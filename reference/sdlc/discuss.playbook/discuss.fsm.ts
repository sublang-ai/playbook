// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// FSM object artifact compiled from discuss.gears.md.
// This module defines the machine, actor contracts, and typed inputs only.
// It binds no runner and supplies no concrete player implementation; the runner
// provides the `player` actor via `.provide(...)`.

import { assign, fromPromise, setup } from 'xstate';

type Player = 'Host' | 'Participant' | 'Committer';

type ReviewScope = 'specItems' | 'decisionRecords' | 'mixed';

type JumpableStateId =
  | 'ready'
  | 'initialProposalRound'
  | 'reconciliationRound'
  | 'hostWritesAgreement'
  | 'commitInitialChanges'
  | 'reviewSpecInitialCommit'
  | 'reviewSpecHostChanges'
  | 'reviewDrInitialCommit'
  | 'reviewDrHostChanges'
  | 'reviewMixedInitialCommit'
  | 'reviewMixedHostChanges'
  | 'hostAddressesFindings'
  | 'participantAddressesRebuttals'
  | 'commitReviewedChanges'
  | 'failed';

type ResumableStateId =
  | 'askHostInitial'
  | 'askParticipantInitial'
  | 'hostInitialRound'
  | 'participantInitialRound'
  | Exclude<
      JumpableStateId,
      | 'ready'
      | 'initialProposalRound'
      | 'reconciliationRound'
      | 'failed'
    >;

export interface PendingBossQuestion {
  questionId: ResumableStateId;
  resumeStateId: ResumableStateId;
  sourceItem: string;
  player: Player;
  question: string;
}

type PendingBossQuestions = Partial<
  Record<ResumableStateId, PendingBossQuestion>
>;

type BossReplies = Partial<Record<ResumableStateId, string>>;

type PendingBossQuestionParams = Omit<PendingBossQuestion, 'questionId'>;

export interface DiscussContext {
  hostPlayer?: string;
  participantPlayer?: string;
  committerPlayer?: string;
  topic?: string;
  hostLlm?: string;
  participantLlm?: string;
  hostProposal?: string;
  participantProposal?: string;
  agreement?: string;
  latestChanges?: string;
  reviewScope?: ReviewScope;
  reviewItems?: string;
  rebuttals?: string;
  lastResult?: PlayerOutput;
  lastError?: unknown;
  pendingBossQuestions?: PendingBossQuestions;
  bossReplies?: BossReplies;
  stagedHostResult?: PlayerOutput;
  stagedParticipantResult?: PlayerOutput;
}

export type DiscussEvent =
  | {
      type: 'START_DISCUSSION';
      topic: string;
      hostLlm?: string;
      participantLlm?: string;
    }
  | {
      type: 'START_REVIEW';
      latestChanges: string;
      reviewScope: ReviewScope;
      rebuttals?: string;
    }
  | { type: 'BOSS_INTERRUPT'; targetId: JumpableStateId }
  | {
      type: 'BOSS_REPLY';
      questionId?: ResumableStateId;
      answer: string;
    };

export interface DiscussInput {
  host?: string;
  participant?: string;
  committer?: string;
}

export interface PlayerInput {
  stateId: ResumableStateId;
  sourceItem: string;
  prompt: string;
  result: Record<string, string>;
  player: Player;
  topic?: string;
  hostLlm?: string;
  participantLlm?: string;
  hostProposal?: string;
  participantProposal?: string;
  agreement?: string;
  latestChanges?: string;
  reviewScope?: ReviewScope;
  reviewItems?: string;
  rebuttals?: string;
  hostPlayer?: string;
  participantPlayer?: string;
  committerPlayer?: string;
  pendingBossQuestion?: PendingBossQuestion;
  bossReply?: string;
}

type AdditionalPlayerFields = {
  proposal?: string;
  agreement?: string;
  latestChanges?: string;
  reviewScope?: ReviewScope;
  reviewItems?: string;
  rebuttals?: string;
  question?: string;
  readonly [key: string]: unknown;
};

export type PlayerOutput =
  | ({ guard: 'proposalMade'; proposal: string } & AdditionalPlayerFields)
  | ({ guard: 'endedInitialDiscussion'; agreement?: string } & AdditionalPlayerFields)
  | ({
      guard: 'wroteChanges';
      latestChanges: string;
      reviewScope: ReviewScope;
    } & AdditionalPlayerFields)
  | ({
      guard: 'committed';
      latestChanges?: string;
      reviewScope?: ReviewScope;
    } & AdditionalPlayerFields)
  | ({ guard: 'noFindings' } & AdditionalPlayerFields)
  | ({ guard: 'findingsRaised'; reviewItems: string } & AdditionalPlayerFields)
  | ({
      guard: 'changesMade';
      latestChanges?: string;
      reviewScope?: ReviewScope;
    } & AdditionalPlayerFields)
  | ({ guard: 'rebuttalsRaised'; rebuttals: string } & AdditionalPlayerFields)
  | ({ guard: 'rebuttalsAddressed'; rebuttals?: string } & AdditionalPlayerFields)
  | ({ guard: 'needsBossReply'; question: string } & AdditionalPlayerFields);

type PlayerDoneEvent = { type: string; output: PlayerOutput };
type PlayerErrorEvent = { type: string; error: unknown };

const NEEDS_BOSS_REPLY_DESCRIPTION =
  "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

const DISCUSS_1_PROMPT = [
  "Boss's topic: <topic>",
  "Assess whether Boss's topic above is better expressed as a few spec items (per @specs/meta.md) or requires one or more DRs added to @specs/decisions/.",
  'Consult @specs/map.md, if necessary, to find relevant context.',
  'Each DR should be coherent and focused.',
  'Propose your design in reply.',
  'DRs, if any, need not include full detail here - describe the key points at a high level.',
  "Don't change any code.",
].join('\n');

const DISCUSS_2_PROMPT = [
  "Boss's topic: <topic>",
  "Assess whether Boss's topic above is better expressed as a few spec items (per @specs/meta.md) or requires one or more DRs added to @specs/decisions/.",
  'Consult @specs/map.md, if necessary, to find relevant context.',
  'Each DR should be coherent and focused.',
  'Propose your design in reply.',
  'DRs, if any, need not include full detail here - describe the key points at a high level.',
  "Don't change any code.",
].join('\n');

const DISCUSS_3_PROMPT = [
  "Other agent's proposal: <participant-proposal>",
  'Your previous proposal: <host-previous-proposal>',
  "Consider the other agent's proposal below.",
  '(1) If there are essentially different points (including creation or division of DRs), list them, accept any reasonable ones, and challenge the rest with strong reasoning, solid evidence, and comprehensive thinking - make your argument.',
  "(2) Only if your proposal of the previous round is equivalent to the other's, with nothing to reconcile, state the end of initial discussion.",
  "Don't change any code.",
].join('\n');

const DISCUSS_4_PROMPT = [
  "Other agent's proposal: <host-proposal>",
  'Your previous proposal: <participant-previous-proposal>',
  "Consider the other agent's proposal below.",
  '(1) If there are essentially different points (including creation or division of DRs), list them, accept any reasonable ones, and challenge the rest with strong reasoning, solid evidence, and comprehensive thinking - make your argument.',
  "(2) Only if your proposal of the previous round is equivalent to the other's, with nothing to reconcile, state the end of initial discussion.",
  "Don't change any code.",
].join('\n');

const DISCUSS_5_PROMPT = [
  'Agreement: <agreement>',
  'Write spec items or DRs according to the agreement.',
  'Update @specs/map.md to reflect your changes (if any) when done.',
].join('\n');

const DISCUSS_6_PROMPT = [
  'Latest changes: <changes>',
  'Rebuttals to address, if any: <rebuttals>',
  'Review the latest spec changes, address any rebuttals, and raise any findings.',
  'Verify any new or updated spec items are:',
  'Complete & coherent: sufficient for you to reimplement code.',
  'Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.',
  'Minimal: essential and concise; every item earns its place; also check with other items.',
  'Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
  'Flag anything missing, redundant, over-specified, or under-specified.',
  "Think thoroughly - don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_7_PROMPT = DISCUSS_6_PROMPT;

const DISCUSS_8_PROMPT = [
  'Latest changes: <changes>',
  'Rebuttals to address, if any: <rebuttals>',
  'Review the latest spec changes, address any rebuttals, and raise any findings.',
  'Review any new/updated decision following @specs/meta.md (reread if necessary).',
  'Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.',
  'Key statements must be backed by references unless they are common sense or widely acknowledged best practices.',
  "If the decision is well-thought-out and well-written, don't raise nitpicks.",
  'Remember to keep the DR simple and minimal.',
  "Think thoroughly - don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_9_PROMPT = DISCUSS_8_PROMPT;

const DISCUSS_10_PROMPT = [
  'Latest changes: <changes>',
  'Rebuttals to address, if any: <rebuttals>',
  'Review the latest spec changes, address any rebuttals, and raise any findings.',
  'Verify any new or updated spec items are:',
  'Complete & coherent: sufficient for you to reimplement code.',
  'Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.',
  'Minimal: essential and concise; every item earns its place; also check with other items.',
  'Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
  'Flag anything missing, redundant, over-specified, or under-specified.',
  'Review any new/updated decision following @specs/meta.md (reread if necessary).',
  'Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.',
  'Key statements must be backed by references unless they are common sense or widely acknowledged best practices.',
  "If the decision is well-thought-out and well-written, don't raise nitpicks.",
  'Remember to keep the DR simple and minimal.',
  "Think thoroughly - don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_11_PROMPT = DISCUSS_10_PROMPT;

const DISCUSS_12_PROMPT = [
  'Review items: <review-items>',
  'For each review item below for the above changes, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
  'Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.',
].join('\n');

const DISCUSS_13_PROMPT = [
  'Rebuttals: <rebuttals>',
  'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
].join('\n');

const DISCUSS_14_PROMPT = [
  'Then make a commit of the changes that belong in the repo, following @specs/packages/git.md (reread if necessary).',
  "If that spec is absent, follow the legacy @specs/dev/git.md; if neither exists, follow the repository's existing commit conventions and do not search elsewhere.",
  'Write the commit message concisely.',
  'Host is <host-llm>.',
  'Participant is <participant-llm>.',
  'Format the Host and Participant model IDs as conventional human forms.',
].join('\n');

const DISCUSS_15_PROMPT = DISCUSS_14_PROMPT;

const jumpableStateIds = [
  'ready',
  'initialProposalRound',
  'reconciliationRound',
  'hostWritesAgreement',
  'commitInitialChanges',
  'reviewSpecInitialCommit',
  'reviewSpecHostChanges',
  'reviewDrInitialCommit',
  'reviewDrHostChanges',
  'reviewMixedInitialCommit',
  'reviewMixedHostChanges',
  'hostAddressesFindings',
  'participantAddressesRebuttals',
  'commitReviewedChanges',
  'failed',
] as const satisfies readonly JumpableStateId[];

const resumableStateIds = [
  'askHostInitial',
  'askParticipantInitial',
  'hostInitialRound',
  'participantInitialRound',
  'hostWritesAgreement',
  'commitInitialChanges',
  'reviewSpecInitialCommit',
  'reviewSpecHostChanges',
  'reviewDrInitialCommit',
  'reviewDrHostChanges',
  'reviewMixedInitialCommit',
  'reviewMixedHostChanges',
  'hostAddressesFindings',
  'participantAddressesRebuttals',
  'commitReviewedChanges',
] as const satisfies readonly ResumableStateId[];

const outputOf = (event: unknown): PlayerOutput =>
  (event as PlayerDoneEvent).output;

const guardIs =
  (guard: string) =>
  ({ event }: { event: unknown }) =>
    outputOf(event).guard === guard;

const needsBossReplyWithQuestion = ({ event }: { event: unknown }) => {
  const output = outputOf(event);
  return (
    output.guard === 'needsBossReply' &&
    typeof output.question === 'string' &&
    output.question.trim().length > 0
  );
};

const needsBossReplyWithoutQuestion = ({ event }: { event: unknown }) => {
  const output = outputOf(event);
  return (
    output.guard === 'needsBossReply' &&
    (typeof output.question !== 'string' || output.question.trim().length === 0)
  );
};

const emptyBossReply = ({ event }: { event: DiscussEvent }) =>
  event.type === 'BOSS_REPLY' && event.answer.trim().length === 0;

const pendingQuestionIds = (context: DiscussContext): ResumableStateId[] =>
  Object.keys(context.pendingBossQuestions ?? {}) as ResumableStateId[];

const resolvedQuestionId = (
  context: DiscussContext,
  event: DiscussEvent,
): ResumableStateId | undefined => {
  if (event.type !== 'BOSS_REPLY') return undefined;
  if (event.questionId) return event.questionId;
  const ids = pendingQuestionIds(context);
  return ids.length === 1 ? ids[0] : undefined;
};

const bossReplyTargets =
  (stateId: ResumableStateId, requireAnswer: boolean) =>
  ({ context, event }: { context: DiscussContext; event: DiscussEvent }) =>
    event.type === 'BOSS_REPLY' &&
    resolvedQuestionId(context, event) === stateId &&
    (requireAnswer
      ? event.answer.trim().length > 0
      : event.answer.trim().length === 0);

const hasReviewScope =
  (scope: ReviewScope) =>
  ({ context, event }: { context: DiscussContext; event: DiscussEvent }) =>
    event.type === 'START_REVIEW'
      ? event.reviewScope === scope
      : context.reviewScope === scope;

const hasContextText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const hasKnownReviewScope = (
  context: DiscussContext,
  scope?: ReviewScope,
): boolean =>
  scope === undefined
    ? context.reviewScope === 'specItems' ||
      context.reviewScope === 'decisionRecords' ||
      context.reviewScope === 'mixed'
    : context.reviewScope === scope;

function canInterruptTo(
  context: DiscussContext,
  targetId: JumpableStateId,
): boolean {
  switch (targetId) {
    case 'ready':
    case 'failed':
      return true;
    case 'initialProposalRound':
      return hasContextText(context.topic);
    case 'reconciliationRound':
      return (
        hasContextText(context.hostProposal) &&
        hasContextText(context.participantProposal)
      );
    case 'hostWritesAgreement':
      return hasContextText(context.agreement);
    case 'commitInitialChanges':
      return (
        hasContextText(context.latestChanges) &&
        hasKnownReviewScope(context)
      );
    case 'reviewSpecInitialCommit':
    case 'reviewSpecHostChanges':
      return (
        hasContextText(context.latestChanges) &&
        hasKnownReviewScope(context, 'specItems')
      );
    case 'reviewDrInitialCommit':
    case 'reviewDrHostChanges':
      return (
        hasContextText(context.latestChanges) &&
        hasKnownReviewScope(context, 'decisionRecords')
      );
    case 'reviewMixedInitialCommit':
    case 'reviewMixedHostChanges':
      return (
        hasContextText(context.latestChanges) &&
        hasKnownReviewScope(context, 'mixed')
      );
    case 'hostAddressesFindings':
      return (
        hasContextText(context.latestChanges) &&
        hasContextText(context.reviewItems) &&
        hasKnownReviewScope(context)
      );
    case 'participantAddressesRebuttals':
      return (
        hasContextText(context.latestChanges) &&
        hasContextText(context.reviewItems) &&
        hasContextText(context.rebuttals) &&
        hasKnownReviewScope(context)
      );
    case 'commitReviewedChanges':
      return hasContextText(context.latestChanges);
  }
}

type DiscussActionName =
  | 'copyStartDiscussion'
  | 'copyStartReview'
  | 'rememberHostProposal'
  | 'rememberParticipantProposal'
  | 'rememberAgreement'
  | 'rememberWrittenChanges'
  | 'rememberCommittedChanges'
  | 'rememberReviewFindings'
  | 'rememberHostReviewResponse'
  | 'rememberParticipantRebuttalResponse'
  | 'rememberCaptainResult'
  | 'rememberCaptainError'
  | 'rememberMalformedCaptainOutput'
  | 'rememberMalformedBossReply'
  | 'setPendingBossQuestion'
  | 'rememberBossReply'
  | 'clearBranchBossReplyContext'
  | 'clearParallelRoundContext'
  | 'clearBossReplyContext';

function bossInterrupts(
  ids: readonly JumpableStateId[],
  actions?: DiscussActionName | DiscussActionName[],
): any[] {
  return ids.map((id) => ({
    guard: ({
      context,
      event,
    }: {
      context: DiscussContext;
      event: DiscussEvent;
    }) =>
      event.type === 'BOSS_INTERRUPT' &&
      event.targetId === id &&
      canInterruptTo(context, id),
    target: `#${id}`,
    reenter: true,
    ...(actions ? { actions } : {}),
  }));
}

function resumableStates(ids: readonly string[]): any[] {
  return ids.map((id) => ({
    guard: ({
      context,
      event,
    }: {
      context: DiscussContext;
      event: DiscussEvent;
    }) =>
      event.type === 'BOSS_REPLY' &&
      event.answer.trim().length > 0 &&
      resolvedQuestionId(context, event) === id,
    target: `#${id}`,
    reenter: true,
    actions: 'rememberBossReply',
  }));
}

const bossReplyFields = (
  context: DiscussContext,
  stateId: ResumableStateId,
) => ({
  ...(context.pendingBossQuestions?.[stateId]
    ? { pendingBossQuestion: context.pendingBossQuestions[stateId] }
    : {}),
  ...(context.bossReplies?.[stateId]
    ? { bossReply: context.bossReplies[stateId] }
    : {}),
});

const withoutKey = <T>(
  record: Partial<Record<ResumableStateId, T>> | undefined,
  stateId: ResumableStateId,
): Partial<Record<ResumableStateId, T>> | undefined => {
  if (!record || record[stateId] === undefined) return record;
  const next = { ...record };
  delete next[stateId];
  return Object.keys(next).length > 0 ? next : undefined;
};

const bothEndedInitialDiscussion = ({ context }: { context: DiscussContext }) =>
  context.stagedHostResult?.guard === 'endedInitialDiscussion' &&
  context.stagedParticipantResult?.guard === 'endedInitialDiscussion';

const withNeedsBossReply = <T extends Record<string, string>>(result: T) => ({
  ...result,
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
});

const captainStateMetadata: Record<
  ResumableStateId,
  { sourceItem: string; player: Player }
> = {
  askHostInitial: { sourceItem: 'DISCUSS-1', player: 'Host' },
  askParticipantInitial: { sourceItem: 'DISCUSS-2', player: 'Participant' },
  hostInitialRound: { sourceItem: 'DISCUSS-3', player: 'Host' },
  participantInitialRound: { sourceItem: 'DISCUSS-4', player: 'Participant' },
  hostWritesAgreement: { sourceItem: 'DISCUSS-5', player: 'Host' },
  commitInitialChanges: { sourceItem: 'DISCUSS-14', player: 'Committer' },
  reviewSpecInitialCommit: { sourceItem: 'DISCUSS-6', player: 'Participant' },
  reviewSpecHostChanges: { sourceItem: 'DISCUSS-7', player: 'Participant' },
  reviewDrInitialCommit: { sourceItem: 'DISCUSS-8', player: 'Participant' },
  reviewDrHostChanges: { sourceItem: 'DISCUSS-9', player: 'Participant' },
  reviewMixedInitialCommit: { sourceItem: 'DISCUSS-10', player: 'Participant' },
  reviewMixedHostChanges: { sourceItem: 'DISCUSS-11', player: 'Participant' },
  hostAddressesFindings: { sourceItem: 'DISCUSS-12', player: 'Host' },
  participantAddressesRebuttals: {
    sourceItem: 'DISCUSS-13',
    player: 'Participant',
  },
  commitReviewedChanges: { sourceItem: 'DISCUSS-15', player: 'Committer' },
};

const reviewTargets = {
  specItems: {
    initial: 'reviewSpecInitialCommit',
    afterChanges: 'reviewSpecHostChanges',
  },
  decisionRecords: {
    initial: 'reviewDrInitialCommit',
    afterChanges: 'reviewDrHostChanges',
  },
  mixed: {
    initial: 'reviewMixedInitialCommit',
    afterChanges: 'reviewMixedHostChanges',
  },
} satisfies Record<ReviewScope, { initial: string; afterChanges: string }>;

export const discussMachine = setup({
  types: {
    context: {} as DiscussContext,
    events: {} as DiscussEvent,
    input: {} as DiscussInput,
  },
  actors: {
    player: fromPromise<PlayerOutput, PlayerInput>(async () => {
      throw new Error('player actor must be provided by the runner');
    }),
  },
  actions: {
    copyStartDiscussion: assign({
      topic: ({ event }) =>
        event.type === 'START_DISCUSSION' ? event.topic : undefined,
      // Optional per-run identities: an event that omits them must not clear
      // the input-seeded context values (gears2fsm.md, Boss entry events).
      hostLlm: ({ context, event }) =>
        event.type === 'START_DISCUSSION'
          ? (event.hostLlm ?? context.hostLlm)
          : context.hostLlm,
      participantLlm: ({ context, event }) =>
        event.type === 'START_DISCUSSION'
          ? (event.participantLlm ?? context.participantLlm)
          : context.participantLlm,
      hostProposal: undefined,
      participantProposal: undefined,
      agreement: undefined,
      latestChanges: undefined,
      reviewScope: undefined,
      reviewItems: undefined,
      rebuttals: undefined,
      lastResult: undefined,
      lastError: undefined,
      pendingBossQuestions: undefined,
      bossReplies: undefined,
      stagedHostResult: undefined,
      stagedParticipantResult: undefined,
    }),
    copyStartReview: assign({
      latestChanges: ({ event }) =>
        event.type === 'START_REVIEW' ? event.latestChanges : undefined,
      reviewScope: ({ event }) =>
        event.type === 'START_REVIEW' ? event.reviewScope : undefined,
      rebuttals: ({ event }) =>
        event.type === 'START_REVIEW' ? event.rebuttals : undefined,
      reviewItems: undefined,
      lastResult: undefined,
      lastError: undefined,
      pendingBossQuestions: undefined,
      bossReplies: undefined,
      stagedHostResult: undefined,
      stagedParticipantResult: undefined,
    }),
    rememberHostProposal: assign({
      hostProposal: ({ event }) => outputOf(event).proposal,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberParticipantProposal: assign({
      participantProposal: ({ event }) => outputOf(event).proposal,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    stageHostResult: assign({
      stagedHostResult: ({ event }) => outputOf(event),
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    stageParticipantResult: assign({
      stagedParticipantResult: ({ event }) => outputOf(event),
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    promoteInitialResults: assign({
      hostProposal: ({ context }) => context.stagedHostResult?.proposal,
      participantProposal: ({ context }) =>
        context.stagedParticipantResult?.proposal,
      stagedHostResult: undefined,
      stagedParticipantResult: undefined,
      lastResult: undefined,
      lastError: undefined,
    }),
    promoteReconciliationResults: assign({
      hostProposal: ({ context }) =>
        context.stagedHostResult?.proposal ?? context.hostProposal,
      participantProposal: ({ context }) =>
        context.stagedParticipantResult?.proposal ??
        context.participantProposal,
      agreement: ({ context }) => {
        const host = context.stagedHostResult;
        const participant = context.stagedParticipantResult;
        if (
          host?.guard === 'endedInitialDiscussion' &&
          participant?.guard === 'endedInitialDiscussion'
        ) {
          return (
            participant.agreement ??
            host.agreement ??
            context.agreement ??
            participant.proposal ??
            host.proposal ??
            context.participantProposal ??
            context.hostProposal
          );
        }
        if (participant?.guard === 'endedInitialDiscussion') {
          return participant.agreement ?? context.agreement;
        }
        if (host?.guard === 'endedInitialDiscussion') {
          return host.agreement ?? context.agreement;
        }
        return context.agreement;
      },
      stagedHostResult: undefined,
      stagedParticipantResult: undefined,
      lastResult: undefined,
      lastError: undefined,
    }),
    rememberAgreement: assign({
      agreement: ({ context, event }) =>
        outputOf(event).agreement ??
        context.agreement ??
        outputOf(event).proposal ??
        context.hostProposal,
      hostProposal: ({ context, event }) =>
        outputOf(event).proposal ?? context.hostProposal,
      participantProposal: ({ context }) => context.participantProposal,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberWrittenChanges: assign({
      latestChanges: ({ event }) => outputOf(event).latestChanges,
      reviewScope: ({ event }) => outputOf(event).reviewScope,
      agreement: ({ context, event }) =>
        outputOf(event).agreement ?? context.agreement,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberCommittedChanges: assign({
      latestChanges: ({ context, event }) =>
        outputOf(event).latestChanges ?? context.latestChanges,
      reviewScope: ({ context, event }) =>
        outputOf(event).reviewScope ?? context.reviewScope,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberReviewFindings: assign({
      reviewItems: ({ event }) => outputOf(event).reviewItems,
      rebuttals: ({ context, event }) =>
        outputOf(event).rebuttals ?? context.rebuttals,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberHostReviewResponse: assign({
      latestChanges: ({ context, event }) =>
        outputOf(event).latestChanges ?? context.latestChanges,
      rebuttals: ({ event }) => outputOf(event).rebuttals,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberParticipantRebuttalResponse: assign({
      rebuttals: ({ event }) => outputOf(event).rebuttals,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberCaptainResult: assign({
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberCaptainError: assign({
      lastError: ({ event }) => (event as unknown as PlayerErrorEvent).error,
    }),
    rememberMalformedCaptainOutput: assign({
      lastError: ({ event }) => outputOf(event),
    }),
    rememberMalformedBossReply: assign({
      lastError: ({ event }) => event,
    }),
    setPendingBossQuestion: assign({
      pendingBossQuestions: (
        { context, event },
        params: PendingBossQuestionParams,
      ) => ({
        ...context.pendingBossQuestions,
        [params.resumeStateId]: {
          ...params,
          questionId: params.resumeStateId,
          question: outputOf(event).question ?? '',
        },
      }),
      bossReplies: ({ context }, params: PendingBossQuestionParams) =>
        withoutKey(context.bossReplies, params.resumeStateId),
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberBossReply: assign({
      bossReplies: ({ context, event }) => {
        const questionId = resolvedQuestionId(context, event);
        return event.type === 'BOSS_REPLY' && questionId
          ? { ...context.bossReplies, [questionId]: event.answer }
          : context.bossReplies;
      },
      lastError: undefined,
    }),
    clearBranchBossReplyContext: assign({
      pendingBossQuestions: (
        { context },
        params: { stateId: ResumableStateId },
      ) => withoutKey(context.pendingBossQuestions, params.stateId),
      bossReplies: ({ context }, params: { stateId: ResumableStateId }) =>
        withoutKey(context.bossReplies, params.stateId),
    }),
    clearParallelRoundContext: assign({
      pendingBossQuestions: undefined,
      bossReplies: undefined,
      stagedHostResult: undefined,
      stagedParticipantResult: undefined,
    }),
    clearBossReplyContext: assign({
      pendingBossQuestions: undefined,
      bossReplies: undefined,
    }),
  },
  guards: {
    needsBossReplyWithQuestion,
    needsBossReplyWithoutQuestion,
    emptyBossReply,
    bothEndedInitialDiscussion,
    proposalMade: guardIs('proposalMade'),
    endedInitialDiscussion: guardIs('endedInitialDiscussion'),
    wroteChanges: guardIs('wroteChanges'),
    committed: guardIs('committed'),
    noFindings: guardIs('noFindings'),
    findingsRaised: guardIs('findingsRaised'),
    changesMade: guardIs('changesMade'),
    rebuttalsRaised: guardIs('rebuttalsRaised'),
    rebuttalsAddressed: guardIs('rebuttalsAddressed'),
    specReview: hasReviewScope('specItems'),
    drReview: hasReviewScope('decisionRecords'),
    mixedReview: hasReviewScope('mixed'),
  },
}).createMachine({
  id: 'discuss',
  initial: 'ready',
  context: ({ input }): DiscussContext => ({
    hostPlayer: input.host,
    participantPlayer: input.participant,
    committerPlayer: input.committer,
    // Per-run identities seed the <host-llm>/<participant-llm> substitutions;
    // a START_DISCUSSION that names identities overrides them (gears2fsm.md:
    // per-run parameters flow in via the machine's input).
    hostLlm: input.host,
    participantLlm: input.participant,
  }),
  on: {
    START_DISCUSSION: {
      target: '#initialProposalRound',
      reenter: true,
      actions: ['clearParallelRoundContext', 'copyStartDiscussion'],
    },
    START_REVIEW: [
      {
        guard: 'specReview',
        target: '#reviewSpecInitialCommit',
        reenter: true,
        actions: ['clearParallelRoundContext', 'copyStartReview'],
      },
      {
        guard: 'drReview',
        target: '#reviewDrInitialCommit',
        reenter: true,
        actions: ['clearParallelRoundContext', 'copyStartReview'],
      },
      {
        guard: 'mixedReview',
        target: '#reviewMixedInitialCommit',
        reenter: true,
        actions: ['clearParallelRoundContext', 'copyStartReview'],
      },
    ],
    BOSS_INTERRUPT: bossInterrupts(
      jumpableStateIds,
      'clearParallelRoundContext',
    ),
  },
  states: {
    ready: {
      id: 'ready',
      tags: 'playbook.parked',
      description: 'Idle hub awaiting a Boss discussion or review directive.',
      meta: {
        playbook: {
          stateId: 'ready',
          description:
            'Idle hub awaiting a Boss discussion or review directive.',
        },
      },
      on: {
        START_DISCUSSION: {
          target: 'initialProposalRound',
          actions: 'copyStartDiscussion',
        },
        START_REVIEW: [
          {
            guard: 'specReview',
            target: reviewTargets.specItems.initial,
            actions: 'copyStartReview',
          },
          {
            guard: 'drReview',
            target: reviewTargets.decisionRecords.initial,
            actions: 'copyStartReview',
          },
          {
            guard: 'mixedReview',
            target: reviewTargets.mixed.initial,
            actions: 'copyStartReview',
          },
        ],
      },
    },
    initialProposalRound: {
      id: 'initialProposalRound',
      type: 'parallel',
      description: 'Host and Participant independently propose designs.',
      meta: {
        playbook: {
          stateId: 'initialProposalRound',
          description: 'Host and Participant independently propose designs.',
        },
      },
      states: {
        host: {
          id: 'initialProposalHost',
          initial: 'working',
          description: 'Host branch for the parallel initial proposal round.',
          meta: {
            playbook: {
              stateId: 'initialProposalHost',
              description:
                'Host branch for the parallel initial proposal round.',
            },
          },
          states: {
            working: {
              id: 'askHostInitial',
              tags: 'playbook.busy',
              description:
                'Host proposes whether the Boss topic should become spec items or DRs.',
              meta: {
                playbook: {
                  stateId: 'askHostInitial',
                  description:
                    'Host proposes whether the Boss topic should become spec items or DRs.',
                },
              },
              invoke: {
                id: 'askHostInitialCaptain',
                src: 'player',
                input: ({ context }): PlayerInput => ({
                  stateId: 'askHostInitial',
                  player: 'Host',
                  sourceItem: 'DISCUSS-1',
                  prompt: DISCUSS_1_PROMPT,
                  result: withNeedsBossReply({
                    proposalMade:
                      'Host proposed a design. Output shall include `proposal: <host proposal>`.',
                  }),
                  topic: context.topic,
                  hostPlayer: context.hostPlayer,
                  ...bossReplyFields(context, 'askHostInitial'),
                }),
                onDone: [
                  {
                    guard: 'needsBossReplyWithQuestion',
                    target: 'waiting',
                    actions: {
                      type: 'setPendingBossQuestion',
                      params: {
                        ...captainStateMetadata.askHostInitial,
                        resumeStateId: 'askHostInitial',
                        question: '',
                      },
                    },
                  },
                  {
                    guard: 'needsBossReplyWithoutQuestion',
                    target: '#failed',
                    actions: [
                      'rememberMalformedCaptainOutput',
                      'clearParallelRoundContext',
                    ],
                  },
                  {
                    guard: 'proposalMade',
                    target: 'complete',
                    actions: [
                      'stageHostResult',
                      {
                        type: 'clearBranchBossReplyContext',
                        params: { stateId: 'askHostInitial' },
                      },
                    ],
                  },
                  {
                    target: '#failed',
                    actions: [
                      'rememberMalformedCaptainOutput',
                      'clearParallelRoundContext',
                    ],
                  },
                ],
                onError: {
                  target: '#failed',
                  actions: [
                    'rememberCaptainError',
                    'clearParallelRoundContext',
                  ],
                },
              },
            },
            waiting: {
              id: 'waitHostInitialReply',
              tags: 'playbook.parked',
              description:
                'Host waits for Boss to answer its proposal question.',
              meta: {
                playbook: {
                  stateId: 'waitHostInitialReply',
                  description:
                    'Host waits for Boss to answer its proposal question.',
                },
              },
              on: {
                BOSS_REPLY: [
                  {
                    guard: bossReplyTargets('askHostInitial', false),
                    target: '#failed',
                    actions: [
                      'rememberMalformedBossReply',
                      'clearParallelRoundContext',
                    ],
                  },
                  {
                    guard: bossReplyTargets('askHostInitial', true),
                    target: 'working',
                    actions: 'rememberBossReply',
                  },
                ],
              },
            },
            complete: {
              id: 'hostInitialProposalComplete',
              type: 'final',
              description:
                'Host initial proposal is staged for the round join.',
              meta: {
                playbook: {
                  stateId: 'hostInitialProposalComplete',
                  description:
                    'Host initial proposal is staged for the round join.',
                },
              },
            },
          },
        },
        participant: {
          id: 'initialProposalParticipant',
          initial: 'working',
          description:
            'Participant branch for the parallel initial proposal round.',
          meta: {
            playbook: {
              stateId: 'initialProposalParticipant',
              description:
                'Participant branch for the parallel initial proposal round.',
            },
          },
          states: {
            working: {
              id: 'askParticipantInitial',
              tags: 'playbook.busy',
              description:
                'Participant independently proposes whether the Boss topic should become spec items or DRs.',
              meta: {
                playbook: {
                  stateId: 'askParticipantInitial',
                  description:
                    'Participant independently proposes whether the Boss topic should become spec items or DRs.',
                },
              },
              invoke: {
                id: 'askParticipantInitialCaptain',
                src: 'player',
                input: ({ context }): PlayerInput => ({
                  stateId: 'askParticipantInitial',
                  player: 'Participant',
                  sourceItem: 'DISCUSS-2',
                  prompt: DISCUSS_2_PROMPT,
                  result: withNeedsBossReply({
                    proposalMade:
                      'Participant proposed a design. Output shall include `proposal: <participant proposal>`.',
                  }),
                  topic: context.topic,
                  participantPlayer: context.participantPlayer,
                  ...bossReplyFields(context, 'askParticipantInitial'),
                }),
                onDone: [
                  {
                    guard: 'needsBossReplyWithQuestion',
                    target: 'waiting',
                    actions: {
                      type: 'setPendingBossQuestion',
                      params: {
                        ...captainStateMetadata.askParticipantInitial,
                        resumeStateId: 'askParticipantInitial',
                        question: '',
                      },
                    },
                  },
                  {
                    guard: 'needsBossReplyWithoutQuestion',
                    target: '#failed',
                    actions: [
                      'rememberMalformedCaptainOutput',
                      'clearParallelRoundContext',
                    ],
                  },
                  {
                    guard: 'proposalMade',
                    target: 'complete',
                    actions: [
                      'stageParticipantResult',
                      {
                        type: 'clearBranchBossReplyContext',
                        params: { stateId: 'askParticipantInitial' },
                      },
                    ],
                  },
                  {
                    target: '#failed',
                    actions: [
                      'rememberMalformedCaptainOutput',
                      'clearParallelRoundContext',
                    ],
                  },
                ],
                onError: {
                  target: '#failed',
                  actions: [
                    'rememberCaptainError',
                    'clearParallelRoundContext',
                  ],
                },
              },
            },
            waiting: {
              id: 'waitParticipantInitialReply',
              tags: 'playbook.parked',
              description:
                'Participant waits for Boss to answer its proposal question.',
              meta: {
                playbook: {
                  stateId: 'waitParticipantInitialReply',
                  description:
                    'Participant waits for Boss to answer its proposal question.',
                },
              },
              on: {
                BOSS_REPLY: [
                  {
                    guard: bossReplyTargets('askParticipantInitial', false),
                    target: '#failed',
                    actions: [
                      'rememberMalformedBossReply',
                      'clearParallelRoundContext',
                    ],
                  },
                  {
                    guard: bossReplyTargets('askParticipantInitial', true),
                    target: 'working',
                    actions: 'rememberBossReply',
                  },
                ],
              },
            },
            complete: {
              id: 'participantInitialProposalComplete',
              type: 'final',
              description:
                'Participant initial proposal is staged for the round join.',
              meta: {
                playbook: {
                  stateId: 'participantInitialProposalComplete',
                  description:
                    'Participant initial proposal is staged for the round join.',
                },
              },
            },
          },
        },
      },
      onDone: {
        target: 'reconciliationRound',
        actions: 'promoteInitialResults',
      },
    },
    reconciliationRound: {
      id: 'reconciliationRound',
      type: 'parallel',
      description:
        'Host and Participant independently reconcile one completed prior round.',
      meta: {
        playbook: {
          stateId: 'reconciliationRound',
          description:
            'Host and Participant independently reconcile one completed prior round.',
        },
      },
      states: {
        host: {
          id: 'reconciliationHost',
          initial: 'working',
          description: 'Host branch for the parallel reconciliation round.',
          meta: {
            playbook: {
              stateId: 'reconciliationHost',
              description: 'Host branch for the parallel reconciliation round.',
            },
          },
          states: {
            working: {
              id: 'hostInitialRound',
              tags: 'playbook.busy',
              description:
                'Host reconciles the Participant proposal during initial discussion.',
              meta: {
                playbook: {
                  stateId: 'hostInitialRound',
                  description:
                    'Host reconciles the Participant proposal during initial discussion.',
                },
              },
              invoke: {
                id: 'hostInitialRoundCaptain',
                src: 'player',
                input: ({ context }): PlayerInput => ({
                  stateId: 'hostInitialRound',
                  player: 'Host',
                  sourceItem: 'DISCUSS-3',
                  prompt: DISCUSS_3_PROMPT,
                  result: withNeedsBossReply({
                    proposalMade:
                      'Host continued the discussion with a revised or challenged proposal. Output shall include `proposal: <host proposal>`.',
                    endedInitialDiscussion:
                      'Host stated the end of initial discussion. Output may include `agreement: <agreement>`.',
                  }),
                  hostProposal: context.hostProposal,
                  participantProposal: context.participantProposal,
                  hostPlayer: context.hostPlayer,
                  ...bossReplyFields(context, 'hostInitialRound'),
                }),
                onDone: [
                  {
                    guard: 'needsBossReplyWithQuestion',
                    target: 'waiting',
                    actions: {
                      type: 'setPendingBossQuestion',
                      params: {
                        ...captainStateMetadata.hostInitialRound,
                        resumeStateId: 'hostInitialRound',
                        question: '',
                      },
                    },
                  },
                  {
                    guard: 'needsBossReplyWithoutQuestion',
                    target: '#failed',
                    actions: [
                      'rememberMalformedCaptainOutput',
                      'clearParallelRoundContext',
                    ],
                  },
                  {
                    guard: 'proposalMade',
                    target: 'complete',
                    actions: [
                      'stageHostResult',
                      {
                        type: 'clearBranchBossReplyContext',
                        params: { stateId: 'hostInitialRound' },
                      },
                    ],
                  },
                  {
                    guard: 'endedInitialDiscussion',
                    target: 'complete',
                    actions: [
                      'stageHostResult',
                      {
                        type: 'clearBranchBossReplyContext',
                        params: { stateId: 'hostInitialRound' },
                      },
                    ],
                  },
                  {
                    target: '#failed',
                    actions: [
                      'rememberMalformedCaptainOutput',
                      'clearParallelRoundContext',
                    ],
                  },
                ],
                onError: {
                  target: '#failed',
                  actions: [
                    'rememberCaptainError',
                    'clearParallelRoundContext',
                  ],
                },
              },
            },
            waiting: {
              id: 'waitHostReconciliationReply',
              tags: 'playbook.parked',
              description:
                'Host waits for Boss to answer its reconciliation question.',
              meta: {
                playbook: {
                  stateId: 'waitHostReconciliationReply',
                  description:
                    'Host waits for Boss to answer its reconciliation question.',
                },
              },
              on: {
                BOSS_REPLY: [
                  {
                    guard: bossReplyTargets('hostInitialRound', false),
                    target: '#failed',
                    actions: [
                      'rememberMalformedBossReply',
                      'clearParallelRoundContext',
                    ],
                  },
                  {
                    guard: bossReplyTargets('hostInitialRound', true),
                    target: 'working',
                    actions: 'rememberBossReply',
                  },
                ],
              },
            },
            complete: {
              id: 'hostReconciliationComplete',
              type: 'final',
              description: 'Host reconciliation result is staged for the join.',
              meta: {
                playbook: {
                  stateId: 'hostReconciliationComplete',
                  description:
                    'Host reconciliation result is staged for the join.',
                },
              },
            },
          },
        },
        participant: {
          id: 'reconciliationParticipant',
          initial: 'working',
          description:
            'Participant branch for the parallel reconciliation round.',
          meta: {
            playbook: {
              stateId: 'reconciliationParticipant',
              description:
                'Participant branch for the parallel reconciliation round.',
            },
          },
          states: {
            working: {
              id: 'participantInitialRound',
              tags: 'playbook.busy',
              description:
                'Participant reconciles the Host proposal during initial discussion.',
              meta: {
                playbook: {
                  stateId: 'participantInitialRound',
                  description:
                    'Participant reconciles the Host proposal during initial discussion.',
                },
              },
              invoke: {
                id: 'participantInitialRoundCaptain',
                src: 'player',
                input: ({ context }): PlayerInput => ({
                  stateId: 'participantInitialRound',
                  player: 'Participant',
                  sourceItem: 'DISCUSS-4',
                  prompt: DISCUSS_4_PROMPT,
                  result: withNeedsBossReply({
                    proposalMade:
                      'Participant continued the discussion with a revised or challenged proposal. Output shall include `proposal: <participant proposal>`.',
                    endedInitialDiscussion:
                      'Participant stated the end of initial discussion. Output may include `agreement: <agreement>`.',
                  }),
                  hostProposal: context.hostProposal,
                  participantProposal: context.participantProposal,
                  agreement: context.agreement,
                  participantPlayer: context.participantPlayer,
                  ...bossReplyFields(context, 'participantInitialRound'),
                }),
                onDone: [
                  {
                    guard: 'needsBossReplyWithQuestion',
                    target: 'waiting',
                    actions: {
                      type: 'setPendingBossQuestion',
                      params: {
                        ...captainStateMetadata.participantInitialRound,
                        resumeStateId: 'participantInitialRound',
                        question: '',
                      },
                    },
                  },
                  {
                    guard: 'needsBossReplyWithoutQuestion',
                    target: '#failed',
                    actions: [
                      'rememberMalformedCaptainOutput',
                      'clearParallelRoundContext',
                    ],
                  },
                  {
                    guard: 'proposalMade',
                    target: 'complete',
                    actions: [
                      'stageParticipantResult',
                      {
                        type: 'clearBranchBossReplyContext',
                        params: { stateId: 'participantInitialRound' },
                      },
                    ],
                  },
                  {
                    guard: 'endedInitialDiscussion',
                    target: 'complete',
                    actions: [
                      'stageParticipantResult',
                      {
                        type: 'clearBranchBossReplyContext',
                        params: { stateId: 'participantInitialRound' },
                      },
                    ],
                  },
                  {
                    target: '#failed',
                    actions: [
                      'rememberMalformedCaptainOutput',
                      'clearParallelRoundContext',
                    ],
                  },
                ],
                onError: {
                  target: '#failed',
                  actions: [
                    'rememberCaptainError',
                    'clearParallelRoundContext',
                  ],
                },
              },
            },
            waiting: {
              id: 'waitParticipantReconciliationReply',
              tags: 'playbook.parked',
              description:
                'Participant waits for Boss to answer its reconciliation question.',
              meta: {
                playbook: {
                  stateId: 'waitParticipantReconciliationReply',
                  description:
                    'Participant waits for Boss to answer its reconciliation question.',
                },
              },
              on: {
                BOSS_REPLY: [
                  {
                    guard: bossReplyTargets('participantInitialRound', false),
                    target: '#failed',
                    actions: [
                      'rememberMalformedBossReply',
                      'clearParallelRoundContext',
                    ],
                  },
                  {
                    guard: bossReplyTargets('participantInitialRound', true),
                    target: 'working',
                    actions: 'rememberBossReply',
                  },
                ],
              },
            },
            complete: {
              id: 'participantReconciliationComplete',
              type: 'final',
              description:
                'Participant reconciliation result is staged for the join.',
              meta: {
                playbook: {
                  stateId: 'participantReconciliationComplete',
                  description:
                    'Participant reconciliation result is staged for the join.',
                },
              },
            },
          },
        },
      },
      onDone: [
        {
          guard: 'bothEndedInitialDiscussion',
          target: 'hostWritesAgreement',
          actions: 'promoteReconciliationResults',
        },
        {
          target: 'reconciliationRound',
          reenter: true,
          actions: 'promoteReconciliationResults',
        },
      ],
    },
    hostWritesAgreement: {
      id: 'hostWritesAgreement',
      tags: 'playbook.busy',
      description:
        'Host writes the agreed spec items or DRs and updates the spec map.',
      meta: {
        playbook: {
          stateId: 'hostWritesAgreement',
          description:
            'Host writes the agreed spec items or DRs and updates the spec map.',
        },
      },
      invoke: {
        id: 'hostWritesAgreementCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'hostWritesAgreement',
          player: 'Host',
          sourceItem: 'DISCUSS-5',
          prompt: DISCUSS_5_PROMPT,
          result: withNeedsBossReply({
            wroteChanges:
              'Host wrote the agreed changes. Output shall include `latestChanges: <summary>` and `reviewScope: "specItems" | "decisionRecords" | "mixed"`.',
          }),
          agreement: context.agreement,
          hostPlayer: context.hostPlayer,
          ...bossReplyFields(context, 'hostWritesAgreement'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.hostWritesAgreement,
                resumeStateId: 'hostWritesAgreement',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'wroteChanges',
            target: 'commitInitialChanges',
            actions: ['rememberWrittenChanges', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    commitInitialChanges: {
      id: 'commitInitialChanges',
      tags: 'playbook.busy',
      description:
        'Committer commits the changes produced at the end of initial discussion.',
      meta: {
        playbook: {
          stateId: 'commitInitialChanges',
          description:
            'Committer commits the changes produced at the end of initial discussion.',
        },
      },
      invoke: {
        id: 'commitInitialChangesCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'commitInitialChanges',
          player: 'Committer',
          sourceItem: 'DISCUSS-14',
          prompt: DISCUSS_14_PROMPT,
          result: withNeedsBossReply({
            committed:
              'Committer made the initial-discussion commit. Output may include `latestChanges: <summary>` and `reviewScope: "specItems" | "decisionRecords" | "mixed"`.',
          }),
          latestChanges: context.latestChanges,
          reviewScope: context.reviewScope,
          hostLlm: context.hostLlm,
          participantLlm: context.participantLlm,
          committerPlayer: context.committerPlayer,
          ...bossReplyFields(context, 'commitInitialChanges'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.commitInitialChanges,
                resumeStateId: 'commitInitialChanges',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: ({ context, event }) =>
              outputOf(event).guard === 'committed' &&
              (outputOf(event).reviewScope ?? context.reviewScope) ===
                'specItems',
            target: reviewTargets.specItems.initial,
            actions: ['rememberCommittedChanges', 'clearBossReplyContext'],
          },
          {
            guard: ({ context, event }) =>
              outputOf(event).guard === 'committed' &&
              (outputOf(event).reviewScope ?? context.reviewScope) ===
                'decisionRecords',
            target: reviewTargets.decisionRecords.initial,
            actions: ['rememberCommittedChanges', 'clearBossReplyContext'],
          },
          {
            guard: ({ context, event }) =>
              outputOf(event).guard === 'committed' &&
              (outputOf(event).reviewScope ?? context.reviewScope) === 'mixed',
            target: reviewTargets.mixed.initial,
            actions: ['rememberCommittedChanges', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    reviewSpecInitialCommit: {
      id: 'reviewSpecInitialCommit',
      tags: 'playbook.busy',
      description: 'Participant reviews newly committed spec-item changes.',
      meta: {
        playbook: {
          stateId: 'reviewSpecInitialCommit',
          description: 'Participant reviews newly committed spec-item changes.',
        },
      },
      invoke: {
        id: 'reviewSpecInitialCommitCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewSpecInitialCommit',
          player: 'Participant',
          sourceItem: 'DISCUSS-6',
          prompt: DISCUSS_6_PROMPT,
          result: withNeedsBossReply({
            noFindings: 'Participant raised no findings.',
            findingsRaised:
              'Participant raised findings. Output shall include `reviewItems: <findings>`.',
          }),
          latestChanges: context.latestChanges,
          rebuttals: context.rebuttals,
          participantPlayer: context.participantPlayer,
          ...bossReplyFields(context, 'reviewSpecInitialCommit'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.reviewSpecInitialCommit,
                resumeStateId: 'reviewSpecInitialCommit',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'noFindings',
            target: 'commitReviewedChanges',
            actions: ['rememberCaptainResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaised',
            target: 'hostAddressesFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    reviewSpecHostChanges: {
      id: 'reviewSpecHostChanges',
      tags: 'playbook.busy',
      description:
        'Participant reviews Host changes to spec items after findings.',
      meta: {
        playbook: {
          stateId: 'reviewSpecHostChanges',
          description:
            'Participant reviews Host changes to spec items after findings.',
        },
      },
      invoke: {
        id: 'reviewSpecHostChangesCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewSpecHostChanges',
          player: 'Participant',
          sourceItem: 'DISCUSS-7',
          prompt: DISCUSS_7_PROMPT,
          result: withNeedsBossReply({
            noFindings: 'Participant raised no findings.',
            findingsRaised:
              'Participant raised findings. Output shall include `reviewItems: <findings>`.',
          }),
          latestChanges: context.latestChanges,
          rebuttals: context.rebuttals,
          participantPlayer: context.participantPlayer,
          ...bossReplyFields(context, 'reviewSpecHostChanges'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.reviewSpecHostChanges,
                resumeStateId: 'reviewSpecHostChanges',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'noFindings',
            target: 'commitReviewedChanges',
            actions: ['rememberCaptainResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaised',
            target: 'hostAddressesFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    reviewDrInitialCommit: {
      id: 'reviewDrInitialCommit',
      tags: 'playbook.busy',
      description:
        'Participant reviews newly committed decision-record changes.',
      meta: {
        playbook: {
          stateId: 'reviewDrInitialCommit',
          description:
            'Participant reviews newly committed decision-record changes.',
        },
      },
      invoke: {
        id: 'reviewDrInitialCommitCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewDrInitialCommit',
          player: 'Participant',
          sourceItem: 'DISCUSS-8',
          prompt: DISCUSS_8_PROMPT,
          result: withNeedsBossReply({
            noFindings: 'Participant raised no findings.',
            findingsRaised:
              'Participant raised findings. Output shall include `reviewItems: <findings>`.',
          }),
          latestChanges: context.latestChanges,
          rebuttals: context.rebuttals,
          participantPlayer: context.participantPlayer,
          ...bossReplyFields(context, 'reviewDrInitialCommit'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.reviewDrInitialCommit,
                resumeStateId: 'reviewDrInitialCommit',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'noFindings',
            target: 'commitReviewedChanges',
            actions: ['rememberCaptainResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaised',
            target: 'hostAddressesFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    reviewDrHostChanges: {
      id: 'reviewDrHostChanges',
      tags: 'playbook.busy',
      description:
        'Participant reviews Host changes to decision records after findings.',
      meta: {
        playbook: {
          stateId: 'reviewDrHostChanges',
          description:
            'Participant reviews Host changes to decision records after findings.',
        },
      },
      invoke: {
        id: 'reviewDrHostChangesCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewDrHostChanges',
          player: 'Participant',
          sourceItem: 'DISCUSS-9',
          prompt: DISCUSS_9_PROMPT,
          result: withNeedsBossReply({
            noFindings: 'Participant raised no findings.',
            findingsRaised:
              'Participant raised findings. Output shall include `reviewItems: <findings>`.',
          }),
          latestChanges: context.latestChanges,
          rebuttals: context.rebuttals,
          participantPlayer: context.participantPlayer,
          ...bossReplyFields(context, 'reviewDrHostChanges'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.reviewDrHostChanges,
                resumeStateId: 'reviewDrHostChanges',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'noFindings',
            target: 'commitReviewedChanges',
            actions: ['rememberCaptainResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaised',
            target: 'hostAddressesFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    reviewMixedInitialCommit: {
      id: 'reviewMixedInitialCommit',
      tags: 'playbook.busy',
      description:
        'Participant reviews newly committed mixed spec-item and DR changes.',
      meta: {
        playbook: {
          stateId: 'reviewMixedInitialCommit',
          description:
            'Participant reviews newly committed mixed spec-item and DR changes.',
        },
      },
      invoke: {
        id: 'reviewMixedInitialCommitCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewMixedInitialCommit',
          player: 'Participant',
          sourceItem: 'DISCUSS-10',
          prompt: DISCUSS_10_PROMPT,
          result: withNeedsBossReply({
            noFindings: 'Participant raised no findings.',
            findingsRaised:
              'Participant raised findings. Output shall include `reviewItems: <findings>`.',
          }),
          latestChanges: context.latestChanges,
          rebuttals: context.rebuttals,
          participantPlayer: context.participantPlayer,
          ...bossReplyFields(context, 'reviewMixedInitialCommit'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.reviewMixedInitialCommit,
                resumeStateId: 'reviewMixedInitialCommit',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'noFindings',
            target: 'commitReviewedChanges',
            actions: ['rememberCaptainResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaised',
            target: 'hostAddressesFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    reviewMixedHostChanges: {
      id: 'reviewMixedHostChanges',
      tags: 'playbook.busy',
      description:
        'Participant reviews Host changes to mixed spec items and DRs after findings.',
      meta: {
        playbook: {
          stateId: 'reviewMixedHostChanges',
          description:
            'Participant reviews Host changes to mixed spec items and DRs after findings.',
        },
      },
      invoke: {
        id: 'reviewMixedHostChangesCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'reviewMixedHostChanges',
          player: 'Participant',
          sourceItem: 'DISCUSS-11',
          prompt: DISCUSS_11_PROMPT,
          result: withNeedsBossReply({
            noFindings: 'Participant raised no findings.',
            findingsRaised:
              'Participant raised findings. Output shall include `reviewItems: <findings>`.',
          }),
          latestChanges: context.latestChanges,
          rebuttals: context.rebuttals,
          participantPlayer: context.participantPlayer,
          ...bossReplyFields(context, 'reviewMixedHostChanges'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.reviewMixedHostChanges,
                resumeStateId: 'reviewMixedHostChanges',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'noFindings',
            target: 'commitReviewedChanges',
            actions: ['rememberCaptainResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaised',
            target: 'hostAddressesFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    hostAddressesFindings: {
      id: 'hostAddressesFindings',
      tags: 'playbook.busy',
      description:
        'Host accepts or challenges review findings and stages repo changes.',
      meta: {
        playbook: {
          stateId: 'hostAddressesFindings',
          description:
            'Host accepts or challenges review findings and stages repo changes.',
        },
      },
      invoke: {
        id: 'hostAddressesFindingsCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'hostAddressesFindings',
          player: 'Host',
          sourceItem: 'DISCUSS-12',
          prompt: DISCUSS_12_PROMPT,
          result: withNeedsBossReply({
            changesMade:
              'Host accepted findings and made changes. Output may include `latestChanges: <summary>`.',
            rebuttalsRaised:
              'Host raised rebuttals. Output shall include `rebuttals: <rebuttals>`.',
          }),
          reviewItems: context.reviewItems,
          latestChanges: context.latestChanges,
          hostPlayer: context.hostPlayer,
          ...bossReplyFields(context, 'hostAddressesFindings'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.hostAddressesFindings,
                resumeStateId: 'hostAddressesFindings',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: ({ context, event }) =>
              outputOf(event).guard === 'changesMade' &&
              (outputOf(event).reviewScope ?? context.reviewScope) ===
                'specItems',
            target: reviewTargets.specItems.afterChanges,
            actions: ['rememberHostReviewResponse', 'clearBossReplyContext'],
          },
          {
            guard: ({ context, event }) =>
              outputOf(event).guard === 'changesMade' &&
              (outputOf(event).reviewScope ?? context.reviewScope) ===
                'decisionRecords',
            target: reviewTargets.decisionRecords.afterChanges,
            actions: ['rememberHostReviewResponse', 'clearBossReplyContext'],
          },
          {
            guard: ({ context, event }) =>
              outputOf(event).guard === 'changesMade' &&
              (outputOf(event).reviewScope ?? context.reviewScope) === 'mixed',
            target: reviewTargets.mixed.afterChanges,
            actions: ['rememberHostReviewResponse', 'clearBossReplyContext'],
          },
          {
            guard: 'rebuttalsRaised',
            target: 'participantAddressesRebuttals',
            actions: ['rememberHostReviewResponse', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    participantAddressesRebuttals: {
      id: 'participantAddressesRebuttals',
      tags: 'playbook.busy',
      description: 'Participant accepts or challenges Host rebuttals.',
      meta: {
        playbook: {
          stateId: 'participantAddressesRebuttals',
          description: 'Participant accepts or challenges Host rebuttals.',
        },
      },
      invoke: {
        id: 'participantAddressesRebuttalsCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'participantAddressesRebuttals',
          player: 'Participant',
          sourceItem: 'DISCUSS-13',
          prompt: DISCUSS_13_PROMPT,
          result: withNeedsBossReply({
            rebuttalsAddressed:
              'Participant addressed Host rebuttals. Output may include `rebuttals: <remaining rebuttal context>`.',
          }),
          rebuttals: context.rebuttals,
          participantPlayer: context.participantPlayer,
          ...bossReplyFields(context, 'participantAddressesRebuttals'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.participantAddressesRebuttals,
                resumeStateId: 'participantAddressesRebuttals',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'rebuttalsAddressed',
            target: 'hostAddressesFindings',
            actions: [
              'rememberParticipantRebuttalResponse',
              'clearBossReplyContext',
            ],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    commitReviewedChanges: {
      id: 'commitReviewedChanges',
      tags: 'playbook.busy',
      description:
        'Committer commits reviewed changes once Participant raises no findings.',
      meta: {
        playbook: {
          stateId: 'commitReviewedChanges',
          description:
            'Committer commits reviewed changes once Participant raises no findings.',
        },
      },
      invoke: {
        id: 'commitReviewedChangesCaptain',
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'commitReviewedChanges',
          player: 'Committer',
          sourceItem: 'DISCUSS-15',
          prompt: DISCUSS_15_PROMPT,
          result: withNeedsBossReply({
            committed: 'Committer made the reviewed-changes commit.',
          }),
          latestChanges: context.latestChanges,
          hostLlm: context.hostLlm,
          participantLlm: context.participantLlm,
          committerPlayer: context.committerPlayer,
          ...bossReplyFields(context, 'commitReviewedChanges'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: {
                ...captainStateMetadata.commitReviewedChanges,
                resumeStateId: 'commitReviewedChanges',
                question: '',
              },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'committed',
            target: 'done',
            actions: ['rememberCaptainResult', 'clearBossReplyContext'],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedCaptainOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberCaptainError', 'clearBossReplyContext'],
        },
      },
    },
    awaitBossReply: {
      id: 'awaitBossReply',
      tags: 'playbook.parked',
      description: 'Waiting for Boss to answer a player question.',
      meta: {
        playbook: {
          stateId: 'awaitBossReply',
          description: 'Waiting for Boss to answer a player question.',
        },
      },
      on: {
        BOSS_REPLY: [
          {
            guard: 'emptyBossReply',
            target: 'failed',
            actions: ['rememberMalformedBossReply', 'clearBossReplyContext'],
          },
          ...resumableStates(resumableStateIds),
          {
            target: 'failed',
            actions: ['rememberMalformedBossReply', 'clearBossReplyContext'],
          },
        ],
        BOSS_INTERRUPT: bossInterrupts(
          jumpableStateIds,
          'clearBossReplyContext',
        ),
        START_DISCUSSION: {
          target: 'initialProposalRound',
          actions: ['clearBossReplyContext', 'copyStartDiscussion'],
        },
        START_REVIEW: [
          {
            guard: 'specReview',
            target: reviewTargets.specItems.initial,
            actions: ['clearBossReplyContext', 'copyStartReview'],
          },
          {
            guard: 'drReview',
            target: reviewTargets.decisionRecords.initial,
            actions: ['clearBossReplyContext', 'copyStartReview'],
          },
          {
            guard: 'mixedReview',
            target: reviewTargets.mixed.initial,
            actions: ['clearBossReplyContext', 'copyStartReview'],
          },
        ],
      },
    },
    failed: {
      id: 'failed',
      tags: 'playbook.parked',
      description:
        'The discussion workflow failed and is waiting for Boss recovery.',
      meta: {
        playbook: {
          stateId: 'failed',
          description:
            'The discussion workflow failed and is waiting for Boss recovery.',
        },
      },
      on: {
        START_DISCUSSION: {
          target: 'initialProposalRound',
          actions: 'copyStartDiscussion',
        },
        START_REVIEW: [
          {
            guard: 'specReview',
            target: reviewTargets.specItems.initial,
            actions: 'copyStartReview',
          },
          {
            guard: 'drReview',
            target: reviewTargets.decisionRecords.initial,
            actions: 'copyStartReview',
          },
          {
            guard: 'mixedReview',
            target: reviewTargets.mixed.initial,
            actions: 'copyStartReview',
          },
        ],
      },
    },
    done: {
      id: 'done',
      type: 'final',
      description: 'The discussion workflow completed with a reviewed commit.',
      meta: {
        playbook: {
          stateId: 'done',
          description:
            'The discussion workflow completed with a reviewed commit.',
        },
      },
    },
  },
});

export { bossInterrupts, resumableStates };

export default discussMachine;
