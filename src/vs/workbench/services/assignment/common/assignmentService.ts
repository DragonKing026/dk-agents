/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IAssignmentService } from '../../../../platform/assignment/common/assignment.js';

export interface IAssignmentFilter {
	/**
	 * Stable identifier for this filter. Used to persist and reconcile the set of
	 * assignment-context ids this filter has excluded, independently of other filters.
	 */
	readonly id: string;
	exclude(assignment: string): boolean;
	onDidChange: Event<void>;
}

export const IWorkbenchAssignmentService = createDecorator<IWorkbenchAssignmentService>('assignmentService');

export interface IWorkbenchAssignmentService extends IAssignmentService {
	getCurrentExperiments(): Promise<string[] | undefined>;
	addTelemetryAssignmentFilter(filter: IAssignmentFilter): void;
	/** Resolves the effective value without delaying developer overrides. */
	getTreatmentWithAssignment<T extends string | number | boolean>(name: string): Promise<ITreatmentWithAssignment<T>>;
}

export interface ITreatmentWithAssignment<T extends string | number | boolean> {
	readonly value: T | undefined;
	/** May remain pending after a developer override resolves; rejects on failure or cancellation, never conflating these with absence. */
	readonly hasAssignment: Promise<boolean>;
}

export async function resolveTreatmentWithAssignment<T extends string | number | boolean>(override: T | undefined, readAssignment: () => Promise<T | undefined>): Promise<ITreatmentWithAssignment<T>> {
	if (override !== undefined) {
		return { value: override, hasAssignment: readAssignment().then(value => value !== undefined) };
	}
	const value = await readAssignment();
	return { value, hasAssignment: Promise.resolve(value !== undefined) };
}

/**
 * Offline assignment service. There is no experimentation backend: treatments are
 * never fetched, so the only source of values is the local `experiments.override.*`
 * settings. Everything else resolves to `undefined`, i.e. the feature's default.
 */
export class WorkbenchAssignmentService extends Disposable implements IWorkbenchAssignmentService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidRefetchAssignments = this._register(new Emitter<void>());
	readonly onDidRefetchAssignments = this._onDidRefetchAssignments.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('experiments.override')) {
				this._onDidRefetchAssignments.fire();
			}
		}));
	}

	async getTreatment<T extends string | number | boolean>(name: string): Promise<T | undefined> {
		return this.getOverride<T>(name);
	}

	async getTreatmentWithAssignment<T extends string | number | boolean>(name: string): Promise<ITreatmentWithAssignment<T>> {
		return resolveTreatmentWithAssignment(this.getOverride<T>(name), async () => undefined);
	}

	async getCurrentExperiments(): Promise<string[] | undefined> {
		return undefined;
	}

	addTelemetryAssignmentFilter(_filter: IAssignmentFilter): void {
		// No assignment context is ever produced, so there is nothing to filter.
	}

	private getOverride<T extends string | number | boolean>(name: string): T | undefined {
		return this.configurationService.getValue<T>(`experiments.override.${name}`);
	}
}

registerSingleton(IWorkbenchAssignmentService, WorkbenchAssignmentService, InstantiationType.Delayed);
