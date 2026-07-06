import type { PlaybookRuntime } from '@sublang/playbook/runtime';
import type { PlaybookRuntimeOptions } from './discuss.playbook.js';
export interface RegistryPlayer {
    id: string;
    adapter?: string;
    model?: string;
}
export interface CreateDiscussRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export interface DiscussOptions {
    /** Which alias alternative runs `Committer` commits; defaults to `host`. */
    committer?: 'host' | 'participant';
}
export declare function validateDiscussOptions(optionSlice: unknown): DiscussOptions;
export declare function createDiscussRuntimeOptions({ captainOptions, players, }: CreateDiscussRuntimeOptions): PlaybookRuntimeOptions;
export declare function discussSavedCountsLine(counts: {
    interruptions: number;
    copyPastes: number;
}, rounds: number): string;
export declare const discussSummaryPolicy: {
    stateCountLabels: {
        readonly askHostInitial: "proposal round";
        readonly askParticipantInitial: "proposal round";
        readonly hostInitialRound: "proposal round";
        readonly participantInitialRound: "proposal round";
        readonly reviewSpecInitialCommit: "review round";
        readonly reviewSpecHostChanges: "review round";
        readonly reviewDrInitialCommit: "review round";
        readonly reviewDrHostChanges: "review round";
        readonly reviewMixedInitialCommit: "review round";
        readonly reviewMixedHostChanges: "review round";
    };
    copyPasteGuardNames: readonly ["proposalMade", "findingsRaised", "rebuttalsRaised", "rebuttalsAddressed", "changesMade"];
    savedCountsLine: typeof discussSavedCountsLine;
};
export declare const discussPlaybookRegistryEntry: {
    id: string;
    command: string;
    intent: string;
    requiredRoleIds: string[];
    idleStateId: string;
    finalStateId: string;
    parkStateIds: string[];
    summaryPolicy: {
        stateCountLabels: {
            readonly askHostInitial: "proposal round";
            readonly askParticipantInitial: "proposal round";
            readonly hostInitialRound: "proposal round";
            readonly participantInitialRound: "proposal round";
            readonly reviewSpecInitialCommit: "review round";
            readonly reviewSpecHostChanges: "review round";
            readonly reviewDrInitialCommit: "review round";
            readonly reviewDrHostChanges: "review round";
            readonly reviewMixedInitialCommit: "review round";
            readonly reviewMixedHostChanges: "review round";
        };
        copyPasteGuardNames: readonly ["proposalMade", "findingsRaised", "rebuttalsRaised", "rebuttalsAddressed", "changesMade"];
        savedCountsLine: typeof discussSavedCountsLine;
    };
    validateOptions: typeof validateDiscussOptions;
    createRuntime(options: CreateDiscussRuntimeOptions): PlaybookRuntime;
};
export default discussPlaybookRegistryEntry;
