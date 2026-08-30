// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// PlaybookRuntime for the decide playbook, linked from the FSM artifact by
// the slc FSM-to-runtime link phase.
//
// Linker inputs:
//   FSM artifact:       ./decide.fsm.ts
//   Link target:        @sublang/playbook/runtime
//   Role binding:       canonical coder and reviewer roles; concrete players
//                       and prompt identities are supplied by the host session
//   Adjudication:       LLM-judge per state (default)
//   Boss-event mapping: free-text judge classification (default)
//   Abort strategy:     natural rejection; every player-invoking state's
//                       onError routes to the quiescent failed state.
//   Output profile:     bespoke parallel runtime with the shared nested-call
//                       bridge (slc/link.md §Output)
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import { createAcceptedOutcomeConsumer, } from '../../../src/accepted-outcome.js';
import { assertJsonSafe, assertPlaybookEffectLedger, assertPlaybookRuntimeSnapshot, combineAbortSignals, createNestedPlaybookBridge, detachPersistedMachineSnapshot, normalizeError, normalizePlaybookSnapshot, PlaybookSemanticCandidateStructureError, reconcilePlaybookSemanticEvidence, snapshotJsonValue, snapshotPlaybookSession, validatePlayerResult, waitForPlaybookQuiescence, } from '../../../src/xstate-runtime.js';
import decideMachine from './decide.fsm.js';
function snapshotDecideRuntimeOptions(value) {
    const captured = snapshotJsonValue(value, 'DECIDE runtime options');
    if (!isPlainObject(captured)) {
        throw new TypeError('DECIDE runtime options must be an object');
    }
    const [unknown] = Object.keys(captured);
    if (unknown !== undefined) {
        throw new TypeError(`DECIDE runtime options.${unknown} is not declared`);
    }
    return Object.freeze({});
}
function authoredStateDescriptions(states) {
    const descriptions = {};
    const visit = (children) => {
        for (const state of Object.values(children ?? {})) {
            const stateId = state.meta?.playbook?.stateId;
            const description = state.meta?.playbook?.description;
            if (typeof stateId === 'string' &&
                typeof description === 'string' &&
                description.trim().length > 0) {
                const existing = descriptions[stateId];
                if (existing !== undefined && existing !== description) {
                    throw new Error(`DECIDE state ${stateId} declares conflicting descriptions`);
                }
                descriptions[stateId] = description;
            }
            visit(state.states);
        }
    };
    visit(states);
    return Object.freeze(descriptions);
}
const STATE_DESCRIPTIONS = authoredStateDescriptions(decideMachine.config.states);
const ROLE_STATES = [
    { stateId: 'askCoderProposal', role: 'coder', sourceItem: 'DECIDE-1' },
    {
        stateId: 'askReviewerProposal',
        role: 'reviewer',
        sourceItem: 'DECIDE-2',
    },
    { stateId: 'commitCoderProposal', role: 'coder', sourceItem: 'DECIDE-3' },
];
const ROLE_STATE_IDS = new Set(ROLE_STATES.map((state) => state.stateId));
const ACCEPTED_OUTCOME_DECLARATIONS = Object.freeze({
    askCoderProposal: new Set(['proposed', 'needsBossReply']),
    askReviewerProposal: new Set(['proposed', 'needsBossReply']),
    commitCoderProposal: new Set(['committed', 'needsBossReply']),
});
const DECIDE_OUTCOME_AUTHORITY = Object.freeze({
    governedPlayerStates: Object.freeze({
        askCoderProposal: Object.freeze({
            proposed: Object.freeze({
                fields: Object.freeze({ coderProposal: 'presentation' }),
                repositoryDisposition: 'unchanged',
            }),
            needsBossReply: Object.freeze({
                fields: Object.freeze({ question: 'presentation' }),
                repositoryDisposition: 'unchanged',
            }),
        }),
        askReviewerProposal: Object.freeze({
            proposed: Object.freeze({
                fields: Object.freeze({ reviewerProposal: 'presentation' }),
                repositoryDisposition: 'unchanged',
            }),
            needsBossReply: Object.freeze({
                fields: Object.freeze({ question: 'presentation' }),
                repositoryDisposition: 'unchanged',
            }),
        }),
        commitCoderProposal: Object.freeze({
            committed: Object.freeze({
                fields: Object.freeze({
                    coderOutput: 'presentation',
                    latestCommit: 'effect',
                }),
                repositoryDisposition: 'one-descendant-commit',
            }),
            needsBossReply: Object.freeze({
                fields: Object.freeze({ question: 'presentation' }),
                repositoryDisposition: 'deferred',
            }),
        }),
    }),
});
const PROPOSAL_STATE_BY_ROLE = Object.freeze({
    coder: 'askCoderProposal',
    reviewer: 'askReviewerProposal',
});
const ROLE_IDS = ['coder', 'reviewer'];
const ROLE_ID_SET = new Set(ROLE_IDS);
const roleLabel = (roleId) => roleId === 'coder' ? 'Coder' : 'Reviewer';
const BOSS_INTERRUPT_TARGETS = ['independentProposals'];
const BOSS_INTERRUPT_TARGET_IDS = new Set(BOSS_INTERRUPT_TARGETS);
const UNFINISHED_FINAL_STATE_IDS = new Set([
    'reportedReviewFailure',
]);
const TELEMETRY_TOPIC = 'playbook.fsm.state';
const TRACE_TOPIC = 'playbook.trace';
const UNRESOLVED_EFFECT_RECONCILIATION_ACTION_ID = 'reconcile:unresolved-effect';
const UNRESOLVED_EFFECT_ABANDONMENT_ACTION_ID = 'abandon:unresolved-effect';
const CONTINUATION_PREAMBLE = 'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';
const PLACEHOLDER_FIELDS = [['<caller-topic>', 'callerTopic']];
const VERBATIM_PAYLOAD_FIELDS = new Set([
    'coderProposal',
    'reviewerProposal',
    'coderOutput',
]);
function composePlayerPrompt(input, promptIdentity) {
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
    if (input.prompt.includes('<coder-llm>')) {
        replacements.set('<coder-llm>', promptIdentity('coder'));
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
function governedOutcomesFor(input) {
    const outcomes = DECIDE_OUTCOME_AUTHORITY.governedPlayerStates[input.stateId];
    if (outcomes === undefined) {
        throw new TypeError(`DECIDE governed player state ${JSON.stringify(input.stateId)} has no outcome authority`);
    }
    const declaredGuards = Object.keys(outcomes).sort();
    const authoredGuards = Object.keys(input.result).sort();
    if (declaredGuards.length !== authoredGuards.length ||
        declaredGuards.some((guard, index) => guard !== authoredGuards[index])) {
        throw new TypeError(`DECIDE governed player state ${input.stateId} changed its authored outcome set`);
    }
    for (const guard of declaredGuards) {
        const required = requiredFieldsFor(input.result[guard]).sort();
        const authoritative = Object.keys(outcomes[guard].fields).sort();
        if (required.length !== authoritative.length ||
            required.some((field, index) => field !== authoritative[index])) {
            throw new TypeError(`DECIDE governed outcome ${input.stateId}.${guard} changed its payload fields`);
        }
    }
    return outcomes;
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
function sortJson(value) {
    if (Array.isArray(value))
        return value.map((entry) => sortJson(entry));
    if (value !== null && typeof value === 'object') {
        const record = value;
        const sorted = {};
        for (const key of Object.keys(record).sort()) {
            sorted[key] = sortJson(record[key]);
        }
        return sorted;
    }
    return value;
}
function stableJson(value, path) {
    return JSON.stringify(sortJson(snapshotJsonValue(value, path)));
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const member of Object.values(value))
            deepFreeze(member);
    }
    return value;
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
            lines.push(`- ${pending.questionId} (${pending.asker.roleId}): ${pending.question}`);
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
function buildAdjudicatorPrompt(input, playerOutput, correction) {
    const outcomes = governedOutcomesFor(input);
    const lines = [];
    lines.push('You are the guard adjudicator for a playbook state machine.');
    lines.push('This is hidden control work. Do not call tools, inspect files, or ' +
        'seek external evidence. Decide only from the supplied player output ' +
        'and guard descriptions. Reply with exactly one JSON object and no prose.');
    lines.push(`The role "${roleLabel(input.role)}" produced the output below for source item ${input.sourceItem}.`);
    lines.push('Choose exactly one guard whose description matches that output.');
    lines.push('');
    lines.push('Player output (verbatim):');
    lines.push('"""');
    lines.push(playerOutput);
    lines.push('"""');
    lines.push('');
    lines.push('Guards (choose exactly one; the descriptions are authoritative and must be applied as written):');
    for (const [guard, description] of Object.entries(input.result)) {
        const semanticFields = Object.entries(outcomes[guard]?.fields ?? {})
            .filter(([, authority]) => authority === 'semantic')
            .map(([field]) => field);
        lines.push(`- ${guard}: semantic fields: ${semanticFields.length === 0 ? '(none)' : semanticFields.join(', ')}; ${description}`);
    }
    lines.push('');
    lines.push('Reply with exactly the chosen `guard` and every semantic-owned field for that guard, and no other field.');
    lines.push('Do not include presentation-, effect-, or runtime-owned fields; the runtime supplies those from authoritative evidence.');
    if (correction !== undefined) {
        lines.push('');
        lines.push('Your first reply was structurally invalid:');
        lines.push('"""');
        lines.push(correction.reply);
        lines.push('"""');
        lines.push(`Validation error: ${correction.error}`);
        lines.push('Correct only that structure using the same player output and outcome schema.');
    }
    return lines.join('\n');
}
function parseGovernedSemanticCandidate(raw) {
    try {
        return parseJudgeJson(raw);
    }
    catch (error) {
        throw new PlaybookSemanticCandidateStructureError(error instanceof Error ? error.message : 'reply is not valid JSON');
    }
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
function schema3Construction(value) {
    if (!isPlainObject(value)) {
        throw new TypeError('DECIDE schema-3 factory input must be a plain object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 ||
        !keys.includes('configuredOptions') ||
        !keys.includes('hostCapabilities') ||
        keys.some((key) => {
            const descriptor = descriptors[key];
            return (descriptor?.get !== undefined ||
                descriptor?.set !== undefined ||
                descriptor?.enumerable !== true ||
                !Object.prototype.hasOwnProperty.call(descriptor, 'value'));
        })) {
        throw new TypeError('DECIDE schema-3 factory input must contain exactly configuredOptions and hostCapabilities data properties');
    }
    const configuredOptions = descriptors.configuredOptions.value;
    if (configuredOptions !== null &&
        typeof configuredOptions === 'object' &&
        Object.prototype.hasOwnProperty.call(configuredOptions, 'hostCapabilities')) {
        throw new TypeError('DECIDE configured options must not contain hostCapabilities');
    }
    const hostCapabilities = descriptors.hostCapabilities.value;
    if (hostCapabilities === null ||
        typeof hostCapabilities !== 'object' ||
        Array.isArray(hostCapabilities)) {
        throw new TypeError('DECIDE schema-3 factory input hostCapabilities must be a live object');
    }
    const repositoryDescriptor = Object.getOwnPropertyDescriptor(hostCapabilities, 'repository');
    const authorityDescriptor = Object.getOwnPropertyDescriptor(hostCapabilities, 'authority');
    const effectLedgerDescriptor = Object.getOwnPropertyDescriptor(hostCapabilities, 'effectLedger');
    const repository = repositoryDescriptor?.value;
    const authority = authorityDescriptor?.value;
    const effectLedger = effectLedgerDescriptor?.value;
    if (authorityDescriptor === undefined ||
        authorityDescriptor.get !== undefined ||
        authorityDescriptor.set !== undefined ||
        !Object.prototype.hasOwnProperty.call(authorityDescriptor, 'value') ||
        !isPlainObject(authority) ||
        authority.artifactSchema !== 3 ||
        authority.playbookId !== 'decide' ||
        typeof authority.sessionId !== 'string' ||
        authority.sessionId.length === 0 ||
        !Array.isArray(authority.requiredRoleIds) ||
        stableJson([...authority.requiredRoleIds].sort(), 'DECIDE host authority required roles') !== stableJson([...ROLE_IDS].sort(), 'DECIDE required roles') ||
        !Array.isArray(authority.concurrentRoleSets) ||
        authority.concurrentRoleSets.length !== 1 ||
        !Array.isArray(authority.concurrentRoleSets[0]) ||
        stableJson([...authority.concurrentRoleSets[0]].sort(), 'DECIDE host authority concurrent roles') !== stableJson([...ROLE_IDS].sort(), 'DECIDE concurrent roles')) {
        throw new TypeError('DECIDE schema-3 factory input hostCapabilities.authority must identify one schema-3 playbook session');
    }
    if (repositoryDescriptor === undefined ||
        repositoryDescriptor.get !== undefined ||
        repositoryDescriptor.set !== undefined ||
        !Object.prototype.hasOwnProperty.call(repositoryDescriptor, 'value') ||
        !isPlainObject(repository) ||
        typeof repository.runExclusive !== 'function' ||
        typeof repository.runCohort !== 'function' ||
        typeof repository.runDeferred !== 'function') {
        throw new TypeError('DECIDE schema-3 factory input hostCapabilities.repository must expose runExclusive, runCohort, and runDeferred functions');
    }
    if (effectLedgerDescriptor === undefined ||
        effectLedgerDescriptor.get !== undefined ||
        effectLedgerDescriptor.set !== undefined ||
        !Object.prototype.hasOwnProperty.call(effectLedgerDescriptor, 'value') ||
        !isPlainObject(effectLedger) ||
        typeof effectLedger.snapshot !== 'function' ||
        typeof effectLedger.writeAhead !== 'function') {
        throw new TypeError('DECIDE schema-3 factory input hostCapabilities.effectLedger must expose snapshot and writeAhead functions');
    }
    return {
        configuredOptions: configuredOptions,
        hostCapabilities: {
            authority: authority,
            repository: repository,
            effectLedger: effectLedger,
        },
    };
}
function deferredValue() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}
function hasCompleteUnchangedReceipt(boundary) {
    return boundary.physicalReceipt?.classification === 'unchanged';
}
// A schema-3 corrective call is bound to the exact physical boundary it would
// repeat.
// A failed-state restart replays the whole entry event. Cooperative host
// attempts are serialized in ledger order, so the latest durable boundary
// identifies the causal host attempt even when a nested or sibling runtime
// wrote it; every boundary in that attempt must have a complete unchanged
// receipt.
// The durable ledger remains the authority in both cases; no process-local
// player result or presentation text can make a replay safe.
function createAutomaticReplayPolicy(artifactSchema, evidence) {
    if (artifactSchema === 2) {
        return Object.freeze({
            allowsEmptyOkCorrection: () => true,
            allowsFailureStateRetry: () => true,
        });
    }
    if (evidence === undefined) {
        throw new TypeError('DECIDE schema-3 automatic replay requires durable effect-ledger evidence');
    }
    const readLedger = () => assertPlaybookEffectLedger(evidence.effectLedger.snapshot(), 'DECIDE automatic-replay effect ledger');
    return Object.freeze({
        allowsEmptyOkCorrection(runtimeSessionId, callId) {
            const matching = readLedger().boundaries.filter((boundary) => boundary.runtimeSessionId === runtimeSessionId &&
                boundary.callId === callId);
            return (matching.length === 1 && hasCompleteUnchangedReceipt(matching[0]));
        },
        allowsFailureStateRetry() {
            const ledger = readLedger();
            const latest = ledger.boundaries.at(-1);
            if (latest === undefined)
                return false;
            const attempt = ledger.boundaries.filter((boundary) => boundary.attemptId === latest.attemptId);
            return (attempt.length > 0 && attempt.every(hasCompleteUnchangedReceipt));
        },
    });
}
function isAbortFailure(error, signal) {
    return signal.aborted && Object.is(error, signal.reason);
}
function abortReasonClassifier(...sources) {
    const captured = sources.filter((source) => source !== undefined);
    return Object.freeze({
        isAbortReason: (error) => captured.some((source) => source instanceof AbortSignal
            ? isAbortFailure(error, source)
            : source.isAbortReason(error)),
    });
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
            isPlainObject(obj.asker) &&
            obj.asker.kind === 'role' &&
            ROLE_ID_SET.has(String(obj.asker.roleId)) &&
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
    ...ROLE_STATE_IDS,
    ...WAIT_STATE_IDS,
    'failed',
]);
// PBRT-45: a question is pending only while its authored reply-wait state
// is active. The context retains an answered question through the resumed
// player call so the Q+A continuation prompt can quote it, and each branch
// keeps its own entry through the parallel region — so an unfiltered
// projection would report the answered question as still awaiting during
// the resume, and both branch questions after only one remains pending.
const RESUME_WAIT_STATE_IDS = {
    ...Object.fromEntries(Object.entries(WAIT_STATE_RESUME_IDS).map(([waitStateId, resumeStateId]) => [
        resumeStateId,
        waitStateId,
    ])),
    commitCoderProposal: 'awaitBossReply',
};
function pendingQuestionsForState(state, context) {
    return pendingQuestionsFromContext(context).filter((pending) => state.activeStateIds.includes(RESUME_WAIT_STATE_IDS[pending.resumeStateId] ?? ''));
}
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
function telemetryPayload(previousState, state, event, context, hiddenQuestionId) {
    const pendingBossQuestions = pendingQuestionsForState(state, context).filter(({ questionId }) => questionId !== hiddenQuestionId);
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
function createDecidePlaybookRuntime(options, deferredEffects) {
    const artifactSchema = 3;
    const automaticReplayPolicy = createAutomaticReplayPolicy(artifactSchema, deferredEffects);
    const fsmInput = snapshotDecideRuntimeOptions(options);
    const readEffectLedger = () => assertPlaybookEffectLedger(deferredEffects.effectLedger.snapshot(), 'DECIDE current host effect ledger');
    let effectLedgerMirror = readEffectLedger();
    const acceptedOutcomeConsumer = createAcceptedOutcomeConsumer(artifactSchema, (source, acceptedOutcome) => Object.prototype.hasOwnProperty.call(ACCEPTED_OUTCOME_DECLARATIONS, source) &&
        ACCEPTED_OUTCOME_DECLARATIONS[source]?.has(acceptedOutcome) === true);
    let ports;
    let sessionIdentity;
    let actor;
    let currentSignal;
    let currentAborts;
    const actorSettlementAborts = [];
    let actorSettlementErrorAborts;
    let currentTurnId;
    let previousState;
    let suppressInspectionEmissions = false;
    let emissionFailures = [];
    let traceSequence = 0;
    let turnSequence = 0;
    let judgeCallSequence = 0;
    let playerCallSequence = 0;
    let playbookCallSequence = 0;
    let applyCallSequence = 0;
    let lifecycleStarted = false;
    let initInFlight;
    let disposed = false;
    let disposalPromise;
    let controlPlaneError;
    let nestedBridge;
    const privateResumeTokens = new Map();
    const playbookCallTurnIds = new Map();
    const inFlightPlayerKeys = new Set();
    const activeBoundaryCalls = new Set();
    const activeEmissionCalls = new Set();
    const emissionQueue = new PQueue({ concurrency: 1 });
    const judgeQueue = new PQueue({ concurrency: 1 });
    // A proposal cohort completes both semantic callbacks concurrently at the
    // repository seam. Serialize each whole adjudication/correction transaction
    // so their durable correction-budget compare-and-swaps cannot race.
    const semanticCompletionQueue = new PQueue({ concurrency: 1 });
    const governedOutputsByBoundaryId = new Map();
    const governedFailuresByBoundaryId = new Map();
    const governedEvidenceByBoundaryId = new Map();
    const governedReceiptsByBoundaryId = new Map();
    const governedPlayerOutputs = new WeakMap();
    const unresolvedSemanticBoundaryIds = new Set();
    const appliedControlReceipts = new Map();
    const pendingProposalCohort = new Map();
    let activeProposalCohort;
    let completedProposalCohortTurnId;
    let deferredOperationId;
    let hiddenDeferredOperationId;
    let activeDeferredContinuation;
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
    const latchInspectionError = (error, aborts = currentAborts) => {
        if (aborts?.isAbortReason(error))
            return;
        if (currentSignal !== undefined)
            controlPlaneError ??= error;
        else
            collectFailure(emissionFailures, error);
    };
    const enqueue = (fn, aborts = currentAborts) => {
        const enqueueAborts = aborts;
        const queued = emissionQueue.add(fn);
        activeEmissionCalls.add(queued);
        void queued.then(() => activeEmissionCalls.delete(queued), (error) => {
            activeEmissionCalls.delete(queued);
            if (!enqueueAborts?.isAbortReason(error)) {
                collectFailure(emissionFailures, error);
            }
        });
        return queued;
    };
    const flush = async (_aborts = currentAborts) => {
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
        const failure = failures.length === 1
            ? failures[0]
            : new AggregateError(failures, 'decide runtime emissions failed');
        // Enqueue ownership already classified every stored failure as distinct.
        // Preserve that classification if an unrelated public boundary drains
        // it with a signal whose reason happens to be the same object.
        if (currentSignal !== undefined)
            controlPlaneError ??= failure;
        throw failure;
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
    const bindSession = (nextSession) => {
        const bound = snapshotPlaybookSession(nextSession);
        if (bound.playbookId !== deferredEffects.authority.playbookId ||
            bound.sessionId !== deferredEffects.authority.sessionId) {
            throw new TypeError('DECIDE runtime session identity must match its bound schema-3 host authority');
        }
        if (bound.roleBindings === undefined)
            return bound;
        const actual = Object.keys(bound.roleBindings).sort();
        const expected = [...ROLE_IDS].sort();
        const missing = expected.filter((roleId) => !actual.includes(roleId));
        const extra = actual.filter((roleId) => !ROLE_ID_SET.has(roleId));
        if (missing.length > 0 || extra.length > 0) {
            throw new TypeError(`DECIDE session roleBindings must cover exactly [${expected.join(', ')}]` +
                `${missing.length === 0 ? '' : `; missing [${missing.join(', ')}]`}` +
                `${extra.length === 0 ? '' : `; extra [${extra.join(', ')}]`}`);
        }
        return bound;
    };
    const resolvedPlayerId = (roleId) => requireSessionIdentity().roleBindings?.[roleId]?.playerId;
    const promptIdentity = (roleId) => requireSessionIdentity().roleBindings?.[roleId]?.promptIdentity ?? roleId;
    const composeInvocationPrompt = (input) => {
        let active = true;
        const lookup = (roleId) => {
            if (!active) {
                throw new Error('DECIDE prompt identity lookup is no longer active for this invocation');
            }
            if (!ROLE_ID_SET.has(roleId)) {
                throw new TypeError(`DECIDE prompt identity lookup rejected undeclared role ${String(roleId)}`);
            }
            return promptIdentity(roleId);
        };
        try {
            return composePlayerPrompt(input, lookup);
        }
        finally {
            active = false;
        }
    };
    const continuationKey = (roleId, playerId) => playerId ?? roleId;
    const tokensByContinuationKey = (tokens) => {
        const byKey = new Map();
        for (const [roleId, token] of Object.entries(tokens)) {
            if (!ROLE_ID_SET.has(roleId)) {
                throw new TypeError(`DECIDE role tokens contain unknown role ${roleId}`);
            }
            const typedRole = roleId;
            const key = continuationKey(typedRole, resolvedPlayerId(typedRole));
            const prior = byKey.get(key);
            if (prior !== undefined && prior !== token) {
                throw new TypeError(`DECIDE runtime snapshot assigns conflicting tokens to roles bound to player ${key}`);
            }
            byKey.set(key, token);
        }
        const rolesByKey = new Map();
        for (const roleId of ROLE_IDS) {
            const key = continuationKey(roleId, resolvedPlayerId(roleId));
            rolesByKey.set(key, [...(rolesByKey.get(key) ?? []), roleId]);
        }
        for (const [key, roles] of rolesByKey) {
            if (roles.length < 2)
                continue;
            const present = roles.filter((roleId) => tokens[roleId] !== undefined);
            if (present.length !== 0 && present.length !== roles.length) {
                throw new TypeError(`DECIDE role tokens must project player ${key} through every aliased role [${roles.join(', ')}]`);
            }
        }
        return byKey;
    };
    const selectPlayerResume = (roleId, playerId) => {
        const session = requireSessionIdentity();
        const selected = session.playerSessions
            ? session.playerSessions.select(roleId)
            : privateResumeTokens.get(continuationKey(roleId, playerId)) ?? false;
        if (selected !== false &&
            (typeof selected !== 'string' || selected.trim().length === 0)) {
            throw new TypeError(`player session store returned an invalid resume token for role ${roleId}`);
        }
        return selected;
    };
    const updatePlayerResume = (roleId, playerId, result) => {
        if (result.resumeToken === undefined && result.status !== 'ok')
            return;
        const session = requireSessionIdentity();
        if (session.playerSessions) {
            session.playerSessions.update(roleId, result.resumeToken);
        }
        else if (result.resumeToken !== undefined) {
            privateResumeTokens.set(continuationKey(roleId, playerId), result.resumeToken);
        }
        else {
            privateResumeTokens.delete(continuationKey(roleId, playerId));
        }
    };
    const snapshotRoleResumeTokens = () => {
        const session = requireSessionIdentity();
        const captured = snapshotJsonValue(session.playerSessions
            ? session.playerSessions.snapshot()
            : Object.fromEntries(ROLE_IDS.flatMap((roleId) => {
                const token = privateResumeTokens.get(continuationKey(roleId, resolvedPlayerId(roleId)));
                return token === undefined ? [] : [[roleId, token]];
            })), 'player session store snapshot');
        if (!isPlainObject(captured)) {
            throw new TypeError('player session store snapshot must be an object');
        }
        const tokens = {};
        for (const [roleId, token] of Object.entries(captured)) {
            if (!ROLE_ID_SET.has(roleId)) {
                throw new TypeError(`player session store snapshot contains unknown role ${roleId}`);
            }
            if (typeof token !== 'string' || token.trim().length === 0) {
                throw new TypeError(`player session store snapshot token for ${roleId} must be a non-empty string`);
            }
            tokens[roleId] = token;
        }
        tokensByContinuationKey(tokens);
        return tokens;
    };
    const restoreRoleResumeTokens = (tokens) => {
        const byKey = tokensByContinuationKey(tokens);
        const session = requireSessionIdentity();
        if (session.playerSessions) {
            session.playerSessions.restore(tokens);
            return;
        }
        privateResumeTokens.clear();
        for (const [key, token] of byKey)
            privateResumeTokens.set(key, token);
    };
    const currentState = (pendingCall = nestedBridge.getPendingCall()) => {
        const live = actor;
        if (!live) {
            throw new Error('decide runtime: actor is not initialized');
        }
        return normalizePlaybookSnapshot(live.getSnapshot(), {
            pendingCall,
        });
    };
    const visiblePendingQuestionsForState = (state, context) => pendingQuestionsForState(state, context).filter(({ questionId }) => questionId !== 'commitCoderProposal' ||
        hiddenDeferredOperationId === undefined);
    const openDeferredOperation = (ledger = effectLedgerMirror) => {
        if (sessionIdentity === undefined)
            return undefined;
        const open = ledger.logicalOperations.filter((operation) => operation.playbookId === sessionIdentity.playbookId &&
            operation.runtimeSessionId === sessionIdentity.sessionId &&
            operation.logicalReceipt === undefined);
        if (open.length > 1) {
            throw new TypeError('DECIDE runtime has multiple open deferred logical operations');
        }
        return open[0];
    };
    const runtimeBoundaryIsOwned = (boundary) => sessionIdentity !== undefined &&
        boundary.playbookId === sessionIdentity.playbookId &&
        boundary.runtimeSessionId === sessionIdentity.sessionId;
    const governedOutcomesForBoundary = (boundary) => {
        const outcomes = DECIDE_OUTCOME_AUTHORITY.governedPlayerStates[boundary.sourceStateId];
        if (outcomes === undefined ||
            !isPlainObject(boundary.sourceOutcomeSchema)) {
            return undefined;
        }
        const authoredGuards = Object.keys(boundary.sourceOutcomeSchema).sort();
        const governedGuards = Object.keys(outcomes).sort();
        if (authoredGuards.length !== governedGuards.length ||
            authoredGuards.some((guard, index) => guard !== governedGuards[index])) {
            return undefined;
        }
        for (const guard of governedGuards) {
            const description = boundary.sourceOutcomeSchema[guard];
            if (typeof description !== 'string')
                return undefined;
            const authoredFields = [
                ...new Set(requiredFieldsFor(description)),
            ].sort();
            const governedFields = Object.keys(outcomes[guard].fields).sort();
            if (authoredFields.length !== governedFields.length ||
                authoredFields.some((field, index) => field !== governedFields[index])) {
                return undefined;
            }
        }
        const dispositions = [
            ...new Set(Object.values(outcomes).map(({ repositoryDisposition }) => repositoryDisposition)),
        ];
        const actualDispositions = new Set(boundary.dispositions);
        return actualDispositions.size === boundary.dispositions.length &&
            actualDispositions.size === dispositions.length &&
            dispositions.every((disposition) => actualDispositions.has(disposition))
            ? outcomes
            : undefined;
    };
    const persistedBoundaryReconciliation = (boundary, ledger) => {
        const outcomes = governedOutcomesForBoundary(boundary);
        if (outcomes === undefined || boundary.semanticCandidate === undefined) {
            return undefined;
        }
        let receipt = boundary.physicalReceipt;
        let awaitingLogicalReceipt = false;
        let historicalDeferred = false;
        const logicalOperation = boundary.logicalOperationId === undefined
            ? undefined
            : ledger.logicalOperations.find(({ operationId }) => operationId === boundary.logicalOperationId);
        if (boundary.logicalOperationId !== undefined &&
            logicalOperation === undefined) {
            return undefined;
        }
        if (logicalOperation !== undefined) {
            if (logicalOperation.boundaryIds.at(-1) !== boundary.boundaryId) {
                historicalDeferred = true;
            }
            else if (logicalOperation.logicalReceipt !== undefined) {
                receipt = logicalOperation.logicalReceipt;
            }
            else if (logicalOperation.pendingQuestion === undefined ||
                logicalOperation.checkpoint === undefined ||
                !Object.prototype.hasOwnProperty.call(logicalOperation, 'playerContinuation')) {
                return undefined;
            }
            else {
                awaitingLogicalReceipt = true;
            }
        }
        try {
            const reconciliation = reconcilePlaybookSemanticEvidence({
                outcomes,
                semanticCandidate: boundary.semanticCandidate,
                finalText: boundary.finalText,
                receipt,
            });
            if (awaitingLogicalReceipt && reconciliation.status !== 'deferred') {
                return undefined;
            }
            return { reconciliation, historicalDeferred };
        }
        catch {
            return undefined;
        }
    };
    const boundaryNeedsSemanticReconciliation = (boundary, ledger) => {
        if (!runtimeBoundaryIsOwned(boundary))
            return false;
        if (governedOutcomesForBoundary(boundary) === undefined)
            return true;
        const persisted = persistedBoundaryReconciliation(boundary, ledger);
        if (persisted !== undefined) {
            if (persisted.reconciliation.status === 'unresolved')
                return true;
            if (persisted.historicalDeferred) {
                return persisted.reconciliation.status !== 'deferred';
            }
            if (persisted.reconciliation.status === 'deferred' &&
                boundary.logicalOperationId === undefined) {
                return true;
            }
            return false;
        }
        if (boundary.physicalReceipt === undefined)
            return true;
        if (typeof boundary.finalText === 'string' &&
            boundary.finalText.trim().length > 0) {
            return true;
        }
        return boundary.physicalReceipt.classification !== 'unchanged';
    };
    const refreshUnresolvedSemanticReconciliation = (ledger = effectLedgerMirror) => {
        unresolvedSemanticBoundaryIds.clear();
        for (const boundary of ledger.boundaries) {
            if (boundaryNeedsSemanticReconciliation(boundary, ledger)) {
                unresolvedSemanticBoundaryIds.add(boundary.boundaryId);
            }
        }
    };
    const synchronizeDeferredProjection = (ledger = effectLedgerMirror) => {
        if (deferredEffects === undefined)
            return;
        effectLedgerMirror = ledger;
        refreshUnresolvedSemanticReconciliation(ledger);
        const operation = openDeferredOperation(ledger);
        if (operation === undefined) {
            deferredOperationId = undefined;
            hiddenDeferredOperationId = undefined;
            return;
        }
        deferredOperationId = operation.operationId;
        hiddenDeferredOperationId =
            operation.logicalReceipt === undefined &&
                (operation.checkpointRestorationEligible ||
                    operation.pendingQuestion === undefined)
                ? operation.operationId
                : undefined;
    };
    const hasUnresolvedReconciliation = () => hiddenDeferredOperationId !== undefined ||
        unresolvedSemanticBoundaryIds.size > 0;
    const refreshReconciliationProjection = () => {
        synchronizeDeferredProjection(readEffectLedger());
    };
    const unresolvedEffectEnvelopeIdentities = () => {
        if (sessionIdentity === undefined)
            return [];
        refreshReconciliationProjection();
        if (!hasUnresolvedReconciliation())
            return [];
        const boundaryIds = new Set(unresolvedSemanticBoundaryIds);
        const operationIds = new Set();
        if (hiddenDeferredOperationId !== undefined) {
            operationIds.add(hiddenDeferredOperationId);
        }
        for (const boundaryId of [...boundaryIds]) {
            const boundary = effectLedgerMirror.boundaries.find((candidate) => candidate.boundaryId === boundaryId);
            const operation = boundary?.logicalOperationId === undefined
                ? undefined
                : effectLedgerMirror.logicalOperations.find(({ operationId }) => operationId === boundary.logicalOperationId);
            if (operation === undefined)
                continue;
            operationIds.add(operation.operationId);
            for (const memberId of operation.boundaryIds) {
                boundaryIds.delete(memberId);
            }
        }
        const ordered = [
            ...[...boundaryIds].map((boundaryId) => ({
                order: effectLedgerMirror.boundaries.find((candidate) => candidate.boundaryId === boundaryId)?.sequence ?? Number.MAX_SAFE_INTEGER,
                value: { kind: 'boundary', boundaryId },
            })),
            ...[...operationIds].map((operationId) => {
                const operation = effectLedgerMirror.logicalOperations.find((candidate) => candidate.operationId === operationId);
                return {
                    order: effectLedgerMirror.boundaries.find(({ boundaryId }) => boundaryId === operation?.boundaryIds[0])?.sequence ?? Number.MAX_SAFE_INTEGER,
                    value: { kind: 'logical-operation', operationId },
                };
            }),
        ].sort((left, right) => left.order - right.order);
        return deepFreeze(snapshotJsonValue(ordered.map(({ value }) => value), 'DECIDE unresolved effect envelope identities'));
    };
    const stateIdentity = (state) => {
        return state.stateId === undefined ? {} : { stateId: state.stateId };
    };
    const enqueueTracedEmission = (type, payload, meta = {}, describedEmission, aborts) => {
        const trace = createTraceEvent(type, payload, meta);
        return enqueue(async () => {
            const runtimePorts = requirePorts();
            await runtimePorts.emitTelemetry({ topic: TRACE_TOPIC, payload: trace });
            await describedEmission?.(runtimePorts);
        }, aborts);
    };
    const createTraceEvent = (type, payload, meta = {}) => {
        const identity = requireSessionIdentity();
        const jsonPayload = snapshotJsonValue(payload, `trace ${type} payload`);
        return Object.freeze({
            schemaVersion: 4,
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
    };
    const emitTrace = (type, payload, meta = {}, aborts) => enqueueTracedEmission(type, payload, meta, undefined, aborts);
    const enqueueAcceptedOutcomeEmission = (acceptedOutcome, state, aborts) => {
        const message = `→ ${acceptedOutcome.acceptedOutcome}`;
        const acceptedTrace = createTraceEvent('outcome.accepted', acceptedOutcome, { turnId: currentTurnId });
        const statusTrace = createTraceEvent('status.emitted', { stateId: acceptedOutcome.target, message, state }, { turnId: currentTurnId });
        return enqueue(async () => {
            const runtimePorts = requirePorts();
            await runtimePorts.emitTelemetry({
                topic: TRACE_TOPIC,
                payload: acceptedTrace,
            });
            await runtimePorts.emitTelemetry({
                topic: TRACE_TOPIC,
                payload: statusTrace,
            });
            await runtimePorts.emitStatus(message);
        }, aborts);
    };
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
        const aborts = abortReasonClassifier(signal);
        try {
            await emitTrace(startedType, identity, meta, aborts);
        }
        catch (error) {
            latchControlPlaneError(error, signal);
            try {
                await emitTrace(finishedType, {
                    ...identity,
                    // A started-trace sink rejection causally identical to the
                    // boundary reason is the abort's own evidence: the pair
                    // finishes 'aborted', not 'error' (DR-036 §4).
                    status: isAbortFailure(error, signal) ? 'aborted' : 'error',
                    error: normalizeErrorFull(error) ?? {
                        name: 'Error',
                        message: String(error),
                    },
                }, meta, aborts);
            }
            catch {
                // Preserve the start failure after one best-effort finish attempt.
            }
            throw error;
        }
    };
    const runJudgeCall = async (prompt, signal, purpose, callStateId) => {
        const aborts = abortReasonClassifier(signal);
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
                    // Only the exact abort reason is cancellation; a distinct
                    // failure under an aborted signal stays an error
                    // (slc/link.md §Abort).
                    status: isAbortFailure(error, signal) ? 'aborted' : 'error',
                    error: normalizeErrorFull(error) ?? {
                        name: 'Error',
                        message: String(error),
                    },
                }, { turnId: currentTurnId, callId }, aborts);
                throw error;
            }
            await emitTrace('judge.call.finished', { ...identity, status: 'ok', reply: finalText }, { turnId: currentTurnId, callId }, aborts);
            return finalText;
        });
        if (queued === undefined) {
            throw new Error('judge call completed without a reply');
        }
        return queued;
    };
    const callJudge = (prompt, signal, purpose, callStateId) => trackBoundaryCall(runJudgeCall(prompt, signal, purpose, callStateId));
    const runPlayerCall = async (input, signal, continuation) => {
        const aborts = abortReasonClassifier(signal);
        if (!ROLE_ID_SET.has(input.role)) {
            throw new TypeError(`DECIDE player input role must name a declared local role`);
        }
        const roleId = input.role;
        const playerId = resolvedPlayerId(roleId);
        const playerKey = continuationKey(roleId, playerId);
        const prompt = composeInvocationPrompt(input);
        let resume;
        try {
            signal.throwIfAborted();
            resume =
                continuation !== undefined &&
                    Object.prototype.hasOwnProperty.call(continuation, 'resume')
                    ? continuation.resume
                    : selectPlayerResume(roleId, playerId);
        }
        catch (error) {
            latchControlPlaneError(error, signal);
            throw error;
        }
        const callId = continuation?.callId ?? `player-${++playerCallSequence}`;
        const identity = {
            stateId: input.stateId,
            sourceItem: input.sourceItem,
            roleId,
            ...(playerId === undefined ? {} : { playerId }),
            resume,
        };
        const emitFailure = (error) => emitTrace('player.call.finished', {
            ...identity,
            // Only the exact abort reason is cancellation; a distinct
            // failure under an aborted signal stays an error
            // (slc/link.md §Abort).
            status: isAbortFailure(error, signal) ? 'aborted' : 'error',
            error: normalizeErrorFull(error) ?? {
                name: 'Error',
                message: String(error),
            },
        }, { turnId: currentTurnId, callId }, aborts);
        if (inFlightPlayerKeys.has(playerKey)) {
            const error = new Error(`resolved player key "${playerKey}" already has an in-flight call`);
            await emitCallStarted('player.call.started', 'player.call.finished', { ...identity, prompt }, { turnId: currentTurnId, callId }, signal);
            await emitFailure(error);
            throw error;
        }
        inFlightPlayerKeys.add(playerKey);
        try {
            await emitCallStarted('player.call.started', 'player.call.finished', { ...identity, prompt }, { turnId: currentTurnId, callId }, signal);
            let rawResult;
            try {
                signal.throwIfAborted();
                const boundary = Promise.resolve(requirePorts().callPlayer(roleId, prompt, signal, { resume }));
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
                updatePlayerResume(roleId, playerId, result);
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
            }, { turnId: currentTurnId, callId }, aborts);
            return {
                roleId,
                ...(playerId === undefined ? {} : { playerId }),
                callId,
                result,
            };
        }
        finally {
            inFlightPlayerKeys.delete(playerKey);
        }
    };
    const governedBoundarySeed = (input, callId) => {
        const outcomes = governedOutcomesFor(input);
        if (currentTurnId === undefined ||
            !Number.isSafeInteger(currentTurnId) ||
            currentTurnId <= 0) {
            throw new Error('DECIDE governed player call requires an active positive turn id');
        }
        return {
            boundaryId: randomUUID(),
            runtimeSessionId: requireSessionIdentity().sessionId,
            turnId: currentTurnId,
            callId,
            roleId: input.role,
            sourceStateId: input.stateId,
            sourceOutcomeSchema: snapshotJsonValue(input.result, 'DECIDE governed player source outcome schema'),
            dispositions: [
                ...new Set(Object.values(outcomes).map(({ repositoryDisposition }) => repositoryDisposition)),
            ],
            correctionBudget: { limit: 1, spent: false },
        };
    };
    const unresolvedGovernedEvidence = (boundaryId, reason, error) => {
        governedFailuresByBoundaryId.set(boundaryId, error instanceof Error
            ? error
            : new Error(`DECIDE governed outcome remains unresolved: ${reason}`));
    };
    const spendSemanticCorrectionBudget = async (boundary, receipt, finalText, semanticCandidate) => {
        const ledger = readEffectLedger();
        const current = ledger.boundaries.find(({ boundaryId }) => boundaryId === boundary.boundaryId);
        if (current === undefined ||
            current.correctionBudget.limit !== 1 ||
            current.correctionBudget.spent) {
            return false;
        }
        if (current.finalText !== undefined && current.finalText !== finalText) {
            throw new TypeError('DECIDE correction budget conflicts with retained finalText');
        }
        if (current.physicalReceipt !== undefined &&
            stableJson(current.physicalReceipt, 'DECIDE retained receipt') !==
                stableJson(receipt, 'DECIDE correction receipt')) {
            throw new TypeError('DECIDE correction budget conflicts with retained repository receipt');
        }
        if (semanticCandidate !== undefined &&
            current.semanticCandidate !== undefined &&
            stableJson(current.semanticCandidate, 'DECIDE retained candidate') !==
                stableJson(semanticCandidate, 'DECIDE correction candidate')) {
            throw new TypeError('DECIDE correction budget conflicts with retained semantic candidate');
        }
        const next = {
            ...current,
            ...(receipt.after === undefined ? {} : { after: receipt.after }),
            physicalReceipt: receipt,
            finalText,
            ...(semanticCandidate === undefined ? {} : { semanticCandidate }),
            correctionBudget: { limit: 1, spent: true },
        };
        const cohortMembers = current.cohortId === undefined
            ? [current]
            : ledger.boundaries.filter(({ cohortId }) => cohortId === current.cohortId);
        if (cohortMembers.length === 0) {
            throw new TypeError('DECIDE correction boundary lost its repository cohort');
        }
        const replacements = cohortMembers.map((member) => ({
            expected: member,
            next: member.boundaryId === current.boundaryId
                ? next
                : {
                    ...member,
                    ...(receipt.after === undefined
                        ? {}
                        : { after: receipt.after }),
                    physicalReceipt: receipt,
                },
        }));
        const acknowledged = assertPlaybookEffectLedger(await deferredEffects.effectLedger.writeAhead([
            {
                kind: 'replace-boundaries',
                // A cohort's shared receipt must become visible for every member in
                // one ledger revision. Publishing only this member's correction
                // spend would transiently create an invalid half-complete cohort.
                replacements,
            },
        ]), 'DECIDE semantic correction budget acknowledgement');
        synchronizeDeferredProjection(acknowledged);
        const spent = acknowledged.boundaries.find(({ boundaryId }) => boundaryId === boundary.boundaryId);
        if (spent === undefined ||
            stableJson(spent, 'DECIDE acknowledged correction boundary') !==
                stableJson(next, 'DECIDE expected correction boundary')) {
            throw new TypeError('DECIDE semantic correction budget spend was not acknowledged exactly');
        }
        return true;
    };
    const completionEvidenceFor = (input, roleId, playerId, signal, operationId) => async (completion) => {
        const queued = await semanticCompletionQueue.add(async () => {
            const { boundary, operation } = completion;
            const outcomes = governedOutcomesFor(input);
            const expectedDispositions = [
                ...new Set(Object.values(outcomes).map(({ repositoryDisposition }) => repositoryDisposition)),
            ];
            const session = requireSessionIdentity();
            if (boundary.playbookId !== session.playbookId ||
                boundary.runtimeSessionId !== session.sessionId ||
                boundary.turnId !== currentTurnId ||
                boundary.roleId !== roleId ||
                (completion.roleId !== undefined && completion.roleId !== roleId) ||
                boundary.sourceStateId !== input.stateId ||
                stableJson(boundary.dispositions, 'DECIDE boundary dispositions') !==
                    stableJson(expectedDispositions, 'DECIDE authority dispositions') ||
                stableJson(boundary.sourceOutcomeSchema, 'DECIDE boundary source schema') !==
                    stableJson(input.result, 'DECIDE authored source schema')) {
                throw new TypeError('DECIDE governed semantic reconciliation source schema changed');
            }
            governedReceiptsByBoundaryId.set(boundary.boundaryId, {
                physicalReceipt: completion.receipt,
                outcomeReceipt: completion.outcomeReceipt,
            });
            if (operation.status !== 'fulfilled' ||
                operation.value.status !== 'ok' ||
                isEmptyFinalText(operation.value.finalText)) {
                const incomplete = operation.status === 'fulfilled' &&
                    operation.value.status === 'ok' &&
                    operation.value.finalText !== undefined
                    ? { finalText: operation.value.finalText }
                    : {};
                if (operation.status === 'fulfilled' &&
                    operation.value.status === 'ok' &&
                    operation.value.finalText !== undefined) {
                    governedEvidenceByBoundaryId.set(boundary.boundaryId, {
                        finalText: operation.value.finalText,
                    });
                }
                return operationId === undefined
                    ? incomplete
                    : { ...incomplete, unresolved: true };
            }
            const finalText = operation.value.finalText;
            let raw;
            try {
                raw = await callJudge(buildAdjudicatorPrompt(input, finalText), signal, 'player-output-adjudication', input.stateId);
            }
            catch (error) {
                unresolvedGovernedEvidence(boundary.boundaryId, 'judge transport failed', error);
                governedEvidenceByBoundaryId.set(boundary.boundaryId, { finalText });
                return { finalText, unresolved: true };
            }
            let candidate;
            let retainedCandidate;
            let reconciliation;
            let structuralError;
            const retainCandidate = (value) => {
                try {
                    retainedCandidate = snapshotJsonValue(value, 'DECIDE recoverable governed semantic candidate');
                }
                catch {
                    // A non-detachable reply still retains presentation and receipt.
                }
            };
            try {
                candidate = parseGovernedSemanticCandidate(raw);
                retainCandidate(candidate);
                reconciliation = reconcilePlaybookSemanticEvidence({
                    outcomes,
                    semanticCandidate: candidate,
                    finalText,
                    receipt: completion.outcomeReceipt,
                });
            }
            catch (error) {
                if (!(error instanceof PlaybookSemanticCandidateStructureError)) {
                    throw error;
                }
                structuralError = error;
            }
            if (structuralError !== undefined) {
                const spent = await spendSemanticCorrectionBudget(boundary, completion.receipt, finalText, retainedCandidate);
                if (!spent || signal.aborted) {
                    unresolvedGovernedEvidence(boundary.boundaryId, 'semantic correction budget is unavailable', signal.aborted ? signal.reason : undefined);
                    governedEvidenceByBoundaryId.set(boundary.boundaryId, {
                        finalText,
                        ...(retainedCandidate === undefined
                            ? {}
                            : { semanticCandidate: retainedCandidate }),
                    });
                    return {
                        finalText,
                        ...(retainedCandidate === undefined
                            ? {}
                            : { semanticCandidate: retainedCandidate }),
                        unresolved: true,
                    };
                }
                let correctiveRaw;
                try {
                    correctiveRaw = await callJudge(buildAdjudicatorPrompt(input, finalText, {
                        reply: raw,
                        error: structuralError.message,
                    }), signal, 'player-output-adjudication', input.stateId);
                }
                catch (error) {
                    unresolvedGovernedEvidence(boundary.boundaryId, 'corrective judge failed', error);
                    governedEvidenceByBoundaryId.set(boundary.boundaryId, {
                        finalText,
                        ...(retainedCandidate === undefined
                            ? {}
                            : { semanticCandidate: retainedCandidate }),
                    });
                    return {
                        finalText,
                        ...(retainedCandidate === undefined
                            ? {}
                            : { semanticCandidate: retainedCandidate }),
                        unresolved: true,
                    };
                }
                try {
                    candidate = parseGovernedSemanticCandidate(correctiveRaw);
                    retainCandidate(candidate);
                    reconciliation = reconcilePlaybookSemanticEvidence({
                        outcomes,
                        semanticCandidate: candidate,
                        finalText,
                        receipt: completion.outcomeReceipt,
                    });
                }
                catch (error) {
                    if (!(error instanceof PlaybookSemanticCandidateStructureError)) {
                        throw error;
                    }
                    unresolvedGovernedEvidence(boundary.boundaryId, 'corrective semantic candidate is invalid');
                    governedEvidenceByBoundaryId.set(boundary.boundaryId, {
                        finalText,
                        ...(retainedCandidate === undefined
                            ? {}
                            : { semanticCandidate: retainedCandidate }),
                    });
                    return {
                        finalText,
                        ...(retainedCandidate === undefined
                            ? {}
                            : { semanticCandidate: retainedCandidate }),
                        unresolved: true,
                    };
                }
            }
            if (reconciliation === undefined) {
                throw new Error('DECIDE semantic reconciliation produced no decision');
            }
            const semanticCandidate = snapshotJsonValue(reconciliation.evidence.semanticCandidate, 'DECIDE governed semantic candidate');
            governedEvidenceByBoundaryId.set(boundary.boundaryId, {
                finalText,
                semanticCandidate,
            });
            if (reconciliation.status === 'unresolved') {
                unresolvedGovernedEvidence(boundary.boundaryId, reconciliation.reason);
                return { finalText, semanticCandidate, unresolved: true };
            }
            const output = reconciliation.output;
            governedOutputsByBoundaryId.set(boundary.boundaryId, output);
            if (reconciliation.status !== 'deferred') {
                return { finalText, semanticCandidate };
            }
            if (output.guard !== 'needsBossReply' ||
                typeof output.question !== 'string' ||
                output.question.trim() === '') {
                throw new TypeError('DECIDE deferred outcome must carry one exact Boss question');
            }
            const pendingQuestion = {
                questionId: input.stateId,
                asker: { kind: 'role', roleId },
                question: output.question,
                sourceItem: input.sourceItem,
            };
            return {
                finalText,
                semanticCandidate,
                deferred: {
                    operationId: operationId ?? randomUUID(),
                    pendingQuestion,
                    playerContinuation: snapshotJsonValue(selectPlayerResume(roleId, playerId), 'DECIDE deferred player continuation'),
                },
            };
        });
        if (queued === undefined) {
            throw new Error('DECIDE semantic completion produced no evidence');
        }
        return queued;
    };
    const acknowledgeGovernedPlayerResult = (value, boundaryId) => {
        const ledger = assertPlaybookEffectLedger(value.effectLedger, 'DECIDE repository settlement effect ledger');
        const completed = ledger.boundaries.find((candidate) => candidate.boundaryId === boundaryId);
        if (completed === undefined ||
            completed.physicalReceipt === undefined ||
            stableJson(completed.physicalReceipt, 'DECIDE completed receipt') !==
                stableJson(value.receipt, 'DECIDE acknowledged receipt')) {
            throw new TypeError('DECIDE repository settlement did not acknowledge its completed boundary');
        }
        const expectedEvidence = governedEvidenceByBoundaryId.get(boundaryId);
        const expectedReceipts = governedReceiptsByBoundaryId.get(boundaryId);
        if (expectedReceipts !== undefined &&
            stableJson(completed.physicalReceipt, 'DECIDE completed physical receipt') !==
                stableJson(expectedReceipts.physicalReceipt, 'DECIDE reconciled physical receipt')) {
            throw new TypeError('DECIDE repository settlement changed the physical receipt used during reconciliation');
        }
        if (expectedEvidence !== undefined &&
            (completed.finalText !== expectedEvidence.finalText ||
                (expectedEvidence.semanticCandidate === undefined
                    ? completed.semanticCandidate !== undefined
                    : completed.semanticCandidate === undefined ||
                        stableJson(completed.semanticCandidate, 'DECIDE completed semantic candidate') !==
                            stableJson(expectedEvidence.semanticCandidate, 'DECIDE expected semantic candidate')))) {
            throw new TypeError('DECIDE repository settlement did not acknowledge its exact governed evidence');
        }
        governedEvidenceByBoundaryId.delete(boundaryId);
        governedReceiptsByBoundaryId.delete(boundaryId);
        synchronizeDeferredProjection(ledger);
        if (value.operation.status === 'rejected') {
            throw value.operation.reason;
        }
        const result = validatePlayerResult(value.operation.value);
        const output = governedOutputsByBoundaryId.get(boundaryId);
        const failure = governedFailuresByBoundaryId.get(boundaryId);
        if (expectedReceipts !== undefined) {
            const continued = 'status' in value && value.status === 'continued'
                ? value
                : undefined;
            const acknowledgedOutcomeReceipt = continued === undefined ? value.receipt : continued.logicalReceipt;
            if (acknowledgedOutcomeReceipt !== undefined &&
                stableJson(acknowledgedOutcomeReceipt, 'DECIDE acknowledged outcome receipt') !==
                    stableJson(expectedReceipts.outcomeReceipt, 'DECIDE reconciled outcome receipt')) {
                throw new TypeError('DECIDE repository settlement changed the outcome receipt used during reconciliation');
            }
            if (continued !== undefined &&
                output !== undefined &&
                output.guard !== 'needsBossReply' &&
                acknowledgedOutcomeReceipt === undefined) {
                throw new TypeError('DECIDE completed deferred continuation omitted its reconciled logical receipt');
            }
        }
        governedOutputsByBoundaryId.delete(boundaryId);
        governedFailuresByBoundaryId.delete(boundaryId);
        const linkedOperationId = completed.logicalOperationId;
        if (value.deferredStatus === 'unresolved') {
            if (linkedOperationId === undefined) {
                throw new TypeError('DECIDE unresolved deferred settlement omitted its logical operation');
            }
            deferredOperationId = linkedOperationId;
            hiddenDeferredOperationId = linkedOperationId;
        }
        else if (value.deferredStatus === 'bound') {
            if (linkedOperationId === undefined) {
                throw new TypeError('DECIDE bound deferred settlement omitted its logical operation');
            }
            deferredOperationId = linkedOperationId;
            hiddenDeferredOperationId = undefined;
        }
        else if ('status' in value &&
            value.status === 'continued' &&
            value
                .logicalReceipt === undefined &&
            linkedOperationId !== undefined) {
            deferredOperationId = linkedOperationId;
            hiddenDeferredOperationId = linkedOperationId;
        }
        else if (linkedOperationId !== undefined) {
            deferredOperationId = undefined;
            hiddenDeferredOperationId = undefined;
        }
        if (failure !== undefined)
            throw failure;
        if (value.deferredStatus === 'unresolved') {
            throw new Error('DECIDE deferred repository settlement remains unresolved');
        }
        if (output !== undefined) {
            governedPlayerOutputs.set(result, output);
        }
        else if (result.status === 'ok' &&
            !isEmptyFinalText(result.finalText)) {
            throw new Error('DECIDE governed player result has no reconciled semantic output');
        }
        return result;
    };
    const shouldRunProposalCohort = (input) => {
        if (input.stateId !== PROPOSAL_STATE_BY_ROLE[input.role] ||
            completedProposalCohortTurnId === currentTurnId) {
            return false;
        }
        const state = currentState();
        return Object.values(PROPOSAL_STATE_BY_ROLE).every((stateId) => state.activeStateIds.includes(stateId));
    };
    const settleProposalCohort = async () => {
        const members = Object.fromEntries(ROLE_IDS.map((roleId) => [roleId, pendingProposalCohort.get(roleId)]));
        const turnId = currentTurnId;
        const cohortSignal = currentSignal;
        const cohortOperations = new AbortController();
        const completionOrder = [];
        try {
            if (turnId === undefined ||
                cohortSignal === undefined ||
                members.coder === undefined ||
                members.reviewer === undefined) {
                throw new Error('DECIDE proposal cohort started without both governed members');
            }
            for (const roleId of ROLE_IDS)
                members[roleId].signal.throwIfAborted();
            const operations = Object.fromEntries(ROLE_IDS.map((roleId) => [
                roleId,
                async () => {
                    const member = members[roleId];
                    try {
                        const operationSignal = combineSignals(member.signal, cohortOperations.signal);
                        const envelope = await runPlayerCall(member.input, operationSignal, { callId: member.callId });
                        member.envelope = envelope;
                        if (envelope.result.status !== 'ok' &&
                            !cohortOperations.signal.aborted) {
                            cohortOperations.abort(new Error(`DECIDE proposal cohort ${roleId} returned status ${JSON.stringify(envelope.result.status)}`));
                        }
                        return envelope.result;
                    }
                    catch (error) {
                        if (!cohortOperations.signal.aborted) {
                            cohortOperations.abort(error);
                        }
                        throw error;
                    }
                    finally {
                        completionOrder.push(roleId);
                    }
                },
            ]));
            const invocationId = randomUUID();
            const settled = await deferredEffects.repository.runCohort({
                signal: cohortSignal,
                invocationId,
                roleIds: ROLE_IDS,
                dispositionsByRole: {
                    coder: ['unchanged'],
                    reviewer: ['unchanged'],
                },
                effectBoundaries: {
                    coder: members.coder.effectBoundary,
                    reviewer: members.reviewer.effectBoundary,
                },
                operations,
                completeEffectBoundary: (completion) => {
                    const member = members[completion.roleId];
                    if (member === undefined) {
                        throw new TypeError(`DECIDE proposal cohort completed unknown role ${String(completion.roleId)}`);
                    }
                    return completionEvidenceFor(member.input, completion.roleId, resolvedPlayerId(completion.roleId), member.signal)(completion);
                },
            });
            if (settled.invocationId !== invocationId) {
                throw new TypeError('DECIDE repository cohort changed its invocation identity');
            }
            const releaseOrder = [
                ...completionOrder,
                ...ROLE_IDS.filter((roleId) => !completionOrder.includes(roleId)),
            ];
            const acknowledgedResults = new Map();
            const acknowledgementFailures = [];
            for (const roleId of releaseOrder) {
                const member = members[roleId];
                try {
                    const result = acknowledgeGovernedPlayerResult({
                        operation: settled.operations[roleId],
                        receipt: settled.receipts[roleId],
                        effectLedger: settled.effectLedger,
                    }, member.effectBoundary.boundaryId);
                    if (member.envelope === undefined) {
                        throw new TypeError(`DECIDE repository cohort omitted its ${roleId} invocation`);
                    }
                    acknowledgedResults.set(roleId, result);
                }
                catch (error) {
                    acknowledgementFailures.push(error);
                }
            }
            if (acknowledgementFailures.length > 0) {
                for (const result of acknowledgedResults.values()) {
                    governedPlayerOutputs.delete(result);
                }
                throw acknowledgementFailures.length === 1
                    ? acknowledgementFailures[0]
                    : new AggregateError(acknowledgementFailures, 'DECIDE proposal cohort reconciliation failed');
            }
            for (const roleId of releaseOrder) {
                const member = members[roleId];
                const result = acknowledgedResults.get(roleId);
                if (member.envelope === undefined || result === undefined) {
                    throw new Error(`DECIDE proposal cohort lost its ${roleId} acknowledgement`);
                }
                member.result.resolve({ ...member.envelope, result });
            }
        }
        catch (error) {
            for (const member of Object.values(members))
                member?.result.reject(error);
        }
        finally {
            completedProposalCohortTurnId = turnId;
            pendingProposalCohort.clear();
            activeProposalCohort = undefined;
        }
    };
    const queueProposalCohortMember = (input, signal) => {
        if (pendingProposalCohort.has(input.role)) {
            throw new Error(`DECIDE proposal cohort already registered role ${input.role}`);
        }
        const callId = `player-${++playerCallSequence}`;
        const member = {
            input,
            signal,
            callId,
            effectBoundary: governedBoundarySeed(input, callId),
            result: deferredValue(),
        };
        pendingProposalCohort.set(input.role, member);
        if (pendingProposalCohort.size === ROLE_IDS.length) {
            if (activeProposalCohort !== undefined) {
                throw new Error('DECIDE proposal cohort was started more than once');
            }
            activeProposalCohort = settleProposalCohort();
        }
        return member.result.promise;
    };
    const callPlayer = (input, signal) => {
        const invocation = async () => {
            const active = activeDeferredContinuation;
            if (active === undefined && hasUnresolvedReconciliation()) {
                throw new Error('DECIDE governed semantic reconciliation remains unresolved');
            }
            if (active !== undefined) {
                if (active.effectBoundary.runtimeSessionId !==
                    requireSessionIdentity().sessionId ||
                    active.effectBoundary.turnId !== currentTurnId ||
                    active.effectBoundary.roleId !== input.role ||
                    active.effectBoundary.sourceStateId !== input.stateId ||
                    active.playerContinuation === undefined) {
                    throw new TypeError('DECIDE deferred continuation did not invoke its bound player boundary');
                }
                active.input = input;
                active.playerId = resolvedPlayerId(input.role);
                try {
                    const envelope = await runPlayerCall(input, signal, {
                        callId: active.effectBoundary.callId,
                        resume: active.playerContinuation,
                    });
                    active.result.resolve(envelope.result);
                    const acknowledgedResult = await active.acknowledged.promise;
                    return { ...envelope, result: acknowledgedResult };
                }
                catch (error) {
                    active.result.reject(error);
                    try {
                        await active.acknowledged.promise;
                    }
                    catch (acknowledgementError) {
                        throw acknowledgementError;
                    }
                    throw error;
                }
            }
            if (shouldRunProposalCohort(input)) {
                return queueProposalCohortMember(input, signal);
            }
            const callId = `player-${++playerCallSequence}`;
            const effectBoundary = governedBoundarySeed(input, callId);
            let envelope;
            const settled = await deferredEffects.repository.runExclusive({
                signal,
                effectBoundary,
                operation: async () => {
                    envelope = await runPlayerCall(input, signal, { callId });
                    return envelope.result;
                },
                completeEffectBoundary: completionEvidenceFor(input, input.role, resolvedPlayerId(input.role), signal),
            });
            const result = acknowledgeGovernedPlayerResult(settled, effectBoundary.boundaryId);
            if (envelope === undefined) {
                throw new TypeError('DECIDE repository settlement omitted its player invocation');
            }
            return { ...envelope, result };
        };
        return trackBoundaryCall(invocation());
    };
    const player = fromPromise(async ({ input, signal }) => {
        const combined = combineSignals(signal, currentSignal);
        const settlementAborts = abortReasonClassifier(combined);
        try {
            // XState starts invoked actors while publishing the entering snapshot.
            // Yield through the runtime emission queue before crossing the player
            // boundary so state trace/status always precede its call-start trace.
            combined.throwIfAborted();
            try {
                await flush(settlementAborts);
            }
            catch (error) {
                latchControlPlaneError(error, combined);
                throw error;
            }
            combined.throwIfAborted();
            let { roleId, playerId, callId, result } = await callPlayer(input, combined);
            if (result.status === 'ok' &&
                isEmptyFinalText(result.finalText) &&
                automaticReplayPolicy.allowsEmptyOkCorrection(requireSessionIdentity().sessionId, callId)) {
                // DR-028: an `ok` result whose finalText is missing, empty, or
                // whitespace-only earns exactly one corrective re-ask — the same
                // composed call repeated, traced by runPlayerCall as its own
                // player-call pair, with the resume selection re-read from the
                // token map the first result left (PBRT-38). An abort that lands
                // between the two calls ends the turn without the re-ask (aborts
                // are never retried), and a rejecting finish emission rejects
                // `callPlayer` itself, so it never reaches this branch (PBRT-47).
                combined.throwIfAborted();
                ({ roleId, playerId, callId, result } = await callPlayer(input, combined));
            }
            if (result.status !== 'ok') {
                throw new Error(`${roleLabel(roleId)}${playerId === undefined ? '' : ` (${playerId})`} returned status "${result.status}"${result.error ? `: ${result.error}` : ''}`);
            }
            const finalText = result.finalText ?? '';
            if (isEmptyFinalText(finalText)) {
                throw new Error(`${roleLabel(roleId)}${playerId === undefined ? '' : ` (${playerId})`} returned status "ok" with no finalText`);
            }
            combined.throwIfAborted();
            const governedOutput = governedPlayerOutputs.get(result);
            if (governedOutput !== undefined) {
                governedPlayerOutputs.delete(result);
                return governedOutput;
            }
            throw new Error('DECIDE governed player result was not reconciled against repository evidence');
        }
        finally {
            actorSettlementAborts.push(settlementAborts);
        }
    });
    nestedBridge = createNestedPlaybookBridge({
        nextCallId: () => `playbook-${++playbookCallSequence}`,
        getBoundarySignal: () => currentSignal,
        callPlaybook: (request, signal) => trackBoundaryCall(Promise.resolve(requirePorts().callPlaybook(request, signal))),
        emitStarted: async (event, aborts) => {
            playbookCallTurnIds.set(event.callId, currentTurnId);
            await emitTrace('playbook.call.started', {
                stateId: event.stateId,
                playbookId: event.playbookId,
                text: event.text,
            }, {
                ...(currentTurnId === undefined ? {} : { turnId: currentTurnId }),
                callId: event.callId,
            }, aborts);
        },
        emitFinished: async (event, aborts) => {
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
                }, aborts);
            }
            finally {
                playbookCallTurnIds.delete(event.callId);
            }
        },
        drain: flush,
        bindResumeSignal: (signal, aborts) => {
            currentSignal = signal;
            currentAborts = aborts ?? abortReasonClassifier(signal);
        },
        bindActorSettlement: (aborts) => {
            actorSettlementAborts.push(aborts);
        },
        onControlPlaneError: (error, aborts) => {
            if (!aborts?.isAbortReason(error) &&
                !currentAborts?.isAbortReason(error)) {
                controlPlaneError ??= error;
            }
        },
        onBackgroundError: (error, aborts) => {
            if (!aborts?.isAbortReason(error)) {
                collectFailure(emissionFailures, error);
            }
        },
    });
    const providedMachine = decideMachine.provide({
        actors: { player, playbook: nestedBridge.actorLogic },
    });
    const consumeActorSettlementAborts = (forSnapshot = false) => {
        const aborts = actorSettlementAborts.shift() ?? actorSettlementErrorAborts;
        actorSettlementErrorAborts = undefined;
        if (forSnapshot && aborts !== undefined) {
            actorSettlementErrorAborts = aborts;
            queueMicrotask(() => {
                if (actorSettlementErrorAborts === aborts) {
                    actorSettlementErrorAborts = undefined;
                }
            });
        }
        return aborts;
    };
    const inspect = (event) => {
        if (actor === undefined || event.actorRef !== actor)
            return;
        if (suppressInspectionEmissions)
            return;
        if (event.type === '@xstate.action') {
            try {
                acceptedOutcomeConsumer.capture(event.action);
            }
            catch (error) {
                latchInspectionError(error);
            }
            return;
        }
        if (event.type !== '@xstate.snapshot')
            return;
        const settlementAborts = consumeActorSettlementAborts(true);
        try {
            const snapshot = event.snapshot;
            const state = normalizePlaybookSnapshot(snapshot);
            const prior = previousState ?? state;
            let acceptedOutcomes = [];
            try {
                acceptedOutcomes = acceptedOutcomeConsumer.confirm(previousState, state);
            }
            catch (error) {
                latchInspectionError(error);
            }
            const context = snapshot.context;
            const fsmPayload = telemetryPayload(prior, state, event.event, context, hiddenDeferredOperationId === undefined
                ? undefined
                : 'commitCoderProposal');
            const describedFsmPayload = snapshotJsonValue(fsmPayload, 'described FSM telemetry');
            void enqueueTracedEmission('fsm.transition', fsmPayload, { turnId: currentTurnId }, (emissionPorts) => emissionPorts.emitTelemetry({
                topic: TELEMETRY_TOPIC,
                payload: describedFsmPayload,
            }), settlementAborts).catch(() => undefined);
            const priorIds = new Set(previousState?.activeStateIds ?? []);
            previousState = state;
            const pendingQuestions = visiblePendingQuestionsForState(state, context);
            const bossRelevantStateIds = state.activeStateIds.filter((stateId) => STATUS_STATE_IDS.has(stateId));
            const scheduleStatus = (message, stateId, data) => {
                const tracePayload = {
                    ...(bossRelevantStateIds.length === 1 ? { stateId } : {}),
                    message,
                    state,
                    ...(data !== undefined ? { data } : {}),
                };
                assertJsonSafe(tracePayload);
                void enqueueTracedEmission('status.emitted', tracePayload, { turnId: currentTurnId }, (emissionPorts) => emissionPorts.emitStatus(message, data), settlementAborts).catch(() => undefined);
            };
            for (const acceptedOutcome of acceptedOutcomes) {
                void enqueueAcceptedOutcomeEmission(acceptedOutcome, state, settlementAborts).catch(() => undefined);
            }
            for (const activeStateId of state.activeStateIds) {
                if (priorIds.has(activeStateId) ||
                    !STATUS_STATE_IDS.has(activeStateId)) {
                    continue;
                }
                if (WAIT_STATE_IDS.has(activeStateId)) {
                    const pending = questionForWaitState(activeStateId, pendingQuestions);
                    if (pending) {
                        scheduleStatus(`${pending.asker.roleId} asks: ${pending.question}`, activeStateId);
                        scheduleStatus(`◆ awaiting Boss reply · ${pending.resumeStateId} · ${pending.asker.roleId} · ${pending.sourceItem}`, activeStateId);
                    }
                    continue;
                }
                const lastError = activeStateId === 'failed'
                    ? normalizeErrorCompact(context.lastError)
                    : undefined;
                const description = STATE_DESCRIPTIONS[activeStateId];
                if (description === undefined)
                    continue;
                const roleState = ROLE_STATES.find((candidate) => candidate.stateId === activeStateId);
                scheduleStatus(roleState === undefined
                    ? '◆ workflow failed; awaiting Boss recovery.'
                    : `⤷ ${roleLabel(roleState.role)}: ${description}`, activeStateId, lastError === undefined ? undefined : { lastError });
            }
        }
        catch (error) {
            acceptedOutcomeConsumer.reset();
            latchInspectionError(error, settlementAborts);
        }
    };
    const createRuntimeActor = (machineSnapshot) => {
        previousState = undefined;
        acceptedOutcomeConsumer.reset();
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
        // A synchronous FSM action throw errors the actor without any pending
        // boundary await to observe it; unobserved, XState would surface it via
        // reportUnhandledError as an uncaughtException. Observe it here: latch
        // it as a control error while a turn signal is active (unless it is
        // the abort reason itself), otherwise collect it with the emission
        // failures (slc/link.md §Abort).
        actor.subscribe({
            error: (error) => latchInspectionError(error, consumeActorSettlementAborts()),
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
        acceptedOutcomeConsumer.reset();
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
        refreshReconciliationProjection();
        if (hasUnresolvedReconciliation())
            return null;
        const snapshot = live.getSnapshot();
        const context = snapshot.context;
        const state = normalizePlaybookSnapshot(snapshot, {
            pendingCall: nestedBridge.getPendingCall(),
        });
        const pendingQuestions = visiblePendingQuestionsForState(state, context);
        const failed = state.activeStateIds.includes('failed');
        if (pendingQuestions.length === 0 &&
            (snapshot.status === 'done' ||
                state.activeStateIds.includes('ready') ||
                (failed &&
                    automaticReplayPolicy.allowsFailureStateRetry()))) {
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
    const deferredBoundarySeed = (operationId, callId) => {
        const operation = effectLedgerMirror.logicalOperations.find((candidate) => candidate.operationId === operationId);
        const latestBoundaryId = operation?.boundaryIds.at(-1);
        const priorBoundary = effectLedgerMirror.boundaries.find((candidate) => candidate.boundaryId === latestBoundaryId);
        if (operation === undefined || priorBoundary === undefined) {
            throw new TypeError('DECIDE deferred logical operation has no linked physical boundary');
        }
        if (currentTurnId === undefined ||
            !Number.isSafeInteger(currentTurnId) ||
            currentTurnId <= 0) {
            throw new Error('DECIDE deferred continuation requires an active positive turn id');
        }
        return {
            boundaryId: randomUUID(),
            runtimeSessionId: requireSessionIdentity().sessionId,
            turnId: currentTurnId,
            callId,
            roleId: priorBoundary.roleId,
            sourceStateId: priorBoundary.sourceStateId,
            sourceOutcomeSchema: snapshotJsonValue(priorBoundary.sourceOutcomeSchema, 'DECIDE deferred source outcome schema'),
            dispositions: [...priorBoundary.dispositions],
            correctionBudget: { limit: 1, spent: false },
        };
    };
    const prepareDeferredContinuation = async (signal, resumeEvent) => {
        if (deferredEffects === undefined || deferredOperationId === undefined) {
            throw new TypeError('DECIDE deferred Boss reply has no host-bound logical operation');
        }
        const operationId = deferredOperationId;
        const callId = `player-${++playerCallSequence}`;
        const effectBoundary = deferredBoundarySeed(operationId, callId);
        const active = {
            operationId,
            effectBoundary,
            result: deferredValue(),
            acknowledged: deferredValue(),
        };
        const readiness = deferredValue();
        const repositoryCall = deferredEffects.repository.runDeferred({
            mode: 'continue',
            signal,
            operationId,
            effectBoundary,
            operation: async ({ playerContinuation }) => {
                if (playerContinuation !== false &&
                    (typeof playerContinuation !== 'string' ||
                        playerContinuation.trim() === '')) {
                    throw new TypeError('DECIDE bound deferred player continuation is invalid');
                }
                active.playerContinuation = playerContinuation;
                readiness.resolve({ status: 'ready' });
                return active.result.promise;
            },
            completeEffectBoundary: async (completion) => {
                if (active.input === undefined) {
                    throw new TypeError('DECIDE deferred continuation omitted its authored player input');
                }
                return completionEvidenceFor(active.input, active.input.role, active.playerId, signal, operationId)(completion);
            },
        });
        void repositoryCall.then((value) => readiness.resolve({ status: 'settled', value }), (reason) => readiness.resolve({ status: 'rejected', reason }));
        const prepared = await readiness.promise;
        if (prepared.status === 'rejected')
            throw prepared.reason;
        if (prepared.status === 'settled') {
            synchronizeDeferredProjection(assertPlaybookEffectLedger(prepared.value.effectLedger, 'DECIDE deferred checkpoint-mismatch effect ledger'));
            hiddenDeferredOperationId = operationId;
            return { proceed: false };
        }
        activeDeferredContinuation = active;
        const acknowledgement = repositoryCall.then((value) => {
            if (value.status !== 'continued') {
                throw new TypeError('DECIDE deferred repository changed status after starting its operation');
            }
            const result = acknowledgeGovernedPlayerResult(value, effectBoundary.boundaryId);
            if (hiddenDeferredOperationId === undefined) {
                suppressInspectionEmissions = false;
                const live = actor;
                if (live === undefined) {
                    throw new Error('DECIDE deferred acknowledgement lost its runtime actor');
                }
                // Entry into the governed continuation was hidden until its durable
                // effect acknowledgement. Publish that exact current root snapshot
                // before releasing the actor output, so an accepted-outcome marker
                // is confirmed against commitCoderProposal rather than the earlier
                // awaitBossReply snapshot.
                inspect({
                    type: '@xstate.snapshot',
                    actorRef: live,
                    event: resumeEvent,
                    snapshot: live.getSnapshot(),
                });
            }
            active.acknowledged.resolve(result);
        }, (error) => {
            active.acknowledged.reject(error);
            throw error;
        }).catch((error) => {
            active.acknowledged.reject(error);
            throw error;
        });
        return { proceed: true, acknowledgement };
    };
    const parkDeferredContinuation = async (signal) => {
        if (deferredEffects === undefined || deferredOperationId === undefined) {
            return;
        }
        const operationId = deferredOperationId;
        const parked = await deferredEffects.repository.runDeferred({
            mode: 'park',
            signal,
            operationId,
        });
        synchronizeDeferredProjection(assertPlaybookEffectLedger(parked.effectLedger, 'DECIDE deferred park effect ledger'));
        hiddenDeferredOperationId = operationId;
    };
    const restoreDeferredReconciliation = async (operationId, signal, publishQuestion) => {
        const restored = await deferredEffects.repository.runDeferred({
            mode: 'restore',
            signal,
            operationId,
        });
        synchronizeDeferredProjection(assertPlaybookEffectLedger(restored.effectLedger, 'DECIDE deferred restoration effect ledger'));
        if (restored.status === 'parked') {
            throw new TypeError('DECIDE deferred restoration returned an invalid parked status');
        }
        if (restored.status !== 'restored') {
            if (hiddenDeferredOperationId !== operationId) {
                throw new TypeError('DECIDE unresolved deferred restoration lost its operation identity');
            }
            return restored.status;
        }
        if (hiddenDeferredOperationId !== undefined) {
            throw new TypeError('DECIDE restored deferred operation remained unresolved');
        }
        if (openDeferredOperation()?.operationId !== operationId) {
            throw new TypeError('DECIDE restored deferred operation is not the current bound wait');
        }
        const live = actor;
        if (live === undefined) {
            throw new Error('decide runtime: init(session) must be called first');
        }
        const state = currentState();
        const context = live.getSnapshot().context;
        const pending = questionForWaitState('awaitBossReply', visiblePendingQuestionsForState(state, context));
        const operation = openDeferredOperation();
        const projectedPending = pending === undefined
            ? undefined
            : {
                questionId: pending.questionId,
                asker: pending.asker,
                question: pending.question,
                sourceItem: pending.sourceItem,
            };
        if (pending === undefined ||
            operation?.pendingQuestion === undefined ||
            stableJson(projectedPending, 'DECIDE restored FSM pending question') !==
                stableJson(operation.pendingQuestion, 'DECIDE restored deferred pending question')) {
            throw new TypeError('DECIDE restored deferred wait does not equal its FSM question');
        }
        if (publishQuestion) {
            await emitBoundaryStatus(`${pending.asker.roleId} asks: ${pending.question}`, state);
            await emitBoundaryStatus(`◆ awaiting Boss reply · ${pending.resumeStateId} · ${pending.asker.roleId} · ${pending.sourceItem}`, state);
            await flush();
        }
        return 'restored';
    };
    const unresolvedControlCandidates = () => {
        if (!hasUnresolvedReconciliation())
            return [];
        const operation = hiddenDeferredOperationId === undefined
            ? undefined
            : effectLedgerMirror.logicalOperations.find(({ operationId }) => operationId === hiddenDeferredOperationId);
        return [
            {
                action: {
                    id: UNRESOLVED_EFFECT_RECONCILIATION_ACTION_ID,
                    label: 'Retry unresolved effect reconciliation',
                },
                kind: 'reconcile',
                ...(operation?.checkpointRestorationEligible === true
                    ? { deferredRestoreOperationId: operation.operationId }
                    : {}),
            },
            {
                action: {
                    id: UNRESOLVED_EFFECT_ABANDONMENT_ACTION_ID,
                    label: 'Abandon unresolved workflow attempt',
                },
                kind: 'abandon',
            },
        ];
    };
    const deriveControlCandidates = () => {
        const state = currentState();
        if (state.status !== 'active' ||
            !state.quiescent ||
            nestedBridge.getPendingCall() !== undefined) {
            return [];
        }
        return unresolvedControlCandidates();
    };
    const describeControlView = () => {
        if (disposed || disposalPromise !== undefined) {
            throw new Error('decide runtime: runtime is disposing or disposed');
        }
        const live = actor;
        if (live === undefined || sessionIdentity === undefined) {
            throw new Error('decide runtime: init(session) must be called before describe');
        }
        if (currentSignal !== undefined || currentTurnId !== undefined) {
            throw new Error('decide runtime: another runtime turn is active');
        }
        refreshReconciliationProjection();
        const state = currentState();
        const context = live.getSnapshot().context;
        const unresolved = hasUnresolvedReconciliation();
        const pendingQuestions = unresolved
            ? []
            : visiblePendingQuestionsForState(state, context).map((pending) => Object.freeze({
                questionId: pending.questionId,
                asker: pending.asker,
                question: pending.question,
                sourceItem: pending.sourceItem,
            }));
        const actions = deriveControlCandidates().map(({ action }) => ({
            ...action,
        }));
        const lastError = normalizeErrorFull(context.lastError);
        const stateDescription = unresolved || state.stateId === undefined
            ? undefined
            : STATE_DESCRIPTIONS[state.stateId];
        return deepFreeze(snapshotJsonValue({
            state,
            ...(stateDescription === undefined ? {} : { stateDescription }),
            pendingQuestions,
            ...(lastError === undefined ? {} : { lastError }),
            actions,
        }, 'DECIDE control view'));
    };
    const normalizedControlError = (error) => normalizeErrorFull(error) ?? {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
    };
    const frozenControlReceipt = (receipt) => deepFreeze(snapshotJsonValue(receipt, 'DECIDE apply receipt'));
    const applyControlAction = async (input) => {
        if (input === null || typeof input !== 'object') {
            throw new TypeError('decide runtime: apply input must be an object');
        }
        const { actionId, key, signal } = input;
        if (typeof actionId !== 'string' || actionId.length === 0) {
            throw new TypeError('decide runtime: apply actionId must be a non-empty string');
        }
        if (typeof key !== 'string' || key.length === 0) {
            throw new TypeError('decide runtime: apply key must be a non-empty string');
        }
        if (!(signal instanceof AbortSignal)) {
            throw new TypeError('decide runtime: apply signal must be an AbortSignal');
        }
        if (disposed || disposalPromise !== undefined) {
            throw new Error('decide runtime: runtime is disposing or disposed');
        }
        if (actor === undefined || sessionIdentity === undefined) {
            throw new Error('decide runtime: init(session) must be called before apply');
        }
        if (currentSignal !== undefined || currentTurnId !== undefined) {
            throw new Error('decide runtime: another runtime turn is active');
        }
        const recorded = appliedControlReceipts.get(key);
        if (recorded !== undefined)
            return recorded;
        signal.throwIfAborted();
        refreshReconciliationProjection();
        const turnId = ++turnSequence;
        const callId = `apply-${++applyCallSequence}`;
        currentTurnId = turnId;
        currentSignal = signal;
        currentAborts = abortReasonClassifier(signal);
        controlPlaneError = undefined;
        let accepted = false;
        let receipt;
        let operationError;
        let settlementError;
        let lateDeliveryError;
        const position = { turnId, callId };
        const preAcceptanceFinish = (reason) => ({
            actionId,
            key,
            disposition: 'rejected',
            reason,
        });
        try {
            try {
                try {
                    await emitTrace('apply.started', {
                        actionId,
                        key,
                        ...stateIdentity(currentState()),
                    }, position, currentAborts);
                }
                catch (error) {
                    latchControlPlaneError(error, signal);
                    try {
                        await emitTrace('apply.finished', {
                            ...preAcceptanceFinish('apply.started trace sink rejected'),
                            status: isAbortFailure(error, signal) ? 'aborted' : 'error',
                            error: normalizedControlError(error),
                        }, position, currentAborts);
                    }
                    catch {
                        // Preserve the start failure after one best-effort finish attempt.
                    }
                    throw error;
                }
                await flush();
                if (signal.aborted) {
                    try {
                        await emitTrace('apply.finished', {
                            ...preAcceptanceFinish('aborted before acceptance'),
                            status: 'aborted',
                            error: normalizedControlError(signal.reason),
                        }, position, currentAborts);
                    }
                    catch (error) {
                        // A rejecting abort-finish sink outranks the abort at settlement.
                        settlementError ??= error;
                    }
                }
                signal.throwIfAborted();
                const candidate = deriveControlCandidates().find(({ action }) => action.id === actionId);
                if (candidate === undefined) {
                    receipt = frozenControlReceipt({
                        disposition: 'rejected',
                        reason: `action ${JSON.stringify(actionId)} is not currently advertised`,
                    });
                }
                else {
                    // Acceptance is the line after which this boundary always records
                    // and returns a receipt: the requested effect may now exist.
                    accepted = true;
                    try {
                        let run;
                        if (candidate.kind === 'abandon') {
                            signal.throwIfAborted();
                            run = {
                                outcome: 'unresolved-effect',
                                state: currentState(),
                            };
                        }
                        else {
                            if (candidate.deferredRestoreOperationId !== undefined) {
                                await restoreDeferredReconciliation(candidate.deferredRestoreOperationId, signal, true);
                            }
                            else {
                                // The host owns receipt reconstruction. Reconciliation only
                                // re-reads its authoritative ledger; it never calls a player
                                // or judge to manufacture missing semantic evidence.
                                refreshReconciliationProjection();
                            }
                            signal.throwIfAborted();
                            run = {
                                outcome: hasUnresolvedReconciliation()
                                    ? 'no-action'
                                    : 'quiescent',
                                state: currentState(),
                            };
                        }
                        if (controlPlaneError !== undefined)
                            throw controlPlaneError;
                        receipt = frozenControlReceipt({
                            disposition: 'executed',
                            run,
                        });
                    }
                    catch (error) {
                        receipt = frozenControlReceipt({
                            disposition: 'failed',
                            error: normalizedControlError(error),
                        });
                    }
                    appliedControlReceipts.set(key, receipt);
                }
            }
            catch (error) {
                operationError = error;
            }
            try {
                await flush();
            }
            catch (error) {
                settlementError = error;
            }
            settlementError ??= controlPlaneError;
            if (accepted && settlementError !== undefined) {
                receipt = frozenControlReceipt({
                    disposition: 'failed',
                    error: normalizedControlError(settlementError),
                });
                appliedControlReceipts.set(key, receipt);
                settlementError = undefined;
            }
            if (receipt !== undefined) {
                const finishFailures = [];
                try {
                    await emitTrace('apply.finished', { actionId, key, ...receipt }, position, currentAborts);
                }
                catch (error) {
                    if (!accepted || !isAbortFailure(error, signal)) {
                        collectFailure(finishFailures, error);
                    }
                }
                try {
                    await flush();
                }
                catch (error) {
                    if (!accepted || !isAbortFailure(error, signal)) {
                        collectFailure(finishFailures, error);
                    }
                }
                if (finishFailures.length > 0) {
                    const failure = finishFailures.length === 1
                        ? finishFailures[0]
                        : new AggregateError(finishFailures, 'DECIDE apply settlement emissions failed');
                    if (accepted)
                        lateDeliveryError = failure;
                    else
                        settlementError = failure;
                }
            }
        }
        finally {
            currentSignal = undefined;
            currentAborts = undefined;
            currentTurnId = undefined;
            controlPlaneError = undefined;
            if (accepted && receipt !== undefined) {
                appliedControlReceipts.set(key, receipt);
            }
        }
        if (lateDeliveryError !== undefined) {
            collectFailure(emissionFailures, lateDeliveryError);
        }
        if (accepted && receipt !== undefined)
            return receipt;
        const failure = settlementError ?? operationError;
        if (failure !== undefined)
            throw failure;
        if (receipt === undefined) {
            throw new Error('decide runtime: apply produced no receipt');
        }
        return receipt;
    };
    const resultForSnapshot = (signal) => {
        const live = actor;
        if (!live)
            throw new Error('decide runtime: actor is not initialized');
        const snapshot = live.getSnapshot();
        const pendingCall = nestedBridge.getPendingCall();
        const state = normalizePlaybookSnapshot(snapshot, { pendingCall });
        const context = snapshot.context;
        const abortedResult = (abortSignal) => ({
            outcome: 'aborted',
            state,
            ...(abortSignal.reason === undefined
                ? {}
                : {
                    error: normalizeErrorFull(abortSignal.reason) ?? {
                        name: 'AbortError',
                        message: String(abortSignal.reason),
                    },
                }),
        });
        if (snapshot.status === 'error') {
            // An errored actor outranks a coincident abort unless the actor's
            // error is the abort reason itself (slc/link.md §Abort).
            const actorError = snapshot.error;
            if (actorError !== undefined &&
                signal !== undefined &&
                isAbortFailure(actorError, signal)) {
                return abortedResult(signal);
            }
            throw (actorError ?? new Error('decide runtime actor entered error status'));
        }
        // Terminal completion outranks a coincident abort (DR-036 §3): reporting
        // 'aborted' over a completed machine would hide a terminal state that the
        // next turn silently restarts, duplicating the workflow's side effects.
        if (snapshot.status === 'done') {
            const output = snapshot.output;
            if (output !== undefined)
                assertJsonSafe(output, 'terminal output');
            const stateDescription = state.activeStateIds.includes('done')
                ? STATE_DESCRIPTIONS.done
                : state.activeStateIds.includes('reportedReviewFailure')
                    ? STATE_DESCRIPTIONS.reportedReviewFailure
                    : undefined;
            if (stateDescription === undefined) {
                throw new Error('decide runtime: completed actor has no authored final-state description');
            }
            return {
                outcome: 'terminal',
                state,
                stateDescription,
                ...(output === undefined ? {} : { output }),
            };
        }
        if (signal?.aborted) {
            return abortedResult(signal);
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
    const cleanupFailedStart = async (cause, options) => {
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
            await nestedBridge.abortPending(cause);
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
        privateResumeTokens.clear();
        inFlightPlayerKeys.clear();
        activeBoundaryCalls.clear();
        activeEmissionCalls.clear();
        emissionQueue.clear();
        judgeQueue.clear();
        semanticCompletionQueue.clear();
        actor = undefined;
        currentSignal = undefined;
        currentAborts = undefined;
        actorSettlementAborts.length = 0;
        actorSettlementErrorAborts = undefined;
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
        applyCallSequence = 0;
        playbookCallTurnIds.clear();
        governedOutputsByBoundaryId.clear();
        governedFailuresByBoundaryId.clear();
        governedEvidenceByBoundaryId.clear();
        governedReceiptsByBoundaryId.clear();
        pendingProposalCohort.clear();
        activeProposalCohort = undefined;
        completedProposalCohortTurnId = undefined;
        deferredOperationId = undefined;
        hiddenDeferredOperationId = undefined;
        unresolvedSemanticBoundaryIds.clear();
        appliedControlReceipts.clear();
        activeDeferredContinuation = undefined;
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
            const identity = bindSession(session);
            let finishInitialization;
            const initialization = new Promise((resolve) => {
                finishInitialization = resolve;
            });
            initInFlight = initialization;
            lifecycleStarted = true;
            ports = identity.ports;
            sessionIdentity = identity;
            try {
                if (deferredEffects !== undefined) {
                    effectLedgerMirror = readEffectLedger();
                    synchronizeDeferredProjection(effectLedgerMirror);
                }
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
                await cleanupFailedStart(error, { emitDisposal: true });
                throw error;
            }
            finally {
                finishInitialization();
                if (initInFlight === initialization)
                    initInFlight = undefined;
            }
        },
        describe: describeControlView,
        unresolvedEffectEnvelopes: unresolvedEffectEnvelopeIdentities,
        apply: applyControlAction,
        // DR-014 §1 / DR-031 §5 / PBRT-45: JSON-safe capture of a parked
        // session, including one already-started suspended REVIEW call.
        // Defined only at a safe capture point — initialized, not disposing
        // or disposed, no active public boundary, and the actor quiescent with
        // status `active`.
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
            const pendingCall = nestedBridge.getPendingCall();
            const bridgeSuspendedCall = nestedBridge.getSuspendedCall();
            if ((pendingCall === undefined) !== (bridgeSuspendedCall === undefined)) {
                return undefined;
            }
            if (pendingCall !== undefined &&
                bridgeSuspendedCall !== undefined &&
                (pendingCall.callId !== bridgeSuspendedCall.callId ||
                    pendingCall.playbookId !== bridgeSuspendedCall.playbookId ||
                    pendingCall.childSessionId !== bridgeSuspendedCall.childSessionId)) {
                return undefined;
            }
            let suspendedCall;
            if (bridgeSuspendedCall !== undefined) {
                if (!playbookCallTurnIds.has(bridgeSuspendedCall.callId)) {
                    return undefined;
                }
                const turnId = playbookCallTurnIds.get(bridgeSuspendedCall.callId);
                if (bridgeSuspendedCall.turnId !== undefined &&
                    bridgeSuspendedCall.turnId !== turnId) {
                    return undefined;
                }
                suspendedCall = {
                    ...bridgeSuspendedCall,
                    ...(turnId === undefined ? {} : { turnId }),
                };
            }
            const state = currentState();
            if (state.status !== 'active' || !state.quiescent)
                return undefined;
            const machine = detachPersistedMachineSnapshot(actor.getPersistedSnapshot());
            const context = actor.getSnapshot().context;
            if (deferredEffects !== undefined) {
                synchronizeDeferredProjection(readEffectLedger());
            }
            const unresolved = hasUnresolvedReconciliation();
            return {
                schemaVersion: 4,
                playbookId: sessionIdentity.playbookId,
                machine,
                roleResumeTokens: snapshotRoleResumeTokens(),
                sequences: {
                    trace: traceSequence,
                    turn: turnSequence,
                    judgeCall: judgeCallSequence,
                    playerCall: playerCallSequence,
                    playbookCall: playbookCallSequence,
                },
                state,
                pendingBossQuestions: unresolved
                    ? []
                    : visiblePendingQuestionsForState(state, context).map((pending) => ({
                        questionId: pending.questionId,
                        asker: pending.asker,
                        question: pending.question,
                        sourceItem: pending.sourceItem,
                    })),
                effectLedger: effectLedgerMirror,
                ...(suspendedCall === undefined ? {} : { suspendedCall }),
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
            const identity = bindSession(session);
            const boundSnapshot = assertPlaybookRuntimeSnapshot(snapshot, identity.playbookId, { allowSuspendedCall: true });
            if (deferredEffects === undefined) {
                if (boundSnapshot.effectLedger.revision !== 0 ||
                    boundSnapshot.effectLedger.boundaries.length !== 0 ||
                    boundSnapshot.effectLedger.logicalOperations.length !== 0) {
                    throw new TypeError('decide runtime snapshot effectLedger must be the canonical empty ledger');
                }
            }
            else {
                const current = readEffectLedger();
                if (stableJson(current, 'DECIDE current effect ledger') !==
                    stableJson(boundSnapshot.effectLedger, 'DECIDE snapshot effect ledger')) {
                    throw new TypeError('decide runtime snapshot effectLedger must equal the current host mirror');
                }
                effectLedgerMirror = current;
            }
            const suspendedCall = boundSnapshot.suspendedCall;
            let finishInitialization;
            const initialization = new Promise((resolve) => {
                finishInitialization = resolve;
            });
            initInFlight = initialization;
            lifecycleStarted = true;
            ports = identity.ports;
            sessionIdentity = identity;
            let priorExternalRoleTokens;
            try {
                traceSequence = boundSnapshot.sequences.trace;
                turnSequence = boundSnapshot.sequences.turn;
                judgeCallSequence = boundSnapshot.sequences.judgeCall;
                playerCallSequence = boundSnapshot.sequences.playerCall;
                playbookCallSequence = boundSnapshot.sequences.playbookCall;
                applyCallSequence = boundSnapshot.sequences.trace;
                if (identity.playerSessions) {
                    priorExternalRoleTokens = snapshotRoleResumeTokens();
                }
                restoreRoleResumeTokens(boundSnapshot.roleResumeTokens);
                nestedBridge.prepareRestore(suspendedCall);
                if (suspendedCall !== undefined) {
                    playbookCallTurnIds.set(suspendedCall.callId, suspendedCall.turnId);
                }
                synchronizeDeferredProjection(effectLedgerMirror);
                suppressInspectionEmissions = true;
                createRuntimeActor(boundSnapshot.machine);
                actor?.start();
                const restoredState = currentState(suspendedCall);
                if (restoredState.status !== 'active') {
                    throw new Error(`decide runtime: restored actor status is ${restoredState.status}, expected active`);
                }
                if (stableJson(restoredState, 'restored runtime state') !==
                    stableJson(boundSnapshot.state, 'runtime snapshot state')) {
                    throw new Error('decide runtime: restored actor state does not match snapshot state');
                }
                previousState = restoredState;
                await flush();
                suppressInspectionEmissions = false;
                // Final fallible step: after this publication the authoritative
                // child has rejoined ordinary resume/abort ownership, so no later
                // restore validation may trigger failed-start rollback.
                nestedBridge.confirmRestore();
            }
            catch (error) {
                let failure = error;
                if (priorExternalRoleTokens !== undefined) {
                    try {
                        identity.playerSessions.restore(priorExternalRoleTokens);
                    }
                    catch (rollbackError) {
                        failure = new AggregateError([error, rollbackError], 'DECIDE restore and player continuation rollback failed');
                    }
                }
                await cleanupFailedStart(failure, { emitDisposal: false });
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
            currentAborts = abortReasonClassifier(turn.signal);
            controlPlaneError = undefined;
            let result = resultForSnapshot(turn.signal);
            let settlement = result;
            const failures = [];
            try {
                await emitTrace('boss.input.received', { text: turn.text }, { turnId });
                // A boundary entered aborted records the attempted input, then refuses
                // delivery before deterministic mapping or the classifier can perform
                // any host-visible work (DR-036 §5).
                turn.signal.throwIfAborted();
                if (turn.text.trim().length === 0) {
                    const state = currentState();
                    result = { outcome: 'no-action', state };
                }
                else {
                    const event = await classify(turn.text, turn.signal);
                    if (!event) {
                        const state = currentState();
                        if (!hasUnresolvedReconciliation()) {
                            await emitBoundaryStatus('No playbook action classified.', state);
                        }
                        result = { outcome: 'no-action', state };
                    }
                    else if (event.type === 'NO_ACTION') {
                        result = { outcome: 'no-action', state: currentState() };
                    }
                    else {
                        const before = currentState();
                        const boundCommitWait = deferredEffects !== undefined &&
                            deferredOperationId !== undefined &&
                            before.activeStateIds.includes('awaitBossReply');
                        if (boundCommitWait && event.type === 'BOSS_INTERRUPT') {
                            await parkDeferredContinuation(turn.signal);
                            result = { outcome: 'no-action', state: currentState() };
                        }
                        else {
                            const prepared = boundCommitWait &&
                                event.type === 'BOSS_REPLY' &&
                                event.questionId === 'commitCoderProposal'
                                ? await prepareDeferredContinuation(turn.signal, event)
                                : undefined;
                            if (prepared?.proceed === false) {
                                result = { outcome: 'no-action', state: currentState() };
                            }
                            else {
                                await emitBoundaryStatus(event.type, before);
                                if (actor.getSnapshot().status === 'done') {
                                    stopActor();
                                    startActor();
                                }
                                const deferredMachineCheckpoint = prepared?.proceed === true
                                    ? detachPersistedMachineSnapshot(actor.getPersistedSnapshot())
                                    : undefined;
                                if (deferredMachineCheckpoint !== undefined) {
                                    suppressInspectionEmissions = true;
                                }
                                try {
                                    actor.send(event);
                                    await driveToQuiescence();
                                    await drainBoundaryCallsAndEmissions();
                                    await prepared?.acknowledgement;
                                    if (deferredMachineCheckpoint !== undefined &&
                                        hiddenDeferredOperationId !== undefined) {
                                        stopActor();
                                        createRuntimeActor(deferredMachineCheckpoint);
                                        actor.start();
                                        previousState = before;
                                        suppressInspectionEmissions = false;
                                    }
                                }
                                catch (error) {
                                    activeDeferredContinuation?.result.reject(error);
                                    if (deferredEffects !== undefined) {
                                        try {
                                            synchronizeDeferredProjection(readEffectLedger());
                                            hiddenDeferredOperationId ??= deferredOperationId;
                                        }
                                        catch {
                                            hiddenDeferredOperationId ??= deferredOperationId;
                                        }
                                    }
                                    if (deferredMachineCheckpoint !== undefined) {
                                        try {
                                            stopActor();
                                            createRuntimeActor(deferredMachineCheckpoint);
                                            actor.start();
                                            previousState = before;
                                        }
                                        finally {
                                            suppressInspectionEmissions = false;
                                        }
                                    }
                                    throw error;
                                }
                                finally {
                                    activeDeferredContinuation = undefined;
                                }
                                if (controlPlaneError !== undefined)
                                    throw controlPlaneError;
                                result = resultForSnapshot(turn.signal);
                            }
                        }
                    }
                }
                settlement = {
                    ...result,
                    ...stateIdentity(result.state),
                };
            }
            catch (error) {
                const primaryError = controlPlaneError;
                // Only a rejection that is the exact abort reason settles as the
                // cancellation; a distinct failure observed while the signal is
                // aborted remains a control error (slc/link.md §Abort).
                if (primaryError !== undefined) {
                    collectFailure(failures, primaryError);
                }
                else if (!isAbortFailure(error, turn.signal)) {
                    collectFailure(failures, error);
                }
                const state = currentState();
                const effectiveError = primaryError ?? error;
                result =
                    isAbortFailure(error, turn.signal) && primaryError === undefined
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
                // A drain rejection that is the exact abort reason evidences the
                // cancellation, not a control-plane failure (slc/link.md §Abort).
                const drainAborted = isAbortFailure(effectiveError, turn.signal);
                if (!drainAborted)
                    collectFailure(failures, effectiveError);
                const state = currentState();
                result = {
                    outcome: drainAborted ? 'aborted' : 'failed',
                    state,
                    error: normalizeErrorFull(effectiveError) ?? {
                        name: 'Error',
                        message: String(effectiveError),
                    },
                };
                settlement = { ...result, ...stateIdentity(state) };
            }
            try {
                await emitTrace('boss.input.settled', settlement, { turnId });
            }
            catch (error) {
                // A settlement-trace rejection that is the exact abort reason also
                // evidences the cancellation (slc/link.md §Abort).
                if (!isAbortFailure(error, turn.signal)) {
                    collectFailure(failures, error);
                }
            }
            try {
                await flush();
            }
            catch (error) {
                // A late flush rejection that is the exact abort reason likewise
                // evidences the cancellation; the settled result already labels
                // the turn aborted then (slc/link.md §Abort).
                if (!isAbortFailure(error, turn.signal)) {
                    collectFailure(failures, error);
                }
            }
            finally {
                const primaryError = controlPlaneError;
                currentSignal = undefined;
                currentAborts = undefined;
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
            refreshReconciliationProjection();
            if (hasUnresolvedReconciliation()) {
                return { outcome: 'no-action', state: currentState() };
            }
            currentTurnId = playbookCallTurnIds.get(callId);
            currentSignal = signal;
            currentAborts = abortReasonClassifier(signal);
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
            const aborts = currentAborts ?? abortReasonClassifier(signal);
            // The control latch has already classified its failure as distinct
            // under the operation that owned it. Only still-unclassified drain and
            // operation candidates may be cancellation evidence for this resume.
            const controlFailure = controlPlaneError;
            const drainAbort = controlFailure === undefined &&
                drainError !== undefined &&
                aborts.isAbortReason(drainError);
            const operationAbort = controlFailure === undefined &&
                operationError !== undefined &&
                aborts.isAbortReason(operationError);
            const abortEvidence = (drainAbort ? drainError : undefined) ??
                (operationAbort ? operationError : undefined);
            const failure = controlFailure ??
                (drainAbort ? undefined : drainError) ??
                (operationAbort ? undefined : operationError);
            currentSignal = undefined;
            currentAborts = undefined;
            currentTurnId = undefined;
            controlPlaneError = undefined;
            if (failure !== undefined)
                throw failure;
            if (abortEvidence !== undefined &&
                runResult?.outcome !== 'terminal' &&
                runResult?.outcome !== 'suspended') {
                const state = currentState();
                runResult = {
                    outcome: 'aborted',
                    state,
                    error: normalizeErrorFull(abortEvidence) ?? {
                        name: 'AbortError',
                        message: String(abortEvidence),
                    },
                };
            }
            if (runResult === undefined) {
                if (signal.aborted) {
                    // Every candidate was the abort's own evidence: settle on the
                    // machine's state under the aborted boundary signal (DR-036 §4).
                    runResult = resultForSnapshot(signal);
                }
                else {
                    throw new Error('decide runtime: playbook resume produced no result');
                }
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
                    privateResumeTokens.clear();
                    playbookCallTurnIds.clear();
                    inFlightPlayerKeys.clear();
                    activeBoundaryCalls.clear();
                    activeEmissionCalls.clear();
                    emissionQueue.clear();
                    judgeQueue.clear();
                    semanticCompletionQueue.clear();
                    actor = undefined;
                    currentSignal = undefined;
                    currentAborts = undefined;
                    actorSettlementAborts.length = 0;
                    actorSettlementErrorAborts = undefined;
                    currentTurnId = undefined;
                    ports = undefined;
                    sessionIdentity = undefined;
                    previousState = undefined;
                    controlPlaneError = undefined;
                    governedOutputsByBoundaryId.clear();
                    governedFailuresByBoundaryId.clear();
                    governedEvidenceByBoundaryId.clear();
                    governedReceiptsByBoundaryId.clear();
                    pendingProposalCohort.clear();
                    activeProposalCohort = undefined;
                    completedProposalCohortTurnId = undefined;
                    deferredOperationId = undefined;
                    hiddenDeferredOperationId = undefined;
                    unresolvedSemanticBoundaryIds.clear();
                    appliedControlReceipts.clear();
                    applyCallSequence = 0;
                    activeDeferredContinuation = undefined;
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
        // @internal — test-only parity with the shared factory's bridge escape
        // hatch. This is hidden by the PlaybookRuntime return type.
        _getNestedBridge() {
            return nestedBridge;
        },
    };
}
export const createPlaybookRuntime = (factoryInput) => {
    const construction = schema3Construction(factoryInput);
    return createDecidePlaybookRuntime(construction.configuredOptions, construction.hostCapabilities);
};
export const _internal = {
    composePlayerPrompt,
    requiredFieldsFor,
    extractJson,
    buildClassifierPrompt,
    parseClassification,
    buildAdjudicatorPrompt,
    combineSignals,
    pendingQuestionsFromContext,
    pendingQuestionsForState,
    normalizeErrorCompact,
    normalizeErrorFull,
    STATE_DESCRIPTIONS,
    ROLE_STATES,
    ROLE_STATE_IDS,
    VERBATIM_PAYLOAD_FIELDS,
    BOSS_INTERRUPT_TARGETS,
    UNFINISHED_FINAL_STATE_IDS,
    CONTINUATION_PREAMBLE,
    TELEMETRY_TOPIC,
};
export default createPlaybookRuntime;
