// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseGearsContract } from '../../../scripts/check-slc-source-gears.mjs';
import {
  codeMachine,
  type CodeContext,
  type PlayerInput,
} from './code.fsm.js';
import { enumeratePlayerStates } from './code.fsm.introspect.js';
import { _internal } from './code.playbook.js';

const { composePlayerPrompt } = _internal;
const promptIdentity = (roleId: string): string =>
  roleId === 'coder' ? 'GPT-5.6 Sol' : roleId;
const RETIRED_COMMIT_RESPONSE_INSTRUCTION =
  'Report it as exactly one final-response line beginning `Commit: `, followed only by the exact commit identity.';

const gearsItems = parseGearsContract(
  readFileSync(fileURLToPath(new URL('./code.gears.md', import.meta.url)), 'utf8'),
);

const ACTUAL_CONTEXT: CodeContext = {
  runResults: 'tests passed',
  callerInput: 'Implement the intent.',
  coderOutput: 'Completed the preceding phase.',
  codeCommit: 'abc123',
  irNumber: '048',
  irTask: 'Implement task 14.',
};

function firstInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    stateId: 'firstPhase',
    role: 'coder',
    sourceItem: 'CODE-1',
    prompt: [
      '> Original request: <caller-input>',
      '> Run results: <run-results>',
      '',
      'Implement the phase.',
      'Credit every AI that contributed to this commit: Coder <coder-llm>.',
    ].join('\n'),
    result: { directCommit: 'done' },
    callerInput: 'line one\nline two',
    runResults: 'test one\ntest two',
    ...overrides,
  } as PlayerInput;
}

describe('CODE player prompt composition', () => {
  it('omits the retired Commit-line response format from every phase', () => {
    for (const state of enumeratePlayerStates(codeMachine)) {
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
        '> Original request: line one',
        '> line two',
        '> Run results: test one',
        '> test two',
        '',
        'Implement the phase.',
        'Credit every AI that contributed to this commit: Coder GPT-5.6 Sol.',
      ].join('\n'),
    );
  });

  it('composes each GEARS body with the machine-tracked values relayed last', () => {
    // The whole prompt is the GEARS blockquote body, instructions first as
    // the prefix pass left them (DR-065), with each relayed value
    // substituted from its own field and the Coder identity resolved.
    const context: CodeContext = {
      ...ACTUAL_CONTEXT,
      callerInput: 'Implement the intent.\nKeep the CLI stable.',
    };
    const states = enumeratePlayerStates(codeMachine);
    expect(states.map(({ sourceItem }) => sourceItem)).toEqual([
      'CODE-1',
      'CODE-3',
    ]);
    for (const state of states) {
      const body = gearsItems
        .find(({ id }) => id === state.sourceItem)
        ?.prompt.join('\n');
      expect(body).toBeDefined();
      const prompt = composePlayerPrompt(state.getInput(context), promptIdentity);
      expect(prompt).toBe(
        body!
          .replace('<caller-input>', 'Implement the intent.\n> Keep the CLI stable.')
          .replace('<ir-number>', '048')
          .replace('<run-results>', 'tests passed')
          .replace('<previous-phase-review>', 'No accepted prior-phase review is available.')
          .replace('<coder-llm>', 'GPT-5.6 Sol'),
      );
      expect(prompt).toMatch(
        /Coder GPT-5\.6 Sol\.\n\n> Original request: Implement the intent\.\n> Keep the CLI stable\.\n/,
      );
    }
  });

  it('omits the optional run-results relay when none exists', () => {
    const prompt = composePlayerPrompt(
      firstInput({ runResults: '' }),
      promptIdentity,
    );
    expect(prompt).not.toContain('<run-results>');
    expect(prompt).not.toContain('\n> \n');
    expect(prompt).toContain('> Original request: line one\n> line two');
  });

  it('substitutes caller input, IR number, and Coder identity once', () => {
    const input: PlayerInput = {
      stateId: 'irTaskPhase',
      role: 'coder',
      sourceItem: 'CODE-3',
      prompt: [
        '> Original request: <caller-input>',
        '> IR number: <ir-number>',
        '> Run results: <run-results>',
        '',
        'Read the identified IR.',
        'Credit every AI that contributed to this commit: Coder <coder-llm>.',
      ].join('\n'),
      result: { finalTask: 'done' },
      callerInput: 'Use literal <coder-llm> and $&.\nThen finish.',
      runResults: '',
      irNumber: '040',
      previousPhaseReview: 'No accepted prior-phase review is available.',
    };
    expect(composePlayerPrompt(input, promptIdentity)).toBe(
      [
        '> Original request: Use literal <coder-llm> and $&.',
        '> Then finish.',
        '> IR number: 040',
        '',
        'Read the identified IR.',
        'Credit every AI that contributed to this commit: Coder GPT-5.6 Sol.',
      ].join('\n'),
    );
  });

  it('prepends the universal continuation before authored content', () => {
    const prompt = composePlayerPrompt(
      firstInput({
        pendingBossQuestion: {
          questionId: 'firstPhase',
          resumeStateId: 'firstPhase',
          sourceItem: 'CODE-1',
          asker: { kind: 'role', roleId: 'coder' },
          question: 'Which branch?',
        },
        bossReply: 'Use the narrow branch.',
      }),
      promptIdentity,
    );
    expect(prompt).toMatch(
      /^Continue the same task[\s\S]*Your previous question:\nWhich branch\?\n\nBoss reply:\nUse the narrow branch\.\n\n> Original request: line one/,
    );
  });
});
