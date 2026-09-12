// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_OUTCOME_ACTION_TYPE } from '../../../src/accepted-outcome.js';
import {
  prMachine,
  type JsonValue,
  type PlaybookInput,
  type PlayerInput,
  type PlayerOutput,
  type PrContext,
  type ScriptInput,
  type ScriptOutput,
} from './pr.fsm.js';

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
  context: PrContext;
  event: unknown;
}

const PULL_REQUEST_URL = 'https://github.com/acme/widgets/pull/12';

const OPENED: PlayerOutput = {
  guard: 'opened',
  pullRequest: '12',
  pullRequestUrl: PULL_REQUEST_URL,
};

const CODE_COMPLETE = {
  status: 'complete',
  lastCodeCommit: 'fix123',
  finalEvaluatedRevision: 'fix-rev',
  allReviewsPassed: true,
} as const;

const INSUFFICIENT_CODE = {
  status: 'review-failed',
  lastCodeCommit: 'fix123',
  error: { name: 'Error', message: 'unsettled findings' },
} as const;

const CONTEXT: PrContext = {
  callerInput: 'Deliver the reviewed branch for issue #12.',
  pullRequest: '12',
  pullRequestUrl: PULL_REQUEST_URL,
};

const done = (output: unknown) => ({
  type: 'xstate.done.actor.worker',
  output,
});

const script = (guard: ScriptOutput['guard'], exitStatus: number): ScriptOutput =>
  ({ guard, exitStatus }) as ScriptOutput;

const authoredFailure = () =>
  Object.assign(new Error('code aborted.'), {
    result: { status: 'aborted', playbookId: 'code' },
  });

const pendingContext: PrContext = {
  ...CONTEXT,
  pendingBossQuestion: {
    questionId: 'openPullRequest',
    resumeStateId: 'openPullRequest',
    sourceItem: 'PR-1',
    asker: { kind: 'role', roleId: 'coder' },
    question: 'Which remote is the GitHub remote?',
  },
};

// One fixture per ordered script arm: the zero guard, the nonzero guard, and
// the fallback that a guard name inconsistent with its exit status reaches.
const scriptFixtures = (
  location: string,
  zeroGuard: ScriptOutput['guard'],
  zeroTarget: string,
  nonzeroGuard: ScriptOutput['guard'],
  nonzeroTarget: string,
): Record<string, readonly TransitionFixture[]> => ({
  [location]: [
    {
      guard: zeroGuard,
      target: zeroTarget,
      context: CONTEXT,
      event: done(script(zeroGuard, 0)),
    },
    {
      guard: nonzeroGuard,
      target: nonzeroTarget,
      context: CONTEXT,
      event: done(script(nonzeroGuard, 1)),
    },
    {
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: done(script(zeroGuard, 1)),
    },
  ],
});

const transitionFixtures: Record<string, readonly TransitionFixture[]> = {
  'openPullRequest.invoke.onDone': [
    {
      guard: 'isOpened',
      target: 'waitForChecks',
      context: CONTEXT,
      event: done(OPENED),
    },
    {
      guard: 'isNotPublished',
      target: 'notPublished',
      context: CONTEXT,
      event: done({
        guard: 'notPublished',
        coderOutput: 'The working tree is not clean; nothing was pushed.',
      }),
    },
    {
      guard: 'needsBossReply',
      target: 'awaitBossReply',
      context: CONTEXT,
      event: done({
        guard: 'needsBossReply',
        question: 'Which remote is the GitHub remote?',
      }),
    },
    {
      // An `opened` claim without the pull request URL supports no outcome
      // and must fall through to the malformed-output park.
      guard: '<fallback>',
      target: 'failed',
      context: CONTEXT,
      event: done({ guard: 'opened', pullRequest: '12' }),
    },
  ],
  ...scriptFixtures(
    'waitForChecks.invoke.onDone',
    'checksPassed',
    'mergePullRequest',
    'checksFailed',
    'fixChecks',
  ),
  'fixChecks.invoke.onDone': [
    {
      guard: 'isCodeSuccess',
      target: 'publishFix',
      context: CONTEXT,
      event: done(CODE_COMPLETE),
    },
    {
      guard: '<fallback>',
      target: 'fixFailed',
      context: CONTEXT,
      event: done(INSUFFICIENT_CODE),
    },
  ],
  'fixChecks.invoke.onError': [
    {
      guard: 'authoredCodeFailure',
      target: 'fixFailed',
      context: CONTEXT,
      event: { type: 'xstate.error.actor.code', error: authoredFailure() },
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
  ...scriptFixtures(
    'publishFix.invoke.onDone',
    'fixPublished',
    'waitForChecksAfterFix',
    'fixNotPublished',
    'fixNotPublished',
  ),
  ...scriptFixtures(
    'waitForChecksAfterFix.invoke.onDone',
    'checksPassed',
    'mergePullRequest',
    'checksStillFailing',
    'checksStillFailing',
  ),
  ...scriptFixtures(
    'mergePullRequest.invoke.onDone',
    'merged',
    'updateLocalDefault',
    'mergeRefused',
    'mergeRefused',
  ),
  ...scriptFixtures(
    'updateLocalDefault.invoke.onDone',
    'localDefaultUpdated',
    'merged',
    'localDefaultNotUpdated',
    'mergedLocalBehind',
  ),
  'awaitBossReply.on.BOSS_REPLY': [
    {
      guard: 'emptyBossReply',
      target: '#failed',
      context: pendingContext,
      event: { type: 'BOSS_REPLY', questionId: 'openPullRequest', answer: '  ' },
    },
    {
      guard: 'resumesOpenPullRequest',
      target: '#openPullRequest',
      context: pendingContext,
      event: {
        type: 'BOSS_REPLY',
        questionId: 'openPullRequest',
        answer: 'Use origin.',
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

// A script state's `onError` is one fallback object; ordered arms are arrays.
function armList(value: unknown): readonly RawTransition[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as readonly RawTransition[];
}

function createWorkflow(
  playerOutputs: readonly PlayerOutput[],
  childOutputs: readonly (JsonValue | Error | undefined)[],
  scriptOutputs: readonly ScriptOutput[],
) {
  const pendingPlayers = [...playerOutputs];
  const pendingChildren = [...childOutputs];
  const pendingScripts = [...scriptOutputs];
  const playerInputs: PlayerInput[] = [];
  const childInputs: PlaybookInput[] = [];
  const scriptInputs: ScriptInput[] = [];
  const machine = prMachine.provide({
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
      script: fromPromise<ScriptOutput, ScriptInput>(async ({ input }) => {
        scriptInputs.push(input);
        const output = pendingScripts.shift();
        if (output === undefined) throw new Error('missing script fixture');
        return output;
      }),
    },
  });
  const actor = createActor(machine, { input: {} });
  actor.start();
  return { actor, playerInputs, childInputs, scriptInputs };
}

const scriptSequence = (inputs: readonly ScriptInput[]) =>
  inputs.map(({ stateId, sourceItem }) => ({ stateId, sourceItem }));

const MERGED_OUTPUT = {
  status: 'merged',
  pullRequest: '12',
  pullRequestUrl: PULL_REQUEST_URL,
  localDefaultUpdated: true,
} as const;

describe('PR FSM transition coverage', () => {
  it('has one load-bearing fixture for every ordered transition arm', () => {
    const states = (prMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const actual = orderedTransitions(states);
    expect([...actual.keys()]).toEqual(Object.keys(transitionFixtures));

    const guards = prMachine.implementations.guards as unknown as Record<
      string,
      (
        args: { context: PrContext; event: unknown },
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
    const states = (prMachine as unknown as {
      config: { states: Record<string, RawState> };
    }).config.states;
    const onDone = states.openPullRequest?.invoke?.onDone;
    expect(Array.isArray(onDone)).toBe(true);
    const arms = onDone as readonly RawTransition[];
    expect(arms).toHaveLength(4);
    expect(arms.slice(0, -1).map((arm) => acceptedOutcomeMarkers(arm))).toEqual(
      [
        {
          source: 'openPullRequest',
          target: 'waitForChecks',
          acceptedOutcome: 'opened',
        },
        {
          source: 'openPullRequest',
          target: 'notPublished',
          acceptedOutcome: 'notPublished',
        },
        {
          source: 'openPullRequest',
          target: 'awaitBossReply',
          acceptedOutcome: 'needsBossReply',
        },
      ].map((marker) => [marker]),
    );
    expect(acceptedOutcomeMarkers(arms.at(-1)!)).toEqual([]);
    // Script states are not player calls and hold no governance boundary;
    // the nested call's outcome is the child's own.
    for (const stateId of [
      'waitForChecks',
      'fixChecks',
      'publishFix',
      'waitForChecksAfterFix',
      'mergePullRequest',
      'updateLocalDefault',
    ]) {
      for (const arm of [
        ...armList(states[stateId]?.invoke?.onDone),
        ...armList(states[stateId]?.invoke?.onError),
      ]) {
        expect(acceptedOutcomeMarkers(arm), stateId).toEqual([]);
      }
    }
  });

  it('merges when the checks pass and fast-forwards the local default branch', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [],
      [
        script('checksPassed', 0),
        script('merged', 0),
        script('localDefaultUpdated', 0),
      ],
    );
    workflow.actor.send({
      type: 'START_PR',
      callerInput: 'Deliver the reviewed branch for issue #12.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('merged');
    expect(snapshot.output).toEqual(MERGED_OUTPUT);
    expect(workflow.playerInputs).toHaveLength(1);
    expect(workflow.playerInputs[0]).toMatchObject({
      stateId: 'openPullRequest',
      role: 'coder',
      sourceItem: 'PR-1',
      callerInput: 'Deliver the reviewed branch for issue #12.',
    });
    expect(workflow.childInputs).toEqual([]);
    expect(scriptSequence(workflow.scriptInputs)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2' },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6' },
      { stateId: 'updateLocalDefault', sourceItem: 'PR-7' },
    ]);
    expect(workflow.scriptInputs.map(({ command }) => command)).toEqual([
      [
        'n=0',
        "while gh pr checks 2>&1 | grep -q 'no checks reported'; do",
        'n=$((n + 1))',
        '[ "$n" -ge 6 ] && exit 0',
        'sleep 10',
        'done',
        'gh pr checks --watch --fail-fast >/dev/null 2>&1',
      ].join('\n'),
      'gh pr merge --merge --delete-branch --match-head-commit "$(git rev-parse HEAD)"',
      'git pull --ff-only',
    ]);
  });

  it('reports a merged pull request whose local default branch stayed behind', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [],
      [
        script('checksPassed', 0),
        script('merged', 0),
        script('localDefaultNotUpdated', 1),
      ],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('mergedLocalBehind');
    expect(snapshot.output).toEqual({
      ...MERGED_OUTPUT,
      localDefaultUpdated: false,
    });
  });

  it('reports an unpublished branch with the Coder result and runs no script', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'notPublished',
          coderOutput: 'The push was rejected: the remote branch has newer commits.',
        },
      ],
      [],
      [],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('notPublished');
    expect(snapshot.output).toEqual({
      status: 'not-merged',
      reason: 'not-published',
      coderOutput: 'The push was rejected: the remote branch has newer commits.',
    });
    expect(workflow.scriptInputs).toEqual([]);
    expect(workflow.childInputs).toEqual([]);
  });

  it('fixes red checks once through CODE, republishes, waits again, and merges', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [CODE_COMPLETE],
      [
        script('checksFailed', 1),
        script('fixPublished', 0),
        script('checksPassed', 0),
        script('merged', 0),
        script('localDefaultUpdated', 0),
      ],
    );
    workflow.actor.send({
      type: 'START_PR',
      callerInput: 'Deliver the reviewed branch for issue #12.\nBranch: issue-12-fix-retry',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('merged');
    expect(snapshot.output).toEqual(MERGED_OUTPUT);
    expect(workflow.childInputs).toEqual([
      {
        stateId: 'fixChecks',
        sourceItem: 'PR-3',
        playbookId: 'code',
        text: [
          '> Original request: Deliver the reviewed branch for issue #12.',
          '> Branch: issue-12-fix-retry',
          `> Pull request: ${PULL_REQUEST_URL}`,
          "> Coding request: The pull request's checks are red on the checked-out branch. Inspect the failing checks with `gh pr checks` and `gh run view --log-failed`, fix their cause on this branch with a minimal change, and make the checks pass.",
        ].join('\n'),
      },
    ]);
    expect(scriptSequence(workflow.scriptInputs)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2' },
      { stateId: 'publishFix', sourceItem: 'PR-4' },
      { stateId: 'waitForChecksAfterFix', sourceItem: 'PR-5' },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6' },
      { stateId: 'updateLocalDefault', sourceItem: 'PR-7' },
    ]);
    // The two waits run one and the same command; only their guards differ.
    expect(workflow.scriptInputs[0]?.command).toBe(
      workflow.scriptInputs[2]?.command,
    );
    expect(Object.keys(workflow.scriptInputs[2]!.result)).toEqual([
      'checksPassed',
      'checksStillFailing',
    ]);
  });

  it('relays an authored CODE failure and leaves the pull request open', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [
        Object.assign(new Error('CODE failed.'), {
          result: {
            status: 'error',
            playbookId: 'code',
            error: { name: 'CodeError', message: 'review rejected the fix' },
          },
        }),
      ],
      [script('checksFailed', 1)],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('fixFailed');
    expect(snapshot.output).toEqual({
      status: 'not-merged',
      reason: 'fix-failed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      childResult: {
        playbookId: 'code',
        status: 'error',
        error: { name: 'CodeError', message: 'review rejected the fix' },
      },
    });
    expect(scriptSequence(workflow.scriptInputs)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2' },
    ]);
  });

  // DR-048: CODE's `reportedReviewFailure` is a declared failure terminal, so
  // the bridge rejects this caller's actor with the child's own public
  // result. PR recognizes the failure from that record — never from CODE's
  // output fields — and still relays the child's output.
  it('relays a CODE failure terminal delivered through the error path', async () => {
    const workflow = createWorkflow(
      [OPENED],
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
              output: INSUFFICIENT_CODE,
              terminal: {
                stateId: 'reportedReviewFailure',
                kind: 'failure',
                description: 'CODE reports the review failure.',
              },
            },
          },
        ),
      ],
      [script('checksFailed', 1)],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('fixFailed');
    expect(snapshot.output).toEqual({
      status: 'not-merged',
      reason: 'fix-failed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      childResult: { playbookId: 'code', status: 'ok', output: INSUFFICIENT_CODE },
    });
  });

  // Belt and braces: the resolved path keeps its own field check, so a child
  // whose completion still resolves the actor without proving success is
  // relayed rather than published as a fix.
  it('relays a resolved CODE result that does not prove success', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [INSUFFICIENT_CODE],
      [script('checksFailed', 1)],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('fixFailed');
    expect(snapshot.output).toEqual({
      status: 'not-merged',
      reason: 'fix-failed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      childResult: { playbookId: 'code', status: 'ok', output: INSUFFICIENT_CODE },
    });
    expect(workflow.scriptInputs).toHaveLength(1);
  });

  it('reports a fix that could not be published', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [CODE_COMPLETE],
      [script('checksFailed', 1), script('fixNotPublished', 1)],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('fixNotPublished');
    expect(snapshot.output).toEqual({
      status: 'not-merged',
      reason: 'fix-not-published',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
  });

  it('reports checks still failing after the one fix attempt without a second CODE call', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [CODE_COMPLETE],
      [
        script('checksFailed', 1),
        script('fixPublished', 0),
        script('checksStillFailing', 1),
      ],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('checksStillFailing');
    expect(snapshot.output).toEqual({
      status: 'not-merged',
      reason: 'checks-failed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    expect(workflow.childInputs).toHaveLength(1);
    expect(scriptSequence(workflow.scriptInputs)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2' },
      { stateId: 'publishFix', sourceItem: 'PR-4' },
      { stateId: 'waitForChecksAfterFix', sourceItem: 'PR-5' },
    ]);
  });

  it('reports a refused merge', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [],
      [script('checksPassed', 0), script('mergeRefused', 1)],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('mergeRefused');
    expect(snapshot.output).toEqual({
      status: 'not-merged',
      reason: 'merge-refused',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    expect(scriptSequence(workflow.scriptInputs)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2' },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6' },
    ]);
  });

  it('parks for a Boss reply and resumes the publication with the answer', async () => {
    const workflow = createWorkflow(
      [
        { guard: 'needsBossReply', question: 'Which remote is the GitHub remote?' },
        OPENED,
      ],
      [],
      [
        script('checksPassed', 0),
        script('merged', 0),
        script('localDefaultUpdated', 0),
      ],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    await waitFor(workflow.actor, (value) => value.matches('awaitBossReply'));
    const parked = workflow.actor.getSnapshot();
    expect(parked.context.pendingBossQuestion).toEqual({
      questionId: 'openPullRequest',
      resumeStateId: 'openPullRequest',
      sourceItem: 'PR-1',
      asker: { kind: 'role', roleId: 'coder' },
      question: 'Which remote is the GitHub remote?',
    });
    expect(workflow.scriptInputs).toEqual([]);
    workflow.actor.send({
      type: 'BOSS_REPLY',
      questionId: 'openPullRequest',
      answer: 'Use origin.',
    });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.value).toBe('merged');
    expect(snapshot.output).toEqual(MERGED_OUTPUT);
    expect(workflow.playerInputs).toHaveLength(2);
    expect(workflow.playerInputs[1]?.pendingBossQuestion?.question).toBe(
      'Which remote is the GitHub remote?',
    );
    expect(workflow.playerInputs[1]?.bossReply).toBe('Use origin.');
    // The consumed question and reply do not survive the accepted outcome.
    expect(snapshot.context.pendingBossQuestion).toBeUndefined();
    expect(snapshot.context.bossReply).toBeUndefined();
  });

  it('parks recoverably on a nested-call control-plane failure', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [new Error('bridge failure')],
      [script('checksFailed', 1)],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(snapshot.context.lastError).toBeInstanceOf(Error);
    expect(snapshot.context.completion).toBeUndefined();
  });

  it('parks a script result that names no declared outcome', async () => {
    const workflow = createWorkflow(
      [OPENED],
      [],
      [script('checksPassed', 2)],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(String(snapshot.context.lastError)).toContain(
      'Script result for PR-2 did not match a declared outcome.',
    );
    expect(snapshot.context.completion).toBeUndefined();
  });

  it('parks a Coder result that matches no available outcome', async () => {
    const workflow = createWorkflow(
      [{ guard: 'opened', pullRequest: '12' } as unknown as PlayerOutput],
      [],
      [],
    );
    workflow.actor.send({ type: 'START_PR', callerInput: 'Deliver it.' });
    const snapshot = await waitFor(workflow.actor, (value) =>
      value.matches('failed'),
    );
    expect(snapshot.status).toBe('active');
    expect(String(snapshot.context.lastError)).toContain(
      'did not match an available outcome',
    );
    expect(workflow.scriptInputs).toEqual([]);
  });
});
