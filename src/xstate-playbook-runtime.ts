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
import { assertPlaybookFailureCause } from './runtime.js';
import {
  assertPlaybookRuntimeSnapshot,
  assertPlaybookEffectLedger,
  attachPlaybookFailureCause,
  combineAbortSignals,
  createNestedPlaybookBridge,
  detachPersistedMachineSnapshot,
  normalizeError,
  normalizePlaybookSnapshot,
  snapshotJsonValue,
  snapshotPlaybookSession,
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
  NormalizedError,
  PlaybookEffectLogicalOperation,
  PlaybookFailureCause,
  PlaybookPendingBossQuestion,
  PlaybookPendingCall,
  PlaybookStepRecord,
  PlaybookPorts,
  PlaybookRepositoryReceipt,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
  PlaybookSuspendedCall,
  PlaybookTerminalOutcome,
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
  /**
   * DR-063 §2: decorate the failure the bridge builds for a non-`ok` result
   * with the cause the boundary decided at the call itself, where the role,
   * the resolved player, and the reported error are known.
   */
  markPlayerResultFailure?(error: Error, result?: PlayerResult): Error;
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
  // DR-063 §2: there is no failure without a cause. A failure the runtime
  // marks with nothing more specific is a runtime defect carrying its own
  // message; a decision site that knows better attaches its cause afterwards.
  attachPlaybookFailureCause(error, {
    code: 'runtime-defect',
    evidence: {
      reason:
        typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : 'unknown runtime defect',
    },
  });
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
// DR-063 §1/§2: there is no failure without a cause. Each decision site builds
// the cause its own evidence states, the runtime attaches it to the error it
// marks as the FSM failure, and anything else the runtime marks becomes
// `runtime-defect` carrying its message as `reason`.
// ---------------------------------------------------------------------------

/** Adjudication reasons this runtime decides itself, and their codes. */
const GOVERNED_JUDGE_FAILURE_REASONS: readonly string[] = [
  'judge transport failed',
  'corrective judge failed',
  'corrective semantic candidate is invalid',
  'semantic correction budget is unavailable',
];

export const ABORTED_FAILURE_CAUSE: PlaybookFailureCause = assertPlaybookFailureCause({
  code: 'aborted',
  evidence: {},
});

export function runtimeDefectCause(reason: string): PlaybookFailureCause {
  return assertPlaybookFailureCause({
    code: 'runtime-defect',
    evidence: { reason: reason.length === 0 ? 'unknown runtime defect' : reason },
  });
}

function failureErrorEvidence(
  error: unknown,
): { readonly name: string; readonly message: string } | undefined {
  if (error === undefined || error === null) return undefined;
  const { name, message } = normalizeError(error);
  return { name, message };
}

/** A string `code` the rejecting port reported, when it reported one. */
function failureErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

export function playerFailureCause(input: {
  readonly roleId: string;
  readonly playerId?: string;
  readonly error: unknown;
}): PlaybookFailureCause {
  return assertPlaybookFailureCause({
    code: 'player-failed',
    evidence: {
      roleId: input.roleId,
      ...(input.playerId === undefined ? {} : { playerId: input.playerId }),
      error: failureErrorEvidence(input.error) ?? {
        name: 'Error',
        message: 'Unknown error',
      },
      ...(failureErrorCode(input.error) === undefined
        ? {}
        : { errorCode: failureErrorCode(input.error)! }),
    },
  });
}

/**
 * DR-063 §1: the cause of an unresolved governed settlement. A reconciled
 * mismatch supplies its own receipt-read cause; the reasons a runtime owns map
 * to adjudication, abort, and runtime-defect codes. Exported so linked
 * machinery of an artifact's own decides the same reasons.
 */
export function governedSettlementCause(
  reason: string,
  error: unknown,
  aborted: boolean,
  supplied: PlaybookFailureCause | undefined,
): PlaybookFailureCause {
  if (supplied !== undefined) return supplied;
  if (aborted || reason.includes('aborted')) return ABORTED_FAILURE_CAUSE;
  if (GOVERNED_JUDGE_FAILURE_REASONS.includes(reason)) {
    const transport = failureErrorEvidence(error);
    return assertPlaybookFailureCause({
      code: 'judge-failed',
      evidence: {
        reason,
        ...(transport === undefined ? {} : { error: transport }),
      },
    });
  }
  return runtimeDefectCause(reason);
}

/**
 * DR-063 §2: the causes decided for thrown values that cannot carry the
 * marker — a string, a frozen error — and for the record a machine keeps in
 * place of the thrown value, kept by identity for as long as the failure
 * stands, so every surface that reads the FSM's own `lastError` publishes the
 * cause decided for exactly that failure, whatever turn reads it. A value
 * that carries the marker answers from it; the map is bounded, since only
 * values that lack the marker need an entry.
 */
export interface PlaybookFailureCauseRetention {
  retain(error: unknown, cause: PlaybookFailureCause): void;
  causeOf(error: unknown): PlaybookFailureCause | undefined;
}

const FAILURE_CAUSE_RETENTION_LIMIT = 8;

export function createFailureCauseRetention(): PlaybookFailureCauseRetention {
  const causes = new Map<unknown, PlaybookFailureCause>();
  return {
    retain(error, cause) {
      if (error === undefined || error === null) return;
      causes.delete(error);
      causes.set(error, cause);
      while (causes.size > FAILURE_CAUSE_RETENTION_LIMIT) {
        causes.delete(causes.keys().next().value);
      }
    },
    causeOf(error) {
      if (error === undefined || error === null) return undefined;
      return normalizeError(error).cause ?? causes.get(error);
    },
  };
}

/**
 * DR-063 §2: the value an invoked actor's rejection carried into the machine,
 * read from the XState error event that delivered it, or `undefined` for any
 * other event.
 */
function actorErrorOf(event: unknown): unknown {
  if (typeof event !== 'object' || event === null) return undefined;
  try {
    const { type, error } = event as { type?: unknown; error?: unknown };
    return typeof type === 'string' && type.startsWith('xstate.error.actor.')
      ? error
      : undefined;
  } catch {
    return undefined;
  }
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

/** One member's completion inside a repository cohort (DR-067 §1). */
type XStateRepositoryCohortCompletion<T> =
  XStateRepositoryExclusiveCompletion<T> & { readonly roleId: string };

interface XStateRepositoryCohortResult<T> {
  readonly baseline: PlaybookRepositoryReceipt['baseline'];
  readonly invocationId: string;
  readonly operations: Readonly<
    Record<
      string,
      XStateRepositoryOperationSettlement<T> | XStateRepositoryOperationRejection
    >
  >;
  readonly receipts: Readonly<Record<string, PlaybookRepositoryReceipt>>;
  readonly effectLedger: PlaybookEffectLedger;
}

export interface XStateRepositoryCapability {
  observe?(): Promise<PlaybookRepositoryReceipt['baseline']>;
  acquire?(options: { readonly signal: AbortSignal }): Promise<{
    assertOwner(): Promise<void>;
    release(): Promise<void>;
  }>;
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
  /**
   * DR-067 §1 / PBRT-73: one repository claim over the working leaves of a
   * parallel state entered together — every member an `unchanged` boundary
   * of one cohort, the operations run concurrently under that claim, and
   * one completion callback per member. Required for an artifact that
   * declares a parallel state.
   */
  runCohort?<T>(options: {
    readonly signal: AbortSignal;
    readonly invocationId: string;
    readonly roleIds: readonly string[];
    readonly dispositionsByRole: Readonly<Record<string, readonly ['unchanged']>>;
    readonly effectBoundaries: Readonly<Record<string, XStateEffectBoundarySeed>>;
    readonly operations: Readonly<
      Record<
        string,
        (context: {
          readonly baseline: PlaybookRepositoryReceipt['baseline'];
          readonly identity: unknown;
          readonly invocationId: string;
          readonly roleId: string;
        }) => Promise<T>
      >
    >;
    readonly completeEffectBoundary: (
      completion: XStateRepositoryCohortCompletion<T>,
    ) => XStateRepositoryCompletionEvidence | Promise<XStateRepositoryCompletionEvidence>;
  }): Promise<XStateRepositoryCohortResult<T>>;
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
  label: string,
): {
  readonly configuredOptions: unknown;
  readonly hostCapabilities: object;
  readonly effectLedger: PlaybookEffectLedgerCapability;
} {
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
  requireCohort = false,
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
    typeof (repository as { runDeferred?: unknown }).runDeferred !==
      'function' ||
    (requireCohort &&
      typeof (repository as { runCohort?: unknown }).runCohort !== 'function')
  ) {
    throw new TypeError(
      requireCohort
        ? `${label} schema-3 factory input hostCapabilities.repository must be an own data property exposing runExclusive, runCohort, and runDeferred`
        : `${label} schema-3 factory input hostCapabilities.repository must be an own data property exposing runExclusive and runDeferred`,
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
> = XStatePlaybookRuntimeConstruction<ConfiguredOptions, HostCapabilities>;

/** Shared XState factory with its captured, validated artifact compatibility. */
export type XStatePlaybookRuntimeFactory<
  Options = unknown,
  ArtifactSchema extends 3 = 3,
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
): 3 {
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
  return artifactSchema as 3;
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
    /** @deprecated Step checkpoints now carry the accepted input directly. */
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
    resuming?: boolean,
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

export interface XStatePlaybookRuntimeSpec<TOptions>
  extends XStatePlaybookRuntimeSpecBase<TOptions> {
  compat: XStatePlaybookRuntimeCompat & { artifactSchema: 3 };
  outcomeAuthority: XStateOutcomeAuthoritySpec;
}

/** Schema-3 shared-engine spec with required exact outcome authority metadata. */
export type XStatePlaybookRuntimeSpecV3<TOptions> =
  XStatePlaybookRuntimeSpec<TOptions>;

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
): Omit<NormalizedError, 'stack'> | undefined {
  if (err === undefined || err === null) return undefined;
  const normalized = normalizeError(err);
  return {
    name: normalized.name,
    message: normalized.message,
    // DR-063 §2: on a failure the cause is why the compact form exists, so it
    // survives where the stack does not.
    ...(normalized.cause === undefined ? {} : { cause: normalized.cause }),
  };
}

export function normalizeErrorFull(
  err: unknown,
): NormalizedError | undefined {
  if (err === undefined || err === null) return undefined;
  return normalizeError(err);
}

// slc/link.md §Abort: cancellation is causal identity with the applicable
// signal's reason — never an `AbortError` name, never bare signal state. A
// distinct failure observed while the signal is aborted stays a non-abort
// control error and takes precedence.
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
  return pendingBossQuestionRecord(context.pendingBossQuestion);
}

/**
 * DR-067 §1: the keyed form of gears2fsm's Boss-reply suspension. Each
 * well-formed `context.pendingBossQuestions[stateId]` record whose own
 * `questionId` equals its key counts only while a wait state that resumes
 * its `resumeStateId` is active, so an answered question the context
 * retains for the resumed prompt never reads as pending. Ordered by
 * question id.
 */
function keyedPendingBossQuestions(
  context: Record<string, unknown>,
  resumesFromActiveWait: (resumeStateId: string) => boolean,
): PlaybookPendingBossQuestionContext[] {
  const keyed = context.pendingBossQuestions;
  if (!isPlainObject(keyed)) return [];
  const pending: PlaybookPendingBossQuestionContext[] = [];
  for (const [key, value] of Object.entries(keyed)) {
    const record = pendingBossQuestionRecord(value);
    if (record === undefined || record.questionId !== key) continue;
    if (!resumesFromActiveWait(record.resumeStateId)) continue;
    pending.push(record);
  }
  return pending.sort((left, right) =>
    left.questionId.localeCompare(right.questionId),
  );
}

function pendingBossQuestionRecord(
  pending: unknown,
): PlaybookPendingBossQuestionContext | undefined {
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
  'Continue the same task using Boss’s reply below.';

function continuationBlocks(input: {
  pendingBossQuestion?: { readonly question: string };
  bossReply?: string;
}, resuming = false): string[] {
  if (input.pendingBossQuestion === undefined || input.bossReply === undefined) {
    return [];
  }
  return [
    CONTINUATION_PREAMBLE,
    ...(resuming ? [] : [`Your previous question:\n${input.pendingBossQuestion.question}`]),
    `Boss reply:\n${input.bossReply}`,
  ];
}

/** Add clarification context without repeating the question in a live conversation. */
export function composePlayerContinuation(
  input: Pick<PlaybookPlayerInput, 'pendingBossQuestion' | 'bossReply'>,
  body: string,
  resuming = false,
): string {
  return [...continuationBlocks(input, resuming), body].join('\n\n');
}

// DR-062 §4: the Coder is told which uncommitted changes were already in the
// worktree when its own call started. The block is composed from the call's
// own baseline observation, names paths only, and is bounded.
const PRE_EXISTING_CHANGE_GROUPS = [
  'staged',
  'modified',
  'deleted',
  'untracked',
  'renamed',
  'unmerged',
  'other',
] as const;

type PreExistingChangeGroup = (typeof PRE_EXISTING_CHANGE_GROUPS)[number];

const PRE_EXISTING_CHANGE_PATH_LIMIT = 40;

/**
 * The group one baseline projection entry belongs to. The shapes are the
 * porcelain-v2 records the repository observer projects: an `untracked`,
 * `rename-or-copy`, or `unmerged` kind, and otherwise an `ordinary` record
 * whose two-character `xy` carries the index state first and the worktree
 * state second.
 */
function preExistingChangeGroup(entry: unknown): PreExistingChangeGroup {
  if (!isPlainObject(entry)) return 'other';
  if (entry.kind === 'untracked') return 'untracked';
  if (entry.kind === 'rename-or-copy') return 'renamed';
  if (entry.kind === 'unmerged') return 'unmerged';
  const xy = entry.xy;
  if (entry.kind !== 'ordinary' || typeof xy !== 'string' || xy.length !== 2) {
    return 'other';
  }
  if (xy[1] === 'D') return 'deleted';
  if (xy[1] === '.') return xy[0] === '.' ? 'other' : 'staged';
  return 'modified';
}

/**
 * The pre-existing-changes block appended to an effect-authorized player
 * prompt, or `undefined` for an empty baseline projection.
 */
function preExistingChangesBlock(
  baseline: PlaybookRepositoryReceipt['baseline'] | undefined,
): string | undefined {
  const projection = baseline?.projection;
  if (!isPlainObject(projection)) return undefined;
  const grouped = new Map<PreExistingChangeGroup, string[]>();
  let total = 0;
  for (const path of Object.keys(projection)) {
    const group = preExistingChangeGroup(projection[path]);
    const paths = grouped.get(group);
    if (paths === undefined) grouped.set(group, [path]);
    else paths.push(path);
    total += 1;
  }
  if (total === 0) return undefined;
  const omitted = Math.max(0, total - PRE_EXISTING_CHANGE_PATH_LIMIT);
  const lines: string[] = [];
  let budget = PRE_EXISTING_CHANGE_PATH_LIMIT;
  for (const group of PRE_EXISTING_CHANGE_GROUPS) {
    const paths = grouped.get(group);
    if (paths === undefined || budget <= 0) continue;
    const printed = paths.slice().sort().slice(0, budget);
    budget -= printed.length;
    lines.push(`> - ${group}: ${printed.join(', ')}`);
  }
  if (omitted > 0 && lines.length > 0) {
    lines[lines.length - 1] += `, … and ${omitted} more`;
  }
  return [
    '> Uncommitted changes present before this call, belonging to the Boss:',
    ...lines,
    "> Leave them exactly as they are unless the task or the Boss's request requires building on them; never revert or delete them; when you commit any of them, name them in your final report.",
  ].join('\n');
}

/**
 * The block for one governed call, or `undefined` where the call is not
 * effect-authorized — a call whose declared outcomes carry no
 * `one-descendant-commit` disposition may commit nothing, so it is told
 * nothing.
 */
export function effectAuthorizedPreExistingBlock(
  effectBoundary: Pick<PlaybookEffectBoundaryStart, 'dispositions'>,
  baseline: PlaybookRepositoryReceipt['baseline'] | undefined,
): string | undefined {
  return effectBoundary.dispositions.includes('one-descendant-commit')
    ? preExistingChangesBlock(baseline)
    : undefined;
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
  resuming = false,
): string {
  const fields = input as unknown as Record<string, unknown>;
  const body = input.prompt.replace(PLACEHOLDER_PATTERN, (match, token) => {
    const value =
      fields[placeholderFieldName(token as string, placeholderFields)];
    return typeof value === 'string' ? value : match;
  });
  return composePlayerContinuation(input, body, resuming);
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

// A result description's output clause (slc/link.md §Captain adjudication):
// everything after `Output shall include` / `输出应包含` names the outcome's
// payload fields, each as a bare backticked name or the annotated
// `name: <placeholder>` form. The text before the clause is the outcome's
// meaning.
const OUTPUT_CLAUSE_MARKERS: readonly string[] = [
  'Output shall include',
  '输出应包含',
];
const PAYLOAD_FIELD_PATTERN =
  /`([A-Za-z_$][A-Za-z0-9_$]*)(?::\s*([^`]*))?`/g;
// Separators between one field's authored segment and the next field token.
const SEGMENT_SEPARATOR_SUFFIX = /(?:\s|[,;.，、；。]|\band\b)+$/;

function splitOutputClause(description: string): {
  readonly meaning: string;
  readonly clause?: string;
} {
  for (const marker of OUTPUT_CLAUSE_MARKERS) {
    const idx = description.indexOf(marker);
    if (idx !== -1) {
      return {
        meaning: description.slice(0, idx).trim(),
        clause: description.slice(idx + marker.length),
      };
    }
  }
  return { meaning: description.trim() };
}

/**
 * Default required-field extraction (slc/link.md §Captain adjudication).
 * Limited to the description's `Output shall include` / `输出应包含` clause;
 * recognizes both the bare backticked name and the annotated `name: <...>`
 * form.
 */
export function defaultExtractRequiredFields(description: string): string[] {
  const { clause } = splitOutputClause(description);
  if (clause === undefined) return [];
  const fields: string[] = [];
  for (const m of clause.matchAll(PAYLOAD_FIELD_PATTERN)) fields.push(m[1]);
  return fields;
}

const CURRENT_CALL_ADJUDICATION_GUIDANCE =
  "Classify the invoked role's current call by the result it reports at call end, using the full output and declared outcome meanings. " +
  'An earlier interim question is not outstanding when later prose explicitly resolves or supersedes it for this call; a prerequisite only for a later workflow stage does not block an affirmatively completed current call. ' +
  'A genuinely unanswered question needed to finish the current call remains outstanding. A commit statement alone does not establish semantic completion; do not force contradictory or insufficient evidence into a completed outcome.';

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
  lines.push(CURRENT_CALL_ADJUDICATION_GUIDANCE);
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

/**
 * Judge-facing rendering of one governed outcome (DR-040 §1). The artifact's
 * description is not altered: its meaning is carried through verbatim, while
 * its `Output shall include` clause — authored for the complete actor output
 * — is replaced by the reply contract `outcomeAuthority` gives the judge:
 * exactly `guard` plus the outcome's semantic-owned fields, each keeping the
 * placeholder or guidance the clause authors for it, and every
 * presentation-, effect-, or runtime-owned field named as runtime-supplied
 * so the judge omits it. Rendering the clause verbatim asked the judge for
 * `question`, `planningResult`, or `evaluatedRevision`, which the reconciler
 * rejects as a structural error, spending the single correction on a
 * self-inflicted defect. Exported so linked machinery of an artifact's own
 * renders the identical contract instead of restating it.
 */
export function renderGovernedOutcomeContract(
  guard: string,
  description: string,
  outcome: XStateGovernedOutcomeSpec | undefined,
): string[] {
  const { meaning, clause } = splitOutputClause(description);
  // Each field's authored segment runs from its token to the next token:
  // the annotated `name: <placeholder>` form, or the bare name followed by
  // its guidance (`` `irNumber` identifying the continued IR ``).
  const authored = new Map<
    string,
    { readonly segment: string; readonly placeholder?: string }
  >();
  if (clause !== undefined) {
    const matches = [...clause.matchAll(PAYLOAD_FIELD_PATTERN)];
    matches.forEach((m, i) => {
      const field = m[1];
      if (authored.has(field)) return;
      const start = m.index ?? 0;
      const end = matches[i + 1]?.index ?? clause.length;
      const segment = clause
        .slice(start, end)
        .replace(SEGMENT_SEPARATOR_SUFFIX, '');
      const placeholder = m[2]?.trim();
      authored.set(field, {
        segment,
        ...(placeholder !== undefined && placeholder.length > 0
          ? { placeholder }
          : {}),
      });
    });
  }
  const replyMembers = [`"guard": ${JSON.stringify(guard)}`];
  const semanticAsAuthored: string[] = [];
  const runtimeSupplied: string[] = [];
  for (const [field, authority] of Object.entries(outcome?.fields ?? {})) {
    if (authority === 'semantic') {
      const entry = authored.get(field);
      replyMembers.push(
        `${JSON.stringify(field)}: ${entry?.placeholder ?? '<string>'}`,
      );
      semanticAsAuthored.push(entry?.segment ?? `\`${field}\``);
    } else {
      runtimeSupplied.push(`\`${field}\` (${authority}-owned)`);
    }
  }
  const lines = [
    meaning.length === 0 ? `- \`${guard}\`` : `- \`${guard}\` — ${meaning}`,
    `  Reply exactly: { ${replyMembers.join(', ')} }`,
  ];
  if (semanticAsAuthored.length > 0) {
    lines.push(
      `  Semantic fields as authored: ${semanticAsAuthored.join('; ')}`,
    );
  }
  if (runtimeSupplied.length > 0) {
    lines.push(
      `  Runtime-supplied, do not include: ${runtimeSupplied.join(', ')}`,
    );
  }
  return lines;
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
    CURRENT_CALL_ADJUDICATION_GUIDANCE,
    'Reply with exactly one JSON object and no prose.',
    '',
    `The ${input.role} role just produced this output:`,
    '',
    '```',
    finalText,
    '```',
    '',
    'Pick exactly one declared `guard` and reply with exactly that outcome\'s reply shape below: `guard` plus its semantic-owned fields and nothing else.',
    'If no declared outcome matches the player output, instead reply exactly {"blocked":"explain the missing outcome or contradictory requirements"}. Never force a match or invent a guard. A blocked reply pauses the playbook for Boss; it is not completion.',
    'A field listed as runtime-supplied is owned by presentation, effect, or runtime evidence; the runtime fills it itself, and a reply that includes one is structurally invalid.',
    '',
  ];
  for (const [guard, description] of Object.entries(input.result)) {
    lines.push(
      ...renderGovernedOutcomeContract(guard, description, outcomes[guard]),
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
  run?: (input: PlaybookPlayerInput, signal: AbortSignal, execute: () => Promise<PlaybookActorOutput>) => Promise<PlaybookActorOutput>;
}

export function createPlayerBridge(
  spec: PlayerBridgeSpec,
  ports: PlaybookPorts,
  getActiveSignal?: () => AbortSignal | undefined,
  boundary?: RuntimeBoundaryCalls,
  onControlPlaneError?: (error: unknown) => void,
): PromiseActorLogic<PlaybookActorOutput, PlaybookPlayerInput> {
  const execute = async ({ input, signal }: { input: PlaybookPlayerInput; signal: AbortSignal }): Promise<PlaybookActorOutput> => {
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
        const failure = new Error(
          result.error ?? `captainBridge: callPlayer status "${result.status}"`,
        );
        throw boundary?.markPlayerResultFailure?.(failure, result) ?? failure;
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
    };
  return fromPromise<PlaybookActorOutput, PlaybookPlayerInput>((args) => spec.run
    ? spec.run(args.input, args.signal, () => execute(args)) : execute(args));
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

function transitionArmTargets(transition: unknown): string[] {
  const arms = Array.isArray(transition) ? transition : [transition];
  const targets: string[] = [];
  for (const arm of arms) {
    if (typeof arm === 'string') {
      targets.push(arm);
    } else if (isPlainObject(arm) && typeof arm.target === 'string') {
      targets.push(arm.target);
    }
  }
  return targets;
}

function playbookStateIdOf(stateDef: unknown): string | undefined {
  if (!isPlainObject(stateDef) || !isPlainObject(stateDef.meta)) {
    return undefined;
  }
  const playbook = stateDef.meta.playbook;
  return isPlainObject(playbook) && typeof playbook.stateId === 'string'
    ? playbook.stateId
    : undefined;
}

function stateTagsOf(stateDef: Record<string, unknown>): readonly string[] {
  const tags = stateDef.tags;
  if (typeof tags === 'string') return [tags];
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
}

/** Every explicit node `id` in the config, mapped to its playbook state id. */
function playbookStateIdsByNodeId(config: unknown): ReadonlyMap<string, string> {
  const byNodeId = new Map<string, string>();
  const visit = (stateDef: unknown): void => {
    if (!isPlainObject(stateDef)) return;
    const stateId = playbookStateIdOf(stateDef);
    if (typeof stateDef.id === 'string' && stateId !== undefined) {
      byNodeId.set(stateDef.id, stateId);
    }
    if (isPlainObject(stateDef.states)) {
      for (const child of Object.values(stateDef.states)) visit(child);
    }
  };
  if (isPlainObject(config) && isPlainObject(config.states)) {
    for (const child of Object.values(config.states)) visit(child);
  }
  return byNodeId;
}

/**
 * One transition target written inside a parallel region, resolved to the
 * playbook state id it names: an `#id` reference through the node ids, and a
 * bare sibling key through the region's own leaves.
 */
function resolveRegionTarget(
  target: string,
  regionStates: Record<string, unknown>,
  byNodeId: ReadonlyMap<string, string>,
): string {
  if (target.startsWith('#')) {
    const nodeId = target.slice(1);
    return byNodeId.get(nodeId) ?? nodeId;
  }
  if (Object.prototype.hasOwnProperty.call(regionStates, target)) {
    return playbookStateIdOf(regionStates[target]) ?? target;
  }
  return target;
}

/**
 * Targets of the FSM's `awaitBossReply` BOSS_REPLY transitions, plus — for
 * the parallel shape gears2fsm compiles (DR-067) — the targets of each
 * region wait leaf's branch-local BOSS_REPLY arms, resolved to state ids.
 */
export function resumableStateIdsFromMachine(
  machine: AnyStateMachine,
): ReadonlySet<string> {
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config) || !isPlainObject(config.states)) {
    return new Set();
  }
  const resumable = new Set<string>();
  const awaitState = config.states[BOSS_REPLY_WAIT_STATE_ID];
  if (isPlainObject(awaitState) && isPlainObject(awaitState.on)) {
    const bossReply = awaitState.on.BOSS_REPLY;
    if (bossReply !== undefined) {
      for (const target of transitionTargets(bossReply)) resumable.add(target);
    }
  }
  const byNodeId = playbookStateIdsByNodeId(config);
  for (const stateDef of Object.values(config.states)) {
    if (
      !isPlainObject(stateDef) ||
      stateDef.type !== 'parallel' ||
      !isPlainObject(stateDef.states)
    ) {
      continue;
    }
    for (const region of Object.values(stateDef.states)) {
      if (!isPlainObject(region) || !isPlainObject(region.states)) continue;
      const regionStates = region.states;
      for (const leaf of Object.values(regionStates)) {
        if (!isPlainObject(leaf) || !isPlainObject(leaf.on)) continue;
        const bossReply = leaf.on.BOSS_REPLY;
        if (bossReply === undefined) continue;
        for (const target of transitionArmTargets(bossReply)) {
          resumable.add(resolveRegionTarget(target, regionStates, byNodeId));
        }
      }
    }
  }
  return resumable;
}

/** One region of a compiled parallel state (DR-067 §1). */
interface XStateParallelRegion {
  readonly key: string;
  readonly roleId: string;
  readonly workingStateId: string;
  readonly waitStateId: string;
  readonly finalStateId: string;
}

/** One root `type: 'parallel'` state of the compiled shape. */
interface XStateParallelState {
  readonly stateId: string;
  readonly regions: readonly XStateParallelRegion[];
}

/**
 * The parallel profile derived from a machine that declares a parallel
 * state (DR-067 §1): its parallel states, each wait state's resume targets
 * — region waits and the root reply wait alike — and, per state id, the
 * config nodes whose `on` maps an active state contributes.
 */
interface XStateParallelProfile {
  readonly states: readonly XStateParallelState[];
  readonly parallelStateByWorkingStateId: ReadonlyMap<
    string,
    XStateParallelState
  >;
  readonly waitResumeTargets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly transitionNodesByStateId: ReadonlyMap<
    string,
    readonly Record<string, unknown>[]
  >;
}

/** One registered cohort member awaiting its cohort's settlement. */
interface XStateCohortMember {
  readonly region: XStateParallelRegion;
  readonly input: PlaybookPlayerInput;
  readonly roleId: string;
  readonly playerId: string | undefined;
  readonly playerKey: string;
  readonly signal: AbortSignal;
  readonly effectBoundary: XStateEffectBoundarySeed;
  readonly run: (
    callSignal: AbortSignal,
    cohortCancellation: AbortSignal,
    preExistingBlock: string | undefined,
  ) => Promise<PlayerResult>;
  readonly reportCollision: (callSignal: AbortSignal) => Promise<never>;
  readonly settled: DeferredValue<PlayerResult>;
}

/** The cohort of one parallel state within one public boundary. */
interface PendingCohort {
  readonly boundarySequence: number;
  readonly members: Map<string, XStateCohortMember>;
  started: boolean;
}

function malformedParallelState(
  label: string,
  key: string,
  reason: string,
): Error {
  return new Error(
    `${label} parallel state ${key} is not the compiled parallel shape: ${reason}`,
  );
}

/**
 * DR-067 §1 / PBRT-52: the factory's domain is flat root states plus root
 * `type: 'parallel'` states of the one shape gears2fsm compiles — each
 * region a compound state with exactly one player-invoking `playbook.busy`
 * working leaf, exactly one `playbook.parked` wait leaf whose BOSS_REPLY
 * arms resume that working leaf, and exactly one final leaf, every leaf
 * carrying a stable `meta.playbook.stateId` distinct from every other
 * state's, and the parent's `onDone` the join. Any other compound state
 * keeps the flat-domain rejection. Returns `undefined` for a flat machine.
 */
function parallelProfileFromMachine(
  machine: AnyStateMachine,
  label: string,
): XStateParallelProfile | undefined {
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config) || !isPlainObject(config.states)) {
    return undefined;
  }
  const rootStates = config.states;
  const parallelKeys = Object.entries(rootStates)
    .filter(
      ([, stateDef]) => isPlainObject(stateDef) && stateDef.type === 'parallel',
    )
    .map(([key]) => key);
  for (const stateDef of Object.values(rootStates)) {
    if (
      isPlainObject(stateDef) &&
      stateDef.type !== 'parallel' &&
      isPlainObject(stateDef.states) &&
      Object.keys(stateDef.states).length > 0
    ) {
      throw new Error(
        `${label} declares a compound state; the shared runtime supports only flat single-region FSMs`,
      );
    }
  }
  if (parallelKeys.length === 0) return undefined;

  const byNodeId = playbookStateIdsByNodeId(config);
  const seenStateIds = new Set<string>();
  for (const stateDef of Object.values(rootStates)) {
    const stateId = playbookStateIdOf(stateDef);
    if (stateId !== undefined) seenStateIds.add(stateId);
  }
  const states: XStateParallelState[] = [];
  const parallelStateByWorkingStateId = new Map<string, XStateParallelState>();
  const waitResumeTargets = new Map<string, ReadonlySet<string>>();
  const transitionNodesByStateId = new Map<
    string,
    readonly Record<string, unknown>[]
  >();
  for (const key of parallelKeys) {
    const parent = rootStates[key] as Record<string, unknown>;
    if (parent.onDone === undefined) {
      throw malformedParallelState(label, key, 'it declares no onDone join');
    }
    if (!isPlainObject(parent.states) || Object.keys(parent.states).length < 2) {
      throw malformedParallelState(
        label,
        key,
        'it must declare at least two regions',
      );
    }
    const regions: XStateParallelRegion[] = [];
    const roleIds = new Set<string>();
    for (const [regionKey, region] of Object.entries(parent.states)) {
      const regionReason = (reason: string) =>
        malformedParallelState(label, key, `region ${regionKey} ${reason}`);
      if (
        !isPlainObject(region) ||
        region.type === 'parallel' ||
        region.type === 'final' ||
        region.type === 'history' ||
        !isPlainObject(region.states)
      ) {
        throw regionReason('must be a compound state of leaves');
      }
      const regionStates = region.states;
      let working: [string, Record<string, unknown>] | undefined;
      let wait: [string, Record<string, unknown>] | undefined;
      let final: [string, Record<string, unknown>] | undefined;
      for (const [leafKey, leaf] of Object.entries(regionStates)) {
        if (!isPlainObject(leaf)) {
          throw regionReason(`leaf ${leafKey} must be a state object`);
        }
        if (
          (isPlainObject(leaf.states) && Object.keys(leaf.states).length > 0) ||
          leaf.type === 'parallel' ||
          leaf.type === 'history'
        ) {
          throw regionReason(`leaf ${leafKey} must be an atomic state`);
        }
        const leafStateId = playbookStateIdOf(leaf);
        if (leafStateId === undefined || leafStateId.trim().length === 0) {
          throw regionReason(
            `leaf ${leafKey} must carry a string meta.playbook.stateId`,
          );
        }
        if (seenStateIds.has(leafStateId)) {
          throw regionReason(
            `leaf ${leafKey} reuses playbook state id ${leafStateId}`,
          );
        }
        seenStateIds.add(leafStateId);
        const invoke = leaf.invoke;
        const invokes = Array.isArray(invoke) ? invoke : invoke ? [invoke] : [];
        const tags = stateTagsOf(leaf);
        if (leaf.type === 'final') {
          if (final !== undefined) throw regionReason('declares two final leaves');
          final = [leafKey, leaf];
        } else if (
          invokes.length === 1 &&
          isPlainObject(invokes[0]) &&
          invokes[0].src === 'player' &&
          tags.includes('playbook.busy')
        ) {
          if (working !== undefined) {
            throw regionReason('declares two working leaves');
          }
          working = [leafKey, leaf];
        } else if (
          invokes.length === 0 &&
          tags.includes('playbook.parked') &&
          isPlainObject(leaf.on) &&
          leaf.on.BOSS_REPLY !== undefined
        ) {
          if (wait !== undefined) throw regionReason('declares two wait leaves');
          wait = [leafKey, leaf];
        } else {
          throw regionReason(
            `leaf ${leafKey} is neither its player-invoking playbook.busy working leaf, its playbook.parked BOSS_REPLY wait leaf, nor its final leaf`,
          );
        }
      }
      if (working === undefined || wait === undefined || final === undefined) {
        throw regionReason(
          'must hold exactly one working leaf, one wait leaf, and one final leaf',
        );
      }
      if (region.initial !== working[0]) {
        throw regionReason('must start in its working leaf');
      }
      const workingStateId = playbookStateIdOf(working[1])!;
      const waitStateId = playbookStateIdOf(wait[1])!;
      const finalStateId = playbookStateIdOf(final[1])!;
      const replyTargets = transitionArmTargets(
        (wait[1].on as Record<string, unknown>).BOSS_REPLY,
      ).map((target) => resolveRegionTarget(target, regionStates, byNodeId));
      const regionStateIds = new Set([waitStateId, finalStateId]);
      if (
        !replyTargets.includes(workingStateId) ||
        replyTargets.some((target) => regionStateIds.has(target))
      ) {
        throw regionReason(
          'wait leaf BOSS_REPLY arms must resume its working leaf',
        );
      }
      const workingMeta = (working[1].meta as Record<string, unknown>)
        .playbook as Record<string, unknown>;
      const roleId = workingMeta.role;
      if (typeof roleId !== 'string' || roleId.trim().length === 0) {
        throw regionReason('working leaf must declare meta.playbook.role');
      }
      if (roleIds.has(roleId)) {
        throw malformedParallelState(
          label,
          key,
          `role ${roleId} works in more than one region`,
        );
      }
      roleIds.add(roleId);
      regions.push({
        key: regionKey,
        roleId,
        workingStateId,
        waitStateId,
        finalStateId,
      });
      waitResumeTargets.set(waitStateId, new Set([workingStateId]));
      for (const [, leaf] of [working, wait, final]) {
        transitionNodesByStateId.set(playbookStateIdOf(leaf)!, [region, leaf]);
      }
    }
    const parallelState: XStateParallelState = {
      stateId: key,
      regions: Object.freeze(regions),
    };
    states.push(parallelState);
    for (const region of regions) {
      parallelStateByWorkingStateId.set(region.workingStateId, parallelState);
    }
    transitionNodesByStateId.set(key, [parent]);
  }
  for (const [key, stateDef] of Object.entries(rootStates)) {
    if (!isPlainObject(stateDef) || parallelKeys.includes(key)) continue;
    transitionNodesByStateId.set(key, [stateDef]);
  }
  const rootWait = rootStates[BOSS_REPLY_WAIT_STATE_ID];
  if (isPlainObject(rootWait) && isPlainObject(rootWait.on)) {
    const bossReply = rootWait.on.BOSS_REPLY;
    if (bossReply !== undefined) {
      waitResumeTargets.set(
        BOSS_REPLY_WAIT_STATE_ID,
        new Set(transitionTargets(bossReply)),
      );
    }
  }
  return Object.freeze({
    states: Object.freeze(states),
    parallelStateByWorkingStateId,
    waitResumeTargets,
    transitionNodesByStateId,
  });
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
 * DR-048: each root final state's declared terminal kind, read from
 * `meta.playbook.terminal` in `machine.config`. The kind is compiled
 * metadata — the compiler derives it from the Source's own outcome wording,
 * exactly as it derives the state's description — so a caller learns whether
 * a completed child succeeded from the machine it reached, never from the
 * child's output fields or an agent's prose.
 *
 * A machine whose final states declare no kind yields an empty map and keeps
 * the pre-DR-048 delivery. A `terminal` on a non-final state, or a value
 * other than `success` or `failure`, is a malformed artifact and throws.
 */
export function terminalOutcomesFromMachine(
  machine: AnyStateMachine,
  label = 'playbook',
): ReadonlyMap<string, 'success' | 'failure'> {
  const kinds = new Map<string, 'success' | 'failure'>();
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config) || !isPlainObject(config.states)) return kinds;
  for (const [key, stateDef] of Object.entries(config.states)) {
    if (!isPlainObject(stateDef)) continue;
    const playbook = isPlainObject(stateDef.meta)
      ? (stateDef.meta as Record<string, unknown>).playbook
      : undefined;
    const declared = isPlainObject(playbook) ? playbook.terminal : undefined;
    if (declared === undefined) continue;
    if (declared !== 'success' && declared !== 'failure') {
      throw new TypeError(
        `${label} state ${key} declares meta.playbook.terminal ` +
          `${JSON.stringify(declared)}; only 'success' or 'failure' is a ` +
          'terminal kind',
      );
    }
    if (stateDef.type !== 'final') {
      throw new TypeError(
        `${label} state ${key} declares meta.playbook.terminal but is not ` +
          'a final state',
      );
    }
    kinds.set(key, declared);
  }
  return kinds;
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
  machine: AnyStateMachine,
  stateDescriptions: ReadonlyMap<string, string>,
): ReadonlyMap<string, XStateRoleStateStatus> {
  if (value === undefined) {
    throw new TypeError(`${label} roleStates must be supplied for schema 3`);
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
  label: string,
  playerStates: ReadonlyMap<string, XStateRoleStateStatus>,
  verbatimPayloadFields: ReadonlySet<string>,
): XStateOutcomeAuthoritySpec {
  const path = `${label} outcomeAuthority`;
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
      // DR-045: an unchanged arm may declare effect-owned fields (injected
      // from the matching unchanged receipt's observed HEAD); only deferred
      // arms remain barred from effect ownership.
      if (
        disposition === 'deferred' &&
        Object.values(fields).includes('effect')
      ) {
        throw new TypeError(
          `${outcomePath} may not declare effect-owned fields for deferred`,
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
        { message: `${askerLabel(pending.asker)} asks: ${pending.question}`, data: { kind: 'boss-question' } },
        {
          message:
            `◆ awaiting Boss reply · ${pending.resumeStateId} · ` +
            `${askerLabel(pending.asker)} · ${pending.sourceItem}`,
          data: { kind: 'boss-question' },
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

/**
 * DR-067 §1: the questions pending in a parallel-declaring machine — the
 * keyed records whose resume state an active wait state (a region wait leaf
 * or the root reply wait) resumes.
 */
function parallelPendingBossQuestions(
  profile: XStateParallelProfile,
  activeStateIds: readonly string[],
  context: Record<string, unknown>,
): PlaybookPendingBossQuestionContext[] {
  return keyedPendingBossQuestions(context, (resumeStateId) =>
    activeStateIds.some(
      (stateId) =>
        profile.waitResumeTargets.get(stateId)?.has(resumeStateId) === true,
    ),
  );
}

/** Event types the root and every active state node of a parallel machine configure. */
function parallelConfiguredEventTypes(
  machine: AnyStateMachine,
  profile: XStateParallelProfile,
  activeStateIds: readonly string[],
): ReadonlySet<string> {
  const configured = new Set<string>();
  const config = (machine as unknown as { config?: unknown }).config;
  if (!isPlainObject(config)) return configured;
  if (isPlainObject(config.on)) {
    for (const type of Object.keys(config.on)) configured.add(type);
  }
  for (const stateId of activeStateIds) {
    for (const node of profile.transitionNodesByStateId.get(stateId) ?? []) {
      if (!isPlainObject(node.on)) continue;
      for (const type of Object.keys(node.on)) configured.add(type);
    }
  }
  return configured;
}

function activeStateIdsOf(snapshotOrState: unknown): readonly string[] {
  const listed = (snapshotOrState as { activeStateIds?: unknown } | null)
    ?.activeStateIds;
  if (Array.isArray(listed)) {
    return listed.filter((stateId): stateId is string => typeof stateId === 'string');
  }
  try {
    return normalizePlaybookSnapshot(snapshotOrState).activeStateIds;
  } catch {
    return [];
  }
}

function makeDefaultClassifyBossText(
  machine: AnyStateMachine,
  entryEvent: { type: string; textField: string } | undefined,
  bossEvents: readonly XStateBossEventSpec[],
  parallelProfile?: XStateParallelProfile,
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
    let pendingQuestions: readonly PlaybookPendingBossQuestionContext[];
    let configuredTypes: ReadonlySet<string>;
    if (parallelProfile === undefined) {
      const pending =
        stateId === BOSS_REPLY_WAIT_STATE_ID
          ? pendingBossQuestionFromContext(state.context)
          : undefined;
      pendingQuestions = pending === undefined ? [] : [pending];
      configuredTypes = configuredEventTypesForState(machine, stateId);
    } else {
      // DR-067 §1: every question pending in any active wait is offered, and
      // the events of every active state node apply.
      const activeStateIds = activeStateIdsOf(snapshotOrState);
      pendingQuestions = parallelPendingBossQuestions(
        parallelProfile,
        activeStateIds,
        state.context,
      );
      configuredTypes = parallelConfiguredEventTypes(
        machine,
        parallelProfile,
        activeStateIds,
      );
    }
    // Several pending questions: a reply must name the one it answers, and
    // the classifier never guesses among them (gears2fsm §Parallel groups).
    const severalPending = pendingQuestions.length > 1;
    const applicable = [...contracts.values()]
      .filter(
        (contract) =>
          configuredTypes.has(contract.type) &&
          (contract.type !== 'BOSS_REPLY' || pendingQuestions.length > 0),
      )
      .map((contract): XStateBossEventSpec =>
        contract.type === 'BOSS_REPLY' && severalPending
          ? {
              type: 'BOSS_REPLY',
              fields: {
                questionId: {
                  source: 'judge',
                  required: true,
                  values: pendingQuestions.map(({ questionId }) => questionId),
                },
                answer: { source: 'text', required: true },
              },
            }
          : contract,
      );

    const lines = [
      'Classify the following Boss message into exactly one event.',
      'Respond with one exact flat JSON object. Do not add fields that are not shown.',
      'The runtime, not the judge, attaches the exact Boss text to textual event fields.',
      '',
      `Current state: ${currentState}`,
    ];
    for (const pending of pendingQuestions) {
      lines.push(
        `Pending question id: ${pending.questionId}`,
        `Pending asker: ${askerLabel(pending.asker)}`,
        `Pending Boss question: ${pending.question}`,
      );
    }
    if (severalPending) {
      lines.push(
        'Several Boss questions are pending: a BOSS_REPLY must name the questionId of the one question it answers.',
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
      if (pendingQuestions.length === 0) {
        await ports.emitStatus(
          'Classifier returned BOSS_REPLY without a pending question',
        );
        return undefined;
      }
      if (!severalPending) {
        const pending = pendingQuestions[0]!;
        const questionId = event.questionId;
        if (questionId !== undefined && questionId !== pending.questionId) {
          await ports.emitStatus(
            `Classifier supplied unknown questionId for BOSS_REPLY: ${String(questionId)}`,
          );
          return undefined;
        }
        event.questionId = pending.questionId;
      }
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
 * Scope: flat single-region machines — every root state's
 * `meta.playbook.stateId` equal to its state key, so each snapshot exposes
 * exactly one playbook state id — plus the parallel profile of DR-067: root
 * `type: 'parallel'` states of the shape gears2fsm compiles, whose regions
 * run as one all-`unchanged` repository cohort with keyed pending questions.
 * A machine declaring a parallel state omits `adopt`.
 */
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
      `${label} artifacts must supply roleStates, not playerStates`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(specDescriptors, 'resolvePlayerId')) {
    throw new TypeError(
      `${label} artifacts must not derive concrete player bindings`,
    );
  }
  // DR-067 §1: a flat machine, or one whose only compound states are root
  // parallel states of the compiled shape; everything else is rejected.
  const parallelProfile = parallelProfileFromMachine(machine, label);
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
  // DR-048: a malformed terminal declaration is a control-plane defect of the
  // artifact, so it fails construction rather than at the one run that
  // happens to reach that final state.
  const terminalKinds = terminalOutcomesFromMachine(machine, label);
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
    machine,
    stateDescriptions,
  );
  const declaredRoleIds = Object.freeze([
    ...new Set([...roleStates.values()].map(({ role }) => role)),
  ]);
  // DR-067 §1: the Boss-relevant states of a parallel-declaring machine —
  // each player state, each wait state, and the failure state. A status is
  // scheduled for each one newly entered, and a status trace names a
  // `stateId` only while exactly one is active.
  const bossRelevantStateIds: ReadonlySet<string> | undefined =
    parallelProfile === undefined
      ? undefined
      : new Set([
          ...roleStates.keys(),
          ...parallelProfile.waitResumeTargets.keys(),
          'failed',
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
    ((input: PlaybookPlayerInput, _identity: XStatePromptIdentity, resuming = false) =>
      defaultComposePlayerPrompt(input, spec.placeholderFields, resuming));
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
    label,
    roleStates,
    verbatimPayloadFields,
  );
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
  // Build the derived classifier unconditionally: it is the sole validator of
  // supplied `bossEvents`, and DR-019 §2 requires a conflicting duplicate to
  // fail factory construction whether or not this spec overrides the
  // classifier that would have consumed the contracts.
  const derivedClassifyBossText = makeDefaultClassifyBossText(
    machine,
    spec.entryEvent,
    spec.bossEvents ?? [],
    parallelProfile,
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

  // DR-067 §1: the questions pending in a state — the singular reply-wait
  // question of a flat machine, or a parallel machine's keyed questions
  // whose own wait state is active.
  const pendingBossQuestionsFor = (
    state: PlaybookState,
    context: Record<string, unknown>,
  ): readonly PlaybookPendingBossQuestionContext[] => {
    if (parallelProfile === undefined) {
      const pending = pendingBossQuestionForState(state, context);
      return pending === undefined ? [] : [pending];
    }
    return parallelPendingBossQuestions(
      parallelProfile,
      state.activeStateIds,
      context,
    );
  };
  const singlePendingBossQuestion = (
    state: PlaybookState,
    context: Record<string, unknown>,
  ): PlaybookPendingBossQuestionContext | undefined => {
    const pending = pendingBossQuestionsFor(state, context);
    return pending.length === 1 ? pending[0] : undefined;
  };
  // DR-067 §1: a status trace names a `stateId` only while exactly one
  // Boss-relevant state is active; a flat machine's is its one state.
  const statusTraceStateId = (state: PlaybookState): string | undefined => {
    if (bossRelevantStateIds === undefined) return state.stateId;
    const relevant = state.activeStateIds.filter((stateId) =>
      bossRelevantStateIds.has(stateId),
    );
    return relevant.length === 1 ? relevant[0] : undefined;
  };
  // DR-067 §1: a parallel machine schedules statuses for each newly entered
  // Boss-relevant state — a player state's role line, a wait state's
  // question lines, and the failure line — diffed against the previous
  // snapshot's active state ids, so a sibling still running is not
  // announced again.
  const parallelStatusesFor = (
    previousState: PlaybookState | undefined,
    state: PlaybookState,
    context: Record<string, unknown>,
  ): ScheduledStatus[] => {
    const prior = new Set(previousState?.activeStateIds ?? []);
    const statuses: ScheduledStatus[] = [];
    for (const stateId of state.activeStateIds) {
      if (prior.has(stateId) || !bossRelevantStateIds!.has(stateId)) continue;
      const resumeTargets = parallelProfile!.waitResumeTargets.get(stateId);
      if (resumeTargets !== undefined) {
        const questions = keyedPendingBossQuestions(context, (resumeStateId) =>
          resumeTargets.has(resumeStateId),
        );
        if (questions.length === 0) {
          statuses.push({ message: 'Awaiting Boss reply.' });
          continue;
        }
        for (const pending of questions) {
          statuses.push(
            {
              message: `${askerLabel(pending.asker)} asks: ${pending.question}`,
              data: { kind: 'boss-question' },
            },
            {
              message:
                `◆ awaiting Boss reply · ${pending.resumeStateId} · ` +
                `${askerLabel(pending.asker)} · ${pending.sourceItem}`,
              data: { kind: 'boss-question' },
            },
          );
        }
        continue;
      }
      if (stateId === 'failed') {
        const lastError = normalizeErrorCompact(context.lastError);
        statuses.push({
          message: '◆ workflow failed; awaiting Boss recovery.',
          ...(lastError === undefined
            ? {}
            : {
                data: snapshotJsonValue({ lastError }, 'failed status data'),
              }),
        });
        continue;
      }
      const roleState = roleStates.get(stateId);
      if (roleState !== undefined) {
        statuses.push({ message: `⤷ ${roleState.role}: ${roleState.label}` });
      }
    }
    return statuses;
  };
  // DR-067 §1: each parallel state's region roles, in region order, are one
  // concurrent role set the FSM exports; a host that forwards those sets in
  // its schema-3 authority is held to them before any agent call.
  const assertDeclaredCohorts = (hostCapabilities: object): void => {
    const authority = Object.getOwnPropertyDescriptor(
      hostCapabilities,
      'authority',
    )?.value;
    if (!isPlainObject(authority) || !Array.isArray(authority.concurrentRoleSets)) {
      return;
    }
    const declared = authority.concurrentRoleSets as readonly unknown[];
    for (const parallelState of parallelProfile!.states) {
      const roles = parallelState.regions.map(({ roleId }) => roleId);
      if (
        !declared.some(
          (candidate) =>
            Array.isArray(candidate) &&
            candidate.length === roles.length &&
            candidate.every((roleId, index) => roleId === roles[index]),
        )
      ) {
        throw new TypeError(
          `${label} parallel state ${parallelState.stateId} roles [${roles.join(', ')}] are not a declared concurrent role set`,
        );
      }
    }
  };

  const createPlaybookRuntime = function createPlaybookRuntime(
    factoryOptions: unknown,
  ): PlaybookRuntime {
    const construction = configuredOptionsFromFactoryInput(
      factoryOptions,
      label,
    );
    const configuredOptions = construction.configuredOptions as TOptions;
    const effectLedgerCapability = construction.effectLedger;
    const hasGovernedPlayerStates =
      Object.keys(outcomeAuthority.governedPlayerStates).length > 0;
    const acceptedOutcomeConsumer = createAcceptedOutcomeConsumer(
      (source, acceptedOutcome) => {
        const governedPlayerStates = outcomeAuthority.governedPlayerStates;
        if (
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
            parallelProfile !== undefined,
          )
        : undefined;
    if (parallelProfile !== undefined) {
      assertDeclaredCohorts(construction.hostCapabilities);
    }
    const currentEffectLedger = (): PlaybookEffectLedger =>
      assertPlaybookEffectLedger(
        effectLedgerCapability.snapshot(),
        `${label} current host effect ledger`,
      );
    let effectLedgerMirror = currentEffectLedger();
    let recoveryCheckpoint: PlaybookRuntimeSnapshot['recoveryCheckpoint'];
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
    // its promise actor settles. The next root snapshot/error consumes it so
    // background settlement emissions retain their owner. A flat machine has
    // one settling actor at a time, so a later binding replaces an unconsumed
    // one; a parallel machine's settlements queue in order (DR-067 §1).
    const actorSettlementAborts: (AbortReasonClassifier | undefined)[] = [];
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
          /** The continuation's own baseline observation (DR-062 §4). */
          baseline?: PlaybookRepositoryReceipt['baseline'];
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
    // DR-063 §2: the cause decided for a non-`ok` player result before the
    // compiled artifact builds the Error that carries it and hands it to
    // `markPlayerResultFailure`. It is cleared at each Boss turn start and at
    // each successful result, so it is never stale.
    let pendingResultFailureCause: PlaybookFailureCause | undefined;
    // DR-063 §2: the causes decided for thrown values that cannot carry the
    // marker — a string, a frozen error — and for the record a machine keeps
    // in place of the thrown value, kept by identity for as long as the
    // failure stands, so every surface that reads the FSM's own `lastError`
    // publishes the cause decided for exactly that failure, whatever turn
    // reads it.
    const failureCauses = createFailureCauseRetention();
    // DR-063 §2 / DR-067 §1: the cause decided for each non-`ok` player
    // result, keyed by the result itself, so concurrent region calls never
    // lend one another the single slot above.
    const resultFailureCauses = new WeakMap<object, PlaybookFailureCause>();
    // DR-067 §1: the parallel profile's cohort bookkeeping. Every public
    // boundary advances the sequence; a parallel state's working leaves run
    // as one cohort at most once per boundary, and each cohort's semantic
    // completions — which the host settles concurrently — reconcile one at a
    // time so their durable correction-budget writes cannot race.
    let publicBoundarySequence = 0;
    const consumedCohortBoundaries = new Map<string, number>();
    const pendingCohorts = new Map<string, PendingCohort>();
    const cohortCompletionQueue = new PQueue({ concurrency: 1 });
    // DR-067 §1: every player, judge, and nested call a parallel machine
    // starts, so a boundary's drain waits for a cancelled sibling whose port
    // ignores its signal before it settles.
    const activeBoundaryCalls = new Set<Promise<unknown>>();
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

    // DR-040 §4 parks only an envelope whose evidence proves a repository
    // delta or cannot exclude one. A standalone boundary whose complete
    // physical receipt is exactly `unchanged` excludes any effect, so missing
    // or unresolved semantics over it are an ordinary failure — the FSM's
    // failure state with its fenced retry — never a parked reconciliation:
    // that state's only exits, reconcile and abandon, project no effect
    // evidence from an `unchanged` receipt, so parking it deadlocks the
    // engagement. A boundary inside a deferred chain is judged by the chain's
    // cumulative receipt from its original baseline, not by its own step.
    function boundaryExcludesEffect(boundary: PlaybookEffectBoundary): boolean {
      return (
        boundary.logicalOperationId === undefined &&
        (boundary.physicalReceipt?.classification === 'unchanged' || boundary.restored !== undefined)
      );
    }

    function boundaryNeedsSemanticReconciliation(
      candidate: PlaybookEffectBoundary,
      ledger: PlaybookEffectLedger,
    ): boolean {
      if (!runtimeBoundaryIsOwned(candidate)) return false;
      if (boundaryExcludesEffect(candidate)) return false;
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
      if (candidate === undefined || candidate.restored !== undefined || candidate.sourceStateId !== state.stateId) {
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
      if (session === undefined) return [];
      const current = currentEffectLedger();
      effectLedgerMirror = current;
      refreshRetainedEffectReconciliation(current);
      syncDeferredReconciliationOverlay();
      refreshUnresolvedSemanticReconciliation(current);
      return projectUnresolvedEffectEnvelopes(current);
    }

    /**
     * The unresolved envelopes of one already-refreshed ledger mirror. Pure:
     * `describe()` reads it through the control view without moving anything.
     */
    function projectUnresolvedEffectEnvelopes(
      current: PlaybookEffectLedger,
    ): readonly (
      | { readonly kind: 'boundary'; readonly boundaryId: string }
      | { readonly kind: 'logical-operation'; readonly operationId: string }
    )[] {
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

    function pendingHasExactUnchangedOrigin(
      pending: PlaybookPendingBossQuestionContext,
    ): boolean {
      // The outcome menu is not the selected outcome: a source-authored
      // unchanged question may share its state with needsBossReply: deferred.
      // An open operation nevertheless always retains its checkpoint and
      // cumulative receipt authority, even if a later boundary looks alike.
      if (
        runtimeLogicalOperations().some(
          (operation) => operation.logicalReceipt === undefined,
        )
      ) {
        return false;
      }
      const latest = effectLedgerMirror.boundaries
        .filter(runtimeBoundaryIsOwned)
        .at(-1);
      if (
        latest === undefined ||
        latest.sourceStateId !== pending.resumeStateId ||
        pending.asker.kind !== 'role' ||
        latest.roleId !== pending.asker.roleId ||
        latest.logicalOperationId !== undefined ||
        latest.physicalReceipt?.classification !== 'unchanged'
      ) {
        return false;
      }
      // Reuse the persisted authority/receipt check rather than infer an arm
      // from question prose or search older evidence for a convenient match.
      const persisted = persistedBoundaryReconciliation(
        latest,
        effectLedgerMirror,
      );
      if (
        persisted === undefined ||
        persisted.historicalDeferred ||
        persisted.reconciliation.status !== 'resolved'
      ) {
        return false;
      }
      const output = persisted.reconciliation.output;
      const declaration =
        outcomeAuthority.governedPlayerStates[latest.sourceStateId]?.[
          output.guard
        ];
      return (
        declaration?.repositoryDisposition === 'unchanged' &&
        typeof output.question === 'string' &&
        output.question === pending.question
      );
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

    function composeBoundPlayerPrompt(input: PlaybookPlayerInput, resuming = false): string {
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
        return composePlayerPrompt(input, lookup, resuming);
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
                    ...stateIdentity(statusTraceStateId(descriptor)),
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
      // DR-067 §1: the per-call abort classification a parallel machine's
      // player pairs enqueue under; absent, the active boundary's.
      aborts?: AbortReasonClassifier,
    ): Promise<void> {
      try {
        await emitTrace(startedType, identity, position, aborts);
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
            aborts,
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
        { v: 1, playerId: playerId ?? roleId },
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
      cause?: PlaybookFailureCause,
    ): GovernedPlayerSettlement {
      const aborted =
        error !== undefined && signal?.aborted === true
          ? Object.is(error, signal.reason)
          : false;
      const decided = governedSettlementCause(reason, error, aborted, cause);
      if (aborted) {
        failureCauses.retain(error, decided);
        return {
          status: 'unresolved',
          error: attachPlaybookFailureCause(error, decided),
        };
      }
      const failure =
        error instanceof Error
          ? error
          : new Error(`${label} governed outcome remains unresolved: ${reason}`);
      failureCauses.retain(failure, decided);
      return {
        status: 'unresolved',
        error: attachPlaybookFailureCause(
          markFsmResultFailure(failure),
          decided,
        ),
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
      // DR-067 §1 / PBRT-69: a cohort's shared receipt becomes visible for
      // every member in one ledger revision — publishing only this member's
      // spend would leave the invalid half-complete cohort the ledger admits
      // nowhere.
      const cohortMembers =
        current.cohortId === undefined
          ? [current]
          : currentLedger.boundaries.filter(
              ({ cohortId }) => cohortId === current.cohortId,
            );
      const replacements = cohortMembers.map((member) => {
        if (member.boundaryId === current.boundaryId) {
          return { expected: current, next };
        }
        if (
          member.physicalReceipt !== undefined &&
          !isDeepStrictEqual(member.physicalReceipt, receipt)
        ) {
          throw new TypeError(
            `${label} correction budget cohort conflicts with its shared repository receipt`,
          );
        }
        return {
          expected: member,
          next: {
            ...member,
            ...(receipt.after === undefined ? {} : { after: receipt.after }),
            physicalReceipt: receipt,
          },
        };
      }) as [
        { readonly expected: PlaybookEffectBoundary; readonly next: PlaybookEffectBoundary },
        ...{
          readonly expected: PlaybookEffectBoundary;
          readonly next: PlaybookEffectBoundary;
        }[],
      ];
      const acknowledged = assertPlaybookEffectLedger(
        await effectLedgerCapability.writeAhead([
          { kind: 'replace-boundaries', replacements },
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
          unresolvedGovernedSettlement(
            reconciliation.reason,
            undefined,
            undefined,
            reconciliation.cause,
          ),
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
      source: 'runExclusive' | 'runDeferred' | 'runCohort' = 'runExclusive',
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
      } else if (source !== 'runDeferred' && value.deferredStatus !== undefined) {
        throw new TypeError(
          `${label} non-deferred settlement returned a deferred binding status`,
        );
      }
      if (governedSettlement !== undefined) {
        governedSettlementsByBoundaryId.delete(boundaryId);
        governedPlayerSettlements.set(result, governedSettlement);
        // An unresolved settlement over an `unchanged` standalone receipt
        // still throws into the failure state through the player bridge; it
        // just never becomes an effect-possible envelope.
        if (
          governedSettlement.status === 'unresolved' &&
          !boundaryExcludesEffect(completed)
        ) {
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

    let acceptedStepResult: PlaybookRuntimeSnapshot['recoveryCheckpoint'];
    let requiredRecoveryBaseline: PlaybookRepositoryReceipt['baseline'] | undefined;

    function captureRecoveryCheckpoint(stateId: string, prompt: string, boundaryPrefix?: number): void {
      if (requiredRecoveryBaseline !== undefined) return;
      // Capture after the entry emissions drain: the invocation is now a
      // real active child in XState's persisted snapshot, before host work.
      const id = recoveryCheckpoint?.stateId === stateId ? recoveryCheckpoint.id : undefined;
      recoveryCheckpoint = undefined;
      if (!actor || currentState().stateId !== stateId) return;
      try {
        const current = currentEffectLedger();
        recoveryCheckpoint = deepFreeze({
          stateId,
          prompt,
          ...(id === undefined ? {} : { id }),
          machine: detachPersistedMachineSnapshot(actor.getPersistedSnapshot()),
          boundaryPrefix: boundaryPrefix ?? current.boundaries.length,
        });
      } catch {
        // An in-memory-only context is still executable; it simply cannot
        // promise a durable step retry. Keep the legacy control behavior.
      }
    }

    function stepReplayIsSafe(): boolean {
      if (!recoveryCheckpoint || hasUnresolvedReconciliation()) return false;
      const current = currentEffectLedger();
      return current.boundaries
        .slice(recoveryCheckpoint.boundaryPrefix)
        .every(
          (boundary) =>
            runtimeBoundaryIsOwned(boundary) &&
            boundary.logicalOperationId === undefined &&
            (boundary.physicalReceipt?.classification === 'unchanged' || boundary.restored !== undefined),
        );
    }

    function repairableReadOnlyBoundary(): PlaybookEffectBoundary | undefined {
      if (!recoveryCheckpoint || !repositoryCapability?.observe || !repositoryCapability.acquire ||
          retainedEffectReconciliationRequired || deferredReconciliationOperationId !== undefined) return undefined;
      const suffix = currentEffectLedger().boundaries.slice(recoveryCheckpoint.boundaryPrefix);
      if (suffix.length !== 1) return undefined;
      const saved = suffix[0]!;
      if (!runtimeBoundaryIsOwned(saved) || saved.restored !== undefined ||
          saved.sourceStateId !== recoveryCheckpoint.stateId || saved.cohortId !== undefined ||
          saved.logicalOperationId !== undefined || saved.dispositions.some((item) => item !== 'unchanged') ||
          saved.physicalReceipt === undefined || saved.after?.head !== saved.baseline.head ||
          saved.physicalReceipt.classification === 'unchanged' ||
          [...unresolvedSemanticBoundaryIds].some((id) => id !== saved.boundaryId)) return undefined;
      return saved;
    }

    async function confirmReadOnlyRestoration(saved: PlaybookEffectBoundary, signal: AbortSignal): Promise<void> {
      const claim = await repositoryCapability!.acquire!({ signal });
      try {
        await claim.assertOwner();
        const restored = snapshotJsonValue(await repositoryCapability!.observe!()) as unknown as PlaybookRepositoryReceipt['baseline'];
        if (!isDeepStrictEqual(restored, saved.baseline)) {
          throw new Error(`${label} preparation has not restored the stopped step's repository; it remains paused`);
        }
        signal.throwIfAborted();
        effectLedgerMirror = assertPlaybookEffectLedger(await effectLedgerCapability!.writeAhead([
          { kind: 'replace-boundaries', replacements: [{ expected: saved, next: { ...saved, restored } }] },
        ]));
        if (!isDeepStrictEqual(effectLedgerMirror.boundaries.find(({ boundaryId }) => boundaryId === saved.boundaryId)?.restored, restored)) {
          throw new Error(`${label} repository restoration was not durably acknowledged`);
        }
        refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
      } finally { await claim.release(); }
    }

    // A completed commit with saved presentation needs only the missing
    // tool-free judgment. Never repeat the player to recover that evidence.
    function recoverableJudgment(): PlaybookEffectBoundary | undefined {
      if (
        !recoveryCheckpoint || recoveryCheckpoint.result !== undefined || recoveryCheckpoint.delivered ||
        retainedEffectReconciliationRequired ||
        deferredReconciliationOperationId !== undefined
      )
        return undefined;
      const suffix = currentEffectLedger().boundaries.slice(
        recoveryCheckpoint.boundaryPrefix,
      );
      if (suffix.length !== 1) return undefined;
      const saved = suffix[0]!;
      if (
        !runtimeBoundaryIsOwned(saved) ||
        saved.sourceStateId !== recoveryCheckpoint.stateId ||
        saved.logicalOperationId !== undefined ||
        saved.correctionBudget.spent ||
        saved.physicalReceipt?.classification !== 'one-descendant-commit' ||
        !saved.finalText?.trim() ||
        governedOutcomesForBoundary(saved) === undefined ||
        (saved.semanticCandidate !== undefined &&
          persistedBoundaryReconciliation(saved, currentEffectLedger())
            ?.reconciliation.status !== 'resolved') ||
        [...unresolvedSemanticBoundaryIds].some((id) => id !== saved.boundaryId)
      )
        return undefined;
      return saved;
    }

    async function recoverJudgment(
      saved: PlaybookEffectBoundary,
      signal: AbortSignal,
    ): Promise<void> {
      const checkpoint = recoveryCheckpoint!;
      const persisted = checkpoint.machine as unknown as {
        children: Record<string, { snapshot: { input: PlaybookPlayerInput } }>;
      };
      const input = Object.values(persisted.children)[0]!;
      const actorInput = input.snapshot.input;
      const outcomes = governedOutcomesForBoundary(saved)!;
      const candidate =
        saved.semanticCandidate ??
        parseGovernedSemanticCandidate(
          await boundary.callJudge(
            'player-output-adjudication',
            saved.sourceStateId,
            buildGovernedJudgePrompt(actorInput, saved.finalText!, outcomes),
            signal,
          ),
        );
      const result = reconcilePlaybookSemanticEvidence({
        outcomes,
        semanticCandidate: candidate,
        finalText: saved.finalText,
        receipt: saved.physicalReceipt,
      });
      signal.throwIfAborted();
      const next = {
        ...saved,
        semanticCandidate: snapshotJsonValue(result.evidence.semanticCandidate),
      };
      const acknowledged = assertPlaybookEffectLedger(
        await effectLedgerCapability!.writeAhead([
          {
            kind: 'replace-boundaries',
            replacements: [{ expected: saved, next }],
          },
        ]),
      );
      if (
        !isDeepStrictEqual(
          acknowledged.boundaries.find((b) => b.boundaryId === saved.boundaryId),
          next,
        )
      ) {
        throw new Error(
          `${label} recovered judgment was not acknowledged exactly`,
        );
      }
      effectLedgerMirror = acknowledged;
      refreshUnresolvedSemanticReconciliation(acknowledged);
      if (result.status !== 'resolved') {
        const error = attachPlaybookFailureCause(new Error(
          result.status === 'unresolved' && 'reason' in result.cause.evidence && result.cause.evidence.reason
            ? String(result.cause.evidence.reason)
            : `${label} saved result could not be reconciled; the playbook remains parked`,
        ), result.status === 'unresolved' ? result.cause : runtimeDefectCause('Saved result still needs a Boss answer'));
        const paused = detachPersistedMachineSnapshot(actor!.getPersistedSnapshot()) as Record<string, JsonValue>;
        stopActor();
        actor = buildActor(runtimePorts!, {
          ...paused, context: { ...(paused.context as Record<string, JsonValue>), lastError: snapshotJsonValue(normalizeErrorFull(error)) },
        });
        suppressInspectionEmissions = false;
        actor.start();
        throw error;
      }
      await resumeCheckpoint({ ...checkpoint, result: snapshotJsonValue(result.output) });
    }

    async function resumeCheckpoint(checkpoint: NonNullable<PlaybookRuntimeSnapshot['recoveryCheckpoint']>): Promise<void> {
      acceptedStepResult = checkpoint;
      try {
        stopActor();
        actor = buildActor(runtimePorts!, checkpoint.machine);
        suppressInspectionEmissions = false;
        actor.start();
        await waitForPlaybookQuiescence(actor, { pendingCalls: nestedBridge });
      } finally { acceptedStepResult = undefined; }
    }

    function exportRuntimeSnapshot(checkpoint?: { interrupted?: true; child?: PlaybookPendingCall }): PlaybookRuntimeSnapshot | undefined {
        if (!actor || !session || disposed || disposalPromise !== undefined) {
          return undefined;
        }
        if (activeSignal !== undefined && checkpoint === undefined) return undefined;
        if (deferredSettlementClosure !== undefined) return undefined;
        const pendingCall = checkpoint?.child ?? nestedBridge.getPendingCall();
        const bridgeSuspendedCall = checkpoint?.child ? nestedBridge.checkpointCall(checkpoint.child) : nestedBridge.getSuspendedCall();
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
        const interrupted = checkpoint?.interrupted && recoveryCheckpoint && machine.root.states.failed;
        const state = interrupted
          ? normalizePlaybookSnapshot(machine.resolveState({ value: 'failed', context: {} }))
          : checkpoint?.child ? normalizePlaybookSnapshot(actor.getSnapshot(), { pendingCall }) : currentState();
        if (state.status !== 'active' || !state.quiescent) return undefined;
        const context = (actor.getSnapshot() as { context?: unknown })
          .context as Record<string, unknown>;
        // DR-063 §2: the failed state's `lastError` is persisted as every live
        // surface publishes it, completed from the runtime's own cause slot, so
        // a thrown value that refused the cause still explains itself after a
        // restart.
        const machineSnapshot = detachPersistedMachineSnapshot(
          interrupted ? { ...recoveryCheckpoint!.machine as object, value: 'failed', children: {} } : actor.getPersistedSnapshot(),
          state.stateId === 'failed'
            ? { lastError: interrupted ? { name: 'InterruptedStep', message: 'The process stopped during this step. Review the recorded work before choosing how to continue.', cause: runtimeDefectCause('The process stopped during this step. Review the recorded work before choosing how to continue.') } : failedStateError(context ?? {}) }
            : {},
        );
        effectLedgerMirror = currentEffectLedger();
        refreshRetainedEffectReconciliation(effectLedgerMirror);
        syncDeferredReconciliationOverlay();
        refreshUnresolvedSemanticReconciliation(effectLedgerMirror);
        const pendingQuestions = !hasUnresolvedReconciliation()
          ? pendingBossQuestionsFor(state, context ?? {})
          : [];
        const interruptedPrefix = interrupted ? activeEffectLedgerPrefixSequence : undefined;
        const interruptedAttempts = new Set(effectLedgerMirror.boundaries.filter(({ sequence }) => interruptedPrefix !== undefined && sequence > interruptedPrefix).map(({ attemptId }) => attemptId));
        const failedEffectAttempt = interrupted && interruptedPrefix !== undefined && interruptedAttempts.size <= 1
          ? { boundaryPrefix: interruptedPrefix, attemptId: interruptedAttempts.values().next().value ?? null }
          :
          hasGovernedPlayerStates &&
          !interrupted && state.stateId === 'failed' &&
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
          pendingBossQuestions: pendingQuestions.map((pending) => ({
            questionId: pending.questionId,
            asker: pending.asker,
            question: pending.question,
            sourceItem: pending.sourceItem,
          })),
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
          ...((state.stateId === 'failed' || pendingQuestions.length > 0) && recoveryCheckpoint !== undefined
            ? { recoveryCheckpoint } : {}),
          ...(suspendedCall === undefined ? {} : { suspendedCall }),
        };
    }

    async function runJournalledStep(
      kind: PlaybookStepRecord['kind'],
      input: PlaybookPlayerInput | PlaybookCaptainInput | PlaybookScriptInput,
      signal: AbortSignal,
      execute: () => Promise<PlaybookActorOutput>,
    ): Promise<PlaybookActorOutput> {
      const saved = acceptedStepResult;
      let output: PlaybookActorOutput;
      if (saved?.stateId === input.stateId && saved.result !== undefined) {
        acceptedStepResult = undefined;
        recoveryCheckpoint = saved;
        output = snapshotJsonValue(saved.result) as PlaybookActorOutput;
      } else {
        const record = savedPorts?.recordStep;
        await drainEmissions();
        signal.throwIfAborted();
        try {
          captureRecoveryCheckpoint(input.stateId, 'command' in input ? input.command : 'role' in input ? composeBoundPlayerPrompt(input) : composeCaptainPrompt(input));
        } catch (error) {
          if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
          throw error;
        }
        if (record) {
          const id = randomUUID();
          if (recoveryCheckpoint) recoveryCheckpoint = { ...recoveryCheckpoint, id };
          const step = { id, kind, stateId: input.stateId };
          await record(step, exportRuntimeSnapshot({ interrupted: true }));
          signal.throwIfAborted();
          const result = snapshotJsonValue(await execute());
          // Keep the known output if its save loses acknowledgement. A drained
          // failure can then preserve it without treating the call as unexecuted.
          if (recoveryCheckpoint?.id === id) recoveryCheckpoint = { ...recoveryCheckpoint, result };
          await record({ ...step, result });
          output = result as PlaybookActorOutput;
        } else {
          output = await execute();
        }
      }
      if (recoveryCheckpoint?.stateId === input.stateId) {
        const { result: _result, ...start } = recoveryCheckpoint;
        recoveryCheckpoint = { ...start, delivered: true };
      }
      return output;
    }

    function validateRecoveryCheckpoint(
      checkpoint: PlaybookRuntimeSnapshot['recoveryCheckpoint'],
    ): void {
      if (!checkpoint) return;
      const node = machine.root.states[checkpoint.stateId];
      const persisted = checkpoint.machine as Record<string, JsonValue>;
      const children = persisted.children;
      if (
        !node ||
        node.invoke.length !== 1 ||
        !['player', 'captain', 'script'].includes(String(node.invoke[0]!.src)) ||
        !isPlainObject(children) ||
        Object.keys(children).length !== 1
      ) {
        throw new TypeError(
          `${label} recovery checkpoint does not name one current invocation`,
        );
      }
      const child = children[node.invoke[0]!.id] as
        Record<string, JsonValue> | undefined;
      if (
        !child ||
        child.src !== node.invoke[0]!.src ||
        !isPlainObject(child.snapshot) ||
        child.snapshot.status !== 'active' ||
        !isPlainObject(child.snapshot.input) ||
        child.snapshot.input.stateId !== checkpoint.stateId
      ) {
        throw new TypeError(
          `${label} recovery checkpoint invocation is incompatible`,
        );
      }
      if (checkpoint.result !== undefined) {
        const output = checkpoint.result;
        const input = child.snapshot.input;
        if (!isPlainObject(output) || typeof output.guard !== 'string' ||
            !isPlainObject(input.result) || !Object.hasOwn(input.result, output.guard) ||
            (node.invoke[0]!.src === 'script' &&
              (!Number.isInteger(output.exitStatus) || Object.keys(output).sort().join(',') !== 'exitStatus,guard' ||
                output.guard !== Object.keys(input.result)[output.exitStatus === 0 ? 0 : Math.min(1, Object.keys(input.result).length - 1)]))) {
          throw new TypeError(`${label} saved step result is incompatible with its invocation`);
        }
        for (const field of extractFields(String(input.result[output.guard]))) {
          if (output[field] === undefined || output[field] === null) throw new TypeError(`${label} saved step result is missing ${field}`);
        }
      }
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

    // -----------------------------------------------------------------
    // DR-067 §1: the parallel profile's repository cohort. The working
    // leaves of one parallel state entered together run under one
    // `runCohort` claim, each member an `unchanged` boundary: a member's
    // result is adjudicated through the one reconciler in serial, a spent
    // correction rewrites every member's boundary in one acknowledged batch,
    // members are acknowledged and released in completion order, and a
    // member's failure cancels its siblings and fails the cohort with the
    // cause decided first.
    // -----------------------------------------------------------------

    function trackBoundaryCall<T>(call: Promise<T>): Promise<T> {
      if (parallelProfile === undefined) return call;
      activeBoundaryCalls.add(call);
      const forget = (): void => {
        activeBoundaryCalls.delete(call);
      };
      void call.then(forget, forget);
      return call;
    }

    async function drainBoundaryCalls(): Promise<void> {
      while (activeBoundaryCalls.size > 0) {
        await Promise.allSettled([...activeBoundaryCalls]);
      }
    }

    function cohortParallelStateFor(
      stateId: string,
    ): XStateParallelState | undefined {
      const parallelState =
        parallelProfile?.parallelStateByWorkingStateId.get(stateId);
      if (parallelState === undefined) return undefined;
      if (
        consumedCohortBoundaries.get(parallelState.stateId) ===
        publicBoundarySequence
      ) {
        return undefined;
      }
      const pending = pendingCohorts.get(parallelState.stateId);
      if (
        pending !== undefined &&
        pending.boundarySequence === publicBoundarySequence &&
        !pending.started
      ) {
        return parallelState;
      }
      const active = currentState().activeStateIds;
      return parallelState.regions.every(({ workingStateId }) =>
        active.includes(workingStateId),
      )
        ? parallelState
        : undefined;
    }

    function startCohort(
      parallelState: XStateParallelState,
      cohort: PendingCohort,
    ): void {
      cohort.started = true;
      consumedCohortBoundaries.set(
        parallelState.stateId,
        cohort.boundarySequence,
      );
      if (pendingCohorts.get(parallelState.stateId) === cohort) {
        pendingCohorts.delete(parallelState.stateId);
      }
    }

    async function joinCohort(
      parallelState: XStateParallelState,
      member: XStateCohortMember,
    ): Promise<PlayerResult> {
      let cohort = pendingCohorts.get(parallelState.stateId);
      if (
        cohort === undefined ||
        cohort.boundarySequence !== publicBoundarySequence ||
        cohort.started
      ) {
        cohort = {
          boundarySequence: publicBoundarySequence,
          members: new Map(),
          started: false,
        };
        pendingCohorts.set(parallelState.stateId, cohort);
      }
      const registered = cohort;
      if (registered.members.has(member.region.key)) {
        throw new Error(
          `${label} parallel state ${parallelState.stateId} registered region ${member.region.key} twice`,
        );
      }
      registered.members.set(member.region.key, member);
      // A member whose invocation stops before every sibling registered —
      // its region exited, or the boundary aborted — leaves no cohort to
      // run: each registered member settles with its own cancellation and
      // the boundary's cohort is spent.
      const withdraw = (): void => {
        if (registered.started) return;
        startCohort(parallelState, registered);
        for (const candidate of registered.members.values()) {
          candidate.settled.reject(
            candidate.signal.aborted
              ? candidate.signal.reason
              : member.signal.reason,
          );
        }
      };
      if (member.signal.aborted) {
        withdraw();
      } else {
        member.signal.addEventListener('abort', withdraw, { once: true });
      }
      if (
        !registered.started &&
        registered.members.size === parallelState.regions.length
      ) {
        startCohort(parallelState, registered);
        void settleCohort(parallelState, registered);
      }
      return await member.settled.promise;
    }

    async function settleCohort(
      parallelState: XStateParallelState,
      cohort: PendingCohort,
    ): Promise<void> {
      const members = parallelState.regions.map(
        ({ key }) => cohort.members.get(key)!,
      );
      const cancellation = new AbortController();
      const completionOrder: XStateCohortMember[] = [];
      const decided = new Map<
        XStateCohortMember,
        {
          readonly error: unknown;
          readonly cause: PlaybookFailureCause | undefined;
          readonly sequence: number;
        }
      >();
      let decisionSequence = 0;
      // DR-063 §2: each member failure is one decision, ordered as it was
      // decided, with the cause decided for exactly that value at that
      // moment — so a value a sibling later rethrows cannot rename it.
      const decide = (
        member: XStateCohortMember,
        error: unknown,
        cause: PlaybookFailureCause | undefined = failureCauses.causeOf(error),
      ): void => {
        if (decided.has(member)) return;
        decided.set(member, { error, cause, sequence: ++decisionSequence });
      };
      const isCancellation = (error: unknown): boolean =>
        cancellation.signal.aborted &&
        Object.is(error, cancellation.signal.reason) &&
        !activeAborts?.isAbortReason(error);
      const operationFor =
        (member: XStateCohortMember) =>
        async (
          context:
            | { readonly baseline?: PlaybookRepositoryReceipt['baseline'] }
            | undefined,
        ): Promise<PlayerResult> => {
          const callSignal = combineAbortSignals(
            member.signal,
            cancellation.signal,
          );
          try {
            if (activePlayerKeys.has(member.playerKey)) {
              await member.reportCollision(callSignal);
            }
            activePlayerKeys.add(member.playerKey);
            try {
              const result = await member.run(
                callSignal,
                cancellation.signal,
                effectAuthorizedPreExistingBlock(
                  member.effectBoundary,
                  context?.baseline,
                ),
              );
              if (result.status !== 'ok' && !cancellation.signal.aborted) {
                // DR-063 §2: the failure built for a non-`ok` member result
                // carries the cause decided for exactly that result, and its
                // siblings are cancelled with it.
                const cause =
                  resultFailureCauses.get(result) ??
                  runtimeDefectCause(
                    `callPlayer status ${JSON.stringify(result.status)}`,
                  );
                const failure = attachPlaybookFailureCause(
                  markFsmResultFailure(
                    new Error(
                      result.error ??
                        `captainBridge: callPlayer status "${result.status}"`,
                    ),
                  ),
                  cause,
                );
                failureCauses.retain(failure, cause);
                decide(member, failure, cause);
                cancellation.abort(failure);
              }
              return result;
            } finally {
              activePlayerKeys.delete(member.playerKey);
            }
          } catch (error) {
            if (!isCancellation(error)) decide(member, error);
            if (!cancellation.signal.aborted) cancellation.abort(error);
            throw error;
          } finally {
            completionOrder.push(member);
          }
        };
      const completeEffectBoundary = (
        completion: XStateRepositoryCohortCompletion<PlayerResult>,
      ): Promise<XStateRepositoryCompletionEvidence> =>
        cohortCompletionQueue.add(async () => {
          const member = members.find(
            ({ roleId }) => roleId === completion.roleId,
          );
          if (
            member === undefined ||
            completion.boundary.boundaryId !== member.effectBoundary.boundaryId
          ) {
            throw new TypeError(
              `${label} repository cohort completed an undeclared member`,
            );
          }
          const evidence = await completionEvidenceFor(
            member.input,
            member.roleId,
            member.playerId,
            member.signal,
            undefined,
          )(completion);
          const settlement = governedSettlementsByBoundaryId.get(
            member.effectBoundary.boundaryId,
          );
          if (settlement?.status === 'unresolved') {
            decide(member, settlement.error);
          }
          return evidence;
        }) as Promise<XStateRepositoryCompletionEvidence>;
      const runSignal = activeSignal ?? members[0]!.signal;
      const invocationId = randomUUID();
      let settled: XStateRepositoryCohortResult<PlayerResult>;
      try {
        for (const member of members) member.signal.throwIfAborted();
        settled = await repositoryCapability!.runCohort!<PlayerResult>({
          signal: runSignal,
          invocationId,
          roleIds: members.map(({ roleId }) => roleId),
          dispositionsByRole: Object.fromEntries(
            members.map(({ roleId }) => [roleId, ['unchanged'] as const]),
          ),
          effectBoundaries: Object.fromEntries(
            members.map(({ roleId, effectBoundary }) => [
              roleId,
              effectBoundary,
            ]),
          ),
          operations: Object.fromEntries(
            members.map((member) => [member.roleId, operationFor(member)]),
          ),
          completeEffectBoundary,
        });
        if (!isPlainObject(settled) || settled.invocationId !== invocationId) {
          throw new TypeError(
            `${label} repository cohort changed its invocation identity`,
          );
        }
      } catch (error) {
        for (const member of members) {
          governedSettlementsByBoundaryId.delete(
            member.effectBoundary.boundaryId,
          );
          governedCompletionEvidenceByBoundaryId.delete(
            member.effectBoundary.boundaryId,
          );
          refreshGovernedBoundaryStart(member.effectBoundary.boundaryId);
        }
        if (!isAbortFailure(error, runSignal)) controlPlaneError ??= error;
        for (const member of members) member.settled.reject(error);
        return;
      }
      const releaseOrder = [
        ...completionOrder,
        ...members.filter((member) => !completionOrder.includes(member)),
      ];
      const acknowledged = new Map<XStateCohortMember, PlayerResult>();
      const failures = new Map<XStateCohortMember, unknown>();
      for (const member of releaseOrder) {
        const operation = isPlainObject(settled.operations)
          ? settled.operations[member.roleId]
          : undefined;
        try {
          const result = acknowledgeGovernedPlayerResult(
            {
              operation,
              receipt: isPlainObject(settled.receipts)
                ? settled.receipts[member.roleId]
                : undefined,
              effectLedger: settled.effectLedger,
            },
            member.effectBoundary.boundaryId,
            'runCohort',
          );
          acknowledged.set(member, result);
          const settlement = governedPlayerSettlements.get(result);
          if (settlement?.status === 'unresolved') {
            failures.set(member, settlement.error);
          } else if (result.status !== 'ok') {
            failures.set(member, decided.get(member)?.error);
          }
        } catch (error) {
          failures.set(member, error);
          const operationReason =
            isPlainObject(operation) &&
            operation.status === 'rejected' &&
            Object.is(operation.reason, error);
          if (!operationReason) {
            // An acknowledgement the host could not prove is a control-plane
            // defect, exactly as on the exclusive path.
            if (!isAbortFailure(error, runSignal)) controlPlaneError ??= error;
            decide(member, error);
          }
        } finally {
          governedSettlementsByBoundaryId.delete(
            member.effectBoundary.boundaryId,
          );
          governedCompletionEvidenceByBoundaryId.delete(
            member.effectBoundary.boundaryId,
          );
        }
      }
      if (failures.size === 0) {
        for (const member of releaseOrder) {
          member.settled.resolve(acknowledged.get(member)!);
        }
        return;
      }
      for (const result of acknowledged.values()) {
        governedPlayerSettlements.delete(result);
      }
      const first = [...decided.values()].sort(
        (left, right) => left.sequence - right.sequence,
      )[0];
      const failure =
        first?.error ??
        failures.get(releaseOrder.find((member) => failures.has(member))!) ??
        markFsmResultFailure(
          new Error(
            `${label} parallel state ${parallelState.stateId} cohort failed`,
          ),
        );
      const cause = first?.cause ?? failureCauses.causeOf(failure);
      if (cause !== undefined) {
        failureCauses.retain(failure, cause);
        attachPlaybookFailureCause(failure, cause);
      }
      for (const member of members) member.settled.reject(failure);
    }

    const boundary: RuntimeBoundaryCalls = {
      async callPlayer(
        input,
        roleId,
        freshPrompt,
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
        const prompt = selectedResume === false
          ? freshPrompt : composeBoundPlayerPrompt(input, true);
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
        const runTracedPlayerCall = async (
          resume: string | false = selectedResume,
          // DR-062 §4: composed from this call's own baseline observation,
          // so the prompt the trace records is the prompt the player is sent.
          preExistingBlock?: string,
          // DR-067 §1: a cohort member's call signal also carries its
          // cohort's sibling cancellation.
          callSignal: AbortSignal = signal,
          cohortCancellation?: AbortSignal,
        ): Promise<PlayerResult> => {
          const identity = callIdentity(resume);
          // DR-067 §1: a parallel machine classifies aborts per call, so a
          // trace sink rejecting with a sibling's cancellation is forgiven
          // for that call alone.
          const traceAborts =
            parallelProfile === undefined
              ? undefined
              : abortReasonClassifier(callSignal, activeAborts);
          const withPreExisting = (text: string): string =>
            preExistingBlock === undefined
              ? text
              : `${text}\n\n${preExistingBlock}`;
          const callPrompt = withPreExisting(
            resume === false ? freshPrompt : prompt,
          );
          const callFreshPrompt = withPreExisting(freshPrompt);
          await emitCallStarted(
            'player.call.started',
            'player.call.finished',
            { ...identity, prompt: callPrompt },
            position,
            callSignal,
            undefined,
            traceAborts,
          );

          let rawResult: unknown;
          try {
            // An abort may land while the awaited started emission drains
            // (e.g. fired from the trace sink itself); the host call must
            // never start after abort, so settle the already-started pair
            // as `aborted` through the catch below.
            callSignal.throwIfAborted();
            rawResult = await requireHostPorts().callPlayer(
              roleId,
              callPrompt,
              callSignal,
              {
                resume,
                ...(callPrompt === callFreshPrompt
                  ? {}
                  : { freshPrompt: callFreshPrompt }),
              },
            );
            // A host promise is not required to honor cancellation. Do not
            // let a late result mutate continuity or publish a successful
            // finish.
            callSignal.throwIfAborted();
          } catch (error) {
            if (!isAbortFailure(error, callSignal)) controlPlaneError ??= error;
            try {
              await emitTrace(
                'player.call.finished',
                {
                  ...identity,
                  status: isAbortFailure(error, callSignal)
                    ? 'aborted'
                    : 'error',
                  error: normalizeError(error),
                },
                position,
                traceAborts,
              );
            } catch {
              // The original non-abort port rejection remains authoritative.
            }
            // A thrown port call carries no authoritative result, so the
            // prior token remains available for a later explicit resume.
            throw decidePlayerCallFailure(
              error,
              roleId,
              playerId,
              callSignal,
              cohortCancellation,
            );
          }

          let result: PlayerResult;
          try {
            result = validatePlayerResult(rawResult);
          } catch (error) {
            if (!isAbortFailure(error, callSignal)) controlPlaneError ??= error;
            try {
              await emitTrace(
                'player.call.finished',
                { ...identity, status: 'error', error: normalizeError(error) },
                position,
                traceAborts,
              );
            } catch {
              // The malformed host result remains authoritative.
            }
            throw decidePlayerCallFailure(
              error,
              roleId,
              playerId,
              callSignal,
              cohortCancellation,
            );
          }

          try {
            updatePlayerResume(roleId, playerId, result);
          } catch (error) {
            if (!isAbortFailure(error, callSignal)) controlPlaneError ??= error;
            try {
              await emitTrace(
                'player.call.finished',
                { ...identity, status: 'error', error: normalizeError(error) },
                position,
                traceAborts,
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
            traceAborts,
          );
          // DR-063 §2: the player bridge builds the failure Error for a
          // non-`ok` result, so the cause is decided here, where the role,
          // the player, and the reported error are known, and a successful
          // result clears it so no later failure inherits it.
          if (result.status === 'ok') {
            pendingResultFailureCause = undefined;
          } else if (result.status === 'aborted') {
            pendingResultFailureCause = ABORTED_FAILURE_CAUSE;
          } else {
            pendingResultFailureCause = playerFailureCause({
              roleId,
              ...(playerId === undefined ? {} : { playerId }),
              error:
                result.error ??
                `callPlayer status ${JSON.stringify(result.status)}`,
            });
          }
          if (pendingResultFailureCause !== undefined) {
            resultFailureCauses.set(result, pendingResultFailureCause);
          }
          return result;
        };
        const reportPlayerKeyCollision = async (
          callSignal: AbortSignal,
        ): Promise<never> => {
          const error = new Error(
            `simultaneous calls to player key ${playerKey} are not allowed`,
          );
          const traceAborts =
            parallelProfile === undefined
              ? undefined
              : abortReasonClassifier(callSignal, activeAborts);
          await emitCallStarted(
            'player.call.started',
            'player.call.finished',
            { ...callIdentity(selectedResume), prompt },
            position,
            callSignal,
            undefined,
            traceAborts,
          );
          await emitTrace(
            'player.call.finished',
            {
              ...callIdentity(selectedResume),
              status: 'error',
              error: normalizeError(error),
            },
            position,
            traceAborts,
          );
          throw error;
        };

        // DR-067 §1: the working leaves of one parallel state entered
        // together run as one all-`unchanged` repository cohort, at most once
        // per public boundary; a corrective re-ask and a single region
        // resuming after its Boss reply take the exclusive path below.
        const cohortState =
          deferredContinuation === undefined
            ? cohortParallelStateFor(input.stateId)
            : undefined;
        if (cohortState !== undefined) {
          const effectBoundary = governedBoundarySeed(
            input,
            roleId,
            callId,
            turnId,
          );
          if (
            effectBoundary === undefined ||
            repositoryCapability?.runCohort === undefined
          ) {
            throw new Error(
              `${label} parallel state ${cohortState.stateId} requires governed player states and repository.runCohort`,
            );
          }
          activeGovernedBoundarySeen = true;
          return await joinCohort(cohortState, {
            region: cohortState.regions.find(
              ({ workingStateId }) => workingStateId === input.stateId,
            )!,
            input,
            roleId,
            playerId,
            playerKey,
            signal,
            effectBoundary,
            run: (callSignal, cohortCancellation, preExistingBlock) =>
              runTracedPlayerCall(
                selectedResume,
                preExistingBlock,
                callSignal,
                cohortCancellation,
              ),
            reportCollision: reportPlayerKeyCollision,
            settled: deferredValue<PlayerResult>(),
          });
        }

        if (activePlayerKeys.has(playerKey)) {
          await reportPlayerKeyCollision(signal);
        }
        activePlayerKeys.add(playerKey);

        try {
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
                effectAuthorizedPreExistingBlock(
                  effectBoundary,
                  deferredContinuation.baseline,
                ),
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
              // DR-062 §4: the call's own baseline, supplied by the host that
              // captured it under this exclusive claim. A host that supplies
              // none states no pre-existing change, exactly as an empty
              // baseline projection does.
              operation: async (context) => {
                if (requiredRecoveryBaseline !== undefined) {
                  if (!isDeepStrictEqual(snapshotJsonValue(context.baseline), requiredRecoveryBaseline)) {
                    throw new Error(`${label} repository changed after preparation; the stopped step remains paused`);
                  }
                  requiredRecoveryBaseline = undefined;
                  captureRecoveryCheckpoint(input.stateId, freshPrompt,
                    currentEffectLedger().boundaries.findIndex(({ boundaryId }) => boundaryId === effectBoundary.boundaryId));
                }
                return runTracedPlayerCall(
                  selectedResume,
                  effectAuthorizedPreExistingBlock(
                    effectBoundary,
                    context?.baseline,
                  ),
                );
              },
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

      markPlayerResultFailure(error, result): Error {
        const cause =
          (result === undefined ? undefined : resultFailureCauses.get(result)) ??
          pendingResultFailureCause;
        if (cause === undefined) return error;
        failureCauses.retain(error, cause);
        return attachPlaybookFailureCause(error, cause);
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
            purpose === 'player-output-adjudication' &&
            stateId !== undefined &&
            outcomeAuthority.governedPlayerStates[stateId] !== undefined;
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
    if (parallelProfile !== undefined) {
      // DR-067 §1: a parallel machine's boundary drain waits for every player
      // and judge call it started.
      const untrackedCallPlayer = boundary.callPlayer;
      const untrackedCallJudge = boundary.callJudge;
      boundary.callPlayer = (input, roleId, freshPrompt, signal) =>
        trackBoundaryCall(untrackedCallPlayer(input, roleId, freshPrompt, signal));
      boundary.callJudge = (purpose, stateId, prompt, signal) =>
        trackBoundaryCall(untrackedCallJudge(purpose, stateId, prompt, signal));
    }

    function playerActor(
      ports: PlaybookPorts,
    ): PromiseActorLogic<PlaybookActorOutput, PlaybookPlayerInput> {
      return createPlayerBridge(
        {
          run: (input, signal, execute) => runJournalledStep('player', input, signal, execute),
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
        ({ input, signal }) => runJournalledStep('captain', input, signal, async () => {
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
        }),
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
        ({ input, signal }) => runJournalledStep('script', input, signal, async () => {
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
        }),
      );
    }

    const nestedBridge = createNestedPlaybookBridge({
      nextCallId: () => `playbook-${++playbookCallSequence}`,
      getBoundarySignal: () => activeSignal,
      callPlaybook: (request, signal) => {
        const call = requireHostPorts().callPlaybook(request, signal);
        return parallelProfile === undefined
          ? call
          : trackBoundaryCall(Promise.resolve(call));
      },
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
        if (parallelProfile === undefined) actorSettlementAborts.length = 0;
        actorSettlementAborts.push(aborts);
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

    // DR-063 §2: the parked failure's error as every public surface publishes
    // it — the FSM's own `lastError`, completed with the cause decided where
    // the failure was decided. An error that already carries a valid cause
    // keeps it; an artifact-built error takes the runtime's own slot; anything
    // else is a runtime defect carrying its message. There is no failure
    // without a cause.
    function failedStateError(
      context: Record<string, unknown>,
    ): NormalizedError | undefined {
      const normalized: NormalizedError | undefined = normalizeErrorFull(
        context.lastError,
      );
      if (normalized === undefined || normalized.cause !== undefined) {
        return normalized;
      }
      return {
        ...normalized,
        cause:
          failureCauses.causeOf(context.lastError) ??
          runtimeDefectCause(normalized.message),
      };
    }

    // DR-063 §2: the failure that parks the machine is the error its parking
    // transition carried, but a compiled machine keeps a JSON-safe record of
    // it as `lastError` (gears2fsm requires JSON-safe context), so neither
    // that value's identity nor its marker reaches the failed state. The cause
    // decided for the carried error is retained under the value the machine
    // kept, so every surface of this turn and of each later one publishes the
    // runtime's own decision for as long as that failure stands. A kept value
    // that already answers keeps its cause.
    function bindParkedFailureCause(
      context: Record<string, unknown>,
      event: unknown,
    ): void {
      const kept = context.lastError;
      if (kept === undefined || kept === null) return;
      if (failureCauses.causeOf(kept) !== undefined) return;
      const decided = failureCauses.causeOf(actorErrorOf(event));
      if (decided !== undefined) failureCauses.retain(kept, decided);
    }

    // DR-063 §2: a rejected player port or a result the runtime cannot read is
    // a `player-failed` failure named by role; an abort is `aborted`. A
    // cancellation the runtime itself issued to a cohort member because its
    // sibling failed is not this player's failure and decides nothing, so the
    // originator's cause stands (DR-067 §1, playbook-55).
    function decidePlayerCallFailure(
      error: unknown,
      roleId: string,
      playerId: string | undefined,
      signal: AbortSignal,
      cohortCancellation?: AbortSignal,
    ): unknown {
      if (
        cohortCancellation?.aborted === true &&
        Object.is(error, cohortCancellation.reason) &&
        !activeAborts?.isAbortReason(error)
      ) {
        return error;
      }
      const cause = isAbortFailure(error, signal)
        ? ABORTED_FAILURE_CAUSE
        : playerFailureCause({
            roleId,
            ...(playerId === undefined ? {} : { playerId }),
            error,
          });
      failureCauses.retain(error, cause);
      return attachPlaybookFailureCause(error, cause);
    }

    function completeFailedStatuses(
      statuses: readonly ScheduledStatus[],
      state: PlaybookState,
      context: Record<string, unknown>,
    ): readonly ScheduledStatus[] {
      if (state.stateId !== 'failed') return statuses;
      const lastError = failedStateError(context);
      if (lastError?.cause === undefined) return statuses;
      const cause = lastError.cause as unknown as JsonValue;
      return statuses.map((status) => {
        const data = status.data;
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          return status;
        }
        const recorded = data as { readonly [key: string]: JsonValue };
        const recordedError = recorded.lastError;
        if (
          recordedError === undefined ||
          recordedError === null ||
          typeof recordedError !== 'object' ||
          Array.isArray(recordedError)
        ) {
          return status;
        }
        return {
          ...status,
          data: snapshotJsonValue(
            { ...recorded, lastError: { ...recordedError, cause } },
            'failed status data',
          ),
        };
      });
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
      if (parallelProfile === undefined) {
        const pendingBossQuestion = pendingBossQuestionForState(state, context);
        if (
          pendingBossQuestion !== undefined &&
          !hasUnresolvedReconciliation()
        ) {
          payload.pendingBossQuestion = pendingBossQuestion;
        }
      } else if (!hasUnresolvedReconciliation()) {
        // DR-067 §1: a parallel machine's telemetry carries every question
        // pending in an active wait, in the plural.
        const pendingBossQuestions = pendingBossQuestionsFor(state, context);
        if (pendingBossQuestions.length > 0) {
          payload.pendingBossQuestions = pendingBossQuestions;
        }
      }
      if (state.stateId === 'failed') {
        const lastError = failedStateError(context);
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
            ...stateIdentity(statusTraceStateId(state)),
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
      const aborts = actorSettlementAborts.shift() ?? actorSettlementErrorAborts;
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
            if (
              state.stateId === undefined &&
              !(
                parallelProfile?.states.some(({ stateId }) =>
                  state.activeStateIds.includes(stateId),
                ) ?? false
              )
            ) {
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
              if (previousState?.stateId !== 'failed' &&
                  previousState?.stateId !== recoveryCheckpoint?.stateId) {
                recoveryCheckpoint = undefined;
              }
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
            if (state.stateId === 'failed') {
              bindParkedFailureCause(context, inspectionEvent.event);
            }
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
            const stateStatuses = completeFailedStatuses(
              bossRelevantStateIds !== undefined && usesDefaultStatuses
                ? parallelStatusesFor(previousState, state, context)
                : statusesForState(state, context, inspectionEvent.event),
              state,
              context,
            );
            const outcomeStatuses = usesDefaultStatuses
              ? acceptedOutcomes.map(({ acceptedOutcome }) => ({
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
        // DR-048: the reached final state's compiled terminal meaning, read
        // from the artifact. It is withheld exactly when the published
        // description is, so an unresolved reconciliation publishes no
        // terminal meaning at all.
        const terminal =
          hasUnresolvedReconciliation() || state.stateId === undefined
            ? undefined
            : terminalOutcomeFor(state.stateId, stateDescription);
        return {
          outcome,
          state,
          ...(stateDescription === undefined ? {} : { stateDescription }),
          ...(terminal === undefined ? {} : { terminal }),
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
      if (failure === undefined) return { outcome, state };
      // DR-063 §2: a `failed` settlement publishes the same cause-completed
      // error the failed state's status line and telemetry publish.
      const normalized =
        outcome === 'failed'
          ? failedStateError({ lastError: failure })
          : normalizeError(failure);
      return {
        outcome,
        state,
        ...(normalized === undefined ? {} : { error: normalized }),
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
      pendingCohorts.clear();
      consumedCohortBoundaries.clear();
      activeBoundaryCalls.clear();
      cohortCompletionQueue.clear();
      actor = undefined;
      session = undefined;
      savedPorts = undefined;
      runtimePorts = undefined;
      activeSignal = undefined;
      activeAborts = undefined;
      actorSettlementAborts.length = 0;
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
      recoveryCheckpoint = undefined;
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
      retryStep?: true;
      retryJudgment?: PlaybookEffectBoundary;
      restoreReadOnly?: PlaybookEffectBoundary;
    }

    function snapshotCan(snapshot: unknown, event: EventObject): boolean {
      const can = (snapshot as { can?: unknown } | null)?.can;
      return (
        typeof can === 'function' &&
        (can as (candidate: EventObject) => boolean).call(snapshot, event) ===
          true
      );
    }

    function retryActionFor(stateId: string | undefined): DerivedControlAction | undefined {
      if (stateId !== 'failed' || !recoveryCheckpoint) return undefined;
      const description = stateDescriptions.get(recoveryCheckpoint.stateId);
      const savedResult = recoveryCheckpoint.result !== undefined;
      const safe = savedResult
        ? !hasUnresolvedReconciliation() && currentEffectLedger().boundaries.slice(recoveryCheckpoint.boundaryPrefix)
          .every((boundary) => runtimeBoundaryIsOwned(boundary) && boundary.sourceStateId === recoveryCheckpoint!.stateId)
        : stepReplayIsSafe();
      if (description === undefined || !safe) return undefined;
      const entry = spec.entryEvent;
      const target = entry && firstTransitionTarget(machine, stateId, entry.type);
      return {
        action: {
          id: target === recoveryCheckpoint.stateId ? `retry:${entry!.type}` : 'retry:step',
          label: `${savedResult ? 'Continue from saved result' : 'Retry'}: ${description}`,
          standing: 'ready',
        },
        retryStep: true,
      };
    }

    /**
     * DR-063 §3: reconciliation only re-reads the host's ledger, which the
     * control view has just done. Where no checkpoint restoration is eligible
     * and every unresolved envelope's boundary already holds a complete
     * receipt, re-reading can resolve nothing, so the action is a no-op.
     */
    function reconciliationStanding(
      deferredRestoreOperationId: string | undefined,
    ): Pick<PlaybookControlAction, 'standing' | 'reason'> {
      if (deferredRestoreOperationId !== undefined) return { standing: 'ready' };
      const current = effectLedgerMirror;
      const envelopes = projectUnresolvedEffectEnvelopes(current);
      if (envelopes.length === 0) return { standing: 'ready' };
      const boundaryIds = envelopes.flatMap((envelope) =>
        envelope.kind === 'boundary'
          ? [envelope.boundaryId]
          : (current.logicalOperations.find(
              ({ operationId }) => operationId === envelope.operationId,
            )?.boundaryIds ?? []),
      );
      if (boundaryIds.length === 0) return { standing: 'ready' };
      const complete = boundaryIds.every(
        (boundaryId) =>
          current.boundaries.find(
            (candidate) => candidate.boundaryId === boundaryId,
          )?.physicalReceipt !== undefined,
      );
      return complete
        ? { standing: 'no-op', reason: 'receipt-complete' }
        : { standing: 'ready' };
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
      const repairable = state.stateId === 'failed' ? repairableReadOnlyBoundary() : undefined;
      if (repairable !== undefined) derived.push({
        action: { id: 'retry:restored-step', label: 'Restore the repository and retry the read-only step', standing: 'ready' },
        retryStep: true,
        restoreReadOnly: repairable,
      });
      const judgment = state.stateId === 'failed' ? recoverableJudgment() : undefined;
        if (judgment !== undefined) derived.push({
          action: { id: 'retry:adjudication', label: 'Retry assessment of the saved result', standing: 'ready' },
          retryJudgment: judgment,
        });
      if (judgment !== undefined && !hasUnresolvedReconciliation()) return derived;
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
              ...reconciliationStanding(deferredRestoreOperationId),
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
              // DR-063 §3: abandonment always changes the session's standing.
              standing: 'ready',
            },
            unresolvedEffectAction: 'abandon',
          },
        );
        return derived;
      }
      const retry = retryActionFor(state.stateId);
      if (retry !== undefined) derived.push(retry);
      // A jump can repeat earlier work, unlike checkpoint retry. Its whole
      // failed attempt must therefore still pass the replay fence.
      if (state.stateId === 'failed' && !failedAttemptAllowsReplay()) {
        return derived;
      }
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
            // DR-063 §3: a jump always moves the machine.
            standing: 'ready',
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
      // DR-067 §1: inside a parallel state, the meaning published is the
      // root state's — the parallel parent's own description.
      const keys = [
        ...(state.stateId === undefined ? [] : [state.stateId]),
        ...(typeof state.value === 'string' ? [state.value] : []),
        ...(isPlainObject(state.value) ? Object.keys(state.value) : []),
        ...state.activeStateIds,
      ];
      for (const key of keys) {
        const description = stateDescriptions.get(key);
        if (description !== undefined) return description;
      }
      return undefined;
    }

    // DR-048: the public terminal record for a reached final state, present
    // only for an artifact that declares that state's kind.
    function terminalOutcomeFor(
      stateId: string,
      description: string | undefined,
    ): PlaybookTerminalOutcome | undefined {
      const kind = terminalKinds.get(stateId);
      if (kind === undefined) return undefined;
      return {
        stateId,
        kind,
        ...(description === undefined ? {} : { description }),
      };
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
      validateRecoveryCheckpoint(boundSnapshot.recoveryCheckpoint);
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
        recoveryCheckpoint = boundSnapshot.recoveryCheckpoint;
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
          ? singlePendingBossQuestion(state, context)
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
      onAccepted?: () => void,
    ): Promise<'continued' | 'unresolved'> {
      if (repositoryCapability === undefined) {
        throw new Error(
          `${label} deferred continuation requires repository.runDeferred`,
        );
      }
      const effectBoundary = continuationBoundarySeed(operation, turnId);
      const boundPlayerId = resolvedPlayerId(effectBoundary.roleId);
      const validateBinding = (value: unknown): void => {
        if (!isPlainObject(value) || Object.keys(value).length !== 2 ||
            value.v !== 1 ||
            value.playerId !== (boundPlayerId ?? effectBoundary.roleId)) {
          throw new TypeError(`${label} bound deferred player continuation is invalid`);
        }
      };
      validateBinding(operation.playerContinuation);
      const continuation: NonNullable<typeof activeDeferredContinuation> = {
        operationId: operation.operationId,
        effectBoundary,
        rawPlayerSettled: deferredValue<void>(),
        delivery: deferredValue<PlayerResult>(),
      };
      activeDeferredContinuation = continuation;
      // Emissions are buffered only until the host durably starts the
      // continuation: an exit that starts no player (checkpoint mismatch,
      // ineligible operation) publishes nothing, so the bound wait it
      // preserves is never contradicted by a classification line.
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
          operation: async (context) => {
            const { playerContinuation } = context ?? {};
            validateBinding(playerContinuation);
            // DR-062 §4: the continuation's own baseline, captured before the
            // FSM re-enters the bound player state that reads it.
            continuation.baseline = context?.baseline;
            continuation.playerContinuation = selectPlayerResume(
              effectBoundary.roleId, boundPlayerId,
            );
            continuationStarted = true;
            onAccepted?.();
            actor!.send(event);
            // The host has durably started this boundary and the FSM has
            // moved: publish the buffered classification line and the
            // authored transition now, and let every later transition,
            // accepted outcome, and status emit inline. Holding them until
            // the operation settled put the cause after its effects — the
            // player call, the nested call a target state starts, and their
            // finishes were traced and sequenced first (PBRT-37).
            settleDeferredInspectionBuffer(true);
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
        const pending = singlePendingBossQuestion(state, context);
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
      exportSnapshot: (checkpoint?: { child?: PlaybookPendingCall }) => exportRuntimeSnapshot(checkpoint?.child ? { child: checkpoint.child } : undefined),

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
      // engagement identity and counter lineage, exposed separately so a
      // capability-less runtime can omit it. Runtime-visible preflight
      // mismatches reject before effects; after preflight the new
      // session.started boundary owns failed-start cleanup just like init.
      // DR-067 §2: retained-snapshot adoption stays in the flat domain, so a
      // machine that declares a parallel state omits the member.
      ...(parallelProfile === undefined
        ? {
            async adopt(
              nextSession: PlaybookSession,
              snapshot: PlaybookRuntimeSnapshot,
              context: PlaybookAdoptionContext,
            ): Promise<void> {
              await rehydrateSnapshot('adopt', nextSession, snapshot, context);
            },
          }
        : {}),

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
        const pendingQuestions = !hasUnresolvedReconciliation()
          ? pendingBossQuestionsFor(state, context)
          : [];
        const lastError =
          state.stateId === 'failed'
            ? failedStateError(context)
            : normalizeErrorFull(context.lastError);
        const projectedContext = projectControlContext(context);
        const stateDescription =
          !hasUnresolvedReconciliation()
            ? stateDescriptionFor(state)
            : undefined;
        const actions = deriveControlActions(snapshot).map(({ action }) => action);
        const retry = actions.find(({ id, standing }) =>
          id.startsWith('retry:') &&
          (standing ?? 'ready') === 'ready');
        const stoppedBoundary = recoveryCheckpoint === undefined ? undefined :
          currentEffectLedger().boundaries.slice(recoveryCheckpoint.boundaryPrefix)
            .filter((boundary) => runtimeBoundaryIsOwned(boundary) && boundary.sourceStateId === recoveryCheckpoint!.stateId).at(-1);
        const recovery = recoveryCheckpoint === undefined ||
          (pendingQuestions.length === 0 && retry === undefined) ? undefined : {
            prompt: recoveryCheckpoint.prompt,
            ...(stoppedBoundary === undefined ? {} : { evidence: snapshotJsonValue({
              declaredResults: stoppedBoundary.sourceOutcomeSchema,
              ...(stoppedBoundary.finalText === undefined ? {} : { savedPlayerText: stoppedBoundary.finalText }),
              ...(stoppedBoundary.semanticCandidate === undefined ? {} : { selectedResult: stoppedBoundary.semanticCandidate }),
              ...(stoppedBoundary.physicalReceipt === undefined ? {} : { repositoryReceipt: stoppedBoundary.physicalReceipt }),
            }) }),
            ...(repairableReadOnlyBoundary() === undefined ? {} : {
              preparation: `This read-only step changed the repository. Restore its exact original HEAD and visible files before retrying; do not accept its saved result. Preserve user work. You may put generated outputs aside and prevent their return using local environment or ignore settings. Original observation: ${JSON.stringify(repairableReadOnlyBoundary()!.baseline)}. Observed after the failed step: ${JSON.stringify(repairableReadOnlyBoundary()!.after)}.`,
            }),
            ...(stateDescriptions.get(recoveryCheckpoint.stateId) === undefined ? {} :
              { description: stateDescriptions.get(recoveryCheckpoint.stateId)! }),
            continuation: pendingQuestions.length === 0
              ? { kind: 'runtime' as const, actionId: retry!.id }
              : { kind: 'reply' as const },
          };
        return deepFreeze({
          state,
          ...(stateDescription === undefined ? {} : { stateDescription }),
          ...(projectedContext !== undefined
            ? { context: projectedContext }
            : {}),
          pendingQuestions: pendingQuestions.map((pending) => ({
            questionId: pending.questionId,
            asker: pending.asker,
            question: pending.question,
            sourceItem: pending.sourceItem,
          })),
          ...(lastError !== undefined ? { lastError } : {}),
          actions,
          ...(recovery === undefined ? {} : { recovery }),
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
        publicBoundarySequence += 1;
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
                if (candidate.retryJudgment !== undefined) {
                  await recoverJudgment(candidate.retryJudgment, signal);
                  run = runResultFor(settledOutcome(signal));
                } else if (candidate.unresolvedEffectAction === 'abandon') {
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
                } else if (candidate.retryStep) {
                  if (candidate.restoreReadOnly !== undefined) {
                    await confirmReadOnlyRestoration(candidate.restoreReadOnly, signal);
                  }
                  const checkpoint = recoveryCheckpoint!;
                  requiredRecoveryBaseline = currentEffectLedger().boundaries
                    .slice(checkpoint.boundaryPrefix).find(({ restored }) => restored !== undefined)?.restored;
                  try {
                    await resumeCheckpoint(checkpoint);
                  } finally {
                    requiredRecoveryBaseline = undefined;
                  }
                  run = runResultFor(settledOutcome(signal));
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
                        run,
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
          if (parallelProfile !== undefined) await drainBoundaryCalls();
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
        onAccepted,
      }: {
        text: string;
        signal: AbortSignal;
        onAccepted?: () => void;
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
        publicBoundarySequence += 1;
        beginAutomaticReplayBoundary();
        activeSignal = signal;
        activeAborts = abortReasonClassifier(signal);
        activeAbortEmission = undefined;
        controlPlaneError = undefined;
        // DR-063 §2: each turn decides its own failures, so no pending result
        // cause carries into this one; a cause decided for a parked failure
        // stays bound to that failure.
        pendingResultFailureCause = undefined;
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
              deferredPending = singlePendingBossQuestion(
                normalizePlaybookSnapshot(snapshot),
                snapshotContext,
              );
              pendingRequiresDeferredBinding =
                deferredPending !== undefined &&
                outcomeAuthority?.governedPlayerStates[
                  deferredPending.resumeStateId
                ]?.needsBossReply?.repositoryDisposition === 'deferred' &&
                !pendingHasExactUnchangedOrigin(deferredPending);
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
                  onAccepted,
                );
                if (continuation === 'continued') {
                  if (controlPlaneError !== undefined) {
                    throw controlPlaneError;
                  }
                  result = runResultFor(
                    !hasUnresolvedReconciliation()
                      ? settledOutcome(signal)
                      : 'no-action',
                  );
                } else {
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
              onAccepted?.();
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

          if (parallelProfile !== undefined) await drainBoundaryCalls();
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
        publicBoundarySequence += 1;
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
          if (parallelProfile !== undefined) await drainBoundaryCalls();
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
            pendingCohorts.clear();
            consumedCohortBoundaries.clear();
            activeBoundaryCalls.clear();
            cohortCompletionQueue.clear();
            actor = undefined;
            activeSignal = undefined;
            activeAborts = undefined;
            actorSettlementAborts.length = 0;
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
