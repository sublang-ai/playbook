import { type PlaybookRuntimeOptions, type PlaybookHostCapabilities, type PlaybookRuntime } from './inspect.playbook.js';
import type { PlaybookHostConstructionCapabilities } from '../code.playbook/playbook-captain.js';
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export type InspectOptions = PlaybookRuntimeOptions;
export interface InspectPlaybookRegistryEntry {
    id: 'inspect';
    command: 'inspect';
    intent: string;
    artifactSchema: 3;
    runtimeProfile: {
        readonly kind: 'shared-factory';
        readonly compat: {
            readonly artifactSchema: 3;
            readonly runtimeAbi: number;
        };
    };
    requiredRoleIds: readonly ['inspector'];
    concurrentRoleSets: readonly [];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(optionSlice: unknown): InspectOptions;
    createRuntime(options: InspectOptions, hostCapabilities: PlaybookHostConstructionCapabilities & PlaybookHostCapabilities): PlaybookRuntime;
}
export declare const inspectStateCountLabels: {
    readonly inspecting: "inspection round";
};
export declare const inspectCopyPasteGuardNames: readonly ["completed"];
export declare function inspectSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const inspectSummaryPolicy: PlaybookSummaryPolicy;
export declare function validateInspectOptions(optionSlice: unknown): InspectOptions;
export declare const inspectPlaybookRegistryEntry: InspectPlaybookRegistryEntry;
export default inspectPlaybookRegistryEntry;
