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
    const byId = new Map();
    for (const entry of registry) {
        byCommand.set(entry.command, entry);
        byId.set(entry.id, entry);
    }
    return { entries: registry, byCommand, byId };
}
export function createPlaybookCaptainShell(options, registry = playbookCaptainRegistry) {
    const { entries, byCommand, byId } = normalizeRegistry(registry);
    let session;
    let players = [];
    let activeContext;
    let active;
    let mode = 'chat';
    let lastRouteDecision;
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
    const disposeActive = async () => {
        const engagement = active;
        active = undefined;
        mode = 'chat';
        await engagement?.runtime.dispose();
    };
    const callVisibleChat = async (context, message) => {
        const result = await context.callCaptain(visibleChatEnvelope(message));
        if (result.status !== 'ok') {
            throw new Error(result.error ?? `callCaptain status "${result.status}"`);
        }
    };
    const ledgerSnapshot = () => ({
        ...(active ? { activePlaybookId: active.entry.id } : {}),
        mode,
        ...(lastRouteDecision ? { lastRouteDecision } : {}),
    });
    const hiddenRouterEnvelope = (prompt) => [
        'You are the Playbook Captain shell router.',
        'This is hidden control work. Return only one JSON object and no prose.',
        'Allowed decisions:',
        '{"decision":"chat","text":"visible clarification or chat reply"}',
        '{"decision":"dispatch","playbookId":"<registered id>","text":"Boss text for that playbook"}',
        '{"decision":"sub","text":"Boss text for the active playbook"}',
        '{"decision":"dismiss","text":"optional visible dismissal reply"}',
        'Use chat for near-miss command-like input or low-confidence playbook selection.',
        'Treat unregistered slash-prefixed input as ordinary router input.',
        `Ledger:\n${JSON.stringify(ledgerSnapshot())}`,
        `Registry:\n${JSON.stringify(entries.map((entry) => ({
            id: entry.id,
            command: entry.command,
            intent: entry.intent,
        })))}`,
        `Boss message:\n${prompt}`,
    ].join('\n\n');
    const routerClarification = async (context) => {
        await callVisibleChat(context, 'I could not route that safely. Ask Boss to clarify whether they want shell chat or /code.');
    };
    const parseRouterDecision = (finalText) => {
        let parsed;
        try {
            parsed = JSON.parse(finalText);
        }
        catch {
            return undefined;
        }
        if (typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)) {
            return undefined;
        }
        const record = parsed;
        const decision = record.decision;
        if (decision === 'chat') {
            return typeof record.text === 'string' && record.text.trim()
                ? { decision, text: record.text.trim() }
                : undefined;
        }
        if (decision === 'dispatch') {
            return typeof record.playbookId === 'string' &&
                byId.has(record.playbookId) &&
                typeof record.text === 'string' &&
                record.text.trim()
                ? {
                    decision,
                    playbookId: record.playbookId,
                    text: record.text.trim(),
                }
                : undefined;
        }
        if (decision === 'sub') {
            return typeof record.text === 'string' && record.text.trim()
                ? { decision, text: record.text.trim() }
                : undefined;
        }
        if (decision === 'dismiss') {
            return typeof record.text === 'string' && record.text.trim()
                ? { decision, text: record.text.trim() }
                : { decision };
        }
        return undefined;
    };
    const routeHidden = async (turn, context) => {
        const result = await context.callCaptain(hiddenRouterEnvelope(turn.prompt), { visibility: 'hidden' });
        if (result.status !== 'ok' || result.finalText === undefined) {
            await routerClarification(context);
            return;
        }
        const decision = parseRouterDecision(result.finalText);
        if (!decision) {
            await routerClarification(context);
            return;
        }
        lastRouteDecision = decision.decision;
        if (decision.decision === 'chat') {
            await callVisibleChat(context, decision.text);
            return;
        }
        if (decision.decision === 'dispatch') {
            const entry = byId.get(decision.playbookId);
            if (!entry || (active && active.entry.id !== entry.id)) {
                await routerClarification(context);
                return;
            }
            const engagement = await engage(entry);
            await submitToActive(engagement, decision.text, context.signal);
            return;
        }
        if (decision.decision === 'sub') {
            if (!active) {
                await routerClarification(context);
                return;
            }
            await submitToActive(active, decision.text, context.signal);
            return;
        }
        if (!active) {
            await routerClarification(context);
            return;
        }
        await disposeActive();
        await callVisibleChat(context, decision.text ?? 'The active playbook engagement has been dismissed.');
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
                await routeHidden(turn, context);
            }
            finally {
                activeContext = undefined;
            }
        },
        async dispose() {
            const engagement = active;
            activeContext = undefined;
            active = undefined;
            mode = 'chat';
            await engagement?.runtime.dispose();
        },
    };
}
export default createPlaybookCaptainShell;
