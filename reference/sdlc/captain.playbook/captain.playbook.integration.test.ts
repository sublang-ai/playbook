// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createActor, fromPromise } from 'xstate';
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
import {
  captainMachine,
  type CaptainInput,
  type CaptainOutput,
  type PlaybookInput,
  type PlaybookOutput,
} from './captain.fsm.js';

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
type JudgeStep =
  | JudgeReply
  | ((
      prompt: string,
      signal: AbortSignal,
    ) => JudgeReply | Promise<JudgeReply>);
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
  readonly classifications?: readonly JudgeStep[];
  readonly adjudications?: readonly JudgeStep[];
  readonly captains?: readonly CaptainStep[];
  readonly children?: readonly ChildStep[];
  readonly delayedEmissions?: boolean;
  readonly rejectTraceType?: PlaybookTraceType;
  readonly rejectTraceError?: Error;
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

function finalResponse(): JudgeReply {
  return { guard: 'final' };
}

function settledSuccess(
  playbookId: string,
  childSessionId: string,
  output?: JsonValue,
): PlaybookCallStart {
  return {
    state: 'settled',
    result: {
      status: 'ok',
      playbookId,
      childSessionId,
      ...(output === undefined ? {} : { output }),
    },
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
      const purpose =
        prompt.includes('Classify this Boss turn') ||
        (prompt.includes('NO_ACTION') && prompt.includes('BOSS_INTERRUPT'))
          ? 'classification'
          : 'adjudication';
      judgeCalls.push({ prompt, signal, purpose });
      const callNumber = judgeCalls.length;
      order.push(`host:judge:${callNumber}:started`);
      try {
        const step =
          purpose === 'classification'
            ? shiftRequired(classifications, 'classification judge')
            : shiftRequired(adjudications, 'adjudication judge');
        const reply =
          typeof step === 'function' ? await step(prompt, signal) : step;
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
        throw (
          script.rejectTraceError ??
          new Error(`Injected ${event.payload.type} trace sink failure`)
        );
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

  it('serializes concurrent disposal behind failed initialization', async () => {
    const harness = makeHarness();
    const started = deferred<void>();
    const releaseStart = deferred<void>();
    const startError = new Error('deferred Captain session-start failure');
    const emitTelemetry = harness.ports.emitTelemetry;
    harness.ports.emitTelemetry = async (event) => {
      await emitTelemetry(event);
      if (
        isTraceTelemetry(event) &&
        event.payload.type === 'session.started'
      ) {
        started.resolve();
        await releaseStart.promise;
        throw startError;
      }
    };
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: ENABLED_PLAYBOOKS,
    });

    const initialization = runtime.init(makeSession(harness.ports));
    await started.promise;
    const firstDisposal = runtime.dispose();
    expect(runtime.dispose()).toBe(firstDisposal);
    releaseStart.resolve();

    await expect(initialization).rejects.toBe(startError);
    await expect(firstDisposal).resolves.toBeUndefined();
    expect(
      harness.traces.filter((trace) => trace.type === 'session.disposed'),
    ).toHaveLength(1);
    await expect(
      runtime.init(makeSession(harness.ports)),
    ).rejects.toThrow(/initialized|disposed/i);
  });

  it('serializes concurrent disposal behind successful initialization emissions', async () => {
    const harness = makeHarness();
    const started = deferred<void>();
    const releaseStart = deferred<void>();
    const emitTelemetry = harness.ports.emitTelemetry;
    harness.ports.emitTelemetry = async (event) => {
      await emitTelemetry(event);
      if (
        isTraceTelemetry(event) &&
        event.payload.type === 'session.started'
      ) {
        started.resolve();
        await releaseStart.promise;
      }
    };
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: ENABLED_PLAYBOOKS,
    });
    let initializationSettled = false;
    let disposalSettled = false;

    const initialization = runtime
      .init(makeSession(harness.ports))
      .finally(() => {
        initializationSettled = true;
      });
    await started.promise;
    const disposal = runtime.dispose().finally(() => {
      disposalSettled = true;
    });
    await delay(20);

    expect(initializationSettled).toBe(false);
    expect(disposalSettled).toBe(false);
    releaseStart.resolve();
    const outcomes = await Promise.allSettled([initialization, disposal]);

    expect(outcomes.map(({ status }) => status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    const startedIndex = harness.telemetry.findIndex(
      (event) =>
        isTraceTelemetry(event) && event.payload.type === 'session.started',
    );
    const transitionIndex = harness.telemetry.findIndex(
      (event) =>
        isTraceTelemetry(event) && event.payload.type === 'fsm.transition',
    );
    const stateTelemetryIndex = harness.telemetry.findIndex(
      (event) => event.topic === 'playbook.fsm.state',
    );
    const disposedIndex = harness.telemetry.findIndex(
      (event) =>
        isTraceTelemetry(event) && event.payload.type === 'session.disposed',
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(transitionIndex).toBeGreaterThan(startedIndex);
    expect(stateTelemetryIndex).toBeGreaterThan(transitionIndex);
    expect(disposedIndex).toBeGreaterThan(stateTelemetryIndex);
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it('completes initialization cleanup when session validation rejects', async () => {
    const harness = makeHarness();
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: ENABLED_PLAYBOOKS,
    });
    const invalidSession = {
      ...makeSession(harness.ports),
      rootSessionId: nextSessionId(),
    };

    await expect(runtime.init(invalidSession)).rejects.toThrow(
      /rootSessionId|root session|identity/i,
    );
    const disposal = runtime.dispose();

    await expect(within(disposal, 200)).resolves.toBeUndefined();
    expect(runtime.dispose()).toBe(disposal);
    expect(harness.traces).toEqual([]);
  });

  it('retains terminal disposal identity before initialization', async () => {
    const harness = makeHarness();
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: ENABLED_PLAYBOOKS,
    });

    const firstDisposal = runtime.dispose();
    expect(runtime.dispose()).toBe(firstDisposal);
    await firstDisposal;
    expect(runtime.dispose()).toBe(firstDisposal);
    expect(harness.traces).toEqual([]);

    await expect(
      runtime.init(makeSession(harness.ports)),
    ).rejects.toThrow(/initialized|disposed/i);
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

  it('initializes, delegates one child, and returns the child-backed visible final response', async () => {
    const intent =
      'Implement the parser fix without changing the public API, then run its tests.';
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will route this implementation to CODE.' },
        {
          status: 'ok',
          finalText: 'The parser fix is implemented and its tests pass.',
        },
      ],
      adjudications: [
        delegation(
          'code',
          'Implement the parser fix without changing the public API, then run its tests.',
        ),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000000',
          { summary: 'Parser fixed; tests pass.' },
        ),
      ],
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
      text: intent,
      signal: signal(),
    });

    expectTerminalResponse(
      result,
      'The parser fix is implemented and its tests pass.',
    );
    expect(harness.captainCalls).toHaveLength(2);
    expect(harness.captainCalls.map(({ options }) => options)).toEqual([
      { visibility: 'visible', resume: false, allowedTools: [] },
      { visibility: 'visible', resume: false, allowedTools: [] },
    ]);
    expect(harness.captainCalls[0].prompt).toContain(`Boss intent: ${intent}`);
    expect(harness.captainCalls[0].prompt).not.toMatch(
      /"guard"|Output shall include|remainingPlan|nextPlaybookId|nextPlaybookInput|response:/i,
    );
    expect(
      harness.judgeCalls.filter(({ purpose }) => purpose === 'classification'),
    ).toHaveLength(0);
    expect(harness.childCalls).toHaveLength(1);
    expect(
      harness.traces.filter((trace) => trace.type === 'captain.call.started'),
    ).toHaveLength(2);
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
        output: {
          response: 'The parser fix is implemented and its tests pass.',
        },
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

  it('accepts a successful child result with no output', async () => {
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will route this implementation.' },
        { status: 'ok', finalText: 'The child completed successfully.' },
      ],
      adjudications: [delegation('code', 'Complete it.'), finalResponse()],
      children: [
        settledSuccess('code', '10000000-0000-4000-8000-000000000020'),
      ],
    });
    const runtime = await initRuntime(harness);

    const result = await runtime.handleBossInput({
      text: 'Complete the implementation.',
      signal: signal(),
    });

    expectTerminalResponse(result, 'The child completed successfully.');
    const finish = harness.traces.find(
      (trace) => trace.type === 'playbook.call.finished',
    );
    expect(finish).toBeDefined();
    expect(
      tracePayload(finish as PlaybookTraceEvent).result,
    ).not.toHaveProperty('output');
    await runtime.dispose();
  });

  it.each([
    {
      label: 'surrounding prose with earlier bracket fragments',
      reply:
        'Ignore [draft] and {n/a}. Intended: {"type":"BOSS_INTERRUPT","targetId":"routing"} Thanks.',
    },
    {
      label: 'a Markdown fence amid prose',
      reply:
        'Result follows:\n```json\n{"type":"BOSS_INTERRUPT","targetId":"routing"}\n```\nDone.',
    },
    {
      label: 'a trailing comma before a later clean decoy',
      reply:
        '{"type":"BOSS_INTERRUPT","targetId":"routing",} Ignore {"type":"NO_ACTION"}',
    },
    {
      label: 'a truncated object',
      reply: '{"type":"BOSS_INTERRUPT","targetId":"routing"',
    },
    {
      label: 'an unterminated string',
      reply: '{"type":"BOSS_INTERRUPT","targetId":"routing',
    },
  ])('recovers parked classifier JSON from $label without rewriting Boss text', async ({
    reply,
  }) => {
    const exactFreshIntent =
      'Implement the exact parser change; do not paraphrase this message.';
    const harness = makeHarness({
      classifications: [reply],
      captains: [
        { status: 'ok', finalText: 'Which outcome should I route?' },
        { status: 'ok', finalText: 'I will route the exact request to CODE.' },
        { status: 'ok', finalText: 'The exact parser change is complete.' },
      ],
      adjudications: [
        { guard: 'question' },
        delegation('code', exactFreshIntent),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000012',
          { summary: 'exact parser change complete' },
        ),
      ],
    });
    const runtime = await initRuntime(harness);

    const parked = await runtime.handleBossInput({
      text: 'Ask one routing question first.',
      signal: signal(),
    });
    expect(parked).toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply', quiescent: true },
    });

    const result = await runtime.handleBossInput({
      text: exactFreshIntent,
      signal: signal(),
    });

    expectTerminalResponse(result, 'The exact parser change is complete.');
    const classification = harness.judgeCalls.find(
      ({ purpose }) => purpose === 'classification',
    );
    expect(classification?.prompt).toContain(exactFreshIntent);
    expect(harness.captainCalls[1].prompt).toContain(
      `Boss intent: ${exactFreshIntent}`,
    );
    expect(harness.captainCalls[1].prompt).not.toContain(
      'prose classification',
    );
    await runtime.dispose();
  });

  it.each([
    {
      label: 'surrounding prose with earlier bracket fragments',
      reply:
        'Ignore [draft] and {n/a}. Intended: {"guard":"final"} Thanks.',
    },
    {
      label: 'a Markdown fence amid prose',
      reply:
        'Result follows:\n```json\n{"guard":"final"}\n```\nDone.',
    },
    {
      label: 'a trailing comma before a later clean decoy',
      reply:
        '{"guard":"final",} Ignore {"guard":"continuing"}',
    },
    {
      label: 'a truncated object',
      reply: '{"guard":"final"',
    },
    {
      label: 'an unterminated string',
      reply: '{"guard":"final',
    },
  ])('recovers final adjudicator JSON from $label', async ({ reply }) => {
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will route this work to CODE.' },
        { status: 'ok', finalText: 'Visible child-backed Captain output.' },
      ],
      adjudications: [
        delegation('code', 'Produce the result to adjudicate.'),
        reply,
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000013',
          { result: 'child-backed' },
        ),
      ],
    });
    const runtime = await initRuntime(harness);

    const result = await runtime.handleBossInput({
      text: 'Adjudicate this output.',
      signal: signal(),
    });

    expectTerminalResponse(result, 'Visible child-backed Captain output.');
    await runtime.dispose();
  });

  it.each([
    { label: 'unrecoverable prose', reply: 'no JSON here' },
    { label: 'a non-object JSON value', reply: '["NO_ACTION"]' },
    { label: 'an unknown event', reply: { type: 'UNKNOWN_EVENT' } },
    {
      label: 'a reply with an unknown question id',
      reply: { type: 'BOSS_REPLY', questionId: 'unknown-question' },
    },
    {
      label: 'NO_ACTION with an injected field',
      reply: { type: 'NO_ACTION', enabledPlaybooks: [] },
    },
    {
      label: 'a classifier-authored Boss paraphrase',
      reply: { type: 'BOSS_INTENT', bossIntent: 'rewritten by classifier' },
    },
  ])('emits exactly one status and no event for $label', async ({ reply }) => {
    const harness = makeHarness({
      classifications: [reply],
      captains: [{ status: 'ok', finalText: 'Which route should I use?' }],
      adjudications: [{ guard: 'question' }],
    });
    const runtime = await initRuntime(harness);
    await runtime.handleBossInput({
      text: 'Ask for routing guidance.',
      signal: signal(),
    });
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
      state: { stateId: 'awaitBossReply', quiescent: true },
    });
    const recoveryStatuses = harness.statuses.slice(statusCount);
    expect(recoveryStatuses).toHaveLength(1);
    expect(recoveryStatuses[0].message).toMatch(
      /not actionable|classification (?:was )?invalid|could not (?:be )?classified|could not classify/i,
    );
    expect(
      harness.traces.filter((trace) => trace.type === 'fsm.transition'),
    ).toHaveLength(transitionCount);
    expect(harness.captainCalls).toHaveLength(1);
    expect(
      harness.judgeCalls.find(({ purpose }) => purpose === 'classification')
        ?.prompt,
    ).toContain('This classification is invalid.');
    expectPairedCalls(harness.traces, 'judge');
    await runtime.dispose();
  });

  it('resumes its own clarification on the same runtime with exact question and answer', async () => {
    const question = 'Should implementation or discussion happen first?';
    const answer = 'Implement first.';
    const intent = 'Implement the idea and then compare alternatives.';
    const harness = makeHarness({
      classifications: [{ type: 'BOSS_REPLY' }],
      captains: [
        { status: 'ok', finalText: question },
        { status: 'ok', finalText: 'I will route implementation to CODE.' },
        { status: 'ok', finalText: 'Implementation completed first.' },
      ],
      adjudications: [
        { guard: 'question' },
        delegation('code', 'Implement the idea before comparing alternatives.'),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000014',
          { summary: 'implementation completed first' },
        ),
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
    expectTerminalResponse(completed, 'Implementation completed first.');
    expect(harness.captainCalls).toHaveLength(3);
    const classification = harness.judgeCalls.find(
      ({ purpose }) => purpose === 'classification',
    );
    expect(classification?.prompt).toContain(question);
    expect(classification?.prompt).toContain(answer);
    expect(classification?.prompt).not.toContain('resumeStateId');
    expect(classification?.prompt).not.toContain('sourceItem');

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

  it('clears a consumed routing question before suspending on a delegated child', async () => {
    const question = 'Should implementation happen before discussion?';
    const answer = 'Implement first.';
    const childSessionId = '10000000-0000-4000-8000-000000000040';
    const harness = makeHarness({
      classifications: [{ type: 'BOSS_REPLY' }],
      captains: [
        { status: 'ok', finalText: question },
        { status: 'ok', finalText: 'I will delegate implementation.' },
      ],
      adjudications: [
        { guard: 'question' },
        delegation('code', 'Implement the requested change.'),
      ],
      children: [{ state: 'suspended', childSessionId }],
    });
    const runtime = await initRuntime(harness);

    await runtime.handleBossInput({
      text: 'Implement and discuss the change.',
      signal: signal(),
    });
    const suspended = await runtime.handleBossInput({
      text: answer,
      signal: signal(),
    });

    expect(suspended).toMatchObject({ outcome: 'suspended' });
    expect(suspended.state.tags).toContain('playbook.suspended');
    const callingTransition = harness.traces
      .filter((trace) => trace.type === 'fsm.transition')
      .findLast(
        (trace) => {
          const state = tracePayload(trace).state as
            | { readonly tags?: unknown }
            | undefined;
          const tags = state?.tags;
          return Array.isArray(tags) && tags.includes('playbook.suspended');
        },
      );
    expect(callingTransition).toBeDefined();
    expect(tracePayload(callingTransition!)).not.toHaveProperty(
      'pendingBossQuestion',
    );
    await runtime.dispose();
  });

  it('rejects an interrupt back into awaitBossReply without clearing the pending question', async () => {
    const question = 'Which implementation constraint matters most?';
    const answer = 'Preserve compatibility.';
    const harness = makeHarness({
      classifications: [
        { type: 'BOSS_INTERRUPT', targetId: 'awaitBossReply' },
        { type: 'BOSS_REPLY' },
      ],
      captains: [
        { status: 'ok', finalText: question },
        { status: 'ok', finalText: 'I will route the compatible change.' },
        { status: 'ok', finalText: 'Compatibility was preserved.' },
      ],
      adjudications: [
        { guard: 'question' },
        delegation('code', 'Implement the change while preserving compatibility.'),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000015',
          { summary: 'compatibility preserved' },
        ),
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
    expect(recoveryStatuses[0].message).toMatch(
      /not actionable|classification (?:was )?invalid|could not (?:be )?classified|could not classify/i,
    );
    expect(
      harness.traces.filter((trace) => trace.type === 'fsm.transition'),
    ).toHaveLength(transitionCount);
    expect(harness.captainCalls).toHaveLength(1);
    const rejectedClassification = harness.judgeCalls.find(
      ({ purpose }) => purpose === 'classification',
    );
    expect(rejectedClassification?.prompt).toContain('BOSS_INTERRUPT');
    expect(rejectedClassification?.prompt).toContain('routing');
    expect(rejectedClassification?.prompt).toContain(
      'Jump back into the same wait state.',
    );
    expect(rejectedClassification?.prompt).not.toContain('"bossIntent"');
    expect(rejectedClassification?.prompt).not.toMatch(
      /BOSS_INTERRUPT[^\n]*targetId[^\n]*(?:reassessing|awaitBossReply)/,
    );

    const completed = await runtime.handleBossInput({
      text: answer,
      signal: signal(),
    });
    expectTerminalResponse(completed, 'Compatibility was preserved.');
    expect(harness.captainCalls[1].prompt).toContain(question);
    expect(harness.captainCalls[1].prompt).toContain(answer);
    await runtime.dispose();
  });

  it('accepts a fresh routing interrupt while parked and clears the old question', async () => {
    const question = 'Which constraint should govern the original intent?';
    const freshIntent = 'Implement the replacement approach with tests.';
    const harness = makeHarness({
      classifications: [
        {
          type: 'BOSS_INTERRUPT',
          targetId: 'routing',
        },
      ],
      captains: [
        { status: 'ok', finalText: question },
        { status: 'ok', finalText: 'I will route the replacement to CODE.' },
        { status: 'ok', finalText: 'The replacement is implemented and tested.' },
      ],
      adjudications: [
        { guard: 'question' },
        delegation('code', 'Implement the replacement approach with tests.'),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000016',
          { summary: 'replacement implemented and tested' },
        ),
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
    expectTerminalResponse(
      completed,
      'The replacement is implemented and tested.',
    );
    expect(harness.captainCalls[1].prompt).toContain(
      `Boss intent: ${freshIntent}`,
    );
    expect(harness.captainCalls[1].prompt).not.toContain(question);
    expect(harness.captainCalls[1].prompt).not.toContain(
      'You previously paused this task',
    );
    expect(
      harness.judgeCalls.find(({ purpose }) => purpose === 'classification')
        ?.prompt,
    ).toContain(freshIntent);
    await runtime.dispose();
  });

  it('executes one child and reassesses its actual output before completing', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000001';
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will use CODE.' },
        { status: 'ok', finalText: 'The fix is complete.' },
      ],
      adjudications: [
        delegation('code', 'Implement the fix with tests.'),
        finalResponse(),
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
        finalResponse(),
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

  it.each([
    { delivery: 'immediate', status: 'aborted' },
    { delivery: 'immediate', status: 'error' },
    { delivery: 'resumed', status: 'aborted' },
    { delivery: 'resumed', status: 'error' },
  ] as const)(
    'rejects the exact child call after an $delivery $status return',
    async ({ delivery, status }) => {
      const repeatedText = 'Try the implementation exactly once.';
      const childSessionId = '10000000-0000-4000-8000-000000000008';
      const childResult: PlaybookCallResult = {
        status,
        playbookId: 'code',
        childSessionId,
        error: {
          name: status === 'aborted' ? 'AbortError' : 'ChildFailure',
          message:
            status === 'aborted'
              ? 'Boss stopped the child.'
              : 'The child could not finish.',
        },
      };
      const childStart: PlaybookCallStart =
        delivery === 'immediate'
          ? { state: 'settled', result: childResult }
          : { state: 'suspended', childSessionId };
      const harness = makeHarness({
        captains: [
          { status: 'ok', finalText: 'I will try the child once.' },
          { status: 'ok', finalText: 'I will repeat the exact child call.' },
        ],
        adjudications: [
          delegation('code', repeatedText, [
            {
              playbookId: 'code',
              purpose: 'Retry only if new information changes the input.',
            },
          ]),
          continuation('code', repeatedText),
        ],
        children: [childStart],
      });
      const runtime = await initRuntime(harness);

      const opened = await runtime.handleBossInput({
        text: 'Try once, then reassess.',
        signal: signal(),
      });
      const completed =
        delivery === 'resumed'
          ? opened.outcome === 'suspended'
            ? await runtime.resumePlaybookCall({
                callId: opened.pendingCall.callId,
                result: childResult,
                signal: signal(),
              })
            : (() => {
                throw new Error('Expected a suspended child call');
              })()
          : opened;

      expect(completed).toMatchObject({
        outcome: 'failed',
        state: { stateId: 'failed', tags: ['playbook.parked'] },
      });
      expect(harness.childCalls).toHaveLength(1);
      expect(harness.captainCalls[1].prompt).toContain(
        'Do not repeat an equivalent failed or completed call without new information.',
      );
      await runtime.dispose();
    },
  );

  it('accepts a same-target continuation with new input information', async () => {
    const initialPlan = [
      {
        playbookId: 'code',
        purpose: 'Refine the implementation from the first result.',
      },
    ];
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will implement first.' },
        { status: 'ok', finalText: 'I will refine from the result.' },
        { status: 'ok', finalText: 'The refinement is complete.' },
      ],
      adjudications: [
        delegation('code', 'Implement the initial version.', initialPlan),
        continuation(
          'code',
          'Refine the implementation using result summary implemented-v1.',
        ),
        finalResponse(),
      ],
      children: [
        settledSuccess('code', '10000000-0000-4000-8000-000000000010', {
          summary: 'implemented-v1',
        }),
        settledSuccess('code', '10000000-0000-4000-8000-000000000011', {
          summary: 'refined-v2',
        }),
      ],
    });
    const runtime = await initRuntime(harness);

    const result = await runtime.handleBossInput({
      text: 'Implement and refine once.',
      signal: signal(),
    });

    expectTerminalResponse(result, 'The refinement is complete.');
    expect(
      harness.childCalls.map(({ request }) => [
        request.playbookId,
        request.text,
      ]),
    ).toEqual([
      ['code', 'Implement the initial version.'],
      [
        'code',
        'Refine the implementation using result summary implemented-v1.',
      ],
    ]);
    await runtime.dispose();
  });

  it('rejects a continuation whose remaining plan does not shrink', async () => {
    const unchangedPlan = [
      { playbookId: 'discuss', purpose: 'Compare the implementation.' },
    ];
    const harness = makeHarness({
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
        captains: [
          { status: 'ok', finalText: 'I will try CODE.' },
          { status: 'ok', finalText: 'I accounted for the child result.' },
        ],
        adjudications: [
          delegation('code', 'Try the implementation.'),
          finalResponse(),
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
            stateId: opened.state.stateId,
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

  it.each([
    {
      label: 'missing target and normalized error',
      result: { status: 'error' },
    },
    {
      label: 'status-incompatible output',
      result: {
        status: 'error',
        playbookId: 'code',
        error: { name: 'Error', message: 'Child failed.' },
        output: { shouldNotExist: true },
      },
    },
    {
      label: 'empty child session identity',
      result: {
        status: 'aborted',
        playbookId: 'code',
        childSessionId: '',
      },
    },
    {
      label: 'malformed public state',
      result: {
        status: 'aborted',
        playbookId: 'code',
        state: { status: 'active', quiescent: true },
      },
    },
    {
      label: 'normalized error with an undeclared field',
      result: {
        status: 'error',
        playbookId: 'code',
        error: {
          name: 'Error',
          message: 'Child failed.',
          privateDetail: 'must not enter evidence',
        },
      },
    },
  ])('routes a malformed child result with $label to failed without reassessment evidence', async ({ result }) => {
    const controlError = new Error('Child transport failed');
    Object.defineProperty(controlError, 'result', {
      value: result,
      enumerable: true,
    });
    let reassessmentCalls = 0;
    const machine = captainMachine.provide({
      actors: {
        captain: fromPromise<CaptainOutput, CaptainInput>(
          async ({ input }) => {
            if (input.sourceItem === 'CAPTAIN-3') {
              reassessmentCalls += 1;
              return {
                guard: 'final',
                response: 'Malformed control errors must not reach reassessment.',
              };
            }
            return {
              guard: 'delegation',
              remainingPlan: [],
              nextPlaybookId: 'code',
              nextPlaybookInput: 'Run the child once.',
            };
          },
        ),
        playbook: fromPromise<PlaybookOutput, PlaybookInput>(async () => {
          throw controlError;
        }),
      },
    });
    const actor = createActor(machine, {
      input: {
        enabledPlaybooks: ENABLED_PLAYBOOKS,
        selfPlaybookId: 'captain',
      },
    });
    const settled = deferred<ReturnType<typeof actor.getSnapshot>>();
    const subscription = actor.subscribe({
      next: (snapshot) => {
        if (snapshot.value === 'failed' || snapshot.status === 'done') {
          settled.resolve(snapshot);
        }
      },
      error: settled.reject,
    });

    try {
      actor.start();
      actor.send({ type: 'BOSS_INTENT', bossIntent: 'Delegate one child.' });
      const snapshot = await within(settled.promise);

      expect(snapshot.value).toBe('failed');
      expect(reassessmentCalls).toBe(0);
      expect(snapshot.context.completedCallResults).toEqual([]);
      expect(snapshot.context.lastError).toMatchObject({
        name: 'Error',
        message: 'Child transport failed',
      });
    } finally {
      subscription.unsubscribe();
      actor.stop();
    }
  });

  it('clears a failed resume boundary while retaining the pending child for a valid retry', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000006';
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will delegate.' },
        { status: 'ok', finalText: 'The resumed child completed.' },
      ],
      adjudications: [
        delegation('code', 'Complete the resumable work.'),
        finalResponse(),
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
    const bossBoundaryCount = harness.traces.filter(
      (trace) =>
        trace.type === 'boss.input.received' ||
        trace.type === 'boss.input.settled',
    ).length;

    await expect(
      runtime.resumePlaybookCall({
        callId: `${opened.pendingCall.callId}:wrong`,
        result: childResult,
        signal: signal(),
      }),
    ).rejects.toThrow(/does not match|unknown|stale/i);

    const completed = await runtime.resumePlaybookCall({
      callId: opened.pendingCall.callId,
      result: childResult,
      signal: signal(),
    });
    expectTerminalResponse(completed, 'The resumed child completed.');
    expectPairedCalls(harness.traces, 'playbook');
    expect(
      harness.traces.filter(
        (trace) =>
          trace.type === 'boss.input.received' ||
          trace.type === 'boss.input.settled',
      ),
    ).toHaveLength(bossBoundaryCount);
    await runtime.dispose();
  });

  it('prefers malformed resumed output over a later failed-status sink error', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000007';
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will delegate.' },
        { status: 'ok', finalText: 'I will route recovery to DISCUSS.' },
        { status: 'ok', finalText: 'Recovery completed from child evidence.' },
      ],
      adjudications: [
        delegation('code', 'Return structured work.'),
        delegation('discuss', 'Recover from the malformed child result.'),
        finalResponse(),
      ],
      children: [
        { state: 'suspended', childSessionId },
        settledSuccess(
          'discuss',
          '10000000-0000-4000-8000-000000000017',
          { summary: 'recovered' },
        ),
      ],
    });
    let rejectedFailedStatus = false;
    let rejectNextStatus = false;
    const ports: PlaybookPorts = {
      ...harness.ports,
      emitStatus: async (message, data) => {
        await harness.ports.emitStatus(message, data);
        if (!rejectedFailedStatus && rejectNextStatus) {
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

    rejectNextStatus = true;
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
      text: 'Recover through a child playbook.',
      signal: signal(),
    });
    expectTerminalResponse(
      recovered,
      'Recovery completed from child evidence.',
    );
    await runtime.dispose();
  });

  it('drains a resumed finish-sink failure without poisoning the next turn', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000008';
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will delegate.' },
        { status: 'ok', finalText: 'I will route trace recovery to DISCUSS.' },
        { status: 'ok', finalText: 'Trace recovery used child evidence.' },
      ],
      adjudications: [
        delegation('code', 'Return traced structured work.'),
        delegation('discuss', 'Recover after the trace failure.'),
        finalResponse(),
      ],
      children: [
        { state: 'suspended', childSessionId },
        settledSuccess(
          'discuss',
          '10000000-0000-4000-8000-000000000018',
          { summary: 'trace recovery complete' },
        ),
      ],
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
    ).rejects.toThrow(/unknown.*stale/i);

    const recovered = await runtime.handleBossInput({
      text: 'Recover after the trace failure.',
      signal: signal(),
    });
    expectTerminalResponse(recovered, 'Trace recovery used child evidence.');
    await runtime.dispose();
  });

  it.each(['unknown', 'captain'])(
    'rejects the %s dynamic target before opening any child',
    async (target) => {
      const harness = makeHarness({
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
      reply: { guard: 'delegation' },
      error: /missing (?:required field )?remainingPlan|required field|omitted/i,
    },
    {
      name: 'an adjudicator-authored visible question',
      reply: { guard: 'question', question: 'Spoofed hidden question.' },
      error: /must not supply.*presentation|undeclared field question/i,
    },
  ])(
    'rejects $name as a control-plane error after the one corrective re-ask',
    async ({ reply, error }) => {
      // CAPPLAY-18/19: a malformed reply is re-asked exactly once, so a
      // persistently malformed judge fails the turn after two calls.
      const harness = makeHarness({
        captains: [{ status: 'ok', finalText: 'A visible routing decision.' }],
        adjudications: [reply, reply],
      });
      const runtime = await initRuntime(harness);

      await expect(
        runtime.handleBossInput({ text: 'Route this request.', signal: signal() }),
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
      expect(
        harness.judgeCalls.filter(({ purpose }) => purpose === 'adjudication'),
      ).toHaveLength(2);
      expectPairedCalls(harness.traces, 'captain');
      expectPairedCalls(harness.traces, 'judge');
      expect(
        harness.traces.filter((trace) => trace.type === 'judge.call.started'),
      ).toHaveLength(2);
      await runtime.dispose();
    },
  );

  // CAPPLAY-19: the adjudication prompt states the explicit `{ guard, … }`
  // contract, and the reply shape observed in issue #13 — the declared
  // outcome's payload without a `guard` key — recovers through exactly one
  // corrective re-ask instead of aborting the turn.
  it('recovers a conversational routing turn after one corrective adjudication re-ask', async () => {
    const visibleReply =
      'Hello! I route work to enabled playbooks. What would you like to work on?';
    const harness = makeHarness({
      classifications: [{ type: 'BOSS_REPLY' }],
      captains: [
        { status: 'ok', finalText: visibleReply },
        { status: 'ok', finalText: 'I will route this request to CODE.' },
        { status: 'ok', finalText: 'The JSDoc comment was added.' },
      ],
      adjudications: [
        // The issue #13 reply shape: the declared outcome's payload with no
        // `guard` key. The decoy text keeps a judge-authored question
        // distinguishable from the preserved visible Captain prose.
        { question: 'Spoofed hidden question.' },
        { guard: 'question' },
        delegation('code', 'Add a JSDoc block comment to parseArgs.'),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000042',
          { summary: 'JSDoc comment added' },
        ),
      ],
    });
    const runtime = await initRuntime(harness);

    const parked = await runtime.handleBossInput({
      text: 'hello, what can you do?',
      signal: signal(),
    });
    expect(parked).toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'awaitBossReply', quiescent: true },
    });

    const adjudications = harness.judgeCalls.filter(
      ({ purpose }) => purpose === 'adjudication',
    );
    expect(adjudications).toHaveLength(2);
    // The whole reply contract, not just its opening clause: the declared
    // result keys and the exact `{ guard, … }` shape are what a judge needs
    // in order not to answer with a bare payload.
    expect(adjudications[0].prompt).toContain('Result keys and descriptions:');
    for (const guard of ['question', 'delegation', 'needsBossReply']) {
      expect(adjudications[0].prompt).toContain(`- \`${guard}\` — `);
    }
    expect(adjudications[0].prompt).toContain(
      'Pick exactly one outcome by `guard` and return JSON ' +
        '`{ guard, …structuralPayloadFields }`. Do not include `question` or ' +
        '`response`; the runtime injects the visible text.',
    );
    expect(adjudications[1].prompt).toContain(adjudications[0].prompt);
    expect(adjudications[1].prompt).toMatch(
      /previous control reply was rejected/,
    );
    expect(adjudications[1].prompt).toMatch(/undeclared guard/);
    expectPairedCalls(harness.traces, 'captain');
    expectPairedCalls(harness.traces, 'judge');
    expect(
      harness.traces.filter((trace) => trace.type === 'judge.call.started'),
    ).toHaveLength(2);

    // The session stays usable: the Boss's answer resumes the same runtime
    // and delegates as usual, and the resumed prompt carries the Captain's
    // own visible prose as the parked question — not the rejected reply's.
    const delegated = await runtime.handleBossInput({
      text: 'add a JSDoc block comment to parseArgs',
      signal: signal(),
    });
    expect(harness.captainCalls[1].prompt).toContain('Boss question:');
    expect(harness.captainCalls[1].prompt).toContain(visibleReply);
    expect(harness.captainCalls[1].prompt).not.toContain(
      'Spoofed hidden question.',
    );
    expectTerminalResponse(delegated, 'The JSDoc comment was added.');
    expect(harness.childCalls).toHaveLength(1);
    await runtime.dispose();
  });

  it.each([
    { boundary: 'captain' as const },
    { boundary: 'judge' as const },
  ])(
    'returns and traces the same aborted result when an in-flight $boundary boundary observes Boss abort',
    async ({ boundary }) => {
      const portStarted = deferred<void>();
      const abortReason = new DOMException(
        `Boss aborted the ${boundary} boundary`,
        'AbortError',
      );
      const waitForAbort = async (receivedSignal: AbortSignal): Promise<never> => {
        portStarted.resolve();
        if (!receivedSignal.aborted) {
          await new Promise<void>((resolve) =>
            receivedSignal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
        }
        throw receivedSignal.reason;
      };
      const harness =
        boundary === 'captain'
          ? makeHarness({
              captains: [async (_prompt, receivedSignal) => waitForAbort(receivedSignal)],
            })
          : makeHarness({
              captains: [
                { status: 'ok', finalText: 'I will route this request.' },
              ],
              adjudications: [
                async (_prompt, receivedSignal) => waitForAbort(receivedSignal),
              ],
            });
      const runtime = await initRuntime(harness);
      const controller = new AbortController();

      const turn = runtime.handleBossInput({
        text: `Route through the ${boundary} boundary.`,
        signal: controller.signal,
      });
      await within(portStarted.promise);
      controller.abort(abortReason);
      const result = await within(turn);
      const settled = [...harness.traces]
        .reverse()
        .find((trace) => trace.type === 'boss.input.settled');
      const projected = {
        outcome: result.outcome,
        state: result.state,
        ...(result.state.stateId === undefined
          ? {}
          : { stateId: result.state.stateId }),
        ...('error' in result && result.error !== undefined
          ? { error: result.error }
          : {}),
      };

      expect(result).toMatchObject({
        outcome: 'aborted',
        error: { name: 'AbortError', message: abortReason.message },
      });
      expect(settled).toMatchObject({ turnId: expect.any(Number) });
      expect(settled?.payload).toEqual(projected);
      await runtime.dispose();
    },
  );

  it.each([
    {
      label: 'AbortError reason',
      abortReason: new DOMException(
        'Boss aborted the parked classifier',
        'AbortError',
      ),
    },
    {
      label: 'ordinary Error reason',
      abortReason: new Error('Boss cancelled the parked classifier'),
    },
  ])('returns and traces the same aborted result when a parked classifier observes Boss abort with an $label', async ({ abortReason }) => {
    const classifierStarted = deferred<void>();
    const harness = makeHarness({
      classifications: [
        async (_prompt, receivedSignal) => {
          classifierStarted.resolve();
          if (!receivedSignal.aborted) {
            await new Promise<void>((resolve) =>
              receivedSignal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          }
          throw receivedSignal.reason;
        },
      ],
      captains: [{ status: 'ok', finalText: 'Which route should I use?' }],
      adjudications: [{ guard: 'question' }],
    });
    const runtime = await initRuntime(harness);
    await runtime.handleBossInput({
      text: 'Ask for routing input.',
      signal: signal(),
    });
    const controller = new AbortController();

    const turn = runtime.handleBossInput({
      text: 'Classify this interrupted reply.',
      signal: controller.signal,
    });
    await within(classifierStarted.promise);
    controller.abort(abortReason);
    const result = await within(turn);
    const settled = [...harness.traces]
      .reverse()
      .find((trace) => trace.type === 'boss.input.settled');
    const projected = {
      outcome: result.outcome,
      state: result.state,
      ...(result.state.stateId === undefined
        ? {}
        : { stateId: result.state.stateId }),
      ...('error' in result && result.error !== undefined
        ? { error: result.error }
        : {}),
    };

    expect(result).toMatchObject({
      outcome: 'aborted',
      error: { name: abortReason.name, message: abortReason.message },
    });
    expect(settled?.payload).toEqual(projected);
    await runtime.dispose();
  });

  it('preserves a classifier transport failure that coincides with Boss abort', async () => {
    const classifierStarted = deferred<void>();
    const transportError = new Error(
      'Classifier transport failed during Boss abort',
    );
    const harness = makeHarness({
      classifications: [
        async (_prompt, receivedSignal) => {
          classifierStarted.resolve();
          if (!receivedSignal.aborted) {
            await new Promise<void>((resolve) =>
              receivedSignal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          }
          throw transportError;
        },
      ],
      captains: [{ status: 'ok', finalText: 'Which route should I use?' }],
      adjudications: [{ guard: 'question' }],
    });
    const runtime = await initRuntime(harness);
    const parked = await runtime.handleBossInput({
      text: 'Ask for routing input.',
      signal: signal(),
    });
    const traceOffset = harness.traces.length;
    const controller = new AbortController();

    const turn = runtime.handleBossInput({
      text: 'Classify this interrupted reply.',
      signal: controller.signal,
    });
    await within(classifierStarted.promise);
    controller.abort(new Error('Boss cancelled classification'));
    await expect(turn).rejects.toBe(transportError);
    const boundaryTraces = harness.traces.slice(traceOffset);
    const judgeFinish = boundaryTraces.find(
      (trace) => trace.type === 'judge.call.finished',
    );
    const settled = boundaryTraces.find(
      (trace) => trace.type === 'boss.input.settled',
    );

    expect(judgeFinish?.payload).toMatchObject({
      status: 'error',
      error: {
        name: 'Error',
        message: transportError.message,
      },
    });
    expect(settled?.payload).toMatchObject({
      outcome: 'no-action',
      state: parked.state,
      error: {
        name: 'Error',
        message: transportError.message,
      },
    });
    await runtime.dispose();
  });

  it.each([
    {
      label: 'ordinary Error',
      sinkError: new Error('Captain finish trace sink failed during abort'),
    },
    {
      label: 'AbortError-named error',
      sinkError: new DOMException(
        'Captain finish trace sink failed during abort',
        'AbortError',
      ),
    },
  ])('rejects a distinct $label trace sink failure while a Captain boundary is aborting', async ({ sinkError }) => {
    const portStarted = deferred<void>();
    const harness = makeHarness({
      captains: [
        async (_prompt, receivedSignal) => {
          portStarted.resolve();
          if (!receivedSignal.aborted) {
            await new Promise<void>((resolve) =>
              receivedSignal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          }
          throw receivedSignal.reason;
        },
      ],
      rejectTraceType: 'captain.call.finished',
      rejectTraceError: sinkError,
    });
    const runtime = await initRuntime(harness);
    const controller = new AbortController();

    const turn = runtime
      .handleBossInput({
        text: 'Abort while the Captain is running.',
        signal: controller.signal,
      })
      .then(
        (result) => ({ kind: 'resolved' as const, result }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
    await within(portStarted.promise);
    controller.abort(new DOMException('Boss aborted the turn', 'AbortError'));
    const settlement = await within(turn);
    await runtime.dispose();

    expect(settlement).toEqual({ kind: 'rejected', error: sinkError });
  });

  it('preserves an AbortError-named Captain transport failure over its finish-sink failure', async () => {
    const transportError = new DOMException(
      'Captain transport emitted an abort-like error',
      'AbortError',
    );
    const sinkError = new Error('Captain finish trace sink failed');
    const harness = makeHarness({
      captains: [async () => Promise.reject(transportError)],
      rejectTraceType: 'captain.call.finished',
      rejectTraceError: sinkError,
    });
    const runtime = await initRuntime(harness);

    await expect(
      runtime.handleBossInput({
        text: 'Run through an abort-shaped transport failure.',
        signal: signal(),
      }),
    ).rejects.toBe(transportError);
    expect(
      harness.traces.filter(
        (trace) => trace.type === 'captain.call.finished',
      ),
    ).toHaveLength(1);
    await runtime.dispose();
  });

  it('forwards abort into a visible Captain call and waits for its natural failure', async () => {
    const portStarted = deferred<void>();
    const portFinished = deferred<void>();
    const forceWake = deferred<void>();
    let portSignal: AbortSignal | undefined;
    const harness = makeHarness({
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
      expected: /final\s*text|finalText/i,
    },
  ])(
    'rejects a Captain $label as a control error',
    async ({ captain, expected }) => {
      const harness = makeHarness({
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
      captains: [{ status: 'ok' }],
      rejectTraceType: 'captain.call.finished',
    });
    const runtime = await initRuntime(harness);

    await expect(
      runtime.handleBossInput({
        text: 'Answer this intent.',
        signal: signal(),
      }),
    ).rejects.toThrow(/final\s*text|finalText/i);

    expectPairedCalls(harness.traces, 'captain');
    await runtime.dispose();
  });

  it('attempts a Captain finish when the start trace records then rejects', async () => {
    const harness = makeHarness({
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

  it('pairs a rejected adjudication judge call, settles the failed turn, and remains recoverable', async () => {
    const judgeError = new Error('Adjudication judge transport failed');
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will route this request.' },
        { status: 'ok', finalText: 'I will retry the route.' },
        { status: 'ok', finalText: 'The retried route completed.' },
      ],
      adjudications: [
        async () => {
          throw judgeError;
        },
        delegation('code', 'Complete the retried request.'),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000021',
          { summary: 'retried request completed' },
        ),
      ],
    });
    const runtime = await initRuntime(harness);

    let rejection: unknown;
    try {
      await runtime.handleBossInput({
        text: 'Route the first request.',
        signal: signal(),
      });
    } catch (error) {
      rejection = error;
    }
    const failedBoundary = [...harness.traces];

    const recovered = await runtime.handleBossInput({
      text: 'Retry with a fresh request.',
      signal: signal(),
    });

    expect(rejection).toBe(judgeError);
    expectTerminalResponse(recovered, 'The retried route completed.');
    const starts = failedBoundary.filter(
      (trace) => trace.type === 'judge.call.started',
    );
    const finishes = failedBoundary.filter(
      (trace) => trace.type === 'judge.call.finished',
    );
    expect(starts).toHaveLength(1);
    expect(finishes.map(({ callId }) => callId)).toEqual(
      starts.map(({ callId }) => callId),
    );
    expect(finishes[0]).toMatchObject({
      turnId: starts[0].turnId,
      payload: {
        status: 'error',
        error: {
          name: 'Error',
          message: 'Adjudication judge transport failed',
        },
      },
    });
    expect(
      failedBoundary.find((trace) => trace.type === 'boss.input.settled'),
    ).toMatchObject({
      payload: {
        outcome: 'failed',
        state: { quiescent: true },
        error: {
          name: 'Error',
          message: 'Adjudication judge transport failed',
        },
      },
    });
    await runtime.dispose();
  });

  it('pairs a rejected parked-state classifier, settles against the unchanged state, and accepts a later directive', async () => {
    const judgeError = new Error('Classifier judge transport failed');
    const harness = makeHarness({
      classifications: [
        async () => {
          throw judgeError;
        },
        { type: 'BOSS_INTENT' },
      ],
      captains: [
        { status: 'ok', finalText: 'Which route should I use?' },
        { status: 'ok', finalText: 'I will route the fresh directive.' },
        { status: 'ok', finalText: 'The fresh directive completed.' },
      ],
      adjudications: [
        { guard: 'question' },
        delegation('code', 'Complete the fresh directive.'),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000022',
          { summary: 'fresh directive completed' },
        ),
      ],
    });
    const runtime = await initRuntime(harness);
    const parked = await runtime.handleBossInput({
      text: 'Ask before choosing a route.',
      signal: signal(),
    });
    expect(parked).toMatchObject({
      outcome: 'quiescent',
      state: { quiescent: true },
    });
    const traceOffset = harness.traces.length;

    let rejection: unknown;
    try {
      await runtime.handleBossInput({
        text: 'This classification attempt should fail.',
        signal: signal(),
      });
    } catch (error) {
      rejection = error;
    }
    const failedBoundary = harness.traces.slice(traceOffset);

    const recovered = await runtime.handleBossInput({
      text: 'Treat this as a fresh directive.',
      signal: signal(),
    });

    expect(rejection).toBe(judgeError);
    expectTerminalResponse(recovered, 'The fresh directive completed.');
    const received = failedBoundary.find(
      (trace) => trace.type === 'boss.input.received',
    );
    const starts = failedBoundary.filter(
      (trace) => trace.type === 'judge.call.started',
    );
    const finishes = failedBoundary.filter(
      (trace) => trace.type === 'judge.call.finished',
    );
    expect(starts).toHaveLength(1);
    expect(finishes.map(({ callId }) => callId)).toEqual(
      starts.map(({ callId }) => callId),
    );
    expect(starts[0].turnId).toBe(received?.turnId);
    expect(finishes[0]).toMatchObject({
      turnId: received?.turnId,
      payload: {
        status: 'error',
        error: {
          name: 'Error',
          message: 'Classifier judge transport failed',
        },
      },
    });
    expect(
      failedBoundary.find((trace) => trace.type === 'boss.input.settled'),
    ).toMatchObject({
      turnId: received?.turnId,
      payload: {
        outcome: 'no-action',
        state: parked.state,
        error: {
          name: 'Error',
          message: 'Classifier judge transport failed',
        },
      },
    });
    await runtime.dispose();
  });

  it('pairs a rejected judge start trace without crossing the judge port', async () => {
    const startError = new Error('Injected judge start trace sink failure');
    const harness = makeHarness({
      captains: [{ status: 'ok', finalText: 'I will route this request.' }],
      rejectTraceType: 'judge.call.started',
      rejectTraceError: startError,
    });
    const runtime = await initRuntime(harness);

    let rejection: unknown;
    try {
      await runtime.handleBossInput({
        text: 'Route this request.',
        signal: signal(),
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBe(startError);
    expect(harness.judgeCalls).toHaveLength(0);
    const starts = harness.traces.filter(
      (trace) => trace.type === 'judge.call.started',
    );
    const finishes = harness.traces.filter(
      (trace) => trace.type === 'judge.call.finished',
    );
    expect(starts).toHaveLength(1);
    expect(finishes.map(({ callId }) => callId)).toEqual(
      starts.map(({ callId }) => callId),
    );
    expect(finishes[0]).toMatchObject({
      turnId: starts[0].turnId,
      payload: {
        status: 'error',
        error: {
          name: 'Error',
          message: 'Injected judge start trace sink failure',
        },
      },
    });
    await runtime.dispose();
  });

  it('stops the root before disposing a suspended child bridge', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000005';
    const harness = makeHarness({
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

  it('finishes session disposal after suspended-child cleanup rejects', async () => {
    const childSessionId = '10000000-0000-4000-8000-000000000023';
    const harness = makeHarness({
      captains: [{ status: 'ok', finalText: 'I will delegate.' }],
      adjudications: [delegation('code', 'Wait for Boss in the child.')],
      children: [{ state: 'suspended', childSessionId }],
      rejectTraceType: 'playbook.call.finished',
    });
    const runtime = await initRuntime(harness);
    await runtime.handleBossInput({
      text: 'Delegate before cleanup.',
      signal: signal(),
    });

    const disposal = runtime.dispose();
    await expect(disposal).rejects.toThrow(
      'Injected playbook.call.finished trace sink failure',
    );

    expectPairedCalls(harness.traces, 'playbook');
    const types = harness.traces.map(({ type }) => type);
    expect(types.lastIndexOf('session.disposed')).toBeGreaterThan(
      types.lastIndexOf('playbook.call.finished'),
    );
    expect(runtime.dispose()).toBe(disposal);
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
      classifications: [{ type: 'NO_ACTION' }],
      captains: [
        { status: 'ok', finalText: 'I will route this once.' },
        { status: 'ok', finalText: 'The one child call completed.' },
      ],
      adjudications: [delegation('code', 'Complete this once.'), finalResponse()],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000019',
          { summary: 'completed once' },
        ),
      ],
    });
    const runtime = await initRuntime(harness);
    const terminal = await runtime.handleBossInput({
      text: 'Answer once.',
      signal: signal(),
    });
    expectTerminalResponse(terminal, 'The one child call completed.');
    const transitionCount = harness.traces.filter(
      (trace) => trace.type === 'fsm.transition',
    ).length;
    const statusCount = harness.statuses.length;
    const traceOffset = harness.traces.length;

    const noAction = await runtime.handleBossInput({
      text: 'No state change.',
      signal: signal(),
    });

    expect(noAction).toMatchObject({
      outcome: 'no-action',
      state: { stateId: 'done', status: 'done', quiescent: true },
    });
    expect(harness.captainCalls).toHaveLength(2);
    expect(
      harness.traces.filter((trace) => trace.type === 'fsm.transition'),
    ).toHaveLength(transitionCount);
    expect(harness.statuses).toHaveLength(statusCount);
    expect(
      harness.traces
        .slice(traceOffset)
        .filter((trace) => trace.type === 'status.emitted'),
    ).toHaveLength(0);
    await runtime.dispose();
  });

  it('leaves a terminal actor untouched when Boss aborts a recorded classifier finish', async () => {
    const finishRecorded = deferred<void>();
    const releaseFinish = deferred<void>();
    let blocked = false;
    const harness = makeHarness({
      classifications: [{ type: 'BOSS_INTENT' }],
      captains: [
        { status: 'ok', finalText: 'I will route this once.' },
        { status: 'ok', finalText: 'The one child call completed.' },
      ],
      adjudications: [delegation('code', 'Complete this once.'), finalResponse()],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000024',
          { summary: 'completed once' },
        ),
      ],
    });
    const ports: PlaybookPorts = {
      ...harness.ports,
      emitTelemetry: async (event) => {
        await harness.ports.emitTelemetry(event);
        if (
          !blocked &&
          isTraceTelemetry(event) &&
          event.payload.type === 'judge.call.finished' &&
          tracePayload(event.payload).purpose === 'boss-input-classification'
        ) {
          blocked = true;
          finishRecorded.resolve();
          await releaseFinish.promise;
        }
      },
    };
    const runtime = createPlaybookRuntime({
      enabledPlaybooks: ENABLED_PLAYBOOKS,
    });
    await runtime.init(makeSession(ports));
    const terminal = await runtime.handleBossInput({
      text: 'Complete one routed call.',
      signal: signal(),
    });
    expectTerminalResponse(terminal, 'The one child call completed.');
    const traceOffset = harness.traces.length;
    const transitionCount = harness.traces.filter(
      (trace) => trace.type === 'fsm.transition',
    ).length;
    const abortReason = new DOMException(
      'Boss aborted after classifier finish',
      'AbortError',
    );
    const controller = new AbortController();

    const turn = runtime.handleBossInput({
      text: 'Do not restart the terminal actor.',
      signal: controller.signal,
    });
    await within(finishRecorded.promise);
    controller.abort(abortReason);
    releaseFinish.resolve();
    const result = await within(turn);
    const boundaryTraces = harness.traces.slice(traceOffset);
    const settled = [...boundaryTraces]
      .reverse()
      .find((trace) => trace.type === 'boss.input.settled');
    const projected = {
      outcome: result.outcome,
      state: result.state,
      ...(result.state.stateId === undefined
        ? {}
        : { stateId: result.state.stateId }),
      ...('error' in result && result.error !== undefined
        ? { error: result.error }
        : {}),
    };

    expect(result).toMatchObject({
      outcome: 'aborted',
      state: terminal.state,
      error: { name: 'AbortError', message: abortReason.message },
    });
    expect(settled?.payload).toEqual(projected);
    expect(
      harness.traces.filter((trace) => trace.type === 'fsm.transition'),
    ).toHaveLength(transitionCount);
    expect(
      boundaryTraces.filter(
        (trace) =>
          trace.type === 'status.emitted' ||
          trace.type === 'captain.call.started',
      ),
    ).toHaveLength(0);
    expect(harness.captainCalls).toHaveLength(2);
    await runtime.dispose();
  });

  it('snapshots session identity and the exact catalog before caller mutation', async () => {
    const mutableCatalog: Array<{
      id: string;
      command: string;
      intent: string;
    }> = ENABLED_PLAYBOOKS.map((entry) => ({ ...entry }));
    const harness = makeHarness({
      captains: [
        { status: 'ok', finalText: 'I will route using the original catalog.' },
        { status: 'ok', finalText: 'Original catalog routing completed.' },
      ],
      adjudications: [
        delegation('code', 'Use the original catalog data.'),
        finalResponse(),
      ],
      children: [
        settledSuccess(
          'code',
          '10000000-0000-4000-8000-000000000020',
          { summary: 'original catalog used' },
        ),
      ],
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
    expectTerminalResponse(result, 'Original catalog routing completed.');
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

  it.each([
    {
      label: 'an empty catalog field',
      catalog: [{ id: 'code', command: '', intent: 'Implement changes.' }],
    },
    {
      label: 'duplicate stable ids',
      catalog: [
        { id: 'code', command: 'code', intent: 'Implement changes.' },
        { id: 'code', command: 'code-again', intent: 'Implement again.' },
      ],
    },
    {
      label: 'an extra entry field',
      catalog: [
        {
          id: 'code',
          command: 'code',
          intent: 'Implement changes.',
          hidden: 'not part of the host boundary',
        },
      ],
    },
  ])('rejects $label in the enabled catalog', ({ catalog }) => {
    expect(() =>
      createPlaybookRuntime({
        enabledPlaybooks: catalog as unknown as typeof ENABLED_PLAYBOOKS,
      }),
    ).toThrow();
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
      captains: [
        { status: 'ok', finalText: 'I will delegate.' },
        { status: 'ok', finalText: 'Delegation complete.' },
      ],
      adjudications: [
        delegation('code', 'Do the traced work.'),
        finalResponse(),
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
    const transitions = harness.traces.filter(
      (trace) => trace.type === 'fsm.transition',
    );
    const stateTelemetry = harness.telemetry.filter(
      (event) => event.topic === 'playbook.fsm.state',
    );
    expect(stateTelemetry.map(({ payload }) => payload)).toEqual(
      transitions.map(({ payload }) => payload),
    );
    for (let index = 0; index < transitions.length; index += 1) {
      const payload = tracePayload(transitions[index]);
      expect(payload).toMatchObject({
        from: expect.any(Object),
        to: expect.any(Object),
        previousState: expect.any(Object),
        state: expect.any(Object),
      });
      expect(payload.to).toEqual(payload.state);
      expect(payload.from).toEqual(payload.previousState);
      if (index > 0) {
        expect(payload.from).toEqual(tracePayload(transitions[index - 1]).state);
      }
    }
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
    expect(tracePayload(childStart!).stateId).toEqual(
      tracePayload(childFinish!).stateId,
    );
    expect(tracePayload(childStart!)).toMatchObject({
      playbookId: harness.childCalls[0].request.playbookId,
      text: harness.childCalls[0].request.text,
    });
  });
});
