// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { setup, fromPromise, assign } from 'xstate';

// ---------------------------------------------------------------------------
// Exported boundary types (the linked runtime provides the actor implementation
// and imports these exact types).
// ---------------------------------------------------------------------------

/**
 * Machine construction input. The caller-supplied inspection request and any
 * relevant discussion context are delivered through the Boss entry event; an
 * optional seed may ride along at construction. No agent call runs before the
 * first Boss-originated event.
 */
export interface InspectInput {
    inspectionRequest?: string;
    discussionContext?: string;
}

/**
 * Terminal workflow output returned to the caller. Source declares two terminal
 * returns: `{ status: 'complete', report }` and `{ status: 'unavailable', report }`.
 */
export type MachineOutput =
    | { status: 'complete'; report: string }
    | { status: 'unavailable'; report: string };

/** Standard suspended-question record carried while awaiting a Boss reply. */
export interface PendingBossQuestion {
    questionId: string;
    resumeStateId: string;
    sourceItem: string;
    asker: { kind: 'captain' } | { kind: 'role'; roleId: string };
    question: string;
}

/** Typed input for the delegated `player` (Inspector) actor. */
export interface PlayerInput {
    stateId: string;
    role: 'inspector';
    sourceItem: string;
    prompt: string;
    inspectionRequest: string;
    discussionContext: string;
    pendingBossQuestion?: PendingBossQuestion;
    bossReply?: string;
    result: Record<'completed' | 'unavailable' | 'needsBossReply', string>;
}

/** Discriminated result contract the Inspector actor returns. */
export type PlayerOutput =
    | { guard: 'completed'; status: string; report: string }
    | { guard: 'unavailable'; status: string; report: string }
    | { guard: 'needsBossReply'; question: string };

// ---------------------------------------------------------------------------
// Internal machine types.
// ---------------------------------------------------------------------------

interface LastError {
    name: string;
    message: string;
    stack?: string;
}

interface InspectContext {
    inspectionRequest: string;
    discussionContext: string;
    report: string;
    status: 'complete' | 'unavailable' | null;
    lastError: LastError | null;
    pendingBossQuestion: PendingBossQuestion | null;
    bossReply: string | null;
}

type InspectEvent =
    | { type: 'START'; inspectionRequest: string; discussionContext?: string }
    | { type: 'BOSS_REPLY'; answer: string; questionId?: string };

interface AcceptedOutcomeParams {
    source: string;
    target: string;
    acceptedOutcome: string;
}

// ---------------------------------------------------------------------------
// Source-derived constants.
// ---------------------------------------------------------------------------

// INSPECT-1 full final prompt, verbatim from the GEARS blockquote. The literal
// leading `>` on the quoted-context lines is prompt content and is preserved.
const INSPECT_1_PROMPT = [
    'Inspect the requested material and give an evidence-based explanation.',
    'Use the attachments actually supplied to this call. Attachment names and metadata alone do not prove what their bytes show.',
    'For a request about a running interface, use the available browser tools to open the requested location, inspect it, and capture a screenshot when needed to support the explanation. Request screenshots as native image content by omitting an explicit filename when the tool supports that form.',
    'Reason from the images or tool results you actually receive, and explain the concrete observations that support your conclusions. Distinguish observed behavior from inference. Never claim to have opened, captured, or viewed something that the available evidence does not establish.',
    'Do not edit repository files, create commits, implement changes, or make unrelated changes to the inspected application. Browser interaction remains within the inspection Boss requested.',
    'If a missing choice or target prevents a useful inspection, ask Boss one concise question carrying every detail needed to answer. Do not invent the missing target.',
    'If required evidence or tools are unavailable, explain exactly what is unavailable and what that prevents you from concluding. Do not substitute a promise to inspect later for a result.',
    "Otherwise, complete the requested inspection and explain the findings, answering Boss's request directly. Make clear which captured figures support the findings without inventing a file path or asset identifier.",
    '',
    '> Inspection request: <inspection-request>',
    '> Discussion context: <discussion-context>',
].join('\n');

// INSPECT-1 local result contract, guard names and descriptions preserved
// verbatim in declared order, with the universal needsBossReply appended.
const INSPECT_1_RESULT: Record<'completed' | 'unavailable' | 'needsBossReply', string> = {
    completed:
        "Inspector's response affirmatively supports a completed inspection, not depending on any fixed presentation format. `inspect` terminates successfully and returns `{ status: 'complete', report }` to the caller, and its terminal description states that the inspection is complete without a repository change. Output shall include `status` (the string complete) and `report: <verbatim final text>`, where report is Inspector's complete explanation.",
    unavailable:
        "Inspector's response affirmatively supports that required evidence or tools are unavailable, not depending on any fixed presentation format. `inspect` terminates as an authored failure and returns `{ status: 'unavailable', report }` to the caller, and its terminal description states that the requested inspection could not be completed. Output shall include `status` (the string unavailable) and `report: <verbatim final text>`, where report is Inspector's complete explanation of the missing evidence or tools.",
    needsBossReply:
        "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.",
};

// Role-id arrays per parallel group; this machine has no parallel group.
export const concurrentRoleSets = [] as const;

// ---------------------------------------------------------------------------
// Structural narrowing helpers (accept unknown event output and narrow to the
// declared contract before reading fields).
// ---------------------------------------------------------------------------

function playerOutputOf(event: unknown): PlayerOutput | null {
    if (typeof event !== 'object' || event === null) return null;
    const output = (event as { output?: unknown }).output;
    if (typeof output !== 'object' || output === null) return null;
    const guard = (output as { guard?: unknown }).guard;
    if (guard === 'completed' || guard === 'unavailable') {
        const status = (output as { status?: unknown }).status;
        const report = (output as { report?: unknown }).report;
        if (typeof status === 'string' && typeof report === 'string' && report.trim().length > 0) {
            return guard === 'completed'
                ? { guard: 'completed', status, report }
                : { guard: 'unavailable', status, report };
        }
        return null;
    }
    if (guard === 'needsBossReply') {
        const question = (output as { question?: unknown }).question;
        if (typeof question === 'string') return { guard: 'needsBossReply', question };
        return null;
    }
    return null;
}

function reportOf(event: unknown): string {
    const output = playerOutputOf(event);
    return output && (output.guard === 'completed' || output.guard === 'unavailable')
        ? output.report
        : '';
}

function normalizeError(error: unknown): LastError {
    if (error instanceof Error) {
        return error.stack !== undefined
            ? { name: error.name, message: error.message, stack: error.stack }
            : { name: error.name, message: error.message };
    }
    return { name: 'Error', message: typeof error === 'string' ? error : 'Unknown error' };
}

function nonEmptyString(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Machine.
// ---------------------------------------------------------------------------

export const inspectMachine = setup({
    types: {
        context: {} as InspectContext,
        events: {} as InspectEvent,
        input: {} as InspectInput,
        output: {} as MachineOutput,
    },
    actors: {
        // Delegated Inspector work; the runner supplies the implementation.
        player: fromPromise<PlayerOutput, PlayerInput>(async () => {
            throw new Error('player actor must be provided by the runner');
        }),
    },
    actions: {
        // No-op accepted-outcome marker; the linked runtime consumes these
        // three string params to publish the accepted-outcome trace.
        'playbook.acceptedOutcome': (_args: unknown, _params: AcceptedOutcomeParams) => {},
        applyEntry: assign({
            inspectionRequest: ({ event }) => {
                const value = (event as { inspectionRequest?: unknown }).inspectionRequest;
                return typeof value === 'string' ? value : '';
            },
            discussionContext: ({ context, event }) => {
                const value = (event as { discussionContext?: unknown }).discussionContext;
                return typeof value === 'string' ? value : context.discussionContext;
            },
            report: () => '',
            status: () => null,
            lastError: () => null,
            pendingBossQuestion: () => null,
            bossReply: () => null,
        }),
        recordCompleted: assign({
            report: ({ event }) => reportOf(event),
            status: () => 'complete' as const,
        }),
        recordUnavailable: assign({
            report: ({ event }) => reportOf(event),
            status: () => 'unavailable' as const,
        }),
        setPendingBossQuestion: assign({
            pendingBossQuestion: ({ event }): PendingBossQuestion => {
                const output = playerOutputOf(event);
                const question = output && output.guard === 'needsBossReply' ? output.question : '';
                return {
                    questionId: 'inspecting',
                    resumeStateId: 'inspecting',
                    sourceItem: 'INSPECT-1',
                    asker: { kind: 'role' as const, roleId: 'inspector' },
                    question,
                };
            },
        }),
        storeBossReply: assign({
            bossReply: ({ event }) => {
                const answer = (event as { answer?: unknown }).answer;
                return typeof answer === 'string' ? answer : '';
            },
        }),
        clearBossReplyContext: assign({
            pendingBossQuestion: () => null,
            bossReply: () => null,
        }),
        rememberError: assign({
            lastError: ({ event }) => normalizeError((event as { error?: unknown }).error),
        }),
        rememberMalformedOutput: assign({
            lastError: () => ({
                name: 'MalformedActorOutput',
                message: 'Inspector returned an unrecognized result.',
            }),
        }),
        rememberEmptyReply: assign({
            lastError: () => ({
                name: 'InvalidBossReply',
                message: 'BOSS_REPLY carried an empty or whitespace-only answer.',
            }),
        }),
    },
    guards: {
        hasInspectionRequest: ({ event }) =>
            nonEmptyString((event as { inspectionRequest?: unknown }).inspectionRequest),
        hasBossReply: ({ event }) => nonEmptyString((event as { answer?: unknown }).answer),
        playerCompleted: ({ event }) => playerOutputOf(event)?.guard === 'completed',
        playerUnavailable: ({ event }) => playerOutputOf(event)?.guard === 'unavailable',
        playerNeedsBossReply: ({ event }) => playerOutputOf(event)?.guard === 'needsBossReply',
    },
}).createMachine({
    id: 'inspect',
    description:
        'Investigate and explain existing material or a running interface without changing the repository.',
    initial: 'ready',
    context: ({ input }) => ({
        inspectionRequest: input.inspectionRequest ?? '',
        discussionContext: input.discussionContext ?? '',
        report: '',
        status: null,
        lastError: null,
        pendingBossQuestion: null,
        bossReply: null,
    }),
    output: ({ context }): MachineOutput =>
        context.status === 'complete'
            ? { status: 'complete', report: context.report }
            : { status: 'unavailable', report: context.report },
    states: {
        ready: {
            id: 'ready',
            description: 'Idle hub awaiting a Boss inspection request.',
            tags: ['playbook.parked'],
            meta: {
                playbook: {
                    stateId: 'ready',
                    description: 'Idle hub awaiting a Boss inspection request.',
                },
            },
            on: {
                START: {
                    guard: 'hasInspectionRequest',
                    target: 'inspecting',
                    actions: 'applyEntry',
                },
            },
        },
        inspecting: {
            id: 'inspecting',
            description:
                'Inspector investigates the requested material and gives an evidence-based explanation.',
            tags: ['playbook.busy'],
            meta: {
                playbook: {
                    stateId: 'inspecting',
                    description:
                        'Inspector investigates the requested material and gives an evidence-based explanation.',
                    role: 'inspector',
                },
            },
            invoke: {
                src: 'player',
                input: ({ context }): PlayerInput => ({
                    stateId: 'inspecting',
                    role: 'inspector',
                    sourceItem: 'INSPECT-1',
                    prompt: INSPECT_1_PROMPT,
                    inspectionRequest: context.inspectionRequest,
                    discussionContext: context.discussionContext,
                    ...(context.pendingBossQuestion
                        ? { pendingBossQuestion: context.pendingBossQuestion }
                        : {}),
                    ...(context.bossReply ? { bossReply: context.bossReply } : {}),
                    result: INSPECT_1_RESULT,
                }),
                onDone: [
                    {
                        guard: 'playerCompleted',
                        target: 'complete',
                        actions: [
                            {
                                type: 'playbook.acceptedOutcome',
                                params: {
                                    source: 'inspecting',
                                    target: 'complete',
                                    acceptedOutcome: 'completed',
                                },
                            },
                            'recordCompleted',
                            'clearBossReplyContext',
                        ],
                    },
                    {
                        guard: 'playerUnavailable',
                        target: 'unavailable',
                        actions: [
                            {
                                type: 'playbook.acceptedOutcome',
                                params: {
                                    source: 'inspecting',
                                    target: 'unavailable',
                                    acceptedOutcome: 'unavailable',
                                },
                            },
                            'recordUnavailable',
                            'clearBossReplyContext',
                        ],
                    },
                    {
                        guard: 'playerNeedsBossReply',
                        target: 'awaitBossReply',
                        actions: [
                            {
                                type: 'playbook.acceptedOutcome',
                                params: {
                                    source: 'inspecting',
                                    target: 'awaitBossReply',
                                    acceptedOutcome: 'needsBossReply',
                                },
                            },
                            'setPendingBossQuestion',
                        ],
                    },
                    {
                        target: 'failed',
                        actions: ['rememberMalformedOutput', 'clearBossReplyContext'],
                    },
                ],
                onError: {
                    target: 'failed',
                    actions: ['rememberError', 'clearBossReplyContext'],
                },
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
                BOSS_REPLY: [
                    {
                        guard: 'hasBossReply',
                        target: '#inspecting',
                        reenter: true,
                        actions: 'storeBossReply',
                    },
                    {
                        target: '#failed',
                        actions: ['rememberEmptyReply', 'clearBossReplyContext'],
                    },
                ],
            },
        },
        complete: {
            id: 'complete',
            type: 'final',
            description: 'The inspection is complete without a repository change.',
            meta: {
                playbook: {
                    stateId: 'complete',
                    description: 'The inspection is complete without a repository change.',
                    terminal: 'success',
                },
            },
        },
        unavailable: {
            id: 'unavailable',
            type: 'final',
            description: 'The requested inspection could not be completed.',
            meta: {
                playbook: {
                    stateId: 'unavailable',
                    description: 'The requested inspection could not be completed.',
                    terminal: 'failure',
                },
            },
        },
        failed: {
            id: 'failed',
            description:
                'A control error or malformed result interrupted the inspection; awaiting Boss recovery.',
            tags: ['playbook.parked'],
            meta: {
                playbook: {
                    stateId: 'failed',
                    description:
                        'A control error or malformed result interrupted the inspection; awaiting Boss recovery.',
                },
            },
            on: {
                START: {
                    guard: 'hasInspectionRequest',
                    target: 'inspecting',
                    actions: 'applyEntry',
                },
            },
        },
    },
});
