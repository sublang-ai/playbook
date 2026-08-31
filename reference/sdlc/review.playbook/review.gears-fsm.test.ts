// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGearsContract } from '../../../scripts/check-slc-source-gears.mjs';
import { ACCEPTED_OUTCOME_ACTION_TYPE } from '../../../src/accepted-outcome.js';
import {
  reviewMachine,
  type PlayerInput,
  type ReviewContext,
} from './review.fsm.js';

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
  context: ReviewContext;
  event: unknown;
}

const gears = new Map(
  parseGearsContract(
    readFileSync(new URL('./review.gears.md', import.meta.url), 'utf8'),
  ).map((item) => [item.id, item]),
);

const states = (
  reviewMachine as unknown as { config: RawMachineConfig }
).config.states ?? {};

const expected = [
  ['reviewInitial', 'REVIEW-1'],
  ['addressFindings', 'REVIEW-2'],
  ['reviewAfterCommit', 'REVIEW-3'],
  ['reviewAfterRebuttal', 'REVIEW-4'],
] as const;

const context: ReviewContext = {
  callerInput: 'Initial request',
  reviewerOutput: 'Reviewer findings',
  coderOutput: 'Coder disposition',
};

const done = (output: unknown) => ({
  type: 'xstate.done.actor.player',
  output,
});

const pendingContext = (
  stateId:
    | 'reviewInitial'
    | 'addressFindings'
    | 'reviewAfterCommit'
    | 'reviewAfterRebuttal',
  sourceItem: 'REVIEW-1' | 'REVIEW-2' | 'REVIEW-3' | 'REVIEW-4',
  roleId: 'coder' | 'reviewer',
): ReviewContext => ({
  ...context,
  pendingBossQuestion: {
    questionId: stateId,
    resumeStateId: stateId,
    sourceItem,
    asker: { kind: 'role', roleId },
    question: 'Which requirement applies?',
  },
});

const transitionFixtures: Record<string, readonly TransitionFixture[]> = {
  'reviewInitial.invoke.onDone': [
    {
      guard: 'hasFindings',
      target: '#addressFindings',
      context,
      event: done({ guard: 'hasFindings', reviewerOutput: 'Finding 1' }),
    },
    {
      guard: 'noFindings',
      target: '#done',
      context,
      event: done({ guard: 'noFindings' }),
    },
    {
      guard: 'needsBossReply',
      target: '#awaitBossReply',
      context,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
  ],
  'addressFindings.invoke.onDone': [
    {
      guard: 'committed',
      target: '#reviewAfterCommit',
      context,
      event: done({ guard: 'committed', coderOutput: 'Committed abc123' }),
    },
    {
      guard: 'rejectedAll',
      target: '#reviewAfterRebuttal',
      context,
      event: done({
        guard: 'rejectedAll',
        coderOutput: 'Rejected with evidence',
      }),
    },
    {
      guard: 'needsBossReply',
      target: '#awaitBossReply',
      context,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
  ],
  'reviewAfterCommit.invoke.onDone': [
    {
      guard: 'hasFindings',
      target: '#addressFindings',
      context,
      event: done({ guard: 'hasFindings', reviewerOutput: 'Finding 2' }),
    },
    {
      guard: 'noFindings',
      target: '#done',
      context,
      event: done({ guard: 'noFindings' }),
    },
    {
      guard: 'needsBossReply',
      target: '#awaitBossReply',
      context,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
  ],
  'reviewAfterRebuttal.invoke.onDone': [
    {
      guard: 'hasFindings',
      target: '#addressFindings',
      context,
      event: done({ guard: 'hasFindings', reviewerOutput: 'Finding remains' }),
    },
    {
      guard: 'noFindings',
      target: '#done',
      context,
      event: done({ guard: 'noFindings' }),
    },
    {
      guard: 'needsBossReply',
      target: '#awaitBossReply',
      context,
      event: done({ guard: 'needsBossReply', question: 'Which scope?' }),
    },
  ],
  'awaitBossReply.on.BOSS_REPLY': [
    {
      guard: 'emptyBossReply',
      target: '#failed',
      context: pendingContext('reviewInitial', 'REVIEW-1', 'reviewer'),
      event: { type: 'BOSS_REPLY', questionId: 'reviewInitial', answer: '  ' },
    },
    {
      guard: 'resumeReviewInitial',
      target: '#reviewInitial',
      context: pendingContext('reviewInitial', 'REVIEW-1', 'reviewer'),
      event: { type: 'BOSS_REPLY', questionId: 'reviewInitial', answer: 'Answer' },
    },
    {
      guard: 'resumeAddressFindings',
      target: '#addressFindings',
      context: pendingContext('addressFindings', 'REVIEW-2', 'coder'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'addressFindings',
        answer: 'Answer',
      },
    },
    {
      guard: 'resumeReviewAfterCommit',
      target: '#reviewAfterCommit',
      context: pendingContext('reviewAfterCommit', 'REVIEW-3', 'reviewer'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'reviewAfterCommit',
        answer: 'Answer',
      },
    },
    {
      guard: 'resumeReviewAfterRebuttal',
      target: '#reviewAfterRebuttal',
      context: pendingContext('reviewAfterRebuttal', 'REVIEW-4', 'reviewer'),
      event: {
        type: 'BOSS_REPLY',
        questionId: 'reviewAfterRebuttal',
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
  if (typeof guard !== 'object' || guard === null) return undefined;
  const type = (guard as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
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

  it('marks all twelve governed outcomes with stable identities', () => {
    const governed = [
      {
        stateId: 'reviewInitial',
        expected: [
          {
            source: 'reviewInitial',
            target: 'addressFindings',
            acceptedOutcome: 'hasFindings',
          },
          {
            source: 'reviewInitial',
            target: 'done',
            acceptedOutcome: 'noFindings',
          },
          {
            source: 'reviewInitial',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
        ],
      },
      {
        stateId: 'addressFindings',
        expected: [
          {
            source: 'addressFindings',
            target: 'reviewAfterCommit',
            acceptedOutcome: 'committed',
          },
          {
            source: 'addressFindings',
            target: 'reviewAfterRebuttal',
            acceptedOutcome: 'rejectedAll',
          },
          {
            source: 'addressFindings',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
        ],
      },
      {
        stateId: 'reviewAfterCommit',
        expected: [
          {
            source: 'reviewAfterCommit',
            target: 'addressFindings',
            acceptedOutcome: 'hasFindings',
          },
          {
            source: 'reviewAfterCommit',
            target: 'done',
            acceptedOutcome: 'noFindings',
          },
          {
            source: 'reviewAfterCommit',
            target: 'awaitBossReply',
            acceptedOutcome: 'needsBossReply',
          },
        ],
      },
      {
        stateId: 'reviewAfterRebuttal',
        expected: [
          {
            source: 'reviewAfterRebuttal',
            target: 'addressFindings',
            acceptedOutcome: 'hasFindings',
          },
          {
            source: 'reviewAfterRebuttal',
            target: 'done',
            acceptedOutcome: 'noFindings',
          },
          {
            source: 'reviewAfterRebuttal',
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
      expect(arms).toHaveLength(expected.length);
      expect(
        arms.map((arm) => acceptedOutcomeMarkers(arm)),
        stateId,
      ).toEqual(expected.map((marker) => [marker]));
    }
  });

  it('keeps relayed fields quoted and owned by the preceding player result', () => {
    expect(gears.get('REVIEW-1')?.prompt).toContain('> <caller-input>');
    expect(gears.get('REVIEW-2')?.prompt).toContain('> <reviewer-output>');
    expect(gears.get('REVIEW-3')?.prompt).toContain('> <coder-output>');
    expect(gears.get('REVIEW-4')?.prompt).toContain('> <coder-output>');

    const text = readFileSync(
      new URL('./review.gears.md', import.meta.url),
      'utf8',
    );
    expect(text).toContain(
      '`reviewerOutput: <verbatim final text>`',
    );
    expect(text).toContain('`coderOutput: <verbatim final text>`');
  });
});
