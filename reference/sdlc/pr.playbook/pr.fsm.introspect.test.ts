// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { prMachine, type PrContext } from './pr.fsm.js';
import {
  enumerateAwaitBossReply,
  enumerateNestedPlaybookStates,
  enumeratePlayerStates,
  enumerateRootEvents,
  enumerateScriptStates,
} from './pr.fsm.introspect.js';

const CONTEXT: PrContext = {
  callerInput: 'Deliver the reviewed branch for issue #12.\nBranch: issue-12-fix-retry',
  pullRequest: '12',
  pullRequestUrl: 'https://github.com/acme/widgets/pull/12',
};

describe('PR FSM introspection', () => {
  it('enumerates the one Coder state with exact GEARS identity', () => {
    const states = enumeratePlayerStates(prMachine);
    expect(
      states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([{ stateId: 'openPullRequest', sourceItem: 'PR-1' }]);
    expect(states.map((state) => state.getInput(CONTEXT).role)).toEqual([
      'coder',
    ]);
    expect(states[0]?.getInput(CONTEXT).callerInput).toBe(CONTEXT.callerInput);
  });

  it('enumerates the one literal code call and its exact input', () => {
    const states = enumerateNestedPlaybookStates(prMachine);
    expect(
      states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([{ stateId: 'fixChecks', sourceItem: 'PR-3' }]);
    expect(states.map((state) => state.getInput(CONTEXT))).toEqual([
      {
        stateId: 'fixChecks',
        sourceItem: 'PR-3',
        playbookId: 'code',
        text: [
          '> Original request: Deliver the reviewed branch for issue #12.',
          '> Branch: issue-12-fix-retry',
          '> Pull request: https://github.com/acme/widgets/pull/12',
          "> Coding request: The pull request's checks are red on the checked-out branch. Inspect the failing checks with `gh pr checks` and `gh run view --log-failed`, fix their cause on this branch with a minimal change, and make the checks pass.",
        ].join('\n'),
      },
    ]);
  });

  it('enumerates the five script states in workflow order with static commands', () => {
    const states = enumerateScriptStates(prMachine);
    expect(
      states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2' },
      { stateId: 'publishFix', sourceItem: 'PR-4' },
      { stateId: 'waitForChecksAfterFix', sourceItem: 'PR-5' },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6' },
      { stateId: 'updateLocalDefault', sourceItem: 'PR-7' },
    ]);
    const inputs = states.map((state) => state.getInput(CONTEXT));
    for (const input of inputs) {
      expect(Object.keys(input).sort()).toEqual([
        'command',
        'result',
        'sourceItem',
        'stateId',
      ]);
      expect(Object.keys(input.result)).toHaveLength(2);
      expect(input.command).not.toMatch(/<[A-Za-z_$#][A-Za-z0-9_$#-]*>/);
    }
    // The two waits run the same static command under different guards.
    expect(inputs[0]?.command).toBe(inputs[2]?.command);
    expect(Object.keys(inputs[0]!.result)).toEqual([
      'checksPassed',
      'checksFailed',
    ]);
    expect(Object.keys(inputs[2]!.result)).toEqual([
      'checksPassed',
      'checksStillFailing',
    ]);
    expect(inputs[3]?.command).toBe(
      "pr=$(gh pr view --json url --jq .url) || exit 1\nbase=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name) || exit 1\n[ -n \"$pr\" ] && [ -n \"$base\" ] || exit 1\n[ \"$(gh pr view \"$pr\" --json baseRefName --jq .baseRefName)\" = \"$base\" ] || exit 1\ngh pr merge --merge --delete-branch --match-head-commit \"$(git rev-parse HEAD)\" || exit 1\n[ \"$(gh pr view \"$pr\" --json state --jq .state)\" = MERGED ] || exit 1\n[ \"$(git branch --show-current)\" = \"$base\" ]",
    );
    expect(inputs[4]?.command).toBe('git pull --ff-only');
    // A script input is ungoverned and agent-free: it carries no prompt and no role.
    expect(inputs.every((input) => !('prompt' in input) && !('role' in input))).toBe(true);
  });

  it('exposes one entry, empty-reply failure, and one resume arm', () => {
    expect(enumerateRootEvents(prMachine)).toEqual({
      startPr: { target: 'openPullRequest' },
    });
    expect(
      enumerateAwaitBossReply(prMachine).bossReplyTransitions.map(
        ({ target }) => target,
      ),
    ).toEqual(['failed', 'openPullRequest']);
  });
});
