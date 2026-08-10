import { type PlaybookRuntime, type PlaybookRuntimeOptions } from './decide.playbook.js';
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
export interface CreateDecideRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export type DecideOptions = Readonly<Record<string, never>>;
export interface DecidePlaybookRegistryEntry {
    id: 'decide';
    command: 'decide';
    intent: string;
    requiredRoleIds: readonly ['coder', 'reviewer'];
    summaryPolicy: PlaybookSummaryPolicy;
    validateOptions(captainOptions: unknown): DecideOptions;
    createRuntime(options: CreateDecideRuntimeOptions): PlaybookRuntime;
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
export declare function createDecideRuntimeOptions({ captainOptions, players, }: CreateDecideRuntimeOptions): PlaybookRuntimeOptions;
export declare const decidePlaybookRegistryEntry: DecidePlaybookRegistryEntry;
export default decidePlaybookRegistryEntry;
