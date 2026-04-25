// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Compiled from .playbook/coding.gears.md by `slc playbook.gears2fsm`.
// Object artifact: requires a runtime providing the `captain` actor.

import { setup, assign, fromPromise } from 'xstate';

export interface CaptainInput {
    role: 'Coder' | 'Reviewer';
    prompt: string;
    result: Record<string, string>;
    [extra: string]: unknown;
}

export interface CaptainOutput {
    guard: string;
    [extra: string]: unknown;
}

export interface CodingContext {
    irNumber: string | null;
    lastResult: CaptainOutput | null;
    coderPlayer: string;
    reviewerPlayer: string;
}

export type CodingEvent =
    | { type: 'BOSS_INTENT'; text: string }
    | { type: 'BOSS_INTERRUPT'; targetId: JumpableId };

export type JumpableId =
    | 'idle'
    | 'planning'
    | 'implementingTask'
    | 'reviewingChanges'
    | 'coderResponding'
    | 'reviewerResponding'
    | 'committing'
    | 'pushing'
    | 'fixingCi'
    | 'summarizingSpecs'
    | 'reviewingSpecs';

const assignLast = assign({
    lastResult: ({ event }: { event: { output: CaptainOutput } }) => event.output,
});

const bossInterrupts = (ids: JumpableId[]) =>
    ids.map((id) => ({
        target: `#${id}` as const,
        guard: ({ event }: { event: CodingEvent }) =>
            event.type === 'BOSS_INTERRUPT' && event.targetId === id,
        reenter: true,
    }));

export const codingMachine = setup({
    types: {} as {
        context: CodingContext;
        events: CodingEvent;
    },
    actors: {
        // Provided by the runner at link time.
        captain: fromPromise<CaptainOutput, CaptainInput>(async () => {
            throw new Error('captain actor must be provided by the runner');
        }),
    },
}).createMachine({
    id: 'coding',
    initial: 'idle',
    context: {
        irNumber: null,
        lastResult: null,
        coderPlayer: 'Claude Opus 4.7',
        reviewerPlayer: 'GPT-5.5',
    },
    on: {
        BOSS_INTERRUPT: bossInterrupts([
            'idle',
            'planning',
            'implementingTask',
            'reviewingChanges',
            'coderResponding',
            'reviewerResponding',
            'committing',
            'pushing',
            'fixingCi',
            'summarizingSpecs',
            'reviewingSpecs',
        ]),
    },
    states: {
        // Wait for Boss intent.
        idle: {
            id: 'idle',
            on: {
                BOSS_INTENT: {
                    target: 'planning',
                    actions: assign({
                        lastResult: ({ event }) => ({ guard: 'intent', intent: event.text }),
                    }),
                },
            },
        },

        // CODE-1
        planning: {
            id: 'planning',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Coder',
                    prompt: [
                        'Estimate if this can be done in a single commit, following best practices.',
                        'If yes, implement, test, and commit; otherwise, break it into tasks as a new iteration in @specs/iterations (every task should be a commit), and commit the IR.',
                        'Consult @specs/map.md to find relevant if needed.',
                    ].join('\n'),
                    intent: context.lastResult?.intent,
                    result: {
                        singleCommitDone: 'Coder finished a single-commit implementation (already committed).',
                        irDrafted: 'Coder drafted and committed an IR; needs implementation.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'singleCommitDone',
                        target: 'reviewingChanges',
                        actions: assignLast,
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'irDrafted',
                        target: 'implementingTask',
                        actions: assign({
                            lastResult: ({ event }) => ({ ...event.output, irJustStarted: true }),
                            irNumber: ({ event }) => (event.output.irNumber as string) ?? null,
                        }),
                    },
                ],
            },
        },

        // Composes CODE-2 + (CODE-3 entry | CODE-4 continue)
        implementingTask: {
            id: 'implementingTask',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Coder',
                    prompt: [
                        context.lastResult?.irJustStarted
                            ? `Implement IR-${context.irNumber}.`
                            : `Continue to implement IR-${context.irNumber} if not all deliverables and tasks are done.`,
                        'Every task is a commit (including corresponding tests if any).',
                        'Stop after each commit for review.',
                    ].join('\n'),
                    result: {
                        taskCommitted: 'Coder committed one task; ready for review.',
                        irComplete: 'All IR deliverables and tasks are done.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'taskCommitted',
                        target: 'reviewingChanges',
                        actions: assignLast,
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'irComplete',
                        target: 'pushing',
                        actions: assignLast,
                    },
                ],
            },
        },

        // Composes CODE-5 + (CODE-6 commit | CODE-7 unstaged)
        reviewingChanges: {
            id: 'reviewingChanges',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Reviewer',
                    prompt: [
                        context.lastResult?.hasUnstagedChanges
                            ? 'Review the latest unstaged/untracked changes.'
                            : 'Review the latest commit.',
                        context.lastResult?.hasUnstagedChanges ? 'Understand the intent.' : null,
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        "If the change is ready to commit or push, don't raise nitpicks.",
                        'Consult @specs/map.md to find relevant context if needed.',
                    ]
                        .filter(Boolean)
                        .join('\n'),
                    result: {
                        hasFindings: 'Reviewer replied issues or suggestions.',
                        noFindings: 'Reviewer has no findings.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'hasFindings',
                        target: 'coderResponding',
                        actions: assignLast,
                    },
                    {
                        guard: ({ context, event }) =>
                            event.output.guard === 'noFindings' && !!context.lastResult?.fromUnstaged,
                        target: 'committing',
                        actions: assignLast,
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'noFindings',
                        target: 'implementingTask',
                        actions: assignLast,
                    },
                ],
            },
        },

        // CODE-8
        coderResponding: {
            id: 'coderResponding',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Coder',
                    prompt: [
                        'For each review item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
                        'Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.',
                    ].join('\n'),
                    reviews: context.lastResult?.findings,
                    result: {
                        challenged: 'Coder challenged some items; needs Reviewer follow-up.',
                        accepted: 'Coder accepted all items and produced unstaged edits ready for re-review.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'challenged',
                        target: 'reviewerResponding',
                        actions: assignLast,
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'accepted',
                        target: 'reviewingChanges',
                        actions: assign({
                            lastResult: ({ event }) => ({
                                ...event.output,
                                hasUnstagedChanges: true,
                                fromUnstaged: true,
                            }),
                        }),
                    },
                ],
            },
        },

        // CODE-9
        reviewerResponding: {
            id: 'reviewerResponding',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Reviewer',
                    prompt: [
                        'For each feedback item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
                        'Then review the latest unstaged/untracked changes (if any).',
                    ].join('\n'),
                    challenges: context.lastResult?.challenges,
                    result: {
                        hasFindings: 'Reviewer still has findings.',
                        noFindings: 'Reviewer agrees; ready to commit.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'hasFindings',
                        target: 'coderResponding',
                        actions: assignLast,
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'noFindings',
                        target: 'committing',
                        actions: assignLast,
                    },
                ],
            },
        },

        // Composes CODE-10 + CODE-11
        committing: {
            id: 'committing',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Coder',
                    prompt: [
                        `You (${context.coderPlayer}) are Coder; ${context.reviewerPlayer} is Reviewer.`,
                        'Finally, commit the relevant changes that belong in the repo, following @specs/items/dev/git.md format (reread if necessary).',
                        'If relevant, mark progress in the IR.',
                    ].join('\n'),
                    result: {
                        committed: 'Coder committed; more IR work remaining.',
                        milestoneReached: 'Coder committed and this is a milestone or end of iteration.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'milestoneReached',
                        target: 'pushing',
                        actions: assignLast,
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'committed',
                        target: 'implementingTask',
                        actions: assignLast,
                    },
                ],
            },
        },

        // CODE-12
        pushing: {
            id: 'pushing',
            invoke: {
                src: 'captain',
                input: (): CaptainInput => ({
                    role: 'Coder',
                    prompt: [
                        'Push and check the CI status and, if any failure, fix it in another commit (no further push), with local verification if possible.',
                        'If the CI log indicates flakiness, rerun any affected CI workflow instead.',
                    ].join('\n'),
                    result: {
                        ciGreen: 'Push succeeded and CI is green.',
                        ciFailed: 'CI failed; need a fix commit.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'ciGreen',
                        target: 'summarizingSpecs',
                        actions: assignLast,
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'ciFailed',
                        target: 'fixingCi',
                        actions: assignLast,
                    },
                ],
            },
        },

        // CODE-13 + CODE-12 fix loop
        fixingCi: {
            id: 'fixingCi',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Reviewer',
                    prompt: 'Check the latest CI failure log if needed.',
                    ciLog: context.lastResult?.ciLog,
                    result: {
                        fixCommitted: 'Coder committed a fix; ready to recheck CI.',
                    },
                }),
                onDone: {
                    target: 'pushing',
                    actions: assignLast,
                },
            },
        },

        // CODE-14
        summarizingSpecs: {
            id: 'summarizingSpecs',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Coder',
                    prompt: [
                        `Read IR-${context.irNumber} and corresponding commits.`,
                        'According to @specs/meta.md, add or update spec items to fully capture:',
                        '',
                        '- the user requirements in @specs/items/user,',
                        '- the system behavior in @specs/items/dev, and',
                        '- the integration/system test cases in @specs/items/test.',
                        '',
                        'The spec items should be the *minimal* set needed to reimplement code without the IR.',
                        'The set should be complete and coherent.',
                        'Avoid implementation specifics.',
                        'Avoid redundant spec items.',
                        'Consult @specs/map.md for relevant context and update it to reflect your changes.',
                    ].join('\n'),
                    result: {
                        specsDrafted: 'Coder drafted spec changes; needs spec review.',
                        noChange: 'No spec changes needed.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'specsDrafted',
                        target: 'reviewingSpecs',
                        actions: assignLast,
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'noChange',
                        target: 'done',
                        actions: assignLast,
                    },
                ],
            },
        },

        // Composes CODE-5 + CODE-15
        reviewingSpecs: {
            id: 'reviewingSpecs',
            invoke: {
                src: 'captain',
                input: ({ context }): CaptainInput => ({
                    role: 'Reviewer',
                    prompt: [
                        `Review the unstaged/untracked changes. Verify the spec items for IR-${context.irNumber} are:`,
                        '',
                        '- Complete & coherent: sufficient for you to reimplement code without the IR.',
                        '- Right level: user requirements (in @specs/items/user) or behavior (in @specs/items/dev), not implementation specifics; integration/system testing (in @specs/items/test), not unit testing.',
                        '- Minimal: essential and concise; every item earns its place; also check with other items.',
                        '',
                        'Flag anything missing, redundant, over-specified, or under-specified.',
                        'Consult @specs/map.md for relevant context and verify it reflects the changes.',
                        'Flag any issues or improvements (numbered; no duplication).',
                        "Think thoroughly — don't just approve or reject.",
                        "If the change is ready to commit or push, don't raise nitpicks.",
                    ].join('\n'),
                    result: {
                        hasFindings: 'Reviewer flagged spec issues.',
                        noFindings: 'Spec changes are ready.',
                    },
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.guard === 'hasFindings',
                        target: 'coderResponding',
                        actions: assign({
                            lastResult: ({ event }) => ({ ...event.output, fromSpecReview: true }),
                        }),
                    },
                    {
                        guard: ({ event }) => event.output.guard === 'noFindings',
                        target: 'done',
                        actions: assignLast,
                    },
                ],
            },
        },

        done: {
            id: 'done',
            type: 'final',
        },
    },
});
