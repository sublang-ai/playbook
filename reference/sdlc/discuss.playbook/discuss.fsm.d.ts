type Player = 'Host' | 'Participant' | 'Committer';
type ReviewScope = 'specItems' | 'decisionRecords' | 'mixed';
type JumpableStateId = 'ready' | 'initialProposalRound' | 'reconciliationRound' | 'hostWritesAgreement' | 'commitInitialChanges' | 'reviewSpecInitialCommit' | 'reviewSpecHostChanges' | 'reviewDrInitialCommit' | 'reviewDrHostChanges' | 'reviewMixedInitialCommit' | 'reviewMixedHostChanges' | 'hostAddressesFindings' | 'participantAddressesRebuttals' | 'commitReviewedChanges' | 'failed';
type ResumableStateId = 'askHostInitial' | 'askParticipantInitial' | 'hostInitialRound' | 'participantInitialRound' | Exclude<JumpableStateId, 'ready' | 'initialProposalRound' | 'reconciliationRound' | 'failed'>;
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
export interface DiscussContext {
    hostPlayer?: string;
    participantPlayer?: string;
    committerPlayer?: string;
    topic?: string;
    hostLlm?: string;
    participantLlm?: string;
    hostProposal?: string;
    participantProposal?: string;
    agreement?: string;
    latestChanges?: string;
    reviewScope?: ReviewScope;
    reviewItems?: string;
    rebuttals?: string;
    lastResult?: PlayerOutput;
    lastError?: unknown;
    pendingBossQuestions?: PendingBossQuestions;
    bossReplies?: BossReplies;
    stagedHostResult?: PlayerOutput;
    stagedParticipantResult?: PlayerOutput;
}
export type DiscussEvent = {
    type: 'START_DISCUSSION';
    topic: string;
    hostLlm?: string;
    participantLlm?: string;
} | {
    type: 'START_REVIEW';
    latestChanges: string;
    reviewScope: ReviewScope;
    rebuttals?: string;
} | {
    type: 'BOSS_INTERRUPT';
    targetId: JumpableStateId;
} | {
    type: 'BOSS_REPLY';
    questionId?: ResumableStateId;
    answer: string;
};
export interface DiscussInput {
    host?: string;
    participant?: string;
    committer?: string;
}
export interface PlayerInput {
    stateId: ResumableStateId;
    sourceItem: string;
    prompt: string;
    result: Record<string, string>;
    player: Player;
    topic?: string;
    hostLlm?: string;
    participantLlm?: string;
    hostProposal?: string;
    participantProposal?: string;
    agreement?: string;
    latestChanges?: string;
    reviewScope?: ReviewScope;
    reviewItems?: string;
    rebuttals?: string;
    hostPlayer?: string;
    participantPlayer?: string;
    committerPlayer?: string;
    pendingBossQuestion?: PendingBossQuestion;
    bossReply?: string;
}
type AdditionalPlayerFields = {
    proposal?: string;
    agreement?: string;
    latestChanges?: string;
    reviewScope?: ReviewScope;
    reviewItems?: string;
    rebuttals?: string;
    question?: string;
    readonly [key: string]: unknown;
};
export type PlayerOutput = ({
    guard: 'proposalMade';
    proposal: string;
} & AdditionalPlayerFields) | ({
    guard: 'endedInitialDiscussion';
    agreement?: string;
} & AdditionalPlayerFields) | ({
    guard: 'wroteChanges';
    latestChanges: string;
    reviewScope: ReviewScope;
} & AdditionalPlayerFields) | ({
    guard: 'committed';
    latestChanges?: string;
    reviewScope?: ReviewScope;
} & AdditionalPlayerFields) | ({
    guard: 'noFindings';
} & AdditionalPlayerFields) | ({
    guard: 'findingsRaised';
    reviewItems: string;
} & AdditionalPlayerFields) | ({
    guard: 'changesMade';
    latestChanges?: string;
    reviewScope?: ReviewScope;
} & AdditionalPlayerFields) | ({
    guard: 'rebuttalsRaised';
    rebuttals: string;
} & AdditionalPlayerFields) | ({
    guard: 'rebuttalsAddressed';
    rebuttals?: string;
} & AdditionalPlayerFields) | ({
    guard: 'needsBossReply';
    question: string;
} & AdditionalPlayerFields);
type DiscussActionName = 'copyStartDiscussion' | 'copyStartReview' | 'rememberHostProposal' | 'rememberParticipantProposal' | 'rememberAgreement' | 'rememberWrittenChanges' | 'rememberCommittedChanges' | 'rememberReviewFindings' | 'rememberHostReviewResponse' | 'rememberParticipantRebuttalResponse' | 'rememberCaptainResult' | 'rememberCaptainError' | 'rememberMalformedCaptainOutput' | 'rememberMalformedBossReply' | 'setPendingBossQuestion' | 'rememberBossReply' | 'clearBranchBossReplyContext' | 'clearParallelRoundContext' | 'clearBossReplyContext';
declare function bossInterrupts(ids: readonly JumpableStateId[], actions?: DiscussActionName | DiscussActionName[]): any[];
declare function resumableStates(ids: readonly string[]): any[];
export declare const discussMachine: import("xstate").StateMachine<DiscussContext, {
    type: "START_DISCUSSION";
    topic: string;
    hostLlm?: string;
    participantLlm?: string;
} | {
    type: "START_REVIEW";
    latestChanges: string;
    reviewScope: ReviewScope;
    rebuttals?: string;
} | {
    type: "BOSS_INTERRUPT";
    targetId: JumpableStateId;
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
    type: "copyStartDiscussion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "copyStartReview";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberHostProposal";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberParticipantProposal";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberAgreement";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberWrittenChanges";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCommittedChanges";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberReviewFindings";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberHostReviewResponse";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberParticipantRebuttalResponse";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCaptainResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCaptainError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedCaptainOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setPendingBossQuestion";
    params: PendingBossQuestionParams;
} | {
    type: "rememberBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "clearBranchBossReplyContext";
    params: {
        stateId: ResumableStateId;
    };
} | {
    type: "clearParallelRoundContext";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "clearBossReplyContext";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "stageHostResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "stageParticipantResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "promoteInitialResults";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "promoteReconciliationResults";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "noFindings";
    params: unknown;
} | {
    type: "committed";
    params: unknown;
} | {
    type: "proposalMade";
    params: unknown;
} | {
    type: "endedInitialDiscussion";
    params: unknown;
} | {
    type: "wroteChanges";
    params: unknown;
} | {
    type: "findingsRaised";
    params: unknown;
} | {
    type: "changesMade";
    params: unknown;
} | {
    type: "rebuttalsRaised";
    params: unknown;
} | {
    type: "rebuttalsAddressed";
    params: unknown;
} | {
    type: "needsBossReplyWithQuestion";
    params: unknown;
} | {
    type: "needsBossReplyWithoutQuestion";
    params: unknown;
} | {
    type: "emptyBossReply";
    params: unknown;
} | {
    type: "bothEndedInitialDiscussion";
    params: unknown;
} | {
    type: "specReview";
    params: unknown;
} | {
    type: "drReview";
    params: unknown;
} | {
    type: "mixedReview";
    params: unknown;
}, never, "done" | "failed" | "ready" | "awaitBossReply" | "hostWritesAgreement" | "commitInitialChanges" | "reviewSpecInitialCommit" | "reviewSpecHostChanges" | "reviewDrInitialCommit" | "reviewDrHostChanges" | "reviewMixedInitialCommit" | "reviewMixedHostChanges" | "hostAddressesFindings" | "participantAddressesRebuttals" | "commitReviewedChanges" | {
    initialProposalRound: {
        host: "working" | "waiting" | "complete";
        participant: "working" | "waiting" | "complete";
    };
} | {
    reconciliationRound: {
        host: "working" | "waiting" | "complete";
        participant: "working" | "waiting" | "complete";
    };
}, string, DiscussInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "discuss";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly initialProposalRound: {
            id: "initialProposalRound";
            states: {
                readonly host: {
                    id: "initialProposalHost";
                    states: {
                        readonly working: {
                            id: "askHostInitial";
                        };
                        readonly waiting: {
                            id: "waitHostInitialReply";
                        };
                        readonly complete: {
                            id: "hostInitialProposalComplete";
                        };
                    };
                };
                readonly participant: {
                    id: "initialProposalParticipant";
                    states: {
                        readonly working: {
                            id: "askParticipantInitial";
                        };
                        readonly waiting: {
                            id: "waitParticipantInitialReply";
                        };
                        readonly complete: {
                            id: "participantInitialProposalComplete";
                        };
                    };
                };
            };
        };
        readonly reconciliationRound: {
            id: "reconciliationRound";
            states: {
                readonly host: {
                    id: "reconciliationHost";
                    states: {
                        readonly working: {
                            id: "hostInitialRound";
                        };
                        readonly waiting: {
                            id: "waitHostReconciliationReply";
                        };
                        readonly complete: {
                            id: "hostReconciliationComplete";
                        };
                    };
                };
                readonly participant: {
                    id: "reconciliationParticipant";
                    states: {
                        readonly working: {
                            id: "participantInitialRound";
                        };
                        readonly waiting: {
                            id: "waitParticipantReconciliationReply";
                        };
                        readonly complete: {
                            id: "participantReconciliationComplete";
                        };
                    };
                };
            };
        };
        readonly hostWritesAgreement: {
            id: "hostWritesAgreement";
        };
        readonly commitInitialChanges: {
            id: "commitInitialChanges";
        };
        readonly reviewSpecInitialCommit: {
            id: "reviewSpecInitialCommit";
        };
        readonly reviewSpecHostChanges: {
            id: "reviewSpecHostChanges";
        };
        readonly reviewDrInitialCommit: {
            id: "reviewDrInitialCommit";
        };
        readonly reviewDrHostChanges: {
            id: "reviewDrHostChanges";
        };
        readonly reviewMixedInitialCommit: {
            id: "reviewMixedInitialCommit";
        };
        readonly reviewMixedHostChanges: {
            id: "reviewMixedHostChanges";
        };
        readonly hostAddressesFindings: {
            id: "hostAddressesFindings";
        };
        readonly participantAddressesRebuttals: {
            id: "participantAddressesRebuttals";
        };
        readonly commitReviewedChanges: {
            id: "commitReviewedChanges";
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
export { bossInterrupts, resumableStates };
export default discussMachine;
