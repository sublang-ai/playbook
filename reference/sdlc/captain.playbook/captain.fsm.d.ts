export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export interface EnabledPlaybook {
    readonly id: string;
    readonly command: string;
    readonly intent: string;
}
export interface PendingBossQuestion {
    readonly questionId: ResumableStateId;
    readonly resumeStateId: ResumableStateId;
    readonly sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3';
    readonly player: 'Captain';
    readonly question: string;
}
type RoutingResult = {
    readonly direct: string;
    readonly question: string;
    readonly delegation: string;
    readonly needsBossReply: string;
};
type ReassessmentResult = {
    readonly final: string;
    readonly followUpQuestion: string;
    readonly continuing: string;
    readonly needsBossReply: string;
};
interface CaptainInputBase {
    readonly stateId: ResumableStateId;
    readonly sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3';
    readonly prompt: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
}
export type CaptainInput = (CaptainInputBase & {
    readonly stateId: 'routing';
    readonly sourceItem: 'CAPTAIN-1';
    readonly result: RoutingResult;
    readonly bossIntent: string;
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
}) | (CaptainInputBase & {
    readonly stateId: 'reassessment';
    readonly sourceItem: 'CAPTAIN-3';
    readonly result: ReassessmentResult;
    readonly bossIntent: string;
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    readonly remainingPlan: readonly JsonValue[];
    readonly completedCallResults: readonly CompletedCallResult[];
});
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
export interface PlaybookInput {
    readonly stateId: 'callPlaybook';
    readonly sourceItem?: 'CAPTAIN-2';
    readonly playbookId: string;
    readonly text: string;
    readonly playbookIdContext: 'nextPlaybookId';
    readonly textContext: 'nextPlaybookInput';
}
export type PlaybookOutput = JsonValue | undefined;
export interface CaptainMachineInput {
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    readonly selfPlaybookId: string;
}
export type CaptainMachineOutput = {
    readonly response: string;
};
type CompactError = {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
};
type CompletedCallResult = {
    readonly playbookId: string;
    readonly status: 'ok';
    readonly output?: JsonValue;
} | {
    readonly playbookId: string;
    readonly status: 'aborted' | 'error';
    readonly error: {
        readonly name: string;
        readonly message: string;
    };
};
type ResumableStateId = 'routing' | 'reassessment';
type CaptainContext = {
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    readonly selfPlaybookId: string;
    readonly bossIntent: string;
    readonly remainingPlan: readonly JsonValue[];
    readonly completedCallResults: readonly CompletedCallResult[];
    readonly callSignatures: readonly string[];
    readonly nextPlaybookId: string;
    readonly nextPlaybookInput: string;
    readonly response: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
    readonly lastError?: CompactError;
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
    type: "restartWithFreshIntent";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberDirectResponse";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberPlannedCall";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setRoutingPendingBossQuestion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "setReassessmentPendingBossQuestion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "appendChildSuccess";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "appendChildError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberCaptainError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedResult";
    params: import("xstate").NonReducibleUnknown;
}, never, never, "done" | "failed" | "callPlaybook" | "routing" | "reassessment" | "ready" | "awaitBossReply", string, CaptainMachineInput, CaptainMachineOutput, import("xstate").EventObject, import("xstate").MetaObject, {
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
        readonly reassessment: {
            id: "reassessment";
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
