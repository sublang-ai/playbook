// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';

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
import type {
  PlaybookSummaryPolicy,
  RegistryPlayer,
} from './code.registry.js';

export interface CreatePlaybookRuntimeOptions {
  captainOptions: unknown;
  players: readonly RegistryPlayer[];
}

export interface PlaybookCaptainDeps {
  loadModule?: (specifier: string) => Promise<unknown>;
  createSessionId?: () => string;
}

export interface PlaybookCaptainRegistryEntry {
  id: string;
  command: string;
  intent: string;
  requiredRoleIds: readonly string[];
  idleStateId: string;
  finalStateId: string;
  parkStateIds: readonly string[];
  summaryPolicy?: PlaybookSummaryPolicy;
  validateOptions(captainOptions: unknown): unknown;
  createRuntime(options: CreatePlaybookRuntimeOptions): PlaybookRuntime;
}

// Per-enabled-playbook binding the shell resolves at init from
// `captain.options.playbooks`: each playbook binds its local roles to
// `<id>-<role>` host players and carries the generated visible set.
interface Enablement {
  entry: PlaybookCaptainRegistryEntry;
  command: string;
  optionInput: unknown;
  boundPlayers: readonly RegistryPlayer[];
  hostPlayerId: (localRole: string) => string;
  visiblePlayerIds?: readonly string[];
}

interface ActiveEngagement {
  entry: PlaybookCaptainRegistryEntry;
  enablement: Enablement;
  runtime: PlaybookRuntime;
  sessionId: string;
}

type RouterDecision =
  | { decision: 'chat'; text: string }
  | { decision: 'dispatch'; playbookId: string; text: string }
  | { decision: 'sub'; text: string }
  | { decision: 'dismiss'; text?: string };

type DisposalReason = 'dismiss' | 'final' | 'dispose';

interface ControlLedger {
  activePlaybookId?: string;
  activeSessionId?: string;
  mode: ShellMode;
  latestSubRuntimeStateId?: string;
  pendingBossQuestion?: unknown;
  lastError?: { name: string; message: string };
  lastRouteDecision?: RouterDecision['decision'];
}

type ShellMode = 'chat' | 'engaged.driving' | 'engaged.parked';

const SUB_RUNTIME_FSM_TOPIC = 'playbook.fsm.state';
const SHELL_FSM_TOPIC = 'playbook.captain.fsm.state';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TurnSummaryCounts {
  interruptions: number;
  copyPastes: number;
}

interface ActiveTurnSummary {
  counts: TurnSummaryCounts;
  stateCounts: Map<string, number>;
}

function parseRegisteredCommand(
  prompt: string,
): { command: string; text: string } | undefined {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    prompt.trim(),
  );
  if (!match) return undefined;
  return { command: match[1], text: (match[2] ?? '').trim() };
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
  progressPhrase: string;
  progressRounds: number;
  savedLine: string;
}): string {
  return [
    'You are the Playbook Captain shell.',
    'This is visible Boss chat after a sub-playbook command completed. Do not reveal hidden control JSON, hidden router decisions, or hidden judge replies.',
    'Write a brief, clearly formatted turn-summary block for Boss.',
    'Use a natural, chat-like tone and no more than two short sentences before the saved-counts line.',
    'State only what was done or what changed; do not explain how it was done.',
    'Do not list raw state names, transitions, guard names, prompts, tools, hidden calls, or reasoning.',
    'If progress detail is useful, use only the aggregate progress phrase supplied below.',
    "Do not mention counts for states the active playbook's summary policy does not label.",
    `Then write the saved-counts line exactly: ${input.savedLine}`,
    'Use the exact counts supplied; do not change them.',
    'Do not repeat the exact progress round count outside the saved-counts line.',
    `Playbook: ${input.playbookId}`,
    `Submitted Boss text:\n${input.submittedText}`,
    `Progress counts:\n${input.progressPhrase}`,
    `Counts:\n${JSON.stringify({
      ...input.counts,
      progressRounds: input.progressRounds,
    })}`,
  ].join('\n\n');
}

function stateCountLabel(
  stateId: string,
  entry: PlaybookCaptainRegistryEntry,
): string | undefined {
  if (stateId === entry.idleStateId || stateId === entry.finalStateId) {
    return undefined;
  }
  const registryLabel = entry.summaryPolicy?.stateCountLabels?.[stateId]?.trim();
  return registryLabel || undefined;
}

function pluralizeStateCount(label: string, count: number): string {
  if (count === 1) return `1 ${label}`;
  if (label.endsWith('y')) return `${count} ${label.slice(0, -1)}ies`;
  if (label.endsWith('s')) return `${count} ${label}es`;
  return `${count} ${label}s`;
}

function summaryProgressPhrase(stateCounts: ReadonlyMap<string, number>): string {
  if (stateCounts.size === 0) return 'none';
  return [...stateCounts.entries()]
    .map(([label, count]) => pluralizeStateCount(label, count))
    .join(', ');
}

function summaryProgressRoundCount(stateCounts: ReadonlyMap<string, number>): number {
  return [...stateCounts.values()].reduce((total, count) => total + count, 0);
}

function guardFromJudgeReply(finalText: string): string | undefined {
  return /"guard"\s*:\s*"([^"]+)"/.exec(finalText)?.[1];
}

function isValidRegistryEntry(
  value: unknown,
): value is PlaybookCaptainRegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.command === 'string' &&
    typeof e.intent === 'string' &&
    Array.isArray(e.requiredRoleIds) &&
    typeof e.idleStateId === 'string' &&
    typeof e.finalStateId === 'string' &&
    Array.isArray(e.parkStateIds) &&
    typeof e.validateOptions === 'function' &&
    typeof e.createRuntime === 'function'
  );
}

function readPlaybooksConfig(
  options: unknown,
): Record<string, unknown> | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const pb = (options as Record<string, unknown>).playbooks;
  if (typeof pb !== 'object' || pb === null || Array.isArray(pb)) {
    return undefined;
  }
  return pb as Record<string, unknown>;
}

interface BuiltRegistry {
  entries: readonly PlaybookCaptainRegistryEntry[];
  byCommand: Map<string, PlaybookCaptainRegistryEntry>;
  byId: Map<string, PlaybookCaptainRegistryEntry>;
  enablementById: Map<string, Enablement>;
}

// Resolve the active registry at init from `captain.options.playbooks`
// (CAPTAIN-16): each enabled playbook is loaded from its explicit `from`
// module and bound to namespaced `<id>-<role>` host players.
async function buildEnablements(
  options: unknown,
  players: readonly RegistryPlayer[],
  loadModule: (specifier: string) => Promise<unknown>,
): Promise<BuiltRegistry> {
  const entries: PlaybookCaptainRegistryEntry[] = [];
  const byCommand = new Map<string, PlaybookCaptainRegistryEntry>();
  const byId = new Map<string, PlaybookCaptainRegistryEntry>();
  const enablementById = new Map<string, Enablement>();

  const config = readPlaybooksConfig(options);
  if (config === undefined) {
    throw new Error('captain.options.playbooks is required');
  }

  const ids = Object.keys(config);
  if (ids.length === 0) {
    throw new Error(
      'captain.options.playbooks must enable at least one playbook',
    );
  }
  for (const id of ids) {
    const block = config[id];
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      throw new Error(`captain.options.playbooks.${id} must be an object`);
    }
    const record = block as Record<string, unknown>;
    const from = record.from;
    if (typeof from !== 'string' || from.length === 0) {
      throw new Error(
        `captain.options.playbooks.${id}.from must be a module specifier`,
      );
    }
    let mod: unknown;
    try {
      mod = await loadModule(from);
    } catch (cause) {
      throw new Error(
        `captain.options.playbooks.${id}.from "${from}" failed to import: ${String(
          (cause as { message?: unknown })?.message ?? cause,
        )}`,
      );
    }
    const entry = (mod as { default?: unknown })?.default;
    if (!isValidRegistryEntry(entry)) {
      throw new Error(
        `captain.options.playbooks.${id}.from "${from}" exposes no valid registry entry`,
      );
    }
    if (entry.id !== id) {
      throw new Error(
        `captain.options.playbooks.${id} key must equal the module manifest id "${entry.id}"`,
      );
    }
    if (byId.has(entry.id)) {
      throw new Error(
        `captain.options.playbooks has a duplicate playbook id "${entry.id}"`,
      );
    }
    const command =
      typeof record.command === 'string' && record.command.length > 0
        ? record.command
        : entry.command;
    if (byCommand.has(command)) {
      throw new Error(
        `captain.options.playbooks has a duplicate effective command "${command}"`,
      );
    }
    const boundPlayers = entry.requiredRoleIds.map((role) => {
      const host = players.find((p) => p.id === `${entry.id}-${role}`);
      return { id: role, adapter: host?.adapter, model: host?.model };
    });
    entries.push(entry);
    byId.set(entry.id, entry);
    byCommand.set(command, entry);
    enablementById.set(entry.id, {
      entry,
      command,
      optionInput: record.options,
      boundPlayers,
      hostPlayerId: (localRole) => `${entry.id}-${localRole}`,
      visiblePlayerIds: entry.requiredRoleIds.map(
        (role) => `${entry.id}-${role}`,
      ),
    });
  }
  return { entries, byCommand, byId, enablementById };
}

export function createPlaybookCaptainShell(
  options: unknown,
  deps: PlaybookCaptainDeps = {},
): Captain {
  const loadModule =
    deps.loadModule ?? ((specifier: string) => import(specifier));
  const createSessionId = deps.createSessionId ?? randomUUID;
  let entries: readonly PlaybookCaptainRegistryEntry[] = [];
  let byCommand = new Map<string, PlaybookCaptainRegistryEntry>();
  let byId = new Map<string, PlaybookCaptainRegistryEntry>();
  let enablementById = new Map<string, Enablement>();
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
  const issuedSessionIds = new Set<string>();

  const requireSession = (): CaptainSession => {
    if (!session) {
      throw new Error('init must be called first');
    }
    return session;
  };

  const ledgerSnapshot = (
    playbookId: string | undefined = active?.entry.id,
    activeSessionId: string | undefined = active?.sessionId,
  ): ControlLedger => ({
    ...(playbookId ? { activePlaybookId: playbookId } : {}),
    ...(activeSessionId ? { activeSessionId } : {}),
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
    activeSessionId: string | undefined = active?.sessionId,
  ): Promise<void> => {
    await requireSession().emitTelemetry({
      topic: SHELL_FSM_TOPIC,
      payload: {
        from,
        to,
        event,
        ledger: ledgerSnapshot(playbookId, activeSessionId),
      },
    });
  };

  const setMode = async (
    nextMode: ShellMode,
    event: string,
    playbookId: string | undefined = active?.entry.id,
    activeSessionId: string | undefined = active?.sessionId,
  ): Promise<void> => {
    if (mode === nextMode) return;
    const from = mode;
    mode = nextMode;
    await emitShellTelemetry(
      from,
      nextMode,
      event,
      playbookId,
      activeSessionId,
    );
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

  const mirrorSubRuntimeTelemetry = async (
    engagement: ActiveEngagement,
    payload: unknown,
  ): Promise<void> => {
    if (active !== engagement) return;
    const record = payloadRecord(payload);
    const stateId = mirroredStateId(payload);
    if (stateId === undefined) return;

    const countLabel = stateCountLabel(stateId, engagement.entry);
    if (activeTurnSummary && countLabel) {
      activeTurnSummary.stateCounts.set(
        countLabel,
        (activeTurnSummary.stateCounts.get(countLabel) ?? 0) + 1,
      );
    }

    latestSubRuntimeStateId = stateId;
    pendingBossQuestion = record?.pendingBossQuestion;
    lastError = normalizeErrorCompact(record?.lastError);

    if (stateId === engagement.entry.finalStateId) {
      finalDisposalRequested = engagement;
      return;
    }

    if (
      stateId === engagement.entry.idleStateId ||
      engagement.entry.parkStateIds.includes(stateId)
    ) {
      await setMode('engaged.parked', `sub-runtime:${stateId}`);
    }
  };

  const createPorts = (engagement: ActiveEngagement): PlaybookPorts => ({
    callPlayer: async (playerId, prompt, _signal, options) => {
      if (!activeContext) {
        throw new Error('callPlayer invoked outside a Boss turn');
      }
      const hostPlayerId = engagement.enablement.hostPlayerId(playerId);
      const result = await activeContext.callPlayer(hostPlayerId, prompt, {
        resume: options.resume,
      });
      if (activeTurnSummary) {
        activeTurnSummary.counts.interruptions++;
      }
      return {
        status: result.status,
        resumeToken: result.resumeToken,
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
        engagement.entry.summaryPolicy?.copyPasteGuardNames.includes(guard) &&
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
        await mirrorSubRuntimeTelemetry(engagement, event.payload);
      }
      await requireSession().emitTelemetry(event);
    },
  });

  // CAPTAIN-22: before dispatching to a playbook, request tmux-play
  // visibility for that playbook's generated host players. A pane
  // reconciliation failure is display-only in tmux-play and does not
  // reject; the legacy path carries no generated set and skips this.
  const requestVisibility = async (enablement: Enablement): Promise<void> => {
    const ids = enablement.visiblePlayerIds;
    if (!ids || ids.length === 0 || !activeContext) return;
    await activeContext.setVisiblePlayers(ids);
  };

  const engage = async (
    entry: PlaybookCaptainRegistryEntry,
  ): Promise<ActiveEngagement> => {
    if (active?.entry.id === entry.id) return active;
    const enablement = enablementById.get(entry.id)!;
    const sessionId = createSessionId();
    if (!UUID_PATTERN.test(sessionId)) {
      throw new Error(
        `playbook session id generator returned a non-UUID value: ${JSON.stringify(
          sessionId,
        )}`,
      );
    }
    if (issuedSessionIds.has(sessionId)) {
      throw new Error(`playbook session id collision: ${sessionId}`);
    }
    issuedSessionIds.add(sessionId);
    const runtime = entry.createRuntime({
      captainOptions: enablement.optionInput,
      players: enablement.boundPlayers,
    });
    const engagement = { entry, enablement, runtime, sessionId };
    active = engagement;
    latestSubRuntimeStateId = undefined;
    pendingBossQuestion = undefined;
    lastError = undefined;
    finalDisposalRequested = undefined;
    try {
      await setMode('engaged.parked', 'engage', entry.id);
      await runtime.init({
        sessionId,
        playbookId: entry.id,
        ports: createPorts(engagement),
      });
      await requireSession().emitStatus(`◇ /${enablement.command} started`);
      return engagement;
    } catch (error) {
      if (active === engagement) active = undefined;
      mode = 'chat';
      finalDisposalRequested = undefined;
      latestSubRuntimeStateId = undefined;
      pendingBossQuestion = undefined;
      lastError = undefined;
      try {
        await runtime.dispose();
      } catch {
        // Preserve the initialization failure while still making a
        // best-effort attempt to release partially acquired resources.
      }
      throw error;
    }
  };

  const submitToActive = async (
    engagement: ActiveEngagement,
    text: string,
    context: CaptainContext,
  ): Promise<void> => {
    await requestVisibility(engagement.enablement);
    const policy = engagement.entry.summaryPolicy;
    const summaryCounts: TurnSummaryCounts = {
      interruptions: 0,
      copyPastes: 0,
    };
    const summaryStateCounts = new Map<string, number>();
    let shouldSummarize = false;
    activeTurnSummary = policy
      ? { counts: summaryCounts, stateCounts: summaryStateCounts }
      : undefined;
    await setMode('engaged.driving', 'submit');
    try {
      await engagement.runtime.handleBossInput({
        text,
        signal: context.signal,
      });
      shouldSummarize = policy !== undefined;
    } finally {
      activeTurnSummary = undefined;
      if (active === engagement && finalDisposalRequested === engagement) {
        finalDisposalRequested = undefined;
        await disposeActive('final');
      } else if (active === engagement && mode === 'engaged.driving') {
        await setMode('engaged.parked', 'turn.settled');
      }
    }
    if (shouldSummarize && policy) {
      const progressRounds = summaryProgressRoundCount(summaryStateCounts);
      await callVisibleTurnSummary(context, {
        playbookId: engagement.entry.id,
        submittedText: text,
        counts: summaryCounts,
        progressPhrase: summaryProgressPhrase(summaryStateCounts),
        progressRounds,
        savedLine: policy.savedCountsLine(summaryCounts, progressRounds),
      });
    }
  };

  const disposeActive = async (
    reason: DisposalReason,
  ): Promise<void> => {
    const engagement = active;
    if (!engagement) return;
    const playbookId = engagement.entry.id;
    const sessionId = engagement.sessionId;
    const commandLabel = `/${engagement.enablement.command}`;
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
    await setMode('chat', reason, playbookId, sessionId);
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
      progressPhrase: string;
      progressRounds: number;
      savedLine: string;
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
          command: enablementById.get(entry.id)?.command ?? entry.command,
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

    const dismissedCommandLabel = `/${active.enablement.command}`;
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
    const enablement = enablementById.get(entry.id)!;
    if (active && active.entry.id !== entry.id) {
      await callVisibleChat(
        context,
        `/${active.enablement.command} is already running. Finish or stop it before starting /${enablement.command}.`,
      );
      return;
    }

    const engagement = await engage(entry);
    if (text.length === 0) {
      await requestVisibility(engagement.enablement);
      await callVisibleChat(
        context,
        `Ask what task to run with /${enablement.command}.`,
      );
      return;
    }

    await submitToActive(engagement, text, context);
  };

  return {
    async init(initSession: CaptainSession): Promise<void> {
      session = initSession;
      players = initSession.players;
      const built = await buildEnablements(options, players, loadModule);
      entries = built.entries;
      byCommand = built.byCommand;
      byId = built.byId;
      enablementById = built.enablementById;
      for (const enablement of enablementById.values()) {
        enablement.entry.validateOptions(enablement.optionInput);
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

    async prepareDispose(): Promise<void> {
      activeContext = undefined;
      await disposeActive('dispose');
    },

    async dispose(): Promise<void> {
      activeContext = undefined;
      await disposeActive('dispose');
    },
  };
}

export default createPlaybookCaptainShell;
