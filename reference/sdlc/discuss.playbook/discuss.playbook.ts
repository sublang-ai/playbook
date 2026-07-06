// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Linked playbook runtime.
// Link inputs:
// - FSM artifact: ./discuss.fsm.ts
// - Link target: ../../../node_modules/@sublang/playbook/src/runtime.ts
// - Player binding: Host -> host, Participant -> participant, Committer -> host
// - Composite alias resolution: Committer = Host | Participant; DISCUSS-13 and
//   DISCUSS-14 carry no <playerName>Player selector fields, so both fall back to
//   the first alias alternative, Host, and therefore use playerId "host".
// - Boss-event mapping strategy: free-text LLM judge JSON classification.
// - Adjudication strategy: LLM-judge for every state; marker-parse available by
//   PlaybookRuntimeOptions.adjudicationStrategies.
// - Abort strategy: natural rejection through the FSM's per-invoke onError arms.

import { createActor, fromPromise } from 'xstate';
import discussMachine, {
  type CaptainInput,
  type CaptainOutput,
  type DiscussionEvent,
  type DiscussionMachineInput,
  type Player,
  type ReviewScope,
  type SourceItemId,
} from './discuss.fsm.ts';
import type {
  PlayerResult,
  PlaybookPorts,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
} from '../../../node_modules/@sublang/playbook/src/runtime.ts';

export type {
  PlayerResult,
  PlaybookPorts,
  PlaybookRuntime,
  PlaybookRuntimeFactory,
} from '../../../node_modules/@sublang/playbook/src/runtime.ts';

type AdjudicationStrategy = 'llm-judge' | 'marker-parse';

type CaptainStateId =
  | 'askHostForInitialProposal'
  | 'askParticipantForInitialProposal'
  | 'hostInitialRound'
  | 'participantInitialRound'
  | 'updateSpecMap'
  | 'commitInitialChanges'
  | 'participantReviewSpecItems'
  | 'participantReviewDrs'
  | 'participantReviewSpecItemsAndDrs'
  | 'hostRespondToReviewFindings'
  | 'participantRespondToSpecItemRebuttals'
  | 'participantRespondToDrRebuttals'
  | 'participantRespondToMixedRebuttals'
  | 'commitReviewedChanges';

export interface PlaybookRuntimeOptions extends DiscussionMachineInput {
  players?: Partial<Record<Player, string>>;
  adjudicationStrategies?: Partial<Record<SourceItemId | CaptainStateId, AdjudicationStrategy>>;
}

const DEFAULT_PLAYER_BINDING = {
  Host: 'host',
  Participant: 'participant',
  Committer: 'host',
} as const satisfies Record<Player, string>;

const COMMITTER_ALIAS_RESOLUTION = {
  alias: 'Committer',
  alternatives: ['Host', 'Participant'],
  states: {
    commitInitialChanges: {
      sourceItem: 'DISCUSS-13',
      selectorFieldsPresent: [],
      resolvedPlayer: 'Host',
      playerId: 'host',
    },
    commitReviewedChanges: {
      sourceItem: 'DISCUSS-14',
      selectorFieldsPresent: [],
      resolvedPlayer: 'Host',
      playerId: 'host',
    },
  },
} as const;

const CAPTAIN_STATES = new Set<string>([
  'askHostForInitialProposal',
  'askParticipantForInitialProposal',
  'hostInitialRound',
  'participantInitialRound',
  'updateSpecMap',
  'commitInitialChanges',
  'participantReviewSpecItems',
  'participantReviewDrs',
  'participantReviewSpecItemsAndDrs',
  'hostRespondToReviewFindings',
  'participantRespondToSpecItemRebuttals',
  'participantRespondToDrRebuttals',
  'participantRespondToMixedRebuttals',
  'commitReviewedChanges',
]);

const QUIESCENT_STATES = new Set<string>(['ready', 'awaitBossReply', 'failed', 'done']);

const INTERRUPT_TARGET_IDS = [
  'ready',
  'askHostForInitialProposal',
  'askParticipantForInitialProposal',
  'hostInitialRound',
  'participantInitialRound',
  'updateSpecMap',
  'commitInitialChanges',
  'participantReviewSpecItems',
  'participantReviewDrs',
  'participantReviewSpecItemsAndDrs',
  'hostRespondToReviewFindings',
  'participantRespondToSpecItemRebuttals',
  'participantRespondToDrRebuttals',
  'participantRespondToMixedRebuttals',
  'commitReviewedChanges',
  'awaitBossReply',
  'failed',
] as const;

const REVIEW_SCOPES = ['specItems', 'drs', 'specItemsAndDrs'] as const;

const CONTINUATION_PREAMBLE =
  'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stateValueOf(snapshot: unknown): string {
  const value = (snapshot as { value?: unknown }).value;
  return typeof value === 'string' ? value : stringify(value);
}

function isFinalSnapshot(snapshot: unknown): boolean {
  return (snapshot as { status?: string }).status === 'done' || stateValueOf(snapshot) === 'done';
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Playbook turn aborted', 'AbortError');
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} returned an empty response`);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  const json = firstBrace >= 0 && lastBrace >= firstBrace ? candidate.slice(firstBrace, lastBrace + 1) : candidate;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new Error(`${label} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${label} JSON must be an object`);
}

function requiredFields(result: Record<string, string>, guard: string): string[] {
  const description = result[guard] ?? '';
  const fields: string[] = [];
  const includePattern = /Output shall include `([A-Za-z_][A-Za-z0-9_]*):/g;
  let match: RegExpExecArray | null;
  while ((match = includePattern.exec(description))) {
    fields.push(match[1]);
  }
  return fields;
}

function optionalFields(result: Record<string, string>, guard: string): string[] {
  const description = result[guard] ?? '';
  const fields: string[] = [];
  const includePattern = /Output may include `([A-Za-z_][A-Za-z0-9_]*):/g;
  let match: RegExpExecArray | null;
  while ((match = includePattern.exec(description))) {
    fields.push(match[1]);
  }
  return fields;
}

function conventionalModelName(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT';
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('-');
}

function substitutePromptPlaceholders(prompt: string, input: CaptainInput): string {
  return prompt
    .replaceAll('<host-llm>', input.hostLlm ? conventionalModelName(input.hostLlm) : '<host-llm>')
    .replaceAll(
      '<participant-llm>',
      input.participantLlm ? conventionalModelName(input.participantLlm) : '<participant-llm>',
    );
}

function labelledBlock(label: string, value: unknown): string | undefined {
  if (!hasText(value)) return undefined;
  return `${label}:\n${value.trim()}`;
}

export function composePlayerPrompt(input: CaptainInput): string {
  const sections: string[] = [];
  if (input.pendingBossQuestion && hasText(input.bossReply)) {
    sections.push(
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

  const structured = [
    labelledBlock('Boss intent', input.topic),
    labelledBlock('Other proposal', input.otherProposal),
    labelledBlock('Host proposal', input.hostProposal),
    labelledBlock('Participant proposal', input.participantProposal),
    labelledBlock('Review scope', input.reviewScope),
    labelledBlock('Review subject', input.reviewSubject),
    labelledBlock('Review items', input.reviewItems),
    labelledBlock('Rebuttals', input.rebuttals),
  ].filter((block): block is string => Boolean(block));

  sections.push(...structured);
  sections.push(substitutePromptPlaceholders(input.prompt, input));
  return sections.join('\n\n');
}

function resolvePlayerId(input: CaptainInput, binding: Record<Player, string>): string {
  if (input.player !== 'Committer') return binding[input.player];
  return binding[COMMITTER_ALIAS_RESOLUTION.states.commitInitialChanges.resolvedPlayer];
}

function adjudicatorPrompt(input: CaptainInput, playerOutput: string): string {
  const guards = Object.entries(input.result)
    .map(([guard, description]) => `- ${guard}: ${description}`)
    .join('\n');
  const fields = Array.from(
    new Set(
      Object.keys(input.result).flatMap((guard) => [
        ...requiredFields(input.result, guard),
        ...optionalFields(input.result, guard),
      ]),
    ),
  );
  const payloadText =
    fields.length > 0
      ? `When the selected guard description requires or permits payload fields, include them as top-level JSON keys. Known payload fields: ${fields.join(', ')}.`
      : 'No payload fields are declared for these guards.';
  return [
    'Classify the player output into exactly one FSM guard.',
    `Source item: ${input.sourceItem}`,
    `Player: ${input.player}`,
    '',
    'Declared guard result keys and verbatim descriptions:',
    guards,
    '',
    payloadText,
    'Return only JSON of the form {"guard":"<one declared guard>", ...payloadFields}.',
    '',
    'Player output, verbatim:',
    playerOutput,
  ].join('\n');
}

function markerParse(playerOutput: string): Record<string, unknown> {
  const lines = playerOutput.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith('FSM-RESULT:')) {
      return parseJsonObject(line.slice('FSM-RESULT:'.length), 'marker parser');
    }
  }
  throw new Error('marker parser found no terminal FSM-RESULT control line');
}

async function adjudicate(
  ports: PlaybookPorts,
  input: CaptainInput,
  playerOutput: string,
  strategy: AdjudicationStrategy,
  signal: AbortSignal,
): Promise<CaptainOutput> {
  assertNotAborted(signal);
  const parsed =
    strategy === 'marker-parse'
      ? markerParse(playerOutput)
      : parseJsonObject(
          await ports.callJudge(adjudicatorPrompt(input, playerOutput), signal),
          'adjudicator',
        );
  const guard = parsed.guard;
  if (typeof guard !== 'string' || !(guard in input.result)) {
    throw new Error(`adjudicator selected undeclared guard ${stringify(guard)} for ${input.sourceItem}`);
  }
  for (const field of requiredFields(input.result, guard)) {
    if (!hasText(parsed[field])) {
      throw new Error(`adjudicator omitted required field ${field} for guard ${guard}`);
    }
  }
  return { ...parsed, guard } as CaptainOutput;
}

function classifierPrompt(text: string, snapshot: unknown): string {
  const context = (snapshot as { context?: Record<string, unknown> }).context ?? {};
  const pending = context.pendingBossQuestion as { question?: string } | undefined;
  const currentState = stateValueOf(snapshot);
  return [
    'Classify Boss input for the discuss FSM.',
    'Return only JSON. Use {"type":"NO_ACTION"} if the text should not send an FSM event.',
    'Do not treat slash-prefixed text specially; classify it as ordinary Boss text.',
    '',
    `Current state: ${currentState}`,
    pending?.question ? `Pending Boss question: ${pending.question}` : 'Pending Boss question: none',
    '',
    'Allowed event JSON shapes:',
    '- {"type":"START_DISCUSSION","topic":"string","hostLlm":"optional string","participantLlm":"optional string"}',
    '- {"type":"BEGIN_INITIAL_ROUND","nextPlayer":"Host|Participant","topic":"optional string","hostProposal":"optional string","participantProposal":"optional string","hostInitialDiscussionEnded":"optional boolean","participantInitialDiscussionEnded":"optional boolean"}',
    '- {"type":"START_REVIEW","scope":"specItems|drs|specItemsAndDrs","reviewSubject":"optional string"}',
    '- {"type":"BOSS_REPLY","answer":"string"}',
    `- {"type":"BOSS_INTERRUPT","targetId":"${INTERRUPT_TARGET_IDS.join('|')}"}`,
    '',
    'Boss input:',
    text,
  ].join('\n');
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseBossEvent(raw: Record<string, unknown>): DiscussionEvent | undefined {
  switch (raw.type) {
    case 'NO_ACTION':
      return undefined;
    case 'START_DISCUSSION': {
      if (!hasText(raw.topic)) throw new Error('START_DISCUSSION requires topic');
      return {
        type: 'START_DISCUSSION',
        topic: raw.topic,
        hostLlm: asOptionalString(raw.hostLlm),
        participantLlm: asOptionalString(raw.participantLlm),
      };
    }
    case 'BEGIN_INITIAL_ROUND': {
      if (raw.nextPlayer !== 'Host' && raw.nextPlayer !== 'Participant') {
        throw new Error('BEGIN_INITIAL_ROUND requires nextPlayer Host or Participant');
      }
      return {
        type: 'BEGIN_INITIAL_ROUND',
        nextPlayer: raw.nextPlayer,
        topic: asOptionalString(raw.topic),
        hostProposal: asOptionalString(raw.hostProposal),
        participantProposal: asOptionalString(raw.participantProposal),
        hostInitialDiscussionEnded: asOptionalBoolean(raw.hostInitialDiscussionEnded),
        participantInitialDiscussionEnded: asOptionalBoolean(raw.participantInitialDiscussionEnded),
      };
    }
    case 'START_REVIEW': {
      if (!REVIEW_SCOPES.includes(raw.scope as ReviewScope)) {
        throw new Error('START_REVIEW requires scope specItems, drs, or specItemsAndDrs');
      }
      return {
        type: 'START_REVIEW',
        scope: raw.scope as ReviewScope,
        reviewSubject: asOptionalString(raw.reviewSubject),
      };
    }
    case 'BOSS_REPLY': {
      if (typeof raw.answer !== 'string') throw new Error('BOSS_REPLY requires answer');
      return { type: 'BOSS_REPLY', answer: raw.answer };
    }
    case 'BOSS_INTERRUPT': {
      if (!INTERRUPT_TARGET_IDS.includes(raw.targetId as (typeof INTERRUPT_TARGET_IDS)[number])) {
        throw new Error('BOSS_INTERRUPT requires a valid targetId');
      }
      return { type: 'BOSS_INTERRUPT', targetId: raw.targetId as string };
    }
    default:
      throw new Error(`classifier selected unknown event ${stringify(raw.type)}`);
  }
}

async function classifyBossInput(
  ports: PlaybookPorts,
  text: string,
  snapshot: unknown,
  signal: AbortSignal,
): Promise<DiscussionEvent | undefined> {
  if (text.trim().length === 0) return undefined;
  assertNotAborted(signal);
  const response = await ports.callJudge(classifierPrompt(text, snapshot), signal);
  assertNotAborted(signal);
  return parseBossEvent(parseJsonObject(response, 'classifier'));
}

function inputFromOptions(options: PlaybookRuntimeOptions): DiscussionMachineInput {
  return {
    players: { ...DEFAULT_PLAYER_BINDING, ...(options.players ?? {}) },
    hostLlm: options.hostLlm,
    participantLlm: options.participantLlm,
  };
}

export function createPlaybookRuntime(options: PlaybookRuntimeOptions): PlaybookRuntime {
  const runtimeOptions = options;
  let ports: PlaybookPorts | undefined;
  let actor: ReturnType<typeof createActor> | undefined;
  let emissions: Promise<void> = Promise.resolve();
  let lastState: string | undefined;
  let lastEvent: string | undefined;
  let pendingCaptains = 0;
  let wakeQuiescence: (() => void) | undefined;
  let disposed = false;
  let activeTurnSignal: AbortSignal | undefined;

  function enqueueEmission(work: () => Promise<void>): void {
    emissions = emissions.then(work, work);
  }

  function wake(): void {
    const fn = wakeQuiescence;
    wakeQuiescence = undefined;
    if (fn) fn();
  }

  function strategyFor(input: CaptainInput): AdjudicationStrategy {
    return (
      runtimeOptions.adjudicationStrategies?.[input.sourceItem] ??
      runtimeOptions.adjudicationStrategies?.[stateValueOf(actor?.getSnapshot()) as CaptainStateId] ??
      'llm-judge'
    );
  }

  function buildActor(): void {
    if (!ports) throw new Error('Playbook runtime init requires ports');
    const boundPorts = ports;
    const machine = discussMachine.provide({
      actors: {
        captain: fromPromise<CaptainOutput, CaptainInput>(async ({ input, signal }) => {
          pendingCaptains += 1;
          const turnSignal = activeTurnSignal ?? signal;
          try {
            assertNotAborted(turnSignal);
            const playerId = resolvePlayerId(input, {
              ...DEFAULT_PLAYER_BINDING,
              ...(runtimeOptions.players ?? {}),
            });
            const result: PlayerResult = await boundPorts.callPlayer(
              playerId,
              composePlayerPrompt(input),
              turnSignal,
            );
            assertNotAborted(turnSignal);
            if (result.status !== 'ok') {
              throw new Error(result.error ?? `player ${playerId} returned ${result.status}`);
            }
            const finalText = result.finalText ?? '';
            return await adjudicate(boundPorts, input, finalText, strategyFor(input), turnSignal);
          } finally {
            pendingCaptains -= 1;
            wake();
          }
        }),
      },
    });
    actor = createActor(machine, { input: inputFromOptions(runtimeOptions) });
    lastState = undefined;
    actor.subscribe((snapshot) => {
      const to = stateValueOf(snapshot);
      const from = lastState;
      if (from === undefined) {
        lastState = to;
        return;
      }
      if (to === from) return;
      const event = lastEvent;
      lastState = to;
      enqueueEmission(async () => {
        await boundPorts.emitStatus(`discuss entered ${to}`, {
          from,
          to,
          event,
          ...(to === 'failed' ? { lastError: snapshot.context.lastError } : {}),
        });
        if (to === 'failed' && snapshot.context.lastError !== undefined) {
          await boundPorts.emitStatus('discuss failed', { lastError: snapshot.context.lastError });
        }
        await boundPorts.emitTelemetry({
          topic: 'playbook.fsm.state',
          payload: { from, to, event },
        });
      });
      wake();
    });
    actor.start();
  }

  async function drain(): Promise<void> {
    await emissions;
  }

  async function waitForQuiescence(signal: AbortSignal, tolerateAbort: boolean): Promise<void> {
    for (;;) {
      if (!tolerateAbort) assertNotAborted(signal);
      const snapshot = actor?.getSnapshot();
      if (!snapshot) return;
      const value = stateValueOf(snapshot);
      if ((QUIESCENT_STATES.has(value) || !CAPTAIN_STATES.has(value) || isFinalSnapshot(snapshot)) && pendingCaptains === 0) {
        await drain();
        return;
      }
      await new Promise<void>((resolve) => {
        wakeQuiescence = resolve;
        setTimeout(resolve, 0);
      });
    }
  }

  return {
    async init(nextPorts: PlaybookPorts): Promise<void> {
      ports = nextPorts;
      disposed = false;
      buildActor();
      await drain();
    },

    async handleBossInput(turn: { text: string; signal: AbortSignal }): Promise<void> {
      if (disposed) throw new Error('Playbook runtime has been disposed');
      if (!ports || !actor) throw new Error('Playbook runtime has not been initialized');
      if (turn.text.trim().length === 0) return;
      let event: DiscussionEvent | undefined;
      try {
        event = await classifyBossInput(ports, turn.text, actor.getSnapshot(), turn.signal);
      } catch (error) {
        await drain();
        if (turn.signal.aborted) return;
        throw error;
      }
      if (!event) {
        await drain();
        return;
      }
      if (isFinalSnapshot(actor.getSnapshot())) {
        actor.stop();
        buildActor();
      }
      lastEvent = event.type;
      activeTurnSignal = turn.signal;
      actor.send(event);
      try {
        await waitForQuiescence(turn.signal, true);
      } catch (error) {
        await drain();
        if (turn.signal.aborted) return;
        throw error;
      } finally {
        activeTurnSignal = undefined;
      }
      await drain();
    },

    async dispose(): Promise<void> {
      disposed = true;
      actor?.stop();
      actor = undefined;
      wake();
      await drain();
    },
  };
}

const defaultFactory: PlaybookRuntimeFactory<PlaybookRuntimeOptions> = createPlaybookRuntime;

export const _internal = {
  composePlayerPrompt,
  defaultPlayerBinding: DEFAULT_PLAYER_BINDING,
  committerAliasResolution: COMMITTER_ALIAS_RESOLUTION,
  classifyBossInput,
  adjudicate,
};

export default defaultFactory;
