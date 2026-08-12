// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGearsContract } from '../../../scripts/check-slc-source-gears.mjs';
import {
  concurrentRoleSets,
  decideMachine,
  type DecideContext,
  type PlayerInput,
  type PlaybookInput,
} from './decide.fsm.js';
import decideRegistry, { validateDecideOptions } from './decide.registry.js';

interface RawInvoke {
  src?: unknown;
  input?: (args: { context: DecideContext }) => PlayerInput | PlaybookInput;
  onDone?: RawTransition | readonly RawTransition[];
  onError?: RawTransition | readonly RawTransition[];
}

interface RawState {
  id?: string;
  type?: string;
  initial?: string;
  description?: string;
  tags?: string | readonly string[];
  meta?: unknown;
  states?: Record<string, RawState>;
  invoke?: RawInvoke;
  onDone?: RawTransition | readonly RawTransition[];
  on?: Record<string, RawTransition | readonly RawTransition[]>;
}

interface RawTransition {
  guard?: unknown;
  target?: unknown;
  actions?: unknown;
}

interface TransitionFixture {
  guard: string;
  target: string;
  context: DecideContext;
  event: unknown;
}

const sourceText = readFileSync(new URL('../decide.md', import.meta.url), 'utf8');
const gearsText = readFileSync(
  new URL('./decide.gears.md', import.meta.url),
  'utf8',
);
const gears = parseGearsContract(gearsText);
const byId = new Map(gears.map((item) => [item.id, item]));
const machineConfig = (
  decideMachine as unknown as { config: RawState & { states: Record<string, RawState> } }
).config;
const states = machineConfig.states;

const CONTEXT: DecideContext = {
  callerTopic: 'Choose a durable design.',
  coderProposal: 'Coder proposes package items.',
  reviewerProposal: 'Reviewer proposes one DR.',
  latestCommit: 'abc123',
};

const NEEDS_BOSS_REPLY_DESCRIPTION =
  "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

const done = (output: unknown) => ({
  type: 'xstate.done.actor.worker',
  output,
});

const actorDoneFixtures = (
  successGuard: string,
  successTarget: string,
  successOutput: unknown,
  questionTarget: string,
  failureTarget: string,
): readonly TransitionFixture[] => [
  {
    guard: 'needsBossReplyWithQuestion',
    target: questionTarget,
    context: CONTEXT,
    event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
  },
  {
    guard: 'needsBossReplyWithoutQuestion',
    target: failureTarget,
    context: CONTEXT,
    event: done({ guard: 'needsBossReply', question: '  ' }),
  },
  {
    guard: successGuard,
    target: successTarget,
    context: CONTEXT,
    event: done(successOutput),
  },
  {
    guard: '<fallback>',
    target: failureTarget,
    context: CONTEXT,
    event: done({ guard: successGuard }),
  },
];

const pendingContext = (
  stateId: 'askCoderProposal' | 'askReviewerProposal' | 'commitCoderProposal',
  sourceItem: 'DECIDE-1' | 'DECIDE-2' | 'DECIDE-3',
  roleId: 'coder' | 'reviewer',
): DecideContext => ({
  ...CONTEXT,
  pendingBossQuestions: {
    [stateId]: {
      questionId: stateId,
      resumeStateId: stateId,
      sourceItem,
      asker: { kind: 'role', roleId },
      question: 'Which scope?',
    },
  },
});

const bossReplyFixtures = (
  stateId: 'askCoderProposal' | 'askReviewerProposal' | 'commitCoderProposal',
  sourceItem: 'DECIDE-1' | 'DECIDE-2' | 'DECIDE-3',
  roleId: 'coder' | 'reviewer',
  emptyTarget: string,
  answerTarget: string,
): readonly TransitionFixture[] => {
  const pending = pendingContext(stateId, sourceItem, roleId);
  return [
    {
      guard: '<inline>',
      target: emptyTarget,
      context: pending,
      event: { type: 'BOSS_REPLY', questionId: stateId, answer: '  ' },
    },
    {
      guard: '<inline>',
      target: answerTarget,
      context: pending,
      event: { type: 'BOSS_REPLY', questionId: stateId, answer: 'Answer' },
    },
  ];
};

const authoredFailure = Object.assign(new Error('REVIEW aborted'), {
  result: { status: 'aborted', playbookId: 'review' },
});

const transitionFixtures: Record<string, readonly TransitionFixture[]> = {
  'root.on.BOSS_INTERRUPT': [
    {
      guard: '<inline>',
      target: '#independentProposals',
      context: CONTEXT,
      event: {
        type: 'BOSS_INTERRUPT',
        targetId: 'independentProposals',
        bossIntent: 'Reconsider this topic.',
      },
    },
  ],
  'independentProposals.coder.working.invoke.onDone': actorDoneFixtures(
    'coderProposed',
    'complete',
    { guard: 'proposed', coderProposal: 'Coder proposal' },
    'waiting',
    '#failed',
  ),
  'independentProposals.coder.waiting.on.BOSS_REPLY': bossReplyFixtures(
    'askCoderProposal',
    'DECIDE-1',
    'coder',
    '#failed',
    'working',
  ),
  'independentProposals.reviewer.working.invoke.onDone': actorDoneFixtures(
    'reviewerProposed',
    'complete',
    { guard: 'proposed', reviewerProposal: 'Reviewer proposal' },
    'waiting',
    '#failed',
  ),
  'independentProposals.reviewer.waiting.on.BOSS_REPLY': bossReplyFixtures(
    'askReviewerProposal',
    'DECIDE-2',
    'reviewer',
    '#failed',
    'working',
  ),
  'commitCoderProposal.invoke.onDone': actorDoneFixtures(
    'committed',
    'reviewCommit',
    {
      guard: 'committed',
      coderOutput: 'Committed proposal.\nCommit: abc123',
      latestCommit: 'abc123',
    },
    'awaitBossReply',
    'failed',
  ),
  'awaitBossReply.on.BOSS_REPLY': bossReplyFixtures(
    'commitCoderProposal',
    'DECIDE-3',
    'coder',
    'failed',
    '#commitCoderProposal',
  ),
  'reviewCommit.invoke.onDone': [
    {
      guard: 'validReviewSuccess',
      target: 'done',
      context: CONTEXT,
      event: done({ approvedCommit: 'latest', noUnsettledFindings: true }),
    },
    {
      guard: '<fallback>',
      target: 'reportedReviewFailure',
      context: CONTEXT,
      event: done({ approvedCommit: 'abc123', noUnsettledFindings: true }),
    },
  ],
  'reviewCommit.invoke.onError': [
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
        error: new Error('unstructured failure'),
      },
    },
  ],
};

const expectedPlayerStates = [
  {
    path: 'independentProposals.coder.working',
    stateId: 'askCoderProposal',
    sourceItem: 'DECIDE-1',
  },
  {
    path: 'independentProposals.reviewer.working',
    stateId: 'askReviewerProposal',
    sourceItem: 'DECIDE-2',
  },
  {
    path: 'commitCoderProposal',
    stateId: 'commitCoderProposal',
    sourceItem: 'DECIDE-3',
  },
] as const;

function stateAt(path: string): RawState | undefined {
  const parts = path.split('.');
  let current: RawState | undefined = { states };
  for (const part of parts) current = current?.states?.[part];
  return current;
}

function invokedStates(
  current: Record<string, RawState>,
  parent = '',
): Array<{ path: string; state: RawState; input: PlayerInput | PlaybookInput }> {
  return Object.entries(current).flatMap(([key, state]) => {
    const path = parent === '' ? key : `${parent}.${key}`;
    const own = state.invoke?.input?.({ context: CONTEXT });
    return [
      ...(own === undefined ? [] : [{ path, state, input: own }]),
      ...invokedStates(state.states ?? {}, path),
    ];
  });
}

function tagsOf(state: RawState): readonly string[] {
  return typeof state.tags === 'string' ? [state.tags] : (state.tags ?? []);
}

function orderedTransitions(
  state: RawState,
  path: string,
): Map<string, readonly RawTransition[]> {
  const found = new Map<string, readonly RawTransition[]>();
  if (Array.isArray(state.invoke?.onDone)) {
    found.set(`${path}.invoke.onDone`, state.invoke.onDone);
  }
  if (Array.isArray(state.invoke?.onError)) {
    found.set(`${path}.invoke.onError`, state.invoke.onError);
  }
  if (Array.isArray(state.onDone)) {
    found.set(`${path}.onDone`, state.onDone);
  }
  for (const [event, transitions] of Object.entries(state.on ?? {})) {
    if (Array.isArray(transitions)) {
      found.set(`${path}.on.${event}`, transitions);
    }
  }
  for (const [key, nested] of Object.entries(state.states ?? {})) {
    const nestedPath = path === 'root' ? key : `${path}.${key}`;
    for (const [location, transitions] of orderedTransitions(
      nested,
      nestedPath,
    )) {
      found.set(location, transitions);
    }
  }
  return found;
}

function guardKey(guard: unknown): string {
  if (guard === undefined) return '<fallback>';
  if (typeof guard === 'string') return guard;
  if (typeof guard === 'function') return '<inline>';
  if (typeof guard === 'object' && guard !== null) {
    const type = (guard as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return '<unknown>';
}

function evaluateGuard(
  guard: unknown,
  fixture: TransitionFixture,
): boolean {
  if (guard === undefined) return true;
  if (typeof guard === 'function') {
    return Boolean(
      (guard as (
        args: { context: DecideContext; event: unknown },
        params: unknown,
      ) => boolean)(
        { context: fixture.context, event: fixture.event },
        undefined,
      ),
    );
  }
  const name = guardKey(guard);
  const implementations = decideMachine.implementations.guards as unknown as Record<
    string,
    (
      args: { context: DecideContext; event: unknown },
      params: unknown,
    ) => boolean
  >;
  return implementations[name](
    { context: fixture.context, event: fixture.event },
    undefined,
  );
}

describe('DECIDE GEARS to FSM compilation', () => {
  it('declares local roles without source-level player bindings', () => {
    expect(sourceText).toContain('\nRoles:\n\n- Coder\n- Reviewer\n');
    expect(sourceText).not.toContain('\nPlayers:\n');
    expect(gearsText).toContain('\n## Roles\n\n- Coder\n- Reviewer\n');
    expect(gearsText).not.toContain('\n## Players\n');
  });

  it('advertises its schema-2 roles and parallel constraint', () => {
    expect(concurrentRoleSets).toEqual([['coder', 'reviewer']]);
    expect(decideRegistry).toMatchObject({
      id: 'decide',
      command: 'decide',
      artifactSchema: 2,
      requiredRoleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [['coder', 'reviewer']],
    });
    expect(decideRegistry.concurrentRoleSets).toEqual(concurrentRoleSets);
    const options = validateDecideOptions(undefined);
    expect(options).toEqual({});
    expect(typeof decideRegistry.createRuntime(options).init).toBe('function');
    expect(() => validateDecideOptions({ coderLlm: 'stale' })).toThrow(
      'captain.options.playbooks.decide.options.coderLlm',
    );
  });

  it('maps exactly DECIDE-1 through DECIDE-4 to the declared actor topology', () => {
    expect(gears.map(({ id }) => id)).toEqual([
      'DECIDE-1',
      'DECIDE-2',
      'DECIDE-3',
      'DECIDE-4',
    ]);

    const invocations = invokedStates(states);
    expect(
      invocations.map(({ path, state, input }) => ({
        path,
        actor: state.invoke?.src,
        sourceItem: input.sourceItem,
      })),
    ).toEqual([
      {
        path: 'independentProposals.coder.working',
        actor: 'player',
        sourceItem: 'DECIDE-1',
      },
      {
        path: 'independentProposals.reviewer.working',
        actor: 'player',
        sourceItem: 'DECIDE-2',
      },
      {
        path: 'commitCoderProposal',
        actor: 'player',
        sourceItem: 'DECIDE-3',
      },
      {
        path: 'reviewCommit',
        actor: 'playbook',
        sourceItem: 'DECIDE-4',
      },
    ]);

    const parallel = states.independentProposals;
    expect(parallel?.id).toBe('independentProposals');
    expect(parallel?.type).toBe('parallel');
    expect(Object.keys(parallel?.states ?? {})).toEqual(['coder', 'reviewer']);
    expect(parallel?.states?.coder?.initial).toBe('working');
    expect(parallel?.states?.reviewer?.initial).toBe('working');
    expect(parallel?.states?.coder?.states?.complete?.type).toBe('final');
    expect(parallel?.states?.reviewer?.states?.complete?.type).toBe('final');
    expect(
      Array.isArray(parallel?.onDone) ? undefined : parallel?.onDone?.target,
    ).toBe('commitCoderProposal');
  });

  it('preserves each delegated role, prompt, and result contract exactly', () => {
    for (const expected of expectedPlayerStates) {
      const item = byId.get(expected.sourceItem);
      const state = stateAt(expected.path);
      const input = state?.invoke?.input?.({ context: CONTEXT });
      expect(input, expected.path).toBeDefined();
      expect(item?.player, expected.sourceItem).toBeDefined();
      expect(input).toMatchObject({
        stateId: expected.stateId,
        sourceItem: expected.sourceItem,
        role: item?.player?.toLowerCase(),
      });
      expect('prompt' in (input ?? {}) ? input.prompt : undefined).toBe(
        item?.prompt.join('\n'),
      );
      expect('result' in (input ?? {}) ? Object.entries(input.result) : []).toEqual([
        ...(item?.results.map(
          ({ guard, description }) => [guard, description] as const,
        ) ?? []),
        ['needsBossReply', NEEDS_BOSS_REPLY_DESCRIPTION],
      ]);
      expect(tagsOf(state ?? {})).toContain('playbook.busy');
      expect(state?.meta).toEqual({
        playbook: {
          stateId: expected.stateId,
          description: state?.description,
          role: item?.player?.toLowerCase(),
        },
      });
    }
  });

  it('composes DECIDE-4 as the literal REVIEW call after the parallel join', () => {
    const state = states.reviewCommit;
    const input = state?.invoke?.input?.({ context: CONTEXT });
    expect(input).toEqual({
      stateId: 'reviewCommit',
      sourceItem: 'DECIDE-4',
      playbookId: 'review',
      text: byId
        .get('DECIDE-4')
        ?.prompt.join('\n')
        .replaceAll('<caller-topic>', CONTEXT.callerTopic ?? '')
        .replaceAll('<coder-proposal>', CONTEXT.coderProposal ?? ''),
    });
    expect(tagsOf(state ?? {})).toContain('playbook.suspended');
    expect(state?.meta).toEqual({
      playbook: {
        stateId: 'reviewCommit',
        description: state?.description,
      },
    });
  });

  it('pins every authored post-REVIEW outcome to its compiled route', () => {
    for (const clause of [
      'When `review` returns an authored abort or failure, or a terminal result that does not prove exact approval, `decide` shall report the failure and the last `decide`-owned commit to its caller.',
      'When the nested `review` call fails outside that authored result contract, `decide` shall park as failed and retain the control-plane error instead of reporting an authored review outcome.',
    ]) {
      expect(sourceText).toContain(clause);
    }
    const reviewSection = gearsText.slice(gearsText.indexOf('### DECIDE-4'));
    expect(reviewSection).toContain(
      'An authored child abort, failure, or invalid approval terminates with the failure and `latestCommit` reported to the caller.',
    );
    expect(reviewSection).toContain(
      'Any other nested-call error parks `decide` as failed and retains the control-plane error.',
    );

    const review = states.reviewCommit?.invoke;
    const route = (transition: RawTransition | undefined) => ({
      guard: guardKey(transition?.guard),
      target: transition?.target,
      actions: transition?.actions,
    });
    expect({
      approved: route(
        Array.isArray(review?.onDone) ? review.onDone[0] : review?.onDone,
      ),
      invalid: route(Array.isArray(review?.onDone) ? review.onDone[1] : undefined),
      authoredFailure: route(
        Array.isArray(review?.onError) ? review.onError[0] : review?.onError,
      ),
      controlFailure: route(
        Array.isArray(review?.onError) ? review.onError[1] : undefined,
      ),
    }).toEqual({
      approved: {
        guard: 'validReviewSuccess',
        target: 'done',
        actions: 'rememberReviewSuccess',
      },
      invalid: {
        guard: '<fallback>',
        target: 'reportedReviewFailure',
        actions: 'rememberReviewProtocolFailure',
      },
      authoredFailure: {
        guard: 'authoredReviewFailure',
        target: 'reportedReviewFailure',
        actions: 'rememberReviewFailure',
      },
      controlFailure: {
        guard: '<fallback>',
        target: 'failed',
        actions: 'rememberActorError',
      },
    });
  });

  it('has one load-bearing fixture for every ordered transition arm', () => {
    const actual = orderedTransitions(machineConfig, 'root');
    expect([...actual.keys()]).toEqual(Object.keys(transitionFixtures));

    for (const [location, fixtures] of Object.entries(transitionFixtures)) {
      const arms = actual.get(location) ?? [];
      expect(
        arms.map((arm) => ({
          guard: guardKey(arm.guard),
          target: arm.target,
        })),
        location,
      ).toEqual(fixtures.map(({ guard, target }) => ({ guard, target })));

      fixtures.forEach((fixture, index) => {
        expect(
          arms
            .slice(0, index + 1)
            .map((arm) => evaluateGuard(arm.guard, fixture)),
          `${location}[${index}]`,
        ).toEqual([
          ...Array.from({ length: index }, () => false),
          true,
        ]);
      });
    }
  });

  it('rejects a textless control-action probe without throwing', () => {
    const interrupt = orderedTransitions(machineConfig, 'root').get(
      'root.on.BOSS_INTERRUPT',
    )?.[0];
    expect(interrupt).toBeDefined();
    expect(
      evaluateGuard(interrupt?.guard, {
        guard: '<inline>',
        target: '#independentProposals',
        context: CONTEXT,
        event: {
          type: 'BOSS_INTERRUPT',
          targetId: 'independentProposals',
        },
      }),
    ).toBe(false);
  });
});
