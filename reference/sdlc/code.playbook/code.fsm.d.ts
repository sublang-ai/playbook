import type { PlaybookCallResult } from '@sublang/playbook/runtime';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
/** Canonical lowercase local id of the source role Coder. */
export type CodeRole = 'coder';
/** One role-id array per parallel group; CODE declares no parallel group. */
export declare const concurrentRoleSets: readonly (readonly CodeRole[])[];
/** Delegated-player working leaves (CODE-1, CODE-2). */
export type WorkingStateId = 'firstPhase' | 'irTaskPhase';
/** Working leaves that may suspend for, and resume from, a Boss reply. */
export type ResumableStateId = WorkingStateId;
/** Root `BOSS_INTERRUPT` targets. */
export type JumpableStateId = WorkingStateId;
/** The one nested `review` call state (CODE-3). */
export type ReviewStateId = 'reviewIntent';
export type CodeSourceItem = 'CODE-1' | 'CODE-2' | 'CODE-3';
/** The accepted phase outcome whose `review` call decides the next step. */
export type PhaseOutcome = 'directCommit' | 'irCommit' | 'moreTasks' | 'finalTask';
/** The literal nested-call target shared by both call states and guards. */
declare const REVIEW_PLAYBOOK_ID = "review";
export interface PendingBossQuestion {
    readonly questionId: ResumableStateId;
    readonly resumeStateId: ResumableStateId;
    readonly sourceItem: 'CODE-1' | 'CODE-2';
    readonly asker: {
        readonly kind: 'role';
        readonly roleId: CodeRole;
    };
    readonly question: string;
}
interface PlayerInputBase {
    readonly role: CodeRole;
    /** The source item's full final prompt, verbatim. */
    readonly prompt: string;
    /** This state's local result contract: guard name → description. */
    readonly result: Readonly<Record<string, string>>;
    /** `<caller-input>`: the caller's complete coding request. */
    readonly callerInput?: string;
    /** `<run-results>`: relevant run results; empty when none were supplied. */
    readonly runResults: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
}
export interface FirstPhasePlayerInput extends PlayerInputBase {
    readonly stateId: 'firstPhase';
    readonly sourceItem: 'CODE-1';
}
export interface IrTaskPhasePlayerInput extends PlayerInputBase {
    readonly stateId: 'irTaskPhase';
    readonly sourceItem: 'CODE-2';
    /** `<ir-number>`: the IR whose next unfinished task this phase implements. */
    readonly irNumber?: string;
}
export type PlayerInput = FirstPhasePlayerInput | IrTaskPhasePlayerInput;
export type PlayerOutput = {
    readonly guard: 'directCommit';
    readonly coderOutput: string;
    readonly latestCommit: string;
} | {
    readonly guard: 'irCommit';
    readonly coderOutput: string;
    readonly latestCommit: string;
    readonly irNumber: string;
} | {
    readonly guard: 'moreTasks';
    readonly coderOutput: string;
    readonly latestCommit: string;
    readonly irNumber: string;
    readonly irTask: string;
} | {
    readonly guard: 'finalTask';
    readonly coderOutput: string;
    readonly latestCommit: string;
    readonly irNumber: string;
    readonly irTask: string;
} | {
    readonly guard: 'needsBossReply';
    readonly question: string;
};
export interface PlaybookInput {
    readonly stateId: ReviewStateId;
    readonly sourceItem: 'CODE-3';
    readonly playbookId: typeof REVIEW_PLAYBOOK_ID;
    readonly text: string;
}
/** A successful call yields the child's own JSON-safe machine output. */
export type PlaybookOutput = JsonValue | undefined;
/** Public output interface of the packaged builtin `review`. */
export interface ReviewPassOutput {
    readonly noUnsettledFindings: true;
    readonly evaluatedRevision: string;
}
export interface CompactError {
    readonly name: string;
    readonly message: string;
}
export interface ErrorRecord {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
}
/** Sanitized completed-result evidence of the `review` call that ended CODE. */
export type CompletedReviewResult = {
    readonly playbookId: typeof REVIEW_PLAYBOOK_ID;
    readonly status: 'ok';
    readonly output?: JsonValue;
} | {
    readonly playbookId: typeof REVIEW_PLAYBOOK_ID;
    readonly status: 'aborted' | 'error';
    readonly error: CompactError;
};
/** Public output interface of the packaged builtin `code`. */
export type CodeOutput = {
    readonly status: 'complete';
    readonly lastCodeCommit: string;
    readonly finalEvaluatedRevision: string;
    readonly allReviewsPassed: true;
} | {
    readonly status: 'review-failed';
    readonly lastCodeCommit: string;
    readonly error: CompactError;
};
export interface CodeInput {
    /** Optional seed for `<run-results>`; `START_CODE` may supply its own. */
    readonly runResults?: string;
}
export interface CodeContext {
    /** `<run-results>`: relevant run results relayed to every phase. */
    readonly runResults: string;
    /** `<caller-input>`: the caller's coding request and relevant context. */
    readonly callerInput?: string;
    /** The accepted `latestCommit` of the latest phase: the last `code`-owned commit. */
    readonly codeCommit?: string;
    /** `<code-commits>`: every phase's accepted commit of this run, oldest first. */
    readonly codeCommits: readonly string[];
    /** `<coder-output>`: Coder's verbatim final text for the latest phase. */
    readonly coderOutput?: string;
    /** `<ir-number>`: the created or continued IR. */
    readonly irNumber?: string;
    /** `<ir-task>`: the IR task the latest IR-task phase implemented. */
    readonly irTask?: string;
    /** The accepted outcome of the latest phase. */
    readonly phaseOutcome?: PhaseOutcome;
    /** Revision evaluated by the passing review. */
    readonly evaluatedRevision?: string;
    /** Compact failure CODE reports when review did not pass a phase. */
    readonly reviewError?: CompactError;
    /** Sanitized evidence of the review result that ended CODE. */
    readonly reviewEvidence?: CompletedReviewResult;
    readonly lastError?: ErrorRecord;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
}
export type CodeEvent = {
    readonly type: 'START_CODE';
    readonly callerInput: string;
    readonly runResults?: string;
} | {
    readonly type: 'BOSS_INTERRUPT';
    readonly targetId: JumpableStateId;
} | {
    readonly type: 'BOSS_REPLY';
    readonly answer: string;
    readonly questionId?: ResumableStateId;
};
/**
 * Recognizes an authored rejected child result: an aborted or error call, or
 * a child that completed at its own authored failure terminal.
 */
export declare function authoredChildResult(error: unknown, expectedPlaybookId: string): PlaybookCallResult | undefined;
export declare const codeMachine: import("xstate").StateMachine<CodeContext, {
    readonly type: "START_CODE";
    readonly callerInput: string;
    readonly runResults?: string;
} | {
    readonly type: "BOSS_INTERRUPT";
    readonly targetId: JumpableStateId;
} | {
    readonly type: "BOSS_REPLY";
    readonly answer: string;
    readonly questionId?: ResumableStateId;
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>> | import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<PlaybookOutput, PlaybookInput, import("xstate").EventObject>> | undefined;
}, {
    src: "player";
    logic: import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>;
    id: string | undefined;
} | {
    src: "playbook";
    logic: import("xstate").PromiseActorLogic<PlaybookOutput, PlaybookInput, import("xstate").EventObject>;
    id: string | undefined;
}, {
    type: "playbook.acceptedOutcome";
    params: {
        readonly source: string;
        readonly target: string;
        readonly acceptedOutcome: string;
    };
} | {
    type: "rememberActorError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "resetForInterrupt";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedPlayerOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "clearBossReplyContext";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberAuthoredReviewFailure";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "startCode";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberPhaseCommit";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setPendingBossQuestion";
    params: {
        readonly resumeStateId: ResumableStateId;
    };
} | {
    type: "rememberReviewPass";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberReviewNotPassed";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedBossReply";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "acceptDirectCommit";
    params: unknown;
} | {
    type: "acceptIrCommit";
    params: unknown;
} | {
    type: "acceptMoreTasks";
    params: unknown;
} | {
    type: "acceptFinalTask";
    params: unknown;
} | {
    type: "authoredReviewFailure";
    params: unknown;
} | {
    type: "needsBossReplyWithQuestion";
    params: unknown;
} | {
    type: "reviewPassed";
    params: unknown;
} | {
    type: "validStartCode";
    params: unknown;
} | {
    type: "emptyBossReply";
    params: unknown;
}, never, "done" | "failed" | "ready" | "awaitBossReply" | "firstPhase" | "irTaskPhase" | "reviewIntent" | "reviewFailed", string, CodeInput, {
    readonly status: "complete";
    readonly lastCodeCommit: string;
    readonly finalEvaluatedRevision: string;
    readonly allReviewsPassed: true;
} | {
    readonly status: "review-failed";
    readonly lastCodeCommit: string;
    readonly error: CompactError;
}, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "code";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly firstPhase: {
            id: "firstPhase";
        };
        readonly irTaskPhase: {
            id: "irTaskPhase";
        };
        readonly reviewIntent: {
            id: "reviewIntent";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly failed: {
            id: "failed";
        };
        readonly reviewFailed: {
            id: "reviewFailed";
        };
        readonly done: {
            id: "done";
        };
    };
}>;
export default codeMachine;
