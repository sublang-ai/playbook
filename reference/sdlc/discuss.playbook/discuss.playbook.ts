// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// PlaybookRuntime for the discuss playbook, linked from the FSM artifact by
// the slc FSM-to-runtime link phase.
//
// Linker inputs:
//   FSM artifact:       ./discuss.fsm.ts
//   Link target:        @sublang/playbook/src/runtime.ts
//   Player binding:     Host -> host, Participant -> participant,
//                       Committer -> committer
//                       (default binding: lowercased player name)
//   Composite players:  Committer = Host | Participant. DISCUSS-14 and
//                       DISCUSS-15 keep PlayerInput.player = 'Committer';
//                       callPlayer resolution uses options.committer when
//                       supplied, otherwise falls back to Host, the first
//                       listed alias alternative.
//   Adjudication:       LLM-judge per state (default)
//   Boss-event mapping: free-text judge classification (default)
//   Abort strategy:     natural rejection; every player-invoking state's
//                       onError routes to the quiescent failed state.

import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import type { InspectionEvent, SnapshotFrom } from 'xstate';

import {
  assertJsonSafe,
  assertPlaybookRuntimeSnapshot,
  combineAbortSignals,
  detachPersistedMachineSnapshot,
  normalizeError,
  normalizePlaybookSnapshot,
  snapshotJsonValue,
  snapshotPlaybookSession,
  validatePlayerResult,
  waitForPlaybookQuiescence,
} from '../../../src/xstate-runtime.js';

import discussMachine, {
  type PlayerInput,
  type PlayerOutput,
  type DiscussEvent,
  type DiscussInput,
  type PendingBossQuestion,
} from './discuss.fsm.js';

import type {
  CaptainCallOptions,
  CaptainResult,
  JsonValue,
  NormalizedError,
  PlayerCallOptions,
  PlayerResult,
  PlaybookCallRequest,
  PlaybookCallResult,
  PlaybookCallStart,
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
} from '@sublang/playbook/runtime';

export type {
  CaptainCallOptions,
  CaptainResult,
  JsonValue,
  NormalizedError,
  PlayerCallOptions,
  PlayerResult,
  PlaybookCallRequest,
  PlaybookCallResult,
  PlaybookCallStart,
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

type PlayerName = 'Host' | 'Participant' | 'Committer';
type ReviewScope = 'specItems' | 'decisionRecords' | 'mixed';

export interface PlaybookRuntimeOptions extends DiscussInput {
  playerBinding?: Partial<Record<PlayerName, string>>;
}

const DEFAULT_PLAYER_BINDING: Readonly<Record<PlayerName, string>> = {
  Host: 'host',
  Participant: 'participant',
  Committer: 'committer',
};

const ALIAS_RESOLUTION: Readonly<Record<string, string>> = {
  'DISCUSS-14':
    'Committer = Host | Participant; uses input.committerPlayer when supplied, otherwise Host.',
  'DISCUSS-15':
    'Committer = Host | Participant; uses input.committerPlayer when supplied, otherwise Host.',
};

function snapshotDiscussRuntimeOptions(value: unknown): PlaybookRuntimeOptions {
  const captured = snapshotJsonValue(value, 'DISCUSS runtime options');
  if (!isPlainObject(captured)) {
    throw new TypeError('DISCUSS runtime options must be an object');
  }
  const allowed = new Set([
    'host',
    'participant',
    'committer',
    'playerBinding',
  ]);
  for (const key of Object.keys(captured)) {
    if (!allowed.has(key)) {
      throw new TypeError(`DISCUSS runtime options.${key} is not declared`);
    }
  }
  for (const key of ['host', 'participant', 'committer'] as const) {
    if (key in captured && typeof captured[key] !== 'string') {
      throw new TypeError(`DISCUSS runtime options.${key} must be a string`);
    }
  }
  if ('playerBinding' in captured) {
    const playerBinding = captured.playerBinding;
    if (!isPlainObject(playerBinding)) {
      throw new TypeError(
        'DISCUSS runtime options.playerBinding must be an object',
      );
    }
    const playerNames = new Set<PlayerName>([
      'Host',
      'Participant',
      'Committer',
    ]);
    for (const [player, playerId] of Object.entries(playerBinding)) {
      if (!playerNames.has(player as PlayerName)) {
        throw new TypeError(
          `DISCUSS runtime options.playerBinding.${player} is not declared`,
        );
      }
      if (typeof playerId !== 'string' || playerId.trim().length === 0) {
        throw new TypeError(
          `DISCUSS runtime options.playerBinding.${player} must be a non-empty string`,
        );
      }
    }
  }
  return captured as unknown as PlaybookRuntimeOptions;
}

const STATE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ready: 'Idle hub awaiting a Boss discussion or review directive.',
  askHostInitial:
    'Host proposes whether the Boss topic should become spec items or DRs.',
  askParticipantInitial:
    'Participant independently proposes whether the Boss topic should become spec items or DRs.',
  hostInitialRound:
    'Host reconciles the Participant proposal during initial discussion.',
  participantInitialRound:
    'Participant reconciles the Host proposal during initial discussion.',
  hostWritesAgreement:
    'Host writes the agreed spec items or DRs and updates the spec map.',
  commitInitialChanges:
    'Committer commits the changes produced at the end of initial discussion.',
  reviewSpecInitialCommit:
    'Participant reviews newly committed spec-item changes.',
  reviewSpecHostChanges:
    'Participant reviews Host changes to spec items after findings.',
  reviewDrInitialCommit:
    'Participant reviews newly committed decision-record changes.',
  reviewDrHostChanges:
    'Participant reviews Host changes to decision records after findings.',
  reviewMixedInitialCommit:
    'Participant reviews newly committed mixed spec-item and DR changes.',
  reviewMixedHostChanges:
    'Participant reviews Host changes to mixed spec items and DRs after findings.',
  hostAddressesFindings:
    'Host accepts or challenges review findings and stages repo changes.',
  participantAddressesRebuttals:
    'Participant accepts or challenges Host rebuttals.',
  commitReviewedChanges:
    'Committer commits reviewed changes once Participant raises no findings.',
  awaitBossReply: 'Waiting for Boss to answer a player question.',
  failed: 'The discussion workflow failed and is waiting for Boss recovery.',
  done: 'The discussion workflow completed with a reviewed commit.',
};

const CAPTAIN_STATES = [
  { stateId: 'askHostInitial', player: 'Host', sourceItem: 'DISCUSS-1' },
  {
    stateId: 'askParticipantInitial',
    player: 'Participant',
    sourceItem: 'DISCUSS-2',
  },
  { stateId: 'hostInitialRound', player: 'Host', sourceItem: 'DISCUSS-3' },
  {
    stateId: 'participantInitialRound',
    player: 'Participant',
    sourceItem: 'DISCUSS-4',
  },
  { stateId: 'hostWritesAgreement', player: 'Host', sourceItem: 'DISCUSS-5' },
  {
    stateId: 'commitInitialChanges',
    player: 'Committer',
    sourceItem: 'DISCUSS-14',
  },
  {
    stateId: 'reviewSpecInitialCommit',
    player: 'Participant',
    sourceItem: 'DISCUSS-6',
  },
  {
    stateId: 'reviewSpecHostChanges',
    player: 'Participant',
    sourceItem: 'DISCUSS-7',
  },
  {
    stateId: 'reviewDrInitialCommit',
    player: 'Participant',
    sourceItem: 'DISCUSS-8',
  },
  {
    stateId: 'reviewDrHostChanges',
    player: 'Participant',
    sourceItem: 'DISCUSS-9',
  },
  {
    stateId: 'reviewMixedInitialCommit',
    player: 'Participant',
    sourceItem: 'DISCUSS-10',
  },
  {
    stateId: 'reviewMixedHostChanges',
    player: 'Participant',
    sourceItem: 'DISCUSS-11',
  },
  {
    stateId: 'hostAddressesFindings',
    player: 'Host',
    sourceItem: 'DISCUSS-12',
  },
  {
    stateId: 'participantAddressesRebuttals',
    player: 'Participant',
    sourceItem: 'DISCUSS-13',
  },
  {
    stateId: 'commitReviewedChanges',
    player: 'Committer',
    sourceItem: 'DISCUSS-15',
  },
] as const;

const CAPTAIN_STATE_IDS: ReadonlySet<string> = new Set(
  CAPTAIN_STATES.map((state) => state.stateId),
);

const BOSS_INTERRUPT_TARGETS = [
  'ready',
  'initialProposalRound',
  'reconciliationRound',
  'hostWritesAgreement',
  'commitInitialChanges',
  'reviewSpecInitialCommit',
  'reviewSpecHostChanges',
  'reviewDrInitialCommit',
  'reviewDrHostChanges',
  'reviewMixedInitialCommit',
  'reviewMixedHostChanges',
  'hostAddressesFindings',
  'participantAddressesRebuttals',
  'commitReviewedChanges',
  'failed',
] as const;

const BOSS_INTERRUPT_TARGET_IDS: ReadonlySet<string> = new Set(
  BOSS_INTERRUPT_TARGETS,
);

const REVIEW_SCOPES: ReadonlySet<string> = new Set([
  'specItems',
  'decisionRecords',
  'mixed',
]);

const TELEMETRY_TOPIC = 'playbook.fsm.state';
const TRACE_TOPIC = 'playbook.trace';

const CONTINUATION_PREAMBLE =
  'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';

const PLACEHOLDER_FIELDS: ReadonlyArray<readonly [string, keyof PlayerInput]> =
  [
    ['<topic>', 'topic'],
    ['<participant-proposal>', 'participantProposal'],
    ['<host-previous-proposal>', 'hostProposal'],
    ['<host-proposal>', 'hostProposal'],
    ['<participant-previous-proposal>', 'participantProposal'],
    ['<agreement>', 'agreement'],
    ['<changes>', 'latestChanges'],
    ['<review-items>', 'reviewItems'],
    ['<rebuttals>', 'rebuttals'],
    ['<host-llm>', 'hostLlm'],
    ['<participant-llm>', 'participantLlm'],
  ];

function composePlayerPrompt(input: PlayerInput): string {
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

  let body = input.prompt;
  for (const [placeholder, field] of PLACEHOLDER_FIELDS) {
    const value = input[field];
    if (typeof value === 'string') {
      body = body.replaceAll(placeholder, value);
    }
  }

  blocks.push(body);
  return blocks.join('\n\n');
}

function resolvePlayerId(
  input: PlayerInput,
  binding: Record<PlayerName, string>,
): string {
  switch (input.player) {
    case 'Host':
      return binding.Host;
    case 'Participant':
      return binding.Participant;
    case 'Committer':
      return input.committerPlayer ?? binding.Host;
    default: {
      const exhaustive: never = input.player;
      throw new Error(`unknown player ${String(exhaustive)}`);
    }
  }
}

// A `result` description names required payload fields in an
// "Output shall include ..." sentence. One sentence can name several
// fields — DISCUSS-5's wroteChanges names both `latestChanges` and
// `reviewScope` — so every backticked `field:` token in the sentence
// span is required, not just the one adjacent to the phrase.
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
  lines.push('You are the Boss-input classifier for the discuss playbook.');
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
        `- ${pending.questionId} (${pending.player}, ${pending.sourceItem}): ${pending.question}`,
      );
    }
    lines.push(
      'If the Boss message answers a pending question, classify it as BOSS_REPLY; if it is a fresh directive, classify it accordingly.',
    );
  }
  lines.push('');
  lines.push('Events and payload contracts:');
  lines.push(
    '- START_DISCUSSION: required topic string; optional hostLlm, participantLlm strings (identities normally come from run options).',
  );
  lines.push(
    '- START_REVIEW: required latestChanges string, required reviewScope string ("specItems" | "decisionRecords" | "mixed"), optional rebuttals string.',
  );
  lines.push(
    `- BOSS_INTERRUPT: required targetId string, one of ${BOSS_INTERRUPT_TARGETS.join(', ')}.`,
  );
  lines.push(
    '- BOSS_REPLY: required answer string and questionId when several questions are pending; valid only while at least one Boss question is pending.',
  );
  lines.push('');
  lines.push('Boss message:');
  lines.push(text);
  lines.push('');
  lines.push(
    'Reply with a single JSON object: { "event": "<EVENT_TYPE or null>", ...payload fields }.',
  );
  lines.push('Use null when no FSM action applies.');
  return lines.join('\n');
}

function parseClassification(
  raw: string,
  pendingQuestionIds: readonly string[] = [],
): DiscussEvent | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  const eventType = obj.event ?? obj.type;

  if (eventType === 'START_DISCUSSION') {
    // hostLlm/participantLlm are optional on the FSM event: the identities
    // normally flow in via the machine input (run options).
    if (typeof obj.topic === 'string') {
      return {
        type: 'START_DISCUSSION',
        topic: obj.topic,
        ...(typeof obj.hostLlm === 'string' ? { hostLlm: obj.hostLlm } : {}),
        ...(typeof obj.participantLlm === 'string'
          ? { participantLlm: obj.participantLlm }
          : {}),
      };
    }
    return null;
  }

  if (eventType === 'START_REVIEW') {
    if (
      typeof obj.latestChanges === 'string' &&
      typeof obj.reviewScope === 'string' &&
      REVIEW_SCOPES.has(obj.reviewScope)
    ) {
      return {
        type: 'START_REVIEW',
        latestChanges: obj.latestChanges,
        reviewScope: obj.reviewScope as ReviewScope,
        ...(typeof obj.rebuttals === 'string'
          ? { rebuttals: obj.rebuttals }
          : {}),
      };
    }
    return null;
  }

  if (eventType === 'BOSS_INTERRUPT') {
    if (
      typeof obj.targetId === 'string' &&
      BOSS_INTERRUPT_TARGET_IDS.has(obj.targetId)
    ) {
      return { type: 'BOSS_INTERRUPT', targetId: obj.targetId as never };
    }
    return null;
  }

  if (eventType === 'BOSS_REPLY') {
    if (typeof obj.answer !== 'string' || pendingQuestionIds.length === 0) {
      return null;
    }
    if (typeof obj.questionId === 'string') {
      return pendingQuestionIds.includes(obj.questionId)
        ? {
            type: 'BOSS_REPLY',
            questionId: obj.questionId as never,
            answer: obj.answer,
          }
        : null;
    }
    return pendingQuestionIds.length === 1
      ? {
          type: 'BOSS_REPLY',
          questionId: pendingQuestionIds[0] as never,
          answer: obj.answer,
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
    `The player "${input.player}" produced the output below for source item ${input.sourceItem}.`,
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
  lines.push('');
  lines.push(
    'Reply with a single JSON object: { "guard": "<one of the guard names above>", ...any payload fields the chosen guard description requires }.',
  );
  return lines.join('\n');
}

function parseAdjudication(raw: string, input: PlayerInput): PlayerOutput {
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

  // Per slc/link.md §Captain adjudication the judge answers
  // `{ guard, …payloadFields }` and the runtime validates the required
  // fields. Every payload field is carried through — dropping the
  // non-required ones would blind FSM fallbacks such as
  // `outputOf(event).reviewScope ?? context.reviewScope` on guards whose
  // description says "may include".
  const output = { ...obj, guard } as unknown as PlayerOutput;
  for (const field of requiredFieldsFor(input.result[guard])) {
    const value = output[field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      throw new Error(
        `adjudicator response for guard "${guard}" missing required field "${field}"`,
      );
    }
  }

  if (
    'reviewScope' in output &&
    typeof output.reviewScope === 'string' &&
    !REVIEW_SCOPES.has(output.reviewScope)
  ) {
    throw new Error(
      `adjudicator returned invalid reviewScope "${output.reviewScope}"`,
    );
  }

  return output;
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

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (Object.is(error, signal.reason)) return true;
  return normalizeErrorCompact(error)?.name === 'AbortError';
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
      typeof obj.player === 'string' &&
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
  waitHostInitialReply: 'askHostInitial',
  waitParticipantInitialReply: 'askParticipantInitial',
  waitHostReconciliationReply: 'hostInitialRound',
  waitParticipantReconciliationReply: 'participantInitialRound',
};

const WAIT_STATE_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(WAIT_STATE_RESUME_IDS),
  'awaitBossReply',
]);

const STATUS_STATE_IDS: ReadonlySet<string> = new Set([
  ...CAPTAIN_STATE_IDS,
  ...WAIT_STATE_IDS,
  'failed',
]);

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

function normalizedEventType(event: unknown): JsonValue {
  if (
    event !== null &&
    typeof event === 'object' &&
    !Array.isArray(event) &&
    'type' in event
  ) {
    const type = (event as { type: unknown }).type;
    return typeof type === 'string' ? type : String(type);
  }
  if (
    event === null ||
    typeof event === 'string' ||
    typeof event === 'boolean' ||
    (typeof event === 'number' && Number.isFinite(event))
  ) {
    return event;
  }
  return String(event);
}

function telemetryPayload(
  previousState: PlaybookState | undefined,
  state: PlaybookState,
  event: unknown,
  context: Record<string, unknown>,
): JsonValue {
  const eventError =
    event !== null &&
    typeof event === 'object' &&
    !Array.isArray(event) &&
    'error' in event
      ? normalizeErrorFull((event as { error: unknown }).error)
      : undefined;
  const pendingBossQuestions = pendingQuestionsFromContext(context);
  const payload = {
    from: previousState?.value ?? null,
    to: state.value,
    event: normalizedEventType(event),
    previousState: previousState ?? null,
    state,
    ...(pendingBossQuestions.length > 0 ? { pendingBossQuestions } : {}),
    ...(eventError !== undefined ? { error: eventError } : {}),
    ...(state.activeStateIds.includes('failed')
      ? { lastError: normalizeErrorFull(context.lastError) ?? null }
      : {}),
  } satisfies Record<string, unknown>;
  assertJsonSafe(payload);
  return payload;
}

export const createPlaybookRuntime: PlaybookRuntimeFactory<
  PlaybookRuntimeOptions
> = (options) => {
  const boundOptions = snapshotDiscussRuntimeOptions(options);
  const binding: Record<PlayerName, string> = {
    ...DEFAULT_PLAYER_BINDING,
    ...(boundOptions.playerBinding ?? {}),
  };
  const fsmInput: DiscussInput = {
    host: boundOptions.host,
    participant: boundOptions.participant,
    committer: boundOptions.committer,
  };

  type SessionIdentity = Readonly<PlaybookSession>;

  let ports: PlaybookPorts | undefined;
  let sessionIdentity: SessionIdentity | undefined;
  let actor: ReturnType<typeof createActor> | undefined;
  let currentSignal: AbortSignal | undefined;
  let currentTurnId: number | undefined;
  let previousState: PlaybookState | undefined;
  let suppressInspectionEmissions = false;
  let emissionFailures: unknown[] = [];
  let traceSequence = 0;
  let turnSequence = 0;
  let judgeCallSequence = 0;
  let playerCallSequence = 0;
  let lifecycleStarted = false;
  let initInFlight: Promise<void> | undefined;
  let disposed = false;
  let disposalPromise: Promise<void> | undefined;
  let controlPlaneError: unknown;
  const playerResumeTokens = new Map<string, string>();
  const inFlightPlayerIds = new Set<string>();
  const activeBoundaryCalls = new Set<Promise<unknown>>();
  const activeEmissionCalls = new Set<Promise<void>>();
  const emissionQueue = new PQueue({ concurrency: 1 });
  const judgeQueue = new PQueue({ concurrency: 1 });

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
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const queued = emissionQueue.add(fn);
    activeEmissionCalls.add(queued);
    void queued.then(
      () => activeEmissionCalls.delete(queued),
      (error: unknown) => {
        activeEmissionCalls.delete(queued);
        collectFailure(emissionFailures, error);
      },
    );
    return queued;
  };
  const flush = async (): Promise<void> => {
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
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, 'discuss runtime emissions failed');
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
      throw new Error('discuss runtime: init(session) must be called first');
    }
    return ports;
  };
  const requireSessionIdentity = (): SessionIdentity => {
    if (!sessionIdentity) {
      throw new Error('discuss runtime: init(session) must be called first');
    }
    return sessionIdentity;
  };
  const currentState = (): PlaybookState => {
    const live = actor;
    if (!live) {
      throw new Error('discuss runtime: actor is not initialized');
    }
    return normalizePlaybookSnapshot(live.getSnapshot());
  };
  const stateIdentity = (state: PlaybookState): { stateId?: string } => {
    return state.stateId === undefined ? {} : { stateId: state.stateId };
  };
  const enqueueTracedEmission = (
    type: PlaybookTraceType,
    payload: unknown,
    meta: { turnId?: number; callId?: string } = {},
    describedEmission?: (runtimePorts: PlaybookPorts) => Promise<void>,
  ): Promise<void> => {
    const runtimePorts = requirePorts();
    const identity = requireSessionIdentity();
    const jsonPayload = snapshotJsonValue(payload, `trace ${type} payload`);
    const trace: PlaybookTraceEvent = Object.freeze({
      schemaVersion: 2,
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
    return enqueue(async () => {
      await runtimePorts.emitTelemetry({ topic: TRACE_TOPIC, payload: trace });
      await describedEmission?.(runtimePorts);
    });
  };
  const emitTrace = (
    type: PlaybookTraceType,
    payload: unknown,
    meta: { turnId?: number; callId?: string } = {},
  ): Promise<void> => enqueueTracedEmission(type, payload, meta);
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
    try {
      await emitTrace(startedType, identity, meta);
    } catch (error) {
      latchControlPlaneError(error, signal);
      try {
        await emitTrace(
          finishedType,
          {
            ...identity,
            status: 'error',
            error: normalizeErrorFull(error) ?? {
              name: 'Error',
              message: String(error),
            },
          },
          meta,
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
    const identity = {
      purpose,
      ...(callStateId !== undefined ? { stateId: callStateId } : {}),
    };
    const queued = await judgeQueue.add(async () => {
      // Keep the complete queue task pending until an active host promise
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
            status: signal.aborted ? 'aborted' : 'error',
            error: normalizeErrorFull(error) ?? {
              name: 'Error',
              message: String(error),
            },
          },
          { turnId: currentTurnId, callId },
        );
        throw error;
      }

      await emitTrace(
        'judge.call.finished',
        { ...identity, status: 'ok', reply: finalText },
        { turnId: currentTurnId, callId },
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
  ): Promise<{ playerId: string; result: PlayerResult }> => {
    const playerId = resolvePlayerId(input, binding);
    if (inFlightPlayerIds.has(playerId)) {
      throw new Error(
        `resolved player "${playerId}" already has an in-flight call`,
      );
    }
    inFlightPlayerIds.add(playerId);
    const prompt = composePlayerPrompt(input);
    const resume: PlayerCallOptions['resume'] =
      playerResumeTokens.get(playerId) ?? false;
    const callId = `player-${++playerCallSequence}`;
    const identity = {
      purpose: 'captain',
      stateId: input.stateId,
      sourceItem: input.sourceItem,
      playerId,
      resume,
    };
    const emitFailure = (error: unknown): Promise<void> =>
      emitTrace(
        'player.call.finished',
        {
          ...identity,
          status: signal.aborted ? 'aborted' : 'error',
          error: normalizeErrorFull(error) ?? {
            name: 'Error',
            message: String(error),
          },
        },
        { turnId: currentTurnId, callId },
      );
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
          requirePorts().callPlayer(playerId, prompt, signal, { resume }),
        );
        rawResult = await boundary;
        // An XState sibling cancellation does not cancel an arbitrary host
        // promise. Re-check before a late resolution can mutate continuity or
        // masquerade as a successful boundary finish.
        signal.throwIfAborted();
      } catch (error) {
        // A rejected call produced no authoritative result, so the previous
        // token remains untouched. This also covers a host promise that
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
          // The malformed host result remains authoritative.
        }
        throw error;
      }

      // The resolved result is authoritative even on aborted/error status.
      // Update continuation state before interpreting that status.
      if (
        typeof result.resumeToken === 'string' &&
        result.resumeToken.trim().length > 0
      ) {
        playerResumeTokens.set(playerId, result.resumeToken);
      } else {
        playerResumeTokens.delete(playerId);
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
      );
      return { playerId, result };
    } finally {
      inFlightPlayerIds.delete(playerId);
    }
  };

  const callPlayer = (
    input: PlayerInput,
    signal: AbortSignal,
  ): Promise<{ playerId: string; result: PlayerResult }> => {
    return trackBoundaryCall(runPlayerCall(input, signal));
  };

  const player = fromPromise<PlayerOutput, PlayerInput>(
    async ({ input, signal }) => {
      const combined = combineSignals(signal, currentSignal);
      // XState starts invoked actors while publishing the entering snapshot.
      // Yield through the runtime emission queue before crossing the player
      // boundary so state trace/status always precede its call-start trace.
      try {
        await flush();
      } catch (error) {
        latchControlPlaneError(error, combined);
        throw error;
      }
      combined.throwIfAborted();

      const { playerId, result } = await callPlayer(input, combined);
      if (result.status !== 'ok') {
        throw new Error(
          `player "${playerId}" returned status "${result.status}"${
            result.error ? `: ${result.error}` : ''
          }`,
        );
      }
      if (result.finalText === undefined) {
        throw new Error(
          `player "${playerId}" returned status "ok" with no finalText`,
        );
      }
      combined.throwIfAborted();

      try {
        const prompt = buildAdjudicatorPrompt(input, result.finalText);
        return parseAdjudication(
          await callJudge(
            prompt,
            combined,
            'player-output-adjudication',
            input.stateId,
          ),
          input,
        );
      } catch (error) {
        latchControlPlaneError(error, combined);
        throw error;
      }
    },
  );

  const providedMachine = discussMachine.provide({ actors: { player } });

  const inspect = (event: InspectionEvent): void => {
    if (event.type !== '@xstate.snapshot') return;
    if (actor === undefined || event.actorRef !== actor) return;
    if (suppressInspectionEmissions) return;
    const snapshot = event.snapshot as SnapshotFrom<typeof discussMachine>;
    const state = normalizePlaybookSnapshot(snapshot);
    const prior = previousState;
    previousState = state;

    const runtimePorts = ports;
    if (!runtimePorts) return;
    const context = snapshot.context as Record<string, unknown>;
    const fsmPayload = telemetryPayload(prior, state, event.event, context);
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
    ).catch(() => undefined);

    const priorIds = new Set(prior?.activeStateIds ?? []);
    const pendingQuestions = pendingQuestionsFromContext(context);
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
      ).catch(() => undefined);
    };

    for (const activeStateId of state.activeStateIds) {
      if (priorIds.has(activeStateId) || !STATUS_STATE_IDS.has(activeStateId)) {
        continue;
      }
      if (WAIT_STATE_IDS.has(activeStateId)) {
        const pending = questionForWaitState(activeStateId, pendingQuestions);
        if (pending) {
          scheduleStatus(
            `${pending.player} asks: ${pending.question}`,
            activeStateId,
          );
          scheduleStatus(
            `◆ awaiting Boss reply · ${pending.resumeStateId} · ${pending.player} · ${pending.sourceItem}`,
            activeStateId,
          );
        }
        continue;
      }
      const lastError =
        activeStateId === 'failed'
          ? normalizeErrorCompact(context.lastError)
          : undefined;
      scheduleStatus(
        STATE_DESCRIPTIONS[activeStateId] ?? activeStateId,
        activeStateId,
        lastError === undefined ? undefined : { lastError },
      );
    }
  };

  const createRuntimeActor = (machineSnapshot?: JsonValue): void => {
    previousState = undefined;
    // DR-014 §1: a restore rehydrates the persisted machine snapshot;
    // XState derives context/value from it and ignores `input` then.
    actor = createActor(providedMachine, {
      input: fsmInput,
      ...(machineSnapshot === undefined
        ? {}
        : {
            snapshot: machineSnapshot as unknown as SnapshotFrom<
              typeof discussMachine
            >,
          }),
      inspect,
    });
  };

  const startActor = (): void => {
    createRuntimeActor();
    actor?.start();
  };

  const driveToQuiescence = async (): Promise<void> => {
    const live = actor;
    if (!live) throw new Error('discuss runtime: actor is not initialized');
    await waitForPlaybookQuiescence(live);
  };

  const classify = async (
    text: string,
    signal: AbortSignal,
  ): Promise<DiscussEvent | null> => {
    const live = actor;
    if (!live) throw new Error('discuss runtime: actor is not initialized');
    const snapshot = live.getSnapshot() as SnapshotFrom<typeof discussMachine>;
    const context = snapshot.context as Record<string, unknown>;
    const state = normalizePlaybookSnapshot(snapshot);
    const pendingQuestions = pendingQuestionsFromContext(context);
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
      pendingQuestions.map(({ questionId }) => questionId),
    );
  };

  const resultForSnapshot = (signal?: AbortSignal): PlaybookRunResult => {
    const live = actor;
    if (!live) throw new Error('discuss runtime: actor is not initialized');
    const snapshot = live.getSnapshot() as SnapshotFrom<typeof discussMachine>;
    const state = normalizePlaybookSnapshot(snapshot);
    const context = snapshot.context as Record<string, unknown>;
    if (signal?.aborted) {
      return {
        outcome: 'aborted',
        state,
        ...(signal.reason === undefined
          ? {}
          : {
              error: normalizeErrorFull(signal.reason) ?? {
                name: 'AbortError',
                message: String(signal.reason),
              },
            }),
      };
    }
    if (snapshot.status === 'done') {
      const output = (snapshot as { output?: unknown }).output;
      if (output !== undefined) assertJsonSafe(output, 'terminal output');
      return {
        outcome: 'terminal',
        state,
        ...(output === undefined ? {} : { output }),
      };
    }
    if (snapshot.status === 'error') {
      throw (
        (snapshot as { error?: unknown }).error ??
        new Error('discuss runtime actor entered error status')
      );
    }
    if (state.activeStateIds.includes('failed')) {
      const error = normalizeErrorFull(context.lastError);
      return {
        outcome: 'failed',
        state,
        ...(error === undefined ? {} : { error }),
      };
    }
    return { outcome: 'quiescent', state };
  };

  // Shared failed-start cleanup for init and restore: stop the actor,
  // drain queued work, optionally emit one best-effort session.disposed
  // boundary, and unbind every closure field so dispose stays callable.
  // The caller rethrows its original failure. A restore failure skips
  // the disposal trace — the parked session was never re-bound in this
  // process, so its persisted snapshot stays authoritative (DR-014 §2).
  const cleanupFailedStart = async (options: {
    emitDisposal: boolean;
  }): Promise<void> => {
    let finalState: PlaybookState | undefined;
    if (options.emitDisposal && actor) {
      try {
        finalState = currentState();
      } catch {
        // A state that cannot even normalize has no disposal descriptor.
      }
    }
    suppressInspectionEmissions = true;
    try {
      actor?.stop();
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
    playerResumeTokens.clear();
    inFlightPlayerIds.clear();
    activeBoundaryCalls.clear();
    activeEmissionCalls.clear();
    emissionQueue.clear();
    judgeQueue.clear();
    actor = undefined;
    currentSignal = undefined;
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
          'discuss runtime: init(session) may only be called once',
        );
      }
      const identity = snapshotPlaybookSession(session);
      let finishInitialization!: () => void;
      const initialization = new Promise<void>((resolve) => {
        finishInitialization = resolve;
      });
      initInFlight = initialization;
      lifecycleStarted = true;
      ports = identity.ports;
      sessionIdentity = identity;
      try {
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
        await cleanupFailedStart({ emitDisposal: true });
        throw error;
      } finally {
        finishInitialization();
        if (initInFlight === initialization) initInFlight = undefined;
      }
    },

    // DR-014 §1 / PBRT-45: JSON-safe capture of a parked session.
    // Defined only at a safe capture point — initialized, not disposing
    // or disposed, no active public boundary, and the actor quiescent
    // with status `active`. DISCUSS never opens nested playbook calls,
    // so no pending-call guard applies.
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
      const state = currentState();
      if (state.status !== 'active' || !state.quiescent) return undefined;
      const machine = detachPersistedMachineSnapshot(
        actor.getPersistedSnapshot(),
      );
      const context = (
        actor.getSnapshot() as SnapshotFrom<typeof discussMachine>
      ).context as Record<string, unknown>;
      return {
        schemaVersion: 1,
        playbookId: sessionIdentity.playbookId,
        machine,
        playerResumeTokens: Object.fromEntries(playerResumeTokens),
        sequences: {
          trace: traceSequence,
          turn: turnSequence,
          judgeCall: judgeCallSequence,
          playerCall: playerCallSequence,
          playbookCall: 0,
        },
        state,
        pendingBossQuestions: pendingQuestionsFromContext(context).map(
          (pending) => ({
            questionId: pending.questionId,
            player: pending.player,
            question: pending.question,
            sourceItem: pending.sourceItem,
          }),
        ),
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
          'discuss runtime: restore(session, snapshot) may only be called once',
        );
      }
      const identity = snapshotPlaybookSession(session);
      const boundSnapshot = assertPlaybookRuntimeSnapshot(
        snapshot,
        identity.playbookId,
      );
      let finishInitialization!: () => void;
      const initialization = new Promise<void>((resolve) => {
        finishInitialization = resolve;
      });
      initInFlight = initialization;
      lifecycleStarted = true;
      ports = identity.ports;
      sessionIdentity = identity;
      try {
        traceSequence = boundSnapshot.sequences.trace;
        turnSequence = boundSnapshot.sequences.turn;
        judgeCallSequence = boundSnapshot.sequences.judgeCall;
        playerCallSequence = boundSnapshot.sequences.playerCall;
        playerResumeTokens.clear();
        for (const [playerId, token] of Object.entries(
          boundSnapshot.playerResumeTokens,
        )) {
          playerResumeTokens.set(playerId, token);
        }
        suppressInspectionEmissions = true;
        createRuntimeActor(boundSnapshot.machine);
        actor?.start();
        const restoredState = currentState();
        if (restoredState.status !== 'active') {
          throw new Error(
            `discuss runtime: restored actor status is ${restoredState.status}, expected active`,
          );
        }
        suppressInspectionEmissions = false;
        previousState = restoredState;
        await flush();
      } catch (error) {
        await cleanupFailedStart({ emitDisposal: false });
        throw error;
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
        throw new Error('discuss runtime: runtime is disposing or disposed');
      }
      requirePorts();
      if (!actor) {
        throw new Error(
          'discuss runtime: init(session) must be called before handleBossInput',
        );
      }
      if (currentTurnId !== undefined) {
        throw new Error('discuss runtime: another runtime turn is active');
      }

      const turnId = ++turnSequence;
      currentTurnId = turnId;
      currentSignal = turn.signal;
      controlPlaneError = undefined;
      let result: PlaybookRunResult = resultForSnapshot(turn.signal);
      let settlement: unknown = result;
      const failures: unknown[] = [];
      try {
        await emitTrace('boss.input.received', { text: turn.text }, { turnId });
        if (turn.text.trim().length === 0) {
          const state = currentState();
          result = { outcome: 'no-action', state };
        } else {
          const event = await classify(turn.text, turn.signal);
          if (!event) {
            const state = currentState();
            await emitBoundaryStatus('No playbook action classified.', state);
            result = { outcome: 'no-action', state };
          } else {
            await emitBoundaryStatus(event.type, currentState());
            if (actor.getSnapshot().status === 'done') {
              actor.stop();
              startActor();
            }

            actor.send(event);
            await driveToQuiescence();
            await drainBoundaryCallsAndEmissions();

            if (controlPlaneError !== undefined) throw controlPlaneError;
            result = resultForSnapshot(turn.signal);
          }
        }
        settlement = {
          ...result,
          ...stateIdentity(result.state),
        };
      } catch (error) {
        const primaryError = controlPlaneError;
        if (primaryError !== undefined) {
          collectFailure(failures, primaryError);
        } else if (!turn.signal.aborted) {
          collectFailure(failures, error);
        }
        const state = currentState();
        const effectiveError = primaryError ?? error;
        result =
          turn.signal.aborted && primaryError === undefined
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
        collectFailure(failures, effectiveError);
        const state = currentState();
        result = {
          outcome:
            turn.signal.aborted && primaryError === undefined
              ? 'aborted'
              : 'failed',
          state,
          error: normalizeErrorFull(effectiveError) ?? {
            name: 'Error',
            message: String(effectiveError),
          },
        };
        settlement = { ...result, ...stateIdentity(state) };
      }
      currentSignal = undefined;
      try {
        await emitTrace('boss.input.settled', settlement, { turnId });
      } catch (error) {
        collectFailure(failures, error);
      }
      try {
        await flush();
      } catch (error) {
        collectFailure(failures, error);
      } finally {
        const primaryError = controlPlaneError;
        currentTurnId = undefined;
        controlPlaneError = undefined;
        if (primaryError !== undefined) throw primaryError;
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'discuss runtime turn failed');
      }
      return result;
    },

    async resumePlaybookCall({
      callId,
    }: {
      callId: string;
      result: PlaybookCallResult;
      signal: AbortSignal;
    }): Promise<PlaybookRunResult> {
      if (disposalPromise !== undefined) {
        throw new Error('discuss runtime: runtime is disposing or disposed');
      }
      requirePorts();
      if (!actor) {
        throw new Error(
          'discuss runtime: init(session) must be called before resumePlaybookCall',
        );
      }
      throw new Error(`unknown or stale playbook call id ${callId}`);
    },

    dispose(): Promise<void> {
      if (disposalPromise !== undefined) return disposalPromise;
      if (currentTurnId !== undefined) {
        return Promise.reject(
          new Error(
            'discuss runtime: cannot dispose while a runtime turn is active',
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
        if (actor) {
          actor.stop();
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
          playerResumeTokens.clear();
          inFlightPlayerIds.clear();
          activeBoundaryCalls.clear();
          activeEmissionCalls.clear();
          emissionQueue.clear();
          judgeQueue.clear();
          actor = undefined;
          currentSignal = undefined;
          currentTurnId = undefined;
          ports = undefined;
          sessionIdentity = undefined;
          previousState = undefined;
          controlPlaneError = undefined;
          disposed = true;
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'discuss runtime disposal failed');
        }
      })();
      return disposalPromise;
    },
  };
};

export const _internal = {
  composePlayerPrompt,
  resolvePlayerId,
  requiredFieldsFor,
  extractJson,
  buildClassifierPrompt,
  parseClassification,
  buildAdjudicatorPrompt,
  parseAdjudication,
  combineSignals,
  pendingQuestionsFromContext,
  normalizeErrorCompact,
  normalizeErrorFull,
  DEFAULT_PLAYER_BINDING,
  ALIAS_RESOLUTION,
  STATE_DESCRIPTIONS,
  CAPTAIN_STATES,
  CAPTAIN_STATE_IDS,
  BOSS_INTERRUPT_TARGETS,
  CONTINUATION_PREAMBLE,
  TELEMETRY_TOPIC,
};

export default createPlaybookRuntime;
