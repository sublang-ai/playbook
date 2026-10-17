// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvent, type AgentOptions } from '@sublang/cligent';
import { createMachine } from 'xstate';
import { expect, it } from 'vitest';
import { createXStatePlaybookRuntime } from '../../../src/xstate-runtime.js';
import { executionConfigFromPlan } from './bin/run.js';
import { loadLaunchPlan } from './bin/launch-config.js';
import { createSessionStore } from './session-store.js';
import { openSessionHost } from './session-host.js';

const meta = (stateId: string) => ({ playbook: { stateId, description: stateId } });
const factory = createXStatePlaybookRuntime(createMachine({
  initial: 'ready',
  states: {
    ready: { meta: meta('ready'), tags: ['playbook.parked'], on: { START: 'work' } },
    work: { meta: { playbook: { stateId: 'work', description: 'Check the task', role: 'worker' } }, tags: ['playbook.busy'], invoke: {
      src: 'player', input: { stateId: 'work', sourceItem: 'FLOW-1', role: 'worker', prompt: 'Check the task.', result: { done: 'The check is complete.' } }, onDone: 'done', onError: 'failed',
    } },
    failed: { meta: meta('failed'), tags: ['playbook.parked'] },
    done: { meta: meta('done'), type: 'final' },
  },
}), {
  label: 'flow', compat: { artifactSchema: 3, runtimeAbi: 1 }, snapshotOptions: () => ({}),
  unfinishedFinalStateIds: [], entryEvent: { type: 'START', textField: 'text' },
  roleStates: { work: { role: 'worker', label: 'Check the task' } },
  outcomeAuthority: { governedPlayerStates: { work: { done: { fields: {}, repositoryDisposition: 'unchanged' } } } },
});
const loadModule = async () => ({ default: {
  id: 'flow', command: 'flow', intent: 'Check a task', artifactSchema: 3,
  runtimeProfile: { kind: 'shared-factory', compat: factory.compat },
  requiredRoleIds: ['worker'], concurrentRoleSets: [], validateOptions: () => ({}),
  createRuntime: (configuredOptions: unknown, hostCapabilities: any) => factory({ configuredOptions, hostCapabilities }),
} });

it.each(['continue', 'recover'] as const)('persists skill settings through %s and isolates Captain control', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'session-skills-'));
  let controller: Awaited<ReturnType<typeof openSessionHost>> | undefined;
  const calls: Array<{ prompt: string; options?: AgentOptions }> = [];
  class Adapter {
    readonly agent = 'claude-code';
    async *run(prompt: string, options?: AgentOptions) {
      calls.push({ prompt, options });
      const result = prompt.includes('hidden-control judge') ? '{"guard":"done"}' : 'The check is complete.';
      yield createEvent('done', this.agent, { status: 'success', result, resumeToken: 'fixture', usage: { toolUses: 0 }, durationMs: 1 }, 'fixture');
    }
  }
  try {
    const cwd = join(dir, 'workspace');
    await mkdir(cwd);
    const configPath = join(dir, 'config.yaml');
    const source = (skill: string) => JSON.stringify({ skills: [skill], captain: { adapter: 'claude', model: 'fixture' }, players: { worker: { adapter: 'claude', model: 'fixture' } }, playbooks: { flow: { from: 'mod://flow', roles: { worker: 'worker' } } } });
    await writeFile(configPath, source('./first'));
    const config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath, loadModule }));
    const store = createSessionStore({ sessionsDir: join(dir, 'sessions') });
    const options = { store, cwd, config, loadModule, adapterImports: { claude: async () => Adapter } };
    controller = await openSessionHost({ ...options, mode: 'new' });
    const sessionId = controller.sessionId;
    const initial = await controller.handleBossTurn('/flow Check the task');
    expect(initial.snapshot.lastSettlementStatus).toBe('ok');
    expect(calls.some(call => call.options?.skills?.[0] === join(dir, 'first'))).toBe(true);
    expect(JSON.stringify(initial.structuralProjection)).not.toContain('skills');
    expect(initial.lastAppliedExecutionProjection.players[0].skills).toEqual([join(dir, 'first')]);
    if (mode === 'recover') await controller.lease.beginTurn({ input: '/flow Check again', attemptId: randomUUID(), attemptedExecutionProjection: config });
    await controller.dispose(); controller = undefined;
    await writeFile(configPath, source('./second'));
    const current = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath, loadModule }));
    controller = await openSessionHost({ ...options, config: current, sessionId, mode });
    calls.length = 0;
    if (mode === 'recover') {
      await controller.recover();
      // Uncertain recovery reports recorded work without replaying it. Its
      // captured settings remain the admitted settings of this controller.
      expect(calls).toEqual([]);
      const recovered = await store.read(sessionId);
      expect(recovered.state).toBe('settled');
      expect(recovered.lastAppliedExecutionProjection.captain.skills).toEqual([join(dir, 'first')]);
      expect(recovered.lastAppliedExecutionProjection.players[0].skills).toEqual([join(dir, 'first')]);
    }
    await controller.handleBossTurn('/flow Check again');
    const expected = join(dir, mode === 'recover' ? 'first' : 'second');
    const workingCalls = calls.filter(call => call.options?.allowedTools === undefined);
    expect(workingCalls).toHaveLength(1);
    expect(workingCalls[0].options?.skills).toEqual([expected]);
    const controlCalls = calls.filter(call => call.options?.allowedTools?.length === 0);
    expect(controlCalls.length).toBeGreaterThan(0);
    for (const call of controlCalls) expect(call.options?.skills).toEqual([]);
    const settled = await store.read(sessionId);
    expect(settled.state).toBe('settled');
    expect(settled.lastAppliedExecutionProjection.players[0].skills).toEqual([expected]);
    expect((await store.validate(sessionId)).integrityValid).toBe(true);
  } finally {
    await controller?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
