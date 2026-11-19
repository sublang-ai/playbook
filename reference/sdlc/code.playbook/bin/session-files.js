// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-111: a session's physical representation (schema 9) is one manifest
// file, an append-only log of replay segments and content-addressed blob
// parts for the rare value past the per-file bound. This module owns those
// files; the store above it owns the logical manifest and replay contracts.
//
//   <id>.json              {schemaVersion: 9, kind, sessionId, manifest, log, spills?}
//   <id>.replay/<seq>.jsonl  whole lines, named by their first sequence
//   <id>.blobs/<sha256>    one part of a spilled manifest value or envelope
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as nativeFs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertPrivateEntry, mkdirPrivate, renameWithRetry, sameFileIdentity, syncDirectory, tightenPrivateEntry } from './private-paths.js';

export const SESSION_STORAGE_VERSION = 9;
export const SESSION_STORAGE_KIND = 'captain-session-storage';
export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
// The writer seals its open segment once it reaches this size, so a Git
// sync rewrites at most this much open replay between syncs.
export const SEGMENT_SEAL_BYTES = 1024 * 1024;
const SEGMENT_NAME = /^[0-9]{12}\.jsonl$/;
const BLOB_NAME = /^[0-9a-f]{64}$/;
const TEMPORARY_NAME = /^\.[0-9a-f-]{36}\.tmp$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A segment line is an envelope's exact bytes, or this reference to the
// blob parts of one envelope too large for any file; envelopes begin {"v":.
const REFERENCE_PREFIX = Buffer.from('{"parts":');
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MIN_SPILL_BYTES = 4096;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function invalid(message) { return new Error(`invalid session storage: ${message}`); }
// Retryable observations: an entry replaced, truncated or removed while read.
function changed(message) { const error = new Error(message); error.privateFileChanged = true; return error; }
function exactKeys(value, required, optional = []) {
  return object(value) && required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function validateReference(value) {
  if (!exactKeys(value, ['sha256', 'byteLength']) || !DIGEST.test(value.sha256) ||
      !count(value.byteLength) || value.byteLength < 1 || value.byteLength > MAX_SESSION_FILE_BYTES) throw invalid('blob reference');
  return { sha256: value.sha256, byteLength: value.byteLength };
}
function validateParts(value) {
  if (!Array.isArray(value) || value.length === 0) throw invalid('blob parts');
  return value.map(validateReference);
}
function validateSegmentEntry(value) {
  if (!exactKeys(value, ['name', 'byteLength', 'sha256']) || typeof value.name !== 'string' || !SEGMENT_NAME.test(value.name) ||
      !count(value.byteLength) || value.byteLength > MAX_SESSION_FILE_BYTES || !DIGEST.test(value.sha256)) throw invalid('replay segment binding');
  return { name: value.name, byteLength: value.byteLength, sha256: value.sha256 };
}
export function segmentName(firstSeq) {
  if (!Number.isSafeInteger(firstSeq) || firstSeq < 1 || firstSeq > 999_999_999_999) throw new RangeError('replay segment sequence is outside its name range');
  return `${String(firstSeq).padStart(12, '0')}.jsonl`;
}
const segmentSeq = (name) => Number(name.slice(0, 12));

// The manifest binds the replay prefix its checkpoint proves: every sealed
// segment whole, and the open segment's prefix.
export function validateLogBinding(value) {
  if (!exactKeys(value, ['sealed', 'open']) || !Array.isArray(value.sealed)) throw invalid('replay log binding');
  const sealed = value.sealed.map(validateSegmentEntry);
  const open = value.open === null ? null : validateSegmentEntry(value.open);
  const names = [...sealed, ...(open ? [open] : [])].map(({ name }) => name);
  if (names.some((name, index) => index > 0 && name <= names[index - 1])) throw invalid('replay log binding order');
  return { sealed, open };
}
export const EMPTY_LOG_BINDING = Object.freeze({ sealed: Object.freeze([]), open: null });
function validateSpills(value) {
  if (!Array.isArray(value) || value.length === 0) throw invalid('manifest spills');
  return value.map((spill) => {
    if (!exactKeys(spill, ['path', 'parts']) || !Array.isArray(spill.path) || spill.path.length === 0 ||
        spill.path.some((key) => typeof key !== 'string' && !count(key))) throw invalid('manifest spill');
    return { path: [...spill.path], parts: validateParts(spill.parts) };
  });
}
function partsOf(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_SESSION_FILE_BYTES) parts.push(bytes.subarray(offset, offset + MAX_SESSION_FILE_BYTES));
  return parts;
}
function placeSpill(root, path, value) {
  let parent = root;
  for (const key of path.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw invalid('manifest spill path');
    parent = parent[key];
  }
  const key = path.at(-1);
  if (parent === null || typeof parent !== 'object' || Array.isArray(parent) !== (typeof key === 'number') ||
      !Object.hasOwn(parent, key) || parent[key] !== null) throw invalid('manifest spill placeholder');
  Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true });
}
// The largest value below the root, by its serialized size. Ancestors are
// larger than their descendants, so successive choices never nest.
function largestSubtree(root) {
  let best;
  const visit = (value, path) => {
    if (value === null || typeof value !== 'object') {
      if (typeof value !== 'string') return;
    }
    const size = Buffer.byteLength(JSON.stringify(value));
    if (path.length > 0 && size >= MIN_SPILL_BYTES && (best === undefined || size > best.size)) best = { path, size, value };
    if (typeof value === 'object' && size >= MIN_SPILL_BYTES) {
      if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, index]));
      else for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  visit(root, []);
  return best;
}

export function createSessionFiles({ sessionsDir, sessionId, fsOps }) {
  if (typeof sessionsDir !== 'string' || !isAbsolute(sessionsDir) || sessionsDir.includes('\0')) throw new TypeError('session files directory must be absolute');
  if (!UUID.test(sessionId)) throw new TypeError('session files require a canonical session UUID');
  const fs = { ...nativeFs, ...fsOps };
  const manifestPath = join(sessionsDir, `${sessionId}.json`);
  const replayDir = join(sessionsDir, `${sessionId}.replay`);
  const blobsDir = join(sessionsDir, `${sessionId}.blobs`);

  const checkDirectory = async (path, label) => {
    const stat = await fs.lstat(path);
    assertPrivateEntry(stat, true, label, path);
    return stat;
  };
  // Creates only a session-owned child; a missing sessions directory refuses.
  const ensureDirectory = async (path, label) => {
    try { await checkDirectory(path, label); return false; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await checkDirectory(sessionsDir, 'session store directory');
    try { await mkdirPrivate(path, fs); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    await checkDirectory(path, label);
    return true;
  };
  // One private admission per opened file; the opened handle must be the
  // admitted entry. A growing entry (the open segment) is read to the length
  // its handle reports when opened.
  const readPrivate = async (path, label, { growing = false, start = 0, identity } = {}) => {
    const before = await fs.lstat(path);
    if (identity !== undefined && !sameFileIdentity(identity, before)) return undefined;
    assertPrivateEntry(before, false, label, path);
    if (before.size > MAX_SESSION_FILE_BYTES) throw invalid(`${label} exceeds the per-file bound`);
    const handle = await fs.open(path, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!sameFileIdentity(before, opened) || (!growing && opened.size !== before.size)) throw changed(`${label} changed while opening`);
      if (opened.size > MAX_SESSION_FILE_BYTES) throw invalid(`${label} exceeds the per-file bound`);
      if (start > opened.size) return undefined;
      const bytes = Buffer.allocUnsafe(opened.size - start);
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) throw changed(`${label} was truncated while reading`);
        offset += bytesRead;
      }
      if (!growing && (await handle.stat()).size !== opened.size) throw changed(`${label} changed while reading`);
      return { bytes, stat: opened };
    } finally { await handle.close(); }
  };

  const readBlob = async (reference) => {
    const read = await readPrivate(join(blobsDir, reference.sha256), 'session blob');
    if (read.bytes.length !== reference.byteLength || sha256(read.bytes) !== reference.sha256) throw invalid('session blob differs from its reference');
    return read.bytes;
  };
  const readParts = async (parts) => {
    const buffers = [];
    for (const part of parts) buffers.push(await readBlob(part));
    return Buffer.concat(buffers);
  };
  const writeBlobs = async (buffers) => {
    if (buffers.length === 0) return;
    const created = await ensureDirectory(blobsDir, 'session blob directory');
    for (const bytes of buffers) {
      const name = sha256(bytes);
      const path = join(blobsDir, name);
      try { await readBlob({ sha256: name, byteLength: bytes.length }); continue; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const temporary = join(blobsDir, `.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        if (process.platform !== 'win32') await handle.chmod(0o600);
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
        try { await fs.link(temporary, path); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; await readBlob({ sha256: name, byteLength: bytes.length }); }
      } finally {
        await handle?.close();
        try { await fs.unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    }
    await syncDirectory(blobsDir, fs);
    if (created) await syncDirectory(sessionsDir, fs);
  };

  const encodeManifest = (manifest, log) => {
    const physical = { schemaVersion: SESSION_STORAGE_VERSION, kind: SESSION_STORAGE_KIND, sessionId, manifest, log: validateLogBinding(log) };
    let bytes = Buffer.from(`${JSON.stringify(physical)}\n`);
    if (bytes.length <= MAX_SESSION_FILE_BYTES) return { bytes, blobs: [], parts: [] };
    const spilled = structuredClone(manifest);
    const spills = [], blobs = [];
    while (bytes.length > MAX_SESSION_FILE_BYTES) {
      const largest = largestSubtree(spilled);
      if (largest === undefined) throw new Error('session manifest exceeds the per-file bound');
      const content = Buffer.from(JSON.stringify(largest.value));
      const parts = partsOf(content).map((part) => { blobs.push(part); return { sha256: sha256(part), byteLength: part.length }; });
      const parent = largest.path.slice(0, -1).reduce((node, key) => node[key], spilled);
      Object.defineProperty(parent, largest.path.at(-1), { value: null, enumerable: true, configurable: true, writable: true });
      spills.push({ path: largest.path, parts });
      bytes = Buffer.from(`${JSON.stringify({ ...physical, manifest: spilled, spills })}\n`);
    }
    return { bytes, blobs, parts: spills.flatMap(({ parts }) => parts) };
  };
  // Writes the blob parts an encoded manifest needs; the caller then
  // publishes its bytes atomically.
  const prepareManifest = async (manifest, log) => {
    const encoded = encodeManifest(manifest, log);
    await writeBlobs(encoded.blobs);
    return encoded;
  };
  const decodeManifest = async (input) => {
    const bytes = Buffer.from(input);
    if (bytes.length > MAX_SESSION_FILE_BYTES) throw invalid('manifest file exceeds the per-file bound');
    let physical;
    try { physical = JSON.parse(utf8.decode(bytes)); } catch (cause) { throw invalid(`manifest file is not JSON: ${cause.message}`); }
    if (!exactKeys(physical, ['schemaVersion', 'kind', 'sessionId', 'manifest', 'log'], ['spills']) ||
        physical.schemaVersion !== SESSION_STORAGE_VERSION || physical.kind !== SESSION_STORAGE_KIND ||
        physical.sessionId !== sessionId || !object(physical.manifest)) throw invalid('manifest file fields');
    const log = validateLogBinding(physical.log);
    const spills = physical.spills === undefined ? [] : validateSpills(physical.spills);
    const manifest = physical.manifest;
    for (const spill of spills) {
      let value;
      try { value = JSON.parse(utf8.decode(await readParts(spill.parts))); }
      catch (cause) { if (cause?.code === 'ENOENT' || cause?.privateFileChanged) throw changed(`manifest spill is unavailable: ${cause.message}`); throw cause; }
      placeSpill(manifest, spill.path, value);
    }
    return { manifest, log, parts: spills.flatMap(({ parts }) => parts) };
  };
  const readManifestFile = async () => (await readPrivate(manifestPath, 'session manifest')).bytes;

  const listSegments = async () => {
    let names;
    try { await checkDirectory(replayDir, 'session replay directory'); names = await fs.readdir(replayDir); }
    catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
    return names.filter((name) => SEGMENT_NAME.test(name)).sort();
  };

  // Reads the log from its start, or from a position a reader verified
  // earlier ({name, identity, offset, seq}): the complete lines with blob
  // references expanded, any unfinished final line, the first structural
  // damage and the position after the last complete line. With a binding it
  // also verifies the bound prefix: sealed segments by their digests, then
  // the open segment's prefix, and counts the lines that prefix holds.
  const readLog = async ({ from, binding } = {}) => {
    const names = await listSegments();
    const emptyBound = () => binding === undefined ? {} : { bound: binding.sealed.length === 0 && binding.open === null ? { ok: true, lines: 0 } : { ok: false, lines: 0, reason: 'the bound replay prefix is missing' } };
    if (names === undefined) return from === undefined ? { absent: true, lines: Buffer.alloc(0), partial: Buffer.alloc(0), segments: [], blobs: [], end: null, ...emptyBound() } : { reset: true };
    let index = 0;
    if (from !== undefined) { index = names.indexOf(from.name); if (index < 0) return { reset: true }; }
    const pieces = [], segments = [], blobs = [];
    let expectedSeq = from === undefined ? 1 : from.seq + 1;
    let partial = Buffer.alloc(0), damage, logical = 0;
    let end = from === undefined ? null : { name: from.name, identity: from.identity, offset: from.offset };
    const bound = binding === undefined ? undefined : { ok: true, lines: 0 };
    const refuse = (reason) => { if (bound.ok) { bound.ok = false; bound.reason = reason; } };
    for (let i = index; i < names.length && damage === undefined; i++) {
      const name = names[i];
      const cursor = i === index && from !== undefined;
      const start = cursor ? from.offset : 0;
      let read;
      try { read = await readPrivate(join(replayDir, name), 'session replay segment', { growing: true, start, ...(cursor ? { identity: from.identity } : {}) }); }
      catch (error) { if (error?.code === 'ENOENT') throw changed('session replay segment disappeared while reading'); throw error; }
      if (read === undefined) return { reset: true };
      if (!cursor && segmentSeq(name) !== expectedSeq) { damage = { offset: logical, reason: `replay segment ${name} does not begin at sequence ${expectedSeq}` }; break; }
      // The binding entry this segment must satisfy, if any.
      const sealedEntry = bound !== undefined && i < binding.sealed.length ? binding.sealed[i] : undefined;
      const openEntry = bound !== undefined && i === binding.sealed.length ? binding.open ?? undefined : undefined;
      const entry = sealedEntry ?? openEntry;
      if (entry !== undefined && entry.name !== name) refuse(`replay segment ${entry.name} is missing`);
      const bytes = read.bytes, hash = createHash('sha256');
      let offset = 0, lines = 0, openChecked = false;
      const checkOpen = () => {
        if (openEntry === undefined || openChecked || openEntry.name !== name || start + offset !== openEntry.byteLength) return;
        openChecked = true;
        if (hash.copy().digest('hex') !== openEntry.sha256) refuse(`open replay segment ${name} prefix differs`);
        else bound.lines += lines;
      };
      checkOpen();
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        if (newline < 0) break;
        const line = bytes.subarray(offset, newline + 1);
        let logicalLine = line;
        if (line.subarray(0, REFERENCE_PREFIX.length).equals(REFERENCE_PREFIX)) {
          try {
            const value = JSON.parse(utf8.decode(line.subarray(0, -1)));
            if (!exactKeys(value, ['parts'])) throw invalid('replay reference line');
            const parts = validateParts(value.parts);
            const envelope = await readParts(parts);
            if (envelope.includes(10)) throw invalid('replay reference holds more than one line');
            blobs.push(...parts);
            logicalLine = Buffer.concat([envelope, Buffer.from('\n')]);
          } catch (cause) { damage = { offset: logical, reason: `replay sequence ${expectedSeq} reference is unavailable: ${cause.message}` }; break; }
        }
        hash.update(line); pieces.push(logicalLine); logical += logicalLine.length;
        expectedSeq++; lines++; offset = newline + 1;
        checkOpen();
      }
      if (damage === undefined && offset < bytes.length) {
        if (i === names.length - 1) partial = bytes.subarray(offset);
        else damage = { offset: logical, reason: `sealed replay segment ${name} ends inside a record` };
      }
      const identity = { dev: read.stat.dev, ino: read.stat.ino };
      segments.push({ name, identity, size: start + bytes.length, complete: start + offset, lines, hash });
      if (sealedEntry !== undefined && sealedEntry.name === name) {
        if (start + bytes.length !== sealedEntry.byteLength || offset !== bytes.length || hash.copy().digest('hex') !== sealedEntry.sha256) refuse(`sealed replay segment ${name} differs`);
        else bound.lines += lines;
      }
      if (openEntry !== undefined && openEntry.name === name && !openChecked) refuse(`open replay segment ${name} is shorter than its bound prefix`);
      end = { name, identity, offset: start + offset };
    }
    if (bound !== undefined && segments.length < binding.sealed.length + (binding.open === null ? 0 : 1)) refuse('the bound replay prefix is missing');
    return { absent: false, lines: Buffer.concat(pieces), partial, ...(damage ? { damage } : {}), segments, blobs, end, ...(bound ? { bound } : {}) };
  };

  // The lease writer: constructed from a complete verified read, it repairs
  // an unfinished final line no checkpoint covers, then appends whole lines,
  // each synced before it is acknowledged.
  const createLogWriter = async ({ read, sealedNames = new Set(), boundBytes = 0 }) => {
    if (read.damage !== undefined || read.reset) throw new Error('session replay log is damaged');
    const sealed = [];
    let open = null, handle, directoryCreated = false;
    const referenced = new Set(read.blobs.map(({ sha256: digest }) => digest));
    for (const [index, segment] of read.segments.entries()) {
      const last = index === read.segments.length - 1;
      if (last && read.partial.length > 0) {
        if (segment.complete < boundBytes) throw new Error('session replay prefix bound by its manifest is incomplete');
        await truncate(segment, segment.complete);
      }
      if (!last || sealedNames.has(segment.name) || segment.size >= SEGMENT_SEAL_BYTES) sealed.push({ name: segment.name, byteLength: segment.size, sha256: segment.hash.copy().digest('hex') });
      else open = { name: segment.name, identity: segment.identity, bytes: segment.size, hash: segment.hash };
    }
    const reopen = async () => {
      const path = join(replayDir, open.name);
      const before = await fs.lstat(path);
      if (!sameFileIdentity(before, open.identity) || before.size !== open.bytes) throw new Error('session replay segment changed outside its writer');
      assertPrivateEntry(before, false, 'session replay segment', path);
      const opened = await fs.open(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
      const stat = await opened.stat();
      if (!sameFileIdentity(stat, open.identity) || stat.size !== open.bytes) { await opened.close(); throw new Error('session replay segment changed outside its writer'); }
      handle = opened;
    };
    const startSegment = async (seq) => {
      directoryCreated = (await ensureDirectory(replayDir, 'session replay directory')) || directoryCreated;
      const name = segmentName(seq);
      const path = join(replayDir, name);
      const created = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | NOFOLLOW, 0o600);
      try {
        if (process.platform !== 'win32') await created.chmod(0o600);
        const stat = await created.stat();
        assertPrivateEntry(stat, false, 'session replay segment', path);
        open = { name, identity: { dev: stat.dev, ino: stat.ino }, bytes: 0, hash: createHash('sha256'), created: true };
        handle = created;
      } catch (error) { await created.close(); throw error; }
    };
    const seal = async () => {
      if (open === null) return;
      await handle?.close(); handle = undefined;
      sealed.push({ name: open.name, byteLength: open.bytes, sha256: open.hash.copy().digest('hex') });
      open = null;
    };
    return {
      async append(line, seq) {
        let physical = line;
        if (line.length > MAX_SESSION_FILE_BYTES) {
          const parts = partsOf(line.subarray(0, -1));
          await writeBlobs(parts);
          const references = parts.map((part) => ({ sha256: sha256(part), byteLength: part.length }));
          for (const { sha256: digest } of references) referenced.add(digest);
          physical = Buffer.from(`${JSON.stringify({ parts: references })}\n`);
        }
        if (open !== null && open.bytes + physical.length > MAX_SESSION_FILE_BYTES) await seal();
        if (open === null) await startSegment(seq);
        else if (handle === undefined) await reopen();
        for (let offset = 0; offset < physical.length;) {
          const { bytesWritten } = await handle.write(physical, offset, physical.length - offset, null);
          offset += bytesWritten;
        }
        await handle.sync();
        open.bytes += physical.length; open.hash.update(physical);
        if (open.created) {
          // A new segment's name is durable before its first line is acknowledged.
          await syncDirectory(replayDir, fs);
          if (directoryCreated) { await syncDirectory(sessionsDir, fs); directoryCreated = false; }
          delete open.created;
        }
        if (open.bytes >= SEGMENT_SEAL_BYTES) await seal();
      },
      seal,
      binding: () => ({ sealed: sealed.map((entry) => ({ ...entry })), open: open === null ? null : { name: open.name, byteLength: open.bytes, sha256: open.hash.copy().digest('hex') } }),
      referencedBlobs: () => new Set(referenced),
      async close() { await handle?.close(); handle = undefined; },
    };
  };
  const truncate = async (segment, length) => {
    const path = join(replayDir, segment.name);
    const handle = await fs.open(path, constants.O_RDWR | NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!sameFileIdentity(stat, segment.identity) || stat.size !== segment.size) throw new Error('session replay segment changed before its repair');
      await handle.truncate(length);
      await handle.sync();
      segment.size = length;
    } finally { await handle.close(); }
  };

  // Removes blob parts no reference keeps: the lease holder's settlement
  // cleanup, after the manifest that dropped them is published.
  const removeUnreferencedBlobs = async (referenced) => {
    let names;
    try { await checkDirectory(blobsDir, 'session blob directory'); names = await fs.readdir(blobsDir); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    let removed = false;
    for (const name of names) {
      if (!BLOB_NAME.test(name) || referenced.has(name)) continue;
      const path = join(blobsDir, name);
      assertPrivateEntry(await fs.lstat(path), false, 'session blob', path);
      await fs.unlink(path); removed = true;
    }
    if (removed) await syncDirectory(blobsDir, fs);
  };

  // The physical files of a bundle: the manifest, every segment at the
  // length read, and the blob parts the manifest and log reference.
  const inventory = (manifestBytes, manifestParts, read) => {
    const files = new Map([[`${sessionId}.json`, manifestBytes.length]]);
    for (const segment of read.segments) files.set(`${sessionId}.replay/${segment.name}`, segment.size);
    for (const part of [...manifestParts, ...read.blobs]) files.set(`${sessionId}.blobs/${part.sha256}`, part.byteLength);
    return [...files].map(([path, byteLength]) => ({ path, byteLength }));
  };

  // Deletion under the session's lease: segments and blobs, their
  // directories, then the caller removes the manifest last. A remaining
  // subdirectory or link keeps its directory.
  const remove = async () => {
    for (const [directory, label] of [[replayDir, 'session replay directory'], [blobsDir, 'session blob directory']]) {
      let names;
      try { await checkDirectory(directory, label); names = await fs.readdir(directory); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      for (const name of names) {
        const path = join(directory, name);
        const stat = await fs.lstat(path);
        if (SEGMENT_NAME.test(name) || BLOB_NAME.test(name) || TEMPORARY_NAME.test(name)) assertPrivateEntry(stat, false, 'session file', path);
        else if (!stat.isFile() || stat.isSymbolicLink()) continue;
        await fs.unlink(path);
      }
      try { await fs.rmdir(directory); }
      catch (error) { if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error; }
      await syncDirectory(sessionsDir, fs);
    }
  };

  // Tighten-only permission preparation of the session's own entries.
  const prepare = async () => {
    for (const [directory, pattern] of [[replayDir, SEGMENT_NAME], [blobsDir, BLOB_NAME]]) {
      let before;
      try { before = await fs.lstat(directory); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      await tightenPrivateEntry(directory, before, true, fs, 'session file preparation');
      for (const name of await fs.readdir(directory)) {
        if (!pattern.test(name)) continue;
        const path = join(directory, name);
        await tightenPrivateEntry(path, await fs.lstat(path), false, fs, 'session file preparation');
      }
    }
  };

  // The conversion's bulk writer: exact log bytes as whole-line segments cut
  // by the writer's size rules, each written and synced once. An existing
  // segment with exactly these bytes stays; another one is replaced, since
  // only an interrupted conversion leaves a log beside an earlier format.
  // Returns the binding of the first `boundSeq` lines.
  const writeLog = async (bytes, boundSeq) => {
    const segments = [];
    let current;
    const lineEnds = [];
    for (let offset = 0; offset < bytes.length;) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline + 1;
      let physical = bytes.subarray(offset, end);
      if (physical.length > MAX_SESSION_FILE_BYTES) {
        if (newline < 0) throw new Error('an unfinished replay line exceeds the per-file bound');
        const parts = partsOf(physical.subarray(0, -1));
        await writeBlobs(parts);
        physical = Buffer.from(`${JSON.stringify({ parts: parts.map((part) => ({ sha256: sha256(part), byteLength: part.length })) })}\n`);
      }
      if (current !== undefined && current.length + physical.length > MAX_SESSION_FILE_BYTES) current = undefined;
      if (current === undefined) { current = { name: segmentName(lineEnds.length + 1), pieces: [], length: 0, lines: 0 }; segments.push(current); }
      current.pieces.push(physical); current.length += physical.length;
      if (newline >= 0) { current.lines++; lineEnds.push(true); }
      if (current.length >= SEGMENT_SEAL_BYTES) current = undefined;
      offset = end;
    }
    const created = await ensureDirectory(replayDir, 'session replay directory');
    const existing = new Set((await fs.readdir(replayDir)).filter((name) => SEGMENT_NAME.test(name)));
    for (const name of existing) if (!segments.some((segment) => segment.name === name)) { assertPrivateEntry(await fs.lstat(join(replayDir, name)), false, 'session replay segment', join(replayDir, name)); await fs.unlink(join(replayDir, name)); }
    const binding = { sealed: [], open: null };
    let remaining = boundSeq, bound = false;
    for (const segment of segments) {
      const content = Buffer.concat(segment.pieces);
      const path = join(replayDir, segment.name);
      let same = false;
      if (existing.has(segment.name)) {
        const read = await readPrivate(path, 'session replay segment', { growing: true });
        same = read.bytes.equals(content);
        if (!same) await fs.unlink(path);
      }
      if (!same) {
        const handle = await fs.open(path, 'wx', 0o600);
        try {
          if (process.platform !== 'win32') await handle.chmod(0o600);
          await handle.writeFile(content); await handle.sync();
        } finally { await handle.close(); }
      }
      if (bound) continue;
      if (remaining === 0) { bound = true; continue; }
      if (remaining >= segment.lines && !(remaining === segment.lines && segment === segments.at(-1))) {
        remaining -= segment.lines;
        binding.sealed.push({ name: segment.name, byteLength: content.length, sha256: sha256(content) });
        continue;
      }
      let offset = 0;
      for (; remaining > 0; remaining--) offset = content.indexOf(10, offset) + 1;
      binding.open = { name: segment.name, byteLength: offset, sha256: sha256(content.subarray(0, offset)) };
      bound = true;
    }
    if (remaining > 0) throw new Error('replay log holds fewer lines than its checkpoint');
    await syncDirectory(replayDir, fs);
    if (created) await syncDirectory(sessionsDir, fs);
    return binding;
  };
  // Atomically replaces the manifest file with exact bytes: a synced
  // temporary renamed over it, then the directory synced.
  const replaceManifest = async (bytes) => {
    const temporary = join(sessionsDir, `.${sessionId}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      if (process.platform !== 'win32') await handle.chmod(0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
      await renameWithRetry(temporary, manifestPath, fs);
      await syncDirectory(sessionsDir, fs);
    } finally {
      await handle?.close();
      try { await fs.unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  };

  const hasLog = async () => {
    try { await fs.lstat(replayDir); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  };

  return Object.freeze({
    sessionId, manifestPath, replayDir, blobsDir,
    readManifestFile, decodeManifest, prepareManifest, readLog, createLogWriter, writeLog, replaceManifest,
    removeUnreferencedBlobs, inventory, remove, prepare, hasLog,
  });
}
