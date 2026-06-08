// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './code.playbook.js';
// PBRT-29/30: CODE runtime options are carried under
// `captain.options.code`, a namespaced object the host forwards
// verbatim through `captain.options`. cligent neither reads nor
// validates `options.code` (PBRT-30); this adapter is the sole
// validator. The CODE options schema defines one key, `committer`: an
// optional Committer-alias player id, one of the baked player ids
// `coder` / `reviewer`. A valid `options.code` is absent, `{}`, or
// `{ committer: 'coder' | 'reviewer' }`; every other key is unknown
// and rejected with a path-named error, and an out-of-range
// `committer` value is rejected naming `captain.options.code.committer`.
// A further CODE option shall be introduced as its own higher-numbered
// item that widens `CODE_OPTION_KEYS`; the validator still fails closed
// on stray keys.
const CODE_OPTION_KEYS = new Set(['committer']);
const COMMITTER_PLAYER_IDS = new Set(['coder', 'reviewer']);
export function validateCodeOptions(captainOptions) {
    const code = readCodeNamespace(captainOptions);
    if (code === undefined)
        return {};
    if (typeof code !== 'object' || code === null || Array.isArray(code)) {
        throw new Error('captain.options.code must be an object');
    }
    for (const key of Object.keys(code)) {
        if (!CODE_OPTION_KEYS.has(key)) {
            throw new Error(`Unknown config field captain.options.code.${key}`);
        }
    }
    const options = {};
    const committer = code.committer;
    if (committer !== undefined) {
        if (typeof committer !== 'string' || !COMMITTER_PLAYER_IDS.has(committer)) {
            throw new Error("captain.options.code.committer must be 'coder' or 'reviewer'");
        }
        options.committer = committer;
    }
    return options;
}
function readCodeNamespace(captainOptions) {
    if (typeof captainOptions !== 'object' ||
        captainOptions === null ||
        Array.isArray(captainOptions)) {
        return undefined;
    }
    return captainOptions.code;
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
export default function createCodeTmuxPlayCaptain(options) {
    // CaptainSession is bound at init time and persists across turns;
    // CaptainContext is rebuilt per turn and carries the call
    // primitives. The runtime is constructed in `init` so identity
    // strings derived from `session.players` can flow into its options;
    // PlaybookPorts is built once at init, so the per-turn context
    // lives in a closure-scoped slot the port callbacks query lazily.
    let runtime;
    let activeContext;
    return {
        async init(session) {
            // PBRT-30: validate `captain.options.code` before constructing
            // the runtime so a stray key fails `init` closed with a
            // path-named error; the empty schema yields an empty options set.
            const codeOptions = validateCodeOptions(options);
            const playerIdentity = (id) => {
                const entry = session.players.find((p) => p.id === id);
                return entry?.model ?? entry?.adapter;
            };
            const coderPlayer = playerIdentity('coder');
            const reviewerPlayer = playerIdentity('reviewer');
            // Identity strings from `session.players` override any same-named
            // keys and are independent of `captain.options.code` (PBRT-30).
            // The validated `committer` alias threads in as the runtime's
            // Committer player id (`committerPlayer`, PBRT-8).
            const runtimeOptions = {
                coderPlayer,
                reviewerPlayer,
                ...(codeOptions.committer !== undefined
                    ? { committerPlayer: codeOptions.committer }
                    : {}),
            };
            runtime = createPlaybookRuntime(runtimeOptions);
            const ports = {
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
                        throw new Error(r.error ?? `callCaptain status "${r.status}"`);
                    }
                    if (r.finalText === undefined) {
                        throw new Error('callCaptain returned status=ok with no finalText');
                    }
                    return r.finalText;
                },
                emitStatus: async (message, data) => {
                    await session.emitStatus(message, data);
                },
                emitTelemetry: async (event) => {
                    await session.emitTelemetry(event);
                },
            };
            await runtime.init(ports);
        },
        async handleBossTurn(turn, context) {
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
            }
            finally {
                activeContext = undefined;
            }
        },
        async dispose() {
            await runtime?.dispose();
        },
    };
}
