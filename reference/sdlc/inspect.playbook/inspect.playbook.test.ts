// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvent, type AgentOptions } from '@sublang/cligent';
import { expect, it } from 'vitest';
import { createSessionStore } from '../code.playbook/session-store.js';
import { openSessionHost, executionConfigFromPlan, loadLaunchPlan } from '../code.playbook/session-host.js';
import registry from './inspect.registry.js';
import { assertWorkflowTerminal } from '../../../scripts/test-support/workflow-contracts.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNQCt0NRAwQCgAfIgTJbJMJcQAAAABJRU5ErkJggg==', 'base64');
const finding = 'The screenshot shows the primary action below the footer. Move it above the footer so it remains visible.';

it.each(['completed', 'unavailable', 'question', 'mutation'] as const)('runs the compiled inspection through the durable host: %s', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'inspect-host-'));
  const cwd = join(root, 'repo');
  const calls: Array<{ prompt: string; options?: AgentOptions }> = [];
  const records: any[] = [];
  const runtimeResults: any[] = [];
  let workerCalls = 0;
  let answering = false;
  const unavailable = 'The supplied interface cannot be reached, so its layout cannot be assessed.';
  const question = 'Which local URL should I inspect?';
  const expected = scenario === 'unavailable' ? unavailable : finding;
  class Adapter {
    readonly agent = 'claude-code';
    async *run(prompt: string, options?: AgentOptions) {
      calls.push({ prompt, options });
      let result: string;
      if (prompt.includes('An action just settled for the current Boss turn')) {
        expect(options?.browser).toBe(false); expect(options?.mcpServers).toEqual({});
        if (scenario === 'mutation') expect(prompt).not.toContain('Player "inspector" reported:');
        else if (scenario !== 'question' || answering) expect(prompt).toContain(JSON.stringify(expected));
        result = scenario === 'mutation' ? 'The attempted inspection changed repository files and was not accepted.' : scenario === 'question' && !answering ? question : expected;
      } else if (prompt.includes('You are Captain preparing an interrupted playbook')) {
        result = JSON.stringify({status:'blocked',summary:'The inspection requires the repository to remain unchanged.'});
      } else if (prompt.includes('Check whether existing instructions already answer')) {
        result = '{"instructionIndex":null}';
      } else if (prompt.includes('Classify the following Boss message')) {
        result = '{"type":"BOSS_REPLY","questionId":"inspecting"}';
      } else if (prompt.includes('hidden-control judge')) {
        expect(options?.browser).toBe(false); expect(options?.mcpServers).toEqual({});
        result = scenario === 'question' && !answering
          ? JSON.stringify({ guard: 'needsBossReply' })
          : JSON.stringify({ guard: scenario === 'unavailable' ? 'unavailable' : 'completed', status: scenario === 'unavailable' ? 'unavailable' : 'complete' });
      } else if (prompt.includes('Inspect the requested material and give an evidence-based explanation.')) {
        workerCalls++;
        expect(options?.browser).toBe(true);
        expect(options?.attachments).toHaveLength(1);
        expect(await readFile(options!.attachments![0]!.path)).toEqual(png);
        if (scenario === 'mutation') await writeFile(join(cwd, 'unexpected.txt'), 'a change the read-only workflow must reject');
        if (scenario === 'question' && !answering) result = question;
        else {
          if (answering) expect(prompt).toContain('http://127.0.0.1:3000');
          yield createEvent('media', this.agent, { mimeType: 'image/png', source: { type: 'base64', data: png.toString('base64') }, toolUseId: 'screenshot' });
          result = expected;
        }
      } else throw new Error(`Unexpected call: ${prompt.slice(0, 180)}`);
      yield createEvent('done', this.agent, { status: 'success', result, resumeToken: options?.resume ?? randomUUID(), usage: { toolUses: 0 }, durationMs: 1 });
    }
  }
  try {
    await mkdir(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '-q'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'baseline');
    const baseline = git('rev-parse', 'HEAD');
    const path = join(root, 'config.yaml');
    await writeFile(path, 'captain: { adapter: claude, model: fixture, browser: true }\nplayers:\n  inspector: { adapter: claude, model: fixture, browser: true }\nplaybooks:\n  inspect: { from: "mod://inspect", roles: { inspector: inspector } }\n');
    const loadModule = async () => ({ default: { ...registry, createRuntime(...args: Parameters<typeof registry.createRuntime>) { const runtime = registry.createRuntime(...args); return { ...runtime, async handleBossInput(...input: Parameters<typeof runtime.handleBossInput>) { const result = await runtime.handleBossInput(...input); runtimeResults.push(result); return result; } }; } } });
    const config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: path, loadModule }));
    const store = createSessionStore({ sessionsDir: join(root, 'sessions') });
    const options = { store, cwd, config, loadModule, adapterImports: { claude: async () => Adapter } as never, observers: [{ onRecord(record: any) { records.push(record); } }] };
    let host = await openSessionHost({ ...options, mode: 'new' });
    const id = host.sessionId;
    const asset = await host.lease.importAsset({ bytes: png, mimeType: 'image/png', name: 'Reference.png' });
    let saved = await host.handleBossTurn({ text: '/inspect Explain the interface and its primary action.', attachments: [asset] });
    if (scenario === 'question') {
      expect(saved.snapshot.mode).toBe('engaged.parked');
      expect(saved.snapshot.pendingBossQuestions).toBeDefined();
      expect(saved.snapshot.pendingBossQuestions[0].question).toBe(question);
      await host.dispose();
      const before = calls.length;
      host = await openSessionHost({ ...options, mode: 'continue', sessionId: id });
      expect(calls).toHaveLength(before);
      answering = true;
      saved = await host.handleBossTurn('/inspect http://127.0.0.1:3000');
    }
    expect(git('rev-parse', 'HEAD')).toBe(baseline);
    const boundaries = saved.effectLedger.boundaries;
    expect(boundaries.length).toBeGreaterThan(0);
    if (scenario === 'mutation') {
      expect(boundaries.some((boundary: any) => boundary.physicalReceipt?.classification !== 'unchanged')).toBe(true);
      expect(saved.snapshot.mode).toBe('engaged.parked');
      expect(saved.snapshot.journal.filter((entry: any) => entry.kind === 'reply').at(-1).payload).not.toContain('The screenshot shows');
    } else {
      expect(git('status', '--porcelain')).toBe('');
      expect(boundaries.every((boundary: any) => boundary.physicalReceipt?.classification === 'unchanged')).toBe(true);
      expect(boundaries.at(-1).finalText).toBe(expected);
      const terminal = runtimeResults.findLast(result => result.outcome === 'terminal');
      assertWorkflowTerminal('inspect', terminal);
      expect(terminal.output.report).toBe(expected);
      expect(saved.snapshot.mode).toBe('chat');
      expect(saved.snapshot.journal.filter((entry: any) => entry.kind === 'reply').at(-1).payload).toContain(expected);
      const evidence = records.filter((record) => record.type === 'playbook_evidence');
      expect(evidence).toHaveLength(1);
      expect(evidence[0].origin).toMatchObject({ kind: 'player', actorId: 'inspector', toolUseId: 'screenshot' });
      expect(Buffer.from(await store.readAsset(id, evidence[0].asset))).toEqual(png);
    }
    expect(workerCalls).toBe(scenario === 'question' ? 2 : 1);
    await host.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
