import { type DecidePlaybookHostCapabilities, type PlaybookRuntime } from './decide.playbook.js';
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export type DecideOptions = Readonly<Record<string, never>>;
export interface DecidePlaybookRegistryEntry {
    id: 'decide';
    command: 'decide';
    intent: string;
    artifactSchema: 3;
    runtimeProfile: {
        readonly kind: 'bespoke';
        readonly artifactSchema: 3;
    };
    requiredRoleIds: readonly ['coder', 'reviewer'];
    concurrentRoleSets: readonly [readonly ['coder', 'reviewer']];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(optionSlice: unknown): DecideOptions;
    createRuntime(options: DecideOptions, hostCapabilities: DecidePlaybookHostCapabilities): PlaybookRuntime;
}
export declare const decideStateCountLabels: {
    readonly independentProposals: "proposal round";
};
export declare const decideCopyPasteGuardNames: readonly ["proposed"];
export declare function decideSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const decideSummaryPolicy: PlaybookSummaryPolicy;
export declare function validateDecideOptions(optionSlice: unknown): DecideOptions;
export declare const decidePlaybookRegistryEntry: DecidePlaybookRegistryEntry;
export default decidePlaybookRegistryEntry;
