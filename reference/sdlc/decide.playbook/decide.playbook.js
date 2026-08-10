// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// PlaybookRuntime for the decide playbook, linked from the FSM artifact by
// the slc FSM-to-runtime link phase.
//
// Linker inputs:
//   FSM artifact:       ./decide.fsm.ts
//   Link target:        @sublang/playbook/runtime
//   Player binding:     Coder -> coder, Reviewer -> reviewer
//                       (default binding: lowercased player name)
//   Adjudication:       LLM-judge per state (default)
//   Boss-event mapping: free-text judge classification (default)
//   Abort strategy:     natural rejection; every player-invoking state's
//                       onError routes to the quiescent failed state.
//   Output profile:     bespoke parallel runtime with the shared nested-call
//                       bridge (slc/link.md §Output)
import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import { assertJsonSafe, assertPlaybookRuntimeSnapshot, combineAbortSignals, createNestedPlaybookBridge, detachPersistedMachineSnapshot, normalizeError, normalizePlaybookSnapshot, snapshotJsonValue, snapshotPlaybookSession, validatePlayerResult, waitForPlaybookQuiescence, } from '../../../src/xstate-runtime.js';
import decideMachine from './decide.fsm.js';
const DEFAULT_PLAYER_BINDING = {
    Coder: 'coder',
    Reviewer: 'reviewer',
};
function snapshotDecideRuntimeOptions(value) {
    const captured = snapshotJsonValue(value, 'DECIDE runtime options');
    if (!isPlainObject(captured)) {
        throw new TypeError('DECIDE runtime options must be an object');
    }
    const allowed = new Set(['coderLlm', 'playerBinding']);
    for (const key of Object.keys(captured)) {
        if (!allowed.has(key)) {
            throw new TypeError(`DECIDE runtime options.${key} is not declared`);
        }
    }
    if (typeof captured.coderLlm !== 'string' ||
        captured.coderLlm.trim().length === 0) {
        throw new TypeError('DECIDE runtime options.coderLlm must be a non-empty string');
    }
    if ('playerBinding' in captured) {
        const playerBinding = captured.playerBinding;
        if (!isPlainObject(playerBinding)) {
            throw new TypeError('DECIDE runtime options.playerBinding must be an object');
        }
        const playerNames = new Set(['Coder', 'Reviewer']);
        for (const [player, playerId] of Object.entries(playerBinding)) {
            if (!playerNames.has(player)) {
                throw new TypeError(`DECIDE runtime options.playerBinding.${player} is not declared`);
            }
            if (typeof playerId !== 'string' || playerId.trim().length === 0) {
                throw new TypeError(`DECIDE runtime options.playerBinding.${player} must be a non-empty string`);
            }
        }
    }
    return captured;
}
const STATE_DESCRIPTIONS = {
    ready: 'Waiting for a topic to decide.',
    askCoderProposal: 'Coder independently proposes a spec design.',
    askReviewerProposal: 'Reviewer independently proposes a spec design.',
    waitCoderProposalReply: 'Coder waits for Boss to answer a question.',
    waitReviewerProposalReply: 'Reviewer waits for Boss to answer a question.',
    commitCoderProposal: 'Coder writes and commits Coder’s independent proposal.',
    awaitBossReply: 'Waiting for Boss to answer Coder’s question.',
    reviewCommit: 'REVIEW examines the committed proposal.',
    failed: 'DECIDE failed and is waiting for a new topic.',
    reportedReviewFailure: 'DECIDE reports REVIEW’s failure and its last commit.',
    done: 'DECIDE completed with an approved commit.',
};
const PLAYER_STATES = [
    { stateId: 'askCoderProposal', player: 'Coder', sourceItem: 'DECIDE-1' },
    {
        stateId: 'askReviewerProposal',
        player: 'Reviewer',
        sourceItem: 'DECIDE-2',
    },
    { stateId: 'commitCoderProposal', player: 'Coder', sourceItem: 'DECIDE-3' },
];
const PLAYER_STATE_IDS = new Set(PLAYER_STATES.map((state) => state.stateId));
const BOSS_INTERRUPT_TARGETS = ['independentProposals'];
const BOSS_INTERRUPT_TARGET_IDS = new Set(BOSS_INTERRUPT_TARGETS);
const TELEMETRY_TOPIC = 'playbook.fsm.state';
const TRACE_TOPIC = 'playbook.trace';
const CONTINUATION_PREAMBLE = 'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';
const PLACEHOLDER_FIELDS = [
    ['<caller-topic>', 'callerTopic'],
    ['<coder-llm>', 'coderLlm'],
];
const VERBATIM_PAYLOAD_FIELDS = new Set([
    'coderProposal',
    'reviewerProposal',
]);
function composePlayerPrompt(input) {
    const blocks = [];
    if (input.pendingBossQuestion && input.bossReply !== undefined) {
        blocks.push([
            CONTINUATION_PREAMBLE,
            '',
            'Boss question:',
            input.pendingBossQuestion.question,
            '',
            'Boss reply:',
            input.bossReply,
        ].join('\n'));
    }
    const replacements = new Map();
    for (const [placeholder, field] of PLACEHOLDER_FIELDS) {
        const value = input[field];
        if (typeof value === 'string')
            replacements.set(placeholder, value);
    }
    const body = input.prompt.replace(/<caller-topic>|<coder-llm>/g, (placeholder, offset, source) => {
        const value = replacements.get(placeholder);
        if (value === undefined)
            return placeholder;
        const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
        return source.slice(lineStart, offset) === '> '
            ? value.replaceAll('\n', '\n> ')
            : value;
    });
    blocks.push(body);
    return blocks.join('\n\n');
}
function resolvePlayerId(input, binding) {
    switch (input.player) {
        case 'Coder':
            return binding.Coder;
        case 'Reviewer':
            return binding.Reviewer;
        default: {
            const exhaustive = input.player;
            throw new Error(`unknown player ${String(exhaustive)}`);
        }
    }
}
// A `result` description names required payload fields in its
// "Output shall include ..." sentence.
function requiredFieldsFor(description) {
    const fields = [];
    const sentence = /Output shall include([^.]*)/g;
    let span;
    while ((span = sentence.exec(description)) !== null) {
        for (const field of span[1].matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
            fields.push(field[1]);
        }
    }
    return fields;
}
// LLM judges routinely wrap JSON in prose/fences or damage its tail. Match
// CODE's recovery contract: scan candidate starts in document order, prefer a
// strict balanced value at each position, then repair trailing commas and
// truncation before considering a later candidate.
function extractJson(raw) {
    try {
        const parsed = parseJudgeJson(raw);
        return isPlainObject(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function parseJudgeJson(raw) {
    const text = stripCodeFence(raw.trim());
    try {
        return JSON.parse(text);
    }
    catch {
        // Fall through to candidate extraction and repair.
    }
    const starts = [];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === '{' || text[index] === '[')
            starts.push(index);
    }
    let firstValue;
    for (const start of starts) {
        let parsedHere;
        for (const repair of [false, true]) {
            const candidate = extractJsonValue(text, start, repair);
            if (candidate === undefined)
                continue;
            try {
                parsedHere = { value: JSON.parse(candidate) };
            }
            catch {
                // Try repair at this position, then continue in document order.
                continue;
            }
            break;
        }
        if (parsedHere === undefined)
            continue;
        if (isPlainObject(parsedHere.value))
            return parsedHere.value;
        firstValue ??= parsedHere;
    }
    if (firstValue !== undefined)
        return firstValue.value;
    throw new Error('judge response is not valid JSON');
}
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stripCodeFence(text) {
    const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    return fence ? fence[1].trim() : text;
}
function extractJsonValue(text, start, repair) {
    const stack = [];
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const character = text[index];
        if (inString) {
            output += character;
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
            output += character;
            continue;
        }
        if (character === '{' || character === '[') {
            stack.push(character === '{' ? '}' : ']');
            output += character;
            continue;
        }
        if (character === '}' || character === ']') {
            if (repair)
                output = dropTrailingComma(output);
            output += character;
            stack.pop();
            if (stack.length === 0)
                return output;
            continue;
        }
        output += character;
    }
    if (!repair)
        return undefined;
    if (inString)
        output += '"';
    output = dropTrailingComma(output);
    while (stack.length > 0)
        output += stack.pop();
    return output;
}
function dropTrailingComma(value) {
    return value.replace(/,(\s*)$/, '$1');
}
function buildClassifierPrompt(text, ctx) {
    const lines = [];
    lines.push('You are the Boss-input classifier for the decide playbook.');
    lines.push('Classify the Boss message into exactly one FSM event, or into no event.');
    lines.push('');
    lines.push(`Current FSM state: ${JSON.stringify(ctx.state.value)}`);
    lines.push(`Active state ids: ${ctx.state.activeStateIds.join(', ')}`);
    if (ctx.pendingQuestions.length > 0) {
        lines.push('Pending Boss questions:');
        for (const pending of ctx.pendingQuestions) {
            lines.push(`- ${pending.questionId} (${pending.player}): ${pending.question}`);
        }
        lines.push('If the Boss message answers a pending question, classify it as BOSS_REPLY; if it is a fresh directive, classify it accordingly.');
    }
    lines.push('');
    lines.push('Events and payload contracts:');
    lines.push(`- BOSS_INTERRUPT: required targetId string, exactly ${BOSS_INTERRUPT_TARGETS[0]}; the runtime attaches the exact Boss text as bossIntent.`);
    lines.push('- BOSS_REPLY: optional questionId when exactly one question is pending and required when several are pending; the runtime attaches the exact Boss text as answer.');
    lines.push('- NO_ACTION: no fields.');
    lines.push('');
    lines.push('Boss message:');
    lines.push(text);
    lines.push('');
    lines.push('Reply with a single JSON object: { "type": "<EVENT_TYPE>", ...declared fields }.');
    lines.push('Use NO_ACTION when no FSM action applies.');
    return lines.join('\n');
}
function parseClassification(raw, text, pendingQuestionIds = []) {
    const obj = extractJson(raw);
    if (!obj)
        return null;
    const exactKeys = (...keys) => {
        const ownKeys = Reflect.ownKeys(obj);
        return (ownKeys.length === keys.length &&
            ownKeys.every((key) => typeof key === 'string' && keys.includes(key)));
    };
    const eventType = obj.type;
    if (eventType === 'NO_ACTION') {
        return exactKeys('type') ? { type: 'NO_ACTION' } : null;
    }
    if (eventType === 'BOSS_INTERRUPT') {
        if (exactKeys('type', 'targetId') &&
            typeof obj.targetId === 'string' &&
            BOSS_INTERRUPT_TARGET_IDS.has(obj.targetId)) {
            return {
                type: 'BOSS_INTERRUPT',
                targetId: obj.targetId,
                bossIntent: text,
            };
        }
        return null;
    }
    if (eventType === 'BOSS_REPLY') {
        if (pendingQuestionIds.length === 0)
            return null;
        if (typeof obj.questionId === 'string') {
            return exactKeys('type', 'questionId') &&
                pendingQuestionIds.includes(obj.questionId)
                ? {
                    type: 'BOSS_REPLY',
                    questionId: obj.questionId,
                    answer: text,
                }
                : null;
        }
        return exactKeys('type') && pendingQuestionIds.length === 1
            ? {
                type: 'BOSS_REPLY',
                questionId: pendingQuestionIds[0],
                answer: text,
            }
            : null;
    }
    return null;
}
function buildAdjudicatorPrompt(input, playerOutput) {
    const lines = [];
    lines.push('You are the guard adjudicator for a playbook state machine.');
    lines.push('This is hidden control work. Do not call tools, inspect files, or ' +
        'seek external evidence. Decide only from the supplied player output ' +
        'and guard descriptions. Reply with exactly one JSON object and no prose.');
    lines.push(`The player "${input.player}" produced the output below for source item ${input.sourceItem}.`);
    lines.push('Choose exactly one guard whose description matches that output.');
    lines.push('');
    lines.push('Player output (verbatim):');
    lines.push('"""');
    lines.push(playerOutput);
    lines.push('"""');
    lines.push('');
    lines.push('Guards (choose exactly one; the descriptions are authoritative and must be applied as written):');
    for (const [guard, description] of Object.entries(input.result)) {
        lines.push(`- ${guard}: ${description}`);
    }
    const runtimeOwnedFields = new Set();
    for (const description of Object.values(input.result)) {
        for (const field of requiredFieldsFor(description)) {
            if (VERBATIM_PAYLOAD_FIELDS.has(field))
                runtimeOwnedFields.add(field);
        }
    }
    if (runtimeOwnedFields.size > 0) {
        lines.push('');
        lines.push(`The runtime owns these verbatim fields; do not include them in your JSON: ${[...runtimeOwnedFields].join(', ')}.`);
    }
    lines.push('');
    lines.push('Reply with a single JSON object: { "guard": "<one of the guard names above>", ...any payload fields the chosen guard description requires }.');
    return lines.join('\n');
}
function parseAdjudication(raw, input, finalText) {
    const obj = extractJson(raw);
    if (!obj || typeof obj.guard !== 'string' || obj.guard.trim() === '') {
        throw new Error('adjudicator returned empty or malformed JSON');
    }
    const guard = obj.guard;
    if (!Object.prototype.hasOwnProperty.call(input.result, guard)) {
        throw new Error(`adjudicator returned undeclared guard "${guard}" for ${input.sourceItem}`);
    }
    const requiredFields = requiredFieldsFor(input.result[guard]);
    const allowedFields = new Set(['guard', ...requiredFields]);
    for (const key of Reflect.ownKeys(obj)) {
        if (typeof key !== 'string' || !allowedFields.has(key)) {
            throw new Error(`adjudicator response for guard "${guard}" included undeclared field "${String(key)}"`);
        }
    }
    const output = { guard };
    for (const field of requiredFields) {
        if (VERBATIM_PAYLOAD_FIELDS.has(field)) {
            output[field] = finalText;
            continue;
        }
        const value = obj[field];
        if (value === undefined ||
            value === null ||
            (typeof value === 'string' && value.trim() === '')) {
            throw new Error(`adjudicator response for guard "${guard}" missing required field "${field}"`);
        }
        output[field] = value;
    }
    return output;
}
function combineSignals(a, b) {
    return combineAbortSignals(a, b);
}
function normalizeErrorCompact(err) {
    if (err === undefined || err === null)
        return undefined;
    const normalized = normalizeError(err);
    return { name: normalized.name, message: normalized.message };
}
function normalizeErrorFull(err) {
    return err === undefined || err === null ? undefined : normalizeError(err);
}
// DR-028's unified empty predicate: a missing, empty, or whitespace-only
// `finalText` on an `ok` player result is the one shape that earns exactly
// one corrective re-ask before the existing failure path applies. Mirrors
// the shared engine's predicate (PBRT-9).
function isEmptyFinalText(finalText) {
    return finalText === undefined || finalText.trim().length === 0;
}
function isAbortFailure(error, signal) {
    return signal.aborted && Object.is(error, signal.reason);
}
function pendingQuestionsFromContext(context) {
    const pending = context.pendingBossQuestions;
    if (pending === undefined ||
        pending === null ||
        typeof pending !== 'object') {
        return [];
    }
    const questions = [];
    for (const [key, value] of Object.entries(pending)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            continue;
        }
        const obj = value;
        if (typeof obj.questionId === 'string' &&
            obj.questionId === key &&
            typeof obj.resumeStateId === 'string' &&
            typeof obj.sourceItem === 'string' &&
            typeof obj.player === 'string' &&
            typeof obj.question === 'string') {
            questions.push(obj);
        }
    }
    return questions.sort((left, right) => left.questionId.localeCompare(right.questionId));
}
const WAIT_STATE_RESUME_IDS = {
    waitCoderProposalReply: 'askCoderProposal',
    waitReviewerProposalReply: 'askReviewerProposal',
};
const WAIT_STATE_IDS = new Set([
    ...Object.keys(WAIT_STATE_RESUME_IDS),
    'awaitBossReply',
]);
const STATUS_STATE_IDS = new Set([
    ...PLAYER_STATE_IDS,
    ...WAIT_STATE_IDS,
    'failed',
]);
function questionForWaitState(stateId, pendingQuestions) {
    const resumeStateId = WAIT_STATE_RESUME_IDS[stateId];
    if (resumeStateId !== undefined) {
        return pendingQuestions.find((pending) => pending.resumeStateId === resumeStateId);
    }
    return stateId === 'awaitBossReply' && pendingQuestions.length === 1
        ? pendingQuestions[0]
        : undefined;
}
const TRANSITION_EVENT_FIELDS = [
    'callerTopic',
    'targetId',
    'bossIntent',
    'questionId',
    'answer',
];
function normalizedTransitionEvent(event) {
    if (event === null || typeof event !== 'object') {
        return snapshotJsonValue(event ?? null, 'FSM event');
    }
    const source = event;
    const descriptor = {};
    if (typeof source.type === 'string')
        descriptor.type = source.type;
    for (const field of TRANSITION_EVENT_FIELDS) {
        if (typeof source[field] === 'string') {
            descriptor[field] = source[field];
        }
    }
    if (source.output !== undefined) {
        descriptor.output = snapshotJsonValue(source.output, 'FSM event output');
    }
    if (source.error !== undefined) {
        descriptor.error = snapshotJsonValue(normalizeError(source.error), 'FSM event error');
    }
    return snapshotJsonValue(descriptor, 'FSM event');
}
function telemetryPayload(previousState, state, event, context) {
    const pendingBossQuestions = pendingQuestionsFromContext(context);
    const prior = previousState ?? state;
    const payload = {
        from: prior.value,
        to: state.value,
        event: normalizedTransitionEvent(event),
        previousState: prior,
        state,
        ...(pendingBossQuestions.length > 0 ? { pendingBossQuestions } : {}),
        ...(state.activeStateIds.includes('failed')
            ? { lastError: normalizeErrorFull(context.lastError) ?? null }
            : {}),
    };
    assertJsonSafe(payload);
    return payload;
}
export const createPlaybookRuntime = (options) => {
    const boundOptions = snapshotDecideRuntimeOptions(options);
    const binding = {
        ...DEFAULT_PLAYER_BINDING,
        ...(boundOptions.playerBinding ?? {}),
    };
    const fsmInput = {
        coderLlm: boundOptions.coderLlm,
    };
    let ports;
    let sessionIdentity;
    let actor;
    let currentSignal;
    let currentTurnId;
    let previousState;
    let suppressInspectionEmissions = false;
    let emissionFailures = [];
    let traceSequence = 0;
    let turnSequence = 0;
    let judgeCallSequence = 0;
    let playerCallSequence = 0;
    let playbookCallSequence = 0;
    let lifecycleStarted = false;
    let initInFlight;
    let disposed = false;
    let disposalPromise;
    let controlPlaneError;
    let nestedBridge;
    const playerResumeTokens = new Map();
    const playbookCallTurnIds = new Map();
    const inFlightPlayerIds = new Set();
    const activeBoundaryCalls = new Set();
    const activeEmissionCalls = new Set();
    const emissionQueue = new PQueue({ concurrency: 1 });
    const judgeQueue = new PQueue({ concurrency: 1 });
    const collectFailure = (failures, error) => {
        if (error instanceof AggregateError) {
            for (const nested of error.errors)
                collectFailure(failures, nested);
            return;
        }
        if (!failures.some((failure) => Object.is(failure, error))) {
            failures.push(error);
        }
    };
    const latchControlPlaneError = (error, signal) => {
        if (!isAbortFailure(error, signal))
            controlPlaneError ??= error;
    };
    const latchInspectionError = (error) => {
        if (currentSignal !== undefined) {
            latchControlPlaneError(error, currentSignal);
        }
        else {
            collectFailure(emissionFailures, error);
        }
    };
    const enqueue = (fn) => {
        const queued = emissionQueue.add(fn);
        activeEmissionCalls.add(queued);
        void queued.then(() => activeEmissionCalls.delete(queued), (error) => {
            activeEmissionCalls.delete(queued);
            collectFailure(emissionFailures, error);
        });
        return queued;
    };
    const flush = async () => {
        while (true) {
            const active = [...activeEmissionCalls];
            if (active.length > 0)
                await Promise.allSettled(active);
            await emissionQueue.onIdle();
            if (activeEmissionCalls.size === 0 &&
                emissionQueue.size === 0 &&
                emissionQueue.pending === 0) {
                break;
            }
        }
        if (emissionFailures.length === 0)
            return;
        const failures = emissionFailures;
        emissionFailures = [];
        if (failures.length === 1)
            throw failures[0];
        throw new AggregateError(failures, 'decide runtime emissions failed');
    };
    const drainBoundaryCallsAndEmissions = async () => {
        while (true) {
            if (activeBoundaryCalls.size > 0) {
                await Promise.allSettled([...activeBoundaryCalls]);
            }
            await flush();
            if (activeBoundaryCalls.size === 0)
                return;
        }
    };
    const trackBoundaryCall = (call) => {
        activeBoundaryCalls.add(call);
        void call.then(() => activeBoundaryCalls.delete(call), () => activeBoundaryCalls.delete(call));
        return call;
    };
    const requirePorts = () => {
        if (!ports) {
            throw new Error('decide runtime: init(session) must be called first');
        }
        return ports;
    };
    const requireSessionIdentity = () => {
        if (!sessionIdentity) {
            throw new Error('decide runtime: init(session) must be called first');
        }
        return sessionIdentity;
    };
    const selectPlayerResume = (playerId) => {
        const session = requireSessionIdentity();
        const selected = session.playerSessions
            ? session.playerSessions.select(playerId)
            : playerResumeTokens.get(playerId) ?? false;
        if (selected !== false &&
            (typeof selected !== 'string' || selected.trim().length === 0)) {
            throw new TypeError(`player session store returned an invalid resume token for ${playerId}`);
        }
        return selected;
    };
    const updatePlayerResume = (playerId, resumeToken) => {
        const session = requireSessionIdentity();
        if (session.playerSessions) {
            session.playerSessions.update(playerId, resumeToken);
        }
        else if (resumeToken !== undefined && resumeToken.trim().length > 0) {
            playerResumeTokens.set(playerId, resumeToken);
        }
        else {
            playerResumeTokens.delete(playerId);
        }
    };
    const snapshotPlayerResumeTokens = () => {
        const session = requireSessionIdentity();
        const captured = snapshotJsonValue(session.playerSessions
            ? session.playerSessions.snapshot()
            : Object.fromEntries(playerResumeTokens), 'player session store snapshot');
        if (!isPlainObject(captured)) {
            throw new TypeError('player session store snapshot must be an object');
        }
        const tokens = {};
        for (const [playerId, token] of Object.entries(captured)) {
            if (playerId.trim().length === 0) {
                throw new TypeError('player session store snapshot player ids must be non-empty');
            }
            if (typeof token !== 'string' || token.trim().length === 0) {
                throw new TypeError(`player session store snapshot token for ${playerId} must be a non-empty string`);
            }
            tokens[playerId] = token;
        }
        return tokens;
    };
    const restorePlayerResumeTokens = (tokens) => {
        const session = requireSessionIdentity();
        if (session.playerSessions) {
            session.playerSessions.restore(tokens);
            return;
        }
        playerResumeTokens.clear();
        for (const [playerId, token] of Object.entries(tokens)) {
            playerResumeTokens.set(playerId, token);
        }
    };
    const currentState = () => {
        const live = actor;
        if (!live) {
            throw new Error('decide runtime: actor is not initialized');
        }
        return normalizePlaybookSnapshot(live.getSnapshot(), {
            pendingCall: nestedBridge.getPendingCall(),
        });
    };
    const stateIdentity = (state) => {
        return state.stateId === undefined ? {} : { stateId: state.stateId };
    };
    const enqueueTracedEmission = (type, payload, meta = {}, describedEmission) => {
        const runtimePorts = requirePorts();
        const identity = requireSessionIdentity();
        const jsonPayload = snapshotJsonValue(payload, `trace ${type} payload`);
        const trace = Object.freeze({
            schemaVersion: 2,
            sessionId: identity.sessionId,
            playbookId: identity.playbookId,
            rootSessionId: identity.rootSessionId,
            ...(identity.parentSessionId !== undefined
                ? { parentSessionId: identity.parentSessionId }
                : {}),
            ...(identity.parentCallId !== undefined
                ? { parentCallId: identity.parentCallId }
                : {}),
            depth: identity.depth,
            sequence: ++traceSequence,
            timestamp: Date.now(),
            type,
            ...(meta.turnId !== undefined ? { turnId: meta.turnId } : {}),
            ...(meta.callId !== undefined ? { callId: meta.callId } : {}),
            payload: jsonPayload,
        });
        return enqueue(async () => {
            await runtimePorts.emitTelemetry({ topic: TRACE_TOPIC, payload: trace });
            await describedEmission?.(runtimePorts);
        });
    };
    const emitTrace = (type, payload, meta = {}) => enqueueTracedEmission(type, payload, meta);
    const emitBoundaryStatus = async (message, state) => {
        const bossRelevantStateIds = state.activeStateIds.filter((stateId) => STATUS_STATE_IDS.has(stateId));
        await enqueueTracedEmission('status.emitted', {
            ...(bossRelevantStateIds.length === 1
                ? { stateId: bossRelevantStateIds[0] }
                : {}),
            message,
            state,
        }, { turnId: currentTurnId }, (runtimePorts) => runtimePorts.emitStatus(message));
    };
    const emitCallStarted = async (startedType, finishedType, identity, meta, signal) => {
        try {
            await emitTrace(startedType, identity, meta);
        }
        catch (error) {
            latchControlPlaneError(error, signal);
            try {
                await emitTrace(finishedType, {
                    ...identity,
                    status: 'error',
                    error: normalizeErrorFull(error) ?? {
                        name: 'Error',
                        message: String(error),
                    },
                }, meta);
            }
            catch {
                // Preserve the start failure after one best-effort finish attempt.
            }
            throw error;
        }
    };
    const runJudgeCall = async (prompt, signal, purpose, callStateId) => {
        const identity = {
            purpose,
            ...(callStateId !== undefined ? { stateId: callStateId } : {}),
        };
        const queued = await judgeQueue.add(async () => {
            // Keep the complete queue task pending until an active coder promise
            // settles. PQueue's signal option may reject add() while that task is
            // still running, which would let the turn drain race a late finish.
            signal.throwIfAborted();
            const callId = `judge-${++judgeCallSequence}`;
            await emitCallStarted('judge.call.started', 'judge.call.finished', { ...identity, prompt }, { turnId: currentTurnId, callId }, signal);
            let finalText;
            try {
                signal.throwIfAborted();
                const reply = await requirePorts().callJudge(prompt, signal);
                if (typeof reply !== 'string') {
                    throw new TypeError('judge result must be a string');
                }
                finalText = reply;
                // A cancelled parallel actor can outlive a judge port that ignores
                // its signal. Do not report that late resolution as success.
                signal.throwIfAborted();
            }
            catch (error) {
                latchControlPlaneError(error, signal);
                await emitTrace('judge.call.finished', {
                    ...identity,
                    status: signal.aborted ? 'aborted' : 'error',
                    error: normalizeErrorFull(error) ?? {
                        name: 'Error',
                        message: String(error),
                    },
                }, { turnId: currentTurnId, callId });
                throw error;
            }
            await emitTrace('judge.call.finished', { ...identity, status: 'ok', reply: finalText }, { turnId: currentTurnId, callId });
            return finalText;
        });
        if (queued === undefined) {
            throw new Error('judge call completed without a reply');
        }
        return queued;
    };
    const callJudge = (prompt, signal, purpose, callStateId) => trackBoundaryCall(runJudgeCall(prompt, signal, purpose, callStateId));
    const runPlayerCall = async (input, signal) => {
        const playerId = resolvePlayerId(input, binding);
        if (inFlightPlayerIds.has(playerId)) {
            throw new Error(`resolved player "${playerId}" already has an in-flight call`);
        }
        const prompt = composePlayerPrompt(input);
        let resume;
        try {
            signal.throwIfAborted();
            resume = selectPlayerResume(playerId);
        }
        catch (error) {
            latchControlPlaneError(error, signal);
            throw error;
        }
        const callId = `player-${++playerCallSequence}`;
        const identity = {
            purpose: 'captain',
            stateId: input.stateId,
            sourceItem: input.sourceItem,
            playerId,
            resume,
        };
        const emitFailure = (error) => emitTrace('player.call.finished', {
            ...identity,
            status: signal.aborted ? 'aborted' : 'error',
            error: normalizeErrorFull(error) ?? {
                name: 'Error',
                message: String(error),
            },
        }, { turnId: currentTurnId, callId });
        inFlightPlayerIds.add(playerId);
        try {
            await emitCallStarted('player.call.started', 'player.call.finished', { ...identity, prompt }, { turnId: currentTurnId, callId }, signal);
            let rawResult;
            try {
                signal.throwIfAborted();
                const boundary = Promise.resolve(requirePorts().callPlayer(playerId, prompt, signal, { resume }));
                rawResult = await boundary;
                // An XState sibling cancellation does not cancel an arbitrary coder
                // promise. Re-check before a late resolution can mutate continuity or
                // masquerade as a successful boundary finish.
                signal.throwIfAborted();
            }
            catch (error) {
                // A rejected call produced no authoritative result, so the previous
                // token remains untouched. This also covers a coder promise that
                // resolves after its invocation signal was cancelled.
                latchControlPlaneError(error, signal);
                try {
                    await emitFailure(error);
                }
                catch {
                    // The original non-abort port rejection remains authoritative.
                }
                throw error;
            }
            let result;
            try {
                result = validatePlayerResult(rawResult);
            }
            catch (error) {
                latchControlPlaneError(error, signal);
                try {
                    await emitFailure(error);
                }
                catch {
                    // The malformed coder result remains authoritative.
                }
                throw error;
            }
            // The resolved result is authoritative even on aborted/error status.
            // Update continuation state before interpreting that status.
            try {
                updatePlayerResume(playerId, typeof result.resumeToken === 'string' &&
                    result.resumeToken.trim().length > 0
                    ? result.resumeToken
                    : undefined);
            }
            catch (error) {
                latchControlPlaneError(error, signal);
                try {
                    await emitFailure(error);
                }
                catch {
                    // The continuation-store failure remains authoritative.
                }
                throw error;
            }
            // Keep this finish outside the boundary catch. A trace sink can record
            // the event and then reject; retrying from that catch would duplicate the
            // same call id and falsely recast an emission failure as a player error.
            await emitTrace('player.call.finished', {
                ...identity,
                status: result.status,
                ...(result.resumeToken !== undefined
                    ? { resumeToken: result.resumeToken }
                    : {}),
                ...(result.finalText !== undefined
                    ? { finalText: result.finalText }
                    : {}),
                ...(result.error !== undefined
                    ? { error: normalizeErrorFull(result.error) }
                    : {}),
            }, { turnId: currentTurnId, callId });
            return { playerId, result };
        }
        finally {
            inFlightPlayerIds.delete(playerId);
        }
    };
    const callPlayer = (input, signal) => {
        return trackBoundaryCall(runPlayerCall(input, signal));
    };
    const player = fromPromise(async ({ input, signal }) => {
        const combined = combineSignals(signal, currentSignal);
        // XState starts invoked actors while publishing the entering snapshot.
        // Yield through the runtime emission queue before crossing the player
        // boundary so state trace/status always precede its call-start trace.
        try {
            await flush();
        }
        catch (error) {
            latchControlPlaneError(error, combined);
            throw error;
        }
        combined.throwIfAborted();
        let { playerId, result } = await callPlayer(input, combined);
        if (result.status === 'ok' && isEmptyFinalText(result.finalText)) {
            // DR-028: an `ok` result whose finalText is missing, empty, or
            // whitespace-only earns exactly one corrective re-ask — the same
            // composed call repeated, traced by runPlayerCall as its own
            // player-call pair, with the resume selection re-read from the
            // token map the first result left (PBRT-38). An abort that lands
            // between the two calls ends the turn without the re-ask (aborts
            // are never retried), and a rejecting finish emission rejects
            // `callPlayer` itself, so it never reaches this branch (PBRT-47).
            combined.throwIfAborted();
            ({ playerId, result } = await callPlayer(input, combined));
        }
        if (result.status !== 'ok') {
            throw new Error(`player "${playerId}" returned status "${result.status}"${result.error ? `: ${result.error}` : ''}`);
        }
        const finalText = result.finalText ?? '';
        if (isEmptyFinalText(finalText)) {
            throw new Error(`player "${playerId}" returned status "ok" with no finalText`);
        }
        combined.throwIfAborted();
        try {
            const prompt = buildAdjudicatorPrompt(input, finalText);
            return parseAdjudication(await callJudge(prompt, combined, 'player-output-adjudication', input.stateId), input, finalText);
        }
        catch (error) {
            latchControlPlaneError(error, combined);
            throw error;
        }
    });
    nestedBridge = createNestedPlaybookBridge({
        nextCallId: () => `playbook-${++playbookCallSequence}`,
        getBoundarySignal: () => currentSignal,
        callPlaybook: (request, signal) => trackBoundaryCall(Promise.resolve(requirePorts().callPlaybook(request, signal))),
        emitStarted: async (event) => {
            playbookCallTurnIds.set(event.callId, currentTurnId);
            await emitTrace('playbook.call.started', {
                stateId: event.stateId,
                playbookId: event.playbookId,
                text: event.text,
            }, {
                ...(currentTurnId === undefined ? {} : { turnId: currentTurnId }),
                callId: event.callId,
            });
        },
        emitFinished: async (event) => {
            const turnId = playbookCallTurnIds.get(event.callId);
            try {
                await emitTrace('playbook.call.finished', {
                    stateId: event.stateId,
                    playbookId: event.playbookId,
                    text: event.text,
                    result: event.result,
                }, {
                    ...(turnId === undefined ? {} : { turnId }),
                    callId: event.callId,
                });
            }
            finally {
                playbookCallTurnIds.delete(event.callId);
            }
        },
        drain: flush,
        bindResumeSignal: (signal) => {
            currentSignal = signal;
        },
        onControlPlaneError: (error) => {
            const signal = currentSignal;
            if (!signal || !isAbortFailure(error, signal)) {
                controlPlaneError ??= error;
            }
        },
        onBackgroundError: (error) => {
            collectFailure(emissionFailures, error);
        },
    });
    const providedMachine = decideMachine.provide({
        actors: { player, playbook: nestedBridge.actorLogic },
    });
    const inspect = (event) => {
        if (event.type !== '@xstate.snapshot')
            return;
        if (actor === undefined || event.actorRef !== actor)
            return;
        if (suppressInspectionEmissions)
            return;
        try {
            const snapshot = event.snapshot;
            const state = normalizePlaybookSnapshot(snapshot);
            const prior = previousState ?? state;
            const context = snapshot.context;
            const fsmPayload = telemetryPayload(prior, state, event.event, context);
            const describedFsmPayload = snapshotJsonValue(fsmPayload, 'described FSM telemetry');
            void enqueueTracedEmission('fsm.transition', fsmPayload, { turnId: currentTurnId }, (emissionPorts) => emissionPorts.emitTelemetry({
                topic: TELEMETRY_TOPIC,
                payload: describedFsmPayload,
            })).catch(() => undefined);
            const priorIds = new Set(previousState?.activeStateIds ?? []);
            previousState = state;
            const pendingQuestions = pendingQuestionsFromContext(context);
            const bossRelevantStateIds = state.activeStateIds.filter((stateId) => STATUS_STATE_IDS.has(stateId));
            const scheduleStatus = (message, stateId, data) => {
                const tracePayload = {
                    ...(bossRelevantStateIds.length === 1 ? { stateId } : {}),
                    message,
                    state,
                    ...(data !== undefined ? { data } : {}),
                };
                assertJsonSafe(tracePayload);
                void enqueueTracedEmission('status.emitted', tracePayload, { turnId: currentTurnId }, (emissionPorts) => emissionPorts.emitStatus(message, data)).catch(() => undefined);
            };
            for (const activeStateId of state.activeStateIds) {
                if (priorIds.has(activeStateId) ||
                    !STATUS_STATE_IDS.has(activeStateId)) {
                    continue;
                }
                if (WAIT_STATE_IDS.has(activeStateId)) {
                    const pending = questionForWaitState(activeStateId, pendingQuestions);
                    if (pending) {
                        scheduleStatus(`${pending.player} asks: ${pending.question}`, activeStateId);
                        scheduleStatus(`◆ awaiting Boss reply · ${pending.resumeStateId} · ${pending.player} · ${pending.sourceItem}`, activeStateId);
                    }
                    continue;
                }
                const lastError = activeStateId === 'failed'
                    ? normalizeErrorCompact(context.lastError)
                    : undefined;
                const description = STATE_DESCRIPTIONS[activeStateId];
                if (description === undefined)
                    continue;
                const playerState = PLAYER_STATES.find((candidate) => candidate.stateId === activeStateId);
                scheduleStatus(playerState === undefined
                    ? '◆ workflow failed; awaiting Boss recovery.'
                    : `⤷ ${playerState.player}: ${description}`, activeStateId, lastError === undefined ? undefined : { lastError });
            }
        }
        catch (error) {
            latchInspectionError(error);
        }
    };
    const createRuntimeActor = (machineSnapshot) => {
        previousState = undefined;
        // DR-014 §1: a restore rehydrates the persisted machine snapshot;
        // XState derives context/value from it and ignores `input` then.
        actor = createActor(providedMachine, {
            input: fsmInput,
            ...(machineSnapshot === undefined
                ? {}
                : {
                    snapshot: machineSnapshot,
                }),
            inspect,
        });
    };
    // PBRT-6: the single seam that stops this runtime's actor. Stopping a
    // still-running actor fires one more `@xstate.snapshot` for the *unchanged*
    // state value with `status: 'stopped'`; `inspect` cannot tell that disposal
    // artifact from a state entry, so unsuppressed it re-emits the parked
    // state's telemetry and a phantom self-loop transition. Suppression is a
    // property of stopping, not a rule each caller must remember — every stop
    // goes through here so no later site can reintroduce the omission.
    const stopActor = () => {
        if (!actor)
            return;
        suppressInspectionEmissions = true;
        actor.stop();
    };
    const startActor = () => {
        createRuntimeActor();
        // A fresh actor's emissions are real state entries again.
        suppressInspectionEmissions = false;
        actor?.start();
    };
    const driveToQuiescence = async () => {
        const live = actor;
        if (!live)
            throw new Error('decide runtime: actor is not initialized');
        await waitForPlaybookQuiescence(live, { pendingCalls: nestedBridge });
    };
    const classify = async (text, signal) => {
        const live = actor;
        if (!live)
            throw new Error('decide runtime: actor is not initialized');
        const snapshot = live.getSnapshot();
        const context = snapshot.context;
        const state = normalizePlaybookSnapshot(snapshot, {
            pendingCall: nestedBridge.getPendingCall(),
        });
        const pendingQuestions = pendingQuestionsFromContext(context);
        if (pendingQuestions.length === 0 &&
            (snapshot.status === 'done' ||
                state.activeStateIds.includes('ready') ||
                state.activeStateIds.includes('failed'))) {
            return { type: 'START_DECIDE', callerTopic: text };
        }
        if (pendingQuestions.length === 0)
            return null;
        const prompt = buildClassifierPrompt(text, {
            state,
            pendingQuestions,
        });
        const raw = await callJudge(prompt, signal, 'boss-input-classification', state.stateId);
        return parseClassification(raw, text, pendingQuestions.map(({ questionId }) => questionId));
    };
    const resultForSnapshot = (signal) => {
        const live = actor;
        if (!live)
            throw new Error('decide runtime: actor is not initialized');
        const snapshot = live.getSnapshot();
        const pendingCall = nestedBridge.getPendingCall();
        const state = normalizePlaybookSnapshot(snapshot, { pendingCall });
        const context = snapshot.context;
        if (signal?.aborted) {
            return {
                outcome: 'aborted',
                state,
                ...(signal.reason === undefined
                    ? {}
                    : {
                        error: normalizeErrorFull(signal.reason) ?? {
                            name: 'AbortError',
                            message: String(signal.reason),
                        },
                    }),
            };
        }
        if (snapshot.status === 'done') {
            const output = snapshot.output;
            if (output !== undefined)
                assertJsonSafe(output, 'terminal output');
            return {
                outcome: 'terminal',
                state,
                ...(output === undefined ? {} : { output }),
            };
        }
        if (snapshot.status === 'error') {
            throw (snapshot.error ??
                new Error('decide runtime actor entered error status'));
        }
        if (state.activeStateIds.includes('failed')) {
            const error = normalizeErrorFull(context.lastError);
            return {
                outcome: 'failed',
                state,
                ...(error === undefined ? {} : { error }),
            };
        }
        if (pendingCall) {
            return { outcome: 'suspended', state, pendingCall };
        }
        return { outcome: 'quiescent', state };
    };
    // Shared failed-start cleanup for init and restore: stop the actor,
    // drain queued work, optionally emit one best-effort session.disposed
    // boundary, and unbind every closure field so dispose stays callable.
    // The caller rethrows its original failure. A restore failure skips
    // the disposal trace — the parked session was never re-bound in this
    // process, so its persisted snapshot stays authoritative (DR-014 §2).
    const cleanupFailedStart = async (options) => {
        let finalState;
        if (options.emitDisposal && actor) {
            try {
                finalState = currentState();
            }
            catch {
                // A state that cannot even normalize has no disposal descriptor.
            }
        }
        try {
            stopActor();
        }
        catch {
            // Preserve the original startup failure.
        }
        try {
            await judgeQueue.onIdle();
            await drainBoundaryCallsAndEmissions();
        }
        catch {
            // Preserve the original startup failure.
        }
        if (options.emitDisposal) {
            try {
                await emitTrace('session.disposed', {
                    ...(finalState === undefined
                        ? {}
                        : { state: finalState, ...stateIdentity(finalState) }),
                });
                await flush();
            }
            catch {
                // The session-start error remains authoritative.
            }
        }
        playerResumeTokens.clear();
        inFlightPlayerIds.clear();
        activeBoundaryCalls.clear();
        activeEmissionCalls.clear();
        emissionQueue.clear();
        judgeQueue.clear();
        actor = undefined;
        currentSignal = undefined;
        currentTurnId = undefined;
        ports = undefined;
        sessionIdentity = undefined;
        previousState = undefined;
        suppressInspectionEmissions = false;
        controlPlaneError = undefined;
        emissionFailures = [];
        traceSequence = 0;
        turnSequence = 0;
        judgeCallSequence = 0;
        playerCallSequence = 0;
        playbookCallSequence = 0;
        playbookCallTurnIds.clear();
        lifecycleStarted = false;
    };
    return {
        async init(session) {
            if (lifecycleStarted ||
                initInFlight !== undefined ||
                disposed ||
                disposalPromise !== undefined) {
                throw new Error('decide runtime: init(session) may only be called once');
            }
            const identity = snapshotPlaybookSession(session);
            let finishInitialization;
            const initialization = new Promise((resolve) => {
                finishInitialization = resolve;
            });
            initInFlight = initialization;
            lifecycleStarted = true;
            ports = identity.ports;
            sessionIdentity = identity;
            try {
                suppressInspectionEmissions = false;
                createRuntimeActor();
                const state = currentState();
                await emitTrace('session.started', {
                    state,
                    ...stateIdentity(state),
                });
                actor?.start();
                await flush();
            }
            catch (error) {
                await cleanupFailedStart({ emitDisposal: true });
                throw error;
            }
            finally {
                finishInitialization();
                if (initInFlight === initialization)
                    initInFlight = undefined;
            }
        },
        // DR-014 §1 / PBRT-45: JSON-safe capture of a parked session.
        // Defined only at a safe capture point — initialized, not disposing
        // or disposed, no active public boundary, and the actor quiescent
        // with status `active` and no pending nested REVIEW call.
        exportSnapshot() {
            if (!actor ||
                !sessionIdentity ||
                disposed ||
                disposalPromise !== undefined) {
                return undefined;
            }
            if (currentTurnId !== undefined || currentSignal !== undefined) {
                return undefined;
            }
            if (nestedBridge.getPendingCall())
                return undefined;
            const state = currentState();
            if (state.status !== 'active' || !state.quiescent)
                return undefined;
            const machine = detachPersistedMachineSnapshot(actor.getPersistedSnapshot());
            const context = actor.getSnapshot().context;
            return {
                schemaVersion: 1,
                playbookId: sessionIdentity.playbookId,
                machine,
                playerResumeTokens: snapshotPlayerResumeTokens(),
                sequences: {
                    trace: traceSequence,
                    turn: turnSequence,
                    judgeCall: judgeCallSequence,
                    playerCall: playerCallSequence,
                    playbookCall: playbookCallSequence,
                },
                state,
                pendingBossQuestions: pendingQuestionsFromContext(context).map((pending) => ({
                    questionId: pending.questionId,
                    player: pending.player,
                    question: pending.question,
                    sourceItem: pending.sourceItem,
                })),
            };
        },
        // DR-014 §1 / PBRT-45: alternative to `init` that rehydrates an
        // exported snapshot under the same immutable session identity.
        // Emits no `session.started`, transition trace, or human status —
        // the session already started; the next public boundary continues
        // the contiguous trace sequence.
        async restore(session, snapshot) {
            if (lifecycleStarted ||
                initInFlight !== undefined ||
                disposed ||
                disposalPromise !== undefined) {
                throw new Error('decide runtime: restore(session, snapshot) may only be called once');
            }
            const identity = snapshotPlaybookSession(session);
            const boundSnapshot = assertPlaybookRuntimeSnapshot(snapshot, identity.playbookId);
            let finishInitialization;
            const initialization = new Promise((resolve) => {
                finishInitialization = resolve;
            });
            initInFlight = initialization;
            lifecycleStarted = true;
            ports = identity.ports;
            sessionIdentity = identity;
            let priorExternalPlayerTokens;
            try {
                traceSequence = boundSnapshot.sequences.trace;
                turnSequence = boundSnapshot.sequences.turn;
                judgeCallSequence = boundSnapshot.sequences.judgeCall;
                playerCallSequence = boundSnapshot.sequences.playerCall;
                playbookCallSequence = boundSnapshot.sequences.playbookCall;
                if (identity.playerSessions) {
                    priorExternalPlayerTokens = snapshotPlayerResumeTokens();
                }
                restorePlayerResumeTokens(boundSnapshot.playerResumeTokens);
                suppressInspectionEmissions = true;
                createRuntimeActor(boundSnapshot.machine);
                actor?.start();
                const restoredState = currentState();
                if (restoredState.status !== 'active') {
                    throw new Error(`decide runtime: restored actor status is ${restoredState.status}, expected active`);
                }
                suppressInspectionEmissions = false;
                previousState = restoredState;
                await flush();
            }
            catch (error) {
                let failure = error;
                if (priorExternalPlayerTokens !== undefined) {
                    try {
                        identity.playerSessions.restore(priorExternalPlayerTokens);
                    }
                    catch (rollbackError) {
                        failure = new AggregateError([error, rollbackError], 'DECIDE restore and player continuation rollback failed');
                    }
                }
                await cleanupFailedStart({ emitDisposal: false });
                throw failure;
            }
            finally {
                finishInitialization();
                if (initInFlight === initialization)
                    initInFlight = undefined;
            }
        },
        async handleBossInput(turn) {
            if (disposalPromise !== undefined) {
                throw new Error('decide runtime: runtime is disposing or disposed');
            }
            requirePorts();
            if (!actor) {
                throw new Error('decide runtime: init(session) must be called before handleBossInput');
            }
            if (currentSignal !== undefined) {
                throw new Error('decide runtime: another runtime turn is active');
            }
            const turnId = ++turnSequence;
            currentTurnId = turnId;
            currentSignal = turn.signal;
            controlPlaneError = undefined;
            let result = resultForSnapshot(turn.signal);
            let settlement = result;
            const failures = [];
            try {
                await emitTrace('boss.input.received', { text: turn.text }, { turnId });
                if (turn.text.trim().length === 0) {
                    const state = currentState();
                    result = { outcome: 'no-action', state };
                }
                else {
                    const event = await classify(turn.text, turn.signal);
                    if (!event) {
                        const state = currentState();
                        await emitBoundaryStatus('No playbook action classified.', state);
                        result = { outcome: 'no-action', state };
                    }
                    else if (event.type === 'NO_ACTION') {
                        result = { outcome: 'no-action', state: currentState() };
                    }
                    else {
                        await emitBoundaryStatus(event.type, currentState());
                        if (actor.getSnapshot().status === 'done') {
                            stopActor();
                            startActor();
                        }
                        actor.send(event);
                        await driveToQuiescence();
                        await drainBoundaryCallsAndEmissions();
                        if (controlPlaneError !== undefined)
                            throw controlPlaneError;
                        result = resultForSnapshot(turn.signal);
                    }
                }
                settlement = {
                    ...result,
                    ...stateIdentity(result.state),
                };
            }
            catch (error) {
                const primaryError = controlPlaneError;
                if (primaryError !== undefined) {
                    collectFailure(failures, primaryError);
                }
                else if (!turn.signal.aborted) {
                    collectFailure(failures, error);
                }
                const state = currentState();
                const effectiveError = primaryError ?? error;
                result =
                    turn.signal.aborted && primaryError === undefined
                        ? resultForSnapshot(turn.signal)
                        : {
                            outcome: 'failed',
                            state,
                            error: normalizeErrorFull(effectiveError) ?? {
                                name: 'Error',
                                message: String(effectiveError),
                            },
                        };
                settlement = {
                    ...result,
                    ...stateIdentity(state),
                };
            }
            try {
                await drainBoundaryCallsAndEmissions();
            }
            catch (error) {
                const primaryError = controlPlaneError;
                const effectiveError = primaryError ?? error;
                collectFailure(failures, effectiveError);
                const state = currentState();
                result = {
                    outcome: turn.signal.aborted && primaryError === undefined
                        ? 'aborted'
                        : 'failed',
                    state,
                    error: normalizeErrorFull(effectiveError) ?? {
                        name: 'Error',
                        message: String(effectiveError),
                    },
                };
                settlement = { ...result, ...stateIdentity(state) };
            }
            currentSignal = undefined;
            try {
                await emitTrace('boss.input.settled', settlement, { turnId });
            }
            catch (error) {
                collectFailure(failures, error);
            }
            try {
                await flush();
            }
            catch (error) {
                collectFailure(failures, error);
            }
            finally {
                const primaryError = controlPlaneError;
                currentTurnId = undefined;
                controlPlaneError = undefined;
                if (primaryError !== undefined)
                    throw primaryError;
            }
            if (failures.length === 1)
                throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(failures, 'decide runtime turn failed');
            }
            return result;
        },
        async resumePlaybookCall({ callId, result: childResult, signal, }) {
            if (disposalPromise !== undefined) {
                throw new Error('decide runtime: runtime is disposing or disposed');
            }
            requirePorts();
            if (!actor) {
                throw new Error('decide runtime: init(session) must be called before resumePlaybookCall');
            }
            if (currentSignal !== undefined) {
                throw new Error('decide runtime: another runtime turn is active');
            }
            currentTurnId = playbookCallTurnIds.get(callId);
            currentSignal = signal;
            controlPlaneError = undefined;
            let runResult;
            let operationError;
            try {
                await nestedBridge.resume({
                    callId,
                    result: childResult,
                    signal,
                });
            }
            catch (error) {
                operationError = error;
            }
            try {
                await waitForPlaybookQuiescence(actor, {
                    pendingCalls: nestedBridge,
                });
                runResult = resultForSnapshot(signal);
            }
            catch (error) {
                operationError ??= error;
            }
            let drainError;
            try {
                await drainBoundaryCallsAndEmissions();
            }
            catch (error) {
                drainError = error;
            }
            const failure = controlPlaneError ?? drainError ?? operationError;
            currentSignal = undefined;
            currentTurnId = undefined;
            controlPlaneError = undefined;
            if (failure !== undefined)
                throw failure;
            if (runResult === undefined) {
                throw new Error('decide runtime: playbook resume produced no result');
            }
            return runResult;
        },
        dispose() {
            if (disposalPromise !== undefined)
                return disposalPromise;
            if (currentSignal !== undefined) {
                return Promise.reject(new Error('decide runtime: cannot dispose while a runtime turn is active'));
            }
            disposalPromise = (async () => {
                const initialization = initInFlight;
                if (initialization)
                    await initialization;
                if (!sessionIdentity || disposed) {
                    disposed = true;
                    return;
                }
                const finalState = currentState();
                const failures = [];
                stopActor();
                try {
                    await nestedBridge.dispose();
                }
                catch (error) {
                    collectFailure(failures, error);
                }
                try {
                    await drainBoundaryCallsAndEmissions();
                }
                catch (error) {
                    collectFailure(failures, error);
                }
                try {
                    await emitTrace('session.disposed', {
                        state: finalState,
                        ...stateIdentity(finalState),
                    });
                }
                catch (error) {
                    collectFailure(failures, error);
                }
                try {
                    await flush();
                }
                catch (error) {
                    collectFailure(failures, error);
                }
                finally {
                    playerResumeTokens.clear();
                    playbookCallTurnIds.clear();
                    inFlightPlayerIds.clear();
                    activeBoundaryCalls.clear();
                    activeEmissionCalls.clear();
                    emissionQueue.clear();
                    judgeQueue.clear();
                    actor = undefined;
                    currentSignal = undefined;
                    currentTurnId = undefined;
                    ports = undefined;
                    sessionIdentity = undefined;
                    previousState = undefined;
                    controlPlaneError = undefined;
                    disposed = true;
                }
                if (failures.length === 1)
                    throw failures[0];
                if (failures.length > 1) {
                    throw new AggregateError(failures, 'decide runtime disposal failed');
                }
            })();
            return disposalPromise;
        },
    };
};
export const _internal = {
    composePlayerPrompt,
    resolvePlayerId,
    requiredFieldsFor,
    extractJson,
    buildClassifierPrompt,
    parseClassification,
    buildAdjudicatorPrompt,
    parseAdjudication,
    combineSignals,
    pendingQuestionsFromContext,
    normalizeErrorCompact,
    normalizeErrorFull,
    DEFAULT_PLAYER_BINDING,
    STATE_DESCRIPTIONS,
    PLAYER_STATES,
    PLAYER_STATE_IDS,
    VERBATIM_PAYLOAD_FIELDS,
    BOSS_INTERRUPT_TARGETS,
    CONTINUATION_PREAMBLE,
    TELEMETRY_TOPIC,
};
export default createPlaybookRuntime;
