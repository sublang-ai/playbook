/** Canonical lowercase local ids of the source roles Coder and Reviewer. */
export type ReviewRole = 'coder' | 'reviewer';
/** One role-id array per parallel group; REVIEW declares no parallel group. */
export declare const concurrentRoleSets: readonly (readonly ReviewRole[])[];
/** Delegated-player working leaves (REVIEW-1 through REVIEW-4). */
export type WorkingStateId = 'firstReview' | 'fixFindings' | 'reviewAfterFix' | 'reviewAfterRejection';
/** Working leaves that may suspend for, and resume from, a Boss reply. */
export type ResumableStateId = WorkingStateId;
/** Root `BOSS_INTERRUPT` targets. */
export type JumpableStateId = WorkingStateId;
export type ReviewSourceItem = 'REVIEW-1' | 'REVIEW-2' | 'REVIEW-3' | 'REVIEW-4';
/** Coder's accepted disposition of the latest findings. */
export type CoderOutcome = 'committed' | 'rejectedAll';
export interface PendingBossQuestion {
    readonly questionId: ResumableStateId;
    readonly resumeStateId: ResumableStateId;
    readonly sourceItem: ReviewSourceItem;
    readonly asker: {
        readonly kind: 'role';
        readonly roleId: ReviewRole;
    };
    readonly question: string;
}
interface PlayerInputBase {
    /** The source item's full final prompt, verbatim. */
    readonly prompt: string;
    /** This state's local result contract: guard name → description. */
    readonly result: Readonly<Record<string, string>>;
    /** `<caller-input>`: the caller's complete review request. */
    readonly callerInput?: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
}
export interface FirstReviewPlayerInput extends PlayerInputBase {
    readonly stateId: 'firstReview';
    readonly role: 'reviewer';
    readonly sourceItem: 'REVIEW-1';
}
export interface FixFindingsPlayerInput extends PlayerInputBase {
    readonly stateId: 'fixFindings';
    readonly role: 'coder';
    readonly sourceItem: 'REVIEW-2';
    /** `<reviewer-output>`: Reviewer's verbatim final text of the latest round. */
    readonly reviewerOutput?: string;
}
export interface ReviewAfterFixPlayerInput extends PlayerInputBase {
    readonly stateId: 'reviewAfterFix';
    readonly role: 'reviewer';
    readonly sourceItem: 'REVIEW-3';
    /** `<latest-commit>`: the receipt-owned latest review-fix commit. */
    readonly latestCommit?: string;
    /** `<coder-output>`: Coder's verbatim final text of the latest fix round. */
    readonly coderOutput?: string;
}
export interface ReviewAfterRejectionPlayerInput extends PlayerInputBase {
    readonly stateId: 'reviewAfterRejection';
    readonly role: 'reviewer';
    readonly sourceItem: 'REVIEW-4';
    /** `<coder-output>`: Coder's verbatim final text of the latest fix round. */
    readonly coderOutput?: string;
}
export type PlayerInput = FirstReviewPlayerInput | FixFindingsPlayerInput | ReviewAfterFixPlayerInput | ReviewAfterRejectionPlayerInput;
export type NeedsBossReplyOutput = {
    readonly guard: 'needsBossReply';
    readonly question: string;
};
/** Reviewer outcomes (REVIEW-1, REVIEW-3, REVIEW-4). */
export type ReviewerOutput = {
    readonly guard: 'hasFindings';
    readonly reviewerOutput: string;
} | {
    readonly guard: 'noFindings';
    /** Effect-owned: the exact revision taken from repository authority. */
    readonly evaluatedRevision: string;
} | NeedsBossReplyOutput;
/** Coder outcomes (REVIEW-2). */
export type CoderOutput = {
    readonly guard: 'committed';
    readonly coderOutput: string;
    /** Effect-owned: the runtime fills it from the repository receipt. */
    readonly latestCommit: string;
} | {
    readonly guard: 'rejectedAll';
    readonly coderOutput: string;
} | NeedsBossReplyOutput;
export type PlayerOutput = ReviewerOutput | CoderOutput;
export interface ErrorRecord {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
}
/** Reviewer rounds REVIEW runs at most: the first and one after each of two Coder dispositions. */
export declare const MAX_REVIEW_ROUNDS = 3;
/** Public output interface of the packaged builtin `review`. */
export type ReviewOutput = {
    readonly noUnsettledFindings: true;
    readonly evaluatedRevision: string;
} | {
    /** Findings Reviewer raised or kept at the third round stay unsettled. */
    readonly noUnsettledFindings: false;
    readonly reviewerOutput: string;
};
/** The machine reads no input: the caller input arrives on `START_REVIEW`. */
export type ReviewInput = Readonly<Record<never, never>>;
export interface ReviewContext {
    /** `<caller-input>`: the caller's intent, review scope, and context. */
    readonly callerInput?: string;
    /** `<reviewer-output>`: Reviewer's verbatim final text with findings. */
    readonly reviewerOutput?: string;
    /** `<coder-output>`: Coder's verbatim final text of the latest fix round. */
    readonly coderOutput?: string;
    /** `<latest-commit>`: the accepted, receipt-owned latest review-fix commit. */
    readonly latestCommit?: string;
    /** Coder's accepted disposition of the latest findings. */
    readonly coderOutcome?: CoderOutcome;
    /** Revision evaluated by the clean review round that ended REVIEW. */
    readonly evaluatedRevision?: string;
    /** The Reviewer round in progress: 1 at the first review, +1 per Coder disposition. */
    readonly round?: number;
    /** Set when the third round ended with findings still unsettled. */
    readonly findingsUnsettled?: true;
    readonly lastError?: ErrorRecord;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
}
export type ReviewEvent = {
    readonly type: 'START_REVIEW';
    readonly callerInput: string;
} | {
    readonly type: 'BOSS_INTERRUPT';
    readonly targetId: JumpableStateId;
} | {
    readonly type: 'BOSS_REPLY';
    readonly answer: string;
    readonly questionId?: ResumableStateId;
};
export declare const reviewMachine: import("xstate").StateMachine<ReviewContext, {
    readonly type: "START_REVIEW";
    readonly callerInput: string;
} | {
    readonly type: "BOSS_INTERRUPT";
    readonly targetId: JumpableStateId;
} | {
    readonly type: "BOSS_REPLY";
    readonly answer: string;
    readonly questionId?: ResumableStateId;
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>> | undefined;
}, {
    src: "player";
    logic: import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>;
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
    type: "setPendingBossQuestion";
    params: {
        readonly resumeStateId: ResumableStateId;
    };
} | {
    type: "rememberMalformedBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "startReview";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberFindings";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCoderDisposition";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberUnsettledFindings";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberEvaluatedRevision";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "emptyBossReply";
    params: unknown;
} | {
    type: "acceptHasFindings";
    params: unknown;
} | {
    type: "acceptHasFindingsBeforeBound";
    params: unknown;
} | {
    type: "validStartReview";
    params: unknown;
} | {
    type: "acceptHasFindingsAtBound";
    params: unknown;
} | {
    type: "acceptNoFindings";
    params: unknown;
} | {
    type: "acceptCommitted";
    params: unknown;
} | {
    type: "acceptRejectedAll";
    params: unknown;
} | {
    type: "acceptNeedsBossReply";
    params: unknown;
}, never, "done" | "failed" | "ready" | "awaitBossReply" | "firstReview" | "fixFindings" | "reviewAfterFix" | "reviewAfterRejection" | "unsettled", string, Readonly<Record<never, never>>, {
    readonly noUnsettledFindings: true;
    readonly evaluatedRevision: string;
} | {
    /** Findings Reviewer raised or kept at the third round stay unsettled. */
    readonly noUnsettledFindings: false;
    readonly reviewerOutput: string;
}, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "review";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly firstReview: {
            id: "firstReview";
        };
        readonly fixFindings: {
            id: "fixFindings";
        };
        readonly reviewAfterFix: {
            id: "reviewAfterFix";
        };
        readonly reviewAfterRejection: {
            id: "reviewAfterRejection";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly failed: {
            id: "failed";
        };
        readonly done: {
            id: "done";
        };
        readonly unsettled: {
            id: "unsettled";
        };
    };
}>;
export default reviewMachine;
