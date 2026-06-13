// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { codePlaybookRegistryEntry, } from './code.registry.js';
const SUB_RUNTIME_FSM_TOPIC = 'playbook.fsm.state';
const SHELL_FSM_TOPIC = 'playbook.captain.fsm.state';
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
function visibleTurnSummaryEnvelope(input) {
    const savedLine = `Saved you: ${input.counts.interruptions} interruptions and ${input.counts.copyPastes} copy-pastes`;
    return [
        'You are the Playbook Captain shell.',
        'This is visible Boss chat after a sub-playbook command completed. Do not reveal hidden control JSON, hidden router decisions, or hidden judge replies.',
        'Write a brief, clearly formatted turn-summary block for Boss.',
        'Use a natural, chat-like tone and no more than two short sentences before the saved-count paragraph.',
        'State only what was done or what changed; do not explain how it was done.',
        'Do not list raw state names, transitions, guard names, prompts, tools, hidden calls, or reasoning.',
        'If state or progress detail is useful, use only the aggregate State counts phrase supplied below.',
        `Then write one short paragraph beginning exactly: ${savedLine}`,
        'Use the exact counts supplied; do not change them.',
        `Playbook: ${input.playbookId}`,
        `Submitted Boss text:\n${input.submittedText}`,
        `State counts:\n${input.stateCountPhrase}`,
        `Counts:\n${JSON.stringify(input.counts)}`,
        `Ledger:\n${JSON.stringify(input.ledger)}`,
    ].join('\n\n');
}
function splitStateWords(stateId) {
    return stateId
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}
function stateCountLabel(stateId, entry) {
    if (stateId === entry.idleStateId || stateId === entry.finalStateId) {
        return undefined;
    }
    const registryLabel = entry.stateCountLabels?.[stateId]?.trim();
    if (registryLabel)
        return registryLabel;
    const words = splitStateWords(stateId);
    if (words.length === 0)
        return `${stateId} state`;
    const fallback = words.join(' ');
    return fallback.endsWith(' state') ? fallback : `${fallback} state`;
}
function pluralizeStateCount(label, count) {
    if (count === 1)
        return `1 ${label}`;
    if (label.endsWith('y'))
        return `${count} ${label.slice(0, -1)}ies`;
    if (label.endsWith('s'))
        return `${count} ${label}es`;
    return `${count} ${label}s`;
}
function stateCountPhrase(stateCounts) {
    if (stateCounts.size === 0)
        return 'none';
    return [...stateCounts.entries()]
        .map(([label, count]) => pluralizeStateCount(label, count))
        .join(', ');
}
function guardFromJudgeReply(finalText) {
    return /"guard"\s*:\s*"([^"]+)"/.exec(finalText)?.[1];
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
    let latestSubRuntimeStateId;
    let pendingBossQuestion;
    let lastError;
    let lastRouteDecision;
    let finalDisposalRequested;
    let activeTurnSummary;
    const requireSession = () => {
        if (!session) {
            throw new Error('init must be called first');
        }
        return session;
    };
    const ledgerSnapshot = (playbookId = active?.entry.id) => ({
        ...(playbookId ? { activePlaybookId: playbookId } : {}),
        mode,
        ...(latestSubRuntimeStateId ? { latestSubRuntimeStateId } : {}),
        ...(pendingBossQuestion !== undefined ? { pendingBossQuestion } : {}),
        ...(lastError ? { lastError } : {}),
        ...(lastRouteDecision ? { lastRouteDecision } : {}),
    });
    const emitShellTelemetry = async (from, to, event, playbookId = active?.entry.id) => {
        await requireSession().emitTelemetry({
            topic: SHELL_FSM_TOPIC,
            payload: {
                from,
                to,
                event,
                ledger: ledgerSnapshot(playbookId),
            },
        });
    };
    const setMode = async (nextMode, event, playbookId = active?.entry.id) => {
        if (mode === nextMode)
            return;
        const from = mode;
        mode = nextMode;
        await emitShellTelemetry(from, nextMode, event, playbookId);
    };
    const normalizeErrorCompact = (value) => {
        if (value === undefined || value === null)
            return undefined;
        if (value instanceof Error) {
            return { name: value.name, message: value.message };
        }
        if (typeof value === 'object') {
            const record = value;
            if (typeof record.message === 'string') {
                return {
                    name: typeof record.name === 'string' ? record.name : 'Error',
                    message: record.message,
                };
            }
        }
        return { name: 'Error', message: String(value) };
    };
    const payloadRecord = (payload) => typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload
        : undefined;
    const mirroredStateId = (payload) => {
        const record = payloadRecord(payload);
        if (!record)
            return undefined;
        if (typeof record.to === 'string')
            return record.to;
        return typeof record.state === 'string' ? record.state : undefined;
    };
    const mirrorSubRuntimeTelemetry = async (payload) => {
        if (!active)
            return;
        const record = payloadRecord(payload);
        const stateId = mirroredStateId(payload);
        if (stateId === undefined)
            return;
        const countLabel = stateCountLabel(stateId, active.entry);
        if (activeTurnSummary && countLabel) {
            activeTurnSummary.stateCounts.set(countLabel, (activeTurnSummary.stateCounts.get(countLabel) ?? 0) + 1);
        }
        latestSubRuntimeStateId = stateId;
        pendingBossQuestion = record?.pendingBossQuestion;
        lastError = normalizeErrorCompact(record?.lastError);
        if (stateId === active.entry.finalStateId) {
            finalDisposalRequested = active;
            return;
        }
        if (stateId === active.entry.idleStateId ||
            stateId === 'failed' ||
            stateId === 'awaitBossReply') {
            await setMode('engaged.parked', `sub-runtime:${stateId}`);
        }
    };
    const createPorts = () => ({
        callPlayer: async (playerId, prompt, _signal) => {
            if (!activeContext) {
                throw new Error('callPlayer invoked outside a Boss turn');
            }
            const result = await activeContext.callPlayer(playerId, prompt);
            if (activeTurnSummary) {
                activeTurnSummary.counts.interruptions++;
            }
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
            const guard = guardFromJudgeReply(result.finalText);
            if (guard &&
                active?.entry.copyPasteGuardNames.includes(guard) &&
                activeTurnSummary) {
                activeTurnSummary.counts.copyPastes++;
            }
            return result.finalText;
        },
        emitStatus: async (message, data) => {
            await requireSession().emitStatus(message, data);
        },
        emitTelemetry: async (event) => {
            if (event.topic === SUB_RUNTIME_FSM_TOPIC) {
                await mirrorSubRuntimeTelemetry(event.payload);
            }
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
        latestSubRuntimeStateId = undefined;
        pendingBossQuestion = undefined;
        lastError = undefined;
        finalDisposalRequested = undefined;
        await setMode('engaged.parked', 'engage', entry.id);
        await runtime.init(createPorts());
        await requireSession().emitStatus(`◇ shell engaged ${entry.id}`);
        return active;
    };
    const submitToActive = async (engagement, text, context) => {
        const summaryCounts = {
            interruptions: 0,
            copyPastes: 0,
        };
        const summaryStateCounts = new Map();
        let summaryLedger;
        let shouldSummarize = false;
        activeTurnSummary = {
            counts: summaryCounts,
            stateCounts: summaryStateCounts,
        };
        await setMode('engaged.driving', 'submit');
        try {
            await engagement.runtime.handleBossInput({
                text,
                signal: context.signal,
            });
            shouldSummarize = true;
        }
        finally {
            summaryLedger = ledgerSnapshot(engagement.entry.id);
            activeTurnSummary = undefined;
            if (active === engagement && finalDisposalRequested === engagement) {
                finalDisposalRequested = undefined;
                await disposeActive('final');
            }
            else if (active === engagement && mode === 'engaged.driving') {
                await setMode('engaged.parked', 'turn.settled');
            }
        }
        if (shouldSummarize && summaryLedger) {
            await callVisibleTurnSummary(context, {
                playbookId: engagement.entry.id,
                submittedText: text,
                counts: summaryCounts,
                stateCountPhrase: stateCountPhrase(summaryStateCounts),
                ledger: summaryLedger,
            });
        }
    };
    const disposeActive = async (reason) => {
        const engagement = active;
        if (!engagement)
            return;
        const playbookId = engagement.entry.id;
        active = undefined;
        finalDisposalRequested = undefined;
        if (reason === 'dispose') {
            mode = 'chat';
            await engagement.runtime.dispose();
            latestSubRuntimeStateId = undefined;
            pendingBossQuestion = undefined;
            lastError = undefined;
            return;
        }
        await setMode('chat', reason, playbookId);
        await engagement.runtime.dispose();
        if (reason === 'dismiss') {
            await requireSession().emitStatus(`◇ shell dismissed ${playbookId}`);
        }
        else if (reason === 'final') {
            await requireSession().emitStatus(`◇ shell disposed ${playbookId}`);
        }
        latestSubRuntimeStateId = undefined;
        pendingBossQuestion = undefined;
        lastError = undefined;
    };
    const callVisibleChat = async (context, message) => {
        const result = await context.callCaptain(visibleChatEnvelope(message));
        if (result.status !== 'ok') {
            throw new Error(result.error ?? `callCaptain status "${result.status}"`);
        }
    };
    const callVisibleTurnSummary = async (context, input) => {
        const result = await context.callCaptain(visibleTurnSummaryEnvelope(input));
        if (result.status !== 'ok') {
            throw new Error(result.error ?? `callCaptain status "${result.status}"`);
        }
    };
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
            await submitToActive(engagement, decision.text, context);
            return;
        }
        if (decision.decision === 'sub') {
            if (!active) {
                await routerClarification(context);
                return;
            }
            await submitToActive(active, decision.text, context);
            return;
        }
        if (!active) {
            await routerClarification(context);
            return;
        }
        await disposeActive('dismiss');
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
        await submitToActive(engagement, text, context);
    };
    return {
        async init(initSession) {
            session = initSession;
            players = initSession.players;
            for (const entry of entries) {
                entry.validateOptions(options);
            }
            await setMode('chat', 'init');
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
            activeContext = undefined;
            await disposeActive('dispose');
        },
    };
}
export default createPlaybookCaptainShell;
