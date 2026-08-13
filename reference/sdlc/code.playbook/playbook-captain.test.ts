// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import { createEvent } from '@sublang/cligent';
import type { AgentAdapter, AgentEvent, AgentOptions } from '@sublang/cligent';
import type {
  BossTurn,
  Captain,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  CallPlayerOptions,
  PlayerRunResult,
  TmuxPlayRecord,
} from '@sublang/cligent/tmux-play';
import {
  AgentCallSettingsError,
  createTmuxPlayRuntime,
} from '@sublang/cligent/tmux-play';
import type {
  JsonValue,
  PlaybookCallResult,
  PlaybookControlView,
  PlaybookPorts,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
} from '../../../src/runtime.js';
import {
  assertPlaybookCaptainShellSnapshot,
  createPlaybookCaptainShell,
  type PlaybookCaptainDeps,
  type PlaybookCaptainRegistryEntry,
  type PlaybookCaptainShellSnapshot,
} from './playbook-captain.js';
import { codeSavedCountsLine } from './code.registry.js';

type CaptainCallOptions = Parameters<CaptainContext['callCaptain']>[1];

interface StubSession {
  session: CaptainSession;
  statuses: { message: string; data?: unknown }[];
  telemetry: { topic: string; payload: unknown }[];
}

interface StubContext {
  context: CaptainContext;
  controller: AbortController;
  playerCalls: {
    playerId: string;
    prompt: string;
    options: CallPlayerOptions | undefined;
  }[];
  captainCalls: { prompt: string; options?: CaptainCallOptions }[];
  visiblePlayers: string[][];
  /** Captain speech surfaced through cligent `emitReply` (DR-029). */
  replies: string[];
}

type CaptainReply =
  | CaptainRunResult
  | ((
      prompt: string,
      options: CaptainCallOptions | undefined,
    ) => CaptainRunResult);

type CaptainCallHook = (
  prompt: string,
  options: CaptainCallOptions | undefined,
) => void;

const ISOLATED_VISIBLE_CAPTAIN_OPTIONS = {
  visibility: 'visible',
  resume: false,
  allowedTools: [],
} as const;

const DEFAULT_AGENT_SETTINGS = {
  model: { kind: 'provider-default' },
  effort: { kind: 'provider-default' },
} as const;

const ISOLATED_HIDDEN_CAPTAIN_OPTIONS = {
  visibility: 'hidden',
  resume: false,
  allowedTools: [],
  settings: DEFAULT_AGENT_SETTINGS,
} as const;

type HandleHook = (
  runtime: FakeRuntime,
  turn: { text: string; signal: AbortSignal },
) => Promise<PlaybookRunResult | void>;

type ResumeHook = (
  runtime: FakeRuntime,
  input: {
    callId: string;
    result: PlaybookCallResult;
    signal: AbortSignal;
  },
) => Promise<PlaybookRunResult | void>;

type DisposeHook = (runtime: FakeRuntime) => Promise<void>;
type InitHook = (
  runtime: FakeRuntime,
  session: PlaybookSession,
) => Promise<void>;
type RestoreHook = (
  runtime: FakeRuntime,
  session: PlaybookSession,
  snapshot: PlaybookRuntimeSnapshot,
) => Promise<void>;

class FakeRuntime implements PlaybookRuntime {
  ports: PlaybookPorts | undefined;
  session: PlaybookSession | undefined;
  readonly inputs: { text: string; signal: AbortSignal }[] = [];
  readonly resumes: {
    callId: string;
    result: PlaybookCallResult;
    signal: AbortSignal;
  }[] = [];
  initCount = 0;
  restoreCount = 0;
  disposeCount = 0;
  snapshot: PlaybookRuntimeSnapshot | undefined;
  describe?: () => PlaybookControlView;

  constructor(
    private readonly handleHook?: HandleHook,
    private readonly disposeHook?: DisposeHook,
    private readonly initHook?: InitHook,
    private readonly resumeHook?: ResumeHook,
    private readonly restoreHook?: RestoreHook,
  ) {}

  async init(session: PlaybookSession): Promise<void> {
    this.session = session;
    this.ports = session.ports;
    this.initCount += 1;
    await this.initHook?.(this, session);
  }

  async handleBossInput(turn: {
    text: string;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult> {
    this.inputs.push(turn);
    return (await this.handleHook?.(this, turn)) ?? quiescentResult();
  }

  exportSnapshot(): PlaybookRuntimeSnapshot | undefined {
    return this.snapshot;
  }

  async restore(
    session: PlaybookSession,
    snapshot: PlaybookRuntimeSnapshot,
  ): Promise<void> {
    this.session = session;
    this.ports = session.ports;
    this.restoreCount += 1;
    this.snapshot = snapshot;
    session.playerSessions?.restore(snapshot.roleResumeTokens);
    await this.restoreHook?.(this, session, snapshot);
  }

  async resumePlaybookCall(input: {
    callId: string;
    result: PlaybookCallResult;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult> {
    this.resumes.push(input);
    return (await this.resumeHook?.(this, input)) ?? quiescentResult();
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    await this.disposeHook?.(this);
  }
}

async function callPlayerAndCommit(
  runtime: FakeRuntime,
  roleId: string,
  prompt: string,
  signal: AbortSignal,
  resume: string | false,
): Promise<Awaited<ReturnType<PlaybookPorts['callPlayer']>>> {
  if (!runtime.ports) throw new Error('runtime ports missing');
  const result = await runtime.ports.callPlayer(roleId, prompt, signal, {
    resume,
  });
  if (result.resumeToken !== undefined || result.status === 'ok') {
    runtime.session?.playerSessions?.update(roleId, result.resumeToken);
  }
  return result;
}

function playbookState(
  stateId = 'ready',
  options: {
    tags?: readonly string[];
    status?: PlaybookState['status'];
    quiescent?: boolean;
  } = {},
): PlaybookState {
  return {
    value: stateId,
    activeStateIds: [stateId],
    tags: options.tags ?? ['playbook.parked'],
    status: options.status ?? 'active',
    quiescent: options.quiescent ?? true,
    stateId,
  };
}

function quiescentResult(stateId = 'ready'): PlaybookRunResult {
  return { outcome: 'quiescent', state: playbookState(stateId) };
}

function terminalResult(
  stateId = 'done',
  output?: JsonValue,
): PlaybookRunResult {
  return {
    outcome: 'terminal',
    state: playbookState(stateId, {
      tags: [],
      status: 'done',
      quiescent: true,
    }),
    ...(output !== undefined ? { output } : {}),
  };
}

function suspendedResult(input: {
  callId: string;
  playbookId: string;
  childSessionId: string;
}): PlaybookRunResult {
  return {
    outcome: 'suspended',
    state: playbookState('waitingForChild', {
      tags: ['playbook.parked'],
      quiescent: true,
    }),
    pendingCall: input,
  };
}

function runtimeSnapshot(
  playbookId: string,
  state: PlaybookState,
  options: {
    turn?: number;
    roleResumeTokens?: Readonly<Record<string, string>>;
    pendingBossQuestions?: PlaybookRuntimeSnapshot['pendingBossQuestions'];
    suspendedCall?: NonNullable<PlaybookRuntimeSnapshot['suspendedCall']>;
  } = {},
): PlaybookRuntimeSnapshot {
  return {
    schemaVersion: 3,
    playbookId,
    machine: { value: state.value, status: state.status },
    roleResumeTokens: options.roleResumeTokens ?? {},
    sequences: {
      trace: 0,
      turn: options.turn ?? 0,
      judgeCall: 0,
      playerCall: 0,
      playbookCall: options.suspendedCall === undefined ? 0 : 1,
      captainCall: 0,
    },
    state,
    pendingBossQuestions: options.pendingBossQuestions ?? [],
    ...(options.suspendedCall === undefined
      ? {}
      : { suspendedCall: options.suspendedCall }),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function stateTelemetry(
  stateId: string,
  extra: Record<string, unknown> = {},
): { topic: string; payload: Record<string, unknown> } {
  const terminal = stateId === 'done';
  return {
    topic: 'playbook.fsm.state',
    payload: {
      state: playbookState(stateId, {
        tags:
          stateId === 'failed' ||
          stateId === 'awaitBossReply' ||
          stateId === 'ready'
            ? ['playbook.parked']
            : [],
        status: terminal ? 'done' : 'active',
        quiescent:
          terminal ||
          stateId === 'failed' ||
          stateId === 'awaitBossReply' ||
          stateId === 'ready',
      }),
      ...extra,
    },
  };
}

function stubSession(
  players: CaptainSession['players'] = [
    { id: 'coder', adapter: 'claude' },
    { id: 'reviewer', adapter: 'codex' },
  ],
): StubSession {
  const statuses: StubSession['statuses'] = [];
  const telemetry: StubSession['telemetry'] = [];
  return {
    session: {
      signal: new AbortController().signal,
      players,
      emitStatus: async (message, data) => {
        statuses.push({ message, data });
      },
      emitTelemetry: async (event) => {
        telemetry.push({ topic: event.topic, payload: event.payload });
      },
      setVisiblePlayers: async () => {},
    },
    statuses,
    telemetry,
  };
}

// The session Captain's durable calls are identified by the verbatim runtime
// prompt the shell wraps (CAPTAIN-9): the decision call, the parse-resolved
// command reply, and the acting turn's closing reply.
function isDecisionPrompt(prompt: string): boolean {
  return prompt.includes(
    'Select exactly one action from the closed set `respond` | `start` | `switch` | `dismiss` | `deliver` | `runtime`',
  );
}

function isCommandReplyPrompt(prompt: string): boolean {
  return prompt.includes(
    'Boss issued a registered command that produces no action this turn',
  );
}

function isClosingReplyPrompt(prompt: string): boolean {
  return prompt.includes(
    'An action just settled for the current Boss turn',
  );
}

function isSessionCaptainPrompt(prompt: string): boolean {
  return (
    isDecisionPrompt(prompt) ||
    isCommandReplyPrompt(prompt) ||
    isClosingReplyPrompt(prompt)
  );
}

/**
 * The default decision for a test that scripts none: an engaged shell hands
 * ordinary text to its leaf, an idle shell answers in chat. Both are read
 * from the shell-composed ControlView digest in the captured prompt.
 */
function defaultDecision(prompt: string): string {
  return prompt.includes('Active path: none — no playbook is engaged')
    ? JSON.stringify({ action: 'respond', text: 'Nothing is running yet.' })
    : JSON.stringify({ action: 'deliver' });
}

function stubContext(
  captainReplies: CaptainReply[] = [],
  onCaptainCall?: CaptainCallHook,
  options: { omitTokens?: boolean } = {},
): StubContext {
  const controller = new AbortController();
  const playerCalls: StubContext['playerCalls'] = [];
  const captainCalls: StubContext['captainCalls'] = [];
  const visiblePlayers: StubContext['visiblePlayers'] = [];
  const replies: string[] = [];
  let captainIndex = 0;
  let tokenSequence = 0;
  // CAPTAIN-35: a durable `ok` result without a resume token marks the
  // conversation unsynchronized, so the default host pins one per call. A
  // test proving the unsynchronized path opts out with `omitTokens`.
  const withToken = (result: CaptainRunResult): CaptainRunResult =>
    options.omitTokens ||
    result.status !== 'ok' ||
    result.resumeToken !== undefined
      ? result
      : { ...result, resumeToken: `conversation-${++tokenSequence}` };
  return {
    context: {
      signal: controller.signal,
      players: [],
      callPlayer: async (
        playerId,
        prompt,
        options,
      ): Promise<PlayerRunResult> => {
        playerCalls.push({ playerId, prompt, options });
        return {
          status: 'ok',
          playerId,
          turnId: 1,
          finalText: `player ${playerId} done`,
        };
      },
      setVisiblePlayers: async (ids): Promise<void> => {
        visiblePlayers.push([...ids]);
      },
      emitReply: async (text: string): Promise<void> => {
        replies.push(text);
      },
      callCaptain: async (prompt, options): Promise<CaptainRunResult> => {
        captainCalls.push({ prompt, options });
        onCaptainCall?.(prompt, options);
        const scripted = captainReplies[captainIndex++];
        if (typeof scripted === 'function') {
          return withToken(scripted(prompt, options));
        }
        if (scripted) return withToken(scripted);
        if (isDecisionPrompt(prompt)) {
          return withToken({
            status: 'ok',
            turnId: 1,
            finalText: defaultDecision(prompt),
          });
        }
        if (isSessionCaptainPrompt(prompt)) {
          return withToken({
            status: 'ok',
            turnId: 1,
            finalText: 'Done — here is where things stand.',
          });
        }
        return withToken({
          status: 'ok',
          turnId: 1,
          finalText: 'captain done',
        });
      },
    },
    controller,
    playerCalls,
    captainCalls,
    visiblePlayers,
    replies,
  };
}

function fakeCodeEntry(
  handleHook?: HandleHook,
  disposeHook?: DisposeHook,
  initHook?: InitHook,
  resumeHook?: ResumeHook,
  restoreHook?: RestoreHook,
): {
  entry: PlaybookCaptainRegistryEntry;
  validateOptions: ReturnType<typeof vi.fn>;
  createRuntime: ReturnType<typeof vi.fn>;
  runtimes: FakeRuntime[];
} {
  const runtimes: FakeRuntime[] = [];
  const validateOptions = vi.fn((value: unknown) => value);
  const createRuntime = vi.fn(() => {
    const runtime = new FakeRuntime(
      handleHook,
      disposeHook,
      initHook,
      resumeHook,
      restoreHook,
    );
    runtimes.push(runtime);
    return runtime;
  });
  return {
    entry: {
      id: 'code',
      command: 'code',
      intent: 'software development / SDLC coding workflow',
      artifactSchema: 2,
      requiredRoleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [],
      summaryPolicy: {
        copyPasteGuardNames: ['hasFindings', 'changesMadeSpecs', 'accepted'],
        stateCountLabels: {
          reviewBossCommitCode: 'review round',
          reviewChangesAndChallengesSpecs: 'review round',
          adjudicateChallenges: 'rebuttal',
        },
        savedCountsLine: codeSavedCountsLine,
      },
      validateOptions,
      createRuntime,
    },
    validateOptions,
    createRuntime,
    runtimes,
  };
}

function fakePlaybookEntry(
  id: string,
  command: string,
  handleHook?: HandleHook,
  disposeHook?: DisposeHook,
  initHook?: InitHook,
  resumeHook?: ResumeHook,
  restoreHook?: RestoreHook,
): ReturnType<typeof fakeCodeEntry> {
  const registry = fakeCodeEntry(
    handleHook,
    disposeHook,
    initHook,
    resumeHook,
    restoreHook,
  );
  registry.entry.id = id;
  registry.entry.command = command;
  registry.entry.intent = `${id} playbook`;
  return registry;
}

type TestTuning =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'provider-default' };

interface TestSessionAgent {
  readonly adapter: string;
  readonly model: TestTuning;
  readonly effort:
    | { readonly kind: 'value'; readonly value: 'low' | 'medium' | 'high' }
    | { readonly kind: 'provider-default' };
  readonly instruction?: string;
  readonly permissions?: { readonly fileWrite?: 'allow' | 'ask' | 'deny' };
}

/**
 * A stand-in session Captain: it receives every Boss turn like the compiled
 * controller does, and, with no scripted hook, executes the host's own
 * deterministic parse resolution through the controller port (CAPTAIN-7).
 */
function fakeSessionCaptain(
  handleHook?: HandleHook,
  resumeHook?: ResumeHook,
  disposeHook?: DisposeHook,
  restoreHook?: RestoreHook,
) {
  const runtimes: FakeRuntime[] = [];
  const ports: {
    controller?: {
      submit: (selection: unknown, signal: AbortSignal) => Promise<unknown>;
      resolveParsedTurn?: (text: string) => unknown;
    };
  } = {};
  const parseDrivenHook: HandleHook = async (_runtime, runtimeTurn) => {
    const resolution = ports.controller?.resolveParsedTurn?.(
      runtimeTurn.text,
    ) as { kind?: string; decision?: unknown } | undefined;
    if (resolution?.kind === 'action') {
      const decision = resolution.decision as {
        action: string;
        playbookId?: string;
        input?: string;
      };
      await ports.controller!.submit(
        decision.action === 'deliver'
          ? { action: 'deliver' }
          : {
              action: decision.action,
              playbookId: decision.playbookId,
              input: decision.input,
            },
        runtimeTurn.signal,
      );
    }
    return quiescentResult();
  };
  const createCaptainRuntime = vi.fn(
    (
      options: Parameters<
        NonNullable<PlaybookCaptainDeps['createCaptainRuntime']>
      >[0],
    ) => {
      ports.controller = options.controller as typeof ports.controller;
      const runtime = new FakeRuntime(
        handleHook ?? parseDrivenHook,
        disposeHook,
        undefined,
        resumeHook,
        restoreHook,
      );
      runtimes.push(runtime);
      return runtime;
    },
  );
  return { createCaptainRuntime, runtimes, ports };
}

// Construct the shell through the `captain.options.playbooks` enablement
// path with an injected loader returning the fake entry/entries.
function makeShell(
  entries:
    | ReturnType<typeof fakeCodeEntry>
    | ReturnType<typeof fakeCodeEntry>[],
  opts: {
    options?: unknown;
    sessionIds?: string[];
    commands?: Readonly<Record<string, string>>;
    createCaptainRuntime?: PlaybookCaptainDeps['createCaptainRuntime'];
    // CAPTAIN-33: the launcher-supplied captain adapter (DR-013 A1).
    captainAdapter?: string;
    captainAgent?: TestSessionAgent;
    rolePlayerIds?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    roleTunings?: Readonly<
      Record<
        string,
        Readonly<Record<string, Pick<TestSessionAgent, 'model' | 'effort'>>>
      >
    >;
    playerAgents?: Readonly<Record<string, TestSessionAgent>>;
    loadModule?: (specifier: string) => Promise<unknown>;
  } = {},
) {
  const list = Array.isArray(entries) ? entries : [entries];
  const modules: Record<string, unknown> = {};
  const playbooks: Record<string, unknown> = {};
  const defaultPlayerAgents: Record<string, unknown> = {};
  for (const r of list) {
    const from = `test://${r.entry.id}`;
    modules[from] = { default: r.entry };
    const roles = Object.fromEntries(
      r.entry.requiredRoleIds.map((role) => {
        const playerId =
          opts.rolePlayerIds?.[r.entry.id]?.[role] ??
          `${list.find((candidate) => candidate.entry.requiredRoleIds.includes(role))!.entry.id}-${role}`;
        defaultPlayerAgents[playerId] ??= {
          adapter: role === 'reviewer' ? 'codex' : 'claude',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        };
        return [
          role,
          {
            playerId,
            model:
              opts.roleTunings?.[r.entry.id]?.[role]?.model ??
              { kind: 'provider-default' },
            effort:
              opts.roleTunings?.[r.entry.id]?.[role]?.effort ??
              { kind: 'provider-default' },
          },
        ];
      }),
    );
    playbooks[r.entry.id] = {
      from,
      ...(opts.commands?.[r.entry.id]
        ? { command: opts.commands[r.entry.id] }
        : {}),
      roles,
      options: opts.options ?? {},
    };
  }
  let sessionSequence = 0;
  const sessionIds = opts.sessionIds;
  // CAPTAIN-16/26: the session Captain takes its own previously unissued id at
  // `init`, before any engagement, so injected engagement ids keep their
  // meaning.
  let captainIdIssued = false;
  return createPlaybookCaptainShell(
    {
      playbooks,
      sessionAgents: {
        captain: opts.captainAgent ?? {
          adapter: opts.captainAdapter ?? 'claude',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        },
        players: opts.playerAgents ?? defaultPlayerAgents,
      },
      captainAdapter:
        opts.captainAgent?.adapter ?? opts.captainAdapter ?? 'claude',
    },
    {
      loadModule: async (specifier: string) => {
        if (opts.loadModule) return opts.loadModule(specifier);
        if (specifier in modules) return modules[specifier];
        throw new Error(`no module ${specifier}`);
      },
      createSessionId: () => {
        if (!captainIdIssued) {
          captainIdIssued = true;
          return SESSION_CAPTAIN_ID;
        }
        return (
          sessionIds?.shift() ??
          `00000000-0000-4000-8000-${String(++sessionSequence).padStart(12, '0')}`
        );
      },
      ...(opts.createCaptainRuntime
        ? { createCaptainRuntime: opts.createCaptainRuntime }
        : {}),
    },
  );
}

const SESSION_CAPTAIN_ID = '00000000-0000-4000-8000-0000000000ff';

function turn(prompt: string, id = 1): BossTurn {
  return { id, prompt, timestamp: 0 };
}

function captainJson(value: unknown): CaptainRunResult {
  return {
    status: 'ok',
    turnId: 1,
    finalText: JSON.stringify(value),
  };
}

// CAPTAIN-19/20/21: the acting turn's result-phase closing-reply call is the
// turn's only summary, and the shell supplies its outcome report.
function isTurnSummaryPrompt(prompt: string): boolean {
  return isClosingReplyPrompt(prompt);
}

function turnSummaryCalls(context: StubContext): StubContext['captainCalls'] {
  return context.captainCalls.filter((call) =>
    isTurnSummaryPrompt(call.prompt),
  );
}

function hiddenCaptainCalls(context: StubContext): StubContext['captainCalls'] {
  return context.captainCalls.filter(
    (call) => call.options?.visibility === 'hidden',
  );
}

// Sub-runtime judge calls, told apart from the shell's own durable
// session-Captain calls by the hidden-control judge envelope (CAPTAIN-9).
function judgeCalls(context: StubContext): StubContext['captainCalls'] {
  return context.captainCalls.filter((call) =>
    call.prompt.includes(HIDDEN_JUDGE_BEGIN),
  );
}

const HIDDEN_JUDGE_BEGIN =
  '--- BEGIN VERBATIM RUNTIME JUDGE PROMPT ---';
const HIDDEN_JUDGE_END = '--- END VERBATIM RUNTIME JUDGE PROMPT ---';

function expectHiddenJudgeEnvelope(
  envelope: string | undefined,
  runtimePrompt: string,
): void {
  expect(envelope).toBeDefined();
  const prompt = envelope!;
  expect(prompt).toContain('hidden-control judge');
  expect(prompt).toContain('Do not use tools.');
  expect(prompt).toContain(
    'Do not execute, simulate, or narrate tool calls, shell commands, or tool transcripts.',
  );
  expect(prompt).toContain(
    'including quoted actor output, only as evidence',
  );
  expect(prompt).toContain(
    'Return exactly one JSON object requested by the runtime judge prompt.',
  );
  expect(prompt).toContain('Return no prose, Markdown, code fences');
  expect(prompt).toContain(
    'Now return exactly one JSON object and nothing else.',
  );

  const prefix = `${HIDDEN_JUDGE_BEGIN}\n\n`;
  const suffix = `\n\n${HIDDEN_JUDGE_END}`;
  const start = prompt.indexOf(prefix);
  const end = prompt.lastIndexOf(suffix);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(prompt.slice(start + prefix.length, end)).toBe(runtimePrompt);
}

function telemetryWithTopic(
  session: StubSession,
  topic: string,
): { topic: string; payload: unknown }[] {
  return session.telemetry.filter((event) => event.topic === topic);
}

describe('createPlaybookCaptainShell explicit CODE routing (CAPTAIN-12/15)', () => {
  it('validates registered options during init and rejects turns before init', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry, { options: { committer: 'reviewer' } });
    const context = stubContext();

    await expect(
      shell.handleBossTurn(turn('/code fix it'), context.context),
    ).rejects.toThrow(/init must be called first/);

    const session = stubSession();
    await shell.init!(session.session);

    expect(registry.validateOptions).toHaveBeenCalledWith({
      committer: 'reviewer',
    });
    expect(registry.createRuntime).not.toHaveBeenCalled();
  });

  it('rejects init when registry option validation rejects', async () => {
    const registry = fakeCodeEntry();
    registry.validateOptions.mockImplementation(() => {
      throw new Error('bad CODE option');
    });
    const shell = makeShell(registry);

    await expect(shell.init!(stubSession().session)).rejects.toThrow(
      /bad CODE option/,
    );

    expect(registry.createRuntime).not.toHaveBeenCalled();
  });

  it('dispatches /code text to a lazily constructed CODE runtime', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession([
      { id: 'code-coder', adapter: 'claude' },
      { id: 'code-reviewer', adapter: 'codex' },
    ]);
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(
      turn('/code fix the failing test'),
      context.context,
    );

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.createRuntime).toHaveBeenCalledWith({});
    expect(registry.runtimes[0]?.initCount).toBe(1);
    expect(registry.runtimes[0]?.inputs).toEqual([
      {
        text: 'fix the failing test',
        signal: context.controller.signal,
      },
    ]);
    expect(session.statuses[0]).toEqual({
      message: '◇ /code started',
      data: undefined,
    });
  });

  // CAPTAIN-7: a bare enabled command resolves to `respond` only — status or
  // clarification, never a start or restart.
  it('answers a bare /code as captain speech without engaging', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'CODE is not running yet.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code'), context.context);

    expect(registry.createRuntime).not.toHaveBeenCalled();
    expect(context.captainCalls).toHaveLength(1);
    expect(context.captainCalls[0]?.options).toEqual(
      ISOLATED_HIDDEN_CAPTAIN_OPTIONS,
    );
    expect(context.captainCalls[0]?.prompt).toContain(
      'Boss issued a registered command that produces no action this turn',
    );
    expect(context.replies).toEqual(['CODE is not running yet.']);
    expect(session.statuses).toEqual([]);
  });

  it('continues the existing CODE runtime for same-playbook /code text', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('/code second task', 2), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'first task',
      'second task',
    ]);
  });
});

describe('createPlaybookCaptainShell internal Captain and lifecycle routing', () => {
  it('ignores idle whitespace without allocating a call, session, or telemetry', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeSessionCaptain();
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    // CAPTAIN-16: the session Captain exists from `init`, outside the stack.
    expect(internal.createCaptainRuntime).toHaveBeenCalledTimes(1);
    expect(internal.runtimes[0]?.initCount).toBe(1);

    await shell.handleBossTurn(turn('   \n\t'), context.context);

    expect(internal.runtimes[0]?.inputs).toEqual([]);
    expect(registry.createRuntime).not.toHaveBeenCalled();
    expect(context.captainCalls).toEqual([]);
    expect(context.replies).toEqual([]);
    expect(session.statuses).toEqual([]);
    expect(session.telemetry).toEqual([]);
  });

  // CAPTAIN-33 (DR-013 A1): the adapter-conditional tool posture over the
  // durable session-Captain calls. An empty allowlist means "no tools" and is
  // distinct from omission, which grants the adapter's full native tool
  // surface, so it is requested only where the adapter can enforce it.
  it.each([
    { label: 'no captainAdapter', captainAdapter: undefined, enforced: true },
    { label: 'an enforcing adapter', captainAdapter: 'claude', enforced: true },
    {
      label: 'an unrecognized adapter',
      captainAdapter: 'future-agent',
      enforced: true,
    },
    {
      label: 'an adapter that cannot enforce it',
      captainAdapter: 'codex',
      enforced: false,
    },
  ])(
    'resolves the control-call tool posture for $label',
    async ({ captainAdapter, enforced }) => {
      const registry = fakeCodeEntry();
      delete registry.entry.summaryPolicy;
      const shell = makeShell(registry, {
        ...(captainAdapter === undefined ? {} : { captainAdapter }),
      });
      const session = stubSession();
      const context = stubContext([
        // The parse-resolved start's closing reply, then the decision call.
        { status: 'ok', turnId: 1, finalText: 'Started CODE on the task.' },
        captainJson({ action: 'dismiss' }),
        { status: 'ok', turnId: 1, finalText: 'Stopped CODE.' },
      ]);

      await shell.init!(session.session);
      await shell.handleBossTurn(turn('/code first task'), context.context);
      await shell.handleBossTurn(turn('dismiss this', 2), context.context);

      expect(context.captainCalls).toHaveLength(3);
      for (const call of context.captainCalls) {
        expect(call.options?.visibility).toBe('hidden');
      }
      const options = context.captainCalls[0]?.options;
      expect(options).toEqual(
        enforced
          ? ISOLATED_HIDDEN_CAPTAIN_OPTIONS
          : // Cligent's Codex adapter rejects any tool list outright, so
            // requesting one would fail the control call before the model.
            {
              visibility: 'hidden',
              resume: false,
              settings: DEFAULT_AGENT_SETTINGS,
            },
      );
      // An empty allowlist means "no tools" and is distinct from omission,
      // which grants the adapter's full native tool surface. `toEqual`
      // ignores an explicitly-undefined key, so assert presence directly.
      expect(
        options !== undefined && Object.hasOwn(options, 'allowedTools'),
      ).toBe(enforced);
    },
  );

  // CAPTAIN-16: the session Captain is constructed at `init` with the
  // sanitized catalog and the host controller port, outside the stack.
  it('constructs the session Captain at init with the sanitized catalog and the controller port', async () => {
    const code = fakeCodeEntry();
    const docs = fakePlaybookEntry('docs', 'docs');
    const internal = fakeSessionCaptain();
    const shell = makeShell([code, docs], {
      commands: { code: 'dev' },
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);

    const captainOptions = internal.createCaptainRuntime.mock.calls[0]?.[0];
    expect(captainOptions?.enabledPlaybooks).toEqual([
      {
        id: 'code',
        command: 'dev',
        intent: 'software development / SDLC coding workflow',
      },
      { id: 'docs', command: 'docs', intent: 'docs playbook' },
    ]);
    expect(Object.isFrozen(captainOptions?.enabledPlaybooks)).toBe(true);
    expect(
      captainOptions?.enabledPlaybooks?.every((entry) => Object.isFrozen(entry)),
    ).toBe(true);
    expect(typeof captainOptions?.controller?.submit).toBe('function');
    expect(typeof captainOptions?.controller?.resolveParsedTurn).toBe(
      'function',
    );
    // The session Captain holds no engagement frame and starts no playbook.
    expect(code.createRuntime).not.toHaveBeenCalled();
    expect(docs.createRuntime).not.toHaveBeenCalled();
    expect(internal.runtimes[0]?.session?.playbookId).toBe('captain');
    expect(internal.runtimes[0]?.session?.depth).toBe(0);
    expect(internal.runtimes[0]?.session?.sessionId).toBe(SESSION_CAPTAIN_ID);

    await shell.handleBossTurn(turn('please coordinate this work'), context.context);
    expect(internal.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'please coordinate this work',
    ]);
  });

  it('keeps internal Captain state status hidden while retaining telemetry', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeSessionCaptain(async (runtime) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitStatus('Entered internalRouting', {
        stateId: 'internalRouting',
        privateData: 'must stay hidden',
      });
      await runtime.ports.emitTelemetry(stateTelemetry('internalRouting'));
      return quiescentResult();
    });
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();

    await shell.init!(session.session);
    await shell.handleBossTurn(
      turn('coordinate privately'),
      stubContext().context,
    );

    expect(session.statuses).not.toContainEqual({
      message: 'Entered internalRouting',
      data: {
        stateId: 'internalRouting',
        privateData: 'must stay hidden',
      },
    });
    expect(telemetryWithTopic(session, 'playbook.fsm.state')).toEqual([
      stateTelemetry('internalRouting'),
    ]);
  });

  it('treats an unregistered slash near-miss as internal Captain input', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeSessionCaptain();
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/cod fix the issue'), context.context);

    expect(internal.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      '/cod fix the issue',
    ]);
    expect(registry.createRuntime).not.toHaveBeenCalled();
  });

  // CAPTAIN-9: the decision envelope carries the exact Boss text and the two
  // shell-composed digests and no shell ledger, session id, or call id.
  it('keeps shell ledger identity out of the decision envelope', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry, {
      sessionIds: ['20000000-0000-4000-8000-000000000001'],
    });
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Started CODE.' },
      captainJson({ action: 'deliver' }),
      { status: 'ok', turnId: 1, finalText: 'Handed it over.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code coordinate first'), context.context);
    await shell.handleBossTurn(
      turn('continue coordinating', 2),
      context.context,
    );

    const decision = context.captainCalls.find((call) =>
      isDecisionPrompt(call.prompt),
    );
    expect(decision?.prompt).toContain('[Boss message]\ncontinue coordinating');
    expect(decision?.prompt).toContain('[ControlView digest]');
    expect(decision?.prompt).toContain('[Catalog digest]');
    expect(decision?.prompt).not.toContain('activePlaybookId');
    expect(decision?.prompt).not.toContain('stackDepth');
    expect(decision?.prompt).not.toContain(
      '20000000-0000-4000-8000-000000000001',
    );
    expect(decision?.prompt).not.toContain(SESSION_CAPTAIN_ID);
    expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'coordinate first',
      'continue coordinating',
    ]);
  });

  // CAPTAIN-34/35: a session-Captain boundary failure settles the turn with a
  // Boss-appropriate reply naming a concrete next step, leaves the stack
  // untouched, and keeps the raw diagnostic off every Boss-visible surface.
  it('settles a failed session-Captain turn with a Boss-appropriate reply and keeps the stack', async () => {
    const registry = fakeCodeEntry();
    const rawFailure = new Error(
      'adjudicator selected undeclared guard undefined',
    );
    let failNext = true;
    const internal = fakeSessionCaptain(async (_runtime, runtimeTurn) => {
      if (failNext) {
        failNext = false;
        throw rawFailure;
      }
      const resolution = internal.ports.controller?.resolveParsedTurn?.(
        runtimeTurn.text,
      ) as { kind?: string; decision?: { action: string; playbookId?: string; input?: string } } | undefined;
      if (resolution?.kind === 'action' && resolution.decision) {
        await internal.ports.controller!.submit(
          {
            action: resolution.decision.action,
            playbookId: resolution.decision.playbookId,
            input: resolution.decision.input,
          },
          runtimeTurn.signal,
        );
      }
      return quiescentResult();
    });
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await expect(
      shell.handleBossTurn(turn('hello, what can you do?'), context.context),
    ).rejects.toBe(rawFailure);

    expect(context.replies).toHaveLength(1);
    const reply = context.replies[0]!;
    expect(reply).toMatch(/send the request again/i);
    expect(reply).toContain('/code');
    expect(reply).not.toMatch(/adjudicator|guard|undeclared|hidden/i);
    // No visible chat call carried the diagnostic, and the stack is untouched.
    expect(context.captainCalls).toHaveLength(0);
    expect(registry.createRuntime).not.toHaveBeenCalled();

    await shell.handleBossTurn(turn('/code fix the parser', 2), context.context);
    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'fix the parser',
    ]);
  });

  // CAPTAIN-35: an external root's failed delivery keeps its recoverable
  // frame and returns the failure through the Captain result phase.
  it('retains a failed external root and reports its boundary error', async () => {
    const rawFailure = new Error('code runtime control failure');
    let turns = 0;
    const registry = fakeCodeEntry(async () => {
      turns += 1;
      if (turns === 2) throw rawFailure;
      return quiescentResult();
    });
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code do the work'), context.context);
    const repliesBefore = context.replies.length;
    await expect(
      shell.handleBossTurn(turn('/code keep going', 2), context.context),
    ).resolves.toBeUndefined();
    expect(registry.runtimes[0]?.disposeCount).toBe(0);
    expect(context.replies).toHaveLength(repliesBefore + 1);
    const failurePrompt = turnSummaryCalls(context).at(-1)?.prompt ?? '';
    expect(failurePrompt).toContain('Settlement status: failed');
    expect(failurePrompt).toContain(rawFailure.message);

    await shell.handleBossTurn(turn('/code try again', 3), context.context);
    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'do the work',
      'keep going',
      'try again',
    ]);
  });

  // CAPTAIN-11/29: `callPlaybook` is not reachable from the session Captain,
  // and an unknown child target rejects from a working playbook.
  it('keeps callPlaybook unreachable from the session Captain and rejects unknown child targets', async () => {
    const internal = fakeSessionCaptain(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await expect(
        runtime.ports.callPlaybook(
          { callId: 'captain:self:1', playbookId: 'captain', text: 'recurse' },
          runtimeTurn.signal,
        ),
      ).rejects.toThrow('never calls a playbook');
      if (runtimeTurn.text === 'kick off the work') {
        await internal.ports.controller!.submit(
          {
            action: 'start',
            playbookId: 'code',
            input: 'do the work',
          },
          runtimeTurn.signal,
        );
      }
      return quiescentResult();
    });
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await expect(
        runtime.ports.callPlaybook(
          {
            callId: 'code:unknown:1',
            playbookId: 'missing',
            text: 'delegate',
          },
          runtimeTurn.signal,
        ),
      ).rejects.toThrow('playbook "missing" is not enabled');
      return quiescentResult();
    });
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('coordinate this'), context.context);
    // A Captain-composed `start` passes its own text through, distinguishable
    // from Boss text in the settlement facts (CAPTAIN-7).
    await shell.handleBossTurn(turn('kick off the work', 2), context.context);

    expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'do the work',
    ]);
  });

  it('serializes sub-runtime Captain and judge calls through one queue', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const callOrder: string[] = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await Promise.all([
        runtime.ports.callCaptain(
          'visible workflow call',
          runtimeTurn.signal,
          ISOLATED_VISIBLE_CAPTAIN_OPTIONS,
        ),
        runtime.ports.callJudge('hidden judge call', runtimeTurn.signal),
      ]);
      return quiescentResult();
    });
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();
    let calls = 0;
    context.context.callCaptain = async (prompt, options) => {
      calls += 1;
      callOrder.push(`${options?.visibility ?? 'visible'}:${prompt}`);
      if (calls === 1) {
        firstStarted.resolve(undefined);
        await releaseFirst.promise;
      }
      return {
        status: 'ok',
        turnId: calls,
        finalText: 'done',
        resumeToken: `conversation-${calls}`,
      };
    };

    await shell.init!(session.session);
    const running = shell.handleBossTurn(
      turn('/code handle directly'),
      context.context,
    );
    await firstStarted.promise;
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst.resolve(undefined);
    await running;

    // The two runtime calls, then the shell's own closing-reply call.
    expect(callOrder).toHaveLength(3);
    expect(callOrder[0]).toBe('visible:visible workflow call');
    expect(callOrder[1]).toMatch(/^hidden:/);
    expectHiddenJudgeEnvelope(
      callOrder[1]?.slice('hidden:'.length),
      'hidden judge call',
    );
    expect(callOrder[2]).toMatch(/^hidden:/);
  });

  it('keeps an aborted running Captain call in the queue until its host settles', async () => {
    const firstStarted = deferred<void>();
    const secondQueued = deferred<void>();
    const releaseFirst = deferred<void>();
    let hostCalls = 0;
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      const narrow = new AbortController();
      const first = runtime.ports.callJudge('first', narrow.signal);
      await firstStarted.promise;
      narrow.abort(new DOMException('sibling stopped', 'AbortError'));
      const second = runtime.ports.callJudge('second', runtimeTurn.signal);
      secondQueued.resolve(undefined);
      await Promise.allSettled([first, second]);
      return quiescentResult();
    });
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();
    context.context.callCaptain = async () => {
      hostCalls += 1;
      if (hostCalls === 1) {
        firstStarted.resolve(undefined);
        await releaseFirst.promise;
      }
      return {
        status: 'ok',
        turnId: hostCalls,
        finalText: 'done',
        resumeToken: `conversation-${hostCalls}`,
      };
    };

    await shell.init!(session.session);
    const running = shell.handleBossTurn(
      turn('/code route'),
      context.context,
    );
    await secondQueued.promise;
    await Promise.resolve();
    expect(hostCalls).toBe(1);

    releaseFirst.resolve(undefined);
    await running;
    // The two judge calls plus the shell's closing-reply call.
    expect(hostCalls).toBe(3);
  });

  // CAPTAIN-19/21: the acting turn's closing reply runs after the action's
  // ordered emissions settle, serialized behind unfinished runtime work.
  it('serializes the closing reply behind unfinished runtime Captain work', async () => {
    const runtimeCallStarted = deferred<void>();
    const releaseRuntimeCall = deferred<void>();
    const callOrder: string[] = [];
    let runtimeCall: Promise<unknown> | undefined;
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      runtimeCall = runtime.ports.callCaptain(
        'unfinished runtime Captain work',
        runtimeTurn.signal,
        {
          visibility: 'visible',
          resume: 'runtime-owned-session',
          allowedTools: ['Read'],
        },
      );
      void runtimeCall.catch(() => undefined);
      return quiescentResult();
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();
    context.context.callCaptain = async (prompt, options) => {
      callOrder.push(`${options?.visibility ?? 'visible'}:${prompt}`);
      if (prompt === 'unfinished runtime Captain work') {
        runtimeCallStarted.resolve(undefined);
        await releaseRuntimeCall.promise;
      }
      return {
        status: 'ok',
        turnId: callOrder.length,
        finalText: 'The round is set up and CODE is running.',
        resumeToken: `conversation-${callOrder.length}`,
      };
    };

    await shell.init!(session.session);
    const running = shell.handleBossTurn(
      turn('/code summarize after runtime work'),
      context.context,
    );
    await runtimeCallStarted.promise;
    await Promise.resolve();
    expect(callOrder).toHaveLength(1);

    releaseRuntimeCall.resolve(undefined);
    await running;
    await runtimeCall;

    expect(callOrder).toHaveLength(2);
    expect(callOrder[0]).toBe('visible:unfinished runtime Captain work');
    expect(callOrder[1]).toContain(
      'An action just settled for the current Boss turn',
    );
    expect(context.replies).toEqual([
      'The round is set up and CODE is running.',
    ]);
  });

  // CAPTAIN-3/11: the session Captain is never an engagement and emits none of
  // the lifecycle status lines, however many turns it settles.
  it('emits no lifecycle status for the session Captain across turns', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeSessionCaptain(async () => quiescentResult());
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('first intent'), context.context);
    await shell.handleBossTurn(turn('second intent', 2), context.context);

    // One session Captain for the whole shell session, never reconstructed.
    expect(internal.createCaptainRuntime).toHaveBeenCalledTimes(1);
    expect(internal.runtimes[0]?.disposeCount).toBe(0);
    expect(session.statuses).toEqual([]);

    await shell.prepareDispose!();
    expect(internal.runtimes[0]?.disposeCount).toBe(1);
  });

  // CAPTAIN-7/8/13: a validated `deliver` hands the shell-authoritative Boss
  // text to the leaf, ignoring any text the selection carries.
  it('delivers the original Boss text to the active runtime', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Started CODE.' },
      captainJson({ action: 'deliver', text: 'a divergent restatement' }),
      { status: 'ok', turnId: 1, finalText: 'Handed it to CODE.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('continue from here', 2), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    const decision = context.captainCalls.find((call) =>
      isDecisionPrompt(call.prompt),
    );
    expect(decision?.options).toEqual({
      visibility: 'hidden',
      resume: 'conversation-1',
      allowedTools: [],
      settings: DEFAULT_AGENT_SETTINGS,
    });
    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'first task',
      'continue from here',
    ]);
    // No hidden lifecycle classification call exists.
    expect(
      context.captainCalls.some((call) =>
        call.prompt.includes('lifecycle classifier'),
      ),
    ).toBe(false);
  });

  it.each([
    {
      label: 'malformed reply',
      result: { status: 'ok', turnId: 1, finalText: 'not json' },
    },
    {
      label: 'non-ok reply',
      result: { status: 'error', turnId: 1, error: 'classifier unavailable' },
    },
    {
      label: 'ok reply without text',
      result: { status: 'ok', turnId: 1 },
    },
    {
      label: 'unknown decision',
      result: captainJson({ decision: 'replace', text: 'do something else' }),
    },
  ] satisfies { label: string; result: CaptainRunResult }[])(
    'fails open to exact leaf delivery for a $label',
    async ({ result }) => {
      const registry = fakeCodeEntry();
      const shell = makeShell(registry);
      const session = stubSession();
      const context = stubContext([result]);

      await shell.init!(session.session);
      await shell.handleBossTurn(turn('/code first task'), context.context);
      await shell.handleBossTurn(
        turn('exact parked Boss reply', 2),
        context.context,
      );

      expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
        'first task',
        'exact parked Boss reply',
      ]);
    },
  );

  it('fails open when lifecycle classification throws', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      () => {
        throw new Error('classifier transport failed');
      },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(
      turn('exact reply after classifier failure', 2),
      context.context,
    );

    expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'first task',
      'exact reply after classifier failure',
    ]);
  });

  // CAPTAIN-13/14: `dismiss` executes only as a validated selection, and the
  // Boss sees the shell's own lifecycle line plus the closing reply.
  it('dismisses on a validated selection without visible chat', async () => {
    const registry = fakeCodeEntry();
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Started CODE.' },
      captainJson({ action: 'dismiss' }),
      { status: 'ok', turnId: 1, finalText: 'Stopped CODE for you.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('dismiss this', 2), context.context);

    expect(registry.runtimes[0]?.disposeCount).toBe(1);
    for (const call of context.captainCalls) {
      expect(call.options?.visibility).toBe('hidden');
    }
    expect(session.statuses.map(({ message }) => message)).toEqual([
      '◇ /code started',
      '◇ /code stopped',
    ]);
    expect(context.replies).toEqual([
      'Started CODE.',
      'Stopped CODE for you.',
    ]);
  });
});

describe('createPlaybookCaptainShell lifecycle and telemetry (CAPTAIN-11/14)', () => {
  it('mirrors idle telemetry without disclosing its ledger to lifecycle classification', async () => {
    const registry = fakeCodeEntry(async (runtime) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry(
        stateTelemetry('ready', { event: { type: 'xstate.done' } }),
      );
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Started CODE.' },
      captainJson({ action: 'deliver' }),
      { status: 'ok', turnId: 1, finalText: 'Resumed the round.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('resume it', 2), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'first task',
      'resume it',
    ]);
    const decisionPrompt = context.captainCalls.find((call) =>
      isDecisionPrompt(call.prompt),
    )!.prompt;
    expect(decisionPrompt).not.toContain('"mode":"engaged.parked"');
    expect(decisionPrompt).not.toContain('latestSubRuntimeStateId');
    expect(decisionPrompt).not.toContain('activePlaybookId');
    // The session Captain forwards its own structured telemetry on the same
    // topic, so assert the mirrored sub-runtime event rather than a count.
    expect(telemetryWithTopic(session, 'playbook.fsm.state')).toContainEqual(
      stateTelemetry('ready', { event: { type: 'xstate.done' } }),
    );
    expect(telemetryWithTopic(session, 'playbook.captain.fsm.state')).toEqual(
      expect.arrayContaining([
        {
          topic: 'playbook.captain.fsm.state',
          payload: expect.objectContaining({
            from: 'engaged.driving',
            to: 'engaged.parked',
            event: 'sub-runtime:ready',
            ledger: expect.objectContaining({
              activePlaybookId: 'code',
              mode: 'engaged.parked',
              latestSubRuntimeStateId: 'ready',
            }),
          }),
        },
      ]),
    );
  });

  it('mirrors pending questions and compact errors without disclosing them to lifecycle classification', async () => {
    const pendingBossQuestion = {
      resumeStateId: 'review',
      sourceItem: 'CODE-7',
      player: 'Coder',
      question: 'Which branch should I use?',
    };
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry(
        runtimeTurn.text === 'first task'
          ? stateTelemetry('awaitBossReply', {
              pendingBossQuestions: [pendingBossQuestion],
            })
          : stateTelemetry('failed', {
              lastError: {
                name: 'TypeError',
                message: 'boom',
                stack: 'hidden stack',
              },
            }),
      );
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Started CODE.' },
      captainJson({ action: 'deliver' }),
      { status: 'ok', turnId: 1, finalText: 'Answered the question.' },
      captainJson({ action: 'deliver' }),
      { status: 'ok', turnId: 1, finalText: 'Reported the failure.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('answer question', 2), context.context);
    await shell.handleBossTurn(turn('what happened?', 3), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    const decisionPrompts = context.captainCalls
      .filter((call) => isDecisionPrompt(call.prompt))
      .map((call) => call.prompt);
    expect(decisionPrompts).toHaveLength(2);
    // CAPTAIN-9: this fake leaf ships no control surface, so the shell
    // composes the degraded ControlView digest from the facts it mirrors —
    // the pending question verbatim and the compact `{ name, message }`
    // error — while the raw stack and the shell ledger stay out.
    for (const prompt of decisionPrompts) {
      expect(prompt).toContain('advertises no control surface');
      expect(prompt).not.toContain('hidden stack');
      expect(prompt).not.toContain('stackDepth');
      expect(prompt).not.toContain('latestSubRuntimeStateId');
    }
    expect(decisionPrompts[0]).toContain('Which branch should I use?');
    expect(decisionPrompts[1]).toContain(
      'Last error: {"name":"TypeError","message":"boom"}',
    );
    const shellTelemetry = JSON.stringify(
      telemetryWithTopic(session, 'playbook.captain.fsm.state'),
    );
    expect(shellTelemetry).toContain('"pendingBossQuestions"');
    expect(shellTelemetry).toContain('Which branch should I use?');
    expect(shellTelemetry).toContain(
      '"lastError":{"name":"TypeError","message":"boom"}',
    );
    expect(shellTelemetry).not.toContain('hidden stack');
  });

  it('disposes final engagements and constructs a replacement on later dispatch', async () => {
    const registry = fakeCodeEntry(async (runtime) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry(
        stateTelemetry('done', { event: { type: 'COMPLETE' } }),
      );
      return terminalResult();
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('/code second task', 2), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(2);
    expect(registry.runtimes[0]?.disposeCount).toBe(1);
    expect(registry.runtimes[1]?.inputs.map((input) => input.text)).toEqual([
      'second task',
    ]);
    expect(session.statuses).toContainEqual({
      message: '◇ /code finished',
      data: undefined,
    });
    expect(
      telemetryWithTopic(session, 'playbook.captain.fsm.state').some((event) =>
        JSON.stringify(event.payload).includes('"event":"final"'),
      ),
    ).toBe(true);
  });

  it('dismiss emits shell status and later dispatch constructs a replacement', async () => {
    const registry = fakeCodeEntry();
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Started CODE.' },
      captainJson({ action: 'dismiss' }),
      { status: 'ok', turnId: 1, finalText: 'Stopped CODE.' },
      { status: 'ok', turnId: 1, finalText: 'Started CODE again.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('dismiss this', 2), context.context);
    await shell.handleBossTurn(turn('/code second task', 3), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(2);
    expect(registry.runtimes[0]?.disposeCount).toBe(1);
    expect(registry.runtimes[1]?.inputs.map((input) => input.text)).toEqual([
      'second task',
    ]);
    expect(session.statuses).toContainEqual({
      message: '◇ /code stopped',
      data: undefined,
    });
    expect(context.captainCalls).toHaveLength(4);
    for (const call of context.captainCalls) {
      expect(call.options?.visibility).toBe('hidden');
      expect(call.options?.allowedTools).toEqual([]);
    }
  });

  // CAPTAIN-2/7: an enabled command absent from the active path switches —
  // dismissal then start, in that order — instead of being refused.
  it('switches to a different registered command while CODE is engaged', async () => {
    const code = fakeCodeEntry();
    delete code.entry.summaryPolicy;
    const docs = fakePlaybookEntry('docs', 'docs');
    delete docs.entry.summaryPolicy;
    const shell = makeShell([code, docs]);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('/docs write it up', 2), context.context);

    expect(code.runtimes[0]?.disposeCount).toBe(1);
    expect(docs.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'write it up',
    ]);
    expect(session.statuses.map(({ message }) => message)).toEqual([
      '◇ /code started',
      '◇ /code stopped',
      '◇ /docs started',
    ]);
    // No decision call parsed the command itself.
    expect(
      context.captainCalls.some((call) => isDecisionPrompt(call.prompt)),
    ).toBe(false);
  });

  it('pre-close teardown drains the active runtime exactly once without shell emissions', async () => {
    const registry = fakeCodeEntry(undefined, async (runtime) => {
      await runtime.ports?.emitStatus('dispose emission', { drained: true });
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    const shellStatusMessages = new Set([
      '◇ /code started',
      '◇ /code stopped',
      '◇ /code finished',
    ]);
    const shellStatusCount = session.statuses.filter((status) =>
      shellStatusMessages.has(status.message),
    ).length;
    const shellTelemetryCount = telemetryWithTopic(
      session,
      'playbook.captain.fsm.state',
    ).length;
    await shell.prepareDispose!();
    await shell.dispose!();

    expect(registry.runtimes[0]?.disposeCount).toBe(1);
    expect(session.statuses).toContainEqual({
      message: 'dispose emission',
      data: { drained: true },
    });
    expect(
      session.statuses.filter((status) =>
        shellStatusMessages.has(status.message),
      ),
    ).toHaveLength(shellStatusCount);
    expect(
      telemetryWithTopic(session, 'playbook.captain.fsm.state'),
    ).toHaveLength(shellTelemetryCount);
  });
});

describe('createPlaybookCaptainShell CODE port wrapping (CAPTAIN-10/15)', () => {
  it('reapplies the complete role settings atomically on every player call', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const store = runtime.session?.playerSessions;
      if (!runtime.ports || !store) throw new Error('runtime ports missing');
      const result = await runtime.ports.callPlayer(
        'coder',
        'configured player',
        runtimeTurn.signal,
        { resume: store.select('coder') },
      );
      store.update('coder', result.resumeToken);
    });
    registry.entry.requiredRoleIds = ['coder'];
    const shell = makeShell(registry, {
      rolePlayerIds: { code: { coder: 'dev.coder' } },
      roleTunings: {
        code: {
          coder: {
            model: { kind: 'value', value: 'gpt-5.6-sol' },
            effort: { kind: 'value', value: 'high' },
          },
        },
      },
      playerAgents: {
        'dev.coder': {
          adapter: 'codex',
          model: { kind: 'value', value: 'session-default-model' },
          effort: { kind: 'value', value: 'low' },
          instruction: 'Keep the implementation narrow.',
          permissions: { fileWrite: 'ask' },
        },
      },
    });
    const context = stubContext();

    await shell.init!(stubSession([
      { id: 'dev.coder', adapter: 'codex' },
    ]).session);
    await shell.handleBossTurn(turn('/code implement it'), context.context);

    expect(context.playerCalls).toEqual([
      {
        playerId: 'dev.coder',
        prompt: 'configured player',
        options: {
          resume: false,
          settings: {
            model: { kind: 'value', value: 'gpt-5.6-sol' },
            effort: { kind: 'value', value: 'high' },
            instruction: 'Keep the implementation narrow.',
            permissions: { fileWrite: 'ask' },
          },
        },
      },
    ]);
    expect(context.playerCalls[0]?.options).not.toHaveProperty('model');
    expect(context.playerCalls[0]?.options).not.toHaveProperty('effort');
  });

  it('preserves the prior player token when complete settings reject', async () => {
    const attemptedResumes: Array<string | false> = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const store = runtime.session?.playerSessions;
      if (!runtime.ports || !store) throw new Error('runtime ports missing');
      const resume = store.select('coder');
      attemptedResumes.push(resume);
      const result = await runtime.ports.callPlayer(
        'coder',
        'unsupported retune',
        runtimeTurn.signal,
        { resume },
      );
      store.update('coder', result.resumeToken);
    });
    registry.entry.requiredRoleIds = ['coder'];
    const shell = makeShell(registry);
    const context = stubContext();
    let hostCalls = 0;
    context.context.callPlayer = async (playerId) => {
      hostCalls += 1;
      if (hostCalls === 1) {
        return {
          status: 'ok',
          playerId,
          turnId: 1,
          finalText: 'seeded',
          resumeToken: 'prior-player-token',
        };
      }
      throw new AgentCallSettingsError('provider cannot restore this default');
    };

    await shell.init!(stubSession().session);
    await shell.handleBossTurn(turn('/code seed it'), context.context);
    expect(registry.runtimes[0]?.session?.playerSessions?.select('coder')).toBe(
      'prior-player-token',
    );
    await shell.handleBossTurn(turn('/code retune it', 2), context.context);

    expect(attemptedResumes).toEqual([false, 'prior-player-token']);
    expect(hostCalls).toBe(2);
    expect(registry.runtimes[0]?.session?.playerSessions?.select('coder')).toBe(
      'prior-player-token',
    );
  });

  it('catches the Captain up when an exact player preflight error reaches shell fallback', async () => {
    let playerRejection: unknown;
    const code = fakeCodeEntry(async (runtime, runtimeTurn) => {
      try {
        await runtime.ports!.callPlayer(
          'coder',
          'unsupported player tuning',
          runtimeTurn.signal,
          { resume: runtime.session!.playerSessions!.select('coder') },
        );
      } catch (error) {
        playerRejection = error;
        throw error;
      }
      return quiescentResult();
    });
    delete code.entry.summaryPolicy;
    let captainTurn = 0;
    const captain = fakeSessionCaptain(async (runtime, runtimeTurn) => {
      captainTurn += 1;
      if (captainTurn === 2) {
        await captain.ports.controller!.submit(
          { action: 'start', playbookId: 'code', input: 'trigger rejection' },
          runtimeTurn.signal,
        );
        if (!playerRejection) throw new Error('expected player rejection');
        throw playerRejection;
      }
      await runtime.ports!.callCaptain(
        'Select exactly one action from the closed set `respond` | `start` | `switch` | `dismiss` | `deliver` | `runtime`.',
        runtimeTurn.signal,
        { visibility: 'hidden', resume: false },
      );
      await captain.ports.controller!.submit(
        {
          action: 'respond',
          text: captainTurn === 1 ? 'Pinned.' : 'Caught up.',
        },
        runtimeTurn.signal,
      );
      return quiescentResult();
    });
    const shell = makeShell(code, {
      createCaptainRuntime: captain.createCaptainRuntime,
    });
    const context = stubContext();
    context.context.callPlayer = async () => {
      throw new AgentCallSettingsError('player tuning rejected');
    };

    await shell.init!(stubSession().session);
    await shell.handleBossTurn(turn('pin Captain'), context.context);
    await shell.handleBossTurn(turn('player preflight', 2), context.context);
    await shell.handleBossTurn(turn('recover Captain', 3), context.context);

    expect(context.captainCalls).toHaveLength(2);
    expect(context.captainCalls[1]?.options?.resume).toBe('conversation-1');
    expect(context.captainCalls[1]?.prompt).toContain(
      'This retained conversation missed the host journal records below.',
    );
    expect(context.captainCalls[1]?.prompt).toContain('player preflight');
    expect(context.replies).toEqual([
      'Pinned.',
      expect.stringContaining('action ended with a failure'),
      'Caught up.',
    ]);

    await shell.dispose?.();
  });

  it('publishes player continuation only through the exact validated runtime update', async () => {
    let restoreRejected = false;
    let mismatchedUpdateRejected = false;
    let repeatedUpdateRejected = false;
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const store = runtime.session!.playerSessions!;
      expect(() => store.update('coder', 'unsourced-token')).toThrow(
        /does not acknowledge a validated host result/,
      );
      const result = await runtime.ports!.callPlayer(
        'coder',
        'authorized call',
        runtimeTurn.signal,
        { resume: store.select('coder') },
      );
      try {
        store.restore({ coder: 'forged-by-runtime' });
      } catch (error) {
        restoreRejected = true;
        expect(error).toMatchObject({
          message: expect.stringMatching(/only available during shell restoration/),
        });
      }
      try {
        store.update('reviewer', result.resumeToken);
      } catch (error) {
        mismatchedUpdateRejected = true;
        expect(error).toMatchObject({
          message: expect.stringMatching(/does not acknowledge/),
        });
      }
      expect(store.select('coder')).toBe(false);
      store.update('coder', result.resumeToken);
      try {
        store.update('coder', result.resumeToken);
      } catch (error) {
        repeatedUpdateRejected = true;
        expect(error).toMatchObject({
          message: expect.stringMatching(/does not acknowledge/),
        });
      }
    });
    registry.entry.requiredRoleIds = ['coder', 'reviewer'];
    const shell = makeShell(registry, {
      rolePlayerIds: {
        code: { coder: 'dev.shared', reviewer: 'dev.shared' },
      },
      playerAgents: {
        'dev.shared': {
          adapter: 'claude',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        },
      },
    });
    const context = stubContext();
    let hostCalls = 0;
    context.context.callPlayer = async (playerId) => {
      hostCalls += 1;
      return {
        status: 'ok',
        playerId,
        turnId: 1,
        finalText: 'committable',
        resumeToken: 'authorized-token',
      };
    };

    await shell.init!(stubSession([
      { id: 'dev.shared', adapter: 'claude' },
    ]).session);
    await shell.handleBossTurn(turn('/code commit once'), context.context);

    expect({ restoreRejected, mismatchedUpdateRejected, repeatedUpdateRejected }).toEqual({
      restoreRejected: true,
      mismatchedUpdateRejected: true,
      repeatedUpdateRejected: true,
    });
    expect(hostCalls).toBe(1);
    expect(registry.runtimes[0]?.session?.playerSessions?.snapshot()).toEqual({
      coder: 'authorized-token',
      reviewer: 'authorized-token',
    });
  });

  it('preserves or clears a player token from the validated result semantics', async () => {
    const observed: Array<string | false> = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const store = runtime.session!.playerSessions!;
      for (const prompt of ['pin', 'preserve', 'clear']) {
        const resume = store.select('coder');
        observed.push(resume);
        const result = await runtime.ports!.callPlayer(
          'coder',
          prompt,
          runtimeTurn.signal,
          { resume },
        );
        if (result.resumeToken !== undefined || result.status === 'ok') {
          store.update('coder', result.resumeToken);
        }
      }
      observed.push(store.select('coder'));
    });
    const shell = makeShell(registry);
    const context = stubContext();
    let call = 0;
    context.context.callPlayer = async (playerId) => {
      call += 1;
      if (call === 1) {
        return {
          status: 'ok',
          playerId,
          turnId: call,
          finalText: 'pinned',
          resumeToken: 'player-token',
        };
      }
      return {
        status: call === 2 ? 'error' : 'ok',
        playerId,
        turnId: call,
        ...(call === 2 ? { error: 'no provider result' } : { finalText: 'clear' }),
      };
    };

    await shell.init!(stubSession().session);
    await shell.handleBossTurn(turn('/code result semantics'), context.context);

    expect(observed).toEqual([false, 'player-token', 'player-token', false]);
  });

  it.each([
    'uncommitted',
    'aborted',
    'late',
    'malformed',
    'malformed-optional',
    'unknown-undefined',
    'accessor',
  ] as const)(
    'quarantines a %s player result rather than reusing uncertain continuity',
    async (failure) => {
      const hostStarted = deferred<void>();
      const hostGate = deferred<PlayerRunResult>();
      let portFailure: unknown;
      let turnCount = 0;
      let accessorReads = 0;
      const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
        turnCount += 1;
        const store = runtime.session!.playerSessions!;
        if (turnCount > 1) {
          await runtime.ports!.callPlayer(
            'coder',
            'must stay quarantined',
            runtimeTurn.signal,
            { resume: store.select('coder') },
          );
          return quiescentResult();
        }
        if (failure === 'late') {
          void runtime.ports!
            .callPlayer('coder', 'late call', runtimeTurn.signal, {
              resume: store.select('coder'),
            })
            .catch((error: unknown) => {
              portFailure = error;
            });
          return quiescentResult();
        }
        const callSignal =
          failure === 'aborted' ? new AbortController() : undefined;
        const result = await runtime.ports!.callPlayer(
          'coder',
          `${failure} call`,
          callSignal?.signal ?? runtimeTurn.signal,
          { resume: store.select('coder') },
        );
        if (failure === 'aborted') {
          callSignal!.abort(new Error('runtime stopped after host result'));
          expect(() => store.update('coder', result.resumeToken)).toThrow(
            /late or aborted/,
          );
        }
        // `uncommitted` deliberately returns without the required update.
        return quiescentResult();
      });
      const shell = makeShell(registry);
      const context = stubContext();
      let hostCalls = 0;
      context.context.callPlayer = async (playerId) => {
        hostCalls += 1;
        hostStarted.resolve(undefined);
        if (failure === 'late') return hostGate.promise;
        if (failure === 'malformed') {
          return {
            status: 'ok',
            playerId: 'wrong-player',
            turnId: 1,
            finalText: 'untrusted',
            resumeToken: 'uncertain-token',
          };
        }
        if (failure === 'malformed-optional') {
          return {
            status: 'ok',
            playerId,
            turnId: 1,
            finalText: 7,
          } as unknown as PlayerRunResult;
        }
        if (failure === 'unknown-undefined') {
          return {
            status: 'ok',
            playerId,
            turnId: 1,
            finalText: 'untrusted',
            futureOrPoison: undefined,
          } as unknown as PlayerRunResult;
        }
        if (failure === 'accessor') {
          return Object.defineProperty(
            {
              status: 'ok',
              playerId,
              turnId: 1,
              finalText: 'untrusted',
            },
            'resumeToken',
            {
              enumerable: true,
              get: () => {
                accessorReads += 1;
                throw new Error('host result accessor executed');
              },
            },
          ) as PlayerRunResult;
        }
        return {
          status: 'ok',
          playerId,
          turnId: 1,
          finalText: 'advanced',
          resumeToken: 'uncertain-token',
        };
      };

      await shell.init!(stubSession().session);
      const firstTurn = shell.handleBossTurn(
        turn('/code poison lane'),
        context.context,
      );
      await hostStarted.promise;
      if (failure === 'late') {
        await Promise.resolve();
        hostGate.resolve({
          status: 'ok',
          playerId: 'code-coder',
          turnId: 1,
          finalText: 'late advanced result',
          resumeToken: 'uncertain-token',
        });
      }
      await firstTurn.catch(() => undefined);
      if (failure === 'late') {
        expect(portFailure).toBeDefined();
      }
      expect(shell.exportSnapshot()).toBeUndefined();

      await shell
        .handleBossTurn(turn('/code retry', 2), context.context)
        .catch(() => undefined);
      expect(hostCalls).toBe(1);
      expect(accessorReads).toBe(0);
      await shell.dispose?.();
    },
  );

  it('rejects an overlapping call through two roles bound to one player', async () => {
    const firstStarted = deferred<void>();
    const firstGate = deferred<PlayerRunResult>();
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const store = runtime.session!.playerSessions!;
      const first = runtime.ports!.callPlayer(
        'coder',
        'first',
        runtimeTurn.signal,
        { resume: store.select('coder') },
      );
      await firstStarted.promise;
      await expect(
        runtime.ports!.callPlayer(
          'reviewer',
          'overlap',
          runtimeTurn.signal,
          { resume: store.select('reviewer') },
        ),
      ).rejects.toThrow(/already has a call in flight/);
      firstGate.resolve({
        status: 'ok',
        playerId: 'dev.shared',
        turnId: 1,
        resumeToken: 'shared-token',
        finalText: 'done',
      });
      const result = await first;
      store.update('coder', result.resumeToken);
    });
    const shell = makeShell(registry, {
      rolePlayerIds: {
        code: { coder: 'dev.shared', reviewer: 'dev.shared' },
      },
      playerAgents: {
        'dev.shared': {
          adapter: 'claude',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        },
      },
    });
    const context = stubContext();
    context.context.callPlayer = async () => {
      firstStarted.resolve(undefined);
      return firstGate.promise;
    };

    await shell.init!(stubSession().session);
    await shell.handleBossTurn(turn('/code overlap'), context.context);

    expect(context.playerCalls).toHaveLength(0);
    expect(registry.runtimes[0]?.session?.playerSessions?.select('coder')).toBe(
      'shared-token',
    );
  });

  it('allows distinct session players to overlap', async () => {
    const firstStarted = deferred<void>();
    const firstGate = deferred<PlayerRunResult>();
    let firstPending = false;
    let secondObservedOverlap = false;
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const store = runtime.session!.playerSessions!;
      const first = runtime.ports!.callPlayer(
        'coder',
        'first',
        runtimeTurn.signal,
        { resume: store.select('coder') },
      );
      await firstStarted.promise;
      const second = await runtime.ports!.callPlayer(
        'reviewer',
        'second',
        runtimeTurn.signal,
        { resume: store.select('reviewer') },
      );
      store.update('reviewer', second.resumeToken);
      firstGate.resolve({
        status: 'ok',
        playerId: 'code-coder',
        turnId: 1,
        resumeToken: 'coder-token',
        finalText: 'done',
      });
      const firstResult = await first;
      store.update('coder', firstResult.resumeToken);
    });
    const shell = makeShell(registry);
    const context = stubContext();
    context.context.callPlayer = async (playerId) => {
      if (playerId === 'code-coder') {
        firstPending = true;
        firstStarted.resolve(undefined);
        const result = await firstGate.promise;
        firstPending = false;
        return result;
      }
      secondObservedOverlap = firstPending;
      return {
        status: 'ok',
        playerId,
        turnId: 1,
        resumeToken: 'reviewer-token',
        finalText: 'done',
      };
    };

    await shell.init!(stubSession().session);
    await shell.handleBossTurn(turn('/code overlap safely'), context.context);

    expect(secondObservedOverlap).toBe(true);
    expect(registry.runtimes[0]?.session?.playerSessions?.snapshot()).toEqual({
      coder: 'coder-token',
      reviewer: 'reviewer-token',
    });
  });

  it('passes CODE ports through and hides sub-runtime judge calls', async () => {
    const observed: unknown[] = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitStatus('sub-runtime status', { step: 1 });
      await runtime.ports.emitTelemetry(stateTelemetry('ready'));
      observed.push(
        await callPlayerAndCommit(
          runtime,
          'coder',
          'player prompt',
          runtimeTurn.signal,
          false,
        ),
      );
      observed.push(
        await runtime.ports.callCaptain('captain prompt', runtimeTurn.signal, {
          visibility: 'visible',
          resume: 'captain-resume-token',
          allowedTools: ['Read', 'Search'],
        }),
      );
      observed.push(
        await runtime.ports.callCaptain(
          'unrestricted captain prompt',
          runtimeTurn.signal,
          {
            visibility: 'visible',
            resume: false,
          },
        ),
      );
      observed.push(
        await runtime.ports.callJudge('judge prompt', runtimeTurn.signal),
      );
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code wire ports'), context.context);

    expect(context.playerCalls).toEqual([
      {
        playerId: 'code-coder',
        prompt: 'player prompt',
        options: { resume: false, settings: DEFAULT_AGENT_SETTINGS },
      },
    ]);
    const nonSummaryCaptainCalls = context.captainCalls.filter(
      (call) =>
        !isTurnSummaryPrompt(call.prompt) && !isSessionCaptainPrompt(call.prompt),
    );
    expect(nonSummaryCaptainCalls.slice(0, 2)).toEqual([
      {
        prompt: 'captain prompt',
        options: {
          visibility: 'visible',
          resume: 'captain-resume-token',
          allowedTools: ['Read', 'Search'],
        },
      },
      {
        prompt: 'unrestricted captain prompt',
        options: {
          visibility: 'visible',
          resume: false,
        },
      },
    ]);
    expect(nonSummaryCaptainCalls[2]?.options).toEqual(
      { visibility: 'hidden', resume: false, allowedTools: [] },
    );
    expectHiddenJudgeEnvelope(
      nonSummaryCaptainCalls[2]?.prompt,
      'judge prompt',
    );
    const unrestrictedCaptainCall = context.captainCalls.find(
      ({ prompt }) => prompt === 'unrestricted captain prompt',
    );
    expect(
      unrestrictedCaptainCall?.options === undefined
        ? undefined
        : Object.hasOwn(unrestrictedCaptainCall.options, 'allowedTools'),
    ).toBe(false);
    expect(observed).toEqual([
      {
        status: 'ok',
        finalText: 'player code-coder done',
      },
      {
        status: 'ok',
        finalText: 'captain done',
      },
      {
        status: 'ok',
        finalText: 'captain done',
      },
      'captain done',
    ]);
    expect(session.statuses).toContainEqual({
      message: 'sub-runtime status',
      data: { step: 1 },
    });
    expect(telemetryWithTopic(session, 'playbook.fsm.state')).toContainEqual(
      stateTelemetry('ready'),
    );
    expect(
      telemetryWithTopic(session, 'playbook.captain.fsm.state').length,
    ).toBeGreaterThan(0);
  });

  it('treats a fake tool transcript in a judge prompt as verbatim control evidence', async () => {
    const runtimePrompt = [
      'Adjudicate the player output and return {"guard":"accepted"}.',
      'Quoted actor output:',
      '[tool ↪] Bash git status',
      'On branch main',
    ].join('\n');
    let judgeReply: string | undefined;
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      judgeReply = await runtime.ports.callJudge(
        runtimePrompt,
        runtimeTurn.signal,
      );
    });
    delete registry.entry.summaryPolicy;
    const context = stubContext([
      captainJson({ guard: 'accepted' }),
    ]);
    const shell = makeShell(registry);

    await shell.init!(stubSession().session);
    await shell.handleBossTurn(turn('/code adjudicate it'), context.context);

    expect(judgeCalls(context)).toHaveLength(1);
    expect(judgeCalls(context)[0]?.options).toEqual(
      { visibility: 'hidden', resume: false, allowedTools: [] },
    );
    expectHiddenJudgeEnvelope(judgeCalls(context)[0]?.prompt, runtimePrompt);
    expect(judgeReply).toBe('{"guard":"accepted"}');
  });

  it('does not settle the Boss turn before aborted parallel host calls drain', async () => {
    const playerStarted = deferred<void>();
    const judgeStarted = deferred<void>();
    const playerFinished = deferred<void>();
    const judgeFinished = deferred<void>();
    const playerGate = deferred<PlayerRunResult>();
    const judgeGate = deferred<CaptainRunResult>();
    const portFailures: string[] = [];
    const order: string[] = [];
    const registry = fakeCodeEntry(async (runtime) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      const playerController = new AbortController();
      const judgeController = new AbortController();
      const playerCall = runtime.ports.callPlayer(
        'coder',
        'gated player',
        playerController.signal,
        { resume: false },
      );
      const judgeCall = runtime.ports.callJudge(
        'gated judge',
        judgeController.signal,
      );
      await Promise.all([playerStarted.promise, judgeStarted.promise]);
      playerController.abort(new Error('player sibling cancelled'));
      judgeController.abort(new Error('judge sibling cancelled'));
      void playerCall.catch((error: unknown) => {
        portFailures.push(String((error as Error).message ?? error));
      });
      void judgeCall.catch((error: unknown) => {
        portFailures.push(String((error as Error).message ?? error));
      });
      return quiescentResult();
    });
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();
    context.context.callPlayer = async (): Promise<PlayerRunResult> => {
      order.push('player:start');
      playerStarted.resolve(undefined);
      const result = await playerGate.promise;
      order.push('player:finish');
      playerFinished.resolve(undefined);
      return result;
    };
    context.context.callCaptain = async (prompt): Promise<CaptainRunResult> => {
      if (isSessionCaptainPrompt(prompt)) {
        // The shell's own durable closing-reply call runs after the action.
        return {
          status: 'ok',
          turnId: 9,
          finalText: 'The round is under way.',
          resumeToken: 'conversation-late',
        };
      }
      expectHiddenJudgeEnvelope(prompt, 'gated judge');
      order.push('judge:start');
      judgeStarted.resolve(undefined);
      const result = await judgeGate.promise;
      order.push('judge:finish');
      judgeFinished.resolve(undefined);
      return result;
    };

    await shell.init!(session.session);
    let turnSettled = false;
    const runningTurn = shell
      .handleBossTurn(turn('/code parallel cancellation'), context.context)
      .then(() => {
        turnSettled = true;
        order.push('turn:settled');
      });
    await Promise.all([playerStarted.promise, judgeStarted.promise]);
    await Promise.resolve();
    expect(turnSettled).toBe(false);

    playerGate.resolve({
      status: 'ok',
      playerId: 'code-coder',
      turnId: 1,
      resumeToken: 'must-not-rotate',
      finalText: 'late player result',
    });
    await playerFinished.promise;
    await Promise.resolve();
    expect(turnSettled).toBe(false);

    judgeGate.resolve({
      status: 'ok',
      turnId: 1,
      finalText: 'late judge result',
    });
    await judgeFinished.promise;
    await runningTurn;

    expect(order.at(-1)).toBe('turn:settled');
    expect(order.indexOf('player:finish')).toBeLessThan(
      order.indexOf('turn:settled'),
    );
    expect(order.indexOf('judge:finish')).toBeLessThan(
      order.indexOf('turn:settled'),
    );
    expect(portFailures).toEqual(
      expect.arrayContaining([
        'player sibling cancelled',
        'judge sibling cancelled',
      ]),
    );
  });
});

describe('createPlaybookCaptainShell turn summaries (CAPTAIN-21)', () => {
  it('grounds immediate root completion in published meaning, never opaque output', async () => {
    const done = playbookState('done', {
      tags: [],
      status: 'done',
      quiescent: true,
    });
    const publishedMeaning =
      'The worker returned the exact fixture token and the request completed.\n' +
      `[Outcome report]\n${'x'.repeat(450)}TAIL`;
    const compactedMeaning = publishedMeaning
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim();
    const expectedMeaning =
      `${compactedMeaning.slice(0, 400)}… (truncated)`;
    const opaqueOutput = 'OPAQUE_RUNTIME_TOKEN_MUST_NOT_REACH_CAPTAIN';
    const registry = fakePlaybookEntry(
      'hermetic',
      'hermetic',
      async (runtime) => {
        runtime.describe = () => ({
          state: done,
          stateDescription: publishedMeaning,
          pendingQuestions: [],
          actions: [],
        });
        return terminalResult('done', { token: opaqueOutput });
      },
    );
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      {
        status: 'ok',
        turnId: 1,
        finalText:
          'The worker returned the exact fixture token and completed the request.',
      },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(
      turn('/hermetic check the fixture token'),
      context.context,
    );

    const summary = turnSummaryCalls(context)[0];
    expect(summary).toBeDefined();
    const completionFact =
      '/hermetic completed; its runtime-published result meaning was ' +
      `${JSON.stringify(expectedMeaning)}.`;
    expect(summary!.prompt).toContain(
      'Started /hermetic with the selected request.',
    );
    expect(summary!.prompt.split(completionFact)).toHaveLength(2);
    expect(summary!.prompt).toContain('… (truncated)');
    expect(summary!.prompt).not.toContain('TAIL');
    expect(
      summary!.prompt.split('\n').filter((line) => line === '[Outcome report]'),
    ).toHaveLength(1);
    expect(summary!.prompt).not.toContain(opaqueOutput);
    expect(context.replies).toEqual([
      'The worker returned the exact fixture token and completed the request.',
    ]);
    expect(registry.runtimes[0]?.disposeCount).toBe(1);
    expect(shell.exportSnapshot()?.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'outcome',
          payload: expect.arrayContaining([completionFact]),
        }),
      ]),
    );
  });

  it('records one central completion fact when delivery finishes the root', async () => {
    let run = 0;
    const registry = fakePlaybookEntry(
      'notes',
      'notes',
      async (runtime) => {
        run += 1;
        const terminal = run === 2;
        const state = terminal
          ? playbookState('done', {
              tags: [],
              status: 'done',
              quiescent: true,
            })
          : playbookState('ready');
        runtime.describe = () => ({
          state,
          stateDescription: terminal
            ? 'The delivered task is complete.'
            : 'Waiting for the next Boss message.',
          pendingQuestions: [],
          actions: [],
        });
        return terminal ? terminalResult() : quiescentResult();
      },
    );
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/notes begin'), context.context);
    await shell.handleBossTurn(turn('finish it', 2), context.context);

    const summary = turnSummaryCalls(context)[1];
    expect(summary).toBeDefined();
    const completionFact =
      '/notes completed; its runtime-published result meaning was ' +
      '"The delivered task is complete.".';
    expect(summary!.prompt).toContain('Delivered the Boss text to /notes.');
    expect(summary!.prompt.split(completionFact)).toHaveLength(2);
    expect(summary!.prompt).not.toContain('finished and was disposed');
  });

  it('appends visible turn summaries after registered and lifecycle-delivered submissions', async () => {
    const order: string[] = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitStatus(`status for ${runtimeTurn.text}`);
      order.push('status');
      await runtime.ports.emitTelemetry(stateTelemetry('ready'));
      order.push('telemetry');
      await callPlayerAndCommit(
        runtime,
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
        false,
      );
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext(
      [
        { status: 'ok', turnId: 1, finalText: 'Ran the command task.' },
        captainJson({ action: 'deliver' }),
        { status: 'ok', turnId: 1, finalText: 'Routed the task.' },
        captainJson({ action: 'deliver' }),
        { status: 'ok', turnId: 1, finalText: 'Continued the round.' },
      ],
      (prompt) => {
        if (isTurnSummaryPrompt(prompt)) order.push('summary');
      },
    );

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code command task'), context.context);
    await shell.handleBossTurn(turn('please route a task', 2), context.context);
    await shell.handleBossTurn(turn('continue it', 3), context.context);

    const summaries = turnSummaryCalls(context);
    expect(summaries).toHaveLength(3);
    for (const summary of summaries) {
      // Every durable call is hidden (CAPTAIN-9).
      expect(summary.options?.visibility).toBe('hidden');
      expect(summary.prompt).toContain(
        'Saved you 1 interruption and 0 copy-pastes across 0 rounds of reviews/rebuttals.',
      );
      expect(summary.prompt).toContain('Progress counts: none');
      expect(summary.prompt).not.toContain('stackDepth');
    }
    expect(summaries[0]?.prompt).toContain('[Boss message]\n/code command task');
    expect(summaries[1]?.prompt).toContain(
      '[Boss message]\nplease route a task',
    );
    expect(summaries[2]?.prompt).toContain('[Boss message]\ncontinue it');
    expect(context.replies).toEqual([
      'Ran the command task.',
      'Routed the task.',
      'Continued the round.',
    ]);
    expect(order).toEqual([
      'status',
      'telemetry',
      'summary',
      'status',
      'telemetry',
      'summary',
      'status',
      'telemetry',
      'summary',
    ]);
  });

  it('counts player replies as interruptions and registry-declared guards as copy-pastes', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry(stateTelemetry('reviewBossCommitCode'));
      await runtime.ports.emitTelemetry(
        stateTelemetry('reviewChangesAndChallengesSpecs'),
      );
      await runtime.ports.emitTelemetry(stateTelemetry('adjudicateChallenges'));
      await runtime.ports.emitTelemetry(stateTelemetry('planAndImplement'));
      await runtime.ports.emitTelemetry(stateTelemetry('testsGreen'));
      await runtime.ports.emitTelemetry(stateTelemetry('customState'));
      await callPlayerAndCommit(
        runtime,
        'coder',
        'first player',
        runtimeTurn.signal,
        false,
      );
      await callPlayerAndCommit(
        runtime,
        'reviewer',
        'second player',
        runtimeTurn.signal,
        false,
      );
      await runtime.ports.callJudge('classifier event', runtimeTurn.signal);
      await runtime.ports.callJudge(
        'malformed adjudication',
        runtimeTurn.signal,
      );
      await runtime.ports.callJudge(
        'guard absent from registry',
        runtimeTurn.signal,
      );
      await runtime.ports.callJudge('review findings', runtimeTurn.signal);
      await runtime.ports.callJudge('review revision', runtimeTurn.signal);
      await runtime.ports.callJudge('review pass', runtimeTurn.signal);
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      captainJson({ event: 'START_CODING', payload: { intent: 'x' } }),
      { status: 'ok', turnId: 1, finalText: 'not json' },
      captainJson({ guard: 'approved' }),
      captainJson({ guard: 'hasFindings' }),
      captainJson({ guard: 'changesMadeSpecs' }),
      captainJson({ guard: 'accepted' }),
      { status: 'ok', turnId: 1, finalText: 'Ran the review round.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code count this'), context.context);

    const summary = turnSummaryCalls(context)[0];
    expect(summary?.prompt).toContain(
      'Saved you 2 interruptions and 3 copy-pastes across 3 rounds of reviews/rebuttals.',
    );
    expect(summary?.prompt).toContain(
      'Progress counts: 2 review rounds, 1 rebuttal',
    );
    expect(summary?.prompt).not.toContain('custom state');
    expect(summary?.prompt).not.toContain('stackDepth');
    // The grounding and no-raw-vocabulary instructions live in the compiled
    // closing-reply prompt the shell wraps verbatim (CAPPLAY-20 pin 5).
    expect(summary?.prompt).toContain(
      'compose the closing reply and turn summary only from the outcome-report facts',
    );
    expect(summary?.prompt).toContain(
      'claim no work the report does not contain',
    );
    expect(summary?.prompt).toContain(
      'Write concise human chat prose with no guard names',
    );
    expect(summary?.prompt).toContain(
      'Do not mention counts for states the report does not name',
    );
    expect(summary?.prompt).toContain('Keep a natural chat-like tone');
  });

  it('counts explicit labeled-state reentry without counting parallel snapshots twice', async () => {
    const roundValue = {
      reconciliationRound: {
        host: 'working',
        participant: 'working',
      },
    } as const;
    const roundState: PlaybookState = {
      value: roundValue,
      activeStateIds: [
        'reconciliationRound',
        'host.reconciliation',
        'participant.reconciliation',
      ],
      tags: ['playbook.busy'],
      status: 'active',
      quiescent: false,
    };
    const registry = fakeCodeEntry(async (runtime) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      const emit = (from: unknown, to: unknown) =>
        runtime.ports!.emitTelemetry({
          topic: 'playbook.fsm.state',
          payload: { from, to, state: roundState },
        });
      await emit('reviewReconciledProposal', roundValue);
      await emit(roundValue, roundValue);
      // The frame still exposes the same active parallel ids, but the
      // structured transition proves the labeled parent was re-entered.
      await emit('reviewReconciledProposal', roundValue);
      await emit(roundValue, roundValue);
      return quiescentResult();
    });
    const stateCountLabels = registry.entry.summaryPolicy!
      .stateCountLabels as Record<string, string>;
    stateCountLabels.reconciliationRound = 'proposal round';
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(
      turn('/code count round reentry'),
      context.context,
    );

    const summary = turnSummaryCalls(context)[0];
    expect(summary?.prompt).toContain('Progress counts: 2 proposal rounds');
    expect(summary?.prompt).toContain(
      'Saved you 0 interruptions and 0 copy-pastes across 2 rounds of reviews/rebuttals.',
    );
  });

  it('uses singular saved-count forms for one copy-paste and one round', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry(stateTelemetry('adjudicateChallenges'));
      await runtime.ports.callJudge('review pass', runtimeTurn.signal);
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      captainJson({ guard: 'accepted' }),
      { status: 'ok', turnId: 1, finalText: 'Adjudicated the rebuttal.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code singular forms'), context.context);

    const summary = turnSummaryCalls(context)[0];
    expect(summary?.prompt).toContain(
      'Saved you 0 interruptions and 1 copy-paste across 1 round of reviews/rebuttals.',
    );
    expect(summary?.prompt).toContain('Progress counts: 1 rebuttal');
  });

  // CAPTAIN-19/21: a do-nothing turn — a `respond` settle or a parse-resolved
  // `respond` — makes no result-phase call, so no `Saved you` line can follow.
  it('makes no result-phase call for a respond settle or a bare command', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      captainJson({ action: 'respond', text: 'Nothing is running yet.' }),
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('just chat with me'), context.context);

    expect(registry.createRuntime).not.toHaveBeenCalled();
    expect(turnSummaryCalls(context)).toHaveLength(0);
    expect(context.replies).toEqual(['Nothing is running yet.']);
    expect(JSON.stringify(context.replies)).not.toContain('Saved you');

    const selectionRegistry = fakeCodeEntry();
    const selectionShell = makeShell(selectionRegistry);
    const selectionSession = stubSession();
    const selectionContext = stubContext([
      { status: 'ok', turnId: 2, finalText: 'CODE is not running.' },
    ]);

    await selectionShell.init!(selectionSession.session);
    await selectionShell.handleBossTurn(
      turn('/code', 2),
      selectionContext.context,
    );

    expect(selectionRegistry.createRuntime).not.toHaveBeenCalled();
    expect(turnSummaryCalls(selectionContext)).toHaveLength(0);
    expect(JSON.stringify(selectionContext.replies)).not.toContain('Saved you');
  });

  // CAPTAIN-19/20: an entry without a `summaryPolicy` still gets the acting
  // turn's closing reply, but no saved-counts line is supplied for it.
  it('supplies no saved-counts line when the entry declares no summary policy', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await callPlayerAndCommit(
        runtime,
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
        false,
      );
    });
    delete (registry.entry as { summaryPolicy?: unknown }).summaryPolicy;
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code do the task'), context.context);

    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'do the task',
    ]);
    const summary = turnSummaryCalls(context)[0];
    expect(summary?.prompt).toContain(
      'No saved-counts line is supplied for this turn; append no saved-counts line.',
    );
    expect(summary?.prompt).not.toContain('Saved you');
  });
});

describe('createPlaybookCaptainShell registry loading (CAPTAIN-16/22/23)', () => {
  const CODE_FROM = '@sublang/playbook/code/registry';

  function namespacedSession() {
    return stubSession([
      { id: 'code-coder', adapter: 'codex', model: 'gpt-5.5' },
      { id: 'code-reviewer', adapter: 'claude', model: 'claude-opus-4-8' },
    ]);
  }

  const sessionAgents = {
    captain: {
      adapter: 'claude',
      model: { kind: 'provider-default' },
      effort: { kind: 'provider-default' },
    },
    players: {
      'code-coder': {
        adapter: 'codex',
        model: { kind: 'value', value: 'gpt-5.5' },
        effort: { kind: 'provider-default' },
      },
      'code-reviewer': {
        adapter: 'claude',
        model: { kind: 'value', value: 'claude-opus-4-8' },
        effort: { kind: 'provider-default' },
      },
    },
  } as const;

  const codeRoles = {
    coder: {
      playerId: 'code-coder',
      model: { kind: 'value', value: 'gpt-5.6-sol' },
      effort: { kind: 'value', value: 'high' },
    },
    reviewer: {
      playerId: 'code-reviewer',
      model: { kind: 'provider-default' },
      effort: { kind: 'provider-default' },
    },
  } as const;

  function withSessionAgents(options: Record<string, unknown>) {
    return { sessionAgents, captainAdapter: 'claude', ...options };
  }

  async function initWith(
    options: unknown,
    loadModule: (specifier: string) => Promise<unknown>,
  ): Promise<void> {
    const shell = createPlaybookCaptainShell(
      withSessionAgents(options as Record<string, unknown>),
      { loadModule },
    );
    await shell.init!(namespacedSession().session);
  }

  it('loads from captain.options.playbooks, binds <id>-<role>, validates the slice, and switches visibility', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await callPlayerAndCommit(
        runtime,
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
        false,
      );
    });
    const options = {
      playbooks: {
        code: {
          from: CODE_FROM,
          roles: codeRoles,
          options: { committer: 'reviewer' },
        },
      },
      sessionAgents,
      captainAdapter: 'claude',
    };
    const shell = createPlaybookCaptainShell(options, {
      loadModule: async (specifier) => {
        if (specifier === CODE_FROM) return { default: registry.entry };
        throw new Error(`no module ${specifier}`);
      },
    });
    const session = namespacedSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code do the task'), context.context);

    // Entry validates its own option slice directly.
    expect(registry.validateOptions).toHaveBeenCalledWith({
      committer: 'reviewer',
    });
    expect(registry.createRuntime).toHaveBeenCalledWith({ committer: 'reviewer' });
    expect(registry.runtimes[0]?.inputs.map((i) => i.text)).toEqual([
      'do the task',
    ]);
    // Local role 'coder' is remapped to the namespaced host player.
    expect(context.playerCalls.map((c) => c.playerId)).toEqual(['code-coder']);
    // Visibility requested for the generated set before dispatch.
    expect(context.visiblePlayers).toContainEqual([
      'code-coder',
      'code-reviewer',
    ]);
  });

  it('rejects init for enablement faults', async () => {
    const code = fakeCodeEntry();
    const code2 = fakePlaybookEntry('code2', 'code');
    const loader = async (specifier: string): Promise<unknown> => {
      if (specifier === 'mod://code') return { default: code.entry };
      if (specifier === 'mod://code2') return { default: code2.entry };
      if (specifier === 'mod://invalid') return { default: { id: 'code' } };
      throw new Error(`no module ${specifier}`);
    };

    await expect(initWith({ playbooks: {} }, loader)).rejects.toThrow(
      /at least one playbook/,
    );
    await expect(initWith({ playbooks: { code: {} } }, loader)).rejects.toThrow(
      /from/,
    );
    await expect(
      initWith({ playbooks: { code: { from: 'mod://missing' } } }, loader),
    ).rejects.toThrow(/failed to import/);
    await expect(
      initWith({ playbooks: { code: { from: 'mod://invalid' } } }, loader),
    ).rejects.toThrow(/no valid registry entry/);
    await expect(
      initWith({ playbooks: { foo: { from: 'mod://code' } } }, loader),
    ).rejects.toThrow(/manifest id/);
    await expect(
      initWith({ playbooks: { captain: { from: 'mod://code' } } }, loader),
    ).rejects.toThrow(/reserved internal Captain id/);
    await expect(
      initWith(
        {
          playbooks: {
            code: { from: 'mod://code', command: 'captain' },
          },
        },
        loader,
      ),
    ).rejects.toThrow(/reserved internal Captain command/);
    await expect(
      initWith(
        {
          playbooks: {
            code: { from: 'mod://code', roles: codeRoles, options: {} },
            code2: { from: 'mod://code2', roles: codeRoles, options: {} },
          },
        },
        loader,
      ),
    ).rejects.toThrow(/duplicate effective command/);

    const exactRoleCases: readonly [string, unknown, RegExp][] = [
      [
        'missing role',
        {
          playbooks: {
            code: {
              from: 'mod://code',
              roles: { coder: codeRoles.coder },
              options: {},
            },
          },
        },
        /exactly cover requiredRoleIds/,
      ],
      [
        'extra role',
        {
          playbooks: {
            code: {
              from: 'mod://code',
              roles: { ...codeRoles, extra: codeRoles.coder },
              options: {},
            },
          },
        },
        /exactly cover requiredRoleIds/,
      ],
      [
        'missing player',
        {
          playbooks: {
            code: {
              from: 'mod://code',
              roles: {
                ...codeRoles,
                coder: { ...codeRoles.coder, playerId: 'dev.missing' },
              },
              options: {},
            },
          },
        },
        /names absent session player/,
      ],
      [
        'unreferenced player',
        {
          playbooks: {
            code: { from: 'mod://code', roles: codeRoles, options: {} },
          },
          sessionAgents: {
            ...sessionAgents,
            players: {
              ...sessionAgents.players,
              'unused.player': {
                adapter: 'claude',
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
            },
          },
        },
        /unreferenced player/,
      ],
    ];
    for (const [_label, value, diagnostic] of exactRoleCases) {
      const config = value as Record<string, unknown>;
      await expect(initWith(config, loader)).rejects.toThrow(diagnostic);
    }
    const withoutAgents = createPlaybookCaptainShell(
      {
        playbooks: {
          code: { from: 'mod://code', roles: codeRoles, options: {} },
        },
      },
      { loadModule: loader },
    );
    await expect(withoutAgents.init!(namespacedSession().session)).rejects.toThrow(
      /sessionAgents/,
    );
  });

  it('reports a setVisiblePlayers rejection without driving the runtime', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell(
      {
        playbooks: {
          code: { from: CODE_FROM, roles: codeRoles, options: {} },
        },
        sessionAgents,
        captainAdapter: 'claude',
      },
      {
        loadModule: async () => ({ default: registry.entry }),
      },
    );
    const session = namespacedSession();
    const context = stubContext();
    context.context.setVisiblePlayers = async () => {
      throw new Error('invalid visible set');
    };

    await shell.init!(session.session);
    await expect(
      shell.handleBossTurn(turn('/code do the task'), context.context),
    ).resolves.toBeUndefined();
    expect(registry.runtimes[0]?.inputs).toEqual([]);
    const failurePrompt = turnSummaryCalls(context).at(-1)?.prompt ?? '';
    expect(failurePrompt).toContain('Settlement status: failed');
    expect(failurePrompt).toContain('invalid visible set');
  });

  it('default-exports the CODE registry entry from @sublang/playbook/code/registry', async () => {
    const mod = await import('@sublang/playbook/code/registry');
    expect(mod.default).toBe(mod.codePlaybookRegistryEntry);
    expect(mod.default.id).toBe('code');
    expect(mod.default.command).toBe('code');
    expect(typeof mod.default.createRuntime).toBe('function');
  });
});

describe('createPlaybookCaptainShell session bridge (CAPTAIN-26/27)', () => {
  const FIRST_ID = '10000000-0000-4000-8000-000000000001';
  const SECOND_ID = '10000000-0000-4000-8000-000000000002';

  it('keeps one UUID while parked and replaces it after dismissal', async () => {
    const registry = fakeCodeEntry(async (runtime) => {
      if (!runtime.ports || !runtime.session) {
        throw new Error('runtime session missing');
      }
      await runtime.ports.emitTelemetry({
        topic: 'playbook.trace',
        payload: {
          schemaVersion: 3,
          sessionId: runtime.session.sessionId,
          playbookId: runtime.session.playbookId,
          rootSessionId: runtime.session.rootSessionId,
          depth: runtime.session.depth,
          sequence: 1,
          timestamp: 1,
          type: 'boss.input.settled',
          payload: { outcome: 'quiescent' },
        },
      });
    });
    const shell = makeShell(registry, {
      sessionIds: [FIRST_ID, SECOND_ID],
    });
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Started CODE.' },
      { status: 'ok', turnId: 2, finalText: 'Continued CODE.' },
      captainJson({ action: 'dismiss' }),
      { status: 'ok', turnId: 3, finalText: 'Stopped CODE.' },
      { status: 'ok', turnId: 4, finalText: 'Started CODE again.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first'), context.context);
    await shell.handleBossTurn(turn('/code second', 2), context.context);

    expect(registry.runtimes).toHaveLength(1);
    expect(registry.runtimes[0]?.session).toMatchObject({
      sessionId: FIRST_ID,
      playbookId: 'code',
    });
    expect(
      telemetryWithTopic(session, 'playbook.captain.fsm.state').some((event) =>
        JSON.stringify(event.payload).includes(
          `"activeSessionId":"${FIRST_ID}"`,
        ),
      ),
    ).toBe(true);
    expect(telemetryWithTopic(session, 'playbook.trace')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ sessionId: FIRST_ID }),
        }),
      ]),
    );

    await shell.handleBossTurn(turn('dismiss it', 3), context.context);
    await shell.handleBossTurn(turn('/code third', 4), context.context);

    expect(
      hiddenCaptainCalls(context).every(
        (call) =>
          !call.prompt.includes(FIRST_ID) &&
          !call.prompt.includes(SECOND_ID) &&
          !call.prompt.includes('activeSessionId') &&
          !call.prompt.includes('rootSessionId') &&
          !call.prompt.includes('stackPath') &&
          !call.prompt.includes('stackDepth'),
      ),
    ).toBe(true);
    expect(
      turnSummaryCalls(context).every(
        (call) =>
          !call.prompt.includes(FIRST_ID) &&
          !call.prompt.includes(SECOND_ID) &&
          !call.prompt.includes('playbook.trace'),
      ),
    ).toBe(true);
    expect(registry.runtimes).toHaveLength(2);
    expect(registry.runtimes[1]?.session?.sessionId).toBe(SECOND_ID);
    expect(session.statuses.map((status) => status.message)).toContain(
      '◇ /code stopped',
    );
    expect(
      session.statuses.some(
        (status) =>
          status.message.includes(FIRST_ID) ||
          status.message.includes(SECOND_ID),
      ),
    ).toBe(false);
  });

  it('rejects a reused generated UUID before constructing a replacement', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry, {
      sessionIds: [FIRST_ID, FIRST_ID],
    });
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Started CODE.' },
      captainJson({ action: 'dismiss' }),
      { status: 'ok', turnId: 2, finalText: 'Stopped CODE.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first'), context.context);
    await shell.handleBossTurn(turn('dismiss it', 2), context.context);
    // DR-029: a failing start settles with its facts rather than
    // rolling back, and the shell lands idle for the next turn.
    await shell.handleBossTurn(turn('/code second', 3), context.context);
    const failure = turnSummaryCalls(context).at(-1)?.prompt ?? '';
    expect(failure).toContain(`playbook session id collision: ${FIRST_ID}`);
    expect(failure).toContain('Settlement status: failed');
    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
  });

  it('disposes a failed initialization and retries with a new engagement', async () => {
    const registry = fakeCodeEntry(undefined, undefined, async () => {
      throw new Error('runtime init failed');
    });
    const shell = makeShell(registry, {
      sessionIds: [FIRST_ID, SECOND_ID],
    });
    const session = stubSession();
    const context = stubContext();
    await shell.init!(session.session);

    // CAPTAIN-26: the broken engagement is cleared and its partial runtime
    // disposed; the settlement reports the failure and a later validated
    // `start` constructs a different engagement.
    await shell.handleBossTurn(turn('/code first'), context.context);
    await shell.handleBossTurn(turn('/code retry', 2), context.context);
    for (const summary of turnSummaryCalls(context)) {
      expect(summary.prompt).toContain('runtime init failed');
      expect(summary.prompt).toContain('Settlement status: failed');
    }

    expect(registry.runtimes).toHaveLength(2);
    expect(registry.runtimes.map((runtime) => runtime.initCount)).toEqual([
      1, 1,
    ]);
    expect(registry.runtimes.map((runtime) => runtime.disposeCount)).toEqual([
      1, 1,
    ]);
    expect(
      registry.runtimes.map((runtime) => runtime.session?.sessionId),
    ).toEqual([FIRST_ID, SECOND_ID]);
    expect(
      telemetryWithTopic(session, 'playbook.captain.fsm.state').filter(
        ({ payload }) =>
          (payload as { event?: unknown }).event === 'engage.failed',
      ),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          from: 'engaged.parked',
          to: 'chat',
          ledger: expect.objectContaining({ mode: 'chat', stackDepth: 0 }),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          from: 'engaged.parked',
          to: 'chat',
          ledger: expect.objectContaining({ mode: 'chat', stackDepth: 0 }),
        }),
      }),
    ]);
  });

  it('forwards explicit resume selections and returned tokens unchanged', async () => {
    const observed: unknown[] = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      const first = await runtime.ports.callPlayer(
        'coder',
        'fresh call',
        runtimeTurn.signal,
        { resume: false },
      );
      runtime.session?.playerSessions?.update('coder', first.resumeToken);
      observed.push(first);
      const second = await runtime.ports.callPlayer(
        'coder',
        'continued call',
        runtimeTurn.signal,
        { resume: first.resumeToken ?? false },
      );
      runtime.session?.playerSessions?.update('coder', second.resumeToken);
      observed.push(second);
    });
    const shell = makeShell(registry, { sessionIds: [FIRST_ID] });
    const session = stubSession();
    const context = stubContext();
    let call = 0;
    context.context.callPlayer = async (
      playerId,
      prompt,
      options,
    ): Promise<PlayerRunResult> => {
      context.playerCalls.push({ playerId, prompt, options });
      call += 1;
      return {
        status: 'ok',
        playerId,
        turnId: 1,
        resumeToken: `player-token-${call}`,
        finalText: `result ${call}`,
      };
    };

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code resume'), context.context);

    expect(context.playerCalls).toEqual([
      {
        playerId: 'code-coder',
        prompt: 'fresh call',
        options: { resume: false, settings: DEFAULT_AGENT_SETTINGS },
      },
      {
        playerId: 'code-coder',
        prompt: 'continued call',
        options: {
          resume: 'player-token-1',
          settings: DEFAULT_AGENT_SETTINGS,
        },
      },
    ]);
    expect(observed).toEqual([
      expect.objectContaining({ resumeToken: 'player-token-1' }),
      expect.objectContaining({ resumeToken: 'player-token-2' }),
    ]);
    expect(
      turnSummaryCalls(context).every(
        (summary) => !summary.prompt.includes('player-token-'),
      ),
    ).toBe(true);
  });

  it('retains the session player ledger through replacement roots in a real tmux-play host', async () => {
    const adapterResumes: Array<string | undefined> = [];
    let adapterRun = 0;

    class PlayerAdapter implements AgentAdapter {
      readonly agent = 'codex';

      async *run(
        _prompt: string,
        options?: AgentOptions,
      ): AsyncGenerator<AgentEvent, void, void> {
        adapterRun += 1;
        adapterResumes.push(options?.resume);
        yield createEvent(
          'done',
          this.agent,
          {
            status: 'success',
            result: `result-${adapterRun}`,
            resumeToken: `token-${adapterRun}`,
            usage: { inputTokens: 1, outputTokens: 1, toolUses: 0 },
            durationMs: 1,
          },
          `transport-${adapterRun}`,
        );
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    let captainRun = 0;
    class UnusedCaptainAdapter implements AgentAdapter {
      readonly agent = 'claude-code';

      async *run(prompt: string): AsyncGenerator<AgentEvent, void, void> {
        captainRun += 1;
        yield createEvent(
          'done',
          this.agent,
          {
            status: 'success',
            // The durable session conversation returns a rotating token
            // (CAPTAIN-31); a reply with none marks it unsynchronized. A
            // decision call answers with control JSON, a prose call with
            // captain speech.
            result: isDecisionPrompt(prompt)
              ? JSON.stringify({ action: 'deliver' })
              : 'The round is under way.',
            resumeToken: `captain-token-${captainRun}`,
            usage: { inputTokens: 1, outputTokens: 1, toolUses: 0 },
            durationMs: 1,
          },
          'captain-transport',
        );
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const calls = new WeakMap<FakeRuntime, number>();
    const disposedSessionIds: string[] = [];
    const registry = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        const callCount = (calls.get(runtime) ?? 0) + 1;
        calls.set(runtime, callCount);
        const result = await runtime.ports.callPlayer(
          'coder',
          runtimeTurn.text,
          runtimeTurn.signal,
          {
            resume:
              runtime.session?.playerSessions?.select('coder') ?? false,
          },
        );
        if (result.resumeToken) {
          runtime.session?.playerSessions?.update('coder', result.resumeToken);
        }
        await runtime.ports.emitTelemetry(
          stateTelemetry(callCount === 2 ? 'done' : 'ready'),
        );
        return callCount === 2 ? terminalResult() : quiescentResult();
      },
      async (runtime) => {
        if (!runtime.ports || !runtime.session) {
          throw new Error('runtime session missing during disposal');
        }
        await runtime.ports.emitTelemetry({
          topic: 'playbook.trace',
          payload: {
            schemaVersion: 3,
            sessionId: runtime.session.sessionId,
            playbookId: runtime.session.playbookId,
            rootSessionId: runtime.session.rootSessionId,
            depth: runtime.session.depth,
            sequence: 1,
            timestamp: 1,
            type: 'session.disposed',
            payload: { stateId: 'ready' },
          },
        });
      },
    );
    registry.entry.requiredRoleIds = ['coder'];
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry, {
      sessionIds: [FIRST_ID, SECOND_ID],
      roleTunings: {
        code: {
          coder: {
            model: { kind: 'value', value: 'gpt-5.6-sol' },
            effort: { kind: 'value', value: 'high' },
          },
        },
      },
      playerAgents: {
        'code-coder': {
          adapter: 'codex',
          model: { kind: 'value', value: 'gpt-5.6-sol' },
          effort: { kind: 'value', value: 'high' },
        },
      },
    });
    const captain: Captain = {
      init: (session) => shell.init!(session),
      async handleBossTurn(bossTurn, context) {
        if (bossTurn.prompt === 'seed old host context') {
          await context.callPlayer('code-coder', bossTurn.prompt);
          return;
        }
        await shell.handleBossTurn(bossTurn, context);
      },
      prepareDispose: () => shell.prepareDispose!(),
      dispose: () => shell.dispose!(),
    };
    const adapterImports = {
      claude: async () => UnusedCaptainAdapter,
      codex: async () => PlayerAdapter,
      gemini: async () => UnusedCaptainAdapter,
      opencode: async () => UnusedCaptainAdapter,
    };
    const host = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [
        {
          id: 'code-coder',
          adapter: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
      ],
      adapterImports,
      observers: [
        {
          onRecord(record: TmuxPlayRecord) {
            if (
              record.type !== 'captain_telemetry' ||
              record.topic !== 'playbook.trace'
            ) {
              return;
            }
            const payload = record.payload as {
              type?: unknown;
              sessionId?: unknown;
            };
            if (
              payload.type === 'session.disposed' &&
              typeof payload.sessionId === 'string'
            ) {
              disposedSessionIds.push(payload.sessionId);
            }
          },
        },
      ],
    });

    await host.runBossTurn('seed old host context');
    await host.runBossTurn('/code first');
    await host.runBossTurn('/code second');
    await host.runBossTurn('/code third');
    await host.dispose();

    expect(adapterResumes).toEqual([
      undefined,
      undefined,
      'token-2',
      'token-3',
    ]);
    expect(
      registry.runtimes.map((runtime) => runtime.session?.sessionId),
    ).toEqual([FIRST_ID, SECOND_ID]);
    // CAPTAIN-16: engagements dispose leaf to root, the session Captain last.
    expect(disposedSessionIds).toEqual([
      FIRST_ID,
      SECOND_ID,
      SESSION_CAPTAIN_ID,
    ]);
  });
});

describe('createPlaybookCaptainShell nested playbooks', () => {
  const ROOT_ID = '20000000-0000-4000-8000-000000000001';
  const CHILD_ID = '20000000-0000-4000-8000-000000000002';
  const LEAF_ID = '20000000-0000-4000-8000-000000000003';

  it('keeps a shared player locked until the owning runtime commits its validated result', async () => {
    let overlapError: unknown;
    let childResume: string | false | undefined;
    const code = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const store = runtime.session!.playerSessions!;
      const first = runtime.ports!.callPlayer(
        'coder',
        'parent call',
        runtimeTurn.signal,
        { resume: store.select('coder') },
      );
      const start = await runtime.ports!.callPlaybook(
        {
          callId: 'code:docs:token-race',
          playbookId: 'docs',
          text: 'probe the shared player',
        },
        runtimeTurn.signal,
      );
      if (start.state !== 'suspended') throw new Error('child must park');
      const firstResult = await first;
      store.update('coder', firstResult.resumeToken);
      return suspendedResult({
        callId: 'code:docs:token-race',
        playbookId: 'docs',
        childSessionId: start.childSessionId,
      });
    });
    code.entry.requiredRoleIds = ['coder'];
    const docs = fakePlaybookEntry(
      'docs',
      'docs',
      async (runtime, runtimeTurn) => {
        const store = runtime.session!.playerSessions!;
        if (runtimeTurn.text === 'probe the shared player') {
          try {
            await runtime.ports!.callPlayer(
              'coder',
              'overlapping child call',
              runtimeTurn.signal,
              { resume: store.select('coder') },
            );
          } catch (error) {
            overlapError = error;
          }
          return quiescentResult('parked');
        }
        childResume = store.select('coder');
        const result = await runtime.ports!.callPlayer(
          'coder',
          'later child call',
          runtimeTurn.signal,
          { resume: childResume },
        );
        store.update('coder', result.resumeToken);
        return quiescentResult('parked');
      },
    );
    docs.entry.requiredRoleIds = ['coder'];
    const shell = makeShell([code, docs], {
      rolePlayerIds: {
        code: { coder: 'dev.shared' },
        docs: { coder: 'dev.shared' },
      },
      playerAgents: {
        'dev.shared': {
          adapter: 'claude',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        },
      },
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const context = stubContext();
    let call = 0;
    context.context.callPlayer = async (
      playerId,
      prompt,
      options,
    ): Promise<PlayerRunResult> => {
      context.playerCalls.push({ playerId, prompt, options });
      call += 1;
      return {
        status: 'ok',
        playerId,
        turnId: call,
        finalText: `result ${call}`,
        resumeToken: call === 1 ? 'first-token' : 'second-token',
      };
    };

    await shell.init!(stubSession().session);
    await shell.handleBossTurn(turn('/code start'), context.context);
    await shell.handleBossTurn(turn('/docs continue', 2), context.context);

    expect(overlapError).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/already has a call in flight/),
      }),
    );
    expect(childResume).toBe('first-token');
    expect(context.playerCalls.map(({ options }) => options?.resume)).toEqual([
      false,
      'first-token',
    ]);
    expect(docs.runtimes[0]?.session?.playerSessions?.select('coder')).toBe(
      'second-token',
    );
  });

  it('suspends a caller, routes the next turn to the leaf, and resumes with the child result', async () => {
    const order: string[] = [];
    let childStart:
      | Awaited<ReturnType<PlaybookPorts['callPlaybook']>>
      | undefined;
    const code = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        childStart = await runtime.ports.callPlaybook(
          {
            callId: 'code:docs:1',
            playbookId: 'docs',
            text: 'draft the API notes',
          },
          runtimeTurn.signal,
        );
        if (childStart.state !== 'suspended') {
          throw new Error('expected the child to suspend');
        }
        return suspendedResult({
          callId: 'code:docs:1',
          playbookId: 'docs',
          childSessionId: childStart.childSessionId,
        });
      },
      undefined,
      undefined,
      async (_runtime, input) => {
        order.push('parent resumed');
        expect(input.callId).toBe('code:docs:1');
        expect(input.result).toMatchObject({
          status: 'ok',
          playbookId: 'docs',
          childSessionId: CHILD_ID,
          output: { document: 'complete' },
        });
        return quiescentResult('readyAfterDocs');
      },
    );
    const docs = fakePlaybookEntry(
      'docs',
      'docs',
      async (_runtime, runtimeTurn) =>
        runtimeTurn.text === 'draft the API notes'
          ? quiescentResult('drafting')
          : terminalResult('done', { document: 'complete' }),
      async () => {
        order.push('child disposed');
      },
    );
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code coordinate docs'), context.context);

    expect(childStart).toEqual({
      state: 'suspended',
      childSessionId: CHILD_ID,
    });
    expect(code.runtimes[0]?.session).toMatchObject({
      sessionId: ROOT_ID,
      playbookId: 'code',
      rootSessionId: ROOT_ID,
      depth: 0,
    });
    expect(code.runtimes[0]?.session).not.toHaveProperty('parentSessionId');
    expect(docs.runtimes[0]?.session).toMatchObject({
      sessionId: CHILD_ID,
      playbookId: 'docs',
      rootSessionId: ROOT_ID,
      parentSessionId: ROOT_ID,
      parentCallId: 'code:docs:1',
      depth: 1,
    });

    await shell.handleBossTurn(turn('continue the child', 2), context.context);

    const decisionPrompts = context.captainCalls.filter((call) =>
      isDecisionPrompt(call.prompt),
    );
    expect(decisionPrompts).toHaveLength(1);
    const lifecyclePrompt = decisionPrompts[0]!.prompt;
    expect(lifecyclePrompt).not.toContain('activePlaybookId');
    expect(lifecyclePrompt).not.toContain('Lifecycle facts:');
    expect(lifecyclePrompt).not.toContain('stackPath');
    expect(lifecyclePrompt).not.toContain('stackDepth');
    expect(lifecyclePrompt).not.toContain('activeSessionId');
    expect(lifecyclePrompt).not.toContain('rootPlaybookId');
    expect(lifecyclePrompt).not.toContain('rootSessionId');
    expect(lifecyclePrompt).not.toContain('parentSessionId');
    expect(lifecyclePrompt).not.toContain('parentCallId');
    expect(lifecyclePrompt).not.toContain('"sessionId"');
    expect(lifecyclePrompt).not.toContain('"callId"');
    expect(lifecyclePrompt).not.toContain('code:docs:1');
    expect(lifecyclePrompt).not.toContain(ROOT_ID);
    expect(lifecyclePrompt).not.toContain(CHILD_ID);
    expect(code.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'coordinate docs',
    ]);
    expect(docs.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'draft the API notes',
      'continue the child',
    ]);
    expect(code.runtimes[0]?.resumes).toHaveLength(1);
    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(code.runtimes[0]?.disposeCount).toBe(0);
    expect(order).toEqual(['child disposed', 'parent resumed']);
    expect(session.statuses.map((status) => status.message)).toEqual(
      expect.arrayContaining([
        '◇ /docs called by /code',
        '◇ /docs returned to /code',
      ]),
    );
  });

  it.each([
    {
      label: 'not parked',
      tags: [] as readonly string[],
      quiescent: true,
    },
    {
      label: 'still busy',
      tags: ['playbook.parked'] as readonly string[],
      quiescent: false,
    },
  ])(
    'returns an initially failed child that is $label through the error boundary',
    async ({ tags, quiescent }) => {
      let childStart:
        | Awaited<ReturnType<PlaybookPorts['callPlaybook']>>
        | undefined;
      const code = fakeCodeEntry(async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        childStart = await runtime.ports.callPlaybook(
          {
            callId: 'code:docs:invalid-initial-failure',
            playbookId: 'docs',
            text: 'open invalid child',
          },
          runtimeTurn.signal,
        );
        return quiescentResult();
      });
      const docs = fakePlaybookEntry('docs', 'docs', async () => ({
        outcome: 'failed',
        state: playbookState('failed', { tags, quiescent }),
        error: { name: 'Error', message: 'child workflow failed' },
      }));
      delete code.entry.summaryPolicy;
      delete docs.entry.summaryPolicy;
      const shell = makeShell([code, docs], {
        sessionIds: [ROOT_ID, CHILD_ID],
      });
      const session = stubSession();
      const context = stubContext();

      await shell.init!(session.session);
      await shell.handleBossTurn(
        turn('/code exercise invalid child failure'),
        context.context,
      );

      expect(childStart).toMatchObject({
        state: 'settled',
        result: {
          status: 'error',
          playbookId: 'docs',
          childSessionId: CHILD_ID,
          error: {
            message: expect.stringContaining(
              'without a quiescent playbook.parked state',
            ),
          },
        },
      });
      expect(docs.runtimes[0]?.disposeCount).toBe(1);
      expect(code.runtimes[0]?.disposeCount).toBe(0);
      await shell.dispose!();
    },
  );

  it('returns a later non-parked child failure to its parent instead of retaining the child', async () => {
    const code = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        if (runtimeTurn.text !== 'open child') return quiescentResult();
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'code:docs:invalid-later-failure',
            playbookId: 'docs',
            text: 'begin child work',
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') throw new Error('docs must suspend');
        return suspendedResult({
          callId: 'code:docs:invalid-later-failure',
          playbookId: 'docs',
          childSessionId: start.childSessionId,
        });
      },
      undefined,
      undefined,
      async () => quiescentResult('readyAfterInvalidChild'),
    );
    const docs = fakePlaybookEntry(
      'docs',
      'docs',
      async (_runtime, runtimeTurn) =>
        runtimeTurn.text === 'begin child work'
          ? quiescentResult('working')
          : {
              outcome: 'failed',
              state: playbookState('failed', {
                tags: [],
                quiescent: true,
              }),
              error: { name: 'Error', message: 'child workflow failed' },
            },
    );
    delete code.entry.summaryPolicy;
    delete docs.entry.summaryPolicy;
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code open child'), context.context);
    await shell.handleBossTurn(
      turn('fail outside recovery', 2),
      context.context,
    );

    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(code.runtimes[0]?.resumes).toHaveLength(1);
    expect(code.runtimes[0]?.resumes[0]).toMatchObject({
      callId: 'code:docs:invalid-later-failure',
      result: {
        status: 'error',
        playbookId: 'docs',
        childSessionId: CHILD_ID,
        error: {
          message: expect.stringContaining(
            'without a quiescent playbook.parked state',
          ),
        },
      },
    });
    await shell.handleBossTurn(
      turn('/code continue parent', 3),
      context.context,
    );
    expect(code.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'open child',
      'continue parent',
    ]);
    await shell.dispose!();
  });

  it('reports nested visibility validation as a failed result, not child evidence', async () => {
    let childCallReturned = false;
    const code = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.callPlaybook(
        {
          callId: 'code:docs:visibility',
          playbookId: 'docs',
          text: 'open docs',
        },
        runtimeTurn.signal,
      );
      childCallReturned = true;
      return quiescentResult();
    });
    const docs = fakePlaybookEntry('docs', 'docs', async () =>
      quiescentResult('drafting'),
    );
    // Give the child one role its caller does not map so the visibility
    // request is observably the explicitly bound child leaf.
    docs.entry.requiredRoleIds = ['docs'];
    delete code.entry.summaryPolicy;
    delete docs.entry.summaryPolicy;
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext();
    context.context.setVisiblePlayers = async (ids) => {
      context.visiblePlayers.push([...ids]);
      if (ids.includes('docs-docs')) {
        throw new Error('invalid nested visible set');
      }
    };

    await shell.init!(session.session);
    await expect(
      shell.handleBossTurn(turn('/code open a nested child'), context.context),
    ).resolves.toBeUndefined();

    expect(childCallReturned).toBe(false);
    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(code.runtimes[0]?.resumes).toEqual([]);
    const failurePrompt = turnSummaryCalls(context).at(-1)?.prompt ?? '';
    expect(failurePrompt).toContain('Settlement status: failed');
    expect(failurePrompt).toContain('invalid nested visible set');
  });

  it('uses the parent invocation lifetime signal for the child initial turn', async () => {
    const invocation = new AbortController();
    const childStarted = deferred<void>();
    let childSignal: AbortSignal | undefined;
    let childStart:
      | Awaited<ReturnType<PlaybookPorts['callPlaybook']>>
      | undefined;
    const code = fakeCodeEntry(async (runtime) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      childStart = await runtime.ports.callPlaybook(
        {
          callId: 'code:docs:cancel-opening',
          playbookId: 'docs',
          text: 'start cancellable docs',
        },
        invocation.signal,
      );
      return quiescentResult('readyAfterCancelledChild');
    });
    const docs = fakePlaybookEntry(
      'docs',
      'docs',
      async (_runtime, runtimeTurn) => {
        childSignal = runtimeTurn.signal;
        childStarted.resolve(undefined);
        await new Promise<void>((resolve) => {
          if (runtimeTurn.signal.aborted) resolve();
          else
            runtimeTurn.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
        return {
          outcome: 'aborted',
          state: playbookState('cancelled', {
            tags: [],
            quiescent: true,
          }),
          error: { name: 'Error', message: 'parent invocation stopped' },
        };
      },
    );
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    const runningTurn = shell.handleBossTurn(
      turn('/code open cancellable child'),
      context.context,
    );
    await childStarted.promise;
    expect(childSignal).not.toBe(context.context.signal);

    invocation.abort(new Error('parent invocation stopped'));
    await runningTurn;

    expect(childSignal?.aborted).toBe(true);
    expect(childStart).toMatchObject({
      state: 'settled',
      result: {
        status: 'aborted',
        playbookId: 'docs',
        childSessionId: CHILD_ID,
      },
    });
    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(code.runtimes[0]?.disposeCount).toBe(0);
  });

  it('serializes invocation-abort cleanup against a simultaneous child return', async () => {
    const invocation = new AbortController();
    const disposeStarted = deferred<void>();
    const releaseDispose = deferred<void>();
    const code = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        if (runtimeTurn.text !== 'open docs') {
          return quiescentResult('readyAfterRace');
        }
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'code:docs:return-race',
            playbookId: 'docs',
            text: 'draft docs',
          },
          invocation.signal,
        );
        if (start.state !== 'suspended') throw new Error('docs must suspend');
        return suspendedResult({
          callId: 'code:docs:return-race',
          playbookId: 'docs',
          childSessionId: start.childSessionId,
        });
      },
      undefined,
      undefined,
      async () => quiescentResult('mustNotResumeTwice'),
    );
    const docs = fakePlaybookEntry(
      'docs',
      'docs',
      async (_runtime, runtimeTurn) =>
        runtimeTurn.text === 'draft docs'
          ? quiescentResult('drafting')
          : terminalResult('done', { document: 'complete' }),
      async () => {
        disposeStarted.resolve(undefined);
        await releaseDispose.promise;
      },
    );
    delete code.entry.summaryPolicy;
    delete docs.entry.summaryPolicy;
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code open docs'), context.context);
    const returning = shell.handleBossTurn(
      turn('finish the child', 2),
      context.context,
    );
    await disposeStarted.promise;
    invocation.abort(new Error('parent invocation cancelled during return'));
    releaseDispose.resolve(undefined);
    await returning;

    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(code.runtimes[0]?.resumes).toEqual([]);

    await shell.handleBossTurn(turn('/code continue root', 3), context.context);
    expect(code.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'open docs',
      'continue root',
    ]);
    expect(docs.createRuntime).toHaveBeenCalledTimes(1);
  });

  it('unwinds nested terminal results strictly LIFO and rejects cycles or a second child from a suspended caller', async () => {
    const order: string[] = [];
    let codeRuntime: FakeRuntime | undefined;
    const code = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        codeRuntime = runtime;
        if (!runtime.ports) throw new Error('runtime ports missing');
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'code:docs:1',
            playbookId: 'docs',
            text: 'start docs',
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') throw new Error('docs must suspend');
        return suspendedResult({
          callId: 'code:docs:1',
          playbookId: 'docs',
          childSessionId: start.childSessionId,
        });
      },
      async () => {
        order.push('code disposed');
      },
      undefined,
      async () => {
        order.push('code resumed');
        return quiescentResult('ready');
      },
    );
    const docs = fakePlaybookEntry(
      'docs',
      'docs',
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'docs:lint:1',
            playbookId: 'lint',
            text: 'lint docs',
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') throw new Error('lint must suspend');
        return suspendedResult({
          callId: 'docs:lint:1',
          playbookId: 'lint',
          childSessionId: start.childSessionId,
        });
      },
      async () => {
        order.push('docs disposed');
      },
      undefined,
      async (_runtime, input) => {
        order.push('docs resumed');
        expect(input.result).toMatchObject({
          status: 'ok',
          playbookId: 'lint',
          childSessionId: LEAF_ID,
        });
        return terminalResult('done', { docs: 'linted' });
      },
    );
    const lint = fakePlaybookEntry(
      'lint',
      'lint',
      async (runtime, runtimeTurn) => {
        if (!runtime.ports || !codeRuntime?.ports) {
          throw new Error('runtime ports missing');
        }
        await expect(
          runtime.ports.callPlaybook(
            {
              callId: 'lint:code:cycle',
              playbookId: 'code',
              text: 'cycle',
            },
            runtimeTurn.signal,
          ),
        ).rejects.toThrow(
          'nested playbook cycle: code -> docs -> lint -> code',
        );
        await expect(
          codeRuntime.ports.callPlaybook(
            {
              callId: 'code:lint:second',
              playbookId: 'lint',
              text: 'second child',
            },
            runtimeTurn.signal,
          ),
        ).rejects.toThrow('only the active leaf may call a child playbook');
        return runtimeTurn.text === 'lint docs'
          ? quiescentResult('checking')
          : terminalResult('done', { clean: true });
      },
      async () => {
        order.push('lint disposed');
      },
    );
    const shell = makeShell([code, docs, lint], {
      sessionIds: [ROOT_ID, CHILD_ID, LEAF_ID],
    });
    const session = stubSession();
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code nested chain'), context.context);

    expect(docs.runtimes[0]?.session).toMatchObject({
      sessionId: CHILD_ID,
      rootSessionId: ROOT_ID,
      parentSessionId: ROOT_ID,
      parentCallId: 'code:docs:1',
      depth: 1,
    });
    expect(lint.runtimes[0]?.session).toMatchObject({
      sessionId: LEAF_ID,
      rootSessionId: ROOT_ID,
      parentSessionId: CHILD_ID,
      parentCallId: 'docs:lint:1',
      depth: 2,
    });
    expect(lint.createRuntime).toHaveBeenCalledTimes(1);

    await shell.handleBossTurn(turn('finish the leaf', 2), context.context);

    expect(order).toEqual([
      'lint disposed',
      'docs resumed',
      'docs disposed',
      'code resumed',
    ]);
    expect(code.runtimes[0]?.resumes[0]?.result).toMatchObject({
      status: 'ok',
      playbookId: 'docs',
      childSessionId: CHILD_ID,
      output: { docs: 'linted' },
    });
    expect(code.runtimes[0]?.disposeCount).toBe(0);
  });

  it('rolls back the outstanding-child guard when child UUID allocation fails', async () => {
    const constructionErrors: Error[] = [];
    let attempt = 0;
    const code = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      attempt += 1;
      try {
        const start = await runtime.ports.callPlaybook(
          {
            callId: `code:docs:uuid:${attempt}`,
            playbookId: 'docs',
            text: `attempt ${attempt}`,
          },
          runtimeTurn.signal,
        );
        if (start.state === 'suspended') {
          return suspendedResult({
            callId: `code:docs:uuid:${attempt}`,
            playbookId: 'docs',
            childSessionId: start.childSessionId,
          });
        }
      } catch (error) {
        constructionErrors.push(error as Error);
      }
      return quiescentResult();
    });
    const docs = fakePlaybookEntry('docs', 'docs', async () =>
      quiescentResult('drafting'),
    );
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, 'not-a-uuid', CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first attempt'), context.context);
    await shell.handleBossTurn(turn('/code retry child', 2), context.context);

    expect(constructionErrors).toHaveLength(1);
    expect(constructionErrors[0]?.message).toContain(
      'session id generator returned a non-UUID value',
    );
    expect(docs.createRuntime).toHaveBeenCalledTimes(1);
    expect(docs.runtimes[0]?.session?.sessionId).toBe(CHILD_ID);
    await shell.dispose!();
  });

  it('rolls back the outstanding-child guard when the child factory throws', async () => {
    const constructionErrors: Error[] = [];
    let callAttempt = 0;
    const code = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      callAttempt += 1;
      try {
        const start = await runtime.ports.callPlaybook(
          {
            callId: `code:docs:factory:${callAttempt}`,
            playbookId: 'docs',
            text: `attempt ${callAttempt}`,
          },
          runtimeTurn.signal,
        );
        if (start.state === 'suspended') {
          return suspendedResult({
            callId: `code:docs:factory:${callAttempt}`,
            playbookId: 'docs',
            childSessionId: start.childSessionId,
          });
        }
      } catch (error) {
        constructionErrors.push(error as Error);
      }
      return quiescentResult();
    });
    const docs = fakePlaybookEntry('docs', 'docs', async () =>
      quiescentResult('drafting'),
    );
    const createChild = docs.entry.createRuntime;
    let factoryAttempt = 0;
    docs.entry.createRuntime = (options) => {
      factoryAttempt += 1;
      if (factoryAttempt === 1) throw new Error('child factory failed');
      return createChild(options);
    };
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID, LEAF_ID],
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first attempt'), context.context);
    await shell.handleBossTurn(turn('/code retry child', 2), context.context);

    expect(constructionErrors.map((error) => error.message)).toEqual([
      'child factory failed',
    ]);
    expect(factoryAttempt).toBe(2);
    expect(docs.runtimes).toHaveLength(1);
    expect(docs.runtimes[0]?.session?.sessionId).toBe(LEAF_ID);
    await shell.dispose!();
  });

  it.each(['init', 'initial-turn'] as const)(
    'pairs a called status on %s failure while keeping pre-call init failure silent',
    async (failureStage) => {
      let childStart:
        | Awaited<ReturnType<PlaybookPorts['callPlaybook']>>
        | undefined;
      const code = fakeCodeEntry(async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        childStart = await runtime.ports.callPlaybook(
          {
            callId: `code:docs:${failureStage}`,
            playbookId: 'docs',
            text: 'fail child boundary',
          },
          runtimeTurn.signal,
        );
        return quiescentResult();
      });
      const docs = fakePlaybookEntry(
        'docs',
        'docs',
        failureStage === 'initial-turn'
          ? async () => {
              throw new Error('child initial turn failed');
            }
          : undefined,
        undefined,
        failureStage === 'init'
          ? async () => {
              throw new Error('child init failed');
            }
          : undefined,
      );
      const shell = makeShell([code, docs], {
        sessionIds: [ROOT_ID, CHILD_ID],
      });
      const session = stubSession();
      const context = stubContext();

      await shell.init!(session.session);
      await shell.handleBossTurn(
        turn(`/code ${failureStage} failure`),
        context.context,
      );

      expect(childStart).toMatchObject({
        state: 'settled',
        result: {
          status: 'error',
          playbookId: 'docs',
          childSessionId: CHILD_ID,
        },
      });
      const childStatuses = session.statuses
        .map((status) => status.message)
        .filter((message) => message.includes('/docs'));
      expect(childStatuses).toEqual(
        failureStage === 'initial-turn'
          ? ['◇ /docs called by /code', '◇ /docs stopped; returning to /code']
          : [],
      );
      expect(docs.runtimes[0]?.disposeCount).toBe(1);
      await shell.dispose!();
    },
  );

  it('dismisses only the active child and resumes its caller with an aborted result', async () => {
    const code = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        if (runtimeTurn.text !== 'call docs') {
          return quiescentResult('readyAfterDismiss');
        }
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'code:docs:dismiss',
            playbookId: 'docs',
            text: 'draft docs',
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') throw new Error('docs must suspend');
        return suspendedResult({
          callId: 'code:docs:dismiss',
          playbookId: 'docs',
          childSessionId: start.childSessionId,
        });
      },
      undefined,
      undefined,
      async () => quiescentResult('readyAfterDismiss'),
    );
    const docs = fakePlaybookEntry('docs', 'docs', async () =>
      quiescentResult('drafting'),
    );
    delete code.entry.summaryPolicy;
    delete docs.entry.summaryPolicy;
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'CODE called the docs playbook.' },
      captainJson({ action: 'dismiss' }),
      { status: 'ok', turnId: 2, finalText: 'Stopped the docs child.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code call docs'), context.context);
    await shell.handleBossTurn(turn('stop the child', 2), context.context);

    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(code.runtimes[0]?.disposeCount).toBe(0);
    expect(code.runtimes[0]?.resumes).toHaveLength(1);
    expect(code.runtimes[0]?.resumes[0]).toMatchObject({
      callId: 'code:docs:dismiss',
      result: {
        status: 'aborted',
        playbookId: 'docs',
        childSessionId: CHILD_ID,
      },
    });
    expect(session.statuses).toContainEqual({
      message: '◇ /docs stopped; returning to /code',
      data: undefined,
    });
    expect(context.captainCalls).toHaveLength(3);
    expect(context.captainCalls[0]?.options).toEqual(
      ISOLATED_HIDDEN_CAPTAIN_OPTIONS,
    );

    await shell.handleBossTurn(turn('/code continue root', 3), context.context);
    expect(code.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'call docs',
      'continue root',
    ]);
    expect(docs.createRuntime).toHaveBeenCalledTimes(1);
  });

  it('reports a nested cleanup failure while keeping the child dismissed', async () => {
    const code = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        if (runtimeTurn.text !== 'call docs') {
          return quiescentResult('readyAfterDismiss');
        }
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'code:docs:dismiss-failure',
            playbookId: 'docs',
            text: 'draft docs',
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') throw new Error('docs must suspend');
        return suspendedResult({
          callId: 'code:docs:dismiss-failure',
          playbookId: 'docs',
          childSessionId: start.childSessionId,
        });
      },
      undefined,
      undefined,
      async () => quiescentResult('readyAfterDismiss'),
    );
    const docs = fakePlaybookEntry(
      'docs',
      'docs',
      async () => quiescentResult('drafting'),
      async () => {
        throw new Error('child dispose failed');
      },
    );
    delete code.entry.summaryPolicy;
    delete docs.entry.summaryPolicy;
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'CODE called the docs playbook.' },
      captainJson({ action: 'dismiss' }),
      {
        status: 'ok',
        turnId: 2,
        finalText: 'The docs child was removed, but its cleanup failed.',
      },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code call docs'), context.context);
    await shell.handleBossTurn(turn('stop the child', 2), context.context);

    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(code.runtimes[0]?.disposeCount).toBe(0);
    expect(code.runtimes[0]?.resumes[0]?.result).toMatchObject({
      status: 'error',
      error: { message: 'child dispose failed' },
    });
    const report = turnSummaryCalls(context).at(-1)?.prompt ?? '';
    expect(report).toContain('Settlement status: failed');
    expect(report).toContain('Dismissed /docs and returned to its caller.');
    expect(report).toContain('Cleanup while removing /docs failed');
    expect(report).toContain('child dispose failed');

    await shell.handleBossTurn(turn('/code continue root', 3), context.context);
    expect(code.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'call docs',
      'continue root',
    ]);
  });
});

describe('Playbook Captain complete session snapshots (CAPTAIN-41/42/43)', () => {
  const ROOT_ID = '30000000-0000-4000-8000-000000000001';
  const CHILD_ID = '30000000-0000-4000-8000-000000000002';
  const roster: CaptainSession['players'] = [
    { id: 'code-coder', adapter: 'claude' },
    { id: 'code-reviewer', adapter: 'codex' },
    { id: 'review-coder', adapter: 'claude' },
    { id: 'review-reviewer', adapter: 'codex' },
  ];

  const nestedSnapshotFixture = async (): Promise<PlaybookCaptainShellSnapshot> => {
    const source = makeShell([fakeCodeEntry(), fakePlaybookEntry('review', 'review')]);
    await source.init!(stubSession(roster).session);
    await source.handleBossTurn(
      turn('hello'),
      stubContext([
        captainJson({ action: 'respond', text: 'Ready.' }),
      ]).context,
    );
    const chat = source.exportSnapshot()!;
    await source.dispose?.();
    const waiting = playbookState('waitingForReview', {
      tags: ['playbook.suspended'],
    });
    return {
      ...chat,
      mode: 'engaged.parked',
      issuedSessionIds: [SESSION_CAPTAIN_ID, ROOT_ID, CHILD_ID],
      frames: [
        {
          playbookId: 'code',
          sessionId: ROOT_ID,
          rootSessionId: ROOT_ID,
          depth: 0,
          options: {},
          roleBindings: {
            coder: 'code-coder',
            reviewer: 'code-reviewer',
          },
          runtime: runtimeSnapshot('code', waiting, {
            turn: 1,
            roleResumeTokens: { reviewer: 'shared-token' },
            suspendedCall: {
              callId: 'code:review:1',
              stateId: 'waitingForReview',
              playbookId: 'review',
              text: 'review this',
              childSessionId: CHILD_ID,
              turnId: 1,
            },
          }),
        },
        {
          playbookId: 'review',
          sessionId: CHILD_ID,
          rootSessionId: ROOT_ID,
          depth: 1,
          parentSessionId: ROOT_ID,
          parentCallId: 'code:review:1',
          options: {},
          roleBindings: {
            coder: 'code-coder',
            reviewer: 'code-reviewer',
          },
          runtime: runtimeSnapshot('review', playbookState('ready'), {
            turn: 1,
            roleResumeTokens: { reviewer: 'shared-token' },
          }),
        },
      ],
      playerSessions: {
        ...chat.playerSessions,
        'code-reviewer': {
          ...chat.playerSessions['code-reviewer']!,
          resumeToken: 'shared-token',
        },
      },
    };
  };

  it('validates intrinsic snapshot state directly without config or runtime work', async () => {
    const base = await nestedSnapshotFixture();
    const input = JSON.parse(JSON.stringify(base));
    const validated = assertPlaybookCaptainShellSnapshot(input);

    expect(validated).toEqual(base);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.captain)).toBe(true);
    expect(
      validated.mode === 'engaged.parked' &&
        Object.isFrozen(validated.frames[0]?.runtime),
    ).toBe(true);
    input.frames[0].roleBindings.coder = 'mutated-after-validation';
    expect(
      validated.mode === 'engaged.parked' &&
        validated.frames[0]?.roleBindings.coder,
    ).toBe('code-coder');

    const clone = (): any => JSON.parse(JSON.stringify(base));
    const intrinsicMutations: Array<() => unknown> = [
      () => {
        const value = clone();
        value.captain.agent.model = { kind: 'value', value: 'forbidden' };
        return value;
      },
      () => {
        const value = clone();
        value.playerSessions['code-coder'].effort = {
          kind: 'value',
          value: 'high',
        };
        return value;
      },
      () => {
        const value = clone();
        value.captain.conversation = {
          kind: 'needsCatchUp',
          resume: false,
          afterJournalSeq: 1,
        };
        return value;
      },
      () => {
        const value = clone();
        value.captain.conversation = {
          kind: 'needsCatchUp',
          resume: 'retained-token',
          afterJournalSeq: 0,
        };
        return value;
      },
      () => {
        const value = clone();
        value.frames[1].parentCallId = 'wrong-edge';
        return value;
      },
      () => {
        const value = clone();
        value.frames[1].runtime.pendingBossQuestions = [
          {
            questionId: 'unknown-role-question',
            asker: { kind: 'role', roleId: 'architect' },
            question: 'Who owns this?',
          },
        ];
        value.pendingBossQuestions =
          value.frames[1].runtime.pendingBossQuestions;
        return value;
      },
      () => {
        const value = clone();
        value.frames[1].runtime.roleResumeTokens.reviewer = 'wrong-token';
        return value;
      },
      () => {
        const value = clone();
        value.pendingBossQuestions = [{ questionId: 'not-the-leaf' }];
        return value;
      },
    ];
    for (const mutate of intrinsicMutations) {
      expect(() => assertPlaybookCaptainShellSnapshot(mutate())).toThrow();
    }
  });

  it('round-trips chat history and resumes the pinned Captain conversation without restore work', async () => {
    const source = makeShell(fakeCodeEntry());
    const sourceSession = stubSession(roster);
    const first = stubContext([
      captainJson({ action: 'respond', text: 'Hello — ready when you are.' }),
    ]);
    await source.init!(sourceSession.session);
    const unopenedSnapshot = source.exportSnapshot()!;
    expect(unopenedSnapshot).toMatchObject({
      schemaVersion: 3,
      mode: 'chat',
      captain: {
        sessionId: SESSION_CAPTAIN_ID,
        conversation: { kind: 'unopened' },
        runtime: { schemaVersion: 3, sequences: { turn: 0 } },
      },
      issuedSessionIds: [SESSION_CAPTAIN_ID],
      sequences: { turn: 0, journal: 0 },
      journal: [],
    });
    const unopenedRestored = makeShell(fakeCodeEntry());
    const unopenedHost = stubSession(roster);
    await unopenedRestored.restore(
      unopenedHost.session,
      JSON.parse(
        JSON.stringify(unopenedSnapshot),
      ) as PlaybookCaptainShellSnapshot,
    );
    expect(unopenedHost.statuses).toEqual([]);
    expect(unopenedHost.telemetry).toEqual([]);
    const firstAfterRestore = stubContext([
      captainJson({ action: 'respond', text: 'First restored reply.' }),
    ]);
    await unopenedRestored.handleBossTurn(
      turn('first restored turn'),
      firstAfterRestore.context,
    );
    expect(firstAfterRestore.captainCalls[0]?.options?.resume).toBe(false);
    expect(firstAfterRestore.replies).toEqual(['First restored reply.']);
    expect(unopenedRestored.exportSnapshot()).toMatchObject({
      sequences: { turn: 1 },
      captain: {
        conversation: { kind: 'pinned' },
        runtime: { sequences: { turn: 1 } },
      },
    });
    await unopenedRestored.dispose?.();
    await source.handleBossTurn(turn('hello'), first.context);

    const snapshot = source.exportSnapshot();
    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      mode: 'chat',
      captain: {
        conversation: { kind: 'pinned', token: 'conversation-1' },
        runtime: {
          schemaVersion: 3,
          sequences: { turn: 1 },
          state: { tags: expect.arrayContaining(['playbook.parked']) },
        },
      },
      sequences: { turn: 1 },
    });
    expect(snapshot && 'frames' in snapshot).toBe(false);
    expect(snapshot?.issuedSessionIds).toEqual([SESSION_CAPTAIN_ID]);

    const restored = makeShell(fakeCodeEntry());
    const restoredSession = stubSession(roster);
    await restored.restore(
      restoredSession.session,
      JSON.parse(JSON.stringify(snapshot)) as PlaybookCaptainShellSnapshot,
    );
    expect(restoredSession.statuses).toEqual([]);
    expect(restoredSession.telemetry).toEqual([]);
    expect(restored.exportSnapshot()).toEqual(snapshot);
    await expect(
      restored.restore(stubSession(roster).session, snapshot!),
    ).rejects.toThrow(/fresh shell/);
    await expect(restored.init!(stubSession(roster).session)).rejects.toThrow(
      /fresh instance/,
    );

    const next = stubContext([
      captainJson({ action: 'respond', text: 'Still with you.' }),
    ]);
    await restored.handleBossTurn(turn('and now?', 2), next.context);
    expect(next.captainCalls[0]?.options?.resume).toBe('conversation-1');
    expect(next.replies).toEqual(['Still with you.']);
    expect(restored.exportSnapshot()).toMatchObject({
      sequences: { turn: 2 },
      captain: { runtime: { sequences: { turn: 2 } } },
    });

    await source.dispose?.();
    await restored.dispose?.();
  });

  it('restores needsSeeding chat through the journal recap rather than a stale token', async () => {
    const source = makeShell(fakeCodeEntry());
    await source.init!(stubSession(roster).session);
    const failedPresentation = stubContext([
      captainJson({ action: 'respond', text: 'Remembered.' }),
    ]);
    failedPresentation.context.emitReply = async () => {
      throw new Error('presentation boundary failed');
    };
    await expect(
      source.handleBossTurn(turn('remember this'), failedPresentation.context),
    ).rejects.toThrow(/presentation boundary failed/);
    const snapshot = source.exportSnapshot()!;
    expect(snapshot).toMatchObject({
      mode: 'chat',
      captain: {
        conversation: { kind: 'needsSeeding' },
        runtime: { schemaVersion: 3, sequences: { turn: 1 } },
      },
      sequences: { turn: 1 },
    });
    const restored = makeShell(fakeCodeEntry());
    const restoredSession = stubSession(roster);
    await restored.restore(
      restoredSession.session,
      JSON.parse(JSON.stringify(snapshot)) as PlaybookCaptainShellSnapshot,
    );
    expect(restoredSession.statuses).toEqual([]);
    expect(restoredSession.telemetry).toEqual([]);

    const next = stubContext([
      captainJson({ action: 'respond', text: 'I remember.' }),
    ]);
    await restored.handleBossTurn(turn('what did I say?', 2), next.context);
    expect(next.captainCalls[0]?.options?.resume).toBe(false);
    expect(next.captainCalls[0]?.prompt).toContain('Conversation recap');
    expect(next.captainCalls[0]?.prompt).toContain('remember this');
    expect(restored.exportSnapshot()).toMatchObject({
      sequences: { turn: 2 },
      captain: { runtime: { sequences: { turn: 2 } } },
    });

    await source.dispose?.();
    await restored.dispose?.();
  });

  it('persists an unopened settings rejection and catches up once without an immediate retry', async () => {
    const source = makeShell(fakeCodeEntry());
    await source.init!(stubSession(roster).session);
    const rejected = stubContext();
    const rejectedCalls: Array<{
      prompt: string;
      options: CaptainCallOptions | undefined;
    }> = [];
    rejected.context.callCaptain = async (prompt, options) => {
      rejectedCalls.push({ prompt, options });
      throw new AgentCallSettingsError('unsupported Captain tuning');
    };

    await source.handleBossTurn(turn('remember unopened failure'), rejected.context);

    expect(rejectedCalls).toHaveLength(1);
    expect(rejected.replies).toHaveLength(1);
    const snapshot = source.exportSnapshot()!;
    expect(snapshot).toMatchObject({
      captain: {
        conversation: {
          kind: 'needsCatchUp',
          resume: false,
          afterJournalSeq: 0,
        },
      },
    });

    const restored = makeShell(fakeCodeEntry());
    await restored.restore(
      stubSession(roster).session,
      JSON.parse(JSON.stringify(snapshot)) as PlaybookCaptainShellSnapshot,
    );
    const recovered = stubContext([
      captainJson({ action: 'respond', text: 'Caught up.' }),
    ]);
    await restored.handleBossTurn(turn('continue after rejection', 2), recovered.context);

    expect(recovered.captainCalls).toHaveLength(1);
    expect(recovered.captainCalls[0]?.options?.resume).toBe(false);
    expect(recovered.captainCalls[0]?.prompt).toContain(
      'This retained conversation missed the host journal records below.',
    );
    expect(recovered.captainCalls[0]?.prompt).toContain(
      'remember unopened failure',
    );
    expect(restored.exportSnapshot()).toMatchObject({
      captain: { conversation: { kind: 'pinned' } },
    });

    await source.dispose?.();
    await restored.dispose?.();
  });

  it('retains a pinned token and only catches up the journal suffix after settings rejection', async () => {
    const source = makeShell(fakeCodeEntry());
    await source.init!(stubSession(roster).session);
    await source.handleBossTurn(
      turn('old settled request'),
      stubContext([
        captainJson({ action: 'respond', text: 'Old reply.' }),
      ]).context,
    );

    const rejected = stubContext();
    rejected.context.callCaptain = async () => {
      throw new AgentCallSettingsError('retune unavailable');
    };
    await source.handleBossTurn(turn('new missed request', 2), rejected.context);
    const snapshot = source.exportSnapshot()!;
    expect(snapshot).toMatchObject({
      captain: {
        conversation: {
          kind: 'needsCatchUp',
          resume: 'conversation-1',
        },
      },
    });
    const oldBoss = snapshot.journal.find(
      (record) => record.kind === 'boss' && record.turnId === 1,
    )!;
    const newBoss = snapshot.journal.find(
      (record) => record.kind === 'boss' && record.turnId === 2,
    )!;
    expect(
      snapshot.captain.conversation.kind === 'needsCatchUp' &&
        snapshot.captain.conversation.afterJournalSeq,
    ).toBeGreaterThanOrEqual(oldBoss.seq);
    expect(
      snapshot.captain.conversation.kind === 'needsCatchUp' &&
        snapshot.captain.conversation.afterJournalSeq,
    ).toBeLessThan(newBoss.seq);

    const recovered = stubContext([
      captainJson({ action: 'respond', text: 'Recovered.' }),
    ]);
    await source.handleBossTurn(turn('recover now', 3), recovered.context);
    const prompt = recovered.captainCalls[0]!.prompt;
    const suffix = prompt.slice(
      prompt.indexOf('This retained conversation missed the host journal records below.'),
    );
    expect(recovered.captainCalls[0]?.options?.resume).toBe('conversation-1');
    expect(suffix).toContain('new missed request');
    expect(suffix).not.toContain('old settled request');

    await source.dispose?.();
  });

  it('advances the catch-up watermark after a successful decision and accumulates repeated rejections', async () => {
    const code = fakeCodeEntry(async () => quiescentResult('ready'));
    delete code.entry.summaryPolicy;
    const shell = makeShell(code, { sessionIds: [ROOT_ID] });
    await shell.init!(stubSession(roster).session);
    await shell.handleBossTurn(
      turn('/code initial action'),
      stubContext([
        { status: 'ok', turnId: 1, finalText: 'Initial action settled.' },
      ]).context,
    );

    const closingRejected = stubContext();
    closingRejected.context.callCaptain = async (prompt) => {
      if (isDecisionPrompt(prompt)) {
        return {
          ...captainJson({ action: 'deliver' }),
          resumeToken: 'decision-token',
        };
      }
      throw new AgentCallSettingsError('closing tuning unavailable');
    };
    await shell.handleBossTurn(turn('first missed closing', 2), closingRejected.context);
    code.runtimes[0]!.snapshot = runtimeSnapshot(
      'code',
      playbookState('ready'),
      { turn: 2 },
    );
    const firstRejected = shell.exportSnapshot()!;
    const turnTwoBossSeq = firstRejected.journal.find(
      (record) => record.kind === 'boss' && record.turnId === 2,
    )!.seq;
    expect(firstRejected.captain.conversation).toEqual({
      kind: 'needsCatchUp',
      resume: 'decision-token',
      afterJournalSeq: turnTwoBossSeq,
    });

    const repeated = stubContext();
    repeated.context.callCaptain = async () => {
      throw new AgentCallSettingsError('still unsupported');
    };
    await shell.handleBossTurn(turn('/code second missed closing', 3), repeated.context);
    code.runtimes[0]!.snapshot = runtimeSnapshot(
      'code',
      playbookState('ready'),
      { turn: 3 },
    );
    const repeatedSnapshot = shell.exportSnapshot()!;
    expect(repeatedSnapshot.captain.conversation).toEqual(
      firstRejected.captain.conversation,
    );

    const recovered = stubContext([
      { status: 'ok', turnId: 4, finalText: 'All caught up.' },
    ]);
    await shell.handleBossTurn(turn('/code recover closing', 4), recovered.context);
    const catchUpCall = recovered.captainCalls[0]!;
    const suffix = catchUpCall.prompt.slice(
      catchUpCall.prompt.indexOf(
        'This retained conversation missed the host journal records below.',
      ),
    );
    expect(catchUpCall.options?.resume).toBe('decision-token');
    expect(suffix).toContain('turn 2 action:');
    expect(suffix).toContain('turn 2 outcome:');
    expect(suffix).not.toContain('first missed closing');
    expect(suffix).toContain('second missed closing');
    expect(suffix).not.toContain('initial action');

    await shell.dispose?.();
  });

  it('dispatches a roleless playbook without requesting an empty visibility set', async () => {
    const registry = fakePlaybookEntry('notes', 'notes');
    registry.entry.requiredRoleIds = [];
    const shell = makeShell(registry);
    const context = stubContext();

    await shell.init!(stubSession([]).session);
    await shell.handleBossTurn(turn('/notes capture this'), context.context);

    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'capture this',
    ]);
    expect(context.visiblePlayers).toEqual([]);

    await shell.dispose?.();
  });

  it('keeps needsSeeding through a settings rejection', async () => {
    const shell = makeShell(fakeCodeEntry());
    await shell.init!(stubSession(roster).session);
    const presentationFailure = stubContext([
      captainJson({ action: 'respond', text: 'Uncertain delivery.' }),
    ]);
    presentationFailure.context.emitReply = async () => {
      throw new Error('presentation uncertain');
    };
    await expect(
      shell.handleBossTurn(turn('seed uncertain state'), presentationFailure.context),
    ).rejects.toThrow(/presentation uncertain/);
    expect(shell.exportSnapshot()).toMatchObject({
      captain: { conversation: { kind: 'needsSeeding' } },
    });

    const typed = stubContext();
    let typedCalls = 0;
    typed.context.callCaptain = async () => {
      typedCalls += 1;
      throw new AgentCallSettingsError('still unsupported');
    };
    await shell.handleBossTurn(turn('retry unsupported', 2), typed.context);
    expect(typedCalls).toBe(1);
    expect(shell.exportSnapshot()).toMatchObject({
      captain: { conversation: { kind: 'needsSeeding' } },
    });

    await shell.dispose?.();
  });

  it('lets the exact abort reason win over typed settings classification', async () => {
    const captain = fakeSessionCaptain(async (runtime, runtimeTurn) => {
      await runtime.ports!.callCaptain(
        'attempt one durable Captain call',
        runtimeTurn.signal,
        { visibility: 'hidden', resume: false },
      );
      return quiescentResult();
    });
    const shell = makeShell(fakeCodeEntry(), {
      createCaptainRuntime: captain.createCaptainRuntime,
    });
    const aborted = stubContext();
    const abortReason = new AgentCallSettingsError('typed abort reason');
    aborted.context.callCaptain = async () => {
      aborted.controller.abort(abortReason);
      throw abortReason;
    };

    await shell.init!(stubSession(roster).session);
    await expect(
      shell.handleBossTurn(turn('abort wins'), aborted.context),
    ).rejects.toBe(abortReason);
    expect(aborted.replies).toEqual([]);

    await shell.dispose?.();
  });

  it('replaces retained catch-up continuity when an admitted Captain call aborts after resolving', async () => {
    const source = makeShell(fakeCodeEntry());
    await source.init!(stubSession(roster).session);
    const rejected = stubContext();
    rejected.context.callCaptain = async () => {
      throw new AgentCallSettingsError('catch-up required');
    };
    await source.handleBossTurn(turn('persist missed turn'), rejected.context);
    const catchUpSnapshot = source.exportSnapshot()!;
    expect(catchUpSnapshot).toMatchObject({
      captain: { conversation: { kind: 'needsCatchUp', resume: false } },
    });

    const restored = makeShell(fakeCodeEntry());
    await restored.restore(
      stubSession(roster).session,
      JSON.parse(JSON.stringify(catchUpSnapshot)) as PlaybookCaptainShellSnapshot,
    );
    const aborted = stubContext();
    const abortReason = new Error('aborted after provider result');
    aborted.context.callCaptain = async () => {
      aborted.controller.abort(abortReason);
      return {
        ...captainJson({ action: 'respond', text: 'must not surface' }),
        resumeToken: 'advanced-token',
      };
    };
    await expect(
      restored.handleBossTurn(
        turn('attempt retained catch-up', 2),
        aborted.context,
      ),
    ).rejects.toBe(abortReason);
    expect(aborted.replies).toEqual([]);
    expect(restored.exportSnapshot()).toMatchObject({
      captain: { conversation: { kind: 'needsSeeding' } },
    });

    const recovered = stubContext([
      captainJson({ action: 'respond', text: 'Recovered fresh.' }),
    ]);
    await restored.handleBossTurn(turn('recover safely', 3), recovered.context);
    expect(recovered.captainCalls[0]?.options?.resume).toBe(false);
    expect(recovered.captainCalls[0]?.prompt).toContain('Conversation recap');
    expect(recovered.captainCalls[0]?.prompt).toContain(
      'attempt retained catch-up',
    );

    await source.dispose?.();
    await restored.dispose?.();
  });

  it('does not let a caught player settings rejection classify a later runtime failure', async () => {
    let playerRejected = false;
    const laterFailure = new Error('distinct runtime failure');
    const code = fakeCodeEntry(async (runtime, runtimeTurn) => {
      try {
        await runtime.ports!.callPlayer(
          'coder',
          'unsupported player call',
          runtimeTurn.signal,
          { resume: runtime.session!.playerSessions!.select('coder') },
        );
      } catch (error) {
        playerRejected = error instanceof AgentCallSettingsError;
      }
      return quiescentResult();
    });
    delete code.entry.summaryPolicy;
    const captain = fakeSessionCaptain(async (_runtime, runtimeTurn) => {
      await captain.ports.controller!.submit(
        {
          action: 'start',
          playbookId: 'code',
          input: 'classify exactly',
        },
        runtimeTurn.signal,
      );
      throw laterFailure;
    });
    const shell = makeShell(code, {
      createCaptainRuntime: captain.createCaptainRuntime,
    });
    const context = stubContext();
    context.context.callPlayer = async () => {
      throw new AgentCallSettingsError('player tuning rejected');
    };

    await shell.init!(stubSession(roster).session);
    await expect(
      shell.handleBossTurn(turn('classify exactly'), context.context),
    ).rejects.toBe(laterFailure);

    expect(playerRejected).toBe(true);
    expect(context.replies).toHaveLength(1);

    await shell.dispose?.();
  });

  it('reports retained Captain continuity in telemetry during catch-up', async () => {
    const code = fakeCodeEntry(async () => quiescentResult('ready'));
    delete code.entry.summaryPolicy;
    const shell = makeShell(code);
    const host = stubSession(roster);
    await shell.init!(host.session);
    await shell.handleBossTurn(
      turn('pin continuity'),
      stubContext([
        captainJson({ action: 'respond', text: 'Pinned.' }),
      ]).context,
    );
    const rejected = stubContext();
    rejected.context.callCaptain = async () => {
      throw new AgentCallSettingsError('temporary tuning mismatch');
    };
    await shell.handleBossTurn(turn('retain continuity', 2), rejected.context);
    const stillRejected = stubContext();
    stillRejected.context.callCaptain = async () => {
      throw new AgentCallSettingsError('temporary tuning mismatch');
    };
    await shell.handleBossTurn(
      turn('/code emit retained ledger', 3),
      stillRejected.context,
    );

    const shellTelemetry = telemetryWithTopic(
      host,
      'playbook.captain.fsm.state',
    );
    expect(shellTelemetry.at(-1)).toMatchObject({
      payload: {
        ledger: { durableConversation: true },
      },
    });

    await shell.dispose?.();
  });

  it('restores one parked root with its session-player continuation', async () => {
    const pendingQuestion = {
      questionId: 'q-1',
      asker: { kind: 'role' as const, roleId: 'coder' },
      question: 'Which target?',
    };
    const sourceCode = fakeCodeEntry(async (runtime, runtimeTurn) => {
      await callPlayerAndCommit(
        runtime,
        'coder',
        'establish root continuation',
        runtimeTurn.signal,
        false,
      );
      await runtime.ports?.emitTelemetry(
        stateTelemetry('ready', {
          pendingBossQuestions: [pendingQuestion],
          lastError: { name: 'TargetError', message: 'target missing' },
        }),
      );
      return quiescentResult('ready');
    });
    const source = makeShell(sourceCode, { sessionIds: [ROOT_ID] });
    await source.init!(stubSession(roster).session);
    const sourceContext = stubContext([
        { status: 'ok', turnId: 1, finalText: 'Implementation is parked.' },
      ]);
    sourceContext.context.callPlayer = async (playerId) => ({
      status: 'ok',
      playerId,
      turnId: 1,
      finalText: 'seeded',
      resumeToken: 'coder-root-token',
    });
    await source.handleBossTurn(turn('/code implement it'), sourceContext.context);
    const runtimeOwnedSnapshot = runtimeSnapshot(
      'code',
      playbookState('ready'),
      {
        turn: 1,
        roleResumeTokens: { coder: 'coder-root-token' },
        pendingBossQuestions: [pendingQuestion],
      },
    );
    sourceCode.runtimes[0]!.snapshot = runtimeOwnedSnapshot;
    const snapshot = source.exportSnapshot();
    expect(snapshot).toMatchObject({
      mode: 'engaged.parked',
      playerSessions: {
        'code-coder': expect.objectContaining({
          resumeToken: 'coder-root-token',
        }),
      },
      pendingBossQuestions: [pendingQuestion],
      lastError: { name: 'TargetError', message: 'target missing' },
      frames: [{ playbookId: 'code', sessionId: ROOT_ID, depth: 0 }],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.captain)).toBe(true);
    expect(
      snapshot?.mode === 'engaged.parked' &&
        Object.isFrozen(snapshot.frames[0]?.runtime),
    ).toBe(true);
    (
      runtimeOwnedSnapshot.roleResumeTokens as Record<string, string>
    ).coder = 'mutated-after-export';
    expect(snapshot).toMatchObject({
      frames: [
        { runtime: { roleResumeTokens: { coder: 'coder-root-token' } } },
      ],
    });

    let restoredToken: string | false | undefined;
    const targetCode = fakeCodeEntry(async (runtime) => {
      restoredToken = runtime.session?.playerSessions?.select('coder');
      return quiescentResult('ready');
    });
    const target = makeShell(targetCode);
    const targetSession = stubSession(roster);
    await target.restore(
      targetSession.session,
      JSON.parse(JSON.stringify(snapshot)) as PlaybookCaptainShellSnapshot,
    );
    expect(targetSession.statuses).toEqual([]);
    expect(targetSession.telemetry).toEqual([]);
    expect(targetCode.runtimes[0]?.restoreCount).toBe(1);
    expect(target.exportSnapshot()).toEqual(snapshot);

    await target.handleBossTurn(
      turn('/code continue', 2),
      stubContext([
        { status: 'ok', turnId: 2, finalText: 'Continued.' },
      ]).context,
    );
    expect(restoredToken).toBe('coder-root-token');

    await source.dispose?.();
    await target.dispose?.();
  });

  it('restores fixed identity while applying current Captain and role tuning', async () => {
    const sourceCode = fakeCodeEntry(async (runtime, runtimeTurn) => {
      await callPlayerAndCommit(
        runtime,
        'coder',
        'pin player under tuning A',
        runtimeTurn.signal,
        false,
      );
      return quiescentResult('ready');
    });
    const fixedPlayer = {
      adapter: 'codex',
      instruction: 'Stable player instruction.',
      permissions: { fileWrite: 'ask' as const },
    };
    const fixedCaptain = {
      adapter: 'claude',
      instruction: 'Stable Captain instruction.',
      permissions: { fileWrite: 'deny' as const },
    };
    const source = makeShell(sourceCode, {
      sessionIds: [ROOT_ID],
      captainAgent: {
        ...fixedCaptain,
        model: { kind: 'value', value: 'captain-a' },
        effort: { kind: 'value', value: 'low' },
      },
      roleTunings: {
        code: {
          coder: {
            model: { kind: 'value', value: 'role-a' },
            effort: { kind: 'value', value: 'low' },
          },
        },
      },
      playerAgents: {
        'code-coder': {
          ...fixedPlayer,
          model: { kind: 'value', value: 'player-default-a' },
          effort: { kind: 'value', value: 'low' },
        },
        'code-reviewer': {
          adapter: 'codex',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        },
      },
    });
    const sourceContext = stubContext([
      { status: 'ok', turnId: 1, finalText: 'Pinned under A.' },
    ]);
    sourceContext.context.callPlayer = async (playerId) => ({
      status: 'ok',
      playerId,
      turnId: 1,
      finalText: 'player A',
      resumeToken: 'player-retained-token',
    });
    await source.init!(stubSession(roster).session);
    await source.handleBossTurn(turn('/code pin A'), sourceContext.context);
    sourceCode.runtimes[0]!.snapshot = runtimeSnapshot(
      'code',
      playbookState('ready'),
      {
        turn: 1,
        roleResumeTokens: { coder: 'player-retained-token' },
      },
    );
    const snapshot = source.exportSnapshot()!;
    expect(JSON.stringify(snapshot)).not.toMatch(/captain-a|role-a|player-default-a/);

    const targetCode = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const result = await runtime.ports!.callPlayer(
        'coder',
        'resume player under tuning B',
        runtimeTurn.signal,
        { resume: runtime.session!.playerSessions!.select('coder') },
      );
      runtime.session!.playerSessions!.update('coder', result.resumeToken);
      return quiescentResult('ready');
    });
    const target = makeShell(targetCode, {
      captainAgent: {
        ...fixedCaptain,
        model: { kind: 'value', value: 'captain-b' },
        effort: { kind: 'value', value: 'high' },
      },
      roleTunings: {
        code: {
          coder: {
            model: { kind: 'provider-default' },
            effort: { kind: 'value', value: 'high' },
          },
        },
      },
      playerAgents: {
        'code-coder': {
          ...fixedPlayer,
          model: { kind: 'value', value: 'player-default-b' },
          effort: { kind: 'value', value: 'high' },
        },
        'code-reviewer': {
          adapter: 'codex',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        },
      },
    });
    await target.restore(stubSession(roster).session, snapshot);
    expect(target.exportSnapshot()).toEqual(snapshot);
    const targetContext = stubContext([
      { status: 'ok', turnId: 2, finalText: 'Continued under B.' },
    ]);
    targetContext.context.callPlayer = async (playerId, _prompt, options) => {
      targetContext.playerCalls.push({ playerId, prompt: 'captured', options });
      return {
        status: 'ok',
        playerId,
        turnId: 2,
        finalText: 'player B',
        resumeToken: 'player-next-token',
      };
    };
    await target.handleBossTurn(turn('/code tune B', 2), targetContext.context);

    expect(targetContext.playerCalls[0]).toMatchObject({
      playerId: 'code-coder',
      options: {
        resume: 'player-retained-token',
        settings: {
          model: { kind: 'provider-default' },
          effort: { kind: 'value', value: 'high' },
          instruction: fixedPlayer.instruction,
          permissions: fixedPlayer.permissions,
        },
      },
    });
    expect(targetContext.captainCalls.at(-1)?.options).toMatchObject({
      resume: 'conversation-1',
      settings: {
        model: { kind: 'value', value: 'captain-b' },
        effort: { kind: 'value', value: 'high' },
        instruction: fixedCaptain.instruction,
        permissions: fixedCaptain.permissions,
      },
    });

    await source.dispose?.();
    await target.dispose?.();
  });

  it('restores a nested parked edge with shared tokens and resumes its original parent once', async () => {
    const callId = 'code:review:1';
    const waiting = playbookState('waitingForReview', {
      tags: ['playbook.suspended'],
    });
    const sourceCode = fakeCodeEntry(async (runtime, runtimeTurn) => {
      const start = await runtime.ports!.callPlaybook(
        { callId, playbookId: 'review', text: 'review this' },
        runtimeTurn.signal,
      );
      if (start.state !== 'suspended') throw new Error('review must park');
      return {
        outcome: 'suspended',
        state: waiting,
        pendingCall: {
          callId,
          playbookId: 'review',
          childSessionId: start.childSessionId,
        },
      };
    });
    const sourceReview = fakePlaybookEntry(
      'review',
      'review',
      async (runtime, runtimeTurn) => {
        await callPlayerAndCommit(
          runtime,
          'reviewer',
          'establish child continuation',
          runtimeTurn.signal,
          false,
        );
        return quiescentResult('ready');
      },
    );
    const source = makeShell([sourceCode, sourceReview], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    await source.init!(stubSession(roster).session);
    const nestedContext = stubContext([
        { status: 'ok', turnId: 1, finalText: 'Review is waiting.' },
      ]);
    nestedContext.context.callPlayer = async (playerId) => ({
      status: 'ok',
      playerId,
      turnId: 1,
      finalText: 'seeded',
      resumeToken: 'shared-reviewer-token',
    });
    await source.handleBossTurn(turn('/code inspect it'), nestedContext.context);
    const projected = { reviewer: 'shared-reviewer-token' };
    sourceCode.runtimes[0]!.snapshot = runtimeSnapshot('code', waiting, {
      turn: 1,
      roleResumeTokens: projected,
      suspendedCall: {
        callId,
        stateId: 'waitingForReview',
        playbookId: 'review',
        text: 'review this',
        childSessionId: CHILD_ID,
        turnId: 1,
      },
    });
    sourceReview.runtimes[0]!.snapshot = runtimeSnapshot(
      'review',
      playbookState('ready'),
      { turn: 1, roleResumeTokens: projected },
    );
    const snapshot = source.exportSnapshot();
    expect(snapshot).toMatchObject({
      mode: 'engaged.parked',
      playerSessions: {
        'code-reviewer': expect.objectContaining({
          resumeToken: 'shared-reviewer-token',
        }),
      },
      frames: [
        {
          playbookId: 'code',
          runtime: { suspendedCall: { callId, childSessionId: CHILD_ID } },
        },
        {
          playbookId: 'review',
          sessionId: CHILD_ID,
          parentSessionId: ROOT_ID,
          parentCallId: callId,
        },
      ],
    });

    const targetCode = fakeCodeEntry(
      undefined,
      undefined,
      undefined,
      async () => quiescentResult('readyAfterReview'),
    );
    const targetReview = fakePlaybookEntry(
      'review',
      'review',
      async () => terminalResult('done', { approved: true }),
    );
    const target = makeShell([targetCode, targetReview]);
    const targetSession = stubSession(roster);
    await target.restore(
      targetSession.session,
      JSON.parse(JSON.stringify(snapshot)) as PlaybookCaptainShellSnapshot,
    );
    expect(targetSession.statuses).toEqual([]);
    expect(targetSession.telemetry).toEqual([]);
    expect(targetCode.runtimes[0]?.restoreCount).toBe(1);
    expect(targetReview.runtimes[0]?.restoreCount).toBe(1);

    await target.handleBossTurn(
      turn('/review finish', 2),
      stubContext([
        { status: 'ok', turnId: 2, finalText: 'Review returned.' },
      ]).context,
    );
    expect(targetReview.runtimes[0]?.inputs).toHaveLength(1);
    expect(targetCode.runtimes[0]?.resumes).toHaveLength(1);
    expect(targetCode.runtimes[0]?.resumes[0]?.callId).toBe(callId);
    expect(
      targetCode.runtimes[0]?.session?.playerSessions?.select('reviewer'),
    ).toBe('shared-reviewer-token');

    const teardownOrder: string[] = [];
    const teardownCode = fakeCodeEntry(
      undefined,
      async () => {
        teardownOrder.push('code');
      },
    );
    const teardownReview = fakePlaybookEntry(
      'review',
      'review',
      undefined,
      async () => {
        teardownOrder.push('review');
      },
    );
    const teardown = makeShell([teardownCode, teardownReview]);
    await teardown.restore(
      stubSession(roster).session,
      JSON.parse(JSON.stringify(snapshot)) as PlaybookCaptainShellSnapshot,
    );
    await teardown.dispose?.();
    expect(teardownOrder).toEqual(['review', 'code']);
    expect(teardownCode.runtimes[0]?.resumes).toEqual([]);

    await source.dispose?.();
    await target.dispose?.();
  });

  it('rejects malformed topology before construction and returns to fresh after clean gated failure', async () => {
    const sourceCode = fakeCodeEntry(async () => quiescentResult('ready'));
    const source = makeShell(sourceCode, { sessionIds: [ROOT_ID] });
    await source.init!(stubSession(roster).session);
    await source.handleBossTurn(
      turn('/code work'),
      stubContext([
        { status: 'ok', turnId: 1, finalText: 'Parked.' },
      ]).context,
    );
    sourceCode.runtimes[0]!.snapshot = runtimeSnapshot(
      'code',
      playbookState('ready'),
      { turn: 1 },
    );
    const valid = source.exportSnapshot()!;
    if (valid.mode !== 'engaged.parked') throw new Error('expected frame');
    const malformed = JSON.parse(JSON.stringify(valid));
    malformed.frames[0].sessionId = SESSION_CAPTAIN_ID;

    let emitOnFirstRestore = true;
    const targetCode = fakeCodeEntry(
      undefined,
      undefined,
      undefined,
      undefined,
      async (_runtime, session) => {
        if (!emitOnFirstRestore) return;
        emitOnFirstRestore = false;
        const signal = new AbortController().signal;
        const calls = [
          () =>
            session.ports.callPlayer(
              'coder',
              'must not reach a player',
              signal,
              { resume: false },
            ),
          () =>
            session.ports.callCaptain('must not reach Captain', signal, {
              visibility: 'hidden',
              resume: false,
            }),
          () => session.ports.callJudge('must not reach a judge', signal),
          () =>
            session.ports.callPlaybook(
              { callId: 'forbidden', playbookId: 'review', text: 'no' },
              signal,
            ),
        ];
        for (const call of calls) {
          try {
            await call();
          } catch {
            // A malicious runtime may swallow a gated call rejection; the
            // shell's attempt latch must still reject the restore.
          }
        }
        await session.ports.emitStatus('must stay gated');
      },
    );
    const target = makeShell(targetCode);
    const rejectedSession = stubSession(roster);
    await expect(
      target.restore(rejectedSession.session, malformed),
    ).rejects.toThrow(/session ids must be unique/);
    expect(targetCode.createRuntime).not.toHaveBeenCalled();
    expect(rejectedSession.statuses).toEqual([]);
    expect(rejectedSession.telemetry).toEqual([]);

    const mismatchedTokens = JSON.parse(JSON.stringify(valid));
    mismatchedTokens.frames[0].runtime.roleResumeTokens = {
      coder: 'not-in-the-root-map',
    };
    await expect(
      target.restore(stubSession(roster).session, mismatchedTokens),
    ).rejects.toThrow(/player tokens do not match session continuation/);
    expect(targetCode.createRuntime).not.toHaveBeenCalled();

    const gatedSession = stubSession(roster);
    await expect(target.restore(gatedSession.session, valid)).rejects.toThrow(
      /attempted a host emission during restore/,
    );
    expect(gatedSession.statuses).toEqual([]);
    expect(gatedSession.telemetry).toEqual([]);
    expect(targetCode.runtimes[0]?.disposeCount).toBe(1);

    const successfulSession = stubSession(roster);
    await target.restore(successfulSession.session, valid);
    expect(successfulSession.statuses).toEqual([]);
    expect(successfulSession.telemetry).toEqual([]);

    await source.dispose?.();
    await target.dispose?.();
  });

  it('cleans Captain, root, and later-child restore failures in strict leaf-to-root order', async () => {
    const snapshot = await nestedSnapshotFixture();
    for (const failing of ['root', 'child'] as const) {
      const events: string[] = [];
      const code = fakeCodeEntry(
        undefined,
        async () => {
          events.push('dispose:code');
        },
        undefined,
        undefined,
        async () => {
          events.push('restore:code');
          if (failing === 'root') throw new Error('root restore failed');
        },
      );
      const review = fakePlaybookEntry(
        'review',
        'review',
        undefined,
        async () => {
          events.push('dispose:review');
        },
        undefined,
        undefined,
        async () => {
          events.push('restore:review');
          if (failing === 'child') throw new Error('child restore failed');
        },
      );
      const captain = fakeSessionCaptain(
        undefined,
        undefined,
        async () => {
          events.push('dispose:captain');
        },
        async () => {
          events.push('restore:captain');
        },
      );
      const shell = makeShell([code, review], {
        createCaptainRuntime: captain.createCaptainRuntime,
      });
      const host = stubSession(roster);
      await expect(shell.restore(host.session, snapshot)).rejects.toThrow(
        new RegExp(`${failing} restore failed`),
      );
      expect(events).toEqual([
        'restore:captain',
        'restore:code',
        ...(failing === 'child' ? ['restore:review'] : []),
        'dispose:review',
        'dispose:code',
        'dispose:captain',
      ]);
      expect(host.statuses).toEqual([]);
      expect(host.telemetry).toEqual([]);
    }
  });

  it('rejects post-restore Captain state, frame state, and token drift before opening the gate', async () => {
    const snapshot = await nestedSnapshotFixture();
    for (const drift of ['captain-state', 'root-state', 'child-token'] as const) {
      const code = fakeCodeEntry(
        undefined,
        undefined,
        undefined,
        undefined,
        async (runtime, _session, restored) => {
          if (drift !== 'root-state') return;
          runtime.snapshot = {
            ...restored,
            state: {
              ...restored.state,
              tags: [...restored.state.tags, 'mutated-after-restore'],
            },
          };
        },
      );
      const review = fakePlaybookEntry(
        'review',
        'review',
        undefined,
        undefined,
        undefined,
        undefined,
        async (runtime, _session, restored) => {
          if (drift !== 'child-token') return;
          runtime.snapshot = {
            ...restored,
            roleResumeTokens: { reviewer: 'mutated-after-restore' },
          };
        },
      );
      const captain = fakeSessionCaptain(
        undefined,
        undefined,
        undefined,
        async (runtime, _session, restored) => {
          if (drift !== 'captain-state') return;
          runtime.snapshot = {
            ...restored,
            state: {
              ...restored.state,
              tags: [...restored.state.tags, 'mutated-after-restore'],
            },
          };
        },
      );
      const shell = makeShell([code, review], {
        createCaptainRuntime: captain.createCaptainRuntime,
      });
      const host = stubSession(roster);
      await expect(shell.restore(host.session, snapshot)).rejects.toThrow(
        /changed snapshot field/,
      );
      expect(host.statuses).toEqual([]);
      expect(host.telemetry).toEqual([]);
      expect(code.runtimes[0]?.disposeCount).toBe(1);
      expect(review.runtimes[0]?.disposeCount).toBe(1);
      expect(captain.runtimes[0]?.disposeCount).toBe(1);
    }
  });

  it('rejects the complete schema, identity, topology, and token mutation matrix before runtime construction', async () => {
    const base = await nestedSnapshotFixture();
    const clone = (): any => JSON.parse(JSON.stringify(base));
    const loadModule = vi.fn(async () => {
      throw new Error('intrinsic validation must precede import');
    });
    const preImportShell = makeShell(
      [fakeCodeEntry(), fakePlaybookEntry('review', 'review')],
      { loadModule },
    );
    await expect(
      preImportShell.restore(
        stubSession(roster).session,
        Object.assign(clone(), { schemaVersion: 9 }),
      ),
    ).rejects.toThrow(/schemaVersion/);
    expect(loadModule).not.toHaveBeenCalled();

    const mutations: readonly [string, () => unknown][] = [
      ['schema version', () => Object.assign(clone(), { schemaVersion: 9 })],
      ['unknown field', () => Object.assign(clone(), { ledger: {} })],
      ['chat with engagement members', () => Object.assign(clone(), { mode: 'chat' })],
      ['conversation/history mismatch', () => {
        const value = clone();
        value.captain.conversation = { kind: 'unopened' };
        return value;
      }],
      ['journal sequence gap', () => {
        const value = clone();
        value.journal[0].seq = 2;
        return value;
      }],
      ['journal turn gap', () => {
        const value = clone();
        value.journal[0].turnId = 2;
        return value;
      }],
      ['journal counter mismatch', () => {
        const value = clone();
        value.sequences.journal++;
        return value;
      }],
      ['Captain turn mismatch', () => {
        const value = clone();
        value.captain.runtime.sequences.turn++;
        return value;
      }],
      ['Captain schema downgrade', () => {
        const value = clone();
        value.captain.runtime.schemaVersion = 1;
        return value;
      }],
      ['Captain player token', () => {
        const value = clone();
        value.captain.runtime.roleResumeTokens = { captain: 'token' };
        return value;
      }],
      ['duplicate issued UUID', () => {
        const value = clone();
        value.issuedSessionIds.push(ROOT_ID);
        return value;
      }],
      ['Captain UUID reused by root', () => {
        const value = clone();
        value.frames[0].sessionId = SESSION_CAPTAIN_ID;
        value.frames[0].rootSessionId = SESSION_CAPTAIN_ID;
        value.frames[1].rootSessionId = SESSION_CAPTAIN_ID;
        value.frames[1].parentSessionId = SESSION_CAPTAIN_ID;
        return value;
      }],
      ['live UUID absent from issued set', () => {
        const value = clone();
        value.issuedSessionIds = value.issuedSessionIds.filter(
          (id: string) => id !== CHILD_ID,
        );
        return value;
      }],
      ['disabled frame playbook', () => {
        const value = clone();
        value.frames[1].playbookId = 'missing';
        value.frames[1].runtime.playbookId = 'missing';
        value.frames[0].runtime.suspendedCall.playbookId = 'missing';
        return value;
      }],
      ['runtime/playbook mismatch', () => {
        const value = clone();
        value.frames[0].runtime.playbookId = 'review';
        return value;
      }],
      ['frame depth gap', () => {
        const value = clone();
        value.frames[1].depth = 2;
        return value;
      }],
      ['parent session mismatch', () => {
        const value = clone();
        value.frames[1].parentSessionId = CHILD_ID;
        return value;
      }],
      ['parent call mismatch', () => {
        const value = clone();
        value.frames[1].parentCallId = 'other-call';
        return value;
      }],
      ['descriptor child mismatch', () => {
        const value = clone();
        value.frames[0].runtime.suspendedCall.childSessionId = ROOT_ID;
        return value;
      }],
      ['non-leaf descriptor removed', () => {
        const value = clone();
        delete value.frames[0].runtime.suspendedCall;
        value.frames[0].runtime.state.tags = ['playbook.parked'];
        return value;
      }],
      ['dangling leaf descriptor', () => {
        const value = clone();
        value.frames[1].runtime.state = playbookState('waitingForChild', {
          tags: ['playbook.suspended'],
        });
        value.frames[1].runtime.sequences.playbookCall = 1;
        value.frames[1].runtime.suspendedCall = {
          callId: 'review:child:1',
          stateId: 'waitingForChild',
          playbookId: 'code',
          text: 'nested again',
          childSessionId: '30000000-0000-4000-8000-000000000003',
          turnId: 1,
        };
        return value;
      }],
      ['leaf not parked', () => {
        const value = clone();
        value.frames[1].runtime.state.tags = [];
        return value;
      }],
      ['unknown player-ledger entry', () => {
        const value = clone();
        value.playerSessions['missing-player'] = {
          adapter: 'claude',
          resumeToken: 'token',
        };
        return value;
      }],
      ['live token projection mismatch', () => {
        const value = clone();
        value.frames[1].runtime.roleResumeTokens.reviewer = 'other-token';
        return value;
      }],
      ['undefined value', () => {
        const value = clone();
        value.lastAction = undefined;
        return value;
      }],
      ['non-finite number', () => {
        const value = clone();
        value.sequences.turn = Number.NaN;
        return value;
      }],
      ['sparse array', () => {
        const value = clone();
        delete value.issuedSessionIds[1];
        return value;
      }],
      ['accessor', () => {
        const value = clone();
        Object.defineProperty(value, 'lastAction', {
          enumerable: true,
          get: () => 'respond',
        });
        return value;
      }],
      ['cycle', () => {
        const value = clone();
        value.journal[0].payload = value;
        return value;
      }],
      ['non-plain instance', () => Object.assign(new Date(), clone())],
    ];

    for (const [name, makeCandidate] of mutations) {
      const code = fakeCodeEntry();
      const review = fakePlaybookEntry('review', 'review');
      const captain = fakeSessionCaptain();
      const shell = makeShell([code, review], {
        createCaptainRuntime: captain.createCaptainRuntime,
      });
      await expect(
        shell.restore(
          stubSession(roster).session,
          makeCandidate() as PlaybookCaptainShellSnapshot,
        ),
        name,
      ).rejects.toBeDefined();
      expect(captain.createCaptainRuntime, name).not.toHaveBeenCalled();
      expect(code.createRuntime, name).not.toHaveBeenCalled();
      expect(review.createRuntime, name).not.toHaveBeenCalled();
    }

    // A configured token retained for a returned child is valid even though
    // neither live frame projects that child's own effective host binding.
    const code = fakeCodeEntry();
    const review = fakePlaybookEntry('review', 'review');
    const valid = makeShell([code, review]);
    await expect(valid.restore(stubSession(roster).session, base)).resolves.toBeUndefined();
    await valid.dispose?.();
  });

  it('claims restore before its first await and rejects already-aborted host sessions', async () => {
    const source = makeShell(fakeCodeEntry());
    await source.init!(stubSession(roster).session);
    const snapshot = source.exportSnapshot()!;
    const registry = fakeCodeEntry();
    const imported = deferred<unknown>();
    const target = createPlaybookCaptainShell(
      {
        playbooks: {
          code: {
            from: 'test://code',
            roles: {
              coder: {
                playerId: 'code-coder',
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
              reviewer: {
                playerId: 'code-reviewer',
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
            },
            options: {},
          },
        },
        sessionAgents: {
          captain: {
            adapter: 'claude',
            model: { kind: 'provider-default' },
            effort: { kind: 'provider-default' },
          },
          players: {
            'code-coder': {
              adapter: 'claude',
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
            'code-reviewer': {
              adapter: 'codex',
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
          },
        },
        captainAdapter: 'claude',
      },
      {
        loadModule: async () => imported.promise,
      },
    );
    const targetSession = stubSession(roster);
    const restoring = target.restore(targetSession.session, snapshot);
    await expect(
      target.restore(stubSession(roster).session, snapshot),
    ).rejects.toThrow(/fresh shell/);
    await expect(target.init!(stubSession(roster).session)).rejects.toThrow(
      /fresh instance/,
    );
    await expect(target.dispose?.()).rejects.toThrow(/setup is in progress/);
    imported.resolve({ default: registry.entry });
    await restoring;

    const abortedSession = {
      ...stubSession(roster).session,
      signal: AbortSignal.abort(),
    };
    const fresh = makeShell(fakeCodeEntry());
    await expect(fresh.init!(abortedSession)).rejects.toThrow(
      /aborted Captain session/,
    );
    await expect(fresh.restore(abortedSession, snapshot)).rejects.toThrow(
      /aborted Captain session/,
    );

    await source.dispose?.();
    await target.dispose?.();
  });

  it('keeps a removed historical frame UUID unavailable to later allocation', async () => {
    const nested = await nestedSnapshotFixture();
    if (nested.mode !== 'engaged.parked') throw new Error('expected frames');
    const snapshot: PlaybookCaptainShellSnapshot = {
      ...nested,
      frames: [
        {
          ...nested.frames[0]!,
          runtime: runtimeSnapshot('code', playbookState('ready'), {
            turn: 1,
            roleResumeTokens: { reviewer: 'shared-token' },
          }),
        },
      ],
    };
    const code = fakeCodeEntry();
    const review = fakePlaybookEntry('review', 'review');
    const modules: Record<string, unknown> = {
      'test://code': { default: code.entry },
      'test://review': { default: review.entry },
    };
    const shell = createPlaybookCaptainShell(
      {
        playbooks: {
          code: {
            from: 'test://code',
            roles: {
              coder: {
                playerId: 'code-coder',
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
              reviewer: {
                playerId: 'code-reviewer',
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
            },
            options: {},
          },
          review: {
            from: 'test://review',
            roles: {
              coder: {
                playerId: 'code-coder',
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
              reviewer: {
                playerId: 'code-reviewer',
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
            },
            options: {},
          },
        },
        sessionAgents: {
          captain: {
            adapter: 'claude',
            model: { kind: 'provider-default' },
            effort: { kind: 'provider-default' },
          },
          players: {
            'code-coder': {
              adapter: 'claude',
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
            'code-reviewer': {
              adapter: 'codex',
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
          },
        },
        captainAdapter: 'claude',
      },
      {
        loadModule: async (specifier) => modules[specifier],
        // Restore allocates nothing. The next root allocation deliberately
        // proposes the removed root's historical UUID and must be rejected.
        createSessionId: () => ROOT_ID,
      },
    );
    const host = stubSession(roster);
    await shell.restore(host.session, snapshot);
    await shell.handleBossTurn(
      turn('stop the current work', 2),
      stubContext([
        captainJson({ action: 'dismiss' }),
        { status: 'ok', turnId: 2, finalText: 'Stopped.' },
      ]).context,
    );
    expect(code.runtimes[0]?.disposeCount).toBe(1);

    await shell.handleBossTurn(
      turn('/code start again', 3),
      stubContext([
        { status: 'ok', turnId: 3, finalText: 'Could not restart.' },
      ]).context,
    );
    expect(code.createRuntime).toHaveBeenCalledTimes(1);
    expect(host.statuses.filter(({ message }) => message.endsWith('started'))).toEqual([]);

    await shell.dispose?.();
  });

  it('fails closed at every unsafe capture category without changing the active work', async () => {
    const captures = new Map<string, PlaybookCaptainShellSnapshot | undefined>();
    let shell!: ReturnType<typeof createPlaybookCaptainShell>;
    const capture = (name: string): void => {
      captures.set(name, shell.exportSnapshot());
    };
    const code = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        capture('engaged.driving');
        const hostCall = runtime.ports!.callCaptain(
          'runtime queue probe',
          runtimeTurn.signal,
          ISOLATED_HIDDEN_CAPTAIN_OPTIONS,
        );
        capture('queued-or-in-flight-host-work');
        await hostCall;
        const start = await runtime.ports!.callPlaybook(
          {
            callId: 'code:review:unsafe',
            playbookId: 'review',
            text: 'review it',
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') throw new Error('review must park');
        return suspendedResult({
          callId: 'code:review:unsafe',
          playbookId: 'review',
          childSessionId: start.childSessionId,
        });
      },
      async () => {
        capture('disposal');
      },
      undefined,
      async () => quiescentResult('readyAfterReview'),
    );
    const review = fakePlaybookEntry(
      'review',
      'review',
      async (_runtime, runtimeTurn) =>
        runtimeTurn.text === 'finish'
          ? terminalResult('done')
          : quiescentResult('ready'),
      async () => {
        capture('frame-removal');
      },
      async () => {
        capture('opening-child');
      },
    );
    shell = makeShell([code, review], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    await shell.init!(stubSession(roster).session);
    const chat = stubContext(
      [captainJson({ action: 'respond', text: 'Ready.' })],
      (prompt) => {
        if (isDecisionPrompt(prompt)) capture('controller-call-transient');
      },
    );
    await shell.handleBossTurn(turn('hello'), chat.context);

    const start = stubContext(
      [{ status: 'ok', turnId: 2, finalText: 'Review is parked.' }],
      (prompt) => {
        if (isClosingReplyPrompt(prompt)) capture('turn-summary-transient');
      },
    );
    await shell.handleBossTurn(turn('/code start nested', 2), start.context);
    await shell.handleBossTurn(
      turn('/review finish', 3),
      stubContext([
        { status: 'ok', turnId: 3, finalText: 'Review returned.' },
      ]).context,
    );
    await shell.dispose?.();

    expect([...captures.keys()].sort()).toEqual(
      [
        'controller-call-transient',
        'disposal',
        'engaged.driving',
        'frame-removal',
        'opening-child',
        'queued-or-in-flight-host-work',
        'turn-summary-transient',
      ].sort(),
    );
    for (const value of captures.values()) expect(value).toBeUndefined();
    expect(code.runtimes).toHaveLength(1);
    expect(review.runtimes).toHaveLength(1);
    expect(code.runtimes[0]?.resumes).toHaveLength(1);
  });

  it.each(['status', 'telemetry'] as const)(
    'drains a fire-and-forget working-frame %s emission before the turn becomes snapshot-safe',
    async (kind) => {
      const emissionStarted = deferred<void>();
      const releaseEmission = deferred<void>();
      const turnWorkCompleted = deferred<void>();
      const code = fakeCodeEntry(async (runtime) => {
        if (kind === 'status') {
          void runtime.ports!.emitStatus('deferred runtime status');
        } else {
          void runtime.ports!.emitTelemetry({
            topic: 'test.deferred-runtime-telemetry',
            payload: { deferred: true },
          });
        }
        return quiescentResult('ready');
      });
      const shell = makeShell(code, { sessionIds: [ROOT_ID] });
      const host = stubSession(roster);
      const originalStatus = host.session.emitStatus.bind(host.session);
      const originalTelemetry = host.session.emitTelemetry.bind(host.session);
      host.session.emitStatus = async (message, data) => {
        if (message === 'deferred runtime status') {
          emissionStarted.resolve(undefined);
          await releaseEmission.promise;
        }
        await originalStatus(message, data);
      };
      host.session.emitTelemetry = async (event) => {
        if (event.topic === 'test.deferred-runtime-telemetry') {
          emissionStarted.resolve(undefined);
          await releaseEmission.promise;
        }
        await originalTelemetry(event);
      };
      await shell.init!(host.session);
      let turnSettled = false;
      const context = stubContext([
        { status: 'ok', turnId: 1, finalText: 'Emission drained.' },
      ]);
      const originalReply = context.context.emitReply.bind(context.context);
      context.context.emitReply = async (text) => {
        await originalReply(text);
        turnWorkCompleted.resolve(undefined);
      };
      const running = shell
        .handleBossTurn(turn('/code emit'), context.context)
        .then(() => {
          turnSettled = true;
        });
      await emissionStarted.promise;
      await turnWorkCompleted.promise;
      // The normal action, settlement, and Boss presentation are complete.
      // Give an untracked implementation a full task in which to settle, so
      // this assertion is specifically pinned to the outstanding emission.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(turnSettled).toBe(false);
      expect(shell.exportSnapshot()).toBeUndefined();

      releaseEmission.resolve(undefined);
      await running;
      code.runtimes[0]!.snapshot = runtimeSnapshot(
        'code',
        playbookState('ready'),
        { turn: 1 },
      );
      expect(shell.exportSnapshot()).toBeDefined();
      await shell.dispose?.();
    },
  );

  it('drains fire-and-forget session-Captain telemetry after ordinary turn work completes', async () => {
    const emissionStarted = deferred<void>();
    const releaseEmission = deferred<void>();
    const turnWorkCompleted = deferred<void>();
    const captain = fakeSessionCaptain(async (runtime) => {
      void runtime.ports!.emitTelemetry({
        topic: 'test.deferred-captain-telemetry',
        payload: { deferred: true },
      });
      return quiescentResult();
    });
    const shell = makeShell(fakeCodeEntry(), {
      createCaptainRuntime: captain.createCaptainRuntime,
    });
    const host = stubSession(roster);
    const originalTelemetry = host.session.emitTelemetry.bind(host.session);
    host.session.emitTelemetry = async (event) => {
      if (event.topic === 'test.deferred-captain-telemetry') {
        emissionStarted.resolve(undefined);
        await releaseEmission.promise;
      }
      await originalTelemetry(event);
    };
    await shell.init!(host.session);

    const context = stubContext();
    const originalReply = context.context.emitReply.bind(context.context);
    context.context.emitReply = async (text) => {
      await originalReply(text);
      turnWorkCompleted.resolve(undefined);
    };
    let turnSettled = false;
    const running = shell
      .handleBossTurn(turn('captain telemetry probe'), context.context)
      .then(() => {
        turnSettled = true;
      });
    await emissionStarted.promise;
    await turnWorkCompleted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(turnSettled).toBe(false);
    expect(shell.exportSnapshot()).toBeUndefined();

    releaseEmission.resolve(undefined);
    await running;
    captain.runtimes[0]!.snapshot = runtimeSnapshot(
      'captain',
      playbookState('ready'),
      { turn: 1 },
    );
    expect(shell.exportSnapshot()).toMatchObject({
      mode: 'chat',
      sequences: { turn: 1 },
      captain: { conversation: { kind: 'needsSeeding' } },
    });
    await shell.dispose?.();
  });

  it('returns undefined during an active turn and permanently closes after disposal', async () => {
    const waiting = deferred<PlaybookRunResult>();
    const registry = fakeCodeEntry(async () => waiting.promise);
    const shell = makeShell(registry, { sessionIds: [ROOT_ID] });
    await shell.init!(stubSession(roster).session);
    const running = shell.handleBossTurn(
      turn('/code wait'),
      stubContext([
        { status: 'ok', turnId: 1, finalText: 'Settled.' },
      ]).context,
    );
    await vi.waitFor(() => expect(registry.runtimes).toHaveLength(1));
    expect(shell.exportSnapshot()).toBeUndefined();
    waiting.resolve(quiescentResult('ready'));
    await running;
    registry.runtimes[0]!.snapshot = runtimeSnapshot(
      'code',
      playbookState('ready'),
      { turn: 1 },
    );
    expect(shell.exportSnapshot()).toBeDefined();
    await shell.dispose?.();
    expect(shell.exportSnapshot()).toBeUndefined();
    await expect(
      shell.restore(stubSession(roster).session, {} as PlaybookCaptainShellSnapshot),
    ).rejects.toThrow(/fresh shell/);

    const disposedFresh = makeShell(fakeCodeEntry());
    await disposedFresh.dispose?.();
    await expect(disposedFresh.init!(stubSession(roster).session)).rejects.toThrow(
      /fresh instance/,
    );
  });

  it('aggregates restore cleanup failure and leaves the shell permanently closed', async () => {
    const source = makeShell(fakeCodeEntry());
    await source.init!(stubSession(roster).session);
    const snapshot = source.exportSnapshot()!;
    const poisonedCaptain = fakeSessionCaptain(
      undefined,
      undefined,
      async () => {
        throw new Error('Captain cleanup failed');
      },
      async () => {
        throw new Error('Captain restore failed');
      },
    );
    const target = makeShell(fakeCodeEntry(), {
      createCaptainRuntime: poisonedCaptain.createCaptainRuntime,
    });
    const targetSession = stubSession(roster);

    await expect(target.restore(targetSession.session, snapshot)).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Captain shell restore and cleanup failed',
      errors: [
        expect.objectContaining({ message: 'Captain restore failed' }),
        expect.objectContaining({ message: 'Captain cleanup failed' }),
      ],
    });
    expect(targetSession.statuses).toEqual([]);
    expect(targetSession.telemetry).toEqual([]);
    await expect(target.restore(stubSession(roster).session, snapshot)).rejects.toThrow(
      /fresh shell/,
    );

    await source.dispose?.();
  });
});

describe('Playbook Captain public module surface (CAPTAIN-18)', () => {
  it('resolves the package shell export as a CODE-registered Captain factory', async () => {
    const mod = await import('@sublang/playbook/playbook-captain');
    const shell = mod.default({
      playbooks: {
        code: {
          from: '@sublang/playbook/code/registry',
          roles: {
            coder: {
              playerId: 'code-coder',
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
          },
          options: {},
        },
      },
      sessionAgents: {
        captain: {
          adapter: 'claude',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        },
        players: {
          'code-coder': {
            adapter: 'claude',
            model: { kind: 'provider-default' },
            effort: { kind: 'provider-default' },
          },
        },
      },
      captainAdapter: 'claude',
    });
    const session = stubSession([
      { id: 'code-coder', adapter: 'claude' },
    ]);
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code'), context.context);

    // CAPTAIN-7: a bare enabled command settles as one durable prose call.
    expect(context.captainCalls).toHaveLength(1);
    expect(context.captainCalls[0]?.prompt).toContain(
      'Boss issued a registered command that produces no action this turn',
    );
    expect(context.replies).toHaveLength(1);
  });
});
