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
const childFrameRuntimeId = '80000000-0000-4000-8000-000000000003';
const reviewRootRuntimeId = '80000000-0000-4000-8000-000000000004';

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

function suspendedState(stateId = 'waitingForReview') {
  return {
    value: stateId,
    activeStateIds: [stateId],
    tags: ['playbook.suspended'],
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

function retentionExecutionProjection(
  options: Parameters<typeof executionProjection>[0] = {},
) {
  const execution = executionProjection(options);
  return {
    ...execution,
    catalog: {
      ...execution.catalog,
      review: {
        id: 'review',
        from: '@sublang/playbook/review/registry',
        manifestCommand: 'review',
        command: 'review',
        intent: 'Review completed work.',
        artifactSchema: 2,
        requiredRoleIds: ['coder'],
        concurrentRoleSets: [],
        roles: {
          coder: { ...execution.catalog.code.roles.coder },
        },
        options: {},
      },
    },
  };
}

function retainedCodeGeneration(childStateId = 'reviewing') {
  const rootState = suspendedState();
  const childState = parkedState(childStateId);
  return {
    frames: [
      {
        playbookId: 'code',
        sessionId: frameRuntimeId,
        rootSessionId: frameRuntimeId,
        depth: 0,
        options: {},
        roleBindings: { coder: 'dev.coder' },
        runtime: {
          ...runtimeSnapshot('code', 1),
          machine: { value: rootState.value, status: rootState.status },
          sequences: {
            ...runtimeSnapshot('code', 1).sequences,
            playbookCall: 1,
          },
          state: rootState,
          suspendedCall: {
            callId: 'code:review:1',
            stateId: 'waitingForReview',
            playbookId: 'review',
            text: 'Review the implementation.',
            childSessionId: childFrameRuntimeId,
            turnId: 1,
          },
        },
      },
      {
        playbookId: 'review',
        sessionId: childFrameRuntimeId,
        rootSessionId: frameRuntimeId,
        depth: 1,
        parentSessionId: frameRuntimeId,
        parentCallId: 'code:review:1',
        options: {},
        roleBindings: { coder: 'dev.coder' },
        runtime: {
          ...runtimeSnapshot('review', 1),
          machine: { value: childState.value, status: childState.status },
          state: childState,
        },
      },
    ],
    rootStateDescription: 'CODE is waiting for REVIEW to finish.',
  };
}

function retainedReviewGeneration(stateId = 'reviewing') {
  const state = parkedState(stateId);
  return {
    frames: [
      {
        playbookId: 'review',
        sessionId: reviewRootRuntimeId,
        rootSessionId: reviewRootRuntimeId,
        depth: 0,
        options: {},
        roleBindings: { coder: 'dev.coder' },
        runtime: {
          ...runtimeSnapshot('review', 1),
          machine: { value: state.value, status: state.status },
          state,
        },
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

function adoptionSessionId(index: number) {
  return `91000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function adoptionLeaseToken(index: number) {
  return `a1000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function sequencedStore(
  sessionsDir: string,
  tokenStart = 1,
  options: Record<string, unknown> = {},
) {
  let nextToken = tokenStart;
  return createCaptainSessionStore({
    sessionsDir,
    now: () => instant,
    hostname: 'test-host',
    pid: 101,
    createLeaseToken: () => adoptionLeaseToken(nextToken++),
    ...options,
  });
}

async function writeRecordFixture(
  sessionsDir: string,
  record: Record<string, unknown>,
) {
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await chmod(sessionsDir, 0o700);
  const validated = validateCaptainSessionRecord(record);
  const path = join(sessionsDir, `${validated.sessionId}.json`);
  await writeFile(path, `${JSON.stringify(validated)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function retainedSettledRecord({
  id,
  execution = retentionExecutionProjection(),
  retainedGenerations = {
    code: retainedCodeGeneration(),
    review: retainedReviewGeneration(),
  },
  schemaVersion = 3,
  cwd = process.cwd(),
  updatedAt = '2026-08-11T21:00:00.020Z',
}: {
  id: string;
  execution?: ReturnType<typeof retentionExecutionProjection>;
  retainedGenerations?: Record<string, unknown>;
  schemaVersion?: number;
  cwd?: string;
  updatedAt?: string;
}) {
  return settledRecord({
    schemaVersion,
    sessionId: id,
    createdAt: '2026-08-11T21:00:00.000Z',
    updatedAt,
    cwd,
    structuralProjection: projectCaptainSessionStructure(execution),
    lastAppliedExecutionProjection: execution,
    snapshot: shellSnapshot(execution, 1, `source-${id}`),
    retainedGenerations,
  });
}

function freshAdoptionTargetRecord({
  id,
  execution = retentionExecutionProjection(),
  state = 'settled',
  cwd = process.cwd(),
  timestamp = '2026-08-11T21:00:00.030Z',
}: {
  id: string;
  execution?: ReturnType<typeof retentionExecutionProjection>;
  state?: 'settled' | 'uncertain';
  cwd?: string;
  timestamp?: string;
}) {
  const structuralProjection = projectCaptainSessionStructure(execution);
  if (state === 'uncertain') {
    return freshUncertainRecord({
      sessionId: id,
      createdAt: timestamp,
      updatedAt: timestamp,
      cwd,
      structuralProjection,
      lastAppliedExecutionProjection: execution,
      snapshot: shellSnapshot(execution),
      retainedGenerations: {},
      uncertain: {
        baseUpdatedAt: null,
        input: 'adopt retained work',
        attemptId: attempt1,
        attemptNumber: 1,
        markedAt: timestamp,
        attemptedExecutionProjection: execution,
      },
    });
  }
  return settledRecord({
    sessionId: id,
    createdAt: '2026-08-11T21:00:00.028Z',
    updatedAt: timestamp,
    cwd,
    structuralProjection,
    lastAppliedExecutionProjection: execution,
    snapshot: shellSnapshot(execution),
    retainedGenerations: {},
  });
}

function withCodeReviewer(
  execution: ReturnType<typeof retentionExecutionProjection>,
  concurrentRoleSets: string[][] = [],
) {
  const reviewer = {
    id: 'dev.reviewer',
    adapter: 'codex',
    model: { kind: 'provider-default' },
    effort: { kind: 'value', value: 'high' },
    permissions: { fileWrite: 'ask' },
  };
  return {
    ...execution,
    players: [...execution.players, reviewer],
    catalog: {
      ...execution.catalog,
      code: {
        ...execution.catalog.code,
        requiredRoleIds: ['coder', 'reviewer'],
        concurrentRoleSets,
        roles: {
          ...execution.catalog.code.roles,
          reviewer: {
            playerId: reviewer.id,
            model: reviewer.model,
            effort: reviewer.effort,
          },
        },
      },
    },
  };
}

function retainedCodeGenerationWithReviewer() {
  const generation = structuredClone(retainedCodeGeneration());
  (generation.frames[0]!.roleBindings as Record<string, string>).reviewer =
    'dev.reviewer';
  return generation;
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
    retainedGenerations: {},
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

function memberlessSchema3Record(overrides: Record<string, unknown> = {}) {
  const { retainedGenerations: _retainedGenerations, ...record } =
    settledRecord();
  return { ...record, schemaVersion: 3, ...overrides };
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
    retainedGenerations: {},
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

describe('durable Captain session records (PBCLI-23/24/51/52/53/54)', () => {
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
      retainedGenerations: {},
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

  it('continues member-less schema 3 and discards to its exact bytes', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = executionProjection();
    const firstLease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    await firstLease.initializeSettled({
      cwd: process.cwd(),
      structuralProjection: projectCaptainSessionStructure(execution),
      executionProjection: execution,
      snapshot: shellSnapshot(execution),
    });
    await firstLease.release();

    const recordPath = join(sessionsDir, `${sessionId}.json`);
    const persisted = JSON.parse(await readFile(recordPath, 'utf8'));
    const { retainedGenerations: _retainedGenerations, ...memberless } =
      persisted;
    const memberlessBytes = `${JSON.stringify(memberless)}\n`;
    await writeFile(recordPath, memberlessBytes, 'utf8');

    const nextLease = await fixedStore(sessionsDir, tokenN).acquire(sessionId);
    expect(await nextLease.read()).not.toHaveProperty('retainedGenerations');
    const uncertain = await nextLease.beginTurn({
      input: 'compatible continuation',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    expect(uncertain).not.toHaveProperty('retainedGenerations');
    const retried = await nextLease.beginRetry({
      expectedAttemptId: attempt1,
      nextAttemptId: attempt2,
    });
    expect(retried).not.toHaveProperty('retainedGenerations');
    const discarded = await nextLease.discard({ attemptId: attempt2 });
    expect(discarded).not.toHaveProperty('retainedGenerations');
    expect(await readFile(recordPath, 'utf8')).toBe(memberlessBytes);
    await nextLease.release();
  });

  it('continues transient schema 4 and canonicalizes a successful settlement', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = executionProjection();
    const firstLease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    await firstLease.initializeSettled({
      cwd: process.cwd(),
      structuralProjection: projectCaptainSessionStructure(execution),
      executionProjection: execution,
      snapshot: shellSnapshot(execution),
    });
    await firstLease.release();

    const recordPath = join(sessionsDir, `${sessionId}.json`);
    const persisted = JSON.parse(await readFile(recordPath, 'utf8'));
    const { retainedGenerations: _retainedGenerations, ...memberless } =
      persisted;
    await writeFile(
      recordPath,
      `${JSON.stringify({ ...memberless, schemaVersion: 4 })}\n`,
      'utf8',
    );
    const store = fixedStore(sessionsDir, tokenN);
    await expect(store.latest()).rejects.toThrow(
      /missing field "retainedGenerations"/,
    );
    const schema4Bytes = `${JSON.stringify({
      ...persisted,
      schemaVersion: 4,
    })}\n`;
    await writeFile(recordPath, schema4Bytes, 'utf8');
    expect((await store.latest()).schemaVersion).toBe(4);

    const nextLease = await store.acquire(sessionId);
    const uncertain = await nextLease.beginTurn({
      input: 'compatible schema-4 continuation',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    expect(uncertain.schemaVersion).toBe(4);
    const retried = await nextLease.beginRetry({
      expectedAttemptId: attempt1,
      nextAttemptId: attempt2,
    });
    expect(retried.schemaVersion).toBe(4);
    const discarded = await nextLease.discard({ attemptId: attempt2 });
    expect(discarded.schemaVersion).toBe(4);
    expect(await readFile(recordPath, 'utf8')).toBe(schema4Bytes);

    const nextTurn = await nextLease.beginTurn({
      input: 'canonicalize compatible schema 4',
      attemptId: attempt3,
      attemptedExecutionProjection: execution,
    });
    expect(nextTurn.schemaVersion).toBe(4);
    const settled = await nextLease.settle({
      attemptId: attempt3,
      snapshot: shellSnapshot(execution, 1),
    });
    expect(settled.schemaVersion).toBe(3);
    expect(settled.retainedGenerations).toEqual({});
    await nextLease.release();
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
    const initialExecution = retentionExecutionProjection();
    const canonicalLease = join(sessionsDir, `.${sessionId}.lock`);
    expect((await stat(canonicalLease)).mode & 0o777).toBe(0o700);
    expect(await readdir(canonicalLease)).toEqual(['owner.json']);
    expect((await stat(join(canonicalLease, 'owner.json'))).mode & 0o777)
      .toBe(0o600);
    const uncertain = await firstLease.beginTurn({
      input: '  exact input\n',
      attemptId: attempt1,
      attemptedExecutionProjection: initialExecution,
      fresh: freshBoundary(initialExecution),
    });
    expect(uncertain).toMatchObject({
      schemaVersion: 3,
      kind: 'captain-session',
      state: 'uncertain',
      sessionId,
      retainedGenerations: {},
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
      snapshot: shellSnapshot(initialExecution, 1),
      retentionUpdates: [
        {
          kind: 'retain',
          rootPlaybookId: 'code',
          generation: retainedCodeGeneration(),
        },
      ],
    });
    expect(firstSettled.state).toBe('settled');
    expect(firstSettled).not.toHaveProperty('uncertain');
    expect(firstSettled.retainedGenerations).toEqual({
      code: retainedCodeGeneration(),
    });
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
    expect((await secondStore.read(sessionId)).retainedGenerations).toEqual(
      firstSettled.retainedGenerations,
    );
    const continued = await secondLease.beginTurn({
      input: 'continued',
      attemptId: attempt2,
      attemptedExecutionProjection: retentionExecutionProjection({
        captainModel: 'captain-current',
        playerModel: 'coder-current',
      }),
    });
    expect(continued.retainedGenerations).toEqual(
      firstSettled.retainedGenerations,
    );
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
    expect(retried.retainedGenerations).toEqual(
      firstSettled.retainedGenerations,
    );
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
        attemptedExecutionProjection: initialExecution,
        fresh: freshBoundary(initialExecution),
      }),
    ).rejects.toThrow(/fresh Captain session record already exists/);
    expect(await readFile(recordPath, 'utf8')).toBe(settledBytes);
    expect((await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')))
      .toBe(false);
    await collisionLease.release();
  });

  it('replaces and clears one retained generation without disturbing another root', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    const execution = retentionExecutionProjection();
    await lease.beginTurn({
      input: 'retain two roots',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
      fresh: freshBoundary(execution),
    });
    const first = await lease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(execution, 1),
      retentionUpdates: [
        {
          kind: 'retain',
          rootPlaybookId: 'code',
          generation: retainedCodeGeneration(),
        },
        {
          kind: 'retain',
          rootPlaybookId: 'review',
          generation: retainedReviewGeneration(),
        },
      ],
    });
    expect(Object.isFrozen(first.retainedGenerations.code)).toBe(true);
    expect(Object.keys(first.retainedGenerations)).toEqual(['code', 'review']);
    expect(first.retainedGenerations.code.rootStateDescription).toBe(
      'CODE is waiting for REVIEW to finish.',
    );
    expect(first.retainedGenerations.review).not.toHaveProperty(
      'rootStateDescription',
    );

    await lease.beginTurn({
      input: 'replace code',
      attemptId: attempt2,
      attemptedExecutionProjection: execution,
    });
    const replaced = await lease.settle({
      attemptId: attempt2,
      snapshot: shellSnapshot(execution, 2),
      retentionUpdates: [
        {
          kind: 'retain',
          rootPlaybookId: 'code',
          generation: retainedCodeGeneration('reviewFailed'),
        },
      ],
    });
    expect(replaced.retainedGenerations).toEqual({
      code: retainedCodeGeneration('reviewFailed'),
      review: retainedReviewGeneration(),
    });

    await lease.beginTurn({
      input: 'complete code cleanly',
      attemptId: attempt3,
      attemptedExecutionProjection: execution,
    });
    const cleared = await lease.settle({
      attemptId: attempt3,
      snapshot: shellSnapshot(execution, 3),
      retentionUpdates: [
        { kind: 'clear', rootPlaybookId: 'code' },
      ],
    });
    expect(cleared.retainedGenerations).toEqual({
      review: retainedReviewGeneration(),
    });
    await lease.release();
  });

  it.each(['member-less schema 3', 'explicitly empty'] as const)(
    'selects the newest settled same-cwd %s predecessor without older fallback',
    async (shape) => {
      const { sessionsDir } = await fixtureDir();
      const olderId = adoptionSessionId(1);
      const emptyId = adoptionSessionId(2);
      const uncertainId = adoptionSessionId(3);
      const otherCwdId = adoptionSessionId(4);
      const targetId = adoptionSessionId(5);
      const legacyId = adoptionSessionId(6);
      const older = retainedSettledRecord({
        id: olderId,
        updatedAt: '2026-08-11T21:00:00.040Z',
      });
      const empty: any = retainedSettledRecord({
        id: emptyId,
        retainedGenerations: {},
        updatedAt: '2026-08-11T21:00:00.040Z',
      });
      if (shape === 'member-less schema 3') {
        delete empty.retainedGenerations;
      }
      const uncertain = freshAdoptionTargetRecord({
        id: uncertainId,
        state: 'uncertain',
        timestamp: '2026-08-11T21:00:00.060Z',
      });
      const otherCwd = retainedSettledRecord({
        id: otherCwdId,
        cwd: join(process.cwd(), 'other-working-directory'),
        updatedAt: '2026-08-11T21:00:00.080Z',
      });
      const target = freshAdoptionTargetRecord({
        id: targetId,
        timestamp: '2026-08-11T21:00:00.070Z',
      });
      for (const record of [older, empty, uncertain, otherCwd, target]) {
        await writeRecordFixture(sessionsDir, record);
      }
      const legacyPath = join(sessionsDir, `${legacyId}.json`);
      await writeFile(
        legacyPath,
        `${JSON.stringify(
          releasedSchema2Record({
            sessionId: legacyId,
            updatedAt: '2026-08-11T21:00:00.090Z',
          }),
        )}\n`,
        { mode: 0o600 },
      );
      const paths = [olderId, emptyId, targetId].map((id) =>
        join(sessionsDir, `${id}.json`),
      );
      const before = await Promise.all(
        paths.map((path) => readFile(path, 'utf8')),
      );

      const store = sequencedStore(sessionsDir);
      const lease = await store.acquire(targetId);
      const legacyRecords: unknown[] = [];
      const predecessor = await lease.predecessor({
        onLegacyRecord: (record: unknown) => legacyRecords.push(record),
      });
      expect(predecessor).toMatchObject({
        sessionId: emptyId,
        updatedAt: '2026-08-11T21:00:00.040Z',
        cwd: process.cwd(),
        retainedGenerations: {},
      });
      expect(Object.isFrozen(predecessor)).toBe(true);
      expect(legacyRecords).toEqual([
        {
          sessionId: legacyId,
          path: legacyPath,
          schemaVersion: 2,
        },
      ]);
      const transfer = await lease.transferPredecessorGenerations({
        predecessor,
      });
      expect(transfer).toEqual({
        sourceSessionId: emptyId,
        retainedGenerations: {},
      });
      await lease.release();

      expect(
        await Promise.all(paths.map((path) => readFile(path, 'utf8'))),
      ).toEqual(before);
      expect((await store.read(olderId)).retainedGenerations).toEqual({
        code: retainedCodeGeneration(),
        review: retainedReviewGeneration(),
      });
    },
  );

  it.each(['malformed', 'unknown schema', 'unsafe'] as const)(
    'fails predecessor selection closed on a %s canonical record',
    async (shape) => {
      const { sessionsDir } = await fixtureDir();
      const targetId = adoptionSessionId(7);
      const corruptId = adoptionSessionId(8);
      const targetPath = await writeRecordFixture(
        sessionsDir,
        freshAdoptionTargetRecord({ id: targetId }),
      );
      const corruptPath = join(sessionsDir, `${corruptId}.json`);
      if (shape === 'unsafe') {
        await writeRecordFixture(
          sessionsDir,
          retainedSettledRecord({ id: corruptId }),
        );
        await chmod(corruptPath, 0o644);
      } else {
        await writeFile(
          corruptPath,
          shape === 'malformed'
            ? '{not-json\n'
            : '{"schemaVersion":99}\n',
          { mode: 0o600 },
        );
      }
      const targetBytes = await readFile(targetPath, 'utf8');
      const store = sequencedStore(sessionsDir, 7);
      const lease = await store.acquire(targetId);
      await expect(lease.predecessor()).rejects.toThrow(
        shape === 'malformed'
          ? /not valid JSON/
          : shape === 'unknown schema'
            ? /schema 99/
            : /0600/,
      );
      expect(await readFile(targetPath, 'utf8')).toBe(targetBytes);
      await lease.release();
    },
  );

  it('moves a schema-4 map whole, orders its new owner, and preserves discard', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(10);
    const targetId = adoptionSessionId(11);
    const sourceExecution = retentionExecutionProjection();
    const targetBase = retentionExecutionProjection({
      captainModel: 'captain-current',
      playerModel: 'coder-current',
      playerId: 'replacement.coder',
    });
    const targetExecution: any = {
      ...targetBase,
      captain: {
        ...targetBase.captain,
        adapter: 'codex',
        instruction: 'Current Captain instruction.',
      },
      players: targetBase.players.map((player) => ({
        ...player,
        instruction: 'Current player instruction.',
      })),
      catalog: Object.fromEntries(
        Object.entries(targetBase.catalog).map(([id, item]) => [
          id,
          {
            ...item,
            command: `${item.command}-current`,
            intent: `${item.intent} Current wording.`,
          },
        ]),
      ),
    };
    const retainedGenerations = {
      code: retainedCodeGeneration(),
      review: retainedReviewGeneration(),
    };
    const source = retainedSettledRecord({
      id: sourceId,
      execution: sourceExecution,
      retainedGenerations,
      schemaVersion: 4,
      updatedAt: '2026-08-11T21:00:00.040Z',
    });
    const target = freshAdoptionTargetRecord({
      id: targetId,
      execution: targetExecution,
    });
    await writeRecordFixture(sessionsDir, source);
    await writeRecordFixture(sessionsDir, target);

    const store = sequencedStore(sessionsDir, 10);
    const lease = await store.acquire(targetId);
    const predecessor = await lease.predecessor();
    const result = await lease.transferPredecessorGenerations({
      predecessor,
    });
    expect(result).toEqual({
      sourceSessionId: sourceId,
      retainedGenerations,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.retainedGenerations.code)).toBe(true);

    const sourceAfter = await store.read(sourceId);
    const targetAfter = await store.read(targetId);
    expect(sourceAfter).toEqual({
      ...source,
      schemaVersion: 3,
      updatedAt: '2026-08-11T21:00:00.041Z',
      retainedGenerations: {},
    });
    expect(targetAfter).toEqual({
      ...target,
      updatedAt: '2026-08-11T21:00:00.042Z',
      retainedGenerations,
    });
    expect(sourceAfter.updatedAt).toBe('2026-08-11T21:00:00.041Z');
    expect(targetAfter).toMatchObject({
      createdAt: target.createdAt,
      updatedAt: '2026-08-11T21:00:00.042Z',
      structuralProjection: {
        captain: {
          adapter: 'codex',
          instruction: 'Current Captain instruction.',
        },
        players: [{ id: 'replacement.coder' }],
        catalog: {
          code: {
            command: 'code-current',
            intent: 'Implement a requested change. Current wording.',
          },
        },
      },
    });
    expect(
      targetAfter.retainedGenerations.code.frames[0].roleBindings,
    ).toEqual({ coder: 'dev.coder' });
    const targetBytes = await readFile(
      join(sessionsDir, `${targetId}.json`),
      'utf8',
    );
    await lease.beginTurn({
      input: 'discard after adoption transfer',
      attemptId: attempt1,
      attemptedExecutionProjection: targetExecution,
    });
    await lease.discard({ attemptId: attempt1 });
    expect(
      await readFile(join(sessionsDir, `${targetId}.json`), 'utf8'),
    ).toBe(targetBytes);
    await lease.release();

    const reopened = sequencedStore(sessionsDir, 20);
    expect((await reopened.read(sourceId)).retainedGenerations).toEqual({});
    expect((await reopened.read(targetId)).retainedGenerations).toEqual(
      retainedGenerations,
    );
    const nextTargetId = adoptionSessionId(12);
    await writeRecordFixture(
      sessionsDir,
      freshAdoptionTargetRecord({
        id: nextTargetId,
        execution: targetExecution,
      }),
    );
    const nextLease = await reopened.acquire(nextTargetId);
    expect((await nextLease.predecessor()).sessionId).toBe(targetId);
    await nextLease.release();
  });

  it.each([
    'registry module',
    'manifest command',
    'raw options',
    'required roles',
    'concurrent roles',
    'descendant catalog',
  ] as const)(
    'rejects an incompatible adoption %s envelope before either write',
    async (mismatch) => {
      const { sessionsDir } = await fixtureDir();
      const sourceId = adoptionSessionId(20);
      const targetId = adoptionSessionId(21);
      let sourceExecution: any = retentionExecutionProjection();
      let targetExecution: any = structuredClone(sourceExecution);
      let generation: any = retainedCodeGeneration();
      if (mismatch === 'registry module') {
        targetExecution.catalog.code.from = '@example/code/registry';
      } else if (mismatch === 'manifest command') {
        targetExecution.catalog.code.manifestCommand = 'other-code';
      } else if (mismatch === 'raw options') {
        targetExecution.catalog.code.options = { variant: 'other' };
      } else if (mismatch === 'required roles') {
        targetExecution = withCodeReviewer(targetExecution);
      } else if (mismatch === 'concurrent roles') {
        sourceExecution = withCodeReviewer(sourceExecution);
        targetExecution = withCodeReviewer(
          structuredClone(retentionExecutionProjection()),
          [['coder', 'reviewer']],
        );
        generation = retainedCodeGenerationWithReviewer();
      } else {
        delete targetExecution.catalog.review;
      }
      const source = retainedSettledRecord({
        id: sourceId,
        execution: sourceExecution,
        retainedGenerations: { code: generation },
      });
      const target = freshAdoptionTargetRecord({
        id: targetId,
        execution: targetExecution,
      });
      const sourcePath = await writeRecordFixture(sessionsDir, source);
      const targetPath = await writeRecordFixture(sessionsDir, target);
      const sourceBytes = await readFile(sourcePath, 'utf8');
      const targetBytes = await readFile(targetPath, 'utf8');

      const store = sequencedStore(sessionsDir, 30);
      const lease = await store.acquire(targetId);
      const predecessor = await lease.predecessor();
      await expect(
        lease.transferPredecessorGenerations({ predecessor }),
      ).rejects.toThrow(
        mismatch === 'descendant catalog'
          ? /no frame playbook "review"/
          : /root envelope differs for "code"/,
      );
      expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
      expect(await readFile(targetPath, 'utf8')).toBe(targetBytes);
      await lease.release();
    },
  );

  it('rejects stale predecessor selection without changing either record', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(30);
    const targetId = adoptionSessionId(31);
    const source = retainedSettledRecord({ id: sourceId });
    const target = freshAdoptionTargetRecord({ id: targetId });
    const sourcePath = await writeRecordFixture(sessionsDir, source);
    const targetPath = await writeRecordFixture(sessionsDir, target);
    const store = sequencedStore(sessionsDir, 40);
    const lease = await store.acquire(targetId);
    const predecessor = await lease.predecessor();

    const changed = {
      ...source,
      updatedAt: '2026-08-11T21:00:00.025Z',
    };
    await writeRecordFixture(sessionsDir, changed);
    const changedBytes = await readFile(sourcePath, 'utf8');
    const targetBytes = await readFile(targetPath, 'utf8');
    await expect(
      lease.transferPredecessorGenerations({ predecessor }),
    ).rejects.toThrow(/adoption predecessor changed/);
    expect(await readFile(sourcePath, 'utf8')).toBe(changedBytes);
    expect(await readFile(targetPath, 'utf8')).toBe(targetBytes);
    await lease.release();
  });

  it('lets two settled contenders leave exactly one generation owner', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(35);
    const firstTargetId = adoptionSessionId(36);
    const secondTargetId = adoptionSessionId(37);
    const source = retainedSettledRecord({
      id: sourceId,
      updatedAt: '2026-08-11T21:00:00.040Z',
    });
    await writeRecordFixture(sessionsDir, source);
    for (const id of [firstTargetId, secondTargetId]) {
      await writeRecordFixture(
        sessionsDir,
        freshAdoptionTargetRecord({ id, timestamp: '2026-08-11T21:00:00.030Z' }),
      );
    }

    const store = sequencedStore(sessionsDir, 45);
    const firstLease = await store.acquire(firstTargetId);
    const secondLease = await store.acquire(secondTargetId);
    const firstPredecessor = await firstLease.predecessor();
    const secondPredecessor = await secondLease.predecessor();
    expect(firstPredecessor.sessionId).toBe(sourceId);
    expect(secondPredecessor.sessionId).toBe(sourceId);

    await firstLease.transferPredecessorGenerations({
      predecessor: firstPredecessor,
    });
    await expect(
      secondLease.transferPredecessorGenerations({
        predecessor: secondPredecessor,
      }),
    ).rejects.toThrow(/adoption predecessor changed/);
    const owners = await Promise.all(
      [sourceId, firstTargetId, secondTargetId].map(async (id) => ({
        id,
        retained: Object.keys(
          (await store.read(id)).retainedGenerations ?? {},
        ).length,
      })),
    );
    expect(owners.filter(({ retained }) => retained > 0)).toEqual([
      { id: firstTargetId, retained: 2 },
    ]);
    await firstLease.release();
    await secondLease.release();
  });

  it('rejects transfer after target ownership changes without writing', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(38);
    const targetId = adoptionSessionId(39);
    const sourcePath = await writeRecordFixture(
      sessionsDir,
      retainedSettledRecord({ id: sourceId }),
    );
    const targetPath = await writeRecordFixture(
      sessionsDir,
      freshAdoptionTargetRecord({ id: targetId }),
    );
    const store = sequencedStore(sessionsDir, 55);
    const lease = await store.acquire(targetId);
    const predecessor = await lease.predecessor();
    const before = await Promise.all(
      [sourcePath, targetPath].map((path) => readFile(path, 'utf8')),
    );
    const ownerPath = join(sessionsDir, `.${targetId}.lock`, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        ...owner,
        ownerToken: adoptionLeaseToken(999),
      })}\n`,
      'utf8',
    );

    await expect(
      lease.transferPredecessorGenerations({ predecessor }),
    ).rejects.toThrow(/owned by a different token/);
    expect(
      await Promise.all(
        [sourcePath, targetPath].map((path) => readFile(path, 'utf8')),
      ),
    ).toEqual(before);
  });

  it.each(['uncertain', 'non-turn-zero', 'already retained'] as const)(
    'rejects an adoption target that is %s before predecessor acquisition',
    async (shape) => {
      const { sessionsDir } = await fixtureDir();
      const sourceId = adoptionSessionId(40);
      const targetId = adoptionSessionId(41);
      const execution = retentionExecutionProjection();
      const source = retainedSettledRecord({ id: sourceId, execution });
      const target =
        shape === 'uncertain'
          ? freshAdoptionTargetRecord({
              id: targetId,
              execution,
              state: 'uncertain',
            })
          : shape === 'non-turn-zero'
          ? settledRecord({
              sessionId: targetId,
              createdAt: '2026-08-11T21:00:00.028Z',
              updatedAt: '2026-08-11T21:00:00.030Z',
              structuralProjection:
                projectCaptainSessionStructure(execution),
              lastAppliedExecutionProjection: execution,
              snapshot: shellSnapshot(execution, 1),
              retainedGenerations: {},
            })
          : {
              ...freshAdoptionTargetRecord({ id: targetId, execution }),
              retainedGenerations: {
                review: retainedReviewGeneration(),
              },
            };
      await writeRecordFixture(sessionsDir, source);
      const targetPath = await writeRecordFixture(sessionsDir, target);
      const targetBytes = await readFile(targetPath, 'utf8');
      const store = sequencedStore(sessionsDir, 50);
      const lease = await store.acquire(targetId);
      await expect(lease.predecessor()).rejects.toThrow(
        shape === 'uncertain'
          ? /must be settled at turn zero/
          : shape === 'non-turn-zero'
          ? /turn-zero shell snapshot/
          : /already retains generations/,
      );
      expect(await readFile(targetPath, 'utf8')).toBe(targetBytes);
      await lease.release();
    },
  );

  it.each([
    'source pre-publication',
    'source post-publication',
    'target pre-publication',
    'target post-publication',
  ] as const)(
    'keeps at most one complete generation owner after a %s fault',
    async (boundary) => {
      const { sessionsDir } = await fixtureDir();
      const sourceId = adoptionSessionId(50);
      const targetId = adoptionSessionId(51);
      const source = retainedSettledRecord({ id: sourceId });
      const target = freshAdoptionTargetRecord({ id: targetId });
      const sourcePath = await writeRecordFixture(sessionsDir, source);
      const targetPath = await writeRecordFixture(sessionsDir, target);
      const sourceBytes = await readFile(sourcePath, 'utf8');
      const targetBytes = await readFile(targetPath, 'utf8');
      let sourcePublished = false;
      let targetPublished = false;
      let syncFailed = false;
      const store = sequencedStore(sessionsDir, 60, {
        fsOps: {
          async rename(from: string, to: string) {
            if (
              from.endsWith('.tmp') &&
              ((boundary === 'source pre-publication' && to === sourcePath) ||
                (boundary === 'target pre-publication' && to === targetPath))
            ) {
              throw new Error(`synthetic ${boundary} failure`);
            }
            await rename(from, to);
            if (from.endsWith('.tmp') && to === sourcePath) {
              sourcePublished = true;
            }
            if (from.endsWith('.tmp') && to === targetPath) {
              targetPublished = true;
            }
          },
          async open(
            path: string,
            flags: string | number,
            mode?: number,
          ) {
            const handle = await open(path, flags as any, mode);
            if (path !== sessionsDir || flags !== 'r') return handle;
            return {
              async sync() {
                const failAfterSource =
                  boundary === 'source post-publication' &&
                  sourcePublished &&
                  !targetPublished;
                const failAfterTarget =
                  boundary === 'target post-publication' && targetPublished;
                if (!syncFailed && (failAfterSource || failAfterTarget)) {
                  syncFailed = true;
                  throw new Error(`synthetic ${boundary} failure`);
                }
                await handle.sync();
              },
              close: () => handle.close(),
            };
          },
        },
      });
      const lease = await store.acquire(targetId);
      const predecessor = await lease.predecessor();
      await expect(
        lease.transferPredecessorGenerations({ predecessor }),
      ).rejects.toThrow(/cannot (?:clear|install) Captain session adoption/);

      const sourceAfterBytes = await readFile(sourcePath, 'utf8');
      const targetAfterBytes = await readFile(targetPath, 'utf8');
      const sourceAfter = validateCaptainSessionRecord(
        JSON.parse(sourceAfterBytes),
      );
      const targetAfter = validateCaptainSessionRecord(
        JSON.parse(targetAfterBytes),
      );
      const owners = [sourceAfter, targetAfter].filter(
        (record) => Object.keys(record.retainedGenerations ?? {}).length > 0,
      );
      expect(owners.length).toBeLessThanOrEqual(1);
      if (
        boundary === 'source pre-publication' ||
        boundary === 'target pre-publication'
      ) {
        expect(sourceAfterBytes).toBe(sourceBytes);
        expect(targetAfterBytes).toBe(targetBytes);
      } else if (boundary === 'source post-publication') {
        expect(sourceAfter.retainedGenerations).toEqual({});
        expect(targetAfterBytes).toBe(targetBytes);
      } else {
        expect(sourceAfter.retainedGenerations).toEqual({});
        expect(targetAfter.retainedGenerations).toEqual(
          source.retainedGenerations,
        );
      }
      expect(
        (await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')),
      ).toBe(false);
      await lease.release();
    },
  );

  it('rejects malformed or dangling retained generations before persistence', async () => {
    const execution = retentionExecutionProjection();
    const base = settledRecord({
      structuralProjection: projectCaptainSessionStructure(execution),
      lastAppliedExecutionProjection: execution,
      snapshot: shellSnapshot(execution, 1),
      retainedGenerations: { code: retainedCodeGeneration() },
    });
    const mutations: Array<[string, (value: any) => void]> = [
      ['unknown root', (value) => {
        value.retainedGenerations.unknown = value.retainedGenerations.code;
        delete value.retainedGenerations.code;
      }],
      ['empty stack', (value) => {
        value.retainedGenerations.code.frames = [];
      }],
      ['blank root-state description', (value) => {
        value.retainedGenerations.code.rootStateDescription = '  ';
      }],
      ['root mismatch', (value) => {
        value.retainedGenerations.code.frames[0].playbookId = 'review';
      }],
      ['final snapshot', (value) => {
        value.retainedGenerations.code.frames[1].runtime.state.status = 'done';
        value.retainedGenerations.code.frames[1].runtime.machine.status = 'done';
      }],
      ['nonquiescent snapshot', (value) => {
        value.retainedGenerations.code.frames[1].runtime.state.quiescent = false;
      }],
      ['dangling bridge', (value) => {
        value.retainedGenerations.code.frames[1].parentCallId = 'wrong-call';
      }],
      ['missing role binding', (value) => {
        delete value.retainedGenerations.code.frames[1].roleBindings.coder;
      }],
      ['duplicate session', (value) => {
        value.retainedGenerations.review = retainedReviewGeneration();
        const frame = value.retainedGenerations.review.frames[0];
        frame.sessionId = frameRuntimeId;
        frame.rootSessionId = frameRuntimeId;
      }],
      ['cyclic object', (value) => {
        value.retainedGenerations.code.frames[0].options =
          value.retainedGenerations.code;
      }],
      ['playbook cycle', (value) => {
        value.retainedGenerations.code.frames[0].runtime.suspendedCall.playbookId =
          'code';
        value.retainedGenerations.code.frames[1].playbookId = 'code';
        value.retainedGenerations.code.frames[1].runtime.playbookId = 'code';
      }],
    ];
    for (const [label, mutate] of mutations) {
      const candidate = structuredClone(base);
      mutate(candidate);
      expect(
        () => validateCaptainSessionRecord(candidate),
        label,
      ).toThrow();
    }

    const { sessionsDir } = await fixtureDir();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    await lease.beginTurn({
      input: 'invalid retention update',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
      fresh: freshBoundary(execution),
    });
    await expect(
      lease.settle({
        attemptId: attempt1,
        snapshot: shellSnapshot(execution, 1),
        retentionUpdates: [
          { kind: 'clear', rootPlaybookId: 'unknown' },
        ],
      }),
    ).rejects.toThrow(/unknown stored playbook/);
    const uncertainBytes = await readFile(
      join(sessionsDir, `${sessionId}.json`),
      'utf8',
    );
    const malformed = retainedCodeGeneration();
    (malformed.frames[1]!.runtime.state as any).status = 'done';
    for (const retentionUpdates of [
      [
        { kind: 'clear' as const, rootPlaybookId: 'code' },
        { kind: 'clear' as const, rootPlaybookId: 'code' },
      ],
      [
        {
          kind: 'retain' as const,
          rootPlaybookId: 'code',
          generation: malformed,
        },
      ],
    ]) {
      await expect(
        lease.settle({
          attemptId: attempt1,
          snapshot: shellSnapshot(execution, 1),
          retentionUpdates,
        }),
      ).rejects.toThrow();
      expect(await readFile(join(sessionsDir, `${sessionId}.json`), 'utf8'))
        .toBe(uncertainBytes);
    }
    expect((await store.read(sessionId)).state).toBe('uncertain');
    await lease.release();
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
    const execution = retentionExecutionProjection();
    await firstLease.beginTurn({
      input: 'first',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
      fresh: freshBoundary(execution),
    });
    await firstLease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(execution, 1, 'settled'),
      retentionUpdates: [
        {
          kind: 'retain',
          rootPlaybookId: 'code',
          generation: retainedCodeGeneration(),
        },
      ],
    });
    await firstLease.release();
    const recordPath = join(sessionsDir, `${sessionId}.json`);
    let failRename = false;

    const failing = fixedStore(sessionsDir, tokenN, {
      createTempId: () => tempId,
      fsOps: {
        async rename(from: string, to: string) {
          if (failRename && from.endsWith('.tmp') && to === recordPath) {
            throw new Error('synthetic record rename failure');
          }
          return rename(from, to);
        },
      },
    });
    const lease = await failing.acquire(sessionId);
    await lease.beginTurn({
      input: 'must not replace',
      attemptId: attempt2,
      attemptedExecutionProjection: execution,
    });
    const before = await readFile(recordPath, 'utf8');
    failRename = true;
    await expect(
      lease.settle({
        attemptId: attempt2,
        snapshot: shellSnapshot(execution, 2, 'replacement'),
        retentionUpdates: [
          {
            kind: 'retain',
            rootPlaybookId: 'code',
            generation: retainedCodeGeneration('replacement'),
          },
        ],
      }),
    ).rejects.toThrow(/synthetic record rename failure/);
    expect(await readFile(recordPath, 'utf8')).toBe(before);
    expect(JSON.parse(before)).toMatchObject({
      state: 'uncertain',
      snapshot: { sequences: { turn: 1 } },
      retainedGenerations: {
        code: {
          frames: [
            {},
            { runtime: { state: { stateId: 'reviewing' } } },
          ],
        },
      },
    });
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
    const execution = retentionExecutionProjection();
    await lease.beginTurn({
      input: 'first turn',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
      fresh: freshBoundary(execution),
    });
    await lease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(execution, 1, 'first settled'),
      retentionUpdates: [
        {
          kind: 'retain',
          rootPlaybookId: 'code',
          generation: retainedCodeGeneration(),
        },
      ],
    });
    await lease.beginTurn({
      input: 'second turn',
      attemptId: attempt2,
      attemptedExecutionProjection: execution,
    });
    failSessionSync = true;
    await expect(
      lease.settle({
        attemptId: attempt2,
        snapshot: shellSnapshot(execution, 2, 'replacement settled'),
        retentionUpdates: [
          {
            kind: 'retain',
            rootPlaybookId: 'code',
            generation: retainedCodeGeneration('reviewFailed'),
          },
        ],
      }),
    ).rejects.toThrow(/synthetic settlement directory sync failure/);
    failSessionSync = false;
    expect(await store.read(sessionId)).toMatchObject({
      state: 'settled',
      snapshot: {
        sequences: { turn: 2 },
        captain: { conversation: { token: 'replacement settled' } },
      },
      retainedGenerations: {
        code: {
          frames: [
            {},
            { runtime: { state: { stateId: 'reviewFailed' } } },
          ],
        },
      },
    });
    await lease.release();
  });

  it('selects member-less schema 3, skips released schemas, and fails closed on corruption', async () => {
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

    const memberlessSchema3 = memberlessSchema3Record({
      sessionId: secondSessionId,
      createdAt: wrongEmbeddedId.createdAt,
      updatedAt: wrongEmbeddedId.updatedAt,
      cwd: wrongEmbeddedId.cwd,
      structuralProjection: wrongEmbeddedId.structuralProjection,
      lastAppliedExecutionProjection:
        wrongEmbeddedId.lastAppliedExecutionProjection,
      snapshot: wrongEmbeddedId.snapshot,
    });
    await writeFile(
      secondPath,
      `${JSON.stringify(memberlessSchema3)}\n`,
      'utf8',
    );
    legacyRecords.length = 0;
    expect(
      (
        await store.latest({
          onLegacyRecord: (record: unknown) => legacyRecords.push(record),
        })
      ).sessionId,
    ).toBe(secondSessionId);
    expect(legacyRecords).toEqual([]);
    expect(await store.read(secondSessionId)).toEqual(memberlessSchema3);

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

    await writeFile(secondPath, '{"schemaVersion":4}\n', 'utf8');
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
