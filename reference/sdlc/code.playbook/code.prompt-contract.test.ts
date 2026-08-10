// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import type { PlayerInput } from './code.fsm.js';
import { _internal } from './code.playbook.js';

const { composePlayerPrompt } = _internal;

function firstInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    stateId: 'runFirstPhase',
    player: 'Coder',
    sourceItem: 'CODE-1',
    prompt: [
      '> <caller-input>',
      '> <run-results>',
      '',
      'Implement the phase.',
      'Coder is <coder-llm>.',
    ].join('\n'),
    result: { directCommit: 'done' },
    callerInput: 'line one\nline two',
    runResults: 'test one\ntest two',
    coderPlayer: 'GPT-5.6 Sol',
    ...overrides,
  };
}

describe('CODE player prompt composition', () => {
  it('keeps every line of relayed values inside Markdown quotes', () => {
    expect(composePlayerPrompt(firstInput())).toBe(
      [
        '> line one',
        '> line two',
        '> test one',
        '> test two',
        '',
        'Implement the phase.',
        'Coder is GPT-5.6 Sol.',
      ].join('\n'),
    );
  });

  it('omits the optional run-results relay when none exists', () => {
    const prompt = composePlayerPrompt(firstInput({ runResults: '' }));
    expect(prompt).not.toContain('<run-results>');
    expect(prompt).not.toContain('\n> \n');
    expect(prompt).toContain('> line one\n> line two');
  });

  it('substitutes IR task, IR number, and Coder identity once', () => {
    const input: PlayerInput = {
      stateId: 'runIrTask',
      player: 'Coder',
      sourceItem: 'CODE-3',
      prompt: [
        '> <ir-task>',
        'Read IR-<#>.',
        'Coder is <coder-llm>.',
      ].join('\n'),
      result: { finalTask: 'done' },
      callerInput: 'unused',
      runResults: '',
      coderPlayer: 'GPT-5.6 Sol',
      irNumber: '040',
      irTask: 'Use literal <coder-llm> and $&.\nThen finish.',
    };
    expect(composePlayerPrompt(input)).toBe(
      [
        '> Use literal <coder-llm> and $&.',
        '> Then finish.',
        'Read IR-040.',
        'Coder is GPT-5.6 Sol.',
      ].join('\n'),
    );
  });

  it('prepends the universal continuation before authored content', () => {
    const prompt = composePlayerPrompt(
      firstInput({
        pendingBossQuestion: {
          questionId: 'runFirstPhase',
          resumeStateId: 'runFirstPhase',
          sourceItem: 'CODE-1',
          player: 'Coder',
          question: 'Which branch?',
        },
        bossReply: 'Use the narrow branch.',
      }),
    );
    expect(prompt).toMatch(
      /^You previously paused this task[\s\S]*Boss question:\nWhich branch\?\n\nBoss reply:\nUse the narrow branch\.\n\n> line one/,
    );
  });
});
