// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { PlaybookControlAction } from '@sublang/playbook/runtime';
import type { PlaybookCaptainShell, PlaybookCaptainShellSnapshot } from './playbook-captain.js';
import type { PlaybookEffectLedger } from './host-capabilities.js';
import type { PlaybookSessionLifecycle, SessionExecutionProjection, SessionStructuralProjection, SessionFreshBoundary, SessionRecovery } from './session-store.js';

export interface SessionHost {
  readonly shell: PlaybookCaptainShell;
  readonly host: { runBossTurn(input: string): Promise<void>; abortActiveTurn(): void; dispose(): Promise<void>; [key: string]: any };
  readonly snapshot: PlaybookCaptainShellSnapshot;
  reconcileRepositoryEffects(): Promise<PlaybookEffectLedger>;
}
export interface SessionHostOptions {
  readonly config: SessionExecutionProjection;
  readonly sessionId?: string;
  readonly cwd: string;
  readonly sessionLease: PlaybookSessionLifecycle;
  readonly loadModule: (specifier: string) => Promise<any>;
  readonly restoreSnapshot?: PlaybookCaptainShellSnapshot;
  readonly reconcileUncertainTurnReplay?: boolean;
  readonly signal?: AbortSignal;
  readonly [key: string]: any;
}
export declare function createCaptainSessionHost(options: SessionHostOptions): Promise<SessionHost>;
export declare function installRetainedGenerationsForLaunch(options: {
  lease: PlaybookSessionLifecycle;
  shell: PlaybookCaptainShell;
  freshBoundary?: SessionFreshBoundary;
  onFreshRecord?: (record: SessionRecovery | undefined) => void;
  onLegacyRecord?: (record: any) => void | Promise<void>;
  onInvalidRecord?: (record: any) => void | Promise<void>;
  retainedGenerations?: Readonly<Record<string, any>>;
  reconcileRepositoryEffects?: () => Promise<PlaybookEffectLedger>;
}): Promise<Readonly<Record<string, any>>>;
export declare function executionConfigFromPlan(plan: any): SessionExecutionProjection;
export declare function validateFrozenExecutionConfig(structural: SessionStructuralProjection, execution: SessionExecutionProjection, dependencies: { loadModule: (specifier: string) => Promise<any>; prepareRegistryModule?: (request: {id: string; from: string; authoredFrom: string}) => Promise<string | void> }): Promise<SessionExecutionProjection>;
export declare function driveHeadlessCaptainTurn(options: any): Promise<any>;
export declare function normalizeLaunchPlan(top: any, options?: any): Promise<any>;
export declare function loadLaunchPlan(options: any): Promise<any>;
export declare function composeGenericConfig(top: any, loadModule: (specifier: string) => Promise<any>, configPath?: string): Promise<any>;
export declare function projectTmuxConfig(plan: any): any;
export declare function resolveLaunchSessionsDir(options: any): string;

import type { SharedSessionStore, ReplayStreamStatus, ReplayStreamEntry, SessionGraph } from './session-store.js';
export interface OpenSessionHostOptions {
  readonly store?: SharedSessionStore;
  readonly sessionsDir?: string;
  readonly sessionId?: string;
  readonly mode?: 'new' | 'continue' | 'retry';
  readonly cwd?: string;
  readonly config?: SessionExecutionProjection;
  readonly plan?: any;
  readonly loadModule?: (specifier: string) => Promise<any>;
  readonly prepareRegistryModule?: (request: {id: string; from: string; authoredFrom: string}) => Promise<string | void>;
  readonly observers?: readonly { onRecord?(record: any): void | Promise<void> }[];
  readonly onStoredRecord?: (record: ReplayStreamEntry, status: ReplayStreamStatus) => void | Promise<void>;
  readonly onCheckpoint?: (record: SessionRecovery) => void | Promise<void>;
  readonly onIncomplete?: () => void | Promise<void>;
  readonly graphs?: readonly { playbookId: string; graph: SessionGraph | null }[];
  readonly initialVisible?: readonly string[];
  readonly [key: string]: any;
}
export interface SessionHostController {
  readonly sessionId: string;
  readonly host: SessionHost['host'];
  readonly shell: PlaybookCaptainShell;
  readonly lease: PlaybookSessionLifecycle;
  read(): Promise<SessionRecovery | undefined>;
  handleBossTurn(input: string): Promise<SessionRecovery>;
  /**
   * The active leaf's currently advertised runtime actions, read live between
   * turns; empty whenever nothing is advertised, a turn is active, or the
   * leaf's control view cannot be read. Each pair carries the leaf's own
   * `standing` and its `reason`, so a host never draws a control without
   * saying what running it would do (DR-063).
   */
  listRuntimeActions(): readonly PlaybookControlAction[];
  /**
   * Submit one currently advertised runtime action as the session's next turn.
   * The turn is the same durable transaction `handleBossTurn` runs, and its
   * decision is the submitted selection, so no decision model call is made.
   */
  submitRuntimeAction(actionId: string): Promise<SessionRecovery>;
  /**
   * The controls the shell offers on its own behalf, read live between turns;
   * today one `ready` give-up while a root is engaged, and empty while idle or
   * while a turn is active. Disjoint from `listRuntimeActions`, which reads the
   * leaf.
   */
  listShellActions(): readonly PlaybookControlAction[];
  /**
   * Submit one currently advertised shell control as the session's next turn.
   * The turn is the same durable transaction `handleBossTurn` runs; both its
   * decision and its closing reply are the shell's, so the turn makes no model
   * call and a give-up survives a provider that is refusing everything.
   */
  submitShellAction(actionId: string): Promise<SessionRecovery>;
  retry(): Promise<SessionRecovery>;
  dispose(): Promise<void>;
}
export declare function openSessionHost(options: OpenSessionHostOptions): Promise<SessionHostController>;
export declare function discardSessionUncertain(store: SharedSessionStore, sessionId: string): Promise<SessionRecovery | undefined>;
