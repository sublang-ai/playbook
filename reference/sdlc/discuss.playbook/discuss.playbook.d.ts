import { type PlayerInput, type PlayerOutput, type DiscussEvent, type DiscussInput, type PendingBossQuestion } from './discuss.fsm.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlayerResult, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlayerResult, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, };
type PlayerName = 'Host' | 'Participant' | 'Committer';
export interface PlaybookRuntimeOptions extends DiscussInput {
    playerBinding?: Partial<Record<PlayerName, string>>;
}
declare function composePlayerPrompt(input: PlayerInput): string;
declare function resolvePlayerId(input: PlayerInput, binding: Record<PlayerName, string>): string;
declare function requiredFieldsFor(description: string): string[];
declare function extractJson(raw: string): Record<string, unknown> | null;
declare function buildClassifierPrompt(text: string, ctx: {
    state: PlaybookState;
    pendingQuestions: readonly PendingBossQuestion[];
}): string;
declare function parseClassification(raw: string, pendingQuestionIds?: readonly string[]): DiscussEvent | null;
declare function buildAdjudicatorPrompt(input: PlayerInput, playerOutput: string): string;
declare function parseAdjudication(raw: string, input: PlayerInput): PlayerOutput;
declare function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal;
declare function normalizeErrorCompact(err: unknown): {
    name: string;
    message: string;
} | undefined;
declare function normalizeErrorFull(err: unknown): {
    name: string;
    message: string;
    stack?: string;
} | undefined;
declare function pendingQuestionsFromContext(context: Record<string, unknown>): PendingBossQuestion[];
export declare const createPlaybookRuntime: PlaybookRuntimeFactory<PlaybookRuntimeOptions>;
export declare const _internal: {
    composePlayerPrompt: typeof composePlayerPrompt;
    resolvePlayerId: typeof resolvePlayerId;
    requiredFieldsFor: typeof requiredFieldsFor;
    extractJson: typeof extractJson;
    buildClassifierPrompt: typeof buildClassifierPrompt;
    parseClassification: typeof parseClassification;
    buildAdjudicatorPrompt: typeof buildAdjudicatorPrompt;
    parseAdjudication: typeof parseAdjudication;
    combineSignals: typeof combineSignals;
    pendingQuestionsFromContext: typeof pendingQuestionsFromContext;
    normalizeErrorCompact: typeof normalizeErrorCompact;
    normalizeErrorFull: typeof normalizeErrorFull;
    DEFAULT_PLAYER_BINDING: Readonly<Record<PlayerName, string>>;
    ALIAS_RESOLUTION: Readonly<Record<string, string>>;
    STATE_DESCRIPTIONS: Readonly<Record<string, string>>;
    CAPTAIN_STATES: readonly [{
        readonly stateId: "askHostInitial";
        readonly player: "Host";
        readonly sourceItem: "DISCUSS-1";
    }, {
        readonly stateId: "askParticipantInitial";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-2";
    }, {
        readonly stateId: "hostInitialRound";
        readonly player: "Host";
        readonly sourceItem: "DISCUSS-3";
    }, {
        readonly stateId: "participantInitialRound";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-4";
    }, {
        readonly stateId: "hostWritesAgreement";
        readonly player: "Host";
        readonly sourceItem: "DISCUSS-5";
    }, {
        readonly stateId: "commitInitialChanges";
        readonly player: "Committer";
        readonly sourceItem: "DISCUSS-14";
    }, {
        readonly stateId: "reviewSpecInitialCommit";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-6";
    }, {
        readonly stateId: "reviewSpecHostChanges";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-7";
    }, {
        readonly stateId: "reviewDrInitialCommit";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-8";
    }, {
        readonly stateId: "reviewDrHostChanges";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-9";
    }, {
        readonly stateId: "reviewMixedInitialCommit";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-10";
    }, {
        readonly stateId: "reviewMixedHostChanges";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-11";
    }, {
        readonly stateId: "hostAddressesFindings";
        readonly player: "Host";
        readonly sourceItem: "DISCUSS-12";
    }, {
        readonly stateId: "participantAddressesRebuttals";
        readonly player: "Participant";
        readonly sourceItem: "DISCUSS-13";
    }, {
        readonly stateId: "commitReviewedChanges";
        readonly player: "Committer";
        readonly sourceItem: "DISCUSS-15";
    }];
    CAPTAIN_STATE_IDS: ReadonlySet<string>;
    BOSS_INTERRUPT_TARGETS: readonly ["ready", "initialProposalRound", "reconciliationRound", "hostWritesAgreement", "commitInitialChanges", "reviewSpecInitialCommit", "reviewSpecHostChanges", "reviewDrInitialCommit", "reviewDrHostChanges", "reviewMixedInitialCommit", "reviewMixedHostChanges", "hostAddressesFindings", "participantAddressesRebuttals", "commitReviewedChanges", "failed"];
    CONTINUATION_PREAMBLE: string;
    TELEMETRY_TOPIC: string;
};
export default createPlaybookRuntime;
