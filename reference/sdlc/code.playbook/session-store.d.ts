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
  readonly state: 'settled' | 'uncertain';
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
