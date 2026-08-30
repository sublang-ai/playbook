import type { NestedPlaybookBridge } from '../../../src/xstate-runtime.js';
import { type PlayerInput, type PlayerOutput, type DecideEvent, type DecideInput, type PendingBossQuestion, type PlaybookInput } from './decide.fsm.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlayerResult, PlayerSessionStore, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlAction, PlaybookControlReceipt, PlaybookControlView, PlaybookEffectBoundary, PlaybookEffectBoundaryStart, PlaybookEffectLedger, PlaybookPendingBossQuestion, PlaybookPendingCall, PlaybookPorts, PlaybookRepositoryReceipt, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType } from '@sublang/playbook/runtime';
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
interface Schema3AutomaticReplayEvidence {
    readEffectLedger(): unknown;
}
interface DecideRepositoryOperationSettlement<T> {
    readonly status: 'fulfilled';
    readonly value: T;
}
interface DecideRepositoryOperationRejection {
    readonly status: 'rejected';
    readonly reason: unknown;
}
interface DecideRepositoryCompletion<T> {
    readonly boundary: PlaybookEffectBoundary;
    readonly operation: DecideRepositoryOperationSettlement<T> | DecideRepositoryOperationRejection;
    readonly receipt: PlaybookRepositoryReceipt;
}
interface DecideDeferredBinding {
    readonly operationId: string;
    readonly pendingQuestion: PlaybookPendingBossQuestion;
    readonly playerContinuation: JsonValue;
}
interface DecideRepositoryCompletionEvidence {
    readonly finalText?: string;
    readonly semanticCandidate?: JsonValue;
    readonly deferred?: DecideDeferredBinding;
    readonly unresolved?: true;
}
interface DecideRepositoryExclusiveResult<T> {
    readonly operation: DecideRepositoryOperationSettlement<T> | DecideRepositoryOperationRejection;
    readonly receipt: PlaybookRepositoryReceipt;
    readonly effectLedger: PlaybookEffectLedger;
    readonly deferredStatus?: 'bound' | 'unresolved';
}
interface DecideRepositoryDeferredContinuationResult<T> extends DecideRepositoryExclusiveResult<T> {
    readonly status: 'continued';
    readonly baseline: PlaybookRepositoryReceipt['baseline'];
    readonly logicalReceipt?: PlaybookRepositoryReceipt;
}
interface DecideRepositoryDeferredCheckpointMismatch {
    readonly status: 'checkpoint-mismatch' | 'ineligible';
    readonly effectLedger: PlaybookEffectLedger;
}
interface DecideRepositoryDeferredParked {
    readonly status: 'parked';
    readonly effectLedger: PlaybookEffectLedger;
}
interface DecideRepositoryDeferredRestoreResult {
    readonly status: 'restored' | 'checkpoint-mismatch' | 'ineligible';
    readonly effectLedger: PlaybookEffectLedger;
}
type DecideEffectBoundarySeed = Omit<PlaybookEffectBoundaryStart, 'playbookId' | 'canonicalWorktree' | 'baseline' | 'cohortId'>;
interface DecideRepositoryCapability {
    runExclusive<T>(options: {
        readonly signal: AbortSignal;
        readonly effectBoundary: DecideEffectBoundarySeed;
        readonly operation: (context: {
            readonly baseline: PlaybookRepositoryReceipt['baseline'];
            readonly identity: unknown;
        }) => Promise<T>;
        readonly completeEffectBoundary: (completion: DecideRepositoryCompletion<T>) => DecideRepositoryCompletionEvidence | Promise<DecideRepositoryCompletionEvidence>;
    }): Promise<DecideRepositoryExclusiveResult<T>>;
    runDeferred<T>(options: {
        readonly mode: 'continue';
        readonly signal: AbortSignal;
        readonly operationId: string;
        readonly effectBoundary: DecideEffectBoundarySeed;
        readonly operation: (context: {
            readonly baseline: PlaybookRepositoryReceipt['baseline'];
            readonly identity: unknown;
            readonly playerContinuation: JsonValue;
        }) => Promise<T>;
        readonly completeEffectBoundary: (completion: DecideRepositoryCompletion<T>) => DecideRepositoryCompletionEvidence | Promise<DecideRepositoryCompletionEvidence>;
    }): Promise<DecideRepositoryDeferredContinuationResult<T> | DecideRepositoryDeferredCheckpointMismatch>;
    runDeferred(options: {
        readonly mode: 'park' | 'restore';
        readonly signal: AbortSignal;
        readonly operationId: string;
    }): Promise<DecideRepositoryDeferredParked | DecideRepositoryDeferredRestoreResult>;
}
interface Schema3DeferredEffectEvidence extends Schema3AutomaticReplayEvidence {
    readonly repository: DecideRepositoryCapability;
}
declare function pendingQuestionsFromContext(context: Record<string, unknown>): PendingBossQuestion[];
declare function pendingQuestionsForState(state: PlaybookState, context: Record<string, unknown>): PendingBossQuestion[];
type DecidePlaybookRuntime = PlaybookRuntime & {
    _getNestedBridge(): NestedPlaybookBridge<PlaybookInput>;
};
type StagedDecidePlaybookRuntime = DecidePlaybookRuntime & {
    _reconcileDeferred(signal: AbortSignal): Promise<'restored' | 'checkpoint-mismatch' | 'ineligible'>;
};
export declare const createPlaybookRuntime: PlaybookRuntimeFactory<PlaybookRuntimeOptions>;
declare function createStagedSchema3AutomaticReplayRuntime(options: PlaybookRuntimeOptions, evidence: Schema3AutomaticReplayEvidence): PlaybookRuntime;
declare function createStagedSchema3DeferredRuntime(options: PlaybookRuntimeOptions, evidence: Schema3DeferredEffectEvidence): StagedDecidePlaybookRuntime;
declare function createStagedSchema3AcceptedOutcomeRuntime(options: PlaybookRuntimeOptions, evidence: Schema3AutomaticReplayEvidence, acceptedOutcomeAction: unknown): PlaybookRuntime;
export declare const _internal: {
    createStagedSchema3AutomaticReplayRuntime: typeof createStagedSchema3AutomaticReplayRuntime;
    createStagedSchema3DeferredRuntime: typeof createStagedSchema3DeferredRuntime;
    createStagedSchema3AcceptedOutcomeRuntime: typeof createStagedSchema3AcceptedOutcomeRuntime;
    composePlayerPrompt: typeof composePlayerPrompt;
    requiredFieldsFor: typeof requiredFieldsFor;
    extractJson: typeof extractJson;
    buildClassifierPrompt: typeof buildClassifierPrompt;
    parseClassification: typeof parseClassification;
    buildAdjudicatorPrompt: typeof buildAdjudicatorPrompt;
    parseAdjudication: typeof parseAdjudication;
    combineSignals: typeof combineSignals;
    pendingQuestionsFromContext: typeof pendingQuestionsFromContext;
    pendingQuestionsForState: typeof pendingQuestionsForState;
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
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
    CONTINUATION_PREAMBLE: string;
    TELEMETRY_TOPIC: string;
};
export default createPlaybookRuntime;
