import type { AnyStateMachine, EventObject, PromiseActorLogic } from 'xstate';
import type { CaptainResult, JsonValue, PlaybookPorts, PlaybookRuntimeFactory, PlaybookSession, PlaybookState, PlayerResult } from './runtime.js';
export interface PlaybookPendingBossQuestionContext {
    questionId: string;
    resumeStateId: string;
    sourceItem: string;
    player: string;
    question: string;
}
export interface PlaybookPlayerInput {
    stateId: string;
    player: string;
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
    callPlayer(input: PlaybookPlayerInput, playerId: string, prompt: string, signal: AbortSignal): Promise<PlayerResult>;
    callJudge(purpose: JudgePurpose, stateId: string | undefined, prompt: string, signal: AbortSignal): Promise<string>;
    callCaptain?(input: PlaybookCaptainInput, prompt: string, signal: AbortSignal): Promise<CaptainResult>;
}
export interface ScheduledStatus {
    message: string;
    data?: JsonValue;
}
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
export interface XStatePlaybookRuntimeSpec<TOptions> {
    /** Diagnostic label used in internal invariant errors. Default 'playbook'. */
    label?: string;
    /**
     * Link-time compatibility declaration checked at construction against the
     * loaded engine's self-report (DR-022). Absent: a legacy artifact emitted
     * before the contract — constructed with no compatibility check.
     */
    compat?: XStatePlaybookRuntimeCompat;
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
    };
    /**
     * Exact flat Boss-event contracts whose non-text fields the judge may
     * select. `entryEvent` and scalar `BOSS_REPLY` contracts are supplied by
     * the factory; linkers emit entries here for additional typed events such
     * as `BOSS_INTERRUPT` when their erased payload cannot be recovered from
     * the XState machine alone.
     */
    bossEvents?: readonly XStateBossEventSpec[];
    /** Boss-input classifier override; default: generic parked-state classifier. */
    classifyBossText?: (text: string, ports: PlaybookPorts, signal: AbortSignal, snapshotOrState: unknown, boundary?: RuntimeBoundaryCalls) => Promise<EventObject | undefined>;
    /** Status line emitted after classification names an event. Default: none. */
    classificationStatus?: (event: EventObject) => string | undefined;
    /** Map a player-invoking state's input to the host player id. Default: lowercased player name. */
    resolvePlayerId?: (input: PlaybookPlayerInput, options: TOptions) => string;
    /** Compose the player prompt. Default: continuation blocks + `<field>` placeholder substitution. */
    composePlayerPrompt?: (input: PlaybookPlayerInput) => string;
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
    /** States that may suspend for a Boss reply. Default: targets of the FSM's `awaitBossReply` BOSS_REPLY transitions. */
    resumableStateIds?: ReadonlySet<string>;
    /** Human status lines for a root transition. Default: entry lines with question/failure surfacing. */
    statusesForState?: (state: PlaybookState, context: Record<string, unknown>, event: unknown) => readonly ScheduledStatus[];
    /** Detached JSON-safe transition-event descriptor. Default: `type` + `transitionEventFields` strings + validated output + normalized error. */
    normalizeTransitionEvent?: (event: unknown) => JsonValue | undefined;
    /** String payload fields the default transition-event descriptor copies. */
    transitionEventFields?: readonly string[];
    /** Working directory for `script` actors. Default: the validated options' string `cwd`, else the process working directory. */
    scriptCwd?: (options: TOptions) => string | undefined;
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
/** Default player binding: each player to its lowercased name. */
export declare function defaultResolvePlayerId(input: PlaybookPlayerInput): string;
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
export interface PlayerBridgeSpec {
    resolvePlayerId: (input: PlaybookPlayerInput) => string;
    composePlayerPrompt: (input: PlaybookPlayerInput) => string;
    adjudication: PlayerAdjudicationSpec;
    resumableStateIds: ReadonlySet<string>;
}
export declare function createPlayerBridge(spec: PlayerBridgeSpec, ports: PlaybookPorts, getActiveSignal?: () => AbortSignal | undefined, boundary?: RuntimeBoundaryCalls, onControlPlaneError?: (error: unknown) => void): PromiseActorLogic<PlaybookActorOutput, PlaybookPlayerInput>;
/** Targets of the FSM's `awaitBossReply` BOSS_REPLY transitions. */
export declare function resumableStateIdsFromMachine(machine: AnyStateMachine): ReadonlySet<string>;
/**
 * Build a `PlaybookRuntimeFactory` that interprets the given FSM artifact
 * under the slc/link.md contract. The factory provides every actor kind the
 * machine declares — `player`, `script`, `captain`, and nested `playbook`
 * (literal and dynamic) — and implements the full runtime lifecycle including
 * the optional parked-session snapshot capability (DR-014).
 *
 * Scope: single-region root machines (each snapshot exposes exactly one
 * playbook state id). Parallel-region FSMs keep their own linked runtimes.
 */
export declare function createXStatePlaybookRuntime<TOptions>(machine: AnyStateMachine, spec: XStatePlaybookRuntimeSpec<TOptions>): PlaybookRuntimeFactory<TOptions>;
