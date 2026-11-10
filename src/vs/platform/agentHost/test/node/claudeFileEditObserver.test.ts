/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { Schemas } from '../../../../base/common/network.js';
import { FileService } from '../../../files/common/fileService.js';
import { IFileService } from '../../../files/common/files.js';
import { createInMemoryFileService } from '../../../files/test/common/inMemoryFileService.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { IDiffComputeService } from '../../common/diffComputeService.js';
import { fixedChatOwnerRef, type IAgentChatOwnerRef } from '../../common/agent.js';
import { AgentHostClientType } from '../../common/agentHostClientInfo.js';
import { AgentHostClientConnectionKind, AgentHostLaunchKind, AgentHostTransportKind } from '../../common/agentHostTelemetry.js';
import { IAgentEditAttributionService, NullAgentEditAttributionService } from '../../common/fileEditAttribution.js';
import { ISessionDatabase, ISessionDataService } from '../../common/sessionDataService.js';
import { ToolResultContentType } from '../../common/state/sessionState.js';
import { ClaudeEditSnapshotBridge } from '../../node/claude/claudeEditorToolMcpServer.js';
import { ClaudeFileEditObserver } from '../../node/claude/claudeFileEditObserver.js';
import { ClaudeMapperState } from '../../node/claude/claudeMapSessionEvents.js';
import { IEditSurvivalReporterFactory, NullEditSurvivalReporterFactory } from '../../node/shared/editSurvivalReporter.js';
import { IEditArcReporterLaunchParams, IEditArcReporterService } from '../../node/shared/editArcReporter.js';
import { createSessionDataService, createZeroDiffComputeService, TestSessionDatabase } from '../common/sessionTestHelpers.js';
import { AgentHostFileEditCoordinator, IAgentHostFileEditCoordinator } from '../../node/agentHostFileEditCoordinator.js';
import { TestChatOwnerRef } from './agentChatContextTestUtils.js';

interface IObserverHarness {
	readonly observer: ClaudeFileEditObserver;
	readonly db: TestSessionDatabase;
	readonly fileService: FileService;
	readonly mapperState: ClaudeMapperState;
	readonly arcReports: IEditArcReporterLaunchParams[];
	readonly fileEditCoordinator: AgentHostFileEditCoordinator;
}

function createObserver(disposables: Pick<import('../../../../base/common/lifecycle.js').DisposableStore, 'add'>, owner: IAgentChatOwnerRef = fixedChatOwnerRef(URI.parse('claude:/sess-1')), bridge?: ClaudeEditSnapshotBridge): IObserverHarness {
	const fileService = createInMemoryFileService(disposables, Schemas.file);

	const db = new TestSessionDatabase();
	const dbRef: IReference<ISessionDatabase> = { object: db, dispose: () => { } };
	const arcReports: IEditArcReporterLaunchParams[] = [];
	const fileEditCoordinator = disposables.add(new AgentHostFileEditCoordinator());

	const services = new ServiceCollection(
		[ILogService, new NullLogService()],
		[IFileService, fileService],
		[IAgentHostFileEditCoordinator, fileEditCoordinator],
		[ISessionDataService, createSessionDataService(db)],
		[IDiffComputeService, createZeroDiffComputeService()],
		[IAgentEditAttributionService, new NullAgentEditAttributionService()],
		[IEditSurvivalReporterFactory, new NullEditSurvivalReporterFactory()],
		[IEditArcReporterService, {
			_serviceBrand: undefined,
			reportEdit: async (params: IEditArcReporterLaunchParams) => {
				arcReports.push(params);
			},
		}],
	);
	const instantiationService: IInstantiationService = disposables.add(new InstantiationService(services));
	const observer = disposables.add(instantiationService.createInstance(
		ClaudeFileEditObserver,
		'claude:/sess-1',
		owner,
		dbRef,
		bridge,
	));
	return { observer, db, fileService, mapperState: new ClaudeMapperState(), arcReports, fileEditCoordinator };
}

function assistantMessage(content: unknown): Extract<SDKMessage, { type: 'assistant' }> {
	return { type: 'assistant', message: { content } } as Extract<SDKMessage, { type: 'assistant' }>;
}

function userMessage(content: unknown): Extract<SDKMessage, { type: 'user' }> {
	return { type: 'user', message: { content } } as Extract<SDKMessage, { type: 'user' }>;
}

suite('ClaudeFileEditObserver', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('attributes edits to the live owner after the chat moves', async () => {
		const owner = disposables.add(new TestChatOwnerRef(URI.parse('claude:/original')));
		const { observer, fileService, mapperState, arcReports } = createObserver(disposables, owner);
		const file = URI.file('/work/moved.txt');
		await fileService.writeFile(file, VSBuffer.fromString('before'));
		observer.observeAssistant(assistantMessage([
			{ type: 'tool_use', id: 'moved-edit', name: 'Write', input: { file_path: file.fsPath, content: 'after' } },
		]));
		await fileService.writeFile(file, VSBuffer.fromString('after'));
		owner.set(URI.parse('claude:/new-owner'));
		await observer.observeUser(userMessage([
			{ type: 'tool_result', tool_use_id: 'moved-edit', content: 'ok' },
		]), 'turn-1', mapperState);
		assert.deepStrictEqual(arcReports.map(report => ({ storage: report.sessionUri, owner: report.ownerSessionUri })), [
			{ storage: 'claude:/sess-1', owner: 'claude:/new-owner' },
		]);
	});

	test('shares editing state through snapshot persistence without advertising a pre-write barrier', async () => {
		const { observer, fileService, mapperState, db, fileEditCoordinator } = createObserver(disposables);
		const resource = URI.file('/work/coordinated.txt');
		await fileService.writeFile(resource, VSBuffer.fromString('before'));
		const gate = { started: new DeferredPromise<void>(), release: new DeferredPromise<void>() };
		db.storeFileEdit = async edit => {
			gate.started.complete();
			await gate.release.p;
			db.addEdit(edit);
		};
		observer.observeAssistant(assistantMessage([
			{ type: 'tool_use', id: 'edit', name: 'Write', input: { file_path: resource.fsPath, content: 'after' } },
		]));
		const afterStart = fileEditCoordinator.isEditing(resource);
		await fileService.writeFile(resource, VSBuffer.fromString('after'));
		const completion = observer.observeUser(userMessage([
			{ type: 'tool_result', tool_use_id: 'edit', content: 'ok' },
		]), 'turn-1', mapperState);
		await gate.started.p;
		const whilePersisting = fileEditCoordinator.isEditing(resource);
		gate.release.complete();
		await completion;

		assert.deepStrictEqual({ afterStart, whilePersisting, afterCompletion: fileEditCoordinator.isEditing(resource), coordinated: fileEditCoordinator.isCoordinatedProvider('claude'), cachedType: mapperState.takeFileEdit('edit')?.type }, {
			afterStart: true, whilePersisting: true, afterCompletion: false, coordinated: false, cachedType: ToolResultContentType.FileEdit,
		});
	});

	test('observe assistant→user round-trip caches a file edit on the mapper state', async () => {
		const { observer, fileService, mapperState, arcReports } = createObserver(disposables);
		await fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('before'));

		const clientContext = {
			clientType: AgentHostClientType.EditorWindow,
			connectionKind: AgentHostClientConnectionKind.RemoteExtensionHost,
			transportKind: AgentHostTransportKind.MessagePort,
			hostLaunchKind: AgentHostLaunchKind.VSCodeMainProcess,
			machineId: 'client-machine-id',
			devDeviceId: 'client-dev-device-id',
		};
		observer.observeAssistant(assistantMessage([
			{ type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: '/work/a.txt', content: 'after' } },
		]), 'plan', clientContext);

		// Tool runs (we simulate it here): file content changes.
		await fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('after'));

		await observer.observeUser(userMessage([
			{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
		]), 'turn-1', mapperState);

		const cached = mapperState.takeFileEdit('tu-1');
		assert.deepStrictEqual({
			cachedType: cached?.type,
			arcMode: arcReports[0]?.mode,
			clientContext: arcReports[0]?.clientContext,
		}, {
			cachedType: ToolResultContentType.FileEdit,
			arcMode: 'plan',
			clientContext,
		});
	});

	test('reports whether the edit was made by a subagent chat', async () => {
		const { observer, fileService, mapperState, arcReports } = createObserver(disposables);
		await fileService.writeFile(URI.file('/work/s.txt'), VSBuffer.fromString('before'));
		for (const [toolUseId, isSubagent] of [['tu-root', false], ['tu-sub', true]] as const) {
			observer.observeAssistant(assistantMessage([
				{ type: 'tool_use', id: toolUseId, name: 'Write', input: { file_path: '/work/s.txt', content: 'after' } },
			]));
			await fileService.writeFile(URI.file('/work/s.txt'), VSBuffer.fromString('after-' + toolUseId));
			await observer.observeUser(userMessage([
				{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' },
			]), 'turn-1', mapperState, { uri: 'ahp-chat:/00000000-0000-4000-8000-000000000001', isSubagent });
		}
		assert.deepStrictEqual(arcReports.map(r => r.isSubagent), [false, true]);
	});

	test('editor tools: the handler snapshots through the bridge and the observer only collects the result', async () => {
		const bridge = new ClaudeEditSnapshotBridge();
		const { observer, fileService, mapperState, arcReports } = createObserver(disposables, undefined, bridge);
		const file = URI.file('/work/editor.txt');
		await fileService.writeFile(file, VSBuffer.fromString('before'));
		const input = { file_path: file.fsPath, content: 'after' };

		observer.observeAssistant(assistantMessage([
			{ type: 'tool_use', id: 'tu-editor', name: 'mcp__editor__Write', input },
		]), 'acceptEdits');
		// The tool handler runs: snapshot, write, snapshot.
		await bridge.beforeEdit(file.fsPath, input);
		await fileService.writeFile(file, VSBuffer.fromString('after'));
		await bridge.afterEdit(file.fsPath, input);
		await observer.observeUser(userMessage([
			{ type: 'tool_result', tool_use_id: 'tu-editor', content: 'ok' },
		]), 'turn-1', mapperState);

		assert.deepStrictEqual({
			cachedType: mapperState.takeFileEdit('tu-editor')?.type,
			reports: arcReports.map(report => report.mode),
		}, {
			cachedType: ToolResultContentType.FileEdit,
			reports: ['acceptEdits'],
		});
	});

	test('editor tools: a later edit of the same file that started before the first result arrived keeps its own snapshots', async () => {
		const bridge = new ClaudeEditSnapshotBridge();
		const { observer, fileService, mapperState, db } = createObserver(disposables, undefined, bridge);
		const file = URI.file('/work/twice.txt');
		await fileService.writeFile(file, VSBuffer.fromString('v0'));
		const inputA = { file_path: file.fsPath, old_string: 'v0', new_string: 'v1' };
		const inputB = { file_path: file.fsPath, old_string: 'v1', new_string: 'v2' };

		observer.observeAssistant(assistantMessage([
			{ type: 'tool_use', id: 'tu-a', name: 'mcp__editor__Edit', input: inputA },
			{ type: 'tool_use', id: 'tu-b', name: 'mcp__editor__Edit', input: inputB },
		]));
		// A runs to completion, then B starts before A's tool_result is observed.
		await bridge.beforeEdit(file.fsPath, inputA);
		await fileService.writeFile(file, VSBuffer.fromString('v1'));
		await bridge.afterEdit(file.fsPath, inputA);
		await bridge.beforeEdit(file.fsPath, inputB);
		await observer.observeUser(userMessage([{ type: 'tool_result', tool_use_id: 'tu-a', content: 'ok' }]), 'turn-1', mapperState);
		await fileService.writeFile(file, VSBuffer.fromString('v2'));
		await bridge.afterEdit(file.fsPath, inputB);
		await observer.observeUser(userMessage([{ type: 'tool_result', tool_use_id: 'tu-b', content: 'ok' }]), 'turn-1', mapperState);

		const decoder = new TextDecoder();
		const edits = await Promise.all(['tu-a', 'tu-b'].map(async id => {
			const cached = mapperState.takeFileEdit(id)?.type === ToolResultContentType.FileEdit;
			const content = await db.readFileEditContent(id, file.fsPath);
			return { cached, recorded: content ? `${decoder.decode(content.beforeContent)} -> ${decoder.decode(content.afterContent)}` : 'not recorded' };
		}));
		assert.deepStrictEqual(edits, [{ cached: true, recorded: 'v0 -> v1' }, { cached: true, recorded: 'v1 -> v2' }]);
	});

	test('editor tools: a write outside any snapshot caches no edit', async () => {
		const bridge = new ClaudeEditSnapshotBridge();
		const { observer, fileService, mapperState } = createObserver(disposables, undefined, bridge);
		const file = URI.file('/home/plans/plan.md');
		const input = { file_path: file.fsPath, content: 'plan' };

		observer.observeAssistant(assistantMessage([
			{ type: 'tool_use', id: 'tu-plan', name: 'mcp__editor__Write', input },
		]));
		await fileService.writeFile(file, VSBuffer.fromString('plan'));
		await observer.observeUser(userMessage([
			{ type: 'tool_result', tool_use_id: 'tu-plan', content: 'ok' },
		]), 'turn-1', mapperState);

		assert.strictEqual(mapperState.takeFileEdit('tu-plan'), undefined);
	});

	test('detaches from the bridge on dispose', async () => {
		const bridge = new ClaudeEditSnapshotBridge();
		const { observer } = createObserver(disposables, undefined, bridge);
		observer.dispose();
		// Falls back to a no-op instead of using the disposed tracker.
		await bridge.beforeEdit('/work/x.txt', {});
		await bridge.afterEdit('/work/x.txt', {});
	});

	test('observeAssistant ignores non-edit tools and tools with no path', () => {
		const { observer, mapperState } = createObserver(disposables);

		observer.observeAssistant(assistantMessage([
			{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'ls' } },
			{ type: 'tool_use', id: 'tu-bad', name: 'Write', input: {} }, // missing file_path
			{ type: 'text', text: 'hi' },
		]));

		// No tool_result for either id should produce a cached edit.
		assert.strictEqual(mapperState.takeFileEdit('tu-bash'), undefined);
		assert.strictEqual(mapperState.takeFileEdit('tu-bad'), undefined);
	});

	test('observeUser ignores tool_result for unknown tool_use_id', async () => {
		const { observer, mapperState } = createObserver(disposables);

		await observer.observeUser(userMessage([
			{ type: 'tool_result', tool_use_id: 'never-tracked', content: 'ok' },
		]), 'turn-1', mapperState);

		assert.strictEqual(mapperState.takeFileEdit('never-tracked'), undefined);
	});

	test('observe* tolerate non-array message content', async () => {
		const { observer, mapperState } = createObserver(disposables);

		observer.observeAssistant(assistantMessage('plain string body'));
		await observer.observeUser(userMessage('plain string body'), 'turn-1', mapperState);

		// No throws, no cached edits.
		assert.strictEqual(mapperState.takeFileEdit('any'), undefined);
	});
});
