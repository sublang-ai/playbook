// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assetUri, createAssetStore, parseAssetUri, validateAssetRef } from './session-assets.js';
import type { PlaybookEvidenceRecord, SessionRecord, SessionTurnInput } from './session-assets.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(limit?: number) {
  const root = await mkdtemp(join(tmpdir(), 'playbook-assets-')); roots.push(root);
  const directory = join(root, 'owner.assets');
  return { root, directory, store: createAssetStore({ directory, ...(limit === undefined ? {} : { maxAssetBytes: limit }) }) };
}

describe('immutable owner assets (session-assets-6, session-assets-7)', () => {
  it('imports a real file, deduplicates content aliases, reads ranges and copies ownership', async () => {
    const { root, store, directory } = await fixture();
    const bytes = Buffer.from('0123456789'.repeat(20000));
    const source = join(root, 'upload.bin'); await writeFile(source, bytes);
    const ref = await store.importAsset({ path: source, mimeType: 'application/octet-stream', name: 'upload.bin' });
    expect(ref.assetId).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    const alias = await store.importAsset({ bytes, mimeType: 'text/plain', name: 'readable.txt' });
    expect(alias.assetId).toBe(ref.assetId);
    expect(await store.describeAsset(ref.assetId)).toEqual(ref);
    expect((await readdir(directory)).length).toBe(2);
    const reader = await store.openAsset(alias);
    expect(Buffer.from(await reader.read({ offset: 65530, length: 65536 }))).toEqual(bytes.subarray(65530, 131066));
    expect(reader.reference).toEqual(alias);
    await reader.close(); await reader.close();
    await expect(reader.read({ offset: 0, length: 1 })).rejects.toThrow('closed');
    const destination = createAssetStore({ directory: join(root, 'session.assets') });
    expect(await destination.copyAsset(store, ref)).toEqual(ref);
    const attachment = await destination.resolveAttachment(ref);
    await rm(directory, { recursive: true }); await rm(source);
    expect(await readFile(attachment.path)).toEqual(bytes);
    expect(attachment.mimeType).toBe('application/octet-stream');
    expect(await destination.listAssets()).toEqual([{ assetId: ref.assetId, path: ref.assetId.slice(7), metadataPath: `${ref.assetId.slice(7)}.json`, byteLength: bytes.length }]);
  });

  it('bounds imports, honors cancellation and recovers after rejected work without partial files', async () => {
    const { store, directory } = await fixture(4);
    await expect(store.importAsset({ bytes: Buffer.alloc(5), mimeType: 'image/png' })).rejects.toThrow('4-byte');
    const controller = new AbortController(); controller.abort(new Error('cancel upload'));
    await expect(store.importAsset({ bytes: Buffer.alloc(4), mimeType: 'image/png', signal: controller.signal })).rejects.toThrow('cancel upload');
    expect(await store.listAssets()).toEqual([]);
    const upload = Buffer.from('abcd');
    const importing = store.importAsset({ bytes: upload, mimeType: 'text/plain' });
    upload.fill(0);
    const ref = await importing;
    expect(Buffer.from(await store.readAsset(ref)).toString()).toBe('abcd');
    expect((await readdir(directory)).every((file) => !file.endsWith('.tmp'))).toBe(true);
  });

  it('rejects source symlinks and hardlinks, unsafe owner directories and corrupted bytes', async () => {
    const { root, store, directory } = await fixture();
    const source = join(root, 'source'); await writeFile(source, 'trusted');
    const alias = join(root, 'alias'); await symlink(source, alias);
    await expect(store.importAsset({ path: alias, mimeType: 'text/plain' })).rejects.toThrow('regular file');
    await rm(alias); await link(source, alias);
    await expect(store.importAsset({ path: source, mimeType: 'text/plain' })).rejects.toThrow('regular file');
    await rm(alias);
    const ref = await store.importAsset({ path: source, mimeType: 'text/plain' });
    const content = join(directory, ref.assetId.slice(7));
    const reader = await store.openAsset(ref);
    await writeFile(content, 'changed');
    await expect(reader.read({ offset: 0, length: 1 })).rejects.toThrow('changed'); await reader.close();
    await expect(store.readAsset(ref)).rejects.toThrow('integrity');
    await expect(store.importAsset({ bytes: Buffer.from('trusted'), mimeType: 'text/plain' })).rejects.toThrow('integrity');
    expect(await readFile(content, 'utf8')).toBe('changed');
    if (process.platform !== 'win32') {
      await chmod(directory, 0o755);
      await expect(store.listAssets()).rejects.toThrow('0700');
    }
  });

  it('rejects invalid refs and unsafe stored links before exposing a path', async () => {
    const { root, store, directory } = await fixture();
    const ref = await store.importAsset({ bytes: Buffer.from('source'), mimeType: 'text/plain' });
    expect(() => validateAssetRef({ ...ref, path: '/private/file' })).toThrow('fields');
    expect(() => validateAssetRef({ ...ref, assetId: '../../outside' })).toThrow('identifier');
    expect(() => validateAssetRef({ ...ref, mimeType: 'Image/PNG' })).toThrow('MIME');
    await expect(store.readAsset({ ...ref, byteLength: 5 })).rejects.toThrow('byte count');
    const content = join(directory, ref.assetId.slice(7));
    await rm(content); const outside = join(root, 'outside'); await writeFile(outside, 'source'); await symlink(outside, content);
    await expect(store.resolveAttachment(ref)).rejects.toThrow('regular file');
    expect(await readFile(outside, 'utf8')).toBe('source');
  });

  it('prepares a Git-restored owner without changing bytes or granting missing permissions', async () => {
    const { store, directory } = await fixture();
    const ref = await store.importAsset({ bytes: Buffer.from('checkout'), mimeType: 'text/plain' });
    if (process.platform === 'win32') return;
    const files = await readdir(directory);
    for (const file of files) await chmod(join(directory, file), 0o644);
    await chmod(directory, 0o755);
    await store.prepare();
    expect(Buffer.from(await store.readAsset(ref)).toString()).toBe('checkout');
    await chmod(join(directory, ref.assetId.slice(7)), 0o400);
    await expect(store.prepare()).rejects.toThrow('insufficient');
  });

  it('repeats preparation from another store without disturbing verified readers or concurrent verification', async () => {
    const { store, directory } = await fixture();
    const ref = await store.importAsset({ bytes: Buffer.from('steady'), mimeType: 'text/plain' });
    const reader = await store.openAsset(ref);
    const other = createAssetStore({ directory });
    await other.prepare();
    const [, concurrent] = await Promise.all([other.prepare(), store.openAsset(ref)]);
    expect(Buffer.from(await reader.read({ offset: 0, length: 6 })).toString()).toBe('steady');
    expect(Buffer.from(await concurrent.read({ offset: 0, length: 6 })).toString()).toBe('steady');
    await reader.close(); await concurrent.close();
    if (process.platform === 'win32') return;
    const content = join(directory, ref.assetId.slice(7));
    await chmod(content, 0o644); await chmod(directory, 0o755);
    await other.prepare();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(content)).mode & 0o777).toBe(0o600);
  });

  it('retains complete orphan bytes but never treats a missing content file as an empty owner', async () => {
    const { store, directory } = await fixture();
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'a'.repeat(64)), 'orphan', { mode: 0o600 });
    expect(await store.listAssets()).toEqual([]);
    const ref = await store.importAsset({ bytes: Buffer.from('real'), mimeType: 'text/plain' });
    await rm(join(directory, ref.assetId.slice(7)));
    await expect(store.listAssets()).rejects.toThrow('no content');
  });
});

it('exports attachment-only turns and visible evidence without machine paths (session-assets-8)', async () => {
  const { store } = await fixture();
  const asset = await store.importAsset({ bytes: Buffer.from('image'), mimeType: 'image/png', name: 'Screenshot' });
  const input: SessionTurnInput = { text: '', attachments: [asset] };
  const evidence: PlaybookEvidenceRecord = { type: 'playbook_evidence', timestamp: 1, turnId: 1, callId: 'call-1', origin: { kind: 'player', actorId: 'inspector', runtimeSessionId: 'frame-1', toolUseId: 'tool-1' }, asset };
  const records: readonly SessionRecord[] = [{ type: 'turn_started', timestamp: 1, turnId: 1, turn: { id: 1, timestamp: 1, prompt: input.text, attachments: input.attachments } }, evidence];
  expect(JSON.parse(JSON.stringify(records))).toEqual(records);
  expect(parseAssetUri(assetUri(asset))).toBe(asset.assetId);
  expect(parseAssetUri(`${assetUri(asset)}/../../file`)).toBeUndefined();
});
