export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type DevStateId = 'planAnalysis' | 'callCode' | 'callDecide' | 'callCodeAfterDecide';
export type DevSourceItem = 'DEV-1' | 'DEV-2' | 'DEV-3' | 'DEV-4';
export type DevChildPlaybookId = 'code' | 'decide';
export type PendingBossQuestion = {
    readonly questionId: 'planAnalysis';
    readonly resumeStateId: 'planAnalysis';
    readonly sourceItem: 'DEV-1';
    readonly asker: {
        readonly kind: 'role';
        readonly roleId: 'analyst';
    };
    readonly question: string;
};
export type DiscussionExchange = {
    readonly question: string;
    readonly answer: string;
};
export type PlayerInput = {
    readonly stateId: 'planAnalysis';
    readonly role: 'analyst';
    readonly sourceItem: 'DEV-1';
    readonly prompt: string;
    readonly result: Readonly<Record<string, string>>;
    readonly developmentRequest: string;
    readonly discussionContext: string;
    readonly runResults: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type PlayerOutput = {
    readonly guard: 'discussionComplete';
} | {
    readonly guard: 'code';
    readonly planningResult: string;
} | {
    readonly guard: 'decideThenCode';
    readonly planningResult: string;
} | {
    readonly guard: 'needsBossReply';
    readonly question: string;
};
export type PlaybookInput = {
    readonly stateId: 'callCode' | 'callDecide' | 'callCodeAfterDecide';
    readonly sourceItem: 'DEV-2' | 'DEV-3' | 'DEV-4';
    readonly playbookId: DevChildPlaybookId;
    readonly text: string;
};
/**
 * The affirmative success proof DEV requires from `decide`'s canonical
 * structured terminal output before starting the dependent `code` call:
 * the `decide`-owned commit, the exact evaluated repository revision, and
 * the affirmative no-unsettled-findings fact. Additional members belong to
 * DECIDE's own contract and do not disprove success.
 */
export type DecideSuccessOutput = {
    readonly decideCommit: string;
    readonly evaluatedRevision: string;
    readonly noUnsettledFindings: true;
};
export type CompactError = {
    readonly name: string;
    readonly message: string;
};
/** Sanitized canonical child result relayed as DEV's own failure outcome. */
export type CompletedChildResult = {
    readonly playbookId: DevChildPlaybookId;
    readonly status: 'ok';
    readonly output?: JsonValue;
} | {
    readonly playbookId: DevChildPlaybookId;
    readonly status: 'aborted' | 'error';
    readonly error: CompactError;
};
export type DevPlaybookOutput = {
    readonly status: 'discussion-complete';
} | {
    readonly status: 'complete';
    readonly childPlaybookId: 'code';
    /** The successful result of DEV's final child call, when it has one. */
    readonly childOutput?: JsonValue;
} | {
    readonly status: 'child-failed';
    /** The relayed canonical child result that ended the selected path. */
    readonly childResult: CompletedChildResult;
};
export type DevInput = {
    readonly runResults?: string;
};
export type DevContext = {
    readonly runResults: string;
    readonly developmentRequest?: string;
    readonly discussionExchanges: readonly DiscussionExchange[];
    readonly planningResult?: string;
    readonly decideCommit?: string;
    readonly evaluatedRevision?: string;
    readonly completion?: 'discussion-complete' | 'complete' | 'child-failed';
    readonly childOutput?: JsonValue;
    readonly childFailure?: CompletedChildResult;
    readonly lastError?: unknown;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type DevEvent = {
    readonly type: 'START_DEV';
    readonly developmentRequest: string;
} | {
    readonly type: 'BOSS_REPLY';
    readonly answer: string;
    readonly questionId?: 'planAnalysis';
};
/** Consumed planning Q&A rendered for later relayed discussion context. */
export declare function renderDiscussionContext(exchanges: readonly DiscussionExchange[]): string;
export declare const devMachine: import("xstate").StateMachine<DevContext, {
    readonly type: "START_DEV";
    readonly developmentRequest: string;
} | {
    readonly type: "BOSS_REPLY";
    readonly answer: string;
    readonly questionId?: "planAnalysis";
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<JsonValue | undefined, PlaybookInput, import("xstate").EventObject>> | import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>> | undefined;
}, {
    src: "playbook";
    logic: import("xstate").PromiseActorLogic<JsonValue | undefined, PlaybookInput, import("xstate").EventObject>;
    id: string | undefined;
} | {
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
    type: "startDev";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeDiscussion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCodePath";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberDecidePath";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberDecideResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithChildSuccess";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithInsufficientCodeResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithInsufficientDecideResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithCodeFailure";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithDecideFailure";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "needsBossReply";
    params: unknown;
} | {
    type: "emptyBossReply";
    params: unknown;
} | {
    type: "isDiscussionComplete";
    params: unknown;
} | {
    type: "isCodePath";
    params: unknown;
} | {
    type: "isDecideThenCode";
    params: unknown;
} | {
    type: "isCodeSuccess";
    params: unknown;
} | {
    type: "isDecideSuccess";
    params: unknown;
} | {
    type: "authoredCodeFailure";
    params: unknown;
} | {
    type: "authoredDecideFailure";
    params: unknown;
} | {
    type: "resumesPlanAnalysis";
    params: unknown;
}, never, "done" | "failed" | "awaitBossReply" | "ready" | "planAnalysis" | "callCode" | "callDecide" | "callCodeAfterDecide" | "discussionComplete" | "reportedChildFailure", string, DevInput, {
    readonly status: "discussion-complete";
} | {
    readonly status: "complete";
    readonly childPlaybookId: "code";
    /** The successful result of DEV's final child call, when it has one. */
    readonly childOutput?: JsonValue;
} | {
    readonly status: "child-failed";
    /** The relayed canonical child result that ended the selected path. */
    readonly childResult: CompletedChildResult;
}, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "dev";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly planAnalysis: {
            id: "planAnalysis";
        };
        readonly callCode: {
            id: "callCode";
        };
        readonly callDecide: {
            id: "callDecide";
        };
        readonly callCodeAfterDecide: {
            id: "callCodeAfterDecide";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly failed: {
            id: "failed";
        };
        readonly discussionComplete: {
            id: "discussionComplete";
        };
        readonly done: {
            id: "done";
        };
        readonly reportedChildFailure: {
            id: "reportedChildFailure";
        };
    };
}>;
export default devMachine;
