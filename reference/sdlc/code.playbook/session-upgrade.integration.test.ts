// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-111: `playbook sessions upgrade` converts schema-7 and schema-8 sessions
// to schema 9, verified against fixtures the earlier writers produced.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionStore } from './session-store.js';
import { findSessionsDirectories, upgradeSessions } from './bin/session-upgrade.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixtures = fileURLToPath(new URL('./fixtures/legacy-sessions/', import.meta.url));
const cli = fileURLToPath(new URL('./bin/playbook.js', import.meta.url));
const ids = {
  settled8: '8a000000-0000-4000-8000-000000000001',
  uncertain8: '8a000000-0000-4000-8000-000000000002',
  history8: '8a000000-0000-4000-8000-000000000003',
  settled7: '7a000000-0000-4000-8000-000000000001',
  tail7: '7a000000-0000-4000-8000-000000000002',
};
const formerFiles: Record<string, string[]> = {
  [ids.settled8]: ['json', 'replay.json', 'chunks'], [ids.uncertain8]: ['json', 'replay.json', 'chunks'], [ids.history8]: ['json', 'replay.json', 'chunks'],
  [ids.settled7]: ['json', 'records.jsonl'], [ids.tail7]: ['json', 'records.jsonl'],
};

// A private copy of the fixture sessions, as a checkout tightened by opening.
async function copySessions(target: string) {
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.cp(join(fixtures, 'sessions'), target, { recursive: true });
  for (const entry of await fs.readdir(target, { recursive: true, withFileTypes: true })) {
    await fs.chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600);
  }
  await fs.chmod(target, 0o700);
  return target;
}
async function root() { const path = await fs.mkdtemp(join(tmpdir(), 'session-upgrade-')); roots.push(path); return path; }
async function expected(id: string) {
  return {
    manifest: JSON.parse(await fs.readFile(join(fixtures, 'expected', `${id}.manifest.json`), 'utf8')),
    replay: await fs.readFile(join(fixtures, 'expected', `${id}.replay.jsonl`)),
  };
}
async function logBytes(sessionsDir: string, id: string) {
  const directory = join(sessionsDir, `${id}.replay`);
  return Buffer.concat(await Promise.all((await fs.readdir(directory)).sort().map((name) => fs.readFile(join(directory, name)))));
}
async function tree(path: string) {
  const entries: Record<string, string> = {};
  for (const entry of await fs.readdir(path, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name);
    entries[relative(path, full)] = entry.isFile() ? digest(await fs.readFile(full)) : entry.isSymbolicLink() ? 'link' : 'directory';
  }
  return entries;
}
async function snapshot(path: string) { return (await fs.lstat(path)).isDirectory() ? tree(path) : digest(await fs.readFile(path)); }
const outcomes = (results: any[]) => Object.fromEntries(results.flatMap(({ sessions }) => sessions.map((session: any) => [session.sessionId, session.outcome])));

describe('session conversion (DR-111)', () => {
  it('converts every schema-7 and schema-8 session in one directory and keeps the former files aside', async () => {
    const base = await root();
    const sessionsDir = await copySessions(join(base, 'sessions'));
    const hintsBefore = JSON.parse(await fs.readFile(join(sessionsDir, `${ids.settled8}.hints.json`), 'utf8'));
    const results = await upgradeSessions({ root: sessionsDir });
    expect(outcomes(results)).toEqual(Object.fromEntries(Object.values(ids).map((id) => [id, 'converted'])));
    const store = createSessionStore({ sessionsDir, createSessionsDir: false });
    for (const id of Object.values(ids)) {
      const want = await expected(id);
      const manifestBytes = await fs.readFile(join(sessionsDir, `${id}.json`));
      expect(JSON.parse(manifestBytes.toString())).toMatchObject({ schemaVersion: 9, sessionId: id });
      expect(await store.readManifest(id)).toEqual(want.manifest);
      expect((await logBytes(sessionsDir, id)).equals(want.replay)).toBe(true);
      const validation = await store.validate(id);
      expect(validation.integrityValid).toBe(true);
      // The former files sit beside the sessions directory, byte for byte.
      const backup = join(base, '.legacy-sessions', id);
      for (const suffix of formerFiles[id]) {
        expect(await snapshot(join(backup, `${id}.${suffix}`))).toEqual(await snapshot(join(fixtures, 'sessions', `${id}.${suffix}`)));
        if (suffix !== 'json') await expect(fs.lstat(join(sessionsDir, `${id}.${suffix}`))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(JSON.parse(await fs.readFile(join(backup, 'receipt.json'), 'utf8'))).toMatchObject({ complete: true, manifestSha256: digest(manifestBytes) });
    }
    // Assets stay in place; provider hints follow the new manifest.
    expect(await fs.readdir(join(sessionsDir, `${ids.settled8}.assets`))).toHaveLength(2);
    const hints = JSON.parse(await fs.readFile(join(sessionsDir, `${ids.settled8}.hints.json`), 'utf8'));
    expect(hints).toEqual({ ...hintsBefore, checkpointSha256: digest(await fs.readFile(join(sessionsDir, `${ids.settled8}.json`))) });
    const lease = await store.acquire(ids.settled8);
    expect(await lease.consumeHints()).toMatchObject({ players: { 'dev.coder': 'player-token-2' }, captain: { kind: 'pinned', token: 'captain-token-2' } });
    // The fixtures were recorded with POSIX working directories, which are
    // not native on Windows, so there only that reason may remain.
    if (process.platform === 'win32') await expect(lease.assertContinuable()).rejects.toThrow(/^recorded working directory is not native; checkpoint relocation is unsupported$/);
    else expect((await lease.assertContinuable()).resumable).toBe(true);
    await lease.append({ type: 'after_conversion', timestamp: 1 });
    await lease.release();
    // The torn final line no checkpoint covered is repaired by the next lease.
    const torn = await store.acquire(ids.tail7);
    expect(torn.streamStatus()).toMatchObject({ lastReadableSeq: (await expected(ids.tail7)).manifest.replay.seq + 1, incomplete: false });
    await torn.release();
    expect((await store.validate(ids.uncertain8)).manifest.state).toBe('uncertain');
    expect((await store.validate(ids.history8)).resumable).toBe(false);
  });

  it('finds sessions directories recursively without following links or entering skipped directories', async () => {
    const base = await root();
    const wanted = [join(base, 'a', 'sessions'), join(base, 'b', 'c', 'sessions')];
    for (const path of wanted) await copySessions(path);
    for (const skipped of ['.git', 'node_modules', '.legacy-sessions']) await copySessions(join(base, skipped, 'x', 'sessions'));
    await copySessions(join(base, 'outside', 'sessions'));
    // A junction is Windows' directory link that needs no symlink privilege.
    await fs.symlink(join(base, 'outside'), join(base, 'link'), process.platform === 'win32' ? 'junction' : undefined);
    await copySessions(join(base, 'named-otherwise'));
    await fs.mkdir(join(base, 'empty', 'sessions'), { recursive: true });
    await fs.rm(join(base, 'outside'), { recursive: true });
    await fs.mkdir(join(base, 'outside', 'sessions'), { recursive: true });
    expect((await findSessionsDirectories(base)).sort()).toEqual(wanted.sort());
    const before = await tree(join(base, 'named-otherwise'));
    const results = await upgradeSessions({ root: base, recursive: true });
    expect(results.map(({ directory }: any) => directory).sort()).toEqual(wanted.sort());
    for (const { sessions } of results) expect(sessions.every(({ outcome }: any) => outcome === 'converted')).toBe(true);
    expect(await tree(join(base, 'named-otherwise'))).toEqual(before);
    expect((await fs.readdir(join(base, 'a'))).sort()).toEqual(['.legacy-sessions', 'sessions']);
  });

  it('skips a converted, an unknown and a leased session and reports each', async () => {
    const base = await root();
    const sessionsDir = await copySessions(join(base, 'sessions'));
    const unknown = '9a000000-0000-4000-8000-000000000001';
    await fs.writeFile(join(sessionsDir, `${unknown}.json`), '{"schemaVersion":99}\n', { mode: 0o600 });
    const holder = createSessionStore({ sessionsDir, createSessionsDir: false });
    const lease = await holder.acquireManagement(ids.uncertain8);
    const first = await upgradeSessions({ root: sessionsDir });
    expect(outcomes(first)).toMatchObject({ [unknown]: 'skipped', [ids.uncertain8]: 'skipped', [ids.settled8]: 'converted' });
    const reasons = Object.fromEntries(first[0].sessions.map((session: any) => [session.sessionId, session.reason]));
    expect(reasons[unknown]).toMatch(/unknown format \(schema 99\)/);
    expect(reasons[ids.uncertain8]).toMatch(/held by a lease/);
    await lease.release();
    const second = await upgradeSessions({ root: sessionsDir });
    expect(outcomes(second)).toMatchObject({ [ids.uncertain8]: 'converted', [ids.settled8]: 'skipped', [unknown]: 'skipped' });
    expect(second[0].sessions.find((session: any) => session.sessionId === ids.settled8).reason).toBe('already schema 9');
  });

  it('lists what it would convert in a dry run and changes nothing', async () => {
    const base = await root();
    const sessionsDir = await copySessions(join(base, 'sessions'));
    const before = await tree(base);
    const results = await upgradeSessions({ root: base, recursive: true, dryRun: true });
    expect(results.map(({ directory }: any) => directory)).toEqual([sessionsDir]);
    expect(outcomes(results)).toEqual(Object.fromEntries(Object.values(ids).map((id) => [id, 'would-convert'])));
    expect(await tree(base)).toEqual(before);
  });

  it('leaves the former session unchanged when the written representation does not verify', async () => {
    const base = await root();
    const sessionsDir = await copySessions(join(base, 'sessions'));
    const before = await tree(sessionsDir);
    const fsOps = { async open(path: string, flags: any, mode?: number) {
      const handle = await fs.open(path, flags, mode);
      if (!path.startsWith(join(sessionsDir, `${ids.settled8}.replay`))) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') return async (bytes: Buffer) => { const copy = Buffer.from(bytes); copy[copy.length - 2] ^= 1; return target.writeFile(copy); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    const results = await upgradeSessions({ root: sessionsDir, fsOps });
    expect(outcomes(results)[ids.settled8]).toBe('failed');
    const after = await tree(sessionsDir);
    for (const [path, value] of Object.entries(before)) if (path.startsWith(ids.settled8)) expect(after[path]).toBe(value);
    expect(JSON.parse(await fs.readFile(join(sessionsDir, `${ids.settled8}.json`), 'utf8')).schemaVersion).toBe(8);
    // Run again: the written residue is rewritten and the conversion completes.
    expect(outcomes(await upgradeSessions({ root: sessionsDir }))[ids.settled8]).toBe('converted');
    expect(await createSessionStore({ sessionsDir }).readManifest(ids.settled8)).toEqual((await expected(ids.settled8)).manifest);
  });

  it.each(['before-switch', 'after-switch'])('completes a conversion interrupted %s when run again', async (when) => {
    const base = await root();
    const sessionsDir = await copySessions(join(base, 'sessions'));
    let armed = true;
    const fsOps = { async rename(from: string, to: string) {
      const target = when === 'before-switch' ? join(sessionsDir, `${ids.settled8}.json`) : join(base, '.legacy-sessions', ids.settled8, `${ids.settled8}.chunks`);
      if (armed && to === target) { armed = false; throw Object.assign(new Error('injected interruption'), { code: 'EIO' }); }
      return fs.rename(from, to);
    } };
    expect(outcomes(await upgradeSessions({ root: sessionsDir, fsOps }))[ids.settled8]).toBe('failed');
    const stored = JSON.parse(await fs.readFile(join(sessionsDir, `${ids.settled8}.json`), 'utf8'));
    expect(stored.schemaVersion).toBe(when === 'before-switch' ? 8 : 9);
    const store = createSessionStore({ sessionsDir });
    // Before the switch the former session is untouched, still unsupported.
    if (when === 'before-switch') await expect(store.validate(ids.settled8)).rejects.toThrow(/storage schema 8 is unsupported/);
    const results = await upgradeSessions({ root: sessionsDir });
    expect(results[0].sessions.find((session: any) => session.sessionId === ids.settled8)).toMatchObject({ outcome: 'converted', ...(when === 'after-switch' ? { reason: 'finished an interrupted conversion' } : {}) });
    for (const suffix of ['replay.json', 'chunks']) await expect(fs.lstat(join(sessionsDir, `${ids.settled8}.${suffix}`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(join(sessionsDir, `${ids.settled8}.hints.json`), 'utf8')).checkpointSha256).toBe(digest(await fs.readFile(join(sessionsDir, `${ids.settled8}.json`))));
    expect(await store.readManifest(ids.settled8)).toEqual((await expected(ids.settled8)).manifest);
  });

  it('refuses to overwrite a backup of a completed conversion and reuses an incomplete one', async () => {
    const base = await root();
    const sessionsDir = await copySessions(join(base, 'sessions'));
    await upgradeSessions({ root: sessionsDir });
    // The former files restored into place beside a completed backup.
    const restored = await copySessions(join(base, 'restored'));
    await fs.cp(join(restored, `${ids.settled7}.json`), join(sessionsDir, `${ids.settled7}.json`));
    await fs.cp(join(restored, `${ids.settled7}.records.jsonl`), join(sessionsDir, `${ids.settled7}.records.jsonl`));
    const refused = await upgradeSessions({ root: sessionsDir });
    expect(refused[0].sessions.find((session: any) => session.sessionId === ids.settled7)).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/completed conversion/) });
    expect(JSON.parse(await fs.readFile(join(sessionsDir, `${ids.settled7}.json`), 'utf8')).schemaVersion).toBe(7);
    const receipt = join(base, '.legacy-sessions', ids.settled7, 'receipt.json');
    await fs.writeFile(receipt, JSON.stringify({ ...JSON.parse(await fs.readFile(receipt, 'utf8')), complete: false }));
    await fs.rm(join(base, '.legacy-sessions', ids.settled7, `${ids.settled7}.records.jsonl`));
    expect(outcomes(await upgradeSessions({ root: sessionsDir }))[ids.settled7]).toBe('converted');
  });

  it('runs as `playbook sessions upgrade` with a directory, recursion and a dry run', async () => {
    const base = await root();
    const sessionsDir = await copySessions(join(base, 'tree', 'sessions'));
    const env = { PATH: process.env.PATH, HOME: join(base, 'home'), SPEX_HOME: join(base, 'spex') };
    const run = async (args: string[]) => {
      try { const value = await exec(process.execPath, [cli, 'sessions', 'upgrade', ...args], { env, timeout: 30_000 }); return { code: 0, ...value }; }
      catch (cause: any) { return { code: cause.code, stdout: cause.stdout ?? '', stderr: cause.stderr ?? '' }; }
    };
    const dry = await run([join(base, 'tree'), '--recursive', '--dry-run']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(sessionsDir);
    expect(dry.stdout).toContain(`${ids.settled8} schema 8: would convert`);
    expect(JSON.parse(await fs.readFile(join(sessionsDir, `${ids.settled8}.json`), 'utf8')).schemaVersion).toBe(8);
    const converted = await run([sessionsDir]);
    expect(converted.code, converted.stderr).toBe(0);
    expect(converted.stdout).toContain(`${ids.tail7} schema 7: converted`);
    expect(converted.stdout).toMatch(/converted 5, skipped 0, failed 0/);
    const again = await run([sessionsDir]);
    expect(again.stdout).toMatch(/converted 0, skipped 5, failed 0/);
    const usage = await run(['--bogus']);
    expect(usage.code).toBe(1);
  });
});
