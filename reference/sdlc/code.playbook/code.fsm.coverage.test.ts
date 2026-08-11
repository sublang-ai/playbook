// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  codingMachine,
  type CodingContext,
  type JsonValue,
  type PlaybookInput,
  type PlayerInput,
  type PlayerOutput,
} from './code.fsm.js';

interface RawInvoke {
  onDone?: RawTransition | readonly RawTransition[];
  onError?: RawTransition | readonly RawTransition[];
}

interface RawState {
  invoke?: RawInvoke;
  on?: Record<string, RawTransition | readonly RawTransition[]>;
  states?: Record<string, RawState>;
}

interface RawTransition {
  guard?: unknown;
  target?: unknown;
}

interface TransitionFixture {
  guard: string;
  target: string;
  context: CodingContext;
  event: unknown;
}

const APPROVED = {
  approvedCommit: 'latest',
  noUnsettledFindings: true,
} as const;

const CONTEXT: CodingContext = {
  coderPlayer: 'GPT-5.6 Sol',
  runResults: '',
  callerInput: 'Implement the request.',
  coderOutput: 'Completed the phase.\nCommit: abc123',
  latestCommit: 'abc123',
  irNumber: '040',
  irTask: 'Implement task 1.',
};

const done = (output: unknown) => ({
  type: 'xstate.done.actor.worker',
  output,
});

const authoredFailure = Object.assign(new Error('REVIEW aborted.'), {
  result: { status: 'aborted', playbookId: 'review' },
});

const pendingContext = (
  stateId: 'runFirstPhase' | 'runIrTask',
  sourceItem: 'CODE-1' | 'CODE-3',
): CodingContext => ({
  ...CONTEXT,
  pendingBossQuestion: {
    questionId: stateId,
    resumeStateId: stateId,
    sourceItem,
    player: 'Coder',
    question: 'Which branch?',
  },
});

const transitionFixtures: Record<string, readonly TransitionFixture[]> = {
  'runFirstPhase.invoke.onDone': [
    {
      guard: 'isDirectCommit',
      target: 'reviewFirstCommit',
      context: CONTEXT,
      event: done({
        guard: 'directCommit',
        coderOutput: 'Completed the phase.\nCommit: abc123',
        latestCommit: 'abc123',
      }),
    },
    {
      guard: 'isIrCommit',
      target: 'reviewFirstCommit',
      context: CONTEXT,
      event: done({
        guard: 'irCommit',
        coderOutput: 'Created IR-040.\nCommit: ir040',
        latestCommit: 'ir040',
        irNumber: '040',
        irTask: 'Implement task 1.',
      }),
    },
    {
      guard: 'needsBossReply',
      target: 'awaitBossReply',
      context: CONTEXT,
      event: done({ guard: 'needsBossReply', question: 'Which branch?' }),
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: done({
        guard: 'directCommit',
        coderOutput: 'Commit: previous\nCommit: abc123',
        latestCommit: 'abc123',
      }),
    },
  ],
  'reviewFirstCommit.invoke.onDone': [
    {
      guard: 'reviewApprovedDirect',
      target: 'done',
      context: { ...CONTEXT, phase: 'direct' },
      event: done(APPROVED),
    },
    {
      guard: 'reviewApprovedIrCreated',
      target: 'runIrTask',
      context: { ...CONTEXT, phase: 'ir-created' },
      event: done(APPROVED),
    },
    {
      guard: '<fallback>',
      target: 'done',
      context: { ...CONTEXT, phase: 'direct' },
      event: done({ approvedCommit: 'previous', noUnsettledFindings: true }),
    },
  ],
  'reviewFirstCommit.invoke.onError': [
    {
      guard: 'authoredReviewFailure',
      target: 'done',
      context: CONTEXT,
      event: { type: 'xstate.error.actor.review', error: authoredFailure },
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: {
        type: 'xstate.error.actor.review',
        error: new Error('control-plane failure'),
      },
    },
  ],
  'runIrTask.invoke.onDone': [
    {
      guard: 'isMoreTasks',
      target: 'reviewIrTask',
      context: CONTEXT,
      event: done({
        guard: 'moreTasks',
        coderOutput: 'Completed task 1.\nCommit: task1',
        latestCommit: 'task1',
        irTask: 'Implement task 2.',
      }),
    },
    {
      guard: 'isFinalTask',
      target: 'reviewIrTask',
      context: CONTEXT,
      event: done({
        guard: 'finalTask',
        coderOutput: 'Completed the final task.\nCommit: task2',
        latestCommit: 'task2',
      }),
    },
    {
      guard: 'needsBossReply',
      target: 'awaitBossReply',
      context: CONTEXT,
      event: done({ guard: 'needsBossReply', question: 'Which branch?' }),
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: done({
        guard: 'finalTask',
        coderOutput: 'Completed the final task.',
        latestCommit: 'task2',
      }),
    },
  ],
  'reviewIrTask.invoke.onDone': [
    {
      guard: 'reviewApprovedMoreTasks',
      target: 'runIrTask',
      context: { ...CONTEXT, phase: 'ir-task-more' },
      event: done(APPROVED),
    },
    {
      guard: 'reviewApprovedFinalTask',
      target: 'done',
      context: { ...CONTEXT, phase: 'ir-task-final' },
      event: done(APPROVED),
    },
    {
      guard: '<fallback>',
      target: 'done',
      context: { ...CONTEXT, phase: 'ir-task-final' },
      event: done({ approvedCommit: 'latest', noUnsettledFindings: false }),
    },
  ],
  'reviewIrTask.invoke.onError': [
    {
      guard: 'authoredReviewFailure',
      target: 'done',
      context: CONTEXT,
      event: { type: 'xstate.error.actor.review', error: authoredFailure },
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: {
        type: 'xstate.error.actor.review',
        error: new Error('control-plane failure'),
      },
    },
  ],
  'awaitBossReply.on.BOSS_REPLY': [
    {
      guard: 'emptyBossReply',
      target: '#failed',
      context: pendingContext('runFirstPhase', 'CODE-1'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'runFirstPhase',
        answer: '  ',
      },
    },
    {
      guard: 'resumesFirstPhase',
      target: '#runFirstPhase',
      context: pendingContext('runFirstPhase', 'CODE-1'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'runFirstPhase',
        answer: 'Use the narrow branch.',
      },
    },
    {
      guard: 'resumesIrTask',
      target: '#runIrTask',
      context: pendingContext('runIrTask', 'CODE-3'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'runIrTask',
        answer: 'Use the narrow branch.',
      },
    },
  ],
};

function orderedTransitions(
  current: Record<string, RawState>,
  parent = '',
): Map<string, readonly RawTransition[]> {
  const found = new Map<string, readonly RawTransition[]>();
  for (const [key, state] of Object.entries(current)) {
    const path = parent === '' ? key : `${parent}.${key}`;
    if (Array.isArray(state.invoke?.onDone)) {
      found.set(`${path}.invoke.onDone`, state.invoke.onDone);
    }
    if (Array.isArray(state.invoke?.onError)) {
      found.set(`${path}.invoke.onError`, state.invoke.onError);
    }
    for (const [event, transitions] of Object.entries(state.on ?? {})) {
      if (Array.isArray(transitions)) {
        found.set(`${path}.on.${event}`, transitions);
      }
    }
    for (const [nestedPath, transitions] of orderedTransitions(
      state.states ?? {},
      path,
    )) {
      found.set(nestedPath, transitions);
    }
  }
  return found;
}

function guardName(guard: unknown): string | undefined {
  if (typeof guard === 'string') return guard;
  if (!isRecord(guard)) return undefined;
  return typeof guard.type === 'string' ? guard.type : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createWorkflow(
  playerOutputs: readonly PlayerOutput[],
  reviewOutputs: readonly (JsonValue | Error | undefined)[],
) {
  const pendingPlayers = [...playerOutputs];
  const pendingReviews = [...reviewOutputs];
  const playerInputs: PlayerInput[] = [];
  const reviewInputs: PlaybookInput[] = [];
  const machine = codingMachine.provide({
    actors: {
      player: fromPromise<PlayerOutput, PlayerInput>(async ({ input }) => {
        playerInputs.push(input);
        const output = pendingPlayers.shift();
        if (output === undefined) throw new Error('missing player fixture');
        return output;
      }),
      playbook: fromPromise<JsonValue | undefined, PlaybookInput>(
        async ({ input }) => {
          reviewInputs.push(input);
          if (pendingReviews.length === 0) {
            throw new Error('missing REVIEW fixture');
          }
          const output = pendingReviews.shift();
          if (output instanceof Error) throw output;
          return output;
        },
      ),
    },
  });
  const actor = createActor(machine, {
    input: { coderPlayer: 'GPT-5.6 Sol', runResults: '' },
  });
  actor.start();
  return { actor, playerInputs, reviewInputs };
}

describe('CODE FSM transition coverage', () => {
  it('has one load-bearing fixture for every ordered transition arm', () => {
    const states = (codingMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const actual = orderedTransitions(states);
    expect([...actual.keys()]).toEqual(Object.keys(transitionFixtures));

    const guards = codingMachine.implementations.guards as unknown as Record<
      string,
      (
        args: { context: CodingContext; event: unknown },
        params: unknown,
      ) => boolean
    >;
    for (const [location, fixtures] of Object.entries(transitionFixtures)) {
      const arms = actual.get(location) ?? [];
      expect(
        arms.map((arm) => ({ guard: guardName(arm.guard), target: arm.target })),
        location,
      ).toEqual(
        fixtures.map(({ guard, target }) => ({
          guard: guard === '<fallback>' ? undefined : guard,
          target,
        })),
      );

      fixtures.forEach((fixture, index) => {
        const evaluations = arms.slice(0, index + 1).map((arm) => {
          const name = guardName(arm.guard);
          return name === undefined
            ? true
            : guards[name](
                { context: fixture.context, event: fixture.event },
                undefined,
              );
        });
        expect(evaluations, `${location}[${index}]`).toEqual([
          ...Array.from({ length: index }, () => false),
          true,
        ]);
      });
    }
  });

  it('completes one direct phase only after exact REVIEW approval', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed the change.\nCommit: abc123',
          latestCommit: 'abc123',
        },
      ],
      [APPROVED],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Fix the bug.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'complete',
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Committed the change.\nCommit: abc123',
    });
    expect(workflow.reviewInputs[0]?.text).toBe(
      '> Initial intent: Fix the bug.\n' +
        '> Coder output: Committed the change.\n' +
        '> Commit: abc123',
    );
  });

  it('loops one commit per IR task and stops after the final reviewed task', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'irCommit',
          coderOutput: 'Created IR-040.\nCommit: ir040',
          latestCommit: 'ir040',
          irNumber: '040',
          irTask: 'Implement task 1.',
        },
        {
          guard: 'moreTasks',
          coderOutput: 'Completed task 1.\nCommit: task1',
          latestCommit: 'task1',
          irTask: 'Implement task 2.',
        },
        {
          guard: 'finalTask',
          coderOutput: 'Completed task 2.\nCommit: task2',
          latestCommit: 'task2',
        },
      ],
      [APPROVED, APPROVED, APPROVED],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Large change.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'complete',
      lastCodeCommit: 'task2',
      lastCodeOutput: 'Completed task 2.\nCommit: task2',
    });
    expect(workflow.playerInputs.map(({ stateId }) => stateId)).toEqual([
      'runFirstPhase',
      'runIrTask',
      'runIrTask',
    ]);
    expect(workflow.reviewInputs.map(({ stateId }) => stateId)).toEqual([
      'reviewFirstCommit',
      'reviewIrTask',
      'reviewIrTask',
    ]);
    expect(workflow.reviewInputs[2]?.text).toContain(
      '> IR task: Implement task 2.',
    );
  });

  it('parks and resumes the same Coder leaf after a Boss reply', async () => {
    const workflow = createWorkflow(
      [
        { guard: 'needsBossReply', question: 'Which branch?' },
        {
          guard: 'directCommit',
          coderOutput: 'Committed with the answer.\nCommit: def456',
          latestCommit: 'def456',
        },
      ],
      [APPROVED],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Implement it.' });
    await waitFor(workflow.actor, (value) => value.matches('awaitBossReply'));
    workflow.actor.send({
      type: 'BOSS_REPLY',
      questionId: 'runFirstPhase',
      answer: 'Use the narrow branch.',
    });
    await waitFor(workflow.actor, (value) => value.status === 'done');
    expect(workflow.playerInputs[1]?.pendingBossQuestion?.question).toBe(
      'Which branch?',
    );
    expect(workflow.playerInputs[1]?.bossReply).toBe(
      'Use the narrow branch.',
    );
  });

  it('reports a terminal REVIEW result that does not prove approval', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed the change.\nCommit: abc123',
          latestCommit: 'abc123',
        },
      ],
      [{ approvedCommit: 'previous', noUnsettledFindings: true }],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Fix it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Committed the change.\nCommit: abc123',
      error: {
        name: 'ReviewContractError',
        message:
          'REVIEW returned an invalid approval result: ' +
          '{"approvedCommit":"previous","noUnsettledFindings":true}',
      },
    });
  });

  it('reports a terminal authored failure from REVIEW', async () => {
    const authoredFailure = Object.assign(new Error('REVIEW failed.'), {
      result: {
        status: 'error',
        playbookId: 'review',
        error: { name: 'ReviewError', message: 'REVIEW failed.' },
      },
    });
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed the change.\nCommit: abc123',
          latestCommit: 'abc123',
        },
      ],
      [authoredFailure],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Fix it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Committed the change.\nCommit: abc123',
      error: { name: 'ReviewError', message: 'REVIEW failed.' },
    });
  });

  it('parks on an unstructured REVIEW control-plane failure', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed the change.\nCommit: abc123',
          latestCommit: 'abc123',
        },
      ],
      [new Error('REVIEW transport failed.')],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Fix it.' });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(snapshot.context.lastError).toMatchObject({
      message: 'REVIEW transport failed.',
    });
  });
});
