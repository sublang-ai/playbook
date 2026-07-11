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
//                       DISCUSS-15 keep CaptainInput.player = 'Committer';
//                       callPlayer resolution uses options.committer when
//                       supplied, otherwise falls back to Host, the first
//                       listed alias alternative.
//   Adjudication:       LLM-judge per state (default)
//   Boss-event mapping: free-text judge classification (default)
//   Abort strategy:     natural rejection; every Captain-invoking state's
//                       onError routes to the quiescent failed state.

import { createActor, fromPromise } from 'xstate';
import type { InspectionEvent, SnapshotFrom } from 'xstate';

import discussMachine, {
  type CaptainInput,
  type CaptainOutput,
  type DiscussEvent,
  type DiscussInput,
} from './discuss.fsm.js';

import type {
  PlayerCallOptions,
  PlayerResult,
  PlaybookPorts,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
  PlaybookSession,
  PlaybookTraceEvent,
  PlaybookTraceType,
} from '@sublang/playbook/runtime';

export type {
  PlayerCallOptions,
  PlayerResult,
  PlaybookPorts,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
  PlaybookSession,
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
  reviewSpecInitialCommit: 'Participant reviews newly committed spec-item changes.',
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

const QUIESCENT_STATES: ReadonlySet<string> = new Set([
  'ready',
  'awaitBossReply',
  'failed',
  'done',
]);

const BOSS_INTERRUPT_TARGETS = [
  'ready',
  'askHostInitial',
  'askParticipantInitial',
  'hostInitialRound',
  'participantInitialRound',
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
  'awaitBossReply',
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

const PLACEHOLDER_FIELDS: ReadonlyArray<readonly [string, keyof CaptainInput]> = [
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

function composePlayerPrompt(input: CaptainInput): string {
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
  input: CaptainInput,
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

function extractJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const tryParse = (value: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(value);
      return parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed) return parsed;
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return tryParse(trimmed.slice(first, last + 1));
  }

  return null;
}

function buildClassifierPrompt(
  text: string,
  ctx: { state: string; pendingQuestion?: string },
): string {
  const lines: string[] = [];
  lines.push('You are the Boss-input classifier for the discuss playbook.');
  lines.push(
    'Classify the Boss message into exactly one FSM event, or into no event.',
  );
  lines.push('');
  lines.push(`Current FSM state: ${ctx.state}`);
  if (ctx.pendingQuestion) {
    lines.push('Pending Boss question:');
    lines.push(ctx.pendingQuestion);
    lines.push(
      'If the Boss message answers that question, classify it as BOSS_REPLY; if it is a fresh directive, classify it accordingly.',
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
    '- BOSS_REPLY: required answer string; valid when the FSM waits in awaitBossReply.',
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

function parseClassification(raw: string): DiscussEvent | null {
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
        ...(typeof obj.rebuttals === 'string' ? { rebuttals: obj.rebuttals } : {}),
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
    return typeof obj.answer === 'string'
      ? { type: 'BOSS_REPLY', answer: obj.answer }
      : null;
  }

  return null;
}

function buildAdjudicatorPrompt(input: CaptainInput, playerOutput: string): string {
  const lines: string[] = [];
  lines.push('You are the guard adjudicator for a playbook state machine.');
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

function parseAdjudication(raw: string, input: CaptainInput): CaptainOutput {
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
  const output: CaptainOutput = { ...obj, guard };
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
    throw new Error(`adjudicator returned invalid reviewScope "${output.reviewScope}"`);
  }

  return output;
}

function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal {
  const signals = [a, b].filter((signal): signal is AbortSignal =>
    signal instanceof AbortSignal,
  );
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function normalizeErrorCompact(
  err: unknown,
): { name: string; message: string } | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      return {
        name: typeof obj.name === 'string' ? obj.name : 'Error',
        message: obj.message,
      };
    }
    // A message-less object (e.g. a malformed CaptainOutput remembered by
    // the FSM's failure actions) would String() to "[object Object]",
    // hiding the very payload that explains the failure. Serialize it.
    return { name: 'Error', message: stringifyCompact(err) };
  }
  return { name: 'Error', message: String(err) };
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeErrorFull(
  err: unknown,
): { name: string; message: string; stack?: string } | undefined {
  const compact = normalizeErrorCompact(err);
  if (!compact) return undefined;
  if (err instanceof Error && err.stack !== undefined) {
    return { ...compact, stack: err.stack };
  }
  if (typeof err === 'object' && err !== null) {
    const stack = (err as Record<string, unknown>).stack;
    if (typeof stack === 'string') return { ...compact, stack };
  }
  return compact;
}

function pendingQuestionFromContext(
  context: Record<string, unknown>,
): { player: string; question: string; resumeStateId: string } | undefined {
  const pending = context.pendingBossQuestion;
  if (pending === undefined || pending === null || typeof pending !== 'object') {
    return undefined;
  }
  const obj = pending as Record<string, unknown>;
  if (
    typeof obj.player === 'string' &&
    typeof obj.question === 'string' &&
    typeof obj.resumeStateId === 'string'
  ) {
    return {
      player: obj.player,
      question: obj.question,
      resumeStateId: obj.resumeStateId,
    };
  }
  return undefined;
}

function formatStateStatus(to: string, context: Record<string, unknown>): string {
  if (to === 'awaitBossReply') {
    const pending = pendingQuestionFromContext(context);
    return `${pending?.player ?? 'Player'} asks: ${pending?.question ?? ''}`;
  }
  return STATE_DESCRIPTIONS[to] ?? to;
}

function telemetryPayload(
  from: string | undefined,
  to: string,
  event: unknown,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: from ?? null,
    to,
    event:
      event !== null &&
      typeof event === 'object' &&
      !Array.isArray(event) &&
      'type' in event
        ? (event as { type: unknown }).type
        : (event ?? null),
  };
  const pending = pendingQuestionFromContext(context);
  if (pending) payload.pendingBossQuestion = pending;
  if (to === 'failed') {
    payload.lastError = normalizeErrorFull(context.lastError) ?? null;
  }
  return payload;
}

function isQuiescent(snapshot: { value: unknown; status?: string }): boolean {
  return (
    snapshot.status === 'done' ||
    (typeof snapshot.value === 'string' && QUIESCENT_STATES.has(snapshot.value))
  );
}

export const createPlaybookRuntime: PlaybookRuntimeFactory<
  PlaybookRuntimeOptions
> = (options) => {
  const binding: Record<PlayerName, string> = {
    ...DEFAULT_PLAYER_BINDING,
    ...(options.playerBinding ?? {}),
  };
  const fsmInput: DiscussInput = {
    host: options.host,
    participant: options.participant,
    committer: options.committer,
  };

  let ports: PlaybookPorts | undefined;
  let sessionIdentity:
    | Readonly<{ sessionId: string; playbookId: string }>
    | undefined;
  let actor: ReturnType<typeof createActor> | undefined;
  let currentSignal: AbortSignal | undefined;
  let currentTurnId: number | undefined;
  let adjudicatorError: unknown;
  let previousValue: string | undefined;
  let emissionChain: Promise<void> = Promise.resolve();
  let emissionFailures: unknown[] = [];
  let traceSequence = 0;
  let turnSequence = 0;
  let judgeCallSequence = 0;
  let playerCallSequence = 0;
  let lifecycleStarted = false;
  let disposed = false;
  const playerResumeTokens = new Map<string, string>();

  const collectFailure = (failures: unknown[], error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) collectFailure(failures, nested);
      return;
    }
    if (!failures.some((failure) => Object.is(failure, error))) {
      failures.push(error);
    }
  };
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const queued = emissionChain.then(() => fn());
    emissionChain = queued.catch((error: unknown) => {
      collectFailure(emissionFailures, error);
    });
    return queued;
  };
  const flush = async (): Promise<void> => {
    await emissionChain;
    if (emissionFailures.length === 0) return;
    const failures = emissionFailures;
    emissionFailures = [];
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, 'discuss runtime emissions failed');
  };
  const requirePorts = (): PlaybookPorts => {
    if (!ports) {
      throw new Error('discuss runtime: init(session) must be called first');
    }
    return ports;
  };
  const requireSessionIdentity = (): Readonly<{
    sessionId: string;
    playbookId: string;
  }> => {
    if (!sessionIdentity) {
      throw new Error('discuss runtime: init(session) must be called first');
    }
    return sessionIdentity;
  };
  const stateId = (): string | undefined => {
    const snapshot = actor?.getSnapshot();
    return typeof snapshot?.value === 'string' ? snapshot.value : previousValue;
  };
  const stateIdentity = (): { stateId?: string } => {
    const current = stateId();
    return current === undefined ? {} : { stateId: current };
  };
  const emitTrace = (
    type: PlaybookTraceType,
    payload: unknown,
    meta: { turnId?: number; callId?: string } = {},
  ): Promise<void> => {
    const runtimePorts = requirePorts();
    const identity = requireSessionIdentity();
    const trace: PlaybookTraceEvent = {
      schemaVersion: 1,
      sessionId: identity.sessionId,
      playbookId: identity.playbookId,
      sequence: ++traceSequence,
      timestamp: Date.now(),
      type,
      ...(meta.turnId !== undefined ? { turnId: meta.turnId } : {}),
      ...(meta.callId !== undefined ? { callId: meta.callId } : {}),
      payload,
    };
    return enqueue(() =>
      runtimePorts.emitTelemetry({ topic: TRACE_TOPIC, payload: trace }),
    );
  };

  const callJudge = async (
    prompt: string,
    signal: AbortSignal,
    purpose: 'boss-input-classification' | 'player-output-adjudication',
    callStateId: string | undefined,
  ): Promise<string> => {
    const callId = `judge-${++judgeCallSequence}`;
    const identity = {
      purpose,
      ...(callStateId !== undefined ? { stateId: callStateId } : {}),
    };
    await emitTrace(
      'judge.call.started',
      { ...identity, prompt },
      { turnId: currentTurnId, callId },
    );

    let finalText: string;
    try {
      finalText = await requirePorts().callJudge(prompt, signal);
    } catch (error) {
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
  };

  const callPlayer = async (
    input: CaptainInput,
    signal: AbortSignal,
  ): Promise<{ playerId: string; result: PlayerResult }> => {
    const playerId = resolvePlayerId(input, binding);
    const prompt = composePlayerPrompt(input);
    const resume: PlayerCallOptions['resume'] =
      playerResumeTokens.get(playerId) ?? false;
    const callId = `player-${++playerCallSequence}`;
    const callStateId =
      stateId() ??
      CAPTAIN_STATES.find((state) => state.sourceItem === input.sourceItem)
        ?.stateId;
    const identity = {
      purpose: 'captain',
      ...(callStateId !== undefined ? { stateId: callStateId } : {}),
      sourceItem: input.sourceItem,
      playerId,
      resume,
    };
    await emitTrace(
      'player.call.started',
      { ...identity, prompt },
      { turnId: currentTurnId, callId },
    );

    let result: PlayerResult;
    try {
      result = await requirePorts().callPlayer(playerId, prompt, signal, {
        resume,
      });
    } catch (error) {
      // A rejected call produced no authoritative result, so the previous
      // token remains untouched.
      await emitTrace(
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
  };

  const captain = fromPromise<CaptainOutput, CaptainInput>(
    async ({ input, signal }) => {
      const combined = combineSignals(signal, currentSignal);
      combined.throwIfAborted();

      const { playerId, result } = await callPlayer(input, combined);
      if (result.status !== 'ok') {
        throw new Error(
          `player "${playerId}" returned status "${result.status}"${
            result.error ? `: ${result.error}` : ''
          }`,
        );
      }
      combined.throwIfAborted();

      try {
        const prompt = buildAdjudicatorPrompt(input, result.finalText ?? '');
        return parseAdjudication(
          await callJudge(
            prompt,
            combined,
            'player-output-adjudication',
            stateId(),
          ),
          input,
        );
      } catch (error) {
        if (!combined.aborted) adjudicatorError = error;
        throw error;
      }
    },
  );

  const providedMachine = discussMachine.provide({ actors: { captain } });

  const inspect = (event: InspectionEvent): void => {
    if (event.type !== '@xstate.snapshot') return;
    if (actor === undefined || event.actorRef !== actor) return;
    const snapshot = event.snapshot as SnapshotFrom<typeof discussMachine>;
    if (typeof snapshot.value !== 'string') return;
    const to = snapshot.value;
    const from = previousValue;
    previousValue = to;

    const runtimePorts = ports;
    if (!runtimePorts) return;
    const context = snapshot.context as Record<string, unknown>;
    const fsmPayload = telemetryPayload(from, to, event.event, context);
    const statusMessage = formatStateStatus(to, context);
    const lastError =
      to === 'failed' ? normalizeErrorCompact(context.lastError) : undefined;
    const statusData =
      lastError === undefined ? undefined : { lastError };

    void emitTrace('fsm.transition', fsmPayload, {
      turnId: currentTurnId,
    });
    // A reentering transition can keep the same state id while still being
    // a real FSM transition (for example BOSS_INTERRUPT targeting `ready`).
    // Trace it, but retain DISCUSS's established host telemetry/status rule
    // of announcing only state-id changes.
    if (from === to) return;
    void enqueue(() =>
      runtimePorts.emitTelemetry({
        topic: TELEMETRY_TOPIC,
        payload: fsmPayload,
      }),
    );
    void emitTrace(
      'status.emitted',
      {
        stateId: to,
        message: statusMessage,
        ...(statusData !== undefined ? { data: statusData } : {}),
      },
      { turnId: currentTurnId },
    );
    void enqueue(() => runtimePorts.emitStatus(statusMessage, statusData));
  };

  const startActor = (): void => {
    previousValue = undefined;
    actor = createActor(providedMachine, { input: fsmInput, inspect });
    actor.start();
  };

  const driveToQuiescence = (): Promise<void> =>
    new Promise((resolve) => {
      const live = actor;
      if (!live) {
        resolve();
        return;
      }

      let settled = false;
      let subscription: { unsubscribe(): void } | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        subscription?.unsubscribe();
        resolve();
      };
      const check = (snapshot: { value: unknown; status?: string }): void => {
        if (isQuiescent(snapshot)) finish();
      };

      subscription = live.subscribe(check);
      check(live.getSnapshot());
    });

  const classify = async (
    text: string,
    signal: AbortSignal,
  ): Promise<DiscussEvent | null> => {
    const live = actor;
    if (!live) throw new Error('discuss runtime: actor is not initialized');
    const snapshot = live.getSnapshot() as SnapshotFrom<typeof discussMachine>;
    const context = snapshot.context as Record<string, unknown>;
    const prompt = buildClassifierPrompt(text, {
      state: String(snapshot.value),
      pendingQuestion: pendingQuestionFromContext(context)?.question,
    });
    const raw = await callJudge(
      prompt,
      signal,
      'boss-input-classification',
      String(snapshot.value),
    );
    return parseClassification(raw);
  };

  return {
    async init(session: PlaybookSession): Promise<void> {
      if (lifecycleStarted) {
        throw new Error('discuss runtime: init(session) may only be called once');
      }
      if (
        !session ||
        typeof session.sessionId !== 'string' ||
        session.sessionId.trim().length === 0
      ) {
        throw new Error('discuss runtime: sessionId must be a non-empty string');
      }
      if (
        typeof session.playbookId !== 'string' ||
        session.playbookId.trim().length === 0
      ) {
        throw new Error('discuss runtime: playbookId must be a non-empty string');
      }
      if (!session.ports) {
        throw new Error('discuss runtime: session.ports is required');
      }

      lifecycleStarted = true;
      ports = session.ports;
      sessionIdentity = Object.freeze({
        sessionId: session.sessionId,
        playbookId: session.playbookId,
      });
      await emitTrace('session.started', { stateId: 'ready' });
      startActor();
      await flush();
    },

    async handleBossInput(turn: {
      text: string;
      signal: AbortSignal;
    }): Promise<void> {
      requirePorts();
      if (!actor) {
        throw new Error(
          'discuss runtime: init(session) must be called before handleBossInput',
        );
      }

      const turnId = ++turnSequence;
      currentTurnId = turnId;
      currentSignal = turn.signal;
      adjudicatorError = undefined;
      let settlement: Record<string, unknown> = {
        outcome: 'failed',
        ...stateIdentity(),
      };
      const failures: unknown[] = [];
      try {
        await emitTrace(
          'boss.input.received',
          { text: turn.text },
          { turnId },
        );
        if (turn.text.trim().length === 0) {
          settlement = { outcome: 'no-action', ...stateIdentity() };
        } else {
          const event = await classify(turn.text, turn.signal);
          if (!event) {
            settlement = { outcome: 'no-action', ...stateIdentity() };
          } else {
            if (actor.getSnapshot().status === 'done') {
              actor.stop();
              startActor();
            }

            actor.send(event);
            await driveToQuiescence();
            await flush();

            if (adjudicatorError !== undefined) {
              const error = adjudicatorError;
              adjudicatorError = undefined;
              throw error;
            }
            const settledStateId = stateId();
            settlement = {
              outcome: turn.signal.aborted
                ? 'aborted'
                : actor.getSnapshot().status === 'done' ||
                    settledStateId === 'done'
                  ? 'terminal'
                  : settledStateId === 'failed'
                    ? 'failed'
                    : 'quiescent',
              ...(settledStateId !== undefined
                ? { stateId: settledStateId }
                : {}),
            };
          }
        }
      } catch (error) {
        collectFailure(failures, error);
        settlement = {
          outcome: turn.signal.aborted ? 'aborted' : 'failed',
          ...stateIdentity(),
          error: normalizeErrorFull(error) ?? {
            name: 'Error',
            message: String(error),
          },
        };
      }

      currentSignal = undefined;
      try {
        await flush();
      } catch (error) {
        collectFailure(failures, error);
        if (!('error' in settlement)) {
          settlement = {
            outcome: turn.signal.aborted ? 'aborted' : 'failed',
            ...stateIdentity(),
            error: normalizeErrorFull(error) ?? {
              name: 'Error',
              message: String(error),
            },
          };
        }
      }
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
        currentTurnId = undefined;
        adjudicatorError = undefined;
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'discuss runtime turn failed');
      }
    },

    async dispose(): Promise<void> {
      if (!sessionIdentity || disposed) return;
      const finalStateId = stateId();
      const failures: unknown[] = [];
      if (actor) {
        actor.stop();
      }
      try {
        await flush();
      } catch (error) {
        collectFailure(failures, error);
      }
      try {
        await emitTrace('session.disposed', {
          ...(finalStateId !== undefined ? { stateId: finalStateId } : {}),
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
        actor = undefined;
        currentSignal = undefined;
        currentTurnId = undefined;
        ports = undefined;
        sessionIdentity = undefined;
        disposed = true;
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'discuss runtime disposal failed');
      }
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
  normalizeErrorCompact,
  normalizeErrorFull,
  DEFAULT_PLAYER_BINDING,
  ALIAS_RESOLUTION,
  STATE_DESCRIPTIONS,
  CAPTAIN_STATES,
  CAPTAIN_STATE_IDS,
  QUIESCENT_STATES,
  BOSS_INTERRUPT_TARGETS,
  CONTINUATION_PREAMBLE,
  TELEMETRY_TOPIC,
};

export default createPlaybookRuntime;
