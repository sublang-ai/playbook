import { type CodePlaybookOptions, type PlaybookRuntime } from './code.playbook.js';
export declare const codeCopyPasteGuardNames: readonly ["accepted", "approved", "challengeAccepted", "challengeRejected", "challengesRaised", "changesMadeCode", "changesMadeCodeAndChallenged", "changesMadeMixed", "changesMadeMixedAndChallenged", "changesMadeSpecs", "changesMadeSpecsAndChallenged", "hasFindings", "needsRevision", "noFindings", "noOpenItems"];
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
    idleStateId: 'ready';
    finalStateId: 'done';
    copyPasteGuardNames: readonly string[];
    validateOptions(captainOptions: unknown): CodeOptions;
    createRuntime(options: CreateCodeRuntimeOptions): PlaybookRuntime;
}
export declare function validateCodeOptions(captainOptions: unknown): CodeOptions;
export declare function createCodeRuntimeOptions({ captainOptions, players, }: CreateCodeRuntimeOptions): CodePlaybookOptions;
export declare const codePlaybookRegistryEntry: CodePlaybookRegistryEntry;
