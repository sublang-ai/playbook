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
  PlayerRunResult,
  TmuxPlayRecord,
} from '@sublang/cligent/tmux-play';
import { createTmuxPlayRuntime } from '@sublang/cligent/tmux-play';
import type {
  JsonValue,
  PlaybookCallResult,
  PlaybookPorts,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookSession,
  PlaybookState,
} from '../../../src/runtime.js';
import {
  createPlaybookCaptainShell,
  type PlaybookCaptainDeps,
  type PlaybookCaptainRegistryEntry,
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
    options: { resume?: string | false } | undefined;
  }[];
  captainCalls: { prompt: string; options?: CaptainCallOptions }[];
  visiblePlayers: string[][];
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

const ISOLATED_HIDDEN_CAPTAIN_OPTIONS = {
  visibility: 'hidden',
  resume: false,
  allowedTools: [],
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
  disposeCount = 0;

  constructor(
    private readonly handleHook?: HandleHook,
    private readonly disposeHook?: DisposeHook,
    private readonly initHook?: InitHook,
    private readonly resumeHook?: ResumeHook,
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

function stubContext(
  captainReplies: CaptainReply[] = [],
  onCaptainCall?: CaptainCallHook,
): StubContext {
  const controller = new AbortController();
  const playerCalls: StubContext['playerCalls'] = [];
  const captainCalls: StubContext['captainCalls'] = [];
  const visiblePlayers: StubContext['visiblePlayers'] = [];
  let captainIndex = 0;
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
      callCaptain: async (prompt, options): Promise<CaptainRunResult> => {
        captainCalls.push({ prompt, options });
        onCaptainCall?.(prompt, options);
        if (isTurnSummaryPrompt(prompt)) {
          return {
            status: 'ok',
            turnId: 1,
            finalText: 'summary done',
          };
        }
        const scripted = captainReplies[captainIndex++];
        if (typeof scripted === 'function') {
          return scripted(prompt, options);
        }
        if (scripted) return scripted;
        return {
          status: 'ok',
          turnId: 1,
          finalText: 'captain done',
        };
      },
    },
    controller,
    playerCalls,
    captainCalls,
    visiblePlayers,
  };
}

function fakeCodeEntry(
  handleHook?: HandleHook,
  disposeHook?: DisposeHook,
  initHook?: InitHook,
  resumeHook?: ResumeHook,
): {
  entry: PlaybookCaptainRegistryEntry;
  validateOptions: ReturnType<typeof vi.fn>;
  createRuntime: ReturnType<typeof vi.fn>;
  runtimes: FakeRuntime[];
} {
  const runtimes: FakeRuntime[] = [];
  const validateOptions = vi.fn();
  const createRuntime = vi.fn(() => {
    const runtime = new FakeRuntime(
      handleHook,
      disposeHook,
      initHook,
      resumeHook,
    );
    runtimes.push(runtime);
    return runtime;
  });
  return {
    entry: {
      id: 'code',
      command: 'code',
      intent: 'software development / SDLC coding workflow',
      requiredRoleIds: ['coder', 'reviewer'],
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
): ReturnType<typeof fakeCodeEntry> {
  const registry = fakeCodeEntry(handleHook, disposeHook, initHook, resumeHook);
  registry.entry.id = id;
  registry.entry.command = command;
  registry.entry.intent = `${id} playbook`;
  return registry;
}

function fakeInternalCaptain(
  handleHook?: HandleHook,
  resumeHook?: ResumeHook,
  disposeHook?: DisposeHook,
) {
  const runtimes: FakeRuntime[] = [];
  const createCaptainRuntime = vi.fn(
    (
      _options: Parameters<
        NonNullable<PlaybookCaptainDeps['createCaptainRuntime']>
      >[0],
    ) => {
      const runtime = new FakeRuntime(
        handleHook,
        disposeHook,
        undefined,
        resumeHook,
      );
      runtimes.push(runtime);
      return runtime;
    },
  );
  return { createCaptainRuntime, runtimes };
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
  } = {},
) {
  const list = Array.isArray(entries) ? entries : [entries];
  const modules: Record<string, unknown> = {};
  const playbooks: Record<string, unknown> = {};
  for (const r of list) {
    const from = `test://${r.entry.id}`;
    modules[from] = { default: r.entry };
    playbooks[r.entry.id] = {
      from,
      ...(opts.commands?.[r.entry.id]
        ? { command: opts.commands[r.entry.id] }
        : {}),
      options: opts.options ?? {},
    };
  }
  let sessionSequence = 0;
  const sessionIds = opts.sessionIds;
  return createPlaybookCaptainShell(
    {
      playbooks,
      ...(opts.captainAdapter === undefined
        ? {}
        : { captainAdapter: opts.captainAdapter }),
    },
    {
      loadModule: async (specifier: string) => {
        if (specifier in modules) return modules[specifier];
        throw new Error(`no module ${specifier}`);
      },
      createSessionId: () =>
        sessionIds?.shift() ??
        `00000000-0000-4000-8000-${String(++sessionSequence).padStart(12, '0')}`,
      ...(opts.createCaptainRuntime
        ? { createCaptainRuntime: opts.createCaptainRuntime }
        : {}),
    },
  );
}

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

function isTurnSummaryPrompt(prompt: string): boolean {
  return prompt.includes('turn-summary block') && prompt.includes('Saved you ');
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
    // Host players bound to local roles: ids re-keyed, host adapter carried.
    expect(registry.createRuntime).toHaveBeenCalledWith({
      captainOptions: {},
      players: [
        { id: 'coder', adapter: 'claude' },
        { id: 'reviewer', adapter: 'codex' },
      ],
    });
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

  it('bare /code engages CODE and uses visible Captain chat without dispatch', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code'), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs).toEqual([]);
    expect(context.captainCalls).toHaveLength(1);
    expect(context.captainCalls[0]?.options).toEqual(
      ISOLATED_VISIBLE_CAPTAIN_OPTIONS,
    );
    expect(context.captainCalls[0]?.prompt).toContain('visible Boss chat');
    expect(context.captainCalls[0]?.prompt).toContain(
      'Ask what task to run with /code.',
    );
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
  it('ignores idle whitespace without allocating an internal Captain root', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain();
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('   \n\t'), context.context);

    expect(internal.createCaptainRuntime).not.toHaveBeenCalled();
    expect(registry.createRuntime).not.toHaveBeenCalled();
    expect(context.captainCalls).toEqual([]);
    expect(session.statuses).toEqual([]);
    expect(session.telemetry).toEqual([]);
  });

  // CAPTAIN-33 (DR-013 A1): an empty allowlist means "no tools" and is
  // distinct from omission, which grants the adapter's full tool surface.
  // Request it only where the adapter can enforce it.
  // DEFERRED — IR-036 task 4 (shell controller rework): this row drives the
  // real compiled captain artifact, which now implements the DR-029
  // controller policy (hidden decision calls over the controller port); the
  // retired visible-router flow scripted here is rewritten with the shell.
  // The A1 tool posture at the new layer is pinned by
  // reference/sdlc/captain.playbook/captain.playbook.integration.test.ts.
  it.skip.each([
    { label: 'no captainAdapter', captainAdapter: undefined },
    { label: 'an enforcing adapter', captainAdapter: 'claude' },
    { label: 'an unrecognized adapter', captainAdapter: 'future-agent' },
  ])(
    'requests the enforced empty tool allowlist with $label',
    async ({ captainAdapter }) => {
      const registry = fakeCodeEntry();
      const shell = makeShell(registry, {
        ...(captainAdapter === undefined ? {} : { captainAdapter }),
      });
      const session = stubSession();
      const question = 'Should I route this to the CODE workflow?';
      const context = stubContext([
        (_prompt, options) => {
          expect(options).toEqual(ISOLATED_VISIBLE_CAPTAIN_OPTIONS);
          return { status: 'ok', turnId: 1, finalText: question };
        },
        (_prompt, options) => {
          expect(options).toEqual(ISOLATED_HIDDEN_CAPTAIN_OPTIONS);
          return captainJson({ guard: 'question' });
        },
      ]);

      await shell.init!(session.session);
      await shell.handleBossTurn(turn('route this'), context.context);

      expect(context.captainCalls).toHaveLength(2);
      for (const { options } of context.captainCalls) {
        expect(options?.allowedTools).toEqual([]);
      }
    },
  );

  // DEFERRED — IR-036 task 4 (shell controller rework): drives the real
  // compiled captain, whose retired visible-router flow this scripts.
  it.skip('omits allowedTools for an adapter that cannot enforce it', async () => {
    const registry = fakeCodeEntry();
    // Cligent's codex adapter rejects any tool list outright, so requesting
    // one would fail every control call before the model is reached.
    const shell = makeShell(registry, { captainAdapter: 'codex' });
    const session = stubSession();
    const question = 'Should I route this to the CODE workflow?';
    const context = stubContext([
      (_prompt, options) => {
        expect(options).toEqual({ visibility: 'visible', resume: false });
        return { status: 'ok', turnId: 1, finalText: question };
      },
      (prompt, options) => {
        expect(options).toEqual({ visibility: 'hidden', resume: false });
        // Isolation degrades to the authored prompt-level restriction.
        expect(prompt).toContain('Do not use tools.');
        return captainJson({ guard: 'question' });
      },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('route this'), context.context);

    expect(context.captainCalls).toHaveLength(2);
    for (const { options } of context.captainCalls) {
      expect(options).not.toHaveProperty('allowedTools');
      // Every other isolation guarantee is unchanged.
      expect(options?.resume).toBe(false);
    }
  });

  // CAPTAIN-33 (DR-013 A1) — the adapter-conditional tool posture the two
  // deferred rows above scripted through the now-retired visible-router
  // flow. The posture itself is live and unchanged (`controlCallToolOptions`
  // in playbook-captain.ts), so it stays pinned here through the hidden
  // lifecycle classifier over a fake runtime — a path that does not depend
  // on the compiled Captain's retired routing errand and so survives the
  // IR-036 task-4 shell rework independently of it.
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
      const context = stubContext([captainJson({ decision: 'dismiss' })]);

      await shell.init!(session.session);
      await shell.handleBossTurn(turn('/code first task'), context.context);
      await shell.handleBossTurn(turn('dismiss this', 2), context.context);

      expect(context.captainCalls).toHaveLength(1);
      const options = context.captainCalls[0]?.options;
      expect(options).toEqual(
        enforced
          ? ISOLATED_HIDDEN_CAPTAIN_OPTIONS
          : // Cligent's Codex adapter rejects any tool list outright, so
            // requesting one would fail the control call before the model.
            { visibility: 'hidden', resume: false },
      );
      // An empty allowlist means "no tools" and is distinct from omission,
      // which grants the adapter's full native tool surface. `toEqual`
      // ignores an explicitly-undefined key, so assert presence directly.
      expect(
        options !== undefined && Object.hasOwn(options, 'allowedTools'),
      ).toBe(enforced);
    },
  );

  // DEFERRED — IR-036 task 4 (shell controller rework): the DR-005 routing
  // question and awaitBossReply parking are retired by the DR-029 session
  // loop (a clarifying question to Boss is a `respond` selection); the
  // exact-text entry pin moves to the controller suites.
  it.skip('enters exact Boss text directly and parks on a routing question', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession();
    const bossText = 'Route THIS request exactly: preserve /slashes and CASE.';
    const question = 'Should I route this to the CODE workflow?';
    const context = stubContext([
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_VISIBLE_CAPTAIN_OPTIONS);
        expect(prompt).toContain(`Boss intent: ${bossText}`);
        expect(prompt).not.toContain('nextPlaybookId');
        expect(prompt).not.toContain('remainingPlan');
        return { status: 'ok', turnId: 1, finalText: question };
      },
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_HIDDEN_CAPTAIN_OPTIONS);
        expect(prompt).toContain(question);
        return captainJson({ guard: 'question' });
      },
    ]);

    await shell.init!(session.session);
    await expect(
      shell.handleBossTurn(turn(bossText), context.context),
    ).resolves.toBeUndefined();

    expect(context.captainCalls).toHaveLength(2);
    expect(
      context.captainCalls.some(({ prompt }) =>
        prompt.includes('Boss-event classifier'),
      ),
    ).toBe(false);
    expect(registry.createRuntime).not.toHaveBeenCalled();
    expect(session.statuses).toEqual([]);
    expect(
      JSON.stringify(telemetryWithTopic(session, 'playbook.fsm.state')),
    ).toContain(question);
    expect(
      telemetryWithTopic(session, 'playbook.captain.fsm.state').at(-1),
    ).toMatchObject({
      payload: {
        to: 'engaged.parked',
        ledger: { mode: 'engaged.parked', stackDepth: 1 },
      },
    });
    await shell.prepareDispose!();
  });

  // DEFERRED — IR-036 task 4 (shell controller rework): the compiled
  // Captain no longer calls playbooks itself — `callPlaybook` is not
  // reachable from the controller (CAPTAIN-11); the shell executes a
  // validated `start` selection instead.
  it.skip('routes the real default Captain through a child before meaningful completion', async () => {
    const bossText =
      'Review parseAdjudication for prototype-chain guard lookup; keep this punctuation: /**proto**.';
    const childInput =
      'Review parseAdjudication for prototype-chain guard lookup and report the concrete conclusion.';
    const registry = fakeCodeEntry(async (_runtime, runtimeTurn) => {
      expect(runtimeTurn.text).toBe(childInput);
      return terminalResult('done', {
        conclusion: 'Use an own-property membership check for declared guards.',
      });
    });
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry, {
      sessionIds: ['10000000-0000-4000-8000-000000000001'],
    });
    const session = stubSession();
    const context = stubContext([
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_VISIBLE_CAPTAIN_OPTIONS);
        expect(prompt).toContain(`Boss intent: ${bossText}`);
        expect(prompt).toContain('"id":"code"');
        expect(prompt).not.toContain('nextPlaybookId');
        expect(prompt).not.toContain('remainingPlan');
        return {
          status: 'ok',
          turnId: 1,
          finalText: 'I will route this review to the CODE playbook.',
        };
      },
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_HIDDEN_CAPTAIN_OPTIONS);
        expect(prompt).toContain(
          'I will route this review to the CODE playbook.',
        );
        return captainJson({
          guard: 'delegation',
          remainingPlan: [],
          nextPlaybookId: 'code',
          nextPlaybookInput: childInput,
        });
      },
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_VISIBLE_CAPTAIN_OPTIONS);
        expect(prompt).toContain(
          'Use an own-property membership check for declared guards.',
        );
        return {
          status: 'ok',
          turnId: 3,
          finalText:
            'The CODE review found that declared guards need an own-property membership check.',
        };
      },
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_HIDDEN_CAPTAIN_OPTIONS);
        expect(prompt).toContain(
          'The CODE review found that declared guards need an own-property membership check.',
        );
        return captainJson({ guard: 'final' });
      },
    ]);

    await shell.init!(session.session);
    expect(telemetryWithTopic(session, 'playbook.trace')).toEqual([]);
    expect(context.captainCalls).toEqual([]);

    await shell.handleBossTurn(turn(bossText), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      childInput,
    ]);
    expect(context.captainCalls).toHaveLength(4);
    expect(
      context.captainCalls.map(({ options }) => options?.visibility),
    ).toEqual(['visible', 'hidden', 'visible', 'hidden']);
    expect(session.statuses.map(({ message }) => message)).toEqual([
      '◇ /code called by Captain',
      '◇ /code returned to Captain',
    ]);
    const visiblePrompts = context.captainCalls
      .filter(({ options }) => options?.visibility === 'visible')
      .map(({ prompt }) => prompt)
      .join('\n');
    expect(visiblePrompts).not.toContain('Current state: routing');
    expect(visiblePrompts).not.toContain('"stateId":"routing"');
    expect(visiblePrompts).not.toContain('callingPlaybook');
    expect(visiblePrompts).not.toContain('/captain');
    expect(visiblePrompts).not.toContain(
      '10000000-0000-4000-8000-000000000001',
    );
    expect(visiblePrompts).not.toContain('nextPlaybookId');
    expect(visiblePrompts).not.toContain('remainingPlan');
    expect(
      context.captainCalls.some(({ prompt }) =>
        prompt.includes('Boss-event classifier'),
      ),
    ).toBe(false);

    const traces = telemetryWithTopic(session, 'playbook.trace').map(
      ({ payload }) => payload as { playbookId?: unknown; type?: unknown },
    );
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          playbookId: 'captain',
          type: 'session.started',
        }),
        expect.objectContaining({
          playbookId: 'captain',
          type: 'captain.call.started',
        }),
        expect.objectContaining({
          playbookId: 'captain',
          type: 'captain.call.finished',
        }),
        expect.objectContaining({
          playbookId: 'captain',
          type: 'session.disposed',
        }),
      ]),
    );
    const stateTelemetryJson = JSON.stringify(
      telemetryWithTopic(session, 'playbook.fsm.state'),
    );
    expect(stateTelemetryJson).toContain('routing');
    expect(stateTelemetryJson).toContain('done');
  });

  it('lazily creates an internal root with only the sanitized catalog', async () => {
    const code = fakeCodeEntry();
    const docs = fakePlaybookEntry('docs', 'docs');
    const internal = fakeInternalCaptain();
    const shell = makeShell([code, docs], {
      commands: { code: 'dev' },
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    expect(internal.createCaptainRuntime).not.toHaveBeenCalled();

    await shell.handleBossTurn(
      turn('please coordinate this work'),
      context.context,
    );

    expect(internal.createCaptainRuntime).toHaveBeenCalledWith({
      enabledPlaybooks: [
        {
          id: 'code',
          command: 'dev',
          intent: 'software development / SDLC coding workflow',
        },
        { id: 'docs', command: 'docs', intent: 'docs playbook' },
      ],
    });
    const captainOptions = internal.createCaptainRuntime.mock.calls[0]?.[0];
    expect(Object.isFrozen(captainOptions?.enabledPlaybooks)).toBe(true);
    expect(
      captainOptions?.enabledPlaybooks?.every((entry) =>
        Object.isFrozen(entry),
      ),
    ).toBe(true);
    expect(internal.runtimes[0]?.session).toMatchObject({
      playbookId: 'captain',
      depth: 0,
    });
    expect(internal.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'please coordinate this work',
    ]);
    expect(code.createRuntime).not.toHaveBeenCalled();
    expect(docs.createRuntime).not.toHaveBeenCalled();
    expect(context.visiblePlayers).toEqual([]);
    expect(session.statuses.map(({ message }) => message)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('/captain')]),
    );
  });

  it('keeps internal Captain state status hidden while retaining telemetry', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain(async (runtime) => {
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
    const internal = fakeInternalCaptain();
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

  it('does not disclose internal frame identity to lifecycle classification', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain();
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('coordinate first'), context.context);
    await shell.handleBossTurn(
      turn('continue coordinating', 2),
      context.context,
    );

    const lifecyclePrompt = hiddenCaptainCalls(context)[0]?.prompt;
    expect(lifecyclePrompt).not.toContain('activePlaybookId');
    expect(lifecyclePrompt).not.toContain('/captain');
    expect(lifecyclePrompt).not.toContain('"captain"');
    expect(internal.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'coordinate first',
      'continue coordinating',
    ]);
  });

  it('does not let a registered slash replace an active internal root', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain();
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('coordinate first'), context.context);
    await shell.handleBossTurn(turn('/code replace it', 2), context.context);

    expect(internal.createCaptainRuntime).toHaveBeenCalledTimes(1);
    expect(internal.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'coordinate first',
    ]);
    expect(registry.createRuntime).not.toHaveBeenCalled();
    const rejection = context.captainCalls.find((call) =>
      call.prompt.includes('Captain is already running'),
    );
    expect(rejection?.prompt).toContain('before starting /code');
    expect(rejection?.prompt).not.toContain('/captain');
  });

  // CAPTAIN-34/35/36: a rejecting internal-root turn disposes the stack under
  // a `failure` reason and rethrows Boss-appropriate prose with the original
  // diagnostic as `cause`, so the next registered command engages cleanly.
  it('resets a failed internal root so the next registered command engages cleanly', async () => {
    const registry = fakeCodeEntry();
    const rawFailure = new Error(
      'adjudicator selected undeclared guard undefined',
    );
    const internal = fakeInternalCaptain(async () => {
      throw rawFailure;
    });
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    let caught: unknown;
    try {
      await shell.handleBossTurn(
        turn('hello, what can you do?'),
        context.context,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/send the request again/i);
    expect(message).toContain('/code');
    expect(message).not.toMatch(/adjudicator|guard|undeclared|hidden/i);
    expect((caught as Error).cause).toBe(rawFailure);
    expect(internal.runtimes[0]?.disposeCount).toBe(1);
    expect(session.telemetry).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ to: 'chat', event: 'failure' }),
      }),
    );
    // CAPTAIN-35: the failing turn makes no visible chat call, so the raw
    // diagnostic reaches no Boss-visible surface.
    expect(context.captainCalls).toHaveLength(0);

    await shell.handleBossTurn(turn('/code fix the parser', 2), context.context);
    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'fix the parser',
    ]);
    expect(
      context.captainCalls.find((call) =>
        call.prompt.includes('already running'),
      ),
    ).toBeUndefined();
  });

  // CAPTAIN-35/36: the same reset applies when the rejecting boundary is the
  // internal root's `resumePlaybookCall` returning a completed child, not just
  // a directly delivered Boss turn.
  it('resets a failed internal root when a returning child rejects its resume', async () => {
    const rawFailure = new Error(
      'adjudicator selected undeclared guard undefined',
    );
    let childStart:
      | Awaited<ReturnType<PlaybookPorts['callPlaybook']>>
      | undefined;
    const internal = fakeInternalCaptain(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        childStart = await runtime.ports.callPlaybook(
          { callId: 'captain:code:1', playbookId: 'code', text: 'do the work' },
          runtimeTurn.signal,
        );
        if (childStart.state !== 'suspended') {
          throw new Error('expected the child to suspend');
        }
        return suspendedResult({
          callId: 'captain:code:1',
          playbookId: 'code',
          childSessionId: childStart.childSessionId,
        });
      },
      async () => {
        throw rawFailure;
      },
    );
    const registry = fakeCodeEntry(async (_runtime, runtimeTurn) =>
      runtimeTurn.text === 'do the work'
        ? quiescentResult('working')
        : terminalResult('done', { summary: 'work complete' }),
    );
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('coordinate the work'), context.context);
    expect(childStart?.state).toBe('suspended');

    let caught: unknown;
    try {
      await shell.handleBossTurn(turn('finish it', 2), context.context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/send the request again/i);
    expect((caught as Error).message).not.toMatch(
      /adjudicator|guard|undeclared|hidden/i,
    );
    expect((caught as Error).cause).toBe(rawFailure);
    expect(internal.runtimes[0]?.disposeCount).toBe(1);
    expect(registry.runtimes[0]?.disposeCount).toBe(1);
    expect(session.telemetry).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ to: 'chat', event: 'failure' }),
      }),
    );
    expect(
      context.captainCalls.some((call) => call.prompt.includes('adjudicator')),
    ).toBe(false);

    await shell.handleBossTurn(turn('/code retry it', 3), context.context);
    expect(registry.createRuntime).toHaveBeenCalledTimes(2);
    expect(registry.runtimes[1]?.inputs.map(({ text }) => text)).toEqual([
      'retry it',
    ]);
    expect(
      context.captainCalls.find((call) =>
        call.prompt.includes('already running'),
      ),
    ).toBeUndefined();
  });

  // CAPTAIN-35/36: an external root's rejected turn keeps its recoverable
  // frame and propagates the boundary error unchanged.
  it('retains a failed external root and propagates its boundary error unchanged', async () => {
    const rawFailure = new Error('code runtime control failure');
    let failNext = true;
    const registry = fakeCodeEntry(async () => {
      if (failNext) {
        failNext = false;
        throw rawFailure;
      }
      return quiescentResult();
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await expect(
      shell.handleBossTurn(turn('/code do the work'), context.context),
    ).rejects.toBe(rawFailure);
    expect(registry.runtimes[0]?.disposeCount).toBe(0);

    await shell.handleBossTurn(turn('/code try again', 2), context.context);
    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'do the work',
      'try again',
    ]);
  });

  it('independently rejects internal-Captain and unknown child targets', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await expect(
        runtime.ports.callPlaybook(
          {
            callId: 'captain:self:1',
            playbookId: 'captain',
            text: 'recurse',
          },
          runtimeTurn.signal,
        ),
      ).rejects.toThrow('internal Captain playbook cannot call itself');
      await expect(
        runtime.ports.callPlaybook(
          {
            callId: 'captain:unknown:1',
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

    await shell.init!(stubSession().session);
    await shell.handleBossTurn(turn('route carefully'), stubContext().context);

    expect(registry.createRuntime).not.toHaveBeenCalled();
  });

  it('serializes internal Captain and judge calls through one queue', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const callOrder: string[] = [];
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain(async (runtime, runtimeTurn) => {
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
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
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
      return { status: 'ok', turnId: calls, finalText: 'done' };
    };

    await shell.init!(session.session);
    const running = shell.handleBossTurn(
      turn('handle directly'),
      context.context,
    );
    await firstStarted.promise;
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst.resolve(undefined);
    await running;

    expect(callOrder).toHaveLength(2);
    expect(callOrder[0]).toBe('visible:visible workflow call');
    expect(callOrder[1]).toMatch(/^hidden:/);
    expectHiddenJudgeEnvelope(
      callOrder[1]?.slice('hidden:'.length),
      'hidden judge call',
    );
  });

  it('keeps an aborted running Captain call in the queue until its host settles', async () => {
    const firstStarted = deferred<void>();
    const secondQueued = deferred<void>();
    const releaseFirst = deferred<void>();
    let hostCalls = 0;
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain(async (runtime, runtimeTurn) => {
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
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();
    context.context.callCaptain = async () => {
      hostCalls += 1;
      if (hostCalls === 1) {
        firstStarted.resolve(undefined);
        await releaseFirst.promise;
      }
      return { status: 'ok', turnId: hostCalls, finalText: 'done' };
    };

    await shell.init!(session.session);
    const running = shell.handleBossTurn(turn('route'), context.context);
    await secondQueued.promise;
    await Promise.resolve();
    expect(hostCalls).toBe(1);

    releaseFirst.resolve(undefined);
    await running;
    expect(hostCalls).toBe(2);
  });

  it('serializes a shell turn summary behind unfinished runtime Captain work', async () => {
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
        finalText: 'done',
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
    expect(callOrder[1]).toContain('turn-summary block');
  });

  it('disposes a terminal internal root without synthetic lifecycle status', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain(async () =>
      terminalResult('done', { response: 'complete' }),
    );
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('first intent'), context.context);
    await shell.handleBossTurn(turn('second intent', 2), context.context);

    expect(internal.createCaptainRuntime).toHaveBeenCalledTimes(2);
    expect(internal.runtimes.map((runtime) => runtime.disposeCount)).toEqual([
      1, 1,
    ]);
    expect(session.statuses.map(({ message }) => message)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('/captain')]),
    );
  });

  it('delivers the original Boss text to the active runtime', async () => {
    const registry = fakeCodeEntry();
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('continue from here', 2), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(hiddenCaptainCalls(context)[0]?.options).toEqual({
      visibility: 'hidden',
      resume: false,
      allowedTools: [],
    });
    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'first task',
      'continue from here',
    ]);
    expect(hiddenCaptainCalls(context)[0]?.prompt).toContain(
      'lifecycle classifier',
    );
    expect(hiddenCaptainCalls(context)[0]?.prompt).not.toContain(
      '"decision":"dispatch"',
    );
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

  it('dismisses without using classifier-authored text or making visible chat', async () => {
    const registry = fakeCodeEntry();
    delete registry.entry.summaryPolicy;
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext([
      captainJson({
        decision: 'dismiss',
        text: 'CODE has been dismissed.',
      }),
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('dismiss this', 2), context.context);

    expect(registry.runtimes[0]?.disposeCount).toBe(1);
    expect(hiddenCaptainCalls(context)[0]?.options).toEqual({
      visibility: 'hidden',
      resume: false,
      allowedTools: [],
    });
    expect(context.captainCalls).toHaveLength(1);
    expect(hiddenCaptainCalls(context)[0]?.prompt).toContain(
      '{"decision":"dismiss"}',
    );
    expect(hiddenCaptainCalls(context)[0]?.prompt).not.toContain(
      'optional visible dismissal reply',
    );
    expect(session.statuses).toContainEqual({
      message: '◇ /code stopped',
      data: undefined,
    });
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
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('resume it', 2), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'first task',
      'resume it',
    ]);
    expect(hiddenCaptainCalls(context)).toHaveLength(1);
    const lifecyclePrompt = hiddenCaptainCalls(context)[0]!.prompt;
    expect(lifecyclePrompt).not.toContain('"mode":"engaged.parked"');
    expect(lifecyclePrompt).not.toContain('latestSubRuntimeStateId');
    expect(lifecyclePrompt).not.toContain('activePlaybookId');
    expect(telemetryWithTopic(session, 'playbook.fsm.state')).toHaveLength(2);
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
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_HIDDEN_CAPTAIN_OPTIONS);
        expect(prompt).toContain('lifecycle classifier');
        return captainJson({ decision: 'deliver' });
      },
      captainJson({ decision: 'deliver' }),
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('answer question', 2), context.context);
    await shell.handleBossTurn(turn('what happened?', 3), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(hiddenCaptainCalls(context)).toHaveLength(2);
    for (const { prompt } of hiddenCaptainCalls(context)) {
      expect(prompt).not.toContain('pendingBossQuestions');
      expect(prompt).not.toContain('Which branch should I use?');
      expect(prompt).not.toContain('lastError');
      expect(prompt).not.toContain('"message":"boom"');
      expect(prompt).not.toContain('hidden stack');
    }
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
    const context = stubContext([captainJson({ decision: 'dismiss' })]);

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
    expect(context.captainCalls).toHaveLength(1);
    expect(context.captainCalls[0]?.options).toEqual(
      ISOLATED_HIDDEN_CAPTAIN_OPTIONS,
    );
  });

  it('rejects a different registered command while CODE is engaged', async () => {
    const code = fakeCodeEntry();
    const docs = fakePlaybookEntry('docs', 'docs');
    const shell = makeShell([code, docs]);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('/docs write docs', 2), context.context);

    expect(code.createRuntime).toHaveBeenCalledTimes(1);
    expect(docs.createRuntime).not.toHaveBeenCalled();
    const visibleRejection = context.captainCalls.find((call) =>
      call.prompt.includes('/code is already running'),
    );
    expect(visibleRejection?.options).toEqual(
      ISOLATED_VISIBLE_CAPTAIN_OPTIONS,
    );
    expect(visibleRejection?.prompt).toContain('/code is already running');
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
  it('passes CODE ports through and hides sub-runtime judge calls', async () => {
    const observed: unknown[] = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitStatus('sub-runtime status', { step: 1 });
      await runtime.ports.emitTelemetry(stateTelemetry('ready'));
      observed.push(
        await runtime.ports.callPlayer(
          'coder',
          'player prompt',
          runtimeTurn.signal,
          { resume: false },
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
        options: { resume: false },
      },
    ]);
    const nonSummaryCaptainCalls = context.captainCalls.filter(
      (call) => !isTurnSummaryPrompt(call.prompt),
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
      ISOLATED_HIDDEN_CAPTAIN_OPTIONS,
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
    expect(telemetryWithTopic(session, 'playbook.fsm.state')).toEqual([
      stateTelemetry('ready'),
    ]);
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

    expect(hiddenCaptainCalls(context)).toHaveLength(1);
    expect(hiddenCaptainCalls(context)[0]?.options).toEqual(
      ISOLATED_HIDDEN_CAPTAIN_OPTIONS,
    );
    expectHiddenJudgeEnvelope(
      hiddenCaptainCalls(context)[0]?.prompt,
      runtimePrompt,
    );
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
  it('appends visible turn summaries after registered and lifecycle-delivered submissions', async () => {
    const order: string[] = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitStatus(`status for ${runtimeTurn.text}`);
      order.push('status');
      await runtime.ports.emitTelemetry(stateTelemetry('ready'));
      order.push('telemetry');
      await runtime.ports.callPlayer(
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
        { resume: false },
      );
    });
    const shell = makeShell(registry);
    const session = stubSession();
    const context = stubContext(
      [
        captainJson({ decision: 'deliver' }),
        captainJson({ decision: 'deliver' }),
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
    expect(summaries.map(({ options }) => options)).toEqual([
      ISOLATED_VISIBLE_CAPTAIN_OPTIONS,
      ISOLATED_VISIBLE_CAPTAIN_OPTIONS,
      ISOLATED_VISIBLE_CAPTAIN_OPTIONS,
    ]);
    expect(summaries.map((call) => call.prompt)).toEqual([
      expect.stringContaining(
        'Saved you 1 interruption and 0 copy-pastes across 0 rounds of reviews/rebuttals.',
      ),
      expect.stringContaining(
        'Saved you 1 interruption and 0 copy-pastes across 0 rounds of reviews/rebuttals.',
      ),
      expect.stringContaining(
        'Saved you 1 interruption and 0 copy-pastes across 0 rounds of reviews/rebuttals.',
      ),
    ]);
    expect(summaries[0]?.prompt).toContain(
      'Submitted Boss text:\ncommand task',
    );
    expect(summaries[0]?.prompt).toContain('Progress counts:\nnone');
    expect(summaries[0]?.prompt).not.toContain('Ledger:');
    expect(summaries[1]?.prompt).toContain(
      'Submitted Boss text:\nplease route a task',
    );
    expect(summaries[2]?.prompt).toContain('Submitted Boss text:\ncontinue it');
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
      await runtime.ports.callPlayer(
        'coder',
        'first player',
        runtimeTurn.signal,
        { resume: false },
      );
      await runtime.ports.callPlayer(
        'reviewer',
        'second player',
        runtimeTurn.signal,
        { resume: false },
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
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code count this'), context.context);

    const summary = turnSummaryCalls(context)[0];
    expect(summary?.prompt).toContain(
      'Saved you 2 interruptions and 3 copy-pastes across 3 rounds of reviews/rebuttals.',
    );
    expect(summary?.prompt).toContain(
      'Progress counts:\n2 review rounds, 1 rebuttal',
    );
    expect(summary?.prompt).not.toContain('custom state');
    expect(summary?.prompt).not.toContain('Ledger:');
    expect(summary?.prompt).toContain(
      'State only what was done or what changed',
    );
    expect(summary?.prompt).toContain('do not explain how it was done');
    expect(summary?.prompt).toContain('Do not list raw state names');
    expect(summary?.prompt).toContain(
      "Do not mention counts for states the active playbook's summary policy does not label",
    );
    expect(summary?.prompt).toContain('natural, chat-like tone');
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
    expect(summary?.prompt).toContain('Progress counts:\n2 proposal rounds');
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
    const context = stubContext([captainJson({ guard: 'accepted' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code singular forms'), context.context);

    const summary = turnSummaryCalls(context)[0];
    expect(summary?.prompt).toContain(
      'Saved you 0 interruptions and 1 copy-paste across 1 round of reviews/rebuttals.',
    );
    expect(summary?.prompt).toContain('Progress counts:\n1 rebuttal');
  });

  it('does not append a turn summary after an internal Captain turn or bare selection', async () => {
    const registry = fakeCodeEntry();
    const internal = fakeInternalCaptain();
    const shell = makeShell(registry, {
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('just chat with me'), context.context);

    expect(registry.createRuntime).not.toHaveBeenCalled();
    expect(internal.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'just chat with me',
    ]);
    expect(turnSummaryCalls(context)).toHaveLength(0);

    const selectionRegistry = fakeCodeEntry();
    const selectionShell = makeShell(selectionRegistry);
    const selectionSession = stubSession();
    const selectionContext = stubContext();

    await selectionShell.init!(selectionSession.session);
    await selectionShell.handleBossTurn(
      turn('/code', 2),
      selectionContext.context,
    );

    expect(selectionRegistry.runtimes[0]?.inputs).toEqual([]);
    expect(turnSummaryCalls(selectionContext)).toHaveLength(0);
  });

  it('does not append a turn summary for a submitted turn when the entry declares no summary policy', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.callPlayer(
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
        { resume: false },
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
    expect(turnSummaryCalls(context)).toHaveLength(0);
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

  async function initWith(
    options: unknown,
    loadModule: (specifier: string) => Promise<unknown>,
  ): Promise<void> {
    const shell = createPlaybookCaptainShell(options, { loadModule });
    await shell.init!(namespacedSession().session);
  }

  it('loads from captain.options.playbooks, binds <id>-<role>, validates the slice, and switches visibility', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.callPlayer(
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
        { resume: false },
      );
    });
    const options = {
      playbooks: {
        code: { from: CODE_FROM, options: { committer: 'reviewer' } },
      },
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
    // createRuntime receives the slice plus host players bound to local roles.
    expect(registry.createRuntime).toHaveBeenCalledWith({
      captainOptions: { committer: 'reviewer' },
      players: [
        { id: 'coder', adapter: 'codex', model: 'gpt-5.5' },
        { id: 'reviewer', adapter: 'claude', model: 'claude-opus-4-8' },
      ],
    });
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
            code: { from: 'mod://code' },
            code2: { from: 'mod://code2' },
          },
        },
        loader,
      ),
    ).rejects.toThrow(/duplicate effective command/);
  });

  it('treats a setVisiblePlayers rejection as an internal error rather than swallowing it', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell(
      { playbooks: { code: { from: CODE_FROM } } },
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
    ).rejects.toThrow(/invalid visible set/);
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
          schemaVersion: 2,
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
      captainJson({ decision: 'dismiss', text: 'Stopped.' }),
      { status: 'ok', turnId: 2, finalText: 'Stopped.' },
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
      captainJson({ decision: 'dismiss', text: 'Stopped.' }),
      { status: 'ok', turnId: 2, finalText: 'Stopped.' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first'), context.context);
    await shell.handleBossTurn(turn('dismiss it', 2), context.context);
    await expect(
      shell.handleBossTurn(turn('/code second', 3), context.context),
    ).rejects.toThrow(`playbook session id collision: ${FIRST_ID}`);
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

    await expect(
      shell.handleBossTurn(turn('/code first'), context.context),
    ).rejects.toThrow('runtime init failed');
    await expect(
      shell.handleBossTurn(turn('/code retry', 2), context.context),
    ).rejects.toThrow('runtime init failed');

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
      observed.push(first);
      const second = await runtime.ports.callPlayer(
        'coder',
        'continued call',
        runtimeTurn.signal,
        { resume: first.resumeToken ?? false },
      );
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
        options: { resume: false },
      },
      {
        playerId: 'code-coder',
        prompt: 'continued call',
        options: { resume: 'player-token-1' },
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

  it('isolates replacement sessions through a real tmux-play host', async () => {
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

    class UnusedCaptainAdapter implements AgentAdapter {
      readonly agent = 'claude-code';

      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield createEvent(
          'done',
          this.agent,
          {
            status: 'success',
            result: 'unused',
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

    const tokens = new WeakMap<FakeRuntime, string>();
    const calls = new WeakMap<FakeRuntime, number>();
    const disposedSessionIds: string[] = [];
    const registry = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        const result = await runtime.ports.callPlayer(
          'coder',
          runtimeTurn.text,
          runtimeTurn.signal,
          { resume: tokens.get(runtime) ?? false },
        );
        if (result.resumeToken) tokens.set(runtime, result.resumeToken);
        const callCount = (calls.get(runtime) ?? 0) + 1;
        calls.set(runtime, callCount);
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
            schemaVersion: 2,
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
      players: [{ id: 'code-coder', adapter: 'codex' }],
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
      undefined,
    ]);
    expect(
      registry.runtimes.map((runtime) => runtime.session?.sessionId),
    ).toEqual([FIRST_ID, SECOND_ID]);
    expect(disposedSessionIds).toEqual([FIRST_ID, SECOND_ID]);
  });
});

describe('createPlaybookCaptainShell nested playbooks', () => {
  const ROOT_ID = '20000000-0000-4000-8000-000000000001';
  const CHILD_ID = '20000000-0000-4000-8000-000000000002';
  const LEAF_ID = '20000000-0000-4000-8000-000000000003';

  // DEFERRED — IR-036 task 4 (shell controller rework): this scenario runs
  // the real compiled captain as a nested engagement driving `callPlaybook`,
  // which the DR-029 controller no longer reaches (CAPTAIN-11/29); the
  // LIFO-unwind coverage over fake runtimes below still runs.
  it.skip('routes a real Captain call to the active leaf and unwinds every parent in LIFO order', async () => {
    const order: string[] = [];
    const code = fakeCodeEntry(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        order.push(`code:input:${runtimeTurn.text}`);
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'code:docs:real-captain',
            playbookId: 'docs',
            text: 'draft the supporting notes',
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') {
          throw new Error('docs must park for Boss');
        }
        return suspendedResult({
          callId: 'code:docs:real-captain',
          playbookId: 'docs',
          childSessionId: start.childSessionId,
        });
      },
      undefined,
      undefined,
      async (_runtime, input) => {
        order.push(`code:resume:${input.result.playbookId}`);
        expect(input).toMatchObject({
          callId: 'code:docs:real-captain',
          result: {
            status: 'ok',
            playbookId: 'docs',
            childSessionId: LEAF_ID,
            output: { notes: 'approved' },
          },
        });
        return terminalResult('done', { codeResult: 'implemented' });
      },
    );
    const docs = fakePlaybookEntry(
      'docs',
      'docs',
      async (_runtime, runtimeTurn) => {
        order.push(`docs:input:${runtimeTurn.text}`);
        return runtimeTurn.text === 'draft the supporting notes'
          ? quiescentResult('awaitBossReply')
          : terminalResult('done', { notes: 'approved' });
      },
    );
    code.entry.summaryPolicy = undefined;
    docs.entry.summaryPolicy = undefined;
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID, LEAF_ID],
    });
    const session = stubSession();
    const context = stubContext([
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_VISIBLE_CAPTAIN_OPTIONS);
        expect(prompt).toContain(
          'Boss intent: implement the feature and document it',
        );
        return {
          status: 'ok',
          turnId: 1,
          finalText: 'Delegate the coordinated work to the code playbook.',
        };
      },
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_HIDDEN_CAPTAIN_OPTIONS);
        expect(prompt).toContain(
          'Delegate the coordinated work to the code playbook.',
        );
        return captainJson({
          guard: 'delegation',
          remainingPlan: [],
          nextPlaybookId: 'code',
          nextPlaybookInput: 'implement the feature and prepare its notes',
        });
      },
      captainJson({ decision: 'deliver' }),
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_VISIBLE_CAPTAIN_OPTIONS);
        expect(prompt).toContain('"codeResult":"implemented"');
        return {
          status: 'ok',
          turnId: 5,
          finalText: 'Implementation and notes are complete.',
        };
      },
      (prompt, options) => {
        expect(options).toEqual(ISOLATED_HIDDEN_CAPTAIN_OPTIONS);
        expect(prompt).toContain('Implementation and notes are complete.');
        return captainJson({ guard: 'final' });
      },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(
      turn('implement the feature and document it'),
      context.context,
    );

    expect(code.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'implement the feature and prepare its notes',
    ]);
    expect(docs.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'draft the supporting notes',
    ]);

    await shell.handleBossTurn(
      turn('Use the public API examples exactly.', 2),
      context.context,
    );

    expect(code.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'implement the feature and prepare its notes',
    ]);
    expect(docs.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'draft the supporting notes',
      'Use the public API examples exactly.',
    ]);
    expect(code.runtimes[0]?.resumes).toHaveLength(1);
    expect(code.runtimes[0]?.disposeCount).toBe(1);
    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(order).toEqual([
      'code:input:implement the feature and prepare its notes',
      'docs:input:draft the supporting notes',
      'docs:input:Use the public API examples exactly.',
      'code:resume:docs',
    ]);
    expect(session.statuses).toEqual([
      { message: '◇ /code called by Captain', data: undefined },
      { message: '◇ /docs called by /code', data: undefined },
      { message: '◇ /docs returned to /code', data: undefined },
      { message: '◇ /code returned to Captain', data: undefined },
    ]);
    expect(JSON.stringify(session.statuses)).not.toContain('/captain');
    expect(JSON.stringify(session.statuses)).not.toContain('routing');
    expect(JSON.stringify(session.statuses)).not.toContain('callingPlaybook');

    const captainTraces = telemetryWithTopic(session, 'playbook.trace').map(
      ({ payload }) =>
        payload as { callId?: unknown; playbookId?: unknown; type?: unknown },
    );
    const started = captainTraces.find(
      (event) =>
        event.playbookId === 'captain' &&
        event.type === 'playbook.call.started',
    );
    const finished = captainTraces.find(
      (event) =>
        event.playbookId === 'captain' &&
        event.type === 'playbook.call.finished',
    );
    expect(started?.callId).toBeTypeOf('string');
    expect(finished?.callId).toBe(started?.callId);
    expect(captainTraces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          playbookId: 'captain',
          type: 'session.disposed',
        }),
      ]),
    );
  });

  it('routes exact Boss replies to an internal Captain child and returns to Captain', async () => {
    const internal = fakeInternalCaptain(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'captain:code:1',
            playbookId: 'code',
            text: 'run the selected workflow',
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') throw new Error('code must suspend');
        return suspendedResult({
          callId: 'captain:code:1',
          playbookId: 'code',
          childSessionId: start.childSessionId,
        });
      },
      async (_runtime, input) => {
        expect(input.callId).toBe('captain:code:1');
        expect(input.result).toMatchObject({
          status: 'ok',
          playbookId: 'code',
          childSessionId: CHILD_ID,
        });
        return terminalResult('done', { response: 'all complete' });
      },
    );
    const code = fakeCodeEntry(async (_runtime, runtimeTurn) =>
      runtimeTurn.text === 'run the selected workflow'
        ? quiescentResult('awaitBossReply')
        : terminalResult('done', { result: 'complete' }),
    );
    const shell = makeShell(code, {
      sessionIds: [ROOT_ID, CHILD_ID],
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext([captainJson({ decision: 'deliver' })]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('coordinate a code task'), context.context);
    await shell.handleBossTurn(
      turn('exact answer for the parked child', 2),
      context.context,
    );

    expect(internal.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'coordinate a code task',
    ]);
    expect(code.runtimes[0]?.inputs.map(({ text }) => text)).toEqual([
      'run the selected workflow',
      'exact answer for the parked child',
    ]);
    expect(code.runtimes[0]?.disposeCount).toBe(1);
    expect(internal.runtimes[0]?.resumes).toHaveLength(1);
    expect(internal.runtimes[0]?.disposeCount).toBe(1);
    expect(session.statuses.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        '◇ /code called by Captain',
        '◇ /code returned to Captain',
      ]),
    );
    expect(session.statuses.map(({ message }) => message)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('/captain')]),
    );
    expect(context.visiblePlayers).not.toContainEqual([]);
  });

  it('dismisses an internal Captain child without extra chat and names Captain literally', async () => {
    const internal = fakeInternalCaptain(
      async (runtime, runtimeTurn) => {
        if (!runtime.ports) throw new Error('runtime ports missing');
        const start = await runtime.ports.callPlaybook(
          {
            callId: 'captain:docs:dismiss',
            playbookId: 'docs',
            text: runtimeTurn.text,
          },
          runtimeTurn.signal,
        );
        if (start.state !== 'suspended') throw new Error('docs must suspend');
        return suspendedResult({
          callId: 'captain:docs:dismiss',
          playbookId: 'docs',
          childSessionId: start.childSessionId,
        });
      },
      async () => quiescentResult('readyAfterDismiss'),
    );
    const docs = fakePlaybookEntry('docs', 'docs', async () =>
      quiescentResult('awaitBossReply'),
    );
    delete docs.entry.summaryPolicy;
    const shell = makeShell(docs, {
      sessionIds: [ROOT_ID, CHILD_ID],
      createCaptainRuntime: internal.createCaptainRuntime,
    });
    const session = stubSession();
    const context = stubContext([
      captainJson({ decision: 'dismiss', text: 'do not show this text' }),
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('draft the guide'), context.context);
    await shell.handleBossTurn(turn('stop the child', 2), context.context);

    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(internal.runtimes[0]?.resumes[0]).toMatchObject({
      callId: 'captain:docs:dismiss',
      result: {
        status: 'aborted',
        playbookId: 'docs',
        childSessionId: CHILD_ID,
      },
    });
    expect(session.statuses.map(({ message }) => message)).toEqual([
      '◇ /docs called by Captain',
      '◇ /docs stopped; returning to Captain',
    ]);
    expect(JSON.stringify(session.statuses)).not.toContain('/captain');
    expect(context.captainCalls).toHaveLength(1);
    expect(context.captainCalls[0]?.options).toEqual(
      ISOLATED_HIDDEN_CAPTAIN_OPTIONS,
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

    expect(hiddenCaptainCalls(context)).toHaveLength(1);
    const lifecyclePrompt = hiddenCaptainCalls(context)[0]!.prompt;
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

  it('surfaces nested visibility validation as a control error, not child evidence', async () => {
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
    delete code.entry.summaryPolicy;
    delete docs.entry.summaryPolicy;
    const shell = makeShell([code, docs], {
      sessionIds: [ROOT_ID, CHILD_ID],
    });
    const session = stubSession();
    const context = stubContext();
    context.context.setVisiblePlayers = async (ids) => {
      context.visiblePlayers.push([...ids]);
      if (ids.includes('docs-coder')) {
        throw new Error('invalid nested visible set');
      }
    };

    await shell.init!(session.session);
    await expect(
      shell.handleBossTurn(turn('/code open a nested child'), context.context),
    ).rejects.toThrow('invalid nested visible set');

    expect(childCallReturned).toBe(false);
    expect(docs.runtimes[0]?.disposeCount).toBe(1);
    expect(code.runtimes[0]?.resumes).toEqual([]);
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
      captainJson({ decision: 'dismiss', text: 'Docs stopped.' }),
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
    expect(context.captainCalls).toHaveLength(1);
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
});

describe('Playbook Captain public module surface (CAPTAIN-18)', () => {
  it('resolves the package shell export as a CODE-registered Captain factory', async () => {
    const mod = await import('@sublang/playbook/playbook-captain');
    const shell = mod.default({
      playbooks: {
        code: { from: '@sublang/playbook/code/registry', options: {} },
      },
    });
    const session = stubSession([
      { id: 'code-coder', adapter: 'claude' },
      { id: 'code-reviewer', adapter: 'codex' },
    ]);
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code'), context.context);

    expect(context.captainCalls[0]?.prompt).toContain(
      'Ask what task to run with /code.',
    );
  });
});
