// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBoundedReplay } from './bin/session-replay.js';
import { createSessionChunks, MAX_SESSION_CHUNK_BYTES } from './bin/session-chunks.js';

const sessionId = '90000000-0000-4000-8000-000000000031';
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
async function fixture(fsOps?: object) {
  const sessionsDir = await fs.mkdtemp(join(tmpdir(), 'session-replay-'));
  temporary.push(sessionsDir);
  await fs.chmod(sessionsDir, 0o700);
  const chunksDir = join(sessionsDir, `${sessionId}.chunks`);
  const rootPath = join(sessionsDir, `${sessionId}.replay.json`);
  const chunks = createSessionChunks({ directory: chunksDir, fsOps });
  const replay = await createBoundedReplay({ sessionId, sessionsDir, fsOps, chunks });
  return { sessionsDir, chunksDir, rootPath, chunks, replay };
}
const line = (seq: number, text: string) => Buffer.from(`${JSON.stringify({ v: 1, seq, record: { text } })}\n`);

describe('bounded replay on the real filesystem', () => {
  it('stores a single huge UTF-8 envelope and reopens its exact bytes with bounded physical files', async () => {
    const { replay, sessionsDir, chunksDir, rootPath } = await fixture();
    const bytes = line(1, '🦉'.repeat(3 * 1024 * 1024));
    await replay.appendBytes(bytes);
    expect((await fs.stat(rootPath)).size).toBeLessThan(1024);
    const names = await fs.readdir(chunksDir);
    expect(names.length).toBeGreaterThan(2);
    for (const name of names) expect((await fs.stat(join(chunksDir, name))).size).toBeLessThanOrEqual(MAX_SESSION_CHUNK_BYTES);
    const reopened = await createBoundedReplay({ sessionId, sessionsDir });
    expect((await reopened.readBytes()).equals(bytes)).toBe(true);
    expect(await reopened.checkpoint()).toEqual({ byteLength: bytes.length });
    for (const file of await reopened.collectFiles()) expect((await fs.stat(join(sessionsDir, file.path))).size).toBe(file.byteLength);
  }, 30_000);

  it('syncs append dependencies together and preserves the published replay if that sync fails', async () => {
    let chunkDirectorySyncs = 0;
    let chunkFileSyncs = 0;
    let failDirectorySync = false;
    const fsOps = { async open(path: string, ...args: any[]) {
      const handle = await (fs.open as any)(path, ...args);
      return new Proxy(handle, { get(target, key) {
        if (key === 'sync') return async () => {
          if (path.endsWith('.chunks')) {
            chunkDirectorySyncs++;
            if (failDirectorySync) throw new Error('injected dependency directory sync failure');
          } else if (path.includes('.chunks/.write-')) chunkFileSyncs++;
          await target.sync();
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    const { replay, chunks, sessionsDir } = await fixture(fsOps);
    await chunks.prepare();
    chunkDirectorySyncs = 0; chunkFileSyncs = 0;
    const first = line(1, 'first');
    await replay.appendBytes(first);
    expect(chunkFileSyncs).toBe(2);
    expect(chunkDirectorySyncs).toBe(1);
    const published = await replay.rootBytes();
    failDirectorySync = true;
    await expect(replay.appendBytes(line(2, 'second'))).rejects.toThrow('dependency directory sync');
    expect(chunkFileSyncs).toBe(4);
    expect(await replay.rootBytes()).toEqual(published);
    const reopened = await createBoundedReplay({ sessionId, sessionsDir });
    expect(await reopened.readBytes()).toEqual(first);
  });
  it('adds one immutable link without rewriting prior chunks, and serializes simultaneous appends', async () => {
    const { replay, chunksDir } = await fixture();
    const first = line(1, 'first');
    await replay.appendBytes(first);
    const original = await Promise.all((await fs.readdir(chunksDir)).map(async (name) => ({ name, stat: await fs.stat(join(chunksDir, name)), bytes: await fs.readFile(join(chunksDir, name)) })));
    await Promise.all([replay.appendBytes(line(2, 'second')), replay.appendBytes(line(3, 'third'))]);
    expect(await replay.readBytes()).toEqual(Buffer.concat([first, line(2, 'second'), line(3, 'third')]));
    for (const saved of original) {
      const stat = await fs.stat(join(chunksDir, saved.name));
      expect(stat.ino).toBe(saved.stat.ino);
      expect(stat.mtimeMs).toBe(saved.stat.mtimeMs);
      expect(await fs.readFile(join(chunksDir, saved.name))).toEqual(saved.bytes);
    }
  });

  it('checks only the verified publication root for lease-trusted checkpoints, with full checks on reopen and public reads', async () => {
    let chunkOpens = 0;
    const fsOps = { async open(path: string, flags: string | number, mode?: number) {
      if (/\.chunks\/[0-9a-f]{64}$/.test(path)) chunkOpens++;
      return fs.open(path, flags, mode);
    } };
    const { replay, sessionsDir, chunks, chunksDir } = await fixture(fsOps);
    for (let seq = 1; seq <= 20; seq++) await replay.appendBytes(line(seq, `entry ${seq}`));
    chunkOpens = 0;
    for (let check = 0; check < 5; check++) await replay.checkpoint({ trustPublished: true });
    expect(chunkOpens).toBe(0);
    const reopened = await createBoundedReplay({ sessionId, sessionsDir, fsOps });
    await reopened.checkpoint({ trustPublished: true });
    expect(chunkOpens).toBeGreaterThanOrEqual(40);
    chunkOpens = 0;
    await reopened.checkpoint({ trustPublished: true });
    expect(chunkOpens).toBe(0);
    const root = JSON.parse((await replay.rootBytes())!.toString());
    const node = await chunks.readJson(root.head);
    const path = join(chunksDir, node.content.sha256);
    const bytes = await fs.readFile(path); bytes[bytes.length - 1] ^= 1;
    await fs.writeFile(path, bytes);
    await expect(replay.readSnapshot()).rejects.toThrow();
    await expect(replay.checkpoint({ trustPublished: true })).rejects.toThrow();
    await expect(replay.collectFiles()).rejects.toThrow();
    await expect(replay.checkpoint()).rejects.toThrow();
    const damaged = await createBoundedReplay({ sessionId, sessionsDir, fsOps });
    await expect(damaged.checkpoint({ trustPublished: true })).rejects.toThrow();
  });

  it('imports exclusively and preserves the legacy source and prior root on repeated import', async () => {
    const { replay, sessionsDir } = await fixture();
    const bytes = Buffer.from(' {"v":1,"seq":1,"record":{"text":"spaces"}}\r\n');
    const legacy = join(sessionsDir, `${sessionId}.records.jsonl`);
    await fs.writeFile(legacy, bytes, { mode: 0o600 });
    expect(await replay.readSnapshot()).toEqual({ root: null, rootBytes: null, bytes: Buffer.alloc(0) });
    await replay.initializeBytes(bytes);
    const root = await replay.rootBytes();
    await expect(replay.initializeBytes(Buffer.from('replacement'))).rejects.toThrow('already exists');
    expect(await replay.rootBytes()).toEqual(root);
    expect(await replay.readBytes()).toEqual(bytes);
    expect(await fs.readFile(legacy)).toEqual(bytes);
  });

  it('preserves the published root when replacement publication fails and permits a retry', async () => {
    let fail = false;
    const fsOps = { async rename(source: string, target: string) {
      if (fail && target.endsWith('.replay.json')) throw new Error('injected root rename failure');
      return fs.rename(source, target);
    } };
    const { replay } = await fixture(fsOps);
    await replay.appendBytes(line(1, 'published'));
    const prior = await replay.rootBytes();
    fail = true;
    await expect(replay.appendBytes(line(2, 'next'))).rejects.toThrow('injected root rename failure');
    expect(await replay.rootBytes()).toEqual(prior);
    expect(await replay.readBytes()).toEqual(line(1, 'published'));
    fail = false;
    await replay.appendBytes(line(2, 'next'));
    expect(await replay.readBytes()).toEqual(Buffer.concat([line(1, 'published'), line(2, 'next')]));
  });

  it('preserves the old root on a failed root fsync after immutable dependencies are written', async () => {
    let fail = false;
    const fsOps = { async open(path: string, flags: string | number, mode?: number) {
      const handle = await fs.open(path, flags, mode);
      if (!path.includes('.replay-') || !fail) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'sync') return async () => { throw new Error('injected root fsync failure'); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    const { replay, sessionsDir } = await fixture(fsOps);
    await replay.appendBytes(line(1, 'published'));
    const prior = await replay.rootBytes();
    fail = true;
    await expect(replay.appendBytes(line(2, 'next'))).rejects.toThrow('injected root fsync failure');
    expect(await replay.rootBytes()).toEqual(prior);
    expect(await replay.readBytes()).toEqual(line(1, 'published'));
    expect((await fs.readdir(sessionsDir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('reads one complete pinned chain when a concurrent append replaces its root', async () => {
    const { replay, sessionsDir, chunks } = await fixture();
    await replay.appendBytes(line(1, 'first'));
    let advanced = false;
    const reading = await createBoundedReplay({ sessionId, sessionsDir, chunks: {
      ...chunks,
      async readJson(ref: unknown) {
        if (!advanced) { advanced = true; await replay.appendBytes(line(2, 'second')); }
        return chunks.readJson(ref);
      },
    } });
    const snapshot = await reading.readSnapshot();
    expect(snapshot.bytes).toEqual(line(1, 'first'));
    expect(snapshot.root.byteLength).toBe(line(1, 'first').length);
    expect(await reading.readBytes()).toEqual(Buffer.concat([line(1, 'first'), line(2, 'second')]));
  });

  it('retries an old root unlinked by an append while its verified handle is being read', async () => {
    const { replay, sessionsDir, rootPath } = await fixture();
    await replay.appendBytes(line(1, 'first'));
    let advanced = false;
    const reading = await createBoundedReplay({ sessionId, sessionsDir, fsOps: {
      async open(path: string, flags: string | number, mode?: number) {
        const handle = await fs.open(path, flags, mode);
        if (path !== rootPath) return handle;
        return new Proxy(handle, { get(target, key) {
          if (key === 'read') return async (...args: any[]) => {
            const result = await (target.read as any)(...args);
            if (!advanced) { advanced = true; await replay.appendBytes(line(2, 'second')); }
            return result;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    } });
    expect(await reading.readBytes()).toEqual(Buffer.concat([line(1, 'first'), line(2, 'second')]));
  });

  it.each(['missing', 'corrupt'])('refuses a %s immutable replay chunk', async (damage) => {
    const { replay, chunks, chunksDir } = await fixture();
    await replay.appendBytes(line(1, 'readable'));
    const snapshot = await replay.readSnapshot();
    const head = await chunks.readJson(snapshot.root.head);
    const chunk = join(chunksDir, head.content.sha256);
    if (damage === 'missing') await fs.unlink(chunk);
    else {
      const bytes = await fs.readFile(chunk);
      bytes[bytes.length - 1] ^= 1;
      await fs.writeFile(chunk, bytes);
    }
    await expect(replay.readBytes()).rejects.toThrow();
    await expect(replay.checkpoint()).rejects.toThrow();
    await expect(replay.collectFiles()).rejects.toThrow();
  });

  it('rejects inconsistent linked lengths and closed root or node extensions', async () => {
    const { replay, chunks, rootPath } = await fixture();
    await replay.appendBytes(line(1, 'readable'));
    const snapshot = await replay.readSnapshot();
    const node = await chunks.readJson(snapshot.root.head);
    const invalidHead = await chunks.writeJson({ ...node, totalBytes: node.totalBytes + 1 });
    await fs.writeFile(rootPath, JSON.stringify({ ...snapshot.root, head: invalidHead }));
    await expect(replay.readBytes()).rejects.toThrow();
    const extended = await chunks.writeJson({ ...node, extra: true });
    await fs.writeFile(rootPath, JSON.stringify({ ...snapshot.root, head: extended }));
    await expect(replay.readBytes()).rejects.toThrow();
    await fs.writeFile(rootPath, JSON.stringify({ ...snapshot.root, extra: true }));
    await expect(replay.readBytes()).rejects.toThrow();
  });

  it.each([2, 3])('checks writer ownership before publication and detects a root replaced during owner check %s', async (replacementCheck) => {
    const { sessionsDir, replay: original, rootPath } = await fixture();
    await original.appendBytes(line(1, 'first'));
    const prior = await original.rootBytes();
    let checks = 0;
    const replay = await createBoundedReplay({ sessionId, sessionsDir, assertOwner: async () => {
      if (++checks === replacementCheck) {
        const stage = join(sessionsDir, 'replacement');
        await fs.writeFile(stage, prior!, { mode: 0o600 });
        await fs.rename(stage, rootPath);
      }
    } });
    await expect(replay.appendBytes(line(2, 'next'))).rejects.toThrow('root changed');
    expect(await original.readBytes()).toEqual(line(1, 'first'));
    const lost = await createBoundedReplay({ sessionId, sessionsDir, assertOwner: async () => { throw new Error('lease lost'); } });
    await expect(lost.appendBytes(line(2, 'next'))).rejects.toThrow('lease lost');
    expect(await original.rootBytes()).toEqual(prior);
  });

  it('refuses to extend or checkpoint a foreign replacement even when its valid root bytes are identical', async () => {
    const { replay, rootPath, sessionsDir } = await fixture();
    await replay.appendBytes(line(1, 'owned chain'));
    const before = await replay.rootBytes();
    const replacement = join(sessionsDir, 'replacement');
    await fs.writeFile(replacement, before!, { mode: 0o600 });
    await fs.rename(replacement, rootPath);
    expect(await replay.readBytes()).toEqual(line(1, 'owned chain'));
    await expect(replay.appendBytes(line(2, 'stale writer'))).rejects.toThrow('changed outside its writer');
    await expect(replay.checkpoint({ trustPublished: true })).rejects.toThrow('changed outside its writer');
    expect(await fs.readFile(rootPath)).toEqual(before);
    const successor = await createBoundedReplay({ sessionId, sessionsDir });
    await successor.appendBytes(line(2, 'new writer'));
    expect(await successor.readBytes()).toEqual(Buffer.concat([line(1, 'owned chain'), line(2, 'new writer')]));
  });

  it('tightens eligible root permissions, refuses links and owner access loss, and leaves deleted chunks untouched', async () => {
    const { replay, rootPath, sessionsDir, chunksDir } = await fixture();
    await replay.appendBytes(line(1, 'private'));
    await fs.chmod(rootPath, 0o644);
    await expect(replay.readBytes()).rejects.toThrow('private');
    await replay.prepare();
    expect((await fs.stat(rootPath)).mode & 0o777).toBe(0o600);
    await fs.chmod(rootPath, 0o400);
    await expect(replay.prepare()).rejects.toThrow('owner access');
    await fs.chmod(rootPath, 0o600);
    const linked = join(sessionsDir, 'linked');
    await fs.link(rootPath, linked);
    await expect(replay.readBytes()).rejects.toThrow('links');
    await fs.unlink(linked);
    const saved = await fs.readFile(rootPath);
    await fs.unlink(rootPath);
    await fs.writeFile(linked, saved, { mode: 0o600 });
    await fs.symlink(linked, rootPath);
    await expect(replay.readBytes()).rejects.toThrow('links');
    await fs.unlink(rootPath);
    await fs.rename(linked, rootPath);
    const names = await fs.readdir(chunksDir);
    await replay.deleteRoot();
    expect(await replay.rootBytes()).toBeNull();
    expect(await fs.readdir(chunksDir)).toEqual(names);
  });
});
