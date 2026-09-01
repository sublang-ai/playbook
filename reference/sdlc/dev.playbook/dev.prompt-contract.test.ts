// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import {
  devMachine,
  renderDiscussionContext,
  type DevContext,
  type PlayerInput,
} from './dev.fsm.js';
import { enumeratePlayerStates } from './dev.fsm.introspect.js';
import { _internal } from './dev.playbook.js';

const { composePlayerPrompt } = _internal;

const ACTUAL_CONTEXT: DevContext = {
  runResults: 'tests passed',
  developmentRequest: 'Plan the request.',
  discussionExchanges: [
    { question: 'Narrow or broad?', answer: 'Narrow.' },
  ],
};

function planInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    stateId: 'planAnalysis',
    role: 'analyst',
    sourceItem: 'DEV-1',
    prompt: [
      '> <development-request>',
      '> <discussion-context>',
      '> <run-results>',
      '',
      'Plan the smallest sound next step.',
    ].join('\n'),
    result: { code: 'done' },
    developmentRequest: 'line one\nline two',
    discussionContext: 'Analyst question: Which?\nBoss reply: The first.',
    runResults: 'test one\ntest two',
    ...overrides,
  };
}

describe('DEV player prompt composition', () => {
  it('forbids repository changes in the authored planning prompt', () => {
    for (const state of enumeratePlayerStates(devMachine)) {
      const input = state.getInput(ACTUAL_CONTEXT);
      expect(input.prompt).toContain(
        'Do not change files or commit while planning or discussing the request.',
      );
      expect(composePlayerPrompt(input)).toContain(
        'Do not change files or commit while planning or discussing the request.',
      );
    }
  });

  it('keeps every line of relayed values inside Markdown quotes', () => {
    expect(composePlayerPrompt(planInput())).toBe(
      [
        '> line one',
        '> line two',
        '> Analyst question: Which?',
        '> Boss reply: The first.',
        '> test one',
        '> test two',
        '',
        'Plan the smallest sound next step.',
      ].join('\n'),
    );
  });

  it('omits the optional relays when no value exists yet', () => {
    const prompt = composePlayerPrompt(
      planInput({ discussionContext: '', runResults: '' }),
    );
    expect(prompt).not.toContain('<discussion-context>');
    expect(prompt).not.toContain('<run-results>');
    expect(prompt).not.toContain('\n> \n');
    expect(prompt).toContain('> line one\n> line two\n\nPlan');
  });

  it('feeds the machine-tracked discussion context into the relay', () => {
    const state = enumeratePlayerStates(devMachine)[0]!;
    const input = state.getInput(ACTUAL_CONTEXT);
    expect(input.discussionContext).toBe(
      renderDiscussionContext(ACTUAL_CONTEXT.discussionExchanges),
    );
    expect(composePlayerPrompt(input)).toContain(
      '> Analyst question: Narrow or broad?\n> Boss reply: Narrow.',
    );
  });

  it('prepends the universal continuation before authored content', () => {
    const prompt = composePlayerPrompt(
      planInput({
        pendingBossQuestion: {
          questionId: 'planAnalysis',
          resumeStateId: 'planAnalysis',
          sourceItem: 'DEV-1',
          asker: { kind: 'role', roleId: 'analyst' },
          question: 'Which scope?',
        },
        bossReply: 'Use the narrow scope.',
      }),
    );
    expect(prompt).toMatch(
      /^You previously paused this task[\s\S]*Boss question:\nWhich scope\?\n\nBoss reply:\nUse the narrow scope\.\n\n> line one/,
    );
  });
});
