type Player = 'Coder' | 'Reviewer' | 'Committer';
type JumpableStateId = 'ready' | 'planAndImplement' | 'respondToReview' | 'continueIr' | 'summarizeSpecs' | 'reviewBossCommitSpecs' | 'reviewBossCommitCode' | 'reviewBossCommitMixed' | 'reviewIrTaskCommitSpecs' | 'reviewIrTaskCommitCode' | 'reviewIrTaskCommitMixed' | 'reviewChangesSpecs' | 'reviewChangesCode' | 'reviewChangesMixed' | 'reviewChangesAndChallengesSpecs' | 'reviewChangesAndChallengesCode' | 'reviewChangesAndChallengesMixed' | 'adjudicateChallenges' | 'commitCoderInitial' | 'commitJoint' | 'failed';
type WorkflowKind = 'singleCommit' | 'iteration' | 'specSummary';
type ChangeOrigin = 'bossIntent' | 'irTask';
type ReviewSubject = 'commit' | 'changes';
type AfterReview = 'continueIr' | 'summarizeSpecs' | 'done';
export type CaptainInput = {
    player: Player;
    sourceItem: string;
    prompt: string;
    result: Record<string, string>;
    intent?: string;
    irNumber?: string;
    taskDescription?: string;
    reviews?: string;
    challenges?: string;
    coderPlayer?: string;
    reviewerPlayer?: string;
};
export type CaptainOutput = {
    guard: string;
    irNumber?: string;
    taskDescription?: string;
    reviews?: string;
    challenges?: string;
    summary?: string;
    [k: string]: unknown;
};
export type CodingInput = {
    intent?: string;
    irNumber?: string;
    coderPlayer?: string;
    reviewerPlayer?: string;
    committerPlayer?: string;
};
export type CodingContext = CodingInput & {
    workflow?: WorkflowKind;
    changeOrigin?: ChangeOrigin;
    reviewSubject?: ReviewSubject;
    afterReview?: AfterReview;
    taskDescription?: string;
    reviews?: string;
    challenges?: string;
    lastResult?: CaptainOutput;
    lastError?: unknown;
};
export type CodingEvent = {
    type: 'START_CODING';
    intent: string;
} | {
    type: 'CONTINUE_IR';
    irNumber: string;
} | {
    type: 'SUMMARIZE_IR';
    irNumber: string;
} | {
    type: 'BOSS_INTERRUPT';
    targetId: JumpableStateId;
    intent?: string;
    irNumber?: string;
};
export declare const codingMachine: import("xstate").StateMachine<CodingContext, {
    type: "START_CODING";
    intent: string;
} | {
    type: "CONTINUE_IR";
    irNumber: string;
} | {
    type: "SUMMARIZE_IR";
    irNumber: string;
} | {
    type: "BOSS_INTERRUPT";
    targetId: JumpableStateId;
    intent?: string;
    irNumber?: string;
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>> | undefined;
}, {
    src: "captain";
    logic: import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>;
    id: string | undefined;
}, never, never, never, {}, string, CodingInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    states?: {} | undefined;
    id?: string | undefined | undefined;
}>;
export {};
