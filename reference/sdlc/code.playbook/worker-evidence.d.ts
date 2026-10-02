import type { PlaybookEffectBoundary } from '../../../src/runtime.js';
export declare const QUOTED_EVIDENCE_LIMIT = 400;
export declare const WORKER_REPORT_LIMIT = 8192;
export declare const WORKER_REPORT_TOTAL_LIMIT = 24576;
/** A report is presentation evidence, never proof of a repository effect. */
export declare function workerReportExcerpt(boundary: PlaybookEffectBoundary, playerId: string, acceptedOutcome: string): string | undefined;
export declare function workerRecoveryReportBlock(reports: readonly string[]): string | undefined;
export declare function workerReportBlock(reports: readonly string[]): string | undefined;
