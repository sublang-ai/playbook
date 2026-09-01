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

  it('enumerates the three literal child calls and their exact inputs', () => {
    const states = enumerateNestedPlaybookStates(devMachine);
    expect(
      states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([
      { stateId: 'callCode', sourceItem: 'DEV-2' },
      { stateId: 'callDecide', sourceItem: 'DEV-3' },
      { stateId: 'callCodeAfterDecide', sourceItem: 'DEV-4' },
    ]);
    const planningRelay =
      '> Plan the request.\n' +
      '> Analyst question: Narrow or broad?\n' +
      '> Boss reply: Narrow.\n' +
      '> Proceed with code.';
    expect(states.map((state) => state.getInput(CONTEXT))).toEqual([
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
        text: `${planningRelay}\n> decide123\n> rev456`,
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
