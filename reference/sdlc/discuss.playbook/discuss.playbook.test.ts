// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import createPlaybookRuntime, {
  _internal,
  type PlayerCallOptions,
  type PlaybookPorts,
  type PlaybookSession,
  type PlaybookTraceEvent,
} from './discuss.playbook.ts';

const { requiredFieldsFor, parseAdjudication, normalizeErrorCompact } =
  _internal;

// The DISCUSS-5 wroteChanges description as authored in discuss.fsm.ts —
// one "Output shall include" sentence naming two fields. The integration
// test below exercises the live FSM text; this literal pins the parsing
// contract at unit level.
const WROTE_CHANGES_DESCRIPTION =
  'Host wrote the agreed changes. Output shall include `latestChanges: <summary>` and `reviewScope: "specItems" | "decisionRecords" | "mixed"`.';

const signal = (): AbortSignal => new AbortController().signal;

function playbookSession(
  ports: PlaybookPorts,
  sessionId = 'discuss-session-1',
): PlaybookSession {
  return { sessionId, playbookId: 'discuss', ports };
}

type TraceEvent = Omit<PlaybookTraceEvent, 'payload'> & {
  payload: Record<string, unknown>;
};

function terminalDiscussionJudgeReplies(
  topic = 'Decide spec heading case.',
): string[] {
  return [
    JSON.stringify({ event: 'START_DISCUSSION', topic }),
    JSON.stringify({ guard: 'proposalMade', proposal: 'host proposal' }),
    JSON.stringify({
      guard: 'proposalMade',
      proposal: 'participant proposal',
    }),
    JSON.stringify({ guard: 'endedInitialDiscussion', agreement: 'agreed' }),
    JSON.stringify({ guard: 'endedInitialDiscussion', agreement: 'agreed' }),
    JSON.stringify({
      guard: 'wroteChanges',
      latestChanges: 'Created DR-001',
      reviewScope: 'mixed',
    }),
    JSON.stringify({
      guard: 'committed',
      latestChanges: 'Commit 753b6c8',
      reviewScope: 'mixed',
    }),
    JSON.stringify({ guard: 'noFindings' }),
    JSON.stringify({ guard: 'committed' }),
  ];
}

describe('requiredFieldsFor (slc/link.md §Captain adjudication)', () => {
  it('extracts every field a single "Output shall include" sentence names', () => {
    // Regression: the previous regex anchored each field to the literal
    // phrase, so DISCUSS-5's second field (`reviewScope`) was silently
    // dropped, context.reviewScope stayed undefined, and the commit
    // state's onDone guard chain fell through to `failed`.
    expect(requiredFieldsFor(WROTE_CHANGES_DESCRIPTION)).toEqual([
      'latestChanges',
      'reviewScope',
    ]);
  });

  it('extracts a single named field', () => {
    expect(
      requiredFieldsFor(
        'Host proposed a design. Output shall include `proposal: <host proposal>`.',
      ),
    ).toEqual(['proposal']);
  });

  it('requires nothing from a "may include" description', () => {
    expect(
      requiredFieldsFor(
        'Committer made the initial-discussion commit. Output may include `latestChanges` and `reviewScope`.',
      ),
    ).toEqual([]);
  });

  it('scopes extraction to the "shall include" sentence', () => {
    expect(
      requiredFieldsFor(
        'Output shall include `alpha: <a>`. The reply may mention `beta: <b>`.',
      ),
    ).toEqual(['alpha']);
  });
});

describe('parseAdjudication (slc/link.md §Captain adjudication)', () => {
  const commitInput = {
    player: 'Committer' as const,
    sourceItem: 'DISCUSS-14',
    prompt: 'commit',
    result: {
      committed:
        'Committer made the initial-discussion commit. Output may include `latestChanges` and `reviewScope`.',
    },
  };

  it('carries non-required payload fields through to the output', () => {
    // Regression: only required fields used to be copied, so the judge's
    // volunteered `reviewScope` on the commit adjudication was dropped and
    // `outputOf(event).reviewScope ?? context.reviewScope` could never see
    // it. The judge answer is `{ guard, …payloadFields }` — payload fields
    // flow through.
    const output = parseAdjudication(
      JSON.stringify({
        guard: 'committed',
        latestChanges: 'Commit 753b6c8',
        reviewScope: 'mixed',
      }),
      commitInput,
    );
    expect(output).toEqual({
      guard: 'committed',
      latestChanges: 'Commit 753b6c8',
      reviewScope: 'mixed',
    });
  });

  it('rejects an invalid passthrough reviewScope loudly', () => {
    expect(() =>
      parseAdjudication(
        JSON.stringify({ guard: 'committed', reviewScope: 'everything' }),
        commitInput,
      ),
    ).toThrow(/invalid reviewScope "everything"/);
  });

  it('still fails loudly on a missing required field', () => {
    expect(() =>
      parseAdjudication(JSON.stringify({ guard: 'wroteChanges' }), {
        ...commitInput,
        sourceItem: 'DISCUSS-5',
        result: { wroteChanges: WROTE_CHANGES_DESCRIPTION },
      }),
    ).toThrow(/missing required field "latestChanges"/);
  });

  it('fails loudly when only the second required field is missing', () => {
    expect(() =>
      parseAdjudication(
        JSON.stringify({ guard: 'wroteChanges', latestChanges: 'lc' }),
        {
          ...commitInput,
          sourceItem: 'DISCUSS-5',
          result: { wroteChanges: WROTE_CHANGES_DESCRIPTION },
        },
      ),
    ).toThrow(/missing required field "reviewScope"/);
  });
});

describe('normalizeErrorCompact', () => {
  it('serializes a message-less object instead of "[object Object]"', () => {
    // Regression: a malformed CaptainOutput remembered as lastError used to
    // surface as `message: "[object Object]"`, hiding the payload that
    // explains the failure.
    expect(normalizeErrorCompact({ guard: 'committed' })).toEqual({
      name: 'Error',
      message: '{"guard":"committed"}',
    });
  });

  it('keeps Error name and message', () => {
    expect(normalizeErrorCompact(new TypeError('boom'))).toEqual({
      name: 'TypeError',
      message: 'boom',
    });
  });
});

// End-to-end regression for the production failure: a discussion flow whose
// judge replies mirror the failed run (commit adjudication answering
// `{ guard: "committed", latestChanges, reviewScope }`) must transition from
// commitInitialChanges into the review state and prompt the Participant —
// not fall into `failed` with lastError "[object Object]".
describe('commit → review transition (DISCUSS-14 → DISCUSS-10)', () => {
  it('continues into the mixed review after the Committer commits', async () => {
    const playerCalls: string[] = [];
    const telemetry: Array<Record<string, unknown>> = [];
    // The commit adjudication reply in this script mirrors the failed run:
    // guard plus volunteered payload fields on a "may include" description.
    const judgeReplies = terminalDiscussionJudgeReplies();
    let judgeIndex = 0;

    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        playerCalls.push(playerId);
        return { status: 'ok', finalText: `${playerId} output` };
      },
      callJudge: async () => {
        const reply = judgeReplies[judgeIndex++];
        if (reply === undefined) {
          throw new Error(`unscripted judge call #${judgeIndex}`);
        }
        return reply;
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.fsm.state') {
          telemetry.push(event.payload as Record<string, unknown>);
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports));
    await runtime.handleBossInput({
      text: 'Decide spec heading case.',
      signal: new AbortController().signal,
    });
    await runtime.dispose();

    const visited = telemetry.map((payload) => payload.to);
    expect(visited).not.toContain('failed');
    expect(visited).toContain('commitInitialChanges');
    expect(visited).toContain('reviewMixedInitialCommit');
    expect(visited).toContain('done');
    // Host, Participant, rounds, agreement write, commit (Committer→Host),
    // Participant review, reviewed commit — the review call is the one the
    // regression used to lose.
    expect(playerCalls).toContain('participant');
    expect(playerCalls[playerCalls.length - 2]).toBe('participant');
  });
});

describe('session trace and player continuation (PBRT-37/38/39)', () => {
  it('emits a boundary-complete ordered trace and rotates independent player tokens', async () => {
    const traces: TraceEvent[] = [];
    const fsmTelemetry: Array<Record<string, unknown>> = [];
    const statuses: Array<{ message: string; data: unknown }> = [];
    const playerCalls: Array<{
      playerId: string;
      prompt: string;
      options: PlayerCallOptions;
    }> = [];
    const judgePrompts: string[] = [];
    const judgeReplies = terminalDiscussionJudgeReplies('Trace this topic.');
    const playerResults = [
      { status: 'ok' as const, resumeToken: 'host-1', finalText: 'host one' },
      {
        status: 'ok' as const,
        resumeToken: 'participant-1',
        finalText: 'participant one',
      },
      { status: 'ok' as const, resumeToken: 'host-2', finalText: 'host two' },
      {
        status: 'ok' as const,
        resumeToken: 'participant-2',
        finalText: 'participant two',
      },
      // A whitespace-only token is not resumable and clears Host.
      { status: 'ok' as const, resumeToken: ' \t', finalText: 'host writes' },
      { status: 'ok' as const, resumeToken: 'host-3', finalText: 'host commits' },
      {
        status: 'ok' as const,
        resumeToken: 'participant-3',
        finalText: 'participant reviews',
      },
      { status: 'ok' as const, resumeToken: 'host-4', finalText: 'host commits' },
    ];
    let judgeIndex = 0;
    let playerIndex = 0;

    const ports: PlaybookPorts = {
      callPlayer: async (playerId, prompt, _signal, options) => {
        const started = traces.at(-1);
        expect(started?.type).toBe('player.call.started');
        expect(started?.payload).toMatchObject({
          playerId,
          prompt,
          resume: options.resume,
        });
        playerCalls.push({ playerId, prompt, options: { ...options } });
        const result = playerResults[playerIndex++];
        if (!result) throw new Error(`unscripted player call #${playerIndex}`);
        return result;
      },
      callJudge: async (prompt) => {
        const started = traces.at(-1);
        expect(started?.type).toBe('judge.call.started');
        expect(started?.payload.prompt).toBe(prompt);
        judgePrompts.push(prompt);
        const reply = judgeReplies[judgeIndex++];
        if (reply === undefined) {
          throw new Error(`unscripted judge call #${judgeIndex}`);
        }
        return reply;
      },
      emitStatus: async (message, data) => {
        const statusTrace = traces.at(-1);
        expect(statusTrace?.type).toBe('status.emitted');
        expect(statusTrace?.payload).toMatchObject({ message });
        statuses.push({ message, data });
      },
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
          return;
        }
        if (event.topic === 'playbook.fsm.state') {
          const stateTrace = traces.at(-1);
          expect(stateTrace?.type).toBe('fsm.transition');
          expect(stateTrace?.payload).toEqual(event.payload);
          fsmTelemetry.push(event.payload as Record<string, unknown>);
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    const initSession = playbookSession(ports, 'immutable-discuss-session');
    await runtime.init(initSession);
    // The runtime snapshots identity instead of retaining this mutable input.
    initSession.sessionId = 'mutated-session';
    initSession.playbookId = 'mutated-playbook';

    await runtime.handleBossInput({
      text: 'Trace this topic.',
      signal: signal(),
    });
    await runtime.dispose();

    expect(playerCalls).toHaveLength(8);
    expect(judgePrompts).toHaveLength(judgeReplies.length);
    expect(fsmTelemetry.length).toBeGreaterThan(1);
    expect(statuses).toHaveLength(fsmTelemetry.length);
    expect(playerCalls.map((call) => call.playerId)).toEqual([
      'host',
      'participant',
      'host',
      'participant',
      'host',
      'host',
      'participant',
      'host',
    ]);
    expect(playerCalls.map((call) => call.options.resume)).toEqual([
      false,
      false,
      'host-1',
      'participant-1',
      'host-2',
      false,
      'participant-2',
      'host-3',
    ]);

    expect(traces.map((trace) => trace.sequence)).toEqual(
      traces.map((_, index) => index + 1),
    );
    for (const trace of traces) {
      expect(trace).toMatchObject({
        schemaVersion: 1,
        sessionId: 'immutable-discuss-session',
        playbookId: 'discuss',
      });
      expect(Number.isInteger(trace.timestamp)).toBe(true);
      expect(trace.timestamp).toBeGreaterThan(0);
    }

    expect(traces[0]).toMatchObject({
      type: 'session.started',
      payload: { stateId: 'ready' },
    });
    expect(traces.at(-1)).toMatchObject({
      type: 'session.disposed',
      payload: { stateId: 'done' },
    });
    const traceTypes = new Set(traces.map((trace) => trace.type));
    expect(traceTypes).toEqual(
      new Set([
        'session.started',
        'boss.input.received',
        'judge.call.started',
        'judge.call.finished',
        'player.call.started',
        'player.call.finished',
        'fsm.transition',
        'status.emitted',
        'boss.input.settled',
        'session.disposed',
      ]),
    );

    const received = traces.find((trace) => trace.type === 'boss.input.received');
    const settled = traces.find((trace) => trace.type === 'boss.input.settled');
    expect(received).toMatchObject({ turnId: 1, payload: { text: 'Trace this topic.' } });
    expect(settled).toMatchObject({
      turnId: 1,
      payload: { outcome: 'terminal', stateId: 'done' },
    });
    expect(received!.sequence).toBeLessThan(settled!.sequence);

    for (const kind of ['judge', 'player'] as const) {
      const started = traces.filter(
        (trace) => trace.type === `${kind}.call.started`,
      );
      const finished = traces.filter(
        (trace) => trace.type === `${kind}.call.finished`,
      );
      expect(started.map((trace) => trace.callId)).toEqual(
        started.map((_, index) => `${kind}-${index + 1}`),
      );
      expect(finished.map((trace) => trace.callId)).toEqual(
        started.map((trace) => trace.callId),
      );
      for (const start of started) {
        const finish = finished.find((trace) => trace.callId === start.callId);
        expect(start.turnId).toBe(1);
        expect(finish?.turnId).toBe(1);
        expect(start.sequence).toBeLessThan(finish!.sequence);
      }
    }

    const firstPlayerStart = traces.find(
      (trace) => trace.type === 'player.call.started',
    );
    const firstPlayerFinish = traces.find(
      (trace) => trace.type === 'player.call.finished',
    );
    expect(firstPlayerStart?.payload).toMatchObject({
      purpose: 'captain',
      stateId: 'askHostInitial',
      sourceItem: 'DISCUSS-1',
      playerId: 'host',
      resume: false,
      prompt: playerCalls[0].prompt,
    });
    expect(firstPlayerFinish?.payload).toMatchObject({
      status: 'ok',
      resumeToken: 'host-1',
      finalText: 'host one',
    });
    expect(
      traces.find(
        (trace) =>
          trace.type === 'player.call.finished' &&
          trace.payload.resumeToken === ' \t',
      ),
    ).toBeDefined();

    const firstJudgeStart = traces.find(
      (trace) => trace.type === 'judge.call.started',
    );
    const firstJudgeFinish = traces.find(
      (trace) => trace.type === 'judge.call.finished',
    );
    expect(firstJudgeStart?.payload).toMatchObject({
      purpose: 'boss-input-classification',
      stateId: 'ready',
      prompt: judgePrompts[0],
    });
    expect(firstJudgeFinish?.payload).toMatchObject({
      status: 'ok',
      reply: judgeReplies[0],
    });
  });

  it('traces empty input as received/settled without any runtime action', async () => {
    const traces: TraceEvent[] = [];
    let judgeCalls = 0;
    let playerCalls = 0;
    let stateTelemetry = 0;
    let statuses = 0;
    const ports: PlaybookPorts = {
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok' };
      },
      callJudge: async () => {
        judgeCalls++;
        return JSON.stringify({ event: null });
      },
      emitStatus: async () => {
        statuses++;
      },
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        } else if (event.topic === 'playbook.fsm.state') {
          stateTelemetry++;
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'empty-input-session'));
    const traceStart = traces.length;
    const statusStart = statuses;
    const stateStart = stateTelemetry;
    await runtime.handleBossInput({ text: '  \n\t ', signal: signal() });

    expect(traces.slice(traceStart).map((trace) => trace.type)).toEqual([
      'boss.input.received',
      'boss.input.settled',
    ]);
    expect(traces.at(-2)).toMatchObject({
      turnId: 1,
      payload: { text: '  \n\t ' },
    });
    expect(traces.at(-1)).toMatchObject({
      turnId: 1,
      payload: { outcome: 'no-action', stateId: 'ready' },
    });
    expect(judgeCalls).toBe(0);
    expect(playerCalls).toBe(0);
    expect(statuses).toBe(statusStart);
    expect(stateTelemetry).toBe(stateStart);
    await runtime.dispose();
  });

  it('traces a same-state reentering FSM transition', async () => {
    const traces: TraceEvent[] = [];
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'ok' }),
      callJudge: async () =>
        JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'ready' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'same-state-session'));
    const traceStart = traces.length;

    await runtime.handleBossInput({ text: 'stay ready', signal: signal() });

    expect(
      traces.slice(traceStart).find((trace) => trace.type === 'fsm.transition'),
    ).toMatchObject({
      turnId: 1,
      payload: {
        from: 'ready',
        to: 'ready',
        event: 'BOSS_INTERRUPT',
      },
    });
    await runtime.dispose();
  });

  it('recovers its emission queue and still traces settlement after a sink failure', async () => {
    const traces: TraceEvent[] = [];
    const telemetryError = new TypeError('state telemetry offline');
    let failNextStateTelemetry = false;
    const ports: PlaybookPorts = {
      callPlayer: async () => ({
        status: 'error',
        error: 'stop after entering the state',
      }),
      callJudge: async () =>
        JSON.stringify({ event: 'START_DISCUSSION', topic: 'Queue recovery.' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        } else if (
          event.topic === 'playbook.fsm.state' &&
          failNextStateTelemetry
        ) {
          failNextStateTelemetry = false;
          throw telemetryError;
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'emission-recovery-session'));
    failNextStateTelemetry = true;

    await expect(
      runtime.handleBossInput({ text: 'start', signal: signal() }),
    ).rejects.toBe(telemetryError);

    expect(
      traces.find(
        (trace) =>
          trace.type === 'boss.input.settled' && trace.turnId === 1,
      ),
    ).toMatchObject({
      payload: {
        outcome: 'failed',
        error: {
          name: 'TypeError',
          message: 'state telemetry offline',
        },
      },
    });
    await runtime.handleBossInput({ text: '  ', signal: signal() });
    expect(
      traces.find(
        (trace) =>
          trace.type === 'boss.input.settled' && trace.turnId === 2,
      ),
    ).toMatchObject({ payload: { outcome: 'no-action' } });
    await runtime.dispose();
  });

  it('omits unavailable failed-state status data from its JSON-safe trace', async () => {
    const traces: TraceEvent[] = [];
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'ok' }),
      callJudge: async () =>
        JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'failed' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'json-safe-failed-session'));
    await runtime.handleBossInput({ text: 'fail directly', signal: signal() });

    const failedStatus = traces.find(
      (trace) =>
        trace.type === 'status.emitted' &&
        trace.payload.stateId === 'failed',
    );
    expect(failedStatus?.payload).toEqual({
      stateId: 'failed',
      message:
        'The discussion workflow failed and is waiting for Boss recovery.',
    });
    expect(JSON.parse(JSON.stringify(failedStatus))).toEqual(failedStatus);
    await runtime.dispose();
  });

  it('retains returned error tokens and preserves the prior token on rejection', async () => {
    const traces: TraceEvent[] = [];
    const resumes: Array<string | false> = [];
    const judgeReplies = [
      JSON.stringify({ event: 'START_DISCUSSION', topic: 'Resume safely.' }),
      JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'askHostInitial' }),
      JSON.stringify({ guard: 'needsBossReply', question: 'Proceed?' }),
      JSON.stringify({ event: 'BOSS_REPLY', answer: 'Yes.' }),
      JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'askHostInitial' }),
    ];
    let judgeIndex = 0;
    let playerIndex = 0;
    const ports: PlaybookPorts = {
      callPlayer: async (_playerId, _prompt, _signal, options) => {
        resumes.push(options.resume);
        playerIndex++;
        if (playerIndex === 1) {
          return {
            status: 'error',
            resumeToken: 'error-token',
            error: 'player stopped',
          };
        }
        if (playerIndex === 2) {
          return {
            status: 'ok',
            resumeToken: 'stable-token',
            finalText: 'I need Boss.',
          };
        }
        if (playerIndex === 3) {
          throw new TypeError('transport broke');
        }
        return {
          status: 'error',
          resumeToken: 'next-error-token',
          error: 'stop after assertion',
        };
      },
      callJudge: async () => {
        const reply = judgeReplies[judgeIndex++];
        if (reply === undefined) {
          throw new Error(`unscripted judge call #${judgeIndex}`);
        }
        return reply;
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'failure-resume-session'));
    await runtime.handleBossInput({ text: 'start', signal: signal() });
    await runtime.handleBossInput({ text: 'retry', signal: signal() });
    await runtime.handleBossInput({ text: 'Yes.', signal: signal() });
    await runtime.handleBossInput({ text: 'retry again', signal: signal() });

    expect(resumes).toEqual([
      false,
      'error-token',
      'stable-token',
      'stable-token',
    ]);
    const rejected = traces.find(
      (trace) =>
        trace.type === 'player.call.finished' &&
        trace.payload.error !== undefined &&
        (trace.payload.error as { message?: string }).message ===
          'transport broke',
    );
    expect(rejected).toMatchObject({
      callId: 'player-3',
      payload: {
        status: 'error',
        resume: 'stable-token',
        error: { name: 'TypeError', message: 'transport broke' },
      },
    });
    const failedSettlements = traces.filter(
      (trace) =>
        trace.type === 'boss.input.settled' &&
        trace.payload.outcome === 'failed',
    );
    expect(failedSettlements.length).toBeGreaterThanOrEqual(3);
    await runtime.dispose();
  });

  it('retains an aborted token and clears continuity when a result omits one', async () => {
    const resumes: Array<string | false> = [];
    const judgeReplies = [
      JSON.stringify({ event: 'START_DISCUSSION', topic: 'Resume safely.' }),
      JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'askHostInitial' }),
      JSON.stringify({ guard: 'needsBossReply', question: 'Proceed?' }),
      JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'askHostInitial' }),
    ];
    let judgeIndex = 0;
    let playerIndex = 0;
    const ports: PlaybookPorts = {
      callPlayer: async (_playerId, _prompt, _signal, options) => {
        resumes.push(options.resume);
        playerIndex++;
        if (playerIndex === 1) {
          return {
            status: 'aborted',
            resumeToken: 'aborted-token',
            error: 'interrupted',
          };
        }
        if (playerIndex === 2) {
          return { status: 'ok', finalText: 'I need Boss.' };
        }
        return { status: 'error', error: 'stop after assertion' };
      },
      callJudge: async () => {
        const reply = judgeReplies[judgeIndex++];
        if (reply === undefined) {
          throw new Error(`unscripted judge call #${judgeIndex}`);
        }
        return reply;
      },
      emitStatus: async () => {},
      emitTelemetry: async () => {},
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'aborted-and-omitted-session'));

    await runtime.handleBossInput({ text: 'start', signal: signal() });
    await runtime.handleBossInput({ text: 'retry', signal: signal() });
    await runtime.handleBossInput({ text: 'retry fresh', signal: signal() });

    expect(resumes).toEqual([false, 'aborted-token', false]);
    await runtime.dispose();
  });

  it('starts distinct runtime sessions fresh and rejects a second init', async () => {
    const observed: Array<{
      sessionId: string;
      resume: string | false;
    }> = [];

    for (const sessionId of ['fresh-session-1', 'fresh-session-2']) {
      const traces: TraceEvent[] = [];
      const ports: PlaybookPorts = {
        callPlayer: async (_playerId, _prompt, _signal, options) => {
          observed.push({ sessionId, resume: options.resume });
          return {
            status: 'error',
            resumeToken: `${sessionId}-token`,
            error: 'stop',
          };
        },
        callJudge: async () =>
          JSON.stringify({ event: 'START_DISCUSSION', topic: sessionId }),
        emitStatus: async () => {},
        emitTelemetry: async (event) => {
          if (event.topic === 'playbook.trace') {
            traces.push(event.payload as TraceEvent);
          }
        },
      };
      const runtime = createPlaybookRuntime({});
      const session = playbookSession(ports, sessionId);
      await runtime.init(session);
      await expect(runtime.init(session)).rejects.toThrow(/only be called once/);
      await runtime.handleBossInput({ text: sessionId, signal: signal() });
      await runtime.dispose();
      expect(new Set(traces.map((trace) => trace.sessionId))).toEqual(
        new Set([sessionId]),
      );
    }

    expect(observed).toEqual([
      { sessionId: 'fresh-session-1', resume: false },
      { sessionId: 'fresh-session-2', resume: false },
    ]);
  });
});
