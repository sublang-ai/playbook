// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PlaybookRepositoryDisposition =
  | 'unchanged'
  | 'one-descendant-commit'
  | 'deferred';
export type RepositoryReceiptClassification =
  | 'unchanged'
  | 'one-descendant-commit'
  | 'multiple-commits'
  | 'rewritten-or-non-descendant'
  | 'worktree-only-change'
  | 'concurrent-or-foreign-change'
  | 'observation-ambiguous';
export declare const REPOSITORY_RECEIPT_CLASSIFICATIONS: readonly RepositoryReceiptClassification[];

export interface RepositoryIdentity {
  readonly worktree: string;
  readonly gitDir: string;
}
export interface PlaybookRepositoryObservation extends RepositoryIdentity {
  readonly head: string;
  readonly projection: Readonly<Record<string, JsonValue>>;
  readonly projectionDigest: string;
}
export interface PlaybookRepositoryReceipt {
  readonly classification: RepositoryReceiptClassification;
  readonly baseline: PlaybookRepositoryObservation;
  readonly after?: PlaybookRepositoryObservation;
  readonly commitOid?: string;
}
export interface RepositoryReceiptOptions {
  readonly allowedDispositions: readonly PlaybookRepositoryDisposition[];
}

export declare function observeGitRepository(
  cwd: string,
): Promise<PlaybookRepositoryObservation>;
export declare function classifyRepositoryReceipt(
  baseline: PlaybookRepositoryObservation,
  after: PlaybookRepositoryObservation,
  options: RepositoryReceiptOptions,
): Promise<PlaybookRepositoryReceipt>;
export declare function captureRepositoryReceipt(
  baseline: PlaybookRepositoryObservation,
  options: RepositoryReceiptOptions,
): Promise<PlaybookRepositoryReceipt>;

export interface PlaybookPendingBossQuestion {
  readonly questionId: string;
  readonly asker:
    | { readonly kind: 'captain' }
    | { readonly kind: 'role'; readonly roleId: string };
  readonly question: string;
  readonly sourceItem?: string;
}
export interface PlaybookEffectBoundary {
  readonly sequence: number;
  readonly boundaryId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly playbookId: string;
  readonly runtimeSessionId: string;
  readonly turnId: number;
  readonly callId: string;
  readonly roleId: string;
  readonly sourceStateId: string;
  readonly sourceOutcomeSchema: JsonValue;
  readonly dispositions: readonly PlaybookRepositoryDisposition[];
  readonly canonicalWorktree: RepositoryIdentity;
  readonly baseline: PlaybookRepositoryObservation;
  readonly after?: PlaybookRepositoryObservation;
  readonly physicalReceipt?: PlaybookRepositoryReceipt;
  readonly finalText?: string;
  readonly semanticCandidate?: JsonValue;
  readonly initialSemanticCandidate?: JsonValue;
  readonly correctionBudget: {
    readonly limit: 1;
    readonly spent: boolean;
  };
  readonly cohortId?: string;
  readonly logicalOperationId?: string;
}
export type PlaybookEffectBoundaryStart = Omit<
  PlaybookEffectBoundary,
  | 'sequence'
  | 'attemptId'
  | 'attemptNumber'
  | 'after'
  | 'physicalReceipt'
  | 'finalText'
  | 'semanticCandidate'
  | 'initialSemanticCandidate'
>;
export type EffectBoundarySeed = Omit<
  PlaybookEffectBoundaryStart,
  'playbookId' | 'canonicalWorktree' | 'baseline' | 'cohortId'
>;
export interface PlaybookEffectLogicalOperation {
  readonly sequence: number;
  readonly operationId: string;
  readonly playbookId: string;
  readonly runtimeSessionId: string;
  readonly boundaryIds: readonly string[];
  readonly originalBaseline: PlaybookRepositoryObservation;
  readonly checkpoint?: PlaybookRepositoryObservation;
  readonly pendingQuestion?: PlaybookPendingBossQuestion;
  readonly playerContinuation?: JsonValue;
  readonly checkpointRestorationEligible: boolean;
  readonly logicalReceipt?: PlaybookRepositoryReceipt;
}
export interface PlaybookEffectLedger {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly boundaries: readonly PlaybookEffectBoundary[];
  readonly logicalOperations: readonly PlaybookEffectLogicalOperation[];
}
export type PlaybookEffectLedgerCommand =
  | {
      readonly kind: 'start-boundaries';
      readonly boundaries: readonly [
        PlaybookEffectBoundaryStart,
        ...PlaybookEffectBoundaryStart[],
      ];
    }
  | {
      readonly kind: 'replace-boundaries';
      readonly replacements: readonly [
        {
          readonly expected: PlaybookEffectBoundary;
          readonly next: PlaybookEffectBoundary;
        },
        ...{
          readonly expected: PlaybookEffectBoundary;
          readonly next: PlaybookEffectBoundary;
        }[],
      ];
    }
  | {
      readonly kind: 'append-logical-operations';
      readonly operations: readonly [
        Omit<PlaybookEffectLogicalOperation, 'sequence'>,
        ...Omit<PlaybookEffectLogicalOperation, 'sequence'>[],
      ];
    }
  | {
      readonly kind: 'replace-logical-operations';
      readonly replacements: readonly [
        {
          readonly expected: PlaybookEffectLogicalOperation;
          readonly next: PlaybookEffectLogicalOperation;
        },
        ...{
          readonly expected: PlaybookEffectLogicalOperation;
          readonly next: PlaybookEffectLogicalOperation;
        }[],
      ];
    };
export type PlaybookEffectLedgerCommandBatch = readonly [
  PlaybookEffectLedgerCommand,
  ...PlaybookEffectLedgerCommand[],
];
export interface PlaybookEffectLedgerCapability {
  snapshot(): PlaybookEffectLedger;
  writeAhead(
    commands: PlaybookEffectLedgerCommandBatch,
  ): Promise<PlaybookEffectLedger>;
}

interface RepositoryOperationSettlement<T> {
  readonly status: 'fulfilled';
  readonly value: T;
}
interface RepositoryOperationRejection {
  readonly status: 'rejected';
  readonly reason: unknown;
}
export interface RepositoryExclusiveCompletion<T> {
  readonly boundary: PlaybookEffectBoundary;
  readonly operation:
    | RepositoryOperationSettlement<T>
    | RepositoryOperationRejection;
  readonly receipt: PlaybookRepositoryReceipt;
  readonly outcomeReceipt: PlaybookRepositoryReceipt;
}
interface RepositoryDeferredBinding {
  readonly operationId: string;
  readonly pendingQuestion: PlaybookPendingBossQuestion;
  readonly playerContinuation: JsonValue;
}
export interface RepositoryCompletionEvidence {
  readonly finalText?: string;
  readonly semanticCandidate?: JsonValue;
  readonly deferred?: RepositoryDeferredBinding;
  readonly unresolved?: true;
}
export interface RepositoryExclusiveResult<T> {
  readonly operation:
    | RepositoryOperationSettlement<T>
    | RepositoryOperationRejection;
  readonly receipt: PlaybookRepositoryReceipt;
  readonly effectLedger: PlaybookEffectLedger;
  readonly deferredStatus?: 'bound' | 'unresolved';
}
interface RepositoryDeferredContinuationResult<T> {
  readonly status: 'continued';
  readonly operation:
    | RepositoryOperationSettlement<T>
    | RepositoryOperationRejection;
  readonly receipt: PlaybookRepositoryReceipt;
  readonly logicalReceipt?: PlaybookRepositoryReceipt;
  readonly effectLedger: PlaybookEffectLedger;
  readonly deferredStatus?: 'bound' | 'unresolved';
}
interface RepositoryDeferredCheckpointMismatch {
  readonly status: 'checkpoint-mismatch' | 'ineligible';
  readonly effectLedger: PlaybookEffectLedger;
}
interface RepositoryDeferredParked {
  readonly status: 'parked';
  readonly effectLedger: PlaybookEffectLedger;
}
interface RepositoryDeferredRestoreResult {
  readonly status: 'restored' | 'checkpoint-mismatch' | 'ineligible';
  readonly effectLedger: PlaybookEffectLedger;
}
export interface RepositoryCapability {
  runExclusive<T>(options: {
    readonly signal?: AbortSignal;
    readonly effectBoundary: EffectBoundarySeed;
    readonly operation: (context: {
      readonly baseline: PlaybookRepositoryObservation;
      readonly identity: RepositoryIdentity;
    }) => Promise<T>;
    readonly completeEffectBoundary: (
      completion: RepositoryExclusiveCompletion<T>,
    ) => RepositoryCompletionEvidence | Promise<RepositoryCompletionEvidence>;
  }): Promise<RepositoryExclusiveResult<T>>;
  runDeferred<T>(options: {
    readonly mode: 'continue';
    readonly signal?: AbortSignal;
    readonly operationId: string;
    readonly effectBoundary: EffectBoundarySeed;
    readonly operation: (context: {
      readonly baseline: PlaybookRepositoryObservation;
      readonly identity: RepositoryIdentity;
      readonly playerContinuation: JsonValue;
    }) => Promise<T>;
    readonly completeEffectBoundary: (
      completion: RepositoryExclusiveCompletion<T>,
    ) => RepositoryCompletionEvidence | Promise<RepositoryCompletionEvidence>;
  }): Promise<
    RepositoryDeferredContinuationResult<T> | RepositoryDeferredCheckpointMismatch
  >;
  runDeferred(options: {
    readonly mode: 'park' | 'restore';
    readonly signal?: AbortSignal;
    readonly operationId: string;
  }): Promise<RepositoryDeferredParked | RepositoryDeferredRestoreResult>;
}
export interface HostCapabilities {
  readonly repository: RepositoryCapability;
  readonly effectLedger: PlaybookEffectLedgerCapability;
}
export interface WorktreeRepositoryCapability extends RepositoryCapability {
  readonly identity: RepositoryIdentity;
  observe(): Promise<PlaybookRepositoryObservation>;
}
export interface WorktreeHostCapabilities extends HostCapabilities {
  readonly repository: WorktreeRepositoryCapability;
}
export interface WorktreeHostCapabilitiesOptions {
  readonly cwd: string;
  readonly playbookId: string;
  readonly requiredRoleIds: readonly string[];
  readonly concurrentRoleSets?: readonly (readonly string[])[];
  readonly effectLedger?: PlaybookEffectLedger;
}
export declare function createWorktreeHostCapabilities(
  options: WorktreeHostCapabilitiesOptions,
): Promise<WorktreeHostCapabilities>;
export declare function createFailClosedHostCapabilities(): HostCapabilities;
