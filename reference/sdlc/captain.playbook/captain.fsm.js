// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { assign, fromPromise, setup } from 'xstate';
const routingPrompt = [
    'Boss intent: <boss-intent>',
    'Enabled playbooks: <enabled-playbooks>',
    "Preserve Boss's intended outcome and constraints.",
    "Treat the enabled-playbooks catalog as immutable host input containing only each enabled callable playbook's stable id, command, and intent.",
    'Prefer a matching specialized playbook when delegation materially improves execution; otherwise handle the intent directly.',
    'Ask exactly one concise question only when its answer would materially change routing or call order.',
    'For a complex intent, divide it into the smallest finite ordered plan of useful playbook calls.',
    'Put only calls after the selected first call in remainingPlan.',
    'Keep the plan finite and ordered, and issue at most one child call at a time.',
    'Do not call a playbook merely to restate or classify the intent.',
    'Call only stable ids in the enabled-playbooks catalog, and never call this Captain playbook itself.',
    'Select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.',
    'Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.',
    'A direct decision shall carry a concise JSON-safe response and complete.',
    'A question decision shall carry one concise question and wait for Boss without losing the original intent.',
    'A delegation decision shall carry a finite remainingPlan plus non-empty nextPlaybookId and nextPlaybookInput for its first call.',
].join('\n');
const reassessmentPrompt = [
    'Boss intent: <boss-intent>',
    'Enabled playbooks: <enabled-playbooks>',
    'Remaining plan: <remaining-plan>',
    'Completed call results: <completed-call-results>',
    "Preserve Boss's intended outcome and constraints.",
    "Treat the enabled-playbooks catalog as immutable host input containing only each enabled callable playbook's stable id, command, and intent.",
    'Treat each returned result as evidence and revise the remaining plan when needed.',
    'A continuing decision must strictly reduce the remaining plan length.',
    "Each completed call result shall contain only the selected playbook id, its ok, aborted, or error status, and either the child's actual JSON-safe output or a compact error with only name and message.",
    'Never retain or expose a child session id, call id, child state, stack trace, or an opaque runtime result object.',
    'Treat a child abort or failure as a completed call result for reassessment; do not route this playbook directly to its generic failure state.',
    'Do not repeat an equivalent failed or completed call without new information.',
    'Keep the plan finite and ordered, and issue at most one child call at a time.',
    'If the intent is fulfilled, give Boss one concise final response.',
    'If information from Boss is now necessary, ask exactly one concise question.',
    'Otherwise select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.',
    'Call only stable ids in the enabled-playbooks catalog, and never call this Captain playbook itself.',
    'Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.',
    'A final decision shall carry a concise JSON-safe response and complete.',
    'A follow-up question shall carry one concise question and wait for Boss without losing the original intent, plan, or completed results.',
    'A continuing decision shall carry a strictly shorter finite remainingPlan plus non-empty nextPlaybookId and nextPlaybookInput.',
].join('\n');
const needsBossReplyDescription = "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";
const captainActor = fromPromise(async () => {
    throw new Error('captain actor must be provided by the runner');
});
const playbookActor = fromPromise(async () => {
    throw new Error('playbook actor must be provided by the runner');
});
function isPlainObject(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    if (Object.getOwnPropertySymbols(value).length !== 0)
        return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor && descriptor.enumerable);
}
function isJsonValue(value, seen = new Set()) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value))
        return false;
    seen.add(value);
    if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length)
            return false;
        return value.every((entry) => entry !== undefined && isJsonValue(entry, seen));
    }
    if (!isPlainObject(value))
        return false;
    return Object.values(value).every((entry) => entry !== undefined && isJsonValue(entry, seen));
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function isFinitePlan(value) {
    return Array.isArray(value) && isJsonValue(value);
}
function outputOf(event) {
    return isPlainObject(event) ? event.output : undefined;
}
function errorOf(event) {
    return isPlainObject(event) ? event.error : undefined;
}
function validResponse(event, guard) {
    const output = outputOf(event);
    return isPlainObject(output) && output.guard === guard && isNonEmptyString(output.response);
}
function validQuestion(event, guard) {
    const output = outputOf(event);
    return isPlainObject(output) && output.guard === guard && isNonEmptyString(output.question);
}
function validPlannedCall(event, guard) {
    const output = outputOf(event);
    return (isPlainObject(output) &&
        output.guard === guard &&
        isFinitePlan(output.remainingPlan) &&
        isNonEmptyString(output.nextPlaybookId) &&
        isNonEmptyString(output.nextPlaybookInput));
}
function callSignature(playbookId, text) {
    return `${playbookId}\u0000${text}`;
}
function validDynamicCall(context, event, guard) {
    if (!validPlannedCall(event, guard))
        return false;
    const output = outputOf(event);
    if (!isPlainObject(output))
        return false;
    const playbookId = output.nextPlaybookId;
    const text = output.nextPlaybookInput;
    return (playbookId !== context.selfPlaybookId &&
        context.enabledPlaybooks.some((entry) => entry.id === playbookId) &&
        !context.callSignatures.includes(callSignature(playbookId, text)));
}
function validContinuingCall(context, event) {
    if (!validDynamicCall(context, event, 'continuing'))
        return false;
    const output = outputOf(event);
    return (isPlainObject(output) &&
        Array.isArray(output.remainingPlan) &&
        output.remainingPlan.length < context.remainingPlan.length);
}
function normalizeError(value) {
    if (value instanceof Error) {
        return value.stack
            ? { name: value.name, message: value.message, stack: value.stack }
            : { name: value.name, message: value.message };
    }
    return { name: 'Error', message: typeof value === 'string' ? value : 'Unknown actor error' };
}
function authoredChildResult(event) {
    const outer = errorOf(event);
    if (!(outer instanceof Error))
        return undefined;
    const result = outer.result;
    if (!isPlainObject(result) || (result.status !== 'aborted' && result.status !== 'error'))
        return undefined;
    const normalized = result.error === undefined
        ? { name: result.status === 'aborted' ? 'AbortError' : 'Error', message: result.status === 'aborted' ? 'Child playbook aborted' : 'Child playbook failed' }
        : isPlainObject(result.error) && typeof result.error.name === 'string' && typeof result.error.message === 'string'
            ? { name: result.error.name, message: result.error.message }
            : normalizeError(result.error);
    return { status: result.status, error: { name: normalized.name, message: normalized.message } };
}
function captainInput(context, stateId, sourceItem, prompt, result) {
    const continuation = context.bossReplyActive &&
        context.pendingBossQuestion?.resumeStateId === stateId &&
        context.bossReply !== undefined
        ? { pendingBossQuestion: context.pendingBossQuestion, bossReply: context.bossReply }
        : {};
    return {
        stateId,
        sourceItem,
        prompt,
        result,
        bossIntent: context.bossIntent,
        enabledPlaybooks: context.enabledPlaybooks,
        ...(sourceItem === 'CAPTAIN-3'
            ? {
                remainingPlan: context.remainingPlan,
                completedCallResults: context.completedCallResults,
            }
            : {}),
        ...continuation,
    };
}
function bossInterrupts(ids) {
    return ids.map((id) => ({
        guard: ({ context, event }) => event.type === 'BOSS_INTERRUPT' &&
            event.targetId === id &&
            isNonEmptyString(event.bossIntent) &&
            isNonEmptyString(context.selfPlaybookId),
        target: `#${id}`,
        reenter: true,
        actions: 'setInterruptedIntent',
    }));
}
function resumableStates(ids) {
    return ids.map((id) => ({
        guard: ({ context, event }) => event.type === 'BOSS_REPLY' &&
            context.pendingBossQuestion?.resumeStateId === id &&
            (event.questionId === undefined || event.questionId === context.pendingBossQuestion.questionId) &&
            isNonEmptyString(event.answer),
        target: `#${id}`,
        actions: 'setBossReply',
    }));
}
export const captainMachine = setup({
    types: {
        context: {},
        events: {},
        input: {},
        output: {},
    },
    actors: {
        captain: captainActor,
        playbook: playbookActor,
    },
    actions: {
        setBossIntent: assign(({ event }) => {
            if (event.type !== 'BOSS_INTENT')
                return {};
            return {
                bossIntent: event.bossIntent,
                remainingPlan: [],
                completedCallResults: [],
                callSignatures: [],
                nextPlaybookId: undefined,
                nextPlaybookInput: undefined,
                response: undefined,
                pendingBossQuestion: undefined,
                bossReply: undefined,
                bossReplyActive: false,
                lastError: undefined,
            };
        }),
        setInterruptedIntent: assign(({ event }) => event.type === 'BOSS_INTERRUPT'
            ? {
                bossIntent: event.bossIntent,
                remainingPlan: [],
                completedCallResults: [],
                callSignatures: [],
                nextPlaybookId: undefined,
                nextPlaybookInput: undefined,
                response: undefined,
                pendingBossQuestion: undefined,
                bossReply: undefined,
                bossReplyActive: false,
                lastError: undefined,
            }
            : {}),
        rememberResponse: assign(({ event }) => {
            const output = outputOf(event);
            return isPlainObject(output) && isNonEmptyString(output.response)
                ? { response: output.response, bossReplyActive: false }
                : {};
        }),
        rememberPlannedCall: assign(({ context, event }) => {
            const output = outputOf(event);
            if (!isPlainObject(output) || !isFinitePlan(output.remainingPlan) || !isNonEmptyString(output.nextPlaybookId) || !isNonEmptyString(output.nextPlaybookInput))
                return {};
            return {
                remainingPlan: output.remainingPlan,
                nextPlaybookId: output.nextPlaybookId,
                nextPlaybookInput: output.nextPlaybookInput,
                callSignatures: [...context.callSignatures, callSignature(output.nextPlaybookId, output.nextPlaybookInput)],
                bossReplyActive: false,
            };
        }),
        setRoutingQuestion: assign(({ event }) => {
            const output = outputOf(event);
            return isPlainObject(output) && isNonEmptyString(output.question)
                ? {
                    pendingBossQuestion: {
                        questionId: 'routing',
                        resumeStateId: 'routing',
                        sourceItem: 'CAPTAIN-1',
                        player: 'Captain',
                        question: output.question,
                    },
                    bossReply: undefined,
                    bossReplyActive: false,
                }
                : {};
        }),
        setReassessmentQuestion: assign(({ event }) => {
            const output = outputOf(event);
            return isPlainObject(output) && isNonEmptyString(output.question)
                ? {
                    pendingBossQuestion: {
                        questionId: 'reassessing',
                        resumeStateId: 'reassessing',
                        sourceItem: 'CAPTAIN-3',
                        player: 'Captain',
                        question: output.question,
                    },
                    bossReply: undefined,
                    bossReplyActive: false,
                }
                : {};
        }),
        setBossReply: assign(({ event }) => event.type === 'BOSS_REPLY' && isNonEmptyString(event.answer)
            ? { bossReply: event.answer, bossReplyActive: true }
            : {}),
        clearBossReplyContext: assign({
            pendingBossQuestion: () => undefined,
            bossReply: () => undefined,
            bossReplyActive: () => false,
        }),
        appendSuccessfulCall: assign(({ context, event }) => {
            const output = outputOf(event);
            if (!isJsonValue(output) && output !== undefined)
                return {};
            const completed = output === undefined
                ? { playbookId: context.nextPlaybookId, status: 'ok' }
                : { playbookId: context.nextPlaybookId, status: 'ok', output: output };
            return { completedCallResults: [...context.completedCallResults, completed] };
        }),
        appendAuthoredChildFailure: assign(({ context, event }) => {
            const child = authoredChildResult(event);
            if (!child || !context.nextPlaybookId)
                return {};
            return {
                completedCallResults: [
                    ...context.completedCallResults,
                    { playbookId: context.nextPlaybookId, status: child.status, error: child.error },
                ],
            };
        }),
        rememberCaptainError: assign(({ event }) => ({ lastError: normalizeError(errorOf(event)) })),
        rememberPlaybookError: assign(({ event }) => ({ lastError: normalizeError(errorOf(event)) })),
        rememberMalformedOutput: assign(() => ({ lastError: { name: 'InvalidActorOutput', message: 'Actor returned malformed or unsupported output' } })),
        rememberInvalidCall: assign(() => ({ lastError: { name: 'InvalidPlaybookCall', message: 'Dynamic playbook call failed pre-invocation validation' } })),
        rememberInvalidBossReply: assign(() => ({ lastError: { name: 'InvalidBossReply', message: 'Boss reply was empty or did not match the pending question' } })),
    },
    guards: {
        routingDirect: ({ event }) => validResponse(event, 'direct'),
        routingQuestion: ({ event }) => validQuestion(event, 'question'),
        routingDelegation: ({ context, event }) => validDynamicCall(context, event, 'delegation'),
        routingNeedsBossReply: ({ event }) => validQuestion(event, 'needsBossReply'),
        finalResponse: ({ event }) => validResponse(event, 'final'),
        followUpQuestion: ({ event }) => validQuestion(event, 'followUpQuestion'),
        continuingCall: ({ context, event }) => validContinuingCall(context, event),
        reassessmentNeedsBossReply: ({ event }) => validQuestion(event, 'needsBossReply'),
        validChildOutput: ({ event }) => {
            const output = outputOf(event);
            return output === undefined || isJsonValue(output);
        },
        authoredChildFailure: ({ event }) => authoredChildResult(event) !== undefined,
        hasTerminalResponse: ({ context }) => isNonEmptyString(context.response),
        validBossIntent: ({ event }) => event.type === 'BOSS_INTENT' && isNonEmptyString(event.bossIntent),
    },
}).createMachine({
    id: 'captain',
    initial: 'ready',
    context: ({ input }) => ({
        selfPlaybookId: input.selfPlaybookId,
        enabledPlaybooks: input.enabledPlaybooks,
        remainingPlan: [],
        completedCallResults: [],
        callSignatures: [],
        bossReplyActive: false,
    }),
    output: ({ context }) => ({ response: context.response }),
    on: {
        BOSS_INTERRUPT: bossInterrupts(['routing']),
    },
    states: {
        ready: {
            id: 'ready',
            description: 'Waiting for Boss to provide an intent.',
            meta: { playbook: { stateId: 'ready', description: 'Waiting for Boss to provide an intent.' } },
            on: {
                BOSS_INTENT: [
                    { guard: 'validBossIntent', target: 'routing', actions: 'setBossIntent' },
                    { target: 'failed', actions: 'rememberMalformedOutput' },
                ],
            },
        },
        routing: {
            id: 'routing',
            description: 'Captain decides how to handle the Boss intent.',
            meta: { playbook: { stateId: 'routing', description: 'Captain decides how to handle the Boss intent.' } },
            tags: ['playbook.busy'],
            invoke: {
                src: 'captain',
                input: ({ context }) => captainInput(context, 'routing', 'CAPTAIN-1', routingPrompt, {
                    direct: 'Handle the intent directly; output includes `response`.',
                    question: 'Ask Boss one routing question; output includes `question`.',
                    delegation: 'Select the first call; output includes `remainingPlan`, `nextPlaybookId`, and `nextPlaybookInput`.',
                    needsBossReply: needsBossReplyDescription,
                }),
                onDone: [
                    { guard: 'routingDirect', target: 'finishing', actions: ['rememberResponse', 'clearBossReplyContext'] },
                    { guard: 'routingQuestion', target: 'awaitBossReply', actions: 'setRoutingQuestion' },
                    { guard: 'routingDelegation', target: 'callingPlaybook', actions: 'rememberPlannedCall' },
                    { guard: 'routingNeedsBossReply', target: 'awaitBossReply', actions: 'setRoutingQuestion' },
                    { target: 'failed', actions: 'rememberMalformedOutput' },
                ],
                onError: { target: 'failed', actions: 'rememberCaptainError' },
            },
        },
        callingPlaybook: {
            id: 'callingPlaybook',
            description: 'Waiting for the selected child playbook to return.',
            meta: { playbook: { stateId: 'callingPlaybook', description: 'Waiting for the selected child playbook to return.' } },
            tags: ['playbook.suspended'],
            invoke: {
                src: 'playbook',
                input: ({ context }) => ({
                    stateId: 'callingPlaybook',
                    sourceItem: 'CAPTAIN-2',
                    playbookId: context.nextPlaybookId,
                    text: context.nextPlaybookInput,
                    playbookIdContext: 'nextPlaybookId',
                    textContext: 'nextPlaybookInput',
                }),
                onDone: [
                    { guard: 'validChildOutput', target: 'reassessing', actions: 'appendSuccessfulCall' },
                    { target: 'failed', actions: 'rememberMalformedOutput' },
                ],
                onError: [
                    { guard: 'authoredChildFailure', target: 'reassessing', actions: 'appendAuthoredChildFailure' },
                    { target: 'failed', actions: 'rememberPlaybookError' },
                ],
            },
        },
        reassessing: {
            id: 'reassessing',
            description: 'Captain reassesses the intent after a child result.',
            meta: { playbook: { stateId: 'reassessing', description: 'Captain reassesses the intent after a child result.' } },
            tags: ['playbook.busy'],
            invoke: {
                src: 'captain',
                input: ({ context }) => captainInput(context, 'reassessing', 'CAPTAIN-3', reassessmentPrompt, {
                    final: 'Complete with a final response; output includes `response`.',
                    followUpQuestion: 'Ask Boss one follow-up question; output includes `question`.',
                    continuing: 'Continue with a revised call and a strictly shorter plan; output includes `remainingPlan`, `nextPlaybookId`, and `nextPlaybookInput`.',
                    needsBossReply: needsBossReplyDescription,
                }),
                onDone: [
                    { guard: 'finalResponse', target: 'finishing', actions: ['rememberResponse', 'clearBossReplyContext'] },
                    { guard: 'followUpQuestion', target: 'awaitBossReply', actions: 'setReassessmentQuestion' },
                    { guard: 'continuingCall', target: 'callingPlaybook', actions: 'rememberPlannedCall' },
                    { guard: 'reassessmentNeedsBossReply', target: 'awaitBossReply', actions: 'setReassessmentQuestion' },
                    { target: 'failed', actions: 'rememberMalformedOutput' },
                ],
                onError: { target: 'failed', actions: 'rememberCaptainError' },
            },
        },
        awaitBossReply: {
            id: 'awaitBossReply',
            description: "Waiting for Boss to answer the acting agent's question.",
            meta: { playbook: { stateId: 'awaitBossReply', description: "Waiting for Boss to answer the acting agent's question." } },
            tags: ['playbook.parked'],
            on: {
                BOSS_REPLY: [
                    ...resumableStates(['routing', 'reassessing']),
                    { target: 'failed', actions: 'rememberInvalidBossReply' },
                ],
                BOSS_INTENT: [
                    { guard: 'validBossIntent', target: 'routing', actions: 'setBossIntent' },
                    { target: 'failed', actions: 'rememberMalformedOutput' },
                ],
            },
        },
        finishing: {
            id: 'finishing',
            description: 'Validating the final Captain response.',
            meta: { playbook: { stateId: 'finishing', description: 'Validating the final Captain response.' } },
            always: [
                { guard: 'hasTerminalResponse', target: 'done' },
                { target: 'failed', actions: 'rememberMalformedOutput' },
            ],
        },
        failed: {
            id: 'failed',
            description: 'Stopped after an invalid result or actor failure and waiting for Boss recovery.',
            meta: { playbook: { stateId: 'failed', description: 'Stopped after an invalid result or actor failure and waiting for Boss recovery.' } },
            tags: ['playbook.parked'],
            on: {
                BOSS_INTENT: [
                    { guard: 'validBossIntent', target: 'routing', actions: 'setBossIntent' },
                    { target: 'failed', actions: 'rememberMalformedOutput' },
                ],
            },
        },
        done: {
            id: 'done',
            type: 'final',
            description: 'Captain completed with a JSON-safe response.',
            meta: { playbook: { stateId: 'done', description: 'Captain completed with a JSON-safe response.' } },
        },
    },
});
