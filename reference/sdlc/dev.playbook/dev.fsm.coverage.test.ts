// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_OUTCOME_ACTION_TYPE } from '../../../src/accepted-outcome.js';
import {
  devMachine,
  type DevContext,
  type JsonValue,
  type PlaybookInput,
  type PlayerInput,
  type PlayerOutput,
} from './dev.fsm.js';

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
  context: DevContext;
  event: unknown;
}

const CODE_COMPLETE = {
  status: 'complete',
  lastCodeCommit: 'code123',
  finalEvaluatedRevision: 'code-rev',
  allReviewsPassed: true,
} as const;

const DECIDE_COMPLETE = {
  decideCommit: 'decide123',
  evaluatedRevision: 'rev456',
  noUnsettledFindings: true,
} as const;

const CONTEXT: DevContext = {
  runResults: '',
  developmentRequest: 'Plan the request.',
  discussionExchanges: [],
  planningResult: 'Proceed with code.',
  decideCommit: 'decide123',
  evaluatedRevision: 'rev456',
};

const done = (output: unknown) => ({
  type: 'xstate.done.actor.worker',
  output,
});

const authoredFailure = (playbookId: 'code' | 'decide') =>
  Object.assign(new Error(`${playbookId} aborted.`), {
    result: { status: 'aborted', playbookId },
  });

const pendingContext: DevContext = {
  ...CONTEXT,
  pendingBossQuestion: {
    questionId: 'planAnalysis',
    resumeStateId: 'planAnalysis',
    sourceItem: 'DEV-1',
    asker: { kind: 'role', roleId: 'analyst' },
    question: 'Which scope?',
  },
};

const codeCallFixtures = (
  onDoneKey: string,
  onErrorKey: string,
): Record<string, readonly TransitionFixture[]> => ({
  [onDoneKey]: [
    {
      guard: 'isCodeSuccess',
      target: 'done',
      context: CONTEXT,
      event: done(CODE_COMPLETE),
    },
    {
      guard: '<fallback>',
      target: 'reportedChildFailure',
      context: CONTEXT,
      event: done({
        status: 'review-failed',
        lastCodeCommit: 'code123',
        error: { name: 'Error', message: 'unsettled findings' },
      }),
    },
  ],
  [onErrorKey]: [
    {
      guard: 'authoredCodeFailure',
      target: 'reportedChildFailure',
      context: CONTEXT,
      event: { type: 'xstate.error.actor.code', error: authoredFailure('code') },
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: {
        type: 'xstate.error.actor.code',
        error: new Error('control-plane failure'),
      },
    },
  ],
});

const transitionFixtures: Record<string, readonly TransitionFixture[]> = {
  'planAnalysis.invoke.onDone': [
    {
      guard: 'isDiscussionComplete',
      target: 'discussionComplete',
      context: { ...pendingContext, bossReply: 'Thanks, stop here.' },
      event: done({ guard: 'discussionComplete' }),
    },
    {
      guard: 'isCodePath',
      target: 'callCode',
      context: CONTEXT,
      event: done({ guard: 'code', planningResult: 'Proceed with code.' }),
    },
    {
      guard: 'isDecideThenCode',
      target: 'callDecide',
      context: CONTEXT,
      event: done({
        guard: 'decideThenCode',
        planningResult: 'Decide the design first.',
      }),
    },
    {
      guard: 'needsBossReply',
      target: 'awaitBossReply',
      context: CONTEXT,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
    {
      // Discussion complete without a preceding Boss reply is unavailable
      // and must fall through to the malformed-output park.
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: done({ guard: 'discussionComplete' }),
    },
  ],
  ...codeCallFixtures('callCode.invoke.onDone', 'callCode.invoke.onError'),
  'callDecide.invoke.onDone': [
    {
      guard: 'isDecideSuccess',
      target: 'callCodeAfterDecide',
      context: CONTEXT,
      event: done(DECIDE_COMPLETE),
    },
    {
      guard: '<fallback>',
      target: 'reportedChildFailure',
      context: CONTEXT,
      event: done({ noUnsettledFindings: true }),
    },
  ],
  'callDecide.invoke.onError': [
    {
      guard: 'authoredDecideFailure',
      target: 'reportedChildFailure',
      context: CONTEXT,
      event: {
        type: 'xstate.error.actor.decide',
        error: authoredFailure('decide'),
      },
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: {
        type: 'xstate.error.actor.decide',
        error: new Error('control-plane failure'),
      },
    },
  ],
  ...codeCallFixtures(
    'callCodeAfterDecide.invoke.onDone',
    'callCodeAfterDecide.invoke.onError',
  ),
  'awaitBossReply.on.BOSS_REPLY': [
    {
      guard: 'emptyBossReply',
      target: '#failed',
      context: pendingContext,
      event: { type: 'BOSS_REPLY', questionId: 'planAnalysis', answer: '  ' },
    },
    {
      guard: 'resumesPlanAnalysis',
      target: '#planAnalysis',
      context: pendingContext,
      event: {
        type: 'BOSS_REPLY',
        questionId: 'planAnalysis',
        answer: 'Use the narrow scope.',
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
  childOutputs: readonly (JsonValue | Error | undefined)[],
) {
  const pendingPlayers = [...playerOutputs];
  const pendingChildren = [...childOutputs];
  const playerInputs: PlayerInput[] = [];
  const childInputs: PlaybookInput[] = [];
  const machine = devMachine.provide({
    actors: {
      player: fromPromise<PlayerOutput, PlayerInput>(async ({ input }) => {
        playerInputs.push(input);
        const output = pendingPlayers.shift();
        if (output === undefined) throw new Error('missing player fixture');
        return output;
      }),
      playbook: fromPromise<JsonValue | undefined, PlaybookInput>(
        async ({ input }) => {
          childInputs.push(input);
          if (pendingChildren.length === 0) {
            throw new Error('missing child fixture');
          }
          const output = pendingChildren.shift();
          if (output instanceof Error) throw output;
          return output;
        },
      ),
    },
  });
  const actor = createActor(machine, { input: {} });
  actor.start();
  return { actor, playerInputs, childInputs };
}

describe('DEV FSM transition coverage', () => {
  it('has one load-bearing fixture for every ordered transition arm', () => {
    const states = (devMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const actual = orderedTransitions(states);
    expect([...actual.keys()]).toEqual(Object.keys(transitionFixtures));

    const guards = devMachine.implementations.guards as unknown as Record<
      string,
      (
        args: { context: DevContext; event: unknown },
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

  it('marks exactly the four accepted governed outcomes with stable identities', () => {
    const states = (devMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const onDone = states.planAnalysis?.invoke?.onDone;
    expect(Array.isArray(onDone)).toBe(true);
    const arms = onDone as readonly RawTransition[];
    expect(arms).toHaveLength(5);
    expect(arms.slice(0, -1).map((arm) => acceptedOutcomeMarkers(arm))).toEqual(
      [
        {
          source: 'planAnalysis',
          target: 'discussionComplete',
          acceptedOutcome: 'discussionComplete',
        },
        {
          source: 'planAnalysis',
          target: 'callCode',
          acceptedOutcome: 'code',
        },
        {
          source: 'planAnalysis',
          target: 'callDecide',
          acceptedOutcome: 'decideThenCode',
        },
        {
          source: 'planAnalysis',
          target: 'awaitBossReply',
          acceptedOutcome: 'needsBossReply',
        },
      ].map((marker) => [marker]),
    );
    expect(acceptedOutcomeMarkers(arms.at(-1)!)).toEqual([]);
    for (const stateId of ['callCode', 'callDecide', 'callCodeAfterDecide']) {
      for (const arm of [
        ...((states[stateId]?.invoke?.onDone as readonly RawTransition[]) ??
          []),
        ...((states[stateId]?.invoke?.onError as readonly RawTransition[]) ??
          []),
      ]) {
        expect(acceptedOutcomeMarkers(arm), stateId).toEqual([]);
      }
    }
  });

  it('completes the code path with the successful CODE result', async () => {
    const workflow = createWorkflow(
      [{ guard: 'code', planningResult: 'Proceed under DR-044.' }],
      [CODE_COMPLETE],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Add the new command.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('done');
    expect(snapshot.output).toEqual({
      status: 'complete',
      childPlaybookId: 'code',
      childOutput: CODE_COMPLETE,
    });
    expect(workflow.childInputs).toEqual([
      {
        stateId: 'callCode',
        sourceItem: 'DEV-2',
        playbookId: 'code',
        text: '> Add the new command.\n> Proceed under DR-044.',
      },
    ]);
  });

  it('sequences decide then code and quotes the decide identities', async () => {
    const workflow = createWorkflow(
      [{ guard: 'decideThenCode', planningResult: 'A DR is required.' }],
      [DECIDE_COMPLETE, CODE_COMPLETE],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Introduce a new workflow.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('done');
    expect(snapshot.output).toEqual({
      status: 'complete',
      childPlaybookId: 'code',
      childOutput: CODE_COMPLETE,
    });
    expect(workflow.childInputs.map(({ stateId }) => stateId)).toEqual([
      'callDecide',
      'callCodeAfterDecide',
    ]);
    expect(workflow.childInputs[0]?.playbookId).toBe('decide');
    expect(workflow.childInputs[1]?.playbookId).toBe('code');
    expect(workflow.childInputs[1]?.text).toBe(
      [
        '> Introduce a new workflow.',
        '> A DR is required.',
        '> decide123',
        '> rev456',
      ].join('\n'),
    );
  });

  it('parks for a Boss reply and completes the discussion after it', async () => {
    const workflow = createWorkflow(
      [
        { guard: 'needsBossReply', question: 'Is a DR wanted here?' },
        { guard: 'discussionComplete' },
      ],
      [],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Should we redesign the trace?',
    });
    await waitFor(workflow.actor, (value) => value.matches('awaitBossReply'));
    workflow.actor.send({
      type: 'BOSS_REPLY',
      questionId: 'planAnalysis',
      answer: 'No repository work for now.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('discussionComplete');
    expect(snapshot.output).toEqual({ status: 'discussion-complete' });
    expect(workflow.playerInputs[1]?.pendingBossQuestion?.question).toBe(
      'Is a DR wanted here?',
    );
    expect(workflow.playerInputs[1]?.bossReply).toBe(
      'No repository work for now.',
    );
    expect(workflow.childInputs).toEqual([]);
  });

  it('relays consumed Q&A as discussion context in the child call', async () => {
    const workflow = createWorkflow(
      [
        { guard: 'needsBossReply', question: 'Narrow or broad?' },
        { guard: 'code', planningResult: 'Implement the narrow fix.' },
      ],
      [CODE_COMPLETE],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Fix the flaky retry.',
    });
    await waitFor(workflow.actor, (value) => value.matches('awaitBossReply'));
    workflow.actor.send({ type: 'BOSS_REPLY', answer: 'Narrow.' });
    await waitFor(workflow.actor, (value) => value.status === 'done');
    expect(workflow.childInputs[0]?.text).toBe(
      [
        '> Fix the flaky retry.',
        '> Analyst question: Narrow or broad?',
        '> Boss reply: Narrow.',
        '> Implement the narrow fix.',
      ].join('\n'),
    );
  });

  it('relays a terminal CODE result that does not prove success', async () => {
    const insufficient = {
      status: 'review-failed',
      lastCodeCommit: 'code123',
      error: { name: 'Error', message: 'unsettled findings' },
    };
    const workflow = createWorkflow(
      [{ guard: 'code', planningResult: 'Proceed with code.' }],
      [insufficient],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Implement it.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reportedChildFailure');
    expect(snapshot.output).toEqual({
      status: 'child-failed',
      childResult: { playbookId: 'code', status: 'ok', output: insufficient },
    });
  });

  it('relays an authored DECIDE failure and starts no later child', async () => {
    const workflow = createWorkflow(
      [{ guard: 'decideThenCode', planningResult: 'A DR is required.' }],
      [
        Object.assign(new Error('DECIDE failed.'), {
          result: {
            status: 'error',
            playbookId: 'decide',
            error: { name: 'DecideError', message: 'review rejected' },
          },
        }),
      ],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Introduce a new workflow.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reportedChildFailure');
    expect(snapshot.output).toEqual({
      status: 'child-failed',
      childResult: {
        playbookId: 'decide',
        status: 'error',
        error: { name: 'DecideError', message: 'review rejected' },
      },
    });
    expect(workflow.childInputs).toHaveLength(1);
  });

  it('parks recoverably on a nested-call control-plane failure', async () => {
    const workflow = createWorkflow(
      [{ guard: 'code', planningResult: 'Proceed with code.' }],
      [new Error('bridge failure')],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Implement it.',
    });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(snapshot.context.lastError).toBeInstanceOf(Error);
    expect(snapshot.context.completion).toBeUndefined();
  });

  it('parks a discussion-complete claim made before any Boss reply', async () => {
    const workflow = createWorkflow([{ guard: 'discussionComplete' }], []);
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Plan it.',
    });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(String(snapshot.context.lastError)).toContain(
      'did not match an available outcome',
    );
  });
});
