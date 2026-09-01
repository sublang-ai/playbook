export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type CodeStateId = 'runFirstPhase' | 'reviewFirstCommit' | 'runIrTask' | 'reviewIrTask';
export type CodeSourceItem = 'CODE-1' | 'CODE-2' | 'CODE-3' | 'CODE-4';
export type CodePhase = 'direct' | 'ir-created' | 'ir-task-more' | 'ir-task-final';
export type PendingBossQuestion = {
    readonly questionId: 'runFirstPhase' | 'runIrTask';
    readonly resumeStateId: 'runFirstPhase' | 'runIrTask';
    readonly sourceItem: 'CODE-1' | 'CODE-3';
    readonly asker: {
        readonly kind: 'role';
        readonly roleId: 'coder';
    };
    readonly question: string;
};
export type PlayerInput = {
    readonly stateId: 'runFirstPhase' | 'runIrTask';
    readonly role: 'coder';
    readonly sourceItem: 'CODE-1' | 'CODE-3';
    readonly prompt: string;
    readonly result: Readonly<Record<string, string>>;
    readonly callerInput: string;
    readonly runResults: string;
    readonly irNumber?: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
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
export type PlaybookInput = {
    readonly stateId: 'reviewFirstCommit' | 'reviewIrTask';
    readonly sourceItem: 'CODE-2' | 'CODE-4';
    readonly playbookId: 'review';
    readonly text: string;
};
export type ReviewOutput = {
    readonly noUnsettledFindings: true;
    /**
     * Exact repository revision at which the review scope was evaluated:
     * the last review-fix commit when one landed, otherwise the clean
     * round's receipt-observed HEAD (DR-045). Always present.
     */
    readonly evaluatedRevision: string;
};
export type CompactError = {
    readonly name: string;
    readonly message: string;
};
export type CodePlaybookOutput = {
    readonly status: 'complete';
    /** Exact identity of the last CODE-owned commit. */
    readonly lastCodeCommit: string;
    /** Exact repository revision the final passing review evaluated. */
    readonly finalEvaluatedRevision: string;
    /** Every phase's review passed with no unsettled findings. */
    readonly allReviewsPassed: true;
} | {
    readonly status: 'review-failed';
    /** Exact identity of the last CODE-owned commit. */
    readonly lastCodeCommit: string;
    readonly error: CompactError;
};
export type CodingInput = {
    readonly runResults?: string;
};
export type CodingContext = {
    readonly runResults: string;
    readonly callerInput?: string;
    readonly coderOutput?: string;
    readonly latestCommit?: string;
    readonly irNumber?: string;
    readonly irTask?: string;
    readonly evaluatedRevision?: string;
    readonly phase?: CodePhase;
    readonly completion?: 'complete' | 'review-failed';
    readonly reviewError?: CompactError;
    readonly lastError?: unknown;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type CodingEvent = {
    readonly type: 'START_CODE';
    readonly callerInput: string;
} | {
    readonly type: 'BOSS_REPLY';
    readonly answer: string;
    readonly questionId?: 'runFirstPhase' | 'runIrTask';
};
export declare const codingMachine: import("xstate").StateMachine<CodingContext, {
    readonly type: "START_CODE";
    readonly callerInput: string;
} | {
    readonly type: "BOSS_REPLY";
    readonly answer: string;
    readonly questionId?: "runFirstPhase" | "runIrTask";
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
    type: "startCoding";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberDirectCommit";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberIrCommit";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMoreTasks";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberFinalTask";
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
    type: "completeSuccessfully";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithReviewFailure";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithInvalidReviewOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedPlayerOutput";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "needsBossReply";
    params: unknown;
} | {
    type: "isDirectCommit";
    params: unknown;
} | {
    type: "isIrCommit";
    params: unknown;
} | {
    type: "isMoreTasks";
    params: unknown;
} | {
    type: "isFinalTask";
    params: unknown;
} | {
    type: "authoredReviewFailure";
    params: unknown;
} | {
    type: "reviewApprovedDirect";
    params: unknown;
} | {
    type: "reviewApprovedIrCreated";
    params: unknown;
} | {
    type: "reviewApprovedMoreTasks";
    params: unknown;
} | {
    type: "reviewApprovedFinalTask";
    params: unknown;
} | {
    type: "emptyBossReply";
    params: unknown;
} | {
    type: "resumesFirstPhase";
    params: unknown;
} | {
    type: "resumesIrTask";
    params: unknown;
}, never, "done" | "failed" | "awaitBossReply" | "ready" | "runFirstPhase" | "reviewFirstCommit" | "runIrTask" | "reviewIrTask" | "reportedReviewFailure", string, CodingInput, {
    readonly status: "complete";
    /** Exact identity of the last CODE-owned commit. */
    readonly lastCodeCommit: string;
    /** Exact repository revision the final passing review evaluated. */
    readonly finalEvaluatedRevision: string;
    /** Every phase's review passed with no unsettled findings. */
    readonly allReviewsPassed: true;
} | {
    readonly status: "review-failed";
    /** Exact identity of the last CODE-owned commit. */
    readonly lastCodeCommit: string;
    readonly error: CompactError;
}, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "code";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly runFirstPhase: {
            id: "runFirstPhase";
        };
        readonly reviewFirstCommit: {
            id: "reviewFirstCommit";
        };
        readonly runIrTask: {
            id: "runIrTask";
        };
        readonly reviewIrTask: {
            id: "reviewIrTask";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly failed: {
            id: "failed";
        };
        readonly reportedReviewFailure: {
            id: "reportedReviewFailure";
        };
        readonly done: {
            id: "done";
        };
    };
}>;
export default codingMachine;
