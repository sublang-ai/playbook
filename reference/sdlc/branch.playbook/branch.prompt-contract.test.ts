// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseGearsContract } from '../../../scripts/check-slc-source-gears.mjs';
import {
  branchMachine,
  type BranchContext,
  type PlayerInput,
} from './branch.fsm.js';
import { enumeratePlayerStates } from './branch.fsm.introspect.js';
import { _internal } from './branch.playbook.js';

// BRANCH declares no prompt-identity placeholder, so the lookup is never read.
const promptIdentity = (roleId: string): string => roleId;
const composePlayerPrompt = (input: PlayerInput, resuming?: boolean): string =>
  _internal.composePlayerPrompt(input, promptIdentity, resuming);

const gearsItem = parseGearsContract(
  readFileSync(
    fileURLToPath(new URL('./branch.gears.md', import.meta.url)),
    'utf8',
  ),
).find(({ id }) => id === 'branch-1');

const ACTUAL_CONTEXT: BranchContext = {
  callerInput: 'Fix #12: the retry loop never backs off.\nKeep the CLI stable.',
};

function branchInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    stateId: 'createBranch',
    role: 'coder',
    sourceItem: 'BRANCH-1',
    prompt: [
      'Prepare a new branch for this work.',
      '',
      '> Original request: <caller-input>',
    ].join('\n'),
    result: { branched: 'done' },
    callerInput: 'line one\nline two',
    ...overrides,
  };
}

describe('BRANCH player prompt composition', () => {
  it('forbids file changes and commits in the authored branching prompt', () => {
    for (const state of enumeratePlayerStates(branchMachine)) {
      const input = state.getInput(ACTUAL_CONTEXT);
      for (const line of [
        'Prepare a new branch for this work without changing any file or making any commit.',
        'Create the branch from the current commit and check it out; do not pull, reset, stash, or move HEAD to another commit.',
        'If the request could refer to more than one issue, or does not say which work to branch for, ask Boss before creating anything.',
      ]) {
        expect(input.prompt).toContain(line);
        expect(composePlayerPrompt(input)).toContain(line);
      }
    }
  });

  it('keeps every line of the relayed caller input inside Markdown quotes', () => {
    expect(composePlayerPrompt(branchInput())).toBe(
      [
        'Prepare a new branch for this work.',
        '',
        '> Original request: line one',
        '> line two',
      ].join('\n'),
    );
  });

  it('composes the GEARS body with the machine-tracked caller input relayed last', () => {
    const state = enumeratePlayerStates(branchMachine)[0]!;
    const input = state.getInput(ACTUAL_CONTEXT);
    expect(input.callerInput).toBe(ACTUAL_CONTEXT.callerInput);
    const prompt = composePlayerPrompt(input);
    // The whole prompt is the GEARS blockquote body, instructions first as
    // the prefix pass left them (DR-065), with the relayed value substituted
    // and every continuation line kept inside the authored quote.
    const body = gearsItem?.prompt.join('\n');
    expect(body).toBeDefined();
    expect(prompt).toBe(
      body!.replace(
        '<caller-input>',
        'Fix #12: the retry loop never backs off.\n> Keep the CLI stable.',
      ),
    );
    expect(prompt).toMatch(
      /^Prepare a new branch for this work without changing any file or making any commit\.\n/,
    );
    expect(prompt).toMatch(
      /\.\n\n> Original request: Fix #12: the retry loop never backs off\.\n> Keep the CLI stable\.$/,
    );
    expect(prompt).not.toContain('<caller-input>');
    expect(prompt).not.toContain('Output shall include');
  });

  it('substitutes placeholders literally without recursive substitution', () => {
    const prompt = composePlayerPrompt(
      branchInput({ callerInput: 'Fix <caller-input> and $& in #12' }),
    );
    expect(prompt).toBe(
      [
        'Prepare a new branch for this work.',
        '',
        '> Original request: Fix <caller-input> and $& in #12',
      ].join('\n'),
    );
  });

  it('prepends the universal continuation before authored content', () => {
    const pendingBossQuestion = {
      questionId: 'createBranch',
      resumeStateId: 'createBranch',
      sourceItem: 'BRANCH-1',
      asker: { kind: 'role', roleId: 'coder' },
      question: 'Which issue?',
    } as const;
    const fresh = composePlayerPrompt(
      branchInput({ pendingBossQuestion, bossReply: 'Issue #12.' }),
    );
    expect(fresh).toMatch(
      /^Continue the same task[\s\S]*Your previous question:\nWhich issue\?\n\nBoss reply:\nIssue #12\.\n\nPrepare a new branch for this work\.\n\n> Original request: line one/,
    );
    const resumed = composePlayerPrompt(
      branchInput({ pendingBossQuestion, bossReply: 'Issue #12.' }),
      true,
    );
    expect(resumed).not.toContain('Your previous question:');
    expect(resumed).toContain('Boss reply:\nIssue #12.');
    expect(resumed).toContain('> Original request: line one\n> line two');
  });
});
