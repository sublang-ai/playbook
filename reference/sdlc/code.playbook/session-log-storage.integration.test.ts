// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-111: a session is one manifest file and a segmented replay log, written
// and read through the real shared lifecycle and store.
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionStore } from './session-store.js';
import { executionProjection, freshBoundary, shellSnapshot } from './test-support/session-boundary.js';
import { MAX_SESSION_FILE_BYTES, SEGMENT_SEAL_BYTES } from './bin/session-files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(fsOps?: object) {
  const root = await fs.mkdtemp(join(tmpdir(), 'session-log-store-')); roots.push(root);
  const sessionsDir = join(root, 'sessions');
  const store = createSessionStore({ sessionsDir, hostname: 'session-log-integration', fsOps });
  const id = randomUUID();
  const lease = await store.acquire(id);
  await lease.initializeSettledWithPredecessor(freshBoundary() as any);
  return { root, sessionsDir, store, id, lease, file: join(sessionsDir, `${id}.json`), replayDir: join(sessionsDir, `${id}.replay`), blobsDir: join(sessionsDir, `${id}.blobs`) };
}
async function settleTurn(lease: any, turn: number, payload = 'next') {
  const attemptId = randomUUID();
  await lease.beginTurn({ input: payload, attemptId, attemptedExecutionProjection: executionProjection() });
  await lease.settle({ attemptId, snapshot: shellSnapshot(turn, payload), unresolvedEffects: [] });
}
async function physical(file: string) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function segmentNames(replayDir: string) { return (await fs.readdir(replayDir)).filter((name) => name.endsWith('.jsonl')).sort(); }
async function logBytes(replayDir: string) {
  return Buffer.concat(await Promise.all((await segmentNames(replayDir)).map((name) => fs.readFile(join(replayDir, name)))));
}
// Every file the session owns, with its size, mode and the bound.
async function assertBoundedPrivateFiles(sessionsDir: string, id: string) {
  const files = [`${id}.json`];
  for (const directory of [`${id}.replay`, `${id}.blobs`]) {
    try { for (const name of await fs.readdir(join(sessionsDir, directory))) files.push(`${directory}/${name}`); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const file of files) {
    const stat = await fs.stat(join(sessionsDir, file));
    expect(stat.size).toBeLessThanOrEqual(MAX_SESSION_FILE_BYTES);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
  }
  return files;
}
// Counts filesystem calls by path through the store's injected operations.
function recordingFs() {
  const calls: Array<{ op: string; path: string }> = [];
  const fsOps: Record<string, unknown> = {};
  for (const op of ['open', 'lstat', 'readdir', 'rename', 'link', 'unlink', 'mkdir', 'rmdir', 'chmod']) {
    fsOps[op] = async (path: any, ...rest: unknown[]) => {
      calls.push({ op, path: String(path) });
      return (fs as any)[op](path, ...rest);
    };
  }
  return { calls, fsOps };
}

describe('schema-9 session layout (DR-111)', () => {
  it('writes one manifest file and an append-only segment log that bind each other', async () => {
    const { store, id, lease, file, replayDir, sessionsDir } = await fixture();
    const stored = await physical(file);
    expect(Object.keys(stored)).toEqual(['schemaVersion', 'kind', 'sessionId', 'manifest', 'log']);
    expect(stored).toMatchObject({ schemaVersion: 9, kind: 'captain-session-storage', sessionId: id });
    expect(stored.manifest).toEqual(await store.readManifest(id));
    expect(await segmentNames(replayDir)).toEqual(['000000000001.jsonl']);
    expect(stored.log).toEqual({ sealed: [], open: { name: '000000000001.jsonl', byteLength: (await logBytes(replayDir)).length, sha256: digest(await logBytes(replayDir)) } });
    for (const name of ['.chunks', '.replay.json', '.records.jsonl']) await expect(fs.lstat(join(sessionsDir, `${id}${name}`))).rejects.toMatchObject({ code: 'ENOENT' });
    await lease.append({ type: 'opaque_history', timestamp: 1, text: 'readable tail' });
    // An append is durable at once; the manifest still binds its checkpoint.
    expect((await store.readStream(id)).entries.at(-1).record.text).toBe('readable tail');
    expect((await physical(file)).log).toEqual(stored.log);
    await settleTurn(lease, 1);
    const settled = await physical(file);
    const bytes = await logBytes(replayDir);
    expect(settled.log).toEqual({ sealed: [{ name: '000000000001.jsonl', byteLength: bytes.length, sha256: digest(bytes) }], open: null });
    expect(settled.manifest.replay).toEqual({ seq: bytes.toString().split('\n').length - 1, sha256: digest(bytes), incomplete: false });
    // Settlement sealed the segment; later appends start the next one.
    await lease.append({ type: 'opaque_history', timestamp: 2, text: 'after settlement' });
    expect(await segmentNames(replayDir)).toEqual(['000000000001.jsonl', `${String(settled.manifest.replay.seq + 1).padStart(12, '0')}.jsonl`]);
    expect((await fs.readFile(join(replayDir, '000000000001.jsonl'))).equals(bytes)).toBe(true);
    await lease.release();
    const validation = await store.validate(id);
    expect(validation).toMatchObject({ integrityValid: true, resumable: true, reasons: [] });
    await assertBoundedPrivateFiles(sessionsDir, id);
  });

  it('seals at the size bound and keeps every file within the per-file bound', async () => {
    const { store, id, lease, replayDir, sessionsDir } = await fixture();
    const text = 'x'.repeat(300 * 1024);
    for (let index = 0; index < 8; index++) await lease.append({ type: 'opaque_history', timestamp: index, text });
    await lease.release();
    const names = await segmentNames(replayDir);
    expect(names.length).toBeGreaterThan(1);
    for (const name of names.slice(0, -1)) expect((await fs.stat(join(replayDir, name))).size).toBeGreaterThanOrEqual(SEGMENT_SEAL_BYTES);
    expect((await store.readHistory(id)).entries.filter(({ record }: any) => record.text === text)).toHaveLength(8);
    expect((await store.validate(id)).integrityValid).toBe(true);
    await assertBoundedPrivateFiles(sessionsDir, id);
  });

  it('stores an envelope over the per-file bound as blob parts and replays its exact bytes', async () => {
    const { root, store, id, lease, file, replayDir, blobsDir, sessionsDir } = await fixture();
    const text = '🦉'.repeat(2 * 1024 * 1024 + 100);
    await lease.append({ type: 'opaque_history', timestamp: 1, text });
    await settleTurn(lease, 1);
    await lease.append({ type: 'opaque_tail', timestamp: 2 });
    await lease.release();
    const parts = await fs.readdir(blobsDir);
    expect(parts.length).toBe(2);
    const reference = (await logBytes(replayDir)).toString().split('\n').find((line) => line.startsWith('{"parts":'))!;
    expect(JSON.parse(reference).parts.map((part: any) => part.sha256).sort()).toEqual([...parts].sort());
    const history = await store.readHistory(id);
    expect(history.entries.find(({ record }: any) => record.type === 'opaque_history').record.text === text).toBe(true);
    const manifest = await store.readManifest(id);
    const bundle = await store.exportBundle(id);
    expect(bundle.replay.length).toBeGreaterThan(MAX_SESSION_FILE_BYTES);
    expect(digest(bundle.replay)).toBe(manifest.replay.sha256);
    expect(bundle.manifest.equals(await fs.readFile(file))).toBe(true);
    const paths = bundle.files.map(({ path }: any) => path).sort();
    expect(paths).toEqual([`${id}.json`, ...parts.map((name) => `${id}.blobs/${name}`), ...(await segmentNames(replayDir)).map((name) => `${id}.replay/${name}`)].sort());
    // The inventory is the complete portable bundle.
    const copyDir = join(root, 'portable-copy');
    for (const entry of bundle.files) {
      const target = join(copyDir, entry.path);
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(join(sessionsDir, entry.path), target);
      await fs.chmod(target, 0o600);
      expect((await fs.stat(target)).size).toBe(entry.byteLength);
    }
    await fs.chmod(copyDir, 0o700);
    const copied = createSessionStore({ sessionsDir: copyDir, hostname: 'session-log-integration' });
    expect(await copied.read(id)).toEqual(await store.read(id));
    expect((await copied.validate(id)).integrityValid).toBe(true);
    await assertBoundedPrivateFiles(sessionsDir, id);
  }, 30_000);

  it('spills manifest values over the per-file bound into blobs and removes them once unreferenced', async () => {
    const payload = 'repeated observation '.repeat(110_000);
    const { store, id, lease, file, blobsDir, sessionsDir } = await fixture();
    for (let turn = 1; turn <= 4; turn++) {
      const attemptId = randomUUID();
      await lease.beginTurn({ input: 'next', attemptId, attemptedExecutionProjection: executionProjection() });
      await lease.settle({ attemptId, snapshot: shellSnapshot(turn, payload), unresolvedEffects: [] });
    }
    const expected = await lease.read();
    const stored = await physical(file);
    expect(stored.spills.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(await store.readManifest(id)))).toBeGreaterThan(MAX_SESSION_FILE_BYTES);
    const reopened = createSessionStore({ sessionsDir, hostname: 'session-log-integration' });
    expect(await reopened.read(id)).toEqual(expected);
    expect((await reopened.validate(id)).integrityValid).toBe(true);
    const spilled = new Set(stored.spills.flatMap(({ parts }: any) => parts.map(({ sha256 }: any) => sha256)));
    expect(new Set(await fs.readdir(blobsDir))).toEqual(spilled);
    // A smaller settled snapshot drops the spills; settlement removes their parts.
    await settleTurn(lease, 5, 'small');
    expect((await physical(file)).spills).toBeUndefined();
    expect(await fs.readdir(blobsDir)).toEqual([]);
    await lease.release();
    expect((await store.validate(id)).integrityValid).toBe(true);
    await assertBoundedPrivateFiles(sessionsDir, id);
  }, 60_000);

  it('deletes the owned representation, hints and assets while preserving another session', async () => {
    const { store, id, lease, sessionsDir } = await fixture();
    await lease.importAsset({ bytes: Buffer.from('asset'), mimeType: 'text/plain' });
    lease.acknowledgeHint('captain', 'captain-token');
    await settleTurn(lease, 1);
    await lease.release();
    expect((await fs.readdir(sessionsDir)).filter((name) => name.startsWith(id)).sort()).toEqual([`${id}.assets`, `${id}.hints.json`, `${id}.json`, `${id}.replay`].sort());
    const other = randomUUID();
    const otherLease = await store.acquire(other);
    await otherLease.initializeSettledWithPredecessor(freshBoundary() as any);
    await otherLease.release();
    const survivor = await store.exportBundle(other);
    await store.delete(id);
    expect((await fs.readdir(sessionsDir)).filter((name) => name.startsWith(id))).toEqual([]);
    expect((await store.validate(other)).integrityValid).toBe(true);
    for (const entry of survivor.files) expect((await fs.stat(join(sessionsDir, entry.path))).size).toBe(entry.byteLength);
  });
});

describe('schema-9 publication and crash safety (DR-111)', () => {
  it('lets a concurrent reader see the previous or the new manifest whole while it is replaced', async () => {
    const { store, id, lease, sessionsDir } = await fixture();
    const reader = createSessionStore({ sessionsDir, hostname: 'session-log-reader' });
    let writing = true;
    const writes = (async () => {
      for (let turn = 1; turn <= 12; turn++) {
        await lease.append({ type: 'opaque_history', timestamp: turn, text: `turn ${turn}` });
        await settleTurn(lease, turn);
      }
      writing = false;
    })();
    let reads = 0;
    while (writing) {
      const validation = await reader.validate(id);
      expect(validation.integrityValid).toBe(true);
      expect(validation.manifest.snapshot.journal.length).toBeLessThanOrEqual(12);
      reads++;
    }
    await writes;
    await lease.release();
    expect(reads).toBeGreaterThan(0);
    expect((await store.read(id)).snapshot.journal).toHaveLength(12);
  }, 60_000);

  it('repairs an unfinished final line beyond the checkpoint at the next lease and continues the sequence', async () => {
    const { store, id, lease, replayDir } = await fixture();
    await lease.append({ type: 'opaque_history', timestamp: 1, text: 'acknowledged' });
    await lease.release();
    const names = await segmentNames(replayDir);
    const last = join(replayDir, names.at(-1)!);
    const before = await fs.readFile(last);
    const status = (await store.readStream(id)).lastReadableSeq;
    // A crash during an append leaves part of an unacknowledged line.
    await fs.appendFile(last, `{"v":1,"seq":${status + 1},"record":{"type":"torn`);
    expect((await store.readStream(id)).lastReadableSeq).toBe(status);
    const history = await store.readHistory(id);
    expect(history).toMatchObject({ lastReadableSeq: status, pendingTail: true, incomplete: false });
    const next = await store.acquire(id);
    expect(next.streamStatus()).toEqual({ lastReadableSeq: status, lastDurableSeq: status, incomplete: false });
    expect((await fs.readFile(last)).equals(before)).toBe(true);
    await next.append({ type: 'after_repair', timestamp: 2 });
    await next.release();
    const entries = (await store.readStream(id)).entries;
    expect(entries.at(-1)).toEqual({ v: 1, seq: status + 1, record: { type: 'after_repair', timestamp: 2, contextSeq: 1 } });
    expect((await store.validate(id)).integrityValid).toBe(true);
  });

  it('refuses to extend a log whose bound prefix is damaged and leaves its bytes unchanged', async () => {
    const { store, id, lease, replayDir } = await fixture();
    await settleTurn(lease, 1);
    await lease.release();
    const segment = join(replayDir, (await segmentNames(replayDir))[0]);
    const bytes = await fs.readFile(segment);
    const damaged = Buffer.from(bytes); damaged[10] ^= 1;
    await fs.writeFile(segment, damaged);
    const validation = await store.validate(id);
    expect(validation.integrityValid).toBe(false);
    const next = await store.acquire(id);
    expect(next.streamStatus()).toEqual({ lastReadableSeq: null, lastDurableSeq: null, incomplete: true });
    await next.release();
    expect((await fs.readFile(segment)).equals(damaged)).toBe(true);
  });

  it('ignores a manifest temporary left by a crash before its rename', async () => {
    const { store, id, lease, sessionsDir, file } = await fixture();
    await lease.release();
    const residue = join(sessionsDir, `.${id}.101.${randomUUID()}.tmp`);
    await fs.writeFile(residue, '{"partial":', { mode: 0o600 });
    const before = await fs.readFile(file);
    expect((await store.listSummaries()).sessions.map(({ sessionId }: any) => sessionId)).toEqual([id]);
    expect((await store.validate(id)).integrityValid).toBe(true);
    const next = await store.acquire(id);
    await settleTurn(next, 1);
    await next.release();
    expect((await fs.readFile(file)).equals(before)).toBe(false);
    expect((await store.validate(id)).integrityValid).toBe(true);
  });

  it.each(['before', 'after'])('keeps a complete manifest when publication stops %s its rename', async (when) => {
    let target = '';
    let failures = 0;
    const fsOps = {
      async rename(from: string, to: string) {
        if (to === target && when === 'before' && failures++ === 0) throw Object.assign(new Error('injected crash before rename'), { code: 'EIO' });
        return fs.rename(from, to);
      },
      async open(path: string, flags: any, mode?: number) {
        const handle = await fs.open(path, flags, mode);
        if (when !== 'after' || path !== dirname(target) || target === '' || failures !== 0) return handle;
        failures++;
        await handle.close();
        throw Object.assign(new Error('injected crash after rename'), { code: 'EIO' });
      },
    };
    const { store, id, lease, file } = await fixture(fsOps);
    const previous = await store.read(id);
    const previousBytes = await fs.readFile(file);
    target = file;
    await expect(settleTurn(lease, 1)).rejects.toThrow(/injected crash/);
    await lease.release().catch(() => undefined);
    const reader = createSessionStore({ sessionsDir: dirname(file), hostname: 'session-log-reader' });
    if (when === 'before') {
      expect((await fs.readFile(file)).equals(previousBytes)).toBe(true);
      expect(await reader.read(id)).toEqual(previous);
    } else {
      expect((await fs.readFile(file)).equals(previousBytes)).toBe(false);
    }
    expect((await reader.validate(id)).integrityValid).toBe(true);
  });

  it('retries a manifest replacement another process briefly holds, and otherwise keeps the previous manifest', async () => {
    let target = '';
    let busy = 0;
    const fsOps = { async rename(from: string, to: string) {
      if (to === target && busy > 0) { busy--; throw Object.assign(new Error('target is open without delete sharing'), { code: 'EPERM' }); }
      return fs.rename(from, to);
    } };
    const { store, id, lease, file } = await fixture(fsOps);
    target = file;
    busy = 2;
    await settleTurn(lease, 1);
    expect((await store.read(id)).snapshot.journal).toHaveLength(1);
    const kept = await fs.readFile(file);
    busy = 1000;
    await expect(settleTurn(lease, 2)).rejects.toThrow(/delete sharing/);
    expect((await fs.readFile(file)).equals(kept)).toBe(true);
    busy = 0;
    await lease.release();
    expect((await store.validate(id)).integrityValid).toBe(true);
    expect((await fs.readdir(dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('schema-9 cost independent of session length (DR-111)', () => {
  async function longSession(records: number) {
    const { store, id, lease, sessionsDir, replayDir } = await fixture();
    await lease.importAsset({ bytes: Buffer.from('first asset'), mimeType: 'text/plain' });
    for (let seq = 1; seq <= records; seq++) await lease.append({ type: 'player_event', timestamp: seq, text: `record ${seq} ${'y'.repeat(200)}` }, 'coder');
    for (let index = 0; index < 20; index++) await lease.importAsset({ bytes: Buffer.from(`asset ${index}`), mimeType: 'text/plain' });
    await lease.release();
    return { store, id, sessionsDir, replayDir };
  }
  async function progressWrites(records: number) {
    const { id, sessionsDir, replayDir } = await longSession(records);
    const { calls, fsOps } = recordingFs();
    const store = createSessionStore({ sessionsDir, hostname: 'session-log-integration', fsOps });
    const lease = await store.acquire(id);
    await lease.beginTurn({ input: 'long run', attemptId: randomUUID(), attemptedExecutionProjection: executionProjection() });
    const writes = [];
    for (let write = 1; write <= 3; write++) {
      await lease.append({ type: 'player_event', timestamp: write }, 'coder');
      calls.length = 0;
      await lease.recordProgress({ snapshot: null });
      writes.push([...calls]);
    }
    await lease.release();
    return { writes, replayDir, assetsDir: join(sessionsDir, `${id}.assets`) };
  }

  it('makes the same file operations per progress write at 200 and 600 records, touching no segment or asset', async () => {
    const short = await progressWrites(200);
    const long = await progressWrites(600);
    for (const run of [short, long]) {
      for (const calls of run.writes) {
        expect(calls.filter(({ path }) => path.startsWith(run.replayDir) || path.startsWith(run.assetsDir))).toEqual([]);
      }
    }
    expect(long.writes.map((calls) => calls.length)).toEqual(short.writes.map((calls) => calls.length));
  }, 60_000);

  it('opens the manifest, each segment once and a constant number of other files to validate', async () => {
    const { id, sessionsDir, replayDir } = await longSession(600);
    const segments = await segmentNames(replayDir);
    const { calls, fsOps } = recordingFs();
    const store = createSessionStore({ sessionsDir, hostname: 'session-log-integration', fsOps });
    expect((await store.validate(id)).integrityValid).toBe(true);
    const opens = calls.filter(({ op }) => op === 'open');
    for (const name of segments) expect(opens.filter(({ path }) => path === join(replayDir, name))).toHaveLength(1);
    const assetOpens = opens.filter(({ path }) => path.includes(`${id}.assets`)).length;
    expect(opens.length - assetOpens).toBe(segments.length + 1);
  }, 60_000);

  it('continues a follower from its verified position and reads only the bytes after it', async () => {
    const { id, sessionsDir, replayDir } = await longSession(300);
    const { calls, fsOps } = recordingFs();
    const follower = createSessionStore({ sessionsDir, hostname: 'session-log-follower', fsOps });
    const first = await follower.readStream(id);
    const writerStore = createSessionStore({ sessionsDir, hostname: 'session-log-integration' });
    for (let round = 1; round <= 3; round++) {
      const writer = await writerStore.acquire(id);
      await writer.append({ type: 'later', timestamp: round });
      await writer.release();
      calls.length = 0;
      const next = await follower.readStream(id, { afterSeq: first.lastReadableSeq + round - 1 });
      expect(next.entries.map(({ record }: any) => record.type)).toEqual(['later']);
      const segments = await segmentNames(replayDir);
      // Only the last segment is opened again: earlier ones are verified.
      expect(calls.filter(({ op, path }) => op === 'open' && path.startsWith(replayDir)).map(({ path }) => path)).toEqual([join(replayDir, segments.at(-1)!)]);
    }
  }, 60_000);

  it('rejects a log rolled back below a live follower position while a new store accepts the retained prefix', async () => {
    const { id, sessionsDir, replayDir } = await longSession(20);
    const follower = createSessionStore({ sessionsDir, hostname: 'session-log-follower' });
    const read = await follower.readStream(id);
    const names = await segmentNames(replayDir);
    const last = join(replayDir, names.at(-1)!);
    const bytes = await fs.readFile(last);
    const lines = bytes.toString().split('\n').filter(Boolean);
    await fs.writeFile(last, `${lines.slice(0, -1).join('\n')}\n`);
    await expect(follower.readStream(id, { afterSeq: read.lastReadableSeq })).rejects.toThrow(/rolled back|exceeds/);
    const fresh = createSessionStore({ sessionsDir, hostname: 'session-log-follower' });
    expect((await fresh.readStream(id)).lastReadableSeq).toBe(read.lastReadableSeq - 1);
  });
});
