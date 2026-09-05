// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export declare const RECORDS_STREAM_VERSION: 1;
export declare function defaultSessionsDir(): string;
export declare function openSessionStore(
  sessionsDir: string,
): PlaybookSessionStore;

export type ReplayJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReplayJsonValue[]
  | ReplayRecord;
export type ReplayRecord = {
  readonly [key: string]: ReplayJsonValue;
};
export interface ReplayStreamEntry {
  readonly v: 1;
  readonly seq: number;
  readonly role?: string;
  readonly record: ReplayRecord;
}
export interface ReplayStreamReadOptions {
  readonly afterSeq?: number;
}
export interface ReplayStreamReadResult {
  readonly entries: readonly ReplayStreamEntry[];
  readonly lastReadableSeq: number;
}
export interface LeaseReplayStreamReadResult extends ReplayStreamReadResult {
  readonly lastDurableSeq: number;
  readonly incomplete: boolean;
}
export type ReplayStreamStatus =
  | {
      readonly lastReadableSeq: number;
      readonly lastDurableSeq: number;
      readonly incomplete: boolean;
    }
  | {
      readonly lastReadableSeq: null;
      readonly lastDurableSeq: null;
      readonly incomplete: true;
    };
export interface PlaybookSessionSummary {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly state: 'settled' | 'uncertain' | 'history-only';
  readonly cwd: string;
  readonly updatedAt: string;
}
export interface SkippedPlaybookSession {
  readonly sessionId: string;
  readonly reason: string;
}
export interface PlaybookSessionListResult {
  readonly sessions: readonly PlaybookSessionSummary[];
  readonly skipped: readonly SkippedPlaybookSession[];
}
export interface PlaybookSessionStore {
  readonly sessionsDir: string;
  list(): Promise<PlaybookSessionListResult>;
  read(sessionId: string): Promise<PlaybookSessionSummary>;
  readStream(
    sessionId: string,
    options?: ReplayStreamReadOptions,
  ): Promise<ReplayStreamReadResult>;
  acquire(sessionId: string): Promise<PlaybookSessionLease>;
}
export interface PlaybookSessionLease {
  readonly sessionId: string;
  readonly ownerToken: string;
  append(record: object, role?: string): Promise<void>;
  readStream(
    options?: ReplayStreamReadOptions,
  ): Promise<LeaseReplayStreamReadResult>;
  streamStatus(): ReplayStreamStatus;
  release(): Promise<ReplayStreamStatus>;
}

/** Recovery data is interpreted by the version-aware codec, not by live runtimes. */
export type SessionSnapshot = Readonly<Record<string, any>>;
export interface SessionEffectLedger {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly boundaries: readonly Readonly<Record<string, any>>[];
  readonly logicalOperations: readonly Readonly<Record<string, any>>[];
}
export interface SessionUnresolvedEffect {
  readonly classification: 'one-descendant-commit' | 'multiple-commits' |
    'rewritten-or-non-descendant' | 'worktree-only-change' |
    'concurrent-or-foreign-change' | 'observation-ambiguous' | 'incomplete';
  readonly baselineHead: string;
  readonly afterHead?: string;
  readonly commitOid?: string;
}
export type SessionRetentionUpdate =
  | { readonly kind: 'retain'; readonly rootPlaybookId: string; readonly generation: Readonly<Record<string, any>> }
  | { readonly kind: 'clear'; readonly rootPlaybookId: string };

export interface SessionExecutionProjection {
  readonly schemaVersion: 2;
  readonly captain: Readonly<Record<string, any>>;
  readonly players: readonly Readonly<Record<string, any>>[];
  readonly catalog: Readonly<Record<string, any>>;
}
export interface SessionStructuralProjection {
  readonly schemaVersion: 1;
  readonly captain: Readonly<Record<string, any>>;
  readonly players: readonly Readonly<Record<string, any>>[];
  readonly catalog: Readonly<Record<string, any>>;
}
export interface SessionRecovery {
  readonly schemaVersion: 6;
  readonly kind: 'captain-session';
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: 'settled' | 'uncertain';
  readonly structuralProjection: SessionStructuralProjection;
  readonly lastAppliedExecutionProjection: SessionExecutionProjection;
  readonly snapshot: SessionSnapshot;
  readonly effectLedger: SessionEffectLedger;
  readonly unresolvedEffects: readonly SessionUnresolvedEffect[];
  readonly retainedGenerations?: Readonly<Record<string, any>>;
  readonly uncertain?: {
    readonly input: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly baseUpdatedAt: string | null;
    readonly markedAt: string;
    readonly attemptedExecutionProjection: SessionExecutionProjection;
    readonly abandonment?: Readonly<Record<string, any>>;
  };
}
export interface SessionReplayCheckpoint {
  readonly seq: number;
  readonly sha256: string;
  readonly incomplete: boolean;
}
export type SessionManifest = Omit<SessionRecovery, 'schemaVersion'> & {
  readonly schemaVersion: 7;
  readonly replay: SessionReplayCheckpoint;
  readonly contextSeq: number;
} | {
  readonly schemaVersion: 7;
  readonly kind: 'captain-session';
  readonly state: 'history-only';
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly replay: SessionReplayCheckpoint;
  readonly contextSeq: number | null;
  readonly reason: string;
};
export type StoredSessionManifest = SessionManifest | {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly cwd?: unknown;
  readonly [key: string]: unknown;
};
export interface SessionGraph {
  readonly initial: string;
  readonly nodes: readonly { readonly id: string; readonly kind: 'state' | 'final'; readonly tags: readonly string[]; readonly parent?: string; readonly role?: string; readonly description?: string }[];
  readonly edges: readonly { readonly id: string; readonly from: string; readonly to: string; readonly event: string }[];
}
export interface SessionContext {
  readonly type: 'session_context';
  readonly timestamp: number;
  readonly contextVersion: 1;
  readonly captainId: string;
  readonly configuration: SessionExecutionProjection;
  readonly graphs: readonly { readonly playbookId: string; readonly graph: SessionGraph | null }[];
  readonly initialVisible: readonly string[];
}
export interface SessionHistory extends ReplayStreamReadResult {
  readonly synthetic?: true;
  readonly missing: boolean;
  readonly incomplete: boolean;
  readonly pendingTail: boolean;
  readonly damage?: { readonly seq: number; readonly offset: number; readonly reason: string };
  readonly digests: readonly string[];
  readonly completeBytes: number;
}
export interface SessionValidation {
  readonly integrityValid: boolean;
  readonly sessionId: string;
  readonly resumable: boolean;
  readonly reasons: readonly string[];
  readonly manifest: StoredSessionManifest;
  readonly history: SessionHistory;
}
export interface SessionHints {
  readonly players: Readonly<Record<string, string>>;
  readonly captain?: { readonly kind: 'pinned'; readonly token: string } | { readonly kind: 'needsCatchUp'; readonly resume: string | false; readonly afterJournalSeq: number };
}
export interface SessionFreshBoundary {
  readonly cwd: string;
  readonly structuralProjection: SessionStructuralProjection;
  readonly executionProjection: SessionExecutionProjection;
  readonly snapshot: SessionSnapshot;
  readonly context?: SessionContext;
  readonly onLegacyRecord?: (record: any) => void | Promise<void>;
  readonly onInvalidRecord?: (record: any) => void | Promise<void>;
}
export interface PlaybookSessionLifecycle extends PlaybookSessionLease {
  read(): Promise<SessionRecovery | undefined>;
  readManifest(): Promise<StoredSessionManifest>;
  initializeSettledWithPredecessor(options: SessionFreshBoundary): Promise<SessionRecovery>;
  abandonFreshSettled(options: { expected: SessionRecovery }): Promise<boolean>;
  beginTurn(options: { input: string; attemptId: string; attemptedExecutionProjection: SessionExecutionProjection }): Promise<SessionRecovery>;
  beginRetry(options: { expectedAttemptId: string; nextAttemptId: string }): Promise<SessionRecovery>;
  settle(options: { attemptId: string; snapshot: SessionSnapshot; unresolvedEffects: readonly SessionUnresolvedEffect[]; retentionUpdates?: readonly SessionRetentionUpdate[] }): Promise<SessionRecovery>;
  discard(options: { attemptId: string }): Promise<SessionRecovery | undefined>;
  beginUnresolvedEffectAbandonment(options: any): Promise<any>;
  completeUnresolvedEffectAbandonment(options: any): Promise<any>;
  recoverUnresolvedEffectAbandonment(): Promise<SessionRecovery | undefined>;
  writeEffectLedger(authority: any, commands: readonly Readonly<Record<string, any>>[]): Promise<SessionEffectLedger>;
  assertOwner(): Promise<any>;
  assertContinuable(context?: { cwd?: string; executionProjection?: SessionExecutionProjection }): Promise<SessionValidation>;
  recordContext(context: SessionContext): Promise<number>;
  consumeHints(): Promise<SessionHints>;
  acknowledgeHint(participantId: string, token: string): void;
  clearHint(participantId: string): void;
}
export interface SharedSessionStore {
  readonly sessionsDir: string;
  prepare(): Promise<void>;
  read(sessionId: string): Promise<SessionRecovery>;
  readManifest(sessionId: string): Promise<StoredSessionManifest>;
  readHistory(sessionId: string, options?: ReplayStreamReadOptions): Promise<SessionHistory>;
  readStream(sessionId: string, options?: ReplayStreamReadOptions): Promise<ReplayStreamReadResult>;
  readSummary(sessionId: string): Promise<PlaybookSessionSummary>;
  listSummaries(): Promise<PlaybookSessionListResult>;
  latest(options?: { preferredCwd?: string; onLegacyRecord?: (record: any) => void | Promise<void> }): Promise<SessionRecovery>;
  acquire(sessionId: string): Promise<PlaybookSessionLifecycle>;
  acquireManagement(sessionId: string): Promise<{ readonly sessionId: string; readonly ownerToken: string; assertOwner(): Promise<unknown>; release(): Promise<void> }>;
  validate(sessionId: string, context?: { cwd?: string; executionProjection?: SessionExecutionProjection }): Promise<SessionValidation>;
  delete(sessionId: string): Promise<void>;
  migrate(sessionId: string, options?: { sourcePath?: string; cwd?: string; backupDir?: string }): Promise<{ manifest: SessionManifest; migrated: boolean; reasons: readonly string[] }>;
}
export declare function createSessionStore(options?: { sessionsDir?: string; env?: Readonly<Record<string, string | undefined>>; homeDir?: string; [key: string]: any }): SharedSessionStore;
export declare function validateSessionManifest(value: unknown): SessionManifest;
export declare function validateSessionContext(value: unknown): SessionContext;
export declare function projectCaptainSessionStructure(value: SessionExecutionProjection): SessionStructuralProjection;
export declare function validateCaptainSessionExecutionProjection(value: unknown): SessionExecutionProjection;
export declare function validateCaptainSessionStructuralProjection(value: unknown): SessionStructuralProjection;
export declare function assertCaptainSessionExecutionCompatible(structural: SessionStructuralProjection, execution: SessionExecutionProjection): SessionExecutionProjection;
export declare function attachSessionHints(snapshot: SessionSnapshot, hints: SessionHints): SessionSnapshot;
