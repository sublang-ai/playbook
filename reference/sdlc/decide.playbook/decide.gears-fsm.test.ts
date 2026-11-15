// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createActor, fromPromise, waitFor } from 'xstate';

import {
  gearsActionItems,
  gearsItemBodies,
  gearsItemFor,
} from '../../../scripts/check-slc-source-gears.mjs';
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
// DR-108: the action items are the ones a machine state cites; the
// requirement and test items carry no prompt.
const gears = gearsActionItems(gearsText);
const byId = new Map(gears.map((item) => [item.id, item]));
const itemBodies = gearsItemBodies(gearsText);
const machineConfig = (
  decideMachine as unknown as { config: RawState & { states: Record<string, RawState> } }
).config;
const states = machineConfig.states;

// The compiled context is typed and total: every field has its `''`,
// `false`, `null`, or empty-record default rather than being optional.
const CONTEXT: DecideContext = {
  callerTopic: 'Choose a durable design.',
  stagedCoderProposal: '',
  stagedReviewerProposal: '',
  coderProposal: 'Coder proposes package items.',
  reviewerProposal: 'Reviewer proposes one DR.',
  coderOutput: 'Committed the synthesized design.',
  decideCommit: 'abc123',
  evaluatedRevision: '',
  reviewStatus: null,
  reviewError: null,
  reviewEvidence: null,
  lastError: null,
  pendingBossQuestions: {},
  bossReplies: {},
};

const NEEDS_BOSS_REPLY_DESCRIPTION =
  "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

const done = (output: unknown) => ({
  type: 'xstate.done.actor.worker',
  output,
});

// A question suspends the branch before any proposal arm is read; a proposal
// branch finishing after its sibling has staged completes the join, so its
// arm precedes the plain staging arm and marks `synthesizeCommit` as target.
const proposalDoneFixtures = (
  joiningGuard: string,
  successGuard: string,
  stagedTarget: string,
  successOutput: unknown,
  siblingStaged: Partial<DecideContext>,
  questionTarget: string,
  fallbackOutput: unknown,
): readonly TransitionFixture[] => [
  {
    guard: 'needsBossReply',
    target: questionTarget,
    context: CONTEXT,
    event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
  },
  {
    guard: joiningGuard,
    target: stagedTarget,
    context: { ...CONTEXT, ...siblingStaged },
    event: done(successOutput),
  },
  {
    guard: successGuard,
    target: stagedTarget,
    context: CONTEXT,
    event: done(successOutput),
  },
  {
    guard: '<fallback>',
    target: '#failed',
    context: CONTEXT,
    event: done(fallbackOutput),
  },
];

const pendingContext = (
  stateId: 'askCoderProposal' | 'askReviewerProposal' | 'synthesizeCommit',
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
  stateId: 'askCoderProposal' | 'askReviewerProposal' | 'synthesizeCommit',
  sourceItem: 'DECIDE-1' | 'DECIDE-2' | 'DECIDE-3',
  roleId: 'coder' | 'reviewer',
): readonly TransitionFixture[] => {
  const pending = pendingContext(stateId, sourceItem, roleId);
  return [
    {
      guard: 'bossReplyIsEmpty',
      target: '#failed',
      context: pending,
      event: { type: 'BOSS_REPLY', questionId: stateId, answer: '  ' },
    },
    {
      guard: 'bossReplyResumes',
      target: `#${stateId}`,
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
      guard: 'interruptTargets',
      target: '#independentProposals',
      context: CONTEXT,
      event: {
        type: 'BOSS_INTERRUPT',
        targetId: 'independentProposals',
        callerTopic: 'Reconsider this topic.',
      },
    },
    {
      // Synthesis restarts from the promoted proposals under the same topic.
      guard: 'interruptTargets',
      target: '#synthesizeCommit',
      context: CONTEXT,
      event: { type: 'BOSS_INTERRUPT', targetId: 'synthesizeCommit' },
    },
  ],
  'independentProposals.coderProposalRegion.askCoderProposal.invoke.onDone':
    proposalDoneFixtures(
      'coderProposedJoining',
      'coderProposed',
      'coderProposalStaged',
      // DECIDE-1 declares `coderProposal`, which DECIDE-4 relays to `review`.
      { guard: 'proposed', coderProposal: 'Coder proposal' },
      { stagedReviewerProposal: 'Reviewer proposal' },
      '#awaitCoderProposalReply',
      { guard: 'needsBossReply', question: '  ' },
    ),
  'independentProposals.coderProposalRegion.awaitCoderProposalReply.on.BOSS_REPLY':
    bossReplyFixtures('askCoderProposal', 'DECIDE-1', 'coder'),
  'independentProposals.reviewerProposalRegion.askReviewerProposal.invoke.onDone':
    proposalDoneFixtures(
      'reviewerProposedJoining',
      'reviewerProposed',
      'reviewerProposalStaged',
      { guard: 'proposed', reviewerProposal: 'Reviewer proposal' },
      { stagedCoderProposal: 'Coder proposal' },
      '#awaitReviewerProposalReply',
      { guard: 'proposed' },
    ),
  'independentProposals.reviewerProposalRegion.awaitReviewerProposalReply.on.BOSS_REPLY':
    bossReplyFixtures('askReviewerProposal', 'DECIDE-2', 'reviewer'),
  'synthesizeCommit.invoke.onDone': [
    {
      guard: 'needsBossReply',
      target: '#awaitBossReply',
      context: CONTEXT,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
    {
      guard: 'committed',
      target: 'reviewCommit',
      context: CONTEXT,
      event: done({
        guard: 'committed',
        coderOutput: 'Committed proposal.',
        latestCommit: 'abc123',
      }),
    },
    {
      guard: '<fallback>',
      target: '#failed',
      context: CONTEXT,
      event: done({ guard: 'committed' }),
    },
  ],
  'awaitBossReply.on.BOSS_REPLY': [
    {
      // The root wait fails a reply naming no pending question before any
      // resume arm can read it.
      guard: 'bossReplyNamesNoPendingQuestion',
      target: '#failed',
      context: pendingContext('synthesizeCommit', 'DECIDE-3', 'coder'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'askCoderProposal',
        answer: 'Answer',
      },
    },
    ...bossReplyFixtures('synthesizeCommit', 'DECIDE-3', 'coder'),
  ],
  'reviewCommit.invoke.onDone': [
    {
      guard: 'reviewApproved',
      target: 'done',
      context: CONTEXT,
      event: done({ evaluatedRevision: 'def456', noUnsettledFindings: true }),
    },
    {
      // The retired approved-latest shape gives no evaluated revision, so it
      // no longer establishes the completion facts.
      guard: '<fallback>',
      target: 'reportedReviewFailure',
      context: CONTEXT,
      event: done({ approvedCommit: 'latest', noUnsettledFindings: true }),
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
    path: 'independentProposals.coderProposalRegion.askCoderProposal',
    stateId: 'askCoderProposal',
    sourceItem: 'DECIDE-1',
  },
  {
    path: 'independentProposals.reviewerProposalRegion.askReviewerProposal',
    stateId: 'askReviewerProposal',
    sourceItem: 'DECIDE-2',
  },
  {
    path: 'synthesizeCommit',
    stateId: 'synthesizeCommit',
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
  // Parameterized compiled guards carry their params on the arm.
  const params =
    typeof guard === 'object' && guard !== null
      ? (guard as { params?: unknown }).params
      : undefined;
  return implementations[name](
    { context: fixture.context, event: fixture.event },
    params,
  );
}

describe('DECIDE GEARS to FSM compilation', () => {
  it('declares local roles without source-level player bindings', () => {
    expect(sourceText).toContain('\nRoles:\n\n- Coder\n- Reviewer\n');
    expect(sourceText).not.toContain('\nPlayers:\n');
    expect(gearsText).toContain('\nRoles:\n\n- Coder\n- Reviewer\n');
    expect(gearsText).not.toContain('\n## Players\n');
  });

  it('advertises its schema-3 roles and parallel constraint', () => {
    expect(concurrentRoleSets).toEqual([['coder', 'reviewer']]);
    expect(decideRegistry).toMatchObject({
      id: 'decide',
      command: 'decide',
      artifactSchema: 3,
      runtimeProfile: {
        kind: 'shared-factory',
        compat: { artifactSchema: 3, runtimeAbi: 1 },
      },
      requiredRoleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [['coder', 'reviewer']],
    });
    expect(decideRegistry.concurrentRoleSets).toEqual(concurrentRoleSets);
    const options = validateDecideOptions(undefined);
    expect(options).toEqual({});
    expect(decideRegistry.createRuntime).toHaveLength(2);
    expect(() => validateDecideOptions({ coderLlm: 'stale' })).toThrow(
      'captain.options.playbooks.decide.options.coderLlm',
    );
  });

  it('retires the Commit response marker from every authored prompt', () => {
    const retired =
      'Include exactly one final-response line beginning `Commit: `';
    expect(sourceText).not.toContain(retired);
    expect(gearsText).not.toContain(retired);
    for (const { input } of invokedStates(states)) {
      if ('prompt' in input) expect(input.prompt).not.toContain(retired);
    }
  });

  it('maps exactly DECIDE-1 through DECIDE-4 to the declared actor topology', () => {
    expect(gears.map(({ id }) => id)).toEqual([
      'decide-1',
      'decide-2',
      'decide-3',
      'decide-4',
    ]);
    // Every other item is a requirement or test item: no prompt, no result
    // contract.
    for (const { id, body } of itemBodies) {
      if (byId.has(id)) continue;
      expect(body, id).not.toMatch(/^>/m);
      expect(body, id).not.toMatch(/^Results:/m);
    }

    const invocations = invokedStates(states);
    expect(
      invocations.map(({ path, state, input }) => ({
        path,
        actor: state.invoke?.src,
        sourceItem: input.sourceItem,
      })),
    ).toEqual([
      {
        path: 'independentProposals.coderProposalRegion.askCoderProposal',
        actor: 'player',
        sourceItem: 'DECIDE-1',
      },
      {
        path: 'independentProposals.reviewerProposalRegion.askReviewerProposal',
        actor: 'player',
        sourceItem: 'DECIDE-2',
      },
      {
        path: 'synthesizeCommit',
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
    expect(Object.keys(parallel?.states ?? {})).toEqual([
      'coderProposalRegion',
      'reviewerProposalRegion',
    ]);
    const coderRegion = parallel?.states?.coderProposalRegion;
    const reviewerRegion = parallel?.states?.reviewerProposalRegion;
    expect(coderRegion?.initial).toBe('askCoderProposal');
    expect(reviewerRegion?.initial).toBe('askReviewerProposal');
    expect(Object.keys(coderRegion?.states ?? {})).toEqual([
      'askCoderProposal',
      'awaitCoderProposalReply',
      'coderProposalStaged',
    ]);
    expect(Object.keys(reviewerRegion?.states ?? {})).toEqual([
      'askReviewerProposal',
      'awaitReviewerProposalReply',
      'reviewerProposalStaged',
    ]);
    expect(coderRegion?.states?.coderProposalStaged?.type).toBe('final');
    expect(reviewerRegion?.states?.reviewerProposalStaged?.type).toBe('final');
    expect(
      Array.isArray(parallel?.onDone) ? undefined : parallel?.onDone,
    ).toEqual({ target: 'synthesizeCommit', actions: 'promoteProposals' });
  });

  it('preserves each delegated role, prompt, and result contract exactly', () => {
    for (const expected of expectedPlayerStates) {
      // A state cites its item ignoring ASCII letter case (DR-108 §4).
      const item = gearsItemFor(gears, expected.sourceItem);
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
        .get('decide-4')
        ?.prompt.join('\n')
        .replaceAll('<caller-topic>', CONTEXT.callerTopic)
        .replaceAll('<decide-commit>', CONTEXT.decideCommit)
        .replaceAll('<coder-proposal>', CONTEXT.coderProposal)
        .replaceAll('<coder-output>', CONTEXT.coderOutput),
    });
    expect(input && 'text' in input ? input.text : '').toContain(
      "> Coder's independent proposal: Coder proposes package items.",
    );
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
      '`decide` is complete only when `review` returns a result that applies to the supplied review scope, gives the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.',
      'It then returns the `decide`-owned commit and that evaluated revision to its caller.',
      'When `review` returns an authored abort or failure, or a terminal result that does not establish those facts, `decide` shall report the failure and the last `decide`-owned commit to its caller.',
      'When the nested `review` call fails outside that authored result contract, `decide` shall park as failed and retain the control-plane error instead of reporting an authored review outcome.',
    ]) {
      expect(sourceText).toContain(clause);
    }
    // DR-108: each post-REVIEW outcome is a requirement item of its own.
    const itemBody = (id: string) => {
      const item = itemBodies.find((candidate) => candidate.id === id);
      expect(item, id).toBeDefined();
      return item?.body ?? '';
    };
    expect(itemBody('decide-6')).toContain(
      '`decide` shall complete, returning to its caller the `decide`-owned commit [[decide-14](#decide-14)] and the evaluated repository revision, only when `review` returns a result [[decide-4](#decide-4)] that:\n\n- applies to the supplied review scope;\n- gives the exact evaluated repository revision;\n- affirmatively establishes that no unsettled findings remain.',
    );
    expect(itemBody('decide-7')).toContain(
      'When `review` [[decide-4](#decide-4)] returns an authored abort or failure, or a terminal result that leaves unestablished any fact that completion requires [[decide-6](#decide-6)], `decide` shall report the failure and the last `decide`-owned commit [[decide-14](#decide-14)] to its caller.',
    );
    expect(itemBody('decide-8')).toContain(
      'When the nested `review` call [[decide-4](#decide-4)] fails outside its authored result contract, `decide` shall park as failed and retain the control-plane error instead of reporting an authored review outcome.',
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
        guard: 'reviewApproved',
        target: 'done',
        actions: 'rememberReviewApproval',
      },
      invalid: {
        guard: '<fallback>',
        target: 'reportedReviewFailure',
        actions: 'rememberUnestablishedReview',
      },
      authoredFailure: {
        guard: 'authoredReviewFailure',
        target: 'reportedReviewFailure',
        actions: 'rememberAuthoredReviewFailure',
      },
      controlFailure: {
        guard: '<fallback>',
        target: 'failed',
        actions: 'rememberActorError',
      },
    });
  });

  it('publishes a distinct terminal meaning per authored outcome', () => {
    const rootFinals = Object.entries(states)
      .filter(([, state]) => state.type === 'final')
      .map(([id]) => id)
      .sort();
    expect(rootFinals).toEqual(['done', 'reportedReviewFailure']);

    // DR-048: each final state also declares whether its outcome means the
    // workflow succeeded or failed, so DEV routes DECIDE's reported failure
    // through its own error path without reading DECIDE's output fields.
    expect(states.done?.meta).toEqual({
      playbook: {
        stateId: 'done',
        description: states.done?.description,
        terminal: 'success',
      },
    });
    expect(states.reportedReviewFailure?.meta).toEqual({
      playbook: {
        stateId: 'reportedReviewFailure',
        description: states.reportedReviewFailure?.description,
        terminal: 'failure',
      },
    });

    const armList = (value: unknown): readonly RawTransition[] =>
      value === undefined
        ? []
        : ((Array.isArray(value) ? value : [value]) as RawTransition[]);

    const entering = new Map<string, string[]>();
    for (const state of Object.values(states)) {
      for (const arm of [
        ...armList(state.invoke?.onDone),
        ...armList(state.invoke?.onError),
      ]) {
        const target = arm.target;
        if (typeof target !== 'string' || !rootFinals.includes(target)) continue;
        entering.set(target, [
          ...(entering.get(target) ?? []),
          String(arm.actions),
        ]);
      }
    }

    // Every arm entering a terminal state carries that state's own outcome, so
    // the description a host quotes holds however the run arrived there.
    expect(entering.get('done')).toEqual(['rememberReviewApproval']);
    expect(entering.get('reportedReviewFailure')?.sort()).toEqual([
      'rememberAuthoredReviewFailure',
      'rememberUnestablishedReview',
    ]);
    expect(states.done?.description).toContain(
      'review established no unsettled findings',
    );
    expect(states.reportedReviewFailure?.description).toContain(
      "reported review's abort, failure, or unestablished result",
    );
    expect(states.reportedReviewFailure?.description).not.toContain(
      'established no unsettled findings',
    );
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

  it('stages each proposal in its branch and promotes both only at the join', async () => {
    const inputs: PlayerInput[] = [];
    const settle: Partial<Record<string, (output: unknown) => void>> = {};
    const actor = createActor(
      decideMachine.provide({
        actors: {
          player: fromPromise(
            ({ input }: { input: PlayerInput }) =>
              new Promise((resolve) => {
                inputs.push(input);
                settle[input.stateId] = resolve as (output: unknown) => void;
              }) as never,
          ),
        },
      }),
    ).start();
    const initial = { ...CONTEXT, coderProposal: '', reviewerProposal: '' };
    expect(actor.getSnapshot().context).toEqual({
      ...initial,
      callerTopic: '',
      coderOutput: '',
      decideCommit: '',
    });

    actor.send({ type: 'START_DECIDE', callerTopic: 'Choose a durable design.' });
    await waitFor(actor, () => inputs.length === 2);
    // Neither proposal call carries either proposal.
    expect(inputs.map(({ stateId }) => stateId).sort()).toEqual([
      'askCoderProposal',
      'askReviewerProposal',
    ]);
    for (const input of inputs) {
      expect(input).not.toHaveProperty('coderProposal');
      expect(input).not.toHaveProperty('reviewerProposal');
      expect(input).toMatchObject({ callerTopic: 'Choose a durable design.' });
    }

    settle.askCoderProposal?.({
      guard: 'proposed',
      coderProposal: 'Coder proposes package items.',
    });
    const staged = await waitFor(actor, (snapshot) =>
      snapshot.matches({
        independentProposals: { coderProposalRegion: 'coderProposalStaged' },
      }),
    );
    expect(staged.context).toMatchObject({
      stagedCoderProposal: 'Coder proposes package items.',
      coderProposal: '',
      reviewerProposal: '',
    });

    settle.askReviewerProposal?.({
      guard: 'proposed',
      reviewerProposal: 'Reviewer proposes one DR.',
    });
    const joined = await waitFor(actor, (snapshot) =>
      snapshot.matches('synthesizeCommit'),
    );
    expect(joined.context).toEqual({
      ...initial,
      coderProposal: 'Coder proposes package items.',
      reviewerProposal: 'Reviewer proposes one DR.',
      coderOutput: '',
      decideCommit: '',
    });
    expect(inputs.at(-1)).toMatchObject({
      stateId: 'synthesizeCommit',
      callerTopic: 'Choose a durable design.',
      reviewerProposal: 'Reviewer proposes one DR.',
    });
    // Coder's own proposal reaches only `review`, never the synthesis call.
    expect(inputs.at(-1)).not.toHaveProperty('coderProposal');
    actor.stop();
  });

  it.each([
    ['actor error', new Error('player is down'), 'Error', 'player is down'],
    [
      'malformed output',
      { guard: 'needsBossReply', question: '  ' },
      'MalformedPlayerOutput',
      'Player output for DECIDE-1 declared needsBossReply without a question.',
    ],
  ] as const)(
    'clears the sibling question and staged results when a proposal fails with %s',
    async (_label, failure, name, message) => {
      let settleCoder: (() => void) | undefined;
      const actor = createActor(
        decideMachine.provide({
          actors: {
            player: fromPromise(async ({ input }: { input: PlayerInput }) => {
              if (input.stateId === 'askReviewerProposal') {
                return { guard: 'needsBossReply', question: 'Which scope?' };
              }
              await new Promise<void>((resolve) => {
                settleCoder = resolve;
              });
              if (failure instanceof Error) throw failure;
              return failure as never;
            }),
          },
        }),
      ).start();
      actor.send({ type: 'START_DECIDE', callerTopic: 'Choose a design.' });
      // The reviewer parks its question while the coder is still working.
      const parked = await waitFor(actor, (snapshot) =>
        snapshot.matches({
          independentProposals: {
            reviewerProposalRegion: 'awaitReviewerProposalReply',
          },
        }),
      );
      expect(Object.keys(parked.context.pendingBossQuestions)).toEqual([
        'askReviewerProposal',
      ]);
      settleCoder?.();
      const failed = await waitFor(actor, (snapshot) => snapshot.matches('failed'));

      expect(failed.context.pendingBossQuestions).toEqual({});
      expect(failed.context.bossReplies).toEqual({});
      expect(failed.context).toMatchObject({
        stagedCoderProposal: '',
        stagedReviewerProposal: '',
        lastError: { name, message },
      });
      // A JSON-safe record, never the thrown value itself.
      expect(failed.context.lastError).not.toBeInstanceOf(Error);
      expect(JSON.parse(JSON.stringify(failed.context.lastError))).toEqual(
        failed.context.lastError,
      );
      actor.stop();
    },
  );

  it('clears the Boss reply when the resumed synthesis fails', async () => {
    const inputs: PlayerInput[] = [];
    const script: unknown[] = [
      { guard: 'needsBossReply', question: 'Which package owns it?' },
      new Error('player is down'),
    ];
    const actor = createActor(
      decideMachine.provide({
        actors: {
          player: fromPromise(async ({ input }: { input: PlayerInput }) => {
            inputs.push(input);
            if (input.stateId === 'askCoderProposal') {
              return { guard: 'proposed', coderProposal: 'Coder proposal' };
            }
            if (input.stateId === 'askReviewerProposal') {
              return { guard: 'proposed', reviewerProposal: 'Reviewer proposal' };
            }
            const next = script.shift();
            if (next instanceof Error) throw next;
            return next as never;
          }),
        },
      }),
    ).start();
    actor.send({ type: 'START_DECIDE', callerTopic: 'Choose a design.' });
    await waitFor(actor, (snapshot) => snapshot.matches('awaitBossReply'));
    expect(actor.getSnapshot().context.pendingBossQuestions).toMatchObject({
      synthesizeCommit: { resumeStateId: 'synthesizeCommit', sourceItem: 'DECIDE-3' },
    });

    actor.send({
      type: 'BOSS_REPLY',
      questionId: 'synthesizeCommit',
      answer: 'The runtime package.',
    });
    const failed = await waitFor(actor, (snapshot) => snapshot.matches('failed'));

    // The resumed call carried the question and reply it answers ...
    expect(inputs.at(-1)).toMatchObject({
      stateId: 'synthesizeCommit',
      pendingBossQuestion: { question: 'Which package owns it?' },
      bossReply: 'The runtime package.',
    });
    // ... and its failure keeps neither.
    expect(failed.context.pendingBossQuestions).toEqual({});
    expect(failed.context.bossReplies).toEqual({});
    expect(failed.context.lastError).toMatchObject({
      name: 'Error',
      message: 'player is down',
    });
    expect(script).toEqual([]);
    actor.stop();
  });

  it('rejects a textless control-action probe without throwing', () => {
    const interrupt = orderedTransitions(machineConfig, 'root').get(
      'root.on.BOSS_INTERRUPT',
    )?.[0];
    expect(interrupt).toBeDefined();
    expect(
      evaluateGuard(interrupt?.guard, {
        guard: 'interruptTargets',
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
