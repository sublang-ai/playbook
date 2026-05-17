// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// IR-005 Task 4 — edge coverage.
// Pins every captain-invoking state's `onDone` arms, `onError`
// route, and every root-level event (START_CODING / CONTINUE_IR
// / SUMMARIZE_IR / BOSS_INTERRUPT[targetId]).
//
// Driver pattern: synthesize a snapshot at `ready` with the
// target context, start an actor with a fake `captain` actor,
// then send `BOSS_INTERRUPT` to jump into the source state. The
// re-entry transition's `reenter: true` re-invokes the captain,
// the fake returns the fixture's `CaptainOutput`, and xstate
// fires the `onDone` arm that matches. The fake hangs on any
// second invocation, so we stay at the resulting state.
//
// Fixtures key by `(stateId, transitionIndex)` because
// `(stateId, target)` collides in four states (see comment on
// `CaptainTransition.index` in `code.fsm.introspect.ts`).

import { describe, expect, it } from 'vitest';
import { createActor, fromPromise } from 'xstate';

import { codingMachine } from './code.fsm.js';
import type {
  CaptainInput,
  CaptainOutput,
  CodingContext,
  CodingEvent,
} from './code.fsm.js';
import {
  enumerateCaptainStates,
  enumerateRootEvents,
} from './code.fsm.introspect.js';

const DRIVE_TIMEOUT_MS = 500;

type Fixture = {
  context?: Partial<CodingContext>;
  captainOutput: CaptainOutput;
};

const fixtures = new Map<string, Fixture>();
function fx(stateId: string, index: number, fixture: Fixture): void {
  fixtures.set(`${stateId}#${index}`, fixture);
}

// CODE-1 — planAndImplement (3 arms)
fx('planAndImplement', 0, { captainOutput: { guard: 'singleCommitReady' } });
fx('planAndImplement', 1, { captainOutput: { guard: 'irDrafted' } });
fx('planAndImplement', 2, { captainOutput: { guard: 'needsBossInput' } });

// CODE-2 — respondToReview (11 arms)
fx('respondToReview', 0, { captainOutput: { guard: 'changesMadeSpecs' } });
fx('respondToReview', 1, { captainOutput: { guard: 'changesMadeCode' } });
fx('respondToReview', 2, { captainOutput: { guard: 'changesMadeMixed' } });
fx('respondToReview', 3, {
  captainOutput: { guard: 'changesMadeSpecsAndChallenged', challenges: '1. rebut x' },
});
fx('respondToReview', 4, {
  captainOutput: { guard: 'changesMadeCodeAndChallenged', challenges: '1. rebut x' },
});
fx('respondToReview', 5, {
  captainOutput: { guard: 'changesMadeMixedAndChallenged', challenges: '1. rebut x' },
});
fx('respondToReview', 6, {
  captainOutput: { guard: 'challengesRaised', challenges: '1. rebut x' },
});
fx('respondToReview', 7, {
  context: { reviewSubject: 'changes' },
  captainOutput: { guard: 'accepted' },
});
fx('respondToReview', 8, {
  context: { reviewSubject: 'commit', afterReview: 'continueIr' },
  captainOutput: { guard: 'accepted' },
});
fx('respondToReview', 9, {
  context: { reviewSubject: 'commit', afterReview: 'summarizeSpecs' },
  captainOutput: { guard: 'accepted' },
});
fx('respondToReview', 10, {
  context: { reviewSubject: 'commit', afterReview: 'done' },
  captainOutput: { guard: 'accepted' },
});

// CODE-3 — continueIr (3 arms)
fx('continueIr', 0, {
  captainOutput: { guard: 'taskReady', taskDescription: 'do x' },
});
fx('continueIr', 1, { captainOutput: { guard: 'iterationDone' } });
fx('continueIr', 2, { captainOutput: { guard: 'needsBossInput' } });

// CODE-4 — summarizeSpecs (3 arms)
fx('summarizeSpecs', 0, { captainOutput: { guard: 'specsReady' } });
fx('summarizeSpecs', 1, { captainOutput: { guard: 'noSpecChanges' } });
fx('summarizeSpecs', 2, { captainOutput: { guard: 'needsBossInput' } });

// CODE-5..10 — review*Commit*  (4 arms each, identical shape)
const reviewCommitStates = [
  'reviewBossCommitSpecs',
  'reviewBossCommitCode',
  'reviewBossCommitMixed',
  'reviewIrTaskCommitSpecs',
  'reviewIrTaskCommitCode',
  'reviewIrTaskCommitMixed',
] as const;
for (const s of reviewCommitStates) {
  fx(s, 0, {
    context: { afterReview: 'continueIr' },
    captainOutput: { guard: 'noFindings' },
  });
  fx(s, 1, {
    context: { afterReview: 'summarizeSpecs' },
    captainOutput: { guard: 'noFindings' },
  });
  fx(s, 2, {
    context: { afterReview: 'done' },
    captainOutput: { guard: 'noFindings' },
  });
  fx(s, 3, {
    captainOutput: { guard: 'hasFindings', reviews: '1. finding' },
  });
}

// CODE-11..13 — reviewChanges* (2 arms each)
const reviewChangesStates = [
  'reviewChangesSpecs',
  'reviewChangesCode',
  'reviewChangesMixed',
] as const;
for (const s of reviewChangesStates) {
  fx(s, 0, { captainOutput: { guard: 'noFindings' } });
  fx(s, 1, {
    captainOutput: { guard: 'hasFindings', reviews: '1. finding' },
  });
}

// CODE-15..17 — reviewChangesAndChallenges* (2 arms each)
const reviewChangesAndChallengesStates = [
  'reviewChangesAndChallengesSpecs',
  'reviewChangesAndChallengesCode',
  'reviewChangesAndChallengesMixed',
] as const;
for (const s of reviewChangesAndChallengesStates) {
  fx(s, 0, { captainOutput: { guard: 'approved' } });
  fx(s, 1, {
    captainOutput: { guard: 'needsRevision', reviews: '1. finding' },
  });
}

// CODE-14 — adjudicateChallenges (5 arms)
fx('adjudicateChallenges', 0, {
  context: { reviewSubject: 'changes' },
  captainOutput: { guard: 'challengeAccepted' },
});
fx('adjudicateChallenges', 1, {
  context: { reviewSubject: 'commit', afterReview: 'continueIr' },
  captainOutput: { guard: 'challengeAccepted' },
});
fx('adjudicateChallenges', 2, {
  context: { reviewSubject: 'commit', afterReview: 'summarizeSpecs' },
  captainOutput: { guard: 'challengeAccepted' },
});
fx('adjudicateChallenges', 3, {
  context: { reviewSubject: 'commit', afterReview: 'done' },
  captainOutput: { guard: 'challengeAccepted' },
});
fx('adjudicateChallenges', 4, { captainOutput: { guard: 'challengeRejected' } });

// CODE-18 — commitCoderInitial (8 arms)
fx('commitCoderInitial', 0, {
  context: { changeOrigin: 'bossIntent' },
  captainOutput: { guard: 'committedSpecs' },
});
fx('commitCoderInitial', 1, {
  context: { changeOrigin: 'bossIntent' },
  captainOutput: { guard: 'committedCode' },
});
fx('commitCoderInitial', 2, {
  context: { changeOrigin: 'bossIntent' },
  captainOutput: { guard: 'committedMixed' },
});
fx('commitCoderInitial', 3, {
  context: { changeOrigin: 'irTask' },
  captainOutput: { guard: 'committedSpecs' },
});
fx('commitCoderInitial', 4, {
  context: { changeOrigin: 'irTask' },
  captainOutput: { guard: 'committedCode' },
});
fx('commitCoderInitial', 5, {
  context: { changeOrigin: 'irTask' },
  captainOutput: { guard: 'committedMixed' },
});
fx('commitCoderInitial', 6, { captainOutput: { guard: 'noRelevantChanges' } });
fx('commitCoderInitial', 7, { captainOutput: { guard: 'needsBossInput' } });

// CODE-19 — commitJoint (5 arms)
fx('commitJoint', 0, {
  context: { afterReview: 'continueIr' },
  captainOutput: { guard: 'committed' },
});
fx('commitJoint', 1, {
  context: { afterReview: 'summarizeSpecs' },
  captainOutput: { guard: 'committed' },
});
fx('commitJoint', 2, {
  context: { afterReview: 'done' },
  captainOutput: { guard: 'committed' },
});
fx('commitJoint', 3, { captainOutput: { guard: 'noRelevantChanges' } });
fx('commitJoint', 4, { captainOutput: { guard: 'needsBossInput' } });

function makeFakeCaptain(behavior: CaptainOutput | 'throw' | 'hang') {
  let called = 0;
  return fromPromise<CaptainOutput, CaptainInput>(async () => {
    called += 1;
    if (called > 1 || behavior === 'hang') {
      return new Promise<CaptainOutput>(() => undefined);
    }
    if (behavior === 'throw') {
      throw new Error('coverage-test synthetic error');
    }
    return behavior;
  });
}

function machineWith(behavior: CaptainOutput | 'throw' | 'hang') {
  return codingMachine.provide({ actors: { captain: makeFakeCaptain(behavior) } });
}

// Drive from `from` (default `ready`) with the given context
// override, send `event`, resolve once the actor reaches `target`
// or moves past `passThrough`.
async function drive(args: {
  context?: Partial<CodingContext>;
  event: CodingEvent;
  behavior: CaptainOutput | 'throw' | 'hang';
  // Starting state. Defaults to `ready`; needed otherwise for the
  // BOSS_INTERRUPT targetId=ready test, where source=target=ready
  // would short-circuit the subscribe before the interrupt fires.
  from?: string;
  // If passThrough is set, resolve when the actor moves *past* that
  // state. If only target is set, resolve when the actor reaches it.
  passThrough?: string;
  target?: string;
}): Promise<string> {
  const machine = machineWith(args.behavior);
  const snap = machine.resolveState({
    value: args.from ?? 'ready',
    context: (args.context ?? {}) as CodingContext,
  });
  const actor = createActor(machine, { snapshot: snap });

  return new Promise<string>((resolve, reject) => {
    let visitedPassThrough = !args.passThrough;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      sub.unsubscribe();
      actor.stop();
      action();
    };
    const timeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `drive timeout: stuck at "${String(actor.getSnapshot().value)}"`,
          ),
        ),
      );
    }, DRIVE_TIMEOUT_MS);
    const sub = actor.subscribe((s) => {
      const val = s.value as string;
      if (args.passThrough && !visitedPassThrough && val === args.passThrough) {
        visitedPassThrough = true;
        return;
      }
      if (args.passThrough && visitedPassThrough && val === args.passThrough) {
        return;
      }
      const shouldResolve = args.target
        ? val === args.target
        : visitedPassThrough && val !== args.passThrough;
      if (shouldResolve) {
        finish(() => resolve(val));
      }
    });
    actor.start();
    // The initial snapshot fires synchronously during start(); if it
    // already satisfies the target (e.g., BOSS_INTERRUPT targetId='ready'
    // with starting value 'ready'), the actor is already stopped and
    // sending would emit a "stopped actor" warning.
    if (!settled) actor.send(args.event);
  });
}

const states = enumerateCaptainStates(codingMachine);
const rootEvents = enumerateRootEvents(codingMachine);

describe('edge coverage — onDone arms', () => {
  for (const state of states) {
    for (const transition of state.transitions) {
      const key = `${state.stateId}#${transition.index}`;
      it(`${key} → ${transition.target}`, async () => {
        const fixture = fixtures.get(key);
        expect(fixture, `missing fixture for ${key}`).toBeDefined();

        // Pre-flight: assert the fixture satisfies *this* arm and
        // falsifies every earlier arm. xstate's `onDone` is
        // first-match-wins, so a fixture that also satisfies an
        // earlier same-target arm would silently fire that arm
        // instead — target-only assertion would still pass.
        const event = { output: fixture!.captainOutput };
        const ctx = (fixture!.context ?? {}) as CodingContext;
        expect(
          transition.guard({ context: ctx, event }),
          `${key}: fixture does not satisfy its arm's guard`,
        ).toBe(true);
        for (let i = 0; i < transition.index; i++) {
          const earlier = state.transitions[i];
          expect(
            earlier.guard({ context: ctx, event }),
            `${key}: fixture also satisfies earlier arm at index ${i} (→ ${earlier.target}); first-match-wins would fire that arm instead`,
          ).toBe(false);
        }

        const landed = await drive({
          context: fixture!.context,
          event: { type: 'BOSS_INTERRUPT', targetId: state.stateId as never },
          behavior: fixture!.captainOutput,
          passThrough: state.stateId,
        });
        expect(landed).toBe(transition.target);
      });
    }
  }
});

describe('edge coverage — onError → failed', () => {
  for (const state of states) {
    it(`${state.stateId} captain throw → failed`, async () => {
      const landed = await drive({
        event: { type: 'BOSS_INTERRUPT', targetId: state.stateId as never },
        behavior: 'throw',
        passThrough: state.stateId,
      });
      expect(landed).toBe('failed');
    });
  }
});

describe('edge coverage — root events', () => {
  it(`START_CODING → ${rootEvents.startCoding.target}`, async () => {
    const landed = await drive({
      event: { type: 'START_CODING', intent: 'test' },
      behavior: 'hang',
      target: rootEvents.startCoding.target,
    });
    expect(landed).toBe(rootEvents.startCoding.target);
  });

  it(`CONTINUE_IR → ${rootEvents.continueIr.target}`, async () => {
    const landed = await drive({
      event: { type: 'CONTINUE_IR', irNumber: '001' },
      behavior: 'hang',
      target: rootEvents.continueIr.target,
    });
    expect(landed).toBe(rootEvents.continueIr.target);
  });

  it(`SUMMARIZE_IR → ${rootEvents.summarizeIr.target}`, async () => {
    const landed = await drive({
      event: { type: 'SUMMARIZE_IR', irNumber: '001' },
      behavior: 'hang',
      target: rootEvents.summarizeIr.target,
    });
    expect(landed).toBe(rootEvents.summarizeIr.target);
  });

  for (const target of rootEvents.bossInterruptTargets) {
    it(`BOSS_INTERRUPT targetId=${target} → ${target}`, async () => {
      // Start at any non-target jumpable state so the interrupt
      // must actually route us. Otherwise (target='ready'), the
      // subscribe would resolve on the initial snapshot before
      // `actor.send` runs — a tautological pass.
      const from = target === 'ready' ? 'planAndImplement' : 'ready';
      const landed = await drive({
        from,
        event: { type: 'BOSS_INTERRUPT', targetId: target as never },
        behavior: 'hang',
        target,
      });
      expect(landed).toBe(target);
    });
  }
});

describe('edge coverage — structural', () => {
  it('every helper-enumerated onDone arm has a fixture', () => {
    const missing: string[] = [];
    for (const s of states) {
      for (const t of s.transitions) {
        const key = `${s.stateId}#${t.index}`;
        if (!fixtures.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('no fixture is unused (all fixtures map to an enumerated arm)', () => {
    const enumerated = new Set<string>();
    for (const s of states) {
      for (const t of s.transitions) {
        enumerated.add(`${s.stateId}#${t.index}`);
      }
    }
    const unused: string[] = [];
    for (const key of fixtures.keys()) {
      if (!enumerated.has(key)) unused.push(key);
    }
    expect(unused).toEqual([]);
  });

  it('total fixture count equals the total `onDone` arm count', () => {
    const armCount = states.reduce((sum, s) => sum + s.transitions.length, 0);
    expect(fixtures.size).toBe(armCount);
  });
});
