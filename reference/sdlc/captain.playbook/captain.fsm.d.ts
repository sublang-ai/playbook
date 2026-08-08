export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
/** One immutable host-catalog entry (id + command + intent only). */
export type EnabledPlaybook = {
    readonly id: string;
    readonly command: string;
    readonly intent: string;
};
/** The closed controller action set (DR-029; stable machine contract). */
export type DecisionAction = 'respond' | 'start' | 'switch' | 'dismiss' | 'deliver' | 'runtime';
/**
 * A deterministic parse-resolved acting decision injected by the host
 * (CAPTAIN-7 parse table): the turn's decision object, entering the decision
 * state with no decision model call.
 */
export type ParsedActingDecision = {
    readonly action: 'start' | 'switch';
    readonly playbookId: string;
    readonly input: string;
} | {
    readonly action: 'deliver';
};
/** Compact `{ name, message }` error evidence (never a raw Error). */
export type CompactError = {
    readonly name: string;
    readonly message: string;
};
/** Receipt evidence of an executed `runtime` action (disposition only). */
export type SettlementReceiptEvidence = {
    readonly disposition: 'executed' | 'rejected' | 'failed';
    readonly reason?: string;
    readonly error?: CompactError;
};
/**
 * The controller-port settlement evidence the machine may retain: status,
 * outcome-report facts, optional rejection reason, receipt disposition, and
 * leaf-state summary — never a session id, call id, child state, stack
 * ledger, resume token, or opaque runtime result (CAPPLAY-10).
 */
export type SettlementEvidence = {
    readonly status: 'ok' | 'rejected' | 'failed';
    readonly facts: readonly string[];
    readonly reason?: string;
    readonly receipt?: SettlementReceiptEvidence;
    readonly leafStateSummary?: string;
};
export type CaptainMachineInput = {
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
};
export type CaptainStateId = 'deciding' | 'answeringCommand' | 'reporting';
export type CaptainSourceItem = 'CAPTAIN-1' | 'CAPTAIN-2' | 'CAPTAIN-3';
export type CaptainInput = {
    readonly stateId: CaptainStateId;
    readonly sourceItem: CaptainSourceItem;
    readonly prompt: string;
    readonly result: Record<string, string>;
    /**
     * DR-013 A1 source-owned tool restriction: this playbook's policy forbids
     * tools on every Captain call, so each state requests the empty allowlist.
     */
    readonly allowedTools: readonly string[];
    /** The injected parse-resolved decision, when the host's parse decided the turn. */
    readonly parsedDecision?: ParsedActingDecision;
};
/**
 * Decision-state output: the validated selection under the stable controller
 * guard contract — `respond` | `start` | `switch` | `dismiss` | `deliver` |
 * `runtime`, with the payload fields DR-029 requires — plus the
 * controller-port settlement evidence of the executed submission. The prose
 * states (`answeringCommand`, `reporting`) carry the default single-outcome
 * `done` contract.
 */
export type CaptainOutput = {
    readonly guard: 'respond';
    readonly text: string;
    readonly settlement: SettlementEvidence;
} | {
    readonly guard: 'start';
    readonly playbookId: string;
    readonly input: string;
    readonly settlement: SettlementEvidence;
} | {
    readonly guard: 'switch';
    readonly playbookId: string;
    readonly input: string;
    readonly settlement: SettlementEvidence;
} | {
    readonly guard: 'dismiss';
    readonly settlement: SettlementEvidence;
} | {
    readonly guard: 'deliver';
    readonly settlement: SettlementEvidence;
} | {
    readonly guard: 'runtime';
    readonly actionId: string;
    readonly settlement: SettlementEvidence;
} | {
    readonly guard: 'done';
};
type Context = {
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    readonly bossText: string;
    readonly parsedDecision?: ParsedActingDecision;
    readonly selectedAction?: DecisionAction;
    readonly settlementStatus?: 'ok' | 'rejected' | 'failed';
    readonly settlementFacts?: readonly string[];
    readonly settlementReason?: string;
    readonly receiptDisposition?: 'executed' | 'rejected' | 'failed';
    readonly receiptReason?: string;
    readonly receiptError?: CompactError;
    readonly leafStateSummary?: string;
    readonly lastError?: JsonValue;
};
type BossTurnEvent = {
    readonly type: 'BOSS_TURN';
    readonly bossText: string;
};
type ParsedRespondEvent = {
    readonly type: 'PARSED_RESPOND';
    readonly bossText: string;
};
type ParsedActionEvent = {
    readonly type: 'PARSED_ACTION';
    readonly bossText: string;
    readonly decision: ParsedActingDecision;
};
type ShutdownEvent = {
    readonly type: 'SHUTDOWN';
};
export type CaptainMachineEvent = BossTurnEvent | ParsedRespondEvent | ParsedActionEvent | ShutdownEvent;
export declare const captainMachine: import("xstate").StateMachine<Context, BossTurnEvent | ParsedRespondEvent | ParsedActionEvent | ShutdownEvent, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>> | undefined;
}, {
    src: "captain";
    logic: import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>;
    id: string | undefined;
}, {
    type: "startDecidedTurn";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "startCommandTurn";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "startParsedTurn";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "recordSettlement";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "recordDecisionReplyFailure";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberInvalidActorOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberActorError";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "start";
    params: unknown;
} | {
    type: "respond";
    params: unknown;
} | {
    type: "switch";
    params: unknown;
} | {
    type: "dismiss";
    params: unknown;
} | {
    type: "deliver";
    params: unknown;
} | {
    type: "runtime";
    params: unknown;
} | {
    type: "hasBossTurnText";
    params: unknown;
} | {
    type: "hasCommandRespondText";
    params: unknown;
} | {
    type: "hasParsedActingDecision";
    params: unknown;
} | {
    type: "isDecisionReplyFailure";
    params: unknown;
}, never, "failed" | "deciding" | "answeringCommand" | "reporting" | "hub" | "shutdown", string, CaptainMachineInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "captain";
    states: {
        readonly hub: {
            id: "hub";
        };
        readonly deciding: {
            id: "deciding";
        };
        readonly answeringCommand: {
            id: "answeringCommand";
        };
        readonly reporting: {
            id: "reporting";
        };
        readonly failed: {
            id: "failed";
        };
        readonly shutdown: {
            id: "shutdown";
        };
    };
}>;
export {};
