import type { Captain, CaptainSession } from '@sublang/cligent/tmux-play';
import type { JsonValue, PlaybookRuntime, PlaybookRuntimeSnapshot } from '@sublang/playbook/runtime';
import { type CaptainControllerPort } from '../captain.playbook/captain.playbook.js';
import type { PlaybookSummaryPolicy, RegistryPlayer } from './code.registry.js';
export interface CreatePlaybookRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export interface PlaybookCaptainDeps {
    loadModule?: (specifier: string) => Promise<unknown>;
    createSessionId?: () => string;
    createCaptainRuntime?: (options: {
        readonly enabledPlaybooks: readonly {
            readonly id: string;
            readonly command: string;
            readonly intent: string;
        }[];
        readonly controller: CaptainControllerPort;
    }) => PlaybookRuntime;
}
export interface PlaybookCaptainRegistryEntry {
    id: string;
    command: string;
    intent: string;
    requiredRoleIds: readonly string[];
    summaryPolicy?: PlaybookSummaryPolicy;
    validateOptions(captainOptions: unknown): unknown;
    createRuntime(options: CreatePlaybookRuntimeOptions): PlaybookRuntime;
}
type PlaybookCaptainConversationSnapshot = {
    readonly kind: 'unopened';
} | {
    readonly kind: 'pinned';
    readonly token: string;
} | {
    readonly kind: 'needsSeeding';
};
interface PlaybookCaptainJournalRecord {
    readonly seq: number;
    readonly turnId: number;
    readonly kind: 'boss' | 'reply' | 'handoff' | 'action' | 'outcome';
    readonly payload: JsonValue;
}
interface PlaybookCaptainFrameSnapshot {
    readonly playbookId: string;
    readonly sessionId: string;
    readonly rootSessionId: string;
    readonly depth: number;
    readonly parentSessionId?: string;
    readonly parentCallId?: string;
    readonly runtime: PlaybookRuntimeSnapshot;
}
interface PlaybookCaptainShellSnapshotFields {
    readonly schemaVersion: 1;
    readonly captain: {
        readonly sessionId: string;
        readonly runtime: PlaybookRuntimeSnapshot;
        readonly conversation: PlaybookCaptainConversationSnapshot;
    };
    /** Every Captain and engagement UUID issued during this logical session. */
    readonly issuedSessionIds: readonly string[];
    readonly sequences: {
        readonly turn: number;
        readonly journal: number;
    };
    readonly journal: readonly PlaybookCaptainJournalRecord[];
    readonly lastAction?: 'respond' | 'start' | 'switch' | 'dismiss' | 'deliver' | 'runtime';
    readonly lastSettlementStatus?: 'ok' | 'rejected' | 'failed';
}
/**
 * Complete JSON-safe durable state for one Captain shell between Boss turns.
 * The discriminated mode keeps chat snapshots free of stale engagement data.
 */
export type PlaybookCaptainShellSnapshot = PlaybookCaptainShellSnapshotFields & ({
    readonly mode: 'chat';
    readonly frames?: never;
    readonly rootPlayerResumeTokens?: never;
    readonly pendingBossQuestions?: never;
    readonly lastError?: never;
} | {
    readonly mode: 'engaged.parked';
    /** Root-to-leaf engagement order. */
    readonly frames: readonly PlaybookCaptainFrameSnapshot[];
    /** Root-owned continuation, keyed by effective host-player id. */
    readonly rootPlayerResumeTokens: Readonly<Record<string, string>>;
    readonly pendingBossQuestions?: JsonValue;
    readonly lastError?: {
        readonly name: string;
        readonly message: string;
    };
});
/** tmux and headless front ends share this one durable Captain shell API. */
export interface PlaybookCaptainShell extends Captain {
    exportSnapshot(): PlaybookCaptainShellSnapshot | undefined;
    restore(session: CaptainSession, snapshot: PlaybookCaptainShellSnapshot): Promise<void>;
}
export declare function createPlaybookCaptainShell(options: unknown, deps?: PlaybookCaptainDeps): PlaybookCaptainShell;
export default createPlaybookCaptainShell;
