/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';

/**
 * Name of the Claude Code executable looked up in `PATH` when
 * `Options.pathToClaudeCodeExecutable` is not set.
 */
export const ClaudeCliExecutable = 'claude';

/**
 * Environment variable that makes the CLI keep file checkpoints (documented in
 * the file checkpointing guide); only set when the options ask for them.
 */
const CheckpointingEnvVar = 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING';

/**
 * Everything needed to start the process. JSON that may carry secrets (MCP
 * server definitions, settings) is not put on the command line, where every
 * local user can read it from `/proc/<pid>/cmdline`; it is written to a private
 * temporary file and the path is passed instead. {@link dispose} removes it.
 */
export interface IClaudeCliLaunchPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Record<string, string>;
	readonly cwd: string | undefined;
	/** `Options` that were set but cannot be expressed with the CLI's documented flags. */
	readonly warnings: readonly string[];
	dispose(): Promise<void>;
}

/** Paths of the temporary files that stand in for inline JSON arguments. */
export interface IClaudeCliConfigFiles {
	readonly mcpConfig?: string;
	readonly settings?: string;
}

/** The JSON documents of an options bag that must travel through files. */
export interface IClaudeCliConfigPayloads {
	readonly mcpConfig?: string;
	/** Inline settings JSON; a settings value that is already a path is passed on untouched. */
	readonly settings?: string;
}

export function collectClaudeCliConfigPayloads(options: Options): IClaudeCliConfigPayloads {
	const servers = Object.fromEntries(Object.entries(options.mcpServers ?? {}).filter(([, config]) => !isSdkMcpServer(config)));
	let settings: string | undefined;
	if (typeof options.settings === 'object') {
		settings = JSON.stringify(options.settings);
	} else if (typeof options.settings === 'string' && options.settings.trimStart().startsWith('{')) {
		settings = options.settings;
	}
	return {
		mcpConfig: Object.keys(servers).length > 0 ? JSON.stringify({ mcpServers: servers }) : undefined,
		settings,
	};
}

/** Options the documented command line has no flag for; setting them has no effect. */
const UnsupportedOptions: readonly (readonly [keyof Options, string])[] = [
	['thinking', 'thinking configuration'],
	['maxThinkingTokens', 'thinking token budget'],
	['taskBudget', 'task budget'],
	['resumeSessionAt', 'resuming up to a message'],
	['resumeDropsTurn', 'dropping a turn on resume'],
	['projectConfigRoot', 'project config root'],
	['managedSettings', 'managed settings'],
	['sessionStore', 'external session store'],
];

export function findUnsupportedClaudeCliOptions(options: Options): string[] {
	const warnings: string[] = [];
	for (const [key, label] of UnsupportedOptions) {
		if (options[key] !== undefined) {
			warnings.push(`Ignoring Options.${key}: the claude command line has no flag for ${label}`);
		}
	}
	if (options.pluginDelivery === 'initialize') {
		warnings.push('Ignoring Options.pluginDelivery=initialize: plugins are passed with --plugin-dir instead');
	}
	if (options.plugins?.some(plugin => plugin.skipMcpDiscovery)) {
		warnings.push('Ignoring skipMcpDiscovery on plugins: MCP servers of plugins are still discovered');
	}
	return warnings;
}

/**
 * Translate {@link Options} into the argument vector of `claude`, grouped by
 * what the flags control. Only flags listed by `claude --help` or the CLI
 * reference are used; see {@link findUnsupportedClaudeCliOptions} for the
 * options that are dropped. Options the binary learns over the control channel
 * instead (system prompt, agents, hooks, ...) are in
 * {@link buildClaudeCliInitializeRequest}.
 */
export function buildClaudeCliArgs(options: Options, files: IClaudeCliConfigFiles = {}): string[] {
	const args: string[] = [];
	const value = (name: string, v: string | number) => args.push(`--${name}=${v}`);

	// Transport: non-interactive, JSON frames in both directions.
	args.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
	if (options.includePartialMessages) {
		args.push('--include-partial-messages');
	}
	if (options.includeHookEvents) {
		args.push('--include-hook-events');
	}

	// Which conversation to run.
	if (options.sessionId) {
		value('session-id', options.sessionId);
	}
	if (options.continue) {
		args.push('--continue');
	}
	if (options.resume) {
		value('resume', options.resume);
		if (options.forkSession) {
			args.push('--fork-session');
		}
	}
	if (options.persistSession === false) {
		args.push('--no-session-persistence');
	}

	// Model behaviour and limits.
	if (options.model) {
		value('model', options.model);
	}
	if (options.fallbackModel) {
		if (options.fallbackModel === options.model) {
			throw new Error('Options.fallbackModel must differ from Options.model');
		}
		value('fallback-model', options.fallbackModel);
	}
	if (options.effort) {
		value('effort', options.effort);
	}
	if (options.maxTurns) {
		value('max-turns', options.maxTurns);
	}
	if (options.maxBudgetUsd !== undefined) {
		value('max-budget-usd', options.maxBudgetUsd);
	}
	if (options.betas?.length) {
		value('betas', options.betas.join(','));
	}
	if (options.outputFormat?.type === 'json_schema') {
		value('json-schema', JSON.stringify(options.outputFormat.schema));
	}
	if (options.agent) {
		value('agent', options.agent);
	}

	// Permissions and tools.
	if (options.permissionMode) {
		// The CLI names the prompting mode "manual"; the SDK type calls it "default".
		value('permission-mode', options.permissionMode === 'default' ? 'manual' : options.permissionMode);
	}
	if (options.allowDangerouslySkipPermissions) {
		args.push('--allow-dangerously-skip-permissions');
	}
	if (options.canUseTool && options.permissionPromptToolName) {
		throw new Error('Options.canUseTool and Options.permissionPromptToolName are mutually exclusive');
	}
	if (options.canUseTool) {
		// Permission questions are sent to the host over the control channel.
		args.push('--permission-prompt-tool=stdio');
	} else if (options.permissionPromptToolName) {
		value('permission-prompt-tool', options.permissionPromptToolName);
	}
	if (options.permissionPrompts) {
		value('permission-prompts', options.permissionPrompts);
	}
	const skillRules = options.skills === undefined ? [] : options.skills === 'all' ? ['Skill'] : options.skills.map(name => `Skill(${name})`);
	const allowed = [...new Set([...(options.allowedTools ?? []), ...skillRules])];
	if (allowed.length > 0) {
		value('allowedTools', allowed.join(','));
	}
	if (options.disallowedTools?.length) {
		value('disallowedTools', options.disallowedTools.join(','));
	}
	if (options.tools !== undefined) {
		if (!Array.isArray(options.tools)) {
			args.push('--tools=default');
		} else if (options.tools.length === 0) {
			args.push('--tools', '');
		} else {
			value('tools', options.tools.join(','));
		}
	}

	// Workspace, settings, MCP servers and plugins.
	for (const directory of options.additionalDirectories ?? []) {
		value('add-dir', directory);
	}
	if (options.settingSources !== undefined) {
		value('setting-sources', options.settingSources.join(','));
	}
	const settingsArg = files.settings ?? (typeof options.settings === 'string' && !options.settings.trimStart().startsWith('{') ? options.settings : undefined);
	if (settingsArg) {
		value('settings', settingsArg);
	}
	if (files.mcpConfig) {
		value('mcp-config', files.mcpConfig);
	}
	if (options.strictMcpConfig) {
		args.push('--strict-mcp-config');
	}
	for (const plugin of options.plugins ?? []) {
		value('plugin-dir', plugin.path);
	}
	if (options.debugFile) {
		value('debug-file', options.debugFile);
	} else if (options.debug) {
		args.push('--debug');
	}

	// Caller-supplied raw flags, validated so they cannot smuggle in another flag.
	for (const [name, extra] of Object.entries(options.extraArgs ?? {})) {
		if (name.startsWith('-') || name.includes('=') || name === '') {
			throw new Error(`Options.extraArgs contains an invalid flag name: ${JSON.stringify(name)}`);
		}
		if (name === 'settings') {
			continue; // Settings are handled above so that inline JSON never reaches the command line.
		}
		args.push(extra === null ? `--${name}` : `--${name}=${extra}`);
	}
	return args;
}

/**
 * Environment of the `claude` subprocess. `Options.env`, when given, replaces
 * the inherited environment. Variables that only make sense for an
 * Electron-hosted child (`VSCODE_*`, `ELECTRON_*`, `NODE_OPTIONS`) are dropped
 * because the child is a native binary, and so are entries set to `undefined`.
 */
export function buildClaudeCliEnv(options: Options, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(options.env ?? inherited)) {
		const hostOnly = key === 'NODE_OPTIONS' || key.startsWith('VSCODE_') || key.startsWith('ELECTRON_');
		if (entry !== undefined && !hostOnly) {
			env[key] = entry;
		}
	}
	if (options.enableFileCheckpointing) {
		env[CheckpointingEnvVar] = 'true';
	}
	return env;
}

/** The `sdk`-type MCP server configs (the ones that carry a live instance). */
export function isSdkMcpServer(config: unknown): config is { type: 'sdk'; name: string; instance: unknown } {
	return typeof config === 'object' && config !== null && (config as { type?: unknown }).type === 'sdk';
}

/**
 * Resolve everything the process needs: validate the working directory, write
 * the private config files and assemble arguments and environment.
 */
export async function prepareClaudeCliLaunch(options: Options): Promise<IClaudeCliLaunchPlan> {
	if (options.cwd !== undefined) {
		const info = await stat(options.cwd).catch(() => undefined);
		if (!info?.isDirectory()) {
			throw new Error(`The working directory for Claude Code does not exist: ${options.cwd}`);
		}
	}

	const payloads = collectClaudeCliConfigPayloads(options);
	let directory: string | undefined;
	const files: { mcpConfig?: string; settings?: string } = {};
	if (payloads.mcpConfig !== undefined || payloads.settings !== undefined) {
		directory = await mkdtemp(join(tmpdir(), 'dk-claude-'));
		try {
			if (payloads.mcpConfig !== undefined) {
				files.mcpConfig = join(directory, 'mcp.json');
				await writeFile(files.mcpConfig, payloads.mcpConfig, { mode: 0o600 });
			}
			if (payloads.settings !== undefined) {
				files.settings = join(directory, 'settings.json');
				await writeFile(files.settings, payloads.settings, { mode: 0o600 });
			}
		} catch (error) {
			await rm(directory, { recursive: true, force: true }).catch(() => { });
			throw error;
		}
	}

	return {
		command: options.pathToClaudeCodeExecutable ?? ClaudeCliExecutable,
		args: buildClaudeCliArgs(options, files),
		env: buildClaudeCliEnv(options),
		cwd: options.cwd,
		warnings: findUnsupportedClaudeCliOptions(options),
		dispose: async () => {
			if (directory) {
				await rm(directory, { recursive: true, force: true }).catch(() => { });
			}
		},
	};
}

/**
 * Body of the `initialize` control request: what the binary learns from the
 * host over the control channel instead of from its command line.
 */
export function buildClaudeCliInitializeRequest(options: Options, hooks: Record<string, unknown[]> | undefined, sdkMcpServerNames: readonly string[]): Record<string, unknown> {
	const prompt = options.systemPrompt;
	let replacement: string[] | undefined;
	let append: string | undefined;
	let excludeDynamic: boolean | undefined;
	let snapshot: boolean | undefined;
	if (prompt === undefined) {
		// No system prompt configured means an empty one, not the default.
		replacement = [''];
	} else if (typeof prompt === 'string') {
		replacement = [prompt];
	} else if (Array.isArray(prompt)) {
		replacement = prompt;
	} else if (prompt.type === 'custom') {
		replacement = typeof prompt.prompt === 'string' ? [prompt.prompt] : prompt.prompt;
		snapshot = prompt.snapshot;
	} else {
		append = prompt.append;
		excludeDynamic = prompt.excludeDynamicSections;
		snapshot = prompt.snapshot;
	}

	const request: Record<string, unknown> = {
		subtype: 'initialize',
		hooks,
		sdkMcpServers: sdkMcpServerNames.length > 0 ? [...sdkMcpServerNames] : undefined,
		systemPrompt: replacement,
		appendSystemPrompt: append,
		excludeDynamicSections: excludeDynamic,
		systemPromptSnapshot: snapshot,
		planModeInstructions: options.planModeInstructions,
		toolAliases: options.toolAliases,
		agents: options.agents,
		title: options.title,
		skills: Array.isArray(options.skills) ? options.skills : undefined,
		promptSuggestions: options.promptSuggestions,
		agentProgressSummaries: options.agentProgressSummaries,
		forwardSubagentText: options.forwardSubagentText,
		supportedDialogKinds: options.supportedDialogKinds,
		perTaskStopAffordance: options.perTaskStopAffordance,
	};
	return request;
}
