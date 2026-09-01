import { type Captain, type CaptainSession, type TuningSelection } from '@sublang/cligent/tmux-play';
import type { Effort, PermissionPolicy } from '@sublang/cligent';
import type { JsonValue, PlaybookEffectLedger, PlaybookEffectLedgerCommandBatch, PlaybookRuntime, PlaybookRuntimeSnapshot } from '@sublang/playbook/runtime';
import { type CaptainControllerPort } from '../captain.playbook/captain.playbook.js';
import type { PlaybookSummaryPolicy } from './code.registry.js';
interface SessionAgent {
    readonly adapter: string;
    readonly model: TuningSelection;
    readonly effort: TuningSelection<Effort>;
    /** Adapter-scoped fast mode. Absence is the provider default; `false` is a
     * literal request, so this carries no provider-default sentinel. */
    readonly fastMode?: boolean;
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
export interface PlaybookCaptainUnresolvedEffect {
    readonly classification: 'one-descendant-commit' | 'multiple-commits' | 'rewritten-or-non-descendant' | 'worktree-only-change' | 'concurrent-or-foreign-change' | 'observation-ambiguous' | 'incomplete';
    readonly baselineHead: string;
    readonly afterHead?: string;
    readonly commitOid?: string;
}
interface PlaybookCaptainUnresolvedEffectSettlementInput {
    readonly rootPlaybookId: string;
    readonly unresolvedEffects: readonly PlaybookCaptainUnresolvedEffect[];
}
type SnapshotAgentEnvelope = DeepReadonly<Omit<SessionAgent, 'model' | 'effort' | 'fastMode'>>;
type PlayerLedgerSnapshotEntry = DeepReadonly<PlayerLedgerEntry>;
export interface PlaybookCaptainDeps {
    loadModule?: (specifier: string) => Promise<unknown>;
    createSessionId?: () => string;
    hostCapabilities?: Readonly<Record<string, PlaybookHostConstructionCapabilities>>;
    createCaptainRuntime?: (options: {
        readonly enabledPlaybooks: readonly {
            readonly id: string;
            readonly command: string;
            readonly intent: string;
        }[];
        readonly controller: CaptainControllerPort;
    }) => PlaybookRuntime;
    unresolvedEffectSettlement?: {
        begin(input: PlaybookCaptainUnresolvedEffectSettlementInput): Promise<void>;
        complete(input: PlaybookCaptainUnresolvedEffectSettlementInput): Promise<void>;
    };
}
/** Live, artifact-typed host facilities supplied outside configured options. */
export interface PlaybookHostConstructionCapabilities {
    readonly authority: {
        readonly playbookId: string;
        readonly artifactSchema: 3;
        readonly cwd: string;
        readonly sessionId: string;
        readonly leaseOwnerToken: string;
        readonly canonicalWorktree: {
            readonly worktree: string;
            readonly gitDir: string;
        };
        readonly requiredRoleIds: readonly string[];
        readonly concurrentRoleSets: readonly (readonly string[])[];
    };
    readonly repository: {
        readonly identity: {
            readonly worktree: string;
            readonly gitDir: string;
        };
        readonly observe: (options?: unknown) => Promise<unknown>;
        readonly acquire: (options?: unknown) => Promise<unknown>;
        readonly runExclusive: (options: unknown) => Promise<unknown>;
        readonly runCohort: (options: unknown) => Promise<unknown>;
        readonly runDeferred: (options: unknown) => Promise<unknown>;
    };
    readonly effectLedger: {
        readonly snapshot: () => PlaybookEffectLedger;
        readonly writeAhead: (commands: PlaybookEffectLedgerCommandBatch) => Promise<PlaybookEffectLedger>;
    };
}
export type PlaybookCaptainRuntimeProfile = {
    readonly kind: 'shared-factory';
    readonly compat: {
        readonly artifactSchema: 3;
        readonly runtimeAbi: number;
    };
} | {
    readonly kind: 'bespoke';
    readonly artifactSchema: 3;
};
interface PlaybookCaptainRegistryEntryBase {
    id: string;
    command: string;
    intent: string;
    runtimeProfile: PlaybookCaptainRuntimeProfile;
    requiredRoleIds: readonly string[];
    concurrentRoleSets: readonly (readonly string[])[];
    summaryPolicy?: PlaybookSummaryPolicy;
    validateOptions(optionSlice: unknown): unknown;
}
export interface PlaybookCaptainRegistryEntryV3 extends PlaybookCaptainRegistryEntryBase {
    artifactSchema: 3;
    createRuntime(configuredOptions: unknown, hostCapabilities: PlaybookHostConstructionCapabilities): PlaybookRuntime;
}
export type PlaybookCaptainRegistryEntry = PlaybookCaptainRegistryEntryV3;
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
    readonly schemaVersion: 4;
    readonly effectLedger: DeepReadonly<PlaybookEffectLedger>;
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
    readonly retainedEffectReconciliation?: PlaybookCaptainRetainedEffectReconciliation;
    readonly pendingBossQuestions?: JsonValue;
    readonly lastError?: {
        readonly name: string;
        readonly message: string;
    };
});
export type PlaybookCaptainShellSnapshot = DeepReadonly<PlaybookCaptainShellSnapshotValue>;
export interface PlaybookCaptainRetainedGeneration {
    /** Repository-effect checkpoint reflected by the retained machine state. */
    readonly effectLedger: DeepReadonly<PlaybookEffectLedger>;
    readonly frames: readonly PlaybookCaptainFrameSnapshot[];
    readonly retainedEffectReconciliation?: {
        readonly sourceGenerationId: string;
    };
    /** Boss-facing description published for the retained root state, if any. */
    readonly rootStateDescription?: string;
}
interface PlaybookCaptainRetainedEffectReconciliation {
    readonly sourceGenerationId: string;
    readonly checkpoint: DeepReadonly<PlaybookEffectLedger>;
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
    readonly unresolvedEffects: readonly PlaybookCaptainUnresolvedEffect[];
}
/** tmux and headless front ends share this one durable Captain shell API. */
export interface PlaybookCaptainShell extends Captain {
    installRetainedGenerations(generations: Readonly<Record<string, PlaybookCaptainRetainedGeneration>>): Promise<void>;
    exportSnapshot(): PlaybookCaptainShellSnapshot | undefined;
    exportSettlement(): PlaybookCaptainSettlement | undefined;
    restore(session: CaptainSession, snapshot: PlaybookCaptainShellSnapshot): Promise<void>;
}
export declare function assertPlaybookCaptainUnresolvedEffects(value: unknown): readonly PlaybookCaptainUnresolvedEffect[];
/** Validate, detach, and freeze one untrusted shell snapshot. */
export declare function assertPlaybookCaptainShellSnapshot(value: unknown): PlaybookCaptainShellSnapshot;
export declare function createPlaybookCaptainShell(options: unknown, deps?: PlaybookCaptainDeps): PlaybookCaptainShell;
export default createPlaybookCaptainShell;
