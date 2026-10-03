// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assign, createMachine } from 'xstate';
import { expect, it } from 'vitest';
import { createWorktreeHostCapabilities } from '../reference/sdlc/code.playbook/host-capabilities.js';
import type { PlaybookPorts, PlaybookSession } from './runtime.js';
import { createXStatePlaybookRuntime, RUNTIME_ABI } from './xstate-playbook-runtime.js';

const id = 'reply-retention';
const questionText = 'Approve this proposed scope?';
const question = {
  questionId: 'approval', resumeStateId: 'approval', sourceItem: 'RETAIN-1',
  asker: { kind: 'role' as const, roleId: 'coordinator' }, question: questionText,
};
const meta = (stateId: string, role?: string, terminal?: 'success' | 'failure') => ({
  playbook: { stateId, description: stateId, ...(role ? { role } : {}),
    ...(terminal ? { terminal } : {}) },
});
const results = {
  approved: 'Boss gave an affirmative answer to the summarized scope in this conversation; a proposal or ambiguous answer does not support approval.',
  refused: 'Boss refused this proposed scope.',
  needsBossReply: 'The acting agent needs a Boss answer. Output shall include `question: <verbatim question text>`.',
};
function matched(context: { pendingBossQuestion?: typeof question; bossReply?: string }) {
  const q = context.pendingBossQuestion;
  return q?.questionId === 'approval' && q.resumeStateId === 'approval' &&
    q.sourceItem === 'RETAIN-1' && q.asker.kind === 'role' &&
    q.asker.roleId === 'coordinator' && typeof context.bossReply === 'string' &&
    context.bossReply.trim().length > 0;
}
const clear = assign({ pendingBossQuestion: () => undefined, bossReply: () => undefined });
const machine = createMachine({
  id,
  context: { pendingBossQuestion: undefined as typeof question | undefined,
    bossReply: undefined as string | undefined, approvalAnswer: undefined as string | undefined },
  initial: 'ready',
  output: ({ context }) => ({ approvalAnswer: context.approvalAnswer ?? null, questionCleared: context.pendingBossQuestion === undefined, replyCleared: context.bossReply === undefined }),
  states: {
    ready: { tags: ['playbook.parked'], meta: meta('ready'), on: { START: 'approval' } },
    approval: {
      tags: ['playbook.busy'], meta: meta('approval', 'coordinator'),
      invoke: {
        src: 'player', input: ({ context }) => ({ stateId: 'approval', role: 'coordinator',
          sourceItem: 'RETAIN-1', prompt: 'Evaluate the current scope answer.', result: results,
          pendingBossQuestion: context.pendingBossQuestion, bossReply: context.bossReply }),
        onDone: [
          { guard: ({ event }) => event.output?.guard === 'needsBossReply', target: 'awaitBossReply',
            actions: [
              { type: 'playbook.acceptedOutcome', params: { source: 'approval', target: 'awaitBossReply', acceptedOutcome: 'needsBossReply' } },
              assign({ pendingBossQuestion: ({ event }) => ({ ...question, question: event.output.question }), bossReply: () => undefined }),
            ] },
          { guard: ({ context, event }) => matched(context) && event.output?.guard === 'approved', target: 'relay',
            actions: [
              { type: 'playbook.acceptedOutcome', params: { source: 'approval', target: 'relay', acceptedOutcome: 'approved' } },
              assign({ approvalAnswer: ({ context }) => context.bossReply }), clear,
            ] },
          { guard: ({ context, event }) => matched(context) && event.output?.guard === 'refused', target: 'refused',
            actions: [{ type: 'playbook.acceptedOutcome', params: { source: 'approval', target: 'refused', acceptedOutcome: 'refused' } }, clear] },
          { target: 'failed', actions: clear },
        ], onError: { target: 'failed', actions: clear },
      },
    },
    awaitBossReply: {
      tags: ['playbook.parked'], meta: meta('awaitBossReply'), on: { BOSS_REPLY: {
        guard: ({ context, event }) => typeof event.answer === 'string' && event.answer.trim().length > 0 &&
          context.pendingBossQuestion !== undefined && event.questionId === context.pendingBossQuestion.questionId,
        target: 'approval', actions: assign({ bossReply: ({ event }) => event.answer }),
      } },
    },
    relay: {
      tags: ['playbook.busy'], meta: meta('relay', 'coordinator'),
      invoke: { src: 'player', input: ({ context }) => ({ stateId: 'relay', role: 'coordinator',
        sourceItem: 'RETAIN-2', prompt: 'Use this complete approved answer:\n<approvalAnswer>',
        approvalAnswer: context.approvalAnswer, result: { done: 'The read-only handoff is complete.' } }),
        onDone: { target: 'done', actions: { type: 'playbook.acceptedOutcome', params: { source: 'relay', target: 'done', acceptedOutcome: 'done' } } },
        onError: 'failed' },
    },
    done: { type: 'final', meta: meta('done', undefined, 'success') },
    refused: { type: 'final', meta: meta('refused', undefined, 'failure') },
    failed: { tags: ['playbook.parked'], meta: meta('failed') },
  },
}, { actions: { 'playbook.acceptedOutcome': () => undefined } });

const createRuntime = createXStatePlaybookRuntime(machine, {
  label: id, compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}), entryEvent: { type: 'START', textField: 'task' },
  roleStates: { approval: { role: 'coordinator', label: 'approval' }, relay: { role: 'coordinator', label: 'relay' } },
  classifyBossText: async text => ({ type: 'BOSS_REPLY', questionId: 'approval', answer: text }),
  verbatimPayloadFields: new Set(['question']),
  outcomeAuthority: { governedPlayerStates: {
    approval: {
      approved: { fields: {}, repositoryDisposition: 'unchanged' },
      refused: { fields: {}, repositoryDisposition: 'unchanged' },
      needsBossReply: { fields: { question: 'presentation' }, repositoryDisposition: 'unchanged' },
    }, relay: { done: { fields: {}, repositoryDisposition: 'unchanged' } },
  } },
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'playbook-boss-reply-retention-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Reply Retention Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  const capabilities = await createWorktreeHostCapabilities({ cwd, playbookId: id, requiredRoleIds: ['coordinator'] });
  const prompts: string[] = [];
  let candidate: object = { guard: 'approved' };
  const ports: PlaybookPorts = {
    callPlayer: async (_role, prompt) => {
      prompts.push(prompt);
      return { status: 'ok', finalText: prompts.length === 1 ? questionText : 'Read-only evaluation complete.' };
    },
    callJudge: async () => JSON.stringify(prompts.length === 1 ? { guard: 'needsBossReply' } : prompts.length === 2 ? candidate : { guard: 'done' }),
    callCaptain: async () => { throw new Error('unexpected Captain'); },
    callPlaybook: async () => { throw new Error('unexpected child'); },
    emitStatus: async () => {}, emitTelemetry: async () => {},
  };
  const sid = randomUUID();
  const session: PlaybookSession = { sessionId: sid, rootSessionId: sid, playbookId: id, depth: 0,
    roleBindings: { coordinator: { playerId: 'fixture.coordinator', promptIdentity: 'Fixture Coordinator' } }, ports };
  const runtime = createRuntime({ configuredOptions: {}, hostCapabilities: capabilities });
  await runtime.init(session);
  const turn = (text: string) => runtime.handleBossInput({ text, signal: new AbortController().signal });
  expect(await turn('Evaluate this scope.')).toMatchObject({ outcome: 'quiescent', state: { stateId: 'awaitBossReply' } });
  expect(runtime.describe().pendingQuestions).toEqual([{ questionId: 'approval', sourceItem: 'RETAIN-1', asker: question.asker, question: questionText }]);
  return { runtime, session, capabilities, prompts, git, head, turn, setCandidate: (next: object) => { candidate = next; },
    async dispose() { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); } };
}

it.each(['Approve exactly this scope.\n', '  同意本范围。\r\n\r\nKeep $& and <literal>.\r\n '])(
  'retains canonical approved input through clearing and a later real governed call: %j', async answer => {
    const f = await fixture();
    try {
      expect(await f.turn(answer)).toMatchObject({ outcome: 'terminal', state: { stateId: 'done' }, output: { approvalAnswer: answer, questionCleared: true, replyCleared: true } });
      expect(f.prompts[2]).toBe('Use this complete approved answer:\n' + answer);
      expect(f.capabilities.effectLedger.snapshot().boundaries.map(b => b.physicalReceipt?.classification)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      expect(f.git('rev-parse', 'HEAD')).toBe(f.head); expect(f.git('status', '--porcelain')).toBe('');
    } finally { await f.dispose(); }
  },
);

it.each([
  ['different echo', { guard: 'approved', approvalAnswer: 'Approve a different scope.' }, 'failed'],
  ['exact echo', { guard: 'approved', approvalAnswer: 'Approve this scope.\n' }, 'failed'],
  ['malformed result', { guard: 'unknown' }, 'failed'],
  ['semantic refusal', { guard: 'refused' }, 'refused'],
] as const)('starts no later call for %s', async (_name, candidate, expected) => {
  const f = await fixture();
  try {
    f.setCandidate(candidate);
    const result = await f.turn('Approve this scope.\n');
    expect(result).toMatchObject({ state: { stateId: expected } });
    expect(f.prompts).toHaveLength(2);
    if (result.outcome === 'terminal') expect(result.output).toMatchObject({ approvalAnswer: null });
    else expect((f.runtime.exportSnapshot!()!.machine.context as Record<string, unknown>).approvalAnswer).toBeUndefined();
    expect(f.git('rev-parse', 'HEAD')).toBe(f.head); expect(f.git('status', '--porcelain')).toBe('');
  } finally { await f.dispose(); }
});

it.each(['questionId', 'asker', 'sourceItem', 'absentQuestion'] as const)('confers no retained approval or later call with restored stale %s authority', async field => {
  const f = await fixture();
  try {
    const snapshot = JSON.parse(JSON.stringify(f.runtime.exportSnapshot!()));
    const q = snapshot.machine.context.pendingBossQuestion;
    if (field === 'asker') q.asker.roleId = 'other';
    else if (field === 'absentQuestion') { delete snapshot.machine.context.pendingBossQuestion; snapshot.machine.context.bossReply = 'Historical approval'; }
    else q[field] = 'stale';
    await f.runtime.dispose();
    const restored = createRuntime({ configuredOptions: {}, hostCapabilities: f.capabilities });
    try {
      await restored.restore!(f.session, snapshot);
      const result = await restored.handleBossInput({ text: 'Approve this scope.\n', signal: new AbortController().signal });
      expect(result.state.stateId).not.toBe('done');
      expect(f.prompts.length).toBeLessThanOrEqual(2);
      expect(f.prompts.every(p => !p.startsWith('Use this complete approved answer:'))).toBe(true);
      expect((restored.exportSnapshot!()!.machine.context as Record<string, unknown>).approvalAnswer).toBeUndefined();
    } finally { await restored.dispose(); }
  } finally { await f.dispose(); }
});

it('retains no approval for an empty reply and ships the matching compiler lifecycle', async () => {
  const f = await fixture();
  try {
    expect(await f.turn('\n  ')).toMatchObject({ outcome: 'no-action', state: { stateId: 'awaitBossReply' } });
    expect(f.prompts).toHaveLength(1);
    expect((f.runtime.exportSnapshot!()!.machine.context as Record<string, unknown>).approvalAnswer).toBeUndefined();
    const text = readFileSync(new URL('../slc/text2gears.md', import.meta.url), 'utf8');
    const fsm = readFileSync(new URL('../slc/gears2fsm.md', import.meta.url), 'utf8');
    expect(text).toContain('do not declare\na Judge-extracted echo property');
    expect(text).toContain('The semantic approval or refusal stays\nin the acting result contract');
    expect(fsm).toContain('before clearing that leaf\'s Q/A');
    expect(fsm).toContain('blank lines and trailing separators');
  } finally { await f.dispose(); }
});
