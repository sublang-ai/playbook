// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// tmux-play host adapter for the CODE playbook — DR-004 §11. This is
// the only file in IR-004 that imports cligent; removing the import
// shall not affect code.playbook.ts or its tests.

import type {
  BossTurn,
  Captain,
  CaptainContext,
  CaptainSession,
} from '@sublang/cligent/tmux-play';
import createPlaybookRuntime, {
  type CodePlaybookOptions,
  type PlaybookPorts,
  type PlaybookRuntime,
} from './code.playbook.js';

// Captain factory per TMUX-014: `(options: unknown) => Captain`.
// `options` is whatever `captain.options` carries in the YAML config.
// The per-run player identity strings (`coderPlayer`, `reviewerPlayer`)
// are derived from `session.players` at init time per PBRT-4 —
// preferring each entry's `model` and falling back to `adapter` when
// no model is pinned — so player prompts and commit-message trailers
// carry the concrete model identity (e.g. `claude-opus-4-7`) rather
// than the adapter family name (e.g. `claude`). Any same-named keys
// in `options` are ignored.
export default function createCodeTmuxPlayCaptain(
  options: unknown,
): Captain {
  // CaptainSession is bound at init time and persists across turns;
  // CaptainContext is rebuilt per turn and carries the call
  // primitives. The runtime is constructed in `init` so identity
  // strings derived from `session.players` can flow into its options;
  // PlaybookPorts is built once at init, so the per-turn context
  // lives in a closure-scoped slot the port callbacks query lazily.
  let runtime: PlaybookRuntime | undefined;
  let activeContext: CaptainContext | undefined;

  return {
    async init(session: CaptainSession): Promise<void> {
      const playerIdentity = (id: string): string | undefined => {
        const entry = session.players.find((p) => p.id === id);
        return entry?.model ?? entry?.adapter;
      };
      const coderPlayer = playerIdentity('coder');
      const reviewerPlayer = playerIdentity('reviewer');
      runtime = createPlaybookRuntime({
        ...(options as CodePlaybookOptions),
        coderPlayer,
        reviewerPlayer,
      });
      const ports: PlaybookPorts = {
        callPlayer: async (playerId, prompt, _signal) => {
          if (!activeContext) {
            throw new Error('callPlayer invoked outside a Boss turn');
          }
          // PlayerRunResult per TMUX-033 already matches PlayerResult
          // (`status: 'ok' | 'aborted' | 'error'`, `finalText?`,
          // `error?`). cligent honors context.signal internally;
          // the runtime's signal is the same source forwarded
          // through handleBossInput, so dropping `_signal` is
          // safe.
          const r = await activeContext.callPlayer(playerId, prompt);
          return {
            status: r.status,
            finalText: r.finalText,
            error: r.error,
          };
        },
        callJudge: async (prompt, _signal) => {
          if (!activeContext) {
            throw new Error('callJudge invoked outside a Boss turn');
          }
          const r = await activeContext.callCaptain(prompt);
          if (r.status !== 'ok') {
            throw new Error(
              r.error ?? `callCaptain status "${r.status}"`,
            );
          }
          if (r.finalText === undefined) {
            throw new Error(
              'callCaptain returned status=ok with no finalText',
            );
          }
          return r.finalText;
        },
        emitStatus: async (message, data) => {
          await session.emitStatus(
            message,
            data as Record<string, unknown> | undefined,
          );
        },
        emitTelemetry: async (event) => {
          await session.emitTelemetry(event);
        },
      };
      await runtime.init(ports);
    },

    async handleBossTurn(
      turn: BossTurn,
      context: CaptainContext,
    ): Promise<void> {
      if (!runtime) {
        throw new Error('init must be called first');
      }
      activeContext = context;
      try {
        // Forward the Boss prompt + cligent's per-turn signal into
        // the runtime; the runtime stashes the signal so the
        // captain bridge passes it down to callPlayer / callJudge.
        await runtime.handleBossInput({
          text: turn.prompt,
          signal: context.signal,
        });
      } finally {
        activeContext = undefined;
      }
    },

    async dispose(): Promise<void> {
      await runtime?.dispose();
    },
  };
}
