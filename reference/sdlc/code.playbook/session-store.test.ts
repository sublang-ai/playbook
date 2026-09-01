// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { writeFileSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCaptainSessionExecutionCompatible,
  assertReplayAppendArguments,
  captainSessionSelectedMembers,
  createCaptainSessionStore,
  defaultCaptainSessionsDir,
  projectCaptainSessionStructure,
  sanitizeReplayRecord,
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
const effectBoundaryId = '70000000-0000-4000-8000-000000000001';
const effectOperationId = '70000000-0000-4000-8000-000000000002';
const effectQuestionId = '70000000-0000-4000-8000-000000000003';
const secondEffectBoundaryId = '70000000-0000-4000-8000-000000000004';
const replayFixtureSessionId = '93000000-0000-4000-8000-000000000001';
const replayFixtureUrl = new URL(
  `./fixtures/${replayFixtureSessionId}.records.jsonl`,
  import.meta.url,
);

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

function replayStreamPath(sessionsDir: string, id = sessionId) {
  return join(sessionsDir, `${id}.records.jsonl`);
}

function replayEnvelope(
  seq: number,
  record: Record<string, unknown> = { type: `record-${seq}` },
  role?: string,
) {
  return {
    v: 1,
    seq,
    ...(role === undefined ? {} : { role }),
    record,
  };
}

function replayLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

async function writeReplayStream(
  sessionsDir: string,
  text: string,
  id = sessionId,
) {
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await chmod(sessionsDir, 0o700);
  const path = replayStreamPath(sessionsDir, id);
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

type ReplayReadEvent = {
  position: number;
  length: number;
  bytesRead: number;
};

function observedReplayFs(
  streamPath: string,
  events: ReplayReadEvent[],
  hooks: {
    onPath?: (operation: 'lstat' | 'open', path: string) => void;
    afterRead?: (readNumber: number) => void | Promise<void>;
  } = {},
) {
  let readNumber = 0;
  return {
    async lstat(path: string) {
      hooks.onPath?.('lstat', path);
      return lstat(path);
    },
    async open(path: string, flags: string | number, mode?: number) {
      hooks.onPath?.('open', path);
      const handle = await open(path, flags as any, mode);
      if (path !== streamPath) return handle;
      return {
        stat: () => handle.stat(),
        async read(
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) {
          const result = await handle.read(buffer, offset, length, position);
          events.push({ position, length, bytesRead: result.bytesRead });
          readNumber += 1;
          await hooks.afterRead?.(readNumber);
          return result;
        },
        close: () => handle.close(),
      };
    },
  };
}

type ReplayMutationEvent = {
  call: number;
  path: string;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function observedReplayMutationFs(
  sessionsDir: string,
  streamPath: string,
  hooks: {
    beforeReplayWrite?: (
      event: ReplayMutationEvent,
    ) => void | Promise<void>;
    afterReplayWrite?: (
      event: ReplayMutationEvent,
    ) => void | Promise<void>;
    beforeReplaySync?: (
      event: ReplayMutationEvent,
    ) => void | Promise<void>;
    beforeSessionsSync?: (
      event: ReplayMutationEvent,
    ) => void | Promise<void>;
  } = {},
) {
  let replayWrites = 0;
  let replaySyncs = 0;
  let sessionsSyncs = 0;
  let ownerOpens = 0;
  let replayOpens = 0;
  let replayPathStats = 0;
  let replayHandleStats = 0;
  let replayCloses = 0;
  let sessionsDirStats = 0;
  const observeWrite = async <T>(operation: () => Promise<T>) => {
    replayWrites += 1;
    const event = { call: replayWrites, path: streamPath };
    await hooks.beforeReplayWrite?.(event);
    const result = await operation();
    await hooks.afterReplayWrite?.(event);
    return result;
  };
  return {
    counts: () => ({
      replayWrites,
      replaySyncs,
      sessionsSyncs,
      ownerOpens,
      replayOpens,
      replayPathStats,
      replayHandleStats,
      replayCloses,
      sessionsDirStats,
    }),
    reset() {
      replayWrites = 0;
      replaySyncs = 0;
      sessionsSyncs = 0;
      ownerOpens = 0;
      replayOpens = 0;
      replayPathStats = 0;
      replayHandleStats = 0;
      replayCloses = 0;
      sessionsDirStats = 0;
    },
    fsOps: {
      async lstat(path: string) {
        if (path === streamPath) replayPathStats += 1;
        if (path === sessionsDir) sessionsDirStats += 1;
        return lstat(path);
      },
      async open(path: string, flags: string | number, mode?: number) {
        if (path.endsWith('/owner.json')) ownerOpens += 1;
        const handle = await open(path, flags as any, mode);
        if (path === streamPath) {
          replayOpens += 1;
          return new Proxy(handle as any, {
            get(target, property) {
              if (property === 'stat') {
                return (...args: unknown[]) => {
                  replayHandleStats += 1;
                  return target.stat(...args);
                };
              }
              if (property === 'write') {
                return (...args: unknown[]) =>
                  observeWrite(() => target.write(...args));
              }
              if (property === 'writeFile') {
                return (...args: unknown[]) =>
                  observeWrite(() => target.writeFile(...args));
              }
              if (property === 'appendFile') {
                return (...args: unknown[]) =>
                  observeWrite(() => target.appendFile(...args));
              }
              if (property === 'sync') {
                return async () => {
                  replaySyncs += 1;
                  await hooks.beforeReplaySync?.({
                    call: replaySyncs,
                    path,
                  });
                  return target.sync();
                };
              }
              if (property === 'close') {
                return (...args: unknown[]) => {
                  replayCloses += 1;
                  return target.close(...args);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        }
        if (path === sessionsDir && flags === 'r') {
          return new Proxy(handle as any, {
            get(target, property) {
              if (property === 'sync') {
                return async () => {
                  sessionsSyncs += 1;
                  await hooks.beforeSessionsSync?.({
                    call: sessionsSyncs,
                    path,
                  });
                  return target.sync();
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        }
        return handle;
      },
    },
  };
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
        artifactSchema: 3,
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

function schema3ExecutionProjection() {
  const execution: any = structuredClone(executionProjection());
  execution.catalog.code.artifactSchema = 3;
  return execution;
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

function effectLedger() {
  return {
    schemaVersion: 1,
    revision: 0,
    boundaries: [],
    logicalOperations: [],
  };
}

function effectWorktree() {
  return {
    worktree: process.cwd(),
    gitDir: join(process.cwd(), '.git'),
  };
}

function effectObservation(head = 'a'.repeat(40)) {
  return {
    ...effectWorktree(),
    head,
    projection: {},
    projectionDigest:
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  };
}

function unresolvedWorktreeEffect() {
  return {
    classification: 'worktree-only-change',
    baselineHead: 'a'.repeat(40),
    afterHead: 'b'.repeat(40),
  };
}

function effectAuthority(
  execution = schema3ExecutionProjection(),
  ownerToken = tokenO,
) {
  const item = execution.catalog.code;
  return {
    playbookId: 'code',
    artifactSchema: 3,
    cwd: process.cwd(),
    sessionId,
    leaseOwnerToken: ownerToken,
    canonicalWorktree: effectWorktree(),
    requiredRoleIds: item.requiredRoleIds,
    concurrentRoleSets: item.concurrentRoleSets,
  };
}

function effectBoundaryStart(options: {
  boundaryId?: string;
  logicalOperationId?: string;
} = {}) {
  const boundaryId = options.boundaryId ?? effectBoundaryId;
  const logicalOperationId = Object.hasOwn(options, 'logicalOperationId')
    ? options.logicalOperationId
    : effectOperationId;
  return {
    boundaryId,
    playbookId: 'code',
    runtimeSessionId: frameRuntimeId,
    turnId: 1,
    callId: `code:coder:${boundaryId}`,
    roleId: 'coder',
    sourceStateId: 'implementing',
    sourceOutcomeSchema: { type: 'object' },
    dispositions: ['one-descendant-commit'],
    canonicalWorktree: effectWorktree(),
    baseline: effectObservation(),
    correctionBudget: { limit: 1, spent: false },
    ...(logicalOperationId === undefined ? {} : { logicalOperationId }),
  };
}

function effectLogicalOperationStart() {
  return {
    operationId: effectOperationId,
    playbookId: 'code',
    runtimeSessionId: frameRuntimeId,
    boundaryIds: [effectBoundaryId],
    originalBaseline: effectObservation(),
    checkpointRestorationEligible: false,
  };
}

function runtimeSnapshot(playbookId = 'captain', turn = 0) {
  const state = parkedState();
  return {
    schemaVersion: 4,
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
    effectLedger: effectLedger(),
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
    schemaVersion: 4,
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
    effectLedger: effectLedger(),
    ...(turn === 0
      ? {}
      : { lastAction: 'respond', lastSettlementStatus: 'ok' }),
    mode: 'chat',
  };
}

function abandonmentSnapshot(
  execution = executionProjection(),
  turn = 1,
  token = `captain-token-${turn}`,
) {
  return {
    ...shellSnapshot(execution, turn, token),
    lastAction: 'runtime',
    lastSettlementStatus: 'ok',
  };
}

function freshBoundary(execution = executionProjection()) {
  return {
    cwd: process.cwd(),
    structuralProjection: projectCaptainSessionStructure(execution),
    executionProjection: execution,
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
        artifactSchema: 3,
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

function retentionSchema3ExecutionProjection() {
  const execution: any = structuredClone(retentionExecutionProjection());
  execution.catalog.code.artifactSchema = 3;
  return execution;
}

function startedEffectLedger() {
  return {
    schemaVersion: 1,
    revision: 1,
    boundaries: [
      {
        sequence: 1,
        ...effectBoundaryStart({ logicalOperationId: undefined }),
        attemptId: attempt1,
        attemptNumber: 1,
      },
    ],
    logicalOperations: [],
  };
}

function completedUnchangedEffectLedger() {
  const started = startedEffectLedger();
  const boundary = started.boundaries[0]!;
  return {
    ...started,
    revision: 2,
    boundaries: [
      {
        ...boundary,
        after: boundary.baseline,
        physicalReceipt: {
          classification: 'unchanged',
          baseline: boundary.baseline,
          after: boundary.baseline,
        },
      },
    ],
  };
}

function retainedCodeGeneration(childStateId = 'reviewing') {
  const rootState = suspendedState();
  const childState = parkedState(childStateId);
  return {
    effectLedger: effectLedger(),
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

function fencedRetainedCodeGeneration(authoritativeLedger: any) {
  const generation: any = structuredClone(retainedCodeGeneration());
  generation.retainedEffectReconciliation = {
    sourceGenerationId: frameRuntimeId,
  };
  for (const frame of generation.frames) {
    frame.runtime.effectLedger = authoritativeLedger;
    frame.runtime.retainedEffectSourceSessionId = frame.sessionId;
    frame.runtime.retainedEffectReconciliation = {
      sourceSessionId: frame.sessionId,
      checkpoint: generation.effectLedger,
    };
  }
  return generation;
}

function retainedReviewGeneration(stateId = 'reviewing') {
  const state = parkedState(stateId);
  return {
    effectLedger: effectLedger(),
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
  ledger = effectLedger(),
  cwd = process.cwd(),
  updatedAt = '2026-08-11T21:00:00.020Z',
}: {
  id: string;
  execution?: ReturnType<typeof retentionExecutionProjection>;
  retainedGenerations?: Record<string, unknown>;
  ledger?: Record<string, unknown>;
  cwd?: string;
  updatedAt?: string;
}) {
  return settledRecord({
    sessionId: id,
    createdAt: '2026-08-11T21:00:00.000Z',
    updatedAt,
    cwd,
    structuralProjection: projectCaptainSessionStructure(execution),
    lastAppliedExecutionProjection: execution,
    snapshot: {
      ...shellSnapshot(execution, 1, `source-${id}`),
      effectLedger: ledger,
    },
    effectLedger: ledger,
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
    schemaVersion: 6,
    kind: 'captain-session',
    state: 'settled',
    sessionId,
    createdAt: '2026-08-11T21:00:00.000Z',
    updatedAt: '2026-08-11T21:00:00.001Z',
    cwd: process.cwd(),
    structuralProjection: projectCaptainSessionStructure(execution),
    lastAppliedExecutionProjection: execution,
    snapshot: shellSnapshot(execution),
    effectLedger: effectLedger(),
    unresolvedEffects: [],
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

function legacyRuntimeSnapshot(value: Record<string, any>) {
  const { effectLedger: _effectLedger, ...snapshot } = value;
  return { ...snapshot, schemaVersion: 3 };
}

function legacyShellSnapshot(value: Record<string, any>) {
  const { effectLedger: _effectLedger, ...snapshot } = value;
  return {
    ...snapshot,
    schemaVersion: 3,
    captain: {
      ...snapshot.captain,
      runtime: legacyRuntimeSnapshot(snapshot.captain.runtime),
    },
    ...(snapshot.frames === undefined
      ? {}
      : {
          frames: snapshot.frames.map((frame: Record<string, any>) => ({
            ...frame,
            runtime: legacyRuntimeSnapshot(frame.runtime),
          })),
        }),
  };
}

function legacyRetainedGenerations(value: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(value).map(([rootId, generation]: [string, any]) => {
      const { effectLedger: _effectLedger, ...legacyGeneration } = generation;
      return [
        rootId,
        {
          ...legacyGeneration,
          frames: generation.frames.map((frame: Record<string, any>) => ({
            ...frame,
            runtime: legacyRuntimeSnapshot(frame.runtime),
          })),
        },
      ];
    }),
  );
}

function legacyRecord(
  value: Record<string, any>,
  schemaVersion: 3 | 4 = 3,
) {
  const {
    effectLedger: _effectLedger,
    unresolvedEffects: _unresolvedEffects,
    ...record
  } = value;
  return {
    ...record,
    schemaVersion,
    snapshot: legacyShellSnapshot(record.snapshot),
    ...(record.retainedGenerations === undefined
      ? {}
      : {
          retainedGenerations: legacyRetainedGenerations(
            record.retainedGenerations,
          ),
        }),
  };
}

function preUnresolvedEffectsRecord(value: Record<string, any>) {
  const record = structuredClone(value);
  record.schemaVersion = 5;
  delete record.unresolvedEffects;
  for (const projection of [
    record.structuralProjection,
    record.lastAppliedExecutionProjection,
    record.uncertain?.attemptedExecutionProjection,
  ]) {
    for (const item of Object.values(projection?.catalog ?? {}) as any[]) {
      item.artifactSchema = 2;
    }
  }
  return record;
}

function memberlessSchema3Record(overrides: Record<string, unknown> = {}) {
  const canonical = { ...settledRecord(), ...overrides };
  const { retainedGenerations: _retainedGenerations, ...record } =
    legacyRecord(canonical);
  return record;
}

function freshUncertainRecord(overrides: Record<string, unknown> = {}) {
  const execution = executionProjection();
  return {
    schemaVersion: 6,
    kind: 'captain-session',
    state: 'uncertain',
    sessionId,
    createdAt: '2026-08-11T21:00:00.000Z',
    updatedAt: '2026-08-11T21:00:00.000Z',
    cwd: process.cwd(),
    structuralProjection: projectCaptainSessionStructure(execution),
    lastAppliedExecutionProjection: execution,
    snapshot: shellSnapshot(execution),
    effectLedger: effectLedger(),
    unresolvedEffects: [],
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

describe('durable Captain session records (PBCLI-23/24/51/52/53/54/63/64)', () => {
  it('atomically initializes one validated turn-zero settled record without replacement', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    const execution = executionProjection();
    const structural = projectCaptainSessionStructure(execution);

    await expect(
      lease.initializeSettledWithPredecessor({
        cwd: process.cwd(),
        structuralProjection: structural,
        executionProjection: execution,
        snapshot: shellSnapshot(
          executionProjection({ playerId: 'dev.other' }),
        ),
      }),
    ).rejects.toThrow(/player ledger differs/);
    await expect(store.read(sessionId)).rejects.toThrow(/does not exist/);

    const settled = await lease.initializeSettledWithPredecessor({
      cwd: process.cwd(),
      structuralProjection: structural,
      executionProjection: execution,
      snapshot: shellSnapshot(execution),
    });
    expect(settled).toMatchObject({
      schemaVersion: 6,
      state: 'settled',
      createdAt: '2026-08-11T21:00:00.000Z',
      updatedAt: '2026-08-11T21:00:00.001Z',
      structuralProjection: { schemaVersion: 1 },
      lastAppliedExecutionProjection: { schemaVersion: 2 },
      snapshot: { schemaVersion: 4 },
      effectLedger: effectLedger(),
      retainedGenerations: {},
    });
    const recordPath = join(sessionsDir, `${sessionId}.json`);
    const bytes = await readFile(recordPath, 'utf8');
    await expect(
      lease.initializeSettledWithPredecessor({
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

  it.each([3, 4] as const)(
    'rejects a valid pre-effect schema %s record before continuation',
    async (schemaVersion) => {
      const { sessionsDir } = await fixtureDir();
      const execution = executionProjection();
      const firstLease = await fixedStore(sessionsDir, tokenO).acquire(
        sessionId,
      );
      await firstLease.initializeSettledWithPredecessor({
        cwd: process.cwd(),
        structuralProjection: projectCaptainSessionStructure(execution),
        executionProjection: execution,
        snapshot: shellSnapshot(execution),
      });
      await firstLease.release();

      const recordPath = join(sessionsDir, `${sessionId}.json`);
      const persisted = JSON.parse(await readFile(recordPath, 'utf8'));
      const legacyBytes = `${JSON.stringify(
        legacyRecord(persisted, schemaVersion),
      )}\n`;
      await writeFile(recordPath, legacyBytes, 'utf8');

      const nextLease = await fixedStore(sessionsDir, tokenN).acquire(
        sessionId,
      );
      await expect(nextLease.read()).rejects.toThrow(
        new RegExp(
          `schema ${schemaVersion} predates the artifact-schema-3 effect-authority cutover`,
        ),
      );
      expect(await readFile(recordPath, 'utf8')).toBe(legacyBytes);
      await nextLease.release();
    },
  );

  it('rejects pre-effect records and gives malformed legacy data precedence', () => {
    const execution = schema3ExecutionProjection();
    const legacy = legacyRecord(
      settledRecord({
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: shellSnapshot(execution),
      }),
    );
    expect(() => validateCaptainSessionRecord(legacy)).toThrow(
      /predates the artifact-schema-3 effect-authority cutover/,
    );

    const pollutedShell = legacyRecord(settledRecord());
    pollutedShell.snapshot.effectLedger = effectLedger();
    expect(() => validateCaptainSessionRecord(pollutedShell)).toThrow(
      /legacy Captain shell snapshot must not contain an effect ledger/,
    );

    const pollutedRuntime = legacyRecord(settledRecord());
    pollutedRuntime.snapshot.captain.runtime.effectLedger = effectLedger();
    expect(() => validateCaptainSessionRecord(pollutedRuntime)).toThrow(
      /runtime must not contain an effect ledger/,
    );

    const preUnresolvedEffects = preUnresolvedEffectsRecord(settledRecord());
    expect(() => validateCaptainSessionRecord(preUnresolvedEffects)).toThrow(
      /schema 5 predates the canonical schema-6 unresolved-effect settlement boundary/,
    );
    const malformedPreUnresolvedEffects = structuredClone(
      preUnresolvedEffects,
    );
    delete malformedPreUnresolvedEffects.effectLedger;
    expect(() =>
      validateCaptainSessionRecord(malformedPreUnresolvedEffects),
    ).toThrow(/missing field "effectLedger"/);

    const completeSchema5 = { ...settledRecord(), schemaVersion: 5 };
    expect(() => validateCaptainSessionRecord(completeSchema5)).toThrow(
      /schema 5 predates the canonical schema-6 unresolved-effect settlement boundary/,
    );
    const malformedCompleteSchema5 = structuredClone(completeSchema5);
    delete malformedCompleteSchema5.effectLedger;
    expect(() =>
      validateCaptainSessionRecord(malformedCompleteSchema5),
    ).toThrow(/missing field "effectLedger"/);
  });

  it('writes exact effect-ledger batches atomically and preserves their authoritative mirror', async () => {
    const { sessionsDir } = await fixtureDir();
    const recordPath = join(sessionsDir, `${sessionId}.json`);
    const execution = schema3ExecutionProjection();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    await lease.initializeSettledWithPredecessor(freshBoundary(execution));
    const authority = effectAuthority(execution);
    await expect(
      lease.writeEffectLedger(authority, [
        { kind: 'start-boundaries', boundaries: [effectBoundaryStart()] },
      ]),
    ).rejects.toThrow(/requires an uncertain turn or a settled chat recovery/);
    const uncertain = await lease.beginTurn({
      input: 'perform one repository effect',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    await expect(
      lease.writeEffectLedger(
        { ...authority, leaseOwnerToken: tokenN },
        [{ kind: 'start-boundaries', boundaries: [effectBoundaryStart()] }],
      ),
    ).rejects.toThrow(/does not match the current Captain session lease/);
    await expect(lease.writeEffectLedger(authority, [])).rejects.toThrow(
      /must be a nonempty array/,
    );
    const initialCommands = [
      {
        kind: 'start-boundaries',
        boundaries: [
          effectBoundaryStart(),
          effectBoundaryStart({
            boundaryId: secondEffectBoundaryId,
            logicalOperationId: undefined,
          }),
        ],
      },
      {
        kind: 'append-logical-operations',
        operations: [effectLogicalOperationStart()],
      },
    ];
    const started = await lease.writeEffectLedger(
      authority,
      initialCommands,
    );
    expect(Object.isFrozen(started)).toBe(true);
    expect(Object.isFrozen(started.boundaries[0])).toBe(true);
    expect(started).toMatchObject({
      revision: 1,
      boundaries: [
        {
          sequence: 1,
          attemptId: uncertain.uncertain.attemptId,
          attemptNumber: uncertain.uncertain.attemptNumber,
          boundaryId: effectBoundaryId,
          logicalOperationId: effectOperationId,
        },
        {
          sequence: 2,
          attemptId: uncertain.uncertain.attemptId,
          attemptNumber: uncertain.uncertain.attemptNumber,
          boundaryId: secondEffectBoundaryId,
        },
      ],
      logicalOperations: [
        { sequence: 1, operationId: effectOperationId },
      ],
    });
    const startedBytes = await readFile(recordPath, 'utf8');
    expect(
      await lease.writeEffectLedger(authority, initialCommands),
    ).toEqual(started);
    expect(await readFile(recordPath, 'utf8')).toBe(startedBytes);
    const reorderedStart: any = structuredClone(initialCommands);
    reorderedStart[0].boundaries.reverse();
    await expect(
      lease.writeEffectLedger(authority, reorderedStart),
    ).rejects.toThrow(/reuses an existing boundary id with different data/);
    const conflictingStart: any = structuredClone(initialCommands);
    conflictingStart[0].boundaries[0].callId = 'code:coder:conflict';
    await expect(
      lease.writeEffectLedger(authority, conflictingStart),
    ).rejects.toThrow(/reuses an existing boundary id with different data/);
    const conflictingOperation: any = structuredClone(initialCommands[1]);
    conflictingOperation.operations[0].checkpointRestorationEligible = true;
    await expect(
      lease.writeEffectLedger(authority, [conflictingOperation]),
    ).rejects.toThrow(
      /reuses an existing operation id with different data/,
    );
    expect(await readFile(recordPath, 'utf8')).toBe(startedBytes);
    const retried = await lease.beginRetry({
      expectedAttemptId: attempt1,
      nextAttemptId: attempt2,
    });
    expect(retried.effectLedger).toEqual(started);
    const retriedBytes = await readFile(recordPath, 'utf8');
    expect(
      await lease.writeEffectLedger(authority, initialCommands),
    ).toEqual(started);
    expect(await readFile(recordPath, 'utf8')).toBe(retriedBytes);

    const futureAttempt = structuredClone(await lease.read());
    futureAttempt.effectLedger.boundaries[0].attemptNumber = 3;
    expect(() => validateCaptainSessionRecord(futureAttempt)).toThrow(
      /names a future uncertain attempt/,
    );
    const mismatchedCurrent = structuredClone(await lease.read());
    mismatchedCurrent.effectLedger.boundaries[0].attemptNumber = 2;
    expect(() => validateCaptainSessionRecord(mismatchedCurrent)).toThrow(
      /attempt identity conflicts with the current uncertain marker/,
    );
    const inconsistentPrior = structuredClone(await lease.read());
    inconsistentPrior.effectLedger.boundaries[1].attemptId = attempt3;
    expect(() => validateCaptainSessionRecord(inconsistentPrior)).toThrow(
      /use inconsistent ids for one attempt number/,
    );
    const reusedPriorId = structuredClone(await lease.read());
    reusedPriorId.uncertain.attemptId = attempt3;
    reusedPriorId.uncertain.attemptNumber = 3;
    reusedPriorId.effectLedger.boundaries[1].attemptNumber = 2;
    expect(() => validateCaptainSessionRecord(reusedPriorId)).toThrow(
      /reuse one id across attempt numbers/,
    );

    const after = effectObservation('b'.repeat(40));
    const receipt = {
      classification: 'one-descendant-commit',
      baseline: effectObservation(),
      after,
      commitOid: 'b'.repeat(40),
    };
    const completedBoundary = {
      ...started.boundaries[0],
      after,
      physicalReceipt: receipt,
      finalText: 'Implemented and verified.',
      semanticCandidate: { status: 'ok' },
      correctionBudget: { limit: 1, spent: true },
    };
    const suspendedOperation = {
      ...started.logicalOperations[0],
      checkpoint: after,
      pendingQuestion: {
        questionId: effectQuestionId,
        asker: { kind: 'role', roleId: 'coder' },
        question: 'May I continue?',
      },
      playerContinuation: { token: 'player-continuation' },
      checkpointRestorationEligible: true,
      logicalReceipt: receipt,
    };
    const completionCommands = [
      {
        kind: 'replace-boundaries',
        replacements: [
          { expected: started.boundaries[0], next: completedBoundary },
        ],
      },
      {
        kind: 'replace-logical-operations',
        replacements: [
          {
            expected: started.logicalOperations[0],
            next: suspendedOperation,
          },
        ],
      },
    ];
    const completed = await lease.writeEffectLedger(
      authority,
      completionCommands,
    );
    expect(completed).toMatchObject({
      revision: 2,
      logicalOperations: [
        {
          checkpointRestorationEligible: true,
          pendingQuestion: { questionId: effectQuestionId },
          logicalReceipt: { classification: 'one-descendant-commit' },
        },
      ],
    });
    expect(completed.boundaries[0]).toMatchObject({
      correctionBudget: { limit: 1, spent: true },
    });
    const completedBytes = await readFile(recordPath, 'utf8');
    await expect(
      lease.writeEffectLedger(authority, completionCommands),
    ).rejects.toThrow(/expected does not match the durable boundary/);
    expect(await readFile(recordPath, 'utf8')).toBe(completedBytes);
    await expect(
      lease.writeEffectLedger(authority, [
        {
          kind: 'replace-boundaries',
          replacements: [
            {
              expected: started.boundaries[0],
              next: {
                ...completedBoundary,
                finalText: 'Conflicting stale replacement.',
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow(/expected does not match the durable boundary/);
    expect(await readFile(recordPath, 'utf8')).toBe(completedBytes);

    const correctedBoundary = {
      ...completed.boundaries[0],
      semanticCandidate: { status: 'corrected' },
      initialSemanticCandidate: { status: 'ok' },
    };
    const corrected = await lease.writeEffectLedger(authority, [
      {
        kind: 'replace-boundaries',
        replacements: [
          { expected: completed.boundaries[0], next: correctedBoundary },
        ],
      },
    ]);
    expect(corrected.boundaries[0]).toMatchObject({
      semanticCandidate: { status: 'corrected' },
      initialSemanticCandidate: { status: 'ok' },
      correctionBudget: { limit: 1, spent: true },
    });
    await expect(
      lease.writeEffectLedger(authority, [
        {
          kind: 'replace-boundaries',
          replacements: [
            {
              expected: corrected.boundaries[0],
              next: {
                ...corrected.boundaries[0],
                semanticCandidate: { status: 'rewritten-again' },
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow(/one-way correction provenance/);

    const consumedOperation = {
      ...completed.logicalOperations[0],
      checkpointRestorationEligible: false,
    };
    const consumed = await lease.writeEffectLedger(authority, [
      {
        kind: 'replace-logical-operations',
        replacements: [
          {
            expected: completed.logicalOperations[0],
            next: consumedOperation,
          },
        ],
      },
    ]);
    expect(consumed).toMatchObject({
      revision: 4,
      logicalOperations: [
        {
          checkpointRestorationEligible: false,
          logicalReceipt: { classification: 'one-descendant-commit' },
        },
      ],
    });
    expect(consumed.logicalOperations[0]).toMatchObject({
      checkpoint: after,
      pendingQuestion: { questionId: effectQuestionId },
      playerContinuation: { token: 'player-continuation' },
    });

    const rebound = {
      ...consumed.logicalOperations[0],
      checkpointRestorationEligible: true,
    };
    const repeatedQuestion = {
      ...rebound,
      pendingQuestion: {
        ...rebound.pendingQuestion,
        question: 'May I continue now?',
      },
    };
    const orderedReplacementBatch = [
      {
        kind: 'replace-logical-operations',
        replacements: [
          {
            expected: consumed.logicalOperations[0],
            next: rebound,
          },
        ],
      },
      {
        kind: 'replace-logical-operations',
        replacements: [
          {
            expected: rebound,
            next: repeatedQuestion,
          },
        ],
      },
    ];
    const repeated = await lease.writeEffectLedger(
      authority,
      orderedReplacementBatch,
    );
    expect(repeated).toMatchObject({
      revision: 5,
      logicalOperations: [
        {
          checkpointRestorationEligible: true,
          pendingQuestion: { question: 'May I continue now?' },
        },
      ],
    });
    const repeatedBytes = await readFile(recordPath, 'utf8');
    await expect(
      lease.writeEffectLedger(authority, orderedReplacementBatch),
    ).rejects.toThrow(/expected does not match the durable logical operation/);
    expect(await readFile(recordPath, 'utf8')).toBe(repeatedBytes);

    const recordText = await readFile(recordPath, 'utf8');
    expect(recordText).not.toContain(tokenO);
    await expect(lease.discard({ attemptId: attempt2 })).rejects.toThrow(
      /differs from its pre-turn checkpoint/,
    );
    await expect(
      lease.settle({
        attemptId: attempt2,
        snapshot: engagedSnapshot(execution),
        unresolvedEffects: [],
      }),
    ).rejects.toThrow(/snapshot effect ledger differs from its durable ledger/);

    const mirrored: any = engagedSnapshot(execution);
    mirrored.effectLedger = repeated;
    mirrored.frames[0].runtime.effectLedger = repeated;
    const settled = await lease.settle({
      attemptId: attempt2,
      snapshot: mirrored,
      unresolvedEffects: [],
    });
    expect(settled.effectLedger).toEqual(repeated);
    expect(settled.snapshot.effectLedger).toEqual(repeated);
    expect(settled.snapshot.frames[0].runtime.effectLedger).toEqual(repeated);

    const schema2Execution = executionProjection();
    schema2Execution.catalog.code.artifactSchema = 2;
    expect(() =>
      validateCaptainSessionRecord(
        settledRecord({
          lastAppliedExecutionProjection: schema2Execution,
        }),
      ),
    ).toThrow(/artifactSchema must be 3/);
    await lease.release();
  });

  it('persists abandonment disposal and crash-recovers its exact settlement (PBCLI-71/72)', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = retentionSchema3ExecutionProjection();
    const unresolvedEffects = [unresolvedWorktreeEffect()];
    const parked = engagedSnapshot(execution);
    const retainedGenerations = {
      code: {
        effectLedger: effectLedger(),
        frames: parked.frames,
      },
    };
    const abandonment = { rootPlaybookId: 'code', unresolvedEffects };

    await writeRecordFixture(
      sessionsDir,
      settledRecord({
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: parked,
        unresolvedEffects,
        retainedGenerations,
      }),
    );
    const lease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    await lease.beginTurn({
      input: 'abandon unresolved effects',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    const started = await lease.beginUnresolvedEffectAbandonment(abandonment);
    expect(started).toMatchObject({
      state: 'uncertain',
      retainedGenerations,
      uncertain: {
        abandonment: {
          phase: 'started',
          rootPlaybookId: 'code',
          unresolvedEffects,
        },
      },
    });
    await expect(
      lease.beginRetry({
        expectedAttemptId: attempt1,
        nextAttemptId: attempt2,
      }),
    ).rejects.toThrow(/abandonment must recover before retry/);
    const startedBytes = await readFile(
      join(sessionsDir, `${sessionId}.json`),
      'utf8',
    );
    await expect(
      lease.discard({ attemptId: attempt1 }),
    ).rejects.toThrow(/abandonment must recover before discard/);
    expect(
      await readFile(join(sessionsDir, `${sessionId}.json`), 'utf8'),
    ).toBe(startedBytes);
    await expect(
      lease.settle({
        attemptId: attempt1,
        snapshot: abandonmentSnapshot(execution, 1),
        unresolvedEffects,
        retentionUpdates: [{ kind: 'clear', rootPlaybookId: 'code' }],
      }),
    ).rejects.toThrow(/has not completed disposal/);

    const disposed = await lease.completeUnresolvedEffectAbandonment(
      abandonment,
    );
    expect(disposed).toMatchObject({
      unresolvedEffects,
      retainedGenerations: {},
      uncertain: { abandonment: { phase: 'disposed' } },
    });
    const settled = await lease.settle({
      attemptId: attempt1,
      snapshot: abandonmentSnapshot(execution, 1),
      unresolvedEffects,
      retentionUpdates: [
        { kind: 'clear', rootPlaybookId: 'code' },
        { kind: 'clear', rootPlaybookId: 'review' },
      ],
    });
    expect(settled).toMatchObject({
      state: 'settled',
      snapshot: { mode: 'chat' },
      unresolvedEffects,
      retainedGenerations: {},
      settledAbandonment: {
        phase: 'final',
        attemptId: attempt1,
        rootPlaybookId: 'code',
        unresolvedEffects,
      },
    });
    const nextTurn = await lease.beginTurn({
      input: 'preserve prior abandonment provenance',
      attemptId: attempt3,
      attemptedExecutionProjection: execution,
    });
    expect(nextTurn).toMatchObject({
      state: 'uncertain',
      settledAbandonment: settled.settledAbandonment,
    });
    expect(await lease.discard({ attemptId: attempt3 })).toEqual(settled);
    await lease.release();

    await writeRecordFixture(
      sessionsDir,
      settledRecord({
        sessionId: secondSessionId,
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: parked,
        unresolvedEffects,
        retainedGenerations,
      }),
    );
    const crashed = await fixedStore(
      sessionsDir,
      tokenN,
    ).acquire(secondSessionId);
    await crashed.beginTurn({
      input: 'crash during abandonment',
      attemptId: attempt2,
      attemptedExecutionProjection: execution,
    });
    await crashed.beginUnresolvedEffectAbandonment(abandonment);
    await crashed.release();

    const recoveredLease = await fixedStore(
      sessionsDir,
      tokenR,
    ).acquire(secondSessionId);
    const recovered = await recoveredLease.recoverUnresolvedEffectAbandonment();
    expect(recovered).toMatchObject({
      state: 'settled',
      snapshot: {
        mode: 'chat',
        lastAction: 'runtime',
        lastSettlementStatus: 'ok',
      },
      unresolvedEffects,
      retainedGenerations: {},
      settledAbandonment: {
        phase: 'recovered',
        attemptId: attempt2,
        rootPlaybookId: 'code',
        unresolvedEffects,
      },
    });
    expect(
      await recoveredLease.recoverUnresolvedEffectAbandonment(),
    ).toEqual(recovered);

    const exactLateSettlement = await recoveredLease.settle({
      attemptId: attempt2,
      snapshot: abandonmentSnapshot(execution, 1),
      unresolvedEffects,
      retentionUpdates: [{ kind: 'clear', rootPlaybookId: 'code' }],
    });
    expect(exactLateSettlement).toMatchObject({
      state: 'settled',
      snapshot: { mode: 'chat', sequences: { turn: 1 } },
      unresolvedEffects,
      retainedGenerations: {},
    });
    expect(exactLateSettlement).toMatchObject({
      settledAbandonment: {
        phase: 'final',
        attemptId: attempt2,
        rootPlaybookId: 'code',
        unresolvedEffects,
      },
    });
    expect(
      await recoveredLease.settle({
        attemptId: attempt2,
        snapshot: abandonmentSnapshot(execution, 1),
        unresolvedEffects,
        retentionUpdates: [{ kind: 'clear', rootPlaybookId: 'code' }],
      }),
    ).toEqual(exactLateSettlement);
    await expect(
      recoveredLease.settle({
        attemptId: attempt3,
        snapshot: abandonmentSnapshot(execution, 1),
        unresolvedEffects,
        retentionUpdates: [{ kind: 'clear', rootPlaybookId: 'code' }],
      }),
    ).rejects.toThrow(/attempt differs from its durable marker/);
    await expect(
      recoveredLease.settle({
        attemptId: attempt2,
        snapshot: abandonmentSnapshot(execution, 1),
        unresolvedEffects,
        retentionUpdates: [{ kind: 'clear', rootPlaybookId: 'review' }],
      }),
    ).rejects.toThrow(/must clear its durable root/);
    await expect(
      recoveredLease.settle({
        attemptId: attempt2,
        snapshot: abandonmentSnapshot(execution, 2),
        unresolvedEffects,
        retentionUpdates: [{ kind: 'clear', rootPlaybookId: 'code' }],
      }),
    ).rejects.toThrow(/differs from its finalized durable record/);
    await recoveredLease.release();
  });

  it('re-synchronizes every published abandonment phase before acknowledging replay', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = schema3ExecutionProjection();
    const unresolvedEffects = [unresolvedWorktreeEffect()];
    const parked = engagedSnapshot(execution);
    const retainedGenerations = {
      code: {
        effectLedger: effectLedger(),
        frames: parked.frames,
      },
    };
    const abandonment = { rootPlaybookId: 'code', unresolvedEffects };
    let directorySyncFailures = 0;
    const storeOptions = {
      createTempId: () => tempId,
      fsOps: {
        async open(path: string, flags: string | number, mode?: number) {
          const handle = await open(path, flags as any, mode);
          if (path !== sessionsDir || flags !== 'r') return handle;
          return {
            async sync() {
              if (directorySyncFailures > 0) {
                directorySyncFailures -= 1;
                throw new Error('synthetic abandonment directory sync failure');
              }
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      },
    };
    await writeRecordFixture(
      sessionsDir,
      settledRecord({
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: parked,
        unresolvedEffects,
        retainedGenerations,
      }),
    );
    const lease = await fixedStore(
      sessionsDir,
      tokenO,
      storeOptions,
    ).acquire(sessionId);
    await lease.beginTurn({
      input: 'publish every abandonment phase',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });

    directorySyncFailures = 1;
    await expect(
      lease.beginUnresolvedEffectAbandonment(abandonment),
    ).rejects.toThrow(/synthetic abandonment directory sync failure/);
    expect(await lease.read()).toMatchObject({
      state: 'uncertain',
      uncertain: { abandonment: { phase: 'started' } },
    });
    await lease.beginUnresolvedEffectAbandonment(abandonment);

    directorySyncFailures = 1;
    await expect(
      lease.completeUnresolvedEffectAbandonment(abandonment),
    ).rejects.toThrow(/synthetic abandonment directory sync failure/);
    expect(await lease.read()).toMatchObject({
      state: 'uncertain',
      unresolvedEffects,
      retainedGenerations: {},
      uncertain: { abandonment: { phase: 'disposed' } },
    });
    await expect(
      lease.settle({
        attemptId: attempt1,
        snapshot: {
          ...abandonmentSnapshot(execution, 1),
          lastSettlementStatus: 'failed',
        },
        unresolvedEffects,
        retentionUpdates: [{ kind: 'clear', rootPlaybookId: 'code' }],
      }),
    ).rejects.toThrow(/successful host-disposal snapshot/);
    expect((await lease.read()).state).toBe('uncertain');
    await lease.completeUnresolvedEffectAbandonment(abandonment);

    const finalInput = {
      attemptId: attempt1,
      snapshot: abandonmentSnapshot(execution, 1),
      unresolvedEffects,
      retentionUpdates: [{ kind: 'clear' as const, rootPlaybookId: 'code' }],
    };
    directorySyncFailures = 1;
    await expect(lease.settle(finalInput)).rejects.toThrow(
      /synthetic abandonment directory sync failure/,
    );
    const publishedFinal = await lease.read();
    expect(publishedFinal).toMatchObject({
      state: 'settled',
      settledAbandonment: { phase: 'final', attemptId: attempt1 },
    });
    expect(await lease.settle(finalInput)).toEqual(publishedFinal);
    await lease.release();

    await writeRecordFixture(
      sessionsDir,
      settledRecord({
        sessionId: secondSessionId,
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: parked,
        unresolvedEffects,
        retainedGenerations,
      }),
    );
    const crashed = await fixedStore(
      sessionsDir,
      tokenN,
      storeOptions,
    ).acquire(secondSessionId);
    await crashed.beginTurn({
      input: 'crash before host disposal',
      attemptId: attempt2,
      attemptedExecutionProjection: execution,
    });
    await crashed.beginUnresolvedEffectAbandonment(abandonment);
    await crashed.release();

    const successor = await fixedStore(
      sessionsDir,
      tokenR,
      storeOptions,
    ).acquire(secondSessionId);
    directorySyncFailures = 1;
    await expect(
      successor.recoverUnresolvedEffectAbandonment(),
    ).rejects.toThrow(/synthetic abandonment directory sync failure/);
    const publishedRecovery = await successor.read();
    expect(publishedRecovery).toMatchObject({
      state: 'settled',
      settledAbandonment: { phase: 'recovered', attemptId: attempt2 },
    });
    expect(
      await successor.recoverUnresolvedEffectAbandonment(),
    ).toEqual(publishedRecovery);
    await successor.release();
  });

  it('keeps the uncertain boundary when abandonment begin cannot publish', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = schema3ExecutionProjection();
    const unresolvedEffects = [unresolvedWorktreeEffect()];
    const parked = engagedSnapshot(execution);
    const recordPath = join(sessionsDir, `${sessionId}.json`);
    let failAbandonmentBegin = false;
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: {
        async rename(from: string, to: string) {
          if (failAbandonmentBegin && to === recordPath) {
            throw new Error('synthetic abandonment begin publication failure');
          }
          return rename(from, to);
        },
      },
    });
    await writeRecordFixture(
      sessionsDir,
      settledRecord({
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: parked,
        unresolvedEffects,
        retainedGenerations: {
          code: { effectLedger: effectLedger(), frames: parked.frames },
        },
      }),
    );
    const lease = await store.acquire(sessionId);
    await lease.beginTurn({
      input: 'fail abandonment begin publication',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    const uncertainBytes = await readFile(recordPath, 'utf8');
    failAbandonmentBegin = true;
    await expect(
      lease.beginUnresolvedEffectAbandonment({
        rootPlaybookId: 'code',
        unresolvedEffects,
      }),
    ).rejects.toThrow(/synthetic abandonment begin publication failure/);
    expect(await readFile(recordPath, 'utf8')).toBe(uncertainBytes);
    expect(await lease.read()).toMatchObject({
      state: 'uncertain',
      unresolvedEffects,
    });
    expect((await lease.read()).uncertain).not.toHaveProperty('abandonment');
    failAbandonmentBegin = false;
    await lease.release();
  });

  it('completes retained-launch recovery in a settled chat record', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = retentionSchema3ExecutionProjection();
    const started = startedEffectLedger();
    await writeRecordFixture(
      sessionsDir,
      settledRecord({
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: { ...shellSnapshot(execution), effectLedger: started },
        effectLedger: started,
        retainedGenerations: { code: retainedCodeGeneration() },
      }),
    );
    const lease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    const expected = started.boundaries[0];
    const after = effectObservation();
    const next = {
      ...expected,
      after,
      physicalReceipt: {
        classification: 'unchanged',
        baseline: expected.baseline,
        after,
      },
    };

    const before = await lease.read();
    await expect(
      lease.writeEffectLedger(effectAuthority(execution), [
        { kind: 'replace-logical-operations', replacements: [{}] },
      ]),
    ).rejects.toThrow(/only complete existing physical boundaries/);
    await expect(
      lease.writeEffectLedger(effectAuthority(execution), [
        {
          kind: 'replace-boundaries',
          replacements: [
            { expected, next: { ...next, finalText: 'not recovery evidence' } },
          ],
        },
      ]),
    ).rejects.toThrow(/cannot change boundary semantics or identity/);
    expect(await lease.read()).toEqual(before);

    const completed = await lease.writeEffectLedger(
      effectAuthority(execution),
      [
        {
          kind: 'replace-boundaries',
          replacements: [{ expected, next }],
        },
      ],
    );

    expect(completed.boundaries[0]).toEqual(next);
    expect(await lease.read()).toMatchObject({
      state: 'settled',
      effectLedger: completed,
      snapshot: { mode: 'chat', effectLedger: completed },
    });
    await expect(
      lease.writeEffectLedger(effectAuthority(execution), [
        {
          kind: 'replace-boundaries',
          replacements: [{ expected: next, next }],
        },
      ]),
    ).rejects.toThrow(/requires one new physical receipt/);
    await lease.release();
  });

  it('recovers a settled abandoned boundary without changing its frozen list', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = schema3ExecutionProjection();
    const started = startedEffectLedger();
    const unresolvedEffects = [
      {
        classification: 'incomplete',
        baselineHead: 'a'.repeat(40),
      },
    ];
    await writeRecordFixture(
      sessionsDir,
      settledRecord({
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: { ...shellSnapshot(execution), effectLedger: started },
        effectLedger: started,
        unresolvedEffects,
      }),
    );
    const lease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    const expected = started.boundaries[0];
    const after = effectObservation();

    const completed = await lease.writeEffectLedger(
      effectAuthority(execution),
      [
        {
          kind: 'replace-boundaries',
          replacements: [
            {
              expected,
              next: {
                ...expected,
                after,
                physicalReceipt: {
                  classification: 'unchanged',
                  baseline: expected.baseline,
                  after,
                },
              },
            },
          ],
        },
      ],
    );
    expect(completed.boundaries[0]).toHaveProperty(
      'physicalReceipt.classification',
      'unchanged',
    );
    expect(await lease.read()).toMatchObject({
      state: 'settled',
      unresolvedEffects,
      retainedGenerations: {},
      effectLedger: completed,
      snapshot: { effectLedger: completed },
    });
    await lease.release();
  });

  it('rejects settled effect recovery without retained or unresolved work', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = schema3ExecutionProjection();
    const started = startedEffectLedger();
    await writeRecordFixture(
      sessionsDir,
      settledRecord({
        structuralProjection: projectCaptainSessionStructure(execution),
        lastAppliedExecutionProjection: execution,
        snapshot: { ...shellSnapshot(execution), effectLedger: started },
        effectLedger: started,
      }),
    );
    const lease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    const expected = started.boundaries[0];
    const after = effectObservation();

    await expect(
      lease.writeEffectLedger(effectAuthority(execution), [
        {
          kind: 'replace-boundaries',
          replacements: [
            {
              expected,
              next: {
                ...expected,
                after,
                physicalReceipt: {
                  classification: 'unchanged',
                  baseline: expected.baseline,
                  after,
                },
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow(/requires an uncertain turn or a settled chat recovery/);
    await lease.release();
  });

  it('keeps the prior effect ledger authoritative when batch publication fails', async () => {
    const { sessionsDir } = await fixtureDir();
    const recordPath = join(sessionsDir, `${sessionId}.json`);
    let failRecordRename = false;
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: {
        async rename(source: string, destination: string) {
          if (failRecordRename && destination === recordPath) {
            throw new Error('synthetic ledger publication failure');
          }
          return rename(source, destination);
        },
      },
    });
    const execution = schema3ExecutionProjection();
    const lease = await store.acquire(sessionId);
    await lease.initializeSettledWithPredecessor(freshBoundary(execution));
    await lease.beginTurn({
      input: 'attempt an atomic repository effect',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    const {
      logicalOperationId: _logicalOperationId,
      ...standaloneBoundary
    } = effectBoundaryStart();
    failRecordRename = true;
    await expect(
      lease.writeEffectLedger(effectAuthority(execution), [
        { kind: 'start-boundaries', boundaries: [standaloneBoundary] },
      ]),
    ).rejects.toThrow(/synthetic ledger publication failure/);
    failRecordRename = false;
    expect((await lease.read()).effectLedger).toEqual(effectLedger());
    expect((await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')))
      .toBe(false);
    await lease.release();
  });

  it('retries directory durability before acknowledging an indeterminate ledger write', async () => {
    const { sessionsDir } = await fixtureDir();
    const recordPath = join(sessionsDir, `${sessionId}.json`);
    let directorySyncFailures = 0;
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: {
        async open(path: string, flags: string, mode?: number) {
          const handle = await open(path, flags, mode);
          if (path !== sessionsDir) return handle;
          return {
            async sync() {
              if (directorySyncFailures > 0) {
                directorySyncFailures -= 1;
                throw new Error('synthetic record directory sync failure');
              }
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      },
    });
    const execution = schema3ExecutionProjection();
    const authority = effectAuthority(execution);
    const lease = await store.acquire(sessionId);
    await lease.initializeSettledWithPredecessor(freshBoundary(execution));
    await lease.beginTurn({
      input: 'attempt a durable repository effect',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    const {
      logicalOperationId: _logicalOperationId,
      ...standaloneBoundary
    } = effectBoundaryStart();
    const started = await lease.writeEffectLedger(authority, [
      { kind: 'start-boundaries', boundaries: [standaloneBoundary] },
    ]);
    const boundary = started.boundaries[0]!;
    const completedBoundary = {
      ...boundary,
      after: boundary.baseline,
      physicalReceipt: {
        classification: 'unchanged',
        baseline: boundary.baseline,
        after: boundary.baseline,
      },
    };
    const completionCommands = [
      {
        kind: 'replace-boundaries',
        replacements: [{ expected: boundary, next: completedBoundary }],
      },
    ];

    directorySyncFailures = 2;
    await expect(
      lease.writeEffectLedger(authority, completionCommands),
    ).rejects.toThrow(/synthetic record directory sync failure/);
    const publishedBytes = await readFile(recordPath, 'utf8');
    expect((await lease.read()).effectLedger).toMatchObject({ revision: 2 });
    await expect(
      lease.writeEffectLedger(authority, completionCommands),
    ).rejects.toThrow(/synthetic record directory sync failure/);
    expect(await readFile(recordPath, 'utf8')).toBe(publishedBytes);

    const acknowledged = await lease.writeEffectLedger(
      authority,
      completionCommands,
    );
    expect(acknowledged).toMatchObject({ revision: 2 });
    expect(await readFile(recordPath, 'utf8')).toBe(publishedBytes);
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
    const schema3Execution = structuredClone(execution);
    schema3Execution.catalog.code.artifactSchema = 3;
    expect(
      validateCaptainSessionExecutionProjection(schema3Execution).catalog.code
        .artifactSchema,
    ).toBe(3);
    expect(
      validateCaptainSessionStructuralProjection(
        projectCaptainSessionStructure(schema3Execution),
      ).catalog.code.artifactSchema,
    ).toBe(3);
    const structuralWithCapabilities = structuredClone(structural);
    structuralWithCapabilities.catalog.code.options = {
      hostCapabilities: {},
    };
    expect(() =>
      validateCaptainSessionStructuralProjection(structuralWithCapabilities),
    ).toThrow(
      /options\.hostCapabilities is host-owned and cannot be persisted/,
    );
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

    expect(validated.captain).not.toHaveProperty('fastMode');
    const fastModeExecution: any = structuredClone(execution);
    fastModeExecution.captain.fastMode = false;
    fastModeExecution.players[0].fastMode = true;
    fastModeExecution.catalog.code.roles.coder.fastMode = false;
    const validatedFastMode = validateCaptainSessionExecutionProjection(
      fastModeExecution,
    );
    expect(validatedFastMode).toMatchObject({
      captain: { fastMode: false },
      players: [{ fastMode: true }],
      catalog: { code: { roles: { coder: { fastMode: false } } } },
    });
    const fastModeStructure = projectCaptainSessionStructure(
      validatedFastMode,
    );
    expect(fastModeStructure.captain).not.toHaveProperty('fastMode');
    expect(fastModeStructure.players[0]).not.toHaveProperty('fastMode');
    expect(fastModeStructure.catalog.code.roles.coder).not.toHaveProperty(
      'fastMode',
    );

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
        'non-boolean Captain fast mode',
        {
          ...execution,
          captain: { ...execution.captain, fastMode: 'yes' },
        },
        /fastMode.*boolean/,
      ],
      [
        'non-boolean player fast mode',
        {
          ...execution,
          players: [{ ...execution.players[0], fastMode: 'yes' }],
        },
        /fastMode.*boolean/,
      ],
      [
        'non-boolean role fast mode',
        {
          ...execution,
          catalog: {
            code: {
              ...execution.catalog.code,
              roles: {
                coder: {
                  ...execution.catalog.code.roles.coder,
                  fastMode: 'yes',
                },
              },
            },
          },
        },
        /fastMode.*boolean/,
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
        'unsupported artifact schema',
        {
          ...execution,
          catalog: {
            code: { ...execution.catalog.code, artifactSchema: 1 },
          },
        },
        /artifactSchema must be 3/,
      ],
      [
        'future artifact schema',
        {
          ...execution,
          catalog: {
            code: { ...execution.catalog.code, artifactSchema: 4 },
          },
        },
        /artifactSchema must be 3/,
      ],
      [
        'persisted host capabilities',
        {
          ...execution,
          catalog: {
            code: {
              ...execution.catalog.code,
              options: { hostCapabilities: {} },
            },
          },
        },
        /options\.hostCapabilities is host-owned and cannot be persisted/,
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
    const initialized =
      await firstLease.initializeSettledWithPredecessor(
        freshBoundary(initialExecution),
      );
    const uncertain = await firstLease.beginTurn({
      input: '  exact input\n',
      attemptId: attempt1,
      attemptedExecutionProjection: initialExecution,
    });
    expect(uncertain).toMatchObject({
      schemaVersion: 6,
      kind: 'captain-session',
      state: 'uncertain',
      sessionId,
      retainedGenerations: {},
      uncertain: {
        baseUpdatedAt: initialized.updatedAt,
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
      unresolvedEffects: [],
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
      collisionLease.initializeSettledWithPredecessor(
        freshBoundary(initialExecution),
      ),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(recordPath, 'utf8')).toBe(settledBytes);
    expect((await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')))
      .toBe(false);
    await collisionLease.release();
  });

  it('retries and settles a historical never-settled uncertain record', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = executionProjection();
    await writeRecordFixture(sessionsDir, freshUncertainRecord());
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);

    const retried = await lease.beginRetry({
      expectedAttemptId: attempt1,
      nextAttemptId: attempt2,
    });
    expect(retried.uncertain).toMatchObject({
      baseUpdatedAt: null,
      input: 'fresh input',
      attemptId: attempt2,
      attemptNumber: 2,
    });
    const settled = await lease.settle({
      attemptId: attempt2,
      snapshot: shellSnapshot(execution, 1),
      unresolvedEffects: [],
      retentionUpdates: [],
    });
    expect(settled).toMatchObject({
      schemaVersion: 6,
      state: 'settled',
      sessionId,
      createdAt: '2026-08-11T21:00:00.000Z',
      retainedGenerations: {},
    });
    expect(settled).not.toHaveProperty('uncertain');
    await lease.release();
  });

  it('replaces and clears one retained generation without disturbing another root', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    const execution = retentionExecutionProjection();
    await lease.initializeSettledWithPredecessor(freshBoundary(execution));
    await lease.beginTurn({
      input: 'retain two roots',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    const first = await lease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(execution, 1),
      unresolvedEffects: [],
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
      unresolvedEffects: [],
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
      unresolvedEffects: [],
      retentionUpdates: [
        { kind: 'clear', rootPlaybookId: 'code' },
      ],
    });
    expect(cleared.retainedGenerations).toEqual({
      review: retainedReviewGeneration(),
    });
    await lease.release();
  });

  it.each(['member-less schema 6', 'explicitly empty'] as const)(
    'selects the newest settled same-cwd %s predecessor without older fallback',
    async (shape) => {
      const { sessionsDir } = await fixtureDir();
      const olderId = adoptionSessionId(1);
      const emptyId = adoptionSessionId(2);
      const uncertainId = adoptionSessionId(3);
      const otherCwdId = adoptionSessionId(4);
      const targetId = adoptionSessionId(5);
      const older = retainedSettledRecord({
        id: olderId,
        updatedAt: '2026-08-11T21:00:00.040Z',
      });
      const empty: any = retainedSettledRecord({
        id: emptyId,
        retainedGenerations: {},
        updatedAt: '2026-08-11T21:00:00.040Z',
      });
      if (shape === 'member-less schema 6') {
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
      for (const record of [older, empty, uncertain, otherCwd]) {
        await writeRecordFixture(sessionsDir, record);
      }
      const paths = [olderId, emptyId].map((id) =>
        join(sessionsDir, `${id}.json`),
      );
      const before = await Promise.all(
        paths.map((path) => readFile(path, 'utf8')),
      );

      const store = sequencedStore(sessionsDir);
      const lease = await store.acquire(targetId);
      const initialized = await lease.initializeSettledWithPredecessor({
        cwd: target.cwd,
        structuralProjection: target.structuralProjection,
        executionProjection: target.lastAppliedExecutionProjection,
        snapshot: target.snapshot,
      });
      expect(initialized).toMatchObject({
        sessionId: targetId,
        retainedGenerations: {},
      });
      expect(Date.parse(initialized.updatedAt)).toBeGreaterThan(
        Date.parse(empty.updatedAt),
      );
      await lease.release();

      expect(
        await Promise.all(paths.map((path) => readFile(path, 'utf8'))),
      ).toEqual(before);
      expect((await store.read(olderId)).retainedGenerations).toEqual({
        code: retainedCodeGeneration(),
        review: retainedReviewGeneration(),
      });
      expect(await store.read(targetId)).toEqual(initialized);
    },
  );

  it('declines a live newest predecessor without falling through to older work', async () => {
    const { sessionsDir } = await fixtureDir();
    const olderId = adoptionSessionId(60);
    const liveId = adoptionSessionId(61);
    const targetId = adoptionSessionId(62);
    const older = retainedSettledRecord({
      id: olderId,
      updatedAt: '2026-08-11T21:00:00.020Z',
    });
    const live = retainedSettledRecord({
      id: liveId,
      updatedAt: '2026-08-11T21:00:00.040Z',
    });
    const olderPath = await writeRecordFixture(sessionsDir, older);
    const livePath = await writeRecordFixture(sessionsDir, live);
    const before = await Promise.all(
      [olderPath, livePath].map((path) => readFile(path, 'utf8')),
    );
    const store = sequencedStore(sessionsDir, 60, {
      probeProcess: async () => {},
    });
    const liveLease = await store.acquire(liveId);
    const targetLease = await store.acquire(targetId);
    const targetTemplate = freshAdoptionTargetRecord({ id: targetId });

    const initialized =
      await targetLease.initializeSettledWithPredecessor({
        cwd: targetTemplate.cwd,
        structuralProjection: targetTemplate.structuralProjection,
        executionProjection: targetTemplate.lastAppliedExecutionProjection,
        snapshot: targetTemplate.snapshot,
      });

    expect(initialized.retainedGenerations).toEqual({});
    expect(
      await Promise.all(
        [olderPath, livePath].map((path) => readFile(path, 'utf8')),
      ),
    ).toEqual(before);
    expect((await store.read(olderId)).retainedGenerations).not.toEqual({});
    expect((await store.read(liveId)).retainedGenerations).not.toEqual({});
    expect((await store.latest()).sessionId).toBe(targetId);
    await targetLease.release();
    await liveLease.release();
  });

  it.each(['foreign', 'permission unknown'] as const)(
    'fails closed when predecessor lease ownership is %s',
    async (ownership) => {
      const { sessionsDir } = await fixtureDir();
      const sourceId = adoptionSessionId(73);
      const targetId = adoptionSessionId(74);
      const sourcePath = await writeRecordFixture(
        sessionsDir,
        retainedSettledRecord({ id: sourceId }),
      );
      const sourceBytes = await readFile(sourcePath, 'utf8');
      const ownerStore = sequencedStore(sessionsDir, 120);
      const sourceLease = await ownerStore.acquire(sourceId);
      const targetStore = sequencedStore(sessionsDir, 130, {
        ...(ownership === 'foreign' ? { hostname: 'other-host' } : {}),
        probeProcess: async () => {
          throw Object.assign(new Error('permission denied'), {
            code: 'EPERM',
          });
        },
      });
      const targetTemplate = freshAdoptionTargetRecord({ id: targetId });
      const targetLease = await targetStore.acquire(targetId);

      await expect(
        targetLease.initializeSettledWithPredecessor({
          cwd: targetTemplate.cwd,
          structuralProjection: targetTemplate.structuralProjection,
          executionProjection:
            targetTemplate.lastAppliedExecutionProjection,
          snapshot: targetTemplate.snapshot,
        }),
      ).rejects.toThrow(
        ownership === 'foreign'
          ? /owned by foreign host/
          : /owner process cannot be ruled dead/,
      );
      expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
      await expect(targetStore.read(targetId)).rejects.toThrow(
        /does not exist/,
      );
      await targetLease.release();
      await sourceLease.release();
    },
  );

  it.each(['disappeared', 'superseded', 'invalid'] as const)(
    'declines when the nominated predecessor is %s before authoritative read',
    async (race) => {
      const { sessionsDir } = await fixtureDir();
      const sourceId = adoptionSessionId(70);
      const newerId = adoptionSessionId(71);
      const targetId = adoptionSessionId(72);
      const source = retainedSettledRecord({
        id: sourceId,
        updatedAt: '2026-08-11T21:00:00.040Z',
      });
      const newer = retainedSettledRecord({
        id: newerId,
        updatedAt: '2026-08-11T21:00:00.060Z',
      });
      const sourcePath = await writeRecordFixture(sessionsDir, source);
      const sourceBytes = await readFile(sourcePath, 'utf8');
      const sourceLeasePath = join(sessionsDir, `.${sourceId}.lock`);
      let raced = false;
      const store = sequencedStore(sessionsDir, 110, {
        fsOps: {
          async rename(from: string, to: string) {
            await rename(from, to);
            if (to !== sourceLeasePath || raced) return;
            raced = true;
            if (race === 'disappeared') {
              await unlink(sourcePath);
            } else if (race === 'invalid') {
              await writeFile(
                join(sessionsDir, `${newerId}.json`),
                '{not-json\n',
                { mode: 0o600 },
              );
            } else {
              await writeRecordFixture(sessionsDir, newer);
            }
          },
        },
      });
      const targetTemplate = freshAdoptionTargetRecord({ id: targetId });
      const lease = await store.acquire(targetId);
      const invalidRecords: unknown[] = [];

      const initialized =
        await lease.initializeSettledWithPredecessor({
          cwd: targetTemplate.cwd,
          structuralProjection: targetTemplate.structuralProjection,
          executionProjection:
            targetTemplate.lastAppliedExecutionProjection,
          snapshot: targetTemplate.snapshot,
          onInvalidRecord: (record: unknown) => invalidRecords.push(record),
        });

      expect(initialized.retainedGenerations).toEqual({});
      expect(Date.parse(initialized.updatedAt)).toBeGreaterThan(
        Date.parse(race === 'superseded' ? newer.updatedAt : source.updatedAt),
      );
      if (race === 'disappeared') {
        await expect(store.read(sourceId)).rejects.toThrow(/does not exist/);
      } else {
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
        if (race === 'invalid') {
          expect(invalidRecords).toEqual([
            {
              sessionId: newerId,
              path: join(sessionsDir, `${newerId}.json`),
              reason: expect.stringMatching(/not valid JSON/),
            },
          ]);
          expect(
            await readFile(join(sessionsDir, `${newerId}.json`), 'utf8'),
          ).toBe('{not-json\n');
        } else {
          expect((await store.read(newerId)).retainedGenerations).not.toEqual(
            {},
          );
        }
      }
      if (race !== 'invalid') {
        expect((await store.latest()).sessionId).toBe(targetId);
      }
      await lease.release();
    },
  );

  it(
    'declines incompatible root options before publishing an empty target',
    async () => {
      const { sessionsDir } = await fixtureDir();
      const sourceId = adoptionSessionId(63);
      const targetId = adoptionSessionId(64);
      const source = retainedSettledRecord({ id: sourceId });
      const sourcePath = await writeRecordFixture(sessionsDir, source);
      const sourceBytes = await readFile(sourcePath, 'utf8');
      const targetExecution: any = retentionExecutionProjection();
      targetExecution.catalog.code.options = { incompatible: true };
      const targetTemplate = freshAdoptionTargetRecord({
        id: targetId,
        execution: targetExecution,
      });
      const store = sequencedStore(sessionsDir, 70);
      const lease = await store.acquire(targetId);

      const initialized = await lease.initializeSettledWithPredecessor({
        cwd: targetTemplate.cwd,
        structuralProjection: targetTemplate.structuralProjection,
        executionProjection: targetTemplate.lastAppliedExecutionProjection,
        snapshot: targetTemplate.snapshot,
      });

      expect(initialized.retainedGenerations).toEqual({});
      expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
      expect(await store.read(targetId)).toEqual(initialized);
      await lease.release();
    },
  );

  it('skips an invalid record while publishing an empty fresh target', async () => {
    const { sessionsDir } = await fixtureDir();
    const corruptId = adoptionSessionId(65);
    const targetId = adoptionSessionId(66);
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    await writeFile(join(sessionsDir, `${corruptId}.json`), '{broken\n', {
      mode: 0o600,
    });
    const targetTemplate = freshAdoptionTargetRecord({ id: targetId });
    const store = sequencedStore(sessionsDir, 80);
    const lease = await store.acquire(targetId);

    const initialized = await lease.initializeSettledWithPredecessor({
      cwd: targetTemplate.cwd,
      structuralProjection: targetTemplate.structuralProjection,
      executionProjection: targetTemplate.lastAppliedExecutionProjection,
      snapshot: targetTemplate.snapshot,
    });
    expect(initialized).toMatchObject({
      sessionId: targetId,
      retainedGenerations: {},
    });
    expect(await store.read(targetId)).toEqual(initialized);
    await lease.release();
  });

  it('requires current target ownership immediately before guarded publication', async () => {
    const { sessionsDir } = await fixtureDir();
    const legacyId = adoptionSessionId(75);
    const targetId = adoptionSessionId(76);
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(sessionsDir, `${legacyId}.json`),
      `${JSON.stringify(
        releasedSchema2Record({ sessionId: legacyId }),
      )}\n`,
      { mode: 0o600 },
    );
    const store = sequencedStore(sessionsDir, 140);
    const lease = await store.acquire(targetId);
    const ownerPath = join(sessionsDir, `.${targetId}.lock`, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    const targetTemplate = freshAdoptionTargetRecord({ id: targetId });

    await expect(
      lease.initializeSettledWithPredecessor({
        cwd: targetTemplate.cwd,
        structuralProjection: targetTemplate.structuralProjection,
        executionProjection: targetTemplate.lastAppliedExecutionProjection,
        snapshot: targetTemplate.snapshot,
        async onLegacyRecord() {
          await writeFile(
            ownerPath,
            `${JSON.stringify({
              ...owner,
              ownerToken: adoptionLeaseToken(999),
            })}\n`,
            'utf8',
          );
        },
      }),
    ).rejects.toThrow(/owned by a different token/);
    await expect(store.read(targetId)).rejects.toThrow(/does not exist/);
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, 'utf8');
    await lease.release();
  });

  it('requires target ownership before clearing a transferable predecessor', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(78);
    const targetId = adoptionSessionId(79);
    const sourcePath = await writeRecordFixture(
      sessionsDir,
      retainedSettledRecord({ id: sourceId }),
    );
    const sourceBytes = await readFile(sourcePath, 'utf8');
    const sourceLeasePath = join(sessionsDir, `.${sourceId}.lock`);
    const targetOwnerPath = join(
      sessionsDir,
      `.${targetId}.lock`,
      'owner.json',
    );
    let targetOwner: any;
    let ownerChanged = false;
    const store = sequencedStore(sessionsDir, 145, {
      fsOps: {
        async rename(from: string, to: string) {
          await rename(from, to);
          if (to !== sourceLeasePath || ownerChanged) return;
          ownerChanged = true;
          await writeFile(
            targetOwnerPath,
            `${JSON.stringify({
              ...targetOwner,
              ownerToken: adoptionLeaseToken(999),
            })}\n`,
            'utf8',
          );
        },
      },
    });
    const lease = await store.acquire(targetId);
    targetOwner = JSON.parse(await readFile(targetOwnerPath, 'utf8'));
    const target = freshAdoptionTargetRecord({ id: targetId });

    await expect(
      lease.initializeSettledWithPredecessor({
        cwd: target.cwd,
        structuralProjection: target.structuralProjection,
        executionProjection: target.lastAppliedExecutionProjection,
        snapshot: target.snapshot,
      }),
    ).rejects.toThrow(/owned by a different token/);
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
    await expect(store.read(targetId)).rejects.toThrow(/does not exist/);
    await writeFile(
      targetOwnerPath,
      `${JSON.stringify(targetOwner)}\n`,
      'utf8',
    );
    await lease.release();
  });

  it('rechecks target ownership before abandoning an exact empty boundary', async () => {
    const { sessionsDir } = await fixtureDir();
    const targetId = adoptionSessionId(77);
    const targetPath = join(sessionsDir, `${targetId}.json`);
    const ownerPath = join(sessionsDir, `.${targetId}.lock`, 'owner.json');
    let owner;
    let armOwnerLoss = false;
    const store = sequencedStore(sessionsDir, 150, {
      fsOps: {
        async open(path: string, flags: string | number, mode?: number) {
          const handle = await open(path, flags as any, mode);
          if (path !== targetPath || !armOwnerLoss) return handle;
          return {
            stat: () => handle.stat(),
            async readFile(encoding: BufferEncoding) {
              const value = await handle.readFile(encoding);
              armOwnerLoss = false;
              await writeFile(
                ownerPath,
                `${JSON.stringify({
                  ...owner,
                  ownerToken: adoptionLeaseToken(999),
                })}\n`,
                'utf8',
              );
              return value;
            },
            close: () => handle.close(),
          };
        },
      },
    });
    const lease = await store.acquire(targetId);
    const targetTemplate = freshAdoptionTargetRecord({ id: targetId });
    const initialized =
      await lease.initializeSettledWithPredecessor({
        cwd: targetTemplate.cwd,
        structuralProjection: targetTemplate.structuralProjection,
        executionProjection: targetTemplate.lastAppliedExecutionProjection,
        snapshot: targetTemplate.snapshot,
      });
    owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    armOwnerLoss = true;

    await expect(
      lease.abandonFreshSettled({ expected: initialized }),
    ).rejects.toThrow(/owned by a different token/);
    expect(await store.read(targetId)).toEqual(initialized);
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, 'utf8');
    await lease.release();
  });

  it('preserves an empty target after a post-publication durability failure', async () => {
    const { sessionsDir } = await fixtureDir();
    const targetId = adoptionSessionId(69);
    const targetPath = join(sessionsDir, `${targetId}.json`);
    const targetTemplate = freshAdoptionTargetRecord({ id: targetId });
    let targetPublished = false;
    let syncFailed = false;
    const store = sequencedStore(sessionsDir, 100, {
      fsOps: {
        async link(from: string, to: string) {
          await link(from, to);
          if (to === targetPath) targetPublished = true;
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
              if (targetPublished && !syncFailed) {
                syncFailed = true;
                throw new Error('synthetic empty-target sync failure');
              }
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      },
    });
    const lease = await store.acquire(targetId);

    await expect(
      lease.initializeSettledWithPredecessor({
        cwd: targetTemplate.cwd,
        structuralProjection: targetTemplate.structuralProjection,
        executionProjection: targetTemplate.lastAppliedExecutionProjection,
        snapshot: targetTemplate.snapshot,
      }),
    ).rejects.toThrow(/cannot publish empty Captain session adoption target/);
    expect(await store.read(targetId)).toMatchObject({
      state: 'settled',
      retainedGenerations: {},
    });
    expect(
      (await readdir(sessionsDir)).some((name) => name.endsWith('.tmp')),
    ).toBe(false);
    await lease.release();
  });

  it.each(['malformed', 'unknown schema', 'unsafe'] as const)(
    'reports a %s canonical record and declines older adoption during fresh discovery',
    async (shape) => {
      const { sessionsDir } = await fixtureDir();
      const targetId = adoptionSessionId(7);
      const corruptId = adoptionSessionId(8);
      const olderId = adoptionSessionId(9);
      const target = freshAdoptionTargetRecord({ id: targetId });
      const corruptPath = join(sessionsDir, `${corruptId}.json`);
      const olderPath = await writeRecordFixture(
        sessionsDir,
        retainedSettledRecord({
          id: olderId,
          updatedAt: '2026-08-11T21:00:00.020Z',
        }),
      );
      const olderBytes = await readFile(olderPath, 'utf8');
      await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
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
      const corruptBytes = await readFile(corruptPath, 'utf8');
      const store = sequencedStore(sessionsDir, 7);
      const lease = await store.acquire(targetId);
      const invalidRecords: any[] = [];
      const initialized = await lease.initializeSettledWithPredecessor({
        cwd: target.cwd,
        structuralProjection: target.structuralProjection,
        executionProjection: target.lastAppliedExecutionProjection,
        snapshot: target.snapshot,
        onInvalidRecord: (record: any) => invalidRecords.push(record),
      });
      expect(initialized).toMatchObject({
        sessionId: targetId,
        retainedGenerations: {},
      });
      expect(invalidRecords).toEqual([
        {
          sessionId: corruptId,
          path: corruptPath,
          reason: expect.stringMatching(
            shape === 'malformed'
              ? /not valid JSON/
              : shape === 'unknown schema'
                ? /schema 99/
                : /0600/,
          ),
        },
      ]);
      expect(await store.read(targetId)).toEqual(initialized);
      expect(Date.parse(initialized.updatedAt)).toBeGreaterThan(
        Date.parse('2026-08-11T21:00:00.020Z'),
      );
      expect(await readFile(corruptPath, 'utf8')).toBe(corruptBytes);
      expect(await readFile(olderPath, 'utf8')).toBe(olderBytes);
      expect((await store.read(olderId)).retainedGenerations).not.toEqual({});
      await lease.release();
      await unlink(corruptPath);
      expect((await store.latest()).sessionId).toBe(targetId);
    },
  );

  it('orders validated legacy records without globally fencing adoption', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(13);
    const olderLegacyId = adoptionSessionId(14);
    const foreignLegacyId = adoptionSessionId(15);
    const targetId = adoptionSessionId(16);
    const source = retainedSettledRecord({
      id: sourceId,
      updatedAt: '2026-08-11T21:00:00.060Z',
    });
    const olderLegacy = legacyRecord(
      retainedSettledRecord({
        id: olderLegacyId,
        updatedAt: '2026-08-11T21:00:00.040Z',
      }),
      3,
    );
    const foreignLegacy = releasedSchema2Record({
      sessionId: foreignLegacyId,
      cwd: join(process.cwd(), 'other-working-directory'),
      updatedAt: '2026-08-11T21:00:00.080Z',
    });
    const sourcePath = await writeRecordFixture(sessionsDir, source);
    const olderLegacyPath = join(sessionsDir, `${olderLegacyId}.json`);
    const foreignLegacyPath = join(sessionsDir, `${foreignLegacyId}.json`);
    const olderLegacyBytes = `${JSON.stringify(olderLegacy)}\n`;
    const foreignLegacyBytes = `${JSON.stringify(foreignLegacy)}\n`;
    await writeFile(olderLegacyPath, olderLegacyBytes, { mode: 0o600 });
    await writeFile(foreignLegacyPath, foreignLegacyBytes, { mode: 0o600 });
    const target = freshAdoptionTargetRecord({ id: targetId });
    const store = sequencedStore(sessionsDir, 15);
    const lease = await store.acquire(targetId);
    const legacyRecords: unknown[] = [];

    const targetAfter = await lease.initializeSettledWithPredecessor({
      cwd: target.cwd,
      structuralProjection: target.structuralProjection,
      executionProjection: target.lastAppliedExecutionProjection,
      snapshot: target.snapshot,
      onLegacyRecord: (record: unknown) => legacyRecords.push(record),
    });

    expect(targetAfter.retainedGenerations).toEqual(
      source.retainedGenerations,
    );
    expect((await store.read(sourceId)).retainedGenerations).toEqual({});
    expect(await readFile(sourcePath, 'utf8')).not.toEqual(
      `${JSON.stringify(source)}\n`,
    );
    expect(await readFile(olderLegacyPath, 'utf8')).toBe(olderLegacyBytes);
    expect(await readFile(foreignLegacyPath, 'utf8')).toBe(
      foreignLegacyBytes,
    );
    expect(legacyRecords).toHaveLength(2);
    expect(legacyRecords).toEqual(
      expect.arrayContaining([
        {
          sessionId: olderLegacyId,
          path: olderLegacyPath,
          schemaVersion: 3,
        },
        {
          sessionId: foreignLegacyId,
          path: foreignLegacyPath,
          schemaVersion: 2,
        },
      ]),
    );
    await lease.release();
  });

  it('does not adopt retained generations from a pre-effect schema-4 record', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(10);
    const targetId = adoptionSessionId(11);
    const olderId = adoptionSessionId(12);
    const sourceExecution = retentionExecutionProjection();
    const targetExecution = retentionExecutionProjection({
      playerId: 'replacement.coder',
    });
    const retainedGenerations = {
      code: retainedCodeGeneration(),
      review: retainedReviewGeneration(),
    };
    const source = legacyRecord(
      retainedSettledRecord({
        id: sourceId,
        execution: sourceExecution,
        retainedGenerations,
        updatedAt: '2026-08-11T21:00:00.040Z',
      }),
      4,
    );
    const target = freshAdoptionTargetRecord({
      id: targetId,
      execution: targetExecution,
    });
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    await chmod(sessionsDir, 0o700);
    const sourcePath = join(sessionsDir, `${sourceId}.json`);
    await writeFile(sourcePath, `${JSON.stringify(source)}\n`, { mode: 0o600 });
    await chmod(sourcePath, 0o600);
    const sourceBytes = await readFile(sourcePath, 'utf8');
    const olderPath = await writeRecordFixture(
      sessionsDir,
      retainedSettledRecord({
        id: olderId,
        updatedAt: '2026-08-11T21:00:00.005Z',
      }),
    );
    const olderBytes = await readFile(olderPath, 'utf8');

    const store = sequencedStore(sessionsDir, 10);
    const lease = await store.acquire(targetId);
    const legacyRecords: unknown[] = [];
    const targetAfter = await lease.initializeSettledWithPredecessor({
      cwd: target.cwd,
      structuralProjection: target.structuralProjection,
      executionProjection: target.lastAppliedExecutionProjection,
      snapshot: target.snapshot,
      onLegacyRecord: (record: unknown) => legacyRecords.push(record),
    });
    expect(Object.isFrozen(targetAfter)).toBe(true);
    expect(targetAfter.retainedGenerations).toEqual({});
    expect(Date.parse(targetAfter.updatedAt)).toBeGreaterThan(
      Date.parse(source.updatedAt),
    );
    expect(legacyRecords).toEqual([
      {
        sessionId: sourceId,
        path: sourcePath,
        schemaVersion: 4,
      },
    ]);
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
    expect(await readFile(olderPath, 'utf8')).toBe(olderBytes);
    expect((await store.read(olderId)).retainedGenerations).not.toEqual({});
    await expect(store.read(sourceId)).rejects.toThrow(
      /schema 4 predates the artifact-schema-3 effect-authority cutover/,
    );
    await lease.release();
    expect((await sequencedStore(sessionsDir, 20).latest()).sessionId).toBe(
      targetId,
    );
  });

  it('moves retained ledger checkpoints without moving settlement evidence', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(70);
    const targetId = adoptionSessionId(71);
    const execution = retentionSchema3ExecutionProjection();
    const authoritativeLedger = startedEffectLedger();
    const unresolvedEffects = [
      {
        classification: 'incomplete',
        baselineHead: 'a'.repeat(40),
      },
    ];
    const generation = retainedCodeGeneration();
    const generationBytes = JSON.stringify(generation);
    const sourceSnapshot = {
      ...shellSnapshot(execution, 1, 'source-with-ledger'),
      effectLedger: authoritativeLedger,
      lastAction: 'runtime',
    };
    const settledAbandonment = {
      phase: 'final',
      attemptId: attempt3,
      rootPlaybookId: 'review',
      unresolvedEffects,
    };
    const source = settledRecord({
      sessionId: sourceId,
      createdAt: '2026-08-11T21:00:00.000Z',
      updatedAt: '2026-08-11T21:00:00.040Z',
      structuralProjection: projectCaptainSessionStructure(execution),
      lastAppliedExecutionProjection: execution,
      snapshot: sourceSnapshot,
      effectLedger: authoritativeLedger,
      unresolvedEffects,
      retainedGenerations: { code: generation },
      settledAbandonment,
    });
    const target = freshAdoptionTargetRecord({
      id: targetId,
      execution,
    });
    await writeRecordFixture(sessionsDir, source);

    const store = sequencedStore(sessionsDir, 70);
    const lease = await store.acquire(targetId);
    const targetAfter = await lease.initializeSettledWithPredecessor({
      cwd: target.cwd,
      structuralProjection: target.structuralProjection,
      executionProjection: target.lastAppliedExecutionProjection,
      snapshot: target.snapshot,
    });
    const sourceAfter = await store.read(sourceId);

    expect(sourceAfter).toMatchObject({
      sessionId: sourceId,
      effectLedger: authoritativeLedger,
      snapshot: { effectLedger: authoritativeLedger },
      unresolvedEffects,
      retainedGenerations: {},
      settledAbandonment,
    });
    expect(targetAfter).toMatchObject({
      sessionId: targetId,
      effectLedger: authoritativeLedger,
      snapshot: { effectLedger: authoritativeLedger },
      unresolvedEffects: [],
      retainedGenerations: { code: generation },
    });
    expect(targetAfter).not.toHaveProperty('settledAbandonment');
    expect(JSON.stringify(targetAfter.retainedGenerations.code)).toBe(
      generationBytes,
    );
    expect(targetAfter.retainedGenerations.code.effectLedger).toEqual(
      effectLedger(),
    );
    expect(
      targetAfter.retainedGenerations.code.frames[0].runtime.effectLedger,
    ).toEqual(effectLedger());
    expect(validateCaptainSessionRecord(targetAfter)).toEqual(targetAfter);
    await lease.release();
  });

  it('preserves a marked generation capture mirror while record authority advances', async () => {
    const { sessionsDir } = await fixtureDir();
    const execution = retentionSchema3ExecutionProjection();
    const captureLedger = startedEffectLedger();
    const generation = fencedRetainedCodeGeneration(captureLedger);
    const generationBytes = JSON.stringify(generation);
    const record = retainedSettledRecord({
      id: sessionId,
      execution,
      retainedGenerations: { code: generation },
      ledger: captureLedger,
    });
    await writeRecordFixture(sessionsDir, record);

    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    await lease.beginTurn({
      input: 'advance authority without selecting the retained generation',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    const boundary = captureLedger.boundaries[0]!;
    const completedBoundary = {
      ...boundary,
      after: boundary.baseline,
      physicalReceipt: {
        classification: 'unchanged',
        baseline: boundary.baseline,
        after: boundary.baseline,
      },
    };
    const advanced = await lease.writeEffectLedger(effectAuthority(execution), [
      {
        kind: 'replace-boundaries',
        replacements: [{ expected: boundary, next: completedBoundary }],
      },
    ]);

    expect(advanced).toEqual(completedUnchangedEffectLedger());
    const persisted = await lease.read();
    expect(persisted.effectLedger).toEqual(advanced);
    expect(JSON.stringify(persisted.retainedGenerations.code)).toBe(
      generationBytes,
    );
    expect(
      persisted.retainedGenerations.code.frames[0].runtime.effectLedger,
    ).toEqual(captureLedger);
    await lease.release();
  });

  it('transfers descendant option drift without changing the generation', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(13);
    const targetId = adoptionSessionId(14);
    const sourceExecution = retentionExecutionProjection();
    const targetExecution: any = structuredClone(sourceExecution);
    targetExecution.catalog.review.options = { targetVariant: 'current' };
    const generation = retainedCodeGeneration();
    const source = retainedSettledRecord({
      id: sourceId,
      execution: sourceExecution,
      retainedGenerations: { code: generation },
    });
    const target = freshAdoptionTargetRecord({
      id: targetId,
      execution: targetExecution,
    });
    await writeRecordFixture(sessionsDir, source);

    const store = sequencedStore(sessionsDir, 25);
    const lease = await store.acquire(targetId);
    const result = await lease.initializeSettledWithPredecessor({
      cwd: target.cwd,
      structuralProjection: target.structuralProjection,
      executionProjection: target.lastAppliedExecutionProjection,
      snapshot: target.snapshot,
    });

    expect(result.retainedGenerations).toEqual({ code: generation });
    expect((await store.read(sourceId)).retainedGenerations).toEqual({});
    expect((await store.read(targetId))).toMatchObject({
      structuralProjection: {
        catalog: {
          review: { options: { targetVariant: 'current' } },
        },
      },
      retainedGenerations: {
        code: { frames: [{}, { options: {} }] },
      },
    });
    await lease.release();
  });

  it.each([
    'registry module',
    'manifest command',
    'raw options',
    'required roles',
    'concurrent roles',
    'descendant catalog',
  ] as const)(
    'declines an incompatible adoption %s envelope into an empty target',
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
      const sourceBytes = await readFile(sourcePath, 'utf8');

      const store = sequencedStore(sessionsDir, 30);
      const lease = await store.acquire(targetId);
      const initialized = await lease.initializeSettledWithPredecessor({
        cwd: target.cwd,
        structuralProjection: target.structuralProjection,
        executionProjection: target.lastAppliedExecutionProjection,
        snapshot: target.snapshot,
      });
      expect(initialized.retainedGenerations).toEqual({});
      expect(Date.parse(initialized.updatedAt)).toBeGreaterThan(
        Date.parse(source.updatedAt),
      );
      expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
      expect(await store.read(targetId)).toEqual(initialized);
      await lease.release();
    },
  );

  it('lets two concurrent guarded contenders leave one generation owner', async () => {
    const { sessionsDir } = await fixtureDir();
    const sourceId = adoptionSessionId(35);
    const firstTargetId = adoptionSessionId(36);
    const secondTargetId = adoptionSessionId(37);
    const source = retainedSettledRecord({
      id: sourceId,
      updatedAt: '2026-08-11T21:00:00.040Z',
    });
    await writeRecordFixture(sessionsDir, source);

    const sourceLeasePath = join(sessionsDir, `.${sourceId}.lock`);
    let sourceLeasePublished: () => void = () => {};
    const sourceLeasePublication = new Promise<void>((resolvePromise) => {
      sourceLeasePublished = resolvePromise;
    });
    let continueFirst: () => void = () => {};
    const firstMayContinue = new Promise<void>((resolvePromise) => {
      continueFirst = resolvePromise;
    });
    let sourceLeasePaused = false;
    const store = sequencedStore(sessionsDir, 45, {
      probeProcess: async () => {},
      fsOps: {
        async rename(from: string, to: string) {
          await rename(from, to);
          if (to !== sourceLeasePath || sourceLeasePaused) return;
          sourceLeasePaused = true;
          sourceLeasePublished();
          await firstMayContinue;
        },
      },
    });
    const firstLease = await store.acquire(firstTargetId);
    const secondLease = await store.acquire(secondTargetId);
    const target = freshAdoptionTargetRecord({ id: firstTargetId });
    const firstInitialization =
      firstLease.initializeSettledWithPredecessor({
        cwd: target.cwd,
        structuralProjection: target.structuralProjection,
        executionProjection: target.lastAppliedExecutionProjection,
        snapshot: target.snapshot,
      });
    await sourceLeasePublication;
    try {
      const second = await secondLease.initializeSettledWithPredecessor({
        cwd: target.cwd,
        structuralProjection: target.structuralProjection,
        executionProjection: target.lastAppliedExecutionProjection,
        snapshot: target.snapshot,
      });
      expect(second.retainedGenerations).toEqual({});
    } finally {
      continueFirst();
    }
    const first = await firstInitialization;
    expect(first.retainedGenerations).toEqual({});
    const owners = await Promise.all(
      [sourceId, firstTargetId, secondTargetId].map(async (id) => ({
        id,
        retained: Object.keys(
          (await store.read(id)).retainedGenerations ?? {},
        ).length,
      })),
    );
    expect(owners.filter(({ retained }) => retained > 0)).toEqual([
      { id: sourceId, retained: 2 },
    ]);
    await firstLease.release();
    await secondLease.release();
  });

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
      const targetPath = join(sessionsDir, `${targetId}.json`);
      const sourceBytes = await readFile(sourcePath, 'utf8');
      let sourcePublished = false;
      let targetPublished = false;
      let syncFailed = false;
      const store = sequencedStore(sessionsDir, 60, {
        fsOps: {
          async rename(from: string, to: string) {
            if (
              from.endsWith('.tmp') &&
              boundary === 'source pre-publication' &&
              to === sourcePath
            ) {
              throw new Error(`synthetic ${boundary} failure`);
            }
            await rename(from, to);
            if (from.endsWith('.tmp') && to === sourcePath) {
              sourcePublished = true;
            }
          },
          async link(from: string, to: string) {
            if (
              boundary === 'target pre-publication' &&
              to === targetPath
            ) {
              throw new Error(`synthetic ${boundary} failure`);
            }
            await link(from, to);
            if (to === targetPath) targetPublished = true;
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
      await expect(
        lease.initializeSettledWithPredecessor({
          cwd: target.cwd,
          structuralProjection: target.structuralProjection,
          executionProjection: target.lastAppliedExecutionProjection,
          snapshot: target.snapshot,
        }),
      ).rejects.toThrow(/cannot (?:clear|install) Captain session adoption/);

      const sourceAfterBytes = await readFile(sourcePath, 'utf8');
      const sourceAfter = validateCaptainSessionRecord(
        JSON.parse(sourceAfterBytes),
      );
      let targetAfter;
      let targetAfterBytes;
      try {
        targetAfterBytes = await readFile(targetPath, 'utf8');
        targetAfter = validateCaptainSessionRecord(
          JSON.parse(targetAfterBytes),
        );
      } catch (error: any) {
        expect(error).toMatchObject({ code: 'ENOENT' });
      }
      const owners = [sourceAfter, targetAfter].filter(
        (record) => record !== undefined,
      ).filter(
        (record) => Object.keys(record.retainedGenerations ?? {}).length > 0,
      );
      expect(owners.length).toBeLessThanOrEqual(1);
      if (
        boundary === 'source pre-publication' ||
        boundary === 'target pre-publication'
      ) {
        expect(sourceAfterBytes).toBe(sourceBytes);
        expect(targetAfter).toBeUndefined();
      } else if (boundary === 'source post-publication') {
        expect(sourceAfter.retainedGenerations).toEqual({});
        expect(targetAfter).toBeUndefined();
      } else {
        expect(sourceAfter.retainedGenerations).toEqual({});
        expect(targetAfter?.retainedGenerations).toEqual(
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
      ['missing generation ledger checkpoint', (value) => {
        delete value.retainedGenerations.code.effectLedger;
      }],
      ['generation ledger ahead of record authority', (value) => {
        value.retainedGenerations.code.effectLedger.revision = 1;
      }],
      ['frame with a divergent generation ledger mirror', (value) => {
        value.retainedGenerations.code.frames[0].runtime.effectLedger.revision =
          1;
      }],
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

    const schema3Execution = retentionSchema3ExecutionProjection();
    const authoritativeLedger = startedEffectLedger();
    const schema3Base = settledRecord({
      structuralProjection: projectCaptainSessionStructure(schema3Execution),
      lastAppliedExecutionProjection: schema3Execution,
      snapshot: {
        ...shellSnapshot(schema3Execution, 1),
        effectLedger: authoritativeLedger,
      },
      effectLedger: authoritativeLedger,
      retainedGenerations: { code: retainedCodeGeneration() },
    });
    expect(validateCaptainSessionRecord(schema3Base)).toMatchObject({
      retainedGenerations: {
        code: { effectLedger: effectLedger() },
      },
    });
    const divergentSchema3Mirror = structuredClone(schema3Base);
    divergentSchema3Mirror.retainedGenerations.code.frames[0].runtime.effectLedger =
      authoritativeLedger;
    expect(() =>
      validateCaptainSessionRecord(divergentSchema3Mirror),
    ).toThrow(/retained-generation checkpoint/);
    const incompleteCheckpoint = structuredClone(schema3Base);
    incompleteCheckpoint.retainedGenerations.code.effectLedger =
      authoritativeLedger;
    incompleteCheckpoint.retainedGenerations.code.frames[0].runtime.effectLedger =
      authoritativeLedger;
    expect(() =>
      validateCaptainSessionRecord(incompleteCheckpoint),
    ).toThrow(/contains an incomplete physical boundary/);

    const fencedBase = settledRecord({
      structuralProjection: projectCaptainSessionStructure(schema3Execution),
      lastAppliedExecutionProjection: schema3Execution,
      snapshot: {
        ...shellSnapshot(schema3Execution, 1),
        effectLedger: authoritativeLedger,
      },
      effectLedger: authoritativeLedger,
      retainedGenerations: {
        code: fencedRetainedCodeGeneration(authoritativeLedger),
      },
    });
    const validatedFenced = validateCaptainSessionRecord(fencedBase);
    expect(validatedFenced.retainedGenerations.code).toMatchObject({
      effectLedger: effectLedger(),
      retainedEffectReconciliation: {
        sourceGenerationId: frameRuntimeId,
      },
    });
    expect(
      validatedFenced.retainedGenerations.code.frames[0].runtime,
    ).toMatchObject({
      effectLedger: authoritativeLedger,
      retainedEffectSourceSessionId: frameRuntimeId,
      retainedEffectReconciliation: {
        sourceSessionId: frameRuntimeId,
        checkpoint: effectLedger(),
      },
    });
    const laterAuthoritativeLedger = completedUnchangedEffectLedger();
    const advancedFencedBase = structuredClone(fencedBase);
    advancedFencedBase.effectLedger = laterAuthoritativeLedger;
    advancedFencedBase.snapshot.effectLedger = laterAuthoritativeLedger;
    const advancedFencedBytes = JSON.stringify(advancedFencedBase);
    const validatedAdvancedFence = validateCaptainSessionRecord(
      advancedFencedBase,
    );
    expect(JSON.stringify(advancedFencedBase)).toBe(advancedFencedBytes);
    expect(validatedAdvancedFence.effectLedger).toEqual(
      laterAuthoritativeLedger,
    );
    expect(
      validatedAdvancedFence.retainedGenerations.code.frames[0].runtime
        .effectLedger,
    ).toEqual(authoritativeLedger);

    const allSchema3Execution: any = structuredClone(schema3Execution);
    allSchema3Execution.catalog.review.artifactSchema = 3;
    const commonMirrorGeneration: any =
      fencedRetainedCodeGeneration(authoritativeLedger);
    commonMirrorGeneration.frames[1].runtime.effectLedger =
      authoritativeLedger;
    commonMirrorGeneration.frames[1].runtime.retainedEffectSourceSessionId =
      childFrameRuntimeId;
    commonMirrorGeneration.frames[1].runtime.retainedEffectReconciliation = {
      sourceSessionId: childFrameRuntimeId,
      checkpoint: effectLedger(),
    };
    const commonMirrorBase = settledRecord({
      structuralProjection: projectCaptainSessionStructure(
        allSchema3Execution,
      ),
      lastAppliedExecutionProjection: allSchema3Execution,
      snapshot: {
        ...shellSnapshot(allSchema3Execution, 1),
        effectLedger: laterAuthoritativeLedger,
      },
      effectLedger: laterAuthoritativeLedger,
      retainedGenerations: { code: commonMirrorGeneration },
    });
    expect(validateCaptainSessionRecord(commonMirrorBase)).toMatchObject({
      retainedGenerations: {
        code: {
          frames: [
            { runtime: { effectLedger: authoritativeLedger } },
            { runtime: { effectLedger: authoritativeLedger } },
          ],
        },
      },
    });
    const divergentMarkedMirrors = structuredClone(commonMirrorBase);
    divergentMarkedMirrors.retainedGenerations.code.frames[1].runtime.effectLedger =
      laterAuthoritativeLedger;
    expect(() =>
      validateCaptainSessionRecord(divergentMarkedMirrors),
    ).toThrow(/marked generation capture mirror/);

    const unmarkedGeneration: any = retainedReviewGeneration();
    unmarkedGeneration.retainedEffectReconciliation = {
      sourceGenerationId: reviewRootRuntimeId,
    };
    const unmarkedFence = settledRecord({
      structuralProjection: projectCaptainSessionStructure(schema3Execution),
      lastAppliedExecutionProjection: schema3Execution,
      snapshot: {
        ...shellSnapshot(schema3Execution, 1),
        effectLedger: authoritativeLedger,
      },
      effectLedger: authoritativeLedger,
      retainedGenerations: { review: unmarkedGeneration },
    });
    expect(() => validateCaptainSessionRecord(unmarkedFence)).toThrow(
      /inconsistent with its schema-3 frame markers/,
    );

    const fencedMutations: Array<[string, (value: any) => void]> = [
      ['mismatched source generation', (value) => {
        value.retainedGenerations.code.retainedEffectReconciliation
          .sourceGenerationId = childFrameRuntimeId;
      }],
      ['mismatched runtime checkpoint', (value) => {
        value.retainedGenerations.code.frames[0].runtime
          .retainedEffectReconciliation.checkpoint = authoritativeLedger;
      }],
      ['missing schema-3 frame marker', (value) => {
        delete value.retainedGenerations.code.frames[0].runtime
          .retainedEffectReconciliation;
      }],
      ['stale marked schema-3 mirror', (value) => {
        value.retainedGenerations.code.frames[0].runtime.effectLedger =
          effectLedger();
      }],
      ['extra frame marker', (value) => {
        value.retainedGenerations.code.frames[1].runtime
          .retainedEffectReconciliation.sourceSessionId = frameRuntimeId;
      }],
    ];
    for (const [label, mutate] of fencedMutations) {
      const candidate = structuredClone(fencedBase);
      mutate(candidate);
      expect(
        () => validateCaptainSessionRecord(candidate),
        label,
      ).toThrow();
    }

    const { sessionsDir } = await fixtureDir();
    const store = fixedStore(sessionsDir, tokenO);
    const lease = await store.acquire(sessionId);
    await lease.initializeSettledWithPredecessor(freshBoundary(execution));
    await lease.beginTurn({
      input: 'invalid retention update',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    await expect(
      lease.settle({
        attemptId: attempt1,
        snapshot: shellSnapshot(execution, 1),
        unresolvedEffects: [],
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
          unresolvedEffects: [],
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
    await writeRecordFixture(sessionsDir, freshUncertainRecord());
    const uncertain = await lease.read();
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
    await lease.initializeSettledWithPredecessor(freshBoundary());
    await lease.beginTurn({
      input: 'work',
      attemptId: attempt1,
      attemptedExecutionProjection: executionProjection(),
    });
    await expect(
      lease.settle({
        attemptId: attempt2,
        snapshot: { marker: 'wrong' },
        unresolvedEffects: [],
      }),
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
      lease.settle({
        attemptId: attempt1,
        snapshot: { marker: 'blocked' },
        unresolvedEffects: [],
      }),
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
        lease.initializeSettledWithPredecessor({
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
    await firstLease.initializeSettledWithPredecessor(freshBoundary(execution));
    await firstLease.beginTurn({
      input: 'first',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    await firstLease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(execution, 1, 'settled'),
      unresolvedEffects: [],
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
        unresolvedEffects: [],
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
    await lease.initializeSettledWithPredecessor(freshBoundary());
    failSessionSync = true;
    await expect(
      lease.beginTurn({
        input: 'published before sync',
        attemptId: attempt1,
        attemptedExecutionProjection: executionProjection(),
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
    await lease.initializeSettledWithPredecessor(freshBoundary(execution));
    await lease.beginTurn({
      input: 'first turn',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    await lease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(execution, 1, 'first settled'),
      unresolvedEffects: [],
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
        unresolvedEffects: [],
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

  it('skips nonresumable records and fails closed on corruption', async () => {
    const { sessionsDir } = await fixtureDir();
    for (const [id, token, attempt] of [
      [sessionId, tokenO, attempt1],
      [secondSessionId, tokenN, attempt2],
    ] as const) {
      const lease = await fixedStore(sessionsDir, token).acquire(id);
      await lease.initializeSettledWithPredecessor(freshBoundary());
      await lease.beginTurn({
        input: `turn for ${id}`,
        attemptId: attempt,
        attemptedExecutionProjection: executionProjection(),
      });
      await lease.settle({
        attemptId: attempt,
        snapshot: shellSnapshot(executionProjection(), 1, id),
        unresolvedEffects: [],
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
    const releasedRecord = releasedSchema2Record({
      sessionId: secondSessionId,
      createdAt: wrongEmbeddedId.createdAt,
      updatedAt: wrongEmbeddedId.updatedAt,
      cwd: wrongEmbeddedId.cwd,
    });
    await writeFile(secondPath, `${JSON.stringify(releasedRecord)}\n`, 'utf8');
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
    ).toBe(sessionId);
    expect(legacyRecords).toEqual([
      {
        sessionId: secondSessionId,
        path: secondPath,
        schemaVersion: 3,
      },
    ]);
    await expect(store.read(secondSessionId)).rejects.toThrow(
      /schema 3 predates the artifact-schema-3 effect-authority cutover/,
    );

    const schema3Execution = schema3ExecutionProjection();
    const preEffectSchema3Artifact = settledRecord({
      sessionId: secondSessionId,
      createdAt: wrongEmbeddedId.createdAt,
      updatedAt: wrongEmbeddedId.updatedAt,
      cwd: wrongEmbeddedId.cwd,
      structuralProjection: projectCaptainSessionStructure(schema3Execution),
      lastAppliedExecutionProjection: schema3Execution,
      snapshot: shellSnapshot(schema3Execution, 1, secondSessionId),
    });
    for (const schemaVersion of [3, 4] as const) {
      const unmigratable = legacyRecord(
        preEffectSchema3Artifact,
        schemaVersion,
      );
      await writeFile(
        secondPath,
        `${JSON.stringify(unmigratable)}\n`,
        'utf8',
      );
      legacyRecords.length = 0;
      expect(
        (
          await store.latest({
            onLegacyRecord: (record: unknown) =>
              legacyRecords.push(record),
          })
        ).sessionId,
      ).toBe(sessionId);
      expect(legacyRecords).toEqual([
        {
          sessionId: secondSessionId,
          path: secondPath,
          schemaVersion,
        },
      ]);
      await expect(store.read(secondSessionId)).rejects.toThrow(
        new RegExp(
          `schema ${schemaVersion} predates the artifact-schema-3 effect-authority cutover`,
        ),
      );
    }

    const preUnresolvedEffects = preUnresolvedEffectsRecord(wrongEmbeddedId);
    await writeFile(
      secondPath,
      `${JSON.stringify(preUnresolvedEffects)}\n`,
      'utf8',
    );
    legacyRecords.length = 0;
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
        schemaVersion: 5,
      },
    ]);
    await expect(store.read(secondSessionId)).rejects.toThrow(
      /schema 5 predates the canonical schema-6 unresolved-effect settlement boundary/,
    );

    await writeFile(
      secondPath,
      `${JSON.stringify({ ...wrongEmbeddedId, schemaVersion: 5 })}\n`,
      'utf8',
    );
    legacyRecords.length = 0;
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
        schemaVersion: 5,
      },
    ]);
    await expect(store.read(secondSessionId)).rejects.toThrow(
      /schema 5 predates the canonical schema-6 unresolved-effect settlement boundary/,
    );

    const malformedUnmigratable = legacyRecord(
      preEffectSchema3Artifact,
    );
    malformedUnmigratable.snapshot.captain.runtime.schemaVersion = 2;
    await writeFile(
      secondPath,
      `${JSON.stringify(malformedUnmigratable)}\n`,
      'utf8',
    );
    legacyRecords.length = 0;
    await expect(
      store.latest({
        onLegacyRecord: (record: unknown) => legacyRecords.push(record),
      }),
    ).rejects.toThrow(/runtime schema 2 cannot migrate to schema 4/);
    expect(legacyRecords).toEqual([]);

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
    await lease.initializeSettledWithPredecessor(freshBoundary());
    await lease.beginTurn({
      input: 'private record',
      attemptId: attempt1,
      attemptedExecutionProjection: executionProjection(),
    });
    await lease.settle({
      attemptId: attempt1,
      snapshot: shellSnapshot(executionProjection(), 1, 'settled'),
      unresolvedEffects: [],
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

describe('shared replay stream codec and reader (PBCLI-74/75/79/80/82)', () => {
  it('reads the cross-host fixture semantically across key and checkout modes', async () => {
    const fixtureText = await readFile(replayFixtureUrl, 'utf8');
    const fixtureStat = await stat(replayFixtureUrl);
    const lines = fixtureText.split('\n');
    expect(fixtureStat.isFile()).toBe(true);
    expect(lines.at(-1)).toBe('');
    expect(lines.slice(0, -1).every((line) => line.length > 0)).toBe(true);
    const expected = lines.slice(0, -1).map((line) => JSON.parse(line));
    expect(expected.map(({ v, seq }) => ({ v, seq }))).toEqual(
      [1, 2, 3, 4, 5].map((seq) => ({ v: 1, seq })),
    );
    expect(Object.keys(expected[2])).toEqual(['v', 'seq', 'record', 'role']);
    expect(expected[3].record.type).toBe('peer_future_record');

    const { sessionsDir } = await fixtureDir();
    await writeReplayStream(
      sessionsDir,
      fixtureText,
      replayFixtureSessionId,
    );
    const result = await fixedStore(
      sessionsDir,
      tokenO,
    ).readStream(replayFixtureSessionId);
    expect(result).toEqual({ entries: expected, lastReadableSeq: 5 });

    const rewritten = `${result.entries
      .map(({ v, seq, role, record }: any) =>
        JSON.stringify({
          v,
          seq,
          ...(role === undefined ? {} : { role }),
          record,
        }),
      )
      .join('\n')}\n`;
    expect(rewritten).not.toBe(fixtureText);
    expect(rewritten.endsWith('\n')).toBe(true);
    expect(
      rewritten
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line)),
    ).toEqual(expected);

    const trace = expected[0].record.payload;
    const roleOmittingPrompt = expected[1];
    expect(roleOmittingPrompt).not.toHaveProperty('role');
    expect(roleOmittingPrompt.record.playerId).toBe(trace.payload.playerId);
    expect(trace).toMatchObject({
      type: 'player.call.started',
      payload: { playerId: 'dev.coder', roleId: 'coder', resume: false },
    });
    expect(await readFile(replayFixtureUrl, 'utf8')).toBe(fixtureText);
    expect((await stat(replayFixtureUrl)).mode).toBe(fixtureStat.mode);
  });

  it('separates append arguments from recursive credential sanitization', () => {
    const unsafeRemovedToken = () => 'must not be traversed';
    const source = {
      type: 'opaque_record',
      resumeToken: unsafeRemovedToken,
      resume: 'root-provider-token',
      nested: {
        resumeToken: 'nested-provider-token',
        resume: 'nested-provider-selection',
        optional: undefined,
        retained: {
          resume: false,
          value: 7,
        },
      },
      entries: [
        { resumeToken: 'array-token', keep: true },
        { resume: 'array-provider-selection', keep: 'yes' },
        { resume: false },
      ],
    };

    expect(sanitizeReplayRecord(source)).toEqual({
      type: 'opaque_record',
      nested: { retained: { resume: false, value: 7 } },
      entries: [{ keep: true }, { keep: 'yes' }, { resume: false }],
    });
    expect(source.resumeToken).toBe(unsafeRemovedToken);
    expect(source.nested.resumeToken).toBe('nested-provider-token');
    expect(source.entries[2]).toEqual({ resume: false });

    for (const value of [null, 1, 'record', () => undefined, []]) {
      expect(() => assertReplayAppendArguments(value, undefined)).toThrow();
    }
    expect(() => assertReplayAppendArguments({}, '')).toThrow();
    expect(() => assertReplayAppendArguments({}, 1)).toThrow();
    expect(() => assertReplayAppendArguments(source, 'coder')).not.toThrow();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      assertReplayAppendArguments(new Date(), undefined),
    ).not.toThrow();
    expect(() => assertReplayAppendArguments(cyclic, undefined)).not.toThrow();
    expect(() => sanitizeReplayRecord(new Date())).toThrow();
    expect(() => sanitizeReplayRecord(cyclic)).toThrow();
    expect(() => sanitizeReplayRecord({ entries: [undefined] })).toThrow();
  });

  it('reads absent, empty, and torn streams without adopting host files', async () => {
    const { sessionsDir } = await fixtureDir();
    await mkdir(sessionsDir, { mode: 0o700 });
    const sidecarPath = join(sessionsDir, `${sessionId}.spex.json`);
    const sidecar = '{"host":"spex","opaque":true}\n';
    await writeFile(sidecarPath, sidecar, { mode: 0o600 });
    const unrelatedPath = replayStreamPath(sessionsDir, secondSessionId);
    const unrelated = '{not-a-playbook-stream}\n';
    await writeFile(unrelatedPath, unrelated, { mode: 0o600 });
    const store = fixedStore(sessionsDir, tokenO);

    expect(await store.readStream(sessionId)).toEqual({
      entries: [],
      lastReadableSeq: 0,
    });
    const streamPath = await writeReplayStream(sessionsDir, '');
    expect(await store.readStream(sessionId, { afterSeq: 0 })).toEqual({
      entries: [],
      lastReadableSeq: 0,
    });

    const first = replayEnvelope(1, { type: 'complete' });
    const torn = '{"v":1,"seq":2,"record":{"type":"partial"';
    const bytes = `${replayLine(first)}${torn}`;
    await writeFile(streamPath, bytes, 'utf8');
    expect(await store.readStream(sessionId)).toEqual({
      entries: [first],
      lastReadableSeq: 1,
    });
    expect(
      await store.readStream(sessionId, { afterSeq: undefined }),
    ).toEqual({
      entries: [first],
      lastReadableSeq: 1,
    });
    expect(await store.readStream(sessionId, { afterSeq: 1 })).toEqual({
      entries: [],
      lastReadableSeq: 1,
    });
    expect(await readFile(streamPath, 'utf8')).toBe(bytes);
    expect(await readFile(sidecarPath, 'utf8')).toBe(sidecar);
    expect(await readFile(unrelatedPath, 'utf8')).toBe(unrelated);

    await expect(
      store.readStream(sessionId, { afterSeq: 2 }),
    ).rejects.toThrow();
    await expect(
      store.readStream(sessionId, { afterSeq: -1 }),
    ).rejects.toThrow();
    await expect(
      store.readStream(sessionId, { afterSeq: null } as any),
    ).rejects.toThrow();
    await expect(
      store.readStream(sessionId, { afterSeq: 0, extra: true } as any),
    ).rejects.toThrow();
  });

  it('rejects closed-envelope, payload, and sequence faults atomically', async () => {
    const validFirst = replayLine(replayEnvelope(1));
    const cases = [
      {
        name: 'missing version',
        text: replayLine({ seq: 1, record: { type: 'missing-v' } }),
      },
      {
        name: 'unknown version',
        text: replayLine({ v: 2, seq: 1, record: { type: 'future-v' } }),
      },
      {
        name: 'missing sequence',
        text: replayLine({ v: 1, record: { type: 'missing-seq' } }),
      },
      {
        name: 'missing record',
        text: replayLine({ v: 1, seq: 1 }),
      },
      {
        name: 'unknown envelope member',
        text: replayLine({
          v: 1,
          seq: 1,
          record: { type: 'closed-envelope' },
          extra: true,
        }),
      },
      {
        name: 'null payload',
        text: replayLine({ v: 1, seq: 1, record: null }),
      },
      {
        name: 'array payload',
        text: replayLine({ v: 1, seq: 1, record: [] }),
      },
      {
        name: 'primitive payload',
        text: replayLine({ v: 1, seq: 1, record: 'record' }),
      },
      {
        name: 'non-string role',
        text: replayLine({ v: 1, seq: 1, role: false, record: {} }),
      },
      {
        name: 'nonpositive sequence',
        text: replayLine(replayEnvelope(0)),
      },
      {
        name: 'duplicate sequence',
        text: `${validFirst}${replayLine(replayEnvelope(1))}`,
      },
      {
        name: 'missing sequence in prefix',
        text: `${validFirst}${replayLine(replayEnvelope(3))}`,
      },
      {
        name: 'prefix does not start at one',
        text: replayLine(replayEnvelope(2)),
      },
      {
        name: 'malformed completed line',
        text: '{"v":1,"seq":1,"record":}\n',
      },
    ] as const;

    for (const row of cases) {
      const { sessionsDir } = await fixtureDir();
      const streamPath = await writeReplayStream(sessionsDir, row.text);
      const sidecarPath = join(sessionsDir, `${sessionId}.spex.json`);
      const sidecar = `host sidecar for ${row.name}\n`;
      await writeFile(sidecarPath, sidecar, { mode: 0o600 });
      await expect(
        fixedStore(sessionsDir, tokenO).readStream(sessionId),
        row.name,
      ).rejects.toThrow();
      expect(await readFile(streamPath, 'utf8'), row.name).toBe(row.text);
      expect(await readFile(sidecarPath, 'utf8'), row.name).toBe(sidecar);
    }
  });

  it('rejects unsafe directory and stream boundaries without mutation', async () => {
    const symlinkedDirectory = await fixtureDir();
    const realSessions = join(symlinkedDirectory.root, 'real-sessions');
    await mkdir(realSessions, { mode: 0o700 });
    await symlink(realSessions, symlinkedDirectory.sessionsDir);
    await expect(
      fixedStore(symlinkedDirectory.sessionsDir, tokenO).readStream(sessionId),
    ).rejects.toThrow();

    const publicDirectory = await fixtureDir();
    await mkdir(publicDirectory.sessionsDir, { mode: 0o700 });
    await chmod(publicDirectory.sessionsDir, 0o755);
    await expect(
      fixedStore(publicDirectory.sessionsDir, tokenO).readStream(sessionId),
    ).rejects.toThrow();
    await chmod(publicDirectory.sessionsDir, 0o700);

    const symlinkedStream = await fixtureDir();
    await mkdir(symlinkedStream.sessionsDir, { mode: 0o700 });
    const target = join(symlinkedStream.root, 'stream-target');
    const targetBytes = replayLine(replayEnvelope(1));
    await writeFile(target, targetBytes, { mode: 0o600 });
    const symlinkPath = replayStreamPath(symlinkedStream.sessionsDir);
    await symlink(target, symlinkPath);
    await expect(
      fixedStore(symlinkedStream.sessionsDir, tokenO).readStream(sessionId),
    ).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(targetBytes);

    const nonRegularStream = await fixtureDir();
    await mkdir(nonRegularStream.sessionsDir, { mode: 0o700 });
    const directoryStream = replayStreamPath(nonRegularStream.sessionsDir);
    await mkdir(directoryStream, { mode: 0o700 });
    await expect(
      fixedStore(nonRegularStream.sessionsDir, tokenO).readStream(sessionId),
    ).rejects.toThrow();

    const publicStream = await fixtureDir();
    const publicPath = await writeReplayStream(
      publicStream.sessionsDir,
      targetBytes,
    );
    await chmod(publicPath, 0o644);
    await expect(
      fixedStore(publicStream.sessionsDir, tokenO).readStream(sessionId),
    ).rejects.toThrow();
    expect(await readFile(publicPath, 'utf8')).toBe(targetBytes);
  });

  it('validates only monotonic suffixes across lease-path turnover', async () => {
    const { sessionsDir } = await fixtureDir();
    const first = replayLine(replayEnvelope(1, { type: 'first' }));
    const second = replayLine(replayEnvelope(2, { type: 'second' }));
    const third = replayLine(replayEnvelope(3, { type: 'third' }));
    const streamPath = await writeReplayStream(sessionsDir, first);
    const reads: ReplayReadEvent[] = [];
    let leasePathReads = 0;
    const canonicalLease = join(sessionsDir, `.${sessionId}.lock`);
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: observedReplayFs(streamPath, reads, {
        onPath(_operation, path) {
          if (path.startsWith(canonicalLease)) leasePathReads += 1;
        },
      }),
    });

    expect(await store.readStream(sessionId)).toEqual({
      entries: [replayEnvelope(1, { type: 'first' })],
      lastReadableSeq: 1,
    });
    expect(reads.some(({ position }) => position === 0)).toBe(true);

    reads.length = 0;
    await mkdir(canonicalLease, { mode: 0o700 });
    await writeFile(streamPath, `${first}${second}`, 'utf8');
    expect(await store.readStream(sessionId, { afterSeq: 1 })).toEqual({
      entries: [replayEnvelope(2, { type: 'second' })],
      lastReadableSeq: 2,
    });
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every(({ position }) => position >= Buffer.byteLength(first)),
    ).toBe(true);

    reads.length = 0;
    await rename(canonicalLease, `${canonicalLease}.retired.${tokenO}`);
    await mkdir(canonicalLease, { mode: 0o700 });
    await writeFile(streamPath, `${first}${second}${third}`, 'utf8');
    expect(await store.readStream(sessionId, { afterSeq: 2 })).toEqual({
      entries: [replayEnvelope(3, { type: 'third' })],
      lastReadableSeq: 3,
    });
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every(
        ({ position }) =>
          position >= Buffer.byteLength(`${first}${second}`),
      ),
    ).toBe(true);
    expect(leasePathReads).toBe(0);
  });

  it('does not advance its cursor when a completed suffix is invalid', async () => {
    const { sessionsDir } = await fixtureDir();
    const first = replayLine(replayEnvelope(1, { type: 'first' }));
    const invalid = replayLine(replayEnvelope(3, { type: 'suffix' }));
    const corrected = replayLine(replayEnvelope(2, { type: 'suffix' }));
    expect(Buffer.byteLength(invalid)).toBe(Buffer.byteLength(corrected));
    const streamPath = await writeReplayStream(sessionsDir, first);
    const reads: ReplayReadEvent[] = [];
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: observedReplayFs(streamPath, reads),
    });
    await store.readStream(sessionId);

    reads.length = 0;
    await writeFile(streamPath, `${first}${invalid}`, 'utf8');
    await expect(
      store.readStream(sessionId, { afterSeq: 1 }),
    ).rejects.toThrow();
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every(({ position }) => position >= Buffer.byteLength(first)),
    ).toBe(true);

    reads.length = 0;
    await writeFile(streamPath, `${first}${corrected}`, 'utf8');
    expect(await store.readStream(sessionId, { afterSeq: 1 })).toEqual({
      entries: [replayEnvelope(2, { type: 'suffix' })],
      lastReadableSeq: 2,
    });
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every(({ position }) => position >= Buffer.byteLength(first)),
    ).toBe(true);
  });

  it('pins its captured length while a lawful append grows the stream', async () => {
    const { sessionsDir } = await fixtureDir();
    const first = replayLine(replayEnvelope(1, { type: 'captured' }));
    const second = replayLine(replayEnvelope(2, { type: 'later' }));
    const streamPath = await writeReplayStream(sessionsDir, first);
    const reads: ReplayReadEvent[] = [];
    let grew = false;
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: observedReplayFs(streamPath, reads, {
        async afterRead() {
          if (grew) return;
          grew = true;
          await writeFile(streamPath, second, { flag: 'a' });
        },
      }),
    });

    expect(await store.readStream(sessionId)).toEqual({
      entries: [replayEnvelope(1, { type: 'captured' })],
      lastReadableSeq: 1,
    });
    expect(grew).toBe(true);
    expect(
      reads.reduce((total, { bytesRead }) => total + bytesRead, 0),
    ).toBe(Buffer.byteLength(first));
    expect(await readFile(streamPath, 'utf8')).toBe(`${first}${second}`);

    reads.length = 0;
    expect(await store.readStream(sessionId, { afterSeq: 1 })).toEqual({
      entries: [replayEnvelope(2, { type: 'later' })],
      lastReadableSeq: 2,
    });
    expect(
      reads.every(({ position }) => position >= Buffer.byteLength(first)),
    ).toBe(true);
  });

  it('restarts after replacement or truncation and rejects in-read replacement', async () => {
    const first = replayLine(replayEnvelope(1, { type: 'old-first' }));
    const second = replayLine(replayEnvelope(2, { type: 'old-second' }));
    const third = replayLine(replayEnvelope(3, { type: 'new-third' }));
    const fourth = replayLine(replayEnvelope(4, { type: 'new-fourth' }));
    const { sessionsDir } = await fixtureDir();
    const streamPath = await writeReplayStream(
      sessionsDir,
      `${first}${second}`,
    );
    const reads: ReplayReadEvent[] = [];
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: observedReplayFs(streamPath, reads),
    });
    await store.readStream(sessionId);

    const replacementPath = `${streamPath}.replacement`;
    await writeFile(
      replacementPath,
      `${first}${second}${third}`,
      { mode: 0o600 },
    );
    await chmod(replacementPath, 0o600);
    await rename(replacementPath, streamPath);
    reads.length = 0;
    expect(await store.readStream(sessionId, { afterSeq: 2 })).toEqual({
      entries: [replayEnvelope(3, { type: 'new-third' })],
      lastReadableSeq: 3,
    });
    expect(reads.some(({ position }) => position === 0)).toBe(true);

    const changedPrefixPath = `${streamPath}.changed-prefix`;
    await writeFile(
      changedPrefixPath,
      `${replayLine(replayEnvelope(1, { type: 'changed-first' }))}${second}${third}`,
      { mode: 0o600 },
    );
    await chmod(changedPrefixPath, 0o600);
    await rename(changedPrefixPath, streamPath);
    await expect(store.readStream(sessionId)).rejects.toThrow();

    const restoredPath = `${streamPath}.restored`;
    await writeFile(restoredPath, `${first}${second}${third}`, {
      mode: 0o600,
    });
    await chmod(restoredPath, 0o600);
    await rename(restoredPath, streamPath);
    await store.readStream(sessionId);

    await truncate(streamPath, Buffer.byteLength(`${first}${second}`));
    reads.length = 0;
    await expect(store.readStream(sessionId)).rejects.toThrow();
    expect(reads.some(({ position }) => position === 0)).toBe(true);

    await writeFile(streamPath, `${first}${second}${third}${fourth}`, 'utf8');
    reads.length = 0;
    expect(await store.readStream(sessionId, { afterSeq: 3 })).toEqual({
      entries: [replayEnvelope(4, { type: 'new-fourth' })],
      lastReadableSeq: 4,
    });
    expect(reads.some(({ position }) => position === 0)).toBe(true);

    const inRead = await fixtureDir();
    const inReadPath = await writeReplayStream(
      inRead.sessionsDir,
      replayLine(replayEnvelope(1, { type: 'original-snapshot' })),
    );
    const inReadEvents: ReplayReadEvent[] = [];
    let replaced = false;
    const mutatingStore = fixedStore(inRead.sessionsDir, tokenN, {
      fsOps: observedReplayFs(inReadPath, inReadEvents, {
        async afterRead() {
          if (replaced) return;
          replaced = true;
          const nextPath = `${inReadPath}.during-read`;
          await writeFile(
            nextPath,
            replayLine(replayEnvelope(2, { type: 'invalid-replacement' })),
            { mode: 0o600 },
          );
          await chmod(nextPath, 0o600);
          await rename(nextPath, inReadPath);
        },
      }),
    });
    await expect(mutatingStore.readStream(sessionId)).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(inReadEvents.some(({ position }) => position === 0)).toBe(true);
  });
});

describe('lease-bound replay mutation (PBCLI-73/75/76/79/80/83)', () => {
  it('seeds from byte zero and repairs each torn-tail branch exactly', async () => {
    const empty = await fixtureDir();
    const emptyLease = await fixedStore(
      empty.sessionsDir,
      tokenO,
    ).acquire(sessionId);
    expect(emptyLease.streamStatus()).toEqual({
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: false,
    });
    await emptyLease.release();

    const retained = await fixtureDir();
    const retainedLine = replayLine(
      replayEnvelope(1, { type: 'complete-prefix' }),
    );
    await writeReplayStream(retained.sessionsDir, retainedLine);
    const retainedLease = await fixedStore(
      retained.sessionsDir,
      tokenO,
    ).acquire(sessionId);
    expect(retainedLease.streamStatus()).toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 1,
      incomplete: false,
    });
    expect(await readFile(replayStreamPath(retained.sessionsDir), 'utf8'))
      .toBe(retainedLine);
    await retainedLease.release();

    const valid = await fixtureDir();
    const first = replayLine(replayEnvelope(1, { type: 'retained' }));
    const validTail =
      '{ "record": {"type":"valid-tail","bytes":"\u2603"}, "seq":2, "v":1, "role":"coder" }';
    const validPath = await writeReplayStream(
      valid.sessionsDir,
      `${first}${validTail}`,
    );
    const validFs = observedReplayMutationFs(
      valid.sessionsDir,
      validPath,
    );
    const validLease = await fixedStore(valid.sessionsDir, tokenO, {
      fsOps: validFs.fsOps,
    }).acquire(sessionId);
    expect(await readFile(validPath, 'utf8')).toBe(`${first}${validTail}\n`);
    expect(validFs.counts().replaySyncs).toBe(1);
    expect(validLease.streamStatus()).toEqual({
      lastReadableSeq: 2,
      lastDurableSeq: 2,
      incomplete: false,
    });
    await expect(validLease.append({ type: 'after-valid-tail' })).resolves
      .toBeUndefined();
    expect(validLease.streamStatus()).toEqual({
      lastReadableSeq: 3,
      lastDurableSeq: 2,
      incomplete: false,
    });
    await expect(validLease.release()).resolves.toEqual({
      lastReadableSeq: 3,
      lastDurableSeq: 3,
      incomplete: false,
    });
    expect(
      (await fixedStore(valid.sessionsDir, tokenN).readStream(sessionId))
        .entries.map(({ seq }: any) => seq),
    ).toEqual([1, 2, 3]);
    const validSuccessor = await fixedStore(
      valid.sessionsDir,
      tokenN,
    ).acquire(sessionId);
    expect(validSuccessor.streamStatus()).toEqual({
      lastReadableSeq: 3,
      lastDurableSeq: 3,
      incomplete: false,
    });
    await validSuccessor.append({ type: 'clean-successor' });
    await expect(validSuccessor.release()).resolves.toEqual({
      lastReadableSeq: 4,
      lastDurableSeq: 4,
      incomplete: false,
    });
    expect(
      (await fixedStore(valid.sessionsDir, tokenR).readStream(sessionId))
        .entries.map(({ seq }: any) => seq),
    ).toEqual([1, 2, 3, 4]);

    for (const [name, prefix, tail, expectedSeq] of [
      [
        'after-prefix',
        first,
        '{"v":1,"seq":2,"record":{"type":"partial"',
        1,
      ],
      ['after-empty', '', '{"v":1,"seq":1,"record":', 0],
    ] as const) {
      const fixture = await fixtureDir();
      const path = await writeReplayStream(
        fixture.sessionsDir,
        `${prefix}${tail}`,
      );
      const observed = observedReplayMutationFs(fixture.sessionsDir, path);
      const lease = await fixedStore(fixture.sessionsDir, tokenO, {
        fsOps: observed.fsOps,
      }).acquire(sessionId);
      expect(await readFile(path, 'utf8'), name).toBe(prefix);
      expect(observed.counts().replaySyncs, name).toBe(1);
      expect(lease.streamStatus(), name).toEqual({
        lastReadableSeq: expectedSeq,
        lastDurableSeq: expectedSeq,
        incomplete: false,
      });
      await lease.append({ type: `after-${name}` });
      expect(
        (await lease.readStream()).entries.map(({ seq }: any) => seq),
        name,
      ).toEqual([
        ...Array.from({ length: expectedSeq }, (_, i) => i + 1),
        expectedSeq + 1,
      ]);
      await lease.release();
    }
  });

  it('ignores follower cursor state and isolates invalid initialization', async () => {
    const { sessionsDir } = await fixtureDir();
    const valid = replayLine(replayEnvelope(1, { type: 'valid' }));
    const invalid = replayLine(replayEnvelope(2, { type: 'other' }));
    expect(Buffer.byteLength(invalid)).toBe(Buffer.byteLength(valid));
    const streamPath = await writeReplayStream(sessionsDir, valid);
    const store = fixedStore(sessionsDir, tokenO);
    await store.readStream(sessionId);
    await writeFile(streamPath, invalid, 'utf8');

    const lease = await store.acquire(sessionId);
    expect(lease.streamStatus()).toEqual({
      lastReadableSeq: null,
      lastDurableSeq: null,
      incomplete: true,
    });
    await expect(lease.append({ type: 'suppressed' })).resolves.toBeUndefined();
    await expect(lease.readStream()).rejects.toThrow();
    const execution = executionProjection();
    await expect(
      lease.initializeSettledWithPredecessor(freshBoundary(execution)),
    ).resolves.toMatchObject({ state: 'settled' });
    await expect(lease.release()).resolves.toEqual({
      lastReadableSeq: null,
      lastDurableSeq: null,
      incomplete: true,
    });
    expect(await readFile(streamPath, 'utf8')).toBe(invalid);

    const successor = await fixedStore(sessionsDir, tokenN).acquire(sessionId);
    expect(successor.streamStatus()).toEqual({
      lastReadableSeq: null,
      lastDurableSeq: null,
      incomplete: true,
    });
    await expect(successor.release()).resolves.toEqual({
      lastReadableSeq: null,
      lastDurableSeq: null,
      incomplete: true,
    });
    expect(await readFile(streamPath, 'utf8')).toBe(invalid);
  });

  it('advances readability on append and durability on settlement and release', async () => {
    const { sessionsDir } = await fixtureDir();
    const streamPath = replayStreamPath(sessionsDir);
    const observed = observedReplayMutationFs(sessionsDir, streamPath);
    const store = fixedStore(sessionsDir, tokenO, {
      fsOps: observed.fsOps,
    });
    const lease = await store.acquire(sessionId);
    const execution = executionProjection();
    await lease.initializeSettledWithPredecessor(freshBoundary(execution));
    await lease.beginTurn({
      input: 'checkpoint replay at settlement',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    const directorySyncsBeforePublication = observed.counts().sessionsSyncs;

    await expect(
      lease.append(
        { type: 'player_event', resumeToken: 'removed', resume: false },
        'coder',
      ),
    ).resolves.toBeUndefined();
    expect(observed.counts().sessionsSyncs).toBe(
      directorySyncsBeforePublication + 1,
    );
    expect(lease.streamStatus()).toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: false,
    });
    expect(await lease.readStream()).toEqual({
      entries: [
        replayEnvelope(
          1,
          { type: 'player_event', resume: false },
          'coder',
        ),
      ],
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: false,
    });

    await expect(
      lease.settle({
        attemptId: attempt1,
        snapshot: shellSnapshot(execution, 1),
        unresolvedEffects: [],
      }),
    ).resolves.toMatchObject({ state: 'settled' });
    expect(lease.streamStatus()).toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 1,
      incomplete: false,
    });
    const settlementSyncs = observed.counts().replaySyncs;
    expect(settlementSyncs).toBeGreaterThan(0);

    await lease.append({ type: 'captain_reply', text: 'done' });
    expect(lease.streamStatus()).toEqual({
      lastReadableSeq: 2,
      lastDurableSeq: 1,
      incomplete: false,
    });
    await expect(lease.release()).resolves.toEqual({
      lastReadableSeq: 2,
      lastDurableSeq: 2,
      incomplete: false,
    });
    expect(observed.counts().replaySyncs).toBe(settlementSyncs + 1);
  });

  it('reuses one writer handle and one owner read per steady append', async () => {
    const { sessionsDir } = await fixtureDir();
    const streamPath = replayStreamPath(sessionsDir);
    const observed = observedReplayMutationFs(sessionsDir, streamPath);
    const lease = await fixedStore(sessionsDir, tokenO, {
      fsOps: observed.fsOps,
    }).acquire(sessionId);
    await lease.append({ type: 'publish-and-retain-handle' });

    observed.reset();
    await expect(lease.append({ type: 'steady-state' })).resolves
      .toBeUndefined();
    expect(observed.counts()).toEqual({
      replayWrites: 1,
      replaySyncs: 0,
      sessionsSyncs: 0,
      ownerOpens: 1,
      replayOpens: 0,
      replayPathStats: 0,
      replayHandleStats: 1,
      replayCloses: 0,
      sessionsDirStats: 0,
    });

    await lease.release();
    expect(observed.counts().replayCloses).toBe(1);
  });

  it('detects canonical stream replacement at the next checkpoint', async () => {
    const { sessionsDir } = await fixtureDir();
    const streamPath = replayStreamPath(sessionsDir);
    const displacedPath = `${streamPath}.displaced`;
    const lease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    await lease.append({ type: 'held-inode' });
    const bytes = await readFile(streamPath);

    await rename(streamPath, displacedPath);
    await writeFile(streamPath, bytes, { mode: 0o600 });
    await chmod(streamPath, 0o600);

    await expect(lease.release()).resolves.toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: true,
    });
    expect(await readFile(streamPath)).toEqual(bytes);
  });

  it('serializes overlapping appends and makes release an admission barrier', async () => {
    const { sessionsDir } = await fixtureDir();
    const streamPath = replayStreamPath(sessionsDir);
    const entered = deferred();
    const unblock = deferred();
    const observed = observedReplayMutationFs(sessionsDir, streamPath, {
      async beforeReplayWrite({ call }) {
        if (call !== 1) return;
        entered.resolve();
        await unblock.promise;
      },
    });
    const lease = await fixedStore(sessionsDir, tokenO, {
      fsOps: observed.fsOps,
    }).acquire(sessionId);

    let secondSettled = false;
    let releaseSettled = false;
    const first = lease.append({ type: 'first' });
    await entered.promise;
    const second = lease.append({ type: 'second' }).finally(() => {
      secondSettled = true;
    });
    const releasing = lease.release().finally(() => {
      releaseSettled = true;
    });
    await expect(lease.append({ type: 'after-release' })).rejects.toThrow();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(releaseSettled).toBe(false);
    expect(lease.streamStatus()).toEqual({
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: false,
    });

    unblock.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(releasing).resolves.toEqual({
      lastReadableSeq: 2,
      lastDurableSeq: 2,
      incomplete: false,
    });
    expect(
      (await fixedStore(sessionsDir, tokenN).readStream(sessionId)).entries,
    ).toEqual([
      replayEnvelope(1, { type: 'first' }),
      replayEnvelope(2, { type: 'second' }),
    ]);
  });

  it('drains admitted work after a held pre-byte append failure', async () => {
    const { sessionsDir } = await fixtureDir();
    const streamPath = replayStreamPath(sessionsDir);
    const entered = deferred();
    const fail = deferred();
    const observed = observedReplayMutationFs(sessionsDir, streamPath, {
      async beforeReplayWrite({ call }) {
        if (call !== 1) return;
        entered.resolve();
        await fail.promise;
        throw new Error('synthetic pre-byte replay failure');
      },
    });
    const lease = await fixedStore(sessionsDir, tokenO, {
      fsOps: observed.fsOps,
    }).acquire(sessionId);
    const first = lease.append({ type: 'fails' });
    await entered.promise;
    let successorSettled = false;
    let releaseSettled = false;
    const successor = lease.append({ type: 'queued' }).finally(() => {
      successorSettled = true;
    });
    const releasing = lease.release().finally(() => {
      releaseSettled = true;
    });
    await Promise.resolve();
    expect(successorSettled).toBe(false);
    expect(releaseSettled).toBe(false);

    fail.resolve();
    await expect(first).rejects.toThrow(/pre-byte replay failure/);
    await expect(successor).resolves.toBeUndefined();
    await expect(releasing).resolves.toEqual({
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: true,
    });
    expect(await fixedStore(sessionsDir, tokenN).readStream(sessionId)).toEqual({
      entries: [],
      lastReadableSeq: 0,
    });
    expect(observed.counts().replayWrites).toBe(1);
    expect(observed.counts().replaySyncs).toBe(0);
  });

  it('classifies raw arguments before sanitization and leaves retry eligible', async () => {
    const cases: readonly [string, unknown, unknown?][] = [
      ['null', null],
      ['number', 7],
      ['string', 'record'],
      ['callable', () => undefined],
      ['array', [{ type: 'array-entry' }]],
      ['empty role', { type: 'record' }, ''],
      ['non-string role', { type: 'record' }, 7],
    ];
    for (const [name, value, role] of cases) {
      const { sessionsDir } = await fixtureDir();
      const lease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
      const before = lease.streamStatus();
      await expect((lease.append as any)(value, role), name).rejects.toThrow();
      expect(lease.streamStatus(), name).toEqual(before);
      expect(await fixedStore(sessionsDir, tokenN).readStream(sessionId), name)
        .toEqual({ entries: [], lastReadableSeq: 0 });
      await expect(lease.append({ type: `corrected-${name}` }), name).resolves
        .toBeUndefined();
      expect(
        (await lease.readStream()).entries.map(({ seq }: any) => seq),
        name,
      ).toEqual([1]);
      await lease.release();
    }
  });

  it('latches sanitizer failures only for the live lease', async () => {
    const cyclic: Record<string, unknown> = { type: 'cyclic' };
    cyclic.self = cyclic;
    for (const [name, value] of [
      ['date', new Date('2026-08-11T21:00:00.000Z')],
      ['cycle', cyclic],
      ['nested callable', { type: 'callable', nested: () => undefined }],
    ] as const) {
      const { sessionsDir } = await fixtureDir();
      const lease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
      await expect(lease.append(value), name).rejects.toThrow();
      expect(lease.streamStatus(), name).toEqual({
        lastReadableSeq: 0,
        lastDurableSeq: 0,
        incomplete: true,
      });
      await expect(lease.append({ type: 'suppressed' }), name).resolves
        .toBeUndefined();
      expect(await fixedStore(sessionsDir, tokenN).readStream(sessionId), name)
        .toEqual({ entries: [], lastReadableSeq: 0 });
      await expect(lease.release(), name).resolves.toEqual({
        lastReadableSeq: 0,
        lastDurableSeq: 0,
        incomplete: true,
      });

      const successor = await fixedStore(
        sessionsDir,
        tokenN,
      ).acquire(sessionId);
      expect(successor.streamStatus(), name).toEqual({
        lastReadableSeq: 0,
        lastDurableSeq: 0,
        incomplete: false,
      });
      await successor.append({ type: `successor-${name}` });
      await successor.release();
      expect(
        (await fixedStore(sessionsDir, tokenR).readStream(sessionId)).entries,
        name,
      ).toEqual([replayEnvelope(1, { type: `successor-${name}` })]);
    }
  });

  it('isolates publication, visible-write, checkpoint, and repair failures', async () => {
    const publication = await fixtureDir();
    const publicationPath = replayStreamPath(publication.sessionsDir);
    let failPublication = false;
    const publicationFs = observedReplayMutationFs(
      publication.sessionsDir,
      publicationPath,
      {
        beforeSessionsSync() {
          if (failPublication) {
            failPublication = false;
            throw new Error('synthetic replay publication sync failure');
          }
        },
      },
    );
    const publicationLease = await fixedStore(
      publication.sessionsDir,
      tokenO,
      { fsOps: publicationFs.fsOps },
    ).acquire(sessionId);
    failPublication = true;
    await expect(publicationLease.append({ type: 'published' })).rejects
      .toThrow(/publication sync failure/);
    expect(publicationLease.streamStatus()).toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: true,
    });
    await publicationLease.append({ type: 'suppressed' });
    expect((await publicationLease.readStream()).entries).toEqual([
      replayEnvelope(1, { type: 'published' }),
    ]);
    await expect(publicationLease.release()).resolves.toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: true,
    });

    const visible = await fixtureDir();
    const visiblePath = replayStreamPath(visible.sessionsDir);
    let failAfterWrite = false;
    const visibleFs = observedReplayMutationFs(
      visible.sessionsDir,
      visiblePath,
      {
        afterReplayWrite() {
          if (failAfterWrite) {
            throw new Error('synthetic post-write replay failure');
          }
        },
      },
    );
    const visibleLease = await fixedStore(visible.sessionsDir, tokenO, {
      fsOps: visibleFs.fsOps,
    }).acquire(sessionId);
    failAfterWrite = true;
    await expect(visibleLease.append({ type: 'complete-but-failed' })).rejects
      .toThrow(/post-write replay failure/);
    expect(visibleLease.streamStatus()).toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: true,
    });
    expect(await visibleLease.readStream()).toEqual({
      entries: [replayEnvelope(1, { type: 'complete-but-failed' })],
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: true,
    });
    expect(
      await fixedStore(visible.sessionsDir, tokenN).readStream(sessionId),
    ).toEqual({
      entries: [replayEnvelope(1, { type: 'complete-but-failed' })],
      lastReadableSeq: 1,
    });
    await visibleLease.release();

    const checkpoint = await fixtureDir();
    const checkpointPath = replayStreamPath(checkpoint.sessionsDir);
    let failCheckpoint = false;
    const checkpointFs = observedReplayMutationFs(
      checkpoint.sessionsDir,
      checkpointPath,
      {
        beforeReplaySync() {
          if (failCheckpoint) {
            throw new Error('synthetic replay checkpoint failure');
          }
        },
      },
    );
    const checkpointLease = await fixedStore(checkpoint.sessionsDir, tokenO, {
      fsOps: checkpointFs.fsOps,
    }).acquire(sessionId);
    const execution = executionProjection();
    await checkpointLease.initializeSettledWithPredecessor(
      freshBoundary(execution),
    );
    await checkpointLease.beginTurn({
      input: 'fail replay checkpoint only',
      attemptId: attempt1,
      attemptedExecutionProjection: execution,
    });
    await checkpointLease.append({ type: 'checkpointed' });
    failCheckpoint = true;
    await expect(
      checkpointLease.settle({
        attemptId: attempt1,
        snapshot: shellSnapshot(execution, 1),
        unresolvedEffects: [],
      }),
    ).resolves.toMatchObject({ state: 'settled' });
    expect(checkpointLease.streamStatus()).toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: true,
    });
    const checkpointSyncs = checkpointFs.counts().replaySyncs;
    await checkpointLease.append({ type: 'suppressed' });
    await expect(checkpointLease.release()).resolves.toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: true,
    });
    expect(checkpointFs.counts().replaySyncs).toBe(checkpointSyncs);

    const release = await fixtureDir();
    const releasePath = replayStreamPath(release.sessionsDir);
    let failRelease = false;
    const releaseFs = observedReplayMutationFs(
      release.sessionsDir,
      releasePath,
      {
        beforeReplaySync() {
          if (failRelease) {
            throw new Error('synthetic replay release checkpoint failure');
          }
        },
      },
    );
    const releaseLease = await fixedStore(release.sessionsDir, tokenO, {
      fsOps: releaseFs.fsOps,
    }).acquire(sessionId);
    await releaseLease.append({ type: 'release-checkpoint' });
    failRelease = true;
    await expect(releaseLease.release()).resolves.toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: true,
    });

    const repair = await fixtureDir();
    const repairFirst = replayLine(replayEnvelope(1, { type: 'first' }));
    const repairTail = JSON.stringify(
      replayEnvelope(2, { type: 'repaired-but-unsynced' }),
    );
    const repairPath = await writeReplayStream(
      repair.sessionsDir,
      `${repairFirst}${repairTail}`,
    );
    const repairFs = observedReplayMutationFs(
      repair.sessionsDir,
      repairPath,
      {
        beforeReplaySync() {
          throw new Error('synthetic replay repair sync failure');
        },
      },
    );
    const repairLease = await fixedStore(repair.sessionsDir, tokenO, {
      fsOps: repairFs.fsOps,
    }).acquire(sessionId);
    expect(await readFile(repairPath, 'utf8')).toBe(
      `${repairFirst}${repairTail}\n`,
    );
    expect(repairLease.streamStatus()).toEqual({
      lastReadableSeq: 2,
      lastDurableSeq: 1,
      incomplete: true,
    });
    await repairLease.append({ type: 'suppressed' });
    await expect(repairLease.release()).resolves.toEqual({
      lastReadableSeq: 2,
      lastDurableSeq: 1,
      incomplete: true,
    });
    const repairSuccessor = await fixedStore(
      repair.sessionsDir,
      tokenN,
    ).acquire(sessionId);
    expect(repairSuccessor.streamStatus()).toEqual({
      lastReadableSeq: 2,
      lastDurableSeq: 2,
      incomplete: false,
    });
    await repairSuccessor.release();
  });

  it('refuses replay mutation without exact canonical ownership', async () => {
    const { sessionsDir } = await fixtureDir();
    const lease = await fixedStore(sessionsDir, tokenO).acquire(sessionId);
    const ownerPath = join(
      sessionsDir,
      `.${sessionId}.lock`,
      'owner.json',
    );
    const ownerBytes = await readFile(ownerPath, 'utf8');
    const owner = JSON.parse(ownerBytes);
    await writeFile(
      ownerPath,
      `${JSON.stringify({ ...owner, ownerToken: tokenN })}\n`,
      'utf8',
    );
    await expect(lease.append({ type: 'not-owner' })).rejects.toThrow(
      /different token|ownership/,
    );
    expect(lease.streamStatus()).toEqual({
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: false,
    });
    expect(await fixedStore(sessionsDir, tokenR).readStream(sessionId)).toEqual({
      entries: [],
      lastReadableSeq: 0,
    });
    await writeFile(ownerPath, ownerBytes, 'utf8');

    let changedDuringSanitization = false;
    const record = new Proxy(
      { type: 'owner-changes-during-sanitization' },
      {
        getPrototypeOf(target) {
          if (!changedDuringSanitization) {
            changedDuringSanitization = true;
            writeFileSync(
              ownerPath,
              `${JSON.stringify({ ...owner, ownerToken: tokenN })}\n`,
              'utf8',
            );
          }
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    await expect(lease.append(record)).rejects.toThrow(
      /different token|ownership/,
    );
    expect(changedDuringSanitization).toBe(true);
    expect(lease.streamStatus()).toEqual({
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: false,
    });
    expect(await fixedStore(sessionsDir, tokenR).readStream(sessionId)).toEqual({
      entries: [],
      lastReadableSeq: 0,
    });
    await writeFile(ownerPath, ownerBytes, 'utf8');
    await lease.release();

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
