// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Generic linked-playbook runtime factory (DR-019). The FSM-interpreter
// machinery that slc/link.md previously regenerated inside every linked
// `<name>.playbook.ts` artifact — actor wiring, boundary tracing, judge
// classification/adjudication, script execution, nested-playbook bridging,
// Boss-reply suspension, snapshot restore/adoption, and disposal — lives here
// once.
// A linked artifact supplies only its per-workflow `spec` (options
// validation and any strategy overrides) and its own FSM; the factory
// interprets the FSM data the artifact already carries.
//
// The machinery is hoisted from the reference CODE artifact
// (reference/sdlc/code.playbook/code.playbook.ts) verbatim where possible;
// its behavior tests are the equivalence proof. Do not change observable
// behavior here without consulting those suites.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import type {
  AnyStateMachine,
  EventObject,
  InspectionEvent,
  PromiseActorLogic,
} from 'xstate';
import {
  createAcceptedOutcomeConsumer,
  type AcceptedOutcomeReceipt,
} from './accepted-outcome.js';
import {
  assertPlaybookRuntimeSnapshot,
  assertPlaybookEffectLedger,
  combineAbortSignals,
  createNestedPlaybookBridge,
  detachPersistedMachineSnapshot,
  normalizeError,
  normalizePlaybookSnapshot,
  snapshotJsonValue,
  snapshotPlaybookSession,
  emptyPlaybookEffectLedger,
  isPlaybookEffectLedgerMonotonicExtension,
  PlaybookSemanticCandidateStructureError,
  reconcilePlaybookSemanticEvidence,
  validateCaptainResult,
  validatePlayerResult,
  waitForPlaybookQuiescence,
} from './xstate-runtime.js';
import type {
  CaptainResult,
  JsonValue,
  PlaybookAdoptionContext,
  PlaybookCallResult,
  PlaybookControlAction,
  PlaybookControlReceipt,
  PlaybookControlView,
  PlaybookEffectBoundary,
  PlaybookEffectBoundaryStart,
  PlaybookEffectLedger,
  PlaybookEffectLedgerCapability,
  PlaybookEffectLogicalOperation,
  PlaybookPendingBossQuestion,
  PlaybookPorts,
  PlaybookRepositoryReceipt,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
  PlaybookSuspendedCall,
  PlaybookTraceEvent,
  PlaybookTraceType,
  PlayerResult,
} from './runtime.js';

// ---------------------------------------------------------------------------
// Structural actor-input contracts. FSM artifacts declare richer types; the
// factory needs only these fields, so any gears2fsm-produced input type is
// assignable by width subtyping.
// ---------------------------------------------------------------------------

export interface PlaybookPendingBossQuestionContext {
  questionId: string;
  resumeStateId: string;
  sourceItem: string;
  asker: { kind: 'captain' } | { kind: 'role'; roleId: string };
  question: string;
}

export interface PlaybookPlayerInput {
  stateId: string;
  role: string;
  sourceItem: string;
  prompt: string;
  result: Readonly<Record<string, string>>;
  pendingBossQuestion?: { readonly question: string };
  bossReply?: string;
}

export interface PlaybookCaptainInput {
  stateId: string;
  sourceItem: string;
  prompt: string;
  result: Readonly<Record<string, string>>;
  allowedTools?: readonly string[];
  pendingBossQuestion?: { readonly question: string };
  bossReply?: string;
}

export interface PlaybookScriptInput {
  stateId: string;
  sourceItem: string;
  command: string;
  result: Readonly<Record<string, string>>;
}

/** Adjudicated actor output: the selected guard plus payload fields. */
export type PlaybookActorOutput = Record<string, unknown> & { guard: string };

export type JudgePurpose =
  | 'boss-input-classification'
  | 'player-output-adjudication'
  | 'captain-output-adjudication';

/**
 * Traced runtime boundary used by the provided actors. The factory's runtime
 * implements it; standalone helpers accept it optionally so verification can
 * exercise composition/adjudication without a live runtime.
 */
export interface RuntimeBoundaryCalls {
  callPlayer(
    input: PlaybookPlayerInput,
    roleId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<PlayerResult>;
  /**
   * Return the host-acknowledged adjudication performed while a governed
   * repository claim was still held. The value is consumable once.
   */
  takeGovernedPlayerOutput?(
    result: PlayerResult,
  ): GovernedPlayerSettlement | undefined;
  recordGovernedPlayerOutput?(
    result: PlayerResult,
    output: PlaybookActorOutput,
  ): void;
  callJudge(
    purpose: JudgePurpose,
    stateId: string | undefined,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string>;
  callCaptain?(
    input: PlaybookCaptainInput,
    prompt: string,
    signal: AbortSignal,
    callOptions?: XStateCaptainCallOptions,
  ): Promise<CaptainResult>;
}

/** Host-acknowledged outcome of one governed player reconciliation. */
type GovernedPlayerSettlement =
  | {
      readonly status: 'resolved';
      readonly output: PlaybookActorOutput;
    }
  | {
      readonly status: 'unresolved';
      readonly error: unknown;
    };

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

export const BOSS_REPLY_ERRORS = {
  missingQuestion: "needsBossReply outcome missing 'question' field",
  unregisteredState: (stateId: string) =>
    `state ${stateId} declared needsBossReply but is not registered as resumable`,
} as const;

// ---------------------------------------------------------------------------
// A host agent result that is not `ok` (or is `ok` with no final text) is a
// recoverable FSM failure, not a control-plane error: it travels the invoked
// actor's XState error path to the failure state and the public boundary
// resolves `failed` (PBRT-47, matching the player boundary's PBRT-9). The
// direct-Captain boundary has to emit its paired finish trace before
// rethrowing, so it needs to tell that failure apart from the control-plane
// errors it does latch — a thrown port, a malformed result, a rejecting sink.
// ---------------------------------------------------------------------------

const fsmResultFailures = new WeakSet<object>();

function markFsmResultFailure(error: Error): Error {
  fsmResultFailures.add(error);
  return error;
}

function isFsmResultFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    fsmResultFailures.has(error as object)
  );
}

// ---------------------------------------------------------------------------
// DR-028: both call boundaries treat an `ok` result whose `finalText` is
// missing, empty, or whitespace-only under one empty predicate, and that
// shape earns exactly one corrective re-ask — the same composed call
// re-issued once through the same boundary — before a second such result
// follows the existing failure path. The retry marker distinguishes the
// re-askable empty-`ok` Captain failure from the never-retried non-`ok`
// statuses; it is applied only when the failure's finish trace emitted
// cleanly, because a rejecting finish sink is a control-plane error whose
// turn gets no corrective re-ask (PBRT-47).
// ---------------------------------------------------------------------------

function isEmptyFinalText(finalText: string | undefined): boolean {
  return finalText === undefined || finalText.trim().length === 0;
}

const emptyOkRetryFailures = new WeakSet<object>();
const HOST_CAPABILITIES_OPTION_KEY = 'hostCapabilities';
const UNRESOLVED_EFFECT_RECONCILIATION_ACTION_ID =
  'reconcile:unresolved-effect';
const UNRESOLVED_EFFECT_ABANDONMENT_ACTION_ID = 'abandon:unresolved-effect';

interface DeferredValue<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
  readonly operation:
    | XStateRepositoryOperationSettlement<T>
    | XStateRepositoryOperationRejection;
  readonly receipt: PlaybookRepositoryReceipt;
  /** Physical receipt for an ordinary call; cumulative receipt for a chain. */
  readonly outcomeReceipt: PlaybookRepositoryReceipt;
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
  readonly operation:
    | XStateRepositoryOperationSettlement<T>
    | XStateRepositoryOperationRejection;
  readonly receipt: PlaybookRepositoryReceipt;
  readonly effectLedger: PlaybookEffectLedger;
  readonly deferredStatus?: 'bound' | 'unresolved';
}

interface XStateRepositoryDeferredContinuationResult<T> {
  readonly status: 'continued';
  readonly operation:
    | XStateRepositoryOperationSettlement<T>
    | XStateRepositoryOperationRejection;
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

type XStateEffectBoundarySeed = Omit<
  PlaybookEffectBoundaryStart,
  'playbookId' | 'canonicalWorktree' | 'baseline' | 'cohortId'
>;

export interface XStateRepositoryCapability {
  runExclusive<T>(options: {
    readonly signal: AbortSignal;
    readonly effectBoundary: XStateEffectBoundarySeed;
    readonly operation: (context: {
      readonly baseline: PlaybookRepositoryReceipt['baseline'];
      readonly identity: unknown;
    }) => Promise<T>;
    readonly completeEffectBoundary: (
      completion: XStateRepositoryExclusiveCompletion<T>,
    ) => XStateRepositoryCompletionEvidence | Promise<XStateRepositoryCompletionEvidence>;
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
    readonly completeEffectBoundary: (
      completion: XStateRepositoryExclusiveCompletion<T>,
    ) => XStateRepositoryCompletionEvidence | Promise<XStateRepositoryCompletionEvidence>;
  }): Promise<
    | XStateRepositoryDeferredContinuationResult<T>
    | XStateRepositoryDeferredCheckpointMismatch
  >;
  runDeferred(options: {
    readonly mode: 'park' | 'restore';
    readonly signal: AbortSignal;
    readonly operationId: string;
  }): Promise<XStateRepositoryDeferredParked | XStateRepositoryDeferredRestoreResult>;
}

function assertNoConfiguredHostCapabilities(value: unknown, label: string): void {
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, HOST_CAPABILITIES_OPTION_KEY)
  ) {
    throw new TypeError(
      `${label} configured options must not contain hostCapabilities`,
    );
  }
}

function configuredOptionsFromFactoryInput(
  value: unknown,
  artifactSchema: number,
  label: string,
): {
  readonly configuredOptions: unknown;
  readonly hostCapabilities?: object;
  readonly effectLedger?: PlaybookEffectLedgerCapability;
} {
  if (artifactSchema === 2) {
    assertNoConfiguredHostCapabilities(value, label);
    return { configuredOptions: value };
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(
      `${label} schema-3 factory input must be a plain object`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('configuredOptions') ||
    !keys.includes(HOST_CAPABILITIES_OPTION_KEY) ||
    keys.some((key) => {
      const descriptor = descriptors[key as keyof typeof descriptors];
      return (
        descriptor?.get !== undefined ||
        descriptor?.set !== undefined ||
        descriptor?.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      );
    })
  ) {
    throw new TypeError(
      `${label} schema-3 factory input must contain exactly configuredOptions and hostCapabilities data properties`,
    );
  }
  const hostCapabilities = descriptors.hostCapabilities!.value;
  if (
    hostCapabilities === null ||
    typeof hostCapabilities !== 'object' ||
    Array.isArray(hostCapabilities)
  ) {
    throw new TypeError(
      `${label} schema-3 factory input hostCapabilities must be a live object`,
    );
  }
  const configuredOptions = descriptors.configuredOptions!.value;
  assertNoConfiguredHostCapabilities(configuredOptions, label);
  const ledgerDescriptor = Object.getOwnPropertyDescriptor(
    hostCapabilities,
    'effectLedger',
  );
  if (
    ledgerDescriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(ledgerDescriptor, 'value') ||
    ledgerDescriptor.get !== undefined ||
    ledgerDescriptor.set !== undefined
  ) {
    throw new TypeError(
      `${label} schema-3 factory input hostCapabilities.effectLedger must be an own data property`,
    );
  }
  const effectLedger = ledgerDescriptor.value;
  if (
    effectLedger === null ||
    typeof effectLedger !== 'object' ||
    Array.isArray(effectLedger) ||
    typeof (effectLedger as { snapshot?: unknown }).snapshot !== 'function' ||
    typeof (effectLedger as { writeAhead?: unknown }).writeAhead !== 'function'
  ) {
    throw new TypeError(
      `${label} schema-3 factory input hostCapabilities.effectLedger must expose snapshot and writeAhead functions`,
    );
  }
  return {
    configuredOptions,
    hostCapabilities,
    effectLedger: effectLedger as PlaybookEffectLedgerCapability,
  };
}

function repositoryCapabilityFromHostCapabilities(
  hostCapabilities: object | undefined,
  label: string,
): XStateRepositoryCapability {
  const descriptor =
    hostCapabilities === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(hostCapabilities, 'repository');
  const repository = descriptor?.value;
  if (
    descriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    repository === null ||
    typeof repository !== 'object' ||
    Array.isArray(repository) ||
    typeof (repository as { runExclusive?: unknown }).runExclusive !==
      'function' ||
    typeof (repository as { runDeferred?: unknown }).runDeferred !== 'function'
  ) {
    throw new TypeError(
      `${label} schema-3 factory input hostCapabilities.repository must be an own data property exposing runExclusive and runDeferred`,
    );
  }
  return repository as XStateRepositoryCapability;
}

function markEmptyOkRetryFailure(error: Error): Error {
  emptyOkRetryFailures.add(error);
  return error;
}

function isEmptyOkRetryFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    emptyOkRetryFailures.has(error as object)
  );
}

// ---------------------------------------------------------------------------
// DR-022: the engine's compatibility self-report. A linked thin module
// records the values current at link time in `spec.compat`; the factory
// checks that declaration against this very module — the engine instance
// that will interpret the FSM, so the check can never consult a different
// engine copy than the one executing — and fails construction on a mismatch
// instead of misbehaving deep in a session. Raising RUNTIME_ABI or removing
// a member of SUPPORTED_ARTIFACT_SCHEMAS is a breaking change (RELEASE-15).
// ---------------------------------------------------------------------------

/** The runtime ABI this engine implements (DR-022). */
export const RUNTIME_ABI = 1;

/** The linked-artifact schema versions this engine accepts (DR-022). */
export const SUPPORTED_ARTIFACT_SCHEMAS: readonly number[] = Object.freeze([
  2,
  3,
]);

/** A linked artifact's declared link-time compatibility values (DR-022). */
export interface XStatePlaybookRuntimeCompat {
  /** The artifact schema version the linker emitted. */
  artifactSchema: number;
  /** The engine ABI the artifact was linked against. */
  runtimeAbi: number;
}

/** Authority for one schema-3 delegated-player outcome payload field. */
export type XStateOutcomeFieldAuthority =
  | 'presentation'
  | 'semantic'
  | 'effect'
  | 'runtime';

/** Repository disposition required by one schema-3 outcome arm. */
export type XStateRepositoryDisposition =
  | 'unchanged'
  | 'one-descendant-commit'
  | 'deferred';

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
  readonly governedPlayerStates: Readonly<
    Record<string, Readonly<Record<string, XStateGovernedOutcomeSpec>>>
  >;
}

/**
 * Schema-3 factory input composed by a registry from persisted configured
 * options and live current-host capabilities. The engine snapshots only the
 * first member and never places the second in machine input or persistence.
 */
export interface XStatePlaybookRuntimeConstruction<
  ConfiguredOptions,
  HostCapabilities extends object,
> {
  readonly configuredOptions: ConfiguredOptions;
  readonly hostCapabilities: HostCapabilities & {
    readonly repository: XStateRepositoryCapability;
    readonly effectLedger: PlaybookEffectLedgerCapability;
  };
}

export type XStatePlaybookRuntimeFactoryOptions<
  ConfiguredOptions,
  HostCapabilities extends object,
> = [HostCapabilities] extends [never]
  ? ConfiguredOptions
  : XStatePlaybookRuntimeConstruction<ConfiguredOptions, HostCapabilities>;

/** Shared XState factory with its captured, validated artifact compatibility. */
export type XStatePlaybookRuntimeFactory<
  Options = unknown,
  ArtifactSchema extends 2 | 3 = 2 | 3,
> = PlaybookRuntimeFactory<Options> & {
  readonly compat: Readonly<{
    readonly artifactSchema: ArtifactSchema;
    readonly runtimeAbi: typeof RUNTIME_ABI;
  }>;
};

// PBRT-50: validate a declaration against the loaded engine, schema first,
// so one clear diagnostic covers a fully skewed artifact. Declaration-free
// artifacts are schema 1 and cannot be interpreted as local-role artifacts.
function assertRuntimeCompat(
  compat: XStatePlaybookRuntimeCompat | undefined,
  label: string,
): 2 | 3 {
  if (compat === undefined) {
    throw new TypeError(
      `${label} spec.compat is required for local-role artifacts`,
    );
  }
  if (compat === null || typeof compat !== 'object') {
    throw new TypeError(`${label} spec.compat must be an object`);
  }
  const { artifactSchema, runtimeAbi } = compat;
  if (!Number.isSafeInteger(artifactSchema)) {
    throw new TypeError(
      `${label} spec.compat.artifactSchema must be an integer`,
    );
  }
  if (!Number.isSafeInteger(runtimeAbi)) {
    throw new TypeError(`${label} spec.compat.runtimeAbi must be an integer`);
  }
  if (!SUPPORTED_ARTIFACT_SCHEMAS.includes(artifactSchema)) {
    throw new TypeError(
      `${label} artifact declares schema ${artifactSchema}, but this ` +
        `@sublang/playbook/xstate-runtime engine supports ` +
        `[${SUPPORTED_ARTIFACT_SCHEMAS.join(', ')}]`,
    );
  }
  if (runtimeAbi !== RUNTIME_ABI) {
    throw new TypeError(
      `${label} artifact declares runtime ABI ${runtimeAbi}, but this ` +
        `@sublang/playbook/xstate-runtime engine implements ${RUNTIME_ABI}`,
    );
  }
  return artifactSchema as 2 | 3;
}

// ---------------------------------------------------------------------------
// The per-workflow spec. Every strategy member has a generic default derived
// from the FSM artifact's own data, so a linker-emitted thin module normally
// supplies only `snapshotOptions` and, where applicable, `compat`,
// `entryEvent`, erased Boss-event field metadata, placeholder exceptions, and
// transition-event fields. Hand-maintained artifacts may override any member
// to preserve their existing observable behavior exactly.
// ---------------------------------------------------------------------------

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
  callCaptain(
    prompt: string,
    callOptions?: XStateCaptainCallOptions,
  ): Promise<CaptainResult>;
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

export type XStateCaptainStrategy<TOptions> = (
  run: XStateCaptainStrategyRun<TOptions>,
) => Promise<PlaybookActorOutput>;

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
  classifyBossText?: (
    text: string,
    ports: PlaybookPorts,
    signal: AbortSignal,
    snapshotOrState: unknown,
    boundary?: RuntimeBoundaryCalls,
    options?: TOptions,
  ) => Promise<EventObject | undefined>;
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
  composePlayerPrompt?: (
    input: PlaybookPlayerInput,
    promptIdentity: XStatePromptIdentity,
  ) => string;
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
  statusesForState?: (
    state: PlaybookState,
    context: Record<string, unknown>,
    event: unknown,
  ) => readonly ScheduledStatus[];
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
export interface XStatePlaybookRuntimeSpec<TOptions>
  extends XStatePlaybookRuntimeSpecBase<TOptions> {
  compat?: XStatePlaybookRuntimeCompat;
  outcomeAuthority?: never;
}

/** Exact schema-2 shared-engine spec; its one-argument factory is intact. */
export interface XStatePlaybookRuntimeSpecV2<TOptions>
  extends XStatePlaybookRuntimeSpec<TOptions> {
  compat: XStatePlaybookRuntimeCompat & { artifactSchema: 2 };
}

/** Schema-3 shared-engine spec with required exact outcome authority metadata. */
export interface XStatePlaybookRuntimeSpecV3<TOptions>
  extends XStatePlaybookRuntimeSpecBase<TOptions> {
  compat: XStatePlaybookRuntimeCompat & { artifactSchema: 3 };
  outcomeAuthority: XStateOutcomeAuthoritySpec;
}

type UncheckedXStatePlaybookRuntimeSpec<TOptions> =
  XStatePlaybookRuntimeSpecBase<TOptions> & {
    compat?: XStatePlaybookRuntimeCompat;
    outcomeAuthority?: XStateOutcomeAuthoritySpec;
  };

// ---------------------------------------------------------------------------
// Tolerant judge-JSON recovery (slc/link.md §Boss-event mapping).
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip a single Markdown code fence that wraps the whole string. */
export function stripCodeFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : text;
}

function dropTrailingComma(out: string): string {
  return out.replace(/,(\s*)$/, '$1');
}

// Scan from `start` (a `{`/`[` index), tracking string and bracket-nesting
// state, and emit the balanced JSON value rooted there. With `repair` false
// the span is returned only if it actually closes; with `repair` true a
// trailing comma, an unterminated string, and unclosed brackets are fixed.
export function extractJsonValue(
  text: string,
  start: number,
  repair: boolean,
): string | undefined {
  const stack: string[] = [];
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (repair) out = dropTrailingComma(out);
      out += ch;
      stack.pop();
      if (stack.length === 0) return out; // top-level value complete
      continue;
    }
    out += ch;
  }
  // End of input before the top-level value closed.
  if (!repair) return undefined; // strict pass: no balanced span here
  if (inString) out += '"';
  out = dropTrailingComma(out);
  while (stack.length > 0) out += stack.pop();
  return out;
}

// Tolerant recovery shared by the classifier and adjudicator: prefer a strict
// balanced span at the earliest opening brace, then its repair, before
// advancing to a later candidate. The first plain object wins; the first
// value of any shape is remembered so a legitimately array/scalar reply still
// surfaces to the caller's own object check.
export function parseJudgeJson(raw: string): unknown {
  const fenced = stripCodeFence(raw.trim());
  // Fast path: a well-formed (optionally fenced) JSON body.
  try {
    return JSON.parse(fenced);
  } catch {
    // Fall through to lenient extraction + repair.
  }
  const starts: number[] = [];
  for (let i = 0; i < fenced.length; i++) {
    const ch = fenced[i];
    if (ch === '{' || ch === '[') starts.push(i);
  }
  let firstValue: { value: unknown } | undefined;
  for (const start of starts) {
    let parsedHere: { value: unknown } | undefined;
    for (const repair of [false, true]) {
      const candidate = extractJsonValue(fenced, start, repair);
      if (candidate === undefined) continue;
      try {
        parsedHere = { value: JSON.parse(candidate) };
      } catch {
        continue; // not parseable this way — try repair, then next start
      }
      break; // prefer the strict span at this start over its repair
    }
    if (parsedHere === undefined) continue;
    if (isPlainObject(parsedHere.value)) return parsedHere.value;
    if (firstValue === undefined) firstValue = parsedHere;
  }
  if (firstValue !== undefined) return firstValue.value;
  throw new Error('adjudicate: judge response is not valid JSON');
}

// ---------------------------------------------------------------------------
// Shared error/context helpers.
// ---------------------------------------------------------------------------

export function normalizeErrorCompact(
  err: unknown,
): { name: string; message: string } | undefined {
  if (err === undefined || err === null) return undefined;
  const normalized = normalizeError(err);
  return { name: normalized.name, message: normalized.message };
}

export function normalizeErrorFull(
  err: unknown,
): { name: string; message: string; stack?: string } | undefined {
  if (err === undefined || err === null) return undefined;
  return normalizeError(err);
}

// slc/link.md §Abort: cancellation is causal identity with the applicable
// signal's reason — never an `AbortError` name, never bare signal state. A
// distinct failure observed while the signal is aborted stays a non-abort
// control error and takes precedence (mirrors DECIDE's bespoke reference).
function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && Object.is(error, signal.reason);
}

interface AbortReasonClassifier {
  isAbortReason(error: unknown): boolean;
}

function abortReasonClassifier(
  ...sources: readonly (AbortSignal | AbortReasonClassifier | undefined)[]
): AbortReasonClassifier {
  const captured = sources.filter(
    (source): source is AbortSignal | AbortReasonClassifier =>
      source !== undefined,
  );
  return Object.freeze({
    isAbortReason: (error: unknown): boolean =>
      captured.some((source) =>
        source instanceof AbortSignal
          ? isAbortFailure(error, source)
          : source.isAbortReason(error),
      ),
  });
}

/**
 * gears2fsm's canonical Boss-reply wait state. On the runtime's Boss-facing
 * surfaces — state telemetry, status lines, the exported snapshot, and the
 * control view — a context question counts as *pending* only while the
 * machine sits in this state awaiting the reply. Later states retain the
 * answered question in context (the resumed player prompt is composed from
 * it), so an unconditional projection would resurrect it: a failure the
 * resumed player reached would export a question nobody is waiting on,
 * disagreeing with the gated telemetry a mirroring host's ledger follows
 * and failing the shell's snapshot-equality settlement check.
 */
const BOSS_REPLY_WAIT_STATE_ID = 'awaitBossReply';

function pendingBossQuestionForState(
  state: PlaybookState,
  context: Record<string, unknown>,
): PlaybookPendingBossQuestionContext | undefined {
  if (state.stateId !== BOSS_REPLY_WAIT_STATE_ID) return undefined;
  return pendingBossQuestionFromContext(context);
}

/** Read the FSM context's single pending Boss question, when well-formed. */
export function pendingBossQuestionFromContext(
  context: Record<string, unknown>,
): PlaybookPendingBossQuestionContext | undefined {
  const pending = context.pendingBossQuestion;
  if (
    pending === undefined ||
    pending === null ||
    typeof pending !== 'object'
  ) {
    return undefined;
  }
  const candidate = pending as Partial<
    Record<keyof PlaybookPendingBossQuestionContext, unknown>
  >;
  if (
    typeof candidate.questionId !== 'string' ||
    typeof candidate.resumeStateId !== 'string' ||
    typeof candidate.sourceItem !== 'string' ||
    !isPlainObject(candidate.asker) ||
    typeof candidate.question !== 'string'
  ) {
    return undefined;
  }
  let asker: PlaybookPendingBossQuestionContext['asker'];
  if (candidate.asker.kind === 'captain') {
    if (Object.keys(candidate.asker).some((key) => key !== 'kind')) {
      return undefined;
    }
    asker = { kind: 'captain' };
  } else if (
    candidate.asker.kind === 'role' &&
    typeof candidate.asker.roleId === 'string' &&
    candidate.asker.roleId.trim().length > 0 &&
    Object.keys(candidate.asker).every(
      (key) => key === 'kind' || key === 'roleId',
    )
  ) {
    asker = { kind: 'role', roleId: candidate.asker.roleId };
  } else {
    return undefined;
  }
  return {
    questionId: candidate.questionId,
    resumeStateId: candidate.resumeStateId,
    sourceItem: candidate.sourceItem,
    asker,
    question: candidate.question,
  };
}

// ---------------------------------------------------------------------------
// Generic strategy defaults.
// ---------------------------------------------------------------------------

const CONTINUATION_PREAMBLE =
  'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';

function continuationBlocks(input: {
  pendingBossQuestion?: { readonly question: string };
  bossReply?: string;
}): string[] {
  if (input.pendingBossQuestion === undefined || input.bossReply === undefined) {
    return [];
  }
  return [
    CONTINUATION_PREAMBLE,
    `Boss question:\n${input.pendingBossQuestion.question}`,
    `Boss reply:\n${input.bossReply}`,
  ];
}

const PLACEHOLDER_PATTERN = /<(#|[A-Za-z_$][A-Za-z0-9_$-]*)>/g;

function placeholderFieldName(
  token: string,
  fields: Readonly<Record<string, string>>,
): string {
  const explicit = fields[token];
  if (explicit !== undefined) return explicit;
  if (token === '#') return 'irNumber';
  return token.replace(/-([A-Za-z0-9])/g, (_match, next: string) =>
    next.toUpperCase(),
  );
}

/**
 * Default player-prompt composer (slc/link.md §Player prompt composition).
 * One callback-based pass substitutes each `<fieldName>` placeholder whose
 * typed input field is a string; replacement text is literal, and
 * placeholder-looking text inside a value is never re-substituted. The
 * continuation preamble and Q/A blocks precede the domain body on resume.
 */
export function defaultComposePlayerPrompt(
  input: PlaybookPlayerInput,
  placeholderFields: Readonly<Record<string, string>> = {},
): string {
  const blocks = continuationBlocks(input);
  const fields = input as unknown as Record<string, unknown>;
  const body = input.prompt.replace(PLACEHOLDER_PATTERN, (match, token) => {
    const value =
      fields[placeholderFieldName(token as string, placeholderFields)];
    return typeof value === 'string' ? value : match;
  });
  blocks.push(body);
  return blocks.join('\n\n');
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry));
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: JsonValue };
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJson(record[key]);
    }
    return sorted;
  }
  return value;
}

function stableJson(value: unknown, path: string): string {
  return JSON.stringify(sortJson(snapshotJsonValue(value, path)));
}

// DR-040 task 8: a retained checkpoint authorizes adoption without a replay
// fence only when the authoritative ledger preserves the checkpoint exactly,
// has made no deferred-operation progress, and every later physical boundary
// is complete and proves `unchanged`. This is intentionally the same
// fail-closed shape as uncertain whole-turn replay.
function retainedAdoptionCheckpointIsSafe(
  checkpoint: PlaybookEffectLedger,
  current: PlaybookEffectLedger,
): boolean {
  if (
    checkpoint.boundaries.some(
      ({ physicalReceipt }) => physicalReceipt === undefined,
    )
  ) {
    return false;
  }
  if (!isPlaybookEffectLedgerMonotonicExtension(checkpoint, current)) {
    return false;
  }
  if (
    !isDeepStrictEqual(
      current.boundaries.slice(0, checkpoint.boundaries.length),
      checkpoint.boundaries,
    ) ||
    !isDeepStrictEqual(
      current.logicalOperations,
      checkpoint.logicalOperations,
    )
  ) {
    return false;
  }
  return current.boundaries
    .slice(checkpoint.boundaries.length)
    .every(
      ({ physicalReceipt }) =>
        physicalReceipt?.classification === 'unchanged',
    );
}

const RETAINED_EFFECT_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireAdoptionIdentity(
  value: JsonValue | undefined,
  path: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

// DR-038 §5: capture the host-owned source lineage before adoption binds
// anything. The retained stack already carries both identities: a frame's
// sessionId names its source runtime, while the common rootSessionId names the
// retained generation. A suspended parent also needs the host's freshly
// allocated target child id so its bridge can be re-keyed without leaking a
// source-session id into the new engagement.
function snapshotAdoptionContext(
  value: PlaybookAdoptionContext | undefined,
  targetSession: PlaybookSession,
  sourceSnapshot: PlaybookRuntimeSnapshot,
): Readonly<PlaybookAdoptionContext> {
  const captured = snapshotJsonValue(value, 'playbook adoption context');
  if (
    captured === null ||
    Array.isArray(captured) ||
    typeof captured !== 'object'
  ) {
    throw new TypeError('playbook adoption context must be an object');
  }
  const fields = captured as { readonly [key: string]: JsonValue };
  const hasSuspendedCall = sourceSnapshot.suspendedCall !== undefined;
  const expectedKeys = [
    'sourceGenerationId',
    'sourceSessionId',
    ...(hasSuspendedCall ? ['targetChildSessionId'] : []),
  ].sort();
  const actualKeys = Object.keys(fields).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `playbook adoption context must contain exactly ${expectedKeys.join(', ')}`,
    );
  }

  const sourceSessionId = requireAdoptionIdentity(
    fields.sourceSessionId,
    'playbook adoption context sourceSessionId',
  );
  const sourceGenerationId = requireAdoptionIdentity(
    fields.sourceGenerationId,
    'playbook adoption context sourceGenerationId',
  );
  const sourceIsRoot = sourceSessionId === sourceGenerationId;
  if ((targetSession.depth === 0) !== sourceIsRoot) {
    throw new TypeError(
      'playbook adoption context source identities do not match the target frame depth',
    );
  }

  const targetChildSessionId = hasSuspendedCall
    ? requireAdoptionIdentity(
        fields.targetChildSessionId,
        'playbook adoption context targetChildSessionId',
      )
    : undefined;
  const sourceIds = new Set([
    sourceSessionId,
    sourceGenerationId,
    ...(sourceSnapshot.suspendedCall === undefined
      ? []
      : [sourceSnapshot.suspendedCall.childSessionId]),
  ]);
  const targetIds = [
    targetSession.sessionId,
    targetSession.rootSessionId,
    ...(targetSession.parentSessionId === undefined
      ? []
      : [targetSession.parentSessionId]),
    ...(targetChildSessionId === undefined ? [] : [targetChildSessionId]),
  ];
  if (targetIds.some((identity) => sourceIds.has(identity))) {
    throw new TypeError(
      'playbook adoption target identities must be fresh from the source generation',
    );
  }
  if (
    targetChildSessionId !== undefined &&
    (targetChildSessionId === targetSession.sessionId ||
      targetChildSessionId === targetSession.rootSessionId ||
      targetChildSessionId === targetSession.parentSessionId)
  ) {
    throw new TypeError(
      'playbook adoption targetChildSessionId must name a fresh child frame',
    );
  }

  return Object.freeze({
    sourceSessionId,
    sourceGenerationId,
    ...(targetChildSessionId === undefined ? {} : { targetChildSessionId }),
  });
}

/**
 * Default direct-Captain prompt composer (slc/link.md §Captain prompt
 * composition). Placeholder substitution is presence-based: string fields
 * substitute verbatim; JSON-safe arrays/objects render as deterministic JSON
 * with lexicographically sorted keys at every depth.
 */
export function defaultComposeCaptainPrompt(
  input: PlaybookCaptainInput,
  placeholderFields: Readonly<Record<string, string>> = {},
): string {
  const blocks = continuationBlocks(input);
  const fields = input as unknown as Record<string, unknown>;
  const body = input.prompt.replace(PLACEHOLDER_PATTERN, (match, token) => {
    const field = placeholderFieldName(token as string, placeholderFields);
    const value = fields[field];
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object') {
      return stableJson(value, `CaptainInput.${field}`);
    }
    return match;
  });
  blocks.push(body);
  return blocks.join('\n\n');
}

/**
 * Default required-field extraction (slc/link.md §Captain adjudication).
 * Limited to the description's `Output shall include` / `输出应包含` clause;
 * recognizes both the bare backticked name and the annotated `name: <...>`
 * form.
 */
export function defaultExtractRequiredFields(description: string): string[] {
  const markers = ['Output shall include', '输出应包含'];
  let clauseStart = -1;
  for (const marker of markers) {
    const idx = description.indexOf(marker);
    if (idx !== -1) {
      clauseStart = idx + marker.length;
      break;
    }
  }
  if (clauseStart === -1) return [];
  const clause = description.slice(clauseStart);
  const fields: string[] = [];
  const re = /`([A-Za-z_$][A-Za-z0-9_$]*)(?::[^`]*)?`/g;
  for (const m of clause.matchAll(re)) fields.push(m[1]);
  return fields;
}

/** Default delegated-player adjudicator prompt. */
export function defaultBuildJudgePrompt(
  input: PlaybookPlayerInput,
  finalText: string,
): string {
  const lines: string[] = [];
  lines.push(
    'This is hidden control work. Do not call tools, inspect files, or ' +
      'seek external evidence. Decide only from the supplied player output ' +
      'and outcome descriptions. Reply with exactly one JSON object and no prose.',
  );
  lines.push('');
  lines.push(`The ${input.role} role just produced this output:`);
  lines.push('');
  lines.push('```');
  lines.push(finalText);
  lines.push('```');
  lines.push('');
  lines.push(
    'Pick exactly one outcome by `guard` and return JSON ' +
      '`{ guard, …payloadFields }`. Required payload fields are named in the ' +
      'outcome description after "Output shall include" / "输出应包含".',
  );
  lines.push('');
  for (const [key, description] of Object.entries(input.result)) {
    lines.push(`- \`${key}\` — ${description}`);
  }
  return lines.join('\n');
}

function buildGovernedJudgePrompt(
  input: PlaybookPlayerInput,
  finalText: string,
  outcomes: Readonly<Record<string, XStateGovernedOutcomeSpec>>,
  correction?: { readonly reply: string; readonly error: string },
): string {
  const lines = [
    'This is hidden control work. Do not call tools, inspect files, or seek external evidence.',
    'Decide only from the supplied player output and declared outcomes.',
    'Reply with exactly one JSON object and no prose.',
    '',
    `The ${input.role} role just produced this output:`,
    '',
    '```',
    finalText,
    '```',
    '',
    'Pick exactly one declared `guard`. Include every semantic-owned field for that guard and no other field.',
    'Do not include presentation-, effect-, or runtime-owned fields; the runtime supplies those from their authoritative evidence.',
    '',
  ];
  for (const [guard, description] of Object.entries(input.result)) {
    const semanticFields = Object.entries(outcomes[guard]?.fields ?? {})
      .filter(([, authority]) => authority === 'semantic')
      .map(([field]) => field);
    lines.push(
      `- \`${guard}\` — semantic fields: ${
        semanticFields.length === 0
          ? '(none)'
          : semanticFields.map((field) => `\`${field}\``).join(', ')
      }; ${description}`,
    );
  }
  if (correction !== undefined) {
    lines.push(
      '',
      'Your first reply was structurally invalid:',
      '',
      '```',
      correction.reply,
      '```',
      '',
      `Validation error: ${correction.error}`,
      'Correct only that structure using the same player output and outcome schema.',
    );
  }
  return lines.join('\n');
}

function parseGovernedSemanticCandidate(raw: string): unknown {
  try {
    return parseJudgeJson(raw);
  } catch (error) {
    throw new PlaybookSemanticCandidateStructureError(
      error instanceof Error ? error.message : 'reply is not valid JSON',
    );
  }
}

// ---------------------------------------------------------------------------
// Player adjudication (slc/link.md §Captain adjudication).
// ---------------------------------------------------------------------------

export interface PlayerAdjudicationSpec {
  buildJudgePrompt?: (input: PlaybookPlayerInput, finalText: string) => string;
  extractRequiredFields?: (description: string) => string[];
  verbatimPayloadFields?: ReadonlySet<string>;
}

const NO_VERBATIM_FIELDS: ReadonlySet<string> = new Set();

/**
 * LLM-judge adjudicator for delegated players. Coerces the player's
 * finalText into one of the state's declared guards, extracts every required
 * payload field from the judge reply, and fails loudly (throws) on a missing
 * JSON object, an undeclared guard, or a missing required field. Fields in
 * `verbatimPayloadFields` carry `finalText.trim()` rather than round-tripping
 * long-form prose through judge JSON.
 */
export async function adjudicatePlayerOutput(
  spec: PlayerAdjudicationSpec,
  input: PlaybookPlayerInput,
  finalText: string,
  ports: PlaybookPorts,
  signal: AbortSignal,
  boundary?: RuntimeBoundaryCalls,
): Promise<PlaybookActorOutput> {
  const buildPrompt = spec.buildJudgePrompt ?? defaultBuildJudgePrompt;
  const extractFields = spec.extractRequiredFields ?? defaultExtractRequiredFields;
  const verbatimFields = spec.verbatimPayloadFields ?? NO_VERBATIM_FIELDS;
  const prompt = buildPrompt(input, finalText);
  const raw = boundary
    ? await boundary.callJudge(
        'player-output-adjudication',
        input.stateId,
        prompt,
        signal,
      )
    : await ports.callJudge(prompt, signal);
  const parsed = parseJudgeJson(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('adjudicate: judge response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const guard = obj.guard;
  if (typeof guard !== 'string') {
    throw new Error('adjudicate: judge response missing string "guard" field');
  }
  if (!Object.prototype.hasOwnProperty.call(input.result, guard)) {
    throw new Error(
      `adjudicate: unknown guard "${guard}" — declared guards: ${Object.keys(
        input.result,
      ).join(', ')}`,
    );
  }
  const verbatim = finalText.trim();
  for (const field of extractFields(input.result[guard])) {
    if (verbatimFields.has(field)) {
      Object.defineProperty(obj, field, {
        value: verbatim,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }
    if (typeof obj[field] !== 'string') {
      if (guard === 'needsBossReply' && field === 'question') {
        throw new Error(BOSS_REPLY_ERRORS.missingQuestion);
      }
      throw new Error(
        `adjudicate: judge response missing required field "${field}" for guard "${guard}"`,
      );
    }
  }
  return obj as PlaybookActorOutput;
}

function validateBossReplyOutput(
  input: { stateId: string },
  output: PlaybookActorOutput,
  resumableStateIds: ReadonlySet<string>,
): void {
  if (output.guard !== 'needsBossReply') return;
  if (typeof output.question !== 'string') {
    throw new Error(BOSS_REPLY_ERRORS.missingQuestion);
  }
  if (!resumableStateIds.has(input.stateId)) {
    throw new Error(BOSS_REPLY_ERRORS.unregisteredState(input.stateId));
  }
}

// ---------------------------------------------------------------------------
// Delegated-player actor bridge. One PromiseActorLogic the machine invokes
// from every player-invoking state: retain the role, resolve any bound player
// identity privately, compose the prompt through the ephemeral identity lookup,
// await callPlayer, adjudicate the finalText. An `ok` result with a missing,
// empty, or whitespace-only finalText earns exactly one corrective re-ask of
// the same composed call (DR-028); a non-`ok` result, or a second such empty
// result, throws so XState routes via onError to the FSM's failure sink.
//
// `getActiveSignal` flows the Boss's public-boundary signal into the host
// port calls — fromPromise hands the bridge XState's actor-scoped signal,
// which only fires on actor.stop(), not on Boss abort.
// ---------------------------------------------------------------------------

interface PlayerBridgeSpec {
  resolveRoleId: (input: PlaybookPlayerInput) => string;
  validateInput?: (input: PlaybookPlayerInput) => void;
  composePlayerPrompt: (input: PlaybookPlayerInput) => string;
  adjudication: PlayerAdjudicationSpec;
  resumableStateIds: ReadonlySet<string>;
  allowsCorrectiveReplay?: (result: PlayerResult) => boolean;
}

export function createPlayerBridge(
  spec: PlayerBridgeSpec,
  ports: PlaybookPorts,
  getActiveSignal?: () => AbortSignal | undefined,
  boundary?: RuntimeBoundaryCalls,
  onControlPlaneError?: (error: unknown) => void,
): PromiseActorLogic<PlaybookActorOutput, PlaybookPlayerInput> {
  return fromPromise<PlaybookActorOutput, PlaybookPlayerInput>(
    async ({ input, signal }) => {
      const activeSignal = combineAbortSignals(signal, getActiveSignal?.());
      let roleId: string;
      let prompt: string;
      try {
        spec.validateInput?.(input);
        roleId = spec.resolveRoleId(input);
        prompt = spec.composePlayerPrompt(input);
      } catch (error) {
        if (!isAbortFailure(error, activeSignal)) {
          onControlPlaneError?.(error);
        }
        throw error;
      }
      const callPlayer = (resume: string | false) =>
        boundary
          ? boundary.callPlayer(
              input,
              roleId,
              prompt,
              activeSignal,
            )
          : ports.callPlayer(roleId, prompt, activeSignal, { resume });
      let result = await callPlayer(false);
      if (
        result.status === 'ok' &&
        isEmptyFinalText(result.finalText) &&
        (spec.allowsCorrectiveReplay?.(result) ?? true)
      ) {
        // An abort that lands between the empty first result and the
        // corrective call ends the turn as ordinary abort settlement with
        // no second host call — aborts are never retried (DR-028 via
        // DR-025's transport exclusion) — matching the direct-Captain
        // boundary, whose queued corrective call re-checks the signal
        // before starting.
        activeSignal.throwIfAborted();
        // DR-028: exactly one corrective re-ask of the same composed call
        // through the same path, traced by the boundary as its own
        // player-call pair. The traced boundary re-reads its token map
        // (PBRT-38), so the corrective call continues the player session
        // when the first result carried a resume token and starts fresh
        // when it cleared one; the portless verification path mirrors that
        // by carrying the first result's token.
        result = await callPlayer(
          typeof result.resumeToken === 'string' &&
            result.resumeToken.trim().length > 0
            ? result.resumeToken
            : false,
        );
      }
      if (result.status !== 'ok') {
        throw new Error(
          result.error ?? `captainBridge: callPlayer status "${result.status}"`,
        );
      }
      const finalText = result.finalText ?? '';
      if (isEmptyFinalText(finalText)) {
        throw new Error(
          'captainBridge: callPlayer returned status=ok with no finalText',
        );
      }
      try {
        const governed = boundary?.takeGovernedPlayerOutput?.(result);
        if (governed?.status === 'unresolved') {
          throw governed.error;
        }
        const output =
          governed?.status === 'resolved'
            ? governed.output
            : await adjudicatePlayerOutput(
                spec.adjudication,
                input,
                finalText,
                ports,
                activeSignal,
                boundary,
              );
        boundary?.recordGovernedPlayerOutput?.(result, output);
        validateBossReplyOutput(input, output, spec.resumableStateIds);
        return output;
      } catch (error) {
        if (
          !isAbortFailure(error, activeSignal) &&
          !isFsmResultFailure(error)
        ) {
          onControlPlaneError?.(error);
        }
        throw error;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Direct-Captain adjudication (slc/link.md §Captain adjudication). The judge
// selects the guard and supplies only other structural fields; the runtime
// injects the exact visible finalText as the selected output's `question` or
// `response` and rejects a judge reply that supplies either presentation
// field as an undeclared extra key.
// ---------------------------------------------------------------------------

/**
 * Default direct-Captain adjudicator prompt (DR-025). The single statement of
 * the `{ guard, …structuralPayloadFields }` reply contract, shared with the
 * compiled default Captain artifact so the wording cannot drift.
 */
export function defaultBuildCaptainJudgePrompt(
  input: {
    readonly stateId: string;
    readonly sourceItem: string;
    readonly result: Readonly<Record<string, string>>;
  },
  finalText: string,
): string {
  const lines: string[] = [];
  lines.push('Adjudicate the direct Captain output for this FSM state.');
  lines.push(`State id: ${input.stateId}`);
  lines.push(`Source item: ${input.sourceItem}`);
  lines.push('');
  lines.push('Visible Captain output:');
  lines.push('```');
  lines.push(finalText);
  lines.push('```');
  lines.push('');
  lines.push('Result keys and descriptions:');
  for (const [key, description] of Object.entries(input.result)) {
    lines.push(`- \`${key}\` — ${description}`);
  }
  lines.push('');
  lines.push(
    'Pick exactly one outcome by `guard` and return JSON ' +
      '`{ guard, …structuralPayloadFields }`. Do not include `question` or ' +
      '`response`; the runtime injects the visible text.',
  );
  return lines.join('\n');
}

function adjudicateCaptainOutput(
  extractFields: (description: string) => string[],
  input: PlaybookCaptainInput,
  finalText: string,
  judgeText: string,
): PlaybookActorOutput {
  const parsed = parseJudgeJson(judgeText);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('adjudicate: judge response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const guard = obj.guard;
  if (typeof guard !== 'string') {
    throw new Error('adjudicate: judge response missing string "guard" field');
  }
  if (!Object.prototype.hasOwnProperty.call(input.result, guard)) {
    throw new Error(
      `adjudicate: unknown guard "${guard}" — declared guards: ${Object.keys(
        input.result,
      ).join(', ')}`,
    );
  }
  const required = extractFields(input.result[guard]);
  const allowed = new Set(['guard']);
  for (const field of required) {
    if (field !== 'question' && field !== 'response') allowed.add(field);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(
        `adjudicate: judge response supplied undeclared field "${key}" for guard "${guard}"`,
      );
    }
  }
  for (const field of required) {
    if (field === 'question' || field === 'response') continue;
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(
        `adjudicate: judge response missing required field "${field}" for guard "${guard}"`,
      );
    }
  }
  const output: Record<string, unknown> = { ...obj, guard };
  if (required.includes('question')) output.question = finalText;
  if (required.includes('response')) output.response = finalText;
  return output as PlaybookActorOutput;
}

// ---------------------------------------------------------------------------
// FSM-artifact introspection over `machine.config` — internal but stable in
// XState v5: it preserves the literal `createMachine` argument.
// ---------------------------------------------------------------------------

function stripIdPrefix(target: string): string {
  return target.startsWith('#') ? target.slice(1) : target;
}

function collectInvokeSources(machine: AnyStateMachine): ReadonlySet<string> {
  const sources = new Set<string>();
  const visit = (stateDef: unknown): void => {
    if (!isPlainObject(stateDef)) return;
    const invoke = stateDef.invoke;
    const invokes = Array.isArray(invoke) ? invoke : invoke ? [invoke] : [];
    for (const entry of invokes) {
      if (isPlainObject(entry) && typeof entry.src === 'string') {
        sources.add(entry.src);
      }
    }
    if (isPlainObject(stateDef.states)) {
      for (const child of Object.values(stateDef.states)) visit(child);
    }
  };
  visit((machine as unknown as { config?: unknown }).config);
  return sources;
}

function collectPlayerStateRoles(
  machine: AnyStateMachine,
): ReadonlyMap<string, string> {
  const roles = new Map<string, string>();
  const visit = (stateDef: unknown, stateKey: string): void => {
    if (!isPlainObject(stateDef)) return;
    const invoke = stateDef.invoke;
    const invokes = Array.isArray(invoke) ? invoke : invoke ? [invoke] : [];
    if (
      invokes.some(
        (entry) =>
          isPlainObject(entry) && entry.src === 'player',
      )
    ) {
      const playbookMeta = isPlainObject(stateDef.meta)
        ? stateDef.meta.playbook
        : undefined;
      const stateId =
        isPlainObject(playbookMeta) &&
        typeof playbookMeta.stateId === 'string'
          ? playbookMeta.stateId
          : typeof stateDef.id === 'string'
            ? stateDef.id
            : stateKey;
      if (stateId.trim().length === 0) {
        throw new TypeError(
          'player state metadata must use a non-empty state id',
        );
      }
      const role = isPlainObject(playbookMeta)
        ? playbookMeta.role
        : undefined;
      if (typeof role !== 'string' || role.trim().length === 0) {
        throw new TypeError(
          `player state ${stateId} meta.playbook.role must be a non-empty string`,
        );
      }
      roles.set(stateId, role);
    }
    if (isPlainObject(stateDef.states)) {
      for (const [childKey, child] of Object.entries(stateDef.states)) {
        visit(child, childKey);
      }
    }
  };
  const config = (machine as unknown as { config?: unknown }).config;
  if (isPlainObject(config) && isPlainObject(config.states)) {
    for (const [stateKey, stateDef] of Object.entries(config.states)) {
      visit(stateDef, stateKey);
    }
  }
  return roles;
}

function transitionTargets(transition: unknown): string[] {
  const arms = Array.isArray(transition) ? transition : [transition];
  const targets: string[] = [];
  for (const arm of arms) {
    if (typeof arm === 'string') {
      targets.push(stripIdPrefix(arm));
    } else if (isPlainObject(arm) && typeof arm.target === 'string') {
      targets.push(stripIdPrefix(arm.target));
    }
  }
  return targets;
}

/** Targets of the FSM's `awaitBossReply` BOSS_REPLY transitions. */
export function resumableStateIdsFromMachine(
  machine: AnyStateMachine,
): ReadonlySet<string> {
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config) || !isPlainObject(config.states)) {
    return new Set();
  }
  const awaitState = config.states[BOSS_REPLY_WAIT_STATE_ID];
  if (!isPlainObject(awaitState) || !isPlainObject(awaitState.on)) {
    return new Set();
  }
  const bossReply = awaitState.on.BOSS_REPLY;
  if (bossReply === undefined) return new Set();
  return new Set(transitionTargets(bossReply));
}

// ---------------------------------------------------------------------------
// DR-029 control surface: the FSM's explicit-state-jump event and the
// source state descriptions that label runtime-advertised actions.
// ---------------------------------------------------------------------------

/** The FSM's explicit-state-jump event type (slc/link.md §Boss-event mapping). */
const JUMP_EVENT_TYPE = 'BOSS_INTERRUPT';

/**
 * Source state descriptions by state key, node id, and `meta.playbook`
 * state id, read from `machine.config`. Control actions are labeled from
 * these descriptions (DR-029); a state without one has no entry.
 */
export function stateDescriptionsFromMachine(
  machine: AnyStateMachine,
): ReadonlyMap<string, string> {
  const descriptions = new Map<string, string>();
  const record = (key: unknown, description: string): void => {
    if (typeof key !== 'string' || key.length === 0) return;
    if (!descriptions.has(key)) descriptions.set(key, description);
  };
  const visit = (key: string, stateDef: unknown): void => {
    if (!isPlainObject(stateDef)) return;
    const playbook = isPlainObject(stateDef.meta)
      ? (stateDef.meta as Record<string, unknown>).playbook
      : undefined;
    const description =
      isPlainObject(playbook) && typeof playbook.description === 'string'
        ? playbook.description
        : typeof stateDef.description === 'string'
          ? stateDef.description
          : undefined;
    if (description !== undefined && description.length > 0) {
      record(key, description);
      record(stateDef.id, description);
      if (isPlainObject(playbook)) record(playbook.stateId, description);
    }
    if (isPlainObject(stateDef.states)) {
      for (const [childKey, child] of Object.entries(stateDef.states)) {
        visit(childKey, child);
      }
    }
  };
  const config = (machine as unknown as { config?: unknown }).config;
  if (isPlainObject(config) && isPlainObject(config.states)) {
    for (const [key, stateDef] of Object.entries(config.states)) {
      visit(key, stateDef);
    }
  }
  return descriptions;
}

/**
 * First configured target of `eventType` from the state with `stateId`,
 * falling back to the machine root's own transitions. Used only to pick the
 * source description that labels a retry action, and only for events that
 * carry no recorded `targetId`: a guarded multi-arm list keyed on the
 * event's `targetId` (the root `BOSS_INTERRUPT` shape) resumes the recorded
 * target, not the first configured arm, so the recorded event outranks this
 * fallback.
 */
function firstTransitionTarget(
  machine: AnyStateMachine,
  stateId: string | undefined,
  eventType: string,
): string | undefined {
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config)) return undefined;
  const candidates: unknown[] = [];
  if (stateId !== undefined && isPlainObject(config.states)) {
    const state = config.states[stateId];
    if (isPlainObject(state) && isPlainObject(state.on)) {
      candidates.push(state.on[eventType]);
    }
  }
  if (isPlainObject(config.on)) candidates.push(config.on[eventType]);
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const targets = transitionTargets(candidate);
    if (targets.length > 0) return targets[0];
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Default transition/status derivation.
// ---------------------------------------------------------------------------

const SUPPRESSED_ENTRY_STATES: ReadonlySet<string> = new Set(['ready', 'done']);

// Bounded escalation for aborted script process groups: SIGTERM first, then
// SIGKILL after this grace, so settlement (gated on the shell's own exit)
// stays bounded even for TERM-immune commands.
const SCRIPT_ABORT_KILL_GRACE_MS = 2000;

class ScriptProcessGroupTeardownError extends Error {
  constructor(
    pid: number,
    message: string,
    cause?: unknown,
  ) {
    super(
      `script process group ${pid} teardown could not be confirmed: ${message}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ScriptProcessGroupTeardownError';
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  );
}

function isProcessPermissionDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EPERM'
  );
}

function makeDefaultNormalizeTransitionEvent(
  transitionEventFields: readonly string[],
): (event: unknown) => JsonValue {
  return (event: unknown): JsonValue => {
    if (event === null || typeof event !== 'object') {
      return snapshotJsonValue(event ?? null, 'FSM event');
    }
    const e = event as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    if (typeof e.type === 'string') out.type = e.type;
    for (const field of transitionEventFields) {
      if (typeof e[field] === 'string') out[field] = e[field] as string;
    }
    if (e.output !== undefined) {
      out.output = snapshotJsonValue(e.output, 'FSM event output');
    }
    if (e.error !== undefined) {
      out.error = snapshotJsonValue(normalizeError(e.error), 'FSM event error');
    }
    return snapshotJsonValue(out, 'FSM event');
  };
}

function snapshotRoleStateStatuses(
  value: unknown,
  label: string,
  artifactSchema: number,
  machine: AnyStateMachine,
  stateDescriptions: ReadonlyMap<string, string>,
): ReadonlyMap<string, XStateRoleStateStatus> {
  if (value === undefined) {
    throw new TypeError(
      `${label} roleStates must be supplied for schema ${artifactSchema}`,
    );
  }
  const captured = snapshotJsonValue(value, `${label} roleStates`);
  if (!isPlainObject(captured)) {
    throw new TypeError(`${label} roleStates must be an object`);
  }
  const declared = collectPlayerStateRoles(machine);
  const statuses = new Map<string, XStateRoleStateStatus>();
  for (const [stateId, candidate] of Object.entries(captured)) {
    if (!declared.has(stateId)) {
      throw new TypeError(
        `${label} roleStates.${stateId} does not name a player state`,
      );
    }
    if (isPlainObject(candidate)) {
      const extra = Object.keys(candidate).find(
        (key) => key !== 'role' && key !== 'label',
      );
      if (extra !== undefined) {
        throw new TypeError(
          `${label} roleStates.${stateId}.${extra} is not allowed`,
        );
      }
    }
    if (
      !isPlainObject(candidate) ||
      typeof candidate.role !== 'string' ||
      candidate.role.trim().length === 0 ||
      typeof candidate.label !== 'string' ||
      candidate.label.trim().length === 0
    ) {
      throw new TypeError(
        `${label} roleStates.${stateId} must carry non-empty role and label strings`,
      );
    }
    const expectedLabel = stateDescriptions.get(stateId);
    if (candidate.label !== expectedLabel) {
      throw new TypeError(
        `${label} roleStates.${stateId}.label must equal its FSM description`,
      );
    }
    if (candidate.role !== declared.get(stateId)) {
      throw new TypeError(
        `${label} roleStates.${stateId}.role must equal its FSM role`,
      );
    }
    statuses.set(stateId, {
      role: candidate.role,
      label: candidate.label,
    });
  }
  for (const stateId of declared.keys()) {
    if (!statuses.has(stateId)) {
      throw new TypeError(
        `${label} roleStates must declare player state ${stateId}`,
      );
    }
  }
  return statuses;
}

const OUTCOME_FIELD_AUTHORITIES: ReadonlySet<string> = new Set([
  'presentation',
  'semantic',
  'effect',
  'runtime',
]);

const REPOSITORY_DISPOSITIONS: ReadonlySet<string> = new Set([
  'unchanged',
  'one-descendant-commit',
  'deferred',
]);
const OUTCOME_FIELD_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SEMANTIC_PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  'irNumber',
  'irTask',
]);

function requireExactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length === 0 && extra.length === 0) return;
  throw new TypeError(
    `${path} must contain exactly ${expected.join(', ')}` +
      (missing.length === 0 ? '' : `; missing ${missing.join(', ')}`) +
      (extra.length === 0 ? '' : `; unknown ${extra.join(', ')}`),
  );
}

function requireAuthorityIdentifier(value: string, path: string): void {
  if (!OUTCOME_FIELD_KEY_PATTERN.test(value)) {
    throw new TypeError(`${path} must be an identifier`);
  }
}

function snapshotOutcomeAuthority(
  descriptor: PropertyDescriptor | undefined,
  artifactSchema: number,
  label: string,
  playerStates: ReadonlyMap<string, XStateRoleStateStatus>,
  verbatimPayloadFields: ReadonlySet<string>,
): XStateOutcomeAuthoritySpec | undefined {
  const path = `${label} outcomeAuthority`;
  if (artifactSchema === 2) {
    if (descriptor !== undefined) {
      throw new TypeError(`${path} is not allowed for schema 2`);
    }
    return undefined;
  }
  if (
    descriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
    descriptor.enumerable !== true
  ) {
    throw new TypeError(
      `${path} must be an own enumerable data property for schema 3`,
    );
  }
  const captured = snapshotJsonValue(descriptor.value, path);
  if (!isPlainObject(captured)) {
    throw new TypeError(`${path} must be an object`);
  }
  requireExactObjectKeys(captured, ['governedPlayerStates'], path);
  const governed = captured.governedPlayerStates;
  if (!isPlainObject(governed)) {
    throw new TypeError(`${path}.governedPlayerStates must be an object`);
  }

  for (const stateId of playerStates.keys()) {
    if (!Object.prototype.hasOwnProperty.call(governed, stateId)) {
      throw new TypeError(
        `${path}.governedPlayerStates must declare player state ${stateId}`,
      );
    }
  }
  for (const stateId of Object.keys(governed)) {
    if (!playerStates.has(stateId)) {
      throw new TypeError(
        `${path}.governedPlayerStates.${stateId} does not name a player state`,
      );
    }
  }

  const usedVerbatimFields = new Set<string>();
  const normalizedStates: Record<
    string,
    Readonly<Record<string, XStateGovernedOutcomeSpec>>
  > = Object.create(null) as Record<
    string,
    Readonly<Record<string, XStateGovernedOutcomeSpec>>
  >;
  for (const [stateId, rawOutcomes] of Object.entries(governed)) {
    const statePath = `${path}.governedPlayerStates.${stateId}`;
    if (!isPlainObject(rawOutcomes) || Object.keys(rawOutcomes).length === 0) {
      throw new TypeError(`${statePath} must declare at least one outcome`);
    }
    const outcomes = Object.create(null) as Record<
      string,
      XStateGovernedOutcomeSpec
    >;
    for (const [outcome, rawSpec] of Object.entries(rawOutcomes)) {
      requireAuthorityIdentifier(outcome, `${statePath} outcome key`);
      const outcomePath = `${statePath}.${outcome}`;
      if (!isPlainObject(rawSpec)) {
        throw new TypeError(`${outcomePath} must be an object`);
      }
      requireExactObjectKeys(
        rawSpec,
        ['fields', 'repositoryDisposition'],
        outcomePath,
      );
      if (!isPlainObject(rawSpec.fields)) {
        throw new TypeError(`${outcomePath}.fields must be an object`);
      }
      const fields = Object.create(null) as Record<
        string,
        XStateOutcomeFieldAuthority
      >;
      for (const [field, authority] of Object.entries(rawSpec.fields)) {
        requireAuthorityIdentifier(field, `${outcomePath}.fields key`);
        if (field === 'guard') {
          throw new TypeError(
            `${outcomePath}.fields.guard is not allowed; the outcome key owns the semantic discriminator`,
          );
        }
        if (
          typeof authority !== 'string' ||
          !OUTCOME_FIELD_AUTHORITIES.has(authority)
        ) {
          throw new TypeError(
            `${outcomePath}.fields.${field} must name presentation, semantic, effect, or runtime authority`,
          );
        }
        const requiredAuthorities = new Set<XStateOutcomeFieldAuthority>();
        if (field === 'latestCommit') requiredAuthorities.add('effect');
        if (SEMANTIC_PAYLOAD_FIELDS.has(field)) {
          requiredAuthorities.add('semantic');
        }
        if (field === 'question' || verbatimPayloadFields.has(field)) {
          requiredAuthorities.add('presentation');
        }
        if (requiredAuthorities.size > 1) {
          throw new TypeError(
            `${outcomePath}.fields.${field} has conflicting linker authority requirements`,
          );
        }
        const requiredAuthority = [...requiredAuthorities][0];
        if (requiredAuthority !== undefined && authority !== requiredAuthority) {
          throw new TypeError(
            `${outcomePath}.fields.${field} must use ${requiredAuthority} authority`,
          );
        }
        if (verbatimPayloadFields.has(field)) usedVerbatimFields.add(field);
        fields[field] = authority as XStateOutcomeFieldAuthority;
      }
      const disposition = rawSpec.repositoryDisposition;
      if (
        typeof disposition !== 'string' ||
        !REPOSITORY_DISPOSITIONS.has(disposition)
      ) {
        throw new TypeError(
          `${outcomePath}.repositoryDisposition must be unchanged, one-descendant-commit, or deferred`,
        );
      }
      if (
        disposition !== 'one-descendant-commit' &&
        Object.values(fields).includes('effect')
      ) {
        throw new TypeError(
          `${outcomePath} may declare effect-owned fields only for one-descendant-commit`,
        );
      }
      outcomes[outcome] = Object.freeze({
        fields: Object.freeze(fields),
        repositoryDisposition: disposition as XStateRepositoryDisposition,
      });
    }
    for (const [outcome, outcomeSpec] of Object.entries(outcomes)) {
      if (outcomeSpec.repositoryDisposition !== 'deferred') continue;
      if (outcome !== 'needsBossReply') {
        throw new TypeError(
          `${statePath}.${outcome} may use deferred only for needsBossReply`,
        );
      }
      if (outcomeSpec.fields.question !== 'presentation') {
        throw new TypeError(
          `${statePath}.needsBossReply deferred outcome must declare presentation-owned question`,
        );
      }
      if (
        !Object.entries(outcomes).some(
          ([other, candidate]) =>
            other !== outcome &&
            candidate.repositoryDisposition === 'one-descendant-commit',
        )
      ) {
        throw new TypeError(
          `${statePath}.needsBossReply deferred outcome requires another one-descendant-commit outcome`,
        );
      }
    }
    normalizedStates[stateId] = Object.freeze(outcomes);
  }
  for (const field of verbatimPayloadFields) {
    requireAuthorityIdentifier(field, `${path} verbatimPayloadFields entry`);
    if (!usedVerbatimFields.has(field)) {
      throw new TypeError(
        `${path} verbatimPayloadFields entry ${field} is absent from governed payload fields`,
      );
    }
  }
  return Object.freeze({
    governedPlayerStates: Object.freeze(normalizedStates),
  });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function assertGovernedPlayerInput(
  authority: XStateOutcomeAuthoritySpec | undefined,
  input: PlaybookPlayerInput,
  extractFields: (description: string) => string[],
  label: string,
): void {
  if (authority === undefined) return;
  const state = authority.governedPlayerStates[input.stateId];
  if (state === undefined) {
    throw new TypeError(
      `${label} outcomeAuthority has no governed player state ${input.stateId}`,
    );
  }
  const actualOutcomes = Object.keys(input.result);
  const governedOutcomes = Object.keys(state);
  if (!sameStringSet(actualOutcomes, governedOutcomes)) {
    throw new TypeError(
      `${label} outcomeAuthority for ${input.stateId} must exactly match outcomes ` +
        governedOutcomes.join(', '),
    );
  }
  for (const outcome of governedOutcomes) {
    const description = input.result[outcome];
    if (typeof description !== 'string') {
      throw new TypeError(
        `${label} player outcome ${input.stateId}.${outcome} must have a string description`,
      );
    }
    const describedFields = [...new Set(extractFields(description))];
    const candidateFields = Object.keys(state[outcome]!.fields);
    if (!sameStringSet(describedFields, candidateFields)) {
      throw new TypeError(
        `${label} outcomeAuthority fields for ${input.stateId}.${outcome} ` +
          'must exactly match its described output fields',
      );
    }
  }
}

function settlingGuard(event: unknown): string | undefined {
  if (!isPlainObject(event) || !isPlainObject(event.output)) return undefined;
  const guard = event.output.guard;
  return typeof guard === 'string' && guard.trim().length > 0
    ? guard
    : undefined;
}

function askerLabel(
  asker: PlaybookPendingBossQuestionContext['asker'],
): string {
  return asker.kind === 'captain' ? 'Captain' : asker.roleId;
}

function makeDefaultStatusesForState(
  roleStates: ReadonlyMap<string, XStateRoleStateStatus>,
): NonNullable<XStatePlaybookRuntimeSpec<unknown>['statusesForState']> {
  return (state, context): ScheduledStatus[] => {
    const statuses: ScheduledStatus[] = [];

    const stateId = state.stateId;
    if (stateId === undefined || SUPPRESSED_ENTRY_STATES.has(stateId)) {
      return statuses;
    }
    if (stateId === BOSS_REPLY_WAIT_STATE_ID) {
      const pending = pendingBossQuestionFromContext(context);
      if (pending === undefined) {
        return [...statuses, { message: 'Awaiting Boss reply.' }];
      }
      return [
        ...statuses,
        { message: `${askerLabel(pending.asker)} asks: ${pending.question}` },
        {
          message:
            `◆ awaiting Boss reply · ${pending.resumeStateId} · ` +
            `${askerLabel(pending.asker)} · ${pending.sourceItem}`,
        },
      ];
    }
    if (stateId === 'failed') {
      const lastError = normalizeErrorCompact(context.lastError);
      return [
        ...statuses,
        {
          message: '◆ workflow failed; awaiting Boss recovery.',
          ...(lastError === undefined
            ? {}
            : {
                data: snapshotJsonValue(
                  { lastError },
                  'failed status data',
                ),
              }),
        },
      ];
    }
    const roleState = roleStates.get(stateId);
    if (roleState !== undefined) {
      statuses.push({
        message: `⤷ ${roleState.role}: ${roleState.label}`,
      });
    }
    return statuses;
  };
}

// ---------------------------------------------------------------------------
// Default parked-state classifier (slc/link.md §Boss-event mapping): the
// runtime-owned textual fields are never requested from the judge; only the
// event choice and non-text routing fields are.
// ---------------------------------------------------------------------------

interface ClassifierState {
  value: unknown;
  context: Record<string, unknown>;
}

function classifierState(snapshotOrState: unknown): ClassifierState {
  if (
    snapshotOrState !== null &&
    typeof snapshotOrState === 'object' &&
    'value' in snapshotOrState
  ) {
    const candidate = snapshotOrState as { value?: unknown; context?: unknown };
    return {
      value: candidate.value,
      context:
        candidate.context !== null &&
        typeof candidate.context === 'object' &&
        !Array.isArray(candidate.context)
          ? (candidate.context as Record<string, unknown>)
          : {},
    };
  }
  return { value: snapshotOrState, context: {} };
}

function configuredEventTypesForState(
  machine: AnyStateMachine,
  stateId: string | undefined,
): ReadonlySet<string> {
  const configured = new Set<string>();
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config)) return configured;
  if (isPlainObject(config.on)) {
    for (const type of Object.keys(config.on)) configured.add(type);
  }
  if (stateId !== undefined && isPlainObject(config.states)) {
    const state = config.states[stateId];
    if (isPlainObject(state) && isPlainObject(state.on)) {
      for (const type of Object.keys(state.on)) configured.add(type);
    }
  }
  return configured;
}

// Derived contracts merge into whatever the machine already yielded for the
// same type, so a deterministic entry event that shares a type with another
// derived contract keeps its exact-text ownership instead of being replaced.
function mergeDerivedContract(
  contracts: Map<string, XStateBossEventSpec>,
  contract: XStateBossEventSpec,
): void {
  const existing = contracts.get(contract.type);
  contracts.set(contract.type, {
    type: contract.type,
    fields: { ...(existing?.fields ?? {}), ...(contract.fields ?? {}) },
  });
}

function defaultBossEventSpecs(
  machine: AnyStateMachine,
  entryEvent: { type: string; textField: string } | undefined,
  supplied: readonly XStateBossEventSpec[],
): ReadonlyMap<string, XStateBossEventSpec> {
  const contracts = new Map<string, XStateBossEventSpec>();
  if (entryEvent !== undefined) {
    mergeDerivedContract(contracts, {
      type: entryEvent.type,
      fields: { [entryEvent.textField]: { source: 'text', required: true } },
    });
  }

  const config = (machine as unknown as { config?: unknown }).config;
  const rootInterrupt =
    isPlainObject(config) && isPlainObject(config.on)
      ? config.on.BOSS_INTERRUPT
      : undefined;
  const interruptTargets =
    rootInterrupt === undefined ? [] : transitionTargets(rootInterrupt);
  if (interruptTargets.length > 0) {
    mergeDerivedContract(contracts, {
      type: 'BOSS_INTERRUPT',
      fields: {
        targetId: {
          source: 'judge',
          required: true,
          values: [...new Set(interruptTargets)],
        },
        // slc/link.md §Boss-event mapping: for BOSS_INTENT and
        // BOSS_INTERRUPT the runtime, never the judge, attaches the exact
        // original Boss text as `bossIntent`.
        bossIntent: { source: 'text', required: true },
      },
    });
  }

  for (const contract of supplied) {
    if (
      typeof contract.type !== 'string' ||
      contract.type.trim().length === 0
    ) {
      throw new TypeError(
        'Boss event contract type must be a non-empty string',
      );
    }
    if (contract.type === 'NO_ACTION' || contract.type === 'BOSS_REPLY') {
      throw new TypeError(
        `Boss event contract ${contract.type} is runtime-owned`,
      );
    }
    const existing = contracts.get(contract.type);
    const fields: Record<string, XStateBossEventFieldSpec> = {
      ...(existing?.fields ?? {}),
    };
    for (const [field, fieldSpec] of Object.entries(contract.fields ?? {})) {
      if (field.length === 0 || field === 'type') {
        throw new TypeError(
          `Boss event contract ${contract.type} has invalid field ${JSON.stringify(field)}`,
        );
      }
      if (fieldSpec.source !== 'judge' && fieldSpec.source !== 'text') {
        throw new TypeError(
          `Boss event contract ${contract.type}.${field} has invalid source`,
        );
      }
      if (fieldSpec.values !== undefined) {
        if (
          fieldSpec.source !== 'judge' ||
          fieldSpec.values.length === 0 ||
          fieldSpec.values.some(
            (value) => typeof value !== 'string' || value.length === 0,
          )
        ) {
          throw new TypeError(
            `Boss event contract ${contract.type}.${field} has invalid values`,
          );
        }
      }
      const normalized: XStateBossEventFieldSpec = {
        source: fieldSpec.source,
        ...(fieldSpec.required === true ? { required: true } : {}),
        ...(fieldSpec.values === undefined
          ? {}
          : { values: [...new Set(fieldSpec.values)] }),
      };
      const derived = fields[field];
      if (derived !== undefined) {
        const derivedValues =
          derived.values === undefined
            ? undefined
            : new Set(derived.values);
        const normalizedValues =
          normalized.values === undefined
            ? undefined
            : new Set(normalized.values);
        const sameValues =
          derivedValues === undefined || normalizedValues === undefined
            ? derivedValues === normalizedValues
            : derivedValues.size === normalizedValues.size &&
              [...derivedValues].every((value) =>
                normalizedValues.has(value),
              );
        if (
          derived.source !== normalized.source ||
          (derived.required === true) !== (normalized.required === true) ||
          !sameValues
        ) {
          throw new TypeError(
            `Boss event contract ${contract.type}.${field} conflicts with the runtime-derived contract`,
          );
        }
        continue;
      }
      fields[field] = normalized;
    }
    contracts.set(contract.type, { type: contract.type, fields });
  }

  contracts.set('BOSS_REPLY', {
    type: 'BOSS_REPLY',
    fields: {
      questionId: { source: 'judge' },
      answer: { source: 'text', required: true },
    },
  });
  return contracts;
}

function eventContractPrompt(contract: XStateBossEventSpec): string {
  const fields = Object.entries(contract.fields ?? {}).filter(
    ([, field]) => field.source === 'judge',
  );
  const members = [
    `"type": ${JSON.stringify(contract.type)}`,
    ...fields.map(([name, field]) =>
      `${JSON.stringify(name)}: ${JSON.stringify(
        field.values?.[0] ?? '<string>',
      )}`,
    ),
  ];
  const notes = fields.flatMap(([name, field]) => [
    ...(field.required === true ? [] : [`${name} optional`]),
    ...(field.values === undefined
      ? []
      : [
          `${name} one of ${field.values
            .map((value) => JSON.stringify(value))
            .join(', ')}`,
        ]),
  ]);
  return `{ ${members.join(', ')} }${
    notes.length === 0 ? '' : ` (${notes.join('; ')})`
  }`;
}

function makeDefaultClassifyBossText(
  machine: AnyStateMachine,
  entryEvent: { type: string; textField: string } | undefined,
  bossEvents: readonly XStateBossEventSpec[],
): (
  text: string,
  ports: PlaybookPorts,
  signal: AbortSignal,
  snapshotOrState: unknown,
  boundary?: RuntimeBoundaryCalls,
) => Promise<EventObject | undefined> {
  const contracts = defaultBossEventSpecs(machine, entryEvent, bossEvents);
  return async (text, ports, signal, snapshotOrState, boundary) => {
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    const state = classifierState(snapshotOrState);
    const stateId = typeof state.value === 'string' ? state.value : undefined;
    const currentState = stateId ?? JSON.stringify(state.value ?? null);
    // The classifier shares the reply-wait pendingness of every other
    // surface: outside the wait, a context question a later state retains
    // is answered history, so the prompt must not present it as pending —
    // a judge told a question awaits at the failure state is steered toward
    // a reply it cannot select or toward no action at all.
    const pending =
      stateId === BOSS_REPLY_WAIT_STATE_ID
        ? pendingBossQuestionFromContext(state.context)
        : undefined;
    const configuredTypes = configuredEventTypesForState(machine, stateId);
    const applicable = [...contracts.values()].filter(
      (contract) =>
        configuredTypes.has(contract.type) &&
        (contract.type !== 'BOSS_REPLY' || pending !== undefined),
    );

    const lines = [
      'Classify the following Boss message into exactly one event.',
      'Respond with one exact flat JSON object. Do not add fields that are not shown.',
      'The runtime, not the judge, attaches the exact Boss text to textual event fields.',
      '',
      `Current state: ${currentState}`,
    ];
    if (pending !== undefined) {
      lines.push(
        `Pending question id: ${pending.questionId}`,
        `Pending asker: ${askerLabel(pending.asker)}`,
        `Pending Boss question: ${pending.question}`,
      );
    }
    lines.push('', 'Allowed JSON objects:', '- { "type": "NO_ACTION" }');
    for (const contract of applicable) {
      lines.push(`- ${eventContractPrompt(contract)}`);
    }
    lines.push('', 'Boss message:', '```', text, '```');
    const prompt = lines.join('\n');

    const raw = boundary
      ? await boundary.callJudge(
          'boss-input-classification',
          stateId,
          prompt,
          signal,
        )
      : await ports.callJudge(prompt, signal);
    let parsed: unknown;
    try {
      parsed = parseJudgeJson(raw);
    } catch {
      await ports.emitStatus('Classifier reply was not recoverable JSON');
      return undefined;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      await ports.emitStatus('Classifier returned a non-object JSON response');
      return undefined;
    }
    const obj = parsed as Record<string, unknown>;
    const eventType = obj.type;
    if (typeof eventType !== 'string') {
      await ports.emitStatus('Classifier did not name an event type');
      return undefined;
    }
    if (eventType === 'NO_ACTION') {
      if (Object.keys(obj).length !== 1) {
        await ports.emitStatus('Classifier supplied extra fields for NO_ACTION');
        return undefined;
      }
      return undefined;
    }
    const contract = applicable.find(
      (candidate) => candidate.type === eventType,
    );
    if (contract === undefined) {
      await ports.emitStatus(
        `Classifier returned unknown or inapplicable event type: ${eventType}`,
      );
      return undefined;
    }
    const fields = contract.fields ?? {};
    const judgeFields = new Set(
      Object.entries(fields)
        .filter(([, field]) => field.source === 'judge')
        .map(([field]) => field),
    );
    const extras = Object.keys(obj).filter(
      (field) => field !== 'type' && !judgeFields.has(field),
    );
    if (extras.length > 0) {
      await ports.emitStatus(
        `Classifier supplied undeclared field for ${eventType}: ${extras[0]}`,
      );
      return undefined;
    }

    const event: Record<string, unknown> = { type: eventType };
    for (const [field, fieldSpec] of Object.entries(fields)) {
      if (fieldSpec.source === 'text') {
        event[field] = text;
        continue;
      }
      const value = obj[field];
      if (value === undefined && fieldSpec.required !== true) continue;
      if (typeof value !== 'string' || value.length === 0) {
        await ports.emitStatus(
          `Classifier omitted or invalidated ${field} for ${eventType}`,
        );
        return undefined;
      }
      if (fieldSpec.values !== undefined && !fieldSpec.values.includes(value)) {
        await ports.emitStatus(
          `Classifier supplied unknown ${field} for ${eventType}: ${value}`,
        );
        return undefined;
      }
      event[field] = value;
    }

    if (eventType === 'BOSS_REPLY') {
      if (pending === undefined) {
        await ports.emitStatus(
          'Classifier returned BOSS_REPLY without a pending question',
        );
        return undefined;
      }
      const questionId = event.questionId;
      if (questionId !== undefined && questionId !== pending.questionId) {
        await ports.emitStatus(
          `Classifier supplied unknown questionId for BOSS_REPLY: ${String(questionId)}`,
        );
        return undefined;
      }
      event.questionId = pending.questionId;
    }
    const can = (snapshotOrState as { can?: unknown } | null)?.can;
    if (
      typeof can === 'function' &&
      !(can as (candidate: EventObject) => boolean).call(
        snapshotOrState,
        event as EventObject,
      )
    ) {
      await ports.emitStatus(
        `Classifier selected ${eventType}, but its state guards rejected the event`,
      );
      return undefined;
    }
    return event as EventObject;
  };
}

// ---------------------------------------------------------------------------
// The generic runtime factory.
// ---------------------------------------------------------------------------

type BossSettlementOutcome =
  | 'no-action'
  | 'quiescent'
  | 'unresolved-effect'
  | 'failed'
  | 'terminal'
  | 'aborted'
  | 'suspended';

interface TracePosition {
  turnId?: number;
  callId?: string;
}

function machineDeclaresParallelState(machine: AnyStateMachine): boolean {
  const visit = (stateDef: unknown): boolean => {
    if (!isPlainObject(stateDef)) return false;
    if (stateDef.type === 'parallel') return true;
    if (!isPlainObject(stateDef.states)) return false;
    return Object.values(stateDef.states).some(visit);
  };
  return visit((machine as unknown as { config?: unknown }).config);
}

// PBRT-52: the factory's domain is FLAT single-region machines — every
// state a direct child of the root, so each snapshot exposes exactly one
// playbook state id and every state-keyed lookup (deterministic entries,
// retry, reply-wait pendingness, configured events, descriptions) indexes
// one unambiguous identity. A compound child would be accepted and then
// silently misbehave on all of those gates, so it is rejected up front
// exactly like a parallel region.
function machineDeclaresNestedState(machine: AnyStateMachine): boolean {
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config) || !isPlainObject(config.states)) return false;
  return Object.values(config.states).some(
    (stateDef) =>
      isPlainObject(stateDef) &&
      isPlainObject(stateDef.states) &&
      Object.keys(stateDef.states).length > 0,
  );
}

// PBRT-52: the factory's lookups index states by their root key, and the
// published playbook identity is `meta.playbook.stateId` — the two must
// coincide or a machine can advertise a pending question or retry under an
// identity no lookup resolves. A state with no string stateId is just as
// dead: every snapshot identity derives from that member, so the first
// entry would fail the exactly-one-state-id inspection at runtime.
// gears2fsm keeps identity and key equal by construction; a hand-authored
// artifact that splits or omits them fails here instead of at a silently
// dead gate.
function assertFlatStateIdentity(
  machine: AnyStateMachine,
  label: string,
): void {
  const config = (machine as unknown as { config?: unknown }).config;
  const states =
    isPlainObject(config) && isPlainObject(config.states)
      ? config.states
      : undefined;
  // A machine with no root states has no playbook identity to expose; its
  // first snapshot would fail the exactly-one-state-id inspection, so it
  // fails construction with the defect named instead.
  if (states === undefined || Object.keys(states).length === 0) {
    throw new Error(
      `${label} declares no root states; the shared runtime requires at ` +
        'least one flat playbook state',
    );
  }
  for (const [key, stateDef] of Object.entries(states)) {
    if (!isPlainObject(stateDef)) continue;
    const meta = isPlainObject(stateDef.meta) ? stateDef.meta : undefined;
    const playbook =
      meta !== undefined && isPlainObject(meta.playbook)
        ? meta.playbook
        : undefined;
    const stateId = playbook?.stateId;
    if (typeof stateId !== 'string') {
      throw new Error(
        `${label} state ${key} declares no string meta.playbook.stateId; ` +
          'the shared runtime derives every playbook state identity from it',
      );
    }
    if (stateId !== key) {
      throw new Error(
        `${label} state ${key} declares meta.playbook.stateId ${stateId}; ` +
          'the shared runtime requires the playbook state id to equal the state key',
      );
    }
  }
}

function rootFinalStateIdsFromMachine(
  machine: AnyStateMachine,
): ReadonlySet<string> {
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config) || !isPlainObject(config.states)) {
    return new Set();
  }
  const stateIds = new Set<string>();
  for (const [stateId, stateDef] of Object.entries(config.states)) {
    if (isPlainObject(stateDef) && stateDef.type === 'final') {
      stateIds.add(stateId);
    }
  }
  return stateIds;
}

// PBRT-52: whether a final outcome leaves the procedure unfinished remains
// authored link metadata. The machine can still prove the mechanical half:
// every declared stable id must resolve to one of its root final states.
function assertUnfinishedFinalStateIds(
  value: ReadonlySet<unknown> | undefined,
  machine: AnyStateMachine,
  label: string,
): void {
  if (value === undefined) return;
  const rootFinalStateIds = rootFinalStateIdsFromMachine(machine);
  for (const stateId of value) {
    if (typeof stateId !== 'string' || !rootFinalStateIds.has(stateId)) {
      throw new TypeError(
        `${label} unfinishedFinalStateIds entry ${JSON.stringify(stateId)} ` +
          'does not name a root final state',
      );
    }
  }
}

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
export function createXStatePlaybookRuntime<TOptions>(
  machine: AnyStateMachine,
  spec: XStatePlaybookRuntimeSpec<TOptions>,
): XStatePlaybookRuntimeFactory<TOptions, 2>;
export function createXStatePlaybookRuntime<
  TOptions,
  THostCapabilities extends object,
>(
  machine: AnyStateMachine,
  spec: XStatePlaybookRuntimeSpecV3<TOptions>,
): XStatePlaybookRuntimeFactory<
  XStatePlaybookRuntimeConstruction<TOptions, THostCapabilities>,
  3
>;
export function createXStatePlaybookRuntime<
  TOptions,
  THostCapabilities extends object = never,
>(
  machine: AnyStateMachine,
  spec: UncheckedXStatePlaybookRuntimeSpec<TOptions>,
): XStatePlaybookRuntimeFactory<
  XStatePlaybookRuntimeFactoryOptions<TOptions, THostCapabilities>
> {
  const label = spec.label ?? 'playbook';
  // DR-022 / PBRT-50: reject an incompatible artifact declaration before any
  // machine interpretation, against this loaded engine's own self-report.
  const artifactSchema = assertRuntimeCompat(spec.compat, label);
  const specDescriptors = Object.getOwnPropertyDescriptors(spec);
  if (Object.prototype.hasOwnProperty.call(specDescriptors, 'playerStates')) {
    throw new TypeError(
      `${label} schema-2 artifacts must supply roleStates, not playerStates`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(specDescriptors, 'resolvePlayerId')) {
    throw new TypeError(
      `${label} schema-2 artifacts must not derive concrete player bindings`,
    );
  }
  if (machineDeclaresParallelState(machine)) {
    throw new Error(
      `${label} uses a parallel state; the shared runtime supports only single-region FSMs`,
    );
  }
  if (machineDeclaresNestedState(machine)) {
    throw new Error(
      `${label} declares a compound state; the shared runtime supports only flat single-region FSMs`,
    );
  }
  assertFlatStateIdentity(machine, label);
  assertUnfinishedFinalStateIds(
    spec.unfinishedFinalStateIds,
    machine,
    label,
  );
  const retainedGenerationMetadata =
    spec.unfinishedFinalStateIds === undefined
      ? undefined
      : Object.freeze({
          unfinishedFinalStateIds: Object.freeze([
            ...spec.unfinishedFinalStateIds,
          ]),
        });
  const declaredActors = collectInvokeSources(machine);
  const resumableStateIds =
    spec.resumableStateIds ?? resumableStateIdsFromMachine(machine);
  // DR-029: source state descriptions label the control actions the
  // runtime advertises through `describe()`.
  const stateDescriptions = stateDescriptionsFromMachine(machine);
  const roleStatesDescriptor = specDescriptors.roleStates;
  if (
    roleStatesDescriptor !== undefined &&
    !Object.prototype.hasOwnProperty.call(roleStatesDescriptor, 'value')
  ) {
    throw new TypeError(`${label} roleStates must be an own data property`);
  }
  const roleStates = snapshotRoleStateStatuses(
    roleStatesDescriptor?.value,
    label,
    artifactSchema,
    machine,
    stateDescriptions,
  );
  const declaredRoleIds = Object.freeze([
    ...new Set([...roleStates.values()].map(({ role }) => role)),
  ]);
  // PBRT-52: the artifact's own ControlView context projection. Nothing is
  // exported by default, so an FSM context member — including one added
  // after this artifact was linked — is private until named here. The two
  // members the view surfaces first-class are rejected at construction
  // rather than silently ignored, so an artifact cannot believe it is
  // exporting them through this list.
  const controlContextFields: readonly string[] = spec.controlContextFields
    ? [...spec.controlContextFields]
    : [];
  for (const field of controlContextFields) {
    if (field === 'pendingBossQuestion' || field === 'lastError') {
      throw new Error(
        `${label} controlContextFields must not name ${field}: the control view surfaces it first-class`,
      );
    }
  }
  const composePlayerPrompt =
    spec.composePlayerPrompt ??
    ((input: PlaybookPlayerInput) =>
      defaultComposePlayerPrompt(input, spec.placeholderFields));
  const composeCaptainPrompt =
    spec.composeCaptainPrompt ??
    ((input: PlaybookCaptainInput) =>
      defaultComposeCaptainPrompt(input, spec.placeholderFields));
  const extractFields =
    spec.extractRequiredFields ?? defaultExtractRequiredFields;
  const verbatimPayloadFields: ReadonlySet<string> = new Set(
    spec.verbatimPayloadFields ?? NO_VERBATIM_FIELDS,
  );
  const adjudication: PlayerAdjudicationSpec = {
    ...(spec.buildJudgePrompt !== undefined
      ? { buildJudgePrompt: spec.buildJudgePrompt }
      : {}),
    extractRequiredFields: extractFields,
    verbatimPayloadFields,
  };
  const outcomeAuthority = snapshotOutcomeAuthority(
    specDescriptors.outcomeAuthority,
    artifactSchema,
    label,
    roleStates,
    verbatimPayloadFields,
  );
  if (outcomeAuthority !== undefined) {
    for (const [stateId, outcomes] of Object.entries(
      outcomeAuthority.governedPlayerStates,
    )) {
      if (
        Object.values(outcomes).some(
          ({ repositoryDisposition }) => repositoryDisposition === 'deferred',
        ) &&
        !resumableStateIds.has(stateId)
      ) {
        throw new TypeError(
          `${label} outcomeAuthority deferred state ${stateId} must be registered in resumableStateIds`,
        );
      }
    }
  }
  // Build the derived classifier unconditionally: it is the sole validator of
  // supplied `bossEvents`, and DR-019 §2 requires a conflicting duplicate to
  // fail factory construction whether or not this spec overrides the
  // classifier that would have consumed the contracts.
  const derivedClassifyBossText = makeDefaultClassifyBossText(
    machine,
    spec.entryEvent,
    spec.bossEvents ?? [],
  );
  const classifyBossText: NonNullable<
    XStatePlaybookRuntimeSpec<TOptions>['classifyBossText']
  > = spec.classifyBossText ?? derivedClassifyBossText;
  const normalizeTransitionEvent =
    spec.normalizeTransitionEvent ??
    makeDefaultNormalizeTransitionEvent(spec.transitionEventFields ?? []);
  const statusesForState =
    spec.statusesForState ??
    makeDefaultStatusesForState(roleStates);
  const usesDefaultStatuses = spec.statusesForState === undefined;
  const classificationStatus =
    spec.classificationStatus ??
    ((event: EventObject) => event.type);
  const machineInput =
    spec.machineInput ?? ((options: TOptions) => options as unknown);
  const scriptCwd =
    spec.scriptCwd ??
    ((options: TOptions): string | undefined => {
      const cwd = (options as Record<string, unknown> | null | undefined)?.cwd;
      return typeof cwd === 'string' ? cwd : undefined;
    });

  const createPlaybookRuntime = function createPlaybookRuntime(
    factoryOptions: unknown,
  ): PlaybookRuntime {
    const construction = configuredOptionsFromFactoryInput(
      factoryOptions,
      artifactSchema,
      label,
    );
    const configuredOptions = construction.configuredOptions as TOptions;
    const effectLedgerCapability = construction.effectLedger;
    const hasGovernedPlayerStates =
      outcomeAuthority !== undefined &&
      Object.keys(outcomeAuthority.governedPlayerStates).length > 0;
    const acceptedOutcomeConsumer = createAcceptedOutcomeConsumer(
      artifactSchema,
      (source, acceptedOutcome) => {
        const governedPlayerStates = outcomeAuthority?.governedPlayerStates;
        if (
          governedPlayerStates === undefined ||
          !Object.prototype.hasOwnProperty.call(governedPlayerStates, source)
        ) {
          return false;
        }
        const declarations = governedPlayerStates[source];
        return (
          declarations !== undefined &&
          Object.prototype.hasOwnProperty.call(
            declarations,
            acceptedOutcome,
          )
        );
      },
    );
    const repositoryCapability =
      hasGovernedPlayerStates
        ? repositoryCapabilityFromHostCapabilities(
            construction.hostCapabilities,
            label,
          )
        : undefined;
    const currentEffectLedger = (): PlaybookEffectLedger =>
      effectLedgerCapability === undefined
        ? emptyPlaybookEffectLedger()
        : assertPlaybookEffectLedger(
            effectLedgerCapability.snapshot(),
            `${label} current host effect ledger`,
          );
    let effectLedgerMirror = currentEffectLedger();
    let retainedEffectSourceSessionId: string | undefined;
    let retainedEffectReconciliation:
      | PlaybookRuntimeSnapshot['retainedEffectReconciliation']
      | undefined;
    let retainedEffectReconciliationRequired = false;
    const playerBoundaryReceipts = new WeakMap<
      object,
      { readonly boundaryId: string; readonly attemptId: string }
    >();
    const governedPlayerSettlements = new WeakMap<
      object,
      GovernedPlayerSettlement
    >();
    const governedSettlementsByBoundaryId = new Map<
      string,
      GovernedPlayerSettlement
    >();
    const governedCompletionEvidenceByBoundaryId = new Map<
      string,
      {
        readonly boundaryEvidence: {
          readonly finalText?: string;
          readonly semanticCandidate?: JsonValue;
        };
        readonly reconciliationStatus?: 'resolved' | 'deferred';
        readonly output?: PlaybookActorOutput;
      }
    >();
    const unresolvedSemanticBoundaryIds = new Set<string>();
    let reconstructedGovernedDelivery:
      | {
          readonly boundary: PlaybookEffectBoundary;
          readonly finalText: string;
          readonly settlement: GovernedPlayerSettlement & {
            readonly status: 'resolved';
          };
        }
      | undefined;
    let reconstructedGovernedPrefixSequence: number | undefined;
    const reconstructedGovernedResults = new WeakMap<
      object,
      PlaybookEffectBoundary
    >();
    let reconstructedAcceptancePending: PlaybookEffectBoundary | undefined;
    const boundOptions = spec.snapshotOptions(configuredOptions);
    assertNoConfiguredHostCapabilities(boundOptions, label);
    const boundScriptCwd = scriptCwd(boundOptions);
    let actor: ReturnType<typeof createActor> | undefined;
    let session: PlaybookSession | undefined;
    let initialized = false;
    let initInFlight: Promise<void> | undefined;
    let disposalPromise: Promise<void> | undefined;
    let disposed = false;
    let savedPorts: PlaybookPorts | undefined;
    let runtimePorts: PlaybookPorts | undefined;
    // The Boss's per-turn AbortSignal, surfaced to the provided actors so
    // ports.callPlayer / callCaptain / callJudge see the right cancellation
    // source. undefined between turns; set by the public boundaries.
    let activeSignal: AbortSignal | undefined;
    // Immutable cancellation provenance for the active public boundary. A
    // nested resume widens it to include both invocation and resume signals;
    // mutable `activeSignal` alone cannot classify a late invocation reason.
    let activeAborts: AbortReasonClassifier | undefined;
    // The bridge binds the provenance of a child result immediately before
    // its promise actor settles. The next root snapshot/error consumes this
    // one-shot so background settlement emissions retain their owner.
    let actorSettlementAborts: AbortReasonClassifier | undefined;
    let actorSettlementErrorAborts: AbortReasonClassifier | undefined;
    // Exact cancellation observed by an emission owned by the active
    // boundary. Ordinary runs settle from their signal/state; apply also
    // needs this phase-local evidence to fold a pre-publication failure into
    // its accepted receipt.
    let activeAbortEmission: unknown;
    let activeTurnId: number | undefined;
    // The durable host attempt observed by governed calls in the active
    // public boundary. The failed-state latch survives later no-action turns;
    // clearing it at every boundary start must not make unsafe replay appear
    // newly eligible.
    let activeGovernedBoundarySeen = false;
    let activeGovernedAttemptId: string | undefined;
    let activeEffectLedgerPrefixSequence: number | undefined;
    let failedGovernedAttemptUnknown = false;
    let failedEffectBoundaryPrefix: number | undefined;
    let failedGovernedAttemptId: string | undefined;
    let deferredReconciliationOperationId: string | undefined;
    let deferredSettlementClosure: Error | undefined;
    let expectedBoundPendingQuestion:
      | PlaybookPendingBossQuestionContext
      | undefined;
    let activeDeferredContinuation:
      | {
          readonly operationId: string;
          readonly effectBoundary: XStateEffectBoundarySeed;
          playerContinuation?: string | false;
          input?: PlaybookPlayerInput;
          roleId?: string;
          playerId?: string;
          result?: PlayerResult;
          callError?: unknown;
          settlement?: GovernedPlayerSettlement;
          signal?: AbortSignal;
          readonly rawPlayerSettled: DeferredValue<void>;
          readonly delivery: DeferredValue<PlayerResult>;
        }
      | undefined;
    let deferInspectionEmissions = false;
    let deferredInspectionEmissions: Array<() => void> = [];
    let controlPlaneError: unknown;
    // Previous root-machine state for the inspect-driven telemetry /
    // status emitter. undefined before the first inspect firing.
    let priorState: PlaybookState | undefined;
    let suppressInspectionEmissions = false;

    let traceSequence = 0;
    let turnSequence = 0;
    let judgeCallSequence = 0;
    let playerCallSequence = 0;
    let playbookCallSequence = 0;
    let captainCallSequence = 0;
    let applyCallSequence = 0;
    // DR-029: the last event a public Boss boundary sent into the
    // machine — classified, deterministic entry, or Boss reply — kept with
    // its recorded payload so a failure-state retry action can replay the
    // event that drove the run into `failed`. Process-local: the durable
    // runtime snapshot does not persist it (PBRT-50).
    let lastBossEvent: EventObject | undefined;
    // DR-029: process-local at-most-once `apply` execution — the accepted receipt
    // recorded for each idempotency key, returned verbatim on a repeated
    // key. A key whose call settled `rejected` or threw before reaching
    // acceptance records nothing, so a later call with that key may still
    // execute.
    const appliedReceipts = new Map<string, PlaybookControlReceipt>();
    const privateResumeTokens = new Map<string, string>();
    const activePlayerKeys = new Set<string>();
    const playbookCallTurnIds = new Map<string, number | undefined>();
    const playbookCallEffectPrefixes = new Map<
      string,
      number | undefined
    >();
    // Captain and judge work share one serialized lane (slc/link.md
    // §Session lifecycle).
    const judgeQueue = new PQueue({ concurrency: 1 });
    const emissionQueue = new PQueue({ concurrency: 1 });
    const activeEmissionCalls = new Set<Promise<void>>();

    // All trace, state-telemetry, and status work shares this one queue.
    // Inspection callbacks enqueue a complete ordered batch synchronously;
    // imperative boundaries await their queued work directly.
    let emissionFailure: { readonly error: unknown } | undefined;

    function runtimeLogicalOperations(
      ledger: PlaybookEffectLedger = effectLedgerMirror,
    ): PlaybookEffectLogicalOperation[] {
      if (session === undefined) return [];
      const runtimeSessionIds = new Set([
        session.sessionId,
        ...(retainedEffectSourceSessionId === undefined
          ? []
          : [retainedEffectSourceSessionId]),
      ]);
      return ledger.logicalOperations.filter(
        (operation) =>
          operation.playbookId === session!.playbookId &&
          runtimeSessionIds.has(operation.runtimeSessionId),
      );
    }

    function refreshRetainedEffectReconciliation(
      current: PlaybookEffectLedger = effectLedgerMirror,
    ): void {
      const retained = retainedEffectReconciliation;
      if (retained === undefined) {
        retainedEffectReconciliationRequired = false;
        return;
      }
      const safe = retainedAdoptionCheckpointIsSafe(
        retained.checkpoint,
        current,
      );
      retainedEffectReconciliationRequired = !safe;
      if (safe) {
        retainedEffectReconciliation = undefined;
        reconstructedGovernedPrefixSequence = undefined;
      }
    }

    function bindRetainedEffectReconciliation(
      retained:
        | PlaybookRuntimeSnapshot['retainedEffectReconciliation']
        | undefined,
      current: PlaybookEffectLedger,
    ): void {
      retainedEffectReconciliation = retained;
      refreshRetainedEffectReconciliation(current);
      reconstructedGovernedPrefixSequence =
        retainedEffectReconciliation === undefined
          ? undefined
          : (retainedEffectReconciliation.checkpoint.boundaries.at(-1)
              ?.sequence ?? 0);
    }

    function refreshRetainedEffectFenceFromHost(): void {
      if (retainedEffectReconciliation === undefined) return;
      const retainedBeforeRefresh = retainedEffectReconciliation;
      try {
        effectLedgerMirror = currentEffectLedger();
        refreshRetainedEffectReconciliation(effectLedgerMirror);
        syncDeferredReconciliationOverlay();
        refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
      } catch {
        // A fence can open only from validated authoritative evidence. If the
        // live mirror or its source-owned deferred-operation view cannot be
        // read exactly, keep every ordinary entry point closed.
        retainedEffectReconciliation ??= retainedBeforeRefresh;
        deferredReconciliationOperationId = undefined;
        retainedEffectReconciliationRequired = true;
      }
    }

    function syncDeferredReconciliationOverlay(): void {
      const unresolved = runtimeLogicalOperations().filter(
        (operation) =>
          operation.logicalReceipt === undefined &&
          (operation.checkpointRestorationEligible ||
            operation.pendingQuestion === undefined),
      );
      if (unresolved.length > 1) {
        throw new Error(
          `${label} effect ledger contains multiple unresolved deferred operations`,
        );
      }
      deferredReconciliationOperationId = unresolved[0]?.operationId;
    }

    function runtimeBoundaryIsOwned(
      boundary: PlaybookEffectBoundary,
    ): boolean {
      if (session === undefined || boundary.playbookId !== session.playbookId) {
        return false;
      }
      return (
        boundary.runtimeSessionId === session.sessionId ||
        boundary.runtimeSessionId === retainedEffectSourceSessionId
      );
    }

    function governedOutcomesForBoundary(
      candidate: PlaybookEffectBoundary,
    ): Readonly<Record<string, XStateGovernedOutcomeSpec>> | undefined {
      const outcomes =
        outcomeAuthority?.governedPlayerStates[candidate.sourceStateId];
      if (outcomes === undefined) return undefined;
      if (
        !isPlainObject(candidate.sourceOutcomeSchema) ||
        !sameStringSet(
          Object.keys(candidate.sourceOutcomeSchema),
          Object.keys(outcomes),
        )
      ) {
        return undefined;
      }
      for (const [guard, description] of Object.entries(
        candidate.sourceOutcomeSchema,
      )) {
        if (typeof description !== 'string') return undefined;
        const describedFields = [...new Set(extractFields(description))];
        if (!sameStringSet(describedFields, Object.keys(outcomes[guard]!.fields))) {
          return undefined;
        }
      }
      const expectedDispositions = [
        ...new Set(
          Object.values(outcomes).map(
            ({ repositoryDisposition }) => repositoryDisposition,
          ),
        ),
      ];
      if (!sameStringSet(candidate.dispositions, expectedDispositions)) {
        return undefined;
      }
      return outcomes;
    }

    function persistedBoundaryReconciliation(
      candidate: PlaybookEffectBoundary,
      ledger: PlaybookEffectLedger,
    ):
      | {
          readonly reconciliation: ReturnType<
            typeof reconcilePlaybookSemanticEvidence
          >;
          readonly historicalDeferred: boolean;
        }
      | undefined {
      const outcomes = governedOutcomesForBoundary(candidate);
      if (outcomes === undefined || candidate.semanticCandidate === undefined) {
        return undefined;
      }
      let receipt = candidate.physicalReceipt;
      let historicalDeferred = false;
      let awaitingLogicalReceipt = false;
      if (candidate.logicalOperationId !== undefined) {
        const operation = ledger.logicalOperations.find(
          ({ operationId }) =>
            operationId === candidate.logicalOperationId,
        );
        if (operation === undefined) return undefined;
        const latestBoundaryId = operation.boundaryIds.at(-1);
        if (latestBoundaryId !== candidate.boundaryId) {
          // Earlier questions remain independently validated historical
          // evidence. Their physical same-HEAD receipt, candidate, and
          // reciprocal operation link must still prove a deferred arm.
          historicalDeferred = true;
        } else if (operation.logicalReceipt !== undefined) {
          receipt = operation.logicalReceipt;
        } else if (
          operation.pendingQuestion === undefined ||
          operation.checkpoint === undefined ||
          !Object.prototype.hasOwnProperty.call(
            operation,
            'playerContinuation',
          )
        ) {
          return undefined;
        } else {
          awaitingLogicalReceipt = true;
        }
      }
      try {
        const reconciliation = reconcilePlaybookSemanticEvidence({
          outcomes,
          semanticCandidate: candidate.semanticCandidate,
          finalText: candidate.finalText,
          receipt,
        });
        if (
          awaitingLogicalReceipt &&
          reconciliation.status !== 'deferred'
        ) {
          return undefined;
        }
        return {
          reconciliation,
          historicalDeferred,
        };
      } catch {
        return undefined;
      }
    }

    function boundaryNeedsSemanticReconciliation(
      candidate: PlaybookEffectBoundary,
      ledger: PlaybookEffectLedger,
    ): boolean {
      if (!runtimeBoundaryIsOwned(candidate)) return false;
      if (governedOutcomesForBoundary(candidate) === undefined) return true;
      const persisted = persistedBoundaryReconciliation(candidate, ledger);
      if (persisted !== undefined) {
        if (persisted.reconciliation.status === 'unresolved') return true;
        if (persisted.historicalDeferred) {
          return persisted.reconciliation.status !== 'deferred';
        }
        if (
          persisted.reconciliation.status === 'deferred' &&
          candidate.logicalOperationId === undefined
        ) {
          return true;
        }
        return false;
      }
      if (candidate.physicalReceipt === undefined) {
        // An unsafe retained suffix is already owned by the task-8 adoption
        // fence, which may still expose its exact deferred-restoration
        // action. A same-generation incomplete boundary has no such fence
        // and remains semantic/effect unresolved until host reconstruction.
        return retainedEffectReconciliation === undefined;
      }
      if (
        typeof candidate.finalText === 'string' &&
        candidate.finalText.trim().length > 0
      ) {
        return true;
      }
      return candidate.physicalReceipt.classification !== 'unchanged';
    }

    function refreshUnresolvedSemanticReconciliation(
      current: PlaybookEffectLedger = effectLedgerMirror,
    ): void {
      unresolvedSemanticBoundaryIds.clear();
      if (outcomeAuthority === undefined || session === undefined) return;
      for (const candidate of current.boundaries) {
        if (boundaryNeedsSemanticReconciliation(candidate, current)) {
          unresolvedSemanticBoundaryIds.add(candidate.boundaryId);
        }
      }
    }

    function prepareReconstructedGovernedDelivery(
      state: PlaybookState,
      ledger: PlaybookEffectLedger = effectLedgerMirror,
    ): void {
      reconstructedGovernedDelivery = undefined;
      if (
        state.stateId === undefined ||
        state.activeStateIds.length !== 1
      ) {
        return;
      }
      const owned = ledger.boundaries.filter(runtimeBoundaryIsOwned);
      const candidate =
        reconstructedGovernedPrefixSequence === undefined
          ? owned.at(-1)
          : owned.find(
              ({ sequence }) =>
                sequence > reconstructedGovernedPrefixSequence!,
            );
      if (candidate === undefined || candidate.sourceStateId !== state.stateId) {
        return;
      }
      const persisted = persistedBoundaryReconciliation(candidate, ledger);
      if (
        persisted === undefined ||
        persisted.historicalDeferred ||
        persisted.reconciliation.status !== 'resolved' ||
        typeof candidate.finalText !== 'string'
      ) {
        return;
      }
      reconstructedGovernedDelivery = {
        boundary: candidate,
        finalText: candidate.finalText,
        settlement: {
          status: 'resolved',
          output: persisted.reconciliation.output as PlaybookActorOutput,
        },
      };
    }

    function takeReconstructedGovernedPlayerResult(
      input: PlaybookPlayerInput,
      roleId: string,
    ): PlayerResult | undefined {
      const reconstructed = reconstructedGovernedDelivery;
      if (reconstructed === undefined) return undefined;
      // A reconstructed envelope is consumable once even when a hostile host
      // changes its mirror between restore validation and actor startup.
      reconstructedGovernedDelivery = undefined;
      const current = currentEffectLedger();
      effectLedgerMirror = current;
      syncDeferredReconciliationOverlay();
      refreshUnresolvedSemanticReconciliation(current);
      const completed = current.boundaries.find(
        ({ boundaryId }) => boundaryId === reconstructed.boundary.boundaryId,
      );
      const expected =
        reconstructedGovernedPrefixSequence === undefined
          ? current.boundaries.filter(runtimeBoundaryIsOwned).at(-1)
          : current.boundaries
              .filter(runtimeBoundaryIsOwned)
              .find(
                ({ sequence }) =>
                  sequence > reconstructedGovernedPrefixSequence!,
              );
      const persisted =
        completed === undefined
          ? undefined
          : persistedBoundaryReconciliation(completed, current);
      if (
        completed === undefined ||
        expected?.boundaryId !== completed.boundaryId ||
        !isDeepStrictEqual(completed, reconstructed.boundary) ||
        completed.sourceStateId !== input.stateId ||
        completed.roleId !== roleId ||
        !isDeepStrictEqual(completed.sourceOutcomeSchema, input.result) ||
        persisted === undefined ||
        persisted.historicalDeferred ||
        persisted.reconciliation.status !== 'resolved' ||
        completed.finalText !== reconstructed.finalText ||
        !isDeepStrictEqual(
          persisted.reconciliation.output,
          reconstructed.settlement.output,
        )
      ) {
        unresolvedSemanticBoundaryIds.add(reconstructed.boundary.boundaryId);
        throw markFsmResultFailure(
          new Error(
            `${label} retained governed semantic envelope is no longer exact`,
          ),
        );
      }
      validateBossReplyOutput(
        input,
        reconstructed.settlement.output,
        resumableStateIds,
      );
      const result = validatePlayerResult({
        status: 'ok',
        finalText: reconstructed.finalText,
      });
      playerBoundaryReceipts.set(result, {
        boundaryId: completed.boundaryId,
        attemptId: completed.attemptId,
      });
      governedPlayerSettlements.set(result, reconstructed.settlement);
      reconstructedGovernedResults.set(result, completed);
      return result;
    }

    function acceptReconstructedGovernedDelivery(
      state: PlaybookState,
    ): void {
      const accepted = reconstructedAcceptancePending;
      if (
        accepted === undefined ||
        state.stateId === accepted.sourceStateId
      ) {
        return;
      }
      reconstructedAcceptancePending = undefined;
      let current: PlaybookEffectLedger;
      try {
        current = currentEffectLedger();
        effectLedgerMirror = current;
        syncDeferredReconciliationOverlay();
        refreshUnresolvedSemanticReconciliation(current);
      } catch {
        unresolvedSemanticBoundaryIds.add(accepted.boundaryId);
        return;
      }
      const acknowledged = current.boundaries.find(
        ({ boundaryId }) => boundaryId === accepted.boundaryId,
      );
      if (
        acknowledged === undefined ||
        !isDeepStrictEqual(acknowledged, accepted)
      ) {
        unresolvedSemanticBoundaryIds.add(accepted.boundaryId);
        return;
      }
      if (reconstructedGovernedPrefixSequence !== undefined) {
        reconstructedGovernedPrefixSequence = accepted.sequence;
        prepareReconstructedGovernedDelivery(state, current);
        if (
          current.boundaries
            .filter(runtimeBoundaryIsOwned)
            .some(
              ({ sequence }) =>
                sequence > reconstructedGovernedPrefixSequence!,
            )
        ) {
          return;
        }
      }
      if (
        unresolvedSemanticBoundaryIds.size > 0 ||
        deferredReconciliationOperationId !== undefined
      ) {
        return;
      }
      // Task 9 has now projected the retained, host-acknowledged envelope
      // into the FSM. Only after that acceptance may the task-8 adoption
      // marker retire; an unresolved sibling boundary leaves it intact.
      retainedEffectReconciliation = undefined;
      retainedEffectReconciliationRequired = false;
      reconstructedGovernedPrefixSequence = undefined;
    }

    function hasUnresolvedReconciliation(): boolean {
      return (
        deferredReconciliationOperationId !== undefined ||
        retainedEffectReconciliationRequired ||
        unresolvedSemanticBoundaryIds.size > 0
      );
    }

    function unresolvedEffectEnvelopeIdentities(): readonly (
      | { readonly kind: 'boundary'; readonly boundaryId: string }
      | { readonly kind: 'logical-operation'; readonly operationId: string }
    )[] {
      if (artifactSchema !== 3 || session === undefined) return [];
      const current = currentEffectLedger();
      effectLedgerMirror = current;
      refreshRetainedEffectReconciliation(current);
      syncDeferredReconciliationOverlay();
      refreshUnresolvedSemanticReconciliation(current);
      if (!hasUnresolvedReconciliation()) return [];

      const boundaryIds = new Set(unresolvedSemanticBoundaryIds);
      const operationIds = new Set<string>();
      if (deferredReconciliationOperationId !== undefined) {
        operationIds.add(deferredReconciliationOperationId);
      }
      if (retainedEffectReconciliationRequired) {
        const checkpointLength = retainedEffectReconciliation?.checkpoint
          .boundaries.length ?? 0;
        for (const boundary of current.boundaries.slice(checkpointLength)) {
          if (boundary.physicalReceipt?.classification === 'unchanged') {
            continue;
          }
          boundaryIds.add(boundary.boundaryId);
        }
      }

      for (const boundaryId of [...boundaryIds]) {
        const boundary = current.boundaries.find(
          (candidate) => candidate.boundaryId === boundaryId,
        );
        if (
          boundary?.logicalOperationId !== undefined &&
          current.logicalOperations.some(
            ({ operationId }) => operationId === boundary.logicalOperationId,
          )
        ) {
          operationIds.add(boundary.logicalOperationId);
          for (const memberId of current.logicalOperations.find(
            ({ operationId }) => operationId === boundary.logicalOperationId,
          )!.boundaryIds) {
            boundaryIds.delete(memberId);
          }
        }
      }

      const ordered = [
        ...[...boundaryIds].map((boundaryId) => ({
          order:
            current.boundaries.find(
              (candidate) => candidate.boundaryId === boundaryId,
            )?.sequence ?? Number.MAX_SAFE_INTEGER,
          value: { kind: 'boundary' as const, boundaryId },
        })),
        ...[...operationIds].map((operationId) => {
          const operation = current.logicalOperations.find(
            (candidate) => candidate.operationId === operationId,
          );
          const firstBoundaryId = operation?.boundaryIds[0];
          return {
            order:
              current.boundaries.find(
                ({ boundaryId }) => boundaryId === firstBoundaryId,
              )?.sequence ?? Number.MAX_SAFE_INTEGER,
            value: { kind: 'logical-operation' as const, operationId },
          };
        }),
      ].sort((left, right) => left.order - right.order);
      return deepFreeze(
        snapshotJsonValue(
          ordered.map(({ value }) => value),
          `${label} unresolved effect envelope identities`,
        ) as unknown as (
          | { readonly kind: 'boundary'; readonly boundaryId: string }
          | { readonly kind: 'logical-operation'; readonly operationId: string }
        )[],
      );
    }

    function closeAfterIndeterminateDeferredSettlement(
      operationId: string | undefined,
      cause: unknown,
    ): void {
      try {
        effectLedgerMirror = currentEffectLedger();
        refreshRetainedEffectReconciliation(effectLedgerMirror);
        syncDeferredReconciliationOverlay();
        refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
      } catch {
        // The current host mirror is itself unavailable. The closure below
        // keeps every public state surface shut until a fresh host recovers
        // the write-ahead record and constructs a replacement runtime.
      }
      expectedBoundPendingQuestion = undefined;
      deferredSettlementClosure ??= new Error(
        `${label} deferred settlement is indeterminate; recover the host effect ledger before continuing`,
        { cause },
      );
      if (
        operationId !== undefined &&
        deferredReconciliationOperationId === undefined
      ) {
        deferredReconciliationOperationId = operationId;
      }
    }

    function assertDeferredSettlementOpen(method: string): void {
      if (deferredSettlementClosure !== undefined) {
        throw new Error(
          `createPlaybookRuntime.${method}: deferred settlement recovery is required`,
          { cause: deferredSettlementClosure },
        );
      }
    }

    function currentBoundDeferredOperation(
      pending: PlaybookPendingBossQuestionContext,
    ): PlaybookEffectLogicalOperation | undefined {
      const projected = {
        questionId: pending.questionId,
        asker: pending.asker,
        question: pending.question,
        sourceItem: pending.sourceItem,
      };
      const matches = runtimeLogicalOperations().filter(
        (operation) =>
          operation.logicalReceipt === undefined &&
          operation.checkpoint !== undefined &&
          operation.pendingQuestion !== undefined &&
          operation.playerContinuation !== undefined &&
          !operation.checkpointRestorationEligible &&
          isDeepStrictEqual(operation.pendingQuestion, projected),
      );
      if (matches.length > 1) {
        throw new Error(
          `${label} effect ledger contains multiple operations for one pending question`,
        );
      }
      return matches[0];
    }

    function continuationBoundarySeed(
      operation: PlaybookEffectLogicalOperation,
      turnId: number,
    ): XStateEffectBoundarySeed {
      const latestBoundaryId = operation.boundaryIds.at(-1);
      const latestBoundary = effectLedgerMirror.boundaries.find(
        ({ boundaryId }) => boundaryId === latestBoundaryId,
      );
      if (latestBoundary === undefined) {
        throw new Error(
          `${label} deferred logical operation has no latest physical boundary`,
        );
      }
      return {
        boundaryId: randomUUID(),
        runtimeSessionId: latestBoundary.runtimeSessionId,
        turnId,
        callId: `player-${++playerCallSequence}`,
        roleId: latestBoundary.roleId,
        sourceStateId: latestBoundary.sourceStateId,
        sourceOutcomeSchema: latestBoundary.sourceOutcomeSchema,
        dispositions: latestBoundary.dispositions,
        correctionBudget: { limit: 1, spent: false },
      };
    }

    function bindSession(nextSession: PlaybookSession): PlaybookSession {
      const bound = snapshotPlaybookSession(nextSession);
      if (bound.roleBindings === undefined) return bound;
      const actual = Object.keys(bound.roleBindings).sort();
      const expected = [...declaredRoleIds].sort();
      const missing = expected.filter((roleId) => !actual.includes(roleId));
      const extra = actual.filter((roleId) => !expected.includes(roleId));
      if (missing.length > 0 || extra.length > 0) {
        throw new TypeError(
          `${label} session roleBindings must cover exactly [${expected.join(', ')}]` +
            `${missing.length === 0 ? '' : `; missing [${missing.join(', ')}]`}` +
            `${extra.length === 0 ? '' : `; extra [${extra.join(', ')}]`}`,
        );
      }
      return bound;
    }

    function requireRoleId(input: PlaybookPlayerInput): string {
      const roleId = input.role;
      if (
        typeof roleId !== 'string' ||
        roleId.trim().length === 0 ||
        !declaredRoleIds.includes(roleId)
      ) {
        throw new TypeError(
          `${label} player input role must name a declared local role`,
        );
      }
      return roleId;
    }

    function resolvedPlayerId(roleId: string): string | undefined {
      return session?.roleBindings?.[roleId]?.playerId;
    }

    function promptIdentity(roleId: string): string {
      if (!declaredRoleIds.includes(roleId)) {
        throw new TypeError(
          `${label} prompt identity lookup rejected undeclared role ${roleId}`,
        );
      }
      return session?.roleBindings?.[roleId]?.promptIdentity ?? roleId;
    }

    function composeBoundPlayerPrompt(input: PlaybookPlayerInput): string {
      let active = true;
      const lookup: XStatePromptIdentity = (roleId) => {
        if (!active) {
          throw new Error(
            `${label} prompt identity lookup is no longer active`,
          );
        }
        return promptIdentity(roleId);
      };
      try {
        return composePlayerPrompt(input, lookup);
      } finally {
        active = false;
      }
    }

    function continuationKey(
      roleId: string,
      playerId: string | undefined,
    ): string {
      return playerId ?? roleId;
    }

    function roleTokensByContinuationKey(
      tokens: Readonly<Record<string, string>>,
    ): Map<string, string> {
      const byKey = new Map<string, string>();
      for (const [roleId, token] of Object.entries(tokens)) {
        if (!declaredRoleIds.includes(roleId)) {
          throw new TypeError(
            `runtime role tokens contain unknown role ${roleId}`,
          );
        }
        const key = continuationKey(roleId, resolvedPlayerId(roleId));
        const existing = byKey.get(key);
        if (existing !== undefined && existing !== token) {
          throw new TypeError(
            `runtime snapshot assigns conflicting tokens to roles bound to player ${key}`,
          );
        }
        byKey.set(key, token);
      }
      const rolesByKey = new Map<string, string[]>();
      for (const roleId of declaredRoleIds) {
        const key = continuationKey(roleId, resolvedPlayerId(roleId));
        rolesByKey.set(key, [...(rolesByKey.get(key) ?? []), roleId]);
      }
      for (const [key, roles] of rolesByKey) {
        if (roles.length < 2) continue;
        const present = roles.filter((roleId) => tokens[roleId] !== undefined);
        if (present.length !== 0 && present.length !== roles.length) {
          throw new TypeError(
            `runtime role tokens must project player ${key} through every aliased role [${roles.join(', ')}]`,
          );
        }
      }
      return byKey;
    }

    function selectPlayerResume(
      roleId: string,
      playerId: string | undefined,
    ): string | false {
      const key = continuationKey(roleId, playerId);
      const selected = session?.playerSessions
        ? session.playerSessions.select(roleId)
        : privateResumeTokens.get(key) ?? false;
      if (
        selected !== false &&
        (typeof selected !== 'string' || selected.trim().length === 0)
      ) {
        throw new TypeError(
          `player session store returned an invalid resume token for role ${roleId}`,
        );
      }
      return selected;
    }

    function updatePlayerResume(
      roleId: string,
      playerId: string | undefined,
      result: PlayerResult,
    ): void {
      const resumeToken = result.resumeToken;
      if (resumeToken === undefined && result.status !== 'ok') return;
      const key = continuationKey(roleId, playerId);
      if (session?.playerSessions) {
        session.playerSessions.update(roleId, resumeToken);
      } else if (resumeToken !== undefined) {
        privateResumeTokens.set(key, resumeToken);
      } else {
        privateResumeTokens.delete(key);
      }
    }

    function snapshotRoleResumeTokens(): Record<string, string> {
      const raw = snapshotJsonValue(
        session?.playerSessions
          ? session.playerSessions.snapshot()
          : Object.fromEntries(
              declaredRoleIds.flatMap((roleId) => {
                const token = privateResumeTokens.get(
                  continuationKey(roleId, resolvedPlayerId(roleId)),
                );
                return token === undefined ? [] : [[roleId, token]];
              }),
            ),
        'player session store snapshot',
      );
      if (!isPlainObject(raw)) {
        throw new TypeError('player session store snapshot must be an object');
      }
      const detached: Record<string, string> = {};
      for (const [roleId, token] of Object.entries(raw)) {
        if (!declaredRoleIds.includes(roleId)) {
          throw new TypeError(
            `player session store snapshot contains unknown role ${roleId}`,
          );
        }
        if (typeof token !== 'string' || token.trim().length === 0) {
          throw new TypeError(
            `player session store snapshot token for ${roleId} must be a non-empty string`,
          );
        }
        detached[roleId] = token;
      }
      roleTokensByContinuationKey(detached);
      return detached;
    }

    function restoreRoleResumeTokens(
      tokens: Readonly<Record<string, string>>,
    ): void {
      const byKey = roleTokensByContinuationKey(tokens);
      if (session?.playerSessions) {
        session.playerSessions.restore(tokens);
        return;
      }
      privateResumeTokens.clear();
      for (const [key, token] of byKey) privateResumeTokens.set(key, token);
    }

    function enqueueEmission(
      fn: () => Promise<void>,
      aborts: AbortReasonClassifier | undefined = activeAborts,
    ): Promise<void> {
      // The emission belongs to the boundary enqueueing it: a rejection
      // causally identical to that boundary's abort reason is the
      // cancellation's own evidence — never latched, so it cannot poison a
      // later unrelated boundary (DR-036).
      const enqueueAborts = aborts;
      const queued = emissionQueue.add(fn).then(() => undefined);
      activeEmissionCalls.add(queued);
      void queued.then(
        () => activeEmissionCalls.delete(queued),
        (error: unknown) => {
          activeEmissionCalls.delete(queued);
          if (enqueueAborts?.isAbortReason(error)) {
            // Record evidence only when it also belongs to the public
            // boundary that is still active. A background A cancellation
            // racing an unrelated B boundary is forgiven under A and must
            // not change B's settlement.
            if (activeAborts?.isAbortReason(error)) {
              activeAbortEmission ??= error;
            }
            return;
          }
          emissionFailure ??= { error };
        },
      );
      return queued;
    }

    async function drainEmissions(
      _aborts: AbortReasonClassifier | undefined = activeAborts,
    ): Promise<void> {
      while (true) {
        const active = [...activeEmissionCalls];
        if (active.length > 0) await Promise.allSettled(active);
        await emissionQueue.onIdle();
        if (
          activeEmissionCalls.size === 0 &&
          emissionQueue.size === 0 &&
          emissionQueue.pending === 0
        ) {
          break;
        }
      }
      if (emissionFailure !== undefined) {
        const { error } = emissionFailure;
        emissionFailure = undefined;
        // The failure was classified as distinct by its enqueue owner. If a
        // later public boundary drains it, retain that classification in the
        // boundary latch before throwing; its signal must not reinterpret
        // the same object as cancellation (DR-036 decision 2).
        if (activeSignal !== undefined) controlPlaneError ??= error;
        throw error;
      }
    }

    function requireSession(): PlaybookSession {
      if (!session) {
        throw new Error('createPlaybookRuntime: init must be called first');
      }
      return session;
    }

    function requireHostPorts(): PlaybookPorts {
      if (!savedPorts) {
        throw new Error('createPlaybookRuntime: init must be called first');
      }
      return savedPorts;
    }

    function createTraceEvent(
      type: PlaybookTraceType,
      payload: unknown,
      position: TracePosition = {},
    ): PlaybookTraceEvent {
      const currentSession = requireSession();
      const safePayload = snapshotJsonValue(payload, `trace ${type} payload`);
      return {
        schemaVersion: 4,
        sessionId: currentSession.sessionId,
        playbookId: currentSession.playbookId,
        rootSessionId: currentSession.rootSessionId,
        ...(currentSession.parentSessionId !== undefined
          ? { parentSessionId: currentSession.parentSessionId }
          : {}),
        ...(currentSession.parentCallId !== undefined
          ? { parentCallId: currentSession.parentCallId }
          : {}),
        depth: currentSession.depth,
        sequence: ++traceSequence,
        timestamp: Date.now(),
        type,
        ...(position.turnId !== undefined ? { turnId: position.turnId } : {}),
        ...(position.callId !== undefined ? { callId: position.callId } : {}),
        payload: safePayload,
      };
    }

    function emitTrace(
      type: PlaybookTraceType,
      payload: unknown,
      position: TracePosition = {},
      aborts?: AbortReasonClassifier,
    ): Promise<void> {
      const currentSession = requireSession();
      const event = createTraceEvent(type, payload, position);
      return enqueueEmission(
        () =>
          currentSession.ports.emitTelemetry({
            topic: 'playbook.trace',
            payload: event,
          }),
        aborts,
      );
    }

    function stateIdentity(stateId: string | undefined): { stateId?: string } {
      return stateId === undefined ? {} : { stateId };
    }

    function currentState(): PlaybookState {
      if (!actor) {
        throw new Error('createPlaybookRuntime: actor is not initialized');
      }
      return normalizePlaybookSnapshot(actor.getSnapshot(), {
        pendingCall: nestedBridge.getPendingCall(),
      });
    }

    function stateTracePayload(
      state = currentState(),
    ): Record<string, unknown> {
      return {
        state,
        ...stateIdentity(state.stateId),
      };
    }

    function createRuntimePorts(hostPorts: PlaybookPorts): PlaybookPorts {
      return {
        callPlayer: (playerId, prompt, signal, callOptions) =>
          hostPorts.callPlayer(playerId, prompt, signal, callOptions),
        callCaptain: (prompt, signal, callOptions) =>
          hostPorts.callCaptain(prompt, signal, callOptions),
        callJudge: (prompt, signal) => hostPorts.callJudge(prompt, signal),
        callPlaybook: (request, signal) =>
          hostPorts.callPlaybook(request, signal),
        emitStatus: (message, data) => {
          const descriptor = actor ? currentState() : undefined;
          const safeData =
            data === undefined
              ? undefined
              : snapshotJsonValue(data, 'status data');
          const trace = createTraceEvent(
            'status.emitted',
            {
              message,
              ...(safeData !== undefined ? { data: safeData } : {}),
              ...(descriptor !== undefined
                ? {
                    state: descriptor,
                    ...stateIdentity(descriptor.stateId),
                  }
                : {}),
            },
            activeTurnId !== undefined ? { turnId: activeTurnId } : {},
          );
          return enqueueEmission(async () => {
            await hostPorts.emitTelemetry({
              topic: 'playbook.trace',
              payload: trace,
            });
            await hostPorts.emitStatus(message, safeData);
          });
        },
        emitTelemetry: (event) => {
          if (typeof event.topic !== 'string' || event.topic.length === 0) {
            throw new TypeError('telemetry topic must be a non-empty string');
          }
          const payload = snapshotJsonValue(event.payload, 'telemetry payload');
          return enqueueEmission(() =>
            hostPorts.emitTelemetry({ topic: event.topic, payload }),
          );
        },
      };
    }

    async function emitCallStarted(
      startedType:
        | 'player.call.started'
        | 'judge.call.started'
        | 'captain.call.started'
        | 'apply.started',
      finishedType:
        | 'player.call.finished'
        | 'judge.call.finished'
        | 'captain.call.finished'
        | 'apply.finished',
      identity: Record<string, unknown>,
      position: TracePosition,
      // The applicable combined signal: a start-sink rejection causally
      // identical to its reason is the cancellation itself, not a control
      // error — the pair finishes `aborted` and nothing latches
      // (slc/link.md §Abort).
      signal: AbortSignal,
      // Base payload of the best-effort finish emitted when the start sink
      // rejects; it defaults to the payload the start carried, which the
      // player, judge, and captain pairs take as-is. The apply pair cannot:
      // its finish carries the receipt disposition and none of the
      // start-only fields, so it passes its own canonical pre-acceptance
      // base (slc/link.md §Playbook trace).
      finishIdentity: Record<string, unknown> = identity,
    ): Promise<void> {
      try {
        await emitTrace(startedType, identity, position);
      } catch (error) {
        if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
        try {
          await emitTrace(
            finishedType,
            {
              ...finishIdentity,
              status: isAbortFailure(error, signal) ? 'aborted' : 'error',
              error: normalizeError(error),
            },
            position,
          );
        } catch {
          // Preserve the start failure after one best-effort finish attempt.
        }
        throw error;
      }
    }

    function governedBoundarySeed(
      input: PlaybookPlayerInput,
      roleId: string,
      callId: string,
      turnId: number | undefined,
    ): XStateEffectBoundarySeed | undefined {
      const governed = outcomeAuthority?.governedPlayerStates[input.stateId];
      if (governed === undefined) return undefined;
      if (!Number.isSafeInteger(turnId) || turnId === undefined || turnId <= 0) {
        throw new Error(
          `${label} governed player call requires an active positive turn id`,
        );
      }
      const dispositions = [
        ...new Set(
          Object.values(governed).map(
            ({ repositoryDisposition }) => repositoryDisposition,
          ),
        ),
      ];
      if (dispositions.length === 0) {
        throw new Error(
          `${label} governed player call has no repository disposition`,
        );
      }
      return {
        boundaryId: randomUUID(),
        // An adopted runtime keeps one durable effect-owner identity across
        // every later target generation. New boundaries must join that same
        // lineage; otherwise a boundary started by an intermediate target is
        // no longer discoverable after the next adoption.
        runtimeSessionId:
          retainedEffectSourceSessionId ?? requireSession().sessionId,
        turnId,
        callId,
        roleId,
        sourceStateId: input.stateId,
        sourceOutcomeSchema: snapshotJsonValue(
          input.result,
          `${label} governed player source outcome schema`,
        ),
        dispositions,
        correctionBudget: { limit: 1, spent: false },
      };
    }

    function boundPendingQuestion(
      input: PlaybookPlayerInput,
      roleId: string,
      output: PlaybookActorOutput,
    ): PlaybookPendingBossQuestionContext {
      if (output.guard !== 'needsBossReply' || typeof output.question !== 'string') {
        throw new TypeError(
          `${label} deferred outcome must carry one exact Boss question`,
        );
      }
      return {
        questionId: input.stateId,
        resumeStateId: input.stateId,
        sourceItem: input.sourceItem,
        asker: { kind: 'role', roleId },
        question: output.question,
      };
    }

    function detachedPlayerContinuation(
      roleId: string,
      playerId: string | undefined,
    ): JsonValue {
      return snapshotJsonValue(
        selectPlayerResume(roleId, playerId),
        `${label} deferred player continuation`,
      );
    }

    function completionEvidenceFor(
      input: PlaybookPlayerInput,
      roleId: string,
      playerId: string | undefined,
      signal: AbortSignal,
      operationId: string | undefined,
    ): (
      completion: XStateRepositoryExclusiveCompletion<PlayerResult>,
    ) => Promise<XStateRepositoryCompletionEvidence> {
      return async (completion) => {
        const { operation } = completion;
        let evidence: XStateRepositoryCompletionEvidence;
        if (
          operation.status !== 'fulfilled' ||
          operation.value.status !== 'ok' ||
          isEmptyFinalText(operation.value.finalText)
        ) {
          evidence = operation.status === 'fulfilled' &&
            operation.value.status === 'ok' &&
            operation.value.finalText !== undefined
            ? { finalText: operation.value.finalText }
            : {};
        } else {
          const finalText = operation.value.finalText!;
          evidence = await reconcileGovernedCompletion(
            input,
            roleId,
            playerId,
            finalText,
            signal,
            operationId,
            completion,
          );
        }
        rememberGovernedCompletionEvidence(
          completion.boundary.boundaryId,
          evidence,
        );
        return evidence;
      };
    }

    function rememberGovernedCompletionEvidence(
      boundaryId: string,
      evidence: XStateRepositoryCompletionEvidence,
    ): void {
      const previous = governedCompletionEvidenceByBoundaryId.get(boundaryId);
      governedCompletionEvidenceByBoundaryId.set(boundaryId, {
        ...previous,
        boundaryEvidence: {
          ...(Object.prototype.hasOwnProperty.call(evidence, 'finalText')
            ? { finalText: evidence.finalText! }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(
            evidence,
            'semanticCandidate',
          )
            ? { semanticCandidate: evidence.semanticCandidate! }
            : {}),
        },
      });
    }

    function unresolvedGovernedSettlement(
      reason: string,
      error?: unknown,
      signal: AbortSignal | undefined = activeSignal,
    ): GovernedPlayerSettlement {
      if (error !== undefined && signal?.aborted && Object.is(error, signal.reason)) {
        return { status: 'unresolved', error };
      }
      const failure =
        error instanceof Error
          ? error
          : new Error(`${label} governed outcome remains unresolved: ${reason}`);
      return {
        status: 'unresolved',
        error: markFsmResultFailure(failure),
      };
    }

    async function spendSemanticCorrectionBudget(
      completedBoundary: PlaybookEffectBoundary,
      receipt: PlaybookRepositoryReceipt,
      finalText: string,
      semanticCandidate: JsonValue | undefined,
    ): Promise<PlaybookEffectBoundary | undefined> {
      if (effectLedgerCapability === undefined) return undefined;
      const currentLedger = currentEffectLedger();
      const current = currentLedger.boundaries.find(
        ({ boundaryId }) => boundaryId === completedBoundary.boundaryId,
      );
      if (
        current === undefined ||
        current.correctionBudget.limit !== 1 ||
        current.correctionBudget.spent
      ) {
        return undefined;
      }
      if (
        current.finalText !== undefined &&
        current.finalText !== finalText
      ) {
        throw new TypeError(
          `${label} correction budget boundary conflicts with retained finalText`,
        );
      }
      if (
        current.physicalReceipt !== undefined &&
        !isDeepStrictEqual(current.physicalReceipt, receipt)
      ) {
        throw new TypeError(
          `${label} correction budget boundary conflicts with its repository receipt`,
        );
      }
      if (
        semanticCandidate !== undefined &&
        current.semanticCandidate !== undefined &&
        !isDeepStrictEqual(current.semanticCandidate, semanticCandidate)
      ) {
        throw new TypeError(
          `${label} correction budget boundary conflicts with its retained semantic candidate`,
        );
      }
      const next: PlaybookEffectBoundary = {
        ...current,
        ...(receipt.after === undefined ? {} : { after: receipt.after }),
        physicalReceipt: receipt,
        finalText,
        ...(semanticCandidate === undefined ? {} : { semanticCandidate }),
        correctionBudget: { limit: 1, spent: true },
      };
      const acknowledged = assertPlaybookEffectLedger(
        await effectLedgerCapability.writeAhead([
          {
            kind: 'replace-boundaries',
            replacements: [{ expected: current, next }],
          },
        ]),
        `${label} semantic correction budget acknowledgement`,
      );
      effectLedgerMirror = acknowledged;
      refreshRetainedEffectReconciliation(acknowledged);
      syncDeferredReconciliationOverlay();
      refreshUnresolvedSemanticReconciliation(acknowledged);
      const spent = acknowledged.boundaries.find(
        ({ boundaryId }) => boundaryId === completedBoundary.boundaryId,
      );
      if (
        spent === undefined ||
        !isDeepStrictEqual(spent, next)
      ) {
        throw new TypeError(
          `${label} semantic correction budget spend was not acknowledged exactly`,
        );
      }
      return spent;
    }

    async function reconcileGovernedCompletion(
      input: PlaybookPlayerInput,
      roleId: string,
      playerId: string | undefined,
      finalText: string,
      signal: AbortSignal,
      operationId: string | undefined,
      completion: XStateRepositoryExclusiveCompletion<unknown>,
    ): Promise<XStateRepositoryCompletionEvidence> {
      const outcomes = outcomeAuthority?.governedPlayerStates[input.stateId];
      if (outcomes === undefined) {
        throw new TypeError(
          `${label} governed semantic reconciliation has no authority for ${input.stateId}`,
        );
      }
      if (
        completion.boundary.sourceStateId !== input.stateId ||
        !isDeepStrictEqual(completion.boundary.sourceOutcomeSchema, input.result)
      ) {
        throw new TypeError(
          `${label} governed semantic reconciliation source schema changed`,
        );
      }

      let raw: string;
      try {
        raw = await boundary.callJudge(
          'player-output-adjudication',
          input.stateId,
          buildGovernedJudgePrompt(input, finalText, outcomes),
          signal,
        );
      } catch (error) {
        governedSettlementsByBoundaryId.set(
          completion.boundary.boundaryId,
          unresolvedGovernedSettlement('judge transport failed', error, signal),
        );
        return { finalText, unresolved: true };
      }

      let candidate: unknown;
      let retainedSemanticCandidate: JsonValue | undefined;
      const retainSemanticCandidate = (value: unknown): void => {
        try {
          retainedSemanticCandidate = snapshotJsonValue(
            value,
            `${label} recoverable governed semantic candidate`,
          );
        } catch {
          // A malformed or non-detachable reply supplies no durable
          // candidate; presentation and receipt evidence still survive.
        }
      };
      const unresolvedEvidence = (): XStateRepositoryCompletionEvidence => ({
        finalText,
        ...(retainedSemanticCandidate === undefined
          ? {}
          : { semanticCandidate: retainedSemanticCandidate }),
        unresolved: true,
      });
      let reconciliation:
        | ReturnType<typeof reconcilePlaybookSemanticEvidence>
        | undefined;
      let structuralError: PlaybookSemanticCandidateStructureError | undefined;
      try {
        candidate = parseGovernedSemanticCandidate(raw);
        retainSemanticCandidate(candidate);
        reconciliation = reconcilePlaybookSemanticEvidence({
          outcomes,
          semanticCandidate: candidate,
          finalText,
          receipt: completion.outcomeReceipt,
        });
      } catch (error) {
        if (!(error instanceof PlaybookSemanticCandidateStructureError)) {
          throw error;
        }
        structuralError = error;
      }

      if (structuralError !== undefined) {
        let spent: PlaybookEffectBoundary | undefined;
        try {
          spent = await spendSemanticCorrectionBudget(
            completion.boundary,
            completion.receipt,
            finalText,
            retainedSemanticCandidate,
          );
        } catch (error) {
          // A failed or indeterminate spend cannot authorize another judge.
          // Let the repository coordinator quarantine its still-owned claim;
          // an acknowledged write remains durable and one-way on recovery.
          throw error;
        }
        if (spent === undefined) {
          governedSettlementsByBoundaryId.set(
            completion.boundary.boundaryId,
            unresolvedGovernedSettlement('semantic correction budget is unavailable'),
          );
          return unresolvedEvidence();
        }
        if (signal.aborted) {
          governedSettlementsByBoundaryId.set(
            completion.boundary.boundaryId,
            unresolvedGovernedSettlement(
              'semantic correction was aborted before its judge call',
              signal.reason,
              signal,
            ),
          );
          return unresolvedEvidence();
        }
        let correctiveRaw: string;
        try {
          correctiveRaw = await boundary.callJudge(
            'player-output-adjudication',
            input.stateId,
            buildGovernedJudgePrompt(input, finalText, outcomes, {
              reply: raw,
              error: structuralError.message,
            }),
            signal,
          );
        } catch (error) {
          governedSettlementsByBoundaryId.set(
            completion.boundary.boundaryId,
            unresolvedGovernedSettlement(
              'corrective judge failed',
              error,
              signal,
            ),
          );
          return unresolvedEvidence();
        }
        try {
          candidate = parseGovernedSemanticCandidate(correctiveRaw);
          retainSemanticCandidate(candidate);
          reconciliation = reconcilePlaybookSemanticEvidence({
            outcomes,
            semanticCandidate: candidate,
            finalText,
            receipt: completion.outcomeReceipt,
          });
        } catch (error) {
          if (!(error instanceof PlaybookSemanticCandidateStructureError)) {
            throw error;
          }
          governedSettlementsByBoundaryId.set(
            completion.boundary.boundaryId,
            unresolvedGovernedSettlement('corrective semantic candidate is invalid'),
          );
          return unresolvedEvidence();
        }
      }

      if (reconciliation === undefined) {
        throw new Error(`${label} semantic reconciliation produced no decision`);
      }
      const semanticCandidate = snapshotJsonValue(
        reconciliation.evidence.semanticCandidate,
        `${label} governed semantic candidate`,
      );
      if (reconciliation.status === 'unresolved') {
        governedSettlementsByBoundaryId.set(
          completion.boundary.boundaryId,
          unresolvedGovernedSettlement(reconciliation.reason),
        );
        return { finalText, semanticCandidate, unresolved: true };
      }

      const output = reconciliation.output as PlaybookActorOutput;
      validateBossReplyOutput(input, output, resumableStateIds);
      governedSettlementsByBoundaryId.set(completion.boundary.boundaryId, {
        status: 'resolved',
        output,
      });
      governedCompletionEvidenceByBoundaryId.set(
        completion.boundary.boundaryId,
        {
          boundaryEvidence: {},
          reconciliationStatus: reconciliation.status,
          output,
        },
      );
      if (reconciliation.status !== 'deferred') {
        return { finalText, semanticCandidate };
      }
      const pending = boundPendingQuestion(input, roleId, output);
      const bindingId = operationId ?? randomUUID();
      expectedBoundPendingQuestion = pending;
      return {
        finalText,
        semanticCandidate,
        deferred: {
          operationId: bindingId,
          pendingQuestion: {
            questionId: pending.questionId,
            asker: pending.asker,
            question: pending.question,
            sourceItem: pending.sourceItem,
          },
          playerContinuation: detachedPlayerContinuation(roleId, playerId),
        },
      };
    }

    async function deferredContinuationCompletionEvidence(
      completion: XStateRepositoryExclusiveCompletion<unknown>,
    ): Promise<XStateRepositoryCompletionEvidence> {
      const remember = (
        evidence: XStateRepositoryCompletionEvidence,
      ): XStateRepositoryCompletionEvidence => {
        rememberGovernedCompletionEvidence(
          completion.boundary.boundaryId,
          evidence,
        );
        return evidence;
      };
      const continuation = activeDeferredContinuation;
      if (continuation === undefined) {
        throw new Error(
          `${label} deferred continuation completed without active runtime context`,
        );
      }
      const result = continuation.result;
      if (
        completion.operation.status !== 'fulfilled' ||
        completion.operation.value !== null ||
        result === undefined ||
        result.status !== 'ok' ||
        isEmptyFinalText(result.finalText)
      ) {
        if (
          completion.outcomeReceipt.classification === 'unchanged' &&
          (continuation.callError !== undefined ||
            (result !== undefined && result.status !== 'ok'))
        ) {
          return remember({});
        }
        governedSettlementsByBoundaryId.set(
          completion.boundary.boundaryId,
          unresolvedGovernedSettlement(
            'deferred player result has no semantic evidence',
            continuation.callError,
          ),
        );
        return remember({
          ...(result?.status !== 'ok' || result.finalText === undefined
            ? {}
            : { finalText: result.finalText }),
          unresolved: true,
        });
      }
      const input = continuation.input;
      const roleId = continuation.roleId;
      const signal = continuation.signal;
      if (input === undefined || roleId === undefined || signal === undefined) {
        throw new Error(
          `${label} deferred continuation lost its bound player identity or signal`,
        );
      }
      return remember(
        await reconcileGovernedCompletion(
          input,
          roleId,
          continuation.playerId,
          result.finalText!,
          signal,
          continuation.operationId,
          completion,
        ),
      );
    }

    function assertAcknowledgedGovernedEvidence(
      completed: PlaybookEffectBoundary,
      settlement: GovernedPlayerSettlement | undefined,
      ledger: PlaybookEffectLedger,
    ): void {
      const expected = governedCompletionEvidenceByBoundaryId.get(
        completed.boundaryId,
      );
      if (
        expected === undefined ||
        (Object.prototype.hasOwnProperty.call(
          expected.boundaryEvidence,
          'finalText',
        )
          ? completed.finalText !== expected.boundaryEvidence.finalText
          : completed.finalText !== undefined) ||
        (Object.prototype.hasOwnProperty.call(
          expected.boundaryEvidence,
          'semanticCandidate',
        )
          ? !isDeepStrictEqual(
              completed.semanticCandidate,
              expected.boundaryEvidence.semanticCandidate,
            )
          : completed.semanticCandidate !== undefined)
      ) {
        throw new TypeError(
          `${label} repository did not acknowledge the exact governed semantic evidence`,
        );
      }
      if (settlement?.status !== 'resolved') return;
      const persisted = persistedBoundaryReconciliation(completed, ledger);
      if (
        persisted === undefined ||
        persisted.historicalDeferred ||
        persisted.reconciliation.status !== expected.reconciliationStatus ||
        !isDeepStrictEqual(
          persisted.reconciliation.output,
          expected.output,
        ) ||
        !isDeepStrictEqual(
          expected.output,
          settlement.output,
        )
      ) {
        throw new TypeError(
          `${label} repository did not acknowledge the exact governed semantic evidence`,
        );
      }
    }

    function recordActiveGovernedAttempt(
      boundary: PlaybookEffectBoundary,
    ): void {
      if (
        activeGovernedAttemptId !== undefined &&
        activeGovernedAttemptId !== boundary.attemptId
      ) {
        throw new Error(
          `${label} governed calls in one runtime boundary used different host attempt ids`,
        );
      }
      activeGovernedAttemptId = boundary.attemptId;
    }

    function refreshGovernedBoundaryStart(boundaryId: string): void {
      try {
        const current = currentEffectLedger();
        const boundary = current.boundaries.find(
          (candidate) => candidate.boundaryId === boundaryId,
        );
        if (boundary === undefined) return;
        effectLedgerMirror = current;
        refreshRetainedEffectReconciliation(current);
        recordActiveGovernedAttempt(boundary);
      } catch {
        // Preserve the repository failure. A mirror that cannot be read or
        // validated supplies no evidence authorizing replay.
      }
    }

    function acknowledgeGovernedPlayerResult(
      value: unknown,
      boundaryId: string,
      source: 'runExclusive' | 'runDeferred' = 'runExclusive',
    ): PlayerResult {
      if (!isPlainObject(value) || !isPlainObject(value.operation)) {
        throw new TypeError(
          `${label} repository ${source} returned an invalid settlement`,
        );
      }
      const ledger = assertPlaybookEffectLedger(
        value.effectLedger,
        `${label} repository ${source} effect ledger`,
      );
      const completed = ledger.boundaries.find(
        (candidate) => candidate.boundaryId === boundaryId,
      );
      if (
        completed === undefined ||
        completed.physicalReceipt === undefined ||
        !isDeepStrictEqual(completed.physicalReceipt, value.receipt)
      ) {
        throw new TypeError(
          `${label} repository ${source} did not acknowledge its completed boundary`,
        );
      }
      effectLedgerMirror = ledger;
      refreshRetainedEffectReconciliation(ledger);
      syncDeferredReconciliationOverlay();
      refreshUnresolvedSemanticReconciliation(ledger);
      recordActiveGovernedAttempt(completed);
      if (value.operation.status === 'rejected') {
        if (!Object.prototype.hasOwnProperty.call(value.operation, 'reason')) {
          throw new TypeError(
            `${label} repository ${source} rejection omitted its reason`,
          );
        }
        throw value.operation.reason;
      }
      if (
        value.operation.status !== 'fulfilled' ||
        !Object.prototype.hasOwnProperty.call(value.operation, 'value')
      ) {
        throw new TypeError(
          `${label} repository ${source} returned an invalid operation settlement`,
        );
      }
      const result = validatePlayerResult(value.operation.value);
      playerBoundaryReceipts.set(result, {
        boundaryId: completed.boundaryId,
        attemptId: completed.attemptId,
      });
      let governedSettlement = governedSettlementsByBoundaryId.get(boundaryId);
      if (
        governedSettlement === undefined &&
        result.status === 'ok' &&
        !isEmptyFinalText(result.finalText)
      ) {
        governedSettlement = unresolvedGovernedSettlement(
          'host omitted governed semantic settlement',
        );
      }
      assertAcknowledgedGovernedEvidence(
        completed,
        governedSettlement,
        ledger,
      );
      governedCompletionEvidenceByBoundaryId.delete(boundaryId);
      let governedOutput =
        governedSettlement?.status === 'resolved'
          ? governedSettlement.output
          : undefined;
      const governedDisposition =
        governedOutput === undefined
          ? undefined
          : governedOutcomesForBoundary(completed)?.[governedOutput.guard]
              ?.repositoryDisposition;
      if (source === 'runExclusive' && governedDisposition === 'deferred') {
        if (
          value.deferredStatus !== 'bound' &&
          value.deferredStatus !== 'unresolved'
        ) {
          throw new TypeError(
            `${label} deferred settlement omitted its durable binding status`,
          );
        }
        const operationId = completed.logicalOperationId;
        if (operationId === undefined) {
          throw new TypeError(
            `${label} deferred settlement omitted its logical operation`,
          );
        }
        if (value.deferredStatus === 'bound') {
          if (
            expectedBoundPendingQuestion === undefined ||
            currentBoundDeferredOperation(expectedBoundPendingQuestion)
              ?.operationId !== operationId
          ) {
            throw new TypeError(
              `${label} deferred settlement did not acknowledge its exact bound question`,
            );
          }
        } else {
          if (deferredReconciliationOperationId !== operationId) {
            throw new TypeError(
              `${label} unresolved deferred settlement is not structurally unresolved`,
            );
          }
          expectedBoundPendingQuestion = undefined;
          governedSettlement = unresolvedGovernedSettlement(
            'deferred question did not receive an eligible durable binding',
          );
          governedOutput = undefined;
        }
      } else if (source === 'runExclusive' && value.deferredStatus !== undefined) {
        throw new TypeError(
          `${label} non-deferred settlement returned a deferred binding status`,
        );
      }
      if (governedSettlement !== undefined) {
        governedSettlementsByBoundaryId.delete(boundaryId);
        governedPlayerSettlements.set(result, governedSettlement);
        if (governedSettlement.status === 'unresolved') {
          unresolvedSemanticBoundaryIds.add(boundaryId);
        } else {
          unresolvedSemanticBoundaryIds.delete(boundaryId);
        }
      }
      return result;
    }

    function acknowledgedBoundaryIsUnchanged(result: PlayerResult): boolean {
      if (outcomeAuthority === undefined) return true;
      const identity = playerBoundaryReceipts.get(result);
      if (identity === undefined) return false;
      const boundary = effectLedgerMirror.boundaries.find(
        (candidate) => candidate.boundaryId === identity.boundaryId,
      );
      return (
        boundary?.attemptId === identity.attemptId &&
        boundary.physicalReceipt?.classification === 'unchanged'
      );
    }

    function failedAttemptMatchesCurrentLedger(
      current: PlaybookEffectLedger,
    ): boolean {
      const boundaryPrefix = failedEffectBoundaryPrefix;
      if (
        failedGovernedAttemptUnknown ||
        boundaryPrefix === undefined
      ) {
        return false;
      }
      const causalBoundaries = current.boundaries.filter(
        ({ sequence }) => sequence > boundaryPrefix,
      );
      const matches =
        failedGovernedAttemptId === undefined
          ? causalBoundaries.length === 0
          : causalBoundaries.length > 0 &&
            causalBoundaries.every(
              ({ attemptId }) => attemptId === failedGovernedAttemptId,
            );
      if (!matches) failedGovernedAttemptUnknown = true;
      return matches;
    }

    function failedAttemptAllowsReplay(): boolean {
      if (!hasGovernedPlayerStates) return true;
      if (unresolvedSemanticBoundaryIds.size > 0) return false;
      let current: PlaybookEffectLedger;
      try {
        current = currentEffectLedger();
        effectLedgerMirror = current;
        refreshRetainedEffectReconciliation(current);
        refreshUnresolvedSemanticReconciliation(current);
      } catch {
        failedGovernedAttemptUnknown = true;
        return false;
      }
      if (unresolvedSemanticBoundaryIds.size > 0) return false;
      if (!failedAttemptMatchesCurrentLedger(current)) return false;
      if (failedGovernedAttemptId === undefined) return true;
      const boundaries = current.boundaries.filter(
        ({ attemptId }) => attemptId === failedGovernedAttemptId,
      );
      return (
        boundaries.length > 0 &&
        boundaries.every(
          ({ physicalReceipt }) =>
            physicalReceipt?.classification === 'unchanged',
        )
      );
    }

    function captureEffectLedgerPrefixSequence(): number | undefined {
      if (!hasGovernedPlayerStates) return undefined;
      try {
        const current = currentEffectLedger();
        effectLedgerMirror = current;
        refreshRetainedEffectReconciliation(current);
        return current.boundaries.at(-1)?.sequence ?? 0;
      } catch {
        return undefined;
      }
    }

    function bindAutomaticReplayBoundary(
      prefixSequence: number | undefined,
    ): void {
      activeGovernedBoundarySeen = false;
      activeGovernedAttemptId = undefined;
      activeEffectLedgerPrefixSequence = prefixSequence;
    }

    function beginAutomaticReplayBoundary(): void {
      bindAutomaticReplayBoundary(captureEffectLedgerPrefixSequence());
    }

    function latchFailedGovernedAttempt(): void {
      if (!hasGovernedPlayerStates) {
        failedGovernedAttemptUnknown = false;
        failedEffectBoundaryPrefix = undefined;
        failedGovernedAttemptId = undefined;
        return;
      }
      if (activeEffectLedgerPrefixSequence === undefined) {
        failedGovernedAttemptUnknown = true;
        failedEffectBoundaryPrefix = undefined;
        failedGovernedAttemptId = undefined;
        return;
      }
      let current: PlaybookEffectLedger;
      try {
        current = currentEffectLedger();
        effectLedgerMirror = current;
        refreshRetainedEffectReconciliation(current);
      } catch {
        failedGovernedAttemptUnknown = true;
        failedEffectBoundaryPrefix = undefined;
        failedGovernedAttemptId = undefined;
        return;
      }
      const attemptIds = new Set(
        current.boundaries
          .filter(
            ({ sequence }) => sequence > activeEffectLedgerPrefixSequence!,
          )
          .map(({ attemptId }) => attemptId),
      );
      if (activeGovernedAttemptId !== undefined) {
        attemptIds.add(activeGovernedAttemptId);
      }
      if (attemptIds.size > 1) {
        failedGovernedAttemptUnknown = true;
        failedEffectBoundaryPrefix = undefined;
        failedGovernedAttemptId = undefined;
        return;
      }
      failedGovernedAttemptUnknown =
        attemptIds.size === 0 && activeGovernedBoundarySeen;
      failedEffectBoundaryPrefix = failedGovernedAttemptUnknown
        ? undefined
        : activeEffectLedgerPrefixSequence;
      failedGovernedAttemptId = attemptIds.values().next().value;
    }

    const boundary: RuntimeBoundaryCalls = {
      async callPlayer(
        input,
        roleId,
        prompt,
        signal,
      ): Promise<PlayerResult> {
        // State-entry telemetry/status must precede the call they describe.
        await drainEmissions();
        signal.throwIfAborted();
        const deferredContinuation = activeDeferredContinuation;
        const reconstructed = takeReconstructedGovernedPlayerResult(
          input,
          roleId,
        );
        if (reconstructed !== undefined) return reconstructed;
        if (
          deferredContinuation === undefined &&
          hasUnresolvedReconciliation()
        ) {
          throw markFsmResultFailure(
            new Error(
              `${label} governed semantic reconciliation remains unresolved`,
            ),
          );
        }
        const turnId = activeTurnId;
        const stateId = input.stateId;
        const playerId = resolvedPlayerId(roleId);
        let selectedResume: string | false;
        try {
          signal.throwIfAborted();
          selectedResume =
            deferredContinuation?.playerContinuation ??
            selectPlayerResume(roleId, playerId);
        } catch (error) {
          if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
          throw error;
        }
        const callId =
          deferredContinuation?.effectBoundary.callId ??
          `player-${++playerCallSequence}`;
        const callIdentity = (resume: string | false) => ({
            ...stateIdentity(stateId),
            sourceItem: input.sourceItem,
            roleId,
            ...(playerId === undefined ? {} : { playerId }),
            resume,
          });
        const position: TracePosition = {
          ...(turnId !== undefined ? { turnId } : {}),
          callId,
        };

        const playerKey = continuationKey(roleId, playerId);
        if (activePlayerKeys.has(playerKey)) {
          const error = new Error(
            `simultaneous calls to player key ${playerKey} are not allowed`,
          );
          await emitCallStarted(
            'player.call.started',
            'player.call.finished',
            { ...callIdentity(selectedResume), prompt },
            position,
            signal,
          );
          await emitTrace(
            'player.call.finished',
            {
              ...callIdentity(selectedResume),
              status: 'error',
              error: normalizeError(error),
            },
            position,
          );
          throw error;
        }
        activePlayerKeys.add(playerKey);

        try {
          const runTracedPlayerCall = async (
            resume: string | false = selectedResume,
          ): Promise<PlayerResult> => {
            const identity = callIdentity(resume);
            await emitCallStarted(
              'player.call.started',
              'player.call.finished',
              { ...identity, prompt },
              position,
              signal,
            );

            let rawResult: unknown;
            try {
              // An abort may land while the awaited started emission drains
              // (e.g. fired from the trace sink itself); the host call must
              // never start after abort, so settle the already-started pair
              // as `aborted` through the catch below.
              signal.throwIfAborted();
              rawResult = await requireHostPorts().callPlayer(
                roleId,
                prompt,
                signal,
                { resume },
              );
              // A host promise is not required to honor cancellation. Do not
              // let a late result mutate continuity or publish a successful
              // finish.
              signal.throwIfAborted();
            } catch (error) {
              if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
              try {
                await emitTrace(
                  'player.call.finished',
                  {
                    ...identity,
                    status: isAbortFailure(error, signal) ? 'aborted' : 'error',
                    error: normalizeError(error),
                  },
                  position,
                );
              } catch {
                // The original non-abort port rejection remains authoritative.
              }
              // A thrown port call carries no authoritative result, so the
              // prior token remains available for a later explicit resume.
              throw error;
            }

            let result: PlayerResult;
            try {
              result = validatePlayerResult(rawResult);
            } catch (error) {
              if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
              try {
                await emitTrace(
                  'player.call.finished',
                  { ...identity, status: 'error', error: normalizeError(error) },
                  position,
                );
              } catch {
                // The malformed host result remains authoritative.
              }
              throw error;
            }

            try {
              updatePlayerResume(roleId, playerId, result);
            } catch (error) {
              if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
              try {
                await emitTrace(
                  'player.call.finished',
                  { ...identity, status: 'error', error: normalizeError(error) },
                  position,
                );
              } catch {
                // The continuation-store failure remains authoritative.
              }
              throw error;
            }

            await emitTrace(
              'player.call.finished',
              {
                ...identity,
                status: result.status,
                ...(result.finalText !== undefined
                  ? { finalText: result.finalText }
                  : {}),
                ...(result.error !== undefined
                  ? { error: normalizeError(result.error) }
                  : {}),
                ...(result.resumeToken !== undefined
                  ? { resumeToken: result.resumeToken }
                  : {}),
              },
              position,
            );
            return result;
          };

          const effectBoundary = governedBoundarySeed(
            input,
            roleId,
            callId,
            turnId,
          );
          if (deferredContinuation !== undefined) {
            if (
              effectBoundary === undefined ||
              effectBoundary.runtimeSessionId !==
                deferredContinuation.effectBoundary.runtimeSessionId ||
              effectBoundary.turnId !== deferredContinuation.effectBoundary.turnId ||
              effectBoundary.callId !== deferredContinuation.effectBoundary.callId ||
              effectBoundary.roleId !== deferredContinuation.effectBoundary.roleId ||
              effectBoundary.sourceStateId !==
                deferredContinuation.effectBoundary.sourceStateId ||
              !isDeepStrictEqual(
                effectBoundary.sourceOutcomeSchema,
                deferredContinuation.effectBoundary.sourceOutcomeSchema,
              ) ||
              !isDeepStrictEqual(
                effectBoundary.dispositions,
                deferredContinuation.effectBoundary.dispositions,
              )
            ) {
              throw new TypeError(
                `${label} deferred continuation did not invoke its bound player boundary`,
              );
            }
            activeGovernedBoundarySeen = true;
            deferredContinuation.input = input;
            deferredContinuation.roleId = roleId;
            deferredContinuation.playerId = playerId;
            deferredContinuation.signal = signal;
            try {
              deferredContinuation.result = await runTracedPlayerCall(
                selectedResume,
              );
            } catch (error) {
              deferredContinuation.callError = error;
            } finally {
              deferredContinuation.rawPlayerSettled.resolve();
            }
            return await deferredContinuation.delivery.promise;
          }
          // Await inside this try so its finally retains the player-key
          // exclusion until the host operation actually settles.
          if (effectBoundary === undefined) return await runTracedPlayerCall();
          if (repositoryCapability === undefined) {
            throw new Error(
              `${label} governed player call requires repository.runExclusive`,
            );
          }
          activeGovernedBoundarySeen = true;
          try {
            const exclusive = await repositoryCapability.runExclusive({
              signal,
              effectBoundary,
              operation: () => runTracedPlayerCall(),
              completeEffectBoundary: completionEvidenceFor(
                input,
                roleId,
                playerId,
                signal,
                undefined,
              ),
            });
            return acknowledgeGovernedPlayerResult(
              exclusive,
              effectBoundary.boundaryId,
            );
          } catch (error) {
            if (expectedBoundPendingQuestion !== undefined) {
              closeAfterIndeterminateDeferredSettlement(undefined, error);
            }
            expectedBoundPendingQuestion = undefined;
            governedSettlementsByBoundaryId.delete(effectBoundary.boundaryId);
            governedCompletionEvidenceByBoundaryId.delete(
              effectBoundary.boundaryId,
            );
            refreshGovernedBoundaryStart(effectBoundary.boundaryId);
            if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
            throw error;
          }
        } finally {
          activePlayerKeys.delete(playerKey);
        }
      },

      takeGovernedPlayerOutput(result): GovernedPlayerSettlement | undefined {
        const settlement = governedPlayerSettlements.get(result);
        if (settlement !== undefined) governedPlayerSettlements.delete(result);
        return settlement;
      },

      recordGovernedPlayerOutput(
        result,
        output,
      ): void {
        const reconstructed = reconstructedGovernedResults.get(result);
        if (reconstructed === undefined) return;
        reconstructedGovernedResults.delete(result);
        const persisted = persistedBoundaryReconciliation(
          reconstructed,
          effectLedgerMirror,
        );
        if (
          persisted === undefined ||
          persisted.reconciliation.status !== 'resolved' ||
          !isDeepStrictEqual(persisted.reconciliation.output, output)
        ) {
          unresolvedSemanticBoundaryIds.add(reconstructed.boundaryId);
          throw markFsmResultFailure(
            new Error(
              `${label} reconstructed governed output changed before FSM acceptance`,
            ),
          );
        }
        reconstructedAcceptancePending = reconstructed;
      },

      async callJudge(purpose, stateId, prompt, signal): Promise<string> {
        return judgeQueue.add(async () => {
          const governedSemanticJudge =
            artifactSchema === 3 &&
            purpose === 'player-output-adjudication' &&
            stateId !== undefined &&
            outcomeAuthority?.governedPlayerStates[stateId] !== undefined;
          signal.throwIfAborted();
          // A transition/status queued synchronously by XState must reach
          // the host before the judge call that follows it.
          await drainEmissions();
          signal.throwIfAborted();
          const turnId = activeTurnId;
          const callId = `judge-${++judgeCallSequence}`;
          const identity = { purpose, ...stateIdentity(stateId) };
          const position: TracePosition = {
            ...(turnId !== undefined ? { turnId } : {}),
            callId,
          };

          await emitCallStarted(
            'judge.call.started',
            'judge.call.finished',
            { ...identity, prompt },
            position,
            signal,
          );
          let reply: unknown;
          try {
            // An abort may land while the awaited started emission drains
            // (e.g. fired from the trace sink itself); the host call must
            // never start after abort, so settle the already-started pair
            // as `aborted` through the catch below.
            signal.throwIfAborted();
            reply = await requireHostPorts().callJudge(prompt, signal);
            signal.throwIfAborted();
          } catch (error) {
            if (!isAbortFailure(error, signal) && !governedSemanticJudge) {
              controlPlaneError ??= error;
            }
            await emitTrace(
              'judge.call.finished',
              {
                ...identity,
                status: isAbortFailure(error, signal) ? 'aborted' : 'error',
                error: normalizeError(error),
              },
              position,
            );
            throw error;
          }
          if (typeof reply !== 'string') {
            const error = new TypeError('judge reply must be a string');
            if (!governedSemanticJudge) controlPlaneError ??= error;
            await emitTrace(
              'judge.call.finished',
              { ...identity, status: 'error', error: normalizeError(error) },
              position,
            );
            throw error;
          }
          // Keep the success finish outside the port-call catch. If a
          // telemetry sink records this boundary and then rejects, that sink
          // failure must not synthesize a second, contradictory finish.
          await emitTrace(
            'judge.call.finished',
            { ...identity, status: 'ok', reply },
            position,
          );
          // The finish sink is part of the classifier boundary. A signal may
          // abort while that ordered emission drains; never let the already
          // classified event mutate the machine afterward.
          signal.throwIfAborted();
          return reply;
        }) as Promise<string>;
      },

      async callCaptain(input, prompt, signal, callOptions): Promise<CaptainResult> {
        return judgeQueue.add(async () => {
          signal.throwIfAborted();
          await drainEmissions();
          signal.throwIfAborted();
          const turnId = activeTurnId;
          const callId = `captain-${++captainCallSequence}`;
          const visibility = callOptions?.visibility ?? 'visible';
          const identity = {
            ...stateIdentity(input.stateId),
            sourceItem: input.sourceItem,
            visibility,
            // The visible workflow form owns its `resume: false` selection;
            // a hidden controller call's durable-conversation resume
            // selection is host-owned (DR-029), so its trace pair carries
            // no resume member and no token.
            ...(visibility === 'visible' ? { resume: false as const } : {}),
            ...(input.allowedTools === undefined
              ? {}
              : { allowedTools: [...input.allowedTools] }),
          };
          const position: TracePosition = {
            ...(turnId !== undefined ? { turnId } : {}),
            callId,
          };

          await emitCallStarted(
            'captain.call.started',
            'captain.call.finished',
            { ...identity, prompt },
            position,
            signal,
          );
          let rawResult: unknown;
          try {
            // An abort may land while the awaited started emission drains
            // (e.g. fired from the trace sink itself); the host call must
            // never start after abort, so settle the already-started pair
            // as `aborted` through the catch below.
            signal.throwIfAborted();
            rawResult = await requireHostPorts().callCaptain(prompt, signal, {
              visibility,
              resume: false,
              ...(input.allowedTools !== undefined
                ? { allowedTools: input.allowedTools }
                : {}),
            });
            signal.throwIfAborted();
          } catch (error) {
            if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
            await emitTrace(
              'captain.call.finished',
              {
                ...identity,
                status: isAbortFailure(error, signal) ? 'aborted' : 'error',
                error: normalizeError(error),
              },
              position,
            );
            throw error;
          }
          let result: CaptainResult;
          try {
            result = validateCaptainResult(rawResult);
          } catch (error) {
            controlPlaneError ??= error;
            await emitTrace(
              'captain.call.finished',
              { ...identity, status: 'error', error: normalizeError(error) },
              position,
            );
            throw error;
          }
          // A non-`ok` host result is a recoverable FSM failure (PBRT-47), so
          // it is never latched as a control-plane error; it is still
          // authoritative for the actor's error path even when the required
          // finish emission fails or a coincident boundary abort lands.
          let resultFailure: Error | undefined;
          let emptyOkRetry = false;
          if (result.status !== 'ok') {
            resultFailure = markFsmResultFailure(
              new Error(
                result.error ??
                  `captainActor: callCaptain status "${result.status}"`,
              ),
            );
          } else if (isEmptyFinalText(result.finalText)) {
            resultFailure = markFsmResultFailure(
              new Error(
                'captainActor: callCaptain returned status=ok with no finalText',
              ),
            );
            emptyOkRetry = true;
          }
          try {
            await emitTrace(
              'captain.call.finished',
              {
                ...identity,
                status: result.status,
                ...(result.finalText !== undefined
                  ? { finalText: result.finalText }
                  : {}),
                ...(result.error !== undefined
                  ? { error: normalizeError(result.error) }
                  : resultFailure !== undefined
                    ? { error: normalizeError(resultFailure) }
                    : {}),
              },
              position,
            );
          } catch (error) {
            // Keep the finish-sink failure in the emission queue for public
            // cleanup evidence, but do not replace an authoritative result
            // failure on the invoked actor's XState onError path. A failure
            // thrown here is never marked re-askable: a rejecting finish
            // sink stays a control-plane error with no corrective re-ask
            // (PBRT-47).
            if (resultFailure !== undefined) throw resultFailure;
            throw error;
          }
          if (resultFailure !== undefined) {
            throw emptyOkRetry
              ? markEmptyOkRetryFailure(resultFailure)
              : resultFailure;
          }
          return result;
        }) as Promise<CaptainResult>;
      },
    };

    function playerActor(
      ports: PlaybookPorts,
    ): PromiseActorLogic<PlaybookActorOutput, PlaybookPlayerInput> {
      return createPlayerBridge(
        {
          resolveRoleId: requireRoleId,
          validateInput: (input) =>
            assertGovernedPlayerInput(
              outcomeAuthority,
              input,
              extractFields,
              label,
            ),
          composePlayerPrompt: composeBoundPlayerPrompt,
          adjudication,
          resumableStateIds,
          allowsCorrectiveReplay: acknowledgedBoundaryIsUnchanged,
        },
        ports,
        () => activeSignal,
        boundary,
        (error) => {
          if (activeSignal === undefined || !isAbortFailure(error, activeSignal)) {
            controlPlaneError ??= error;
          }
        },
      );
    }

    // Direct-Captain actor (slc/link.md §Captain prompt composition,
    // §Captain adjudication): one visible callCaptain, then hidden judge
    // adjudication that injects the exact visible finalText as the selected
    // output's question/response.
    function captainActor(): PromiseActorLogic<
      PlaybookActorOutput,
      PlaybookCaptainInput
    > {
      return fromPromise<PlaybookActorOutput, PlaybookCaptainInput>(
        async ({ input, signal }) => {
          const active = combineAbortSignals(signal, activeSignal);
          try {
            await drainEmissions();
            const prompt = composeCaptainPrompt(input);
            if (spec.captainStrategy !== undefined) {
              // Controller form (slc/link.md §Captain adjudication): the
              // spec's strategy owns the call pipeline; the engine still
              // owns tracing, the shared lane, signal combination, and the
              // control-plane latch in the catch below.
              const output = await spec.captainStrategy({
                input,
                prompt,
                signal: active,
                options: boundOptions,
                session: requireSession(),
                callCaptain: (callPrompt, callOptions) =>
                  boundary.callCaptain!(input, callPrompt, active, callOptions),
                isEmptyOkRetry: isEmptyOkRetryFailure,
                recoverableFailure: <E extends Error>(error: E): E => {
                  markFsmResultFailure(error);
                  return error;
                },
              });
              validateBossReplyOutput(input, output, resumableStateIds);
              return output;
            }
            let result: CaptainResult;
            try {
              result = await boundary.callCaptain!(input, prompt, active);
            } catch (error) {
              if (!isEmptyOkRetryFailure(error)) throw error;
              // DR-028: exactly one corrective re-ask of the same composed
              // call through the same boundary, traced as its own
              // started/finished pair, its result read under the unchanged
              // rules — a second empty `ok` result throws from the boundary
              // exactly as the first did, with no further re-ask.
              result = await boundary.callCaptain!(input, prompt, active);
            }
            // The boundary owns result validation (PBRT-47) and throws the
            // authoritative failure itself, so a returned result is always
            // `ok` with visible text. Assert that invariant rather than
            // restating the failure semantics, which would drift.
            const finalText = result.finalText ?? '';
            if (result.status !== 'ok' || isEmptyFinalText(finalText)) {
              throw new Error(
                'captainActor: boundary returned an unvalidated Captain result',
              );
            }
            const judgePrompt = defaultBuildCaptainJudgePrompt(
              input,
              finalText,
            );
            const raw = await boundary.callJudge(
              'captain-output-adjudication',
              input.stateId,
              judgePrompt,
              active,
            );
            const output = adjudicateCaptainOutput(
              extractFields,
              input,
              finalText,
              raw,
            );
            validateBossReplyOutput(input, output, resumableStateIds);
            return output;
          } catch (error) {
            // A host-reported Captain result failure routes to the FSM's
            // failure state (PBRT-47); everything else here — a drained
            // emission failure, prompt composition, the port itself,
            // adjudication — is control plane.
            if (!isAbortFailure(error, active) && !isFsmResultFailure(error)) {
              controlPlaneError ??= error;
            }
            throw error;
          }
        },
      );
    }

    // Deterministic script actor (slc/link.md §Script execution). Runs
    // `input.command` through `sh -c`, resolves the declared guard
    // mechanically from the exit status, and emits one status + one
    // `playbook.script` telemetry event. No agent call, no adjudication,
    // no `*.call.*` trace.
    function scriptActor(): PromiseActorLogic<
      PlaybookActorOutput,
      PlaybookScriptInput
    > {
      return fromPromise<PlaybookActorOutput, PlaybookScriptInput>(
        async ({ input, signal }) => {
          await drainEmissions();
          const active = combineAbortSignals(signal, activeSignal);
          const guards = Object.keys(input.result);
          const okGuard = guards[0];
          const failedGuard = guards[1] ?? guards[0];
          const cwd = boundScriptCwd ?? process.cwd();
          const ports = runtimePorts ?? requireHostPorts();
          // slc/link.md §Script execution: an already-aborted turn spawns
          // nothing, and the thrown signal reason keeps the rejection
          // causally classified as the abort it is.
          active.throwIfAborted();

          // Abort ownership — the listener that terminates the group and
          // the escalation timer — spans the whole invocation body, not
          // just the spawn-to-close window: an abort landing during the
          // post-exit emission tail must still kill surviving group
          // members before the actor settles (slc/link.md §Script
          // execution). One finally releases both.
          let child: ReturnType<typeof spawn> | undefined;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const signalGroup = (sig: NodeJS.Signals): void => {
            if (child?.pid !== undefined) {
              try {
                process.kill(-child.pid, sig);
              } catch {
                // Confirmation belongs to the bounded liveness probe below:
                // a failed signal can mean ESRCH, EPERM, or another fault.
              }
            }
          };
          // After a SIGKILL is posted, settlement waits for the group to
          // stop being signalable — bounded by the same grace so an
          // unreapable member outside the runtime's control cannot stall
          // the turn forever. Observed teardown is milliseconds.
          let groupGonePromise: Promise<void> | undefined;
          const awaitGroupGone = (): Promise<void> => {
            const pid = child?.pid;
            if (pid === undefined) return Promise.resolve();
            groupGonePromise ??= (async () => {
              const teardownFailure = (
                message: string,
                cause?: unknown,
              ): ScriptProcessGroupTeardownError => {
                const failure = new ScriptProcessGroupTeardownError(
                  pid,
                  message,
                  cause,
                );
                // A teardown failure is not an authored script result.
                // Surface it at the active public boundary even though
                // XState also routes the rejected actor through onError.
                controlPlaneError ??= failure;
                return failure;
              };
              const deadline = Date.now() + SCRIPT_ABORT_KILL_GRACE_MS;
              let lastProbeError: unknown;
              for (;;) {
                try {
                  process.kill(-pid, 0);
                } catch (error) {
                  if (isNoSuchProcess(error)) return;
                  // EPERM confirms that at least one process in the group
                  // still exists but is not signalable by this process. Keep
                  // waiting for ESRCH within the bound; every other probe
                  // error makes confirmation itself unreliable immediately.
                  if (!isProcessPermissionDenied(error)) {
                    throw teardownFailure(
                      'the liveness probe failed',
                      error,
                    );
                  }
                  lastProbeError = error;
                }
                if (Date.now() >= deadline) {
                  throw teardownFailure(
                    `the group remained signalable after ${SCRIPT_ABORT_KILL_GRACE_MS}ms`,
                    lastProbeError,
                  );
                }
                await new Promise((tick) => setTimeout(tick, 5));
              }
            })();
            return groupGonePromise;
          };
          const onAbort = (): void => {
            signalGroup('SIGTERM');
            killTimer = setTimeout(
              () => signalGroup('SIGKILL'),
              SCRIPT_ABORT_KILL_GRACE_MS,
            );
          };
          // An abort observed once the shell has already exited rejects
          // with the signal's reason before guard resolution and before
          // starting any further script emission — after killing whatever
          // group members outlived the shell. The shell's own exit ended
          // the TERM grace's purpose, so escalation is immediate here.
          const settleIfAborted = async (): Promise<void> => {
            if (!active.aborted) return;
            signalGroup('SIGKILL');
            await awaitGroupGone();
            active.throwIfAborted();
          };
          let invocationFailed = false;
          try {
            const exitStatus = await new Promise<number>(
              (resolve, reject) => {
                try {
                  // detached: the shell leads its own POSIX process group,
                  // so an abort can terminate the command's whole group — a
                  // lone SIGTERM to the wrapper never reaches backgrounded
                  // members.
                  child = spawn('sh', ['-c', input.command], {
                    cwd,
                    stdio: 'ignore',
                    detached: true,
                  });
                } catch (error) {
                  reject(error);
                  return;
                }
                // On abort, terminate the group and escalate — but settle
                // only from 'close', after the shell itself has exited, so
                // the turn never reports quiescence while the script still
                // runs (slc/link.md §Abort). SIGKILL is untrappable, so
                // 'close' is bounded by the grace.
                active.addEventListener('abort', onAbort, { once: true });
                child.on('error', (error) => {
                  reject(error);
                });
                child.on('close', (code) => {
                  if (active.aborted) {
                    // The shell may exit cooperatively on the group SIGTERM
                    // while a TERM-immune same-group descendant survives;
                    // the group stays addressable while any member lives,
                    // so kill it and await its disappearance before
                    // settling (slc/link.md §Script execution).
                    signalGroup('SIGKILL');
                    void awaitGroupGone().then(
                      () =>
                        reject(active.reason),
                      reject,
                    );
                    return;
                  }
                  resolve(typeof code === 'number' ? code : 1);
                });
              },
            );

            await settleIfAborted();

            await ports.emitStatus(
              `Executed script for ${input.stateId} (exit ${exitStatus}).`,
            );
            await settleIfAborted();
            await ports.emitTelemetry({
              topic: 'playbook.script',
              payload: {
                stateId: input.stateId,
                sourceItem: input.sourceItem,
                exitStatus,
              },
            });
            await settleIfAborted();

            if (exitStatus === 0) {
              return { guard: okGuard, exitStatus: 0 };
            }
            return { guard: failedGuard, exitStatus };
          } catch (error) {
            // Preserve the invocation's authoritative exact cancellation or
            // distinct sink failure after teardown succeeds. The finally
            // block may replace it only with a distinct teardown failure
            // when the process group cannot be confirmed gone.
            invocationFailed = true;
            throw error;
          } finally {
            try {
              if (active.aborted) {
                signalGroup('SIGKILL');
                await awaitGroupGone();
                if (!invocationFailed) active.throwIfAborted();
              }
            } finally {
              active.removeEventListener('abort', onAbort);
              if (killTimer !== undefined) clearTimeout(killTimer);
            }
          }
        },
      );
    }

    const nestedBridge = createNestedPlaybookBridge({
      nextCallId: () => `playbook-${++playbookCallSequence}`,
      getBoundarySignal: () => activeSignal,
      callPlaybook: (request, signal) =>
        requireHostPorts().callPlaybook(request, signal),
      emitStarted: async (event, aborts) => {
        playbookCallTurnIds.set(event.callId, activeTurnId);
        if (hasGovernedPlayerStates) {
          playbookCallEffectPrefixes.set(
            event.callId,
            activeEffectLedgerPrefixSequence,
          );
        }
        await emitTrace(
          'playbook.call.started',
          {
            stateId: event.stateId,
            playbookId: event.playbookId,
            text: event.text,
          },
          {
            ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
            callId: event.callId,
          },
          aborts,
        );
      },
      emitFinished: async (event, aborts) => {
        const turnId = playbookCallTurnIds.get(event.callId);
        try {
          await emitTrace(
            'playbook.call.finished',
            {
              stateId: event.stateId,
              playbookId: event.playbookId,
              text: event.text,
              result: event.result,
            },
            {
              ...(turnId !== undefined ? { turnId } : {}),
              callId: event.callId,
            },
            aborts,
          );
        } finally {
          playbookCallTurnIds.delete(event.callId);
          playbookCallEffectPrefixes.delete(event.callId);
        }
      },
      drain: drainEmissions,
      bindResumeSignal: (signal, aborts) => {
        activeSignal = signal;
        activeAborts = aborts ?? abortReasonClassifier(signal);
      },
      bindActorSettlement: (aborts) => {
        actorSettlementAborts = aborts;
      },
      onControlPlaneError: (error, aborts) => {
        // The shared bridge classifies before reporting against its own
        // invocation-and-resume signals; classify once more here against
        // the boundary signal so a report that is the active boundary's
        // exact abort reason can never masquerade as a control error
        // (slc/link.md §Abort).
        if (
          !aborts?.isAbortReason(error) &&
          !activeAborts?.isAbortReason(error)
        ) {
          controlPlaneError ??= error;
        }
      },
      onBackgroundError: (error, aborts) => {
        if (!aborts?.isAbortReason(error)) emissionFailure ??= { error };
      },
    });

    function tracePositionForActiveTurn(): TracePosition {
      return activeTurnId === undefined ? {} : { turnId: activeTurnId };
    }

    function structuredStateTelemetryPayload(
      previousState: PlaybookState | undefined,
      state: PlaybookState,
      event: unknown,
      context: Record<string, unknown>,
    ): JsonValue {
      const payload: Record<string, unknown> = {
        from: previousState?.value ?? null,
        to: state.value,
        event: normalizeTransitionEvent(event) ?? null,
        previousState: previousState ?? null,
        state,
      };
      const pendingBossQuestion = pendingBossQuestionForState(state, context);
      if (
        pendingBossQuestion !== undefined &&
        !hasUnresolvedReconciliation()
      ) {
        payload.pendingBossQuestion = pendingBossQuestion;
      }
      if (state.stateId === 'failed') {
        const lastError = normalizeErrorFull(context.lastError);
        if (lastError !== undefined) payload.lastError = lastError;
      }
      return snapshotJsonValue(payload, 'FSM telemetry payload');
    }

    function enqueueTransitionEmission(
      payload: JsonValue,
      state: PlaybookState,
      acceptedOutcomes: readonly AcceptedOutcomeReceipt[],
      statuses: readonly ScheduledStatus[],
      position: TracePosition,
      aborts?: AbortReasonClassifier,
    ): void {
      const currentSession = requireSession();
      const transitionTrace = createTraceEvent(
        'fsm.transition',
        payload,
        position,
      );
      const acceptedOutcomeTraces = acceptedOutcomes.map((acceptedOutcome) =>
        createTraceEvent('outcome.accepted', acceptedOutcome, position),
      );
      const statusEmissions = statuses.map(({ message, data }) => ({
        message,
        data,
        trace: createTraceEvent(
          'status.emitted',
          {
            message,
            ...(data === undefined ? {} : { data }),
            state,
            ...stateIdentity(state.stateId),
          },
          position,
        ),
      }));
      void enqueueEmission(
        async () => {
          await currentSession.ports.emitTelemetry({
            topic: 'playbook.trace',
            payload: transitionTrace,
          });
          await currentSession.ports.emitTelemetry({
            topic: 'playbook.fsm.state',
            payload,
          });
          for (const acceptedOutcome of acceptedOutcomeTraces) {
            await currentSession.ports.emitTelemetry({
              topic: 'playbook.trace',
              payload: acceptedOutcome,
            });
          }
          for (const status of statusEmissions) {
            await currentSession.ports.emitTelemetry({
              topic: 'playbook.trace',
              payload: status.trace,
            });
            await currentSession.ports.emitStatus(status.message, status.data);
          }
        },
        aborts,
      ).catch(() => undefined);
    }

    // One classifying latch for every runtime-observed error — inspection
    // failures and root-actor errors alike. Outside a boundary the error
    // rides the emission channel, which the next boundary's (or init's)
    // drain throws; inside a boundary it is a control-plane error unless it
    // is the boundary signal's own abort reason (slc/link.md §Abort).
    function latchRuntimeError(
      error: unknown,
      aborts: AbortReasonClassifier | undefined = activeAborts,
    ): void {
      if (aborts?.isAbortReason(error)) return;
      if (activeSignal === undefined) emissionFailure ??= { error };
      else controlPlaneError ??= error;
    }

    function consumeActorSettlementAborts(
      forSnapshot = false,
    ): AbortReasonClassifier | undefined {
      const aborts = actorSettlementAborts ?? actorSettlementErrorAborts;
      actorSettlementAborts = undefined;
      actorSettlementErrorAborts = undefined;
      if (forSnapshot && aborts !== undefined) {
        // XState can report an errored root through both its inspection
        // snapshot and subscriber. Keep the same provenance through that
        // synchronous notification only; an ordinary transition must not
        // lend it to a later unrelated actor error.
        actorSettlementErrorAborts = aborts;
        queueMicrotask(() => {
          if (actorSettlementErrorAborts === aborts) {
            actorSettlementErrorAborts = undefined;
          }
        });
      }
      return aborts;
    }

    // PBRT-6: the single seam that stops this runtime's actor. Stopping a
    // still-running actor fires one more `@xstate.snapshot` for the
    // *unchanged* state value with `status: 'stopped'`, which the inspect
    // callback cannot distinguish from a state entry — unsuppressed it
    // re-emits the parked state's statuses and a phantom self-loop
    // transition. Suppression is a property of stopping, not a rule each
    // caller must remember, so every stop goes through here; a caller that
    // builds a replacement actor clears the flag before starting it.
    function stopActor(): void {
      if (!actor) return;
      suppressInspectionEmissions = true;
      acceptedOutcomeConsumer.reset();
      actor.stop();
    }

    function buildActor(
      ports: PlaybookPorts,
      machineSnapshot?: JsonValue,
    ): ReturnType<typeof createActor> {
      priorState = undefined;
      acceptedOutcomeConsumer.reset();
      const actors: Record<string, unknown> = {};
      if (declaredActors.has('player')) actors.player = playerActor(ports);
      if (declaredActors.has('captain')) actors.captain = captainActor();
      if (declaredActors.has('script')) actors.script = scriptActor();
      if (declaredActors.has('playbook')) {
        actors.playbook = nestedBridge.actorLogic;
      }
      const provided = machine.provide({
        actors: actors as never,
      });
      let builtActor: ReturnType<typeof createActor>;
      builtActor = createActor(provided, {
        input: machineInput(boundOptions, requireSession()) as never,
        // DR-014 §1: a restore rehydrates the persisted machine snapshot;
        // XState derives context/value from it and ignores `input` then.
        ...(machineSnapshot === undefined
          ? {}
          : { snapshot: machineSnapshot as never }),
        inspect: (inspectionEvent: InspectionEvent) => {
          if (inspectionEvent.actorRef !== builtActor) return;
          if (suppressInspectionEmissions) return;
          if (inspectionEvent.type === '@xstate.action') {
            try {
              acceptedOutcomeConsumer.capture(inspectionEvent.action);
            } catch (error) {
              latchRuntimeError(error);
            }
            return;
          }
          if (inspectionEvent.type !== '@xstate.snapshot') return;
          const settlementAborts = consumeActorSettlementAborts(true);
          try {
            const snap = inspectionEvent.snapshot;
            const state = normalizePlaybookSnapshot(snap);
            if (state.stateId === undefined) {
              throw new Error(
                `${label} root snapshot must expose exactly one playbook state id`,
              );
            }
            const previousState = priorState;
            acceptReconstructedGovernedDelivery(state);
            let acceptedOutcomes: readonly AcceptedOutcomeReceipt[] = [];
            try {
              acceptedOutcomes = acceptedOutcomeConsumer.confirm(
                previousState,
                state,
              );
            } catch (error) {
              latchRuntimeError(error);
            }
            if (state.stateId === 'failed') {
              if (
                previousState?.stateId !== 'failed' ||
                activeGovernedBoundarySeen
              ) {
                latchFailedGovernedAttempt();
              }
            } else if (previousState?.stateId === 'failed') {
              failedEffectBoundaryPrefix = undefined;
              failedGovernedAttemptId = undefined;
              failedGovernedAttemptUnknown = false;
            }
            const context = ((snap as { context?: unknown }).context ??
              {}) as Record<string, unknown>;
            if (
              state.stateId === BOSS_REPLY_WAIT_STATE_ID &&
              deferredReconciliationOperationId !== undefined
            ) {
              priorState = state;
              return;
            }
            if (
              state.stateId === BOSS_REPLY_WAIT_STATE_ID &&
              expectedBoundPendingQuestion !== undefined &&
              !deferInspectionEmissions
            ) {
              validateBoundQuestionProjection();
            }
            const payload = structuredStateTelemetryPayload(
              previousState,
              state,
              inspectionEvent.event,
              context,
            );
            const stateStatuses = statusesForState(
              state,
              context,
              inspectionEvent.event,
            );
            const outcomeStatuses = usesDefaultStatuses
              ? artifactSchema === 2
                ? (() => {
                    const guard = settlingGuard(inspectionEvent.event);
                    return guard === undefined
                      ? []
                      : [{ message: `→ ${guard}` }];
                  })()
                : acceptedOutcomes.map(({ acceptedOutcome }) => ({
                    message: `→ ${acceptedOutcome}`,
                  }))
              : [];
            const statuses = [...outcomeStatuses, ...stateStatuses];
            const publish = () =>
              enqueueTransitionEmission(
                payload,
                state,
                acceptedOutcomes,
                statuses,
                tracePositionForActiveTurn(),
                settlementAborts,
              );
            if (deferInspectionEmissions) {
              deferredInspectionEmissions.push(publish);
            } else {
              publish();
            }
            priorState = state;
          } catch (error) {
            acceptedOutcomeConsumer.reset();
            latchRuntimeError(error, settlementAborts);
          }
        },
      });
      // A synchronously-errored actor is already quiescent, so the turn's
      // quiescence wait never subscribes and XState would report the error
      // as unhandled after the boundary returns. Observe it through the
      // classifying latch: mid-boundary it is the control-plane error
      // unless it is the abort reason itself; at startup it rides the
      // emission channel so `init`'s own drain rejects with it and the
      // failed-start cleanup runs (slc/link.md §Session lifecycle).
      builtActor.subscribe({
        error: (error) =>
          latchRuntimeError(error, consumeActorSettlementAborts()),
      });
      return builtActor;
    }

    function runResultFor(
      outcome: BossSettlementOutcome,
      error?: unknown,
    ): PlaybookRunResult {
      const state = currentState();
      if (outcome === 'quiescent' || outcome === 'no-action') {
        return { outcome, state };
      }
      if (outcome === 'unresolved-effect') {
        return { outcome, state };
      }
      if (outcome === 'suspended') {
        const pendingCall = nestedBridge.getPendingCall();
        if (!pendingCall) {
          throw new Error('suspended runtime has no pending playbook call');
        }
        return { outcome, state, pendingCall };
      }
      if (outcome === 'terminal') {
        const output = (
          actor?.getSnapshot() as { output?: unknown } | undefined
        )?.output;
        const stateDescription =
          !hasUnresolvedReconciliation()
            ? stateDescriptionFor(state)
            : undefined;
        return {
          outcome,
          state,
          ...(stateDescription === undefined ? {} : { stateDescription }),
          ...(output === undefined
            ? {}
            : {
                output: snapshotJsonValue(
                  output,
                  'terminal playbook output',
                ),
              }),
        };
      }
      const failure =
        error ??
        (outcome === 'failed'
          ? (actor?.getSnapshot() as { context?: { lastError?: unknown } })
              ?.context?.lastError
          : outcome === 'aborted'
            ? activeSignal?.reason
            : undefined);
      return {
        outcome,
        state,
        ...(failure !== undefined ? { error: normalizeError(failure) } : {}),
      };
    }

    function settledOutcome(signal: AbortSignal): BossSettlementOutcome {
      if (nestedBridge.getPendingCall()) return 'suspended';
      const state = currentState();
      if (state.status === 'error') {
        // An errored actor outranks a coincident abort unless the actor's
        // error is the abort reason itself (slc/link.md §Abort).
        const actorError = (
          actor?.getSnapshot() as { error?: unknown } | undefined
        )?.error;
        if (actorError !== undefined && isAbortFailure(actorError, signal)) {
          return 'aborted';
        }
        throw actorError ?? new Error(`${label} actor entered error status`);
      }
      // Terminal completion outranks a coincident abort: the work finished,
      // and reporting `aborted` would hide a terminal machine behind a
      // settlement a later turn silently restarts (slc/link.md §Abort).
      if (state.status === 'done') return 'terminal';
      if (signal.aborted) return 'aborted';
      if (state.stateId === 'failed') return 'failed';
      return 'quiescent';
    }

    function settlementTracePayload(
      result: PlaybookRunResult,
    ): Record<string, unknown> {
      return {
        ...result,
        ...stateIdentity(result.state.stateId),
      };
    }

    // Shared failed-start cleanup for init, restore, and adoption: stop the
    // actor, abort/drain nested and host work, optionally emit one best-effort
    // session.disposed boundary, and unbind every closure field so dispose
    // stays callable. The caller rethrows its original failure. A snapshot
    // start failure skips the disposal trace — the parked generation was
    // never re-bound in this process, so its persisted snapshot stays
    // authoritative (DR-014 §2).
    async function cleanupFailedStart(
      cause: unknown,
      options: { emitDisposal: boolean },
    ): Promise<void> {
      let finalState: PlaybookState | undefined;
      if (options.emitDisposal && actor) {
        try {
          finalState = currentState();
        } catch {
          // A state that cannot even normalize has no disposal descriptor.
        }
      }
      try {
        stopActor();
      } catch {
        // Preserve the original startup failure.
      }
      try {
        await nestedBridge.abortPending(cause);
      } catch {
        // Preserve the original startup failure.
      }
      try {
        await judgeQueue.onIdle();
        await drainEmissions();
      } catch {
        // Preserve the original startup failure.
      }
      if (options.emitDisposal) {
        try {
          await emitTrace(
            'session.disposed',
            finalState === undefined
              ? {}
              : {
                  state: finalState,
                  ...stateIdentity(finalState.stateId),
                },
          );
          await drainEmissions();
        } catch {
          // The session-start error remains authoritative.
        }
      }
      privateResumeTokens.clear();
      activePlayerKeys.clear();
      playbookCallTurnIds.clear();
      playbookCallEffectPrefixes.clear();
      activeEmissionCalls.clear();
      emissionQueue.clear();
      judgeQueue.clear();
      appliedReceipts.clear();
      actor = undefined;
      session = undefined;
      savedPorts = undefined;
      runtimePorts = undefined;
      activeSignal = undefined;
      activeAborts = undefined;
      actorSettlementAborts = undefined;
      actorSettlementErrorAborts = undefined;
      activeAbortEmission = undefined;
      activeTurnId = undefined;
      activeGovernedBoundarySeen = false;
      activeGovernedAttemptId = undefined;
      activeEffectLedgerPrefixSequence = undefined;
      failedGovernedAttemptUnknown = false;
      failedEffectBoundaryPrefix = undefined;
      failedGovernedAttemptId = undefined;
      controlPlaneError = undefined;
      emissionFailure = undefined;
      priorState = undefined;
      retainedEffectSourceSessionId = undefined;
      retainedEffectReconciliation = undefined;
      retainedEffectReconciliationRequired = false;
      reconstructedGovernedDelivery = undefined;
      reconstructedGovernedPrefixSequence = undefined;
      reconstructedAcceptancePending = undefined;
      governedSettlementsByBoundaryId.clear();
      governedCompletionEvidenceByBoundaryId.clear();
      unresolvedSemanticBoundaryIds.clear();
      deferredReconciliationOperationId = undefined;
      deferredSettlementClosure = undefined;
      expectedBoundPendingQuestion = undefined;
      activeDeferredContinuation = undefined;
      deferInspectionEmissions = false;
      deferredInspectionEmissions = [];
      lastBossEvent = undefined;
      suppressInspectionEmissions = false;
      initialized = false;
      traceSequence = 0;
      turnSequence = 0;
      judgeCallSequence = 0;
      playerCallSequence = 0;
      playbookCallSequence = 0;
      captainCallSequence = 0;
      applyCallSequence = 0;
    }

    // -----------------------------------------------------------------
    // DR-029 control surface: action derivation shared by `describe`
    // and by `apply`'s live revalidation.
    // -----------------------------------------------------------------

    interface DerivedControlAction {
      action: PlaybookControlAction;
      event?: EventObject;
      deferredRestoreOperationId?: string;
      unresolvedEffectAction?: 'reconcile' | 'abandon';
    }

    function snapshotCan(snapshot: unknown, event: EventObject): boolean {
      const can = (snapshot as { can?: unknown } | null)?.can;
      return (
        typeof can === 'function' &&
        (can as (candidate: EventObject) => boolean).call(snapshot, event) ===
          true
      );
    }

    // DR-034: where the artifact names the FSM context member its entry
    // action copies the exact Boss text into, that member of the live
    // snapshot is the retry payload's source. The persisted machine snapshot
    // carries it, so the candidate derives identically in the process that
    // exported the snapshot and in one that restored it, and a failure
    // reached after a Boss reply — whose recorded event the failure state
    // refuses — is recoverable too. Naming the member is the artifact's
    // statement that it holds the entry text: a same-named member is never
    // assumed, since inferring one would turn any matching context member
    // into a replay payload without its author saying so.
    // Declared and absent or empty excludes the candidate rather than
    // falling back to the record, which would make the action depend on the
    // process again — the very thing this source exists to end.
    function retryEventFrom(snapshot: unknown): EventObject | undefined {
      const entryEvent = spec.entryEvent;
      if (entryEvent?.contextField === undefined) return lastBossEvent;
      const context = (snapshot as { context?: unknown } | null)?.context;
      const text = isPlainObject(context)
        ? context[entryEvent.contextField]
        : undefined;
      if (typeof text !== 'string' || text.trim() === '') return undefined;
      return { type: entryEvent.type, [entryEvent.textField]: text };
    }

    // The failure-state retry entry replays the recorded last classified
    // event with its recorded payload, or the entry event the declared
    // context member above sources. A candidate whose event the live
    // snapshot does not accept — or whose payload the runtime can source
    // from neither — is excluded rather than completed with invented text.
    function retryActionFor(
      snapshot: unknown,
      stateId: string | undefined,
    ): DerivedControlAction | undefined {
      if (stateId !== 'failed') return undefined;
      if (!failedAttemptAllowsReplay()) return undefined;
      const retryEvent = retryEventFrom(snapshot);
      if (retryEvent === undefined) return undefined;
      if (!snapshotCan(snapshot, retryEvent)) return undefined;
      // A recorded explicit-state-jump event names the exact state its
      // replay re-enters: the root BOSS_INTERRUPT shape is a guarded
      // multi-arm list keyed on `targetId`, so the first configured arm
      // may label a different state than the one the recorded event
      // actually resumes.
      const recordedTargetId =
        retryEvent.type === JUMP_EVENT_TYPE
          ? (retryEvent as { targetId?: unknown }).targetId
          : undefined;
      const target =
        typeof recordedTargetId === 'string' &&
        recordedTargetId.trim().length > 0
          ? recordedTargetId
          : firstTransitionTarget(machine, stateId, retryEvent.type);
      // PBRT-52: a label is written from a source state description, never
      // from an identifier. Falling back to the target id — or, with no
      // resolvable target, to the FSM event type — makes the label *be* the
      // internal name, which defeats the substitution the label exists for
      // and puts a machine identifier into Boss-facing text
      // (CAPPLAY-5). A candidate whose label can only be an id is excluded
      // exactly like one whose payload cannot be sourced.
      const description =
        (target === undefined ? undefined : stateDescriptions.get(target)) ??
        stateDescriptions.get(stateId);
      if (description === undefined) return undefined;
      return {
        action: {
          id: `retry:${retryEvent.type}`,
          label: `Retry: ${description}`,
        },
        event: retryEvent,
      };
    }

    function deriveControlActions(snapshot: unknown): DerivedControlAction[] {
      // Actions derive only at the safe point the parked snapshot also
      // uses — quiescent actor with status `active` and no pending nested
      // call. Anywhere else the view still describes the state while
      // advertising nothing.
      let state: PlaybookState;
      try {
        state = normalizePlaybookSnapshot(snapshot, {
          pendingCall: nestedBridge.getPendingCall(),
        });
      } catch {
        return [];
      }
      if (
        state.status !== 'active' ||
        !state.quiescent ||
        nestedBridge.getPendingCall()
      ) {
        return [];
      }
      const derived: DerivedControlAction[] = [];
      if (hasUnresolvedReconciliation()) {
        const operation =
          deferredReconciliationOperationId === undefined
            ? undefined
            : effectLedgerMirror.logicalOperations.find(
                ({ operationId }) =>
                  operationId === deferredReconciliationOperationId,
              );
        const deferredRestoreOperationId =
          operation?.checkpointRestorationEligible === true
            ? operation.operationId
            : undefined;
        derived.push(
          {
            action: {
              id: UNRESOLVED_EFFECT_RECONCILIATION_ACTION_ID,
              label: 'Retry unresolved effect reconciliation',
            },
            unresolvedEffectAction: 'reconcile',
            ...(deferredRestoreOperationId === undefined
              ? {}
              : { deferredRestoreOperationId }),
          },
          {
            action: {
              id: UNRESOLVED_EFFECT_ABANDONMENT_ACTION_ID,
              label: 'Abandon unresolved workflow attempt',
            },
            unresolvedEffectAction: 'abandon',
          },
        );
        return derived;
      }
      const retry = retryActionFor(snapshot, state.stateId);
      if (retry !== undefined) derived.push(retry);
      // Jump entries: resumable targets whose explicit-state-jump event the
      // live snapshot accepts (state guards included), sent with the
      // advertised target id and optional textual fields omitted.
      for (const targetId of [...resumableStateIds].sort()) {
        const event = { type: JUMP_EVENT_TYPE, targetId } as EventObject;
        if (!snapshotCan(snapshot, event)) continue;
        // PBRT-52: no published description for the target, no Boss-appropriate
        // label. A jump cannot borrow another state's meaning without naming
        // the wrong state, so the entry is not advertised at all rather than
        // labeled with its own target id.
        const description = stateDescriptions.get(targetId);
        if (description === undefined) continue;
        derived.push({
          action: {
            id: `jump:${targetId}`,
            label: `Resume from: ${description}`,
          },
          event,
        });
      }
      return derived;
    }

    // PBRT-52: the control view's context is the artifact's declared
    // projection, not a serialization of whatever the FSM happens to hold.
    // Only the runtime knows which of its context members are safe and
    // relevant for a controller prompt — an allow-by-default export cannot
    // keep player output, resolved player identities, or option values out
    // of a prompt whose host is required to exclude them
    // (CAPTAIN-9) — so nothing is exported unless
    // `controlContextFields` names it, in the order it names them. Each
    // named member is still sanitized: raw `Error` values are normalized
    // and a value that cannot be made JSON-safe is dropped, never thrown,
    // since `describe` must stay side-effect free and total.
    function projectControlContext(
      context: Record<string, unknown>,
    ): JsonValue | undefined {
      const projected: Record<string, JsonValue> = {};
      for (const key of controlContextFields) {
        const value = context[key];
        if (value === undefined) continue;
        try {
          projected[key] = snapshotJsonValue(
            value instanceof Error ? normalizeError(value) : value,
            `control context ${key}`,
          );
        } catch {
          // Declared but not JSON-safe — dropped.
        }
      }
      return Object.keys(projected).length === 0 ? undefined : projected;
    }

    // PBRT-52: the view's Boss-facing state description — the meaning of the
    // state the runtime is in, written by the artifact's own source, from the
    // same descriptions its action labels are written from. A control view is
    // the only grounding a controller host has for a status answer, and an
    // internal state id is not Boss-appropriate text
    // (CAPPLAY-5), so the runtime publishes the meaning
    // rather than leaving the host to substitute the identifier for it. A
    // state whose source declares no description publishes none: an id is
    // never promoted into a description by default.
    function stateDescriptionFor(state: PlaybookState): string | undefined {
      const keys = [
        ...(state.stateId === undefined ? [] : [state.stateId]),
        ...(typeof state.value === 'string' ? [state.value] : []),
        ...state.activeStateIds,
      ];
      for (const key of keys) {
        const description = stateDescriptions.get(key);
        if (description !== undefined) return description;
      }
      return undefined;
    }

    function receiptTracePayload(
      receipt: PlaybookControlReceipt,
    ): Record<string, unknown> {
      return {
        disposition: receipt.disposition,
        ...(receipt.disposition === 'rejected'
          ? { reason: receipt.reason }
          : {}),
        ...(receipt.disposition === 'failed' ? { error: receipt.error } : {}),
        ...(receipt.disposition === 'executed' ? { run: receipt.run } : {}),
      };
    }

    // DR-014 / DR-038: restore and adoption share one transactional snapshot
    // start. Adoption deliberately differs at the public boundary so a host
    // can feature-detect permission to bind a retained generation to a fresh
    // engagement identity; the runtime-visible schema, playbook, and actor
    // state remain exact, while adoption deliberately re-keys a suspended
    // bridge into the fresh target counter and session lineage.
    async function rehydrateSnapshot(
      kind: 'restore' | 'adopt',
      nextSession: PlaybookSession,
      snapshot: PlaybookRuntimeSnapshot,
      context?: PlaybookAdoptionContext,
    ): Promise<void> {
      if (initialized || disposed || disposalPromise !== undefined) {
        throw new Error(
          `createPlaybookRuntime.${kind}: already initialized`,
        );
      }
      const boundSession = bindSession(nextSession);
      const boundSnapshot = assertPlaybookRuntimeSnapshot(
        snapshot,
        boundSession.playbookId,
        { allowSuspendedCall: true },
      );
      if (
        kind === 'adopt' &&
        effectLedgerCapability !== undefined &&
        (
          boundSnapshot.retainedEffectReconciliation?.checkpoint ??
          boundSnapshot.effectLedger
        ).boundaries.some(
          ({ physicalReceipt }) => physicalReceipt === undefined,
        )
      ) {
        throw new TypeError(
          'retained runtime checkpoint contains an incomplete physical boundary',
        );
      }
      if (
        artifactSchema === 2 &&
        (boundSnapshot.retainedEffectSourceSessionId !== undefined ||
          boundSnapshot.retainedEffectReconciliation !== undefined)
      ) {
        throw new TypeError(
          'schema-2 runtime snapshots must not carry retained effect lineage',
        );
      }
      const hostEffectLedger = currentEffectLedger();
      if (
        kind === 'restore' &&
        !isDeepStrictEqual(boundSnapshot.effectLedger, hostEffectLedger)
      ) {
        throw new TypeError(
          'runtime snapshot effectLedger does not equal the current host mirror',
        );
      }
      if (
        kind === 'adopt' &&
        !isPlaybookEffectLedgerMonotonicExtension(
          boundSnapshot.effectLedger,
          hostEffectLedger,
        )
      ) {
        throw new TypeError(
          'retained runtime snapshot effectLedger is not a monotonic prefix of the current host mirror',
        );
      }
      effectLedgerMirror = hostEffectLedger;
      if (
        declaredActors.has('captain') &&
        boundSnapshot.sequences.captainCall === undefined
      ) {
        throw new TypeError(
          'runtime snapshot sequences.captainCall is required for a direct-Captain artifact',
        );
      }
      const adoptionContext =
        kind === 'adopt'
          ? snapshotAdoptionContext(context, boundSession, boundSnapshot)
          : undefined;
      if (
        adoptionContext !== undefined &&
        effectLedgerCapability !== undefined &&
        !RETAINED_EFFECT_SESSION_ID_PATTERN.test(
          adoptionContext.sourceSessionId,
        )
      ) {
        throw new TypeError(
          'schema-3 retained adoption sourceSessionId must be a canonical UUID',
        );
      }
      const retainedReconciliation =
        boundSnapshot.retainedEffectReconciliation ??
        (adoptionContext !== undefined &&
        effectLedgerCapability !== undefined &&
        !retainedAdoptionCheckpointIsSafe(
          boundSnapshot.effectLedger,
          hostEffectLedger,
        )
          ? Object.freeze({
              sourceSessionId:
                boundSnapshot.retainedEffectSourceSessionId ??
                adoptionContext.sourceSessionId,
              checkpoint: boundSnapshot.effectLedger,
            })
          : undefined);
      retainedEffectSourceSessionId =
        boundSnapshot.retainedEffectSourceSessionId ??
        boundSnapshot.retainedEffectReconciliation?.sourceSessionId ??
        (adoptionContext !== undefined && effectLedgerCapability !== undefined
          ? adoptionContext.sourceSessionId
          : undefined);
      bindRetainedEffectReconciliation(
        retainedReconciliation,
        hostEffectLedger,
      );
      const sourceSuspendedCall = boundSnapshot.suspendedCall;
      const suspendedCall: PlaybookSuspendedCall | undefined =
        adoptionContext !== undefined && sourceSuspendedCall !== undefined
          ? Object.freeze({
              callId: 'playbook-1',
              stateId: sourceSuspendedCall.stateId,
              playbookId: sourceSuspendedCall.playbookId,
              text: sourceSuspendedCall.text,
              childSessionId: adoptionContext.targetChildSessionId!,
            })
          : sourceSuspendedCall;
      let priorExternalPlayerTokens:
        | Readonly<Record<string, string>>
        | undefined;
      let externalStoreRestoreAttempted = false;
      let adoptionStartAttempted = false;
      initialized = true;
      let finishInitialization!: () => void;
      const initialization = new Promise<void>((resolve) => {
        finishInitialization = resolve;
      });
      initInFlight = initialization;
      const initTask = (async () => {
        session = boundSession;
        syncDeferredReconciliationOverlay();
        refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
        prepareReconstructedGovernedDelivery(
          boundSnapshot.state,
          effectLedgerMirror,
        );
        savedPorts = boundSession.ports;
        runtimePorts = createRuntimePorts(boundSession.ports);
        if (adoptionContext === undefined) {
          traceSequence = boundSnapshot.sequences.trace;
          turnSequence = boundSnapshot.sequences.turn;
          judgeCallSequence = boundSnapshot.sequences.judgeCall;
          playerCallSequence = boundSnapshot.sequences.playerCall;
          playbookCallSequence = boundSnapshot.sequences.playbookCall;
          captainCallSequence = boundSnapshot.sequences.captainCall ?? 0;
          // The runtime snapshot carries no apply counter (PBRT-50); every
          // apply boundary consumed trace numbers, so the persisted trace
          // counter is a collision-safe id floor here too, keeping
          // `apply-<n>` call ids unique across a snapshot start.
          applyCallSequence = boundSnapshot.sequences.trace;
        } else {
          // DR-038 §5: a new engagement owns a new counter space. A
          // rebased live child consumes the first target-local playbook id;
          // all other counters begin before their first target boundary.
          traceSequence = 0;
          turnSequence = 0;
          judgeCallSequence = 0;
          playerCallSequence = 0;
          playbookCallSequence = suspendedCall === undefined ? 0 : 1;
          captainCallSequence = 0;
          applyCallSequence = 0;
        }
        // Same-engagement restore owns the snapshot's token projection.
        // Adoption leaves it inert: the fresh engagement's player ledger (or
        // the absence of one) is authoritative, and its binding rules land
        // independently under DR-038 §4.
        if (kind === 'restore') {
          if (boundSession.playerSessions) {
            priorExternalPlayerTokens = snapshotRoleResumeTokens();
            externalStoreRestoreAttempted = true;
          }
          restoreRoleResumeTokens(boundSnapshot.roleResumeTokens);
        }
        nestedBridge.prepareRestore(suspendedCall);
        if (suspendedCall !== undefined) {
          playbookCallTurnIds.set(
            suspendedCall.callId,
            suspendedCall.turnId,
          );
          if (hasGovernedPlayerStates) {
            const savedPrefix =
              kind === 'restore'
                ? suspendedCall.effectBoundaryPrefixSequence
                : undefined;
            // Pre-task-5 snapshots and retained-generation adoption have no
            // target-local causal prefix. Zero is conservative; an explicit
            // null preserves an observation failure as unknown/fail-closed.
            playbookCallEffectPrefixes.set(
              suspendedCall.callId,
              savedPrefix === null ? undefined : (savedPrefix ?? 0),
            );
          }
        }
        suppressInspectionEmissions = true;
        actor = buildActor(runtimePorts, boundSnapshot.machine);
        if (adoptionContext !== undefined) {
          adoptionStartAttempted = true;
          await emitTrace(
            'session.started',
            {
              state: boundSnapshot.state,
              ...stateIdentity(boundSnapshot.state.stateId),
              adoption: {
                sourceSessionId: adoptionContext.sourceSessionId,
                sourceGenerationId: adoptionContext.sourceGenerationId,
                ...(sourceSuspendedCall === undefined ||
                suspendedCall === undefined
                  ? {}
                  : {
                      sourceCallId: sourceSuspendedCall.callId,
                      sourceChildSessionId:
                        sourceSuspendedCall.childSessionId,
                      targetCallId: suspendedCall.callId,
                      targetChildSessionId: suspendedCall.childSessionId,
                    }),
              },
            },
            suspendedCall === undefined
              ? {}
              : { callId: suspendedCall.callId },
          );
        }
        actor.start();
        // A start-time actor error rides the startup emission channel
        // (latchRuntimeError); consume both latches here so the original
        // error outranks the derived status check below.
        {
          const startupFailure = emissionFailure;
          if (
            controlPlaneError !== undefined ||
            startupFailure !== undefined
          ) {
            const startupError =
              controlPlaneError !== undefined
                ? controlPlaneError
                : startupFailure!.error;
            controlPlaneError = undefined;
            if (emissionFailure === startupFailure) {
              emissionFailure = undefined;
            }
            throw startupError;
          }
        }
        const restoredState = normalizePlaybookSnapshot(
          actor.getSnapshot(),
          suspendedCall === undefined
            ? {}
            : {
                pendingCall: {
                  callId: suspendedCall.callId,
                  playbookId: suspendedCall.playbookId,
                  childSessionId: suspendedCall.childSessionId,
                },
              },
        );
        if (restoredState.status !== 'active') {
          throw new Error(
            `createPlaybookRuntime.${kind}: restored actor status is ${restoredState.status}, expected active`,
          );
        }
        if (
          stableJson(restoredState, 'restored runtime state') !==
          stableJson(boundSnapshot.state, 'runtime snapshot state')
        ) {
          throw new Error(
            `createPlaybookRuntime.${kind}: restored actor state does not match snapshot state`,
          );
        }
        const restoredFailedEffectAttempt =
          restoredState.stateId === 'failed' && kind === 'restore'
            ? boundSnapshot.failedEffectAttempt
            : undefined;
        failedEffectBoundaryPrefix =
          restoredFailedEffectAttempt?.boundaryPrefix;
        failedGovernedAttemptId =
          typeof restoredFailedEffectAttempt?.attemptId === 'string'
            ? restoredFailedEffectAttempt.attemptId
            : undefined;
        activeGovernedBoundarySeen = false;
        activeGovernedAttemptId = undefined;
        activeEffectLedgerPrefixSequence = undefined;
        failedGovernedAttemptUnknown =
          restoredState.stateId === 'failed' &&
          kind === 'restore' &&
          hasGovernedPlayerStates &&
          restoredFailedEffectAttempt === undefined;
        priorState = restoredState;
        await drainEmissions();
        suppressInspectionEmissions = false;
        acceptReconstructedGovernedDelivery(currentState());
        // Final fallible step: after this publication the authoritative
        // child has rejoined ordinary resume/abort ownership, so no later
        // snapshot-start validation may trigger failed-start rollback.
        nestedBridge.confirmRestore();
      })();
      try {
        await initTask;
      } catch (error) {
        let failure = error;
        if (
          externalStoreRestoreAttempted &&
          priorExternalPlayerTokens !== undefined
        ) {
          try {
            boundSession.playerSessions!.restore(priorExternalPlayerTokens);
          } catch (rollbackError) {
            failure = new AggregateError(
              [error, rollbackError],
              `createPlaybookRuntime.${kind} and player continuation rollback failed`,
            );
          }
        }
        await cleanupFailedStart(failure, {
          emitDisposal: adoptionStartAttempted,
        });
        throw failure;
      } finally {
        finishInitialization();
        if (initInFlight === initialization) initInFlight = undefined;
      }
    }

    function validateBoundQuestionProjection(): void {
      const expected = expectedBoundPendingQuestion;
      if (expected === undefined) return;
      const snapshot = actor?.getSnapshot();
      const state = snapshot === undefined
        ? undefined
        : normalizePlaybookSnapshot(snapshot);
      const context = ((snapshot as { context?: unknown } | undefined)
        ?.context ?? {}) as Record<string, unknown>;
      const actual =
        state?.stateId === BOSS_REPLY_WAIT_STATE_ID
          ? pendingBossQuestionFromContext(context)
          : undefined;
      if (!isDeepStrictEqual(actual, expected)) {
        throw new Error(
          `${label} deferred FSM question does not equal its durable binding`,
        );
      }
      const operation = currentBoundDeferredOperation(expected);
      if (operation === undefined) {
        throw new Error(
          `${label} deferred FSM question has no exact durable operation`,
        );
      }
      expectedBoundPendingQuestion = undefined;
    }

    function settleDeferredInspectionBuffer(publish: boolean): void {
      const buffered = deferredInspectionEmissions;
      deferredInspectionEmissions = [];
      deferInspectionEmissions = false;
      if (publish) {
        for (const emission of buffered) emission();
      }
    }

    async function continueBoundDeferredOperation(
      operation: PlaybookEffectLogicalOperation,
      event: EventObject,
      signal: AbortSignal,
      turnId: number,
      classificationLine?: string,
    ): Promise<'continued' | 'unresolved'> {
      if (repositoryCapability === undefined) {
        throw new Error(
          `${label} deferred continuation requires repository.runDeferred`,
        );
      }
      const effectBoundary = continuationBoundarySeed(operation, turnId);
      const continuation: NonNullable<typeof activeDeferredContinuation> = {
        operationId: operation.operationId,
        effectBoundary,
        rawPlayerSettled: deferredValue<void>(),
        delivery: deferredValue<PlayerResult>(),
      };
      activeDeferredContinuation = continuation;
      deferInspectionEmissions = true;
      let continuationStarted = false;
      let deliverySettled = false;
      deferredInspectionEmissions =
        classificationLine === undefined
          ? []
          : [() => void runtimePorts!.emitStatus(classificationLine)];
      try {
        const result = await repositoryCapability.runDeferred({
          mode: 'continue',
          signal,
          operationId: operation.operationId,
          effectBoundary,
          operation: async ({ playerContinuation }) => {
            const selectedContinuation =
              retainedEffectSourceSessionId === undefined
                ? playerContinuation
                : selectPlayerResume(
                    effectBoundary.roleId,
                    resolvedPlayerId(effectBoundary.roleId),
                  );
            if (
              selectedContinuation !== false &&
              (typeof selectedContinuation !== 'string' ||
                selectedContinuation.trim().length === 0)
            ) {
              throw new TypeError(
                `${label} bound deferred player continuation is invalid`,
              );
            }
            // Retained adoption owns a fresh Captain-session player ledger;
            // no source token becomes target ownership. Same-engagement
            // continuation still uses the exact durable binding.
            continuation.playerContinuation = selectedContinuation;
            continuationStarted = true;
            actor!.send(event);
            // The invoked player remains gated inside boundary.callPlayer.
            // Return to the host only after the raw player call settles so it
            // can capture and persist the receipt before any actor output or
            // error reaches XState.
            await continuation.rawPlayerSettled.promise;
            return null;
          },
          completeEffectBoundary: deferredContinuationCompletionEvidence,
        });
        effectLedgerMirror = assertPlaybookEffectLedger(
          result.effectLedger,
          `${label} deferred continuation effect ledger`,
        );
        refreshRetainedEffectReconciliation(effectLedgerMirror);
        syncDeferredReconciliationOverlay();
        refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
        if (result.status !== 'continued') {
          if (continuationStarted) {
            deliverySettled = true;
            continuation.delivery.reject(
              markFsmResultFailure(
                new Error(`${label} deferred continuation remains unresolved`),
              ),
            );
            await waitForPlaybookQuiescence(actor!, {
              pendingCalls: nestedBridge,
            });
            if (controlPlaneError !== undefined) throw controlPlaneError;
          }
          expectedBoundPendingQuestion = undefined;
          settleDeferredInspectionBuffer(false);
          return 'unresolved';
        }
        const completed = effectLedgerMirror.boundaries.find(
          ({ boundaryId }) => boundaryId === effectBoundary.boundaryId,
        );
        if (
          completed?.physicalReceipt === undefined ||
          !isDeepStrictEqual(completed.physicalReceipt, result.receipt)
        ) {
          throw new TypeError(
            `${label} deferred continuation did not acknowledge its physical boundary`,
          );
        }
        recordActiveGovernedAttempt(completed);
        let settlement = governedSettlementsByBoundaryId.get(
          effectBoundary.boundaryId,
        );
        if (
          settlement === undefined &&
          continuation.result?.status === 'ok' &&
          !isEmptyFinalText(continuation.result.finalText)
        ) {
          settlement = unresolvedGovernedSettlement(
            'host omitted governed semantic settlement',
          );
        }
        assertAcknowledgedGovernedEvidence(
          completed,
          settlement,
          effectLedgerMirror,
        );
        governedSettlementsByBoundaryId.delete(effectBoundary.boundaryId);
        governedCompletionEvidenceByBoundaryId.delete(effectBoundary.boundaryId);
        if (
          settlement?.status === 'resolved' &&
          settlement.output.guard === 'needsBossReply' &&
          result.deferredStatus !== 'bound'
        ) {
          settlement = unresolvedGovernedSettlement(
            'deferred question did not receive an eligible durable binding',
          );
        }
        if (settlement?.status === 'unresolved') {
          unresolvedSemanticBoundaryIds.add(effectBoundary.boundaryId);
        } else if (settlement?.status === 'resolved') {
          unresolvedSemanticBoundaryIds.delete(effectBoundary.boundaryId);
        }
        if (result.logicalReceipt !== undefined) {
          const completedOperation = effectLedgerMirror.logicalOperations.find(
            ({ operationId }) => operationId === operation.operationId,
          );
          if (
            completedOperation?.logicalReceipt === undefined ||
            !isDeepStrictEqual(
              completedOperation.logicalReceipt,
              result.logicalReceipt,
            )
          ) {
            throw new TypeError(
              `${label} deferred continuation did not acknowledge its cumulative receipt`,
            );
          }
        }
        if (
          settlement?.status === 'resolved' &&
          settlement.output.guard === 'needsBossReply'
        ) {
          if (
            result.deferredStatus !== 'bound' &&
            result.deferredStatus !== 'unresolved'
          ) {
            throw new TypeError(
              `${label} repeated deferred settlement omitted its durable binding status`,
            );
          }
        } else if (
          settlement?.status === 'resolved' &&
          result.logicalReceipt === undefined
        ) {
          throw new TypeError(
            `${label} final deferred settlement omitted its cumulative receipt`,
          );
        }
        if (continuation.callError !== undefined) {
          deliverySettled = true;
          continuation.delivery.reject(continuation.callError);
        } else if (continuation.result === undefined) {
          deliverySettled = true;
          continuation.delivery.reject(
            markFsmResultFailure(
              new Error(`${label} deferred player returned no result`),
            ),
          );
        } else {
          if (settlement !== undefined) {
            governedPlayerSettlements.set(continuation.result, settlement);
          }
          // The bound answer authorizes exactly this one player call. Clear
          // its live delivery scope before XState can advance through a
          // nested call and invoke a later governed player in the same turn.
          activeDeferredContinuation = undefined;
          deliverySettled = true;
          continuation.delivery.resolve(continuation.result);
        }
        await waitForPlaybookQuiescence(actor!, {
          pendingCalls: nestedBridge,
        });
        if (controlPlaneError !== undefined) throw controlPlaneError;
        if (!hasUnresolvedReconciliation()) {
          validateBoundQuestionProjection();
          settleDeferredInspectionBuffer(true);
        } else {
          expectedBoundPendingQuestion = undefined;
          settleDeferredInspectionBuffer(false);
        }
        return 'continued';
      } catch (error) {
        let failure = error;
        governedSettlementsByBoundaryId.delete(effectBoundary.boundaryId);
        governedCompletionEvidenceByBoundaryId.delete(effectBoundary.boundaryId);
        if (continuationStarted && !deliverySettled) {
          deliverySettled = true;
          continuation.delivery.reject(error);
          try {
            await waitForPlaybookQuiescence(actor!, {
              pendingCalls: nestedBridge,
            });
          } catch (drainError) {
            failure = new AggregateError(
              [error, drainError],
              `${label} deferred continuation rejection and actor drain both failed`,
            );
          }
        }
        if (continuationStarted) {
          closeAfterIndeterminateDeferredSettlement(
            operation.operationId,
            failure,
          );
        }
        settleDeferredInspectionBuffer(false);
        throw failure;
      } finally {
        activeDeferredContinuation = undefined;
      }
    }

    function isExactDeferredBossReply(
      snapshot: unknown,
      event: EventObject,
      pending: PlaybookPendingBossQuestionContext,
    ): boolean {
      const candidate = event as {
        readonly type: string;
        readonly questionId?: unknown;
        readonly answer?: unknown;
      };
      return (
        candidate.type === 'BOSS_REPLY' &&
        (candidate.questionId === undefined ||
          candidate.questionId === pending.questionId) &&
        typeof candidate.answer === 'string' &&
        candidate.answer.trim().length > 0 &&
        snapshotCan(snapshot, event)
      );
    }

    async function parkBoundDeferredOperation(
      operationId: string,
      signal: AbortSignal,
    ): Promise<void> {
      if (repositoryCapability === undefined) {
        throw new Error(
          `${label} deferred parking requires repository.runDeferred`,
        );
      }
      const parked = await repositoryCapability.runDeferred({
        mode: 'park',
        signal,
        operationId,
      });
      if (parked.status !== 'parked') {
        throw new TypeError(
          `${label} repository refused to park its deferred operation`,
        );
      }
      effectLedgerMirror = assertPlaybookEffectLedger(
        parked.effectLedger,
        `${label} parked deferred effect ledger`,
      );
      refreshRetainedEffectReconciliation(effectLedgerMirror);
      syncDeferredReconciliationOverlay();
      refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
      if (deferredReconciliationOperationId !== operationId) {
        throw new TypeError(
          `${label} parked deferred operation is not structurally unresolved`,
        );
      }
    }

    async function restoreBoundDeferredOperation(
      operationId: string,
      signal: AbortSignal,
    ): Promise<'restored' | 'checkpoint-mismatch' | 'ineligible'> {
      if (repositoryCapability === undefined) {
        throw new Error(
          `${label} deferred restoration requires repository.runDeferred`,
        );
      }
      const restored = await repositoryCapability.runDeferred({
        mode: 'restore',
        signal,
        operationId,
      });
      if (restored.status === 'parked') {
        throw new TypeError(
          `${label} repository returned a park result for deferred restoration`,
        );
      }
      effectLedgerMirror = assertPlaybookEffectLedger(
        restored.effectLedger,
        `${label} restored deferred effect ledger`,
      );
      refreshRetainedEffectReconciliation(effectLedgerMirror);
      syncDeferredReconciliationOverlay();
      refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
      if (restored.status === 'restored') {
        if (deferredReconciliationOperationId !== undefined) {
          throw new TypeError(
            `${label} restored deferred operation remained unresolved`,
          );
        }
        const snapshot = actor!.getSnapshot();
        const state = normalizePlaybookSnapshot(snapshot);
        const context = ((snapshot as { context?: unknown }).context ??
          {}) as Record<string, unknown>;
        const pending = pendingBossQuestionForState(state, context);
        if (
          pending === undefined ||
          currentBoundDeferredOperation(pending)?.operationId !== operationId
        ) {
          throw new TypeError(
            `${label} restored deferred wait does not equal its FSM question`,
          );
        }
      } else if (deferredReconciliationOperationId !== operationId) {
        throw new TypeError(
          `${label} unresolved deferred restoration lost its operation identity`,
        );
      }
      return restored.status;
    }

    const runtime = {
      ...(retainedGenerationMetadata === undefined
        ? {}
        : { retainedGenerationMetadata }),
      async init(nextSession: PlaybookSession): Promise<void> {
        if (initialized || disposed || disposalPromise !== undefined) {
          throw new Error('createPlaybookRuntime.init: already initialized');
        }
        const boundSession = bindSession(nextSession);
        initialized = true;
        let finishInitialization!: () => void;
        const initialization = new Promise<void>((resolve) => {
          finishInitialization = resolve;
        });
        initInFlight = initialization;
        const initTask = (async () => {
          session = boundSession;
          syncDeferredReconciliationOverlay();
          refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
          savedPorts = boundSession.ports;
          runtimePorts = createRuntimePorts(boundSession.ports);
          suppressInspectionEmissions = false;
          actor = buildActor(runtimePorts);
          await emitTrace('session.started', stateTracePayload());
          actor.start();
          await drainEmissions();
        })();
        try {
          await initTask;
        } catch (error) {
          await cleanupFailedStart(error, { emitDisposal: true });
          throw error;
        } finally {
          finishInitialization();
          if (initInFlight === initialization) initInFlight = undefined;
        }
      },

      // DR-014 §1 / DR-031 §5 / PBRT-45: JSON-safe capture of a parked
      // session, including one already-started suspended nested call.
      // Defined only at a safe capture point — initialized, not disposing
      // or disposed, no active public boundary, and the actor quiescent with
      // status `active`.
      exportSnapshot(): PlaybookRuntimeSnapshot | undefined {
        if (!actor || !session || disposed || disposalPromise !== undefined) {
          return undefined;
        }
        if (activeSignal !== undefined) return undefined;
        if (deferredSettlementClosure !== undefined) return undefined;
        const pendingCall = nestedBridge.getPendingCall();
        const bridgeSuspendedCall = nestedBridge.getSuspendedCall();
        if ((pendingCall === undefined) !== (bridgeSuspendedCall === undefined)) {
          return undefined;
        }
        let suspendedCall: typeof bridgeSuspendedCall;
        if (bridgeSuspendedCall !== undefined) {
          if (
            pendingCall?.callId !== bridgeSuspendedCall.callId ||
            pendingCall?.playbookId !== bridgeSuspendedCall.playbookId ||
            pendingCall?.childSessionId !== bridgeSuspendedCall.childSessionId
          ) {
            return undefined;
          }
          if (!playbookCallTurnIds.has(bridgeSuspendedCall.callId)) {
            return undefined;
          }
          const turnId = playbookCallTurnIds.get(bridgeSuspendedCall.callId);
          if (
            bridgeSuspendedCall.turnId !== undefined &&
            bridgeSuspendedCall.turnId !== turnId
          ) {
            return undefined;
          }
          suspendedCall = {
            ...bridgeSuspendedCall,
            ...(turnId === undefined ? {} : { turnId }),
            ...(hasGovernedPlayerStates
              ? {
                  effectBoundaryPrefixSequence:
                    playbookCallEffectPrefixes.get(
                      bridgeSuspendedCall.callId,
                    ) ?? null,
                }
              : {}),
          };
        }
        const state = currentState();
        if (state.status !== 'active' || !state.quiescent) return undefined;
        const machineSnapshot = detachPersistedMachineSnapshot(
          actor.getPersistedSnapshot(),
        );
        const context = (actor.getSnapshot() as { context?: unknown })
          .context as Record<string, unknown>;
        effectLedgerMirror = currentEffectLedger();
        refreshRetainedEffectReconciliation(effectLedgerMirror);
        syncDeferredReconciliationOverlay();
        refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
        const pending =
          !hasUnresolvedReconciliation()
            ? pendingBossQuestionForState(state, context ?? {})
            : undefined;
        const failedEffectAttempt =
          hasGovernedPlayerStates &&
          state.stateId === 'failed' &&
          failedAttemptMatchesCurrentLedger(effectLedgerMirror)
            ? {
                boundaryPrefix: failedEffectBoundaryPrefix!,
                attemptId: failedGovernedAttemptId ?? null,
              }
            : undefined;
        return {
          schemaVersion: 4,
          playbookId: session.playbookId,
          machine: machineSnapshot,
          roleResumeTokens: snapshotRoleResumeTokens(),
          sequences: {
            trace: traceSequence,
            turn: turnSequence,
            judgeCall: judgeCallSequence,
            playerCall: playerCallSequence,
            playbookCall: playbookCallSequence,
            ...(declaredActors.has('captain')
              ? { captainCall: captainCallSequence }
              : {}),
          },
          state,
          pendingBossQuestions:
            pending === undefined
              ? []
              : [
                  {
                    questionId: pending.questionId,
                    asker: pending.asker,
                    question: pending.question,
                    sourceItem: pending.sourceItem,
                  },
                ],
          effectLedger: effectLedgerMirror,
          ...(retainedEffectSourceSessionId === undefined
            ? {}
            : { retainedEffectSourceSessionId }),
          ...(retainedEffectReconciliation === undefined
            ? {}
            : { retainedEffectReconciliation }),
          ...(failedEffectAttempt === undefined
            ? {}
            : { failedEffectAttempt }),
          ...(suspendedCall === undefined ? {} : { suspendedCall }),
        };
      },

      // DR-014 §1 / PBRT-45: alternative to `init` that rehydrates an
      // exported snapshot under the same immutable session identity.
      // Emits no `session.started`, transition trace, or human status —
      // the session already started; the next public boundary continues
      // the contiguous trace sequence.
      async restore(
        nextSession: PlaybookSession,
        snapshot: PlaybookRuntimeSnapshot,
      ): Promise<void> {
        await rehydrateSnapshot('restore', nextSession, snapshot);
      },

      // DR-038 §§1,5 / PBRT-61/PBRT-65: adoption is restore under a fresh
      // engagement identity and counter lineage, exposed separately so
      // capability-less bespoke runtimes can omit it. Runtime-visible
      // preflight mismatches reject before effects; after preflight the new
      // session.started boundary owns failed-start cleanup just like init.
      async adopt(
        nextSession: PlaybookSession,
        snapshot: PlaybookRuntimeSnapshot,
        context: PlaybookAdoptionContext,
      ): Promise<void> {
        await rehydrateSnapshot('adopt', nextSession, snapshot, context);
      },

      // DR-029 / PBRT-52: side-effect-free control view over the live
      // snapshot, valid at parked quiescence outside an active boundary.
      // The view is detached and frozen; producing it emits nothing and
      // moves nothing.
      describe(): PlaybookControlView {
        if (disposed || disposalPromise !== undefined) {
          throw new Error(
            'createPlaybookRuntime.describe: runtime is disposing or disposed',
          );
        }
        if (!actor || !savedPorts) {
          throw new Error(
            'createPlaybookRuntime.describe: init must be called first',
          );
        }
        if (activeSignal !== undefined) {
          throw new Error(
            'createPlaybookRuntime.describe: another runtime turn is active',
          );
        }
        assertDeferredSettlementOpen('describe');
        refreshRetainedEffectFenceFromHost();
        const snapshot = actor.getSnapshot();
        const state = currentState();
        const context = ((snapshot as { context?: unknown }).context ??
          {}) as Record<string, unknown>;
        const pending =
          !hasUnresolvedReconciliation()
            ? pendingBossQuestionForState(state, context)
            : undefined;
        const lastError = normalizeErrorFull(context.lastError);
        const projectedContext = projectControlContext(context);
        const stateDescription =
          !hasUnresolvedReconciliation()
            ? stateDescriptionFor(state)
            : undefined;
        return deepFreeze({
          state,
          ...(stateDescription === undefined ? {} : { stateDescription }),
          ...(projectedContext !== undefined
            ? { context: projectedContext }
            : {}),
          pendingQuestions:
            pending === undefined
              ? []
              : [
                  {
                    questionId: pending.questionId,
                    asker: pending.asker,
                    question: pending.question,
                    sourceItem: pending.sourceItem,
                  },
                ],
          ...(lastError !== undefined ? { lastError } : {}),
          actions: deriveControlActions(snapshot).map(({ action }) => action),
        });
      },

      // DR-029 / PBRT-52: revalidate the named action against the live
      // state and execute it at most once per idempotency key. The receipt
      // discriminates rejected-before-any-effect from executed and from
      // failed-after-effects-may-exist; a repeated key returns the recorded
      // receipt without re-execution. A rejection settles before acceptance,
      // so — like a key whose call threw before reaching acceptance — it
      // records nothing and the key may execute later, once the action is
      // advertised.
      async apply(input: {
        actionId: string;
        key: string;
        signal: AbortSignal;
      }): Promise<PlaybookControlReceipt> {
        if (input === null || typeof input !== 'object') {
          throw new TypeError(
            'createPlaybookRuntime.apply: input must be an object',
          );
        }
        assertDeferredSettlementOpen('apply');
        const { actionId, key, signal } = input;
        if (typeof actionId !== 'string' || actionId.length === 0) {
          throw new TypeError(
            'createPlaybookRuntime.apply: actionId must be a non-empty string',
          );
        }
        if (typeof key !== 'string' || key.length === 0) {
          throw new TypeError(
            'createPlaybookRuntime.apply: key must be a non-empty string',
          );
        }
        if (!(signal instanceof AbortSignal)) {
          throw new TypeError(
            'createPlaybookRuntime.apply: signal must be an AbortSignal',
          );
        }
        if (disposed || disposalPromise !== undefined) {
          throw new Error(
            'createPlaybookRuntime.apply: runtime is disposing or disposed',
          );
        }
        if (!actor || !savedPorts) {
          throw new Error(
            'createPlaybookRuntime.apply: init must be called first',
          );
        }
        if (activeSignal !== undefined) {
          throw new Error(
            'createPlaybookRuntime.apply: another runtime turn is active',
          );
        }
        // Settlement is final: a repeated key returns the recorded receipt
        // with no revalidation, no execution, and no new trace pair.
        const recorded = appliedReceipts.get(key);
        if (recorded !== undefined) return recorded;
        // An abort before acceptance ends the call with no receipt
        // recorded, like every other pre-acceptance failure.
        signal.throwIfAborted();
        refreshRetainedEffectFenceFromHost();

        const turnId = ++turnSequence;
        const callId = `apply-${++applyCallSequence}`;
        const position: TracePosition = { turnId, callId };
        activeTurnId = turnId;
        beginAutomaticReplayBoundary();
        activeSignal = signal;
        activeAborts = abortReasonClassifier(signal);
        activeAbortEmission = undefined;
        controlPlaneError = undefined;
        // Every receipt variant is normalized and frozen where it is built,
        // inside the guarded region, so the recording step below cannot
        // throw after effects exist.
        const settledReceipt = (
          value: PlaybookControlReceipt,
        ): PlaybookControlReceipt =>
          deepFreeze(
            snapshotJsonValue(
              value,
              'apply receipt',
            ) as unknown as PlaybookControlReceipt,
          );
        let receipt: PlaybookControlReceipt | undefined;
        let operationError: unknown;
        let settlementError: unknown;
        // Acceptance is the line past which this boundary owes a receipt and
        // can no longer signal by throwing: the action may have run, and a
        // caller that gets an exception instead of a receipt is left with an
        // executed effect it cannot record and a key it will not reuse.
        let accepted = false;
        // Publication is the second line this boundary respects. Before it,
        // nothing has left the runtime: a settlement failure past acceptance
        // is a post-acceptance control-plane error PBRT-52 settles as the
        // `failed` receipt, and folding it in replaces the receipt recorded
        // at acceptance so the finish trace, the returned receipt, and any
        // replay of the key all report one settlement. Past publication that
        // agreement is no longer achievable — the disposition is already on
        // the wire — so the fold refuses to run, by construction rather than
        // by call ordering. Only the first settlement error is latched, so
        // one fold is all there is to do.
        let folded = false;
        let published = false;
        const foldSettlementFailure = (): void => {
          if (published || !accepted || folded) return;
          if (settlementError === undefined) return;
          folded = true;
          receipt = settledReceipt({
            disposition: 'failed',
            error: normalizeError(settlementError),
          });
          appliedReceipts.set(key, receipt);
        };
        // A settlement failure that lands after the receipt is published says
        // nothing about the effect: the action ran, the caller's receipt is
        // true, and only the telemetry delivery failed. Rewriting `executed`
        // to `failed` there would make the runtime lie to its only caller
        // about work that succeeded, irrecoverably — accepted receipts are
        // final for their key. Past publication such a failure is therefore
        // re-latched onto the emission channel, surfacing from the next
        // public boundary's drain, and `apply` still does not throw past
        // acceptance (PBRT-52). A delivery rejection causally identical to
        // this call's own abort reason evidences the cancellation and is
        // dropped — never carried to a later unrelated boundary
        // (slc/link.md §Abort).
        const latchDeliveryFailure = (error: unknown): void => {
          if (isAbortFailure(error, signal)) return;
          emissionFailure ??= { error };
        };
        try {
          try {
            const identity = {
              actionId,
              key,
              ...stateIdentity(currentState().stateId),
            };
            // Every apply finish carries the receipt disposition and no
            // start-only field — `stateId` is on the start alone
            // (slc/link.md §Playbook trace). Both finishes reachable
            // before acceptance settle with no effect behind them, so both
            // carry the canonical `rejected` disposition and the reason
            // that ended the call, alongside the transport marker.
            const preAcceptanceFinish = (
              reason: string,
            ): Record<string, unknown> => ({
              actionId,
              key,
              ...receiptTracePayload({ disposition: 'rejected', reason }),
            });
            await emitCallStarted(
              'apply.started',
              'apply.finished',
              identity,
              position,
              signal,
              preAcceptanceFinish('apply.started trace sink rejected'),
            );
            // An abort may land while the awaited started emission drains
            // (e.g. fired from the trace sink itself); the action must
            // never execute after abort. Settle the already-started pair
            // as `aborted` — carrying the canonical rejected-before-any-
            // effect receipt disposition required of every apply finish —
            // and end the call pre-acceptance: no receipt is recorded and
            // the key stays free.
            if (signal.aborted) {
              try {
                await emitTrace(
                  'apply.finished',
                  {
                    ...preAcceptanceFinish('aborted before acceptance'),
                    status: 'aborted',
                    error: normalizeError(signal.reason),
                  },
                  position,
                );
              } catch (error) {
                // A rejecting finish sink surfaces at the boundary like
                // any settlement failure (see the precedence below).
                settlementError ??= error;
              }
              signal.throwIfAborted();
            }
            const snapshot = actor.getSnapshot();
            const candidate = deriveControlActions(snapshot).find(
              ({ action }) => action.id === actionId,
            );
            if (candidate === undefined) {
              receipt = settledReceipt({
                disposition: 'rejected',
                reason: `action ${JSON.stringify(
                  actionId,
                )} is not currently advertised`,
              });
            } else {
              // Acceptance: from here every outcome records a receipt under
              // the key, so the action can never execute twice.
              accepted = true;
              try {
                let run: PlaybookRunResult;
                if (candidate.unresolvedEffectAction === 'abandon') {
                  signal.throwIfAborted();
                  run = runResultFor('unresolved-effect');
                } else if (
                  candidate.unresolvedEffectAction === 'reconcile'
                ) {
                  if (candidate.deferredRestoreOperationId !== undefined) {
                    await restoreBoundDeferredOperation(
                      candidate.deferredRestoreOperationId,
                      signal,
                    );
                  } else {
                    // Receipt reconstruction itself belongs to the host. The
                    // runtime may only re-read that authoritative mirror; it
                    // never replays a player to manufacture missing evidence.
                    refreshRetainedEffectFenceFromHost();
                  }
                  signal.throwIfAborted();
                  run = runResultFor(
                    hasUnresolvedReconciliation()
                      ? 'no-action'
                      : 'quiescent',
                  );
                } else {
                  actor.send(candidate.event!);
                  await waitForPlaybookQuiescence(actor, {
                    pendingCalls: nestedBridge,
                  });
                  run = runResultFor(settledOutcome(signal));
                }
                if (controlPlaneError !== undefined) throw controlPlaneError;
                receipt = settledReceipt(
                  run.outcome === 'failed' || run.outcome === 'aborted'
                    ? {
                        disposition: 'failed',
                        error:
                          ('error' in run ? run.error : undefined) ??
                          normalizeError(
                            new Error(
                              `apply settled with outcome ${run.outcome}`,
                            ),
                          ),
                      }
                    : { disposition: 'executed', run },
                );
              } catch (error) {
                // Effects may exist: a post-acceptance failure is the
                // receipt, not a control-plane rejection (DR-029).
                receipt = settledReceipt({
                  disposition: 'failed',
                  error: normalizeError(error),
                });
              }
            }
          } catch (error) {
            operationError = error; // pre-acceptance: no receipt is recorded
          }

          // Record acceptance before the settlement emissions, so a crash
          // between acceptance and settlement can never re-execute the
          // action: the recorded receipt survives and a replayed key
          // returns it. A rejection settled before acceptance: it is
          // returned and traced but never recorded, so its key stays free
          // to execute once the action is advertised.
          if (receipt !== undefined && receipt.disposition !== 'rejected') {
            appliedReceipts.set(key, receipt);
          }
          try {
            await drainEmissions();
          } catch (error) {
            settlementError = error;
          }
          // Exact cancellation is not a control-plane latch, but after apply
          // acceptance and before publication it is still settlement evidence
          // and therefore folds into the owed failed receipt (DR-036 §4).
          settlementError ??= activeAbortEmission;
          // Fold before the finish emission, the last point at which the
          // traced disposition and the returned one can still be made the
          // same value.
          foldSettlementFailure();
          if (receipt !== undefined) {
            // Publication: this disposition is now the settlement, for the
            // trace, for the caller, and for every replay of the key.
            published = true;
            try {
              await emitTrace(
                'apply.finished',
                { actionId, key, ...receiptTracePayload(receipt) },
                position,
              );
            } catch (error) {
              if (accepted) latchDeliveryFailure(error);
              else settlementError ??= error;
            }
            // Drain even when the finish emission rejected, so this call
            // leaves no queued emission behind it. Before acceptance the
            // failure is consumed and thrown, as every pre-acceptance failure
            // is; past it the failure is re-latched instead — the effect
            // happened, so the delivery failure travels on the emission
            // channel to the next boundary rather than rewriting what
            // happened or vanishing here.
            try {
              await drainEmissions();
            } catch (error) {
              if (accepted) latchDeliveryFailure(error);
              else settlementError ??= error;
            }
          }
        } finally {
          // Always release the boundary sentinel, even on a path no
          // constructible input reaches today, so a defect here can never
          // wedge every later public boundary behind "another runtime turn
          // is active".
          activeSignal = undefined;
          activeAborts = undefined;
          activeAbortEmission = undefined;
          activeTurnId = undefined;
          activeGovernedBoundarySeen = false;
          activeGovernedAttemptId = undefined;
          activeEffectLedgerPrefixSequence = undefined;
          controlPlaneError = undefined;
        }
        // Past acceptance every settlement failure has been folded into the
        // receipt, so nothing is left to throw and the caller always leaves
        // with the settlement of the effect it may have caused (PBRT-52).
        if (accepted && receipt !== undefined) return receipt;
        // Before acceptance no effect exists and no receipt is owed, so a
        // failure still surfaces by throwing. Settlement failures (a
        // rejecting finish sink, a drain-latched emission failure) outrank
        // the operation error, matching the `drainError ?? operationError`
        // precedence of the other public boundaries. A start-sink failure is
        // unaffected: its latched drain error is the start error itself.
        const failure = settlementError ?? operationError;
        if (failure !== undefined) throw failure;
        if (receipt === undefined) {
          throw new Error(
            'createPlaybookRuntime.apply: no receipt was produced',
          );
        }
        return receipt;
      },

      unresolvedEffectEnvelopes: unresolvedEffectEnvelopeIdentities,

      async handleBossInput({
        text,
        signal,
      }: {
        text: string;
        signal: AbortSignal;
      }): Promise<PlaybookRunResult> {
        if (!actor || !savedPorts) {
          throw new Error(
            'createPlaybookRuntime.handleBossInput: init must be called first',
          );
        }
        if (disposed || disposalPromise !== undefined) {
          throw new Error(
            'createPlaybookRuntime.handleBossInput: runtime is disposing or disposed',
          );
        }
        if (activeSignal !== undefined) {
          throw new Error(
            'createPlaybookRuntime.handleBossInput: another runtime turn is active',
          );
        }
        assertDeferredSettlementOpen('handleBossInput');
        refreshRetainedEffectFenceFromHost();
        const turnId = ++turnSequence;
        activeTurnId = turnId;
        beginAutomaticReplayBoundary();
        activeSignal = signal;
        activeAborts = abortReasonClassifier(signal);
        activeAbortEmission = undefined;
        controlPlaneError = undefined;
        let result: PlaybookRunResult | undefined;
        let operationError: unknown;
        // The boundary sentinel releases on every exit: a settlement defect
        // past the drain — a snapshot normalization throw inside
        // `runResultFor` included — must never wedge every later public
        // boundary and `dispose` itself behind "another runtime turn is
        // active". Mirrors the apply boundary's finally.
        try {
          try {
            await emitTrace('boss.input.received', { text }, { turnId });
            // Record the attempted input, then refuse a boundary that entered
            // aborted before deterministic mapping or the classifier can
            // perform host-visible work (DR-036 §5).
            signal.throwIfAborted();
            // 1. Map the Boss text to an FSM event: deterministic exact entry
            //    where applicable (slc/link.md §Boss-event mapping), judge
            //    classification otherwise.
            let event: EventObject | undefined;
            let classifiedSnapshot: unknown;
            let deferredPending:
              | PlaybookPendingBossQuestionContext
              | undefined;
            let deferredOperation: PlaybookEffectLogicalOperation | undefined;
            let pendingRequiresDeferredBinding = false;
            const trimmed = text.trim();
            if (trimmed !== '') {
              const snapshot = actor.getSnapshot();
              classifiedSnapshot = snapshot;
              const terminal = snapshot.status === 'done';
              const stateId = normalizePlaybookSnapshot(snapshot).stateId;
              const snapshotContext = ((snapshot as { context?: unknown })
                .context ?? {}) as Record<string, unknown>;
              deferredPending = pendingBossQuestionForState(
                normalizePlaybookSnapshot(snapshot),
                snapshotContext,
              );
              pendingRequiresDeferredBinding =
                deferredPending !== undefined &&
                outcomeAuthority?.governedPlayerStates[
                  deferredPending.resumeStateId
                ]?.needsBossReply?.repositoryDisposition === 'deferred';
              deferredOperation =
                !pendingRequiresDeferredBinding
                  ? undefined
                  : currentBoundDeferredOperation(deferredPending!);
              // PBRT-1 / slc/link.md §Boss-event mapping: the idle entry, the
              // recoverable failure state, and the reconstructed terminal all
              // accept exactly one ordinary textual entry event, so delivered
              // text enters deterministically — no judge call to spend and no
              // classifier whim to settle a restart as no action. Every other
              // parked state — a reply wait or an authored mid-workflow
              // checkpoint — classifies under its own Boss-event contracts.
              if (
                hasUnresolvedReconciliation()
              ) {
                event = undefined;
              } else if (
                stateId === 'failed' &&
                !failedAttemptAllowsReplay()
              ) {
                event = undefined;
              } else if (
                spec.entryEvent !== undefined &&
                (stateId === 'ready' || stateId === 'failed' || terminal)
              ) {
                event = {
                  type: spec.entryEvent.type,
                  [spec.entryEvent.textField]: text,
                };
              } else {
                event = await classifyBossText(
                  text,
                  runtimePorts!,
                  signal,
                  snapshot,
                  boundary,
                  boundOptions,
                );
              }
              signal.throwIfAborted();
            }
            if (
              event !== undefined &&
              deferredPending !== undefined &&
              pendingRequiresDeferredBinding &&
              deferredOperation === undefined &&
              hasGovernedPlayerStates &&
              deferredReconciliationOperationId === undefined
            ) {
              throw new Error(
                `${label} pending governed Boss question has no durable logical operation`,
              );
            }
            let handledDeferred = false;
            if (
              event !== undefined &&
              classifiedSnapshot !== undefined &&
              deferredPending !== undefined &&
              deferredOperation !== undefined
            ) {
              if (
                isExactDeferredBossReply(
                  classifiedSnapshot,
                  event,
                  deferredPending,
                )
              ) {
                const statusLine = classificationStatus(event);
                const continuation = await continueBoundDeferredOperation(
                  deferredOperation,
                  event,
                  signal,
                  turnId,
                  statusLine,
                );
                if (continuation === 'continued') {
                  try {
                    lastBossEvent = snapshotJsonValue(
                      event,
                      'recorded Boss event',
                    ) as unknown as EventObject;
                  } catch {
                    lastBossEvent = undefined;
                  }
                  if (controlPlaneError !== undefined) {
                    throw controlPlaneError;
                  }
                  result = runResultFor(
                    !hasUnresolvedReconciliation()
                      ? settledOutcome(signal)
                      : 'no-action',
                  );
                } else {
                  lastBossEvent = undefined;
                  result = runResultFor('no-action');
                }
                handledDeferred = true;
              } else if (event.type === 'BOSS_REPLY') {
                // A malformed, empty, or mismatched answer does not consume
                // the durable wait and starts no repository or player work.
                event = undefined;
              } else {
                await parkBoundDeferredOperation(
                  deferredOperation.operationId,
                  signal,
                );
                lastBossEvent = undefined;
                result = runResultFor('no-action');
                handledDeferred = true;
              }
            }
            // Empty input, no-action classifier output, or invalid classifier
            // output — nothing to send.
            if (handledDeferred) {
              // The deferred host transaction already decided whether the
              // authored continuation ran; never send its event a second time.
            } else if (event === undefined) {
              result = runResultFor('no-action');
            } else {
              // 2. Optional Captain-pane classification line: the bare FSM
              //    event type, emitted before the FSM advances.
              const statusLine = classificationStatus(event);
              if (statusLine !== undefined) {
                await runtimePorts!.emitStatus(statusLine);
              }
              signal.throwIfAborted();
              // 3. A final actor cannot accept new events; reconstruct only
              //    after classification produced a real event.
              if (actor.getSnapshot().status === 'done') {
                stopActor();
                actor = buildActor(runtimePorts!);
                // The replacement actor's snapshots are real state entries.
                suppressInspectionEmissions = false;
                actor.start();
              }
              // DR-029: keep the classified event with its recorded payload
              // as the retry-replay source. Recording is sanitizing, not
              // load-bearing: an override classifier's non-JSON-safe event is
              // simply not recorded, and the turn proceeds unchanged.
              try {
                lastBossEvent = snapshotJsonValue(
                  event,
                  'recorded Boss event',
                ) as unknown as EventObject;
              } catch {
                lastBossEvent = undefined;
              }
              actor.send(event);
              await waitForPlaybookQuiescence(actor, {
                pendingCalls: nestedBridge,
              });
              if (controlPlaneError !== undefined) throw controlPlaneError;
              result = runResultFor(settledOutcome(signal));
            }
          } catch (error) {
            operationError = error;
          }

          let drainError: unknown;
          try {
            await drainEmissions();
          } catch (error) {
            drainError = error;
          }
          const latchedControlError = controlPlaneError;
          // A drain rejection that is the exact abort reason evidences the
          // cancellation, not a control-plane failure (slc/link.md §Abort).
          const drainAbort =
            drainError !== undefined && isAbortFailure(drainError, signal);
          const effectiveDrainError = drainAbort ? undefined : drainError;
          const primaryError =
            latchedControlError ?? effectiveDrainError ?? operationError;
          const abortError =
            latchedControlError === undefined &&
            effectiveDrainError === undefined &&
            ((operationError !== undefined &&
              isAbortFailure(operationError, signal)) ||
              (drainAbort && operationError === undefined));
          // A deferred continuation whose actor advanced before the host's
          // completion write became authoritative has no safe public FSM
          // settlement. The durable uncertain record is the only recovery
          // source, so do not project the actor's advanced snapshot into a
          // `boss.input.settled` event.
          const settlementResult =
            deferredSettlementClosure !== undefined
              ? undefined
              : primaryError === undefined
                ? (result ?? runResultFor('no-action'))
                : runResultFor(
                    abortError ? 'aborted' : 'failed',
                    primaryError,
                  );

          let settlementEmissionError: unknown;
          if (settlementResult !== undefined) {
            try {
              await emitTrace(
                'boss.input.settled',
                settlementTracePayload(settlementResult),
                { turnId },
              );
            } catch (error) {
              settlementEmissionError = error;
            }
          }
          try {
            await drainEmissions();
          } catch (error) {
            settlementEmissionError ??= error;
          }
          if (
            settlementEmissionError !== undefined &&
            isAbortFailure(settlementEmissionError, signal)
          ) {
            settlementEmissionError = undefined;
          }
          const failure =
            controlPlaneError ??
            latchedControlError ??
            effectiveDrainError ??
            (abortError
              ? (settlementEmissionError ?? operationError)
              : (operationError ?? settlementEmissionError));

          if (
            failure !== undefined &&
            !(abortError && settlementEmissionError === undefined)
          ) {
            throw failure;
          }
          if (settlementResult === undefined) {
            throw deferredSettlementClosure;
          }
          return settlementResult;
        } finally {
          activeSignal = undefined;
          activeAborts = undefined;
          activeAbortEmission = undefined;
          activeTurnId = undefined;
          activeGovernedBoundarySeen = false;
          activeGovernedAttemptId = undefined;
          activeEffectLedgerPrefixSequence = undefined;
          controlPlaneError = undefined;
        }
      },

      async resumePlaybookCall(input: {
        callId: string;
        result: PlaybookCallResult;
        signal: AbortSignal;
      }): Promise<PlaybookRunResult> {
        if (!actor || !savedPorts) {
          throw new Error(
            'createPlaybookRuntime.resumePlaybookCall: init must be called first',
          );
        }
        if (disposed || disposalPromise !== undefined) {
          throw new Error(
            'createPlaybookRuntime.resumePlaybookCall: runtime is disposing or disposed',
          );
        }
        if (activeSignal !== undefined) {
          throw new Error(
            'createPlaybookRuntime.resumePlaybookCall: another runtime turn is active',
          );
        }
        refreshRetainedEffectFenceFromHost();
        if (hasUnresolvedReconciliation()) {
          return runResultFor('no-action');
        }
        activeTurnId = playbookCallTurnIds.get(input.callId);
        bindAutomaticReplayBoundary(
          playbookCallEffectPrefixes.has(input.callId)
            ? playbookCallEffectPrefixes.get(input.callId)
            : hasGovernedPlayerStates
              ? 0
              : undefined,
        );
        activeSignal = input.signal;
        activeAborts = abortReasonClassifier(input.signal);
        activeAbortEmission = undefined;
        controlPlaneError = undefined;
        // The boundary sentinel releases on every exit, mirroring
        // `handleBossInput` and the apply boundary.
        try {
          let result: PlaybookRunResult | undefined;
          let operationError: unknown;
          try {
            await nestedBridge.resume(input);
          } catch (error) {
            operationError = error;
          }
          try {
            await waitForPlaybookQuiescence(actor, {
              pendingCalls: nestedBridge,
            });
            result = runResultFor(settledOutcome(input.signal));
          } catch (error) {
            operationError ??= error;
          }
          // A resume refused because its signal was already aborted
          // delivers nothing: the pending call survives for a later
          // resume, and the boundary settles `aborted` rather than
          // advertising `suspended` (slc/link.md §Nested playbook bridge).
          if (
            operationError !== undefined &&
            isAbortFailure(operationError, input.signal) &&
            nestedBridge.getPendingCall()?.callId === input.callId
          ) {
            result = {
              outcome: 'aborted',
              state: currentState(),
              error: normalizeError(input.signal.reason),
            };
          }
          let drainError: unknown;
          try {
            await drainEmissions();
          } catch (error) {
            drainError = error;
          }
          const aborts = activeAborts ?? abortReasonClassifier(input.signal);
          // A control-plane latch has already classified its failure as
          // distinct under the owning operation. Never reinterpret it
          // against this later resume signal (DR-036 decision 2).
          const controlFailure = controlPlaneError;
          const drainAbort =
            controlFailure === undefined &&
            drainError !== undefined &&
            aborts.isAbortReason(drainError);
          const operationAbort =
            controlFailure === undefined &&
            operationError !== undefined &&
            aborts.isAbortReason(operationError);
          const abortEvidence =
            activeAbortEmission ??
            (drainAbort ? drainError : undefined) ??
            (operationAbort ? operationError : undefined);
          const failure =
            controlFailure ??
            (drainAbort ? undefined : drainError) ??
            (operationAbort ? undefined : operationError);
          if (failure !== undefined) throw failure;
          if (
            abortEvidence !== undefined &&
            result?.outcome !== 'terminal' &&
            result?.outcome !== 'suspended'
          ) {
            result = runResultFor('aborted', abortEvidence);
          }
          if (result === undefined) {
            throw new Error('playbook resume produced no runtime result');
          }
          return result;
        } finally {
          activeSignal = undefined;
          activeAborts = undefined;
          activeAbortEmission = undefined;
          activeTurnId = undefined;
          activeGovernedBoundarySeen = false;
          activeGovernedAttemptId = undefined;
          activeEffectLedgerPrefixSequence = undefined;
          controlPlaneError = undefined;
        }
      },

      dispose(): Promise<void> {
        if (disposalPromise !== undefined) return disposalPromise;
        if (disposed) return Promise.resolve();
        if (activeSignal !== undefined) {
          return Promise.reject(
            new Error(
              'createPlaybookRuntime.dispose: cannot dispose during an active runtime boundary',
            ),
          );
        }
        const task = (async (): Promise<void> => {
          const failures: unknown[] = [];
          try {
            if (initInFlight !== undefined) {
              try {
                await initInFlight;
              } catch {
                // Dispose still releases whatever an unsuccessful init bound.
              }
            }
            const finalState = actor ? currentState() : undefined;
            // Stop the root before settling a suspended child. Its rejection
            // must not re-enter the FSM and start fresh work during disposal.
            // `stopActor` suppresses inspection first, so the stop snapshot
            // adds nothing beside the `session.disposed` trace below (PBRT-6).
            stopActor();
            try {
              await nestedBridge.dispose();
            } catch (error) {
              failures.push(error);
            }
            try {
              await drainEmissions();
            } catch (error) {
              failures.push(error);
            }
            if (session !== undefined) {
              try {
                await emitTrace(
                  'session.disposed',
                  finalState === undefined
                    ? {}
                    : {
                        state: finalState,
                        ...stateIdentity(finalState.stateId),
                      },
                );
                await drainEmissions();
              } catch (error) {
                failures.push(error);
              }
            }
          } finally {
            // A composing host owns the shared store for the complete root
            // engagement tree. Child disposal must not erase a token its
            // caller will resume. The private fallback remains runtime-owned.
            if (session?.playerSessions === undefined) {
              privateResumeTokens.clear();
            }
            activePlayerKeys.clear();
            playbookCallTurnIds.clear();
            playbookCallEffectPrefixes.clear();
            activeEmissionCalls.clear();
            emissionQueue.clear();
            judgeQueue.clear();
            appliedReceipts.clear();
            actor = undefined;
            activeSignal = undefined;
            activeAborts = undefined;
            actorSettlementAborts = undefined;
            actorSettlementErrorAborts = undefined;
            activeAbortEmission = undefined;
            activeTurnId = undefined;
            activeGovernedBoundarySeen = false;
            activeGovernedAttemptId = undefined;
            activeEffectLedgerPrefixSequence = undefined;
            failedGovernedAttemptUnknown = false;
            failedEffectBoundaryPrefix = undefined;
            failedGovernedAttemptId = undefined;
            controlPlaneError = undefined;
            emissionFailure = undefined;
            lastBossEvent = undefined;
            retainedEffectSourceSessionId = undefined;
            retainedEffectReconciliation = undefined;
            retainedEffectReconciliationRequired = false;
            reconstructedGovernedDelivery = undefined;
            reconstructedGovernedPrefixSequence = undefined;
            reconstructedAcceptancePending = undefined;
            governedSettlementsByBoundaryId.clear();
            governedCompletionEvidenceByBoundaryId.clear();
            unresolvedSemanticBoundaryIds.clear();
            deferredReconciliationOperationId = undefined;
            deferredSettlementClosure = undefined;
            expectedBoundPendingQuestion = undefined;
            activeDeferredContinuation = undefined;
            deferInspectionEmissions = false;
            deferredInspectionEmissions = [];
            savedPorts = undefined;
            runtimePorts = undefined;
            session = undefined;
            disposed = true;
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(
              failures,
              'playbook runtime disposal failed',
            );
          }
        })();
        disposalPromise = task;
        return task;
      },

      // @internal — test-only escape hatches for inspecting the underlying
      // actor, traced boundary, and nested bridge. Not part of the stable
      // public runtime contract.
      _getActor() {
        return actor;
      },
      _getBoundary() {
        return boundary;
      },
      _getNestedBridge() {
        return nestedBridge;
      },
    };
    return runtime as PlaybookRuntime;
  };
  Object.defineProperty(createPlaybookRuntime, 'compat', {
    value: Object.freeze({ artifactSchema, runtimeAbi: RUNTIME_ABI }),
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return createPlaybookRuntime as XStatePlaybookRuntimeFactory<
    XStatePlaybookRuntimeFactoryOptions<TOptions, THostCapabilities>
  >;
}
