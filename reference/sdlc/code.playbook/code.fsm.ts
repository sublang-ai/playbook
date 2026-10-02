// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// FSM object artifact compiled from ./code.gears.md by gears2fsm.
// It declares only the machine, its actor contracts, and typed inputs; the
// linked runtime supplies the `player` and `playbook` actor implementations.

import { assign, fromPromise, setup } from 'xstate';
import { validatePlaybookCallResult } from '@sublang/playbook/xstate-runtime';
import type { PlaybookCallResult } from '@sublang/playbook/runtime';

// ---------------------------------------------------------------------------
// Shared JSON value type (exact readonly variance of the shared boundary)
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/** Canonical lowercase local id of the source role Coder. */
export type CodeRole = 'coder';

/** One role-id array per parallel group; CODE declares no parallel group. */
export const concurrentRoleSets: readonly (readonly CodeRole[])[] = [];

/** Delegated-player working leaves (CODE-1, CODE-3). */
export type WorkingStateId = 'firstPhase' | 'irTaskPhase';

/** Working leaves that may suspend for, and resume from, a Boss reply. */
export type ResumableStateId = WorkingStateId;

/** Root `BOSS_INTERRUPT` targets. */
export type JumpableStateId = WorkingStateId;

/** Nested `review` call states (CODE-2, CODE-4). */
export type ReviewStateId = 'reviewNewIntentPhase' | 'reviewIrTaskPhase';

export type CodeSourceItem = 'CODE-1' | 'CODE-2' | 'CODE-3' | 'CODE-4';

/** The accepted phase outcome whose `review` call decides the next step. */
export type PhaseOutcome =
  | 'directCommit'
  | 'irCommit'
  | 'moreTasks'
  | 'finalTask';

/** The literal nested-call target shared by both call states and guards. */
const REVIEW_PLAYBOOK_ID = 'review';

// ---------------------------------------------------------------------------
// Boss-reply suspension (scalar form: one active player task at a time)
// ---------------------------------------------------------------------------

export interface PendingBossQuestion {
  readonly questionId: ResumableStateId;
  readonly resumeStateId: ResumableStateId;
  readonly sourceItem: 'CODE-1' | 'CODE-3';
  readonly asker: { readonly kind: 'role'; readonly roleId: CodeRole };
  readonly question: string;
}

// ---------------------------------------------------------------------------
// Delegated player actor contract
// ---------------------------------------------------------------------------

interface PlayerInputBase {
  readonly role: CodeRole;
  /** The source item's full final prompt, verbatim. */
  readonly prompt: string;
  /** This state's local result contract: guard name → description. */
  readonly result: Readonly<Record<string, string>>;
  /** `<caller-input>`: the caller's complete coding request. */
  readonly callerInput?: string;
  /** `<run-results>`: relevant run results; empty when none were supplied. */
  readonly runResults: string;
  readonly pendingBossQuestion?: PendingBossQuestion;
  readonly bossReply?: string;
}

export interface FirstPhasePlayerInput extends PlayerInputBase {
  readonly stateId: 'firstPhase';
  readonly sourceItem: 'CODE-1';
}

export interface IrTaskPhasePlayerInput extends PlayerInputBase {
  readonly stateId: 'irTaskPhase';
  readonly sourceItem: 'CODE-3';
  /** `<ir-number>`: the IR whose next unfinished task this phase implements. */
  readonly irNumber?: string;
  /** Source-owned relay; historical canonical evidence, not present approval. */
  readonly previousPhaseReview: string;
}

export type PlayerInput = FirstPhasePlayerInput | IrTaskPhasePlayerInput;

export type PlayerOutput =
  | {
      readonly guard: 'directCommit';
      readonly coderOutput: string;
      readonly latestCommit: string;
    }
  | {
      readonly guard: 'irCommit';
      readonly coderOutput: string;
      readonly latestCommit: string;
      readonly irNumber: string;
    }
  | {
      readonly guard: 'moreTasks';
      readonly coderOutput: string;
      readonly latestCommit: string;
      readonly irNumber: string;
      readonly irTask: string;
    }
  | {
      readonly guard: 'finalTask';
      readonly coderOutput: string;
      readonly latestCommit: string;
      readonly irNumber: string;
      readonly irTask: string;
    }
  | { readonly guard: 'needsBossReply'; readonly question: string };

// ---------------------------------------------------------------------------
// Nested playbook actor contract
// ---------------------------------------------------------------------------

export interface PlaybookInput {
  readonly stateId: ReviewStateId;
  readonly sourceItem: 'CODE-2' | 'CODE-4';
  readonly playbookId: typeof REVIEW_PLAYBOOK_ID;
  readonly text: string;
}

/** A successful call yields the child's own JSON-safe machine output. */
export type PlaybookOutput = JsonValue | undefined;

/** Public output interface of the packaged builtin `review`. */
export interface ReviewPassOutput {
  readonly noUnsettledFindings: true;
  readonly evaluatedRevision: string;
}

export interface CompactError {
  readonly name: string;
  readonly message: string;
}

export interface ErrorRecord {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/** Sanitized completed-result evidence of the `review` call that ended CODE. */
export type CompletedReviewResult =
  | {
      readonly playbookId: typeof REVIEW_PLAYBOOK_ID;
      readonly status: 'ok';
      readonly output?: JsonValue;
    }
  | {
      readonly playbookId: typeof REVIEW_PLAYBOOK_ID;
      readonly status: 'aborted' | 'error';
      readonly error: CompactError;
    };

// ---------------------------------------------------------------------------
// Machine input, context, events, and output
// ---------------------------------------------------------------------------

/** Public output interface of the packaged builtin `code`. */
export type CodeOutput =
  | {
      readonly status: 'complete';
      readonly lastCodeCommit: string;
      readonly finalEvaluatedRevision: string;
      readonly allReviewsPassed: true;
    }
  | {
      readonly status: 'review-failed';
      readonly lastCodeCommit: string;
      readonly error: CompactError;
    };

export interface CodeInput {
  /** Optional seed for `<run-results>`; `START_CODE` may supply its own. */
  readonly runResults?: string;
}

export interface PreviousPhaseReview {
  readonly phaseKind: 'direct' | 'new-intent' | 'ir-task';
  readonly phaseOutcome: PhaseOutcome;
  readonly scopeCommit: string;
  readonly evaluatedRevision: string;
  readonly irNumber?: string;
  readonly irTask?: string;
}

export interface CodeContext {
  /** `<run-results>`: relevant run results relayed to every phase. */
  readonly runResults: string;
  /** `<caller-input>`: the caller's coding request and relevant context. */
  readonly callerInput?: string;
  /** `<code-commit>`: the accepted `latestCommit` of the latest phase. */
  readonly codeCommit?: string;
  /** `<coder-output>`: Coder's verbatim final text for the latest phase. */
  readonly coderOutput?: string;
  /** `<ir-number>`: the created or continued IR. */
  readonly irNumber?: string;
  /** `<ir-task>`: the IR task the latest IR-task phase implemented. */
  readonly irTask?: string;
  /** The accepted outcome of the phase under review. */
  readonly phaseOutcome?: PhaseOutcome;
  /** Revision evaluated by the latest passing review. */
  readonly evaluatedRevision?: string;
  /** Frozen only by an accepted canonical clean child REVIEW. */
  readonly previousPhaseReview?: PreviousPhaseReview;
  /** Compact failure CODE reports when review did not pass a phase. */
  readonly reviewError?: CompactError;
  /** Sanitized evidence of the review result that ended CODE. */
  readonly reviewEvidence?: CompletedReviewResult;
  readonly lastError?: ErrorRecord;
  readonly pendingBossQuestion?: PendingBossQuestion;
  readonly bossReply?: string;
}

export type CodeEvent =
  | {
      readonly type: 'START_CODE';
      readonly callerInput: string;
      readonly runResults?: string;
    }
  | { readonly type: 'BOSS_INTERRUPT'; readonly targetId: JumpableStateId }
  | {
      readonly type: 'BOSS_REPLY';
      readonly answer: string;
      readonly questionId?: ResumableStateId;
    };

// ---------------------------------------------------------------------------
// Prompts and result contracts (verbatim from code.gears.md)
// ---------------------------------------------------------------------------

const FIRST_PHASE_PROMPT = [
  'First determine whether the coding request starts a new coding intent or continues an existing IR with unfinished work.',
  'If the request may continue an existing IR but does not identify it unambiguously, ask Boss before changing files.',
  '',
  'For a new coding intent, assess whether it can be completed well in one commit.',
  'If it can, implement and test it, update the affected specs, and ensure @specs/map.md remains accurate.',
  'If it cannot, decompose it into tasks sized to exactly one commit each, add a new IR under @specs/intents, and do not implement any IR task in this phase.',
  'Plan affected spec updates before, with, or after their corresponding code changes, either as standalone IR tasks or as explicit work within related tasks.',
  '',
  'For an existing IR, read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.',
  'Do not implement a later task in this phase.',
  "Mark the IR's progress and deliverables when relevant.",
  'If the IR will be finished after this phase, double-check that all acceptance criteria are met.',
  '',
  'Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.',
  '',
  'Keep to the original intent and follow what it asks.',
  'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
  "Make the phase's minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.",
  'Make the commit message explain concisely what changed and why, including relevant verification.',
  'Identify every new commit you make.',
  'Credit every AI that contributed to this commit: Coder <coder-llm>.',
  '',
  '> Original request: <caller-input>',
  '> Run results: <run-results>',
].join('\n');

const IR_TASK_PHASE_PROMPT = [
  'Read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.',
  'Do not implement a later task in this phase.',
  "Mark the IR's progress and deliverables when relevant.",
  'If the IR will be finished after this phase, double-check that all acceptance criteria are met.',
  'Use the quoted previous-phase review only for its exact recorded scope; committed pending-review text may predate that canonical result.',
  'Before treating it as current review evidence, verify clean current HEAD equals its evaluatedRevision; a mismatch is not approval.',
  'It does not replace independent review of this task or any new owner or release decision.',
  '',
  'Keep to the original intent and follow what it asks.',
  'Do not re-run tests or builds whose inputs have not changed since any previous reported run.',
  "Make the phase's minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.",
  'Make the commit message explain concisely what changed and why, including relevant verification.',
  'Identify every new commit you make.',
  'Credit every AI that contributed to this commit: Coder <coder-llm>.',
  '',
  '> Original request: <caller-input>',
  '> IR number: <ir-number>',
  '> Run results: <run-results>',
  '> Previous phase review: <previous-phase-review>',
].join('\n');

const REVIEW_NEW_INTENT_PHASE_TEMPLATE = [
  '> Original intent: <caller-input>',
  '> Review scope: the commit <code-commit> from this coding phase and its resulting repository state.',
  '> Coder output: <coder-output>',
].join('\n');

const REVIEW_IR_TASK_PHASE_TEMPLATE = [
  '> Original intent: <caller-input>',
  '> Review scope: the commit <code-commit> from this coding phase and its resulting repository state.',
  '> Coder output: <coder-output>',
  '',
  '> Current IR task: <ir-task>',
].join('\n');

const NEEDS_BOSS_REPLY_DESCRIPTION =
  "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

const FIRST_PHASE_RESULT = {
  directCommit:
    "Coder completed the new coding intent as one direct implementation phase and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.",
  irCommit:
    "Coder decomposed the new coding intent into a new IR, implemented no IR task, and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, and `irNumber` identifying the created IR.",
  moreTasks:
    "Coder continued an existing IR, implemented exactly its next unfinished task, made its one new commit, and at least one IR task remains unfinished; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.",
  finalTask:
    "Coder continued an existing IR, implemented its final unfinished task, and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.",
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} as const;

const IR_TASK_PHASE_RESULT = {
  moreTasks:
    "Coder implemented exactly the IR's next unfinished task, made its one new commit, and at least one IR task remains unfinished; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the IR, and `irTask` naming the implemented task.",
  finalTask:
    "Coder implemented the IR's final unfinished task and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the IR, and `irTask` naming the implemented task.",
  needsBossReply: NEEDS_BOSS_REPLY_DESCRIPTION,
} as const;

const STATE_DESCRIPTIONS = {
  ready: 'Waiting for a coding request.',
  firstPhase:
    'Coder runs the first coding phase: a direct implementation, a new IR, or the next task of an existing IR.',
  reviewNewIntentPhase:
    'REVIEW examines the commit of the direct implementation or new-IR phase.',
  irTaskPhase: "Coder implements the identified IR's next unfinished task.",
  reviewIrTaskPhase: 'REVIEW examines the commit of the IR-task phase.',
  awaitBossReply: "Waiting for Boss to answer the acting agent's question.",
  failed:
    'CODE parked after a control-plane failure and waits for Boss to restart or resume it.',
  reviewFailed:
    'CODE stopped because review did not pass a phase and reports the failure with its last code-owned commit.',
  done: "CODE completed: every phase's review passed with no unsettled findings.",
} as const;

type StateKey = keyof typeof STATE_DESCRIPTIONS;

const RESUME_METADATA = {
  firstPhase: { sourceItem: 'CODE-1' },
  irTaskPhase: { sourceItem: 'CODE-3' },
} as const satisfies Record<
  ResumableStateId,
  { readonly sourceItem: PendingBossQuestion['sourceItem'] }
>;

const REVIEW_NOT_PASSED: CompactError = {
  name: 'ReviewNotPassed',
  message:
    'review returned a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings.',
};

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
    case 'directCommit':
      return isNonEmptyString(output.coderOutput) &&
        isNonEmptyString(output.latestCommit)
        ? {
            guard: 'directCommit',
            coderOutput: output.coderOutput,
            latestCommit: output.latestCommit,
          }
        : undefined;
    case 'irCommit':
      return isNonEmptyString(output.coderOutput) &&
        isNonEmptyString(output.latestCommit) &&
        isNonEmptyString(output.irNumber)
        ? {
            guard: 'irCommit',
            coderOutput: output.coderOutput,
            latestCommit: output.latestCommit,
            irNumber: output.irNumber,
          }
        : undefined;
    case 'moreTasks':
    case 'finalTask':
      return isNonEmptyString(output.coderOutput) &&
        isNonEmptyString(output.latestCommit) &&
        isNonEmptyString(output.irNumber) &&
        isNonEmptyString(output.irTask)
        ? {
            guard: output.guard,
            coderOutput: output.coderOutput,
            latestCommit: output.latestCommit,
            irNumber: output.irNumber,
            irTask: output.irTask,
          }
        : undefined;
    case 'needsBossReply':
      return isNonEmptyString(output.question)
        ? { guard: 'needsBossReply', question: output.question }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Strict JSON validation: null, booleans, finite numbers, strings, exact
 * arrays, and plain records of enumerable own data properties. Cycle
 * detection tracks only the active recursion path.
 */
function isJsonValue(value: unknown, path: Set<object> = new Set()): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  const container = value as object;
  if (path.has(container)) return false;
  path.add(container);
  try {
    if (Array.isArray(container)) {
      if (Object.getPrototypeOf(container) !== Array.prototype) return false;
      const keys = Reflect.ownKeys(container);
      if (keys.length !== container.length + 1) return false;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(container, 'length');
      if (
        lengthDescriptor === undefined ||
        lengthDescriptor.configurable !== false ||
        lengthDescriptor.enumerable !== false ||
        lengthDescriptor.value !== container.length
      ) {
        return false;
      }
      for (let index = 0; index < container.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(container, String(index));
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !('value' in descriptor) ||
          !isJsonValue(descriptor.value, path)
        ) {
          return false;
        }
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(container);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(container)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(container, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        !isJsonValue(descriptor.value, path)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    path.delete(container);
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
// Nested `review` results
// ---------------------------------------------------------------------------

/**
 * Source-authored acceptance on `review`'s declared public output: the
 * result returns the exact evaluated repository revision and affirmatively
 * establishes that no unsettled findings remain. The shared bridge correlates
 * the result with the supplied review scope.
 */
function reviewPassOf(event: unknown): ReviewPassOutput | undefined {
  const output = doneOutputOf(event);
  if (!isRecord(output)) return undefined;
  return output.noUnsettledFindings === true &&
    isNonEmptyString(output.evaluatedRevision)
    ? { noUnsettledFindings: true, evaluatedRevision: output.evaluatedRevision }
    : undefined;
}

/**
 * Recognizes an authored rejected child result: an aborted or error call, or
 * a child that completed at its own authored failure terminal.
 */
export function authoredChildResult(
  error: unknown,
  expectedPlaybookId: string,
): PlaybookCallResult | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const result = validatePlaybookCallResult(
      (error as Error & { result?: unknown }).result,
      expectedPlaybookId,
    );
    return result.status !== 'ok' || result.terminal?.kind === 'failure'
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}

/** Compact evidence and reported error for an authored review failure. */
function authoredReviewFailureOf(
  event: unknown,
):
  | { readonly evidence: CompletedReviewResult; readonly error: CompactError }
  | undefined {
  const result = authoredChildResult(actorErrorOf(event), REVIEW_PLAYBOOK_ID);
  if (result === undefined) return undefined;
  if (result.status === 'ok') {
    const description = result.terminal?.description;
    return {
      evidence: {
        playbookId: REVIEW_PLAYBOOK_ID,
        status: 'ok',
        ...(result.output === undefined ? {} : { output: result.output }),
      },
      error: {
        name: 'ReviewFailed',
        message: isNonEmptyString(description)
          ? `review ended at its authored failure terminal: ${description}`
          : 'review ended at its authored failure terminal.',
      },
    };
  }
  const error: CompactError =
    result.error !== undefined
      ? { name: result.error.name, message: result.error.message }
      : { name: 'AbortError', message: 'The review call was aborted.' };
  return {
    evidence: { playbookId: REVIEW_PLAYBOOK_ID, status: result.status, error },
    error,
  };
}

// ---------------------------------------------------------------------------
// Nested call text composition (quoted relays)
// ---------------------------------------------------------------------------

const REVIEW_PLACEHOLDER =
  /<caller-input>|<code-commit>|<coder-output>|<ir-task>/g;

/**
 * Composes review call text in one callback pass per template line: a quoted
 * relay line whose value is empty contributes no line, a multi-line value is
 * quoted line by line, and an absent value keeps its placeholder literal.
 */
function composeReviewText(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
): string {
  const lines: string[] = [];
  for (const line of template.split('\n')) {
    const quoted = line.startsWith('> ');
    const tokens = line.match(REVIEW_PLACEHOLDER) ?? [];
    if (quoted && tokens.some((token) => values[token] === '')) continue;
    lines.push(
      line.replace(REVIEW_PLACEHOLDER, (token: string) => {
        const value = values[token];
        if (value === undefined) return token;
        return quoted ? value.split('\n').join('\n> ') : value;
      }),
    );
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type EventArgs = { readonly event: unknown };
type ContextEventArgs = {
  readonly context: CodeContext;
  readonly event: unknown;
};
type MachineArgs = {
  readonly context: CodeContext;
  readonly event: CodeEvent;
};

const acceptsOutcome =
  (outcome: PhaseOutcome) =>
  ({ event }: EventArgs): boolean =>
    playerOutputOf(event)?.guard === outcome;

const needsBossReplyWithQuestion = ({ event }: EventArgs): boolean =>
  playerOutputOf(event)?.guard === 'needsBossReply';

// A review state is entered only through an accepting phase arm, which records
// the phase outcome and its non-empty code-owned commit.
const reviewPassedAfter =
  (outcome: PhaseOutcome) =>
  ({ context, event }: ContextEventArgs): boolean =>
    context.phaseOutcome === outcome &&
    isNonEmptyString(context.codeCommit) &&
    reviewPassOf(event) !== undefined;

const authoredReviewFailure = ({ event }: EventArgs): boolean =>
  authoredReviewFailureOf(event) !== undefined;

const validStartCode = ({ event }: MachineArgs): boolean =>
  event.type === 'START_CODE' &&
  isNonEmptyString(event.callerInput) &&
  (event.runResults === undefined || typeof event.runResults === 'string');

const repliesToPendingQuestion = ({ context, event }: MachineArgs): boolean =>
  event.type === 'BOSS_REPLY' &&
  context.pendingBossQuestion !== undefined &&
  (event.questionId === undefined ||
    event.questionId === context.pendingBossQuestion.questionId);

const emptyBossReply = (args: MachineArgs): boolean =>
  repliesToPendingQuestion(args) &&
  args.event.type === 'BOSS_REPLY' &&
  !isNonEmptyString(args.event.answer);

const INTERRUPT_PRECONDITIONS = {
  firstPhase: (context: CodeContext) => isNonEmptyString(context.callerInput),
  irTaskPhase: (context: CodeContext) =>
    isNonEmptyString(context.callerInput) &&
    isNonEmptyString(context.irNumber),
} as const satisfies Record<JumpableStateId, (context: CodeContext) => boolean>;

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

const bossReplyFields = (context: CodeContext) => ({
  ...(context.pendingBossQuestion !== undefined
    ? { pendingBossQuestion: context.pendingBossQuestion }
    : {}),
  ...(context.bossReply !== undefined ? { bossReply: context.bossReply } : {}),
});

const acceptedOutcome = (
  source: WorkingStateId,
  target: string,
  outcome: PhaseOutcome | 'needsBossReply',
) =>
  ({
    type: 'playbook.acceptedOutcome',
    params: { source, target, acceptedOutcome: outcome },
  }) as const;

const acceptPhaseArm = (
  source: WorkingStateId,
  outcome: PhaseOutcome,
  guard: 'acceptDirectCommit' | 'acceptIrCommit' | 'acceptMoreTasks' | 'acceptFinalTask',
  target: ReviewStateId,
) =>
  ({
    guard,
    target: `#${target}`,
    actions: [
      acceptedOutcome(source, target, outcome),
      'rememberPhaseCommit',
      'clearBossReplyContext',
    ],
  }) as const;

const suspendArm = (source: WorkingStateId) =>
  ({
    guard: 'needsBossReplyWithQuestion',
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

const reviewOnError = [
  {
    guard: 'authoredReviewFailure',
    target: '#reviewFailed',
    actions: 'rememberAuthoredReviewFailure',
  },
  { target: '#failed', actions: 'rememberActorError' },
] as const;

const meta = (stateId: StateKey, role?: CodeRole) => ({
  playbook: {
    stateId,
    description: STATE_DESCRIPTIONS[stateId],
    ...(role === undefined ? {} : { role }),
  },
});

const finalMeta = (
  stateId: 'reviewFailed' | 'done',
  terminal: 'success' | 'failure',
) => ({
  playbook: {
    stateId,
    description: STATE_DESCRIPTIONS[stateId],
    terminal,
  },
});

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export const codeMachine = setup({
  types: {
    context: {} as CodeContext,
    events: {} as CodeEvent,
    input: {} as CodeInput,
    output: {} as CodeOutput,
  },
  actors: {
    player: fromPromise<PlayerOutput, PlayerInput>(async () => {
      throw new Error('player actor must be provided by the runner');
    }),
    playbook: fromPromise<PlaybookOutput, PlaybookInput>(async () => {
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
    startCode: assign(({ context, event }) =>
      event.type === 'START_CODE'
        ? {
            callerInput: event.callerInput,
            runResults: event.runResults ?? context.runResults,
            codeCommit: undefined,
            coderOutput: undefined,
            irNumber: undefined,
            irTask: undefined,
            phaseOutcome: undefined,
            evaluatedRevision: undefined,
            previousPhaseReview: undefined,
            reviewError: undefined,
            reviewEvidence: undefined,
            lastError: undefined,
            pendingBossQuestion: undefined,
            bossReply: undefined,
          }
        : {},
    ),
    resetForInterrupt: assign({
      phaseOutcome: undefined,
      evaluatedRevision: undefined,
      previousPhaseReview: undefined,
      reviewError: undefined,
      reviewEvidence: undefined,
      lastError: undefined,
      pendingBossQuestion: undefined,
      bossReply: undefined,
    }),
    rememberPhaseCommit: assign(({ event }) => {
      const output = playerOutputOf(event);
      if (output === undefined || output.guard === 'needsBossReply') return {};
      return {
        codeCommit: output.latestCommit,
        coderOutput: output.coderOutput,
        phaseOutcome: output.guard,
        irNumber: output.guard === 'directCommit' ? undefined : output.irNumber,
        irTask:
          output.guard === 'moreTasks' || output.guard === 'finalTask'
            ? output.irTask
            : undefined,
        lastError: undefined,
      };
    }),
    setPendingBossQuestion: assign(
      ({ event }, params: { readonly resumeStateId: ResumableStateId }) => {
        const output = playerOutputOf(event);
        if (output?.guard !== 'needsBossReply') return {};
        const pendingBossQuestion: PendingBossQuestion = {
          questionId: params.resumeStateId,
          resumeStateId: params.resumeStateId,
          sourceItem: RESUME_METADATA[params.resumeStateId].sourceItem,
          asker: { kind: 'role', roleId: 'coder' },
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
    rememberReviewPass: assign(({ context, event }) => {
      const pass = reviewPassOf(event);
      return pass === undefined || context.codeCommit === undefined || context.phaseOutcome === undefined
        ? {}
        : {
            evaluatedRevision: pass.evaluatedRevision,
            previousPhaseReview: {
              phaseKind: context.phaseOutcome === 'directCommit'
                ? 'direct' as const : context.phaseOutcome === 'irCommit'
                ? 'new-intent' as const : 'ir-task' as const,
              phaseOutcome: context.phaseOutcome,
              scopeCommit: context.codeCommit,
              evaluatedRevision: pass.evaluatedRevision,
              ...(context.irNumber === undefined ? {} : { irNumber: context.irNumber }),
              ...(context.irTask === undefined ? {} : { irTask: context.irTask }),
            },
            lastError: undefined,
          };
    }),
    rememberReviewNotPassed: assign(({ event }) => {
      const output = doneOutputOf(event);
      const reviewEvidence: CompletedReviewResult = {
        playbookId: REVIEW_PLAYBOOK_ID,
        status: 'ok',
        ...(isJsonValue(output) ? { output } : {}),
      };
      return { reviewEvidence, reviewError: REVIEW_NOT_PASSED, lastError: undefined };
    }),
    rememberAuthoredReviewFailure: assign(({ event }) => {
      const failure = authoredReviewFailureOf(event);
      return failure === undefined
        ? {}
        : {
            reviewEvidence: failure.evidence,
            reviewError: failure.error,
            lastError: undefined,
          };
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
              ? 'Coder output declared needsBossReply without a question.'
              : 'Coder output did not match an outcome declared for the working state.',
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
    needsBossReplyWithQuestion,
    acceptDirectCommit: acceptsOutcome('directCommit'),
    acceptIrCommit: acceptsOutcome('irCommit'),
    acceptMoreTasks: acceptsOutcome('moreTasks'),
    acceptFinalTask: acceptsOutcome('finalTask'),
    reviewPassedDirect: reviewPassedAfter('directCommit'),
    reviewPassedNewIr: reviewPassedAfter('irCommit'),
    reviewPassedNonfinalTask: reviewPassedAfter('moreTasks'),
    reviewPassedFinalTask: reviewPassedAfter('finalTask'),
    authoredReviewFailure,
    validStartCode,
    emptyBossReply,
  },
}).createMachine({
  id: 'code',
  initial: 'ready',
  context: ({ input }): CodeContext => ({
    runResults: typeof input?.runResults === 'string' ? input.runResults : '',
  }),
  output: ({ context }): CodeOutput => {
    if (!isNonEmptyString(context.codeCommit)) {
      throw new Error(
        'CODE reached a final state without its last code-owned commit',
      );
    }
    if (context.reviewError !== undefined) {
      return {
        status: 'review-failed',
        lastCodeCommit: context.codeCommit,
        error: context.reviewError,
      };
    }
    if (!isNonEmptyString(context.evaluatedRevision)) {
      throw new Error('CODE completed without the final evaluated revision');
    }
    return {
      status: 'complete',
      lastCodeCommit: context.codeCommit,
      finalEvaluatedRevision: context.evaluatedRevision,
      allReviewsPassed: true,
    };
  },
  on: {
    BOSS_INTERRUPT: bossInterrupts(['firstPhase', 'irTaskPhase'] as const),
  },
  states: {
    ready: {
      id: 'ready',
      tags: 'playbook.parked',
      description: STATE_DESCRIPTIONS.ready,
      meta: meta('ready'),
      on: {
        START_CODE: {
          guard: 'validStartCode',
          target: 'firstPhase',
          actions: 'startCode',
        },
      },
    },
    firstPhase: {
      id: 'firstPhase',
      tags: 'playbook.busy',
      description: STATE_DESCRIPTIONS.firstPhase,
      meta: meta('firstPhase', 'coder'),
      invoke: {
        src: 'player',
        input: ({ context }): FirstPhasePlayerInput => ({
          stateId: 'firstPhase',
          role: 'coder',
          sourceItem: 'CODE-1',
          prompt: FIRST_PHASE_PROMPT,
          result: FIRST_PHASE_RESULT,
          ...(context.callerInput !== undefined
            ? { callerInput: context.callerInput }
            : {}),
          runResults: context.runResults,
          ...bossReplyFields(context),
        }),
        onDone: [
          suspendArm('firstPhase'),
          acceptPhaseArm(
            'firstPhase',
            'directCommit',
            'acceptDirectCommit',
            'reviewNewIntentPhase',
          ),
          acceptPhaseArm(
            'firstPhase',
            'irCommit',
            'acceptIrCommit',
            'reviewNewIntentPhase',
          ),
          acceptPhaseArm(
            'firstPhase',
            'moreTasks',
            'acceptMoreTasks',
            'reviewIrTaskPhase',
          ),
          acceptPhaseArm(
            'firstPhase',
            'finalTask',
            'acceptFinalTask',
            'reviewIrTaskPhase',
          ),
          malformedPlayerOutputArm,
        ],
        onError: playerOnError,
      },
    },
    reviewNewIntentPhase: {
      id: 'reviewNewIntentPhase',
      tags: 'playbook.suspended',
      description: STATE_DESCRIPTIONS.reviewNewIntentPhase,
      meta: meta('reviewNewIntentPhase'),
      invoke: {
        src: 'playbook',
        input: ({ context }): PlaybookInput => ({
          stateId: 'reviewNewIntentPhase',
          sourceItem: 'CODE-2',
          playbookId: REVIEW_PLAYBOOK_ID,
          text: composeReviewText(REVIEW_NEW_INTENT_PHASE_TEMPLATE, {
            '<caller-input>': context.callerInput,
            '<code-commit>': context.codeCommit,
            '<coder-output>': context.coderOutput,
          }),
        }),
        onDone: [
          {
            guard: 'reviewPassedDirect',
            target: 'done',
            actions: 'rememberReviewPass',
          },
          {
            guard: 'reviewPassedNewIr',
            target: 'irTaskPhase',
            actions: 'rememberReviewPass',
          },
          { target: 'reviewFailed', actions: 'rememberReviewNotPassed' },
        ],
        onError: reviewOnError,
      },
    },
    irTaskPhase: {
      id: 'irTaskPhase',
      tags: 'playbook.busy',
      description: STATE_DESCRIPTIONS.irTaskPhase,
      meta: meta('irTaskPhase', 'coder'),
      invoke: {
        src: 'player',
        input: ({ context }): IrTaskPhasePlayerInput => ({
          stateId: 'irTaskPhase',
          role: 'coder',
          sourceItem: 'CODE-3',
          prompt: IR_TASK_PHASE_PROMPT,
          result: IR_TASK_PHASE_RESULT,
          ...(context.callerInput !== undefined
            ? { callerInput: context.callerInput }
            : {}),
          ...(context.irNumber !== undefined
            ? { irNumber: context.irNumber }
            : {}),
          runResults: context.runResults,
          previousPhaseReview: context.previousPhaseReview === undefined
            ? 'No accepted prior-phase review is available.'
            : JSON.stringify(context.previousPhaseReview),
          ...bossReplyFields(context),
        }),
        onDone: [
          suspendArm('irTaskPhase'),
          acceptPhaseArm(
            'irTaskPhase',
            'moreTasks',
            'acceptMoreTasks',
            'reviewIrTaskPhase',
          ),
          acceptPhaseArm(
            'irTaskPhase',
            'finalTask',
            'acceptFinalTask',
            'reviewIrTaskPhase',
          ),
          malformedPlayerOutputArm,
        ],
        onError: playerOnError,
      },
    },
    reviewIrTaskPhase: {
      id: 'reviewIrTaskPhase',
      tags: 'playbook.suspended',
      description: STATE_DESCRIPTIONS.reviewIrTaskPhase,
      meta: meta('reviewIrTaskPhase'),
      invoke: {
        src: 'playbook',
        input: ({ context }): PlaybookInput => ({
          stateId: 'reviewIrTaskPhase',
          sourceItem: 'CODE-4',
          playbookId: REVIEW_PLAYBOOK_ID,
          text: composeReviewText(REVIEW_IR_TASK_PHASE_TEMPLATE, {
            '<caller-input>': context.callerInput,
            '<code-commit>': context.codeCommit,
            '<coder-output>': context.coderOutput,
            '<ir-task>': context.irTask,
          }),
        }),
        onDone: [
          {
            guard: 'reviewPassedNonfinalTask',
            target: 'irTaskPhase',
            actions: 'rememberReviewPass',
          },
          {
            guard: 'reviewPassedFinalTask',
            target: 'done',
            actions: 'rememberReviewPass',
          },
          { target: 'reviewFailed', actions: 'rememberReviewNotPassed' },
        ],
        onError: reviewOnError,
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
          ...resumableStates(['firstPhase', 'irTaskPhase'] as const),
        ],
        START_CODE: {
          guard: 'validStartCode',
          target: 'firstPhase',
          actions: 'startCode',
        },
      },
    },
    failed: {
      id: 'failed',
      tags: 'playbook.parked',
      description: STATE_DESCRIPTIONS.failed,
      meta: meta('failed'),
      on: {
        START_CODE: {
          guard: 'validStartCode',
          target: 'firstPhase',
          actions: 'startCode',
        },
      },
    },
    reviewFailed: {
      id: 'reviewFailed',
      type: 'final',
      description: STATE_DESCRIPTIONS.reviewFailed,
      meta: finalMeta('reviewFailed', 'failure'),
    },
    done: {
      id: 'done',
      type: 'final',
      description: STATE_DESCRIPTIONS.done,
      meta: finalMeta('done', 'success'),
    },
  },
});

export default codeMachine;
