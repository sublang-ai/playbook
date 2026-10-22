// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFixtureManifest, writeFixtureFile as writeFile } from './test-support/session-persistence.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvent } from '@sublang/cligent';
import { createMachine } from 'xstate';
import { expect, it } from 'vitest';
import { createXStatePlaybookRuntime } from '../../../src/xstate-runtime.js';
import { runPlaybookCli } from './bin/playbook.js';
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

it.each(['SDK continue', 'CLI session', 'CLI continue', 'CLI retry', 'SDK recover'])(
  '%s reads a stored snapshot with an omitted presentation prefix', async (path) => {
    const dir = await mkdtemp(join(tmpdir(), 'snapshot-compatibility-'));
    let controller: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    const calls: string[] = [];
    class Adapter {
      readonly agent = 'claude-code';
      async *run(prompt: string) {
        calls.push(prompt);
        const result = prompt.includes('Boss issued a registered command that produces no action this turn')
          ? 'No playbook is engaged.'
          : prompt.includes('hidden-control judge') ? '{"guard":"done"}' : 'The check is complete.';
        yield createEvent('done', this.agent, { status: 'success', result, resumeToken: 'fixture', usage: { toolUses: 0 }, durationMs: 1 }, 'fixture');
      }
    }
    try {
      const cwd = join(dir, 'workspace');
      await mkdir(cwd);
      const configPath = join(dir, 'config.yaml');
      await writeFile(configPath, 'captain: { adapter: claude, model: fixture }\nplayers:\n  worker: { adapter: claude, model: fixture }\nplaybooks:\n  flow: { from: "mod://flow", roles: { worker: worker } }\n');
      const config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath, loadModule }));
      const store = createSessionStore({ sessionsDir: join(dir, 'sessions') });
      const options = { store, cwd, config, loadModule, adapterImports: { claude: async () => Adapter } };
      controller = await openSessionHost({ ...options, mode: 'new' });
      const sessionId = controller.sessionId;
      const initial = await controller.handleBossTurn('/flow Check the task');
      expect(initial.snapshot.lastSettlementStatus).toBe('ok');
      const prefix = initial.effectLedger.boundaries.length;
      expect(prefix).toBeGreaterThan(0);
      expect(initial.snapshot.presentedEffectPrefix).toBe(prefix);
      const uncertain = path === 'CLI retry' || path === 'SDK recover';
      if (uncertain) {
        await controller.lease.beginTurn({ input: '/flow', attemptId: randomUUID(), attemptedExecutionProjection: config });
        await controller.lease.recordProgress({ snapshot: initial.snapshot });
      }
      await controller.dispose(); controller = undefined;

      // Simulate the supported older shape without changing the replay stream.
      const manifestPath = join(store.sessionsDir, `${sessionId}.json`);
      const manifest = await readFixtureManifest(manifestPath);
      delete manifest.snapshot.presentedEffectPrefix;
      if (manifest.uncertain?.progress?.snapshot) delete manifest.uncertain.progress.snapshot.presentedEffectPrefix;
      await writeFile(manifestPath, JSON.stringify(manifest));
      expect((await store.validate(sessionId)).integrityValid).toBe(true);
      const callCount = calls.length;
      if (path.startsWith('SDK')) {
        controller = await openSessionHost({ ...options, sessionId, mode: uncertain ? 'recover' : 'continue' });
        expect(controller.shell.exportSnapshot()?.presentedEffectPrefix).toBe(prefix);
        if (uncertain) await controller.recover();
        else await controller.handleBossTurn('/flow');
      } else {
        let stdout = '', stderr = '';
        const argv = path === 'CLI retry' ? ['run', '--session', sessionId, '--retry-uncertain']
          : path === 'CLI continue' ? ['run', '--continue', '/flow'] : ['run', '--session', sessionId, '/flow'];
        const result = await runPlaybookCli({ argv, cwd, userConfigPath: configPath, sessionStore: store, loadModule, adapterImports: options.adapterImports, env: { ANTHROPIC_API_KEY: 'fixture' }, probeAdapterSdk: async () => true, stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } } });
        expect(result.code, stderr).toBe(0);
        expect(stdout).toContain(uncertain ? 'no work was repeated' : 'No playbook is engaged.');
      }
      const settled = await store.read(sessionId);
      expect(settled.state).toBe('settled');
      expect(settled.snapshot.presentedEffectPrefix).toBe(prefix);
      if (uncertain) expect(calls).toHaveLength(callCount);
    } finally {
      await controller?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
