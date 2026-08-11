export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
type Player = 'Coder' | 'Reviewer';
type JumpableStateId = 'independentProposals';
type ResumableStateId = 'askCoderProposal' | 'askReviewerProposal' | 'commitCoderProposal';
export interface PendingBossQuestion {
    questionId: ResumableStateId;
    resumeStateId: ResumableStateId;
    sourceItem: string;
    player: Player;
    question: string;
}
type PendingBossQuestions = Partial<Record<ResumableStateId, PendingBossQuestion>>;
type BossReplies = Partial<Record<ResumableStateId, string>>;
type PendingBossQuestionParams = Omit<PendingBossQuestion, 'questionId'>;
export interface ReviewSuccessOutput {
    approvedCommit: 'latest';
    noUnsettledFindings: true;
}
export interface DecideFailureOutput {
    lastDecideCommit: string;
    noUnsettledFindings: false;
    reviewStatus: 'aborted' | 'error';
    error?: {
        name: string;
        message: string;
    };
}
export type DecideOutput = ReviewSuccessOutput | DecideFailureOutput;
interface ChildFailure {
    status: 'aborted' | 'error';
    playbookId: 'review';
    error?: {
        name: string;
        message: string;
    };
}
export interface DecideContext {
    coderLlm: string;
    callerTopic?: string;
    coderProposal?: string;
    reviewerProposal?: string;
    latestCommit?: string;
    reviewResult?: ReviewSuccessOutput;
    reviewFailure?: ChildFailure;
    lastResult?: PlayerOutput;
    lastError?: unknown;
    pendingBossQuestions?: PendingBossQuestions;
    bossReplies?: BossReplies;
    stagedCoderResult?: PlayerOutput;
    stagedReviewerResult?: PlayerOutput;
}
export type DecideEvent = {
    type: 'START_DECIDE';
    callerTopic: string;
} | {
    type: 'BOSS_INTERRUPT';
    targetId: JumpableStateId;
    bossIntent: string;
} | {
    type: 'BOSS_REPLY';
    questionId?: ResumableStateId;
    answer: string;
};
export interface DecideInput {
    coderLlm: string;
}
export interface PlayerInput {
    stateId: ResumableStateId;
    sourceItem: string;
    prompt: string;
    result: Record<string, string>;
    player: Player;
    callerTopic?: string;
    coderLlm?: string;
    pendingBossQuestion?: PendingBossQuestion;
    bossReply?: string;
}
type AdditionalPlayerFields = {
    coderProposal?: string;
    reviewerProposal?: string;
    latestCommit?: string;
    question?: string;
    readonly [key: string]: unknown;
};
export type PlayerOutput = ({
    guard: 'proposed';
    coderProposal: string;
} & AdditionalPlayerFields) | ({
    guard: 'proposed';
    reviewerProposal: string;
} & AdditionalPlayerFields) | ({
    guard: 'committed';
    latestCommit: string;
} & AdditionalPlayerFields) | ({
    guard: 'needsBossReply';
    question: string;
} & AdditionalPlayerFields);
export interface PlaybookInput {
    stateId: 'reviewCommit';
    sourceItem: 'DECIDE-4';
    playbookId: 'review';
    text: string;
}
export declare const decideMachine: import("xstate").StateMachine<DecideContext, {
    type: "START_DECIDE";
    callerTopic: string;
} | {
    type: "BOSS_INTERRUPT";
    targetId: JumpableStateId;
    bossIntent: string;
} | {
    type: "BOSS_REPLY";
    questionId?: ResumableStateId;
    answer: string;
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
    type: "rememberActorError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "clearBossReplyContext";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "copyInterruptedTopic";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "copyStartTopic";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "stageCoderProposal";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "stageReviewerProposal";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "promoteProposals";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCommit";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberReviewSuccess";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberReviewFailure";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberReviewProtocolFailure";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedActorOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setPendingBossQuestion";
    params: PendingBossQuestionParams;
} | {
    type: "clearBranchBossReplyContext";
    params: {
        stateId: ResumableStateId;
    };
} | {
    type: "clearProposalRoundContext";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "authoredReviewFailure";
    params: unknown;
} | {
    type: "committed";
    params: unknown;
} | {
    type: "coderProposed";
    params: unknown;
} | {
    type: "reviewerProposed";
    params: unknown;
} | {
    type: "needsBossReplyWithQuestion";
    params: unknown;
} | {
    type: "needsBossReplyWithoutQuestion";
    params: unknown;
} | {
    type: "validReviewSuccess";
    params: unknown;
}, never, "done" | "failed" | "awaitBossReply" | "ready" | "commitCoderProposal" | "reviewCommit" | "reportedReviewFailure" | {
    independentProposals: {
        coder: "complete" | "working" | "waiting";
        reviewer: "complete" | "working" | "waiting";
    };
}, string, DecideInput, ReviewSuccessOutput | DecideFailureOutput, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "decide";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly independentProposals: {
            id: "independentProposals";
            states: {
                readonly coder: {
                    states: {
                        readonly working: {
                            id: "askCoderProposal";
                        };
                        readonly waiting: {
                            id: "waitCoderProposalReply";
                        };
                        readonly complete: {};
                    };
                };
                readonly reviewer: {
                    states: {
                        readonly working: {
                            id: "askReviewerProposal";
                        };
                        readonly waiting: {
                            id: "waitReviewerProposalReply";
                        };
                        readonly complete: {};
                    };
                };
            };
        };
        readonly commitCoderProposal: {
            id: "commitCoderProposal";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly reviewCommit: {
            id: "reviewCommit";
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
export default decideMachine;
