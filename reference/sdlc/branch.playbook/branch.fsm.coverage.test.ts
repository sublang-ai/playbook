// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_OUTCOME_ACTION_TYPE } from '../../../src/accepted-outcome.js';
import {
  branchMachine,
  type BranchContext,
  type PlayerInput,
  type PlayerOutput,
} from './branch.fsm.js';

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
  context: BranchContext;
  event: unknown;
}

const BASE_REVISION = '1111111111111111111111111111111111111111';

const BRANCHED = {
  guard: 'branched',
  branch: 'issue-12-fix-retry',
  baseRevision: BASE_REVISION,
  issueSummary: 'Issue #12 asks for exponential backoff with jitter.',
} as const;

const CONTEXT: BranchContext = {
  callerInput: 'Fix #12: the retry loop never backs off.',
};

const done = (output: unknown) => ({
  type: 'xstate.done.actor.player',
  output,
});

const pendingContext: BranchContext = {
  ...CONTEXT,
  pendingBossQuestion: {
    questionId: 'createBranch',
    resumeStateId: 'createBranch',
    sourceItem: 'BRANCH-1',
    asker: { kind: 'role', roleId: 'coder' },
    question: 'Which issue should the branch be for?',
  },
};

const transitionFixtures: Record<string, readonly TransitionFixture[]> = {
  'createBranch.invoke.onDone': [
    {
      guard: 'isBranched',
      target: 'branched',
      context: CONTEXT,
      event: done(BRANCHED),
    },
    {
      guard: 'isRefused',
      target: 'refused',
      context: CONTEXT,
      event: done({
        guard: 'refused',
        coderOutput: 'The working tree is not clean; nothing was created.',
      }),
    },
    {
      guard: 'needsBossReply',
      target: 'awaitBossReply',
      context: CONTEXT,
      event: done({
        guard: 'needsBossReply',
        question: 'Which issue should the branch be for?',
      }),
    },
    {
      // A branched claim without the receipt-observed base revision is not
      // an accepted outcome (DR-045) and falls through to the malformed park.
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: done({
        guard: 'branched',
        branch: 'issue-12-fix-retry',
        issueSummary: 'Issue #12 asks for exponential backoff with jitter.',
      }),
    },
  ],
  'awaitBossReply.on.BOSS_REPLY': [
    {
      guard: 'emptyBossReply',
      target: '#failed',
      context: pendingContext,
      event: { type: 'BOSS_REPLY', questionId: 'createBranch', answer: '  ' },
    },
    {
      guard: 'resumesCreateBranch',
      target: '#createBranch',
      context: pendingContext,
      event: {
        type: 'BOSS_REPLY',
        questionId: 'createBranch',
        answer: 'Issue #12.',
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

function createWorkflow(playerOutputs: readonly (PlayerOutput | Error)[]) {
  const pendingPlayers = [...playerOutputs];
  const playerInputs: PlayerInput[] = [];
  const machine = branchMachine.provide({
    actors: {
      player: fromPromise<PlayerOutput, PlayerInput>(async ({ input }) => {
        playerInputs.push(input);
        const output = pendingPlayers.shift();
        if (output === undefined) throw new Error('missing player fixture');
        if (output instanceof Error) throw output;
        return output;
      }),
    },
  });
  const actor = createActor(machine, { input: {} });
  actor.start();
  return { actor, playerInputs };
}

describe('BRANCH FSM transition coverage', () => {
  it('has one load-bearing fixture for every ordered transition arm', () => {
    const states = (branchMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const actual = orderedTransitions(states);
    expect([...actual.keys()]).toEqual(Object.keys(transitionFixtures));

    const guards = branchMachine.implementations.guards as unknown as Record<
      string,
      (
        args: { context: BranchContext; event: unknown },
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

  it('marks exactly the three accepted governed outcomes with stable identities', () => {
    const states = (branchMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const onDone = states.createBranch?.invoke?.onDone;
    expect(Array.isArray(onDone)).toBe(true);
    const arms = onDone as readonly RawTransition[];
    expect(arms).toHaveLength(4);
    expect(arms.slice(0, -1).map((arm) => acceptedOutcomeMarkers(arm))).toEqual(
      [
        {
          source: 'createBranch',
          target: 'branched',
          acceptedOutcome: 'branched',
        },
        {
          source: 'createBranch',
          target: 'refused',
          acceptedOutcome: 'refused',
        },
        {
          source: 'createBranch',
          target: 'awaitBossReply',
          acceptedOutcome: 'needsBossReply',
        },
      ].map((marker) => [marker]),
    );
    expect(acceptedOutcomeMarkers(arms.at(-1)!)).toEqual([]);
  });

  it('completes branched with the exact name, base revision, and summary', async () => {
    const workflow = createWorkflow([BRANCHED]);
    workflow.actor.send({
      type: 'START_BRANCH',
      callerInput: 'Fix #12: the retry loop never backs off.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('branched');
    expect(snapshot.output).toEqual({
      status: 'branched',
      branch: 'issue-12-fix-retry',
      baseRevision: BASE_REVISION,
      issueSummary: 'Issue #12 asks for exponential backoff with jitter.',
    });
    expect(workflow.playerInputs).toEqual([
      expect.objectContaining({
        stateId: 'createBranch',
        role: 'coder',
        sourceItem: 'BRANCH-1',
        callerInput: 'Fix #12: the retry loop never backs off.',
      }),
    ]);
    expect(workflow.playerInputs[0]?.pendingBossQuestion).toBeUndefined();
    expect(workflow.playerInputs[0]?.bossReply).toBeUndefined();
  });

  it("fails refused with Coder's complete report and no branch", async () => {
    const workflow = createWorkflow([
      {
        guard: 'refused',
        coderOutput: 'gh is not authenticated for origin; nothing was created.',
      },
    ]);
    workflow.actor.send({ type: 'START_BRANCH', callerInput: 'Fix #12.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('refused');
    expect(snapshot.output).toEqual({
      status: 'refused',
      coderOutput: 'gh is not authenticated for origin; nothing was created.',
    });
    expect(snapshot.context.branch).toBeUndefined();
    expect(snapshot.context.baseRevision).toBeUndefined();
  });

  it('parks for a Boss reply and resumes the same Coder state with the answer', async () => {
    const workflow = createWorkflow([
      {
        guard: 'needsBossReply',
        question: 'Which issue should the branch be for?',
      },
      BRANCHED,
    ]);
    workflow.actor.send({
      type: 'START_BRANCH',
      callerInput: 'Branch for the retry issue.',
    });
    const parked = await waitFor(workflow.actor, (value) =>
      value.matches('awaitBossReply'),
    );
    expect(parked.context.pendingBossQuestion).toEqual({
      questionId: 'createBranch',
      resumeStateId: 'createBranch',
      sourceItem: 'BRANCH-1',
      asker: { kind: 'role', roleId: 'coder' },
      question: 'Which issue should the branch be for?',
    });
    workflow.actor.send({
      type: 'BOSS_REPLY',
      questionId: 'createBranch',
      answer: 'Issue #12.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('branched');
    expect(workflow.playerInputs).toHaveLength(2);
    expect(workflow.playerInputs[1]?.pendingBossQuestion?.question).toBe(
      'Which issue should the branch be for?',
    );
    expect(workflow.playerInputs[1]?.bossReply).toBe('Issue #12.');
    // Leaving the Coder state through its accepted outcome clears the
    // consumed question and reply context.
    expect(snapshot.context.pendingBossQuestion).toBeUndefined();
    expect(snapshot.context.bossReply).toBeUndefined();
  });

  it('parks an empty Boss reply as a recoverable failure', async () => {
    const workflow = createWorkflow([
      {
        guard: 'needsBossReply',
        question: 'Which issue should the branch be for?',
      },
    ]);
    workflow.actor.send({ type: 'START_BRANCH', callerInput: 'Branch it.' });
    await waitFor(workflow.actor, (value) => value.matches('awaitBossReply'));
    workflow.actor.send({ type: 'BOSS_REPLY', answer: '   ' });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(String(snapshot.context.lastError)).toContain('empty answer');
    expect(snapshot.context.pendingBossQuestion).toBeUndefined();
    expect(workflow.playerInputs).toHaveLength(1);
  });

  it('parks a Coder result that matches no available outcome', async () => {
    const workflow = createWorkflow([
      { guard: 'branched', branch: 'issue-12-fix-retry' } as unknown as PlayerOutput,
    ]);
    workflow.actor.send({ type: 'START_BRANCH', callerInput: 'Fix #12.' });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(String(snapshot.context.lastError)).toContain(
      'did not match an available outcome',
    );
    expect(snapshot.context.completion).toBeUndefined();
  });

  it('parks recoverably on a player invocation failure and restarts', async () => {
    const workflow = createWorkflow([new Error('coder transport failed'), BRANCHED]);
    workflow.actor.send({ type: 'START_BRANCH', callerInput: 'Fix #12.' });
    const failed = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(failed.status).toBe('active');
    expect(failed.context.lastError).toBeInstanceOf(Error);
    workflow.actor.send({ type: 'START_BRANCH', callerInput: 'Fix #12 again.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('branched');
    expect(snapshot.context.lastError).toBeUndefined();
    expect(workflow.playerInputs[1]?.callerInput).toBe('Fix #12 again.');
  });
});
