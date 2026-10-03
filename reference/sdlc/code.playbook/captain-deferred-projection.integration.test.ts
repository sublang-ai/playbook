// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Σ* <alph@sublang.ai>

// Real CODE/REVIEW, durable host/store and Git; only provider replies are scripted.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createEvent, type AgentAdapter, type AgentEvent, type AgentOptions } from '@sublang/cligent';
import { expect, it } from 'vitest';
import code from './code.registry.js';
import review from '../review.playbook/review.registry.js';
import { loadLaunchPlan } from './bin/launch-config.js';
import { executionConfigFromPlan } from './bin/run.js';
import { createSessionStore } from './session-store.js';
import { openSessionHost, type SessionHostController } from './session-host.js';

const exec = promisify(execFile);
const QUESTION = 'Boss question: Which synthetic local destination should this task use?';

it('keeps a checkpoint-mismatched deferred wait durable through restoration and one explicit continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'captain-deferred-projection-'));
  const cwd = join(dir, 'repository');
  await mkdir(cwd);
  const git = async (...args: string[]) => (await exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim();
  await git('init', '--quiet');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(cwd, 'baseline.txt'), 'baseline\n');
  await git('add', 'baseline.txt'); await git('commit', '-qm', 'baseline');
  const calls: string[] = [];
  const records: any[] = [];
  let coderCalls = 0;
  let marker = 'question';
  class Adapter implements AgentAdapter {
    readonly agent = 'claude-code';
    async *run(prompt: string, options?: AgentOptions): AsyncGenerator<AgentEvent> {
      let result: string;
      if (prompt.includes('Check whether existing instructions already answer')) {
        calls.push('question-check'); result = '{"instructionIndex":null}';
      } else if (prompt.includes('Select exactly one action from the closed set')) {
        calls.push('route'); result = '{"action":"deliver"}';
      } else if (prompt.includes('An action just settled for the current Boss turn')) {
        calls.push('closing'); result = 'The current task and its repository evidence remain available.';
      } else if (prompt.includes('Classify the following Boss message')) {
        calls.push('classify'); result = '{"type":"BOSS_REPLY"}';
      } else if (prompt.includes('This is hidden control work.')) {
        calls.push('judge');
        result = JSON.stringify({ guard: marker === 'question' ? 'needsBossReply' : marker === 'review' ? 'noFindings' : 'directCommit' });
      } else if (options?.model === 'synthetic-coder') {
        calls.push('coder'); coderCalls++;
        if (coderCalls === 1) result = QUESTION;
        else {
          expect(prompt).toContain('Use the exact approved synthetic destination.');
          await writeFile(join(cwd, 'finished.txt'), 'approved synthetic destination\n');
          await git('add', 'finished.txt'); await git('commit', '-qm', 'finish the approved synthetic task');
          marker = 'commit'; result = 'The current direct task is complete in one commit.';
        }
      } else if (options?.model === 'synthetic-reviewer') {
        calls.push('reviewer'); marker = 'review'; result = 'No unsettled findings remain for the exact supplied committed scope.';
      } else throw new Error(`Unexpected scripted call: ${prompt.slice(0, 80)}`);
      yield createEvent('done', this.agent, { status: 'success', result, resumeToken: 'scripted-conversation', usage: { toolUses: 0 }, durationMs: 1 }, 'scripted-success');
    }
  }
  const loadModule = async (specifier: string) => ({ default: specifier.includes('/code/') ? code : review });
  const configPath = join(dir, 'config.yaml');
  await writeFile(configPath, 'captain: { adapter: claude, model: synthetic-captain }\nplayers:\n  dev.coder: { adapter: claude, model: synthetic-coder }\n  dev.reviewer: { adapter: claude, model: synthetic-reviewer }\nplaybooks:\n  code: { from: "@sublang/playbook/code/registry", roles: { coder: dev.coder } }\n  review: { from: "@sublang/playbook/review/registry", roles: { coder: dev.coder, reviewer: dev.reviewer } }\n');
  const config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath, loadModule }));
  const sessionsDir = join(dir, 'sessions');
  const store = createSessionStore({ sessionsDir });
  const options = { store, cwd, config, loadModule, adapterImports: { claude: async () => Adapter }, observers: [{ onRecord(record: any) { records.push(record); } }] };
  let controller: SessionHostController | undefined = await openSessionHost({ ...options, mode: 'new' });
  try {
    const first = await controller.handleBossTurn('/code inspect the synthetic direct task and ask its owner destination');
    expect(first.state).toBe('settled');
    expect(first.snapshot.frames[0].runtime.state.stateId).toBe('awaitBossReply');
    expect(first.effectLedger.logicalOperations).toHaveLength(1);
    const originalOperation = structuredClone(first.effectLedger.logicalOperations[0]);
    const originalBoundaries = structuredClone(first.effectLedger.boundaries);
    const originalQuestion = first.snapshot.pendingBossQuestions;
    const recordsPath = join(sessionsDir, `${controller.sessionId}.records.jsonl`);
    const recordsBefore = await readFile(recordsPath);
    await writeFile(join(cwd, 'incoming.txt'), 'actual new upstream input\n');
    const mismatch = await controller.handleBossTurn('Use the received synthetic destination.');
    expect(mismatch.state).toBe('settled');
    expect(mismatch.snapshot.mode).toBe('engaged.parked');
    expect(mismatch.snapshot.frames[0].runtime.state.stateId).toBe('awaitBossReply');
    expect(mismatch.snapshot.pendingBossQuestions ?? []).toEqual([]);
    expect(mismatch.snapshot.frames[0].runtime.pendingBossQuestions).toEqual([]);
    expect(mismatch.effectLedger.boundaries).toEqual(originalBoundaries);
    expect(mismatch.effectLedger.logicalOperations[0]).toEqual({ ...originalOperation, checkpointRestorationEligible: true });
    expect(coderCalls).toBe(1);
    expect(controller.listRuntimeActions().map(a => a.id)).toContain('reconcile:unresolved-effect');
    const sessionId = controller.sessionId;
    await controller.dispose();
    const callsBeforeReopen = calls.length;
    controller = await openSessionHost({ ...options, sessionId, mode: 'continue' });
    expect(calls).toHaveLength(callsBeforeReopen);
    expect((await controller.read()).snapshot.frames[0].runtime.state.stateId).toBe('awaitBossReply');
    const protectedCalls = () => calls.filter(c => ['coder', 'reviewer', 'judge', 'classify'].includes(c));
    const beforeBlocked = protectedCalls();
    const blocked = await controller.submitRuntimeAction('reconcile:unresolved-effect');
    expect(blocked.effectLedger).toEqual(mismatch.effectLedger);
    expect(blocked.snapshot.pendingBossQuestions ?? []).toEqual([]);
    expect(blocked.snapshot.mode).toBe('engaged.parked');
    expect(blocked.effectLedger.logicalOperations[0].checkpointRestorationEligible).toBe(true);
    expect(controller.listRuntimeActions().map(a => a.id)).toContain('reconcile:unresolved-effect');
    expect(protectedCalls()).toEqual(beforeBlocked);
    const lastApply = () => records.filter(r => r.type === 'captain_telemetry' && r.topic === 'playbook.trace' && r.payload?.playbookId === 'code' && r.payload?.type === 'apply.finished').at(-1)?.payload.payload;
    expect(lastApply()).toMatchObject({ disposition: 'executed', run: { outcome: 'no-action' } });
    await rm(join(cwd, 'incoming.txt'));
    const beforeReconcile = protectedCalls();
    const reconciled = await controller.submitRuntimeAction('reconcile:unresolved-effect');
    expect(protectedCalls()).toEqual(beforeReconcile);
    expect(lastApply()).toMatchObject({ disposition: 'executed', run: { outcome: 'quiescent' } });
    expect(reconciled.snapshot.pendingBossQuestions).toEqual(originalQuestion);
    expect(reconciled.effectLedger.boundaries).toEqual(originalBoundaries);
    expect(reconciled.effectLedger.logicalOperations[0]).toEqual(originalOperation);
    expect(coderCalls).toBe(1);
    expect((await readFile(recordsPath)).subarray(0, recordsBefore.length)).toEqual(recordsBefore);
    const done = await controller.handleBossTurn('Use the exact approved synthetic destination.');
    expect(coderCalls).toBe(2);
    expect(calls.filter(c => c === 'reviewer')).toHaveLength(1);
    expect(done.snapshot.mode).toBe('chat');
    expect(done.effectLedger.logicalOperations[0].logicalReceipt?.classification).toBe('one-descendant-commit');
    expect(await git('status', '--porcelain=v1')).toBe('');
    expect((await readFile(recordsPath)).subarray(0, recordsBefore.length)).toEqual(recordsBefore);
  } finally {
    await controller?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
