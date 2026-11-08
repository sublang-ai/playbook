// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// FSM object artifact compiled from ./review.gears.md by gears2fsm.
// It declares only the machine, its actor contracts, and typed inputs; the
// linked runtime supplies the `player` actor implementation.
import { assign, fromPromise, setup } from 'xstate';
/** One role-id array per parallel group; REVIEW declares no parallel group. */
export const concurrentRoleSets = [];
// ---------------------------------------------------------------------------
// Machine input, context, events, and output
// ---------------------------------------------------------------------------
/** Reviewer rounds REVIEW runs at most: the first and one after each of two Coder dispositions. */
export const MAX_REVIEW_ROUNDS = 3;
// ---------------------------------------------------------------------------
// Prompts and result contracts (verbatim from review.gears.md)
// ---------------------------------------------------------------------------
const FIRST_REVIEW_PROMPT = [
    'A new review begins for the review scope.',
    'Keep to the original intent and follow what it asks.',
    'When the scope names commits, read each commit message for its context and rationale; otherwise use repository history and commit messages wherever they help establish that context.',
    '',
    'Understand the full picture and think systematically about the underlying design.',
    'Continue to identify issues or improvements, if any, without duplication.',
    'Number the findings consistently across rounds.',
    'Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.',
    'For specs, flag stale, missing, over-specified, or under-specified ones, if any.',
    'Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.',
    '',
    'If an issue represents a class of defect, find every instance within the review scope worth fixing rather than surfacing one or two per round, which drags out the review.',
    'For any rebuttal, accept or challenge it.',
    'Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.',
    '',
    'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
    'Do not edit files or commit; report findings only.',
    '',
    'Consult @specs/map.md for context if needed; verify it remains accurate.',
    'Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.',
    '',
    '> Original request: <caller-input>',
].join('\n');
const FIX_FINDINGS_PROMPT = [
    'For each review item, accept or reject it.',
    'Before deciding, understand the full picture and think systematically about the underlying design.',
    'Keep to the original intent and follow what it asks.',
    'Reject anything that is not essential or is not worth fixing now.',
    'If you accept an item, fix its root cause, including any fundamental design flaw — do not patch around it; if it represents a class of defect, find every instance within the review scope worth fixing rather than addressing one or two per round, which drags out the review.',
    'If you reject an item, give the reasoning and cite code or test output that supports it.',
    'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
    '',
    'If you accept any item, make minimal changes and add one new review-fix commit; never rewrite any existing commit.',
    'Follow @specs/packages/git.md.',
    'Make the commit message explain concisely what changed and why, including relevant verification.',
    'Identify every new commit you make.',
    'Credit every AI that contributed to this commit: Coder <coder-llm> and Reviewer <reviewer-llm>, whose findings it answers.',
    '',
    'If you reject every item, change nothing and make no commit.',
    'Report every disposition, all relevant run results, and every rebuttal.',
    '',
    '> Original request: <caller-input>',
    '> Reviewer findings: <reviewer-output>',
].join('\n');
const REVIEW_AFTER_FIX_PROMPT = [
    'A new review round begins for the review scope in the cumulative committed state, with particular attention to the latest review-fix commit.',
    'Keep to the original intent and follow what it asks.',
    "Read the latest review-fix commit's message and see Coder's feedback below.",
    '',
    'Understand the full picture and think systematically about the underlying design.',
    'Continue to identify issues or improvements, if any, without duplication.',
    'Number the findings consistently across rounds.',
    'Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.',
    'For specs, flag stale, missing, over-specified, or under-specified ones, if any.',
    'Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.',
    '',
    'If an issue represents a class of defect, find every instance within the review scope worth fixing rather than surfacing one or two per round, which drags out the review.',
    'For any rebuttal, accept or challenge it.',
    'Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.',
    '',
    'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
    'Do not edit files or commit; report findings only.',
    '',
    'Consult @specs/map.md for context if needed; verify it remains accurate.',
    'Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.',
    '',
    '> Original request: <caller-input>',
    '> Latest commit: <latest-commit>',
    '> Coder output: <coder-output>',
].join('\n');
const REVIEW_AFTER_REJECTION_PROMPT = [
    'No new commit was made because Coder rejected every finding.',
    "See Coder's feedback below.",
    '',
    'Understand the full picture and think systematically about the underlying design.',
    'Continue to identify issues or improvements, if any, without duplication.',
    'Number the findings consistently across rounds.',
    'Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.',
    'For specs, flag stale, missing, over-specified, or under-specified ones, if any.',
    'Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.',
    '',
    'If an issue represents a class of defect, find every instance within the review scope worth fixing rather than surfacing one or two per round, which drags out the review.',
    'For any rebuttal, accept or challenge it.',
    'Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.',
    '',
    'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
    'Do not edit files or commit; report findings only.',
    '',
    'Consult @specs/map.md for context if needed; verify it remains accurate.',
    'Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.',
    '',
    '> Original request: <caller-input>',
    '> Coder output: <coder-output>',
].join('\n');
const NEEDS_BOSS_REPLY_DESCRIPTION = "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";
const FIRST_REVIEW_RESULT = {
    hasFindings: "Reviewer raised one or more unsettled findings; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. Output shall include `reviewerOutput: <verbatim final text>`.",
    noFindings: "Reviewer affirmatively reported that the requested review is complete and no unsettled findings remain; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. On this outcome the workflow returns the exact repository revision at which the review scope was evaluated, taken from repository authority and not from either player's prose, as evaluatedRevision, and the fact that no unsettled findings remain within that scope, as noUnsettledFindings true. Output shall include `evaluatedRevision: <repository revision>`.",
    needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
};
const FIX_FINDINGS_RESULT = {
    committed: "Coder made one new review-fix commit; the outcome does not depend on finding numbering or any fixed presentation format of Coder's reply. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.",
    rejectedAll: "Coder rejected every finding, changed nothing, and made no commit; the outcome does not depend on finding numbering or any fixed presentation format of Coder's reply. Output shall include `coderOutput: <verbatim final text>`.",
    needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
};
const LATER_REVIEW_RESULT = {
    hasFindings: "Reviewer raised or kept one or more unsettled findings; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. Output shall include `reviewerOutput: <verbatim final text>`.",
    noFindings: "Reviewer affirmatively reported that the requested review is complete and no unsettled findings remain; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. On this outcome the workflow returns the exact repository revision at which the review scope was evaluated, taken from repository authority and not from either player's prose, as evaluatedRevision, and the fact that no unsettled findings remain within that scope, as noUnsettledFindings true. Output shall include `evaluatedRevision: <repository revision>`.",
    needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
};
/** REVIEW-3's authored result contract (identical to REVIEW-4's). */
const REVIEW_AFTER_FIX_RESULT = LATER_REVIEW_RESULT;
/** REVIEW-4's authored result contract (identical to REVIEW-3's). */
const REVIEW_AFTER_REJECTION_RESULT = LATER_REVIEW_RESULT;
const STATE_DESCRIPTIONS = {
    ready: 'Waiting for a caller to start a review.',
    firstReview: 'Reviewer runs the first review round over the review scope.',
    fixFindings: "Coder accepts or rejects each of Reviewer's findings and commits any accepted fixes.",
    reviewAfterFix: 'Reviewer runs the next review round over the cumulative committed state after a review-fix commit.',
    reviewAfterRejection: 'Reviewer runs the next review round after Coder rejected every finding without a commit.',
    awaitBossReply: "Waiting for Boss to answer the acting agent's question.",
    failed: 'REVIEW parked after a failure and waits for Boss to restart or resume it.',
    done: 'REVIEW completed: the review scope was evaluated at the returned revision and no unsettled findings remain.',
    unsettled: 'REVIEW stopped after its third round: findings remain unsettled within the review scope, and no further fix round runs.',
};
const RESUME_METADATA = {
    firstReview: { sourceItem: 'REVIEW-1', role: 'reviewer' },
    fixFindings: { sourceItem: 'REVIEW-2', role: 'coder' },
    reviewAfterFix: { sourceItem: 'REVIEW-3', role: 'reviewer' },
    reviewAfterRejection: { sourceItem: 'REVIEW-4', role: 'reviewer' },
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
        case 'hasFindings':
            return isNonEmptyString(output.reviewerOutput)
                ? { guard: 'hasFindings', reviewerOutput: output.reviewerOutput }
                : undefined;
        case 'noFindings':
            return isNonEmptyString(output.evaluatedRevision)
                ? { guard: 'noFindings', evaluatedRevision: output.evaluatedRevision }
                : undefined;
        case 'committed':
            return isNonEmptyString(output.coderOutput) &&
                isNonEmptyString(output.latestCommit)
                ? {
                    guard: 'committed',
                    coderOutput: output.coderOutput,
                    latestCommit: output.latestCommit,
                }
                : undefined;
        case 'rejectedAll':
            return isNonEmptyString(output.coderOutput)
                ? { guard: 'rejectedAll', coderOutput: output.coderOutput }
                : undefined;
        case 'needsBossReply':
            return isNonEmptyString(output.question)
                ? { guard: 'needsBossReply', question: output.question }
                : undefined;
        default:
            return undefined;
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
const acceptsOutcome = (outcome) => ({ event }) => playerOutputOf(event)?.guard === outcome;
/** The round in progress; a context from before the bound counts as the first. */
const roundOf = (context) => context.round ?? 1;
// A later round routes findings by its ordinal: Coder answers them before the
// third round, and the third round's findings stay unsettled.
const acceptHasFindingsBeforeBound = ({ context, event }) => playerOutputOf(event)?.guard === 'hasFindings' &&
    roundOf(context) < MAX_REVIEW_ROUNDS;
const acceptHasFindingsAtBound = ({ context, event }) => playerOutputOf(event)?.guard === 'hasFindings' &&
    roundOf(context) >= MAX_REVIEW_ROUNDS;
// The entry guard validates the text the current event supplies, before the
// entry action copies it into context.
const validStartReview = ({ event }) => event.type === 'START_REVIEW' && isNonEmptyString(event.callerInput);
const repliesToPendingQuestion = ({ context, event }) => event.type === 'BOSS_REPLY' &&
    context.pendingBossQuestion !== undefined &&
    (event.questionId === undefined ||
        event.questionId === context.pendingBossQuestion.questionId);
const emptyBossReply = (args) => repliesToPendingQuestion(args) &&
    args.event.type === 'BOSS_REPLY' &&
    !isNonEmptyString(args.event.answer);
/** Typed context each jumpable working leaf needs to be entered safely. */
const INTERRUPT_PRECONDITIONS = {
    firstReview: (context) => isNonEmptyString(context.callerInput),
    fixFindings: (context) => isNonEmptyString(context.callerInput) &&
        isNonEmptyString(context.reviewerOutput),
    reviewAfterFix: (context) => isNonEmptyString(context.callerInput) &&
        context.coderOutcome === 'committed' &&
        isNonEmptyString(context.latestCommit) &&
        isNonEmptyString(context.coderOutput),
    reviewAfterRejection: (context) => isNonEmptyString(context.callerInput) &&
        context.coderOutcome === 'rejectedAll' &&
        isNonEmptyString(context.coderOutput),
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
/** Reviewer found unsettled findings: Coder answers them next (REVIEW-2). */
const hasFindingsArm = (source, guard = 'acceptHasFindings') => ({
    guard,
    target: '#fixFindings',
    actions: [
        acceptedOutcome(source, 'fixFindings', 'hasFindings'),
        'rememberFindings',
        'clearBossReplyContext',
    ],
});
/** Reviewer kept findings at the third round: they stay unsettled (DR-102). */
const unsettledArm = (source) => ({
    guard: 'acceptHasFindingsAtBound',
    target: '#unsettled',
    actions: [
        acceptedOutcome(source, 'unsettled', 'hasFindings'),
        'rememberUnsettledFindings',
        'clearBossReplyContext',
    ],
});
/** Reviewer affirmed a complete review with no unsettled findings. */
const noFindingsArm = (source) => ({
    guard: 'acceptNoFindings',
    target: '#done',
    actions: [
        acceptedOutcome(source, 'done', 'noFindings'),
        'rememberEvaluatedRevision',
        'clearBossReplyContext',
    ],
});
const suspendArm = (source) => ({
    guard: 'acceptNeedsBossReply',
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
const startReviewArm = {
    guard: 'validStartReview',
    target: '#firstReview',
    actions: 'startReview',
};
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
export const reviewMachine = setup({
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
    },
    actions: {
        'playbook.acceptedOutcome': (_args, _params) => undefined,
        startReview: assign(({ event }) => event.type === 'START_REVIEW'
            ? {
                callerInput: event.callerInput,
                reviewerOutput: undefined,
                coderOutput: undefined,
                latestCommit: undefined,
                coderOutcome: undefined,
                evaluatedRevision: undefined,
                round: 1,
                findingsUnsettled: undefined,
                lastError: undefined,
                pendingBossQuestion: undefined,
                bossReply: undefined,
            }
            : {}),
        // A jump back to the first review restarts the round count; a jump into a
        // later round redoes that round and keeps it.
        resetForInterrupt: assign(({ context, event }) => ({
            evaluatedRevision: undefined,
            findingsUnsettled: undefined,
            round: event.type === 'BOSS_INTERRUPT' && event.targetId === 'firstReview'
                ? 1
                : roundOf(context),
            lastError: undefined,
            pendingBossQuestion: undefined,
            bossReply: undefined,
        })),
        rememberFindings: assign(({ event }) => {
            const output = playerOutputOf(event);
            return output?.guard === 'hasFindings'
                ? { reviewerOutput: output.reviewerOutput, lastError: undefined }
                : {};
        }),
        rememberCoderDisposition: assign(({ context, event }) => {
            const output = playerOutputOf(event);
            // Each disposition opens the next Reviewer round.
            const round = roundOf(context) + 1;
            if (output?.guard === 'committed') {
                return {
                    coderOutput: output.coderOutput,
                    latestCommit: output.latestCommit,
                    coderOutcome: 'committed',
                    round,
                    lastError: undefined,
                };
            }
            if (output?.guard === 'rejectedAll') {
                return {
                    coderOutput: output.coderOutput,
                    coderOutcome: 'rejectedAll',
                    round,
                    lastError: undefined,
                };
            }
            return {};
        }),
        rememberUnsettledFindings: assign(({ event }) => {
            const output = playerOutputOf(event);
            return output?.guard === 'hasFindings'
                ? {
                    reviewerOutput: output.reviewerOutput,
                    findingsUnsettled: true,
                    lastError: undefined,
                }
                : {};
        }),
        rememberEvaluatedRevision: assign(({ event }) => {
            const output = playerOutputOf(event);
            return output?.guard === 'noFindings'
                ? { evaluatedRevision: output.evaluatedRevision, lastError: undefined }
                : {};
        }),
        setPendingBossQuestion: assign(({ event }, params) => {
            const output = playerOutputOf(event);
            if (output?.guard !== 'needsBossReply')
                return {};
            const metadata = RESUME_METADATA[params.resumeStateId];
            const pendingBossQuestion = {
                questionId: params.resumeStateId,
                resumeStateId: params.resumeStateId,
                sourceItem: metadata.sourceItem,
                asker: { kind: 'role', roleId: metadata.role },
                question: output.question,
            };
            return { pendingBossQuestion, bossReply: undefined, lastError: undefined };
        }),
        rememberBossReply: assign(({ event }) => event.type === 'BOSS_REPLY' ? { bossReply: event.answer } : {}),
        clearBossReplyContext: assign({
            pendingBossQuestion: undefined,
            bossReply: undefined,
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
                        ? 'Player output declared needsBossReply without a question.'
                        : 'Player output did not match an outcome declared for the working state.',
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
        acceptHasFindings: acceptsOutcome('hasFindings'),
        acceptHasFindingsBeforeBound,
        acceptHasFindingsAtBound,
        acceptNoFindings: acceptsOutcome('noFindings'),
        acceptCommitted: acceptsOutcome('committed'),
        acceptRejectedAll: acceptsOutcome('rejectedAll'),
        acceptNeedsBossReply: acceptsOutcome('needsBossReply'),
        validStartReview,
        emptyBossReply,
    },
}).createMachine({
    id: 'review',
    initial: 'ready',
    context: {},
    output: ({ context }) => {
        if (context.findingsUnsettled === true) {
            if (!isNonEmptyString(context.reviewerOutput)) {
                throw new Error('REVIEW stopped at its bound without the unsettled findings');
            }
            return {
                noUnsettledFindings: false,
                reviewerOutput: context.reviewerOutput,
            };
        }
        if (!isNonEmptyString(context.evaluatedRevision)) {
            throw new Error('REVIEW completed without the evaluated repository revision');
        }
        return {
            noUnsettledFindings: true,
            evaluatedRevision: context.evaluatedRevision,
        };
    },
    on: {
        BOSS_INTERRUPT: bossInterrupts([
            'firstReview',
            'fixFindings',
            'reviewAfterFix',
            'reviewAfterRejection',
        ]),
    },
    states: {
        ready: {
            id: 'ready',
            tags: 'playbook.parked',
            description: STATE_DESCRIPTIONS.ready,
            meta: meta('ready'),
            on: {
                START_REVIEW: startReviewArm,
            },
        },
        firstReview: {
            id: 'firstReview',
            tags: 'playbook.busy',
            description: STATE_DESCRIPTIONS.firstReview,
            meta: meta('firstReview', 'reviewer'),
            invoke: {
                src: 'player',
                input: ({ context }) => ({
                    stateId: 'firstReview',
                    role: 'reviewer',
                    sourceItem: 'REVIEW-1',
                    prompt: FIRST_REVIEW_PROMPT,
                    result: FIRST_REVIEW_RESULT,
                    ...(context.callerInput !== undefined
                        ? { callerInput: context.callerInput }
                        : {}),
                    ...bossReplyFields(context),
                }),
                onDone: [
                    hasFindingsArm('firstReview'),
                    noFindingsArm('firstReview'),
                    suspendArm('firstReview'),
                    malformedPlayerOutputArm,
                ],
                onError: playerOnError,
            },
        },
        fixFindings: {
            id: 'fixFindings',
            tags: 'playbook.busy',
            description: STATE_DESCRIPTIONS.fixFindings,
            meta: meta('fixFindings', 'coder'),
            invoke: {
                src: 'player',
                input: ({ context }) => ({
                    stateId: 'fixFindings',
                    role: 'coder',
                    sourceItem: 'REVIEW-2',
                    prompt: FIX_FINDINGS_PROMPT,
                    result: FIX_FINDINGS_RESULT,
                    ...(context.callerInput !== undefined
                        ? { callerInput: context.callerInput }
                        : {}),
                    ...(context.reviewerOutput !== undefined
                        ? { reviewerOutput: context.reviewerOutput }
                        : {}),
                    ...bossReplyFields(context),
                }),
                onDone: [
                    {
                        guard: 'acceptCommitted',
                        target: '#reviewAfterFix',
                        actions: [
                            acceptedOutcome('fixFindings', 'reviewAfterFix', 'committed'),
                            'rememberCoderDisposition',
                            'clearBossReplyContext',
                        ],
                    },
                    {
                        guard: 'acceptRejectedAll',
                        target: '#reviewAfterRejection',
                        actions: [
                            acceptedOutcome('fixFindings', 'reviewAfterRejection', 'rejectedAll'),
                            'rememberCoderDisposition',
                            'clearBossReplyContext',
                        ],
                    },
                    suspendArm('fixFindings'),
                    malformedPlayerOutputArm,
                ],
                onError: playerOnError,
            },
        },
        reviewAfterFix: {
            id: 'reviewAfterFix',
            tags: 'playbook.busy',
            description: STATE_DESCRIPTIONS.reviewAfterFix,
            meta: meta('reviewAfterFix', 'reviewer'),
            invoke: {
                src: 'player',
                input: ({ context }) => ({
                    stateId: 'reviewAfterFix',
                    role: 'reviewer',
                    sourceItem: 'REVIEW-3',
                    prompt: REVIEW_AFTER_FIX_PROMPT,
                    result: REVIEW_AFTER_FIX_RESULT,
                    ...(context.callerInput !== undefined
                        ? { callerInput: context.callerInput }
                        : {}),
                    ...(context.latestCommit !== undefined
                        ? { latestCommit: context.latestCommit }
                        : {}),
                    ...(context.coderOutput !== undefined
                        ? { coderOutput: context.coderOutput }
                        : {}),
                    ...bossReplyFields(context),
                }),
                onDone: [
                    hasFindingsArm('reviewAfterFix', 'acceptHasFindingsBeforeBound'),
                    unsettledArm('reviewAfterFix'),
                    noFindingsArm('reviewAfterFix'),
                    suspendArm('reviewAfterFix'),
                    malformedPlayerOutputArm,
                ],
                onError: playerOnError,
            },
        },
        reviewAfterRejection: {
            id: 'reviewAfterRejection',
            tags: 'playbook.busy',
            description: STATE_DESCRIPTIONS.reviewAfterRejection,
            meta: meta('reviewAfterRejection', 'reviewer'),
            invoke: {
                src: 'player',
                input: ({ context }) => ({
                    stateId: 'reviewAfterRejection',
                    role: 'reviewer',
                    sourceItem: 'REVIEW-4',
                    prompt: REVIEW_AFTER_REJECTION_PROMPT,
                    result: REVIEW_AFTER_REJECTION_RESULT,
                    ...(context.callerInput !== undefined
                        ? { callerInput: context.callerInput }
                        : {}),
                    ...(context.coderOutput !== undefined
                        ? { coderOutput: context.coderOutput }
                        : {}),
                    ...bossReplyFields(context),
                }),
                onDone: [
                    hasFindingsArm('reviewAfterRejection', 'acceptHasFindingsBeforeBound'),
                    unsettledArm('reviewAfterRejection'),
                    noFindingsArm('reviewAfterRejection'),
                    suspendArm('reviewAfterRejection'),
                    malformedPlayerOutputArm,
                ],
                onError: playerOnError,
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
                    ...resumableStates([
                        'firstReview',
                        'fixFindings',
                        'reviewAfterFix',
                        'reviewAfterRejection',
                    ]),
                ],
                START_REVIEW: startReviewArm,
            },
        },
        failed: {
            id: 'failed',
            tags: 'playbook.parked',
            description: STATE_DESCRIPTIONS.failed,
            meta: meta('failed'),
            on: {
                START_REVIEW: startReviewArm,
            },
        },
        done: {
            id: 'done',
            type: 'final',
            description: STATE_DESCRIPTIONS.done,
            meta: finalMeta('done', 'success'),
        },
        unsettled: {
            id: 'unsettled',
            type: 'final',
            description: STATE_DESCRIPTIONS.unsettled,
            meta: finalMeta('unsettled', 'failure'),
        },
    },
});
export default reviewMachine;
