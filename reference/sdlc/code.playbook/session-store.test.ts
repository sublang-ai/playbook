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
  assertCaptainSessionExecutionCompatible,
  captainSessionSelectedMembers,
  createCaptainSessionStore,
  defaultCaptainSessionsDir,
  projectCaptainSessionStructure,
  validateCaptainSessionExecutionProjection,
  validateCaptainSessionRecord,
  validateCaptainSessionStructuralProjection,
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
const captainRuntimeId = '80000000-0000-4000-8000-000000000001';
const frameRuntimeId = '80000000-0000-4000-8000-000000000002';

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

function executionProjection(
  options: {
    captainModel?: string;
    playerModel?: string;
    playerId?: string;
  } = {},
) {
  const playerId = options.playerId ?? 'dev.coder';
  return {
    schemaVersion: 2,
    captain: {
      adapter: 'claude',
      model:
        options.captainModel === undefined
          ? { kind: 'provider-default' }
          : { kind: 'value', value: options.captainModel },
      effort: { kind: 'provider-default' },
      permissions: { mode: 'auto' },
    },
    players: [
      {
        id: playerId,
        adapter: 'codex',
        model:
          options.playerModel === undefined
            ? { kind: 'provider-default' }
            : { kind: 'value', value: options.playerModel },
        effort: { kind: 'value', value: 'high' },
        permissions: { fileWrite: 'ask' },
      },
    ],
    catalog: {
      code: {
        id: 'code',
        from: '@sublang/playbook/code/registry',
        manifestCommand: 'code',
        command: 'code',
        intent: 'Implement a requested change.',
        artifactSchema: 2,
        requiredRoleIds: ['coder'],
        concurrentRoleSets: [],
        roles: {
          coder: {
            playerId,
            model:
              options.playerModel === undefined
                ? { kind: 'provider-default' }
                : { kind: 'value', value: options.playerModel },
            effort: { kind: 'value', value: 'high' },
          },
        },
        options: {},
      },
    },
  };
}

function parkedState(stateId = 'routing') {
  return {
    value: stateId,
    activeStateIds: [stateId],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId,
  };
}

function runtimeSnapshot(playbookId = 'captain', turn = 0) {
  const state = parkedState();
  return {
    schemaVersion: 3,
    playbookId,
    machine: { value: state.value, status: state.status },
    roleResumeTokens: {},
    sequences: {
      trace: 0,
      turn,
      judgeCall: 0,
      playerCall: 0,
      playbookCall: 0,
      captainCall: 0,
    },
    state,
    pendingBossQuestions: [],
  };
}

function shellSnapshot(
  execution = executionProjection(),
  turn = 0,
  token = `captain-token-${turn}`,
) {
  const structural = projectCaptainSessionStructure(execution);
  const journal = Array.from({ length: turn }, (_, index) => ({
    seq: index + 1,
    turnId: index + 1,
    kind: 'boss',
    payload: `turn-${index + 1}`,
  }));
  return {
    schemaVersion: 3,
    captain: {
      sessionId: captainRuntimeId,
      runtime: runtimeSnapshot('captain', turn),
      agent: structural.captain,
      conversation:
        turn === 0
          ? { kind: 'unopened' }
          : { kind: 'pinned', token },
    },
    playerSessions: Object.fromEntries(
      structural.players.map(({ id, ...agent }: any) => [id, agent]),
    ),
    issuedSessionIds: [captainRuntimeId],
    sequences: { turn, journal: journal.length },
    journal,
    ...(turn === 0
      ? {}
      : { lastAction: 'respond', lastSettlementStatus: 'ok' }),
    mode: 'chat',
  };
}

function freshBoundary(execution = executionProjection()) {
  return {
    cwd: process.cwd(),
    structuralProjection: projectCaptainSessionStructure(execution),
    snapshot: shellSnapshot(execution),
  };
}

function engagedSnapshot(execution = executionProjection()) {
  const snapshot = shellSnapshot(execution);
  return {
    ...snapshot,
    issuedSessionIds: [captainRuntimeId, frameRuntimeId],
    mode: 'engaged.parked',
    frames: [
      {
        playbookId: 'code',
        sessionId: frameRuntimeId,
        rootSessionId: frameRuntimeId,
        depth: 0,
        options: { normalizedByRegistry: true },
        roleBindings: { coder: 'dev.coder' },
        runtime: runtimeSnapshot('code'),
      },
    ],
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
  const execution = executionProjection();
  return {
    schemaVersion: 3,
    kind: 'captain-session',
    state: 'settled',
    sessionId,
    createdAt: '2026-08-11T21:00:00.000Z',
    updatedAt: '2026-08-11T21:00:00.001Z',
    cwd: process.cwd(),
    structuralProjection: projectCaptainSessionStructure(execution),
    lastAppliedExecutionProjection: execution,
    snapshot: shellSnapshot(execution),
    ...overrides,
  };
}

function releasedSchema2Record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    kind: 'captain-session',
    state: 'settled',
    sessionId,
    createdAt: '2026-08-11T21:00:00.000Z',
    updatedAt: '2026-08-11T21:00:00.001Z',
    cwd: process.cwd(),
    config: {},
    snapshot: {},
    ...overrides,
  };
}

function freshUncertainRecord(overrides: Record<string, unknown> = {}) {
  const execution = executionProjection();
  return {
    schemaVersion: 3,
    kind: 'captain-session',
    state: 'uncertain',
    sessionId,
    createdAt: '2026-08-11T21:00:00.000Z',
    updatedAt: '2026-08-11T21:00:00.000Z',
    cwd: process.cwd(),
    structuralProjection: projectCaptainSessionStructure(execution),
    lastAppliedExecutionProjection: execution,
    snapshot: shellSnapshot(execution),
    uncertain: {
      baseUpdatedAt: null,
      input: 'fresh input',
      attemptId: attempt1,
      attemptNumber: 1,
      markedAt: '2026-08-11T21:00:00.000Z',
      attemptedExecutionProjection: execution,
    },
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
  it('atomically initializes one validated turn-zero settled record without replacement', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    const execution = executionProjection();
    const structural = projectCaptainSessionStructure(execution);

    await expect(
      lease.initializeSettled({
        cwd: process.cwd(),
        structuralProjection: structural,
        executionProjection: execution,
        snapshot: shellSnapshot(
          executionProjection({ playerId: 'dev.other' }),
        ),
      }),
    ).rejects.toThrow(/player ledger differs/);
    await expect(store.read(sessionId)).rejects.toThrow(/does not exist/);

    const settled = await lease.initializeSettled({
      cwd: process.cwd(),
      structuralProjection: structural,
      executionProjection: execution,
      snapshot: shellSnapshot(execution),
    });
    expect(settled).toMatchObject({
      schemaVersion: 3,
      state: 'settled',
      createdAt: '2026-08-11T21:00:00.000Z',
      updatedAt: '2026-08-11T21:00:00.001Z',
      structuralProjection: { schemaVersion: 1 },
      lastAppliedExecutionProjection: { schemaVersion: 2 },
    });
    const recordPath = join(sessionsDir, `${sessionId}.json`);
    const bytes = await readFile(recordPath, 'utf8');
    await expect(
      lease.initializeSettled({
        cwd: process.cwd(),
        structuralProjection: structural,
        executionProjection: execution,
        snapshot: shellSnapshot(execution),
      }),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(recordPath, 'utf8')).toBe(bytes);
    expect((await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')))
      .toBe(false);
    await lease.release();
  });

  it('validates closed execution and structural projections before effects', () => {
    const execution = executionProjection({
      captainModel: 'captain-current',
      playerModel: 'coder-current',
    });
    const validated = validateCaptainSessionExecutionProjection(execution);
    const structural = projectCaptainSessionStructure(validated);

    expect(Object.isFrozen(validated)).toBe(true);
    expect(validateCaptainSessionStructuralProjection(structural)).toEqual(
      structural,
    );
    expect(captainSessionSelectedMembers(structural)).toEqual({
      playbookIds: ['code'],
      playerIds: ['dev.coder'],
    });
    expect(
      assertCaptainSessionExecutionCompatible(
        structural,
        executionProjection({
          captainModel: 'next-captain',
          playerModel: 'next-coder',
        }),
      ),
    ).toMatchObject({ captain: { model: { value: 'next-captain' } } });
    const retunedEffort = {
      ...execution,
      captain: {
        ...execution.captain,
        effort: { kind: 'value', value: 'high' },
      },
      players: [
        {
          ...execution.players[0],
          effort: { kind: 'provider-default' },
        },
      ],
      catalog: {
        code: {
          ...execution.catalog.code,
          roles: {
            coder: {
              ...execution.catalog.code.roles.coder,
              effort: { kind: 'provider-default' },
            },
          },
        },
      },
    };
    expect(
      assertCaptainSessionExecutionCompatible(structural, retunedEffort),
    ).toMatchObject({
      captain: { effort: { kind: 'value', value: 'high' } },
      players: [{ effort: { kind: 'provider-default' } }],
      catalog: {
        code: {
          roles: { coder: { effort: { kind: 'provider-default' } } },
        },
      },
    });

    const mutations: Array<[string, any, RegExp]> = [
      [
        'unknown field',
        { ...execution, extra: true },
        /unknown field "extra"/,
      ],
      [
        'unknown adapter',
        { ...execution, captain: { ...execution.captain, adapter: 'other' } },
        /adapter.*not supported/,
      ],
      [
        'adapter-incompatible effort',
        {
          ...execution,
          captain: {
            ...execution.captain,
            effort: { kind: 'value', value: 'on' },
          },
        },
        /effort.*claude/i,
      ],
      [
        'path-shaped stored module',
        {
          ...execution,
          catalog: {
            code: { ...execution.catalog.code, from: '../unsafe.js' },
          },
        },
        /canonical module specifier/,
      ],
      [
        'noncanonical command',
        {
          ...execution,
          catalog: {
            code: { ...execution.catalog.code, command: ' code' },
          },
        },
        /canonical trimmed form/,
      ],
      [
        'extra roster member',
        {
          ...execution,
          players: [
            ...execution.players,
            { ...execution.players[0], id: 'dev.extra' },
          ],
        },
        /players must equal the ordered player ids/,
      ],
    ];
    for (const [name, mutation, expected] of mutations) {
      expect(
        () => validateCaptainSessionExecutionProjection(mutation),
        name,
      ).toThrow(expected);
    }

    expect(() =>
      assertCaptainSessionExecutionCompatible(structural, {
        ...execution,
        captain: {
          ...execution.captain,
          permissions: { mode: 'bypass' },
        },
      }),
    ).toThrow(/does not reproduce/);
    expect(() =>
      validateCaptainSessionRecord(releasedSchema2Record()),
    ).toThrow(/incompatible root-owned player identity/);
  });

  it('rejects an internally inconsistent fresh uncertain boundary', () => {
    const retuned = executionProjection({ captainModel: 'different' });
    expect(() =>
      validateCaptainSessionRecord(
        freshUncertainRecord({
          uncertain: {
            ...freshUncertainRecord().uncertain,
            attemptedExecutionProjection: retuned,
          },
        }),
      ),
    ).toThrow(/baseline and attempted execution projections must match/);

    const execution = executionProjection();
    expect(() =>
      validateCaptainSessionRecord(
        freshUncertainRecord({ snapshot: shellSnapshot(execution, 1) }),
      ),
    ).toThrow(/initialized turn-zero shell snapshot/);
  });

  it('rejects a continued marker whose baseline is not after creation', () => {
    const execution = executionProjection();
    expect(() =>
      validateCaptainSessionRecord({
        ...freshUncertainRecord(),
        updatedAt: '2026-08-11T21:00:00.002Z',
        snapshot: shellSnapshot(execution, 1),
        uncertain: {
          ...freshUncertainRecord().uncertain,
          baseUpdatedAt: '2026-08-11T21:00:00.000Z',
          markedAt: '2026-08-11T21:00:00.002Z',
        },
      }),
    ).toThrow(/baseUpdatedAt must identify an earlier settled boundary/);
  });

  it('crosslinks shell identity while leaving option normalization to the registry', () => {
    const execution = executionProjection();
    const structural = projectCaptainSessionStructure(execution);
    expect(
      validateCaptainSessionRecord(
        settledRecord({
          structuralProjection: structural,
          lastAppliedExecutionProjection: execution,
          snapshot: engagedSnapshot(execution),
        }),
      ).snapshot,
    ).toMatchObject({
      mode: 'engaged.parked',
      frames: [{ options: { normalizedByRegistry: true } }],
    });

    const snapshot = shellSnapshot(execution);
    expect(() =>
      validateCaptainSessionRecord(
        settledRecord({
          snapshot: {
            ...snapshot,
            captain: {
              ...snapshot.captain,
              agent: { adapter: 'codex' },
            },
          },
        }),
      ),
    ).toThrow(/Captain envelope differs/);
  });

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
      attemptedExecutionProjection: executionProjection(),
      fresh: freshBoundary(),
    });
    expect(uncertain).toMatchObject({
      schemaVersion: 3,
      kind: 'captain-session',
      state: 'uncertain',
      sessionId,
      uncertain: {
        baseUpdatedAt: null,
        input: '  exact input\n',
        attemptId: attempt1,
        attemptNumber: 1,
        attemptedExecutionProjection: { schemaVersion: 2 },
      },
    });
    expect(Object.isFrozen(uncertain)).toBe(true);
    const firstSettled = await firstLease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(executionProjection(), 1),
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
      attemptedExecutionProjection: executionProjection({
        captainModel: 'captain-current',
        playerModel: 'coder-current',
      }),
    });
    expect(continued.uncertain).toMatchObject({
      baseUpdatedAt: firstSettled.updatedAt,
      attemptNumber: 1,
      attemptedExecutionProjection: {
        captain: { model: { kind: 'value', value: 'captain-current' } },
        players: [
          { model: { kind: 'value', value: 'coder-current' } },
        ],
      },
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
        attemptedExecutionProjection: executionProjection(),
        fresh: freshBoundary(),
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
      attemptedExecutionProjection: executionProjection(),
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
          attemptedExecutionProjection: executionProjection(),
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
      attemptedExecutionProjection: executionProjection(),
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
      const execution = executionProjection();
      await expect(
        lease.initializeSettled({
          cwd: process.cwd(),
          structuralProjection: projectCaptainSessionStructure(execution),
          executionProjection: execution,
          snapshot: shellSnapshot(execution),
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
      attemptedExecutionProjection: executionProjection(),
      fresh: freshBoundary(),
    });
    await firstLease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(executionProjection(), 1, 'settled'),
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
      lease.beginTurn({
        input: 'must not replace',
        attemptId: attempt2,
        attemptedExecutionProjection: executionProjection(),
      }),
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
        attemptedExecutionProjection: executionProjection(),
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
      attemptedExecutionProjection: executionProjection(),
      fresh: freshBoundary(),
    });
    await lease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(executionProjection(), 1, 'first settled'),
    });
    await lease.beginTurn({
      input: 'second turn',
      attemptId: attempt2,
      attemptedExecutionProjection: executionProjection(),
    });
    failSessionSync = true;
    await expect(
      lease.settle({
        attemptId: attempt2,
        snapshot: shellSnapshot(executionProjection(), 2, 'replacement settled'),
      }),
    ).rejects.toThrow(/synthetic settlement directory sync failure/);
    failSessionSync = false;
    expect(await store.read(sessionId)).toMatchObject({
      state: 'settled',
      snapshot: {
        sequences: { turn: 2 },
        captain: { conversation: { token: 'replacement settled' } },
      },
    });
    await lease.release();
  });

  it('selects tied records, skips released schema 2, and fails closed on corruption', async () => {
    const { sessionsDir } = await fixtureDir();
    for (const [id, token, attempt] of [
      [sessionId, tokenO, attempt1],
      [secondSessionId, tokenN, attempt2],
    ] as const) {
      const lease = await fixedStore(sessionsDir, token).acquire(id);
      await lease.beginTurn({
        input: `turn for ${id}`,
        attemptId: attempt,
        attemptedExecutionProjection: executionProjection(),
        fresh: freshBoundary(),
      });
      await lease.settle({
        attemptId: attempt,
        snapshot: shellSnapshot(executionProjection(), 1, id),
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
    const legacyRecord = releasedSchema2Record({
      sessionId: secondSessionId,
      createdAt: wrongEmbeddedId.createdAt,
      updatedAt: wrongEmbeddedId.updatedAt,
      cwd: wrongEmbeddedId.cwd,
    });
    await writeFile(secondPath, `${JSON.stringify(legacyRecord)}\n`, 'utf8');
    const legacyRecords: unknown[] = [];
    expect(
      (
        await store.latest({
          onLegacyRecord: (record: unknown) => legacyRecords.push(record),
        })
      ).sessionId,
    ).toBe(sessionId);
    expect(legacyRecords).toEqual([
      {
        sessionId: secondSessionId,
        path: secondPath,
        schemaVersion: 2,
      },
    ]);
    await expect(store.read(secondSessionId)).rejects.toThrow(
      new RegExp(`${secondSessionId}.*${secondSessionId}\\.json.*schema 2`),
    );

    await writeFile(secondPath, '{"schemaVersion":2}\n', 'utf8');
    await expect(store.latest()).rejects.toThrow(
      new RegExp(`${secondSessionId}.*${secondSessionId}\\.json.*state`),
    );

    await writeFile(secondPath, '{"schemaVersion":99}\n', 'utf8');
    await expect(store.latest()).rejects.toThrow(
      new RegExp(`${secondSessionId}.*${secondSessionId}\\.json.*schema 99`),
    );

    await writeFile(secondPath, '{"schemaVersion":3}\n', 'utf8');
    await expect(store.latest()).rejects.toThrow(
      new RegExp(`${secondSessionId}.*${secondSessionId}\\.json.*state`),
    );

    await writeFile(secondPath, '{not-json\n', 'utf8');
    await expect(store.latest()).rejects.toThrow(
      new RegExp(`${secondSessionId}.*${secondSessionId}\\.json.*valid JSON`),
    );
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
      attemptedExecutionProjection: executionProjection(),
      fresh: freshBoundary(),
    });
    await lease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(executionProjection(), 1, 'settled'),
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
