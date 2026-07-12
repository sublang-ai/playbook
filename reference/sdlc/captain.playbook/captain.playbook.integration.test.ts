// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import createPlaybookRuntime, {
  _internal,
  type CaptainCallOptions,
  type CaptainResult,
  type JsonValue,
  type PlaybookCallRequest,
  type PlaybookCallResult,
  type PlaybookCallStart,
  type PlaybookPorts,
  type PlaybookRunResult,
  type PlaybookRuntime,
  type PlaybookSession,
  type PlaybookTraceEvent,
  type PlaybookTraceType,
} from './captain.playbook.js';
import type { CaptainInput } from './captain.fsm.js';

const ENABLED_PLAYBOOKS = [
  {
    id: 'code',
    command: 'code',
    intent: 'Implement and review a software change.',
  },
  {
    id: 'discuss',
    command: 'discuss',
    intent: 'Develop independent proposals and synthesize them.',
  },
] as const;

type JudgeReply = string | Readonly<Record<string, unknown>>;
type CaptainStep =
  | CaptainResult
  | ((
      prompt: string,
      signal: AbortSignal,
      options: CaptainCallOptions,
    ) => CaptainResult | Promise<CaptainResult>);
type ChildStep =
  | PlaybookCallStart
  | ((
      request: PlaybookCallRequest,
      signal: AbortSignal,
    ) => PlaybookCallStart | Promise<PlaybookCallStart>);

interface HarnessScript {
  readonly classifications?: readonly JudgeReply[];
  readonly adjudications?: readonly JudgeReply[];
  readonly captains?: readonly CaptainStep[];
  readonly children?: readonly ChildStep[];
  readonly delayedEmissions?: boolean;
  readonly rejectTraceType?: PlaybookTraceType;
}

interface CaptainInvocation {
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly options: CaptainCallOptions;
}

interface JudgeInvocation {
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly purpose: 'classification' | 'adjudication';
}

interface ChildInvocation {
  readonly request: PlaybookCallRequest;
  readonly signal: AbortSignal;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function within<T>(
  promise: Promise<T>,
  milliseconds = 2_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(`Operation did not settle within ${milliseconds}ms`),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function encodeJudgeReply(reply: JudgeReply): string {
  return typeof reply === 'string' ? reply : JSON.stringify(reply);
}

function shiftRequired<T>(steps: T[], label: string): T {
  const step = steps.shift();
  if (step === undefined) {
    throw new Error(`Unexpected ${label} call`);
  }
  return step;
}

function isTraceTelemetry(event: {
  readonly topic: string;
  readonly payload: unknown;
}): event is {
  readonly topic: 'playbook.trace';
  readonly payload: PlaybookTraceEvent;
} {
  return event.topic === 'playbook.trace';
}

function tracePayload(trace: PlaybookTraceEvent): Record<string, unknown> {
  return trace.payload as Record<string, unknown>;
}

let sessionSequence = 0;

function nextSessionId(): string {
  sessionSequence += 1;
  return `00000000-0000-4000-8000-${String(sessionSequence).padStart(12, '0')}`;
}

function makeSession(
  ports: PlaybookPorts,
  sessionId = nextSessionId(),
): PlaybookSession {
  return {
    sessionId,
    playbookId: 'captain',
    rootSessionId: sessionId,
    depth: 0,
    ports,
  };
}

function intentClassification(text: string): JudgeReply {
  return { type: 'BOSS_INTENT', bossIntent: text };
}

function delegation(
  playbookId: string,
  text: string,
  remainingPlan: readonly JsonValue[] = [],
): JudgeReply {
  return {
    guard: 'delegation',
    remainingPlan,
    nextPlaybookId: playbookId,
    nextPlaybookInput: text,
  };
}

function continuation(
  playbookId: string,
  text: string,
  remainingPlan: readonly JsonValue[] = [],
): JudgeReply {
  return {
    guard: 'continuing',
    remainingPlan,
    nextPlaybookId: playbookId,
    nextPlaybookInput: text,
  };
}

function directResponse(response: string): JudgeReply {
  return { guard: 'direct', response };
}

function finalResponse(response: string): JudgeReply {
  return { guard: 'final', response };
}

function settledSuccess(
  playbookId: string,
  childSessionId: string,
  output: JsonValue,
): PlaybookCallStart {
  return {
    state: 'settled',
    result: { status: 'ok', playbookId, childSessionId, output },
  };
}

function makeHarness(script: HarnessScript = {}) {
  const classifications = [...(script.classifications ?? [])];
  const adjudications = [...(script.adjudications ?? [])];
  const captains = [...(script.captains ?? [])];
  const children = [...(script.children ?? [])];

  const captainCalls: CaptainInvocation[] = [];
  const judgeCalls: JudgeInvocation[] = [];
  const childCalls: ChildInvocation[] = [];
  const statuses: Array<{ readonly message: string; readonly data?: unknown }> =
    [];
  const telemetry: Array<{
    readonly topic: string;
    readonly payload: unknown;
  }> = [];
  const order: string[] = [];
  let activeEmissions = 0;
  let maxConcurrentEmissions = 0;
  let activeChildCalls = 0;
  let maxConcurrentChildCalls = 0;
  let traceRejected = false;

  async function recordEmission(
    label: string,
    record: () => void,
  ): Promise<void> {
    activeEmissions += 1;
    maxConcurrentEmissions = Math.max(maxConcurrentEmissions, activeEmissions);
    order.push(label);
    try {
      if (script.delayedEmissions) await delay(1);
      record();
    } finally {
      activeEmissions -= 1;
    }
  }

  const ports: PlaybookPorts = {
    callPlayer: async () => {
      throw new Error('The generic Captain must not call a player port');
    },
    callCaptain: async (prompt, signal, options) => {
      const invocation = { prompt, signal, options };
      captainCalls.push(invocation);
      const callNumber = captainCalls.length;
      order.push(`host:captain:${callNumber}:started`);
      try {
        const step = shiftRequired(captains, 'Captain');
        return typeof step === 'function'
          ? await step(prompt, signal, options)
          : step;
      } finally {
        order.push(`host:captain:${callNumber}:finished`);
      }
    },
    callJudge: async (prompt, signal) => {
      const purpose = prompt.includes('Classify the Boss text')
        ? 'classification'
        : 'adjudication';
      judgeCalls.push({ prompt, signal, purpose });
      const callNumber = judgeCalls.length;
      order.push(`host:judge:${callNumber}:started`);
      try {
        const reply =
          purpose === 'classification'
            ? shiftRequired(classifications, 'classification judge')
            : shiftRequired(adjudications, 'adjudication judge');
        return encodeJudgeReply(reply);
      } finally {
        order.push(`host:judge:${callNumber}:finished`);
      }
    },
    callPlaybook: async (request, signal) => {
      childCalls.push({ request, signal });
      const callNumber = childCalls.length;
      activeChildCalls += 1;
      maxConcurrentChildCalls = Math.max(
        maxConcurrentChildCalls,
        activeChildCalls,
      );
      order.push(`host:playbook:${callNumber}:started`);
      try {
        const step = shiftRequired(children, 'child playbook');
        return typeof step === 'function' ? await step(request, signal) : step;
      } finally {
        activeChildCalls -= 1;
        order.push(`host:playbook:${callNumber}:finished`);
      }
    },
    emitStatus: async (message, data) => {
      await recordEmission('emit:status', () => {
        statuses.push(data === undefined ? { message } : { message, data });
      });
    },
    emitTelemetry: async (event) => {
      let label = 'emit:state';
      if (isTraceTelemetry(event)) {
        label = `emit:trace:${event.payload.type}:${event.payload.sequence}`;
      }
      await recordEmission(label, () => telemetry.push(event));
      if (
        !traceRejected &&
        isTraceTelemetry(event) &&
        event.payload.type === script.rejectTraceType
      ) {
        traceRejected = true;
        throw new Error(`Injected ${event.payload.type} trace sink failure`);
      }
    },
  };

  return {
    ports,
    captainCalls,
    judgeCalls,
    childCalls,
    statuses,
    telemetry,
    order,
    get traces(): readonly PlaybookTraceEvent[] {
      return telemetry.filter(isTraceTelemetry).map((event) => event.payload);
    },
    get maxConcurrentEmissions(): number {
      return maxConcurrentEmissions;
    },
    get maxConcurrentChildCalls(): number {
      return maxConcurrentChildCalls;
    },
  };
}

async function initRuntime(
  harness: ReturnType<typeof makeHarness>,
  enabledPlaybooks: readonly (typeof ENABLED_PLAYBOOKS)[number][] = ENABLED_PLAYBOOKS,
): Promise<PlaybookRuntime> {
  const runtime = createPlaybookRuntime({
    enabledPlaybooks,
  });
  await runtime.init(makeSession(harness.ports));
  return runtime;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function expectTerminalResponse(
  result: PlaybookRunResult,
  response: string,
): void {
  expect(result).toMatchObject({
    outcome: 'terminal',
    state: { status: 'done', quiescent: true },
    output: { response },
  });
}

function expectPairedCalls(
  traces: readonly PlaybookTraceEvent[],
  kind: 'captain' | 'judge' | 'player' | 'playbook',
): void {
  const starts = traces.filter(
    (trace) => trace.type === `${kind}.call.started`,
  );
  const finishes = traces.filter(
    (trace) => trace.type === `${kind}.call.finished`,
  );
  expect(finishes.map((trace) => trace.callId)).toEqual(
    starts.map((trace) => trace.callId),
  );
  expect(new Set(starts.map((trace) => trace.callId)).size).toBe(starts.length);
}

describe('compiled default Captain runtime', () => {
  it('attempts session disposal when initialization telemetry records then rejects', async () => {
    const harness = makeHarness({ rejectTraceType: 'session.started' });
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: ENABLED_PLAYBOOKS,
    });
    const failedSessionId = nextSessionId();

    await expect(
      runtime.init(makeSession(harness.ports, failedSessionId)),
    ).rejects.toThrow('Injected session.started trace sink failure');
    expect(harness.traces.map((trace) => trace.type)).toEqual([
      'session.started',
      'session.disposed',
    ]);

    const retrySessionId = nextSessionId();
    await expect(
      runtime.init(makeSession(harness.ports, retrySessionId)),
    ).resolves.toBeUndefined();
    expect(
      harness.traces.filter((trace) => trace.sessionId === retrySessionId)[0],
    ).toMatchObject({ sequence: 1, type: 'session.started' });
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it('suppresses teardown snapshots after an initialization transition sink failure', async () => {
    const harness = makeHarness({ rejectTraceType: 'fsm.transition' });
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: ENABLED_PLAYBOOKS,
    });
    const failedSessionId = nextSessionId();

    await expect(
      runtime.init(makeSession(harness.ports, failedSessionId)),
    ).rejects.toThrow('Injected fsm.transition trace sink failure');
    expect(
      harness.traces.filter(
        (trace) =>
          trace.sessionId === failedSessionId &&
          trace.type === 'fsm.transition',
      ),
    ).toHaveLength(1);

    const retrySessionId = nextSessionId();
    await expect(
      runtime.init(makeSession(harness.ports, retrySessionId)),
    ).resolves.toBeUndefined();
    expect(
      harness.traces.filter((trace) => trace.sessionId === retrySessionId)[0],
    ).toMatchObject({ sequence: 1, type: 'session.started' });
    await runtime.dispose();
  });

  it('returns one terminal direct response without a second visible presentation', async () => {
    const harness = makeHarness({
      classifications: [intentClassification('Explain the trade-off.')],
      captains: [{ status: 'ok', finalText: 'Use the simpler option.' }],
      adjudications: [directResponse('Use the simpler option.')],
    });
    const runtime = await initRuntime(harness);
    expect(harness.statuses).toHaveLength(0);

    expect(harness.traces[0]).toMatchObject({
      type: 'session.started',
      payload: {
        stateId: 'ready',
        state: {
          value: 'ready',
          activeStateIds: ['ready'],
          quiescent: true,
        },
      },
    });

    const result = await runtime.handleBossInput({
      text: 'Explain the trade-off.',
      signal: signal(),
    });

    expectTerminalResponse(result, 'Use the simpler option.');
    expect(harness.captainCalls).toHaveLength(1);
    expect(harness.captainCalls[0].options).toEqual({ visibility: 'visible' });
    expect(
      harness.traces.filter((trace) => trace.type === 'captain.call.started'),
    ).toHaveLength(1);
    expectPairedCalls(harness.traces, 'captain');
    expect(
      harness.traces
        .filter((trace) => trace.type.startsWith('judge.call.'))
        .every((trace) => typeof tracePayload(trace).stateId === 'string'),
    ).toBe(true);
    expect(harness.traces.at(-1)).toMatchObject({
      type: 'boss.input.settled',
      payload: {
        outcome: 'terminal',
        stateId: 'done',
        output: { response: 'Use the simpler option.' },
      },
    });
    expect(
      harness.statuses.some(
        ({ data }) =>
          (data as { readonly stateId?: unknown } | undefined)?.stateId ===
          'done',
      ),
    ).toBe(false);
    expect(
      harness.traces
        .filter((trace) => trace.type === 'status.emitted')
        .every(
          (trace) =>
            trace.turnId === 1 &&
            typeof tracePayload(trace).stateId === 'string' &&
            typeof tracePayload(trace).state === 'object',
        ),
    ).toBe(true);
    await runtime.dispose();
  });

  it.each([
    {
      label: 'surrounding prose with earlier bracket fragments',
      reply:
        'Ignore [draft] and {n/a}. Intended: {"type":"BOSS_INTENT","bossIntent":"prose classification"} Thanks.',
      bossIntent: 'prose classification',
    },
    {
      label: 'a Markdown fence amid prose',
      reply:
        'Result follows:\n```json\n{"type":"BOSS_INTENT","bossIntent":"fenced classification"}\n```\nDone.',
      bossIntent: 'fenced classification',
    },
    {
      label: 'a trailing comma before a later clean decoy',
      reply:
        '{"type":"BOSS_INTENT","bossIntent":"trailing classification",} Ignore {"type":"NO_ACTION"}',
      bossIntent: 'trailing classification',
    },
    {
      label: 'a truncated object',
      reply: '{"type":"BOSS_INTENT","bossIntent":"truncated classification"',
      bossIntent: 'truncated classification',
    },
    {
      label: 'an unterminated string',
      reply: '{"type":"BOSS_INTENT","bossIntent":"unterminated classification',
      bossIntent: 'unterminated classification',
    },
  ])('recovers classifier JSON from $label', async ({ reply, bossIntent }) => {
    const harness = makeHarness({
      classifications: [reply],
      captains: [{ status: 'ok', finalText: 'Recovered classification.' }],
      adjudications: [directResponse('Recovered classification.')],
    });
    const runtime = await initRuntime(harness);

    const result = await runtime.handleBossInput({
      text: 'Route this messy classifier reply.',
      signal: signal(),
    });

    expectTerminalResponse(result, 'Recovered classification.');
    expect(harness.captainCalls[0].prompt).toContain(
      `Boss intent: ${bossIntent}`,
    );
    await runtime.dispose();
  });

  it.each([
    {
      label: 'surrounding prose with earlier bracket fragments',
      reply:
        'Ignore [draft] and {n/a}. Intended: {"guard":"direct","response":"prose adjudication"} Thanks.',
      response: 'prose adjudication',
    },
    {
      label: 'a Markdown fence amid prose',
      reply:
        'Result follows:\n```json\n{"guard":"direct","response":"fenced adjudication"}\n```\nDone.',
      response: 'fenced adjudication',
    },
    {
      label: 'a trailing comma before a later clean decoy',
      reply:
        '{"guard":"direct","response":"trailing adjudication",} Ignore {"guard":"direct","response":"decoy"}',
      response: 'trailing adjudication',
    },
    {
      label: 'a truncated object',
      reply: '{"guard":"direct","response":"truncated adjudication"',
      response: 'truncated adjudication',
    },
    {
      label: 'an unterminated string',
      reply: '{"guard":"direct","response":"unterminated adjudication',
      response: 'unterminated adjudication',
    },
  ])('recovers adjudicator JSON from $label', async ({ reply, response }) => {
    const harness = makeHarness({
      classifications: [intentClassification('Adjudicate this output.')],
      captains: [{ status: 'ok', finalText: 'Visible Captain output.' }],
      adjudications: [reply],
    });
    const runtime = await initRuntime(harness);

    const result = await runtime.handleBossInput({
      text: 'Adjudicate this output.',
      signal: signal(),
    });

    expectTerminalResponse(result, response);
    await runtime.dispose();
  });

  it.each([
    { label: 'unrecoverable prose', reply: 'no JSON here' },
    { label: 'a non-object JSON value', reply: '["NO_ACTION"]' },
    { label: 'an unknown event', reply: { type: 'UNKNOWN_EVENT' } },
    {
      label: 'a reply without a pending question',
      reply: { type: 'BOSS_REPLY', answer: 'orphan reply' },
    },
  ])('emits exactly one status and no event for $label', async ({ reply }) => {
    const harness = makeHarness({ classifications: [reply] });
    const runtime = await initRuntime(harness);
    const statusCount = harness.statuses.length;
    const transitionCount = harness.traces.filter(
      (trace) => trace.type === 'fsm.transition',
    ).length;

    const result = await runtime.handleBossInput({
      text: 'This classification is invalid.',
      signal: signal(),
    });

    expect(result).toMatchObject({
      outcome: 'no-action',
      state: { stateId: 'ready', quiescent: true },
    });
    const recoveryStatuses = harness.statuses.slice(statusCount);
    expect(recoveryStatuses).toHaveLength(1);
    expect(recoveryStatuses[0].message).toContain(
      'Boss input was not actionable',
    );
    expect(
      harness.traces.filter((trace) => trace.type === 'fsm.transition'),
    ).toHaveLength(transitionCount);
    expect(harness.captainCalls).toHaveLength(0);
    expectPairedCalls(harness.traces, 'judge');
    await runtime.dispose();
  });

  it('resumes its own clarification on the same runtime with exact question and answer', async () => {
    const question = 'Should implementation or discussion happen first?';
    const answer = 'Implement first.';
    const intent = 'Implement the idea and then compare alternatives.';
    const harness = makeHarness({
      classifications: [
        intentClassification(intent),
        { type: 'BOSS_REPLY', answer },
      ],
      captains: [
        { status: 'ok', finalText: question },
        { status: 'ok', finalText: 'I will start with implementation.' },
      ],
      adjudications: [
        { guard: 'needsBossReply', question },
        directResponse('I will start with implementation.'),
      ],
    });
    const runtime = await initRuntime(harness);

    const parked = await runtime.handleBossInput({
      text: intent,
      signal: signal(),
    });
    expect(parked).toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply', quiescent: true },
    });

    const completed = await runtime.handleBossInput({
      text: answer,
      signal: signal(),
    });
    expectTerminalResponse(completed, 'I will start with implementation.');
    expect(harness.captainCalls).toHaveLength(2);
    expect(harness.judgeCalls[2]).toMatchObject({ purpose: 'classification' });
    expect(harness.judgeCalls[2].prompt).toContain(question);

    const expectedPrefix = [
      'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.',
      '',
      'Boss question:',
      question,
      '',
      'Boss reply:',
      answer,
      '',
    ].join('\n');
    expect(harness.captainCalls[1].prompt.startsWith(expectedPrefix)).toBe(
      true,
    );
    expect(harness.captainCalls[1].prompt).toContain(`Boss intent: ${intent}`);
    expect(
      harness.traces.every(
        (trace) => trace.sessionId === harness.traces[0].sessionId,
      ),
    ).toBe(true);
    await runtime.dispose();
  });

  it('rejects an interrupt back into awaitBossReply without clearing the pending question', async () => {
    const question = 'Which implementation constraint matters most?';
    const answer = 'Preserve compatibility.';
    const harness = makeHarness({
      classifications: [
        intentClassification('Implement after clarifying constraints.'),
        { type: 'BOSS_INTERRUPT', targetId: 'awaitBossReply' },
        { type: 'BOSS_REPLY', answer },
      ],
      captains: [
        { status: 'ok', finalText: question },
        { status: 'ok', finalText: 'I will preserve compatibility.' },
      ],
      adjudications: [
        { guard: 'needsBossReply', question },
        directResponse('I will preserve compatibility.'),
      ],
    });
    const runtime = await initRuntime(harness);
    const parked = await runtime.handleBossInput({
      text: 'Implement after clarifying constraints.',
      signal: signal(),
    });
    expect(parked).toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply', quiescent: true },
    });
    const statusCount = harness.statuses.length;
    const transitionCount = harness.traces.filter(
      (trace) => trace.type === 'fsm.transition',
    ).length;

    const rejectedInterrupt = await runtime.handleBossInput({
      text: 'Jump back into the same wait state.',
      signal: signal(),
    });

    expect(rejectedInterrupt).toMatchObject({
      outcome: 'no-action',
      state: { stateId: 'awaitBossReply', quiescent: true },
    });
    const recoveryStatuses = harness.statuses.slice(statusCount);
    expect(recoveryStatuses).toHaveLength(1);
    expect(recoveryStatuses[0].message).toContain(
      'Boss input was not actionable',
    );
    expect(
      harness.traces.filter((trace) => trace.type === 'fsm.transition'),
    ).toHaveLength(transitionCount);
    expect(harness.captainCalls).toHaveLength(1);
    expect(harness.judgeCalls[2].prompt).toContain(
      'BOSS_INTERRUPT with targetId exactly "routing"',
    );

    const completed = await runtime.handleBossInput({
      text: answer,
      signal: signal(),
    });
    expectTerminalResponse(completed, 'I will preserve compatibility.');
    expect(harness.captainCalls[1].prompt).toContain(question);
    expect(harness.captainCalls[1].prompt).toContain(answer);
    await runtime.dispose();
  });

  it('accepts a fresh routing interrupt while parked and clears the old question', async () => {
    const question = 'Which constraint should govern the original intent?';
    const freshIntent = 'Explain the replacement approach directly.';
    const harness = makeHarness({
      classifications: [
        intentClassification('Clarify the original intent.'),
        {
          type: 'BOSS_INTERRUPT',
          targetId: 'routing',
          bossIntent: freshIntent,
        },
      ],
      captains: [
        { status: 'ok', finalText: question },
        { status: 'ok', finalText: 'Use the replacement approach.' },
      ],
      adjudications: [
        { guard: 'needsBossReply', question },
        directResponse('Use the replacement approach.'),
      ],
    });
    const runtime = await initRuntime(harness);

    const parked = await runtime.handleBossInput({
      text: 'Clarify the original intent.',
      signal: signal(),
    });
    expect(parked).toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply', quiescent: true },
    });

    const completed = await runtime.handleBossInput({
      text: freshIntent,
      signal: signal(),
    });
    expectTerminalResponse(completed, 'Use the replacement approach.');
    expect(harness.captainCalls[1].prompt).toContain(
      `Boss intent: ${freshIntent}`,
    );
    expect(harness.captainCalls[1].prompt).not.toContain(question);
    expect(harness.captainCalls[1].prompt).not.toContain(
      'You previously paused this task',
    );
    await runtime.dispose();
  });

  it('executes one child and reassesses its actual output before completing', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000001';
    const harness = makeHarness({
      classifications: [intentClassification('Implement the fix.')],
      captains: [
        { status: 'ok', finalText: 'I will use CODE.' },
        { status: 'ok', finalText: 'The fix is complete.' },
      ],
      adjudications: [
        delegation('code', 'Implement the fix with tests.'),
        finalResponse('The fix is complete.'),
      ],
      children: [
        settledSuccess('code', childSessionId, { summary: 'tests pass' }),
      ],
    });
    const runtime = await initRuntime(harness);

    const result = await within(
      runtime.handleBossInput({
        text: 'Implement the fix.',
        signal: signal(),
      }),
      2_000,
    );

    expectTerminalResponse(result, 'The fix is complete.');
    expect(harness.childCalls.map((call) => call.request)).toEqual([
      expect.objectContaining({
        playbookId: 'code',
        text: 'Implement the fix with tests.',
      }),
    ]);
    expect(harness.captainCalls[1].prompt).toContain(
      'Completed call results: [{"output":{"summary":"tests pass"},"playbookId":"code","status":"ok"}]',
    );
    expectPairedCalls(harness.traces, 'playbook');
    await runtime.dispose();
  });

  it('executes a revised multi-child plan strictly one child at a time', async () => {
    const harness = makeHarness({
      classifications: [intentClassification('Implement, then compare.')],
      captains: [
        { status: 'ok', finalText: 'First I will implement.' },
        { status: 'ok', finalText: 'Now I will compare proposals.' },
        { status: 'ok', finalText: 'Both steps are complete.' },
      ],
      adjudications: [
        delegation('code', 'Implement the requested change.', [
          { playbookId: 'discuss', purpose: 'Compare alternatives.' },
        ]),
        continuation(
          'discuss',
          'Compare alternatives using the implementation.',
          [],
        ),
        finalResponse('Both steps are complete.'),
      ],
      children: [
        settledSuccess('code', '10000000-0000-4000-8000-000000000002', {
          commit: 'abc123',
        }),
        settledSuccess('discuss', '10000000-0000-4000-8000-000000000003', {
          recommendation: 'keep it simple',
        }),
      ],
    });
    const runtime = await initRuntime(harness);

    const result = await within(
      runtime.handleBossInput({
        text: 'Implement, then compare.',
        signal: signal(),
      }),
      2_000,
    );

    expectTerminalResponse(result, 'Both steps are complete.');
    expect(harness.childCalls.map((call) => call.request.playbookId)).toEqual([
      'code',
      'discuss',
    ]);
    expect(harness.childCalls.map((call) => call.request.text)).toEqual([
      'Implement the requested change.',
      'Compare alternatives using the implementation.',
    ]);
    expect(harness.maxConcurrentChildCalls).toBe(1);
    await runtime.dispose();
  });

  it('rejects an equivalent completed child call before reinvocation', async () => {
    const repeatedText = 'Implement the requested change.';
    const harness = makeHarness({
      classifications: [intentClassification('Implement once.')],
      captains: [
        { status: 'ok', finalText: 'I will implement it.' },
        { status: 'ok', finalText: 'I will repeat the same call.' },
      ],
      adjudications: [
        delegation('code', repeatedText, [
          { playbookId: 'code', purpose: 'Only if new evidence requires it.' },
        ]),
        continuation('code', repeatedText),
      ],
      children: [
        settledSuccess('code', '10000000-0000-4000-8000-000000000004', {
          summary: 'implemented',
        }),
      ],
    });
    const runtime = await initRuntime(harness);

    const result = await runtime.handleBossInput({
      text: 'Implement once.',
      signal: signal(),
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(harness.childCalls).toHaveLength(1);
    await runtime.dispose();
  });

  it('rejects a continuation whose remaining plan does not shrink', async () => {
    const unchangedPlan = [
      { playbookId: 'discuss', purpose: 'Compare the implementation.' },
    ];
    const harness = makeHarness({
      classifications: [intentClassification('Implement with a bounded plan.')],
      captains: [
        { status: 'ok', finalText: 'I will implement first.' },
        { status: 'ok', finalText: 'I will keep extending the plan.' },
      ],
      adjudications: [
        delegation('code', 'Implement the bounded change.', unchangedPlan),
        continuation(
          'discuss',
          'Compare the bounded implementation.',
          unchangedPlan,
        ),
      ],
      children: [
        settledSuccess('code', '10000000-0000-4000-8000-000000000009', {
          summary: 'implemented',
        }),
      ],
    });
    const runtime = await initRuntime(harness);

    const result = await runtime.handleBossInput({
      text: 'Implement with a bounded plan.',
      signal: signal(),
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed', tags: ['playbook.parked'] },
    });
    expect(harness.childCalls).toHaveLength(1);
    await runtime.dispose();
  });

  it.each([
    { delivery: 'immediate', status: 'aborted' },
    { delivery: 'immediate', status: 'error' },
    { delivery: 'resumed', status: 'aborted' },
    { delivery: 'resumed', status: 'error' },
  ] as const)(
    'sanitizes $delivery child $status evidence before Captain reassessment',
    async ({ delivery, status }) => {
      const childSessionId = '10000000-0000-4000-8000-000000000004';
      const error =
        status === 'aborted'
          ? {
              name: 'AbortError',
              message: 'Boss stopped the child.',
              stack: 'SECRET_CHILD_STACK',
            }
          : {
              name: 'ChildFailure',
              message: 'The child could not finish.',
              stack: 'SECRET_CHILD_STACK',
            };
      const childResult: PlaybookCallResult = {
        status,
        playbookId: 'code',
        childSessionId,
        state: {
          value: 'privateChildState',
          stateId: 'privateChildState',
          activeStateIds: ['privateChildState'],
          tags: ['private-tag'],
          status: 'error',
          quiescent: true,
        },
        error,
      };
      const childStart: PlaybookCallStart =
        delivery === 'immediate'
          ? { state: 'settled', result: childResult }
          : { state: 'suspended', childSessionId };
      const harness = makeHarness({
        classifications: [intentClassification('Try the implementation.')],
        captains: [
          { status: 'ok', finalText: 'I will try CODE.' },
          { status: 'ok', finalText: 'I accounted for the child result.' },
        ],
        adjudications: [
          delegation('code', 'Try the implementation.'),
          finalResponse('I accounted for the child result.'),
        ],
        children: [childStart],
      });
      const runtime = await initRuntime(harness);

      const opened = await within(
        runtime.handleBossInput({
          text: 'Try the implementation.',
          signal: signal(),
        }),
        2_000,
      );
      let completed = opened;
      if (delivery === 'resumed') {
        expect(opened).toMatchObject({
          outcome: 'suspended',
          pendingCall: { playbookId: 'code', childSessionId },
        });
        if (opened.outcome !== 'suspended') {
          throw new Error('Expected a suspended child call');
        }
        expect(
          harness.traces
            .filter((trace) => trace.type === 'boss.input.settled')
            .at(-1),
        ).toMatchObject({
          payload: {
            outcome: 'suspended',
            stateId: 'callingPlaybook',
            pendingCall: opened.pendingCall,
          },
        });
        completed = await within(
          runtime.resumePlaybookCall({
            callId: opened.pendingCall.callId,
            result: childResult,
            signal: signal(),
          }),
        );
      }

      expectTerminalResponse(completed, 'I accounted for the child result.');
      const reassessmentPrompt = harness.captainCalls[1].prompt;
      const evidenceLine = reassessmentPrompt
        .split('\n')
        .find((line) => line.startsWith('Completed call results: '));
      expect(evidenceLine).toBeDefined();
      const evidence = JSON.parse(
        evidenceLine!.slice('Completed call results: '.length),
      );
      expect(evidence).toEqual([
        {
          playbookId: 'code',
          status,
          error: { name: error.name, message: error.message },
        },
      ]);
      expect(reassessmentPrompt).not.toContain(childSessionId);
      expect(reassessmentPrompt).not.toContain('privateChildState');
      expect(reassessmentPrompt).not.toContain('private-tag');
      expect(reassessmentPrompt).not.toContain('SECRET_CHILD_STACK');
      expect(reassessmentPrompt).not.toContain('childSessionId');
      expect(reassessmentPrompt).not.toContain('callId');
      if (delivery === 'resumed') {
        const playbookBoundaries = harness.traces.filter((trace) =>
          trace.type.startsWith('playbook.call.'),
        );
        expect(playbookBoundaries.map(({ turnId }) => turnId)).toEqual([1, 1]);
        expect(
          harness.traces.filter(
            (trace) => trace.type === 'captain.call.started',
          )[1]?.turnId,
        ).toBe(1);
      }
      await runtime.dispose();
    },
  );

  it('clears a failed resume boundary while retaining the pending child for a valid retry', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000006';
    const harness = makeHarness({
      classifications: [intentClassification('Delegate and resume safely.')],
      captains: [
        { status: 'ok', finalText: 'I will delegate.' },
        { status: 'ok', finalText: 'The resumed child completed.' },
      ],
      adjudications: [
        delegation('code', 'Complete the resumable work.'),
        finalResponse('The resumed child completed.'),
      ],
      children: [{ state: 'suspended', childSessionId }],
    });
    const runtime = await initRuntime(harness);
    const opened = await runtime.handleBossInput({
      text: 'Delegate and resume safely.',
      signal: signal(),
    });
    if (opened.outcome !== 'suspended') {
      throw new Error('Expected a suspended child call');
    }
    const childResult: PlaybookCallResult = {
      status: 'ok',
      playbookId: 'code',
      childSessionId,
      output: { done: true },
    };

    await expect(
      runtime.resumePlaybookCall({
        callId: `${opened.pendingCall.callId}:wrong`,
        result: childResult,
        signal: signal(),
      }),
    ).rejects.toThrow(/does not match/);

    const completed = await runtime.resumePlaybookCall({
      callId: opened.pendingCall.callId,
      result: childResult,
      signal: signal(),
    });
    expectTerminalResponse(completed, 'The resumed child completed.');
    expectPairedCalls(harness.traces, 'playbook');
    await runtime.dispose();
  });

  it('prefers malformed resumed output over a later failed-status sink error', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000007';
    const harness = makeHarness({
      classifications: [
        intentClassification('Delegate malformed resumable work.'),
        intentClassification('Recover with a direct answer.'),
      ],
      captains: [
        { status: 'ok', finalText: 'I will delegate.' },
        { status: 'ok', finalText: 'Recovery completed.' },
      ],
      adjudications: [
        delegation('code', 'Return structured work.'),
        directResponse('Recovery completed.'),
      ],
      children: [{ state: 'suspended', childSessionId }],
    });
    let rejectedFailedStatus = false;
    const ports: PlaybookPorts = {
      ...harness.ports,
      emitStatus: async (message, data) => {
        await harness.ports.emitStatus(message, data);
        const stateId = (data as { readonly stateId?: unknown } | undefined)
          ?.stateId;
        if (!rejectedFailedStatus && stateId === 'failed') {
          rejectedFailedStatus = true;
          throw new Error('secondary failed-status sink failure');
        }
      },
    };
    const runtime = createPlaybookRuntime({ enabledPlaybooks: ENABLED_PLAYBOOKS });
    await runtime.init(makeSession(ports));
    const opened = await runtime.handleBossInput({
      text: 'Delegate malformed resumable work.',
      signal: signal(),
    });
    if (opened.outcome !== 'suspended') {
      throw new Error('Expected a suspended child call');
    }

    await expect(
      runtime.resumePlaybookCall({
        callId: opened.pendingCall.callId,
        result: {
          status: 'ok',
          playbookId: 'code',
          childSessionId,
          output: { score: Number.NaN },
        },
        signal: signal(),
      }),
    ).rejects.toThrow(/finite JSON number/);

    const finish = harness.traces.find(
      (trace) => trace.type === 'playbook.call.finished',
    );
    const failedTransition = harness.traces.find(
      (trace) =>
        trace.type === 'fsm.transition' &&
        (trace.payload as { readonly state?: { readonly stateId?: string } })
          .state?.stateId === 'failed',
    );
    expect(tracePayload(finish!).result).toMatchObject({
      status: 'error',
      error: { message: expect.stringMatching(/finite JSON number/) },
    });
    expect(failedTransition).toBeDefined();
    expect(finish!.sequence).toBeLessThan(failedTransition!.sequence);
    expect(rejectedFailedStatus).toBe(true);

    const boundarySnapshot = {
      traces: harness.traces.length,
      statuses: harness.statuses.length,
      telemetry: harness.telemetry.length,
    };
    await delay(20);
    expect({
      traces: harness.traces.length,
      statuses: harness.statuses.length,
      telemetry: harness.telemetry.length,
    }).toEqual(boundarySnapshot);

    const recovered = await runtime.handleBossInput({
      text: 'Recover with a direct answer.',
      signal: signal(),
    });
    expectTerminalResponse(recovered, 'Recovery completed.');
    await runtime.dispose();
  });

  it('drains a resumed finish-sink failure without poisoning the next turn', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000008';
    const harness = makeHarness({
      classifications: [
        intentClassification('Delegate traced resumable work.'),
        intentClassification('Recover after the trace failure.'),
      ],
      captains: [
        { status: 'ok', finalText: 'I will delegate.' },
        { status: 'ok', finalText: 'Trace recovery completed.' },
      ],
      adjudications: [
        delegation('code', 'Return traced structured work.'),
        directResponse('Trace recovery completed.'),
      ],
      children: [{ state: 'suspended', childSessionId }],
      rejectTraceType: 'playbook.call.finished',
    });
    const runtime = await initRuntime(harness);
    const opened = await runtime.handleBossInput({
      text: 'Delegate traced resumable work.',
      signal: signal(),
    });
    if (opened.outcome !== 'suspended') {
      throw new Error('Expected a suspended child call');
    }

    await expect(
      runtime.resumePlaybookCall({
        callId: opened.pendingCall.callId,
        result: {
          status: 'ok',
          playbookId: 'code',
          childSessionId,
          output: { done: true },
        },
        signal: signal(),
      }),
    ).rejects.toThrow('Injected playbook.call.finished trace sink failure');

    const finishes = harness.traces.filter(
      (trace) => trace.type === 'playbook.call.finished',
    );
    const failedTransition = harness.traces.find(
      (trace) =>
        trace.type === 'fsm.transition' &&
        (trace.payload as { readonly state?: { readonly stateId?: string } })
          .state?.stateId === 'failed',
    );
    expect(finishes).toHaveLength(1);
    expect(failedTransition).toBeDefined();
    expect(finishes[0].sequence).toBeLessThan(failedTransition!.sequence);

    const boundarySnapshot = {
      traces: harness.traces.length,
      statuses: harness.statuses.length,
      telemetry: harness.telemetry.length,
    };
    await delay(20);
    expect({
      traces: harness.traces.length,
      statuses: harness.statuses.length,
      telemetry: harness.telemetry.length,
    }).toEqual(boundarySnapshot);

    await expect(
      runtime.resumePlaybookCall({
        callId: opened.pendingCall.callId,
        result: {
          status: 'ok',
          playbookId: 'code',
          childSessionId,
          output: { done: true },
        },
        signal: signal(),
      }),
    ).rejects.toThrow(/unknown or stale/);

    const recovered = await runtime.handleBossInput({
      text: 'Recover after the trace failure.',
      signal: signal(),
    });
    expectTerminalResponse(recovered, 'Trace recovery completed.');
    await runtime.dispose();
  });

  it.each(['unknown', 'captain'])(
    'rejects the %s dynamic target before opening any child',
    async (target) => {
      const harness = makeHarness({
        classifications: [intentClassification('Route this intent.')],
        captains: [{ status: 'ok', finalText: 'I selected a target.' }],
        adjudications: [delegation(target, 'Do the work.')],
      });
      const runtime = await initRuntime(harness);

      const result = await runtime.handleBossInput({
        text: 'Route this intent.',
        signal: signal(),
      });

      expect(result).toMatchObject({
        outcome: 'failed',
        state: {
          stateId: 'failed',
          tags: ['playbook.parked'],
          quiescent: true,
        },
      });
      expect(harness.childCalls).toHaveLength(0);
      expect(
        harness.traces.filter(
          (trace) => trace.type === 'playbook.call.started',
        ),
      ).toHaveLength(0);
      await runtime.dispose();
    },
  );

  it.each([
    { name: 'malformed JSON', reply: 'not JSON at all', error: /json|object/i },
    {
      name: 'an undeclared guard',
      reply: { guard: 'notDeclared' },
      error: /undeclared (?:adjudication )?guard/i,
    },
    {
      name: 'a missing required field',
      reply: { guard: 'direct' },
      error: /requires response|required field|omitted/i,
    },
  ])(
    'rejects $name as a control-plane error after quiescence',
    async ({ reply, error }) => {
      const harness = makeHarness({
        classifications: [intentClassification('Answer directly.')],
        captains: [{ status: 'ok', finalText: 'A visible answer.' }],
        adjudications: [reply],
      });
      const runtime = await initRuntime(harness);

      await expect(
        runtime.handleBossInput({ text: 'Answer directly.', signal: signal() }),
      ).rejects.toThrow(error);

      const settled = [...harness.traces]
        .reverse()
        .find((trace) => trace.type === 'boss.input.settled');
      expect(settled).toMatchObject({
        payload: {
          outcome: 'failed',
          state: { stateId: 'failed', quiescent: true },
        },
      });
      expectPairedCalls(harness.traces, 'captain');
      expectPairedCalls(harness.traces, 'judge');
      await runtime.dispose();
    },
  );

  it('forwards abort into a visible Captain call and waits for its natural failure', async () => {
    const portStarted = deferred<void>();
    const portFinished = deferred<void>();
    const forceWake = deferred<void>();
    let portSignal: AbortSignal | undefined;
    const harness = makeHarness({
      classifications: [intentClassification('Answer this slowly.')],
      captains: [
        async (_prompt, receivedSignal) => {
          portSignal = receivedSignal;
          portStarted.resolve(undefined);
          if (!receivedSignal.aborted) {
            await Promise.race([
              new Promise<void>((resolve) =>
                receivedSignal.addEventListener('abort', () => resolve(), {
                  once: true,
                }),
              ),
              forceWake.promise,
            ]);
          }
          await portFinished.promise;
          return { status: 'aborted', error: 'Captain call aborted' };
        },
      ],
    });
    const runtime = await initRuntime(harness);
    const controller = new AbortController();
    let publicSettled = false;

    const turn = runtime
      .handleBossInput({
        text: 'Answer this slowly.',
        signal: controller.signal,
      })
      .finally(() => {
        publicSettled = true;
      });
    await within(portStarted.promise);
    controller.abort();
    await delay(20);

    const observedAbort = portSignal?.aborted === true;
    const settledBeforePortFinished = publicSettled;
    forceWake.resolve(undefined);
    portFinished.resolve(undefined);
    const result = await within(turn);
    expect(observedAbort).toBe(true);
    expect(settledBeforePortFinished).toBe(false);
    expect(result).toMatchObject({
      outcome: 'aborted',
      state: { stateId: 'failed', quiescent: true },
    });
    expectPairedCalls(harness.traces, 'captain');

    const boundarySnapshot = {
      traces: harness.traces.length,
      statuses: harness.statuses.length,
      telemetry: harness.telemetry.length,
      captainCalls: harness.captainCalls.length,
    };
    await delay(20);
    expect({
      traces: harness.traces.length,
      statuses: harness.statuses.length,
      telemetry: harness.telemetry.length,
      captainCalls: harness.captainCalls.length,
    }).toEqual(boundarySnapshot);
    await runtime.dispose();
  });

  it('forwards abort into a child opening and does not return before its finish boundary', async () => {
    const portStarted = deferred<void>();
    const portFinished = deferred<void>();
    const forceWake = deferred<void>();
    let portSignal: AbortSignal | undefined;
    const harness = makeHarness({
      classifications: [intentClassification('Delegate this slowly.')],
      captains: [{ status: 'ok', finalText: 'I will delegate.' }],
      adjudications: [delegation('code', 'Open the slow child.')],
      children: [
        async (_request, receivedSignal) => {
          portSignal = receivedSignal;
          portStarted.resolve(undefined);
          if (!receivedSignal.aborted) {
            await Promise.race([
              new Promise<void>((resolve) =>
                receivedSignal.addEventListener('abort', () => resolve(), {
                  once: true,
                }),
              ),
              forceWake.promise,
            ]);
          }
          await portFinished.promise;
          throw new DOMException('Child opening aborted', 'AbortError');
        },
      ],
    });
    const runtime = await initRuntime(harness);
    const controller = new AbortController();
    let publicSettled = false;

    const turn = runtime
      .handleBossInput({
        text: 'Delegate this slowly.',
        signal: controller.signal,
      })
      .then(
        (result) => ({ kind: 'resolved' as const, result }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        publicSettled = true;
      });
    await within(portStarted.promise);
    controller.abort();
    await delay(20);

    const observedAbort = portSignal?.aborted === true;
    const settledBeforePortFinished = publicSettled;
    forceWake.resolve(undefined);
    portFinished.resolve(undefined);
    await within(turn);
    expect(observedAbort).toBe(true);
    expect(settledBeforePortFinished).toBe(false);
    expectPairedCalls(harness.traces, 'playbook');

    const boundarySnapshot = {
      traces: harness.traces.length,
      statuses: harness.statuses.length,
      telemetry: harness.telemetry.length,
      childCalls: harness.childCalls.length,
    };
    await delay(20);
    expect({
      traces: harness.traces.length,
      statuses: harness.statuses.length,
      telemetry: harness.telemetry.length,
      childCalls: harness.childCalls.length,
    }).toEqual(boundarySnapshot);
    await runtime.dispose();
  });

  it.each([
    {
      label: 'port rejection',
      captain: async () => {
        throw new Error('Captain transport failed');
      },
      expected: 'Captain transport failed',
    },
    {
      label: 'non-ok result',
      captain: { status: 'error' as const, error: 'Captain model failed' },
      expected: 'Captain model failed',
    },
    {
      label: 'missing final text',
      captain: { status: 'ok' as const },
      expected: 'Captain call did not return finalText',
    },
  ])(
    'rejects a Captain $label as a control error',
    async ({ captain, expected }) => {
      const harness = makeHarness({
        classifications: [intentClassification('Answer this intent.')],
        captains: [captain],
      });
      const runtime = await initRuntime(harness);

      await expect(
        runtime.handleBossInput({
          text: 'Answer this intent.',
          signal: signal(),
        }),
      ).rejects.toThrow(expected);

      expectPairedCalls(harness.traces, 'captain');
      expect(harness.traces.at(-1)).toMatchObject({
        type: 'boss.input.settled',
        payload: {
          outcome: 'failed',
          state: { stateId: 'failed', quiescent: true },
        },
      });
      await runtime.dispose();
    },
  );

  it('preserves the first Captain control error when its paired finish trace also rejects', async () => {
    const harness = makeHarness({
      classifications: [intentClassification('Answer this intent.')],
      captains: [{ status: 'ok' }],
      rejectTraceType: 'captain.call.finished',
    });
    const runtime = await initRuntime(harness);

    await expect(
      runtime.handleBossInput({
        text: 'Answer this intent.',
        signal: signal(),
      }),
    ).rejects.toThrow('Captain call did not return finalText');

    expectPairedCalls(harness.traces, 'captain');
    await runtime.dispose();
  });

  it('attempts a Captain finish when the start trace records then rejects', async () => {
    const harness = makeHarness({
      classifications: [intentClassification('Answer this intent.')],
      rejectTraceType: 'captain.call.started',
    });
    const runtime = await initRuntime(harness);

    await expect(
      runtime.handleBossInput({
        text: 'Answer this intent.',
        signal: signal(),
      }),
    ).rejects.toThrow('Injected captain.call.started trace sink failure');

    expect(harness.captainCalls).toHaveLength(0);
    expectPairedCalls(harness.traces, 'captain');
    expect(
      harness.traces.find((trace) => trace.type === 'captain.call.finished')
        ?.payload,
    ).toMatchObject({ status: 'error' });
    await runtime.dispose();
  });

  it('stops the root before disposing a suspended child bridge', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000005';
    const harness = makeHarness({
      classifications: [intentClassification('Delegate and wait.')],
      captains: [{ status: 'ok', finalText: 'I will delegate.' }],
      adjudications: [delegation('code', 'Wait for Boss in the child.')],
      children: [{ state: 'suspended', childSessionId }],
    });
    const runtime = await initRuntime(harness);

    const opened = await runtime.handleBossInput({
      text: 'Delegate and wait.',
      signal: signal(),
    });
    expect(opened).toMatchObject({
      outcome: 'suspended',
      pendingCall: { playbookId: 'code', childSessionId },
    });

    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(harness.captainCalls).toHaveLength(1);
    expectPairedCalls(harness.traces, 'playbook');
    const types = harness.traces.map(({ type }) => type);
    expect(types.lastIndexOf('playbook.call.finished')).toBeLessThan(
      types.lastIndexOf('session.disposed'),
    );
    expect(
      harness.traces.some(
        (trace) =>
          trace.type === 'fsm.transition' &&
          JSON.stringify(trace.payload).includes('reassessing'),
      ),
    ).toBe(false);
  });

  it('shares one in-flight disposal promise and emits one disposal boundary', async () => {
    const harness = makeHarness();
    const disposalStarted = deferred<void>();
    const releaseDisposal = deferred<void>();
    const ports: PlaybookPorts = {
      ...harness.ports,
      emitTelemetry: async (event) => {
        await harness.ports.emitTelemetry(event);
        if (
          isTraceTelemetry(event) &&
          event.payload.type === 'session.disposed'
        ) {
          disposalStarted.resolve(undefined);
          await releaseDisposal.promise;
        }
      },
    };
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: ENABLED_PLAYBOOKS,
    });
    await runtime.init(makeSession(ports));

    const first = runtime.dispose();
    await disposalStarted.promise;
    const second = runtime.dispose();

    expect(second).toBe(first);
    releaseDisposal.resolve(undefined);
    await Promise.all([first, second]);
    const later = runtime.dispose();
    expect(later).toBe(first);
    await later;
    expect(
      harness.traces.filter((trace) => trace.type === 'session.disposed'),
    ).toHaveLength(1);
  });

  it('retains a failed disposal promise without emitting a second boundary', async () => {
    const harness = makeHarness({ rejectTraceType: 'session.disposed' });
    const runtime = await initRuntime(harness);

    const first = runtime.dispose();
    await expect(first).rejects.toThrow(
      'Injected session.disposed trace sink failure',
    );
    const later = runtime.dispose();

    expect(later).toBe(first);
    await expect(later).rejects.toThrow(
      'Injected session.disposed trace sink failure',
    );
    expect(
      harness.traces.filter((trace) => trace.type === 'session.disposed'),
    ).toHaveLength(1);
  });

  it('leaves the terminal actor untouched when classification returns NO_ACTION', async () => {
    const harness = makeHarness({
      classifications: [
        intentClassification('Answer once.'),
        { type: 'NO_ACTION' },
      ],
      captains: [{ status: 'ok', finalText: 'One answer.' }],
      adjudications: [directResponse('One answer.')],
    });
    const runtime = await initRuntime(harness);
    const terminal = await runtime.handleBossInput({
      text: 'Answer once.',
      signal: signal(),
    });
    expectTerminalResponse(terminal, 'One answer.');
    const transitionCount = harness.traces.filter(
      (trace) => trace.type === 'fsm.transition',
    ).length;

    const noAction = await runtime.handleBossInput({
      text: 'No state change.',
      signal: signal(),
    });

    expect(noAction).toMatchObject({
      outcome: 'no-action',
      state: { stateId: 'done', status: 'done', quiescent: true },
    });
    expect(harness.captainCalls).toHaveLength(1);
    expect(
      harness.traces.filter((trace) => trace.type === 'fsm.transition'),
    ).toHaveLength(transitionCount);
    await runtime.dispose();
  });

  it('snapshots session identity and the exact catalog before caller mutation', async () => {
    const mutableCatalog: Array<{
      id: string;
      command: string;
      intent: string;
    }> = ENABLED_PLAYBOOKS.map((entry) => ({ ...entry }));
    const harness = makeHarness({
      classifications: [intentClassification('Use the original catalog.')],
      captains: [{ status: 'ok', finalText: 'Original data retained.' }],
      adjudications: [directResponse('Original data retained.')],
    });
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: mutableCatalog,
    });
    const originalSessionId = nextSessionId();
    const mutableSession = makeSession(harness.ports, originalSessionId);
    await runtime.init(mutableSession);

    mutableSession.sessionId = 'mutated-session-id';
    mutableSession.playbookId = 'mutated-playbook-id';
    mutableSession.rootSessionId = 'mutated-root-id';
    mutableSession.depth = 99;
    mutableCatalog[0].id = 'mutated-code';
    mutableCatalog[0].command = '/mutated';
    mutableCatalog[0].intent = 'Mutated intent.';
    mutableCatalog.push({
      id: 'late',
      command: 'late',
      intent: 'Added after initialization.',
    });

    const result = await runtime.handleBossInput({
      text: 'Use the original catalog.',
      signal: signal(),
    });
    expectTerminalResponse(result, 'Original data retained.');
    expect(harness.captainCalls[0].prompt).toContain(
      'Enabled playbooks: [{"command":"code","id":"code","intent":"Implement and review a software change."},{"command":"discuss","id":"discuss","intent":"Develop independent proposals and synthesize them."}]',
    );
    expect(harness.captainCalls[0].prompt).not.toContain('mutated');
    expect(harness.captainCalls[0].prompt).not.toContain('Added after');
    expect(
      harness.traces.every(
        (trace) =>
          trace.sessionId === originalSessionId &&
          trace.playbookId === 'captain' &&
          trace.rootSessionId === originalSessionId &&
          trace.depth === 0,
      ),
    ).toBe(true);
    await runtime.dispose();
  });

  it('substitutes placeholders literally in one pass over the original template', () => {
    const bossIntent = "literal <enabled-playbooks> $& $$ $` $'";
    const catalogIntent = "catalog keeps <boss-intent> and $& $$ $` $'";
    const prompt = _internal.composeCaptainPrompt({
      stateId: 'routing',
      sourceItem: 'CAPTAIN-1',
      prompt: [
        'Intent=<boss-intent>',
        'Catalog=<enabled-playbooks>',
        'Plan=<remaining-plan>',
        'Results=<completed-call-results>',
      ].join('\n'),
      result: {},
      bossIntent,
      enabledPlaybooks: [
        { id: 'code', command: 'code', intent: catalogIntent },
      ],
      remainingPlan: ['<completed-call-results>', '$&'],
      completedCallResults: ['<remaining-plan>', '$$'],
    });

    expect(prompt).toBe(
      [
        `Intent=${bossIntent}`,
        `Catalog=[{"command":"code","id":"code","intent":${JSON.stringify(catalogIntent)}}]`,
        'Plan=["<completed-call-results>","$&"]',
        'Results=["<remaining-plan>","$$"]',
      ].join('\n'),
    );
  });

  it('serializes all emissions and orders complete trace pairs around host calls', async () => {
    const harness = makeHarness({
      delayedEmissions: true,
      classifications: [intentClassification('Delegate with tracing.')],
      captains: [
        { status: 'ok', finalText: 'I will delegate.' },
        { status: 'ok', finalText: 'Delegation complete.' },
      ],
      adjudications: [
        delegation('code', 'Do the traced work.'),
        finalResponse('Delegation complete.'),
      ],
      children: [
        settledSuccess('code', '10000000-0000-4000-8000-000000000005', {
          done: true,
        }),
      ],
    });
    const runtime = await initRuntime(harness);
    const result = await within(
      runtime.handleBossInput({
        text: 'Delegate with tracing.',
        signal: signal(),
      }),
      2_000,
    );
    expectTerminalResponse(result, 'Delegation complete.');
    await runtime.dispose();

    expect(harness.maxConcurrentEmissions).toBe(1);
    expect(harness.traces.map((trace) => trace.sequence)).toEqual(
      harness.traces.map((_trace, index) => index + 1),
    );
    expectPairedCalls(harness.traces, 'captain');
    expectPairedCalls(harness.traces, 'judge');
    expectPairedCalls(harness.traces, 'playbook');

    for (const kind of ['captain', 'judge', 'playbook'] as const) {
      const starts = harness.traces.filter(
        (trace) => trace.type === `${kind}.call.started`,
      );
      const finishes = harness.traces.filter(
        (trace) => trace.type === `${kind}.call.finished`,
      );
      for (let index = 0; index < starts.length; index += 1) {
        const startLabel = `emit:trace:${starts[index].type}:${starts[index].sequence}`;
        const finishLabel = `emit:trace:${finishes[index].type}:${finishes[index].sequence}`;
        expect(harness.order.indexOf(startLabel)).toBeLessThan(
          harness.order.indexOf(`host:${kind}:${index + 1}:started`),
        );
        expect(
          harness.order.indexOf(`host:${kind}:${index + 1}:finished`),
        ).toBeLessThan(harness.order.indexOf(finishLabel));
      }
    }

    for (let index = 0; index < harness.order.length; index += 1) {
      if (harness.order[index] === 'emit:state') {
        expect(harness.order[index - 1]).toMatch(
          /^emit:trace:fsm\.transition:/,
        );
      }
      if (harness.order[index] === 'emit:status') {
        expect(harness.order[index - 1]).toMatch(
          /^emit:trace:status\.emitted:/,
        );
      }
    }

    const childStart = harness.traces.find(
      (trace) => trace.type === 'playbook.call.started',
    );
    const childFinish = harness.traces.find(
      (trace) => trace.type === 'playbook.call.finished',
    );
    expect(childStart?.callId).toBe(childFinish?.callId);
    expect(tracePayload(childStart!)).toMatchObject({
      stateId: 'callingPlaybook',
      playbookId: harness.childCalls[0].request.playbookId,
      text: harness.childCalls[0].request.text,
    });
  });
});
