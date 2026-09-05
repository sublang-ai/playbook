// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPlaybookEffectLedger,
  emptyPlaybookEffectLedger,
} from '../../../src/xstate-runtime.js';

import createPlaybookRuntime, {
  type JsonValue,
  type PlaybookCallStart,
  type PlaybookPorts,
  type PlaybookSession,
  type PlayerResult,
} from './code.playbook.js';
import {
  codeCopyPasteGuardNames,
  codePlaybookRegistryEntry,
  codeStateCountLabels,
  validateCodeOptions,
} from './code.registry.js';
import { createRepositoryEffectCapabilities } from './bin/repository-effects.js';

const APPROVED = {
  evaluatedRevision: 'review-rev',
  noUnsettledFindings: true,
} as const;

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

interface Fixtures {
  players: PlayerFixture[];
  judges: unknown[];
  children: Array<PlaybookCallStart | Error>;
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
  const repo = await mkdtemp(join(tmpdir(), 'code-authority-'));
  tempDirs.push(repo);
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'user.name', 'CODE Authority Test');
  await git(repo, 'config', 'user.email', 'code@example.invalid');
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
              throw new Error('CODE test effect-ledger replacement is stale');
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
                'CODE test logical-operation replacement is stale',
              );
            }
            logicalOperations[index] = replacement.next;
          }
          continue;
        }
        throw new Error(`unsupported CODE test ledger command ${command.kind}`);
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

async function harness(fixtures: Partial<Fixtures> = {}) {
  const repo = await initRepository();
  const ledgerService = effectLedgerService();
  const players = [...(fixtures.players ?? [])];
  const judges = [...(fixtures.judges ?? [])];
  const children = [...(fixtures.children ?? [])];
  const playerCalls: Array<{
    playerId: string;
    prompt: string;
    resume: string | false;
  }> = [];
  const judgePrompts: string[] = [];
  const childRequests: Array<{
    callId: string;
    playbookId: string;
    text: string;
  }> = [];
  const statuses: string[] = [];
  const telemetry: Array<{ topic: string; payload: unknown }> = [];
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
      await commit(`phase ${effectIndex}.1`);
      await commit(`phase ${effectIndex}.2`);
      return;
    }
    if (effect === 'commit-all') {
      await git(repo, 'add', '--all');
      await git(repo, 'commit', '--quiet', '-m', `phase ${effectIndex}`);
      commitOids.push(await git(repo, 'rev-parse', 'HEAD'));
      return;
    }
    await commit(`phase ${effectIndex}`);
    if (effect === 'residual') {
      await writeFile(join(repo, `residual-${effectIndex}.txt`), 'residual\n');
    }
  };
  const ports: PlaybookPorts = {
    async callPlayer(playerId, prompt, _signal, options) {
      playerCalls.push({ playerId, prompt, resume: options.resume });
      const fixture = players.shift();
      if (fixture === undefined) throw new Error('missing player fixture');
      const { repositoryEffect = 'commit', ...result } = fixture;
      await applyRepositoryEffect(repositoryEffect);
      return result;
    },
    async callCaptain() {
      throw new Error('CODE has no direct Captain state');
    },
    async callJudge(prompt) {
      judgePrompts.push(prompt);
      if (judges.length === 0) throw new Error('missing judge fixture');
      return JSON.stringify(judges.shift());
    },
    async callPlaybook(request) {
      childRequests.push(request);
      const start = children.shift();
      if (start === undefined) throw new Error('missing child fixture');
      if (start instanceof Error) throw start;
      return start;
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
      code: {
        id: 'code',
        artifactSchema: 3,
        requiredRoleIds: ['coder'],
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
    playerCalls,
    judgePrompts,
    childRequests,
    statuses,
    telemetry,
    commitOids,
    effectLedger: ledgerService,
    hostCapabilities: capabilities.code,
  };
}

type CodeHarness = Awaited<ReturnType<typeof harness>>;

function linkedRuntime(host: CodeHarness, options: unknown = {}) {
  return createPlaybookRuntime({
    configuredOptions: options,
    hostCapabilities: host.hostCapabilities,
  });
}

function acceptedOutcomes(host: CodeHarness): unknown[] {
  return host.telemetry
    .filter(({ topic }) => topic === 'playbook.trace')
    .map(({ payload }) => payload as { type?: string; payload?: unknown })
    .filter(({ type }) => type === 'outcome.accepted')
    .map(({ payload }) => payload);
}

function rootSession(ports: PlaybookPorts): PlaybookSession {
  return {
    sessionId: '40000000-0000-4000-8000-000000000001',
    playbookId: 'code',
    rootSessionId: '40000000-0000-4000-8000-000000000001',
    depth: 0,
    roleBindings: {
      coder: { playerId: 'coder', promptIdentity: 'GPT-5.6 Sol' },
    },
    ports,
  };
}

function approvedChild(index: number): PlaybookCallStart {
  return {
    state: 'settled',
    result: {
      status: 'ok',
      playbookId: 'review',
      childSessionId: `review-${index}`,
      output: APPROVED,
    },
  };
}

describe('linked CODE runtime', () => {
  it('leaves review-round counting to the nested REVIEW playbook', () => {
    expect(codeStateCountLabels).toEqual({});
    expect(codeCopyPasteGuardNames).toEqual([
      'directCommit',
      'irCommit',
      'moreTasks',
      'finalTask',
    ]);
  });

  it('advertises the schema-3 local-role manifest', async () => {
    const host = await harness();
    expect(codePlaybookRegistryEntry).toMatchObject({
      artifactSchema: 3,
      runtimeProfile: {
        kind: 'shared-factory',
        compat: { artifactSchema: 3, runtimeAbi: 1 },
      },
      requiredRoleIds: ['coder'],
      concurrentRoleSets: [],
    });
    expect(codePlaybookRegistryEntry.runtimeProfile.compat).toBe(
      createPlaybookRuntime.compat,
    );
    expect(
      codePlaybookRegistryEntry.createRuntime(
        validateCodeOptions({}),
        host.hostCapabilities,
      ),
    ).toBeDefined();
  });

  it('runs one direct commit and calls REVIEW with exact quoted context', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'Tests passed.',
          resumeToken: 'coder-1',
        },
      ],
      judges: [{ guard: 'directCommit' }],
      children: [approvedChild(1)],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix the bug.\nPreserve compatibility.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      "The coding workflow completed after every phase's REVIEW passed with no unsettled findings.",
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'complete',
      lastCodeCommit: host.commitOids[0],
      finalEvaluatedRevision: 'review-rev',
      allReviewsPassed: true,
    });
    expect(host.playerCalls).toHaveLength(1);
    expect(host.playerCalls[0]).toMatchObject({
      playerId: 'coder',
      resume: false,
    });
    expect(host.playerCalls[0]?.prompt).toContain(
      '> Fix the bug.\n> Preserve compatibility.',
    );
    expect(host.playerCalls[0]?.prompt).toContain('Coder is GPT-5.6 Sol.');
    expect(host.playerCalls[0]?.prompt).not.toContain('`Commit: `');
    expect(host.childRequests).toHaveLength(1);
    expect(host.childRequests[0]).toMatchObject({
      playbookId: 'review',
      text:
        '> Original intent: Fix the bug.\n' +
        '> Preserve compatibility.\n' +
        `> Review scope: the commit ${host.commitOids[0]} from this coding phase and its resulting repository state.\n` +
        '> Coder output: Tests passed.',
    });
    expect(host.statuses).toContain('→ directCommit');
    expect(acceptedOutcomes(host)).toContainEqual({
      source: 'runFirstPhase',
      target: 'reviewFirstCommit',
      acceptedOutcome: 'directCommit',
    });
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('done');
    expect(view.stateDescription).toBe(
      "The coding workflow completed after every phase's REVIEW passed with no unsettled findings.",
    );
    await runtime.dispose();
  });

  it.each([
    ['missing', 'Finished successfully.'],
    ['glued', 'Finished. Commit:abc123'],
    ['fenced', '```\nCommit: abc123\n```'],
    ['quoted', '> Commit: abc123'],
    ['duplicated', 'Commit: first\nCommit: second'],
    ['misleading', 'Commit: definitely-not-the-observed-oid'],
  ])(
    'ignores %s Commit prose when effect evidence proves the commit',
    async (_label, finalText) => {
      const host = await harness({
        players: [{ status: 'ok', finalText }],
        judges: [{ guard: 'directCommit' }],
        children: [approvedChild(1)],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(rootSession(host.ports));

      const result = await runtime.handleBossInput({
        text: 'Fix it.',
        signal: new AbortController().signal,
      });

      expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
        status: 'complete',
        lastCodeCommit: host.commitOids[0],
        finalEvaluatedRevision: 'review-rev',
        allReviewsPassed: true,
      });
      expect(host.commitOids[0]).toMatch(/^[0-9a-f]{40}$/);
      expect(host.childRequests).toHaveLength(1);
      await runtime.dispose();
    },
  );

  it('rejects a semantic attempt to supply effect-owned latestCommit', async () => {
    const forged = { guard: 'directCommit', latestCommit: 'f'.repeat(40) };
    const host = await harness({
      players: [{ status: 'ok', finalText: 'Finished.' }],
      judges: [forged, forged],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
      'reconcile:unresolved-effect',
      'abandon:unresolved-effect',
    ]);
    expect(host.judgePrompts).toHaveLength(2);
    expect(host.childRequests).toEqual([]);
    expect(host.statuses).not.toContain('→ directCommit');
    await runtime.dispose();
  });

  // DR-040 §4 / PBRT-77: an `unchanged` receipt excludes any effect, so a
  // claimed commit over it is an ordinary failure with the ordinary retry —
  // never a parked reconciliation, whose reconcile would be a no-op and
  // whose abandonment would have no effect evidence to record.
  it('fails a directCommit candidate over unchanged repository evidence into the ordinary retryable failure', async () => {
    const host = await harness({
      players: [
        { status: 'ok', finalText: 'Finished.', repositoryEffect: 'unchanged' },
      ],
      judges: [{ guard: 'directCommit' }],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
      'retry:START_CODE',
    ]);
    expect(runtime.unresolvedEffectEnvelopes?.()).toEqual([]);
    expect(host.childRequests).toEqual([]);
    expect(host.effectLedger.snapshot().boundaries[0]?.physicalReceipt)
      .toMatchObject({ classification: 'unchanged' });
    expect(host.statuses).not.toContain('→ directCommit');
    await runtime.dispose();
  });

  it.each([
    ['worktree', 'worktree-only-change'],
    ['multiple', 'multiple-commits'],
    ['rewritten', 'rewritten-or-non-descendant'],
    ['residual', 'observation-ambiguous'],
  ] as const)(
    'parks a directCommit candidate for %s repository evidence',
    async (repositoryEffect, classification) => {
      const host = await harness({
        players: [
          { status: 'ok', finalText: 'Finished.', repositoryEffect },
        ],
        judges: [{ guard: 'directCommit' }],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(rootSession(host.ports));

      const result = await runtime.handleBossInput({
        text: 'Fix it.',
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        outcome: 'failed',
        state: { stateId: 'failed' },
      });
      expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
        'reconcile:unresolved-effect',
        'abandon:unresolved-effect',
      ]);
      expect(host.childRequests).toEqual([]);
      expect(host.effectLedger.snapshot().boundaries[0]?.physicalReceipt)
        .toMatchObject({ classification });
      expect(host.statuses).not.toContain('→ directCommit');
      await runtime.dispose();
    },
  );

  it('keeps one Coder conversation through an IR-task Boss question', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'Created IR-040.',
          resumeToken: 'coder-1',
        },
        {
          status: 'ok',
          finalText: 'Which compatibility boundary should I use?',
          resumeToken: 'coder-question',
          repositoryEffect: 'worktree',
        },
        {
          status: 'ok',
          finalText: 'Completed task 1.',
          resumeToken: 'coder-2',
          repositoryEffect: 'commit-all',
        },
        {
          status: 'ok',
          finalText: 'Completed task 2.',
          resumeToken: 'coder-3',
        },
      ],
      judges: [
        {
          guard: 'irCommit',
          irNumber: '040',
        },
        {
          guard: 'needsBossReply',
        },
        { type: 'BOSS_REPLY' },
        {
          guard: 'moreTasks',
          irNumber: '040',
          irTask: 'Implement task 1.',
        },
        {
          guard: 'finalTask',
          irNumber: '040',
          irTask: 'Implement task 2.',
        },
      ],
      children: [approvedChild(1), approvedChild(2), approvedChild(3)],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const parked = await runtime.handleBossInput({
      text: 'Implement the large change.',
      signal: new AbortController().signal,
    });
    expect(parked.outcome).toBe('quiescent');
    expect(host.effectLedger.snapshot().logicalOperations[0]).toMatchObject({
      pendingQuestion: {
        question: 'Which compatibility boundary should I use?',
      },
    });

    const result = await runtime.handleBossInput({
      text: 'Preserve the narrow compatibility boundary.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      "The coding workflow completed after every phase's REVIEW passed with no unsettled findings.",
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'complete',
      lastCodeCommit: host.commitOids[2],
      finalEvaluatedRevision: 'review-rev',
      allReviewsPassed: true,
    });
    expect(host.playerCalls.map(({ resume }) => resume)).toEqual([
      false,
      'coder-1',
      'coder-question',
      'coder-2',
    ]);
    expect(host.playerCalls[1]?.prompt).toContain(
      '> Implement the large change.\n> 040\n\nRead the identified IR',
    );
    expect(host.playerCalls[2]?.prompt).toContain(
      'Boss question:\nWhich compatibility boundary should I use?\n\n' +
        'Boss reply:\nPreserve the narrow compatibility boundary.',
    );
    expect(host.playerCalls[3]?.prompt).toContain(
      '> Implement the large change.\n> 040\n\nRead the identified IR',
    );
    expect(host.childRequests.map(({ text }) => text)).toEqual([
      '> Original intent: Implement the large change.\n' +
        `> Review scope: the commit ${host.commitOids[0]} from this coding phase and its resulting repository state.\n` +
        '> Coder output: Created IR-040.',
      '> Original intent: Implement the large change.\n' +
        `> Review scope: the commit ${host.commitOids[1]} from this coding phase and its resulting repository state.\n` +
        '> Coder output: Completed task 1.\n' +
        '> Current IR task: Implement task 1.',
      '> Original intent: Implement the large change.\n' +
        `> Review scope: the commit ${host.commitOids[2]} from this coding phase and its resulting repository state.\n` +
        '> Coder output: Completed task 2.\n' +
        '> Current IR task: Implement task 2.',
    ]);
    expect(host.commitOids).toHaveLength(3);
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'runFirstPhase',
        target: 'reviewFirstCommit',
        acceptedOutcome: 'irCommit',
      },
      {
        source: 'runIrTask',
        target: 'awaitBossReply',
        acceptedOutcome: 'needsBossReply',
      },
      {
        source: 'runIrTask',
        target: 'reviewIrTask',
        acceptedOutcome: 'moreTasks',
      },
      {
        source: 'runIrTask',
        target: 'reviewIrTask',
        acceptedOutcome: 'finalTask',
      },
    ]);
    await runtime.dispose();
  });

  it('suspends on REVIEW and validates its exact approval on resume', async () => {
    const host = await harness({
      players: [{ status: 'ok', finalText: 'Committed.' }],
      judges: [{ guard: 'directCommit' }],
      children: [
        { state: 'suspended', childSessionId: 'review-suspended' },
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));
    const suspended = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });
    expect(suspended.outcome).toBe('suspended');
    if (suspended.outcome !== 'suspended') throw new Error('expected suspension');

    const resumed = await runtime.resumePlaybookCall({
      callId: suspended.pendingCall.callId,
      signal: new AbortController().signal,
      result: {
        status: 'ok',
        playbookId: 'review',
        childSessionId: 'review-suspended',
        output: APPROVED,
      },
    });
    expect(resumed.outcome).toBe('terminal');
    await runtime.dispose();
  });

  it('reports valid REVIEW abort/error results with the last CODE evidence', async () => {
    const host = await harness({
      players: [{ status: 'ok', finalText: 'Committed.' }],
      judges: [{ guard: 'directCommit' }],
      children: [
        {
          state: 'settled',
          result: {
            status: 'error',
            playbookId: 'review',
            childSessionId: 'review-error',
            error: { name: 'ReviewError', message: 'Reviewer unavailable.' },
          },
        },
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));
    const result = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('terminal');
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      'The coding workflow reported a REVIEW failure and the last code-owned commit.',
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'review-failed',
      lastCodeCommit: host.commitOids[0],
      error: { name: 'ReviewError', message: 'Reviewer unavailable.' },
    });
    expect(host.playerCalls).toHaveLength(1);
    // A host with no access to the run output quotes this published meaning to
    // report the outcome, so it must not read as an approval.
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('reportedReviewFailure');
    expect(view.stateDescription).toBe(
      'The coding workflow reported a REVIEW failure and the last code-owned commit.',
    );
    await runtime.dispose();
  });

  it('parks a raw nested-call rejection with the committed phase visible', async () => {
    const host = await harness({
      players: [{ status: 'ok', finalText: 'Committed.' }],
      judges: [{ guard: 'directCommit' }],
      children: [new Error('nested REVIEW bridge failed')],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    await expect(
      runtime.handleBossInput({
        text: 'Fix it.',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('nested REVIEW bridge failed');
    expect(host.playerCalls).toHaveLength(1);
    expect(host.childRequests).toHaveLength(1);
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(view.lastError).toMatchObject({
      name: 'Error',
      message: 'nested REVIEW bridge failed',
    });
    expect(view.context).toEqual({ phase: 'direct' });
    await runtime.dispose();
  });

  it('reports the new-IR commit and starts no task after REVIEW fails', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'Created IR-041.',
          resumeToken: 'coder-ir',
        },
      ],
      judges: [
        {
          guard: 'irCommit',
          irNumber: '041',
        },
      ],
      children: [
        {
          state: 'settled',
          result: {
            status: 'error',
            playbookId: 'review',
            childSessionId: 'review-ir-error',
            error: { name: 'ReviewError', message: 'IR review failed.' },
          },
        },
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Implement a large change.',
      signal: new AbortController().signal,
    });

    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'review-failed',
      lastCodeCommit: host.commitOids[0],
      error: { name: 'ReviewError', message: 'IR review failed.' },
    });
    expect(host.playerCalls).toHaveLength(1);
    expect(host.childRequests).toHaveLength(1);
    await runtime.dispose();
  });

  it('reports the current task commit and starts no next task after REVIEW fails', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'Created IR-041.',
          resumeToken: 'coder-ir',
        },
        {
          status: 'ok',
          finalText: 'Completed task 1.',
          resumeToken: 'coder-task-1',
        },
      ],
      judges: [
        {
          guard: 'irCommit',
          irNumber: '041',
        },
        {
          guard: 'moreTasks',
          irNumber: '041',
          irTask: 'Implement task 1.',
        },
      ],
      children: [
        approvedChild(1),
        {
          state: 'settled',
          result: {
            status: 'error',
            playbookId: 'review',
            childSessionId: 'review-task-error',
            error: { name: 'ReviewError', message: 'Task review failed.' },
          },
        },
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Implement a large change.',
      signal: new AbortController().signal,
    });

    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'review-failed',
      lastCodeCommit: host.commitOids[1],
      error: { name: 'ReviewError', message: 'Task review failed.' },
    });
    expect(host.playerCalls).toHaveLength(2);
    expect(host.childRequests).toHaveLength(2);
    await runtime.dispose();
  });

  it('treats an invalid REVIEW success result as terminal failure', async () => {
    const host = await harness({
      players: [{ status: 'ok', finalText: 'Committed.' }],
      judges: [{ guard: 'directCommit' }],
      children: [
        {
          state: 'settled',
          result: {
            status: 'ok',
            playbookId: 'review',
            childSessionId: 'review-invalid',
            output: { approvedCommit: 'old', noUnsettledFindings: true },
          },
        },
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));
    const result = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('terminal');
    const output = result.outcome === 'terminal' ? result.output : undefined;
    expect(output).toMatchObject({
      status: 'review-failed',
      lastCodeCommit: host.commitOids[0],
      error: { name: 'ReviewContractError' },
    });
    await runtime.dispose();
  });

  it('resumes the same Coder state with a quoted Boss answer', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'Which branch should I use?',
          resumeToken: 'coder-question',
          repositoryEffect: 'worktree',
        },
        {
          status: 'ok',
          finalText: 'Committed after the answer.',
          resumeToken: 'coder-done',
          repositoryEffect: 'commit-all',
        },
      ],
      judges: [
        { guard: 'needsBossReply' },
        { type: 'BOSS_REPLY' },
        { guard: 'directCommit' },
      ],
      children: [approvedChild(1)],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));
    const parked = await runtime.handleBossInput({
      text: 'Implement it.',
      signal: new AbortController().signal,
    });
    expect(parked.outcome).toBe('quiescent');
    const openOperation = host.effectLedger.snapshot().logicalOperations[0];
    expect(openOperation).toMatchObject({
      originalBaseline: { projection: {} },
      checkpoint: {
        projection: {
          'effect-1.txt': expect.any(Object),
        },
      },
      pendingQuestion: { question: 'Which branch should I use?' },
    });
    expect(host.childRequests).toEqual([]);

    const completed = await runtime.handleBossInput({
      text: 'Use the narrow branch.',
      signal: new AbortController().signal,
    });
    expect(completed.outcome).toBe('terminal');
    expect(
      completed.outcome === 'terminal' ? completed.output : undefined,
    ).toMatchObject({ lastCodeCommit: host.commitOids[0] });
    expect(host.playerCalls.map(({ resume }) => resume)).toEqual([
      false,
      'coder-question',
    ]);
    expect(host.playerCalls[1]?.prompt).toContain(
      'Boss question:\nWhich branch should I use?\n\n' +
        'Boss reply:\nUse the narrow branch.',
    );
    expect(host.effectLedger.snapshot().logicalOperations[0]).toMatchObject({
      operationId: openOperation?.operationId,
      originalBaseline: openOperation?.originalBaseline,
      logicalReceipt: {
        classification: 'one-descendant-commit',
        commitOid: host.commitOids[0],
      },
    });
    expect(host.statuses).toEqual(
      expect.arrayContaining(['→ needsBossReply', '→ directCommit']),
    );
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'runFirstPhase',
        target: 'awaitBossReply',
        acceptedOutcome: 'needsBossReply',
      },
      {
        source: 'runFirstPhase',
        target: 'reviewFirstCommit',
        acceptedOutcome: 'directCommit',
      },
    ]);
    await runtime.dispose();
  });

  it('validates and snapshots the small runtime option surface', async () => {
    const host = await harness();
    expect(() => linkedRuntime(host, { extra: true })).toThrow(
      'CODE runtime options.extra is not declared',
    );
    expect(() => linkedRuntime(host, { runResults: 5 })).toThrow(
      'CODE runtime options.runResults must be a string',
    );
    const mutable = { runResults: 'previous verification' };
    const runtime = linkedRuntime(host, mutable);
    mutable.runResults = 'changed';
    expect(runtime).toBeDefined();
  });

  it('emits a complete trace pair around every nested REVIEW call', async () => {
    const host = await harness({
      players: [{ status: 'ok', finalText: 'Committed.' }],
      judges: [{ guard: 'directCommit' }],
      children: [approvedChild(1)],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));
    await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });
    const trace = host.telemetry
      .filter(({ topic }) => topic === 'playbook.trace')
      .map(({ payload }) => payload as { type?: string; payload?: JsonValue });
    expect(trace.filter(({ type }) => type === 'playbook.call.started')).toHaveLength(1);
    expect(trace.filter(({ type }) => type === 'playbook.call.finished')).toHaveLength(1);
    await runtime.dispose();
  });
});
