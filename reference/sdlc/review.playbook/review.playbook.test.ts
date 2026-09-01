// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPlaybookEffectLedger,
  emptyPlaybookEffectLedger,
} from '../../../src/xstate-runtime.js';

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
import { createRepositoryEffectCapabilities } from '../code.playbook/bin/repository-effects.js';

type RepositoryEffect =
  | 'commit'
  | 'commit-all'
  | 'unchanged'
  | 'worktree'
  | 'multiple'
  | 'rewritten'
  | 'residual';

type PlayerFixture = PlayerResult & {
  readonly repositoryEffect?: RepositoryEffect;
};

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

interface HarnessInput {
  playerResults: PlayerFixture[];
  judgeReplies: string[];
  playerCalls: PlayerCall[];
}

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repo,
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function initRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'review-authority-'));
  tempDirs.push(repo);
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'user.name', 'REVIEW Authority Test');
  await git(repo, 'config', 'user.email', 'review@example.invalid');
  await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8');
  await git(repo, 'add', '--all');
  await git(repo, 'commit', '--quiet', '-m', 'base');
  return repo;
}

function effectLedgerService() {
  let ledger = emptyPlaybookEffectLedger();
  return {
    snapshot: () => ledger,
    async writeAhead(_authority: unknown, commands: any[]) {
      const boundaries = [...ledger.boundaries] as any[];
      const logicalOperations = [...ledger.logicalOperations] as any[];
      for (const command of commands) {
        if (command.kind === 'start-boundaries') {
          const attemptId = '10000000-0000-4000-8000-000000000001';
          for (const seed of command.boundaries) {
            boundaries.push({
              sequence: boundaries.length + 1,
              ...seed,
              attemptId,
              attemptNumber: 1,
            });
          }
          continue;
        }
        if (command.kind === 'replace-boundaries') {
          for (const replacement of command.replacements) {
            const index = boundaries.findIndex(
              (boundary) =>
                boundary.boundaryId === replacement.expected.boundaryId,
            );
            if (
              index < 0 ||
              JSON.stringify(boundaries[index]) !==
                JSON.stringify(replacement.expected)
            ) {
              throw new Error('REVIEW test effect-ledger replacement is stale');
            }
            boundaries[index] = replacement.next;
          }
          continue;
        }
        if (command.kind === 'append-logical-operations') {
          for (const operation of command.operations) {
            logicalOperations.push({
              sequence: logicalOperations.length + 1,
              ...operation,
            });
          }
          continue;
        }
        if (command.kind === 'replace-logical-operations') {
          for (const replacement of command.replacements) {
            const index = logicalOperations.findIndex(
              (operation) =>
                operation.operationId === replacement.expected.operationId,
            );
            if (
              index < 0 ||
              JSON.stringify(logicalOperations[index]) !==
                JSON.stringify(replacement.expected)
            ) {
              throw new Error(
                'REVIEW test logical-operation replacement is stale',
              );
            }
            logicalOperations[index] = replacement.next;
          }
          continue;
        }
        throw new Error(`unsupported REVIEW ledger command ${command.kind}`);
      }
      ledger = assertPlaybookEffectLedger({
        ...ledger,
        revision: ledger.revision + 1,
        boundaries,
        logicalOperations,
      });
      return ledger;
    },
  };
}

async function harness(input: HarnessInput) {
  const repo = await initRepository();
  const baseCommit = await git(repo, 'rev-parse', 'HEAD');
  const ledgerService = effectLedgerService();
  const telemetry: Array<{ topic: string; payload: unknown }> = [];
  const statuses: string[] = [];
  const commitOids: string[] = [];
  let effectIndex = 0;
  const applyRepositoryEffect = async (
    effect: RepositoryEffect,
  ): Promise<void> => {
    effectIndex += 1;
    if (effect === 'unchanged') return;
    if (effect === 'worktree') {
      await writeFile(join(repo, `effect-${effectIndex}.txt`), 'changed\n');
      return;
    }
    if (effect === 'rewritten') {
      const tree = await git(repo, 'rev-parse', 'HEAD^{tree}');
      const oid = await git(repo, 'commit-tree', tree, '-m', 'foreign root');
      await git(repo, 'reset', '--hard', '--quiet', oid);
      return;
    }
    const commit = async (message: string): Promise<void> => {
      await git(repo, 'commit', '--quiet', '--allow-empty', '-m', message);
      commitOids.push(await git(repo, 'rev-parse', 'HEAD'));
    };
    if (effect === 'multiple') {
      await commit(`review ${effectIndex}.1`);
      await commit(`review ${effectIndex}.2`);
      return;
    }
    if (effect === 'commit-all') {
      await git(repo, 'add', '--all');
      await git(repo, 'commit', '--quiet', '-m', `review ${effectIndex}`);
      commitOids.push(await git(repo, 'rev-parse', 'HEAD'));
      return;
    }
    await commit(`review ${effectIndex}`);
    if (effect === 'residual') {
      await writeFile(join(repo, `residual-${effectIndex}.txt`), 'residual\n');
    }
  };
  const ports: PlaybookPorts = {
    async callPlayer(playerId, prompt, _signal, options) {
      input.playerCalls.push({ playerId, prompt, options });
      const result = input.playerResults.shift();
      if (result === undefined) throw new Error('unexpected player call');
      const { repositoryEffect = 'unchanged', ...playerResult } = result;
      await applyRepositoryEffect(repositoryEffect);
      return playerResult;
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
    async emitStatus(message) {
      statuses.push(message);
    },
    async emitTelemetry(event) {
      telemetry.push(event);
    },
  };
  const capabilities = await createRepositoryEffectCapabilities({
    cwd: repo,
    catalog: {
      review: {
        id: 'review',
        artifactSchema: 3,
        requiredRoleIds: ['coder', 'reviewer'],
        concurrentRoleSets: [],
      },
    },
    sessionId: '20000000-0000-4000-8000-000000000001',
    sessionLease: {
      sessionId: '20000000-0000-4000-8000-000000000001',
      ownerToken: '30000000-0000-4000-8000-000000000001',
      assertOwner: async () => undefined,
    },
    createWriteAhead: () => ledgerService,
  });
  return {
    ports,
    telemetry,
    statuses,
    baseCommit,
    commitOids,
    effectLedger: ledgerService,
    hostCapabilities: capabilities.review,
  };
}

type ReviewHarness = Awaited<ReturnType<typeof harness>>;

function linkedRuntime(host: ReviewHarness, options: unknown = {}) {
  return createPlaybookRuntime({
    configuredOptions: options,
    hostCapabilities: host.hostCapabilities,
  });
}

function acceptedOutcomes(host: ReviewHarness): unknown[] {
  return host.telemetry
    .filter(({ topic }) => topic === 'playbook.trace')
    .map(({ payload }) => payload as { type?: string; payload?: unknown })
    .filter(({ type }) => type === 'outcome.accepted')
    .map(({ payload }) => payload);
}

describe('linked REVIEW runtime', () => {
  it('carries both players verbatim through a commit-fix round', async () => {
    const playerCalls: PlayerCall[] = [];
    const host = await harness({
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
          repositoryEffect: 'commit',
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
    const runtime = linkedRuntime(host);
    await runtime.init(session(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Review the feature.\nRun result: focused suite passed.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    if (result.outcome === 'terminal') {
      expect(result.stateDescription).toBe(
        'The requested review is complete: no unsettled findings remain within the review scope.',
      );
      // The evaluated revision is the receipt-derived review-fix commit OID:
      // the judge reply named no commit, so only the receipt can supply it.
      expect(result.output).toEqual({
        noUnsettledFindings: true,
        evaluatedRevision: host.commitOids[0],
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
      'A new review begins for the review scope.',
    );
    expect(playerCalls[0].prompt).toContain(
      'Keep to the original intent and follow what it asks.',
    );
    expect(playerCalls[0].prompt).toContain(
      'When the scope names commits, read each commit message for its context and rationale; otherwise use repository history and commit messages wherever they help establish that context.',
    );
    expect(playerCalls[0].prompt).toContain(
      'For any rebuttal, accept or challenge it.',
    );
    expect(playerCalls[1].prompt).toContain(
      '> Review the feature.\n> Run result: focused suite passed.',
    );
    expect(playerCalls[1].prompt).toContain(
      '> 1. First finding\n>    Evidence.',
    );
    expect(playerCalls[1].prompt).toContain(
      'Keep to the original intent and follow what it asks.',
    );
    expect(playerCalls[1].prompt).toContain(
      'Identify every new commit you make.',
    );
    expect(playerCalls[1].prompt).toContain(
      'Coder is GPT-5.6 Sol; Reviewer is Claude Opus 5.',
    );
    expect(playerCalls[1].prompt).not.toContain(
      'format model tokens in conventional human form',
    );
    expect(playerCalls[2].prompt).toContain(
      'A new review round begins for the review scope in the cumulative committed state, with particular attention to the latest review-fix commit.',
    );
    expect(playerCalls[2].prompt).toContain(
      "Read the latest review-fix commit's message and see Coder's feedback below.",
    );
    expect(playerCalls[2].prompt).toContain(
      '> Review the feature.\n> Run result: focused suite passed.',
    );
    // The relayed evaluated revision is the exact receipt-derived commit OID.
    expect(playerCalls[2].prompt).toContain(`> ${host.commitOids[0]}`);
    expect(playerCalls[2].prompt).toContain(
      '> Accepted; fixed in abc123.\n> Tests: focused pass.',
    );
    expect(playerCalls[2].prompt).toContain(
      'For any rebuttal, accept or challenge it.',
    );
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'reviewInitial',
        target: 'addressFindings',
        acceptedOutcome: 'hasFindings',
      },
      {
        source: 'addressFindings',
        target: 'reviewAfterCommit',
        acceptedOutcome: 'committed',
      },
      {
        source: 'reviewAfterCommit',
        target: 'done',
        acceptedOutcome: 'noFindings',
      },
    ]);
    expect(host.statuses).toEqual(
      expect.arrayContaining([
        '→ hasFindings',
        '→ committed',
        '→ noFindings',
      ]),
    );

    await runtime.dispose();
  });

  it('adjudicates an all-rejected round without inventing a commit', async () => {
    const playerCalls: PlayerCall[] = [];
    const host = await harness({
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
    const runtime = linkedRuntime(host);
    await runtime.init(session(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Review the latest contract commit.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    if (result.outcome === 'terminal') {
      // No review-fix commit landed, so the closing clean round's unchanged
      // receipt observes the caller-supplied scope revision as HEAD and the
      // reconciler injects exactly that OID (DR-045).
      expect(result.output).toEqual({
        noUnsettledFindings: true,
        evaluatedRevision: host.baseCommit,
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
    expect(playerCalls[2].prompt).toContain("See Coder's feedback below.");
    expect(playerCalls[2].prompt).toContain(
      '> Review the latest contract commit.',
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
      'A new review round begins for the review scope in the cumulative committed state',
    );
    expect(playerCalls[2].prompt).not.toContain('> <latest-commit>');
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'reviewInitial',
        target: 'addressFindings',
        acceptedOutcome: 'hasFindings',
      },
      {
        source: 'addressFindings',
        target: 'reviewAfterRebuttal',
        acceptedOutcome: 'rejectedAll',
      },
      {
        source: 'reviewAfterRebuttal',
        target: 'done',
        acceptedOutcome: 'noFindings',
      },
    ]);

    await runtime.dispose();
  });

  it('keeps a Reviewer outcome unresolved after any repository change', async () => {
    const playerCalls: PlayerCall[] = [];
    const host = await harness({
      playerCalls,
      playerResults: [
        {
          status: 'ok',
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-1',
          repositoryEffect: 'commit',
        },
      ],
      judgeReplies: ['{"guard":"noFindings"}'],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(session(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Review the latest commit.',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(playerCalls).toHaveLength(1);
    expect(host.effectLedger.snapshot().boundaries[0]?.physicalReceipt)
      .toMatchObject({ classification: 'concurrent-or-foreign-change' });
    expect(acceptedOutcomes(host)).toEqual([]);
    expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
      'reconcile:unresolved-effect',
      'abandon:unresolved-effect',
    ]);
    await runtime.dispose();
  });

  it.each([
    ['committed', 'unchanged', 'unchanged'],
    ['rejectedAll', 'commit', 'one-descendant-commit'],
    ['committed', 'residual', 'observation-ambiguous'],
  ] as const)(
    'parks Coder %s under %s evidence without replay',
    async (guard, repositoryEffect, classification) => {
      const playerCalls: PlayerCall[] = [];
      const host = await harness({
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
              guard === 'committed'
                ? 'Accepted and committed.'
                : 'Rejected every finding with evidence.',
            resumeToken: 'coder-1',
            repositoryEffect,
          },
        ],
        judgeReplies: [
          '{"guard":"hasFindings"}',
          JSON.stringify({ guard }),
        ],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(session(host.ports));

      const result = await runtime.handleBossInput({
        text: 'Review the latest contract commit.',
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        outcome: 'failed',
        state: { stateId: 'failed' },
      });
      expect(playerCalls.map(({ playerId }) => playerId)).toEqual([
        'reviewer',
        'coder',
      ]);
      expect(host.effectLedger.snapshot().boundaries[1]?.physicalReceipt)
        .toMatchObject({ classification });
      expect(acceptedOutcomes(host)).toEqual([
        {
          source: 'reviewInitial',
          target: 'addressFindings',
          acceptedOutcome: 'hasFindings',
        },
      ]);
      expect(host.statuses).not.toContain(`→ ${guard}`);
      expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
        'reconcile:unresolved-effect',
        'abandon:unresolved-effect',
      ]);
      await runtime.dispose();
    },
  );

  it('rejects a judge-authored commit identity instead of trusting prose', async () => {
    const playerCalls: PlayerCall[] = [];
    const host = await harness({
      playerCalls,
      playerResults: [
        {
          status: 'ok',
          finalText: '1. The contract is incomplete.',
          resumeToken: 'reviewer-1',
        },
        {
          status: 'ok',
          finalText: 'Accepted and committed as deadbeef.',
          resumeToken: 'coder-1',
          repositoryEffect: 'commit',
        },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        // The candidate may carry only the guard plus semantic-owned fields;
        // a judge-supplied latestCommit is a structural error, and the one
        // corrective adjudication repeats it, so the boundary stays parked.
        '{"guard":"committed","latestCommit":"deadbeef"}',
        '{"guard":"committed","latestCommit":"deadbeef"}',
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(session(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Review the latest contract commit.',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(playerCalls.map(({ playerId }) => playerId)).toEqual([
      'reviewer',
      'coder',
    ]);
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'reviewInitial',
        target: 'addressFindings',
        acceptedOutcome: 'hasFindings',
      },
    ]);
    expect(host.statuses).not.toContain('→ committed');
    expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
      'reconcile:unresolved-effect',
      'abandon:unresolved-effect',
    ]);
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
        '{"guard":"needsBossReply"}',
        '{"type":"BOSS_REPLY"}',
        '{"guard":"noFindings"}',
      ],
      resumedCall: 1,
      resumedPlayer: 'reviewer',
      resumedToken: 'reviewer-question',
      deferred: false,
      expectsFixRevision: false,
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
          repositoryEffect: 'worktree' as const,
        },
        {
          status: 'ok' as const,
          finalText: 'Fixed and committed.',
          resumeToken: 'coder-answer',
          repositoryEffect: 'commit-all' as const,
        },
        {
          status: 'ok' as const,
          finalText: 'No unsettled findings.',
          resumeToken: 'reviewer-approved',
        },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        '{"guard":"needsBossReply"}',
        '{"type":"BOSS_REPLY"}',
        '{"guard":"committed"}',
        '{"guard":"noFindings"}',
      ],
      resumedCall: 2,
      resumedPlayer: 'coder',
      resumedToken: 'coder-question',
      deferred: true,
      expectsFixRevision: true,
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
          repositoryEffect: 'commit' as const,
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
        '{"guard":"needsBossReply"}',
        '{"type":"BOSS_REPLY"}',
        '{"guard":"noFindings"}',
      ],
      resumedCall: 3,
      resumedPlayer: 'reviewer',
      resumedToken: 'reviewer-question',
      deferred: false,
      expectsFixRevision: true,
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
        '{"guard":"needsBossReply"}',
        '{"type":"BOSS_REPLY"}',
        '{"guard":"noFindings"}',
      ],
      resumedCall: 3,
      resumedPlayer: 'reviewer',
      resumedToken: 'reviewer-question',
      deferred: false,
      expectsFixRevision: false,
    },
  ])('resumes $origin after a Boss answer', async (scenario) => {
    const playerCalls: PlayerCall[] = [];
    const host = await harness({
      playerCalls,
      playerResults: [...scenario.playerResults],
      judgeReplies: [...scenario.judgeReplies],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(session(host.ports));

    const parked = await runtime.handleBossInput({
      text: 'Review the release commit.',
      signal: new AbortController().signal,
    });
    expect(parked.outcome).toBe('quiescent');
    expect(parked.state.stateId).toBe('awaitBossReply');
    const openOperation = host.effectLedger.snapshot().logicalOperations[0];
    if (scenario.deferred) {
      expect(openOperation).toMatchObject({
        originalBaseline: { projection: {} },
        checkpoint: {
          projection: { 'effect-2.txt': expect.any(Object) },
        },
        pendingQuestion: {
          question: 'Which release target should govern?',
        },
      });
    } else {
      expect(openOperation).toBeUndefined();
    }

    const completed = await runtime.handleBossInput({
      text: 'Target version 6.0.0.',
      signal: new AbortController().signal,
    });
    expect(completed.outcome).toBe('terminal');
    if (completed.outcome === 'terminal') {
      // DR-045: the closing clean round's unchanged receipt always observes
      // the evaluated revision — the review-fix commit when one landed, the
      // caller-supplied baseline otherwise.
      expect(completed.output).toEqual({
        noUnsettledFindings: true,
        evaluatedRevision: scenario.expectsFixRevision
          ? host.commitOids[0]
          : host.baseCommit,
      });
    }
    const resumed = playerCalls[scenario.resumedCall];
    expect(resumed?.playerId).toBe(scenario.resumedPlayer);
    expect(resumed?.options.resume).toBe(scenario.resumedToken);
    expect(resumed?.prompt).toContain(
      'Boss question:\nWhich release target should govern?',
    );
    expect(resumed?.prompt).toContain(
      'Boss reply:\nTarget version 6.0.0.',
    );
    if (scenario.deferred) {
      expect(host.effectLedger.snapshot().logicalOperations[0]).toMatchObject({
        operationId: openOperation?.operationId,
        originalBaseline: openOperation?.originalBaseline,
        logicalReceipt: {
          classification: 'one-descendant-commit',
          commitOid: host.commitOids[0],
        },
      });
    }

    await runtime.dispose();
  });

  it('abandons a pending question when Boss starts a fresh review', async () => {
    const playerCalls: PlayerCall[] = [];
    const host = await harness({
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
        '{"guard":"needsBossReply"}',
        '{"type":"BOSS_INTERRUPT","targetId":"reviewInitial"}',
        '{"guard":"noFindings"}',
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(session(host.ports));

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
    const host = await harness({
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
    const runtime = linkedRuntime(host);
    await runtime.init(session(host.ports));

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

  it('advertises the schema-3 local-role manifest', async () => {
    const playerCalls: PlayerCall[] = [];
    const host = await harness({
      playerCalls,
      playerResults: [],
      judgeReplies: [],
    });
    expect(reviewPlaybookRegistryEntry).toMatchObject({
      artifactSchema: 3,
      runtimeProfile: {
        kind: 'shared-factory',
        compat: { artifactSchema: 3, runtimeAbi: 1 },
      },
      requiredRoleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [],
    });
    expect(reviewPlaybookRegistryEntry.runtimeProfile.compat).toBe(
      createPlaybookRuntime.compat,
    );
    expect(
      reviewPlaybookRegistryEntry.createRuntime(
        validateReviewOptions({}),
        host.hostCapabilities,
      ),
    ).toBeDefined();
    expect(() => linkedRuntime(host, { coderLlm: 'gpt-5.6' })).toThrow(
      /runtime options\.coderLlm is not declared/,
    );
  });

  it('validates the registry slice without deriving host identity', () => {
    expect(validateReviewOptions(undefined)).toEqual({});
    expect(() => validateReviewOptions({ extra: true })).toThrow(
      /review\.options\.extra/,
    );
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
