// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { devMachine, type DevContext } from './dev.fsm.js';
import {
  enumerateAwaitBossReply,
  enumerateNestedPlaybookStates,
  enumeratePlayerStates,
  enumerateRootEvents,
} from './dev.fsm.introspect.js';

const CONTEXT: DevContext = {
  runResults: 'unit tests passed',
  developmentRequest: 'Plan the request.',
  discussionExchanges: [{ question: 'Narrow or broad?', answer: 'Narrow.' }],
  planningResult: 'Proceed with code.',
  decideCommit: 'decide123',
  evaluatedRevision: 'rev456',
  deliveryViaPullRequest: true,
  pullRequestPath: 'code',
  branch: 'issue-12-flaky-retry',
  baseRevision: 'base789',
  issueSummary: 'Issue #12: the retry loops forever.',
  lastCodeCommit: 'code123',
  finalEvaluatedRevision: 'code-rev',
};

describe('DEV FSM introspection', () => {
  it('enumerates the one Analyst state with exact GEARS identity', () => {
    const states = enumeratePlayerStates(devMachine);
    expect(
      states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([{ stateId: 'planAnalysis', sourceItem: 'DEV-1' }]);
    expect(states.map((state) => state.getInput(CONTEXT).role)).toEqual([
      'analyst',
    ]);
  });

  it('enumerates the five literal child calls and their exact inputs', () => {
    const states = enumerateNestedPlaybookStates(devMachine);
    expect(
      states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([
      { stateId: 'createBranch', sourceItem: 'DEV-5' },
      { stateId: 'callCode', sourceItem: 'DEV-2' },
      { stateId: 'callDecide', sourceItem: 'DEV-3' },
      { stateId: 'callCodeAfterDecide', sourceItem: 'DEV-4' },
      { stateId: 'openPullRequest', sourceItem: 'DEV-6' },
    ]);
    const planningRelay =
      '> Original request: Plan the request.\n' +
      '> Prior discussion: Analyst question: Narrow or broad?\n' +
      '> Boss reply: Narrow.\n' +
      '> Planning result: Proceed with code.';
    expect(states.map((state) => state.getInput(CONTEXT))).toEqual([
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
        stateId: 'callDecide',
        sourceItem: 'DEV-3',
        playbookId: 'decide',
        text: planningRelay,
      },
      {
        stateId: 'callCodeAfterDecide',
        sourceItem: 'DEV-4',
        playbookId: 'code',
        text: `${planningRelay}\n> DECIDE commit: decide123\n> Evaluated revision: rev456`,
      },
      {
        stateId: 'openPullRequest',
        sourceItem: 'DEV-6',
        playbookId: 'pr',
        text: [
          '> Original request: Plan the request.',
          '> Issue summary: Issue #12: the retry loops forever.',
          '> Branch: issue-12-flaky-retry',
          '> Base revision: base789',
          '> CODE commit: code123',
          '> Evaluated revision: code-rev',
        ].join('\n'),
      },
    ]);
  });

  it('exposes one entry, empty-reply failure, and one resume arm', () => {
    expect(enumerateRootEvents(devMachine)).toEqual({
      startDev: { target: 'planAnalysis' },
    });
    expect(
      enumerateAwaitBossReply(devMachine).bossReplyTransitions.map(
        ({ target }) => target,
      ),
    ).toEqual(['failed', 'planAnalysis']);
  });
});
