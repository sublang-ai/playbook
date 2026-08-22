// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Unit tests for the generic linked-runtime factory (DR-019): the thin-module
// contract slc/link.md §Output emits — a machine plus a small spec — driven
// end to end over synthetic FSMs that exercise every provided actor kind
// (player, script, captain, nested playbook) and the generic strategy
// defaults (entry event, parked-state classifier, prompt composition,
// adjudication, statuses).

import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assign, createMachine } from 'xstate';

import type {
  PlaybookPorts,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookSession,
  PlaybookTraceEvent,
  PlayerSessionStore,
  PlayerResult,
} from './runtime.js';
import {
  createXStatePlaybookRuntime,
  defaultComposeCaptainPrompt,
  defaultComposePlayerPrompt,
  defaultExtractRequiredFields,
  normalizePlaybookSnapshot,
  resumableStateIdsFromMachine,
  RUNTIME_ABI,
  SUPPORTED_ARTIFACT_SCHEMAS,
  type XStatePlaybookRuntimeSpec,
} from './xstate-runtime.js';
import createCodePlaybookRuntime from '../reference/sdlc/code.playbook/code.playbook.js';
import { decideMachine } from '../reference/sdlc/decide.playbook/decide.fsm.js';

const meta = (stateId: string) => ({
  playbook: { stateId, description: `${stateId} state` },
});

const roleMeta = (stateId: string, role: string) => ({
  playbook: { ...meta(stateId).playbook, role },
});

interface RecordedStatus {
  message: string;
  data?: unknown;
}

interface RecordedTelemetry {
  topic: string;
  payload: unknown;
}

function makeRecordingPorts(overrides: Partial<PlaybookPorts> = {}): {
  ports: PlaybookPorts;
  statuses: RecordedStatus[];
  telemetry: RecordedTelemetry[];
} {
  const statuses: RecordedStatus[] = [];
  const telemetry: RecordedTelemetry[] = [];
  const ports: PlaybookPorts = {
    callPlayer: async () => {
      throw new Error('callPlayer not used in this test');
    },
    callCaptain: async () => {
      throw new Error('callCaptain not used in this test');
    },
    callJudge: async () => '{}',
    callPlaybook: async () => {
      throw new Error('callPlaybook not used in this test');
    },
    emitStatus: async (message, data) => {
      statuses.push(data === undefined ? { message } : { message, data });
    },
    emitTelemetry: async (event) => {
      telemetry.push({ topic: event.topic, payload: event.payload });
    },
    ...overrides,
  };
  return { ports, statuses, telemetry };
}

let sessionSequence = 0;

function makeSession(
  ports: PlaybookPorts,
  playerSessions?: PlayerSessionStore,
): PlaybookSession {
  const sessionId = `factory-test-session-${++sessionSequence}`;
  return {
    sessionId,
    playbookId: 'factory-test',
    rootSessionId: sessionId,
    depth: 0,
    ...(playerSessions === undefined ? {} : { playerSessions }),
    ports,
  };
}

function turn(text: string): { text: string; signal: AbortSignal } {
  return { text, signal: new AbortController().signal };
}

interface WorkflowOptions {
  command?: string;
  cwd?: string;
}

// Synthetic player+script workflow: ready → implement (player) → verify
// (script) → done, with Boss-reply suspension and a recoverable failed sink.
const workflowMachine = createMachine({
  id: 'wf',
  context: ({
    input,
  }: {
    input: { command?: string } | undefined;
  }) => ({
    task: undefined as string | undefined,
    command: input?.command ?? 'true',
    summary: undefined as string | undefined,
    pendingBossQuestion: undefined as
      | {
          questionId: string;
          resumeStateId: string;
          sourceItem: string;
          asker: { kind: 'role'; roleId: string };
          question: string;
        }
      | undefined,
    bossReply: undefined as string | undefined,
    lastError: undefined as unknown,
  }),
  initial: 'ready',
  on: {
    BOSS_INTERRUPT: {
      guard: ({ event }) =>
        (event as { targetId?: string }).targetId === 'implement',
      target: '#implement',
      reenter: true,
      actions: assign({
        task: ({ event }) =>
          (event as { bossIntent?: string }).bossIntent,
        pendingBossQuestion: () => undefined,
        bossReply: () => undefined,
      }),
    },
  },
  states: {
    ready: {
      meta: meta('ready'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'implement',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
            lastError: () => undefined,
          }),
        },
      },
    },
    implement: {
      id: 'implement',
      meta: roleMeta('implement', 'coder'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'implement',
          role: 'coder',
          sourceItem: 'WF-1',
          prompt: 'Implement this task: <task>',
          task: context.task,
          ...(context.pendingBossQuestion !== undefined &&
          context.bossReply !== undefined
            ? {
                pendingBossQuestion: context.pendingBossQuestion,
                bossReply: context.bossReply,
              }
            : {}),
          result: {
            implemented:
              'The work is complete. Output shall include `summary: <one-line summary>`.',
            needsBossReply:
              'The player asked Boss a question. Output shall include `question: <verbatim question>`.',
          },
        }),
        onDone: [
          {
            guard: ({ event }) =>
              (event.output as { guard: string }).guard === 'needsBossReply',
            target: 'awaitBossReply',
            actions: assign({
              pendingBossQuestion: ({ event }) => ({
                questionId: 'q-1',
                resumeStateId: 'implement',
                sourceItem: 'WF-1',
                asker: { kind: 'role', roleId: 'coder' },
                question: (event.output as { question: string }).question,
              }),
            }),
          },
          {
            target: 'verify',
            actions: assign({
              summary: ({ event }) =>
                (event.output as { summary: string }).summary,
              pendingBossQuestion: () => undefined,
              bossReply: () => undefined,
            }),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign({
            lastError: ({ event }) => event.error,
          }),
        },
      },
    },
    awaitBossReply: {
      meta: meta('awaitBossReply'),
      tags: ['playbook.parked'],
      on: {
        BOSS_REPLY: {
          target: 'implement',
          actions: assign({
            bossReply: ({ event }) => (event as { answer: string }).answer,
          }),
        },
        START: {
          target: 'implement',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
            pendingBossQuestion: () => undefined,
            bossReply: () => undefined,
          }),
        },
      },
    },
    verify: {
      meta: meta('verify'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'script',
        input: ({ context }) => ({
          stateId: 'verify',
          sourceItem: 'WF-2',
          command: context.command,
          result: {
            verified: 'The command exited zero.',
            verificationFailed: 'The command exited nonzero.',
          },
        }),
        onDone: [
          {
            guard: ({ event }) =>
              (event.output as { guard: string }).guard === 'verified',
            target: 'done',
          },
          {
            target: 'failed',
            actions: assign({
              lastError: () => new Error('verification failed'),
            }),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign({ lastError: ({ event }) => event.error }),
        },
      },
    },
    failed: {
      meta: meta('failed'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'implement',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
            lastError: () => undefined,
          }),
        },
      },
    },
    done: {
      meta: meta('done'),
      type: 'final',
    },
  },
  output: ({ context }) => ({ summary: context.summary ?? null }),
});

const workflowSpec: XStatePlaybookRuntimeSpec<WorkflowOptions> = {
  label: 'workflow',
  compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: (value) => {
    const options = (value ?? {}) as WorkflowOptions;
    return options;
  },
  machineInput: (options) =>
    options.command === undefined ? {} : { command: options.command },
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {
    implement: { role: 'coder', label: 'implement state' },
  },
};

const createWorkflowRuntime = createXStatePlaybookRuntime(
  workflowMachine,
  workflowSpec,
);

const createWorkflowRuntimeWithBossEvents = createXStatePlaybookRuntime(
  workflowMachine,
  {
    ...workflowSpec,
    bossEvents: [
      {
        type: 'BOSS_INTERRUPT',
        fields: {
          targetId: {
            source: 'judge',
            required: true,
            values: ['implement'],
          },
          bossIntent: { source: 'text', required: true },
          mode: { source: 'judge', values: ['resume', 'restart'] },
        },
      },
    ],
  },
);

describe('generic strategy defaults', () => {
  it('defaultComposePlayerPrompt substitutes <field> placeholders and keeps unmatched ones', () => {
    const prompt = defaultComposePlayerPrompt({
      stateId: 'implement',
      role: 'coder',
      sourceItem: 'WF-1',
      prompt: 'Do <task> for <missing> now.',
      result: { ok: 'fine' },
      ...({ task: 'the thing' } as object),
    });
    expect(prompt).toBe('Do the thing for <missing> now.');
  });

  it('defaultComposePlayerPrompt prepends the continuation preamble and Q/A blocks', () => {
    const prompt = defaultComposePlayerPrompt({
      stateId: 'implement',
      role: 'coder',
      sourceItem: 'WF-1',
      prompt: 'Continue.',
      result: { ok: 'fine' },
      pendingBossQuestion: { question: 'Which color?' },
      bossReply: 'Blue.',
    });
    expect(prompt).toBe(
      [
        'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.',
        'Boss question:\nWhich color?',
        'Boss reply:\nBlue.',
        'Continue.',
      ].join('\n\n'),
    );
  });

  it('maps canonical kebab and special placeholders to typed input fields in one pass', () => {
    const playerPrompt = defaultComposePlayerPrompt({
      stateId: 'review',
      role: 'reviewer',
      sourceItem: 'WF-3',
      prompt: 'Compare <participant-proposal> for IR-<#>; literal <model>.',
      result: { ok: 'fine' },
      ...({
        participantProposal: 'Use <participant-proposal> literally.',
        irNumber: '42',
      } as object),
    });
    expect(playerPrompt).toBe(
      'Compare Use <participant-proposal> literally. for IR-42; literal <model>.',
    );

    const captainPrompt = defaultComposeCaptainPrompt({
      stateId: 'routing',
      sourceItem: 'CAP-1',
      prompt:
        '<boss-intent>\n<enabled-playbooks>\n<remaining-plan>\n<completed-call-results>',
      result: { routed: 'done' },
      ...({
        bossIntent: 'Ship safely.',
        enabledPlaybooks: [{ intent: 'Code', command: '/code', id: 'code' }],
        remainingPlan: [{ task: 'review', step: 2 }],
        completedCallResults: [{ output: { z: 1, a: 2 }, id: 'code' }],
      } as object),
    });
    expect(captainPrompt).toBe(
      [
        'Ship safely.',
        '[{"command":"/code","id":"code","intent":"Code"}]',
        '[{"step":2,"task":"review"}]',
        '[{"id":"code","output":{"a":2,"z":1}}]',
      ].join('\n'),
    );

    expect(
      defaultComposePlayerPrompt(
        {
          stateId: 'commit',
          role: 'committer',
          sourceItem: 'WF-4',
          prompt: 'Coder is <coder-llm>.',
          result: { ok: 'fine' },
          ...({ coderPlayer: 'gpt-5.5' } as object),
        },
        { 'coder-llm': 'coderPlayer' },
      ),
    ).toBe('Coder is gpt-5.5.');
  });

  it('defaultExtractRequiredFields reads only the Output-shall-include clause, in either language', () => {
    expect(
      defaultExtractRequiredFields(
        'Guards `ok` and `error` may appear. Output shall include `summary: <text>` and `detail`.',
      ),
    ).toEqual(['summary', 'detail']);
    expect(
      defaultExtractRequiredFields('结论已定。输出应包含 `conclusion: <文本>`。'),
    ).toEqual(['conclusion']);
    expect(defaultExtractRequiredFields('No required payload.')).toEqual([]);
  });

  it('resumableStateIdsFromMachine derives BOSS_REPLY resume targets', () => {
    expect([...resumableStateIdsFromMachine(workflowMachine)]).toEqual([
      'implement',
    ]);
  });

  it.each([
    [
      'entry text ownership',
      {
        type: 'START',
        fields: { task: { source: 'judge' as const } },
      },
    ],
    [
      'derived interrupt targets',
      {
        type: 'BOSS_INTERRUPT',
        fields: {
          targetId: {
            source: 'judge' as const,
            required: true,
            values: ['other'],
          },
        },
      },
    ],
  ])('rejects bossEvents metadata that conflicts with %s', (_label, event) => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        bossEvents: [event],
      }),
    ).toThrow(/conflicts with the runtime-derived contract/);
  });

  it('validates bossEvents even when the spec overrides classifyBossText', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        classifyBossText: async () => undefined,
        bossEvents: [
          {
            type: 'BOSS_INTERRUPT',
            fields: {
              targetId: {
                source: 'judge',
                required: true,
                values: ['other'],
              },
            },
          },
        ],
      }),
    ).toThrow(/conflicts with the runtime-derived contract/);
  });

  it.each([
    [
      'an omitted player state',
      {},
      /must declare player state implement/,
    ],
    [
      'a non-player state',
      {
        implement: { role: 'coder', label: 'implement state' },
        verify: { role: 'coder', label: 'verify state' },
      },
      /roleStates\.verify does not name a player state/,
    ],
    [
      'a label that diverges from the FSM',
      { implement: { role: 'coder', label: 'Implement the task' } },
      /roleStates\.implement\.label must equal its FSM description/,
    ],
    [
      'a role that diverges from the FSM',
      { implement: { role: 'reviewer', label: 'implement state' } },
      /roleStates\.implement\.role must equal its FSM role/,
    ],
  ])('rejects roleStates metadata with %s', (_label, roleStates, error) => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        roleStates,
      }),
    ).toThrow(error);
  });
});

describe('player + script workflow over the shared factory', () => {
  it('terminates the aborted script process group and settles only after the shell exits', async () => {
    // slc/link.md §Script execution: on abort the whole detached group dies
    // — TERM-immune wrapper and backgrounded descendant alike, via SIGKILL
    // escalation — and the turn settles only once the shell has exited, so
    // quiescence is never reported over a still-running script.
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'playbook-script-abort-'));
    try {
      const controller = new AbortController();
      const command =
        `echo $$ > ${dir}/wrapper.pid; trap '' TERM; ` +
        `sleep 30 & echo $! > ${dir}/child.pid; wait`;
      const { ports, statuses } = makeRecordingPorts({
        callPlayer: async () => ({ status: 'ok', finalText: 'done' }),
        callJudge: async () => '{"guard":"implemented","summary":"ok"}',
      });
      const runtime = createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        label: 'script-abort-workflow',
        machineInput: () => ({ command }),
      })({});
      await runtime.init(makeSession(ports));
      const turn = runtime.handleBossInput({
        text: 'run the trap script',
        signal: controller.signal,
      });
      const readPid = async (name: string): Promise<number> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            const text = await readFile(join(dir, name), 'utf8');
            const pid = Number.parseInt(text.trim(), 10);
            if (Number.isInteger(pid) && pid > 0) return pid;
          } catch {
            // Not written yet.
          }
          await new Promise((tick) => setTimeout(tick, 25));
        }
        throw new Error(`${name} was never written`);
      };
      const wrapperPid = await readPid('wrapper.pid');
      const childPid = await readPid('child.pid');
      controller.abort(new Error('boss cancelled the script'));
      const settled = await turn;
      expect(settled.outcome).toBe('aborted');
      // Both group members are dead at settlement — kill(pid, 0) throws.
      for (const pid of [wrapperPid, childPid]) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(
        statuses.some(({ message }) =>
          message.startsWith('Executed script for'),
        ),
      ).toBe(false);
      await runtime.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('kills a TERM-immune descendant when the shell exits cooperatively on the group SIGTERM', async () => {
    // slc/link.md §Script execution: settlement requires no group member
    // surviving. A wrapper that dies on the group SIGTERM must not cancel
    // the SIGKILL escalation and strand a TERM-ignoring descendant — the
    // close path SIGKILLs the group before settling.
    const dir = await mkdtemp(join(tmpdir(), 'playbook-script-coop-'));
    try {
      const controller = new AbortController();
      const command =
        `echo $$ > ${dir}/wrapper.pid; ` +
        `sh -c 'echo $$ > ${dir}/desc.pid; trap "" TERM; exec sleep 30' & wait`;
      const { ports, statuses } = makeRecordingPorts({
        callPlayer: async () => ({ status: 'ok', finalText: 'done' }),
        callJudge: async () => '{"guard":"implemented","summary":"ok"}',
      });
      const runtime = createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        label: 'script-coop-workflow',
        machineInput: () => ({ command }),
      })({});
      await runtime.init(makeSession(ports));
      const turnPromise = runtime.handleBossInput({
        text: 'run the cooperative script',
        signal: controller.signal,
      });
      const readPid = async (name: string): Promise<number> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            const text = await readFile(join(dir, name), 'utf8');
            const pid = Number.parseInt(text.trim(), 10);
            if (Number.isInteger(pid) && pid > 0) return pid;
          } catch {
            // Not written yet.
          }
          await new Promise((tick) => setTimeout(tick, 25));
        }
        throw new Error(`${name} was never written`);
      };
      const wrapperPid = await readPid('wrapper.pid');
      const descPid = await readPid('desc.pid');
      controller.abort(new Error('boss cancelled the script'));
      const settled = await turnPromise;
      expect(settled.outcome).toBe('aborted');
      // Both group members are dead at settlement — kill(pid, 0) throws —
      // even though only the descendant needed the close-time group SIGKILL.
      for (const pid of [wrapperPid, descPid]) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(
        statuses.some(({ message }) =>
          message.startsWith('Executed script for'),
        ),
      ).toBe(false);
      await runtime.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('rejects an abort observed after the shell exit before status, telemetry, and guard', async () => {
    // slc/link.md §Script execution: an abort landing once the script has
    // completed must still reject with the signal's reason — never resolve
    // the guard behind an aborted settlement, which would leave a secretly
    // terminal machine that a later turn restarts from idle.
    const controller = new AbortController();
    const abortReason = new Error('stop after the script exited');
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'done' }),
      callJudge: async () => '{"guard":"implemented","summary":"ok"}',
      emitStatus: async (message) => {
        if (message.startsWith('Executed script for')) {
          controller.abort(abortReason);
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const settled = await runtime.handleBossInput({
      text: 'build the widget',
      signal: controller.signal,
    });
    expect(settled.outcome).toBe('aborted');
    expect(settled.state.stateId).not.toBe('done');
    expect(telemetry.some(({ topic }) => topic === 'playbook.script')).toBe(
      false,
    );
    await runtime.dispose();
  });

  it('runs deterministic entry, default composition, adjudication, and script execution to terminal', async () => {
    const judgePrompts: string[] = [];
    const playerPrompts: string[] = [];
    const { ports, statuses, telemetry } = makeRecordingPorts({
      callPlayer: async (playerId, prompt) => {
        expect(playerId).toBe('coder');
        playerPrompts.push(prompt);
        return { status: 'ok', finalText: 'All done, boss.' };
      },
      callJudge: async (prompt) => {
        judgePrompts.push(prompt);
        return '{"guard":"implemented","summary":"shipped the task"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput(turn('build the widget'));

    // Deterministic entry: no classifier call; the single judge call is the
    // adjudication.
    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain(
      'Do not call tools, inspect files, or seek external evidence.',
    );
    expect(judgePrompts[0]).toContain(
      'Reply with exactly one JSON object and no prose.',
    );
    expect(judgePrompts[0]).toContain(
      'The coder role just produced this output:',
    );
    // Default composer substituted the machine-carried field.
    expect(playerPrompts).toEqual(['Implement this task: build the widget']);

    expect(result.outcome).toBe('terminal');
    expect(result.state.stateId).toBe('done');
    expect(
      'output' in result ? result.output : undefined,
    ).toEqual({ summary: 'shipped the task' });

    // Default classification, player-entry, and settling-guard statuses plus
    // the script record. No raw state id is used as Boss-facing fallback.
    expect(statuses.map(({ message }) => message)).toEqual([
      'START',
      '⤷ coder: implement state',
      '→ implemented',
      'Executed script for verify (exit 0).',
      '→ verified',
    ]);
    const scriptEvents = telemetry.filter(
      ({ topic }) => topic === 'playbook.script',
    );
    expect(scriptEvents).toEqual([
      {
        topic: 'playbook.script',
        payload: { stateId: 'verify', sourceItem: 'WF-2', exitStatus: 0 },
      },
    ]);
    await runtime.dispose();
  });

  it('runs the script in the cwd option and resolves the failure guard on nonzero exit', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'playbook-script-'));
    try {
      const { ports, statuses } = makeRecordingPorts({
        callPlayer: async () => ({ status: 'ok', finalText: 'done' }),
        callJudge: async () =>
          '{"guard":"implemented","summary":"wrote marker"}',
      });
      const runtime = createWorkflowRuntime({
        command: 'pwd > marker.txt && false',
        cwd: workDir,
      });
      await runtime.init(makeSession(ports));
      const result = await runtime.handleBossInput(turn('write a marker'));

      const marker = await readFile(join(workDir, 'marker.txt'), 'utf8');
      expect(marker.trim().endsWith(workDir.split('/').pop()!)).toBe(true);
      expect(result.outcome).toBe('failed');
      expect(result.state.stateId).toBe('failed');
      expect(statuses.map(({ message }) => message)).toEqual([
        'START',
        '⤷ coder: implement state',
        '→ implemented',
        'Executed script for verify (exit 1).',
        '→ verificationFailed',
        '◆ workflow failed; awaiting Boss recovery.',
      ]);
      expect(statuses.at(-1)).toEqual({
        message: '◆ workflow failed; awaiting Boss recovery.',
        data: {
          lastError: { name: 'Error', message: 'verification failed' },
        },
      });
      await runtime.dispose();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('suspends on needsBossReply and resumes through the generic BOSS_REPLY classifier', async () => {
    let playerCalls = 0;
    const playerInputsSeen: string[] = [];
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerCalls += 1;
        playerInputsSeen.push(prompt);
        return playerCalls === 1
          ? { status: 'ok', finalText: 'Which database should I use?' }
          : { status: 'ok', finalText: 'Done with sqlite.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          expect(prompt).toContain('Pending Boss question: Which database?');
          return '{"type":"BOSS_REPLY","questionId":"q-1"}';
        }
        return playerCalls === 1
          ? '{"guard":"needsBossReply","question":"Which database?"}'
          : '{"guard":"implemented","summary":"used sqlite"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));

    const suspended = await runtime.handleBossInput(turn('build storage'));
    expect(suspended.outcome).toBe('quiescent');
    expect(suspended.state.stateId).toBe('awaitBossReply');
    expect(statuses.slice(-3)).toEqual([
      { message: '→ needsBossReply' },
      { message: 'coder asks: Which database?' },
      {
        message: '◆ awaiting Boss reply · implement · coder · WF-1',
      },
    ]);

    const resumed = await runtime.handleBossInput(turn('use sqlite'));
    expect(resumed.outcome).toBe('terminal');
    // The continuation preamble and exact Boss answer preceded the second
    // player prompt.
    expect(playerInputsSeen[1]).toContain('Boss question:\nWhich database?');
    expect(playerInputsSeen[1]).toContain('Boss reply:\nuse sqlite');
    await runtime.dispose();
  });

  it('accepts a fresh exact entry directive while parked and rejects injected text fields', async () => {
    let playerCalls = 0;
    let classifierCalls = 0;
    const playerPrompts: string[] = [];
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerCalls += 1;
        playerPrompts.push(prompt);
        return playerCalls === 1
          ? { status: 'ok', finalText: 'Which database?' }
          : { status: 'ok', finalText: 'Done.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          classifierCalls += 1;
          return classifierCalls === 1
            ? '{"type":"BOSS_REPLY","questionId":"q-1","answer":"injected"}'
            : '{"type":"START"}';
        }
        return playerCalls === 1
          ? '{"guard":"needsBossReply","question":"Which database?"}'
          : '{"guard":"implemented","summary":"restarted"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('old task'));

    const rejected = await runtime.handleBossInput(turn('malicious answer'));
    expect(rejected.outcome).toBe('no-action');
    expect(rejected.state.stateId).toBe('awaitBossReply');
    expect(statuses.map(({ message }) => message)).toContain(
      'Classifier supplied undeclared field for BOSS_REPLY: answer',
    );

    const restarted = await runtime.handleBossInput(turn('new task'));
    expect(restarted.outcome).toBe('terminal');
    expect(playerPrompts[1]).toBe('Implement this task: new task');
    await runtime.dispose();
  });

  it('derives and validates a root BOSS_INTERRUPT target while parked', async () => {
    let playerCalls = 0;
    const playerPrompts: string[] = [];
    const classifierPrompts: string[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerCalls += 1;
        playerPrompts.push(prompt);
        return playerCalls === 1
          ? { status: 'ok', finalText: 'Need a decision.' }
          : { status: 'ok', finalText: 'Done.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          classifierPrompts.push(prompt);
          return '{"type":"BOSS_INTERRUPT","targetId":"implement"}';
        }
        return playerCalls === 1
          ? '{"guard":"needsBossReply","question":"Need a decision."}'
          : '{"guard":"implemented","summary":"interrupted"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('original task'));

    const interrupted = await runtime.handleBossInput(turn('continue now'));
    expect(interrupted.outcome).toBe('terminal');
    expect(playerCalls).toBe(2);
    // slc/link.md §Boss-event mapping: the derived BOSS_INTERRUPT contract
    // carries the runtime-owned `bossIntent` text field without the linker
    // supplying `bossEvents`, and the judge is never offered it.
    expect(playerPrompts[1]).toBe('Implement this task: continue now');
    expect(classifierPrompts[0]).not.toContain('"bossIntent"');
    await runtime.dispose();
  });

  it('merges bossEvents without weakening exact text, optional fields, or closed values', async () => {
    let playerCalls = 0;
    const playerPrompts: string[] = [];
    const classifierPrompts: string[] = [];
    const classifierReplies = [
      '{"type":"BOSS_INTERRUPT","targetId":"implement","mode":"invalid"}',
      '{"type":"BOSS_INTERRUPT","targetId":"implement"}',
    ];
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerCalls += 1;
        playerPrompts.push(prompt);
        return playerCalls === 1
          ? { status: 'ok', finalText: 'Need a decision.' }
          : { status: 'ok', finalText: 'Done.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          classifierPrompts.push(prompt);
          return classifierReplies.shift() ?? '{"type":"NO_ACTION"}';
        }
        return playerCalls === 1
          ? '{"guard":"needsBossReply","question":"Need a decision."}'
          : '{"guard":"implemented","summary":"interrupted"}';
      },
    });
    const runtime = createWorkflowRuntimeWithBossEvents({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('original task'));

    const invalid = await runtime.handleBossInput(turn('invalid route'));
    expect(invalid.outcome).toBe('no-action');
    expect(statuses.map(({ message }) => message)).toContain(
      'Classifier supplied unknown mode for BOSS_INTERRUPT: invalid',
    );

    const interrupted = await runtime.handleBossInput(turn('continue exactly'));
    expect(interrupted.outcome).toBe('terminal');
    expect(playerPrompts[1]).toBe('Implement this task: continue exactly');
    expect(classifierPrompts[0]).toContain('"targetId": "implement"');
    expect(classifierPrompts[0]).toContain('"mode": "resume"');
    expect(classifierPrompts[0]).not.toContain('"bossIntent"');
    await runtime.dispose();
  });

  it('classifies checkpoint text without pending context and keeps empty input trace-only', async () => {
    // PBRT-25: a parked mid-workflow checkpoint — no pending question, not
    // one of the three deterministic entries — like the acceptance notes
    // fixture's `outline`. The machine deliberately retains the answered
    // question through the resumed call and into the checkpoint, the way
    // CODE and REVIEW retain theirs, so the classifier gate has something
    // to exclude.
    const checkpointMachine = createMachine({
      id: 'checkpointed',
      initial: 'ready',
      context: {
        task: undefined as string | undefined,
        pendingBossQuestion: undefined as
          | {
              questionId: string;
              resumeStateId: string;
              sourceItem: string;
              asker: { kind: 'role'; roleId: string };
              question: string;
            }
          | undefined,
        bossReply: undefined as string | undefined,
      },
      states: {
        ready: {
          meta: meta('ready'),
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
          id: 'work',
          meta: roleMeta('work', 'coder'),
          tags: ['playbook.busy'],
          invoke: {
            src: 'player',
            input: ({ context }) => ({
              stateId: 'work',
              role: 'coder',
              sourceItem: 'CHK-1',
              prompt: 'Work on: <task>',
              task: context.task,
              ...(context.pendingBossQuestion !== undefined &&
              context.bossReply !== undefined
                ? {
                    pendingBossQuestion: context.pendingBossQuestion,
                    bossReply: context.bossReply,
                  }
                : {}),
              result: {
                drafted: 'The draft is open for the next Boss turn.',
                needsBossReply:
                  'The player asked Boss a question. Output shall include `question: <verbatim question>`.',
              },
            }),
            onDone: [
              {
                guard: ({ event }) =>
                  (event.output as { guard: string }).guard ===
                  'needsBossReply',
                target: 'awaitBossReply',
                actions: assign({
                  pendingBossQuestion: ({ event }) => ({
                    questionId: 'chk-q',
                    resumeStateId: 'work',
                    sourceItem: 'CHK-1',
                    asker: { kind: 'role', roleId: 'coder' } as const,
                    question: (event.output as { question: string }).question,
                  }),
                }),
              },
              // Deliberately retains pendingBossQuestion into the checkpoint.
              { target: 'checkpoint' },
            ],
            onError: { target: 'checkpoint' },
          },
        },
        awaitBossReply: {
          meta: meta('awaitBossReply'),
          tags: ['playbook.parked'],
          on: {
            BOSS_REPLY: {
              target: 'work',
              actions: assign({
                bossReply: ({ event }) => (event as { answer: string }).answer,
              }),
            },
          },
        },
        checkpoint: {
          meta: meta('checkpoint'),
          tags: ['playbook.parked'],
          on: {
            START: {
              target: 'work',
              actions: assign({
                task: ({ event }) => (event as { task: string }).task,
                pendingBossQuestion: () => undefined,
                bossReply: () => undefined,
              }),
            },
            // A late-answer arm, so BOSS_REPLY is configured here and its
            // absence from the classifier prompt is the reply-wait
            // pendingness gate's doing — not the configured-event filter's.
            BOSS_REPLY: {
              target: 'work',
              actions: assign({
                bossReply: ({ event }) => (event as { answer: string }).answer,
              }),
            },
          },
        },
      },
    });
    const createCheckpointRuntime = createXStatePlaybookRuntime(
      checkpointMachine,
      {
        label: 'checkpointed',
        compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: (value) => (value ?? {}) as Record<string, never>,
        machineInput: () => ({}),
        entryEvent: { type: 'START', textField: 'task' },
        roleStates: { work: { role: 'coder', label: 'work state' } },
      },
    );

    const playerPrompts: string[] = [];
    const classifierPrompts: string[] = [];
    const { ports, statuses, telemetry } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerPrompts.push(prompt);
        return {
          status: 'ok',
          finalText:
            playerPrompts.length === 1
              ? 'Where should the intro go?'
              : 'Drafted.',
        };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          classifierPrompts.push(prompt);
          return classifierPrompts.length === 1
            ? '{"type":"BOSS_REPLY","questionId":"chk-q"}'
            : '{"type":"START"}';
        }
        return playerPrompts.length === 1
          ? '{"guard":"needsBossReply","question":"Where should the intro go?"}'
          : '{"guard":"drafted"}';
      },
    });
    const session = makeSession(ports);
    const runtime = createCheckpointRuntime({});
    await runtime.init(session);
    const asked = await runtime.handleBossInput(turn('begin the draft'));
    expect(asked.state.stateId).toBe('awaitBossReply');
    expect(classifierPrompts).toHaveLength(0);

    // The reply classifies at the wait with the question presented, and the
    // resumed work settles at the checkpoint with the answered question
    // still riding the context.
    const parked = await runtime.handleBossInput(turn('put it first'));
    expect(parked.state.stateId).toBe('checkpoint');
    expect(classifierPrompts).toHaveLength(1);
    expect(classifierPrompts[0]).toContain('Pending Boss question:');
    expect(playerPrompts).toHaveLength(2);

    // PBRT-7 holds at the checkpoint as in every state: empty input is
    // trace-only no-action — no event, judge call, player call, status
    // emission, or FSM transition — retained context notwithstanding.
    const statusesBefore = statuses.length;
    const tracesBefore = telemetry.filter(
      ({ topic }) => topic === 'playbook.trace',
    ).length;
    const fsmBefore = telemetry.filter(
      ({ topic }) => topic === 'playbook.fsm.state',
    ).length;
    for (const text of ['', '   ']) {
      expect((await runtime.handleBossInput(turn(text))).outcome).toBe(
        'no-action',
      );
    }
    expect(classifierPrompts).toHaveLength(1);
    expect(playerPrompts).toHaveLength(2);
    expect(statuses.length).toBe(statusesBefore);
    const newTraces = telemetry
      .filter(({ topic }) => topic === 'playbook.trace')
      .slice(tracesBefore)
      .map(({ payload }) => (payload as { type: string }).type);
    expect(newTraces).toEqual([
      'boss.input.received',
      'boss.input.settled',
      'boss.input.received',
      'boss.input.settled',
    ]);
    expect(
      telemetry.filter(({ topic }) => topic === 'playbook.fsm.state').length,
    ).toBe(fsmBefore);

    // The retained-context checkpoint is exported once, and each input is
    // driven from its own restored runtime, so the slash-prefixed and the
    // ordinary case both start from the identical retained answered
    // question — the first input's restart cannot clear the context out
    // from under the second.
    const snapshot = runtime.exportSnapshot!()!;
    expect(snapshot.state.stateId).toBe('checkpoint');
    expect(snapshot.pendingBossQuestions).toEqual([]);
    await runtime.dispose();

    // Nonempty slash-prefixed and ordinary text alike classify under the
    // checkpoint's own contracts — no special slash parsing — and the
    // prompt neither presents the retained answered question as pending
    // nor offers the checkpoint's configured BOSS_REPLY contract, which
    // only the pendingness gate can exclude.
    for (const text of ['/publish the draft', 'refine the intro']) {
      const restored = createCheckpointRuntime({});
      await restored.restore!(session, snapshot);
      const resumed = await restored.handleBossInput(turn(text));
      const prompt = classifierPrompts.at(-1)!;
      expect(prompt).toContain('Current state: checkpoint');
      expect(prompt).toContain(text);
      expect(prompt).not.toContain('Pending Boss question:');
      expect(prompt).not.toContain('BOSS_REPLY');
      expect(resumed.state.stateId).toBe('checkpoint');
      expect(playerPrompts.at(-1)).toContain(text);
      await restored.dispose();
    }
    expect(classifierPrompts).toHaveLength(3);
    expect(playerPrompts).toHaveLength(4);
  });

  it('restarts from failed deterministically and reports an unrecoverable wait reply as one status', async () => {
    let playerCalls = 0;
    let classifierCalls = 0;
    const classifierReplies: string[] = [
      'not json at all',
      '{"type":"BOSS_REPLY","questionId":"q-1"}',
    ];
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : playerCalls === 2
            ? { status: 'ok', finalText: 'Which database should I use?' }
            : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          classifierCalls += 1;
          return classifierReplies.shift() ?? '{"type":"NO_ACTION"}';
        }
        return playerCalls === 2
          ? '{"guard":"needsBossReply","question":"Which database?"}'
          : '{"guard":"implemented","summary":"recovered"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));

    const failedRun = await runtime.handleBossInput(turn('try the work'));
    expect(failedRun.outcome).toBe('failed');

    // PBRT-1: the recoverable failure state is a deterministic entry — the
    // restart spends no judge call the classifier could settle as no action.
    const restarted = await runtime.handleBossInput(turn('try again'));
    expect(classifierCalls).toBe(0);
    expect(restarted.state.stateId).toBe('awaitBossReply');

    // The reply wait is where classification lives, and an unrecoverable
    // reply there surfaces as one status with the machine unmoved.
    const noAction = await runtime.handleBossInput(turn('hmm'));
    expect(noAction.outcome).toBe('no-action');
    expect(classifierCalls).toBe(1);
    expect(statuses.map(({ message }) => message)).toContain(
      'Classifier reply was not recoverable JSON',
    );

    const resumed = await runtime.handleBossInput(turn('use sqlite'));
    expect(classifierCalls).toBe(2);
    expect(resumed.outcome).toBe('terminal');
    await runtime.dispose();
  });

  it('surfaces a distinct player failure racing a turn abort instead of misreporting a clean abort', async () => {
    // slc/link.md §Abort: only the exact signal reason is cancellation. A
    // fresh failure — AbortError-named or plain — that lands while the turn
    // signal happens to be aborted is a real fault the Boss must see.
    for (const fresh of [
      new DOMException('port gave up', 'AbortError'),
      new Error('port gave up'),
    ]) {
      const controller = new AbortController();
      const abortReason = new Error('boss cancelled the turn');
      const traces: Array<{ type: string; payload: unknown }> = [];
      const { ports } = makeRecordingPorts({
        callPlayer: async () => {
          controller.abort(abortReason);
          throw fresh;
        },
        emitTelemetry: async (event) => {
          if (event.topic !== 'playbook.trace') return;
          traces.push(event.payload as { type: string; payload: unknown });
        },
      });
      const runtime = createWorkflowRuntime({});
      await runtime.init(makeSession(ports));
      await expect(
        runtime.handleBossInput({ text: 'first try', signal: controller.signal }),
      ).rejects.toBe(fresh);
      const finish = traces.find(
        ({ type }) => type === 'player.call.finished',
      ) as { payload: { status: string } } | undefined;
      expect(finish?.payload.status).toBe('error');
      await runtime.dispose();
    }
  });

  it('settles as an abort when the player rejects with the exact combined-signal reason', async () => {
    const controller = new AbortController();
    const abortReason = new Error('boss cancelled the turn');
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, _prompt, portSignal) => {
        controller.abort(abortReason);
        // Causal identity: the port honors cancellation by rethrowing the
        // combined signal's own reason.
        throw portSignal.reason;
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const aborted = await runtime.handleBossInput({
      text: 'first try',
      signal: controller.signal,
    });
    expect(aborted.outcome).toBe('aborted');
    await runtime.dispose();
  });

  it('settles as an abort when the trace sink rejects with the exact abort reason', async () => {
    // slc/link.md §Abort: a sink whose rejection IS the signal's reason
    // evidences the cancellation itself; the drain must not convert a clean
    // abort into a control-plane rejection carrying the Boss's own reason.
    const controller = new AbortController();
    const abortReason = new Error('boss cancelled the turn');
    let armed = true;
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, _prompt, portSignal) => {
        controller.abort(abortReason);
        throw portSignal.reason;
      },
      emitTelemetry: async () => {
        if (armed && controller.signal.aborted) throw abortReason;
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const aborted = await runtime.handleBossInput({
      text: 'first try',
      signal: controller.signal,
    });
    expect(aborted.outcome).toBe('aborted');
    armed = false;
    await runtime.dispose();
  });

  it('rejects with a distinct sink failure that lands while the turn is aborted', async () => {
    // The reverse case pins the precedence: a sink failure that is not the
    // signal's reason is a real control-plane fault the Boss must see even
    // though the turn was cancelled (slc/link.md §Abort).
    const controller = new AbortController();
    const abortReason = new Error('boss cancelled the turn');
    const sinkFailure = new Error('trace sink offline');
    let armed = true;
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, _prompt, portSignal) => {
        controller.abort(abortReason);
        throw portSignal.reason;
      },
      emitTelemetry: async () => {
        if (armed && controller.signal.aborted) throw sinkFailure;
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await expect(
      runtime.handleBossInput({ text: 'first try', signal: controller.signal }),
    ).rejects.toBe(sinkFailure);
    armed = false;
    await runtime.dispose();
  });

  it('rejects a synchronous FSM action failure instead of leaking an unobserved actor error', async () => {
    // PBRT-13: an action that throws before the quiescence wait subscribes
    // errors the actor while it already counts as quiescent, so no observer
    // ever attached. The boundary must reject with the distinct failure —
    // coincident abort or not — and the error must never escape as an
    // uncaughtException after the method returns.
    for (const abortFirst of [false, true]) {
      const escaped: unknown[] = [];
      const onUncaught = (error: unknown): void => {
        escaped.push(error);
      };
      process.on('uncaughtException', onUncaught);
      try {
        const controller = new AbortController();
        const abortReason = new Error('boss cancelled the turn');
        const actionFailure = new Error('distinct action failure');
        const machine = createMachine({
          id: 'actionThrow',
          context: () => ({ task: undefined as string | undefined }),
          initial: 'ready',
          states: {
            ready: {
              meta: meta('ready'),
              tags: ['playbook.parked'],
              on: {
                START: {
                  target: 'work',
                  actions: [
                    assign({
                      task: ({ event }) => (event as { task: string }).task,
                    }),
                    () => {
                      if (abortFirst) controller.abort(abortReason);
                      throw actionFailure;
                    },
                  ],
                },
              },
            },
            work: {
              meta: meta('work'),
              tags: ['playbook.parked'],
            },
          },
        });
        const runtime = createXStatePlaybookRuntime(machine, {
          label: 'action-throw',
          compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
          snapshotOptions: (value) => (value ?? {}) as Record<string, never>,
          entryEvent: { type: 'START', textField: 'task' },
          roleStates: {},
        })({});
        await runtime.init(makeSession(makeRecordingPorts().ports));
        await expect(
          runtime.handleBossInput({ text: 'go', signal: controller.signal }),
        ).rejects.toBe(actionFailure);
        // The escape reproduced tens of milliseconds after return; give the
        // reporter room to surface before asserting silence.
        await new Promise((tick) => setTimeout(tick, 100));
        expect(escaped).toEqual([]);
        await runtime.dispose().catch(() => undefined);
      } finally {
        process.off('uncaughtException', onUncaught);
      }
    }
  });

  it('does not send a classified event when abort fires during its finish trace', async () => {
    const controller = new AbortController();
    const abortReason = new Error('stop after classification');
    let playerCalls = 0;
    let armed = false;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'ok', finalText: 'Which database should I use?' };
      },
      callJudge: async (prompt) =>
        prompt.includes('Classify the following Boss message')
          ? '{"type":"BOSS_REPLY","questionId":"q-1"}'
          : '{"guard":"needsBossReply","question":"Which database?"}',
      emitTelemetry: async (event) => {
        const trace = event.payload as { type?: string };
        if (
          armed &&
          event.topic === 'playbook.trace' &&
          trace.type === 'judge.call.finished'
        ) {
          controller.abort(abortReason);
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const parked = await runtime.handleBossInput(turn('first try'));
    expect(parked.state.stateId).toBe('awaitBossReply');
    armed = true;

    const aborted = await runtime.handleBossInput({
      text: 'use sqlite',
      signal: controller.signal,
    });
    expect(aborted.outcome).toBe('aborted');
    expect(aborted.state.stateId).toBe('awaitBossReply');
    expect(playerCalls).toBe(1);
    await runtime.dispose();
  });

  it('makes no host judge call when abort lands during the judge.call.started emission', async () => {
    // The queue-front signal checks cannot see an abort that fires while the
    // classifier call's own `judge.call.started` emission drains. The
    // boundary must settle that window as an ordinary abort — the pair
    // finished `aborted` with zero host judge calls, the machine unmoved.
    const controller = new AbortController();
    let judgeCalls = 0;
    let playerCalls = 0;
    let armed = false;
    const traces: PlaybookTraceEvent[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'ok', finalText: 'Which database should I use?' };
      },
      callJudge: async () => {
        judgeCalls += 1;
        return '{"guard":"needsBossReply","question":"Which database?"}';
      },
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as PlaybookTraceEvent;
        if (armed) traces.push(trace);
        if (armed && trace.type === 'judge.call.started') {
          controller.abort(new Error('stop inside the started emission'));
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const parked = await runtime.handleBossInput(turn('first try'));
    expect(parked.state.stateId).toBe('awaitBossReply');
    expect(judgeCalls).toBe(1);
    armed = true;

    const aborted = await runtime.handleBossInput({
      text: 'use sqlite',
      signal: controller.signal,
    });
    expect(aborted.outcome).toBe('aborted');
    expect(aborted.state.stateId).toBe('awaitBossReply');
    // The setup adjudication was the only host judge call; the aborted
    // classifier never reached the host.
    expect(judgeCalls).toBe(1);
    expect(playerCalls).toBe(1);
    const pair = traces.filter(({ type }) => type.startsWith('judge.call.'));
    expect(pair.map(({ type }) => type)).toEqual([
      'judge.call.started',
      'judge.call.finished',
    ]);
    expect(pair[1].payload).toMatchObject({ status: 'aborted' });
    await runtime.dispose();
  });
});

interface CaptainOptions {
  toolFree?: boolean;
}

// Synthetic direct-Captain workflow with an optional Boss-reply park.
const captainMachine = createMachine({
  id: 'cap',
  context: ({ input }: { input: CaptainOptions | undefined }) => ({
    topic: undefined as string | undefined,
    response: undefined as string | undefined,
    toolFree: input?.toolFree === true,
    pendingBossQuestion: undefined as
      | {
          questionId: string;
          resumeStateId: string;
          sourceItem: string;
          asker: { kind: 'captain' };
          question: string;
        }
      | undefined,
    bossReply: undefined as string | undefined,
    lastError: undefined as unknown,
  }),
  initial: 'ready',
  states: {
    ready: {
      meta: meta('ready'),
      tags: ['playbook.parked'],
      on: {
        GO: {
          target: 'decide',
          actions: assign({
            topic: ({ event }) => (event as { topic: string }).topic,
          }),
        },
      },
    },
    decide: {
      meta: meta('decide'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'captain',
        input: ({ context }) => ({
          stateId: 'decide',
          sourceItem: 'CAP-1',
          prompt: 'Decide about <topic>.',
          topic: context.topic,
          ...(context.toolFree ? { allowedTools: [] } : {}),
          ...(context.pendingBossQuestion !== undefined &&
          context.bossReply !== undefined
            ? {
                pendingBossQuestion: context.pendingBossQuestion,
                bossReply: context.bossReply,
              }
            : {}),
          result: {
            final:
              'The Captain answered. Output shall include `response: <verbatim response>`.',
            needsBossReply:
              'The Captain asked Boss a question. Output shall include `question: <verbatim question>`.',
          },
        }),
        onDone: [
          {
            guard: ({ event }) =>
              (event.output as { guard: string }).guard === 'needsBossReply',
            target: 'awaitBossReply',
            actions: assign({
              pendingBossQuestion: ({ event }) => ({
                questionId: 'captain-q-1',
                resumeStateId: 'decide',
                sourceItem: 'CAP-1',
                asker: { kind: 'captain' },
                question: (event.output as { question: string }).question,
              }),
            }),
          },
          {
            target: 'done',
            actions: assign({
              response: ({ event }) =>
                (event.output as { response: string }).response,
              pendingBossQuestion: () => undefined,
              bossReply: () => undefined,
            }),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign({ lastError: ({ event }) => event.error }),
        },
      },
    },
    awaitBossReply: {
      meta: meta('awaitBossReply'),
      tags: ['playbook.parked'],
      on: {
        BOSS_REPLY: {
          target: 'decide',
          actions: assign({
            bossReply: ({ event }) => (event as { answer: string }).answer,
          }),
        },
      },
    },
    failed: {
      meta: meta('failed'),
      tags: ['playbook.parked'],
      on: { GO: 'decide' },
    },
    done: { meta: meta('done'), type: 'final' },
  },
  output: ({ context }) => ({ response: context.response ?? null }),
});

const createCaptainRuntime = createXStatePlaybookRuntime(captainMachine, {
  compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: (value) => (value ?? {}) as CaptainOptions,
  roleStates: {},
  machineInput: (options) => options,
  entryEvent: { type: 'GO', textField: 'topic' },
});

describe('direct-Captain actor over the shared factory', () => {
  it('makes one visible callCaptain, adjudicates hidden, and injects the visible response', async () => {
    const captainCalls: {
      prompt: string;
      options: Record<string, unknown>;
    }[] = [];
    const judgePrompts: string[] = [];
    const { ports, telemetry } = makeRecordingPorts({
      callCaptain: async (prompt, _signal, options) => {
        captainCalls.push({
          prompt,
          options: options as unknown as Record<string, unknown>,
        });
        return { status: 'ok', finalText: 'Ship it on Tuesday.' };
      },
      callJudge: async (prompt) => {
        judgePrompts.push(prompt);
        return '{"guard":"final"}';
      },
    });
    const runtime = createCaptainRuntime({ toolFree: true });
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput(turn('release timing'));

    expect(captainCalls).toHaveLength(1);
    expect(captainCalls[0].prompt).toBe('Decide about release timing.');
    expect(captainCalls[0].options).toMatchObject({
      visibility: 'visible',
      resume: false,
      allowedTools: [],
    });
    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain(
      'Adjudicate the direct Captain output for this FSM state.',
    );
    expect(result.outcome).toBe('terminal');
    expect('output' in result ? result.output : undefined).toEqual({
      response: 'Ship it on Tuesday.',
    });

    const captainTraces = telemetry
      .map(({ payload }) => payload as { type?: string; payload?: unknown })
      .filter(
        (event) =>
          event.type === 'captain.call.started' ||
          event.type === 'captain.call.finished',
      );
    expect(captainTraces).toHaveLength(2);
    await runtime.dispose();
  });

  it('rejects a judge reply that supplies the presentation field itself', async () => {
    const { ports } = makeRecordingPorts({
      callCaptain: async () => ({ status: 'ok', finalText: 'Real answer.' }),
      callJudge: async () => '{"guard":"final","response":"paraphrased"}',
    });
    const runtime = createCaptainRuntime({});
    await runtime.init(makeSession(ports));
    await expect(
      runtime.handleBossInput(turn('release timing')),
    ).rejects.toThrow(/undeclared field "response"/);
    await runtime.dispose();
  });

  // PBRT-47: a host-reported Captain result failure is a recoverable FSM
  // failure, not a control-plane error. It routes through the invoked actor's
  // XState error path to the failure state and resolves `failed`, exactly as
  // the delegated-player boundary does for the same class of host failure.
  // A non-`ok` status is never re-asked (DR-028 / PBRT-51): exactly one
  // host call happens.
  it.each([
    [
      'non-ok result',
      { status: 'error' as const, error: 'captain unavailable' },
      /captain unavailable/,
    ],
    [
      'aborted result',
      { status: 'aborted' as const },
      /callCaptain status "aborted"/,
    ],
  ])(
    'routes a %s to the FSM failure state instead of rejecting, with no second call',
    async (_label, captainResult, error) => {
      let captainCalls = 0;
      const { ports, telemetry } = makeRecordingPorts({
        callCaptain: async () => {
          captainCalls += 1;
          return captainResult;
        },
      });
      const runtime = createCaptainRuntime({});
      await runtime.init(makeSession(ports));
      const result = await runtime.handleBossInput(turn('release timing'));

      expect(captainCalls).toBe(1);
      expect(result.outcome).toBe('failed');
      expect(result.state.stateId).toBe('failed');
      expect('error' in result ? result.error : undefined).toMatchObject({
        name: 'Error',
        message: expect.stringMatching(error) as unknown as string,
      });
      const finishes = telemetry
        .map(({ payload }) => payload as { type?: string; payload?: unknown })
        .filter((event) => event.type === 'captain.call.finished');
      expect(finishes).toHaveLength(1);
      expect(finishes[0]?.payload).toMatchObject({
        status: captainResult.status,
        error: { name: 'Error' },
      });
      await runtime.dispose();
    },
  );

  it.each([
    [
      'thrown port',
      async () => {
        throw new Error('captain transport failed');
      },
      /captain transport failed/,
    ],
    [
      'malformed result',
      async () => ({ status: 'ok', unexpected: true }) as never,
      /not a declared property/,
    ],
  ])(
    'keeps a %s as a control-plane rejection',
    async (_label, callCaptain, error) => {
      const { ports, telemetry } = makeRecordingPorts({ callCaptain });
      const runtime = createCaptainRuntime({});
      await runtime.init(makeSession(ports));

      await expect(
        runtime.handleBossInput(turn('release timing')),
      ).rejects.toThrow(error);
      const finishes = telemetry
        .map(({ payload }) => payload as { type?: string })
        .filter((event) => event.type === 'captain.call.finished');
      expect(finishes).toHaveLength(1);
      await runtime.dispose();
    },
  );

  it('agrees with the player boundary on a host result failure', async () => {
    const { ports: captainPorts } = makeRecordingPorts({
      callCaptain: async () => ({ status: 'error', error: 'agent crashed' }),
    });
    const captainRuntime = createCaptainRuntime({});
    await captainRuntime.init(makeSession(captainPorts));
    const captainResult = await captainRuntime.handleBossInput(
      turn('release timing'),
    );
    await captainRuntime.dispose();

    const { ports: playerPorts } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'error', error: 'agent crashed' }),
    });
    const playerRuntime = createWorkflowRuntime({});
    await playerRuntime.init(makeSession(playerPorts));
    const playerResult = await playerRuntime.handleBossInput(
      turn('do the work'),
    );
    await playerRuntime.dispose();

    expect(captainResult.outcome).toBe(playerResult.outcome);
    expect(captainResult.outcome).toBe('failed');
    expect(captainResult.state.stateId).toBe('failed');
    expect(playerResult.state.stateId).toBe('failed');
    expect(
      'error' in captainResult ? captainResult.error?.message : undefined,
    ).toBe('agent crashed');
    expect(
      'error' in playerResult ? playerResult.error?.message : undefined,
    ).toBe('agent crashed');
  });

  it('preserves a direct-Captain result failure when its finish sink rejects', async () => {
    let finishAttempts = 0;
    const { ports, statuses } = makeRecordingPorts({
      callCaptain: async () => ({
        status: 'error',
        error: 'captain unavailable',
      }),
      emitTelemetry: async (event) => {
        const trace = event.payload as { type?: string };
        if (trace.type === 'captain.call.finished') {
          finishAttempts += 1;
          throw new Error('finish sink failed');
        }
      },
    });
    const runtime = createCaptainRuntime({});
    await runtime.init(makeSession(ports));
    // The rejecting sink is the control-plane error the public boundary
    // surfaces; the host result stays the failure state's own evidence.
    await expect(
      runtime.handleBossInput(turn('release timing')),
    ).rejects.toThrow('finish sink failed');
    expect(finishAttempts).toBe(1);
    expect(
      statuses.find(({ message }) =>
        message.startsWith('◆ workflow failed;'),
      ),
    ).toMatchObject({
      data: { lastError: { message: 'captain unavailable' } },
    });
    await runtime.dispose();
  });

  it('preserves a direct-Captain result failure over a finish-time abort', async () => {
    const controller = new AbortController();
    const { ports, statuses } = makeRecordingPorts({
      callCaptain: async () => ({
        status: 'error',
        error: 'captain unavailable',
      }),
      emitTelemetry: async (event) => {
        const trace = event.payload as { type?: string };
        if (trace.type === 'captain.call.finished') {
          controller.abort(new Error('finish-time abort'));
        }
      },
    });
    const runtime = createCaptainRuntime({});
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput({
      text: 'release timing',
      signal: controller.signal,
    });

    expect(result.outcome).toBe('aborted');
    expect(result.state.stateId).toBe('failed');
    expect(
      statuses.find(({ message }) =>
        message.startsWith('◆ workflow failed;'),
      ),
    ).toMatchObject({
      data: { lastError: { message: 'captain unavailable' } },
    });
    await runtime.dispose();
  });

  it('omits allowedTools from the host call and trace when the source does not restrict tools', async () => {
    let optionsSeen: Record<string, unknown> | undefined;
    const { ports, telemetry } = makeRecordingPorts({
      callCaptain: async (_prompt, _signal, options) => {
        optionsSeen = options as unknown as Record<string, unknown>;
        return { status: 'ok', finalText: 'Use the configured tools.' };
      },
      callJudge: async () => '{"guard":"final"}',
    });
    const runtime = createCaptainRuntime({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('tool policy'));

    expect(optionsSeen).toEqual({ visibility: 'visible', resume: false });
    const start = telemetry
      .map(({ payload }) => payload as { type?: string; payload?: unknown })
      .find((event) => event.type === 'captain.call.started');
    expect(start?.payload).not.toHaveProperty('allowedTools');
    await runtime.dispose();
  });

  it('preserves unique Captain call ids across parked snapshot restore', async () => {
    let captainCalls = 0;
    const { ports, telemetry } = makeRecordingPorts({
      callCaptain: async () => {
        captainCalls += 1;
        return {
          status: 'ok',
          finalText:
            captainCalls === 1 ? 'Which release day?' : 'Release Tuesday.',
        };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          return '{"type":"BOSS_REPLY","questionId":"captain-q-1"}';
        }
        return captainCalls === 1
          ? '{"guard":"needsBossReply"}'
          : '{"guard":"final"}';
      },
    });
    const session = makeSession(ports);
    const first = createCaptainRuntime({});
    await first.init(session);
    const parked = await first.handleBossInput(turn('release timing'));
    expect(parked.state.stateId).toBe('awaitBossReply');
    const snapshot = first.exportSnapshot?.();
    expect(snapshot?.sequences.captainCall).toBe(1);

    const restored = createCaptainRuntime({});
    await restored.restore?.(session, snapshot!);
    const result = await restored.handleBossInput(turn('Tuesday'));
    expect(result.outcome).toBe('terminal');
    const callIds = telemetry
      .map(({ payload }) => payload as { type?: string; callId?: string })
      .filter((event) => event.type === 'captain.call.started')
      .map(({ callId }) => callId);
    expect(callIds).toEqual(['captain-1', 'captain-2']);
    await restored.dispose();
  });

  it('rejects a direct-Captain snapshot missing its call counter', async () => {
    let captainCalls = 0;
    const { ports, telemetry } = makeRecordingPorts({
      callCaptain: async () => {
        captainCalls += 1;
        return {
          status: 'ok',
          finalText:
            captainCalls === 1 ? 'Which release day?' : 'Release Tuesday.',
        };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          return '{"type":"BOSS_REPLY","questionId":"captain-q-1"}';
        }
        return captainCalls === 1
          ? '{"guard":"needsBossReply"}'
          : '{"guard":"final"}';
      },
    });
    const session = makeSession(ports);
    const first = createCaptainRuntime({});
    await first.init(session);
    await first.handleBossInput(turn('release timing'));
    const malformedSnapshot = structuredClone(first.exportSnapshot!());
    delete malformedSnapshot.sequences.captainCall;
    const telemetryCount = telemetry.length;

    const restored = createCaptainRuntime({});
    await expect(restored.restore!(session, malformedSnapshot)).rejects.toThrow(
      'sequences.captainCall is required for a direct-Captain artifact',
    );
    expect(captainCalls).toBe(1);
    expect(telemetry).toHaveLength(telemetryCount);
    const callIds = telemetry
      .map(({ payload }) => payload as { type?: string; callId?: string })
      .filter((event) => event.type === 'captain.call.started')
      .map(({ callId }) => callId);
    expect(callIds).toEqual(['captain-1']);
    await restored.dispose();
    await first.dispose();
  });
});

// DR-028 / PBRT-51: an `ok` result whose finalText is missing, empty, or
// whitespace-only earns exactly one corrective re-ask of the same composed
// call through the same boundary — its own traced started/finished pair —
// before a second such result follows the existing failure path. The three
// variants are one empty predicate at both boundaries.
const EMPTY_FINAL_TEXT_VARIANTS: ReadonlyArray<[string, string | undefined]> = [
  ['missing', undefined],
  ['empty-string', ''],
  ['whitespace-only', ' \n\t '],
];

describe('empty ok Captain result corrective re-ask (DR-028 / PBRT-51)', () => {
  it.each(EMPTY_FINAL_TEXT_VARIANTS)(
    'recovers a %s finalText through exactly one re-ask of the same call',
    async (_label, emptyText) => {
      let captainCalls = 0;
      const prompts: string[] = [];
      const { ports, telemetry } = makeRecordingPorts({
        callCaptain: async (prompt) => {
          captainCalls += 1;
          prompts.push(prompt);
          if (captainCalls === 1) {
            return emptyText === undefined
              ? { status: 'ok' }
              : { status: 'ok', finalText: emptyText };
          }
          return { status: 'ok', finalText: 'Ship it on Tuesday.' };
        },
        callJudge: async () => '{"guard":"final"}',
      });
      const runtime = createCaptainRuntime({});
      await runtime.init(makeSession(ports));
      const result = await runtime.handleBossInput(turn('release timing'));

      expect(captainCalls).toBe(2);
      expect(prompts[1]).toBe(prompts[0]);
      expect(result.outcome).toBe('terminal');
      expect('output' in result ? result.output : undefined).toEqual({
        response: 'Ship it on Tuesday.',
      });
      const captainTraces = telemetry
        .map(
          ({ payload }) =>
            payload as {
              type?: string;
              callId?: string;
              payload?: Record<string, unknown>;
            },
        )
        .filter(
          (event) =>
            event.type === 'captain.call.started' ||
            event.type === 'captain.call.finished',
        );
      // Each call traces as its own started/finished pair.
      expect(
        captainTraces.map(({ type, callId }) => ({ type, callId })),
      ).toEqual([
        { type: 'captain.call.started', callId: 'captain-1' },
        { type: 'captain.call.finished', callId: 'captain-1' },
        { type: 'captain.call.started', callId: 'captain-2' },
        { type: 'captain.call.finished', callId: 'captain-2' },
      ]);
      // The first call's single finish records the empty-result failure;
      // the second is the ordinary success finish.
      expect(captainTraces[1]?.payload).toMatchObject({
        status: 'ok',
        error: {
          name: 'Error',
          message: expect.stringMatching(/no finalText/) as unknown as string,
        },
      });
      expect(captainTraces[3]?.payload).toMatchObject({
        status: 'ok',
        finalText: 'Ship it on Tuesday.',
      });
      expect(captainTraces[3]?.payload).not.toHaveProperty('error');
      await runtime.dispose();
    },
  );

  it.each(EMPTY_FINAL_TEXT_VARIANTS)(
    'routes a second %s finalText to the failure state after exactly two calls',
    async (_label, emptyText) => {
      let captainCalls = 0;
      const { ports, telemetry } = makeRecordingPorts({
        callCaptain: async () => {
          captainCalls += 1;
          return emptyText === undefined
            ? { status: 'ok' }
            : { status: 'ok', finalText: emptyText };
        },
      });
      const runtime = createCaptainRuntime({});
      await runtime.init(makeSession(ports));
      const result = await runtime.handleBossInput(turn('release timing'));

      expect(captainCalls).toBe(2);
      expect(result.outcome).toBe('failed');
      expect(result.state.stateId).toBe('failed');
      expect('error' in result ? result.error : undefined).toMatchObject({
        name: 'Error',
        message: expect.stringMatching(/no finalText/) as unknown as string,
      });
      const finishes = telemetry
        .map(({ payload }) => payload as { type?: string; payload?: unknown })
        .filter((event) => event.type === 'captain.call.finished');
      expect(finishes).toHaveLength(2);
      for (const finish of finishes) {
        expect(finish.payload).toMatchObject({
          status: 'ok',
          error: { name: 'Error' },
        });
      }
      await runtime.dispose();
    },
  );

  it('issues no corrective re-ask when the empty result finish sink rejects', async () => {
    let captainCalls = 0;
    const { ports, statuses } = makeRecordingPorts({
      callCaptain: async () => {
        captainCalls += 1;
        return { status: 'ok' };
      },
      emitTelemetry: async (event) => {
        const trace = event.payload as { type?: string };
        if (trace.type === 'captain.call.finished') {
          throw new Error('finish sink failed');
        }
      },
    });
    const runtime = createCaptainRuntime({});
    await runtime.init(makeSession(ports));
    // The rejecting sink stays the control-plane error the public boundary
    // surfaces; the host-result failure stays the failure state's evidence
    // and earns no second host call (PBRT-47).
    await expect(
      runtime.handleBossInput(turn('release timing')),
    ).rejects.toThrow('finish sink failed');
    expect(captainCalls).toBe(1);
    expect(
      statuses.find(({ message }) =>
        message.startsWith('◆ workflow failed;'),
      ),
    ).toMatchObject({
      data: {
        lastError: {
          message: expect.stringMatching(/no finalText/) as unknown as string,
        },
      },
    });
    await runtime.dispose();
  });

  it('makes no second host call when abort lands during the corrective started emission', async () => {
    // The queue-start signal check cannot see an abort that fires while the
    // corrective call's own `captain.call.started` emission drains. The
    // boundary must settle that window as an ordinary abort — the pair
    // finished `aborted` after exactly one host call.
    const controller = new AbortController();
    let captainCalls = 0;
    const traces: PlaybookTraceEvent[] = [];
    const { ports } = makeRecordingPorts({
      callCaptain: async () => {
        captainCalls += 1;
        return { status: 'ok' };
      },
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as PlaybookTraceEvent;
        traces.push(trace);
        if (
          trace.type === 'captain.call.started' &&
          trace.callId === 'captain-2'
        ) {
          controller.abort(new Error('stop inside the started emission'));
        }
      },
    });
    const runtime = createCaptainRuntime({});
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput({
      text: 'release timing',
      signal: controller.signal,
    });

    expect(captainCalls).toBe(1);
    expect(result.outcome).toBe('aborted');
    const corrective = traces.filter(({ callId }) => callId === 'captain-2');
    expect(corrective.map(({ type }) => type)).toEqual([
      'captain.call.started',
      'captain.call.finished',
    ]);
    expect(corrective[1].payload).toMatchObject({ status: 'aborted' });
    await runtime.dispose();
  });
});

describe('empty ok player result corrective re-ask (DR-028 / PBRT-51)', () => {
  it.each(EMPTY_FINAL_TEXT_VARIANTS)(
    'recovers a %s finalText with the resume selection the first result left',
    async (_label, emptyText) => {
      const playerCalls: Array<{ prompt: string; resume: string | false }> = [];
      const { ports, telemetry } = makeRecordingPorts({
        callPlayer: async (_playerId, prompt, _signal, options) => {
          playerCalls.push({ prompt, resume: options.resume });
          if (playerCalls.length === 1) {
            return {
              status: 'ok',
              ...(emptyText === undefined ? {} : { finalText: emptyText }),
              resumeToken: 'tok-1',
            };
          }
          return { status: 'ok', finalText: 'All done, boss.' };
        },
        callJudge: async () => '{"guard":"implemented","summary":"shipped"}',
      });
      const runtime = createWorkflowRuntime({});
      await runtime.init(makeSession(ports));
      const result = await runtime.handleBossInput(turn('build the widget'));

      expect(result.outcome).toBe('terminal');
      expect(playerCalls).toHaveLength(2);
      // The same composed call, repeated — and the corrective call continues
      // the player session the first result left (PBRT-38 token adoption).
      expect(playerCalls[1].prompt).toBe(playerCalls[0].prompt);
      expect(playerCalls[0].resume).toBe(false);
      expect(playerCalls[1].resume).toBe('tok-1');
      const playerTraces = telemetry
        .map(({ payload }) => payload as { type?: string; callId?: string })
        .filter(
          (event) =>
            event.type === 'player.call.started' ||
            event.type === 'player.call.finished',
        );
      // Each call traces as its own started/finished pair.
      expect(
        playerTraces.map(({ type, callId }) => ({ type, callId })),
      ).toEqual([
        { type: 'player.call.started', callId: 'player-1' },
        { type: 'player.call.finished', callId: 'player-1' },
        { type: 'player.call.started', callId: 'player-2' },
        { type: 'player.call.finished', callId: 'player-2' },
      ]);
      await runtime.dispose();
    },
  );

  it('starts the corrective call fresh when the first result cleared the token', async () => {
    const resumes: Array<string | false> = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, _prompt, _signal, options) => {
        resumes.push(options.resume);
        return resumes.length === 1
          ? { status: 'ok', finalText: '' }
          : { status: 'ok', finalText: 'All done, boss.' };
      },
      callJudge: async () => '{"guard":"implemented","summary":"shipped"}',
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput(turn('build the widget'));

    expect(result.outcome).toBe('terminal');
    expect(resumes).toEqual([false, false]);
    await runtime.dispose();
  });

  it.each(EMPTY_FINAL_TEXT_VARIANTS)(
    'resolves the failed outcome after a second %s finalText',
    async (_label, emptyText) => {
      let playerCalls = 0;
      const { ports } = makeRecordingPorts({
        callPlayer: async () => {
          playerCalls += 1;
          return emptyText === undefined
            ? { status: 'ok' }
            : { status: 'ok', finalText: emptyText };
        },
      });
      const runtime = createWorkflowRuntime({});
      await runtime.init(makeSession(ports));
      const result = await runtime.handleBossInput(turn('build the widget'));

      expect(playerCalls).toBe(2);
      expect(result.outcome).toBe('failed');
      expect(result.state.stateId).toBe('failed');
      expect('error' in result ? result.error : undefined).toMatchObject({
        message: expect.stringMatching(/no finalText/) as unknown as string,
      });
      await runtime.dispose();
    },
  );

  it.each([
    ['aborted', { status: 'aborted' as const }],
    ['error', { status: 'error' as const, error: 'player crashed' }],
  ])('makes no second call after a first %s result', async (_label, first) => {
    let playerCalls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return first;
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput(turn('build the widget'));

    expect(playerCalls).toBe(1);
    expect(result.outcome).toBe('failed');
    expect(result.state.stateId).toBe('failed');
    await runtime.dispose();
  });

  it('skips the corrective re-ask when the boundary abort lands on the empty first result', async () => {
    // Aborts are never retried (DR-028 via DR-025's transport exclusion):
    // an abort fired from the first call's own finish sink must end the
    // turn as abort settlement after exactly one host call, matching the
    // direct-Captain boundary's queue-start signal check.
    const controller = new AbortController();
    let playerCalls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'ok', finalText: '' };
      },
      emitTelemetry: async (event) => {
        const trace = event.payload as { type?: string };
        if (
          event.topic === 'playbook.trace' &&
          trace.type === 'player.call.finished'
        ) {
          controller.abort(new Error('stop before the re-ask'));
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput({
      text: 'build the widget',
      signal: controller.signal,
    });

    expect(playerCalls).toBe(1);
    expect(result.outcome).toBe('aborted');
    await runtime.dispose();
  });

  it('makes no second host call when abort lands during the corrective started emission', async () => {
    // The pre-corrective signal check cannot see an abort that fires while
    // the corrective call's own `player.call.started` emission drains. The
    // boundary must settle that window as an ordinary abort — the pair
    // finished `aborted` after exactly one host call.
    const controller = new AbortController();
    let playerCalls = 0;
    const traces: PlaybookTraceEvent[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'ok', finalText: '' };
      },
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as PlaybookTraceEvent;
        traces.push(trace);
        if (
          trace.type === 'player.call.started' &&
          trace.callId === 'player-2'
        ) {
          controller.abort(new Error('stop inside the started emission'));
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput({
      text: 'build the widget',
      signal: controller.signal,
    });

    expect(playerCalls).toBe(1);
    expect(result.outcome).toBe('aborted');
    const corrective = traces.filter(({ callId }) => callId === 'player-2');
    expect(corrective.map(({ type }) => type)).toEqual([
      'player.call.started',
      'player.call.finished',
    ]);
    expect(corrective[1].payload).toMatchObject({ status: 'aborted' });
    await runtime.dispose();
  });

  it('finishes the player pair when the started sink records then rejects', async () => {
    // slc/link.md §Playbook trace: a recorded-then-rejected started sink
    // leaves no unpaired start — one best-effort error finish preserves the
    // call id and prompt, no host call begins, and the method rejects with
    // the original sink error, the same canonical handling the judge,
    // Captain, and apply boundaries already implement.
    let playerCalls = 0;
    const traces: PlaybookTraceEvent[] = [];
    const sinkFailure = new Error('started sink offline');
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'ok', finalText: 'done' };
      },
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as PlaybookTraceEvent;
        traces.push(trace);
        if (trace.type === 'player.call.started') throw sinkFailure;
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await expect(
      runtime.handleBossInput(turn('build the widget')),
    ).rejects.toBe(sinkFailure);
    expect(playerCalls).toBe(0);
    const pair = traces.filter(({ callId }) => callId === 'player-1');
    expect(pair.map(({ type }) => type)).toEqual([
      'player.call.started',
      'player.call.finished',
    ]);
    expect(pair[1].payload).toMatchObject({
      status: 'error',
      error: { message: 'started sink offline' },
      prompt: 'Implement this task: build the widget',
      roleId: 'coder',
    });
    await runtime.dispose();
  });
});

describe('host-owned player continuation (DR-030)', () => {
  it('selects and advances the shared token before the matching traces', async () => {
    const tokens = new Map<string, string>([['coder', 'parent-token']]);
    const operations: string[] = [];
    const store: PlayerSessionStore = {
      select(playerId) {
        operations.push(`select:${playerId}:${tokens.get(playerId) ?? 'fresh'}`);
        return tokens.get(playerId) ?? false;
      },
      update(playerId, resumeToken) {
        operations.push(`update:${playerId}:${resumeToken ?? 'clear'}`);
        if (resumeToken === undefined) tokens.delete(playerId);
        else tokens.set(playerId, resumeToken);
      },
      snapshot() {
        operations.push('snapshot');
        return Object.fromEntries(tokens);
      },
      restore(next) {
        operations.push('restore');
        tokens.clear();
        for (const [playerId, token] of Object.entries(next)) {
          tokens.set(playerId, token);
        }
      },
    };
    const resumes: Array<string | false> = [];
    let calls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, _prompt, _signal, options) => {
        calls += 1;
        resumes.push(options.resume);
        return calls === 1
          ? { status: 'ok', finalText: '', resumeToken: 'child-token' }
          : {
              status: 'ok',
              finalText: 'All done, boss.',
              resumeToken: 'final-token',
            };
      },
      callJudge: async () => '{"guard":"implemented","summary":"shipped"}',
      emitTelemetry: async (event) => {
        if (
          event.topic === 'playbook.trace' &&
          (event.payload as PlaybookTraceEvent).type === 'player.call.started'
        ) {
          operations.push(
            `started:${String(
              ((event.payload as PlaybookTraceEvent).payload as { resume?: unknown })
                .resume,
            )}`,
          );
        }
        if (
          event.topic === 'playbook.trace' &&
          (event.payload as PlaybookTraceEvent).type === 'player.call.finished'
        ) {
          operations.push(`finished:${tokens.get('coder') ?? 'clear'}`);
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports, store));

    const result = await runtime.handleBossInput(turn('build the widget'));

    expect(result.outcome).toBe('terminal');
    expect(resumes).toEqual(['parent-token', 'child-token']);
    expect(operations).toEqual([
      'select:coder:parent-token',
      'started:parent-token',
      'update:coder:child-token',
      'finished:child-token',
      'select:coder:child-token',
      'started:child-token',
      'update:coder:final-token',
      'finished:final-token',
    ]);
    await runtime.dispose();
    expect(tokens.get('coder')).toBe('final-token');
  });

  it('exports and restores through the supplied store', async () => {
    const firstTokens = new Map<string, string>();
    const firstStore: PlayerSessionStore = {
      select: (playerId) => firstTokens.get(playerId) ?? false,
      update(playerId, resumeToken) {
        if (resumeToken === undefined) firstTokens.delete(playerId);
        else firstTokens.set(playerId, resumeToken);
      },
      snapshot: () => Object.fromEntries(firstTokens),
      restore(next) {
        firstTokens.clear();
        for (const [playerId, token] of Object.entries(next)) {
          firstTokens.set(playerId, token);
        }
      },
    };
    let calls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        calls += 1;
        return {
          status: 'ok',
          finalText: 'Which database should I use?',
          resumeToken: 'parked-token',
        };
      },
      callJudge: async () =>
        '{"guard":"needsBossReply","question":"Which database?"}',
    });
    const first = createWorkflowRuntime({});
    const firstSession = makeSession(ports, firstStore);
    await first.init(firstSession);
    const parked = await first.handleBossInput(turn('build storage'));
    expect(parked.state.stateId).toBe('awaitBossReply');
    const snapshot = first.exportSnapshot!();
    expect(snapshot?.roleResumeTokens).toEqual({ coder: 'parked-token' });
    await first.dispose();
    expect(firstTokens.get('coder')).toBe('parked-token');

    const restoredTokens = new Map<string, string>();
    const restoreCalls: Readonly<Record<string, string>>[] = [];
    const restoredStore: PlayerSessionStore = {
      select: (playerId) => restoredTokens.get(playerId) ?? false,
      update(playerId, resumeToken) {
        if (resumeToken === undefined) restoredTokens.delete(playerId);
        else restoredTokens.set(playerId, resumeToken);
      },
      snapshot: () => Object.fromEntries(restoredTokens),
      restore(next) {
        restoreCalls.push(next);
        restoredTokens.clear();
        for (const [playerId, token] of Object.entries(next)) {
          restoredTokens.set(playerId, token);
        }
      },
    };
    const second = createWorkflowRuntime({});
    await second.restore!(makeSession(ports, restoredStore), snapshot!);

    expect(restoreCalls).toEqual([{ coder: 'parked-token' }]);
    expect(restoredTokens.get('coder')).toBe('parked-token');
    await second.dispose();
  });

  it('rejects a store selection failure before allocating or tracing a call', async () => {
    const storeError = new Error('continuation selection unavailable');
    const tokens = new Map<string, string>([['coder', 'prior-token']]);
    let selections = 0;
    const store: PlayerSessionStore = {
      select(playerId) {
        selections += 1;
        if (selections === 1) throw storeError;
        return tokens.get(playerId) ?? false;
      },
      update(playerId, resumeToken) {
        if (resumeToken === undefined) tokens.delete(playerId);
        else tokens.set(playerId, resumeToken);
      },
      snapshot: () => Object.fromEntries(tokens),
      restore(next) {
        tokens.clear();
        for (const [playerId, token] of Object.entries(next)) {
          tokens.set(playerId, token);
        }
      },
    };
    const resumes: Array<string | false> = [];
    const traces: PlaybookTraceEvent[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, _prompt, _signal, options) => {
        resumes.push(options.resume);
        return {
          status: 'ok',
          finalText: 'Recovered.',
          resumeToken: 'next-token',
        };
      },
      callJudge: async (prompt) =>
        prompt.includes('Classify the following Boss message')
          ? '{"type":"START"}'
          : '{"guard":"implemented","summary":"recovered"}',
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as PlaybookTraceEvent);
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports, store));

    await expect(runtime.handleBossInput(turn('first try'))).rejects.toBe(
      storeError,
    );
    expect(resumes).toEqual([]);
    expect(tokens.get('coder')).toBe('prior-token');
    expect(
      traces.filter(({ type }) => type.startsWith('player.call.')),
    ).toEqual([]);

    const recovered = await runtime.handleBossInput(turn('try again'));
    expect(recovered.outcome).toBe('terminal');
    expect(resumes).toEqual(['prior-token']);
    expect(
      traces.find(({ type }) => type === 'player.call.started')?.callId,
    ).toBe('player-1');
    await runtime.dispose();
  });

  it('rolls a shared store back when runtime restore does not bind', async () => {
    const sourceTokens = new Map<string, string>();
    const sourceStore: PlayerSessionStore = {
      select: (playerId) => sourceTokens.get(playerId) ?? false,
      update(playerId, resumeToken) {
        if (resumeToken === undefined) sourceTokens.delete(playerId);
        else sourceTokens.set(playerId, resumeToken);
      },
      snapshot: () => Object.fromEntries(sourceTokens),
      restore(next) {
        sourceTokens.clear();
        for (const [playerId, token] of Object.entries(next)) {
          sourceTokens.set(playerId, token);
        }
      },
    };
    const { ports } = makeRecordingPorts({
      callPlayer: async () => ({
        status: 'ok',
        finalText: 'Which database should I use?',
        resumeToken: 'snapshot-token',
      }),
      callJudge: async () =>
        '{"guard":"needsBossReply","question":"Which database?"}',
    });
    const source = createWorkflowRuntime({});
    await source.init(makeSession(ports, sourceStore));
    await source.handleBossInput(turn('build storage'));
    const snapshot = source.exportSnapshot!()!;
    await source.dispose();

    const restoredTokens = new Map<string, string>([
      ['coder', 'original-token'],
    ]);
    const restoreStore: PlayerSessionStore = {
      select: (playerId) => restoredTokens.get(playerId) ?? false,
      update(playerId, resumeToken) {
        if (resumeToken === undefined) restoredTokens.delete(playerId);
        else restoredTokens.set(playerId, resumeToken);
      },
      snapshot: () => Object.fromEntries(restoredTokens),
      restore(next) {
        restoredTokens.clear();
        for (const [playerId, token] of Object.entries(next)) {
          restoredTokens.set(playerId, token);
        }
      },
    };
    const brokenSnapshot = {
      ...snapshot,
      machine: { ...snapshot.machine, status: 'done' },
    };
    const restored = createWorkflowRuntime({});

    await expect(
      restored.restore!(makeSession(ports, restoreStore), brokenSnapshot),
    ).rejects.toBeDefined();
    expect(Object.fromEntries(restoredTokens)).toEqual({
      coder: 'original-token',
    });
    await restored.dispose();
  });

  it('pairs a continuation-store update failure and never interprets the result', async () => {
    const traces: PlaybookTraceEvent[] = [];
    const storeError = new Error('continuation store unavailable');
    const store: PlayerSessionStore = {
      select: () => false,
      update: () => {
        throw storeError;
      },
      snapshot: () => ({}),
      restore: () => undefined,
    };
    const { ports } = makeRecordingPorts({
      callPlayer: async () => ({
        status: 'ok',
        finalText: 'Implemented.',
        resumeToken: 'new-token',
      }),
      callJudge: async () => {
        throw new Error('judge must not run');
      },
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as PlaybookTraceEvent);
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports, store));

    await expect(
      runtime.handleBossInput(turn('build the widget')),
    ).rejects.toBe(storeError);
    expect(
      traces
        .filter(({ callId }) => callId === 'player-1')
        .map(({ type }) => type),
    ).toEqual(['player.call.started', 'player.call.finished']);
    expect(
      traces.find(
        ({ callId, type }) =>
          callId === 'player-1' && type === 'player.call.finished',
      )?.payload,
    ).toMatchObject({
      status: 'error',
      error: { message: 'continuation store unavailable' },
    });
    await runtime.dispose();
  });
});

// Synthetic nested-playbook workflow: ready → call (playbook) → done.
const nestedMachine = createMachine({
  id: 'nest',
  context: () => ({
    request: undefined as string | undefined,
    childOutput: undefined as unknown,
    lastError: undefined as unknown,
  }),
  initial: 'ready',
  states: {
    ready: {
      meta: meta('ready'),
      tags: ['playbook.parked'],
      on: {
        GO: {
          target: 'call',
          actions: assign({
            request: ({ event }) => (event as { request: string }).request,
          }),
        },
      },
    },
    call: {
      meta: meta('call'),
      tags: ['playbook.suspended'],
      invoke: {
        src: 'playbook',
        input: ({ context }) => ({
          stateId: 'call',
          playbookId: 'child',
          text: context.request ?? '',
        }),
        onDone: {
          target: 'done',
          actions: assign({ childOutput: ({ event }) => event.output }),
        },
        onError: {
          target: 'failed',
          actions: assign({ lastError: ({ event }) => event.error }),
        },
      },
    },
    failed: {
      meta: meta('failed'),
      tags: ['playbook.parked'],
      on: { GO: 'call' },
    },
    done: { meta: meta('done'), type: 'final' },
  },
  output: ({ context }) => ({ childOutput: context.childOutput ?? null }),
});

const createNestedRuntime = createXStatePlaybookRuntime(nestedMachine, {
  compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  roleStates: {},
  machineInput: () => ({}),
  entryEvent: { type: 'GO', textField: 'request' },
});

describe('nested playbook actor over the shared factory', () => {
  it('suspends on a child call and resumes to terminal through resumePlaybookCall', async () => {
    const { ports, telemetry } = makeRecordingPorts({
      callPlaybook: async (request) => {
        expect(request).toMatchObject({ playbookId: 'child', text: 'do it' });
        return { state: 'suspended', childSessionId: 'child-session-1' };
      },
    });
    const runtime = createNestedRuntime({});
    await runtime.init(makeSession(ports));

    const suspended = await runtime.handleBossInput(turn('do it'));
    expect(suspended.outcome).toBe('suspended');
    const pendingCall =
      'pendingCall' in suspended ? suspended.pendingCall : undefined;
    expect(pendingCall).toMatchObject({
      playbookId: 'child',
      childSessionId: 'child-session-1',
    });

    const resumed = await runtime.resumePlaybookCall({
      callId: pendingCall!.callId,
      result: {
        status: 'ok',
        playbookId: 'child',
        childSessionId: 'child-session-1',
        output: { note: 'child finished' },
      },
      signal: new AbortController().signal,
    });
    expect(resumed.outcome).toBe('terminal');
    expect('output' in resumed ? resumed.output : undefined).toEqual({
      childOutput: { note: 'child finished' },
    });

    const callTraces = telemetry
      .map(({ payload }) => payload as { type?: string })
      .filter(
        (event) =>
          event.type === 'playbook.call.started' ||
          event.type === 'playbook.call.finished',
      );
    expect(callTraces).toHaveLength(2);
    await runtime.dispose();
  });

  it('keeps the aborted resume settlement when the drain rejects with the exact resume reason', async () => {
    // slc/link.md §Abort: resumePlaybookCall surfaces only failures that
    // are not causally identical to its signal's reason; when every
    // candidate is that exact reason, the settled aborted result stands.
    const controller = new AbortController();
    const abortReason = new Error('boss cancelled the resume');
    let armed = true;
    const { ports } = makeRecordingPorts({
      callPlaybook: async () => ({
        state: 'suspended',
        childSessionId: 'child-session-1',
      }),
      emitTelemetry: async (event) => {
        if (
          armed &&
          controller.signal.aborted &&
          event.topic === 'playbook.fsm.state'
        ) {
          throw abortReason;
        }
      },
    });
    const runtime = createNestedRuntime({});
    await runtime.init(makeSession(ports));
    const suspended = await runtime.handleBossInput(turn('do it'));
    expect(suspended.outcome).toBe('suspended');
    const pendingCall =
      'pendingCall' in suspended ? suspended.pendingCall : undefined;
    controller.abort(abortReason);
    const resumed = await runtime.resumePlaybookCall({
      callId: pendingCall!.callId,
      result: {
        status: 'ok',
        playbookId: 'child',
        childSessionId: 'child-session-1',
        output: { note: 'late child' },
      },
      signal: controller.signal,
    });
    expect(resumed.outcome).toBe('aborted');
    armed = false;
    await runtime.dispose();
  });

  it('restores a suspended child without replaying its start', async () => {
    let hostStarts = 0;
    const { ports, statuses, telemetry } = makeRecordingPorts({
      callPlaybook: async (request) => {
        hostStarts += 1;
        expect(request).toMatchObject({ playbookId: 'child', text: 'do it' });
        return { state: 'suspended', childSessionId: 'child-session-1' };
      },
    });
    const session = makeSession(ports);
    const first = createNestedRuntime({});
    await first.init(session);
    const suspended = await first.handleBossInput(turn('do it'));
    expect(suspended.outcome).toBe('suspended');

    const snapshot = first.exportSnapshot?.();
    if (
      snapshot?.schemaVersion !== 3 ||
      snapshot.suspendedCall === undefined
    ) {
      throw new Error('expected a schema-3 suspended-call snapshot');
    }
    expect(snapshot.suspendedCall).toEqual({
      callId: 'playbook-1',
      stateId: 'call',
      playbookId: 'child',
      text: 'do it',
      childSessionId: 'child-session-1',
      turnId: 1,
    });
    expect(snapshot.sequences).toMatchObject({
      turn: 1,
      playbookCall: 1,
    });
    const telemetryBeforeRestore = telemetry.length;
    const statusesBeforeRestore = statuses.length;

    const restored = createNestedRuntime({});
    await restored.restore?.(session, snapshot);
    expect(hostStarts).toBe(1);
    expect(telemetry).toHaveLength(telemetryBeforeRestore);
    expect(statuses).toHaveLength(statusesBeforeRestore);
    expect(
      telemetry
        .map(({ payload }) => payload as PlaybookTraceEvent)
        .filter(({ type }) => type === 'playbook.call.started'),
    ).toHaveLength(1);

    const resumed = await restored.resumePlaybookCall({
      callId: snapshot.suspendedCall.callId,
      result: {
        status: 'ok',
        playbookId: snapshot.suspendedCall.playbookId,
        childSessionId: snapshot.suspendedCall.childSessionId,
        output: { note: 'child finished after restore' },
      },
      signal: new AbortController().signal,
    });
    expect(resumed.outcome).toBe('terminal');
    expect('output' in resumed ? resumed.output : undefined).toEqual({
      childOutput: { note: 'child finished after restore' },
    });
    const callTraces = telemetry
      .map(({ payload }) => payload as PlaybookTraceEvent)
      .filter(
        ({ type }) =>
          type === 'playbook.call.started' ||
          type === 'playbook.call.finished',
      );
    expect(callTraces).toHaveLength(2);
    expect(callTraces[1]).toMatchObject({
      type: 'playbook.call.finished',
      callId: snapshot.suspendedCall.callId,
      turnId: snapshot.suspendedCall.turnId,
      sequence: snapshot.sequences.trace + 1,
    });
    expect(hostStarts).toBe(1);

    await restored.dispose();
    await first.dispose();
  });

  it('rolls back a pre-confirm state mismatch and permits exact retry', async () => {
    let hostStarts = 0;
    const { ports, telemetry } = makeRecordingPorts({
      callPlaybook: async () => {
        hostStarts += 1;
        return { state: 'suspended', childSessionId: 'child-session-1' };
      },
    });
    const session = makeSession(ports);
    const first = createNestedRuntime({});
    await first.init(session);
    await first.handleBossInput(turn('do it'));
    const snapshot = first.exportSnapshot?.();
    if (
      snapshot?.schemaVersion !== 3 ||
      snapshot.suspendedCall === undefined
    ) {
      throw new Error('expected a schema-3 suspended-call snapshot');
    }
    const mismatched = structuredClone(snapshot);
    (mismatched.state as { value: unknown }).value = 'ready';

    const restored = createNestedRuntime({});
    await expect(restored.restore?.(session, mismatched)).rejects.toThrow(
      'restored actor state does not match snapshot state',
    );
    expect(hostStarts).toBe(1);
    expect(
      telemetry
        .map(({ payload }) => payload as PlaybookTraceEvent)
        .filter(({ type }) => type === 'playbook.call.finished'),
    ).toEqual([]);

    // Failed-start cleanup removes the provisional bridge claim and turn
    // ownership, so the same runtime can retry the authoritative snapshot.
    await restored.restore?.(session, snapshot);
    await restored.resumePlaybookCall({
      callId: snapshot.suspendedCall.callId,
      result: {
        status: 'ok',
        playbookId: snapshot.suspendedCall.playbookId,
        childSessionId: snapshot.suspendedCall.childSessionId,
      },
      signal: new AbortController().signal,
    });
    expect(hostStarts).toBe(1);
    expect(
      telemetry
        .map(({ payload }) => payload as PlaybookTraceEvent)
        .filter(({ type }) => type === 'playbook.call.finished'),
    ).toHaveLength(1);

    await restored.dispose();
    await first.dispose();
  });

  it('arms descriptor-free restores so an opaque invoke cannot reopen a child', async () => {
    let hostStarts = 0;
    const { ports, telemetry } = makeRecordingPorts({
      callPlaybook: async () => {
        hostStarts += 1;
        return { state: 'suspended', childSessionId: 'child-session-1' };
      },
    });
    const session = makeSession(ports);
    const first = createNestedRuntime({});
    await first.init(session);
    await first.handleBossInput(turn('do it'));
    const snapshot = first.exportSnapshot?.();
    if (
      snapshot?.schemaVersion !== 3 ||
      snapshot.suspendedCall === undefined
    ) {
      throw new Error('expected a schema-3 suspended-call snapshot');
    }
    const { suspendedCall: _suspendedCall, ...withoutCall } = snapshot;
    const forgedLegacy = {
      ...withoutCall,
      schemaVersion: 1 as const,
      state: {
        ...snapshot.state,
        tags: ['playbook.parked'],
        quiescent: true,
      },
    };

    const restored = createNestedRuntime({});
    await expect(restored.restore?.(session, forgedLegacy)).rejects.toThrow();
    expect(hostStarts).toBe(1);
    expect(
      telemetry
        .map(({ payload }) => payload as PlaybookTraceEvent)
        .filter(({ type }) => type === 'playbook.call.started'),
    ).toHaveLength(1);
    expect(
      telemetry
        .map(({ payload }) => payload as PlaybookTraceEvent)
        .filter(({ type }) => type === 'playbook.call.finished'),
    ).toEqual([]);

    await restored.dispose();
    await first.dispose();
  });

  it('round-trips the real CODE runtime while it is suspended behind REVIEW', async () => {
    let playerCalls = 0;
    let childStarts = 0;
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return {
          status: 'ok',
          finalText: 'Implemented and verified.\nCommit: abc123',
        };
      },
      callJudge: async () =>
        '{"guard":"directCommit","latestCommit":"abc123"}',
      callPlaybook: async () => {
        childStarts += 1;
        return {
          state: 'suspended',
          childSessionId: 'review-suspended',
        };
      },
    });
    const session = { ...makeSession(ports), playbookId: 'code' };
    const first = createCodePlaybookRuntime({});
    await first.init(session);
    const suspended = await first.handleBossInput(turn('Fix it.'));
    expect(suspended.outcome).toBe('suspended');
    const snapshot = first.exportSnapshot?.();
    if (
      snapshot?.schemaVersion !== 3 ||
      snapshot.suspendedCall === undefined
    ) {
      throw new Error('expected CODE to export its suspended REVIEW call');
    }

    const restored = createCodePlaybookRuntime({});
    await restored.restore?.(session, snapshot);
    const immediate = restored.exportSnapshot?.();
    expect(immediate).toMatchObject({
      schemaVersion: 3,
      state: snapshot.state,
      sequences: snapshot.sequences,
      suspendedCall: snapshot.suspendedCall,
    });
    expect(playerCalls).toBe(1);
    expect(childStarts).toBe(1);
    expect(
      telemetry
        .map(({ payload }) => payload as PlaybookTraceEvent)
        .filter(({ type }) => type === 'session.started'),
    ).toHaveLength(1);
    expect(
      telemetry
        .map(({ payload }) => payload as PlaybookTraceEvent)
        .filter(({ type }) => type === 'playbook.call.started'),
    ).toHaveLength(1);

    const resumed = await restored.resumePlaybookCall({
      callId: snapshot.suspendedCall.callId,
      result: {
        status: 'ok',
        playbookId: 'review',
        childSessionId: snapshot.suspendedCall.childSessionId,
        output: {
          approvedCommit: 'latest',
          noUnsettledFindings: true,
        },
      },
      signal: new AbortController().signal,
    });
    expect(resumed.outcome).toBe('terminal');
    const traces = telemetry.map(
      ({ payload }) => payload as PlaybookTraceEvent,
    );
    const finishIndex = traces.findIndex(
      ({ type }) => type === 'playbook.call.finished',
    );
    const parentTransitionIndex = traces.findIndex(
      ({ type }, index) => index > finishIndex && type === 'fsm.transition',
    );
    expect(finishIndex).toBeGreaterThanOrEqual(0);
    expect(parentTransitionIndex).toBeGreaterThan(finishIndex);
    expect(traces[finishIndex]).toMatchObject({
      callId: snapshot.suspendedCall.callId,
      turnId: snapshot.suspendedCall.turnId,
      sequence: snapshot.sequences.trace + 1,
    });
    expect(playerCalls).toBe(1);
    expect(childStarts).toBe(1);

    await restored.dispose();
    await first.dispose();
  });

  it('settles an immediately resolved child call without suspension', async () => {
    const { ports } = makeRecordingPorts({
      callPlaybook: async () => ({
        state: 'settled',
        result: {
          status: 'ok',
          playbookId: 'child',
          childSessionId: 'child-session-2',
          output: { note: 'fast child' },
        },
      }),
    });
    const runtime = createNestedRuntime({});
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput(turn('do it fast'));
    expect(result.outcome).toBe('terminal');
    expect('output' in result ? result.output : undefined).toEqual({
      childOutput: { note: 'fast child' },
    });
    await runtime.dispose();
  });
});

describe('parked-session snapshot over the shared factory', () => {
  it('exports a parked snapshot and restores it in a fresh runtime', async () => {
    let playerCalls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'ok', finalText: 'Which database should I use?' }
          : { status: 'ok', finalText: 'Done with sqlite.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          return '{"type":"BOSS_REPLY","questionId":"q-1"}';
        }
        return playerCalls === 1
          ? '{"guard":"needsBossReply","question":"Which database?"}'
          : '{"guard":"implemented","summary":"used sqlite"}';
      },
    });
    const first = createWorkflowRuntime({});
    const session = makeSession(ports);
    await first.init(session);
    const suspended = await first.handleBossInput(turn('build storage'));
    expect(suspended.state.stateId).toBe('awaitBossReply');

    const snapshot = first.exportSnapshot?.();
    expect(snapshot).toBeDefined();
    expect(snapshot?.sequences).not.toHaveProperty('captainCall');
    expect(snapshot?.pendingBossQuestions).toEqual([
      {
        questionId: 'q-1',
        asker: { kind: 'role', roleId: 'coder' },
        question: 'Which database?',
        sourceItem: 'WF-1',
      },
    ]);
    await first.dispose();

    const second = createWorkflowRuntime({});
    await second.restore!(
      { ...session, ports },
      snapshot!,
    );
    const resumed = await second.handleBossInput(turn('use sqlite'));
    expect(resumed.outcome).toBe('terminal');
    await second.dispose();
  });
});

describe('boundary hygiene', () => {
  it('returns no-action for empty text without any port call', async () => {
    let called = 0;
    const { ports } = makeRecordingPorts({
      callJudge: async () => {
        called += 1;
        return '{}';
      },
      callPlayer: async () => {
        called += 1;
        return { status: 'ok', finalText: 'x' };
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const result: PlaybookRunResult = await runtime.handleBossInput(
      turn('   '),
    );
    expect(result.outcome).toBe('no-action');
    expect(called).toBe(0);
    await runtime.dispose();
  });

  it('rejects a second init and use before init', async () => {
    const { ports } = makeRecordingPorts();
    const runtime = createWorkflowRuntime({});
    await expect(runtime.handleBossInput(turn('x'))).rejects.toThrow(
      /init must be called first/,
    );
    await runtime.init(makeSession(ports));
    await expect(runtime.init(makeSession(ports))).rejects.toThrow(
      /already initialized/,
    );
    await runtime.dispose();
  });

  // PBRT-6: stopping a still-running actor makes XState fire one more
  // `@xstate.snapshot` carrying the *unchanged* state value with
  // `status: 'stopped'`. That is a disposal artifact, not a state entry, so
  // disposal reports itself with `session.disposed` and nothing else.
  it('emits no status or FSM telemetry for the actor stop during dispose', async () => {
    const { ports, statuses, telemetry } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'done' }),
      callJudge: async () => '{"guard":"implemented","summary":"shipped"}',
    });
    const runtime = createWorkflowRuntime({ command: 'false' });
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput(turn('build the widget'));
    // Parked at a non-final state, so its actor is still running at dispose.
    expect(result.state.stateId).toBe('failed');

    const traceTypes = (): string[] =>
      telemetry
        .filter(({ topic }) => topic === 'playbook.trace')
        .map(({ payload }) => (payload as PlaybookTraceEvent).type);
    const fsmStateCount = (): number =>
      telemetry.filter(({ topic }) => topic === 'playbook.fsm.state').length;
    const statusesBefore = statuses.map(({ message }) => message);
    const tracesBefore = traceTypes();
    const fsmStatesBefore = fsmStateCount();

    await runtime.dispose();

    expect(traceTypes().slice(tracesBefore.length)).toEqual([
      'session.disposed',
    ]);
    expect(fsmStateCount()).toBe(fsmStatesBefore);
    expect(statuses.map(({ message }) => message)).toEqual(statusesBefore);
  });
});

describe('runtime compatibility declaration (DR-022)', () => {
  it('reports an integer ABI and a supported-schema set that admits it', () => {
    expect(Number.isSafeInteger(RUNTIME_ABI)).toBe(true);
    expect(SUPPORTED_ARTIFACT_SCHEMAS.length).toBeGreaterThan(0);
    expect(
      SUPPORTED_ARTIFACT_SCHEMAS.every((schema) =>
        Number.isSafeInteger(schema),
      ),
    ).toBe(true);
    expect(Object.isFrozen(SUPPORTED_ARTIFACT_SCHEMAS)).toBe(true);
  });

  it('constructs and runs under a matching link-time declaration', async () => {
    const runtime = createXStatePlaybookRuntime(workflowMachine, {
      ...workflowSpec,
      compat: {
        artifactSchema: SUPPORTED_ARTIFACT_SCHEMAS[0],
        runtimeAbi: RUNTIME_ABI,
      },
    })({});
    const { ports } = makeRecordingPorts();
    await runtime.init(makeSession(ports));
    const result = await runtime.handleBossInput(turn('   '));
    expect(result.outcome).toBe('no-action');
    await runtime.dispose();
  });

  it('rejects a declaration-free legacy artifact', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        compat: undefined,
      }),
    ).toThrow(/spec\.compat is required/);
  });

  it('rejects an unsupported artifact schema naming the supported set', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        compat: { artifactSchema: 99, runtimeAbi: RUNTIME_ABI },
      }),
    ).toThrow(
      new TypeError(
        'workflow artifact declares schema 99, but this ' +
          '@sublang/playbook/xstate-runtime engine supports [2]',
      ),
    );
  });

  it('rejects a mismatched runtime ABI naming both values', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI + 1 },
      }),
    ).toThrow(
      new TypeError(
        'workflow artifact declares runtime ABI 2, but this ' +
          '@sublang/playbook/xstate-runtime engine implements 1',
      ),
    );
  });

  it('raises the schema error alone when both values are wrong', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        compat: { artifactSchema: 99, runtimeAbi: RUNTIME_ABI + 1 },
      }),
    ).toThrow(/declares schema 99.*supports \[2\]/);
  });

  it('rejects a malformed declaration naming the offending member', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        compat: { artifactSchema: 1.5, runtimeAbi: RUNTIME_ABI },
      }),
    ).toThrow(/spec\.compat\.artifactSchema must be an integer/);
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        compat: {
          artifactSchema: 2,
          runtimeAbi: 'latest',
        } as unknown as { artifactSchema: number; runtimeAbi: number },
      }),
    ).toThrow(/spec\.compat\.runtimeAbi must be an integer/);
  });

  it('checks compatibility before rejecting an unsupported parallel machine', () => {
    expect(() =>
      createXStatePlaybookRuntime(decideMachine, {
        label: 'decide-control',
        snapshotOptions: (value) =>
          (value ?? {}) as Record<string, never>,
        compat: { artifactSchema: 99, runtimeAbi: RUNTIME_ABI },
      }),
    ).toThrow(
      new TypeError(
        'decide-control artifact declares schema 99, but this ' +
          '@sublang/playbook/xstate-runtime engine supports [2]',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// DR-029 control surface (PBRT-52 / PBRT-53): describe/apply over the
// shared factory — synthetic workflow machines plus the real linked CODE
// runtime, with the parallel DECIDE FSM held outside the factory's supported
// domain, under fake ports with scripted per-call results.
// ---------------------------------------------------------------------------

function deferredValue<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sigOf(): AbortSignal {
  return new AbortController().signal;
}

function playbookTraces(
  telemetry: RecordedTelemetry[],
): PlaybookTraceEvent[] {
  return telemetry
    .filter(({ topic }) => topic === 'playbook.trace')
    .map(({ payload }) => payload as PlaybookTraceEvent);
}

function applyTraces(telemetry: RecordedTelemetry[]): PlaybookTraceEvent[] {
  return playbookTraces(telemetry).filter(
    (event) =>
      event.type === 'apply.started' || event.type === 'apply.finished',
  );
}

// Synthetic machine with a context-conditional jump guard plus deliberately
// non-JSON-safe context entries, for the PBRT-53 sanitize and
// excluded-to-included flip rows.
const conditionalMachine = createMachine({
  id: 'cond',
  context: () => ({
    task: undefined as string | undefined,
    note: new Error('kept note') as unknown,
    probe: (() => true) as unknown,
    lastError: undefined as unknown,
  }),
  initial: 'ready',
  on: {
    BOSS_INTERRUPT: {
      guard: ({ context, event }) =>
        (event as { targetId?: string }).targetId === 'implement' &&
        context.task !== undefined,
      target: '#cond-implement',
      reenter: true,
    },
  },
  states: {
    ready: {
      meta: meta('ready'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'implement',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
          }),
        },
      },
    },
    implement: {
      id: 'cond-implement',
      meta: roleMeta('implement', 'coder'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'implement',
          role: 'coder',
          sourceItem: 'CD-1',
          prompt: 'Do: <task>',
          task: context.task,
          result: { done: 'Finished.' },
        }),
        onDone: { target: 'ready' },
        onError: {
          target: 'failed',
          actions: assign({ lastError: ({ event }) => event.error }),
        },
      },
    },
    awaitBossReply: {
      meta: meta('awaitBossReply'),
      tags: ['playbook.parked'],
      on: { BOSS_REPLY: { target: 'implement' } },
    },
    failed: {
      meta: meta('failed'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'implement',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
          }),
        },
      },
    },
  },
});

const createConditionalRuntime = createXStatePlaybookRuntime(
  conditionalMachine,
  {
    label: 'conditional',
    compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: (value) => (value ?? {}) as Record<string, never>,
    roleStates: {
      implement: { role: 'coder', label: 'implement state' },
    },
    machineInput: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    // The declared projection names one JSON-safe member and one that is
    // not, so the sanitize row still has something to drop.
    controlContextFields: ['task', 'note', 'probe'],
  },
);

// DR-034: the same workflow machine, whose entry action copies the entry
// text into `task`, with that member declared as the retry payload's
// source. Everything else matches `createWorkflowRuntime`, so a difference
// between the two is the declaration's doing.
const createRecoverableWorkflowRuntime = createXStatePlaybookRuntime(
  workflowMachine,
  {
    ...workflowSpec,
    label: 'recoverable-workflow',
    entryEvent: { type: 'START', textField: 'task', contextField: 'task' },
  },
);

describe('control surface over the shared factory (DR-029 / PBRT-52 / PBRT-53)', () => {
  it('exposes describe and apply together on every factory runtime and detects a pair-less runtime distinctly', () => {
    const factoryRuntimes: PlaybookRuntime[] = [
      createWorkflowRuntime({}),
      createConditionalRuntime({}),
      createCodePlaybookRuntime({}),
    ];
    for (const runtime of factoryRuntimes) {
      expect(typeof runtime.describe).toBe('function');
      expect(typeof runtime.apply).toBe('function');
    }
    // DR-022-style feature detection: the pair stays optional on the
    // contract, so a capability-less runtime remains legal and reports the
    // pair as absent — it advertises no actions and plain text delivery is
    // the only verb against it.
    const capabilityLess: PlaybookRuntime = {
      init: async () => {},
      handleBossInput: async () => {
        throw new Error('unused');
      },
      resumePlaybookCall: async () => {
        throw new Error('unused');
      },
      dispose: async () => {},
    };
    expect(capabilityLess.describe).toBeUndefined();
    expect(capabilityLess.apply).toBeUndefined();
  });

  // PBRT-52: the view's context is an artifact-authored projection, not a
  // serialization of the FSM context. An artifact that declares none exports
  // none, so a context member — including one added to the machine after the
  // artifact was linked — is private until someone names it. Allow-by-default
  // export is what let CODE's resolved roster and raw player output reach a
  // session-Captain prompt required to exclude them (CAPTAIN-9).
  it('exports no control context for a runtime that declares no projection', async () => {
    const { ports } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'error', error: 'agent crashed' }),
    });
    // `workflowSpec` declares no `controlContextFields`.
    const runtime = createWorkflowRuntime({ command: 'true' });
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('build the widget'));

    const view = runtime.describe!();
    // The live FSM context is full — `task`, `command`, `lastError` — and
    // the view carries none of it.
    expect(view.state.stateId).toBe('failed');
    expect(view.context).toBeUndefined();
    expect(view.lastError).toMatchObject({ message: 'agent crashed' });
    expect(view.actions.length).toBeGreaterThan(0);
    await runtime.dispose();
  });

  // Source-first standing guard. The privacy contract lives in `slc/link.md`
  // and reaches a shipped runtime only through the projection its artifact
  // declares, so an artifact that ships without one — a re-link that dropped
  // it, or a new artifact whose author never read the clause — silently
  // exposes nothing, or, if the engine default ever regressed, everything.
  // Artifacts are discovered rather than listed, so the next one is covered
  // without anyone remembering this file.
  describe('linked artifacts declare their control-context projection', () => {
    const root = new URL('../', import.meta.url);
    const artifacts = readdirSync(new URL('reference/sdlc/', root), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.playbook'))
      .flatMap((entry) => {
        const dir = `reference/sdlc/${entry.name}/`;
        return readdirSync(new URL(dir, root))
          .filter((file) => file.endsWith('.playbook.ts'))
          .map(
            (file) =>
              [
                `${dir}${file}`,
                readFileSync(new URL(`${dir}${file}`, root), 'utf8'),
              ] as [string, string],
          );
      });

    it('discovers every linked artifact', () => {
      expect(artifacts.map(([path]) => path).sort()).toEqual([
        'reference/sdlc/captain.playbook/captain.playbook.ts',
        'reference/sdlc/code.playbook/code.playbook.ts',
        'reference/sdlc/decide.playbook/decide.playbook.ts',
        'reference/sdlc/review.playbook/review.playbook.ts',
      ]);
    });

    it.each(artifacts)('%s declares what its control view exposes', (
      _path,
      source,
    ) => {
      // Only a shared-factory artifact carries a spec; a fat artifact owns its
      // own `describe` — or, like DECIDE, ships without the pair at all.
      if (!source.includes('createXStatePlaybookRuntime(')) return;
      expect(source).toContain('controlContextFields:');
    });

    // DR-034's companion standing guard. A recoverable failure state whose
    // artifact names no retry source is recoverable only while its process
    // lives, and the engine cannot say so for a third-party artifact — so
    // the repository says it for the artifacts it maintains, and a re-link
    // that drops the declaration fails here rather than in a continued
    // session. The source is a member of the deterministic entry event, so
    // this binds an artifact that declares one; a controller playbook whose
    // parked entry is a mapped union has no such event and no host that
    // reads its actions.
    it.each(artifacts)('%s declares its retry source where it can fail', (
      path,
      source,
    ) => {
      if (!source.includes('createXStatePlaybookRuntime(')) return;
      if (!source.includes('entryEvent:')) return;
      const fsmSource = readFileSync(
        new URL(path.replace('.playbook.ts', '.fsm.ts'), root),
        'utf8',
      );
      if (!/\n\s{4}failed: \{/.test(fsmSource)) return;
      expect(source).toContain('contextField:');
    });

    // The `_internal` clause of link.md §Output, matched to what each machine
    // actually does: a playbook that calls players exposes the player
    // composer; a controller that calls none exposes no stub under that name.
    it.each(artifacts)('%s exposes the composers its machine uses', (
      path,
      source,
    ) => {
      const internal = /export const _internal = \{([\s\S]*?)\n\};/.exec(
        source,
      )?.[1];
      expect(internal).toBeDefined();
      const fsmSource = readFileSync(
        new URL(path.replace('.playbook.ts', '.fsm.ts'), root),
        'utf8',
      );
      const callsPlayers = /src:\s*['"]player['"]/.test(fsmSource);
      if (source.includes('createXStatePlaybookRuntime(') && callsPlayers) {
        expect(source).toContain('roleStates:');
      }
      expect(/compose\w*Prompt/.test(internal!)).toBe(true);
      expect(internal!.includes('composePlayerPrompt')).toBe(callsPlayers);
    });
  });

  it('refuses a projection naming a member the view surfaces first-class', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        controlContextFields: ['task', 'lastError'],
      }),
    ).toThrow(/controlContextFields must not name lastError/);
  });

  it('throws from describe and apply before init, during an active boundary, and after disposal', async () => {
    const fresh = createWorkflowRuntime({});
    expect(() => fresh.describe!()).toThrow(/init must be called first/);
    await expect(
      fresh.apply!({ actionId: 'jump:implement', key: 'k', signal: sigOf() }),
    ).rejects.toThrow(/init must be called first/);

    const playerStarted = deferredValue<void>();
    const playerRelease = deferredValue<PlayerResult>();
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerStarted.resolve();
        return playerRelease.promise;
      },
      callJudge: async () => '{"guard":"implemented","summary":"done"}',
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const activeTurn = runtime.handleBossInput(turn('busy work'));
    await playerStarted.promise;
    expect(() => runtime.describe!()).toThrow(
      /another runtime turn is active/,
    );
    await expect(
      runtime.apply!({
        actionId: 'jump:implement',
        key: 'held',
        signal: sigOf(),
      }),
    ).rejects.toThrow(/another runtime turn is active/);
    playerRelease.resolve({ status: 'ok', finalText: 'done' });
    await activeTurn;

    // The rejected-by-lifecycle call reached no acceptance, so its key
    // recorded nothing: a later call with it settles on the live state
    // (rejected here — the machine is terminal) instead of replaying.
    const receipt = await runtime.apply!({
      actionId: 'jump:implement',
      key: 'held',
      signal: sigOf(),
    });
    expect(receipt.disposition).toBe('rejected');

    await runtime.dispose();
    expect(() => runtime.describe!()).toThrow(/disposing or disposed/);
    await expect(
      runtime.apply!({ actionId: 'jump:implement', key: 'k2', signal: sigOf() }),
    ).rejects.toThrow(/disposing or disposed/);
  });

  it('describes side-effect free: view fields, pending question id, live jump derivation, unmoved machine', async () => {
    let playerCalls = 0;
    const { ports, statuses, telemetry } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'ok', finalText: 'Which database should I use?' };
      },
      callJudge: async () =>
        '{"guard":"needsBossReply","question":"Which database?"}',
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));

    // Parked at ready: the machine's own guards accept the jump, so it is
    // advertised; no retry entry outside the failure state.
    const atReady = runtime.describe!();
    expect(atReady.state.stateId).toBe('ready');
    // The view publishes what the state *means*, from the same source
    // descriptions the action labels are written from: a controller host has
    // no other grounding for a status answer, and a state id is not
    // Boss-appropriate text.
    expect(atReady.stateDescription).toBe('ready state');
    expect(atReady.actions).toEqual([
      { id: 'jump:implement', label: 'Resume from: implement state' },
    ]);
    expect(atReady.pendingQuestions).toEqual([]);
    expect(atReady.lastError).toBeUndefined();

    await runtime.handleBossInput(turn('build storage'));
    const snapshotBefore = runtime.exportSnapshot!();
    const statusCount = statuses.length;
    const telemetryCount = telemetry.length;

    const first = runtime.describe!();
    const second = runtime.describe!();
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.actions)).toBe(true);
    // Side-effect free: no trace, status, or telemetry; the machine
    // snapshot is unmoved.
    expect(statuses.length).toBe(statusCount);
    expect(telemetry.length).toBe(telemetryCount);
    expect(runtime.exportSnapshot!()).toEqual(snapshotBefore);

    expect(first.state.stateId).toBe('awaitBossReply');
    expect(first.stateDescription).toBe('awaitBossReply state');
    expect(first.pendingQuestions).toEqual([
      {
        questionId: 'q-1',
        asker: { kind: 'role', roleId: 'coder' },
        question: 'Which database?',
        sourceItem: 'WF-1',
      },
    ]);
    expect(first.lastError).toBeUndefined();
    expect(first.actions.map(({ id }) => id)).toEqual(['jump:implement']);
    expect(playerCalls).toBe(1);
    await runtime.dispose();
  });

  it('advertises the failure-state retry and replays exactly the recorded event with no classification call', async () => {
    let playerCalls = 0;
    const playerPrompts: string[] = [];
    const judgePrompts: string[] = [];
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerCalls += 1;
        playerPrompts.push(prompt);
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async (prompt) => {
        judgePrompts.push(prompt);
        return '{"guard":"implemented","summary":"recovered"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const failedRun = await runtime.handleBossInput(turn('build the widget'));
    expect(failedRun.outcome).toBe('failed');

    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(view.lastError).toMatchObject({
      name: 'Error',
      message: 'agent crashed',
    });
    expect(view.actions).toEqual([
      { id: 'retry:START', label: 'Retry: implement state' },
      { id: 'jump:implement', label: 'Resume from: implement state' },
    ]);

    const judgeCallsBefore = judgePrompts.length;
    const receipt = await runtime.apply!({
      actionId: 'retry:START',
      key: 'retry-1',
      signal: sigOf(),
    });
    expect(receipt.disposition).toBe('executed');
    expect(
      receipt.disposition === 'executed' ? receipt.run.outcome : undefined,
    ).toBe('terminal');
    // The retry replayed the recorded classified event with its recorded
    // payload: the second player prompt is byte-equal to the first, and no
    // judge call was a Boss-text classification.
    expect(playerPrompts).toEqual([
      'Implement this task: build the widget',
      'Implement this task: build the widget',
    ]);
    for (const prompt of judgePrompts.slice(judgeCallsBefore)) {
      expect(prompt).not.toContain('Classify the following Boss message');
    }

    const pairs = applyTraces(telemetry);
    expect(pairs.map(({ type }) => type)).toEqual([
      'apply.started',
      'apply.finished',
    ]);
    expect(pairs[0].callId).toBe('apply-1');
    expect(pairs[1].callId).toBe('apply-1');
    expect(pairs[0].turnId).toBe(pairs[1].turnId);
    expect(pairs[0].payload).toMatchObject({
      actionId: 'retry:START',
      key: 'retry-1',
      stateId: 'failed',
    });
    expect(pairs[1].payload).toMatchObject({
      actionId: 'retry:START',
      key: 'retry-1',
      disposition: 'executed',
    });
    await runtime.dispose();
  });

  it('advertises no retry when the failure state refuses the recorded event', async () => {
    let playerCalls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'ok', finalText: 'Which database should I use?' }
          : { status: 'error', error: 'resume crashed' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          return '{"type":"BOSS_REPLY","questionId":"q-1"}';
        }
        return '{"guard":"needsBossReply","question":"Which database?"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('build storage'));
    const failedRun = await runtime.handleBossInput(turn('use sqlite'));
    expect(failedRun.outcome).toBe('failed');

    // The recorded last classified event is BOSS_REPLY, which the failure
    // state does not accept — no retry entry, no invented substitute.
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(view.lastError).toMatchObject({ message: 'resume crashed' });
    expect(view.actions.map(({ id }) => id)).toEqual(['jump:implement']);
    await runtime.dispose();
  });

  it('derives the declared failure-state retry from the persisted snapshot, identically before and after restore', async () => {
    const playerPrompts: string[] = [];
    let playerCalls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerCalls += 1;
        playerPrompts.push(prompt);
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async () => '{"guard":"implemented","summary":"recovered"}',
    });
    const session = makeSession(ports);
    const source = createRecoverableWorkflowRuntime({});
    await source.init(session);
    const failedRun = await source.handleBossInput(turn('build the widget'));
    expect(failedRun.outcome).toBe('failed');

    const live = source.describe!().actions;
    expect(live).toEqual([
      { id: 'retry:START', label: 'Retry: implement state' },
      { id: 'jump:implement', label: 'Resume from: implement state' },
    ]);

    // The recovery input rides the machine snapshot the host already
    // persists, so nothing is added to the snapshot for it.
    const snapshot = source.exportSnapshot!()!;
    expect(Object.keys(snapshot).sort()).toEqual([
      'machine',
      'pendingBossQuestions',
      'playbookId',
      'roleResumeTokens',
      'schemaVersion',
      'sequences',
      'state',
    ]);
    await source.dispose();

    // A fresh process holds no recorded event, and the same action derives
    // anyway — same id, same label — and replays the same player prompt.
    const restored = createRecoverableWorkflowRuntime({});
    await restored.restore!(session, snapshot);
    expect(restored.describe!().actions).toEqual(live);

    const receipt = await restored.apply!({
      actionId: 'retry:START',
      key: 'retry-after-restore',
      signal: sigOf(),
    });
    expect(receipt.disposition).toBe('executed');
    expect(playerPrompts[1]).toBe(playerPrompts[0]);
    await restored.dispose();
  });

  it('recovers a failure reached after a Boss reply, which the recorded event cannot', async () => {
    const makePorts = () => {
      let playerCalls = 0;
      return makeRecordingPorts({
        callPlayer: async () => {
          playerCalls += 1;
          return playerCalls === 1
            ? { status: 'ok', finalText: 'Which database should I use?' }
            : playerCalls === 2
              ? { status: 'error', error: 'resume crashed' }
              : { status: 'ok', finalText: 'Recovered.' };
        },
        callJudge: async (prompt) => {
          if (prompt.includes('Classify the following Boss message')) {
            return '{"type":"BOSS_REPLY","questionId":"q-1"}';
          }
          return playerCalls === 1
            ? '{"guard":"needsBossReply","question":"Which database?"}'
            : '{"guard":"implemented","summary":"recovered"}';
        },
      });
    };

    // The recorded event is the reply that resumed the work, which the
    // failure state refuses — so the recorded source advertises no retry at
    // all, in its own live process.
    const { ports: recordedPorts } = makePorts();
    const recorded = createWorkflowRuntime({});
    await recorded.init(makeSession(recordedPorts));
    await recorded.handleBossInput(turn('build storage'));
    // At the wait the question is pending on every surface.
    expect(recorded.describe!().pendingQuestions).toHaveLength(1);
    expect(recorded.exportSnapshot!()!.pendingBossQuestions).toHaveLength(1);
    expect((await recorded.handleBossInput(turn('use sqlite'))).outcome).toBe(
      'failed',
    );
    expect(recorded.describe!().actions.map(({ id }) => id)).toEqual([
      'jump:implement',
    ]);
    // The answered question the failure state retains in context is not
    // pending: the view and the snapshot agree with the gated state
    // telemetry, so a mirroring shell can settle this parked record.
    expect(recorded.describe!().pendingQuestions).toEqual([]);
    expect(recorded.exportSnapshot!()!.pendingBossQuestions).toEqual([]);
    await recorded.dispose();

    // The declared source names the entry text the machine still holds, so
    // the same failure is recoverable — and stays so across restore.
    const { ports } = makePorts();
    const session = makeSession(ports);
    const declared = createRecoverableWorkflowRuntime({});
    await declared.init(session);
    await declared.handleBossInput(turn('build storage'));
    expect((await declared.handleBossInput(turn('use sqlite'))).outcome).toBe(
      'failed',
    );
    expect(declared.describe!().actions).toEqual([
      { id: 'retry:START', label: 'Retry: implement state' },
      { id: 'jump:implement', label: 'Resume from: implement state' },
    ]);
    const snapshot = declared.exportSnapshot!()!;
    expect(snapshot.pendingBossQuestions).toEqual([]);
    await declared.dispose();

    const restored = createRecoverableWorkflowRuntime({});
    await restored.restore!(session, snapshot);
    const receipt = await restored.apply!({
      actionId: 'retry:START',
      key: 'reply-path-retry',
      signal: sigOf(),
    });
    expect(receipt.disposition).toBe('executed');
    expect(
      receipt.disposition === 'executed' ? receipt.run.outcome : undefined,
    ).toBe('terminal');
    await restored.dispose();
  });

  it('restarts deterministically at a failure after an answered question', async () => {
    const classifierPrompts: string[] = [];
    const playerPrompts: string[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerPrompts.push(prompt);
        return playerPrompts.length === 1
          ? { status: 'ok', finalText: 'Which database should I use?' }
          : playerPrompts.length === 2
            ? { status: 'error', error: 'resume crashed' }
            : { status: 'ok', finalText: 'Restarted.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          classifierPrompts.push(prompt);
          return '{"type":"BOSS_REPLY","questionId":"q-1"}';
        }
        return playerPrompts.length === 1
          ? '{"guard":"needsBossReply","question":"Which database?"}'
          : '{"guard":"implemented","summary":"restarted"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('build storage'));
    expect((await runtime.handleBossInput(turn('use sqlite'))).outcome).toBe(
      'failed',
    );
    // The reply turn classified at the wait with the question presented.
    expect(classifierPrompts).toHaveLength(1);
    expect(classifierPrompts[0]).toContain('Pending Boss question:');

    // At the failure the retained question is answered history and PBRT-1
    // names the state a deterministic entry: delivered text restarts with
    // no judge call for the retained question to steer.
    const restarted = await runtime.handleBossInput(turn('start over on pg'));
    expect(classifierPrompts).toHaveLength(1);
    expect(restarted.outcome).toBe('terminal');
    expect(playerPrompts).toHaveLength(3);
    expect(playerPrompts[2]).toContain('start over on pg');
    await runtime.dispose();
  });

  it('excludes the declared retry when its member holds no text instead of falling back to the record', async () => {
    const createUnsourcedRuntime = createXStatePlaybookRuntime(workflowMachine, {
      ...workflowSpec,
      label: 'unsourced-workflow',
      // Declared, but naming a member this machine never populates.
      entryEvent: {
        type: 'START',
        textField: 'task',
        contextField: 'neverAssigned',
      },
    });
    const { ports } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'error', error: 'agent crashed' }),
    });
    const runtime = createUnsourcedRuntime({});
    await runtime.init(makeSession(ports));
    expect((await runtime.handleBossInput(turn('build it'))).outcome).toBe(
      'failed',
    );
    // The recorded event would have produced `retry:START` here; a declared
    // source that cannot be read excludes the candidate rather than
    // reaching for a record a restored process would not have.
    expect(runtime.describe!().actions.map(({ id }) => id)).toEqual([
      'jump:implement',
    ]);
    await runtime.dispose();
  });

  it('leaves an undeclared runtime with its process-local retry, absent after restore', async () => {
    const { ports } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'error', error: 'agent crashed' }),
    });
    const session = makeSession(ports);
    const source = createWorkflowRuntime({});
    await source.init(session);
    expect((await source.handleBossInput(turn('build it'))).outcome).toBe(
      'failed',
    );
    expect(source.describe!().actions.map(({ id }) => id)).toEqual([
      'retry:START',
      'jump:implement',
    ]);
    const snapshot = source.exportSnapshot!()!;
    await source.dispose();

    const restored = createWorkflowRuntime({});
    await restored.restore!(session, snapshot);
    expect(restored.describe!().actions.map(({ id }) => id)).toEqual([
      'jump:implement',
    ]);
    await restored.dispose();
  });

  it('derives context-conditional jumps from the live snapshot and sanitizes the control context', async () => {
    const { ports } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'error', error: 'cond agent failed' }),
    });
    const runtime = createConditionalRuntime({});
    await runtime.init(makeSession(ports));

    // Fresh ready: the jump guard requires context input the machine does
    // not yet hold, so the candidate is excluded.
    expect(runtime.describe!().actions).toEqual([]);

    const failedRun = await runtime.handleBossInput(turn('polish the docs'));
    expect(failedRun.outcome).toBe('failed');

    // The live context gained the required input: excluded flips to
    // included; the recorded entry event is retryable from failed.
    const view = runtime.describe!();
    expect(view.actions).toEqual([
      { id: 'retry:START', label: 'Retry: implement state' },
      { id: 'jump:implement', label: 'Resume from: implement state' },
    ]);
    // Sanitized JSON-safe context: the raw Error entry is normalized, the
    // non-JSON-safe function entry is dropped, and the first-class-surfaced
    // members (lastError, pendingBossQuestion) are omitted.
    expect(Object.keys(view.context as Record<string, unknown>)).toEqual([
      'task',
      'note',
    ]);
    expect(view.context).toMatchObject({
      task: 'polish the docs',
      note: { name: 'Error', message: 'kept note' },
    });
    expect(view.lastError).toMatchObject({
      name: 'Error',
      message: 'cond agent failed',
    });
    await runtime.dispose();
  });

  it('records no receipt for keys that never reach acceptance and executes them later', async () => {
    const playerPrompts: string[] = [];
    let failStartSink = false;
    const telemetryEvents: RecordedTelemetry[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async (_playerId, prompt) => {
        playerPrompts.push(prompt);
        return { status: 'ok', finalText: 'done' };
      },
      callJudge: async () => '{"guard":"implemented","summary":"jumped"}',
      emitTelemetry: async (event) => {
        telemetryEvents.push({ topic: event.topic, payload: event.payload });
        const trace = event.payload as { type?: string };
        if (
          event.topic === 'playbook.trace' &&
          trace.type === 'apply.started' &&
          failStartSink
        ) {
          failStartSink = false;
          throw new Error('start sink offline');
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));

    // Pre-acceptance abort: the call throws, records nothing, and emits no
    // trace pair.
    const preAborted = new AbortController();
    preAborted.abort(new Error('gone before start'));
    await expect(
      runtime.apply!({
        actionId: 'jump:implement',
        key: 'first',
        signal: preAborted.signal,
      }),
    ).rejects.toThrow('gone before start');
    expect(applyTraces(telemetryEvents)).toEqual([]);

    // Pre-acceptance start-sink rejection: same key, still no receipt.
    failStartSink = true;
    await expect(
      runtime.apply!({
        actionId: 'jump:implement',
        key: 'first',
        signal: sigOf(),
      }),
    ).rejects.toThrow('start sink offline');

    // The key never reached acceptance, so it may execute now — and the
    // jump event is sent with its textual fields omitted: the machine's
    // placeholder stays unsubstituted, never invented.
    const receipt = await runtime.apply!({
      actionId: 'jump:implement',
      key: 'first',
      signal: sigOf(),
    });
    expect(receipt.disposition).toBe('executed');
    expect(playerPrompts).toEqual(['Implement this task: <task>']);
    // slc/link.md §Playbook trace: every apply finish adds the receipt
    // disposition and carries no start-only field. Assert over *every*
    // finish in the trace — the best-effort one the start-sink rejection
    // emits included, which a disposition-filtered assertion never sees.
    const pairs = applyTraces(telemetryEvents);
    const finishes = pairs.filter((event) => event.type === 'apply.finished');
    for (const finish of finishes) {
      const payload = finish.payload as Record<string, unknown>;
      expect(payload.actionId).toBe('jump:implement');
      expect(payload.key).toBe('first');
      expect(typeof payload.disposition).toBe('string');
      expect(payload).not.toHaveProperty('stateId');
    }
    expect(
      finishes.map(
        (event) => (event.payload as { disposition?: string }).disposition,
      ),
    ).toEqual(['rejected', 'executed']);
    // The rejected-before-any-effect finish names why the call ended and
    // keeps the transport failure as its diagnostic.
    expect(finishes[0].payload).toMatchObject({
      disposition: 'rejected',
      reason: 'apply.started trace sink rejected',
      status: 'error',
      error: { message: 'start sink offline' },
    });
    // `stateId` is start-only, not merely absent everywhere.
    expect(
      pairs
        .filter((event) => event.type === 'apply.started')
        .map((event) => (event.payload as { stateId?: string }).stateId),
    ).toEqual(['ready', 'ready']);
    await runtime.dispose();
  });

  it('records no receipt for a rejected key, which executes once the action is advertised', async () => {
    let playerCalls = 0;
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async () => '{"guard":"implemented","summary":"recovered"}',
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));

    // At fresh `ready` no retry is advertised: the call settles `rejected`
    // before acceptance, traces its own pair, and records nothing under
    // the key.
    const rejected = await runtime.apply!({
      actionId: 'retry:START',
      key: 'retry-later',
      signal: sigOf(),
    });
    expect(rejected).toEqual({
      disposition: 'rejected',
      reason: 'action "retry:START" is not currently advertised',
    });
    expect(playerCalls).toBe(0);

    // Drive the run into `failed`, so the retry becomes advertisable.
    await runtime.handleBossInput(turn('build the widget'));
    expect(
      runtime.describe!().actions.some(({ id }) => id === 'retry:START'),
    ).toBe(true);

    // The rejection was not final for its key: the same key revalidates
    // afresh and executes exactly once, tracing its own second pair.
    const executed = await runtime.apply!({
      actionId: 'retry:START',
      key: 'retry-later',
      signal: sigOf(),
    });
    expect(executed.disposition).toBe('executed');
    expect(playerCalls).toBe(2);

    // The executed receipt is recorded and final: a replay returns it
    // verbatim with no further execution and no new pair.
    const pairsBefore = applyTraces(telemetry).length;
    const replayed = await runtime.apply!({
      actionId: 'retry:START',
      key: 'retry-later',
      signal: sigOf(),
    });
    expect(replayed).toEqual(executed);
    expect(playerCalls).toBe(2);
    const pairs = applyTraces(telemetry);
    expect(pairs).toHaveLength(pairsBefore);
    expect(
      pairs
        .filter((event) => event.type === 'apply.finished')
        .map(
          (event) =>
            (event.payload as { disposition?: string }).disposition,
        ),
    ).toEqual(['rejected', 'executed']);
    expect(new Set(pairs.map(({ callId }) => callId)).size).toBe(2);
    await runtime.dispose();
  });

  // A rejecting `apply.finished` sink is the one settlement failure that lands
  // *after* the disposition is already on the wire. Rewriting the receipt there
  // cannot make the trace and the return agree — the trace is gone — and it
  // makes the runtime tell its only caller that work which succeeded failed,
  // irrecoverably, since an accepted receipt is final for its key. The receipt
  // stands; the delivery failure travels on the emission channel and surfaces
  // from the next public boundary that drains it.
  it('keeps the published receipt when the finish sink rejects and latches the delivery failure', async () => {
    let playerCalls = 0;
    let failFinishSink = false;
    const telemetryEvents: RecordedTelemetry[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async () => '{"guard":"implemented","summary":"recovered"}',
      emitTelemetry: async (event) => {
        telemetryEvents.push({ topic: event.topic, payload: event.payload });
        const trace = event.payload as { type?: string };
        if (
          event.topic === 'playbook.trace' &&
          trace.type === 'apply.finished' &&
          failFinishSink
        ) {
          failFinishSink = false;
          throw new Error('finish sink offline');
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('build the widget'));

    failFinishSink = true;
    // Past acceptance the boundary owes a receipt and does not throw: the
    // action ran, and the caller is told so.
    const settled = await runtime.apply!({
      actionId: 'retry:START',
      key: 'crash',
      signal: sigOf(),
    });
    expect(settled.disposition).toBe('executed');
    expect(playerCalls).toBe(2);

    // The emitted disposition and the returned one are the same value — the
    // agreement PBRT-52 requires, held by construction rather than by a
    // retroactive rewrite the emitted trace could not follow.
    expect(
      applyTraces(telemetryEvents)
        .filter((event) => event.type === 'apply.finished')
        .map(
          (event) => (event.payload as { disposition?: string }).disposition,
        )
        .at(-1),
    ).toBe('executed');

    // The key is settled and final: the replayed key returns exactly the
    // settlement the caller saw, with no re-execution and no new trace pair.
    const beforeReplay = applyTraces(telemetryEvents).length;
    const replayed = await runtime.apply!({
      actionId: 'retry:START',
      key: 'crash',
      signal: sigOf(),
    });
    expect(replayed).toEqual(settled);
    expect(playerCalls).toBe(2);
    expect(applyTraces(telemetryEvents)).toHaveLength(beforeReplay);

    // The delivery failure is not swallowed either: it rides the engine's
    // standing emission-failure latch — the same channel every background
    // emission failure travels — and surfaces from the next public boundary
    // that drains it. Probed with an empty turn, which reaches the settlement
    // drain without opening a nested call boundary of its own.
    await expect(runtime.handleBossInput(turn(''))).rejects.toThrow(
      'finish sink offline',
    );
    await runtime.dispose();
  });

  // The harder half: the action runs to a clean settlement and the
  // *settlement drain* is what rejects. Before, that escaped the boundary as
  // a bare throw over a receipt that said `executed`, leaving the shell with
  // a journalled action and no outcome and a fresh key that re-runs
  // completed work on the next Boss turn. The failure now settles the
  // receipt, and the pair reports the same disposition the caller got.
  it('settles failed and traces it when the drain rejects after a clean run', async () => {
    let playerCalls = 0;
    let failTerminalTelemetry = false;
    const telemetryEvents: RecordedTelemetry[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async () => '{"guard":"implemented","summary":"recovered"}',
      emitTelemetry: async (event) => {
        telemetryEvents.push({ topic: event.topic, payload: event.payload });
        // Reject the last state telemetry of an otherwise clean run, so the
        // failure is latched for the settlement drain rather than routed
        // back into the actor.
        if (
          failTerminalTelemetry &&
          event.topic === 'playbook.fsm.state' &&
          (event.payload as { to?: unknown }).to === 'done'
        ) {
          throw new Error('telemetry sink rejected');
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('build the widget'));

    failTerminalTelemetry = true;
    const settled = await runtime.apply!({
      actionId: 'retry:START',
      key: 'drain-crash',
      signal: sigOf(),
    });
    expect(settled.disposition).toBe('failed');
    expect(
      settled.disposition === 'failed' ? settled.error.message : undefined,
    ).toBe('telemetry sink rejected');
    // The run really did execute — this is the `failed`-after-effects
    // disposition, not a rejection.
    expect(playerCalls).toBe(2);
    expect(
      applyTraces(telemetryEvents)
        .filter((event) => event.type === 'apply.finished')
        .map(
          (event) => (event.payload as { disposition?: string }).disposition,
        ),
    ).toEqual(['failed']);

    failTerminalTelemetry = false;
    const replayed = await runtime.apply!({
      actionId: 'retry:START',
      key: 'drain-crash',
      signal: sigOf(),
    });
    expect(replayed).toEqual(settled);
    expect(playerCalls).toBe(2);
    await runtime.dispose();
  });

  it('settles a failed receipt when the boundary aborts mid-execution and drains cleanly', async () => {
    let playerCalls = 0;
    const applyPlayerStarted = deferredValue<void>();
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async (_playerId, _prompt, signal) => {
        playerCalls += 1;
        if (playerCalls === 1) {
          return { status: 'error', error: 'agent crashed' };
        }
        applyPlayerStarted.resolve();
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('build the widget'));

    const controller = new AbortController();
    const applying = runtime.apply!({
      actionId: 'retry:START',
      key: 'aborted-apply',
      signal: controller.signal,
    });
    await applyPlayerStarted.promise;
    // apply shares the single active-boundary sentinel.
    expect(() => runtime.describe!()).toThrow(
      /another runtime turn is active/,
    );
    controller.abort(new Error('boss cancelled'));

    // Post-acceptance abort settles the receipt rather than rejecting.
    const receipt = await applying;
    expect(receipt.disposition).toBe('failed');
    expect(
      receipt.disposition === 'failed' ? receipt.error.message : undefined,
    ).toBe('boss cancelled');

    // The boundary drained cleanly: describe works again, the abort receipt
    // is replayable under its key, and no new pair is emitted for it.
    const pairCount = applyTraces(telemetry).length;
    expect(runtime.describe!().state.stateId).toBe('failed');
    const replayed = await runtime.apply!({
      actionId: 'retry:START',
      key: 'aborted-apply',
      signal: sigOf(),
    });
    expect(replayed).toEqual(receipt);
    expect(playerCalls).toBe(2);
    expect(applyTraces(telemetry)).toHaveLength(pairCount);
    await runtime.dispose();
  });

  it('settles pre-acceptance when abort lands during the apply.started emission: no effect, no receipt', async () => {
    // The pre-acceptance signal check runs before the started emission; an
    // abort that fires while that emission drains must still settle before
    // acceptance — the machine unmoved, no host call, no receipt recorded,
    // the pair finished `aborted`, and the key free to execute later.
    const controller = new AbortController();
    let playerCalls = 0;
    const traces: PlaybookTraceEvent[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async () => '{"guard":"implemented","summary":"recovered"}',
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as PlaybookTraceEvent;
        traces.push(trace);
        if (trace.type === 'apply.started') {
          controller.abort(new Error('stop inside the started emission'));
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const failedRun = await runtime.handleBossInput(turn('build the widget'));
    expect(failedRun.outcome).toBe('failed');
    const machineBefore = runtime.exportSnapshot!()!.machine;

    await expect(
      runtime.apply!({
        actionId: 'retry:START',
        key: 'window-abort',
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop inside the started emission');

    expect(playerCalls).toBe(1);
    expect(runtime.describe!().state.stateId).toBe('failed');
    expect(runtime.exportSnapshot!()!.machine).toEqual(machineBefore);
    const pair = traces.filter(
      ({ type }) => type === 'apply.started' || type === 'apply.finished',
    );
    expect(pair.map(({ type, callId }) => ({ type, callId }))).toEqual([
      { type: 'apply.started', callId: 'apply-1' },
      { type: 'apply.finished', callId: 'apply-1' },
    ]);
    // slc/link.md §Playbook trace: every apply finish adds the canonical
    // receipt disposition — for a pre-acceptance abort that is `rejected`
    // (before any effect) with its reason, alongside the abort marker.
    expect(pair[1].payload).toMatchObject({
      actionId: 'retry:START',
      key: 'window-abort',
      status: 'aborted',
      error: { message: 'stop inside the started emission' },
      disposition: 'rejected',
      reason: 'aborted before acceptance',
    });
    // The start carries the state identity; the finish never does.
    expect((pair[0].payload as { stateId?: string }).stateId).toBe('failed');
    expect(pair[1].payload).not.toHaveProperty('stateId');
    // No receipt was recorded, so the same key executes once the abort is
    // gone.
    const receipt = await runtime.apply!({
      actionId: 'retry:START',
      key: 'window-abort',
      signal: sigOf(),
    });
    expect(receipt.disposition).toBe('executed');
    expect(playerCalls).toBe(2);
    // Every apply finish of the session — the aborted one and the executed
    // one — is canonical: disposition present, start-only fields absent.
    const finishes = traces.filter(({ type }) => type === 'apply.finished');
    expect(
      finishes.map(
        ({ payload }) => (payload as { disposition?: string }).disposition,
      ),
    ).toEqual(['rejected', 'executed']);
    for (const finish of finishes) {
      expect(finish.payload).not.toHaveProperty('stateId');
    }
    await runtime.dispose();
  });

  it('surfaces a finish-sink rejection over the pre-acceptance abort like the other public boundaries', async () => {
    // The abort lands while the apply.started emission drains, and the sink
    // then rejects the abort finish itself. Like the settlement drain of
    // handleBossInput/resumePlaybookCall, the latched sink failure outranks
    // the abort at the public boundary: apply rejects with the sink error,
    // still settling pre-acceptance — no execution, no receipt, the key
    // free to execute later.
    const controller = new AbortController();
    let playerCalls = 0;
    let failFinishSink = true;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async () => '{"guard":"implemented","summary":"recovered"}',
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as PlaybookTraceEvent;
        if (trace.type === 'apply.started') {
          controller.abort(new Error('stop inside the started emission'));
        }
        if (trace.type === 'apply.finished' && failFinishSink) {
          failFinishSink = false;
          throw new Error('finish sink offline');
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const failedRun = await runtime.handleBossInput(turn('build the widget'));
    expect(failedRun.outcome).toBe('failed');

    await expect(
      runtime.apply!({
        actionId: 'retry:START',
        key: 'window-abort-sink',
        signal: controller.signal,
      }),
    ).rejects.toThrow('finish sink offline');

    // Still pre-acceptance: no execution, no receipt, the machine unmoved,
    // and the boundary drained cleanly for the next call.
    expect(playerCalls).toBe(1);
    expect(runtime.describe!().state.stateId).toBe('failed');
    const receipt = await runtime.apply!({
      actionId: 'retry:START',
      key: 'window-abort-sink',
      signal: sigOf(),
    });
    expect(receipt.disposition).toBe('executed');
    expect(playerCalls).toBe(2);
    await runtime.dispose();
  });

  it('drives the real CODE runtime: ControlView at failed, receipt discrimination, and idempotent replay', async () => {
    const playerScript: PlayerResult[] = [
      { status: 'error', error: 'coder is down' },
      { status: 'error', error: 'coder is down again' },
      { status: 'ok', finalText: 'I need to ask the Boss something.' },
    ];
    const playerCalls: { playerId: string; prompt: string }[] = [];
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async (playerId, prompt) => {
        const next = playerScript.shift();
        if (!next) throw new Error('unexpected player call');
        playerCalls.push({ playerId, prompt });
        return next;
      },
      callJudge: async () =>
        '{"guard":"needsBossReply","question":"Which repo should I touch?"}',
    });
    const runtime = createCodePlaybookRuntime({});
    await runtime.init(makeSession(ports));

    const failedRun = await runtime.handleBossInput(turn('add a button'));
    expect(failedRun.outcome).toBe('failed');
    expect(playerCalls).toHaveLength(1);

    // ControlView on the real machine: failed leaf, normalized lastError,
    // the recorded-event retry labeled from the source state description,
    // and exactly the registered resumable targets the live guards accept.
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    // The real artifact publishes the meaning of the state it is in, from the
    // same source description its action labels are written from. This is the
    // grounding a controller host speaks a status answer from, in place of the
    // state id it used to be handed.
    expect(view.stateDescription).toBe(
      'The coding workflow failed and is waiting for a new coding intent.',
    );
    expect(view.lastError).toMatchObject({
      name: 'Error',
      message: 'coder is down',
    });
    expect(view.actions[0]).toEqual({
      id: 'retry:START_CODE',
      label:
        'Retry: Coder is implementing one direct phase or committing a new ' +
        'intent record.',
    });
    expect(view.actions.map(({ id }) => id)).toEqual([
      'retry:START_CODE',
    ]);
    // PBRT-52: CODE exposes only its declared phase. The initial player
    // failed before selecting one, so the projection is empty rather than
    // leaking caller or player-authored context.
    expect(view.context).toBeUndefined();

    // A29-17 leg (c): a scripted player error mid-action settles `failed`
    // with the normalized error while its effects stay visible in traces.
    const failedReceipt = await runtime.apply!({
      actionId: 'retry:START_CODE',
      key: 'code-k1',
      signal: sigOf(),
    });
    expect(failedReceipt.disposition).toBe('failed');
    expect(
      failedReceipt.disposition === 'failed'
        ? failedReceipt.error.message
        : undefined,
    ).toBe('coder is down again');
    expect(playerCalls).toHaveLength(2);

    // A29-17 leg (a): the advertised retry from failed settles `executed`
    // with the run result.
    const executedReceipt = await runtime.apply!({
      actionId: 'retry:START_CODE',
      key: 'code-k2',
      signal: sigOf(),
    });
    expect(executedReceipt.disposition).toBe('executed');
    expect(
      executedReceipt.disposition === 'executed'
        ? executedReceipt.run
        : undefined,
    ).toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply' },
    });
    expect(playerCalls).toHaveLength(3);

    // The executed action parked the real machine on its pending Boss
    // question, surfaced with its stable id; no retry outside failed.
    const parkedView = runtime.describe!();
    expect(parkedView.pendingQuestions).toEqual([
      {
        questionId: 'runFirstPhase',
        asker: { kind: 'role', roleId: 'coder' },
        question: 'Which repo should I touch?',
        sourceItem: 'CODE-1',
      },
    ]);
    expect(
      parkedView.actions.some(({ id }) => id.startsWith('retry:')),
    ).toBe(false);

    // A29-17 leg (b): the same actionId re-applied after the state moved on
    // settles `rejected` before any effect — snapshot unchanged, zero
    // player calls.
    const machineBefore = runtime.exportSnapshot!()!.machine;
    const rejectedReceipt = await runtime.apply!({
      actionId: 'retry:START_CODE',
      key: 'code-k3',
      signal: sigOf(),
    });
    expect(rejectedReceipt).toEqual({
      disposition: 'rejected',
      reason: 'action "retry:START_CODE" is not currently advertised',
    });
    expect(runtime.exportSnapshot!()!.machine).toEqual(machineBefore);
    expect(playerCalls).toHaveLength(3);

    // A29-17 leg (d): the repeated idempotency key returns the recorded
    // receipt with exactly one execution in total and no new trace pair.
    const pairsBeforeReplay = applyTraces(telemetry);
    const replayed = await runtime.apply!({
      actionId: 'retry:START_CODE',
      key: 'code-k2',
      signal: sigOf(),
    });
    expect(replayed).toEqual(executedReceipt);
    expect(playerCalls).toHaveLength(3);

    const pairs = applyTraces(telemetry);
    expect(pairs).toHaveLength(pairsBeforeReplay.length);
    expect(pairs.map(({ type }) => type)).toEqual([
      'apply.started',
      'apply.finished',
      'apply.started',
      'apply.finished',
      'apply.started',
      'apply.finished',
    ]);
    expect(pairs.map(({ callId }) => callId)).toEqual([
      'apply-1',
      'apply-1',
      'apply-2',
      'apply-2',
      'apply-3',
      'apply-3',
    ]);
    expect(pairs[0].payload).toMatchObject({
      actionId: 'retry:START_CODE',
      key: 'code-k1',
      stateId: 'failed',
    });
    expect(pairs[1].payload).toMatchObject({
      disposition: 'failed',
      error: { message: 'coder is down again' },
    });
    expect(pairs[3].payload).toMatchObject({ disposition: 'executed' });
    expect(pairs[4].payload).toMatchObject({ stateId: 'awaitBossReply' });
    expect(pairs[5].payload).toMatchObject({
      disposition: 'rejected',
      reason: 'action "retry:START_CODE" is not currently advertised',
    });
    // The player call executed by apply-1 traces inside that boundary.
    const applyTurnIds = new Set(
      pairs
        .map(({ turnId }) => turnId)
        .filter((turnId): turnId is number => turnId !== undefined),
    );
    const playerStarts = playbookTraces(telemetry).filter(
      (event) => event.type === 'player.call.started',
    );
    expect(
      playerStarts.filter(
        ({ turnId }) => turnId !== undefined && applyTurnIds.has(turnId),
      ),
    ).toHaveLength(2);
    await runtime.dispose();
  });

  it('labels a guarded BOSS_INTERRUPT retry from its recorded targetId', async () => {
    const interruptMachine = createMachine({
      id: 'interrupt-retry',
      context: { lastError: undefined as unknown },
      initial: 'ready',
      on: {
        BOSS_INTERRUPT: [
          {
            guard: ({ event }) =>
              (event as { targetId?: string }).targetId === 'firstRoute',
            target: '#firstRoute',
          },
          {
            guard: ({ event }) =>
              (event as { targetId?: string }).targetId === 'secondRoute',
            target: '#secondRoute',
          },
        ],
      },
      states: {
        ready: {
          meta: meta('ready'),
          tags: ['playbook.parked'],
        },
        firstRoute: {
          id: 'firstRoute',
          meta: meta('firstRoute'),
          tags: ['playbook.parked'],
        },
        secondRoute: {
          id: 'secondRoute',
          meta: roleMeta('secondRoute', 'coder'),
          tags: ['playbook.busy'],
          invoke: {
            src: 'player',
            input: () => ({
              stateId: 'secondRoute',
              sourceItem: 'INTERRUPT-2',
              role: 'coder',
              prompt: 'Run the second route.',
              result: { done: 'The second route completed.' },
            }),
            onDone: '#firstRoute',
            onError: {
              target: '#interruptFailed',
              actions: assign({
                lastError: ({ event }) => event.error,
              }),
            },
          },
        },
        failed: {
          id: 'interruptFailed',
          meta: meta('failed'),
          tags: ['playbook.parked'],
        },
      },
    });
    const createInterruptRuntime = createXStatePlaybookRuntime(
      interruptMachine,
      {
        label: 'interrupt-retry',
        compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: () => ({}),
        roleStates: {
          secondRoute: { role: 'coder', label: 'secondRoute state' },
        },
      },
    );
    const { ports } = makeRecordingPorts({
      callPlayer: async () => ({
        status: 'error',
        error: 'second route failed',
      }),
      callJudge: async () =>
        '{"type":"BOSS_INTERRUPT","targetId":"secondRoute"}',
    });
    const runtime = createInterruptRuntime({});
    await runtime.init(makeSession(ports));

    const failed = await runtime.handleBossInput(turn('take the second route'));
    expect(failed.outcome).toBe('failed');
    expect(runtime.describe!().actions).toContainEqual({
      id: 'retry:BOSS_INTERRUPT',
      label: 'Retry: secondRoute state',
    });
    expect(runtime.describe!().actions).not.toContainEqual({
      id: 'retry:BOSS_INTERRUPT',
      label: 'Retry: firstRoute state',
    });
    await runtime.dispose();
  });

  it('rejects the parallel DECIDE machine at factory construction', () => {
    expect(() =>
      createXStatePlaybookRuntime(decideMachine, {
        label: 'decide-control',
        compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: (value) =>
          (value ?? {}) as Record<string, never>,
        entryEvent: { type: 'START_DECIDE', textField: 'callerTopic' },
        controlContextFields: ['callerTopic'],
      }),
    ).toThrow(
      'decide-control uses a parallel state; the shared runtime supports only single-region FSMs',
    );
  });

  it('rejects a non-parallel compound machine at factory construction', () => {
    // PBRT-52: a compound child used to be accepted and then silently
    // misbehave on every state-keyed gate; the factory now enforces its own
    // flat domain up front, like the parallel rejection beside it.
    const compoundMachine = createMachine({
      id: 'compounded',
      initial: 'outer',
      states: {
        outer: {
          meta: meta('outer'),
          initial: 'inner',
          states: { inner: { meta: meta('inner') } },
        },
      },
    });
    expect(() =>
      createXStatePlaybookRuntime(compoundMachine, {
        label: 'compound-control',
        compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: (value) => (value ?? {}) as Record<string, never>,
        entryEvent: { type: 'START', textField: 'task' },
        roleStates: {},
      }),
    ).toThrow(
      'compound-control declares a compound state; the shared runtime supports only flat single-region FSMs',
    );
  });

  it('rejects a flat machine whose meta.playbook.stateId differs from its state key', () => {
    const splitIdentityMachine = createMachine({
      id: 'split',
      initial: 'pause',
      states: {
        pause: {
          meta: meta('awaitBossReply'),
          tags: ['playbook.parked'],
        },
      },
    });
    expect(() =>
      createXStatePlaybookRuntime(splitIdentityMachine, {
        label: 'split-control',
        compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: (value) => (value ?? {}) as Record<string, never>,
        entryEvent: { type: 'START', textField: 'task' },
        roleStates: {},
      }),
    ).toThrow(
      'split-control state pause declares meta.playbook.stateId awaitBossReply; the shared runtime requires the playbook state id to equal the state key',
    );
  });

  it('rejects a flat machine whose state declares no meta.playbook.stateId', () => {
    // PBRT-52: every snapshot identity derives from `meta.playbook.stateId`,
    // so a state without one is identity-dead — its first entry would fail
    // the exactly-one-state-id inspection. The factory rejects it up front
    // beside the split-identity shape.
    const missingIdentityMachine = createMachine({
      id: 'missing',
      initial: 'ready',
      states: {
        ready: { tags: ['playbook.parked'] },
      },
    });
    expect(() =>
      createXStatePlaybookRuntime(missingIdentityMachine, {
        label: 'missing-control',
        compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: (value) => (value ?? {}) as Record<string, never>,
        entryEvent: { type: 'START', textField: 'task' },
        roleStates: {},
      }),
    ).toThrow(
      'missing-control state ready declares no string meta.playbook.stateId; the shared runtime derives every playbook state identity from it',
    );
  });
});

// Round-7 finding 4, producer half. PBRT-52 already required every action
// label to be "written from the source state descriptions"; both derivation
// families quietly fell back to an identifier when no description existed —
// the jump to its own target id, the retry to the target id and then to the
// FSM event type. That defeats the substitution the label exists for: the
// controller host names an executed or refused action by its label precisely
// so no identifier is spoken (CAPTAIN-34), so a label that *is* an identifier
// makes the substitution a no-op.
describe('action labels never fall back to an identifier (PBRT-52)', () => {
  it('does not advertise a jump whose target publishes no description', async () => {
    const jumpMachine = createMachine({
      id: 'jm',
      initial: 'ready',
      on: {
        BOSS_INTERRUPT: [
          {
            guard: ({ event }) =>
              (event as { targetId?: string }).targetId === 'described',
            target: '#described',
          },
          {
            guard: ({ event }) =>
              (event as { targetId?: string }).targetId === 'undescribed',
            target: '#undescribed',
          },
        ],
      },
      states: {
        ready: { meta: meta('ready') },
        awaitBossReply: {
          meta: meta('awaitBossReply'),
          on: {
            BOSS_REPLY: [{ target: '#described' }, { target: '#undescribed' }],
          },
        },
        described: { id: 'described', meta: meta('described') },
        // A resumable target whose source declares no description at all —
        // identity is still mandatory (PBRT-52's flat-domain guard).
        undescribed: {
          id: 'undescribed',
          meta: { playbook: { stateId: 'undescribed' } },
        },
      },
    });
    const createJump = createXStatePlaybookRuntime(jumpMachine, {
      label: 'jump',
      compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
      snapshotOptions: () => ({}),
      roleStates: {},
    });
    const { ports } = makeRecordingPorts();
    const runtime = createJump({});
    await runtime.init(makeSession(ports));

    // Both targets are registered resumable states and the live snapshot
    // accepts both jump events; only the described one is advertised.
    expect(resumableStateIdsFromMachine(jumpMachine)).toEqual(
      new Set(['described', 'undescribed']),
    );
    const view = runtime.describe!();
    expect(view.actions).toEqual([
      { id: 'jump:described', label: 'Resume from: described state' },
    ]);
    await runtime.dispose();
  });

  it('labels a retry from its source description rather than the target id', async () => {
    const retryMachine = createMachine({
      id: 'rm',
      initial: 'ready',
      states: {
        ready: { meta: meta('ready'), on: { START: 'failed' } },
        failed: {
          meta: meta('failed'),
          tags: ['playbook.parked'],
          on: { START: 'plain' },
        },
        // The state the retry re-enters publishes no description, so the
        // only names available for it are its own id and the replayed event
        // type — identity itself stays mandatory (PBRT-52).
        plain: { meta: { playbook: { stateId: 'plain' } } },
      },
    });
    const createRetry = createXStatePlaybookRuntime(retryMachine, {
      label: 'retry',
      compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
      snapshotOptions: () => ({}),
      roleStates: {},
      entryEvent: { type: 'START', textField: 'task' },
    });
    const { ports } = makeRecordingPorts();
    const runtime = createRetry({});
    await runtime.init(makeSession(ports));
    await runtime.handleBossInput(turn('do the thing'));

    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(view.actions).toEqual([
      { id: 'retry:START', label: 'Retry: failed state' },
    ]);
    expect(view.actions[0]!.label).not.toContain('plain');
    expect(view.actions[0]!.label).not.toContain('START');
    await runtime.dispose();
  });
});
