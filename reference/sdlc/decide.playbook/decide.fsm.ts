// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// FSM object artifact compiled from decide.gears.md.
// This module defines only the machine, actor contracts, and typed inputs.
// The linked runtime supplies the player and nested-playbook actors.

import { assign, fromPromise, setup } from 'xstate';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type Role = 'coder' | 'reviewer';

export const concurrentRoleSets = [['coder', 'reviewer']] as const;

type JumpableStateId = 'independentProposals';

type ResumableStateId =
  | 'askCoderProposal'
  | 'askReviewerProposal'
  | 'commitCoderProposal';

export interface PendingBossQuestion {
  questionId: ResumableStateId;
  resumeStateId: ResumableStateId;
  sourceItem: string;
  asker: { kind: 'role'; roleId: Role };
  question: string;
}

type PendingBossQuestions = Partial<
  Record<ResumableStateId, PendingBossQuestion>
>;

type BossReplies = Partial<Record<ResumableStateId, string>>;

type PendingBossQuestionParams = Omit<PendingBossQuestion, 'questionId'>;

export interface ReviewSuccessOutput {
  approvedCommit: 'latest';
  noUnsettledFindings: true;
}

export interface DecideFailureOutput {
  lastDecideCommit: string;
  noUnsettledFindings: false;
  reviewStatus: 'aborted' | 'error';
  error?: {
    name: string;
    message: string;
  };
}

export type DecideOutput = ReviewSuccessOutput | DecideFailureOutput;

interface ChildFailure {
  status: 'aborted' | 'error';
  playbookId: 'review';
  error?: {
    name: string;
    message: string;
  };
}

export interface DecideContext {
  callerTopic?: string;
  coderProposal?: string;
  reviewerProposal?: string;
  latestCommit?: string;
  reviewResult?: ReviewSuccessOutput;
  reviewFailure?: ChildFailure;
  lastResult?: PlayerOutput;
  lastError?: unknown;
  pendingBossQuestions?: PendingBossQuestions;
  bossReplies?: BossReplies;
  stagedCoderResult?: PlayerOutput;
  stagedReviewerResult?: PlayerOutput;
}

export type DecideEvent =
  | { type: 'START_DECIDE'; callerTopic: string }
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

export type DecideInput = Readonly<Record<string, never>>;

export interface PlayerInput {
  stateId: ResumableStateId;
  sourceItem: string;
  prompt: string;
  result: Record<string, string>;
  role: Role;
  callerTopic?: string;
  pendingBossQuestion?: PendingBossQuestion;
  bossReply?: string;
}

type AdditionalPlayerFields = {
  coderProposal?: string;
  reviewerProposal?: string;
  coderOutput?: string;
  latestCommit?: string;
  question?: string;
  readonly [key: string]: unknown;
};

export type PlayerOutput =
  | ({ guard: 'proposed'; coderProposal: string } & AdditionalPlayerFields)
  | ({ guard: 'proposed'; reviewerProposal: string } & AdditionalPlayerFields)
  | ({ guard: 'committed'; coderOutput: string; latestCommit: string } &
      AdditionalPlayerFields)
  | ({ guard: 'needsBossReply'; question: string } & AdditionalPlayerFields);

export interface PlaybookInput {
  stateId: 'reviewCommit';
  sourceItem: 'DECIDE-4';
  playbookId: 'review';
  text: string;
}

type PlayerDoneEvent = { type: string; output: PlayerOutput };
type ActorErrorEvent = { type: string; error: unknown };
type PlaybookDoneEvent = { type: string; output: JsonValue | undefined };

const NEEDS_BOSS_REPLY_DESCRIPTION =
  "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

const INDEPENDENT_PROPOSAL_PROMPT = [
  '> <caller-topic>',
  '',
  'Assess whether the topic is better expressed as a few spec items under @specs/packages/ or requires one or more DRs under @specs/decisions/.',
  'Propose your design.',
  'Keep your proposal coherent, focused, and concise.',
  'Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.',
  'Do not change any files.',
].join('\n');

const COMMIT_CODER_PROMPT = [
  'Turn your proposal into the necessary spec items or DRs.',
  'Follow @specs/meta.md and update @specs/map.md when needed.',
  "Do not inspect or incorporate Reviewer's proposal before this commit.",
  'Do not change code or implement the proposal.',
  '',
  'Commit the result as one new commit, following @specs/packages/git.md.',
  'Make the commit message explain concisely what changed and why.',
  'Coder is <coder-llm>; format the model token in conventional human form.',
].join('\n');

const REVIEW_INPUT_TEMPLATE = [
  'Review the latest commit as a spec-design change against the initial intent.',
  'Compare it with your independent proposal and take the best of both.',
  'Make your suggestions.',
  '',
  'Initial intent: <caller-topic>.',
  "Coder's independent proposal: <coder-proposal>.",
].join('\n');

function composeReviewInput(
  callerTopic: string | undefined,
  coderProposal: string | undefined,
): string {
  const fields: Readonly<Record<string, string>> = {
    '<caller-topic>': callerTopic ?? '',
    '<coder-proposal>': coderProposal ?? '',
  };
  return REVIEW_INPUT_TEMPLATE.replace(
    /<caller-topic>|<coder-proposal>/g,
    (placeholder) => fields[placeholder],
  );
}

const outputOf = (event: unknown): PlayerOutput =>
  (event as PlayerDoneEvent).output;

const playbookOutputOf = (event: unknown): JsonValue | undefined =>
  (event as PlaybookDoneEvent).output;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const coderProposed = ({ event }: { event: unknown }) => {
  const output = outputOf(event);
  return output.guard === 'proposed' && isNonEmptyString(output.coderProposal);
};

const reviewerProposed = ({ event }: { event: unknown }) => {
  const output = outputOf(event);
  return (
    output.guard === 'proposed' && isNonEmptyString(output.reviewerProposal)
  );
};

function commitOutput(
  event: unknown,
): { readonly coderOutput: string; readonly latestCommit: string } | undefined {
  const output = outputOf(event);
  if (
    output.guard !== 'committed' ||
    !isNonEmptyString(output.coderOutput) ||
    !isNonEmptyString(output.latestCommit)
  ) {
    return undefined;
  }
  return {
    coderOutput: output.coderOutput,
    latestCommit: output.latestCommit,
  };
}

const committed = ({ event }: { event: unknown }) =>
  commitOutput(event) !== undefined;

const needsBossReplyWithQuestion = ({ event }: { event: unknown }) => {
  const output = outputOf(event);
  return output.guard === 'needsBossReply' && isNonEmptyString(output.question);
};

const needsBossReplyWithoutQuestion = ({ event }: { event: unknown }) => {
  const output = outputOf(event);
  return (
    output.guard === 'needsBossReply' && !isNonEmptyString(output.question)
  );
};

const pendingQuestionIds = (context: DecideContext): ResumableStateId[] =>
  Object.keys(context.pendingBossQuestions ?? {}) as ResumableStateId[];

const resolvedQuestionId = (
  context: DecideContext,
  event: DecideEvent,
): ResumableStateId | undefined => {
  if (event.type !== 'BOSS_REPLY') return undefined;
  if (event.questionId) return event.questionId;
  const ids = pendingQuestionIds(context);
  return ids.length === 1 ? ids[0] : undefined;
};

const bossReplyTargets =
  (stateId: ResumableStateId, requireAnswer: boolean) =>
  ({ context, event }: { context: DecideContext; event: DecideEvent }) =>
    event.type === 'BOSS_REPLY' &&
    resolvedQuestionId(context, event) === stateId &&
    (requireAnswer
      ? event.answer.trim().length > 0
      : event.answer.trim().length === 0);

const bossReplyFields = (
  context: DecideContext,
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

const withNeedsBossReply = <T extends Record<string, string>>(result: T) => ({
  ...result,
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const isExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
  );
};

function isStateValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value === 'string') return true;
  if (!isPlainRecord(value) || ancestors.has(value)) return false;
  const next = new Set(ancestors).add(value);
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      Object.prototype.propertyIsEnumerable.call(value, key) &&
      isStateValue(value[key], next),
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Reflect.ownKeys(value).every((key) => {
      if (key === 'length') return true;
      return (
        typeof key === 'string' &&
        /^(0|[1-9][0-9]*)$/.test(key) &&
        Number(key) < value.length
      );
    }) &&
    value.every((entry) => isNonEmptyString(entry)) &&
    new Set(value).size === value.length
  );
}

function isPlaybookState(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set([
    'value',
    'activeStateIds',
    'tags',
    'status',
    'quiescent',
    'stateId',
  ]);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowed.has(key),
    ) ||
    !Object.prototype.hasOwnProperty.call(value, 'value') ||
    !Object.prototype.hasOwnProperty.call(value, 'activeStateIds') ||
    !Object.prototype.hasOwnProperty.call(value, 'tags') ||
    !Object.prototype.hasOwnProperty.call(value, 'status') ||
    !Object.prototype.hasOwnProperty.call(value, 'quiescent')
  ) {
    return false;
  }
  return (
    isStateValue(value.value) &&
    isStringArray(value.activeStateIds) &&
    isStringArray(value.tags) &&
    (value.status === 'active' ||
      value.status === 'done' ||
      value.status === 'error' ||
      value.status === 'stopped') &&
    typeof value.quiescent === 'boolean' &&
    (!Object.prototype.hasOwnProperty.call(value, 'stateId') ||
      (isNonEmptyString(value.stateId) &&
        value.activeStateIds.length === 1 &&
        value.activeStateIds[0] === value.stateId))
  );
}

function reviewSuccessFrom(event: unknown): ReviewSuccessOutput | undefined {
  const output = playbookOutputOf(event);
  if (!isPlainRecord(output)) return undefined;
  if (!isExactKeys(output, ['approvedCommit', 'noUnsettledFindings'])) {
    return undefined;
  }
  if (
    output.approvedCommit !== 'latest' ||
    output.noUnsettledFindings !== true
  ) {
    return undefined;
  }
  return {
    approvedCommit: 'latest',
    noUnsettledFindings: true,
  };
}

const validReviewSuccess = ({ event }: { event: unknown }) =>
  reviewSuccessFrom(event) !== undefined;

function normalizedChildFailure(error: unknown): ChildFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const result = (error as Error & { result?: unknown }).result;
  if (!isPlainRecord(result)) return undefined;
  const allowed = new Set([
    'status',
    'playbookId',
    'childSessionId',
    'state',
    'error',
  ]);
  if (
    Reflect.ownKeys(result).some(
      (key) => typeof key !== 'string' || !allowed.has(key),
    ) ||
    (result.status !== 'aborted' && result.status !== 'error') ||
    result.playbookId !== 'review' ||
    Object.prototype.hasOwnProperty.call(result, 'output')
  ) {
    return undefined;
  }
  if (
    Object.prototype.hasOwnProperty.call(result, 'childSessionId') &&
    !isNonEmptyString(result.childSessionId)
  ) {
    return undefined;
  }
  if (
    Object.prototype.hasOwnProperty.call(result, 'state') &&
    !isPlaybookState(result.state)
  ) {
    return undefined;
  }
  let normalizedError: ChildFailure['error'];
  if (Object.prototype.hasOwnProperty.call(result, 'error')) {
    if (!isPlainRecord(result.error)) return undefined;
    const errorKeys = Reflect.ownKeys(result.error);
    if (
      errorKeys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'name' && key !== 'message' && key !== 'stack'),
      ) ||
      !Object.prototype.hasOwnProperty.call(result.error, 'name') ||
      !Object.prototype.hasOwnProperty.call(result.error, 'message')
    ) {
      return undefined;
    }
    if (
      !isNonEmptyString(result.error.name) ||
      typeof result.error.message !== 'string' ||
      (Object.prototype.hasOwnProperty.call(result.error, 'stack') &&
        typeof result.error.stack !== 'string')
    ) {
      return undefined;
    }
    normalizedError = {
      name: result.error.name,
      message: result.error.message,
    };
  } else if (result.status === 'error') {
    return undefined;
  }
  return {
    status: result.status,
    playbookId: 'review',
    ...(normalizedError ? { error: normalizedError } : {}),
  };
}

const authoredReviewFailure = ({ event }: { event: unknown }) =>
  normalizedChildFailure((event as ActorErrorEvent).error) !== undefined;

function bossInterrupts(ids: readonly JumpableStateId[]): any[] {
  return ids.map((id) => ({
    guard: ({ event }: { event: DecideEvent }) =>
      event.type === 'BOSS_INTERRUPT' &&
      event.targetId === id &&
      typeof event.bossIntent === 'string' &&
      event.bossIntent.trim().length > 0,
    target: `#${id}`,
    reenter: true,
    actions: 'copyInterruptedTopic',
  }));
}

function resumableStates(ids: readonly ResumableStateId[]): any[] {
  return ids.map((id) => ({
    guard: ({ context, event }: { context: DecideContext; event: DecideEvent }) =>
      event.type === 'BOSS_REPLY' &&
      event.answer.trim().length > 0 &&
      resolvedQuestionId(context, event) === id,
    target: `#${id}`,
    reenter: true,
    actions: 'rememberBossReply',
  }));
}

const stateMetadata: Record<
  ResumableStateId,
  { sourceItem: string; asker: { kind: 'role'; roleId: Role } }
> = {
  askCoderProposal: {
    sourceItem: 'DECIDE-1',
    asker: { kind: 'role', roleId: 'coder' },
  },
  askReviewerProposal: {
    sourceItem: 'DECIDE-2',
    asker: { kind: 'role', roleId: 'reviewer' },
  },
  commitCoderProposal: {
    sourceItem: 'DECIDE-3',
    asker: { kind: 'role', roleId: 'coder' },
  },
};

export const decideMachine = setup({
  types: {
    context: {} as DecideContext,
    events: {} as DecideEvent,
    input: {} as DecideInput,
    output: {} as DecideOutput,
  },
  actors: {
    player: fromPromise<PlayerOutput, PlayerInput>(async () => {
      throw new Error('player actor must be provided by the runner');
    }),
    playbook: fromPromise<JsonValue | undefined, PlaybookInput>(async () => {
      throw new Error('playbook actor must be provided by the runner');
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
    copyStartTopic: assign({
      callerTopic: ({ event }) =>
        event.type === 'START_DECIDE' ? event.callerTopic : undefined,
      coderProposal: undefined,
      reviewerProposal: undefined,
      latestCommit: undefined,
      reviewResult: undefined,
      reviewFailure: undefined,
      lastResult: undefined,
      lastError: undefined,
      pendingBossQuestions: undefined,
      bossReplies: undefined,
      stagedCoderResult: undefined,
      stagedReviewerResult: undefined,
    }),
    copyInterruptedTopic: assign({
      callerTopic: ({ event }) =>
        event.type === 'BOSS_INTERRUPT' ? event.bossIntent : undefined,
      coderProposal: undefined,
      reviewerProposal: undefined,
      latestCommit: undefined,
      reviewResult: undefined,
      reviewFailure: undefined,
      lastResult: undefined,
      lastError: undefined,
      pendingBossQuestions: undefined,
      bossReplies: undefined,
      stagedCoderResult: undefined,
      stagedReviewerResult: undefined,
    }),
    stageCoderProposal: assign({
      stagedCoderResult: ({ event }) => outputOf(event),
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    stageReviewerProposal: assign({
      stagedReviewerResult: ({ event }) => outputOf(event),
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    promoteProposals: assign({
      coderProposal: ({ context }) =>
        context.stagedCoderResult?.coderProposal,
      reviewerProposal: ({ context }) =>
        context.stagedReviewerResult?.reviewerProposal,
      stagedCoderResult: undefined,
      stagedReviewerResult: undefined,
      lastResult: undefined,
      lastError: undefined,
    }),
    rememberCommit: assign({
      latestCommit: ({ event }) => outputOf(event).latestCommit,
      lastResult: ({ event }) => outputOf(event),
      lastError: undefined,
    }),
    rememberReviewSuccess: assign({
      reviewResult: ({ event }) => reviewSuccessFrom(event),
      reviewFailure: undefined,
      lastError: undefined,
    }),
    rememberReviewFailure: assign({
      reviewFailure: ({ event }) =>
        normalizedChildFailure((event as unknown as ActorErrorEvent).error),
      lastError: undefined,
    }),
    rememberReviewProtocolFailure: assign({
      reviewFailure: {
        status: 'error',
        playbookId: 'review',
        error: {
          name: 'ReviewProtocolError',
          message:
            'REVIEW returned without an approved latest commit and a no-findings result.',
        },
      },
      lastError: undefined,
    }),
    rememberActorError: assign({
      lastError: ({ event }) =>
        (event as unknown as ActorErrorEvent).error,
    }),
    rememberMalformedActorOutput: assign({
      lastError: ({ event }) =>
        (event as unknown as PlayerDoneEvent | PlaybookDoneEvent).output,
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
    clearProposalRoundContext: assign({
      pendingBossQuestions: undefined,
      bossReplies: undefined,
      stagedCoderResult: undefined,
      stagedReviewerResult: undefined,
    }),
    clearBossReplyContext: assign({
      pendingBossQuestions: undefined,
      bossReplies: undefined,
    }),
  },
  guards: {
    coderProposed,
    reviewerProposed,
    committed,
    needsBossReplyWithQuestion,
    needsBossReplyWithoutQuestion,
    validReviewSuccess,
    authoredReviewFailure,
  },
}).createMachine({
  id: 'decide',
  initial: 'ready',
  context: (): DecideContext => ({}),
  output: ({ context }): DecideOutput => {
    if (context.reviewResult) return context.reviewResult;
    if (!context.latestCommit || !context.reviewFailure) {
      throw new Error('DECIDE reached a final state without a result');
    }
    return {
      lastDecideCommit: context.latestCommit,
      noUnsettledFindings: false,
      reviewStatus: context.reviewFailure.status,
      ...(context.reviewFailure.error
        ? { error: context.reviewFailure.error }
        : {}),
    };
  },
  on: {
    BOSS_INTERRUPT: bossInterrupts(['independentProposals']),
  },
  states: {
    ready: {
      id: 'ready',
      tags: 'playbook.parked',
      description: 'Waiting for a topic to decide.',
      meta: {
        playbook: {
          stateId: 'ready',
          description: 'Waiting for a topic to decide.',
        },
      },
      on: {
        START_DECIDE: {
          guard: ({ event }) => event.callerTopic.trim().length > 0,
          target: 'independentProposals',
          actions: 'copyStartTopic',
        },
      },
    },
    independentProposals: {
      id: 'independentProposals',
      type: 'parallel',
      description: 'Coder and Reviewer prepare independent proposals.',
      meta: {
        playbook: {
          stateId: 'independentProposals',
          description: 'Coder and Reviewer prepare independent proposals.',
        },
      },
      states: {
        coder: {
          initial: 'working',
          states: {
            working: {
              id: 'askCoderProposal',
              tags: 'playbook.busy',
              description: 'Coder independently proposes a spec design.',
              meta: {
                playbook: {
                  stateId: 'askCoderProposal',
                  description: 'Coder independently proposes a spec design.',
                  role: 'coder',
                },
              },
              invoke: {
                src: 'player',
                input: ({ context }): PlayerInput => ({
                  stateId: 'askCoderProposal',
                  sourceItem: 'DECIDE-1',
                  role: 'coder',
                  prompt: INDEPENDENT_PROPOSAL_PROMPT,
                  result: withNeedsBossReply({
                    proposed:
                      'Coder completed an independent proposal. Output shall include `coderProposal: <verbatim final text>`.',
                  }),
                  callerTopic: context.callerTopic,
                  ...bossReplyFields(context, 'askCoderProposal'),
                }),
                onDone: [
                  {
                    guard: 'needsBossReplyWithQuestion',
                    target: 'waiting',
                    actions: [
                      {
                        type: 'playbook.acceptedOutcome',
                        params: {
                          source: 'askCoderProposal',
                          target: 'waitCoderProposalReply',
                          acceptedOutcome: 'needsBossReply',
                        },
                      },
                      {
                        type: 'setPendingBossQuestion',
                        params: {
                          ...stateMetadata.askCoderProposal,
                          resumeStateId: 'askCoderProposal',
                          question: '',
                        },
                      },
                    ],
                  },
                  {
                    guard: 'needsBossReplyWithoutQuestion',
                    target: '#failed',
                    actions: [
                      'rememberMalformedActorOutput',
                      'clearProposalRoundContext',
                    ],
                  },
                  {
                    guard: 'coderProposed',
                    target: 'complete',
                    actions: [
                      {
                        type: 'playbook.acceptedOutcome',
                        params: ({ context }) => ({
                          source: 'askCoderProposal',
                          target:
                            context.stagedReviewerResult === undefined
                              ? 'coderProposalComplete'
                              : 'commitCoderProposal',
                          acceptedOutcome: 'proposed',
                        }),
                      },
                      'stageCoderProposal',
                      {
                        type: 'clearBranchBossReplyContext',
                        params: { stateId: 'askCoderProposal' },
                      },
                    ],
                  },
                  {
                    target: '#failed',
                    actions: [
                      'rememberMalformedActorOutput',
                      'clearProposalRoundContext',
                    ],
                  },
                ],
                onError: {
                  target: '#failed',
                  actions: [
                    'rememberActorError',
                    'clearProposalRoundContext',
                  ],
                },
              },
            },
            waiting: {
              id: 'waitCoderProposalReply',
              tags: 'playbook.parked',
              description: 'Coder waits for Boss to answer a question.',
              meta: {
                playbook: {
                  stateId: 'waitCoderProposalReply',
                  description: 'Coder waits for Boss to answer a question.',
                },
              },
              on: {
                BOSS_REPLY: [
                  {
                    guard: bossReplyTargets('askCoderProposal', false),
                    target: '#failed',
                    actions: [
                      'rememberMalformedBossReply',
                      'clearProposalRoundContext',
                    ],
                  },
                  {
                    guard: bossReplyTargets('askCoderProposal', true),
                    target: 'working',
                    actions: 'rememberBossReply',
                  },
                ],
              },
            },
            complete: {
              type: 'final',
              description: 'Coder proposal is staged for the parallel join.',
              meta: {
                playbook: {
                  stateId: 'coderProposalComplete',
                  description:
                    'Coder proposal is staged for the parallel join.',
                },
              },
            },
          },
        },
        reviewer: {
          initial: 'working',
          states: {
            working: {
              id: 'askReviewerProposal',
              tags: 'playbook.busy',
              description: 'Reviewer independently proposes a spec design.',
              meta: {
                playbook: {
                  stateId: 'askReviewerProposal',
                  description:
                    'Reviewer independently proposes a spec design.',
                  role: 'reviewer',
                },
              },
              invoke: {
                src: 'player',
                input: ({ context }): PlayerInput => ({
                  stateId: 'askReviewerProposal',
                  sourceItem: 'DECIDE-2',
                  role: 'reviewer',
                  prompt: INDEPENDENT_PROPOSAL_PROMPT,
                  result: withNeedsBossReply({
                    proposed:
                      'Reviewer completed an independent proposal. Output shall include `reviewerProposal: <verbatim final text>`.',
                  }),
                  callerTopic: context.callerTopic,
                  ...bossReplyFields(context, 'askReviewerProposal'),
                }),
                onDone: [
                  {
                    guard: 'needsBossReplyWithQuestion',
                    target: 'waiting',
                    actions: [
                      {
                        type: 'playbook.acceptedOutcome',
                        params: {
                          source: 'askReviewerProposal',
                          target: 'waitReviewerProposalReply',
                          acceptedOutcome: 'needsBossReply',
                        },
                      },
                      {
                        type: 'setPendingBossQuestion',
                        params: {
                          ...stateMetadata.askReviewerProposal,
                          resumeStateId: 'askReviewerProposal',
                          question: '',
                        },
                      },
                    ],
                  },
                  {
                    guard: 'needsBossReplyWithoutQuestion',
                    target: '#failed',
                    actions: [
                      'rememberMalformedActorOutput',
                      'clearProposalRoundContext',
                    ],
                  },
                  {
                    guard: 'reviewerProposed',
                    target: 'complete',
                    actions: [
                      {
                        type: 'playbook.acceptedOutcome',
                        params: ({ context }) => ({
                          source: 'askReviewerProposal',
                          target:
                            context.stagedCoderResult === undefined
                              ? 'reviewerProposalComplete'
                              : 'commitCoderProposal',
                          acceptedOutcome: 'proposed',
                        }),
                      },
                      'stageReviewerProposal',
                      {
                        type: 'clearBranchBossReplyContext',
                        params: { stateId: 'askReviewerProposal' },
                      },
                    ],
                  },
                  {
                    target: '#failed',
                    actions: [
                      'rememberMalformedActorOutput',
                      'clearProposalRoundContext',
                    ],
                  },
                ],
                onError: {
                  target: '#failed',
                  actions: [
                    'rememberActorError',
                    'clearProposalRoundContext',
                  ],
                },
              },
            },
            waiting: {
              id: 'waitReviewerProposalReply',
              tags: 'playbook.parked',
              description: 'Reviewer waits for Boss to answer a question.',
              meta: {
                playbook: {
                  stateId: 'waitReviewerProposalReply',
                  description:
                    'Reviewer waits for Boss to answer a question.',
                },
              },
              on: {
                BOSS_REPLY: [
                  {
                    guard: bossReplyTargets('askReviewerProposal', false),
                    target: '#failed',
                    actions: [
                      'rememberMalformedBossReply',
                      'clearProposalRoundContext',
                    ],
                  },
                  {
                    guard: bossReplyTargets('askReviewerProposal', true),
                    target: 'working',
                    actions: 'rememberBossReply',
                  },
                ],
              },
            },
            complete: {
              type: 'final',
              description:
                'Reviewer proposal is staged for the parallel join.',
              meta: {
                playbook: {
                  stateId: 'reviewerProposalComplete',
                  description:
                    'Reviewer proposal is staged for the parallel join.',
                },
              },
            },
          },
        },
      },
      onDone: {
        target: 'commitCoderProposal',
        actions: 'promoteProposals',
      },
    },
    commitCoderProposal: {
      id: 'commitCoderProposal',
      tags: 'playbook.busy',
      description: 'Coder writes and commits Coder’s independent proposal.',
      meta: {
        playbook: {
          stateId: 'commitCoderProposal',
          description: 'Coder writes and commits Coder’s independent proposal.',
          role: 'coder',
        },
      },
      invoke: {
        src: 'player',
        input: ({ context }): PlayerInput => ({
          stateId: 'commitCoderProposal',
          sourceItem: 'DECIDE-3',
          role: 'coder',
          prompt: COMMIT_CODER_PROMPT,
          result: withNeedsBossReply({
            committed:
              "Coder committed Coder's proposal. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.",
          }),
          ...bossReplyFields(context, 'commitCoderProposal'),
        }),
        onDone: [
          {
            guard: 'needsBossReplyWithQuestion',
            target: 'awaitBossReply',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'commitCoderProposal',
                  target: 'awaitBossReply',
                  acceptedOutcome: 'needsBossReply',
                },
              },
              {
                type: 'setPendingBossQuestion',
                params: {
                  ...stateMetadata.commitCoderProposal,
                  resumeStateId: 'commitCoderProposal',
                  question: '',
                },
              },
            ],
          },
          {
            guard: 'needsBossReplyWithoutQuestion',
            target: 'failed',
            actions: [
              'rememberMalformedActorOutput',
              'clearBossReplyContext',
            ],
          },
          {
            guard: 'committed',
            target: 'reviewCommit',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'commitCoderProposal',
                  target: 'reviewCommit',
                  acceptedOutcome: 'committed',
                },
              },
              'rememberCommit',
              {
                type: 'clearBranchBossReplyContext',
                params: { stateId: 'commitCoderProposal' },
              },
            ],
          },
          {
            target: 'failed',
            actions: [
              'rememberMalformedActorOutput',
              'clearBossReplyContext',
            ],
          },
        ],
        onError: {
          target: 'failed',
          actions: ['rememberActorError', 'clearBossReplyContext'],
        },
      },
    },
    awaitBossReply: {
      id: 'awaitBossReply',
      tags: 'playbook.parked',
      description: 'Waiting for Boss to answer Coder’s question.',
      meta: {
        playbook: {
          stateId: 'awaitBossReply',
          description: 'Waiting for Boss to answer Coder’s question.',
        },
      },
      on: {
        BOSS_REPLY: [
          {
            guard: bossReplyTargets('commitCoderProposal', false),
            target: 'failed',
            actions: [
              'rememberMalformedBossReply',
              'clearBossReplyContext',
            ],
          },
          ...resumableStates(['commitCoderProposal']),
        ],
      },
    },
    reviewCommit: {
      id: 'reviewCommit',
      tags: 'playbook.suspended',
      description: 'REVIEW examines the committed proposal.',
      meta: {
        playbook: {
          stateId: 'reviewCommit',
          description: 'REVIEW examines the committed proposal.',
        },
      },
      invoke: {
        src: 'playbook',
        input: ({ context }): PlaybookInput => ({
          stateId: 'reviewCommit',
          sourceItem: 'DECIDE-4',
          playbookId: 'review',
          text: composeReviewInput(
            context.callerTopic,
            context.coderProposal,
          ),
        }),
        onDone: [
          {
            guard: 'validReviewSuccess',
            target: 'done',
            actions: 'rememberReviewSuccess',
          },
          {
            target: 'reportedReviewFailure',
            actions: 'rememberReviewProtocolFailure',
          },
        ],
        onError: [
          {
            guard: 'authoredReviewFailure',
            target: 'reportedReviewFailure',
            actions: 'rememberReviewFailure',
          },
          {
            target: 'failed',
            actions: 'rememberActorError',
          },
        ],
      },
    },
    failed: {
      id: 'failed',
      tags: 'playbook.parked',
      description: 'DECIDE failed and is waiting for a new topic.',
      meta: {
        playbook: {
          stateId: 'failed',
          description: 'DECIDE failed and is waiting for a new topic.',
        },
      },
      on: {
        START_DECIDE: {
          guard: ({ event }) => event.callerTopic.trim().length > 0,
          target: 'independentProposals',
          actions: 'copyStartTopic',
        },
      },
    },
    reportedReviewFailure: {
      id: 'reportedReviewFailure',
      type: 'final',
      description: 'DECIDE reports REVIEW’s failure and its last commit.',
      meta: {
        playbook: {
          stateId: 'reportedReviewFailure',
          description: 'DECIDE reports REVIEW’s failure and its last commit.',
        },
      },
    },
    done: {
      id: 'done',
      type: 'final',
      description: 'DECIDE completed with an approved commit.',
      meta: {
        playbook: {
          stateId: 'done',
          description: 'DECIDE completed with an approved commit.',
        },
      },
    },
  },
});

export default decideMachine;
