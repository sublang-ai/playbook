import { type DevPlaybookHostCapabilities, type PlaybookRuntime } from './dev.playbook.js';
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export type DevOptions = Readonly<Record<string, never>>;
export interface DevPlaybookRegistryEntry {
    id: 'dev';
    command: 'dev';
    intent: string;
    artifactSchema: 3;
    runtimeProfile: {
        readonly kind: 'shared-factory';
        readonly compat: {
            readonly artifactSchema: 3;
            readonly runtimeAbi: number;
        };
    };
    requiredRoleIds: readonly ['analyst'];
    concurrentRoleSets: readonly [];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(optionSlice: unknown): DevOptions;
    createRuntime(options: DevOptions, hostCapabilities: DevPlaybookHostCapabilities): PlaybookRuntime;
}
export declare const devStateCountLabels: {
    readonly planAnalysis: "planning round";
};
export declare const devCopyPasteGuardNames: readonly ["code", "decideThenCode"];
export declare function devSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const devSummaryPolicy: PlaybookSummaryPolicy;
export declare function validateDevOptions(optionSlice: unknown): DevOptions;
export declare const devPlaybookRegistryEntry: DevPlaybookRegistryEntry;
export default devPlaybookRegistryEntry;
