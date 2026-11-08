// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// Deterministic provider boundary; real CODE, REVIEW, host and Git effects.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createEvent, type AgentAdapter, type AgentEvent, type AgentOptions } from '@sublang/cligent';
import { describe, expect, it } from 'vitest';
import codeEntry from './code.registry.js';
import reviewEntry from '../review.playbook/review.registry.js';
import { loadLaunchPlan } from './bin/launch-config.js';
import { executionConfigFromPlan } from './bin/run.js';
import { createSessionStore } from './session-store.js';
import { openSessionHost, type SessionHostController } from './session-host.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim();
type Scenario = 'pass' | 'restore' | 'transport-failed' | 'malformed-child' | 'record-maintenance';
const COMPLETED_IR = 'specs/intents/001-completed.md';
const COMPLETED_IR_TEXT = `# IR-001: Completed Work

## Status

Coder work complete; owner acceptance pending.

## Intent

Deliver the requested fixture behavior.

## Deliverables

- [x] Implement the requested behavior.

## Tasks

1. Implement the requested behavior.

## Verification

Completed Coder work is recorded in the fixture baseline.
`;
const AWAIT_ONE_REVIEW = 'The earlier phases of this intent await the one REVIEW that follows its final task';

interface Evidence {
  cwd: string; scenario: Scenario; marker: string; baselineCount: number;
  taskCommits: string[]; reviewRevision?: string;
  coderPrompts: string[]; allCoderPrompts: string[]; reviewerPrompts: string[];
  reviewers: number; subsequentCalls: number; records: any[];
}

function codeTerminal(evidence: Evidence) {
  return evidence.records
    .filter(r => r.type === 'captain_telemetry' && r.topic === 'playbook.trace')
    .map(r => r.payload)
    .find(r => r.playbookId === 'code' && r.type === 'boss.input.settled' && r.payload.outcome === 'terminal')?.payload;
}

async function commitTask(evidence: Evidence, files: Record<string, string>, message: string) {
  for (const [name, text] of Object.entries(files)) await writeFile(join(evidence.cwd, name), text);
  await git(evidence.cwd, 'add', ...Object.keys(files));
  await git(evidence.cwd, 'commit', '-qm', message);
  evidence.taskCommits.push(await git(evidence.cwd, 'rev-parse', 'HEAD'));
}

function adapterFor(evidence: Evidence) {
  return class DeterministicAdapter implements AgentAdapter {
    readonly agent = 'claude-code';
    async *run(prompt: string, options?: AgentOptions): AsyncGenerator<AgentEvent> {
      let result: string;
      // DR-090 §3: a player prompt opens with its role line.
      const body = prompt.replace(/^Role: [^\n]*\n\n/, '');
      if (options?.model === 'synthetic-coder') evidence.allCoderPrompts.push(prompt);
      if (prompt.includes('Check whether existing instructions already answer')) {
        result = '{"instructionIndex":null}';
      } else if (prompt.includes('Select exactly one action from the closed set')) {
        result = '{"action":"deliver"}';
      } else if (prompt.includes('An action just settled for the current Boss turn')) {
        result = 'The actual current workflow state and owner question are preserved.';
      } else if (prompt.includes('Classify the following Boss message')) {
        result = '{"type":"BOSS_REPLY"}';
      } else if (prompt.includes('This is hidden control work.')) {
        if (evidence.marker === 'DIRECT') {
          expect(prompt).toContain('standalone documentation or status maintenance that does not implement an identified unfinished IR task');
          expect(prompt).toContain('IR with no unfinished task');
        }
        const outcomes: Record<string, unknown> = {
          DIRECT: { guard: 'directCommit' },
          FIRST: { guard: 'moreTasks', irNumber: '040', irTask: 'Task 1: implement the reviewed feature.' },
          FINDINGS: { guard: 'hasFindings' },
          FIXED: { guard: 'committed' },
          CLEAN: { guard: 'noFindings' },
          QUESTION: { guard: 'needsBossReply' },
          FINAL: { guard: 'finalTask', irNumber: '040', irTask: 'Task 2: record the approved local target.' },
        };
        result = JSON.stringify(outcomes[evidence.marker]);
      } else if (options?.model === 'synthetic-reviewer') {
        evidence.reviewers++;
        evidence.reviewerPrompts.push(prompt);
        if (evidence.reviewers === 1) {
          // DR-102: the one REVIEW starts only after every phase commit exists.
          const phases = evidence.scenario === 'record-maintenance' ? 1 : 2;
          expect(evidence.taskCommits).toHaveLength(phases);
          expect(Number(await git(evidence.cwd, 'rev-list', '--count', 'HEAD'))).toBe(evidence.baselineCount + phases);
          expect(await git(evidence.cwd, 'rev-parse', 'HEAD')).toBe(evidence.taskCommits.at(-1));
        }
        if (evidence.scenario === 'transport-failed') throw new Error('Injected Reviewer transport failure');
        if (evidence.scenario === 'record-maintenance') {
          expect(prompt).toContain(evidence.taskCommits[0]);
          expect(await readFile(join(evidence.cwd, COMPLETED_IR), 'utf8')).toContain('Owner acceptance recorded from the caller.');
        }
        const findings = (evidence.scenario === 'pass' || evidence.scenario === 'restore') && evidence.reviewers === 1;
        evidence.marker = findings ? 'FINDINGS' : 'CLEAN';
        result = findings
          ? 'One material finding: the committed feature says broken; fix it.'
          : 'Review complete. No unsettled findings remain for the exact supplied committed scope.';
        if (!findings) evidence.reviewRevision = await git(evidence.cwd, 'rev-parse', 'HEAD');
      } else if (body.startsWith('For each review item')) {
        await writeFile(join(evidence.cwd, 'feature.txt'), 'fixed\n');
        await git(evidence.cwd, 'add', 'feature.txt');
        await git(evidence.cwd, 'commit', '-qm', 'fix: answer the bound review');
        evidence.marker = 'FIXED';
        result = 'Accepted and fixed the material finding in one review-fix commit.';
      } else if (body.startsWith('First determine whether')) {
        evidence.coderPrompts.push(prompt);
        expect(evidence.reviewers).toBe(0);
        if (evidence.scenario === 'record-maintenance') {
          expect(prompt).toContain('Treat standalone documentation or status maintenance that does not implement an identified unfinished IR task as a new change intent');
          expect(prompt).toContain('For a new change intent, assess whether it can be completed well in one commit.');
          expect(prompt).toContain('Do not invent or reopen an IR task');
          const path = join(evidence.cwd, COMPLETED_IR);
          expect(await readFile(path, 'utf8')).toBe(COMPLETED_IR_TEXT);
          await commitTask(evidence, {
            [COMPLETED_IR]: COMPLETED_IR_TEXT.replace('Coder work complete; owner acceptance pending.', 'Owner acceptance recorded from the caller.'),
          }, 'docs: record owner acceptance');
          evidence.marker = 'DIRECT';
          result = 'Recorded the caller\'s owner acceptance of completed IR-001 in one status-only commit. No IR task was invented or implemented; the requested record update is complete and awaits independent REVIEW.';
        } else {
          await commitTask(evidence, {
            'feature.txt': 'broken\n',
            'intent.md': 'IR-040 task 1 complete; independent review follows the final task.\nTask 2 needs a new owner target decision.\n',
          }, 'feat: implement task one');
          evidence.marker = 'FIRST';
          result = 'Implemented IR-040 task 1 in one commit; another task remains.';
        }
      } else if (prompt.includes('Read the identified IR and implement exactly its next unfinished task')) {
        evidence.coderPrompts.push(prompt);
        evidence.subsequentCalls++;
        // DR-102: no review ran before this later task, and none is relayed to it.
        expect(evidence.reviewers).toBe(0);
        expect(prompt).not.toContain('Previous phase review');
        expect(prompt).toContain(AWAIT_ONE_REVIEW);
        expect(await git(evidence.cwd, 'rev-parse', 'HEAD')).toBe(evidence.taskCommits[0]);
        expect(await git(evidence.cwd, 'status', '--porcelain=v1')).toBe('');
        if (evidence.scenario === 'restore' && !prompt.includes('Boss ⟶')) {
          evidence.marker = 'QUESTION';
          result = 'Boss question: Which new local target should task 2 use?';
        } else {
          await commitTask(evidence, { 'target.txt': 'owner-approved synthetic target\n' }, 'docs: record task two target');
          evidence.marker = 'FINAL';
          result = 'Implemented final IR-040 task 2 in one commit, using the actual owner answer.';
        }
      } else throw new Error(`Unexpected fixture call: ${prompt.slice(0, 90)}`);
      yield createEvent('done', this.agent, {
        status: 'success', result, resumeToken: 'deterministic-conversation', usage: { toolUses: 0 }, durationMs: 1,
      }, 'transport:success');
    }
  };
}

async function fixture(scenario: Scenario, run: (f: {
  evidence: Evidence; controller: SessionHostController; reopen(): Promise<SessionHostController>;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'code-intent-review-flow-'));
  const cwd = join(dir, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '--quiet');
  await git(cwd, 'config', 'user.name', 'Fixture');
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(cwd, 'base.txt'), 'baseline\n');
  if (scenario === 'record-maintenance') {
    await mkdir(join(cwd, 'specs', 'intents'), { recursive: true });
    await writeFile(join(cwd, COMPLETED_IR), COMPLETED_IR_TEXT);
  }
  await git(cwd, 'add', '--all'); await git(cwd, 'commit', '-qm', 'baseline');
  const evidence: Evidence = {
    cwd, scenario, marker: '', baselineCount: Number(await git(cwd, 'rev-list', '--count', 'HEAD')),
    taskCommits: [], coderPrompts: [], allCoderPrompts: [], reviewerPrompts: [],
    reviewers: 0, subsequentCalls: 0, records: [],
  };
  const loadModule = async (specifier: string) => {
    const entry = specifier.includes('/code/') ? codeEntry : reviewEntry;
    if (entry.id !== 'review' || scenario !== 'malformed-child') return { default: entry };
    return { default: { ...entry, createRuntime: (...args: any[]) => {
      const runtime = (entry.createRuntime as any)(...args);
      return { ...runtime, async handleBossInput(input: any) {
        const result = await runtime.handleBossInput(input);
        return result.outcome === 'terminal' ? { ...result, output: { noUnsettledFindings: true } } : result;
      } };
    } } };
  };
  const configPath = join(dir, 'playbook.config.yaml');
  await writeFile(configPath, `captain: { adapter: claude, model: synthetic-captain }\nplayers:\n  dev.coder: { adapter: claude, model: synthetic-coder }\n  dev.reviewer: { adapter: claude, model: synthetic-reviewer }\nplaybooks:\n  code:\n    from: "@sublang/playbook/code/registry"\n    roles: { coder: dev.coder }\n  review:\n    from: "@sublang/playbook/review/registry"\n    roles: { coder: dev.coder, reviewer: dev.reviewer }\n`);
  const plan = await loadLaunchPlan({ userConfigPath: configPath, loadModule });
  const config = executionConfigFromPlan(plan);
  const store = createSessionStore({ sessionsDir: join(dir, 'sessions') });
  const adapterImports = { claude: async () => adapterFor(evidence) };
  const observers = [{ onRecord(record: any) { evidence.records.push(record); } }];
  let controller = await openSessionHost({ store, mode: 'new', cwd, config, loadModule, adapterImports, observers });
  try {
    await run({ evidence, controller, async reopen() {
      const sessionId = controller.sessionId; await controller.dispose();
      controller = await openSessionHost({ store, mode: 'continue', sessionId, config, loadModule, adapterImports, observers });
      return controller;
    } });
  } finally {
    try {
      const evidenceDir = process.env.PLAYBOOK_INTENT_REVIEW_EVIDENCE_DIR;
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(join(evidenceDir, `${scenario}.json`), JSON.stringify(evidence, null, 2));
      }
    } finally {
      try { await controller.dispose(); }
      finally { await rm(dir, { recursive: true, force: true }); }
    }
  }
}

function expectNoPriorReviewRelay(evidence: Evidence) {
  expect(evidence.allCoderPrompts.length).toBeGreaterThan(0);
  for (const prompt of evidence.allCoderPrompts) {
    expect(prompt).not.toContain('Previous phase review');
    expect(prompt).not.toContain('evaluatedRevision');
  }
}

describe('model-free intent review through real CODE and REVIEW', () => {
  it('reviews a requested status-only update to a completed IR once as a direct phase', async () => {
    await fixture('record-maintenance', async ({ controller, evidence }) => {
      const result = await controller.handleBossTurn('/code Record my owner acceptance of completed IR-001; update only its status.');
      expect(result.snapshot.frames ?? []).toEqual([]);
      expect(evidence.subsequentCalls).toBe(0);
      expect(evidence.reviewers).toBe(1);
      const head = await git(evidence.cwd, 'rev-parse', 'HEAD');
      expect(evidence.taskCommits).toEqual([head]);
      expect(evidence.reviewerPrompts[0]).toContain(`namely ${head}, and its resulting repository state`);
      expect(evidence.reviewRevision).toBe(head);
      expect(codeTerminal(evidence)).toMatchObject({
        outcome: 'terminal', state: { stateId: 'done' },
        output: { status: 'complete', lastCodeCommit: head, finalEvaluatedRevision: head, allReviewsPassed: true },
      });
      expect(result.effectLedger.boundaries).toEqual(expect.arrayContaining([expect.objectContaining({
        sourceStateId: 'firstPhase',
        physicalReceipt: expect.objectContaining({ classification: 'one-descendant-commit', commitOid: head }),
      })]));
      expect(await git(evidence.cwd, 'diff', 'HEAD^', 'HEAD', '--name-only')).toBe(COMPLETED_IR);
      expect(await readFile(join(evidence.cwd, COMPLETED_IR), 'utf8')).toBe(COMPLETED_IR_TEXT.replace('Coder work complete; owner acceptance pending.', 'Owner acceptance recorded from the caller.'));
      expect(await git(evidence.cwd, 'status', '--porcelain=v1')).toBe('');
      expectNoPriorReviewRelay(evidence);
    });
  });
  it('reviews every phase commit of a multi-task intent once, after its final task', async () => {
    await fixture('pass', async ({ controller, evidence }) => {
      const result = await controller.handleBossTurn('/code continue existing IR-040, task one then the final task');
      expect(result.snapshot.frames ?? []).toEqual([]);
      expect(evidence.subsequentCalls).toBe(1);
      expect(evidence.coderPrompts).toHaveLength(2);
      expect(evidence.reviewers).toBe(2);
      const [first, second] = evidence.taskCommits;
      expect(evidence.taskCommits).toHaveLength(2);
      expect(evidence.reviewerPrompts[0]).toContain(`namely ${first}, ${second}, and its resulting repository state`);
      expect(evidence.reviewerPrompts[0]).toContain('IR number: 040');
      expect(evidence.coderPrompts[1]).not.toContain('Previous phase review');
      expect(evidence.coderPrompts[1]).toContain(AWAIT_ONE_REVIEW);
      expectNoPriorReviewRelay(evidence);
      const head = await git(evidence.cwd, 'rev-parse', 'HEAD');
      expect(head).not.toBe(second);
      expect(await git(evidence.cwd, 'rev-parse', 'HEAD^')).toBe(second);
      expect(codeTerminal(evidence)).toMatchObject({
        outcome: 'terminal', state: { stateId: 'done' },
        output: { status: 'complete', lastCodeCommit: second, finalEvaluatedRevision: head, allReviewsPassed: true },
      });
      expect(await git(evidence.cwd, 'status', '--porcelain=v1')).toBe('');
      expect((await git(evidence.cwd, 'log', '--format=%s')).split('\n')).toHaveLength(4);
    });
  });
  it('restores a later task across a genuinely new owner question before the one REVIEW', async () => {
    await fixture('restore', async ({ controller, evidence, reopen }) => {
      const parked = await controller.handleBossTurn('/code continue existing IR-040');
      const frame = parked.snapshot.frames.at(-1)!;
      expect(frame.runtime.state.stateId).toBe('awaitBossReply');
      const context = (frame.runtime as any).machine.context;
      expect(context.previousPhaseReview).toBeUndefined();
      expect(context.codeCommits).toHaveLength(1);
      expect(evidence.reviewers).toBe(0);
      const reopened = await reopen();
      await reopened.handleBossTurn('Use the explicit new synthetic owner-approved local target.');
      expect(evidence.subsequentCalls).toBe(2);
      expect(evidence.coderPrompts[2]).toContain('Boss ⟶');
      expect(evidence.coderPrompts[2]).toContain(AWAIT_ONE_REVIEW);
      expect(evidence.reviewers).toBe(2);
      const [first, second] = evidence.taskCommits;
      expect(evidence.reviewerPrompts[0]).toContain(`namely ${first}, ${second}, and its resulting repository state`);
      expectNoPriorReviewRelay(evidence);
      expect(codeTerminal(evidence)).toMatchObject({
        outcome: 'terminal', state: { stateId: 'done' },
        output: { status: 'complete', lastCodeCommit: second, allReviewsPassed: true },
      });
    });
  });
  for (const scenario of ['transport-failed', 'malformed-child'] as const) {
    it(`keeps every task commit when the intent's ${scenario} REVIEW does not pass`, async () => {
      await fixture(scenario, async ({ controller, evidence }) => {
        const result = await controller.handleBossTurn('/code continue existing IR-040');
        expect(evidence.subsequentCalls).toBe(1);
        expect(evidence.coderPrompts).toHaveLength(2);
        expect(evidence.reviewers).toBe(1);
        expect(evidence.taskCommits).toHaveLength(2);
        const second = evidence.taskCommits[1];
        expect(await git(evidence.cwd, 'rev-parse', 'HEAD')).toBe(second);
        expect(await git(evidence.cwd, 'rev-parse', 'HEAD^')).toBe(evidence.taskCommits[0]);
        expect(result.snapshot.lastSettlementStatus).not.toBe('rejected');
        expect(await git(evidence.cwd, 'status', '--porcelain=v1')).toBe('');
        if (scenario === 'malformed-child') {
          expect(codeTerminal(evidence)).toMatchObject({
            outcome: 'terminal', state: { stateId: 'reviewFailed' },
            output: { status: 'review-failed', lastCodeCommit: second },
          });
        }
      });
    });
  }
});
