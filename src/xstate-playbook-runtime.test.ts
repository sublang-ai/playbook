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
import { assign, createMachine } from 'xstate';

import type {
  PlaybookPorts,
  PlaybookRunResult,
  PlaybookSession,
} from './runtime.js';
import {
  createXStatePlaybookRuntime,
  defaultComposeCaptainPrompt,
  defaultComposePlayerPrompt,
  defaultExtractRequiredFields,
  resumableStateIdsFromMachine,
  type XStatePlaybookRuntimeSpec,
} from './xstate-runtime.js';

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
    const { ports } = makeRecordingPorts({
      callPlayer: async () => {
        playerCalls += 1;
        return playerCalls === 1
          ? { status: 'ok', finalText: 'Need a decision.' }
          : { status: 'ok', finalText: 'Done.' };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Classify the following Boss message')) {
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

  it.each([
    [
      'non-ok result',
      { status: 'error' as const, error: 'captain unavailable' },
      /captain unavailable/,
    ],
    ['missing finalText', { status: 'ok' as const }, /no finalText/],
    ['empty finalText', { status: 'ok' as const, finalText: '' }, /no finalText/],
  ])('rejects a %s as a control-plane failure', async (_label, captainResult, error) => {
    const { ports, telemetry } = makeRecordingPorts({
      callCaptain: async () => captainResult,
    });
    const runtime = createCaptainRuntime({});
    await runtime.init(makeSession(ports));
    await expect(
      runtime.handleBossInput(turn('release timing')),
    ).rejects.toThrow(error);
    const finish = telemetry
      .map(({ payload }) => payload as { type?: string; payload?: unknown })
      .find((event) => event.type === 'captain.call.finished');
    expect(finish?.payload).toMatchObject({
      status: captainResult.status,
      error: { name: 'Error' },
    });
    await runtime.dispose();
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
    await expect(
      runtime.handleBossInput(turn('release timing')),
    ).rejects.toThrow('captain unavailable');
    expect(finishAttempts).toBe(1);
    expect(
      statuses.find(({ message }) =>
        message.startsWith('Workflow failed;'),
      ),
    ).toMatchObject({
      data: { lastError: { message: 'captain unavailable' } },
    });
    await runtime.dispose();
  });

  it('preserves a direct-Captain result failure over a finish-time abort', async () => {
    const controller = new AbortController();
    const { ports } = makeRecordingPorts({
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
    await expect(
      runtime.handleBossInput({
        text: 'release timing',
        signal: controller.signal,
      }),
    ).rejects.toThrow('captain unavailable');
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
});
