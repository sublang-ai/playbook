// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-111: converts sessions saved in the schema-7 monolithic and schema-8
// chunked formats to schema 9. It runs by hand through `playbook sessions
// upgrade`; the store never loads it. It keeps read-only decoders for the two
// earlier formats and writes through the schema-9 file layer.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as nativeFs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertPrivateEntry, mkdirPrivate, renameWithRetry, sameFileIdentity, syncDirectory, tightenPrivateEntry } from './private-paths.js';
import { createSessionFiles, SESSION_STORAGE_VERSION } from './session-files.js';
import { validateSessionHints, validateSessionManifest } from './portable-codec.js';
import { createCaptainSessionStore, SESSION_ID_PATTERN } from './session-store.js';

const ROOT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.legacy-sessions']);
export const LEGACY_DIRECTORY = '.legacy-sessions';
const LEGACY_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const parseJson = (bytes) => JSON.parse(utf8.decode(bytes));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const message = (error) => (error instanceof Error ? error.message : String(error));
function corrupt(what) { return new Error(`former session storage is invalid: ${what}`); }

// A sessions directory is one named `sessions` holding a session root.
// The walk follows no link and skips Git, package and backup directories.
export async function findSessionsDirectories(root, { fsOps } = {}) {
  const fs = { ...nativeFs, ...fsOps };
  const found = [];
  const visit = async (directory) => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error?.code)) return; throw error; }
    if (basename(directory) === 'sessions' && entries.some((entry) => entry.isFile() && ROOT_NAME.test(entry.name))) {
      found.push(directory);
      return;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIPPED_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name));
    }
  };
  await visit(root);
  return found;
}

// Read-only decoders of the schema-8 chunk codec (session-persistence-11 of
// that format): byte leaves and indexes, tagged JSON nodes, references.
function legacyChunks(directory, fs) {
  const reference = (value) => {
    if (!object(value) || Object.keys(value).length !== 2 || !own(value, 'sha256') || !own(value, 'byteLength') ||
        !DIGEST.test(value.sha256) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 ||
        value.byteLength > LEGACY_MAX_CHUNK_BYTES) throw corrupt('chunk reference');
    return value;
  };
  const files = new Map();
  const readNode = async (ref) => {
    reference(ref);
    const bytes = await readPrivateFile(join(directory, ref.sha256), 'former session chunk', fs);
    if (bytes.length !== ref.byteLength || sha256(bytes) !== ref.sha256) throw corrupt(`chunk ${ref.sha256} differs from its reference`);
    files.set(ref.sha256, bytes.length);
    return bytes;
  };
  const readBytes = async (ref, depth = 0) => {
    if (depth > 512) throw corrupt('byte index depth');
    const bytes = await readNode(ref);
    if (bytes[0] === 0) return bytes.subarray(1);
    if (bytes[0] !== 1) throw corrupt('byte node tag');
    const children = parseJson(bytes.subarray(1));
    if (!Array.isArray(children) || children.length === 0 || children.length > 1024) throw corrupt('byte index');
    const pieces = [];
    for (const child of children) pieces.push(await readBytes(child, depth + 1));
    return Buffer.concat(pieces);
  };
  const decode = async (node, depth) => {
    if (depth > 2048 || !Array.isArray(node) || node.length !== 2) throw corrupt('tagged JSON');
    const [kind, value] = node;
    if (kind === 'v') {
      if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) throw corrupt('tagged scalar');
      return value;
    }
    if (kind === 'r') return readJson(value, depth + 1);
    if (kind === 's') { const result = parseJson(await readBytes(value)); if (typeof result !== 'string') throw corrupt('tagged string'); return result; }
    if ((kind !== 'a' && kind !== 'o') || !Array.isArray(value)) throw corrupt('tagged structure');
    const result = kind === 'a' ? [] : {};
    for (const entry of value) {
      if (kind === 'a') { result.push(await decode(entry, depth + 1)); continue; }
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || own(result, entry[0])) throw corrupt('tagged object entry');
      Object.defineProperty(result, entry[0], { value: await decode(entry[1], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  const readJson = async (ref, depth = 0) => {
    if (depth > 2048) throw corrupt('tagged JSON depth');
    const bytes = await readNode(ref);
    if (bytes[0] === 2) return decode(parseJson(bytes.subarray(1)), depth + 1);
    if (bytes[0] !== 3) throw corrupt('JSON node tag');
    return decode(parseJson(await readBytes(reference(parseJson(bytes.subarray(1))))), depth + 1);
  };
  return { readJson, readBytes, reference, files };
}

async function readPrivateFile(path, label, fs) {
  const before = await fs.lstat(path);
  assertPrivateEntry(before, false, label, path);
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened) || opened.size !== before.size) throw new Error(`${label} changed while opening`);
    const bytes = await handle.readFile();
    if ((await handle.stat()).size !== bytes.length) throw new Error(`${label} changed while reading`);
    return bytes;
  } finally { await handle.close(); }
}
async function exists(path, fs) {
  try { await fs.lstat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

// The complete former representation, verified: its logical manifest, the
// exact replay bytes and the files that hold them.
async function readFormerSession(sessionsDir, sessionId, rootBytes, fs) {
  const stored = parseJson(rootBytes);
  if (stored?.schemaVersion === 7) {
    const manifest = validateSessionManifest(stored);
    if (manifest.sessionId !== sessionId) throw corrupt('manifest identity');
    const replayPath = join(sessionsDir, `${sessionId}.records.jsonl`);
    const replay = (await exists(replayPath, fs)) ? await readPrivateFile(replayPath, 'former session replay', fs) : Buffer.alloc(0);
    return { format: 7, manifest, replay, files: [`${sessionId}.json`, ...((await exists(replayPath, fs)) ? [`${sessionId}.records.jsonl`] : [])] };
  }
  const fields = ['schemaVersion', 'kind', 'sessionId', 'cwd', 'state', 'createdAt', 'updatedAt', 'root'];
  if (!object(stored) || Object.keys(stored).length !== fields.length || fields.some((key) => !own(stored, key)) ||
      stored.kind !== 'captain-session-storage' || stored.sessionId !== sessionId) throw corrupt('bounded root');
  const chunks = legacyChunks(join(sessionsDir, `${sessionId}.chunks`), fs);
  const manifest = validateSessionManifest(await chunks.readJson(chunks.reference(stored.root)));
  if (['sessionId', 'cwd', 'state', 'createdAt', 'updatedAt'].some((key) => manifest[key] !== stored[key])) throw corrupt('bounded summary differs from its manifest');
  const replayRootPath = join(sessionsDir, `${sessionId}.replay.json`);
  let replay = Buffer.alloc(0);
  if (await exists(replayRootPath, fs)) {
    const root = parseJson(await readPrivateFile(replayRootPath, 'former replay root', fs));
    if (!object(root) || Object.keys(root).length !== 5 || root.kind !== 'captain-session-replay' || root.schemaVersion !== 1 ||
        root.sessionId !== sessionId || !Number.isSafeInteger(root.byteLength) || root.byteLength < 0 ||
        (root.head === null) !== (root.byteLength === 0)) throw corrupt('replay root');
    const pieces = [];
    let ref = root.head, total = root.byteLength;
    const seen = new Set();
    while (ref !== null) {
      chunks.reference(ref);
      if (seen.has(ref.sha256)) throw corrupt('replay chain cycle');
      seen.add(ref.sha256);
      const node = await chunks.readJson(ref);
      if (!object(node) || Object.keys(node).length !== 4 || !Number.isSafeInteger(node.byteLength) || node.byteLength < 1 ||
          node.totalBytes !== total || node.byteLength > total) throw corrupt('replay chain node');
      const bytes = await chunks.readBytes(chunks.reference(node.content));
      if (bytes.length !== node.byteLength) throw corrupt('replay chain content length');
      pieces.push(bytes);
      total -= node.byteLength;
      ref = node.previous;
    }
    if (total !== 0) throw corrupt('replay chain length');
    replay = Buffer.concat(pieces.reverse());
  } else if (manifest.replay.seq > 0) throw corrupt('replay root is missing');
  const files = [`${sessionId}.json`, ...((await exists(replayRootPath, fs)) ? [`${sessionId}.replay.json`] : []),
    ...((await exists(join(sessionsDir, `${sessionId}.chunks`), fs)) ? [`${sessionId}.chunks`] : [])];
  return { format: 8, manifest, replay, files };
}

// The checkpoint's replay prefix must be the exact bytes its digest names.
function checkpointPrefix(replay, seq) {
  let end = 0;
  for (let index = 0; index < seq; index++) {
    const newline = replay.indexOf(10, end);
    if (newline < 0) throw corrupt('replay holds fewer records than its checkpoint');
    end = newline + 1;
  }
  return replay.subarray(0, end);
}

// Tighten-only preparation of the former files, as opening them did.
async function prepareFormerFiles(sessionsDir, sessionId, fs) {
  const tighten = async (path, directory) => {
    let stat;
    try { stat = await fs.lstat(path); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
    await tightenPrivateEntry(path, stat, directory, fs, 'former session preparation');
    return true;
  };
  for (const suffix of ['.json', '.records.jsonl', '.replay.json', '.hints.json']) await tighten(join(sessionsDir, `${sessionId}${suffix}`), false);
  const chunks = join(sessionsDir, `${sessionId}.chunks`);
  if (await tighten(chunks, true)) {
    for (const name of await fs.readdir(chunks)) if (DIGEST.test(name)) await tighten(join(chunks, name), false);
  }
}

async function ensurePrivateDirectory(path, fs) {
  try { await mkdirPrivate(path, fs); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(path);
  assertPrivateEntry(stat, true, 'former session backup directory', path);
}
async function writePrivateBytes(path, bytes, fs) {
  const temporary = `${path}.tmp`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try {
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle.close(); }
  await renameWithRetry(temporary, path, fs);
  await syncDirectory(dirname(path), fs);
}

// Rebinds the provider hints of the former root to the new manifest; hints
// that do not match it are left as they are and start fresh conversations.
async function rebindHints(sessionsDir, sessionId, formerRoot, manifest, nextManifestBytes, fs) {
  const path = join(sessionsDir, `${sessionId}.hints.json`);
  let hints;
  try { hints = validateSessionHints(parseJson(await readPrivateFile(path, 'session hints', fs)), formerRoot, manifest); }
  catch { return false; }
  await writePrivateBytes(path, Buffer.from(`${JSON.stringify({ ...hints, checkpointSha256: sha256(nextManifestBytes) })}\n`), fs);
  return true;
}

// Moves the former files beside the backup of the former root; a name
// already moved is done.
async function retireFormerFiles(sessionsDir, sessionId, backup, fs) {
  let moved = false;
  for (const name of [`${sessionId}.records.jsonl`, `${sessionId}.replay.json`, `${sessionId}.chunks`]) {
    const source = join(sessionsDir, name);
    if (!(await exists(source, fs))) continue;
    const target = join(backup, name);
    if (await exists(target, fs)) throw new Error(`backup already holds ${name}`);
    await fs.rename(source, target);
    moved = true;
  }
  if (moved) { await syncDirectory(sessionsDir, fs); await syncDirectory(backup, fs); }
}

async function readReceipt(path, fs) {
  try { return parseJson(await readPrivateFile(path, 'conversion receipt', fs)); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

// Converts one session: verifies the former representation completely,
// writes schema 9 under the session's lease, switches only after the new
// manifest's logical content, the exact replay bytes and the replay digest
// equal the former ones, then retires the former files to the backup.
async function convertSession({ sessionsDir, sessionId, store, fs, dryRun }) {
  const files = createSessionFiles({ sessionsDir, sessionId, fsOps: fs });
  const backup = join(dirname(sessionsDir), LEGACY_DIRECTORY, sessionId);
  const receiptPath = join(backup, 'receipt.json');
  const rootPath = join(sessionsDir, `${sessionId}.json`);
  // Classification only reads the root: a checkout may have left it with
  // wider permissions, which preparation under the lease tightens before
  // any read that authorizes a write.
  let rootBytes;
  try {
    const stat = await fs.lstat(rootPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('session root is not a regular file');
    rootBytes = await fs.readFile(rootPath);
  } catch (error) { return { sessionId, outcome: 'failed', reason: message(error) }; }
  let schemaVersion;
  try { schemaVersion = parseJson(rootBytes)?.schemaVersion; } catch { schemaVersion = undefined; }
  const result = (outcome, reason) => ({ sessionId, format: schemaVersion, outcome, ...(reason === undefined ? {} : { reason }) });
  let resuming = false;
  if (schemaVersion === SESSION_STORAGE_VERSION) {
    const receipt = await readReceipt(receiptPath, fs).catch(() => undefined);
    if (receipt?.complete !== false || receipt.manifestSha256 !== sha256(rootBytes)) return result('skipped', 'already schema 9');
    resuming = true;
  } else if (schemaVersion !== 7 && schemaVersion !== 8) {
    return result('skipped', `unknown format${schemaVersion === undefined ? '' : ` (schema ${schemaVersion})`}`);
  }
  if (dryRun) {
    const state = await store.readLeaseState(sessionId);
    return state === 'idle' ? result(resuming ? 'would-finish' : 'would-convert') : result('skipped', `held by a lease (${state})`);
  }
  let lease;
  try { lease = await store.acquireManagement(sessionId); }
  catch (error) {
    if (error?.code === 'PLAYBOOK_SESSION_LEASE_ACTIVE') return result('skipped', 'held by a lease');
    return result('failed', message(error));
  }
  let outcome;
  try {
    await lease.assertOwner();
    if (resuming) {
      const receipt = await readReceipt(receiptPath, fs);
      const formerRoot = await readPrivateFile(join(backup, `${sessionId}.json`), 'former session root', fs);
      if (sha256(formerRoot) !== receipt.formerRootSha256) throw new Error('backup of the former root differs from its receipt');
      const current = await readPrivateFile(rootPath, 'session root', fs);
      if (sha256(current) !== receipt.manifestSha256) throw new Error('session changed after its conversion switched');
      await retireFormerFiles(sessionsDir, sessionId, backup, fs);
      const manifest = (await files.decodeManifest(current)).manifest;
      await rebindHints(sessionsDir, sessionId, formerRoot, manifest, current, fs);
      await writePrivateBytes(receiptPath, Buffer.from(`${JSON.stringify({ ...receipt, complete: true })}\n`), fs);
      outcome = result('converted', 'finished an interrupted conversion');
    } else {
      await prepareFormerFiles(sessionsDir, sessionId, fs);
      // Reread under the lease: only this read may authorize writes.
      const formerRoot = await readPrivateFile(rootPath, 'session root', fs);
      const former = await readFormerSession(sessionsDir, sessionId, formerRoot, fs);
      const prefix = checkpointPrefix(former.replay, former.manifest.replay.seq);
      if (sha256(prefix) !== former.manifest.replay.sha256) throw corrupt('replay checkpoint digest differs');
      const receipt = await readReceipt(receiptPath, fs);
      if (receipt !== undefined && receipt.complete !== false) throw new Error(`${LEGACY_DIRECTORY}/${sessionId} already holds a completed conversion; move it aside to convert again`);
      // Write and verify the new representation before anything switches.
      const binding = await files.writeLog(former.replay, former.manifest.replay.seq);
      const { bytes } = await files.prepareManifest(former.manifest, binding);
      const decoded = await files.decodeManifest(bytes);
      const read = await files.readLog({ binding: decoded.log });
      const logical = Buffer.concat([read.lines, read.partial]);
      if (!isDeepStrictEqual(decoded.manifest, former.manifest) || read.damage !== undefined || !read.bound.ok ||
          read.bound.lines !== former.manifest.replay.seq || !logical.equals(former.replay) ||
          sha256(checkpointPrefix(read.lines, former.manifest.replay.seq)) !== former.manifest.replay.sha256) {
        throw new Error('converted session differs from its former representation');
      }
      await ensurePrivateDirectory(dirname(backup), fs);
      await ensurePrivateDirectory(backup, fs);
      await writePrivateBytes(join(backup, `${sessionId}.json`), formerRoot, fs);
      await writePrivateBytes(receiptPath, Buffer.from(`${JSON.stringify({ v: 1, sessionId, formerSchema: former.format, formerRootSha256: sha256(formerRoot), manifestSha256: sha256(bytes), complete: false })}\n`), fs);
      await lease.assertOwner();
      if (!(await readPrivateFile(rootPath, 'session root', fs)).equals(formerRoot)) throw new Error('session changed during its conversion');
      await files.replaceManifest(bytes);
      await retireFormerFiles(sessionsDir, sessionId, backup, fs);
      await rebindHints(sessionsDir, sessionId, formerRoot, former.manifest, bytes, fs);
      await writePrivateBytes(receiptPath, Buffer.from(`${JSON.stringify({ v: 1, sessionId, formerSchema: former.format, formerRootSha256: sha256(formerRoot), manifestSha256: sha256(bytes), complete: true })}\n`), fs);
      outcome = result('converted');
    }
  } catch (error) {
    outcome = result('failed', message(error));
  }
  try { await lease.release(); }
  catch (error) { outcome = result('failed', `${outcome.reason ? `${outcome.reason}; ` : ''}lease release failed: ${message(error)}`); }
  return outcome;
}

// Converts every session in one sessions directory, or with `recursive`, in
// every sessions directory under `root`. Each session's outcome is reported.
export async function upgradeSessions({ root, recursive = false, dryRun = false, fsOps, storeOptions = {} }) {
  const fs = { ...nativeFs, ...fsOps };
  const directories = recursive ? await findSessionsDirectories(root, { fsOps }) : [root];
  const results = [];
  for (const sessionsDir of directories) {
    let names;
    try { names = await fs.readdir(sessionsDir); }
    catch (error) { results.push({ directory: sessionsDir, sessions: [], error: message(error) }); continue; }
    const store = createCaptainSessionStore({ sessionsDir, createSessionsDir: false, fsOps, ...storeOptions });
    const sessions = [];
    for (const name of names.sort()) {
      const match = ROOT_NAME.exec(name);
      if (!match || !SESSION_ID_PATTERN.test(match[1])) continue;
      sessions.push(await convertSession({ sessionsDir, sessionId: match[1], store, fs, dryRun }));
    }
    results.push({ directory: sessionsDir, sessions });
  }
  return results;
}

// The command's report: each directory, each session's outcome, and totals.
export function formatUpgradeReport(results, { dryRun = false } = {}) {
  const lines = [];
  const totals = { converted: 0, planned: 0, skipped: 0, failed: 0 };
  for (const { directory, sessions, error } of results) {
    lines.push(directory);
    if (error !== undefined) { lines.push(`  failed: ${error}`); totals.failed++; continue; }
    if (sessions.length === 0) lines.push('  no sessions');
    for (const session of sessions) {
      const outcome = { 'would-convert': 'would convert', 'would-finish': 'would finish an interrupted conversion' }[session.outcome] ?? session.outcome;
      const format = session.format === undefined ? '' : ` schema ${session.format}`;
      lines.push(`  ${session.sessionId}${format}: ${outcome}${session.reason === undefined ? '' : ` (${session.reason})`}`);
      if (session.outcome === 'converted') totals.converted++;
      else if (session.outcome.startsWith('would-')) totals.planned++;
      else if (session.outcome === 'failed') totals.failed++;
      else totals.skipped++;
    }
  }
  if (results.length === 0) lines.push('no sessions directory found');
  lines.push(dryRun
    ? `would convert ${totals.planned}, skipped ${totals.skipped}, failed ${totals.failed}`
    : `converted ${totals.converted}, skipped ${totals.skipped}, failed ${totals.failed}`);
  return { text: `${lines.join('\n')}\n`, failed: totals.failed };
}
