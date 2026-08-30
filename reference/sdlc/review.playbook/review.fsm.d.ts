type Role = 'coder' | 'reviewer';
type JumpableStateId = 'reviewInitial';
export type ResumableStateId = 'reviewInitial' | 'addressFindings' | 'reviewAfterCommit' | 'reviewAfterRebuttal';
export interface PendingBossQuestion {
    questionId: ResumableStateId;
    resumeStateId: ResumableStateId;
    sourceItem: `REVIEW-${1 | 2 | 3 | 4}`;
    asker: {
        readonly kind: 'role';
        readonly roleId: Role;
    };
    question: string;
}
export interface ReviewOutput {
    approvedCommit: 'latest';
    noUnsettledFindings: true;
}
export type ReviewInput = Readonly<Record<string, never>>;
export interface ReviewContext {
    callerInput?: string;
    reviewerOutput?: string;
    coderOutput?: string;
    lastError?: unknown;
    pendingBossQuestion?: PendingBossQuestion;
    bossReply?: string;
}
export type ReviewEvent = {
    type: 'START_REVIEW';
    callerInput: string;
} | {
    type: 'BOSS_INTERRUPT';
    targetId: JumpableStateId;
    bossIntent: string;
} | {
    type: 'BOSS_REPLY';
    questionId?: ResumableStateId;
    answer: string;
};
export interface PlayerInput {
    stateId: ResumableStateId;
    sourceItem: `REVIEW-${1 | 2 | 3 | 4}`;
    role: Role;
    prompt: string;
    result: Readonly<Record<string, string>>;
    callerInput?: string;
    reviewerOutput?: string;
    coderOutput?: string;
    pendingBossQuestion?: PendingBossQuestion;
    bossReply?: string;
}
export type PlayerOutput = {
    guard: 'hasFindings';
    reviewerOutput: string;
} | {
    guard: 'noFindings';
} | {
    guard: 'committed';
    coderOutput: string;
} | {
    guard: 'rejectedAll';
    coderOutput: string;
} | {
    guard: 'needsBossReply';
    question: string;
};
export declare const reviewMachine: import("xstate").StateMachine<ReviewContext, {
    type: "START_REVIEW";
    callerInput: string;
} | {
    type: "BOSS_INTERRUPT";
    targetId: JumpableStateId;
    bossIntent: string;
} | {
    type: "BOSS_REPLY";
    questionId?: ResumableStateId;
    answer: string;
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
    type: "rememberBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberEmptyBossReplyError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "copyStartInput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "copyInterruptedInput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberReviewerOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCoderOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "clearBossReplyContext";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setPendingReviewInitial";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setPendingAddressFindings";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setPendingReviewAfterCommit";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setPendingReviewAfterRebuttal";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "needsBossReply";
    params: unknown;
} | {
    type: "emptyBossReply";
    params: unknown;
} | {
    type: "hasFindings";
    params: unknown;
} | {
    type: "noFindings";
    params: unknown;
} | {
    type: "committed";
    params: unknown;
} | {
    type: "rejectedAll";
    params: unknown;
} | {
    type: "resumeReviewInitial";
    params: unknown;
} | {
    type: "resumeAddressFindings";
    params: unknown;
} | {
    type: "resumeReviewAfterCommit";
    params: unknown;
} | {
    type: "resumeReviewAfterRebuttal";
    params: unknown;
} | {
    type: "restartInitialReview";
    params: unknown;
}, never, "done" | "failed" | "awaitBossReply" | "ready" | "reviewInitial" | "addressFindings" | "reviewAfterCommit" | "reviewAfterRebuttal", string, Readonly<Record<string, never>>, ReviewOutput, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "review";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly reviewInitial: {
            id: "reviewInitial";
        };
        readonly addressFindings: {
            id: "addressFindings";
        };
        readonly reviewAfterCommit: {
            id: "reviewAfterCommit";
        };
        readonly reviewAfterRebuttal: {
            id: "reviewAfterRebuttal";
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
    };
}>;
export {};
