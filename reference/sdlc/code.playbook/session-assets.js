// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const DEFAULT_MAX_ASSET_BYTES = 100 * 1024 * 1024;
const ID = /^sha256:([0-9a-f]{64})$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const CHUNK = 64 * 1024;
const noFollow = constants.O_NOFOLLOW ?? 0;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const abort = (signal) => signal?.throwIfAborted();
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validSize(value) { return Number.isSafeInteger(value) && value >= 0; }
function checkedId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('asset ID must be a lowercase SHA-256 content identifier');
  return value.slice(7);
}
export function validateAssetRef(value) {
  if (!object(value) || Object.keys(value).some((key) => !['assetId', 'byteLength', 'mimeType', 'name'].includes(key))) throw new TypeError('invalid asset reference fields');
  checkedId(value.assetId);
  if (!validSize(value.byteLength)) throw new TypeError('asset byte length must be a nonnegative safe integer');
  if (typeof value.mimeType !== 'string' || !MIME.test(value.mimeType)) throw new TypeError('asset MIME type must be a lowercase media type without parameters');
  if (own(value, 'name') && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value.name))) throw new TypeError('asset display name must be nonempty text without control characters');
  return Object.freeze({ assetId: value.assetId, byteLength: value.byteLength, mimeType: value.mimeType, ...(value.name === undefined ? {} : { name: value.name }) });
}
export function validateAssetRefs(value) {
  if (!Array.isArray(value)) throw new TypeError('attachment references must be an array');
  return Object.freeze(value.map(validateAssetRef));
}
export function normalizeSessionTurnInput(value) {
  if (typeof value === 'string') return Object.freeze({ text: value, attachments: Object.freeze([]) });
  if (!object(value) || typeof value.text !== 'string' || Object.keys(value).some((key) => !['text', 'attachments'].includes(key))) throw new TypeError('session input requires exact text and optional attachment references');
  return Object.freeze({ text: value.text, attachments: value.attachments === undefined ? Object.freeze([]) : validateAssetRefs(value.attachments) });
}
export function assetUri(reference) { return `playbook-asset:${validateAssetRef(reference).assetId}`; }
export function parseAssetUri(value) {
  if (typeof value !== 'string' || !value.startsWith('playbook-asset:')) return undefined;
  const id = value.slice('playbook-asset:'.length);
  return ID.test(id) ? id : undefined;
}
/** Persist native media before presentation or replay; no path or Markdown inference. */
export async function externalizeAgentEvent(store, event) {
  if (event?.type === 'media' && event.payload?.source?.type === 'base64') {
    const data = event.payload;
    const encoded = typeof data.source.data === 'string' ? data.source.data.replace(/\s/g, '') : '';
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('native media contained invalid base64');
    const mimeType = typeof data.mimeType === 'string' ? data.mimeType.split(';', 1)[0].trim().toLowerCase() : data.mimeType;
    const asset = await store.importAsset({ bytes: Buffer.from(encoded, 'base64'), mimeType, ...(data.name ? { name: basename(data.name.replace(/\\/g, '/')) } : {}) });
    return { event: { ...event, payload: { ...data, mimeType: asset.mimeType, source: { type: 'uri', uri: assetUri(asset) } } }, asset };
  }
  if (event?.type === 'tool_result') {
    const output = JSON.stringify(event.payload?.output);
    if (output !== undefined && Buffer.byteLength(output) > 4096) {
      const asset = await store.importAsset({ bytes: Buffer.from(output), mimeType: 'application/json', name: 'Tool result' });
      return { event: { ...event, payload: { ...event.payload, output: { type: 'asset_reference', asset } } } };
    }
  }
  return { event };
}
function assertOwner(stat, label) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user`);
}
function assertDirectory(stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('asset owner directory must be a real directory');
  assertOwner(stat, 'asset owner directory');
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) throw new Error('asset owner directory must have private 0700 permissions');
}
function assertFile(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a single-link regular file`);
  assertOwner(stat, label);
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error(`${label} must have private 0600 permissions`);
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | noFollow);
  try { assertDirectory(await handle.stat()); await handle.sync(); } finally { await handle.close(); }
}

/** One immutable owner. A session host holds its ordinary lease around mutations. */
export function createAssetStore(options) {
  if (!object(options) || typeof options.directory !== 'string' || !options.directory || options.directory.includes('\0')) throw new TypeError('asset owner directory must be a nonempty path');
  const directory = resolve(options.directory);
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes <= 0) throw new TypeError('maximum asset bytes must be a positive safe integer');
  let importTail = Promise.resolve();
  const ensureDirectory = async (create) => {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    assertDirectory(await lstat(directory));
  };
  const prepare = async () => {
    let before;
    try { before = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('asset owner directory must be a real directory');
    assertOwner(before, 'asset owner directory');
    if (process.platform !== 'win32' && (before.mode & 0o700) !== 0o700) throw new Error('asset owner directory has insufficient owner permissions');
    const directoryHandle = await open(directory, constants.O_RDONLY | noFollow);
    try {
      const opened = await directoryHandle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('asset owner directory changed during preparation');
      // fchmod always moves ctime, which verified readers pin: change only modes that differ.
      if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o700) await directoryHandle.chmod(0o700);
      for (const name of await readdir(directory)) {
        if (!/^(?:[0-9a-f]{64}(?:\.json)?|\.import-[0-9a-f-]+\.tmp)$/.test(name)) throw new Error('unknown asset owner entry');
        const path = join(directory, name);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('asset entry must be a single-link regular file');
        assertOwner(stat, 'asset entry');
        if (process.platform !== 'win32' && (stat.mode & 0o600) !== 0o600) throw new Error('asset entry has insufficient owner permissions');
        const handle = await open(path, constants.O_RDONLY | noFollow);
        try {
          const pinned = await handle.stat();
          if (!sameFile(stat, pinned)) throw new Error('asset entry changed during preparation');
          if (process.platform !== 'win32' && (pinned.mode & 0o777) !== 0o600) await handle.chmod(0o600);
          assertFile(await handle.stat(), 'asset entry');
          const final = await lstat(path);
          if (final.dev !== pinned.dev || final.ino !== pinned.ino || final.nlink !== 1) throw new Error('asset entry changed during preparation');
        } finally { await handle.close(); }
      }
      const final = await lstat(directory);
      if (final.dev !== opened.dev || final.ino !== opened.ino || final.isSymbolicLink()) throw new Error('asset owner directory changed during preparation');
      assertDirectory(await directoryHandle.stat());
    } finally { await directoryHandle.close(); }
  };
  const checkedOpen = async (filename, label) => {
    await ensureDirectory(false);
    const path = join(directory, filename);
    const before = await lstat(path);
    assertFile(before, label);
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const after = await handle.stat();
      assertFile(after, label);
      if (!sameFile(before, after)) throw new Error(`${label} changed while opening`);
      return { handle, stat: after };
    } catch (error) { await handle.close(); throw error; }
  };
  const describeAsset = async (assetId) => {
    const hash = checkedId(assetId);
    const { handle, stat } = await checkedOpen(`${hash}.json`, 'asset descriptor');
    try {
      if (stat.size > 16 * 1024) throw new Error('asset descriptor is too large');
      const descriptor = validateAssetRef(JSON.parse(await handle.readFile('utf8')));
      if (descriptor.assetId !== assetId) throw new Error('asset descriptor identity does not match its filename');
      if (!sameFile(stat, await handle.stat())) throw new Error('asset descriptor changed while reading');
      return descriptor;
    } finally { await handle.close(); }
  };
  const openAsset = async (value, options = {}) => {
    abort(options.signal);
    const requested = typeof value === 'string' ? undefined : validateAssetRef(value);
    const assetId = requested?.assetId ?? value;
    const hash = checkedId(assetId);
    const descriptor = await describeAsset(assetId);
    const reference = requested ?? descriptor;
    if (reference.byteLength !== descriptor.byteLength) throw new Error('asset reference byte count disagrees with its descriptor');
    if (reference.byteLength > maxAssetBytes) throw new Error(`asset exceeds the ${maxAssetBytes}-byte owner limit`);
    const { handle, stat } = await checkedOpen(hash, 'asset content');
    try {
      if (stat.size !== reference.byteLength) throw new Error('asset byte count does not match its reference');
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(Math.min(CHUNK, stat.size));
      for (let offset = 0; offset < stat.size;) {
        abort(options.signal);
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        if (!bytesRead) throw new Error('asset was truncated while verifying');
        digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (digest.digest('hex') !== hash || !sameFile(stat, await handle.stat())) throw new Error('asset content failed SHA-256 integrity verification');
      abort(options.signal);
    } catch (error) { await handle.close(); throw error; }
    let closed = false;
    let pending = Promise.resolve();
    const enqueue = (operation) => {
      const promise = pending.then(operation);
      pending = promise.then(() => undefined, () => undefined);
      return promise;
    };
    return Object.freeze({
      reference,
      read: (request) => enqueue(async () => {
        if (closed) throw new Error('asset reader is closed');
        if (!object(request) || !validSize(request.offset) || !validSize(request.length) || request.offset > reference.byteLength || request.length > reference.byteLength - request.offset) throw new RangeError('asset read range is outside its content');
        abort(request.signal);
        if (!sameFile(stat, await handle.stat())) throw new Error('asset changed after verification');
        const buffer = Buffer.alloc(request.length);
        for (let read = 0; read < request.length;) {
          abort(request.signal);
          const { bytesRead } = await handle.read(buffer, read, Math.min(CHUNK, request.length - read), request.offset + read);
          if (!bytesRead) throw new Error('asset was truncated while reading');
          read += bytesRead;
        }
        if (!sameFile(stat, await handle.stat())) throw new Error('asset changed while reading');
        abort(request.signal);
        return buffer;
      }),
      close: () => enqueue(async () => { if (!closed) { closed = true; await handle.close(); } }),
    });
  };
  const readAsset = async (reference, options = {}) => {
    const reader = await openAsset(reference, options);
    try { return await reader.read({ offset: 0, length: reader.reference.byteLength, signal: options.signal }); }
    finally { await reader.close(); }
  };
  const publishFile = async (temporary, destination) => {
    try { await link(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await unlink(temporary);
  };
  const importAsset = (input) => {
    // Capture in-memory uploads at admission; caller mutation cannot race hashing
    // or an asynchronous write, including while another import owns the queue.
    try {
      abort(input?.signal);
      if (object(input)) {
        if (input.bytes instanceof Uint8Array && input.bytes.byteLength > maxAssetBytes) throw new Error(`asset exceeds the ${maxAssetBytes}-byte owner limit`);
        input = { ...input, ...(input.bytes instanceof Uint8Array ? { bytes: Buffer.from(input.bytes) } : {}) };
      }
    } catch (error) { return Promise.reject(error); }
    const operation = importTail.then(async () => {
      if (!object(input) || (own(input, 'path') === own(input, 'bytes'))) throw new TypeError('asset import requires exactly one path or byte array');
      const hasPath = own(input, 'path');
      if (hasPath && (typeof input.path !== 'string' || !input.path || input.path.includes('\0'))) throw new TypeError('asset source path must be nonempty');
      if (!hasPath && !(input.bytes instanceof Uint8Array)) throw new TypeError('asset source bytes must be a Uint8Array');
      validateAssetRef({ assetId: `sha256:${'0'.repeat(64)}`, byteLength: 0, mimeType: input.mimeType, ...(input.name === undefined ? {} : { name: input.name }) });
      abort(input.signal);
      let source, sourceStat;
      if (hasPath) {
        const before = await lstat(input.path);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('asset source must be a single-link regular file');
        source = await open(input.path, constants.O_RDONLY | noFollow);
        sourceStat = await source.stat();
        if (!sameFile(before, sourceStat)) { await source.close(); throw new Error('asset source changed while opening'); }
      }
      let temp, metadataTemp, output;
      try {
        const byteLength = hasPath ? sourceStat.size : input.bytes.byteLength;
        if (byteLength > maxAssetBytes) throw new Error(`asset exceeds the ${maxAssetBytes}-byte owner limit`);
        await ensureDirectory(true);
        abort(input.signal);
        temp = join(directory, `.import-${randomUUID()}.tmp`);
        output = await open(temp, 'wx', 0o600);
        const digest = createHash('sha256');
        const buffer = hasPath ? Buffer.alloc(Math.min(CHUNK, byteLength)) : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
        for (let offset = 0; offset < byteLength;) {
          abort(input.signal);
          const bytes = hasPath ? (await source.read(buffer, 0, Math.min(buffer.length, byteLength - offset), offset)).bytesRead : Math.min(CHUNK, byteLength - offset);
          if (!bytes) throw new Error('asset source was truncated while importing');
          const chunk = hasPath ? buffer.subarray(0, bytes) : buffer.subarray(offset, offset + bytes);
          digest.update(chunk);
          await output.writeFile(chunk); offset += bytes;
        }
        if (hasPath && !sameFile(sourceStat, await source.stat())) throw new Error('asset source changed while importing');
        const reference = validateAssetRef({ assetId: `sha256:${digest.digest('hex')}`, byteLength, mimeType: input.mimeType, ...(input.name === undefined ? {} : { name: input.name }) });
        await output.sync(); await output.close(); output = undefined;
        abort(input.signal);
        const hash = checkedId(reference.assetId);
        await publishFile(temp, join(directory, hash)); temp = undefined;
        metadataTemp = join(directory, `.import-${randomUUID()}.tmp`);
        output = await open(metadataTemp, 'wx', 0o600);
        await output.writeFile(`${JSON.stringify(reference)}\n`, 'utf8'); await output.sync(); await output.close(); output = undefined;
        await publishFile(metadataTemp, join(directory, `${hash}.json`)); metadataTemp = undefined;
        await syncDirectory(directory);
        const verified = await openAsset(reference, { signal: input.signal }); await verified.close();
        return reference;
      } finally {
        await source?.close(); await output?.close();
        for (const path of [temp, metadataTemp]) if (path) await unlink(path).catch(() => {});
      }
    });
    importTail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const store = Object.freeze({
    directory, prepare, importAsset, describeAsset, openAsset, readAsset,
    resolveAttachment: async (reference, options = {}) => {
      const reader = await openAsset(reference, options); await reader.close();
      return Object.freeze({ path: join(directory, checkedId(reader.reference.assetId)), mimeType: reader.reference.mimeType });
    },
    copyAsset: async (source, reference, options = {}) => importAsset({ bytes: await source.readAsset(reference, options), mimeType: reference.mimeType, ...(reference.name === undefined ? {} : { name: reference.name }), signal: options.signal }),
    listAssets: async () => {
      try { await ensureDirectory(false); } catch (error) { if (error.code === 'ENOENT') return Object.freeze([]); throw error; }
      const entries = await readdir(directory);
      const result = [];
      for (const name of entries.sort()) {
        if (/^\.import-[0-9a-f-]+\.tmp$/.test(name)) continue;
        if (/^[0-9a-f]{64}\.json$/.test(name)) continue;
        if (!/^[0-9a-f]{64}$/.test(name)) throw new Error(`unknown asset owner entry ${JSON.stringify(basename(name))}`);
        if (!entries.includes(`${name}.json`)) { const orphan = await checkedOpen(name, 'unreferenced asset content'); await orphan.handle.close(); continue; }
        const reader = await openAsset(`sha256:${name}`); await reader.close();
        result.push(Object.freeze({ assetId: reader.reference.assetId, path: name, metadataPath: `${name}.json`, byteLength: reader.reference.byteLength }));
      }
      // A descriptor without its content is corruption, not an empty asset set.
      for (const name of entries.filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry))) if (!entries.includes(name.slice(0, -5))) throw new Error('asset descriptor has no content file');
      return Object.freeze(result);
    },
  });
  return store;
}
