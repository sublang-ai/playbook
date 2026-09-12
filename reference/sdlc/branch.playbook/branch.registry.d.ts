import { type BranchPlaybookHostCapabilities, type PlaybookRuntime } from './branch.playbook.js';
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export type BranchOptions = Readonly<Record<string, never>>;
export interface BranchPlaybookRegistryEntry {
    id: 'branch';
    command: 'branch';
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
    validateOptions(optionSlice: unknown): BranchOptions;
    createRuntime(options: BranchOptions, hostCapabilities: BranchPlaybookHostCapabilities): PlaybookRuntime;
}
export declare const branchStateCountLabels: {
    readonly createBranch: "branching round";
};
export declare const branchCopyPasteGuardNames: readonly ["branched"];
export declare function branchSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const branchSummaryPolicy: PlaybookSummaryPolicy;
export declare function validateBranchOptions(optionSlice: unknown): BranchOptions;
export declare const branchPlaybookRegistryEntry: BranchPlaybookRegistryEntry;
export default branchPlaybookRegistryEntry;
