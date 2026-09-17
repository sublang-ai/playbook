export type BranchStateId = 'createBranch';
export type BranchSourceItem = 'BRANCH-1';
export type PendingBossQuestion = {
    readonly questionId: 'createBranch';
    readonly resumeStateId: 'createBranch';
    readonly sourceItem: 'BRANCH-1';
    readonly asker: {
        readonly kind: 'role';
        readonly roleId: 'coder';
    };
    readonly question: string;
};
export type PlayerInput = {
    readonly stateId: 'createBranch';
    readonly role: 'coder';
    readonly sourceItem: 'BRANCH-1';
    readonly prompt: string;
    readonly result: Readonly<Record<string, string>>;
    readonly callerInput: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type PlayerOutput = {
    readonly guard: 'branched';
    readonly branch: string;
    /**
     * Receipt-owned effect evidence (DR-045): the branching call's
     * `unchanged` receipt observes the commit the branch was created from
     * as HEAD, so the linked runtime injects it and never takes it from
     * Coder's prose.
     */
    readonly baseRevision: string;
    readonly issueSummary: string;
} | {
    readonly guard: 'refused';
    readonly coderOutput: string;
} | {
    readonly guard: 'needsBossReply';
    readonly question: string;
};
export type BranchPlaybookOutput = {
    readonly status: 'branched';
    /** Exact name of the new branch now checked out. */
    readonly branch: string;
    /** Exact receipt-observed revision the branch was created from. */
    readonly baseRevision: string;
    /** Coder's concise summary of the issue and its comments, or of the request. */
    readonly issueSummary: string;
} | {
    readonly status: 'refused';
    /** Coder's complete report carrying the reason no branch was created. */
    readonly coderOutput: string;
};
export type BranchInput = Readonly<Record<string, never>>;
export type BranchContext = {
    readonly callerInput?: string;
    readonly branch?: string;
    /** Observed HEAD of the branching call's unchanged receipt (DR-045). */
    readonly baseRevision?: string;
    readonly issueSummary?: string;
    readonly coderOutput?: string;
    readonly completion?: 'branched' | 'refused';
    readonly lastError?: unknown;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type BranchEvent = {
    readonly type: 'START_BRANCH';
    readonly callerInput: string;
} | {
    readonly type: 'BOSS_REPLY';
    readonly answer: string;
    readonly questionId?: 'createBranch';
};
export declare const branchMachine: import("xstate").StateMachine<BranchContext, {
    readonly type: "START_BRANCH";
    readonly callerInput: string;
} | {
    readonly type: "BOSS_REPLY";
    readonly answer: string;
    readonly questionId?: "createBranch";
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
    type: "rememberPendingQuestion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberEmptyBossReplyError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedPlayerOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "startBranch";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberBranched";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberRefused";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "needsBossReply";
    params: unknown;
} | {
    type: "emptyBossReply";
    params: unknown;
} | {
    type: "isBranched";
    params: unknown;
} | {
    type: "isRefused";
    params: unknown;
} | {
    type: "resumesCreateBranch";
    params: unknown;
}, never, "failed" | "ready" | "awaitBossReply" | "refused" | "createBranch" | "branched", string, Readonly<Record<string, never>>, {
    readonly status: "branched";
    /** Exact name of the new branch now checked out. */
    readonly branch: string;
    /** Exact receipt-observed revision the branch was created from. */
    readonly baseRevision: string;
    /** Coder's concise summary of the issue and its comments, or of the request. */
    readonly issueSummary: string;
} | {
    readonly status: "refused";
    /** Coder's complete report carrying the reason no branch was created. */
    readonly coderOutput: string;
}, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "branch";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly createBranch: {
            id: "createBranch";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly failed: {
            id: "failed";
        };
        readonly branched: {
            id: "branched";
        };
        readonly refused: {
            id: "refused";
        };
    };
}>;
export default branchMachine;
