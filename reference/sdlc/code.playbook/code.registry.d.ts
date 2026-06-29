import { type CodePlaybookOptions, type PlaybookRuntime } from './code.playbook.js';
export declare const codeCopyPasteGuardNames: readonly ["accepted", "approved", "challengeAccepted", "challengeRejected", "challengesRaised", "changesMadeCode", "changesMadeCodeAndChallenged", "changesMadeMixed", "changesMadeMixedAndChallenged", "changesMadeSpecs", "changesMadeSpecsAndChallenged", "hasFindings", "needsRevision", "noFindings", "noOpenItems"];
export declare const codeStateCountLabels: {
    readonly adjudicateChallenges: "rebuttal";
    readonly reviewBossCommitSpecs: "review round";
    readonly reviewBossCommitCode: "review round";
    readonly reviewBossCommitMixed: "review round";
    readonly reviewIrTaskCommitSpecs: "review round";
    readonly reviewIrTaskCommitCode: "review round";
    readonly reviewIrTaskCommitMixed: "review round";
    readonly reviewChangesSpecs: "review round";
    readonly reviewChangesCode: "review round";
    readonly reviewChangesMixed: "review round";
    readonly reviewChangesAndChallengesSpecs: "review round";
    readonly reviewChangesAndChallengesCode: "review round";
    readonly reviewChangesAndChallengesMixed: "review round";
};
export declare function codeSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export declare const codeSummaryPolicy: PlaybookSummaryPolicy;
export interface CodeOptions {
    committer?: 'coder' | 'reviewer';
}
export interface RegistryPlayer {
    id: string;
    adapter?: string;
    model?: string;
}
export interface CreateCodeRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export interface CodePlaybookRegistryEntry {
    id: 'code';
    command: 'code';
    intent: string;
    requiredRoleIds: readonly string[];
    idleStateId: 'ready';
    finalStateId: 'done';
    parkStateIds: readonly string[];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(captainOptions: unknown): CodeOptions;
    createRuntime(options: CreateCodeRuntimeOptions): PlaybookRuntime;
}
export declare function validateCodeOptions(captainOptions: unknown): CodeOptions;
export declare function createCodeRuntimeOptions({ captainOptions, players, }: CreateCodeRuntimeOptions): CodePlaybookOptions;
export declare const codePlaybookRegistryEntry: CodePlaybookRegistryEntry;
export default codePlaybookRegistryEntry;
