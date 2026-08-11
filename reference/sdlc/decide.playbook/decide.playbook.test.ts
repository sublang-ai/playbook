// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';

import type { PlayerSessionStore } from '../../../src/runtime.js';
import createPlaybookRuntime, {
  type PlayerCallOptions,
  type PlaybookCallRequest,
  type PlaybookCallResult,
  type PlaybookPorts,
  type PlaybookRunResult,
  type PlaybookSession,
} from './decide.playbook.ts';

const signal = (): AbortSignal => new AbortController().signal;

interface PlayerCallRecord {
  playerId: string;
  prompt: string;
  options: PlayerCallOptions;
}

interface TelemetryRecord {
  topic: string;
  payload: unknown;
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
    select: (playerId) => tokens.get(playerId) ?? false,
    update: (playerId, resumeToken) => {
      if (resumeToken === undefined) tokens.delete(playerId);
      else tokens.set(playerId, resumeToken);
    },
    snapshot: () => Object.fromEntries(tokens),
    restore: (restored) => {
      tokens.clear();
      for (const [playerId, resumeToken] of Object.entries(restored)) {
        tokens.set(playerId, resumeToken);
      }
    },
  };
}

function session(
  ports: PlaybookPorts,
  playerSessions = createPlayerSessionStore(),
): PlaybookSession {
  return {
    sessionId: 'decide-test-session',
    playbookId: 'decide',
    rootSessionId: 'decide-test-session',
    depth: 0,
    playerSessions,
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
}

async function runToReview(): Promise<ReviewBoundary> {
  const playerCounts = new Map<string, number>();
  let request: PlaybookCallRequest | undefined;
  const ports = completePorts({
    callPlayer: async (playerId) => {
      const count = (playerCounts.get(playerId) ?? 0) + 1;
      playerCounts.set(playerId, count);
      return {
        status: 'ok',
        resumeToken: `${playerId}-token-${count}`,
        finalText:
          playerId === 'coder' && count === 1
            ? 'Coder proposal'
            : playerId === 'reviewer'
              ? 'Reviewer proposal'
              : 'Committed proposal\nCommit: abc123',
      };
    },
    callJudge: async (prompt) => judgeReply(prompt),
    callPlaybook: async (nestedRequest) => {
      request = nestedRequest;
      return { state: 'suspended', childSessionId: 'review-child' };
    },
  });
  const runtime = createPlaybookRuntime({ coderLlm: 'GPT-5.6 Sol' });
  await runtime.init(session(ports));
  const result = await runtime.handleBossInput({
    text: 'Choose the durable design.',
    signal: signal(),
  });
  expect(result).toMatchObject({ outcome: 'suspended' });
  if (!request) throw new Error('DECIDE did not call REVIEW');
  return { runtime, request };
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
    callPlayer: async (playerId) => {
      if (playerId === 'reviewer') {
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
  const runtime = createPlaybookRuntime({ coderLlm: 'GPT-5.6 Sol' });
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
      callPlayer: async (playerId, prompt, _signal, options) => {
        playerCalls.push({ playerId, prompt, options: { ...options } });
        const count = (playerCounts.get(playerId) ?? 0) + 1;
        playerCounts.set(playerId, count);
        if (count === 1) {
          activeProposalCalls += 1;
          maximumActiveProposalCalls = Math.max(
            maximumActiveProposalCalls,
            activeProposalCalls,
          );
          try {
            return await proposalResults[playerId as 'coder' | 'reviewer']
              .promise;
          } finally {
            activeProposalCalls -= 1;
          }
        }
        expect(playerId).toBe('coder');
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
    const runtime = createPlaybookRuntime({ coderLlm: 'GPT-5.6 Sol' });
    await runtime.init(session(ports, playerSessions));

    const running = runtime.handleBossInput({
      text: callerTopic,
      signal: signal(),
    });
    await vi.waitFor(() => {
      expect(playerCalls).toHaveLength(2);
    });

    expect(maximumActiveProposalCalls).toBe(2);
    expect(playerCalls.map(({ playerId }) => playerId).sort()).toEqual([
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
      playerId: 'coder',
      options: { resume: 'coder-token-1' },
    });
    expect(playerCalls[2].prompt).toContain('Coder is GPT-5.6 Sol');
    expect(playerCalls[2].prompt).toContain(
      'exactly one final-response line beginning `Commit: `',
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
      callPlayer: async (playerId, prompt, _signal, options) => {
        playerCalls.push({ playerId, prompt, options: { ...options } });
        const count = (counts.get(playerId) ?? 0) + 1;
        counts.set(playerId, count);
        return {
          status: 'ok',
          resumeToken: `${playerId}-token-${count}`,
          finalText:
            count === 1
              ? `Need ${playerId} input`
              : playerId === 'coder' && count === 3
                ? 'Committed replacement proposal\nCommit: replacement-commit'
                : `${playerId} replacement proposal`,
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
    const runtime = createPlaybookRuntime({ coderLlm: 'GPT-5.6 Sol' });
    await runtime.init(session(ports));

    await expect(
      runtime.handleBossInput({ text: 'Old topic', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'quiescent' });
    expect(playerCalls).toHaveLength(2);

    await expect(
      runtime.handleBossInput({ text: 'New topic', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'suspended' });
    const restarted = playerCalls.slice(2, 4);
    expect(restarted.map(({ playerId }) => playerId).sort()).toEqual([
      'coder',
      'reviewer',
    ]);
    for (const call of restarted) {
      expect(call.prompt).toContain('> New topic');
      expect(call.prompt).not.toContain('> Old topic');
      expect(call.options.resume).toBe(`${call.playerId}-token-1`);
    }

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
