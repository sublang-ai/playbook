// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Test-only semantic fixture construction. Production readers continue to
// validate actual physical roots; raw fs reads remain available for byte checks.
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createSessionChunks } from '../bin/session-chunks.js';
import { createBoundedReplay } from '../bin/session-replay.js';
import { decodeStoredManifest, encodeStoredManifest } from '../bin/storage-manifest.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function locations(path: string) {
  const id = basename(path).replace(/\.(?:records\.jsonl|replay\.json|json)$/, '');
  if (!UUID.test(id)) throw new Error('fixture path needs a canonical session ID');
  const sessionsDir = dirname(path);
  return { id, sessionsDir, manifest: join(sessionsDir, `${id}.json`), legacy: join(sessionsDir, `${id}.records.jsonl`), replay: join(sessionsDir, `${id}.replay.json`), chunks: createSessionChunks({ directory: join(sessionsDir, `${id}.chunks`) }) };
}
async function exists(path: string) { try { await fs.lstat(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; } }
export async function decodeFixtureManifest(bytes: string | Uint8Array, file: string) {
  const { id, chunks } = locations(file);
  return decodeStoredManifest(Buffer.from(bytes).toString('utf8'), chunks, id);
}
export async function readFixtureManifest(file: string) {
  return decodeFixtureManifest(await fs.readFile(file), file);
}
export async function readFixtureReplay(path: string, encoding?: 'utf8'): Promise<any> {
  const f = locations(path);
  let bytes: Buffer;
  if (await exists(f.replay)) bytes = await (await createBoundedReplay({sessionId:f.id,sessionsDir:f.sessionsDir,chunks:f.chunks})).readBytes();
  else bytes = await fs.readFile(f.legacy);
  return encoding ? bytes.toString(encoding) : bytes;
}
export async function writeFixtureReplay(path: string, input: string | Uint8Array, _options?: any) {
  const f = locations(path); const bytes = Buffer.from(input);
  if (path.endsWith('.records.jsonl')) return fs.writeFile(f.legacy,bytes,_options ?? {mode:0o600});
  let legacy = false;
  try { legacy = JSON.parse(await fs.readFile(f.manifest,'utf8')).schemaVersion <= 6 && !await exists(f.replay); } catch { /* Stream-only fixtures use bounded roots. */ }
  if (legacy) { await fs.writeFile(f.legacy,bytes,{mode:0o600}); return; }
  const replay = await createBoundedReplay({sessionId:f.id,sessionsDir:f.sessionsDir,chunks:f.chunks});
  await replay.deleteRoot(); await replay.initializeBytes(bytes);
}
export async function removeFixtureReplay(path: string) {
  const f = locations(path);
  await Promise.all([fs.rm(f.replay,{force:true}),fs.rm(f.legacy,{force:true})]);
}
export async function writeFixtureFile(path: any, input: any, options?: any) {
  if (typeof path !== 'string' || !UUID.test(basename(path).replace(/\.json$/, '')) || !path.endsWith('.json')) return fs.writeFile(path,input,options);
  const f = locations(path);
  let value;
  try { value=JSON.parse(Buffer.from(input).toString()); } catch { return fs.writeFile(path,input,options); }
  if (value.schemaVersion === 7) return fs.writeFile(path,await encodeStoredManifest(value,f.chunks),options);
  if (value.schemaVersion <= 6 && await exists(f.replay)) {
    const replay = await createBoundedReplay({sessionId:f.id,sessionsDir:f.sessionsDir,chunks:f.chunks});
    await fs.writeFile(f.legacy,await replay.readBytes(),{mode:0o600}); await replay.deleteRoot();
  }
  return fs.writeFile(path,input,options);
}
