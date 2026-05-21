// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// IR-005 Task 2 — unit tests for the FSM introspection helpers.

import { describe, expect, it } from 'vitest';

import { codingMachine } from './code.fsm.js';
import {
  enumerateCaptainStates,
  enumerateRootEvents,
} from './code.fsm.introspect.js';

const STATE_ID_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const SOURCE_ITEM_RE = /^CODE-(?:[1-9]|1[0-9])$/;
const KNOWN_PLAYERS = new Set(['Coder', 'Reviewer', 'Committer']);

describe('enumerateCaptainStates', () => {
  const states = enumerateCaptainStates(codingMachine);
  const knownStateIds = new Set(
    Object.keys(
      (codingMachine as unknown as { config: { states: Record<string, unknown> } }).config.states,
    ),
  );

  it('returns one entry per captain-invoking state (19 total)', () => {
    expect(states).toHaveLength(19);
  });

  it('every entry has a valid stateId, sourceItem, and getInput', () => {
    for (const s of states) {
      expect(s.stateId).toMatch(STATE_ID_RE);
      expect(s.sourceItem).toMatch(SOURCE_ITEM_RE);
      expect(typeof s.getInput).toBe('function');
    }
  });

  it('sourceItems cover CODE-1..19 exactly once each', () => {
    const seen = states.map((s) => s.sourceItem).sort();
    const expected = Array.from({ length: 19 }, (_, i) => `CODE-${i + 1}`).sort();
    expect(seen).toEqual(expected);
  });

  it('getInput returns a CaptainInput with a non-empty prompt, a known player, and a non-empty result map', () => {
    for (const s of states) {
      const input = s.getInput({});
      expect(input.sourceItem).toBe(s.sourceItem);
      expect(typeof input.prompt).toBe('string');
      expect(input.prompt.length).toBeGreaterThan(0);
      expect(KNOWN_PLAYERS.has(input.player)).toBe(true);
      expect(typeof input.result).toBe('object');
      expect(Object.keys(input.result).length).toBeGreaterThan(0);
    }
  });

  it('every state has at least one transition with a function guard and a known target', () => {
    for (const s of states) {
      expect(s.transitions.length).toBeGreaterThan(0);
      for (const t of s.transitions) {
        expect(t.target).toMatch(STATE_ID_RE);
        expect(t.target.startsWith('#')).toBe(false);
        expect(knownStateIds.has(t.target)).toBe(true);
        expect(typeof t.guard).toBe('function');
      }
    }
  });

  it('transition.index matches the arm position in the source onDone array', () => {
    for (const s of states) {
      s.transitions.forEach((t, i) => {
        expect(t.index).toBe(i);
      });
    }
  });

  it('the three states with same-target arms keep distinct indices per arm', () => {
    // Sentinel for the keying choice in Task 4's fixture table:
    // `(stateId, target)` is not unique, but `(stateId, index)` is.
    const collisions: Array<[stateId: string, target: string, count: number]> = [
      ['planAndImplement', 'commitCoderInitial', 2],
      ['commitCoderInitial', 'ready', 2],
      ['commitJoint', 'done', 2],
    ];
    for (const [stateId, target, count] of collisions) {
      const state = states.find((s) => s.stateId === stateId);
      expect(state, `${stateId} present in enumeration`).toBeDefined();
      const arms = state!.transitions.filter((t) => t.target === target);
      expect(arms).toHaveLength(count);
      const indices = arms.map((t) => t.index);
      expect(new Set(indices).size).toBe(arms.length);
    }
  });

  it('pins per-state transition counts (sentinel — bumps require updating this list)', () => {
    const counts = Object.fromEntries(
      states.map((s) => [s.stateId, s.transitions.length] as const),
    );
    expect(counts).toEqual({
      planAndImplement: 3,
      respondToReview: 11,
      continueIr: 3,
      summarizeSpecs: 3,
      reviewBossCommitSpecs: 4,
      reviewBossCommitCode: 4,
      reviewBossCommitMixed: 4,
      reviewIrTaskCommitSpecs: 4,
      reviewIrTaskCommitCode: 4,
      reviewIrTaskCommitMixed: 4,
      reviewChangesSpecs: 2,
      reviewChangesCode: 2,
      reviewChangesMixed: 2,
      reviewChangesAndChallengesSpecs: 2,
      reviewChangesAndChallengesCode: 2,
      reviewChangesAndChallengesMixed: 2,
      adjudicateChallenges: 5,
      commitCoderInitial: 8,
      commitJoint: 5,
    });
  });
});

describe('enumerateRootEvents', () => {
  const events = enumerateRootEvents(codingMachine);

  it('readyEvents targets match the FSM source', () => {
    expect(events.startCoding.target).toBe('planAndImplement');
    expect(events.continueIr.target).toBe('continueIr');
    expect(events.summarizeIr.target).toBe('summarizeSpecs');
  });

  it('bossInterruptTargets enumerates all 21 jumpable states without `#` prefixes', () => {
    expect(events.bossInterruptTargets).toEqual([
      'ready',
      'planAndImplement',
      'respondToReview',
      'continueIr',
      'summarizeSpecs',
      'reviewBossCommitSpecs',
      'reviewBossCommitCode',
      'reviewBossCommitMixed',
      'reviewIrTaskCommitSpecs',
      'reviewIrTaskCommitCode',
      'reviewIrTaskCommitMixed',
      'reviewChangesSpecs',
      'reviewChangesCode',
      'reviewChangesMixed',
      'reviewChangesAndChallengesSpecs',
      'reviewChangesAndChallengesCode',
      'reviewChangesAndChallengesMixed',
      'adjudicateChallenges',
      'commitCoderInitial',
      'commitJoint',
      'failed',
    ]);
  });
});
