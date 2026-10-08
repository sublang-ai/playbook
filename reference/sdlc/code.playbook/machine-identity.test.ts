// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-99: the machine identity (DR-087, playbook-cli-97/95) over isolated
// state directories and real child processes, and its carriage in session
// leases and repository claims beside legacy host-name owners.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACHINE_IDENTITY_TAG_PREFIX,
  isMachineIdentity,
  machineIdentityPath,
  resolveMachineIdentity,
} from './machine-identity.js';
import { resolveMachineIdentity as resolveWithFileOperations } from './bin/machine-identity.js';
import { createCaptainSessionStore } from './bin/session-store.js';
import { createRepositoryEffectCoordinator } from './bin/repository-effects.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const UNAVAILABLE = 'PLAYBOOK_MACHINE_IDENTITY_UNAVAILABLE';
const TAGGED = /^machine-id:v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const binModule = new URL('./bin/machine-identity.js', import.meta.url).href;

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scenario() {
  const root = await mkdtemp(join(tmpdir(), 'playbook-machine-identity-'));
  tempDirs.push(root);
  const xdg = join(root, 'xdg-state');
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const env = { XDG_STATE_HOME: xdg, HOME: home };
  return { root, xdg, home, env, path: join(xdg, 'playbook', 'machine-id') };
}

function processError(code: string) {
  return Object.assign(new Error(`process probe ${code}`), { code });
}

async function resolveInChild(env: Record<string, string>): Promise<string> {
  const source = `
    import { resolveMachineIdentity } from ${JSON.stringify(binModule)};
    process.stdout.write((await resolveMachineIdentity()) + '\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code) =>
      code === 0 ? resolveExit() : rejectExit(new Error(`child exited ${code}: ${stderr}`)),
    );
  });
  children.delete(child);
  return stdout.trim();
}

describe('the machine identity file (PBCLI-97/95)', () => {
  it('names the XDG state file and accepts exactly the tagged form', async () => {
    expect(machineIdentityPath({ XDG_STATE_HOME: '/state' }, '/h')).toBe('/state/playbook/machine-id');
    expect(machineIdentityPath({ HOME: '/home/u' }, '/h')).toBe('/home/u/.local/state/playbook/machine-id');
    expect(machineIdentityPath({}, '/h')).toBe('/h/.local/state/playbook/machine-id');
    expect(MACHINE_IDENTITY_TAG_PREFIX).toBe('machine-id:v1:');
    expect(isMachineIdentity(`machine-id:v1:${randomUUID()}`)).toBe(true);
    expect(isMachineIdentity(`machine-id:v1:${randomUUID().toUpperCase()}`)).toBe(false);
    expect(isMachineIdentity('machine-id:v1:not-a-uuid')).toBe(false);
    expect(isMachineIdentity('machine-id:v2:00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(isMachineIdentity(hostname())).toBe(false);
    expect(isMachineIdentity(undefined)).toBe(false);
  });

  it('publishes one private identity when absent and returns it again in the process', async () => {
    const { env, path, xdg } = await scenario();
    const first = await resolveMachineIdentity({ env });
    expect(first).toMatch(TAGGED);
    expect(await readFile(path, 'utf8')).toBe(`${first}\n`);
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    expect((await lstat(join(xdg, 'playbook'))).mode & 0o7777).toBe(0o700);
    expect(await readdir(join(xdg, 'playbook'))).toEqual(['machine-id']);
    await writeFile(path, 'tampered\n');
    expect(await resolveMachineIdentity({ env })).toBe(first);
  });

  it('gives two processes resolving at once one identity and one complete file', async () => {
    const { env, path } = await scenario();
    const [a, b, c] = await Promise.all([resolveInChild(env), resolveInChild(env), resolveInChild(env)]);
    expect(a).toMatch(TAGGED);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(await readFile(path, 'utf8')).toBe(`${a}\n`);
    expect(await resolveMachineIdentity({ env })).toBe(a);
  });

  it('tightens excess permissions in place and refuses links, wrong owners, and unreadable files', async () => {
    const { env, path, xdg } = await scenario();
    const value = `machine-id:v1:${randomUUID()}`;
    await mkdir(join(xdg, 'playbook'), { recursive: true, mode: 0o755 });
    await chmod(join(xdg, 'playbook'), 0o755);
    await writeFile(path, `${value}\n`, { mode: 0o644 });
    await chmod(path, 0o644);
    expect(await resolveMachineIdentity({ env })).toBe(value);
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    expect((await lstat(join(xdg, 'playbook'))).mode & 0o7777).toBe(0o700);

    const linked = await scenario();
    await mkdir(join(linked.xdg, 'playbook'), { recursive: true, mode: 0o700 });
    await writeFile(linked.path, `${value}\n`, { mode: 0o600 });
    await link(linked.path, join(linked.xdg, 'playbook', 'twin'));
    await expect(resolveMachineIdentity({ env: linked.env })).rejects.toMatchObject({
      code: UNAVAILABLE,
      message: expect.stringContaining(linked.path),
    });

    const symlinked = await scenario();
    await mkdir(join(symlinked.xdg, 'playbook'), { recursive: true, mode: 0o700 });
    await writeFile(join(symlinked.root, 'elsewhere'), `${value}\n`, { mode: 0o600 });
    await symlink(join(symlinked.root, 'elsewhere'), symlinked.path);
    await expect(resolveMachineIdentity({ env: symlinked.env })).rejects.toMatchObject({ code: UNAVAILABLE });

    const foreign = await scenario();
    await mkdir(join(foreign.xdg, 'playbook'), { recursive: true, mode: 0o700 });
    await writeFile(foreign.path, `${value}\n`, { mode: 0o600 });
    const fsOps = {
      lstat: async (target: string) => {
        const stat = await lstat(target);
        if (target === foreign.path) Object.defineProperty(stat, 'uid', { value: stat.uid + 1 });
        return stat;
      },
    };
    await expect(resolveWithFileOperations({ env: foreign.env, fsOps })).rejects.toMatchObject({ code: UNAVAILABLE });

    const unreadable = await scenario();
    await mkdir(join(unreadable.xdg, 'playbook'), { recursive: true, mode: 0o700 });
    await writeFile(unreadable.path, `${value}\n`, { mode: 0o600 });
    await chmod(unreadable.path, 0o000);
    await expect(resolveMachineIdentity({ env: unreadable.env })).rejects.toMatchObject({ code: UNAVAILABLE });
    await chmod(unreadable.path, 0o600);
  });

  it('never replaces a malformed file and refuses until it is repaired', async () => {
    const { env, path, xdg } = await scenario();
    await mkdir(join(xdg, 'playbook'), { recursive: true, mode: 0o700 });
    for (const bytes of ['nonsense\n', 'machine-id:v1:not-a-uuid\n', `machine-id:v1:${randomUUID()}\nmachine-id:v1:${randomUUID()}\n`, '']) {
      await writeFile(path, bytes, { mode: 0o600 });
      await expect(resolveMachineIdentity({ env })).rejects.toMatchObject({
        code: UNAVAILABLE,
        message: expect.stringContaining(path),
      });
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
    const value = `machine-id:v1:${randomUUID()}`;
    await writeFile(path, value, { mode: 0o600 });
    expect(await resolveMachineIdentity({ env })).toBe(value);
  });

  it('is unavailable when its directory cannot be a private directory of the user', async () => {
    const { env, xdg, root } = await scenario();
    await mkdir(xdg, { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'target'), { mode: 0o700 });
    await symlink(join(root, 'target'), join(xdg, 'playbook'));
    await expect(resolveMachineIdentity({ env })).rejects.toMatchObject({ code: UNAVAILABLE });
    expect(await readdir(join(root, 'target'))).toEqual([]);
  });
});

describe('leases and claims carry the machine identity (PBCLI-23/59)', () => {
  const sessionId = '90000000-0000-4000-8000-000000000031';
  const token = () => randomUUID();

  async function sessionsDirFor(root: string) {
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    return sessionsDir;
  }

  async function writeOwner(sessionsDir: string, owner: Record<string, unknown>) {
    const lock = join(sessionsDir, `.${sessionId}.lock`);
    const stage = join(sessionsDir, `.${sessionId}.lock.stage.test`);
    await mkdir(stage, { mode: 0o700 });
    await writeFile(join(stage, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    await rename(stage, lock);
  }

  it('publishes the tagged identity in a session lease and refuses to publish while it is unavailable', async () => {
    const { root, env, home, path, xdg } = await scenario();
    const sessionsDir = await sessionsDirFor(root);
    const store = createCaptainSessionStore({ sessionsDir, env, homeDir: home, createLeaseToken: token });
    const lease = await store.acquire(sessionId);
    const owner = JSON.parse(await readFile(join(sessionsDir, `.${sessionId}.lock`, 'owner.json'), 'utf8'));
    expect(owner.hostname).toBe(await resolveMachineIdentity({ env }));
    expect(owner.hostname).toMatch(TAGGED);
    expect(await readFile(path, 'utf8')).toBe(`${owner.hostname}\n`);
    await lease.release();

    const broken = await scenario();
    await mkdir(join(broken.xdg, 'playbook'), { recursive: true, mode: 0o700 });
    await writeFile(broken.path, 'nonsense\n', { mode: 0o600 });
    const refused = createCaptainSessionStore({ sessionsDir, env: broken.env, homeDir: broken.home, createLeaseToken: token });
    await expect(refused.acquire(sessionId)).rejects.toThrow(`machine identity file ${broken.path} is unavailable`);
    expect((await readdir(sessionsDir)).filter((name) => name === `.${sessionId}.lock`)).toEqual([]);
    expect(await readdir(join(broken.xdg, 'playbook'))).toEqual(['machine-id']);
    void xdg;
  });

  it('reclaims a dead tagged owner of this machine and refuses another machine, naming the identity', async () => {
    const { root, env, home } = await scenario();
    const sessionsDir = await sessionsDirFor(root);
    const identity = await resolveMachineIdentity({ env });
    const base = { schemaVersion: 1, kind: 'captain-session-lease', sessionId, pid: 4242, acquiredAt: '2026-09-30T00:00:00.000Z' };
    const deadToken = token();
    await writeOwner(sessionsDir, { ...base, ownerToken: deadToken, hostname: identity });
    const dead = createCaptainSessionStore({
      sessionsDir, env, homeDir: home, createLeaseToken: token,
      probeProcess: async () => { throw processError('ESRCH'); },
    });
    const successor = await dead.acquire(sessionId);
    await successor.assertOwner();
    expect(await readdir(sessionsDir)).toContain(`.${sessionId}.lock.retired.${deadToken}`);
    await successor.release();

    const other = `machine-id:v1:${randomUUID()}`;
    await writeOwner(sessionsDir, { ...base, ownerToken: token(), hostname: other });
    const foreign = createCaptainSessionStore({ sessionsDir, env, homeDir: home, createLeaseToken: token, probeProcess: async () => { throw processError('ESRCH'); } });
    await expect(foreign.acquire(sessionId)).rejects.toMatchObject({
      code: 'PLAYBOOK_SESSION_LEASE_ACTIVE',
      message: expect.stringContaining(`another machine (identity ${JSON.stringify(other)})`),
    });
    expect(await foreign.readLeaseState(sessionId)).toBe('unknown');
  });

  it('applies the legacy host-name rule to untagged owners and refuses a value that only looks tagged', async () => {
    const { root, env, home } = await scenario();
    const sessionsDir = await sessionsDirFor(root);
    const base = { schemaVersion: 1, kind: 'captain-session-lease', sessionId, pid: 4242, acquiredAt: '2026-09-30T00:00:00.000Z' };
    const esrch = async () => { throw processError('ESRCH'); };
    await writeOwner(sessionsDir, { ...base, ownerToken: token(), hostname: hostname() });
    const reclaimer = createCaptainSessionStore({ sessionsDir, env, homeDir: home, createLeaseToken: token, probeProcess: esrch });
    const successor = await reclaimer.acquire(sessionId);
    const owner = JSON.parse(await readFile(join(sessionsDir, `.${sessionId}.lock`, 'owner.json'), 'utf8'));
    expect(owner.hostname).toMatch(TAGGED);
    await successor.release();

    await writeOwner(sessionsDir, { ...base, ownerToken: token(), hostname: `${hostname()}.renamed` });
    await expect(reclaimer.acquire(sessionId)).rejects.toMatchObject({
      code: 'PLAYBOOK_SESSION_LEASE_ACTIVE',
      message: expect.stringContaining('foreign host'),
    });

    await rm(join(sessionsDir, `.${sessionId}.lock`), { recursive: true, force: true });
    await writeOwner(sessionsDir, { ...base, ownerToken: token(), hostname: 'machine-id:v1:not-a-uuid' });
    await expect(reclaimer.acquire(sessionId)).rejects.toThrow(/cannot be verified/);
    expect(await reclaimer.readLeaseState(sessionId)).toBe('unknown');
  });

  it('publishes the tagged identity in a repository claim and classifies owners the same way', async () => {
    const { root, env, home } = await scenario();
    const repo = join(root, 'repo');
    await mkdir(repo, { mode: 0o700 });
    // The fixture's Git runs without the developer's signing setup, as
    // repository-effects.test.ts runs its own.
    const git = (...args: string[]) => execFileAsync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args]);
    for (const args of [['init', '--quiet'], ['config', 'user.name', 'Identity Test'], ['config', 'user.email', 'identity@example.invalid']]) {
      await git(...args);
    }
    await writeFile(join(repo, 'base.txt'), 'base\n');
    await git('add', '--all');
    await git('commit', '--quiet', '-m', 'base');
    const identity = await resolveMachineIdentity({ env });

    const coordinator = createRepositoryEffectCoordinator({ env, homeDir: home, pollIntervalMs: 2 });
    const claim = await coordinator.acquire(repo);
    const root_ = join(repo, '.git', 'playbook-effect-claims');
    const active = JSON.parse(await readFile(join(root_, 'active', 'owner.json'), 'utf8'));
    expect(active.hostname).toBe(identity);
    await claim.release();

    const other = `machine-id:v1:${randomUUID()}`;
    await mkdir(join(root_, 'stage'), { mode: 0o700 });
    await writeFile(join(root_, 'stage', 'owner.json'), `${JSON.stringify({ schema: 1, ownerToken: randomUUID(), pid: 4242, hostname: other })}\n`, { mode: 0o600 });
    await rename(join(root_, 'stage'), join(root_, 'active'));
    await expect(
      createRepositoryEffectCoordinator({ env, homeDir: home, pollIntervalMs: 2, probeProcess: async () => 'dead' }).acquire(repo),
    ).rejects.toThrow(`another machine (identity ${JSON.stringify(other)})`);

    await rm(join(root_, 'active'), { recursive: true, force: true });
    await mkdir(join(root_, 'stage'), { mode: 0o700 });
    await writeFile(join(root_, 'stage', 'owner.json'), `${JSON.stringify({ schema: 1, ownerToken: randomUUID(), pid: 4242, hostname: hostname() })}\n`, { mode: 0o600 });
    await rename(join(root_, 'stage'), join(root_, 'active'));
    const legacy = await createRepositoryEffectCoordinator({ env, homeDir: home, pollIntervalMs: 2, probeProcess: async () => 'dead' }).acquire(repo);
    expect(JSON.parse(await readFile(join(root_, 'active', 'owner.json'), 'utf8')).hostname).toBe(identity);
    await legacy.release();

    const broken = await scenario();
    await mkdir(join(broken.xdg, 'playbook'), { recursive: true, mode: 0o700 });
    await writeFile(broken.path, 'nonsense\n', { mode: 0o600 });
    await expect(
      createRepositoryEffectCoordinator({ env: broken.env, homeDir: broken.home, pollIntervalMs: 2 }).acquire(repo),
    ).rejects.toMatchObject({ code: UNAVAILABLE });
  });
});
