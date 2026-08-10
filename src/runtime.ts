// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Public runtime contract for @sublang/playbook — the type-only single
// source for the PlaybookPorts / PlaybookRuntime contract authored in
// slc/link.md. It imports no CODE or FSM types, so the dependency runs
// one way: linked playbook runtimes (e.g. code.playbook.ts) import and
// re-export these names rather than redefining them
// (PBRT-5, PBRT-34, DR-004 Addendum A4).

export interface PlayerResult {
  status: 'ok' | 'aborted' | 'error';
  resumeToken?: string;
  finalText?: string;
  error?: string;
}

export interface PlayerCallOptions {
  resume: string | false;
}

// DR-030: a composing host may supply one frame-local view of the root
// engagement's player continuation. The runtime selects through this store
// before tracing/calling and updates it from the validated result. Hosts that
// omit it retain the runtime's private per-session store.
export interface PlayerSessionStore {
  select(playerId: string): string | false;
  update(playerId: string, resumeToken?: string): void;
  snapshot(): Readonly<Record<string, string>>;
  restore(tokens: Readonly<Record<string, string>>): void;
}

export interface CaptainCallOptions {
  visibility: 'visible' | 'hidden';
  resume: string | false;
  allowedTools?: readonly string[];
}

export interface CaptainResult {
  status: 'ok' | 'aborted' | 'error';
  finalText?: string;
  error?: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface NormalizedError {
  name: string;
  message: string;
  stack?: string;
}

export type PlaybookStateValue =
  | string
  | { readonly [key: string]: PlaybookStateValue };

export interface PlaybookState {
  value: PlaybookStateValue;
  activeStateIds: readonly string[];
  tags: readonly string[];
  status: 'active' | 'done' | 'error' | 'stopped';
  quiescent: boolean;
  stateId?: string;
}

export interface PlaybookPendingCall {
  callId: string;
  playbookId: string;
  childSessionId: string;
}

export interface PlaybookCallRequest {
  callId: string;
  playbookId: string;
  text: string;
}

export type PlaybookCallResult =
  | {
      status: 'ok';
      playbookId: string;
      childSessionId: string;
      state?: PlaybookState;
      output?: JsonValue;
    }
  | {
      status: 'aborted';
      playbookId: string;
      childSessionId?: string;
      state?: PlaybookState;
      error?: NormalizedError;
    }
  | {
      status: 'error';
      playbookId: string;
      childSessionId?: string;
      state?: PlaybookState;
      error: NormalizedError;
    };

export type PlaybookCallStart =
  | { state: 'settled'; result: PlaybookCallResult }
  | { state: 'suspended'; childSessionId: string };

export type PlaybookRunResult =
  | { outcome: 'quiescent' | 'no-action'; state: PlaybookState }
  | {
      outcome: 'failed' | 'aborted';
      state: PlaybookState;
      error?: NormalizedError;
    }
  | {
      outcome: 'terminal';
      state: PlaybookState;
      output?: JsonValue;
    }
  | {
      outcome: 'suspended';
      state: PlaybookState;
      pendingCall: PlaybookPendingCall;
    };

export interface PlaybookPorts {
  callPlayer(
    playerId: string,
    prompt: string,
    signal: AbortSignal,
    options: PlayerCallOptions,
  ): Promise<PlayerResult>;
  callCaptain(
    prompt: string,
    signal: AbortSignal,
    options: CaptainCallOptions,
  ): Promise<CaptainResult>;
  callJudge(prompt: string, signal: AbortSignal): Promise<string>;
  callPlaybook(
    request: PlaybookCallRequest,
    signal: AbortSignal,
  ): Promise<PlaybookCallStart>;
  emitStatus(message: string, data?: unknown): Promise<void>;
  emitTelemetry(event: { topic: string; payload: unknown }): Promise<void>;
}

export interface PlaybookSession {
  sessionId: string;
  playbookId: string;
  rootSessionId: string;
  parentSessionId?: string;
  parentCallId?: string;
  depth: number;
  playerSessions?: PlayerSessionStore;
  ports: PlaybookPorts;
}

export type PlaybookTraceType =
  | 'session.started'
  | 'boss.input.received'
  | 'judge.call.started'
  | 'judge.call.finished'
  | 'player.call.started'
  | 'player.call.finished'
  | 'captain.call.started'
  | 'captain.call.finished'
  | 'playbook.call.started'
  | 'playbook.call.finished'
  | 'apply.started'
  | 'apply.finished'
  | 'fsm.transition'
  | 'status.emitted'
  | 'boss.input.settled'
  | 'session.disposed';

export interface PlaybookTraceEvent {
  schemaVersion: 2;
  sessionId: string;
  playbookId: string;
  rootSessionId: string;
  parentSessionId?: string;
  parentCallId?: string;
  depth: number;
  sequence: number;
  timestamp: number;
  type: PlaybookTraceType;
  turnId?: number;
  callId?: string;
  payload: JsonValue;
}

export interface PlaybookPendingBossQuestion {
  questionId: string;
  player: string;
  question: string;
  sourceItem?: string;
}

// DR-014 §1: JSON-safe capture of a parked session. `machine` is the
// XState persisted snapshot and is opaque to hosts; the pending Boss
// questions are first-class so a host can surface what was asked
// without parsing status lines or telemetry.
export interface PlaybookRuntimeSnapshot {
  schemaVersion: 1;
  playbookId: string;
  machine: JsonValue;
  playerResumeTokens: { readonly [playerId: string]: string };
  sequences: {
    trace: number;
    turn: number;
    judgeCall: number;
    playerCall: number;
    playbookCall: number;
    captainCall?: number;
  };
  state: PlaybookState;
  pendingBossQuestions: readonly PlaybookPendingBossQuestion[];
}

// DR-029: one currently valid, runtime-advertised control action. The id
// is stable within the returned view; the label is runtime-written,
// Boss-appropriate text derived from source state descriptions.
export interface PlaybookControlAction {
  id: string;
  label: string;
}

// DR-029: the sanitized control view `describe()` returns — current
// state and the runtime-written description of what that state means,
// the authored context projection, pending Boss questions, the last
// recorded error, and the currently valid actions. `stateDescription` is
// the Boss-appropriate grounding a host may speak from; the state id is
// internal and is absent from it whenever the runtime's source declares
// no description for the state it is in.
export interface PlaybookControlView {
  state: PlaybookState;
  stateDescription?: string;
  context?: JsonValue;
  pendingQuestions: readonly PlaybookPendingBossQuestion[];
  lastError?: NormalizedError;
  actions: readonly PlaybookControlAction[];
}

// DR-029: the receipt `apply()` returns says which of three things
// happened — rejected before any effect, executed with the settled run
// result, or failed after effects may exist.
export type PlaybookControlReceipt =
  | { disposition: 'rejected'; reason: string }
  | { disposition: 'executed'; run: PlaybookRunResult }
  | { disposition: 'failed'; error: NormalizedError };

export interface PlaybookRuntime {
  init(session: PlaybookSession): Promise<void>;
  // DR-014 §1 optional durable-session capability: a runtime implements
  // both members or neither. `exportSnapshot` returns undefined outside
  // a safe capture point (parked quiescence between public boundaries);
  // `restore` is an alternative to `init` that rehydrates the exported
  // snapshot under the same immutable session identity.
  exportSnapshot?(): PlaybookRuntimeSnapshot | undefined;
  restore?(
    session: PlaybookSession,
    snapshot: PlaybookRuntimeSnapshot,
  ): Promise<void>;
  // DR-029 optional control-surface capability: a runtime implements
  // both members or neither. `describe` is side-effect free and valid at
  // parked quiescence outside an active boundary; `apply` revalidates the
  // named action against the live state, executes it at most once per
  // idempotency key within that runtime instance, and returns a receipt. A
  // runtime lacking the pair advertises no actions; plain text delivery is
  // the only verb against it.
  describe?(): PlaybookControlView;
  apply?(input: {
    actionId: string;
    key: string;
    signal: AbortSignal;
  }): Promise<PlaybookControlReceipt>;
  handleBossInput(turn: {
    text: string;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult>;
  resumePlaybookCall(input: {
    callId: string;
    result: PlaybookCallResult;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult>;
  dispose(): Promise<void>;
}

export type PlaybookRuntimeFactory<Options = unknown> = (
  options: Options,
) => PlaybookRuntime;
