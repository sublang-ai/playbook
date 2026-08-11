// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCaptainSessionStore,
  defaultCaptainSessionsDir,
  validateCaptainSessionRecord,
} from './bin/session-store.js';

const tempDirs: string[] = [];
const sessionId = '90000000-0000-4000-8000-000000000021';
const secondSessionId = '90000000-0000-4000-8000-000000000025';
const attempt1 = '90000000-0000-4000-8000-000000000022';
const attempt2 = '90000000-0000-4000-8000-000000000023';
const attempt3 = '90000000-0000-4000-8000-000000000024';
const tokenO = 'a0000000-0000-4000-8000-000000000001';
const tokenN = 'a0000000-0000-4000-8000-000000000002';
const tokenR = 'a0000000-0000-4000-8000-000000000003';
const tokenThird = 'a0000000-0000-4000-8000-000000000004';
const tempId = 'b0000000-0000-4000-8000-000000000001';
const instant = new Date('2026-08-11T21:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixtureDir() {
  const root = await mkdtemp(join(tmpdir(), 'captain-session-store-'));
  tempDirs.push(root);
  return { root, sessionsDir: join(root, 'sessions') };
}

function freshBoundary(marker = 'baseline') {
  return {
    cwd: process.cwd(),
    config: { schemaVersion: 1, marker: 'config' },
    snapshot: { schemaVersion: 1, marker },
  };
}

function fixedStore(
  sessionsDir: string,
  ownerToken: string,
  options: Record<string, unknown> = {},
) {
  return createCaptainSessionStore({
    sessionsDir,
    now: () => instant,
    hostname: 'test-host',
    pid: 101,
    createLeaseToken: () => ownerToken,
    ...options,
  });
}

function processError(code: string) {
  return Object.assign(new Error(`process probe ${code}`), { code });
}

function settledRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    kind: 'captain-session',
    state: 'settled',
    sessionId,
    createdAt: '2026-08-11T21:00:00.000Z',
    updatedAt: '2026-08-11T21:00:00.001Z',
    cwd: process.cwd(),
    config: { schemaVersion: 1 },
    snapshot: { schemaVersion: 1 },
    ...overrides,
  };
}

function leaseOwner(
  ownerToken = tokenO,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    kind: 'captain-session-lease',
    sessionId,
    ownerToken,
    pid: 101,
    hostname: 'test-host',
    acquiredAt: '2026-08-11T21:00:00.000Z',
    ...overrides,
  };
}

describe('durable Captain session records (PBCLI-23/24)', () => {
  it('uses the XDG location and advances fresh, retry, settle, and exact discard boundaries', async () => {
    expect(
      defaultCaptainSessionsDir(
        { XDG_STATE_HOME: '/state', HOME: '/home' },
        '/home',
      ),
    ).toBe('/state/playbook/sessions');
    expect(defaultCaptainSessionsDir({ HOME: '/home' }, '/home')).toBe(
      '/home/.local/state/playbook/sessions',
    );

    const { sessionsDir } = await fixtureDir();
    const firstStore = fixedStore(sessionsDir, tokenO);
    const firstLease = await firstStore.acquire(sessionId);
    const canonicalLease = join(sessionsDir, `.${sessionId}.lock`);
    expect((await stat(canonicalLease)).mode & 0o777).toBe(0o700);
    expect(await readdir(canonicalLease)).toEqual(['owner.json']);
    expect((await stat(join(canonicalLease, 'owner.json'))).mode & 0o777)
      .toBe(0o600);
    const uncertain = await firstLease.beginTurn({
      input: '  exact input\n',
      attemptId: attempt1,
      fresh: freshBoundary(),
    });
    expect(uncertain).toMatchObject({
      schemaVersion: 2,
      kind: 'captain-session',
      state: 'uncertain',
      sessionId,
      uncertain: {
        baseUpdatedAt: null,
        input: '  exact input\n',
        attemptId: attempt1,
        attemptNumber: 1,
      },
    });
    expect(Object.isFrozen(uncertain)).toBe(true);
    const firstSettled = await firstLease.settle({
      attemptId: attempt1,
      snapshot: { schemaVersion: 1, marker: 'settled' },
    });
    expect(firstSettled.state).toBe('settled');
    expect(firstSettled).not.toHaveProperty('uncertain');
    await firstLease.release();

    const recordPath = join(sessionsDir, `${sessionId}.json`);
    const settledBytes = await readFile(recordPath, 'utf8');
    expect((await stat(sessionsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(sessionsDir)).toContain(
      `.${sessionId}.lock.retired.${tokenO}`,
    );
    const firstTombstone = join(
      sessionsDir,
      `.${sessionId}.lock.retired.${tokenO}`,
    );
    expect((await stat(firstTombstone)).mode & 0o777).toBe(0o700);
    expect(await readdir(firstTombstone)).toEqual(['owner.json']);
    expect((await stat(join(firstTombstone, 'owner.json'))).mode & 0o777)
      .toBe(0o600);

    const secondStore = fixedStore(sessionsDir, tokenN);
    const secondLease = await secondStore.acquire(sessionId);
    const continued = await secondLease.beginTurn({
      input: 'continued',
      attemptId: attempt2,
    });
    expect(continued.uncertain).toMatchObject({
      baseUpdatedAt: firstSettled.updatedAt,
      attemptNumber: 1,
    });
    const retried = await secondLease.beginRetry({
      expectedAttemptId: attempt2,
      nextAttemptId: attempt3,
    });
    expect(retried.uncertain).toMatchObject({
      input: 'continued',
      attemptId: attempt3,
      attemptNumber: 2,
      baseUpdatedAt: firstSettled.updatedAt,
    });
    await secondLease.discard({ attemptId: attempt3 });
    expect(await readFile(recordPath, 'utf8')).toBe(settledBytes);
    await secondLease.release();

    const collisionLease = await fixedStore(
      sessionsDir,
      tokenR,
    ).acquire(sessionId);
    await expect(
      collisionLease.beginTurn({
        input: 'must not overwrite',
        attemptId: attempt2,
        fresh: freshBoundary('collision'),
      }),
    ).rejects.toThrow(/fresh Captain session record already exists/);
    expect(await readFile(recordPath, 'utf8')).toBe(settledBytes);
    expect((await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')))
      .toBe(false);
    await collisionLease.release();
  });

  it('deletes a never-settled fresh marker and validates the exact union', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    const uncertain = await lease.beginTurn({
      input: 'fresh work',
      attemptId: attempt1,
      fresh: freshBoundary(),
    });
    expect(validateCaptainSessionRecord(uncertain)).toEqual(uncertain);
    await lease.discard({ attemptId: attempt1 });
    await expect(store.read(sessionId)).rejects.toThrow(/does not exist/);
    await lease.release();

    expect(() =>
      validateCaptainSessionRecord(settledRecord({ state: 'unknown' })),
    ).toThrow(/state.*not supported/);
    expect(() =>
      validateCaptainSessionRecord({ ...settledRecord(), internal: true }),
    ).toThrow(/unknown field/);
    expect(() =>
      validateCaptainSessionRecord({
        ...settledRecord({
          state: 'uncertain',
          updatedAt: '2026-08-11T21:00:00.002Z',
        }),
        uncertain: {
          baseUpdatedAt: '2026-08-11T21:00:00.001Z',
          input: 'work',
          attemptId: attempt1,
          attemptNumber: 1,
          markedAt: '2026-08-11T21:00:00.009Z',
        },
      }),
    ).toThrow(/markedAt must equal updatedAt/);
    expect(() =>
      validateCaptainSessionRecord({
        ...settledRecord(),
        config: { invalid: undefined },
      }),
    ).toThrow(/JSON/);

    let getterCalls = 0;
    const config = {};
    Object.defineProperty(config, 'unsafe', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'value';
      },
    });
    expect(() =>
      validateCaptainSessionRecord({ ...settledRecord(), config }),
    ).toThrow(/data propert|accessor/i);
    expect(getterCalls).toBe(0);
  });

  it('requires the current owner and exact uncertain attempt for every mutation', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    await lease.beginTurn({
      input: 'work',
      attemptId: attempt1,
      fresh: freshBoundary(),
    });
    await expect(
      lease.settle({ attemptId: attempt2, snapshot: { marker: 'wrong' } }),
    ).rejects.toThrow(/attempt id changed/);
    expect((await store.read(sessionId)).state).toBe('uncertain');

    const ownerPath = join(sessionsDir, `.${sessionId}.lock`, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    await writeFile(
      ownerPath,
      `${JSON.stringify({ ...owner, ownerToken: tokenN })}\n`,
      'utf8',
    );
    await expect(lease.assertOwner()).rejects.toThrow(/different token/);
    await expect(
      lease.settle({ attemptId: attempt1, snapshot: { marker: 'blocked' } }),
    ).rejects.toThrow(/different token/);
    await expect(lease.release()).rejects.toThrow(/different token/);
    expect((await store.read(sessionId)).state).toBe('uncertain');
  });

  it('cleans unpublished record temps after file-sync and no-replace publication failures', async () => {
    for (const boundary of ['file-sync', 'link'] as const) {
      const { sessionsDir } = await fixtureDir();
      const store = fixedStore(sessionsDir, tokenO, {
        createTempId: () => tempId,
        fsOps:
          boundary === 'link'
            ? {
                async link() {
                  throw new Error('synthetic record link failure');
                },
              }
            : {
                async open(
                  path: string,
                  flags: string | number,
                  mode?: number,
                ) {
                  const handle = await open(path, flags as any, mode);
                  if (flags !== 'wx' || !String(path).endsWith('.tmp')) {
                    return handle;
                  }
                  return {
                    chmod: (value: number) => handle.chmod(value),
                    stat: () => handle.stat(),
                    writeFile: (value: string, encoding: BufferEncoding) =>
                      handle.writeFile(value, encoding),
                    async sync() {
                      throw new Error('synthetic record file sync failure');
                    },
                    close: () => handle.close(),
                  };
                },
              },
      });
      const lease = await store.acquire(sessionId);
      await expect(
        lease.beginTurn({
          input: 'must not publish',
          attemptId: attempt1,
          fresh: freshBoundary(),
        }),
      ).rejects.toThrow(
        boundary === 'link'
          ? /synthetic record link failure/
          : /synthetic record file sync failure/,
      );
      const names = await readdir(sessionsDir);
      expect(names).not.toContain(`${sessionId}.json`);
      expect(names.some((name) => name.endsWith('.tmp'))).toBe(false);
      await lease.release();
    }
  });

  it('keeps prior bytes and cleans its temp when a replacement rename fails', async () => {
    const { sessionsDir } = await fixtureDir();
    const firstLease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    await firstLease.beginTurn({
      input: 'first',
      attemptId: attempt1,
      fresh: freshBoundary(),
    });
    await firstLease.settle({
      attemptId: attempt1,
      snapshot: { schemaVersion: 1, marker: 'settled' },
    });
    await firstLease.release();
    const recordPath = join(sessionsDir, `${sessionId}.json`);
    const before = await readFile(recordPath, 'utf8');

    const failing = fixedStore(sessionsDir, tokenN, {
      createTempId: () => tempId,
      fsOps: {
        async rename(from: string, to: string) {
          if (from.endsWith('.tmp') && to === recordPath) {
            throw new Error('synthetic record rename failure');
          }
          return rename(from, to);
        },
      },
    });
    const lease = await failing.acquire(sessionId);
    await expect(
      lease.beginTurn({ input: 'must not replace', attemptId: attempt2 }),
    ).rejects.toThrow(/synthetic record rename failure/);
    expect(await readFile(recordPath, 'utf8')).toBe(before);
    expect((await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')))
      .toBe(false);
    await lease.release();
  });

  it('reports a directory-sync failure after publishing a complete record', async () => {
    const { sessionsDir } = await fixtureDir();
    let failSessionSync = false;
    const store = fixedStore(sessionsDir, tokenO, {
      createTempId: () => tempId,
      fsOps: {
        async open(path: string, flags: string | number, mode?: number) {
          const handle = await open(path, flags as any, mode);
          if (path !== sessionsDir || flags !== 'r') return handle;
          return {
            async sync() {
              if (failSessionSync) {
                throw new Error('synthetic record directory sync failure');
              }
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      },
    });
    const lease = await store.acquire(sessionId);
    failSessionSync = true;
    await expect(
      lease.beginTurn({
        input: 'published before sync',
        attemptId: attempt1,
        fresh: freshBoundary(),
      }),
    ).rejects.toThrow(/synthetic record directory sync failure/);
    expect((await store.read(sessionId)).state).toBe('uncertain');
    expect((await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')))
      .toBe(false);
    failSessionSync = false;
    await lease.release();
  });

  it('reports post-settlement sync failure while exposing only a complete settled replacement', async () => {
    const { sessionsDir } = await fixtureDir();
    let failSessionSync = false;
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: {
        async open(path: string, flags: string | number, mode?: number) {
          const handle = await open(path, flags as any, mode);
          if (path !== sessionsDir || flags !== 'r') return handle;
          return {
            async sync() {
              if (failSessionSync) {
                throw new Error('synthetic settlement directory sync failure');
              }
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      },
    });
    const lease = await store.acquire(sessionId);
    await lease.beginTurn({
      input: 'first turn',
      attemptId: attempt1,
      fresh: freshBoundary(),
    });
    await lease.settle({
      attemptId: attempt1,
      snapshot: { schemaVersion: 1, marker: 'first settled' },
    });
    await lease.beginTurn({ input: 'second turn', attemptId: attempt2 });
    failSessionSync = true;
    await expect(
      lease.settle({
        attemptId: attempt2,
        snapshot: { schemaVersion: 1, marker: 'replacement settled' },
      }),
    ).rejects.toThrow(/synthetic settlement directory sync failure/);
    failSessionSync = false;
    expect(await store.read(sessionId)).toMatchObject({
      state: 'settled',
      snapshot: { marker: 'replacement settled' },
    });
    await lease.release();
  });

  it('selects tied records deterministically and fails closed on canonical corruption', async () => {
    const { sessionsDir } = await fixtureDir();
    for (const [id, token, attempt] of [
      [sessionId, tokenO, attempt1],
      [secondSessionId, tokenN, attempt2],
    ] as const) {
      const lease = await fixedStore(sessionsDir, token).acquire(id);
      await lease.beginTurn({
        input: `turn for ${id}`,
        attemptId: attempt,
        fresh: freshBoundary(id),
      });
      await lease.settle({
        attemptId: attempt,
        snapshot: { schemaVersion: 1, marker: id },
      });
      await lease.release();
    }
    const store = fixedStore(sessionsDir, tokenR);
    expect((await store.latest()).sessionId).toBe(secondSessionId);
    const secondPath = join(sessionsDir, `${secondSessionId}.json`);
    const wrongEmbeddedId = JSON.parse(await readFile(secondPath, 'utf8'));
    await writeFile(
      secondPath,
      `${JSON.stringify({ ...wrongEmbeddedId, sessionId })}\n`,
      'utf8',
    );
    await expect(store.read(secondSessionId)).rejects.toThrow(
      /contains record/,
    );
    await writeFile(
      secondPath,
      '{"schemaVersion":2}\n',
      'utf8',
    );
    await expect(store.latest()).rejects.toThrow(/missing field|not supported/);
  });

  it('rejects symlink storage and non-private record boundaries', async () => {
    const first = await fixtureDir();
    const target = join(first.root, 'real-sessions');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, first.sessionsDir);
    await expect(
      fixedStore(first.sessionsDir, tokenO).acquire(sessionId),
    ).rejects.toThrow(/not a real directory/);

    const second = await fixtureDir();
    const store = fixedStore(second.sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    await lease.beginTurn({
      input: 'private record',
      attemptId: attempt1,
      fresh: freshBoundary(),
    });
    await lease.settle({
      attemptId: attempt1,
      snapshot: { schemaVersion: 1, marker: 'settled' },
    });
    await lease.release();
    const recordPath = join(second.sessionsDir, `${sessionId}.json`);
    await symlink(
      `${sessionId}.json`,
      join(second.sessionsDir, `${secondSessionId}.json`),
    );
    await expect(store.read(secondSessionId)).rejects.toThrow(/cannot read/);
    await chmod(recordPath, 0o644);
    await expect(store.read(sessionId)).rejects.toThrow(/0600/);
    await chmod(recordPath, 0o600);
    await chmod(second.sessionsDir, 0o500);
    await expect(store.read(sessionId)).rejects.toThrow(/0700/);
    await chmod(second.sessionsDir, 0o700);
  });
});

describe('exclusive Captain session leases (PBCLI-23/24)', () => {
  it('fails closed for live, foreign, and permission-unknown owners and reclaims only ESRCH', async () => {
    const { sessionsDir } = await fixtureDir();
    const ownerStore = fixedStore(sessionsDir, tokenO, {
      hostname: 'shared-host',
      pid: 111,
    });
    await ownerStore.acquire(sessionId);
    const ownerPath = join(
      sessionsDir,
      `.${sessionId}.lock`,
      'owner.json',
    );
    const ancientOwner = JSON.parse(await readFile(ownerPath, 'utf8'));
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        ...ancientOwner,
        acquiredAt: '2000-01-01T00:00:00.000Z',
      })}\n`,
      'utf8',
    );

    await expect(
      fixedStore(sessionsDir, tokenN, {
        hostname: 'shared-host',
        pid: 222,
        probeProcess: async () => {},
      }).acquire(sessionId),
    ).rejects.toThrow(/active in process 111/);
    await expect(
      fixedStore(sessionsDir, tokenN, {
        hostname: 'other-host',
        pid: 222,
      }).acquire(sessionId),
    ).rejects.toThrow(/foreign host/);
    await expect(
      fixedStore(sessionsDir, tokenN, {
        hostname: 'shared-host',
        pid: 222,
        probeProcess: async () => {
          throw processError('EPERM');
        },
      }).acquire(sessionId),
    ).rejects.toThrow(/cannot be ruled dead/);

    const successor = await fixedStore(sessionsDir, tokenN, {
      hostname: 'shared-host',
      pid: 222,
      probeProcess: async () => {
        throw processError('ESRCH');
      },
    }).acquire(sessionId);
    await successor.assertOwner();
    expect(await readdir(sessionsDir)).toContain(
      `.${sessionId}.lock.retired.${tokenO}`,
    );
    await successor.release();
  });

  it('rejects malformed canonical leases before probing and cleans its own stage', async () => {
    const cases = [
      {
        name: 'missing owner',
        expected: /incomplete or malformed/,
        mutate: async (_root: string, _lock: string, ownerPath: string) => {
          await rm(ownerPath);
        },
      },
      {
        name: 'extra entry',
        expected: /incomplete or malformed/,
        mutate: async (_root: string, lock: string) => {
          await writeFile(join(lock, 'extra'), 'unexpected\n', { mode: 0o600 });
        },
      },
      {
        name: 'invalid owner JSON',
        expected: /not valid JSON/,
        mutate: async (_root: string, _lock: string, ownerPath: string) => {
          await writeFile(ownerPath, '{invalid\n', 'utf8');
        },
      },
      {
        name: 'non-private owner',
        expected: /0600/,
        mutate: async (_root: string, _lock: string, ownerPath: string) => {
          await chmod(ownerPath, 0o644);
        },
      },
      {
        name: 'symlink owner',
        expected: /real regular file/,
        mutate: async (root: string, _lock: string, ownerPath: string) => {
          const target = join(root, 'owner-target');
          await writeFile(target, `${JSON.stringify(leaseOwner())}\n`, {
            mode: 0o600,
          });
          await rm(ownerPath);
          await symlink(target, ownerPath);
        },
      },
      {
        name: 'non-private lock',
        expected: /private real directory/,
        mutate: async (_root: string, lock: string) => {
          await chmod(lock, 0o755);
        },
      },
    ] as const;

    for (const row of cases) {
      const { root, sessionsDir } = await fixtureDir();
      await mkdir(sessionsDir, { mode: 0o700 });
      const lock = join(sessionsDir, `.${sessionId}.lock`);
      await mkdir(lock, { mode: 0o700 });
      const ownerPath = join(lock, 'owner.json');
      await writeFile(ownerPath, `${JSON.stringify(leaseOwner())}\n`, {
        mode: 0o600,
      });
      await row.mutate(root, lock, ownerPath);
      let probes = 0;
      await expect(
        fixedStore(sessionsDir, tokenN, {
          probeProcess: async () => {
            probes += 1;
          },
        }).acquire(sessionId),
        row.name,
      ).rejects.toThrow(row.expected);
      expect(probes, row.name).toBe(0);
      expect(await readdir(sessionsDir), row.name).toContain(
        `.${sessionId}.lock`,
      );
      expect(
        (await readdir(sessionsDir)).some((name) => name.includes('.stage.')),
        row.name,
      ).toBe(false);
    }
  });

  it('cleans lease stages when owner creation or either stage sync fails', async () => {
    for (const boundary of [
      'owner-open',
      'owner-sync',
      'stage-directory-sync',
    ] as const) {
      const { sessionsDir } = await fixtureDir();
      const store = fixedStore(sessionsDir, tokenO, {
        fsOps: {
          async open(path: string, flags: string | number, mode?: number) {
            const isStageOwner =
              path.includes('.lock.stage.') && path.endsWith('/owner.json');
            const isStageDirectory =
              path.includes('.lock.stage.') && flags === 'r';
            if (boundary === 'owner-open' && isStageOwner && flags === 'wx') {
              throw new Error('synthetic lease owner open failure');
            }
            const handle = await open(path, flags as any, mode);
            if (boundary === 'owner-sync' && isStageOwner && flags === 'wx') {
              return {
                chmod: (value: number) => handle.chmod(value),
                stat: () => handle.stat(),
                writeFile: (value: string, encoding: BufferEncoding) =>
                  handle.writeFile(value, encoding),
                async sync() {
                  throw new Error('synthetic lease owner sync failure');
                },
                close: () => handle.close(),
              };
            }
            if (boundary === 'stage-directory-sync' && isStageDirectory) {
              return {
                async sync() {
                  throw new Error('synthetic lease directory sync failure');
                },
                close: () => handle.close(),
              };
            }
            return handle;
          },
        },
      });
      await expect(store.acquire(sessionId)).rejects.toThrow(
        new RegExp(`synthetic lease .* ${boundary.endsWith('sync') ? 'sync' : 'open'} failure`),
      );
      expect(await readdir(sessionsDir)).toEqual([]);
    }
  });

  it('rejects unsafe canonical locks, malformed retired guards, and token reuse', async () => {
    const first = await fixtureDir();
    await mkdir(first.sessionsDir, { mode: 0o700 });
    const target = join(first.root, 'target-lock');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(first.sessionsDir, `.${sessionId}.lock`));
    await expect(
      fixedStore(first.sessionsDir, tokenO).acquire(sessionId),
    ).rejects.toThrow(/private real directory/);

    const second = await fixtureDir();
    await mkdir(second.sessionsDir, { mode: 0o700 });
    await mkdir(
      join(second.sessionsDir, `.${sessionId}.lock.retired.not-a-uuid`),
      { mode: 0o700 },
    );
    await expect(
      fixedStore(second.sessionsDir, tokenO).acquire(sessionId),
    ).rejects.toThrow(/retired lease token.*UUID|must be a UUID/);

    const third = await fixtureDir();
    const store = fixedStore(third.sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    await lease.release();
    await expect(
      fixedStore(third.sessionsDir, tokenO).acquire(sessionId),
    ).rejects.toThrow(/already retired/);

    const tombstone = join(
      third.sessionsDir,
      `.${sessionId}.lock.retired.${tokenO}`,
    );
    const retiredOwnerPath = join(tombstone, 'owner.json');
    const retiredOwner = JSON.parse(await readFile(retiredOwnerPath, 'utf8'));
    await writeFile(
      retiredOwnerPath,
      `${JSON.stringify({ ...retiredOwner, ownerToken: tokenN })}\n`,
      'utf8',
    );
    await expect(
      fixedStore(third.sessionsDir, tokenThird).acquire(sessionId),
    ).rejects.toThrow(/retired lease owner token is mismatched/);
    await chmod(tombstone, 0o755);
    await expect(
      fixedStore(third.sessionsDir, tokenN).acquire(sessionId),
    ).rejects.toThrow(/private real directory/);
  });

  it('retires its own canonical lease when failure follows publication', async () => {
    const { sessionsDir } = await fixtureDir();
    await mkdir(sessionsDir, { mode: 0o700 });
    let sessionSyncs = 0;
    const failing = fixedStore(sessionsDir, tokenO, {
      fsOps: {
        async open(path: string, flags: string | number, mode?: number) {
          if (path === sessionsDir && flags === 'r') {
            const handle = await open(path, flags as any, mode);
            return {
              async sync() {
                sessionSyncs += 1;
                if (sessionSyncs === 1) {
                  throw new Error('synthetic post-publication sync failure');
                }
                await handle.sync();
              },
              close: () => handle.close(),
            };
          }
          return open(path, flags as any, mode);
        },
      },
    });
    await expect(failing.acquire(sessionId)).rejects.toThrow(
      /post-publication sync failure/,
    );
    const names = await readdir(sessionsDir);
    expect(names).not.toContain(`.${sessionId}.lock`);
    expect(names).toContain(`.${sessionId}.lock.retired.${tokenO}`);

    const successor = await fixedStore(sessionsDir, tokenN).acquire(sessionId);
    await successor.assertOwner();
    await successor.release();
  });

  it('keeps old-token retirement occupied against a delayed second reclaimer', async () => {
    const { sessionsDir } = await fixtureDir();
    await fixedStore(sessionsDir, tokenO, {
      hostname: 'shared-host',
      pid: 111,
    }).acquire(sessionId);

    let announcePaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      announcePaused = resolve;
    });
    let resumeRename!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeRename = resolve;
    });
    const canonical = join(sessionsDir, `.${sessionId}.lock`);
    const retiredO = join(
      sessionsDir,
      `.${sessionId}.lock.retired.${tokenO}`,
    );
    let held = false;
    const delayedStore = fixedStore(sessionsDir, tokenR, {
      hostname: 'shared-host',
      pid: 333,
      probeProcess: async () => {
        throw processError('ESRCH');
      },
      fsOps: {
        async rename(from: string, to: string) {
          if (!held && from === canonical && to === retiredO) {
            held = true;
            announcePaused();
            await resume;
          }
          return rename(from, to);
        },
      },
    });
    const delayed = delayedStore.acquire(sessionId);
    await paused;

    const successor = await fixedStore(sessionsDir, tokenN, {
      hostname: 'shared-host',
      pid: 222,
      probeProcess: async () => {
        throw processError('ESRCH');
      },
    }).acquire(sessionId);
    resumeRename();
    await expect(delayed).rejects.toThrow(/changed before retirement|occupied/);
    await successor.assertOwner();
    expect(await readdir(sessionsDir)).toContain(
      `.${sessionId}.lock.retired.${tokenO}`,
    );

    await expect(
      fixedStore(sessionsDir, tokenThird, {
        hostname: 'shared-host',
        pid: 444,
        probeProcess: async () => {},
      }).acquire(sessionId),
    ).rejects.toThrow(/active in process 222/);
    await successor.release();
  });
});
