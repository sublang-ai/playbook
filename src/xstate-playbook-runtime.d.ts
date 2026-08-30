import type { AnyStateMachine, EventObject, PromiseActorLogic } from 'xstate';
import type { CaptainResult, JsonValue, PlaybookEffectBoundary, PlaybookEffectBoundaryStart, PlaybookEffectLedger, PlaybookEffectLedgerCapability, PlaybookPendingBossQuestion, PlaybookPorts, PlaybookRepositoryReceipt, PlaybookRuntimeFactory, PlaybookSession, PlaybookState, PlayerResult } from './runtime.js';
export interface PlaybookPendingBossQuestionContext {
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
export interface PlaybookPlayerInput {
    stateId: string;
    role: string;
    sourceItem: string;
    prompt: string;
    result: Readonly<Record<string, string>>;
    pendingBossQuestion?: {
        readonly question: string;
    };
    bossReply?: string;
}
export interface PlaybookCaptainInput {
    stateId: string;
    sourceItem: string;
    prompt: string;
    result: Readonly<Record<string, string>>;
    allowedTools?: readonly string[];
    pendingBossQuestion?: {
        readonly question: string;
    };
    bossReply?: string;
}
export interface PlaybookScriptInput {
    stateId: string;
    sourceItem: string;
    command: string;
    result: Readonly<Record<string, string>>;
}
/** Adjudicated actor output: the selected guard plus payload fields. */
export type PlaybookActorOutput = Record<string, unknown> & {
    guard: string;
};
export type JudgePurpose = 'boss-input-classification' | 'player-output-adjudication' | 'captain-output-adjudication';
/**
 * Traced runtime boundary used by the provided actors. The factory's runtime
 * implements it; standalone helpers accept it optionally so verification can
 * exercise composition/adjudication without a live runtime.
 */
export interface RuntimeBoundaryCalls {
    callPlayer(input: PlaybookPlayerInput, roleId: string, prompt: string, signal: AbortSignal): Promise<PlayerResult>;
    /**
     * Return the host-acknowledged adjudication performed while a governed
     * repository claim was still held. The value is consumable once.
     */
    takeGovernedPlayerOutput?(result: PlayerResult): PlaybookActorOutput | undefined;
    recordGovernedPlayerOutput?(result: PlayerResult, output: PlaybookActorOutput): void;
    callJudge(purpose: JudgePurpose, stateId: string | undefined, prompt: string, signal: AbortSignal): Promise<string>;
    callCaptain?(input: PlaybookCaptainInput, prompt: string, signal: AbortSignal, callOptions?: XStateCaptainCallOptions): Promise<CaptainResult>;
}
/**
 * Presentation selection for one traced direct-Captain call
 * (slc/link.md §Captain adjudication). `'visible'` (the default) is the
 * workflow form: the port receives `{ visibility: 'visible', resume: false }`
 * and the trace pair carries both members. `'hidden'` is the controller form
 * (DR-029): the port receives `{ visibility: 'hidden', resume: false }`
 * while the host's session-Captain wrapper owns the actual durable-conversation
 * resume selection, so the trace pair carries `visibility: 'hidden'` and no
 * `resume` member — the pinned token never enters runtime telemetry.
 */
export interface XStateCaptainCallOptions {
    visibility?: 'visible' | 'hidden';
}
export interface ScheduledStatus {
    message: string;
    data?: JsonValue;
}
/** Boss-facing identity for one FSM state whose invoked actor is `player`. */
export interface XStateRoleStateStatus {
    role: string;
    label: string;
}
/** Invocation-scoped lookup exposed only while composing a player prompt. */
export type XStatePromptIdentity = (roleId: string) => string;
export interface XStateBossEventFieldSpec {
    /** The judge supplies routing data; the runtime supplies exact Boss text. */
    source: 'judge' | 'text';
    /** Judge-authored fields are optional unless explicitly required. */
    required?: boolean;
    /** Optional closed set for a string-valued judge field. */
    values?: readonly string[];
}
export interface XStateBossEventSpec {
    type: string;
    fields?: Readonly<Record<string, XStateBossEventFieldSpec>>;
}
export declare const BOSS_REPLY_ERRORS: {
    readonly missingQuestion: "needsBossReply outcome missing 'question' field";
    readonly unregisteredState: (stateId: string) => string;
};
interface XStateRepositoryOperationSettlement<T> {
    readonly status: 'fulfilled';
    readonly value: T;
}
interface XStateRepositoryOperationRejection {
    readonly status: 'rejected';
    readonly reason: unknown;
}
interface XStateRepositoryExclusiveCompletion<T> {
    readonly boundary: PlaybookEffectBoundary;
    readonly operation: XStateRepositoryOperationSettlement<T> | XStateRepositoryOperationRejection;
    readonly receipt: PlaybookRepositoryReceipt;
}
interface XStateDeferredBinding {
    readonly operationId: string;
    readonly pendingQuestion: PlaybookPendingBossQuestion;
    readonly playerContinuation: JsonValue;
}
interface XStateRepositoryCompletionEvidence {
    readonly finalText?: string;
    readonly semanticCandidate?: JsonValue;
    readonly deferred?: XStateDeferredBinding;
    readonly unresolved?: true;
}
interface XStateRepositoryExclusiveResult<T> {
    readonly operation: XStateRepositoryOperationSettlement<T> | XStateRepositoryOperationRejection;
    readonly receipt: PlaybookRepositoryReceipt;
    readonly effectLedger: PlaybookEffectLedger;
    readonly deferredStatus?: 'bound' | 'unresolved';
}
interface XStateRepositoryDeferredContinuationResult<T> {
    readonly status: 'continued';
    readonly operation: XStateRepositoryOperationSettlement<T> | XStateRepositoryOperationRejection;
    readonly receipt: PlaybookRepositoryReceipt;
    readonly logicalReceipt?: PlaybookRepositoryReceipt;
    readonly effectLedger: PlaybookEffectLedger;
    readonly deferredStatus?: 'bound' | 'unresolved';
}
interface XStateRepositoryDeferredCheckpointMismatch {
    readonly status: 'checkpoint-mismatch' | 'ineligible';
    readonly effectLedger: PlaybookEffectLedger;
}
interface XStateRepositoryDeferredParked {
    readonly status: 'parked';
    readonly effectLedger: PlaybookEffectLedger;
}
interface XStateRepositoryDeferredRestoreResult {
    readonly status: 'restored' | 'checkpoint-mismatch' | 'ineligible';
    readonly effectLedger: PlaybookEffectLedger;
}
type XStateEffectBoundarySeed = Omit<PlaybookEffectBoundaryStart, 'playbookId' | 'canonicalWorktree' | 'baseline' | 'cohortId'>;
export interface XStateRepositoryCapability {
    runExclusive<T>(options: {
        readonly signal: AbortSignal;
        readonly effectBoundary: XStateEffectBoundarySeed;
        readonly operation: () => Promise<T>;
        readonly completeEffectBoundary: (completion: XStateRepositoryExclusiveCompletion<T>) => XStateRepositoryCompletionEvidence | Promise<XStateRepositoryCompletionEvidence>;
    }): Promise<XStateRepositoryExclusiveResult<T>>;
    runDeferred<T>(options: {
        readonly mode: 'continue';
        readonly signal: AbortSignal;
        readonly operationId: string;
        readonly effectBoundary: XStateEffectBoundarySeed;
        readonly operation: (context: {
            readonly baseline: PlaybookRepositoryReceipt['baseline'];
            readonly identity: unknown;
            readonly playerContinuation: JsonValue;
        }) => Promise<T>;
        readonly completeEffectBoundary: (completion: XStateRepositoryExclusiveCompletion<T>) => XStateRepositoryCompletionEvidence | Promise<XStateRepositoryCompletionEvidence>;
    }): Promise<XStateRepositoryDeferredContinuationResult<T> | XStateRepositoryDeferredCheckpointMismatch>;
    runDeferred(options: {
        readonly mode: 'park' | 'restore';
        readonly signal: AbortSignal;
        readonly operationId: string;
    }): Promise<XStateRepositoryDeferredParked | XStateRepositoryDeferredRestoreResult>;
}
/** The runtime ABI this engine implements (DR-022). */
export declare const RUNTIME_ABI = 1;
/** The linked-artifact schema versions this engine accepts (DR-022). */
export declare const SUPPORTED_ARTIFACT_SCHEMAS: readonly number[];
/** A linked artifact's declared link-time compatibility values (DR-022). */
export interface XStatePlaybookRuntimeCompat {
    /** The artifact schema version the linker emitted. */
    artifactSchema: number;
    /** The engine ABI the artifact was linked against. */
    runtimeAbi: number;
}
/** Authority for one schema-3 delegated-player outcome payload field. */
export type XStateOutcomeFieldAuthority = 'presentation' | 'semantic' | 'effect' | 'runtime';
/** Repository disposition required by one schema-3 outcome arm. */
export type XStateRepositoryDisposition = 'unchanged' | 'one-descendant-commit' | 'deferred';
/** Closed authority and repository contract for one governed outcome. */
export interface XStateGovernedOutcomeSpec {
    readonly fields: Readonly<Record<string, XStateOutcomeFieldAuthority>>;
    readonly repositoryDisposition: XStateRepositoryDisposition;
}
/**
 * Schema-3 authority metadata, keyed first by player state and then by its
 * declared outcome. A roleless artifact supplies an explicitly empty
 * `governedPlayerStates` object.
 */
export interface XStateOutcomeAuthoritySpec {
    readonly governedPlayerStates: Readonly<Record<string, Readonly<Record<string, XStateGovernedOutcomeSpec>>>>;
}
/**
 * Schema-3 factory input composed by a registry from persisted configured
 * options and live current-host capabilities. The engine snapshots only the
 * first member and never places the second in machine input or persistence.
 */
export interface XStatePlaybookRuntimeConstruction<ConfiguredOptions, HostCapabilities extends object> {
    readonly configuredOptions: ConfiguredOptions;
    readonly hostCapabilities: HostCapabilities & {
        readonly repository: XStateRepositoryCapability;
        readonly effectLedger: PlaybookEffectLedgerCapability;
    };
}
export type XStatePlaybookRuntimeFactoryOptions<ConfiguredOptions, HostCapabilities extends object> = [HostCapabilities] extends [never] ? ConfiguredOptions : XStatePlaybookRuntimeConstruction<ConfiguredOptions, HostCapabilities>;
/** Shared XState factory with its captured, validated artifact compatibility. */
export type XStatePlaybookRuntimeFactory<Options = unknown, ArtifactSchema extends 2 | 3 = 2 | 3> = PlaybookRuntimeFactory<Options> & {
    readonly compat: Readonly<{
        readonly artifactSchema: ArtifactSchema;
        readonly runtimeAbi: typeof RUNTIME_ABI;
    }>;
};
/**
 * One direct-Captain actor invocation handed to a spec's `captainStrategy`
 * (slc/link.md §Captain adjudication, controller form). The engine owns
 * signal combination, emission draining, trace pairing, the shared
 * Captain/judge lane, and control-plane latching; the strategy owns the
 * playbook-specific call pipeline — e.g. the controller's hidden decision
 * call, `{ action, … }` control-JSON validation with its single corrective
 * re-ask, and controller-port submission.
 */
export interface XStateCaptainStrategyRun<TOptions> {
    input: PlaybookCaptainInput;
    /** The prompt composed by the spec's Captain composer for `input`. */
    prompt: string;
    /** Combined invocation-lifetime + active-boundary abort signal. */
    signal: AbortSignal;
    /** The immutable validated runtime options. */
    options: TOptions;
    /** The bound immutable playbook session identity. */
    session: PlaybookSession;
    /**
     * One traced Captain call through the shared serialized lane; every call —
     * initial or corrective — emits its own paired `captain.call.started` /
     * `captain.call.finished` boundary. Throws the boundary's authoritative
     * failure for non-`ok` and empty-`ok` results exactly as the default
     * pipeline does.
     */
    callCaptain(prompt: string, callOptions?: XStateCaptainCallOptions): Promise<CaptainResult>;
    /**
     * DR-028: true when `error` is the boundary's re-askable empty-`ok`
     * marker; the strategy may re-issue the same composed call exactly once.
     */
    isEmptyOkRetry(error: unknown): boolean;
    /**
     * Mark `error` as a recoverable FSM-result failure: it travels the invoked
     * actor's XState `onError` path without being latched as a control-plane
     * error, so the machine's authored recovery arms can route it.
     */
    recoverableFailure<E extends Error>(error: E): E;
}
export type XStateCaptainStrategy<TOptions> = (run: XStateCaptainStrategyRun<TOptions>) => Promise<PlaybookActorOutput>;
interface XStatePlaybookRuntimeSpecBase<TOptions> {
    /** Diagnostic label used in internal invariant errors. Default 'playbook'. */
    label?: string;
    /** Validate and JSON-snapshot the caller's per-run options. */
    snapshotOptions: (value: unknown) => TOptions;
    /** Derive the FSM machine input from validated options. Default: identity. */
    machineInput?: (options: TOptions, session: PlaybookSession) => unknown;
    /**
     * Deterministic textual entry event (slc/link.md §Boss-event mapping):
     * where the ready or reconstructed terminal machine accepts exactly one
     * ordinary textual entry event, send it without a judge call, carrying the
     * exact Boss text in `textField`. Absent: every non-empty turn classifies.
     */
    entryEvent?: {
        type: string;
        textField: string;
        /**
         * DR-034: the FSM context member this machine's entry action copies the
         * exact Boss text into. Where it is named, the failure-state retry
         * builds its payload from that member of the live snapshot instead of
         * from the process-local recorded event, so the action derives the same
         * before and after `restore`. Absent: the recorded event stays the
         * source and the action lives only as long as the process.
         */
        contextField?: string;
    };
    /**
     * Exact flat Boss-event contracts whose non-text fields the judge may
     * select. `entryEvent` and scalar `BOSS_REPLY` contracts are supplied by
     * the factory; linkers emit entries here for additional typed events such
     * as `BOSS_INTERRUPT` when their erased payload cannot be recovered from
     * the XState machine alone.
     */
    bossEvents?: readonly XStateBossEventSpec[];
    /** Boss-input classifier override; default: generic parked-state classifier. Receives the bound validated options last so a fully deterministic controller mapping can consult host-supplied option members (slc/link.md §Boss-event mapping). */
    classifyBossText?: (text: string, ports: PlaybookPorts, signal: AbortSignal, snapshotOrState: unknown, boundary?: RuntimeBoundaryCalls, options?: TOptions) => Promise<EventObject | undefined>;
    /**
     * Direct-Captain actor strategy override (slc/link.md §Captain
     * adjudication, controller form): replaces the default visible-call +
     * hidden-judge pipeline for every `captain` state of this machine. The
     * engine still composes the prompt, combines signals, traces each call as
     * its own pair, and latches control-plane errors; failures the strategy
     * marks with `recoverableFailure` travel the actor's `onError` path as
     * recoverable FSM-result failures instead.
     */
    captainStrategy?: XStateCaptainStrategy<TOptions>;
    /** Status line emitted after classification; metadata defaults to the event type. */
    classificationStatus?: (event: EventObject) => string | undefined;
    /** Complete FSM-derived Boss-facing metadata for every `player` state. */
    roleStates?: Readonly<Record<string, XStateRoleStateStatus>>;
    /** Compose the player prompt. Default: continuation blocks + `<field>` placeholder substitution. */
    composePlayerPrompt?: (input: PlaybookPlayerInput, promptIdentity: XStatePromptIdentity) => string;
    /** Compose the direct-Captain prompt. Default: continuation blocks + placeholder substitution with deterministic JSON rendering. */
    composeCaptainPrompt?: (input: PlaybookCaptainInput) => string;
    /** Linker-known exceptions to the default kebab-token → camel-field mapping. */
    placeholderFields?: Readonly<Record<string, string>>;
    /** Adjudicator prompt for delegated players. Default: generic guard menu. */
    buildJudgePrompt?: (input: PlaybookPlayerInput, finalText: string) => string;
    /** Required-payload-field extraction from a `result` description. Default: bilingual `Output shall include` clause scan. */
    extractRequiredFields?: (description: string) => string[];
    /** Required fields carried verbatim from the player's finalText instead of judge JSON. Default: none. */
    verbatimPayloadFields?: ReadonlySet<string>;
    /**
     * DR-029 / PBRT-52: the runtime-authored ControlView context
     * projection — the exact FSM context members `describe()` may expose,
     * in the order the view lists them. Only this artifact knows which of
     * its context members are safe and relevant for a controller prompt, so
     * the engine exports what is named here and nothing else: a member the
     * artifact has not named stays private, and a member added to the FSM
     * later stays private until someone names it. Absent or empty: the view
     * carries no context at all. `pendingBossQuestion` and `lastError` are
     * surfaced first-class by the view and shall not be named here.
     */
    controlContextFields?: readonly string[];
    /** Root final states whose terminal outcome leaves unfinished work. Default: none. */
    unfinishedFinalStateIds?: ReadonlySet<string>;
    /** States that may suspend for a Boss reply. Default: targets of the FSM's `awaitBossReply` BOSS_REPLY transitions. */
    resumableStateIds?: ReadonlySet<string>;
    /** Human status lines for a root transition. Default: guard, declared-player, question, and failure lines. */
    statusesForState?: (state: PlaybookState, context: Record<string, unknown>, event: unknown) => readonly ScheduledStatus[];
    /** Detached JSON-safe transition-event descriptor. Default: `type` + `transitionEventFields` strings + validated output + normalized error. */
    normalizeTransitionEvent?: (event: unknown) => JsonValue | undefined;
    /** String payload fields the default transition-event descriptor copies. */
    transitionEventFields?: readonly string[];
    /** Working directory for `script` actors. Default: the validated options' string `cwd`, else the process working directory. */
    scriptCwd?: (options: TOptions) => string | undefined;
}
/**
 * Legacy schema-2-compatible shared-engine spec name. Its optional compat
 * member is retained for downstream source compatibility; construction still
 * rejects an absent or unsupported declaration before interpretation.
 */
export interface XStatePlaybookRuntimeSpec<TOptions> extends XStatePlaybookRuntimeSpecBase<TOptions> {
    compat?: XStatePlaybookRuntimeCompat;
    outcomeAuthority?: never;
}
/** Exact schema-2 shared-engine spec; its one-argument factory is intact. */
export interface XStatePlaybookRuntimeSpecV2<TOptions> extends XStatePlaybookRuntimeSpec<TOptions> {
    compat: XStatePlaybookRuntimeCompat & {
        artifactSchema: 2;
    };
}
/** Schema-3 shared-engine spec with required exact outcome authority metadata. */
export interface XStatePlaybookRuntimeSpecV3<TOptions> extends XStatePlaybookRuntimeSpecBase<TOptions> {
    compat: XStatePlaybookRuntimeCompat & {
        artifactSchema: 3;
    };
    outcomeAuthority: XStateOutcomeAuthoritySpec;
}
/** Strip a single Markdown code fence that wraps the whole string. */
export declare function stripCodeFence(text: string): string;
export declare function extractJsonValue(text: string, start: number, repair: boolean): string | undefined;
export declare function parseJudgeJson(raw: string): unknown;
export declare function normalizeErrorCompact(err: unknown): {
    name: string;
    message: string;
} | undefined;
export declare function normalizeErrorFull(err: unknown): {
    name: string;
    message: string;
    stack?: string;
} | undefined;
/** Read the FSM context's single pending Boss question, when well-formed. */
export declare function pendingBossQuestionFromContext(context: Record<string, unknown>): PlaybookPendingBossQuestionContext | undefined;
/**
 * Default player-prompt composer (slc/link.md §Player prompt composition).
 * One callback-based pass substitutes each `<fieldName>` placeholder whose
 * typed input field is a string; replacement text is literal, and
 * placeholder-looking text inside a value is never re-substituted. The
 * continuation preamble and Q/A blocks precede the domain body on resume.
 */
export declare function defaultComposePlayerPrompt(input: PlaybookPlayerInput, placeholderFields?: Readonly<Record<string, string>>): string;
/**
 * Default direct-Captain prompt composer (slc/link.md §Captain prompt
 * composition). Placeholder substitution is presence-based: string fields
 * substitute verbatim; JSON-safe arrays/objects render as deterministic JSON
 * with lexicographically sorted keys at every depth.
 */
export declare function defaultComposeCaptainPrompt(input: PlaybookCaptainInput, placeholderFields?: Readonly<Record<string, string>>): string;
/**
 * Default required-field extraction (slc/link.md §Captain adjudication).
 * Limited to the description's `Output shall include` / `输出应包含` clause;
 * recognizes both the bare backticked name and the annotated `name: <...>`
 * form.
 */
export declare function defaultExtractRequiredFields(description: string): string[];
/** Default delegated-player adjudicator prompt. */
export declare function defaultBuildJudgePrompt(input: PlaybookPlayerInput, finalText: string): string;
export interface PlayerAdjudicationSpec {
    buildJudgePrompt?: (input: PlaybookPlayerInput, finalText: string) => string;
    extractRequiredFields?: (description: string) => string[];
    verbatimPayloadFields?: ReadonlySet<string>;
}
/**
 * LLM-judge adjudicator for delegated players. Coerces the player's
 * finalText into one of the state's declared guards, extracts every required
 * payload field from the judge reply, and fails loudly (throws) on a missing
 * JSON object, an undeclared guard, or a missing required field. Fields in
 * `verbatimPayloadFields` carry `finalText.trim()` rather than round-tripping
 * long-form prose through judge JSON.
 */
export declare function adjudicatePlayerOutput(spec: PlayerAdjudicationSpec, input: PlaybookPlayerInput, finalText: string, ports: PlaybookPorts, signal: AbortSignal, boundary?: RuntimeBoundaryCalls): Promise<PlaybookActorOutput>;
interface PlayerBridgeSpec {
    resolveRoleId: (input: PlaybookPlayerInput) => string;
    validateInput?: (input: PlaybookPlayerInput) => void;
    composePlayerPrompt: (input: PlaybookPlayerInput) => string;
    adjudication: PlayerAdjudicationSpec;
    resumableStateIds: ReadonlySet<string>;
    allowsCorrectiveReplay?: (result: PlayerResult) => boolean;
}
export declare function createPlayerBridge(spec: PlayerBridgeSpec, ports: PlaybookPorts, getActiveSignal?: () => AbortSignal | undefined, boundary?: RuntimeBoundaryCalls, onControlPlaneError?: (error: unknown) => void): PromiseActorLogic<PlaybookActorOutput, PlaybookPlayerInput>;
/**
 * Default direct-Captain adjudicator prompt (DR-025). The single statement of
 * the `{ guard, …structuralPayloadFields }` reply contract, shared with the
 * compiled default Captain artifact so the wording cannot drift.
 */
export declare function defaultBuildCaptainJudgePrompt(input: {
    readonly stateId: string;
    readonly sourceItem: string;
    readonly result: Readonly<Record<string, string>>;
}, finalText: string): string;
/** Targets of the FSM's `awaitBossReply` BOSS_REPLY transitions. */
export declare function resumableStateIdsFromMachine(machine: AnyStateMachine): ReadonlySet<string>;
/**
 * Source state descriptions by state key, node id, and `meta.playbook`
 * state id, read from `machine.config`. Control actions are labeled from
 * these descriptions (DR-029); a state without one has no entry.
 */
export declare function stateDescriptionsFromMachine(machine: AnyStateMachine): ReadonlyMap<string, string>;
/**
 * Build a `PlaybookRuntimeFactory` that interprets the given FSM artifact
 * under the slc/link.md contract. The factory provides every actor kind the
 * machine declares — `player`, `script`, `captain`, and nested `playbook`
 * (literal and dynamic) — and implements the full runtime lifecycle including
 * the optional parked-session snapshot capability (DR-014) and the retained-
 * snapshot adoption capability (DR-038).
 *
 * Scope: flat single-region machines — no parallel state, no compound
 * child states, and every root state's `meta.playbook.stateId` equal to its
 * state key — so each snapshot exposes exactly one playbook state id.
 * Parallel-region FSMs keep their own linked runtimes.
 */
export declare function createXStatePlaybookRuntime<TOptions>(machine: AnyStateMachine, spec: XStatePlaybookRuntimeSpec<TOptions>): XStatePlaybookRuntimeFactory<TOptions, 2>;
export declare function createXStatePlaybookRuntime<TOptions, THostCapabilities extends object>(machine: AnyStateMachine, spec: XStatePlaybookRuntimeSpecV3<TOptions>): XStatePlaybookRuntimeFactory<XStatePlaybookRuntimeConstruction<TOptions, THostCapabilities>, 3>;
export {};
