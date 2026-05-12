// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './code.playbook.js';
// Captain factory per TMUX-014: `(options: unknown) => Captain`.
// `options` is whatever `captain.options` carries in the YAML config;
// for the CODE playbook this is `CodePlaybookOptions` (coderPlayer,
// reviewerPlayer, plus the rest of CodingInput).
export default function createCodeTmuxPlayCaptain(options) {
    const runtime = createPlaybookRuntime(options);
    // CaptainSession is bound at init time and persists across turns;
    // CaptainContext is rebuilt per turn and carries the call
    // primitives. PlaybookPorts is built once at init, so the per-turn
    // context lives in a closure-scoped slot the port callbacks query
    // lazily.
    let activeContext;
    return {
        async init(session) {
            const ports = {
                callPlayer: async (playerId, prompt, _signal) => {
                    if (!activeContext) {
                        throw new Error('callPlayer invoked outside a Boss turn');
                    }
                    // RoleRunResult per TMUX-033 already matches PlayerResult
                    // (`status: 'ok' | 'aborted' | 'error'`, `finalText?`,
                    // `error?`). cligent honors context.signal internally;
                    // the runtime's signal is the same source forwarded
                    // through handleBossInput, so dropping `_signal` is
                    // safe.
                    const r = await activeContext.callRole(playerId, prompt);
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
            await runtime.dispose();
        },
    };
}
