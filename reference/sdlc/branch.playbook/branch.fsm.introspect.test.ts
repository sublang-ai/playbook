// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { branchMachine, type BranchContext } from './branch.fsm.js';
import {
  enumerateAwaitBossReply,
  enumeratePlayerStates,
  enumerateRootEvents,
} from './branch.fsm.introspect.js';

const CONTEXT: BranchContext = {
  callerInput: 'Fix #12: the retry loop never backs off.',
  branch: 'issue-12-fix-retry',
  baseRevision: '1111111111111111111111111111111111111111',
  issueSummary: 'Issue #12 asks for exponential backoff with jitter.',
};

describe('BRANCH FSM introspection', () => {
  it('enumerates the one Coder state with exact GEARS identity', () => {
    const states = enumeratePlayerStates(branchMachine);
    expect(
      states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([{ stateId: 'createBranch', sourceItem: 'BRANCH-1' }]);
    expect(states.map((state) => state.getInput(CONTEXT).role)).toEqual([
      'coder',
    ]);
    expect(states[0]?.getInput(CONTEXT).callerInput).toBe(
      'Fix #12: the retry loop never backs off.',
    );
    expect(states[0]?.transitions.map(({ target }) => target)).toEqual([
      'branched',
      'refused',
      'awaitBossReply',
      'failed',
    ]);
  });

  it('exposes one entry, empty-reply failure, and one resume arm', () => {
    expect(enumerateRootEvents(branchMachine)).toEqual({
      startBranch: { target: 'createBranch' },
    });
    expect(
      enumerateAwaitBossReply(branchMachine).bossReplyTransitions.map(
        ({ target }) => target,
      ),
    ).toEqual(['failed', 'createBranch']);
  });
});
