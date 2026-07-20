export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type EnabledPlaybook = {
    readonly id: string;
    readonly command: string;
    readonly intent: string;
};
export type NormalizedError = {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
};
export type PlaybookStateValue = string | {
    readonly [key: string]: PlaybookStateValue;
};
export type PlaybookState = {
    readonly value: PlaybookStateValue;
    readonly activeStateIds: readonly string[];
    readonly tags: readonly string[];
    readonly status: 'active' | 'done' | 'error' | 'stopped';
    readonly quiescent: boolean;
    readonly stateId?: string;
};
export type CompletedCallResult = {
    readonly playbookId: string;
    readonly status: 'ok';
    readonly output?: JsonValue;
} | {
    readonly playbookId: string;
    readonly status: 'aborted' | 'error';
    readonly error: NormalizedError;
};
export type PendingBossQuestion = {
    readonly questionId: ResumableStateId;
    readonly resumeStateId: ResumableStateId;
    readonly sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3';
    readonly player: 'Captain';
    readonly question: string;
};
export type ResumableStateId = 'routing' | 'reassessing';
export type CaptainMachineInput = {
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    readonly selfPlaybookId: string;
    readonly bossIntent?: string;
};
export type CaptainMachineOutput = {
    readonly response: string;
};
export type CaptainInput = {
    readonly stateId: ResumableStateId;
    readonly sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3';
    readonly prompt: string;
    readonly result: Record<string, string>;
    readonly bossIntent: string;
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    readonly remainingPlan?: readonly JsonValue[];
    readonly completedCallResults?: readonly CompletedCallResult[];
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type CaptainOutput = {
    readonly guard: 'question';
    readonly question: string;
} | {
    readonly guard: 'delegation';
    readonly remainingPlan: readonly JsonValue[];
    readonly nextPlaybookId: string;
    readonly nextPlaybookInput: string;
} | {
    readonly guard: 'final';
    readonly response: string;
} | {
    readonly guard: 'followUpQuestion';
    readonly question: string;
} | {
    readonly guard: 'continuing';
    readonly remainingPlan: readonly JsonValue[];
    readonly nextPlaybookId: string;
    readonly nextPlaybookInput: string;
} | {
    readonly guard: 'needsBossReply';
    readonly question: string;
};
export type PlaybookInput = {
    readonly stateId: 'callPlaybook';
    readonly sourceItem?: 'CAPTAIN-2';
    readonly playbookId: string;
    readonly text: string;
    readonly playbookIdContext: 'nextPlaybookId';
    readonly textContext: 'nextPlaybookInput';
};
export type PlaybookOutput = JsonValue | undefined;
type Context = {
    readonly bossIntent: string;
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    readonly selfPlaybookId: string;
    readonly remainingPlan: readonly JsonValue[];
    readonly completedCallResults: readonly CompletedCallResult[];
    readonly nextPlaybookId: string;
    readonly nextPlaybookInput: string;
    readonly callHistory: readonly string[];
    readonly response?: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
    readonly lastError?: JsonValue;
};
type BossIntentEvent = {
    readonly type: 'BOSS_INTENT';
    readonly bossIntent: string;
};
type BossInterruptEvent = {
    readonly type: 'BOSS_INTERRUPT';
    readonly targetId: 'routing';
    readonly bossIntent: string;
};
type BossReplyEvent = {
    readonly type: 'BOSS_REPLY';
    readonly answer: string;
    readonly questionId?: string;
};
export declare const captainMachine: import("xstate").StateMachine<Context, BossIntentEvent | BossInterruptEvent | BossReplyEvent, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<PlaybookOutput, PlaybookInput, import("xstate").EventObject>> | import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>> | undefined;
}, {
    src: "playbook";
    logic: import("xstate").PromiseActorLogic<PlaybookOutput, PlaybookInput, import("xstate").EventObject>;
    id: string | undefined;
} | {
    src: "captain";
    logic: import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>;
    id: string | undefined;
}, {
    type: "startRoutingFromBoss";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "storeBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberInvalidBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setRoutingQuestion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "storeRoutingDelegation";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "appendSuccessfulChildResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "appendRejectedChildResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "storeFinalResponse";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setReassessQuestion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "storeContinuingCall";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberInvalidActorOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberActorError";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "isRoutingInterrupt";
    params: unknown;
} | {
    type: "canResumeRouting";
    params: unknown;
} | {
    type: "canResumeReassessing";
    params: unknown;
} | {
    type: "hasBossIntent";
    params: unknown;
} | {
    type: "isRoutingQuestion";
    params: unknown;
} | {
    type: "isRoutingDelegation";
    params: unknown;
} | {
    type: "isReassessFinal";
    params: unknown;
} | {
    type: "isReassessQuestion";
    params: unknown;
} | {
    type: "isReassessContinuing";
    params: unknown;
} | {
    type: "isPlaybookSuccessOutput";
    params: unknown;
} | {
    type: "isAuthoredChildError";
    params: unknown;
}, never, "done" | "failed" | "callPlaybook" | "awaitBossReply" | "ready" | "routing" | "reassessing", string, CaptainMachineInput, CaptainMachineOutput, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "captain";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly routing: {
            id: "routing";
        };
        readonly callPlaybook: {
            id: "callPlaybook";
        };
        readonly reassessing: {
            id: "reassessing";
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
