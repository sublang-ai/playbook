export interface PlayerResult {
    status: 'ok' | 'aborted' | 'error';
    resumeToken?: string;
    finalText?: string;
    error?: string;
}
export interface PlayerCallOptions {
    resume: string | false;
}
export interface PlayerSessionStore {
    select(roleId: string): string | false;
    update(roleId: string, resumeToken?: string): void;
    snapshot(): Readonly<Record<string, string>>;
    restore(tokens: Readonly<Record<string, string>>): void;
}
export interface PlaybookRoleBinding {
    readonly playerId: string;
    readonly promptIdentity: string;
}
export interface CaptainCallOptions {
    visibility: 'visible' | 'hidden';
    resume: string | false;
    allowedTools?: readonly string[];
}
export interface CaptainResult {
    status: 'ok' | 'aborted' | 'error';
    finalText?: string;
    error?: string;
}
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export interface NormalizedError {
    name: string;
    message: string;
    stack?: string;
}
export type PlaybookStateValue = string | {
    readonly [key: string]: PlaybookStateValue;
};
export interface PlaybookState {
    value: PlaybookStateValue;
    activeStateIds: readonly string[];
    tags: readonly string[];
    status: 'active' | 'done' | 'error' | 'stopped';
    quiescent: boolean;
    stateId?: string;
}
export interface PlaybookPendingCall {
    callId: string;
    playbookId: string;
    childSessionId: string;
}
export interface PlaybookSuspendedCall extends PlaybookPendingCall {
    stateId: string;
    text: string;
    turnId?: number;
    effectBoundaryPrefixSequence?: number | null;
}
export interface PlaybookCallRequest {
    callId: string;
    playbookId: string;
    text: string;
}
export interface PlaybookTerminalOutcome {
    stateId: string;
    kind: 'success' | 'failure';
    description?: string;
}
export type PlaybookCallResult = {
    status: 'ok';
    playbookId: string;
    childSessionId: string;
    state?: PlaybookState;
    output?: JsonValue;
    terminal?: PlaybookTerminalOutcome;
} | {
    status: 'aborted';
    playbookId: string;
    childSessionId?: string;
    state?: PlaybookState;
    error?: NormalizedError;
} | {
    status: 'error';
    playbookId: string;
    childSessionId?: string;
    state?: PlaybookState;
    error: NormalizedError;
};
export type PlaybookCallStart = {
    state: 'settled';
    result: PlaybookCallResult;
} | {
    state: 'suspended';
    childSessionId: string;
};
export type PlaybookRunResult = {
    outcome: 'quiescent' | 'no-action';
    state: PlaybookState;
} | {
    outcome: 'unresolved-effect';
    state: PlaybookState;
} | {
    outcome: 'failed' | 'aborted';
    state: PlaybookState;
    error?: NormalizedError;
} | {
    outcome: 'terminal';
    state: PlaybookState;
    stateDescription?: string;
    terminal?: PlaybookTerminalOutcome;
    output?: JsonValue;
} | {
    outcome: 'suspended';
    state: PlaybookState;
    pendingCall: PlaybookPendingCall;
};
export interface PlaybookPorts {
    callPlayer(roleId: string, prompt: string, signal: AbortSignal, options: PlayerCallOptions): Promise<PlayerResult>;
    callCaptain(prompt: string, signal: AbortSignal, options: CaptainCallOptions): Promise<CaptainResult>;
    callJudge(prompt: string, signal: AbortSignal): Promise<string>;
    callPlaybook(request: PlaybookCallRequest, signal: AbortSignal): Promise<PlaybookCallStart>;
    emitStatus(message: string, data?: unknown): Promise<void>;
    emitTelemetry(event: {
        topic: string;
        payload: unknown;
    }): Promise<void>;
}
export interface PlaybookSession {
    sessionId: string;
    playbookId: string;
    rootSessionId: string;
    parentSessionId?: string;
    parentCallId?: string;
    depth: number;
    roleBindings?: Readonly<Record<string, PlaybookRoleBinding>>;
    playerSessions?: PlayerSessionStore;
    ports: PlaybookPorts;
}
export interface PlaybookAdoptionContext {
    readonly sourceSessionId: string;
    readonly sourceGenerationId: string;
    readonly targetChildSessionId?: string;
}
export type PlaybookTraceType = 'session.started' | 'boss.input.received' | 'judge.call.started' | 'judge.call.finished' | 'player.call.started' | 'player.call.finished' | 'captain.call.started' | 'captain.call.finished' | 'playbook.call.started' | 'playbook.call.finished' | 'apply.started' | 'apply.finished' | 'fsm.transition' | 'outcome.accepted' | 'status.emitted' | 'boss.input.settled' | 'session.disposed';
export interface PlaybookTraceEvent {
    schemaVersion: 4;
    sessionId: string;
    playbookId: string;
    rootSessionId: string;
    parentSessionId?: string;
    parentCallId?: string;
    depth: number;
    sequence: number;
    timestamp: number;
    type: PlaybookTraceType;
    turnId?: number;
    callId?: string;
    payload: JsonValue;
}
export interface PlaybookPendingBossQuestion {
    questionId: string;
    asker: {
        kind: 'captain';
    } | {
        kind: 'role';
        roleId: string;
    };
    question: string;
    sourceItem?: string;
}
/** One repository disposition declared by a governed outcome arm (DR-040). */
export type PlaybookRepositoryDisposition = 'unchanged' | 'one-descendant-commit' | 'deferred';
/** A detached Git-visible repository observation owned by the effect ledger. */
export interface PlaybookRepositoryObservation {
    readonly worktree: string;
    readonly gitDir: string;
    readonly head: string;
    readonly projection: Readonly<Record<string, JsonValue>>;
    readonly projectionDigest: string;
}
/** The fail-closed classification of one complete physical or logical receipt. */
export interface PlaybookRepositoryReceipt {
    readonly classification: 'unchanged' | 'one-descendant-commit' | 'multiple-commits' | 'rewritten-or-non-descendant' | 'worktree-only-change' | 'concurrent-or-foreign-change' | 'observation-ambiguous';
    readonly baseline: PlaybookRepositoryObservation;
    readonly after?: PlaybookRepositoryObservation;
    readonly commitOid?: string;
}
/** One durably ordered physical governed-player boundary (DR-040). */
export interface PlaybookEffectBoundary {
    readonly sequence: number;
    readonly boundaryId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly playbookId: string;
    readonly runtimeSessionId: string;
    readonly turnId: number;
    readonly callId: string;
    readonly roleId: string;
    readonly sourceStateId: string;
    readonly sourceOutcomeSchema: JsonValue;
    readonly dispositions: readonly PlaybookRepositoryDisposition[];
    readonly canonicalWorktree: {
        readonly worktree: string;
        readonly gitDir: string;
    };
    readonly baseline: PlaybookRepositoryObservation;
    readonly after?: PlaybookRepositoryObservation;
    readonly physicalReceipt?: PlaybookRepositoryReceipt;
    readonly finalText?: string;
    readonly semanticCandidate?: JsonValue;
    readonly initialSemanticCandidate?: JsonValue;
    readonly correctionBudget: {
        readonly limit: 1;
        readonly spent: boolean;
    };
    readonly cohortId?: string;
    readonly logicalOperationId?: string;
}
/** One physical boundary before the host assigns attempt and sequence data. */
export type PlaybookEffectBoundaryStart = Omit<PlaybookEffectBoundary, 'sequence' | 'attemptId' | 'attemptNumber' | 'after' | 'physicalReceipt' | 'finalText' | 'semanticCandidate' | 'initialSemanticCandidate'>;
/** One deferred logical operation spanning its ordered physical boundaries. */
export interface PlaybookEffectLogicalOperation {
    readonly sequence: number;
    readonly operationId: string;
    readonly playbookId: string;
    readonly runtimeSessionId: string;
    readonly boundaryIds: readonly string[];
    readonly originalBaseline: PlaybookRepositoryObservation;
    readonly checkpoint?: PlaybookRepositoryObservation;
    readonly pendingQuestion?: PlaybookPendingBossQuestion;
    readonly playerContinuation?: JsonValue;
    readonly checkpointRestorationEligible: boolean;
    readonly logicalReceipt?: PlaybookRepositoryReceipt;
}
/** Complete detached mirror of one host-owned reconciliation ledger. */
export interface PlaybookEffectLedger {
    readonly schemaVersion: 1;
    readonly revision: number;
    readonly boundaries: readonly PlaybookEffectBoundary[];
    readonly logicalOperations: readonly PlaybookEffectLogicalOperation[];
}
/** One mutation accepted by the host-owned effect-ledger write-ahead boundary. */
export type PlaybookEffectLedgerCommand = {
    readonly kind: 'start-boundaries';
    readonly boundaries: readonly [
        PlaybookEffectBoundaryStart,
        ...PlaybookEffectBoundaryStart[]
    ];
} | {
    readonly kind: 'replace-boundaries';
    readonly replacements: readonly [
        {
            readonly expected: PlaybookEffectBoundary;
            readonly next: PlaybookEffectBoundary;
        },
        ...{
            readonly expected: PlaybookEffectBoundary;
            readonly next: PlaybookEffectBoundary;
        }[]
    ];
} | {
    readonly kind: 'append-logical-operations';
    readonly operations: readonly [
        Omit<PlaybookEffectLogicalOperation, 'sequence'>,
        ...Omit<PlaybookEffectLogicalOperation, 'sequence'>[]
    ];
} | {
    readonly kind: 'replace-logical-operations';
    readonly replacements: readonly [
        {
            readonly expected: PlaybookEffectLogicalOperation;
            readonly next: PlaybookEffectLogicalOperation;
        },
        ...{
            readonly expected: PlaybookEffectLogicalOperation;
            readonly next: PlaybookEffectLogicalOperation;
        }[]
    ];
};
/** A nonempty command batch persisted as one ledger revision. */
export type PlaybookEffectLedgerCommandBatch = readonly [
    PlaybookEffectLedgerCommand,
    ...PlaybookEffectLedgerCommand[]
];
/** Live current-host seam for atomic effect-ledger observation and mutation. */
export interface PlaybookEffectLedgerCapability {
    snapshot(): PlaybookEffectLedger;
    writeAhead(commands: PlaybookEffectLedgerCommandBatch): Promise<PlaybookEffectLedger>;
}
export interface PlaybookRuntimeSnapshot {
    schemaVersion: 4;
    playbookId: string;
    machine: JsonValue;
    roleResumeTokens: {
        readonly [roleId: string]: string;
    };
    sequences: {
        trace: number;
        turn: number;
        judgeCall: number;
        playerCall: number;
        playbookCall: number;
        captainCall?: number;
    };
    state: PlaybookState;
    pendingBossQuestions: readonly PlaybookPendingBossQuestion[];
    effectLedger: PlaybookEffectLedger;
    /** Original runtime identity retained across schema-3 adoption lineage. */
    retainedEffectSourceSessionId?: string;
    /**
     * Unsafe retained-adoption checkpoint. The marker remains durable until
     * authoritative reconciliation proves its complete suffix replay-safe.
     */
    retainedEffectReconciliation?: {
        readonly sourceSessionId: string;
        readonly checkpoint: PlaybookEffectLedger;
    };
    failedEffectAttempt?: {
        readonly boundaryPrefix: number;
        readonly attemptId: string | null;
    };
    suspendedCall?: PlaybookSuspendedCall;
}
export interface PlaybookControlAction {
    id: string;
    label: string;
}
export interface PlaybookControlView {
    state: PlaybookState;
    stateDescription?: string;
    context?: JsonValue;
    pendingQuestions: readonly PlaybookPendingBossQuestion[];
    lastError?: NormalizedError;
    actions: readonly PlaybookControlAction[];
}
export type PlaybookControlReceipt = {
    disposition: 'rejected';
    reason: string;
} | {
    disposition: 'executed';
    run: PlaybookRunResult;
} | {
    disposition: 'failed';
    error: NormalizedError;
};
export interface PlaybookRetainedGenerationMetadata {
    readonly unfinishedFinalStateIds: readonly string[];
}
export interface PlaybookRuntime {
    init(session: PlaybookSession): Promise<void>;
    exportSnapshot?(): PlaybookRuntimeSnapshot | undefined;
    restore?(session: PlaybookSession, snapshot: PlaybookRuntimeSnapshot): Promise<void>;
    adopt?(session: PlaybookSession, snapshot: PlaybookRuntimeSnapshot, context: PlaybookAdoptionContext): Promise<void>;
    readonly retainedGenerationMetadata?: PlaybookRetainedGenerationMetadata;
    describe?(): PlaybookControlView;
    /**
     * Host-only identities of the durable envelopes that still require
     * unresolved-effect settlement. The host owns their bounded projection
     * from its authoritative effect ledger; no repository evidence enters a
     * runtime-owned run result.
     */
    unresolvedEffectEnvelopes?(): readonly ({
        readonly kind: 'boundary';
        readonly boundaryId: string;
    } | {
        readonly kind: 'logical-operation';
        readonly operationId: string;
    })[];
    apply?(input: {
        actionId: string;
        key: string;
        signal: AbortSignal;
    }): Promise<PlaybookControlReceipt>;
    handleBossInput(turn: {
        text: string;
        signal: AbortSignal;
    }): Promise<PlaybookRunResult>;
    resumePlaybookCall(input: {
        callId: string;
        result: PlaybookCallResult;
        signal: AbortSignal;
    }): Promise<PlaybookRunResult>;
    dispose(): Promise<void>;
}
export type PlaybookRuntimeFactory<Options = unknown> = (options: Options) => PlaybookRuntime;
