// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  chmod,
  mkdtemp,
  open,
  readFile,
  readdir,
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
const firstId = '90000000-0000-4000-8000-000000000021';
const secondId = '90000000-0000-4000-8000-000000000022';

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

function complete(sessionId = firstId) {
  return {
    sessionId,
    cwd: process.cwd(),
    config: { schemaVersion: 1 },
    snapshot: { schemaVersion: 1, marker: sessionId },
  };
}

describe('complete Captain session store (PBCLI-24)', () => {
  it('uses the XDG state contract and atomically replaces private records', async () => {
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
    const instants = [
      new Date('2026-08-11T21:00:00.000Z'),
      new Date('2025-01-01T00:00:00.000Z'),
    ];
    const store = createCaptainSessionStore({
      sessionsDir,
      now: () => instants.shift()!,
    });
    const created = await store.commitNew(complete());
    const updated = await store.commitNext(created, {
      schemaVersion: 1,
      marker: 'continued',
    });

    expect(created).toMatchObject({
      schemaVersion: 2,
      kind: 'captain-session',
      sessionId: firstId,
      createdAt: '2026-08-11T21:00:00.000Z',
      updatedAt: '2026-08-11T21:00:00.000Z',
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBe('2026-08-11T21:00:00.001Z');
    expect(updated.snapshot.marker).toBe('continued');
    expect(await store.read(firstId)).toEqual(updated);
    expect(await readdir(sessionsDir)).toEqual([`${firstId}.json`]);
    expect((await stat(sessionsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(sessionsDir, `${firstId}.json`))).mode & 0o777)
      .toBe(0o600);
  });

  it('selects by canonical updatedAt with a deterministic id tie-break', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = createCaptainSessionStore({
      sessionsDir,
      now: () => new Date('2026-08-11T21:10:00.000Z'),
    });
    await store.commitNew(complete(firstId));
    await store.commitNew(complete(secondId));
    expect((await store.latest()).sessionId).toBe(secondId);
  });

  it('does not clobber an existing fresh UUID record', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = createCaptainSessionStore({ sessionsDir });
    await store.commitNew(complete());
    const before = await readFile(join(sessionsDir, `${firstId}.json`), 'utf8');
    await expect(
      store.commitNew({
        ...complete(),
        snapshot: { schemaVersion: 1, marker: 'must-not-win' },
      }),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'))
      .toBe(before);
  });

  it('cleans the temp and publishes nothing when file sync or new publication fails', async () => {
    for (const boundary of ['file-sync', 'link'] as const) {
      const { sessionsDir } = await fixtureDir();
      const store = createCaptainSessionStore({
        sessionsDir,
        fsOps:
          boundary === 'link'
            ? {
                async link() {
                  throw new Error('synthetic link failure');
                },
              }
            : {
                async open(path: string, flags: string | number, mode?: number) {
                  const handle = await open(path, flags as any, mode);
                  if (flags !== 'wx') return handle;
                  return {
                    chmod: (value: number) => handle.chmod(value),
                    stat: () => handle.stat(),
                    writeFile: (value: string, encoding: BufferEncoding) =>
                      handle.writeFile(value, encoding),
                    async sync() {
                      throw new Error('synthetic file sync failure');
                    },
                    close: () => handle.close(),
                  };
                },
              },
      });
      await expect(store.commitNew(complete())).rejects.toThrow(
        new RegExp(`synthetic ${boundary.replace('-', ' ')} failure`),
      );
      expect(await readdir(sessionsDir)).toEqual([]);
    }
  });

  it('keeps the old continuation bytes and removes its temp when rename fails', async () => {
    const { sessionsDir } = await fixtureDir();
    const base = createCaptainSessionStore({
      sessionsDir,
      now: () => new Date('2026-08-11T21:30:00.000Z'),
    });
    const prior = await base.commitNew(complete());
    const path = join(sessionsDir, `${firstId}.json`);
    const before = await readFile(path, 'utf8');
    const failing = createCaptainSessionStore({
      sessionsDir,
      now: () => new Date('2026-08-11T21:30:01.000Z'),
      fsOps: {
        async rename() {
          throw new Error('synthetic rename failure');
        },
      },
    });
    await expect(
      failing.commitNext(prior, { schemaVersion: 1, marker: 'must-not-win' }),
    ).rejects.toThrow(/synthetic rename failure/);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readdir(sessionsDir)).toEqual([`${firstId}.json`]);
  });

  it('rejects a directory-sync failure after atomic publication', async () => {
    const { sessionsDir } = await fixtureDir();
    const base = createCaptainSessionStore({
      sessionsDir,
      now: () => new Date('2026-08-11T21:40:00.000Z'),
    });
    const prior = await base.commitNew(complete());
    const failing = createCaptainSessionStore({
      sessionsDir,
      now: () => new Date('2026-08-11T21:40:01.000Z'),
      fsOps: {
        async open(path: string, flags: string | number, mode?: number) {
          if (path === sessionsDir && flags === 'r') {
            return {
              async sync() {
                throw new Error('synthetic directory sync failure');
              },
              async close() {},
            };
          }
          return open(path, flags as any, mode);
        },
      },
    });
    await expect(
      failing.commitNext(prior, { schemaVersion: 1, marker: 'published' }),
    ).rejects.toThrow(/synthetic directory sync failure/);
    // Rename already published complete bytes; Task 8 will add uncertain-turn
    // recovery, but Task 7 must still withhold stdout on this durability error.
    expect((await base.read(firstId)).snapshot.marker).toBe('published');
    expect(await readdir(sessionsDir)).toEqual([`${firstId}.json`]);
  });

  it('fails closed on a malformed canonical record instead of falling back', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = createCaptainSessionStore({
      sessionsDir,
      now: () => new Date('2026-08-11T21:20:00.000Z'),
    });
    await store.commitNew(complete(firstId));
    await store.commitNew(complete(secondId));
    await writeFile(
      join(sessionsDir, `${secondId}.json`),
      '{"schemaVersion":1}\n',
      'utf8',
    );
    await expect(store.latest()).rejects.toThrow(/missing field|not supported/);
  });

  it('rejects unsafe ids, open schemas, accessors, and non-JSON values', async () => {
    expect(() =>
      validateCaptainSessionRecord({
        schemaVersion: 1,
        kind: 'captain-session',
        sessionId: firstId,
        createdAt: '2026-08-11T21:00:00.000Z',
        updatedAt: '2026-08-11T21:00:00.000Z',
        cwd: process.cwd(),
        config: {},
        snapshot: {},
      }),
    ).toThrow(/schema.*not supported/);

    const { sessionsDir } = await fixtureDir();
    const store = createCaptainSessionStore({ sessionsDir });
    await expect(store.read('../escape')).rejects.toThrow(/must be a UUID/);
    await expect(
      store.commitNew({
        ...complete(),
        config: { bad: undefined },
      }),
    ).rejects.toThrow(/JSON/);

    let getterCalls = 0;
    const config = {};
    Object.defineProperty(config, 'bad', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'unsafe';
      },
    });
    await expect(store.commitNew({ ...complete(), config }))
      .rejects.toThrow(/data propert|accessor/i);
    expect(getterCalls).toBe(0);
  });

  it('refuses symlink stores and non-private record files', async () => {
    const { root, sessionsDir } = await fixtureDir();
    const target = join(root, 'real-sessions');
    await chmod(root, 0o700);
    await (await import('node:fs/promises')).mkdir(target, { mode: 0o700 });
    await symlink(target, sessionsDir);
    const linkedStore = createCaptainSessionStore({ sessionsDir });
    await expect(linkedStore.commitNew(complete())).rejects.toThrow(
      /not a real directory/,
    );

    const second = await fixtureDir();
    const store = createCaptainSessionStore({ sessionsDir: second.sessionsDir });
    await store.commitNew(complete());
    await symlink(
      `${firstId}.json`,
      join(second.sessionsDir, `${secondId}.json`),
    );
    await expect(store.read(secondId)).rejects.toThrow(/cannot read/);
    await chmod(join(second.sessionsDir, `${firstId}.json`), 0o644);
    await expect(store.read(firstId)).rejects.toThrow(/0600/);
    await chmod(join(second.sessionsDir, `${firstId}.json`), 0o600);
    await chmod(second.sessionsDir, 0o500);
    await expect(store.read(firstId)).rejects.toThrow(/0700/);
    await chmod(second.sessionsDir, 0o700);
  });
});
