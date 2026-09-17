// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Public runtime contract for @sublang/playbook — the type-only single
// source for the PlaybookPorts / PlaybookRuntime contract authored in
// slc/link.md. It imports no CODE or FSM types, so the dependency runs
// one way: linked playbook runtimes (e.g. code.playbook.ts) import and
// re-export these names rather than redefining them
// (PBRT-5, PBRT-34, DR-004 Addendum A4).

export interface PlayerResult {
  status: 'ok' | 'aborted' | 'error';
  resumeToken?: string;
  finalText?: string;
  error?: string;
}

export interface PlayerCallOptions {
  resume: string | false;
  /** Complete task and clarification context if the host must start fresh. */
  freshPrompt?: string;
}

// DR-032: a composing host may supply one frame-local role view of the
// Captain session's player continuation. The runtime selects through this store
// before tracing/calling and updates it from the validated result. Hosts that
// omit it retain the runtime's private per-session store.
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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// DR-063 §1: the closed list of failure codes. There is no unknown code — an
// unrecognized failure is `runtime-defect` carrying its message as `reason` —
// so a host catalogue is complete exactly when it covers this list.
export const PLAYBOOK_FAILURE_CODES = [
  'commit-missing',
  'commit-residual',
  'pre-existing-lost',
  'commits-more-than-one',
  'history-rewritten',
  'foreign-change',
  'observation-unstable',
  'attribution-ambiguous',
  'receipt-missing',
  'judge-failed',
  'player-failed',
  'aborted',
  'child-failed',
  'runtime-defect',
] as const;

export type PlaybookFailureCode = (typeof PLAYBOOK_FAILURE_CODES)[number];

/** The bounded path lists one failure code's evidence may carry (DR-063 §1). */
export interface PlaybookFailurePaths {
  /** Paths changed in the worktree that no commit carries. */
  readonly uncommitted?: readonly string[];
  /** Pre-existing baseline paths the call changed before committing. */
  readonly altered?: readonly string[];
  /** Pre-existing baseline paths whose content is nowhere. */
  readonly lost?: readonly string[];
  /** Paths whose entry differs or is missing on either side. */
  readonly changed?: readonly string[];
  /** Paths omitted from the lists above by the 32-path bound. */
  readonly truncated?: number;
}

/** The bounded error record a failure cause may carry (DR-063 §1). */
export interface PlaybookFailureErrorEvidence {
  readonly name: string;
  readonly message: string;
}

/** The closed evidence object of one failure cause (DR-063 §1). */
export interface PlaybookFailureEvidence {
  readonly required?: PlaybookRepositoryDisposition;
  readonly observed?: PlaybookRepositoryReceipt['classification'];
  readonly baselineHead?: string;
  readonly afterHead?: string;
  readonly commitOid?: string;
  readonly paths?: PlaybookFailurePaths;
  readonly reason?: string;
  readonly error?: PlaybookFailureErrorEvidence;
  readonly errorCode?: string;
  readonly roleId?: string;
  readonly playerId?: string;
  readonly playbookId?: string;
  readonly cause?: PlaybookFailureCause;
}

/**
 * Why a parked workflow failed (DR-063 §1): one code from the closed list and
 * the closed evidence object that code names. Evidence holds repository paths,
 * dispositions, classifications, and revision identities only — never file
 * content, player prose, or internal call and session identities.
 */
export interface PlaybookFailureCause {
  readonly code: PlaybookFailureCode;
  readonly evidence: PlaybookFailureEvidence;
}

/** Evidence members admitted for each code, in the order a sentence reads them. */
const FAILURE_EVIDENCE_MEMBERS: Readonly<
  Record<
    PlaybookFailureCode,
    {
      readonly required: readonly string[];
      readonly optional: readonly string[];
      readonly paths: readonly (keyof PlaybookFailurePaths)[];
    }
  >
> = {
  'commit-missing': {
    required: ['required', 'observed', 'baselineHead', 'afterHead', 'paths'],
    optional: [],
    paths: ['uncommitted'],
  },
  'commit-residual': {
    required: ['required', 'observed', 'baselineHead', 'afterHead', 'paths'],
    optional: ['commitOid'],
    paths: ['uncommitted', 'altered'],
  },
  'pre-existing-lost': {
    required: ['required', 'observed', 'baselineHead', 'paths'],
    optional: ['afterHead'],
    paths: ['lost'],
  },
  'commits-more-than-one': {
    required: ['required', 'observed', 'baselineHead', 'afterHead'],
    optional: [],
    paths: [],
  },
  'history-rewritten': {
    required: ['required', 'observed', 'baselineHead', 'afterHead'],
    optional: [],
    paths: [],
  },
  'foreign-change': {
    required: ['required', 'observed', 'baselineHead', 'afterHead', 'paths'],
    optional: [],
    paths: ['changed'],
  },
  'observation-unstable': {
    required: ['required', 'observed', 'baselineHead'],
    optional: [],
    paths: [],
  },
  'attribution-ambiguous': {
    required: ['required', 'observed', 'baselineHead'],
    optional: ['afterHead'],
    paths: [],
  },
  'receipt-missing': { required: ['baselineHead'], optional: [], paths: [] },
  'judge-failed': { required: ['reason'], optional: ['error'], paths: [] },
  'player-failed': {
    required: ['roleId', 'error'],
    optional: ['playerId', 'errorCode'],
    paths: [],
  },
  aborted: { required: [], optional: [], paths: [] },
  'child-failed': { required: ['playbookId'], optional: ['cause'], paths: [] },
  'runtime-defect': { required: ['reason'], optional: [], paths: [] },
};

const FAILURE_PATH_LIMIT = 32;
const FAILURE_CAUSE_DEPTH_LIMIT = 4;

const REPOSITORY_DISPOSITIONS: readonly PlaybookRepositoryDisposition[] = [
  'unchanged',
  'one-descendant-commit',
  'deferred',
];

const RECEIPT_CLASSIFICATIONS: readonly PlaybookRepositoryReceipt['classification'][] =
  [
    'unchanged',
    'one-descendant-commit',
    'multiple-commits',
    'rewritten-or-non-descendant',
    'worktree-only-change',
    'concurrent-or-foreign-change',
    'observation-ambiguous',
  ];

function failureCauseRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function failureCauseString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a nonempty string`);
  }
  return value;
}

function failureCausePathList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  if (value.length > FAILURE_PATH_LIMIT) {
    throw new TypeError(`${path} must hold at most ${FAILURE_PATH_LIMIT} paths`);
  }
  const paths = value.map((entry, index) =>
    failureCauseString(entry, `${path}[${index}]`),
  );
  for (const [index, entry] of paths.entries()) {
    if (index > 0 && !(paths[index - 1]! < entry)) {
      throw new TypeError(`${path} must be sorted and free of duplicates`);
    }
  }
  return Object.freeze(paths);
}

function failureCausePaths(
  value: unknown,
  admitted: readonly (keyof PlaybookFailurePaths)[],
  path: string,
): PlaybookFailurePaths {
  const record = failureCauseRecord(value, path);
  const allowed = new Set<string>([...admitted, 'truncated']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${path} must not carry ${JSON.stringify(key)}`);
    }
  }
  const paths: Record<string, unknown> = {};
  for (const member of admitted) {
    if (!Object.hasOwn(record, member)) {
      throw new TypeError(`${path}.${member} is required`);
    }
    paths[member] = failureCausePathList(record[member], `${path}.${member}`);
  }
  if (Object.hasOwn(record, 'truncated')) {
    const truncated = record.truncated;
    if (
      typeof truncated !== 'number' ||
      !Number.isSafeInteger(truncated) ||
      truncated <= 0
    ) {
      throw new TypeError(`${path}.truncated must be a positive integer`);
    }
    paths.truncated = truncated;
  }
  return Object.freeze(paths) as PlaybookFailurePaths;
}

function failureCauseErrorEvidence(
  value: unknown,
  path: string,
): PlaybookFailureErrorEvidence {
  const record = failureCauseRecord(value, path);
  for (const key of Object.keys(record)) {
    if (key !== 'name' && key !== 'message') {
      throw new TypeError(`${path} must not carry ${JSON.stringify(key)}`);
    }
  }
  if (typeof record.message !== 'string') {
    throw new TypeError(`${path}.message must be a string`);
  }
  return Object.freeze({
    name: failureCauseString(record.name, `${path}.name`),
    message: record.message,
  });
}

function validateFailureCause(
  value: unknown,
  path: string,
  depth: number,
): PlaybookFailureCause {
  if (depth > FAILURE_CAUSE_DEPTH_LIMIT) {
    throw new TypeError(
      `${path} must nest at most ${FAILURE_CAUSE_DEPTH_LIMIT} causes`,
    );
  }
  const record = failureCauseRecord(value, path);
  for (const key of Object.keys(record)) {
    if (key !== 'code' && key !== 'evidence') {
      throw new TypeError(`${path} must not carry ${JSON.stringify(key)}`);
    }
  }
  const code = record.code;
  if (
    typeof code !== 'string' ||
    !(PLAYBOOK_FAILURE_CODES as readonly string[]).includes(code)
  ) {
    throw new TypeError(`${path}.code must be one of the declared codes`);
  }
  const spec = FAILURE_EVIDENCE_MEMBERS[code as PlaybookFailureCode];
  const evidenceRecord = failureCauseRecord(record.evidence, `${path}.evidence`);
  const allowed = new Set<string>([...spec.required, ...spec.optional]);
  for (const key of Object.keys(evidenceRecord)) {
    if (!allowed.has(key)) {
      throw new TypeError(
        `${path}.evidence must not carry ${JSON.stringify(key)}`,
      );
    }
  }
  const evidence: Record<string, unknown> = {};
  for (const member of [...spec.required, ...spec.optional]) {
    const required = spec.required.includes(member);
    if (!Object.hasOwn(evidenceRecord, member)) {
      if (required) {
        throw new TypeError(`${path}.evidence.${member} is required`);
      }
      continue;
    }
    const memberValue = evidenceRecord[member];
    const memberPath = `${path}.evidence.${member}`;
    if (member === 'required') {
      if (!REPOSITORY_DISPOSITIONS.includes(memberValue as never)) {
        throw new TypeError(`${memberPath} must be a repository disposition`);
      }
      evidence[member] = memberValue;
    } else if (member === 'observed') {
      if (!RECEIPT_CLASSIFICATIONS.includes(memberValue as never)) {
        throw new TypeError(`${memberPath} must be a receipt classification`);
      }
      evidence[member] = memberValue;
    } else if (member === 'paths') {
      evidence[member] = failureCausePaths(memberValue, spec.paths, memberPath);
    } else if (member === 'error') {
      evidence[member] = failureCauseErrorEvidence(memberValue, memberPath);
    } else if (member === 'cause') {
      evidence[member] = validateFailureCause(
        memberValue,
        memberPath,
        depth + 1,
      );
    } else {
      evidence[member] = failureCauseString(memberValue, memberPath);
    }
  }
  return Object.freeze({
    code: code as PlaybookFailureCode,
    evidence: Object.freeze(evidence) as PlaybookFailureEvidence,
  });
}

/**
 * Validate, detach, and freeze one failure cause (DR-063 §1). The check is
 * closed per code: exactly the evidence members that code names, nothing else,
 * and a `child-failed` cause nests at most four deep. A value this rejects is
 * not a cause, so a caller omits it rather than publishing an invented one.
 */
export function assertPlaybookFailureCause(
  value: unknown,
): PlaybookFailureCause {
  return validateFailureCause(value, 'playbook failure cause', 1);
}

export interface NormalizedError {
  name: string;
  message: string;
  stack?: string;
  /** DR-063 §2: present exactly when the underlying error carried a valid one. */
  cause?: PlaybookFailureCause;
}

export type PlaybookStateValue =
  | string
  | { readonly [key: string]: PlaybookStateValue };

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

// DR-031 §5: complete durable identity for one nested call whose start
// boundary has already been published and whose child remains suspended.
// `turnId` is absent when the call was opened outside a Boss-turn boundary.
// A schema-3 runtime adds the effect-ledger prefix captured before the causal
// public boundary; null records that the prefix could not be observed.
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

// DR-048: the reached final state's compiled terminal meaning. `kind` is
// authored metadata read from the artifact, never from an agent reply, and
// `description` repeats that state's authored description when it declares
// one. An artifact whose final states declare no kind carries no such record.
export interface PlaybookTerminalOutcome {
  stateId: string;
  kind: 'success' | 'failure';
  description?: string;
}

export type PlaybookCallResult =
  | {
      status: 'ok';
      playbookId: string;
      childSessionId: string;
      state?: PlaybookState;
      output?: JsonValue;
      terminal?: PlaybookTerminalOutcome;
    }
  | {
      status: 'aborted';
      playbookId: string;
      childSessionId?: string;
      state?: PlaybookState;
      error?: NormalizedError;
    }
  | {
      status: 'error';
      playbookId: string;
      childSessionId?: string;
      state?: PlaybookState;
      error: NormalizedError;
    };

export type PlaybookCallStart =
  | { state: 'settled'; result: PlaybookCallResult }
  | { state: 'suspended'; childSessionId: string };

export type PlaybookRunResult =
  | { outcome: 'quiescent' | 'no-action'; state: PlaybookState }
  | { outcome: 'unresolved-effect'; state: PlaybookState }
  | {
      outcome: 'failed' | 'aborted';
      state: PlaybookState;
      error?: NormalizedError;
    }
  | {
      outcome: 'terminal';
      state: PlaybookState;
      stateDescription?: string;
      terminal?: PlaybookTerminalOutcome;
      output?: JsonValue;
    }
  | {
      outcome: 'suspended';
      state: PlaybookState;
      pendingCall: PlaybookPendingCall;
    };

export interface PlaybookPorts {
  callPlayer(
    roleId: string,
    prompt: string,
    signal: AbortSignal,
    options: PlayerCallOptions,
  ): Promise<PlayerResult>;
  callCaptain(
    prompt: string,
    signal: AbortSignal,
    options: CaptainCallOptions,
  ): Promise<CaptainResult>;
  callJudge(prompt: string, signal: AbortSignal): Promise<string>;
  callPlaybook(
    request: PlaybookCallRequest,
    signal: AbortSignal,
  ): Promise<PlaybookCallStart>;
  emitStatus(message: string, data?: unknown): Promise<void>;
  emitTelemetry(event: { topic: string; payload: unknown }): Promise<void>;
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

// DR-038 §5: the source identities and, for a suspended nested call, the
// fresh target child identity that let adoption start one explicit target
// trace lineage without carrying source-session counters or child UUIDs
// forward.
export interface PlaybookAdoptionContext {
  readonly sourceSessionId: string;
  readonly sourceGenerationId: string;
  readonly targetChildSessionId?: string;
}

export type PlaybookTraceType =
  | 'session.started'
  | 'boss.input.received'
  | 'judge.call.started'
  | 'judge.call.finished'
  | 'player.call.started'
  | 'player.call.finished'
  | 'captain.call.started'
  | 'captain.call.finished'
  | 'playbook.call.started'
  | 'playbook.call.finished'
  | 'apply.started'
  | 'apply.finished'
  | 'fsm.transition'
  | 'outcome.accepted'
  | 'status.emitted'
  | 'boss.input.settled'
  | 'session.disposed';

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
  asker: { kind: 'captain' } | { kind: 'role'; roleId: string };
  question: string;
  sourceItem?: string;
}

/** One repository disposition declared by a governed outcome arm (DR-040). */
export type PlaybookRepositoryDisposition =
  | 'unchanged'
  | 'one-descendant-commit'
  | 'deferred';

/** A detached Git-visible repository observation owned by the effect ledger. */
export interface PlaybookRepositoryObservation {
  readonly worktree: string;
  readonly gitDir: string;
  readonly head: string;
  readonly projection: Readonly<Record<string, JsonValue>>;
  readonly projectionDigest: string;
}

/**
 * The fate of the baseline projection entries a governed call absorbed into
 * its one commit, altered, or lost (DR-062). Each list holds sorted unique
 * baseline paths and the three are pairwise disjoint.
 */
export interface PlaybookRepositoryPreExistingChanges {
  readonly absorbed: readonly string[];
  readonly altered: readonly string[];
  readonly lost: readonly string[];
}

/** The fail-closed classification of one complete physical or logical receipt. */
export interface PlaybookRepositoryReceipt {
  readonly classification:
    | 'unchanged'
    | 'one-descendant-commit'
    | 'multiple-commits'
    | 'rewritten-or-non-descendant'
    | 'worktree-only-change'
    | 'concurrent-or-foreign-change'
    | 'observation-ambiguous';
  readonly baseline: PlaybookRepositoryObservation;
  readonly after?: PlaybookRepositoryObservation;
  readonly commitOid?: string;
  readonly preExisting?: PlaybookRepositoryPreExistingChanges;
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
  readonly correctionBudget: { readonly limit: 1; readonly spent: boolean };
  readonly cohortId?: string;
  readonly logicalOperationId?: string;
}

/** One physical boundary before the host assigns attempt and sequence data. */
export type PlaybookEffectBoundaryStart = Omit<
  PlaybookEffectBoundary,
  | 'sequence'
  | 'attemptId'
  | 'attemptNumber'
  | 'after'
  | 'physicalReceipt'
  | 'finalText'
  | 'semanticCandidate'
  | 'initialSemanticCandidate'
>;

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
export type PlaybookEffectLedgerCommand =
  | {
      readonly kind: 'start-boundaries';
      readonly boundaries: readonly [
        PlaybookEffectBoundaryStart,
        ...PlaybookEffectBoundaryStart[],
      ];
    }
  | {
      readonly kind: 'replace-boundaries';
      readonly replacements: readonly [
        {
          readonly expected: PlaybookEffectBoundary;
          readonly next: PlaybookEffectBoundary;
        },
        ...{
          readonly expected: PlaybookEffectBoundary;
          readonly next: PlaybookEffectBoundary;
        }[],
      ];
    }
  | {
      readonly kind: 'append-logical-operations';
      readonly operations: readonly [
        Omit<PlaybookEffectLogicalOperation, 'sequence'>,
        ...Omit<PlaybookEffectLogicalOperation, 'sequence'>[],
      ];
    }
  | {
      readonly kind: 'replace-logical-operations';
      readonly replacements: readonly [
        {
          readonly expected: PlaybookEffectLogicalOperation;
          readonly next: PlaybookEffectLogicalOperation;
        },
        ...{
          readonly expected: PlaybookEffectLogicalOperation;
          readonly next: PlaybookEffectLogicalOperation;
        }[],
      ];
    };

/** A nonempty command batch persisted as one ledger revision. */
export type PlaybookEffectLedgerCommandBatch = readonly [
  PlaybookEffectLedgerCommand,
  ...PlaybookEffectLedgerCommand[],
];

/** Live current-host seam for atomic effect-ledger observation and mutation. */
export interface PlaybookEffectLedgerCapability {
  snapshot(): PlaybookEffectLedger;
  writeAhead(
    commands: PlaybookEffectLedgerCommandBatch,
  ): Promise<PlaybookEffectLedger>;
}

// DR-014 §1 / DR-031 §5 / DR-032: JSON-safe capture of a parked or nested-call
// suspended session. `machine` is the opaque XState persisted snapshot;
// pending Boss questions and a suspended call are first-class so a
// host never has to reconstruct durable ownership from presentation records.
export interface PlaybookRuntimeSnapshot {
  schemaVersion: 4;
  playbookId: string;
  machine: JsonValue;
  roleResumeTokens: { readonly [roleId: string]: string };
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

// DR-063 §3: what running an advertised action would do. `ready` is the only
// standing that can change anything; `no-op` runs and changes nothing; a
// `blocked` action cannot run at all. An absent standing reads as `ready`, so
// a runtime that publishes none advertises exactly what it always did.
export type PlaybookControlStanding = 'ready' | 'no-op' | 'blocked';

// DR-063 §3: the closed reason list a non-`ready` standing names.
export type PlaybookControlActionReason = 'receipt-complete';

// DR-029: one currently valid, runtime-advertised control action. The id
// is stable within the returned view; the label is runtime-written,
// Boss-appropriate text derived from source state descriptions. DR-063 §3
// adds the standing, so a host never draws a control without saying what
// running it would do; an action that publishes none reads as `ready`.
export interface PlaybookControlAction {
  id: string;
  label: string;
  standing?: PlaybookControlStanding;
  reason?: PlaybookControlActionReason;
}

// DR-029: the sanitized control view `describe()` returns — current
// state and the runtime-written description of what that state means,
// the authored context projection, pending Boss questions, the last
// recorded error, and the currently valid actions. `stateDescription` is
// the Boss-appropriate grounding a host may speak from; the state id is
// internal and is absent from it whenever the runtime's source declares
// no description for the state it is in.
export interface PlaybookControlView {
  state: PlaybookState;
  stateDescription?: string;
  context?: JsonValue;
  pendingQuestions: readonly PlaybookPendingBossQuestion[];
  lastError?: NormalizedError;
  actions: readonly PlaybookControlAction[];
}

// DR-029: the receipt `apply()` returns says which of three things
// happened — rejected before any effect, executed with the settled run
// result, or failed after effects may exist.
export type PlaybookControlReceipt =
  | { disposition: 'rejected'; reason: string }
  | { disposition: 'executed'; run: PlaybookRunResult }
  | { disposition: 'failed'; error: NormalizedError };

// DR-038 §2: link-authored metadata the Captain uses to decide whether a
// quiescent generation is eligible for retention and whether a root terminal
// outcome preserves its pre-terminal generation. Presence is classification
// data, independent from the optional adoption operation; an explicitly empty
// final-state list is meaningful.
export interface PlaybookRetainedGenerationMetadata {
  readonly unfinishedFinalStateIds: readonly string[];
}

export interface PlaybookRuntime {
  init(session: PlaybookSession): Promise<void>;
  // DR-014 §1 optional durable-session capability: a runtime implements
  // both members or neither. `exportSnapshot` returns undefined outside
  // a safe capture point (parked quiescence between public boundaries);
  // `restore` is an alternative to `init` that rehydrates the exported
  // snapshot under the same immutable session identity.
  exportSnapshot?(): PlaybookRuntimeSnapshot | undefined;
  restore?(
    session: PlaybookSession,
    snapshot: PlaybookRuntimeSnapshot,
  ): Promise<void>;
  // DR-038 §1 optional generation-adoption capability: a distinct
  // initialization path that rehydrates a retained snapshot under a fresh
  // engagement identity. Presence is feature-detected independently from
  // retained-generation classification metadata.
  adopt?(
    session: PlaybookSession,
    snapshot: PlaybookRuntimeSnapshot,
    context: PlaybookAdoptionContext,
  ): Promise<void>;
  readonly retainedGenerationMetadata?: PlaybookRetainedGenerationMetadata;
  // DR-029 optional control-surface capability: a runtime implements
  // both members or neither. `describe` is side-effect free and valid at
  // parked quiescence outside an active boundary; `apply` revalidates the
  // named action against the live state, executes it at most once per
  // idempotency key within that runtime instance, and returns a receipt. A
  // runtime lacking the pair advertises no actions; plain text delivery is
  // the only verb against it.
  describe?(): PlaybookControlView;
  /**
   * Host-only identities of the durable envelopes that still require
   * unresolved-effect settlement. The host owns their bounded projection
   * from its authoritative effect ledger; no repository evidence enters a
   * runtime-owned run result.
   */
  unresolvedEffectEnvelopes?(): readonly (
    | { readonly kind: 'boundary'; readonly boundaryId: string }
    | { readonly kind: 'logical-operation'; readonly operationId: string }
  )[];
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

export type PlaybookRuntimeFactory<Options = unknown> = (
  options: Options,
) => PlaybookRuntime;
