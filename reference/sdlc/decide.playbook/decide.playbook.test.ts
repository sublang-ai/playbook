// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';

import type { PlayerSessionStore } from '../../../src/runtime.js';
import createPlaybookRuntime, {
  _internal,
  type PlayerCallOptions,
  type PlaybookCallRequest,
  type PlaybookCallResult,
  type PlaybookPorts,
  type PlaybookRunResult,
  type PlaybookRuntimeSnapshot,
  type PlaybookSession,
  type PlaybookTraceEvent,
} from './decide.playbook.ts';

const signal = (): AbortSignal => new AbortController().signal;

const distinctBindings = {
  coder: { playerId: 'dev.coder', promptIdentity: 'GPT-5.6 Sol' },
  reviewer: {
    playerId: 'dev.reviewer',
    promptIdentity: 'Claude Opus 5',
  },
} as const;

interface PlayerCallRecord {
  roleId: string;
  prompt: string;
  options: PlayerCallOptions;
}

interface TelemetryRecord {
  topic: string;
  payload: unknown;
}

function playbookTraces(records: readonly TelemetryRecord[]): PlaybookTraceEvent[] {
  return records
    .filter(({ topic }) => topic === 'playbook.trace')
    .map(({ payload }) => payload as PlaybookTraceEvent);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createPlayerSessionStore(): PlayerSessionStore & {
  readonly tokens: Map<string, string>;
} {
  const tokens = new Map<string, string>();
  return {
    tokens,
    select: (roleId) => tokens.get(roleId) ?? false,
    update: (roleId, resumeToken) => {
      if (resumeToken === undefined) tokens.delete(roleId);
      else tokens.set(roleId, resumeToken);
    },
    snapshot: () => Object.fromEntries(tokens),
    restore: (restored) => {
      tokens.clear();
      for (const [roleId, resumeToken] of Object.entries(restored)) {
        tokens.set(roleId, resumeToken);
      }
    },
  };
}

function session(
  ports: PlaybookPorts,
  playerSessions = createPlayerSessionStore(),
  roleBindings?: PlaybookSession['roleBindings'],
): PlaybookSession {
  return {
    sessionId: 'decide-test-session',
    playbookId: 'decide',
    rootSessionId: 'decide-test-session',
    depth: 0,
    playerSessions,
    ...(roleBindings === undefined ? {} : { roleBindings }),
    ports,
  };
}

function completePorts(overrides: Partial<PlaybookPorts>): PlaybookPorts {
  return {
    callPlayer: async () => {
      throw new Error('unexpected player call');
    },
    callCaptain: async () => {
      throw new Error('unexpected direct Captain call');
    },
    callJudge: async () => {
      throw new Error('unexpected judge call');
    },
    callPlaybook: async () => {
      throw new Error('unexpected nested playbook call');
    },
    emitStatus: async () => {},
    emitTelemetry: async () => {},
    ...overrides,
  };
}

function judgeReply(prompt: string): string {
  if (prompt.includes('source item DECIDE-1')) {
    return JSON.stringify({ guard: 'proposed' });
  }
  if (prompt.includes('source item DECIDE-2')) {
    return JSON.stringify({ guard: 'proposed' });
  }
  if (prompt.includes('source item DECIDE-3')) {
    return JSON.stringify({ guard: 'committed', latestCommit: 'abc123' });
  }
  throw new Error(`unexpected judge prompt: ${prompt}`);
}

interface ReviewBoundary {
  runtime: ReturnType<typeof createPlaybookRuntime>;
  request: PlaybookCallRequest;
  telemetry: TelemetryRecord[];
}

async function runToReview(
  onTelemetry?: (record: TelemetryRecord) => void | Promise<void>,
): Promise<ReviewBoundary> {
  const playerCounts = new Map<string, number>();
  const telemetry: TelemetryRecord[] = [];
  let request: PlaybookCallRequest | undefined;
  const ports = completePorts({
    callPlayer: async (roleId) => {
      const count = (playerCounts.get(roleId) ?? 0) + 1;
      playerCounts.set(roleId, count);
      return {
        status: 'ok',
        resumeToken: `${roleId}-token-${count}`,
        finalText:
          roleId === 'coder' && count === 1
            ? 'Coder proposal'
            : roleId === 'reviewer'
              ? 'Reviewer proposal'
              : 'Committed proposal\nCommit: abc123',
      };
    },
    callJudge: async (prompt) => judgeReply(prompt),
    callPlaybook: async (nestedRequest) => {
      request = nestedRequest;
      return { state: 'suspended', childSessionId: 'review-child' };
    },
    emitTelemetry: async (record) => {
      telemetry.push(record);
      await onTelemetry?.(record);
    },
  });
  const runtime = createPlaybookRuntime({});
  await runtime.init(session(ports));
  const result = await runtime.handleBossInput({
    text: 'Choose the durable design.',
    signal: signal(),
  });
  expect(result).toMatchObject({ outcome: 'suspended' });
  if (!request) throw new Error('DECIDE did not call REVIEW');
  return { runtime, request, telemetry };
}

async function startWithCommitOutput(
  commitOutput: string,
  latestCommit: string,
  callPlaybook: PlaybookPorts['callPlaybook'] = async () => ({
    state: 'suspended',
    childSessionId: 'review-child',
  }),
): Promise<{
  runtime: ReturnType<typeof createPlaybookRuntime>;
  result: Promise<PlaybookRunResult>;
  nestedRequests: PlaybookCallRequest[];
}> {
  let coderCalls = 0;
  const nestedRequests: PlaybookCallRequest[] = [];
  const ports = completePorts({
    callPlayer: async (roleId) => {
      if (roleId === 'reviewer') {
        return {
          status: 'ok',
          resumeToken: 'reviewer-token-1',
          finalText: 'Reviewer proposal',
        };
      }
      coderCalls += 1;
      return {
        status: 'ok',
        resumeToken: `coder-token-${coderCalls}`,
        finalText: coderCalls === 1 ? 'Coder proposal' : commitOutput,
      };
    },
    callJudge: async (prompt) =>
      prompt.includes('source item DECIDE-3')
        ? JSON.stringify({ guard: 'committed', latestCommit })
        : judgeReply(prompt),
    callPlaybook: async (request, boundarySignal) => {
      nestedRequests.push(request);
      return callPlaybook(request, boundarySignal);
    },
  });
  const runtime = createPlaybookRuntime({});
  await runtime.init(session(ports));
  return {
    runtime,
    result: runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: signal(),
    }),
    nestedRequests,
  };
}

describe('DECIDE parallel proposals and nested REVIEW handoff', () => {
  it('keeps proposals blind, resumes mapped roles, and suspends on exact REVIEW input', async () => {
    const coderProposal = 'Coder proposal with literal <caller-topic> token.';
    const reviewerProposal = 'Reviewer private alternative.';
    const callerTopic =
      'Choose <coder-llm> behavior.\nKeep mapped roles shared.';
    const proposalResults = {
      coder: deferred<{
        status: 'ok';
        resumeToken: string;
        finalText: string;
      }>(),
      reviewer: deferred<{
        status: 'ok';
        resumeToken: string;
        finalText: string;
      }>(),
    };
    const playerCalls: PlayerCallRecord[] = [];
    const playerCounts = new Map<string, number>();
    const telemetry: TelemetryRecord[] = [];
    const statuses: string[] = [];
    const nestedRequests: PlaybookCallRequest[] = [];
    const playerSessions = createPlayerSessionStore();
    let activeProposalCalls = 0;
    let maximumActiveProposalCalls = 0;

    const ports = completePorts({
      callPlayer: async (roleId, prompt, _signal, options) => {
        playerCalls.push({ roleId, prompt, options: { ...options } });
        const count = (playerCounts.get(roleId) ?? 0) + 1;
        playerCounts.set(roleId, count);
        if (count === 1) {
          activeProposalCalls += 1;
          maximumActiveProposalCalls = Math.max(
            maximumActiveProposalCalls,
            activeProposalCalls,
          );
          try {
            return await proposalResults[roleId as 'coder' | 'reviewer']
              .promise;
          } finally {
            activeProposalCalls -= 1;
          }
        }
        expect(roleId).toBe('coder');
        return {
          status: 'ok',
          resumeToken: 'coder-token-2',
          finalText: 'Committed Coder proposal.\nCommit: abc123',
        };
      },
      callJudge: async (prompt) => judgeReply(prompt),
      callPlaybook: async (request) => {
        nestedRequests.push(request);
        return { state: 'suspended', childSessionId: 'review-child' };
      },
      emitStatus: async (message) => {
        statuses.push(message);
      },
      emitTelemetry: async (record) => {
        telemetry.push(record);
      },
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports, playerSessions, distinctBindings));

    const running = runtime.handleBossInput({
      text: callerTopic,
      signal: signal(),
    });
    await vi.waitFor(() => {
      expect(playerCalls).toHaveLength(2);
    });

    expect(maximumActiveProposalCalls).toBe(2);
    expect(playerCalls.map(({ roleId }) => roleId).sort()).toEqual([
      'coder',
      'reviewer',
    ]);
    for (const call of playerCalls) {
      expect(call.prompt).toContain(
        '> Choose <coder-llm> behavior.\n> Keep mapped roles shared.',
      );
      expect(call.prompt).toContain('Propose your design.');
      expect(call.prompt).not.toContain(coderProposal);
      expect(call.prompt).not.toContain(reviewerProposal);
      expect(call.options.resume).toBe(false);
    }

    proposalResults.coder.resolve({
      status: 'ok',
      resumeToken: 'coder-token-1',
      finalText: coderProposal,
    });
    proposalResults.reviewer.resolve({
      status: 'ok',
      resumeToken: 'reviewer-token-1',
      finalText: reviewerProposal,
    });

    const result = await running;
    expect(result).toMatchObject({
      outcome: 'suspended',
      pendingCall: {
        callId: 'playbook-1',
        playbookId: 'review',
        childSessionId: 'review-child',
      },
    });
    expect(playerCalls).toHaveLength(3);
    expect(playerCalls[2]).toMatchObject({
      roleId: 'coder',
      options: { resume: 'coder-token-1' },
    });
    expect(playerCalls[2].prompt).toContain('Coder is GPT-5.6 Sol');
    expect(playerCalls[2].prompt).toContain(
      'Include exactly one final-response line beginning `Commit: `, followed only by the exact commit identity; other final-response content may appear on other lines.',
    );
    expect(playerCalls[2].prompt).not.toContain(reviewerProposal);
    expect(nestedRequests).toEqual([
      {
        callId: 'playbook-1',
        playbookId: 'review',
        text: [
          'Review the latest commit as a spec-design change against the initial intent.',
          'Compare it with your independent proposal and take the best of both.',
          'Make your suggestions.',
          '',
          `Initial intent: ${callerTopic}.`,
          `Coder's independent proposal: ${coderProposal}.`,
        ].join('\n'),
      },
    ]);
    expect(nestedRequests[0].text).not.toContain(reviewerProposal);
    expect(nestedRequests[0].text).toContain(
      'Coder proposal with literal <caller-topic> token.',
    );
    expect(Object.fromEntries(playerSessions.tokens)).toEqual({
      coder: 'coder-token-2',
      reviewer: 'reviewer-token-1',
    });
    const playerTraces = playbookTraces(telemetry).filter(({ type }) =>
      type.startsWith('player.call.'),
    );
    expect(playerTraces).toHaveLength(6);
    for (const trace of playerTraces) {
      expect(trace.schemaVersion).toBe(3);
      const payload = trace.payload as Record<string, unknown>;
      expect(payload.roleId).toMatch(/^(coder|reviewer)$/);
      expect(payload.playerId).toBe(
        payload.roleId === 'coder' ? 'dev.coder' : 'dev.reviewer',
      );
      expect(payload).not.toHaveProperty('purpose');
    }
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      roleResumeTokens: {
        coder: 'coder-token-2',
        reviewer: 'reviewer-token-1',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('dev.coder');
    expect(JSON.stringify(snapshot)).not.toContain('dev.reviewer');
    expect(JSON.stringify(snapshot)).not.toContain('GPT-5.6 Sol');
    expect(JSON.stringify(snapshot)).not.toContain('Claude Opus 5');
    expect(statuses).toContain('START_DECIDE');
    expect(statuses).toContain(
      '⤷ Coder: Coder independently proposes a spec design.',
    );
    expect(statuses).toContain(
      '⤷ Reviewer: Reviewer independently proposes a spec design.',
    );
    expect(statuses).toContain(
      '⤷ Coder: Coder writes and commits Coder’s independent proposal.',
    );
    expect(statuses).not.toContain('REVIEW examines the committed proposal.');

    const fsmPayloads = telemetry
      .filter(({ topic }) => topic === 'playbook.fsm.state')
      .map(({ payload }) => payload as Record<string, unknown>);
    const initial = fsmPayloads[0];
    expect(initial.from).toEqual(initial.to);
    expect(initial.previousState).toEqual(initial.state);
    expect(fsmPayloads).toContainEqual(
      expect.objectContaining({
        event: {
          type: 'START_DECIDE',
          callerTopic,
        },
      }),
    );

    await runtime.dispose();
  });

  it.each([
    ['a missing marker', 'Committed proposal.', 'abc123'],
    [
      'duplicate markers',
      'Committed proposal.\nCommit: old\nCommit: abc123',
      'abc123',
    ],
    [
      'a marker that disagrees with adjudication',
      'Committed proposal.\nCommit: def456',
      'abc123',
    ],
  ])('rejects commit identity with %s', async (_label, output, latestCommit) => {
    const { runtime, result, nestedRequests } = await startWithCommitOutput(
      output,
      latestCommit,
    );
    await expect(result).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
      error: {
        message: expect.stringContaining('"guard":"committed"'),
      },
    });
    expect(nestedRequests).toEqual([]);
    await runtime.dispose();
  });

  it('restarts both proposal branches with the exact interrupted topic', async () => {
    const playerCalls: PlayerCallRecord[] = [];
    const counts = new Map<string, number>();
    const ports = completePorts({
      callPlayer: async (roleId, prompt, _signal, options) => {
        playerCalls.push({ roleId, prompt, options: { ...options } });
        const count = (counts.get(roleId) ?? 0) + 1;
        counts.set(roleId, count);
        return {
          status: 'ok',
          resumeToken: `${roleId}-token-${count}`,
          finalText:
            count === 1
              ? `Need ${roleId} input`
              : roleId === 'coder' && count === 3
                ? 'Committed replacement proposal\nCommit: replacement-commit'
                : `${roleId} replacement proposal`,
        };
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Boss-input classifier')) {
          return JSON.stringify({
            type: 'BOSS_INTERRUPT',
            targetId: 'independentProposals',
          });
        }
        if (
          prompt.includes('source item DECIDE-1') ||
          prompt.includes('source item DECIDE-2')
        ) {
          const match = prompt.match(/Need (coder|reviewer) input/);
          return match
            ? JSON.stringify({
                guard: 'needsBossReply',
                question: `${match[1]} question?`,
              })
            : JSON.stringify({ guard: 'proposed' });
        }
        return JSON.stringify({
          guard: 'committed',
          latestCommit: 'replacement-commit',
        });
      },
      callPlaybook: async () => ({
        state: 'suspended',
        childSessionId: 'review-child',
      }),
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));

    await expect(
      runtime.handleBossInput({ text: 'Old topic', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'quiescent' });
    expect(playerCalls).toHaveLength(2);

    await expect(
      runtime.handleBossInput({ text: 'New topic', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'suspended' });
    const restarted = playerCalls.slice(2, 4);
    expect(restarted.map(({ roleId }) => roleId).sort()).toEqual([
      'coder',
      'reviewer',
    ]);
    for (const call of restarted) {
      expect(call.prompt).toContain('> New topic');
      expect(call.prompt).not.toContain('> Old topic');
      expect(call.options.resume).toBe(`${call.roleId}-token-1`);
    }

    await runtime.dispose();
  });

  it('rejects aliased parallel roles before a second host call', async () => {
    const hostCalls = vi.fn(
      (_roleId: string, _prompt: string, invocationSignal: AbortSignal) =>
        new Promise<{
          status: 'aborted';
        }>((resolve) => {
          invocationSignal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        }),
    );
    const telemetry: TelemetryRecord[] = [];
    const runtime = createPlaybookRuntime({});
    await runtime.init(
      session(
        completePorts({
          callPlayer: hostCalls,
          emitTelemetry: async (record) => {
            telemetry.push(record);
          },
        }),
        createPlayerSessionStore(),
        {
          coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
          reviewer: {
            playerId: 'dev.shared',
            promptIdentity: 'Reviewer',
          },
        },
      ),
    );

    await expect(
      runtime.handleBossInput({ text: 'Compare designs.', signal: signal() }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(hostCalls).toHaveBeenCalledTimes(1);
    const collision = playbookTraces(telemetry).find(
      ({ type, payload }) =>
        type === 'player.call.finished' &&
        (payload as Record<string, unknown>).status === 'error',
    );
    expect(collision?.payload).toMatchObject({
      playerId: 'dev.shared',
      error: {
        message: expect.stringContaining('already has an in-flight call'),
      },
    });

    await runtime.dispose();
  });

  it('snapshots parallel questions with local-role askers', async () => {
    const runtime = createPlaybookRuntime({});
    const statuses: string[] = [];
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId) => ({
            status: 'ok',
            resumeToken: `${roleId}-thread`,
            finalText: `Need ${roleId} clarification`,
          }),
          callJudge: async (prompt) => {
            const roleId = prompt.includes('Need coder clarification')
              ? 'coder'
              : 'reviewer';
            return JSON.stringify({
              guard: 'needsBossReply',
              question: `${roleId} question?`,
            });
          },
          emitStatus: async (message) => {
            statuses.push(message);
          },
        }),
      ),
    );

    await expect(
      runtime.handleBossInput({ text: 'Compare designs.', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'quiescent' });
    expect(runtime.exportSnapshot?.()).toMatchObject({
      schemaVersion: 3,
      roleResumeTokens: {
        coder: 'coder-thread',
        reviewer: 'reviewer-thread',
      },
      pendingBossQuestions: [
        {
          questionId: 'askCoderProposal',
          asker: { kind: 'role', roleId: 'coder' },
          question: 'coder question?',
          sourceItem: 'DECIDE-1',
        },
        {
          questionId: 'askReviewerProposal',
          asker: { kind: 'role', roleId: 'reviewer' },
          question: 'reviewer question?',
          sourceItem: 'DECIDE-2',
        },
      ],
    });
    expect(statuses).toEqual(
      expect.arrayContaining([
        'coder asks: coder question?',
        '◆ awaiting Boss reply · askCoderProposal · coder · DECIDE-1',
        'reviewer asks: reviewer question?',
        '◆ awaiting Boss reply · askReviewerProposal · reviewer · DECIDE-2',
      ]),
    );

    await runtime.dispose();
  });

  // PBRT-45: a question pends only while its authored reply-wait state is
  // active — the map spans all three of DECIDE's reply paths, and the
  // context's retained entries never leak past their waits.
  it('counts a question as pending only in its own active authored wait', () => {
    const question = (resumeStateId: string, roleId: string) => ({
      questionId: resumeStateId,
      resumeStateId,
      sourceItem: 'DECIDE-1',
      asker: { kind: 'role', roleId },
      question: `${resumeStateId}?`,
    });
    const context = {
      pendingBossQuestions: {
        askCoderProposal: question('askCoderProposal', 'coder'),
        askReviewerProposal: question('askReviewerProposal', 'reviewer'),
        commitCoderProposal: question('commitCoderProposal', 'coder'),
      },
    };
    const state = (...activeStateIds: string[]) =>
      ({
        value: 'proposals',
        activeStateIds,
        tags: [],
        status: 'active',
        quiescent: true,
      }) as never;
    const pendingIds = (...activeStateIds: string[]) =>
      _internal
        .pendingQuestionsForState(state(...activeStateIds), context)
        .map(({ questionId }: { questionId: string }) => questionId);

    expect(pendingIds('waitCoderProposalReply')).toEqual(['askCoderProposal']);
    expect(pendingIds('waitReviewerProposalReply')).toEqual([
      'askReviewerProposal',
    ]);
    expect(pendingIds('awaitBossReply')).toEqual(['commitCoderProposal']);
    expect(
      pendingIds('waitCoderProposalReply', 'waitReviewerProposalReply'),
    ).toEqual(['askCoderProposal', 'askReviewerProposal']);
    // A resumed player state and the failure state pend nothing, however
    // long the context retains the answered entries.
    expect(pendingIds('askCoderProposal')).toEqual([]);
    expect(pendingIds('failed')).toEqual([]);
  });

  it('drops an answered branch question from telemetry while its sibling still waits', async () => {
    const telemetry: TelemetryRecord[] = [];
    let coderCalls = 0;
    const runtime = createPlaybookRuntime({});
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId) => {
            if (roleId === 'coder') coderCalls += 1;
            return {
              status: 'ok',
              resumeToken: `${roleId}-thread`,
              finalText: `Need ${roleId} clarification`,
            };
          },
          callJudge: async (prompt) => {
            if (prompt.includes('Classify the Boss message')) {
              return JSON.stringify({
                type: 'BOSS_REPLY',
                questionId: 'askCoderProposal',
              });
            }
            const roleId = prompt.includes('Need coder clarification')
              ? 'coder'
              : 'reviewer';
            return JSON.stringify({
              guard: 'needsBossReply',
              question: `${roleId} question ${coderCalls}?`,
            });
          },
          emitTelemetry: async (record) => {
            telemetry.push(record);
          },
        }),
      ),
    );

    await runtime.handleBossInput({ text: 'Compare designs.', signal: signal() });
    const parkedPayloads = telemetry.filter(
      ({ topic }) => topic === 'playbook.fsm.state',
    ).length;

    // Boss answers the coder's question; the reviewer's stays open. Every
    // transition of the resumed turn — the branch re-entering its player
    // state included — reports only the question still awaiting its reply,
    // never the answered one riding the context for the resumed prompt.
    await runtime.handleBossInput({
      text: 'Use approach A.',
      signal: signal(),
    });
    const resumedPayloads = telemetry
      .filter(({ topic }) => topic === 'playbook.fsm.state')
      .slice(parkedPayloads)
      .map(({ payload }) => payload as Record<string, unknown>);
    expect(resumedPayloads.length).toBeGreaterThan(1);
    const resumeTransition = resumedPayloads[0] as {
      pendingBossQuestions?: Array<{ questionId: string }>;
    };
    expect(
      resumeTransition.pendingBossQuestions?.map(
        ({ questionId }) => questionId,
      ),
    ).toEqual(['askReviewerProposal']);

    // The resumed coder asked again, so the turn parks with two genuinely
    // pending questions — the snapshot and the final transition agree.
    const parkedAgain = resumedPayloads.at(-1) as {
      pendingBossQuestions?: Array<{ questionId: string }>;
    };
    expect(
      parkedAgain.pendingBossQuestions?.map(({ questionId }) => questionId),
    ).toEqual(expect.arrayContaining(['askCoderProposal', 'askReviewerProposal']));
    expect(coderCalls).toBe(2);
    expect(
      runtime.exportSnapshot?.()?.pendingBossQuestions?.map(
        ({ questionId }) => questionId,
      ),
    ).toEqual(['askCoderProposal', 'askReviewerProposal']);

    await runtime.dispose();
  });
});

describe('DECIDE suspended REVIEW persistence', () => {
  it('restores one suspended REVIEW without replay and resumes its original trace once', async () => {
    const {
      runtime: source,
      request,
      telemetry: sourceTelemetry,
    } = await runToReview();
    const snapshot = source.exportSnapshot?.();
    if (
      snapshot?.schemaVersion !== 3 ||
      snapshot.suspendedCall === undefined
    ) {
      throw new Error('DECIDE did not export its suspended REVIEW call');
    }
    expect(snapshot.suspendedCall).toEqual({
      ...request,
      stateId: 'reviewCommit',
      childSessionId: 'review-child',
      turnId: 1,
    });
    expect(snapshot.state).toMatchObject({
      stateId: 'reviewCommit',
      status: 'active',
      quiescent: true,
      tags: expect.arrayContaining(['playbook.suspended']),
    });

    const roundTripped = JSON.parse(
      JSON.stringify(snapshot),
    ) as PlaybookRuntimeSnapshot;
    const nestedRequests: PlaybookCallRequest[] = [];
    const restoredStatuses: string[] = [];
    const restoredTelemetry: TelemetryRecord[] = [];
    const restored = createPlaybookRuntime({});
    const restoredPorts = completePorts({
      callPlaybook: async (nestedRequest) => {
        nestedRequests.push(nestedRequest);
        throw new Error('restore must not restart REVIEW');
      },
      emitStatus: async (message) => {
        restoredStatuses.push(message);
      },
      emitTelemetry: async (record) => {
        restoredTelemetry.push(record);
      },
    });
    if (!restored.restore) throw new Error('DECIDE restore is unavailable');
    await restored.restore(session(restoredPorts), roundTripped);

    expect(nestedRequests).toEqual([]);
    expect(restoredStatuses).toEqual([]);
    expect(restoredTelemetry).toEqual([]);
    const restoredSnapshot = restored.exportSnapshot?.();
    expect(restoredSnapshot?.schemaVersion).toBe(3);
    expect(restoredSnapshot?.suspendedCall).toEqual(snapshot.suspendedCall);
    expect(restoredSnapshot?.state).toEqual(snapshot.state);

    const childResult = {
      status: 'ok',
      playbookId: 'review',
      childSessionId: 'review-child',
      output: {
        approvedCommit: 'latest',
        noUnsettledFindings: true,
      },
    } satisfies PlaybookCallResult;
    await expect(
      restored.resumePlaybookCall({
        callId: request.callId,
        result: childResult,
        signal: signal(),
      }),
    ).resolves.toMatchObject({ outcome: 'terminal' });

    const sourceStarts = playbookTraces(sourceTelemetry).filter(
      ({ type }) => type === 'playbook.call.started',
    );
    const restoredTraces = playbookTraces(restoredTelemetry);
    const restoredStarts = restoredTraces.filter(
      ({ type }) => type === 'playbook.call.started',
    );
    const restoredFinishes = restoredTraces.filter(
      ({ type }) => type === 'playbook.call.finished',
    );
    expect(sourceStarts).toHaveLength(1);
    expect(restoredStarts).toHaveLength(0);
    expect(restoredFinishes).toHaveLength(1);
    expect(sourceStarts[0]).toMatchObject({
      callId: request.callId,
      turnId: 1,
      payload: {
        stateId: 'reviewCommit',
        playbookId: 'review',
        text: request.text,
      },
    });
    expect(restoredFinishes[0]).toMatchObject({
      callId: request.callId,
      turnId: 1,
      payload: {
        stateId: 'reviewCommit',
        playbookId: 'review',
        text: request.text,
        result: childResult,
      },
    });
    expect(restoredFinishes[0].sequence).toBeGreaterThan(
      sourceStarts[0].sequence,
    );
    expect(
      restoredTraces.some(
        ({ type, sequence }) =>
          type === 'fsm.transition' &&
          sequence > restoredFinishes[0].sequence,
      ),
    ).toBe(true);

    await expect(
      restored.resumePlaybookCall({
        callId: request.callId,
        result: childResult,
        signal: signal(),
      }),
    ).rejects.toThrow(`unknown or stale playbook call id ${request.callId}`);
    await restored.dispose();
    await source.dispose();
  });

  it.each([
    [
      'descriptor disagrees with the restored invoke input',
      (snapshot: PlaybookRuntimeSnapshot): PlaybookRuntimeSnapshot => {
        if (
          snapshot.schemaVersion !== 3 ||
          snapshot.suspendedCall === undefined
        ) {
          throw new Error('expected a suspended schema-3 snapshot');
        }
        return {
          ...snapshot,
          suspendedCall: {
            ...snapshot.suspendedCall,
            text: `${snapshot.suspendedCall.text} (forged)`,
          },
        };
      },
      /text does not match its persisted input/,
    ],
    [
      'public state disagrees with the restored actor',
      (snapshot: PlaybookRuntimeSnapshot): PlaybookRuntimeSnapshot => ({
        ...snapshot,
        state: { ...snapshot.state, value: 'forgedReviewCommit' },
      }),
      /restored actor state does not match snapshot state/,
    ],
  ] as const)(
    'rolls back a failed restore when the %s',
    async (_label, mutate, expectedError) => {
      const { runtime: source } = await runToReview();
      const snapshot = source.exportSnapshot?.();
      if (!snapshot) throw new Error('DECIDE did not export a snapshot');
      const invalidSnapshot = mutate(
        JSON.parse(JSON.stringify(snapshot)) as PlaybookRuntimeSnapshot,
      );
      const nestedRequests: PlaybookCallRequest[] = [];
      const statuses: string[] = [];
      const telemetry: TelemetryRecord[] = [];
      const playerSessions = createPlayerSessionStore();
      playerSessions.update('coder', 'keep-me');
      const restored = createPlaybookRuntime({});
      const restoredPorts = completePorts({
        callPlaybook: async (request) => {
          nestedRequests.push(request);
          throw new Error('failed restore must not restart REVIEW');
        },
        emitStatus: async (message) => {
          statuses.push(message);
        },
        emitTelemetry: async (record) => {
          telemetry.push(record);
        },
      });
      if (!restored.restore) throw new Error('DECIDE restore is unavailable');

      await expect(
        restored.restore(
          session(restoredPorts, playerSessions),
          invalidSnapshot,
        ),
      ).rejects.toThrow(expectedError);
      expect(nestedRequests).toEqual([]);
      expect(statuses).toEqual([]);
      expect(telemetry).toEqual([]);
      expect(Object.fromEntries(playerSessions.tokens)).toEqual({
        coder: 'keep-me',
      });

      await restored.dispose();
      await source.dispose();
    },
  );

  it.each([1, 2])(
    'rejects legacy schema-%i snapshots without invoking a child',
    async (schemaVersion) => {
      const source = createPlaybookRuntime({});
      await source.init(session(completePorts({})));
      const snapshot = source.exportSnapshot?.();
      if (!snapshot) throw new Error('DECIDE did not export a snapshot');
      const legacySnapshot = {
        ...snapshot,
        schemaVersion,
      } as unknown as PlaybookRuntimeSnapshot;
      const nestedRequests: PlaybookCallRequest[] = [];
      const statuses: string[] = [];
      const telemetry: TelemetryRecord[] = [];
      const restored = createPlaybookRuntime({});
      const restoredPorts = completePorts({
        callPlaybook: async (request) => {
          nestedRequests.push(request);
          throw new Error('legacy restore must not call a child');
        },
        emitStatus: async (message) => {
          statuses.push(message);
        },
        emitTelemetry: async (record) => {
          telemetry.push(record);
        },
      });
      if (!restored.restore) throw new Error('DECIDE restore is unavailable');
      await expect(
        restored.restore(session(restoredPorts), legacySnapshot),
      ).rejects.toThrow(`schemaVersion ${schemaVersion} is not supported`);

      expect(nestedRequests).toEqual([]);
      expect(statuses).toEqual([]);
      expect(telemetry).toEqual([]);
      expect(restored.exportSnapshot?.()).toBeUndefined();

      await restored.dispose();
      await source.dispose();
    },
  );
});

describe('DECIDE local-role continuation', () => {
  it.each(['aborted', 'error'] as const)(
    'preserves a prior token when a resolved %s result omits one',
    async (status) => {
      const playerSessions = createPlayerSessionStore();
      playerSessions.update('coder', 'coder-prior');
      const runtime = createPlaybookRuntime({});
      await runtime.init(
        session(
          completePorts({
            callPlayer: async (roleId) =>
              roleId === 'coder'
                ? {
                    status,
                    ...(status === 'error' ? { error: 'failed' } : {}),
                  }
                : {
                    status: 'ok',
                    finalText: 'Reviewer proposal',
                  },
            callJudge: async (prompt) => judgeReply(prompt),
          }),
          playerSessions,
        ),
      );

      await expect(
        runtime.handleBossInput({ text: 'Compare designs.', signal: signal() }),
      ).resolves.toMatchObject({ outcome: 'failed' });
      expect(playerSessions.tokens.get('coder')).toBe('coder-prior');

      await runtime.dispose();
    },
  );

  it('clears a prior token only for a validated ok result that omits one', async () => {
    const playerSessions = createPlayerSessionStore();
    playerSessions.update('coder', 'coder-prior');
    const runtime = createPlaybookRuntime({});
    await runtime.init(
      session(
        completePorts({
          callPlayer: async (roleId) =>
            roleId === 'coder'
              ? { status: 'ok', finalText: 'Coder proposal' }
              : {
                  status: 'ok',
                  resumeToken: 'reviewer-next',
                  finalText: 'Need reviewer clarification',
                },
          callJudge: async (prompt) =>
            prompt.includes('source item DECIDE-1')
              ? JSON.stringify({ guard: 'proposed' })
              : JSON.stringify({
                  guard: 'needsBossReply',
                  question: 'Reviewer question?',
                }),
        }),
        playerSessions,
      ),
    );

    await expect(
      runtime.handleBossInput({ text: 'Compare designs.', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'quiescent' });
    expect(Object.fromEntries(playerSessions.tokens)).toEqual({
      reviewer: 'reviewer-next',
    });

    await runtime.dispose();
  });
});

describe('DECIDE terminal settlement from REVIEW', () => {
  it('accepts only REVIEW\'s exact approved-latest/no-findings output', async () => {
    const { runtime, request } = await runToReview();
    await expect(
      runtime.resumePlaybookCall({
        callId: request.callId,
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'review-child',
          output: {
            approvedCommit: 'latest',
            noUnsettledFindings: true,
          },
        },
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      outcome: 'terminal',
      output: {
        approvedCommit: 'latest',
        noUnsettledFindings: true,
      },
    });
    await runtime.dispose();
  });

  it.each([
    [
      'abort',
      {
        status: 'aborted',
        playbookId: 'review',
        childSessionId: 'review-child',
      } satisfies PlaybookCallResult,
      'aborted',
    ],
    [
      'failure',
      {
        status: 'error',
        playbookId: 'review',
        childSessionId: 'review-child',
        error: { name: 'ReviewError', message: 'Review could not finish.' },
      } satisfies PlaybookCallResult,
      'error',
    ],
  ] as const)(
    'reports an authored REVIEW %s with the last DECIDE commit',
    async (_label, childResult, reviewStatus) => {
      const { runtime, request } = await runToReview();
      await expect(
        runtime.resumePlaybookCall({
          callId: request.callId,
          result: childResult,
          signal: signal(),
        }),
      ).resolves.toMatchObject({
        outcome: 'terminal',
        output: {
          lastDecideCommit: 'abc123',
          noUnsettledFindings: false,
          reviewStatus,
        },
      });
      await runtime.dispose();
    },
  );

  it('reports malformed REVIEW success as a terminal protocol failure', async () => {
    const { runtime, request } = await runToReview();
    const result = await runtime.resumePlaybookCall({
      callId: request.callId,
      result: {
        status: 'ok',
        playbookId: 'review',
        childSessionId: 'review-child',
        output: {
          approvedCommit: 'abc123',
          noUnsettledFindings: true,
        },
      },
      signal: signal(),
    });
    expect(result).toMatchObject({
      outcome: 'terminal',
      output: {
        lastDecideCommit: 'abc123',
        noUnsettledFindings: false,
        reviewStatus: 'error',
        error: { name: 'ReviewProtocolError' },
      },
    } satisfies Partial<PlaybookRunResult>);
    await runtime.dispose();
  });

  it('parks when the nested REVIEW call rejects outside its result contract', async () => {
    const transportError = new Error('REVIEW transport failed.');
    const { runtime, result, nestedRequests } = await startWithCommitOutput(
      'Committed proposal.\nCommit: abc123',
      'abc123',
      async () => {
        throw transportError;
      },
    );
    await expect(result).rejects.toBe(transportError);
    expect(nestedRequests).toHaveLength(1);
    expect(runtime.exportSnapshot?.()).toMatchObject({
      state: { stateId: 'failed', status: 'active', quiescent: true },
    });
    await runtime.dispose();
  });
});

describe('DECIDE abort classification', () => {
  // slc/link.md §Abort: cancellation is causal identity (Object.is) with the
  // applicable signal reason, never bare `signal.aborted`. A distinct player
  // failure observed while the turn signal is aborted remains a non-abort
  // control error that takes precedence over the coincident abort.
  it('reports a distinct post-abort player rejection as an error, not an abort', async () => {
    const abortReason = new Error('Boss cancelled the turn.');
    const distinctFailure = new Error('player transport failed after abort');
    const telemetry: TelemetryRecord[] = [];
    const playerCalls: string[] = [];
    let rejectCoder!: (error: unknown) => void;
    const ports = completePorts({
      callPlayer: (roleId, _prompt, invocationSignal) => {
        playerCalls.push(roleId);
        if (roleId === 'coder') {
          return new Promise<never>((_resolve, reject) => {
            rejectCoder = reject;
          });
        }
        return new Promise<{ status: 'aborted' }>((resolve) => {
          invocationSignal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        });
      },
      emitTelemetry: async (record) => {
        telemetry.push(record);
      },
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));
    const controller = new AbortController();
    const running = runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(playerCalls).toHaveLength(2);
    });

    controller.abort(abortReason);
    rejectCoder(distinctFailure);

    await expect(running).rejects.toBe(distinctFailure);
    const finishes = playbookTraces(telemetry).filter(
      ({ type }) => type === 'player.call.finished',
    );
    const coderFinish = finishes.find(
      ({ payload }) => (payload as Record<string, unknown>).roleId === 'coder',
    );
    expect(coderFinish?.payload).toMatchObject({
      status: 'error',
      error: { message: distinctFailure.message },
    });
    // The sibling that rejected with the exact reason stays an abort.
    const reviewerFinish = finishes.find(
      ({ payload }) =>
        (payload as Record<string, unknown>).roleId === 'reviewer',
    );
    expect(reviewerFinish?.payload).toMatchObject({ status: 'aborted' });

    await runtime.dispose();
  });

  // slc/link.md §Abort: a rejection that IS the exact signal reason settles
  // as an ordinary abort — a cancellation-aware trace sink rejecting with
  // the abort reason itself must not recast the aborted turn as a failure
  // or reject the public boundary with that reason.
  it('settles aborted when a trace sink rejects with exactly the abort reason', async () => {
    const abortReason = new Error('Boss cancelled the turn.');
    const controller = new AbortController();
    let sinkRejects = false;
    const playerCalls: string[] = [];
    const ports = completePorts({
      callPlayer: (roleId, _prompt, invocationSignal) => {
        playerCalls.push(roleId);
        return new Promise<{ status: 'aborted' }>((resolve) => {
          invocationSignal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        });
      },
      emitTelemetry: async () => {
        if (sinkRejects) throw abortReason;
      },
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));
    const running = runtime.handleBossInput({
      text: 'Choose the durable design.',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(playerCalls).toHaveLength(2);
    });

    controller.abort(abortReason);
    sinkRejects = true;

    await expect(running).resolves.toMatchObject({
      outcome: 'aborted',
      error: { message: abortReason.message },
    });

    sinkRejects = false;
    await runtime.dispose();
  });

  // DR-036 §4: a started-trace sink rejection causally identical to the
  // boundary reason is the abort's own evidence — the turn settles aborted
  // and the pair's best-effort finish records status 'aborted', never a
  // lying 'error'.
  it('finishes the started pair aborted when its sink aborts with the rethrown reason', async () => {
    const abortReason = new Error('Boss cancelled the turn.');
    const controller = new AbortController();
    const telemetry: TelemetryRecord[] = [];
    let abortedStartCallId: string | undefined;
    const ports = completePorts({
      callPlayer: (_roleId, _prompt, invocationSignal) =>
        new Promise<{ status: 'aborted' }>((resolve) => {
          invocationSignal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        }),
      emitTelemetry: async (record) => {
        telemetry.push(record);
        if (record.topic !== 'playbook.trace') return;
        const trace = record.payload as PlaybookTraceEvent;
        if (
          trace.type === 'player.call.started' &&
          abortedStartCallId === undefined
        ) {
          abortedStartCallId = trace.callId;
          controller.abort(abortReason);
          throw abortReason;
        }
      },
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));
    await expect(
      runtime.handleBossInput({
        text: 'Choose the durable design.',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'aborted',
      error: { message: abortReason.message },
    });
    expect(abortedStartCallId).toBeDefined();
    const pairFinish = playbookTraces(telemetry).find(
      (trace) =>
        trace.type === 'player.call.finished' &&
        trace.callId === abortedStartCallId,
    );
    expect(pairFinish?.payload).toMatchObject({
      status: 'aborted',
      error: { message: abortReason.message },
    });
    await runtime.dispose();
  });

  // DR-036 §3: terminal completion outranks a coincident abort. A sink that
  // aborts the resume with its own rethrown reason while handling the final
  // done transition must neither hide the completed machine behind an
  // aborted settlement nor reject the boundary with the abort's evidence.
  it('settles terminal when the done-transition sink aborts with the rethrown reason', async () => {
    const abortReason = new Error('Boss cancelled during settlement.');
    const controller = new AbortController();
    let doneSinkTriggered = false;
    const { runtime, request } = await runToReview((record) => {
      if (doneSinkTriggered || record.topic !== 'playbook.trace') return;
      const trace = record.payload as PlaybookTraceEvent;
      const payload = trace.payload as { state?: { status?: string } };
      if (
        trace.type === 'fsm.transition' &&
        payload.state?.status === 'done'
      ) {
        doneSinkTriggered = true;
        controller.abort(abortReason);
        throw abortReason;
      }
    });
    await expect(
      runtime.resumePlaybookCall({
        callId: request.callId,
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'review-child',
          output: {
            approvedCommit: 'latest',
            noUnsettledFindings: true,
          },
        },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'terminal',
      output: {
        approvedCommit: 'latest',
        noUnsettledFindings: true,
      },
    });
    expect(doneSinkTriggered).toBe(true);
    await runtime.dispose();
  });
});
