// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createActor, fromPromise, waitFor } from 'xstate';

import { parseGearsContract } from '../../../scripts/check-slc-source-gears.mjs';
import { ACCEPTED_OUTCOME_ACTION_TYPE } from '../../../src/accepted-outcome.js';
import {
  concurrentRoleSets,
  reviewMachine,
  type PlayerInput,
  type PlayerOutput,
  type ReviewContext,
} from './review.fsm.js';
import { reviewPlaybookRegistryEntry } from './review.registry.js';

interface RawState {
  tags?: readonly string[];
  meta?: unknown;
  invoke?: {
    src?: unknown;
    input?: (args: { context: ReviewContext }) => PlayerInput;
    onDone?: RawTransition | readonly RawTransition[];
  };
  on?: Record<string, RawTransition | readonly RawTransition[]>;
  states?: Record<string, RawState>;
}

interface RawMachineConfig {
  on?: Record<string, RawTransition | readonly RawTransition[]>;
  states?: Record<string, RawState>;
}

interface RawTransition {
  guard?: unknown;
  target?: unknown;
  actions?: unknown;
}

interface TransitionFixture {
  // `undefined` names the unguarded malformed-output fallback arm.
  guard: string | undefined;
  target: string;
  context: ReviewContext;
  event: unknown;
}

const gears = new Map(
  parseGearsContract(
    readFileSync(new URL('./review.gears.md', import.meta.url), 'utf8'),
  ).map((item) => [item.id, item]),
);

const machineConfig = (
  reviewMachine as unknown as { config: RawMachineConfig }
).config;
const states = machineConfig.states ?? {};

const expected = [
  ['firstReview', 'REVIEW-1'],
  ['fixFindings', 'REVIEW-2'],
  ['reviewAfterFix', 'REVIEW-3'],
  ['reviewAfterRejection', 'REVIEW-4'],
] as const;

// The machine's typed context before any request: no field set.
const blank: ReviewContext = {};

// A stored request.
const request: ReviewContext = {
  ...blank,
  callerInput: 'Initial request',
};

const context: ReviewContext = {
  ...request,
  reviewerOutput: 'Reviewer findings',
  coderOutput: 'Coder disposition',
  latestCommit: '1111111111111111111111111111111111111111',
  evaluatedRevision: '3333333333333333333333333333333333333333',
};

const done = (output: unknown) => ({
  type: 'xstate.done.actor.player',
  output,
});

const pendingContext = (
  stateId:
    | 'firstReview'
    | 'fixFindings'
    | 'reviewAfterFix'
    | 'reviewAfterRejection',
  sourceItem: 'REVIEW-1' | 'REVIEW-2' | 'REVIEW-3' | 'REVIEW-4',
  roleId: 'coder' | 'reviewer',
  extra: Partial<ReviewContext> = {},
): ReviewContext => ({
  ...context,
  ...extra,
  pendingBossQuestion: {
    questionId: stateId,
    resumeStateId: stateId,
    sourceItem,
    asker: { kind: 'role', roleId },
    question: 'Which requirement applies?',
  },
});

const interrupt = (targetId: string) => ({
  type: 'BOSS_INTERRUPT',
  targetId,
  bossIntent: 'Redo this round.',
});

const transitionFixtures: Record<string, readonly TransitionFixture[]> = {
  // Each Boss jump is guarded by its target id and by the typed context the
  // target round needs, so no round is entered without its evidence.
  'root.on.BOSS_INTERRUPT': [
    {
      guard: '<inline>',
      target: '#firstReview',
      context: request,
      event: interrupt('firstReview'),
    },
    {
      guard: '<inline>',
      target: '#fixFindings',
      context,
      event: interrupt('fixFindings'),
    },
    {
      guard: '<inline>',
      target: '#reviewAfterFix',
      context: { ...context, coderOutcome: 'committed' },
      event: interrupt('reviewAfterFix'),
    },
    {
      guard: '<inline>',
      target: '#reviewAfterRejection',
      context: { ...context, coderOutcome: 'rejectedAll' },
      event: interrupt('reviewAfterRejection'),
    },
  ],
  'firstReview.invoke.onDone': [
    {
      guard: 'acceptHasFindings',
      target: '#fixFindings',
      context,
      event: done({ guard: 'hasFindings', reviewerOutput: 'Finding 1' }),
    },
    {
      guard: 'acceptNoFindings',
      target: '#done',
      context,
      event: done({
        guard: 'noFindings',
        evaluatedRevision: '3333333333333333333333333333333333333333',
      }),
    },
    {
      guard: 'acceptNeedsBossReply',
      target: '#awaitBossReply',
      context,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
    {
      guard: undefined,
      target: '#failed',
      context,
      event: done({ guard: 'hasFindings' }),
    },
  ],
  'fixFindings.invoke.onDone': [
    {
      guard: 'acceptCommitted',
      target: '#reviewAfterFix',
      context,
      event: done({
        guard: 'committed',
        coderOutput: 'Committed the accepted fixes.',
        latestCommit: '2222222222222222222222222222222222222222',
      }),
    },
    {
      guard: 'acceptRejectedAll',
      target: '#reviewAfterRejection',
      context,
      event: done({
        guard: 'rejectedAll',
        coderOutput: 'Rejected with evidence',
      }),
    },
    {
      guard: 'acceptNeedsBossReply',
      target: '#awaitBossReply',
      context,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
    {
      // A commit claim without the receipt-derived commit identity accepts
      // no arm and fails closed.
      guard: undefined,
      target: '#failed',
      context,
      event: done({ guard: 'committed', coderOutput: 'Committed.' }),
    },
  ],
  'reviewAfterFix.invoke.onDone': [
    {
      guard: 'acceptHasFindingsBeforeBound',
      target: '#fixFindings',
      context: { ...context, round: 2 },
      event: done({ guard: 'hasFindings', reviewerOutput: 'Finding 2' }),
    },
    {
      // playbook-62 / DR-102: the third round's findings stay unsettled.
      guard: 'acceptHasFindingsAtBound',
      target: '#unsettled',
      context: { ...context, round: 3 },
      event: done({ guard: 'hasFindings', reviewerOutput: 'Finding 2' }),
    },
    {
      guard: 'acceptNoFindings',
      target: '#done',
      context,
      event: done({
        guard: 'noFindings',
        evaluatedRevision: '3333333333333333333333333333333333333333',
      }),
    },
    {
      guard: 'acceptNeedsBossReply',
      target: '#awaitBossReply',
      context,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
    {
      guard: undefined,
      target: '#failed',
      context,
      event: done({ guard: 'noFindings' }),
    },
  ],
  'reviewAfterRejection.invoke.onDone': [
    {
      guard: 'acceptHasFindingsBeforeBound',
      target: '#fixFindings',
      context: { ...context, round: 2 },
      event: done({ guard: 'hasFindings', reviewerOutput: 'Finding remains' }),
    },
    {
      // playbook-62 / DR-102: the third round's findings stay unsettled.
      guard: 'acceptHasFindingsAtBound',
      target: '#unsettled',
      context: { ...context, round: 3 },
      event: done({ guard: 'hasFindings', reviewerOutput: 'Finding remains' }),
    },
    {
      guard: 'acceptNoFindings',
      target: '#done',
      context,
      event: done({
        guard: 'noFindings',
        evaluatedRevision: '3333333333333333333333333333333333333333',
      }),
    },
    {
      guard: 'acceptNeedsBossReply',
      target: '#awaitBossReply',
      context,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
    {
      guard: undefined,
      target: '#failed',
      context,
      event: done({ guard: 'needsBossReply', question: '  ' }),
    },
  ],
  // A resume answers the pending question of exactly its round; each
  // follow-up round's fixture carries the Coder disposition that entered it.
  'awaitBossReply.on.BOSS_REPLY': [
    {
      guard: 'emptyBossReply',
      target: 'failed',
      context: pendingContext('firstReview', 'REVIEW-1', 'reviewer'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'firstReview',
        answer: '  ',
      },
    },
    {
      guard: '<inline>',
      target: '#firstReview',
      context: pendingContext('firstReview', 'REVIEW-1', 'reviewer'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'firstReview',
        answer: 'Answer',
      },
    },
    {
      guard: '<inline>',
      target: '#fixFindings',
      context: pendingContext('fixFindings', 'REVIEW-2', 'coder'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'fixFindings',
        answer: 'Answer',
      },
    },
    {
      guard: '<inline>',
      target: '#reviewAfterFix',
      context: pendingContext('reviewAfterFix', 'REVIEW-3', 'reviewer', {
        coderOutcome: 'committed',
      }),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'reviewAfterFix',
        answer: 'Answer',
      },
    },
    {
      guard: '<inline>',
      target: '#reviewAfterRejection',
      context: pendingContext('reviewAfterRejection', 'REVIEW-4', 'reviewer', {
        coderOutcome: 'rejectedAll',
      }),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'reviewAfterRejection',
        answer: 'Answer',
      },
    },
  ],
};

function orderedTransitions(
  current: Record<string, RawState>,
  parent = '',
): Map<string, readonly RawTransition[]> {
  const found = new Map<string, readonly RawTransition[]>();
  if (parent === '') {
    for (const [event, transitions] of Object.entries(machineConfig.on ?? {})) {
      if (Array.isArray(transitions)) found.set(`root.on.${event}`, transitions);
    }
  }
  for (const [key, state] of Object.entries(current)) {
    const path = parent === '' ? key : `${parent}.${key}`;
    if (Array.isArray(state.invoke?.onDone)) {
      found.set(`${path}.invoke.onDone`, state.invoke.onDone);
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
  if (typeof guard !== 'object' || guard === null) return undefined;
  const type = (guard as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function guardParams(guard: unknown): unknown {
  return typeof guard === 'object' && guard !== null
    ? (guard as { params?: unknown }).params
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function acceptedOutcomeMarkers(
  transition: RawTransition,
): readonly unknown[] {
  const actions =
    transition.actions === undefined
      ? []
      : Array.isArray(transition.actions)
        ? transition.actions
        : [transition.actions];
  return actions
    .filter(
      (action) =>
        isRecord(action) && action.type === ACCEPTED_OUTCOME_ACTION_TYPE,
    )
    .map((action) => action.params);
}

describe('REVIEW GEARS to FSM compilation', () => {
  it('maps every REVIEW item once with its canonical role and exact prompt', () => {
    expect([...gears.keys()]).toEqual(expected.map(([, item]) => item));
    // playbook-1: the FSM export and the registry manifest agree on the
    // (empty) ordered concurrent role sets.
    expect(concurrentRoleSets).toEqual([]);
    expect(concurrentRoleSets).toEqual(
      reviewPlaybookRegistryEntry.concurrentRoleSets,
    );
    for (const [stateId, sourceItem] of expected) {
      const item = gears.get(sourceItem);
      const input = states[stateId]?.invoke?.input?.({ context });
      expect(input).toBeDefined();
      expect(input?.stateId).toBe(stateId);
      expect(input?.sourceItem).toBe(sourceItem);
      expect(item?.player).toBeDefined();
      expect(input?.role).toBe(item?.player?.toLowerCase());
      expect(input?.prompt).toBe(item?.prompt.join('\n'));
      expect(states[stateId]?.tags).toContain('playbook.busy');
      expect(states[stateId]?.meta).toEqual({
        playbook: {
          stateId,
          description: expect.any(String),
          role: item?.player?.toLowerCase(),
        },
      });
    }
  });

  it('preserves each authored result contract and adds only Boss suspension', () => {
    for (const [stateId, sourceItem] of expected) {
      const input = states[stateId]?.invoke?.input?.({ context });
      const entries = Object.entries(input?.result ?? {});
      expect(entries.slice(0, -1)).toEqual(
        (gears.get(sourceItem)?.results ?? []).map(
          ({ guard, description }) => [guard, description],
        ),
      );
      expect(entries.at(-1)?.[0]).toBe('needsBossReply');
    }
  });

  it('tells the adjudicator in every Reviewer outcome that a progress report supports none', () => {
    // compiler-results-13 / playbook-21: the adjudicator reads only each
    // outcome's result description, so the Source's qualification that a
    // progress report, status update, or promise of a later result supports
    // no review outcome sits in every Reviewer result the judge selects from.
    const qualification =
      'a progress report, status update, or promise of a later result supports no review outcome';
    for (const [stateId, sourceItem] of expected) {
      const input = states[stateId]?.invoke?.input?.({ context });
      if (input?.role !== 'reviewer') continue;
      expect(Object.keys(input.result), stateId).toEqual([
        'hasFindings',
        'noFindings',
        'needsBossReply',
      ]);
      for (const guard of ['hasFindings', 'noFindings']) {
        expect(input.result[guard], `${stateId}.${guard}`).toContain(
          qualification,
        );
      }
      for (const { guard, description } of gears.get(sourceItem)?.results ??
        []) {
        expect(description, `${sourceItem}.${guard}`).toContain(qualification);
      }
    }
  });

  it('has one load-bearing fixture for every ordered transition arm', () => {
    const actual = orderedTransitions(states);
    expect([...actual.keys()]).toEqual(Object.keys(transitionFixtures));

    const guards = reviewMachine.implementations.guards as unknown as Record<
      string,
      (
        args: { context: ReviewContext; event: unknown },
        params: unknown,
      ) => boolean
    >;
    for (const [location, fixtures] of Object.entries(transitionFixtures)) {
      const arms = actual.get(location) ?? [];
      expect(
        arms.map((arm) => ({ guard: guardName(arm.guard), target: arm.target })),
        location,
      ).toEqual(fixtures.map(({ guard, target }) => ({ guard, target })));

      fixtures.forEach((fixture, index) => {
        const evaluations = arms.slice(0, index + 1).map((arm) => {
          const name = guardName(arm.guard);
          const args = { context: fixture.context, event: fixture.event };
          if (name === undefined) return true;
          if (name === '<inline>') {
            return (arm.guard as (value: typeof args) => boolean)(args);
          }
          return guards[name](args, guardParams(arm.guard));
        });
        expect(evaluations, `${location}[${index}]`).toEqual([
          ...Array.from({ length: index }, () => false),
          true,
        ]);
      });
    }
  });

  it('marks all fourteen governed outcomes with stable identities', () => {
    const governed = [
      {
        stateId: 'firstReview',
        expected: [
          {
            source: 'firstReview',
            target: 'fixFindings',
            acceptedOutcome: 'hasFindings',
          },
          {
            source: 'firstReview',
            target: 'done',
            acceptedOutcome: 'noFindings',
          },
          {
            source: 'firstReview',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
        ],
      },
      {
        stateId: 'fixFindings',
        expected: [
          {
            source: 'fixFindings',
            target: 'reviewAfterFix',
            acceptedOutcome: 'committed',
          },
          {
            source: 'fixFindings',
            target: 'reviewAfterRejection',
            acceptedOutcome: 'rejectedAll',
          },
          {
            source: 'fixFindings',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
        ],
      },
      {
        stateId: 'reviewAfterFix',
        expected: [
          {
            source: 'reviewAfterFix',
            target: 'fixFindings',
            acceptedOutcome: 'hasFindings',
          },
          {
            source: 'reviewAfterFix',
            target: 'unsettled',
            acceptedOutcome: 'hasFindings',
          },
          {
            source: 'reviewAfterFix',
            target: 'done',
            acceptedOutcome: 'noFindings',
          },
          {
            source: 'reviewAfterFix',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
        ],
      },
      {
        stateId: 'reviewAfterRejection',
        expected: [
          {
            source: 'reviewAfterRejection',
            target: 'fixFindings',
            acceptedOutcome: 'hasFindings',
          },
          {
            source: 'reviewAfterRejection',
            target: 'unsettled',
            acceptedOutcome: 'hasFindings',
          },
          {
            source: 'reviewAfterRejection',
            target: 'done',
            acceptedOutcome: 'noFindings',
          },
          {
            source: 'reviewAfterRejection',
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
      // The trailing unguarded malformed-output fallback accepts no outcome
      // and so carries no marker.
      expect(arms).toHaveLength(expected.length + 1);
      expect(
        arms.map((arm) => acceptedOutcomeMarkers(arm)),
        stateId,
      ).toEqual([...expected.map((marker) => [marker]), []]);
      expect(arms.at(-1)?.guard, stateId).toBeUndefined();
    }
  });

  it('keeps every round relay quoted, ordered, and receipt- or player-owned', () => {
    // Every prompt relays the caller's complete request ahead of the round's
    // evidence: no prompt assumes what an earlier one told its conversation.
    for (const [id, item] of gears) {
      expect(item.prompt, id).toContain('> Original request: <caller-input>');
      expect(item.prompt.join('\n'), id).not.toContain('<original-intent>');
    }
    expect(gears.get('REVIEW-2')?.prompt).toContain('> Reviewer findings: <reviewer-output>');
    expect(gears.get('REVIEW-3')?.prompt).toEqual(
      expect.arrayContaining([
        '> Latest commit: <latest-commit>',
        '> Coder output: <coder-output>',
      ]),
    );
    expect(gears.get('REVIEW-4')?.prompt).toContain('> Coder output: <coder-output>');
    // The evaluated revision relays only where a receipt-derived review-fix
    // commit exists; no other round leaves a placeholder without a producer.
    for (const [id, item] of gears) {
      if (id === 'REVIEW-3') continue;
      expect(item.prompt, id).not.toContain('> Latest commit: <latest-commit>');
    }
    const review3 = gears.get('REVIEW-3')?.prompt ?? [];
    expect(review3.indexOf('> Original request: <caller-input>')).toBeLessThan(
      review3.indexOf('> Latest commit: <latest-commit>'),
    );
    expect(review3.indexOf('> Latest commit: <latest-commit>')).toBeLessThan(
      review3.indexOf('> Coder output: <coder-output>'),
    );
    // DR-065: the prefix pass moved every relay block after the last
    // instruction line; the layout itself records each move.
    for (const [id, item] of gears) {
      const firstRelay = item.prompt.findIndex((line) => line.startsWith('> '));
      expect(firstRelay, id).toBeGreaterThan(0);
      expect(item.prompt[firstRelay - 1], id).toBe('');
      expect(
        item.prompt.slice(firstRelay).every((line) => line.startsWith('> ')),
        id,
      ).toBe(true);
    }

    const text = readFileSync(
      new URL('./review.gears.md', import.meta.url),
      'utf8',
    );
    expect(text).toContain(
      '`reviewerOutput: <verbatim final text>`',
    );
    expect(text).toContain('`coderOutput: <verbatim final text>`');
    // The review-fix commit identity is annotated as a commit identity, not
    // verbatim player text: it is receipt-owned effect evidence.
    expect(text).toContain('`latestCommit: <commit identity>`');
    expect(text).not.toContain('`latestCommit: <verbatim final text>`');
    expect(text).not.toMatch(/^## Prefixed prompts$/m);
  });

  // playbook-13/-15: a resumed call that fails leaves its working state
  // without suspending for its own question, so the failure exit clears the
  // pending question and reply rather than parking them in `failed`.
  it.each(
    (
      [
        ['firstReview', []],
        ['fixFindings', [{ guard: 'hasFindings', reviewerOutput: '1. Finding' }]],
        [
          'reviewAfterFix',
          [
            { guard: 'hasFindings', reviewerOutput: '1. Finding' },
            {
              guard: 'committed',
              latestCommit: '2222222222222222222222222222222222222222',
              coderOutput: 'Fixed.',
            },
          ],
        ],
        [
          'reviewAfterRejection',
          [
            { guard: 'hasFindings', reviewerOutput: '1. Finding' },
            { guard: 'rejectedAll', coderOutput: 'Rejected with evidence.' },
          ],
        ],
      ] as const
    ).flatMap(([stateId, before]) =>
      (['actor error', 'malformed output'] as const).map(
        (failure) => [stateId, failure, before] as const,
      ),
    ),
  )(
    'clears the Boss reply when resumed %s fails with %s',
    async (stateId, failure, before) => {
      const inputs: PlayerInput[] = [];
      const script: unknown[] = [
        ...before,
        { guard: 'needsBossReply', question: 'Which release applies?' },
        failure === 'actor error'
          ? new Error('player is down')
          : stateId === 'fixFindings'
            ? { guard: 'committed', coderOutput: 'Committed.' }
            : { guard: 'hasFindings' },
      ];
      const actor = createActor(
        reviewMachine.provide({
          actors: {
            player: fromPromise(async ({ input }: { input: PlayerInput }) => {
              inputs.push(input);
              const next = script.shift();
              if (next instanceof Error) throw next;
              return next as never;
            }),
          },
        }),
      ).start();
      actor.send({ type: 'START_REVIEW', callerInput: 'Review the release.' });
      await waitFor(actor, (snapshot) => snapshot.matches('awaitBossReply'));
      expect(actor.getSnapshot().context.pendingBossQuestion).toMatchObject({
        resumeStateId: stateId,
      });

      actor.send({ type: 'BOSS_REPLY', answer: 'Use 6.0.' });
      const failed = await waitFor(actor, (snapshot) =>
        snapshot.matches('failed'),
      );

      // The resumed call carried the question and reply it answers ...
      expect(inputs.at(-1)).toMatchObject({
        stateId,
        pendingBossQuestion: { question: 'Which release applies?' },
        bossReply: 'Use 6.0.',
      });
      // ... and its failure keeps neither: both are cleared.
      expect(failed.context.lastError).toBeDefined();
      expect(failed.context.pendingBossQuestion).toBeUndefined();
      expect(failed.context.bossReply).toBeUndefined();
      expect(script).toEqual([]);
      actor.stop();
    },
  );

  // Every prompt, Coder's included, relays the caller's request whole: a
  // later round's conversation may start fresh, so no prompt assumes what an
  // earlier one said, and a caller's labelled request keeps every label.
  it.each([
    ['Boss free text', 'Review the feature.\nRun result: focused suite passed.'],
    [
      "a caller's quoted labelled request",
      '> Original intent: Fix the bug.\n> Note: docs follow.\n> Review scope: the commit abc123.\n> Coder output: Committed the change.',
    ],
  ] as const)('relays %s whole in every round', async (_name, callerInput) => {
    const inputs: PlayerInput[] = [];
    const script: PlayerOutput[] = [
      { guard: 'hasFindings', reviewerOutput: '1. Finding' },
      { guard: 'rejectedAll', coderOutput: 'Rejected with evidence.' },
      { guard: 'hasFindings', reviewerOutput: '1. Finding kept' },
      {
        guard: 'committed',
        latestCommit: '2222222222222222222222222222222222222222',
        coderOutput: 'Fixed.',
      },
      {
        guard: 'noFindings',
        evaluatedRevision: '2222222222222222222222222222222222222222',
      },
    ];
    const actor = createActor(
      reviewMachine.provide({
        actors: {
          player: fromPromise<PlayerOutput, PlayerInput>(async ({ input }) => {
            inputs.push(input);
            const next = script.shift();
            if (next === undefined) throw new Error('unexpected player call');
            return next;
          }),
        },
      }),
      { input: {} },
    ).start();
    actor.send({ type: 'START_REVIEW', callerInput });
    const completed = await waitFor(
      actor,
      (snapshot) => snapshot.status === 'done',
    );
    expect(completed.context.callerInput).toBe(callerInput);
    expect(completed.context).not.toHaveProperty('originalIntent');
    expect(inputs.map(({ sourceItem }) => sourceItem)).toEqual([
      'REVIEW-1',
      'REVIEW-2',
      'REVIEW-4',
      'REVIEW-2',
      'REVIEW-3',
    ]);
    for (const input of inputs) {
      expect(input.callerInput, input.sourceItem).toBe(callerInput);
      expect(input, input.sourceItem).not.toHaveProperty('originalIntent');
    }
    actor.stop();
  });

  // playbook-62 / DR-102: REVIEW runs at most three Reviewer rounds; the
  // third round's findings stop REVIEW unsettled with no further Coder call.
  const scriptedActor = (script: (PlayerOutput | 'pending')[]) => {
    const inputs: PlayerInput[] = [];
    const actor = createActor(
      reviewMachine.provide({
        actors: {
          player: fromPromise<PlayerOutput, PlayerInput>(async ({ input }) => {
            inputs.push(input);
            const next = script.shift();
            if (next === undefined) throw new Error('unexpected player call');
            if (next === 'pending') return new Promise<never>(() => undefined);
            return next;
          }),
        },
      }),
      { input: {} },
    ).start();
    return { actor, inputs };
  };
  const commit = {
    guard: 'committed',
    latestCommit: '2222222222222222222222222222222222222222',
    coderOutput: 'Fixed.',
  } as const;

  it('stops after the third round with its findings unsettled', async () => {
    const { actor, inputs } = scriptedActor([
      { guard: 'hasFindings', reviewerOutput: '1. Round one finding' },
      commit,
      { guard: 'hasFindings', reviewerOutput: '1. Round two finding' },
      { guard: 'rejectedAll', coderOutput: 'Rejected with evidence.' },
      { guard: 'hasFindings', reviewerOutput: '1. Round three finding' },
    ]);
    actor.send({ type: 'START_REVIEW', callerInput: 'Review the release.' });
    const stopped = await waitFor(actor, (snapshot) => snapshot.status === 'done');
    expect(stopped.value).toBe('unsettled');
    expect(stopped.context.round).toBe(3);
    expect(inputs.map(({ stateId }) => stateId)).toEqual([
      'firstReview',
      'fixFindings',
      'reviewAfterFix',
      'fixFindings',
      'reviewAfterRejection',
    ]);
    expect(inputs.filter(({ role }) => role === 'coder')).toHaveLength(2);
    expect(stopped.output).toEqual({
      noUnsettledFindings: false,
      reviewerOutput: '1. Round three finding',
    });
    actor.stop();
  });

  it('sends the second round findings to Coder before the bound', async () => {
    const { actor, inputs } = scriptedActor([
      { guard: 'hasFindings', reviewerOutput: '1. Round one finding' },
      { guard: 'rejectedAll', coderOutput: 'Rejected with evidence.' },
      { guard: 'hasFindings', reviewerOutput: '1. Round two finding' },
      'pending',
    ]);
    actor.send({ type: 'START_REVIEW', callerInput: 'Review the release.' });
    const fixing = await waitFor(
      actor,
      (snapshot) => snapshot.matches('fixFindings') && snapshot.context.round === 2,
    );
    expect(fixing.context.reviewerOutput).toBe('1. Round two finding');
    expect(fixing.context.findingsUnsettled).toBeUndefined();
    await waitFor(actor, () => inputs.length === 4);
    expect(inputs.at(-1)).toMatchObject({
      stateId: 'fixFindings',
      reviewerOutput: '1. Round two finding',
    });
    actor.stop();
  });

  it('restarts the round count only on a Boss jump to the first review', async () => {
    const { actor, inputs } = scriptedActor([
      { guard: 'hasFindings', reviewerOutput: '1. Round one finding' },
      commit,
      'pending',
      'pending',
      'pending',
    ]);
    actor.send({ type: 'START_REVIEW', callerInput: 'Review the release.' });
    const second = await waitFor(
      actor,
      (snapshot) =>
        snapshot.matches('reviewAfterFix') && snapshot.context.round === 2,
    );
    expect(second.context).toMatchObject({
      callerInput: 'Review the release.',
      coderOutcome: 'committed',
      latestCommit: commit.latestCommit,
      coderOutput: commit.coderOutput,
    });
    // A jump that redoes a later round keeps that round's ordinal ...
    actor.send({ type: 'BOSS_INTERRUPT', targetId: 'reviewAfterFix' });
    const redone = await waitFor(actor, () => inputs.length === 4);
    expect(redone.value).toBe('reviewAfterFix');
    expect(redone.context.round).toBe(2);
    // ... and a jump back to the first review restarts the count.
    actor.send({ type: 'BOSS_INTERRUPT', targetId: 'firstReview' });
    const restarted = await waitFor(actor, () => inputs.length === 5);
    expect(restarted.value).toBe('firstReview');
    expect(restarted.context.round).toBe(1);
    actor.stop();
  });

  it('refuses a Boss jump into a round whose typed context is missing', () => {
    const jumps = (machineConfig.on?.BOSS_INTERRUPT ?? []) as readonly {
      guard: (args: { context: ReviewContext; event: unknown }) => boolean;
      target: string;
    }[];
    const enterable = (probe: ReviewContext) =>
      expected
        .map(([targetId]) => targetId)
        .filter((targetId) =>
          jumps.some(
            (jump) =>
              jump.target === `#${targetId}` &&
              jump.guard({ context: probe, event: interrupt(targetId) }),
          ),
        );
    expect(enterable(blank)).toEqual([]);
    expect(enterable(request)).toEqual(['firstReview']);
    // Findings and a Coder disposition exist, but no disposition is recorded,
    // so neither follow-up round can be entered.
    expect(enterable(context)).toEqual(['firstReview', 'fixFindings']);
  });

  it('requires receipt-derived identities before accepting commit or completion', () => {
    const guards = reviewMachine.implementations.guards as unknown as Record<
      string,
      (
        args: { context: ReviewContext; event: unknown },
        params: unknown,
      ) => boolean
    >;
    expect(
      guards.acceptCommitted(
        {
          context,
          event: done({ guard: 'committed', coderOutput: 'Committed.' }),
        },
        undefined,
      ),
    ).toBe(false);
    expect(
      guards.acceptCommitted(
        {
          context,
          event: done({
            guard: 'committed',
            coderOutput: 'Committed.',
            latestCommit: '   ',
          }),
        },
        undefined,
      ),
    ).toBe(false);
    // DR-045: completion equally requires the receipt-observed revision.
    expect(
      guards.acceptNoFindings(
        { context, event: done({ guard: 'noFindings' }) },
        undefined,
      ),
    ).toBe(false);
    expect(
      guards.acceptNoFindings(
        {
          context,
          event: done({ guard: 'noFindings', evaluatedRevision: ' ' }),
        },
        undefined,
      ),
    ).toBe(false);
  });

  it('derives the terminal result from the receipt-observed revision only', () => {
    const output = (
      reviewMachine as unknown as {
        config: { output: (args: { context: ReviewContext }) => unknown };
      }
    ).config.output;
    expect(output({ context })).toEqual({
      noUnsettledFindings: true,
      evaluatedRevision: '3333333333333333333333333333333333333333',
    });
    // DR-045: completion without a receipt-observed revision is guarded out;
    // the output derivation refuses to fabricate one.
    expect(() => output({ context: request })).toThrow(
      /without the evaluated repository revision/,
    );
    // playbook-62 / DR-102: the bound's stop returns the unsettled findings,
    // never a revision, and refuses to stop without them.
    expect(
      output({
        context: {
          ...context,
          findingsUnsettled: true,
          reviewerOutput: 'Finding remains',
        },
      }),
    ).toEqual({ noUnsettledFindings: false, reviewerOutput: 'Finding remains' });
    expect(() =>
      output({
        context: { ...context, findingsUnsettled: true, reviewerOutput: '' },
      }),
    ).toThrow(/without the unsettled findings/);
  });

  it('declares the terminal kind of each final state', () => {
    const states = (
      reviewMachine as unknown as {
        config: {
          states: Record<
            string,
            { type?: string; description?: string; meta?: unknown }
          >;
        };
      }
    ).config.states;
    // DR-048: a clean review is REVIEW's only success; DR-102 / playbook-62:
    // stopping at the round bound with findings unsettled is a failure, so a
    // caller's `onDone` never reads it as approval.
    expect(
      Object.entries(states)
        .filter(([, state]) => state.type === 'final')
        .map(([id]) => id)
        .sort(),
    ).toEqual(['done', 'unsettled']);
    expect(states.done?.meta).toEqual({
      playbook: {
        stateId: 'done',
        description: states.done?.description,
        terminal: 'success',
      },
    });
    expect(states.unsettled?.meta).toEqual({
      playbook: {
        stateId: 'unsettled',
        description: states.unsettled?.description,
        terminal: 'failure',
      },
    });
    expect(states.unsettled?.description).toEqual(expect.any(String));
    expect(states.unsettled?.description).not.toContain(
      'no unsettled findings remain',
    );
  });
});
