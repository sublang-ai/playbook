// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  assign,
  createActor,
  createMachine,
  enqueueActions,
  fromPromise,
} from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import {
  ACCEPTED_OUTCOME_ACTION_TYPE,
  createAcceptedOutcomeConsumer,
} from './accepted-outcome.js';
import type {
  PlaybookEffectLedger,
  PlaybookEffectLedgerCommandBatch,
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
  detachPersistedMachineSnapshot,
  emptyPlaybookEffectLedger,
  normalizePlaybookSnapshot,
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
    readonly acknowledgedClassifications?: readonly PlaybookRepositoryReceipt['classification'][];
    readonly attemptId?: string;
    readonly initialLedger?: PlaybookEffectLedger;
    readonly startAcknowledgement?: Promise<void>;
    readonly completionAcknowledgement?: Promise<void>;
    readonly finalWriteAcknowledgement?: Promise<void>;
    readonly correctionWriteAcknowledgement?: Promise<void>;
    readonly afterCorrectionWrite?: () => void;
    readonly failCorrectionWrite?: boolean;
    readonly mismatchCorrectionAcknowledgement?: boolean;
    readonly omitAcknowledgedSemanticCandidate?: boolean;
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
    outcomeReceipt: PlaybookRepositoryReceipt,
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
    })({ boundary, operation, receipt, outcomeReceipt });
  const completedBoundary = (
    started: Record<string, unknown>,
    receipt: PlaybookRepositoryReceipt,
    completion: {
      readonly finalText?: string;
      readonly semanticCandidate?: unknown;
    },
    logicalOperationId?: string,
  ) => {
    const candidateChanged =
      Object.prototype.hasOwnProperty.call(started, 'semanticCandidate') &&
      completion.semanticCandidate !== undefined &&
      JSON.stringify(started.semanticCandidate) !==
        JSON.stringify(completion.semanticCandidate);
    return {
      ...started,
      ...(receipt.after === undefined ? {} : { after: receipt.after }),
      physicalReceipt: receipt,
      ...(completion.finalText === undefined
        ? {}
        : { finalText: completion.finalText }),
      ...(completion.semanticCandidate === undefined
        ? {}
        : { semanticCandidate: completion.semanticCandidate }),
      ...(candidateChanged
        ? { initialSemanticCandidate: started.semanticCandidate }
        : {}),
      ...(logicalOperationId === undefined ? {} : { logicalOperationId }),
    };
  };
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
    const outcomeReceipt = receiptFor(
      classification,
      baseline,
      currentCallIndex,
    );
    updateObservation(outcomeReceipt);
    const completion = await completionFor(
      input,
      started,
      operation,
      outcomeReceipt,
      outcomeReceipt,
    );
    await options.finalWriteAcknowledgement;
    if (options.failAfterCompletionAt?.includes(currentCallIndex)) {
      throw new Error('effect boundary final write acknowledgement unavailable');
    }
    const acknowledgedClassification =
      options.acknowledgedClassifications?.[currentCallIndex] ??
      classification;
    const receipt = receiptFor(
      acknowledgedClassification,
      baseline,
      currentCallIndex,
    );
    updateObservation(receipt);
    const operationId = completion.deferred?.operationId;
    const eligible =
      completion.deferred !== undefined &&
      receipt.after !== undefined &&
      receipt.after.head === baseline.head &&
      (acknowledgedClassification === 'unchanged' ||
        acknowledgedClassification === 'worktree-only-change');
    const acknowledgedStart =
      ledger.boundaries.find(
        ({ boundaryId }) => boundaryId === started.boundaryId,
      ) ?? started;
    const acknowledgedCompletion = options.omitAcknowledgedSemanticCandidate
      ? (({ semanticCandidate: _candidate, ...evidence }) => evidence)(
          completion,
        )
      : completion;
    const completed = completedBoundary(
      acknowledgedStart,
      receipt,
      acknowledgedCompletion,
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
    const logicalReceipt: PlaybookRepositoryReceipt = {
      classification,
      baseline: logical.originalBaseline,
      ...(receipt.after === undefined ? {} : { after: receipt.after }),
      ...(classification === 'one-descendant-commit' && receipt.commitOid
        ? { commitOid: receipt.commitOid }
        : {}),
    };
    const completion = await completionFor(
      input,
      started,
      operation,
      receipt,
      logicalReceipt,
    );
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
    const acknowledgedStart =
      ledger.boundaries.find(
        ({ boundaryId }) => boundaryId === started.boundaryId,
      ) ?? started;
    const completed = completedBoundary(
      acknowledgedStart,
      receipt,
      completion,
      operationId,
    );
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
      writeAhead: vi.fn(
        async (
          commands: PlaybookEffectLedgerCommandBatch,
        ): Promise<PlaybookEffectLedger> => {
          if (
            commands.length !== 1 ||
            commands[0].kind !== 'replace-boundaries'
          ) {
            throw new Error(
              'test effect ledger accepts only one replace-boundaries command',
            );
          }
          const replacements = commands[0].replacements;
          const boundaries = [...ledger.boundaries];
          for (const { expected, next } of replacements) {
            const index = boundaries.findIndex(
              ({ boundaryId }) => boundaryId === expected.boundaryId,
            );
            if (
              index < 0 ||
              JSON.stringify(boundaries[index]) !== JSON.stringify(expected)
            ) {
              throw new Error('effect ledger replace-boundaries CAS failed');
            }
            boundaries[index] = next;
          }
          if (options.failCorrectionWrite) {
            throw new Error('effect ledger correction spend unavailable');
          }
          const priorLedger = ledger;
          const nextLedger = assertPlaybookEffectLedger({
            ...ledger,
            revision: ledger.revision + 1,
            boundaries,
          });
          await options.correctionWriteAcknowledgement;
          ledger = nextLedger;
          options.afterCorrectionWrite?.();
          return options.mismatchCorrectionAcknowledgement
            ? priorLedger
            : ledger;
        },
      ),
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
        onDone: {
          target: 'ready',
          actions: {
            type: ACCEPTED_OUTCOME_ACTION_TYPE,
            params: {
              source: 'work',
              target: 'ready',
              acceptedOutcome: 'complete',
            },
          },
        },
        onError: 'ready',
      },
    },
  },
});

const acceptedOutcomeParams = (task: string) => {
  const marker = {
    source: task === 'unconfirmed-source' ? 'other' : 'work',
    target: task === 'mismatch' ? 'fallback' : 'accepted',
    acceptedOutcome: task === 'undeclared' ? 'unknown' : 'complete',
  };
  return task === 'malformed' || task === 'malformed-then-valid'
    ? { ...marker, extra: true }
    : marker;
};

const acceptedOutcomeActions = enqueueActions<
  { task: string },
  { type: string },
  undefined
>(({ context, enqueue }) => {
  const marker = (params: Record<string, unknown>) =>
    enqueue({ type: ACCEPTED_OUTCOME_ACTION_TYPE, params });
  const params = acceptedOutcomeParams(context.task);
  marker(params);
  if (context.task === 'malformed-then-valid') {
    marker({
      source: 'work',
      target: 'accepted',
      acceptedOutcome: 'complete',
    });
  } else if (context.task === 'duplicate') {
    marker({ ...params, target: 'fallback', acceptedOutcome: 'alternate' });
  }
});

const acceptedOutcomeMachine = createMachine({
  id: 'accepted-outcome',
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
          sourceItem: 'ROLE-OUTCOME-1',
          prompt: `Implement ${context.task}.`,
          result: {
            complete: 'The task is complete.',
            alternate: 'The task took the alternate accepted arm.',
          },
        }),
        onDone: [
          {
            guard: ({ context }) => context.task !== 'fallback',
            target: 'accepted',
            actions: acceptedOutcomeActions,
          },
          { target: 'fallback' },
        ],
        onError: 'fallback',
      },
    },
    accepted: {
      meta: stateMeta('accepted', 'The outcome was accepted.'),
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
    fallback: {
      meta: stateMeta('fallback', 'The stricter guard rejected the outcome.'),
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
  },
});

const semanticEvidenceMachine = createMachine({
  id: 'role-semantic-evidence',
  context: {
    task: '',
    delivered: undefined as Record<string, unknown> | undefined,
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
            delivered: () => undefined,
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
          sourceItem: 'ROLE-SEMANTIC-1',
          prompt: `Implement ${context.task}.`,
          result: {
            complete:
              'The task is complete. Output includes `message`, `irNumber`, and `latestCommit`.',
          },
        }),
        onDone: {
          target: 'delivered',
          actions: assign({
            delivered: ({ event }) =>
              (event as { output: Record<string, unknown> }).output,
          }),
        },
        onError: 'unresolved',
      },
    },
    delivered: {
      meta: stateMeta('delivered', 'The reconciled result was delivered.'),
      tags: ['playbook.parked'],
    },
    unresolved: {
      meta: stateMeta('unresolved', 'Semantic evidence remains unresolved.'),
      tags: ['playbook.parked'],
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
    compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    roleStates: { work: { role: 'coder', label: 'Implement the task.' } },
    outcomeAuthority: repeatOutcomeAuthority,
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

const semanticEffectOutcomeAuthority: XStateOutcomeAuthoritySpec = {
  governedPlayerStates: {
    work: {
      complete: {
        fields: {
          message: 'presentation',
          irNumber: 'semantic',
          latestCommit: 'effect',
        },
        repositoryDisposition: 'one-descendant-commit',
      },
    },
  },
};

function semanticEvidenceSchema3Spec(): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return {
    ...repeatSchema3Spec(),
    label: 'ROLE-SEMANTIC',
    extractRequiredFields: () => ['message', 'irNumber', 'latestCommit'],
    verbatimPayloadFields: new Set(['message']),
    outcomeAuthority: semanticEffectOutcomeAuthority,
  };
}

function repeatSchema3Spec(
  overrides: Partial<XStatePlaybookRuntimeSpecV3<EmptyOptions>> = {},
): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return repeatSpec(overrides);
}

function acceptedOutcomeSchema3Spec(): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return repeatSchema3Spec({
    label: 'ROLE-OUTCOME',
    classifyBossText: async (text) => ({ type: 'START', task: text }),
    outcomeAuthority: {
      governedPlayerStates: {
        work: {
          complete: { fields: {}, repositoryDisposition: 'unchanged' },
          alternate: { fields: {}, repositoryDisposition: 'unchanged' },
        },
      },
    },
  });
}

function retrySchema3Spec(
  overrides: Partial<XStatePlaybookRuntimeSpecV3<EmptyOptions>> = {},
): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return repeatSchema3Spec({
    entryEvent: {
      type: 'START',
      textField: 'task',
      contextField: 'task',
    },
    ...overrides,
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

function unchangedBossSchema3Spec(): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return {
    ...deferredBossSchema3Spec(),
    outcomeAuthority: {
      governedPlayerStates: {
        work: {
          complete: {
            fields: {},
            repositoryDisposition: 'unchanged',
          },
          needsBossReply: {
            fields: { question: 'presentation' },
            repositoryDisposition: 'unchanged',
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
  it('advertises artifact schema 3 and rejects legacy declarations', () => {
    expect(SUPPORTED_ARTIFACT_SCHEMAS).toEqual([3]);
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
    ).toThrow('supports [3]');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('supports [3]');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: undefined,
      }),
    ).toThrow('roleStates must be supplied for schema 3');

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
    const { outcomeAuthority: _outcomeAuthority, ...authorityMissingSpec } =
      repeatSpec();
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        authorityMissingSpec as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
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
    ).toThrow(
      'outcomeAuthority deferred state work must be registered in resumableStateIds',
    );
    expect(() =>
      createXStatePlaybookRuntime(
        deferredBossMachine,
        deferredBossSchema3Spec(),
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

  it('publishes confirmed schema-3 accepted outcomes before settlement', async () => {
    const telemetry: unknown[] = [];
    const statuses: string[] = [];
    let releaseAcceptedOutcome!: () => void;
    let observeAcceptedOutcome!: () => void;
    const acceptedOutcomeBlocked = new Promise<void>((resolve) => {
      releaseAcceptedOutcome = resolve;
    });
    const acceptedOutcomeObserved = new Promise<void>((resolve) => {
      observeAcceptedOutcome = resolve;
    });
    const ports: PlaybookPorts = {
      ...recordingPorts(async () => ({
        status: 'ok',
        finalText: 'Implemented.',
      })),
      emitStatus: async (message) => {
        statuses.push(message);
      },
      emitTelemetry: async (event) => {
        telemetry.push(event);
        const payload = event.payload as Record<string, unknown>;
        if (
          event.topic === 'playbook.trace' &&
          payload.type === 'outcome.accepted'
        ) {
          observeAcceptedOutcome();
          await acceptedOutcomeBlocked;
        }
      },
    };
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      acceptedOutcomeMachine,
      acceptedOutcomeSchema3Spec(),
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
    await runtime.init(session(ports));

    let settled = false;
    const turn = runtime.handleBossInput(bossTurn('accept')).then((result) => {
      settled = true;
      return result;
    });
    await acceptedOutcomeObserved;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(statuses).not.toContain('→ complete');
    releaseAcceptedOutcome();
    await turn;

    expect(statuses).toContain('→ complete');
    const traces = telemetry
      .map((event) => event as { topic: string; payload: Record<string, unknown> })
      .filter(
        ({ topic, payload }) =>
          topic === 'playbook.trace' && payload.type === 'outcome.accepted',
      );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.payload).toMatchObject({
      schemaVersion: 4,
      payload: {
        source: 'work',
        target: 'accepted',
        acceptedOutcome: 'complete',
      },
    });
    await runtime.dispose();
  });

  it('publishes no schema-3 outcome when a stricter guard selects fallback', async () => {
    const telemetry: unknown[] = [];
    const statuses: string[] = [];
    const ports: PlaybookPorts = {
      ...recordingPorts(async () => ({
        status: 'ok',
        finalText: 'Implemented.',
      }), telemetry),
      emitStatus: async (message) => {
        statuses.push(message);
      },
    };
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      acceptedOutcomeMachine,
      acceptedOutcomeSchema3Spec(),
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
    await runtime.init(session(ports));

    await runtime.handleBossInput(bossTurn('fallback'));

    expect(statuses).not.toContain('→ complete');
    expect(
      telemetry.some((event) => {
        const candidate = event as {
          topic?: string;
          payload?: { type?: string };
        };
        return (
          candidate.topic === 'playbook.trace' &&
          candidate.payload?.type === 'outcome.accepted'
        );
      }),
    ).toBe(false);
    await runtime.dispose();
  });

  it('fails closed on invalid markers and clears them before a later snapshot', async () => {
    for (const [task, diagnostic] of [
      ['malformed', 'params must contain exactly'],
      ['malformed-then-valid', 'params must contain exactly'],
      ['undeclared', 'names undeclared outcome work.unknown'],
      ['duplicate', 'source work was instrumented more than once'],
    ] as const) {
      const telemetry: unknown[] = [];
      const statuses: string[] = [];
      const ports: PlaybookPorts = {
        ...recordingPorts(async () => ({
          status: 'ok',
          finalText: 'Implemented.',
        }), telemetry),
        emitStatus: async (message) => {
          statuses.push(message);
        },
      };
      const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
        acceptedOutcomeMachine,
        acceptedOutcomeSchema3Spec(),
      )({
        configuredOptions: {},
        hostCapabilities: emptyLedgerHostCapabilities(),
      });
      await runtime.init(session(ports));

      await expect(runtime.handleBossInput(bossTurn(task))).rejects.toThrow(
        diagnostic,
      );
      expect(statuses).not.toContain('→ complete');
      expect(JSON.stringify(telemetry)).not.toContain('outcome.accepted');
      await runtime.dispose();
    }

    const telemetry: unknown[] = [];
    const statuses: string[] = [];
    const ports: PlaybookPorts = {
      ...recordingPorts(async () => ({
        status: 'ok',
        finalText: 'Implemented.',
      }), telemetry),
      emitStatus: async (message) => {
        statuses.push(message);
      },
    };
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      acceptedOutcomeMachine,
      acceptedOutcomeSchema3Spec(),
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
    await runtime.init(session(ports));

    await expect(runtime.handleBossInput(bossTurn('mismatch'))).rejects.toThrow(
      'target fallback was not confirmed by the public root snapshot',
    );
    expect(JSON.stringify(telemetry)).not.toContain('outcome.accepted');
    const secondTurnStart = telemetry.length;
    await runtime.handleBossInput(bossTurn('accept'));
    const secondTurnTransitions = telemetry
      .slice(secondTurnStart)
      .filter(
        (event) =>
          (event as { topic?: string }).topic === 'playbook.fsm.state',
      ) as Array<{ payload: { previousState?: { stateId?: string } } }>;
    expect(secondTurnTransitions[0]?.payload.previousState?.stateId).toBe(
      'accepted',
    );
    expect(
      telemetry.filter((event) =>
        JSON.stringify(event).includes('outcome.accepted'),
      ),
    ).toHaveLength(1);
    expect(statuses.filter((status) => status === '→ complete')).toHaveLength(1);
    await runtime.dispose();
  });

  it('does not claim a schema-3 status when accepted trace delivery fails', async () => {
    const statuses: string[] = [];
    const ports: PlaybookPorts = {
      ...recordingPorts(async () => ({
        status: 'ok',
        finalText: 'Implemented.',
      })),
      emitStatus: async (message) => {
        statuses.push(message);
      },
      emitTelemetry: async (event) => {
        const trace = event.payload as { type?: string };
        if (event.topic === 'playbook.trace' && trace.type === 'outcome.accepted') {
          throw new Error('accepted trace unavailable');
        }
      },
    };
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      acceptedOutcomeMachine,
      acceptedOutcomeSchema3Spec(),
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
    await runtime.init(session(ports));

    await expect(runtime.handleBossInput(bossTurn('accept'))).rejects.toThrow(
      'accepted trace unavailable',
    );
    expect(statuses).not.toContain('→ complete');
    await runtime.dispose();
  });

  it('rejects an initial-entry marker without a prior public root snapshot', async () => {
    const telemetry: unknown[] = [];
    const statuses: string[] = [];
    const initialMarkerMachine = createMachine({
      id: 'initial-accepted-outcome',
      initial: 'ready',
      states: {
        ready: {
          meta: stateMeta('ready', 'Waiting.'),
          tags: ['playbook.parked'],
          entry: {
            type: ACCEPTED_OUTCOME_ACTION_TYPE,
            params: {
              source: 'work',
              target: 'ready',
              acceptedOutcome: 'complete',
            },
          },
        },
        work: {
          meta: roleMeta('work', 'coder', 'Implement the task.'),
          tags: ['playbook.busy'],
          invoke: {
            src: 'player',
            input: {
              stateId: 'work',
              role: 'coder',
              sourceItem: 'ROLE-OUTCOME-1',
              prompt: 'Implement the task.',
              result: {
                complete: 'The task is complete.',
                alternate: 'The task took the alternate accepted arm.',
              },
            },
            onDone: 'ready',
            onError: 'ready',
          },
        },
      },
    });
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      initialMarkerMachine,
      acceptedOutcomeSchema3Spec(),
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });

    await expect(
      runtime.init(
        session({
          ...recordingPorts(async () => ({
            status: 'ok',
            finalText: 'unused',
          }), telemetry),
          emitStatus: async (message) => {
            statuses.push(message);
          },
        }),
      ),
    ).rejects.toThrow('marker has no prior public root snapshot');
    expect(JSON.stringify(telemetry)).not.toContain('outcome.accepted');
    expect(statuses).not.toContain('→ complete');
    await runtime.dispose();

    const unconfirmedSourceMachine = createMachine({
      id: 'unconfirmed-source-accepted-outcome',
      initial: 'ready',
      states: {
        ready: {
          meta: stateMeta('ready', 'Waiting.'),
          tags: ['playbook.parked'],
          on: {
            START: {
              target: 'accepted',
              actions: {
                type: ACCEPTED_OUTCOME_ACTION_TYPE,
                params: {
                  source: 'work',
                  target: 'accepted',
                  acceptedOutcome: 'complete',
                },
              },
            },
          },
        },
        accepted: {
          meta: stateMeta('accepted', 'Accepted.'),
          tags: ['playbook.parked'],
        },
        work: {
          meta: roleMeta('work', 'coder', 'Implement the task.'),
          tags: ['playbook.busy'],
          invoke: {
            src: 'player',
            input: {
              stateId: 'work',
              role: 'coder',
              sourceItem: 'ROLE-OUTCOME-1',
              prompt: 'Implement the task.',
              result: {
                complete: 'The task is complete.',
                alternate: 'The task took the alternate accepted arm.',
              },
            },
            onDone: 'accepted',
            onError: 'accepted',
          },
        },
      },
    });
    const unconfirmedSourceRuntime = createXStatePlaybookRuntime<
      EmptyOptions,
      object
    >(unconfirmedSourceMachine, acceptedOutcomeSchema3Spec())({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
    const unconfirmedTelemetry: unknown[] = [];
    await unconfirmedSourceRuntime.init(
      session(
        recordingPorts(
          async () => ({ status: 'ok', finalText: 'unused' }),
          unconfirmedTelemetry,
        ),
      ),
    );
    await expect(
      unconfirmedSourceRuntime.handleBossInput(bossTurn('unconfirmed')),
    ).rejects.toThrow(
      'source work was not confirmed by the prior public root snapshot',
    );
    expect(JSON.stringify(unconfirmedTelemetry)).not.toContain(
      'outcome.accepted',
    );
    await unconfirmedSourceRuntime.dispose();
  });

  it('confirms parallel markers in execution order and rejects duplicates', () => {
    const marker = (
      source: string,
      target: string,
      acceptedOutcome: string,
    ) => ({
      type: ACCEPTED_OUTCOME_ACTION_TYPE,
      params: { source, target, acceptedOutcome },
    });
    const parallelMachine = createMachine({
      id: 'parallel-accepted-outcomes',
      type: 'parallel',
      states: {
        left: {
          initial: 'waiting',
          states: {
            waiting: {
              meta: stateMeta('leftWork', 'Left outcome pending.'),
              on: {
                ACCEPT: {
                  target: 'done',
                  actions: marker('leftWork', 'leftDone', 'leftComplete'),
                },
              },
            },
            done: {
              meta: stateMeta('leftDone', 'Left outcome accepted.'),
            },
          },
        },
        right: {
          initial: 'waiting',
          states: {
            waiting: {
              meta: stateMeta('rightWork', 'Right outcome pending.'),
              on: {
                ACCEPT: {
                  target: 'done',
                  actions: marker('rightWork', 'rightDone', 'rightComplete'),
                },
              },
            },
            done: {
              meta: stateMeta('rightDone', 'Right outcome accepted.'),
            },
          },
        },
      },
    });
    const consumer = createAcceptedOutcomeConsumer(
      (source, outcome) =>
        (source === 'leftWork' && outcome === 'leftComplete') ||
        (source === 'rightWork' && outcome === 'rightComplete'),
    );
    const confirmed: unknown[] = [];
    let previousParallelState:
      | ReturnType<typeof normalizePlaybookSnapshot>
      | undefined;
    let rootActor: ReturnType<typeof createActor>;
    let inspectionError: unknown;
    rootActor = createActor(parallelMachine, {
      inspect: (event) => {
        if (event.actorRef !== rootActor) return;
        try {
          if (event.type === '@xstate.action') {
            consumer.capture(event.action);
          } else if (event.type === '@xstate.snapshot') {
            const state = normalizePlaybookSnapshot(event.snapshot);
            confirmed.push(
              ...consumer.confirm(previousParallelState ?? state, state),
            );
            previousParallelState = state;
          }
        } catch (error) {
          inspectionError = error;
        }
      },
    });
    rootActor.start();
    rootActor.send({ type: 'ACCEPT' });

    expect(inspectionError).toBeUndefined();
    expect(confirmed).toEqual([
      {
        source: 'leftWork',
        target: 'leftDone',
        acceptedOutcome: 'leftComplete',
      },
      {
        source: 'rightWork',
        target: 'rightDone',
        acceptedOutcome: 'rightComplete',
      },
    ]);
    rootActor.stop();

    const duplicateMachine = createMachine({
      id: 'duplicate-accepted-outcome',
      initial: 'waiting',
      states: {
        waiting: {
          meta: stateMeta('work', 'Outcome pending.'),
          on: {
            ACCEPT: {
              target: 'done',
              actions: [
                marker('work', 'done', 'complete'),
                marker('work', 'done', 'complete'),
              ],
            },
          },
        },
        done: { meta: stateMeta('done', 'Outcome accepted.') },
      },
    });
    const duplicateConsumer = createAcceptedOutcomeConsumer(
      (source, outcome) => source === 'work' && outcome === 'complete',
    );
    const duplicateConfirmed: unknown[] = [];
    let previousDuplicateState:
      | ReturnType<typeof normalizePlaybookSnapshot>
      | undefined;
    let duplicateActor: ReturnType<typeof createActor>;
    let duplicateError: unknown;
    duplicateActor = createActor(duplicateMachine, {
      inspect: (event) => {
        if (event.actorRef !== duplicateActor) return;
        try {
          if (event.type === '@xstate.action') {
            duplicateConsumer.capture(event.action);
          } else if (event.type === '@xstate.snapshot') {
            const state = normalizePlaybookSnapshot(event.snapshot);
            duplicateConfirmed.push(
              ...duplicateConsumer.confirm(
                previousDuplicateState ?? state,
                state,
              ),
            );
            previousDuplicateState = state;
          }
        } catch (error) {
          duplicateError = error;
        }
      },
    });
    duplicateActor.start();
    duplicateActor.send({ type: 'ACCEPT' });

    expect(duplicateError).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          'source work was instrumented more than once',
        ),
      }),
    );
    expect(duplicateConfirmed).toEqual([]);
    duplicateActor.stop();

    const unconfirmedSourceConsumer = createAcceptedOutcomeConsumer(
      (source, outcome) => source === 'work' && outcome === 'complete',
    );
    unconfirmedSourceConsumer.capture(marker('work', 'done', 'complete'));
    expect(() =>
      unconfirmedSourceConsumer.confirm(
        {
          value: 'other',
          activeStateIds: ['other'],
          tags: [],
          status: 'active',
          quiescent: true,
          stateId: 'other',
        },
        {
          value: 'done',
          activeStateIds: ['done'],
          tags: [],
          status: 'active',
          quiescent: true,
          stateId: 'done',
        },
      ),
    ).toThrow('source work was not confirmed by the prior public root snapshot');

    const initialEntryConsumer = createAcceptedOutcomeConsumer(
      (source, outcome) => source === 'work' && outcome === 'complete',
    );
    initialEntryConsumer.capture(marker('work', 'work', 'complete'));
    expect(() =>
      initialEntryConsumer.confirm(undefined, {
        value: 'work',
        activeStateIds: ['work'],
        tags: [],
        status: 'active',
        quiescent: true,
        stateId: 'work',
      }),
    ).toThrow('marker has no prior public root snapshot');

    const poisonedConsumer = createAcceptedOutcomeConsumer(
      (source, outcome) => source === 'work' && outcome === 'complete',
    );
    expect(() =>
      poisonedConsumer.capture({
        type: ACCEPTED_OUTCOME_ACTION_TYPE,
        params: {
          source: 'work',
          target: 'done',
          acceptedOutcome: 'complete',
          extra: true,
        },
      }),
    ).toThrow('params must contain exactly');
    expect(() =>
      poisonedConsumer.capture(marker('work', 'done', 'complete')),
    ).not.toThrow();
    expect(
      poisonedConsumer.confirm(
        {
          value: 'work',
          activeStateIds: ['work'],
          tags: [],
          status: 'active',
          quiescent: true,
          stateId: 'work',
        },
        {
          value: 'done',
          activeStateIds: ['done'],
          tags: [],
          status: 'active',
          quiescent: true,
          stateId: 'done',
        },
      ),
    ).toEqual([]);
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

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { outcome: 'quiescent', state: { stateId: 'ready' } },
    );

    expect(callPlayer).toHaveBeenCalledTimes(1);
    expect(runtime.exportSnapshot?.()?.effectLedger.boundaries[0]).toMatchObject({
      finalText: 'done',
      semanticCandidate: { guard: 'complete' },
      correctionBudget: { limit: 1, spent: false },
    });
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

  it('reconciles semantic, effect, and opaque presentation evidence before FSM delivery', async () => {
    const foreignOid = 'f'.repeat(40);
    const finalText = `Implemented without claiming ${foreignOid}.`;
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText,
    }));
    const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () =>
      '{"guard":"complete","irNumber":"048"}',
    );
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        semanticEvidenceMachine,
        semanticEvidenceSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session({ ...recordingPorts(callPlayer), callJudge });
    const runtime = createRuntime();
    await runtime.init(boundSession);

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { state: { stateId: 'delivered' } },
    );

    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.machine).toMatchObject({
      context: {
        delivered: {
          guard: 'complete',
          message: finalText,
          irNumber: '048',
          latestCommit: '2'.repeat(40),
        },
      },
    });
    expect(snapshot?.effectLedger.boundaries[0]).toMatchObject({
      finalText,
      semanticCandidate: { guard: 'complete', irNumber: '048' },
      physicalReceipt: {
        classification: 'one-descendant-commit',
        commitOid: '2'.repeat(40),
      },
      correctionBudget: { limit: 1, spent: false },
    });
    expect(
      JSON.stringify(snapshot?.effectLedger.boundaries[0]?.semanticCandidate),
    ).not.toContain(foreignOid);
    await runtime.dispose();
  });

  it('rejects a host acknowledgement that changes reconciled effect evidence', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
      acknowledgedClassifications: ['unchanged'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () =>
      '{"guard":"complete","irNumber":"048"}',
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session({ ...recordingPorts(callPlayer), callJudge }));

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'did not acknowledge the exact governed semantic evidence',
    );

    expect(callPlayer).toHaveBeenCalledOnce();
    expect(callJudge).toHaveBeenCalledOnce();
    expect(
      (runtime.exportSnapshot?.()?.machine as {
        context?: { delivered?: unknown };
      }).context?.delivered,
    ).toBeUndefined();
    await runtime.dispose();
  });

  it('delivers one complete retained envelope once and parks when its candidate is missing', async () => {
    const finalText = 'Implemented from durable evidence.';
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText,
    }));
    const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () =>
      '{"guard":"complete","irNumber":"048"}',
    );
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        semanticEvidenceMachine,
        semanticEvidenceSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session({ ...recordingPorts(callPlayer), callJudge });
    const completed = createRuntime();
    await completed.init(boundSession);
    await completed.handleBossInput(bossTurn('the task'));
    const completedSnapshot = completed.exportSnapshot?.();
    expect(completedSnapshot).toBeDefined();
    await completed.dispose();
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(callJudge).toHaveBeenCalledOnce();

    const suspendedActor = createActor(
      semanticEvidenceMachine.provide({
        actors: {
          player: fromPromise(
            () => new Promise<Record<string, unknown>>(() => undefined),
          ),
        },
      }),
    );
    suspendedActor.start();
    suspendedActor.send({ type: 'START', task: 'the task' });
    expect(normalizePlaybookSnapshot(suspendedActor.getSnapshot()).stateId).toBe(
      'work',
    );
    const retainedMachine = detachPersistedMachineSnapshot(
      suspendedActor.getPersistedSnapshot(),
    );
    const retainedState = normalizePlaybookSnapshot(
      suspendedActor.getSnapshot(),
    );
    suspendedActor.stop();
    const restartSnapshot = {
      ...completedSnapshot!,
      machine: retainedMachine,
      state: retainedState,
      pendingBossQuestions: [],
      retainedEffectSourceSessionId: boundSession.sessionId,
      retainedEffectReconciliation: {
        sourceSessionId: boundSession.sessionId,
        checkpoint: emptyPlaybookEffectLedger(),
      },
    };

    const restored = createRuntime();
    await restored.restore?.(boundSession, restartSnapshot);
    await vi.waitFor(() => {
      expect(restored.describe?.().state.stateId).toBe('delivered');
    });
    expect(restored.exportSnapshot?.()?.machine).toMatchObject({
      context: {
        delivered: {
          guard: 'complete',
          message: finalText,
          irNumber: '048',
          latestCommit: '2'.repeat(40),
        },
      },
    });
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(callJudge).toHaveBeenCalledOnce();
    expect(restored.exportSnapshot?.()).not.toHaveProperty(
      'retainedEffectReconciliation',
    );
    await restored.dispose();

    const retainedBoundary = completedSnapshot!.effectLedger.boundaries[0]!;
    const { semanticCandidate: _candidate, ...withoutCandidate } =
      retainedBoundary;
    const missingCandidateLedger = assertPlaybookEffectLedger({
      ...completedSnapshot!.effectLedger,
      revision: completedSnapshot!.effectLedger.revision + 1,
      boundaries: [withoutCandidate],
    });
    hostCapabilities.replaceEffectLedger(missingCandidateLedger);
    const missingCandidateSnapshot = {
      ...restartSnapshot,
      effectLedger: missingCandidateLedger,
    };
    const fenced = createRuntime();
    await fenced.restore?.(boundSession, missingCandidateSnapshot);
    await vi.waitFor(() => {
      expect(fenced.describe?.().state.stateId).toBe('unresolved');
    });
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(callJudge).toHaveBeenCalledOnce();
    expect(
      fenced.exportSnapshot?.()?.effectLedger.boundaries[0]
        ?.semanticCandidate,
    ).toBeUndefined();
    expect(fenced.exportSnapshot?.()).toHaveProperty(
      'retainedEffectReconciliation',
    );
    await fenced.dispose();

    const operationId = '60000000-0000-4000-8000-000000000006';
    const linkedBoundary = {
      ...retainedBoundary,
      logicalOperationId: operationId,
    };
    const openLogicalLedger = assertPlaybookEffectLedger({
      ...completedSnapshot!.effectLedger,
      revision: completedSnapshot!.effectLedger.revision + 1,
      boundaries: [linkedBoundary],
      logicalOperations: [
        {
          sequence: 1,
          operationId,
          playbookId: linkedBoundary.playbookId,
          runtimeSessionId: linkedBoundary.runtimeSessionId,
          boundaryIds: [linkedBoundary.boundaryId],
          originalBaseline: linkedBoundary.baseline,
          checkpoint: linkedBoundary.after,
          pendingQuestion: {
            questionId: 'work',
            asker: { kind: 'role', roleId: 'coder' },
            question: 'Which target?',
          },
          playerContinuation: false,
          checkpointRestorationEligible: false,
        },
      ],
    });
    hostCapabilities.replaceEffectLedger(openLogicalLedger);
    const openLogical = createRuntime();
    await openLogical.restore?.(boundSession, {
      ...restartSnapshot,
      effectLedger: openLogicalLedger,
    });
    await vi.waitFor(() => {
      expect(openLogical.describe?.().state.stateId).toBe('unresolved');
    });
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(callJudge).toHaveBeenCalledOnce();
    expect(openLogical.exportSnapshot?.()).toHaveProperty(
      'retainedEffectReconciliation',
    );
    await openLogical.dispose();
  });

  it('awaits the durable correction spend before one corrective judge call', async () => {
    let acknowledgeCorrection!: () => void;
    const correctionWriteAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeCorrection = resolve;
    });
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
      correctionWriteAcknowledgement,
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi
      .fn<PlaybookPorts['callJudge']>()
      .mockResolvedValueOnce(
        '{"guard":"complete","irNumber":"048","message":"forged"}',
      )
      .mockResolvedValueOnce('{"guard":"complete","irNumber":"048"}');
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        semanticEvidenceMachine,
        semanticEvidenceSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session({ ...recordingPorts(callPlayer), callJudge });
    const runtime = createRuntime();
    await runtime.init(boundSession);

    const pending = runtime.handleBossInput(bossTurn('the task'));
    await vi.waitFor(() => {
      expect(hostCapabilities.effectLedger.writeAhead).toHaveBeenCalledOnce();
    });
    expect(callJudge).toHaveBeenCalledOnce();
    expect(
      hostCapabilities.effectLedger.snapshot().boundaries[0]?.correctionBudget,
    ).toEqual({ limit: 1, spent: false });
    acknowledgeCorrection();

    await expect(pending).resolves.toMatchObject({
      state: { stateId: 'delivered' },
    });
    expect(callJudge).toHaveBeenCalledTimes(2);
    expect(callJudge.mock.calls[1]?.[0]).toContain(
      'extra or wrongly owned message',
    );
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({
        semanticCandidate: { guard: 'complete', irNumber: '048' },
        initialSemanticCandidate: {
          guard: 'complete',
          irNumber: '048',
          message: 'forged',
        },
        correctionBudget: { limit: 1, spent: true },
      });
    await runtime.dispose();
  });

  it.each([
    [
      'missing semantic field',
      '{"guard":"complete"}',
      { guard: 'complete' },
    ],
    [
      'wrongly owned presentation field',
      '{"guard":"complete","irNumber":"048","message":"forged"}',
      { guard: 'complete', irNumber: '048', message: 'forged' },
    ],
    [
      'undeclared extra field',
      '{"guard":"complete","irNumber":"048","rogue":"value"}',
      { guard: 'complete', irNumber: '048', rogue: 'value' },
    ],
    ['malformed reply', 'not JSON', undefined],
  ])('parks after a second structurally invalid %s candidate', async (
    _label,
    reply,
    expectedCandidate,
  ) => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () => reply);
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(
      session({ ...recordingPorts(callPlayer), callJudge }),
    );

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { state: { stateId: 'unresolved' } },
    );

    expect(callJudge).toHaveBeenCalledTimes(2);
    expect(hostCapabilities.effectLedger.writeAhead).toHaveBeenCalledOnce();
    const completedBoundary =
      hostCapabilities.effectLedger.snapshot().boundaries[0];
    expect(completedBoundary).toMatchObject({
      finalText: 'Implemented.',
      correctionBudget: { limit: 1, spent: true },
    });
    if (expectedCandidate === undefined) {
      expect(completedBoundary).not.toHaveProperty('semanticCandidate');
    } else {
      expect(completedBoundary?.semanticCandidate).toEqual(expectedCandidate);
    }
    expect(
      (runtime.exportSnapshot?.()?.machine as {
        context?: { delivered?: unknown };
      }).context?.delivered,
    ).toBeUndefined();
    await runtime.dispose();
  });

  it('retains a valid candidate but parks an inconsistent repository receipt', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['multiple-commits'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () =>
      '{"guard":"complete","irNumber":"048"}',
    );
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        semanticEvidenceMachine,
        semanticEvidenceSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const telemetry: unknown[] = [];
    const boundSession = session({
      ...recordingPorts(callPlayer, telemetry),
      callJudge,
    });
    const runtime = createRuntime();
    await runtime.init(boundSession);

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { state: { stateId: 'unresolved' } },
    );

    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.effectLedger.boundaries[0]).toMatchObject({
      semanticCandidate: { guard: 'complete', irNumber: '048' },
      physicalReceipt: { classification: 'multiple-commits' },
      correctionBudget: { limit: 1, spent: false },
    });
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
    expect(hostCapabilities.effectLedger.writeAhead).not.toHaveBeenCalled();
    expect(callJudge).toHaveBeenCalledOnce();
    await runtime.dispose();

    const restored = createRuntime();
    await restored.restore?.(boundSession, snapshot!);
    expect(restored.describe?.().state.stateId).toBe('unresolved');
    await restored.handleBossInput(bossTurn('no authored transition'));
    const reconciliation = await restored.apply?.({
      actionId: 'reconcile:unresolved-effect',
      key: 'retry-unresolved-effect',
      signal: new AbortController().signal,
    });
    expect(reconciliation).toMatchObject({
      disposition: 'executed',
      run: { outcome: 'no-action', state: { stateId: 'unresolved' } },
    });
    const unresolvedState = restored.describe?.().state;
    const applyTraceCount = () =>
      telemetry.filter((event) => {
        const record = event as {
          topic?: unknown;
          payload?: { type?: unknown };
        };
        return (
          record.topic === 'playbook.trace' &&
          (record.payload?.type === 'apply.started' ||
            record.payload?.type === 'apply.finished')
        );
      }).length;
    const traceCountBeforeAbandonment = applyTraceCount();
    const abandonment = await restored.apply?.({
      actionId: 'abandon:unresolved-effect',
      key: 'abandon-unresolved-effect',
      signal: new AbortController().signal,
    });
    expect(abandonment).toEqual({
      disposition: 'executed',
      run: {
        outcome: 'unresolved-effect',
        state: unresolvedState,
      },
    });
    const traceCountAfterAbandonment = applyTraceCount();
    expect(traceCountAfterAbandonment).toBe(
      traceCountBeforeAbandonment + 2,
    );
    await expect(
      restored.apply?.({
        actionId: 'abandon:unresolved-effect',
        key: 'abandon-unresolved-effect',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(abandonment);
    expect(applyTraceCount()).toBe(traceCountAfterAbandonment);
    if (abandonment?.disposition === 'executed') {
      expect(Object.keys(abandonment.run).sort()).toEqual([
        'outcome',
        'state',
      ]);
      expect(abandonment.run.state).toMatchObject({
        stateId: 'unresolved',
        status: 'active',
        quiescent: true,
      });
      expect(abandonment.run.state.tags).toContain('playbook.parked');
    }
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(callJudge).toHaveBeenCalledOnce();
    await restored.dispose();
  });

  it('rejects an unresolved acknowledgement that drops retained semantic evidence', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['multiple-commits'],
      omitAcknowledgedSemanticCandidate: true,
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () =>
      '{"guard":"complete","irNumber":"048"}',
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session({ ...recordingPorts(callPlayer), callJudge }));

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'did not acknowledge the exact governed semantic evidence',
    );
    expect(callJudge).toHaveBeenCalledOnce();
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .not.toHaveProperty('semanticCandidate');
    await runtime.dispose();
  });

  it('parks judge transport failures without spending correction budget', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () => {
      throw new Error('judge transport unavailable');
    });
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(
      session({ ...recordingPorts(callPlayer), callJudge }),
    );

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { state: { stateId: 'unresolved' } },
    );
    expect(callJudge).toHaveBeenCalledOnce();
    expect(hostCapabilities.effectLedger.writeAhead).not.toHaveBeenCalled();
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({ correctionBudget: { limit: 1, spent: false } });
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .not.toHaveProperty('semanticCandidate');
    await runtime.dispose();
  });

  it('parks a non-string judge result without correction or retained candidate', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () =>
      ({ guard: 'complete' }) as unknown as string,
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session({ ...recordingPorts(callPlayer), callJudge }));

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { state: { stateId: 'unresolved' } },
    );
    expect(callJudge).toHaveBeenCalledOnce();
    expect(hostCapabilities.effectLedger.writeAhead).not.toHaveBeenCalled();
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({ correctionBudget: { limit: 1, spent: false } });
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .not.toHaveProperty('semanticCandidate');
    await runtime.dispose();
  });

  it.each([
    [
      'aborted result',
      { status: 'aborted', finalText: 'non-authoritative diagnostic' },
      1,
    ],
    [
      'error result',
      {
        status: 'error',
        error: 'player failed',
        finalText: 'non-authoritative diagnostic',
      },
      1,
    ],
    ['missing finalText', { status: 'ok' }, 2],
  ] as const)(
    'starts no semantic adjudication for a player %s',
    async (_label, playerResult, expectedPlayerCalls) => {
      const hostCapabilities = emptyLedgerHostCapabilities({
        classifications: Array(expectedPlayerCalls).fill('unchanged'),
      });
      const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () =>
        playerResult,
      );
      const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () =>
        '{"guard":"complete","irNumber":"048"}',
      );
      const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
        semanticEvidenceMachine,
        semanticEvidenceSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
      await runtime.init(session({ ...recordingPorts(callPlayer), callJudge }));

      await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
        { state: { stateId: 'unresolved' } },
      );
      expect(callPlayer).toHaveBeenCalledTimes(expectedPlayerCalls);
      expect(callJudge).not.toHaveBeenCalled();
      for (const boundary of hostCapabilities.effectLedger.snapshot().boundaries) {
        expect(boundary).not.toHaveProperty('semanticCandidate');
        expect(boundary).not.toHaveProperty('finalText');
      }
      await runtime.dispose();
    },
  );

  it.each(['abort', 'error'] as const)(
    'starts no semantic adjudication for a thrown player %s',
    async (kind) => {
      const controller = new AbortController();
      const failure = new Error(`player ${kind}`);
      const hostCapabilities = emptyLedgerHostCapabilities({
        classifications: ['unchanged'],
      });
      const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => {
        if (kind === 'abort') controller.abort(failure);
        throw failure;
      });
      const callJudge = vi.fn<PlaybookPorts['callJudge']>(async () =>
        '{"guard":"complete","irNumber":"048"}',
      );
      const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
        semanticEvidenceMachine,
        semanticEvidenceSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
      await runtime.init(session({ ...recordingPorts(callPlayer), callJudge }));

      const turn = runtime.handleBossInput({
        text: 'the task',
        signal: controller.signal,
      });
      if (kind === 'abort') {
        await expect(turn).resolves.toMatchObject({ outcome: 'aborted' });
      } else {
        await expect(turn).rejects.toBe(failure);
      }
      expect(callJudge).not.toHaveBeenCalled();
      expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
        .not.toHaveProperty('semanticCandidate');
      await runtime.dispose();
    },
  );

  it.each([
    [
      'transport failure',
      async () => {
        throw new Error('corrective judge unavailable');
      },
    ],
    [
      'result-shape failure',
      async () => ({ guard: 'complete' }) as unknown as string,
    ],
  ])('parks a corrective judge %s after the single durable spend', async (
    _label,
    correctiveReply,
  ) => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi
      .fn<PlaybookPorts['callJudge']>()
      .mockResolvedValueOnce('{"guard":"complete"}')
      .mockImplementationOnce(correctiveReply);
    const createRuntime = () =>
      createXStatePlaybookRuntime<EmptyOptions, object>(
        semanticEvidenceMachine,
        semanticEvidenceSchema3Spec(),
      )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session({ ...recordingPorts(callPlayer), callJudge });
    const runtime = createRuntime();
    await runtime.init(boundSession);

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { state: { stateId: 'unresolved' } },
    );
    expect(callJudge).toHaveBeenCalledTimes(2);
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({
        semanticCandidate: { guard: 'complete' },
        correctionBudget: { limit: 1, spent: true },
      });
    const snapshot = runtime.exportSnapshot?.();
    await runtime.dispose();

    const restored = createRuntime();
    await restored.restore?.(boundSession, snapshot!);
    await restored.handleBossInput(bossTurn('no authored transition'));
    expect(callJudge).toHaveBeenCalledTimes(2);
    await restored.dispose();
  });

  it('does not start a corrective judge after aborting an acknowledged spend', async () => {
    const controller = new AbortController();
    const abortReason = new Error('Boss cancelled during correction spend');
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
      afterCorrectionWrite: () => controller.abort(abortReason),
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi
      .fn<PlaybookPorts['callJudge']>()
      .mockResolvedValueOnce('{"guard":"complete"}')
      .mockResolvedValueOnce('{"guard":"complete","irNumber":"048"}');
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(
      session({ ...recordingPorts(callPlayer), callJudge }),
    );

    await expect(
      runtime.handleBossInput({ text: 'the task', signal: controller.signal }),
    ).resolves.toMatchObject({ outcome: 'aborted' });
    expect(callJudge).toHaveBeenCalledOnce();
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({
        semanticCandidate: { guard: 'complete' },
        correctionBudget: { limit: 1, spent: true },
      });
    await runtime.dispose();
  });

  it('retains the invalid candidate when a durable correction spend acknowledgement is lost', async () => {
    const interruption = new Error(
      'process interrupted after correction spend storage',
    );
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
      afterCorrectionWrite: () => {
        throw interruption;
      },
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const firstCandidate = { guard: 'complete' };
    const callJudge = vi
      .fn<PlaybookPorts['callJudge']>()
      .mockResolvedValueOnce(JSON.stringify(firstCandidate))
      .mockResolvedValueOnce('{"guard":"complete","irNumber":"048"}');
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    const boundSession = session({ ...recordingPorts(callPlayer), callJudge });
    await runtime.init(boundSession);

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toBe(
      interruption,
    );

    expect(callJudge).toHaveBeenCalledOnce();
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({
        finalText: 'Implemented.',
        semanticCandidate: firstCandidate,
        correctionBudget: { limit: 1, spent: true },
        physicalReceipt: { classification: 'one-descendant-commit' },
      });
    const interruptedSnapshot = runtime.exportSnapshot?.();
    expect(interruptedSnapshot).toBeDefined();
    await runtime.dispose();

    const restoredHost = emptyLedgerHostCapabilities({
      initialLedger: hostCapabilities.effectLedger.snapshot(),
    });
    const restored = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities: restoredHost });
    await restored.restore?.(boundSession, interruptedSnapshot!);
    await restored.handleBossInput(bossTurn('no authored transition'));
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(callJudge).toHaveBeenCalledOnce();
    expect(restored.exportSnapshot?.()?.effectLedger.boundaries[0])
      .toMatchObject({
        semanticCandidate: firstCandidate,
        correctionBudget: { limit: 1, spent: true },
      });
    await restored.dispose();
  });

  it('fails closed when the correction spend is not acknowledged', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
      failCorrectionWrite: true,
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const callJudge = vi
      .fn<PlaybookPorts['callJudge']>()
      .mockResolvedValueOnce('{"guard":"complete"}')
      .mockResolvedValueOnce('{"guard":"complete","irNumber":"048"}');
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(
      session({ ...recordingPorts(callPlayer), callJudge }),
    );

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'effect ledger correction spend unavailable',
    );
    expect(callJudge).toHaveBeenCalledOnce();
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({ correctionBudget: { limit: 1, spent: false } });
    await runtime.dispose();
  });

  it('starts no corrective judge from a mismatched spend acknowledgement', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
      mismatchCorrectionAcknowledgement: true,
    });
    const callPlayer = vi.fn<PlaybookPorts['callPlayer']>(async () => ({
      status: 'ok',
      finalText: 'Implemented.',
    }));
    const firstCandidate = { guard: 'complete' };
    const callJudge = vi
      .fn<PlaybookPorts['callJudge']>()
      .mockResolvedValueOnce(JSON.stringify(firstCandidate))
      .mockResolvedValueOnce('{"guard":"complete","irNumber":"048"}');
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      semanticEvidenceMachine,
      semanticEvidenceSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session({ ...recordingPorts(callPlayer), callJudge }));

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'semantic correction budget spend was not acknowledged exactly',
    );

    expect(callJudge).toHaveBeenCalledOnce();
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({
        semanticCandidate: firstCandidate,
        correctionBudget: { limit: 1, spent: true },
      });
    await runtime.dispose();
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
    const hostCapabilities = emptyLedgerHostCapabilities();
    const createRuntime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (input, promptIdentity) => {
          retainedLookup = promptIdentity;
          return `${promptIdentity(input.role)}\n\n${input.prompt}`;
        },
      }),
    );
    const runtime = createRuntime({ configuredOptions: {}, hostCapabilities });
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
      expect(payload.schemaVersion).toBe(4);
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

    const restored = createRuntime({ configuredOptions: {}, hostCapabilities });
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
    const createRuntime = createXStatePlaybookRuntime<EmptyOptions, object>(
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
      const runtime = createRuntime({
        configuredOptions: {},
        hostCapabilities: emptyLedgerHostCapabilities(),
      });
      await expect(runtime.init(session(ports, { roleBindings }))).rejects.toThrow(
        'must cover exactly [coder]',
      );
      await runtime.dispose();
    }

    const emptyIdentity = createRuntime({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
    await expect(
      emptyIdentity.init(
        session(ports, {
          roleBindings: { coder: { playerId: 'dev.coder', promptIdentity: ' ' } },
        }),
      ),
    ).rejects.toThrow('promptIdentity must be a non-empty string');
    await emptyIdentity.dispose();

    const lookup = createRuntime({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
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
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (input, promptIdentity) => {
          standalonePromptIdentities.push(promptIdentity(input.role));
          return input.prompt;
        },
      }),
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
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
      .mockResolvedValueOnce({
        status: 'error',
        error: 'try again',
        finalText: 'non-authoritative diagnostic prose',
      })
      .mockResolvedValue({ status: 'ok', finalText: 'done' });
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      retryMachine,
      retrySchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(recordingPorts(callPlayer)));

    const failed = await runtime.handleBossInput(bossTurn('the task'));
    expect(failed.state.stateId).toBe('failed');
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .not.toHaveProperty('finalText');
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

  it('parks after an invalid correction on a nonzero receipt without enabling replay', async () => {
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

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { outcome: 'failed', state: { stateId: 'failed' } },
    );
    expect(callPlayer).toHaveBeenCalledOnce();
    expect(ports.callJudge).toHaveBeenCalledTimes(2);
    expect(hostCapabilities.effectLedger.snapshot().boundaries[0])
      .toMatchObject({ correctionBudget: { limit: 1, spent: true } });
    expect(runtime.describe?.().actions.map(({ id }) => id)).not.toContain(
      'retry:START',
    );
    await runtime.dispose();
  });

  it('retains an earlier governed boundary when a suspended child resumes into failure', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
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
      retrySchema3Spec({
        outcomeAuthority: effectAuthorizedRepeatOutcomeAuthority,
      }),
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
  it('keeps a governed unchanged question outside the deferred protocol', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['unchanged', 'unchanged'],
    });
    const harness = deferredTestPorts(
      [
        {
          status: 'ok',
          finalText: 'Choose a format.',
          resumeToken: 'thread-question',
        },
        {
          status: 'ok',
          finalText: 'The unchanged review is complete.',
          resumeToken: 'thread-final',
        },
      ],
      ['{"guard":"needsBossReply"}', '{"guard":"complete"}'],
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      deferredBossMachine,
      unchangedBossSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(harness.ports));

    await expect(
      runtime.handleBossInput(bossTurn('the task')),
    ).resolves.toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply' },
    });
    const questionLedger = hostCapabilities.effectLedger.snapshot();
    expect(questionLedger.logicalOperations).toEqual([]);
    expect(questionLedger.boundaries).toMatchObject([
      {
        semanticCandidate: { guard: 'needsBossReply' },
        physicalReceipt: { classification: 'unchanged' },
      },
    ]);
    expect(runtime.describe?.().pendingQuestions).toMatchObject([
      { questionId: 'work', question: 'Choose a format.' },
    ]);
    expect(hostCapabilities.repository.runExclusive).toHaveBeenCalledOnce();
    expect(hostCapabilities.repository.runDeferred).not.toHaveBeenCalled();

    await expect(
      runtime.handleBossInput(bossTurn('markdown')),
    ).resolves.toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'ready' },
    });
    const completed = hostCapabilities.effectLedger.snapshot();
    expect(completed.logicalOperations).toEqual([]);
    expect(
      completed.boundaries.map(
        ({ physicalReceipt }) => physicalReceipt?.classification,
      ),
    ).toEqual(['unchanged', 'unchanged']);
    expect(harness.resumes).toEqual([false, 'thread-question']);
    expect(hostCapabilities.repository.runExclusive).toHaveBeenCalledTimes(2);
    expect(hostCapabilities.repository.runDeferred).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('withholds a governed unchanged question under nonmatching evidence', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['concurrent-or-foreign-change'],
    });
    const harness = deferredTestPorts(
      [
        {
          status: 'ok',
          finalText: 'Choose a format.',
          resumeToken: 'thread-question',
        },
      ],
      ['{"guard":"needsBossReply"}'],
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      deferredBossMachine,
      unchangedBossSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(harness.ports));

    await expect(
      runtime.handleBossInput(bossTurn('the task')),
    ).resolves.toMatchObject({ state: { stateId: 'ready' } });
    expect(hostCapabilities.effectLedger.snapshot()).toMatchObject({
      logicalOperations: [],
      boundaries: [
        {
          semanticCandidate: { guard: 'needsBossReply' },
          physicalReceipt: { classification: 'concurrent-or-foreign-change' },
        },
      ],
    });
    expect(runtime.describe?.().pendingQuestions).toEqual([]);
    expect(harness.callPlayer).toHaveBeenCalledOnce();
    expect(harness.callJudge).toHaveBeenCalledOnce();
    expect(hostCapabilities.repository.runDeferred).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('parks a deferred candidate whose complete receipt does not preserve HEAD', async () => {
    const hostCapabilities = emptyLedgerHostCapabilities({
      classifications: ['one-descendant-commit'],
    });
    const harness = deferredTestPorts(
      [
        {
          status: 'ok',
          finalText: 'Choose a format.',
          resumeToken: 'thread-question',
        },
      ],
      ['{"guard":"needsBossReply"}'],
    );
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      deferredBossMachine,
      deferredBossSchema3Spec(),
    )({ configuredOptions: {}, hostCapabilities });
    await runtime.init(session(harness.ports));

    await expect(runtime.handleBossInput(bossTurn('the task'))).resolves.toMatchObject(
      { state: { stateId: 'ready' } },
    );

    expect(hostCapabilities.effectLedger.snapshot()).toMatchObject({
      logicalOperations: [],
      boundaries: [
        {
          semanticCandidate: { guard: 'needsBossReply' },
          physicalReceipt: { classification: 'one-descendant-commit' },
          correctionBudget: { limit: 1, spent: false },
        },
      ],
    });
    expect(runtime.describe?.().pendingQuestions).toEqual([]);
    expect(harness.callJudge).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

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
          finalText: 'Choose a format.',
          resumeToken: 'thread-question',
        },
        {
          status: 'ok',
          finalText: 'Implemented and committed.',
          resumeToken: 'thread-final',
        },
      ],
      [
        '{"guard":"needsBossReply"}',
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
    expect(initialLedger.boundaries[0]).toMatchObject({
      finalText: 'Choose a format.',
      semanticCandidate: { guard: 'needsBossReply' },
    });
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
    expect(completed.boundaries[1]).toMatchObject({
      finalText: 'Implemented and committed.',
      semanticCandidate: { guard: 'complete' },
    });
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
          finalText: 'Choose a format.',
          resumeToken: 'thread-question',
        },
        { status: 'ok', finalText: 'done', resumeToken: 'thread-final' },
      ],
      [
        '{"guard":"needsBossReply"}',
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
      actions: [
        { id: 'reconcile:unresolved-effect' },
        { id: 'abandon:unresolved-effect' },
      ],
    });
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.pendingBossQuestions).toEqual([]);
    expect(JSON.stringify(snapshot?.machine)).not.toContain(
      'answer that must be discarded',
    );
    await runtime.dispose();

    const restored = createRuntime();
    await restored.restore?.(boundSession, snapshot!);
    await expect(
      restored.apply?.({
        actionId: 'reconcile:unresolved-effect',
        key: 'unequal-retry',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      disposition: 'executed',
      run: { outcome: 'no-action' },
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
        actionId: 'reconcile:unresolved-effect',
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
        { status: 'ok', finalText: 'First question?', resumeToken: 'thread-1' },
        { status: 'ok', finalText: 'Second question?', resumeToken: 'thread-2' },
        { status: 'ok', finalText: 'done', resumeToken: 'thread-3' },
      ],
      [
        '{"guard":"needsBossReply"}',
        '{"guard":"needsBossReply"}',
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
        {
          status: 'ok',
          finalText: 'Choose a format.',
          resumeToken: 'thread-question',
        },
      ],
      ['{"guard":"needsBossReply"}'],
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
      actions: [
        { id: 'reconcile:unresolved-effect' },
        { id: 'abandon:unresolved-effect' },
      ],
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
          { status: 'ok', finalText: 'First question?', resumeToken: 'thread-1' },
          { status: 'ok', finalText: 'Second question?', resumeToken: 'thread-2' },
        ],
        [
          '{"guard":"needsBossReply"}',
          '{"guard":"needsBossReply"}',
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
        onDone: {
          target: 'review',
          actions: {
            type: ACCEPTED_OUTCOME_ACTION_TYPE,
            params: {
              source: 'code',
              target: 'review',
              acceptedOutcome: 'complete',
            },
          },
        },
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
        onDone: {
          target: 'ready',
          actions: {
            type: ACCEPTED_OUTCOME_ACTION_TYPE,
            params: {
              source: 'review',
              target: 'ready',
              acceptedOutcome: 'complete',
            },
          },
        },
        onError: 'ready',
      },
    },
  },
});

const aliasSpec: XStatePlaybookRuntimeSpec<EmptyOptions> = {
  label: 'ROLE-ALIAS',
  compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {
    code: { role: 'coder', label: 'Draft a proposal.' },
    review: { role: 'reviewer', label: 'Review the proposal.' },
  },
  outcomeAuthority: {
    governedPlayerStates: {
      code: {
        complete: { fields: {}, repositoryDisposition: 'unchanged' },
      },
      review: {
        complete: { fields: {}, repositoryDisposition: 'unchanged' },
      },
    },
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
    const hostCapabilities = emptyLedgerHostCapabilities();
    const createRuntime = createXStatePlaybookRuntime<EmptyOptions, object>(
      aliasMachine,
      aliasSpec,
    );
    const runtime = createRuntime({ configuredOptions: {}, hostCapabilities });
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
    const restored = createRuntime({ configuredOptions: {}, hostCapabilities });
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
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      aliasMachine,
      aliasSpec,
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
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
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSpec(),
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
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
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      collisionMachine,
      {
        label: 'ROLE-COLLISION',
        compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: () => ({}),
        entryEvent: { type: 'START', textField: 'task' },
        roleStates: {
          work: { role: 'coder', label: 'Run simultaneous work.' },
          reviewerDeclaration: {
            role: 'reviewer',
            label: 'Declare the Reviewer role.',
          },
        },
        outcomeAuthority: {
          governedPlayerStates: {
            work: {
              complete: { fields: {}, repositoryDisposition: 'unchanged' },
            },
            reviewerDeclaration: {
              complete: { fields: {}, repositoryDisposition: 'unchanged' },
            },
          },
        },
      },
    )({
      configuredOptions: {},
      hostCapabilities: emptyLedgerHostCapabilities(),
    });
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
