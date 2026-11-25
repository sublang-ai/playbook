// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-111: converts sessions saved in the schema-7 monolithic and schema-8
// chunked formats to schema 9. It runs by hand through `playbook sessions
// upgrade`; the store never loads it. It keeps read-only decoders for the two
// earlier formats and writes through the schema-9 file layer.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as nativeFs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertPrivateEntry, mkdirPrivate, needsTightening, renameWithRetry, sameFileIdentity, syncDirectory, tightenPrivateEntry, verifyPrivateEntry } from './private-paths.js';
import { createSessionFiles, SESSION_STORAGE_VERSION } from './session-files.js';
import { validateSessionHints, validateSessionManifest } from './portable-codec.js';
import { createCaptainSessionStore, parseSessionHistory, SESSION_ID_PATTERN, validateSessionHistory } from './session-store.js';

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
    try {
      // Check the supplied root too: readdir follows a directory link.
      if (!(await fs.lstat(directory)).isDirectory() || SKIPPED_DIRECTORIES.has(basename(directory))) return;
      entries = await fs.readdir(directory, { withFileTypes: true });
    }
    catch (error) { if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error?.code)) return; throw error; }
    if (basename(directory) === 'sessions' && entries.some((entry) => entry.isFile() && ROOT_NAME.test(entry.name))) {
      found.push(directory);
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
  const readNode = async (ref) => {
    reference(ref);
    const bytes = await readPrivateFile(join(directory, ref.sha256), 'former session chunk', fs);
    if (bytes.length !== ref.byteLength || sha256(bytes) !== ref.sha256) throw corrupt(`chunk ${ref.sha256} differs from its reference`);
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
  return { readJson, readBytes, reference };
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
// exact replay bytes.
async function readFormerSession(sessionsDir, sessionId, rootBytes, fs) {
  const stored = parseJson(rootBytes);
  if (stored?.schemaVersion === 7) {
    const manifest = validateSessionManifest(stored);
    if (manifest.sessionId !== sessionId) throw corrupt('manifest identity');
    const replayPath = join(sessionsDir, `${sessionId}.records.jsonl`);
    const replay = (await exists(replayPath, fs)) ? await readPrivateFile(replayPath, 'former session replay', fs) : Buffer.alloc(0);
    return { format: 7, manifest, replay };
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
  return { format: 8, manifest, replay };
}

// Tighten-only preparation of the former files, as opening them did. Only
// an entry with excess POSIX bits is opened to tighten it; every file is
// admitted again when it is read, and on Windows nothing is tightened, so
// there a file costs no descriptor read here.
async function prepareFormerFiles(sessionsDir, sessionId, fs) {
  const tighten = async (path, directory) => {
    let stat;
    try { stat = await fs.lstat(path); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
    if (needsTightening(stat, directory)) await tightenPrivateEntry(path, stat, directory, fs, 'former session preparation');
    else if (directory) assertPrivateEntry(stat, true, 'former session preparation', path);
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
  await syncDirectory(dirname(path), fs);
}
async function writePrivateBytes(path, bytes, fs) {
  const directory = dirname(path);
  assertPrivateEntry(await fs.lstat(directory), true, 'conversion directory', directory);
  if (await exists(path, fs)) assertPrivateEntry(await fs.lstat(path), false, 'conversion file', path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      if (process.platform !== 'win32') await handle.chmod(0o600);
      assertPrivateEntry(await handle.stat(), false, 'conversion temporary', temporary);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await renameWithRetry(temporary, path, fs);
    await syncDirectory(directory, fs);
  } finally {
    try { await fs.unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

// Rebinds the provider hints of the former root to the new manifest; hints
// that do not match it are left as they are and start fresh conversations.
async function rebindHints(sessionsDir, sessionId, formerRoot, manifest, nextManifestBytes, fs) {
  const path = join(sessionsDir, `${sessionId}.hints.json`);
  let bytes;
  try { bytes = await readPrivateFile(path, 'session hints', fs); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  let hints;
  try { hints = validateSessionHints(parseJson(bytes), formerRoot, manifest); }
  catch { return false; }
  await writePrivateBytes(path, Buffer.from(`${JSON.stringify({ ...hints, checkpointSha256: sha256(nextManifestBytes) })}\n`), fs);
  return true;
}

function formerSidecars(sessionId, format) {
  return format === 7 ? [`${sessionId}.records.jsonl`] : [`${sessionId}.replay.json`, `${sessionId}.chunks`];
}

// Moves the former files beside the saved root. A sidecar already moved is done.
async function retireFormerFiles(sessionsDir, sessionId, format, backup, fs) {
  for (const name of formerSidecars(sessionId, format)) {
    const source = join(sessionsDir, name);
    if (!(await exists(source, fs))) continue;
    assertPrivateEntry(await fs.lstat(source), name.endsWith('.chunks'), 'former session entry', source);
    const target = join(backup, name);
    if (await exists(target, fs)) throw new Error(`backup already holds ${name}`);
    await fs.rename(source, target);
  }
  // Also make a previous run's last rename durable before completing its receipt.
  await syncDirectory(sessionsDir, fs);
  await syncDirectory(backup, fs);
}

async function readReceipt(path, fs) {
  try {
    const backup = dirname(path);
    for (const directory of [dirname(backup), backup]) {
      assertPrivateEntry(await fs.lstat(directory), true, 'former session backup directory', directory);
    }
    const receipt = parseJson(await readPrivateFile(path, 'conversion receipt', fs));
    if (receipt?.v !== 1 || receipt.sessionId !== basename(backup) || ![7, 8].includes(receipt.formerSchema) ||
        !DIGEST.test(receipt.formerRootSha256) || !DIGEST.test(receipt.manifestSha256) || typeof receipt.complete !== 'boolean') {
      throw new Error('invalid conversion receipt');
    }
    return receipt;
  }
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
    let receipt;
    try { receipt = await readReceipt(receiptPath, fs); }
    catch (error) { return result('failed', message(error)); }
    if (receipt?.complete !== false) return result('skipped', 'already schema 9');
    if (receipt.manifestSha256 !== sha256(rootBytes)) return result('failed', 'session changed after its conversion switched');
    resuming = true;
  } else if (schemaVersion !== 7 && schemaVersion !== 8) {
    return result('skipped', `unknown format${schemaVersion === undefined ? '' : ` (schema ${schemaVersion})`}`);
  }
  if (dryRun) {
    let state = await store.readLeaseState(sessionId);
    if (state === 'unknown') {
      // A checkout's owner-accessible directory may need tightening before
      // the strict store can inspect it. Preview an absent lease without chmod.
      try {
        verifyPrivateEntry(await fs.lstat(sessionsDir), true, 'sessions directory', process.getuid?.(), sessionsDir);
        if (!(await exists(join(sessionsDir, `.${sessionId}.lock`), fs))) state = 'idle';
      } catch (error) { return result('failed', message(error)); }
    }
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
      await retireFormerFiles(sessionsDir, sessionId, receipt.formerSchema, backup, fs);
      const manifest = (await files.decodeManifest(current)).manifest;
      await rebindHints(sessionsDir, sessionId, formerRoot, manifest, current, fs);
      await writePrivateBytes(receiptPath, Buffer.from(`${JSON.stringify({ ...receipt, complete: true })}\n`), fs);
      outcome = result('converted', 'finished an interrupted conversion');
    } else {
      await prepareFormerFiles(sessionsDir, sessionId, fs);
      // Reread under the lease: only this read may authorize writes.
      const formerRoot = await readPrivateFile(rootPath, 'session root', fs);
      const former = await readFormerSession(sessionsDir, sessionId, formerRoot, fs);
      const history = parseSessionHistory(former.replay);
      if (history.damage) throw corrupt(history.damage.reason);
      if (history.digests[former.manifest.replay.seq] !== former.manifest.replay.sha256) throw corrupt('replay checkpoint digest differs');
      const receipt = await readReceipt(receiptPath, fs);
      if (receipt !== undefined && receipt.complete !== false) throw new Error(`${LEGACY_DIRECTORY}/${sessionId} already holds a completed conversion; move it aside to convert again`);
      if (receipt && receipt.formerRootSha256 !== sha256(formerRoot)) throw new Error('backup belongs to a different former root');
      // Write and verify the new representation before anything switches.
      const binding = await files.writeLog(former.replay, former.manifest.replay.seq);
      const { bytes } = await files.prepareManifest(former.manifest, binding);
      const decoded = await files.decodeManifest(bytes);
      const read = await files.readLog({ binding: decoded.log });
      const logical = Buffer.concat([read.lines, read.partial]);
      if (!isDeepStrictEqual(decoded.manifest, former.manifest) || read.damage !== undefined || !read.bound.ok ||
          !logical.equals(former.replay)) {
        throw new Error('converted session differs from its former representation');
      }
      const validation = await validateSessionHistory({
        sessionId, manifest: decoded.manifest, history: { ...history, missing: read.absent, bound: read.bound },
        openAsset: (reference) => store.openAsset(sessionId, reference),
      });
      if (!validation.integrityValid) throw corrupt(validation.reasons.join('; '));
      await ensurePrivateDirectory(dirname(backup), fs);
      await ensurePrivateDirectory(backup, fs);
      // Before cutover none of this session's sidecars have moved. A collision
      // here would leave retirement permanently blocked after the switch.
      for (const name of formerSidecars(sessionId, former.format)) {
        if (await exists(join(backup, name), fs)) throw new Error(`backup already holds ${name}`);
      }
      const backupRoot = join(backup, `${sessionId}.json`);
      if (await exists(backupRoot, fs)) {
        if (!(await readPrivateFile(backupRoot, 'former session backup', fs)).equals(formerRoot)) throw new Error('backup belongs to a different former root');
      } else {
        await writePrivateBytes(backupRoot, formerRoot, fs);
      }
      await writePrivateBytes(receiptPath, Buffer.from(`${JSON.stringify({ v: 1, sessionId, formerSchema: former.format, formerRootSha256: sha256(formerRoot), manifestSha256: sha256(bytes), complete: false })}\n`), fs);
      await lease.assertOwner();
      if (!(await readPrivateFile(rootPath, 'session root', fs)).equals(formerRoot)) throw new Error('session changed during its conversion');
      await files.replaceManifest(bytes);
      await retireFormerFiles(sessionsDir, sessionId, former.format, backup, fs);
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
