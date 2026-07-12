// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import { registerPlaybookAbortCleanup } from '../../../src/xstate-runtime.js';
import createDefaultCaptainRuntime from '../captain.playbook/captain.playbook.js';
class VisibilityControlError extends Error {
    constructor(cause) {
        super(`playbook visibility request failed: ${String(cause?.message ?? cause)}`, { cause });
        this.name = 'VisibilityControlError';
    }
}
const SUB_RUNTIME_FSM_TOPIC = 'playbook.fsm.state';
const SHELL_FSM_TOPIC = 'playbook.captain.fsm.state';
const INTERNAL_CAPTAIN_ID = 'captain';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseRegisteredCommand(prompt) {
    const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!match)
        return undefined;
    return { command: match[1], text: (match[2] ?? '').trim() };
}
function visibleChatEnvelope(message) {
    return [
        'You are the Playbook Captain shell.',
        'This is visible Boss chat. Do not reveal hidden control JSON, hidden lifecycle decisions, or hidden judge replies.',
        message,
    ].join('\n\n');
}
function visibleTurnSummaryEnvelope(input) {
    return [
        'You are the Playbook Captain shell.',
        'This is visible Boss chat after a sub-playbook command completed. Do not reveal hidden control JSON, hidden lifecycle decisions, or hidden judge replies.',
        'Write a brief, clearly formatted turn-summary block for Boss.',
        'Use a natural, chat-like tone and no more than two short sentences before the saved-counts line.',
        'State only what was done or what changed; do not explain how it was done.',
        'Do not list raw state names, transitions, guard names, prompts, tools, hidden calls, or reasoning.',
        'If progress detail is useful, use only the aggregate progress phrase supplied below.',
        "Do not mention counts for states the active playbook's summary policy does not label.",
        `Then write the saved-counts line exactly: ${input.savedLine}`,
        'Use the exact counts supplied; do not change them.',
        'Do not repeat the exact progress round count outside the saved-counts line.',
        `Playbook: ${input.playbookId}`,
        `Submitted Boss text:\n${input.submittedText}`,
        `Progress counts:\n${input.progressPhrase}`,
        `Counts:\n${JSON.stringify({
            ...input.counts,
            progressRounds: input.progressRounds,
        })}`,
    ].join('\n\n');
}
function stateCountLabel(stateId, entry) {
    const registryLabel = entry.summaryPolicy?.stateCountLabels?.[stateId]?.trim();
    return registryLabel || undefined;
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
function summaryProgressPhrase(stateCounts) {
    if (stateCounts.size === 0)
        return 'none';
    return [...stateCounts.entries()]
        .map(([label, count]) => pluralizeStateCount(label, count))
        .join(', ');
}
function summaryProgressRoundCount(stateCounts) {
    return [...stateCounts.values()].reduce((total, count) => total + count, 0);
}
function guardFromJudgeReply(finalText) {
    return /"guard"\s*:\s*"([^"]+)"/.exec(finalText)?.[1];
}
function isValidRegistryEntry(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const e = value;
    return (typeof e.id === 'string' &&
        typeof e.command === 'string' &&
        typeof e.intent === 'string' &&
        Array.isArray(e.requiredRoleIds) &&
        typeof e.validateOptions === 'function' &&
        typeof e.createRuntime === 'function');
}
function readPlaybooksConfig(options) {
    if (typeof options !== 'object' || options === null)
        return undefined;
    const pb = options.playbooks;
    if (typeof pb !== 'object' || pb === null || Array.isArray(pb)) {
        return undefined;
    }
    return pb;
}
// Resolve the active registry at init from `captain.options.playbooks`
// (CAPTAIN-16): each enabled playbook is loaded from its explicit `from`
// module and bound to namespaced `<id>-<role>` host players.
async function buildEnablements(options, players, loadModule) {
    const entries = [];
    const byCommand = new Map();
    const byId = new Map();
    const enablementById = new Map();
    const config = readPlaybooksConfig(options);
    if (config === undefined) {
        throw new Error('captain.options.playbooks is required');
    }
    const ids = Object.keys(config);
    if (ids.length === 0) {
        throw new Error('captain.options.playbooks must enable at least one playbook');
    }
    for (const id of ids) {
        if (id === INTERNAL_CAPTAIN_ID) {
            throw new Error(`captain.options.playbooks.${id} collides with the reserved internal Captain id`);
        }
        const block = config[id];
        if (typeof block !== 'object' || block === null || Array.isArray(block)) {
            throw new Error(`captain.options.playbooks.${id} must be an object`);
        }
        const record = block;
        const from = record.from;
        if (typeof from !== 'string' || from.length === 0) {
            throw new Error(`captain.options.playbooks.${id}.from must be a module specifier`);
        }
        let mod;
        try {
            mod = await loadModule(from);
        }
        catch (cause) {
            throw new Error(`captain.options.playbooks.${id}.from "${from}" failed to import: ${String(cause?.message ?? cause)}`);
        }
        const entry = mod?.default;
        if (!isValidRegistryEntry(entry)) {
            throw new Error(`captain.options.playbooks.${id}.from "${from}" exposes no valid registry entry`);
        }
        if (entry.id !== id) {
            throw new Error(`captain.options.playbooks.${id} key must equal the module manifest id "${entry.id}"`);
        }
        if (byId.has(entry.id)) {
            throw new Error(`captain.options.playbooks has a duplicate playbook id "${entry.id}"`);
        }
        const command = typeof record.command === 'string' && record.command.length > 0
            ? record.command
            : entry.command;
        if (command === INTERNAL_CAPTAIN_ID) {
            throw new Error(`captain.options.playbooks.${id} command collides with the reserved internal Captain command`);
        }
        if (byCommand.has(command)) {
            throw new Error(`captain.options.playbooks has a duplicate effective command "${command}"`);
        }
        const boundPlayers = entry.requiredRoleIds.map((role) => {
            const host = players.find((p) => p.id === `${entry.id}-${role}`);
            return {
                id: role,
                ...(host?.adapter !== undefined ? { adapter: host.adapter } : {}),
                ...(host?.model !== undefined ? { model: host.model } : {}),
            };
        });
        entries.push(entry);
        byId.set(entry.id, entry);
        byCommand.set(command, entry);
        enablementById.set(entry.id, {
            entry,
            command,
            optionInput: record.options,
            boundPlayers,
            hostPlayerId: (localRole) => `${entry.id}-${localRole}`,
            visiblePlayerIds: entry.requiredRoleIds.map((role) => `${entry.id}-${role}`),
        });
    }
    return { entries, byCommand, byId, enablementById };
}
export function createPlaybookCaptainShell(options, deps = {}) {
    const loadModule = deps.loadModule ?? ((specifier) => import(specifier));
    const createSessionId = deps.createSessionId ?? randomUUID;
    const createCaptainRuntime = deps.createCaptainRuntime ?? createDefaultCaptainRuntime;
    let entries = [];
    let byCommand = new Map();
    let byId = new Map();
    let enablementById = new Map();
    let internalCaptainEnablement;
    let session;
    let players = [];
    let activeContext;
    const frames = [];
    let mode = 'chat';
    let pendingBossQuestions;
    let lastError;
    let lastRouteDecision;
    let activeTurnSummary;
    let activeTurnHostCalls;
    const issuedSessionIds = new Set();
    const pendingChildParents = new Set();
    const captainQueue = new PQueue({ concurrency: 1 });
    let disposing = false;
    const rootFrame = () => frames[0];
    const leafFrame = () => frames.at(-1);
    const frameLabel = (frame) => frame.internal ? 'Captain' : `/${frame.enablement.command}`;
    const requireSession = () => {
        if (!session) {
            throw new Error('init must be called first');
        }
        return session;
    };
    const ledgerSnapshot = (playbookId = leafFrame()?.entry.id, activeSessionId = leafFrame()?.sessionId) => ({
        ...(playbookId ? { activePlaybookId: playbookId } : {}),
        ...(activeSessionId ? { activeSessionId } : {}),
        ...(rootFrame()
            ? {
                rootPlaybookId: rootFrame().entry.id,
                rootSessionId: rootFrame().sessionId,
            }
            : {}),
        stackDepth: frames.length,
        stackPath: frames.map((frame) => frame.entry.id),
        mode,
        ...(leafFrame()?.state?.stateId
            ? { latestSubRuntimeStateId: leafFrame().state.stateId }
            : {}),
        ...(leafFrame()?.state
            ? { latestSubRuntimeState: leafFrame().state }
            : {}),
        ...(pendingBossQuestions !== undefined ? { pendingBossQuestions } : {}),
        ...(lastError ? { lastError } : {}),
        ...(lastRouteDecision ? { lastRouteDecision } : {}),
    });
    const emitShellTelemetry = async (from, to, event, playbookId = leafFrame()?.entry.id, activeSessionId = leafFrame()?.sessionId) => {
        await requireSession().emitTelemetry({
            topic: SHELL_FSM_TOPIC,
            payload: {
                from,
                to,
                event,
                ledger: ledgerSnapshot(playbookId, activeSessionId),
            },
        });
    };
    const setMode = async (nextMode, event, playbookId = leafFrame()?.entry.id, activeSessionId = leafFrame()?.sessionId) => {
        if (mode === nextMode)
            return;
        const from = mode;
        mode = nextMode;
        await emitShellTelemetry(from, nextMode, event, playbookId, activeSessionId);
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
    const playbookState = (value) => {
        const record = payloadRecord(value);
        if (!record ||
            !Array.isArray(record.activeStateIds) ||
            !record.activeStateIds.every((id) => typeof id === 'string') ||
            !Array.isArray(record.tags) ||
            !record.tags.every((tag) => typeof tag === 'string') ||
            typeof record.status !== 'string' ||
            typeof record.quiescent !== 'boolean' ||
            !('value' in record)) {
            return undefined;
        }
        return record;
    };
    const stateValueContains = (value, stateId) => {
        if (typeof value === 'string')
            return value === stateId;
        const record = payloadRecord(value);
        if (!record)
            return false;
        return Object.entries(record).some(([key, nested]) => key === stateId || stateValueContains(nested, stateId));
    };
    const drainHostCalls = async (calls) => {
        while (calls.size > 0) {
            await Promise.allSettled([...calls]);
        }
    };
    const trackHostCall = (frame, call) => {
        // Cligent's host methods are scoped to the whole Boss turn, while an
        // XState invocation can carry a narrower sibling-cancellation signal.
        // Keep both frame and turn ownership after XState stops awaiting the
        // promise so the host cannot outlive frame disposal or turn settlement.
        const turnCalls = activeTurnHostCalls;
        let tracked;
        tracked = call.finally(() => {
            frame.inFlightHostCalls.delete(tracked);
            turnCalls?.delete(tracked);
        });
        frame.inFlightHostCalls.add(tracked);
        turnCalls?.add(tracked);
        return tracked;
    };
    const callCaptainQueued = (frame, context, prompt, options, signal) => {
        const queued = captainQueue.add(async () => {
            signal.throwIfAborted();
            const result = await trackHostCall(frame, context.callCaptain(prompt, options));
            signal.throwIfAborted();
            return result;
        });
        return trackHostCall(frame, queued);
    };
    const mirrorSubRuntimeTelemetry = async (frame, payload) => {
        const record = payloadRecord(payload);
        const state = playbookState(record?.state);
        if (!record || !state)
            return;
        const previousActiveIds = new Set(frame.state?.activeStateIds ?? []);
        frame.state = state;
        if (activeTurnSummary?.owner === frame) {
            for (const stateId of state.activeStateIds) {
                const newlyActive = !previousActiveIds.has(stateId);
                const structuredEntry = stateValueContains(record.to, stateId) &&
                    !stateValueContains(record.from, stateId);
                if (!newlyActive && !structuredEntry)
                    continue;
                const countLabel = stateCountLabel(stateId, frame.entry);
                if (countLabel) {
                    activeTurnSummary.stateCounts.set(countLabel, (activeTurnSummary.stateCounts.get(countLabel) ?? 0) + 1);
                }
            }
        }
        if (leafFrame() === frame) {
            pendingBossQuestions =
                record.pendingBossQuestions ?? record.pendingBossQuestion;
            lastError = normalizeErrorCompact(record.lastError);
            if (state.quiescent && state.tags.includes('playbook.parked')) {
                await setMode('engaged.parked', `sub-runtime:${state.stateId ?? 'structured'}`);
            }
        }
    };
    let callNestedPlaybook;
    const createPorts = (frame) => ({
        callPlayer: async (playerId, prompt, signal, options) => {
            if (!activeContext) {
                throw new Error('callPlayer invoked outside a Boss turn');
            }
            const context = activeContext;
            signal.throwIfAborted();
            const hostPlayerId = frame.enablement.hostPlayerId(playerId);
            const result = await trackHostCall(frame, context.callPlayer(hostPlayerId, prompt, {
                resume: options.resume,
            }));
            // CaptainContext is turn-scoped and cannot accept a narrower XState
            // invocation signal. Recheck after the host call so a sibling
            // cancellation is still reported as aborted and cannot rotate a
            // stopped branch's player token in the linked runtime.
            signal.throwIfAborted();
            if (activeTurnSummary?.owner === frame) {
                activeTurnSummary.counts.interruptions++;
            }
            return {
                status: result.status,
                ...(result.resumeToken !== undefined
                    ? { resumeToken: result.resumeToken }
                    : {}),
                ...(result.finalText !== undefined
                    ? { finalText: result.finalText }
                    : {}),
                ...(result.error !== undefined ? { error: result.error } : {}),
            };
        },
        callCaptain: async (prompt, signal, options) => {
            if (!activeContext) {
                throw new Error('callCaptain invoked outside a Boss turn');
            }
            const result = await callCaptainQueued(frame, activeContext, prompt, { visibility: options.visibility }, signal);
            return {
                status: result.status,
                ...(result.finalText !== undefined
                    ? { finalText: result.finalText }
                    : {}),
                ...(result.error !== undefined ? { error: result.error } : {}),
            };
        },
        callJudge: async (prompt, signal) => {
            if (!activeContext) {
                throw new Error('callJudge invoked outside a Boss turn');
            }
            const result = await callCaptainQueued(frame, activeContext, prompt, { visibility: 'hidden' }, signal);
            if (result.status !== 'ok') {
                throw new Error(result.error ?? `callCaptain status "${result.status}"`);
            }
            if (result.finalText === undefined) {
                throw new Error('callCaptain returned status=ok with no finalText');
            }
            const guard = guardFromJudgeReply(result.finalText);
            if (guard &&
                activeTurnSummary?.owner === frame &&
                frame.entry.summaryPolicy?.copyPasteGuardNames.includes(guard)) {
                activeTurnSummary.counts.copyPastes++;
            }
            return result.finalText;
        },
        callPlaybook: (request, signal) => {
            const opening = callNestedPlaybook(frame, request, signal);
            let exposed;
            const registerOpeningCleanup = () => {
                registerPlaybookAbortCleanup(signal, exposed);
            };
            exposed = opening.finally(() => {
                signal.removeEventListener('abort', registerOpeningCleanup);
            });
            signal.addEventListener('abort', registerOpeningCleanup, { once: true });
            if (signal.aborted)
                registerOpeningCleanup();
            return exposed;
        },
        emitStatus: async (message, data) => {
            if (frame.internal)
                return;
            await requireSession().emitStatus(message, data);
        },
        emitTelemetry: async (event) => {
            if (event.topic === SUB_RUNTIME_FSM_TOPIC) {
                await mirrorSubRuntimeTelemetry(frame, event.payload);
            }
            await requireSession().emitTelemetry(event);
        },
    });
    // CAPTAIN-22: before dispatching to a playbook, request tmux-play
    // visibility for that playbook's generated host players. A pane
    // reconciliation failure is display-only in tmux-play and does not
    // reject; the legacy path carries no generated set and skips this.
    const requestVisibility = async (enablement) => {
        const ids = enablement.visiblePlayerIds;
        if (!ids || ids.length === 0 || !activeContext)
            return;
        try {
            await activeContext.setVisiblePlayers(ids);
        }
        catch (error) {
            throw new VisibilityControlError(error);
        }
    };
    const allocateSessionId = () => {
        const sessionId = createSessionId();
        if (!UUID_PATTERN.test(sessionId)) {
            throw new Error(`playbook session id generator returned a non-UUID value: ${JSON.stringify(sessionId)}`);
        }
        if (issuedSessionIds.has(sessionId)) {
            throw new Error(`playbook session id collision: ${sessionId}`);
        }
        issuedSessionIds.add(sessionId);
        return sessionId;
    };
    const normalizeErrorFull = (value) => {
        const compact = normalizeErrorCompact(value) ?? {
            name: 'Error',
            message: String(value),
        };
        const stack = value instanceof Error
            ? value.stack
            : typeof value === 'object' && value !== null
                ? value.stack
                : undefined;
        return typeof stack === 'string' ? { ...compact, stack } : compact;
    };
    const makeFrame = (enablement, parent, internal = false) => {
        const entry = enablement.entry;
        const sessionId = allocateSessionId();
        const runtime = entry.createRuntime({
            captainOptions: enablement.optionInput,
            players: enablement.boundPlayers,
        });
        return {
            entry,
            enablement,
            runtime,
            sessionId,
            rootSessionId: parent?.frame.rootSessionId ?? sessionId,
            depth: parent ? parent.frame.depth + 1 : 0,
            ...(parent ? { parent } : {}),
            inFlightHostCalls: new Set(),
            internal,
        };
    };
    const initFrame = async (frame) => {
        await frame.runtime.init({
            sessionId: frame.sessionId,
            playbookId: frame.entry.id,
            rootSessionId: frame.rootSessionId,
            ...(frame.parent
                ? {
                    parentSessionId: frame.parent.frame.sessionId,
                    parentCallId: frame.parent.callId,
                }
                : {}),
            depth: frame.depth,
            ports: createPorts(frame),
        });
    };
    const clearLeafLedger = () => {
        pendingBossQuestions = undefined;
        lastError = undefined;
    };
    const engageEnablement = async (enablement, internal) => {
        const entry = enablement.entry;
        const existing = rootFrame();
        if (existing?.entry.id === entry.id && frames.length === 1) {
            return existing;
        }
        if (existing) {
            throw new Error('cannot engage a second root playbook');
        }
        const frame = makeFrame(enablement, undefined, internal);
        frames.push(frame);
        clearLeafLedger();
        try {
            await setMode('engaged.parked', 'engage', entry.id, frame.sessionId);
            await initFrame(frame);
            if (!internal) {
                await requireSession().emitStatus(`◇ ${frameLabel(frame)} started`);
            }
            return frame;
        }
        catch (error) {
            if (leafFrame() === frame)
                frames.pop();
            mode = 'chat';
            clearLeafLedger();
            try {
                await frame.runtime.dispose();
            }
            catch {
                // Preserve the initialization failure while still making a
                // best-effort attempt to release partially acquired resources.
            }
            throw error;
        }
    };
    const engage = async (entry) => engageEnablement(enablementById.get(entry.id), false);
    const createInternalCaptainEnablement = () => {
        const catalog = Object.freeze(entries.map((entry) => Object.freeze({
            id: entry.id,
            command: enablementById.get(entry.id).command,
            intent: entry.intent,
        })));
        const entry = {
            id: INTERNAL_CAPTAIN_ID,
            command: INTERNAL_CAPTAIN_ID,
            intent: 'internal orchestration policy',
            requiredRoleIds: [],
            validateOptions: () => undefined,
            createRuntime: () => createCaptainRuntime({ enabledPlaybooks: catalog }),
        };
        return {
            entry,
            command: INTERNAL_CAPTAIN_ID,
            optionInput: undefined,
            boundPlayers: [],
            hostPlayerId(localRole) {
                throw new Error(`internal Captain has no player binding for ${JSON.stringify(localRole)}`);
            },
        };
    };
    const engageInternalCaptain = async () => {
        if (!internalCaptainEnablement) {
            throw new Error('internal Captain enablement is unavailable before init');
        }
        return engageEnablement(internalCaptainEnablement, true);
    };
    const disposeFrame = (frame) => {
        if (frame.disposePromise)
            return frame.disposePromise;
        const operation = (async () => {
            if (frame.invocationSignal && frame.abortListener) {
                frame.invocationSignal.removeEventListener('abort', frame.abortListener);
            }
            frame.invocationSignal = undefined;
            frame.abortListener = undefined;
            let disposeError;
            try {
                await frame.runtime.dispose();
            }
            catch (error) {
                disposeError = error;
            }
            await drainHostCalls(frame.inFlightHostCalls);
            if (disposeError !== undefined)
                throw disposeError;
        })();
        frame.disposePromise = operation;
        return operation;
    };
    const removeTopFrame = (frame, reason) => {
        if (frame.removal) {
            return {
                claimed: false,
                reason: frame.removal.reason,
                promise: frame.removal.promise,
            };
        }
        const operation = (async () => {
            if (leafFrame() !== frame) {
                throw new Error('nested playbook stack is not LIFO');
            }
            let removalError;
            try {
                await disposeFrame(frame);
            }
            catch (error) {
                removalError = error;
            }
            finally {
                if (leafFrame() === frame) {
                    frames.pop();
                    if (frame.parent) {
                        pendingChildParents.delete(frame.parent.frame);
                    }
                    pendingChildParents.delete(frame);
                }
                else if (frames.includes(frame)) {
                    const stackError = new Error('nested playbook stack changed during frame removal');
                    removalError =
                        removalError === undefined
                            ? stackError
                            : new AggregateError([removalError, stackError], 'nested playbook frame removal failed');
                }
            }
            if (removalError !== undefined)
                throw removalError;
        })();
        frame.removal = { reason, promise: operation };
        return { claimed: true, reason, promise: operation };
    };
    const unwindFramesFrom = async (frame, reason = 'stack') => {
        const index = frames.indexOf(frame);
        if (index < 0)
            return;
        const failures = [];
        while (frames.length > index) {
            const current = leafFrame();
            const removal = removeTopFrame(current, reason);
            try {
                await removal.promise;
            }
            catch (error) {
                failures.push(error);
            }
            if (frames.includes(current)) {
                failures.push(new Error('nested playbook frame remained after removal attempt'));
                break;
            }
        }
        clearLeafLedger();
        if (failures.length === 1)
            throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, 'nested playbook stack disposal failed');
        }
    };
    const popChild = async (frame, status) => {
        if (!frame.parent || (leafFrame() !== frame && !frame.removal)) {
            throw new Error('nested playbook stack is not LIFO');
        }
        const parent = frame.parent.frame;
        const removal = removeTopFrame(frame, 'return');
        if (!removal.claimed) {
            await removal.promise;
            return false;
        }
        let cleanupError;
        try {
            await removal.promise;
        }
        catch (error) {
            cleanupError = error;
        }
        const message = status === 'returned'
            ? `◇ ${frameLabel(frame)} returned to ${frameLabel(parent)}`
            : `◇ ${frameLabel(frame)} stopped; returning to ${frameLabel(parent)}`;
        try {
            await requireSession().emitStatus(message);
        }
        catch (error) {
            cleanupError =
                cleanupError === undefined
                    ? error
                    : new AggregateError([cleanupError, error], 'nested playbook return cleanup failed');
        }
        let visibilityError;
        try {
            await requestVisibility(parent.enablement);
        }
        catch (error) {
            visibilityError = error;
        }
        if (visibilityError !== undefined) {
            if (cleanupError !== undefined) {
                throw new VisibilityControlError(new AggregateError([cleanupError, visibilityError], 'nested playbook return and visibility failed'));
            }
            throw visibilityError;
        }
        if (cleanupError !== undefined)
            throw cleanupError;
        return true;
    };
    const disposeStack = async (reason) => {
        const root = rootFrame();
        if (!root)
            return;
        const rootId = root.entry.id;
        const rootSessionId = root.sessionId;
        const failures = [];
        disposing = true;
        try {
            if (reason !== 'dispose') {
                try {
                    await setMode('chat', reason, rootId, rootSessionId);
                }
                catch (error) {
                    failures.push(error);
                    mode = 'chat';
                }
            }
            else {
                mode = 'chat';
            }
            try {
                await unwindFramesFrom(root);
            }
            catch (error) {
                failures.push(error);
            }
        }
        finally {
            disposing = false;
            pendingChildParents.clear();
            clearLeafLedger();
        }
        if (!root.internal) {
            try {
                if (reason === 'dismiss') {
                    await requireSession().emitStatus(`◇ ${frameLabel(root)} stopped`);
                }
                else if (reason === 'final') {
                    await requireSession().emitStatus(`◇ ${frameLabel(root)} finished`);
                }
            }
            catch (error) {
                failures.push(error);
            }
        }
        if (failures.length === 1)
            throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, 'playbook stack disposal failed');
        }
    };
    const callResultFor = (frame, result) => {
        if (result.outcome === 'terminal') {
            return {
                status: 'ok',
                playbookId: frame.entry.id,
                childSessionId: frame.sessionId,
                state: result.state,
                ...(result.output !== undefined ? { output: result.output } : {}),
            };
        }
        if (result.outcome === 'aborted') {
            return {
                status: 'aborted',
                playbookId: frame.entry.id,
                childSessionId: frame.sessionId,
                state: result.state,
                ...(result.error ? { error: result.error } : {}),
            };
        }
        throw new Error(`playbook ${frame.entry.id} has not returned`);
    };
    const assertRetainableResult = (frame, result) => {
        if (result.outcome === 'suspended')
            return;
        if (result.state.quiescent &&
            result.state.tags.includes('playbook.parked')) {
            return;
        }
        throw new Error(`playbook ${frame.entry.id} returned outcome "${result.outcome}" ` +
            'without a quiescent playbook.parked state');
    };
    const driveFrame = async (frame, text, context, signal = context.signal) => {
        if (leafFrame() !== frame) {
            throw new Error('only the active leaf may receive Boss input');
        }
        await requestVisibility(frame.enablement);
        await setMode('engaged.driving', 'submit');
        const result = await frame.runtime.handleBossInput({
            text,
            signal,
        });
        frame.state = result.state;
        return result;
    };
    async function resumeParent(child, callResult, context, status = 'returned') {
        const parentLink = child.parent;
        if (!parentLink)
            throw new Error('root playbook has no caller');
        const parent = parentLink.frame;
        const invocationSignal = child.invocationSignal;
        let effectiveResult = callResult;
        let ownsReturn = false;
        let visibilityControlError;
        try {
            ownsReturn = await popChild(child, status);
        }
        catch (error) {
            ownsReturn = child.removal?.reason === 'return';
            if (error instanceof VisibilityControlError) {
                visibilityControlError = error;
            }
            else {
                effectiveResult = {
                    status: context.signal.aborted ? 'aborted' : 'error',
                    playbookId: child.entry.id,
                    childSessionId: child.sessionId,
                    ...(child.state ? { state: child.state } : {}),
                    error: normalizeErrorFull(error),
                };
            }
        }
        if (!ownsReturn ||
            disposing ||
            invocationSignal?.aborted ||
            !frames.includes(parent)) {
            return;
        }
        let result;
        try {
            result = await parent.runtime.resumePlaybookCall({
                callId: parentLink.callId,
                result: effectiveResult,
                signal: context.signal,
            });
        }
        catch (error) {
            if (disposing || invocationSignal?.aborted)
                return;
            await returnBoundaryFailure(parent, error, context);
            return;
        }
        parent.state = result.state;
        await processFrameResult(parent, result, context);
        if (visibilityControlError !== undefined)
            throw visibilityControlError;
    }
    async function returnBoundaryFailure(frame, error, context) {
        if (!frame.parent)
            throw error;
        await resumeParent(frame, {
            status: context.signal.aborted ? 'aborted' : 'error',
            playbookId: frame.entry.id,
            childSessionId: frame.sessionId,
            ...(frame.state ? { state: frame.state } : {}),
            error: normalizeErrorFull(error),
        }, context);
    }
    async function processFrameResult(frame, result, context) {
        if (result.outcome === 'terminal') {
            if (frame.parent) {
                await resumeParent(frame, callResultFor(frame, result), context);
            }
            else {
                await disposeStack('final');
            }
            return;
        }
        if (result.outcome === 'aborted' && frame.parent) {
            await resumeParent(frame, callResultFor(frame, result), context);
            return;
        }
        assertRetainableResult(frame, result);
        if (leafFrame()) {
            await setMode('engaged.parked', `turn:${result.outcome}`);
        }
    }
    const disposeAbandonedChild = async (child) => {
        if (disposing || !frames.includes(child) || !child.parent)
            return;
        if (child.removal) {
            await child.removal.promise;
            return;
        }
        const parent = child.parent.frame;
        let cleanupError;
        try {
            await unwindFramesFrom(child, 'abandoned');
        }
        catch (error) {
            cleanupError = error;
        }
        if (frames.includes(parent)) {
            await requestVisibility(parent.enablement);
        }
        if (cleanupError !== undefined)
            throw cleanupError;
    };
    callNestedPlaybook = async (parent, request, invocationSignal) => {
        if (!activeContext) {
            throw new Error('callPlaybook invoked outside a Boss turn');
        }
        invocationSignal.throwIfAborted();
        if (leafFrame() !== parent) {
            throw new Error('only the active leaf may call a child playbook');
        }
        if (pendingChildParents.has(parent)) {
            throw new Error('playbook frame already has an outstanding child');
        }
        if (typeof request.callId !== 'string' || request.callId.trim() === '') {
            throw new Error('nested playbook call id must be a non-empty string');
        }
        if (typeof request.playbookId !== 'string' ||
            request.playbookId.trim() === '') {
            throw new Error('nested playbook id must be a non-empty string');
        }
        if (typeof request.text !== 'string') {
            throw new Error('nested playbook input text must be a string');
        }
        if (request.playbookId === INTERNAL_CAPTAIN_ID) {
            throw new Error('the internal Captain playbook cannot call itself');
        }
        const entry = byId.get(request.playbookId);
        if (!entry) {
            throw new Error(`playbook "${request.playbookId}" is not enabled`);
        }
        if (frames.some((frame) => frame.entry.id === request.playbookId)) {
            throw new Error(`nested playbook cycle: ${[
                ...frames.map((frame) => frame.entry.id),
                request.playbookId,
            ].join(' -> ')}`);
        }
        pendingChildParents.add(parent);
        let child;
        try {
            child = makeFrame(enablementById.get(entry.id), {
                frame: parent,
                callId: request.callId,
            });
        }
        catch (error) {
            pendingChildParents.delete(parent);
            throw error;
        }
        frames.push(child);
        clearLeafLedger();
        let calledStatusEmitted = false;
        let returnStatusHandled = false;
        try {
            await initFrame(child);
            invocationSignal.throwIfAborted();
            await requireSession().emitStatus(`◇ ${frameLabel(child)} called by ${frameLabel(parent)}`);
            calledStatusEmitted = true;
            const result = await driveFrame(child, request.text, activeContext, AbortSignal.any([invocationSignal, activeContext.signal]));
            if (result.outcome === 'terminal' || result.outcome === 'aborted') {
                const callResult = callResultFor(child, result);
                returnStatusHandled = true;
                const returned = await popChild(child, result.outcome === 'aborted' ? 'stopped' : 'returned');
                if (!returned) {
                    throw new Error('nested playbook return lost its active frame');
                }
                return { state: 'settled', result: callResult };
            }
            assertRetainableResult(child, result);
            if (invocationSignal.aborted) {
                const callResult = {
                    status: 'aborted',
                    playbookId: child.entry.id,
                    childSessionId: child.sessionId,
                    state: result.state,
                };
                returnStatusHandled = true;
                const returned = await popChild(child, 'stopped');
                if (!returned) {
                    throw new Error('nested playbook abort lost its active frame');
                }
                return { state: 'settled', result: callResult };
            }
            const abortListener = () => {
                registerPlaybookAbortCleanup(invocationSignal, disposeAbandonedChild(child));
            };
            child.invocationSignal = invocationSignal;
            child.abortListener = abortListener;
            invocationSignal.addEventListener('abort', abortListener, { once: true });
            return { state: 'suspended', childSessionId: child.sessionId };
        }
        catch (error) {
            let boundaryError = error;
            let visibilityControlFailure = error instanceof VisibilityControlError;
            if (frames.includes(child)) {
                try {
                    await unwindFramesFrom(child, 'stack');
                }
                catch (cleanupError) {
                    boundaryError = new AggregateError([error, cleanupError], 'nested playbook call and cleanup failed');
                }
            }
            pendingChildParents.delete(parent);
            if (calledStatusEmitted && !returnStatusHandled) {
                try {
                    await requireSession().emitStatus(`◇ ${frameLabel(child)} stopped; returning to ${frameLabel(parent)}`);
                }
                catch (statusError) {
                    boundaryError = new AggregateError([boundaryError, statusError], 'nested playbook failure status emission failed');
                }
            }
            if (frames.includes(parent)) {
                try {
                    await requestVisibility(parent.enablement);
                }
                catch (visibilityError) {
                    visibilityControlFailure = true;
                    boundaryError = new AggregateError([boundaryError, visibilityError], 'nested playbook call return failed');
                }
            }
            if (visibilityControlFailure)
                throw boundaryError;
            return {
                state: 'settled',
                result: {
                    status: invocationSignal.aborted ? 'aborted' : 'error',
                    playbookId: request.playbookId,
                    childSessionId: child.sessionId,
                    error: normalizeErrorFull(boundaryError),
                },
            };
        }
    };
    const submitToActive = async (frame, text, context) => {
        const policy = frame.entry.summaryPolicy;
        const summaryCounts = {
            interruptions: 0,
            copyPastes: 0,
        };
        const summaryStateCounts = new Map();
        activeTurnSummary = policy
            ? {
                owner: frame,
                counts: summaryCounts,
                stateCounts: summaryStateCounts,
            }
            : undefined;
        let completed = false;
        try {
            const result = await driveFrame(frame, text, context);
            await processFrameResult(frame, result, context);
            completed = true;
        }
        catch (error) {
            if (frame.parent && frames.includes(frame)) {
                await returnBoundaryFailure(frame, error, context);
                completed = true;
            }
            else {
                throw error;
            }
        }
        finally {
            activeTurnSummary = undefined;
            if (leafFrame() && mode === 'engaged.driving') {
                await setMode('engaged.parked', 'turn.settled');
            }
        }
        if (completed && policy) {
            const progressRounds = summaryProgressRoundCount(summaryStateCounts);
            await callVisibleTurnSummary(frame, context, {
                playbookId: frame.entry.id,
                submittedText: text,
                counts: summaryCounts,
                progressPhrase: summaryProgressPhrase(summaryStateCounts),
                progressRounds,
                savedLine: policy.savedCountsLine(summaryCounts, progressRounds),
            });
        }
    };
    const callVisibleChat = async (frame, context, message) => {
        const result = await callCaptainQueued(frame, context, visibleChatEnvelope(message), undefined, context.signal);
        if (result.status !== 'ok') {
            throw new Error(result.error ?? `callCaptain status "${result.status}"`);
        }
    };
    const callVisibleTurnSummary = async (frame, context, input) => {
        const result = await callCaptainQueued(frame, context, visibleTurnSummaryEnvelope(input), undefined, context.signal);
        if (result.status !== 'ok') {
            throw new Error(result.error ?? `callCaptain status "${result.status}"`);
        }
    };
    const hiddenLifecycleEnvelope = (prompt) => [
        'You are the Playbook Captain shell lifecycle classifier.',
        'This is hidden control work. Return only one JSON object and no prose.',
        'Allowed decisions:',
        '{"decision":"deliver"}',
        '{"decision":"dismiss"}',
        'Choose dismiss only when Boss explicitly asks to stop or dismiss the current active engagement.',
        'Choose deliver for every task instruction, answer, clarification, continuation, command-like near miss, or ambiguous message.',
        'Do not rewrite, summarize, or copy the Boss message into the result.',
        `Boss message:\n${prompt}`,
    ].join('\n\n');
    const parseLifecycleDecision = (finalText) => {
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
        if (decision === 'deliver')
            return { decision };
        if (decision === 'dismiss')
            return { decision };
        return undefined;
    };
    const routeEngaged = async (turn, context) => {
        const leaf = leafFrame();
        if (!leaf) {
            throw new Error('engaged lifecycle routing requires an active leaf');
        }
        let decision;
        try {
            const result = await callCaptainQueued(leaf, context, hiddenLifecycleEnvelope(turn.prompt), { visibility: 'hidden' }, context.signal);
            if (result.status === 'ok' && result.finalText !== undefined) {
                decision = parseLifecycleDecision(result.finalText);
            }
        }
        catch {
            // Lifecycle classification is advisory. Delivery is fail-open so an
            // unavailable classifier can never consume a parked leaf's Boss reply.
        }
        if (decision?.decision !== 'dismiss') {
            lastRouteDecision = 'deliver';
            await submitToActive(leaf, turn.prompt, context);
            return;
        }
        lastRouteDecision = 'dismiss';
        if (leaf.parent) {
            await resumeParent(leaf, {
                status: 'aborted',
                playbookId: leaf.entry.id,
                childSessionId: leaf.sessionId,
                ...(leaf.state ? { state: leaf.state } : {}),
            }, context, 'stopped');
        }
        else {
            await disposeStack('dismiss');
        }
    };
    const handleRegisteredCommand = async (entry, text, context) => {
        const enablement = enablementById.get(entry.id);
        const leaf = leafFrame();
        if (leaf && leaf.entry.id !== entry.id) {
            await callVisibleChat(leaf, context, `${frameLabel(leaf)} is already running. Finish or stop it before starting /${enablement.command}.`);
            return;
        }
        const engagement = leaf ?? (await engage(entry));
        if (text.length === 0) {
            await requestVisibility(engagement.enablement);
            await callVisibleChat(engagement, context, `Ask what task to run with /${enablement.command}.`);
            return;
        }
        await submitToActive(engagement, text, context);
    };
    return {
        async init(initSession) {
            session = initSession;
            players = initSession.players;
            const built = await buildEnablements(options, players, loadModule);
            entries = built.entries;
            byCommand = built.byCommand;
            byId = built.byId;
            enablementById = built.enablementById;
            for (const enablement of enablementById.values()) {
                enablement.entry.validateOptions(enablement.optionInput);
            }
            internalCaptainEnablement = createInternalCaptainEnablement();
            await setMode('chat', 'init');
        },
        async handleBossTurn(turn, context) {
            requireSession();
            if (activeTurnHostCalls !== undefined) {
                throw new Error('cannot handle concurrent Boss turns');
            }
            const turnHostCalls = new Set();
            activeTurnHostCalls = turnHostCalls;
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
                const leaf = leafFrame();
                if (leaf) {
                    await routeEngaged(turn, context);
                    return;
                }
                const captain = await engageInternalCaptain();
                await submitToActive(captain, turn.prompt, context);
            }
            finally {
                await drainHostCalls(turnHostCalls);
                if (activeTurnHostCalls === turnHostCalls) {
                    activeTurnHostCalls = undefined;
                }
                activeContext = undefined;
            }
        },
        async prepareDispose() {
            activeContext = undefined;
            await disposeStack('dispose');
        },
        async dispose() {
            activeContext = undefined;
            await disposeStack('dispose');
        },
    };
}
export default createPlaybookCaptainShell;
