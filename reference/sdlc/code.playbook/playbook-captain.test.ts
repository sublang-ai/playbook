// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import type {
  BossTurn,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  PlayerRunResult,
} from '@sublang/cligent/tmux-play';
import type {
  PlaybookPorts,
  PlaybookRuntime,
} from './code.playbook.js';
import {
  createPlaybookCaptainShell,
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
  playerCalls: { playerId: string; prompt: string }[];
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

type HandleHook = (
  runtime: FakeRuntime,
  turn: { text: string; signal: AbortSignal },
) => Promise<void>;

type DisposeHook = (runtime: FakeRuntime) => Promise<void>;

class FakeRuntime implements PlaybookRuntime {
  ports: PlaybookPorts | undefined;
  readonly inputs: { text: string; signal: AbortSignal }[] = [];
  initCount = 0;
  disposeCount = 0;

  constructor(
    private readonly handleHook?: HandleHook,
    private readonly disposeHook?: DisposeHook,
  ) {}

  async init(ports: PlaybookPorts): Promise<void> {
    this.ports = ports;
    this.initCount += 1;
  }

  async handleBossInput(turn: {
    text: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.inputs.push(turn);
    await this.handleHook?.(this, turn);
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    await this.disposeHook?.(this);
  }
}

function stubSession(
  players: { id: string; adapter?: string; model?: string }[] = [
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
      callPlayer: async (playerId, prompt): Promise<PlayerRunResult> => {
        playerCalls.push({ playerId, prompt });
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
      callCaptain: async (
        prompt,
        options,
      ): Promise<CaptainRunResult> => {
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

function fakeCodeEntry(handleHook?: HandleHook, disposeHook?: DisposeHook): {
  entry: PlaybookCaptainRegistryEntry;
  validateOptions: ReturnType<typeof vi.fn>;
  createRuntime: ReturnType<typeof vi.fn>;
  runtimes: FakeRuntime[];
} {
  const runtimes: FakeRuntime[] = [];
  const validateOptions = vi.fn();
  const createRuntime = vi.fn(() => {
    const runtime = new FakeRuntime(handleHook, disposeHook);
    runtimes.push(runtime);
    return runtime;
  });
  return {
    entry: {
      id: 'code',
      command: 'code',
      intent: 'software development / SDLC coding workflow',
      requiredRoleIds: ['coder', 'reviewer'],
      idleStateId: 'ready',
      finalStateId: 'done',
      parkStateIds: ['failed', 'awaitBossReply'],
      summaryPolicy: {
        copyPasteGuardNames: [
          'hasFindings',
          'changesMadeSpecs',
          'accepted',
        ],
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

function fakePlaybookEntry(id: string, command: string): ReturnType<typeof fakeCodeEntry> {
  const registry = fakeCodeEntry();
  registry.entry.id = id;
  registry.entry.command = command;
  registry.entry.intent = `${id} playbook`;
  return registry;
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
  return prompt.includes('turn-summary block') &&
    prompt.includes('Saved you ');
}

function turnSummaryCalls(context: StubContext): StubContext['captainCalls'] {
  return context.captainCalls.filter((call) =>
    isTurnSummaryPrompt(call.prompt),
  );
}

function hiddenCaptainCalls(context: StubContext): StubContext['captainCalls'] {
  return context.captainCalls.filter((call) =>
    call.options?.visibility === 'hidden',
  );
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
    const shell = createPlaybookCaptainShell(
      { code: { committer: 'reviewer' } },
      [registry.entry],
    );
    const context = stubContext();

    await expect(
      shell.handleBossTurn(turn('/code fix it'), context.context),
    ).rejects.toThrow(/init must be called first/);

    const session = stubSession();
    await shell.init!(session.session);

    expect(registry.validateOptions).toHaveBeenCalledWith({
      code: { committer: 'reviewer' },
    });
    expect(registry.createRuntime).not.toHaveBeenCalled();
  });

  it('rejects init when registry option validation rejects', async () => {
    const registry = fakeCodeEntry();
    registry.validateOptions.mockImplementation(() => {
      throw new Error('bad CODE option');
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);

    await expect(shell.init!(stubSession().session)).rejects.toThrow(
      /bad CODE option/,
    );

    expect(registry.createRuntime).not.toHaveBeenCalled();
  });

  it('dispatches /code text to a lazily constructed CODE runtime', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code fix the failing test'), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.createRuntime).toHaveBeenCalledWith({
      captainOptions: {},
      players: session.session.players,
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
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code'), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs).toEqual([]);
    expect(context.captainCalls).toHaveLength(1);
    expect(context.captainCalls[0]?.options).toBeUndefined();
    expect(context.captainCalls[0]?.prompt).toContain('visible Boss chat');
    expect(context.captainCalls[0]?.prompt).toContain(
      'Ask what task to run with /code.',
    );
  });

  it('continues the existing CODE runtime for same-playbook /code text', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
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

describe('createPlaybookCaptainShell hidden router decisions (CAPTAIN-12/13)', () => {
  it('routes ordinary text through hidden dispatch without pre-classifying it', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      captainJson({
        decision: 'dispatch',
        playbookId: 'code',
        text: 'fix routed issue',
      }),
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('please fix the issue'), context.context);

    expect(context.captainCalls[0]?.options).toEqual({
      visibility: 'hidden',
    });
    expect(context.captainCalls[0]?.prompt).toContain(
      'hidden control work',
    );
    expect(context.captainCalls[0]?.prompt).toContain(
      '"command":"code"',
    );
    expect(registry.runtimes[0]?.inputs).toEqual([
      {
        text: 'fix routed issue',
        signal: context.controller.signal,
      },
    ]);
  });

  it('routes near-miss command-like input through hidden chat clarification', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      captainJson({
        decision: 'chat',
        text: 'Use /code with a task when you want CODE.',
      }),
      { status: 'ok', turnId: 1, finalText: 'visible reply' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/cod fix the issue'), context.context);

    expect(registry.createRuntime).not.toHaveBeenCalled();
    expect(context.captainCalls[0]?.options).toEqual({
      visibility: 'hidden',
    });
    expect(context.captainCalls[0]?.prompt).toContain('/cod fix the issue');
    expect(context.captainCalls[0]?.prompt).toContain('near-miss');
    expect(context.captainCalls[1]?.options).toBeUndefined();
    expect(context.captainCalls[1]?.prompt).toContain('visible Boss chat');
    expect(context.captainCalls[1]?.prompt).not.toContain(
      'Return only one JSON object',
    );
    expect(context.captainCalls[1]?.prompt).not.toContain(
      '"decision":"dispatch"',
    );
  });

  it('degrades invalid router JSON to visible clarification without dispatch', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      { status: 'ok', turnId: 1, finalText: 'not json' },
      { status: 'ok', turnId: 1, finalText: 'visible clarification' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('what should happen here?'), context.context);

    expect(registry.createRuntime).not.toHaveBeenCalled();
    expect(context.captainCalls[0]?.options).toEqual({
      visibility: 'hidden',
    });
    expect(context.captainCalls[1]?.options).toBeUndefined();
    expect(context.captainCalls[1]?.prompt).toContain(
      "I'm not sure whether this should be Captain chat or a /code task.",
    );
  });

  it.each([
    {
      label: 'non-ok router result',
      result: { status: 'error', turnId: 1, error: 'router failed' },
    },
    {
      label: 'ok router result without finalText',
      result: { status: 'ok', turnId: 1 },
    },
  ] satisfies { label: string; result: CaptainRunResult }[])(
    'degrades $label to visible clarification without dispatch',
    async ({ result }) => {
      const registry = fakeCodeEntry();
      const shell = createPlaybookCaptainShell({}, [registry.entry]);
      const session = stubSession();
      const context = stubContext([
        result,
        { status: 'ok', turnId: 1, finalText: 'visible clarification' },
      ]);

      await shell.init!(session.session);
      await shell.handleBossTurn(turn('what should happen here?'), context.context);

      expect(registry.createRuntime).not.toHaveBeenCalled();
      expect(context.captainCalls[0]?.options).toEqual({
        visibility: 'hidden',
      });
      expect(context.captainCalls[1]?.options).toBeUndefined();
      expect(context.captainCalls[1]?.prompt).toContain(
        "I'm not sure whether this should be Captain chat or a /code task.",
      );
    },
  );

  it('continues the active runtime for router sub decisions', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      captainJson({ decision: 'sub', text: 'continue same CODE run' }),
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('continue from here', 2), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(hiddenCaptainCalls(context)[0]?.options).toEqual({
      visibility: 'hidden',
    });
    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'first task',
      'continue same CODE run',
    ]);
  });

  it('parses router dismiss decisions and returns to visible chat', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      captainJson({
        decision: 'dismiss',
        text: 'CODE has been dismissed.',
      }),
      { status: 'ok', turnId: 1, finalText: 'visible dismissal' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('dismiss this', 2), context.context);

    expect(registry.runtimes[0]?.disposeCount).toBe(1);
    expect(hiddenCaptainCalls(context)[0]?.options).toEqual({
      visibility: 'hidden',
    });
    const visibleDismissal = context.captainCalls.find((call) =>
      call.prompt.includes('CODE has been dismissed.'),
    );
    expect(visibleDismissal?.options).toBeUndefined();
  });
});

describe('createPlaybookCaptainShell lifecycle and telemetry (CAPTAIN-11/14)', () => {
  it('mirrors idle telemetry into the router ledger and resumes the parked runtime', async () => {
    const registry = fakeCodeEntry(async (runtime) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'ready', event: { type: 'xstate.done' } },
      });
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      (prompt) => {
        expect(prompt).toContain('"mode":"engaged.parked"');
        expect(prompt).toContain('"latestSubRuntimeStateId":"ready"');
        return captainJson({
          decision: 'sub',
          text: 'resume parked runtime',
        });
      },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('resume it', 2), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
    expect(registry.runtimes[0]?.inputs.map((input) => input.text)).toEqual([
      'first task',
      'resume parked runtime',
    ]);
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

  it('mirrors pending Boss questions and compact errors into the router ledger', async () => {
    const pendingBossQuestion = {
      resumeStateId: 'review',
      sourceItem: 'CODE-7',
      player: 'Coder',
      question: 'Which branch should I use?',
    };
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload:
          runtimeTurn.text === 'first task'
            ? { to: 'awaitBossReply', pendingBossQuestion }
            : {
                to: 'failed',
                lastError: {
                  name: 'TypeError',
                  message: 'boom',
                  stack: 'hidden stack',
                },
              },
      });
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      (prompt) => {
        expect(prompt).toContain('"pendingBossQuestion"');
        expect(prompt).toContain('Which branch should I use?');
        return captainJson({ decision: 'sub', text: 'second task' });
      },
      (prompt) => {
        expect(prompt).toContain('"lastError":{"name":"TypeError","message":"boom"}');
        expect(prompt).not.toContain('hidden stack');
        return captainJson({ decision: 'chat', text: 'visible recovery' });
      },
      { status: 'ok', turnId: 1, finalText: 'visible recovery reply' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code first task'), context.context);
    await shell.handleBossTurn(turn('answer question', 2), context.context);
    await shell.handleBossTurn(turn('what happened?', 3), context.context);

    expect(registry.createRuntime).toHaveBeenCalledTimes(1);
  });

  it('disposes final engagements and constructs a replacement on later dispatch', async () => {
    const registry = fakeCodeEntry(async (runtime) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'done', event: { type: 'COMPLETE' } },
      });
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
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
      telemetryWithTopic(session, 'playbook.captain.fsm.state').some(
        (event) => JSON.stringify(event.payload).includes('"event":"final"'),
      ),
    ).toBe(true);
  });

  it('dismiss emits shell status and later dispatch constructs a replacement', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      captainJson({
        decision: 'dismiss',
        text: 'CODE has been dismissed.',
      }),
      { status: 'ok', turnId: 1, finalText: 'visible dismissal' },
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
  });

  it('rejects a different registered command while CODE is engaged', async () => {
    const code = fakeCodeEntry();
    const docs = fakePlaybookEntry('docs', 'docs');
    const shell = createPlaybookCaptainShell({}, [code.entry, docs.entry]);
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
    expect(visibleRejection?.options).toBeUndefined();
    expect(visibleRejection?.prompt).toContain(
      '/code is already running',
    );
  });

  it('shell dispose tears down the active runtime without shell teardown emissions', async () => {
    const registry = fakeCodeEntry(undefined, async (runtime) => {
      await runtime.ports?.emitStatus('dispose emission', { drained: true });
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
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
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { state: 'ready' },
      });
      observed.push(
        await runtime.ports.callPlayer(
          'coder',
          'player prompt',
          runtimeTurn.signal,
        ),
      );
      observed.push(
        await runtime.ports.callJudge('judge prompt', runtimeTurn.signal),
      );
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code wire ports'), context.context);

    expect(context.playerCalls).toEqual([
      { playerId: 'coder', prompt: 'player prompt' },
    ]);
    expect(
      context.captainCalls.filter((call) => !isTurnSummaryPrompt(call.prompt)),
    ).toEqual([
      {
        prompt: 'judge prompt',
        options: { visibility: 'hidden' },
      },
    ]);
    expect(observed).toEqual([
      {
        status: 'ok',
        finalText: 'player coder done',
        error: undefined,
      },
      'captain done',
    ]);
    expect(session.statuses).toContainEqual({
      message: 'sub-runtime status',
      data: { step: 1 },
    });
    expect(telemetryWithTopic(session, 'playbook.fsm.state')).toEqual([
      {
        topic: 'playbook.fsm.state',
        payload: { state: 'ready' },
      },
    ]);
    expect(
      telemetryWithTopic(session, 'playbook.captain.fsm.state').length,
    ).toBeGreaterThan(0);
  });
});

describe('createPlaybookCaptainShell turn summaries (CAPTAIN-21)', () => {
  it('appends visible turn summaries after registered, dispatch, and sub submissions', async () => {
    const order: string[] = [];
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitStatus(`status for ${runtimeTurn.text}`);
      order.push('status');
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'ready' },
      });
      order.push('telemetry');
      await runtime.ports.callPlayer(
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
      );
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      captainJson({
        decision: 'dispatch',
        playbookId: 'code',
        text: 'routed task',
      }),
      captainJson({ decision: 'sub', text: 'routed continuation' }),
    ], (prompt) => {
      if (isTurnSummaryPrompt(prompt)) order.push('summary');
    });

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code command task'), context.context);
    await shell.handleBossTurn(turn('please route a task', 2), context.context);
    await shell.handleBossTurn(turn('continue it', 3), context.context);

    const summaries = turnSummaryCalls(context);
    expect(summaries).toHaveLength(3);
    expect(summaries.every((call) => call.options === undefined)).toBe(true);
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
    expect(summaries[0]?.prompt).toContain('Submitted Boss text:\ncommand task');
    expect(summaries[0]?.prompt).toContain(
      'Progress counts:\nnone',
    );
    expect(summaries[0]?.prompt).not.toContain('Ledger:');
    expect(summaries[1]?.prompt).toContain('Submitted Boss text:\nrouted task');
    expect(summaries[2]?.prompt).toContain(
      'Submitted Boss text:\nrouted continuation',
    );
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
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'reviewBossCommitCode' },
      });
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'reviewChangesAndChallengesSpecs' },
      });
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'adjudicateChallenges' },
      });
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'planAndImplement' },
      });
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'testsGreen' },
      });
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'customState' },
      });
      await runtime.ports.callPlayer('coder', 'first player', runtimeTurn.signal);
      await runtime.ports.callPlayer('reviewer', 'second player', runtimeTurn.signal);
      await runtime.ports.callJudge('classifier event', runtimeTurn.signal);
      await runtime.ports.callJudge('malformed adjudication', runtimeTurn.signal);
      await runtime.ports.callJudge('guard absent from registry', runtimeTurn.signal);
      await runtime.ports.callJudge('review findings', runtimeTurn.signal);
      await runtime.ports.callJudge('review revision', runtimeTurn.signal);
      await runtime.ports.callJudge('review pass', runtimeTurn.signal);
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
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
    expect(summary?.prompt).toContain('State only what was done or what changed');
    expect(summary?.prompt).toContain('do not explain how it was done');
    expect(summary?.prompt).toContain('Do not list raw state names');
    expect(summary?.prompt).toContain(
      "Do not mention counts for states the active playbook's summary policy does not label",
    );
    expect(summary?.prompt).toContain('natural, chat-like tone');
  });

  it('uses singular saved-count forms for one copy-paste and one round', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'adjudicateChallenges' },
      });
      await runtime.ports.callJudge('review pass', runtimeTurn.signal);
    });
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      captainJson({ guard: 'accepted' }),
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code singular forms'), context.context);

    const summary = turnSummaryCalls(context)[0];
    expect(summary?.prompt).toContain(
      'Saved you 0 interruptions and 1 copy-paste across 1 round of reviews/rebuttals.',
    );
    expect(summary?.prompt).toContain('Progress counts:\n1 rebuttal');
  });

  it('does not append a turn summary after plain Captain chat or bare selection', async () => {
    const registry = fakeCodeEntry();
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
    const session = stubSession();
    const context = stubContext([
      captainJson({ decision: 'chat', text: 'visible Captain chat' }),
      { status: 'ok', turnId: 1, finalText: 'visible chat reply' },
      { status: 'ok', turnId: 1, finalText: 'bare code reply' },
    ]);

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('just chat with me'), context.context);
    await shell.handleBossTurn(turn('/code', 2), context.context);

    expect(registry.runtimes[0]?.inputs).toEqual([]);
    expect(turnSummaryCalls(context)).toHaveLength(0);
  });

  it('does not append a turn summary for a submitted turn when the entry declares no summary policy', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.callPlayer(
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
      );
    });
    delete (registry.entry as { summaryPolicy?: unknown }).summaryPolicy;
    const shell = createPlaybookCaptainShell({}, [registry.entry]);
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
    const shell = createPlaybookCaptainShell(options, undefined, { loadModule });
    await shell.init!(namespacedSession().session);
  }

  it('loads from captain.options.playbooks, binds <id>-<role>, validates the slice, and switches visibility', async () => {
    const registry = fakeCodeEntry(async (runtime, runtimeTurn) => {
      if (!runtime.ports) throw new Error('runtime ports missing');
      await runtime.ports.callPlayer(
        'coder',
        `player prompt for ${runtimeTurn.text}`,
        runtimeTurn.signal,
      );
    });
    const options = {
      playbooks: { code: { from: CODE_FROM, options: { committer: 'reviewer' } } },
    };
    const shell = createPlaybookCaptainShell(options, undefined, {
      loadModule: async (specifier) => {
        if (specifier === CODE_FROM) return { default: registry.entry };
        throw new Error(`no module ${specifier}`);
      },
    });
    const session = namespacedSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code do the task'), context.context);

    // Entry validates its own option slice, re-keyed under the entry id.
    expect(registry.validateOptions).toHaveBeenCalledWith({
      code: { committer: 'reviewer' },
    });
    // createRuntime receives the slice plus host players bound to local roles.
    expect(registry.createRuntime).toHaveBeenCalledWith({
      captainOptions: { code: { committer: 'reviewer' } },
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
    expect(context.visiblePlayers).toContainEqual(['code-coder', 'code-reviewer']);
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
    await expect(
      initWith({ playbooks: { code: {} } }, loader),
    ).rejects.toThrow(/from/);
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
      undefined,
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

describe('Playbook Captain public module surface (CAPTAIN-18)', () => {
  it('resolves the package shell export as a CODE-registered Captain factory', async () => {
    const mod = await import('@sublang/playbook/playbook-captain');
    const shell = mod.default({});
    const session = stubSession();
    const context = stubContext();

    await shell.init!(session.session);
    await shell.handleBossTurn(turn('/code'), context.context);

    expect(context.captainCalls[0]?.prompt).toContain(
      'Ask what task to run with /code.',
    );
  });
});
