// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { assign, fromPromise, setup } from 'xstate';
const ROUTING_PROMPT = [
    'Boss intent: <boss-intent>',
    'Enabled playbooks: <enabled-playbooks>',
    'You are routing this intent, not performing the requested work.',
    'Use only the Boss intent and enabled-playbooks catalog supplied here.',
    'Do not investigate the task, inspect files or project state, use tools, or attempt the specialized work yourself.',
    "Preserve Boss's intended outcome and constraints.",
    'If the supplied evidence identifies a useful route, select an enabled playbook; do not finish the intent yourself.',
    'Ask exactly one concise question only when its answer is necessary to choose a useful route or call order.',
    'For a complex intent, divide it into the smallest finite ordered plan of useful playbook calls.',
    'Name the selected first playbook and state its complete standalone request containing only the context it needs.',
    'List any later playbook calls in their intended order after the selected first call.',
    'Do not call a playbook merely to restate or classify the intent.',
    'Write only concise human-facing routing prose or the one routing question.',
    'Do not emit JSON, guard names, result property names, or control instructions.',
    'Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.',
].join('\n');
const REASSESS_PROMPT = [
    'Boss intent: <boss-intent>',
    'Enabled playbooks: <enabled-playbooks>',
    'Remaining plan: <remaining-plan>',
    'Completed call results: <completed-call-results>',
    "Preserve Boss's intended outcome and constraints.",
    'Treat each returned result as evidence and revise the remaining plan when needed.',
    'A continuing decision must strictly reduce the remaining plan length.',
    'Do not repeat an equivalent failed or completed call without new information.',
    'If the intent is fulfilled, give Boss one concise final response that states the result or actionable conclusion.',
    'Do not finish with a bare acknowledgement, a promise to act, or an announcement that the round is complete.',
    'If information from Boss is now necessary, ask exactly one concise question.',
    'Otherwise name exactly one next enabled playbook and state its complete standalone request containing only the context it needs.',
    'List any still-later playbook calls in their intended order after the selected next call.',
    'Write only concise human-facing final, question, or routing prose.',
    'Do not emit JSON, guard names, result property names, or control instructions.',
    'Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.',
].join('\n');
const NEEDS_BOSS_REPLY_DESCRIPTION = "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";
const ROUTING_RESULTS = {
    question: 'Captain asked the one material routing question. Output shall include `question: <verbatim final text from the visible Captain call>`.',
    delegation: 'Captain selected the first useful call. Output shall include `remainingPlan: <finite JSON-safe array of only later calls>`, `nextPlaybookId: <selected stable enabled-playbook id>`, and `nextPlaybookInput: <complete standalone request>`.',
    needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
};
const REASSESS_RESULTS = {
    final: 'Captain gave Boss the concrete result or actionable conclusion. Output shall include `response: <verbatim final text from the visible Captain call>`.',
    followUpQuestion: 'Captain asked one necessary follow-up question. Output shall include `question: <verbatim final text from the visible Captain call>`.',
    continuing: 'Captain selected another useful call. Output shall include `remainingPlan: <strictly shorter finite JSON-safe array of only later calls>`, `nextPlaybookId: <selected stable enabled-playbook id>`, and `nextPlaybookInput: <complete standalone request>`.',
    needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
};
function isPlainRecord(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isJsonValue(value, seen = []) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (typeof value !== 'object') {
        return false;
    }
    if (seen.includes(value)) {
        return false;
    }
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
            return false;
        }
        const keys = Reflect.ownKeys(value);
        if (keys.length !== value.length + 1 || !keys.includes('length')) {
            return false;
        }
        for (let index = 0; index < value.length; index += 1) {
            const key = String(index);
            if (!Object.prototype.hasOwnProperty.call(value, key)) {
                return false;
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                return false;
            }
            if (!isJsonValue(descriptor.value, [...seen, value])) {
                return false;
            }
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
        return Boolean(lengthDescriptor && !lengthDescriptor.enumerable && !lengthDescriptor.configurable && lengthDescriptor.value === value.length);
    }
    if (!isPlainRecord(value)) {
        return false;
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') {
            return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            return false;
        }
        if (!isJsonValue(descriptor.value, [...seen, value])) {
            return false;
        }
    }
    return true;
}
function isJsonArray(value) {
    return Array.isArray(value) && isJsonValue(value);
}
function hasDoneOutput(event) {
    return isPlainRecord(event) && 'output' in event;
}
function hasErrorValue(event) {
    return isPlainRecord(event) && 'error' in event;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function isRoutingQuestionOutput(output) {
    return isPlainRecord(output) && (output.guard === 'question' || output.guard === 'needsBossReply') && isNonEmptyString(output.question);
}
function isReassessQuestionOutput(output) {
    return isPlainRecord(output) && (output.guard === 'followUpQuestion' || output.guard === 'needsBossReply') && isNonEmptyString(output.question);
}
function isDelegationOutput(output) {
    return (isPlainRecord(output) &&
        output.guard === 'delegation' &&
        isJsonArray(output.remainingPlan) &&
        isNonEmptyString(output.nextPlaybookId) &&
        isNonEmptyString(output.nextPlaybookInput));
}
function isContinuingOutput(output) {
    return (isPlainRecord(output) &&
        output.guard === 'continuing' &&
        isJsonArray(output.remainingPlan) &&
        isNonEmptyString(output.nextPlaybookId) &&
        isNonEmptyString(output.nextPlaybookInput));
}
function isFinalOutput(output) {
    return isPlainRecord(output) && output.guard === 'final' && isNonEmptyString(output.response);
}
function outputFrom(event) {
    return hasDoneOutput(event) ? event.output : undefined;
}
function errorFrom(event) {
    return hasErrorValue(event) ? event.error : undefined;
}
function targetInCatalog(context, playbookId) {
    return context.enabledPlaybooks.some((entry) => entry.id === playbookId);
}
function callSignature(playbookId, text) {
    return JSON.stringify([playbookId, text]);
}
function canEnterDynamicCall(context, playbookId, text) {
    return (isNonEmptyString(playbookId) &&
        isNonEmptyString(text) &&
        playbookId !== context.selfPlaybookId &&
        targetInCatalog(context, playbookId) &&
        !context.callHistory.includes(callSignature(playbookId, text)));
}
function normalizeError(error) {
    if (error instanceof Error) {
        const normalized = {
            name: error.name || 'Error',
            message: error.message || 'Unknown error',
        };
        if (typeof error.stack === 'string') {
            normalized.stack = error.stack;
        }
        return normalized;
    }
    if (isPlainRecord(error) && typeof error.name === 'string' && typeof error.message === 'string') {
        const normalized = {
            name: error.name,
            message: error.message,
        };
        if (typeof error.stack === 'string') {
            normalized.stack = error.stack;
        }
        return normalized;
    }
    return { name: 'Error', message: String(error) };
}
function isNormalizedError(value) {
    const allowed = new Set(['name', 'message', 'stack']);
    return (isPlainRecord(value) &&
        Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key)) &&
        isNonEmptyString(value.name) &&
        typeof value.message === 'string' &&
        (!('stack' in value) || typeof value.stack === 'string'));
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function isPlaybookStateValue(value, seen = []) {
    if (typeof value === 'string') {
        return true;
    }
    if (!isPlainRecord(value) || seen.includes(value)) {
        return false;
    }
    return Reflect.ownKeys(value).every((key) => {
        if (typeof key !== 'string') {
            return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return Boolean(descriptor &&
            descriptor.enumerable &&
            'value' in descriptor &&
            isPlaybookStateValue(descriptor.value, [...seen, value]));
    });
}
function isPlaybookState(value) {
    if (!isPlainRecord(value)) {
        return false;
    }
    const allowed = new Set(['value', 'activeStateIds', 'tags', 'status', 'quiescent', 'stateId']);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
        return false;
    }
    return (isPlaybookStateValue(value.value) &&
        isStringArray(value.activeStateIds) &&
        isStringArray(value.tags) &&
        (value.status === 'active' || value.status === 'done' || value.status === 'error' || value.status === 'stopped') &&
        typeof value.quiescent === 'boolean' &&
        (!('stateId' in value) || typeof value.stateId === 'string'));
}
function publicChildResult(error) {
    if (!(error instanceof Error) || !('result' in error)) {
        return undefined;
    }
    const result = error.result;
    return isPlainRecord(result) ? result : undefined;
}
function isValidPublicChildResult(error, context) {
    const result = publicChildResult(error);
    if (!result) {
        return false;
    }
    const allowed = new Set(['playbookId', 'status', 'error', 'output', 'childSessionId', 'state']);
    if (Reflect.ownKeys(result).some((key) => typeof key !== 'string' || !allowed.has(key))) {
        return false;
    }
    if (result.playbookId !== context.nextPlaybookId || (result.status !== 'aborted' && result.status !== 'error')) {
        return false;
    }
    if ('output' in result) {
        return false;
    }
    if ('childSessionId' in result && !isNonEmptyString(result.childSessionId)) {
        return false;
    }
    if ('state' in result && !isPlaybookState(result.state)) {
        return false;
    }
    if (result.status === 'error') {
        return isNormalizedError(result.error);
    }
    return !('error' in result) || isNormalizedError(result.error);
}
function compactChildError(error) {
    const result = publicChildResult(error);
    if (result && isNormalizedError(result.error)) {
        return { name: result.error.name, message: result.error.message };
    }
    return { name: 'AbortError', message: 'Child playbook aborted.' };
}
function childStatus(error) {
    const result = publicChildResult(error);
    return result?.status === 'error' ? 'error' : 'aborted';
}
function makePendingQuestion(stateId, sourceItem, question) {
    return {
        questionId: stateId,
        resumeStateId: stateId,
        sourceItem,
        player: 'Captain',
        question,
    };
}
function bossIntentFromEvent(event) {
    return event.type === 'BOSS_INTENT' || event.type === 'BOSS_INTERRUPT' ? event.bossIntent : '';
}
function answerMatchesPending(context, event) {
    if (event.type !== 'BOSS_REPLY' || !context.pendingBossQuestion || !isNonEmptyString(event.answer)) {
        return false;
    }
    return event.questionId === undefined || event.questionId === context.pendingBossQuestion.questionId;
}
function bossInterrupts(ids) {
    return ids.map((id) => ({
        guard: 'isRoutingInterrupt',
        target: `#${id}`,
        reenter: true,
        actions: 'startRoutingFromBoss',
    }));
}
function resumableStates() {
    return [
        {
            guard: 'canResumeRouting',
            target: '#routing',
            actions: 'storeBossReply',
        },
        {
            guard: 'canResumeReassessing',
            target: '#reassessing',
            actions: 'storeBossReply',
        },
        {
            target: 'failed',
            actions: 'rememberInvalidBossReply',
        },
    ];
}
export const captainMachine = setup({
    types: {},
    actors: {
        captain: fromPromise(() => {
            throw new Error('captain actor must be provided by the runner');
        }),
        playbook: fromPromise(() => {
            throw new Error('playbook actor must be provided by the runner');
        }),
    },
    guards: {
        hasBossIntent: ({ event }) => event.type === 'BOSS_INTENT' && isNonEmptyString(event.bossIntent),
        isRoutingInterrupt: ({ event }) => event.type === 'BOSS_INTERRUPT' && event.targetId === 'routing' && isNonEmptyString(event.bossIntent),
        canResumeRouting: ({ context, event }) => answerMatchesPending(context, event) && context.pendingBossQuestion?.resumeStateId === 'routing',
        canResumeReassessing: ({ context, event }) => answerMatchesPending(context, event) && context.pendingBossQuestion?.resumeStateId === 'reassessing',
        isRoutingQuestion: ({ event }) => isRoutingQuestionOutput(outputFrom(event)),
        isRoutingDelegation: ({ context, event }) => {
            const output = outputFrom(event);
            return isDelegationOutput(output) && canEnterDynamicCall(context, output.nextPlaybookId, output.nextPlaybookInput);
        },
        isReassessFinal: ({ event }) => isFinalOutput(outputFrom(event)),
        isReassessQuestion: ({ event }) => isReassessQuestionOutput(outputFrom(event)),
        isReassessContinuing: ({ context, event }) => {
            const output = outputFrom(event);
            return (isContinuingOutput(output) &&
                output.remainingPlan.length < context.remainingPlan.length &&
                canEnterDynamicCall(context, output.nextPlaybookId, output.nextPlaybookInput));
        },
        isPlaybookSuccessOutput: ({ event }) => {
            const output = outputFrom(event);
            return output === undefined || isJsonValue(output);
        },
        isAuthoredChildError: ({ context, event }) => isValidPublicChildResult(errorFrom(event), context),
    },
    actions: {
        startRoutingFromBoss: assign(({ event }) => ({
            bossIntent: bossIntentFromEvent(event),
            remainingPlan: [],
            completedCallResults: [],
            nextPlaybookId: '',
            nextPlaybookInput: '',
            callHistory: [],
            response: undefined,
            pendingBossQuestion: undefined,
            bossReply: undefined,
            lastError: undefined,
        })),
        storeBossReply: assign(({ event }) => ({
            bossReply: event.type === 'BOSS_REPLY' ? event.answer : undefined,
            lastError: undefined,
        })),
        setRoutingQuestion: assign(({ event }) => {
            const output = outputFrom(event);
            return {
                pendingBossQuestion: isRoutingQuestionOutput(output) ? makePendingQuestion('routing', 'CAPTAIN-1', output.question) : undefined,
                bossReply: undefined,
            };
        }),
        storeRoutingDelegation: assign(({ context, event }) => {
            const output = outputFrom(event);
            if (!isDelegationOutput(output)) {
                return {};
            }
            return {
                remainingPlan: output.remainingPlan,
                nextPlaybookId: output.nextPlaybookId,
                nextPlaybookInput: output.nextPlaybookInput,
                callHistory: [...context.callHistory, callSignature(output.nextPlaybookId, output.nextPlaybookInput)],
                pendingBossQuestion: undefined,
                bossReply: undefined,
                lastError: undefined,
            };
        }),
        appendSuccessfulChildResult: assign(({ context, event }) => {
            const output = outputFrom(event);
            const result = isJsonValue(output)
                ? { playbookId: context.nextPlaybookId, status: 'ok', output }
                : { playbookId: context.nextPlaybookId, status: 'ok' };
            return {
                completedCallResults: [...context.completedCallResults, result],
                lastError: undefined,
            };
        }),
        appendRejectedChildResult: assign(({ context, event }) => {
            const error = errorFrom(event);
            const result = {
                playbookId: context.nextPlaybookId,
                status: childStatus(error),
                error: compactChildError(error),
            };
            return {
                completedCallResults: [...context.completedCallResults, result],
                lastError: undefined,
            };
        }),
        storeFinalResponse: assign(({ event }) => {
            const output = outputFrom(event);
            return isFinalOutput(output)
                ? {
                    response: output.response,
                    pendingBossQuestion: undefined,
                    bossReply: undefined,
                    lastError: undefined,
                }
                : {};
        }),
        setReassessQuestion: assign(({ event }) => {
            const output = outputFrom(event);
            return {
                pendingBossQuestion: isReassessQuestionOutput(output) ? makePendingQuestion('reassessing', 'CAPTAIN-3', output.question) : undefined,
                bossReply: undefined,
            };
        }),
        storeContinuingCall: assign(({ context, event }) => {
            const output = outputFrom(event);
            if (!isContinuingOutput(output)) {
                return {};
            }
            return {
                remainingPlan: output.remainingPlan,
                nextPlaybookId: output.nextPlaybookId,
                nextPlaybookInput: output.nextPlaybookInput,
                callHistory: [...context.callHistory, callSignature(output.nextPlaybookId, output.nextPlaybookInput)],
                pendingBossQuestion: undefined,
                bossReply: undefined,
                lastError: undefined,
            };
        }),
        rememberInvalidActorOutput: assign({
            lastError: () => ({ name: 'ActorOutputError', message: 'Actor output did not match any declared result contract.' }),
        }),
        rememberInvalidBossReply: assign({
            lastError: () => ({ name: 'BossReplyError', message: 'BOSS_REPLY did not match a pending question or carried an empty answer.' }),
        }),
        rememberActorError: assign(({ event }) => ({
            lastError: normalizeError(errorFrom(event)),
        })),
    },
}).createMachine({
    id: 'captain',
    initial: 'ready',
    context: ({ input }) => ({
        bossIntent: input.bossIntent ?? '',
        enabledPlaybooks: input.enabledPlaybooks,
        selfPlaybookId: input.selfPlaybookId,
        remainingPlan: [],
        completedCallResults: [],
        nextPlaybookId: '',
        nextPlaybookInput: '',
        callHistory: [],
    }),
    output: ({ context }) => ({
        response: context.response ?? '',
    }),
    on: {
        BOSS_INTERRUPT: bossInterrupts(['routing']),
    },
    states: {
        ready: {
            id: 'ready',
            description: 'Idle hub waiting for Boss to provide a new intent.',
            tags: ['playbook.parked'],
            meta: { playbook: { stateId: 'ready', description: 'Idle hub waiting for Boss to provide a new intent.' } },
            on: {
                BOSS_INTENT: {
                    guard: 'hasBossIntent',
                    target: 'routing',
                    actions: 'startRoutingFromBoss',
                },
            },
        },
        routing: {
            id: 'routing',
            description: 'Captain routes the Boss intent to a first enabled playbook or asks one routing question.',
            tags: ['playbook.busy'],
            meta: {
                playbook: {
                    stateId: 'routing',
                    description: 'Captain routes the Boss intent to a first enabled playbook or asks one routing question.',
                },
            },
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    ...{
                        stateId: 'routing',
                        sourceItem: 'CAPTAIN-1',
                        prompt: ROUTING_PROMPT,
                        result: ROUTING_RESULTS,
                        bossIntent: context.bossIntent,
                        enabledPlaybooks: context.enabledPlaybooks,
                    },
                    ...(context.pendingBossQuestion ? { pendingBossQuestion: context.pendingBossQuestion } : {}),
                    ...(context.bossReply ? { bossReply: context.bossReply } : {}),
                }),
                onDone: [
                    { guard: 'isRoutingQuestion', target: 'awaitBossReply', actions: 'setRoutingQuestion' },
                    { guard: 'isRoutingDelegation', target: 'callPlaybook', actions: 'storeRoutingDelegation' },
                    { target: 'failed', actions: 'rememberInvalidActorOutput' },
                ],
                onError: { target: 'failed', actions: 'rememberActorError' },
            },
        },
        callPlaybook: {
            id: 'callPlaybook',
            description: 'Captain calls the selected enabled playbook with the selected standalone request.',
            tags: ['playbook.suspended'],
            meta: {
                playbook: {
                    stateId: 'callPlaybook',
                    description: 'Captain calls the selected enabled playbook with the selected standalone request.',
                },
            },
            invoke: {
                src: 'playbook',
                input: ({ context }) => ({
                    stateId: 'callPlaybook',
                    sourceItem: 'CAPTAIN-2',
                    playbookId: context.nextPlaybookId,
                    text: context.nextPlaybookInput,
                    playbookIdContext: 'nextPlaybookId',
                    textContext: 'nextPlaybookInput',
                }),
                onDone: [
                    { guard: 'isPlaybookSuccessOutput', target: 'reassessing', actions: 'appendSuccessfulChildResult' },
                    { target: 'failed', actions: 'rememberInvalidActorOutput' },
                ],
                onError: [
                    { guard: 'isAuthoredChildError', target: 'reassessing', actions: 'appendRejectedChildResult' },
                    { target: 'failed', actions: 'rememberActorError' },
                ],
            },
        },
        reassessing: {
            id: 'reassessing',
            description: 'Captain reassesses the original intent, remaining plan, and completed call results.',
            tags: ['playbook.busy'],
            meta: {
                playbook: {
                    stateId: 'reassessing',
                    description: 'Captain reassesses the original intent, remaining plan, and completed call results.',
                },
            },
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    ...{
                        stateId: 'reassessing',
                        sourceItem: 'CAPTAIN-3',
                        prompt: REASSESS_PROMPT,
                        result: REASSESS_RESULTS,
                        bossIntent: context.bossIntent,
                        enabledPlaybooks: context.enabledPlaybooks,
                        remainingPlan: context.remainingPlan,
                        completedCallResults: context.completedCallResults,
                    },
                    ...(context.pendingBossQuestion ? { pendingBossQuestion: context.pendingBossQuestion } : {}),
                    ...(context.bossReply ? { bossReply: context.bossReply } : {}),
                }),
                onDone: [
                    { guard: 'isReassessFinal', target: 'done', actions: 'storeFinalResponse' },
                    { guard: 'isReassessQuestion', target: 'awaitBossReply', actions: 'setReassessQuestion' },
                    { guard: 'isReassessContinuing', target: 'callPlaybook', actions: 'storeContinuingCall' },
                    { target: 'failed', actions: 'rememberInvalidActorOutput' },
                ],
                onError: { target: 'failed', actions: 'rememberActorError' },
            },
        },
        awaitBossReply: {
            id: 'awaitBossReply',
            description: "Waiting for Boss to answer the acting agent's question.",
            tags: ['playbook.parked'],
            meta: {
                playbook: {
                    stateId: 'awaitBossReply',
                    description: "Waiting for Boss to answer the acting agent's question.",
                },
            },
            on: {
                BOSS_REPLY: resumableStates(),
                BOSS_INTENT: {
                    guard: 'hasBossIntent',
                    target: 'routing',
                    actions: 'startRoutingFromBoss',
                },
            },
        },
        failed: {
            id: 'failed',
            description: 'Recoverable failure retaining context for Boss recovery.',
            tags: ['playbook.parked'],
            meta: { playbook: { stateId: 'failed', description: 'Recoverable failure retaining context for Boss recovery.' } },
            on: {
                BOSS_INTENT: {
                    guard: 'hasBossIntent',
                    target: 'routing',
                    actions: 'startRoutingFromBoss',
                },
            },
        },
        done: {
            id: 'done',
            type: 'final',
            description: 'Captain completed with a concise response for Boss.',
            meta: { playbook: { stateId: 'done', description: 'Captain completed with a concise response for Boss.' } },
        },
    },
});
