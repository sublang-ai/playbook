// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assign, createMachine } from 'xstate';
import { createEvent } from '@sublang/cligent';
import { createXStatePlaybookRuntime } from '../../../../src/xstate-runtime.js';
import { createSessionStore } from '../session-store.js';
import { validateCaptainSessionRecord } from '../bin/session-store.js';
import { openSessionHost } from '../session-host.js';
import { executionConfigFromPlan } from '../bin/run.js';
import { loadLaunchPlan } from '../bin/launch-config.js';

const [dir, phase] = process.argv.slice(2);
const sessionId = '96000000-0000-4000-8000-000000000001';
const finding = 'The primary button is hidden behind the footer. Move it above the footer.';
const question = 'Should I inspect the page again?';
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
let completing = false;
const meta = (stateId) => ({ playbook: { stateId, description: stateId } });
const factory = createXStatePlaybookRuntime(createMachine({
  initial: 'ready', context: { task: '' }, states: {
    ready: { meta: meta('ready'), tags: ['playbook.parked'], on: { START: {
      target: 'inspect', actions: assign({ task: ({ event }) => event.text }),
    } } },
    inspect: {
      meta: { playbook: { stateId: 'inspect', description: 'Inspect the page', role: 'inspector' } },
      tags: ['playbook.busy'], invoke: {
        src: 'player', input: ({ context }) => ({
          stateId: 'inspect', sourceItem: 'INSPECT-1', role: 'inspector',
          prompt: `Inspect page: ${context.task}`,
          ...(context.bossReply ? { bossReply: context.bossReply, pendingBossQuestion: context.pendingBossQuestion } : {}),
          result: { done: 'Inspection complete.' },
        }),
        onDone: [
          { guard: ({ context }) => context.bossReply === undefined, target: 'awaitBossReply', actions: [
            assign({ pendingBossQuestion: () => ({ questionId: 'page', resumeStateId: 'inspect', sourceItem: 'INSPECT-1', asker: { kind: 'captain' }, question }) }),
            { type: 'playbook.acceptedOutcome', params: { source: 'inspect', target: 'awaitBossReply', acceptedOutcome: 'done' } },
          ] },
          { target: 'done', actions: { type: 'playbook.acceptedOutcome', params: { source: 'inspect', target: 'done', acceptedOutcome: 'done' } } },
        ], onError: 'failed',
      },
    },
    awaitBossReply: { meta: meta('awaitBossReply'), tags: ['playbook.parked'], on: { BOSS_REPLY: {
      target: 'inspect', actions: assign({ bossReply: ({ event }) => event.answer }),
    } } },
    failed: { meta: meta('failed'), tags: ['playbook.parked'] },
    done: { meta: meta('done'), type: 'final' },
  },
}, { actions: { 'playbook.acceptedOutcome': () => {} } }), {
  label: 'inspection', compat: { artifactSchema: 3, runtimeAbi: 1 },
  snapshotOptions: () => ({}), unfinishedFinalStateIds: [],
  entryEvent: { type: 'START', textField: 'text' },
  roleStates: { inspect: { role: 'inspector', label: 'Inspect the page' } },
  outcomeAuthority: { governedPlayerStates: { inspect: {
    done: { fields: {}, repositoryDisposition: 'unchanged' },
  } } },
});
const registry = {
  id: 'inspection', command: 'inspection', intent: 'Inspect a page', artifactSchema: 3,
  runtimeProfile: { kind: 'shared-factory', compat: factory.compat },
  requiredRoleIds: ['inspector'], concurrentRoleSets: [], validateOptions: () => ({}),
  createRuntime: (configuredOptions, hostCapabilities) => factory({ configuredOptions, hostCapabilities }),
};
const loadModule = async () => ({ default: registry });
class Adapter {
  agent = 'claude-code';
  async *run(prompt) {
    assert.equal(phase, 'start', 'recovery must make no provider call');
    await appendFile(join(dir, 'calls'), 'call\n');
    let result;
    if (prompt.includes('Check whether existing instructions already answer')) result = '{"instructionIndex":null}';
    else if (prompt.includes('Classify the following Boss message')) result = '{"type":"BOSS_REPLY","questionId":"page"}';
    else if (prompt.includes('Select exactly one action')) result = JSON.stringify(prompt.includes('[Boss message]\nResume inspection')
      ? { action: 'resume', playbookId: 'inspection' } : { action: 'dismiss' });
    else if (prompt.includes('An action just settled')) result = 'The inspection is waiting for a page.';
    else if (prompt.includes('This is hidden control work.')) result = JSON.stringify({ guard: 'done' });
    else {
      assert(prompt.includes('Inspect page:'), prompt.slice(0, 120));
      result = finding;
      await appendFile(join(dir, 'players'), 'finding\n');
    }
    yield createEvent('done', this.agent, { status: 'success', result, resumeToken: 'fixture', usage: { toolUses: 0 }, durationMs: 1 }, 'fixture');
  }
}

if (phase === 'start') {
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, '.gitignore'), 'sessions/\nconfig.yaml\ncalls\nplayers\nidentities.json\n');
  git('add', '.gitignore'); git('commit', '-qm', 'baseline');
  await writeFile(join(dir, 'calls'), ''); await writeFile(join(dir, 'players'), '');
  await writeFile(join(dir, 'config.yaml'), 'captain: { adapter: claude, model: fixture }\nplayers:\n  page.inspector: { adapter: claude, model: fixture }\nplaybooks:\n  inspection: { from: "fixture://inspection", roles: { inspector: page.inspector } }\n');
}
const store = createSessionStore({ sessionsDir: join(dir, 'sessions') });
const wrapped = { ...store, async acquire(id) {
  const lease = await store.acquire(id);
  return { ...lease, async recordProgress(change) {
    assert.equal(phase, 'start', 'recovery must write no execution progress');
    await lease.recordProgress(change);
    if (completing && change.step?.kind === 'completion') {
      assert.equal(change.snapshot.mode, 'chat');
      assert.equal(change.snapshot.frames?.length ?? 0, 0, 'completed adopted runtime was disposed');
      process.kill(process.pid, 'SIGKILL');
    }
  } };
} };
const config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: join(dir, 'config.yaml'), loadModule }));
const beforeCalls = await readFile(join(dir, 'calls'), 'utf8');
const host = await openSessionHost({ store: wrapped, config, loadModule, cwd: dir, sessionId, mode: phase === 'start' ? 'new' : 'recover', adapterImports: { claude: async () => Adapter } });
if (phase === 'start') {
  const parked = await host.handleBossTurn('/inspection Inspect the selected page');
  const sourceId = parked.snapshot.frames[0].sessionId;
  assert.equal(parked.snapshot.frames[0].runtime.state.stateId, 'awaitBossReply');
  await host.handleBossTurn('Stop inspection');
  const adopted = await host.handleBossTurn('Resume inspection');
  const targetId = adopted.snapshot.frames[0].sessionId;
  assert.notEqual(sourceId, targetId);
  assert.equal(adopted.snapshot.frames[0].runtime.retainedEffectSourceSessionId, sourceId);
  await writeFile(join(dir, 'identities.json'), JSON.stringify({ sourceId, targetId }));
  completing = true;
  await host.handleBossTurn('/inspection Inspect the home page');
  throw new Error('Expected process loss after adopted-root completion');
}
const { sourceId, targetId } = JSON.parse(await readFile(join(dir, 'identities.json'), 'utf8'));
const record = await host.read();
assert.equal(record.uncertain.progress.snapshot.frames?.length ?? 0, 0);
const step = record.uncertain.progress.steps.find((entry) => entry.kind === 'player' && entry.workerEvidence);
assert(step, 'accepted adopted result must save its exact evidence reference');
assert.equal(step.runtimeSessionId, targetId);
assert.equal(step.workerEvidence.playerId, 'page.inspector');
const boundary = record.effectLedger.boundaries.find((entry) => entry.boundaryId === step.workerEvidence.boundaryId);
assert.equal(boundary.runtimeSessionId, sourceId);
assert.equal(boundary.finalText, finding);
const preceding = record.snapshot.effectLedger.boundaries.find((entry) => entry.runtimeSessionId === sourceId && entry.callId === boundary.callId);
assert(preceding, 'adoption restarts native call numbering under retained effect ownership');
assert.equal(preceding.finalText, finding);
assert.deepEqual(preceding.semanticCandidate, boundary.semanticCandidate);
assert.notEqual(preceding.boundaryId, boundary.boundaryId);
const staleReference = structuredClone(record);
staleReference.uncertain.progress.steps.find((entry) => entry.workerEvidence).workerEvidence.boundaryId = preceding.boundaryId;
assert.throws(() => validateCaptainSessionRecord(staleReference), /Worker evidence must name its accepted player boundary/);
const duplicateReference = structuredClone(record);
duplicateReference.uncertain.progress.steps.push({ ...structuredClone(step), id: '96000000-0000-4000-8000-000000000099' });
assert.throws(() => validateCaptainSessionRecord(duplicateReference), /Worker evidence must name its accepted player boundary/);
const recovered = await host.recover();
assert.equal(recovered.state, 'settled');
const reply = recovered.snapshot.journal.filter((entry) => entry.kind === 'reply').at(-1).payload;
assert(reply.includes(`Player "page.inspector" reported: ${JSON.stringify(finding)}`), reply);
assert(!reply.includes('You may summarize'), reply);
assert.equal(await readFile(join(dir, 'calls'), 'utf8'), beforeCalls, 'recovery must not replay providers');
assert.equal(await readFile(join(dir, 'players'), 'utf8'), 'finding\nfinding\n');
await host.dispose();
console.log(JSON.stringify({ settled: true }));
