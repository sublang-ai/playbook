// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { codePlaybookRegistryEntry, } from './code.registry.js';
export const playbookCaptainRegistry = [
    codePlaybookRegistryEntry,
];
function parseRegisteredCommand(prompt) {
    const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!match)
        return undefined;
    return { command: match[1], text: (match[2] ?? '').trim() };
}
function visibleChatEnvelope(message) {
    return [
        'You are the Playbook Captain shell.',
        'This is visible Boss chat. Do not reveal hidden control JSON, hidden router decisions, or hidden judge replies.',
        message,
    ].join('\n\n');
}
function normalizeRegistry(registry) {
    const byCommand = new Map();
    for (const entry of registry) {
        byCommand.set(entry.command, entry);
    }
    return { entries: registry, byCommand };
}
export function createPlaybookCaptainShell(options, registry = playbookCaptainRegistry) {
    const { entries, byCommand } = normalizeRegistry(registry);
    let session;
    let players = [];
    let activeContext;
    let active;
    let mode = 'chat';
    const requireSession = () => {
        if (!session) {
            throw new Error('init must be called first');
        }
        return session;
    };
    const createPorts = () => ({
        callPlayer: async (playerId, prompt, _signal) => {
            if (!activeContext) {
                throw new Error('callPlayer invoked outside a Boss turn');
            }
            const result = await activeContext.callPlayer(playerId, prompt);
            return {
                status: result.status,
                finalText: result.finalText,
                error: result.error,
            };
        },
        callJudge: async (prompt, _signal) => {
            if (!activeContext) {
                throw new Error('callJudge invoked outside a Boss turn');
            }
            const result = await activeContext.callCaptain(prompt, {
                visibility: 'hidden',
            });
            if (result.status !== 'ok') {
                throw new Error(result.error ?? `callCaptain status "${result.status}"`);
            }
            if (result.finalText === undefined) {
                throw new Error('callCaptain returned status=ok with no finalText');
            }
            return result.finalText;
        },
        emitStatus: async (message, data) => {
            await requireSession().emitStatus(message, data);
        },
        emitTelemetry: async (event) => {
            await requireSession().emitTelemetry(event);
        },
    });
    const engage = async (entry) => {
        if (active?.entry.id === entry.id)
            return active;
        const runtime = entry.createRuntime({
            captainOptions: options,
            players,
        });
        active = { entry, runtime };
        mode = 'engaged.parked';
        await runtime.init(createPorts());
        await requireSession().emitStatus(`◇ shell engaged ${entry.id}`, {
            playbookId: entry.id,
            mode,
        });
        return active;
    };
    const submitToActive = async (engagement, text, signal) => {
        mode = 'engaged.driving';
        try {
            await engagement.runtime.handleBossInput({ text, signal });
        }
        finally {
            if (active === engagement) {
                mode = 'engaged.parked';
            }
        }
    };
    const callVisibleChat = async (context, message) => {
        const result = await context.callCaptain(visibleChatEnvelope(message));
        if (result.status !== 'ok') {
            throw new Error(result.error ?? `callCaptain status "${result.status}"`);
        }
    };
    const handleRegisteredCommand = async (entry, text, context) => {
        if (active && active.entry.id !== entry.id) {
            await callVisibleChat(context, `Boss requested /${entry.command}, but ${active.entry.command} is already engaged. Ask Boss to finish, dismiss, or resolve the current engagement first.`);
            return;
        }
        const engagement = await engage(entry);
        if (text.length === 0) {
            await callVisibleChat(context, `Boss selected /${entry.command} without a task. Ask for the task to run in ${entry.id}.`);
            return;
        }
        await submitToActive(engagement, text, context.signal);
    };
    return {
        async init(initSession) {
            session = initSession;
            players = initSession.players;
            for (const entry of entries) {
                entry.validateOptions(options);
            }
            mode = 'chat';
        },
        async handleBossTurn(turn, context) {
            requireSession();
            activeContext = context;
            try {
                const command = parseRegisteredCommand(turn.prompt);
                if (command !== undefined) {
                    const entry = byCommand.get(command.command);
                    if (entry) {
                        await handleRegisteredCommand(entry, command.text, context);
                        return;
                    }
                }
                await callVisibleChat(context, `Boss said: ${turn.prompt}\n\nAsk whether they want to run /code or continue in shell chat.`);
            }
            finally {
                activeContext = undefined;
            }
        },
        async dispose() {
            const engagement = active;
            active = undefined;
            activeContext = undefined;
            mode = 'chat';
            await engagement?.runtime.dispose();
        },
    };
}
export default createPlaybookCaptainShell;
