// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// PlaybookRuntime for the decide playbook, linked from the FSM artifact by
// the slc FSM-to-runtime link phase.
//
// Linker inputs:
//   FSM artifact:       ./decide.fsm.ts
//   Link target:        @sublang/playbook/runtime
//   Role binding:       canonical coder and reviewer roles; concrete players
//                       and prompt identities are supplied by the host session
//   Adjudication:       LLM-judge per state (default)
//   Boss-event mapping: free-text judge classification (default)
//   Abort strategy:     natural rejection; every player-invoking state's
//                       onError routes to the quiescent failed state.
//   Output profile:     bespoke parallel runtime with the shared nested-call
//                       bridge (slc/link.md §Output)

import { randomUUID } from 'node:crypto';

import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import type { InspectionEvent, SnapshotFrom } from 'xstate';

import {
  createAcceptedOutcomeConsumer,
  type AcceptedOutcomeReceipt,
} from '../../../src/accepted-outcome.js';

import {
  assertJsonSafe,
  assertPlaybookEffectLedger,
  assertPlaybookRuntimeSnapshot,
  combineAbortSignals,
  createNestedPlaybookBridge,
  detachPersistedMachineSnapshot,
  emptyPlaybookEffectLedger,
  normalizeError,
  normalizePlaybookSnapshot,
  snapshotJsonValue,
  snapshotPlaybookSession,
  validatePlayerResult,
  waitForPlaybookQuiescence,
} from '../../../src/xstate-runtime.js';
import type { NestedPlaybookBridge } from '../../../src/xstate-runtime.js';

import decideMachine, {
  type PlayerInput,
  type PlayerOutput,
  type DecideEvent,
  type DecideInput,
  type PendingBossQuestion,
  type PlaybookInput,
} from './decide.fsm.js';

import type {
  CaptainCallOptions,
  CaptainResult,
  JsonValue,
  NormalizedError,
  PlayerCallOptions,
  PlayerResult,
  PlayerSessionStore,
  PlaybookCallRequest,
  PlaybookCallResult,
  PlaybookCallStart,
  PlaybookControlAction,
  PlaybookControlReceipt,
  PlaybookControlView,
  PlaybookEffectBoundary,
  PlaybookEffectBoundaryStart,
  PlaybookEffectLedger,
  PlaybookPendingBossQuestion,
  PlaybookPendingCall,
  PlaybookPorts,
  PlaybookRepositoryReceipt,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
  PlaybookStateValue,
  PlaybookTraceEvent,
  PlaybookTraceType,
} from '@sublang/playbook/runtime';

export type {
  CaptainCallOptions,
  CaptainResult,
  JsonValue,
  NormalizedError,
  PlayerCallOptions,
  PlayerResult,
  PlayerSessionStore,
  PlaybookCallRequest,
  PlaybookCallResult,
  PlaybookCallStart,
  PlaybookControlAction,
  PlaybookControlReceipt,
  PlaybookControlView,
  PlaybookPendingCall,
  PlaybookPorts,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
  PlaybookStateValue,
  PlaybookTraceEvent,
  PlaybookTraceType,
};

type RoleId = 'coder' | 'reviewer';

export type PlaybookRuntimeOptions = DecideInput;

function snapshotDecideRuntimeOptions(value: unknown): PlaybookRuntimeOptions {
  const captured = snapshotJsonValue(value, 'DECIDE runtime options');
  if (!isPlainObject(captured)) {
    throw new TypeError('DECIDE runtime options must be an object');
  }
  const [unknown] = Object.keys(captured);
  if (unknown !== undefined) {
    throw new TypeError(`DECIDE runtime options.${unknown} is not declared`);
  }
  return Object.freeze({});
}

interface AuthoredStateConfig {
  readonly meta?: {
    readonly playbook?: {
      readonly stateId?: unknown;
      readonly description?: unknown;
    };
  };
  readonly states?: Readonly<Record<string, AuthoredStateConfig>>;
}

function authoredStateDescriptions(
  states: Readonly<Record<string, AuthoredStateConfig>> | undefined,
): Readonly<Record<string, string>> {
  const descriptions: Record<string, string> = {};
  const visit = (
    children: Readonly<Record<string, AuthoredStateConfig>> | undefined,
  ): void => {
    for (const state of Object.values(children ?? {})) {
      const stateId = state.meta?.playbook?.stateId;
      const description = state.meta?.playbook?.description;
      if (
        typeof stateId === 'string' &&
        typeof description === 'string' &&
        description.trim().length > 0
      ) {
        const existing = descriptions[stateId];
        if (existing !== undefined && existing !== description) {
          throw new Error(
            `DECIDE state ${stateId} declares conflicting descriptions`,
          );
        }
        descriptions[stateId] = description;
      }
      visit(state.states);
    }
  };
  visit(states);
  return Object.freeze(descriptions);
}

const STATE_DESCRIPTIONS = authoredStateDescriptions(
  decideMachine.config.states as
    | Readonly<Record<string, AuthoredStateConfig>>
    | undefined,
);

const ROLE_STATES = [
  { stateId: 'askCoderProposal', role: 'coder', sourceItem: 'DECIDE-1' },
  {
    stateId: 'askReviewerProposal',
    role: 'reviewer',
    sourceItem: 'DECIDE-2',
  },
  { stateId: 'commitCoderProposal', role: 'coder', sourceItem: 'DECIDE-3' },
] as const;

const ROLE_STATE_IDS: ReadonlySet<string> = new Set(
  ROLE_STATES.map((state) => state.stateId),
);

const ACCEPTED_OUTCOME_DECLARATIONS: Readonly<
  Record<string, ReadonlySet<string>>
> = Object.freeze({
  askCoderProposal: new Set(['proposed', 'needsBossReply']),
  askReviewerProposal: new Set(['proposed', 'needsBossReply']),
  commitCoderProposal: new Set(['committed', 'needsBossReply']),
});

const ROLE_IDS = ['coder', 'reviewer'] as const;
const ROLE_ID_SET: ReadonlySet<string> = new Set(ROLE_IDS);

const roleLabel = (roleId: RoleId): string =>
  roleId === 'coder' ? 'Coder' : 'Reviewer';

const BOSS_INTERRUPT_TARGETS = ['independentProposals'] as const;

const BOSS_INTERRUPT_TARGET_IDS: ReadonlySet<string> = new Set(
  BOSS_INTERRUPT_TARGETS,
);
const UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string> = new Set([
  'reportedReviewFailure',
]);

const TELEMETRY_TOPIC = 'playbook.fsm.state';
const TRACE_TOPIC = 'playbook.trace';

const CONTINUATION_PREAMBLE =
  'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';

const PLACEHOLDER_FIELDS: ReadonlyArray<readonly [string, keyof PlayerInput]> =
  [['<caller-topic>', 'callerTopic']];

const VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  'coderProposal',
  'reviewerProposal',
  'coderOutput',
]);

type PromptIdentity = (roleId: RoleId) => string;

function composePlayerPrompt(
  input: PlayerInput,
  promptIdentity: PromptIdentity,
): string {
  const blocks: string[] = [];

  if (input.pendingBossQuestion && input.bossReply !== undefined) {
    blocks.push(
      [
        CONTINUATION_PREAMBLE,
        '',
        'Boss question:',
        input.pendingBossQuestion.question,
        '',
        'Boss reply:',
        input.bossReply,
      ].join('\n'),
    );
  }

  const replacements = new Map<string, string>();
  for (const [placeholder, field] of PLACEHOLDER_FIELDS) {
    const value = input[field];
    if (typeof value === 'string') replacements.set(placeholder, value);
  }
  if (input.prompt.includes('<coder-llm>')) {
    replacements.set('<coder-llm>', promptIdentity('coder'));
  }
  const body = input.prompt.replace(
    /<caller-topic>|<coder-llm>/g,
    (placeholder, offset: number, source: string) => {
      const value = replacements.get(placeholder);
      if (value === undefined) return placeholder;
      const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
      return source.slice(lineStart, offset) === '> '
        ? value.replaceAll('\n', '\n> ')
        : value;
    },
  );

  blocks.push(body);
  return blocks.join('\n\n');
}

// A `result` description names required payload fields in its
// "Output shall include ..." sentence.
function requiredFieldsFor(description: string): string[] {
  const fields: string[] = [];
  const sentence = /Output shall include([^.]*)/g;
  let span: RegExpExecArray | null;
  while ((span = sentence.exec(description)) !== null) {
    for (const field of span[1].matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
      fields.push(field[1]);
    }
  }
  return fields;
}

// LLM judges routinely wrap JSON in prose/fences or damage its tail. Match
// CODE's recovery contract: scan candidate starts in document order, prefer a
// strict balanced value at each position, then repair trailing commas and
// truncation before considering a later candidate.
function extractJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = parseJudgeJson(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJudgeJson(raw: string): unknown {
  const text = stripCodeFence(raw.trim());
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to candidate extraction and repair.
  }

  const starts: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '{' || text[index] === '[') starts.push(index);
  }
  let firstValue: { value: unknown } | undefined;
  for (const start of starts) {
    let parsedHere: { value: unknown } | undefined;
    for (const repair of [false, true]) {
      const candidate = extractJsonValue(text, start, repair);
      if (candidate === undefined) continue;
      try {
        parsedHere = { value: JSON.parse(candidate) };
      } catch {
        // Try repair at this position, then continue in document order.
        continue;
      }
      break;
    }
    if (parsedHere === undefined) continue;
    if (isPlainObject(parsedHere.value)) return parsedHere.value;
    firstValue ??= parsedHere;
  }
  if (firstValue !== undefined) return firstValue.value;
  throw new Error('judge response is not valid JSON');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function stripCodeFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fence ? fence[1].trim() : text;
}

function extractJsonValue(
  text: string,
  start: number,
  repair: boolean,
): string | undefined {
  const stack: string[] = [];
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character === '{' ? '}' : ']');
      output += character;
      continue;
    }
    if (character === '}' || character === ']') {
      if (repair) output = dropTrailingComma(output);
      output += character;
      stack.pop();
      if (stack.length === 0) return output;
      continue;
    }
    output += character;
  }
  if (!repair) return undefined;
  if (inString) output += '"';
  output = dropTrailingComma(output);
  while (stack.length > 0) output += stack.pop();
  return output;
}

function dropTrailingComma(value: string): string {
  return value.replace(/,(\s*)$/, '$1');
}

function buildClassifierPrompt(
  text: string,
  ctx: {
    state: PlaybookState;
    pendingQuestions: readonly PendingBossQuestion[];
  },
): string {
  const lines: string[] = [];
  lines.push('You are the Boss-input classifier for the decide playbook.');
  lines.push(
    'Classify the Boss message into exactly one FSM event, or into no event.',
  );
  lines.push('');
  lines.push(`Current FSM state: ${JSON.stringify(ctx.state.value)}`);
  lines.push(`Active state ids: ${ctx.state.activeStateIds.join(', ')}`);
  if (ctx.pendingQuestions.length > 0) {
    lines.push('Pending Boss questions:');
    for (const pending of ctx.pendingQuestions) {
      lines.push(
        `- ${pending.questionId} (${pending.asker.roleId}): ${pending.question}`,
      );
    }
    lines.push(
      'If the Boss message answers a pending question, classify it as BOSS_REPLY; if it is a fresh directive, classify it accordingly.',
    );
  }
  lines.push('');
  lines.push('Events and payload contracts:');
  lines.push(
    `- BOSS_INTERRUPT: required targetId string, exactly ${BOSS_INTERRUPT_TARGETS[0]}; the runtime attaches the exact Boss text as bossIntent.`,
  );
  lines.push(
    '- BOSS_REPLY: optional questionId when exactly one question is pending and required when several are pending; the runtime attaches the exact Boss text as answer.',
  );
  lines.push('- NO_ACTION: no fields.');
  lines.push('');
  lines.push('Boss message:');
  lines.push(text);
  lines.push('');
  lines.push(
    'Reply with a single JSON object: { "type": "<EVENT_TYPE>", ...declared fields }.',
  );
  lines.push('Use NO_ACTION when no FSM action applies.');
  return lines.join('\n');
}

function parseClassification(
  raw: string,
  text: string,
  pendingQuestionIds: readonly string[] = [],
): DecideEvent | { type: 'NO_ACTION' } | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  const exactKeys = (...keys: string[]): boolean => {
    const ownKeys = Reflect.ownKeys(obj);
    return (
      ownKeys.length === keys.length &&
      ownKeys.every(
        (key) => typeof key === 'string' && keys.includes(key),
      )
    );
  };
  const eventType = obj.type;

  if (eventType === 'NO_ACTION') {
    return exactKeys('type') ? { type: 'NO_ACTION' } : null;
  }

  if (eventType === 'BOSS_INTERRUPT') {
    if (
      exactKeys('type', 'targetId') &&
      typeof obj.targetId === 'string' &&
      BOSS_INTERRUPT_TARGET_IDS.has(obj.targetId)
    ) {
      return {
        type: 'BOSS_INTERRUPT',
        targetId: obj.targetId as 'independentProposals',
        bossIntent: text,
      };
    }
    return null;
  }

  if (eventType === 'BOSS_REPLY') {
    if (pendingQuestionIds.length === 0) return null;
    if (typeof obj.questionId === 'string') {
      return exactKeys('type', 'questionId') &&
        pendingQuestionIds.includes(obj.questionId)
        ? {
            type: 'BOSS_REPLY',
            questionId: obj.questionId as never,
            answer: text,
          }
        : null;
    }
    return exactKeys('type') && pendingQuestionIds.length === 1
      ? {
          type: 'BOSS_REPLY',
          questionId: pendingQuestionIds[0] as never,
          answer: text,
        }
      : null;
  }

  return null;
}

function buildAdjudicatorPrompt(
  input: PlayerInput,
  playerOutput: string,
): string {
  const lines: string[] = [];
  lines.push('You are the guard adjudicator for a playbook state machine.');
  lines.push(
    'This is hidden control work. Do not call tools, inspect files, or ' +
      'seek external evidence. Decide only from the supplied player output ' +
      'and guard descriptions. Reply with exactly one JSON object and no prose.',
  );
  lines.push(
    `The role "${roleLabel(input.role)}" produced the output below for source item ${input.sourceItem}.`,
  );
  lines.push('Choose exactly one guard whose description matches that output.');
  lines.push('');
  lines.push('Player output (verbatim):');
  lines.push('"""');
  lines.push(playerOutput);
  lines.push('"""');
  lines.push('');
  lines.push(
    'Guards (choose exactly one; the descriptions are authoritative and must be applied as written):',
  );
  for (const [guard, description] of Object.entries(input.result)) {
    lines.push(`- ${guard}: ${description}`);
  }
  const runtimeOwnedFields = new Set<string>();
  for (const description of Object.values(input.result)) {
    for (const field of requiredFieldsFor(description)) {
      if (VERBATIM_PAYLOAD_FIELDS.has(field)) runtimeOwnedFields.add(field);
    }
  }
  if (runtimeOwnedFields.size > 0) {
    lines.push('');
    lines.push(
      `The runtime owns these verbatim fields; do not include them in your JSON: ${[...runtimeOwnedFields].join(', ')}.`,
    );
  }
  lines.push('');
  lines.push(
    'Reply with a single JSON object: { "guard": "<one of the guard names above>", ...any payload fields the chosen guard description requires }.',
  );
  return lines.join('\n');
}

function parseAdjudication(
  raw: string,
  input: PlayerInput,
  finalText: string,
): PlayerOutput {
  const obj = extractJson(raw);
  if (!obj || typeof obj.guard !== 'string' || obj.guard.trim() === '') {
    throw new Error('adjudicator returned empty or malformed JSON');
  }

  const guard = obj.guard;
  if (!Object.prototype.hasOwnProperty.call(input.result, guard)) {
    throw new Error(
      `adjudicator returned undeclared guard "${guard}" for ${input.sourceItem}`,
    );
  }

  const requiredFields = requiredFieldsFor(input.result[guard]);
  const allowedFields = new Set(['guard', ...requiredFields]);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string' || !allowedFields.has(key)) {
      throw new Error(
        `adjudicator response for guard "${guard}" included undeclared field "${String(key)}"`,
      );
    }
  }
  const output: Record<string, unknown> = { guard };
  for (const field of requiredFields) {
    if (VERBATIM_PAYLOAD_FIELDS.has(field)) {
      output[field] = finalText;
      continue;
    }
    const value = obj[field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      throw new Error(
        `adjudicator response for guard "${guard}" missing required field "${field}"`,
      );
    }
    output[field] = value;
  }
  return output as PlayerOutput;
}

function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal {
  return combineAbortSignals(a, b);
}

function normalizeErrorCompact(
  err: unknown,
): { name: string; message: string } | undefined {
  if (err === undefined || err === null) return undefined;
  const normalized = normalizeError(err);
  return { name: normalized.name, message: normalized.message };
}

function normalizeErrorFull(
  err: unknown,
): { name: string; message: string; stack?: string } | undefined {
  return err === undefined || err === null ? undefined : normalizeError(err);
}

// DR-028's unified empty predicate: a missing, empty, or whitespace-only
// `finalText` on an `ok` player result is the one shape that earns exactly
// one corrective re-ask before the existing failure path applies. Mirrors
// the shared engine's predicate (PBRT-9).
function isEmptyFinalText(finalText: string | undefined): boolean {
  return finalText === undefined || finalText.trim().length === 0;
}

interface AutomaticReplayPolicy {
  allowsEmptyOkCorrection(runtimeSessionId: string, callId: string): boolean;
  allowsFailureStateRetry(): boolean;
}

interface Schema3AutomaticReplayEvidence {
  readEffectLedger(): unknown;
}

interface DecideRepositoryOperationSettlement<T> {
  readonly status: 'fulfilled';
  readonly value: T;
}

interface DecideRepositoryOperationRejection {
  readonly status: 'rejected';
  readonly reason: unknown;
}

interface DecideRepositoryCompletion<T> {
  readonly boundary: PlaybookEffectBoundary;
  readonly operation:
    | DecideRepositoryOperationSettlement<T>
    | DecideRepositoryOperationRejection;
  readonly receipt: PlaybookRepositoryReceipt;
}

interface DecideDeferredBinding {
  readonly operationId: string;
  readonly pendingQuestion: PlaybookPendingBossQuestion;
  readonly playerContinuation: JsonValue;
}

interface DecideRepositoryCompletionEvidence {
  readonly finalText?: string;
  readonly semanticCandidate?: JsonValue;
  readonly deferred?: DecideDeferredBinding;
  readonly unresolved?: true;
}

interface DecideRepositoryExclusiveResult<T> {
  readonly operation:
    | DecideRepositoryOperationSettlement<T>
    | DecideRepositoryOperationRejection;
  readonly receipt: PlaybookRepositoryReceipt;
  readonly effectLedger: PlaybookEffectLedger;
  readonly deferredStatus?: 'bound' | 'unresolved';
}

interface DecideRepositoryDeferredContinuationResult<T>
  extends DecideRepositoryExclusiveResult<T> {
  readonly status: 'continued';
  readonly baseline: PlaybookRepositoryReceipt['baseline'];
  readonly logicalReceipt?: PlaybookRepositoryReceipt;
}

interface DecideRepositoryDeferredCheckpointMismatch {
  readonly status: 'checkpoint-mismatch' | 'ineligible';
  readonly effectLedger: PlaybookEffectLedger;
}

interface DecideRepositoryDeferredParked {
  readonly status: 'parked';
  readonly effectLedger: PlaybookEffectLedger;
}

interface DecideRepositoryDeferredRestoreResult {
  readonly status: 'restored' | 'checkpoint-mismatch' | 'ineligible';
  readonly effectLedger: PlaybookEffectLedger;
}

type DecideEffectBoundarySeed = Omit<
  PlaybookEffectBoundaryStart,
  'playbookId' | 'canonicalWorktree' | 'baseline' | 'cohortId'
>;

interface DecideRepositoryCapability {
  runExclusive<T>(options: {
    readonly signal: AbortSignal;
    readonly effectBoundary: DecideEffectBoundarySeed;
    readonly operation: (context: {
      readonly baseline: PlaybookRepositoryReceipt['baseline'];
      readonly identity: unknown;
    }) => Promise<T>;
    readonly completeEffectBoundary: (
      completion: DecideRepositoryCompletion<T>,
    ) =>
      | DecideRepositoryCompletionEvidence
      | Promise<DecideRepositoryCompletionEvidence>;
  }): Promise<DecideRepositoryExclusiveResult<T>>;
  runDeferred<T>(options: {
    readonly mode: 'continue';
    readonly signal: AbortSignal;
    readonly operationId: string;
    readonly effectBoundary: DecideEffectBoundarySeed;
    readonly operation: (context: {
      readonly baseline: PlaybookRepositoryReceipt['baseline'];
      readonly identity: unknown;
      readonly playerContinuation: JsonValue;
    }) => Promise<T>;
    readonly completeEffectBoundary: (
      completion: DecideRepositoryCompletion<T>,
    ) =>
      | DecideRepositoryCompletionEvidence
      | Promise<DecideRepositoryCompletionEvidence>;
  }): Promise<
    | DecideRepositoryDeferredContinuationResult<T>
    | DecideRepositoryDeferredCheckpointMismatch
  >;
  runDeferred(options: {
    readonly mode: 'park' | 'restore';
    readonly signal: AbortSignal;
    readonly operationId: string;
  }): Promise<
    DecideRepositoryDeferredParked | DecideRepositoryDeferredRestoreResult
  >;
}

interface Schema3DeferredEffectEvidence extends Schema3AutomaticReplayEvidence {
  readonly repository: DecideRepositoryCapability;
}

interface DeferredValue<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function hasCompleteUnchangedReceipt(
  boundary: PlaybookEffectBoundary,
): boolean {
  return boundary.physicalReceipt?.classification === 'unchanged';
}

// IR-048 task 5 stages the schema-3 automatic-replay fence in DECIDE without
// moving the shipped artifact off schema 2 before its atomic task-16 cutover.
// A corrective call is bound to the exact physical boundary it would repeat.
// A failed-state restart replays the whole entry event. Cooperative host
// attempts are serialized in ledger order, so the latest durable boundary
// identifies the causal host attempt even when a nested or sibling runtime
// wrote it; every boundary in that attempt must have a complete unchanged
// receipt.
// The durable ledger remains the authority in both cases; no process-local
// player result or presentation text can make a replay safe.
function createAutomaticReplayPolicy(
  artifactSchema: 2 | 3,
  evidence?: Schema3AutomaticReplayEvidence,
): AutomaticReplayPolicy {
  if (artifactSchema === 2) {
    return Object.freeze({
      allowsEmptyOkCorrection: () => true,
      allowsFailureStateRetry: () => true,
    });
  }
  if (evidence === undefined) {
    throw new TypeError(
      'DECIDE schema-3 automatic replay requires durable effect-ledger evidence',
    );
  }

  const readLedger = (): PlaybookEffectLedger =>
    assertPlaybookEffectLedger(
      evidence.readEffectLedger(),
      'DECIDE automatic-replay effect ledger',
    );

  return Object.freeze({
    allowsEmptyOkCorrection(runtimeSessionId: string, callId: string) {
      const matching = readLedger().boundaries.filter(
        (boundary) =>
          boundary.runtimeSessionId === runtimeSessionId &&
          boundary.callId === callId,
      );
      return (
        matching.length === 1 && hasCompleteUnchangedReceipt(matching[0]!)
      );
    },

    allowsFailureStateRetry() {
      const ledger = readLedger();
      const latest = ledger.boundaries.at(-1);
      if (latest === undefined) return false;
      const attempt = ledger.boundaries.filter(
        (boundary) => boundary.attemptId === latest.attemptId,
      );
      return (
        attempt.length > 0 && attempt.every(hasCompleteUnchangedReceipt)
      );
    },
  });
}

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

function pendingQuestionsFromContext(
  context: Record<string, unknown>,
): PendingBossQuestion[] {
  const pending = context.pendingBossQuestions;
  if (
    pending === undefined ||
    pending === null ||
    typeof pending !== 'object'
  ) {
    return [];
  }
  const questions: PendingBossQuestion[] = [];
  for (const [key, value] of Object.entries(pending)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const obj = value as Record<string, unknown>;
    if (
      typeof obj.questionId === 'string' &&
      obj.questionId === key &&
      typeof obj.resumeStateId === 'string' &&
      typeof obj.sourceItem === 'string' &&
      isPlainObject(obj.asker) &&
      obj.asker.kind === 'role' &&
      ROLE_ID_SET.has(String(obj.asker.roleId)) &&
      typeof obj.question === 'string'
    ) {
      questions.push(obj as unknown as PendingBossQuestion);
    }
  }
  return questions.sort((left, right) =>
    left.questionId.localeCompare(right.questionId),
  );
}

const WAIT_STATE_RESUME_IDS: Readonly<Record<string, string>> = {
  waitCoderProposalReply: 'askCoderProposal',
  waitReviewerProposalReply: 'askReviewerProposal',
};

const WAIT_STATE_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(WAIT_STATE_RESUME_IDS),
  'awaitBossReply',
]);

const STATUS_STATE_IDS: ReadonlySet<string> = new Set([
  ...ROLE_STATE_IDS,
  ...WAIT_STATE_IDS,
  'failed',
]);

// PBRT-45: a question is pending only while its authored reply-wait state
// is active. The context retains an answered question through the resumed
// player call so the Q+A continuation prompt can quote it, and each branch
// keeps its own entry through the parallel region — so an unfiltered
// projection would report the answered question as still awaiting during
// the resume, and both branch questions after only one remains pending.
const RESUME_WAIT_STATE_IDS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(WAIT_STATE_RESUME_IDS).map(([waitStateId, resumeStateId]) => [
      resumeStateId,
      waitStateId,
    ]),
  ),
  commitCoderProposal: 'awaitBossReply',
};

function pendingQuestionsForState(
  state: PlaybookState,
  context: Record<string, unknown>,
): PendingBossQuestion[] {
  return pendingQuestionsFromContext(context).filter((pending) =>
    state.activeStateIds.includes(
      RESUME_WAIT_STATE_IDS[pending.resumeStateId] ?? '',
    ),
  );
}

function questionForWaitState(
  stateId: string,
  pendingQuestions: readonly PendingBossQuestion[],
): PendingBossQuestion | undefined {
  const resumeStateId = WAIT_STATE_RESUME_IDS[stateId];
  if (resumeStateId !== undefined) {
    return pendingQuestions.find(
      (pending) => pending.resumeStateId === resumeStateId,
    );
  }
  return stateId === 'awaitBossReply' && pendingQuestions.length === 1
    ? pendingQuestions[0]
    : undefined;
}

const TRANSITION_EVENT_FIELDS: readonly string[] = [
  'callerTopic',
  'targetId',
  'bossIntent',
  'questionId',
  'answer',
];

function normalizedTransitionEvent(event: unknown): JsonValue {
  if (event === null || typeof event !== 'object') {
    return snapshotJsonValue(event ?? null, 'FSM event');
  }
  const source = event as Record<string, unknown>;
  const descriptor: Record<string, JsonValue> = {};
  if (typeof source.type === 'string') descriptor.type = source.type;
  for (const field of TRANSITION_EVENT_FIELDS) {
    if (typeof source[field] === 'string') {
      descriptor[field] = source[field] as string;
    }
  }
  if (source.output !== undefined) {
    descriptor.output = snapshotJsonValue(source.output, 'FSM event output');
  }
  if (source.error !== undefined) {
    descriptor.error = snapshotJsonValue(
      normalizeError(source.error),
      'FSM event error',
    );
  }
  return snapshotJsonValue(descriptor, 'FSM event');
}

function telemetryPayload(
  previousState: PlaybookState | undefined,
  state: PlaybookState,
  event: unknown,
  context: Record<string, unknown>,
  hiddenQuestionId?: string,
): JsonValue {
  const pendingBossQuestions = pendingQuestionsForState(
    state,
    context,
  ).filter(({ questionId }) => questionId !== hiddenQuestionId);
  const prior = previousState ?? state;
  const payload = {
    from: prior.value,
    to: state.value,
    event: normalizedTransitionEvent(event),
    previousState: prior,
    state,
    ...(pendingBossQuestions.length > 0 ? { pendingBossQuestions } : {}),
    ...(state.activeStateIds.includes('failed')
      ? { lastError: normalizeErrorFull(context.lastError) ?? null }
      : {}),
  } satisfies Record<string, unknown>;
  assertJsonSafe(payload);
  return payload;
}

type DecidePlaybookRuntime = PlaybookRuntime & {
  _getNestedBridge(): NestedPlaybookBridge<PlaybookInput>;
};

type DeferredContinuationEnvelope = {
  readonly roleId: RoleId;
  readonly playerId?: string;
  readonly callId: string;
  readonly result: PlayerResult;
};

interface ActiveDeferredContinuation {
  readonly operationId: string;
  readonly effectBoundary: DecideEffectBoundarySeed;
  readonly result: DeferredValue<PlayerResult>;
  readonly acknowledged: DeferredValue<void>;
  playerContinuation?: string | false;
  input?: PlayerInput;
  playerId?: string;
}

type StagedDecidePlaybookRuntime = DecidePlaybookRuntime & {
  _reconcileDeferred(signal: AbortSignal): Promise<
    'restored' | 'checkpoint-mismatch' | 'ineligible'
  >;
};

function createDecidePlaybookRuntime(
  options: PlaybookRuntimeOptions,
  artifactSchema: 2 | 3,
  automaticReplayPolicy: AutomaticReplayPolicy,
  deferredEffects?: Schema3DeferredEffectEvidence,
  stagedAcceptedOutcomeAction?: unknown,
): DecidePlaybookRuntime {
  const fsmInput = snapshotDecideRuntimeOptions(options);
  const readEffectLedger = (): PlaybookEffectLedger =>
    deferredEffects === undefined
      ? emptyPlaybookEffectLedger()
      : assertPlaybookEffectLedger(
          deferredEffects.readEffectLedger(),
          'DECIDE current host effect ledger',
        );
  let effectLedgerMirror = readEffectLedger();
  const acceptedOutcomeConsumer = createAcceptedOutcomeConsumer(
    artifactSchema,
    (source, acceptedOutcome) =>
      Object.prototype.hasOwnProperty.call(
        ACCEPTED_OUTCOME_DECLARATIONS,
        source,
      ) &&
      ACCEPTED_OUTCOME_DECLARATIONS[source]?.has(acceptedOutcome) === true,
  );

  type SessionIdentity = Readonly<PlaybookSession>;

  let ports: PlaybookPorts | undefined;
  let sessionIdentity: SessionIdentity | undefined;
  let actor: ReturnType<typeof createActor> | undefined;
  let currentSignal: AbortSignal | undefined;
  let currentAborts: AbortReasonClassifier | undefined;
  const actorSettlementAborts: AbortReasonClassifier[] = [];
  let actorSettlementErrorAborts: AbortReasonClassifier | undefined;
  let currentTurnId: number | undefined;
  let previousState: PlaybookState | undefined;
  let suppressInspectionEmissions = false;
  let emissionFailures: unknown[] = [];
  let traceSequence = 0;
  let turnSequence = 0;
  let judgeCallSequence = 0;
  let playerCallSequence = 0;
  let playbookCallSequence = 0;
  let lifecycleStarted = false;
  let initInFlight: Promise<void> | undefined;
  let disposed = false;
  let disposalPromise: Promise<void> | undefined;
  let controlPlaneError: unknown;
  let nestedBridge: NestedPlaybookBridge<PlaybookInput>;
  const privateResumeTokens = new Map<string, string>();
  const playbookCallTurnIds = new Map<string, number | undefined>();
  const inFlightPlayerKeys = new Set<string>();
  const activeBoundaryCalls = new Set<Promise<unknown>>();
  const activeEmissionCalls = new Set<Promise<void>>();
  const emissionQueue = new PQueue({ concurrency: 1 });
  const judgeQueue = new PQueue({ concurrency: 1 });
  const governedOutputsByBoundaryId = new Map<string, PlayerOutput>();
  const governedPlayerOutputs = new WeakMap<object, PlayerOutput>();
  let deferredOperationId: string | undefined;
  let hiddenDeferredOperationId: string | undefined;
  let activeDeferredContinuation: ActiveDeferredContinuation | undefined;

  const collectFailure = (failures: unknown[], error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) collectFailure(failures, nested);
      return;
    }
    if (!failures.some((failure) => Object.is(failure, error))) {
      failures.push(error);
    }
  };
  const latchControlPlaneError = (
    error: unknown,
    signal: AbortSignal,
  ): void => {
    if (!isAbortFailure(error, signal)) controlPlaneError ??= error;
  };
  const latchInspectionError = (
    error: unknown,
    aborts: AbortReasonClassifier | undefined = currentAborts,
  ): void => {
    if (aborts?.isAbortReason(error)) return;
    if (currentSignal !== undefined) controlPlaneError ??= error;
    else collectFailure(emissionFailures, error);
  };
  const enqueue = (
    fn: () => Promise<void>,
    aborts: AbortReasonClassifier | undefined = currentAborts,
  ): Promise<void> => {
    const enqueueAborts = aborts;
    const queued = emissionQueue.add(fn);
    activeEmissionCalls.add(queued);
    void queued.then(
      () => activeEmissionCalls.delete(queued),
      (error: unknown) => {
        activeEmissionCalls.delete(queued);
        if (!enqueueAborts?.isAbortReason(error)) {
          collectFailure(emissionFailures, error);
        }
      },
    );
    return queued;
  };
  const flush = async (
    _aborts: AbortReasonClassifier | undefined = currentAborts,
  ): Promise<void> => {
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
    if (emissionFailures.length === 0) return;
    const failures = emissionFailures;
    emissionFailures = [];
    const failure =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'decide runtime emissions failed');
    // Enqueue ownership already classified every stored failure as distinct.
    // Preserve that classification if an unrelated public boundary drains
    // it with a signal whose reason happens to be the same object.
    if (currentSignal !== undefined) controlPlaneError ??= failure;
    throw failure;
  };
  const drainBoundaryCallsAndEmissions = async (): Promise<void> => {
    while (true) {
      if (activeBoundaryCalls.size > 0) {
        await Promise.allSettled([...activeBoundaryCalls]);
      }
      await flush();
      if (activeBoundaryCalls.size === 0) return;
    }
  };
  const trackBoundaryCall = <T>(call: Promise<T>): Promise<T> => {
    activeBoundaryCalls.add(call);
    void call.then(
      () => activeBoundaryCalls.delete(call),
      () => activeBoundaryCalls.delete(call),
    );
    return call;
  };
  const requirePorts = (): PlaybookPorts => {
    if (!ports) {
      throw new Error('decide runtime: init(session) must be called first');
    }
    return ports;
  };
  const requireSessionIdentity = (): SessionIdentity => {
    if (!sessionIdentity) {
      throw new Error('decide runtime: init(session) must be called first');
    }
    return sessionIdentity;
  };

  const bindSession = (nextSession: PlaybookSession): SessionIdentity => {
    const bound = snapshotPlaybookSession(nextSession);
    if (bound.roleBindings === undefined) return bound;
    const actual = Object.keys(bound.roleBindings).sort();
    const expected = [...ROLE_IDS].sort();
    const missing = expected.filter((roleId) => !actual.includes(roleId));
    const extra = actual.filter((roleId) => !ROLE_ID_SET.has(roleId));
    if (missing.length > 0 || extra.length > 0) {
      throw new TypeError(
        `DECIDE session roleBindings must cover exactly [${expected.join(', ')}]` +
          `${missing.length === 0 ? '' : `; missing [${missing.join(', ')}]`}` +
          `${extra.length === 0 ? '' : `; extra [${extra.join(', ')}]`}`,
      );
    }
    return bound;
  };

  const resolvedPlayerId = (roleId: RoleId): string | undefined =>
    requireSessionIdentity().roleBindings?.[roleId]?.playerId;

  const promptIdentity = (roleId: RoleId): string =>
    requireSessionIdentity().roleBindings?.[roleId]?.promptIdentity ?? roleId;

  const composeInvocationPrompt = (input: PlayerInput): string => {
    let active = true;
    const lookup: PromptIdentity = (roleId) => {
      if (!active) {
        throw new Error(
          'DECIDE prompt identity lookup is no longer active for this invocation',
        );
      }
      if (!ROLE_ID_SET.has(roleId)) {
        throw new TypeError(
          `DECIDE prompt identity lookup rejected undeclared role ${String(roleId)}`,
        );
      }
      return promptIdentity(roleId);
    };
    try {
      return composePlayerPrompt(input, lookup);
    } finally {
      active = false;
    }
  };

  const continuationKey = (
    roleId: RoleId,
    playerId: string | undefined,
  ): string => playerId ?? roleId;

  const tokensByContinuationKey = (
    tokens: Readonly<Record<string, string>>,
  ): Map<string, string> => {
    const byKey = new Map<string, string>();
    for (const [roleId, token] of Object.entries(tokens)) {
      if (!ROLE_ID_SET.has(roleId)) {
        throw new TypeError(
          `DECIDE role tokens contain unknown role ${roleId}`,
        );
      }
      const typedRole = roleId as RoleId;
      const key = continuationKey(typedRole, resolvedPlayerId(typedRole));
      const prior = byKey.get(key);
      if (prior !== undefined && prior !== token) {
        throw new TypeError(
          `DECIDE runtime snapshot assigns conflicting tokens to roles bound to player ${key}`,
        );
      }
      byKey.set(key, token);
    }
    const rolesByKey = new Map<string, RoleId[]>();
    for (const roleId of ROLE_IDS) {
      const key = continuationKey(roleId, resolvedPlayerId(roleId));
      rolesByKey.set(key, [...(rolesByKey.get(key) ?? []), roleId]);
    }
    for (const [key, roles] of rolesByKey) {
      if (roles.length < 2) continue;
      const present = roles.filter((roleId) => tokens[roleId] !== undefined);
      if (present.length !== 0 && present.length !== roles.length) {
        throw new TypeError(
          `DECIDE role tokens must project player ${key} through every aliased role [${roles.join(', ')}]`,
        );
      }
    }
    return byKey;
  };

  const selectPlayerResume = (
    roleId: RoleId,
    playerId: string | undefined,
  ): string | false => {
    const session = requireSessionIdentity();
    const selected = session.playerSessions
      ? session.playerSessions.select(roleId)
      : privateResumeTokens.get(continuationKey(roleId, playerId)) ?? false;
    if (
      selected !== false &&
      (typeof selected !== 'string' || selected.trim().length === 0)
    ) {
      throw new TypeError(
        `player session store returned an invalid resume token for role ${roleId}`,
      );
    }
    return selected;
  };
  const updatePlayerResume = (
    roleId: RoleId,
    playerId: string | undefined,
    result: PlayerResult,
  ): void => {
    if (result.resumeToken === undefined && result.status !== 'ok') return;
    const session = requireSessionIdentity();
    if (session.playerSessions) {
      session.playerSessions.update(roleId, result.resumeToken);
    } else if (result.resumeToken !== undefined) {
      privateResumeTokens.set(
        continuationKey(roleId, playerId),
        result.resumeToken,
      );
    } else {
      privateResumeTokens.delete(continuationKey(roleId, playerId));
    }
  };
  const snapshotRoleResumeTokens = (): Record<string, string> => {
    const session = requireSessionIdentity();
    const captured = snapshotJsonValue(
      session.playerSessions
        ? session.playerSessions.snapshot()
        : Object.fromEntries(
            ROLE_IDS.flatMap((roleId) => {
              const token = privateResumeTokens.get(
                continuationKey(roleId, resolvedPlayerId(roleId)),
              );
              return token === undefined ? [] : [[roleId, token]];
            }),
          ),
      'player session store snapshot',
    );
    if (!isPlainObject(captured)) {
      throw new TypeError('player session store snapshot must be an object');
    }
    const tokens: Record<string, string> = {};
    for (const [roleId, token] of Object.entries(captured)) {
      if (!ROLE_ID_SET.has(roleId)) {
        throw new TypeError(
          `player session store snapshot contains unknown role ${roleId}`,
        );
      }
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new TypeError(
          `player session store snapshot token for ${roleId} must be a non-empty string`,
        );
      }
      tokens[roleId] = token;
    }
    tokensByContinuationKey(tokens);
    return tokens;
  };
  const restoreRoleResumeTokens = (
    tokens: Readonly<Record<string, string>>,
  ): void => {
    const byKey = tokensByContinuationKey(tokens);
    const session = requireSessionIdentity();
    if (session.playerSessions) {
      session.playerSessions.restore(tokens);
      return;
    }
    privateResumeTokens.clear();
    for (const [key, token] of byKey) privateResumeTokens.set(key, token);
  };
  const currentState = (
    pendingCall: PlaybookPendingCall | undefined =
      nestedBridge.getPendingCall(),
  ): PlaybookState => {
    const live = actor;
    if (!live) {
      throw new Error('decide runtime: actor is not initialized');
    }
    return normalizePlaybookSnapshot(live.getSnapshot(), {
      pendingCall,
    });
  };
  const visiblePendingQuestionsForState = (
    state: PlaybookState,
    context: Record<string, unknown>,
  ): PendingBossQuestion[] =>
    pendingQuestionsForState(state, context).filter(
      ({ questionId }) =>
        questionId !== 'commitCoderProposal' ||
        hiddenDeferredOperationId === undefined,
    );
  const openDeferredOperation = (
    ledger: PlaybookEffectLedger = effectLedgerMirror,
  ) => {
    if (sessionIdentity === undefined) return undefined;
    const open = ledger.logicalOperations.filter(
      (operation) =>
        operation.playbookId === sessionIdentity!.playbookId &&
        operation.runtimeSessionId === sessionIdentity!.sessionId &&
        operation.logicalReceipt === undefined,
    );
    if (open.length > 1) {
      throw new TypeError(
        'DECIDE runtime has multiple open deferred logical operations',
      );
    }
    return open[0];
  };
  const synchronizeDeferredProjection = (
    ledger: PlaybookEffectLedger = effectLedgerMirror,
  ): void => {
    if (deferredEffects === undefined) return;
    effectLedgerMirror = ledger;
    const operation = openDeferredOperation(ledger);
    if (operation === undefined) {
      deferredOperationId = undefined;
      hiddenDeferredOperationId = undefined;
      return;
    }
    deferredOperationId = operation.operationId;
    hiddenDeferredOperationId =
      operation.pendingQuestion !== undefined &&
      operation.playerContinuation !== undefined &&
      operation.checkpoint !== undefined &&
      operation.checkpointRestorationEligible === false
        ? undefined
        : operation.operationId;
  };
  const stateIdentity = (state: PlaybookState): { stateId?: string } => {
    return state.stateId === undefined ? {} : { stateId: state.stateId };
  };
  const enqueueTracedEmission = (
    type: PlaybookTraceType,
    payload: unknown,
    meta: { turnId?: number; callId?: string } = {},
    describedEmission?: (runtimePorts: PlaybookPorts) => Promise<void>,
    aborts?: AbortReasonClassifier,
  ): Promise<void> => {
    const trace = createTraceEvent(type, payload, meta);
    return enqueue(
      async () => {
        const runtimePorts = requirePorts();
        await runtimePorts.emitTelemetry({ topic: TRACE_TOPIC, payload: trace });
        await describedEmission?.(runtimePorts);
      },
      aborts,
    );
  };
  const createTraceEvent = (
    type: PlaybookTraceType,
    payload: unknown,
    meta: { turnId?: number; callId?: string } = {},
  ): PlaybookTraceEvent => {
    const identity = requireSessionIdentity();
    const jsonPayload = snapshotJsonValue(payload, `trace ${type} payload`);
    return Object.freeze({
      schemaVersion: 4,
      sessionId: identity.sessionId,
      playbookId: identity.playbookId,
      rootSessionId: identity.rootSessionId,
      ...(identity.parentSessionId !== undefined
        ? { parentSessionId: identity.parentSessionId }
        : {}),
      ...(identity.parentCallId !== undefined
        ? { parentCallId: identity.parentCallId }
        : {}),
      depth: identity.depth,
      sequence: ++traceSequence,
      timestamp: Date.now(),
      type,
      ...(meta.turnId !== undefined ? { turnId: meta.turnId } : {}),
      ...(meta.callId !== undefined ? { callId: meta.callId } : {}),
      payload: jsonPayload,
    });
  };
  const emitTrace = (
    type: PlaybookTraceType,
    payload: unknown,
    meta: { turnId?: number; callId?: string } = {},
    aborts?: AbortReasonClassifier,
  ): Promise<void> => enqueueTracedEmission(type, payload, meta, undefined, aborts);
  const enqueueAcceptedOutcomeEmission = (
    acceptedOutcome: AcceptedOutcomeReceipt,
    state: PlaybookState,
    aborts?: AbortReasonClassifier,
  ): Promise<void> => {
    const message = `→ ${acceptedOutcome.acceptedOutcome}`;
    const acceptedTrace = createTraceEvent(
      'outcome.accepted',
      acceptedOutcome,
      { turnId: currentTurnId },
    );
    const statusTrace = createTraceEvent(
      'status.emitted',
      { stateId: acceptedOutcome.target, message, state },
      { turnId: currentTurnId },
    );
    return enqueue(
      async () => {
        const runtimePorts = requirePorts();
        await runtimePorts.emitTelemetry({
          topic: TRACE_TOPIC,
          payload: acceptedTrace,
        });
        await runtimePorts.emitTelemetry({
          topic: TRACE_TOPIC,
          payload: statusTrace,
        });
        await runtimePorts.emitStatus(message);
      },
      aborts,
    );
  };
  const emitBoundaryStatus = async (
    message: string,
    state: PlaybookState,
  ): Promise<void> => {
    const bossRelevantStateIds = state.activeStateIds.filter((stateId) =>
      STATUS_STATE_IDS.has(stateId),
    );
    await enqueueTracedEmission(
      'status.emitted',
      {
        ...(bossRelevantStateIds.length === 1
          ? { stateId: bossRelevantStateIds[0] }
          : {}),
        message,
        state,
      },
      { turnId: currentTurnId },
      (runtimePorts) => runtimePorts.emitStatus(message),
    );
  };

  const emitCallStarted = async (
    startedType: 'player.call.started' | 'judge.call.started',
    finishedType: 'player.call.finished' | 'judge.call.finished',
    identity: Record<string, unknown>,
    meta: { turnId?: number; callId?: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const aborts = abortReasonClassifier(signal);
    try {
      await emitTrace(startedType, identity, meta, aborts);
    } catch (error) {
      latchControlPlaneError(error, signal);
      try {
        await emitTrace(
          finishedType,
          {
            ...identity,
            // A started-trace sink rejection causally identical to the
            // boundary reason is the abort's own evidence: the pair
            // finishes 'aborted', not 'error' (DR-036 §4).
            status: isAbortFailure(error, signal) ? 'aborted' : 'error',
            error: normalizeErrorFull(error) ?? {
              name: 'Error',
              message: String(error),
            },
          },
          meta,
          aborts,
        );
      } catch {
        // Preserve the start failure after one best-effort finish attempt.
      }
      throw error;
    }
  };

  const runJudgeCall = async (
    prompt: string,
    signal: AbortSignal,
    purpose: 'boss-input-classification' | 'player-output-adjudication',
    callStateId: string | undefined,
  ): Promise<string> => {
    const aborts = abortReasonClassifier(signal);
    const identity = {
      purpose,
      ...(callStateId !== undefined ? { stateId: callStateId } : {}),
    };
    const queued = await judgeQueue.add(async () => {
      // Keep the complete queue task pending until an active coder promise
      // settles. PQueue's signal option may reject add() while that task is
      // still running, which would let the turn drain race a late finish.
      signal.throwIfAborted();
      const callId = `judge-${++judgeCallSequence}`;
      await emitCallStarted(
        'judge.call.started',
        'judge.call.finished',
        { ...identity, prompt },
        { turnId: currentTurnId, callId },
        signal,
      );

      let finalText: string;
      try {
        signal.throwIfAborted();
        const reply: unknown = await requirePorts().callJudge(prompt, signal);
        if (typeof reply !== 'string') {
          throw new TypeError('judge result must be a string');
        }
        finalText = reply;
        // A cancelled parallel actor can outlive a judge port that ignores
        // its signal. Do not report that late resolution as success.
        signal.throwIfAborted();
      } catch (error) {
        latchControlPlaneError(error, signal);
        await emitTrace(
          'judge.call.finished',
          {
            ...identity,
            // Only the exact abort reason is cancellation; a distinct
            // failure under an aborted signal stays an error
            // (slc/link.md §Abort).
            status: isAbortFailure(error, signal) ? 'aborted' : 'error',
            error: normalizeErrorFull(error) ?? {
              name: 'Error',
              message: String(error),
            },
          },
          { turnId: currentTurnId, callId },
          aborts,
        );
        throw error;
      }

      await emitTrace(
        'judge.call.finished',
        { ...identity, status: 'ok', reply: finalText },
        { turnId: currentTurnId, callId },
        aborts,
      );
      return finalText;
    });
    if (queued === undefined) {
      throw new Error('judge call completed without a reply');
    }
    return queued;
  };

  const callJudge = (
    prompt: string,
    signal: AbortSignal,
    purpose: 'boss-input-classification' | 'player-output-adjudication',
    callStateId: string | undefined,
  ): Promise<string> =>
    trackBoundaryCall(runJudgeCall(prompt, signal, purpose, callStateId));

  const runPlayerCall = async (
    input: PlayerInput,
    signal: AbortSignal,
    continuation?: {
      readonly resume?: string | false;
      readonly callId: string;
    },
  ): Promise<DeferredContinuationEnvelope> => {
    const aborts = abortReasonClassifier(signal);
    if (!ROLE_ID_SET.has(input.role)) {
      throw new TypeError(
        `DECIDE player input role must name a declared local role`,
      );
    }
    const roleId = input.role;
    const playerId = resolvedPlayerId(roleId);
    const playerKey = continuationKey(roleId, playerId);
    const prompt = composeInvocationPrompt(input);
    let resume: PlayerCallOptions['resume'];
    try {
      signal.throwIfAborted();
      resume =
        continuation !== undefined &&
        Object.prototype.hasOwnProperty.call(continuation, 'resume')
          ? continuation.resume!
          : selectPlayerResume(roleId, playerId);
    } catch (error) {
      latchControlPlaneError(error, signal);
      throw error;
    }
    const callId =
      continuation?.callId ?? `player-${++playerCallSequence}`;
    const identity = {
      stateId: input.stateId,
      sourceItem: input.sourceItem,
      roleId,
      ...(playerId === undefined ? {} : { playerId }),
      resume,
    };
    const emitFailure = (error: unknown): Promise<void> =>
      emitTrace(
        'player.call.finished',
        {
          ...identity,
          // Only the exact abort reason is cancellation; a distinct
          // failure under an aborted signal stays an error
          // (slc/link.md §Abort).
          status: isAbortFailure(error, signal) ? 'aborted' : 'error',
          error: normalizeErrorFull(error) ?? {
            name: 'Error',
            message: String(error),
          },
        },
        { turnId: currentTurnId, callId },
        aborts,
      );
    if (inFlightPlayerKeys.has(playerKey)) {
      const error = new Error(
        `resolved player key "${playerKey}" already has an in-flight call`,
      );
      await emitCallStarted(
        'player.call.started',
        'player.call.finished',
        { ...identity, prompt },
        { turnId: currentTurnId, callId },
        signal,
      );
      await emitFailure(error);
      throw error;
    }
    inFlightPlayerKeys.add(playerKey);
    try {
      await emitCallStarted(
        'player.call.started',
        'player.call.finished',
        { ...identity, prompt },
        { turnId: currentTurnId, callId },
        signal,
      );

      let rawResult: unknown;
      try {
        signal.throwIfAborted();
        const boundary = Promise.resolve(
          requirePorts().callPlayer(roleId, prompt, signal, { resume }),
        );
        rawResult = await boundary;
        // An XState sibling cancellation does not cancel an arbitrary coder
        // promise. Re-check before a late resolution can mutate continuity or
        // masquerade as a successful boundary finish.
        signal.throwIfAborted();
      } catch (error) {
        // A rejected call produced no authoritative result, so the previous
        // token remains untouched. This also covers a coder promise that
        // resolves after its invocation signal was cancelled.
        latchControlPlaneError(error, signal);
        try {
          await emitFailure(error);
        } catch {
          // The original non-abort port rejection remains authoritative.
        }
        throw error;
      }

      let result: PlayerResult;
      try {
        result = validatePlayerResult(rawResult);
      } catch (error) {
        latchControlPlaneError(error, signal);
        try {
          await emitFailure(error);
        } catch {
          // The malformed coder result remains authoritative.
        }
        throw error;
      }

      // The resolved result is authoritative even on aborted/error status.
      // Update continuation state before interpreting that status.
      try {
        updatePlayerResume(roleId, playerId, result);
      } catch (error) {
        latchControlPlaneError(error, signal);
        try {
          await emitFailure(error);
        } catch {
          // The continuation-store failure remains authoritative.
        }
        throw error;
      }

      // Keep this finish outside the boundary catch. A trace sink can record
      // the event and then reject; retrying from that catch would duplicate the
      // same call id and falsely recast an emission failure as a player error.
      await emitTrace(
        'player.call.finished',
        {
          ...identity,
          status: result.status,
          ...(result.resumeToken !== undefined
            ? { resumeToken: result.resumeToken }
            : {}),
          ...(result.finalText !== undefined
            ? { finalText: result.finalText }
            : {}),
          ...(result.error !== undefined
            ? { error: normalizeErrorFull(result.error) }
            : {}),
        },
        { turnId: currentTurnId, callId },
        aborts,
      );
      return {
        roleId,
        ...(playerId === undefined ? {} : { playerId }),
        callId,
        result,
      };
    } finally {
      inFlightPlayerKeys.delete(playerKey);
    }
  };

  const governedBoundarySeed = (
    input: PlayerInput,
    callId: string,
  ): DecideEffectBoundarySeed => {
    if (
      currentTurnId === undefined ||
      !Number.isSafeInteger(currentTurnId) ||
      currentTurnId <= 0
    ) {
      throw new Error(
        'DECIDE governed player call requires an active positive turn id',
      );
    }
    return {
      boundaryId: randomUUID(),
      runtimeSessionId: requireSessionIdentity().sessionId,
      turnId: currentTurnId,
      callId,
      roleId: input.role,
      sourceStateId: input.stateId,
      sourceOutcomeSchema: snapshotJsonValue(
        input.result,
        'DECIDE governed player source outcome schema',
      ),
      dispositions: ['one-descendant-commit', 'deferred'],
      correctionBudget: { limit: 1, spent: false },
    };
  };

  const completionEvidenceFor = (
    input: PlayerInput,
    roleId: RoleId,
    playerId: string | undefined,
    signal: AbortSignal,
    operationId?: string,
  ) =>
    async ({
      boundary,
      operation,
    }: DecideRepositoryCompletion<PlayerResult>): Promise<DecideRepositoryCompletionEvidence> => {
      if (
        operation.status !== 'fulfilled' ||
        operation.value.status !== 'ok' ||
        isEmptyFinalText(operation.value.finalText)
      ) {
        const incomplete =
          operation.status === 'fulfilled' &&
          operation.value.finalText !== undefined
            ? { finalText: operation.value.finalText }
            : {};
        return operationId === undefined
          ? incomplete
          : { ...incomplete, unresolved: true };
      }
      const finalText = operation.value.finalText!;
      const output = parseAdjudication(
        await callJudge(
          buildAdjudicatorPrompt(input, finalText),
          signal,
          'player-output-adjudication',
          input.stateId,
        ),
        input,
        finalText,
      );
      governedOutputsByBoundaryId.set(boundary.boundaryId, output);
      const semanticCandidate = snapshotJsonValue(
        output,
        'DECIDE governed semantic candidate',
      );
      if (output.guard !== 'needsBossReply') {
        return { finalText, semanticCandidate };
      }
      if (typeof output.question !== 'string' || output.question.trim() === '') {
        throw new TypeError(
          'DECIDE deferred outcome must carry one exact Boss question',
        );
      }
      const pendingQuestion: PlaybookPendingBossQuestion = {
        questionId: input.stateId,
        asker: { kind: 'role', roleId },
        question: output.question,
        sourceItem: input.sourceItem,
      };
      return {
        finalText,
        semanticCandidate,
        deferred: {
          operationId: operationId ?? randomUUID(),
          pendingQuestion,
          playerContinuation: snapshotJsonValue(
            selectPlayerResume(roleId, playerId),
            'DECIDE deferred player continuation',
          ),
        },
      };
    };

  const acknowledgeGovernedPlayerResult = (
    value: DecideRepositoryExclusiveResult<PlayerResult>,
    boundaryId: string,
  ): PlayerResult => {
    const ledger = assertPlaybookEffectLedger(
      value.effectLedger,
      'DECIDE repository settlement effect ledger',
    );
    const completed = ledger.boundaries.find(
      (candidate) => candidate.boundaryId === boundaryId,
    );
    if (
      completed === undefined ||
      completed.physicalReceipt === undefined ||
      stableJson(completed.physicalReceipt, 'DECIDE completed receipt') !==
        stableJson(value.receipt, 'DECIDE acknowledged receipt')
    ) {
      throw new TypeError(
        'DECIDE repository settlement did not acknowledge its completed boundary',
      );
    }
    effectLedgerMirror = ledger;
    if (value.operation.status === 'rejected') {
      throw value.operation.reason;
    }
    const result = validatePlayerResult(value.operation.value);
    const output = governedOutputsByBoundaryId.get(boundaryId);
    if (output !== undefined) {
      governedOutputsByBoundaryId.delete(boundaryId);
      governedPlayerOutputs.set(result, output);
    }
    const linkedOperationId = completed.logicalOperationId;
    if (value.deferredStatus === 'unresolved') {
      if (linkedOperationId === undefined) {
        throw new TypeError(
          'DECIDE unresolved deferred settlement omitted its logical operation',
        );
      }
      deferredOperationId = linkedOperationId;
      hiddenDeferredOperationId = linkedOperationId;
      return result;
    }
    if (value.deferredStatus === 'bound') {
      if (linkedOperationId === undefined) {
        throw new TypeError(
          'DECIDE bound deferred settlement omitted its logical operation',
        );
      }
      deferredOperationId = linkedOperationId;
      hiddenDeferredOperationId = undefined;
    } else if (
      'status' in value &&
      value.status === 'continued' &&
      (value as { readonly logicalReceipt?: PlaybookRepositoryReceipt })
        .logicalReceipt === undefined &&
      linkedOperationId !== undefined
    ) {
      deferredOperationId = linkedOperationId;
      hiddenDeferredOperationId = linkedOperationId;
    } else if (linkedOperationId !== undefined) {
      deferredOperationId = undefined;
      hiddenDeferredOperationId = undefined;
    }
    return result;
  };

  const callPlayer = (
    input: PlayerInput,
    signal: AbortSignal,
  ): Promise<DeferredContinuationEnvelope> => {
    const invocation = async (): Promise<DeferredContinuationEnvelope> => {
      if (
        deferredEffects === undefined ||
        input.stateId !== 'commitCoderProposal'
      ) {
        return runPlayerCall(input, signal);
      }

      const active = activeDeferredContinuation;
      if (active !== undefined) {
        if (
          active.effectBoundary.runtimeSessionId !==
            requireSessionIdentity().sessionId ||
          active.effectBoundary.turnId !== currentTurnId ||
          active.effectBoundary.roleId !== input.role ||
          active.effectBoundary.sourceStateId !== input.stateId ||
          active.playerContinuation === undefined
        ) {
          throw new TypeError(
            'DECIDE deferred continuation did not invoke its bound player boundary',
          );
        }
        active.input = input;
        active.playerId = resolvedPlayerId(input.role);
        try {
          const envelope = await runPlayerCall(input, signal, {
            callId: active.effectBoundary.callId,
            resume: active.playerContinuation,
          });
          active.result.resolve(envelope.result);
          await active.acknowledged.promise;
          return envelope;
        } catch (error) {
          active.result.reject(error);
          try {
            await active.acknowledged.promise;
          } catch (acknowledgementError) {
            throw acknowledgementError;
          }
          throw error;
        }
      }

      const callId = `player-${++playerCallSequence}`;
      const effectBoundary = governedBoundarySeed(input, callId);
      let envelope: DeferredContinuationEnvelope | undefined;
      const settled = await deferredEffects.repository.runExclusive({
        signal,
        effectBoundary,
        operation: async () => {
          envelope = await runPlayerCall(input, signal, { callId });
          return envelope.result;
        },
        completeEffectBoundary: completionEvidenceFor(
          input,
          input.role,
          resolvedPlayerId(input.role),
          signal,
        ),
      });
      const result = acknowledgeGovernedPlayerResult(
        settled,
        effectBoundary.boundaryId,
      );
      if (envelope === undefined) {
        throw new TypeError(
          'DECIDE repository settlement omitted its player invocation',
        );
      }
      return { ...envelope, result };
    };
    return trackBoundaryCall(invocation());
  };

  const player = fromPromise<PlayerOutput, PlayerInput>(
    async ({ input, signal }) => {
      const combined = combineSignals(signal, currentSignal);
      const settlementAborts = abortReasonClassifier(combined);
      try {
        // XState starts invoked actors while publishing the entering snapshot.
        // Yield through the runtime emission queue before crossing the player
        // boundary so state trace/status always precede its call-start trace.
        combined.throwIfAborted();
        try {
          await flush(settlementAborts);
        } catch (error) {
          latchControlPlaneError(error, combined);
          throw error;
        }
        combined.throwIfAborted();

        let { roleId, playerId, callId, result } = await callPlayer(
          input,
          combined,
        );
        if (
          result.status === 'ok' &&
          isEmptyFinalText(result.finalText) &&
          automaticReplayPolicy.allowsEmptyOkCorrection(
            requireSessionIdentity().sessionId,
            callId,
          )
        ) {
          // DR-028: an `ok` result whose finalText is missing, empty, or
          // whitespace-only earns exactly one corrective re-ask — the same
          // composed call repeated, traced by runPlayerCall as its own
          // player-call pair, with the resume selection re-read from the
          // token map the first result left (PBRT-38). An abort that lands
          // between the two calls ends the turn without the re-ask (aborts
          // are never retried), and a rejecting finish emission rejects
          // `callPlayer` itself, so it never reaches this branch (PBRT-47).
          combined.throwIfAborted();
          ({ roleId, playerId, callId, result } = await callPlayer(
            input,
            combined,
          ));
        }
        if (result.status !== 'ok') {
          throw new Error(
            `${roleLabel(roleId)}${
              playerId === undefined ? '' : ` (${playerId})`
            } returned status "${result.status}"${
              result.error ? `: ${result.error}` : ''
            }`,
          );
        }
        const finalText = result.finalText ?? '';
        if (isEmptyFinalText(finalText)) {
          throw new Error(
            `${roleLabel(roleId)}${
              playerId === undefined ? '' : ` (${playerId})`
            } returned status "ok" with no finalText`,
          );
        }
        combined.throwIfAborted();

        const governedOutput = governedPlayerOutputs.get(result);
        if (governedOutput !== undefined) {
          governedPlayerOutputs.delete(result);
          return governedOutput;
        }

        try {
          const prompt = buildAdjudicatorPrompt(input, finalText);
          return parseAdjudication(
            await callJudge(
              prompt,
              combined,
              'player-output-adjudication',
              input.stateId,
            ),
            input,
            finalText,
          );
        } catch (error) {
          latchControlPlaneError(error, combined);
          throw error;
        }
      } finally {
        actorSettlementAborts.push(settlementAborts);
      }
    },
  );

  nestedBridge = createNestedPlaybookBridge<PlaybookInput>({
    nextCallId: () => `playbook-${++playbookCallSequence}`,
    getBoundarySignal: () => currentSignal,
    callPlaybook: (request, signal) =>
      trackBoundaryCall(
        Promise.resolve(requirePorts().callPlaybook(request, signal)),
      ),
    emitStarted: async (event, aborts) => {
      playbookCallTurnIds.set(event.callId, currentTurnId);
      await emitTrace(
        'playbook.call.started',
        {
          stateId: event.stateId,
          playbookId: event.playbookId,
          text: event.text,
        },
        {
          ...(currentTurnId === undefined ? {} : { turnId: currentTurnId }),
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
            ...(turnId === undefined ? {} : { turnId }),
            callId: event.callId,
          },
          aborts,
        );
      } finally {
        playbookCallTurnIds.delete(event.callId);
      }
    },
    drain: flush,
    bindResumeSignal: (signal, aborts) => {
      currentSignal = signal;
      currentAborts = aborts ?? abortReasonClassifier(signal);
    },
    bindActorSettlement: (aborts) => {
      actorSettlementAborts.push(aborts);
    },
    onControlPlaneError: (error, aborts) => {
      if (
        !aborts?.isAbortReason(error) &&
        !currentAborts?.isAbortReason(error)
      ) {
        controlPlaneError ??= error;
      }
    },
    onBackgroundError: (error, aborts) => {
      if (!aborts?.isAbortReason(error)) {
        collectFailure(emissionFailures, error);
      }
    },
  });

  const providedMachine = decideMachine.provide({
    actors: { player, playbook: nestedBridge.actorLogic },
    ...(stagedAcceptedOutcomeAction === undefined
      ? {}
      : {
          actions: {
            clearBranchBossReplyContext: stagedAcceptedOutcomeAction,
          } as never,
        }),
  });

  const consumeActorSettlementAborts = (
    forSnapshot = false,
  ): AbortReasonClassifier | undefined => {
    const aborts = actorSettlementAborts.shift() ?? actorSettlementErrorAborts;
    actorSettlementErrorAborts = undefined;
    if (forSnapshot && aborts !== undefined) {
      actorSettlementErrorAborts = aborts;
      queueMicrotask(() => {
        if (actorSettlementErrorAborts === aborts) {
          actorSettlementErrorAborts = undefined;
        }
      });
    }
    return aborts;
  };

  const inspect = (event: InspectionEvent): void => {
    if (actor === undefined || event.actorRef !== actor) return;
    if (suppressInspectionEmissions) return;
    if (event.type === '@xstate.action') {
      try {
        acceptedOutcomeConsumer.capture(event.action);
      } catch (error) {
        latchInspectionError(error);
      }
      return;
    }
    if (event.type !== '@xstate.snapshot') return;
    const settlementAborts = consumeActorSettlementAborts(true);
    try {
      const snapshot = event.snapshot as SnapshotFrom<typeof decideMachine>;
      const state = normalizePlaybookSnapshot(snapshot);
      const prior = previousState ?? state;
      let acceptedOutcomes: readonly AcceptedOutcomeReceipt[] = [];
      try {
        acceptedOutcomes = acceptedOutcomeConsumer.confirm(previousState, state);
      } catch (error) {
        latchInspectionError(error);
      }
      const context = snapshot.context as unknown as Record<string, unknown>;
      const fsmPayload = telemetryPayload(
        prior,
        state,
        event.event,
        context,
        hiddenDeferredOperationId === undefined
          ? undefined
          : 'commitCoderProposal',
      );
      const describedFsmPayload = snapshotJsonValue(
        fsmPayload,
        'described FSM telemetry',
      );

      void enqueueTracedEmission(
        'fsm.transition',
        fsmPayload,
        { turnId: currentTurnId },
        (emissionPorts) =>
          emissionPorts.emitTelemetry({
            topic: TELEMETRY_TOPIC,
            payload: describedFsmPayload,
          }),
        settlementAborts,
      ).catch(() => undefined);

      const priorIds = new Set(previousState?.activeStateIds ?? []);
      previousState = state;
      const pendingQuestions = visiblePendingQuestionsForState(state, context);
      const bossRelevantStateIds = state.activeStateIds.filter((stateId) =>
        STATUS_STATE_IDS.has(stateId),
      );
      const scheduleStatus = (
        message: string,
        stateId: string,
        data?: JsonValue,
      ): void => {
        const tracePayload = {
          ...(bossRelevantStateIds.length === 1 ? { stateId } : {}),
          message,
          state,
          ...(data !== undefined ? { data } : {}),
        };
        assertJsonSafe(tracePayload);
        void enqueueTracedEmission(
          'status.emitted',
          tracePayload,
          { turnId: currentTurnId },
          (emissionPorts) => emissionPorts.emitStatus(message, data),
          settlementAborts,
        ).catch(() => undefined);
      };

      for (const acceptedOutcome of acceptedOutcomes) {
        void enqueueAcceptedOutcomeEmission(
          acceptedOutcome,
          state,
          settlementAborts,
        ).catch(() => undefined);
      }

      for (const activeStateId of state.activeStateIds) {
        if (
          priorIds.has(activeStateId) ||
          !STATUS_STATE_IDS.has(activeStateId)
        ) {
          continue;
        }
        if (WAIT_STATE_IDS.has(activeStateId)) {
          const pending = questionForWaitState(
            activeStateId,
            pendingQuestions,
          );
          if (pending) {
            scheduleStatus(
              `${pending.asker.roleId} asks: ${pending.question}`,
              activeStateId,
            );
            scheduleStatus(
              `◆ awaiting Boss reply · ${pending.resumeStateId} · ${pending.asker.roleId} · ${pending.sourceItem}`,
              activeStateId,
            );
          }
          continue;
        }
        const lastError =
          activeStateId === 'failed'
            ? normalizeErrorCompact(context.lastError)
            : undefined;
        const description = STATE_DESCRIPTIONS[activeStateId];
        if (description === undefined) continue;
        const roleState = ROLE_STATES.find(
          (candidate) => candidate.stateId === activeStateId,
        );
        scheduleStatus(
          roleState === undefined
            ? '◆ workflow failed; awaiting Boss recovery.'
            : `⤷ ${roleLabel(roleState.role)}: ${description}`,
          activeStateId,
          lastError === undefined ? undefined : { lastError },
        );
      }
    } catch (error) {
      acceptedOutcomeConsumer.reset();
      latchInspectionError(error, settlementAborts);
    }
  };

  const createRuntimeActor = (machineSnapshot?: JsonValue): void => {
    previousState = undefined;
    acceptedOutcomeConsumer.reset();
    // DR-014 §1: a restore rehydrates the persisted machine snapshot;
    // XState derives context/value from it and ignores `input` then.
    actor = createActor(providedMachine, {
      input: fsmInput,
      ...(machineSnapshot === undefined
        ? {}
        : {
            snapshot: machineSnapshot as unknown as SnapshotFrom<
              typeof decideMachine
            >,
          }),
      inspect,
    });
    // A synchronous FSM action throw errors the actor without any pending
    // boundary await to observe it; unobserved, XState would surface it via
    // reportUnhandledError as an uncaughtException. Observe it here: latch
    // it as a control error while a turn signal is active (unless it is
    // the abort reason itself), otherwise collect it with the emission
    // failures (slc/link.md §Abort).
    actor.subscribe({
      error: (error) =>
        latchInspectionError(error, consumeActorSettlementAborts()),
    });
  };

  // PBRT-6: the single seam that stops this runtime's actor. Stopping a
  // still-running actor fires one more `@xstate.snapshot` for the *unchanged*
  // state value with `status: 'stopped'`; `inspect` cannot tell that disposal
  // artifact from a state entry, so unsuppressed it re-emits the parked
  // state's telemetry and a phantom self-loop transition. Suppression is a
  // property of stopping, not a rule each caller must remember — every stop
  // goes through here so no later site can reintroduce the omission.
  const stopActor = (): void => {
    if (!actor) return;
    suppressInspectionEmissions = true;
    acceptedOutcomeConsumer.reset();
    actor.stop();
  };

  const startActor = (): void => {
    createRuntimeActor();
    // A fresh actor's emissions are real state entries again.
    suppressInspectionEmissions = false;
    actor?.start();
  };

  const driveToQuiescence = async (): Promise<void> => {
    const live = actor;
    if (!live) throw new Error('decide runtime: actor is not initialized');
    await waitForPlaybookQuiescence(live, { pendingCalls: nestedBridge });
  };

  const classify = async (
    text: string,
    signal: AbortSignal,
  ): Promise<DecideEvent | { type: 'NO_ACTION' } | null> => {
    const live = actor;
    if (!live) throw new Error('decide runtime: actor is not initialized');
    const snapshot = live.getSnapshot() as SnapshotFrom<typeof decideMachine>;
    const context = snapshot.context as unknown as Record<string, unknown>;
    const state = normalizePlaybookSnapshot(snapshot, {
      pendingCall: nestedBridge.getPendingCall(),
    });
    const pendingQuestions = visiblePendingQuestionsForState(state, context);
    const failed = state.activeStateIds.includes('failed');
    if (
      pendingQuestions.length === 0 &&
      (snapshot.status === 'done' ||
        state.activeStateIds.includes('ready') ||
        (failed &&
          automaticReplayPolicy.allowsFailureStateRetry()))
    ) {
      return { type: 'START_DECIDE', callerTopic: text };
    }
    if (pendingQuestions.length === 0) return null;
    const prompt = buildClassifierPrompt(text, {
      state,
      pendingQuestions,
    });
    const raw = await callJudge(
      prompt,
      signal,
      'boss-input-classification',
      state.stateId,
    );
    return parseClassification(
      raw,
      text,
      pendingQuestions.map(({ questionId }) => questionId),
    );
  };

  const deferredBoundarySeed = (
    operationId: string,
    callId: string,
  ): DecideEffectBoundarySeed => {
    const operation = effectLedgerMirror.logicalOperations.find(
      (candidate) => candidate.operationId === operationId,
    );
    const latestBoundaryId = operation?.boundaryIds.at(-1);
    const priorBoundary = effectLedgerMirror.boundaries.find(
      (candidate) => candidate.boundaryId === latestBoundaryId,
    );
    if (operation === undefined || priorBoundary === undefined) {
      throw new TypeError(
        'DECIDE deferred logical operation has no linked physical boundary',
      );
    }
    if (
      currentTurnId === undefined ||
      !Number.isSafeInteger(currentTurnId) ||
      currentTurnId <= 0
    ) {
      throw new Error(
        'DECIDE deferred continuation requires an active positive turn id',
      );
    }
    return {
      boundaryId: randomUUID(),
      runtimeSessionId: requireSessionIdentity().sessionId,
      turnId: currentTurnId,
      callId,
      roleId: priorBoundary.roleId,
      sourceStateId: priorBoundary.sourceStateId,
      sourceOutcomeSchema: snapshotJsonValue(
        priorBoundary.sourceOutcomeSchema,
        'DECIDE deferred source outcome schema',
      ),
      dispositions: [...priorBoundary.dispositions],
      correctionBudget: { limit: 1, spent: false },
    };
  };

  type PreparedDeferredContinuation =
    | { readonly proceed: false }
    | { readonly proceed: true; readonly acknowledgement: Promise<void> };

  const prepareDeferredContinuation = async (
    signal: AbortSignal,
  ): Promise<PreparedDeferredContinuation> => {
    if (deferredEffects === undefined || deferredOperationId === undefined) {
      throw new TypeError(
        'DECIDE deferred Boss reply has no host-bound logical operation',
      );
    }
    const operationId = deferredOperationId;
    const callId = `player-${++playerCallSequence}`;
    const effectBoundary = deferredBoundarySeed(operationId, callId);
    const active: ActiveDeferredContinuation = {
      operationId,
      effectBoundary,
      result: deferredValue<PlayerResult>(),
      acknowledged: deferredValue<void>(),
    };
    type Readiness =
      | { readonly status: 'ready' }
      | {
          readonly status: 'settled';
          readonly value:
            | DecideRepositoryDeferredContinuationResult<PlayerResult>
            | DecideRepositoryDeferredCheckpointMismatch;
        }
      | { readonly status: 'rejected'; readonly reason: unknown };
    const readiness = deferredValue<Readiness>();
    const repositoryCall = deferredEffects.repository.runDeferred({
      mode: 'continue',
      signal,
      operationId,
      effectBoundary,
      operation: async ({ playerContinuation }) => {
        if (
          playerContinuation !== false &&
          (typeof playerContinuation !== 'string' ||
            playerContinuation.trim() === '')
        ) {
          throw new TypeError(
            'DECIDE bound deferred player continuation is invalid',
          );
        }
        active.playerContinuation = playerContinuation;
        readiness.resolve({ status: 'ready' });
        return active.result.promise;
      },
      completeEffectBoundary: async (completion) => {
        if (active.input === undefined) {
          throw new TypeError(
            'DECIDE deferred continuation omitted its authored player input',
          );
        }
        return completionEvidenceFor(
          active.input,
          active.input.role,
          active.playerId,
          signal,
          operationId,
        )(completion);
      },
    });
    void repositoryCall.then(
      (value) => readiness.resolve({ status: 'settled', value }),
      (reason: unknown) => readiness.resolve({ status: 'rejected', reason }),
    );
    const prepared = await readiness.promise;
    if (prepared.status === 'rejected') throw prepared.reason;
    if (prepared.status === 'settled') {
      synchronizeDeferredProjection(
        assertPlaybookEffectLedger(
          prepared.value.effectLedger,
          'DECIDE deferred checkpoint-mismatch effect ledger',
        ),
      );
      hiddenDeferredOperationId = operationId;
      return { proceed: false };
    }

    activeDeferredContinuation = active;
    const acknowledgement = repositoryCall.then(
      (value) => {
        if (value.status !== 'continued') {
          throw new TypeError(
            'DECIDE deferred repository changed status after starting its operation',
          );
        }
        acknowledgeGovernedPlayerResult(value, effectBoundary.boundaryId);
        if (hiddenDeferredOperationId === undefined) {
          suppressInspectionEmissions = false;
        }
        active.acknowledged.resolve();
      },
      (error: unknown) => {
        active.acknowledged.reject(error);
        throw error;
      },
    ).catch((error: unknown) => {
      active.acknowledged.reject(error);
      throw error;
    });
    return { proceed: true, acknowledgement };
  };

  const parkDeferredContinuation = async (
    signal: AbortSignal,
  ): Promise<void> => {
    if (deferredEffects === undefined || deferredOperationId === undefined) {
      return;
    }
    const operationId = deferredOperationId;
    const parked = await deferredEffects.repository.runDeferred({
      mode: 'park',
      signal,
      operationId,
    });
    synchronizeDeferredProjection(
      assertPlaybookEffectLedger(
        parked.effectLedger,
        'DECIDE deferred park effect ledger',
      ),
    );
    hiddenDeferredOperationId = operationId;
  };

  const reconcileDeferred = async (
    signal: AbortSignal,
  ): Promise<'restored' | 'checkpoint-mismatch' | 'ineligible'> => {
    if (deferredEffects === undefined) return 'ineligible';
    if (currentSignal !== undefined) {
      throw new Error('decide runtime: another runtime turn is active');
    }
    synchronizeDeferredProjection(readEffectLedger());
    const operationId = hiddenDeferredOperationId;
    if (operationId === undefined) return 'ineligible';
    const restored = await deferredEffects.repository.runDeferred({
      mode: 'restore',
      signal,
      operationId,
    });
    synchronizeDeferredProjection(
      assertPlaybookEffectLedger(
        restored.effectLedger,
        'DECIDE deferred restoration effect ledger',
      ),
    );
    if (restored.status === 'parked') {
      throw new TypeError(
        'DECIDE deferred restoration returned an invalid parked status',
      );
    }
    if (restored.status !== 'restored') return restored.status;
    const live = actor;
    if (live === undefined) {
      throw new Error('decide runtime: init(session) must be called first');
    }
    const state = currentState();
    const context = (
      live.getSnapshot() as SnapshotFrom<typeof decideMachine>
    ).context as unknown as Record<string, unknown>;
    const pending = questionForWaitState(
      'awaitBossReply',
      visiblePendingQuestionsForState(state, context),
    );
    if (pending !== undefined) {
      await emitBoundaryStatus(
        `${pending.asker.roleId} asks: ${pending.question}`,
        state,
      );
      await emitBoundaryStatus(
        `◆ awaiting Boss reply · ${pending.resumeStateId} · ${pending.asker.roleId} · ${pending.sourceItem}`,
        state,
      );
      await flush();
    }
    return 'restored';
  };

  const resultForSnapshot = (signal?: AbortSignal): PlaybookRunResult => {
    const live = actor;
    if (!live) throw new Error('decide runtime: actor is not initialized');
    const snapshot = live.getSnapshot() as SnapshotFrom<typeof decideMachine>;
    const pendingCall = nestedBridge.getPendingCall();
    const state = normalizePlaybookSnapshot(snapshot, { pendingCall });
    const context = snapshot.context as unknown as Record<string, unknown>;
    const abortedResult = (abortSignal: AbortSignal): PlaybookRunResult => ({
      outcome: 'aborted',
      state,
      ...(abortSignal.reason === undefined
        ? {}
        : {
            error: normalizeErrorFull(abortSignal.reason) ?? {
              name: 'AbortError',
              message: String(abortSignal.reason),
            },
          }),
    });
    if (snapshot.status === 'error') {
      // An errored actor outranks a coincident abort unless the actor's
      // error is the abort reason itself (slc/link.md §Abort).
      const actorError = (snapshot as { error?: unknown }).error;
      if (
        actorError !== undefined &&
        signal !== undefined &&
        isAbortFailure(actorError, signal)
      ) {
        return abortedResult(signal);
      }
      throw (
        actorError ?? new Error('decide runtime actor entered error status')
      );
    }
    // Terminal completion outranks a coincident abort (DR-036 §3): reporting
    // 'aborted' over a completed machine would hide a terminal state that the
    // next turn silently restarts, duplicating the workflow's side effects.
    if (snapshot.status === 'done') {
      const output = (snapshot as { output?: unknown }).output;
      if (output !== undefined) assertJsonSafe(output, 'terminal output');
      const stateDescription = state.activeStateIds.includes('done')
        ? STATE_DESCRIPTIONS.done
        : state.activeStateIds.includes('reportedReviewFailure')
          ? STATE_DESCRIPTIONS.reportedReviewFailure
          : undefined;
      if (stateDescription === undefined) {
        throw new Error(
          'decide runtime: completed actor has no authored final-state description',
        );
      }
      return {
        outcome: 'terminal',
        state,
        stateDescription,
        ...(output === undefined ? {} : { output }),
      };
    }
    if (signal?.aborted) {
      return abortedResult(signal);
    }
    if (state.activeStateIds.includes('failed')) {
      const error = normalizeErrorFull(context.lastError);
      return {
        outcome: 'failed',
        state,
        ...(error === undefined ? {} : { error }),
      };
    }
    if (pendingCall) {
      return { outcome: 'suspended', state, pendingCall };
    }
    return { outcome: 'quiescent', state };
  };

  // Shared failed-start cleanup for init and restore: stop the actor,
  // drain queued work, optionally emit one best-effort session.disposed
  // boundary, and unbind every closure field so dispose stays callable.
  // The caller rethrows its original failure. A restore failure skips
  // the disposal trace — the parked session was never re-bound in this
  // process, so its persisted snapshot stays authoritative (DR-014 §2).
  const cleanupFailedStart = async (
    cause: unknown,
    options: { emitDisposal: boolean },
  ): Promise<void> => {
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
      await drainBoundaryCallsAndEmissions();
    } catch {
      // Preserve the original startup failure.
    }
    if (options.emitDisposal) {
      try {
        await emitTrace('session.disposed', {
          ...(finalState === undefined
            ? {}
            : { state: finalState, ...stateIdentity(finalState) }),
        });
        await flush();
      } catch {
        // The session-start error remains authoritative.
      }
    }
    privateResumeTokens.clear();
    inFlightPlayerKeys.clear();
    activeBoundaryCalls.clear();
    activeEmissionCalls.clear();
    emissionQueue.clear();
    judgeQueue.clear();
    actor = undefined;
    currentSignal = undefined;
    currentAborts = undefined;
    actorSettlementAborts.length = 0;
    actorSettlementErrorAborts = undefined;
    currentTurnId = undefined;
    ports = undefined;
    sessionIdentity = undefined;
    previousState = undefined;
    suppressInspectionEmissions = false;
    controlPlaneError = undefined;
    emissionFailures = [];
    traceSequence = 0;
    turnSequence = 0;
    judgeCallSequence = 0;
    playerCallSequence = 0;
    playbookCallSequence = 0;
    playbookCallTurnIds.clear();
    governedOutputsByBoundaryId.clear();
    deferredOperationId = undefined;
    hiddenDeferredOperationId = undefined;
    activeDeferredContinuation = undefined;
    lifecycleStarted = false;
  };

  return {
    async init(session: PlaybookSession): Promise<void> {
      if (
        lifecycleStarted ||
        initInFlight !== undefined ||
        disposed ||
        disposalPromise !== undefined
      ) {
        throw new Error(
          'decide runtime: init(session) may only be called once',
        );
      }
      const identity = bindSession(session);
      let finishInitialization!: () => void;
      const initialization = new Promise<void>((resolve) => {
        finishInitialization = resolve;
      });
      initInFlight = initialization;
      lifecycleStarted = true;
      ports = identity.ports;
      sessionIdentity = identity;
      try {
        if (deferredEffects !== undefined) {
          effectLedgerMirror = readEffectLedger();
          synchronizeDeferredProjection(effectLedgerMirror);
        }
        suppressInspectionEmissions = false;
        createRuntimeActor();
        const state = currentState();
        await emitTrace('session.started', {
          state,
          ...stateIdentity(state),
        });
        actor?.start();
        await flush();
      } catch (error) {
        await cleanupFailedStart(error, { emitDisposal: true });
        throw error;
      } finally {
        finishInitialization();
        if (initInFlight === initialization) initInFlight = undefined;
      }
    },

    // DR-014 §1 / DR-031 §5 / PBRT-45: JSON-safe capture of a parked
    // session, including one already-started suspended REVIEW call.
    // Defined only at a safe capture point — initialized, not disposing
    // or disposed, no active public boundary, and the actor quiescent with
    // status `active`.
    exportSnapshot(): PlaybookRuntimeSnapshot | undefined {
      if (
        !actor ||
        !sessionIdentity ||
        disposed ||
        disposalPromise !== undefined
      ) {
        return undefined;
      }
      if (currentTurnId !== undefined || currentSignal !== undefined) {
        return undefined;
      }
      const pendingCall = nestedBridge.getPendingCall();
      const bridgeSuspendedCall = nestedBridge.getSuspendedCall();
      if ((pendingCall === undefined) !== (bridgeSuspendedCall === undefined)) {
        return undefined;
      }
      if (
        pendingCall !== undefined &&
        bridgeSuspendedCall !== undefined &&
        (pendingCall.callId !== bridgeSuspendedCall.callId ||
          pendingCall.playbookId !== bridgeSuspendedCall.playbookId ||
          pendingCall.childSessionId !== bridgeSuspendedCall.childSessionId)
      ) {
        return undefined;
      }
      let suspendedCall: typeof bridgeSuspendedCall;
      if (bridgeSuspendedCall !== undefined) {
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
        };
      }
      const state = currentState();
      if (state.status !== 'active' || !state.quiescent) return undefined;
      const machine = detachPersistedMachineSnapshot(
        actor.getPersistedSnapshot(),
      );
      const context = (
        actor.getSnapshot() as SnapshotFrom<typeof decideMachine>
      ).context as unknown as Record<string, unknown>;
      if (deferredEffects !== undefined) {
        const current = readEffectLedger();
        if (
          stableJson(current, 'DECIDE current effect ledger') !==
          stableJson(effectLedgerMirror, 'DECIDE acknowledged effect ledger')
        ) {
          return undefined;
        }
      }
      return {
        schemaVersion: 4,
        playbookId: sessionIdentity.playbookId,
        machine,
        roleResumeTokens: snapshotRoleResumeTokens(),
        sequences: {
          trace: traceSequence,
          turn: turnSequence,
          judgeCall: judgeCallSequence,
          playerCall: playerCallSequence,
          playbookCall: playbookCallSequence,
        },
        state,
        pendingBossQuestions: visiblePendingQuestionsForState(state, context).map(
          (pending) => ({
            questionId: pending.questionId,
            asker: pending.asker,
            question: pending.question,
            sourceItem: pending.sourceItem,
          }),
        ),
        effectLedger: effectLedgerMirror,
        ...(suspendedCall === undefined ? {} : { suspendedCall }),
      };
    },

    // DR-014 §1 / PBRT-45: alternative to `init` that rehydrates an
    // exported snapshot under the same immutable session identity.
    // Emits no `session.started`, transition trace, or human status —
    // the session already started; the next public boundary continues
    // the contiguous trace sequence.
    async restore(
      session: PlaybookSession,
      snapshot: PlaybookRuntimeSnapshot,
    ): Promise<void> {
      if (
        lifecycleStarted ||
        initInFlight !== undefined ||
        disposed ||
        disposalPromise !== undefined
      ) {
        throw new Error(
          'decide runtime: restore(session, snapshot) may only be called once',
        );
      }
      const identity = bindSession(session);
      const boundSnapshot = assertPlaybookRuntimeSnapshot(
        snapshot,
        identity.playbookId,
        { allowSuspendedCall: true },
      );
      if (deferredEffects === undefined) {
        if (
          boundSnapshot.effectLedger.revision !== 0 ||
          boundSnapshot.effectLedger.boundaries.length !== 0 ||
          boundSnapshot.effectLedger.logicalOperations.length !== 0
        ) {
          throw new TypeError(
            'decide runtime snapshot effectLedger must be the canonical empty ledger',
          );
        }
      } else {
        const current = readEffectLedger();
        if (
          stableJson(current, 'DECIDE current effect ledger') !==
          stableJson(boundSnapshot.effectLedger, 'DECIDE snapshot effect ledger')
        ) {
          throw new TypeError(
            'decide runtime snapshot effectLedger must equal the current host mirror',
          );
        }
        effectLedgerMirror = current;
      }
      const suspendedCall = boundSnapshot.suspendedCall;
      let finishInitialization!: () => void;
      const initialization = new Promise<void>((resolve) => {
        finishInitialization = resolve;
      });
      initInFlight = initialization;
      lifecycleStarted = true;
      ports = identity.ports;
      sessionIdentity = identity;
      let priorExternalRoleTokens:
        | Readonly<Record<string, string>>
        | undefined;
      try {
        traceSequence = boundSnapshot.sequences.trace;
        turnSequence = boundSnapshot.sequences.turn;
        judgeCallSequence = boundSnapshot.sequences.judgeCall;
        playerCallSequence = boundSnapshot.sequences.playerCall;
        playbookCallSequence = boundSnapshot.sequences.playbookCall;
        if (identity.playerSessions) {
          priorExternalRoleTokens = snapshotRoleResumeTokens();
        }
        restoreRoleResumeTokens(boundSnapshot.roleResumeTokens);
        nestedBridge.prepareRestore(suspendedCall);
        if (suspendedCall !== undefined) {
          playbookCallTurnIds.set(suspendedCall.callId, suspendedCall.turnId);
        }
        suppressInspectionEmissions = true;
        createRuntimeActor(boundSnapshot.machine);
        actor?.start();
        const restoredState = currentState(suspendedCall);
        if (restoredState.status !== 'active') {
          throw new Error(
            `decide runtime: restored actor status is ${restoredState.status}, expected active`,
          );
        }
        if (
          stableJson(restoredState, 'restored runtime state') !==
          stableJson(boundSnapshot.state, 'runtime snapshot state')
        ) {
          throw new Error(
            'decide runtime: restored actor state does not match snapshot state',
          );
        }
        previousState = restoredState;
        synchronizeDeferredProjection(effectLedgerMirror);
        await flush();
        suppressInspectionEmissions = false;
        // Final fallible step: after this publication the authoritative
        // child has rejoined ordinary resume/abort ownership, so no later
        // restore validation may trigger failed-start rollback.
        nestedBridge.confirmRestore();
      } catch (error) {
        let failure = error;
        if (priorExternalRoleTokens !== undefined) {
          try {
            identity.playerSessions!.restore(priorExternalRoleTokens);
          } catch (rollbackError) {
            failure = new AggregateError(
              [error, rollbackError],
              'DECIDE restore and player continuation rollback failed',
            );
          }
        }
        await cleanupFailedStart(failure, { emitDisposal: false });
        throw failure;
      } finally {
        finishInitialization();
        if (initInFlight === initialization) initInFlight = undefined;
      }
    },

    async handleBossInput(turn: {
      text: string;
      signal: AbortSignal;
    }): Promise<PlaybookRunResult> {
      if (disposalPromise !== undefined) {
        throw new Error('decide runtime: runtime is disposing or disposed');
      }
      requirePorts();
      if (!actor) {
        throw new Error(
          'decide runtime: init(session) must be called before handleBossInput',
        );
      }
      if (currentSignal !== undefined) {
        throw new Error('decide runtime: another runtime turn is active');
      }

      const turnId = ++turnSequence;
      currentTurnId = turnId;
      currentSignal = turn.signal;
      currentAborts = abortReasonClassifier(turn.signal);
      controlPlaneError = undefined;
      let result: PlaybookRunResult = resultForSnapshot(turn.signal);
      let settlement: unknown = result;
      const failures: unknown[] = [];
      try {
        await emitTrace('boss.input.received', { text: turn.text }, { turnId });
        // A boundary entered aborted records the attempted input, then refuses
        // delivery before deterministic mapping or the classifier can perform
        // any host-visible work (DR-036 §5).
        turn.signal.throwIfAborted();
        if (turn.text.trim().length === 0) {
          const state = currentState();
          result = { outcome: 'no-action', state };
        } else {
          const event = await classify(turn.text, turn.signal);
          if (!event) {
            const state = currentState();
            await emitBoundaryStatus('No playbook action classified.', state);
            result = { outcome: 'no-action', state };
          } else if (event.type === 'NO_ACTION') {
            result = { outcome: 'no-action', state: currentState() };
          } else {
            const before = currentState();
            const boundCommitWait =
              deferredEffects !== undefined &&
              deferredOperationId !== undefined &&
              before.activeStateIds.includes('awaitBossReply');
            if (boundCommitWait && event.type === 'BOSS_INTERRUPT') {
              await parkDeferredContinuation(turn.signal);
              result = { outcome: 'no-action', state: currentState() };
            } else {
              const prepared =
                boundCommitWait &&
                event.type === 'BOSS_REPLY' &&
                event.questionId === 'commitCoderProposal'
                  ? await prepareDeferredContinuation(turn.signal)
                  : undefined;
              if (prepared?.proceed === false) {
                result = { outcome: 'no-action', state: currentState() };
              } else {
                await emitBoundaryStatus(event.type, before);
                if (actor.getSnapshot().status === 'done') {
                  stopActor();
                  startActor();
                }

                const deferredMachineCheckpoint =
                  prepared?.proceed === true
                    ? detachPersistedMachineSnapshot(
                        actor.getPersistedSnapshot(),
                      )
                    : undefined;
                if (deferredMachineCheckpoint !== undefined) {
                  suppressInspectionEmissions = true;
                }

                try {
                  actor.send(event);
                  await driveToQuiescence();
                  await drainBoundaryCallsAndEmissions();
                  await prepared?.acknowledgement;
                  if (
                    deferredMachineCheckpoint !== undefined &&
                    hiddenDeferredOperationId !== undefined
                  ) {
                    stopActor();
                    createRuntimeActor(deferredMachineCheckpoint);
                    actor.start();
                    previousState = before;
                    suppressInspectionEmissions = false;
                  }
                } catch (error) {
                  activeDeferredContinuation?.result.reject(error);
                  if (deferredEffects !== undefined) {
                    try {
                      synchronizeDeferredProjection(readEffectLedger());
                      hiddenDeferredOperationId ??= deferredOperationId;
                    } catch {
                      hiddenDeferredOperationId ??= deferredOperationId;
                    }
                  }
                  if (deferredMachineCheckpoint !== undefined) {
                    try {
                      stopActor();
                      createRuntimeActor(deferredMachineCheckpoint);
                      actor.start();
                      previousState = before;
                    } finally {
                      suppressInspectionEmissions = false;
                    }
                  }
                  throw error;
                } finally {
                  activeDeferredContinuation = undefined;
                }

                if (controlPlaneError !== undefined) throw controlPlaneError;
                result = resultForSnapshot(turn.signal);
              }
            }
          }
        }
        settlement = {
          ...result,
          ...stateIdentity(result.state),
        };
      } catch (error) {
        const primaryError = controlPlaneError;
        // Only a rejection that is the exact abort reason settles as the
        // cancellation; a distinct failure observed while the signal is
        // aborted remains a control error (slc/link.md §Abort).
        if (primaryError !== undefined) {
          collectFailure(failures, primaryError);
        } else if (!isAbortFailure(error, turn.signal)) {
          collectFailure(failures, error);
        }
        const state = currentState();
        const effectiveError = primaryError ?? error;
        result =
          isAbortFailure(error, turn.signal) && primaryError === undefined
            ? resultForSnapshot(turn.signal)
            : {
                outcome: 'failed',
                state,
                error: normalizeErrorFull(effectiveError) ?? {
                  name: 'Error',
                  message: String(effectiveError),
                },
              };
        settlement = {
          ...result,
          ...stateIdentity(state),
        };
      }

      try {
        await drainBoundaryCallsAndEmissions();
      } catch (error) {
        const primaryError = controlPlaneError;
        const effectiveError = primaryError ?? error;
        // A drain rejection that is the exact abort reason evidences the
        // cancellation, not a control-plane failure (slc/link.md §Abort).
        const drainAborted = isAbortFailure(effectiveError, turn.signal);
        if (!drainAborted) collectFailure(failures, effectiveError);
        const state = currentState();
        result = {
          outcome: drainAborted ? 'aborted' : 'failed',
          state,
          error: normalizeErrorFull(effectiveError) ?? {
            name: 'Error',
            message: String(effectiveError),
          },
        };
        settlement = { ...result, ...stateIdentity(state) };
      }
      try {
        await emitTrace('boss.input.settled', settlement, { turnId });
      } catch (error) {
        // A settlement-trace rejection that is the exact abort reason also
        // evidences the cancellation (slc/link.md §Abort).
        if (!isAbortFailure(error, turn.signal)) {
          collectFailure(failures, error);
        }
      }
      try {
        await flush();
      } catch (error) {
        // A late flush rejection that is the exact abort reason likewise
        // evidences the cancellation; the settled result already labels
        // the turn aborted then (slc/link.md §Abort).
        if (!isAbortFailure(error, turn.signal)) {
          collectFailure(failures, error);
        }
      } finally {
        const primaryError = controlPlaneError;
        currentSignal = undefined;
        currentAborts = undefined;
        currentTurnId = undefined;
        controlPlaneError = undefined;
        if (primaryError !== undefined) throw primaryError;
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'decide runtime turn failed');
      }
      return result;
    },

    async resumePlaybookCall({
      callId,
      result: childResult,
      signal,
    }: {
      callId: string;
      result: PlaybookCallResult;
      signal: AbortSignal;
    }): Promise<PlaybookRunResult> {
      if (disposalPromise !== undefined) {
        throw new Error('decide runtime: runtime is disposing or disposed');
      }
      requirePorts();
      if (!actor) {
        throw new Error(
          'decide runtime: init(session) must be called before resumePlaybookCall',
        );
      }
      if (currentSignal !== undefined) {
        throw new Error('decide runtime: another runtime turn is active');
      }
      currentTurnId = playbookCallTurnIds.get(callId);
      currentSignal = signal;
      currentAborts = abortReasonClassifier(signal);
      controlPlaneError = undefined;
      let runResult: PlaybookRunResult | undefined;
      let operationError: unknown;
      try {
        await nestedBridge.resume({
          callId,
          result: childResult,
          signal,
        });
      } catch (error) {
        operationError = error;
      }
      try {
        await waitForPlaybookQuiescence(actor, {
          pendingCalls: nestedBridge,
        });
        runResult = resultForSnapshot(signal);
      } catch (error) {
        operationError ??= error;
      }
      let drainError: unknown;
      try {
        await drainBoundaryCallsAndEmissions();
      } catch (error) {
        drainError = error;
      }
      const aborts = currentAborts ?? abortReasonClassifier(signal);
      // The control latch has already classified its failure as distinct
      // under the operation that owned it. Only still-unclassified drain and
      // operation candidates may be cancellation evidence for this resume.
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
        (drainAbort ? drainError : undefined) ??
        (operationAbort ? operationError : undefined);
      const failure =
        controlFailure ??
        (drainAbort ? undefined : drainError) ??
        (operationAbort ? undefined : operationError);
      currentSignal = undefined;
      currentAborts = undefined;
      currentTurnId = undefined;
      controlPlaneError = undefined;
      if (failure !== undefined) throw failure;
      if (
        abortEvidence !== undefined &&
        runResult?.outcome !== 'terminal' &&
        runResult?.outcome !== 'suspended'
      ) {
        const state = currentState();
        runResult = {
          outcome: 'aborted',
          state,
          error: normalizeErrorFull(abortEvidence) ?? {
            name: 'AbortError',
            message: String(abortEvidence),
          },
        };
      }
      if (runResult === undefined) {
        if (signal.aborted) {
          // Every candidate was the abort's own evidence: settle on the
          // machine's state under the aborted boundary signal (DR-036 §4).
          runResult = resultForSnapshot(signal);
        } else {
          throw new Error(
            'decide runtime: playbook resume produced no result',
          );
        }
      }
      return runResult;
    },

    dispose(): Promise<void> {
      if (disposalPromise !== undefined) return disposalPromise;
      if (currentSignal !== undefined) {
        return Promise.reject(
          new Error(
            'decide runtime: cannot dispose while a runtime turn is active',
          ),
        );
      }
      disposalPromise = (async () => {
        const initialization = initInFlight;
        if (initialization) await initialization;
        if (!sessionIdentity || disposed) {
          disposed = true;
          return;
        }
        const finalState = currentState();
        const failures: unknown[] = [];
        stopActor();
        try {
          await nestedBridge.dispose();
        } catch (error) {
          collectFailure(failures, error);
        }
        try {
          await drainBoundaryCallsAndEmissions();
        } catch (error) {
          collectFailure(failures, error);
        }
        try {
          await emitTrace('session.disposed', {
            state: finalState,
            ...stateIdentity(finalState),
          });
        } catch (error) {
          collectFailure(failures, error);
        }
        try {
          await flush();
        } catch (error) {
          collectFailure(failures, error);
        } finally {
          privateResumeTokens.clear();
          playbookCallTurnIds.clear();
          inFlightPlayerKeys.clear();
          activeBoundaryCalls.clear();
          activeEmissionCalls.clear();
          emissionQueue.clear();
          judgeQueue.clear();
          actor = undefined;
          currentSignal = undefined;
          currentAborts = undefined;
          actorSettlementAborts.length = 0;
          actorSettlementErrorAborts = undefined;
          currentTurnId = undefined;
          ports = undefined;
          sessionIdentity = undefined;
          previousState = undefined;
          controlPlaneError = undefined;
          governedOutputsByBoundaryId.clear();
          deferredOperationId = undefined;
          hiddenDeferredOperationId = undefined;
          activeDeferredContinuation = undefined;
          disposed = true;
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'decide runtime disposal failed');
        }
      })();
      return disposalPromise;
    },

    // @internal — test-only parity with the shared factory's bridge escape
    // hatch. This is hidden by the PlaybookRuntime return type.
    _getNestedBridge() {
      return nestedBridge;
    },
    ...(deferredEffects === undefined
      ? {}
      : { _reconcileDeferred: reconcileDeferred }),
  };
}

const legacyAutomaticReplayPolicy = createAutomaticReplayPolicy(2);

export const createPlaybookRuntime: PlaybookRuntimeFactory<
  PlaybookRuntimeOptions
> = (options) =>
  createDecidePlaybookRuntime(options, 2, legacyAutomaticReplayPolicy);

function createStagedSchema3AutomaticReplayRuntime(
  options: PlaybookRuntimeOptions,
  evidence: Schema3AutomaticReplayEvidence,
): PlaybookRuntime {
  return createDecidePlaybookRuntime(
    options,
    3,
    createAutomaticReplayPolicy(3, evidence),
  );
}

function createStagedSchema3DeferredRuntime(
  options: PlaybookRuntimeOptions,
  evidence: Schema3DeferredEffectEvidence,
): StagedDecidePlaybookRuntime {
  return createDecidePlaybookRuntime(
    options,
    3,
    createAutomaticReplayPolicy(3, evidence),
    evidence,
  ) as StagedDecidePlaybookRuntime;
}

function createStagedSchema3AcceptedOutcomeRuntime(
  options: PlaybookRuntimeOptions,
  evidence: Schema3AutomaticReplayEvidence,
  acceptedOutcomeAction: unknown,
): PlaybookRuntime {
  return createDecidePlaybookRuntime(
    options,
    3,
    createAutomaticReplayPolicy(3, evidence),
    undefined,
    acceptedOutcomeAction,
  );
}

export const _internal = {
  createStagedSchema3AutomaticReplayRuntime,
  createStagedSchema3DeferredRuntime,
  createStagedSchema3AcceptedOutcomeRuntime,
  composePlayerPrompt,
  requiredFieldsFor,
  extractJson,
  buildClassifierPrompt,
  parseClassification,
  buildAdjudicatorPrompt,
  parseAdjudication,
  combineSignals,
  pendingQuestionsFromContext,
  pendingQuestionsForState,
  normalizeErrorCompact,
  normalizeErrorFull,
  STATE_DESCRIPTIONS,
  ROLE_STATES,
  ROLE_STATE_IDS,
  VERBATIM_PAYLOAD_FIELDS,
  BOSS_INTERRUPT_TARGETS,
  UNFINISHED_FINAL_STATE_IDS,
  CONTINUATION_PREAMBLE,
  TELEMETRY_TOPIC,
};

export default createPlaybookRuntime;
