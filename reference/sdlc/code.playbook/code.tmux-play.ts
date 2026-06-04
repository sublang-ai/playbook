// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// tmux-play host adapter for the CODE playbook — DR-004 §11. This is
// the only file in IR-004 that imports cligent; removing the import
// shall not affect code.playbook.ts or its tests.

import type {
  BossTurn,
  Captain,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
} from '@sublang/cligent/tmux-play';
import createPlaybookRuntime, {
  type CodePlaybookOptions,
  type PlaybookPorts,
  type PlaybookRuntime,
} from './code.playbook.js';

// ─── TEMPORARY cligent augmentation — remove on the cligent bump ────
// DR-007 / PBRT-15: every judge call (classification + adjudication)
// rides `context.callCaptain(prompt, { visibility: 'hidden' })` so the
// judge's JSON never streams to the Boss pane and duplicates the
// runtime's composed glyph lines. The installed `@sublang/cligent`
// ("latest") still types `callCaptain(prompt)` with no options arg, so
// this module augmentation adds the hidden-visibility overload to make
// the adapter compile against today's published types — without bumping
// the dependency or touching the lockfile.
//
// TODO(cligent-bump): DELETE this whole block once
// `@sublang/cligent/tmux-play` ships the `visibility` option on
// `callCaptain`. The `CLIGENT_SUPPORTS_HIDDEN_CAPTAIN` flag in
// code.tmux-play.test.ts flips to `true` in the same change.
declare module '@sublang/cligent/tmux-play' {
  interface CaptainContext {
    callCaptain(
      prompt: string,
      options?: { readonly visibility?: 'hidden' | 'visible' },
    ): Promise<CaptainRunResult>;
  }
}

// PBRT-29/30: CODE runtime options are carried under
// `captain.options.code`, a namespaced object the host forwards
// verbatim through `captain.options`. cligent neither reads nor
// validates `options.code` (PBRT-30); this adapter is the sole
// validator. The CODE options schema defines no keys yet, so a valid
// `options.code` is an empty object or absent, every key is unknown
// and rejected with a path-named error, and the adapter passes an
// empty options set into `createPlaybookRuntime`. A new CODE option
// shall be introduced as its own higher-numbered item that extends
// `CODE_OPTION_KEYS`; until then the validator exists to establish the
// seam and fail closed on stray keys.
const CODE_OPTION_KEYS = new Set<string>();

// The validated CODE options set. Empty today (no keys defined); a
// future CODE option widens both this type and `CODE_OPTION_KEYS`.
export type CodeOptions = Record<string, never>;

export function validateCodeOptions(captainOptions: unknown): CodeOptions {
  const code = readCodeNamespace(captainOptions);
  if (code === undefined) return {};
  if (typeof code !== 'object' || code === null || Array.isArray(code)) {
    throw new Error('captain.options.code must be an object');
  }
  for (const key of Object.keys(code)) {
    if (!CODE_OPTION_KEYS.has(key)) {
      throw new Error(`Unknown config field captain.options.code.${key}`);
    }
  }
  return {};
}

function readCodeNamespace(captainOptions: unknown): unknown {
  if (
    typeof captainOptions !== 'object' ||
    captainOptions === null ||
    Array.isArray(captainOptions)
  ) {
    return undefined;
  }
  return (captainOptions as Record<string, unknown>).code;
}

// Captain factory per TMUX-014: `(options: unknown) => Captain`.
// `options` is whatever `captain.options` carries in the YAML config;
// CODE reads only the namespaced `options.code` (PBRT-30). The per-run
// player identity strings (`coderPlayer`, `reviewerPlayer`) are
// derived from `session.players` at init time per PBRT-4 — preferring
// each entry's `model` and falling back to `adapter` when no model is
// pinned — so player prompts and commit-message trailers carry the
// concrete model identity (e.g. `claude-opus-4-7`) rather than the
// adapter family name (e.g. `claude`). They come from `session.players`
// independent of `captain.options.code` and override any same-named
// keys.
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
      // PBRT-30: validate `captain.options.code` before constructing
      // the runtime so a stray key fails `init` closed with a
      // path-named error; the empty schema yields an empty options set.
      const codeOptions = validateCodeOptions(options);
      const playerIdentity = (id: string): string | undefined => {
        const entry = session.players.find((p) => p.id === id);
        return entry?.model ?? entry?.adapter;
      };
      const coderPlayer = playerIdentity('coder');
      const reviewerPlayer = playerIdentity('reviewer');
      // Identity strings from `session.players` override any same-named
      // keys and are independent of `captain.options.code` (PBRT-30).
      const runtimeOptions: CodePlaybookOptions = {
        ...codeOptions,
        coderPlayer,
        reviewerPlayer,
      };
      runtime = createPlaybookRuntime(runtimeOptions);
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
          // PBRT-15 / DR-007: run the judge call hidden so its JSON
          // reply never reaches the Boss pane; the runtime composes the
          // human-readable pane lines (PBRT-3) from the parsed result.
          const r = await activeContext.callCaptain(prompt, {
            visibility: 'hidden',
          });
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
