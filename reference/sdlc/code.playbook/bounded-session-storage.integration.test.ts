// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionStore, projectCaptainSessionStructure } from './session-store.js';
import { createBoundedReplay } from './bin/session-replay.js';
import { MAX_SESSION_CHUNK_BYTES } from './bin/session-chunks.js';

const roots: string[] = [];
const captainRuntimeId = '80000000-0000-4000-8000-000000000001';
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function executionProjection() {
  return {
    schemaVersion: 2,
    captain: { adapter: 'claude', model: { kind: 'provider-default' }, effort: { kind: 'provider-default' }, permissions: { mode: 'auto' } },
    players: [{ id: 'dev.coder', adapter: 'codex', model: { kind: 'provider-default' }, effort: { kind: 'value', value: 'high' }, permissions: { fileWrite: 'ask' } }],
    catalog: { code: {
      id: 'code', from: '@sublang/playbook/code/registry', manifestCommand: 'code', command: 'code', intent: 'Implement a requested change.',
      artifactSchema: 3, requiredRoleIds: ['coder'], concurrentRoleSets: [],
      roles: { coder: { playerId: 'dev.coder', model: { kind: 'provider-default' }, effort: { kind: 'value', value: 'high' } } }, options: {},
    } },
  };
}
const effectLedger = () => ({ schemaVersion: 1, revision: 0, boundaries: [], logicalOperations: [] });
function shellSnapshot(turn = 0, payload = 'next') {
  const structural = projectCaptainSessionStructure(executionProjection());
  const state = { value: 'routing', activeStateIds: ['routing'], tags: ['playbook.parked'], status: 'active', quiescent: true, stateId: 'routing' };
  const journal = Array.from({ length: turn }, (_, index) => ({ seq: index + 1, turnId: index + 1, kind: 'boss', payload }));
  return {
    schemaVersion: 4,
    captain: {
      sessionId: captainRuntimeId,
      runtime: { schemaVersion: 4, playbookId: 'captain', machine: { value: state.value, status: state.status }, roleResumeTokens: {},
        sequences: { trace: 0, turn, judgeCall: 0, playerCall: 0, playbookCall: 0, captainCall: 0 }, state, pendingBossQuestions: [], effectLedger: effectLedger() },
      agent: structural.captain, conversation: turn === 0 ? { kind: 'unopened' } : { kind: 'needsSeeding' },
    },
    playerSessions: Object.fromEntries(structural.players.map(({ id, ...agent }: any) => [id, agent])),
    issuedSessionIds: [captainRuntimeId], sequences: { turn, journal: journal.length }, journal, effectLedger: effectLedger(),
    ...(turn ? { lastAction: 'respond', lastSettlementStatus: 'ok' } : {}), mode: 'chat',
  };
}
function freshBoundary(turn = 0, payload?: string) {
  const execution = executionProjection();
  return { cwd: process.cwd(), structuralProjection: projectCaptainSessionStructure(execution), executionProjection: execution, snapshot: shellSnapshot(turn, payload) };
}
async function fixture(fsOps?: object) {
  const root = await fs.mkdtemp(join(tmpdir(), 'bounded-session-store-')); roots.push(root);
  const sessionsDir = join(root, 'sessions');
  const store = createSessionStore({ sessionsDir, hostname: 'bounded-storage-integration', fsOps });
  const id = randomUUID();
  const lease = await store.acquire(id);
  await lease.initializeSettledWithPredecessor(freshBoundary() as any);
  return { root, sessionsDir, store, id, lease, file: join(sessionsDir, `${id}.json`), replayRoot: join(sessionsDir, `${id}.replay.json`), chunksDir: join(sessionsDir, `${id}.chunks`) };
}
async function bytesFor(sessionsDir: string, sessionId: string) {
  return (await createBoundedReplay({ sessionsDir, sessionId })).readBytes();
}
async function assertBoundedFiles(sessionsDir: string, id: string) {
  const files = [`${id}.json`, `${id}.replay.json`, ...(await fs.readdir(join(sessionsDir, `${id}.chunks`))).map((name) => `${id}.chunks/${name}`)];
  let total = 0;
  for (const file of files) {
    const stat = await fs.stat(join(sessionsDir, file));
    expect(stat.size).toBeLessThanOrEqual(MAX_SESSION_CHUNK_BYTES);
    expect(stat.mode & 0o777).toBe(0o600);
    total += stat.size;
  }
  return total;
}

describe('bounded session storage through the shared lifecycle', () => {
  it.each(['shape', 'cwd'])('refuses unchanged invalid schema7 %s before creating lease or derived state', async (invalid) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'bounded-invalid-legacy-')); roots.push(root);
    const sessionsDir = join(root, 'sessions'); await fs.mkdir(sessionsDir, { mode: 0o700 });
    const id = randomUUID();
    const manifest = { schemaVersion: 7, kind: 'captain-session', sessionId: id, cwd: invalid === 'cwd' ? 'relative' : process.cwd(),
      state: 'history-only', reason: 'fixture', createdAt: '2026-08-11T21:00:00.000Z', updatedAt: '2026-08-11T21:00:00.000Z',
      replay: { seq: 0, sha256: digest(Buffer.alloc(0)), incomplete: false }, contextSeq: null, ...(invalid === 'shape' ? { extra: true } : {}) };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const path = join(sessionsDir, `${id}.json`);
    await fs.writeFile(path, bytes, { mode: 0o600 });
    await fs.writeFile(join(sessionsDir, `${id}.records.jsonl`), '', { mode: 0o600 });
    const before = (await fs.readdir(sessionsDir)).sort();
    const store = createSessionStore({ sessionsDir, hostname: 'bounded-storage-integration' });
    await expect(store.migrate(id)).rejects.toThrow();
    expect((await fs.readdir(sessionsDir)).sort()).toEqual(before);
    expect((await fs.readFile(path)).equals(bytes)).toBe(true);
  });

  it('creates owned chunk directories inside an existing externally prepared sessions directory', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'bounded-prepared-sessions-')); roots.push(root);
    const sessionsDir = join(root, 'sessions');
    await fs.mkdir(sessionsDir, { mode: 0o700 });
    const store = createSessionStore({ sessionsDir, createSessionsDir: false, hostname: 'bounded-storage-integration' });
    const id = randomUUID();
    const lease = await store.acquire(id);
    await expect(lease.initializeSettledWithPredecessor(freshBoundary() as any)).resolves.toMatchObject({ state: 'settled' });
    await lease.release();
    expect((await store.validate(id)).integrityValid).toBe(true);
    expect((await fs.stat(join(sessionsDir, `${id}.chunks`))).isDirectory()).toBe(true);
  });

  it('writes schema8 roots, checkpoints an oversized event, and exports a portable closure with an exact proven prefix', async () => {
    const { root, sessionsDir, store, id, lease, file } = await fixture();
    const physical = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(physical).toMatchObject({ schemaVersion: 8, kind: 'captain-session-storage', sessionId: id, state: 'settled' });
    expect((await fs.stat(file)).size).toBeLessThan(1024);
    await expect(fs.stat(join(sessionsDir, `${id}.records.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
    const text = '🦉'.repeat(2 * 1024 * 1024 + 100);
    await lease.append({ type: 'opaque_history', timestamp: 1, text });
    const attemptId = randomUUID();
    await lease.beginTurn({ input: 'next', attemptId, attemptedExecutionProjection: executionProjection() });
    await lease.settle({ attemptId, snapshot: shellSnapshot(1), unresolvedEffects: [] });
    const manifest = await store.readManifest(id);
    const prefix = await bytesFor(sessionsDir, id);
    expect(prefix.length).toBeGreaterThan(MAX_SESSION_CHUNK_BYTES);
    expect(manifest.replay.sha256).toBe(digest(prefix));
    await lease.append({ type: 'opaque_tail', timestamp: 2, text: 'later presentation' });
    await lease.release();
    const history = await store.readHistory(id);
    expect(history.entries[1].record.text === text).toBe(true);
    expect(history.entries.at(-1).record.type).toBe('opaque_tail');
    expect((await store.validate(id)).integrityValid).toBe(true);
    const logical = await store.read(id);
    expect(logical.snapshot.journal).toEqual(shellSnapshot(1).journal);
    const bundle = await store.exportBundle(id);
    expect(bundle.replay.equals(prefix)).toBe(true);
    expect(bundle.manifest.equals(await fs.readFile(file))).toBe(true);
    const paths = bundle.files.map(({ path }: any) => path);
    expect(paths).toContain(`${id}.json`);
    expect(paths).toContain(`${id}.replay.json`);
    expect(paths.some((path: string) => path.startsWith(`${id}.chunks/`))).toBe(true);
    const copyDir = join(root, 'portable-copy');
    await fs.mkdir(copyDir, { mode: 0o700 });
    for (const entry of bundle.files) {
      const target = join(copyDir, entry.path);
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(join(sessionsDir, entry.path), target);
      await fs.chmod(target, 0o600);
      expect((await fs.stat(target)).size).toBe(entry.byteLength);
    }
    const copied = createSessionStore({ sessionsDir: copyDir, hostname: 'bounded-storage-integration' });
    expect(await copied.read(id)).toEqual(logical);
    expect((await copied.validate(id)).integrityValid).toBe(true);
    expect((await copied.readHistory(id)).entries.at(-1).record.type).toBe('opaque_tail');
    await assertBoundedFiles(sessionsDir, id);
  }, 30_000);

  it('hydrates repeated large journal evidence without copying equal evidence into every physical checkpoint', async () => {
    const payload = 'repeated observation '.repeat(110_000);
    const { store, id, lease, file, sessionsDir } = await fixture();
    for (let turn = 1; turn <= 6; turn++) {
      const attemptId = randomUUID();
      await lease.beginTurn({ input: payload, attemptId, attemptedExecutionProjection: executionProjection() });
      await lease.settle({ attemptId, snapshot: shellSnapshot(turn, payload), unresolvedEffects: [] });
    }
    const expected = await lease.read();
    await lease.release();
    const reopened = createSessionStore({ sessionsDir, hostname: 'bounded-storage-integration' });
    const actual = await reopened.read(id);
    expect(actual.snapshot.journal.length).toBe(6);
    expect(actual.snapshot.journal.every((entry: any) => entry.payload === payload)).toBe(true);
    expect(digest(Buffer.from(JSON.stringify(actual)))).toBe(digest(Buffer.from(JSON.stringify(expected))));
    const manifest = await reopened.readManifest(id);
    const logicalLength = Buffer.byteLength(JSON.stringify(manifest));
    expect(logicalLength).toBeGreaterThan(MAX_SESSION_CHUNK_BYTES);
    expect(await assertBoundedFiles(sessionsDir, id)).toBeLessThan(logicalLength / 2);
    expect((await fs.stat(file)).size).toBeLessThan(1024);
    expect((await store.validate(id)).integrityValid).toBe(true);
  }, 30_000);

  it('migrates an exact schema7 bundle explicitly, retains source bytes, and preserves logical recovery and replay', async () => {
    const { root, store, id, lease, file, replayRoot, chunksDir, sessionsDir } = await fixture();
    await lease.append({ type: 'opaque_history', timestamp: 1, text: 'retained byte-for-byte' });
    const attemptId = randomUUID();
    await lease.beginTurn({ input: 'next', attemptId, attemptedExecutionProjection: executionProjection() });
    await lease.settle({ attemptId, snapshot: shellSnapshot(1), unresolvedEffects: [] });
    const logicalManifest = await store.readManifest(id);
    const recovery = await store.read(id);
    const replay = await bytesFor(sessionsDir, id);
    await lease.release();
    const originalManifest = Buffer.from(` ${JSON.stringify(logicalManifest)}\n`);
    await fs.writeFile(file, originalManifest, { mode: 0o600 });
    const legacyReplay = join(sessionsDir, `${id}.records.jsonl`);
    await fs.writeFile(legacyReplay, replay, { mode: 0o600 });
    await fs.unlink(replayRoot);
    await fs.rm(chunksDir, { recursive: true });
    const legacyStore = createSessionStore({ sessionsDir, hostname: 'bounded-storage-integration' });
    expect(await legacyStore.read(id)).toEqual(recovery);
    expect((await legacyStore.validate(id)).integrityValid).toBe(true);
    expect((JSON.parse(await fs.readFile(file, 'utf8'))).schemaVersion).toBe(7);
    const migrated = await legacyStore.migrate(id);
    expect(migrated.migrated).toBe(true);
    expect((JSON.parse(await fs.readFile(file, 'utf8'))).schemaVersion).toBe(8);
    expect(await legacyStore.read(id)).toEqual(recovery);
    expect((await bytesFor(sessionsDir, id)).equals(replay)).toBe(true);
    const backup = join(root, 'local', 'migrations', id, 'bounded');
    expect((await fs.readFile(join(backup, 'manifest'))).equals(originalManifest)).toBe(true);
    expect((await fs.readFile(join(backup, 'replay'))).equals(replay)).toBe(true);
    await expect(fs.stat(legacyReplay)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await legacyStore.validate(id)).integrityValid).toBe(true);
  });

  it.each(['valid', 'torn', 'saved-incomplete'])('normalizes only unaccepted schema7 replay tail while retaining original bytes: %s', async (tailKind) => {
    const { root, store, id, lease, file, replayRoot, chunksDir, sessionsDir } = await fixture();
    const initial = await store.readManifest(id);
    const logical = tailKind === 'saved-incomplete' ? { ...initial, replay: { ...initial.replay, incomplete: true } } : initial;
    const prefix = await bytesFor(sessionsDir, id);
    await lease.release();
    const tail = tailKind === 'torn' ? Buffer.from(`{"v":1,"seq":${logical.replay.seq + 1},"record":`) :
      Buffer.from(` {"seq":${logical.replay.seq + 1},"v":1,"record":{"type":"opaque_tail","text":"accepted without a final LF"}}`);
    const original = Buffer.concat([prefix, tail]);
    const originalManifest = Buffer.from(` ${JSON.stringify(logical)}\n`);
    await fs.writeFile(file, originalManifest, { mode: 0o600 });
    await fs.writeFile(join(sessionsDir, `${id}.records.jsonl`), original, { mode: 0o600 });
    await fs.unlink(replayRoot); await fs.rm(chunksDir, { recursive: true });
    await store.migrate(id);
    const converted = tailKind === 'torn' ? prefix : Buffer.concat([original, Buffer.from('\n')]);
    expect((await bytesFor(sessionsDir, id)).equals(converted)).toBe(true);
    expect((await store.readManifest(id)).replay).toEqual(logical.replay);
    const backup = join(root, 'local', 'migrations', id, 'bounded');
    expect((await fs.readFile(join(backup, 'replay'))).equals(original)).toBe(true);
    expect((await fs.readFile(join(backup, 'manifest'))).equals(originalManifest)).toBe(true);
    const history = await store.readHistory(id);
    expect(history.pendingTail).toBe(false);
    expect(history.incomplete).toBe(false);
    if (tailKind === 'saved-incomplete') {
      expect((await store.validate(id)).resumable).toBe(false);
      expect((await store.validate(id)).reasons).toContain('session replay is incomplete');
    } else {
      const next = await store.acquire(id);
      await next.append({ type: 'after_migration', timestamp: 2 });
      await next.release();
      expect((await store.readHistory(id)).lastReadableSeq).toBe(history.lastReadableSeq + 1);
      expect((await store.validate(id)).resumable).toBe(true);
    }
  });

  it('keeps the preceding recovery checkpoint when its next physical root cannot be published', async () => {
    let failedRoot = '';
    const fsOps = { async rename(source: string, target: string) {
      if (target === failedRoot) throw new Error('injected checkpoint root publication failure');
      return fs.rename(source, target);
    } };
    const { store, id, lease, file } = await fixture(fsOps);
    const previousRoot = await fs.readFile(file);
    const previous = await store.read(id);
    await lease.append({ type: 'opaque_history', timestamp: 1, text: 'readable tail survives a failed checkpoint' });
    failedRoot = file;
    await expect(lease.beginTurn({ input: 'next', attemptId: randomUUID(), attemptedExecutionProjection: executionProjection() })).rejects.toThrow('injected checkpoint root publication failure');
    expect((await fs.readFile(file)).equals(previousRoot)).toBe(true);
    expect(await store.read(id)).toEqual(previous);
    expect((await store.validate(id)).integrityValid).toBe(true);
    failedRoot = '';
    await lease.release();
  });

  it('retries export when explicit migration retires its pinned legacy replay', async () => {
    const { store, id, lease, file, replayRoot, chunksDir, sessionsDir } = await fixture();
    const logical = await store.readManifest(id);
    const replay = await bytesFor(sessionsDir, id);
    await lease.release();
    const legacyReplay = join(sessionsDir, `${id}.records.jsonl`);
    await fs.writeFile(file, JSON.stringify(logical), { mode: 0o600 });
    await fs.writeFile(legacyReplay, replay, { mode: 0o600 });
    await fs.unlink(replayRoot);
    await fs.rm(chunksDir, { recursive: true });
    let migrated = false;
    const exporter = createSessionStore({ sessionsDir, hostname: 'bounded-storage-integration', fsOps: {
      async lstat(path: string, options?: any) {
        if (path === legacyReplay && !migrated) {
          migrated = true;
          await store.migrate(id);
        }
        return fs.lstat(path, options);
      },
    } });
    const bundle = await exporter.exportBundle(id);
    expect(migrated).toBe(true);
    expect(JSON.parse(bundle.manifest.toString()).schemaVersion).toBe(8);
    expect(bundle.manifest.equals(await fs.readFile(file))).toBe(true);
    expect(bundle.replay.equals(replay)).toBe(true);
    expect(bundle.files.some((entry: any) => entry.path === `${id}.records.jsonl`)).toBe(false);
  });

  it('retries export when its opened manifest is atomically superseded by an owning checkpoint', async () => {
    let rootPath = '';
    let advance: null | (() => Promise<void>) = null;
    const fsOps = { async open(path: string, flags: string | number, mode?: number) {
      const handle = await fs.open(path, flags, mode);
      if (path !== rootPath) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'readFile') return async (...args: any[]) => {
          const bytes = await (target.readFile as any)(...args);
          const action = advance; advance = null;
          await action?.();
          return bytes;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    const { store, id, lease, file } = await fixture(fsOps);
    rootPath = file;
    advance = async () => {
      const attemptId = randomUUID();
      await lease.beginTurn({ input: 'next', attemptId, attemptedExecutionProjection: executionProjection() });
      await lease.settle({ attemptId, snapshot: shellSnapshot(1), unresolvedEffects: [] });
    };
    const exporting = store.exportBundle(id);
    await expect(exporting).resolves.toHaveProperty('sessionId', id);
    const bundle = await exporting;
    expect(bundle.manifest.equals(await fs.readFile(file))).toBe(true);
    expect((await store.read(id)).snapshot.journal).toEqual(shellSnapshot(1).journal);
    await lease.release();
  });

  it('finishes a same-directory schema6 migration after interruption between bounded publication and legacy retirement', async () => {
    let interruptedPath = '';
    const fsOps = { async unlink(path: string) {
      if (path === interruptedPath) { interruptedPath = ''; throw new Error('injected legacy retirement interruption'); }
      return fs.unlink(path);
    } };
    const { root, store, id, lease, file, replayRoot, chunksDir, sessionsDir } = await fixture(fsOps);
    const recovery = await store.read(id);
    const replay = await bytesFor(sessionsDir, id);
    await lease.release();
    const legacyManifest = Buffer.from(`${JSON.stringify(recovery)}\n`);
    await fs.writeFile(file, legacyManifest, { mode: 0o600 });
    const legacyReplay = join(sessionsDir, `${id}.records.jsonl`);
    await fs.writeFile(legacyReplay, replay, { mode: 0o600 });
    await fs.unlink(replayRoot); await fs.rm(chunksDir, { recursive: true });
    interruptedPath = legacyReplay;
    await expect(store.migrate(id)).rejects.toThrow('injected legacy retirement interruption');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).schemaVersion).toBe(8);
    expect((await store.validate(id)).integrityValid).toBe(true);
    const retained = join(root, 'local', 'migrations', id);
    expect((await fs.readFile(join(retained, 'inputs', '0'))).equals(legacyManifest)).toBe(true);
    expect((await fs.readFile(join(retained, 'inputs', '1'))).equals(replay)).toBe(true);
    await store.migrate(id);
    await expect(fs.stat(legacyReplay)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(join(retained, 'receipt.json'), 'utf8')).complete).toBe(true);
    expect(await store.read(id)).toEqual(recovery);
  });

  it.each(['root', 'retained-manifest', 'legacy-replay'])('requires the original publication and retained source before completing interrupted schema7 migration: %s', async (changed) => {
    let interruptedPath = '';
    const fsOps = { async unlink(path: string) {
      if (path === interruptedPath) { interruptedPath = ''; throw new Error('injected schema7 retirement interruption'); }
      return fs.unlink(path);
    } };
    const { root, store, id, lease, file, replayRoot, chunksDir, sessionsDir } = await fixture(fsOps);
    const logical = await store.readManifest(id);
    const replay = await bytesFor(sessionsDir, id);
    await lease.release();
    await fs.writeFile(file, JSON.stringify(logical), { mode: 0o600 });
    const legacyReplay = join(sessionsDir, `${id}.records.jsonl`);
    await fs.writeFile(legacyReplay, replay, { mode: 0o600 });
    await fs.unlink(replayRoot); await fs.rm(chunksDir, { recursive: true });
    interruptedPath = legacyReplay;
    await expect(store.migrate(id)).rejects.toThrow('injected schema7 retirement interruption');
    const backup = join(root, 'local', 'migrations', id, 'bounded');
    const modified = changed === 'root' ? file : changed === 'retained-manifest' ? join(backup, 'manifest') : legacyReplay;
    const original = await fs.readFile(modified);
    await fs.writeFile(modified, Buffer.concat([Buffer.from(' '), original]));
    await expect(store.migrate(id)).rejects.toThrow(/receipt differs|legacy replay changed/);
    expect((await fs.stat(legacyReplay)).isFile()).toBe(true);
    expect(JSON.parse(await fs.readFile(join(backup, 'receipt.json'), 'utf8')).complete).toBe(false);
    await fs.writeFile(modified, original);
    await store.migrate(id);
    await expect(fs.stat(legacyReplay)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(join(backup, 'receipt.json'), 'utf8')).complete).toBe(true);
    expect(await store.readManifest(id)).toEqual(logical);
  });

  it.each(['none', 'retained-input', 'published-root'])('finishes a source-retired sidecar migration only with its unchanged retained proof: %s', async (changed) => {
    let receiptPath = '';
    let receiptWrites = 0;
    const fsOps = { async rename(source: string, target: string) {
      if (target === receiptPath && ++receiptWrites === 3) throw new Error('injected final sidecar receipt interruption');
      return fs.rename(source, target);
    } };
    const { root, store, id, lease, file, replayRoot, chunksDir, sessionsDir } = await fixture(fsOps);
    await lease.release();
    await fs.unlink(file); await fs.unlink(replayRoot); await fs.rm(chunksDir, { recursive: true });
    const sourcePath = join(sessionsDir, `${id}.spex.json`);
    const sidecar = Buffer.from(JSON.stringify({ v: 1, session: { id, createdAt: Date.parse('2026-08-11T21:00:00.000Z'), snapshot: { shell: { journal: [] } } } }));
    await fs.writeFile(sourcePath, sidecar, { mode: 0o600 });
    const retained = join(root, 'local', 'migrations', id);
    receiptPath = join(retained, 'receipt.json');
    const migration = { sourcePath, cwd: process.cwd() };
    await expect(store.migrate(id, migration)).rejects.toThrow('injected final sidecar receipt interruption');
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(receiptPath, 'utf8')).complete).toBe(false);
    if (changed !== 'none') {
      const path = changed === 'retained-input' ? join(retained, 'inputs', '0') : file;
      const original = await fs.readFile(path);
      await fs.writeFile(path, Buffer.concat([Buffer.from(' '), original]));
      await expect(store.migrate(id, migration)).rejects.toThrow(/input differs|root differs/);
      expect(JSON.parse(await fs.readFile(receiptPath, 'utf8')).complete).toBe(false);
      await fs.writeFile(path, original);
    }
    await store.migrate(id, migration);
    expect(JSON.parse(await fs.readFile(receiptPath, 'utf8')).complete).toBe(true);
    expect((await fs.readFile(join(retained, 'inputs', '0'))).equals(sidecar)).toBe(true);
    expect((await store.validate(id)).integrityValid).toBe(true);
  });

  it.each(['missing', 'corrupt'])('refuses %s referenced recovery content without changing its root', async (damage) => {
    const { store, id, lease, file, chunksDir, sessionsDir } = await fixture();
    await lease.release();
    const before = await fs.readFile(file);
    const physical = JSON.parse(before.toString());
    const path = join(chunksDir, physical.root.sha256);
    if (damage === 'missing') await fs.unlink(path);
    else {
      const bytes = await fs.readFile(path); bytes[bytes.length - 1] ^= 1;
      await fs.writeFile(path, bytes);
    }
    const reopened = createSessionStore({ sessionsDir, hostname: 'bounded-storage-integration' });
    await expect(reopened.read(id)).rejects.toThrow();
    await expect(reopened.exportBundle(id)).rejects.toThrow();
    expect((await fs.readFile(file)).equals(before)).toBe(true);
    // Validation may report a refusal or reject before a logical schema exists.
    const valid = await store.validate(id).then((result: any) => result.integrityValid, () => false);
    expect(valid).toBe(false);
  });

  it('deletes the complete owned bounded representation while preserving another session', async () => {
    const { store, id, lease, sessionsDir } = await fixture();
    await lease.release();
    const other = randomUUID();
    const otherLease = await store.acquire(other);
    await otherLease.initializeSettledWithPredecessor(freshBoundary() as any);
    await otherLease.release();
    const survivor = await store.exportBundle(other);
    await store.delete(id);
    for (const suffix of ['.json', '.replay.json', '.chunks', '.hints.json', '.records.jsonl']) await expect(fs.lstat(join(sessionsDir, `${id}${suffix}`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.validate(other)).integrityValid).toBe(true);
    for (const entry of survivor.files) expect((await fs.stat(join(sessionsDir, entry.path))).size).toBe(entry.byteLength);
  });
});
