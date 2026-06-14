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
  finalText?: string;
  error?: string;
}

export interface PlaybookPorts {
  callPlayer(
    playerId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<PlayerResult>;
  callJudge(prompt: string, signal: AbortSignal): Promise<string>;
  emitStatus(message: string, data?: unknown): Promise<void>;
  emitTelemetry(event: { topic: string; payload: unknown }): Promise<void>;
}

export interface PlaybookRuntime {
  init(ports: PlaybookPorts): Promise<void>;
  handleBossInput(turn: { text: string; signal: AbortSignal }): Promise<void>;
  dispose(): Promise<void>;
}

export type PlaybookRuntimeFactory<Options = unknown> = (
  options: Options,
) => PlaybookRuntime;
