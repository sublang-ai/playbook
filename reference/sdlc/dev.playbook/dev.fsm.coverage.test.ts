// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_OUTCOME_ACTION_TYPE } from '../../../src/accepted-outcome.js';
import {
  devMachine,
  type DevChildPlaybookId,
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

// BRANCH's canonical success output (DR-050): `baseRevision` is the
// unchanged receipt's observed HEAD, injected by BRANCH's own reconciler.
const BRANCH_COMPLETE = {
  status: 'branched',
  branch: 'issue-12-flaky-retry',
  baseRevision: 'base789',
  issueSummary: 'Issue #12: the retry loops forever on a closed socket.',
} as const;

const PR_COMPLETE = {
  status: 'merged',
  pullRequest: '34',
  pullRequestUrl: 'https://github.com/example/repo/pull/34',
  localDefaultUpdated: true,
} as const;

const CONTEXT: DevContext = {
  runResults: '',
  developmentRequest: 'Plan the request.',
  discussionExchanges: [],
  planningResult: 'Proceed with code.',
  decideCommit: 'decide123',
  evaluatedRevision: 'rev456',
  deliveryViaPullRequest: false,
};

const PULL_REQUEST_CONTEXT: DevContext = {
  ...CONTEXT,
  deliveryViaPullRequest: true,
  pullRequestPath: 'code',
  branch: BRANCH_COMPLETE.branch,
  baseRevision: BRANCH_COMPLETE.baseRevision,
  issueSummary: BRANCH_COMPLETE.issueSummary,
};

const DECIDE_PULL_REQUEST_CONTEXT: DevContext = {
  ...PULL_REQUEST_CONTEXT,
  pullRequestPath: 'decide-then-code',
};

const done = (output: unknown) => ({
  type: 'xstate.done.actor.worker',
  output,
});

const authoredFailure = (playbookId: DevChildPlaybookId) =>
  Object.assign(new Error(`${playbookId} aborted.`), {
    result: { status: 'aborted', playbookId },
  });

// DR-048: a child that completed at its own authored failure terminal is
// rejected by the bridge with its public result carrying the terminal record.
const failureTerminal = (
  playbookId: DevChildPlaybookId,
  stateId: string,
  output: JsonValue,
) =>
  Object.assign(
    new Error(`Child playbook ${playbookId} reached failure terminal ${stateId}`),
    {
      result: {
        status: 'ok',
        playbookId,
        childSessionId: `child-${playbookId}-1`,
        output,
        terminal: {
          stateId,
          kind: 'failure',
          description: `${playbookId.toUpperCase()} reports ${stateId}.`,
        },
      },
    },
  );

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
  pullRequestContext: DevContext,
): Record<string, readonly TransitionFixture[]> => ({
  [onDoneKey]: [
    {
      guard: 'isCodeSuccessViaPullRequest',
      target: 'openPullRequest',
      context: pullRequestContext,
      event: done(CODE_COMPLETE),
    },
    {
      guard: 'isPlainCodeSuccess',
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
      guard: 'isCodeViaPullRequest',
      target: 'createBranch',
      context: CONTEXT,
      event: done({
        guard: 'codeViaPullRequest',
        planningResult: 'Fix issue #12 through a pull request.',
      }),
    },
    {
      guard: 'isDecideThenCodeViaPullRequest',
      target: 'createBranch',
      context: CONTEXT,
      event: done({
        guard: 'decideThenCodeViaPullRequest',
        planningResult: 'Decide the design, then deliver issue #12 through a pull request.',
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
  'createBranch.invoke.onDone': [
    {
      guard: 'isBranchSuccessForCode',
      target: 'callCode',
      context: { ...CONTEXT, deliveryViaPullRequest: true, pullRequestPath: 'code' },
      event: done(BRANCH_COMPLETE),
    },
    {
      guard: 'isBranchSuccessForDecide',
      target: 'callDecide',
      context: {
        ...CONTEXT,
        deliveryViaPullRequest: true,
        pullRequestPath: 'decide-then-code',
      },
      event: done(BRANCH_COMPLETE),
    },
    {
      // A branch result missing a consumed field is insufficient for either
      // path: DEV never substitutes an empty default.
      guard: '<fallback>',
      target: 'reportedChildFailure',
      context: { ...CONTEXT, deliveryViaPullRequest: true, pullRequestPath: 'code' },
      event: done({
        status: 'branched',
        branch: 'issue-12-flaky-retry',
        baseRevision: 'base789',
      }),
    },
  ],
  'createBranch.invoke.onError': [
    {
      guard: 'authoredBranchFailure',
      target: 'reportedChildFailure',
      context: PULL_REQUEST_CONTEXT,
      event: {
        type: 'xstate.error.actor.branch',
        error: authoredFailure('branch'),
      },
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: PULL_REQUEST_CONTEXT,
      event: {
        type: 'xstate.error.actor.branch',
        error: new Error('control-plane failure'),
      },
    },
  ],
  ...codeCallFixtures(
    'callCode.invoke.onDone',
    'callCode.invoke.onError',
    PULL_REQUEST_CONTEXT,
  ),
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
    DECIDE_PULL_REQUEST_CONTEXT,
  ),
  'openPullRequest.invoke.onError': [
    {
      guard: 'authoredPrFailure',
      target: 'reportedChildFailure',
      context: PULL_REQUEST_CONTEXT,
      event: {
        type: 'xstate.error.actor.pr',
        error: failureTerminal('pr', 'checksStillFailing', {
          status: 'not-merged',
          reason: 'checks-failed',
          pullRequest: '34',
          pullRequestUrl: 'https://github.com/example/repo/pull/34',
        }),
      },
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: PULL_REQUEST_CONTEXT,
      event: {
        type: 'xstate.error.actor.pr',
        error: new Error('control-plane failure'),
      },
    },
  ],
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
  const visited: string[] = [];
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
  actor.subscribe((snapshot) => {
    const value = String(snapshot.value);
    if (visited.at(-1) !== value) visited.push(value);
  });
  actor.start();
  return { actor, playerInputs, childInputs, visited };
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

  // DR-048 / DR-050: `pr` declares its terminal kinds, so its success is
  // proven by `onDone` alone and DEV consumes none of its fields by name.
  it('completes on pr success through one unguarded onDone arm', () => {
    const states = (devMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    expect(states.openPullRequest?.invoke?.onDone).toEqual({
      target: 'done',
      actions: 'completeWithChildSuccess',
    });
  });

  // On a pull-request path the `pr` call consumes the exact final evaluated
  // revision, so a CODE success that omits it proves neither the plain nor
  // the pull-request completion: both success guards stay false.
  it('never completes a pull-request path from a CODE result without the evaluated revision', () => {
    const guards = devMachine.implementations.guards as unknown as Record<
      string,
      (args: { context: DevContext; event: unknown }, params: unknown) => boolean
    >;
    const event = done({
      status: 'complete',
      lastCodeCommit: 'code123',
      allReviewsPassed: true,
    });
    expect(
      guards.isCodeSuccessViaPullRequest(
        { context: PULL_REQUEST_CONTEXT, event },
        undefined,
      ),
    ).toBe(false);
    expect(
      guards.isPlainCodeSuccess(
        { context: PULL_REQUEST_CONTEXT, event },
        undefined,
      ),
    ).toBe(false);
    expect(guards.isPlainCodeSuccess({ context: CONTEXT, event }, undefined)).toBe(
      true,
    );
  });

  it('marks exactly the six accepted governed outcomes with stable identities', () => {
    const states = (devMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const onDone = states.planAnalysis?.invoke?.onDone;
    expect(Array.isArray(onDone)).toBe(true);
    const arms = onDone as readonly RawTransition[];
    expect(arms).toHaveLength(7);
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
          target: 'createBranch',
          acceptedOutcome: 'codeViaPullRequest',
        },
        {
          source: 'planAnalysis',
          target: 'createBranch',
          acceptedOutcome: 'decideThenCodeViaPullRequest',
        },
        {
          source: 'planAnalysis',
          target: 'awaitBossReply',
          acceptedOutcome: 'needsBossReply',
        },
      ].map((marker) => [marker]),
    );
    expect(acceptedOutcomeMarkers(arms.at(-1)!)).toEqual([]);
    for (const stateId of [
      'createBranch',
      'callCode',
      'callDecide',
      'callCodeAfterDecide',
      'openPullRequest',
    ]) {
      const invoke = states[stateId]?.invoke;
      const armList = (value: unknown): readonly RawTransition[] =>
        value === undefined
          ? []
          : ((Array.isArray(value) ? value : [value]) as RawTransition[]);
      for (const arm of [...armList(invoke?.onDone), ...armList(invoke?.onError)]) {
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
        text: '> Original request: Add the new command.\n> Planning result: Proceed under DR-044.',
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
        '> Original request: Introduce a new workflow.',
        '> Planning result: A DR is required.',
        '> DECIDE commit: decide123',
        '> Evaluated revision: rev456',
      ].join('\n'),
    );
  });

  // DR-050 pins the plain paths: a plain request visits the same states over
  // the same edges and composes the same child inputs as the pre-DR-050
  // artifact did, with no `branch` or `pr` call. The literals below are that
  // artifact's recorded behavior, not values derived from this machine.
  it('keeps both plain paths byte-identical to the pre-DR-050 artifact', async () => {
    const code = createWorkflow(
      [{ guard: 'code', planningResult: 'Proceed under DR-044.' }],
      [CODE_COMPLETE],
    );
    code.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Add the new command.',
    });
    await waitFor(code.actor, (value) => value.status === 'done');
    expect(code.visited).toEqual(['ready', 'planAnalysis', 'callCode', 'done']);
    expect(code.childInputs).toEqual([
      {
        stateId: 'callCode',
        sourceItem: 'DEV-2',
        playbookId: 'code',
        text: '> Original request: Add the new command.\n> Planning result: Proceed under DR-044.',
      },
    ]);
    expect(code.actor.getSnapshot().output).toEqual({
      status: 'complete',
      childPlaybookId: 'code',
      childOutput: CODE_COMPLETE,
    });

    const decide = createWorkflow(
      [{ guard: 'decideThenCode', planningResult: 'A DR is required.' }],
      [DECIDE_COMPLETE, CODE_COMPLETE],
    );
    decide.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Introduce a new workflow.',
    });
    await waitFor(decide.actor, (value) => value.status === 'done');
    expect(decide.visited).toEqual([
      'ready',
      'planAnalysis',
      'callDecide',
      'callCodeAfterDecide',
      'done',
    ]);
    expect(decide.childInputs).toEqual([
      {
        stateId: 'callDecide',
        sourceItem: 'DEV-3',
        playbookId: 'decide',
        text: '> Original request: Introduce a new workflow.\n> Planning result: A DR is required.',
      },
      {
        stateId: 'callCodeAfterDecide',
        sourceItem: 'DEV-4',
        playbookId: 'code',
        text: [
          '> Original request: Introduce a new workflow.',
          '> Planning result: A DR is required.',
          '> DECIDE commit: decide123',
          '> Evaluated revision: rev456',
        ].join('\n'),
      },
    ]);
    expect(decide.actor.getSnapshot().output).toEqual({
      status: 'complete',
      childPlaybookId: 'code',
      childOutput: CODE_COMPLETE,
    });
    for (const workflow of [code, decide]) {
      expect(
        workflow.childInputs.map(({ playbookId }) => playbookId),
      ).not.toContain('branch');
      expect(
        workflow.childInputs.map(({ playbookId }) => playbookId),
      ).not.toContain('pr');
    }
  });

  it('delivers code via pull request through branch, code, and pr', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'codeViaPullRequest',
          planningResult: 'Fix issue #12 through a pull request.',
        },
      ],
      [BRANCH_COMPLETE, CODE_COMPLETE, PR_COMPLETE],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Fix #12.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(workflow.visited).toEqual([
      'ready',
      'planAnalysis',
      'createBranch',
      'callCode',
      'openPullRequest',
      'done',
    ]);
    expect(snapshot.output).toEqual({
      status: 'complete',
      childPlaybookId: 'pr',
      childOutput: PR_COMPLETE,
    });
    const planningRelay =
      '> Original request: Fix #12.\n> Planning result: Fix issue #12 through a pull request.';
    expect(workflow.childInputs).toEqual([
      {
        stateId: 'createBranch',
        sourceItem: 'DEV-5',
        playbookId: 'branch',
        text: planningRelay,
      },
      {
        stateId: 'callCode',
        sourceItem: 'DEV-2',
        playbookId: 'code',
        text: planningRelay,
      },
      {
        stateId: 'openPullRequest',
        sourceItem: 'DEV-6',
        playbookId: 'pr',
        text: [
          '> Original request: Fix #12.',
          '> Issue summary: Issue #12: the retry loops forever on a closed socket.',
          '> Branch: issue-12-flaky-retry',
          '> Base revision: base789',
          '> CODE commit: code123',
          '> Evaluated revision: code-rev',
        ].join('\n'),
      },
    ]);
    // Every pull-request identity came from a child's canonical result.
    expect(snapshot.context).toMatchObject({
      deliveryViaPullRequest: true,
      pullRequestPath: 'code',
      branch: BRANCH_COMPLETE.branch,
      baseRevision: BRANCH_COMPLETE.baseRevision,
      issueSummary: BRANCH_COMPLETE.issueSummary,
      lastCodeCommit: CODE_COMPLETE.lastCodeCommit,
      finalEvaluatedRevision: CODE_COMPLETE.finalEvaluatedRevision,
    });
  });

  it('delivers decide then code via pull request through branch, decide, code, and pr', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'decideThenCodeViaPullRequest',
          planningResult: 'A DR is required before issue #12 is delivered.',
        },
      ],
      [BRANCH_COMPLETE, DECIDE_COMPLETE, CODE_COMPLETE, PR_COMPLETE],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Resolve #12 with a new decision.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(workflow.visited).toEqual([
      'ready',
      'planAnalysis',
      'createBranch',
      'callDecide',
      'callCodeAfterDecide',
      'openPullRequest',
      'done',
    ]);
    expect(snapshot.output).toEqual({
      status: 'complete',
      childPlaybookId: 'pr',
      childOutput: PR_COMPLETE,
    });
    expect(
      workflow.childInputs.map(({ stateId, sourceItem, playbookId }) => ({
        stateId,
        sourceItem,
        playbookId,
      })),
    ).toEqual([
      { stateId: 'createBranch', sourceItem: 'DEV-5', playbookId: 'branch' },
      { stateId: 'callDecide', sourceItem: 'DEV-3', playbookId: 'decide' },
      { stateId: 'callCodeAfterDecide', sourceItem: 'DEV-4', playbookId: 'code' },
      { stateId: 'openPullRequest', sourceItem: 'DEV-6', playbookId: 'pr' },
    ]);
    expect(workflow.childInputs[2]?.text).toBe(
      [
        '> Original request: Resolve #12 with a new decision.',
        '> Planning result: A DR is required before issue #12 is delivered.',
        '> DECIDE commit: decide123',
        '> Evaluated revision: rev456',
      ].join('\n'),
    );
    expect(workflow.childInputs[3]?.text).toBe(
      [
        '> Original request: Resolve #12 with a new decision.',
        '> Issue summary: Issue #12: the retry loops forever on a closed socket.',
        '> Branch: issue-12-flaky-retry',
        '> Base revision: base789',
        '> CODE commit: code123',
        '> Evaluated revision: code-rev',
      ].join('\n'),
    );
  });

  it('relays an authored BRANCH failure and starts no later child', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'codeViaPullRequest',
          planningResult: 'Fix issue #12 through a pull request.',
        },
      ],
      [
        Object.assign(new Error('BRANCH failed.'), {
          result: {
            status: 'error',
            playbookId: 'branch',
            error: {
              name: 'BranchError',
              message: 'branch issue-12-flaky-retry already exists',
            },
          },
        }),
      ],
    );
    workflow.actor.send({ type: 'START_DEV', developmentRequest: 'Fix #12.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reportedChildFailure');
    expect(snapshot.output).toEqual({
      status: 'child-failed',
      childResult: {
        playbookId: 'branch',
        status: 'error',
        error: {
          name: 'BranchError',
          message: 'branch issue-12-flaky-retry already exists',
        },
      },
    });
    expect(workflow.childInputs.map(({ playbookId }) => playbookId)).toEqual([
      'branch',
    ]);
  });

  // DR-048: BRANCH's `refused` is a declared failure terminal, so the bridge
  // rejects the caller's actor with the child's own result and DEV relays
  // that output through its error-path arm.
  it('relays a BRANCH refusal terminal with its output', async () => {
    const refused = {
      status: 'refused',
      coderOutput: 'The working tree is not clean; nothing was created.',
    };
    const workflow = createWorkflow(
      [
        {
          guard: 'codeViaPullRequest',
          planningResult: 'Fix issue #12 through a pull request.',
        },
      ],
      [failureTerminal('branch', 'refused', refused)],
    );
    workflow.actor.send({ type: 'START_DEV', developmentRequest: 'Fix #12.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reportedChildFailure');
    expect(snapshot.output).toEqual({
      status: 'child-failed',
      childResult: { playbookId: 'branch', status: 'ok', output: refused },
    });
    expect(workflow.childInputs).toHaveLength(1);
  });

  it('relays a BRANCH success that omits a consumed field, never defaulting it', async () => {
    const incomplete = {
      status: 'branched',
      branch: 'issue-12-flaky-retry',
      baseRevision: 'base789',
    };
    const workflow = createWorkflow(
      [
        {
          guard: 'decideThenCodeViaPullRequest',
          planningResult: 'A DR is required before issue #12 is delivered.',
        },
      ],
      [incomplete],
    );
    workflow.actor.send({ type: 'START_DEV', developmentRequest: 'Fix #12.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reportedChildFailure');
    expect(snapshot.output).toEqual({
      status: 'child-failed',
      childResult: { playbookId: 'branch', status: 'ok', output: incomplete },
    });
    expect(workflow.childInputs).toHaveLength(1);
    expect(snapshot.context.branch).toBeUndefined();
    expect(snapshot.context.baseRevision).toBeUndefined();
    expect(snapshot.context.issueSummary).toBeUndefined();
  });

  it('relays a PR failure terminal after branch and code succeeded', async () => {
    const stillFailing = {
      status: 'not-merged',
      reason: 'checks-failed',
      pullRequest: '34',
      pullRequestUrl: 'https://github.com/example/repo/pull/34',
    };
    const workflow = createWorkflow(
      [
        {
          guard: 'codeViaPullRequest',
          planningResult: 'Fix issue #12 through a pull request.',
        },
      ],
      [
        BRANCH_COMPLETE,
        CODE_COMPLETE,
        failureTerminal('pr', 'checksStillFailing', stillFailing),
      ],
    );
    workflow.actor.send({ type: 'START_DEV', developmentRequest: 'Fix #12.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reportedChildFailure');
    expect(snapshot.output).toEqual({
      status: 'child-failed',
      childResult: { playbookId: 'pr', status: 'ok', output: stillFailing },
    });
    expect(workflow.childInputs.map(({ playbookId }) => playbookId)).toEqual([
      'branch',
      'code',
      'pr',
    ]);
  });

  it('relays a CODE success without the evaluated revision on a pull-request path', async () => {
    const incomplete = {
      status: 'complete',
      lastCodeCommit: 'code123',
      allReviewsPassed: true,
    };
    const workflow = createWorkflow(
      [
        {
          guard: 'codeViaPullRequest',
          planningResult: 'Fix issue #12 through a pull request.',
        },
      ],
      [BRANCH_COMPLETE, incomplete],
    );
    workflow.actor.send({ type: 'START_DEV', developmentRequest: 'Fix #12.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('reportedChildFailure');
    expect(snapshot.output).toEqual({
      status: 'child-failed',
      childResult: { playbookId: 'code', status: 'ok', output: incomplete },
    });
    expect(workflow.childInputs.map(({ playbookId }) => playbookId)).toEqual([
      'branch',
      'code',
    ]);
  });

  it('parks recoverably on a BRANCH control-plane failure', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'codeViaPullRequest',
          planningResult: 'Fix issue #12 through a pull request.',
        },
      ],
      [new Error('bridge failure')],
    );
    workflow.actor.send({ type: 'START_DEV', developmentRequest: 'Fix #12.' });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(snapshot.context.lastError).toBeInstanceOf(Error);
    expect(snapshot.context.completion).toBeUndefined();
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
        '> Original request: Fix the flaky retry.',
        '> Prior discussion: Analyst question: Narrow or broad?',
        '> Boss reply: Narrow.',
        '> Planning result: Implement the narrow fix.',
      ].join('\n'),
    );
  });

  it('relays consumed Q&A into the branch call but not the pr call', async () => {
    const workflow = createWorkflow(
      [
        { guard: 'needsBossReply', question: 'Which issue?' },
        {
          guard: 'codeViaPullRequest',
          planningResult: 'Deliver issue #12 through a pull request.',
        },
      ],
      [BRANCH_COMPLETE, CODE_COMPLETE, PR_COMPLETE],
    );
    workflow.actor.send({
      type: 'START_DEV',
      developmentRequest: 'Fix the retry issue.',
    });
    await waitFor(workflow.actor, (value) => value.matches('awaitBossReply'));
    workflow.actor.send({ type: 'BOSS_REPLY', answer: 'Issue #12.' });
    await waitFor(workflow.actor, (value) => value.status === 'done');
    expect(workflow.childInputs[0]?.text).toBe(
      [
        '> Original request: Fix the retry issue.',
        '> Prior discussion: Analyst question: Which issue?',
        '> Boss reply: Issue #12.',
        '> Planning result: Deliver issue #12 through a pull request.',
      ].join('\n'),
    );
    expect(workflow.childInputs[2]?.text).toBe(
      [
        '> Original request: Fix the retry issue.',
        '> Issue summary: Issue #12: the retry loops forever on a closed socket.',
        '> Branch: issue-12-flaky-retry',
        '> Base revision: base789',
        '> CODE commit: code123',
        '> Evaluated revision: code-rev',
      ].join('\n'),
    );
  });

  // DR-048: CODE's `reportedReviewFailure` is a declared failure terminal, so
  // the bridge rejects this caller's actor with the child's own public
  // result. DEV recognizes the failure from that record — never from CODE's
  // output fields — and still relays the child's output.
  it('relays a terminal CODE result that does not prove success', async () => {
    const insufficient = {
      status: 'review-failed',
      lastCodeCommit: 'code123',
      error: { name: 'Error', message: 'unsettled findings' },
    };
    const workflow = createWorkflow(
      [{ guard: 'code', planningResult: 'Proceed with code.' }],
      [
        Object.assign(
          new Error(
            'Child playbook code reached failure terminal reportedReviewFailure',
          ),
          {
            result: {
              status: 'ok',
              playbookId: 'code',
              childSessionId: 'child-code-1',
              output: insufficient,
              terminal: {
                stateId: 'reportedReviewFailure',
                kind: 'failure',
                description: 'CODE reports the review failure.',
              },
            },
          },
        ),
      ],
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

  // Belt and braces: the resolved path keeps its own field check, so a child
  // whose completion still resolves the actor — an artifact declaring no
  // terminal kind, or a success terminal reached with an output that does
  // not prove success — is relayed rather than accepted as complete.
  it('relays a resolved CODE result that does not prove success', async () => {
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
