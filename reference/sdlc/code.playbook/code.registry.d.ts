import { type CodePlaybookOptions, type PlaybookRuntime } from './code.playbook.js';
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
export interface CreateCodeRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export type CodeOptions = Readonly<Record<string, never>>;
export interface CodePlaybookRegistryEntry {
    id: 'code';
    command: 'code';
    intent: string;
    requiredRoleIds: readonly ['coder'];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(captainOptions: unknown): CodeOptions;
    createRuntime(options: CreateCodeRuntimeOptions): PlaybookRuntime;
}
export declare const codeStateCountLabels: {};
export declare const codeCopyPasteGuardNames: readonly ["directCommit", "irCommit", "moreTasks", "finalTask"];
export declare function codeSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const codeSummaryPolicy: PlaybookSummaryPolicy;
export declare function validateCodeOptions(optionSlice: unknown): CodeOptions;
export declare function createCodeRuntimeOptions({ captainOptions, players, }: CreateCodeRuntimeOptions): CodePlaybookOptions;
export declare const codePlaybookRegistryEntry: CodePlaybookRegistryEntry;
export default codePlaybookRegistryEntry;
