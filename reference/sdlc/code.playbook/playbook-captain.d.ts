import { type Captain, type CaptainSession, type TuningSelection } from '@sublang/cligent/tmux-play';
import type { Effort, PermissionPolicy } from '@sublang/cligent';
import type { JsonValue, PlaybookRuntime, PlaybookRuntimeSnapshot } from '@sublang/playbook/runtime';
import { type CaptainControllerPort } from '../captain.playbook/captain.playbook.js';
import type { PlaybookSummaryPolicy } from './code.registry.js';
interface SessionAgent {
    readonly adapter: string;
    readonly model: TuningSelection;
    readonly effort: TuningSelection<Effort>;
    readonly instruction?: string;
    readonly permissions?: PermissionPolicy;
}
interface PlayerLedgerEntry {
    readonly adapter: string;
    readonly instruction?: string;
    readonly permissions?: PermissionPolicy;
    resumeToken?: string;
}
type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer Element)[] ? readonly DeepReadonly<Element>[] : T extends object ? {
    readonly [Key in keyof T]: DeepReadonly<T[Key]>;
} : T;
type SnapshotAgentEnvelope = DeepReadonly<Omit<SessionAgent, 'model' | 'effort'>>;
type PlayerLedgerSnapshotEntry = DeepReadonly<PlayerLedgerEntry>;
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
/** Live, artifact-typed host facilities supplied outside configured options. */
export interface PlaybookHostConstructionCapabilities {
    readonly [capability: string]: unknown;
}
interface PlaybookCaptainRegistryEntryBase {
    id: string;
    command: string;
    intent: string;
    requiredRoleIds: readonly string[];
    concurrentRoleSets: readonly (readonly string[])[];
    summaryPolicy?: PlaybookSummaryPolicy;
    validateOptions(optionSlice: unknown): unknown;
}
export interface PlaybookCaptainRegistryEntryV2 extends PlaybookCaptainRegistryEntryBase {
    artifactSchema: 2;
    createRuntime(configuredOptions: unknown): PlaybookRuntime;
}
export interface PlaybookCaptainRegistryEntryV3 extends PlaybookCaptainRegistryEntryBase {
    artifactSchema: 3;
    createRuntime(configuredOptions: unknown, hostCapabilities: PlaybookHostConstructionCapabilities): PlaybookRuntime;
}
export type PlaybookCaptainRegistryEntry = PlaybookCaptainRegistryEntryV2 | PlaybookCaptainRegistryEntryV3;
type PlaybookCaptainConversationSnapshot = {
    readonly kind: 'unopened';
} | {
    readonly kind: 'pinned';
    readonly token: string;
} | {
    readonly kind: 'needsCatchUp';
    readonly resume: string | false;
    readonly afterJournalSeq: number;
} | {
    readonly kind: 'needsSeeding';
};
interface PlaybookCaptainJournalRecord {
    readonly seq: number;
    readonly turnId: number;
    readonly kind: 'boss' | 'reply' | 'handoff' | 'action' | 'outcome';
    readonly payload: JsonValue;
}
export interface PlaybookCaptainFrameSnapshot {
    readonly playbookId: string;
    readonly sessionId: string;
    readonly rootSessionId: string;
    readonly depth: number;
    readonly parentSessionId?: string;
    readonly parentCallId?: string;
    readonly options: JsonValue;
    readonly roleBindings: Readonly<Record<string, string>>;
    readonly runtime: DeepReadonly<PlaybookRuntimeSnapshot>;
}
interface PlaybookCaptainShellSnapshotFields {
    readonly schemaVersion: 3;
    readonly captain: {
        readonly sessionId: string;
        readonly runtime: DeepReadonly<PlaybookRuntimeSnapshot>;
        readonly agent: SnapshotAgentEnvelope;
        readonly conversation: PlaybookCaptainConversationSnapshot;
    };
    readonly playerSessions: Readonly<Record<string, PlayerLedgerSnapshotEntry>>;
    /** Every Captain and engagement UUID issued during this logical session. */
    readonly issuedSessionIds: readonly string[];
    readonly sequences: {
        readonly turn: number;
        readonly journal: number;
    };
    readonly journal: readonly PlaybookCaptainJournalRecord[];
    readonly lastAction?: 'respond' | 'start' | 'switch' | 'resume' | 'dismiss' | 'deliver' | 'runtime';
    readonly lastSettlementStatus?: 'ok' | 'rejected' | 'failed';
}
/**
 * Complete JSON-safe durable state for one Captain shell between Boss turns.
 * The discriminated mode keeps chat snapshots free of stale engagement data.
 */
type PlaybookCaptainShellSnapshotValue = PlaybookCaptainShellSnapshotFields & ({
    readonly mode: 'chat';
    readonly frames?: never;
    readonly pendingBossQuestions?: never;
    readonly lastError?: never;
} | {
    readonly mode: 'engaged.parked';
    /** Root-to-leaf engagement order. */
    readonly frames: readonly PlaybookCaptainFrameSnapshot[];
    readonly pendingBossQuestions?: JsonValue;
    readonly lastError?: {
        readonly name: string;
        readonly message: string;
    };
});
export type PlaybookCaptainShellSnapshot = DeepReadonly<PlaybookCaptainShellSnapshotValue>;
export interface PlaybookCaptainRetainedGeneration {
    readonly frames: readonly PlaybookCaptainFrameSnapshot[];
    /** Boss-facing description published for the retained root state, if any. */
    readonly rootStateDescription?: string;
}
export type PlaybookCaptainRetentionUpdate = {
    readonly kind: 'retain';
    readonly rootPlaybookId: string;
    readonly generation: PlaybookCaptainRetainedGeneration;
} | {
    readonly kind: 'clear';
    readonly rootPlaybookId: string;
};
export interface PlaybookCaptainSettlement {
    readonly snapshot: PlaybookCaptainShellSnapshot;
    readonly retentionUpdates: readonly PlaybookCaptainRetentionUpdate[];
}
/** tmux and headless front ends share this one durable Captain shell API. */
export interface PlaybookCaptainShell extends Captain {
    installRetainedGenerations(generations: Readonly<Record<string, PlaybookCaptainRetainedGeneration>>): Promise<void>;
    exportSnapshot(): PlaybookCaptainShellSnapshot | undefined;
    exportSettlement(): PlaybookCaptainSettlement | undefined;
    restore(session: CaptainSession, snapshot: PlaybookCaptainShellSnapshot): Promise<void>;
}
/** Validate, detach, and freeze one untrusted shell snapshot. */
export declare function assertPlaybookCaptainShellSnapshot(value: unknown): PlaybookCaptainShellSnapshot;
export declare function createPlaybookCaptainShell(options: unknown, deps?: PlaybookCaptainDeps): PlaybookCaptainShell;
export default createPlaybookCaptainShell;
