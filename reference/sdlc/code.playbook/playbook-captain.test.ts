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
  /** Captain speech surfaced through cligent `emitReply` (DR-029 §7). */
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
    'An action just executed for the current Boss turn',
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

/**
 * A stand-in session Captain: it receives every Boss turn like the compiled
 * controller does, and, with no scripted hook, executes the host's own
 * deterministic parse resolution through the controller port (CAPTAIN-7).
 */
function fakeSessionCaptain(
  handleHook?: HandleHook,
  resumeHook?: ResumeHook,
  disposeHook?: DisposeHook,
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
              input: { origin: 'boss', text: decision.input },
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
  // CAPTAIN-16/26: the session Captain takes its own previously unissued id at
  // `init`, before any engagement, so injected engagement ids keep their
  // meaning.
  let captainIdIssued = false;
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
          ? { visibility: 'hidden', resume: false, allowedTools: [] }
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
            input: { origin: 'boss', text: resolution.decision.input },
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

  // CAPTAIN-35: an external root's rejected delivery keeps its recoverable
  // frame and propagates the boundary error unchanged.
  it('retains a failed external root and propagates its boundary error unchanged', async () => {
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
    ).rejects.toBe(rawFailure);
    expect(registry.runtimes[0]?.disposeCount).toBe(0);
    // No Boss-appropriate failure reply replaces the propagated error.
    expect(context.replies).toHaveLength(repliesBefore);

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
            input: { origin: 'captain', text: 'do the work' },
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
      'An action just executed for the current Boss turn',
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
      ISOLATED_HIDDEN_CAPTAIN_OPTIONS,
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
    // DR-029 §2: a failing start settles with its facts rather than
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

    // CAPTAIN-7: a bare enabled command settles as one durable prose call.
    expect(context.captainCalls).toHaveLength(1);
    expect(context.captainCalls[0]?.prompt).toContain(
      'Boss issued a registered command that produces no action this turn',
    );
    expect(context.replies).toHaveLength(1);
  });
});
