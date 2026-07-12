// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { assign, fromPromise, setup } from 'xstate';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface EnabledPlaybook {
  readonly id: string;
  readonly command: string;
  readonly intent: string;
}

export interface PendingBossQuestion {
  readonly questionId: ResumableStateId;
  readonly resumeStateId: ResumableStateId;
  readonly sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3';
  readonly player: 'Captain';
  readonly question: string;
}

type RoutingResult = {
  readonly direct: string;
  readonly question: string;
  readonly delegation: string;
  readonly needsBossReply: string;
};

type ReassessmentResult = {
  readonly final: string;
  readonly followUpQuestion: string;
  readonly continuing: string;
  readonly needsBossReply: string;
};

interface CaptainInputBase {
  readonly stateId: ResumableStateId;
  readonly sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3';
  readonly prompt: string;
  readonly pendingBossQuestion?: PendingBossQuestion;
  readonly bossReply?: string;
}

export type CaptainInput =
  | (CaptainInputBase & {
      readonly stateId: 'routing';
      readonly sourceItem: 'CAPTAIN-1';
      readonly result: RoutingResult;
      readonly bossIntent: string;
      readonly enabledPlaybooks: readonly EnabledPlaybook[];
    })
  | (CaptainInputBase & {
      readonly stateId: 'reassessment';
      readonly sourceItem: 'CAPTAIN-3';
      readonly result: ReassessmentResult;
      readonly bossIntent: string;
      readonly enabledPlaybooks: readonly EnabledPlaybook[];
      readonly remainingPlan: readonly JsonValue[];
      readonly completedCallResults: readonly CompletedCallResult[];
    });

export type CaptainOutput =
  | { readonly guard: 'direct'; readonly response: string }
  | { readonly guard: 'question'; readonly question: string }
  | {
      readonly guard: 'delegation';
      readonly remainingPlan: readonly JsonValue[];
      readonly nextPlaybookId: string;
      readonly nextPlaybookInput: string;
    }
  | { readonly guard: 'final'; readonly response: string }
  | { readonly guard: 'followUpQuestion'; readonly question: string }
  | {
      readonly guard: 'continuing';
      readonly remainingPlan: readonly JsonValue[];
      readonly nextPlaybookId: string;
      readonly nextPlaybookInput: string;
    }
  | { readonly guard: 'needsBossReply'; readonly question: string };

export interface PlaybookInput {
  readonly stateId: 'callPlaybook';
  readonly sourceItem?: 'CAPTAIN-2';
  readonly playbookId: string;
  readonly text: string;
  readonly playbookIdContext: 'nextPlaybookId';
  readonly textContext: 'nextPlaybookInput';
}

export type PlaybookOutput = JsonValue | undefined;

export interface CaptainMachineInput {
  readonly enabledPlaybooks: readonly EnabledPlaybook[];
  readonly selfPlaybookId: string;
}

export type CaptainMachineOutput = { readonly response: string };

type CompactError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
};

type CompletedCallResult =
  | {
      readonly playbookId: string;
      readonly status: 'ok';
      readonly output?: JsonValue;
    }
  | {
      readonly playbookId: string;
      readonly status: 'aborted' | 'error';
      readonly error: { readonly name: string; readonly message: string };
    };

type ResumableStateId = 'routing' | 'reassessment';

type CaptainContext = {
  readonly enabledPlaybooks: readonly EnabledPlaybook[];
  readonly selfPlaybookId: string;
  readonly bossIntent: string;
  readonly remainingPlan: readonly JsonValue[];
  readonly completedCallResults: readonly CompletedCallResult[];
  readonly callSignatures: readonly string[];
  readonly nextPlaybookId: string;
  readonly nextPlaybookInput: string;
  readonly response: string;
  readonly pendingBossQuestion?: PendingBossQuestion;
  readonly bossReply?: string;
  readonly lastError?: CompactError;
};

type CaptainEvent =
  | { readonly type: 'BOSS_INTENT'; readonly bossIntent: string }
  | {
      readonly type: 'BOSS_INTERRUPT';
      readonly targetId: 'routing';
      readonly bossIntent: string;
    }
  | {
      readonly type: 'BOSS_REPLY';
      readonly answer: string;
      readonly questionId?: string;
    };

const routingPrompt = [
  'Boss intent: <boss-intent>',
  'Enabled playbooks: <enabled-playbooks>',
  "Preserve Boss's intended outcome and constraints.",
  'Treat the enabled-playbooks catalog as immutable host input for the session; Boss events and Captain decisions cannot replace it.',
  'Each enabled-playbooks catalog entry contains only a stable playbook id, its command, and its intent.',
  'Prefer a matching specialized playbook when delegation materially improves execution; otherwise handle the intent directly.',
  'Ask exactly one concise question only when its answer would materially change routing or call order.',
  'For a complex intent, divide it into the smallest finite ordered plan of useful playbook calls.',
  'Keep the plan finite and ordered, and issue at most one child call at a time.',
  'Put only calls after the selected first call in remainingPlan.',
  'Every continuation must strictly reduce the length of remainingPlan.',
  'Do not call a playbook merely to restate or classify the intent.',
  'Select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.',
  'Call only ids in the enabled-playbooks catalog and never call this Captain playbook itself.',
  'Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.',
  'On a fresh directive that interrupts parked Captain work, restart this routing behavior with the fresh intent; do not jump directly into reassessment or retain the prior question, answer, plan, call history, evidence, selection, response, or error.',
  'A direct decision must carry a concise JSON-safe response and complete; its result guard is exactly direct.',
  'A question decision must carry one concise question and wait for Boss without losing the original intent; its result guard is exactly question.',
  "Boss's answer resumes this same routing decision with continuation context, not a separate behavior.",
  'After consuming the answer to the routing question, the question and answer are no longer pending before calling a child or completing.',
  'A delegation decision must carry a finite remainingPlan plus non-empty nextPlaybookId and nextPlaybookInput for its first call; its result guard is exactly delegation.',
].join('\n');

const reassessmentPrompt = [
  'Boss intent: <boss-intent>',
  'Enabled playbooks: <enabled-playbooks>',
  'Remaining plan: <remaining-plan>',
  'Completed call results: <completed-call-results>',
  "Preserve Boss's intended outcome and constraints.",
  'Treat the enabled-playbooks catalog as immutable host input for the session; Boss events and Captain decisions cannot replace it.',
  'Each enabled-playbooks catalog entry contains only a stable playbook id, its command, and its intent.',
  'Treat each returned result as evidence and revise the remaining plan when needed.',
  'Keep the plan finite and ordered, and issue at most one child call at a time.',
  'A continuing decision must strictly reduce the remaining plan length, and its remainingPlan must contain only calls after the selected next call.',
  'Do not repeat an equivalent failed or completed call without new information.',
  'For the deterministic safety floor, two calls are the same only when both the stable target id and complete standalone input match exactly.',
  'Record that exact stable-target-id and complete-standalone-input pair before invoking the child, so an ok, aborted, or error return prevents the same later attempt.',
  'Input revised with new information is different for this exact check; still apply the broader semantic no-repeat requirement.',
  "Each completed call result must contain only the selected playbook id, its ok, aborted, or error status, and either the child's actual JSON-safe output or a compact error containing only name and message.",
  'Never retain or expose a child session id, call id, child state, stack trace, or opaque runtime result object.',
  'If the intent is fulfilled, give Boss one concise final response.',
  'If information from Boss is now necessary, ask exactly one concise question.',
  'Otherwise select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.',
  'Call only ids in the enabled-playbooks catalog and never call this Captain playbook itself.',
  'Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.',
  'A final decision must carry a concise JSON-safe response and complete; its result guard is exactly final.',
  'A follow-up question must carry one concise question and wait for Boss without losing the original intent, plan, or completed results; its result guard is exactly followUpQuestion.',
  "Boss's answer resumes this same reassessment with continuation context, not a separate behavior.",
  'After consuming the answer to the reassessment question, the question and answer are no longer pending before calling a child or completing.',
  'A continuing decision must carry a strictly shorter finite remainingPlan plus non-empty nextPlaybookId and nextPlaybookInput; its result guard is exactly continuing.',
  'Treat a child abort or failure as a completed call result for reassessment; do not route this playbook directly to its generic failure state.',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, active = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (active.has(value)) return false;
  active.add(value);

  let valid = true;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) valid = false;
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      keys.length !== value.length + 1 ||
      !lengthDescriptor ||
      lengthDescriptor.enumerable ||
      lengthDescriptor.configurable ||
      lengthDescriptor.value !== value.length ||
      (lengthDescriptor.writable !== true && lengthDescriptor.writable !== false)
    ) valid = false;
    for (let index = 0; valid && index < value.length; index += 1) {
      const key = String(index);
      if (keys[index] !== key) {
        valid = false;
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        valid = false;
        break;
      }
      valid = isJsonValue(descriptor.value, active);
    }
    if (valid && keys[keys.length - 1] !== 'length') valid = false;
  } else if (isRecord(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        valid = false;
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        valid = false;
        break;
      }
      if (!isJsonValue(descriptor.value, active)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = false;
  }

  active.delete(value);
  return valid;
}

function actorOutput(event: unknown): unknown {
  return isRecord(event) ? event.output : undefined;
}

function actorError(event: unknown): unknown {
  return isRecord(event) ? event.error : undefined;
}

function hasGuard(event: unknown, guard: CaptainOutput['guard']): boolean {
  const output = actorOutput(event);
  return isRecord(output) && isJsonValue(output) && output.guard === guard;
}

function hasNonEmptyStringField(event: unknown, guard: CaptainOutput['guard'], field: string): boolean {
  const output = actorOutput(event);
  return hasGuard(event, guard) && isRecord(output) && typeof output[field] === 'string' && output[field].length > 0;
}

function callSignature(playbookId: string, text: string): string {
  return JSON.stringify([playbookId, text]);
}

function isValidPlannedCall(
  context: CaptainContext,
  event: unknown,
  guard: 'delegation' | 'continuing',
): boolean {
  const output = actorOutput(event);
  if (!hasGuard(event, guard) || !isRecord(output)) return false;
  const plan = output.remainingPlan;
  const playbookId = output.nextPlaybookId;
  const text = output.nextPlaybookInput;
  if (!Array.isArray(plan) || !isJsonValue(plan)) return false;
  if (guard === 'continuing' && plan.length >= context.remainingPlan.length) return false;
  if (typeof playbookId !== 'string' || playbookId.length === 0) return false;
  if (typeof text !== 'string' || text.length === 0) return false;
  if (playbookId === context.selfPlaybookId) return false;
  if (!context.enabledPlaybooks.some((entry) => entry.id === playbookId)) return false;
  return !context.callSignatures.includes(callSignature(playbookId, text));
}

function plannedCallUpdate(event: unknown): Pick<CaptainContext, 'remainingPlan' | 'nextPlaybookId' | 'nextPlaybookInput'> {
  const output = actorOutput(event) as {
    readonly remainingPlan: readonly JsonValue[];
    readonly nextPlaybookId: string;
    readonly nextPlaybookInput: string;
  };
  return {
    remainingPlan: output.remainingPlan,
    nextPlaybookId: output.nextPlaybookId,
    nextPlaybookInput: output.nextPlaybookInput,
  };
}

function normalizeError(value: unknown): CompactError {
  if (value instanceof Error) {
    return value.stack === undefined
      ? { name: value.name, message: value.message }
      : { name: value.name, message: value.message, stack: value.stack };
  }
  return { name: 'Error', message: typeof value === 'string' ? value : 'Unknown actor error' };
}

type AuthoredChildResult =
  | { readonly status: 'aborted'; readonly error?: { readonly name: string; readonly message: string } }
  | { readonly status: 'error'; readonly error: { readonly name: string; readonly message: string } };

function authoredChildResult(event: unknown): AuthoredChildResult | undefined {
  const error = actorError(event);
  if (!(error instanceof Error) || !('result' in error)) return undefined;
  const result = error.result;
  if (!isRecord(result) || !isJsonValue(result)) return undefined;
  if (result.status !== 'aborted' && result.status !== 'error') return undefined;
  if (result.error !== undefined) {
    if (!isRecord(result.error) || typeof result.error.name !== 'string' || typeof result.error.message !== 'string') return undefined;
  } else if (result.status === 'error') {
    return undefined;
  }
  return result as AuthoredChildResult;
}

function isAuthoredChildError(event: unknown): boolean {
  return authoredChildResult(event) !== undefined;
}

function completedChildError(playbookId: string, event: unknown): CompletedCallResult {
  const result = authoredChildResult(event);
  if (!result) throw new Error('Authored child result was not validated');
  const error = result.error ?? { name: 'AbortError', message: 'Child playbook aborted' };
  return { playbookId, status: result.status, error: { name: error.name, message: error.message } };
}

function completedChildSuccess(playbookId: string, event: unknown): CompletedCallResult | undefined {
  const output = actorOutput(event);
  if (output !== undefined && !isJsonValue(output)) return undefined;
  return output === undefined
    ? { playbookId, status: 'ok' }
    : { playbookId, status: 'ok', output };
}

function validBossReply(context: CaptainContext, event: CaptainEvent): boolean {
  if (event.type !== 'BOSS_REPLY' || event.answer.trim().length === 0) return false;
  const pending = context.pendingBossQuestion;
  if (!pending) return false;
  return event.questionId === undefined || event.questionId === pending.questionId;
}

function setPendingBossQuestion(
  resumeStateId: ResumableStateId,
  sourceItem: 'CAPTAIN-1' | 'CAPTAIN-3',
  event: unknown,
): Pick<CaptainContext, 'pendingBossQuestion' | 'bossReply'> {
  const output = actorOutput(event) as { readonly question: string };
  return {
    pendingBossQuestion: {
      questionId: resumeStateId,
      resumeStateId,
      sourceItem,
      player: 'Captain',
      question: output.question,
    },
    bossReply: undefined,
  };
}

function clearBossReplyContext(): Pick<CaptainContext, 'pendingBossQuestion' | 'bossReply'> {
  return { pendingBossQuestion: undefined, bossReply: undefined };
}

function bossInterrupts(ids: readonly ['routing']) {
  return [{
    guard: ({ event }: { event: CaptainEvent }) =>
      event.type === 'BOSS_INTERRUPT' && event.targetId === ids[0] && event.bossIntent.trim().length > 0,
    target: '#routing',
    reenter: true,
    actions: 'restartWithFreshIntent',
  }] as const;
}

function resumableStates(ids: readonly ['routing', 'reassessment']) {
  return [
    {
      guard: ({ context, event }: { context: CaptainContext; event: CaptainEvent }) =>
        validBossReply(context, event) && context.pendingBossQuestion?.resumeStateId === ids[0],
      target: '#routing',
      actions: 'rememberBossReply',
    },
    {
      guard: ({ context, event }: { context: CaptainContext; event: CaptainEvent }) =>
        validBossReply(context, event) && context.pendingBossQuestion?.resumeStateId === ids[1],
      target: '#reassessment',
      actions: 'rememberBossReply',
    },
  ] as const;
}

const needsBossReplyDescription = "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

export const captainMachine = setup({
  types: {
    context: {} as CaptainContext,
    events: {} as CaptainEvent,
    input: {} as CaptainMachineInput,
    output: {} as CaptainMachineOutput,
  },
  actors: {
    captain: fromPromise<CaptainOutput, CaptainInput>(async () => {
      throw new Error('captain actor must be provided by the runner');
    }),
    playbook: fromPromise<PlaybookOutput, PlaybookInput>(async () => {
      throw new Error('playbook actor must be provided by the runner');
    }),
  },
  actions: {
    restartWithFreshIntent: assign(({ context, event }) => {
      if ((event.type !== 'BOSS_INTERRUPT' && event.type !== 'BOSS_INTENT') || event.bossIntent.trim().length === 0) return {};
      return {
        bossIntent: event.bossIntent,
        remainingPlan: [],
        completedCallResults: [],
        callSignatures: [],
        nextPlaybookId: '',
        nextPlaybookInput: '',
        response: '',
        pendingBossQuestion: undefined,
        bossReply: undefined,
        lastError: undefined,
        enabledPlaybooks: context.enabledPlaybooks,
      };
    }),
    rememberDirectResponse: assign(({ event }) => {
      const output = actorOutput(event) as { readonly response: string };
      return { response: output.response, ...clearBossReplyContext() };
    }),
    rememberPlannedCall: assign(({ context, event }) => {
      const update = plannedCallUpdate(event);
      return {
        ...update,
        callSignatures: [...context.callSignatures, callSignature(update.nextPlaybookId, update.nextPlaybookInput)],
        ...clearBossReplyContext(),
      };
    }),
    setRoutingPendingBossQuestion: assign(({ event }) => setPendingBossQuestion('routing', 'CAPTAIN-1', event)),
    setReassessmentPendingBossQuestion: assign(({ event }) => setPendingBossQuestion('reassessment', 'CAPTAIN-3', event)),
    rememberBossReply: assign(({ event }) => event.type === 'BOSS_REPLY' ? { bossReply: event.answer } : {}),
    appendChildSuccess: assign(({ context, event }) => {
      const result = completedChildSuccess(context.nextPlaybookId, event);
      return result ? { completedCallResults: [...context.completedCallResults, result] } : {};
    }),
    appendChildError: assign(({ context, event }) => ({
      completedCallResults: [...context.completedCallResults, completedChildError(context.nextPlaybookId, event)],
    })),
    rememberCaptainError: assign(({ event }) => ({ lastError: normalizeError(actorError(event)) })),
    rememberMalformedResult: assign(() => ({ lastError: { name: 'ResultError', message: 'Actor returned a malformed or unsupported result' } })),
  },
}).createMachine({
  id: 'captain',
  initial: 'ready',
  context: ({ input }) => ({
    enabledPlaybooks: input.enabledPlaybooks,
    selfPlaybookId: input.selfPlaybookId,
    bossIntent: '',
    remainingPlan: [],
    completedCallResults: [],
    callSignatures: [],
    nextPlaybookId: '',
    nextPlaybookInput: '',
    response: '',
  }),
  output: ({ context }) => ({ response: context.response }),
  on: {
    BOSS_INTERRUPT: bossInterrupts(['routing']),
  },
  states: {
    ready: {
      id: 'ready',
      description: 'Waiting for Boss to provide an intent.',
      meta: { playbook: { stateId: 'ready', description: 'Waiting for Boss to provide an intent.' } },
      tags: ['playbook.parked'],
      on: {
        BOSS_INTENT: {
          guard: ({ event }) => event.bossIntent.trim().length > 0,
          target: 'routing',
          actions: 'restartWithFreshIntent',
        },
      },
    },
    routing: {
      id: 'routing',
      description: 'Deciding how to handle the Boss intent.',
      meta: { playbook: { stateId: 'routing', description: 'Deciding how to handle the Boss intent.' } },
      tags: ['playbook.busy'],
      invoke: {
        id: 'routing',
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          stateId: 'routing',
          sourceItem: 'CAPTAIN-1',
          prompt: routingPrompt,
          result: {
            direct: 'Captain chose a direct response. Output shall include `response: concise JSON-safe response`.',
            question: 'Captain chose to ask Boss a routing question. Output shall include `question: concise question`.',
            delegation: 'Captain selected the first call. Output shall include `remainingPlan: finite ordered JSON-safe array`, `nextPlaybookId: non-empty stable id`, and `nextPlaybookInput: non-empty complete standalone input`.',
            needsBossReply: needsBossReplyDescription,
          },
          bossIntent: context.bossIntent,
          enabledPlaybooks: context.enabledPlaybooks,
          ...(context.pendingBossQuestion ? { pendingBossQuestion: context.pendingBossQuestion } : {}),
          ...(context.bossReply !== undefined ? { bossReply: context.bossReply } : {}),
        }),
        onDone: [
          {
            guard: ({ event }) => hasNonEmptyStringField(event, 'direct', 'response'),
            target: 'done',
            actions: 'rememberDirectResponse',
          },
          {
            guard: ({ event }) => hasNonEmptyStringField(event, 'question', 'question'),
            target: 'awaitBossReply',
            actions: 'setRoutingPendingBossQuestion',
          },
          {
            guard: ({ context, event }) => isValidPlannedCall(context, event, 'delegation'),
            target: 'callPlaybook',
            actions: 'rememberPlannedCall',
          },
          {
            guard: ({ event }) => hasNonEmptyStringField(event, 'needsBossReply', 'question'),
            target: 'awaitBossReply',
            actions: 'setRoutingPendingBossQuestion',
          },
          { target: 'failed', actions: 'rememberMalformedResult' },
        ],
        onError: { target: 'failed', actions: 'rememberCaptainError' },
      },
    },
    callPlaybook: {
      id: 'callPlaybook',
      description: 'Calling the selected enabled playbook.',
      meta: { playbook: { stateId: 'callPlaybook', description: 'Calling the selected enabled playbook.' } },
      tags: ['playbook.suspended'],
      invoke: {
        src: 'playbook',
        input: ({ context }): PlaybookInput => ({
          stateId: 'callPlaybook',
          sourceItem: 'CAPTAIN-2',
          playbookId: context.nextPlaybookId,
          text: context.nextPlaybookInput,
          playbookIdContext: 'nextPlaybookId',
          textContext: 'nextPlaybookInput',
        }),
        onDone: [
          {
            guard: ({ event }) => completedChildSuccess('', event) !== undefined,
            target: 'reassessment',
            actions: 'appendChildSuccess',
          },
          { target: 'failed', actions: 'rememberMalformedResult' },
        ],
        onError: [
          {
            guard: ({ event }) => isAuthoredChildError(event),
            target: 'reassessment',
            actions: 'appendChildError',
          },
          { target: 'failed', actions: 'rememberCaptainError' },
        ],
      },
    },
    reassessment: {
      id: 'reassessment',
      description: 'Reassessing the intent after a completed child call.',
      meta: { playbook: { stateId: 'reassessment', description: 'Reassessing the intent after a completed child call.' } },
      tags: ['playbook.busy'],
      invoke: {
        id: 'reassessment',
        src: 'captain',
        input: ({ context }): CaptainInput => ({
          stateId: 'reassessment',
          sourceItem: 'CAPTAIN-3',
          prompt: reassessmentPrompt,
          result: {
            final: 'Captain determined the intent is fulfilled. Output shall include `response: concise JSON-safe response`.',
            followUpQuestion: 'Captain needs information from Boss. Output shall include `question: concise question`.',
            continuing: 'Captain selected the next call. Output shall include `remainingPlan: strictly shorter finite ordered JSON-safe array`, `nextPlaybookId: non-empty stable id`, and `nextPlaybookInput: non-empty complete standalone input`.',
            needsBossReply: needsBossReplyDescription,
          },
          bossIntent: context.bossIntent,
          enabledPlaybooks: context.enabledPlaybooks,
          remainingPlan: context.remainingPlan,
          completedCallResults: context.completedCallResults,
          ...(context.pendingBossQuestion ? { pendingBossQuestion: context.pendingBossQuestion } : {}),
          ...(context.bossReply !== undefined ? { bossReply: context.bossReply } : {}),
        }),
        onDone: [
          {
            guard: ({ event }) => hasNonEmptyStringField(event, 'final', 'response'),
            target: 'done',
            actions: 'rememberDirectResponse',
          },
          {
            guard: ({ event }) => hasNonEmptyStringField(event, 'followUpQuestion', 'question'),
            target: 'awaitBossReply',
            actions: 'setReassessmentPendingBossQuestion',
          },
          {
            guard: ({ context, event }) => isValidPlannedCall(context, event, 'continuing'),
            target: 'callPlaybook',
            actions: 'rememberPlannedCall',
          },
          {
            guard: ({ event }) => hasNonEmptyStringField(event, 'needsBossReply', 'question'),
            target: 'awaitBossReply',
            actions: 'setReassessmentPendingBossQuestion',
          },
          { target: 'failed', actions: 'rememberMalformedResult' },
        ],
        onError: { target: 'failed', actions: 'rememberCaptainError' },
      },
    },
    awaitBossReply: {
      id: 'awaitBossReply',
      description: "Waiting for Boss to answer the acting agent's question.",
      meta: { playbook: { stateId: 'awaitBossReply', description: "Waiting for Boss to answer the acting agent's question." } },
      tags: ['playbook.parked'],
      on: {
        BOSS_REPLY: resumableStates(['routing', 'reassessment']),
        BOSS_INTENT: {
          guard: ({ event }) => event.bossIntent.trim().length > 0,
          target: 'routing',
          actions: 'restartWithFreshIntent',
        },
      },
    },
    failed: {
      id: 'failed',
      description: 'Waiting for Boss recovery after an unrecoverable error.',
      meta: { playbook: { stateId: 'failed', description: 'Waiting for Boss recovery after an unrecoverable error.' } },
      tags: ['playbook.parked'],
      on: {
        BOSS_INTENT: {
          guard: ({ event }) => event.bossIntent.trim().length > 0,
          target: 'routing',
          actions: 'restartWithFreshIntent',
        },
      },
    },
    done: {
      id: 'done',
      type: 'final',
      description: 'Returning the completed response to Boss.',
      meta: { playbook: { stateId: 'done', description: 'Returning the completed response to Boss.' } },
    },
  },
});
