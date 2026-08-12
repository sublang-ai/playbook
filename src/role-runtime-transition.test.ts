// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { assign, createMachine } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type {
  PlaybookPorts,
  PlaybookRoleBinding,
  PlaybookSession,
  PlayerResult,
  PlayerSessionStore,
} from './runtime.js';
import {
  createXStatePlaybookRuntime,
  RUNTIME_ABI,
  SUPPORTED_ARTIFACT_SCHEMAS,
  type XStatePlaybookRuntimeSpec,
} from './xstate-runtime.js';

const stateMeta = (stateId: string, description: string) => ({
  playbook: { stateId, description },
});

const roleMeta = (stateId: string, role: string, description: string) => ({
  playbook: { stateId, role, description },
});

const repeatMachine = createMachine({
  id: 'role-repeat',
  context: { task: '' },
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
          }),
        },
      },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Implement the task.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          role: 'coder',
          sourceItem: 'ROLE-1',
          prompt: `Implement ${context.task}.`,
          result: { complete: 'The task is complete.' },
        }),
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

interface EmptyOptions {}

function repeatSpec(
  overrides: Partial<XStatePlaybookRuntimeSpec<EmptyOptions>> = {},
): XStatePlaybookRuntimeSpec<EmptyOptions> {
  return {
    label: 'ROLE-REPEAT',
    compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    roleStates: { work: { role: 'coder', label: 'Implement the task.' } },
    ...overrides,
  };
}

function recordingPorts(
  callPlayer: PlaybookPorts['callPlayer'],
  telemetry: unknown[] = [],
): PlaybookPorts {
  return {
    callPlayer,
    callCaptain: async () => {
      throw new Error('callCaptain not used');
    },
    callJudge: async () => '{"guard":"complete"}',
    callPlaybook: async () => {
      throw new Error('callPlaybook not used');
    },
    emitStatus: async () => undefined,
    emitTelemetry: async (event) => {
      telemetry.push(event);
    },
  };
}

let sessionSequence = 0;

function session(
  ports: PlaybookPorts,
  options: {
    roleBindings?: Readonly<Record<string, PlaybookRoleBinding>>;
    playerSessions?: PlayerSessionStore;
  } = {},
): PlaybookSession {
  const sessionId = `role-session-${++sessionSequence}`;
  return {
    sessionId,
    playbookId: 'role-fixture',
    rootSessionId: sessionId,
    depth: 0,
    ...options,
    ports,
  };
}

const bossTurn = (text: string) => ({
  text,
  signal: new AbortController().signal,
});

describe('DR-032 shared role runtime transition', () => {
  it('advertises only artifact schema 2 and rejects legacy declarations', () => {
    expect(SUPPORTED_ARTIFACT_SCHEMAS).toEqual([2]);
    expect(Object.isFrozen(SUPPORTED_ARTIFACT_SCHEMAS)).toBe(true);

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: undefined,
      }),
    ).toThrow('spec.compat is required');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: { artifactSchema: 1, runtimeAbi: RUNTIME_ABI },
      }),
    ).toThrow('supports [2]');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: undefined,
      }),
    ).toThrow('roleStates must be supplied for schema 2');

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        playerStates: {
          work: { player: 'Coder', label: 'Implement the task.' },
        },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('must supply roleStates, not playerStates');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        resolvePlayerId: () => 'coder',
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('must not derive concrete player bindings');

    const accessorSpec = repeatSpec() as Record<string, unknown>;
    const legacyGetter = vi.fn(() => ({}));
    Object.defineProperty(accessorSpec, 'playerStates', {
      enumerable: true,
      get: legacyGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        accessorSpec as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
    ).toThrow('must supply roleStates, not playerStates');
    expect(legacyGetter).not.toHaveBeenCalled();

    const roleStatesGetter = vi.fn(() => ({
      work: { role: 'coder', label: 'Implement the task.' },
    }));
    const accessorRoleStates = repeatSpec() as Record<string, unknown>;
    Object.defineProperty(accessorRoleStates, 'roleStates', {
      enumerable: true,
      get: roleStatesGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        accessorRoleStates as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
    ).toThrow('roleStates must be an own data property');
    expect(roleStatesGetter).not.toHaveBeenCalled();

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: {
          work: {
            role: 'coder',
            label: 'Implement the task.',
            playerId: 'dev.coder',
          },
        },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('roleStates.work.playerId is not allowed');

    const roleGetter = vi.fn(() => 'coder');
    const accessorEntry = { label: 'Implement the task.' } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorEntry, 'role', {
      enumerable: true,
      get: roleGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: { work: accessorEntry },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('roleStates.work.role must be a JSON data property');
    expect(roleGetter).not.toHaveBeenCalled();
  });

  it('uses detached bindings for prompt identity while the port receives the role', async () => {
    const telemetry: unknown[] = [];
    const calls: Array<{ roleId: string; prompt: string; resume: string | false }> = [];
    const mutableBinding = {
      playerId: 'dev.shared',
      promptIdentity: 'GPT-5.6 Sol',
    };
    let retainedLookup: ((roleId: string) => string) | undefined;
    const ports = recordingPorts(async (roleId, prompt, _signal, options) => {
      calls.push({ roleId, prompt, resume: options.resume });
      return { status: 'ok', resumeToken: 'thread-1', finalText: 'done' };
    }, telemetry);
    const createRuntime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (input, promptIdentity) => {
          retainedLookup = promptIdentity;
          return `${promptIdentity(input.role)}\n\n${input.prompt}`;
        },
      }),
    );
    const runtime = createRuntime({});
    await runtime.init(
      session(ports, { roleBindings: { coder: mutableBinding } }),
    );
    mutableBinding.playerId = 'mutated.player';
    mutableBinding.promptIdentity = 'mutated model';

    await runtime.handleBossInput(bossTurn('the change'));

    expect(calls).toEqual([
      {
        roleId: 'coder',
        prompt: 'GPT-5.6 Sol\n\nImplement the change.',
        resume: false,
      },
    ]);
    const playerTraces = telemetry
      .map((event) => event as { topic: string; payload: Record<string, unknown> })
      .filter(
        ({ topic, payload }) =>
          topic === 'playbook.trace' &&
          String(payload.type).startsWith('player.call.'),
      );
    expect(playerTraces).toHaveLength(2);
    for (const { payload } of playerTraces) {
      expect(payload.schemaVersion).toBe(3);
      expect(payload.payload).toMatchObject({
        roleId: 'coder',
        playerId: 'dev.shared',
      });
    }
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      roleResumeTokens: { coder: 'thread-1' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('dev.shared');
    expect(JSON.stringify(snapshot)).not.toContain('GPT-5.6 Sol');
    expect(() => retainedLookup?.('coder')).toThrow(
      'prompt identity lookup is no longer active',
    );
    await runtime.dispose();

    const restored = createRuntime({});
    await restored.restore?.(
      session(ports, {
        roleBindings: {
          coder: {
            playerId: 'dev.shared',
            promptIdentity: 'Claude Opus 5',
          },
        },
      }),
      snapshot!,
    );
    await restored.handleBossInput(bossTurn('the follow-up'));
    expect(calls[1]).toEqual({
      roleId: 'coder',
      prompt: 'Claude Opus 5\n\nImplement the follow-up.',
      resume: 'thread-1',
    });
    expect(JSON.stringify(restored.exportSnapshot?.())).not.toContain(
      'Claude Opus 5',
    );
    expect(() => retainedLookup?.('coder')).toThrow(
      'prompt identity lookup is no longer active',
    );
    await restored.dispose();
  });

  it('validates exact bindings and limits prompt lookup to declared roles', async () => {
    const port = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'done',
    }));
    const ports = recordingPorts(port);
    const createRuntime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (_input, promptIdentity) =>
          promptIdentity('reviewer'),
      }),
    );

    for (const roleBindings of [
      {},
      {
        coder: { playerId: 'dev.coder', promptIdentity: 'Coder' },
        reviewer: { playerId: 'dev.reviewer', promptIdentity: 'Reviewer' },
      },
    ]) {
      const runtime = createRuntime({});
      await expect(runtime.init(session(ports, { roleBindings }))).rejects.toThrow(
        'must cover exactly [coder]',
      );
      await runtime.dispose();
    }

    const emptyIdentity = createRuntime({});
    await expect(
      emptyIdentity.init(
        session(ports, {
          roleBindings: { coder: { playerId: 'dev.coder', promptIdentity: ' ' } },
        }),
      ),
    ).rejects.toThrow('promptIdentity must be a non-empty string');
    await emptyIdentity.dispose();

    const lookup = createRuntime({});
    await lookup.init(
      session(ports, {
        roleBindings: {
          coder: { playerId: 'dev.coder', promptIdentity: 'Coder' },
        },
      }),
    );
    await expect(
      lookup.handleBossInput(bossTurn('task')),
    ).rejects.toThrow('lookup rejected undeclared role reviewer');
    expect(port).not.toHaveBeenCalled();
    await lookup.dispose();
  });

  it('preserves, clears, and replaces external continuation only when authorized', async () => {
    const tokens = new Map<string, string>();
    const updates: Array<[string, string | undefined]> = [];
    const store: PlayerSessionStore = {
      select: (roleId) => tokens.get(roleId) ?? false,
      update: (roleId, token) => {
        updates.push([roleId, token]);
        if (token === undefined) tokens.delete(roleId);
        else tokens.set(roleId, token);
      },
      snapshot: () => Object.fromEntries(tokens),
      restore: (next) => {
        tokens.clear();
        for (const [roleId, token] of Object.entries(next)) {
          tokens.set(roleId, token);
        }
      },
    };
    const results: PlayerResult[] = [
      { status: 'ok', resumeToken: 'thread-1', finalText: 'done' },
      { status: 'aborted' },
      { status: 'ok', resumeToken: '   ', finalText: 'invalid' },
      { status: 'error', error: 'failed' },
      { status: 'ok', finalText: 'done' },
      { status: 'ok', resumeToken: 'thread-2', finalText: 'done' },
    ];
    const resumes: Array<string | false> = [];
    const standalonePromptIdentities: string[] = [];
    const ports = recordingPorts(async (_roleId, _prompt, _signal, options) => {
      resumes.push(options.resume);
      return results.shift()!;
    });
    const runtime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (input, promptIdentity) => {
          standalonePromptIdentities.push(promptIdentity(input.role));
          return input.prompt;
        },
      }),
    )({});
    await runtime.init(session(ports, { playerSessions: store }));

    await runtime.handleBossInput(bossTurn('one'));
    await runtime.handleBossInput(bossTurn('two'));
    await expect(runtime.handleBossInput(bossTurn('three'))).rejects.toThrow(
      'resumeToken must be a non-empty string',
    );
    await runtime.handleBossInput(bossTurn('four'));
    await runtime.handleBossInput(bossTurn('five'));
    await runtime.handleBossInput(bossTurn('six'));

    expect(resumes).toEqual([
      false,
      'thread-1',
      'thread-1',
      'thread-1',
      'thread-1',
      false,
    ]);
    expect(updates).toEqual([
      ['coder', 'thread-1'],
      ['coder', undefined],
      ['coder', 'thread-2'],
    ]);
    expect(standalonePromptIdentities).toEqual(Array(6).fill('coder'));
    expect(runtime.exportSnapshot?.()?.roleResumeTokens).toEqual({
      coder: 'thread-2',
    });
    await runtime.dispose();
  });
});

const aliasMachine = createMachine({
  id: 'role-alias',
  context: {},
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: { START: 'code' },
    },
    code: {
      meta: roleMeta('code', 'coder', 'Draft a proposal.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'code',
          role: 'coder',
          sourceItem: 'ALIAS-1',
          prompt: 'Draft.',
          result: { complete: 'Complete.' },
        },
        onDone: 'review',
        onError: 'ready',
      },
    },
    review: {
      meta: roleMeta('review', 'reviewer', 'Review the proposal.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'review',
          role: 'reviewer',
          sourceItem: 'ALIAS-2',
          prompt: 'Review.',
          result: { complete: 'Complete.' },
        },
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

const aliasSpec: XStatePlaybookRuntimeSpec<EmptyOptions> = {
  label: 'ROLE-ALIAS',
  compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {
    code: { role: 'coder', label: 'Draft a proposal.' },
    review: { role: 'reviewer', label: 'Review the proposal.' },
  },
};

describe('DR-032 aliased private continuation', () => {
  it('shares by player privately but projects and restores by local role', async () => {
    const calls: Array<{ roleId: string; resume: string | false }> = [];
    const results: PlayerResult[] = [
      { status: 'ok', resumeToken: 'thread-1', finalText: 'draft' },
      { status: 'ok', resumeToken: 'thread-2', finalText: 'review' },
    ];
    const ports = recordingPorts(async (roleId, _prompt, _signal, options) => {
      calls.push({ roleId, resume: options.resume });
      return results.shift()!;
    });
    const bindings = {
      coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
      reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
    };
    const createRuntime = createXStatePlaybookRuntime(aliasMachine, aliasSpec);
    const runtime = createRuntime({});
    await runtime.init(session(ports, { roleBindings: bindings }));
    await runtime.handleBossInput(bossTurn('start'));
    expect(calls).toEqual([
      { roleId: 'coder', resume: false },
      { roleId: 'reviewer', resume: 'thread-1' },
    ]);
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.roleResumeTokens).toEqual({
      coder: 'thread-2',
      reviewer: 'thread-2',
    });
    await runtime.dispose();

    const conflicting = structuredClone(snapshot!);
    conflicting.roleResumeTokens = {
      coder: 'thread-a',
      reviewer: 'thread-b',
    };
    const restored = createRuntime({});
    await expect(
      restored.restore?.(
        session(ports, { roleBindings: bindings }),
        conflicting,
      ),
    ).rejects.toThrow('conflicting tokens');
    await restored.dispose();
  });

  it('rejects a one-sided external alias projection', async () => {
    const ports = recordingPorts(async () => ({
      status: 'ok',
      finalText: 'unused',
    }));
    const store: PlayerSessionStore = {
      select: () => false,
      update: () => undefined,
      snapshot: () => ({ coder: 'thread-1' }),
      restore: () => undefined,
    };
    const runtime = createXStatePlaybookRuntime(aliasMachine, aliasSpec)({});
    await runtime.init(
      session(ports, {
        roleBindings: {
          coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
          reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
        },
        playerSessions: store,
      }),
    );
    expect(() => runtime.exportSnapshot?.()).toThrow(
      'through every aliased role',
    );
    await runtime.dispose();
  });

  it('rejects an accessor-bearing external projection without invoking it', async () => {
    const tokenGetter = vi.fn(() => 'thread-1');
    const store: PlayerSessionStore = {
      select: () => false,
      update: () => undefined,
      snapshot: () => {
        const projected = {} as Record<string, string>;
        Object.defineProperty(projected, 'coder', {
          enumerable: true,
          get: tokenGetter,
        });
        return projected;
      },
      restore: () => undefined,
    };
    const runtime = createXStatePlaybookRuntime(repeatMachine, repeatSpec())({});
    await runtime.init(
      session(
        recordingPorts(async () => ({
          status: 'ok',
          finalText: 'unused',
        })),
        { playerSessions: store },
      ),
    );

    expect(() => runtime.exportSnapshot?.()).toThrow(
      'player session store snapshot.coder must be a JSON data property',
    );
    expect(tokenGetter).not.toHaveBeenCalled();
    await runtime.dispose();
  });
});

const collisionMachine = createMachine({
  id: 'role-collision',
  context: {},
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: { START: 'work' },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Run simultaneous work.'),
      tags: ['playbook.busy'],
      invoke: [
        {
          id: 'coder-call',
          src: 'player',
          input: {
            stateId: 'work',
            role: 'coder',
            sourceItem: 'COLLISION-1',
            prompt: 'Code.',
            result: { complete: 'Complete.' },
          },
          onDone: 'ready',
          onError: 'ready',
        },
        {
          id: 'reviewer-call',
          src: 'player',
          input: {
            stateId: 'work',
            role: 'reviewer',
            sourceItem: 'COLLISION-2',
            prompt: 'Review.',
            result: { complete: 'Complete.' },
          },
          onDone: 'ready',
          onError: 'ready',
        },
      ],
    },
    reviewerDeclaration: {
      meta: roleMeta(
        'reviewerDeclaration',
        'reviewer',
        'Declare the Reviewer role.',
      ),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'reviewerDeclaration',
          role: 'reviewer',
          sourceItem: 'COLLISION-DECLARATION',
          prompt: 'Unused.',
          result: { complete: 'Complete.' },
        },
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

describe('DR-032 resolved-player concurrency', () => {
  it('rejects an aliased overlap before a second host call', async () => {
    const hostCalls = vi.fn(
      (_roleId: string, _prompt: string, signal: AbortSignal) =>
        new Promise<PlayerResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const telemetry: unknown[] = [];
    const runtime = createXStatePlaybookRuntime(collisionMachine, {
      label: 'ROLE-COLLISION',
      compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
      snapshotOptions: () => ({}),
      entryEvent: { type: 'START', textField: 'task' },
      roleStates: {
        work: { role: 'coder', label: 'Run simultaneous work.' },
        reviewerDeclaration: {
          role: 'reviewer',
          label: 'Declare the Reviewer role.',
        },
      },
    })({});
    await runtime.init(
      session(recordingPorts(hostCalls, telemetry), {
        roleBindings: {
          coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
          reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
        },
      }),
    );

    await runtime.handleBossInput(bossTurn('start'));

    expect(hostCalls).toHaveBeenCalledTimes(1);
    const finishes = telemetry
      .map((entry) => entry as { topic: string; payload: Record<string, unknown> })
      .filter(
        ({ topic, payload }) =>
          topic === 'playbook.trace' && payload.type === 'player.call.finished',
      )
      .map(({ payload }) => payload.payload as Record<string, unknown>);
    expect(finishes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          playerId: 'dev.shared',
          status: 'error',
          error: expect.objectContaining({
            message: expect.stringContaining('player key dev.shared'),
          }),
        }),
      ]),
    );
    await runtime.dispose();
  });
});
