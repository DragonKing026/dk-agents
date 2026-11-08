/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as zlib from 'zlib';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { multiplexProperties } from '../../node/agentHostRestrictedTelemetry.js';

suite('AgentHost restricted telemetry chunking', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const key of ['messageText', 'prompt']) {
		for (const length of [0, 100, 8192, 8193, 20000]) {
			test(`always compresses ${key} of length ${length}`, async () => {
				const value = 'x'.repeat(length);
				const properties = await multiplexProperties({ [key]: value });
				assert.deepStrictEqual(properties, {
					[key]: value.slice(0, 8192),
					[`${key}Chunk`]: zlib.gzipSync(Buffer.from(value, 'utf8')).toString('base64'),
				});
			});
		}
	}

	test('preserves Unicode across the raw prefix boundary', async () => {
		const messageText = 'x'.repeat(8191) + '\u{1F600}\u4F60\u597D';
		const properties = await multiplexProperties({ messageText });
		assert.deepStrictEqual({
			prefix: properties.messageText,
			reconstructed: zlib.gunzipSync(Buffer.from(properties.messageTextChunk!, 'base64')).toString('utf8'),
		}, {
			prefix: messageText.slice(0, 8192),
			reconstructed: messageText,
		});
	});
});
