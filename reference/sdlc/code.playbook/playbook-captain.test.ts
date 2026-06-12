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
}

type HandleHook = (
  runtime: FakeRuntime,
  turn: { text: string; signal: AbortSignal },
) => Promise<void>;

class FakeRuntime implements PlaybookRuntime {
  ports: PlaybookPorts | undefined;
  readonly inputs: { text: string; signal: AbortSignal }[] = [];
  initCount = 0;
  disposeCount = 0;

  constructor(private readonly handleHook?: HandleHook) {}

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
  }
}

function stubSession(): StubSession {
  const statuses: StubSession['statuses'] = [];
  const telemetry: StubSession['telemetry'] = [];
  return {
    session: {
      signal: new AbortController().signal,
      players: [
        { id: 'coder', adapter: 'claude' },
        { id: 'reviewer', adapter: 'codex' },
      ],
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

function stubContext(): StubContext {
  const controller = new AbortController();
  const playerCalls: StubContext['playerCalls'] = [];
  const captainCalls: StubContext['captainCalls'] = [];
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
      callCaptain: async (
        prompt,
        options,
      ): Promise<CaptainRunResult> => {
        captainCalls.push({ prompt, options });
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
  };
}

function fakeCodeEntry(handleHook?: HandleHook): {
  entry: PlaybookCaptainRegistryEntry;
  validateOptions: ReturnType<typeof vi.fn>;
  createRuntime: ReturnType<typeof vi.fn>;
  runtimes: FakeRuntime[];
} {
  const runtimes: FakeRuntime[] = [];
  const validateOptions = vi.fn();
  const createRuntime = vi.fn(() => {
    const runtime = new FakeRuntime(handleHook);
    runtimes.push(runtime);
    return runtime;
  });
  return {
    entry: {
      id: 'code',
      command: 'code',
      intent: 'software development / SDLC coding workflow',
      idleStateId: 'ready',
      finalStateId: 'done',
      validateOptions,
      createRuntime,
    },
    validateOptions,
    createRuntime,
    runtimes,
  };
}

function turn(prompt: string, id = 1): BossTurn {
  return { id, prompt, timestamp: 0 };
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
      'Boss selected /code without a task',
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
    expect(context.captainCalls).toEqual([
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
    expect(session.telemetry).toEqual([
      {
        topic: 'playbook.fsm.state',
        payload: { state: 'ready' },
      },
    ]);
  });
});
