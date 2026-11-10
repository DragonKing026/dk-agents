/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { basename, dirname, isAbsolute, join, normalize, resolve } from '../../../../base/common/path.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../files/common/files.js';
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

/** Where a tool's `file_path` points, and whether that is inside the session's working directories. */
export interface IResolvedClaudeEditorPath {
	/** Absolute, normalized path the tool reads and writes. */
	readonly path: string;
	/** Whether the file lies inside one of the working directories. Only such files are snapshotted for review. */
	readonly inWorkspace: boolean;
}

/**
 * Resolves a tool's `file_path` lexically: relative paths are taken against
 * the first working directory, and `.` and `..` segments are folded, so a
 * path cannot step out of (or into) a working directory by spelling. Symbolic
 * links are not followed; see {@link resolveClaudeEditorPathOnDisk}.
 */
export function resolveClaudeEditorPath(filePath: string, workingDirectories: readonly URI[]): IResolvedClaudeEditorPath {
	const path = isAbsolute(filePath)
		? resolve(filePath)
		: workingDirectories.length ? resolve(workingDirectories[0].fsPath, filePath) : normalize(filePath);
	return { path, inWorkspace: isInsideAny(path, workingDirectories) };
}

/**
 * Like {@link resolveClaudeEditorPath}, but judged by where the file really
 * is: symbolic links are followed (of the file, or of its closest existing
 * ancestor when the file does not exist yet), so a link from outside the
 * working directories to a file inside them counts as inside, and a link
 * inside them to a file outside counts as outside. Working directories that
 * are links themselves are compared by their real path too, since the CLI
 * reports files by the real path of its working directory. The snapshot is
 * taken of the real file. When the real path cannot be determined, the
 * lexical resolution stands.
 */
export async function resolveClaudeEditorPathOnDisk(filePath: string, workingDirectories: readonly URI[], fileService: IFileService): Promise<IResolvedClaudeEditorPath> {
	const lexical = resolveClaudeEditorPath(filePath, workingDirectories);
	if (!isAbsolute(lexical.path)) {
		return lexical;
	}
	const real = await realpathOfClosestExisting(lexical.path, fileService);
	if (real === undefined) {
		return lexical;
	}
	const realDirectories = await Promise.all(workingDirectories.map(directory => fileService.realpath(directory).then(uri => uri ?? directory, () => directory)));
	return { path: real, inWorkspace: isInsideAny(real, workingDirectories) || isInsideAny(real, realDirectories) };
}

function isInsideAny(path: string, directories: readonly URI[]): boolean {
	const resource = URI.file(path);
	return directories.some(directory => extUriBiasedIgnorePathCase.isEqualOrParent(resource, directory));
}

/** Real path of `path`, or of its closest existing ancestor with the remaining segments appended; `undefined` when none resolves. */
async function realpathOfClosestExisting(path: string, fileService: IFileService): Promise<string | undefined> {
	let current = path;
	const tail: string[] = [];
	for (; ;) {
		try {
			const real = await fileService.realpath(URI.file(current));
			if (real) {
				return tail.length ? join(real.fsPath, ...tail.reverse()) : real.fsPath;
			}
		} catch {
			// Not resolvable at this level: try the parent.
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		tail.push(basename(current));
		current = parent;
	}
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

/** `text` with every line break as CRLF. */
function toCrlf(text: string): string {
	return text.replace(/\r?\n/g, '\r\n');
}

/**
 * Build the per-session in-process MCP server that serves `Edit` and `Write`.
 *
 * `resolveTarget` turns a tool's `file_path` into the path to write and
 * whether it is inside the session's working directories (see
 * {@link resolveClaudeEditorPathOnDisk}). A write inside them is bracketed by
 * the snapshotter (`beforeEdit` before the bytes hit the disk, `afterEdit` once
 * they are there) so the review and checkpoints see exactly that change. A
 * write outside them, such as a plan file under the user's home, is written
 * without a snapshot. A failure (missing file, ambiguous match, file changed
 * since it was read, I/O error) degrades to an `isError` result rather than
 * rejecting; a snapshot left open by a failed write is released when the
 * tool's result reaches the file-edit observer.
 *
 * `Edit` writes with the etag and mtime of the content it read, so a file the
 * user or another tool changed in between (as far as the file service tells a
 * change: a later mtime with a different size) is not blindly overwritten.
 * When the file
 * uses CRLF line endings and `old_string` is not found as given, the match is
 * retried with CRLF line endings in both `old_string` and `new_string`.
 */
export async function buildEditorToolMcpServer(
	sdk: IClaudeAgentSdkService,
	fileService: IFileService,
	logService: ILogService,
	resolveTarget: (filePath: string) => Promise<IResolvedClaudeEditorPath>,
	snapshotter: IClaudeEditSnapshotter,
): Promise<McpSdkServerConfigWithInstance> {

	/** `expected` is the etag and mtime of the content the tool read; a file that changed since is not overwritten. */
	const writeTracked = async (target: IResolvedClaudeEditorPath, toolInput: unknown, content: string, expected?: { readonly etag: string; readonly mtime: number }): Promise<void> => {
		if (target.inWorkspace) {
			try {
				await snapshotter.beforeEdit(target.path, toolInput);
			} catch (error) {
				logService.warn(`[ClaudeEditorTools] Snapshot before editing ${target.path} failed: ${error}`);
			}
		}
		try {
			await fileService.writeFile(URI.file(target.path), VSBuffer.fromString(content), expected);
		} catch (error) {
			if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE) {
				throw new Error(`${target.path} changed since it was read. Read it again and retry the edit.`);
			}
			throw error;
		}
		if (target.inWorkspace) {
			try {
				await snapshotter.afterEdit(target.path, toolInput);
			} catch (error) {
				logService.warn(`[ClaudeEditorTools] Snapshot after editing ${target.path} failed: ${error}`);
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
			const target = await resolveTarget(filePath);
			if (!isAbsolute(target.path)) {
				return errorResult(`file_path must be absolute: ${filePath}`);
			}
			let content;
			try {
				content = await fileService.readFile(URI.file(target.path));
			} catch {
				return errorResult(`File not found or not readable: ${target.path}`);
			}
			const original = content.value.toString();
			let needle = oldString;
			let replacement = newString;
			let occurrences = countOccurrences(original, needle);
			if (occurrences === 0 && original.includes('\r\n') && !needle.includes('\r')) {
				needle = toCrlf(oldString);
				replacement = toCrlf(newString);
				occurrences = countOccurrences(original, needle);
			}
			if (occurrences === 0) {
				return errorResult(`old_string was not found in ${target.path}.`);
			}
			if (occurrences > 1 && !replaceAll) {
				return errorResult(`old_string occurs ${occurrences} times in ${target.path}. Add surrounding context to make it unique, or set replace_all to replace every occurrence.`);
			}
			const updated = original.split(needle).join(replacement);
			await writeTracked(target, args, updated, { etag: content.etag, mtime: content.mtime });
			return textResult(occurrences > 1
				? `Replaced ${occurrences} occurrences in ${target.path}.`
				: `Edited ${target.path}.`);
		},
		Write: async args => {
			const { file_path: filePath, content } = args as { file_path: string; content: string };
			const target = await resolveTarget(filePath);
			if (!isAbsolute(target.path)) {
				return errorResult(`file_path must be absolute: ${filePath}`);
			}
			const existed = await fileService.exists(URI.file(target.path));
			// The parent directory is created before the snapshot, so a failed
			// write of a new file leaves an empty directory behind at worst.
			await fileService.createFolder(URI.file(dirname(target.path)));
			await writeTracked(target, args, content);
			return textResult(existed ? `Updated ${target.path}.` : `Created ${target.path}.`);
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
