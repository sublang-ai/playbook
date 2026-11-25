// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Test-only semantic fixture construction in the schema-9 layout (DR-111).
// Production readers continue to validate the actual physical files; raw fs
// reads remain available for byte checks. A path may name the session by
// any of its files: `<id>.json`, `<id>.replay.json`, `<id>.records.jsonl`.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createSessionFiles, MAX_SESSION_FILE_BYTES, segmentName } from '../bin/session-files.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function locations(input: string) {
  // A segment path names its session through its replay directory.
  const path = /^[0-9]{12}\.jsonl$/.test(basename(input)) ? dirname(input) : input;
  const id = basename(path).replace(/\.(?:records\.jsonl|replay\.json|replay|json)$/, '');
  if (!UUID.test(id)) throw new Error('fixture path needs a canonical session ID');
  const sessionsDir = dirname(path);
  return { id, sessionsDir, manifest: join(sessionsDir, `${id}.json`), legacy: join(sessionsDir, `${id}.records.jsonl`), replayDir: join(sessionsDir, `${id}.replay`), files: createSessionFiles({ sessionsDir, sessionId: id }) };
}
async function exists(path: string) { try { await fs.lstat(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; } }
async function segments(replayDir: string) {
  if (!await exists(replayDir)) return [];
  const names = (await fs.readdir(replayDir)).filter((name) => /^[0-9]{12}\.jsonl$/.test(name)).sort();
  return Promise.all(names.map(async (name) => ({ name, bytes: await fs.readFile(join(replayDir, name)) })));
}
// The log prefix holding the first `seq` lines: the segments before the
// one it ends in are sealed, that one is open with the bound prefix.
function bindingFor(list: { name: string; bytes: Buffer }[], seq: number) {
  const sealed = [];
  let remaining = seq;
  for (const [index, { name, bytes }] of list.entries()) {
    let offset = 0;
    while (remaining > 0) {
      const newline = bytes.indexOf(10, offset);
      if (newline < 0) break;
      offset = newline + 1; remaining--;
    }
    if (remaining === 0 && (offset < bytes.length || index === list.length - 1 || offset === 0)) {
      return { sealed, open: { name, byteLength: offset, sha256: digest(bytes.subarray(0, offset)) } };
    }
    sealed.push({ name, byteLength: bytes.length, sha256: digest(bytes) });
  }
  if (remaining > 0) throw new Error('fixture replay holds fewer lines than its manifest binds');
  return { sealed, open: null };
}
export async function decodeFixtureManifest(bytes: string | Uint8Array, file: string) {
  const { files } = locations(file);
  return (await files.decodeManifest(Buffer.from(bytes))).manifest;
}
export async function readFixtureManifest(file: string) {
  return decodeFixtureManifest(await fs.readFile(file), file);
}
export async function readFixtureReplay(path: string, encoding?: 'utf8'): Promise<any> {
  const f = locations(path);
  let bytes: Buffer;
  if (await exists(f.replayDir)) { const read = await f.files.readLog(); bytes = Buffer.concat([read.lines, read.partial]); }
  else bytes = await fs.readFile(f.legacy);
  return encoding ? bytes.toString(encoding) : bytes;
}
// Replaces the log with these exact bytes in one segment (or as many as the
// per-file bound needs) and rebinds a published manifest to them.
export async function writeFixtureReplay(path: string, input: string | Uint8Array, _options?: any) {
  const f = locations(path); const bytes = Buffer.from(input);
  if (path.endsWith('.records.jsonl')) return fs.writeFile(f.legacy, bytes, _options ?? { mode: 0o600 });
  await fs.rm(f.replayDir, { recursive: true, force: true });
  await fs.mkdir(f.replayDir, { mode: 0o700 });
  // Whole lines per segment, each within the per-file bound.
  let seq = 1, start = 0;
  do {
    let end = start, lines = 0;
    for (let newline = bytes.indexOf(10, end); newline >= 0 && newline + 1 - start <= MAX_SESSION_FILE_BYTES; newline = bytes.indexOf(10, end)) { end = newline + 1; lines++; }
    if (end === start || bytes.indexOf(10, end) < 0) end = bytes.length;
    if (end - start > MAX_SESSION_FILE_BYTES) throw new Error('fixture replay line exceeds the per-file bound');
    await fs.writeFile(join(f.replayDir, segmentName(seq)), bytes.subarray(start, end), { mode: 0o600 });
    seq += lines; start = end;
  } while (start < bytes.length);
  if (await exists(f.manifest)) {
    try {
      const physical = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
      if (physical.schemaVersion === 9) await writeFixtureFile(f.manifest, `${JSON.stringify((await f.files.decodeManifest(await fs.readFile(f.manifest))).manifest)}\n`, { mode: 0o600 });
    } catch { /* A deliberately unreadable manifest stays as written. */ }
  }
}
export async function removeFixtureReplay(path: string) {
  const f = locations(path);
  await Promise.all([fs.rm(f.replayDir, { recursive: true, force: true }), fs.rm(f.legacy, { force: true })]);
}
// A schema-7 logical manifest becomes a schema-9 manifest binding the
// present log through its checkpoint sequence; anything else is written as given.
export async function writeFixtureFile(path: any, input: any, options?: any) {
  if (typeof path !== 'string' || !UUID.test(basename(path).replace(/\.json$/, '')) || !path.endsWith('.json')) return fs.writeFile(path, input, options);
  const f = locations(path);
  let value;
  try { value = JSON.parse(Buffer.from(input).toString()); } catch { return fs.writeFile(path, input, options); }
  if (typeof value?.schemaVersion === 'number' && value.schemaVersion <= 6 && await exists(f.replayDir)) {
    // A legacy record keeps its replay in the legacy monolithic file.
    await fs.writeFile(f.legacy, await readFixtureReplay(path), { mode: 0o600 });
    await fs.rm(f.replayDir, { recursive: true, force: true });
  }
  if (value?.schemaVersion !== 7) return fs.writeFile(path, input, options);
  const list = await segments(f.replayDir);
  let log;
  try { log = bindingFor(list, value.replay?.seq ?? 0); } catch { log = { sealed: [], open: null }; }
  const encoded = await f.files.prepareManifest(value, log);
  return fs.writeFile(path, encoded.bytes, options);
}
// A portable session for a validated recovery record: its execution context
// as the log's one record, and the schema-9 manifest checkpointing it.
export async function writeRecoveryFixture(sessionsDir: string, recovery: any) {
  const { contextFromRecovery, manifestFromRecovery } = await import('../bin/portable-codec.js');
  const context = contextFromRecovery(recovery);
  context.timestamp = Date.parse(recovery.updatedAt);
  const stream = `${JSON.stringify({ v: 1, seq: 1, record: context })}\n`;
  await writeFixtureReplay(join(sessionsDir, `${recovery.sessionId}.replay.json`), stream);
  const manifest = manifestFromRecovery(recovery, { seq: 1, sha256: digest(Buffer.from(stream)), incomplete: false }, 1);
  const path = join(sessionsDir, `${recovery.sessionId}.json`);
  await writeFixtureFile(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return path;
}
