/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AnyZodRawShape, InferShape, McpSdkServerConfigWithInstance, SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Minimal in-process MCP server for the `claude` binary.
 *
 * The binary asks the host to serve `sdk`-type MCP servers over the control
 * channel (`mcp_message` requests carrying JSON-RPC). `@modelcontextprotocol/sdk`
 * is only a transitive dependency of the Claude Agent SDK and is therefore not
 * shipped with the product, so the three methods a tool server needs
 * (`initialize`, `tools/list`, `tools/call`) are handled here directly.
 */

const DefaultProtocolVersion = '2025-06-18';

/** JSON-RPC message as exchanged inside `mcp_message` control requests. */
export interface IJsonRpcMessage {
	readonly jsonrpc: '2.0';
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

export type JsonRpcResponse = {
	readonly jsonrpc: '2.0';
	readonly id: string | number;
	readonly result: unknown;
} | {
	readonly jsonrpc: '2.0';
	readonly id: string | number;
	readonly error: { readonly code: number; readonly message: string };
};

const InvalidParams = -32602;
const MethodNotFound = -32601;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = SdkMcpToolDefinition<any>;

/**
 * The object stored in `McpSdkServerConfigWithInstance.instance`. It is not an
 * `McpServer`; the cast lives in {@link createClaudeCliMcpServer} and nothing
 * outside this module hands the instance to code that expects the real class.
 */
export class ClaudeCliMcpServer {

	private readonly _tools = new Map<string, AnyTool>();

	constructor(
		readonly name: string,
		private readonly _version: string,
		tools: readonly AnyTool[],
	) {
		for (const definition of tools) {
			this._tools.set(definition.name, definition);
		}
	}

	/**
	 * Handle one JSON-RPC message. Notifications (no `id`) and responses
	 * produce no JSON-RPC reply and return `undefined`.
	 */
	async handleMessage(message: IJsonRpcMessage, signal: AbortSignal): Promise<JsonRpcResponse | undefined> {
		if (message.id === undefined || message.method === undefined) {
			return undefined;
		}
		const id = message.id;
		try {
			switch (message.method) {
				case 'initialize': {
					const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
					return {
						jsonrpc: '2.0', id, result: {
							protocolVersion: typeof requested === 'string' ? requested : DefaultProtocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: this.name, version: this._version },
						}
					};
				}
				case 'ping':
					return { jsonrpc: '2.0', id, result: {} };
				case 'tools/list':
					return { jsonrpc: '2.0', id, result: { tools: [...this._tools.values()].map(definition => describeTool(definition)) } };
				case 'tools/call':
					return await this._callTool(id, message.params, signal);
				default:
					return { jsonrpc: '2.0', id, error: { code: MethodNotFound, message: `Method not found: ${message.method}` } };
			}
		} catch (error) {
			return { jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
		}
	}

	private async _callTool(id: string | number, params: unknown, signal: AbortSignal): Promise<JsonRpcResponse> {
		const { name, arguments: rawArguments, _meta } = (params ?? {}) as { name?: unknown; arguments?: unknown; _meta?: unknown };
		const definition = typeof name === 'string' ? this._tools.get(name) : undefined;
		if (!definition) {
			return { jsonrpc: '2.0', id, error: { code: InvalidParams, message: `Unknown tool: ${String(name)}` } };
		}
		const parsed = await z.object(definition.inputSchema as z.ZodRawShape).safeParseAsync(rawArguments ?? {});
		if (!parsed.success) {
			const result: CallToolResult = { content: [{ type: 'text', text: `Invalid arguments for tool ${definition.name}: ${parsed.error.message}` }], isError: true };
			return { jsonrpc: '2.0', id, result };
		}
		try {
			// The request's `_meta` reaches the handler as `extra._meta`, like the
			// MCP SDK does: the CLI puts the originating `tool_use_id` there
			// (`claudecode/toolUseId`), which the client tools need to pair the
			// call with the workbench's completion.
			const extra = { signal, requestId: id, ...(_meta && typeof _meta === 'object' ? { _meta } : {}) };
			const result = await definition.handler(parsed.data, extra);
			return { jsonrpc: '2.0', id, result };
		} catch (error) {
			const result: CallToolResult = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
			return { jsonrpc: '2.0', id, result };
		}
	}
}

function describeTool(definition: AnyTool): Record<string, unknown> {
	return {
		name: definition.name,
		description: definition.description,
		inputSchema: toJsonSchema(definition.inputSchema),
		...(definition.annotations ? { annotations: definition.annotations } : {}),
		...(definition._meta ? { _meta: definition._meta } : {}),
	};
}

function toJsonSchema(shape: AnyZodRawShape): Record<string, unknown> {
	try {
		const { $schema: _ignored, ...schema } = z.toJSONSchema(z.object(shape as z.ZodRawShape)) as Record<string, unknown>;
		return schema;
	} catch {
		// A shape the converter cannot express: advertise a permissive object
		// rather than failing the whole listing.
		return { type: 'object', additionalProperties: true };
	}
}

export function createClaudeCliTool<Schema extends AnyZodRawShape>(
	name: string,
	description: string,
	inputSchema: Schema,
	handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
	options?: Parameters<typeof tool>[4],
): SdkMcpToolDefinition<Schema> {
	const meta: Record<string, unknown> = {};
	if (options?.searchHint) {
		meta['anthropic/searchHint'] = options.searchHint;
	}
	if (options?.alwaysLoad) {
		meta['anthropic/alwaysLoad'] = true;
	}
	return {
		name,
		description,
		inputSchema,
		handler,
		annotations: options?.annotations,
		_meta: Object.keys(meta).length > 0 ? meta : undefined,
	};
}

export function createClaudeCliMcpServer(options: {
	name: string;
	version?: string;
	tools?: AnyTool[];
}): McpSdkServerConfigWithInstance {
	const instance = new ClaudeCliMcpServer(options.name, options.version ?? '1.0.0', options.tools ?? []);
	const config = { type: 'sdk', name: options.name, instance };
	return config as unknown as McpSdkServerConfigWithInstance;
}
