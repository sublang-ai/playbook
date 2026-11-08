// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_OUTCOME_ACTION_TYPE } from '../../../src/accepted-outcome.js';
import {
  codeMachine,
  type CodeContext,
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
  context: CodeContext;
  event: unknown;
}

const APPROVED = {
  evaluatedRevision: 'rev123',
  noUnsettledFindings: true,
} as const;

// A terminal REVIEW result without the DR-045 evaluated revision does not
// establish the evaluated scope, so CODE must not accept it as approval.
const APPROVED_WITHOUT_REVISION = { noUnsettledFindings: true } as const;
// The compact error CODE reports when REVIEW's terminal result does not
// establish the evaluated scope; the offending output stays in the
// review evidence rather than in the reported message.
const REVIEW_NOT_PASSED = {
  name: 'ReviewNotPassed',
  message:
    'review returned a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings.',
} as const;
const APPROVED_TASK4 = {
  evaluatedRevision: 'task4rev',
  noUnsettledFindings: true,
} as const;

const CONTEXT: CodeContext = {
  runResults: '',
  callerInput: 'Implement the request.',
  coderOutput: 'Completed the phase.',
  codeCommit: 'abc123',
  codeCommits: ['abc123'],
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
  stateId: 'firstPhase' | 'irTaskPhase',
  sourceItem: 'CODE-1' | 'CODE-3',
): CodeContext => ({
  ...CONTEXT,
  pendingBossQuestion: {
    questionId: stateId,
    resumeStateId: stateId,
    sourceItem,
    asker: { kind: 'role', roleId: 'coder' },
    question: 'Which branch?',
  },
});

// Each Coder leaf routes a well-formed question first, then its accepted
// commit outcomes, and finally the malformed-output fallback.
const questionFixture: TransitionFixture = {
  guard: 'needsBossReplyWithQuestion',
  target: '#awaitBossReply',
  context: CONTEXT,
  event: done({ guard: 'needsBossReply', question: 'Which branch?' }),
};

const transitionFixtures: Record<string, readonly TransitionFixture[]> = {
  'root.on.BOSS_INTERRUPT': [
    {
      // The generated interrupt arms guard inline on targetId and context.
      guard: '<inline>',
      target: '#firstPhase',
      context: CONTEXT,
      event: { type: 'BOSS_INTERRUPT', targetId: 'firstPhase' },
    },
    {
      guard: '<inline>',
      target: '#irTaskPhase',
      context: CONTEXT,
      event: { type: 'BOSS_INTERRUPT', targetId: 'irTaskPhase' },
    },
  ],
  'firstPhase.invoke.onDone': [
    questionFixture,
    {
      guard: 'acceptDirectCommit',
      target: '#reviewIntent',
      context: CONTEXT,
      event: done({
        guard: 'directCommit',
        coderOutput: 'Completed the phase.',
        latestCommit: 'abc123',
      }),
    },
    {
      guard: 'acceptIrCommit',
      target: '#irTaskPhase',
      context: CONTEXT,
      event: done({
        guard: 'irCommit',
        coderOutput: 'Created IR-040.',
        latestCommit: 'ir040',
        irNumber: '040',
      }),
    },
    {
      guard: 'acceptMoreTasks',
      target: '#irTaskPhase',
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
      guard: 'acceptFinalTask',
      target: '#reviewIntent',
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
      guard: '<fallback>',
      target: '#failed',
      context: CONTEXT,
      event: done({
        guard: 'directCommit',
        coderOutput: 'Completed without reconciled effect evidence.',
      }),
    },
  ],
  'irTaskPhase.invoke.onDone': [
    questionFixture,
    {
      guard: 'acceptMoreTasks',
      target: '#irTaskPhase',
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
      guard: 'acceptFinalTask',
      target: '#reviewIntent',
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
      guard: '<fallback>',
      target: '#failed',
      context: CONTEXT,
      event: done({
        guard: 'finalTask',
        coderOutput: 'Completed without reconciled effect evidence.',
      }),
    },
  ],
  // DR-102: the one review follows the direct phase or the final task; a
  // nonfinal phase outcome never reaches it.
  'reviewIntent.invoke.onDone': [
    {
      guard: 'reviewPassed',
      target: 'done',
      context: { ...CONTEXT, phaseOutcome: 'finalTask' },
      event: done(APPROVED),
    },
    {
      guard: '<fallback>',
      target: 'reviewFailed',
      context: { ...CONTEXT, phaseOutcome: 'directCommit' },
      event: done({ evaluatedRevision: 'rev123', noUnsettledFindings: false }),
    },
  ],
  'reviewIntent.invoke.onError': [
    {
      guard: 'authoredReviewFailure',
      target: '#reviewFailed',
      context: CONTEXT,
      event: { type: 'xstate.error.actor.review', error: authoredFailure },
    },
    {
      guard: '<fallback>',
      target: '#failed',
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
      target: 'failed',
      context: pendingContext('firstPhase', 'CODE-1'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'firstPhase',
        answer: '  ',
      },
    },
    {
      // The generated resume arms guard inline on the pending question.
      guard: '<inline>',
      target: '#firstPhase',
      context: pendingContext('firstPhase', 'CODE-1'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'firstPhase',
        answer: 'Use the narrow branch.',
      },
    },
    {
      guard: '<inline>',
      target: '#irTaskPhase',
      context: pendingContext('irTaskPhase', 'CODE-3'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'irTaskPhase',
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
  if (typeof guard === 'function') return '<inline>';
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

// Only the IR-task leaf's input carries the IR number.
const irNumberOf = (input: PlayerInput | undefined): string | undefined =>
  input?.stateId === 'irTaskPhase' ? input.irNumber : undefined;

function createWorkflow(
  playerOutputs: readonly (PlayerOutput | Error)[],
  reviewOutputs: readonly (JsonValue | Error | undefined)[],
) {
  const pendingPlayers = [...playerOutputs];
  const pendingReviews = [...reviewOutputs];
  const playerInputs: PlayerInput[] = [];
  const reviewInputs: PlaybookInput[] = [];
  const machine = codeMachine.provide({
    actors: {
      player: fromPromise<PlayerOutput, PlayerInput>(async ({ input }) => {
        playerInputs.push(input);
        const output = pendingPlayers.shift();
        if (output === undefined) throw new Error('missing player fixture');
        if (output instanceof Error) throw output;
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
    const config = (codeMachine as unknown as {
      config: RawState & { states: Record<string, RawState> };
    }).config;
    // Root-level arms (the Boss interrupts) are ordered transitions too.
    const actual = new Map<string, readonly RawTransition[]>([
      ...orderedTransitions({ root: { on: config.on } }),
      ...orderedTransitions(config.states),
    ]);
    expect([...actual.keys()]).toEqual(Object.keys(transitionFixtures));

    const guards = codeMachine.implementations.guards as unknown as Record<
      string,
      (
        args: { context: CodeContext; event: unknown },
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
          const args = { context: fixture.context, event: fixture.event };
          if (name === undefined) return true;
          if (name === '<inline>') {
            return (arm.guard as (value: typeof args) => boolean)(args);
          }
          return guards[name](args, undefined);
        });
        expect(evaluations, `${location}[${index}]`).toEqual([
          ...Array.from({ length: index }, () => false),
          true,
        ]);
      });
    }
  });

  it('marks exactly the eight accepted governed outcomes with stable identities', () => {
    const states = (codeMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    // playbook-32: one marker per accepted matrix arm, in the compiled arm
    // order (the question arm first); the final fallback accepts no outcome.
    const governed = [
      {
        stateId: 'firstPhase',
        expected: [
          {
            source: 'firstPhase',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
          {
            source: 'firstPhase',
            target: 'reviewIntent',
            acceptedOutcome: 'directCommit',
          },
          {
            source: 'firstPhase',
            target: 'irTaskPhase',
            acceptedOutcome: 'irCommit',
          },
          {
            source: 'firstPhase',
            target: 'irTaskPhase',
            acceptedOutcome: 'moreTasks',
          },
          {
            source: 'firstPhase',
            target: 'reviewIntent',
            acceptedOutcome: 'finalTask',
          },
        ],
      },
      {
        stateId: 'irTaskPhase',
        expected: [
          {
            source: 'irTaskPhase',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
          {
            source: 'irTaskPhase',
            target: 'irTaskPhase',
            acceptedOutcome: 'moreTasks',
          },
          {
            source: 'irTaskPhase',
            target: 'reviewIntent',
            acceptedOutcome: 'finalTask',
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
    // A direct intent names its one commit and relays no IR block.
    expect(workflow.reviewInputs[0]?.text).toBe(
      '> Original intent: Fix the bug.\n' +
        '> Review scope: every commit of this coding intent, namely abc123, and its resulting repository state.\n' +
        '> Coder output: Committed the change.',
    );
    expect(snapshot.context.codeCommits).toEqual(['abc123']);
  });

  it('loops one commit per IR task and reviews the intent once after the final task', async () => {
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
      [APPROVED],
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
    // DR-102: three phases, each with its own Coder call, then one REVIEW.
    expect(workflow.playerInputs.map(({ stateId }) => stateId)).toEqual([
      'firstPhase',
      'irTaskPhase',
      'irTaskPhase',
    ]);
    expect(irNumberOf(workflow.playerInputs[1])).toBe('040');
    expect(irNumberOf(workflow.playerInputs[2])).toBe('040');
    for (const input of workflow.playerInputs) {
      expect(input).not.toHaveProperty('previousPhaseReview');
    }
    expect(workflow.reviewInputs.map(({ stateId }) => stateId)).toEqual([
      'reviewIntent',
    ]);
    // CODE-3 names every phase commit oldest first and relays the IR number
    // as the Source's second, separate quote block.
    expect(workflow.reviewInputs[0]?.text).toBe(
      '> Original intent: Large change.\n' +
        '> Review scope: every commit of this coding intent, namely ir040, task1, task2, and its resulting repository state.\n' +
        '> Coder output: Completed task 2.\n' +
        '\n' +
        '> IR number: 040',
    );
    expect(snapshot.context.codeCommits).toEqual(['ir040', 'task1', 'task2']);
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
      [APPROVED_TASK4],
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
      'firstPhase',
      'irTaskPhase',
    ]);
    expect(irNumberOf(workflow.playerInputs[1])).toBe('040');
    expect(workflow.reviewInputs.map(({ stateId }) => stateId)).toEqual([
      'reviewIntent',
    ]);
    expect(workflow.reviewInputs[0]?.text).toContain(
      '> Review scope: every commit of this coding intent, namely task3, task4, and its resulting repository state.',
    );
    expect(workflow.reviewInputs[0]?.text).toContain('> IR number: 040');
  });

  it('reports every task commit when the one review fails after a multi-task intent', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'moreTasks',
          coderOutput: 'Task 3.',
          latestCommit: 'task3',
          irNumber: '040',
          irTask: 'Implement task 3.',
        },
        {
          guard: 'finalTask',
          coderOutput: 'Task 4.',
          latestCommit: 'task4',
          irNumber: '040',
          irTask: 'Implement task 4.',
        },
      ],
      [authoredFailure],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Continue IR-040.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reviewFailed');
    expect(snapshot.output).toMatchObject({
      status: 'review-failed',
      lastCodeCommit: 'task4',
    });
    expect(snapshot.context.codeCommits).toEqual(['task3', 'task4']);
    expect(workflow.reviewInputs).toHaveLength(1);
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
      questionId: 'firstPhase',
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
    expect(snapshot.value).toBe('reviewFailed');
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      error: REVIEW_NOT_PASSED,
    });
    expect(snapshot.context.reviewEvidence).toEqual({
      playbookId: 'review',
      status: 'ok',
      output: APPROVED_WITHOUT_REVISION,
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
    expect(snapshot.value).toBe('reviewFailed');
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      error: REVIEW_NOT_PASSED,
    });
    expect(snapshot.context.reviewEvidence).toEqual({
      playbookId: 'review',
      status: 'ok',
      output: { approvedCommit: 'previous', noUnsettledFindings: true },
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
    expect(snapshot.value).toBe('reviewFailed');
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

  // playbook-13/-15: a resumed Coder call that fails leaves its working
  // state without suspending for its own question, so the failure exit
  // clears the pending question and Boss's reply rather than parking them in
  // `failed`, and it records the failure as a JSON-safe error record.
  it.each([
    ['firstPhase', 'an actor error'],
    ['firstPhase', 'a malformed result'],
    ['irTaskPhase', 'an actor error'],
    ['irTaskPhase', 'a malformed result'],
  ] as const)(
    'clears the answered question when the resumed %s call fails with %s',
    async (stateId, failure) => {
      const question: PlayerOutput = {
        guard: 'needsBossReply',
        question: 'Which branch?',
      };
      const failing =
        failure === 'an actor error'
          ? new Error('coder exploded')
          : ({ guard: 'moreTasks', coderOutput: 'No commit.' } as unknown as PlayerOutput);
      const workflow = createWorkflow(
        stateId === 'firstPhase'
          ? [question, failing]
          : [
              {
                guard: 'irCommit',
                coderOutput: 'Created IR-040.',
                latestCommit: 'ir040',
                irNumber: '040',
              },
              question,
              failing,
            ],
        stateId === 'firstPhase' ? [] : [APPROVED],
      );
      workflow.actor.send({ type: 'START_CODE', callerInput: 'Implement it.' });
      await waitFor(workflow.actor, (value) => value.matches('awaitBossReply'));
      workflow.actor.send({
        type: 'BOSS_REPLY',
        questionId: stateId,
        answer: 'Use the narrow branch.',
      });
      const snapshot = await waitFor(workflow.actor, (value) =>
        value.matches('failed'),
      );
      const resumed = workflow.playerInputs.at(-1);
      expect(resumed?.stateId).toBe(stateId);
      expect(resumed?.pendingBossQuestion?.question).toBe('Which branch?');
      expect(resumed?.bossReply).toBe('Use the narrow branch.');
      expect(snapshot.context.pendingBossQuestion).toBeUndefined();
      expect(snapshot.context.bossReply).toBeUndefined();
      const lastError = snapshot.context.lastError;
      expect(lastError).toMatchObject(
        failure === 'an actor error'
          ? { name: 'Error', message: 'coder exploded' }
          : {
              name: 'MalformedPlayerOutput',
              message:
                'Coder output did not match an outcome declared for the working state.',
            },
      );
      expect(JSON.parse(JSON.stringify(lastError))).toEqual(lastError);
    },
  );
});
