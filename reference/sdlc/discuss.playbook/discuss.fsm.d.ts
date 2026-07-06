type Player = 'Host' | 'Participant' | 'Committer';
type ReviewScope = 'specItems' | 'decisionRecords' | 'mixed';
type JumpableStateId = 'ready' | 'askHostInitial' | 'askParticipantInitial' | 'hostInitialRound' | 'participantInitialRound' | 'hostWritesAgreement' | 'commitInitialChanges' | 'reviewSpecInitialCommit' | 'reviewSpecHostChanges' | 'reviewDrInitialCommit' | 'reviewDrHostChanges' | 'reviewMixedInitialCommit' | 'reviewMixedHostChanges' | 'hostAddressesFindings' | 'participantAddressesRebuttals' | 'commitReviewedChanges' | 'awaitBossReply' | 'failed';
type ResumableStateId = Exclude<JumpableStateId, 'ready' | 'awaitBossReply' | 'failed'>;
export interface PendingBossQuestion {
    resumeStateId: ResumableStateId;
    sourceItem: string;
    player: Player;
    question: string;
}
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
    lastResult?: CaptainOutput;
    lastError?: unknown;
    pendingBossQuestion?: PendingBossQuestion;
    bossReply?: string;
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
    answer: string;
};
export interface DiscussInput {
    host?: string;
    participant?: string;
    committer?: string;
}
export interface CaptainInput {
    player: Player;
    sourceItem: string;
    prompt: string;
    result: Record<string, string>;
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
export interface CaptainOutput {
    guard: string;
    proposal?: string;
    agreement?: string;
    latestChanges?: string;
    reviewScope?: ReviewScope;
    reviewItems?: string;
    rebuttals?: string;
    question?: string;
    [key: string]: unknown;
}
type DiscussActionName = 'copyStartDiscussion' | 'copyStartReview' | 'rememberHostProposal' | 'rememberParticipantProposal' | 'rememberAgreement' | 'rememberWrittenChanges' | 'rememberCommittedChanges' | 'rememberReviewFindings' | 'rememberHostReviewResponse' | 'rememberParticipantRebuttalResponse' | 'rememberCaptainResult' | 'rememberCaptainError' | 'rememberMalformedCaptainOutput' | 'rememberMalformedBossReply' | 'setPendingBossQuestion' | 'rememberBossReply' | 'clearBossReplyContext';
declare function bossInterrupts(ids: readonly string[], actions?: DiscussActionName | DiscussActionName[]): any[];
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
    answer: string;
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>> | undefined;
}, {
    src: "captain";
    logic: import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>;
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
    params: PendingBossQuestion;
} | {
    type: "rememberBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "clearBossReplyContext";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "noFindings";
    params: unknown;
} | {
    type: "committed";
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
    type: "specReview";
    params: unknown;
} | {
    type: "drReview";
    params: unknown;
} | {
    type: "mixedReview";
    params: unknown;
}, never, "ready" | "failed" | "done" | "awaitBossReply" | "askHostInitial" | "askParticipantInitial" | "hostInitialRound" | "participantInitialRound" | "hostWritesAgreement" | "commitInitialChanges" | "reviewSpecInitialCommit" | "reviewSpecHostChanges" | "reviewDrInitialCommit" | "reviewDrHostChanges" | "reviewMixedInitialCommit" | "reviewMixedHostChanges" | "hostAddressesFindings" | "participantAddressesRebuttals" | "commitReviewedChanges", string, DiscussInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "discuss";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly askHostInitial: {
            id: "askHostInitial";
        };
        readonly askParticipantInitial: {
            id: "askParticipantInitial";
        };
        readonly hostInitialRound: {
            id: "hostInitialRound";
        };
        readonly participantInitialRound: {
            id: "participantInitialRound";
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
