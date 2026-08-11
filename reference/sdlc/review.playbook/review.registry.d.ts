import { type PlaybookRuntime, type ReviewPlaybookOptions } from './review.playbook.js';
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export interface RegistryPlayer {
    id: string;
    adapter?: string;
    model?: string;
}
export interface CreateReviewRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export type ReviewOptions = Readonly<Record<string, never>>;
export interface ReviewPlaybookRegistryEntry {
    id: 'review';
    command: 'review';
    intent: string;
    requiredRoleIds: readonly ['coder', 'reviewer'];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(captainOptions: unknown): ReviewOptions;
    createRuntime(options: CreateReviewRuntimeOptions): PlaybookRuntime;
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
export declare function createReviewRuntimeOptions({ captainOptions, players, }: CreateReviewRuntimeOptions): ReviewPlaybookOptions;
export declare const reviewPlaybookRegistryEntry: ReviewPlaybookRegistryEntry;
export default reviewPlaybookRegistryEntry;
