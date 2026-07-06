// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { assign, fromPromise, setup } from 'xstate';

export type Player = 'Host' | 'Participant' | 'Committer';

export type ReviewScope = 'specItems' | 'drs' | 'specItemsAndDrs';

export type SourceItemId =
  | 'DISCUSS-1'
  | 'DISCUSS-2'
  | 'DISCUSS-3'
  | 'DISCUSS-4'
  | 'DISCUSS-5'
  | 'DISCUSS-6'
  | 'DISCUSS-7'
  | 'DISCUSS-8'
  | 'DISCUSS-9'
  | 'DISCUSS-10'
  | 'DISCUSS-11'
  | 'DISCUSS-12'
  | 'DISCUSS-13'
  | 'DISCUSS-14';

export interface PendingBossQuestion {
  resumeStateId: string;
  sourceItem: SourceItemId;
  player: Player;
  question: string;
}

export interface DiscussionContext {
  players: Partial<Record<Player, string>>;
  hostLlm?: string;
  participantLlm?: string;
  topic?: string;
  hostProposal?: string;
  participantProposal?: string;
  hostInitialDiscussionEnded?: boolean;
  participantInitialDiscussionEnded?: boolean;
  reviewScope?: ReviewScope;
  reviewSubject?: string;
  reviewItems?: string;
  rebuttals?: string;
  pendingBossQuestion?: PendingBossQuestion;
  bossReply?: string;
  lastResult?: CaptainOutput;
  lastError?: unknown;
}

export interface DiscussionMachineInput {
  players?: Partial<Record<Player, string>>;
  hostLlm?: string;
  participantLlm?: string;
}

export type DiscussionEvent =
  | { type: 'START_DISCUSSION'; topic: string; hostLlm?: string; participantLlm?: string }
  | {
      type: 'BEGIN_INITIAL_ROUND';
      nextPlayer: 'Host' | 'Participant';
      topic?: string;
      hostProposal?: string;
      participantProposal?: string;
      hostInitialDiscussionEnded?: boolean;
      participantInitialDiscussionEnded?: boolean;
    }
  | { type: 'START_REVIEW'; scope: ReviewScope; reviewSubject?: string }
  | { type: 'BOSS_INTERRUPT'; targetId: string }
  | { type: 'BOSS_REPLY'; answer: string };

export interface CaptainInput {
  player: Player;
  sourceItem: SourceItemId;
  prompt: string;
  result: Record<string, string>;
  topic?: string;
  otherProposal?: string;
  hostProposal?: string;
  participantProposal?: string;
  reviewScope?: ReviewScope;
  reviewSubject?: string;
  reviewItems?: string;
  rebuttals?: string;
  hostLlm?: string;
  participantLlm?: string;
  pendingBossQuestion?: PendingBossQuestion;
  bossReply?: string;
}

export interface CaptainOutput {
  guard: string;
  proposal?: string;
  reviewItems?: string;
  rebuttals?: string;
  question?: string;
  [field: string]: unknown;
}

const NEEDS_BOSS_REPLY_DESCRIPTION =
  "The player's prose surfaces a clarifying question for Boss that the player cannot answer alone. Output shall include `question: <verbatim question text from the player's prose>`.";

const DISCUSS_1_PROMPT = [
  "Assess whether Boss's topic above is better expressed as a few spec items (per @specs/meta.md) or requires one or more DRs added to @specs/decisions/.",
  'Consult @specs/map.md, if necessary, to find relevant context.',
  'Each DR should be coherent and focused.',
  'Propose your design in reply.',
  'DRs, if any, need not include full detail here — describe the key points at a high level.',
  "Don't change any code.",
].join('\n');

const DISCUSS_2_PROMPT = [
  "Consider the other agent's proposal below.",
  '(1) If there are essentially different points (including creation or division of DRs), list them, accept any reasonable ones, and challenge the rest with strong reasoning, solid evidence, and comprehensive thinking — make your argument.',
  "(2) Only if your proposal of the previous round is equivalent to the other's, with nothing to reconcile, state the end of initial discussion.",
  "Don't change any code.",
].join('\n');

const DISCUSS_3_PROMPT = [
  'Update @specs/map.md to reflect your changes (if any) when done.',
].join('\n');

const DISCUSS_4_PROMPT = [
  'For each review item below for the above changes, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
  'Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.',
].join('\n');

const DISCUSS_5_PROMPT = [
  "Assess whether Boss's topic above is better expressed as a few spec items (per @specs/meta.md) or requires one or more DRs added to @specs/decisions/.",
  'Consult @specs/map.md, if necessary, to find relevant context.',
  'Each DR should be coherent and focused.',
  'Propose your design in reply.',
  'DRs, if any, need not include full detail here — describe the key points at a high level.',
  "Don't change any code.",
].join('\n');

const DISCUSS_6_PROMPT = [
  "Consider the other agent's proposal below.",
  '(1) If there are essentially different points (including creation or division of DRs), list them, accept any reasonable ones, and challenge the rest with strong reasoning, solid evidence, and comprehensive thinking — make your argument.',
  "(2) Only if your proposal of the previous round is equivalent to the other's, with nothing to reconcile, state the end of initial discussion.",
  "Don't change any code.",
].join('\n');

const DISCUSS_7_PROMPT = [
  'Verify any new or updated spec items are:',
  '',
  '- Complete & coherent: sufficient for you to reimplement code.',
  '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
  '- Minimal: essential and concise; every item earns its place; also check with other items.',
  '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
  '',
  'Flag anything missing, redundant, over-specified, or under-specified.',
  "Think thoroughly — don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_8_PROMPT = [
  'Review any new/updated decision following @specs/meta.md (reread if necessary).',
  'Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.',
  'Key statements must be backed by references unless they are common sense or widely acknowledged best practices.',
  '',
  "If the decision is well-thought-out and well-written, don't raise nitpicks.",
  'Remember to keep the DR simple and minimal.',
  "Think thoroughly — don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_9_PROMPT = [
  'Verify any new or updated spec items are:',
  '',
  '- Complete & coherent: sufficient for you to reimplement code.',
  '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
  '- Minimal: essential and concise; every item earns its place; also check with other items.',
  '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
  '',
  'Flag anything missing, redundant, over-specified, or under-specified.',
  'Review any new/updated decision following @specs/meta.md (reread if necessary).',
  'Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.',
  'Key statements must be backed by references unless they are common sense or widely acknowledged best practices.',
  '',
  "If the decision is well-thought-out and well-written, don't raise nitpicks.",
  'Remember to keep the DR simple and minimal.',
  "Think thoroughly — don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_10_PROMPT = [
  'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
  'Verify any new or updated spec items are:',
  '',
  '- Complete & coherent: sufficient for you to reimplement code.',
  '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
  '- Minimal: essential and concise; every item earns its place; also check with other items.',
  '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
  '',
  'Flag anything missing, redundant, over-specified, or under-specified.',
  "Think thoroughly — don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_11_PROMPT = [
  'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
  'Review any new/updated decision following @specs/meta.md (reread if necessary).',
  'Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.',
  'Key statements must be backed by references unless they are common sense or widely acknowledged best practices.',
  '',
  "If the decision is well-thought-out and well-written, don't raise nitpicks.",
  'Remember to keep the DR simple and minimal.',
  "Think thoroughly — don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_12_PROMPT = [
  'For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.',
  'Verify any new or updated spec items are:',
  '',
  '- Complete & coherent: sufficient for you to reimplement code.',
  '- Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.',
  '- Minimal: essential and concise; every item earns its place; also check with other items.',
  '- Well organized: spec packages are finely scoped, with high cohesion and low coupling.',
  '',
  'Flag anything missing, redundant, over-specified, or under-specified.',
  'Review any new/updated decision following @specs/meta.md (reread if necessary).',
  'Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.',
  'Key statements must be backed by references unless they are common sense or widely acknowledged best practices.',
  '',
  "If the decision is well-thought-out and well-written, don't raise nitpicks.",
  'Remember to keep the DR simple and minimal.',
  "Think thoroughly — don't just approve or reject.",
  'For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.',
  'Verify @specs/map.md reflects the changes.',
  "If the change is ready to commit or push, don't raise nitpicks.",
  'Do not edit files or commit; report findings only.',
].join('\n');

const DISCUSS_13_PROMPT = [
  'Then make a commit of the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).',
  'Write the commit message concisely.',
  'Host is <host-llm>.',
  'Participant is <participant-llm>.',
  '`<*-llm>` shall be the conventional human form of the substituted ID (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`).',
].join('\n');

const DISCUSS_14_PROMPT = [
  'Then make a commit of the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).',
  'Write the commit message concisely.',
  'Host is <host-llm>.',
  'Participant is <participant-llm>.',
  '`<*-llm>` shall be the conventional human form of the substituted ID (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`).',
].join('\n');

const proposalResult = {
  proposed: 'The player made or revised a proposal. Output may include `proposal: <proposal text>`.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} satisfies Record<string, string>;

const initialRoundResult = {
  proposed:
    'The player identified differences or unresolved points and made a continuing proposal. Output may include `proposal: <proposal text>`.',
  endedInitialDiscussion:
    'The player stated the end of initial discussion because the proposals are equivalent with nothing to reconcile.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} satisfies Record<string, string>;

const mapUpdateResult = {
  updated: 'The player updated specs/map.md to reflect the changes.',
  noChangesNeeded: 'The player determined specs/map.md needed no change.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} satisfies Record<string, string>;

const hostReviewResponseResult = {
  rebuttalsRaised:
    'Host raised rebuttals to be relayed back to Participant. Output shall include `rebuttals: <rebuttal text>`.',
  acceptedOrEdited:
    'Host accepted the review items or made edits without raising rebuttals that require Participant response.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} satisfies Record<string, string>;

const participantReviewResult = {
  noFindings: 'Participant raised no findings on the reviewed changes.',
  findingsRaised:
    'Participant raised review findings. Output shall include `reviewItems: <findings text>`.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} satisfies Record<string, string>;

const commitResult = {
  committed: 'Committer made the requested commit.',
  noCommitNeeded: 'Committer determined there were no repository changes to commit.',
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} satisfies Record<string, string>;

type DiscussionStateId =
  | 'ready'
  | 'askHostForInitialProposal'
  | 'askParticipantForInitialProposal'
  | 'hostInitialRound'
  | 'participantInitialRound'
  | 'updateSpecMap'
  | 'commitInitialChanges'
  | 'participantReviewSpecItems'
  | 'participantReviewDrs'
  | 'participantReviewSpecItemsAndDrs'
  | 'hostRespondToReviewFindings'
  | 'participantRespondToSpecItemRebuttals'
  | 'participantRespondToDrRebuttals'
  | 'participantRespondToMixedRebuttals'
  | 'commitReviewedChanges'
  | 'awaitBossReply'
  | 'failed';

type DiscussionActionName =
  | 'startDiscussion'
  | 'startInitialRound'
  | 'startReview'
  | 'rememberHostProposal'
  | 'rememberParticipantProposal'
  | 'markHostInitialDiscussionEnded'
  | 'markParticipantInitialDiscussionEnded'
  | 'rememberReviewFindings'
  | 'rememberRebuttals'
  | 'rememberResult'
  | 'rememberCaptainError'
  | 'rememberMalformedBossReply'
  | 'setPendingBossQuestion'
  | 'rememberBossReply'
  | 'clearBossReplyContext';

type BossInterruptActionName = 'clearBossReplyContext';

const INTERRUPT_TARGET_IDS = [
  'ready',
  'askHostForInitialProposal',
  'askParticipantForInitialProposal',
  'hostInitialRound',
  'participantInitialRound',
  'updateSpecMap',
  'commitInitialChanges',
  'participantReviewSpecItems',
  'participantReviewDrs',
  'participantReviewSpecItemsAndDrs',
  'hostRespondToReviewFindings',
  'participantRespondToSpecItemRebuttals',
  'participantRespondToDrRebuttals',
  'participantRespondToMixedRebuttals',
  'commitReviewedChanges',
  'awaitBossReply',
  'failed',
] as const satisfies readonly DiscussionStateId[];

const RESUMABLE_STATE_IDS = [
  'askHostForInitialProposal',
  'askParticipantForInitialProposal',
  'hostInitialRound',
  'participantInitialRound',
  'updateSpecMap',
  'commitInitialChanges',
  'participantReviewSpecItems',
  'participantReviewDrs',
  'participantReviewSpecItemsAndDrs',
  'hostRespondToReviewFindings',
  'participantRespondToSpecItemRebuttals',
  'participantRespondToDrRebuttals',
  'participantRespondToMixedRebuttals',
  'commitReviewedChanges',
] as const;

const STATE_META = {
  askHostForInitialProposal: { sourceItem: 'DISCUSS-1', player: 'Host' },
  askParticipantForInitialProposal: { sourceItem: 'DISCUSS-5', player: 'Participant' },
  hostInitialRound: { sourceItem: 'DISCUSS-2', player: 'Host' },
  participantInitialRound: { sourceItem: 'DISCUSS-6', player: 'Participant' },
  updateSpecMap: { sourceItem: 'DISCUSS-3', player: 'Host' },
  commitInitialChanges: { sourceItem: 'DISCUSS-13', player: 'Committer' },
  participantReviewSpecItems: { sourceItem: 'DISCUSS-7', player: 'Participant' },
  participantReviewDrs: { sourceItem: 'DISCUSS-8', player: 'Participant' },
  participantReviewSpecItemsAndDrs: { sourceItem: 'DISCUSS-9', player: 'Participant' },
  hostRespondToReviewFindings: { sourceItem: 'DISCUSS-4', player: 'Host' },
  participantRespondToSpecItemRebuttals: { sourceItem: 'DISCUSS-10', player: 'Participant' },
  participantRespondToDrRebuttals: { sourceItem: 'DISCUSS-11', player: 'Participant' },
  participantRespondToMixedRebuttals: { sourceItem: 'DISCUSS-12', player: 'Participant' },
  commitReviewedChanges: { sourceItem: 'DISCUSS-14', player: 'Committer' },
} as const satisfies Record<
  (typeof RESUMABLE_STATE_IDS)[number],
  { sourceItem: SourceItemId; player: Player }
>;

function outputOf(event: unknown): CaptainOutput {
  return (event as { output: CaptainOutput }).output;
}

function errorOf(event: unknown): unknown {
  return (event as { error?: unknown }).error;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function continuationFields(context: DiscussionContext) {
  return {
    ...(context.pendingBossQuestion ? { pendingBossQuestion: context.pendingBossQuestion } : {}),
    ...(context.bossReply !== undefined ? { bossReply: context.bossReply } : {}),
  };
}

function bossInterrupts(
  ids: readonly string[],
  actions?: BossInterruptActionName | readonly BossInterruptActionName[],
) {
  return ids.map((id) => ({
    guard: ({ event }: { event: DiscussionEvent }) =>
      event.type === 'BOSS_INTERRUPT' && event.targetId === id,
    target: `#${id}`,
    reenter: true as const,
    ...(actions ? { actions } : {}),
  }));
}

function resumableStates(ids: readonly string[]) {
  return ids.map((id) => ({
    guard: ({ context }: { context: DiscussionContext }) =>
      context.pendingBossQuestion?.resumeStateId === id,
    target: `#${id}`,
    reenter: true as const,
    actions: 'rememberBossReply' as const,
  }));
}

const captainPlaceholder = fromPromise<CaptainOutput, CaptainInput>(async () => {
  throw new Error('captain actor must be provided by the runner');
});

const machineSetup = setup({
  types: {} as {
    context: DiscussionContext;
    events: DiscussionEvent;
    input: DiscussionMachineInput;
    actors: {
      captain: typeof captainPlaceholder;
    };
  },
  actors: {
    captain: captainPlaceholder,
  },
  actions: {
    startDiscussion: assign({
      topic: ({ event }) => (event.type === 'START_DISCUSSION' ? event.topic : undefined),
      hostLlm: ({ context, event }) =>
        event.type === 'START_DISCUSSION' ? (event.hostLlm ?? context.hostLlm) : context.hostLlm,
      participantLlm: ({ context, event }) =>
        event.type === 'START_DISCUSSION'
          ? (event.participantLlm ?? context.participantLlm)
          : context.participantLlm,
      hostProposal: undefined,
      participantProposal: undefined,
      hostInitialDiscussionEnded: false,
      participantInitialDiscussionEnded: false,
      reviewScope: undefined,
      reviewSubject: undefined,
      reviewItems: undefined,
      rebuttals: undefined,
      pendingBossQuestion: undefined,
      bossReply: undefined,
      lastResult: undefined,
      lastError: undefined,
    }),
    startInitialRound: assign({
      topic: ({ context, event }) =>
        event.type === 'BEGIN_INITIAL_ROUND' ? (event.topic ?? context.topic) : context.topic,
      hostProposal: ({ context, event }) =>
        event.type === 'BEGIN_INITIAL_ROUND'
          ? (event.hostProposal ?? context.hostProposal)
          : context.hostProposal,
      participantProposal: ({ context, event }) =>
        event.type === 'BEGIN_INITIAL_ROUND'
          ? (event.participantProposal ?? context.participantProposal)
          : context.participantProposal,
      hostInitialDiscussionEnded: ({ context, event }) =>
        event.type === 'BEGIN_INITIAL_ROUND'
          ? (event.hostInitialDiscussionEnded ?? context.hostInitialDiscussionEnded ?? false)
          : context.hostInitialDiscussionEnded,
      participantInitialDiscussionEnded: ({ context, event }) =>
        event.type === 'BEGIN_INITIAL_ROUND'
          ? (event.participantInitialDiscussionEnded ??
              context.participantInitialDiscussionEnded ??
              false)
          : context.participantInitialDiscussionEnded,
      pendingBossQuestion: undefined,
      bossReply: undefined,
      lastResult: undefined,
      lastError: undefined,
    }),
    startReview: assign({
      reviewScope: ({ event }) => (event.type === 'START_REVIEW' ? event.scope : undefined),
      reviewSubject: ({ event }) =>
        event.type === 'START_REVIEW' ? event.reviewSubject : undefined,
      reviewItems: undefined,
      rebuttals: undefined,
      pendingBossQuestion: undefined,
      bossReply: undefined,
      lastResult: undefined,
      lastError: undefined,
    }),
    rememberHostProposal: assign({
      hostProposal: ({ event }) =>
        hasText(outputOf(event).proposal) ? outputOf(event).proposal : undefined,
      hostInitialDiscussionEnded: false,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberParticipantProposal: assign({
      participantProposal: ({ event }) =>
        hasText(outputOf(event).proposal) ? outputOf(event).proposal : undefined,
      participantInitialDiscussionEnded: false,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    markHostInitialDiscussionEnded: assign({
      hostInitialDiscussionEnded: true,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    markParticipantInitialDiscussionEnded: assign({
      participantInitialDiscussionEnded: true,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberReviewFindings: assign({
      reviewItems: ({ event }) =>
        hasText(outputOf(event).reviewItems) ? outputOf(event).reviewItems : undefined,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberRebuttals: assign({
      rebuttals: ({ event }) =>
        hasText(outputOf(event).rebuttals) ? outputOf(event).rebuttals : undefined,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberResult: assign({
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberCaptainError: assign({
      lastError: ({ event }) => errorOf(event),
    }),
    rememberMalformedBossReply: assign({
      lastError: ({ event }) => event,
    }),
    setPendingBossQuestion: assign(
      ({ event }, params: { resumeStateId: keyof typeof STATE_META }) => {
        const meta = STATE_META[params.resumeStateId];
        return {
          pendingBossQuestion: {
            resumeStateId: params.resumeStateId,
            sourceItem: meta.sourceItem,
            player: meta.player,
            question: String(outputOf(event).question ?? ''),
          },
          bossReply: undefined,
          lastResult: outputOf(event),
          lastError: undefined,
        };
      },
    ),
    rememberBossReply: assign({
      bossReply: ({ event }) => (event.type === 'BOSS_REPLY' ? event.answer : undefined),
      lastError: undefined,
    }),
    clearBossReplyContext: assign({
      pendingBossQuestion: undefined,
      bossReply: undefined,
    }),
  },
  guards: {
    beginHostInitialRound: ({ event }) =>
      event.type === 'BEGIN_INITIAL_ROUND' && event.nextPlayer === 'Host',
    beginParticipantInitialRound: ({ event }) =>
      event.type === 'BEGIN_INITIAL_ROUND' && event.nextPlayer === 'Participant',
    reviewSpecItems: ({ event }) =>
      event.type === 'START_REVIEW' && event.scope === 'specItems',
    reviewDrs: ({ event }) => event.type === 'START_REVIEW' && event.scope === 'drs',
    reviewSpecItemsAndDrs: ({ event }) =>
      event.type === 'START_REVIEW' && event.scope === 'specItemsAndDrs',
    needsBossReplyWithQuestion: ({ event }) =>
      outputOf(event).guard === 'needsBossReply' && hasText(outputOf(event).question),
    needsBossReplyWithoutQuestion: ({ event }) => outputOf(event).guard === 'needsBossReply',
    hostProposed: ({ event }) => outputOf(event).guard === 'proposed',
    participantProposed: ({ event }) => outputOf(event).guard === 'proposed',
    hostEndedAndParticipantAlreadyEnded: ({ context, event }) =>
      outputOf(event).guard === 'endedInitialDiscussion' &&
      context.participantInitialDiscussionEnded === true,
    participantEndedAndHostAlreadyEnded: ({ context, event }) =>
      outputOf(event).guard === 'endedInitialDiscussion' &&
      context.hostInitialDiscussionEnded === true,
    hostEnded: ({ event }) => outputOf(event).guard === 'endedInitialDiscussion',
    participantEnded: ({ event }) => outputOf(event).guard === 'endedInitialDiscussion',
    mapUpdated: ({ event }) => outputOf(event).guard === 'updated',
    noMapChangesNeeded: ({ event }) => outputOf(event).guard === 'noChangesNeeded',
    findingsRaisedWithItems: ({ event }) =>
      outputOf(event).guard === 'findingsRaised' && hasText(outputOf(event).reviewItems),
    noFindings: ({ event }) => outputOf(event).guard === 'noFindings',
    rebuttalsRaisedWithText: ({ event }) =>
      outputOf(event).guard === 'rebuttalsRaised' && hasText(outputOf(event).rebuttals),
    specItemRebuttalsRaisedWithText: ({ context, event }) =>
      context.reviewScope === 'specItems' &&
      outputOf(event).guard === 'rebuttalsRaised' &&
      hasText(outputOf(event).rebuttals),
    drRebuttalsRaisedWithText: ({ context, event }) =>
      context.reviewScope === 'drs' &&
      outputOf(event).guard === 'rebuttalsRaised' &&
      hasText(outputOf(event).rebuttals),
    mixedRebuttalsRaisedWithText: ({ context, event }) =>
      context.reviewScope === 'specItemsAndDrs' &&
      outputOf(event).guard === 'rebuttalsRaised' &&
      hasText(outputOf(event).rebuttals),
    acceptedOrEdited: ({ event }) => outputOf(event).guard === 'acceptedOrEdited',
    committed: ({ event }) =>
      outputOf(event).guard === 'committed' || outputOf(event).guard === 'noCommitNeeded',
    emptyBossReply: ({ event }) =>
      event.type === 'BOSS_REPLY' && event.answer.trim().length === 0,
  },
}).createMachine({
  id: 'discuss',
  initial: 'ready',
  context: ({ input }) => ({
    players: input.players ?? {},
    hostLlm: input.hostLlm,
    participantLlm: input.participantLlm,
    hostInitialDiscussionEnded: false,
    participantInitialDiscussionEnded: false,
  }),
  on: {
    BOSS_INTERRUPT: bossInterrupts(INTERRUPT_TARGET_IDS),
  },
  states: {
    ready: {
      id: 'ready',
      description: 'Quiescent idle hub awaiting a Boss entry event.',
      on: {
        START_DISCUSSION: {
          target: 'askHostForInitialProposal',
          actions: 'startDiscussion',
        },
        BEGIN_INITIAL_ROUND: [
          {
            guard: 'beginHostInitialRound',
            target: 'hostInitialRound',
            actions: 'startInitialRound',
          },
          {
            guard: 'beginParticipantInitialRound',
            target: 'participantInitialRound',
            actions: 'startInitialRound',
          },
        ],
        START_REVIEW: [
          {
            guard: 'reviewSpecItems',
            target: 'participantReviewSpecItems',
            actions: 'startReview',
          },
          {
            guard: 'reviewDrs',
            target: 'participantReviewDrs',
            actions: 'startReview',
          },
          {
            guard: 'reviewSpecItemsAndDrs',
            target: 'participantReviewSpecItemsAndDrs',
            actions: 'startReview',
          },
        ],
      },
    },

    askHostForInitialProposal: {
      id: 'askHostForInitialProposal',
      description: 'Host proposes how to express Boss topic as specs or DRs.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Host',
          sourceItem: 'DISCUSS-1',
          prompt: DISCUSS_1_PROMPT,
          result: proposalResult,
          topic: context.topic,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'askHostForInitialProposal' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'hostProposed',
            target: '#askParticipantForInitialProposal',
            actions: ['rememberHostProposal', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    askParticipantForInitialProposal: {
      id: 'askParticipantForInitialProposal',
      description: 'Participant proposes how to express Boss topic as specs or DRs.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Participant',
          sourceItem: 'DISCUSS-5',
          prompt: DISCUSS_5_PROMPT,
          result: proposalResult,
          topic: context.topic,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'askParticipantForInitialProposal' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'participantProposed',
            target: '#hostInitialRound',
            actions: ['rememberParticipantProposal', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    hostInitialRound: {
      id: 'hostInitialRound',
      description: 'Host reconciles against Participant proposal in an initial-discussion round.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Host',
          sourceItem: 'DISCUSS-2',
          prompt: DISCUSS_2_PROMPT,
          result: initialRoundResult,
          topic: context.topic,
          otherProposal: context.participantProposal,
          hostProposal: context.hostProposal,
          participantProposal: context.participantProposal,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'hostInitialRound' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'hostEndedAndParticipantAlreadyEnded',
            target: '#updateSpecMap',
            actions: ['markHostInitialDiscussionEnded', 'clearBossReplyContext'],
          },
          {
            guard: 'hostEnded',
            target: '#participantInitialRound',
            actions: ['markHostInitialDiscussionEnded', 'clearBossReplyContext'],
          },
          {
            guard: 'hostProposed',
            target: '#participantInitialRound',
            actions: ['rememberHostProposal', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    participantInitialRound: {
      id: 'participantInitialRound',
      description: 'Participant reconciles against Host proposal in an initial-discussion round.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Participant',
          sourceItem: 'DISCUSS-6',
          prompt: DISCUSS_6_PROMPT,
          result: initialRoundResult,
          topic: context.topic,
          otherProposal: context.hostProposal,
          hostProposal: context.hostProposal,
          participantProposal: context.participantProposal,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'participantInitialRound' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'participantEndedAndHostAlreadyEnded',
            target: '#updateSpecMap',
            actions: ['markParticipantInitialDiscussionEnded', 'clearBossReplyContext'],
          },
          {
            guard: 'participantEnded',
            target: '#hostInitialRound',
            actions: ['markParticipantInitialDiscussionEnded', 'clearBossReplyContext'],
          },
          {
            guard: 'participantProposed',
            target: '#hostInitialRound',
            actions: ['rememberParticipantProposal', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    updateSpecMap: {
      id: 'updateSpecMap',
      description: 'Host updates specs/map.md after initial discussion ends.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Host',
          sourceItem: 'DISCUSS-3',
          prompt: DISCUSS_3_PROMPT,
          result: mapUpdateResult,
          topic: context.topic,
          hostProposal: context.hostProposal,
          participantProposal: context.participantProposal,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'updateSpecMap' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'mapUpdated',
            target: '#commitInitialChanges',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'noMapChangesNeeded',
            target: '#done',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    commitInitialChanges: {
      id: 'commitInitialChanges',
      description: 'Committer commits changes written at the end of initial discussion.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Committer',
          sourceItem: 'DISCUSS-13',
          prompt: DISCUSS_13_PROMPT,
          result: commitResult,
          hostLlm: context.hostLlm,
          participantLlm: context.participantLlm,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'commitInitialChanges' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'committed',
            target: '#done',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    participantReviewSpecItems: {
      id: 'participantReviewSpecItems',
      description: 'Participant reviews new or updated spec items.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Participant',
          sourceItem: 'DISCUSS-7',
          prompt: DISCUSS_7_PROMPT,
          result: participantReviewResult,
          reviewScope: context.reviewScope,
          reviewSubject: context.reviewSubject,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'participantReviewSpecItems' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaisedWithItems',
            target: '#hostRespondToReviewFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            guard: 'noFindings',
            target: '#commitReviewedChanges',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    participantReviewDrs: {
      id: 'participantReviewDrs',
      description: 'Participant reviews new or updated DRs.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Participant',
          sourceItem: 'DISCUSS-8',
          prompt: DISCUSS_8_PROMPT,
          result: participantReviewResult,
          reviewScope: context.reviewScope,
          reviewSubject: context.reviewSubject,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'participantReviewDrs' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaisedWithItems',
            target: '#hostRespondToReviewFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            guard: 'noFindings',
            target: '#commitReviewedChanges',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    participantReviewSpecItemsAndDrs: {
      id: 'participantReviewSpecItemsAndDrs',
      description: 'Participant reviews both spec items and DRs.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Participant',
          sourceItem: 'DISCUSS-9',
          prompt: DISCUSS_9_PROMPT,
          result: participantReviewResult,
          reviewScope: context.reviewScope,
          reviewSubject: context.reviewSubject,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'participantReviewSpecItemsAndDrs' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaisedWithItems',
            target: '#hostRespondToReviewFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            guard: 'noFindings',
            target: '#commitReviewedChanges',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    hostRespondToReviewFindings: {
      id: 'hostRespondToReviewFindings',
      description: 'Host challenges or accepts Participant review findings.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Host',
          sourceItem: 'DISCUSS-4',
          prompt: DISCUSS_4_PROMPT,
          result: hostReviewResponseResult,
          reviewScope: context.reviewScope,
          reviewSubject: context.reviewSubject,
          reviewItems: context.reviewItems,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'hostRespondToReviewFindings' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'specItemRebuttalsRaisedWithText',
            target: '#participantRespondToSpecItemRebuttals',
            actions: ['rememberRebuttals', 'clearBossReplyContext'],
          },
          {
            guard: 'drRebuttalsRaisedWithText',
            target: '#participantRespondToDrRebuttals',
            actions: ['rememberRebuttals', 'clearBossReplyContext'],
          },
          {
            guard: 'mixedRebuttalsRaisedWithText',
            target: '#participantRespondToMixedRebuttals',
            actions: ['rememberRebuttals', 'clearBossReplyContext'],
          },
          {
            guard: 'acceptedOrEdited',
            target: '#ready',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    participantRespondToSpecItemRebuttals: {
      id: 'participantRespondToSpecItemRebuttals',
      description: 'Participant responds to Host rebuttals on spec item review.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Participant',
          sourceItem: 'DISCUSS-10',
          prompt: DISCUSS_10_PROMPT,
          result: participantReviewResult,
          reviewScope: context.reviewScope,
          reviewSubject: context.reviewSubject,
          reviewItems: context.reviewItems,
          rebuttals: context.rebuttals,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'participantRespondToSpecItemRebuttals' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaisedWithItems',
            target: '#hostRespondToReviewFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            guard: 'noFindings',
            target: '#commitReviewedChanges',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    participantRespondToDrRebuttals: {
      id: 'participantRespondToDrRebuttals',
      description: 'Participant responds to Host rebuttals on DR review.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Participant',
          sourceItem: 'DISCUSS-11',
          prompt: DISCUSS_11_PROMPT,
          result: participantReviewResult,
          reviewScope: context.reviewScope,
          reviewSubject: context.reviewSubject,
          reviewItems: context.reviewItems,
          rebuttals: context.rebuttals,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'participantRespondToDrRebuttals' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaisedWithItems',
            target: '#hostRespondToReviewFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            guard: 'noFindings',
            target: '#commitReviewedChanges',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    participantRespondToMixedRebuttals: {
      id: 'participantRespondToMixedRebuttals',
      description: 'Participant responds to Host rebuttals on mixed spec and DR review.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Participant',
          sourceItem: 'DISCUSS-12',
          prompt: DISCUSS_12_PROMPT,
          result: participantReviewResult,
          reviewScope: context.reviewScope,
          reviewSubject: context.reviewSubject,
          reviewItems: context.reviewItems,
          rebuttals: context.rebuttals,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'participantRespondToMixedRebuttals' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'findingsRaisedWithItems',
            target: '#hostRespondToReviewFindings',
            actions: ['rememberReviewFindings', 'clearBossReplyContext'],
          },
          {
            guard: 'noFindings',
            target: '#commitReviewedChanges',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    commitReviewedChanges: {
      id: 'commitReviewedChanges',
      description: 'Committer commits reviewed changes when Participant raises no findings.',
      invoke: {
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          player: 'Committer',
          sourceItem: 'DISCUSS-14',
          prompt: DISCUSS_14_PROMPT,
          result: commitResult,
          hostLlm: context.hostLlm,
          participantLlm: context.participantLlm,
          ...continuationFields(context),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: '#awaitBossReply',
            actions: {
              type: 'setPendingBossQuestion',
              params: { resumeStateId: 'commitReviewedChanges' },
            },
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: '#failed',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          {
            guard: 'committed',
            target: '#done',
            actions: ['rememberResult', 'clearBossReplyContext'],
          },
          { target: '#failed', actions: ['rememberResult', 'clearBossReplyContext'] },
        ],
        onError: { target: '#failed', actions: ['rememberCaptainError', 'clearBossReplyContext'] },
      },
    },

    awaitBossReply: {
      id: 'awaitBossReply',
      description: 'Waiting for Boss to answer a player question.',
      on: {
        BOSS_REPLY: [
          {
            guard: 'emptyBossReply',
            target: '#failed',
            actions: ['rememberMalformedBossReply', 'clearBossReplyContext'],
          },
          ...resumableStates(RESUMABLE_STATE_IDS),
          {
            target: '#failed',
            actions: ['rememberMalformedBossReply', 'clearBossReplyContext'],
          },
        ],
        START_DISCUSSION: {
          target: '#askHostForInitialProposal',
          actions: ['clearBossReplyContext', 'startDiscussion'],
        },
        BEGIN_INITIAL_ROUND: [
          {
            guard: 'beginHostInitialRound',
            target: '#hostInitialRound',
            actions: ['clearBossReplyContext', 'startInitialRound'],
          },
          {
            guard: 'beginParticipantInitialRound',
            target: '#participantInitialRound',
            actions: ['clearBossReplyContext', 'startInitialRound'],
          },
        ],
        START_REVIEW: [
          {
            guard: 'reviewSpecItems',
            target: '#participantReviewSpecItems',
            actions: ['clearBossReplyContext', 'startReview'],
          },
          {
            guard: 'reviewDrs',
            target: '#participantReviewDrs',
            actions: ['clearBossReplyContext', 'startReview'],
          },
          {
            guard: 'reviewSpecItemsAndDrs',
            target: '#participantReviewSpecItemsAndDrs',
            actions: ['clearBossReplyContext', 'startReview'],
          },
        ],
        BOSS_INTERRUPT: bossInterrupts(INTERRUPT_TARGET_IDS, 'clearBossReplyContext'),
      },
    },

    failed: {
      id: 'failed',
      description: 'Recoverable failure hub awaiting Boss recovery.',
      on: {
        START_DISCUSSION: {
          target: '#askHostForInitialProposal',
          actions: 'startDiscussion',
        },
        BEGIN_INITIAL_ROUND: [
          {
            guard: 'beginHostInitialRound',
            target: '#hostInitialRound',
            actions: 'startInitialRound',
          },
          {
            guard: 'beginParticipantInitialRound',
            target: '#participantInitialRound',
            actions: 'startInitialRound',
          },
        ],
        START_REVIEW: [
          {
            guard: 'reviewSpecItems',
            target: '#participantReviewSpecItems',
            actions: 'startReview',
          },
          {
            guard: 'reviewDrs',
            target: '#participantReviewDrs',
            actions: 'startReview',
          },
          {
            guard: 'reviewSpecItemsAndDrs',
            target: '#participantReviewSpecItemsAndDrs',
            actions: 'startReview',
          },
        ],
      },
    },

    done: {
      id: 'done',
      description: 'The discussion workflow completed.',
      type: 'final',
    },
  },
});

export { bossInterrupts, resumableStates };
export const discussMachine = machineSetup;
export default discussMachine;
