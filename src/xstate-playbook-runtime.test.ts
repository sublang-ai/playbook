// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Unit tests for the generic linked-runtime factory (DR-019): the thin-module
// contract slc/link.md §Output emits — a machine plus a small spec — driven
// end to end over synthetic FSMs that exercise every provided actor kind
// (player, script, captain, nested playbook) and the generic strategy
// defaults (entry event, parked-state classifier, prompt composition,
// adjudication, statuses).

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assign, createActor, createMachine, fromPromise, waitFor } from 'xstate';

import type {
  JsonValue,
  PlaybookPorts,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookSession,
  PlaybookTraceEvent,
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
import { discussMachine } from '../reference/sdlc/discuss.playbook/discuss.fsm.js';

const meta = (stateId: string) => ({
  playbook: { stateId, description: `${stateId} state` },
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

function makeSession(ports: PlaybookPorts): PlaybookSession {
  const sessionId = `factory-test-session-${++sessionSequence}`;
  return {
    sessionId,
    playbookId: 'factory-test',
    rootSessionId: sessionId,
    depth: 0,
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
          player: string;
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
      meta: meta('implement'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'implement',
          player: 'Coder',
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
                player: 'Coder',
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
  snapshotOptions: (value) => {
    const options = (value ?? {}) as WorkflowOptions;
    return options;
  },
  machineInput: (options) =>
    options.command === undefined ? {} : { command: options.command },
  entryEvent: { type: 'START', textField: 'task' },
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
      player: 'Coder',
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
      player: 'Coder',
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
      player: 'Reviewer',
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
          player: 'Committer',
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
});

describe('player + script workflow over the shared factory', () => {
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
    expect(judgePrompts[0]).toContain('The Coder just produced this output:');
    // Default composer substituted the machine-carried field.
    expect(playerPrompts).toEqual(['Implement this task: build the widget']);

    expect(result.outcome).toBe('terminal');
    expect(result.state.stateId).toBe('done');
    expect(
      'output' in result ? result.output : undefined,
    ).toEqual({ summary: 'shipped the task' });

    // Default entry statuses plus the script record.
    expect(statuses.map(({ message }) => message)).toEqual([
      'Entered implement.',
      'Entered verify.',
      'Executed script for verify (exit 0).',
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
        'Entered implement.',
        'Entered verify.',
        'Executed script for verify (exit 1).',
        'Workflow failed; awaiting Boss recovery.',
      ]);
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
    expect(statuses.map(({ message }) => message)).toContain(
      'Coder asks: Which database?',
    );

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

  it('restarts from failed through the classifier and reports an unrecoverable reply as one status', async () => {
    let playerCalls = 0;
    const classifierReplies: string[] = [
      'not json at all',
      '{"type":"START"}',
    ];
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'error', error: 'agent crashed' }
          : { status: 'ok', finalText: 'Recovered.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          return classifierReplies.shift() ?? '{"type":"NO_ACTION"}';
        }
        return '{"guard":"implemented","summary":"recovered"}';
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));

    const failedRun = await runtime.handleBossInput(turn('try the work'));
    expect(failedRun.outcome).toBe('failed');

    const noAction = await runtime.handleBossInput(turn('hmm'));
    expect(noAction.outcome).toBe('no-action');
    expect(statuses.map(({ message }) => message)).toContain(
      'Classifier reply was not recoverable JSON',
    );

    const restarted = await runtime.handleBossInput(turn('try again'));
    expect(restarted.outcome).toBe('terminal');
    await runtime.dispose();
  });

  it('does not send a classified event when abort fires during its finish trace', async () => {
    const controller = new AbortController();
    const abortReason = new Error('stop after classification');
    let playerCalls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'error', error: 'agent unavailable' };
      },
      callJudge: async () => '{"type":"START"}',
      emitTelemetry: async (event) => {
        const trace = event.payload as { type?: string };
        if (
          event.topic === 'playbook.trace' &&
          trace.type === 'judge.call.finished'
        ) {
          controller.abort(abortReason);
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const failed = await runtime.handleBossInput(turn('first try'));
    expect(failed.state.stateId).toBe('failed');

    const aborted = await runtime.handleBossInput({
      text: 'try again',
      signal: controller.signal,
    });
    expect(aborted.outcome).toBe('aborted');
    expect(aborted.state.stateId).toBe('failed');
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
    const traces: PlaybookTraceEvent[] = [];
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'error', error: 'agent unavailable' };
      },
      callJudge: async () => {
        judgeCalls += 1;
        return '{"type":"START"}';
      },
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as PlaybookTraceEvent;
        traces.push(trace);
        if (trace.type === 'judge.call.started') {
          controller.abort(new Error('stop inside the started emission'));
        }
      },
    });
    const runtime = createWorkflowRuntime({});
    await runtime.init(makeSession(ports));
    const failed = await runtime.handleBossInput(turn('first try'));
    expect(failed.state.stateId).toBe('failed');

    const aborted = await runtime.handleBossInput({
      text: 'try again',
      signal: controller.signal,
    });
    expect(aborted.outcome).toBe('aborted');
    expect(aborted.state.stateId).toBe('failed');
    expect(judgeCalls).toBe(0);
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
          player: string;
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
                player: 'Captain',
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
  snapshotOptions: (value) => (value ?? {}) as CaptainOptions,
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
      statuses.find(({ message }) => message.startsWith('Workflow failed;')),
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
      statuses.find(({ message }) => message.startsWith('Workflow failed;')),
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

  it('uses the trace sequence as a collision-safe legacy Captain id floor', async () => {
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
    const legacySnapshot = structuredClone(first.exportSnapshot!());
    delete legacySnapshot.sequences.captainCall;

    const restored = createCaptainRuntime({});
    await restored.restore!(session, legacySnapshot);
    const result = await restored.handleBossInput(turn('Tuesday'));
    expect(result.outcome).toBe('terminal');
    const callIds = telemetry
      .map(({ payload }) => payload as { type?: string; callId?: string })
      .filter((event) => event.type === 'captain.call.started')
      .map(({ callId }) => callId);
    expect(callIds).toEqual([
      'captain-1',
      `captain-${legacySnapshot.sequences.trace + 1}`,
    ]);
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
      statuses.find(({ message }) => message.startsWith('Workflow failed;')),
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
  snapshotOptions: () => ({}),
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
        player: 'Coder',
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

  it('constructs a declaration-free legacy artifact without any check', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, workflowSpec),
    ).not.toThrow();
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
          '@sublang/playbook/xstate-runtime engine supports [1]',
      ),
    );
  });

  it('rejects a mismatched runtime ABI naming both values', () => {
    expect(() =>
      createXStatePlaybookRuntime(workflowMachine, {
        ...workflowSpec,
        compat: { artifactSchema: 1, runtimeAbi: RUNTIME_ABI + 1 },
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
    ).toThrow(/declares schema 99.*supports \[1\]/);
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
          artifactSchema: 1,
          runtimeAbi: 'latest',
        } as unknown as { artifactSchema: number; runtimeAbi: number },
      }),
    ).toThrow(/spec\.compat\.runtimeAbi must be an integer/);
  });
});

// ---------------------------------------------------------------------------
// DR-029 §3 control surface (PBRT-52 / PBRT-53): describe/apply over the
// shared factory — synthetic workflow machines plus the real linked CODE
// runtime and the real DISCUSS FSM at the bare runtime surface, under fake
// ports with scripted per-call results.
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
      meta: meta('implement'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'implement',
          player: 'Coder',
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
    snapshotOptions: (value) => (value ?? {}) as Record<string, never>,
    machineInput: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    // The declared projection names one JSON-safe member and one that is
    // not, so the sanitize row still has something to drop.
    controlContextFields: ['task', 'note', 'probe'],
  },
);

// The real DISCUSS FSM at the bare runtime surface: the shared factory over
// the compiled machine, registering the PBRT-40 category exemplars — a
// resumable-but-not-jumpable branch leaf, two context-conditional jumpable
// targets, and the context-conditional parallel parent.
const createDiscussControlRuntime = createXStatePlaybookRuntime(
  discussMachine,
  {
    label: 'discuss-control',
    snapshotOptions: (value) => (value ?? {}) as Record<string, never>,
    machineInput: () => ({}),
    entryEvent: { type: 'START_DISCUSSION', textField: 'topic' },
    controlContextFields: ['topic'],
    resumableStateIds: new Set([
      'askHostInitial',
      'hostWritesAgreement',
      'commitInitialChanges',
      'initialProposalRound',
    ]),
  },
);

describe('control surface over the shared factory (DR-029 §3 / PBRT-52 / PBRT-53)', () => {
  it('exposes describe and apply together on every factory runtime and detects a pair-less runtime distinctly', () => {
    const factoryRuntimes: PlaybookRuntime[] = [
      createWorkflowRuntime({}),
      createConditionalRuntime({}),
      createCodePlaybookRuntime({}),
      createDiscussControlRuntime({}),
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
        player: 'Coder',
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
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
          return '{"event":"START_CODING","payload":{"intent":"add a button"}}';
        }
        return '{"guard":"needsBossReply","question":"Which repo should I touch?"}';
      },
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
      'Captures the last Captain error so the runner can report it. Boss may resume from here.',
    );
    expect(view.lastError).toMatchObject({
      name: 'Error',
      message: 'coder is down',
    });
    expect(view.actions[0]).toEqual({
      id: 'retry:START_CODING',
      label:
        'Retry: CODE-1: Coder assesses a Boss intent and either implements ' +
        'a single-commit change or drafts an IR.',
    });
    expect(view.actions.map(({ id }) => id)).toEqual([
      'retry:START_CODING',
      'jump:adjudicateChallenges',
      'jump:commitCoderInitial',
      'jump:commitJoint',
      'jump:continueIr',
      // CODE registers `failed` itself among its Boss-reply targets (the
      // empty-reply arm), and its interrupt guard accepts it live.
      'jump:failed',
      'jump:planAndImplement',
      'jump:respondToReview',
      'jump:reviewBossCommitCode',
      'jump:reviewBossCommitMixed',
      'jump:reviewBossCommitSpecs',
      'jump:reviewChangesAndChallengesCode',
      'jump:reviewChangesAndChallengesMixed',
      'jump:reviewChangesAndChallengesSpecs',
      'jump:reviewChangesCode',
      'jump:reviewChangesMixed',
      'jump:reviewChangesSpecs',
      'jump:reviewIrTaskCommitCode',
      'jump:reviewIrTaskCommitMixed',
      'jump:reviewIrTaskCommitSpecs',
      'jump:summarizeSpecs',
    ]);
    expect(
      view.actions.find(({ id }) => id === 'jump:planAndImplement')?.label,
    ).toBe(
      'Resume from: CODE-1: Coder assesses a Boss intent and either ' +
        'implements a single-commit change or drafts an IR.',
    );
    // PBRT-52: the view carries exactly CODE's declared projection. The
    // roster members the shell resolved (`coderPlayer`, `reviewerPlayer`,
    // `committerPlayer`), the option value `intent`, and every
    // player-authored member (`irNumber`, `taskDescription`, `reviews`,
    // `challenges`, `lastResult`) are all live in `CodingContext` here and
    // none of them is exported.
    expect(Object.keys(view.context as Record<string, unknown>)).toEqual([
      'workflow',
      'changeOrigin',
      'afterReview',
    ]);
    expect(view.context).toMatchObject({
      workflow: 'singleCommit',
      changeOrigin: 'bossIntent',
      afterReview: 'done',
    });
    expect(view.context).not.toHaveProperty('lastError');
    expect(view.context).not.toHaveProperty('pendingBossQuestion');

    // A29-17 leg (c): a scripted player error mid-action settles `failed`
    // with the normalized error while its effects stay visible in traces.
    const failedReceipt = await runtime.apply!({
      actionId: 'retry:START_CODING',
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
      actionId: 'retry:START_CODING',
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
        questionId: 'planAndImplement',
        player: 'Coder',
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
      actionId: 'retry:START_CODING',
      key: 'code-k3',
      signal: sigOf(),
    });
    expect(rejectedReceipt).toEqual({
      disposition: 'rejected',
      reason: 'action "retry:START_CODING" is not currently advertised',
    });
    expect(runtime.exportSnapshot!()!.machine).toEqual(machineBefore);
    expect(playerCalls).toHaveLength(3);

    // A29-17 leg (d): the repeated idempotency key returns the recorded
    // receipt with exactly one execution in total and no new trace pair.
    const pairsBeforeReplay = applyTraces(telemetry);
    const replayed = await runtime.apply!({
      actionId: 'retry:START_CODING',
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
      actionId: 'retry:START_CODING',
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
      reason: 'action "retry:START_CODING" is not currently advertised',
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

  it('labels the failure-state retry from the recorded BOSS_INTERRUPT targetId, not the first configured arm', async () => {
    // CODE's root BOSS_INTERRUPT is a guarded multi-arm list whose first
    // configured arm targets `ready`. The replay resumes the recorded
    // event's own targetId, so the label must name that state's
    // description — never the first arm's.
    let playerCalls = 0;
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return { status: 'error', error: 'coder is down' };
      },
      callJudge: async () =>
        '{"event":"BOSS_INTERRUPT","payload":{"targetId":"respondToReview"}}',
    });
    const runtime = createCodePlaybookRuntime({});
    await runtime.init(makeSession(ports));
    const failedRun = await runtime.handleBossInput(
      turn('address the review findings'),
    );
    expect(failedRun.outcome).toBe('failed');
    expect(playerCalls).toBe(1);

    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(view.actions[0]).toEqual({
      id: 'retry:BOSS_INTERRUPT',
      label:
        'Retry: CODE-2: Coder addresses or challenges Reviewer findings.',
    });
    await runtime.dispose();
  });

  it('excludes refused DISCUSS targets at the bare runtime surface and includes them once context allows', async () => {
    // Fresh ready: every registered candidate is excluded — the branch leaf
    // is resumable but not jumpable, and the jumpable targets'
    // context-conditional guards refuse an empty context (PBRT-40).
    const runtime = createDiscussControlRuntime({});
    await runtime.init(makeSession(makeRecordingPorts().ports));
    const fresh = runtime.describe!();
    expect(fresh.state.stateId).toBe('ready');
    expect(fresh.actions).toEqual([]);
    await runtime.dispose();

    // Seed the real machine to `failed` with the round's input in context —
    // outside any runtime, since the shared factory's singular-state
    // telemetry contract does not drive this parallel FSM — and restore the
    // parked capture at the bare runtime surface.
    const seed = createActor(
      discussMachine.provide({
        actors: {
          player: fromPromise(async () => {
            throw 'proposal agent down';
          }),
        } as never,
      }),
      { input: {} },
    );
    seed.start();
    seed.send({
      type: 'START_DISCUSSION',
      topic: 'Should we adopt X or Y?',
    });
    await waitFor(seed, (snapshot) => snapshot.value === 'failed');
    const machineSnapshot = JSON.parse(
      JSON.stringify(seed.getPersistedSnapshot()),
    ) as JsonValue;
    const state = normalizePlaybookSnapshot(seed.getSnapshot());
    seed.stop();

    const restored = createDiscussControlRuntime({});
    const session = makeSession(makeRecordingPorts().ports);
    await restored.restore!(session, {
      schemaVersion: 1,
      playbookId: session.playbookId,
      machine: machineSnapshot,
      playerResumeTokens: {},
      sequences: {
        trace: 0,
        turn: 0,
        judgeCall: 0,
        playerCall: 0,
        playbookCall: 0,
      },
      state,
      pendingBossQuestions: [],
    });

    // The live context now holds the round's required input, so exactly the
    // context-conditional parallel parent flips to included; the other
    // registered candidates stay excluded. No retry appears: the recorded
    // last classified event is process-local and never restores.
    const view = restored.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(view.lastError).toMatchObject({ message: 'proposal agent down' });
    expect(view.context).toMatchObject({ topic: 'Should we adopt X or Y?' });
    expect(view.actions).toEqual([
      {
        id: 'jump:initialProposalRound',
        label:
          'Resume from: Host and Participant independently propose designs.',
      },
    ]);
    await restored.dispose();
  });
});
