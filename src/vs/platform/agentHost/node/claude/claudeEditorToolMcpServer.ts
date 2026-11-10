/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { dirname, isAbsolute, resolve } from '../../../../base/common/path.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../files/common/files.js';
import type { ILogService } from '../../../log/common/log.js';
import type { ToolDefinition } from '../../common/state/protocol/state.js';
import type { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { jsonSchemaToZodRawShape } from './clientTools/claudeJsonSchemaToZod.js';

/**
 * Name of the in-process MCP server that serves the editor-backed `Edit` and
 * `Write` tools to the Claude SDK via `Options.mcpServers['editor']`. The SDK
 * surfaces them to the model as `mcp__editor__Edit` and `mcp__editor__Write`.
 */
export const CLAUDE_EDITOR_TOOL_MCP_SERVER_NAME = 'editor';

const EDITOR_TOOL_PREFIX = `mcp__${CLAUDE_EDITOR_TOOL_MCP_SERVER_NAME}__`;

/** Tool names the `editor` server exposes (before the SDK adds its prefix). */
export const CLAUDE_EDITOR_TOOL_NAMES: readonly string[] = ['Edit', 'Write'];

/** Whether the SDK tool name belongs to the `editor` server. */
export function isClaudeEditorToolName(toolName: string): boolean {
	return toolName.startsWith(EDITOR_TOOL_PREFIX) && CLAUDE_EDITOR_TOOL_NAMES.includes(toolName.slice(EDITOR_TOOL_PREFIX.length));
}

/**
 * Maps `mcp__editor__Edit` and `mcp__editor__Write` to the plain `Edit` and
 * `Write` the rest of the pipeline (tool display, permissions, file-edit
 * tracking) is keyed on. Any other name is returned unchanged.
 */
export function normalizeClaudeToolName(toolName: string): string {
	return isClaudeEditorToolName(toolName) ? toolName.slice(EDITOR_TOOL_PREFIX.length) : toolName;
}

/**
 * Resolves a tool's `file_path` to an absolute path (relative ones against the
 * first working directory) and tells whether it lies inside any of the
 * session's working directories. Only such files are snapshotted for review.
 */
export function resolveClaudeEditorPath(filePath: string, workingDirectories: readonly URI[]): { readonly path: string; readonly inWorkspace: boolean } {
	const path = isAbsolute(filePath) || workingDirectories.length === 0 ? filePath : resolve(workingDirectories[0].fsPath, filePath);
	const resource = URI.file(path);
	return { path, inWorkspace: workingDirectories.some(directory => extUriBiasedIgnorePathCase.isEqualOrParent(resource, directory)) };
}

/**
 * Narrow view of the file-edit tracker that the `editor` tools call around a
 * write, so the before and after snapshots are taken deterministically by the
 * tool itself instead of racing the SDK message stream.
 */
export interface IClaudeEditSnapshotter {
	/** Captures the file as it is before the tool writes it. */
	beforeEdit(filePath: string, toolInput: unknown): Promise<void>;
	/** Captures the file as the tool left it. */
	afterEdit(filePath: string, toolInput: unknown): Promise<void>;
}

/**
 * Stable hand-off between a session and its file-edit observer. The `editor`
 * server is built before the SDK pipeline (and with it the observer that owns
 * the tracker) exists, and the pipeline is rebuilt over a session's life, so
 * the server talks to this bridge and the current observer attaches itself.
 * Without an attached target the calls do nothing and the tools still write.
 */
export class ClaudeEditSnapshotBridge implements IClaudeEditSnapshotter {

	private _target: IClaudeEditSnapshotter | undefined;

	/** Routes calls to `target`; a later attach replaces it. */
	attach(target: IClaudeEditSnapshotter): void {
		this._target = target;
	}

	/** Stops routing to `target`, unless it was already replaced. */
	detach(target: IClaudeEditSnapshotter): void {
		if (this._target === target) {
			this._target = undefined;
		}
	}

	beforeEdit(filePath: string, toolInput: unknown): Promise<void> {
		return this._target?.beforeEdit(filePath, toolInput) ?? Promise.resolve();
	}

	afterEdit(filePath: string, toolInput: unknown): Promise<void> {
		return this._target?.afterEdit(filePath, toolInput) ?? Promise.resolve();
	}
}

const EDITOR_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		name: 'Edit',
		description: 'Replace text in an existing file. `old_string` must match the file content exactly and occur exactly once, unless `replace_all` is true, in which case every occurrence is replaced.',
		inputSchema: {
			type: 'object',
			properties: {
				file_path: { type: 'string', description: 'Absolute path of the file to modify.' },
				old_string: { type: 'string', description: 'The exact text to replace.' },
				new_string: { type: 'string', description: 'The text to put in its place. Must differ from `old_string`.' },
				replace_all: { type: 'boolean', description: 'Replace every occurrence of `old_string` instead of requiring a single one.' },
			},
			required: ['file_path', 'old_string', 'new_string'],
		},
	},
	{
		name: 'Write',
		description: 'Write a file, replacing its content when it exists. Missing parent directories are created.',
		inputSchema: {
			type: 'object',
			properties: {
				file_path: { type: 'string', description: 'Absolute path of the file to write.' },
				content: { type: 'string', description: 'The full content of the file.' },
			},
			required: ['file_path', 'content'],
		},
	},
];

interface IToolResult {
	readonly [key: string]: unknown;
	readonly content: Array<{ type: 'text'; text: string }>;
	readonly isError?: boolean;
}

function textResult(text: string): IToolResult {
	return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): IToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

/** Number of non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/**
 * Build the per-session in-process MCP server that serves `Edit` and `Write`.
 *
 * A write inside one of the session's working directories is bracketed by the
 * snapshotter (`beforeEdit` before the bytes hit the disk, `afterEdit` once
 * they are there) so the review and checkpoints see exactly that change. A
 * write outside them, such as a plan file under the user's home, is written
 * without a snapshot. A failure (missing file, ambiguous match, I/O error)
 * degrades to an `isError` result rather than rejecting.
 *
 * `getWorkingDirectories` is read per call because a session's directories can
 * change; its first entry also resolves relative paths.
 */
export async function buildEditorToolMcpServer(
	sdk: IClaudeAgentSdkService,
	fileService: IFileService,
	logService: ILogService,
	getWorkingDirectories: () => readonly URI[],
	snapshotter: IClaudeEditSnapshotter,
): Promise<McpSdkServerConfigWithInstance> {

	const resolveTarget = (filePath: string): { readonly path: string; readonly tracked: boolean } => {
		const { path, inWorkspace } = resolveClaudeEditorPath(filePath, getWorkingDirectories());
		return { path, tracked: inWorkspace };
	};

	const writeTracked = async (filePath: string, toolInput: unknown, content: string): Promise<void> => {
		const { path, tracked } = resolveTarget(filePath);
		if (tracked) {
			try {
				await snapshotter.beforeEdit(path, toolInput);
			} catch (error) {
				logService.warn(`[ClaudeEditorTools] Snapshot before editing ${path} failed: ${error}`);
			}
		}
		await fileService.writeFile(URI.file(path), VSBuffer.fromString(content));
		if (tracked) {
			try {
				await snapshotter.afterEdit(path, toolInput);
			} catch (error) {
				logService.warn(`[ClaudeEditorTools] Snapshot after editing ${path} failed: ${error}`);
			}
		}
	};

	const handlers: { readonly [name: string]: (args: Record<string, unknown>) => Promise<IToolResult> } = {
		Edit: async args => {
			const { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll } = args as { file_path: string; old_string: string; new_string: string; replace_all?: boolean };
			if (oldString === newString) {
				return errorResult('old_string and new_string are identical; nothing to change.');
			}
			if (oldString === '') {
				return errorResult('old_string must not be empty. Use Write to create a file or replace its whole content.');
			}
			const { path } = resolveTarget(filePath);
			let original: string;
			try {
				original = (await fileService.readFile(URI.file(path))).value.toString();
			} catch {
				return errorResult(`File not found or not readable: ${path}`);
			}
			const occurrences = countOccurrences(original, oldString);
			if (occurrences === 0) {
				return errorResult(`old_string was not found in ${path}.`);
			}
			if (occurrences > 1 && !replaceAll) {
				return errorResult(`old_string occurs ${occurrences} times in ${path}. Add surrounding context to make it unique, or set replace_all to replace every occurrence.`);
			}
			const updated = original.split(oldString).join(newString);
			await writeTracked(filePath, args, updated);
			return textResult(occurrences > 1
				? `Replaced ${occurrences} occurrences in ${path}.`
				: `Edited ${path}.`);
		},
		Write: async args => {
			const { file_path: filePath, content } = args as { file_path: string; content: string };
			const { path } = resolveTarget(filePath);
			const existed = await fileService.exists(URI.file(path));
			await fileService.createFolder(URI.file(dirname(path)));
			await writeTracked(filePath, args, content);
			return textResult(existed ? `Updated ${path}.` : `Created ${path}.`);
		},
	};

	const tools = await Promise.all(EDITOR_TOOL_DEFINITIONS.map(definition => sdk.tool(
		definition.name,
		definition.description ?? '',
		jsonSchemaToZodRawShape(definition.inputSchema),
		async args => {
			try {
				return await handlers[definition.name](args);
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		},
	)));
	return sdk.createSdkMcpServer({ name: CLAUDE_EDITOR_TOOL_MCP_SERVER_NAME, tools });
}
