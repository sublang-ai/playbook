// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { prMachine, type PrContext, type PlayerInput } from './pr.fsm.js';
import { enumeratePlayerStates } from './pr.fsm.introspect.js';
import { _internal } from './pr.playbook.js';

const { composePlayerPrompt } = _internal;

const ACTUAL_CONTEXT: PrContext = {
  callerInput:
    'Deliver the reviewed branch for issue #12.\nBranch: issue-12-fix-retry\nBase revision: 0123abcd',
};

function openInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    stateId: 'openPullRequest',
    role: 'coder',
    sourceItem: 'PR-1',
    prompt: [
      '> Original request: <caller-input>',
      '',
      'Publish the branch and open its pull request.',
    ].join('\n'),
    result: { opened: 'done' },
    callerInput: 'line one\nline two',
    ...overrides,
  };
}

describe('PR player prompt composition', () => {
  it('forbids file changes, commits, and force-pushes in the authored publication prompt', () => {
    for (const state of enumeratePlayerStates(prMachine)) {
      const input = state.getInput(ACTUAL_CONTEXT);
      for (const clause of [
        'without changing any file or making any commit.',
        'never force-push.',
        'Report the pull request number and URL exactly.',
      ]) {
        expect(input.prompt).toContain(clause);
        expect(composePlayerPrompt(input)).toContain(clause);
      }
    }
  });

  it('keeps every line of the relayed caller input inside its Markdown quote', () => {
    expect(composePlayerPrompt(openInput())).toBe(
      [
        '> Original request: line one',
        '> line two',
        '',
        'Publish the branch and open its pull request.',
      ].join('\n'),
    );
  });

  it('substitutes exactly the machine-tracked caller input into the relay', () => {
    const state = enumeratePlayerStates(prMachine)[0]!;
    const input = state.getInput(ACTUAL_CONTEXT);
    expect(input.callerInput).toBe(ACTUAL_CONTEXT.callerInput);
    const prompt = composePlayerPrompt(input);
    expect(prompt).toContain(
      '> Original request: Deliver the reviewed branch for issue #12.\n> Branch: issue-12-fix-retry\n> Base revision: 0123abcd\n\nPublish the branch',
    );
    expect(prompt).not.toContain('<caller-input>');
  });

  it('never re-substitutes placeholder-looking text inside a relayed value', () => {
    expect(
      composePlayerPrompt(openInput({ callerInput: 'keep <caller-input> literal' })),
    ).toBe(
      [
        '> Original request: keep <caller-input> literal',
        '',
        'Publish the branch and open its pull request.',
      ].join('\n'),
    );
  });

  it('prepends the universal continuation before authored content', () => {
    const prompt = composePlayerPrompt(
      openInput({
        pendingBossQuestion: {
          questionId: 'openPullRequest',
          resumeStateId: 'openPullRequest',
          sourceItem: 'PR-1',
          asker: { kind: 'role', roleId: 'coder' },
          question: 'Which remote is the GitHub remote?',
        },
        bossReply: 'Use origin.',
      }),
    );
    expect(prompt).toMatch(
      /^Continue the same task[\s\S]*Your previous question:\nWhich remote is the GitHub remote\?\n\nBoss reply:\nUse origin\.\n\n> Original request: line one/,
    );
  });
});
