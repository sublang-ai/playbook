/**
 * Machine construction input. The caller-supplied inspection request and any
 * relevant discussion context are delivered through the Boss entry event; an
 * optional seed may ride along at construction. No agent call runs before the
 * first Boss-originated event.
 */
export interface InspectInput {
    inspectionRequest?: string;
    discussionContext?: string;
}
/**
 * Terminal workflow output returned to the caller. Source declares two terminal
 * returns: `{ status: 'complete', report }` and `{ status: 'unavailable', report }`.
 */
export type MachineOutput = {
    status: 'complete';
    report: string;
} | {
    status: 'unavailable';
    report: string;
};
/** Standard suspended-question record carried while awaiting a Boss reply. */
export interface PendingBossQuestion {
    questionId: string;
    resumeStateId: string;
    sourceItem: string;
    asker: {
        kind: 'captain';
    } | {
        kind: 'role';
        roleId: string;
    };
    question: string;
}
/** Typed input for the delegated `player` (Inspector) actor. */
export interface PlayerInput {
    stateId: string;
    role: 'inspector';
    sourceItem: string;
    prompt: string;
    inspectionRequest: string;
    discussionContext: string;
    pendingBossQuestion?: PendingBossQuestion;
    bossReply?: string;
    result: Record<'completed' | 'unavailable' | 'needsBossReply', string>;
}
/** Discriminated result contract the Inspector actor returns. */
export type PlayerOutput = {
    guard: 'completed';
    status: string;
    report: string;
} | {
    guard: 'unavailable';
    status: string;
    report: string;
} | {
    guard: 'needsBossReply';
    question: string;
};
interface LastError {
    name: string;
    message: string;
    stack?: string;
}
interface InspectContext {
    inspectionRequest: string;
    discussionContext: string;
    report: string;
    status: 'complete' | 'unavailable' | null;
    lastError: LastError | null;
    pendingBossQuestion: PendingBossQuestion | null;
    bossReply: string | null;
}
interface AcceptedOutcomeParams {
    source: string;
    target: string;
    acceptedOutcome: string;
}
export declare const concurrentRoleSets: readonly [];
export declare const inspectMachine: import("xstate").StateMachine<InspectContext, {
    type: "START";
    inspectionRequest: string;
    discussionContext?: string;
} | {
    type: "BOSS_REPLY";
    answer: string;
    questionId?: string;
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>> | undefined;
}, {
    src: "player";
    logic: import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>;
    id: string | undefined;
}, {
    type: "playbook.acceptedOutcome";
    params: AcceptedOutcomeParams;
} | {
    type: "clearBossReplyContext";
    params: unknown;
} | {
    type: "setPendingBossQuestion";
    params: unknown;
} | {
    type: "applyEntry";
    params: unknown;
} | {
    type: "recordCompleted";
    params: unknown;
} | {
    type: "recordUnavailable";
    params: unknown;
} | {
    type: "storeBossReply";
    params: unknown;
} | {
    type: "rememberError";
    params: unknown;
} | {
    type: "rememberMalformedOutput";
    params: unknown;
} | {
    type: "rememberEmptyReply";
    params: unknown;
}, {
    type: "hasInspectionRequest";
    params: unknown;
} | {
    type: "hasBossReply";
    params: unknown;
} | {
    type: "playerCompleted";
    params: unknown;
} | {
    type: "playerUnavailable";
    params: unknown;
} | {
    type: "playerNeedsBossReply";
    params: unknown;
}, never, "failed" | "ready" | "complete" | "awaitBossReply" | "unavailable" | "inspecting", string, InspectInput, {
    status: "complete";
    report: string;
} | {
    status: "unavailable";
    report: string;
}, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "inspect";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly inspecting: {
            id: "inspecting";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly complete: {
            id: "complete";
        };
        readonly unavailable: {
            id: "unavailable";
        };
        readonly failed: {
            id: "failed";
        };
    };
}>;
export {};
