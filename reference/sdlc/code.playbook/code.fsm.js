// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// XState v5's generics do not flow through helpers declared outside the
// machine (e.g., shared guard/action factories, the `readyEvents` block),
// so strict checking emits structural-mismatch noise without surfacing real
// bugs. The runner overrides `captain` via `.provide({ actors: { ... } })`
// and re-asserts the public surface (`CodingContext`, `CodingEvent`,
// `CaptainInput`, `CaptainOutput`) at the boundary.
// @ts-nocheck
import { assign, fromPromise, setup } from 'xstate';
const jumpableStateIds = [
    'ready',
    'planAndImplement',
    'respondToReview',
    'continueIr',
    'summarizeSpecs',
    'reviewBossCommitSpecs',
    'reviewBossCommitCode',
    'reviewBossCommitMixed',
    'reviewIrTaskCommitSpecs',
    'reviewIrTaskCommitCode',
    'reviewIrTaskCommitMixed',
    'reviewChangesSpecs',
    'reviewChangesCode',
    'reviewChangesMixed',
    'reviewChangesAndChallengesSpecs',
    'reviewChangesAndChallengesCode',
    'reviewChangesAndChallengesMixed',
    'adjudicateChallenges',
    'commitCoderInitial',
    'commitJoint',
    'failed',
];
const resumableStateIds = [
    'planAndImplement',
    'respondToReview',
    'continueIr',
    'summarizeSpecs',
    'reviewBossCommitSpecs',
    'reviewBossCommitCode',
    'reviewBossCommitMixed',
    'reviewIrTaskCommitSpecs',
    'reviewIrTaskCommitCode',
    'reviewIrTaskCommitMixed',
    'reviewChangesSpecs',
    'reviewChangesCode',
    'reviewChangesMixed',
    'reviewChangesAndChallengesSpecs',
    'reviewChangesAndChallengesCode',
    'reviewChangesAndChallengesMixed',
    'adjudicateChallenges',
    'commitCoderInitial',
    'commitJoint',
];
const outputOf = (event) => event.output;
const guardIs = (guard) => ({ event }) => outputOf(event)?.guard === guard;
const guardAndOrigin = (guard, origin) => ({ context, event }) => outputOf(event)?.guard === guard && context.changeOrigin === origin;
const acceptedAfter = (subject) => ({ context, event }) => outputOf(event)?.guard === 'accepted' && context.reviewSubject === subject;
const noFindingsAfter = (afterReview) => ({ context, event }) => outputOf(event)?.guard === 'noFindings' && context.afterReview === afterReview;
const rememberCaptainOutput = assign({
    lastResult: ({ event }) => outputOf(event),
    lastError: () => undefined,
    irNumber: ({ context, event }) => outputOf(event)?.irNumber ?? context.irNumber,
    taskDescription: ({ context, event }) => outputOf(event)?.taskDescription ?? context.taskDescription,
    reviews: ({ context, event }) => outputOf(event)?.reviews ?? context.reviews,
    challenges: ({ context, event }) => outputOf(event)?.challenges ?? context.challenges,
});
const rememberCaptainError = assign({
    lastError: ({ event }) => event.error,
});
const rememberEmptyBossReplyError = assign({
    lastError: () => new Error('BOSS_REPLY received empty answer'),
});
const rememberBossInput = assign({
    intent: ({ context, event }) => event.intent ?? context.intent,
    irNumber: ({ context, event }) => event.irNumber ?? context.irNumber,
});
const needsBossReplyDescription = "The player's prose surfaces a clarifying question for Boss that the player cannot answer alone. Output shall include `question: <verbatim question text from the player's prose>`.";
const bossReplyInputFields = (context) => ({
    pendingBossQuestion: context.pendingBossQuestion,
    bossReply: context.bossReply,
});
const withNeedsBossReply = (result) => ({
    ...result,
    needsBossReply: needsBossReplyDescription,
});
const captainStateMetadata = {
    planAndImplement: { sourceItem: 'CODE-1', player: 'Coder' },
    respondToReview: { sourceItem: 'CODE-2', player: 'Coder' },
    continueIr: { sourceItem: 'CODE-3', player: 'Coder' },
    summarizeSpecs: { sourceItem: 'CODE-4', player: 'Coder' },
    reviewBossCommitSpecs: { sourceItem: 'CODE-5', player: 'Reviewer' },
    reviewBossCommitCode: { sourceItem: 'CODE-6', player: 'Reviewer' },
    reviewBossCommitMixed: { sourceItem: 'CODE-7', player: 'Reviewer' },
    reviewIrTaskCommitSpecs: { sourceItem: 'CODE-8', player: 'Reviewer' },
    reviewIrTaskCommitCode: { sourceItem: 'CODE-9', player: 'Reviewer' },
    reviewIrTaskCommitMixed: { sourceItem: 'CODE-10', player: 'Reviewer' },
    reviewChangesSpecs: { sourceItem: 'CODE-11', player: 'Reviewer' },
    reviewChangesCode: { sourceItem: 'CODE-12', player: 'Reviewer' },
    reviewChangesMixed: { sourceItem: 'CODE-13', player: 'Reviewer' },
    reviewChangesAndChallengesSpecs: { sourceItem: 'CODE-15', player: 'Reviewer' },
    reviewChangesAndChallengesCode: { sourceItem: 'CODE-16', player: 'Reviewer' },
    reviewChangesAndChallengesMixed: { sourceItem: 'CODE-17', player: 'Reviewer' },
    adjudicateChallenges: { sourceItem: 'CODE-14', player: 'Reviewer' },
    commitCoderInitial: { sourceItem: 'CODE-18', player: 'Committer' },
    commitJoint: { sourceItem: 'CODE-19', player: 'Committer' },
};
const planAndImplementInput = (context) => ({
    player: 'Coder',
    sourceItem: 'CODE-1',
    intent: context.intent,
    ...bossReplyInputFields(context),
    prompt: [
        'Assess whether this can be completed in a single commit, following best practices.',
        'If yes, implement and test, updating both code and specs; otherwise, decompose into tasks as a new IR under @specs/iterations and stop without implementing any IR task.',
        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
        'Ensure @specs/map.md reflects the changes.',
        'Do not commit.',
    ].join('\n'),
    result: withNeedsBossReply({
        singleCommitReady: 'Coder produced uncommitted single-commit changes (Initial Changes).',
        irDrafted: 'Coder decomposed the intent into a new IR and drafted it uncommitted (Initial Changes).',
    }),
});
const continueIrInput = (context) => ({
    player: 'Coder',
    sourceItem: 'CODE-3',
    irNumber: context.irNumber,
    ...bossReplyInputFields(context),
    prompt: [
        'Continue to implement IR-<#> if not all deliverables and tasks are done.',
        'Implement one task at a time (including corresponding tests if any).',
        'Stop after each task for review — do not commit yet.',
        'If relevant, mark progress in the IR.',
    ].join('\n'),
    result: withNeedsBossReply({
        taskReady: 'Coder produced uncommitted changes for the next IR task (Initial Changes). Output shall include `taskDescription: <one-line description of the task just implemented>`.',
        iterationDone: 'All IR deliverables and tasks are done.',
    }),
});
const summarizeSpecsInput = (context) => ({
    player: 'Coder',
    sourceItem: 'CODE-4',
    irNumber: context.irNumber,
    ...bossReplyInputFields(context),
    prompt: [
        'Read IR-<#> and corresponding commits.',
        'According to @specs/meta.md, add or update spec items to fully capture:',
        '',
        '- the user requirements in @specs/user,',
        '- the system behavior in @specs/dev, and',
        '- the integration/system test cases in @specs/test.',
        '',
        'The spec items should be the *minimal* set needed to reimplement code without the IR.',
        'The set should be complete and coherent.',
        'Avoid implementation specifics.',
        'Avoid redundant spec items.',
        'Ensure @specs/map.md reflects the changes.',
    ].join('\n'),
    result: withNeedsBossReply({
        specsReady: 'Coder produced uncommitted spec updates (Initial Changes).',
        noSpecChanges: 'Existing specs already capture the iteration.',
    }),
});
const setPendingBossQuestion = (resumeStateId) => assign({
    pendingBossQuestion: ({ context, event, }) => {
        const input = captainStateMetadata[resumeStateId];
        return {
            resumeStateId,
            sourceItem: input.sourceItem,
            player: input.player,
            question: outputOf(event)?.question ?? '',
        };
    },
    bossReply: () => undefined,
});
const rememberBossReply = assign({
    bossReply: ({ event }) => event.answer ?? '',
});
const clearBossReplyContext = assign({
    pendingBossQuestion: () => undefined,
    bossReply: () => undefined,
});
const actionsArray = (actions) => actions === undefined ? [] : Array.isArray(actions) ? actions : [actions];
const withClearBossReplyContext = (transition) => ({
    ...transition,
    actions: [clearBossReplyContext, ...actionsArray(transition.actions)],
});
const bossInterrupts = (ids, extraActions = []) => ids.map((id) => ({
    target: `#${id}`,
    guard: ({ event }) => event.type === 'BOSS_INTERRUPT' && event.targetId === id,
    reenter: true,
    actions: [...extraActions, rememberBossInput],
}));
const resumableStates = (ids) => ids.map((id) => ({
    target: `#${id}`,
    guard: ({ context, event }) => event.type === 'BOSS_REPLY' &&
        context.pendingBossQuestion?.resumeStateId === id,
    reenter: true,
    actions: rememberBossReply,
}));
const bossReplyIsEmpty = ({ event }) => event.type === 'BOSS_REPLY' && event.answer.trim() === '';
const withNeedsBossReplyTransition = (resumeStateId, transitions) => [
    ...transitions.map((transition) => withClearBossReplyContext(transition)),
    {
        guard: guardIs('needsBossReply'),
        target: '#awaitBossReply',
        actions: [rememberCaptainOutput, setPendingBossQuestion(resumeStateId)],
    },
];
const captainError = {
    target: '#failed',
    actions: rememberCaptainError,
};
const readyEvents = {
    START_CODING: {
        target: '#planAndImplement',
        actions: [
            rememberBossInput,
            assign({
                workflow: () => 'singleCommit',
                changeOrigin: () => 'bossIntent',
                afterReview: () => 'done',
            }),
        ],
    },
    CONTINUE_IR: {
        target: '#continueIr',
        actions: [
            rememberBossInput,
            assign({
                workflow: () => 'iteration',
                changeOrigin: () => 'irTask',
                afterReview: () => 'continueIr',
            }),
        ],
    },
    SUMMARIZE_IR: {
        target: '#summarizeSpecs',
        actions: [
            rememberBossInput,
            assign({
                workflow: () => 'specSummary',
                changeOrigin: () => 'irTask',
                afterReview: () => 'done',
            }),
        ],
    },
};
const awaitBossReplyEvents = {
    START_CODING: withClearBossReplyContext(readyEvents.START_CODING),
    CONTINUE_IR: withClearBossReplyContext(readyEvents.CONTINUE_IR),
    SUMMARIZE_IR: withClearBossReplyContext(readyEvents.SUMMARIZE_IR),
    BOSS_INTERRUPT: bossInterrupts(jumpableStateIds, [clearBossReplyContext]),
    BOSS_REPLY: [
        {
            guard: bossReplyIsEmpty,
            target: '#failed',
            actions: [clearBossReplyContext, rememberEmptyBossReplyError],
        },
        ...resumableStates(resumableStateIds),
    ],
};
const captainPlaceholder = fromPromise(async () => {
    throw new Error('captain actor must be provided by the runner');
});
export const codingMachine = setup({
    types: {},
    actors: {
        captain: captainPlaceholder,
    },
}).createMachine({
    id: 'coding',
    context: ({ input }) => ({
        intent: input?.intent,
        irNumber: input?.irNumber,
        coderPlayer: input?.coderPlayer,
        reviewerPlayer: input?.reviewerPlayer,
        committerPlayer: input?.committerPlayer,
    }),
    initial: 'ready',
    on: {
        BOSS_INTERRUPT: bossInterrupts(jumpableStateIds),
    },
    states: {
        ready: {
            id: 'ready',
            description: 'Idle hub: waits for Boss to start or resume a coding sub-procedure.',
            on: readyEvents,
        },
        awaitBossReply: {
            id: 'awaitBossReply',
            description: 'Waiting for Boss to answer a player question.',
            on: awaitBossReplyEvents,
        },
        planAndImplement: {
            id: 'planAndImplement',
            description: 'CODE-1: Coder assesses a Boss intent and either implements a single-commit change or drafts an IR.',
            invoke: {
                src: 'captain',
                input: ({ context }) => planAndImplementInput(context),
                onDone: withNeedsBossReplyTransition('planAndImplement', [
                    {
                        guard: guardIs('singleCommitReady'),
                        target: '#commitCoderInitial',
                        actions: [
                            rememberCaptainOutput,
                            assign({
                                workflow: () => 'singleCommit',
                                changeOrigin: () => 'bossIntent',
                                afterReview: () => 'done',
                            }),
                        ],
                    },
                    {
                        guard: guardIs('irDrafted'),
                        target: '#commitCoderInitial',
                        actions: [
                            rememberCaptainOutput,
                            assign({
                                workflow: () => 'iteration',
                                changeOrigin: () => 'bossIntent',
                                afterReview: () => 'continueIr',
                            }),
                        ],
                    },
                ]),
                onError: captainError,
            },
        },
        respondToReview: {
            id: 'respondToReview',
            description: 'CODE-2: Coder addresses or challenges Reviewer findings.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Coder',
                    sourceItem: 'CODE-2',
                    ...bossReplyInputFields(context),
                    reviews: context.reviews,
                    prompt: [
                        'For each review item below for the above changes, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
                        'Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.',
                    ].join('\n'),
                    result: {
                        changesMadeSpecs: 'Coder accepted items and produced unstaged/untracked edits in @specs/{user,dev,test}/ only, without raising any rebuttals.',
                        changesMadeCode: 'Coder accepted items and produced unstaged/untracked edits outside @specs/{user,dev,test}/ only, without raising any rebuttals.',
                        changesMadeMixed: 'Coder accepted items and produced unstaged/untracked edits spanning both @specs/{user,dev,test}/ and other files, without raising any rebuttals.',
                        changesMadeSpecsAndChallenged: 'Coder produced unstaged/untracked edits in @specs/{user,dev,test}/ only AND challenged one or more review items. Output shall include `challenges: <numbered rebuttals, one per challenged item>`.',
                        changesMadeCodeAndChallenged: 'Coder produced unstaged/untracked edits outside @specs/{user,dev,test}/ only AND challenged one or more review items. Output shall include `challenges: <numbered rebuttals, one per challenged item>`.',
                        changesMadeMixedAndChallenged: 'Coder produced unstaged/untracked edits spanning both @specs/{user,dev,test}/ and other files AND challenged one or more review items. Output shall include `challenges: <numbered rebuttals, one per challenged item>`.',
                        challengesRaised: 'Coder challenged one or more review items without producing any code edits. Output shall include `challenges: <numbered rebuttals, one per challenged item>`.',
                        accepted: 'Coder accepted the review outcome without further edits.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('respondToReview', [
                    {
                        guard: guardIs('changesMadeSpecs'),
                        target: '#reviewChangesSpecs',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('changesMadeCode'),
                        target: '#reviewChangesCode',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('changesMadeMixed'),
                        target: '#reviewChangesMixed',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('changesMadeSpecsAndChallenged'),
                        target: '#reviewChangesAndChallengesSpecs',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('changesMadeCodeAndChallenged'),
                        target: '#reviewChangesAndChallengesCode',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('changesMadeMixedAndChallenged'),
                        target: '#reviewChangesAndChallengesMixed',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('challengesRaised'),
                        target: '#adjudicateChallenges',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: acceptedAfter('changes'),
                        target: '#commitJoint',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: ({ context, event }) => outputOf(event)?.guard === 'accepted' &&
                            context.reviewSubject === 'commit' &&
                            context.afterReview === 'continueIr',
                        target: '#continueIr',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: ({ context, event }) => outputOf(event)?.guard === 'accepted' &&
                            context.reviewSubject === 'commit' &&
                            context.afterReview === 'summarizeSpecs',
                        target: '#summarizeSpecs',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: ({ context, event }) => outputOf(event)?.guard === 'accepted' &&
                            context.reviewSubject === 'commit' &&
                            context.afterReview === 'done',
                        target: '#done',
                        actions: rememberCaptainOutput,
                    },
                ]),
                onError: captainError,
            },
        },
        continueIr: {
            id: 'continueIr',
            description: 'CODE-3: Coder continues an IR after the previous task or IR draft passed review.',
            invoke: {
                src: 'captain',
                input: ({ context }) => continueIrInput(context),
                onDone: withNeedsBossReplyTransition('continueIr', [
                    {
                        guard: guardIs('taskReady'),
                        target: '#commitCoderInitial',
                        actions: [
                            rememberCaptainOutput,
                            assign({
                                workflow: () => 'iteration',
                                changeOrigin: () => 'irTask',
                                afterReview: () => 'continueIr',
                            }),
                        ],
                    },
                    {
                        guard: guardIs('iterationDone'),
                        target: '#summarizeSpecs',
                        actions: [
                            rememberCaptainOutput,
                            assign({
                                workflow: () => 'specSummary',
                                afterReview: () => 'done',
                            }),
                        ],
                    },
                ]),
                onError: captainError,
            },
        },
        summarizeSpecs: {
            id: 'summarizeSpecs',
            description: 'CODE-4: Coder summarizes a completed IR into minimal spec items.',
            invoke: {
                src: 'captain',
                input: ({ context }) => summarizeSpecsInput(context),
                onDone: withNeedsBossReplyTransition('summarizeSpecs', [
                    {
                        guard: guardIs('specsReady'),
                        target: '#commitCoderInitial',
                        actions: [
                            rememberCaptainOutput,
                            assign({
                                workflow: () => 'specSummary',
                                changeOrigin: () => 'irTask',
                                afterReview: () => 'done',
                            }),
                        ],
                    },
                    {
                        guard: guardIs('noSpecChanges'),
                        target: '#done',
                        actions: rememberCaptainOutput,
                    },
                ]),
                onError: captainError,
            },
        },
        reviewBossCommitSpecs: {
            id: 'reviewBossCommitSpecs',
            description: 'CODE-5: Reviewer reviews a Boss-intent commit whose changes are only in @specs/{user,dev,test}/.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-5',
                    ...bossReplyInputFields(context),
                    intent: context.intent,
                    prompt: [
                        'Review the latest commit.',
                        'Refer to the commit message.',
                        'Verify any affected spec items are:',
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code.',
                        '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The spec-only commit has no review findings.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewBossCommitSpecs', [
                    { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewBossCommitCode: {
            id: 'reviewBossCommitCode',
            description: 'CODE-6: Reviewer reviews a Boss-intent commit whose changes are only outside @specs/{user,dev,test}/.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-6',
                    ...bossReplyInputFields(context),
                    intent: context.intent,
                    prompt: [
                        'Review the latest commit.',
                        'Refer to the commit message.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The code-only commit has no review findings.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewBossCommitCode', [
                    { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewBossCommitMixed: {
            id: 'reviewBossCommitMixed',
            description: 'CODE-7: Reviewer reviews a Boss-intent commit whose changes span both @specs/{user,dev,test}/ and other files.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-7',
                    ...bossReplyInputFields(context),
                    intent: context.intent,
                    prompt: [
                        'Review the latest commit.',
                        'Refer to the commit message.',
                        'Verify any affected spec items are:',
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code.',
                        '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The mixed commit has no review findings.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewBossCommitMixed', [
                    { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewIrTaskCommitSpecs: {
            id: 'reviewIrTaskCommitSpecs',
            description: 'CODE-8: Reviewer reviews an IR-task commit whose changes are only in @specs/{user,dev,test}/.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-8',
                    ...bossReplyInputFields(context),
                    irNumber: context.irNumber,
                    taskDescription: context.taskDescription,
                    prompt: [
                        'Review the latest commit.',
                        'Refer to the commit message.',
                        'Verify any affected spec items are:',
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code.',
                        '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The IR-task spec-only commit has no review findings.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewIrTaskCommitSpecs', [
                    { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewIrTaskCommitCode: {
            id: 'reviewIrTaskCommitCode',
            description: 'CODE-9: Reviewer reviews an IR-task commit whose changes are only outside @specs/{user,dev,test}/.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-9',
                    ...bossReplyInputFields(context),
                    irNumber: context.irNumber,
                    taskDescription: context.taskDescription,
                    prompt: [
                        'Review the latest commit.',
                        'Refer to the commit message.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The IR-task code-only commit has no review findings.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewIrTaskCommitCode', [
                    { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewIrTaskCommitMixed: {
            id: 'reviewIrTaskCommitMixed',
            description: 'CODE-10: Reviewer reviews an IR-task commit whose changes span both @specs/{user,dev,test}/ and other files.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-10',
                    ...bossReplyInputFields(context),
                    irNumber: context.irNumber,
                    taskDescription: context.taskDescription,
                    prompt: [
                        'Review the latest commit.',
                        'Refer to the commit message.',
                        'Verify any affected spec items are:',
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code.',
                        '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The IR-task mixed commit has no review findings.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewIrTaskCommitMixed', [
                    { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
                    { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewChangesSpecs: {
            id: 'reviewChangesSpecs',
            description: 'CODE-11: Reviewer reviews uncommitted Coder changes that touch only @specs/{user,dev,test}/ with no accompanying rebuttals.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-11',
                    ...bossReplyInputFields(context),
                    prompt: [
                        'Review the unstaged and untracked changes in the context of the staged changes.',
                        'Understand the intent.',
                        'Verify any affected spec items are:',
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code.',
                        '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The uncommitted spec-only changes are ready to commit.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewChangesSpecs', [
                    {
                        guard: guardIs('noFindings'),
                        target: '#commitJoint',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewChangesCode: {
            id: 'reviewChangesCode',
            description: 'CODE-12: Reviewer reviews uncommitted Coder changes that touch only files outside @specs/{user,dev,test}/ with no accompanying rebuttals.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-12',
                    ...bossReplyInputFields(context),
                    prompt: [
                        'Review the unstaged and untracked changes in the context of the staged changes.',
                        'Understand the intent.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The uncommitted code-only changes are ready to commit.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewChangesCode', [
                    {
                        guard: guardIs('noFindings'),
                        target: '#commitJoint',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewChangesMixed: {
            id: 'reviewChangesMixed',
            description: 'CODE-13: Reviewer reviews uncommitted Coder changes that touch both @specs/{user,dev,test}/ and other files with no accompanying rebuttals.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-13',
                    ...bossReplyInputFields(context),
                    prompt: [
                        'Review the unstaged and untracked changes in the context of the staged changes.',
                        'Understand the intent.',
                        'Verify any affected spec items are:',
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code.',
                        '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        noFindings: 'The uncommitted mixed changes are ready to commit.',
                        hasFindings: 'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewChangesMixed', [
                    {
                        guard: guardIs('noFindings'),
                        target: '#commitJoint',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('hasFindings'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewChangesAndChallengesSpecs: {
            id: 'reviewChangesAndChallengesSpecs',
            description: 'CODE-15: Reviewer reviews uncommitted Coder changes that touch only @specs/{user,dev,test}/ and adjudicates accompanying rebuttals in one round.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-15',
                    ...bossReplyInputFields(context),
                    reviews: context.reviews,
                    challenges: context.challenges,
                    prompt: [
                        'Review the unstaged and untracked changes in the context of the staged changes.',
                        'Understand the intent.',
                        'Verify any affected spec items are:',
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code.',
                        '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                        'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
                    ].join('\n'),
                    result: {
                        approved: 'The new spec-only changes are ready to commit and every rebuttal was accepted (or no items remained open).',
                        needsRevision: 'The combined round needs more work: the review produced findings, one or more rebuttals were rejected, or both. Output shall include `reviews: <numbered list of any new findings or rejected rebuttals to address>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewChangesAndChallengesSpecs', [
                    {
                        guard: guardIs('approved'),
                        target: '#commitJoint',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('needsRevision'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewChangesAndChallengesCode: {
            id: 'reviewChangesAndChallengesCode',
            description: 'CODE-16: Reviewer reviews uncommitted Coder changes that touch only files outside @specs/{user,dev,test}/ and adjudicates accompanying rebuttals in one round.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-16',
                    ...bossReplyInputFields(context),
                    reviews: context.reviews,
                    challenges: context.challenges,
                    prompt: [
                        'Review the unstaged and untracked changes in the context of the staged changes.',
                        'Understand the intent.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                        'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
                    ].join('\n'),
                    result: {
                        approved: 'The new code-only changes are ready to commit and every rebuttal was accepted (or no items remained open).',
                        needsRevision: 'The combined round needs more work: the review produced findings, one or more rebuttals were rejected, or both. Output shall include `reviews: <numbered list of any new findings or rejected rebuttals to address>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewChangesAndChallengesCode', [
                    {
                        guard: guardIs('approved'),
                        target: '#commitJoint',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('needsRevision'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' })],
                    },
                ]),
                onError: captainError,
            },
        },
        reviewChangesAndChallengesMixed: {
            id: 'reviewChangesAndChallengesMixed',
            description: 'CODE-17: Reviewer reviews uncommitted Coder changes that touch both @specs/{user,dev,test}/ and other files and adjudicates accompanying rebuttals in one round.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-17',
                    ...bossReplyInputFields(context),
                    reviews: context.reviews,
                    challenges: context.challenges,
                    prompt: [
                        'Review the unstaged and untracked changes in the context of the staged changes.',
                        'Understand the intent.',
                        'Verify any affected spec items are:',
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code.',
                        '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        'For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.',
                        'Verify @specs/map.md reflects the changes.',
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Do not edit files or commit; report findings only.',
                        'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
                    ].join('\n'),
                    result: {
                        approved: 'The new mixed changes are ready to commit and every rebuttal was accepted (or no items remained open).',
                        needsRevision: 'The combined round needs more work: the review produced findings, one or more rebuttals were rejected, or both. Output shall include `reviews: <numbered list of any new findings or rejected rebuttals to address>`.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('reviewChangesAndChallengesMixed', [
                    {
                        guard: guardIs('approved'),
                        target: '#commitJoint',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('needsRevision'),
                        target: '#respondToReview',
                        actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' })],
                    },
                ]),
                onError: captainError,
            },
        },
        adjudicateChallenges: {
            id: 'adjudicateChallenges',
            description: 'CODE-14: Reviewer adjudicates Coder rebuttals against the prior review when Coder produced no code edits this round.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Reviewer',
                    sourceItem: 'CODE-14',
                    ...bossReplyInputFields(context),
                    reviews: context.reviews,
                    challenges: context.challenges,
                    prompt: [
                        'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
                        'Do not edit files or commit; report findings only.',
                    ].join('\n'),
                    result: {
                        challengeAccepted: 'Reviewer accepted the rebuttal — no further review edits are required.',
                        challengeRejected: 'Reviewer rejected the rebuttal — Coder must respond again.',
                        noOpenItems: 'No review items remain open.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('adjudicateChallenges', [
                    {
                        guard: ({ context, event }) => (outputOf(event)?.guard === 'challengeAccepted' ||
                            outputOf(event)?.guard === 'noOpenItems') &&
                            context.reviewSubject === 'changes',
                        target: '#commitJoint',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: ({ context, event }) => (outputOf(event)?.guard === 'challengeAccepted' ||
                            outputOf(event)?.guard === 'noOpenItems') &&
                            context.reviewSubject === 'commit' &&
                            context.afterReview === 'continueIr',
                        target: '#continueIr',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: ({ context, event }) => (outputOf(event)?.guard === 'challengeAccepted' ||
                            outputOf(event)?.guard === 'noOpenItems') &&
                            context.reviewSubject === 'commit' &&
                            context.afterReview === 'summarizeSpecs',
                        target: '#summarizeSpecs',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: ({ context, event }) => (outputOf(event)?.guard === 'challengeAccepted' ||
                            outputOf(event)?.guard === 'noOpenItems') &&
                            context.reviewSubject === 'commit' &&
                            context.afterReview === 'done',
                        target: '#done',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardIs('challengeRejected'),
                        target: '#respondToReview',
                        actions: rememberCaptainOutput,
                    },
                ]),
                onError: captainError,
            },
        },
        commitCoderInitial: {
            id: 'commitCoderInitial',
            description: 'CODE-18: Committer commits Coder Initial Changes when Reviewer has not played since the last commit.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Committer',
                    sourceItem: 'CODE-18',
                    ...bossReplyInputFields(context),
                    coderPlayer: context.coderPlayer,
                    committerPlayer: context.committerPlayer,
                    prompt: [
                        'Make a commit of the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).',
                        'Write concisely.',
                        'Coder is <coder-llm>.',
                        'Format the `Co-authored-by` `<model>` token as the conventional human form of the substituted id (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`).',
                    ].join('\n'),
                    result: {
                        committedSpecs: 'Committed changes that touch only @specs/{user,dev,test}/.',
                        committedCode: 'Committed changes that touch only files outside @specs/{user,dev,test}/.',
                        committedMixed: 'Committed changes that span both @specs/{user,dev,test}/ and other files.',
                        noRelevantChanges: 'There are no relevant changes to commit.',
                        needsBossInput: 'Committing requires additional Boss input.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('commitCoderInitial', [
                    {
                        guard: guardAndOrigin('committedSpecs', 'bossIntent'),
                        target: '#reviewBossCommitSpecs',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardAndOrigin('committedCode', 'bossIntent'),
                        target: '#reviewBossCommitCode',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardAndOrigin('committedMixed', 'bossIntent'),
                        target: '#reviewBossCommitMixed',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardAndOrigin('committedSpecs', 'irTask'),
                        target: '#reviewIrTaskCommitSpecs',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardAndOrigin('committedCode', 'irTask'),
                        target: '#reviewIrTaskCommitCode',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: guardAndOrigin('committedMixed', 'irTask'),
                        target: '#reviewIrTaskCommitMixed',
                        actions: rememberCaptainOutput,
                    },
                    { guard: guardIs('noRelevantChanges'), target: '#ready', actions: rememberCaptainOutput },
                    { guard: guardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
                ]),
                onError: captainError,
            },
        },
        commitJoint: {
            id: 'commitJoint',
            description: 'CODE-19: Committer commits changes when both Coder and Reviewer have played since the last commit.',
            invoke: {
                src: 'captain',
                input: ({ context }) => ({
                    player: 'Committer',
                    sourceItem: 'CODE-19',
                    ...bossReplyInputFields(context),
                    coderPlayer: context.coderPlayer,
                    reviewerPlayer: context.reviewerPlayer,
                    committerPlayer: context.committerPlayer,
                    prompt: [
                        'Make a commit of the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).',
                        'Write concisely.',
                        'Coder is <coder-llm>; Reviewer is <reviewer-llm>.',
                        'Format the `Co-authored-by` `<model>` token as the conventional human form of the substituted id (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`).',
                    ].join('\n'),
                    result: {
                        committed: 'Relevant changes were committed.',
                        noRelevantChanges: 'There are no relevant changes to commit.',
                        needsBossInput: 'Committing requires additional Boss input.',
                        needsBossReply: needsBossReplyDescription,
                    },
                }),
                onDone: withNeedsBossReplyTransition('commitJoint', [
                    {
                        guard: ({ context, event }) => outputOf(event)?.guard === 'committed' && context.afterReview === 'continueIr',
                        target: '#continueIr',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: ({ context, event }) => outputOf(event)?.guard === 'committed' && context.afterReview === 'summarizeSpecs',
                        target: '#summarizeSpecs',
                        actions: rememberCaptainOutput,
                    },
                    {
                        guard: ({ context, event }) => outputOf(event)?.guard === 'committed' && context.afterReview === 'done',
                        target: '#done',
                        actions: rememberCaptainOutput,
                    },
                    { guard: guardIs('noRelevantChanges'), target: '#done', actions: rememberCaptainOutput },
                    { guard: guardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
                ]),
                onError: captainError,
            },
        },
        failed: {
            id: 'failed',
            description: 'Captures the last Captain error so the runner can report it. Boss may resume from here.',
            on: readyEvents,
        },
        done: {
            id: 'done',
            description: 'The selected coding workflow has completed.',
            type: 'final',
        },
    },
});
