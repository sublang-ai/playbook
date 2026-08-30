// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { assign, createMachine } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type {
  PlaybookEffectLedger,
  PlaybookPorts,
  PlaybookRepositoryObservation,
  PlaybookRepositoryReceipt,
  PlaybookRoleBinding,
  PlaybookSession,
  PlayerResult,
  PlayerSessionStore,
} from './runtime.js';
import {
  adjudicatePlayerOutput,
  assertPlaybookEffectLedger,
  createXStatePlaybookRuntime,
  emptyPlaybookEffectLedger,
  RUNTIME_ABI,
  SUPPORTED_ARTIFACT_SCHEMAS,
  type XStateOutcomeAuthoritySpec,
  type XStatePlaybookRuntimeSpec,
  type XStatePlaybookRuntimeSpecV3,
} from './xstate-runtime.js';

const EFFECT_OBSERVATION = Object.freeze({
  worktree: '/repo',
  gitDir: '/repo/.git',
  head: '1'.repeat(40),
  projection: Object.freeze({}),
  projectionDigest:
    'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
});

const EFFECT_CHANGED_OBSERVATION = Object.freeze({
  ...EFFECT_OBSERVATION,
  projection: Object.freeze({
    'changed.txt': Object.freeze({ mode: '100644', content: 'changed' }),
  }),
  projectionDigest:
    'sha256:4b797d2a72bd825a64e65ec546734edc020fc9070965c5eb3678943ddcfd1b25',
});

function emptyLedgerHostCapabilities(
  options: {
    readonly classifications?: readonly PlaybookRepositoryReceipt['classification'][];
    readonly attemptId?: string;
    readonly initialLedger?: PlaybookEffectLedger;
    readonly startAcknowledgement?: Promise<void>;
    readonly completionAcknowledgement?: Promise<void>;
    readonly finalWriteAcknowledgement?: Promise<void>;
    readonly failCompletionAt?: readonly number[];
    readonly failAfterCompletionAt?: readonly number[];
  } = {},
) {
  let ledger = options.initialLedger ?? emptyPlaybookEffectLedger();
  let observation: PlaybookRepositoryObservation = EFFECT_OBSERVATION;
  let callIndex = 0;
  const attemptId =
    options.attemptId ?? '20000000-0000-4000-8000-000000000001';
  const receiptFor = (
    classification: PlaybookRepositoryReceipt['classification'],
    baseline: PlaybookRepositoryObservation,
    currentCallIndex: number,
  ): PlaybookRepositoryReceipt => {
    const changedProjection = Object.freeze({
      'changed.txt': Object.freeze({
        mode: '100644',
        content: 'changed',
      }),
    });
    const changedProjectionObservation = Object.freeze({
      ...baseline,
      projection: changedProjection,
      projectionDigest:
        'sha256:4b797d2a72bd825a64e65ec546734edc020fc9070965c5eb3678943ddcfd1b25',
    });
    const changedHeadObservation = Object.freeze({
      ...baseline,
      head: (currentCallIndex + 2).toString(16).repeat(40).slice(0, 40),
      projection: Object.freeze({}),
      projectionDigest:
        'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    });
    switch (classification) {
      case 'unchanged':
        return { classification, baseline, after: baseline };
      case 'one-descendant-commit':
        return {
          classification,
          baseline,
          after: changedHeadObservation,
          commitOid: changedHeadObservation.head,
        };
      case 'multiple-commits':
      case 'rewritten-or-non-descendant':
        return { classification, baseline, after: changedHeadObservation };
      case 'worktree-only-change':
      case 'concurrent-or-foreign-change':
        return {
          classification,
          baseline,
          after: changedProjectionObservation,
        };
      case 'observation-ambiguous':
        return { classification, baseline };
    }
  };
  const completionFor = async (
    input: Record<string, unknown>,
    boundary: Record<string, unknown>,
    operation: Record<string, unknown>,
    receipt: PlaybookRepositoryReceipt,
  ) =>
    (input.completeEffectBoundary as (value: unknown) => Promise<{
      readonly finalText?: string;
      readonly semanticCandidate?: unknown;
      readonly deferred?: {
        readonly operationId: string;
        readonly pendingQuestion: unknown;
        readonly playerContinuation: unknown;
      };
      readonly unresolved?: true;
    }> | {
      readonly finalText?: string;
      readonly semanticCandidate?: unknown;
      readonly deferred?: {
        readonly operationId: string;
        readonly pendingQuestion: unknown;
        readonly playerContinuation: unknown;
      };
      readonly unresolved?: true;
    })({ boundary, operation, receipt });
  const completedBoundary = (
    started: Record<string, unknown>,
    receipt: PlaybookRepositoryReceipt,
    completion: {
      readonly finalText?: string;
      readonly semanticCandidate?: unknown;
    },
    logicalOperationId?: string,
  ) => ({
    ...started,
    ...(receipt.after === undefined ? {} : { after: receipt.after }),
    physicalReceipt: receipt,
    ...(completion.finalText === undefined
      ? {}
      : { finalText: completion.finalText }),
    ...(completion.semanticCandidate === undefined
      ? {}
      : { semanticCandidate: completion.semanticCandidate }),
    ...(logicalOperationId === undefined ? {} : { logicalOperationId }),
  });
  const updateObservation = (receipt: PlaybookRepositoryReceipt) => {
    if (receipt.after !== undefined) observation = receipt.after;
  };
  const runExclusive = vi.fn(async (input: Record<string, unknown>) => {
    const currentCallIndex = callIndex++;
    const baseline = observation;
    const seed = input.effectBoundary as Record<string, unknown>;
    const started = {
      sequence: ledger.boundaries.length + 1,
      ...seed,
      attemptId,
      attemptNumber: 1,
      playbookId: 'role-fixture',
      canonicalWorktree: { worktree: '/repo', gitDir: '/repo/.git' },
      baseline,
    };
    ledger = assertPlaybookEffectLedger({
      ...ledger,
      revision: ledger.revision + 1,
      boundaries: [...ledger.boundaries, started],
    });
    await options.startAcknowledgement;
    let operation:
      | { readonly status: 'fulfilled'; readonly value: unknown }
      | { readonly status: 'rejected'; readonly reason: unknown };
    try {
      operation = {
        status: 'fulfilled',
        value: await (input.operation as () => Promise<unknown>)(),
      };
    } catch (reason) {
      operation = { status: 'rejected', reason };
    }
    await options.completionAcknowledgement;
    if (options.failCompletionAt?.includes(currentCallIndex)) {
      throw new Error('effect boundary completion acknowledgement unavailable');
    }
    const classification = options.classifications?.[currentCallIndex] ?? 'unchanged';
    const receipt = receiptFor(classification, baseline, currentCallIndex);
    updateObservation(receipt);
    const completion = await completionFor(input, started, operation, receipt);
    await options.finalWriteAcknowledgement;
    if (options.failAfterCompletionAt?.includes(currentCallIndex)) {
      throw new Error('effect boundary final write acknowledgement unavailable');
    }
    const operationId = completion.deferred?.operationId;
    const eligible =
      completion.deferred !== undefined &&
      receipt.after !== undefined &&
      receipt.after.head === baseline.head &&
      (classification === 'unchanged' ||
        classification === 'worktree-only-change');
    const completed = completedBoundary(
      started,
      receipt,
      completion,
      operationId,
    );
    ledger = assertPlaybookEffectLedger({
      ...ledger,
      revision: ledger.revision + 1,
      boundaries: [...ledger.boundaries.slice(0, -1), completed],
      logicalOperations:
        completion.deferred === undefined
          ? ledger.logicalOperations
          : [
              ...ledger.logicalOperations,
              {
                sequence: ledger.logicalOperations.length + 1,
                operationId: operationId!,
                playbookId: 'role-fixture',
                runtimeSessionId: seed.runtimeSessionId,
                boundaryIds: [seed.boundaryId],
                originalBaseline: baseline,
                ...(eligible
                  ? {
                      checkpoint: receipt.after,
                      pendingQuestion: completion.deferred.pendingQuestion,
                      playerContinuation:
                        completion.deferred.playerContinuation,
                    }
                  : {}),
                checkpointRestorationEligible: false,
              },
            ],
    });
    return {
      operation,
      receipt,
      effectLedger: ledger,
      ...(completion.deferred === undefined
        ? {}
        : { deferredStatus: eligible ? 'bound' : 'unresolved' }),
    };
  });
  const runDeferred = vi.fn(async (input: Record<string, unknown>) => {
    const operationId = input.operationId as string;
    const logicalIndex = ledger.logicalOperations.findIndex(
      (operation) => operation.operationId === operationId,
    );
    const logical = ledger.logicalOperations[logicalIndex];
    if (logical === undefined || logical.logicalReceipt !== undefined) {
      throw new Error('deferred test operation is not open');
    }
    const hasBinding =
      logical.checkpoint !== undefined &&
      logical.pendingQuestion !== undefined &&
      Object.prototype.hasOwnProperty.call(logical, 'playerContinuation');
    if (input.mode === 'park') {
      if (hasBinding) {
        const next = {
          sequence: logical.sequence,
          operationId: logical.operationId,
          playbookId: logical.playbookId,
          runtimeSessionId: logical.runtimeSessionId,
          boundaryIds: logical.boundaryIds,
          originalBaseline: logical.originalBaseline,
          checkpointRestorationEligible: false,
        };
        ledger = assertPlaybookEffectLedger({
          ...ledger,
          revision: ledger.revision + 1,
          logicalOperations: ledger.logicalOperations.map((candidate, index) =>
            index === logicalIndex ? next : candidate,
          ),
        });
      }
      return { status: 'parked', effectLedger: ledger };
    }
    if (!hasBinding) return { status: 'ineligible', effectLedger: ledger };
    const checkpointExact = JSON.stringify(logical.checkpoint) === JSON.stringify(observation);
    if (input.mode === 'restore') {
      if (!logical.checkpointRestorationEligible) {
        return { status: 'ineligible', effectLedger: ledger };
      }
      if (!checkpointExact) {
        return { status: 'checkpoint-mismatch', effectLedger: ledger };
      }
      ledger = assertPlaybookEffectLedger({
        ...ledger,
        revision: ledger.revision + 1,
        logicalOperations: ledger.logicalOperations.map((candidate, index) =>
          index === logicalIndex
            ? { ...logical, checkpointRestorationEligible: false }
            : candidate,
        ),
      });
      return { status: 'restored', effectLedger: ledger };
    }
    if (logical.checkpointRestorationEligible) {
      return { status: 'ineligible', effectLedger: ledger };
    }
    if (!checkpointExact) {
      ledger = assertPlaybookEffectLedger({
        ...ledger,
        revision: ledger.revision + 1,
        logicalOperations: ledger.logicalOperations.map((candidate, index) =>
          index === logicalIndex
            ? { ...logical, checkpointRestorationEligible: true }
            : candidate,
        ),
      });
      return { status: 'checkpoint-mismatch', effectLedger: ledger };
    }
    const currentCallIndex = callIndex++;
    const seed = input.effectBoundary as Record<string, unknown>;
    const started = {
      sequence: ledger.boundaries.length + 1,
      ...seed,
      attemptId,
      attemptNumber: 1,
      playbookId: 'role-fixture',
      canonicalWorktree: { worktree: '/repo', gitDir: '/repo/.git' },
      baseline: observation,
      logicalOperationId: operationId,
    };
    const startingLogical = {
      sequence: logical.sequence,
      operationId: logical.operationId,
      playbookId: logical.playbookId,
      runtimeSessionId: logical.runtimeSessionId,
      boundaryIds: [...logical.boundaryIds, seed.boundaryId as string],
      originalBaseline: logical.originalBaseline,
      checkpointRestorationEligible: false,
    };
    ledger = assertPlaybookEffectLedger({
      ...ledger,
      revision: ledger.revision + 1,
      boundaries: [...ledger.boundaries, started],
      logicalOperations: ledger.logicalOperations.map((candidate, index) =>
        index === logicalIndex ? startingLogical : candidate,
      ),
    });
    let operation:
      | { readonly status: 'fulfilled'; readonly value: unknown }
      | { readonly status: 'rejected'; readonly reason: unknown };
    try {
      operation = {
        status: 'fulfilled',
        value: await (input.operation as (value: unknown) => Promise<unknown>)({
          baseline: observation,
          identity: { worktree: '/repo', gitDir: '/repo/.git' },
          playerContinuation: logical.playerContinuation,
        }),
      };
    } catch (reason) {
      operation = { status: 'rejected', reason };
    }
    const baseline = observation;
    const classification = options.classifications?.[currentCallIndex] ?? 'unchanged';
    const receipt = receiptFor(classification, baseline, currentCallIndex);
    updateObservation(receipt);
    const completion = await completionFor(input, started, operation, receipt);
    await options.finalWriteAcknowledgement;
    if (options.failAfterCompletionAt?.includes(currentCallIndex)) {
      throw new Error('deferred completion write acknowledgement unavailable');
    }
    const eligible =
      completion.deferred !== undefined &&
      receipt.after !== undefined &&
      receipt.after.head === logical.originalBaseline.head &&
      (classification === 'unchanged' ||
        classification === 'worktree-only-change');
    const completed = completedBoundary(started, receipt, completion, operationId);
    const logicalReceipt: PlaybookRepositoryReceipt = {
      classification,
      baseline: logical.originalBaseline,
      ...(receipt.after === undefined ? {} : { after: receipt.after }),
      ...(classification === 'one-descendant-commit' && receipt.commitOid
        ? { commitOid: receipt.commitOid }
        : {}),
    };
    const nextLogical =
      completion.deferred !== undefined && eligible
        ? {
            ...startingLogical,
            checkpoint: receipt.after,
            pendingQuestion: completion.deferred.pendingQuestion,
            playerContinuation: completion.deferred.playerContinuation,
            checkpointRestorationEligible: false,
          }
        : completion.deferred !== undefined || completion.unresolved === true
          ? startingLogical
          : { ...startingLogical, logicalReceipt };
    ledger = assertPlaybookEffectLedger({
      ...ledger,
      revision: ledger.revision + 1,
      boundaries: [...ledger.boundaries.slice(0, -1), completed],
      logicalOperations: ledger.logicalOperations.map((candidate, index) =>
        index === logicalIndex ? nextLogical : candidate,
      ),
    });
    return {
      status: 'continued',
      operation,
      receipt,
      effectLedger: ledger,
      ...(completion.deferred !== undefined || completion.unresolved === true
        ? {}
        : { logicalReceipt }),
      ...(completion.deferred === undefined
        ? {}
        : { deferredStatus: eligible ? 'bound' : 'unresolved' }),
    };
  });
  return {
    repository: { runExclusive, runDeferred },
    effectLedger: {
      snapshot: () => ledger,
      writeAhead: async () => ledger,
    },
    replaceEffectLedger(next: PlaybookEffectLedger) {
      ledger = assertPlaybookEffectLedger(next);
    },
    replaceObservation(next: PlaybookRepositoryObservation) {
      observation = next;
    },
  };
}

function oneBoundaryEffectLedger() {
  return assertPlaybookEffectLedger({
    schemaVersion: 1,
    revision: 1,
    boundaries: [
      {
        sequence: 1,
        boundaryId: '10000000-0000-4000-8000-000000000001',
        attemptId: '10000000-0000-4000-8000-000000000002',
        attemptNumber: 1,
        playbookId: 'role-fixture',
        runtimeSessionId: '10000000-0000-4000-8000-000000000003',
        turnId: 1,
        callId: 'player-1',
        roleId: 'coder',
        sourceStateId: 'work',
        sourceOutcomeSchema: { type: 'object' },
        dispositions: ['unchanged'],
        canonicalWorktree: { worktree: '/repo', gitDir: '/repo/.git' },
        baseline: EFFECT_OBSERVATION,
        correctionBudget: { limit: 1, spent: false },
      },
    ],
    logicalOperations: [],
  });
}

function ambiguousBoundaryEffectLedger() {
  const started = oneBoundaryEffectLedger();
  const boundary = started.boundaries[0]!;
  const physicalReceipt: PlaybookRepositoryReceipt = {
    classification: 'observation-ambiguous',
    baseline: EFFECT_OBSERVATION,
  };
  return assertPlaybookEffectLedger({
    ...started,
    revision: 2,
    boundaries: [{ ...boundary, physicalReceipt }],
  });
}

const stateMeta = (stateId: string, description: string) => ({
  playbook: { stateId, description },
});

const roleMeta = (stateId: string, role: string, description: string) => ({
  playbook: { stateId, role, description },
});

const repeatMachine = createMachine({
  id: 'role-repeat',
  context: { task: '' },
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
          }),
        },
      },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Implement the task.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          role: 'coder',
          sourceItem: 'ROLE-1',
          prompt: `Implement ${context.task}.`,
          result: { complete: 'The task is complete.' },
        }),
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

const retryMachine = createMachine({
  id: 'role-retry',
  context: { task: '' },
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
          }),
        },
      },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Implement the task.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          role: 'coder',
          sourceItem: 'ROLE-1',
          prompt: `Implement ${context.task}.`,
          result: { complete: 'The task is complete.' },
        }),
        onDone: 'ready',
        onError: 'failed',
      },
    },
    failed: {
      meta: stateMeta('failed', 'The task failed.'),
      tags: ['playbook.parked'],
      on: { START: 'work' },
    },
  },
});

const deferredBossMachine = createMachine({
  id: 'role-deferred-boss',
  context: {
    task: '',
    pendingBossQuestion: undefined as
      | {
          questionId: string;
          resumeStateId: string;
          sourceItem: string;
          asker: { kind: 'role'; roleId: string };
          question: string;
        }
      | undefined,
    bossReply: undefined as string | undefined,
  },
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
            pendingBossQuestion: () => undefined,
            bossReply: () => undefined,
          }),
        },
      },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Implement the governed task.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          role: 'coder',
          sourceItem: 'ROLE-DEFERRED-1',
          prompt: `Implement ${context.task}.`,
          result: {
            complete:
              'The task is complete. Output shall include no additional fields.',
            needsBossReply:
              "The acting agent needs Boss input. Output shall include `question: <verbatim question text from the acting agent's prose>`.",
          },
          ...(context.pendingBossQuestion === undefined
            ? {}
            : { pendingBossQuestion: context.pendingBossQuestion }),
          ...(context.bossReply === undefined
            ? {}
            : { bossReply: context.bossReply }),
        }),
        onDone: [
          {
            guard: ({ event }) =>
              (event as { output?: { guard?: string } }).output?.guard ===
              'needsBossReply',
            target: 'awaitBossReply',
            actions: assign({
              pendingBossQuestion: ({ event }) => {
                const output = (event as {
                  output: { guard: string; question: string };
                }).output;
                return {
                  questionId: 'work',
                  resumeStateId: 'work',
                  sourceItem: 'ROLE-DEFERRED-1',
                  asker: { kind: 'role' as const, roleId: 'coder' },
                  question: output.question,
                };
              },
              bossReply: () => undefined,
            }),
          },
          {
            target: 'ready',
            actions: assign({
              pendingBossQuestion: () => undefined,
              bossReply: () => undefined,
            }),
          },
        ],
        onError: 'ready',
      },
    },
    awaitBossReply: {
      meta: stateMeta('awaitBossReply', 'Waiting for Boss to answer Coder.'),
      tags: ['playbook.parked'],
      on: {
        BOSS_REPLY: {
          guard: ({ context, event }) => {
            const reply = event as { questionId?: string; answer?: string };
            return (
              typeof reply.answer === 'string' &&
              reply.answer.trim().length > 0 &&
              (reply.questionId === undefined ||
                reply.questionId === context.pendingBossQuestion?.questionId)
            );
          },
          target: 'work',
          reenter: true,
          actions: assign({
            bossReply: ({ event }) =>
              (event as { answer: string }).answer,
          }),
        },
        START: {
          target: 'work',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
            pendingBossQuestion: () => undefined,
            bossReply: () => undefined,
          }),
        },
      },
    },
  },
});

// A schema-3 parent can fail outside its own governed player state after a
// nested or sibling runtime has already written the shared host attempt. The
// unreachable `work` state makes the artifact governed; `control` exercises
// the parent-only failure path without manufacturing a local player boundary.
const foreignEffectRetryMachine = createMachine({
  id: 'foreign-effect-retry',
  context: { task: '' },
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'control',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
          }),
        },
      },
    },
    control: {
      meta: stateMeta('control', 'Checking child settlement.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'captain',
        input: () => ({
          stateId: 'control',
          sourceItem: 'ROLE-2',
          prompt: 'Check the child settlement.',
          result: { complete: 'The child settlement is safe.' },
        }),
        onDone: 'ready',
        onError: 'failed',
      },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Implement the task.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: () => ({
          stateId: 'work',
          role: 'coder',
          sourceItem: 'ROLE-1',
          prompt: 'Implement the task.',
          result: { complete: 'The task is complete.' },
        }),
        onDone: 'ready',
        onError: 'failed',
      },
    },
    failed: {
      meta: stateMeta('failed', 'The task failed.'),
      tags: ['playbook.parked'],
      on: { START: 'control' },
    },
  },
});

const nestedAfterGovernedEffectMachine = createMachine({
  id: 'nested-after-governed-effect',
  context: { task: '' },
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
          }),
        },
      },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Implement the task.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          role: 'coder',
          sourceItem: 'ROLE-1',
          prompt: `Implement ${context.task}.`,
          result: { complete: 'The task is complete.' },
        }),
        onDone: 'child',
        onError: 'failed',
      },
    },
    child: {
      meta: stateMeta('child', 'Waiting for child review.'),
      tags: ['playbook.suspended'],
      invoke: {
        src: 'playbook',
        input: ({ context }) => ({
          stateId: 'child',
          playbookId: 'review',
          text: context.task,
        }),
        onDone: 'ready',
        onError: 'failed',
      },
    },
    failed: {
      meta: stateMeta('failed', 'The task failed.'),
      tags: ['playbook.parked'],
      on: { START: 'work' },
    },
  },
});

interface EmptyOptions {}

function repeatSpec(
  overrides: Partial<XStatePlaybookRuntimeSpec<EmptyOptions>> = {},
): XStatePlaybookRuntimeSpec<EmptyOptions> {
  return {
    label: 'ROLE-REPEAT',
    compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    roleStates: { work: { role: 'coder', label: 'Implement the task.' } },
    ...overrides,
  };
}

const repeatOutcomeAuthority: XStateOutcomeAuthoritySpec = {
  governedPlayerStates: {
    work: {
      complete: { fields: {}, repositoryDisposition: 'unchanged' },
    },
  },
};

const effectAuthorizedRepeatOutcomeAuthority: XStateOutcomeAuthoritySpec = {
  governedPlayerStates: {
    work: {
      complete: {
        fields: {},
        repositoryDisposition: 'one-descendant-commit',
      },
    },
  },
};

function repeatSchema3Spec(
  overrides: Partial<XStatePlaybookRuntimeSpecV3<EmptyOptions>> = {},
): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return {
    ...repeatSpec(),
    compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
    outcomeAuthority: repeatOutcomeAuthority,
    ...overrides,
  };
}

function retrySchema3Spec(): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return repeatSchema3Spec({
    entryEvent: {
      type: 'START',
      textField: 'task',
      contextField: 'task',
    },
  });
}

function deferredBossSchema3Spec(): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return {
    compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    roleStates: {
      work: { role: 'coder', label: 'Implement the governed task.' },
    },
    classifyBossText: async (text) =>
      text === 'new directive'
        ? { type: 'START', task: text }
        : text === 'invalid'
          ? { type: 'BOSS_REPLY', questionId: 'work', answer: '' }
          : text === 'wrong question'
            ? {
                type: 'BOSS_REPLY',
                questionId: 'different-question',
                answer: text,
              }
            : { type: 'BOSS_REPLY', questionId: 'work', answer: text },
    outcomeAuthority: {
      governedPlayerStates: {
        work: {
          complete: {
            fields: {},
            repositoryDisposition: 'one-descendant-commit',
          },
          needsBossReply: {
            fields: { question: 'presentation' },
            repositoryDisposition: 'deferred',
          },
        },
      },
    },
  };
}

function foreignEffectRetrySchema3Spec(): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return {
    compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    roleStates: {
      work: { role: 'coder', label: 'Implement the task.' },
    },
    machineInput: () => ({}),
    entryEvent: {
      type: 'START',
      textField: 'task',
      contextField: 'task',
    },
    outcomeAuthority: repeatOutcomeAuthority,
  };
}

function recordingPorts(
  callPlayer: PlaybookPorts['callPlayer'],
  telemetry: unknown[] = [],
): PlaybookPorts {
  return {
    callPlayer,
    callCaptain: async () => {
      throw new Error('callCaptain not used');
    },
    callJudge: async () => '{"guard":"complete"}',
    callPlaybook: async () => {
      throw new Error('callPlaybook not used');
    },
    emitStatus: async () => undefined,
    emitTelemetry: async (event) => {
      telemetry.push(event);
    },
  };
}

function deferredTestPorts(
  playerResults: PlayerResult[],
  judgeReplies: string[],
) {
  const statuses: string[] = [];
  const telemetry: unknown[] = [];
  const resumes: Array<string | false> = [];
  const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(
    async (_roleId, _prompt, _signal, options) => {
      resumes.push(options.resume);
      const result = playerResults.shift();
      if (result === undefined) throw new Error('unexpected deferred player call');
      return result;
    },
  );
  const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () => {
    const reply = judgeReplies.shift();
    if (reply === undefined) throw new Error('unexpected deferred judge call');
    return reply;
  });
  const ports: PlaybookPorts = {
    ...recordingPorts(callPlayer, telemetry),
    callJudge,
    emitStatus: async (message) => {
      statuses.push(message);
    },
  };
  return { ports, callPlayer, callJudge, resumes, statuses, telemetry };
}

let sessionSequence = 0;

function session(
  ports: PlaybookPorts,
  options: {
    roleBindings?: Readonly<Record<string, PlaybookRoleBinding>>;
    playerSessions?: PlayerSessionStore;
  } = {},
): PlaybookSession {
  sessionSequence += 1;
  const numericSessionId = sessionSequence.toString(16).padStart(12, '0');
  return {
    sessionId: `30000000-0000-4000-8000-${numericSessionId}`,
    playbookId: 'role-fixture',
    rootSessionId: `30000000-0000-4000-8000-${numericSessionId}`,
    depth: 0,
    ...options,
    ports,
  };
}

const bossTurn = (text: string) => ({
  text,
  signal: new AbortController().signal,
});

describe('DR-032 shared role runtime transition', () => {
  it('advertises artifact schemas 2 and 3 and rejects legacy declarations', () => {
    expect(SUPPORTED_ARTIFACT_SCHEMAS).toEqual([2, 3]);
    expect(Object.isFrozen(SUPPORTED_ARTIFACT_SCHEMAS)).toBe(true);

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: undefined,
      }),
    ).toThrow('spec.compat is required');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: { artifactSchema: 1, runtimeAbi: RUNTIME_ABI },
      }),
    ).toThrow('supports [2, 3]');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: undefined,
      }),
    ).toThrow('roleStates must be supplied for schema 2');

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        playerStates: {
          work: { player: 'Coder', label: 'Implement the task.' },
        },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('must supply roleStates, not playerStates');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        resolvePlayerId: () => 'coder',
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('must not derive concrete player bindings');

    const accessorSpec = repeatSpec() as Record<string, unknown>;
    const legacyGetter = vi.fn(() => ({}));
    Object.defineProperty(accessorSpec, 'playerStates', {
      enumerable: true,
      get: legacyGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        accessorSpec as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
    ).toThrow('must supply roleStates, not playerStates');
    expect(legacyGetter).not.toHaveBeenCalled();

    const roleStatesGetter = vi.fn(() => ({
      work: { role: 'coder', label: 'Implement the task.' },
    }));
    const accessorRoleStates = repeatSpec() as Record<string, unknown>;
    Object.defineProperty(accessorRoleStates, 'roleStates', {
      enumerable: true,
      get: roleStatesGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        accessorRoleStates as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
    ).toThrow('roleStates must be an own data property');
    expect(roleStatesGetter).not.toHaveBeenCalled();

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: {
          work: {
            role: 'coder',
            label: 'Implement the task.',
            playerId: 'dev.coder',
          },
        },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('roleStates.work.playerId is not allowed');

    const roleGetter = vi.fn(() => 'coder');
    const accessorEntry = { label: 'Implement the task.' } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorEntry, 'role', {
      enumerable: true,
      get: roleGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: { work: accessorEntry },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('roleStates.work.role must be a JSON data property');
    expect(roleGetter).not.toHaveBeenCalled();
  });

  it('validates the closed schema-3 authority contract at construction', () => {
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, repeatSchema3Spec()),
    ).not.toThrow();
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        outcomeAuthority: repeatOutcomeAuthority,
      }),
    ).toThrow('outcomeAuthority is not allowed for schema 2');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
      }),
    ).toThrow(
      'outcomeAuthority must be an own enumerable data property for schema 3',
    );

    const cases: readonly [
      authority: unknown,
      diagnostic: string,
    ][] = [
      [
        { governedPlayerStates: {}, extra: true },
        'must contain exactly governedPlayerStates',
      ],
      [
        { governedPlayerStates: {} },
        'must declare player state work',
      ],
      [
        {
          governedPlayerStates: {
            work: {},
          },
        },
        'work must declare at least one outcome',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: {},
                repositoryDisposition: 'unchanged',
                extra: true,
              },
            },
          },
        },
        'must contain exactly fields, repositoryDisposition',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: { fields: {} },
            },
          },
        },
        'missing repositoryDisposition',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: {},
                repositoryDisposition: 'changed',
              },
            },
          },
        },
        'repositoryDisposition must be unchanged, one-descendant-commit, or deferred',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { message: 'operator' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'must name presentation, semantic, effect, or runtime authority',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { guard: 'semantic' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'outcome key owns the semantic discriminator',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              committed: {
                fields: { latestCommit: 'semantic' },
                repositoryDisposition: 'one-descendant-commit',
              },
            },
          },
        },
        'latestCommit must use effect authority',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { irNumber: 'runtime' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'irNumber must use semantic authority',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              needsBossReply: {
                fields: { question: 'semantic' },
                repositoryDisposition: 'deferred',
              },
            },
          },
        },
        'question must use presentation authority',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { latestCommit: 'effect' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'effect-owned fields only for one-descendant-commit',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              paused: {
                fields: { question: 'presentation' },
                repositoryDisposition: 'deferred',
              },
            },
          },
        },
        'may use deferred only for needsBossReply',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              committed: {
                fields: {},
                repositoryDisposition: 'one-descendant-commit',
              },
              needsBossReply: {
                fields: {},
                repositoryDisposition: 'deferred',
              },
            },
          },
        },
        'must declare presentation-owned question',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              needsBossReply: {
                fields: { question: 'presentation' },
                repositoryDisposition: 'deferred',
              },
            },
          },
        },
        'requires another one-descendant-commit outcome',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: {},
                repositoryDisposition: 'unchanged',
              },
            },
            other: {
              complete: {
                fields: {},
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'other does not name a player state',
      ],
    ];
    for (const [outcomeAuthority, diagnostic] of cases) {
      expect(() =>
        createXStatePlaybookRuntime(
          repeatMachine,
          repeatSchema3Spec({
            outcomeAuthority:
              outcomeAuthority as XStateOutcomeAuthoritySpec,
          }),
        ),
      ).toThrow(diagnostic);
    }

    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          outcomeAuthority: {
            governedPlayerStates: {
              work: {
                committed: {
                  fields: { latestCommit: 'effect' },
                  repositoryDisposition: 'one-descendant-commit',
                },
                needsBossReply: {
                  fields: { question: 'presentation' },
                  repositoryDisposition: 'deferred',
                },
              },
            },
          },
        }),
      ),
    ).not.toThrow();

    const authorityGetter = vi.fn(() => repeatOutcomeAuthority);
    const accessorSpec = repeatSchema3Spec() as Record<string, unknown>;
    Object.defineProperty(accessorSpec, 'outcomeAuthority', {
      enumerable: true,
      get: authorityGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        accessorSpec as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
    ).toThrow(
      'outcomeAuthority must be an own enumerable data property for schema 3',
    );
    expect(authorityGetter).not.toHaveBeenCalled();

    const nonEnumerableSpec = repeatSchema3Spec() as Record<string, unknown>;
    Object.defineProperty(nonEnumerableSpec, 'outcomeAuthority', {
      value: repeatOutcomeAuthority,
      enumerable: false,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        nonEnumerableSpec as unknown as XStatePlaybookRuntimeSpecV3<EmptyOptions>,
      ),
    ).toThrow(
      'outcomeAuthority must be an own enumerable data property for schema 3',
    );

    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          verbatimPayloadFields: new Set(['message']),
          outcomeAuthority: {
            governedPlayerStates: {
              work: {
                complete: {
                  fields: { message: 'semantic' },
                  repositoryDisposition: 'unchanged',
                },
              },
            },
          },
        }),
      ),
    ).toThrow('message must use presentation authority');
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          outcomeAuthority: {
            governedPlayerStates: {
              work: {
                complete: {
                  fields: { message: 'presentation' },
                  repositoryDisposition: 'unchanged',
                },
              },
            },
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          outcomeAuthority: {
            governedPlayerStates: {
              work: {
                complete: {
                  fields: {
                    moreTasks: 'runtime',
                    finalTask: 'runtime',
                  },
                  repositoryDisposition: 'unchanged',
                },
              },
            },
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          verbatimPayloadFields: new Set(['unused']),
        }),
      ),
    ).toThrow('unused is absent from governed payload fields');

    const rolelessMachine = createMachine({
      id: 'schema-3-roleless',
      initial: 'ready',
      states: {
        ready: {
          meta: stateMeta('ready', 'Waiting.'),
          tags: ['playbook.parked'],
        },
      },
    });
    expect(() =>
      createXStatePlaybookRuntime(rolelessMachine, {
        label: 'ROLELESS-3',
        compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: () => ({}),
        roleStates: {},
        outcomeAuthority: { governedPlayerStates: {} },
      }),
    ).not.toThrow();
  });

  it('keeps schema-3 configured options disjoint from live capabilities', async () => {
    interface ConfiguredOptions {
      readonly marker: string;
    }
    interface CapabilityMachineInput {
      readonly configuredOptions: ConfiguredOptions;
    }
    const configuredOptions = { marker: 'configured-marker' };
    const hostCapabilities = {
      marker: 'capability-marker',
      observe: () => 'observed',
      ...emptyLedgerHostCapabilities(),
    };
    const snapshotOptions = vi.fn((value: unknown): ConfiguredOptions => {
      const options = value as ConfiguredOptions;
      return { marker: options.marker };
    });
    const machineInput = vi.fn(
      (options: ConfiguredOptions): CapabilityMachineInput => ({
        configuredOptions: options,
      }),
    );
    const capabilityMachine = createMachine({
      id: 'schema-3-capability-exclusion',
      context: ({
        input,
      }: {
        input: CapabilityMachineInput | undefined;
      }) => ({ ...input }),
      initial: 'ready',
      states: {
        ready: {
          meta: stateMeta('ready', 'Waiting.'),
          tags: ['playbook.parked'],
        },
      },
    });
    const createRuntime = createXStatePlaybookRuntime<
      ConfiguredOptions,
      typeof hostCapabilities
    >(capabilityMachine, {
      label: 'CAPABILITY-EXCLUSION',
      compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
      snapshotOptions,
      machineInput,
      roleStates: {},
      outcomeAuthority: { governedPlayerStates: {} },
    });

    const mutableSchema3Spec = repeatSchema3Spec();
    const schema3Factory = createXStatePlaybookRuntime<
      EmptyOptions,
      typeof hostCapabilities
    >(repeatMachine, mutableSchema3Spec);
    const schema3Compat = schema3Factory.compat;
    expect(schema3Compat).toEqual({
      artifactSchema: 3,
      runtimeAbi: RUNTIME_ABI,
    });
    expect(Object.isFrozen(schema3Compat)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(schema3Factory, 'compat'),
    ).toMatchObject({
      enumerable: true,
      writable: false,
      configurable: false,
    });
    (mutableSchema3Spec.compat as { artifactSchema: number }).artifactSchema = 2;
    expect(schema3Factory.compat).toBe(schema3Compat);
    expect(() =>
      schema3Factory({} as {
        configuredOptions: EmptyOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must contain exactly');

    const mutableSchema2Spec = repeatSpec();
    const schema2Factory = createXStatePlaybookRuntime(
      repeatMachine,
      mutableSchema2Spec,
    );
    const schema2Compat = schema2Factory.compat;
    expect(schema2Compat).toEqual({
      artifactSchema: 2,
      runtimeAbi: RUNTIME_ABI,
    });
    expect(Object.isFrozen(schema2Compat)).toBe(true);
    (mutableSchema2Spec.compat as { artifactSchema: number }).artifactSchema = 3;
    expect(schema2Factory.compat).toBe(schema2Compat);
    expect(() => schema2Factory({})).not.toThrow();

    expect(() =>
      createRuntime({} as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must contain exactly');
    const nonPlainInput = Object.assign(Object.create({ inherited: true }), {
      configuredOptions,
      hostCapabilities,
    });
    expect(() =>
      createRuntime(nonPlainInput as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must be a plain object');
    expect(() =>
      createRuntime({
        configuredOptions,
        hostCapabilities: 1,
      } as unknown as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('hostCapabilities must be a live object');
    expect(() =>
      createRuntime({
        configuredOptions,
        hostCapabilities,
        extra: true,
      } as unknown as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must contain exactly');

    const capabilityGetter = vi.fn(() => hostCapabilities);
    const accessorInput = { configuredOptions } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'hostCapabilities', {
      enumerable: true,
      get: capabilityGetter,
    });
    expect(() =>
      createRuntime(accessorInput as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must contain exactly');
    expect(capabilityGetter).not.toHaveBeenCalled();
    expect(snapshotOptions).not.toHaveBeenCalled();
    expect(() =>
      createRuntime({
        configuredOptions: {
          marker: 'configured-marker',
          hostCapabilities: {},
        },
        hostCapabilities,
      } as unknown as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('configured options must not contain hostCapabilities');
    expect(snapshotOptions).not.toHaveBeenCalled();
    expect(() =>
      createRuntime({
        configuredOptions,
        hostCapabilities: {
          marker: 'capability-marker',
          observe: () => 'observed',
        },
      } as unknown as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('hostCapabilities.effectLedger must be an own data property');
    expect(snapshotOptions).not.toHaveBeenCalled();

    const runtime = createRuntime({ configuredOptions, hostCapabilities });
    expect(snapshotOptions).toHaveBeenCalledOnce();
    expect(snapshotOptions).toHaveBeenCalledWith(configuredOptions);
    const callPlayer = vi.fn(async () => {
      throw new Error('roleless runtime must not call a player');
    });
    await runtime.init(session(recordingPorts(callPlayer)));
    expect(machineInput).toHaveBeenCalledOnce();
    expect(machineInput).toHaveBeenCalledWith(
      { marker: 'configured-marker' },
      expect.objectContaining({ playbookId: 'role-fixture' }),
    );
    const exported = runtime.exportSnapshot?.();
    expect(exported?.machine).toMatchObject({
      context: { configuredOptions: { marker: 'configured-marker' } },
    });
    expect(exported?.effectLedger).toEqual(emptyPlaybookEffectLedger());
    expect(JSON.stringify(exported)).toContain('configured-marker');
    expect(JSON.stringify(exported)).not.toContain('capability-marker');
    expect(callPlayer).not.toHaveBeenCalled();
    await runtime.dispose();

    if (exported === undefined) throw new Error('expected a safe snapshot');
    const divergentLedger = oneBoundaryEffectLedger();
    const divergentRuntime = createRuntime({
      configuredOptions,
      hostCapabilities: {
        marker: 'capability-marker',
        observe: () => 'observed',
        effectLedger: {
          snapshot: () => divergentLedger,
          writeAhead: async () => divergentLedger,
        },
      },
    });
    await expect(
      divergentRuntime.restore?.(
        session(recordingPorts(callPlayer)),
        exported,
      ),
    ).rejects.toThrow('does not equal the current host mirror');
    expect(callPlayer).not.toHaveBeenCalled();

    const injectedFactory = createXStatePlaybookRuntime<
      EmptyOptions,
      typeof hostCapabilities
    >(
      repeatMachine,
      repeatSchema3Spec({
        snapshotOptions: () =>
          ({ hostCapabilities: {} }) as unknown as EmptyOptions,
      }),
    );
    expect(() =>
      injectedFactory({ configuredOptions: {}, hostCapabilities }),
    ).toThrow('configured options must not contain hostCapabilities');
  });

  it('snapshots linker-declared verbatim fields at factory construction', async () => {
    const mutableVerbatimFields = new Set(['message']);
    const callPlayer = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'exact player prose',
    }));
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSchema3Spec({
        extractRequiredFields: () => ['message'],
        verbatimPayloadFields: mutableVerbatimFields,
        outcomeAuthority: {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { message: 'presentation' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
      }),
    )({ configuredOptions: {}, hostCapabilities: emptyLedgerHostCapabilities() });
    mutableVerbatimFields.clear();
    await runtime.init(session(recordingPorts(callPlayer)));

    await expect(
      runtime.handleBossInput(bossTurn('the task')),
    ).resolves.toBeDefined();

    expect(callPlayer).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('rejects mismatched schema-3 outcome fields before a player call', async () => {
    const callPlayer = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'unused',
    }));
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSchema3Spec({
        outcomeAuthority: {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { message: 'semantic' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
      }),
    )({ configuredOptions: {}, hostCapabilities: emptyLedgerHostCapabilities() });
    await runtime.init(session(recordingPorts(callPlayer)));

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'must exactly match its described output fields',
    );

    expect(callPlayer).not.toHaveBeenCalled();
    await runtime.dispose();

    const mismatchedOutcomeCall = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'unused',
    }));
    const mismatchedOutcomeRuntime = createXStatePlaybookRuntime<
      EmptyOptions,
      object
    >(
      repeatMachine,
      repeatSchema3Spec({
        outcomeAuthority: {
          governedPlayerStates: {
            work: {
              other: {
                fields: {},
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
      }),
    )({ configuredOptions: {}, hostCapabilities: emptyLedgerHostCapabilities() });
    await mismatchedOutcomeRuntime.init(
      session(recordingPorts(mismatchedOutcomeCall)),
    );

    await expect(
      mismatchedOutcomeRuntime.handleBossInput(bossTurn('the task')),
    ).rejects.toThrow('must exactly match outcomes other');

    expect(mismatchedOutcomeCall).not.toHaveBeenCalled();
    await mismatchedOutcomeRuntime.dispose();
  });

  it('preserves prototype-shaped authority field identifiers exactly', async () => {
    const callPlayer = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'done',
    }));
    const outcomeAuthority = JSON.parse(
      '{"governedPlayerStates":{"work":{"complete":{"fields":{"__proto__":"runtime"},"repositoryDisposition":"unchanged"}}}}',
    ) as XStateOutcomeAuthoritySpec;
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSchema3Spec({
        extractRequiredFields: () => ['__proto__'],
        outcomeAuthority,
      }),
    )({ configuredOptions: {}, hostCapabilities: emptyLedgerHostCapabilities() });
    await runtime.init(session(recordingPorts(callPlayer)));

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'missing required field "__proto__"',
    );

    expect(callPlayer).toHaveBeenCalledTimes(1);
    await runtime.dispose();

    const adjudicated = await adjudicatePlayerOutput(
      {
        extractRequiredFields: () => ['__proto__'],
        verbatimPayloadFields: new Set(['__proto__']),
      },
      {
        stateId: 'work',
        role: 'coder',
        sourceItem: 'ROLE-1',
        prompt: 'Implement the task.',
        result: { complete: 'The task is complete.' },
      },
      'exact player prose',
      recordingPorts(callPlayer),
      new AbortController().signal,
    );
    expect(Object.hasOwn(adjudicated, '__proto__')).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(adjudicated, '__proto__')?.value,
    ).toBe('exact player prose');
  });

  it('uses detached bindings for prompt identity while the port receives the role', async () => {
    const telemetry: unknown[] = [];
    const calls: Array<{ roleId: string; prompt: string; resume: string | false }> = [];
    const mutableBinding = {
      playerId: 'dev.shared',
      promptIdentity: 'GPT-5.6 Sol',
    };
    let retainedLookup: ((roleId: string) => string) | undefined;
    const ports = recordingPorts(async (roleId, prompt, _signal, options) => {
      calls.push({ roleId, prompt, resume: options.resume });
      return { status: 'ok', resumeToken: 'thread-1', finalText: 'done' };
    }, telemetry);
    const createRuntime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (input, promptIdentity) => {
          retainedLookup = promptIdentity;
          return `${promptIdentity(input.role)}\n\n${input.prompt}`;
        },
      }),
    );
    const runtime = createRuntime({});
    await runtime.init(
      session(ports, { roleBindings: { coder: mutableBinding } }),
    );
    mutableBinding.playerId = 'mutated.player';
    mutableBinding.promptIdentity = 'mutated model';

    await runtime.handleBossInput(bossTurn('the change'));

    expect(calls).toEqual([
      {
        roleId: 'coder',
        prompt: 'GPT-5.6 Sol\n\nImplement the change.',
        resume: false,
      },
    ]);
    const playerTraces = telemetry
      .map((event) => event as { topic: string; payload: Record<string, unknown> })
      .filter(
        ({ topic, payload }) =>
          topic === 'playbook.trace' &&
          String(payload.type).startsWith('player.call.'),
      );
    expect(playerTraces).toHaveLength(2);
    for (const { payload } of playerTraces) {
      expect(payload.schemaVersion).toBe(3);
      expect(payload.payload).toMatchObject({
        roleId: 'coder',
        playerId: 'dev.shared',
      });
    }
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot).toMatchObject({
      schemaVersion: 4,
      roleResumeTokens: { coder: 'thread-1' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('dev.shared');
    expect(JSON.stringify(snapshot)).not.toContain('GPT-5.6 Sol');
    expect(() => retainedLookup?.('coder')).toThrow(
      'prompt identity lookup is no longer active',
    );
    await runtime.dispose();

    const restored = createRuntime({});
    await restored.restore?.(
      session(ports, {
        roleBindings: {
          coder: {
            playerId: 'dev.shared',
            promptIdentity: 'Claude Opus 5',
          },
        },
      }),
      snapshot!,
    );
    await restored.handleBossInput(bossTurn('the follow-up'));
    expect(calls[1]).toEqual({
      roleId: 'coder',
      prompt: 'Claude Opus 5\n\nImplement the follow-up.',
      resume: 'thread-1',
    });
    expect(JSON.stringify(restored.exportSnapshot?.())).not.toContain(
      'Claude Opus 5',
    );
    expect(() => retainedLookup?.('coder')).toThrow(
      'prompt identity lookup is no longer active',
    );
    await restored.dispose();
  });

  it('validates exact bindings and limits prompt lookup to declared roles', async () => {
    const port = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'done',
    }));
    const ports = recordingPorts(port);
    const createRuntime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (_input, promptIdentity) =>
          promptIdentity('reviewer'),
      }),
    );

    for (const roleBindings of [
      {},
      {
        coder: { playerId: 'dev.coder', promptIdentity: 'Coder' },
        reviewer: { playerId: 'dev.reviewer', promptIdentity: 'Reviewer' },
      },
    ]) {
      const runtime = createRuntime({});
      await expect(runtime.init(session(ports, { roleBindings }))).rejects.toThrow(
        'must cover exactly [coder]',
      );
      await runtime.dispose();
    }

    const emptyIdentity = createRuntime({});
    await expect(
      emptyIdentity.init(
        session(ports, {
          roleBindings: { coder: { playerId: 'dev.coder', promptIdentity: ' ' } },
        }),
      ),
    ).rejects.toThrow('promptIdentity must be a non-empty string');
    await emptyIdentity.dispose();

    const lookup = createRuntime({});
    await lookup.init(
      session(ports, {
        roleBindings: {
          coder: { playerId: 'dev.coder', promptIdentity: 'Coder' },
        },
      }),
    );
    await expect(
      lookup.handleBossInput(bossTurn('task')),
    ).rejects.toThrow('lookup rejected undeclared role reviewer');
    expect(port).not.toHaveBeenCalled();
    await lookup.dispose();
  });

  it('preserves, clears, and replaces external continuation only when authorized', async () => {
    const tokens = new Map<string, string>();
    const updates: Array<[string, string | undefined]> = [];
    const store: PlayerSessionStore = {
      select: (roleId) => tokens.get(roleId) ?? false,
      update: (roleId, token) => {
        updates.push([roleId, token]);
        if (token === undefined) tokens.delete(roleId);
        else tokens.set(roleId, token);
      },
      snapshot: () => Object.fromEntries(tokens),
      restore: (next) => {
        tokens.clear();
        for (const [roleId, token] of Object.entries(next)) {
          tokens.set(roleId, token);
        }
      },
    };
    const results: PlayerResult[] = [
      { status: 'ok', resumeToken: 'thread-1', finalText: 'done' },
      { status: 'aborted' },
      { status: 'ok', resumeToken: '   ', finalText: 'invalid' },
      { status: 'error', error: 'failed' },
      { status: 'ok', finalText: 'done' },
      { status: 'ok', resumeToken: 'thread-2', finalText: 'done' },
    ];
    const resumes: Array<string | false> = [];
    const standalonePromptIdentities: string[] = [];
    const ports = recordingPorts(async (_roleId, _prompt, _signal, options) => {
      resumes.push(options.resume);
      return results.shift()!;
    });
    const runtime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (input, promptIdentity) => {
          standalonePromptIdentities.push(promptIdentity(input.role));
          return input.prompt;
        },
      }),
    )({});
    await runtime.init(session(ports, { playerSessions: store }));

    await runtime.handleBossInput(bossTurn('one'));
    await runtime.handleBossInput(bossTurn('two'));
    await expect(runtime.handleBossInput(bossTurn('three'))).rejects.toThrow(
      'resumeToken must be a non-empty string',
    );
    await runtime.handleBossInput(bossTurn('four'));
    await runtime.handleBossInput(bossTurn('five'));
    await runtime.handleBossInput(bossTurn('six'));

    expect(resumes).toEqual([
      false,
      'thread-1',
      'thread-1',
      'thread-1',
      'thread-1',
      false,
    ]);
    expect(updates).toEqual([
      ['coder', 'thread-1'],
      ['coder', undefined],
      ['coder', 'thread-2'],
    ]);
    expect(standalonePromptIdentities).toEqual(Array(6).fill('coder'));
    expect(runtime.exportSnapshot?.()?.roleResumeTokens).toEqual({
      coder: 'thread-2',
    });
    await runtime.dispose();
  });

  it.each([
    ['unchanged', 'unchanged' as const, 2, false],
    ['one descendant commit', 'one-descendant-commit' as const, 1, true],
    ['multiple commits', 'multiple-commits' as const, 1, true],
    [
      'rewritten history',
      'rewritten-or-non-descendant' as const,
      1,
      true,
    ],
    ['worktree-only change', 'worktree-only-change' as const, 1, true],
    [
      'concurrent or foreign change',
      'concurrent-or-foreign-change' as const,
      1,
      false,
    ],
    ['ambiguous observation', 'observation-ambiguous' as const, 1, false],
  ])(
    'allows schema-3 empty-result correction only after a complete %s receipt',
    async (_label, classification, expectedCalls, effectAuthorized) => {
      const hostCapabilities = emptyLedgerHostCapabilities({
        classifications: [classification, 'unchanged'],
      });
      const callPlayer = vi
        .fn<PlaybookPorts['callPlayer']>()
        .mockResolvedValueOnce({ status: 'ok', finalText: '' })
        .mockResolvedValue({ status: 'ok', finalText: 'done' });
      const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
        repeatMachine,
        repeatSchema3Spec(
          effectAuthorized
            ? { outcomeAuthority: effectAuthorizedRepeatOutcomeAuthority }
            : {},
        ),
      )({ configuredOptions: {}, hostCapabilities });
      await runtime.init(session(recordingPorts(callPlayer)));

      await runtime.handleBossInput(bossTurn('the task'));

      expect(callPlayer).toHaveBeenCalledTimes(expectedCalls);
      expect(hostCapabilities.repository.runExclusive).toHaveBeenCalledTimes(
        expectedCalls,
      );
      const boundaries = hostCapabilities.effectLedger.snapshot().boundaries;
      expect(boundaries).toHaveLength(expectedCalls);
      expect(boundaries[0]?.finalText).toBe('');
      expect(boundaries[0]?.physicalReceipt?.classification).toBe(
        classification,
      );
      await runtime.dispose();
    },
  );

  it('does not begin the traced schema-3 player call before the durable start acknowledgement', async () => {
    let acknowledgeStart!: () => void;
    const startAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeStart = resolve;
    });
    const hostCapabilities = emptyLedgerHostCapabilities({
      startAcknowledgement,
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'done',
    }));
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(recordingPorts(callPlayer)));

    const pending = runtime.handleBossInput(bossTurn('the task'));
    await vi.waitFor(() => {
      expect(hostCapabilities.repository.runExclusive).toHaveBeenCalledOnce();
    });
    expect(callPlayer).not.toHaveBeenCalled();
    expect(hostCapabilities.effectLedger.snapshot().boundaries).toHaveLength(1);
    acknowledgeStart();
    await pending;
    expect(callPlayer).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it('does not begin empty-result correction before the first durable completion acknowledgement', async () => {
    let acknowledgeCompletion!: () => void;
    const completionAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeCompletion = resolve;
    });
    const hostCapabilities = emptyLedgerHostCapabilities({
      completionAcknowledgement,
    });
    const callPlayer = vi
      .fn<PlaybookPorts['callPlayer']>()
      .mockResolvedValueOnce({ status: 'ok', finalText: '' })
      .mockResolvedValue({ status: 'ok', finalText: 'done' });
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(recordingPorts(callPlayer)));

    const pending = runtime.handleBossInput(bossTurn('the task'));
    await vi.waitFor(() => {
      expect(callPlayer).toHaveBeenCalledOnce();
    });
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .not.toHaveProperty('physicalReceipt');
    expect(hostCapabilities.repository.runExclusive).toHaveBeenCalledOnce();
    acknowledgeCompletion();
    await pending;
    expect(callPlayer).toHaveBeenCalledTimes(2);
    expect(hostCapabilities.repository.runExclusive).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it('treats a started boundary without a completion acknowledgement as ineligible for correction or retry', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      failCompletionAt: [0],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: '',
    }));
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      retryMachine,
      retrySchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(recordingPorts(callPlayer)));

    await expect(
      runtime.handleBossInput(bossTurn('the task')),
    ).rejects.toThrow('completion acknowledgement unavailable');
    expect(
      hostCapabilities.effectLedger.snapshot().boundaries[0]?.physicalReceipt,
    ).toBeUndefined();
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(runtime.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    await runtime.handleBossInput(bossTurn('later no-action turn'));
    expect(callPlayer).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it('advertises and applies a failed-state retry only for an all-unchanged host attempt', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities();
    const callPlayer = vi
      .fn<PlaybookPorts['callPlayer']>()
      .mockResolvedValueOnce({ status: 'error', error: 'try again' })
      .mockResolvedValue({ status: 'ok', finalText: 'done' });
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      retryMachine,
      retrySchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(recordingPorts(callPlayer)));

    const failed = await runtime.handleBossInput(bossTurn('the task'));
    expect(failed.state.stateId).toBe('failed');
    expect(runtime.describe?.().actions.map(({ id }) => id)).toContain(
      'retry:START',
    );

    const receipt = await runtime.apply?.({
      actionId: 'retry:START',
      key: 'retry-once',
      signal: new AbortController().signal,
    });
    expect(receipt?.disposition).toBe('executed');
    expect(callPlayer).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it('suppresses retry when a second empty result follows a nonzero receipt', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['unchanged', 'concurrent-or-foreign-change'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: '',
    }));
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      retryMachine,
      retrySchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(recordingPorts(callPlayer)));

    await expect(
      runtime.handleBossInput(bossTurn('the task')),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(callPlayer).toHaveBeenCalledTimes(2);
    expect(runtime.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    await runtime.dispose();
  });

  it('suppresses retry when adjudication fails after a nonzero receipt', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['concurrent-or-foreign-change'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'candidate output',
    }));
    const ports = {
      ...recordingPorts(callPlayer),
      callJudge: vi.fn(async () => 'not-json'),
    };
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      retryMachine,
      retrySchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(ports));

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'judge response is not valid JSON',
    );
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(ports.callJudge).toHaveBeenCalledOnce();
    expect(runtime.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    await runtime.dispose();
  });

  it('retains an earlier governed boundary when a suspended child resumes into failure', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['concurrent-or-foreign-change'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'implemented',
    }));
    const callPlaybook = vi.fn<PlaybookPorts['callPlaybook']>(async () => ({
      state: 'suspended',
      childSessionId: 'review-child',
    }));
    const ports = { ...recordingPorts(callPlayer), callPlaybook };
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      nestedAfterGovernedEffectMachine,
      retrySchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(ports));

    const suspended = await runtime.handleBossInput(bossTurn('the task'));
    expect(suspended).toMatchObject({ outcome: 'suspended' });
    const pendingCall =
      'pendingCall' in suspended ? suspended.pendingCall : undefined;
    expect(pendingCall).toMatchObject({
      playbookId: 'review',
      childSessionId: 'review-child',
    });

    await expect(
      runtime.resumePlaybookCall({
        callId: pendingCall!.callId,
        result: {
          status: 'error',
          playbookId: 'review',
          childSessionId: 'review-child',
          error: { name: 'Error', message: 'review failed' },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(runtime.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    expect(runtime.exportSnapshot?.()?.failedEffectAttempt).toEqual({
      boundaryPrefix: 0,
      attemptId: '20000000-0000-4000-8000-000000000001',
    });
    await runtime.dispose();
  });

  it('restores a suspended child with its exact causal effect prefix', async () => {
    const attemptId = '20000000-0000-4000-8000-000000000001';
    const hostCapabilities = emptyLedgerHostCapabilities({
      attemptId,
      initialLedger: ambiguousBoundaryEffectLedger(),
      classifications: ['unchanged'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'implemented',
    }));
    const callPlaybook = vi.fn<PlaybookPorts['callPlaybook']>(async () => ({
      state: 'suspended',
      childSessionId: 'review-child',
    }));
    const ports = { ...recordingPorts(callPlayer), callPlaybook };
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        nestedAfterGovernedEffectMachine,
        retrySchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session(ports);
    const runtime = createRuntime();
    await runtime.init(boundSession);

    const suspended = await runtime.handleBossInput(bossTurn('the task'));
    const pendingCall =
      'pendingCall' in suspended ? suspended.pendingCall : undefined;
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.suspendedCall).toMatchObject({
      callId: pendingCall?.callId,
      effectBoundaryPrefixSequence: 1,
    });
    await runtime.dispose();

    const restored = createRuntime();
    await restored.restore?.(boundSession, snapshot!);
    expect(callPlaybook).toHaveBeenCalledOnce();
    expect(callPlayer).toHaveBeenCalledOnce();
    await expect(
      restored.resumePlaybookCall({
        callId: pendingCall!.callId,
        result: {
          status: 'error',
          playbookId: 'review',
          childSessionId: 'review-child',
          error: { name: 'Error', message: 'review failed after restore' },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(restored.describe?.().actions.map(({ id }) => id)).toContain(
      'retry:START',
    );
    expect(restored.exportSnapshot?.()?.failedEffectAttempt).toEqual({
      boundaryPrefix: 1,
      attemptId,
    });
    await restored.dispose();
  });

  it('suppresses failed-state retry across no-action turns and restore when any boundary in the host attempt is nonzero', async () => {
    const attemptId = '10000000-0000-4000-8000-000000000002';
    const hostCapabilities = emptyLedgerHostCapabilities({
      attemptId,
      initialLedger: ambiguousBoundaryEffectLedger(),
      classifications: ['unchanged'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'error',
      error: 'still failed',
    }));
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        retryMachine,
        retrySchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session(recordingPorts(callPlayer));
    const runtime = createRuntime();
    await runtime.init(boundSession);

    const failed = await runtime.handleBossInput(bossTurn('the task'));
    expect(failed.state.stateId).toBe('failed');
    expect(
      hostCapabilities.effectLedger
        .snapshot()
        .boundaries.filter((boundary) => boundary.attemptId === attemptId)
        .map((boundary) => boundary.physicalReceipt?.classification),
    ).toEqual(['observation-ambiguous', 'unchanged']);
    expect(runtime.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    await expect(
      runtime.apply?.({
        actionId: 'retry:START',
        key: 'blocked-retry',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ disposition: 'rejected' });
    await runtime.handleBossInput(bossTurn('later no-action turn'));
    expect(callPlayer).toHaveBeenCalledTimes(1);

    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot).toBeDefined();
    await runtime.dispose();
    const restored = createRuntime();
    await restored.restore?.(boundSession, snapshot!);
    expect(restored.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    await restored.handleBossInput(bossTurn('after restore'));
    expect(callPlayer).toHaveBeenCalledTimes(1);
    await restored.dispose();
  });

  it('binds a parent failure to a foreign-runtime boundary and preserves that fence across restore', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities();
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => {
      throw new Error('the unreachable player state must not run');
    });
    const callCaptain = vi.fn<PlaybookPorts['callCaptain']>(async () => {
      hostCapabilities.replaceEffectLedger(ambiguousBoundaryEffectLedger());
      return { status: 'error', error: 'child settlement failed' };
    });
    const ports = { ...recordingPorts(callPlayer), callCaptain };
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        foreignEffectRetryMachine,
        foreignEffectRetrySchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session(ports);
    const runtime = createRuntime();
    await runtime.init(boundSession);

    await expect(
      runtime.handleBossInput(bossTurn('the task')),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(callCaptain).toHaveBeenCalledOnce();
    expect(runtime.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.failedEffectAttempt).toEqual({
      boundaryPrefix: 0,
      attemptId: '10000000-0000-4000-8000-000000000002',
    });
    await runtime.dispose();

    const restored = createRuntime();
    await restored.restore?.(boundSession, snapshot!);
    expect(restored.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    await restored.handleBossInput(bossTurn('must remain fenced'));
    expect(callCaptain).toHaveBeenCalledOnce();
    const current = hostCapabilities.effectLedger.snapshot();
    const firstBoundary = current.boundaries[0]!;
    hostCapabilities.replaceEffectLedger({
      ...current,
      revision: current.revision + 1,
      boundaries: [
        ...current.boundaries,
        {
          ...firstBoundary,
          sequence: 2,
          boundaryId: '10000000-0000-4000-8000-000000000004',
          attemptId: '10000000-0000-4000-8000-000000000005',
        },
      ],
    });
    expect(restored.exportSnapshot?.()).not.toHaveProperty(
      'failedEffectAttempt',
    );
    await restored.dispose();
  });

  it('persists an explicit pre-effect failure so safe retry remains available after restore', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities();
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => {
      throw new Error('the unreachable player state must not run');
    });
    const callCaptain = vi.fn<PlaybookPorts['callCaptain']>(async () => ({
      status: 'error',
      error: 'pre-effect control failure',
    }));
    const ports = { ...recordingPorts(callPlayer), callCaptain };
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        foreignEffectRetryMachine,
        foreignEffectRetrySchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session(ports);
    const runtime = createRuntime();
    await runtime.init(boundSession);

    await runtime.handleBossInput(bossTurn('the task'));
    expect(runtime.describe?.().actions.map(({ id }) => id)).toContain(
      'retry:START',
    );
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.failedEffectAttempt).toEqual({
      boundaryPrefix: 0,
      attemptId: null,
    });
    await runtime.dispose();

    const restored = createRuntime();
    await restored.restore?.(boundSession, snapshot!);
    expect(restored.describe?.().actions.map(({ id }) => id)).toContain(
      'retry:START',
    );
    hostCapabilities.replaceEffectLedger(ambiguousBoundaryEffectLedger());
    expect(restored.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    expect(restored.exportSnapshot?.()).not.toHaveProperty(
      'failedEffectAttempt',
    );
    await restored.dispose();
  });
});

describe('DR-040 deferred Boss continuation', () => {
  it('publishes a bound question only after acknowledgement and completes from the original baseline', async () => {
    let acknowledgeFinalWrite!: () => void;
    const finalWriteAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeFinalWrite = resolve;
    });
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['unchanged', 'one-descendant-commit'],
      finalWriteAcknowledgement,
    });
    const harness = deferredTestPorts(
      [
        {
          status: 'ok',
          finalText: 'I need a decision.',
          resumeToken: 'thread-question',
        },
        {
          status: 'ok',
          finalText: 'Implemented and committed.',
          resumeToken: 'thread-final',
        },
      ],
      [
        '{"guard":"needsBossReply","question":"Choose a format."}',
        '{"guard":"complete"}',
      ],
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      deferredBossMachine,
      deferredBossSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(harness.ports));
    harness.statuses.length = 0;

    const initial = runtime.handleBossInput(bossTurn('the task'));
    await vi.waitFor(() => expect(harness.callJudge).toHaveBeenCalledOnce());
    expect(harness.statuses).not.toContain('Coder asks: Choose a format.');
    expect(hostCapabilities.effectLedger.snapshot().logicalOperations).toEqual(
      [],
    );
    acknowledgeFinalWrite();
    await expect(initial).resolves.toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply' },
    });

    const initialLedger = hostCapabilities.effectLedger.snapshot();
    const open = initialLedger.logicalOperations[0]!;
    expect(open).toMatchObject({
      boundaryIds: [initialLedger.boundaries[0]?.boundaryId],
      originalBaseline: EFFECT_OBSERVATION,
      checkpointRestorationEligible: false,
      pendingQuestion: {
        questionId: 'work',
        sourceItem: 'ROLE-DEFERRED-1',
        question: 'Choose a format.',
      },
      playerContinuation: 'thread-question',
    });
    expect(initialLedger.boundaries[0]?.logicalOperationId).toBe(
      open.operationId,
    );
    expect(harness.statuses).toContain('coder asks: Choose a format.');
    expect(runtime.describe?.().pendingQuestions).toEqual([
      {
        questionId: 'work',
        asker: { kind: 'role', roleId: 'coder' },
        question: 'Choose a format.',
        sourceItem: 'ROLE-DEFERRED-1',
      },
    ]);

    const revision = initialLedger.revision;
    await runtime.handleBossInput(bossTurn('invalid'));
    await runtime.handleBossInput(bossTurn('wrong question'));
    expect(hostCapabilities.effectLedger.snapshot().revision).toBe(revision);
    expect(harness.callPlayer).toHaveBeenCalledOnce();
    expect(harness.callJudge).toHaveBeenCalledOnce();

    await expect(runtime.handleBossInput(bossTurn('markdown'))).resolves.toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'ready' },
    });
    const completed = hostCapabilities.effectLedger.snapshot();
    expect(harness.resumes).toEqual([false, 'thread-question']);
    expect(completed.boundaries).toHaveLength(2);
    expect(completed.logicalOperations[0]).toMatchObject({
      operationId: open.operationId,
      originalBaseline: EFFECT_OBSERVATION,
      boundaryIds: completed.boundaries.map(({ boundaryId }) => boundaryId),
      logicalReceipt: {
        classification: 'one-descendant-commit',
        baseline: EFFECT_OBSERVATION,
      },
    });
    expect(completed.boundaries[1]?.physicalReceipt?.baseline).toEqual(
      open.checkpoint,
    );
    await runtime.dispose();
  });

  it('discards a mismatched answer and restores the same wait across restart without a call', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['unchanged', 'one-descendant-commit'],
    });
    const harness = deferredTestPorts(
      [
        {
          status: 'ok',
          finalText: 'I need a decision.',
          resumeToken: 'thread-question',
        },
        { status: 'ok', finalText: 'done', resumeToken: 'thread-final' },
      ],
      [
        '{"guard":"needsBossReply","question":"Choose a format."}',
        '{"guard":"complete"}',
      ],
    );
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        deferredBossMachine,
        deferredBossSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session(harness.ports);
    const runtime = createRuntime();
    await runtime.init(boundSession);
    await runtime.handleBossInput(bossTurn('the task'));
    const bound = hostCapabilities.effectLedger.snapshot().logicalOperations[0]!;
    const checkpoint = bound.checkpoint!;

    hostCapabilities.replaceObservation(EFFECT_CHANGED_OBSERVATION);
    await expect(
      runtime.handleBossInput(bossTurn('answer that must be discarded')),
    ).resolves.toMatchObject({ outcome: 'no-action' });
    const mismatched = hostCapabilities.effectLedger.snapshot();
    expect(mismatched.logicalOperations[0]).toMatchObject({
      operationId: bound.operationId,
      pendingQuestion: bound.pendingQuestion,
      playerContinuation: bound.playerContinuation,
      checkpointRestorationEligible: true,
    });
    expect(mismatched.boundaries).toHaveLength(1);
    expect(harness.callPlayer).toHaveBeenCalledOnce();
    expect(harness.callJudge).toHaveBeenCalledOnce();
    expect(runtime.describe?.()).toMatchObject({
      pendingQuestions: [],
      actions: [{ id: 'reconcile:restore-deferred-wait' }],
    });
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.pendingBossQuestions).toEqual([]);
    expect(JSON.stringify(snapshot?.machine)).not.toContain(
      'answer that must be discarded',
    );
    await runtime.dispose();

    const restored = createRuntime();
    await restored.restore?.(boundSession, snapshot!);
    await restored.apply?.({
      actionId: 'reconcile:restore-deferred-wait',
      key: 'unequal-retry',
      signal: new AbortController().signal,
    });
    expect(
      hostCapabilities.effectLedger.snapshot().logicalOperations[0]
        ?.checkpointRestorationEligible,
    ).toBe(true);
    expect(harness.callPlayer).toHaveBeenCalledOnce();
    expect(harness.callJudge).toHaveBeenCalledOnce();

    hostCapabilities.replaceObservation(checkpoint);
    await expect(
      restored.apply?.({
        actionId: 'reconcile:restore-deferred-wait',
        key: 'exact-retry',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      disposition: 'executed',
      run: { outcome: 'quiescent' },
    });
    expect(restored.describe?.().pendingQuestions[0]).toEqual(
      bound.pendingQuestion,
    );
    expect(harness.callPlayer).toHaveBeenCalledOnce();
    expect(harness.callJudge).toHaveBeenCalledOnce();

    await restored.handleBossInput(bossTurn('later valid answer'));
    expect(harness.resumes).toEqual([false, 'thread-question']);
    await restored.dispose();
  });

  it('preserves one operation and original baseline across repeated questions', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: [
        'unchanged',
        'unchanged',
        'one-descendant-commit',
      ],
    });
    const harness = deferredTestPorts(
      [
        { status: 'ok', finalText: 'question one', resumeToken: 'thread-1' },
        { status: 'ok', finalText: 'question two', resumeToken: 'thread-2' },
        { status: 'ok', finalText: 'done', resumeToken: 'thread-3' },
      ],
      [
        '{"guard":"needsBossReply","question":"First question?"}',
        '{"guard":"needsBossReply","question":"Second question?"}',
        '{"guard":"complete"}',
      ],
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      deferredBossMachine,
      deferredBossSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(harness.ports));
    await runtime.handleBossInput(bossTurn('the task'));
    const first = hostCapabilities.effectLedger.snapshot().logicalOperations[0]!;

    await runtime.handleBossInput(bossTurn('first answer'));
    const repeated = hostCapabilities.effectLedger.snapshot();
    expect(repeated.logicalOperations).toHaveLength(1);
    expect(repeated.logicalOperations[0]).toMatchObject({
      operationId: first.operationId,
      originalBaseline: first.originalBaseline,
      playerContinuation: 'thread-2',
      pendingQuestion: { question: 'Second question?' },
    });
    expect(repeated.boundaries).toHaveLength(2);
    expect(repeated.logicalOperations[0]?.boundaryIds).toEqual(
      repeated.boundaries.map(({ boundaryId }) => boundaryId),
    );

    await runtime.handleBossInput(bossTurn('second answer'));
    const final = hostCapabilities.effectLedger.snapshot();
    expect(final.logicalOperations[0]).toMatchObject({
      operationId: first.operationId,
      originalBaseline: first.originalBaseline,
      logicalReceipt: { baseline: first.originalBaseline },
    });
    expect(harness.resumes).toEqual([false, 'thread-1', 'thread-2']);
    await runtime.dispose();
  });

  it('parks another exit without starting its authored transition', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['worktree-only-change'],
    });
    const harness = deferredTestPorts(
      [
        { status: 'ok', finalText: 'question', resumeToken: 'thread-question' },
      ],
      ['{"guard":"needsBossReply","question":"Choose a format."}'],
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      deferredBossMachine,
      deferredBossSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(harness.ports));
    await runtime.handleBossInput(bossTurn('the task'));
    await runtime.handleBossInput(bossTurn('new directive'));

    const parked = hostCapabilities.effectLedger.snapshot().logicalOperations[0]!;
    expect(parked).not.toHaveProperty('checkpoint');
    expect(parked).not.toHaveProperty('pendingQuestion');
    expect(parked).not.toHaveProperty('playerContinuation');
    expect(parked.checkpointRestorationEligible).toBe(false);
    expect(harness.callPlayer).toHaveBeenCalledOnce();
    expect(runtime.describe?.()).toMatchObject({
      pendingQuestions: [],
      actions: [],
    });
    await runtime.dispose();
  });

  it.each([
    ['initial bind', 0],
    ['continued bind', 1],
  ])(
    'closes every state surface when the %s write is indeterminate',
    async (_label, failureIndex) => {
      const hostCapabilities = emptyLedgerHostCapabilities({
        classifications: ['worktree-only-change', 'unchanged'],
        failAfterCompletionAt: [failureIndex],
      });
      const harness = deferredTestPorts(
        [
          { status: 'ok', finalText: 'question one', resumeToken: 'thread-1' },
          { status: 'ok', finalText: 'question two', resumeToken: 'thread-2' },
        ],
        [
          '{"guard":"needsBossReply","question":"First question?"}',
          '{"guard":"needsBossReply","question":"Second question?"}',
        ],
      );
      const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
        deferredBossMachine,
        deferredBossSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
      await runtime.init(session(harness.ports));
      harness.telemetry.length = 0;
      harness.statuses.length = 0;

      if (failureIndex === 1) {
        await runtime.handleBossInput(bossTurn('the task'));
        harness.telemetry.length = 0;
        harness.statuses.length = 0;
      }
      await expect(
        runtime.handleBossInput(
          bossTurn(failureIndex === 0 ? 'the task' : 'valid answer'),
        ),
      ).rejects.toThrow('write acknowledgement unavailable');
      expect(runtime.exportSnapshot?.()).toBeUndefined();
      expect(() => runtime.describe?.()).toThrow(
        'deferred settlement recovery is required',
      );
      await expect(
        runtime.handleBossInput(bossTurn('another turn')),
      ).rejects.toThrow('deferred settlement recovery is required');
      const settled = harness.telemetry.filter(
        (event) =>
          (event as { payload?: { type?: string } }).payload?.type ===
          'boss.input.settled',
      );
      expect(settled).toEqual([]);
      expect(harness.statuses).not.toContain('Coder asks: Second question?');
      await runtime.dispose();
    },
  );
});

const aliasMachine = createMachine({
  id: 'role-alias',
  context: {},
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: { START: 'code' },
    },
    code: {
      meta: roleMeta('code', 'coder', 'Draft a proposal.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'code',
          role: 'coder',
          sourceItem: 'ALIAS-1',
          prompt: 'Draft.',
          result: { complete: 'Complete.' },
        },
        onDone: 'review',
        onError: 'ready',
      },
    },
    review: {
      meta: roleMeta('review', 'reviewer', 'Review the proposal.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'review',
          role: 'reviewer',
          sourceItem: 'ALIAS-2',
          prompt: 'Review.',
          result: { complete: 'Complete.' },
        },
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

const aliasSpec: XStatePlaybookRuntimeSpec<EmptyOptions> = {
  label: 'ROLE-ALIAS',
  compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {
    code: { role: 'coder', label: 'Draft a proposal.' },
    review: { role: 'reviewer', label: 'Review the proposal.' },
  },
};

describe('DR-032 aliased private continuation', () => {
  it('shares by player privately but projects and restores by local role', async () => {
    const calls: Array<{ roleId: string; resume: string | false }> = [];
    const results: PlayerResult[] = [
      { status: 'ok', resumeToken: 'thread-1', finalText: 'draft' },
      { status: 'ok', resumeToken: 'thread-2', finalText: 'review' },
    ];
    const ports = recordingPorts(async (roleId, _prompt, _signal, options) => {
      calls.push({ roleId, resume: options.resume });
      return results.shift()!;
    });
    const bindings = {
      coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
      reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
    };
    const createRuntime = createXStatePlaybookRuntime(aliasMachine, aliasSpec);
    const runtime = createRuntime({});
    await runtime.init(session(ports, { roleBindings: bindings }));
    await runtime.handleBossInput(bossTurn('start'));
    expect(calls).toEqual([
      { roleId: 'coder', resume: false },
      { roleId: 'reviewer', resume: 'thread-1' },
    ]);
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.roleResumeTokens).toEqual({
      coder: 'thread-2',
      reviewer: 'thread-2',
    });
    await runtime.dispose();

    const conflicting = structuredClone(snapshot!);
    conflicting.roleResumeTokens = {
      coder: 'thread-a',
      reviewer: 'thread-b',
    };
    const restored = createRuntime({});
    await expect(
      restored.restore?.(
        session(ports, { roleBindings: bindings }),
        conflicting,
      ),
    ).rejects.toThrow('conflicting tokens');
    await restored.dispose();
  });

  it('rejects a one-sided external alias projection', async () => {
    const ports = recordingPorts(async () => ({
      status: 'ok',
      finalText: 'unused',
    }));
    const store: PlayerSessionStore = {
      select: () => false,
      update: () => undefined,
      snapshot: () => ({ coder: 'thread-1' }),
      restore: () => undefined,
    };
    const runtime = createXStatePlaybookRuntime(aliasMachine, aliasSpec)({});
    await runtime.init(
      session(ports, {
        roleBindings: {
          coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
          reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
        },
        playerSessions: store,
      }),
    );
    expect(() => runtime.exportSnapshot?.()).toThrow(
      'through every aliased role',
    );
    await runtime.dispose();
  });

  it('rejects an accessor-bearing external projection without invoking it', async () => {
    const tokenGetter = vi.fn(() => 'thread-1');
    const store: PlayerSessionStore = {
      select: () => false,
      update: () => undefined,
      snapshot: () => {
        const projected = {} as Record<string, string>;
        Object.defineProperty(projected, 'coder', {
          enumerable: true,
          get: tokenGetter,
        });
        return projected;
      },
      restore: () => undefined,
    };
    const runtime = createXStatePlaybookRuntime(repeatMachine, repeatSpec())({});
    await runtime.init(
      session(
        recordingPorts(async () => ({
          status: 'ok',
          finalText: 'unused',
        })),
        { playerSessions: store },
      ),
    );

    expect(() => runtime.exportSnapshot?.()).toThrow(
      'player session store snapshot.coder must be a JSON data property',
    );
    expect(tokenGetter).not.toHaveBeenCalled();
    await runtime.dispose();
  });
});

const collisionMachine = createMachine({
  id: 'role-collision',
  context: {},
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: { START: 'work' },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Run simultaneous work.'),
      tags: ['playbook.busy'],
      invoke: [
        {
          id: 'coder-call',
          src: 'player',
          input: {
            stateId: 'work',
            role: 'coder',
            sourceItem: 'COLLISION-1',
            prompt: 'Code.',
            result: { complete: 'Complete.' },
          },
          onDone: 'ready',
          onError: 'ready',
        },
        {
          id: 'reviewer-call',
          src: 'player',
          input: {
            stateId: 'work',
            role: 'reviewer',
            sourceItem: 'COLLISION-2',
            prompt: 'Review.',
            result: { complete: 'Complete.' },
          },
          onDone: 'ready',
          onError: 'ready',
        },
      ],
    },
    reviewerDeclaration: {
      meta: roleMeta(
        'reviewerDeclaration',
        'reviewer',
        'Declare the Reviewer role.',
      ),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'reviewerDeclaration',
          role: 'reviewer',
          sourceItem: 'COLLISION-DECLARATION',
          prompt: 'Unused.',
          result: { complete: 'Complete.' },
        },
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

describe('DR-032 resolved-player concurrency', () => {
  it('rejects an aliased overlap before a second host call', async () => {
    const hostCalls = vi.fn(
      (_roleId: string, _prompt: string, signal: AbortSignal) =>
        new Promise<PlayerResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const telemetry: unknown[] = [];
    const runtime = createXStatePlaybookRuntime(collisionMachine, {
      label: 'ROLE-COLLISION',
      compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
      snapshotOptions: () => ({}),
      entryEvent: { type: 'START', textField: 'task' },
      roleStates: {
        work: { role: 'coder', label: 'Run simultaneous work.' },
        reviewerDeclaration: {
          role: 'reviewer',
          label: 'Declare the Reviewer role.',
        },
      },
    })({});
    await runtime.init(
      session(recordingPorts(hostCalls, telemetry), {
        roleBindings: {
          coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
          reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
        },
      }),
    );

    await runtime.handleBossInput(bossTurn('start'));

    expect(hostCalls).toHaveBeenCalledTimes(1);
    const finishes = telemetry
      .map((entry) => entry as { topic: string; payload: Record<string, unknown> })
      .filter(
        ({ topic, payload }) =>
          topic === 'playbook.trace' && payload.type === 'player.call.finished',
      )
      .map(({ payload }) => payload.payload as Record<string, unknown>);
    expect(finishes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          playerId: 'dev.shared',
          status: 'error',
          error: expect.objectContaining({
            message: expect.stringContaining('player key dev.shared'),
          }),
        }),
      ]),
    );
    await runtime.dispose();
  });
});
