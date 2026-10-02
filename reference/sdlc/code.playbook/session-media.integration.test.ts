// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvent, type AgentOptions } from '@sublang/cligent';
import { expect, it } from 'vitest';
import { questionRegistry } from '../../../acceptance-fixtures/captain-question-flow.js';
import { createSessionStore } from './session-store.js';
import { openSessionHost, executionConfigFromPlan, loadLaunchPlan } from './session-host.js';
import { assetUri, createAssetStore, externalizeAgentEvent, type SessionAssetRef } from './session-assets.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNQCt0NRAwQCgAfIgTJbJMJcQAAAABJRU5ErkJggg==', 'base64');

it('preserves attachment-only turns, explicitly relays pending evidence and stores real worker media through the durable host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playbook-media-host-'));
  const cwd = join(root, 'repo');
  const calls: Array<{ prompt: string; options?: AgentOptions }> = [];
  const records: any[] = [];
  let selected: SessionAssetRef;
  let selectedEarlier = true;
  const largeResult = { content: [{ type: 'image', data: png.toString('base64').repeat(100), mimeType: 'image/png' }] };
  class Adapter {
    readonly agent = 'claude-code';
    async *run(prompt: string, options?: AgentOptions) {
      calls.push({ prompt, options });
      const marker = '--- BEGIN VERBATIM RUNTIME PROMPT ---';
      const index = prompt.lastIndexOf(marker);
      const policy = index < 0 ? prompt : prompt.slice(index + marker.length).split('--- END VERBATIM RUNTIME PROMPT ---')[0]!;
      let result: string;
      if (policy.includes('An action just settled for the current Boss turn')) {
        expect(options?.browser).toBe(false); expect(options?.mcpServers).toEqual({});
        expect(prompt).toContain('metadata only');
        expect(prompt).toContain('Player \"worker\" reported: \"I inspected the image.\"');
        expect(prompt).toContain('Only the canonical settlement and receipts establish effects');
        result = 'The worker inspected the image; the screenshot shows its observation.';
      } else if (policy.includes('Select exactly one action from the closed set')) {
        expect(options?.browser).toBe(false); expect(options?.mcpServers).toEqual({});
        result = JSON.stringify({ action: 'start', playbookId: 'question-flow', input: 'Inspect the evidence.', ...(selectedEarlier ? { attachmentIds: [selected.assetId] } : {}) });
      } else if (prompt.startsWith('You are the Playbook Captain shell hidden-control judge.')) {
        expect(options?.browser).toBe(false); expect(options?.mcpServers).toEqual({});
        result = JSON.stringify({ guard: 'done' });
      } else if (prompt.includes('QUESTION_RELAY_WORKER:')) {
        expect(options?.browser).toBe(selectedEarlier);
        expect(options?.attachments ?? []).toHaveLength(selectedEarlier ? 1 : 0);
        if (selectedEarlier) expect(await readFile(options!.attachments![0]!.path)).toEqual(png);
        yield createEvent('tool_result', this.agent, { toolUseId: 'capture', output: largeResult, isError: false });
        yield createEvent('media', this.agent, { mimeType: 'image/png', source: { type: 'base64', data: png.toString('base64') }, toolUseId: 'capture', name: 'Screenshot.png' });
        yield createEvent('media', this.agent, { mimeType: 'image/png', source: { type: 'base64', data: png.toString('base64') }, toolUseId: 'capture' });
        result = 'I inspected the image.';
      } else throw new Error(`Unexpected call: ${prompt.slice(0, 150)}`);
      yield createEvent('done', this.agent, { status: 'success', result, resumeToken: options?.resume ?? randomUUID(), usage: { toolUses: 0 }, durationMs: 1 });
    }
  }
  try {
    await mkdir(cwd); execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'baseline'], { cwd });
    const configPath = join(root, 'config.yaml');
    const configuration = (browser: boolean) => `captain: { adapter: claude, model: captain, browser: ${browser} }\nplayers:\n  worker: { adapter: claude, model: worker, browser: ${browser} }\nplaybooks:\n  question-flow:\n    from: mod://question-flow\n    roles: { worker: worker }\n`;
    await writeFile(configPath, configuration(true));
    const loadModule = async () => ({ default: questionRegistry });
    const adapterImports = { claude: async () => Adapter } as never;
    let config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath, loadModule }));
    const store = createSessionStore({ sessionsDir: join(root, 'sessions') });
    let sessionId: string | undefined;
    const open = () => openSessionHost({ store, cwd, config, loadModule, adapterImports, ...(sessionId ? { mode: 'continue' as const, sessionId } : { mode: 'new' as const }), observers: [{ onRecord(record: any) { records.push(record); } }] });
    let controller = await open(); sessionId = controller.sessionId;
    selected = await controller.lease.importAsset({ bytes: png, mimeType: 'image/png', name: 'Reference.png' });
    const blank = await controller.handleBossTurn({ text: '', attachments: [selected] });
    expect(blank.state).toBe('settled'); expect(calls).toHaveLength(0);
    expect(records.find(record => record.type === 'turn_started').turn).toMatchObject({ prompt: '', attachments: [selected] });
    expect(records.filter(record => record.type === 'captain_reply').at(-1).text).toContain('What would you like');
    expect((blank.snapshot as any).pendingAttachments).toEqual([selected]);
    await controller.dispose();
    controller = await open();
    const completed = await controller.handleBossTurn('Analyze this image.');
    expect(completed.snapshot.mode).toBe('chat');
    await controller.dispose();
    const evidence = records.filter(record => record.type === 'playbook_evidence');
    expect(evidence).toHaveLength(1); expect(evidence[0]).toMatchObject({ turnId: 2, origin: { kind: 'player', actorId: 'worker', toolUseId: 'capture' }, asset: { assetId: selected.assetId } });
    expect(Buffer.from(await store.readAsset(sessionId, evidence[0].asset))).toEqual(png);
    const stream = await store.readStream(sessionId);
    expect(JSON.stringify(stream.entries)).not.toContain(png.toString('base64'));
    const tool = records.find(record => record.type === 'player_event' && record.event.type === 'tool_result');
    expect(JSON.parse(Buffer.from(await store.readAsset(sessionId, tool.event.payload.output.asset)).toString())).toEqual(largeResult);
    expect(records.find(record => record.type === 'player_event' && record.event.type === 'media').event.payload.source).toEqual({ type: 'uri', uri: assetUri(selected) });
    selectedEarlier = false; await writeFile(configPath, configuration(false));
    config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath, loadModule }));
    controller = await open();
    await controller.handleBossTurn('Inspect an unrelated thing.'); await controller.dispose();
    expect(records.filter(record => record.type === 'playbook_evidence')).toHaveLength(2);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('shares visible media ingestion with independent owners without inferring files or fetching URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playbook-media-ingest-'));
  try {
    const store = createAssetStore({ directory: join(root, 'authoring.assets') });
    const event = createEvent('media', 'claude-code', { mimeType: 'image/png', source: { type: 'base64', data: png.toString('base64') }, name: '/machine/path/output.png' });
    const result = await externalizeAgentEvent(store, event);
    expect(result.event).toMatchObject({ sessionId: event.sessionId, timestamp: event.timestamp, payload: { source: { type: 'uri', uri: assetUri(result.asset!) } } });
    expect(result.asset?.name).toBe('output.png'); expect(Buffer.from(await store.readAsset(result.asset!))).toEqual(png);
    const spaced = createEvent('media', 'claude-code', { mimeType: 'IMAGE/PNG; charset=binary', source: { type: 'base64', data: png.toString('base64').replace(/.{20}/g, '$&\n') } });
    const normalized = await externalizeAgentEvent(store, spaced);
    expect(normalized.asset).toMatchObject({ assetId: result.asset!.assetId, mimeType: 'image/png' });
    expect(normalized.event).toMatchObject({ sessionId: spaced.sessionId, timestamp: spaced.timestamp, payload: { mimeType: 'image/png', source: { type: 'uri', uri: assetUri(result.asset!) } } });
    const remote = createEvent('media', 'claude-code', { mimeType: 'image/png', source: { type: 'uri', uri: 'https://example.invalid/image.png' } });
    expect((await externalizeAgentEvent(store, remote)).event).toBe(remote);
    const malformed = createEvent('media', 'claude-code', { mimeType: 'image/png', source: { type: 'base64', data: 'not base64!' } });
    await expect(externalizeAgentEvent(store, malformed)).rejects.toThrow('base64');
    expect((await store.listAssets())).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('promotes only explicitly scoped preparation media and reports failed persistence without inline payloads', async () => {
  const { createSessionMediaProjector } = await import('./bin/session-media.js');
  const root = await mkdtemp(join(tmpdir(), 'playbook-preparation-media-'));
  try {
    const store = createAssetStore({ directory: join(root, 'evidence.assets') });
    const delivered: SessionAssetRef[] = [];
    const projector = createSessionMediaProjector({ lease: store, onEvidence: (reference: SessionAssetRef) => { delivered.push(reference); } });
    const record = { type: 'captain_event', timestamp: 1, turnId: 1, visibility: 'hidden', event: createEvent('media', 'claude-code', { mimeType: 'image/png', source: { type: 'base64', data: png.toString('base64') } }) };
    expect(await projector.project(record)).toHaveLength(1);
    const end = projector.beginPreparation('runtime');
    const prepared = await projector.project(record);
    expect(prepared).toHaveLength(2); expect(prepared[1]).toMatchObject({type:'playbook_evidence',origin:{kind:'preparation',actorId:'captain',runtimeSessionId:'runtime'}});
    expect(await projector.project(record)).toHaveLength(1); expect(delivered).toHaveLength(1);
    end(); expect(await projector.project(record)).toHaveLength(1);
    const bounded = createSessionMediaProjector({ lease: createAssetStore({ directory: join(root, 'limited.assets'), maxAssetBytes: 1 }) });
    const failure = await bounded.project(record); expect(failure).toHaveLength(1); expect(failure[0].type).toBe('runtime_error');
    expect(JSON.stringify(failure)).not.toContain(png.toString('base64'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
