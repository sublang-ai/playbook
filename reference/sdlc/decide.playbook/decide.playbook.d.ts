import { type PlayerInput, type PlayerOutput, type DecideEvent, type DecideInput, type PendingBossQuestion } from './decide.fsm.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlayerResult, PlayerSessionStore, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlAction, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlayerResult, PlayerSessionStore, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlAction, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, };
type RoleId = 'coder' | 'reviewer';
export type PlaybookRuntimeOptions = DecideInput;
type PromptIdentity = (roleId: RoleId) => string;
declare function composePlayerPrompt(input: PlayerInput, promptIdentity: PromptIdentity): string;
declare function requiredFieldsFor(description: string): string[];
declare function extractJson(raw: string): Record<string, unknown> | null;
declare function buildClassifierPrompt(text: string, ctx: {
    state: PlaybookState;
    pendingQuestions: readonly PendingBossQuestion[];
}): string;
declare function parseClassification(raw: string, text: string, pendingQuestionIds?: readonly string[]): DecideEvent | {
    type: 'NO_ACTION';
} | null;
declare function buildAdjudicatorPrompt(input: PlayerInput, playerOutput: string): string;
declare function parseAdjudication(raw: string, input: PlayerInput, finalText: string): PlayerOutput;
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
    STATE_DESCRIPTIONS: Readonly<Record<string, string>>;
    ROLE_STATES: readonly [{
        readonly stateId: "askCoderProposal";
        readonly role: "coder";
        readonly sourceItem: "DECIDE-1";
    }, {
        readonly stateId: "askReviewerProposal";
        readonly role: "reviewer";
        readonly sourceItem: "DECIDE-2";
    }, {
        readonly stateId: "commitCoderProposal";
        readonly role: "coder";
        readonly sourceItem: "DECIDE-3";
    }];
    ROLE_STATE_IDS: ReadonlySet<string>;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
    BOSS_INTERRUPT_TARGETS: readonly ["independentProposals"];
    CONTINUATION_PREAMBLE: string;
    TELEMETRY_TOPIC: string;
};
export default createPlaybookRuntime;
