// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// FSM object artifact compiled from ./review.gears.md by gears2fsm.
// It declares only the machine, its actor contracts, and typed inputs; the
// linked runtime supplies the `player` actor implementation.

import { assign, fromPromise, setup } from 'xstate';

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/** Canonical lowercase local ids of the source roles Coder and Reviewer. */
export type ReviewRole = 'coder' | 'reviewer';

/** One role-id array per parallel group; REVIEW declares no parallel group. */
export const concurrentRoleSets: readonly (readonly ReviewRole[])[] = [];

/** Delegated-player working leaves (REVIEW-1 through REVIEW-4). */
export type WorkingStateId =
  | 'firstReview'
  | 'fixFindings'
  | 'reviewAfterFix'
  | 'reviewAfterRejection';

/** Working leaves that may suspend for, and resume from, a Boss reply. */
export type ResumableStateId = WorkingStateId;

/** Root `BOSS_INTERRUPT` targets. */
export type JumpableStateId = WorkingStateId;

export type ReviewSourceItem = 'REVIEW-1' | 'REVIEW-2' | 'REVIEW-3' | 'REVIEW-4';

/** Coder's accepted disposition of the latest findings. */
export type CoderOutcome = 'committed' | 'rejectedAll';

// ---------------------------------------------------------------------------
// Boss-reply suspension (scalar form: one active player task at a time)
// ---------------------------------------------------------------------------

export interface PendingBossQuestion {
  readonly questionId: ResumableStateId;
  readonly resumeStateId: ResumableStateId;
  readonly sourceItem: ReviewSourceItem;
  readonly asker: { readonly kind: 'role'; readonly roleId: ReviewRole };
  readonly question: string;
}

// ---------------------------------------------------------------------------
// Delegated player actor contract
// ---------------------------------------------------------------------------

interface PlayerInputBase {
  /** The source item's full final prompt, verbatim. */
  readonly prompt: string;
  /** This state's local result contract: guard name → description. */
  readonly result: Readonly<Record<string, string>>;
  /** `<caller-input>`: the caller's complete review request. */
  readonly callerInput?: string;
  readonly pendingBossQuestion?: PendingBossQuestion;
  readonly bossReply?: string;
}

export interface FirstReviewPlayerInput extends PlayerInputBase {
  readonly stateId: 'firstReview';
  readonly role: 'reviewer';
  readonly sourceItem: 'REVIEW-1';
}

export interface FixFindingsPlayerInput extends PlayerInputBase {
  readonly stateId: 'fixFindings';
  readonly role: 'coder';
  readonly sourceItem: 'REVIEW-2';
  /** `<reviewer-output>`: Reviewer's verbatim final text of the latest round. */
  readonly reviewerOutput?: string;
}

export interface ReviewAfterFixPlayerInput extends PlayerInputBase {
  readonly stateId: 'reviewAfterFix';
  readonly role: 'reviewer';
  readonly sourceItem: 'REVIEW-3';
  /** `<latest-commit>`: the receipt-owned latest review-fix commit. */
  readonly latestCommit?: string;
  /** `<coder-output>`: Coder's verbatim final text of the latest fix round. */
  readonly coderOutput?: string;
}

export interface ReviewAfterRejectionPlayerInput extends PlayerInputBase {
  readonly stateId: 'reviewAfterRejection';
  readonly role: 'reviewer';
  readonly sourceItem: 'REVIEW-4';
  /** `<coder-output>`: Coder's verbatim final text of the latest fix round. */
  readonly coderOutput?: string;
}

export type PlayerInput =
  | FirstReviewPlayerInput
  | FixFindingsPlayerInput
  | ReviewAfterFixPlayerInput
  | ReviewAfterRejectionPlayerInput;

export type NeedsBossReplyOutput = {
  readonly guard: 'needsBossReply';
  readonly question: string;
};

/** Reviewer outcomes (REVIEW-1, REVIEW-3, REVIEW-4). */
export type ReviewerOutput =
  | { readonly guard: 'hasFindings'; readonly reviewerOutput: string }
  | {
      readonly guard: 'noFindings';
      /** Effect-owned: the exact revision taken from repository authority. */
      readonly evaluatedRevision: string;
    }
  | NeedsBossReplyOutput;

/** Coder outcomes (REVIEW-2). */
export type CoderOutput =
  | {
      readonly guard: 'committed';
      readonly coderOutput: string;
      /** Effect-owned: the runtime fills it from the repository receipt. */
      readonly latestCommit: string;
    }
  | { readonly guard: 'rejectedAll'; readonly coderOutput: string }
  | NeedsBossReplyOutput;

export type PlayerOutput = ReviewerOutput | CoderOutput;

type PlayerGuard = PlayerOutput['guard'];

export interface ErrorRecord {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

// ---------------------------------------------------------------------------
// Machine input, context, events, and output
// ---------------------------------------------------------------------------

/** Reviewer rounds REVIEW runs at most: the first and one after each of two Coder dispositions. */
export const MAX_REVIEW_ROUNDS = 3;

/** Public output interface of the packaged builtin `review`. */
export type ReviewOutput =
  | {
      readonly noUnsettledFindings: true;
      readonly evaluatedRevision: string;
    }
  | {
      /** Findings Reviewer raised or kept at the third round stay unsettled. */
      readonly noUnsettledFindings: false;
      readonly reviewerOutput: string;
    };

/** The machine reads no input: the caller input arrives on `START_REVIEW`. */
export type ReviewInput = Readonly<Record<never, never>>;

export interface ReviewContext {
  /** `<caller-input>`: the caller's intent, review scope, and context. */
  readonly callerInput?: string;
  /** `<reviewer-output>`: Reviewer's verbatim final text with findings. */
  readonly reviewerOutput?: string;
  /** `<coder-output>`: Coder's verbatim final text of the latest fix round. */
  readonly coderOutput?: string;
  /** `<latest-commit>`: the accepted, receipt-owned latest review-fix commit. */
  readonly latestCommit?: string;
  /** Coder's accepted disposition of the latest findings. */
  readonly coderOutcome?: CoderOutcome;
  /** Revision evaluated by the clean review round that ended REVIEW. */
  readonly evaluatedRevision?: string;
  /** The Reviewer round in progress: 1 at the first review, +1 per Coder disposition. */
  readonly round?: number;
  /** Set when the third round ended with findings still unsettled. */
  readonly findingsUnsettled?: true;
  readonly lastError?: ErrorRecord;
  readonly pendingBossQuestion?: PendingBossQuestion;
  readonly bossReply?: string;
}

export type ReviewEvent =
  | { readonly type: 'START_REVIEW'; readonly callerInput: string }
  | { readonly type: 'BOSS_INTERRUPT'; readonly targetId: JumpableStateId }
  | {
      readonly type: 'BOSS_REPLY';
      readonly answer: string;
      readonly questionId?: ResumableStateId;
    };

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

const NEEDS_BOSS_REPLY_DESCRIPTION =
  "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

const FIRST_REVIEW_RESULT = {
  hasFindings:
    "Reviewer raised one or more unsettled findings; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. Output shall include `reviewerOutput: <verbatim final text>`.",
  noFindings:
    "Reviewer affirmatively reported that the requested review is complete and no unsettled findings remain; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. On this outcome the workflow returns the exact repository revision at which the review scope was evaluated, taken from repository authority and not from either player's prose, as evaluatedRevision, and the fact that no unsettled findings remain within that scope, as noUnsettledFindings true. Output shall include `evaluatedRevision: <repository revision>`.",
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} as const;

const FIX_FINDINGS_RESULT = {
  committed:
    "Coder made one new review-fix commit; the outcome does not depend on finding numbering or any fixed presentation format of Coder's reply. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.",
  rejectedAll:
    "Coder rejected every finding, changed nothing, and made no commit; the outcome does not depend on finding numbering or any fixed presentation format of Coder's reply. Output shall include `coderOutput: <verbatim final text>`.",
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} as const;

const LATER_REVIEW_RESULT = {
  hasFindings:
    "Reviewer raised or kept one or more unsettled findings; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. Output shall include `reviewerOutput: <verbatim final text>`.",
  noFindings:
    "Reviewer affirmatively reported that the requested review is complete and no unsettled findings remain; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. On this outcome the workflow returns the exact repository revision at which the review scope was evaluated, taken from repository authority and not from either player's prose, as evaluatedRevision, and the fact that no unsettled findings remain within that scope, as noUnsettledFindings true. Output shall include `evaluatedRevision: <repository revision>`.",
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} as const;

/** REVIEW-3's authored result contract (identical to REVIEW-4's). */
const REVIEW_AFTER_FIX_RESULT = LATER_REVIEW_RESULT;

/** REVIEW-4's authored result contract (identical to REVIEW-3's). */
const REVIEW_AFTER_REJECTION_RESULT = LATER_REVIEW_RESULT;

const STATE_DESCRIPTIONS = {
  ready: 'Waiting for a caller to start a review.',
  firstReview: 'Reviewer runs the first review round over the review scope.',
  fixFindings:
    "Coder accepts or rejects each of Reviewer's findings and commits any accepted fixes.",
  reviewAfterFix:
    'Reviewer runs the next review round over the cumulative committed state after a review-fix commit.',
  reviewAfterRejection:
    'Reviewer runs the next review round after Coder rejected every finding without a commit.',
  awaitBossReply: "Waiting for Boss to answer the acting agent's question.",
  failed:
    'REVIEW parked after a failure and waits for Boss to restart or resume it.',
  done: 'REVIEW completed: the review scope was evaluated at the returned revision and no unsettled findings remain.',
  unsettled:
    'REVIEW stopped after its third round: findings remain unsettled within the review scope, and no further fix round runs.',
} as const;

type StateKey = keyof typeof STATE_DESCRIPTIONS;

const RESUME_METADATA = {
  firstReview: { sourceItem: 'REVIEW-1', role: 'reviewer' },
  fixFindings: { sourceItem: 'REVIEW-2', role: 'coder' },
  reviewAfterFix: { sourceItem: 'REVIEW-3', role: 'reviewer' },
  reviewAfterRejection: { sourceItem: 'REVIEW-4', role: 'reviewer' },
} as const satisfies Record<
  ResumableStateId,
  { readonly sourceItem: ReviewSourceItem; readonly role: ReviewRole }
>;

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const doneOutputOf = (event: unknown): unknown =>
  isRecord(event) ? event.output : undefined;

const actorErrorOf = (event: unknown): unknown =>
  isRecord(event) ? event.error : undefined;

/** Narrows a player done event to the declared player output contract. */
function playerOutputOf(event: unknown): PlayerOutput | undefined {
  const output = doneOutputOf(event);
  if (!isRecord(output)) return undefined;
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
function errorRecord(value: unknown): ErrorRecord {
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
// Guards
// ---------------------------------------------------------------------------

type EventArgs = { readonly event: unknown };
type MachineArgs = {
  readonly context: ReviewContext;
  readonly event: ReviewEvent;
};

const acceptsOutcome =
  (outcome: PlayerGuard) =>
  ({ event }: EventArgs): boolean =>
    playerOutputOf(event)?.guard === outcome;

type ContextEventArgs = {
  readonly context: ReviewContext;
  readonly event: unknown;
};

/** The round in progress; a context from before the bound counts as the first. */
const roundOf = (context: ReviewContext): number => context.round ?? 1;

// A later round routes findings by its ordinal: Coder answers them before the
// third round, and the third round's findings stay unsettled.
const acceptHasFindingsBeforeBound = ({ context, event }: ContextEventArgs): boolean =>
  playerOutputOf(event)?.guard === 'hasFindings' &&
  roundOf(context) < MAX_REVIEW_ROUNDS;

const acceptHasFindingsAtBound = ({ context, event }: ContextEventArgs): boolean =>
  playerOutputOf(event)?.guard === 'hasFindings' &&
  roundOf(context) >= MAX_REVIEW_ROUNDS;

// The entry guard validates the text the current event supplies, before the
// entry action copies it into context.
const validStartReview = ({ event }: MachineArgs): boolean =>
  event.type === 'START_REVIEW' && isNonEmptyString(event.callerInput);

const repliesToPendingQuestion = ({ context, event }: MachineArgs): boolean =>
  event.type === 'BOSS_REPLY' &&
  context.pendingBossQuestion !== undefined &&
  (event.questionId === undefined ||
    event.questionId === context.pendingBossQuestion.questionId);

const emptyBossReply = (args: MachineArgs): boolean =>
  repliesToPendingQuestion(args) &&
  args.event.type === 'BOSS_REPLY' &&
  !isNonEmptyString(args.event.answer);

/** Typed context each jumpable working leaf needs to be entered safely. */
const INTERRUPT_PRECONDITIONS = {
  firstReview: (context: ReviewContext) => isNonEmptyString(context.callerInput),
  fixFindings: (context: ReviewContext) =>
    isNonEmptyString(context.callerInput) &&
    isNonEmptyString(context.reviewerOutput),
  reviewAfterFix: (context: ReviewContext) =>
    isNonEmptyString(context.callerInput) &&
    context.coderOutcome === 'committed' &&
    isNonEmptyString(context.latestCommit) &&
    isNonEmptyString(context.coderOutput),
  reviewAfterRejection: (context: ReviewContext) =>
    isNonEmptyString(context.callerInput) &&
    context.coderOutcome === 'rejectedAll' &&
    isNonEmptyString(context.coderOutput),
} as const satisfies Record<
  JumpableStateId,
  (context: ReviewContext) => boolean
>;

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

/** One guarded root transition per jumpable state. */
function bossInterrupts<const Ids extends readonly JumpableStateId[]>(
  ids: Ids,
) {
  return ids.map((id) => ({
    guard: ({ context, event }: MachineArgs) =>
      event.type === 'BOSS_INTERRUPT' &&
      event.targetId === id &&
      INTERRUPT_PRECONDITIONS[id](context),
    target: `#${id}` as const,
    reenter: true,
    actions: 'resetForInterrupt' as const,
  }));
}

/** One guarded `BOSS_REPLY` resume transition per suspended working leaf. */
function resumableStates<const Ids extends readonly ResumableStateId[]>(
  ids: Ids,
) {
  return ids.map((id) => ({
    guard: (args: MachineArgs) =>
      repliesToPendingQuestion(args) &&
      args.event.type === 'BOSS_REPLY' &&
      isNonEmptyString(args.event.answer) &&
      args.context.pendingBossQuestion?.resumeStateId === id,
    target: `#${id}` as const,
    reenter: true,
    actions: 'rememberBossReply' as const,
  }));
}

const bossReplyFields = (context: ReviewContext) => ({
  ...(context.pendingBossQuestion !== undefined
    ? { pendingBossQuestion: context.pendingBossQuestion }
    : {}),
  ...(context.bossReply !== undefined ? { bossReply: context.bossReply } : {}),
});

const acceptedOutcome = (
  source: WorkingStateId,
  target: StateKey,
  outcome: PlayerGuard,
) =>
  ({
    type: 'playbook.acceptedOutcome',
    params: { source, target, acceptedOutcome: outcome },
  }) as const;

/** Reviewer found unsettled findings: Coder answers them next (REVIEW-2). */
const hasFindingsArm = (
  source: 'firstReview' | 'reviewAfterFix' | 'reviewAfterRejection',
  guard: 'acceptHasFindings' | 'acceptHasFindingsBeforeBound' = 'acceptHasFindings',
) =>
  ({
    guard,
    target: '#fixFindings',
    actions: [
      acceptedOutcome(source, 'fixFindings', 'hasFindings'),
      'rememberFindings',
      'clearBossReplyContext',
    ],
  }) as const;

/** Reviewer kept findings at the third round: they stay unsettled (DR-102). */
const unsettledArm = (source: 'reviewAfterFix' | 'reviewAfterRejection') =>
  ({
    guard: 'acceptHasFindingsAtBound',
    target: '#unsettled',
    actions: [
      acceptedOutcome(source, 'unsettled', 'hasFindings'),
      'rememberUnsettledFindings',
      'clearBossReplyContext',
    ],
  }) as const;

/** Reviewer affirmed a complete review with no unsettled findings. */
const noFindingsArm = (source: 'firstReview' | 'reviewAfterFix' | 'reviewAfterRejection') =>
  ({
    guard: 'acceptNoFindings',
    target: '#done',
    actions: [
      acceptedOutcome(source, 'done', 'noFindings'),
      'rememberEvaluatedRevision',
      'clearBossReplyContext',
    ],
  }) as const;

const suspendArm = (source: WorkingStateId) =>
  ({
    guard: 'acceptNeedsBossReply',
    target: '#awaitBossReply',
    actions: [
      acceptedOutcome(source, 'awaitBossReply', 'needsBossReply'),
      { type: 'setPendingBossQuestion', params: { resumeStateId: source } },
    ],
  }) as const;

const malformedPlayerOutputArm = {
  target: '#failed',
  actions: ['rememberMalformedPlayerOutput', 'clearBossReplyContext'],
} as const;

const playerOnError = {
  target: '#failed',
  actions: ['rememberActorError', 'clearBossReplyContext'],
} as const;

const startReviewArm = {
  guard: 'validStartReview',
  target: '#firstReview',
  actions: 'startReview',
} as const;

const meta = (stateId: Exclude<StateKey, 'done' | 'unsettled'>, role?: ReviewRole) => ({
  playbook: {
    stateId,
    description: STATE_DESCRIPTIONS[stateId],
    ...(role === undefined ? {} : { role }),
  },
});

const finalMeta = (stateId: 'done' | 'unsettled', terminal: 'success' | 'failure') => ({
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
    context: {} as ReviewContext,
    events: {} as ReviewEvent,
    input: {} as ReviewInput,
    output: {} as ReviewOutput,
  },
  actors: {
    player: fromPromise<PlayerOutput, PlayerInput>(async () => {
      throw new Error('player actor must be provided by the runner');
    }),
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
    startReview: assign(({ event }) =>
      event.type === 'START_REVIEW'
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
        : {},
    ),
    // A jump back to the first review restarts the round count; a jump into a
    // later round redoes that round and keeps it.
    resetForInterrupt: assign(({ context, event }) => ({
      evaluatedRevision: undefined,
      findingsUnsettled: undefined,
      round:
        event.type === 'BOSS_INTERRUPT' && event.targetId === 'firstReview'
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
          coderOutcome: 'committed' as const,
          round,
          lastError: undefined,
        };
      }
      if (output?.guard === 'rejectedAll') {
        return {
          coderOutput: output.coderOutput,
          coderOutcome: 'rejectedAll' as const,
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
            findingsUnsettled: true as const,
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
    setPendingBossQuestion: assign(
      ({ event }, params: { readonly resumeStateId: ResumableStateId }) => {
        const output = playerOutputOf(event);
        if (output?.guard !== 'needsBossReply') return {};
        const metadata = RESUME_METADATA[params.resumeStateId];
        const pendingBossQuestion: PendingBossQuestion = {
          questionId: params.resumeStateId,
          resumeStateId: params.resumeStateId,
          sourceItem: metadata.sourceItem,
          asker: { kind: 'role', roleId: metadata.role },
          question: output.question,
        };
        return { pendingBossQuestion, bossReply: undefined, lastError: undefined };
      },
    ),
    rememberBossReply: assign(({ event }) =>
      event.type === 'BOSS_REPLY' ? { bossReply: event.answer } : {},
    ),
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
          message:
            isRecord(output) && output.guard === 'needsBossReply'
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
  output: ({ context }): ReviewOutput => {
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
    ] as const),
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
        input: ({ context }): FirstReviewPlayerInput => ({
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
        input: ({ context }): FixFindingsPlayerInput => ({
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
        input: ({ context }): ReviewAfterFixPlayerInput => ({
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
        input: ({ context }): ReviewAfterRejectionPlayerInput => ({
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
          ] as const),
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
