// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_OUTCOME_ACTION_TYPE } from '../../../src/accepted-outcome.js';
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
  actions?: unknown;
}

interface TransitionFixture {
  guard: string;
  target: string;
  context: CodingContext;
  event: unknown;
}

const APPROVED = {
  evaluatedRevision: 'rev123',
  noUnsettledFindings: true,
} as const;

// A terminal REVIEW result without the DR-045 evaluated revision does not
// establish the evaluated scope, so CODE must not accept it as approval.
const APPROVED_WITHOUT_REVISION = { noUnsettledFindings: true } as const;
const APPROVED_TASK4 = {
  evaluatedRevision: 'task4rev',
  noUnsettledFindings: true,
} as const;

const CONTEXT: CodingContext = {
  runResults: '',
  callerInput: 'Implement the request.',
  coderOutput: 'Completed the phase.',
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
    asker: { kind: 'role', roleId: 'coder' },
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
        coderOutput: 'Completed the phase.',
        latestCommit: 'abc123',
      }),
    },
    {
      guard: 'isIrCommit',
      target: 'reviewFirstCommit',
      context: CONTEXT,
      event: done({
        guard: 'irCommit',
        coderOutput: 'Created IR-040.',
        latestCommit: 'ir040',
        irNumber: '040',
      }),
    },
    {
      guard: 'isMoreTasks',
      target: 'reviewIrTask',
      context: CONTEXT,
      event: done({
        guard: 'moreTasks',
        coderOutput: 'Continued IR-040 with task 1.',
        latestCommit: 'task1',
        irNumber: '040',
        irTask: 'Implement task 1.',
      }),
    },
    {
      guard: 'isFinalTask',
      target: 'reviewIrTask',
      context: CONTEXT,
      event: done({
        guard: 'finalTask',
        coderOutput: 'Finished IR-040.',
        latestCommit: 'task2',
        irNumber: '040',
        irTask: 'Implement task 2.',
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
        coderOutput: 'Completed without reconciled effect evidence.',
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
      target: 'reportedReviewFailure',
      context: { ...CONTEXT, phase: 'direct' },
      event: done({ approvedCommit: 'previous', noUnsettledFindings: true }),
    },
  ],
  'reviewFirstCommit.invoke.onError': [
    {
      guard: 'authoredReviewFailure',
      target: 'reportedReviewFailure',
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
        coderOutput: 'Completed task 1.',
        latestCommit: 'task1',
        irNumber: '040',
        irTask: 'Implement task 1.',
      }),
    },
    {
      guard: 'isFinalTask',
      target: 'reviewIrTask',
      context: CONTEXT,
      event: done({
        guard: 'finalTask',
        coderOutput: 'Completed the final task.',
        latestCommit: 'task2',
        irNumber: '040',
        irTask: 'Implement task 2.',
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
        coderOutput: 'Completed without reconciled effect evidence.',
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
      target: 'reportedReviewFailure',
      context: { ...CONTEXT, phase: 'ir-task-final' },
      event: done({ evaluatedRevision: 'rev123', noUnsettledFindings: false }),
    },
  ],
  'reviewIrTask.invoke.onError': [
    {
      guard: 'authoredReviewFailure',
      target: 'reportedReviewFailure',
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

function transitionActions(transition: RawTransition): readonly unknown[] {
  if (transition.actions === undefined) return [];
  return Array.isArray(transition.actions)
    ? transition.actions
    : [transition.actions];
}

function acceptedOutcomeMarkers(
  transition: RawTransition,
): readonly unknown[] {
  return transitionActions(transition)
    .filter(
      (action) =>
        isRecord(action) && action.type === ACCEPTED_OUTCOME_ACTION_TYPE,
    )
    .map((action) => (action as Record<string, unknown>).params);
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
    input: { runResults: '' },
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

  it('marks exactly the eight accepted governed outcomes with stable identities', () => {
    const states = (codingMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const governed = [
      {
        stateId: 'runFirstPhase',
        expected: [
          {
            source: 'runFirstPhase',
            target: 'reviewFirstCommit',
            acceptedOutcome: 'directCommit',
          },
          {
            source: 'runFirstPhase',
            target: 'reviewFirstCommit',
            acceptedOutcome: 'irCommit',
          },
          {
            source: 'runFirstPhase',
            target: 'reviewIrTask',
            acceptedOutcome: 'moreTasks',
          },
          {
            source: 'runFirstPhase',
            target: 'reviewIrTask',
            acceptedOutcome: 'finalTask',
          },
          {
            source: 'runFirstPhase',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
        ],
      },
      {
        stateId: 'runIrTask',
        expected: [
          {
            source: 'runIrTask',
            target: 'reviewIrTask',
            acceptedOutcome: 'moreTasks',
          },
          {
            source: 'runIrTask',
            target: 'reviewIrTask',
            acceptedOutcome: 'finalTask',
          },
          {
            source: 'runIrTask',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
        ],
      },
    ] as const;

    for (const { stateId, expected } of governed) {
      const onDone = states[stateId]?.invoke?.onDone;
      expect(Array.isArray(onDone), stateId).toBe(true);
      const arms = onDone as readonly RawTransition[];
      expect(arms).toHaveLength(expected.length + 1);
      expect(
        arms.slice(0, -1).map((arm) => acceptedOutcomeMarkers(arm)),
        stateId,
      ).toEqual(expected.map((marker) => [marker]));
      expect(acceptedOutcomeMarkers(arms.at(-1)!)).toEqual([]);
    }
  });

  it('completes one direct phase only after exact REVIEW approval', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed the change.',
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
    expect(snapshot.value).toBe('done');
    expect(snapshot.output).toEqual({
      status: 'complete',
      lastCodeCommit: 'abc123',
      finalEvaluatedRevision: 'rev123',
      allReviewsPassed: true,
    });
    expect(workflow.reviewInputs[0]?.text).toBe(
      '> Original intent: Fix the bug.\n' +
        '> Review scope: the commit abc123 from this coding phase and its resulting repository state.\n' +
        '> Coder output: Committed the change.',
    );
  });

  it('loops one commit per IR task and stops after the final reviewed task', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'irCommit',
          coderOutput: 'Created IR-040.',
          latestCommit: 'ir040',
          irNumber: '040',
        },
        {
          guard: 'moreTasks',
          coderOutput: 'Completed task 1.',
          latestCommit: 'task1',
          irNumber: '040',
          irTask: 'Implement task 1.',
        },
        {
          guard: 'finalTask',
          coderOutput: 'Completed task 2.',
          latestCommit: 'task2',
          irNumber: '040',
          irTask: 'Implement task 2.',
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
      finalEvaluatedRevision: 'rev123',
      allReviewsPassed: true,
    });
    expect(workflow.playerInputs.map(({ stateId }) => stateId)).toEqual([
      'runFirstPhase',
      'runIrTask',
      'runIrTask',
    ]);
    expect(workflow.playerInputs[1]?.irNumber).toBe('040');
    expect(workflow.reviewInputs.map(({ stateId }) => stateId)).toEqual([
      'reviewFirstCommit',
      'reviewIrTask',
      'reviewIrTask',
    ]);
    expect(workflow.reviewInputs[0]?.text).not.toContain('Current IR task:');
    expect(workflow.reviewInputs[2]?.text).toBe(
      '> Original intent: Large change.\n' +
        '> Review scope: the commit task2 from this coding phase and its resulting repository state.\n' +
        '> Coder output: Completed task 2.\n' +
        '> Current IR task: Implement task 2.',
    );
  });

  it('continues an existing IR from the first phase through the IR-task review', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'moreTasks',
          coderOutput: 'Continued IR-040 with task 3.',
          latestCommit: 'task3',
          irNumber: '040',
          irTask: 'Implement task 3.',
        },
        {
          guard: 'finalTask',
          coderOutput: 'Finished IR-040.',
          latestCommit: 'task4',
          irNumber: '040',
          irTask: 'Implement task 4.',
        },
      ],
      [APPROVED, APPROVED_TASK4],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Continue IR-040.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'complete',
      lastCodeCommit: 'task4',
      finalEvaluatedRevision: 'task4rev',
      allReviewsPassed: true,
    });
    expect(workflow.playerInputs.map(({ stateId }) => stateId)).toEqual([
      'runFirstPhase',
      'runIrTask',
    ]);
    expect(workflow.playerInputs[1]?.irNumber).toBe('040');
    expect(workflow.reviewInputs.map(({ stateId }) => stateId)).toEqual([
      'reviewIrTask',
      'reviewIrTask',
    ]);
    expect(workflow.reviewInputs[0]?.text).toContain(
      '> Current IR task: Implement task 3.',
    );
  });

  it('parks and resumes the same Coder leaf after a Boss reply', async () => {
    const workflow = createWorkflow(
      [
        { guard: 'needsBossReply', question: 'Which branch?' },
        {
          guard: 'directCommit',
          coderOutput: 'Committed with the answer.',
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

  it('reports a terminal REVIEW result that omits the evaluated revision', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed the change.',
          latestCommit: 'abc123',
        },
      ],
      [APPROVED_WITHOUT_REVISION],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Fix it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reportedReviewFailure');
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      error: {
        name: 'ReviewContractError',
        message:
          'REVIEW returned an invalid approval result: ' +
          '{"noUnsettledFindings":true}',
      },
    });
  });

  it('reports a terminal REVIEW result that does not prove scope-evaluated approval', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed the change.',
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
    expect(snapshot.value).toBe('reportedReviewFailure');
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
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
          coderOutput: 'Committed the change.',
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
    expect(snapshot.value).toBe('reportedReviewFailure');
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      error: { name: 'ReviewError', message: 'REVIEW failed.' },
    });
  });

  it('parks on an unstructured REVIEW control-plane failure', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed the change.',
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
