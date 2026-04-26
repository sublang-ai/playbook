// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { assign, setup } from 'xstate';

type Role = 'Coder' | 'Reviewer';

type JumpableStateId =
  | 'ready'
  | 'planAndImplement'
  | 'implementIr'
  | 'continueIr'
  | 'reviewCodeCommit'
  | 'reviewCodeChanges'
  | 'respondToReview'
  | 'adjudicateChallenges'
  | 'commitChanges'
  | 'pushMilestone'
  | 'reviewCiFailure'
  | 'rerunCi'
  | 'fixCi'
  | 'summarizeSpecs'
  | 'reviewSpecChanges'
  | 'failed';

type WorkflowKind = 'singleCommit' | 'iteration' | 'adHoc' | 'specSummary';
type ReviewSubject = 'commit' | 'changes' | 'specs';
type AfterReview = 'implementIr' | 'continueIr' | 'pushMilestone' | 'summarizeSpecs' | 'done';
type AfterCommit =
  | 'implementIr'
  | 'continueIr'
  | 'pushMilestone'
  | 'summarizeSpecs'
  | 'done'
  | 'reviewCodeCommit';

export type CaptainInput = {
  role: Role;
  sourceItems: string[];
  prompt: string;
  result: Record<string, string>;
};

export type CaptainOutput = {
  guard: string;
  summary?: string;
  irNumber?: string;
  reviews?: string;
  challenges?: string;
  [key: string]: unknown;
};

export type CodingInput = {
  intent?: string;
  irNumber?: string;
  players?: string;
  coderPlayer?: string;
  reviewerPlayer?: string;
};

export type CodingContext = CodingInput & {
  workflow?: WorkflowKind;
  reviewSubject?: ReviewSubject;
  afterReview?: AfterReview;
  afterCommit?: AfterCommit;
  reviews?: string;
  challenges?: string;
  lastResult?: CaptainOutput;
  lastError?: unknown;
};

export type CodingEvent =
  | { type: 'START_CODING'; intent: string; players?: string }
  | { type: 'IMPLEMENT_IR'; irNumber: string; players?: string }
  | { type: 'CONTINUE_IR'; irNumber: string; players?: string }
  | { type: 'REVIEW_COMMIT'; players?: string }
  | { type: 'REVIEW_CHANGES'; players?: string }
  | { type: 'COMMIT_CHANGES'; players?: string }
  | { type: 'PUSH_MILESTONE'; irNumber?: string; players?: string }
  | { type: 'SUMMARIZE_IR'; irNumber: string; players?: string }
  | { type: 'REVIEW_SPECS'; irNumber?: string; players?: string }
  | { type: 'BOSS_INTERRUPT'; targetId: JumpableStateId; intent?: string; irNumber?: string; players?: string };

const jumpableStateIds = [
  'ready',
  'planAndImplement',
  'implementIr',
  'continueIr',
  'reviewCodeCommit',
  'reviewCodeChanges',
  'respondToReview',
  'adjudicateChallenges',
  'commitChanges',
  'pushMilestone',
  'reviewCiFailure',
  'rerunCi',
  'fixCi',
  'summarizeSpecs',
  'reviewSpecChanges',
  'failed',
] as const satisfies readonly JumpableStateId[];

const outputOf = (event: unknown): CaptainOutput | undefined =>
  (event as { output?: CaptainOutput }).output;

const outputGuardIs = (guard: string) => ({ event }: { event: unknown }) =>
  outputOf(event)?.guard === guard;

const outputGuardIsWorkflow = (guard: string, workflow: WorkflowKind) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    context.workflow === workflow && outputOf(event)?.guard === guard;

const noFindingsAfter = (afterReview: AfterReview) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.guard === 'noFindings' && context.afterReview === afterReview;

const committedAfter = (afterCommit: AfterCommit) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.guard === 'committed' && context.afterCommit === afterCommit;

const noRelevantChangesAfter = (afterCommit: AfterCommit) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.guard === 'noRelevantChanges' && context.afterCommit === afterCommit;

const changesMadeFor = (subject: ReviewSubject) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.guard === 'changesMade' && context.reviewSubject === subject;

const challengesNeedReviewFor = (subject: ReviewSubject) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.guard === 'changesNeedReview' && context.reviewSubject === subject;

const bossInterrupts = (ids: readonly JumpableStateId[]) =>
  ids.map((id) => ({
    target: `#${id}` as const,
    guard: ({ event }: { event: CodingEvent }) =>
      event.type === 'BOSS_INTERRUPT' && event.targetId === id,
    reenter: true,
    actions: rememberBossInput,
  }));

const afterCiFixReview = (context: CodingContext): AfterReview =>
  context.workflow === 'iteration' ? 'summarizeSpecs' : 'done';

const afterReviewedFixCommit = (context: CodingContext): AfterCommit =>
  context.afterReview ?? context.afterCommit ?? 'done';

const rememberCaptainOutput = assign({
  lastResult: ({ event }) => outputOf(event),
  lastError: () => undefined,
  irNumber: ({ context, event }) => outputOf(event)?.irNumber ?? context.irNumber,
  reviews: ({ context, event }) => outputOf(event)?.reviews ?? context.reviews,
  challenges: ({ context, event }) => outputOf(event)?.challenges ?? context.challenges,
});

const rememberCaptainError = assign({
  lastError: ({ event }) => (event as { error?: unknown }).error,
});

const rememberBossInput = assign({
  intent: ({ context, event }) => (event as { intent?: string }).intent ?? context.intent,
  irNumber: ({ context, event }) => (event as { irNumber?: string }).irNumber ?? context.irNumber,
  players: ({ context, event }) => (event as { players?: string }).players ?? context.players,
});

const setCodeReviewContext = assign({
  workflow: ({ context }) => context.workflow ?? 'adHoc',
  reviewSubject: () => 'changes' as const,
  afterCommit: ({ context }) => context.afterCommit ?? ('done' as const),
});

const playerLine = (context: CodingContext) =>
  context.players ??
  `You (${context.coderPlayer ?? 'Coder'}) are Coder; ${context.reviewerPlayer ?? 'Reviewer'} is Reviewer.`;

const priorContextLines = (context: CodingContext) => {
  const lines: string[] = [];

  if (context.lastResult?.summary) {
    lines.push(`Previous summary: ${context.lastResult.summary}`);
  }
  if (context.reviews) {
    lines.push(`Review items: ${context.reviews}`);
  }
  if (context.challenges) {
    lines.push(`Coder challenges: ${context.challenges}`);
  }

  return lines;
};

const prompt = (context: CodingContext, lines: string[]) =>
  [...lines, ...priorContextLines(context)].filter(Boolean).join('\n');

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
        workflow: () => 'singleCommit' as const,
        afterReview: () => 'done' as const,
        afterCommit: () => 'done' as const,
      }),
    ],
  },
  IMPLEMENT_IR: {
    target: '#implementIr',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'iteration' as const,
        afterReview: () => 'continueIr' as const,
        afterCommit: () => 'continueIr' as const,
      }),
    ],
  },
  CONTINUE_IR: {
    target: '#continueIr',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'iteration' as const,
        afterReview: () => 'continueIr' as const,
        afterCommit: () => 'continueIr' as const,
      }),
    ],
  },
  REVIEW_COMMIT: {
    target: '#reviewCodeCommit',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'adHoc' as const,
        reviewSubject: () => 'commit' as const,
        afterReview: () => 'done' as const,
        afterCommit: () => 'done' as const,
      }),
    ],
  },
  REVIEW_CHANGES: {
    target: '#reviewCodeChanges',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'adHoc' as const,
        reviewSubject: () => 'changes' as const,
        afterCommit: () => 'done' as const,
      }),
    ],
  },
  COMMIT_CHANGES: {
    target: '#commitChanges',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'adHoc' as const,
        afterCommit: () => 'reviewCodeCommit' as const,
      }),
    ],
  },
  PUSH_MILESTONE: {
    target: '#pushMilestone',
    actions: [
      rememberBossInput,
      assign({
        workflow: ({ event }) =>
          (event as { irNumber?: string }).irNumber ? ('iteration' as const) : ('adHoc' as const),
        afterReview: ({ event }) =>
          (event as { irNumber?: string }).irNumber ? ('summarizeSpecs' as const) : ('done' as const),
        afterCommit: ({ event }) =>
          (event as { irNumber?: string }).irNumber ? ('summarizeSpecs' as const) : ('done' as const),
      }),
    ],
  },
  SUMMARIZE_IR: {
    target: '#summarizeSpecs',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'specSummary' as const,
        reviewSubject: () => 'specs' as const,
        afterCommit: () => 'done' as const,
      }),
    ],
  },
  REVIEW_SPECS: {
    target: '#reviewSpecChanges',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'specSummary' as const,
        reviewSubject: () => 'specs' as const,
        afterCommit: () => 'done' as const,
      }),
    ],
  },
};

export const codingMachine = setup({
  types: {} as {
    context: CodingContext;
    events: CodingEvent;
    input: CodingInput | undefined;
    actors: {
      src: 'Captain';
      input: CaptainInput;
      output: CaptainOutput;
    };
  },
}).createMachine({
  id: 'coding',
  context: ({ input }) => ({
    intent: input?.intent,
    irNumber: input?.irNumber,
    players: input?.players,
    coderPlayer: input?.coderPlayer,
    reviewerPlayer: input?.reviewerPlayer,
  }),
  initial: 'ready',
  on: {
    BOSS_INTERRUPT: bossInterrupts(jumpableStateIds),
  },
  states: {
    ready: {
      id: 'ready',
      description: 'Waits for Boss to start or resume a coding sub-procedure.',
      on: readyEvents,
    },

    planAndImplement: {
      id: 'planAndImplement',
      description: 'Turns a Boss intent into either a single committed change or a reviewed iteration plan.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-1'],
          prompt: prompt(context, [
            `Boss intent: ${context.intent ?? '(not supplied)'}`,
            '',
            'Estimate if this can be done in a single commit, following best practices.',
            'If yes, implement, test, and commit; otherwise, break it into tasks as a new iteration in @specs/iterations (every task should be a commit), and commit the IR.',
            'Consult @specs/map.md to find relevant if needed.',
          ]),
          result: {
            singleCommitCommitted: 'The intent was implemented, tested, and committed as one commit.',
            iterationCommitted: 'A new iteration with per-commit tasks was created and committed.',
            needsBossInput: 'Progress requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: outputGuardIs('singleCommitCommitted'),
            target: '#reviewCodeCommit',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'singleCommit' as const,
                reviewSubject: () => 'commit' as const,
                afterReview: () => 'done' as const,
              }),
            ],
          },
          {
            guard: outputGuardIs('iterationCommitted'),
            target: '#reviewCodeCommit',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                reviewSubject: () => 'commit' as const,
                afterReview: () => 'implementIr' as const,
              }),
            ],
          },
          { guard: outputGuardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    implementIr: {
      id: 'implementIr',
      description: 'Implements the first task of a drafted and reviewed iteration.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-2', 'CODE-3'],
          prompt: prompt(context, [
            `IR number: ${context.irNumber ?? '<#>'}`,
            '',
            'Every task is a commit (including corresponding tests if any).',
            'Stop after each commit for review.',
            `Implement IR-${context.irNumber ?? '<#>'}.`,
          ]),
          result: {
            taskCommitted: 'An IR task was completed and committed.',
            changesReadyForReview: 'Uncommitted changes are ready for review before commit.',
            iterationDone: 'All IR deliverables and tasks are done.',
            needsBossInput: 'Progress requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: outputGuardIs('taskCommitted'),
            target: '#reviewCodeCommit',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                reviewSubject: () => 'commit' as const,
                afterReview: () => 'continueIr' as const,
              }),
            ],
          },
          {
            guard: outputGuardIs('changesReadyForReview'),
            target: '#reviewCodeChanges',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                reviewSubject: () => 'changes' as const,
                afterCommit: () => 'continueIr' as const,
              }),
            ],
          },
          {
            guard: outputGuardIs('iterationDone'),
            target: '#pushMilestone',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                afterReview: () => 'summarizeSpecs' as const,
                afterCommit: () => 'summarizeSpecs' as const,
              }),
            ],
          },
          { guard: outputGuardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    continueIr: {
      id: 'continueIr',
      description: 'Continues an iteration after the previous task has passed review.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-2', 'CODE-4'],
          prompt: prompt(context, [
            `IR number: ${context.irNumber ?? '<#>'}`,
            '',
            'Every task is a commit (including corresponding tests if any).',
            'Stop after each commit for review.',
            `Continue to implement IR-${context.irNumber ?? '<#>'} if not all deliverables and tasks are done.`,
          ]),
          result: {
            taskCommitted: 'Another IR task was completed and committed.',
            changesReadyForReview: 'Uncommitted changes are ready for review before commit.',
            iterationDone: 'All IR deliverables and tasks are done.',
            needsBossInput: 'Progress requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: outputGuardIs('taskCommitted'),
            target: '#reviewCodeCommit',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                reviewSubject: () => 'commit' as const,
                afterReview: () => 'continueIr' as const,
              }),
            ],
          },
          {
            guard: outputGuardIs('changesReadyForReview'),
            target: '#reviewCodeChanges',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                reviewSubject: () => 'changes' as const,
                afterCommit: () => 'continueIr' as const,
              }),
            ],
          },
          {
            guard: outputGuardIs('iterationDone'),
            target: '#pushMilestone',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                afterReview: () => 'summarizeSpecs' as const,
                afterCommit: () => 'summarizeSpecs' as const,
              }),
            ],
          },
          { guard: outputGuardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    reviewCodeCommit: {
      id: 'reviewCodeCommit',
      description: 'Reviews a committed code or IR change and advances to the next workflow step on approval.',
      invoke: {
        src: 'Captain',
        input: (): CaptainInput => ({
          role: 'Reviewer',
          sourceItems: ['CODE-5', 'CODE-6'],
          prompt: [
            'Review the latest commit.',
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly - don't just approve or reject.",
            "If the change is ready to commit or push, don't raise nitpicks.",
            'Consult @specs/map.md to find relevant context if needed.',
          ].join('\n'),
          result: {
            noFindings: 'The latest commit has no review findings.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          { guard: noFindingsAfter('implementIr'), target: '#implementIr', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('pushMilestone'), target: '#pushMilestone', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
          {
            guard: outputGuardIs('hasFindings'),
            target: '#respondToReview',
            actions: [
              rememberCaptainOutput,
              assign({
                reviewSubject: () => 'commit' as const,
                afterReview: ({ context }) => context.afterReview ?? ('done' as const),
                afterCommit: ({ context }) => afterReviewedFixCommit(context),
              }),
            ],
          },
        ],
        onError: captainError,
      },
    },

    reviewCodeChanges: {
      id: 'reviewCodeChanges',
      description: 'Reviews uncommitted code changes before they are committed.',
      invoke: {
        src: 'Captain',
        input: (): CaptainInput => ({
          role: 'Reviewer',
          sourceItems: ['CODE-5', 'CODE-7'],
          prompt: [
            'Review the latest unstaged/untracked changes.',
            'Understand the intent.',
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly - don't just approve or reject.",
            "If the change is ready to commit or push, don't raise nitpicks.",
            'Consult @specs/map.md to find relevant context if needed.',
          ].join('\n'),
          result: {
            noFindings: 'The uncommitted changes are ready to commit.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          {
            guard: outputGuardIs('noFindings'),
            target: '#commitChanges',
            actions: [rememberCaptainOutput, setCodeReviewContext],
          },
          {
            guard: outputGuardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, setCodeReviewContext],
          },
        ],
        onError: captainError,
      },
    },

    respondToReview: {
      id: 'respondToReview',
      description: 'Asks Coder to accept or challenge review findings with evidence.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-8'],
          prompt: prompt(context, [
            'For each review item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
            'Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.',
          ]),
          result: {
            changesMade: 'Coder accepted one or more items and made unstaged/untracked edits.',
            challengesRaised: 'Coder challenged one or more review items.',
            readyToCommit: 'Coder accepted the review outcome and the change is ready to commit.',
          },
        }),
        onDone: [
          { guard: changesMadeFor('specs'), target: '#reviewSpecChanges', actions: rememberCaptainOutput },
          { guard: changesMadeFor('changes'), target: '#reviewCodeChanges', actions: rememberCaptainOutput },
          { guard: changesMadeFor('commit'), target: '#reviewCodeChanges', actions: rememberCaptainOutput },
          { guard: outputGuardIs('challengesRaised'), target: '#adjudicateChallenges', actions: rememberCaptainOutput },
          { guard: outputGuardIs('readyToCommit'), target: '#commitChanges', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    adjudicateChallenges: {
      id: 'adjudicateChallenges',
      description: 'Returns Coder challenges to Reviewer and routes any remaining work back into review.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Reviewer',
          sourceItems: ['CODE-9'],
          prompt: prompt(context, [
            'For each feedback item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
            'Then review the latest unstaged/untracked changes (if any).',
          ]),
          result: {
            challengeAccepted: 'Reviewer accepted the challenge and no further review edits are required.',
            challengeRejected: 'Reviewer rejected the challenge and Coder must respond.',
            changesNeedReview: 'There are unstaged/untracked changes that need another review pass.',
            noOpenItems: 'No review items remain open.',
          },
        }),
        onDone: [
          { guard: challengesNeedReviewFor('specs'), target: '#reviewSpecChanges', actions: rememberCaptainOutput },
          { guard: challengesNeedReviewFor('changes'), target: '#reviewCodeChanges', actions: rememberCaptainOutput },
          { guard: challengesNeedReviewFor('commit'), target: '#reviewCodeChanges', actions: rememberCaptainOutput },
          { guard: outputGuardIs('challengeRejected'), target: '#respondToReview', actions: rememberCaptainOutput },
          { guard: outputGuardIs('challengeAccepted'), target: '#commitChanges', actions: rememberCaptainOutput },
          { guard: outputGuardIs('noOpenItems'), target: '#commitChanges', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    commitChanges: {
      id: 'commitChanges',
      description: 'Commits relevant repository changes and advances without re-reviewing already reviewed edits.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-10', 'CODE-11'],
          prompt: prompt(context, [
            playerLine(context),
            'Finally, commit the relevant changes that belong in the repo, following @specs/items/dev/git.md format (reread if necessary).',
            'If relevant, mark progress in the IR.',
          ]),
          result: {
            committed: 'Relevant changes were committed.',
            noRelevantChanges: 'There are no relevant changes to commit.',
            needsBossInput: 'Committing requires additional Boss input.',
          },
        }),
        onDone: [
          { guard: committedAfter('implementIr'), target: '#implementIr', actions: rememberCaptainOutput },
          { guard: committedAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: committedAfter('pushMilestone'), target: '#pushMilestone', actions: rememberCaptainOutput },
          { guard: committedAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: committedAfter('done'), target: '#done', actions: rememberCaptainOutput },
          {
            guard: committedAfter('reviewCodeCommit'),
            target: '#reviewCodeCommit',
            actions: [
              rememberCaptainOutput,
              assign({
                reviewSubject: () => 'commit' as const,
                afterReview: () => 'done' as const,
              }),
            ],
          },
          { guard: noRelevantChangesAfter('implementIr'), target: '#implementIr', actions: rememberCaptainOutput },
          { guard: noRelevantChangesAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: noRelevantChangesAfter('pushMilestone'), target: '#pushMilestone', actions: rememberCaptainOutput },
          { guard: noRelevantChangesAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: outputGuardIs('noRelevantChanges'), target: '#done', actions: rememberCaptainOutput },
          { guard: outputGuardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    pushMilestone: {
      id: 'pushMilestone',
      description: 'Pushes a milestone if needed, checks CI, and routes failures to diagnosis or rerun.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-12'],
          prompt: prompt(context, [
            'Push the milestone if it has not already been pushed, then check the CI status.',
            'If you can confidently identify flakiness from the CI log, rerun any affected CI workflow instead.',
            'If CI is not green and the cause is not obviously flaky, report it for Reviewer.',
          ]),
          result: {
            ciPassed: 'Push completed and CI passed.',
            ciFailed: 'CI failed and Reviewer should inspect the failure log.',
            flakyRerunStarted: 'A flaky affected workflow was rerun.',
            pushedNoCi: 'Push completed and no CI result is available.',
          },
        }),
        onDone: [
          { guard: outputGuardIsWorkflow('ciPassed', 'iteration'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: outputGuardIs('ciPassed'), target: '#done', actions: rememberCaptainOutput },
          { guard: outputGuardIs('ciFailed'), target: '#reviewCiFailure', actions: rememberCaptainOutput },
          { guard: outputGuardIs('flakyRerunStarted'), target: '#pushMilestone', reenter: true, actions: rememberCaptainOutput },
          { guard: outputGuardIs('pushedNoCi'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    reviewCiFailure: {
      id: 'reviewCiFailure',
      description: 'Lets Reviewer classify the latest CI failure before Coder retries or reruns.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Reviewer',
          sourceItems: ['CODE-13'],
          prompt: prompt(context, ['Check the latest CI failure log if needed.']),
          result: {
            fixNeeded: 'The CI log identifies a non-flaky issue that Coder should fix.',
            flaky: 'The CI log indicates flakiness.',
            noAction: 'No reviewer action is needed.',
          },
        }),
        onDone: [
          { guard: outputGuardIs('fixNeeded'), target: '#fixCi', actions: rememberCaptainOutput },
          { guard: outputGuardIs('flaky'), target: '#rerunCi', actions: rememberCaptainOutput },
          { guard: outputGuardIsWorkflow('noAction', 'iteration'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: outputGuardIs('noAction'), target: '#done', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    rerunCi: {
      id: 'rerunCi',
      description: 'Reruns an affected flaky CI workflow without pushing or changing code.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-12'],
          prompt: prompt(context, [
            'Rerun the affected flaky CI workflow.',
            'Do not push and do not change code for this action.',
          ]),
          result: {
            flakyRerunStarted: 'A flaky affected workflow was rerun.',
            needsBossInput: 'Rerunning CI requires additional Boss input.',
          },
        }),
        onDone: [
          { guard: outputGuardIs('flakyRerunStarted'), target: '#pushMilestone', reenter: true, actions: rememberCaptainOutput },
          { guard: outputGuardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    fixCi: {
      id: 'fixCi',
      description: 'Fixes a diagnosed CI failure in a local commit without pushing.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-12'],
          prompt: prompt(context, [
            'Fix the diagnosed CI failure in another commit.',
            'Do not push after committing the fix.',
            'Locally verify the fix if possible.',
          ]),
          result: {
            fixCommittedNoPush: 'A CI fix was committed locally and intentionally not pushed.',
            needsBossInput: 'Fixing CI requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: outputGuardIs('fixCommittedNoPush'),
            target: '#reviewCodeCommit',
            actions: [
              rememberCaptainOutput,
              assign({
                reviewSubject: () => 'commit' as const,
                afterReview: ({ context }) => afterCiFixReview(context),
                afterCommit: ({ context }) => afterCiFixReview(context),
              }),
            ],
          },
          { guard: outputGuardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    summarizeSpecs: {
      id: 'summarizeSpecs',
      description: 'Drafts spec changes that make an iteration reimplementable without its IR.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Coder',
          sourceItems: ['CODE-14'],
          prompt: prompt(context, [
            `IR number: ${context.irNumber ?? '<#>'}`,
            '',
            `Read IR-${context.irNumber ?? '<#>'} and corresponding commits.`,
            'According to @specs/meta.md, add or update spec items to fully capture:',
            '',
            '- the user requirements in @specs/items/user,',
            '- the system behavior in @specs/items/dev, and',
            '- the integration/system test cases in @specs/items/test.',
            '',
            'The spec items should be the minimal set needed to reimplement code without the IR.',
            'The set should be complete and coherent.',
            'Avoid implementation specifics.',
            'Avoid redundant spec items.',
            'Consult @specs/map.md for relevant context and update it to reflect your changes.',
          ]),
          result: {
            specsReadyForReview: 'Spec updates are drafted and ready for review.',
            noSpecChangesNeeded: 'The existing specs already capture the iteration.',
            needsBossInput: 'Spec summarization requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: outputGuardIs('specsReadyForReview'),
            target: '#reviewSpecChanges',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'specSummary' as const,
                reviewSubject: () => 'specs' as const,
                afterCommit: () => 'done' as const,
              }),
            ],
          },
          { guard: outputGuardIs('noSpecChangesNeeded'), target: '#done', actions: rememberCaptainOutput },
          { guard: outputGuardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    reviewSpecChanges: {
      id: 'reviewSpecChanges',
      description: 'Reviews spec changes for completeness, level, minimality, and map consistency.',
      invoke: {
        src: 'Captain',
        input: ({ context }): CaptainInput => ({
          role: 'Reviewer',
          sourceItems: ['CODE-15'],
          prompt: prompt(context, [
            `IR number: ${context.irNumber ?? '<#>'}`,
            '',
            `Review the unstaged/untracked changes. Verify the spec items for IR-${context.irNumber ?? '<#>'} are:`,
            '',
            '- Complete & coherent: sufficient for you to reimplement code without the IR.',
            '- Right level: user requirements (in @specs/items/user) or behavior (in @specs/items/dev), not implementation specifics; integration/system testing (in @specs/items/test), not unit testing.',
            '- Minimal: essential and concise; every item earns its place; also check with other items.',
            '',
            'Flag anything missing, redundant, over-specified, or under-specified.',
            'Consult @specs/map.md for relevant context and verify it reflects the changes.',
          ]),
          result: {
            noFindings: 'The spec changes are reviewed and ready to commit.',
            hasFindings: 'The spec review produced findings for Coder.',
          },
        }),
        onDone: [
          {
            guard: outputGuardIs('noFindings'),
            target: '#commitChanges',
            actions: [
              rememberCaptainOutput,
              assign({
                reviewSubject: () => 'specs' as const,
                afterCommit: () => 'done' as const,
              }),
            ],
          },
          {
            guard: outputGuardIs('hasFindings'),
            target: '#respondToReview',
            actions: [
              rememberCaptainOutput,
              assign({
                reviewSubject: () => 'specs' as const,
                afterCommit: () => 'done' as const,
              }),
            ],
          },
        ],
        onError: captainError,
      },
    },

    failed: {
      id: 'failed',
      description: 'Preserves the last Captain error or unresolved failure so the runner can report it distinctly.',
      on: readyEvents,
    },

    done: {
      id: 'done',
      description: 'The selected coding workflow has completed.',
      type: 'final',
    },
  },
});
