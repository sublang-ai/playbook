import { type PrPlaybookHostCapabilities, type PlaybookRuntime } from './pr.playbook.js';
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export type PrOptions = Readonly<Record<string, never>>;
export interface PrPlaybookRegistryEntry {
    id: 'pr';
    command: 'pr';
    intent: string;
    artifactSchema: 3;
    runtimeProfile: {
        readonly kind: 'shared-factory';
        readonly compat: {
            readonly artifactSchema: 3;
            readonly runtimeAbi: number;
        };
    };
    requiredRoleIds: readonly ['coder'];
    concurrentRoleSets: readonly [];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(optionSlice: unknown): PrOptions;
    createRuntime(options: PrOptions, hostCapabilities: PrPlaybookHostCapabilities): PlaybookRuntime;
}
export declare const prStateCountLabels: {
    readonly openPullRequest: "publication round";
};
export declare const prCopyPasteGuardNames: readonly ["opened"];
export declare function prSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const prSummaryPolicy: PlaybookSummaryPolicy;
export declare function validatePrOptions(optionSlice: unknown): PrOptions;
export declare const prPlaybookRegistryEntry: PrPlaybookRegistryEntry;
export default prPlaybookRegistryEntry;
