// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Generic linked-playbook runtime factory (DR-019). The FSM-interpreter
// machinery that slc/link.md previously regenerated inside every linked
// `<name>.playbook.ts` artifact — actor wiring, boundary tracing, judge
// classification/adjudication, script execution, nested-playbook bridging,
// Boss-reply suspension, snapshot/restore, and disposal — lives here once.
// A linked artifact supplies only its per-workflow `spec` (options
// validation and any strategy overrides) and its own FSM; the factory
// interprets the FSM data the artifact already carries.
//
// The machinery is hoisted from the reference CODE artifact
// (reference/sdlc/code.playbook/code.playbook.ts) verbatim where possible;
// its behavior tests are the equivalence proof. Do not change observable
// behavior here without consulting those suites.

import { spawn } from 'node:child_process';
import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import type {
  AnyStateMachine,
  EventObject,
  InspectionEvent,
  PromiseActorLogic,
} from 'xstate';
import {
  assertPlaybookRuntimeSnapshot,
  combineAbortSignals,
  createNestedPlaybookBridge,
  detachPersistedMachineSnapshot,
  normalizeError,
  normalizePlaybookSnapshot,
  snapshotJsonValue,
  snapshotPlaybookSession,
  validateCaptainResult,
  validatePlayerResult,
  waitForPlaybookQuiescence,
} from './xstate-runtime.js';
import type {
  CaptainResult,
  JsonValue,
  PlaybookCallResult,
  PlaybookControlAction,
  PlaybookControlReceipt,
  PlaybookControlView,
  PlaybookPorts,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
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
  player: string;
  question: string;
}

export interface PlaybookPlayerInput {
  stateId: string;
  player: string;
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
    playerId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<PlayerResult>;
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

/**
 * Presentation selection for one traced direct-Captain call
 * (slc/link.md §Captain adjudication). `'visible'` (the default) is the
 * workflow form: the port receives `{ visibility: 'visible', resume: false }`
 * and the trace pair carries both members. `'hidden'` is the controller form
 * (DR-029 §4): the port receives `{ visibility: 'hidden', resume: false }`
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
  1,
]);

/** A linked artifact's declared link-time compatibility values (DR-022). */
export interface XStatePlaybookRuntimeCompat {
  /** The artifact schema version the linker emitted. */
  artifactSchema: number;
  /** The engine ABI the artifact was linked against. */
  runtimeAbi: number;
}

// PBRT-50: validate a declaration against the loaded engine, schema first,
// so one clear diagnostic covers a fully skewed artifact. Absent means a
// legacy artifact emitted before the DR-022 contract; those must keep
// loading unchanged (DR-019 §4), so there is nothing to check.
function assertRuntimeCompat(
  compat: XStatePlaybookRuntimeCompat | undefined,
  label: string,
): void {
  if (compat === undefined) return;
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
  entryEvent?: { type: string; textField: string };
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
  /**
   * DR-029 §3 / PBRT-52: the runtime-authored ControlView context
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
  /** States that may suspend for a Boss reply. Default: targets of the FSM's `awaitBossReply` BOSS_REPLY transitions. */
  resumableStateIds?: ReadonlySet<string>;
  /** Human status lines for a root transition. Default: entry lines with question/failure surfacing. */
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

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason || normalizeError(error).name === 'AbortError')
  );
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
    typeof candidate.player !== 'string' ||
    typeof candidate.question !== 'string'
  ) {
    return undefined;
  }
  return {
    questionId: candidate.questionId,
    resumeStateId: candidate.resumeStateId,
    sourceItem: candidate.sourceItem,
    player: candidate.player,
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

/** Default player binding: each player to its lowercased name. */
export function defaultResolvePlayerId(input: PlaybookPlayerInput): string {
  return input.player.toLowerCase();
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
  lines.push(`The ${input.player} just produced this output:`);
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
      obj[field] = verbatim;
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
// from every player-invoking state: resolve the playerId, compose the prompt,
// await callPlayer, adjudicate the finalText. An `ok` result with a missing,
// empty, or whitespace-only finalText earns exactly one corrective re-ask of
// the same composed call (DR-028); a non-`ok` result, or a second such empty
// result, throws so XState routes via onError to the FSM's failure sink.
//
// `getActiveSignal` flows the Boss's public-boundary signal into the host
// port calls — fromPromise hands the bridge XState's actor-scoped signal,
// which only fires on actor.stop(), not on Boss abort.
// ---------------------------------------------------------------------------

export interface PlayerBridgeSpec {
  resolvePlayerId: (input: PlaybookPlayerInput) => string;
  composePlayerPrompt: (input: PlaybookPlayerInput) => string;
  adjudication: PlayerAdjudicationSpec;
  resumableStateIds: ReadonlySet<string>;
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
      const playerId = spec.resolvePlayerId(input);
      const prompt = spec.composePlayerPrompt(input);
      const callPlayer = (resume: string | false) =>
        boundary
          ? boundary.callPlayer(input, playerId, prompt, activeSignal)
          : ports.callPlayer(playerId, prompt, activeSignal, { resume });
      let result = await callPlayer(false);
      if (result.status === 'ok' && isEmptyFinalText(result.finalText)) {
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
        const output = await adjudicatePlayerOutput(
          spec.adjudication,
          input,
          finalText,
          ports,
          activeSignal,
          boundary,
        );
        validateBossReplyOutput(input, output, spec.resumableStateIds);
        return output;
      } catch (error) {
        onControlPlaneError?.(error);
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
  const awaitState = config.states.awaitBossReply;
  if (!isPlainObject(awaitState) || !isPlainObject(awaitState.on)) {
    return new Set();
  }
  const bossReply = awaitState.on.BOSS_REPLY;
  if (bossReply === undefined) return new Set();
  return new Set(transitionTargets(bossReply));
}

// ---------------------------------------------------------------------------
// DR-029 §3 control surface: the FSM's explicit-state-jump event and the
// source state descriptions that label runtime-advertised actions.
// ---------------------------------------------------------------------------

/** The FSM's explicit-state-jump event type (slc/link.md §Boss-event mapping). */
const JUMP_EVENT_TYPE = 'BOSS_INTERRUPT';

/**
 * Source state descriptions by state key, node id, and `meta.playbook`
 * state id, read from `machine.config`. Control actions are labeled from
 * these descriptions (DR-029 §3); a state without one falls back to its id.
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

function defaultStatusesForState(
  state: PlaybookState,
  context: Record<string, unknown>,
): ScheduledStatus[] {
  const stateId = state.stateId;
  if (stateId === undefined || SUPPRESSED_ENTRY_STATES.has(stateId)) return [];
  if (stateId === 'awaitBossReply') {
    const pending = pendingBossQuestionFromContext(context);
    const message =
      pending === undefined
        ? 'Awaiting Boss reply.'
        : `${pending.player} asks: ${pending.question}`;
    return [{ message }];
  }
  if (stateId === 'failed') {
    const lastError = normalizeErrorFull(context.lastError);
    return [
      {
        message: 'Workflow failed; awaiting Boss recovery.',
        ...(lastError === undefined
          ? {}
          : { data: snapshotJsonValue({ lastError }, 'failed status data') }),
      },
    ];
  }
  return [{ message: `Entered ${stateId}.` }];
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
    const pending = pendingBossQuestionFromContext(state.context);
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
        `Pending asking player: ${pending.player}`,
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
  | 'failed'
  | 'terminal'
  | 'aborted'
  | 'suspended';

interface TracePosition {
  turnId?: number;
  callId?: string;
}

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
export function createXStatePlaybookRuntime<TOptions>(
  machine: AnyStateMachine,
  spec: XStatePlaybookRuntimeSpec<TOptions>,
): PlaybookRuntimeFactory<TOptions> {
  const label = spec.label ?? 'playbook';
  // DR-022 / PBRT-50: reject an incompatible artifact declaration before any
  // machine interpretation, against this loaded engine's own self-report.
  assertRuntimeCompat(spec.compat, label);
  const declaredActors = collectInvokeSources(machine);
  const resumableStateIds =
    spec.resumableStateIds ?? resumableStateIdsFromMachine(machine);
  // DR-029 §3: source state descriptions label the control actions the
  // runtime advertises through `describe()`.
  const stateDescriptions = stateDescriptionsFromMachine(machine);
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
  const resolvePlayerIdSpec = spec.resolvePlayerId;
  const composePlayerPrompt =
    spec.composePlayerPrompt ??
    ((input: PlaybookPlayerInput) =>
      defaultComposePlayerPrompt(input, spec.placeholderFields));
  const composeCaptainPrompt =
    spec.composeCaptainPrompt ??
    ((input: PlaybookCaptainInput) =>
      defaultComposeCaptainPrompt(input, spec.placeholderFields));
  const adjudication: PlayerAdjudicationSpec = {
    ...(spec.buildJudgePrompt !== undefined
      ? { buildJudgePrompt: spec.buildJudgePrompt }
      : {}),
    ...(spec.extractRequiredFields !== undefined
      ? { extractRequiredFields: spec.extractRequiredFields }
      : {}),
    ...(spec.verbatimPayloadFields !== undefined
      ? { verbatimPayloadFields: spec.verbatimPayloadFields }
      : {}),
  };
  const extractFields =
    spec.extractRequiredFields ?? defaultExtractRequiredFields;
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
  const statusesForState = spec.statusesForState ?? defaultStatusesForState;
  const machineInput =
    spec.machineInput ?? ((options: TOptions) => options as unknown);
  const scriptCwd =
    spec.scriptCwd ??
    ((options: TOptions): string | undefined => {
      const cwd = (options as Record<string, unknown> | null | undefined)?.cwd;
      return typeof cwd === 'string' ? cwd : undefined;
    });

  return function createPlaybookRuntime(options: TOptions): PlaybookRuntime {
    const boundOptions = spec.snapshotOptions(options);
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
    let activeTurnId: number | undefined;
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
    // DR-029 §3: the last event a public Boss boundary sent into the
    // machine — classified, deterministic entry, or Boss reply — kept with
    // its recorded payload so a failure-state retry action can replay the
    // event that drove the run into `failed`. Process-local: the schema-1
    // parked snapshot does not persist it (PBRT-50: no schema bump).
    let lastBossEvent: EventObject | undefined;
    // DR-029 §3: at-most-once `apply` execution — the accepted receipt
    // recorded for each idempotency key, returned verbatim on a repeated
    // key. A key whose call settled `rejected` or threw before reaching
    // acceptance records nothing, so a later call with that key may still
    // execute.
    const appliedReceipts = new Map<string, PlaybookControlReceipt>();
    const playerResumeTokens = new Map<string, string>();
    const activePlayerIds = new Set<string>();
    const playbookCallTurnIds = new Map<string, number | undefined>();
    // Captain and judge work share one serialized lane (slc/link.md
    // §Session lifecycle).
    const judgeQueue = new PQueue({ concurrency: 1 });
    const emissionQueue = new PQueue({ concurrency: 1 });
    const activeEmissionCalls = new Set<Promise<void>>();

    // All trace, state-telemetry, and status work shares this one queue.
    // Inspection callbacks enqueue a complete ordered batch synchronously;
    // imperative boundaries await their queued work directly.
    let emissionFailure: unknown;

    function enqueueEmission(fn: () => Promise<void>): Promise<void> {
      const queued = emissionQueue.add(fn).then(() => undefined);
      activeEmissionCalls.add(queued);
      void queued.then(
        () => activeEmissionCalls.delete(queued),
        (error: unknown) => {
          activeEmissionCalls.delete(queued);
          emissionFailure ??= error;
        },
      );
      return queued;
    }

    async function drainEmissions(): Promise<void> {
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
        const error = emissionFailure;
        emissionFailure = undefined;
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
        schemaVersion: 2,
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
    ): Promise<void> {
      const currentSession = requireSession();
      const event = createTraceEvent(type, payload, position);
      return enqueueEmission(() =>
        currentSession.ports.emitTelemetry({
          topic: 'playbook.trace',
          payload: event,
        }),
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
        controlPlaneError ??= error;
        try {
          await emitTrace(
            finishedType,
            {
              ...finishIdentity,
              status: 'error',
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

    const boundary: RuntimeBoundaryCalls = {
      async callPlayer(input, playerId, prompt, signal): Promise<PlayerResult> {
        // State-entry telemetry/status must precede the call they describe.
        await drainEmissions();
        const turnId = activeTurnId;
        const callId = `player-${++playerCallSequence}`;
        const stateId = input.stateId;
        const resume = playerResumeTokens.get(playerId) ?? false;
        const identity = {
          purpose: 'captain' as const,
          ...stateIdentity(stateId),
          sourceItem: input.sourceItem,
          playerId,
          resume,
        };
        const position: TracePosition = {
          ...(turnId !== undefined ? { turnId } : {}),
          callId,
        };

        if (activePlayerIds.has(playerId)) {
          const error = new Error(
            `simultaneous calls to resolved player ${playerId} are not allowed`,
          );
          await emitCallStarted(
            'player.call.started',
            'player.call.finished',
            { ...identity, prompt },
            position,
          );
          await emitTrace(
            'player.call.finished',
            { ...identity, status: 'error', error: normalizeError(error) },
            position,
          );
          throw error;
        }
        activePlayerIds.add(playerId);

        try {
          await emitTrace(
            'player.call.started',
            { ...identity, prompt },
            position,
          );

          let rawResult: unknown;
          try {
            // An abort may land while the awaited started emission drains
            // (e.g. fired from the trace sink itself); the host call must
            // never start after abort, so settle the already-started pair
            // as `aborted` through the catch below.
            signal.throwIfAborted();
            rawResult = await requireHostPorts().callPlayer(
              playerId,
              prompt,
              signal,
              { resume },
            );
            // A host promise is not required to honor cancellation. Do not let
            // a late result mutate continuity or publish a successful finish.
            signal.throwIfAborted();
          } catch (error) {
            if (!signal.aborted) controlPlaneError ??= error;
            try {
              await emitTrace(
                'player.call.finished',
                {
                  ...identity,
                  status: signal.aborted ? 'aborted' : 'error',
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
            if (!signal.aborted) controlPlaneError ??= error;
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

          if (
            typeof result.resumeToken === 'string' &&
            result.resumeToken.trim().length > 0
          ) {
            playerResumeTokens.set(playerId, result.resumeToken);
          } else {
            playerResumeTokens.delete(playerId);
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
        } finally {
          activePlayerIds.delete(playerId);
        }
      },

      async callJudge(purpose, stateId, prompt, signal): Promise<string> {
        return judgeQueue.add(async () => {
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
            if (!isAbortFailure(error, signal)) {
              controlPlaneError ??= error;
            }
            await emitTrace(
              'judge.call.finished',
              {
                ...identity,
                status: signal.aborted ? 'aborted' : 'error',
                error: normalizeError(error),
              },
              position,
            );
            throw error;
          }
          if (typeof reply !== 'string') {
            const error = new TypeError('judge reply must be a string');
            controlPlaneError ??= error;
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
            // selection is host-owned (DR-029 §2), so its trace pair carries
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
                status: signal.aborted ? 'aborted' : 'error',
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

    function resolvePlayerId(input: PlaybookPlayerInput): string {
      return resolvePlayerIdSpec
        ? resolvePlayerIdSpec(input, boundOptions)
        : defaultResolvePlayerId(input);
    }

    function playerActor(
      ports: PlaybookPorts,
    ): PromiseActorLogic<PlaybookActorOutput, PlaybookPlayerInput> {
      return createPlayerBridge(
        {
          resolvePlayerId,
          composePlayerPrompt,
          adjudication,
          resumableStateIds,
        },
        ports,
        () => activeSignal,
        boundary,
        (error) => {
          if (!activeSignal?.aborted) controlPlaneError ??= error;
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
            if (!active.aborted && !isFsmResultFailure(error)) {
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

          const exitStatus = await new Promise<number>((resolve, reject) => {
            let child: ReturnType<typeof spawn>;
            try {
              child = spawn('sh', ['-c', input.command], {
                cwd,
                stdio: 'ignore',
              });
            } catch (error) {
              reject(error);
              return;
            }
            const onAbort = (): void => {
              child.kill('SIGTERM');
              reject(active.reason ?? new Error('script aborted'));
            };
            if (active.aborted) {
              onAbort();
              return;
            }
            active.addEventListener('abort', onAbort, { once: true });
            child.on('error', (error) => {
              active.removeEventListener('abort', onAbort);
              reject(error);
            });
            child.on('close', (code) => {
              active.removeEventListener('abort', onAbort);
              resolve(typeof code === 'number' ? code : 1);
            });
          });

          await ports.emitStatus(
            `Executed script for ${input.stateId} (exit ${exitStatus}).`,
          );
          await ports.emitTelemetry({
            topic: 'playbook.script',
            payload: {
              stateId: input.stateId,
              sourceItem: input.sourceItem,
              exitStatus,
            },
          });

          if (exitStatus === 0) {
            return { guard: okGuard, exitStatus: 0 };
          }
          return { guard: failedGuard, exitStatus };
        },
      );
    }

    const nestedBridge = createNestedPlaybookBridge({
      nextCallId: () => `playbook-${++playbookCallSequence}`,
      getBoundarySignal: () => activeSignal,
      callPlaybook: (request, signal) =>
        requireHostPorts().callPlaybook(request, signal),
      emitStarted: async (event) => {
        playbookCallTurnIds.set(event.callId, activeTurnId);
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
        );
      },
      emitFinished: async (event) => {
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
          );
        } finally {
          playbookCallTurnIds.delete(event.callId);
        }
      },
      drain: drainEmissions,
      bindResumeSignal: (signal) => {
        activeSignal = signal;
      },
      onControlPlaneError: (error) => {
        if (!activeSignal?.aborted) controlPlaneError ??= error;
      },
      onBackgroundError: (error) => {
        emissionFailure ??= error;
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
      if (state.stateId === 'awaitBossReply') {
        const pendingBossQuestion = pendingBossQuestionFromContext(context);
        if (pendingBossQuestion !== undefined) {
          payload.pendingBossQuestion = pendingBossQuestion;
        }
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
      statuses: readonly ScheduledStatus[],
      position: TracePosition,
    ): void {
      const currentSession = requireSession();
      const transitionTrace = createTraceEvent(
        'fsm.transition',
        payload,
        position,
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
      void enqueueEmission(async () => {
        await currentSession.ports.emitTelemetry({
          topic: 'playbook.trace',
          payload: transitionTrace,
        });
        await currentSession.ports.emitTelemetry({
          topic: 'playbook.fsm.state',
          payload,
        });
        for (const status of statusEmissions) {
          await currentSession.ports.emitTelemetry({
            topic: 'playbook.trace',
            payload: status.trace,
          });
          await currentSession.ports.emitStatus(status.message, status.data);
        }
      }).catch(() => undefined);
    }

    function latchInspectionError(error: unknown): void {
      if (activeSignal !== undefined) controlPlaneError ??= error;
      else emissionFailure ??= error;
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
      actor.stop();
    }

    function buildActor(
      ports: PlaybookPorts,
      machineSnapshot?: JsonValue,
    ): ReturnType<typeof createActor> {
      priorState = undefined;
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
          if (inspectionEvent.type !== '@xstate.snapshot') return;
          if (inspectionEvent.actorRef !== builtActor) return;
          if (suppressInspectionEmissions) return;
          try {
            const snap = inspectionEvent.snapshot;
            const state = normalizePlaybookSnapshot(snap);
            if (state.stateId === undefined) {
              throw new Error(
                `${label} root snapshot must expose exactly one playbook state id`,
              );
            }
            const previousState = priorState;
            const context = ((snap as { context?: unknown }).context ??
              {}) as Record<string, unknown>;
            const payload = structuredStateTelemetryPayload(
              previousState,
              state,
              inspectionEvent.event,
              context,
            );
            const statuses = statusesForState(
              state,
              context,
              inspectionEvent.event,
            );
            enqueueTransitionEmission(
              payload,
              state,
              statuses,
              tracePositionForActiveTurn(),
            );
            priorState = state;
          } catch (error) {
            latchInspectionError(error);
          }
        },
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
        if (output !== undefined) {
          return {
            outcome,
            state,
            output: snapshotJsonValue(output, 'terminal playbook output'),
          };
        }
        return { outcome, state };
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
      if (signal.aborted) return 'aborted';
      const state = currentState();
      if (state.status === 'error') {
        const actorError = (
          actor?.getSnapshot() as { error?: unknown } | undefined
        )?.error;
        throw actorError ?? new Error(`${label} actor entered error status`);
      }
      if (state.status === 'done') return 'terminal';
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

    // Shared failed-start cleanup for init and restore: stop the actor,
    // abort/drain nested and host work, optionally emit one best-effort
    // session.disposed boundary, and unbind every closure field so dispose
    // stays callable. The caller rethrows its original failure. A restore
    // failure skips the disposal trace — the parked session was never
    // re-bound in this process, so its persisted snapshot stays
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
      playerResumeTokens.clear();
      activePlayerIds.clear();
      playbookCallTurnIds.clear();
      activeEmissionCalls.clear();
      emissionQueue.clear();
      judgeQueue.clear();
      appliedReceipts.clear();
      actor = undefined;
      session = undefined;
      savedPorts = undefined;
      runtimePorts = undefined;
      activeSignal = undefined;
      activeTurnId = undefined;
      controlPlaneError = undefined;
      emissionFailure = undefined;
      priorState = undefined;
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
    // DR-029 §3 control surface: action derivation shared by `describe`
    // and by `apply`'s live revalidation.
    // -----------------------------------------------------------------

    interface DerivedControlAction {
      action: PlaybookControlAction;
      event: EventObject;
    }

    function snapshotCan(snapshot: unknown, event: EventObject): boolean {
      const can = (snapshot as { can?: unknown } | null)?.can;
      return (
        typeof can === 'function' &&
        (can as (candidate: EventObject) => boolean).call(snapshot, event) ===
          true
      );
    }

    // The failure-state retry entry replays the recorded last classified
    // event with its recorded payload. A candidate whose event the live
    // snapshot does not accept — or whose payload the runtime never
    // recorded — is excluded rather than completed with invented text.
    function retryActionFor(
      snapshot: unknown,
      stateId: string | undefined,
    ): DerivedControlAction | undefined {
      if (stateId !== 'failed' || lastBossEvent === undefined) {
        return undefined;
      }
      if (!snapshotCan(snapshot, lastBossEvent)) return undefined;
      // A recorded explicit-state-jump event names the exact state its
      // replay re-enters: the root BOSS_INTERRUPT shape is a guarded
      // multi-arm list keyed on `targetId`, so the first configured arm
      // may label a different state than the one the recorded event
      // actually resumes.
      const recordedTargetId =
        lastBossEvent.type === JUMP_EVENT_TYPE
          ? (lastBossEvent as { targetId?: unknown }).targetId
          : undefined;
      const target =
        typeof recordedTargetId === 'string' &&
        recordedTargetId.trim().length > 0
          ? recordedTargetId
          : firstTransitionTarget(machine, stateId, lastBossEvent.type);
      const description =
        (target === undefined ? undefined : stateDescriptions.get(target)) ??
        target ??
        lastBossEvent.type;
      return {
        action: {
          id: `retry:${lastBossEvent.type}`,
          label: `Retry: ${description}`,
        },
        event: lastBossEvent,
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
      const retry = retryActionFor(snapshot, state.stateId);
      if (retry !== undefined) derived.push(retry);
      // Jump entries: resumable targets whose explicit-state-jump event the
      // live snapshot accepts (state guards included), sent with the
      // advertised target id and optional textual fields omitted.
      for (const targetId of [...resumableStateIds].sort()) {
        const event = { type: JUMP_EVENT_TYPE, targetId } as EventObject;
        if (!snapshotCan(snapshot, event)) continue;
        derived.push({
          action: {
            id: `jump:${targetId}`,
            label: `Resume from: ${stateDescriptions.get(targetId) ?? targetId}`,
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

    const runtime = {
      async init(nextSession: PlaybookSession): Promise<void> {
        if (initialized || disposed || disposalPromise !== undefined) {
          throw new Error('createPlaybookRuntime.init: already initialized');
        }
        const boundSession = snapshotPlaybookSession(nextSession);
        initialized = true;
        let finishInitialization!: () => void;
        const initialization = new Promise<void>((resolve) => {
          finishInitialization = resolve;
        });
        initInFlight = initialization;
        const initTask = (async () => {
          session = boundSession;
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

      // DR-014 §1 / PBRT-45: JSON-safe capture of a parked session.
      // Defined only at a safe capture point — initialized, not disposing
      // or disposed, no active public boundary, no pending nested call,
      // and the actor quiescent with status `active`.
      exportSnapshot(): PlaybookRuntimeSnapshot | undefined {
        if (!actor || !session || disposed || disposalPromise !== undefined) {
          return undefined;
        }
        if (activeSignal !== undefined) return undefined;
        if (nestedBridge.getPendingCall()) return undefined;
        const state = currentState();
        if (state.status !== 'active' || !state.quiescent) return undefined;
        const machineSnapshot = detachPersistedMachineSnapshot(
          actor.getPersistedSnapshot(),
        );
        const context = (actor.getSnapshot() as { context?: unknown })
          .context as Record<string, unknown>;
        const pending = pendingBossQuestionFromContext(context ?? {});
        return {
          schemaVersion: 1,
          playbookId: session.playbookId,
          machine: machineSnapshot,
          playerResumeTokens: Object.fromEntries(playerResumeTokens),
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
                    player: pending.player,
                    question: pending.question,
                    sourceItem: pending.sourceItem,
                  },
                ],
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
        if (initialized || disposed || disposalPromise !== undefined) {
          throw new Error('createPlaybookRuntime.restore: already initialized');
        }
        const boundSession = snapshotPlaybookSession(nextSession);
        const boundSnapshot = assertPlaybookRuntimeSnapshot(
          snapshot,
          boundSession.playbookId,
        );
        initialized = true;
        let finishInitialization!: () => void;
        const initialization = new Promise<void>((resolve) => {
          finishInitialization = resolve;
        });
        initInFlight = initialization;
        const initTask = (async () => {
          session = boundSession;
          savedPorts = boundSession.ports;
          runtimePorts = createRuntimePorts(boundSession.ports);
          traceSequence = boundSnapshot.sequences.trace;
          turnSequence = boundSnapshot.sequences.turn;
          judgeCallSequence = boundSnapshot.sequences.judgeCall;
          playerCallSequence = boundSnapshot.sequences.playerCall;
          playbookCallSequence = boundSnapshot.sequences.playbookCall;
          captainCallSequence =
            boundSnapshot.sequences.captainCall ??
            // Legacy schema-v1 snapshots predate this dedicated counter.
            // Every Captain call already consumed at least one trace number,
            // so the global trace counter is a collision-safe id floor.
            boundSnapshot.sequences.trace;
          // The schema-1 snapshot carries no apply counter (PBRT-50: no
          // schema bump); every apply boundary consumed trace numbers, so
          // the persisted trace counter is a collision-safe id floor here
          // too, keeping `apply-<n>` call ids unique across restore.
          applyCallSequence = boundSnapshot.sequences.trace;
          playerResumeTokens.clear();
          for (const [playerId, token] of Object.entries(
            boundSnapshot.playerResumeTokens,
          )) {
            playerResumeTokens.set(playerId, token);
          }
          suppressInspectionEmissions = true;
          actor = buildActor(runtimePorts, boundSnapshot.machine);
          actor.start();
          const restoredState = currentState();
          if (restoredState.status !== 'active') {
            throw new Error(
              `createPlaybookRuntime.restore: restored actor status is ${restoredState.status}, expected active`,
            );
          }
          suppressInspectionEmissions = false;
          priorState = restoredState;
          await drainEmissions();
        })();
        try {
          await initTask;
        } catch (error) {
          await cleanupFailedStart(error, { emitDisposal: false });
          throw error;
        } finally {
          finishInitialization();
          if (initInFlight === initialization) initInFlight = undefined;
        }
      },

      // DR-029 §3 / PBRT-52: side-effect-free control view over the live
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
        const snapshot = actor.getSnapshot();
        const state = currentState();
        const context = ((snapshot as { context?: unknown }).context ??
          {}) as Record<string, unknown>;
        const pending = pendingBossQuestionFromContext(context);
        const lastError = normalizeErrorFull(context.lastError);
        const projectedContext = projectControlContext(context);
        return deepFreeze({
          state,
          ...(projectedContext !== undefined
            ? { context: projectedContext }
            : {}),
          pendingQuestions:
            pending === undefined
              ? []
              : [
                  {
                    questionId: pending.questionId,
                    player: pending.player,
                    question: pending.question,
                    sourceItem: pending.sourceItem,
                  },
                ],
          ...(lastError !== undefined ? { lastError } : {}),
          actions: deriveControlActions(snapshot).map(({ action }) => action),
        });
      },

      // DR-029 §3 / PBRT-52: revalidate the named action against the live
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

        const turnId = ++turnSequence;
        const callId = `apply-${++applyCallSequence}`;
        const position: TracePosition = { turnId, callId };
        activeTurnId = turnId;
        activeSignal = signal;
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
        // Past acceptance a settlement-emission failure is a post-acceptance
        // control-plane error, which PBRT-52 settles as the `failed` receipt
        // rather than as a throw. Folding replaces the receipt recorded at
        // acceptance, so a replayed key returns the same settlement the
        // caller saw; the boundary sentinel is still held, so nothing can
        // observe the intermediate value. Only the first settlement error is
        // latched, so one fold is all there is to do.
        let folded = false;
        const foldSettlementFailure = (): void => {
          if (!accepted || folded || settlementError === undefined) return;
          folded = true;
          receipt = settledReceipt({
            disposition: 'failed',
            error: normalizeError(settlementError),
          });
          appliedReceipts.set(key, receipt);
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
                actor.send(candidate.event);
                await waitForPlaybookQuiescence(actor, {
                  pendingCalls: nestedBridge,
                });
                if (controlPlaneError !== undefined) throw controlPlaneError;
                const run = runResultFor(settledOutcome(signal));
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
                // receipt, not a control-plane rejection (DR-029 §3).
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
          // Fold before the finish emission so the traced disposition is the
          // one the caller receives.
          foldSettlementFailure();
          if (receipt !== undefined) {
            try {
              await emitTrace(
                'apply.finished',
                { actionId, key, ...receiptTracePayload(receipt) },
                position,
              );
            } catch (error) {
              settlementError ??= error;
            }
            // Drain even when the finish emission rejected, so its latched
            // sink failure cannot leak into the next public boundary.
            try {
              await drainEmissions();
            } catch (error) {
              settlementError ??= error;
            }
            // A finish sink that itself rejected has already lost its pair;
            // the receipt still has to tell the caller what happened.
            foldSettlementFailure();
          }
        } finally {
          // Always release the boundary sentinel, even on a path no
          // constructible input reaches today, so a defect here can never
          // wedge every later public boundary behind "another runtime turn
          // is active".
          activeSignal = undefined;
          activeTurnId = undefined;
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
        const turnId = ++turnSequence;
        activeTurnId = turnId;
        activeSignal = signal;
        controlPlaneError = undefined;
        let result: PlaybookRunResult | undefined;
        let operationError: unknown;
        try {
          await emitTrace('boss.input.received', { text }, { turnId });
          // 1. Map the Boss text to an FSM event: deterministic exact entry
          //    where applicable (slc/link.md §Boss-event mapping), judge
          //    classification otherwise.
          let event: EventObject | undefined;
          const trimmed = text.trim();
          if (trimmed !== '') {
            const snapshot = actor.getSnapshot();
            const terminal = snapshot.status === 'done';
            const stateId = normalizePlaybookSnapshot(snapshot).stateId;
            if (
              spec.entryEvent !== undefined &&
              (stateId === 'ready' || terminal)
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
          // Empty input, no-action classifier output, or invalid classifier
          // output — nothing to send.
          if (event === undefined) {
            result = runResultFor('no-action');
          } else {
            // 2. Optional Captain-pane classification line: the bare FSM
            //    event type, emitted before the FSM advances.
            const statusLine = spec.classificationStatus?.(event);
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
            // DR-029 §3: keep the classified event with its recorded payload
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
        const primaryError =
          latchedControlError ?? drainError ?? operationError;
        const abortError =
          latchedControlError === undefined &&
          drainError === undefined &&
          operationError !== undefined &&
          isAbortFailure(operationError, signal);
        const settlementResult =
          primaryError === undefined
            ? (result ?? runResultFor('no-action'))
            : runResultFor(abortError ? 'aborted' : 'failed', primaryError);

        let settlementEmissionError: unknown;
        try {
          await emitTrace(
            'boss.input.settled',
            settlementTracePayload(settlementResult),
            { turnId },
          );
        } catch (error) {
          settlementEmissionError = error;
        }
        try {
          await drainEmissions();
        } catch (error) {
          settlementEmissionError ??= error;
        }
        const failure =
          controlPlaneError ??
          latchedControlError ??
          drainError ??
          (abortError
            ? (settlementEmissionError ?? operationError)
            : (operationError ?? settlementEmissionError));
        activeSignal = undefined;
        activeTurnId = undefined;
        controlPlaneError = undefined;

        if (
          failure !== undefined &&
          !(abortError && settlementEmissionError === undefined)
        ) {
          throw failure;
        }
        return settlementResult;
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
        activeTurnId = playbookCallTurnIds.get(input.callId);
        activeSignal = input.signal;
        controlPlaneError = undefined;
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
        let drainError: unknown;
        try {
          await drainEmissions();
        } catch (error) {
          drainError = error;
        }
        const failure = controlPlaneError ?? drainError ?? operationError;
        activeSignal = undefined;
        activeTurnId = undefined;
        controlPlaneError = undefined;
        if (failure !== undefined) throw failure;
        if (result === undefined) {
          throw new Error('playbook resume produced no runtime result');
        }
        return result;
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
            playerResumeTokens.clear();
            activePlayerIds.clear();
            playbookCallTurnIds.clear();
            activeEmissionCalls.clear();
            emissionQueue.clear();
            judgeQueue.clear();
            appliedReceipts.clear();
            actor = undefined;
            activeSignal = undefined;
            activeTurnId = undefined;
            controlPlaneError = undefined;
            emissionFailure = undefined;
            lastBossEvent = undefined;
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
}
