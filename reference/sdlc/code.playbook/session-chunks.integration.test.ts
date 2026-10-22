// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createSessionChunks, MAX_SESSION_CHUNK_BYTES } from './bin/session-chunks.js';
const roots: string[] = [];
async function fixture(fsOps?: any) {
  const root = await fs.mkdtemp(join(tmpdir(), 'session-chunks-'));
  await fs.chmod(root, 0o700); roots.push(root);
  const directory = join(root, 'owner.chunks');
  return { directory, store: createSessionChunks({ directory, fsOps }) };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('bounded immutable session chunks on real disk', () => {
  it('round trips large strings, keys, arrays, byte streams and unambiguous user shapes within the file bound', async () => {
    const { directory, store } = await fixture();
    const large = '😀\\\"\ud800'.repeat(600_000);
    const value = { ['key'.repeat(3_000_000)]: large, array: Array.from({ length: 20000 }, (_, n) => ({ n, ref: ['r', { sha256: 'a'.repeat(64), byteLength: 3 }] })), ['__proto__']: 'safe' };
    // Real storage roundtrip verifies the bounded representation contract,
    // including arbitrary literal user tags and oversized individual values.
    const ref = await store.writeJson(value);
    expect(await store.readJson(ref)).toEqual(value);
    const data = Buffer.alloc(MAX_SESSION_CHUNK_BYTES * 2 + 17, 42);
    const bytes = await store.writeBytes(data);
    expect((await store.readBytes(bytes)).equals(data)).toBe(true);
    const entries = await store.walk(ref);
    expect(entries.length).toBeGreaterThan(3);
    for (const name of await fs.readdir(directory)) {
      expect(name).toMatch(/^[0-9a-f]{64}$/);
      const stat = await fs.lstat(join(directory, name));
      expect(stat.size).toBeLessThanOrEqual(MAX_SESSION_CHUNK_BYTES);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
    }
  }, 30000);
  it('deduplicates equal ledger subtrees and bytes while retaining old roots', async () => {
    const { directory, store } = await fixture();
    const ledger = { boundaries: Array.from({ length: 1000 }, (_, n) => ({ n, projection: 'x'.repeat(100) })) };
    const one = await store.writeJson(ledger);
    const files = (await fs.readdir(directory)).length;
    expect(await store.writeJson(structuredClone(ledger))).toEqual(one);
    expect((await fs.readdir(directory)).length).toBe(files);
    const three = await store.writeJson({ effectLedger: ledger, snapshot: { effectLedger: structuredClone(ledger) }, runtime: { effectLedger: structuredClone(ledger) } });
    expect((await fs.readdir(directory)).length - files).toBeLessThan(10);
    expect(await store.readJson(one)).toEqual(ledger);
    expect((await store.readJson(three)).runtime.effectLedger).toEqual(ledger);
    const empty = await store.writeBytes(Buffer.alloc(0));
    expect(await store.readBytes(empty)).toEqual(Buffer.alloc(0));
  });
  it('rejects missing/corrupt chunks, unsafe links and malformed refs without silently replacing evidence', async () => {
    const { directory, store } = await fixture();
    const ref = await store.writeBytes(Buffer.from('original'));
    await fs.writeFile(join(directory, ref.sha256), Buffer.alloc(ref.byteLength, 1));
    await expect(store.readBytes(ref)).rejects.toThrow('digest');
    await expect(store.writeBytes(Buffer.from('original'))).rejects.toThrow('digest');
    await fs.unlink(join(directory, ref.sha256));
    await expect(store.readBytes(ref)).rejects.toThrow();
    await expect(store.readBytes({ ...ref, byteLength: MAX_SESSION_CHUNK_BYTES + 1 })).rejects.toThrow();
    const other = join(directory, 'foreign'); await fs.writeFile(other, 'x', { mode: 0o600 });
    await fs.symlink(other, join(directory, ref.sha256));
    await expect(store.writeBytes(Buffer.from('original'))).rejects.toThrow('unsafe');
    await expect(store.delete()).rejects.toThrow('unsafe');
    expect(await fs.readFile(other, 'utf8')).toBe('x');
  });
  it('preserves published roots under injected sync failure and removes session-owned chunks', async () => {
    let failSync = false;
    const { directory, store } = await fixture({ open: async (...args: any[]) => {
      const handle = await (fs.open as any)(...args);
      return new Proxy(handle, { get(target, key) {
        if (key === 'sync') return async () => { if (failSync) throw new Error('injected sync failure'); await target.sync(); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } });
    const old = await store.writeJson({ checkpoint: 'old' });
    failSync = true;
    await expect(store.writeJson({ checkpoint: 'new' })).rejects.toThrow('injected sync');
    failSync = false;
    expect(await store.readJson(old)).toEqual({ checkpoint: 'old' });
    await store.delete();
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const closed = createSessionChunks({ directory, createDirectory: false });
    await expect(closed.writeBytes(Buffer.from('x'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('recovers only a proven temporary publication hardlink after interruption', async () => {
    const { directory, store } = await fixture();
    const ref = await store.writeJson({ checkpoint: 'durable' });
    const temporary = join(directory, `.write-${ref.sha256}-00000000-0000-4000-8000-000000000000.tmp`);
    await fs.link(join(directory, ref.sha256), temporary);
    await expect(store.readJson(ref)).rejects.toThrow('unsafe');
    await store.prepare();
    expect((await fs.lstat(temporary)).nlink).toBe(2);
    await expect(store.readJson(ref)).rejects.toThrow('unsafe');
    await store.prepare({ recoverInterrupted: true });
    await expect(fs.lstat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.readJson(ref)).toEqual({ checkpoint: 'durable' });
    expect((await fs.lstat(join(directory, ref.sha256))).nlink).toBe(1);
  });
  it('preserves a live writer temporary while another host prepares the namespace', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const { directory, store } = await fixture({ open: async (path: string, ...args: any[]) => {
      const handle = await (fs.open as any)(path, ...args);
      if (!path.includes('/.write-')) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') return async (bytes: Buffer) => {
          await target.writeFile(bytes); entered(); await paused;
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } });
    const publication = store.writeJson({ checkpoint: 'concurrent' });
    try {
      await writing;
      const temporary = (await fs.readdir(directory)).find((name) => name.startsWith('.write-'))!;
      const before = await fs.lstat(join(directory, temporary));
      await createSessionChunks({ directory }).prepare();
      const after = await fs.lstat(join(directory, temporary));
      expect(after.ino).toBe(before.ino);
      expect(after.nlink).toBe(1);
    } finally { resume(); }
    const ref = await publication;
    expect(await store.readJson(ref)).toEqual({ checkpoint: 'concurrent' });
    expect(await fs.readdir(directory)).toEqual([ref.sha256]);
  });
  it('validates physical encoding tags, UTF-8 and indexes while reopening deep JSON', async () => {
    const { directory, store } = await fixture();
    const publish = async (bytes: Buffer) => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await fs.writeFile(join(directory, sha256), bytes, { mode: 0o600 });
      return { sha256, byteLength: bytes.length };
    };
    const badText = await store.writeBytes(Buffer.from([0xff]));
    const invalid = await publish(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify(badText))]));
    await expect(store.readJson(invalid)).rejects.toThrow();
    const unknown = await publish(Buffer.from([4]));
    await expect(store.walk(unknown)).rejects.toThrow('encoding');
    const leaf = await store.writeBytes(Buffer.from('x'));
    const oversizedIndex = await publish(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(Array(1025).fill(leaf)))]));
    await expect(store.readBytes(oversizedIndex)).rejects.toThrow('encoding');
    let deep: any = 'payload'.repeat(5000);
    for (let depth = 0; depth < 510; depth++) deep = { child: deep };
    expect(JSON.stringify(await store.readJson(await store.writeJson(deep)))).toBe(JSON.stringify(deep));
  });
  it('proves orphan file integrity and bounds without requiring an orphan graph to be complete', async () => {
    const { directory, store } = await fixture();
    const live = await store.writeJson({ checkpoint: 'live' });
    const orphanBytes = Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ sha256: 'f'.repeat(64), byteLength: 1 }))]);
    const orphan = createHash('sha256').update(orphanBytes).digest('hex');
    await fs.writeFile(join(directory, orphan), orphanBytes, { mode: 0o600 });
    expect((await store.validateNamespace()).some((entry: any) => entry.path === orphan)).toBe(true);
    await fs.writeFile(join(directory, orphan), Buffer.alloc(orphanBytes.length, 0), { mode: 0o600 });
    await expect(store.validateNamespace()).rejects.toThrow('digest');
    await fs.unlink(join(directory, orphan));
    const oversized = join(directory, 'e'.repeat(64));
    const handle = await fs.open(oversized, 'wx', 0o600);
    await handle.truncate(MAX_SESSION_CHUNK_BYTES + 1); await handle.close();
    await expect(store.validateNamespace()).rejects.toThrow('file bound');
    expect(await store.readJson(live)).toEqual({ checkpoint: 'live' });
  });
  it('reuses verified bytes only within one operation and hydrates independent logical mirrors', async () => {
    const reads = new Map<string, number>();
    const { directory, store } = await fixture({ open: async (path: string, ...args: any[]) => {
      if (/\/[0-9a-f]{64}$/.test(path)) reads.set(path, (reads.get(path) ?? 0) + 1);
      return (fs.open as any)(path, ...args);
    } });
    const ledger = { boundaries: Array.from({length:1000}, (_,n) => ({n, text:'observation'.repeat(20)})) };
    const ref = await store.writeJson({a:ledger,b:structuredClone(ledger)});
    reads.clear();
    const hydrated = await store.readJson(ref);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(hydrated.a).not.toBe(hydrated.b);
    hydrated.a.boundaries[0].text = 'changed locally';
    expect(hydrated.b.boundaries[0].text).toBe(ledger.boundaries[0].text);
    await fs.writeFile(join(directory,ref.sha256), Buffer.alloc(ref.byteLength,0));
    await expect(store.readJson(ref)).rejects.toThrow('digest');
  });
  it('checks fresh file identity before cross-operation reuse and fully rereads exported proofs', async () => {
    let opens = 0;
    const { directory, store } = await fixture({ open: async (path: string, ...args: any[]) => {
      if (/\/[0-9a-f]{64}$/.test(path)) opens++;
      return (fs.open as any)(path, ...args);
    } });
    const input = Buffer.from('verified immutable bytes');
    const ref = await store.writeBytes(input);
    opens = 0;
    const first = await store.readBytes(ref);
    first[0] = 0;
    expect((await store.readBytes(ref)).equals(input)).toBe(true);
    expect(opens).toBe(0);
    await store.walk(ref);
    expect(opens).toBeGreaterThan(0);
    const path = join(directory,ref.sha256);
    const replacement = join(directory,'replacement');
    await fs.writeFile(replacement,Buffer.concat([Buffer.from([0]),input]),{mode:0o600});
    await fs.rename(replacement,path);
    opens = 0;
    expect((await store.readBytes(ref)).equals(input)).toBe(true);
    expect(opens).toBe(1);
    await fs.chmod(path,0o644);
    await expect(store.readBytes(ref)).rejects.toThrow('private');
    await fs.chmod(path,0o600);
    await fs.unlink(path);
    await expect(store.readBytes(ref)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('disables cross-operation cache when injected file stats lack nanosecond proof', async () => {
    let opens = 0;
    const { store } = await fixture({
      lstat: (path: string) => fs.lstat(path),
      open: async (path: string, ...args: any[]) => {
        if (/\/[0-9a-f]{64}$/.test(path)) opens++;
        return (fs.open as any)(path,...args);
      },
    });
    const ref = await store.writeBytes(Buffer.from('uncached proof'));
    opens = 0;
    await store.readBytes(ref);await store.readBytes(ref);
    expect(opens).toBe(2);
  });
  it('stores common JSON in one physical node and bounds oversized inline JSON through a byte tree', async () => {
    const { directory, store } = await fixture();
    const small = await store.writeJson({previous:null,content:{sha256:'a'.repeat(64),byteLength:20},byteLength:19,totalBytes:19});
    expect((await fs.readFile(join(directory,small.sha256)))[0]).toBe(2);
    expect(await fs.readdir(directory)).toEqual([small.sha256]);
    const large = await store.writeJson({['large-key'.repeat(1_100_000)]:1});
    const closure = await store.walk(large);
    const tags = await Promise.all(closure.map(async (entry: any) => (await fs.readFile(join(directory,entry.path)))[0]));
    expect(tags).toContain(3);expect(tags).toContain(1);expect(tags).toContain(0);
    for (const entry of closure) expect(entry.byteLength).toBeLessThanOrEqual(MAX_SESSION_CHUNK_BYTES);
    expect(Object.keys(await store.readJson(large))[0].length).toBe('large-key'.length*1_100_000);
  });
  it('keeps the exact specified inline encoding while hydrating literals synchronously', async () => {
    const { directory, store } = await fixture();
    const value = {label:'literal',items:[null,false,5]};
    const ref = await store.writeJson(value);
    const expected = Buffer.concat([Buffer.from([2]),Buffer.from('["o",[["label",["v","literal"]],["items",["a",[["v",null],["v",false],["v",5]]]]]]')]);
    expect((await fs.readFile(join(directory,ref.sha256))).equals(expected)).toBe(true);
    expect(await store.readJson(ref)).toEqual(value);
  });
  it('rejects accessors, sparse arrays and cyclic/non-JSON input', async () => {
    const { store } = await fixture();
    const circular: any = {}; circular.self = circular;
    for (const value of [circular, [undefined], Array(3), { get value() { throw new Error('getter executed'); } }, { value: NaN }]) {
      await expect(store.writeJson(value)).rejects.toThrow();
    }
  });
});
