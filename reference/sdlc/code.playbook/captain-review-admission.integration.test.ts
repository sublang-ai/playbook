// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createEvent, type AgentAdapter, type AgentEvent, type AgentOptions } from '@sublang/cligent';
import { describe, expect, it } from 'vitest';
import { assign, createMachine } from 'xstate';
import { createXStatePlaybookRuntime } from '../../../src/xstate-runtime.js';
import codeEntry from './code.registry.js';
import decideEntry from '../decide.playbook/decide.registry.js';
import reviewEntry from '../review.playbook/review.registry.js';
import { loadLaunchPlan } from './bin/launch-config.js';
import { executionConfigFromPlan } from './bin/run.js';
import { createSessionStore } from './session-store.js';
import { openSessionHost, type SessionHostController } from './session-host.js';

const exec = promisify(execFile);
const packaged = (id: string) => `@sublang/playbook/${id}/registry`;

// Only the provider boundary is deterministic. The real compiled registries,
// session host, durable store, frame bridge and Git effect coordinator execute.
class AdmissionAdapter implements AgentAdapter {
  static playerCalls = 0;
  readonly agent = 'claude-code';
  async *run(prompt: string, _options?: AgentOptions): AsyncGenerator<AgentEvent> {
    let result: string;
    if (prompt.includes('Check whether existing instructions already answer')) {
      result = JSON.stringify({ instructionIndex: null });
    } else if (prompt.includes('Select exactly one action from the closed set')) {
      result = JSON.stringify({ action: 'respond', text: 'Status remains available.' });
    } else if (prompt.includes('An action just settled for the current Boss turn')) {
      result = 'The request is paused. REVIEW must be enabled before packaged CODE or DECIDE can start.';
    } else if (prompt.includes('Classify the following Boss message')) {
      result = JSON.stringify({ type: 'BOSS_REPLY' });
    } else if (prompt.includes('This is hidden control work.')) {
      result = JSON.stringify({ guard: 'needsBossReply' });
    } else if (prompt.includes('You are Captain preparing an interrupted playbook')) {
      result = JSON.stringify({ status: 'blocked', summary: 'The fixture requires a Boss decision.' });
    } else {
      AdmissionAdapter.playerCalls++;
      result = 'Boss question: Which synthetic acceptance target should I use?';
    }
    yield createEvent('done', this.agent, {
      status: 'success', result, resumeToken: 'synthetic-admission-conversation',
      usage: { toolUses: 0 }, durationMs: 1,
    }, 'transport:success');
  }
}

function wrapperEntry(nested: boolean, childId: string) {
  const factory = createXStatePlaybookRuntime(createMachine({
    initial: 'ready', context: { task: '' },
    states: {
      ready: {
        tags: ['playbook.parked'],
        meta: { playbook: { stateId: 'ready', description: 'Wait for a local task' } },
        on: { START: { target: nested ? 'child' : 'parked', actions: assign({ task: ({ event }) => event.text }) } },
      },
      parked: {
        tags: ['playbook.parked'],
        meta: { playbook: { stateId: 'parked', description: 'Keep the current task available' } },
        on: { START: { target: nested ? 'child' : 'parked', actions: assign({ task: ({ event }) => event.text }) } },
      },
      child: {
        tags: ['playbook.suspended'],
        meta: { playbook: { stateId: 'child', description: 'Wait for the requested child' } },
        invoke: {
          src: 'playbook',
          input: ({ context }) => ({ stateId: 'child', sourceItem: 'WRAPPER-1', playbookId: childId, text: context.task }),
          onDone: 'parked', onError: 'parked',
        },
      },
    },
  }), {
    label: 'wrapper', compat: { artifactSchema: 3, runtimeAbi: 1 },
    snapshotOptions: () => ({}), entryEvent: { type: 'START', textField: 'text' },
    roleStates: {}, outcomeAuthority: { governedPlayerStates: {} },
  });
  return {
    id: 'wrapper', command: 'wrapper', intent: 'Preserve a local task or call its child',
    artifactSchema: 3, runtimeProfile: { kind: 'shared-factory', compat: factory.compat },
    requiredRoleIds: [], concurrentRoleSets: [],
    validateOptions: (options: unknown) => options ?? {},
    createRuntime: (configuredOptions: unknown, hostCapabilities: any) => factory({ configuredOptions, hostCapabilities }),
  };
}

async function fixture(
  settings: { id: 'code' | 'decide'; review?: boolean; nested?: boolean; from?: string; command?: string },
  run: (fixture: { controller: SessionHostController; factories: Record<string, number>; cwd: string; baseline: string; records: any[]; assertGitUnchanged(): Promise<void> }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-review-admission-'));
  const cwd = join(dir, 'repository');
  await mkdir(cwd);
  await exec('git', ['init', '--quiet'], { cwd });
  await writeFile(join(cwd, 'tracked.txt'), 'baseline\n');
  await exec('git', ['add', 'tracked.txt'], { cwd });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline'], { cwd });
  const baseline = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const factories = { code: 0, decide: 0, review: 0 };
  const entries = { code: codeEntry, decide: decideEntry, review: reviewEntry };
  const from = settings.from ?? packaged(settings.id);
  const loadModule = async (specifier: string) => {
    if (specifier === 'mod://wrapper') return { default: wrapperEntry(settings.nested ?? false, settings.id) };
    const id = specifier === from ? settings.id : specifier === packaged('review') ? 'review' : undefined;
    if (!id) throw new Error(`Unexpected fixture module: ${specifier}`);
    const entry = entries[id];
    return { default: { ...entry, createRuntime: (...args: any[]) => {
      factories[id]++;
      return (entry.createRuntime as any)(...args);
    } } };
  };
  const configPath = join(dir, 'playbook.config.yaml');
  const needsReviewer = settings.id === 'decide' || settings.review;
  await writeFile(configPath, `captain: { adapter: claude, model: synthetic-captain }\nplayers:\n  dev.coder: { adapter: claude, model: synthetic-coder }\n${needsReviewer ? '  dev.reviewer: { adapter: claude, model: synthetic-reviewer }\n' : ''}playbooks:\n  ${settings.id}:\n    from: ${JSON.stringify(from)}\n${settings.command ? `    command: ${settings.command}\n` : ''}    roles: ${settings.id === 'decide' ? '{ coder: dev.coder, reviewer: dev.reviewer }' : '{ coder: dev.coder }'}\n  wrapper:\n    from: mod://wrapper\n    roles: {}\n${settings.review ? '  review:\n    from: "@sublang/playbook/review/registry"\n    roles: { coder: dev.coder, reviewer: dev.reviewer }\n' : ''}`);
  const plan = await loadLaunchPlan({ userConfigPath: configPath, loadModule });
  const store = createSessionStore({ sessionsDir: join(dir, 'sessions') });
  const records: any[] = [];
  AdmissionAdapter.playerCalls = 0;
  const controller = await openSessionHost({
    store, mode: 'new', cwd, config: executionConfigFromPlan(plan), loadModule,
    adapterImports: { claude: async () => AdmissionAdapter },
    observers: [{ onRecord(record: any) { records.push(record); } }],
  });
  try {
    await run({ controller, factories, cwd, baseline, records, async assertGitUnchanged() {
      expect((await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()).toBe(baseline);
      expect((await exec('git', ['status', '--porcelain=v1'], { cwd })).stdout).toBe('');
      expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    } });
  } finally {
    await controller.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('packaged workflow REVIEW admission through the shared host', () => {
  for (const id of ['code', 'decide'] as const) {
    it(`refuses fresh ${id} before a working factory, player or Git effect`, async () => {
      await fixture({ id }, async ({ controller, factories, records, assertGitUnchanged }) => {
        const stopped = await controller.handleBossTurn(`/${id} inspect the synthetic task`);
        expect(factories[id]).toBe(0);
        expect(AdmissionAdapter.playerCalls).toBe(0);
        expect(stopped.snapshot.frames ?? []).toEqual([]);
        expect(stopped.snapshot.lastSettlementStatus).toBe('rejected');
        expect(stopped.snapshot.journal.filter(({ kind }: any) => kind === 'action').at(-1)?.payload).toMatchObject({ action: 'start', playbookId: id, refused: true });
        expect(JSON.stringify(stopped.snapshot.journal)).toContain('review');
        expect(JSON.stringify(records.filter(({ type }) => type === 'captain_reply'))).toContain('REVIEW');
        await assertGitUnchanged();
        await controller.handleBossTurn('What is the status?');
        expect(factories[id]).toBe(0);
        await assertGitUnchanged();
      });
    });

    it(`refuses a switch to ${id} without dismissing the active root`, async () => {
      await fixture({ id }, async ({ controller, factories, records, assertGitUnchanged }) => {
        const active = await controller.handleBossTurn('/wrapper preserve this synthetic request');
        const before = structuredClone(active.snapshot.frames);
        const recordCount = records.length;
        const stopped = await controller.handleBossTurn(`/${id} replace it with coding`);
        expect(factories[id]).toBe(0);
        expect(AdmissionAdapter.playerCalls).toBe(0);
        expect(stopped.snapshot.frames).toEqual(before);
        expect(stopped.snapshot.lastSettlementStatus).toBe('rejected');
        expect(JSON.stringify(records.slice(recordCount))).not.toContain('/wrapper stopped');
        await assertGitUnchanged();
      });
    });

    it(`refuses repeated nested ${id} before child bookkeeping and leaves its parent usable`, async () => {
      await fixture({ id, nested: true }, async ({ controller, factories, records, assertGitUnchanged }) => {
        for (const request of ['first', 'second']) {
          const stopped = await controller.handleBossTurn(`/wrapper ${request} synthetic attempt`);
          expect(factories[id]).toBe(0);
          expect(AdmissionAdapter.playerCalls).toBe(0);
          expect(stopped.snapshot.frames).toHaveLength(1);
          expect(stopped.snapshot.frames[0].playbookId).toBe('wrapper');
          expect(stopped.snapshot.frames[0].runtime.state.stateId).toBe('parked');
          await assertGitUnchanged();
        }
        expect(JSON.stringify(records)).not.toContain(`/${id} called by /wrapper`);
        expect(JSON.stringify(records)).not.toContain('outstanding child');
      });
    });
  }

  it('uses the configured effective command in the refusal', async () => {
    await fixture({ id: 'code', command: 'build' }, async ({ controller, factories, assertGitUnchanged }) => {
      const stopped = await controller.handleBossTurn('/build inspect the synthetic task');
      expect(factories.code).toBe(0);
      expect(JSON.stringify(stopped.snapshot.journal)).toContain('/build');
      expect(JSON.stringify(stopped.snapshot.journal)).toContain('review');
      await assertGitUnchanged();
    });
  });

  for (const from of ['mod://custom-code', '@sublang/playbook/code/registry-alias']) {
    it(`keeps custom same-id or aliased modules admitted: ${from}`, async () => {
      await fixture({ id: 'code', from }, async ({ controller, factories, assertGitUnchanged }) => {
        const stopped = await controller.handleBossTurn('/code inspect the synthetic task');
        expect(factories.code).toBe(1);
        expect(AdmissionAdapter.playerCalls).toBe(1);
        expect(stopped.snapshot.frames).toHaveLength(1);
        expect(stopped.snapshot.frames[0].runtime.state.stateId).toBe('awaitBossReply');
        expect(JSON.stringify(stopped.snapshot)).not.toContain(from);
        await assertGitUnchanged();
      });
    });
  }

  for (const id of ['code', 'decide'] as const) {
    it(`admits the real packaged ${id} when validated REVIEW is enabled`, async () => {
      await fixture({ id, review: true }, async ({ controller, factories, assertGitUnchanged }) => {
        const stopped = await controller.handleBossTurn(`/${id} inspect the synthetic task`);
        expect(factories[id]).toBe(1);
        expect(AdmissionAdapter.playerCalls).toBe(id === 'code' ? 1 : 2);
        expect(stopped.snapshot.frames).toHaveLength(1);
        expect(JSON.stringify(stopped.snapshot)).not.toContain(packaged(id));
        await assertGitUnchanged();
      });
    });
  }
});
