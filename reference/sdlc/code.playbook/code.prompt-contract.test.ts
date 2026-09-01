// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import {
  codingMachine,
  type CodingContext,
  type PlayerInput,
} from './code.fsm.js';
import { enumeratePlayerStates } from './code.fsm.introspect.js';
import { _internal } from './code.playbook.js';

const { composePlayerPrompt } = _internal;
const promptIdentity = (roleId: string): string =>
  roleId === 'coder' ? 'GPT-5.6 Sol' : roleId;
const RETIRED_COMMIT_RESPONSE_INSTRUCTION =
  'Report it as exactly one final-response line beginning `Commit: `, followed only by the exact commit identity.';

const ACTUAL_CONTEXT: CodingContext = {
  runResults: 'tests passed',
  callerInput: 'Implement the intent.',
  coderOutput: 'Completed the preceding phase.',
  latestCommit: 'abc123',
  irNumber: '048',
  irTask: 'Implement task 14.',
};

function firstInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    stateId: 'runFirstPhase',
    role: 'coder',
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
    ...overrides,
  };
}

describe('CODE player prompt composition', () => {
  it('omits the retired Commit-line response format from every phase', () => {
    for (const state of enumeratePlayerStates(codingMachine)) {
      const input = state.getInput(ACTUAL_CONTEXT);
      expect(input.prompt).not.toContain(RETIRED_COMMIT_RESPONSE_INSTRUCTION);
      expect(composePlayerPrompt(input, promptIdentity)).not.toContain(
        RETIRED_COMMIT_RESPONSE_INSTRUCTION,
      );
    }
  });

  it('keeps every line of relayed values inside Markdown quotes', () => {
    expect(composePlayerPrompt(firstInput(), promptIdentity)).toBe(
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
    const prompt = composePlayerPrompt(
      firstInput({ runResults: '' }),
      promptIdentity,
    );
    expect(prompt).not.toContain('<run-results>');
    expect(prompt).not.toContain('\n> \n');
    expect(prompt).toContain('> line one\n> line two');
  });

  it('substitutes caller input, IR number, and Coder identity once', () => {
    const input: PlayerInput = {
      stateId: 'runIrTask',
      role: 'coder',
      sourceItem: 'CODE-3',
      prompt: [
        '> <caller-input>',
        '> <ir-number>',
        '> <run-results>',
        '',
        'Read the identified IR.',
        'Coder is <coder-llm>.',
      ].join('\n'),
      result: { finalTask: 'done' },
      callerInput: 'Use literal <coder-llm> and $&.\nThen finish.',
      runResults: '',
      irNumber: '040',
    };
    expect(composePlayerPrompt(input, promptIdentity)).toBe(
      [
        '> Use literal <coder-llm> and $&.',
        '> Then finish.',
        '> 040',
        '',
        'Read the identified IR.',
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
          asker: { kind: 'role', roleId: 'coder' },
          question: 'Which branch?',
        },
        bossReply: 'Use the narrow branch.',
      }),
      promptIdentity,
    );
    expect(prompt).toMatch(
      /^You previously paused this task[\s\S]*Boss question:\nWhich branch\?\n\nBoss reply:\nUse the narrow branch\.\n\n> line one/,
    );
  });
});
