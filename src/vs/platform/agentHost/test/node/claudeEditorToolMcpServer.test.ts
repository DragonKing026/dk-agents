/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IFileService } from '../../../files/common/files.js';
import { createInMemoryFileService } from '../../../files/test/common/inMemoryFileService.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IClaudeAgentSdkService } from '../../node/claude/claudeAgentSdkService.js';
import {
	buildEditorToolMcpServer,
	ClaudeEditSnapshotBridge,
	CLAUDE_EDITOR_TOOL_MCP_SERVER_NAME,
	isClaudeEditorToolName,
	normalizeClaudeToolName,
	resolveClaudeEditorPath,
	type IClaudeEditSnapshotter,
} from '../../node/claude/claudeEditorToolMcpServer.js';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

function makeSdk(): { sdk: IClaudeAgentSdkService; handlers: Map<string, ToolHandler>; serverNames: string[] } {
	const handlers = new Map<string, ToolHandler>();
	const serverNames: string[] = [];
	const sdk = {
		createSdkMcpServer: async (options: { name: string }) => {
			serverNames.push(options.name);
			return { name: options.name, instance: { __fake: true } } as unknown as McpSdkServerConfigWithInstance;
		},
		tool: async (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
			handlers.set(name, handler);
			return { name } as unknown as ReturnType<IClaudeAgentSdkService['tool']>;
		},
	} as unknown as IClaudeAgentSdkService;
	return { sdk, handlers, serverNames };
}

suite('claudeEditorToolMcpServer', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.file('/work');

	interface IHarness {
		readonly fileService: IFileService;
		readonly events: string[];
		call(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
		read(path: string): Promise<string>;
		serverNames: string[];
		toolNames: string[];
	}

	async function setup(snapshotterFails = false): Promise<IHarness> {
		const fileService = createInMemoryFileService(disposables, Schemas.file);
		const events: string[] = [];
		const read = async (path: string) => (await fileService.readFile(URI.file(path))).value.toString();
		const snapshotter: IClaudeEditSnapshotter = {
			beforeEdit: async (path, input) => {
				events.push(`before:${path}:${await read(path).catch(() => '<missing>')}:${JSON.stringify(input)}`);
				if (snapshotterFails) {
					throw new Error('snapshot failed');
				}
			},
			afterEdit: async (path, input) => {
				events.push(`after:${path}:${await read(path)}:${JSON.stringify(input)}`);
			},
		};
		const { sdk, handlers, serverNames } = makeSdk();
		const server = await buildEditorToolMcpServer(sdk, fileService, new NullLogService(), () => [root], snapshotter);
		assert.strictEqual((server as unknown as { name: string }).name, CLAUDE_EDITOR_TOOL_MCP_SERVER_NAME);
		return {
			fileService,
			events,
			read,
			serverNames,
			toolNames: [...handlers.keys()],
			call: (tool, args) => handlers.get(tool)!(args, undefined),
		};
	}

	function text(result: CallToolResult): string {
		return (result.content[0] as { text: string }).text;
	}

	test('serves Edit and Write from a server named editor', async () => {
		const h = await setup();
		assert.deepStrictEqual({ servers: h.serverNames, tools: h.toolNames }, { servers: ['editor'], tools: ['Edit', 'Write'] });
	});

	test('Edit snapshots before and after the write and reports success', async () => {
		const h = await setup();
		await h.fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('hello world'));
		const input = { file_path: '/work/a.txt', old_string: 'world', new_string: 'there' };

		const result = await h.call('Edit', input);

		assert.deepStrictEqual({
			isError: result.isError,
			content: await h.read('/work/a.txt'),
			events: h.events,
		}, {
			isError: undefined,
			content: 'hello there',
			events: [
				`before:/work/a.txt:hello world:${JSON.stringify(input)}`,
				`after:/work/a.txt:hello there:${JSON.stringify(input)}`,
			],
		});
	});

	test('Edit inserts the replacement literally', async () => {
		const h = await setup();
		await h.fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('price: X'));
		await h.call('Edit', { file_path: '/work/a.txt', old_string: 'X', new_string: '$& $1 $$' });
		assert.strictEqual(await h.read('/work/a.txt'), 'price: $& $1 $$');
	});

	test('Edit fails without touching the file when old_string is absent', async () => {
		const h = await setup();
		await h.fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('abc'));
		const result = await h.call('Edit', { file_path: '/work/a.txt', old_string: 'zzz', new_string: 'y' });
		assert.deepStrictEqual({ isError: result.isError, content: await h.read('/work/a.txt'), events: h.events }, { isError: true, content: 'abc', events: [] });
	});

	test('Edit fails when old_string occurs more than once without replace_all', async () => {
		const h = await setup();
		await h.fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('x x x'));
		const result = await h.call('Edit', { file_path: '/work/a.txt', old_string: 'x', new_string: 'y' });
		assert.deepStrictEqual({ isError: result.isError, mentionsCount: text(result).includes('3 times'), content: await h.read('/work/a.txt'), events: h.events }, { isError: true, mentionsCount: true, content: 'x x x', events: [] });
	});

	test('Edit with replace_all replaces every occurrence', async () => {
		const h = await setup();
		await h.fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('x x x'));
		const result = await h.call('Edit', { file_path: '/work/a.txt', old_string: 'x', new_string: 'y', replace_all: true });
		assert.deepStrictEqual({ isError: result.isError, content: await h.read('/work/a.txt'), snapshots: h.events.length }, { isError: undefined, content: 'y y y', snapshots: 2 });
	});

	test('Edit fails for a missing file, an empty or an unchanged old_string', async () => {
		const h = await setup();
		await h.fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('abc'));
		const results = await Promise.all([
			h.call('Edit', { file_path: '/work/missing.txt', old_string: 'a', new_string: 'b' }),
			h.call('Edit', { file_path: '/work/a.txt', old_string: '', new_string: 'b' }),
			h.call('Edit', { file_path: '/work/a.txt', old_string: 'a', new_string: 'a' }),
		]);
		assert.deepStrictEqual({ errors: results.map(r => r.isError), events: h.events }, { errors: [true, true, true], events: [] });
	});

	test('Write creates the file with its parent directories and snapshots it', async () => {
		const h = await setup();
		const input = { file_path: '/work/deep/er/new.txt', content: 'fresh' };

		const result = await h.call('Write', input);

		assert.deepStrictEqual({
			isError: result.isError,
			content: await h.read('/work/deep/er/new.txt'),
			events: h.events,
		}, {
			isError: undefined,
			content: 'fresh',
			events: [
				`before:/work/deep/er/new.txt:<missing>:${JSON.stringify(input)}`,
				`after:/work/deep/er/new.txt:fresh:${JSON.stringify(input)}`,
			],
		});
	});

	test('Write replaces an existing file', async () => {
		const h = await setup();
		await h.fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('old'));
		await h.call('Write', { file_path: '/work/a.txt', content: 'new' });
		assert.strictEqual(await h.read('/work/a.txt'), 'new');
	});

	test('a file outside the working directories is written without a snapshot', async () => {
		const h = await setup();
		const result = await h.call('Write', { file_path: '/home/user/.plans/plan.md', content: 'plan' });
		assert.deepStrictEqual({ isError: result.isError, content: await h.read('/home/user/.plans/plan.md'), events: h.events }, { isError: undefined, content: 'plan', events: [] });
	});

	test('a failing snapshot does not stop the write', async () => {
		const h = await setup(true);
		await h.fileService.writeFile(URI.file('/work/a.txt'), VSBuffer.fromString('abc'));
		const result = await h.call('Edit', { file_path: '/work/a.txt', old_string: 'b', new_string: 'B' });
		assert.deepStrictEqual({ isError: result.isError, content: await h.read('/work/a.txt') }, { isError: undefined, content: 'aBc' });
	});

	test('normalizes only the editor server tool names', () => {
		assert.deepStrictEqual({
			edit: normalizeClaudeToolName('mcp__editor__Edit'),
			write: normalizeClaudeToolName('mcp__editor__Write'),
			builtin: normalizeClaudeToolName('Edit'),
			otherServer: normalizeClaudeToolName('mcp__host__Edit'),
			otherTool: normalizeClaudeToolName('mcp__editor__Other'),
			isEditor: [isClaudeEditorToolName('mcp__editor__Edit'), isClaudeEditorToolName('Edit'), isClaudeEditorToolName('mcp__editor__Other')],
		}, {
			edit: 'Edit',
			write: 'Write',
			builtin: 'Edit',
			otherServer: 'mcp__host__Edit',
			otherTool: 'mcp__editor__Other',
			isEditor: [true, false, false],
		});
	});

	test('resolveClaudeEditorPath resolves relative paths and tells workspace files apart', () => {
		assert.deepStrictEqual([
			resolveClaudeEditorPath('src/a.ts', [root]),
			resolveClaudeEditorPath('/work/b.ts', [root]),
			resolveClaudeEditorPath('/workshop/b.ts', [root]),
			resolveClaudeEditorPath('/extra/c.ts', [root, URI.file('/extra')]),
		], [
			{ path: '/work/src/a.ts', inWorkspace: true },
			{ path: '/work/b.ts', inWorkspace: true },
			{ path: '/workshop/b.ts', inWorkspace: false },
			{ path: '/extra/c.ts', inWorkspace: true },
		]);
	});

	test('the bridge forwards to the attached target and is a no-op otherwise', async () => {
		const calls: string[] = [];
		const target: IClaudeEditSnapshotter = {
			beforeEdit: async path => { calls.push(`before:${path}`); },
			afterEdit: async path => { calls.push(`after:${path}`); },
		};
		const bridge = new ClaudeEditSnapshotBridge();
		await bridge.beforeEdit('/a', {});
		bridge.attach(target);
		await bridge.beforeEdit('/b', {});
		await bridge.afterEdit('/b', {});
		bridge.detach({ beforeEdit: async () => { }, afterEdit: async () => { } });
		await bridge.beforeEdit('/c', {});
		bridge.detach(target);
		await bridge.afterEdit('/d', {});
		assert.deepStrictEqual(calls, ['before:/b', 'after:/b', 'before:/c']);
	});
});
