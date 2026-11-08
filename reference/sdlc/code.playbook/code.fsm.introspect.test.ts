// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { codeMachine, type CodeContext } from './code.fsm.js';
import {
  enumerateAwaitBossReply,
  enumerateNestedPlaybookStates,
  enumeratePlayerStates,
  enumerateRootEvents,
} from './code.fsm.introspect.js';

const CONTEXT: CodeContext = {
  runResults: 'unit tests passed',
  callerInput: 'Implement the intent.',
  coderOutput: 'Committed the requested change.',
  codeCommit: 'abc123',
  codeCommits: ['abc000', 'abc123'],
  irNumber: '040',
  irTask: 'Implement task 1.',
};

describe('CODE FSM introspection', () => {
  it('enumerates the two Coder states with exact GEARS identity', () => {
    const states = enumeratePlayerStates(codeMachine);
    expect(states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem }))).toEqual([
      { stateId: 'firstPhase', sourceItem: 'CODE-1' },
      { stateId: 'irTaskPhase', sourceItem: 'CODE-2' },
    ]);
    expect(states.map((state) => state.getInput(CONTEXT).role)).toEqual([
      'coder',
      'coder',
    ]);
  });

  it('enumerates the one literal REVIEW call and its exact input', () => {
    const states = enumerateNestedPlaybookStates(codeMachine);
    expect(states.map(({ stateId, sourceItem }) => ({ stateId, sourceItem }))).toEqual([
      { stateId: 'reviewIntent', sourceItem: 'CODE-3' },
    ]);
    // DR-102: the scope names every phase commit oldest first, and an IR
    // relays its number as the Source's second, separate quote block.
    expect(states.map((state) => state.getInput(CONTEXT))).toEqual([
      {
        stateId: 'reviewIntent',
        sourceItem: 'CODE-3',
        playbookId: 'review',
        text:
          '> Original intent: Implement the intent.\n' +
          '> Review scope: every commit of this coding intent, namely abc000, abc123, and its resulting repository state.\n' +
          '> Coder output: Committed the requested change.\n' +
          '\n' +
          '> IR number: 040',
      },
    ]);
    // A direct intent relays no IR block.
    expect(
      states[0]?.getInput({ ...CONTEXT, codeCommits: ['abc123'], irNumber: undefined }).text,
    ).toBe(
      '> Original intent: Implement the intent.\n' +
        '> Review scope: every commit of this coding intent, namely abc123, and its resulting repository state.\n' +
        '> Coder output: Committed the requested change.',
    );
  });

  it('exposes one entry, empty-reply failure, and two resume arms', () => {
    expect(enumerateRootEvents(codeMachine)).toEqual({
      startCode: { target: 'firstPhase' },
    });
    expect(
      enumerateAwaitBossReply(codeMachine).bossReplyTransitions.map(
        ({ target }) => target,
      ),
    ).toEqual(['failed', 'firstPhase', 'irTaskPhase']);
  });
});
