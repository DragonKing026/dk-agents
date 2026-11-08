/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { resolveTreatmentWithAssignment, WorkbenchAssignmentService } from '../../common/assignmentService.js';

suite('resolveTreatmentWithAssignment', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the override without waiting for the assignment', async () => {
		const result = await resolveTreatmentWithAssignment('override', () => new Promise<string | undefined>(() => { /* never resolves */ }));
		assert.strictEqual(result.value, 'override');
	});

	test('reports whether an assignment exists', async () => {
		const withAssignment = await resolveTreatmentWithAssignment(undefined, async () => 'assigned');
		assert.strictEqual(withAssignment.value, 'assigned');
		assert.strictEqual(await withAssignment.hasAssignment, true);

		const without = await resolveTreatmentWithAssignment(undefined, async () => undefined);
		assert.strictEqual(without.value, undefined);
		assert.strictEqual(await without.hasAssignment, false);
	});
});

suite('WorkbenchAssignmentService (offline)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(overrides: Record<string, unknown> = {}): WorkbenchAssignmentService {
		const configurationService = new TestConfigurationService();
		for (const [key, value] of Object.entries(overrides)) {
			configurationService.setUserConfiguration(key, value);
		}
		return disposables.add(new WorkbenchAssignmentService(configurationService));
	}

	test('returns no treatment and no experiments without overrides', async () => {
		const service = createService();
		assert.strictEqual(await service.getTreatment('some.treatment'), undefined);
		assert.strictEqual(await service.getCurrentExperiments(), undefined);

		const result = await service.getTreatmentWithAssignment('some.treatment');
		assert.strictEqual(result.value, undefined);
		assert.strictEqual(await result.hasAssignment, false);
	});

	test('honours experiments.override settings', async () => {
		const service = createService({ 'experiments.override.some.treatment': true });
		assert.strictEqual(await service.getTreatment<boolean>('some.treatment'), true);

		const result = await service.getTreatmentWithAssignment<boolean>('some.treatment');
		assert.strictEqual(result.value, true);
		assert.strictEqual(await result.hasAssignment, false);
	});
});
