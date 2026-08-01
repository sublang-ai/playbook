// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// slc link artifact
// FSM path: ./captain.fsm.ts
// Player binding: none (no delegated-player states)
// Adjudication strategy: LLM-judge per Captain state
// Boss-event mapping: deterministic ready entry; LLM-judge classification otherwise
import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import { captainMachine, } from './captain.fsm.js';
import { assertJsonSafe, combineAbortSignals, createNestedPlaybookBridge, defaultBuildCaptainJudgePrompt, normalizeError, normalizePlaybookSnapshot, snapshotJsonValue, snapshotPlaybookSession, validateCaptainResult, waitForPlaybookQuiescence, } from '../../../src/xstate-runtime.js';
const CAPTAIN_OPTIONS = {
    visibility: 'visible',
    resume: false,
    allowedTools: [],
};
const CONTINUATION_PREAMBLE = 'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';
function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
}
function isRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function omitUndefined(value) {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
            assertJsonSafe(entry, key);
            copy[key] = snapshotJsonValue(entry, key);
        }
    }
    return snapshotJsonValue(copy);
}
function stableJson(value) {
    const json = snapshotJsonValue(value);
    return JSON.stringify(sortJson(json));
}
function sortJson(value) {
    if (Array.isArray(value))
        return Object.freeze(value.map((entry) => sortJson(entry)));
    if (value && typeof value === 'object') {
        const record = value;
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortJson(record[key]);
        }
        return Object.freeze(sorted);
    }
    return value;
}
function replacePlaceholders(template, replacements) {
    return template.replace(/<[^>\n]+>/g, (placeholder) => replacements.get(placeholder) ?? placeholder);
}
function continuationPrefix(input) {
    if (!input.pendingBossQuestion || !input.bossReply)
        return '';
    return [
        CONTINUATION_PREAMBLE,
        '',
        'Boss question:',
        input.pendingBossQuestion.question,
        '',
        'Boss reply:',
        input.bossReply,
        '',
        '',
    ].join('\n');
}
export function composeCaptainPrompt(input) {
    const replacements = new Map();
    replacements.set('<boss-intent>', input.bossIntent);
    replacements.set('<enabled-playbooks>', stableJson(input.enabledPlaybooks));
    if (input.remainingPlan !== undefined) {
        replacements.set('<remaining-plan>', stableJson(input.remainingPlan));
    }
    if (input.completedCallResults !== undefined) {
        replacements.set('<completed-call-results>', stableJson(input.completedCallResults));
    }
    return `${continuationPrefix(input)}${replacePlaceholders(input.prompt, replacements)}`;
}
export function composePlayerPrompt(input) {
    return `${continuationPrefix(input)}${input.prompt}`;
}
function validateEnabledPlaybooks(value) {
    if (!Array.isArray(value)) {
        throw new TypeError('enabledPlaybooks must be an array');
    }
    const ids = new Set();
    return Object.freeze(value.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new TypeError(`enabledPlaybooks[${index}] must be an object`);
        }
        const keys = Object.keys(entry).sort();
        if (keys.join('\0') !== ['command', 'id', 'intent'].join('\0')) {
            throw new TypeError(`enabledPlaybooks[${index}] must contain exactly id, command, and intent`);
        }
        const id = assertNonEmptyString(entry.id, `enabledPlaybooks[${index}].id`);
        const command = assertNonEmptyString(entry.command, `enabledPlaybooks[${index}].command`);
        const intent = assertNonEmptyString(entry.intent, `enabledPlaybooks[${index}].intent`);
        if (ids.has(id)) {
            throw new TypeError(`enabledPlaybooks id ${id} is duplicated`);
        }
        ids.add(id);
        return Object.freeze({ id, command, intent });
    }));
}
function parseJsonObjectLoose(text) {
    const source = text;
    for (let start = 0; start < source.length; start += 1) {
        if (source[start] !== '{')
            continue;
        const bounded = boundedJsonCandidate(source, start);
        const candidates = bounded ? [bounded, bounded.replace(/,\s*([}\]])/g, '$1')] : [repairJsonSuffix(source.slice(start))];
        for (const candidate of candidates) {
            try {
                const parsed = JSON.parse(candidate);
                if (isRecord(parsed))
                    return parsed;
            }
            catch {
                // Try the next candidate at the same object boundary.
            }
        }
    }
    return undefined;
}
function boundedJsonCandidate(source, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === '{' || char === '[')
            depth += 1;
        else if (char === '}' || char === ']') {
            depth -= 1;
            if (depth === 0)
                return source.slice(start, index + 1);
        }
    }
    return undefined;
}
function repairJsonSuffix(source) {
    let repaired = source.replace(/,\s*$/g, '');
    let inString = false;
    let escaped = false;
    const stack = [];
    for (const char of repaired) {
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === '{')
            stack.push('}');
        else if (char === '[')
            stack.push(']');
        else if (char === '}' || char === ']')
            stack.pop();
    }
    if (inString)
        repaired += '"';
    while (stack.length > 0)
        repaired += stack.pop();
    return repaired.replace(/,\s*([}\]])/g, '$1');
}
function requiredOutputFields(description) {
    const marker = description.match(/Output shall include\s+(.+)$/);
    if (!marker)
        return [];
    const fields = [];
    const seen = new Set();
    const regex = /`([^`]+)`/g;
    let match;
    while ((match = regex.exec(marker[1])) !== null) {
        const name = match[1].split(':', 1)[0]?.trim();
        if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !seen.has(name)) {
            seen.add(name);
            fields.push(name);
        }
    }
    return fields;
}
function makeJudgePrompt(input, visibleText) {
    return defaultBuildCaptainJudgePrompt(input, visibleText);
}
// CAPPLAY-18: a structurally malformed adjudication reply gets exactly one
// corrective re-ask carrying the rejection reason and the restated shape.
function makeJudgeRetryPrompt(judgePrompt, rejection) {
    return [
        judgePrompt,
        '',
        `Your previous control reply was rejected: ${normalizeError(rejection).message}.`,
        'Reply again with exactly one JSON object naming one declared `guard` key and only its required structural fields, with no prose.',
    ].join('\n');
}
function adjudicateCaptainOutput(input, visibleText, judgeText) {
    const parsed = parseJsonObjectLoose(judgeText);
    if (!parsed)
        throw new Error('adjudicator reply did not contain a JSON object');
    const guard = parsed.guard;
    if (typeof guard !== 'string' || !(guard in input.result)) {
        throw new Error(`adjudicator selected undeclared guard ${String(guard)}`);
    }
    const allowed = new Set(['guard']);
    for (const field of requiredOutputFields(input.result[guard] ?? '')) {
        if (field !== 'question' && field !== 'response')
            allowed.add(field);
    }
    for (const key of Object.keys(parsed)) {
        if (!allowed.has(key))
            throw new Error(`adjudicator supplied undeclared field ${key}`);
    }
    if (guard === 'question' || guard === 'followUpQuestion' || guard === 'needsBossReply') {
        return { guard, question: visibleText };
    }
    if (guard === 'final') {
        return { guard, response: visibleText };
    }
    if (guard === 'delegation' || guard === 'continuing') {
        const missing = ['remainingPlan', 'nextPlaybookId', 'nextPlaybookInput'].filter((field) => !(field in parsed));
        if (missing.length > 0) {
            throw new Error(`adjudicator omitted required field ${missing.join(', ')}`);
        }
        const remainingPlan = snapshotJsonValue(parsed.remainingPlan, 'remainingPlan');
        if (!Array.isArray(remainingPlan))
            throw new Error('adjudicator remainingPlan must be a JSON array');
        return {
            guard,
            remainingPlan,
            nextPlaybookId: assertNonEmptyString(parsed.nextPlaybookId, 'nextPlaybookId'),
            nextPlaybookInput: assertNonEmptyString(parsed.nextPlaybookInput, 'nextPlaybookInput'),
        };
    }
    throw new Error(`adjudicator selected unsupported guard ${guard}`);
}
function validateClassifier(text, bossText, pendingQuestionId) {
    const parsed = parseJsonObjectLoose(text);
    if (!parsed)
        return undefined;
    const type = parsed.type;
    if (type === 'NO_ACTION') {
        if (Object.keys(parsed).length !== 1)
            return undefined;
        return { type: 'NO_ACTION' };
    }
    if (type === 'BOSS_INTENT') {
        if (Object.keys(parsed).length !== 1)
            return undefined;
        return { type: 'BOSS_INTENT', bossIntent: bossText };
    }
    if (type === 'BOSS_INTERRUPT') {
        if (Object.keys(parsed).sort().join('\0') !== ['targetId', 'type'].join('\0'))
            return undefined;
        if (parsed.targetId !== 'routing')
            return undefined;
        return { type: 'BOSS_INTERRUPT', targetId: 'routing', bossIntent: bossText };
    }
    if (type === 'BOSS_REPLY') {
        const keys = Object.keys(parsed).sort();
        if (keys.join('\0') !== ['questionId', 'type'].join('\0') && keys.join('\0') !== 'type')
            return undefined;
        const questionId = parsed.questionId === undefined ? pendingQuestionId : parsed.questionId;
        if (questionId !== pendingQuestionId || typeof questionId !== 'string')
            return undefined;
        return { type: 'BOSS_REPLY', answer: bossText, questionId };
    }
    return undefined;
}
function classifierPrompt(text, state, pending) {
    return [
        'Classify this Boss message for the Captain playbook FSM.',
        '',
        'Boss message:',
        text,
        '',
        'Current state:',
        stableJson(state),
        '',
        'Pending Boss question:',
        stableJson(pending ?? null),
        '',
        'Return JSON only. Allowed objects are {"type":"BOSS_REPLY","questionId":"routing-or-reassessing"}, {"type":"BOSS_INTERRUPT","targetId":"routing"}, {"type":"BOSS_INTENT"}, or {"type":"NO_ACTION"}.',
    ].join('\n');
}
function stateFromSnapshot(actor, pendingCall) {
    return normalizePlaybookSnapshot(actor.getSnapshot(), { pendingCall });
}
function resultFromState(state, output, pendingCall, error) {
    if (pendingCall)
        return { outcome: 'suspended', state, pendingCall };
    if (state.status === 'done') {
        return output === undefined ? { outcome: 'terminal', state } : { outcome: 'terminal', state, output };
    }
    if (state.stateId === 'failed') {
        return error === undefined ? { outcome: 'failed', state } : { outcome: 'failed', state, error: normalizeError(error) };
    }
    return { outcome: 'quiescent', state };
}
function isAbortLikeError(error) {
    return normalizeError(error).name === 'AbortError';
}
function isSignalAbort(error, signal) {
    return signal.aborted && error === signal.reason;
}
class CaptainPlaybookRuntime {
    enabledPlaybooks;
    emissionQueue = new PQueue({ concurrency: 1 });
    captainLane = new PQueue({ concurrency: 1 });
    session;
    actor;
    nestedBridge;
    sequence = 0;
    turnId = 0;
    callId = 0;
    boundaryTurnId;
    playbookCallTurnIds = new Map();
    activeBoundarySignal;
    activeTurn;
    disposing;
    disposed = false;
    terminallyDisposedBeforeInit = false;
    disposalTraceEmitted = false;
    initializing = false;
    initializationDone;
    resolveInitializationDone;
    latchedControlError;
    suppressInspection = false;
    previousState;
    constructor(options) {
        this.enabledPlaybooks = validateEnabledPlaybooks(options.enabledPlaybooks);
    }
    async init(session) {
        if (this.session || this.actor)
            throw new Error('playbook runtime is already initialized');
        if (this.disposed || this.terminallyDisposedBeforeInit || this.disposing)
            throw new Error('playbook runtime is disposed');
        this.initializing = true;
        this.initializationDone = new Promise((resolve) => {
            this.resolveInitializationDone = resolve;
        });
        this.disposalTraceEmitted = false;
        let actor;
        let initialState;
        try {
            const captured = snapshotPlaybookSession(session);
            this.session = captured;
            this.nestedBridge = this.createBridge(captured);
            actor = this.createActor(captured, this.nestedBridge);
            this.actor = actor;
            initialState = stateFromSnapshot(actor);
            this.previousState = initialState;
            await this.trace('session.started', omitUndefined({ state: initialState, stateId: initialState.stateId }));
            await this.drain();
            actor.start();
            await this.drain();
        }
        catch (error) {
            this.suppressInspection = true;
            actor?.stop();
            if (initialState && !this.disposalTraceEmitted)
                await this.bestEffortDisposeTrace(initialState);
            this.session = undefined;
            this.actor = undefined;
            this.nestedBridge = undefined;
            this.sequence = 0;
            this.turnId = 0;
            this.callId = 0;
            this.latchedControlError = undefined;
            this.previousState = undefined;
            this.suppressInspection = false;
            throw error;
        }
        finally {
            this.initializing = false;
            this.resolveInitializationDone?.();
            this.resolveInitializationDone = undefined;
        }
    }
    async handleBossInput(turn) {
        if (this.activeTurn)
            throw new Error('playbook runtime already has an active boundary');
        if (this.disposing || this.disposed)
            throw new Error('playbook runtime is disposing');
        const run = this.handleBossInputInner(turn);
        this.activeTurn = run;
        try {
            return await run;
        }
        catch (error) {
            if (isSignalAbort(error, turn.signal)) {
                const actor = this.actor;
                const bridge = this.nestedBridge;
                const snapshot = actor
                    ? await waitForPlaybookQuiescence(actor, { pendingCalls: bridge })
                    : undefined;
                const state = snapshot
                    ? normalizePlaybookSnapshot(snapshot, { pendingCall: bridge?.getPendingCall() })
                    : { value: 'failed', activeStateIds: ['failed'], tags: ['playbook.parked'], status: 'active', quiescent: true, stateId: 'failed' };
                try {
                    await this.drain();
                }
                catch {
                    // The signal-driven abort remains the public outcome.
                }
                return { outcome: 'aborted', state, error: normalizeError(error) };
            }
            throw error;
        }
        finally {
            this.activeTurn = undefined;
            const error = this.latchedControlError;
            this.latchedControlError = undefined;
            const aborted = this.activeBoundarySignal?.aborted === true;
            this.activeBoundarySignal = undefined;
            this.boundaryTurnId = undefined;
            if (error && (!aborted || !isAbortLikeError(error)))
                throw error;
        }
    }
    async resumePlaybookCall(input) {
        if (this.activeTurn)
            throw new Error('playbook runtime already has an active boundary');
        if (this.disposing || this.disposed)
            throw new Error('playbook runtime is disposing');
        const run = this.resumePlaybookCallInner(input);
        this.activeTurn = run;
        try {
            return await run;
        }
        finally {
            this.activeTurn = undefined;
            const error = this.latchedControlError;
            this.latchedControlError = undefined;
            const aborted = this.activeBoundarySignal?.aborted === true;
            this.activeBoundarySignal = undefined;
            this.boundaryTurnId = undefined;
            if (error && (!aborted || !isAbortLikeError(error)))
                throw error;
        }
    }
    dispose() {
        if (this.activeTurn)
            return Promise.reject(new Error('cannot dispose during an active boundary'));
        if (this.disposing)
            return this.disposing;
        if (!this.initializing && !this.session && !this.actor && !this.disposed) {
            this.terminallyDisposedBeforeInit = true;
            this.disposed = true;
            this.disposing = Promise.resolve();
            return this.disposing;
        }
        this.disposing = this.disposeInner();
        return this.disposing;
    }
    async handleBossInputInner(turn) {
        const actor = this.requireActor();
        const nestedBridge = this.requireBridge();
        const currentTurnId = this.nextTurnId();
        this.boundaryTurnId = currentTurnId;
        this.activeBoundarySignal = turn.signal;
        await this.trace('boss.input.received', { text: turn.text }, currentTurnId);
        const state = stateFromSnapshot(actor, nestedBridge.getPendingCall());
        let event;
        if (turn.text.trim().length === 0) {
            const result = { outcome: 'no-action', state };
            await this.traceSettled(result, currentTurnId);
            await this.drain();
            return result;
        }
        if (state.stateId === 'ready' || state.stateId === 'failed') {
            event = { type: 'BOSS_INTENT', bossIntent: turn.text };
        }
        else {
            try {
                event = await this.classifyBossInput(turn.text, state, turn.signal);
            }
            catch (error) {
                if (isSignalAbort(error, turn.signal)) {
                    const result = { outcome: 'aborted', state, error: normalizeError(error) };
                    await this.traceSettled(result, currentTurnId);
                    await this.drain();
                    return result;
                }
                await this.trace('boss.input.settled', omitUndefined({
                    outcome: 'no-action',
                    state,
                    stateId: state.stateId,
                    error: normalizeError(error),
                }), currentTurnId);
                await this.drain();
                throw error;
            }
            if (!event) {
                await this.emitStatus('classification was invalid; Boss input was not actionable.', { state });
                const result = { outcome: 'no-action', state };
                await this.traceSettled(result, currentTurnId);
                await this.drain();
                return result;
            }
        }
        if (event?.type === 'NO_ACTION') {
            const result = { outcome: 'no-action', state };
            await this.traceSettled(result, currentTurnId);
            await this.drain();
            return result;
        }
        if (turn.signal.aborted) {
            const result = { outcome: 'aborted', state, error: normalizeError(turn.signal.reason) };
            await this.traceSettled(result, currentTurnId);
            await this.drain();
            return result;
        }
        if (actor.getSnapshot().status === 'done') {
            this.reconstructActor();
        }
        this.requireActor().send(event);
        const snapshot = await waitForPlaybookQuiescence(this.requireActor(), { pendingCalls: nestedBridge });
        const settledState = normalizePlaybookSnapshot(snapshot, { pendingCall: nestedBridge.getPendingCall() });
        const result = turn.signal.aborted
            ? { outcome: 'aborted', state: settledState, error: normalizeError(turn.signal.reason) }
            : resultFromState(settledState, this.machineOutput(), nestedBridge.getPendingCall(), this.latchedControlError);
        await this.traceSettled(result, currentTurnId);
        await this.drain();
        return result;
    }
    async resumePlaybookCallInner(input) {
        const nestedBridge = this.requireBridge();
        this.activeBoundarySignal = input.signal;
        this.boundaryTurnId = this.playbookCallTurnIds.get(input.callId);
        let resumeError;
        try {
            await nestedBridge.resume(input);
        }
        catch (error) {
            resumeError = error;
        }
        const snapshot = await waitForPlaybookQuiescence(this.requireActor(), { pendingCalls: nestedBridge });
        const pendingCall = nestedBridge.getPendingCall();
        const state = normalizePlaybookSnapshot(snapshot, { pendingCall });
        const result = resultFromState(state, this.machineOutput(), pendingCall);
        await this.drain();
        if (resumeError !== undefined)
            throw resumeError;
        return input.signal.aborted ? { outcome: 'aborted', state, error: normalizeError(input.signal.reason) } : result;
    }
    async disposeInner() {
        if (this.disposed)
            return;
        if (this.initializing) {
            await this.initializationDone;
        }
        const actor = this.actor;
        const bridge = this.nestedBridge;
        const finalState = actor ? stateFromSnapshot(actor, bridge?.getPendingCall()) : undefined;
        let cleanupError;
        this.suppressInspection = true;
        actor?.stop();
        try {
            await bridge?.dispose();
        }
        catch (error) {
            cleanupError = error;
        }
        if (this.initializing) {
            try {
                await this.drain();
            }
            catch (error) {
                if (cleanupError === undefined)
                    cleanupError = error;
            }
        }
        else {
            try {
                await this.drain();
            }
            catch (error) {
                if (cleanupError === undefined)
                    cleanupError = error;
            }
        }
        this.latchedControlError = undefined;
        if (finalState && !this.disposalTraceEmitted) {
            this.disposalTraceEmitted = true;
            try {
                await this.trace('session.disposed', omitUndefined({ state: finalState, stateId: finalState.stateId }));
            }
            catch (error) {
                if (cleanupError === undefined)
                    cleanupError = error;
            }
        }
        try {
            await this.drain();
        }
        catch (error) {
            if (cleanupError === undefined)
                cleanupError = error;
        }
        this.session = undefined;
        this.actor = undefined;
        this.nestedBridge = undefined;
        this.disposed = true;
        if (cleanupError !== undefined)
            throw cleanupError;
    }
    createActor(session, bridge) {
        const provided = captainMachine.provide({
            actors: {
                captain: fromPromise(async ({ input, signal }) => {
                    await this.drain();
                    const combined = combineAbortSignals(signal, this.activeBoundarySignal);
                    return await this.runCaptainActor(input, combined);
                }),
                playbook: bridge.actorLogic,
            },
        });
        let rootActor;
        rootActor = createActor(provided, {
            input: {
                enabledPlaybooks: this.enabledPlaybooks,
                selfPlaybookId: session.playbookId,
            },
            inspect: (inspectionEvent) => {
                if (this.suppressInspection)
                    return;
                if (inspectionEvent.type !== '@xstate.snapshot')
                    return;
                if (inspectionEvent.actorRef !== rootActor)
                    return;
                try {
                    this.enqueueTransition(inspectionEvent.event, rootActor);
                }
                catch (error) {
                    this.latchControlError(error);
                }
            },
        });
        return rootActor;
    }
    createBridge(session) {
        return createNestedPlaybookBridge({
            nextCallId: () => `call-${this.nextCallId()}`,
            getBoundarySignal: () => this.activeBoundarySignal,
            callPlaybook: (request, signal) => session.ports.callPlaybook(request, signal),
            emitStarted: async (event) => {
                const turnId = this.currentTraceTurnId();
                if (turnId !== undefined)
                    this.playbookCallTurnIds.set(event.callId, turnId);
                await this.trace('playbook.call.started', {
                    stateId: event.stateId,
                    playbookId: event.playbookId,
                    text: event.text,
                }, turnId, event.callId);
            },
            emitFinished: async (event) => {
                const turnId = this.playbookCallTurnIds.get(event.callId) ?? this.currentTraceTurnId();
                await this.trace('playbook.call.finished', {
                    stateId: event.stateId,
                    playbookId: event.playbookId,
                    text: event.text,
                    result: event.result,
                }, turnId, event.callId);
                this.playbookCallTurnIds.delete(event.callId);
            },
            drain: () => this.drain(),
            bindResumeSignal: (signal) => {
                this.activeBoundarySignal = signal;
            },
            onControlPlaneError: (error) => this.latchControlError(error),
            onBackgroundError: (error) => this.latchControlError(error),
        });
    }
    async runCaptainActor(input, signal) {
        try {
            const prompt = composeCaptainPrompt(input);
            const result = await this.callCaptain(input, prompt, signal);
            if (signal.aborted)
                throw signal.reason;
            if (result.status !== 'ok') {
                throw new Error(result.error ?? `Captain returned ${result.status}`);
            }
            if (!result.finalText) {
                throw new Error('Captain returned ok without finalText');
            }
            const judgePrompt = makeJudgePrompt(input, result.finalText);
            const judgeText = await this.callJudge('captain-output-adjudication', judgePrompt, signal, input.stateId);
            try {
                return adjudicateCaptainOutput(input, result.finalText, judgeText);
            }
            catch (rejection) {
                // One corrective re-ask on a malformed control reply (CAPPLAY-18);
                // a judge transport failure above never reaches this catch.
                if (signal.aborted)
                    throw signal.reason;
                const retryPrompt = makeJudgeRetryPrompt(judgePrompt, rejection);
                const retryText = await this.callJudge('captain-output-adjudication', retryPrompt, signal, input.stateId);
                return adjudicateCaptainOutput(input, result.finalText, retryText);
            }
        }
        catch (error) {
            if (!signal.aborted)
                this.latchControlError(error);
            throw error;
        }
    }
    async callCaptain(input, prompt, signal) {
        const callId = `captain-${this.nextCallId()}`;
        const startPayload = {
            stateId: input.stateId,
            sourceItem: input.sourceItem,
            prompt,
            visibility: 'visible',
            resume: false,
            allowedTools: [],
        };
        try {
            await this.trace('captain.call.started', startPayload, this.currentTraceTurnId(), callId);
        }
        catch (error) {
            await this.tracePreservingError('captain.call.finished', {
                ...startPayload,
                status: 'error',
                error: normalizeError(error),
            }, error, this.currentTraceTurnId(), callId);
            throw error;
        }
        let result;
        let failure;
        try {
            result = await this.captainLane.add(async () => {
                if (signal.aborted)
                    throw signal.reason;
                const raw = await this.requireSession().ports.callCaptain(prompt, signal, CAPTAIN_OPTIONS);
                if (signal.aborted)
                    throw signal.reason;
                return validateCaptainResult(raw);
            });
            if (result.status !== 'ok') {
                failure = new Error(result.error ?? `Captain returned ${result.status}`);
            }
            else if (!result.finalText) {
                failure = new Error('Captain returned ok without finalText');
            }
        }
        catch (error) {
            failure = error;
        }
        const normalized = failure === undefined ? undefined : normalizeError(failure);
        const abortedFailure = failure !== undefined && isSignalAbort(failure, signal);
        const finishPayload = {
            stateId: input.stateId,
            sourceItem: input.sourceItem,
            prompt,
            visibility: 'visible',
            resume: false,
            allowedTools: [],
            status: result?.status ?? (abortedFailure ? 'aborted' : 'error'),
            ...(result?.finalText === undefined ? {} : { finalText: result.finalText }),
            ...(result?.error === undefined ? {} : { error: result.error }),
            ...(normalized === undefined ? {} : { error: normalized }),
        };
        if (failure !== undefined) {
            if (isSignalAbort(failure, signal)) {
                await this.trace('captain.call.finished', finishPayload, this.currentTraceTurnId(), callId);
                throw failure;
            }
            await this.tracePreservingError('captain.call.finished', finishPayload, failure, this.currentTraceTurnId(), callId);
            throw failure;
        }
        await this.trace('captain.call.finished', finishPayload, this.currentTraceTurnId(), callId);
        if (failure !== undefined)
            throw failure;
        if (!result)
            throw new Error('Captain returned no result');
        return result;
    }
    async callJudge(purpose, prompt, signal, stateId) {
        const callId = `judge-${this.nextCallId()}`;
        const startPayload = omitUndefined({ purpose, prompt, stateId });
        try {
            await this.trace('judge.call.started', startPayload, this.currentTraceTurnId(), callId);
        }
        catch (error) {
            await this.tracePreservingError('judge.call.finished', omitUndefined({ purpose, prompt, stateId, status: 'error', error: normalizeError(error) }), error, this.currentTraceTurnId(), callId);
            throw error;
        }
        let reply;
        let failure;
        try {
            reply = await this.captainLane.add(async () => {
                if (signal.aborted)
                    throw signal.reason;
                const text = await this.requireSession().ports.callJudge(prompt, signal);
                if (signal.aborted)
                    throw signal.reason;
                if (typeof text !== 'string')
                    throw new TypeError('judge reply must be a string');
                return text;
            });
        }
        catch (error) {
            failure = error;
        }
        if (failure !== undefined) {
            const aborted = isSignalAbort(failure, signal);
            const finishPayload = omitUndefined({
                purpose,
                prompt,
                stateId,
                status: aborted ? 'aborted' : 'error',
                error: normalizeError(failure),
            });
            if (aborted) {
                await this.trace('judge.call.finished', finishPayload, this.currentTraceTurnId(), callId);
            }
            else {
                await this.tracePreservingError('judge.call.finished', finishPayload, failure, this.currentTraceTurnId(), callId);
            }
            throw failure;
        }
        await this.trace('judge.call.finished', omitUndefined({ purpose, prompt, stateId, status: 'ok', reply }), this.currentTraceTurnId(), callId);
        if (reply === undefined)
            throw new Error('judge returned no reply');
        return reply;
    }
    async classifyBossInput(text, state, signal) {
        const pending = this.pendingQuestion();
        const prompt = classifierPrompt(text, state, pending ? { questionId: pending.questionId, player: pending.player, question: pending.question } : undefined);
        const reply = await this.callJudge('boss-input-classification', prompt, signal, state.stateId);
        const event = validateClassifier(reply, text, pending?.questionId);
        if (!event)
            return undefined;
        return event;
    }
    pendingQuestion() {
        const snapshot = this.actor?.getSnapshot();
        const context = snapshot?.context;
        if (!isRecord(context) || !isRecord(context.pendingBossQuestion))
            return undefined;
        return {
            questionId: assertNonEmptyString(context.pendingBossQuestion.questionId, 'pending question id'),
            player: assertNonEmptyString(context.pendingBossQuestion.player, 'pending question player'),
            question: assertNonEmptyString(context.pendingBossQuestion.question, 'pending question text'),
        };
    }
    enqueueTransition(event, actor) {
        const state = stateFromSnapshot(actor, this.nestedBridge?.getPendingCall());
        const previousState = this.previousState ?? state;
        this.previousState = state;
        const transition = omitUndefined({
            event: this.describeEvent(event),
            from: previousState,
            to: state,
            previousState,
            state,
            stateId: state.stateId,
            pendingBossQuestion: this.pendingQuestion(),
            lastError: this.lastError(),
        });
        this.enqueue(async () => {
            await this.traceNow('fsm.transition', transition, this.currentTraceTurnId());
            await this.requireSession().ports.emitTelemetry({ topic: 'playbook.fsm.state', payload: transition });
            if (state.stateId !== 'ready' && state.stateId !== 'done') {
                await this.traceNow('status.emitted', omitUndefined({ message: `Entered ${state.stateId ?? 'state'}`, state, stateId: state.stateId }), this.currentTraceTurnId());
                await this.requireSession().ports.emitStatus(`Entered ${state.stateId ?? 'state'}`, transition);
            }
        });
    }
    describeEvent(event) {
        if (!isRecord(event))
            return { type: 'unknown' };
        const type = typeof event.type === 'string' ? event.type : 'unknown';
        const copy = { type };
        for (const key of ['bossIntent', 'targetId', 'answer', 'questionId', 'output']) {
            if (key in event && event[key] === undefined)
                continue;
            if (key in event)
                copy[key] = snapshotJsonValue(event[key], `event.${key}`);
        }
        if ('error' in event)
            copy.error = snapshotJsonValue(normalizeError(event.error));
        return snapshotJsonValue(copy);
    }
    lastError() {
        const context = this.actor?.getSnapshot().context;
        if (!isRecord(context) || !('lastError' in context))
            return undefined;
        if (context.lastError === undefined)
            return undefined;
        return snapshotJsonValue(context.lastError, 'lastError');
    }
    machineOutput() {
        const snapshot = this.actor?.getSnapshot();
        if (!snapshot || snapshot.status !== 'done')
            return undefined;
        const output = snapshot.output;
        return output === undefined ? undefined : snapshotJsonValue(output, 'machine output');
    }
    async emitStatus(message, data) {
        const state = stateFromSnapshot(this.requireActor(), this.nestedBridge?.getPendingCall());
        const payload = omitUndefined({ message, data, state, stateId: state.stateId });
        await this.trace('status.emitted', payload, this.currentTraceTurnId());
        await this.requireSession().ports.emitStatus(message, data);
    }
    async traceSettled(result, turnId) {
        await this.trace('boss.input.settled', this.runResultPayload(result), turnId);
    }
    runResultPayload(result) {
        return omitUndefined({
            outcome: result.outcome,
            state: result.state,
            stateId: result.state.stateId,
            pendingCall: 'pendingCall' in result ? result.pendingCall : undefined,
            output: 'output' in result ? result.output : undefined,
            error: 'error' in result ? result.error : undefined,
        });
    }
    async trace(type, payload, turnId, callId) {
        this.enqueue(async () => {
            await this.traceNow(type, payload, turnId, callId);
        });
        await this.drain();
    }
    async tracePreservingError(type, payload, preservedError, turnId, callId) {
        const previous = this.latchedControlError;
        this.latchedControlError = undefined;
        try {
            await this.trace(type, payload, turnId, callId);
        }
        catch (error) {
            // Preserve the earlier boundary/control failure.
        }
        finally {
            this.latchedControlError = previous ?? preservedError;
        }
    }
    async traceNow(type, payload, turnId, callId) {
        const session = this.requireSession();
        const event = {
            schemaVersion: 2,
            sessionId: session.sessionId,
            playbookId: session.playbookId,
            rootSessionId: session.rootSessionId,
            ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
            ...(session.parentCallId === undefined ? {} : { parentCallId: session.parentCallId }),
            depth: session.depth,
            sequence: this.nextSequence(),
            timestamp: Date.now(),
            type,
            ...(turnId === undefined ? {} : { turnId }),
            ...(callId === undefined ? {} : { callId }),
            payload: snapshotJsonValue(payload, `trace ${type}`),
        };
        await session.ports.emitTelemetry({ topic: 'playbook.trace', payload: event });
    }
    enqueue(task) {
        void this.emissionQueue.add(async () => {
            try {
                await task();
            }
            catch (error) {
                this.latchControlError(error);
                throw error;
            }
        }).catch(() => undefined);
    }
    drain() {
        return this.emissionQueue.onIdle().then(() => {
            if (this.latchedControlError)
                throw this.latchedControlError;
        });
    }
    async bestEffortDisposeTrace(state) {
        try {
            this.disposalTraceEmitted = true;
            await this.trace('session.disposed', omitUndefined({ state, stateId: state.stateId }));
            await this.drain();
        }
        catch {
            // Preserve the original initialization error.
        }
    }
    reconstructActor() {
        this.actor?.stop();
        const session = this.requireSession();
        const bridge = this.requireBridge();
        this.actor = this.createActor(session, bridge);
        this.actor.start();
    }
    requireSession() {
        if (!this.session)
            throw new Error('playbook runtime is not initialized');
        return this.session;
    }
    requireActor() {
        if (!this.actor)
            throw new Error('playbook runtime actor is not initialized');
        return this.actor;
    }
    requireBridge() {
        if (!this.nestedBridge)
            throw new Error('nested bridge is not initialized');
        return this.nestedBridge;
    }
    nextSequence() {
        this.sequence += 1;
        return this.sequence;
    }
    nextTurnId() {
        this.turnId += 1;
        return this.turnId;
    }
    currentTraceTurnId() {
        return this.boundaryTurnId;
    }
    nextCallId() {
        this.callId += 1;
        return this.callId;
    }
    latchControlError(error) {
        if (!this.latchedControlError)
            this.latchedControlError = error;
    }
}
export const _internal = {
    composeCaptainPrompt,
    composePlayerPrompt,
    parseJsonObjectLoose,
};
export function createPlaybookRuntime(options) {
    return new CaptainPlaybookRuntime(options);
}
const factory = createPlaybookRuntime;
export default factory;
