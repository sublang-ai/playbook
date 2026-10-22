// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Physical storage only: callers retain the session lease and validate the
// materialized recovery schema. No published chunk is replaced or collected.
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import * as nativeFs from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { sameFileIdentity, tightenPrivateEntry, verifyPrivateEntry } from './private-paths.js';

export const MAX_SESSION_CHUNK_BYTES = 8 * 1024 * 1024;
const INLINE_BYTES = 16 * 1024;
const FANOUT = 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_NODES = 4096;
const DIGEST = /^[0-9a-f]{64}$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value));
const parseJson = (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = () => { throw new Error('invalid session chunk encoding'); };
function reference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !own(value, 'sha256') || !own(value, 'byteLength') ||
      !DIGEST.test(value.sha256) || !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 1 || value.byteLength > MAX_SESSION_CHUNK_BYTES) fail();
  return value;
}
function privateStat(stat, directory) {
  if (typeof stat.mode === 'bigint') {
    const original = stat;
    stat = { ...stat, mode: Number(stat.mode), uid: Number(stat.uid), nlink: Number(stat.nlink),
      isFile: () => original.isFile(), isDirectory: () => original.isDirectory(), isSymbolicLink: () => original.isSymbolicLink() };
  }
  verifyPrivateEntry(stat, directory, 'session chunk');
  if ((stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)) throw new Error('session chunk permissions must be private');
}
function unchanged(before, after) {
  const precise = before.mtimeNs !== undefined && after.mtimeNs !== undefined;
  return BigInt(before.dev) === BigInt(after.dev) && BigInt(before.ino) === BigInt(after.ino) && BigInt(before.size) === BigInt(after.size) &&
    (precise ? before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs :
      typeof before.size === typeof after.size ? before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs :
        Math.trunc(Number(before.mtimeMs)) === Math.trunc(Number(after.mtimeMs)) && Math.trunc(Number(before.ctimeMs)) === Math.trunc(Number(after.ctimeMs)));
}

export function createSessionChunks({ directory, fsOps, createDirectory = true }) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) throw new TypeError('session chunk directory must be absolute');
  if (typeof createDirectory !== 'boolean') throw new TypeError('createDirectory must be boolean');
  const fs = { ...nativeFs, ...fsOps };
  // Reuse immutable bytes only after a fresh private-path proof with exact
  // nanosecond metadata. Public export proofs always read and hash the files.
  const verified = new Map();
  let cachedBytes = 0;
  const forget = (digest) => {
    const entry = verified.get(digest);
    if (entry) { cachedBytes -= entry.bytes.length; verified.delete(digest); }
  };
  const remember = (digest, bytes, stat, owner) => {
    if (stat.mtimeNs === undefined || stat.ctimeNs === undefined) return;
    forget(digest);
    verified.set(digest, { bytes, stat, owner }); cachedBytes += bytes.length;
    while (cachedBytes > CACHE_BYTES || verified.size > CACHE_NODES) forget(verified.keys().next().value);
  };
  const operations = new AsyncLocalStorage();
  const freshDirectory = async () => { const stat = await fs.lstat(directory); privateStat(stat, true); return stat; };
  const checkDirectory = async () => {
    const context = operations.getStore();
    if (context?.owner) return context.owner;
    const owner = await freshDirectory();
    if (context) context.owner = owner;
    return owner;
  };
  const operation = (work, force = false) => operations.run({ reads: new Map(), writes: new Map(), force }, async () => {
    try { return await work(); }
    finally {
      const owner = operations.getStore().owner;
      if (owner && !sameFileIdentity(owner, await freshDirectory())) throw new Error('session chunk directory changed during operation');
    }
  });
  const sync = async (path, expected) => {
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    try {
      const opened = await handle.stat(); privateStat(opened, true);
      if (expected && !sameFileIdentity(expected, opened)) throw new Error('session chunk directory changed');
      await handle.sync();
      const current = await fs.lstat(path); privateStat(current, true);
      if (!sameFileIdentity(opened, current)) throw new Error('session chunk directory changed');
    } finally { await handle.close(); }
  };
  const ensureDirectory = async () => {
    // Never create the sessions directory or its ancestors implicitly.
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) {
      if (error.code !== 'ENOENT' || !createDirectory) throw error;
      const parent = await fs.lstat(dirname(directory)); privateStat(parent, true);
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      stat = await fs.lstat(directory);
      await sync(dirname(directory), parent);
    }
    await tightenPrivateEntry(directory, stat, true, fs, 'session chunk directory');
  };
  const prepare = async ({ recoverInterrupted = false } = {}) => {
    if (typeof recoverInterrupted !== 'boolean') throw new TypeError('recoverInterrupted must be boolean');
    await ensureDirectory();
    const pendingAliases = new Map();
    const names = await fs.readdir(directory);
    for (const name of names) {
      const match = /^\.write-([0-9a-f]{64})-[0-9a-f-]{36}\.tmp$/.exec(name);
      if (!match) continue;
      const path = join(directory, name);
      const temporary = await fs.lstat(path);
      if (temporary.nlink === 1) privateStat(temporary, false);
      else {
        // A crash between exclusive link publication and alias removal may
        // leave precisely these two names for one private store-owned inode.
        if (temporary.isSymbolicLink() || !temporary.isFile() || temporary.nlink !== 2 ||
            (process.getuid && temporary.uid !== process.getuid()) || (temporary.mode & 0o7777) !== 0o600) throw new Error('unsafe interrupted session chunk publication');
        const destination = await fs.lstat(join(directory, match[1]));
        if (!unchanged(temporary, destination) || destination.isSymbolicLink()) throw new Error('session chunk temporary alias differs from publication');
        pendingAliases.set(match[1], temporary);
      }
      if (recoverInterrupted) {
        // The caller must hold exclusive recovery authority. Unowned prepare
        // must never unlink a temporary still being written by another host.
        if (!unchanged(temporary, await fs.lstat(path))) throw new Error('session chunk temporary changed');
        await fs.unlink(path);
      }
    }
    await sync(directory, await checkDirectory());
    for (const name of names) {
      if (!DIGEST.test(name)) continue;
      const path = join(directory, name);
      const stat = await fs.lstat(path);
      if (stat.size > MAX_SESSION_CHUNK_BYTES) throw new Error('session chunk exceeds file bound');
      if (!recoverInterrupted && pendingAliases.has(name) && unchanged(pendingAliases.get(name), stat)) continue;
      await tightenPrivateEntry(path, stat, false, fs, 'session chunk file');
    }
  };
  const readNodeUncached = async (ref) => {
    reference(ref);
    const owner = await checkDirectory();
    const path = join(directory, ref.sha256);
    const before = await fs.lstat(path, { bigint: true }); privateStat(before, false);
    if (BigInt(before.size) !== BigInt(ref.byteLength)) throw new Error('session chunk length mismatch');
    const cached = verified.get(ref.sha256);
    if (!operations.getStore()?.force && cached && before.mtimeNs !== undefined &&
        sameFileIdentity(owner, cached.owner) && unchanged(cached.stat, before)) {
      verified.delete(ref.sha256); verified.set(ref.sha256, cached);
      return cached.bytes;
    }
    forget(ref.sha256);
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat({ bigint: true }); privateStat(opened, false);
      if (!unchanged(before, opened)) throw new Error('session chunk changed before read');
      // Read the proven bounded length, rather than readFile on a growing file.
      const bytes = Buffer.alloc(ref.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error('session chunk truncated during read');
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true }); privateStat(after, false);
      const current = await fs.lstat(path, { bigint: true }); privateStat(current, false);
      if (!unchanged(opened, after) || !unchanged(after, current) || !sameFileIdentity(owner, await checkDirectory())) throw new Error('session chunk changed during read');
      if (hash(bytes) !== ref.sha256) throw new Error('session chunk digest mismatch');
      if ([before, opened, after, current].every((stat) => stat.mtimeNs !== undefined && stat.ctimeNs !== undefined)) remember(ref.sha256, bytes, current, owner);
      return bytes;
    } finally { await handle.close(); }
  };
  const readNode = (ref) => {
    reference(ref);
    const reads = operations.getStore()?.reads;
    const previous = reads?.get(ref.sha256);
    if (previous) {
      if (previous.byteLength !== ref.byteLength) fail();
      return previous.bytes;
    }
    const bytes = readNodeUncached(ref);
    reads?.set(ref.sha256, { byteLength: ref.byteLength, bytes });
    return bytes;
  };
  const writeNode = async (bytes) => {
    if (!bytes.length || bytes.length > MAX_SESSION_CHUNK_BYTES) throw new Error('session chunk exceeds file bound');
    const ref = Object.freeze({ sha256: hash(bytes), byteLength: bytes.length });
    const writes = operations.getStore()?.writes;
    if (writes?.has(ref.sha256)) return writes.get(ref.sha256);
    const owner = await checkDirectory();
    try { await readNode(ref); writes?.set(ref.sha256, ref); return ref; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      operations.getStore()?.reads.delete(ref.sha256);
    }
    const temporary = join(directory, `.write-${ref.sha256}-${randomUUID()}.tmp`);
    const destination = join(directory, ref.sha256);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.chmod(0o600);
      const opened = await handle.stat(); privateStat(opened, false);
      await handle.writeFile(bytes); await handle.sync();
      const after = await handle.stat(); privateStat(after, false);
      const current = await fs.lstat(temporary); privateStat(current, false);
      if (!sameFileIdentity(opened, after) || !unchanged(after, current) || after.size !== bytes.length || !sameFileIdentity(owner, await checkDirectory())) throw new Error('session chunk changed during write');
      await handle.close(); handle = undefined;
      // link is exclusive publication; remove its temporary alias before any
      // private reader sees it, then sync both the file and directory.
      try { await fs.link(temporary, destination); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await fs.unlink(temporary);
      await readNode(ref);
      writes?.set(ref.sha256, ref);
      return ref;
    } finally {
      await handle?.close();
      // Failed publication leaves only unreachable bytes, never a new root.
      try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const put = (tag, value) => writeNode(Buffer.concat([Buffer.from([tag]), jsonBytes(value)]));
  const writeBytes = async (input) => {
    const bytes = Buffer.from(input);
    let level = [];
    for (let offset = 0; offset < bytes.length || offset === 0; offset += MAX_SESSION_CHUNK_BYTES - 1) {
      level.push(await writeNode(Buffer.concat([Buffer.from([0]), bytes.subarray(offset, offset + MAX_SESSION_CHUNK_BYTES - 1)])));
    }
    while (level.length > 1) {
      const next = [];
      for (let offset = 0; offset < level.length; offset += FANOUT) next.push(await put(1, level.slice(offset, offset + FANOUT)));
      level = next;
    }
    return level[0];
  };
  const readBytes = async (ref, depth = 0) => {
    if (depth > 512) fail();
    const bytes = await readNode(ref);
    if (bytes[0] === 0) return bytes.subarray(1);
    if (bytes[0] !== 1) fail();
    const children = parseJson(bytes.subarray(1));
    if (!Array.isArray(children) || !children.length || children.length > FANOUT) fail();
    const pieces = [];
    for (const child of children) pieces.push(await readBytes(reference(child), depth + 1));
    return Buffer.concat(pieces);
  };
  const writeEncodedJson = async (encoded, bytes = jsonBytes(encoded)) => {
    return bytes.length + 1 <= MAX_SESSION_CHUNK_BYTES
      ? writeNode(Buffer.concat([Buffer.from([2]), bytes]))
      : put(3, await writeBytes(bytes));
  };
  // Inline JSON has no asynchronous work. Yield only at actual chunk IO,
  // retaining depth-first ordering even when a child needs persistence.
  const eachSequential = (values, visit, start = 0) => {
    for (let index = start; index < values.length; index++) {
      const pending = visit(values[index], index);
      if (pending instanceof Promise) return pending.then(() => eachSequential(values, visit, index + 1));
    }
  };
  const writeJson = async (value) => {
    const active = new Set();
    const encode = (node, depth) => {
      if (depth > 512) throw new Error('session JSON nesting exceeds supported depth');
      if (node === null || typeof node === 'string' || typeof node === 'boolean' || (typeof node === 'number' && Number.isFinite(node))) {
        const serialized = jsonBytes(node);
        return serialized.length <= INLINE_BYTES ? ['v', node] : writeBytes(serialized).then((ref) => ['s', ref]);
      }
      if (!node || typeof node !== 'object' || (!Array.isArray(node) && ![Object.prototype, null].includes(Object.getPrototypeOf(node))) || active.has(node)) throw new TypeError('session chunks require plain acyclic JSON');
      active.add(node);
      try {
        const entries = [];
        for (const key of Object.keys(node)) {
          const descriptor = Object.getOwnPropertyDescriptor(node, key);
          if (!descriptor || !own(descriptor, 'value')) throw new TypeError('session chunks reject JSON accessors');
          entries.push([key, descriptor.value]);
        }
        if (Array.isArray(node) && (entries.length !== node.length || entries.some(([key], index) => key !== String(index)))) throw new TypeError('session chunks reject sparse or extended arrays');
        const encoded = [];
        const finish = () => {
          const plain = Array.isArray(node) ? encoded.map(([, child]) => child) : encoded;
          const representation = [Array.isArray(node) ? 'a' : 'o', plain];
          const bytes = jsonBytes(representation);
          return bytes.length <= INLINE_BYTES ? representation : writeEncodedJson(representation, bytes).then((ref) => ['r', ref]);
        };
        const children = eachSequential(entries, ([key, child]) => {
          const result = encode(child, depth + 1);
          if (result instanceof Promise) return result.then((value) => { encoded.push([key, value]); });
          encoded.push([key, result]);
        });
        const result = children instanceof Promise ? children.then(finish) : finish();
        if (result instanceof Promise) return result.finally(() => active.delete(node));
        active.delete(node);
        return result;
      } catch (error) { active.delete(node); throw error; }
    };
    return writeEncodedJson(await encode(value, 0));
  };
  const decode = (node, depth, collect) => {
    if (depth > 2048 || !Array.isArray(node) || node.length !== 2) fail();
    const [kind, value] = node;
    if (kind === 'v') {
      if (value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) fail();
      return value;
    }
    if (kind === 'r') { collect?.(reference(value)); return loadJson(value, depth + 1, collect); }
    if (kind === 's') {
      collect?.(reference(value));
      return readBytes(value).then((bytes) => { const result = parseJson(bytes); if (typeof result !== 'string') fail(); return result; });
    }
    if (kind !== 'a' && kind !== 'o' || !Array.isArray(value)) fail();
    const result = kind === 'a' ? [] : {};
    const children = eachSequential(value, (entry) => {
      if (kind === 'o' && (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || own(result, entry[0]))) fail();
      const set = (decoded) => {
        if (kind === 'a') result.push(decoded);
        else Object.defineProperty(result, entry[0], { value: decoded, enumerable: true, writable: true, configurable: true });
      };
      const decoded = decode(kind === 'a' ? entry : entry[1], depth + 1, collect);
      if (decoded instanceof Promise) return decoded.then(set);
      set(decoded);
    });
    return children instanceof Promise ? children.then(() => result) : result;
  };
  const loadJson = async (ref, depth = 0, collect) => {
    if (depth > 2048) fail();
    const bytes = await readNode(ref);
    if (bytes[0] === 2) return decode(parseJson(bytes.subarray(1)), depth + 1, collect);
    if (bytes[0] !== 3) fail();
    const body = reference(parseJson(bytes.subarray(1)));
    collect?.(body);
    return decode(parseJson(await readBytes(body)), depth + 1, collect);
  };
  const walk = async (ref) => {
    const seen = new Map();
    const visit = async (value) => {
      reference(value);
      if (seen.has(value.sha256)) { if (seen.get(value.sha256).byteLength !== value.byteLength) fail(); return; }
      const bytes = await readNode(value);
      seen.set(value.sha256, Object.freeze({ path: value.sha256, sha256: value.sha256, byteLength: value.byteLength }));
      if (bytes[0] === 0) return;
      if (bytes[0] === 1) {
        const children = parseJson(bytes.subarray(1));
        if (!Array.isArray(children) || !children.length || children.length > FANOUT) fail();
        for (const child of children) await visit(child);
      } else if (bytes[0] === 2 || bytes[0] === 3) {
        const refs = [];
        await loadJson(value, 0, (child) => refs.push(child));
        for (const child of refs) await visit(child);
      } else fail();
    };
    await visit(ref);
    return Object.freeze([...seen.values()]);
  };
  const validateEncoding = (encoded, depth = 0) => {
    if (depth > 2048 || !Array.isArray(encoded) || encoded.length !== 2) fail();
    const [kind, value] = encoded;
    if (kind === 'v') {
      if (value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) fail();
    } else if (kind === 'r' || kind === 's') reference(value);
    else if (kind === 'a') {
      if (!Array.isArray(value)) fail();
      for (const child of value) validateEncoding(child, depth + 1);
    } else if (kind === 'o') {
      if (!Array.isArray(value)) fail();
      const keys = new Set();
      for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0])) fail();
        keys.add(entry[0]); validateEncoding(entry[1], depth + 1);
      }
    } else fail();
  };
  const validateNamespace = async () => {
    const owner = await checkDirectory();
    const entries = [];
    for (const name of await fs.readdir(directory)) {
      const path = join(directory, name);
      const stat = await fs.lstat(path);
      if (!DIGEST.test(name)) {
        // A namespace proof never repairs temporary aliases. The same proof
        // used by prepare permits a pending store-owned publication alias.
        const temporary = /^\.write-([0-9a-f]{64})-[0-9a-f-]{36}\.tmp$/.exec(name);
        if (temporary && stat.nlink === 2) {
          if (stat.isSymbolicLink() || !stat.isFile() ||
              (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o7777) !== 0o600 ||
              !unchanged(stat, await fs.lstat(join(directory, temporary[1])))) throw new Error('unsafe interrupted session chunk publication');
        } else privateStat(stat, false);
        continue;
      }
      if (stat.size > MAX_SESSION_CHUNK_BYTES) throw new Error('session chunk exceeds file bound');
      const bytes = await readNode({ sha256: name, byteLength: stat.size });
      if (bytes[0] === 1) {
        const children = parseJson(bytes.subarray(1));
        if (!Array.isArray(children) || !children.length || children.length > FANOUT) fail();
        for (const child of children) reference(child);
      } else if (bytes[0] === 2) validateEncoding(parseJson(bytes.subarray(1)));
      else if (bytes[0] === 3) reference(parseJson(bytes.subarray(1)));
      else if (bytes[0] !== 0) fail();
      entries.push(Object.freeze({ path: name, byteLength: bytes.length }));
    }
    if (!sameFileIdentity(owner, await checkDirectory())) throw new Error('session chunk directory changed during validation');
    return Object.freeze(entries);
  };
  const remove = async () => {
    let owner;
    try { owner = await checkDirectory(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const names = await fs.readdir(directory);
    // Validate every candidate before removing any; links and subdirectories
    // are never followed or recursively removed.
    for (const name of names) privateStat(await fs.lstat(join(directory, name)), false);
    for (const name of names) {
      if (!sameFileIdentity(owner, await checkDirectory())) throw new Error('session chunk directory changed during deletion');
      const path = join(directory, name); privateStat(await fs.lstat(path), false); await fs.unlink(path);
    }
    await sync(directory, owner);
    await fs.rmdir(directory);
    verified.clear(); cachedBytes = 0;
    await sync(dirname(directory));
  };
  const writeOperation = (work) => operation(async () => {
    await ensureDirectory();
    const owner = await checkDirectory();
    const result = await work();
    // Files have each been synced before publication. One directory sync
    // proves the complete dependency graph before its reference is returned.
    await sync(directory, owner);
    return result;
  });
  return Object.freeze({
    prepare,
    writeJson: (value) => writeOperation(() => writeJson(value)),
    readJson: (ref) => operation(() => loadJson(ref)),
    writeBytes: (bytes) => writeOperation(() => writeBytes(bytes)),
    readBytes: (ref) => operation(async () => Buffer.from(await readBytes(ref))),
    walk: (ref) => operation(() => walk(ref), true),
    validateNamespace: () => operation(validateNamespace, true),
    delete: remove,
  });
}
