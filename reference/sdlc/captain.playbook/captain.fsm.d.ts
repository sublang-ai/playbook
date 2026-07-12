export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type EnabledPlaybook = {
    readonly id: string;
    readonly command: string;
    readonly intent: string;
};
export type PendingBossQuestion = {
    readonly questionId: string;
    readonly resumeStateId: ResumableStateId;
    readonly sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3';
    readonly player: 'Captain';
    readonly question: string;
};
export type CaptainInput = {
    readonly stateId: ResumableStateId;
    readonly sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3';
    readonly prompt: string;
    readonly result: Readonly<Record<string, string>>;
    readonly bossIntent: string;
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    readonly remainingPlan?: readonly JsonValue[];
    readonly completedCallResults?: readonly CompletedCallResult[];
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type CaptainOutput = {
    readonly guard: 'direct';
    readonly response: string;
} | {
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
    readonly stateId: 'callingPlaybook';
    readonly sourceItem?: 'CAPTAIN-2';
    readonly playbookId: string;
    readonly text: string;
    readonly playbookIdContext: 'nextPlaybookId';
    readonly textContext: 'nextPlaybookInput';
};
export type PlaybookOutput = JsonValue | undefined;
export type CompactError = {
    readonly name: string;
    readonly message: string;
};
export type CompletedCallResult = {
    readonly playbookId: string;
    readonly status: 'ok';
    readonly output?: JsonValue;
} | {
    readonly playbookId: string;
    readonly status: 'aborted' | 'error';
    readonly error: CompactError;
};
export type CaptainMachineInput = {
    readonly selfPlaybookId: string;
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
};
export type CaptainMachineOutput = {
    readonly response: string;
};
type ResumableStateId = 'routing' | 'reassessing';
type CaptainContext = {
    readonly selfPlaybookId: string;
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    bossIntent?: string;
    remainingPlan: readonly JsonValue[];
    completedCallResults: readonly CompletedCallResult[];
    nextPlaybookId?: string;
    nextPlaybookInput?: string;
    callSignatures: readonly string[];
    response?: string;
    pendingBossQuestion?: PendingBossQuestion;
    bossReply?: string;
    bossReplyActive: boolean;
    lastError?: CompactError & {
        readonly stack?: string;
    };
};
export declare const captainMachine: import("xstate").StateMachine<CaptainContext, {
    readonly type: "BOSS_INTENT";
    readonly bossIntent: string;
} | {
    readonly type: "BOSS_INTERRUPT";
    readonly targetId: "routing";
    readonly bossIntent: string;
} | {
    readonly type: "BOSS_REPLY";
    readonly answer: string;
    readonly questionId?: string;
}, {
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
    type: "setInterruptedIntent";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setBossIntent";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberResponse";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberPlannedCall";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setRoutingQuestion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setReassessmentQuestion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "clearBossReplyContext";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "appendSuccessfulCall";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "appendAuthoredChildFailure";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCaptainError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberPlaybookError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberInvalidCall";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberInvalidBossReply";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "followUpQuestion";
    params: unknown;
} | {
    type: "routingDirect";
    params: unknown;
} | {
    type: "routingQuestion";
    params: unknown;
} | {
    type: "routingDelegation";
    params: unknown;
} | {
    type: "routingNeedsBossReply";
    params: unknown;
} | {
    type: "finalResponse";
    params: unknown;
} | {
    type: "continuingCall";
    params: unknown;
} | {
    type: "reassessmentNeedsBossReply";
    params: unknown;
} | {
    type: "validChildOutput";
    params: unknown;
} | {
    type: "authoredChildFailure";
    params: unknown;
} | {
    type: "hasTerminalResponse";
    params: unknown;
} | {
    type: "validBossIntent";
    params: unknown;
}, never, "done" | "failed" | "routing" | "reassessing" | "callingPlaybook" | "ready" | "finishing" | "awaitBossReply", string, CaptainMachineInput, CaptainMachineOutput, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "captain";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly routing: {
            id: "routing";
        };
        readonly callingPlaybook: {
            id: "callingPlaybook";
        };
        readonly reassessing: {
            id: "reassessing";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly finishing: {
            id: "finishing";
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
