// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type {
  PlayerResult,
  PlayerSessionStore,
  PlaybookEffectBoundary,
  PlaybookEffectLedger,
  PlaybookEffectLedgerCommandBatch,
  PlaybookRepositoryReceipt,
} from '../../../src/runtime.js';
import createLinkedPlaybookRuntime, {
  _internal,
  type PlayerCallOptions,
  type PlaybookCallRequest,
  type PlaybookCallResult,
  type PlaybookPorts,
  type PlaybookRunResult,
  type PlaybookRuntimeSnapshot,
  type PlaybookSession,
  type PlaybookTraceEvent,
} from './decide.playbook.ts';

const signal = (): AbortSignal => new AbortController().signal;

const distinctBindings = {
  coder: { playerId: 'dev.coder', promptIdentity: 'GPT-5.6 Sol' },
  reviewer: {
    playerId: 'dev.reviewer',
    promptIdentity: 'Claude Opus 5',
  },
} as const;

interface PlayerCallRecord {
  roleId: string;
  prompt: string;
  options: PlayerCallOptions;
}

interface TelemetryRecord {
  topic: string;
  payload: unknown;
}

function playbookTraces(records: readonly TelemetryRecord[]): PlaybookTraceEvent[] {
  return records
    .filter(({ topic }) => topic === 'playbook.trace')
    .map(({ payload }) => payload as PlaybookTraceEvent);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createPlayerSessionStore(): PlayerSessionStore & {
  readonly tokens: Map<string, string>;
} {
  const tokens = new Map<string, string>();
  return {
    tokens,
    select: (roleId) => tokens.get(roleId) ?? false,
    update: (roleId, resumeToken) => {
      if (resumeToken === undefined) tokens.delete(roleId);
      else tokens.set(roleId, resumeToken);
    },
    snapshot: () => Object.fromEntries(tokens),
    restore: (restored) => {
      tokens.clear();
      for (const [roleId, resumeToken] of Object.entries(restored)) {
        tokens.set(roleId, resumeToken);
      }
    },
  };
}

function session(
  ports: PlaybookPorts,
  playerSessions = createPlayerSessionStore(),
  roleBindings?: PlaybookSession['roleBindings'],
): PlaybookSession {
  return {
    sessionId: DECIDE_TEST_SESSION_ID,
    playbookId: 'decide',
    rootSessionId: DECIDE_TEST_SESSION_ID,
    depth: 0,
    playerSessions,
    ...(roleBindings === undefined ? {} : { roleBindings }),
    ports,
  };
}

const DECIDE_TEST_SESSION_ID = '30000000-0000-4000-8000-000000000000';
const REPLAY_SESSION_ID = '30000000-0000-4000-8000-000000000001';

function replayObservation(projection: Record<string, unknown> = {}) {
  return {
    worktree: '/repo',
    gitDir: '/repo/.git',
    head: '1'.repeat(40),
    projection,
    projectionDigest: `sha256:${createHash('sha256')
      .update(JSON.stringify(projection))
      .digest('hex')}`,
  };
}

const REPLAY_BASELINE = replayObservation();
const DEFAULT_COMMIT_OID = `${'0'.repeat(39)}b`;

function replayLedger(
  boundaries: readonly PlaybookEffectBoundary[],
): PlaybookEffectLedger {
  return {
    schemaVersion: 1,
    revision: boundaries.length === 0 ? 0 : boundaries.length,
    boundaries,
    logicalOperations: [],
  };
}

type TestReceiptClassification =
  | 'unchanged'
  | 'one-descendant-commit'
  | 'worktree-only-change'
  | 'concurrent-or-foreign-change'
  | 'observation-ambiguous';

interface TestEffectHostOptions {
  readonly exclusiveClassifications?: readonly TestReceiptClassification[];
  readonly cohortClassifications?: readonly TestReceiptClassification[];
  readonly sessionId?: string;
}

function createTestEffectHost(options: TestEffectHostOptions = {}) {
  let ledger = replayLedger([]);
  let observation = REPLAY_BASELINE;
  let boundarySequence = 0;
  let attemptSequence = 0;
  let commitSequence = 10;
  const exclusiveClassifications = [
    ...(options.exclusiveClassifications ?? []),
  ];
  const cohortClassifications = [...(options.cohortClassifications ?? [])];

  const writeAhead = async (
    commands: PlaybookEffectLedgerCommandBatch,
  ): Promise<PlaybookEffectLedger> => {
    const boundaries = [...ledger.boundaries] as PlaybookEffectBoundary[];
    const logicalOperations = [...ledger.logicalOperations];
    for (const command of commands) {
      if (command.kind === 'start-boundaries') {
        const attemptId = `61000000-0000-4000-8000-${String(++attemptSequence).padStart(12, '0')}`;
        for (const seed of command.boundaries) {
          boundaries.push({
            sequence: ++boundarySequence,
            attemptId,
            attemptNumber: 1,
            ...seed,
          });
        }
        continue;
      }
      if (command.kind === 'replace-boundaries') {
        for (const { expected, next } of command.replacements) {
          const index = boundaries.findIndex(
            ({ boundaryId }) => boundaryId === expected.boundaryId,
          );
          if (
            index < 0 ||
            JSON.stringify(boundaries[index]) !== JSON.stringify(expected)
          ) {
            throw new Error('DECIDE test effect boundary replacement is stale');
          }
          boundaries[index] = next;
        }
        continue;
      }
      if (command.kind === 'append-logical-operations') {
        for (const operation of command.operations) {
          logicalOperations.push({
            sequence: logicalOperations.length + 1,
            ...operation,
          });
        }
        continue;
      }
      for (const { expected, next } of command.replacements) {
        const index = logicalOperations.findIndex(
          ({ operationId }) => operationId === expected.operationId,
        );
        if (
          index < 0 ||
          JSON.stringify(logicalOperations[index]) !== JSON.stringify(expected)
        ) {
          throw new Error(
            'DECIDE test logical-operation replacement is stale',
          );
        }
        logicalOperations[index] = next;
      }
    }
    ledger = {
      schemaVersion: 1,
      revision: ledger.revision + 1,
      boundaries,
      logicalOperations,
    };
    return ledger;
  };

  const receipt = (
    baseline: typeof REPLAY_BASELINE,
    classification: TestReceiptClassification,
  ): PlaybookRepositoryReceipt => {
    if (classification === 'unchanged') {
      return { classification, baseline, after: baseline };
    }
    if (classification === 'one-descendant-commit') {
      const commitOid = (++commitSequence).toString(16).padStart(40, '0');
      const after = { ...baseline, head: commitOid };
      return { classification, baseline, after, commitOid };
    }
    const after = replayObservation({ foreign: String(++commitSequence) });
    return { classification, baseline, after };
  };

  const settle = async (operation: (context: any) => Promise<unknown>, context: any) => {
    try {
      return { status: 'fulfilled' as const, value: await operation(context) };
    } catch (reason) {
      return { status: 'rejected' as const, reason };
    }
  };

  const completedBoundary = (
    current: PlaybookEffectBoundary,
    physicalReceipt: PlaybookRepositoryReceipt,
    completion: any,
    logicalOperationId?: string,
  ): PlaybookEffectBoundary => ({
    ...current,
    ...(physicalReceipt.after === undefined
      ? {}
      : { after: physicalReceipt.after }),
    physicalReceipt,
    ...(completion.finalText === undefined
      ? {}
      : { finalText: completion.finalText }),
    ...(completion.semanticCandidate === undefined
      ? {}
      : { semanticCandidate: completion.semanticCandidate }),
    ...(logicalOperationId === undefined ? {} : { logicalOperationId }),
  });

  const repository = {
    identity: { worktree: '/repo', gitDir: '/repo/.git' },
    observe: async () => observation,
    acquire: async () => ({}),
    async runExclusive(raw: any) {
      const baseline = observation;
      const seed = {
        ...raw.effectBoundary,
        playbookId: 'decide',
        canonicalWorktree: repository.identity,
        baseline,
      };
      await writeAhead([{ kind: 'start-boundaries', boundaries: [seed] }]);
      const started = ledger.boundaries.find(
        ({ boundaryId }) => boundaryId === seed.boundaryId,
      )!;
      const operation = await settle(raw.operation, {
        baseline,
        identity: repository.identity,
      });
      const defaultClassification: TestReceiptClassification =
        seed.sourceStateId === 'commitCoderProposal'
          ? operation.status === 'fulfilled' &&
            /\?|question/i.test(String((operation.value as any)?.finalText ?? ''))
            ? 'unchanged'
            : 'one-descendant-commit'
          : 'unchanged';
      const physicalReceipt = receipt(
        baseline,
        exclusiveClassifications.shift() ?? defaultClassification,
      );
      observation = physicalReceipt.after ?? baseline;
      const completion = await raw.completeEffectBoundary({
        boundary: started,
        operation,
        receipt: physicalReceipt,
        outcomeReceipt: physicalReceipt,
      });
      const current = ledger.boundaries.find(
        ({ boundaryId }) => boundaryId === seed.boundaryId,
      )!;
      const operationId = completion.deferred?.operationId;
      const commands: any[] = [
        {
          kind: 'replace-boundaries',
          replacements: [
            {
              expected: current,
              next: completedBoundary(
                current,
                physicalReceipt,
                completion,
                operationId,
              ),
            },
          ],
        },
      ];
      if (completion.deferred !== undefined) {
        commands.push({
          kind: 'append-logical-operations',
          operations: [
            {
              operationId,
              playbookId: 'decide',
              runtimeSessionId: current.runtimeSessionId,
              boundaryIds: [current.boundaryId],
              originalBaseline: current.baseline,
              checkpoint: physicalReceipt.after,
              pendingQuestion: completion.deferred.pendingQuestion,
              playerContinuation: completion.deferred.playerContinuation,
              checkpointRestorationEligible: false,
            },
          ],
        });
      }
      const effectLedger = await writeAhead(
        commands as PlaybookEffectLedgerCommandBatch,
      );
      return {
        operation,
        receipt: physicalReceipt,
        effectLedger,
        ...(completion.deferred === undefined
          ? {}
          : { deferredStatus: 'bound' as const }),
      };
    },
    async runCohort(raw: any) {
      const baseline = observation;
      const cohortId = `62000000-0000-4000-8000-${String(++attemptSequence).padStart(12, '0')}`;
      const roleIds = [...raw.roleIds] as Array<'coder' | 'reviewer'>;
      const seeds = roleIds.map((roleId) => ({
        ...raw.effectBoundaries[roleId],
        playbookId: 'decide',
        canonicalWorktree: repository.identity,
        baseline,
        cohortId,
      }));
      await writeAhead([{ kind: 'start-boundaries', boundaries: seeds }]);
      const operations = Object.fromEntries(
        await Promise.all(
          roleIds.map(async (roleId) => [
            roleId,
            await settle(raw.operations[roleId], {
              baseline,
              identity: repository.identity,
              invocationId: raw.invocationId,
              roleId,
            }),
          ]),
        ),
      ) as Record<'coder' | 'reviewer', any>;
      const physicalReceipt = receipt(
        baseline,
        cohortClassifications.shift() ?? 'unchanged',
      );
      observation = physicalReceipt.after ?? baseline;
      const completions = await Promise.all(
        roleIds.map((roleId) => {
          const boundary = ledger.boundaries.find(
            ({ boundaryId }) =>
              boundaryId === raw.effectBoundaries[roleId].boundaryId,
          )!;
          return raw.completeEffectBoundary({
            boundary,
            operation: operations[roleId],
            receipt: physicalReceipt,
            outcomeReceipt: physicalReceipt,
            roleId,
          });
        }),
      );
      const replacements = roleIds.map((roleId, index) => {
        const current = ledger.boundaries.find(
          ({ boundaryId }) =>
            boundaryId === raw.effectBoundaries[roleId].boundaryId,
        )!;
        return {
          expected: current,
          next: completedBoundary(
            current,
            physicalReceipt,
            completions[index],
          ),
        };
      });
      const effectLedger = await writeAhead([
        { kind: 'replace-boundaries', replacements },
      ]);
      const receipts = Object.fromEntries(
        roleIds.map((roleId) => [roleId, physicalReceipt]),
      );
      return {
        baseline,
        invocationId: raw.invocationId,
        operations,
        receipts,
        effectLedger,
      };
    },
    async runDeferred() {
      throw new Error('unexpected default DECIDE deferred continuation');
    },
  };

  const hostCapabilities = {
    authority: {
      playbookId: 'decide',
      artifactSchema: 3 as const,
      cwd: '/repo',
      sessionId: options.sessionId ?? DECIDE_TEST_SESSION_ID,
      leaseOwnerToken: '64000000-0000-4000-8000-000000000001',
      canonicalWorktree: repository.identity,
      requiredRoleIds: ['coder', 'reviewer'] as const,
      concurrentRoleSets: [['coder', 'reviewer']] as const,
    },
    repository,
    effectLedger: { snapshot: () => ledger, writeAhead },
  };
  return { hostCapabilities, readEffectLedger: () => ledger };
}

function createPlaybookRuntime(
  options: unknown = {},
  host = createTestEffectHost(),
) {
  return createLinkedPlaybookRuntime({
    configuredOptions: options as Record<string, never>,
    hostCapabilities: host.hostCapabilities,
  });
}

const DEFERRED_ATTEMPT_ID = '50000000-0000-4000-8000-000000000002';

function createDeferredRepositoryHarness() {
  let ledger: PlaybookEffectLedger = replayLedger([]);
  let checkpointMatches = true;
  let restorationMatches = true;
  let failBindCompletion = false;
  let failContinuationCompletion = false;
  const calls: Array<{ mode: string; operationId?: string }> = [];

  const replaceOperation = (
    operationId: string,
    update: (operation: PlaybookEffectLedger['logicalOperations'][number]) =>
      PlaybookEffectLedger['logicalOperations'][number],
  ): void => {
    ledger = {
      ...ledger,
      revision: ledger.revision + 1,
      logicalOperations: ledger.logicalOperations.map((operation) =>
        operation.operationId === operationId ? update(operation) : operation,
      ),
    };
  };
  const writeAhead = async (
    commands: PlaybookEffectLedgerCommandBatch,
  ): Promise<PlaybookEffectLedger> => {
    const boundaries = [...ledger.boundaries];
    const logicalOperations = [...ledger.logicalOperations];
    for (const command of commands) {
      if (command.kind === 'replace-boundaries') {
        for (const { expected, next } of command.replacements) {
          const index = boundaries.findIndex(
            ({ boundaryId }) => boundaryId === expected.boundaryId,
          );
          if (
            index < 0 ||
            JSON.stringify(boundaries[index]) !== JSON.stringify(expected)
          ) {
            throw new Error(
              'DECIDE deferred boundary replacement is stale',
            );
          }
          boundaries[index] = next;
        }
      } else if (command.kind === 'replace-logical-operations') {
        for (const { expected, next } of command.replacements) {
          const index = logicalOperations.findIndex(
            ({ operationId }) => operationId === expected.operationId,
          );
          if (
            index < 0 ||
            JSON.stringify(logicalOperations[index]) !==
              JSON.stringify(expected)
          ) {
            throw new Error(
              'DECIDE deferred logical-operation replacement is stale',
            );
          }
          logicalOperations[index] = next;
        }
      } else {
        throw new Error(
          `unexpected DECIDE deferred write-ahead command ${command.kind}`,
        );
      }
    }
    ledger = {
      ...ledger,
      revision: ledger.revision + 1,
      boundaries,
      logicalOperations,
    };
    return ledger;
  };
  const boundaryFrom = (
    seed: Record<string, unknown>,
    options: {
      baseline: ReturnType<typeof replayObservation>;
      after: ReturnType<typeof replayObservation>;
      receipt: PlaybookEffectBoundary['physicalReceipt'];
      finalText?: string;
      semanticCandidate?: unknown;
      operationId: string;
    },
  ): PlaybookEffectBoundary => ({
    ...(seed as unknown as Omit<
      PlaybookEffectBoundary,
      | 'sequence'
      | 'attemptId'
      | 'attemptNumber'
      | 'playbookId'
      | 'canonicalWorktree'
      | 'baseline'
      | 'after'
      | 'physicalReceipt'
      | 'logicalOperationId'
    >),
    sequence: ledger.boundaries.length + 1,
    attemptId: DEFERRED_ATTEMPT_ID,
    attemptNumber: 1,
    playbookId: 'decide',
    canonicalWorktree: { worktree: '/repo', gitDir: '/repo/.git' },
    baseline: options.baseline,
    after: options.after,
    physicalReceipt: options.receipt,
    ...(options.finalText === undefined
      ? {}
      : { finalText: options.finalText }),
    ...(options.semanticCandidate === undefined
      ? {}
      : { semanticCandidate: options.semanticCandidate as never }),
    logicalOperationId: options.operationId,
  });

  const repository = {
    identity: { worktree: '/repo', gitDir: '/repo/.git' },
    observe: async () => REPLAY_BASELINE,
    acquire: async () => ({}),
    async runCohort(options: any) {
      calls.push({ mode: 'cohort' });
      const cohortId = '51000000-0000-4000-8000-000000000001';
      const roleIds = [...options.roleIds] as Array<'coder' | 'reviewer'>;
      const started = Object.fromEntries(
        roleIds.map((roleId) => {
          const seed = options.effectBoundaries[roleId];
          return [
            roleId,
            {
              ...seed,
              sequence: ledger.boundaries.length + roleIds.indexOf(roleId) + 1,
              attemptId: DEFERRED_ATTEMPT_ID,
              attemptNumber: 1,
              playbookId: 'decide',
              canonicalWorktree: repository.identity,
              baseline: REPLAY_BASELINE,
              cohortId,
            },
          ];
        }),
      ) as Record<'coder' | 'reviewer', PlaybookEffectBoundary>;
      ledger = {
        ...ledger,
        revision: ledger.revision + 1,
        boundaries: [
          ...ledger.boundaries,
          ...roleIds.map((roleId) => started[roleId]),
        ],
      };
      const operations = Object.fromEntries(
        await Promise.all(
          roleIds.map(async (roleId) => [
            roleId,
            await Promise.resolve()
              .then(() =>
                options.operations[roleId]({
                  baseline: REPLAY_BASELINE,
                  identity: repository.identity,
                  invocationId: options.invocationId,
                  roleId,
                }),
              )
              .then(
                (value) => ({ status: 'fulfilled' as const, value }),
                (reason) => ({ status: 'rejected' as const, reason }),
              ),
          ]),
        ),
      ) as Record<'coder' | 'reviewer', any>;
      const receipt = {
        classification: 'unchanged' as const,
        baseline: REPLAY_BASELINE,
        after: REPLAY_BASELINE,
      };
      const completions = await Promise.all(
        roleIds.map((roleId) =>
          options.completeEffectBoundary({
            boundary: started[roleId],
            operation: operations[roleId],
            receipt,
            outcomeReceipt: receipt,
            roleId,
          }),
        ),
      );
      ledger = {
        ...ledger,
        revision: ledger.revision + 1,
        boundaries: ledger.boundaries.map((boundary) => {
          const index = roleIds.findIndex(
            (roleId) => started[roleId].boundaryId === boundary.boundaryId,
          );
          if (index < 0) return boundary;
          const completion = completions[index];
          return {
            ...boundary,
            after: REPLAY_BASELINE,
            physicalReceipt: receipt,
            ...(completion.finalText === undefined
              ? {}
              : { finalText: completion.finalText }),
            ...(completion.semanticCandidate === undefined
              ? {}
              : { semanticCandidate: completion.semanticCandidate }),
          };
        }),
      };
      return {
        baseline: REPLAY_BASELINE,
        invocationId: options.invocationId,
        operations,
        receipts: { coder: receipt, reviewer: receipt },
        effectLedger: ledger,
      };
    },
    async runExclusive(options: any) {
      calls.push({ mode: 'exclusive' });
      const operation = await Promise.resolve()
        .then(options.operation)
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        );
      const after = REPLAY_BASELINE;
      const receipt = {
        classification: 'unchanged' as const,
        baseline: REPLAY_BASELINE,
        after,
      };
      const provisional = boundaryFrom(options.effectBoundary, {
        baseline: REPLAY_BASELINE,
        after,
        receipt,
        operationId: '50000000-0000-4000-8000-000000000001',
      });
      const completion = await options.completeEffectBoundary({
        boundary: provisional,
        operation,
        receipt,
        outcomeReceipt: receipt,
      });
      const operationId = completion.deferred?.operationId;
      if (typeof operationId !== 'string') {
        throw new Error('initial DECIDE question did not bind its operation');
      }
      if (failBindCompletion) {
        failBindCompletion = false;
        throw new Error('injected deferred bind completion failure');
      }
      const boundary = boundaryFrom(options.effectBoundary, {
        baseline: REPLAY_BASELINE,
        after,
        receipt,
        finalText: completion.finalText,
        semanticCandidate: completion.semanticCandidate,
        operationId,
      });
      ledger = {
        ...ledger,
        revision: ledger.revision + 1,
        boundaries: [...ledger.boundaries, boundary],
        logicalOperations: [
          ...ledger.logicalOperations,
          {
            sequence: ledger.logicalOperations.length + 1,
            operationId,
            playbookId: 'decide',
            runtimeSessionId: boundary.runtimeSessionId,
            boundaryIds: [boundary.boundaryId],
            originalBaseline: REPLAY_BASELINE,
            checkpoint: after,
            pendingQuestion: completion.deferred.pendingQuestion,
            playerContinuation: completion.deferred.playerContinuation,
            checkpointRestorationEligible: false,
          },
        ],
      };
      return {
        operation,
        receipt,
        effectLedger: ledger,
        deferredStatus: 'bound' as const,
      };
    },

    async runDeferred(options: any) {
      calls.push({ mode: options.mode, operationId: options.operationId });
      const current = ledger.logicalOperations.find(
        ({ operationId }) => operationId === options.operationId,
      );
      if (current === undefined) throw new Error('missing deferred operation');
      if (options.mode === 'park') {
        replaceOperation(options.operationId, (operation) => {
          const {
            checkpoint: _checkpoint,
            pendingQuestion: _pendingQuestion,
            playerContinuation: _playerContinuation,
            ...withoutBinding
          } = operation;
          return {
            ...withoutBinding,
            checkpointRestorationEligible: false,
          };
        });
        return { status: 'parked' as const, effectLedger: ledger };
      }
      if (options.mode === 'restore') {
        if (!current.checkpointRestorationEligible) {
          return { status: 'ineligible' as const, effectLedger: ledger };
        }
        if (!restorationMatches) {
          return {
            status: 'checkpoint-mismatch' as const,
            effectLedger: ledger,
          };
        }
        replaceOperation(options.operationId, (operation) => ({
          ...operation,
          checkpointRestorationEligible: false,
        }));
        return { status: 'restored' as const, effectLedger: ledger };
      }
      if (!checkpointMatches) {
        replaceOperation(options.operationId, (operation) => ({
          ...operation,
          checkpointRestorationEligible: true,
        }));
        return {
          status: 'checkpoint-mismatch' as const,
          effectLedger: ledger,
        };
      }

      const baseline = current.checkpoint!;
      const operation = await Promise.resolve()
        .then(() =>
          options.operation({
            baseline,
            identity: { worktree: '/repo', gitDir: '/repo/.git' },
            playerContinuation: current.playerContinuation,
          }),
        )
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        );
      const committed =
        operation.status === 'fulfilled' &&
        String(operation.value.finalText ?? '') === 'Committed proposal';
      const after = committed
        ? { ...baseline, head: 'b'.repeat(40) }
        : baseline;
      const receipt = committed
        ? {
            classification: 'one-descendant-commit' as const,
            baseline,
            after,
            commitOid: 'b'.repeat(40),
          }
        : {
            classification: 'unchanged' as const,
            baseline,
            after,
          };
      const provisional = boundaryFrom(options.effectBoundary, {
        baseline,
        after,
        receipt,
        operationId: options.operationId,
      });
      const outcomeReceipt = committed
        ? {
            classification: 'one-descendant-commit' as const,
            baseline: current.originalBaseline,
            after,
            commitOid: 'b'.repeat(40),
          }
        : {
            classification: 'unchanged' as const,
            baseline: current.originalBaseline,
            after,
          };
      const completion = await options.completeEffectBoundary({
        boundary: provisional,
        operation,
        receipt,
        outcomeReceipt,
      });
      if (failContinuationCompletion) {
        failContinuationCompletion = false;
        throw new Error('injected deferred continuation completion failure');
      }
      const boundary = boundaryFrom(options.effectBoundary, {
        baseline,
        after,
        receipt,
        finalText: completion.finalText,
        semanticCandidate: completion.semanticCandidate,
        operationId: options.operationId,
      });
      const logicalReceipt = committed ? outcomeReceipt : undefined;
      ledger = {
        ...ledger,
        revision: ledger.revision + 1,
        boundaries: [...ledger.boundaries, boundary],
        logicalOperations: ledger.logicalOperations.map((candidate) =>
          candidate.operationId !== options.operationId
            ? candidate
            : completion.deferred
              ? {
                  ...candidate,
                  boundaryIds: [...candidate.boundaryIds, boundary.boundaryId],
                  checkpoint: after,
                  pendingQuestion: completion.deferred.pendingQuestion,
                  playerContinuation: completion.deferred.playerContinuation,
                  checkpointRestorationEligible: false,
                }
              : (() => {
                  const {
                    checkpoint: _checkpoint,
                    pendingQuestion: _pendingQuestion,
                    playerContinuation: _playerContinuation,
                    ...withoutBinding
                  } = candidate;
                  return {
                    ...withoutBinding,
                    boundaryIds: [
                      ...candidate.boundaryIds,
                      boundary.boundaryId,
                    ],
                    ...(logicalReceipt === undefined
                      ? {}
                      : { logicalReceipt }),
                    checkpointRestorationEligible: false,
                  };
                })(),
        ),
      };
      return {
        status: 'continued' as const,
        baseline,
        operation,
        receipt,
        ...(logicalReceipt === undefined ? {} : { logicalReceipt }),
        effectLedger: ledger,
        ...(completion.deferred
          ? { deferredStatus: 'bound' as const }
          : {}),
      };
    },
  };

  const effectLedger = {
    snapshot: () => ledger,
    writeAhead,
  };
  const hostCapabilities = {
    authority: {
      playbookId: 'decide',
      artifactSchema: 3 as const,
      cwd: '/repo',
      sessionId: REPLAY_SESSION_ID,
      leaseOwnerToken: '52000000-0000-4000-8000-000000000001',
      canonicalWorktree: repository.identity,
      requiredRoleIds: ['coder', 'reviewer'] as const,
      concurrentRoleSets: [['coder', 'reviewer']] as const,
    },
    repository,
    effectLedger,
  };

  return {
    repository,
    effectLedger,
    hostCapabilities,
    calls,
    readEffectLedger: () => ledger,
    setCheckpointMatches(value: boolean) {
      checkpointMatches = value;
    },
    setRestorationMatches(value: boolean) {
      restorationMatches = value;
    },
    failNextBindCompletion() {
      failBindCompletion = true;
    },
    failNextContinuationCompletion() {
      failContinuationCompletion = true;
    },
  };
}

function replaySession(ports: PlaybookPorts): PlaybookSession {
  return {
    ...session(ports),
    sessionId: REPLAY_SESSION_ID,
    rootSessionId: REPLAY_SESSION_ID,
  };
}

function completePorts(overrides: Partial<PlaybookPorts>): PlaybookPorts {
  return {
    callPlayer: async () => {
      throw new Error('unexpected player call');
    },
    callCaptain: async () => {
      throw new Error('unexpected direct Captain call');
    },
    callJudge: async () => {
      throw new Error('unexpected judge call');
    },
    callPlaybook: async () => {
      throw new Error('unexpected nested playbook call');
    },
    emitStatus: async () => {},
    emitTelemetry: async () => {},
    ...overrides,
  };
}

function judgeReply(prompt: string): string {
  if (prompt.includes('source item DECIDE-1')) {
    return JSON.stringify({ guard: 'proposed' });
  }
  if (prompt.includes('source item DECIDE-2')) {
    return JSON.stringify({ guard: 'proposed' });
  }
  if (prompt.includes('source item DECIDE-3')) {
    return JSON.stringify({ guard: 'committed' });
  }
  throw new Error(`unexpected judge prompt: ${prompt}`);
}

function createAcceptedOutcomeDecideRuntime() {
  return createPlaybookRuntime({});
}

interface ReviewBoundary {
  runtime: ReturnType<typeof createPlaybookRuntime>;
  request: PlaybookCallRequest;
  telemetry: TelemetryRecord[];
  host: ReturnType<typeof createTestEffectHost>;
}

async function runToReview(
  onTelemetry?: (record: TelemetryRecord) => void | Promise<void>,
  turnSignal: AbortSignal = signal(),
): Promise<ReviewBoundary> {
  const playerCounts = new Map<string, number>();
  const telemetry: TelemetryRecord[] = [];
  let request: PlaybookCallRequest | undefined;
  const ports = completePorts({
    callPlayer: async (roleId) => {
      const count = (playerCounts.get(roleId) ?? 0) + 1;
      playerCounts.set(roleId, count);
      return {
        status: 'ok',
        resumeToken: `${roleId}-token-${count}`,
        finalText:
          roleId === 'coder' && count === 1
            ? 'Coder proposal'
            : roleId === 'reviewer'
              ? 'Reviewer proposal'
              : 'Committed proposal',
      };
    },
    callJudge: async (prompt) => judgeReply(prompt),
    callPlaybook: async (nestedRequest) => {
      request = nestedRequest;
      return { state: 'suspended', childSessionId: 'review-child' };
    },
    emitTelemetry: async (record) => {
      telemetry.push(record);
      await onTelemetry?.(record);
    },
  });
  const host = createTestEffectHost();
  const runtime = createPlaybookRuntime({}, host);
  await runtime.init(session(ports));
  const result = await runtime.handleBossInput({
    text: 'Choose the durable design.',
    signal: turnSignal,
  });
  expect(result).toMatchObject({ outcome: 'suspended' });
  if (!request) throw new Error('DECIDE did not call REVIEW');
  return { runtime, request, telemetry, host };
}

async function startWithCommitOutput(
  commitOutput: string,
  callPlaybook: PlaybookPorts['callPlaybook'] = async () => ({
    state: 'suspended',
    childSessionId: 'review-child',
  }),
): Promise<{
  runtime: ReturnType<typeof createPlaybookRuntime>;
  result: Promise<PlaybookRunResult>;
  nestedRequests: PlaybookCallRequest[];
}> {
  let coderCalls = 0;
  const nestedRequests: PlaybookCallRequest[] = [];
  const ports = completePorts({
    callPlayer: async (roleId) => {
      if (roleId === 'reviewer') {
        return {
          status: 'ok',
          resumeToken: 'reviewer-token-1',
          finalText: 'Reviewer proposal',
        };
      }
      coderCalls += 1;
      return {
        status: 'ok',
        resumeToken: `coder-token-${coderCalls}`,
        finalText: coderCalls === 1 ? 'Coder proposal' : commitOutput,
      };
    },
    callJudge: async (prompt) =>
      prompt.includes('source item DECIDE-3')
        ? JSON.stringify({ guard: 'committed' })
        : judgeReply(prompt),
    callPlaybook: async (request, boundarySignal) => {
      nestedRequests.push(request);
      return callPlaybook(request, boundarySignal);
    },
  });
  const runtime = createPlaybookRuntime({});
  await runtime.init(session(ports));
  return {
    runtime,
    result: runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: signal(),
    }),
    nestedRequests,
  };
}

describe('DECIDE parallel proposals and nested REVIEW handoff', () => {
  it('keeps its internal runtime id distinct from logical host authority', async () => {
    const host = createTestEffectHost({
      sessionId: '30000000-0000-4000-8000-000000000099',
    });
    const runtime = createPlaybookRuntime({}, host);

    await expect(runtime.init(session(completePorts({})))).resolves.toBe(
      undefined,
    );
    expect(runtime.exportSnapshot()).toMatchObject({ playbookId: 'decide' });

    await runtime.dispose();
  });

  it('keeps proposals blind, resumes mapped roles, and suspends on exact REVIEW input', async () => {
    const coderProposal = 'Coder proposal with literal <caller-topic> token.';
    const reviewerProposal = 'Reviewer private alternative.';
    const callerTopic =
      'Choose <coder-llm> behavior.\nKeep mapped roles shared.';
    const proposalResults = {
      coder: deferred<{
        status: 'ok';
        resumeToken: string;
        finalText: string;
      }>(),
      reviewer: deferred<{
        status: 'ok';
        resumeToken: string;
        finalText: string;
      }>(),
    };
    const playerCalls: PlayerCallRecord[] = [];
    const playerCounts = new Map<string, number>();
    const telemetry: TelemetryRecord[] = [];
    const statuses: string[] = [];
    const nestedRequests: PlaybookCallRequest[] = [];
    const playerSessions = createPlayerSessionStore();
    let activeProposalCalls = 0;
    let maximumActiveProposalCalls = 0;

    const ports = completePorts({
      callPlayer: async (roleId, prompt, _signal, options) => {
        playerCalls.push({ roleId, prompt, options: { ...options } });
        const count = (playerCounts.get(roleId) ?? 0) + 1;
        playerCounts.set(roleId, count);
        if (count === 1) {
          activeProposalCalls += 1;
          maximumActiveProposalCalls = Math.max(
            maximumActiveProposalCalls,
            activeProposalCalls,
          );
          try {
            return await proposalResults[roleId as 'coder' | 'reviewer']
              .promise;
          } finally {
            activeProposalCalls -= 1;
          }
        }
        expect(roleId).toBe('coder');
        return {
          status: 'ok',
          resumeToken: 'coder-token-2',
          finalText: 'Committed Coder proposal.',
        };
      },
      callJudge: async (prompt) => judgeReply(prompt),
      callPlaybook: async (request) => {
        nestedRequests.push(request);
        return { state: 'suspended', childSessionId: 'review-child' };
      },
      emitStatus: async (message) => {
        statuses.push(message);
      },
      emitTelemetry: async (record) => {
        telemetry.push(record);
      },
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports, playerSessions, distinctBindings));

    const running = runtime.handleBossInput({
      text: callerTopic,
      signal: signal(),
    });
    await vi.waitFor(() => {
      expect(playerCalls).toHaveLength(2);
    });

    expect(maximumActiveProposalCalls).toBe(2);
    expect(playerCalls.map(({ roleId }) => roleId).sort()).toEqual([
      'coder',
      'reviewer',
    ]);
    for (const call of playerCalls) {
      expect(call.prompt).toContain(
        '> Choose <coder-llm> behavior.\n> Keep mapped roles shared.',
      );
      expect(call.prompt).toContain('Propose your design.');
      expect(call.prompt).not.toContain(coderProposal);
      expect(call.prompt).not.toContain(reviewerProposal);
      expect(call.options.resume).toBe(false);
    }

    proposalResults.coder.resolve({
      status: 'ok',
      resumeToken: 'coder-token-1',
      finalText: coderProposal,
    });
    proposalResults.reviewer.resolve({
      status: 'ok',
      resumeToken: 'reviewer-token-1',
      finalText: reviewerProposal,
    });

    const result = await running;
    expect(result).toMatchObject({
      outcome: 'suspended',
      pendingCall: {
        callId: 'playbook-1',
        playbookId: 'review',
        childSessionId: 'review-child',
      },
    });
    expect(playerCalls).toHaveLength(3);
    expect(playerCalls[2]).toMatchObject({
      roleId: 'coder',
      options: { resume: 'coder-token-1' },
    });
    expect(playerCalls[2].prompt).toContain('Coder is GPT-5.6 Sol');
    expect(playerCalls[2].prompt).not.toContain(
      'Include exactly one final-response line beginning `Commit: `, followed only by the exact commit identity; other final-response content may appear on other lines.',
    );
    expect(playerCalls[2].prompt).not.toContain(reviewerProposal);
    expect(nestedRequests).toEqual([
      {
        callId: 'playbook-1',
        playbookId: 'review',
        text: [
          'Review the latest commit as a spec-design change against the initial intent.',
          'Compare it with your independent proposal and take the best of both.',
          'Make your suggestions.',
          '',
          `Initial intent: ${callerTopic}.`,
          `Coder's independent proposal: ${coderProposal}.`,
        ].join('\n'),
      },
    ]);
    expect(nestedRequests[0].text).not.toContain(reviewerProposal);
    expect(nestedRequests[0].text).toContain(
      'Coder proposal with literal <caller-topic> token.',
    );
    expect(Object.fromEntries(playerSessions.tokens)).toEqual({
      coder: 'coder-token-2',
      reviewer: 'reviewer-token-1',
    });
    const playerTraces = playbookTraces(telemetry).filter(({ type }) =>
      type.startsWith('player.call.'),
    );
    expect(playerTraces).toHaveLength(6);
    for (const trace of playerTraces) {
      expect(trace.schemaVersion).toBe(4);
      const payload = trace.payload as Record<string, unknown>;
      expect(payload.roleId).toMatch(/^(coder|reviewer)$/);
      expect(payload.playerId).toBe(
        payload.roleId === 'coder' ? 'dev.coder' : 'dev.reviewer',
      );
      expect(payload).not.toHaveProperty('purpose');
    }
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot).toMatchObject({
      schemaVersion: 4,
      roleResumeTokens: {
        coder: 'coder-token-2',
        reviewer: 'reviewer-token-1',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('dev.coder');
    expect(JSON.stringify(snapshot)).not.toContain('dev.reviewer');
    expect(JSON.stringify(snapshot)).not.toContain('GPT-5.6 Sol');
    expect(JSON.stringify(snapshot)).not.toContain('Claude Opus 5');
    expect(statuses).toContain('START_DECIDE');
    expect(statuses).toContain(
      '⤷ Coder: Coder independently proposes a spec design.',
    );
    expect(statuses).toContain(
      '⤷ Reviewer: Reviewer independently proposes a spec design.',
    );
    expect(statuses).toContain(
      '⤷ Coder: Coder writes and commits Coder’s independent proposal.',
    );
    expect(statuses).not.toContain('REVIEW examines the committed proposal.');

    const fsmPayloads = telemetry
      .filter(({ topic }) => topic === 'playbook.fsm.state')
      .map(({ payload }) => payload as Record<string, unknown>);
    const initial = fsmPayloads[0];
    expect(initial.from).toEqual(initial.to);
    expect(initial.previousState).toEqual(initial.state);
    expect(fsmPayloads).toContainEqual(
      expect.objectContaining({
        event: {
          type: 'START_DECIDE',
          callerTopic,
        },
      }),
    );

    await runtime.dispose();
  });

  it.each([
    ['missing', 'Committed proposal.'],
    ['glued', 'Committed proposal. Commit:deadbeef'],
    ['fenced', '```text\nCommit: deadbeef\n```'],
    ['quoted', '> Commit: deadbeef'],
    [
      'duplicated',
      'Committed proposal.\nCommit: old\nCommit: deadbeef',
    ],
    [
      'misleading',
      'This prose says Commit: definitely-not-the-repository-oid.',
    ],
  ])('ignores %s Commit prose under equal effect evidence', async (_label, output) => {
    const { runtime, result, nestedRequests } =
      await startWithCommitOutput(output);
    await expect(result).resolves.toMatchObject({
      outcome: 'suspended',
      state: { stateId: 'reviewCommit' },
    });
    expect(nestedRequests).toHaveLength(1);
    await runtime.dispose();
  });

  it('restarts both proposal branches with the exact interrupted topic', async () => {
    const playerCalls: PlayerCallRecord[] = [];
    const counts = new Map<string, number>();
    const ports = completePorts({
      callPlayer: async (roleId, prompt, _signal, options) => {
        playerCalls.push({ roleId, prompt, options: { ...options } });
        const count = (counts.get(roleId) ?? 0) + 1;
        counts.set(roleId, count);
        return {
          status: 'ok',
          resumeToken: `${roleId}-token-${count}`,
          finalText:
            count === 1
              ? `Need ${roleId} input`
              : roleId === 'coder' && count === 3
                ? 'Committed replacement proposal'
                : `${roleId} replacement proposal`,
        };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Boss-input classifier')) {
          return JSON.stringify({
            type: 'BOSS_INTERRUPT',
            targetId: 'independentProposals',
          });
        }
        if (
          prompt.includes('source item DECIDE-1') ||
          prompt.includes('source item DECIDE-2')
        ) {
          const match = prompt.match(/Need (coder|reviewer) input/);
          return match
            ? JSON.stringify({ guard: 'needsBossReply' })
            : JSON.stringify({ guard: 'proposed' });
        }
        return JSON.stringify({ guard: 'committed' });
      },
      callPlaybook: async () => ({
        state: 'suspended',
        childSessionId: 'review-child',
      }),
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));

    await expect(
      runtime.handleBossInput({ text: 'Old topic', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'quiescent' });
    expect(playerCalls).toHaveLength(2);

    await expect(
      runtime.handleBossInput({ text: 'New topic', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'suspended' });
    const restarted = playerCalls.slice(2, 4);
    expect(restarted.map(({ roleId }) => roleId).sort()).toEqual([
      'coder',
      'reviewer',
    ]);
    for (const call of restarted) {
      expect(call.prompt).toContain('> New topic');
      expect(call.prompt).not.toContain('> Old topic');
      expect(call.options.resume).toBe(`${call.roleId}-token-1`);
    }

    await runtime.dispose();
  });

  it('rejects aliased parallel roles before a second host call', async () => {
    const hostCalls = vi.fn(
      (_roleId: string, _prompt: string, invocationSignal: AbortSignal) =>
        new Promise<{
          status: 'aborted';
        }>((resolve) => {
          invocationSignal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        }),
    );
    const telemetry: TelemetryRecord[] = [];
    const runtime = createPlaybookRuntime({});
    await runtime.init(
      session(
        completePorts({
          callPlayer: hostCalls,
          emitTelemetry: async (record) => {
            telemetry.push(record);
          },
        }),
        createPlayerSessionStore(),
        {
          coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
          reviewer: {
            playerId: 'dev.shared',
            promptIdentity: 'Reviewer',
          },
        },
      ),
    );

    await expect(
      runtime.handleBossInput({ text: 'Compare designs.', signal: signal() }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(hostCalls).toHaveBeenCalledTimes(1);
    const collision = playbookTraces(telemetry).find(
      ({ type, payload }) =>
        type === 'player.call.finished' &&
        (payload as Record<string, unknown>).status === 'error',
    );
    expect(collision?.payload).toMatchObject({
      playerId: 'dev.shared',
      error: {
        message: expect.stringContaining('already has an in-flight call'),
      },
    });

    await runtime.dispose();
  });

  it('snapshots parallel questions with local-role askers', async () => {
    const runtime = createPlaybookRuntime({});
    const statuses: string[] = [];
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId) => ({
            status: 'ok',
            resumeToken: `${roleId}-thread`,
            finalText: `Need ${roleId} clarification`,
          }),
          callJudge: async (prompt) => {
            const roleId = prompt.includes('Need coder clarification')
              ? 'coder'
              : 'reviewer';
            return JSON.stringify({ guard: 'needsBossReply' });
          },
          emitStatus: async (message) => {
            statuses.push(message);
          },
        }),
      ),
    );
    await expect(
      runtime.handleBossInput({ text: 'Compare designs.', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'quiescent' });
    expect(runtime.exportSnapshot?.()).toMatchObject({
      schemaVersion: 4,
      roleResumeTokens: {
        coder: 'coder-thread',
        reviewer: 'reviewer-thread',
      },
      pendingBossQuestions: [
        {
          questionId: 'askCoderProposal',
          asker: { kind: 'role', roleId: 'coder' },
          question: 'Need coder clarification',
          sourceItem: 'DECIDE-1',
        },
        {
          questionId: 'askReviewerProposal',
          asker: { kind: 'role', roleId: 'reviewer' },
          question: 'Need reviewer clarification',
          sourceItem: 'DECIDE-2',
        },
      ],
    });
    expect(statuses).toEqual(
      expect.arrayContaining([
        'coder asks: Need coder clarification',
        '◆ awaiting Boss reply · askCoderProposal · coder · DECIDE-1',
        'reviewer asks: Need reviewer clarification',
        '◆ awaiting Boss reply · askReviewerProposal · reviewer · DECIDE-2',
      ]),
    );

    await runtime.dispose();
  });

  // PBRT-45: a question pends only while its authored reply-wait state is
  // active — the map spans all three of DECIDE's reply paths, and the
  // context's retained entries never leak past their waits.
  it('counts a question as pending only in its own active authored wait', () => {
    const question = (resumeStateId: string, roleId: string) => ({
      questionId: resumeStateId,
      resumeStateId,
      sourceItem: 'DECIDE-1',
      asker: { kind: 'role', roleId },
      question: `${resumeStateId}?`,
    });
    const context = {
      pendingBossQuestions: {
        askCoderProposal: question('askCoderProposal', 'coder'),
        askReviewerProposal: question('askReviewerProposal', 'reviewer'),
        commitCoderProposal: question('commitCoderProposal', 'coder'),
      },
    };
    const state = (...activeStateIds: string[]) =>
      ({
        value: 'proposals',
        activeStateIds,
        tags: [],
        status: 'active',
        quiescent: true,
      }) as never;
    const pendingIds = (...activeStateIds: string[]) =>
      _internal
        .pendingQuestionsForState(state(...activeStateIds), context)
        .map(({ questionId }: { questionId: string }) => questionId);

    expect(pendingIds('waitCoderProposalReply')).toEqual(['askCoderProposal']);
    expect(pendingIds('waitReviewerProposalReply')).toEqual([
      'askReviewerProposal',
    ]);
    expect(pendingIds('awaitBossReply')).toEqual(['commitCoderProposal']);
    expect(
      pendingIds('waitCoderProposalReply', 'waitReviewerProposalReply'),
    ).toEqual(['askCoderProposal', 'askReviewerProposal']);
    // A resumed player state and the failure state pend nothing, however
    // long the context retains the answered entries.
    expect(pendingIds('askCoderProposal')).toEqual([]);
    expect(pendingIds('failed')).toEqual([]);
  });

  it('drops an answered branch question from telemetry while its sibling still waits', async () => {
    const telemetry: TelemetryRecord[] = [];
    let coderCalls = 0;
    const runtime = createPlaybookRuntime({});
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId) => {
            if (roleId === 'coder') coderCalls += 1;
            return {
              status: 'ok',
              resumeToken: `${roleId}-thread`,
              finalText: `Need ${roleId} clarification`,
            };
          },
          callJudge: async (prompt) => {
            if (prompt.includes('Classify the Boss message')) {
              return JSON.stringify({
                type: 'BOSS_REPLY',
                questionId: 'askCoderProposal',
              });
            }
            const roleId = prompt.includes('Need coder clarification')
              ? 'coder'
              : 'reviewer';
            return JSON.stringify({ guard: 'needsBossReply' });
          },
          emitTelemetry: async (record) => {
            telemetry.push(record);
          },
        }),
      ),
    );

    await runtime.handleBossInput({ text: 'Compare designs.', signal: signal() });
    const parkedPayloads = telemetry.filter(
      ({ topic }) => topic === 'playbook.fsm.state',
    ).length;

    // Boss answers the coder's question; the reviewer's stays open. Every
    // transition of the resumed turn — the branch re-entering its player
    // state included — reports only the question still awaiting its reply,
    // never the answered one riding the context for the resumed prompt.
    await runtime.handleBossInput({
      text: 'Use approach A.',
      signal: signal(),
    });
    const resumedPayloads = telemetry
      .filter(({ topic }) => topic === 'playbook.fsm.state')
      .slice(parkedPayloads)
      .map(({ payload }) => payload as Record<string, unknown>);
    expect(resumedPayloads.length).toBeGreaterThan(1);
    const resumeTransition = resumedPayloads[0] as {
      pendingBossQuestions?: Array<{ questionId: string }>;
    };
    expect(
      resumeTransition.pendingBossQuestions?.map(
        ({ questionId }) => questionId,
      ),
    ).toEqual(['askReviewerProposal']);

    // The resumed coder asked again, so the turn parks with two genuinely
    // pending questions — the snapshot and the final transition agree.
    const parkedAgain = resumedPayloads.at(-1) as {
      pendingBossQuestions?: Array<{ questionId: string }>;
    };
    expect(
      parkedAgain.pendingBossQuestions?.map(({ questionId }) => questionId),
    ).toEqual(expect.arrayContaining(['askCoderProposal', 'askReviewerProposal']));
    expect(coderCalls).toBe(2);
    expect(
      runtime.exportSnapshot?.()?.pendingBossQuestions?.map(
        ({ questionId }) => questionId,
      ),
    ).toEqual(['askCoderProposal', 'askReviewerProposal']);

    await runtime.dispose();
  });
});

describe('DECIDE accepted-outcome consumer', () => {
  it.each(['coder', 'reviewer'] as const)(
    'publishes executed parallel outcomes when %s finishes first and drains them before settlement',
    async (firstRole) => {
      const secondRole = firstRole === 'coder' ? 'reviewer' : 'coder';
      const telemetry: TelemetryRecord[] = [];
      const statuses: string[] = [];
      const acceptedObserved = deferred<void>();
      const releaseAccepted = deferred<void>();
      const coderProposal = deferred<PlayerResult>();
      const reviewerProposal = deferred<PlayerResult>();
      let coderCalls = 0;
      let proposalCalls = 0;
      let settled = false;
      const ports = completePorts({
        callPlayer: async (roleId) => {
          if (roleId === 'reviewer') {
            proposalCalls += 1;
            return reviewerProposal.promise;
          }
          coderCalls += 1;
          if (coderCalls === 1) {
            proposalCalls += 1;
            return coderProposal.promise;
          }
          return {
            status: 'ok',
            finalText: 'Committed proposal',
          };
        },
        callJudge: async (prompt) => judgeReply(prompt),
        callPlaybook: async () => ({
          state: 'suspended',
          childSessionId: 'review-child',
        }),
        emitStatus: async (message) => {
          statuses.push(message);
        },
        emitTelemetry: async (record) => {
          telemetry.push(record);
          if (
            record.topic === 'playbook.trace' &&
            (record.payload as { type?: string }).type === 'outcome.accepted' &&
            !settled
          ) {
            acceptedObserved.resolve();
            await releaseAccepted.promise;
          }
        },
      });
      const runtime = createAcceptedOutcomeDecideRuntime();
      await runtime.init(session(ports));

      const running = runtime
        .handleBossInput({ text: 'Choose the durable design.', signal: signal() })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.waitFor(() => {
        expect(proposalCalls).toBe(2);
      });
      const proposals = { coder: coderProposal, reviewer: reviewerProposal };
      proposals[firstRole].resolve({
        status: 'ok',
        finalText: `${firstRole} proposal`,
      });
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(
        playbookTraces(telemetry).filter(
          ({ type }) => type === 'outcome.accepted',
        ),
      ).toEqual([]);
      expect(statuses.some((status) => status.startsWith('→ '))).toBe(false);
      proposals[secondRole].resolve({
        status: 'ok',
        finalText: `${secondRole} proposal`,
      });
      await acceptedObserved.promise;
      expect(settled).toBe(false);
      expect(statuses.some((status) => status.startsWith('→ '))).toBe(false);
      releaseAccepted.resolve();
      await expect(running).resolves.toMatchObject({ outcome: 'suspended' });

      const acceptedTraces = playbookTraces(telemetry).filter(
        ({ type }) => type === 'outcome.accepted',
      );
      expect(acceptedTraces).toHaveLength(3);
      const proposalTrace = (roleId: 'coder' | 'reviewer', first: boolean) => ({
        schemaVersion: 4,
        payload: {
          source:
            roleId === 'coder' ? 'askCoderProposal' : 'askReviewerProposal',
          target: first
            ? roleId === 'coder'
              ? 'coderProposalComplete'
              : 'reviewerProposalComplete'
            : 'commitCoderProposal',
          acceptedOutcome: 'proposed',
        },
      });
      expect(
        acceptedTraces.map(({ schemaVersion, payload }) => ({
          schemaVersion,
          payload,
        })),
      ).toEqual([
        proposalTrace(firstRole, true),
        proposalTrace(secondRole, false),
        {
          schemaVersion: 4,
          payload: {
            source: 'commitCoderProposal',
            target: 'reviewCommit',
            acceptedOutcome: 'committed',
          },
        },
      ]);
      expect(statuses.filter((status) => status === '→ proposed')).toHaveLength(
        2,
      );
      expect(statuses.filter((status) => status === '→ committed')).toHaveLength(
        1,
      );
      await runtime.dispose();
    },
  );

  it('publishes no accepted outcome when DECIDE selects its fallback arm', async () => {
    const telemetry: TelemetryRecord[] = [];
    const statuses: string[] = [];
    const runtime = createAcceptedOutcomeDecideRuntime();
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId) => ({
            status: 'ok',
            finalText: `${roleId} proposal`,
          }),
          callJudge: async () =>
            JSON.stringify({ guard: 'needsBossReply', question: 42 }),
          emitStatus: async (message) => {
            statuses.push(message);
          },
          emitTelemetry: async (record) => {
            telemetry.push(record);
          },
        }),
      ),
    );

    await expect(
      runtime.handleBossInput({
        text: 'Choose the durable design.',
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(
      playbookTraces(telemetry).filter(
        ({ type }) => type === 'outcome.accepted',
      ),
    ).toEqual([]);
    expect(statuses.some((status) => status.startsWith('→ '))).toBe(false);
    expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
      'reconcile:unresolved-effect',
      'abandon:unresolved-effect',
    ]);
    expect(runtime.unresolvedEffectEnvelopes?.()).toHaveLength(2);
    await runtime.dispose();
  });

  it.each([
    ['proposal', 'concurrent-or-foreign-change', 2, 'proposed'],
    ['proposal', 'observation-ambiguous', 2, 'proposed'],
    ['merge', 'worktree-only-change', 3, 'committed'],
    ['merge', 'observation-ambiguous', 3, 'committed'],
  ] as const)(
    'parks a %s outcome under %s evidence without another player call',
    async (boundary, classification, expectedPlayerCalls, rejectedOutcome) => {
      const statuses: string[] = [];
      let coderCalls = 0;
      let reviewCalls = 0;
      const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async (roleId) => {
        if (roleId === 'reviewer') {
          return { status: 'ok', finalText: 'Reviewer proposal' };
        }
        coderCalls += 1;
        return {
          status: 'ok',
          finalText:
            coderCalls === 1 ? 'Coder proposal' : 'Committed proposal',
        };
      });
      const host = createTestEffectHost({
        ...(boundary === 'proposal'
          ? { cohortClassifications: [classification] }
          : { exclusiveClassifications: [classification] }),
      });
      const runtime = createLinkedPlaybookRuntime({
        configuredOptions: {},
        hostCapabilities: host.hostCapabilities,
      });
      await runtime.init(
        session(
          completePorts({
            callPlayer,
            callJudge: async (prompt) => judgeReply(prompt),
            callPlaybook: async () => {
              reviewCalls += 1;
              return { state: 'suspended', childSessionId: 'review-child' };
            },
            emitStatus: async (message) => {
              statuses.push(message);
            },
          }),
        ),
      );

      await expect(
        runtime.handleBossInput({
          text: 'Choose the durable design.',
          signal: signal(),
        }),
      ).resolves.toMatchObject({
        outcome: 'failed',
        state: { stateId: 'failed' },
      });
      expect(callPlayer).toHaveBeenCalledTimes(expectedPlayerCalls);
      expect(reviewCalls).toBe(0);
      expect(statuses).not.toContain(`→ ${rejectedOutcome}`);
      const unresolvedView = runtime.describe?.();
      expect(unresolvedView).not.toHaveProperty('stateDescription');
      expect(unresolvedView?.pendingQuestions).toEqual([]);
      expect(unresolvedView?.actions).toEqual([
        {
          id: 'reconcile:unresolved-effect',
          label: 'Retry unresolved effect reconciliation',
        },
        {
          id: 'abandon:unresolved-effect',
          label: 'Abandon unresolved workflow attempt',
        },
      ]);
      expect(runtime.unresolvedEffectEnvelopes?.()).toHaveLength(
        boundary === 'proposal' ? 2 : 1,
      );

      await expect(
        runtime.apply?.({
          actionId: 'reconcile:unresolved-effect',
          key: 'retry-unresolved-effect',
          signal: signal(),
        }),
      ).resolves.toMatchObject({
        disposition: 'executed',
        run: { outcome: 'no-action', state: { stateId: 'failed' } },
      });
      expect(callPlayer).toHaveBeenCalledTimes(expectedPlayerCalls);
      expect(reviewCalls).toBe(0);

      const unresolvedState = runtime.describe?.().state;
      const abandonment = await runtime.apply?.({
        actionId: 'abandon:unresolved-effect',
        key: 'abandon-unresolved-effect',
        signal: signal(),
      });
      expect(abandonment).toEqual({
        disposition: 'executed',
        run: { outcome: 'unresolved-effect', state: unresolvedState },
      });
      if (abandonment?.disposition === 'executed') {
        expect(Object.keys(abandonment.run).sort()).toEqual([
          'outcome',
          'state',
        ]);
      }
      expect(callPlayer).toHaveBeenCalledTimes(expectedPlayerCalls);
      expect(reviewCalls).toBe(0);
      await runtime.dispose();
    },
  );
});

describe('DECIDE automatic-replay effect fence', () => {
  it.each([
    ['an unchanged exact receipt', 'unchanged', true],
    [
      'a nonzero exact receipt',
      'concurrent-or-foreign-change',
      false,
    ],
  ] as const)(
    'permits empty-ok correction under %s only when durably unchanged',
    async (_label, classification, expectedCorrection) => {
      let coderCalls = 0;
      let reviewCalls = 0;
      const ports = completePorts({
        callPlayer: async (roleId) => {
          if (roleId === 'reviewer') {
            return {
              status: 'ok',
              finalText: 'Reviewer proposal',
            };
          }
          coderCalls += 1;
          return {
            status: 'ok',
            finalText:
              coderCalls === 1
                ? ''
                : coderCalls === 2
                  ? 'Coder proposal'
                  : 'Committed proposal',
          };
        },
        callJudge: async (prompt) => judgeReply(prompt),
        callPlaybook: async () => {
          reviewCalls += 1;
          return { state: 'suspended', childSessionId: 'review-child' };
        },
      });
      const host = createTestEffectHost({
        sessionId: REPLAY_SESSION_ID,
        cohortClassifications: [classification],
      });
      const runtime = createLinkedPlaybookRuntime({
        configuredOptions: {},
        hostCapabilities: host.hostCapabilities,
      });
      await runtime.init(replaySession(ports));

      const result = await runtime.handleBossInput({
        text: 'Choose the durable design.',
        signal: signal(),
      });

      if (expectedCorrection) {
        expect(result).toMatchObject({ outcome: 'suspended' });
        expect(coderCalls).toBe(3);
        expect(reviewCalls).toBe(1);
      } else {
        expect(result).toMatchObject({
          outcome: 'failed',
          state: { stateId: 'failed' },
          error: {
            message: expect.stringContaining(
              'repository-disposition-mismatch',
            ),
          },
        });
        expect(coderCalls).toBe(1);
        expect(reviewCalls).toBe(0);
      }

      await runtime.dispose();
    },
  );

  it.each([
    ['an all-unchanged host attempt', 'unchanged', true],
    [
      'a nonzero host attempt',
      'concurrent-or-foreign-change',
      false,
    ],
  ] as const)(
    'permits failed-state restart under %s only when the whole attempt is safe',
    async (_label, classification, expectedRestart) => {
      let firstAttemptCalls = 0;
      let playerCalls = 0;
      let attemptNumber = 1;
      const ports = completePorts({
        callPlayer: async () => {
          playerCalls += 1;
          if (attemptNumber === 1) {
            firstAttemptCalls += 1;
          }
          return {
            status: 'error',
            error: `attempt ${attemptNumber} failed`,
          };
        },
      });
      const host = createTestEffectHost({
        sessionId: REPLAY_SESSION_ID,
        cohortClassifications: [classification],
      });
      const runtime = createLinkedPlaybookRuntime({
        configuredOptions: {},
        hostCapabilities: host.hostCapabilities,
      });
      await runtime.init(replaySession(ports));
      await expect(
        runtime.handleBossInput({ text: 'First topic.', signal: signal() }),
      ).resolves.toMatchObject({
        outcome: 'failed',
        state: { stateId: 'failed' },
      });
      expect(firstAttemptCalls).toBe(2);
      const callsBeforeRetry = playerCalls;
      attemptNumber = 2;

      const retry = await runtime.handleBossInput({
        text: 'Try a new topic.',
        signal: signal(),
      });

      if (expectedRestart) {
        expect(retry).toMatchObject({
          outcome: 'failed',
          state: { stateId: 'failed' },
        });
        expect(playerCalls).toBeGreaterThan(callsBeforeRetry);
      } else {
        expect(retry).toMatchObject({
          outcome: 'no-action',
          state: { stateId: 'failed' },
        });
        expect(playerCalls).toBe(callsBeforeRetry);
      }

      await runtime.dispose();
    },
  );
});

describe('DECIDE deferred effect continuation', () => {
  function stagedFixture(
    harness = createDeferredRepositoryHarness(),
  ) {
    const playerSessions = createPlayerSessionStore();
    const playerCalls: PlayerCallRecord[] = [];
    const statuses: string[] = [];
    let coderCalls = 0;
    let reviewerCalls = 0;
    let judgeCalls = 0;
    const ports = completePorts({
      callPlayer: async (roleId, prompt, _signal, options) => {
        playerCalls.push({ roleId, prompt, options: { ...options } });
        if (roleId === 'reviewer') {
          reviewerCalls += 1;
          return {
            status: 'ok',
            resumeToken: `reviewer-token-${reviewerCalls}`,
            finalText: 'Reviewer proposal',
          };
        }
        coderCalls += 1;
        return {
          status: 'ok',
          resumeToken: `coder-token-${coderCalls}`,
          finalText:
            coderCalls === 1
              ? 'Coder proposal'
              : coderCalls === 2
                ? 'Approve this checkpoint?'
                : coderCalls === 3
                  ? 'Approve the second checkpoint?'
                  : 'Committed proposal',
        };
      },
      callJudge: async (prompt) => {
        judgeCalls += 1;
        if (prompt.includes('Boss-input classifier')) {
          if (prompt.includes('Not an answer')) {
            return JSON.stringify({ type: 'NO_ACTION' });
          }
          if (prompt.includes('Take a new direction')) {
            return JSON.stringify({
              type: 'BOSS_INTERRUPT',
              targetId: 'independentProposals',
            });
          }
          return JSON.stringify({
            type: 'BOSS_REPLY',
            questionId: 'commitCoderProposal',
          });
        }
        if (prompt.includes('source item DECIDE-1')) {
          return JSON.stringify({ guard: 'proposed' });
        }
        if (prompt.includes('source item DECIDE-2')) {
          return JSON.stringify({ guard: 'proposed' });
        }
        if (prompt.includes('Approve the second checkpoint?')) {
          return JSON.stringify({ guard: 'needsBossReply' });
        }
        if (prompt.includes('Approve this checkpoint?')) {
          return JSON.stringify({ guard: 'needsBossReply' });
        }
        return JSON.stringify({ guard: 'committed' });
      },
      callPlaybook: async () => ({
        state: 'suspended',
        childSessionId: 'review-child',
      }),
      emitStatus: async (message) => {
        statuses.push(message);
      },
    });
    const runtime = createLinkedPlaybookRuntime({
      configuredOptions: {},
      hostCapabilities: harness.hostCapabilities,
    });
    return {
      harness,
      playerSessions,
      playerCalls,
      statuses,
      runtime,
      counts: () => ({ coderCalls, reviewerCalls, judgeCalls }),
      init: () =>
        runtime.init({ ...replaySession(ports), playerSessions }),
      restore: (snapshot: PlaybookRuntimeSnapshot) =>
        runtime.restore?.(
          { ...replaySession(ports), playerSessions },
          snapshot,
        ),
    };
  }

  it('binds one cumulative operation and uses only its saved continuation', async () => {
    const fixture = stagedFixture();
    await fixture.init();

    await expect(
      fixture.runtime.handleBossInput({
        text: 'Choose the durable design.',
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply' },
    });
    const firstLedger = fixture.harness.readEffectLedger();
    const operationId = firstLedger.logicalOperations[0]?.operationId;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstLedger.logicalOperations[0]).toMatchObject({
      originalBaseline: REPLAY_BASELINE,
      pendingQuestion: { question: 'Approve this checkpoint?' },
      playerContinuation: 'coder-token-2',
    });
    expect(fixture.statuses).toContain(
      'coder asks: Approve this checkpoint?',
    );

    const callsBeforeInvalid = fixture.playerCalls.length;
    const ledgerBeforeInvalid = JSON.stringify(firstLedger);
    await expect(
      fixture.runtime.handleBossInput({
        text: 'Not an answer',
        signal: signal(),
      }),
    ).resolves.toMatchObject({ outcome: 'no-action' });
    expect(fixture.playerCalls).toHaveLength(callsBeforeInvalid);
    expect(JSON.stringify(fixture.harness.readEffectLedger())).toBe(
      ledgerBeforeInvalid,
    );

    // The durable binding, not a later store read, selects the continuation.
    fixture.playerSessions.update('coder', 'foreign-token');
    await expect(
      fixture.runtime.handleBossInput({
        text: 'Yes, continue.',
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply' },
    });
    expect(fixture.playerCalls.at(-1)?.options.resume).toBe('coder-token-2');
    const repeated = fixture.harness.readEffectLedger();
    expect(repeated.logicalOperations[0]).toMatchObject({
      operationId,
      originalBaseline: REPLAY_BASELINE,
      pendingQuestion: { question: 'Approve the second checkpoint?' },
      playerContinuation: 'coder-token-3',
    });
    expect(repeated.logicalOperations[0]?.boundaryIds).toHaveLength(2);

    await expect(
      fixture.runtime.handleBossInput({
        text: 'Yes, finish.',
        signal: signal(),
      }),
    ).resolves.toMatchObject({ outcome: 'suspended' });
    expect(fixture.playerCalls.at(-1)?.options.resume).toBe('coder-token-3');
    const finalLedger = fixture.harness.readEffectLedger();
    expect(finalLedger.logicalOperations[0]).toMatchObject({
      operationId,
      logicalReceipt: {
        classification: 'one-descendant-commit',
        baseline: REPLAY_BASELINE,
      },
    });
    expect(finalLedger.logicalOperations[0]?.boundaryIds).toHaveLength(3);
    expect(
      fixture.harness.calls
        .filter(({ mode }) => mode === 'continue')
        .map(({ operationId: id }) => id),
    ).toEqual([operationId, operationId]);

    await fixture.runtime.dispose();
  });

  it('publishes no advanced question state when a durable completion rejects', async () => {
    const bindFailure = stagedFixture();
    bindFailure.harness.failNextBindCompletion();
    await bindFailure.init();
    await expect(
      bindFailure.runtime.handleBossInput({
        text: 'Choose the durable design.',
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(bindFailure.statuses).not.toContain(
      'coder asks: Approve this checkpoint?',
    );
    expect(
      bindFailure.runtime.exportSnapshot?.()?.pendingBossQuestions,
    ).toEqual([]);
    await bindFailure.runtime.dispose();

    const continuationFailure = stagedFixture();
    await continuationFailure.init();
    await continuationFailure.runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: signal(),
    });
    const statusesBeforeContinuation = continuationFailure.statuses.length;
    continuationFailure.harness.failNextContinuationCompletion();
    await expect(
      continuationFailure.runtime.handleBossInput({
        text: 'Yes, continue.',
        signal: signal(),
      }),
    ).rejects.toThrow('injected deferred continuation completion failure');
    expect(
      continuationFailure.runtime.exportSnapshot?.()?.state,
    ).toMatchObject({ stateId: 'awaitBossReply' });
    expect(
      continuationFailure.runtime.exportSnapshot?.()?.pendingBossQuestions,
    ).toMatchObject([
      {
        questionId: 'commitCoderProposal',
        question: 'Approve this checkpoint?',
      },
    ]);
    expect(
      continuationFailure.statuses.slice(statusesBeforeContinuation),
    ).not.toContain('coder asks: Approve the second checkpoint?');
    await continuationFailure.runtime.dispose();
  });

  it('parks mismatches and exits, then restores only the exact saved wait', async () => {
    const fixture = stagedFixture();
    await fixture.init();
    await fixture.runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: signal(),
    });
    const callsAtWait = fixture.playerCalls.length;
    fixture.harness.setCheckpointMatches(false);

    await expect(
      fixture.runtime.handleBossInput({
        text: 'Yes, continue.',
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      outcome: 'no-action',
      state: { stateId: 'awaitBossReply' },
    });
    expect(fixture.playerCalls).toHaveLength(callsAtWait);
    expect(fixture.runtime.exportSnapshot?.()?.pendingBossQuestions).toEqual(
      [],
    );
    expect(
      fixture.harness.readEffectLedger().logicalOperations[0],
    ).toMatchObject({
      checkpointRestorationEligible: true,
      pendingQuestion: { question: 'Approve this checkpoint?' },
      playerContinuation: 'coder-token-2',
    });

    const parkedSnapshot = fixture.runtime.exportSnapshot?.();
    expect(parkedSnapshot).toBeDefined();
    await fixture.runtime.dispose();

    const restoredFixture = stagedFixture(fixture.harness);
    await restoredFixture.restore(parkedSnapshot!);
    const beforeRestore = restoredFixture.counts();
    await expect(
      restoredFixture.runtime.apply?.({
        actionId: 'reconcile:unresolved-effect',
        key: 'restore-deferred-checkpoint',
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      disposition: 'executed',
      run: {
        outcome: 'quiescent',
        state: { stateId: 'awaitBossReply' },
      },
    });
    expect(restoredFixture.counts()).toEqual(beforeRestore);
    expect(
      restoredFixture.runtime.exportSnapshot?.()?.pendingBossQuestions,
    ).toMatchObject([
      {
        questionId: 'commitCoderProposal',
        question: 'Approve this checkpoint?',
      },
    ]);

    await restoredFixture.runtime.handleBossInput({
      text: 'Take a new direction',
      signal: signal(),
    });
    expect(restoredFixture.playerCalls).toHaveLength(0);
    const parked = fixture.harness.readEffectLedger().logicalOperations[0];
    expect(parked).not.toHaveProperty('pendingQuestion');
    expect(parked).not.toHaveProperty('playerContinuation');
    expect(parked).not.toHaveProperty('checkpoint');
    expect(
      restoredFixture.runtime.exportSnapshot?.()?.pendingBossQuestions,
    ).toEqual([]);

    await restoredFixture.runtime.dispose();
  });
});

describe('DECIDE suspended REVIEW persistence', () => {
  it('restores one suspended REVIEW without replay and resumes its original trace once', async () => {
    const {
      runtime: source,
      request,
      telemetry: sourceTelemetry,
      host,
    } = await runToReview();
    const snapshot = source.exportSnapshot?.();
    if (
      snapshot?.schemaVersion !== 4 ||
      snapshot.suspendedCall === undefined
    ) {
      throw new Error('DECIDE did not export its suspended REVIEW call');
    }
    expect(snapshot.suspendedCall).toEqual({
      ...request,
      stateId: 'reviewCommit',
      childSessionId: 'review-child',
      turnId: 1,
    });
    expect(snapshot.state).toMatchObject({
      stateId: 'reviewCommit',
      status: 'active',
      quiescent: true,
      tags: expect.arrayContaining(['playbook.suspended']),
    });

    const roundTripped = JSON.parse(
      JSON.stringify(snapshot),
    ) as PlaybookRuntimeSnapshot;
    const nestedRequests: PlaybookCallRequest[] = [];
    const restoredStatuses: string[] = [];
    const restoredTelemetry: TelemetryRecord[] = [];
    const restored = createPlaybookRuntime({}, host);
    const restoredPorts = completePorts({
      callPlaybook: async (nestedRequest) => {
        nestedRequests.push(nestedRequest);
        throw new Error('restore must not restart REVIEW');
      },
      emitStatus: async (message) => {
        restoredStatuses.push(message);
      },
      emitTelemetry: async (record) => {
        restoredTelemetry.push(record);
      },
    });
    if (!restored.restore) throw new Error('DECIDE restore is unavailable');
    await restored.restore(session(restoredPorts), roundTripped);

    expect(nestedRequests).toEqual([]);
    expect(restoredStatuses).toEqual([]);
    expect(restoredTelemetry).toEqual([]);
    const restoredSnapshot = restored.exportSnapshot?.();
    expect(restoredSnapshot?.schemaVersion).toBe(4);
    expect(restoredSnapshot?.suspendedCall).toEqual(snapshot.suspendedCall);
    expect(restoredSnapshot?.state).toEqual(snapshot.state);

    const childResult = {
      status: 'ok',
      playbookId: 'review',
      childSessionId: 'review-child',
      output: {
        approvedCommit: 'latest',
        noUnsettledFindings: true,
      },
    } satisfies PlaybookCallResult;
    await expect(
      restored.resumePlaybookCall({
        callId: request.callId,
        result: childResult,
        signal: signal(),
      }),
    ).resolves.toMatchObject({ outcome: 'terminal' });

    const sourceStarts = playbookTraces(sourceTelemetry).filter(
      ({ type }) => type === 'playbook.call.started',
    );
    const restoredTraces = playbookTraces(restoredTelemetry);
    const restoredStarts = restoredTraces.filter(
      ({ type }) => type === 'playbook.call.started',
    );
    const restoredFinishes = restoredTraces.filter(
      ({ type }) => type === 'playbook.call.finished',
    );
    expect(sourceStarts).toHaveLength(1);
    expect(restoredStarts).toHaveLength(0);
    expect(restoredFinishes).toHaveLength(1);
    expect(sourceStarts[0]).toMatchObject({
      callId: request.callId,
      turnId: 1,
      payload: {
        stateId: 'reviewCommit',
        playbookId: 'review',
        text: request.text,
      },
    });
    expect(restoredFinishes[0]).toMatchObject({
      callId: request.callId,
      turnId: 1,
      payload: {
        stateId: 'reviewCommit',
        playbookId: 'review',
        text: request.text,
        result: childResult,
      },
    });
    expect(restoredFinishes[0].sequence).toBeGreaterThan(
      sourceStarts[0].sequence,
    );
    expect(
      restoredTraces.some(
        ({ type, sequence }) =>
          type === 'fsm.transition' &&
          sequence > restoredFinishes[0].sequence,
      ),
    ).toBe(true);

    await expect(
      restored.resumePlaybookCall({
        callId: request.callId,
        result: childResult,
        signal: signal(),
      }),
    ).rejects.toThrow(`unknown or stale playbook call id ${request.callId}`);
    await restored.dispose();
    await source.dispose();
  });

  it.each([
    [
      'descriptor disagrees with the restored invoke input',
      (snapshot: PlaybookRuntimeSnapshot): PlaybookRuntimeSnapshot => {
        if (
          snapshot.schemaVersion !== 4 ||
          snapshot.suspendedCall === undefined
        ) {
          throw new Error('expected a suspended schema-4 snapshot');
        }
        return {
          ...snapshot,
          suspendedCall: {
            ...snapshot.suspendedCall,
            text: `${snapshot.suspendedCall.text} (forged)`,
          },
        };
      },
      /text does not match its persisted input/,
    ],
    [
      'public state disagrees with the restored actor',
      (snapshot: PlaybookRuntimeSnapshot): PlaybookRuntimeSnapshot => ({
        ...snapshot,
        state: { ...snapshot.state, value: 'forgedReviewCommit' },
      }),
      /restored actor state does not match snapshot state/,
    ],
    [
      'effect ledger differs from the current host mirror',
      (snapshot: PlaybookRuntimeSnapshot): PlaybookRuntimeSnapshot => ({
        ...snapshot,
        effectLedger: { ...snapshot.effectLedger, revision: 1 },
      }),
      /must equal the current host mirror/,
    ],
  ] as const)(
    'rolls back a failed restore when the %s',
    async (_label, mutate, expectedError) => {
      const { runtime: source, host } = await runToReview();
      const snapshot = source.exportSnapshot?.();
      if (!snapshot) throw new Error('DECIDE did not export a snapshot');
      const invalidSnapshot = mutate(
        JSON.parse(JSON.stringify(snapshot)) as PlaybookRuntimeSnapshot,
      );
      const nestedRequests: PlaybookCallRequest[] = [];
      const statuses: string[] = [];
      const telemetry: TelemetryRecord[] = [];
      const playerSessions = createPlayerSessionStore();
      playerSessions.update('coder', 'keep-me');
      const restored = createPlaybookRuntime({}, host);
      const restoredPorts = completePorts({
        callPlaybook: async (request) => {
          nestedRequests.push(request);
          throw new Error('failed restore must not restart REVIEW');
        },
        emitStatus: async (message) => {
          statuses.push(message);
        },
        emitTelemetry: async (record) => {
          telemetry.push(record);
        },
      });
      if (!restored.restore) throw new Error('DECIDE restore is unavailable');

      await expect(
        restored.restore(
          session(restoredPorts, playerSessions),
          invalidSnapshot,
        ),
      ).rejects.toThrow(expectedError);
      expect(nestedRequests).toEqual([]);
      expect(statuses).toEqual([]);
      expect(telemetry).toEqual([]);
      expect(Object.fromEntries(playerSessions.tokens)).toEqual({
        coder: 'keep-me',
      });

      await restored.dispose();
      await source.dispose();
    },
  );

  it.each([1, 2, 3])(
    'rejects legacy schema-%i snapshots without invoking a child',
    async (schemaVersion) => {
      const source = createPlaybookRuntime({});
      await source.init(session(completePorts({})));
      const snapshot = source.exportSnapshot?.();
      if (!snapshot) throw new Error('DECIDE did not export a snapshot');
      const legacySnapshot = {
        ...snapshot,
        schemaVersion,
      } as unknown as PlaybookRuntimeSnapshot;
      const nestedRequests: PlaybookCallRequest[] = [];
      const statuses: string[] = [];
      const telemetry: TelemetryRecord[] = [];
      const restored = createPlaybookRuntime({});
      const restoredPorts = completePorts({
        callPlaybook: async (request) => {
          nestedRequests.push(request);
          throw new Error('legacy restore must not call a child');
        },
        emitStatus: async (message) => {
          statuses.push(message);
        },
        emitTelemetry: async (record) => {
          telemetry.push(record);
        },
      });
      if (!restored.restore) throw new Error('DECIDE restore is unavailable');
      await expect(
        restored.restore(session(restoredPorts), legacySnapshot),
      ).rejects.toThrow(
        `schemaVersion ${schemaVersion} is not supported (expected 4)`,
      );

      expect(nestedRequests).toEqual([]);
      expect(statuses).toEqual([]);
      expect(telemetry).toEqual([]);
      expect(restored.exportSnapshot?.()).toBeUndefined();

      await restored.dispose();
      await source.dispose();
    },
  );
});

describe('DECIDE local-role continuation', () => {
  it.each(['aborted', 'error'] as const)(
    'preserves a prior token when a resolved %s result omits one',
    async (status) => {
      const playerSessions = createPlayerSessionStore();
      playerSessions.update('coder', 'coder-prior');
      const runtime = createPlaybookRuntime({});
      await runtime.init(
        session(
          completePorts({
            callPlayer: async (roleId) =>
              roleId === 'coder'
                ? {
                    status,
                    ...(status === 'error' ? { error: 'failed' } : {}),
                  }
                : {
                    status: 'ok',
                    finalText: 'Reviewer proposal',
                  },
            callJudge: async (prompt) => judgeReply(prompt),
          }),
          playerSessions,
        ),
      );

      await expect(
        runtime.handleBossInput({ text: 'Compare designs.', signal: signal() }),
      ).resolves.toMatchObject({ outcome: 'failed' });
      expect(playerSessions.tokens.get('coder')).toBe('coder-prior');

      await runtime.dispose();
    },
  );

  it('clears a prior token only for a validated ok result that omits one', async () => {
    const playerSessions = createPlayerSessionStore();
    playerSessions.update('coder', 'coder-prior');
    const runtime = createPlaybookRuntime({});
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId) =>
            roleId === 'coder'
              ? { status: 'ok', finalText: 'Coder proposal' }
              : {
                  status: 'ok',
                  resumeToken: 'reviewer-next',
                  finalText: 'Need reviewer clarification',
                },
          callJudge: async (prompt) =>
            prompt.includes('source item DECIDE-1')
              ? JSON.stringify({ guard: 'proposed' })
              : JSON.stringify({ guard: 'needsBossReply' }),
        }),
        playerSessions,
      ),
    );

    await expect(
      runtime.handleBossInput({ text: 'Compare designs.', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'quiescent' });
    expect(Object.fromEntries(playerSessions.tokens)).toEqual({
      reviewer: 'reviewer-next',
    });

    await runtime.dispose();
  });
});

describe('DECIDE terminal settlement from REVIEW', () => {
  it('accepts only REVIEW\'s exact approved-latest/no-findings output', async () => {
    const { runtime, request } = await runToReview();
    await expect(
      runtime.resumePlaybookCall({
        callId: request.callId,
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'review-child',
          output: {
            approvedCommit: 'latest',
            noUnsettledFindings: true,
          },
        },
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      outcome: 'terminal',
      stateDescription: 'DECIDE completed with an approved commit.',
      output: {
        approvedCommit: 'latest',
        noUnsettledFindings: true,
      },
    });
    await runtime.dispose();
  });

  it.each([
    [
      'abort',
      {
        status: 'aborted',
        playbookId: 'review',
        childSessionId: 'review-child',
      } satisfies PlaybookCallResult,
      'aborted',
    ],
    [
      'failure',
      {
        status: 'error',
        playbookId: 'review',
        childSessionId: 'review-child',
        error: { name: 'ReviewError', message: 'Review could not finish.' },
      } satisfies PlaybookCallResult,
      'error',
    ],
  ] as const)(
    'reports an authored REVIEW %s with the last DECIDE commit',
    async (_label, childResult, reviewStatus) => {
      const { runtime, request } = await runToReview();
      await expect(
        runtime.resumePlaybookCall({
          callId: request.callId,
          result: childResult,
          signal: signal(),
        }),
      ).resolves.toMatchObject({
        outcome: 'terminal',
        stateDescription:
          'DECIDE reports REVIEW’s failure and its last commit.',
        output: {
          lastDecideCommit: DEFAULT_COMMIT_OID,
          noUnsettledFindings: false,
          reviewStatus,
        },
      });
      await runtime.dispose();
    },
  );

  it('reports malformed REVIEW success as a terminal protocol failure', async () => {
    const { runtime, request } = await runToReview();
    const result = await runtime.resumePlaybookCall({
      callId: request.callId,
      result: {
        status: 'ok',
        playbookId: 'review',
        childSessionId: 'review-child',
        output: {
          approvedCommit: 'abc123',
          noUnsettledFindings: true,
        },
      },
      signal: signal(),
    });
    expect(result).toMatchObject({
      outcome: 'terminal',
      output: {
        lastDecideCommit: DEFAULT_COMMIT_OID,
        noUnsettledFindings: false,
        reviewStatus: 'error',
        error: { name: 'ReviewProtocolError' },
      },
    } satisfies Partial<PlaybookRunResult>);
    await runtime.dispose();
  });

  it('parks when the nested REVIEW call rejects outside its result contract', async () => {
    const transportError = new Error('REVIEW transport failed.');
    const { runtime, result, nestedRequests } = await startWithCommitOutput(
      'Committed proposal.',
      async () => {
        throw transportError;
      },
    );
    await expect(result).rejects.toBe(transportError);
    expect(nestedRequests).toHaveLength(1);
    expect(runtime.exportSnapshot?.()).toMatchObject({
      state: { stateId: 'failed', status: 'active', quiescent: true },
    });
    await runtime.dispose();
  });
});

describe('DECIDE abort classification', () => {
  // slc/link.md §Abort: cancellation is causal identity (Object.is) with the
  // applicable signal reason, never bare `signal.aborted`. A distinct player
  // failure observed while the turn signal is aborted remains a non-abort
  // control error that takes precedence over the coincident abort.
  it('refuses pre-aborted Boss text before classification or host work', async () => {
    const abortReason = new Error('Boss cancelled before delivery.');
    const controller = new AbortController();
    controller.abort(abortReason);
    const calls = { captain: 0, judge: 0, player: 0, playbook: 0 };
    const telemetry: TelemetryRecord[] = [];
    const runtime = createPlaybookRuntime({});
    await runtime.init(
      session(
        completePorts({
          callCaptain: async () => {
            calls.captain += 1;
            throw new Error('unexpected Captain call');
          },
          callJudge: async () => {
            calls.judge += 1;
            throw new Error('unexpected judge call');
          },
          callPlayer: async () => {
            calls.player += 1;
            throw new Error('unexpected player call');
          },
          callPlaybook: async () => {
            calls.playbook += 1;
            throw new Error('unexpected nested playbook call');
          },
          emitTelemetry: async (record) => telemetry.push(record),
        }),
      ),
    );
    const traceCountBefore = playbookTraces(telemetry).length;

    await expect(
      runtime.handleBossInput({
        text: 'Choose the durable design.',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'aborted',
      state: { stateId: 'ready' },
      error: { message: abortReason.message },
    });
    expect(calls).toEqual({ captain: 0, judge: 0, player: 0, playbook: 0 });
    expect(
      playbookTraces(telemetry)
        .slice(traceCountBefore)
        .map(({ type }) => type),
    ).toEqual(['boss.input.received', 'boss.input.settled']);

    await runtime.dispose();
  });

  it('holds the public-boundary sentinel through settlement delivery', async () => {
    const settlementEntered = deferred<void>();
    const releaseSettlement = deferred<void>();
    let blockSettlement = true;
    const runtime = createPlaybookRuntime({});
    await runtime.init(
      session(
        completePorts({
          emitTelemetry: async (record) => {
            if (record.topic !== 'playbook.trace') return;
            const trace = record.payload as PlaybookTraceEvent;
            if (trace.type !== 'boss.input.settled' || !blockSettlement) return;
            settlementEntered.resolve();
            await releaseSettlement.promise;
          },
        }),
      ),
    );

    const first = runtime.handleBossInput({ text: '   ', signal: signal() });
    await settlementEntered.promise;
    await expect(
      runtime.handleBossInput({ text: '', signal: signal() }),
    ).rejects.toThrow(/another runtime turn is active/);

    blockSettlement = false;
    releaseSettlement.resolve();
    await expect(first).resolves.toMatchObject({ outcome: 'no-action' });
    await expect(
      runtime.handleBossInput({ text: '', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'no-action' });

    await runtime.dispose();
  });

  it('keeps invocation cancellation applicable while a fresh resume settles', async () => {
    const invocation = new AbortController();
    const resume = new AbortController();
    const invocationReason = new Error('original invocation cancelled');
    let rejectFinish = false;
    const finishes: PlaybookTraceEvent[] = [];
    const { runtime, request } = await runToReview(
      (record) => {
        if (!rejectFinish || record.topic !== 'playbook.trace') return;
        const trace = record.payload as PlaybookTraceEvent;
        if (trace.type !== 'playbook.call.finished') return;
        finishes.push(trace);
        if (finishes.length === 1) {
          invocation.abort(invocationReason);
          throw invocationReason;
        }
      },
      invocation.signal,
    );
    rejectFinish = true;

    await expect(
      runtime.resumePlaybookCall({
        callId: request.callId,
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'review-child',
          output: {
            approvedCommit: 'latest',
            noUnsettledFindings: true,
          },
        },
        signal: resume.signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'aborted',
      error: { message: invocationReason.message },
    });
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      payload: { result: { status: 'ok' } },
    });

    rejectFinish = false;
    await runtime.dispose();
  });

  it('does not forgive a stored distinct failure under a later resume abort', async () => {
    const deliveryFailure = new Error('pending observer failed');
    const { runtime, request } = await runToReview();
    const bridge = (
      runtime as unknown as {
        _getNestedBridge(): {
          subscribePendingCall(
            listener: (pending: unknown) => void,
          ): () => void;
        };
      }
    )._getNestedBridge();
    const unsubscribe = bridge.subscribePendingCall(() => {
      throw deliveryFailure;
    });
    unsubscribe();

    const later = new AbortController();
    later.abort(deliveryFailure);
    await expect(
      runtime.resumePlaybookCall({
        callId: request.callId,
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'review-child',
          output: {
            approvedCommit: 'latest',
            noUnsettledFindings: true,
          },
        },
        signal: later.signal,
      }),
    ).rejects.toBe(deliveryFailure);
    await runtime.dispose();
  });

  it('does not forgive a stored distinct failure under a later abort', async () => {
    const invocation = new AbortController();
    const invocationReason = new Error('suspended invocation cancelled');
    const deliveryFailure = new Error('background delivery failed');
    const transitionRejected = deferred<void>();
    let rejectTransition = false;
    const { runtime } = await runToReview(
      (record) => {
        if (!rejectTransition || record.topic !== 'playbook.trace') return;
        const trace = record.payload as PlaybookTraceEvent;
        if (trace.type !== 'fsm.transition') return;
        rejectTransition = false;
        transitionRejected.resolve();
        throw deliveryFailure;
      },
      invocation.signal,
    );

    rejectTransition = true;
    invocation.abort(invocationReason);
    await transitionRejected.promise;
    await new Promise((tick) => setTimeout(tick, 0));

    const later = new AbortController();
    later.abort(deliveryFailure);
    await expect(
      runtime.handleBossInput({ text: '', signal: later.signal }),
    ).rejects.toBe(deliveryFailure);
    await runtime.dispose();
  });

  it('does not carry a background invocation cancellation into the next turn', async () => {
    const invocation = new AbortController();
    const invocationReason = new Error('suspended invocation cancelled');
    const transitionRejected = deferred<void>();
    let rejectTransition = false;
    const { runtime } = await runToReview(
      (record) => {
        if (!rejectTransition || record.topic !== 'playbook.trace') return;
        const trace = record.payload as PlaybookTraceEvent;
        if (trace.type !== 'fsm.transition') return;
        rejectTransition = false;
        transitionRejected.resolve();
        throw invocationReason;
      },
      invocation.signal,
    );

    rejectTransition = true;
    invocation.abort(invocationReason);
    await transitionRejected.promise;
    // Let the serialized background emission observe its rejection before
    // the unrelated boundary drains the lane.
    await new Promise((tick) => setTimeout(tick, 0));

    await expect(
      runtime.handleBossInput({ text: '', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'no-action' });
    await runtime.dispose();
  });

  it('forgives a parallel sibling finish rejection owned only by its invocation signal', async () => {
    const coderResult = deferred<PlayerResult>();
    let reviewerSignal: AbortSignal | undefined;
    let reviewerFinishRejected = false;
    const playerCalls: string[] = [];
    const host = createTestEffectHost();
    const runtime = createPlaybookRuntime({}, host);
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId, _prompt, invocationSignal) => {
            playerCalls.push(roleId);
            if (roleId === 'coder') return coderResult.promise;
            reviewerSignal = invocationSignal;
            return await new Promise<PlayerResult>((_resolve, reject) => {
              invocationSignal.addEventListener(
                'abort',
                () => reject(invocationSignal.reason),
                { once: true },
              );
            });
          },
          emitTelemetry: async (record) => {
            if (record.topic !== 'playbook.trace') return;
            const trace = record.payload as PlaybookTraceEvent;
            const payload = trace.payload as {
              roleId?: string;
              status?: string;
            };
            if (
              trace.type === 'player.call.finished' &&
              payload.roleId === 'reviewer' &&
              payload.status === 'aborted'
            ) {
              reviewerFinishRejected = true;
              throw reviewerSignal!.reason;
            }
          },
        }),
      ),
    );

    const running = runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: signal(),
    });
    await vi.waitFor(() => expect(playerCalls).toHaveLength(2));
    coderResult.resolve({
      status: 'error',
      error: 'coder proposal failed',
    });

    await expect(running).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(reviewerSignal?.aborted).toBe(true);
    expect(reviewerFinishRejected).toBe(true);
    expect(host.readEffectLedger().boundaries).toHaveLength(2);
    for (const boundary of host.readEffectLedger().boundaries) {
      expect(boundary).not.toHaveProperty('finalText');
      expect(boundary.physicalReceipt?.classification).toBe('unchanged');
    }
    await runtime.dispose();
  });

  it('reports a distinct post-abort player rejection as an error, not an abort', async () => {
    const abortReason = new Error('Boss cancelled the turn.');
    const distinctFailure = new Error('player transport failed after abort');
    const telemetry: TelemetryRecord[] = [];
    const playerCalls: string[] = [];
    let rejectCoder!: (error: unknown) => void;
    const ports = completePorts({
      callPlayer: (roleId, _prompt, invocationSignal) => {
        playerCalls.push(roleId);
        if (roleId === 'coder') {
          return new Promise<never>((_resolve, reject) => {
            rejectCoder = reject;
          });
        }
        return new Promise<{ status: 'aborted' }>((resolve) => {
          invocationSignal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        });
      },
      emitTelemetry: async (record) => {
        telemetry.push(record);
      },
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));
    const controller = new AbortController();
    const running = runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(playerCalls).toHaveLength(2);
    });

    controller.abort(abortReason);
    rejectCoder(distinctFailure);

    await expect(running).rejects.toBe(distinctFailure);
    const finishes = playbookTraces(telemetry).filter(
      ({ type }) => type === 'player.call.finished',
    );
    const coderFinish = finishes.find(
      ({ payload }) => (payload as Record<string, unknown>).roleId === 'coder',
    );
    expect(coderFinish?.payload).toMatchObject({
      status: 'error',
      error: { message: distinctFailure.message },
    });
    // The sibling that rejected with the exact reason stays an abort.
    const reviewerFinish = finishes.find(
      ({ payload }) =>
        (payload as Record<string, unknown>).roleId === 'reviewer',
    );
    expect(reviewerFinish?.payload).toMatchObject({ status: 'aborted' });

    await runtime.dispose();
  });

  // slc/link.md §Abort: a rejection that IS the exact signal reason settles
  // as an ordinary abort — a cancellation-aware trace sink rejecting with
  // the abort reason itself must not recast the aborted turn as a failure
  // or reject the public boundary with that reason.
  it('settles aborted when a trace sink rejects with exactly the abort reason', async () => {
    const abortReason = new Error('Boss cancelled the turn.');
    const controller = new AbortController();
    let sinkRejects = false;
    const playerCalls: string[] = [];
    const ports = completePorts({
      callPlayer: (roleId, _prompt, invocationSignal) => {
        playerCalls.push(roleId);
        return new Promise<{ status: 'aborted' }>((resolve) => {
          invocationSignal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        });
      },
      emitTelemetry: async () => {
        if (sinkRejects) throw abortReason;
      },
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));
    const running = runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(playerCalls).toHaveLength(2);
    });

    controller.abort(abortReason);
    sinkRejects = true;

    await expect(running).resolves.toMatchObject({
      outcome: 'aborted',
      error: { message: abortReason.message },
    });

    sinkRejects = false;
    await runtime.dispose();
  });

  // DR-036 §4: a started-trace sink rejection causally identical to the
  // boundary reason is the abort's own evidence — the turn settles aborted
  // and the pair's best-effort finish records status 'aborted', never a
  // lying 'error'.
  it('finishes the started pair aborted when its sink aborts with the rethrown reason', async () => {
    const abortReason = new Error('Boss cancelled the turn.');
    const controller = new AbortController();
    const telemetry: TelemetryRecord[] = [];
    let abortedStartCallId: string | undefined;
    const ports = completePorts({
      callPlayer: (_roleId, _prompt, invocationSignal) =>
        new Promise<{ status: 'aborted' }>((resolve) => {
          invocationSignal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        }),
      emitTelemetry: async (record) => {
        telemetry.push(record);
        if (record.topic !== 'playbook.trace') return;
        const trace = record.payload as PlaybookTraceEvent;
        if (
          trace.type === 'player.call.started' &&
          abortedStartCallId === undefined
        ) {
          abortedStartCallId = trace.callId;
          controller.abort(abortReason);
          throw abortReason;
        }
      },
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));
    await expect(
      runtime.handleBossInput({
        text: 'Choose the durable design.',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'aborted',
      error: { message: abortReason.message },
    });
    expect(abortedStartCallId).toBeDefined();
    const pairFinish = playbookTraces(telemetry).find(
      (trace) =>
        trace.type === 'player.call.finished' &&
        trace.callId === abortedStartCallId,
    );
    expect(pairFinish?.payload).toMatchObject({
      status: 'aborted',
      error: { message: abortReason.message },
    });
    await runtime.dispose();
  });

  // DR-036 §3: terminal completion outranks a coincident abort. A sink that
  // aborts the resume with its own rethrown reason while handling the final
  // done transition must neither hide the completed machine behind an
  // aborted settlement nor reject the boundary with the abort's evidence.
  it('settles terminal when the done-transition sink aborts with the rethrown reason', async () => {
    const abortReason = new Error('Boss cancelled during settlement.');
    const controller = new AbortController();
    let doneSinkTriggered = false;
    const { runtime, request } = await runToReview((record) => {
      if (doneSinkTriggered || record.topic !== 'playbook.trace') return;
      const trace = record.payload as PlaybookTraceEvent;
      const payload = trace.payload as { state?: { status?: string } };
      if (
        trace.type === 'fsm.transition' &&
        payload.state?.status === 'done'
      ) {
        doneSinkTriggered = true;
        controller.abort(abortReason);
        throw abortReason;
      }
    });
    await expect(
      runtime.resumePlaybookCall({
        callId: request.callId,
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'review-child',
          output: {
            approvedCommit: 'latest',
            noUnsettledFindings: true,
          },
        },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'terminal',
      output: {
        approvedCommit: 'latest',
        noUnsettledFindings: true,
      },
    });
    expect(doneSinkTriggered).toBe(true);
    await runtime.dispose();
  });
});

describe('DECIDE unresolved apply settlement', () => {
  async function unresolvedApplyFixture(
    onTelemetry?: (record: TelemetryRecord) => void | Promise<void>,
  ) {
    const telemetry: TelemetryRecord[] = [];
    const host = createTestEffectHost({
      cohortClassifications: ['concurrent-or-foreign-change'],
    });
    const runtime = createPlaybookRuntime({}, host);
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId) => ({
            status: 'ok',
            finalText:
              roleId === 'coder' ? 'Coder proposal' : 'Reviewer proposal',
          }),
          callJudge: async (prompt) => judgeReply(prompt),
          emitTelemetry: async (record) => {
            telemetry.push(record);
            await onTelemetry?.(record);
          },
        }),
      ),
    );
    await expect(
      runtime.handleBossInput({
        text: 'Choose the durable design.',
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
      'reconcile:unresolved-effect',
      'abandon:unresolved-effect',
    ]);
    return { runtime, telemetry };
  }

  it.each([
    ['a rejected start sink', false, 'error'],
    ['an abort while the start sink drains', true, 'aborted'],
  ] as const)(
    'finishes %s before acceptance and leaves its key reusable',
    async (_label, abortAtStart, expectedStatus) => {
      const controller = new AbortController();
      const failure = new Error(
        abortAtStart ? 'apply cancelled during start' : 'apply start sink failed',
      );
      let armed = false;
      const { runtime, telemetry } = await unresolvedApplyFixture(
        async (record) => {
          if (!armed || record.topic !== 'playbook.trace') return;
          const trace = record.payload as PlaybookTraceEvent;
          if (trace.type !== 'apply.started') return;
          armed = false;
          if (abortAtStart) controller.abort(failure);
          else throw failure;
        },
      );
      armed = true;

      await expect(
        runtime.apply!({
          actionId: 'reconcile:unresolved-effect',
          key: 'pre-acceptance',
          signal: controller.signal,
        }),
      ).rejects.toBe(failure);

      const pair = playbookTraces(telemetry).filter(
        ({ type }) => type === 'apply.started' || type === 'apply.finished',
      );
      expect(pair.map(({ type, callId }) => ({ type, callId }))).toEqual([
        { type: 'apply.started', callId: 'apply-1' },
        { type: 'apply.finished', callId: 'apply-1' },
      ]);
      expect(pair[1]?.payload).toMatchObject({
        actionId: 'reconcile:unresolved-effect',
        key: 'pre-acceptance',
        disposition: 'rejected',
        reason: abortAtStart
          ? 'aborted before acceptance'
          : 'apply.started trace sink rejected',
        status: expectedStatus,
        error: { message: failure.message },
      });
      expect(pair[1]?.payload).not.toHaveProperty('stateId');

      await expect(
        runtime.apply!({
          actionId: 'reconcile:unresolved-effect',
          key: 'pre-acceptance',
          signal: signal(),
        }),
      ).resolves.toMatchObject({ disposition: 'executed' });
      await runtime.dispose();
    },
  );

  it.each([
    ['drops the exact apply abort reason', true],
    ['re-latches a distinct delivery failure', false],
  ] as const)(
    '%s after receipt publication',
    async (_label, identical) => {
      const controller = new AbortController();
      const abortReason = new Error('apply cancelled after publication');
      const deliveryFailure = identical
        ? abortReason
        : new Error('apply finish sink failed');
      let armed = false;
      const { runtime } = await unresolvedApplyFixture(async (record) => {
        if (!armed || record.topic !== 'playbook.trace') return;
        const trace = record.payload as PlaybookTraceEvent;
        if (trace.type !== 'apply.finished') return;
        armed = false;
        controller.abort(abortReason);
        throw deliveryFailure;
      });
      armed = true;

      await expect(
        runtime.apply!({
          actionId: 'reconcile:unresolved-effect',
          key: 'published-receipt',
          signal: controller.signal,
        }),
      ).resolves.toMatchObject({ disposition: 'executed' });

      const nextTurn = runtime.handleBossInput({ text: '', signal: signal() });
      if (identical) {
        await expect(nextTurn).resolves.toMatchObject({ outcome: 'no-action' });
      } else {
        await expect(nextTurn).rejects.toBe(deliveryFailure);
      }
      await runtime.dispose();
    },
  );
});
