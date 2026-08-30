// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// FSM object artifact compiled from review.gears.md.
// The linked runtime supplies the delegated-player actor.

import { assign, fromPromise, setup } from 'xstate';

type Role = 'coder' | 'reviewer';

type JumpableStateId = 'reviewInitial';

export type ResumableStateId =
  | 'reviewInitial'
  | 'addressFindings'
  | 'reviewAfterCommit'
  | 'reviewAfterRebuttal';

export interface PendingBossQuestion {
  questionId: ResumableStateId;
  resumeStateId: ResumableStateId;
  sourceItem: `REVIEW-${1 | 2 | 3 | 4}`;
  asker: { readonly kind: 'role'; readonly roleId: Role };
  question: string;
}

export interface ReviewOutput {
  approvedCommit: 'latest';
  noUnsettledFindings: true;
}

export type ReviewInput = Readonly<Record<string, never>>;

export interface ReviewContext {
  callerInput?: string;
  reviewerOutput?: string;
  coderOutput?: string;
  lastError?: unknown;
  pendingBossQuestion?: PendingBossQuestion;
  bossReply?: string;
}

export type ReviewEvent =
  | { type: 'START_REVIEW'; callerInput: string }
  | {
      type: 'BOSS_INTERRUPT';
      targetId: JumpableStateId;
      bossIntent: string;
    }
  | {
      type: 'BOSS_REPLY';
      questionId?: ResumableStateId;
      answer: string;
    };

export interface PlayerInput {
  stateId: ResumableStateId;
  sourceItem: `REVIEW-${1 | 2 | 3 | 4}`;
  role: Role;
  prompt: string;
  result: Readonly<Record<string, string>>;
  callerInput?: string;
  reviewerOutput?: string;
  coderOutput?: string;
  pendingBossQuestion?: PendingBossQuestion;
  bossReply?: string;
}

export type PlayerOutput =
  | { guard: 'hasFindings'; reviewerOutput: string }
  | { guard: 'noFindings' }
  | { guard: 'committed'; coderOutput: string }
  | { guard: 'rejectedAll'; coderOutput: string }
  | { guard: 'needsBossReply'; question: string };

type PlayerDoneEvent = { type: string; output: PlayerOutput };

const NEEDS_BOSS_REPLY_DESCRIPTION =
  "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

const SHARED_REVIEW_INSTRUCTION = [
  'Understand the full picture and think systematically about the underlying design.',
  'Continue to identify issues or improvements, if any (numbered; no duplication).',
  'For any rebuttal, accept or challenge it.',
  'Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.',
  'Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.',
  'For specs, flag stale, missing, over-specified, or under-specified ones.',
  'Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.',
  '',
  'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
  'Do not edit files or commit; report findings only.',
  '',
  'Consult @specs/map.md for context if needed; verify it remains accurate.',
  'Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.',
].join('\n');

const INITIAL_REVIEW_PROMPT = [
  'A new review begins on the latest commit.',
  'Review the latest commit and resulting repository state; read the commit message first for its intent, scope, and rationale.',
  '',
  '> <caller-input>',
  '',
  SHARED_REVIEW_INSTRUCTION,
].join('\n');

const POST_COMMIT_REVIEW_PROMPT = [
  'Review the latest commit and resulting repository state; read the commit message first for its intent, scope, and rationale.',
  '',
  '> <coder-output>',
  '',
  SHARED_REVIEW_INSTRUCTION,
].join('\n');

const REBUTTAL_REVIEW_PROMPT = [
  'No new commit was made because Coder rejected every finding.',
  '',
  '> <coder-output>',
  '',
  SHARED_REVIEW_INSTRUCTION,
].join('\n');

const CODER_DISPOSITION_PROMPT = [
  '> <reviewer-output>',
  '',
  'For each review item, accept or reject it.',
  'Before deciding, understand the full picture and think systematically about the underlying design.',
  'Reject anything that is not essential or is not worth fixing now.',
  'If you accept an item, fix its root cause, including any fundamental design flaw - do not patch around it.',
  'If you reject an item, give the reasoning and cite code or test output that supports it.',
  'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
  '',
  'If you accept any item, make minimal changes and commit them as one new commit; never amend the reviewed commit.',
  'Follow @specs/packages/git.md.',
  'Make the commit message explain concisely what changed and why, including relevant verification.',
  'Coder is <coder-llm>; Reviewer is <reviewer-llm>; format model tokens in conventional human form.',
  '',
  'If you reject every item, change nothing and make no commit.',
  'Report every disposition, all relevant run results, and every rebuttal.',
].join('\n');

const REVIEW_RESULTS = {
  hasFindings:
    'Reviewer raised one or more unsettled findings. Output shall include `reviewerOutput: <verbatim final text>`.',
  noFindings: 'Reviewer raised no unsettled findings.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} as const;

const REBUTTAL_RESULTS = {
  hasFindings:
    'Reviewer kept one or more unsettled findings. Output shall include `reviewerOutput: <verbatim final text>`.',
  noFindings:
    'Reviewer accepted the rebuttals and no unsettled findings remain.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} as const;

const CODER_RESULTS = {
  committed:
    'Coder accepted at least one item and made one new commit. Output shall include `coderOutput: <verbatim final text>`.',
  rejectedAll:
    'Coder rejected every item and made no commit. Output shall include `coderOutput: <verbatim final text>`.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} as const;

const stateDescriptions = {
  ready: 'Waits for a caller to start a committed-work review.',
  reviewInitial:
    'REVIEW-1: Reviewer examines the latest commit against the caller input.',
  addressFindings:
    'REVIEW-2: Coder accepts or rejects every current review finding.',
  reviewAfterCommit:
    'REVIEW-3: Reviewer examines the new review-fix commit and repository state.',
  reviewAfterRebuttal:
    'REVIEW-4: Reviewer adjudicates an all-rejected Coder disposition.',
  awaitBossReply: 'Waits for Boss to answer the active player question.',
  failed: 'Retains a recoverable REVIEW failure for the caller.',
  done: 'The latest commit is approved with no unsettled findings.',
} as const;

const playbookMeta = <StateId extends keyof typeof stateDescriptions>(
  stateId: StateId,
  role?: Role,
) => ({
  playbook: {
    stateId,
    description: stateDescriptions[stateId],
    ...(role === undefined ? {} : { role }),
  },
});

const outputOf = (event: unknown): PlayerOutput =>
  (event as PlayerDoneEvent).output;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const stateMetadata = {
  reviewInitial: {
    sourceItem: 'REVIEW-1',
    asker: { kind: 'role', roleId: 'reviewer' },
  },
  addressFindings: {
    sourceItem: 'REVIEW-2',
    asker: { kind: 'role', roleId: 'coder' },
  },
  reviewAfterCommit: {
    sourceItem: 'REVIEW-3',
    asker: { kind: 'role', roleId: 'reviewer' },
  },
  reviewAfterRebuttal: {
    sourceItem: 'REVIEW-4',
    asker: { kind: 'role', roleId: 'reviewer' },
  },
} as const satisfies Record<
  ResumableStateId,
  {
    sourceItem: `REVIEW-${1 | 2 | 3 | 4}`;
    asker: { readonly kind: 'role'; readonly roleId: Role };
  }
>;

const playerPlaceholder = fromPromise<PlayerOutput, PlayerInput>(async () => {
  throw new Error('player actor must be provided by the runner');
});

export const reviewMachine = setup({
  types: {
    context: {} as ReviewContext,
    events: {} as ReviewEvent,
    input: {} as ReviewInput,
    output: {} as ReviewOutput,
  },
  actors: {
    player: playerPlaceholder,
  },
  guards: {
    hasFindings: ({ event }) => {
      const output = outputOf(event);
      return (
        output.guard === 'hasFindings' &&
        isNonEmptyString(output.reviewerOutput)
      );
    },
    noFindings: ({ event }) => outputOf(event).guard === 'noFindings',
    committed: ({ event }) => {
      const output = outputOf(event);
      return (
        output.guard === 'committed' && isNonEmptyString(output.coderOutput)
      );
    },
    rejectedAll: ({ event }) => {
      const output = outputOf(event);
      return (
        output.guard === 'rejectedAll' && isNonEmptyString(output.coderOutput)
      );
    },
    needsBossReply: ({ event }) => {
      const output = outputOf(event);
      return (
        output.guard === 'needsBossReply' && isNonEmptyString(output.question)
      );
    },
    emptyBossReply: ({ event }) =>
      event.type === 'BOSS_REPLY' && event.answer.trim().length === 0,
    resumeReviewInitial: ({ context, event }) =>
      event.type === 'BOSS_REPLY' &&
      event.answer.trim().length > 0 &&
      context.pendingBossQuestion?.resumeStateId === 'reviewInitial' &&
      (event.questionId === undefined ||
        event.questionId === context.pendingBossQuestion.questionId),
    resumeAddressFindings: ({ context, event }) =>
      event.type === 'BOSS_REPLY' &&
      event.answer.trim().length > 0 &&
      context.pendingBossQuestion?.resumeStateId === 'addressFindings' &&
      (event.questionId === undefined ||
        event.questionId === context.pendingBossQuestion.questionId),
    resumeReviewAfterCommit: ({ context, event }) =>
      event.type === 'BOSS_REPLY' &&
      event.answer.trim().length > 0 &&
      context.pendingBossQuestion?.resumeStateId === 'reviewAfterCommit' &&
      (event.questionId === undefined ||
        event.questionId === context.pendingBossQuestion.questionId),
    resumeReviewAfterRebuttal: ({ context, event }) =>
      event.type === 'BOSS_REPLY' &&
      event.answer.trim().length > 0 &&
      context.pendingBossQuestion?.resumeStateId === 'reviewAfterRebuttal' &&
      (event.questionId === undefined ||
        event.questionId === context.pendingBossQuestion.questionId),
    restartInitialReview: ({ event }) =>
      event.type === 'BOSS_INTERRUPT' &&
      event.targetId === 'reviewInitial' &&
      typeof event.bossIntent === 'string' &&
      event.bossIntent.trim().length > 0,
  },
  actions: {
    'playbook.acceptedOutcome': (
      _args,
      _params: {
        readonly source: string;
        readonly target: string;
        readonly acceptedOutcome: string;
      },
    ) => undefined,
    copyStartInput: assign({
      callerInput: ({ event }) =>
        event.type === 'START_REVIEW' ? event.callerInput : undefined,
      reviewerOutput: undefined,
      coderOutput: undefined,
      lastError: undefined,
      pendingBossQuestion: undefined,
      bossReply: undefined,
    }),
    copyInterruptedInput: assign({
      callerInput: ({ event }) =>
        event.type === 'BOSS_INTERRUPT' ? event.bossIntent : undefined,
      reviewerOutput: undefined,
      coderOutput: undefined,
      lastError: undefined,
      pendingBossQuestion: undefined,
      bossReply: undefined,
    }),
    rememberReviewerOutput: assign({
      reviewerOutput: ({ event }) => {
        const output = outputOf(event);
        return output.guard === 'hasFindings'
          ? output.reviewerOutput
          : undefined;
      },
      lastError: undefined,
      pendingBossQuestion: undefined,
      bossReply: undefined,
    }),
    rememberCoderOutput: assign({
      coderOutput: ({ event }) => {
        const output = outputOf(event);
        return output.guard === 'committed' || output.guard === 'rejectedAll'
          ? output.coderOutput
          : undefined;
      },
      lastError: undefined,
      pendingBossQuestion: undefined,
      bossReply: undefined,
    }),
    clearBossReplyContext: assign({
      pendingBossQuestion: undefined,
      bossReply: undefined,
    }),
    rememberBossReply: assign({
      bossReply: ({ event }) =>
        event.type === 'BOSS_REPLY' ? event.answer : undefined,
    }),
    rememberActorError: assign({
      lastError: ({ event }) =>
        (event as { error?: unknown }).error ??
        new Error('REVIEW player invocation failed'),
    }),
    rememberEmptyBossReplyError: assign({
      lastError: () => new Error('BOSS_REPLY received an empty answer'),
      pendingBossQuestion: undefined,
      bossReply: undefined,
    }),
    setPendingReviewInitial: assign({
      pendingBossQuestion: ({ event }) => {
        const output = outputOf(event);
        return {
          questionId: 'reviewInitial',
          resumeStateId: 'reviewInitial',
          ...stateMetadata.reviewInitial,
          question: output.guard === 'needsBossReply' ? output.question : '',
        };
      },
      bossReply: undefined,
    }),
    setPendingAddressFindings: assign({
      pendingBossQuestion: ({ event }) => {
        const output = outputOf(event);
        return {
          questionId: 'addressFindings',
          resumeStateId: 'addressFindings',
          ...stateMetadata.addressFindings,
          question: output.guard === 'needsBossReply' ? output.question : '',
        };
      },
      bossReply: undefined,
    }),
    setPendingReviewAfterCommit: assign({
      pendingBossQuestion: ({ event }) => {
        const output = outputOf(event);
        return {
          questionId: 'reviewAfterCommit',
          resumeStateId: 'reviewAfterCommit',
          ...stateMetadata.reviewAfterCommit,
          question: output.guard === 'needsBossReply' ? output.question : '',
        };
      },
      bossReply: undefined,
    }),
    setPendingReviewAfterRebuttal: assign({
      pendingBossQuestion: ({ event }) => {
        const output = outputOf(event);
        return {
          questionId: 'reviewAfterRebuttal',
          resumeStateId: 'reviewAfterRebuttal',
          ...stateMetadata.reviewAfterRebuttal,
          question: output.guard === 'needsBossReply' ? output.question : '',
        };
      },
      bossReply: undefined,
    }),
  },
}).createMachine({
  id: 'review',
  context: {},
  initial: 'ready',
  on: {
    BOSS_INTERRUPT: {
      guard: 'restartInitialReview',
      target: '#reviewInitial',
      reenter: true,
      actions: 'copyInterruptedInput',
    },
  },
  states: {
    ready: {
      id: 'ready',
      description: stateDescriptions.ready,
      meta: playbookMeta('ready'),
      tags: ['playbook.parked'],
      on: {
        START_REVIEW: {
          guard: ({ event }) => event.callerInput.trim().length > 0,
          target: '#reviewInitial',
          actions: 'copyStartInput',
        },
      },
    },
    reviewInitial: {
      id: 'reviewInitial',
      description: stateDescriptions.reviewInitial,
      meta: playbookMeta('reviewInitial', 'reviewer'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewInitial',
          sourceItem: 'REVIEW-1',
          role: 'reviewer',
          prompt: INITIAL_REVIEW_PROMPT,
          result: REVIEW_RESULTS,
          callerInput: context.callerInput,
          pendingBossQuestion: context.pendingBossQuestion,
          bossReply: context.bossReply,
        }),
        onDone: [
          {
            guard: 'hasFindings',
            target: '#addressFindings',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewInitial',
                  target: 'addressFindings',
                  acceptedOutcome: 'hasFindings',
                },
              },
              'rememberReviewerOutput',
            ],
          },
          {
            guard: 'noFindings',
            target: '#done',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewInitial',
                  target: 'done',
                  acceptedOutcome: 'noFindings',
                },
              },
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'needsBossReply',
            target: '#awaitBossReply',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewInitial',
                  target: 'awaitBossReply',
                  acceptedOutcome: 'needsBossReply',
                },
              },
              'setPendingReviewInitial',
            ],
          },
        ],
        onError: {
          target: '#failed',
          actions: 'rememberActorError',
        },
      },
    },
    addressFindings: {
      id: 'addressFindings',
      description: stateDescriptions.addressFindings,
      meta: playbookMeta('addressFindings', 'coder'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'addressFindings',
          sourceItem: 'REVIEW-2',
          role: 'coder',
          prompt: CODER_DISPOSITION_PROMPT,
          result: CODER_RESULTS,
          reviewerOutput: context.reviewerOutput,
          pendingBossQuestion: context.pendingBossQuestion,
          bossReply: context.bossReply,
        }),
        onDone: [
          {
            guard: 'committed',
            target: '#reviewAfterCommit',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'addressFindings',
                  target: 'reviewAfterCommit',
                  acceptedOutcome: 'committed',
                },
              },
              'rememberCoderOutput',
            ],
          },
          {
            guard: 'rejectedAll',
            target: '#reviewAfterRebuttal',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'addressFindings',
                  target: 'reviewAfterRebuttal',
                  acceptedOutcome: 'rejectedAll',
                },
              },
              'rememberCoderOutput',
            ],
          },
          {
            guard: 'needsBossReply',
            target: '#awaitBossReply',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'addressFindings',
                  target: 'awaitBossReply',
                  acceptedOutcome: 'needsBossReply',
                },
              },
              'setPendingAddressFindings',
            ],
          },
        ],
        onError: {
          target: '#failed',
          actions: 'rememberActorError',
        },
      },
    },
    reviewAfterCommit: {
      id: 'reviewAfterCommit',
      description: stateDescriptions.reviewAfterCommit,
      meta: playbookMeta('reviewAfterCommit', 'reviewer'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewAfterCommit',
          sourceItem: 'REVIEW-3',
          role: 'reviewer',
          prompt: POST_COMMIT_REVIEW_PROMPT,
          result: REVIEW_RESULTS,
          coderOutput: context.coderOutput,
          pendingBossQuestion: context.pendingBossQuestion,
          bossReply: context.bossReply,
        }),
        onDone: [
          {
            guard: 'hasFindings',
            target: '#addressFindings',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewAfterCommit',
                  target: 'addressFindings',
                  acceptedOutcome: 'hasFindings',
                },
              },
              'rememberReviewerOutput',
            ],
          },
          {
            guard: 'noFindings',
            target: '#done',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewAfterCommit',
                  target: 'done',
                  acceptedOutcome: 'noFindings',
                },
              },
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'needsBossReply',
            target: '#awaitBossReply',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewAfterCommit',
                  target: 'awaitBossReply',
                  acceptedOutcome: 'needsBossReply',
                },
              },
              'setPendingReviewAfterCommit',
            ],
          },
        ],
        onError: {
          target: '#failed',
          actions: 'rememberActorError',
        },
      },
    },
    reviewAfterRebuttal: {
      id: 'reviewAfterRebuttal',
      description: stateDescriptions.reviewAfterRebuttal,
      meta: playbookMeta('reviewAfterRebuttal', 'reviewer'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewAfterRebuttal',
          sourceItem: 'REVIEW-4',
          role: 'reviewer',
          prompt: REBUTTAL_REVIEW_PROMPT,
          result: REBUTTAL_RESULTS,
          coderOutput: context.coderOutput,
          pendingBossQuestion: context.pendingBossQuestion,
          bossReply: context.bossReply,
        }),
        onDone: [
          {
            guard: 'hasFindings',
            target: '#addressFindings',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewAfterRebuttal',
                  target: 'addressFindings',
                  acceptedOutcome: 'hasFindings',
                },
              },
              'rememberReviewerOutput',
            ],
          },
          {
            guard: 'noFindings',
            target: '#done',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewAfterRebuttal',
                  target: 'done',
                  acceptedOutcome: 'noFindings',
                },
              },
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'needsBossReply',
            target: '#awaitBossReply',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'reviewAfterRebuttal',
                  target: 'awaitBossReply',
                  acceptedOutcome: 'needsBossReply',
                },
              },
              'setPendingReviewAfterRebuttal',
            ],
          },
        ],
        onError: {
          target: '#failed',
          actions: 'rememberActorError',
        },
      },
    },
    awaitBossReply: {
      id: 'awaitBossReply',
      description: stateDescriptions.awaitBossReply,
      meta: playbookMeta('awaitBossReply'),
      tags: ['playbook.parked'],
      on: {
        START_REVIEW: {
          guard: ({ event }) => event.callerInput.trim().length > 0,
          target: '#reviewInitial',
          actions: 'copyStartInput',
        },
        BOSS_REPLY: [
          {
            guard: 'emptyBossReply',
            target: '#failed',
            actions: 'rememberEmptyBossReplyError',
          },
          {
            guard: 'resumeReviewInitial',
            target: '#reviewInitial',
            reenter: true,
            actions: 'rememberBossReply',
          },
          {
            guard: 'resumeAddressFindings',
            target: '#addressFindings',
            reenter: true,
            actions: 'rememberBossReply',
          },
          {
            guard: 'resumeReviewAfterCommit',
            target: '#reviewAfterCommit',
            reenter: true,
            actions: 'rememberBossReply',
          },
          {
            guard: 'resumeReviewAfterRebuttal',
            target: '#reviewAfterRebuttal',
            reenter: true,
            actions: 'rememberBossReply',
          },
        ],
      },
    },
    failed: {
      id: 'failed',
      description: stateDescriptions.failed,
      meta: playbookMeta('failed'),
      tags: ['playbook.parked'],
      on: {
        START_REVIEW: {
          guard: ({ event }) => event.callerInput.trim().length > 0,
          target: '#reviewInitial',
          actions: 'copyStartInput',
        },
      },
    },
    done: {
      id: 'done',
      description: stateDescriptions.done,
      meta: playbookMeta('done'),
      type: 'final',
    },
  },
  output: (): ReviewOutput => ({
    approvedCommit: 'latest',
    noUnsettledFindings: true,
  }),
});
