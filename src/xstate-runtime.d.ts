import { type AnyActorRef, type PromiseActorLogic, type SnapshotFrom } from 'xstate';
import type { CaptainResult, JsonValue, NormalizedError, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPendingCall, PlaybookEffectLedger, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookSuspendedCall, PlayerResult } from './runtime.js';
export * from './xstate-playbook-runtime.js';
/**
 * Immutable cancellation provenance for one runtime operation. The captured
 * signal identities do not change when a mutable runtime advances to another
 * public boundary, while each signal's eventual reason remains observable.
 */
interface AbortReasonClassifier {
    isAbortReason(error: unknown): boolean;
}
/**
 * Compose invocation-lifetime and imperative-boundary cancellation without
 * installing a second forwarding listener in each generated runtime.
 */
export declare function combineAbortSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal;
/**
 * Register host cleanup started synchronously by an invocation abort.
 * The nested bridge drains these promises before it publishes the matching
 * call-finish boundary, without widening the public six-port contract.
 */
export declare function registerPlaybookAbortCleanup(signal: AbortSignal, cleanup: Promise<unknown>): void;
/** Reject values that would be changed, omitted, or rejected by JSON. */
export declare function assertJsonSafe(value: unknown, path?: string, ancestors?: ReadonlySet<object>): asserts value is JsonValue;
/** Validate, detach, and recursively freeze host-owned JSON input. */
export declare function snapshotJsonValue(value: unknown, path?: string): JsonValue;
/** Validate session causality and detach its immutable identity from the host. */
export declare function snapshotPlaybookSession(session: PlaybookSession): PlaybookSession;
export declare function hiddenControlEnvelope(prompt: string): string;
export declare function normalizeError(error: unknown): NormalizedError;
export interface PlaybookStateMetadata {
    stateId: string;
    description?: string;
}
/** Read stable state identity without consulting XState's private `_nodes`. */
export declare function activePlaybookStateMetadata(snapshot: unknown): readonly PlaybookStateMetadata[];
export interface SnapshotNormalizationOptions {
    pendingCall?: PlaybookPendingCall;
}
export declare function normalizePlaybookSnapshot(snapshot: unknown, options?: SnapshotNormalizationOptions): PlaybookState;
export declare function detachPersistedMachineSnapshot(persisted: unknown): JsonValue;
/** Return the canonical empty host-owned effect-ledger mirror. */
export declare function emptyPlaybookEffectLedger(): PlaybookEffectLedger;
/** Validate, detach, and recursively freeze one effect-ledger mirror. */
export declare function assertPlaybookEffectLedger(value: unknown, path?: string): PlaybookEffectLedger;
/** Whether current preserves every durable fact in baseline and only extends it. */
export declare function isPlaybookEffectLedgerMonotonicExtension(baselineValue: unknown, currentValue: unknown): boolean;
export interface PlaybookRuntimeSnapshotValidationOptions {
    /**
     * Opt in only when the restore path will prepare and confirm the suspended
     * call transaction. The default is fail-closed so a legacy restore cannot
     * reopen or ignore it.
     */
    allowSuspendedCall?: boolean;
}
export declare function assertPlaybookRuntimeSnapshot(value: unknown, expectedPlaybookId: string, options?: PlaybookRuntimeSnapshotValidationOptions): PlaybookRuntimeSnapshot;
export interface NestedPlaybookInput {
    stateId: string;
    playbookId: string;
    text: string;
}
export interface PlaybookCallStarted {
    callId: string;
    stateId: string;
    playbookId: string;
    text: string;
}
export interface PlaybookCallFinished extends PlaybookCallStarted {
    result: PlaybookCallResult;
}
export interface NestedPlaybookBridgeOptions {
    nextCallId(): string;
    /** Active public runtime boundary whose abort also owns a new child call. */
    getBoundarySignal?(): AbortSignal | undefined;
    callPlaybook(request: PlaybookCallRequest, signal: AbortSignal): Promise<PlaybookCallStart>;
    emitStarted(event: PlaybookCallStarted, aborts?: AbortReasonClassifier): Promise<void>;
    emitFinished(event: PlaybookCallFinished, aborts?: AbortReasonClassifier): Promise<void>;
    drain(aborts?: AbortReasonClassifier): Promise<void>;
    bindResumeSignal?(signal: AbortSignal, aborts?: AbortReasonClassifier): void;
    /** Bind provenance to the root transition caused by this child result. */
    bindActorSettlement?(aborts: AbortReasonClassifier): void;
    onControlPlaneError?(error: unknown, aborts?: AbortReasonClassifier): void;
    onBackgroundError?(error: unknown, aborts?: AbortReasonClassifier): void;
}
export declare class NestedPlaybookCallError extends Error {
    readonly result: PlaybookCallResult;
    constructor(result: PlaybookCallResult);
}
export interface PendingCallObserver {
    getPendingCall(): PlaybookPendingCall | undefined;
    subscribePendingCall(listener: (pendingCall: PlaybookPendingCall) => void): () => void;
}
export interface NestedPlaybookBridge<TInput extends NestedPlaybookInput = NestedPlaybookInput> extends PendingCallObserver {
    actorLogic: PromiseActorLogic<JsonValue | undefined, TInput>;
    /** Arm fail-closed actor startup for a snapshot with zero or one nested call. */
    prepareRestore(call?: PlaybookSuspendedCall): void;
    /**
     * Commit restore startup after the persisted machine recreated exactly the
     * expected zero or one nested invocation.
     */
    confirmRestore(): void;
    /** Complete durable identity; undefined until a normal or restored call suspends. */
    getSuspendedCall(): PlaybookSuspendedCall | undefined;
    resume(input: {
        callId: string;
        result: PlaybookCallResult;
        signal: AbortSignal;
    }): Promise<void>;
    abortPending(error?: unknown): Promise<void>;
    dispose(): Promise<void>;
}
/** Validate, detach, and freeze a host direct-Captain result. */
export declare function validateCaptainResult(value: unknown, path?: string): CaptainResult;
/** Validate, detach, and freeze a host delegated-player result. */
export declare function validatePlayerResult(value: unknown, path?: string): PlayerResult;
export declare function validatePlaybookCallResult(result: unknown, expectedPlaybookId: string, expectedChildSessionId?: string): PlaybookCallResult;
export declare function validatePlaybookCallStart(start: unknown, expectedPlaybookId: string): PlaybookCallStart;
export declare function createNestedPlaybookBridge<TInput extends NestedPlaybookInput = NestedPlaybookInput>(options: NestedPlaybookBridgeOptions): NestedPlaybookBridge<TInput>;
export interface WaitForPlaybookQuiescenceOptions {
    signal?: AbortSignal;
    timeout?: number;
    pendingCalls?: PendingCallObserver;
}
/**
 * Wait at the imperative runtime boundary; workflow waiting remains in XState.
 * A pending-call notification covers the case where the suspended state was
 * entered before its host returned the child session id.
 */
export declare function waitForPlaybookQuiescence<TActorRef extends AnyActorRef>(actor: TActorRef, options?: WaitForPlaybookQuiescenceOptions): Promise<SnapshotFrom<TActorRef>>;
