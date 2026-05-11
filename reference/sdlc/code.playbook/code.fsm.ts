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

type Player = 'Coder' | 'Reviewer' | 'Committer';

type JumpableStateId =
  | 'ready'
  | 'planAndImplement'
  | 'respondToReview'
  | 'continueIr'
  | 'summarizeSpecs'
  | 'reviewBossCommitSpecs'
  | 'reviewBossCommitCode'
  | 'reviewBossCommitMixed'
  | 'reviewIrTaskCommitSpecs'
  | 'reviewIrTaskCommitCode'
  | 'reviewIrTaskCommitMixed'
  | 'reviewChangesSpecs'
  | 'reviewChangesCode'
  | 'reviewChangesMixed'
  | 'adjudicateChallenges'
  | 'commitCoderInitial'
  | 'commitReviewerCleared'
  | 'commitJoint'
  | 'failed';

type WorkflowKind = 'singleCommit' | 'iteration' | 'specSummary';
type FileScope = 'specs' | 'code' | 'mixed';
type ChangeOrigin = 'bossIntent' | 'irTask';
type ReviewSubject = 'commit' | 'changes';
type AfterReview = 'continueIr' | 'summarizeSpecs' | 'done';

export type CaptainInput = {
  player: Player;
  sourceItem: string;
  prompt: string;
  result: Record<string, string>;
};

export type CaptainOutput = {
  guard: string;
  fileScope?: FileScope;
  irNumber?: string;
  reviews?: string;
  challenges?: string;
  summary?: string;
  [k: string]: unknown;
};

export type CodingInput = {
  intent?: string;
  irNumber?: string;
  coderPlayer?: string;
  reviewerPlayer?: string;
  committerPlayer?: string;
};

export type CodingContext = CodingInput & {
  workflow?: WorkflowKind;
  changeOrigin?: ChangeOrigin;
  fileScope?: FileScope;
  reviewSubject?: ReviewSubject;
  afterReview?: AfterReview;
  reviews?: string;
  challenges?: string;
  lastResult?: CaptainOutput;
  lastError?: unknown;
};

export type CodingEvent =
  | { type: 'START_CODING'; intent: string }
  | { type: 'CONTINUE_IR'; irNumber: string }
  | { type: 'SUMMARIZE_IR'; irNumber: string }
  | {
      type: 'BOSS_INTERRUPT';
      targetId: JumpableStateId;
      intent?: string;
      irNumber?: string;
    };

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
  'adjudicateChallenges',
  'commitCoderInitial',
  'commitReviewerCleared',
  'commitJoint',
  'failed',
] as const satisfies readonly JumpableStateId[];

const outputOf = (event: unknown): CaptainOutput | undefined =>
  (event as { output?: CaptainOutput }).output;

const guardIs = (guard: string) =>
  ({ event }: { event: unknown }) => outputOf(event)?.guard === guard;

const committedTo = (origin: ChangeOrigin, scope: FileScope) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.guard === 'committed' &&
    context.changeOrigin === origin &&
    outputOf(event)?.fileScope === scope;

const changesMadeWithScope = (scope: FileScope) =>
  ({ event }: { event: unknown }) =>
    outputOf(event)?.guard === 'changesMade' && outputOf(event)?.fileScope === scope;

const acceptedAfter = (subject: ReviewSubject) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.guard === 'accepted' && context.reviewSubject === subject;

const noFindingsAfter = (afterReview: AfterReview) =>
  ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.guard === 'noFindings' && context.afterReview === afterReview;

const rememberCaptainOutput = assign({
  lastResult: ({ event }: { event: unknown }) => outputOf(event),
  lastError: () => undefined,
  irNumber: ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.irNumber ?? context.irNumber,
  fileScope: ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.fileScope ?? context.fileScope,
  reviews: ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.reviews ?? context.reviews,
  challenges: ({ context, event }: { context: CodingContext; event: unknown }) =>
    outputOf(event)?.challenges ?? context.challenges,
});

const rememberCaptainError = assign({
  lastError: ({ event }: { event: unknown }) => (event as { error?: unknown }).error,
});

const rememberBossInput = assign({
  intent: ({ context, event }: { context: CodingContext; event: unknown }) =>
    (event as { intent?: string }).intent ?? context.intent,
  irNumber: ({ context, event }: { context: CodingContext; event: unknown }) =>
    (event as { irNumber?: string }).irNumber ?? context.irNumber,
});

const bossInterrupts = (ids: readonly JumpableStateId[]) =>
  ids.map((id) => ({
    target: `#${id}` as const,
    guard: ({ event }: { event: CodingEvent }) =>
      event.type === 'BOSS_INTERRUPT' && event.targetId === id,
    reenter: true,
    actions: rememberBossInput,
  }));

const captainError = {
  target: '#failed',
  actions: rememberCaptainError,
};

const irNum = (context: CodingContext) => context.irNumber ?? '<#>';
const coderLlm = (context: CodingContext) => context.coderPlayer ?? '<coder-llm>';
const reviewerLlm = (context: CodingContext) => context.reviewerPlayer ?? '<reviewer-llm>';

const readyEvents = {
  START_CODING: {
    target: '#planAndImplement',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'singleCommit' as const,
        changeOrigin: () => 'bossIntent' as const,
        afterReview: () => 'done' as const,
      }),
    ],
  },
  CONTINUE_IR: {
    target: '#continueIr',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'iteration' as const,
        changeOrigin: () => 'irTask' as const,
        afterReview: () => 'continueIr' as const,
      }),
    ],
  },
  SUMMARIZE_IR: {
    target: '#summarizeSpecs',
    actions: [
      rememberBossInput,
      assign({
        workflow: () => 'specSummary' as const,
        changeOrigin: () => 'irTask' as const,
        afterReview: () => 'done' as const,
      }),
    ],
  },
};

const captainPlaceholder = fromPromise<CaptainOutput, CaptainInput>(async () => {
  throw new Error('captain actor must be provided by the runner');
});

export const codingMachine = setup({
  types: {} as {
    context: CodingContext;
    events: CodingEvent;
    input: CodingInput | undefined;
  },
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

    planAndImplement: {
      id: 'planAndImplement',
      description:
        'CODE-1: Coder assesses a Boss intent and either implements a single-commit change or drafts an IR.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Coder',
          sourceItem: 'CODE-1',
          prompt: [
            'Assess whether this can be completed in a single commit, following best practices.',
            'If yes, implement and test, updating both code and specs; otherwise, decompose into tasks as a new IR under @specs/iterations.',
            'Consult @specs/map.md for relevant context if needed; ensure it reflects the changes.',
            'Do not commit.',
          ].join('\n'),
          result: {
            singleCommitReady:
              'Coder produced uncommitted single-commit changes (Initial Changes).',
            irDrafted:
              'Coder decomposed the intent into a new IR and drafted it uncommitted (Initial Changes).',
            needsBossInput: 'Progress requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: guardIs('singleCommitReady'),
            target: '#commitCoderInitial',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'singleCommit' as const,
                changeOrigin: () => 'bossIntent' as const,
                afterReview: () => 'done' as const,
              }),
            ],
          },
          {
            guard: guardIs('irDrafted'),
            target: '#commitCoderInitial',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                changeOrigin: () => 'bossIntent' as const,
                afterReview: () => 'continueIr' as const,
              }),
            ],
          },
          { guard: guardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    respondToReview: {
      id: 'respondToReview',
      description: 'CODE-2: Coder addresses or challenges Reviewer findings.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Coder',
          sourceItem: 'CODE-2',
          prompt: [
            'For each review item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
            'Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.',
          ].join('\n'),
          result: {
            changesMade:
              'Coder accepted one or more items and produced unstaged/untracked edits.',
            challengesRaised: 'Coder challenged one or more review items.',
            accepted:
              'Coder accepted the review outcome without further edits.',
          },
        }),
        onDone: [
          {
            guard: changesMadeWithScope('specs'),
            target: '#reviewChangesSpecs',
            actions: rememberCaptainOutput,
          },
          {
            guard: changesMadeWithScope('code'),
            target: '#reviewChangesCode',
            actions: rememberCaptainOutput,
          },
          {
            guard: changesMadeWithScope('mixed'),
            target: '#reviewChangesMixed',
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
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'accepted' &&
              context.reviewSubject === 'commit' &&
              context.afterReview === 'continueIr',
            target: '#continueIr',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'accepted' &&
              context.reviewSubject === 'commit' &&
              context.afterReview === 'summarizeSpecs',
            target: '#summarizeSpecs',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'accepted' &&
              context.reviewSubject === 'commit' &&
              context.afterReview === 'done',
            target: '#done',
            actions: rememberCaptainOutput,
          },
        ],
        onError: captainError,
      },
    },

    continueIr: {
      id: 'continueIr',
      description:
        'CODE-3: Coder continues an IR after the previous task or IR draft passed review.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Coder',
          sourceItem: 'CODE-3',
          prompt: [
            `Continue to implement IR-${irNum(context)} if not all deliverables and tasks are done.`,
            'Implement one task at a time (including corresponding tests if any).',
            'Stop after each task for review — do not commit yet.',
            'If relevant, mark progress in the IR.',
          ].join('\n'),
          result: {
            taskReady: 'Coder produced uncommitted changes for the next IR task (Initial Changes).',
            iterationDone: 'All IR deliverables and tasks are done.',
            needsBossInput: 'Progress requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: guardIs('taskReady'),
            target: '#commitCoderInitial',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'iteration' as const,
                changeOrigin: () => 'irTask' as const,
                afterReview: () => 'continueIr' as const,
              }),
            ],
          },
          {
            guard: guardIs('iterationDone'),
            target: '#summarizeSpecs',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'specSummary' as const,
                afterReview: () => 'done' as const,
              }),
            ],
          },
          { guard: guardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    summarizeSpecs: {
      id: 'summarizeSpecs',
      description: 'CODE-4: Coder summarizes a completed IR into minimal spec items.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Coder',
          sourceItem: 'CODE-4',
          prompt: [
            `Read IR-${irNum(context)} and corresponding commits.`,
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
            'Consult @specs/map.md for relevant context and update it to reflect your changes.',
          ].join('\n'),
          result: {
            specsReady: 'Coder produced uncommitted spec updates (Initial Changes).',
            noSpecChanges: 'Existing specs already capture the iteration.',
            needsBossInput: 'Spec summarization requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: guardIs('specsReady'),
            target: '#commitCoderInitial',
            actions: [
              rememberCaptainOutput,
              assign({
                workflow: () => 'specSummary' as const,
                changeOrigin: () => 'irTask' as const,
                fileScope: () => 'specs' as const,
                afterReview: () => 'done' as const,
              }),
            ],
          },
          { guard: guardIs('noSpecChanges'), target: '#done', actions: rememberCaptainOutput },
          { guard: guardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    reviewBossCommitSpecs: {
      id: 'reviewBossCommitSpecs',
      description:
        'CODE-5: Reviewer reviews a Boss-intent commit whose changes are only in @specs/{user,dev,test}/.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-5',
          prompt: [
            'Review the latest commit.',
            'Refer to the commit message.',
            'Verify any affected spec items are:',
            '',
            '- Complete & coherent: sufficient for you to reimplement code.',
            '- Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
            '- Minimal: essential and concise; every item earns its place; also check with other items.',
            '',
            'Flag anything missing, redundant, over-specified, or under-specified.',
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The spec-only commit has no review findings.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' as const })],
          },
        ],
        onError: captainError,
      },
    },

    reviewBossCommitCode: {
      id: 'reviewBossCommitCode',
      description:
        'CODE-6: Reviewer reviews a Boss-intent commit whose changes are only outside @specs/{user,dev,test}/.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-6',
          prompt: [
            'Review the latest commit.',
            'Refer to the commit message.',
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly — don't just approve or reject.",
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The code-only commit has no review findings.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' as const })],
          },
        ],
        onError: captainError,
      },
    },

    reviewBossCommitMixed: {
      id: 'reviewBossCommitMixed',
      description:
        'CODE-7: Reviewer reviews a Boss-intent commit whose changes span both @specs/{user,dev,test}/ and other files.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-7',
          prompt: [
            'Review the latest commit.',
            'Refer to the commit message.',
            'Verify any affected spec items are:',
            '',
            '- Complete & coherent: sufficient for you to reimplement code.',
            '- Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
            '- Minimal: essential and concise; every item earns its place; also check with other items.',
            '',
            'Flag anything missing, redundant, over-specified, or under-specified.',
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly — don't just approve or reject.",
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The mixed commit has no review findings.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' as const })],
          },
        ],
        onError: captainError,
      },
    },

    reviewIrTaskCommitSpecs: {
      id: 'reviewIrTaskCommitSpecs',
      description:
        'CODE-8: Reviewer reviews an IR-task commit whose changes are only in @specs/{user,dev,test}/.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-8',
          prompt: [
            'Review the latest commit.',
            'Refer to the commit message.',
            'Verify any affected spec items are:',
            '',
            '- Complete & coherent: sufficient for you to reimplement code.',
            '- Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
            '- Minimal: essential and concise; every item earns its place; also check with other items.',
            '',
            'Flag anything missing, redundant, over-specified, or under-specified.',
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The IR-task spec-only commit has no review findings.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' as const })],
          },
        ],
        onError: captainError,
      },
    },

    reviewIrTaskCommitCode: {
      id: 'reviewIrTaskCommitCode',
      description:
        'CODE-9: Reviewer reviews an IR-task commit whose changes are only outside @specs/{user,dev,test}/.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-9',
          prompt: [
            'Review the latest commit.',
            'Refer to the commit message.',
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly — don't just approve or reject.",
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The IR-task code-only commit has no review findings.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' as const })],
          },
        ],
        onError: captainError,
      },
    },

    reviewIrTaskCommitMixed: {
      id: 'reviewIrTaskCommitMixed',
      description:
        'CODE-10: Reviewer reviews an IR-task commit whose changes span both @specs/{user,dev,test}/ and other files.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-10',
          prompt: [
            'Review the latest commit.',
            'Refer to the commit message.',
            'Verify any affected spec items are:',
            '',
            '- Complete & coherent: sufficient for you to reimplement code.',
            '- Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
            '- Minimal: essential and concise; every item earns its place; also check with other items.',
            '',
            'Flag anything missing, redundant, over-specified, or under-specified.',
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly — don't just approve or reject.",
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The IR-task mixed commit has no review findings.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          { guard: noFindingsAfter('continueIr'), target: '#continueIr', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('summarizeSpecs'), target: '#summarizeSpecs', actions: rememberCaptainOutput },
          { guard: noFindingsAfter('done'), target: '#done', actions: rememberCaptainOutput },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'commit' as const })],
          },
        ],
        onError: captainError,
      },
    },

    reviewChangesSpecs: {
      id: 'reviewChangesSpecs',
      description:
        'CODE-11: Reviewer reviews uncommitted Coder changes that touch only @specs/{user,dev,test}/.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-11',
          prompt: [
            'Review the unstaged/untracked changes.',
            'Understand the intent.',
            'Verify any affected spec items are:',
            '',
            '- Complete & coherent: sufficient for you to reimplement code.',
            '- Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
            '- Minimal: essential and concise; every item earns its place; also check with other items.',
            '',
            'Flag anything missing, redundant, over-specified, or under-specified.',
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The uncommitted spec-only changes are ready to commit.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          {
            guard: guardIs('noFindings'),
            target: '#commitReviewerCleared',
            actions: rememberCaptainOutput,
          },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' as const })],
          },
        ],
        onError: captainError,
      },
    },

    reviewChangesCode: {
      id: 'reviewChangesCode',
      description:
        'CODE-12: Reviewer reviews uncommitted Coder changes that touch only files outside @specs/{user,dev,test}/.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-12',
          prompt: [
            'Review the unstaged/untracked changes.',
            'Understand the intent.',
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly — don't just approve or reject.",
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The uncommitted code-only changes are ready to commit.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          {
            guard: guardIs('noFindings'),
            target: '#commitReviewerCleared',
            actions: rememberCaptainOutput,
          },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' as const })],
          },
        ],
        onError: captainError,
      },
    },

    reviewChangesMixed: {
      id: 'reviewChangesMixed',
      description:
        'CODE-13: Reviewer reviews uncommitted Coder changes that touch both @specs/{user,dev,test}/ and other files.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-13',
          prompt: [
            'Review the unstaged/untracked changes.',
            'Understand the intent.',
            'Verify any affected spec items are:',
            '',
            '- Complete & coherent: sufficient for you to reimplement code.',
            '- Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
            '- Minimal: essential and concise; every item earns its place; also check with other items.',
            '',
            'Flag anything missing, redundant, over-specified, or under-specified.',
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly — don't just approve or reject.",
            'Consult @specs/map.md for relevant context if needed; verify it reflects the changes.',
            "If the change is ready to commit or push, don't raise nitpicks.",
          ].join('\n'),
          result: {
            noFindings: 'The uncommitted mixed changes are ready to commit.',
            hasFindings: 'The review produced findings for Coder.',
          },
        }),
        onDone: [
          {
            guard: guardIs('noFindings'),
            target: '#commitReviewerCleared',
            actions: rememberCaptainOutput,
          },
          {
            guard: guardIs('hasFindings'),
            target: '#respondToReview',
            actions: [rememberCaptainOutput, assign({ reviewSubject: () => 'changes' as const })],
          },
        ],
        onError: captainError,
      },
    },

    adjudicateChallenges: {
      id: 'adjudicateChallenges',
      description: 'CODE-14: Reviewer adjudicates Coder rebuttals against the prior review.',
      invoke: {
        src: 'captain',
        input: (): CaptainInput => ({
          player: 'Reviewer',
          sourceItem: 'CODE-14',
          prompt: [
            'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
          ].join('\n'),
          result: {
            challengeAccepted:
              'Reviewer accepted the rebuttal — no further review edits are required.',
            challengeRejected:
              'Reviewer rejected the rebuttal — Coder must respond again.',
            noOpenItems: 'No review items remain open.',
          },
        }),
        onDone: [
          {
            guard: ({ context, event }) =>
              (outputOf(event)?.guard === 'challengeAccepted' ||
                outputOf(event)?.guard === 'noOpenItems') &&
              context.reviewSubject === 'changes',
            target: '#commitJoint',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              (outputOf(event)?.guard === 'challengeAccepted' ||
                outputOf(event)?.guard === 'noOpenItems') &&
              context.reviewSubject === 'commit' &&
              context.afterReview === 'continueIr',
            target: '#continueIr',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              (outputOf(event)?.guard === 'challengeAccepted' ||
                outputOf(event)?.guard === 'noOpenItems') &&
              context.reviewSubject === 'commit' &&
              context.afterReview === 'summarizeSpecs',
            target: '#summarizeSpecs',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              (outputOf(event)?.guard === 'challengeAccepted' ||
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
        ],
        onError: captainError,
      },
    },

    commitCoderInitial: {
      id: 'commitCoderInitial',
      description:
        'CODE-15: Committer commits Coder Initial Changes when Reviewer has not played since the last commit.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Committer',
          sourceItem: 'CODE-15',
          prompt: [
            'Commit the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).',
            `Coder is ${coderLlm(context)}.`,
          ].join('\n'),
          result: {
            committed: 'Relevant changes were committed.',
            noRelevantChanges: 'There are no relevant changes to commit.',
            needsBossInput: 'Committing requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: committedTo('bossIntent', 'specs'),
            target: '#reviewBossCommitSpecs',
            actions: rememberCaptainOutput,
          },
          {
            guard: committedTo('bossIntent', 'code'),
            target: '#reviewBossCommitCode',
            actions: rememberCaptainOutput,
          },
          {
            guard: committedTo('bossIntent', 'mixed'),
            target: '#reviewBossCommitMixed',
            actions: rememberCaptainOutput,
          },
          {
            guard: committedTo('irTask', 'specs'),
            target: '#reviewIrTaskCommitSpecs',
            actions: rememberCaptainOutput,
          },
          {
            guard: committedTo('irTask', 'code'),
            target: '#reviewIrTaskCommitCode',
            actions: rememberCaptainOutput,
          },
          {
            guard: committedTo('irTask', 'mixed'),
            target: '#reviewIrTaskCommitMixed',
            actions: rememberCaptainOutput,
          },
          { guard: guardIs('noRelevantChanges'), target: '#ready', actions: rememberCaptainOutput },
          { guard: guardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    commitReviewerCleared: {
      id: 'commitReviewerCleared',
      description:
        'CODE-16: Committer commits changes Reviewer cleared in the same round when Coder has not played since the last commit.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Committer',
          sourceItem: 'CODE-16',
          prompt: [
            'Commit the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).',
            `Reviewer is ${reviewerLlm(context)}.`,
          ].join('\n'),
          result: {
            committed: 'Relevant changes were committed.',
            noRelevantChanges: 'There are no relevant changes to commit.',
            needsBossInput: 'Committing requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'committed' && context.afterReview === 'continueIr',
            target: '#continueIr',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'committed' && context.afterReview === 'summarizeSpecs',
            target: '#summarizeSpecs',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'committed' && context.afterReview === 'done',
            target: '#done',
            actions: rememberCaptainOutput,
          },
          { guard: guardIs('noRelevantChanges'), target: '#done', actions: rememberCaptainOutput },
          { guard: guardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    commitJoint: {
      id: 'commitJoint',
      description:
        'CODE-17: Committer commits changes when both Coder and Reviewer have played since the last commit.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Committer',
          sourceItem: 'CODE-17',
          prompt: [
            'Commit the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).',
            `Coder is ${coderLlm(context)}; Reviewer is ${reviewerLlm(context)}.`,
          ].join('\n'),
          result: {
            committed: 'Relevant changes were committed.',
            noRelevantChanges: 'There are no relevant changes to commit.',
            needsBossInput: 'Committing requires additional Boss input.',
          },
        }),
        onDone: [
          {
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'committed' && context.afterReview === 'continueIr',
            target: '#continueIr',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'committed' && context.afterReview === 'summarizeSpecs',
            target: '#summarizeSpecs',
            actions: rememberCaptainOutput,
          },
          {
            guard: ({ context, event }) =>
              outputOf(event)?.guard === 'committed' && context.afterReview === 'done',
            target: '#done',
            actions: rememberCaptainOutput,
          },
          { guard: guardIs('noRelevantChanges'), target: '#done', actions: rememberCaptainOutput },
          { guard: guardIs('needsBossInput'), target: '#ready', actions: rememberCaptainOutput },
        ],
        onError: captainError,
      },
    },

    failed: {
      id: 'failed',
      description:
        'Captures the last Captain error so the runner can report it. Boss may resume from here.',
      on: readyEvents,
    },

    done: {
      id: 'done',
      description: 'The selected coding workflow has completed.',
      type: 'final',
    },
  },
});
