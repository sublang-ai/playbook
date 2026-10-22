// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Exact replay bytes live in immutable chunks. The small root is the only
// mutable entry; publication never modifies a previously readable chain.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as nativeFs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createSessionChunks, MAX_SESSION_CHUNK_BYTES } from './session-chunks.js';
import { sameFileIdentity, tightenPrivateEntry, verifyPrivateEntry } from './private-paths.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error('invalid bounded session replay'); };
function reference(value) {
  if (!exactKeys(value, ['sha256', 'byteLength']) || !DIGEST.test(value.sha256) ||
      !count(value.byteLength) || value.byteLength < 1 || value.byteLength > MAX_SESSION_CHUNK_BYTES) invalid();
  return value;
}
function privateStat(stat, directory) {
  verifyPrivateEntry(stat, directory, 'session replay');
  if ((stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)) throw new Error('session replay permissions must be private');
}
const unchanged = (left, right) => sameFileIdentity(left, right) && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
function rootChanged(message) {
  const error = new Error(message);
  error.replayRootRetry = true;
  return error;
}
function privateRootStat(stat) {
  try { privateStat(stat, false); }
  catch (error) {
    // A complete initial root can briefly have its staging link, and an
    // already opened old root loses its last link on atomic replacement.
    // Retry those observations; a persistent unsafe link still fails closed.
    if (stat.nlink !== 1) error.replayRootRetry = true;
    throw error;
  }
}

export async function createBoundedReplay({ sessionId, sessionsDir, fsOps, assertOwner = async () => {}, chunks }) {
  if (!UUID.test(sessionId)) throw new TypeError('session replay requires a canonical session UUID');
  if (typeof sessionsDir !== 'string' || !isAbsolute(sessionsDir) || sessionsDir.includes('\0')) throw new TypeError('session replay directory must be absolute');
  if (typeof assertOwner !== 'function') throw new TypeError('session replay owner check must be a function');
  const fs = { ...nativeFs, ...fsOps };
  const path = join(sessionsDir, `${sessionId}.replay.json`);
  const chunkStore = chunks ?? createSessionChunks({ directory: join(sessionsDir, `${sessionId}.chunks`), fsOps });
  let queue = Promise.resolve();
  // This constant-size proof is private to one backend / writer lease. It
  // establishes durability of append-only dependencies, not immunity to an
  // outside writer changing an immutable chunk. Public reads always verify.
  let publicationProof = null;
  let mutationAnchor = null;
  const proofOf = (snapshot) => ({
    owner: snapshot.owner, stat: snapshot.stat,
    rootBytes: snapshot.rootBytes === null ? null : Buffer.from(snapshot.rootBytes),
  });
  const assertMutationAnchor = (snapshot) => {
    if (mutationAnchor === null) return;
    if (!sameFileIdentity(mutationAnchor.owner, snapshot.owner) ||
        (mutationAnchor.rootBytes === null ? snapshot.rootBytes !== null : snapshot.rootBytes === null ||
          !unchanged(mutationAnchor.stat, snapshot.stat) || !mutationAnchor.rootBytes.equals(snapshot.rootBytes))) {
      throw new Error('session replay root changed outside its writer');
    }
  };
  const matchesProof = (snapshot) => publicationProof !== null && snapshot.rootBytes !== null &&
    sameFileIdentity(publicationProof.owner, snapshot.owner) && unchanged(publicationProof.stat, snapshot.stat) &&
    publicationProof.rootBytes.equals(snapshot.rootBytes);
  const rememberProof = (snapshot) => {
    if (mutationAnchor === null) mutationAnchor = proofOf(snapshot);
    if (snapshot.rootBytes !== null) publicationProof = proofOf(snapshot);
  };
  const serialize = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const directory = async () => {
    const stat = await fs.lstat(sessionsDir); privateStat(stat, true); return stat;
  };
  const syncDirectory = async (expected) => {
    const handle = await fs.open(sessionsDir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    try {
      const stat = await handle.stat(); privateStat(stat, true);
      if (!sameFileIdentity(expected, stat)) throw new Error('session replay directory changed');
      await handle.sync();
      if (!sameFileIdentity(stat, await directory())) throw new Error('session replay directory changed');
    } finally { await handle.close(); }
  };
  const validateRoot = (value) => {
    if (!exactKeys(value, ['kind', 'schemaVersion', 'sessionId', 'head', 'byteLength']) ||
        value.kind !== 'captain-session-replay' || value.schemaVersion !== 1 || value.sessionId !== sessionId ||
        !count(value.byteLength) || (value.head === null) !== (value.byteLength === 0)) invalid();
    if (value.head !== null) reference(value.head);
    return value;
  };
  const readRootOnce = async () => {
    const owner = await directory();
    let before;
    try { before = await fs.lstat(path); }
    catch (error) { if (error.code === 'ENOENT') return { root: null, rootBytes: null, stat: null, owner }; throw error; }
    privateRootStat(before);
    if (before.size > MAX_SESSION_CHUNK_BYTES) throw new Error('session replay root exceeds file bound');
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat(); privateRootStat(opened);
      if (!unchanged(before, opened)) throw rootChanged('session replay root changed before read');
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw rootChanged('session replay root truncated during read');
        offset += bytesRead;
      }
      const after = await handle.stat(); privateRootStat(after);
      if (!unchanged(opened, after)) throw rootChanged('session replay root changed during read');
      if (!sameFileIdentity(owner, await directory())) throw new Error('session replay directory changed during read');
      return { root: validateRoot(JSON.parse(bytes.toString('utf8'))), rootBytes: bytes, stat: after, owner };
    } finally { await handle.close(); }
  };
  const readRoot = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await readRootOnce(); }
      catch (error) { if (!error.replayRootRetry || attempt === 3) throw error; }
    }
  };
  const assertSnapshot = async (snapshot) => {
    const current = await readRoot();
    if (!sameFileIdentity(snapshot.owner, current.owner) ||
        (snapshot.rootBytes === null ? current.rootBytes !== null : current.rootBytes === null ||
          !sameFileIdentity(snapshot.stat, current.stat) || !snapshot.rootBytes.equals(current.rootBytes))) {
      throw new Error('session replay root changed before publication');
    }
    if (snapshot.stat !== null) {
      const latest = await fs.lstat(path); privateStat(latest, false);
      if (!unchanged(snapshot.stat, latest)) throw new Error('session replay root changed before publication');
    }
  };
  const verifyChain = async (snapshot, visit) => {
    let ref = snapshot.root?.head ?? null;
    let total = snapshot.root?.byteLength ?? 0;
    const seen = new Set();
    while (ref !== null) {
      reference(ref);
      if (seen.has(ref.sha256)) throw new Error('session replay chain contains a cycle');
      seen.add(ref.sha256);
      const node = await chunkStore.readJson(ref);
      if (!exactKeys(node, ['previous', 'content', 'byteLength', 'totalBytes']) ||
          !count(node.byteLength) || node.byteLength === 0 || !count(node.totalBytes) ||
          node.totalBytes !== total || node.byteLength > total) invalid();
      reference(node.content);
      if (node.previous !== null) reference(node.previous);
      const bytes = await chunkStore.readBytes(node.content);
      if (bytes.byteLength !== node.byteLength) throw new Error('session replay append length mismatch');
      await visit?.(ref, node, bytes);
      total -= node.byteLength;
      ref = node.previous;
    }
    if (total !== 0) throw new Error('session replay chain length mismatch');
  };
  const visitChain = async (snapshot, visit) => {
    try { return await verifyChain(snapshot, visit); }
    catch (error) { publicationProof = null; throw error; }
  };
  const publish = async (snapshot, root, exclusive) => {
    const bytes = Buffer.from(`${JSON.stringify(root)}\n`);
    const temporary = join(sessionsDir, `.${sessionId}.replay-${randomUUID()}.tmp`);
    let handle;
    let temporaryStat;
    try {
      await assertOwner();
      await assertSnapshot(snapshot);
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.chmod(0o600);
      temporaryStat = await handle.stat(); privateStat(temporaryStat, false);
      await handle.writeFile(bytes); await handle.sync();
      const after = await handle.stat(); privateStat(after, false);
      const current = await fs.lstat(temporary); privateStat(current, false);
      if (!sameFileIdentity(temporaryStat, after) || !sameFileIdentity(after, current)) throw new Error('session replay temporary root changed');
      await handle.close(); handle = undefined;
      await assertOwner();
      await assertSnapshot(snapshot);
      if (exclusive || snapshot.root === null) await fs.link(temporary, path);
      else await fs.rename(temporary, path);
      // Exclusive publication briefly has two private links; remove the staging
      // name before readers' single-link verification and directory syncing.
      if (exclusive || snapshot.root === null) await fs.unlink(temporary);
      await syncDirectory(snapshot.owner);
      const published = await fs.lstat(path); privateStat(published, false);
      if (!sameFileIdentity(temporaryStat, published) || published.size !== bytes.length) throw new Error('session replay root changed after publication');
      const completed = { owner: snapshot.owner, stat: published, rootBytes: bytes };
      mutationAnchor = proofOf(completed);
      rememberProof(completed);
      return { byteLength: root.byteLength };
    } finally {
      await handle?.close();
      try {
        const current = await fs.lstat(temporary);
        if (temporaryStat && sameFileIdentity(temporaryStat, current)) await fs.unlink(temporary);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const append = async (input, exclusive) => {
    if (!(input instanceof Uint8Array)) throw new TypeError('session replay bytes must be a Uint8Array');
    const bytes = input;
    await assertOwner();
    const snapshot = await readRoot();
    if (exclusive && snapshot.root !== null) throw new Error('session replay root already exists');
    assertMutationAnchor(snapshot);
    if (!exclusive && bytes.length === 0 && snapshot.root !== null) return { byteLength: snapshot.root.byteLength };
    const prior = snapshot.root?.byteLength ?? 0;
    const byteLength = prior + bytes.length;
    if (!count(byteLength)) throw new Error('session replay byte count exceeds safe integer range');
    // An append may extend only a fully verified predecessor. Subsequent
    // appends can reuse that proof under the exclusive writer's immutable
    // chunk rule; a changed root or directory requires verification again.
    if (snapshot.root !== null && !matchesProof(snapshot)) {
      await visitChain(snapshot);
      rememberProof(snapshot);
    }
    const head = bytes.length ? await chunkStore.writeBytesAndJson(bytes, (content) => ({ previous: snapshot.root?.head ?? null, content, byteLength: bytes.length, totalBytes: byteLength })) : null;
    return publish(snapshot, { kind: 'captain-session-replay', schemaVersion: 1, sessionId, head, byteLength }, exclusive);
  };
  const readSnapshot = async () => {
      const snapshot = await readRoot();
      const parts = [];
      await visitChain(snapshot, (_ref, _node, bytes) => parts.push(bytes));
      rememberProof(snapshot);
      return { root: snapshot.root, rootBytes: snapshot.rootBytes, bytes: Buffer.concat(parts.reverse(), snapshot.root?.byteLength ?? 0) };
  };
  const admit = (bytes, exclusive) => {
    if (!(bytes instanceof Uint8Array)) return Promise.reject(new TypeError('session replay bytes must be a Uint8Array'));
    const admitted = Buffer.from(bytes);
    return serialize(() => append(admitted, exclusive));
  };
  return Object.freeze({
    appendBytes: (bytes) => admit(bytes, false),
    initializeBytes: (bytes) => admit(bytes, true),
    readSnapshot,
    async readBytes() { return (await readSnapshot()).bytes; },
    async rootBytes() { return (await readRoot()).rootBytes; },
    checkpoint: ({ trustPublished = false } = {}) => serialize(async () => {
      await assertOwner();
      const snapshot = await readRoot();
      assertMutationAnchor(snapshot);
      if (!trustPublished || !matchesProof(snapshot)) {
        await visitChain(snapshot);
        rememberProof(snapshot);
      }
      await assertOwner();
      await assertSnapshot(snapshot);
      await syncDirectory(snapshot.owner);
      return { byteLength: snapshot.root?.byteLength ?? 0 };
    }),
    async collectFiles() {
      const snapshot = await readRoot();
      if (snapshot.root === null) return [];
      const files = new Map([[`${sessionId}.replay.json`, { path: `${sessionId}.replay.json`, byteLength: snapshot.rootBytes.length }]]);
      await visitChain(snapshot, async (ref, node) => {
        for (const pointer of [ref, node.content]) for (const file of await chunkStore.walk(pointer)) {
          const relative = `${sessionId}.chunks/${file.path}`;
          const existing = files.get(relative);
          if (existing && existing.byteLength !== file.byteLength) invalid();
          files.set(relative, { path: relative, byteLength: file.byteLength });
        }
      });
      return [...files.values()];
    },
    deleteRoot: () => serialize(async () => {
      await assertOwner();
      const snapshot = await readRoot();
      if (snapshot.root === null) return;
      await assertOwner();
      await assertSnapshot(snapshot);
      await fs.unlink(path);
      await syncDirectory(snapshot.owner);
      publicationProof = null;
      mutationAnchor = null;
    }),
    async prepare() {
      await tightenPrivateEntry(sessionsDir, await fs.lstat(sessionsDir), true, fs, 'session replay directory');
      try { await tightenPrivateEntry(path, await fs.lstat(path), false, fs, 'session replay root'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  });
}
