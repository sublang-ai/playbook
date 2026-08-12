import { type PlaybookRuntime } from './code.playbook.js';
export interface PlaybookSummaryPolicy {
    stateCountLabels: Readonly<Record<string, string>>;
    copyPasteGuardNames: readonly string[];
    savedCountsLine(counts: {
        interruptions: number;
        copyPastes: number;
    }, rounds: number): string;
}
export type CodeOptions = Readonly<Record<string, never>>;
export interface CodePlaybookRegistryEntry {
    id: 'code';
    command: 'code';
    intent: string;
    artifactSchema: 2;
    requiredRoleIds: readonly ['coder'];
    concurrentRoleSets: readonly [];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(optionSlice: unknown): CodeOptions;
    createRuntime(options: CodeOptions): PlaybookRuntime;
}
export declare const codeStateCountLabels: {};
export declare const codeCopyPasteGuardNames: readonly ["directCommit", "irCommit", "moreTasks", "finalTask"];
export declare function codeSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const codeSummaryPolicy: PlaybookSummaryPolicy;
export declare function validateCodeOptions(optionSlice: unknown): CodeOptions;
export declare const codePlaybookRegistryEntry: CodePlaybookRegistryEntry;
export default codePlaybookRegistryEntry;
