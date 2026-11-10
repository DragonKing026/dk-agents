/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { PassThrough } from 'stream';
import { z } from 'zod';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { buildClaudeCliArgs, buildClaudeCliEnv, prepareClaudeCliLaunch } from '../../node/claude/claudeCliArgs.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ClaudeCliQuery, type IClaudeCliProcess, type IClaudeCliProcessLauncher } from '../../node/claude/claudeCliQuery.js';
import { ClaudeCliSdkService, isClaudeCliAvailable } from '../../node/claude/claudeCliSdkService.js';

type Json = any;

const InitializeResponse = {
	commands: [],
	agents: [],
	output_style: 'default',
	available_output_styles: ['default'],
	models: [{ value: 'default', displayName: 'Default', description: 'The default model' }],
	account: { tokenSource: 'none', apiProvider: 'firstParty' },
};

/** A scripted stand-in for the `claude` process: frames in and out, no real binary. */
class FakeClaudeProcess implements IClaudeCliProcess {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly sent: Json[] = [];
	readonly signals: NodeJS.Signals[] = [];
	stdinEnded = false;
	exitOnKill = true;
	killResult = true;
	autoInitialize = true;

	private readonly _onDidExit = new Emitter<{ code: number | null; signal: string | null }>();
	private readonly _onDidError = new Emitter<Error>();
	readonly onDidExit = this._onDidExit.event;
	readonly onDidError = this._onDidError.event;
	private _stdinBuffer = '';
	private _exited = false;

	constructor(readonly command: string, readonly args: readonly string[], readonly env: Record<string, string>, readonly cwd: string | undefined) {
		this.stdin.setEncoding('utf8');
		this.stdin.on('data', (chunk: string) => {
			this._stdinBuffer += chunk;
			let newline: number;
			while ((newline = this._stdinBuffer.indexOf('\n')) >= 0) {
				const frame = JSON.parse(this._stdinBuffer.slice(0, newline));
				this._stdinBuffer = this._stdinBuffer.slice(newline + 1);
				this.sent.push(frame);
				if (this.autoInitialize && frame.type === 'control_request' && frame.request.subtype === 'initialize') {
					this.respond(frame.request_id, InitializeResponse);
				}
			}
		});
		this.stdin.on('end', () => this.stdinEnded = true);
	}

	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		if (this.exitOnKill) {
			this.exit(null, signal ?? 'SIGTERM');
		}
		return this.killResult;
	}

	emit(message: Json): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}

	respond(requestId: string, response: Json): void {
		this.emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
	}

	fail(requestId: string, error: string): void {
		this.emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
	}

	exit(code: number | null, signal: string | null = null): void {
		if (!this._exited) {
			this._exited = true;
			this._onDidExit.fire({ code, signal });
			this._onDidExit.dispose();
			this._onDidError.dispose();
		}
	}

	raise(error: Error): void {
		this._onDidError.fire(error);
	}

	controlRequests(subtype?: string): Json[] {
		return this.sent.filter(frame => frame.type === 'control_request' && (subtype === undefined || frame.request.subtype === subtype));
	}

	controlResponses(): Json[] {
		return this.sent.filter(frame => frame.type === 'control_response');
	}
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 20_000; i++) {
		if (condition()) {
			return;
		}
		await new Promise(resolve => setImmediate(resolve));
	}
	assert.fail(`Timed out waiting for ${what}`);
}

const assistant = (text: string): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: 'u1', session_id: 's1' }) as unknown as SDKMessage;
const result = (): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, result: 'done', uuid: 'u2', session_id: 's1' }) as unknown as SDKMessage;

suite('ClaudeCliSdkService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let processes: FakeClaudeProcess[];
	let configure: (process: FakeClaudeProcess) => void;

	setup(() => {
		processes = [];
		configure = () => { };
	});

	const launcher: IClaudeCliProcessLauncher = {
		launch(command, args, options) {
			const fake = new FakeClaudeProcess(command, args, options.env, options.cwd);
			configure(fake);
			processes.push(fake);
			return fake;
		}
	};

	function createService(): ClaudeCliSdkService {
		return new ClaudeCliSdkService(launcher, new NullLogService());
	}

	function prompt(...texts: string[]): AsyncIterable<SDKUserMessage> {
		return (async function* () {
			for (const text of texts) {
				yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } } as SDKUserMessage;
			}
		})();
	}

	/** A prompt that stays open and never yields, like the session's prompt queue between turns. */
	function openPrompt(): AsyncIterable<SDKUserMessage> {
		return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => { }) }) };
	}

	suite('options', () => {

		test('map onto command line flags, grouped by purpose', () => {
			const args = buildClaudeCliArgs({
				model: 'opus',
				effort: 'high',
				maxTurns: 3,
				permissionMode: 'default',
				resume: 'sess-1',
				allowedTools: ['Read', 'Bash(git:*)'],
				disallowedTools: ['WebSearch'],
				additionalDirectories: ['/a', '/b'],
				includePartialMessages: true,
				allowDangerouslySkipPermissions: true,
				settingSources: ['user', 'project'],
				canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
				executable: 'node',
				executableArgs: ['--flag'],
				plugins: [{ type: 'local', path: '/plugins/p', skipMcpDiscovery: true }, { type: 'local', path: '/plugins/q' }],
				extraArgs: { 'replay-user-messages': null, 'foo': 'bar' },
			}, { mcpConfig: '/t/mcp.json', settings: '/t/settings.json' });
			assert.deepStrictEqual(args, [
				'-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
				'--include-partial-messages',
				'--resume=sess-1',
				'--model=opus',
				'--effort=high',
				'--max-turns=3',
				'--permission-mode=manual',
				'--allow-dangerously-skip-permissions',
				'--permission-prompt-tool=stdio',
				'--allowedTools=Read,Bash(git:*)',
				'--disallowedTools=WebSearch',
				'--add-dir=/a',
				'--add-dir=/b',
				'--setting-sources=user,project',
				'--settings=/t/settings.json',
				'--mcp-config=/t/mcp.json',
				'--plugin-dir=/plugins/p',
				'--plugin-dir=/plugins/q',
				'--replay-user-messages',
				'--foo=bar',
			]);
		});

		test('options without a documented flag are reported and not passed on', async () => {
			const plan = await prepareClaudeCliLaunch({ thinking: { type: 'adaptive' }, resumeSessionAt: 'm1', pluginDelivery: 'initialize' });
			try {
				assert.deepStrictEqual(plan.warnings.map(w => w.split(':')[0]), ['Ignoring Options.thinking', 'Ignoring Options.resumeSessionAt', 'Ignoring Options.pluginDelivery=initialize']);
				assert.ok(!plan.args.some(arg => /thinking|resume-session-at|await-initialize/.test(arg)));
			} finally {
				await plan.dispose();
			}
		});

		test('invalid combinations and extra flag names are rejected', () => {
			assert.throws(() => buildClaudeCliArgs({ canUseTool: async () => ({ behavior: 'deny', message: '' }), permissionPromptToolName: 'mcp__x__y' }), /mutually exclusive/);
			assert.throws(() => buildClaudeCliArgs({ model: 'a', fallbackModel: 'a' }), /must differ/);
			assert.throws(() => buildClaudeCliArgs({ extraArgs: { '--evil': null } }), /invalid flag name/);
			assert.throws(() => buildClaudeCliArgs({ extraArgs: { 'a=b': 'c' } }), /invalid flag name/);
		});

		test('MCP servers and inline settings go through private files, not the command line', async () => {
			const plan = await prepareClaudeCliLaunch({
				mcpServers: { files: { type: 'stdio', command: 'srv', env: { TOKEN: 'secret-token' } } },
				settings: { env: { KEY: 'secret-key' } },
			});
			const mcpArg = plan.args.find(arg => arg.startsWith('--mcp-config='))!;
			const settingsArg = plan.args.find(arg => arg.startsWith('--settings='))!;
			assert.ok(mcpArg.endsWith('/mcp.json') && settingsArg.endsWith('/settings.json'));
			assert.ok(!plan.args.join(' ').includes('secret'));
			const mcpPath = mcpArg.slice('--mcp-config='.length);
			const settingsPath = settingsArg.slice('--settings='.length);
			assert.deepStrictEqual(JSON.parse(readFileSync(mcpPath, 'utf8')), { mcpServers: { files: { type: 'stdio', command: 'srv', env: { TOKEN: 'secret-token' } } } });
			assert.deepStrictEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { env: { KEY: 'secret-key' } });
			assert.strictEqual(statSync(mcpPath).mode & 0o777, 0o600);
			assert.strictEqual(statSync(settingsPath).mode & 0o777, 0o600);
			const directory = join(mcpPath, '..');
			assert.strictEqual(statSync(directory).mode & 0o777, 0o700);
			await plan.dispose();
			assert.strictEqual(existsSync(directory), false);
		});

		test('the config files are removed once the process is gone', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: { settings: { env: { A: '1' } } } });
			const settingsPath = processes[0].args.find(arg => arg.startsWith('--settings='))!.slice('--settings='.length);
			assert.strictEqual(existsSync(settingsPath), true);
			await query.return(undefined);
			await waitFor(() => !existsSync(settingsPath), 'temporary files to be removed');
		});

		test('a missing working directory is reported as such', async () => {
			await assert.rejects(createService().query({ prompt: 'hi', options: { cwd: join(tmpdir(), 'does-not-exist-dk-code') } }), /working directory for Claude Code does not exist/);
		});

		test('start a new session with --session-id and leave in-process MCP servers off the command line', async () => {
			const service = createService();
			const server = await service.createSdkMcpServer({ name: 'client', tools: [] });
			const args = buildClaudeCliArgs({ sessionId: 'abc', mcpServers: { client: server }, persistSession: false });
			assert.deepStrictEqual(args.slice(6), ['--session-id=abc', '--no-session-persistence']);
		});

		test('environment drops host-only variables and keeps the rest', () => {
			const env = buildClaudeCliEnv({
				env: { PATH: '/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '1', ELECTRON_FOO: 'x', VSCODE_PID: '1', NODE_OPTIONS: '--x', GONE: undefined },
				enableFileCheckpointing: true,
			});
			assert.deepStrictEqual(env, {
				PATH: '/bin',
				HOME: '/h',
				CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true',
			});
		});

		test('environment falls back to the inherited one', () => {
			const env = buildClaudeCliEnv({}, { PATH: '/bin', VSCODE_X: '1', KEEP: 'y' });
			assert.strictEqual(env.KEEP, 'y');
			assert.strictEqual(env.VSCODE_X, undefined);
		});

		test('the binary is started with the working directory and a sanitised environment', async () => {
			const service = createService();
			const query = await service.query({ prompt: 'hi', options: { cwd: tmpdir(), env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' } } });
			const claude = processes[0];
			assert.strictEqual(claude.command, 'claude');
			assert.strictEqual(claude.cwd, tmpdir());
			assert.strictEqual(claude.env.ELECTRON_RUN_AS_NODE, undefined);
			query.close();
			await query.return(undefined);
		});

		test('initialize carries the system prompt and the in-process MCP server names', async () => {
			const service = createService();
			const server = await service.createSdkMcpServer({ name: 'client', tools: [] });
			const query = await service.query({ prompt: 'hi', options: { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra' }, mcpServers: { client: server } } });
			const [initialize] = processes[0].controlRequests('initialize');
			assert.strictEqual(initialize.request.appendSystemPrompt, 'extra');
			assert.deepStrictEqual(initialize.request.sdkMcpServers, ['client']);
			assert.strictEqual(initialize.request.systemPrompt, undefined);
			query.close();
		});
	});

	suite('protocol', () => {

		test('initialize is sent before the prompt and the prompt is a user message', async () => {
			const query = await createService().query({ prompt: 'hello', options: {} });
			const claude = processes[0];
			await waitFor(() => claude.sent.length >= 2, 'initialize and prompt');
			assert.strictEqual(claude.sent[0].type, 'control_request');
			assert.strictEqual(claude.sent[0].request.subtype, 'initialize');
			assert.deepStrictEqual(claude.sent[1], {
				type: 'user',
				session_id: '',
				parent_tool_use_id: null,
				message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
			});
			query.close();
		});

		test('SDK messages come out of the iterator unchanged and stdin closes after the last result', async () => {
			const query = await createService().query({ prompt: 'hello', options: {} });
			const claude = processes[0];
			const messages: SDKMessage[] = [];
			const consumed = (async () => {
				for await (const message of query) {
					messages.push(message);
				}
			})();
			claude.emit({ type: 'keep_alive' });
			claude.emit(assistant('hi there'));
			claude.emit(result());
			await waitFor(() => claude.stdinEnded, 'stdin to close after the result');
			claude.exit(0);
			await consumed;
			assert.deepStrictEqual(messages, [assistant('hi there'), result()]);
		});

		test('a single string prompt closes stdin after the first result even if more are expected', async () => {
			const query = await createService().query({ prompt: 'hello', options: {} });
			const claude = processes[0];
			claude.emit(result());
			await waitFor(() => claude.stdinEnded, 'stdin to close');
			query.close();
		});

		test('an exhausted prompt iterable closes stdin when every message was answered', async () => {
			const query = await createService().query({ prompt: prompt('one', 'two'), options: {} });
			const claude = processes[0];
			await waitFor(() => claude.sent.filter(frame => frame.type === 'user').length === 2, 'both prompts');
			claude.emit(result());
			await waitFor(() => claude.sent.length >= 3, 'idle');
			assert.strictEqual(claude.stdinEnded, false);
			claude.emit(result());
			await waitFor(() => claude.stdinEnded, 'stdin to close');
			query.close();
		});

		test('merged messages: one result for two messages closes stdin after a quiet period', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
			const query = await createService().query({ prompt: prompt('one', 'two'), options: {} });
			const claude = processes[0];
			await new Promise(resolve => setTimeout(resolve, 10));
			assert.strictEqual(claude.sent.filter(frame => frame.type === 'user').length, 2);
			claude.emit(result());
			await new Promise(resolve => setTimeout(resolve, 1000));
			assert.strictEqual(claude.stdinEnded, false);
			await new Promise(resolve => setTimeout(resolve, 5000));
			assert.strictEqual(claude.stdinEnded, true);
			query.close();
		}));

		test('output after the last result postpones closing stdin', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
			const query = await createService().query({ prompt: prompt('one', 'two'), options: {} });
			const claude = processes[0];
			await new Promise(resolve => setTimeout(resolve, 10));
			claude.emit(result());
			await new Promise(resolve => setTimeout(resolve, 2000));
			claude.emit(assistant('late'));
			await new Promise(resolve => setTimeout(resolve, 2000));
			assert.strictEqual(claude.stdinEnded, false);
			await new Promise(resolve => setTimeout(resolve, 2000));
			assert.strictEqual(claude.stdinEnded, true);
			query.close();
		}));

		test('a control response resolves the matching request and an error response rejects it', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const claude = processes[0];
			const mode = query.setPermissionMode('plan');
			await waitFor(() => claude.controlRequests('set_permission_mode').length === 1, 'set_permission_mode');
			const [sent] = claude.controlRequests('set_permission_mode');
			assert.strictEqual(sent.request.mode, 'plan');
			claude.respond(sent.request_id, {});
			await mode;

			const model = query.setModel('sonnet');
			await waitFor(() => claude.controlRequests('set_model').length === 1, 'set_model');
			const [setModel] = claude.controlRequests('set_model');
			assert.strictEqual(setModel.request.model, 'sonnet');
			claude.fail(setModel.request_id, 'unknown model');
			await assert.rejects(model, /unknown model/);

			const interrupt = query.interrupt();
			await waitFor(() => claude.controlRequests('interrupt').length === 1, 'interrupt');
			claude.respond(claude.controlRequests('interrupt')[0].request_id, {});
			assert.strictEqual(await interrupt, undefined);
			query.close();
		});

		test('initialization answers supportedModels and accountInfo without any prompt being sent', async () => {
			// The model enumeration pattern: a prompt that never yields.
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const [models, account] = await Promise.all([query.supportedModels(), query.accountInfo()]);
			assert.deepStrictEqual(models.map(m => m.value), ['default']);
			assert.strictEqual(account.apiProvider, 'firstParty');
			assert.deepStrictEqual(processes[0].sent.map(frame => frame.type), ['control_request']);
			query.close();
			await query.return(undefined);
			assert.deepStrictEqual(processes[0].signals, ['SIGTERM']);
		});

		test('commands_changed updates supportedCommands', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			processes[0].emit({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'x', description: '', argumentHint: '' }] });
			const consumer = query.next();
			await consumer;
			assert.deepStrictEqual((await query.supportedCommands()).map(c => c.name), ['x']);
			query.close();
		});
	});

	suite('requests from the binary', () => {

		test('can_use_tool calls canUseTool and answers with its result and the tool use id', async () => {
			const calls: Json[] = [];
			const query = await createService().query({
				prompt: openPrompt(),
				options: {
					canUseTool: async (toolName, input, options) => {
						calls.push({ toolName, input, suggestions: options.suggestions, blockedPath: options.blockedPath, toolUseID: options.toolUseID });
						return { behavior: 'allow', updatedInput: { ...input, extra: true } };
					},
				},
			});
			const claude = processes[0];
			claude.emit({
				type: 'control_request', request_id: 'cli-1', request: {
					subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x' },
					permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
					blocked_path: '/x', tool_use_id: 'toolu_1',
				}
			});
			await waitFor(() => claude.controlResponses().length === 1, 'permission response');
			assert.deepStrictEqual(calls, [{
				toolName: 'Write', input: { file_path: '/x' },
				suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
				blockedPath: '/x', toolUseID: 'toolu_1',
			}]);
			assert.deepStrictEqual(claude.controlResponses()[0], {
				type: 'control_response',
				response: {
					subtype: 'success', request_id: 'cli-1',
					response: { behavior: 'allow', updatedInput: { file_path: '/x', extra: true }, toolUseID: 'toolu_1' },
				},
			});
			query.close();
		});

		test('a throwing callback is answered with an error response', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: { canUseTool: async () => { throw new Error('boom'); } } });
			const claude = processes[0];
			claude.emit({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 't' } });
			await waitFor(() => claude.controlResponses().length === 1, 'error response');
			assert.deepStrictEqual(claude.controlResponses()[0].response, { subtype: 'error', request_id: 'cli-1', error: 'boom' });
			query.close();
		});

		test('control_cancel_request aborts the signal given to canUseTool and no response is written', async () => {
			let seen: AbortSignal | undefined;
			const query = await createService().query({
				prompt: openPrompt(),
				options: {
					canUseTool: (_name, _input, options) => new Promise(() => { seen = options.signal; }),
				},
			});
			const claude = processes[0];
			claude.emit({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 't' } });
			await waitFor(() => seen !== undefined, 'canUseTool call');
			claude.emit({ type: 'control_cancel_request', request_id: 'cli-1' });
			await waitFor(() => seen!.aborted, 'abort');
			assert.deepStrictEqual(claude.controlResponses(), []);
			query.close();
		});

		test('hooks are registered in initialize and hook_callback runs the callback', async () => {
			const inputs: Json[] = [];
			const query = await createService().query({
				prompt: openPrompt(),
				options: {
					hooks: {
						PreToolUse: [{
							matcher: 'Bash',
							hooks: [async (input, toolUseID) => { inputs.push({ input, toolUseID }); return { continue: true }; }],
						}],
					},
				},
			});
			const claude = processes[0];
			const { hooks } = claude.controlRequests('initialize')[0].request;
			assert.deepStrictEqual(hooks, { PreToolUse: [{ matcher: 'Bash', hookCallbackIds: ['hook_0'] }] });
			claude.emit({ type: 'control_request', request_id: 'cli-2', request: { subtype: 'hook_callback', callback_id: 'hook_0', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, tool_use_id: 'toolu_2' } });
			await waitFor(() => claude.controlResponses().length === 1, 'hook response');
			assert.deepStrictEqual(inputs, [{ input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, toolUseID: 'toolu_2' }]);
			assert.deepStrictEqual(claude.controlResponses()[0].response, { subtype: 'success', request_id: 'cli-2', response: { continue: true } });

			claude.emit({ type: 'control_request', request_id: 'cli-3', request: { subtype: 'hook_callback', callback_id: 'hook_9', input: {} } });
			await waitFor(() => claude.controlResponses().length === 2, 'unknown hook response');
			assert.strictEqual(claude.controlResponses()[1].response.subtype, 'error');
			query.close();
		});

		test('elicitation goes to onElicitation', async () => {
			const query = await createService().query({
				prompt: openPrompt(),
				options: { onElicitation: async request => ({ action: 'accept', content: { echo: request.message } }) },
			});
			const claude = processes[0];
			claude.emit({ type: 'control_request', request_id: 'cli-4', request: { subtype: 'elicitation', mcp_server_name: 'srv', message: 'Name?' } });
			await waitFor(() => claude.controlResponses().length === 1, 'elicitation response');
			assert.deepStrictEqual(claude.controlResponses()[0].response.response, { action: 'accept', content: { echo: 'Name?' } });
			query.close();
		});

		test('handlers that yield nothing are answered as a refusal or cancellation', async () => {
			const query = await createService().query({
				prompt: openPrompt(),
				options: {
					canUseTool: async () => undefined as never,
					onElicitation: async () => null,
					onUserDialog: async () => null,
				},
			});
			const claude = processes[0];
			claude.emit({ type: 'control_request', request_id: 'a', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 't1' } });
			claude.emit({ type: 'control_request', request_id: 'b', request: { subtype: 'elicitation', mcp_server_name: 's', message: 'm' } });
			claude.emit({ type: 'control_request', request_id: 'c', request: { subtype: 'request_user_dialog', dialog_kind: 'k', payload: {} } });
			await waitFor(() => claude.controlResponses().length === 3, 'three responses');
			const byId = Object.fromEntries(claude.controlResponses().map(r => [r.response.request_id, r.response]));
			assert.strictEqual(byId.a.subtype, 'success');
			assert.strictEqual(byId.a.response.behavior, 'deny');
			assert.strictEqual(byId.a.response.toolUseID, 't1');
			assert.deepStrictEqual(byId.b.response, { action: 'cancel' });
			assert.deepStrictEqual(byId.c.response, { behavior: 'cancelled' });
			query.close();
		});

		test('unknown subtypes are answered with an error', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const claude = processes[0];
			claude.emit({ type: 'control_request', request_id: 'cli-5', request: { subtype: 'something_new' } });
			await waitFor(() => claude.controlResponses().length === 1, 'error response');
			assert.deepStrictEqual(claude.controlResponses()[0].response, { subtype: 'error', request_id: 'cli-5', error: 'Control request of unknown kind: something_new' });
			query.close();
		});

		test('mcp_message serves tools of an in-process server', async () => {
			const service = createService();
			const echo = await service.tool('echo', 'Echo the text', { text: z.string() }, async (args, extra) => {
				const meta = (extra as { _meta?: Record<string, unknown> })._meta;
				return { content: [{ type: 'text', text: `echo:${args.text}` }], ...(meta ? { _meta: meta } : {}) };
			});
			const server = await service.createSdkMcpServer({ name: 'client', tools: [echo] });
			const query = await service.query({ prompt: openPrompt(), options: { mcpServers: { client: server } } });
			const claude = processes[0];
			const ask = async (id: string, message: Json): Promise<Json> => {
				claude.emit({ type: 'control_request', request_id: id, request: { subtype: 'mcp_message', server_name: 'client', message } });
				await waitFor(() => claude.controlResponses().some(r => r.response.request_id === id), `response ${id}`);
				return claude.controlResponses().find(r => r.response.request_id === id).response.response.mcp_response;
			};

			const init = await ask('m1', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
			assert.strictEqual(init.result.protocolVersion, '2025-03-26');
			assert.deepStrictEqual(init.result.serverInfo, { name: 'client', version: '1.0.0' });

			const list = await ask('m2', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
			assert.strictEqual(list.result.tools.length, 1);
			assert.strictEqual(list.result.tools[0].name, 'echo');
			assert.deepStrictEqual(list.result.tools[0].inputSchema.properties, { text: { type: 'string' } });
			assert.deepStrictEqual(list.result.tools[0].inputSchema.required, ['text']);

			const call = await ask('m3', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } });
			assert.deepStrictEqual(call.result, { content: [{ type: 'text', text: 'echo:x' }] });

			const invalid = await ask('m4', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: {} } });
			assert.strictEqual(invalid.result.isError, true);

			const missing = await ask('m5', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
			assert.strictEqual(missing.error.code, -32602);

			// The request's `_meta` (where the CLI puts the tool_use_id) reaches the handler as `extra._meta`.
			const withMeta = await ask('m7', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { text: 'm' }, _meta: { 'claudecode/toolUseId': 'toolu_7' } } });
			assert.deepStrictEqual(withMeta.result, { content: [{ type: 'text', text: 'echo:m' }], _meta: { 'claudecode/toolUseId': 'toolu_7' } });

			const notification = await ask('m6', { jsonrpc: '2.0', method: 'notifications/initialized' });
			assert.deepStrictEqual(notification, { jsonrpc: '2.0', result: {}, id: 0 });
			query.close();
		});
	});

	suite('lifecycle', () => {

		test('close ends stdin, sends SIGTERM and the iterator ends without an error', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const claude = processes[0];
			const consumed = (async () => {
				for await (const _ of query) { /* drain */ }
			})();
			query.close();
			await consumed;
			assert.deepStrictEqual(claude.signals, ['SIGTERM']);
			await waitFor(() => claude.stdinEnded, 'stdin to end');
			await query.return(undefined);
		});

		test('aborting the controller closes the process', async () => {
			const abortController = new AbortController();
			const query = await createService().query({ prompt: openPrompt(), options: { abortController } });
			abortController.abort();
			await query.return(undefined);
			assert.deepStrictEqual(processes[0].signals, ['SIGTERM']);
		});

		test('pending requests are rejected on close', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const pending = query.setModel('x');
			query.close();
			await assert.rejects(pending, /session was closed/);
			await query.return(undefined);
		});

		test('a process that ignores SIGTERM is killed, and one that ignores SIGKILL is given up on', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
			configure = fake => fake.exitOnKill = false;
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const claude = processes[0];
			query.close();
			assert.deepStrictEqual(claude.signals, ['SIGTERM']);
			await query.return(undefined);
			assert.deepStrictEqual(claude.signals, ['SIGTERM', 'SIGKILL']);
		}));

		test('a failing prompt iterable stops the process', async () => {
			const failing: AsyncIterable<SDKUserMessage> = {
				[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('prompt source broke')) }),
			};
			const query = await createService().query({ prompt: failing, options: {} });
			await assert.rejects(query.next(), /prompt source broke/);
			assert.deepStrictEqual(processes[0].signals, ['SIGTERM']);
			await query.return(undefined);
		});

		test('a process error event stops the process', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			processes[0].raise(new Error('pipe broke'));
			await assert.rejects(query.next(), /pipe broke/);
			assert.deepStrictEqual(processes[0].signals, ['SIGTERM']);
			await query.return(undefined);
		});

		test('close after the session already failed still stops the process', async () => {
			configure = fake => fake.exitOnKill = false;
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const claude = processes[0];
			claude.stdout.write('x'.repeat(10) + '\n');
			claude.raise(new Error('boom'));
			await assert.rejects(query.next(), /boom/);
			assert.deepStrictEqual(claude.signals, ['SIGTERM']);
			query.close();
			assert.deepStrictEqual(claude.signals, ['SIGTERM']);
			claude.exit(null, 'SIGTERM');
			await query.return(undefined);
		});

		test('return() does not wait forever for a process that cannot be killed', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
			configure = fake => fake.exitOnKill = false;
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const result = await query.return(undefined);
			assert.strictEqual(result.done, true);
			assert.deepStrictEqual(processes[0].signals, ['SIGTERM', 'SIGKILL']);
		}));

		test('an unsignalable process counts as gone', async () => {
			configure = fake => { fake.exitOnKill = false; fake.killResult = false; };
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			await query.return(undefined);
		});

		test('an over-long output line fails the session', async () => {
			const options = {};
			const plan = await prepareClaudeCliLaunch(options);
			const query = new ClaudeCliQuery(options, launcher, { trace() { }, warn() { } }, plan, { maxLineLength: 100 });
			processes[0].stdout.write('a'.repeat(60));
			processes[0].stdout.write('b'.repeat(60));
			await assert.rejects(query.next(), /longer than 100 characters/);
			assert.deepStrictEqual(processes[0].signals, ['SIGTERM']);
			await query.return(undefined);
		});

		test('lines that are not protocol frames are ignored and later frames still arrive', async () => {
			const warnings: string[] = [];
			const options = {};
			const plan = await prepareClaudeCliLaunch(options);
			const query = new ClaudeCliQuery(options, launcher, { trace() { }, warn: m => warnings.push(m) }, plan);
			const claude = processes[0];
			for (const line of ['null', '5', '"text"', '[1,2]', '{"no":"type"}', 'not json at all', '{"type":"control_response"}', '{"type":"control_response","response":{"request_id":"nope"}}', '{"type":"control_request","request_id":"r"}', '{"type":"control_cancel_request"}']) {
				claude.stdout.write(`${line}\n`);
			}
			claude.emit(assistant('still alive'));
			const first = await query.next();
			assert.deepStrictEqual(first.value, assistant('still alive'));
			assert.deepStrictEqual(warnings, []);
			await query.return(undefined);
		});

		test('a frame split over several chunks is reassembled', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const text = JSON.stringify(assistant('chunked'));
			processes[0].stdout.write(text.slice(0, 10));
			processes[0].stdout.write(text.slice(10, 30));
			processes[0].stdout.write(`${text.slice(30)}\n`);
			assert.deepStrictEqual((await query.next()).value, assistant('chunked'));
			await query.return(undefined);
		});

		test('a non-zero exit fails the iterator with the stderr tail', async () => {
			const stderr: string[] = [];
			const query = await createService().query({ prompt: 'hi', options: { stderr: data => stderr.push(data) } });
			const claude = processes[0];
			claude.emit(assistant('partial'));
			claude.stderr.write('Error: not logged in\n');
			await waitFor(() => stderr.length > 0, 'stderr');
			claude.exit(1);
			const first = await query.next();
			assert.strictEqual(first.done, false);
			await assert.rejects(query.next(), /exited with code 1\. stderr: Error: not logged in/);
			assert.deepStrictEqual((await query.next()).done, true);
			assert.deepStrictEqual(stderr, ['Error: not logged in\n']);
		});

		test('a signal exit fails the iterator', async () => {
			const query = await createService().query({ prompt: 'hi', options: {} });
			processes[0].exit(null, 'SIGSEGV');
			await assert.rejects(query.next(), /terminated by signal SIGSEGV/);
		});

		test('a clean exit ends the iterator and rejects pending requests', async () => {
			const query = await createService().query({ prompt: openPrompt(), options: {} });
			const pending = query.setModel('x');
			processes[0].exit(0);
			await assert.rejects(pending, /exited before responding/);
			assert.deepStrictEqual((await query.next()).done, true);
		});

		test('a missing binary reports where to get it', async () => {
			configure = fake => {
				fake.autoInitialize = false;
				queueMicrotask(() => fake.raise(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
			};
			const query = await createService().query({ prompt: 'hi', options: {} });
			await assert.rejects(query.next(), /'claude' was not found.*PATH/);
			await assert.rejects(query.initializationResult(), /was not found/);
		});

		test('a throwing spawn fails the query instead of the call', async () => {
			const service = new ClaudeCliSdkService({ launch() { throw new Error('EACCES'); } }, new NullLogService());
			const query = await service.query({ prompt: 'hi', options: {} });
			await assert.rejects(query.next(), /EACCES/);
		});
	});

	suite('startup', () => {

		test('resolves after the initialize answer and sends the prompt only once query is called', async () => {
			const warm = await createService().startup({ options: { cwd: tmpdir() } });
			const claude = processes[0];
			assert.deepStrictEqual(claude.sent.map(frame => frame.type), ['control_request']);
			const query = warm.query(prompt('go'));
			await waitFor(() => claude.sent.some(frame => frame.type === 'user'), 'prompt');
			assert.throws(() => warm.query('again'), /already supplied/);
			claude.emit(result());
			const first = await query.next();
			assert.strictEqual((first.value as SDKMessage).type, 'result');
			await warm[Symbol.asyncDispose]();
			await query.return(undefined);
			assert.deepStrictEqual(claude.signals, ['SIGTERM']);
		});

		test('rejects when the process dies before initializing', async () => {
			configure = fake => { fake.autoInitialize = false; queueMicrotask(() => fake.exit(2)); };
			await assert.rejects(createService().startup({ options: {} }), /exited with code 2/);
		});

		test('times out and closes the process when initialize is never answered', async () => {
			configure = fake => fake.autoInitialize = false;
			await assert.rejects(createService().startup({ options: {}, initializeTimeoutMs: 20 }), /did not answer initialize/);
			assert.deepStrictEqual(processes[0].signals, ['SIGTERM']);
		});
	});

	suite('sessions on disk', () => {

		test('listings are empty and fork and delete are refused', async () => {
			const service = createService();
			assert.deepStrictEqual(await service.listSessions(), []);
			assert.strictEqual(await service.getSessionInfo('x'), undefined);
			assert.deepStrictEqual(await service.getSessionMessages('x'), []);
			assert.deepStrictEqual(await service.listSubagents('x'), []);
			assert.deepStrictEqual(await service.getSubagentMessages('x', 'a'), []);
			assert.strictEqual(await service.canLoadWithoutDownload(), true);
			await service.ensureAvailable();
			await assert.rejects(service.forkSession('x'), /not supported yet/);
			await assert.rejects(service.deleteSession('x'), /not supported yet/);
		});
	});

	suite('isClaudeCliAvailable', () => {
		let directory: string;

		setup(() => {
			directory = mkdtempSync(join(tmpdir(), 'claude-cli-test-'));
		});

		teardown(() => {
			rmSync(directory, { recursive: true, force: true });
		});

		test('finds an executable named claude on PATH', async () => {
			const bin = join(directory, 'claude');
			writeFileSync(bin, '#!/bin/sh\n');
			chmodSync(bin, 0o755);
			assert.strictEqual(await isClaudeCliAvailable({ PATH: `/nonexistent:${directory}` }, 'linux'), true);
		});

		test('ignores a file that is not executable and a missing PATH', async () => {
			const bin = join(directory, 'claude');
			writeFileSync(bin, '');
			chmodSync(bin, 0o644);
			assert.strictEqual(await isClaudeCliAvailable({ PATH: directory }, 'linux'), false);
			assert.strictEqual(await isClaudeCliAvailable({}, 'linux'), false);
		});
	});
});
