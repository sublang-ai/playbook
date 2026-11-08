// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// FSM object artifact compiled from ./code.gears.md by gears2fsm.
// It declares only the machine, its actor contracts, and typed inputs; the
// linked runtime supplies the `player` and `playbook` actor implementations.
import { assign, fromPromise, setup } from 'xstate';
import { validatePlaybookCallResult } from '@sublang/playbook/xstate-runtime';
/** One role-id array per parallel group; CODE declares no parallel group. */
export const concurrentRoleSets = [];
/** The literal nested-call target shared by both call states and guards. */
const REVIEW_PLAYBOOK_ID = 'review';
// ---------------------------------------------------------------------------
// Prompts and result contracts (verbatim from code.gears.md)
// ---------------------------------------------------------------------------
const FIRST_PHASE_PROMPT = [
    'First determine whether the request starts a new change intent or continues an existing IR with unfinished work.',
    'If the request may continue an existing IR but does not identify it unambiguously, ask Boss before changing files.',
    '',
    'Treat standalone documentation or status maintenance that does not implement an identified unfinished IR task as a new change intent, even when it refers to an IR with no unfinished task.',
    'Do not invent or reopen an IR task, claim unperformed work complete, or infer an owner decision not supplied by the caller.',
    '',
    'For a new change intent, assess whether it can be completed well in one commit.',
    'If it can, implement and test it, update the affected specs, and ensure @specs/map.md remains accurate.',
    'If it cannot, decompose it into tasks sized to exactly one commit each, add a new IR under @specs/intents, and do not implement any IR task in this phase.',
    'Plan affected spec updates before, with, or after their corresponding code changes, either as standalone IR tasks or as explicit work within related tasks.',
    '',
    'For an existing IR with unfinished work, read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.',
    'Do not implement a later task in this phase.',
    "Mark the IR's progress and deliverables when relevant.",
    "After implementing an IR task, identify it and state whether any IR task still has unfinished Coder work; if so identify the next unfinished task, otherwise state this was the final IR task's Coder work.",
    "Report pending independent REVIEW, owner acceptance and later delivery/workshop steps separately; they imply an unfinished IR task only when the IR assigns that work to a remaining task.",
    "Report only what the IR and completed work establish, in ordinary prose without a required marker.",
    'If the IR will be finished after this phase, double-check that all acceptance criteria are met.',
    '',
    'Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.',
    '',
    'Keep to the original intent and follow what it asks.',
    'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
    "If a required Boss answer prevents completion of the current phase or IR task, ask that question and return without committing.",
    "Preserve permitted uncommitted work for the deferred continuation; do not create a partial or blocker-only commit to meet the one-commit requirement.",
    "After the answer allows completion, make exactly one phase-owned commit.",
    "When the phase is complete, make its minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.",
    'Make the commit message explain concisely what changed and why, including relevant verification.',
    'Identify every new commit you make.',
    'Credit every AI that contributed to this commit: Coder <coder-llm>.',
    '',
    '> Original request: <caller-input>',
    '> Run results: <run-results>',
].join('\n');
const IR_TASK_PHASE_PROMPT = [
    'Read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.',
    'Do not implement a later task in this phase.',
    "Mark the IR's progress and deliverables when relevant.",
    "After implementing an IR task, identify it and state whether any IR task still has unfinished Coder work; if so identify the next unfinished task, otherwise state this was the final IR task's Coder work.",
    "Report pending independent REVIEW, owner acceptance and later delivery/workshop steps separately; they imply an unfinished IR task only when the IR assigns that work to a remaining task.",
    "Report only what the IR and completed work establish, in ordinary prose without a required marker.",
    'If the IR will be finished after this phase, double-check that all acceptance criteria are met.',
    'The earlier phases of this intent await the one REVIEW that follows its final task; do not ask Boss to review or approve them.',
    '',
    'Keep to the original intent and follow what it asks.',
    'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
    "If a required Boss answer prevents completion of the current phase or IR task, ask that question and return without committing.",
    "Preserve permitted uncommitted work for the deferred continuation; do not create a partial or blocker-only commit to meet the one-commit requirement.",
    "After the answer allows completion, make exactly one phase-owned commit.",
    "When the phase is complete, make its minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.",
    'Make the commit message explain concisely what changed and why, including relevant verification.',
    'Identify every new commit you make.',
    'Credit every AI that contributed to this commit: Coder <coder-llm>.',
    '',
    '> Original request: <caller-input>',
    '> IR number: <ir-number>',
    '> Run results: <run-results>',
].join('\n');
const REVIEW_INTENT_TEMPLATE = [
    '> Original intent: <caller-input>',
    '> Review scope: every commit of this coding intent, namely <code-commits>, and its resulting repository state.',
    '> Coder output: <coder-output>',
    '',
    '> IR number: <ir-number>',
].join('\n');
const NEEDS_BOSS_REPLY_DESCRIPTION = "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";
const FIRST_PHASE_RESULT = {
    directCommit: "Coder completed the new change intent, including standalone documentation or status maintenance that does not implement an identified unfinished IR task (even when it refers to an IR with no unfinished task), as one direct implementation phase and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.",
    irCommit: "Coder decomposed the new change intent into a new IR, implemented no IR task, and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, and `irNumber` identifying the created IR.",
    moreTasks: "Coder continued an existing IR, implemented exactly its next unfinished task, made its one new commit, and at least one IR task remains unfinished; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.",
    finalTask: "Coder continued an existing IR, implemented its final unfinished task, and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.",
    needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
};
const IR_TASK_PHASE_RESULT = {
    moreTasks: "Coder implemented exactly the IR's next unfinished task, made its one new commit, and at least one IR task remains unfinished; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the IR, and `irTask` naming the implemented task.",
    finalTask: "Coder implemented the IR's final unfinished task and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the IR, and `irTask` naming the implemented task.",
    needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
};
const STATE_DESCRIPTIONS = {
    ready: 'Waiting for a coding request.',
    firstPhase: 'Coder runs the first phase: a direct change, a new IR, or an existing IR\'s next unfinished task.',
    irTaskPhase: "Coder implements the identified IR's next unfinished task.",
    reviewIntent: 'REVIEW examines every commit of this coding intent.',
    awaitBossReply: "Waiting for Boss to answer the acting agent's question.",
    failed: 'CODE parked after a control-plane failure and waits for Boss to restart or resume it.',
    reviewFailed: "CODE stopped because review did not pass the intent's commits and reports the failure with its last code-owned commit.",
    done: "CODE completed: the intent's review passed with no unsettled findings.",
};
const RESUME_METADATA = {
    firstPhase: { sourceItem: 'CODE-1' },
    irTaskPhase: { sourceItem: 'CODE-2' },
};
const REVIEW_NOT_PASSED = {
    name: 'ReviewNotPassed',
    message: 'review returned a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings.',
};
// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const doneOutputOf = (event) => isRecord(event) ? event.output : undefined;
const actorErrorOf = (event) => isRecord(event) ? event.error : undefined;
/** Narrows a player done event to the declared player output contract. */
function playerOutputOf(event) {
    const output = doneOutputOf(event);
    if (!isRecord(output))
        return undefined;
    switch (output.guard) {
        case 'directCommit':
            return isNonEmptyString(output.coderOutput) &&
                isNonEmptyString(output.latestCommit)
                ? {
                    guard: 'directCommit',
                    coderOutput: output.coderOutput,
                    latestCommit: output.latestCommit,
                }
                : undefined;
        case 'irCommit':
            return isNonEmptyString(output.coderOutput) &&
                isNonEmptyString(output.latestCommit) &&
                isNonEmptyString(output.irNumber)
                ? {
                    guard: 'irCommit',
                    coderOutput: output.coderOutput,
                    latestCommit: output.latestCommit,
                    irNumber: output.irNumber,
                }
                : undefined;
        case 'moreTasks':
        case 'finalTask':
            return isNonEmptyString(output.coderOutput) &&
                isNonEmptyString(output.latestCommit) &&
                isNonEmptyString(output.irNumber) &&
                isNonEmptyString(output.irTask)
                ? {
                    guard: output.guard,
                    coderOutput: output.coderOutput,
                    latestCommit: output.latestCommit,
                    irNumber: output.irNumber,
                    irTask: output.irTask,
                }
                : undefined;
        case 'needsBossReply':
            return isNonEmptyString(output.question)
                ? { guard: 'needsBossReply', question: output.question }
                : undefined;
        default:
            return undefined;
    }
}
/**
 * Strict JSON validation: null, booleans, finite numbers, strings, exact
 * arrays, and plain records of enumerable own data properties. Cycle
 * detection tracks only the active recursion path.
 */
function isJsonValue(value, path = new Set()) {
    if (value === null)
        return true;
    switch (typeof value) {
        case 'boolean':
        case 'string':
            return true;
        case 'number':
            return Number.isFinite(value);
        case 'object':
            break;
        default:
            return false;
    }
    const container = value;
    if (path.has(container))
        return false;
    path.add(container);
    try {
        if (Array.isArray(container)) {
            if (Object.getPrototypeOf(container) !== Array.prototype)
                return false;
            const keys = Reflect.ownKeys(container);
            if (keys.length !== container.length + 1)
                return false;
            const lengthDescriptor = Object.getOwnPropertyDescriptor(container, 'length');
            if (lengthDescriptor === undefined ||
                lengthDescriptor.configurable !== false ||
                lengthDescriptor.enumerable !== false ||
                lengthDescriptor.value !== container.length) {
                return false;
            }
            for (let index = 0; index < container.length; index += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(container, String(index));
                if (descriptor === undefined ||
                    !descriptor.enumerable ||
                    !('value' in descriptor) ||
                    !isJsonValue(descriptor.value, path)) {
                    return false;
                }
            }
            return true;
        }
        const prototype = Object.getPrototypeOf(container);
        if (prototype !== Object.prototype && prototype !== null)
            return false;
        for (const key of Reflect.ownKeys(container)) {
            if (typeof key !== 'string')
                return false;
            const descriptor = Object.getOwnPropertyDescriptor(container, key);
            if (descriptor === undefined ||
                !descriptor.enumerable ||
                !('value' in descriptor) ||
                !isJsonValue(descriptor.value, path)) {
                return false;
            }
        }
        return true;
    }
    finally {
        path.delete(container);
    }
}
/** Normalizes any thrown or malformed value to a JSON-safe error record. */
function errorRecord(value) {
    if (value instanceof Error) {
        return {
            name: value.name || 'Error',
            message: value.message,
            ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
        };
    }
    if (isRecord(value) && typeof value.message === 'string') {
        return {
            name: isNonEmptyString(value.name) ? value.name : 'Error',
            message: value.message,
        };
    }
    return { name: 'Error', message: String(value) };
}
// ---------------------------------------------------------------------------
// Nested `review` results
// ---------------------------------------------------------------------------
/**
 * Source-authored acceptance on `review`'s declared public output: the
 * result returns the exact evaluated repository revision and affirmatively
 * establishes that no unsettled findings remain. The shared bridge correlates
 * the result with the supplied review scope.
 */
function reviewPassOf(event) {
    const output = doneOutputOf(event);
    if (!isRecord(output))
        return undefined;
    return output.noUnsettledFindings === true &&
        isNonEmptyString(output.evaluatedRevision)
        ? { noUnsettledFindings: true, evaluatedRevision: output.evaluatedRevision }
        : undefined;
}
/**
 * Recognizes an authored rejected child result: an aborted or error call, or
 * a child that completed at its own authored failure terminal.
 */
export function authoredChildResult(error, expectedPlaybookId) {
    if (!(error instanceof Error))
        return undefined;
    try {
        const result = validatePlaybookCallResult(error.result, expectedPlaybookId);
        return result.status !== 'ok' || result.terminal?.kind === 'failure'
            ? result
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** Compact evidence and reported error for an authored review failure. */
function authoredReviewFailureOf(event) {
    const result = authoredChildResult(actorErrorOf(event), REVIEW_PLAYBOOK_ID);
    if (result === undefined)
        return undefined;
    if (result.status === 'ok') {
        const description = result.terminal?.description;
        return {
            evidence: {
                playbookId: REVIEW_PLAYBOOK_ID,
                status: 'ok',
                ...(result.output === undefined ? {} : { output: result.output }),
            },
            error: {
                name: 'ReviewFailed',
                message: isNonEmptyString(description)
                    ? `review ended at its authored failure terminal: ${description}`
                    : 'review ended at its authored failure terminal.',
            },
        };
    }
    const error = result.error !== undefined
        ? { name: result.error.name, message: result.error.message }
        : { name: 'AbortError', message: 'The review call was aborted.' };
    return {
        evidence: { playbookId: REVIEW_PLAYBOOK_ID, status: result.status, error },
        error,
    };
}
// ---------------------------------------------------------------------------
// Nested call text composition (quoted relays)
// ---------------------------------------------------------------------------
const REVIEW_PLACEHOLDER = /<caller-input>|<code-commits>|<coder-output>|<ir-number>/g;
/**
 * Composes review call text in one callback pass per template line: a quoted
 * relay line whose value is empty contributes no line, a multi-line value is
 * quoted line by line, and an absent value keeps its placeholder literal.
 */
function composeReviewText(template, values) {
    const lines = [];
    for (const line of template.split('\n')) {
        const quoted = line.startsWith('> ');
        const tokens = line.match(REVIEW_PLACEHOLDER) ?? [];
        if (quoted && tokens.some((token) => values[token] === ''))
            continue;
        lines.push(line.replace(REVIEW_PLACEHOLDER, (token) => {
            const value = values[token];
            if (value === undefined)
                return token;
            return quoted ? value.split('\n').join('\n> ') : value;
        }));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return lines.join('\n');
}
const acceptsOutcome = (outcome) => ({ event }) => playerOutputOf(event)?.guard === outcome;
const needsBossReplyWithQuestion = ({ event }) => playerOutputOf(event)?.guard === 'needsBossReply';
// The review state is entered only through an accepting final-phase arm, which
// records the phase outcome and the run's non-empty code-owned commits.
const reviewPassed = ({ context, event }) => (context.phaseOutcome === 'directCommit' ||
    context.phaseOutcome === 'finalTask') &&
    isNonEmptyString(context.codeCommit) &&
    reviewPassOf(event) !== undefined;
const authoredReviewFailure = ({ event }) => authoredReviewFailureOf(event) !== undefined;
const validStartCode = ({ event }) => event.type === 'START_CODE' &&
    isNonEmptyString(event.callerInput) &&
    (event.runResults === undefined || typeof event.runResults === 'string');
const repliesToPendingQuestion = ({ context, event }) => event.type === 'BOSS_REPLY' &&
    context.pendingBossQuestion !== undefined &&
    (event.questionId === undefined ||
        event.questionId === context.pendingBossQuestion.questionId);
const emptyBossReply = (args) => repliesToPendingQuestion(args) &&
    args.event.type === 'BOSS_REPLY' &&
    !isNonEmptyString(args.event.answer);
const INTERRUPT_PRECONDITIONS = {
    firstPhase: (context) => isNonEmptyString(context.callerInput),
    irTaskPhase: (context) => isNonEmptyString(context.callerInput) &&
        isNonEmptyString(context.irNumber),
};
// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------
/** One guarded root transition per jumpable state. */
function bossInterrupts(ids) {
    return ids.map((id) => ({
        guard: ({ context, event }) => event.type === 'BOSS_INTERRUPT' &&
            event.targetId === id &&
            INTERRUPT_PRECONDITIONS[id](context),
        target: `#${id}`,
        reenter: true,
        actions: 'resetForInterrupt',
    }));
}
/** One guarded `BOSS_REPLY` resume transition per suspended working leaf. */
function resumableStates(ids) {
    return ids.map((id) => ({
        guard: (args) => repliesToPendingQuestion(args) &&
            args.event.type === 'BOSS_REPLY' &&
            isNonEmptyString(args.event.answer) &&
            args.context.pendingBossQuestion?.resumeStateId === id,
        target: `#${id}`,
        reenter: true,
        actions: 'rememberBossReply',
    }));
}
const bossReplyFields = (context) => ({
    ...(context.pendingBossQuestion !== undefined
        ? { pendingBossQuestion: context.pendingBossQuestion }
        : {}),
    ...(context.bossReply !== undefined ? { bossReply: context.bossReply } : {}),
});
const acceptedOutcome = (source, target, outcome) => ({
    type: 'playbook.acceptedOutcome',
    params: { source, target, acceptedOutcome: outcome },
});
// A nonfinal phase continues to the next IR task; the direct phase and the
// final task reach the one review. The IR-task leaf reenters itself so its
// player actor restarts for the next task.
const acceptPhaseArm = (source, outcome, guard, target) => ({
    guard,
    target: `#${target}`,
    ...(target === source ? { reenter: true } : {}),
    actions: [
        acceptedOutcome(source, target, outcome),
        'rememberPhaseCommit',
        'clearBossReplyContext',
    ],
});
const suspendArm = (source) => ({
    guard: 'needsBossReplyWithQuestion',
    target: '#awaitBossReply',
    actions: [
        acceptedOutcome(source, 'awaitBossReply', 'needsBossReply'),
        { type: 'setPendingBossQuestion', params: { resumeStateId: source } },
    ],
});
const malformedPlayerOutputArm = {
    target: '#failed',
    actions: ['rememberMalformedPlayerOutput', 'clearBossReplyContext'],
};
const playerOnError = {
    target: '#failed',
    actions: ['rememberActorError', 'clearBossReplyContext'],
};
const reviewOnError = [
    {
        guard: 'authoredReviewFailure',
        target: '#reviewFailed',
        actions: 'rememberAuthoredReviewFailure',
    },
    { target: '#failed', actions: 'rememberActorError' },
];
const meta = (stateId, role) => ({
    playbook: {
        stateId,
        description: STATE_DESCRIPTIONS[stateId],
        ...(role === undefined ? {} : { role }),
    },
});
const finalMeta = (stateId, terminal) => ({
    playbook: {
        stateId,
        description: STATE_DESCRIPTIONS[stateId],
        terminal,
    },
});
// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------
export const codeMachine = setup({
    types: {
        context: {},
        events: {},
        input: {},
        output: {},
    },
    actors: {
        player: fromPromise(async () => {
            throw new Error('player actor must be provided by the runner');
        }),
        playbook: fromPromise(async () => {
            throw new Error('playbook actor must be provided by the runner');
        }),
    },
    actions: {
        'playbook.acceptedOutcome': (_args, _params) => undefined,
        startCode: assign(({ context, event }) => event.type === 'START_CODE'
            ? {
                callerInput: event.callerInput,
                runResults: event.runResults ?? context.runResults,
                codeCommit: undefined,
                codeCommits: [],
                coderOutput: undefined,
                irNumber: undefined,
                irTask: undefined,
                phaseOutcome: undefined,
                evaluatedRevision: undefined,
                reviewError: undefined,
                reviewEvidence: undefined,
                lastError: undefined,
                pendingBossQuestion: undefined,
                bossReply: undefined,
            }
            : {}),
        resetForInterrupt: assign({
            phaseOutcome: undefined,
            evaluatedRevision: undefined,
            reviewError: undefined,
            reviewEvidence: undefined,
            lastError: undefined,
            pendingBossQuestion: undefined,
            bossReply: undefined,
        }),
        rememberPhaseCommit: assign(({ context, event }) => {
            const output = playerOutputOf(event);
            if (output === undefined || output.guard === 'needsBossReply')
                return {};
            return {
                codeCommit: output.latestCommit,
                codeCommits: [...(context.codeCommits ?? []), output.latestCommit],
                coderOutput: output.coderOutput,
                phaseOutcome: output.guard,
                irNumber: output.guard === 'directCommit' ? undefined : output.irNumber,
                irTask: output.guard === 'moreTasks' || output.guard === 'finalTask'
                    ? output.irTask
                    : undefined,
                lastError: undefined,
            };
        }),
        setPendingBossQuestion: assign(({ event }, params) => {
            const output = playerOutputOf(event);
            if (output?.guard !== 'needsBossReply')
                return {};
            const pendingBossQuestion = {
                questionId: params.resumeStateId,
                resumeStateId: params.resumeStateId,
                sourceItem: RESUME_METADATA[params.resumeStateId].sourceItem,
                asker: { kind: 'role', roleId: 'coder' },
                question: output.question,
            };
            return { pendingBossQuestion, bossReply: undefined, lastError: undefined };
        }),
        rememberBossReply: assign(({ event }) => event.type === 'BOSS_REPLY' ? { bossReply: event.answer } : {}),
        clearBossReplyContext: assign({
            pendingBossQuestion: undefined,
            bossReply: undefined,
        }),
        rememberReviewPass: assign(({ event }) => {
            const pass = reviewPassOf(event);
            return pass === undefined
                ? {}
                : { evaluatedRevision: pass.evaluatedRevision, lastError: undefined };
        }),
        rememberReviewNotPassed: assign(({ event }) => {
            const output = doneOutputOf(event);
            const reviewEvidence = {
                playbookId: REVIEW_PLAYBOOK_ID,
                status: 'ok',
                ...(isJsonValue(output) ? { output } : {}),
            };
            return { reviewEvidence, reviewError: REVIEW_NOT_PASSED, lastError: undefined };
        }),
        rememberAuthoredReviewFailure: assign(({ event }) => {
            const failure = authoredReviewFailureOf(event);
            return failure === undefined
                ? {}
                : {
                    reviewEvidence: failure.evidence,
                    reviewError: failure.error,
                    lastError: undefined,
                };
        }),
        rememberActorError: assign(({ event }) => ({
            lastError: errorRecord(actorErrorOf(event)),
        })),
        rememberMalformedPlayerOutput: assign(({ event }) => {
            const output = doneOutputOf(event);
            return {
                lastError: {
                    name: 'MalformedPlayerOutput',
                    message: isRecord(output) && output.guard === 'needsBossReply'
                        ? 'Coder output declared needsBossReply without a question.'
                        : 'Coder output did not match an outcome declared for the working state.',
                },
            };
        }),
        rememberMalformedBossReply: assign({
            lastError: {
                name: 'MalformedBossReply',
                message: 'BOSS_REPLY carried an empty answer.',
            },
        }),
    },
    guards: {
        needsBossReplyWithQuestion,
        acceptDirectCommit: acceptsOutcome('directCommit'),
        acceptIrCommit: acceptsOutcome('irCommit'),
        acceptMoreTasks: acceptsOutcome('moreTasks'),
        acceptFinalTask: acceptsOutcome('finalTask'),
        reviewPassed,
        authoredReviewFailure,
        validStartCode,
        emptyBossReply,
    },
}).createMachine({
    id: 'code',
    initial: 'ready',
    context: ({ input }) => ({
        runResults: typeof input?.runResults === 'string' ? input.runResults : '',
        codeCommits: [],
    }),
    output: ({ context }) => {
        if (!isNonEmptyString(context.codeCommit)) {
            throw new Error('CODE reached a final state without its last code-owned commit');
        }
        if (context.reviewError !== undefined) {
            return {
                status: 'review-failed',
                lastCodeCommit: context.codeCommit,
                error: context.reviewError,
            };
        }
        if (!isNonEmptyString(context.evaluatedRevision)) {
            throw new Error('CODE completed without the final evaluated revision');
        }
        return {
            status: 'complete',
            lastCodeCommit: context.codeCommit,
            finalEvaluatedRevision: context.evaluatedRevision,
            allReviewsPassed: true,
        };
    },
    on: {
        BOSS_INTERRUPT: bossInterrupts(['firstPhase', 'irTaskPhase']),
    },
    states: {
        ready: {
            id: 'ready',
            tags: 'playbook.parked',
            description: STATE_DESCRIPTIONS.ready,
            meta: meta('ready'),
            on: {
                START_CODE: {
                    guard: 'validStartCode',
                    target: 'firstPhase',
                    actions: 'startCode',
                },
            },
        },
        firstPhase: {
            id: 'firstPhase',
            tags: 'playbook.busy',
            description: STATE_DESCRIPTIONS.firstPhase,
            meta: meta('firstPhase', 'coder'),
            invoke: {
                src: 'player',
                input: ({ context }) => ({
                    stateId: 'firstPhase',
                    role: 'coder',
                    sourceItem: 'CODE-1',
                    prompt: FIRST_PHASE_PROMPT,
                    result: FIRST_PHASE_RESULT,
                    ...(context.callerInput !== undefined
                        ? { callerInput: context.callerInput }
                        : {}),
                    runResults: context.runResults,
                    ...bossReplyFields(context),
                }),
                onDone: [
                    suspendArm('firstPhase'),
                    acceptPhaseArm('firstPhase', 'directCommit', 'acceptDirectCommit', 'reviewIntent'),
                    acceptPhaseArm('firstPhase', 'irCommit', 'acceptIrCommit', 'irTaskPhase'),
                    acceptPhaseArm('firstPhase', 'moreTasks', 'acceptMoreTasks', 'irTaskPhase'),
                    acceptPhaseArm('firstPhase', 'finalTask', 'acceptFinalTask', 'reviewIntent'),
                    malformedPlayerOutputArm,
                ],
                onError: playerOnError,
            },
        },
        irTaskPhase: {
            id: 'irTaskPhase',
            tags: 'playbook.busy',
            description: STATE_DESCRIPTIONS.irTaskPhase,
            meta: meta('irTaskPhase', 'coder'),
            invoke: {
                src: 'player',
                input: ({ context }) => ({
                    stateId: 'irTaskPhase',
                    role: 'coder',
                    sourceItem: 'CODE-2',
                    prompt: IR_TASK_PHASE_PROMPT,
                    result: IR_TASK_PHASE_RESULT,
                    ...(context.callerInput !== undefined
                        ? { callerInput: context.callerInput }
                        : {}),
                    ...(context.irNumber !== undefined
                        ? { irNumber: context.irNumber }
                        : {}),
                    runResults: context.runResults,
                    ...bossReplyFields(context),
                }),
                onDone: [
                    suspendArm('irTaskPhase'),
                    acceptPhaseArm('irTaskPhase', 'moreTasks', 'acceptMoreTasks', 'irTaskPhase'),
                    acceptPhaseArm('irTaskPhase', 'finalTask', 'acceptFinalTask', 'reviewIntent'),
                    malformedPlayerOutputArm,
                ],
                onError: playerOnError,
            },
        },
        reviewIntent: {
            id: 'reviewIntent',
            tags: 'playbook.suspended',
            description: STATE_DESCRIPTIONS.reviewIntent,
            meta: meta('reviewIntent'),
            invoke: {
                src: 'playbook',
                input: ({ context }) => ({
                    stateId: 'reviewIntent',
                    sourceItem: 'CODE-3',
                    playbookId: REVIEW_PLAYBOOK_ID,
                    text: composeReviewText(REVIEW_INTENT_TEMPLATE, {
                        '<caller-input>': context.callerInput,
                        '<code-commits>': (context.codeCommits ?? []).join(', '),
                        '<coder-output>': context.coderOutput,
                        // An IR relays its number; a direct intent contributes no line.
                        '<ir-number>': context.irNumber ?? '',
                    }),
                }),
                onDone: [
                    {
                        guard: 'reviewPassed',
                        target: 'done',
                        actions: 'rememberReviewPass',
                    },
                    { target: 'reviewFailed', actions: 'rememberReviewNotPassed' },
                ],
                onError: reviewOnError,
            },
        },
        awaitBossReply: {
            id: 'awaitBossReply',
            tags: 'playbook.parked',
            description: STATE_DESCRIPTIONS.awaitBossReply,
            meta: meta('awaitBossReply'),
            on: {
                BOSS_REPLY: [
                    {
                        guard: 'emptyBossReply',
                        target: 'failed',
                        actions: ['rememberMalformedBossReply', 'clearBossReplyContext'],
                    },
                    ...resumableStates(['firstPhase', 'irTaskPhase']),
                ],
                START_CODE: {
                    guard: 'validStartCode',
                    target: 'firstPhase',
                    actions: 'startCode',
                },
            },
        },
        failed: {
            id: 'failed',
            tags: 'playbook.parked',
            description: STATE_DESCRIPTIONS.failed,
            meta: meta('failed'),
            on: {
                START_CODE: {
                    guard: 'validStartCode',
                    target: 'firstPhase',
                    actions: 'startCode',
                },
            },
        },
        reviewFailed: {
            id: 'reviewFailed',
            type: 'final',
            description: STATE_DESCRIPTIONS.reviewFailed,
            meta: finalMeta('reviewFailed', 'failure'),
        },
        done: {
            id: 'done',
            type: 'final',
            description: STATE_DESCRIPTIONS.done,
            meta: finalMeta('done', 'success'),
        },
    },
});
export default codeMachine;
