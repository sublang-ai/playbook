// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { codingMachine, type CodingContext } from './code.fsm.js';
import {
  enumerateAwaitBossReply,
  enumerateNestedPlaybookStates,
  enumeratePlayerStates,
  enumerateRootEvents,
} from './code.fsm.introspect.js';

const CONTEXT: CodingContext = {
  runResults: 'unit tests passed',
  callerInput: 'Implement the intent.',
  coderOutput: 'Committed.\nCommit: abc123',
  latestCommit: 'abc123',
  irNumber: '040',
  irTask: 'Implement task 1.',
};

describe('CODE FSM introspection', () => {
  it('enumerates the two Coder states with exact GEARS identity', () => {
    const states = enumeratePlayerStates(codingMachine);
    expect(states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem }))).toEqual([
      { stateId: 'runFirstPhase', sourceItem: 'CODE-1' },
      { stateId: 'runIrTask', sourceItem: 'CODE-3' },
    ]);
    expect(states.map((state) => state.getInput(CONTEXT).role)).toEqual([
      'coder',
      'coder',
    ]);
  });

  it('enumerates both literal REVIEW calls and their exact inputs', () => {
    const states = enumerateNestedPlaybookStates(codingMachine);
    expect(states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem }))).toEqual([
      { stateId: 'reviewFirstCommit', sourceItem: 'CODE-2' },
      { stateId: 'reviewIrTask', sourceItem: 'CODE-4' },
    ]);
    expect(states.map((state) => state.getInput(CONTEXT))).toEqual([
      {
        stateId: 'reviewFirstCommit',
        sourceItem: 'CODE-2',
        playbookId: 'review',
        text:
          '> Initial intent: Implement the intent.\n' +
          '> Coder output: Committed.\n> Commit: abc123',
      },
      {
        stateId: 'reviewIrTask',
        sourceItem: 'CODE-4',
        playbookId: 'review',
        text:
          '> IR task: Implement task 1.\n' +
          '> Coder output: Committed.\n> Commit: abc123',
      },
    ]);
  });

  it('exposes one entry, empty-reply failure, and two resume arms', () => {
    expect(enumerateRootEvents(codingMachine)).toEqual({
      startCode: { target: 'runFirstPhase' },
    });
    expect(
      enumerateAwaitBossReply(codingMachine).bossReplyTransitions.map(
        ({ target }) => target,
      ),
    ).toEqual(['failed', 'runFirstPhase', 'runIrTask']);
  });
});
