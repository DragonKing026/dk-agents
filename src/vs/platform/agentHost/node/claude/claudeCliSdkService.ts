/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AnyZodRawShape, ForkSessionOptions, ForkSessionResult, GetSessionMessagesOptions, GetSubagentMessagesOptions, InferShape, ListSubagentsOptions, McpSdkServerConfigWithInstance, Options, Query, SDKSessionInfo, SDKUserMessage, SdkMcpToolDefinition, SessionMessage, SessionMutationOptions, WarmQuery, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import { delimiter, join } from '../../../../base/common/path.js';
import { Emitter } from '../../../../base/common/event.js';
import { ILogService } from '../../../log/common/log.js';
import { ClaudeCliExecutable, prepareClaudeCliLaunch } from './claudeCliArgs.js';
import { createClaudeCliMcpServer, createClaudeCliTool } from './claudeCliMcp.js';
import { ClaudeCliQuery, startClaudeCliWarmQuery, type IClaudeCliLogger, type IClaudeCliProcess, type IClaudeCliProcessLauncher } from './claudeCliQuery.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';

/**
 * Whether the Claude Code CLI can be found on `PATH`. A plain file lookup:
 * the binary is never started, so none of its hooks or updaters run.
 */
export async function isClaudeCliAvailable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	const extensions = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
	for (const directory of (env.PATH ?? '').split(delimiter)) {
		if (!directory) {
			continue;
		}
		for (const extension of extensions) {
			const candidate = join(directory, ClaudeCliExecutable + extension);
			try {
				if ((await stat(candidate)).isFile()) {
					await access(candidate, constants.X_OK);
					return true;
				}
			} catch { /* not here */ }
		}
	}
	return false;
}

/** How long after `exit` the pipes may stay open (grandchildren can hold them) before the exit is reported anyway. */
const PipeDrainGraceMs = 2000;

class ChildProcessLauncher implements IClaudeCliProcessLauncher {
	launch(command: string, args: readonly string[], options: { cwd: string | undefined; env: Record<string, string> }): IClaudeCliProcess {
		// Own process group on POSIX so that the whole tree (MCP servers, background commands) can be signalled.
		const grouped = process.platform !== 'win32';
		const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: grouped });
		// Permanent handlers: an unhandled 'error' on any of these would crash the host.
		child.on('error', () => { });
		child.stdin.on('error', () => { });
		child.stdout.on('error', () => { });
		child.stderr.on('error', () => { });

		const exit = new Emitter<{ code: number | null; signal: string | null }>();
		const failure = new Emitter<Error>();
		let exitReported = false;
		const reportExit = (code: number | null, signal: string | null) => {
			if (!exitReported) {
				exitReported = true;
				exit.fire({ code, signal });
			}
		};
		child.once('close', reportExit);
		child.once('exit', (code, signal) => {
			const timer = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				reportExit(code, signal);
			}, PipeDrainGraceMs);
			(timer as unknown as { unref?(): void }).unref?.();
		});
		child.on('error', error => failure.fire(error));

		return {
			stdin: child.stdin,
			stdout: child.stdout,
			stderr: child.stderr,
			kill: signal => {
				if (grouped && child.pid !== undefined) {
					try {
						process.kill(-child.pid, signal);
						return true;
					} catch { /* group already gone: fall back to the child itself */ }
				}
				return child.kill(signal);
			},
			onDidExit: exit.event,
			onDidError: failure.event,
		};
	}
}

const NotSupportedYet = 'not supported yet';

/**
 * {@link IClaudeAgentSdkService} that talks to the user's own `claude` binary
 * (Claude Code CLI) over its stream-json protocol instead of loading
 * `@anthropic-ai/claude-agent-sdk` at run time. The binary authenticates by
 * itself; nothing here reads or forwards credentials.
 *
 * Reading sessions back from disk is not implemented yet: listings are empty
 * and forking or deleting a session is refused.
 */
export class ClaudeCliSdkService implements IClaudeAgentSdkService {
	declare readonly _serviceBrand: undefined;

	private readonly _logger: IClaudeCliLogger;

	constructor(
		private readonly _launcher: IClaudeCliProcessLauncher | undefined,
		@ILogService logService: ILogService,
	) {
		this._logger = {
			trace: message => logService.trace(message),
			warn: message => logService.warn(message),
		};
	}

	async listSessions(): Promise<readonly SDKSessionInfo[]> {
		return [];
	}

	async getSessionInfo(_sessionId: string): Promise<SDKSessionInfo | undefined> {
		return undefined;
	}

	async startup(params: { options: Options; initializeTimeoutMs?: number }): Promise<WarmQuery> {
		const plan = await prepareClaudeCliLaunch(params.options);
		return startClaudeCliWarmQuery(params.options, this._launcher ?? new ChildProcessLauncher(), this._logger, plan, params.initializeTimeoutMs);
	}

	async query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Promise<Query> {
		const options = params.options ?? {};
		const plan = await prepareClaudeCliLaunch(options);
		const query = new ClaudeCliQuery(options, this._launcher ?? new ChildProcessLauncher(), this._logger, plan);
		query.attachPrompt(params.prompt);
		return query;
	}

	async getSessionMessages(_sessionId: string, _options?: GetSessionMessagesOptions): Promise<readonly SessionMessage[]> {
		return [];
	}

	async listSubagents(_sessionId: string, _options?: ListSubagentsOptions): Promise<readonly string[]> {
		return [];
	}

	async getSubagentMessages(_sessionId: string, _agentId: string, _options?: GetSubagentMessagesOptions): Promise<readonly SessionMessage[]> {
		return [];
	}

	async canLoadWithoutDownload(): Promise<boolean> {
		return true;
	}

	async ensureAvailable(): Promise<void> {
		// Nothing to download: the binary is the user's own installation.
	}

	async forkSession(_sessionId: string, _options?: ForkSessionOptions): Promise<ForkSessionResult> {
		throw new Error(`Forking a Claude session is ${NotSupportedYet}`);
	}

	async deleteSession(_sessionId: string, _options?: SessionMutationOptions): Promise<void> {
		throw new Error(`Deleting a Claude session is ${NotSupportedYet}`);
	}

	async createSdkMcpServer(options: {
		name: string;
		version?: string;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		tools?: Array<SdkMcpToolDefinition<any>>;
	}): Promise<McpSdkServerConfigWithInstance> {
		return createClaudeCliMcpServer(options);
	}

	async tool<Schema extends AnyZodRawShape>(
		name: string,
		description: string,
		inputSchema: Schema,
		// eslint-disable-next-line local/code-prefer-event-or-observable -- Mirrors the tool handler contract of the SDK types.
		handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
		options?: Parameters<typeof tool>[4],
	): Promise<SdkMcpToolDefinition<Schema>> {
		return createClaudeCliTool(name, description, inputSchema, handler, options);
	}
}
