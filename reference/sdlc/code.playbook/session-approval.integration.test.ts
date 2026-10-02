// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentOptions, ApprovalDecision } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { expect, it } from 'vitest';
import { questionRegistry } from '../../../acceptance-fixtures/captain-question-flow.js';
import { createSessionStore } from './session-store.js';
import { openSessionHost, executionConfigFromPlan, loadLaunchPlan, type SessionHostController, type TmuxPlayApprovalRequest } from './session-host.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('keeps live approval ownership out of durable state and denies a closing host before draining its lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playbook-approval-host-'));
  const cwd = join(root, 'repo');
  const requests: TmuxPlayApprovalRequest[] = [];
  const nativeDecisions: ApprovalDecision[] = [];
  const records: any[] = [];
  const entered = deferred<AbortSignal>();
  const lateAnswer = deferred<ApprovalDecision>();
  let mode: 'allow' | 'deny' | 'wait' | 'error' | 'invalid' = 'allow';
  const failedSignals: AbortSignal[] = [];
  let nativeEffects = 0;
  let controller: SessionHostController | undefined;
  // The host, tmux runtime, Cligent and Claude permission bridge are real;
  // only the SDK peer is controlled, and it acts only on native allowance.
  class Adapter extends ClaudeCodeAdapter {
    constructor() {
      super({ loadSdk: async () => ({
        query({ prompt, options }) {
          return (async function* () {
            if (typeof prompt !== 'string') throw new Error('Unexpected fixture attachment');
            const sessionId = options?.resume ?? options?.sessionId ?? '03187067-c574-4477-aa2a-53e1d24044ed';
            yield { type: 'system', subtype: 'init', session_id: sessionId, model: 'fixture' };
            let result: string;
            if (prompt.includes('An action just settled for the current Boss turn')) result = 'The worker reported the observed approval decision.';
            else if (prompt.includes('Select exactly one action from the closed set')) result = JSON.stringify({ action: 'start', playbookId: 'question-flow', input: 'Inspect with a native approval.' });
            else if (prompt.startsWith('You are the Playbook Captain shell hidden-control judge.')) result = JSON.stringify({ guard: 'done' });
            else if (prompt.includes('QUESTION_RELAY_WORKER:')) {
              const response = await options!.canUseTool!('browser_click', { target: 'local fixture' }, { signal: new AbortController().signal, toolUseID: 'repeated-tool-id', decisionReason: 'Native provider requested approval' });
              const decision = response.behavior === 'allow' ? 'allow_once' : 'deny';
              nativeDecisions.push(decision);
              if (response.behavior === 'allow') nativeEffects += 1;
              if (mode === 'wait') {
                // Graceful work may continue after denial while disposal drains.
                // A newly raised native ask must not reopen the closed host UI.
                const next = await options!.canUseTool!('browser_click', { target: 'after closing' }, { signal: new AbortController().signal, toolUseID: 'after-closing' });
                nativeDecisions.push(next.behavior === 'allow' ? 'allow_once' : 'deny');
                if (next.behavior === 'allow') nativeEffects += 1;
              }
              result = `The native tool request received ${decision}.`;
            } else throw new Error(`Unexpected call: ${prompt.slice(0, 150)}`);
            yield { type: 'result', subtype: 'success', result, session_id: sessionId, is_error: false, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } };
          })();
        },
      }) });
    }
    override async *run(prompt: string, options?: AgentOptions): AsyncGenerator<AgentEvent> {
      if (prompt.includes('QUESTION_RELAY_WORKER:')) expect(options?.approvalHandler).toBeTypeOf('function');
      else {
        expect(options?.approvalHandler).toBeUndefined();
        expect(options?.allowedTools).toEqual([]);
        expect(options?.browser).toBe(false); expect(options?.mcpServers).toEqual({});
      }
      yield* super.run(prompt, options as Parameters<ClaudeCodeAdapter['run']>[1]);
    }
  }
  try {
    await mkdir(cwd); execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'baseline'], { cwd });
    const configPath = join(root, 'config.yaml');
    await writeFile(configPath, 'captain: { adapter: claude, model: captain }\nplayers:\n  worker: { adapter: claude, model: worker }\nplaybooks:\n  question-flow:\n    from: mod://question-flow\n    roles: { worker: worker }\n');
    const loadModule = async () => ({ default: questionRegistry });
    const config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath, loadModule }));
    const store = createSessionStore({ sessionsDir: join(root, 'sessions') });
    let sessionId: string | undefined;
    const open = () => openSessionHost({ store, cwd, config, loadModule, adapterImports: { claude: async () => Adapter }, ...(sessionId ? { sessionId, mode: 'continue' as const } : { mode: 'new' as const }), observers: [{ onRecord(record: any) { records.push(record); } }], approvalHandler: async (envelope, { signal }) => {
      requests.push(envelope);
      if (mode === 'wait') { entered.resolve(signal); return lateAnswer.promise; }
      if (mode === 'error') { failedSignals.push(signal); throw new Error('Host handler failed'); }
      if (mode === 'invalid') { failedSignals.push(signal); return 'allow_always' as ApprovalDecision; }
      return mode === 'allow' ? 'allow_once' : 'deny';
    } });
    controller = await open(); sessionId = controller.sessionId;
    await controller.handleBossTurn('Inspect first.');
    await controller.dispose(); controller = undefined;
    mode = 'deny'; controller = await open();
    await controller.handleBossTurn('Inspect again.');
    await controller.dispose(); controller = undefined;
    expect(requests.map(request => [request.turnId, request.actorId])).toEqual([[1, 'worker'], [2, 'worker']]);
    expect(new Set(requests.map(request => request.invocationId)).size).toBe(2);
    expect(nativeDecisions).toEqual(['allow_once', 'deny']);
    const durable = await store.readStream(sessionId);
    const archived = durable.entries.flatMap(entry => entry.record.type === 'player_event' ? [entry.record as any] : []).filter(record => record.event.type.startsWith('approval_'));
    expect(archived.map(record => [record.turnId, record.event.type])).toEqual([[1, 'approval_request'], [1, 'approval_response'], [2, 'approval_request'], [2, 'approval_response']]);
    expect(JSON.stringify(durable)).not.toContain('approvalHandler');
    expect(JSON.stringify(await store.read(sessionId))).not.toContain('approvalHandler');

    mode = 'wait'; controller = await open();
    const turn = controller.handleBossTurn('Inspect with a pending approval.');
    const signal = await entered.promise;
    const closing = controller.dispose();
    await Promise.all([turn, closing]); controller = undefined;
    expect(signal.aborted).toBe(true);
    expect(nativeDecisions).toEqual(['allow_once', 'deny', 'deny', 'deny']);
    expect(requests.at(-1)?.turnId).toBe(3);
    expect(requests).toHaveLength(3);
    lateAnswer.resolve('allow_once'); await Promise.resolve();
    expect(nativeDecisions).toEqual(['allow_once', 'deny', 'deny', 'deny']);
    const lease = await store.acquire(sessionId); await lease.release();
    for (const failure of ['error', 'invalid'] as const) {
      mode = failure; controller = await open();
      await controller.handleBossTurn('Inspect with an invalid approval handler.');
      await controller.dispose(); controller = undefined;
    }
    expect(failedSignals.map(signal => signal.aborted)).toEqual([true, true]);
    expect(nativeDecisions).toEqual(['allow_once', 'deny', 'deny', 'deny', 'deny', 'deny']);
    expect(nativeEffects).toBe(1);
    const failures = records.filter(record => record.type === 'player_event' && record.event.type === 'approval_response' && record.turnId >= 4);
    expect(failures).toHaveLength(2);
    expect(failures.map(record => record.event.payload)).toEqual([
      { requestId: requests[3]!.request.id, decision: 'deny', source: 'error' },
      { requestId: requests[4]!.request.id, decision: 'deny', source: 'error' },
    ]);
    expect(records.filter(record => record.type === 'turn_finished')).toHaveLength(5);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).toBe('');
  } finally { lateAnswer.resolve('deny'); await controller?.dispose(); await rm(root, { recursive: true, force: true }); }
}, 20_000);
