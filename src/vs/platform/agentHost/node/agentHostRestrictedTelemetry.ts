/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as zlib from 'zlib';
import { promisify } from 'util';

export type TelemetryProps = Record<string, string | undefined>;
export type TelemetryMeasurements = Record<string, number | undefined>;

export interface IAgentHostInternalTelemetryContext {
	readonly isInternal: boolean;
	readonly trackingId: string | undefined;
	readonly userName: string | undefined;
	readonly isVscodeTeamMember: boolean;
}

export interface IAgentHostRestrictedTelemetryContext extends IAgentHostInternalTelemetryContext {
	readonly restrictedTelemetryEnabled: boolean;
	readonly telemetryEndpoint: string | undefined;
	/** Whether content exclusion is enabled; undefined when account discovery could not determine it. */
	readonly copilotIgnoreEnabled?: boolean;
}

/**
 * App Insights caps a single property value at ~8192 chars. Long values are chunked so the Copilot
 * Telemetry Service can reassemble them, mirroring the Copilot extension's `multiplexProperties` so
 * events look identical on the wire and downstream.
 *
 * When a value is too long it is gzip + base64 compressed and emitted under a compressed chunk
 * family, normally `<key>Chunk`, `<key>Chunk_2`, `<key>Chunk_3`, … (first column has no numeric
 * suffix, the rest are NOT zero-padded, each capped at {@link MAX_PROPERTY_LENGTH}), while the
 * original `<key>` column carries just the first uncompressed chunk of the value.
 * The `messagesJson` property is the schema exception: its compressed family is
 * `messagesJSONChunk`, `messagesJSONChunk_2`, `messagesJSONChunk_3`, …
 *
 * Fields in {@link ALWAYS_COMPRESSED_CHUNK_KEYS} always get the compressed chunk family even when
 * they fit within {@link MAX_PROPERTY_LENGTH}, so the backend can always read them from their
 * compressed chunk family without branching on size.
 */
const MAX_PROPERTY_LENGTH = 8192;
const MAX_CONCATENATED_PROPERTIES = 50;

// Suffix appended to the base property name for the compressed (gzip + base64) chunk family.
const COMPRESSED_CHUNK_SUFFIX = 'Chunk';

// Fields that are always emitted as a compressed chunk family, regardless of their length. These
// are known to frequently exceed the per-property limit, so always producing the compressed chunk
// family gives the backend a single, uniform place to read the value from.
const ALWAYS_COMPRESSED_CHUNK_KEYS = new Set<string>(['messagesJson', 'messageText', 'diffsJSON', 'prompt']);

const gzip = promisify(zlib.gzip);

// Compress off the main thread (libuv threadpool) so large telemetry values never block the agent
// host event loop.
async function compressTelemetryValue(value: string): Promise<string> {
	const compressed = await gzip(Buffer.from(value, 'utf8'));
	return compressed.toString('base64');
}

export async function multiplexProperties(properties: TelemetryProps): Promise<TelemetryProps> {
	const newProperties: TelemetryProps = { ...properties };
	for (const key in properties) {
		const value = properties[key];
		const valueLength = value?.length ?? 0;
		// Known-large fields are always emitted as a compressed chunk family so the backend can read
		// them uniformly, even when they happen to be short.
		const forceCompress = value !== undefined && ALWAYS_COMPRESSED_CHUNK_KEYS.has(key);
		if (valueLength <= MAX_PROPERTY_LENGTH && !forceCompress) {
			continue;
		}
		// Compressed chunking: keep the original column as just the first uncompressed chunk and emit
		// the full value gzip + base64 compressed under its schema chunk family (no zero padding).
		newProperties[key] = value!.slice(0, MAX_PROPERTY_LENGTH);
		const compressed = await compressTelemetryValue(value!);
		const compressedChunkKey = key === 'messagesJson' ? 'messagesJSON' : key;
		for (let offset = 0, index = 1; offset < compressed.length && index <= MAX_CONCATENATED_PROPERTIES; offset += MAX_PROPERTY_LENGTH, index++) {
			const columnName = index === 1 ? `${compressedChunkKey}${COMPRESSED_CHUNK_SUFFIX}` : `${compressedChunkKey}${COMPRESSED_CHUNK_SUFFIX}_${index}`;
			newProperties[columnName] = compressed.slice(offset, offset + MAX_PROPERTY_LENGTH);
		}
	}
	return newProperties;
}

/**
 * The restricted telemetry surface the agent host exposes, mirroring the Copilot extension's
 * `ITelemetryService` restricted methods so agent-host code can emit the same GH/MSFT events.
 */
export interface IAgentHostRestrictedTelemetry {
	/** GH standard (non-restricted) telemetry -> `copilot_v0_copilot_event`. */
	sendGHTelemetryEvent(eventName: string, properties?: TelemetryProps, measurements?: TelemetryMeasurements): void;
	/** GH enhanced/restricted telemetry (prompts, tools, etc.) -> `copilot_v0_restricted_copilot_event`. */
	sendEnhancedGHTelemetryEvent(eventName: string, properties?: TelemetryProps, measurements?: TelemetryMeasurements): void;
	/** GH enhanced telemetry attributed and routed using an immutable per-session context. */
	sendEnhancedGHTelemetryEventForContext(context: IAgentHostRestrictedTelemetryContext, eventName: string, properties?: TelemetryProps, measurements?: TelemetryMeasurements): void;
	/** MSFT-internal telemetry -> Aria/Collector++ (internal-only table). No-op without an internal key. */
	sendInternalMSFTTelemetryEvent(eventName: string, properties?: TelemetryProps, measurements?: TelemetryMeasurements): void;
	/** MSFT-internal telemetry attributed using an immutable per-session context. */
	sendInternalMSFTTelemetryEventForContext(context: IAgentHostInternalTelemetryContext, eventName: string, properties?: TelemetryProps, measurements?: TelemetryMeasurements): void;
	/** Sets the Copilot user tracking id (`copilot_trackingId`) carried on every subsequent event. */
	setCopilotTrackingId(trackingId: string | undefined): void;
	/** Adds or removes a property carried on every subsequent event, mirroring `ITelemetryService.setCommonProperty`. */
	setCommonProperty(name: string, value: string | boolean | undefined): void;
	/** Overrides the POST endpoint with the user's CAPI `endpoints.telemetry`; falsy restores the default. */
	setRestrictedTelemetryEndpoint(endpointUrl: string | undefined): void;
	/** Enables enhanced GH telemetry once the authenticated account opts in; off by default and on flip/logout. */
	setRestrictedTelemetryEnabled(enabled: boolean): void;
	/** Sets the internal-user identity and enables the internal sink only for staff accounts. */
	setInternalTelemetryContext(context: IAgentHostInternalTelemetryContext | undefined): void;
}
