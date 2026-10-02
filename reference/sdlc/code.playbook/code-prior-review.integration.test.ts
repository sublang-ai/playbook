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
type Scenario = 'pass' | 'restore' | 'stale' | 'transport-failed' | 'malformed-child';

interface Evidence {
  cwd: string; scenario: Scenario; marker: string; scopeCommit?: string; reviewRevision?: string;
  coderPrompts: string[]; reviewers: number; subsequentCalls: number; records: any[];
}

function codeTerminal(evidence: Evidence) {
  return evidence.records
    .filter(r => r.type === 'captain_telemetry' && r.topic === 'playbook.trace')
    .map(r => r.payload)
    .find(r => r.playbookId === 'code' && r.type === 'boss.input.settled' && r.payload.outcome === 'terminal')?.payload;
}

function adapterFor(evidence: Evidence) {
  return class DeterministicAdapter implements AgentAdapter {
    readonly agent = 'claude-code';
    async *run(prompt: string, options?: AgentOptions): AsyncGenerator<AgentEvent> {
      let result: string;
      if (prompt.includes('Check whether existing instructions already answer')) {
        result = '{"instructionIndex":null}';
      } else if (prompt.includes('Select exactly one action from the closed set')) {
        result = '{"action":"deliver"}';
      } else if (prompt.includes('An action just settled for the current Boss turn')) {
        result = 'The actual current workflow state and owner question are preserved.';
      } else if (prompt.includes('Classify the following Boss message')) {
        result = '{"type":"BOSS_REPLY"}';
      } else if (prompt.includes('This is hidden control work.')) {
        const outcomes: Record<string, unknown> = {
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
        if (evidence.scenario === 'transport-failed') throw new Error('Injected Reviewer transport failure');
        evidence.marker = evidence.reviewers === 1 ? 'FINDINGS' : 'CLEAN';
        result = evidence.marker === 'FINDINGS'
          ? 'One material finding: the committed feature says broken; fix it.'
          : 'Review complete. No unsettled findings remain for the exact supplied committed scope.';
        if (evidence.marker === 'CLEAN') evidence.reviewRevision = await git(evidence.cwd, 'rev-parse', 'HEAD');
      } else if (prompt.startsWith('For each review item')) {
        await writeFile(join(evidence.cwd, 'feature.txt'), 'fixed\n');
        await git(evidence.cwd, 'add', 'feature.txt');
        await git(evidence.cwd, 'commit', '-qm', 'fix: answer the bound review');
        evidence.marker = 'FIXED';
        result = 'Accepted and fixed the material finding in one review-fix commit.';
      } else if (prompt.startsWith('First determine whether')) {
        evidence.coderPrompts.push(prompt);
        await writeFile(join(evidence.cwd, 'feature.txt'), 'broken\n');
        await writeFile(join(evidence.cwd, 'intent.md'), 'IR-040 task 1 complete; bound independent review pending.\nTask 2 needs a new owner target decision.\n');
        await git(evidence.cwd, 'add', 'feature.txt', 'intent.md');
        await git(evidence.cwd, 'commit', '-qm', 'feat: implement task one pending review');
        evidence.scopeCommit = await git(evidence.cwd, 'rev-parse', 'HEAD');
        evidence.marker = 'FIRST';
        result = 'Implemented IR-040 task 1 in one commit; another task remains.';
      } else if (prompt.includes('Read the identified IR and implement exactly its next unfinished task')) {
        evidence.coderPrompts.push(prompt);
        evidence.subsequentCalls++;
        const line = prompt.split('\n').find(line => line.startsWith('> Previous phase review: '));
        expect(line, 'a later task must receive its canonical review evidence').toBeDefined();
        const prior = JSON.parse(line!.slice('> Previous phase review: '.length));
        expect(prior).toEqual({
          phaseKind: 'ir-task', phaseOutcome: 'moreTasks', scopeCommit: evidence.scopeCommit,
          evaluatedRevision: evidence.reviewRevision, irNumber: '040', irTask: 'Task 1: implement the reviewed feature.',
        });
        expect(prior.scopeCommit).not.toBe(prior.evaluatedRevision);
        expect(await readFile(join(evidence.cwd, 'intent.md'), 'utf8')).toContain('review pending');
        expect(await git(evidence.cwd, 'rev-parse', 'HEAD')).toBe(prior.evaluatedRevision);
        expect(await git(evidence.cwd, 'status', '--porcelain=v1')).toBe('');
        expect(prompt).toContain('Before treating it as current review evidence, verify clean current HEAD equals its evaluatedRevision; a mismatch is not approval.');
        expect(prompt).toContain('It does not replace independent review of this task or any new owner or release decision.');
        if (evidence.scenario !== 'pass' && !prompt.includes('Boss reply:')) {
          evidence.marker = 'QUESTION';
          result = 'Boss question: Which new local target should task 2 use? Prior task review does not authorize that owner choice.';
        } else {
          await writeFile(join(evidence.cwd, 'target.txt'), 'owner-approved synthetic target\n');
          await git(evidence.cwd, 'add', 'target.txt');
          await git(evidence.cwd, 'commit', '-qm', 'docs: record task two target');
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
  const dir = await mkdtemp(join(tmpdir(), 'code-prior-review-flow-'));
  const cwd = join(dir, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '--quiet');
  await git(cwd, 'config', 'user.name', 'Fixture');
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(cwd, 'base.txt'), 'baseline\n');
  await git(cwd, 'add', 'base.txt'); await git(cwd, 'commit', '-qm', 'baseline');
  const evidence: Evidence = { cwd, scenario, marker: '', coderPrompts: [], reviewers: 0, subsequentCalls: 0, records: [] };
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
    await writeFile(`/private/tmp/playbook-canonical-prior-review-${scenario}-evidence.json`, JSON.stringify(evidence, null, 2));
    await controller.dispose(); await rm(dir, { recursive: true, force: true });
  }
}

describe('model-free prior-review relay through real CODE and REVIEW', () => {
  it('relays exact scope/task and review-fix descendant while retaining independent final review', async () => {
    await fixture('pass', async ({ controller, evidence }) => {
      const result = await controller.handleBossTurn('/code continue existing IR-040, task one then the final task');
      expect(result.snapshot.frames ?? []).toEqual([]);
      expect(evidence.subsequentCalls).toBe(1);
      expect(evidence.reviewers).toBe(3);
      const head = await git(evidence.cwd, 'rev-parse', 'HEAD');
      expect(codeTerminal(evidence)).toMatchObject({
        outcome: 'terminal', state: { stateId: 'done' },
        output: { status: 'complete', lastCodeCommit: head, finalEvaluatedRevision: head, allReviewsPassed: true },
      });
      expect(await git(evidence.cwd, 'status', '--porcelain=v1')).toBe('');
      expect((await git(evidence.cwd, 'log', '--format=%s')).split('\n')).toHaveLength(4);
    });
  });
  it('preserves the frozen accepted record through permitted restore and a genuinely new owner question', async () => {
    await fixture('restore', async ({ controller, evidence, reopen }) => {
      const parked = await controller.handleBossTurn('/code continue existing IR-040');
      expect(parked.snapshot.frames.at(-1)?.runtime.state.stateId).toBe('awaitBossReply');
      const frozen = (parked.snapshot.frames.at(-1)?.runtime as any).machine.context.previousPhaseReview;
      const reopened = await reopen();
      await reopened.handleBossTurn('Use the explicit new synthetic owner-approved local target.');
      expect(evidence.subsequentCalls).toBe(2);
      const first = evidence.coderPrompts[1]!.split('\n').find(l => l.startsWith('> Previous phase review: '));
      const resumed = evidence.coderPrompts[2]!.split('\n').find(l => l.startsWith('> Previous phase review: '));
      expect(resumed).toBe(first);
      expect(JSON.stringify(frozen)).toBe(first!.slice('> Previous phase review: '.length));
      expect(evidence.coderPrompts[2]).toContain('Boss reply:');
      expect(evidence.reviewers).toBe(3);
      expect(codeTerminal(evidence)).toMatchObject({
        outcome: 'terminal', state: { stateId: 'done' }, output: { status: 'complete', allReviewsPassed: true },
      });
    });
  });
  it('retains historical review evidence while the existing deferred checkpoint fence refuses stale HEAD', async () => {
    await fixture('stale', async ({ controller, evidence, reopen }) => {
      await controller.handleBossTurn('/code continue existing IR-040');
      const reviewed = evidence.reviewRevision;
      const reopened = await reopen();
      await writeFile(join(evidence.cwd, 'outside.txt'), 'separate external commit\n');
      await git(evidence.cwd, 'add', 'outside.txt'); await git(evidence.cwd, 'commit', '-qm', 'chore: unrelated external change');
      const staleHead = await git(evidence.cwd, 'rev-parse', 'HEAD');
      expect(staleHead).not.toBe(reviewed);
      await expect(reopened.handleBossTurn('Use the new synthetic owner-approved local target.'))
        .rejects.toThrow('session remains uncertain');
      expect(evidence.subsequentCalls).toBe(1);
      expect((await reopened.read())?.state).toBe('uncertain');
      expect(await git(evidence.cwd, 'rev-parse', 'HEAD')).toBe(staleHead);
      expect(await readFile(join(evidence.cwd, 'intent.md'), 'utf8')).toContain('review pending');
    });
  });
  for (const scenario of ['transport-failed', 'malformed-child'] as const) {
    it(`starts no later task for ${scenario} REVIEW and keeps the actual owned commit`, async () => {
      await fixture(scenario, async ({ controller, evidence }) => {
        const result = await controller.handleBossTurn('/code continue existing IR-040');
        expect(evidence.subsequentCalls).toBe(0);
        expect(evidence.coderPrompts).toHaveLength(1);
        expect(evidence.scopeCommit).toBeDefined();
        expect(result.snapshot.lastSettlementStatus).not.toBe('rejected');
        expect(await git(evidence.cwd, 'status', '--porcelain=v1')).toBe('');
      });
    });
  }
});
