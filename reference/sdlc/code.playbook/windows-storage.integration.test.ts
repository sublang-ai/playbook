// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveMachineIdentity } from './machine-identity.js';
import { createCaptainSessionStore } from './bin/session-store.js';
import { createSessionChunks } from './bin/session-chunks.js';
import { createBoundedReplay } from './bin/session-replay.js';
import { mkdirPrivate } from './bin/private-paths.js';
import { createAssetStore } from './session-assets.js';

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
      const chunks = createSessionChunks({ directory: join(sessionsDir, 'fixture.chunks') });
      const value = { evidence: 'unchanged bytes', items: [1, 2, 3] };
      const ref = await chunks.writeJson(value);
      expect(await chunks.readJson(ref)).toEqual(value);
      const assets = createAssetStore({ directory: join(root, 'assets') });
      const asset = await assets.importAsset({ bytes: Buffer.from('fixture evidence'), mimeType: 'text/plain' });
      const reader = await assets.openAsset(asset);
      await assets.prepare();
      expect(Buffer.from(await reader.read({ offset: 0, length: 16 })).toString()).toBe('fixture evidence');
      await reader.close();
      const files = await assets.listAssets();
      const file = join(assets.directory, files[0].path);
      const before = await fs.readFile(file);
      execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
      await expect(assets.openAsset(asset)).rejects.toThrow();
      expect(await fs.readFile(file)).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120000);
  it('publishes and prepares bounded replay with directory identity checks', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'playbook-windows-replay-'));
    try {
      const sessionsDir = join(root, 'sessions');
      await mkdirPrivate(sessionsDir, fs);
      const replay = await createBoundedReplay({ sessionId: '94000000-0000-4000-8000-000000000002', sessionsDir });
      await replay.initializeBytes(Buffer.from('one\n'));
      await replay.appendBytes(Buffer.from('two\n'));
      await replay.prepare();
      expect((await replay.readBytes()).toString()).toBe('one\ntwo\n');
      expect(await replay.checkpoint()).toEqual({ byteLength: 8 });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120000);

});
