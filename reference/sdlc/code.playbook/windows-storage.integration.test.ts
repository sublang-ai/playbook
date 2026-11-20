// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveMachineIdentity } from './machine-identity.js';
import { machineIdentityPath, resolveMachineIdentity as readMachineIdentity } from './bin/machine-identity.js';
import { createCaptainSessionStore } from './bin/session-store.js';
import { createSessionFiles } from './bin/session-files.js';
import { mkdirPrivate } from './bin/private-paths.js';
import { createAssetStore } from './session-assets.js';
import { executionProjection, freshBoundary, shellSnapshot } from './test-support/session-boundary.js';

// The access masks icacls writes for these simple rights.
const RIGHTS_MASK: Record<string, number> = { R: 0x120089, RX: 0x1200A9, M: 0x1301BF };

// Grant Everyone (S-1-1-0) access, as the Codex sandbox grants its group,
// and confirm by SID and mask, never by the localized account name, that
// the grant landed, so an admission is not vacuous.
function grant(path: string, rights: string): void {
  execFileSync('icacls.exe', [path, '/grant', `*S-1-1-0:${rights}`], { windowsHide: true });
  const expected = RIGHTS_MASK[/\((\w+)\)$/.exec(rights)![1]];
  const { readOwnerAndDacl } = createRequire(import.meta.url)('@openclaw/fs-safe/permissions');
  const facts = readOwnerAndDacl(path);
  const granted = facts.aces
    .filter((ace: { sid: string; aceType: string }) => ace.aceType === 'allow' && ace.sid === 's-1-1-0')
    .reduce((mask: number, ace: { mask: number }) => mask | ace.mask, 0);
  expect(granted & expected).toBe(expected);
}

// Packaged .NET ACL inspection is supported too: the measured replay probe
// takes about 69 seconds under Electron, so retain a bounded two-minute budget.
describe.skipIf(process.platform !== 'win32')('native Windows private session storage', () => {
  it('retains machine identity, leases, immutable bytes and rejects an overbroad ACL', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'playbook-windows-'));
    try {
      const env = { ...process.env, XDG_STATE_HOME: join(root, 'state') };
      const identity = await resolveMachineIdentity({ env });
      expect(await resolveMachineIdentity({ env })).toBe(identity);
      const sessionsDir = join(root, 'sessions');
      const store = createCaptainSessionStore({ sessionsDir, env });
      const sessionId = '94000000-0000-4000-8000-000000000001';
      for (let n = 0; n < 2; n++) { const lease = await store.acquire(sessionId); await lease.release(); }
      // A blob part over the per-file bound's share of a manifest round-trips.
      const sessionFiles = createSessionFiles({ sessionsDir, sessionId });
      const large = { schemaVersion: 7, evidence: 'x'.repeat(9 * 1024 * 1024) };
      const encoded = await sessionFiles.prepareManifest(large, { sealed: [], open: null });
      expect((await sessionFiles.decodeManifest(encoded.bytes)).manifest).toEqual(large);
      const assets = createAssetStore({ directory: join(root, 'assets') });
      const asset = await assets.importAsset({ bytes: Buffer.from('fixture evidence'), mimeType: 'text/plain' });
      const reader = await assets.openAsset(asset);
      await assets.prepare();
      expect(Buffer.from(await reader.read({ offset: 0, length: 16 })).toString()).toBe('fixture evidence');
      await reader.close();
      const files = await assets.listAssets();
      const file = join(assets.directory, files[0].path);
      const before = await fs.readFile(file);
      // A read grant another tool adds is admitted; one that may change the
      // file refuses without touching its bytes (session-assets-11).
      grant(file, '(R)');
      const granted = await assets.openAsset(asset);
      expect(Buffer.from(await granted.read({ offset: 0, length: 16 })).toString()).toBe('fixture evidence');
      await granted.close();
      grant(file, '(M)');
      await expect(assets.openAsset(asset)).rejects.toThrow();
      expect(await fs.readFile(file)).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120000);
  it('appends, seals and prepares a segment log with private checks (DR-111)', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'playbook-windows-replay-'));
    try {
      const sessionsDir = join(root, 'sessions');
      await mkdirPrivate(sessionsDir, fs);
      const sessionId = '94000000-0000-4000-8000-000000000002';
      const store = createCaptainSessionStore({ sessionsDir });
      const lease = await store.acquire(sessionId);
      await lease.initializeSettledWithPredecessor(freshBoundary() as any);
      await lease.append({ type: 'one', timestamp: 1 });
      const attemptId = '94000000-0000-4000-8000-0000000000a2';
      await lease.beginTurn({ input: 'two', attemptId, attemptedExecutionProjection: executionProjection() });
      await lease.settle({ attemptId, snapshot: shellSnapshot(1, 'two'), unresolvedEffects: [] });
      await lease.append({ type: 'two', timestamp: 2 });
      await lease.release();
      await store.prepare();
      const files = createSessionFiles({ sessionsDir, sessionId });
      await files.prepare();
      const read = await files.readLog();
      expect(read.segments.length).toBe(2);
      expect(read.lines.toString()).toContain('"type":"two"');
      expect((await store.validate(sessionId)).integrityValid).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120000);
  it('admits read grants on a schema-9 manifest and segment and refuses a modify grant (DR-111)', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'playbook-windows-log-'));
    try {
      const env = { ...process.env, XDG_STATE_HOME: join(root, 'state') };
      const sessionsDir = join(root, 'sessions');
      const sessionId = '94000000-0000-4000-8000-000000000004';
      const store = createCaptainSessionStore({ sessionsDir, env });
      const lease = await store.acquire(sessionId);
      await lease.append({ type: 'opaque_history', timestamp: 1 });
      await lease.release();
      const segment = join(sessionsDir, `${sessionId}.replay`, '000000000001.jsonl');
      grant(sessionsDir, '(OI)(CI)(RX)');
      grant(join(sessionsDir, `${sessionId}.replay`), '(OI)(CI)(RX)');
      grant(segment, '(RX)');
      const reader = createCaptainSessionStore({ sessionsDir, env });
      const next = await reader.acquire(sessionId);
      expect((await next.readStream()).entries.map(({ record }: any) => record.type)).toEqual(['opaque_history']);
      await next.append({ type: 'later', timestamp: 2 });
      await next.release();
      const before = await fs.readFile(segment);
      grant(segment, '(M)');
      await expect(createCaptainSessionStore({ sessionsDir, env }).acquire(sessionId))
        .rejects.toThrow(/refuses unsafe ownership/);
      expect(await fs.readFile(segment)).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120000);
  it('keeps the previous manifest while another process holds it without delete sharing (DR-111)', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'playbook-windows-held-'));
    try {
      const env = { ...process.env, XDG_STATE_HOME: join(root, 'state') };
      const sessionsDir = join(root, 'sessions');
      const sessionId = '94000000-0000-4000-8000-000000000005';
      const store = createCaptainSessionStore({ sessionsDir, env });
      const lease = await store.acquire(sessionId);
      await lease.initializeSettledWithPredecessor(freshBoundary() as any);
      const manifest = join(sessionsDir, `${sessionId}.json`);
      const before = await fs.readFile(manifest);
      // Git, an indexer or antivirus may open the manifest without delete sharing.
      const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
        `$f=[IO.File]::Open('${manifest}','Open','Read','Read'); 'held'; [Console]::In.ReadLine() | Out-Null; $f.Close()`], { stdio: ['pipe', 'pipe', 'ignore'] });
      await new Promise((resolve) => holder.stdout!.once('data', resolve));
      const attemptId = '94000000-0000-4000-8000-0000000000a5';
      try {
        await expect(lease.beginTurn({ input: 'held', attemptId, attemptedExecutionProjection: executionProjection() })).rejects.toThrow();
        expect(await fs.readFile(manifest)).toEqual(before);
      } finally { holder.stdin!.end('\n'); await new Promise((resolve) => holder.on('exit', resolve)); }
      await lease.beginTurn({ input: 'released', attemptId, attemptedExecutionProjection: executionProjection() });
      await lease.settle({ attemptId, snapshot: shellSnapshot(1, 'released'), unresolvedEffects: [] });
      await lease.release();
      expect((await createCaptainSessionStore({ sessionsDir, env }).validate(sessionId)).integrityValid).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120000);
  it('admits read grants on sessions and machine identity and refuses a modify grant', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'playbook-windows-grants-'));
    try {
      const env = { ...process.env, XDG_STATE_HOME: join(root, 'state') };
      const identity = await resolveMachineIdentity({ env });
      const identityFile = machineIdentityPath(env);
      grant(join(root, 'state', 'playbook'), '(OI)(CI)(RX)');
      grant(identityFile, '(RX)');
      // Read again from disk, past the per-process cache (session-storage-27).
      expect(await readMachineIdentity({ env, fsOps: {} })).toBe(identity);

      const sessionsDir = join(root, 'sessions');
      await mkdirPrivate(sessionsDir, fs);
      const sessionId = '94000000-0000-4000-8000-000000000003';
      const writer = await createCaptainSessionStore({ sessionsDir, env }).acquire(sessionId);
      await writer.initializeSettledWithPredecessor(freshBoundary() as any);
      await writer.release();
      const sessionFile = join(sessionsDir, `${sessionId}.json`);
      grant(sessionsDir, '(OI)(CI)(RX)');
      grant(sessionFile, '(RX)');
      const store = createCaptainSessionStore({ sessionsDir, env });
      const lease = await store.acquire(sessionId);
      await lease.release();
      expect((await store.validate(sessionId)).integrityValid).toBe(true);

      const before = await fs.readFile(sessionFile);
      grant(sessionFile, '(M)');
      await expect(createCaptainSessionStore({ sessionsDir, env }).acquire(sessionId))
        .rejects.toThrow(/refuses unsafe ownership/);
      expect(await fs.readFile(sessionFile)).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120000);
});
