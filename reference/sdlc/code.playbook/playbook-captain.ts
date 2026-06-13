// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  BossTurn,
  Captain,
  CaptainContext,
  CaptainSession,
} from '@sublang/cligent/tmux-play';
import type {
  PlaybookPorts,
  PlaybookRuntime,
} from './code.playbook.js';
import {
  codePlaybookRegistryEntry,
  type RegistryPlayer,
} from './code.registry.js';

export interface CreatePlaybookRuntimeOptions {
  captainOptions: unknown;
  players: readonly RegistryPlayer[];
}

export interface PlaybookCaptainRegistryEntry {
  id: string;
  command: string;
  intent: string;
  idleStateId: string;
  finalStateId: string;
  copyPasteGuardNames: readonly string[];
  stateCountLabels?: Readonly<Record<string, string>>;
  validateOptions(captainOptions: unknown): unknown;
  createRuntime(options: CreatePlaybookRuntimeOptions): PlaybookRuntime;
}

interface ActiveEngagement {
  entry: PlaybookCaptainRegistryEntry;
  runtime: PlaybookRuntime;
}

type RouterDecision =
  | { decision: 'chat'; text: string }
  | { decision: 'dispatch'; playbookId: string; text: string }
  | { decision: 'sub'; text: string }
  | { decision: 'dismiss'; text?: string };

type DisposalReason = 'dismiss' | 'final' | 'dispose';

interface ControlLedger {
  activePlaybookId?: string;
  mode: ShellMode;
  latestSubRuntimeStateId?: string;
  pendingBossQuestion?: unknown;
  lastError?: { name: string; message: string };
  lastRouteDecision?: RouterDecision['decision'];
}

type ShellMode = 'chat' | 'engaged.driving' | 'engaged.parked';

const SUB_RUNTIME_FSM_TOPIC = 'playbook.fsm.state';
const SHELL_FSM_TOPIC = 'playbook.captain.fsm.state';

interface TurnSummaryCounts {
  interruptions: number;
  copyPastes: number;
}

interface ActiveTurnSummary {
  counts: TurnSummaryCounts;
  stateCounts: Map<string, number>;
}

const SUMMARY_VISIBLE_STATE_COUNT_LABELS = new Set([
  'review round',
  'rebuttal',
]);

export const playbookCaptainRegistry: readonly PlaybookCaptainRegistryEntry[] = [
  codePlaybookRegistryEntry,
];

function parseRegisteredCommand(
  prompt: string,
): { command: string; text: string } | undefined {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    prompt.trim(),
  );
  if (!match) return undefined;
  return { command: match[1], text: (match[2] ?? '').trim() };
}

function playbookCommandLabel(entry: PlaybookCaptainRegistryEntry): string {
  return `/${entry.command}`;
}

function visibleChatEnvelope(message: string): string {
  return [
    'You are the Playbook Captain shell.',
    'This is visible Boss chat. Do not reveal hidden control JSON, hidden router decisions, or hidden judge replies.',
    message,
  ].join('\n\n');
}

function visibleTurnSummaryEnvelope(input: {
  playbookId: string;
  submittedText: string;
  counts: TurnSummaryCounts;
  reviewProgressPhrase: string;
}): string {
  const savedLine = `Saved you: ${input.counts.interruptions} interruptions and ${input.counts.copyPastes} copy-pastes`;
  return [
    'You are the Playbook Captain shell.',
    'This is visible Boss chat after a sub-playbook command completed. Do not reveal hidden control JSON, hidden router decisions, or hidden judge replies.',
    'Write a brief, clearly formatted turn-summary block for Boss.',
    'Use a natural, chat-like tone and no more than two short sentences before the saved-count paragraph.',
    'State only what was done or what changed; do not explain how it was done.',
    'Do not list raw state names, transitions, guard names, prompts, tools, hidden calls, or reasoning.',
    'If progress detail is useful, use only the aggregate review/rebuttal rounds phrase supplied below.',
    'Do not mention counts for plan or implementation steps, tests green, or any other internal state.',
    `Then write one short paragraph beginning exactly: ${savedLine}`,
    'Use the exact counts supplied; do not change them.',
    `Playbook: ${input.playbookId}`,
    `Submitted Boss text:\n${input.submittedText}`,
    `Review/rebuttal rounds:\n${input.reviewProgressPhrase}`,
    `Counts:\n${JSON.stringify(input.counts)}`,
  ].join('\n\n');
}

function stateCountLabel(
  stateId: string,
  entry: PlaybookCaptainRegistryEntry,
): string | undefined {
  if (stateId === entry.idleStateId || stateId === entry.finalStateId) {
    return undefined;
  }
  const registryLabel = entry.stateCountLabels?.[stateId]?.trim();
  if (!registryLabel) return undefined;
  return SUMMARY_VISIBLE_STATE_COUNT_LABELS.has(registryLabel)
    ? registryLabel
    : undefined;
}

function pluralizeStateCount(label: string, count: number): string {
  if (count === 1) return `1 ${label}`;
  if (label.endsWith('y')) return `${count} ${label.slice(0, -1)}ies`;
  if (label.endsWith('s')) return `${count} ${label}es`;
  return `${count} ${label}s`;
}

function reviewProgressPhrase(stateCounts: ReadonlyMap<string, number>): string {
  if (stateCounts.size === 0) return 'none';
  return [...stateCounts.entries()]
    .map(([label, count]) => pluralizeStateCount(label, count))
    .join(', ');
}

function guardFromJudgeReply(finalText: string): string | undefined {
  return /"guard"\s*:\s*"([^"]+)"/.exec(finalText)?.[1];
}

function normalizeRegistry(
  registry: readonly PlaybookCaptainRegistryEntry[],
): {
  entries: readonly PlaybookCaptainRegistryEntry[];
  byCommand: Map<string, PlaybookCaptainRegistryEntry>;
  byId: Map<string, PlaybookCaptainRegistryEntry>;
} {
  const byCommand = new Map<string, PlaybookCaptainRegistryEntry>();
  const byId = new Map<string, PlaybookCaptainRegistryEntry>();
  for (const entry of registry) {
    byCommand.set(entry.command, entry);
    byId.set(entry.id, entry);
  }
  return { entries: registry, byCommand, byId };
}

export function createPlaybookCaptainShell(
  options: unknown,
  registry: readonly PlaybookCaptainRegistryEntry[] = playbookCaptainRegistry,
): Captain {
  const { entries, byCommand, byId } = normalizeRegistry(registry);
  let session: CaptainSession | undefined;
  let players: readonly RegistryPlayer[] = [];
  let activeContext: CaptainContext | undefined;
  let active: ActiveEngagement | undefined;
  let mode: ShellMode = 'chat';
  let latestSubRuntimeStateId: string | undefined;
  let pendingBossQuestion: unknown;
  let lastError: { name: string; message: string } | undefined;
  let lastRouteDecision: RouterDecision['decision'] | undefined;
  let finalDisposalRequested: ActiveEngagement | undefined;
  let activeTurnSummary: ActiveTurnSummary | undefined;

  const requireSession = (): CaptainSession => {
    if (!session) {
      throw new Error('init must be called first');
    }
    return session;
  };

  const ledgerSnapshot = (
    playbookId: string | undefined = active?.entry.id,
  ): ControlLedger => ({
    ...(playbookId ? { activePlaybookId: playbookId } : {}),
    mode,
    ...(latestSubRuntimeStateId ? { latestSubRuntimeStateId } : {}),
    ...(pendingBossQuestion !== undefined ? { pendingBossQuestion } : {}),
    ...(lastError ? { lastError } : {}),
    ...(lastRouteDecision ? { lastRouteDecision } : {}),
  });

  const emitShellTelemetry = async (
    from: ShellMode,
    to: ShellMode,
    event: string,
    playbookId: string | undefined = active?.entry.id,
  ): Promise<void> => {
    await requireSession().emitTelemetry({
      topic: SHELL_FSM_TOPIC,
      payload: {
        from,
        to,
        event,
        ledger: ledgerSnapshot(playbookId),
      },
    });
  };

  const setMode = async (
    nextMode: ShellMode,
    event: string,
    playbookId: string | undefined = active?.entry.id,
  ): Promise<void> => {
    if (mode === nextMode) return;
    const from = mode;
    mode = nextMode;
    await emitShellTelemetry(from, nextMode, event, playbookId);
  };

  const normalizeErrorCompact = (
    value: unknown,
  ): { name: string; message: string } | undefined => {
    if (value === undefined || value === null) return undefined;
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.message === 'string') {
        return {
          name: typeof record.name === 'string' ? record.name : 'Error',
          message: record.message,
        };
      }
    }
    return { name: 'Error', message: String(value) };
  };

  const payloadRecord = (
    payload: unknown,
  ): Record<string, unknown> | undefined =>
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;

  const mirroredStateId = (payload: unknown): string | undefined => {
    const record = payloadRecord(payload);
    if (!record) return undefined;
    if (typeof record.to === 'string') return record.to;
    return typeof record.state === 'string' ? record.state : undefined;
  };

  const mirrorSubRuntimeTelemetry = async (payload: unknown): Promise<void> => {
    if (!active) return;
    const record = payloadRecord(payload);
    const stateId = mirroredStateId(payload);
    if (stateId === undefined) return;

    const countLabel = stateCountLabel(stateId, active.entry);
    if (activeTurnSummary && countLabel) {
      activeTurnSummary.stateCounts.set(
        countLabel,
        (activeTurnSummary.stateCounts.get(countLabel) ?? 0) + 1,
      );
    }

    latestSubRuntimeStateId = stateId;
    pendingBossQuestion = record?.pendingBossQuestion;
    lastError = normalizeErrorCompact(record?.lastError);

    if (stateId === active.entry.finalStateId) {
      finalDisposalRequested = active;
      return;
    }

    if (
      stateId === active.entry.idleStateId ||
      stateId === 'failed' ||
      stateId === 'awaitBossReply'
    ) {
      await setMode('engaged.parked', `sub-runtime:${stateId}`);
    }
  };

  const createPorts = (): PlaybookPorts => ({
    callPlayer: async (playerId, prompt, _signal) => {
      if (!activeContext) {
        throw new Error('callPlayer invoked outside a Boss turn');
      }
      const result = await activeContext.callPlayer(playerId, prompt);
      if (activeTurnSummary) {
        activeTurnSummary.counts.interruptions++;
      }
      return {
        status: result.status,
        finalText: result.finalText,
        error: result.error,
      };
    },
    callJudge: async (prompt, _signal) => {
      if (!activeContext) {
        throw new Error('callJudge invoked outside a Boss turn');
      }
      const result = await activeContext.callCaptain(prompt, {
        visibility: 'hidden',
      });
      if (result.status !== 'ok') {
        throw new Error(
          result.error ?? `callCaptain status "${result.status}"`,
        );
      }
      if (result.finalText === undefined) {
        throw new Error('callCaptain returned status=ok with no finalText');
      }
      const guard = guardFromJudgeReply(result.finalText);
      if (
        guard &&
        active?.entry.copyPasteGuardNames.includes(guard) &&
        activeTurnSummary
      ) {
        activeTurnSummary.counts.copyPastes++;
      }
      return result.finalText;
    },
    emitStatus: async (message, data) => {
      await requireSession().emitStatus(
        message,
        data as Record<string, unknown> | undefined,
      );
    },
    emitTelemetry: async (event) => {
      if (event.topic === SUB_RUNTIME_FSM_TOPIC) {
        await mirrorSubRuntimeTelemetry(event.payload);
      }
      await requireSession().emitTelemetry(event);
    },
  });

  const engage = async (
    entry: PlaybookCaptainRegistryEntry,
  ): Promise<ActiveEngagement> => {
    if (active?.entry.id === entry.id) return active;
    const runtime = entry.createRuntime({
      captainOptions: options,
      players,
    });
    active = { entry, runtime };
    latestSubRuntimeStateId = undefined;
    pendingBossQuestion = undefined;
    lastError = undefined;
    finalDisposalRequested = undefined;
    await setMode('engaged.parked', 'engage', entry.id);
    await runtime.init(createPorts());
    await requireSession().emitStatus(
      `◇ ${playbookCommandLabel(entry)} started`,
    );
    return active;
  };

  const submitToActive = async (
    engagement: ActiveEngagement,
    text: string,
    context: CaptainContext,
  ): Promise<void> => {
    const summaryCounts: TurnSummaryCounts = {
      interruptions: 0,
      copyPastes: 0,
    };
    const summaryStateCounts = new Map<string, number>();
    let shouldSummarize = false;
    activeTurnSummary = {
      counts: summaryCounts,
      stateCounts: summaryStateCounts,
    };
    await setMode('engaged.driving', 'submit');
    try {
      await engagement.runtime.handleBossInput({
        text,
        signal: context.signal,
      });
      shouldSummarize = true;
    } finally {
      activeTurnSummary = undefined;
      if (active === engagement && finalDisposalRequested === engagement) {
        finalDisposalRequested = undefined;
        await disposeActive('final');
      } else if (active === engagement && mode === 'engaged.driving') {
        await setMode('engaged.parked', 'turn.settled');
      }
    }
    if (shouldSummarize) {
      await callVisibleTurnSummary(context, {
        playbookId: engagement.entry.id,
        submittedText: text,
        counts: summaryCounts,
        reviewProgressPhrase: reviewProgressPhrase(summaryStateCounts),
      });
    }
  };

  const disposeActive = async (
    reason: DisposalReason,
  ): Promise<void> => {
    const engagement = active;
    if (!engagement) return;
    const playbookId = engagement.entry.id;
    const commandLabel = playbookCommandLabel(engagement.entry);
    active = undefined;
    finalDisposalRequested = undefined;
    if (reason === 'dispose') {
      mode = 'chat';
      await engagement.runtime.dispose();
      latestSubRuntimeStateId = undefined;
      pendingBossQuestion = undefined;
      lastError = undefined;
      return;
    }
    await setMode('chat', reason, playbookId);
    await engagement.runtime.dispose();
    if (reason === 'dismiss') {
      await requireSession().emitStatus(`◇ ${commandLabel} stopped`);
    } else if (reason === 'final') {
      await requireSession().emitStatus(`◇ ${commandLabel} finished`);
    }
    latestSubRuntimeStateId = undefined;
    pendingBossQuestion = undefined;
    lastError = undefined;
  };

  const callVisibleChat = async (
    context: CaptainContext,
    message: string,
  ): Promise<void> => {
    const result = await context.callCaptain(visibleChatEnvelope(message));
    if (result.status !== 'ok') {
      throw new Error(
        result.error ?? `callCaptain status "${result.status}"`,
      );
    }
  };

  const callVisibleTurnSummary = async (
    context: CaptainContext,
    input: {
      playbookId: string;
      submittedText: string;
      counts: TurnSummaryCounts;
      reviewProgressPhrase: string;
    },
  ): Promise<void> => {
    const result = await context.callCaptain(visibleTurnSummaryEnvelope(input));
    if (result.status !== 'ok') {
      throw new Error(
        result.error ?? `callCaptain status "${result.status}"`,
      );
    }
  };

  const hiddenRouterEnvelope = (prompt: string): string =>
    [
      'You are the Playbook Captain shell router.',
      'This is hidden control work. Return only one JSON object and no prose.',
      'Allowed decisions:',
      '{"decision":"chat","text":"visible clarification or chat reply"}',
      '{"decision":"dispatch","playbookId":"<registered id>","text":"Boss text for that playbook"}',
      '{"decision":"sub","text":"Boss text for the active playbook"}',
      '{"decision":"dismiss","text":"optional visible dismissal reply"}',
      'Use chat for near-miss command-like input or low-confidence playbook selection.',
      'Treat unregistered slash-prefixed input as ordinary router input.',
      `Ledger:\n${JSON.stringify(ledgerSnapshot())}`,
      `Registry:\n${JSON.stringify(
        entries.map((entry) => ({
          id: entry.id,
          command: entry.command,
          intent: entry.intent,
        })),
      )}`,
      `Boss message:\n${prompt}`,
    ].join('\n\n');

  const routerClarification = async (
    context: CaptainContext,
  ): Promise<void> => {
    await callVisibleChat(
      context,
      "I'm not sure whether this should be Captain chat or a /code task. Please clarify.",
    );
  };

  const parseRouterDecision = (
    finalText: string,
  ): RouterDecision | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(finalText);
    } catch {
      return undefined;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const decision = record.decision;
    if (decision === 'chat') {
      return typeof record.text === 'string' && record.text.trim()
        ? { decision, text: record.text.trim() }
        : undefined;
    }
    if (decision === 'dispatch') {
      return typeof record.playbookId === 'string' &&
        byId.has(record.playbookId) &&
        typeof record.text === 'string' &&
        record.text.trim()
        ? {
            decision,
            playbookId: record.playbookId,
            text: record.text.trim(),
          }
        : undefined;
    }
    if (decision === 'sub') {
      return typeof record.text === 'string' && record.text.trim()
        ? { decision, text: record.text.trim() }
        : undefined;
    }
    if (decision === 'dismiss') {
      return typeof record.text === 'string' && record.text.trim()
        ? { decision, text: record.text.trim() }
        : { decision };
    }
    return undefined;
  };

  const routeHidden = async (
    turn: BossTurn,
    context: CaptainContext,
  ): Promise<void> => {
    const result = await context.callCaptain(
      hiddenRouterEnvelope(turn.prompt),
      { visibility: 'hidden' },
    );
    if (result.status !== 'ok' || result.finalText === undefined) {
      await routerClarification(context);
      return;
    }
    const decision = parseRouterDecision(result.finalText);
    if (!decision) {
      await routerClarification(context);
      return;
    }
    lastRouteDecision = decision.decision;

    if (decision.decision === 'chat') {
      await callVisibleChat(context, decision.text);
      return;
    }

    if (decision.decision === 'dispatch') {
      const entry = byId.get(decision.playbookId);
      if (!entry || (active && active.entry.id !== entry.id)) {
        await routerClarification(context);
        return;
      }
      const engagement = await engage(entry);
      await submitToActive(engagement, decision.text, context);
      return;
    }

    if (decision.decision === 'sub') {
      if (!active) {
        await routerClarification(context);
        return;
      }
      await submitToActive(active, decision.text, context);
      return;
    }

    if (!active) {
      await routerClarification(context);
      return;
    }

    const dismissedCommandLabel = playbookCommandLabel(active.entry);
    await disposeActive('dismiss');
    await callVisibleChat(
      context,
      decision.text ?? `${dismissedCommandLabel} stopped.`,
    );
  };

  const handleRegisteredCommand = async (
    entry: PlaybookCaptainRegistryEntry,
    text: string,
    context: CaptainContext,
  ): Promise<void> => {
    if (active && active.entry.id !== entry.id) {
      await callVisibleChat(
        context,
        `/${active.entry.command} is already running. Finish or stop it before starting /${entry.command}.`,
      );
      return;
    }

    const engagement = await engage(entry);
    if (text.length === 0) {
      await callVisibleChat(
        context,
        `Ask what task to run with /${entry.command}.`,
      );
      return;
    }

    await submitToActive(engagement, text, context);
  };

  return {
    async init(initSession: CaptainSession): Promise<void> {
      session = initSession;
      players = initSession.players;
      for (const entry of entries) {
        entry.validateOptions(options);
      }
      await setMode('chat', 'init');
    },

    async handleBossTurn(
      turn: BossTurn,
      context: CaptainContext,
    ): Promise<void> {
      requireSession();
      activeContext = context;
      try {
        const command = parseRegisteredCommand(turn.prompt);
        if (command !== undefined) {
          const entry = byCommand.get(command.command);
          if (entry) {
            await handleRegisteredCommand(entry, command.text, context);
            return;
          }
        }

        await routeHidden(turn, context);
      } finally {
        activeContext = undefined;
      }
    },

    async dispose(): Promise<void> {
      activeContext = undefined;
      await disposeActive('dispose');
    },
  };
}

export default createPlaybookCaptainShell;
