// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type {
  CaptainCallOptions,
  CaptainResult,
  PlaybookCallStart,
  PlaybookPorts,
  PlaybookSession,
  PlayerCallOptions,
  PlayerResult,
} from '@sublang/playbook/runtime';
import createPlaybookRuntime, { _internal } from './review.playbook.js';
import {
  reviewPlaybookRegistryEntry,
  reviewStateCountLabels,
  validateReviewOptions,
} from './review.registry.js';

interface PlayerCall {
  playerId: string;
  prompt: string;
  options: PlayerCallOptions;
}

function session(ports: PlaybookPorts): PlaybookSession {
  const sessionId = randomUUID();
  return {
    sessionId,
    playbookId: 'review',
    rootSessionId: sessionId,
    depth: 0,
    roleBindings: {
      coder: { playerId: 'coder', promptIdentity: 'GPT-5.6 Sol' },
      reviewer: { playerId: 'reviewer', promptIdentity: 'Claude Opus 5' },
    },
    ports,
  };
}

function portsFor(input: {
  playerResults: PlayerResult[];
  judgeReplies: string[];
  playerCalls: PlayerCall[];
}): PlaybookPorts {
  return {
    async callPlayer(playerId, prompt, _signal, options) {
      input.playerCalls.push({ playerId, prompt, options });
      const result = input.playerResults.shift();
      if (result === undefined) throw new Error('unexpected player call');
      return result;
    },
    async callCaptain(
      _prompt: string,
      _signal: AbortSignal,
      _options: CaptainCallOptions,
    ): Promise<CaptainResult> {
      throw new Error('REVIEW must not call Captain directly');
    },
    async callJudge() {
      const reply = input.judgeReplies.shift();
      if (reply === undefined) throw new Error('unexpected judge call');
      return reply;
    },
    async callPlaybook(): Promise<PlaybookCallStart> {
      throw new Error('REVIEW must not call another playbook');
    },
    async emitStatus() {},
    async emitTelemetry() {},
  };
}

describe('linked REVIEW runtime', () => {
  it('carries both players verbatim through a commit-fix round', async () => {
    const playerCalls: PlayerCall[] = [];
    const ports = portsFor({
      playerCalls,
      playerResults: [
        {
          status: 'ok',
          finalText: '1. First finding\n   Evidence.',
          resumeToken: 'reviewer-1',
        },
        {
          status: 'ok',
          finalText: 'Accepted; fixed in abc123.\nTests: focused pass.',
          resumeToken: 'coder-1',
        },
        {
          status: 'ok',
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-2',
        },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        '{"guard":"committed"}',
        '{"guard":"noFindings"}',
      ],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));

    const result = await runtime.handleBossInput({
      text: 'Review the feature.\nRun result: focused suite passed.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    if (result.outcome === 'terminal') {
      expect(result.output).toEqual({
        approvedCommit: 'latest',
        noUnsettledFindings: true,
      });
    }
    expect(playerCalls.map(({ playerId }) => playerId)).toEqual([
      'reviewer',
      'coder',
      'reviewer',
    ]);
    expect(playerCalls.map(({ options }) => options.resume)).toEqual([
      false,
      false,
      'reviewer-1',
    ]);
    expect(playerCalls[0].prompt).toContain(
      '> Review the feature.\n> Run result: focused suite passed.',
    );
    expect(playerCalls[0].prompt).toContain(
      'read the commit message first for its intent, scope, and rationale.',
    );
    expect(playerCalls[0].prompt).toContain(
      'For any rebuttal, accept or challenge it.',
    );
    expect(playerCalls[1].prompt).toContain(
      '> 1. First finding\n>    Evidence.',
    );
    expect(playerCalls[1].prompt).toContain(
      'Coder is GPT-5.6 Sol; Reviewer is Claude Opus 5;',
    );
    expect(playerCalls[2].prompt).toContain(
      '> Accepted; fixed in abc123.\n> Tests: focused pass.',
    );
    expect(playerCalls[2].prompt).toContain(
      'read the commit message first for its intent, scope, and rationale.',
    );
    expect(playerCalls[2].prompt).toContain(
      'For any rebuttal, accept or challenge it.',
    );

    await runtime.dispose();
  });

  it('adjudicates an all-rejected round without inventing a commit', async () => {
    const playerCalls: PlayerCall[] = [];
    const ports = portsFor({
      playerCalls,
      playerResults: [
        {
          status: 'ok',
          finalText: '1. The contract is incomplete.',
          resumeToken: 'reviewer-1',
        },
        {
          status: 'ok',
          finalText:
            'Rejected item 1: the cited contract already requires it.\n' +
            'No files changed and no commit was made.',
          resumeToken: 'coder-1',
        },
        {
          status: 'ok',
          finalText: 'Rebuttal accepted; no unsettled findings remain.',
          resumeToken: 'reviewer-2',
        },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        '{"guard":"rejectedAll"}',
        '{"guard":"noFindings"}',
      ],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));

    const result = await runtime.handleBossInput({
      text: 'Review the latest contract commit.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    if (result.outcome === 'terminal') {
      expect(result.output).toEqual({
        approvedCommit: 'latest',
        noUnsettledFindings: true,
      });
    }
    expect(playerCalls.map(({ playerId }) => playerId)).toEqual([
      'reviewer',
      'coder',
      'reviewer',
    ]);
    expect(playerCalls.map(({ options }) => options.resume)).toEqual([
      false,
      false,
      'reviewer-1',
    ]);
    expect(playerCalls.filter(({ playerId }) => playerId === 'coder')).toHaveLength(
      1,
    );
    expect(playerCalls[2].prompt).toContain(
      'No new commit was made because Coder rejected every finding.',
    );
    expect(
      playerCalls[2].prompt.match(/For any rebuttal, accept or challenge it\./g),
    ).toHaveLength(1);
    expect(playerCalls[2].prompt).not.toContain(
      'State which findings, if any, remain.',
    );
    expect(playerCalls[2].prompt).toContain(
      '> Rejected item 1: the cited contract already requires it.\n' +
        '> No files changed and no commit was made.',
    );
    expect(playerCalls[2].prompt).not.toContain(
      'Review the latest commit and resulting repository state; read the commit message first for its intent, scope, and rationale.',
    );

    await runtime.dispose();
  });

  it.each([
    {
      origin: 'reviewInitial',
      playerResults: [
        {
          status: 'ok' as const,
          finalText: 'Which release target should govern?',
          resumeToken: 'reviewer-question',
        },
        {
          status: 'ok' as const,
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-answer',
        },
      ],
      judgeReplies: [
        '{"guard":"needsBossReply","question":"Which release target should govern?"}',
        '{"type":"BOSS_REPLY"}',
        '{"guard":"noFindings"}',
      ],
      resumedCall: 1,
      resumedPlayer: 'reviewer',
      resumedToken: 'reviewer-question',
    },
    {
      origin: 'addressFindings',
      playerResults: [
        {
          status: 'ok' as const,
          finalText: '1. The target is ambiguous.',
          resumeToken: 'reviewer-findings',
        },
        {
          status: 'ok' as const,
          finalText: 'Which release target should govern?',
          resumeToken: 'coder-question',
        },
        {
          status: 'ok' as const,
          finalText: 'Fixed and committed.',
          resumeToken: 'coder-answer',
        },
        {
          status: 'ok' as const,
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-approved',
        },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        '{"guard":"needsBossReply","question":"Which release target should govern?"}',
        '{"type":"BOSS_REPLY"}',
        '{"guard":"committed"}',
        '{"guard":"noFindings"}',
      ],
      resumedCall: 2,
      resumedPlayer: 'coder',
      resumedToken: 'coder-question',
    },
    {
      origin: 'reviewAfterCommit',
      playerResults: [
        {
          status: 'ok' as const,
          finalText: '1. The target is ambiguous.',
          resumeToken: 'reviewer-findings',
        },
        {
          status: 'ok' as const,
          finalText: 'Fixed and committed.',
          resumeToken: 'coder-commit',
        },
        {
          status: 'ok' as const,
          finalText: 'Which release target should govern?',
          resumeToken: 'reviewer-question',
        },
        {
          status: 'ok' as const,
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-answer',
        },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        '{"guard":"committed"}',
        '{"guard":"needsBossReply","question":"Which release target should govern?"}',
        '{"type":"BOSS_REPLY"}',
        '{"guard":"noFindings"}',
      ],
      resumedCall: 3,
      resumedPlayer: 'reviewer',
      resumedToken: 'reviewer-question',
    },
    {
      origin: 'reviewAfterRebuttal',
      playerResults: [
        {
          status: 'ok' as const,
          finalText: '1. The target is ambiguous.',
          resumeToken: 'reviewer-findings',
        },
        {
          status: 'ok' as const,
          finalText: 'Rejected with evidence.',
          resumeToken: 'coder-rebuttal',
        },
        {
          status: 'ok' as const,
          finalText: 'Which release target should govern?',
          resumeToken: 'reviewer-question',
        },
        {
          status: 'ok' as const,
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-answer',
        },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        '{"guard":"rejectedAll"}',
        '{"guard":"needsBossReply","question":"Which release target should govern?"}',
        '{"type":"BOSS_REPLY"}',
        '{"guard":"noFindings"}',
      ],
      resumedCall: 3,
      resumedPlayer: 'reviewer',
      resumedToken: 'reviewer-question',
    },
  ])('resumes $origin after a Boss answer', async (scenario) => {
    const playerCalls: PlayerCall[] = [];
    const ports = portsFor({
      playerCalls,
      playerResults: [...scenario.playerResults],
      judgeReplies: [...scenario.judgeReplies],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));

    const parked = await runtime.handleBossInput({
      text: 'Review the release commit.',
      signal: new AbortController().signal,
    });
    expect(parked.outcome).toBe('quiescent');
    expect(parked.state.stateId).toBe('awaitBossReply');

    const completed = await runtime.handleBossInput({
      text: 'Target version 6.0.0.',
      signal: new AbortController().signal,
    });
    expect(completed.outcome).toBe('terminal');
    const resumed = playerCalls[scenario.resumedCall];
    expect(resumed?.playerId).toBe(scenario.resumedPlayer);
    expect(resumed?.options.resume).toBe(scenario.resumedToken);
    expect(resumed?.prompt).toContain(
      'Boss question:\nWhich release target should govern?',
    );
    expect(resumed?.prompt).toContain(
      'Boss reply:\nTarget version 6.0.0.',
    );

    await runtime.dispose();
  });

  it('abandons a pending question when Boss starts a fresh review', async () => {
    const playerCalls: PlayerCall[] = [];
    const ports = portsFor({
      playerCalls,
      playerResults: [
        {
          status: 'ok',
          finalText: 'Which release target should govern?',
          resumeToken: 'reviewer-question',
        },
        {
          status: 'ok',
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-restarted',
        },
      ],
      judgeReplies: [
        '{"guard":"needsBossReply","question":"Which release target should govern?"}',
        '{"type":"BOSS_INTERRUPT","targetId":"reviewInitial"}',
        '{"guard":"noFindings"}',
      ],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));

    await runtime.handleBossInput({
      text: 'Review the old release commit.',
      signal: new AbortController().signal,
    });
    const completed = await runtime.handleBossInput({
      text: 'Review the replacement commit instead.',
      signal: new AbortController().signal,
    });

    expect(completed.outcome).toBe('terminal');
    expect(playerCalls[1]?.prompt).toContain(
      '> Review the replacement commit instead.',
    );
    expect(playerCalls[1]?.prompt).not.toContain('Boss question:');
    expect(playerCalls[1]?.prompt).not.toContain('Boss reply:');
    await runtime.dispose();
  });

  it('restarts a failed review with fresh caller context', async () => {
    const playerCalls: PlayerCall[] = [];
    const ports = portsFor({
      playerCalls,
      playerResults: [
        { status: 'error', error: 'reviewer transport failed' },
        {
          status: 'ok',
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-restarted',
        },
      ],
      // PBRT-1: the failure state is a deterministic entry, so the restart
      // makes no classifier call — the only judge reply the turn consumes
      // is the restarted reviewer's adjudication. A classifier call here
      // would shift this queue and fail loudly on the missing guard.
      judgeReplies: ['{"guard":"noFindings"}'],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(session(ports));

    const failed = await runtime.handleBossInput({
      text: 'Review the old release commit.',
      signal: new AbortController().signal,
    });
    expect(failed.outcome).toBe('failed');
    expect(runtime.describe!().lastError).toMatchObject({
      message: 'reviewer transport failed',
    });

    const completed = await runtime.handleBossInput({
      text: 'Review the replacement commit.',
      signal: new AbortController().signal,
    });
    expect(completed.outcome).toBe('terminal');
    expect(playerCalls[1]?.prompt).toContain('> Review the replacement commit.');
    expect(playerCalls[1]?.prompt).not.toContain('old release commit');
    expect(runtime.describe!().lastError).toBeUndefined();
    await runtime.dispose();
  });

  it('counts only Reviewer review and rebuttal states as rounds', () => {
    expect(reviewStateCountLabels).toEqual({
      reviewInitial: 'review round',
      reviewAfterCommit: 'review round',
      reviewAfterRebuttal: 'rebuttal',
    });
  });

  it('advertises the schema-2 local-role manifest', () => {
    expect(reviewPlaybookRegistryEntry).toMatchObject({
      artifactSchema: 2,
      requiredRoleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [],
    });
  });

  it('validates the registry slice without deriving host identity', () => {
    expect(validateReviewOptions(undefined)).toEqual({});
    expect(() => validateReviewOptions({ extra: true })).toThrow(
      /review\.options\.extra/,
    );
    expect(
      reviewPlaybookRegistryEntry.createRuntime(
        validateReviewOptions({}),
      ),
    ).toBeDefined();
    expect(() =>
      createPlaybookRuntime({ coderLlm: 'gpt-5.6' } as never),
    ).toThrow(/runtime options\.coderLlm is not declared/);
  });

  it('quotes every line of relayed text without recursive substitution', () => {
    const prompt = _internal.composePlayerPrompt({
      stateId: 'reviewAfterCommit',
      sourceItem: 'REVIEW-3',
      role: 'reviewer',
      prompt: '> <coder-output>\nUse <coder-llm>.',
      result: { noFindings: 'No findings.' },
      coderOutput: 'Line one\nLine two with <coder-llm> and $&.',
    }, (roleId) => roleId === 'coder' ? 'GPT-5.6 Sol' : roleId);
    expect(prompt).toBe(
      '> Line one\n> Line two with <coder-llm> and $&.\nUse GPT-5.6 Sol.',
    );
  });
});
