// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { assertWorkflowTerminal } from '../../../scripts/test-support/workflow-contracts.mjs';

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
  const { stdout } = await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], {
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
  const judgePrompts: string[] = [];
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
    async callJudge(prompt) {
      judgePrompts.push(prompt);
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
    judgePrompts,
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
    assertWorkflowTerminal('review', result);
    if (result.outcome === 'terminal') {
      expect(result.stateDescription).toBe(
        'REVIEW completed: the review scope was evaluated at the returned revision and no unsettled findings remain.',
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
    // DR-065: the instructions lead, after the role line (DR-090 §3), and
    // the relayed caller input trails.
    expect(playerCalls[0].prompt.startsWith(
      'Role: reviewer · Model: Claude Opus 5\n\nA new review begins for the review scope.\n',
    )).toBe(true);
    expect(playerCalls[0].prompt.endsWith(
      '\n\n> Original request: Review the feature.\n> Run result: focused suite passed.',
    )).toBe(true);
    expect(playerCalls[0].prompt).toContain(
      'Keep to the original intent and follow what it asks.',
    );
    expect(playerCalls[0].prompt).toContain(
      'When the scope names commits, read each commit message for its context and rationale; otherwise use repository history and commit messages wherever they help establish that context.',
    );
    expect(playerCalls[0].prompt).toContain(
      'For any rebuttal, accept or challenge it.',
    );
    // Every later prompt relays the request whole as well.
    expect(playerCalls[1].prompt).toContain(
      '> Original request: Review the feature.\n> Run result: focused suite passed.',
    );
    expect(playerCalls[1].prompt).toContain(
      '> Reviewer findings: 1. First finding\n>    Evidence.',
    );
    expect(playerCalls[1].prompt).toContain(
      'Keep to the original intent and follow what it asks.',
    );
    expect(playerCalls[1].prompt).toContain(
      'Identify every new commit you make.',
    );
    expect(playerCalls[1].prompt).toContain(
      'Credit every AI that contributed to this commit: Coder GPT-5.6 Sol and Reviewer Claude Opus 5, whose findings it answers.',
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
      '> Original request: Review the feature.\n> Run result: focused suite passed.',
    );
    // The relayed evaluated revision is the exact receipt-derived commit OID.
    expect(playerCalls[2].prompt).toContain(`> Latest commit: ${host.commitOids[0]}`);
    expect(playerCalls[2].prompt).toContain(
      '> Coder output: Accepted; fixed in abc123.\n> Tests: focused pass.',
    );
    expect(playerCalls[2].prompt).toContain(
      'For any rebuttal, accept or challenge it.',
    );
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'firstReview',
        target: 'fixFindings',
        acceptedOutcome: 'hasFindings',
      },
      {
        source: 'fixFindings',
        target: 'reviewAfterFix',
        acceptedOutcome: 'committed',
      },
      {
        source: 'reviewAfterFix',
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
    // compiler-results-13 / playbook-21: each Reviewer adjudication prompt
    // tells the judge, in both the findings and the clean outcome, that a
    // progress report, status update, or promise supports neither.
    expect(host.judgePrompts).toHaveLength(3);
    for (const index of [0, 2]) {
      expect(
        host.judgePrompts[index]?.split(
          'a progress report, status update, or promise of a later result supports no review outcome',
        ),
        `judge prompt ${index}`,
      ).toHaveLength(3);
    }

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
    assertWorkflowTerminal('review', result);
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
      '> Original request: Review the latest contract commit.',
    );
    expect(
      playerCalls[2].prompt.match(/For any rebuttal, accept or challenge it\./g),
    ).toHaveLength(1);
    expect(playerCalls[2].prompt).not.toContain(
      'State which findings, if any, remain.',
    );
    expect(playerCalls[2].prompt).toContain(
      '> Coder output: Rejected item 1: the cited contract already requires it.\n' +
        '> No files changed and no commit was made.',
    );
    expect(playerCalls[2].prompt).not.toContain(
      'A new review round begins for the review scope in the cumulative committed state',
    );
    expect(playerCalls[2].prompt).not.toContain('> <latest-commit>');
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'firstReview',
        target: 'fixFindings',
        acceptedOutcome: 'hasFindings',
      },
      {
        source: 'fixFindings',
        target: 'reviewAfterRejection',
        acceptedOutcome: 'rejectedAll',
      },
      {
        source: 'reviewAfterRejection',
        target: 'done',
        acceptedOutcome: 'noFindings',
      },
    ]);

    await runtime.dispose();
  });

  // A caller's labelled request reaches Reviewer and Coder whole in every
  // round: a later round's conversation may start fresh, so no prompt assumes
  // what an earlier one said, and every label the caller wrote stays.
  it('relays a labelled request whole in every round', async () => {
    const playerCalls: PlayerCall[] = [];
    const host = await harness({
      playerCalls,
      playerResults: [
        { status: 'ok', finalText: '1. The grammar drifted.', resumeToken: 'reviewer-1' },
        { status: 'ok', finalText: 'Rejected item 1 with evidence.', resumeToken: 'coder-1' },
        { status: 'ok', finalText: '1. The grammar still drifts.', resumeToken: 'reviewer-2' },
        {
          status: 'ok',
          finalText: 'Accepted and fixed.',
          resumeToken: 'coder-2',
          repositoryEffect: 'commit',
        },
        { status: 'ok', finalText: 'No unsettled findings.', resumeToken: 'reviewer-3' },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        '{"guard":"rejectedAll"}',
        '{"guard":"hasFindings"}',
        '{"guard":"committed"}',
        '{"guard":"noFindings"}',
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(session(host.ports));

    // The request as CODE composes it: its lines carry the relay's quote.
    const request = [
      '> Original intent: Ship the parser.',
      '> Note: docs follow.',
      '> Review scope: the commit abc123 from this coding phase and its resulting repository state.',
      '> Coder output: Committed the parser.',
    ].join('\n');
    const result = await runtime.handleBossInput({
      text: request,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    assertWorkflowTerminal('review', result);
    expect(playerCalls.map(({ playerId }) => playerId)).toEqual([
      'reviewer',
      'coder',
      'reviewer',
      'coder',
      'reviewer',
    ]);
    const relayed = '> Original request: ' + request.replaceAll('\n', '\n> ');
    expect(playerCalls[0].prompt.endsWith(`\n\n${relayed}`)).toBe(true);
    expect(playerCalls[1].prompt.endsWith(
      `\n\n${relayed}\n> Reviewer findings: 1. The grammar drifted.`,
    )).toBe(true);
    expect(playerCalls[2].prompt.endsWith(
      `\n\n${relayed}\n> Coder output: Rejected item 1 with evidence.`,
    )).toBe(true);
    expect(playerCalls[3].prompt.endsWith(
      `\n\n${relayed}\n> Reviewer findings: 1. The grammar still drifts.`,
    )).toBe(true);
    expect(playerCalls[4].prompt.endsWith(
      `\n\n${relayed}\n> Latest commit: ${host.commitOids[0]}\n> Coder output: Accepted and fixed.`,
    )).toBe(true);
    for (const { prompt } of playerCalls) {
      expect(prompt).toContain('> Review scope:');
      expect(prompt).not.toContain('<original-intent>');
    }
    expect(acceptedOutcomes(host)).toEqual([
      { source: 'firstReview', target: 'fixFindings', acceptedOutcome: 'hasFindings' },
      { source: 'fixFindings', target: 'reviewAfterRejection', acceptedOutcome: 'rejectedAll' },
      { source: 'reviewAfterRejection', target: 'fixFindings', acceptedOutcome: 'hasFindings' },
      { source: 'fixFindings', target: 'reviewAfterFix', acceptedOutcome: 'committed' },
      { source: 'reviewAfterFix', target: 'done', acceptedOutcome: 'noFindings' },
    ]);
    await runtime.dispose();
  });

  // playbook-62 / DR-102: REVIEW runs at most three Reviewer rounds; findings
  // the third round raises or keeps stop it unsettled, with no sixth call.
  it.each([
    ['a rejection', 'reviewAfterRejection', undefined, 'rejectedAll'],
    ['a second commit', 'reviewAfterFix', 'commit', 'committed'],
  ] as const)(
    'stops after the third round with the findings unsettled after %s',
    async (_name, lastRound, secondEffect, secondGuard) => {
      const playerCalls: PlayerCall[] = [];
      const thirdFindings = '1. The parser still drops escapes.\n   Evidence.';
      const host = await harness({
        playerCalls,
        playerResults: [
          { status: 'ok', finalText: '1. The parser drops escapes.', resumeToken: 'reviewer-1' },
          {
            status: 'ok',
            finalText: 'Accepted and fixed.',
            resumeToken: 'coder-1',
            repositoryEffect: 'commit',
          },
          { status: 'ok', finalText: '1. The parser still drops escapes.', resumeToken: 'reviewer-2' },
          {
            status: 'ok',
            finalText:
              secondGuard === 'committed'
                ? 'Accepted and fixed again.'
                : 'Rejected item 1 with evidence.',
            resumeToken: 'coder-2',
            ...(secondEffect === undefined ? {} : { repositoryEffect: secondEffect }),
          },
          { status: 'ok', finalText: thirdFindings, resumeToken: 'reviewer-3' },
          { status: 'ok', finalText: 'Unexpected sixth call.', resumeToken: 'coder-3' },
        ],
        judgeReplies: [
          '{"guard":"hasFindings"}',
          '{"guard":"committed"}',
          '{"guard":"hasFindings"}',
          `{"guard":"${secondGuard}"}`,
          '{"guard":"hasFindings"}',
        ],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(session(host.ports));

      const result = await runtime.handleBossInput({
        text: 'Review the parser commit.',
        signal: new AbortController().signal,
      });

      expect(result.outcome).toBe('terminal');
      assertWorkflowTerminal('review', result);
      if (result.outcome === 'terminal') {
        expect(result.stateDescription).toBe(
          'REVIEW stopped after its third round: findings remain unsettled within the review scope, and no further fix round runs.',
        );
        expect(result.output).toEqual({
          noUnsettledFindings: false,
          reviewerOutput: thirdFindings,
        });
      }
      expect(playerCalls.map(({ playerId }) => playerId)).toEqual([
        'reviewer',
        'coder',
        'reviewer',
        'coder',
        'reviewer',
      ]);
      expect(acceptedOutcomes(host)).toEqual([
        { source: 'firstReview', target: 'fixFindings', acceptedOutcome: 'hasFindings' },
        { source: 'fixFindings', target: 'reviewAfterFix', acceptedOutcome: 'committed' },
        { source: 'reviewAfterFix', target: 'fixFindings', acceptedOutcome: 'hasFindings' },
        { source: 'fixFindings', target: lastRound, acceptedOutcome: secondGuard },
        { source: lastRound, target: 'unsettled', acceptedOutcome: 'hasFindings' },
      ]);
      // No sixth player call and no sixth adjudication ran.
      expect(host.judgePrompts).toHaveLength(5);
      expect(playerCalls).toHaveLength(5);
      await runtime.dispose();
    },
  );

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

  // DR-040 §4 / PBRT-77: an `unchanged` receipt excludes any effect, so a
  // claimed commit over it is an ordinary failure whose all-`unchanged`
  // attempt keeps the ordinary retry — never a parked reconciliation whose
  // abandonment would have no effect evidence to record.
  it('fails Coder committed under unchanged evidence into the ordinary retryable failure', async () => {
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
          finalText: 'Accepted and committed.',
          resumeToken: 'coder-1',
          repositoryEffect: 'unchanged',
        },
      ],
      judgeReplies: ['{"guard":"hasFindings"}', '{"guard":"committed"}'],
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
    expect(
      host.effectLedger
        .snapshot()
        .boundaries.map(({ physicalReceipt }) => physicalReceipt?.classification),
    ).toEqual(['unchanged', 'unchanged']);
    expect(host.statuses).not.toContain('→ committed');
    expect(runtime.unresolvedEffectEnvelopes?.()).toEqual([]);
    // Besides the ordinary retry, Boss may jump back into any round whose
    // typed context exists; no reconciliation action is offered.
    expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
      'retry:step',
      'jump:firstReview',
      'jump:fixFindings',
    ]);
    await runtime.dispose();
  });

  it.each([
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
          source: 'firstReview',
          target: 'fixFindings',
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
        source: 'firstReview',
        target: 'fixFindings',
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
      origin: 'firstReview',
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
      origin: 'fixFindings',
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
      origin: 'reviewAfterFix',
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
      origin: 'reviewAfterRejection',
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
    assertWorkflowTerminal('review', completed);
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
    expect(resumed?.prompt).not.toContain(
      '? ⟶\nWhich release target should govern?',
    );
    expect(resumed?.prompt).toContain(
      'Boss ⟶\nTarget version 6.0.0.',
    );
    for (const prompt of [resumed?.prompt, resumed?.options.freshPrompt]) {
      // Every round relays the request whole.
      expect(prompt).toContain('> Original request: Review the release commit.');
      if (scenario.origin === 'fixFindings') {
        expect(prompt).toContain(
          '> Reviewer findings: 1. The target is ambiguous.',
        );
      } else if (scenario.origin === 'reviewAfterFix') {
        expect(prompt).toContain(`> Latest commit: ${host.commitOids[0]}`);
        expect(prompt).toContain('> Coder output: Fixed and committed.');
      } else if (scenario.origin === 'reviewAfterRejection') {
        expect(prompt).toContain('> Coder output: Rejected with evidence.');
      }
    }
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
      // A fresh request enters through the start event, whose text the
      // runtime attaches as the new caller input; a Boss jump would re-run a
      // round with the retained input instead.
      judgeReplies: [
        '{"guard":"needsBossReply"}',
        '{"type":"START_REVIEW"}',
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
    assertWorkflowTerminal('review', completed);
    expect(playerCalls[1]?.prompt).toContain(
      '> Original request: Review the replacement commit instead.',
    );
    expect(playerCalls[1]?.prompt).not.toContain('Boss question:');
    expect(playerCalls[1]?.prompt).not.toContain('Boss ⟶');
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
    assertWorkflowTerminal('review', completed);
    expect(playerCalls[1]?.prompt).toContain('> Original request: Review the replacement commit.');
    expect(playerCalls[1]?.prompt).not.toContain('old release commit');
    expect(runtime.describe!().lastError).toBeUndefined();
    await runtime.dispose();
  });

  // playbook-13/-15: a resumed call that fails leaves its working state
  // without suspending for its own question, so neither the control view
  // nor the exported snapshot keeps the answered question or its reply.
  it.each([
    {
      role: 'Reviewer',
      playerResults: [
        {
          status: 'ok' as const,
          finalText: 'Which release target should govern?',
          resumeToken: 'reviewer-question',
        },
        { status: 'error' as const, error: 'reviewer transport failed' },
      ],
      judgeReplies: ['{"guard":"needsBossReply"}', '{"type":"BOSS_REPLY"}'],
      error: 'reviewer transport failed',
    },
    {
      role: 'Coder',
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
        { status: 'error' as const, error: 'coder transport failed' },
      ],
      judgeReplies: [
        '{"guard":"hasFindings"}',
        '{"guard":"needsBossReply"}',
        '{"type":"BOSS_REPLY"}',
      ],
      error: 'coder transport failed',
    },
  ])('drops the answered question when the resumed $role call fails', async (scenario) => {
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
    expect(parked.state.stateId).toBe('awaitBossReply');
    expect(runtime.describe!().pendingQuestions).toHaveLength(1);

    const failed = await runtime.handleBossInput({
      text: 'Target version 6.0.0.',
      signal: new AbortController().signal,
    });
    expect(failed.outcome).toBe('failed');
    expect(playerCalls.at(-1)?.prompt).toContain(
      'Boss ⟶\nTarget version 6.0.0.',
    );
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(view.pendingQuestions).toEqual([]);
    expect(view.lastError).toMatchObject({ message: scenario.error });
    const machine = runtime.exportSnapshot!()!.machine as {
      context: Record<string, unknown>;
    };
    expect(machine.context.pendingBossQuestion).toBeUndefined();
    expect(machine.context.bossReply).toBeUndefined();
    expect(machine.context.lastError).toMatchObject({ message: scenario.error });
    await runtime.dispose();
  });

  // DR-063: the compiled machine keeps a JSON-safe `{ name, message }`
  // record as its `lastError`, not the value the Reviewer's call threw, and
  // the runtime still publishes the cause it decided for that failure.
  it.each([
    ['a rejected Reviewer port', 'reject'],
    ['a non-`ok` Reviewer result', 'error'],
  ] as const)(
    'publishes %s as `player-failed` naming the Reviewer role and its player',
    async (_label, failure) => {
      const host = await harness({
        playerCalls: [],
        playerResults: [],
        judgeReplies: [],
      });
      const failedStatusData: unknown[] = [];
      const ports: PlaybookPorts = {
        ...host.ports,
        async callPlayer() {
          if (failure === 'reject') throw new Error('reviewer is down');
          return { status: 'error', error: 'reviewer is down' };
        },
        async emitStatus(message, data) {
          host.statuses.push(message);
          if (message.startsWith('◆ workflow failed')) {
            failedStatusData.push(data);
          }
        },
      };
      const runtime = linkedRuntime(host);
      await runtime.init(session(ports));

      const settled = await runtime
        .handleBossInput({
          text: 'Review the latest commit.',
          signal: new AbortController().signal,
        })
        .then(
          (result) => ({ result }),
          (rejection: unknown) => ({ rejection }),
        );

      const cause = {
        code: 'player-failed',
        evidence: {
          roleId: 'reviewer',
          playerId: 'reviewer',
          error: { name: 'Error', message: 'reviewer is down' },
        },
      };
      // A thrown port is a control-plane error, so that boundary rejects; a
      // non-`ok` result settles `failed` and carries the cause itself.
      if (failure === 'reject') {
        expect(settled).toMatchObject({
          rejection: { message: 'reviewer is down' },
        });
      } else {
        expect(settled).toMatchObject({
          result: { outcome: 'failed', error: { cause } },
        });
      }
      const view = runtime.describe!();
      expect(view.state.stateId).toBe('failed');
      expect(view.lastError).toMatchObject({
        name: 'Error',
        message: 'reviewer is down',
        cause,
      });
      expect(failedStatusData).toMatchObject([{ lastError: { cause } }]);
      expect(runtime.exportSnapshot!()!.machine).toMatchObject({
        context: {
          lastError: { name: 'Error', message: 'reviewer is down', cause },
        },
      });
      await runtime.dispose();
    },
  );

  it('counts only Reviewer review and rebuttal states as rounds', () => {
    expect(reviewStateCountLabels).toEqual({
      firstReview: 'review round',
      reviewAfterFix: 'review round',
      reviewAfterRejection: 'rebuttal',
    });
    // Each label keys a Reviewer round the linked runtime actually enters.
    for (const stateId of Object.keys(reviewStateCountLabels)) {
      expect(_internal.RESUMABLE_STATE_IDS.has(stateId), stateId).toBe(true);
    }
  });

  it('reports only the round-bound stop as an unfinished final state', () => {
    // playbook-62 / DR-102: the unsettled stop is a failure terminal, never
    // a completed review.
    expect(_internal.UNFINISHED_FINAL_STATE_IDS).toEqual(new Set(['unsettled']));
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
      stateId: 'reviewAfterFix',
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
