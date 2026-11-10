/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Disposable, IReference, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { ISessionDatabase } from '../../common/sessionDataService.js';
import type { IAgentHostClientTelemetryContext } from '../../common/agentHostTelemetry.js';
import { FileEditTracker } from '../shared/fileEditTracker.js';
import { CLAUDE_AGENT_PROVIDER_ID, type IAgentChatOwnerRef } from '../../common/agent.js';
import type { ClaudeMapperState } from './claudeMapSessionEvents.js';
import { getClaudeToolPath, isClaudeFileEditTool } from './claudeToolDisplay.js';
import { isClaudeEditorToolName, normalizeClaudeToolName, type ClaudeEditSnapshotBridge, type IClaudeEditSnapshotter } from './claudeEditorToolMcpServer.js';

/**
 * Phase 8 — file-edit observation off the SDK message stream.
 *
 * Owns the {@link FileEditTracker}, the in-flight `tool_use_id → path`
 * map, and the dbRef whose lifetime gates persistence writes. Snapshots
 * before-content when an assistant `tool_use` block arrives, snapshots
 * after-content when the matching synthetic `tool_result` arrives, and
 * stages a {@link ToolResultFileEditContent} on the session's
 * {@link ClaudeMapperState} so the synchronous mapper can attach it to
 * the `ChatToolCallComplete` action.
 *
 * Hooks (`Options.hooks.PreToolUse` / `Options.hooks.PostToolUse`) are
 * deliberately NOT used: they are user-bypassable via settings, whereas
 * the SDK message stream is the canonical, non-bypassable signal that
 * a tool will run. Mirrors the production extension's dispatch-time
 * observation (extensions/copilot/.../claudeMessageDispatch.ts:200) —
 * see the comment there about `bypassPermissions` and internal SDK
 * paths that skip `canUseTool`.
 *
 * Best-effort: the SDK proceeds to run the tool concurrently after
 * yielding the `tool_use` block, so {@link observeAssistant}'s before-
 * snapshot races against tool execution. Tool execution involves disk
 * I/O before the write, which gives enough microtask headroom in
 * practice; same guarantee the production extension relies on with
 * `stream.externalEdit`.
 *
 * The editor-backed `Edit` and `Write` tools (`mcp__editor__*`) do not
 * race: their handlers take both snapshots themselves through
 * {@link IClaudeEditSnapshotter}, which this observer implements on top of
 * the tracker, so {@link observeAssistant} only records their path.
 */
export class ClaudeFileEditObserver extends Disposable implements IClaudeEditSnapshotter {

	private readonly _editTracker: FileEditTracker;

	/**
	 * Maps SDK `tool_use_id` → file path + raw tool input + model
	 * captured when the SDK yields the assistant `tool_use` block in
	 * {@link observeAssistant}. Consumed (and removed) by
	 * {@link observeUser} when the matching `tool_result` arrives.
	 * The raw input is forwarded to
	 * {@link FileEditTracker.takeCompletedEdit} so it can extract the
	 * AI-written text chunks for the edit-survival reporter. The
	 * model is read off the assistant message body and is naturally
	 * per-subagent: when a subagent emits the `tool_use`, its model
	 * (not the parent's) is what we record.
	 */
	private readonly _editToolPaths = new Map<string, { readonly filePath: string; readonly toolName: string; readonly toolInput: unknown; readonly modelId: string | undefined; readonly clientContext?: IAgentHostClientTelemetryContext; readonly chatUri?: string; /** The tool's handler took both snapshots itself (editor tools). */ readonly selfSnapshotted: boolean }>();

	/** Permission mode of the latest assistant message, recorded with edits the editor tools snapshot. */
	private _lastMode: PermissionMode | undefined;

	constructor(
		sessionUri: string,
		/** The session that owns the chat, read when an edit is attributed. */
		owner: IAgentChatOwnerRef,
		dbRef: IReference<ISessionDatabase>,
		/** Receives this observer as the snapshotter of the session's editor tools. */
		editSnapshotBridge: ClaudeEditSnapshotBridge | undefined = undefined,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// Keep the connection warm; the tracker owns references for its writes.
		this._register(dbRef);
		this._editTracker = this._register(instantiationService.createInstance(
			FileEditTracker,
			sessionUri,
			() => owner.get().toString(),
			CLAUDE_AGENT_PROVIDER_ID,
		));
		if (editSnapshotBridge) {
			editSnapshotBridge.attach(this);
			this._register(toDisposable(() => editSnapshotBridge.detach(this)));
		}
	}

	beforeEdit(filePath: string, toolInput: unknown): Promise<void> {
		return this._editTracker.trackEditStart(filePath, this._lastMode, toolInput);
	}

	afterEdit(filePath: string, toolInput: unknown): Promise<void> {
		return this._editTracker.completeEdit(filePath, toolInput);
	}

	/**
	 * Snapshot before-content for any file-edit `tool_use` blocks
	 * carried by an SDK assistant message. Caller must invoke this when
	 * the SDK yields a canonical `'assistant'` message (full
	 * `tool_use.input` available).
	 */
	observeAssistant(message: Extract<SDKMessage, { type: 'assistant' }>, mode?: PermissionMode, clientContext?: IAgentHostClientTelemetryContext, chatUri?: string): void {
		const content = message.message.content;
		if (!Array.isArray(content)) {
			return;
		}
		this._lastMode = mode;
		const modelId = typeof message.message.model === 'string' ? message.message.model : undefined;
		for (const block of content) {
			if (block.type !== 'tool_use') {
				continue;
			}
			const toolName = normalizeClaudeToolName(block.name);
			if (!isClaudeFileEditTool(toolName)) {
				continue;
			}
			const filePath = getClaudeToolPath(toolName, block.input);
			if (!filePath) {
				continue;
			}
			const selfSnapshotted = isClaudeEditorToolName(block.name);
			this._editToolPaths.set(block.id, { filePath, toolName, toolInput: block.input, modelId, clientContext, chatUri, selfSnapshotted });
			if (selfSnapshotted) {
				// The tool's handler snapshots the file itself.
				continue;
			}
			void this._editTracker.trackEditStart(filePath, mode, block.input).catch(err =>
				this._logService.warn(`[ClaudeFileEditObserver] trackEditStart failed for ${filePath}: ${err}`));
		}
	}

	/**
	 * Take after-content snapshots and stage
	 * {@link ToolResultFileEditContent} entries on `mapperState` for any
	 * `tool_result` blocks carried by an SDK user message. Caller MUST
	 * await this BEFORE invoking the synchronous mapper, so the cached
	 * file edit is already on `mapperState` when `mapUserMessage` calls
	 * `state.takeFileEdit`.
	 */
	async observeUser(
		message: Extract<SDKMessage, { type: 'user' }>,
		turnId: string,
		mapperState: ClaudeMapperState,
		chat?: { readonly uri: string; readonly isSubagent: boolean },
	): Promise<void> {
		const content = message.message.content;
		if (!Array.isArray(content)) {
			return;
		}
		for (const block of content) {
			if (block.type !== 'tool_result') {
				continue;
			}
			const tracked = this._editToolPaths.get(block.tool_use_id);
			if (!tracked) {
				continue;
			}
			this._editToolPaths.delete(block.tool_use_id);
			try {
				// An editor tool completed its own snapshot in its handler. Completing
				// it again here would complete whichever edit of the file is pending
				// instead, such as a later edit of the same file that already started.
				if (!tracked.selfSnapshotted) {
					await this._editTracker.completeEdit(tracked.filePath, tracked.toolInput);
				}
				const editChatUri = chat?.isSubagent ? chat.uri : tracked.chatUri ?? chat?.uri;
				const fileEdit = await this._editTracker.takeCompletedEdit(turnId, block.tool_use_id, tracked.filePath, tracked.toolName, tracked.toolInput, tracked.modelId, chat?.isSubagent ?? false, tracked.clientContext, editChatUri);
				if (fileEdit) {
					mapperState.cacheFileEdit(block.tool_use_id, fileEdit);
				}
			} catch (err) {
				this._logService.warn(`[ClaudeFileEditObserver] file edit tracking failed for ${tracked.filePath}: ${err}`);
			}
		}
	}

	override dispose(): void {
		void this._editTracker.flushAttribution().catch(error => {
			this._logService.warn(`[ClaudeFileEditObserver] Failed to flush edit attribution: ${error}`);
		});
		super.dispose();
	}
}
