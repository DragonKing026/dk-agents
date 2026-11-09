/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AccountInfo, AgentInfo, HookCallback, HookCallbackMatcher, McpServerConfig, McpServerStatus, McpSetServersResult, ModelInfo, Options, PermissionMode, Query, RewindFilesResult, SDKControlGetContextUsageResponse, SDKControlGetUsageResponse, SDKControlInitializeResponse, SDKControlInterruptResponse, SDKControlMcpReadResourceResponse, SDKControlReadFileResponse, SDKControlReloadOutputStylesResponse, SDKControlReloadPluginsResponse, SDKControlReloadSkillsResponse, SDKMessage, SDKUserMessage, SdkPluginConfig, SlashCommand, WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Readable, Writable } from 'stream';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { buildClaudeCliInitializeRequest, isSdkMcpServer, type IClaudeCliLaunchPlan } from './claudeCliArgs.js';
import { ClaudeCliMcpServer, type IJsonRpcMessage } from './claudeCliMcp.js';

/**
 * A running `claude` process as seen by {@link ClaudeCliQuery}. Production
 * wraps a `ChildProcess`; tests provide streams and fire the events.
 */
export interface IClaudeCliProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable | undefined;
	/** Signal the process and everything it started; `false` when there is nothing to signal. */
	kill(signal: NodeJS.Signals): boolean;
	/** The process finished and its output is drained (or gave up waiting for it). */
	readonly onDidExit: Event<{ readonly code: number | null; readonly signal: string | null }>;
	/** The process could not be spawned or failed at runtime. */
	readonly onDidError: Event<Error>;
}

export interface IClaudeCliSpawnOptions {
	readonly cwd: string | undefined;
	readonly env: Record<string, string>;
}

/** Starts the `claude` binary. Injected so tests can drive the protocol without one. */
export interface IClaudeCliProcessLauncher {
	launch(command: string, args: readonly string[], options: IClaudeCliSpawnOptions): IClaudeCliProcess;
}

export interface IClaudeCliLogger {
	trace(message: string): void;
	warn(message: string): void;
}

/** Tunable limits; the defaults are what production uses. */
export interface IClaudeCliLimits {
	/** Longest stdout line accepted before the session is failed. */
	readonly maxLineLength?: number;
	/** Time the process gets to exit after SIGTERM before it is killed. */
	readonly killGraceMs?: number;
	/** Extra time after SIGKILL before the process is considered gone anyway. */
	readonly giveUpMs?: number;
	/** Quiet period after the last result before an input that has ended is closed. */
	readonly idleAfterResultMs?: number;
}

const DefaultLimits = {
	maxLineLength: 64 * 1024 * 1024,
	killGraceMs: 5000,
	giveUpMs: 3000,
	idleAfterResultMs: 3000,
};
const StderrTailChars = 2048;
const DefaultInitializeTimeoutMs = 60_000;

class MessageQueue<T> implements AsyncIterator<T, undefined> {
	private readonly _items: T[] = [];
	private readonly _waiters: { resolve(result: IteratorResult<T, undefined>): void; reject(error: unknown): void }[] = [];
	private _done = false;
	private _error: { readonly error: unknown } | undefined;

	push(item: T): void {
		if (this._done) {
			return;
		}
		const waiter = this._waiters.shift();
		if (waiter) {
			waiter.resolve({ done: false, value: item });
		} else {
			this._items.push(item);
		}
	}

	end(): void {
		this._done = true;
		for (const waiter of this._waiters.splice(0)) {
			waiter.resolve({ done: true, value: undefined });
		}
	}

	/** Items already queued are delivered first, then the error is thrown once. */
	fail(error: unknown): void {
		if (this._done) {
			return;
		}
		const waiter = this._waiters.shift();
		if (waiter) {
			waiter.reject(error);
		} else {
			this._error = { error };
		}
		this.end();
	}

	next(): Promise<IteratorResult<T, undefined>> {
		if (this._items.length > 0) {
			return Promise.resolve({ done: false, value: this._items.shift()! });
		}
		if (this._error) {
			const { error } = this._error;
			this._error = undefined;
			return Promise.reject(error);
		}
		if (this._done) {
			return Promise.resolve({ done: true, value: undefined });
		}
		return new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
	}
}

interface IPendingRequest {
	resolve(response: Record<string, unknown>): void;
	reject(error: Error): void;
}

interface IControlRequestEnvelope {
	readonly type: 'control_request';
	readonly request_id: string;
	readonly request: { readonly subtype: string;[key: string]: unknown };
}

interface IControlResponseEnvelope {
	readonly response: { readonly subtype: string; readonly request_id: string; readonly response?: Record<string, unknown>; readonly error?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
	(timer as unknown as { unref?(): void }).unref?.();
	return timer;
}

/**
 * `Query` implemented over the stream-json protocol of the `claude` binary:
 * newline-delimited JSON in both directions. SDK messages flow out of the
 * iterator unchanged; control requests (both directions) are multiplexed on
 * the same pipes and matched by `request_id`.
 *
 * Lifecycle: there is a single way to stop the process, {@link _terminate}
 * (end stdin, SIGTERM, SIGKILL after a grace period, give up after a hard
 * limit). It runs on {@link close} and whenever the session fails, whatever
 * state the iterator is in.
 */
export class ClaudeCliQuery implements Query {

	private readonly _store = new DisposableStore();
	private readonly _output = new MessageQueue<SDKMessage>();
	private readonly _pending = new Map<string, IPendingRequest>();
	private readonly _cancelControllers = new Map<string, AbortController>();
	private readonly _hookCallbacks = new Map<string, HookCallback>();
	private readonly _sdkMcpServers = new Map<string, ClaudeCliMcpServer>();
	private readonly _initialization: Promise<SDKControlInitializeResponse>;
	private readonly _exited: Promise<void>;
	private readonly _signal: AbortSignal | undefined;
	private readonly _limits: Required<IClaudeCliLimits>;
	private readonly _onAbort = () => this.close();
	private readonly _timers = new Set<ReturnType<typeof setTimeout>>();

	private _process: IClaudeCliProcess | undefined;
	private _resolveExited!: () => void;
	private _nextRequestId = 1;
	private _partialLine: string[] = [];
	private _partialLength = 0;
	private _stdoutDead = false;
	private _stderrTail = '';
	private _closing = false;
	private _terminating = false;
	private _processExited = false;
	private _finished = false;
	private _inputEnded = false;
	private _inputClosed = false;
	private _closeAfterFirstResult = false;
	private _promptAttached = false;
	private _outstandingTurns = 0;
	private _resultsSinceWrite = 0;
	private _idleTimer: ReturnType<typeof setTimeout> | undefined;
	private _latestCommands: SlashCommand[] | undefined;
	private _initializeRequest: Record<string, unknown> | undefined;

	constructor(
		private readonly _options: Options,
		launcher: IClaudeCliProcessLauncher,
		private readonly _logger: IClaudeCliLogger,
		private readonly _plan: IClaudeCliLaunchPlan,
		limits: IClaudeCliLimits = {},
	) {
		this._limits = { ...DefaultLimits, ...limits };
		this._exited = new Promise<void>(resolve => this._resolveExited = resolve);
		this._signal = _options.abortController?.signal;
		for (const warning of _plan.warnings) {
			this._logger.warn(`[ClaudeCli] ${warning}`);
		}

		let startupError: Error | undefined;
		for (const [name, config] of Object.entries(_options.mcpServers ?? {})) {
			if (isSdkMcpServer(config)) {
				if (config.instance instanceof ClaudeCliMcpServer) {
					this._sdkMcpServers.set(name, config.instance);
				} else {
					startupError ??= new Error(`In-process MCP server '${name}' was not created by this provider`);
				}
			}
		}

		let launched: IClaudeCliProcess | undefined;
		if (!startupError) {
			try {
				launched = launcher.launch(_plan.command, _plan.args, { cwd: _plan.cwd, env: _plan.env });
			} catch (error) {
				startupError = toError(error);
			}
		}

		if (!launched) {
			this._initialization = Promise.reject(startupError);
			this._initialization.catch(() => { });
			this._finish(startupError);
			return;
		}

		const child = this._process = launched;
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this._onStdout(chunk));
		child.stdout.on('error', error => this._logger.trace(`[ClaudeCli] stdout error: ${error.message}`));
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => this._onStderr(chunk));
		child.stderr?.on('error', error => this._logger.trace(`[ClaudeCli] stderr error: ${error.message}`));
		// A write racing the process exit surfaces as EPIPE; exit handling reports the real cause.
		child.stdin.on('error', error => this._logger.trace(`[ClaudeCli] stdin error: ${error.message}`));
		this._store.add(child.onDidError(error => this._finish(this._describeProcessError(error))));
		this._store.add(child.onDidExit(({ code, signal }) => this._onExit(code, signal)));

		if (this._signal) {
			if (this._signal.aborted) {
				this.close();
			} else {
				this._signal.addEventListener('abort', this._onAbort, { once: true });
			}
		}

		// The first frame on the wire is always `initialize`; prompts follow it.
		this._initialization = this._request(this._buildInitializeRequest()) as Promise<SDKControlInitializeResponse>;
		this._initialization.catch(() => { });
	}

	// #region Prompt input

	/** Feed the prompt of a query started with {@link startup}; may be called once. */
	attachPrompt(prompt: string | AsyncIterable<SDKUserMessage>): void {
		if (this._promptAttached) {
			throw new Error('The prompt of this query was already supplied');
		}
		this._promptAttached = true;
		if (typeof prompt === 'string') {
			// A single prompt: the input is closed as soon as its first result arrives.
			this._closeAfterFirstResult = true;
			this._inputEnded = true;
			this._writeUserMessage({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null }).catch(error => this._logger.trace(`[ClaudeCli] could not send the prompt: ${toError(error).message}`));
		} else {
			this.streamInput(prompt).catch(error => this._finish(toError(error)));
		}
	}

	async streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void> {
		try {
			for await (const message of stream) {
				if (this._closing || this._finished) {
					break;
				}
				await this._writeUserMessage(message);
			}
		} finally {
			this._inputEnded = true;
			this._closeInputIfDone();
		}
	}

	private _writeUserMessage(message: SDKUserMessage): Promise<void> {
		if (this._finished) {
			// The process is already gone; the iterator carries the reason.
			return Promise.resolve();
		}
		this._outstandingTurns++;
		this._resultsSinceWrite = 0;
		this._clearIdleTimer();
		return this._write(message);
	}

	/**
	 * The CLI may merge queued messages into one turn or answer one message with
	 * several results, so counting results against messages is not reliable on
	 * its own. After the prompt iterable has ended, stdin is closed when every
	 * message was answered, or, once at least one result arrived since the last
	 * message, after a quiet period without further output.
	 */
	private _closeInputIfDone(): void {
		if (!this._inputEnded || this._inputClosed) {
			return;
		}
		if (this._outstandingTurns <= 0) {
			this._endStdin();
		} else if (this._resultsSinceWrite > 0) {
			this._armIdleTimer();
		}
	}

	private _armIdleTimer(): void {
		this._clearIdleTimer();
		this._idleTimer = this._schedule(this._limits.idleAfterResultMs, () => {
			this._idleTimer = undefined;
			this._endStdin();
		});
	}

	private _clearIdleTimer(): void {
		if (this._idleTimer) {
			clearTimeout(this._idleTimer);
			this._timers.delete(this._idleTimer);
			this._idleTimer = undefined;
		}
	}

	private _schedule(delayMs: number, callback: () => void): ReturnType<typeof setTimeout> {
		const timer = unref(setTimeout(() => {
			this._timers.delete(timer);
			callback();
		}, delayMs));
		this._timers.add(timer);
		return timer;
	}

	private _endStdin(): void {
		if (this._inputClosed) {
			return;
		}
		this._inputClosed = true;
		this._clearIdleTimer();
		try {
			this._process?.stdin.end();
		} catch { /* already closed */ }
	}

	// #endregion

	// #region Output (AsyncGenerator)

	next(): Promise<IteratorResult<SDKMessage, void>> {
		return this._output.next();
	}

	async return(_value?: void): Promise<IteratorResult<SDKMessage, void>> {
		this.close();
		await this._exited;
		return { done: true, value: undefined };
	}

	throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
		this.close();
		return Promise.reject(error);
	}

	[Symbol.asyncIterator](): this {
		return this;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.return();
	}

	// #endregion

	// #region Transport

	/** Write one frame; resolves once the stream has accepted it (waits for `drain` under back-pressure). */
	private _write(message: unknown): Promise<void> {
		const stdin = this._process?.stdin;
		if (!stdin || this._finished || this._closing || this._inputClosed) {
			return Promise.reject(new Error('Claude Code is not accepting input any more'));
		}
		try {
			if (stdin.write(`${JSON.stringify(message)}\n`)) {
				return Promise.resolve();
			}
		} catch (error) {
			return Promise.reject(toError(error));
		}
		return new Promise<void>(resolve => {
			const done = () => {
				stdin.off('drain', done);
				stdin.off('close', done);
				resolve();
			};
			stdin.once('drain', done);
			stdin.once('close', done);
		});
	}

	private _onStdout(chunk: string): void {
		if (this._stdoutDead) {
			return;
		}
		let start = 0;
		for (; ;) {
			const newline = chunk.indexOf('\n', start);
			if (newline < 0) {
				const rest = chunk.slice(start);
				if (rest) {
					this._partialLine.push(rest);
					this._partialLength += rest.length;
					if (this._partialLength > this._limits.maxLineLength) {
						this._stdoutDead = true;
						this._partialLine = [];
						this._finish(new Error(`Claude Code wrote an output line longer than ${this._limits.maxLineLength} characters`));
					}
				}
				return;
			}
			this._partialLine.push(chunk.slice(start, newline));
			const line = this._partialLine.join('').trim();
			this._partialLine = [];
			this._partialLength = 0;
			start = newline + 1;
			if (line) {
				this._onLine(line);
			}
		}
	}

	private _onStderr(chunk: string): void {
		this._stderrTail = (this._stderrTail + chunk).slice(-StderrTailChars);
		try {
			this._options.stderr?.(chunk);
		} catch (error) {
			this._logger.warn(`[ClaudeCli] stderr callback failed: ${toError(error).message}`);
		}
	}

	private _onLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this._logger.trace(`[ClaudeCli] ignoring non-JSON output line (${line.length} chars)`);
			return;
		}
		if (!isRecord(message) || typeof message.type !== 'string') {
			this._logger.trace('[ClaudeCli] ignoring output line that is not a protocol frame');
			return;
		}
		try {
			this._dispatchFrame(message as Record<string, unknown> & { type: string });
		} catch (error) {
			this._logger.warn(`[ClaudeCli] failed to handle a '${message.type}' frame: ${toError(error).message}`);
		}
	}

	private _dispatchFrame(message: Record<string, unknown> & { type: string }): void {
		switch (message.type) {
			case 'control_response':
				if (isRecord(message.response) && typeof message.response.request_id === 'string') {
					this._onControlResponse(message as unknown as IControlResponseEnvelope);
				} else {
					this._logger.trace('[ClaudeCli] ignoring a malformed control_response');
				}
				return;
			case 'control_request':
				if (isRecord(message.request) && typeof message.request.subtype === 'string' && typeof message.request_id === 'string') {
					this._onControlRequest(message as unknown as IControlRequestEnvelope).catch(error => this._logger.warn(`[ClaudeCli] control request handling failed: ${toError(error).message}`));
				} else {
					this._logger.trace('[ClaudeCli] ignoring a malformed control_request');
				}
				return;
			case 'control_cancel_request':
				if (typeof message.request_id === 'string') {
					this._cancelControllers.get(message.request_id)?.abort();
				}
				return;
			case 'keep_alive':
				return;
		}
		const sdkMessage = message as unknown as SDKMessage;
		if (sdkMessage.type === 'result') {
			this._outstandingTurns--;
			this._resultsSinceWrite++;
			if (this._closeAfterFirstResult) {
				this._endStdin();
			} else {
				this._closeInputIfDone();
			}
		} else if (this._inputEnded && !this._inputClosed && this._resultsSinceWrite > 0) {
			this._armIdleTimer();
		}
		if (sdkMessage.type === 'system' && sdkMessage.subtype === 'commands_changed') {
			this._latestCommands = sdkMessage.commands;
		}
		this._output.push(sdkMessage);
	}

	private _onExit(code: number | null, signal: string | null): void {
		if (this._partialLine.length > 0) {
			const rest = this._partialLine.join('').trim();
			this._partialLine = [];
			if (rest) {
				this._onLine(rest);
			}
		}
		this._markProcessExited();
		if (this._closing || (code === 0 && !signal)) {
			this._finish();
			return;
		}
		const how = code !== null && code !== 0 ? `exited with code ${code}` : `was terminated by signal ${signal}`;
		const stderr = this._stderrTail.trim();
		this._finish(new Error(`Claude Code process ${how}${stderr ? `. stderr: ${stderr}` : ''}`));
	}

	private _describeProcessError(error: Error): Error {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return new Error(`Claude Code executable '${this._plan.command}' was not found. Install the Claude Code CLI and make sure it is on PATH.`);
		}
		return new Error(`Failed to run Claude Code process: ${error.message}`);
	}

	/**
	 * Settle the iterator and every outstanding request exactly once, and stop
	 * the process: a failed session must not leave a running binary behind.
	 */
	private _finish(error?: Error): void {
		if (this._finished) {
			return;
		}
		this._finished = true;
		this._signal?.removeEventListener('abort', this._onAbort);
		this._clearIdleTimer();
		const failure = error ?? new Error('Claude Code process exited before responding');
		for (const pending of this._pending.values()) {
			pending.reject(failure);
		}
		this._pending.clear();
		for (const controller of this._cancelControllers.values()) {
			controller.abort();
		}
		this._cancelControllers.clear();
		if (error && !this._closing) {
			this._output.fail(error);
		} else {
			this._output.end();
		}
		this._terminate();
	}

	/** The one shutdown path: end stdin, SIGTERM, SIGKILL after the grace period, give up after the hard limit. */
	private _terminate(): void {
		const child = this._process;
		if (this._processExited) {
			return;
		}
		if (!child) {
			this._markProcessExited();
			return;
		}
		if (this._terminating) {
			return;
		}
		this._terminating = true;
		this._endStdin();
		let signalled = false;
		try {
			signalled = child.kill('SIGTERM');
		} catch { /* already gone */ }
		if (!signalled) {
			this._markProcessExited();
			return;
		}
		this._schedule(this._limits.killGraceMs, () => {
			try {
				child.kill('SIGKILL');
			} catch { /* already gone */ }
		});
		this._schedule(this._limits.killGraceMs + this._limits.giveUpMs, () => {
			this._logger.warn('[ClaudeCli] the process did not exit after SIGKILL; giving up on it');
			this._markProcessExited();
		});
	}

	private _markProcessExited(): void {
		if (this._processExited) {
			return;
		}
		this._processExited = true;
		for (const timer of this._timers) {
			clearTimeout(timer);
		}
		this._timers.clear();
		this._store.dispose();
		this._resolveExited();
		this._plan.dispose().catch(() => { });
	}

	/**
	 * Stop the session. The iterator ends quietly right away; {@link return}
	 * additionally waits until the process is gone.
	 */
	close(): void {
		if (this._closing) {
			return;
		}
		this._closing = true;
		this._signal?.removeEventListener('abort', this._onAbort);
		const reason = new Error('The Claude session was closed');
		for (const pending of this._pending.values()) {
			pending.reject(reason);
		}
		this._pending.clear();
		for (const controller of this._cancelControllers.values()) {
			controller.abort();
		}
		this._output.end();
		this._terminate();
	}

	// #endregion

	// #region Control requests we send

	private _request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (this._closing || this._finished) {
			return Promise.reject(new Error('The Claude session was closed'));
		}
		const requestId = `req-${this._nextRequestId++}`;
		return new Promise((resolve, reject) => {
			this._pending.set(requestId, { resolve, reject });
			this._write({ type: 'control_request', request_id: requestId, request }).catch(error => {
				this._pending.delete(requestId);
				reject(toError(error));
			});
		});
	}

	private _onControlResponse(message: IControlResponseEnvelope): void {
		const { subtype, request_id, response, error } = message.response;
		const pending = this._pending.get(request_id);
		if (!pending) {
			return;
		}
		this._pending.delete(request_id);
		if (subtype === 'error') {
			pending.reject(new Error(error ?? 'Control request failed'));
		} else {
			pending.resolve(isRecord(response) ? response : {});
		}
	}

	private _buildInitializeRequest(): Record<string, unknown> {
		if (!this._initializeRequest) {
			let hooks: Record<string, unknown[]> | undefined;
			let nextId = 0;
			for (const [event, matchers] of Object.entries(this._options.hooks ?? {}) as [string, HookCallbackMatcher[]][]) {
				if (matchers.length === 0) {
					continue;
				}
				hooks ??= {};
				hooks[event] = matchers.map(matcher => ({
					matcher: matcher.matcher,
					hookCallbackIds: matcher.hooks.map(callback => {
						const id = `hook_${nextId++}`;
						this._hookCallbacks.set(id, callback);
						return id;
					}),
					timeout: matcher.timeout,
				}));
			}
			this._initializeRequest = buildClaudeCliInitializeRequest(this._options, hooks, [...this._sdkMcpServers.keys()]);
		}
		return this._initializeRequest;
	}

	// #endregion

	// #region Control requests we receive

	private async _onControlRequest(envelope: IControlRequestEnvelope): Promise<void> {
		const requestId = envelope.request_id;
		const controller = new AbortController();
		this._cancelControllers.set(requestId, controller);
		try {
			const result = await this._handleControlRequest(envelope.request, requestId, controller.signal);
			if (!controller.signal.aborted && !this._finished) {
				await this._write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: result } });
			}
		} catch (error) {
			if (controller.signal.aborted || this._finished) {
				return;
			}
			await this._write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: toError(error).message } }).catch(() => { /* process is gone */ });
		} finally {
			if (this._cancelControllers.get(requestId) === controller) {
				this._cancelControllers.delete(requestId);
			}
		}
	}

	/**
	 * Every request is answered: a handler that yields nothing (`null`) is
	 * answered as a refusal or cancellation, because the binary waits for the
	 * reply for as long as the turn runs.
	 */
	private async _handleControlRequest(request: IControlRequestEnvelope['request'], requestId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
		switch (request.subtype) {
			case 'can_use_tool': {
				const canUseTool = this._options.canUseTool;
				if (!canUseTool) {
					throw new Error('A tool permission was requested but no canUseTool handler is configured');
				}
				const matchedAskRule = request.matched_ask_rule as { source: string; tool_name: string; rule_content?: string } | undefined;
				const mcpServer = request.mcp_server as { name: string; source: string } | undefined;
				const result = await canUseTool(request.tool_name as string, request.input as Record<string, unknown>, {
					signal,
					suggestions: request.permission_suggestions as never,
					blockedPath: request.blocked_path as string | undefined,
					...(mcpServer ? { mcpServer: { name: mcpServer.name, source: mcpServer.source } } : {}),
					decisionReason: request.decision_reason as string | undefined,
					...(typeof request.decision_reason_type === 'string' ? { decisionReasonType: request.decision_reason_type as never } : {}),
					title: request.title as string | undefined,
					displayName: request.display_name as string | undefined,
					description: request.description as string | undefined,
					defaultToNo: request.default_to_no as boolean | undefined,
					suppressAlwaysAllowRule: request.suppress_always_allow_rule as boolean | undefined,
					toolUseID: request.tool_use_id as string,
					agentID: request.agent_id as string | undefined,
					requestId,
					...(typeof request.requires_user_interaction === 'boolean' ? { requiresUserInteraction: request.requires_user_interaction } : {}),
					...(matchedAskRule ? { matchedAskRule: { source: matchedAskRule.source, toolName: matchedAskRule.tool_name, ...(matchedAskRule.rule_content !== undefined ? { ruleContent: matchedAskRule.rule_content } : {}) } } : {}),
				});
				if (result === null || result === undefined) {
					return { behavior: 'deny', message: 'The permission request was not answered by the host', toolUseID: request.tool_use_id };
				}
				return { ...result, toolUseID: request.tool_use_id };
			}
			case 'hook_callback': {
				const callback = this._hookCallbacks.get(request.callback_id as string);
				if (!callback) {
					throw new Error(`Hook callback id is not registered: ${String(request.callback_id)}`);
				}
				return await callback(request.input as never, request.tool_use_id as string | undefined, { signal }) as Record<string, unknown>;
			}
			case 'elicitation': {
				const onElicitation = this._options.onElicitation;
				if (!onElicitation) {
					return { action: 'decline' };
				}
				const result = await onElicitation({
					serverName: request.mcp_server_name as string,
					message: request.message as string,
					mode: request.mode as 'form' | 'url' | undefined,
					url: request.url as string | undefined,
					elicitationId: request.elicitation_id as string | undefined,
					requestedSchema: request.requested_schema as Record<string, unknown> | undefined,
					title: request.title as string | undefined,
					displayName: request.display_name as string | undefined,
					description: request.description as string | undefined,
				}, { signal, requestId });
				return result ? result as unknown as Record<string, unknown> : { action: 'cancel' };
			}
			case 'request_user_dialog': {
				const onUserDialog = this._options.onUserDialog;
				if (!onUserDialog) {
					throw new Error(`No handler is configured for the user dialog '${String(request.dialog_kind)}'`);
				}
				const result = await onUserDialog({
					dialogKind: request.dialog_kind as string,
					payload: request.payload as Record<string, unknown>,
					toolUseID: request.tool_use_id as string | undefined,
				}, { signal, requestId });
				return result ? result as unknown as Record<string, unknown> : { behavior: 'cancelled' };
			}
			case 'mcp_message': {
				const server = this._sdkMcpServers.get(request.server_name as string);
				if (!server) {
					throw new Error(`Unknown in-process MCP server: ${String(request.server_name)}`);
				}
				const response = await server.handleMessage(request.message as IJsonRpcMessage, signal);
				// Notifications get an empty acknowledgement, requests their JSON-RPC response.
				return { mcp_response: response ?? { jsonrpc: '2.0', result: {}, id: 0 } };
			}
			default:
				throw new Error(`Control request of unknown kind: ${request.subtype}`);
		}
	}

	// #endregion

	// #region Query API

	async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
		const response = await this._request({ subtype: 'interrupt' });
		return Object.keys(response).length > 0 ? response as unknown as SDKControlInterruptResponse : undefined;
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> {
		await this._request({ subtype: 'set_permission_mode', mode });
	}

	async setMcpPermissionModeOverride(serverName: string, mode: 'default' | 'auto' | null): Promise<{ warning?: string }> {
		return await this._request({ subtype: 'set_mcp_permission_mode_override', serverName, mode });
	}

	async setModel(model?: string): Promise<void> {
		await this._request({ subtype: 'set_model', model });
	}

	async setMaxThinkingTokens(maxThinkingTokens: number | null, thinkingDisplay?: 'summarized' | 'omitted' | 'highlights' | null): Promise<void> {
		await this._request({ subtype: 'set_max_thinking_tokens', max_thinking_tokens: maxThinkingTokens, thinking_display: thinkingDisplay });
	}

	async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
		await this._request({ subtype: 'apply_flag_settings', settings });
	}

	async updateSettings(source: 'localSettings' | 'userSettings', settings: Record<string, unknown>): Promise<void> {
		await this._request({ subtype: 'update_settings', source, settings });
	}

	initializationResult(): Promise<SDKControlInitializeResponse> {
		return this._initialization;
	}

	async reinitialize(): Promise<SDKControlInitializeResponse> {
		return await this._request(this._buildInitializeRequest()) as unknown as SDKControlInitializeResponse;
	}

	async supportedCommands(): Promise<SlashCommand[]> {
		const { commands } = await this._initialization;
		return this._latestCommands ?? commands;
	}

	async supportedModels(): Promise<ModelInfo[]> {
		return (await this._initialization).models;
	}

	async supportedAgents(): Promise<AgentInfo[]> {
		return (await this._initialization).agents;
	}

	async accountInfo(): Promise<AccountInfo> {
		return (await this._initialization).account;
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		return (await this._request({ subtype: 'mcp_status' })).mcpServers as McpServerStatus[];
	}

	async getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<SDKControlGetContextUsageResponse> {
		return await this._request({ subtype: 'get_context_usage', ...opts }) as unknown as SDKControlGetContextUsageResponse;
	}

	async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<SDKControlGetUsageResponse> {
		return await this._request({ subtype: 'get_usage', ...(opts?.skipBehaviors ? { skip_behaviors: true } : {}) }) as unknown as SDKControlGetUsageResponse;
	}

	async readFile(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<SDKControlReadFileResponse | null> {
		try {
			return await this._request({ subtype: 'read_file', path, max_bytes: options?.maxBytes, encoding: options?.encoding }) as unknown as SDKControlReadFileResponse | null;
		} catch {
			return null;
		}
	}

	async reloadPlugins(options?: { holdOnCacheImpact?: boolean; addPlugins?: SdkPluginConfig[] }): Promise<SDKControlReloadPluginsResponse> {
		return await this._request({
			subtype: 'reload_plugins',
			...(options?.holdOnCacheImpact ? { hold_on_cache_impact: true } : {}),
			...(options?.addPlugins && options.addPlugins.length > 0 ? { add_plugins: options.addPlugins } : {}),
		}) as unknown as SDKControlReloadPluginsResponse;
	}

	async reloadSkills(): Promise<SDKControlReloadSkillsResponse> {
		return await this._request({ subtype: 'reload_skills' }) as unknown as SDKControlReloadSkillsResponse;
	}

	async reloadOutputStyles(): Promise<SDKControlReloadOutputStylesResponse> {
		return await this._request({ subtype: 'reload_output_styles' }) as unknown as SDKControlReloadOutputStylesResponse;
	}

	async rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult> {
		return await this._request({ subtype: 'rewind_files', user_message_id: userMessageId, dry_run: options?.dryRun }) as unknown as RewindFilesResult;
	}

	async seedReadState(path: string, mtime: number): Promise<void> {
		await this._request({ subtype: 'seed_read_state', path, mtime });
	}

	async reconnectMcpServer(serverName: string): Promise<void> {
		await this._request({ subtype: 'mcp_reconnect', serverName });
	}

	async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
		await this._request({ subtype: 'mcp_toggle', serverName, enabled });
	}

	async readMcpResource(serverName: string, uri: string): Promise<SDKControlMcpReadResourceResponse> {
		return await this._request({ subtype: 'mcp_read_resource', serverName, uri }) as unknown as SDKControlMcpReadResourceResponse;
	}

	async setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> {
		if (Object.values(servers).some(isSdkMcpServer)) {
			throw new Error('Replacing in-process MCP servers at runtime is not supported yet');
		}
		return await this._request({ subtype: 'mcp_set_servers', servers }) as unknown as McpSetServersResult;
	}

	async stopTask(taskId: string): Promise<void> {
		await this._request({ subtype: 'stop_task', task_id: taskId });
	}

	async backgroundTasks(toolUseId?: string): Promise<boolean> {
		const response = await this._request({ subtype: 'background_tasks', ...(toolUseId ? { tool_use_id: toolUseId } : {}) });
		return response.backgrounded === true;
	}

	// #endregion
}

/**
 * `WarmQuery` over a {@link ClaudeCliQuery} whose `initialize` handshake has
 * completed; {@link query} supplies the prompt to the ready process.
 */
export class ClaudeCliWarmQuery implements WarmQuery {

	constructor(private readonly _query: ClaudeCliQuery) { }

	query(prompt: string | AsyncIterable<SDKUserMessage>): Query {
		this._query.attachPrompt(prompt);
		return this._query;
	}

	close(): void {
		this._query.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this._query.close();
	}
}

/** Start the process and wait for its `initialize` answer. */
export async function startClaudeCliWarmQuery(options: Options, launcher: IClaudeCliProcessLauncher, logger: IClaudeCliLogger, plan: IClaudeCliLaunchPlan, initializeTimeoutMs: number = DefaultInitializeTimeoutMs, limits?: IClaudeCliLimits): Promise<WarmQuery> {
	const query = new ClaudeCliQuery(options, launcher, logger, plan, limits);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			query.initializationResult(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Claude Code did not answer initialize within ${initializeTimeoutMs} ms`)), initializeTimeoutMs);
			}),
		]);
	} catch (error) {
		query.close();
		throw error;
	} finally {
		clearTimeout(timer);
	}
	return new ClaudeCliWarmQuery(query);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

