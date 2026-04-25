// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { assign, createMachine } from 'xstate';

type Role = 'Coder' | 'Reviewer';

type StateId =
  | 'ready'
  | 'planAndImplement'
  | 'implementIr'
  | 'continueIr'
  | 'reviewCodeCommit'
  | 'reviewCodeChanges'
  | 'respondToCodeReview'
  | 'adjudicateChallenges'
  | 'commitChanges'
  | 'pushMilestone'
  | 'reviewCiFailure'
  | 'summarizeSpecs'
  | 'reviewSpecChanges';

type CaptainGuard =
  | 'singleCommitCommitted'
  | 'iterationCommitted'
  | 'taskCommitted'
  | 'changesReadyForReview'
  | 'iterationDone'
  | 'noFindings'
  | 'hasFindings'
  | 'changesMade'
  | 'challengesRaised'
  | 'readyToCommit'
  | 'challengeAccepted'
  | 'challengeRejected'
  | 'changesNeedReview'
  | 'noOpenItems'
  | 'committed'
  | 'noRelevantChanges'
  | 'ciPassed'
  | 'ciFailed'
  | 'flakyRerunStarted'
  | 'fixCommittedNoPush'
  | 'pushedNoCi'
  | 'fixNeeded'
  | 'flaky'
  | 'noAction'
  | 'specsCommitted'
  | 'noSpecChangesNeeded'
  | 'needsBossInput';

type CaptainOutput = {
  guard: CaptainGuard;
  summary?: string;
  irNumber?: string;
  reviews?: string;
  challenges?: string;
  [key: string]: unknown;
};

type CaptainInput = {
  role: Role;
  sourceItems: string[];
  prompt: string;
  result: Partial<Record<CaptainGuard, string>>;
};

type CodingContext = {
  intent?: string;
  irNumber?: string;
  players?: string;
  reviews?: string;
  challenges?: string;
  lastResult?: CaptainOutput;
  lastError?: unknown;
};

type CodingEvent =
  | { type: 'START_CODING'; intent: string; players?: string }
  | { type: 'IMPLEMENT_IR'; irNumber: string; players?: string }
  | { type: 'CONTINUE_IR'; irNumber: string; players?: string }
  | { type: 'REVIEW_COMMIT'; players?: string }
  | { type: 'REVIEW_CHANGES'; players?: string }
  | { type: 'RESPOND_TO_REVIEW'; reviews?: string; players?: string }
  | { type: 'COMMIT_CHANGES'; players?: string }
  | { type: 'PUSH_MILESTONE'; irNumber?: string; players?: string }
  | { type: 'REVIEW_CI_FAILURE'; players?: string }
  | { type: 'SUMMARIZE_IR'; irNumber: string; players?: string }
  | { type: 'REVIEW_SPECS'; irNumber?: string; players?: string }
  | { type: 'BOSS_INTERRUPT'; targetId: StateId; intent?: string; irNumber?: string; players?: string };

const outputOf = (event: unknown): CaptainOutput | undefined =>
  (event as { output?: CaptainOutput }).output;

const is = (guard: CaptainGuard) => ({ event }: { event: unknown }) =>
  outputOf(event)?.guard === guard;

const isWithIr = (guard: CaptainGuard) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    Boolean(context.irNumber) && outputOf(event)?.guard === guard;

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
  reviews: ({ context, event }) => (event as { reviews?: string }).reviews ?? context.reviews,
});

const prompt = (context: CodingContext, lines: string[]) =>
  [
    ...lines,
    context.lastResult ? '' : undefined,
    context.lastResult ? `Previous result:\n${JSON.stringify(context.lastResult, null, 2)}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');

const captainError = {
  target: '#ready',
  actions: rememberCaptainError,
};

export const codingMachine = createMachine(
  {
    id: 'coding',
    types: {} as {
      context: CodingContext;
      events: CodingEvent;
      input: Partial<CodingContext> | undefined;
      actors: {
        src: 'Captain';
        input: CaptainInput;
        output: CaptainOutput;
      };
    },
    context: ({ input }) => ({
      intent: input?.intent,
      irNumber: input?.irNumber,
      players: input?.players,
    }),
    initial: 'ready',
    on: {
      START_CODING: { target: '#planAndImplement', actions: rememberBossInput },
      IMPLEMENT_IR: { target: '#implementIr', actions: rememberBossInput },
      CONTINUE_IR: { target: '#continueIr', actions: rememberBossInput },
      REVIEW_COMMIT: { target: '#reviewCodeCommit', actions: rememberBossInput },
      REVIEW_CHANGES: { target: '#reviewCodeChanges', actions: rememberBossInput },
      RESPOND_TO_REVIEW: { target: '#respondToCodeReview', actions: rememberBossInput },
      COMMIT_CHANGES: { target: '#commitChanges', actions: rememberBossInput },
      PUSH_MILESTONE: { target: '#pushMilestone', actions: rememberBossInput },
      REVIEW_CI_FAILURE: { target: '#reviewCiFailure', actions: rememberBossInput },
      SUMMARIZE_IR: { target: '#summarizeSpecs', actions: rememberBossInput },
      REVIEW_SPECS: { target: '#reviewSpecChanges', actions: rememberBossInput },
      BOSS_INTERRUPT: [
        { guard: ({ event }) => event.targetId === 'ready', target: '#ready', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'planAndImplement', target: '#planAndImplement', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'implementIr', target: '#implementIr', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'continueIr', target: '#continueIr', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'reviewCodeCommit', target: '#reviewCodeCommit', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'reviewCodeChanges', target: '#reviewCodeChanges', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'respondToCodeReview', target: '#respondToCodeReview', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'adjudicateChallenges', target: '#adjudicateChallenges', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'commitChanges', target: '#commitChanges', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'pushMilestone', target: '#pushMilestone', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'reviewCiFailure', target: '#reviewCiFailure', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'summarizeSpecs', target: '#summarizeSpecs', reenter: true, actions: rememberBossInput },
        { guard: ({ event }) => event.targetId === 'reviewSpecChanges', target: '#reviewSpecChanges', reenter: true, actions: rememberBossInput },
      ],
    },
    states: {
      ready: {
        id: 'ready',
        description: 'Waits for Boss or runtime events that identify the next coding workflow obligation.',
      },

      planAndImplement: {
        id: 'planAndImplement',
        description: 'Converts a Boss coding intent into either one reviewed commit path or a reviewed iteration path.',
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
            { guard: is('singleCommitCommitted'), target: '#reviewCodeCommit', actions: rememberCaptainOutput },
            { guard: is('iterationCommitted'), target: '#reviewCodeCommit', actions: rememberCaptainOutput },
            { guard: is('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      implementIr: {
        id: 'implementIr',
        description: 'Starts implementation for a drafted and reviewed iteration.',
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
            { guard: is('taskCommitted'), target: '#reviewCodeCommit', actions: rememberCaptainOutput },
            { guard: is('changesReadyForReview'), target: '#reviewCodeChanges', actions: rememberCaptainOutput },
            { guard: is('iterationDone'), target: '#pushMilestone', actions: rememberCaptainOutput },
            { guard: is('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      continueIr: {
        id: 'continueIr',
        description: 'Continues an iteration after a task commit has passed review.',
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
            { guard: is('taskCommitted'), target: '#reviewCodeCommit', actions: rememberCaptainOutput },
            { guard: is('changesReadyForReview'), target: '#reviewCodeChanges', actions: rememberCaptainOutput },
            { guard: is('iterationDone'), target: '#pushMilestone', actions: rememberCaptainOutput },
            { guard: is('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      reviewCodeCommit: {
        id: 'reviewCodeCommit',
        description: 'Reviews the latest unreviewed code commit.',
        invoke: {
          src: 'Captain',
          input: (): CaptainInput => ({
            role: 'Reviewer',
            sourceItems: ['CODE-5', 'CODE-6'],
            prompt: [
              'Flag any issues or improvements (numbered; no duplication).',
              "Think thoroughly - don't just approve or reject.",
              "If the change is ready to commit or push, don't raise nitpicks.",
              'Consult @specs/map.md to find relevant context if needed.',
              'Review the latest commit.',
            ].join('\n'),
            result: {
              noFindings: 'The latest commit has no review findings.',
              hasFindings: 'The review produced findings for Coder.',
            },
          }),
          onDone: [
            { guard: is('noFindings'), target: '#ready', actions: rememberCaptainOutput },
            { guard: is('hasFindings'), target: '#respondToCodeReview', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      reviewCodeChanges: {
        id: 'reviewCodeChanges',
        description: 'Reviews uncommitted code changes before commit.',
        invoke: {
          src: 'Captain',
          input: (): CaptainInput => ({
            role: 'Reviewer',
            sourceItems: ['CODE-5', 'CODE-7'],
            prompt: [
              'Flag any issues or improvements (numbered; no duplication).',
              "Think thoroughly - don't just approve or reject.",
              "If the change is ready to commit or push, don't raise nitpicks.",
              'Consult @specs/map.md to find relevant context if needed.',
              'Review the latest unstaged/untracked changes.',
              'Understand the intent.',
            ].join('\n'),
            result: {
              noFindings: 'The uncommitted changes are ready to commit.',
              hasFindings: 'The review produced findings for Coder.',
            },
          }),
          onDone: [
            { guard: is('noFindings'), target: '#commitChanges', actions: rememberCaptainOutput },
            { guard: is('hasFindings'), target: '#respondToCodeReview', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      respondToCodeReview: {
        id: 'respondToCodeReview',
        description: 'Asks Coder to accept or challenge each review item with evidence, leaving Coder edits unstaged.',
        invoke: {
          src: 'Captain',
          input: ({ context }): CaptainInput => ({
            role: 'Coder',
            sourceItems: ['CODE-8'],
            prompt: prompt(context, [
              `Review items: ${context.reviews ?? '(from previous Reviewer result)'}`,
              '',
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
            { guard: is('changesMade'), target: '#reviewCodeChanges', actions: rememberCaptainOutput },
            { guard: is('challengesRaised'), target: '#adjudicateChallenges', actions: rememberCaptainOutput },
            { guard: is('readyToCommit'), target: '#commitChanges', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      adjudicateChallenges: {
        id: 'adjudicateChallenges',
        description: 'Returns Coder challenges to Reviewer, then reviews any new uncommitted changes.',
        invoke: {
          src: 'Captain',
          input: ({ context }): CaptainInput => ({
            role: 'Reviewer',
            sourceItems: ['CODE-9'],
            prompt: prompt(context, [
              `Coder challenges: ${context.challenges ?? '(from previous Coder result)'}`,
              '',
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
            { guard: is('challengeAccepted'), target: '#commitChanges', actions: rememberCaptainOutput },
            { guard: is('challengeRejected'), target: '#respondToCodeReview', actions: rememberCaptainOutput },
            { guard: is('changesNeedReview'), target: '#reviewCodeChanges', actions: rememberCaptainOutput },
            { guard: is('noOpenItems'), target: '#commitChanges', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      commitChanges: {
        id: 'commitChanges',
        description: 'Commits relevant repository changes with the configured player descriptions and git-message format.',
        invoke: {
          src: 'Captain',
          input: ({ context }): CaptainInput => ({
            role: 'Coder',
            sourceItems: ['CODE-10', 'CODE-11'],
            prompt: prompt(context, [
              context.players ?? 'Use the current player descriptions for Coder, Reviewer, and any other contributors.',
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
            { guard: is('committed'), target: '#reviewCodeCommit', actions: rememberCaptainOutput },
            { guard: is('noRelevantChanges'), target: '#ready', actions: rememberCaptainOutput },
            { guard: is('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      pushMilestone: {
        id: 'pushMilestone',
        description: 'Pushes at a milestone or iteration end, checks CI, and handles failures without a second push.',
        invoke: {
          src: 'Captain',
          input: ({ context }): CaptainInput => ({
            role: 'Coder',
            sourceItems: ['CODE-12'],
            prompt: prompt(context, [
              'Push and check the CI status and, if any failure, fix it in another commit (no further push), with local verification if possible.',
              'If the CI log indicates flakiness, rerun any affected CI workflow instead.',
            ]),
            result: {
              ciPassed: 'Push completed and CI passed.',
              ciFailed: 'CI failed and Reviewer should inspect the failure log.',
              flakyRerunStarted: 'A flaky affected workflow was rerun.',
              fixCommittedNoPush: 'A CI fix was committed locally and intentionally not pushed yet.',
              pushedNoCi: 'Push completed and no CI result is available.',
            },
          }),
          onDone: [
            { guard: isWithIr('ciPassed'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
            { guard: is('ciPassed'), target: '#ready', actions: rememberCaptainOutput },
            { guard: is('ciFailed'), target: '#reviewCiFailure', actions: rememberCaptainOutput },
            { guard: is('flakyRerunStarted'), target: '#pushMilestone', reenter: true, actions: rememberCaptainOutput },
            { guard: is('fixCommittedNoPush'), target: '#reviewCodeCommit', actions: rememberCaptainOutput },
            { guard: is('pushedNoCi'), target: '#ready', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      reviewCiFailure: {
        id: 'reviewCiFailure',
        description: 'Lets Reviewer inspect CI failure details when a pushed milestone has not passed.',
        invoke: {
          src: 'Captain',
          input: (): CaptainInput => ({
            role: 'Reviewer',
            sourceItems: ['CODE-13'],
            prompt: 'Check the latest CI failure log if needed.',
            result: {
              fixNeeded: 'The CI log identifies a non-flaky issue that needs a fix.',
              flaky: 'The CI log indicates flakiness.',
              noAction: 'No reviewer action is needed.',
            },
          }),
          onDone: [
            { guard: is('fixNeeded'), target: '#ready', actions: rememberCaptainOutput },
            { guard: is('flaky'), target: '#pushMilestone', actions: rememberCaptainOutput },
            { guard: is('noAction'), target: '#ready', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },

      summarizeSpecs: {
        id: 'summarizeSpecs',
        description: 'After an iteration is done and pushed, updates specs so the IR is no longer needed for reimplementation.',
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
              specsCommitted: 'Spec updates were committed.',
              noSpecChangesNeeded: 'The existing specs already capture the iteration.',
              needsBossInput: 'Spec summarization requires additional Boss input.',
            },
          }),
          onDone: [
            { guard: is('specsCommitted'), target: '#reviewSpecChanges', actions: rememberCaptainOutput },
            { guard: is('noSpecChangesNeeded'), target: '#ready', actions: rememberCaptainOutput },
            { guard: is('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
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
              noFindings: 'The spec changes are reviewed and complete.',
              hasFindings: 'The spec review produced findings that Coder should fold back into summarization.',
            },
          }),
          onDone: [
            { guard: is('noFindings'), target: '#ready', actions: rememberCaptainOutput },
            { guard: is('hasFindings'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          ],
          onError: captainError,
        },
      },
    },
  },
);
