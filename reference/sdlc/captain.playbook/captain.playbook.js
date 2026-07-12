// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// slc link inputs:
//   FSM: ./captain.fsm.ts
//   player binding: none (no delegated-player actor)
//   adjudication: LLM judge per Captain state
//   Boss-event mapping: free-text judge classification
import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import { captainMachine, } from './captain.fsm.js';
import { assertJsonSafe, combineAbortSignals, createNestedPlaybookBridge, normalizeError, normalizePlaybookSnapshot, snapshotJsonValue, snapshotPlaybookSession, validateCaptainResult, waitForPlaybookQuiescence, } from '../../../src/xstate-runtime.js';
const classifierSchema = [
    '{ "type": "BOSS_INTENT", "bossIntent": "non-empty fresh directive" }',
    '{ "type": "BOSS_INTERRUPT", "targetId": "routing", "bossIntent": "non-empty fresh directive" }',
    '{ "type": "BOSS_REPLY", "answer": "non-empty answer", "questionId"?: "pending question id" }',
    '{ "type": "NO_ACTION" }',
].join('\n');
function isRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, keys) {
    const actual = Reflect.ownKeys(value);
    return actual.every((key) => typeof key === 'string') &&
        actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function deterministicJson(value) {
    const safe = snapshotJsonValue(value);
    const sort = (item) => {
        if (Array.isArray(item))
            return item.map(sort);
        if (item !== null && typeof item === 'object') {
            const sorted = {};
            const record = item;
            for (const key of Object.keys(record).sort())
                sorted[key] = sort(record[key]);
            return sorted;
        }
        return item;
    };
    return JSON.stringify(sort(safe));
}
function continuationPrefix(input) {
    if (!input.pendingBossQuestion || input.bossReply === undefined)
        return '';
    return [
        'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.',
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
    if ('bossIntent' in input)
        replacements.set('<boss-intent>', input.bossIntent);
    if ('enabledPlaybooks' in input)
        replacements.set('<enabled-playbooks>', deterministicJson(input.enabledPlaybooks));
    if ('remainingPlan' in input)
        replacements.set('<remaining-plan>', deterministicJson(input.remainingPlan));
    if ('completedCallResults' in input)
        replacements.set('<completed-call-results>', deterministicJson(input.completedCallResults));
    const body = input.prompt.replace(/<[^>\n]+>/g, (placeholder) => replacements.get(placeholder) ?? placeholder);
    return continuationPrefix(input) + body;
}
export function composePlayerPrompt(input) {
    if (!input.pendingBossQuestion || input.bossReply === undefined)
        return input.prompt;
    return [
        'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.',
        '',
        'Boss question:',
        input.pendingBossQuestion.question,
        '',
        'Boss reply:',
        input.bossReply,
        '',
        '',
    ].join('\n') + input.prompt;
}
function freezeCatalog(value) {
    const detached = snapshotJsonValue(value, 'enabledPlaybooks');
    if (!Array.isArray(detached))
        throw new TypeError('enabledPlaybooks must be an array');
    const ids = new Set();
    const copy = detached.map((entry, index) => {
        if (!isRecord(entry) || !exactKeys(entry, ['id', 'command', 'intent'])) {
            throw new TypeError(`enabledPlaybooks[${index}] must contain exactly id, command, and intent`);
        }
        for (const key of ['id', 'command', 'intent']) {
            if (typeof entry[key] !== 'string' || entry[key].trim().length === 0) {
                throw new TypeError(`enabledPlaybooks[${index}].${key} must be a non-empty string`);
            }
        }
        if (ids.has(entry.id))
            throw new TypeError(`duplicate enabled playbook id: ${entry.id}`);
        ids.add(entry.id);
        return Object.freeze({ id: entry.id, command: entry.command, intent: entry.intent });
    });
    return Object.freeze(copy);
}
function balancedEnd(text, start) {
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                quoted = false;
            continue;
        }
        if (char === '"')
            quoted = true;
        else if (char === '{' || char === '[')
            stack.push(char);
        else if (char === '}' || char === ']') {
            const opening = stack.pop();
            if ((char === '}' && opening !== '{') || (char === ']' && opening !== '['))
                return undefined;
            if (stack.length === 0)
                return index + 1;
        }
    }
    return undefined;
}
function repairJson(candidate) {
    let repaired = candidate.replace(/,\s*([}\]])/g, '$1');
    let quoted = false;
    let escaped = false;
    const stack = [];
    for (const char of repaired) {
        if (quoted) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                quoted = false;
        }
        else if (char === '"')
            quoted = true;
        else if (char === '{' || char === '[')
            stack.push(char);
        else if (char === '}' || char === ']')
            stack.pop();
    }
    if (escaped)
        repaired += '\\';
    if (quoted)
        repaired += '"';
    while (stack.length > 0)
        repaired += stack.pop() === '{' ? '}' : ']';
    return repaired.replace(/,\s*([}\]])/g, '$1');
}
function recoverJsonObject(text) {
    for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
        const end = balancedEnd(text, start);
        const candidate = end === undefined ? text.slice(start) : text.slice(start, end);
        for (const attempt of [candidate, repairJson(candidate)]) {
            try {
                const parsed = JSON.parse(attempt);
                if (isRecord(parsed))
                    return parsed;
            }
            catch {
                // Try the bounded repair, then the next object candidate.
            }
        }
    }
    return undefined;
}
function pendingQuestion(snapshot) {
    if (!isRecord(snapshot) || !isRecord(snapshot.context) || !isRecord(snapshot.context.pendingBossQuestion))
        return undefined;
    const pending = snapshot.context.pendingBossQuestion;
    if (typeof pending.questionId !== 'string' || typeof pending.player !== 'string' || typeof pending.question !== 'string')
        return undefined;
    return { questionId: pending.questionId, player: pending.player, question: pending.question };
}
function classifierPrompt(text, state, pending) {
    return [
        'Classify the Boss text as exactly one JSON event allowed by the current playbook state.',
        'Return only one JSON object with exactly the fields shown for its selected arm.',
        'Do not include runtime options, catalogs, state internals, or extra fields.',
        `Current state: ${deterministicJson(state)}`,
        ...(pending ? [`Pending Boss question: ${deterministicJson(pending)}`] : []),
        'Allowed events:',
        classifierSchema,
        'Boss text:',
        text,
    ].join('\n');
}
function parseClassification(reply, pending) {
    const value = recoverJsonObject(reply);
    if (!value || typeof value.type !== 'string')
        return undefined;
    if (value.type === 'NO_ACTION')
        return exactKeys(value, ['type']) ? { type: 'NO_ACTION' } : undefined;
    if (value.type === 'BOSS_INTENT') {
        return exactKeys(value, ['type', 'bossIntent']) && typeof value.bossIntent === 'string' && value.bossIntent.trim()
            ? { type: 'BOSS_INTENT', bossIntent: value.bossIntent } : undefined;
    }
    if (value.type === 'BOSS_INTERRUPT') {
        return exactKeys(value, ['type', 'targetId', 'bossIntent']) && value.targetId === 'routing' && typeof value.bossIntent === 'string' && value.bossIntent.trim()
            ? { type: 'BOSS_INTERRUPT', targetId: 'routing', bossIntent: value.bossIntent } : undefined;
    }
    if (value.type === 'BOSS_REPLY') {
        const withId = Object.prototype.hasOwnProperty.call(value, 'questionId');
        if (!exactKeys(value, withId ? ['type', 'answer', 'questionId'] : ['type', 'answer']))
            return undefined;
        if (typeof value.answer !== 'string' || !value.answer.trim() || (withId && typeof value.questionId !== 'string'))
            return undefined;
        const questionId = withId ? value.questionId : pending?.questionId;
        if (!pending || questionId !== pending.questionId)
            return undefined;
        return { type: 'BOSS_REPLY', answer: value.answer, questionId };
    }
    return undefined;
}
function requiredFields(description) {
    return [...description.matchAll(/`([A-Za-z_$][\w$]*)(?::[^`]*)?`/g)].map((match) => match[1]);
}
function adjudicatorPrompt(input, prose) {
    return [
        `Adjudicate the direct Captain output for source item ${input.sourceItem}.`,
        'Return one JSON object selecting exactly one declared result guard and every payload field named by its description.',
        'Do not interpret, paraphrase, or alter the result descriptions.',
        'Captain output:',
        prose,
        'Declared results:',
        ...Object.entries(input.result).map(([guard, description]) => `${guard}: ${description}`),
    ].join('\n');
}
function parseAdjudication(reply, input) {
    const value = recoverJsonObject(reply);
    if (!value)
        throw new Error('Captain adjudication reply contains no recoverable JSON object');
    if (typeof value.guard !== 'string' || !(value.guard in input.result)) {
        throw new Error(`Captain adjudication selected undeclared guard: ${String(value.guard)}`);
    }
    const description = input.result[value.guard];
    const fields = requiredFields(description);
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(value, field))
            throw new Error(`Captain adjudication omitted required field: ${field}`);
    }
    if (!exactKeys(value, ['guard', ...fields]))
        throw new Error('Captain adjudication returned undeclared payload fields');
    assertJsonSafe(value, 'Captain adjudication');
    for (const field of fields) {
        if (typeof value[field] === 'string' && value[field].length === 0)
            throw new Error(`Captain adjudication returned empty required field: ${field}`);
    }
    const guard = value.guard;
    if (guard === 'direct' || guard === 'final') {
        if (typeof value.response !== 'string' || value.response.length === 0)
            throw new Error('Captain adjudication returned invalid required field: response');
    }
    else if (guard === 'question' || guard === 'followUpQuestion' || guard === 'needsBossReply') {
        if (typeof value.question !== 'string' || value.question.length === 0)
            throw new Error('Captain adjudication returned invalid required field: question');
    }
    else {
        if (!Array.isArray(value.remainingPlan))
            throw new Error('Captain adjudication returned invalid required field: remainingPlan');
        snapshotJsonValue(value.remainingPlan, 'Captain adjudication remainingPlan');
        if (typeof value.nextPlaybookId !== 'string' || value.nextPlaybookId.length === 0)
            throw new Error('Captain adjudication returned invalid required field: nextPlaybookId');
        if (typeof value.nextPlaybookInput !== 'string' || value.nextPlaybookInput.length === 0)
            throw new Error('Captain adjudication returned invalid required field: nextPlaybookInput');
    }
    return snapshotJsonValue(value, 'Captain adjudication output');
}
export function createPlaybookRuntime(options) {
    const enabledPlaybooks = freezeCatalog(options.enabledPlaybooks);
    const emissionQueue = new PQueue({ concurrency: 1 });
    const captainQueue = new PQueue({ concurrency: 1 });
    let session;
    let actor;
    let nestedBridge;
    let activeBoundary = false;
    let boundarySignal;
    let currentTurnId;
    let nextTurn = 0;
    let nextCall = 0;
    let traceSequence = 0;
    let previousState;
    let controlError;
    let backgroundError;
    let inspectionEnabled = false;
    let disposing = false;
    let disposed = false;
    let disposalPromise;
    let initializationLatch;
    let resolveInitialization;
    const callTurnIds = new Map();
    const latchControl = (error) => { if (controlError === undefined)
        controlError = error; };
    const latchBackground = (error) => { if (backgroundError === undefined)
        backgroundError = error; };
    const requireSession = () => {
        if (!session)
            throw new Error('playbook runtime is not initialized');
        return session;
    };
    const enqueue = (task) => {
        const queued = emissionQueue.add(task);
        void queued.catch(latchBackground);
    };
    const drainRaw = async () => { await emissionQueue.onIdle(); };
    const drain = async () => {
        await drainRaw();
        if (backgroundError !== undefined)
            throw backgroundError;
    };
    const trace = (type, payload, callId) => {
        const bound = requireSession();
        const safePayload = snapshotJsonValue(payload, `trace ${type} payload`);
        const event = Object.freeze({
            schemaVersion: 2,
            sessionId: bound.sessionId,
            playbookId: bound.playbookId,
            rootSessionId: bound.rootSessionId,
            ...(bound.parentSessionId === undefined ? {} : { parentSessionId: bound.parentSessionId }),
            ...(bound.parentCallId === undefined ? {} : { parentCallId: bound.parentCallId }),
            depth: bound.depth,
            sequence: ++traceSequence,
            timestamp: Date.now(),
            type,
            ...(currentTurnId === undefined ? {} : { turnId: currentTurnId }),
            ...(callId === undefined ? {} : { callId }),
            payload: safePayload,
        });
        enqueue(() => bound.ports.emitTelemetry({ topic: 'playbook.trace', payload: event }));
    };
    const emitStatus = (message, state, data) => {
        const payload = { message, state, ...(state.stateId ? { stateId: state.stateId } : {}), ...(data === undefined ? {} : { data: snapshotJsonValue(data) }) };
        trace('status.emitted', payload);
        enqueue(() => requireSession().ports.emitStatus(message, data));
    };
    const eventDescriptor = (event) => {
        if (!isRecord(event))
            return { type: 'unknown' };
        const descriptor = { type: typeof event.type === 'string' ? event.type : 'unknown' };
        for (const key of ['bossIntent', 'targetId', 'answer', 'questionId'])
            if (typeof event[key] === 'string')
                descriptor[key] = event[key];
        if (Object.prototype.hasOwnProperty.call(event, 'output') && event.output !== undefined)
            descriptor.output = snapshotJsonValue(event.output);
        if (Object.prototype.hasOwnProperty.call(event, 'error'))
            descriptor.error = snapshotJsonValue(normalizeError(event.error));
        return snapshotJsonValue(descriptor);
    };
    const inspect = (inspectionEvent) => {
        try {
            if (!inspectionEnabled || !actor || !isRecord(inspectionEvent) || inspectionEvent.type !== '@xstate.snapshot' || inspectionEvent.actorRef !== actor)
                return;
            const snapshot = inspectionEvent.snapshot;
            const state = normalizePlaybookSnapshot(snapshot, { pendingCall: nestedBridge?.getPendingCall() });
            const transitionEvent = eventDescriptor(inspectionEvent.event);
            const context = isRecord(snapshot) && isRecord(snapshot.context) ? snapshot.context : undefined;
            const pending = context?.pendingBossQuestion;
            const transitionError = context?.lastError;
            const payload = snapshotJsonValue({
                from: previousState ?? state,
                to: state,
                event: transitionEvent,
                previousState: previousState ?? state,
                state,
                ...(pending === undefined ? {} : { pendingBossQuestion: snapshotJsonValue(pending) }),
                ...(transitionError === undefined ? {} : { error: snapshotJsonValue(normalizeError(transitionError)) }),
            });
            trace('fsm.transition', payload);
            enqueue(() => requireSession().ports.emitTelemetry({ topic: 'playbook.fsm.state', payload }));
            if (state.stateId && state.stateId !== 'ready' && state.stateId !== 'done') {
                emitStatus(`Entered ${state.stateId}.`, state, state.stateId === 'failed' ? context?.lastError : undefined);
            }
            previousState = snapshotJsonValue(state);
        }
        catch (error) {
            latchBackground(error);
        }
    };
    const nextCallId = () => `${requireSession().sessionId}:call:${++nextCall}`;
    const judge = async (prompt, signal, purpose, stateId) => {
        const callId = nextCallId();
        const startPayload = { purpose, prompt, ...(stateId ? { stateId } : {}) };
        trace('judge.call.started', startPayload, callId);
        try {
            await drainRaw();
            if (backgroundError !== undefined)
                throw backgroundError;
        }
        catch (error) {
            try {
                trace('judge.call.finished', { ...startPayload, status: 'error', error: normalizeError(error) }, callId);
                await drainRaw();
            }
            catch { /* Preserve start failure. */ }
            latchControl(error);
            throw error;
        }
        try {
            const reply = await captainQueue.add(async () => {
                if (signal.aborted)
                    throw signal.reason;
                const value = await requireSession().ports.callJudge(prompt, signal);
                if (signal.aborted)
                    throw signal.reason;
                if (typeof value !== 'string')
                    throw new TypeError('judge reply must be a string');
                return value;
            });
            if (typeof reply !== 'string')
                throw new TypeError('judge reply must be a string');
            trace('judge.call.finished', { ...startPayload, status: 'ok', reply }, callId);
            await drainRaw();
            return reply;
        }
        catch (error) {
            const status = signal.aborted ? 'aborted' : 'error';
            trace('judge.call.finished', { ...startPayload, status, error: normalizeError(error) }, callId);
            await drainRaw();
            if (!signal.aborted)
                latchControl(error);
            throw error;
        }
    };
    const runCaptain = async (input, invocationSignal) => {
        await drain();
        const signal = combineAbortSignals(invocationSignal, boundarySignal);
        const prompt = composeCaptainPrompt(input);
        const callId = nextCallId();
        const visibility = 'visible';
        const boundary = { prompt, visibility, stateId: input.stateId, sourceItem: input.sourceItem };
        trace('captain.call.started', boundary, callId);
        try {
            await drainRaw();
            if (backgroundError !== undefined)
                throw backgroundError;
        }
        catch (error) {
            try {
                trace('captain.call.finished', { ...boundary, status: 'error', error: normalizeError(error) }, callId);
                await drainRaw();
            }
            catch { /* Preserve start failure. */ }
            latchControl(error);
            throw error;
        }
        let captured;
        try {
            const raw = await captainQueue.add(async () => {
                if (signal.aborted)
                    throw signal.reason;
                const value = await requireSession().ports.callCaptain(prompt, signal, { visibility });
                if (signal.aborted)
                    throw signal.reason;
                return value;
            });
            captured = validateCaptainResult(raw);
            const missing = captured.status === 'ok' && captured.finalText === undefined;
            trace('captain.call.finished', {
                ...boundary,
                status: captured.status,
                ...(captured.finalText === undefined ? {} : { finalText: captured.finalText }),
                ...(captured.error === undefined ? {} : { error: normalizeError(captured.error) }),
                ...(missing ? { error: normalizeError(new Error('Captain result is missing finalText')) } : {}),
            }, callId);
            await drainRaw();
            if (captured.status !== 'ok' || missing) {
                const error = new Error(missing ? 'Captain result is missing finalText' : captured.error ?? `Captain returned ${captured.status}`);
                if (!signal.aborted)
                    latchControl(error);
                throw error;
            }
            const reply = await judge(adjudicatorPrompt(input, captured.finalText), signal, 'captain-output-adjudication', input.stateId);
            try {
                return parseAdjudication(reply, input);
            }
            catch (error) {
                latchControl(error);
                throw error;
            }
        }
        catch (error) {
            if (!captured) {
                trace('captain.call.finished', { ...boundary, status: signal.aborted ? 'aborted' : 'error', error: normalizeError(error) }, callId);
                await drainRaw();
            }
            if (!signal.aborted)
                latchControl(error);
            throw error;
        }
    };
    const describe = () => {
        const current = actor;
        if (!current)
            throw new Error('playbook runtime is not initialized');
        return normalizePlaybookSnapshot(current.getSnapshot(), { pendingCall: nestedBridge?.getPendingCall() });
    };
    const resultFor = (signal) => {
        const state = describe();
        if (signal.aborted)
            return { outcome: 'aborted', state, error: normalizeError(signal.reason) };
        const pendingCall = nestedBridge?.getPendingCall();
        if (pendingCall)
            return { outcome: 'suspended', state, pendingCall };
        if (state.status === 'done') {
            const output = actor?.getSnapshot().output;
            if (output === undefined)
                return { outcome: 'terminal', state };
            return { outcome: 'terminal', state, output: snapshotJsonValue(output) };
        }
        if (state.stateId === 'failed') {
            const error = actor?.getSnapshot().context.lastError;
            return error === undefined ? { outcome: 'failed', state } : { outcome: 'failed', state, error: normalizeError(error) };
        }
        return { outcome: 'quiescent', state };
    };
    const settleTrace = (result) => {
        trace('boss.input.settled', { ...result, ...(result.state.stateId ? { stateId: result.state.stateId } : {}) });
    };
    const buildActor = () => {
        const bound = requireSession();
        nestedBridge = createNestedPlaybookBridge({
            nextCallId,
            getBoundarySignal: () => boundarySignal,
            callPlaybook: (request, signal) => bound.ports.callPlaybook(request, signal),
            emitStarted: async (event) => {
                callTurnIds.set(event.callId, currentTurnId);
                trace('playbook.call.started', { stateId: event.stateId, playbookId: event.playbookId, text: event.text }, event.callId);
                await drain();
            },
            emitFinished: async (event) => {
                const prior = currentTurnId;
                currentTurnId = callTurnIds.get(event.callId);
                try {
                    trace('playbook.call.finished', { stateId: event.stateId, playbookId: event.playbookId, text: event.text, result: event.result }, event.callId);
                    await drain();
                }
                finally {
                    callTurnIds.delete(event.callId);
                    currentTurnId = prior;
                }
            },
            drain,
            bindResumeSignal: (signal) => { boundarySignal = signal; },
            onControlPlaneError: latchControl,
            onBackgroundError: latchBackground,
        });
        const provided = captainMachine.provide({
            actors: {
                captain: fromPromise(({ input, signal }) => runCaptain(input, signal)),
                playbook: nestedBridge.actorLogic,
            },
        });
        return createActor(provided, {
            input: { enabledPlaybooks, selfPlaybookId: bound.playbookId },
            inspect,
        });
    };
    const finishBoundary = async (operationError) => {
        try {
            await drainRaw();
            const selected = controlError ?? operationError ?? backgroundError;
            if (selected !== undefined)
                throw selected;
        }
        finally {
            controlError = undefined;
            backgroundError = undefined;
            boundarySignal = undefined;
            currentTurnId = undefined;
            activeBoundary = false;
        }
    };
    const runtime = {
        async init(value) {
            if (disposed || disposing)
                throw new Error('playbook runtime is disposed');
            if (session || initializationLatch)
                throw new Error('playbook runtime is already initialized');
            initializationLatch = new Promise((resolve) => { resolveInitialization = resolve; });
            let attemptedStart = false;
            try {
                session = snapshotPlaybookSession(value);
                actor = buildActor();
                const initial = normalizePlaybookSnapshot(actor.getSnapshot());
                trace('session.started', { state: initial, ...(initial.stateId ? { stateId: initial.stateId } : {}) });
                await drain();
                inspectionEnabled = true;
                attemptedStart = true;
                actor.start();
                await drain();
            }
            catch (error) {
                inspectionEnabled = false;
                if (attemptedStart)
                    actor?.stop();
                try {
                    await nestedBridge?.dispose();
                }
                catch { /* Preserve init error. */ }
                if (session) {
                    try {
                        const finalState = actor ? normalizePlaybookSnapshot(actor.getSnapshot()) : undefined;
                        trace('session.disposed', finalState ? { state: finalState, ...(finalState.stateId ? { stateId: finalState.stateId } : {}) } : {});
                        await drainRaw();
                    }
                    catch { /* Preserve init error. */ }
                }
                actor = undefined;
                nestedBridge = undefined;
                session = undefined;
                traceSequence = 0;
                previousState = undefined;
                controlError = undefined;
                backgroundError = undefined;
                callTurnIds.clear();
                throw error;
            }
            finally {
                resolveInitialization?.();
                resolveInitialization = undefined;
                initializationLatch = undefined;
            }
        },
        async handleBossInput(turn) {
            if (!session || !actor)
                throw new Error('playbook runtime is not initialized');
            if (disposing || disposed)
                throw new Error('playbook runtime is disposing');
            if (activeBoundary)
                throw new Error('another playbook boundary is active');
            activeBoundary = true;
            boundarySignal = turn.signal;
            currentTurnId = ++nextTurn;
            let operationError;
            try {
                trace('boss.input.received', { text: turn.text });
                await drain();
                if (turn.text.trim().length === 0) {
                    const result = { outcome: 'no-action', state: describe() };
                    settleTrace(result);
                    await drain();
                    return result;
                }
                const state = describe();
                const pending = pendingQuestion(actor.getSnapshot());
                let classified;
                try {
                    const reply = await judge(classifierPrompt(turn.text, state, pending), turn.signal, 'boss-input-classification', state.stateId);
                    classified = parseClassification(reply, pending);
                }
                catch (error) {
                    if (turn.signal.aborted && controlError === undefined) {
                        const aborted = { outcome: 'aborted', state: describe(), error: normalizeError(turn.signal.reason) };
                        settleTrace(aborted);
                        await drain();
                        return aborted;
                    }
                    operationError = error;
                    const failedClassification = { outcome: 'no-action', state: describe() };
                    trace('boss.input.settled', { ...failedClassification, error: normalizeError(error), ...(failedClassification.state.stateId ? { stateId: failedClassification.state.stateId } : {}) });
                    await drainRaw();
                    throw error;
                }
                if (!classified) {
                    emitStatus('Boss input could not be classified for the current playbook state.', describe());
                    const result = { outcome: 'no-action', state: describe() };
                    settleTrace(result);
                    await drain();
                    return result;
                }
                if (classified.type === 'NO_ACTION') {
                    const result = { outcome: 'no-action', state: describe() };
                    settleTrace(result);
                    await drain();
                    return result;
                }
                if (actor.getSnapshot().status === 'done') {
                    inspectionEnabled = false;
                    actor.stop();
                    await nestedBridge?.dispose();
                    actor = buildActor();
                    inspectionEnabled = true;
                    actor.start();
                    await drain();
                }
                actor.send(classified);
                await waitForPlaybookQuiescence(actor, { pendingCalls: nestedBridge });
                const result = resultFor(turn.signal);
                if (controlError !== undefined) {
                    trace('boss.input.settled', { ...result, error: normalizeError(controlError), ...(result.state.stateId ? { stateId: result.state.stateId } : {}) });
                    await drainRaw();
                    throw controlError;
                }
                settleTrace(result);
                await drain();
                return result;
            }
            catch (error) {
                operationError = error;
                throw error;
            }
            finally {
                await finishBoundary(operationError);
            }
        },
        async resumePlaybookCall(input) {
            if (!session || !actor || !nestedBridge)
                throw new Error('playbook runtime is not initialized');
            if (disposing || disposed)
                throw new Error('playbook runtime is disposing');
            if (activeBoundary)
                throw new Error('another playbook boundary is active');
            const pending = nestedBridge.getPendingCall();
            if (!pending || pending.callId !== input.callId)
                throw new Error('unknown, duplicate, or stale playbook call id');
            activeBoundary = true;
            boundarySignal = input.signal;
            currentTurnId = callTurnIds.get(input.callId);
            let operationError;
            try {
                try {
                    await nestedBridge.resume(input);
                }
                catch (error) {
                    operationError = error;
                }
                await waitForPlaybookQuiescence(actor, { pendingCalls: nestedBridge });
                await drainRaw();
                const selected = controlError ?? operationError ?? backgroundError;
                if (selected !== undefined)
                    throw selected;
                return resultFor(input.signal);
            }
            catch (error) {
                operationError = error;
                throw error;
            }
            finally {
                await finishBoundary(operationError);
            }
        },
        dispose() {
            if (disposalPromise)
                return disposalPromise;
            if (activeBoundary)
                return Promise.reject(new Error('cannot dispose during an active playbook boundary'));
            disposing = true;
            disposalPromise = (async () => {
                if (initializationLatch)
                    await initializationLatch;
                const bound = session;
                const current = actor;
                const bridge = nestedBridge;
                const finalState = current ? normalizePlaybookSnapshot(current.getSnapshot(), { pendingCall: bridge?.getPendingCall() }) : undefined;
                inspectionEnabled = false;
                current?.stop();
                let cleanupError;
                try {
                    await bridge?.dispose();
                }
                catch (error) {
                    cleanupError = error;
                }
                await captainQueue.onIdle();
                await drainRaw();
                if (bound && finalState) {
                    trace('session.disposed', { state: finalState, ...(finalState.stateId ? { stateId: finalState.stateId } : {}) });
                    await drainRaw();
                }
                actor = undefined;
                nestedBridge = undefined;
                session = undefined;
                disposed = true;
                disposing = false;
                if (cleanupError !== undefined)
                    throw cleanupError;
                if (backgroundError !== undefined)
                    throw backgroundError;
            })();
            return disposalPromise;
        },
    };
    return runtime;
}
export const _internal = Object.freeze({ composePlayerPrompt, composeCaptainPrompt });
const factory = createPlaybookRuntime;
export default factory;
