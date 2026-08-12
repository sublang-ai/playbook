import { type PlaybookRuntime } from './review.playbook.js';
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export type ReviewOptions = Readonly<Record<string, never>>;
export interface ReviewPlaybookRegistryEntry {
    id: 'review';
    command: 'review';
    intent: string;
    artifactSchema: 2;
    requiredRoleIds: readonly ['coder', 'reviewer'];
    concurrentRoleSets: readonly [];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(optionSlice: unknown): ReviewOptions;
    createRuntime(options: ReviewOptions): PlaybookRuntime;
}
export declare const reviewStateCountLabels: {
    readonly reviewInitial: "review round";
    readonly reviewAfterCommit: "review round";
    readonly reviewAfterRebuttal: "rebuttal";
};
export declare const reviewCopyPasteGuardNames: readonly ["hasFindings", "committed", "rejectedAll"];
export declare function reviewSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const reviewSummaryPolicy: PlaybookSummaryPolicy;
export declare function validateReviewOptions(optionSlice: unknown): ReviewOptions;
export declare const reviewPlaybookRegistryEntry: ReviewPlaybookRegistryEntry;
export default reviewPlaybookRegistryEntry;
