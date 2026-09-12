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
  type PlaybookPorts,
  type PlaybookSession,
  type PlayerResult,
} from './branch.playbook.js';
import branchPlaybookRegistryEntry, {
  branchCopyPasteGuardNames,
  branchStateCountLabels,
  validateBranchOptions,
} from './branch.registry.js';
import { createRepositoryEffectCapabilities } from '../code.playbook/bin/repository-effects.js';

const BRANCH_NAME = 'issue-12-fix-retry';
const ISSUE_SUMMARY =
  'Issue #12: the retry loop never backs off; two comments ask for jitter.';
const BRANCHED_REPLY = {
  guard: 'branched',
  branch: BRANCH_NAME,
  issueSummary: ISSUE_SUMMARY,
} as const;
const BRANCHED_DESCRIPTION =
  "A new branch for the request is checked out at the caller's current commit; no file changed and no commit was made.";
const REFUSED_DESCRIPTION =
  'No branch was created: Coder reported the obstacle with its reason — a dirty working tree, an unauthenticated `gh`, an unreadable issue, or a branch-name collision.';

type RepositoryEffect = 'unchanged' | 'branch' | 'commit' | 'worktree';

type PlayerFixture = PlayerResult & {
  readonly repositoryEffect?: RepositoryEffect;
};

interface Fixtures {
  players: PlayerFixture[];
  judges: unknown[];
  /** Non-ignored untracked dirt present before the run begins. */
  dirty: boolean;
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
  const repo = await mkdtemp(join(tmpdir(), 'branch-authority-'));
  tempDirs.push(repo);
  await git(repo, 'init', '--quiet', '--initial-branch=main');
  await git(repo, 'config', 'user.name', 'BRANCH Authority Test');
  await git(repo, 'config', 'user.email', 'branch@example.invalid');
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
              throw new Error('BRANCH test effect-ledger replacement is stale');
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
                'BRANCH test logical-operation replacement is stale',
              );
            }
            logicalOperations[index] = replacement.next;
          }
          continue;
        }
        throw new Error(`unsupported BRANCH test ledger command ${command.kind}`);
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
  if (fixtures.dirty === true) {
    await writeFile(join(repo, 'scratch.txt'), 'pre-existing dirt\n', 'utf8');
  }
  const baseCommit = await git(repo, 'rev-parse', 'HEAD');
  const ledgerService = effectLedgerService();
  const players = [...(fixtures.players ?? [])];
  const judges = [...(fixtures.judges ?? [])];
  const playerCalls: Array<{
    playerId: string;
    prompt: string;
    resume: string | false;
    freshPrompt?: string;
  }> = [];
  const judgePrompts: string[] = [];
  const statuses: string[] = [];
  const telemetry: Array<{ topic: string; payload: unknown }> = [];
  let effectIndex = 0;
  const applyRepositoryEffect = async (
    effect: RepositoryEffect,
  ): Promise<void> => {
    effectIndex += 1;
    if (effect === 'unchanged') return;
    if (effect === 'branch') {
      // The real branching effect: a new branch at HEAD, checked out. It
      // moves only the symbolic ref, so the receipt must still prove
      // `unchanged` (DR-040 compares HEAD by OID and excludes Git
      // administrative data from the projection).
      await git(repo, 'checkout', '--quiet', '-b', BRANCH_NAME);
      return;
    }
    if (effect === 'worktree') {
      await writeFile(join(repo, `effect-${effectIndex}.txt`), 'changed\n');
      return;
    }
    await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'branching');
  };
  const ports: PlaybookPorts = {
    async callPlayer(playerId, prompt, _signal, options) {
      playerCalls.push({
        playerId,
        prompt,
        resume: options.resume,
        ...(options.freshPrompt === undefined
          ? {}
          : { freshPrompt: options.freshPrompt }),
      });
      const fixture = players.shift();
      if (fixture === undefined) throw new Error('missing player fixture');
      // BRANCH owns no repository commit, so fixtures default to the
      // unchanged repository the governed disposition requires.
      const { repositoryEffect = 'unchanged', ...result } = fixture;
      await applyRepositoryEffect(repositoryEffect);
      return result;
    },
    async callCaptain() {
      throw new Error('BRANCH has no direct Captain state');
    },
    async callJudge(prompt) {
      judgePrompts.push(prompt);
      if (judges.length === 0) throw new Error('missing judge fixture');
      return JSON.stringify(judges.shift());
    },
    async callPlaybook() {
      throw new Error('BRANCH must not call another playbook');
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
      branch: {
        id: 'branch',
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
    repo,
    baseCommit,
    ports,
    playerCalls,
    judgePrompts,
    statuses,
    telemetry,
    effectLedger: ledgerService,
    hostCapabilities: capabilities.branch,
  };
}

type BranchHarness = Awaited<ReturnType<typeof harness>>;

function linkedRuntime(host: BranchHarness, options: unknown = {}) {
  return createPlaybookRuntime({
    configuredOptions: options,
    hostCapabilities: host.hostCapabilities,
  });
}

function acceptedOutcomes(host: BranchHarness): unknown[] {
  return host.telemetry
    .filter(({ topic }) => topic === 'playbook.trace')
    .map(({ payload }) => payload as { type?: string; payload?: unknown })
    .filter(({ type }) => type === 'outcome.accepted')
    .map(({ payload }) => payload);
}

function receiptClassifications(host: BranchHarness): readonly (string | undefined)[] {
  return host.effectLedger
    .snapshot()
    .boundaries.map(({ physicalReceipt }) => physicalReceipt?.classification);
}

function rootSession(ports: PlaybookPorts): PlaybookSession {
  return {
    sessionId: '40000000-0000-4000-8000-000000000001',
    playbookId: 'branch',
    rootSessionId: '40000000-0000-4000-8000-000000000001',
    depth: 0,
    roleBindings: {
      coder: { playerId: 'dev.coder', promptIdentity: 'GPT-5.6 Sol' },
    },
    ports,
  };
}

describe('linked BRANCH runtime', () => {
  it('labels only the branching round BRANCH itself owns', () => {
    expect(branchStateCountLabels).toEqual({ createBranch: 'branching round' });
    expect(branchCopyPasteGuardNames).toEqual(['branched']);
  });

  it('advertises the schema-3 local-role manifest', async () => {
    const host = await harness();
    expect(branchPlaybookRegistryEntry).toMatchObject({
      id: 'branch',
      command: 'branch',
      artifactSchema: 3,
      runtimeProfile: {
        kind: 'shared-factory',
        compat: { artifactSchema: 3, runtimeAbi: 1 },
      },
      requiredRoleIds: ['coder'],
      concurrentRoleSets: [],
    });
    expect(branchPlaybookRegistryEntry.runtimeProfile.compat).toBe(
      createPlaybookRuntime.compat,
    );
    expect(validateBranchOptions(undefined)).toEqual({});
    expect(() => validateBranchOptions({ extra: 1 })).toThrow(
      'captain.options.playbooks.branch.options.extra',
    );
    expect(
      branchPlaybookRegistryEntry.createRuntime(
        validateBranchOptions({}),
        host.hostCapabilities,
      ),
    ).toBeDefined();
    expect(() => linkedRuntime(host, { cwd: host.repo })).toThrow(
      /runtime options\.cwd is not declared/,
    );
  });

  it.each([
    ['a clean tree', false],
    ['byte-identical pre-existing dirt', true],
  ])(
    'branches under an unchanged receipt over %s and returns the receipt-observed base revision',
    async (_label, dirty) => {
      const host = await harness({
        dirty,
        players: [
          {
            status: 'ok',
            finalText:
              `Created and checked out ${BRANCH_NAME} from the current commit.\n${ISSUE_SUMMARY}`,
            resumeToken: 'coder-1',
            repositoryEffect: 'branch',
          },
        ],
        judges: [BRANCHED_REPLY],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(rootSession(host.ports));

      const result = await runtime.handleBossInput({
        text: 'Fix #12.\nKeep the CLI stable.',
        signal: new AbortController().signal,
      });

      expect(result.outcome).toBe('terminal');
      if (result.outcome !== 'terminal') throw new Error('expected terminal');
      expect(result.stateDescription).toBe(BRANCHED_DESCRIPTION);
      // DR-048: the reached final state's compiled kind is the run's
      // published outcome, read from the artifact rather than any reply.
      expect(result.terminal).toEqual({
        stateId: 'branched',
        kind: 'success',
        description: BRANCHED_DESCRIPTION,
      });
      // DR-045: the base revision is the unchanged receipt's observed HEAD —
      // the judge reply named no revision, so only the receipt can supply it.
      expect(result.output).toEqual({
        status: 'branched',
        branch: BRANCH_NAME,
        baseRevision: host.baseCommit,
        issueSummary: ISSUE_SUMMARY,
      });
      expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
        BRANCH_NAME,
      );
      expect(await git(host.repo, 'rev-parse', 'HEAD')).toBe(host.baseCommit);
      expect(host.playerCalls).toHaveLength(1);
      // The port receives the canonical local role id; the host binding maps
      // it to the stable `dev.coder` player.
      expect(host.playerCalls[0]).toMatchObject({
        playerId: 'coder',
        resume: false,
      });
      expect(host.playerCalls[0]?.prompt).toContain(
        '> Original request: Fix #12.\n> Keep the CLI stable.',
      );
      expect(host.playerCalls[0]?.prompt).toContain(
        'Prepare a new branch for this work without changing any file or making any commit.',
      );
      expect(host.playerCalls[0]?.prompt).toContain(
        'Create the branch from the current commit and check it out; do not pull, reset, stash, or move HEAD to another commit.',
      );
      expect(host.playerCalls[0]?.prompt).not.toContain('Output shall include');
      // The judge is asked for the guard and the two semantic fields only;
      // the effect-owned base revision is named as runtime-supplied.
      expect(host.judgePrompts).toHaveLength(1);
      expect(host.judgePrompts[0]).toContain(
        '{ "guard": "branched", "branch": <exact branch name>, "issueSummary": <concise summary> }',
      );
      expect(host.judgePrompts[0]).toContain('`baseRevision` (effect-owned)');
      expect(host.judgePrompts[0]).toContain('`coderOutput` (presentation-owned)');
      expect(host.statuses).toContain('→ branched');
      expect(acceptedOutcomes(host)).toEqual([
        {
          source: 'createBranch',
          target: 'branched',
          acceptedOutcome: 'branched',
        },
      ]);
      expect(receiptClassifications(host)).toEqual(['unchanged']);
      expect(host.effectLedger.snapshot().logicalOperations).toEqual([]);
      const view = runtime.describe!();
      expect(view.state.stateId).toBe('branched');
      expect(view.stateDescription).toBe(BRANCHED_DESCRIPTION);
      await runtime.dispose();
    },
  );

  it("refuses under an unchanged receipt and relays Coder's complete report", async () => {
    const report =
      'The working tree is not clean: base.txt has unstaged changes.\nNothing was created.';
    const host = await harness({
      players: [{ status: 'ok', finalText: report, resumeToken: 'coder-1' }],
      judges: [{ guard: 'refused' }],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix #12.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    if (result.outcome !== 'terminal') throw new Error('expected terminal');
    expect(result.stateDescription).toBe(REFUSED_DESCRIPTION);
    expect(result.terminal).toEqual({
      stateId: 'refused',
      kind: 'failure',
      description: REFUSED_DESCRIPTION,
    });
    // The verbatim report is runtime-owned: the judge reply carried the
    // guard alone and the player's canonical final text fills the field.
    expect(result.output).toEqual({ status: 'refused', coderOutput: report });
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(host.judgePrompts[0]).toContain('{ "guard": "refused" }');
    expect(host.statuses).toContain('→ refused');
    expect(acceptedOutcomes(host)).toEqual([
      { source: 'createBranch', target: 'refused', acceptedOutcome: 'refused' },
    ]);
    expect(receiptClassifications(host)).toEqual(['unchanged']);
    expect(runtime.describe!().state.stateId).toBe('refused');
    await runtime.dispose();
  });

  // Under BRANCH's all-`unchanged` authority, any repository delta during the
  // branching call — a commit or a bare worktree edit alike — is change the
  // declared disposition cannot own, so it classifies as foreign and parks.
  it.each([
    ['commit', 'concurrent-or-foreign-change'],
    ['worktree', 'concurrent-or-foreign-change'],
  ] as const)(
    'parks a branching call that mutates the repository (%s) as unresolved',
    async (repositoryEffect, classification) => {
      const host = await harness({
        players: [
          {
            status: 'ok',
            finalText: `Created ${BRANCH_NAME} and touched files.`,
            repositoryEffect,
          },
        ],
        judges: [BRANCHED_REPLY],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(rootSession(host.ports));

      const result = await runtime.handleBossInput({
        text: 'Fix #12.',
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
      expect(receiptClassifications(host)).toEqual([classification]);
      expect(acceptedOutcomes(host)).toEqual([]);
      expect(host.statuses).not.toContain('→ branched');
      await runtime.dispose();
    },
  );

  it('rejects a judge-authored base revision instead of trusting prose', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: `Created ${BRANCH_NAME} from deadbeef.`,
          resumeToken: 'coder-1',
          repositoryEffect: 'branch',
        },
      ],
      // The candidate may carry only the guard plus semantic-owned fields; a
      // judge-supplied baseRevision is a structural error, and the one
      // corrective adjudication repeats it, so no outcome is accepted.
      judges: [
        { ...BRANCHED_REPLY, baseRevision: 'deadbeef' },
        { ...BRANCHED_REPLY, baseRevision: 'deadbeef' },
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix #12.',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
    });
    expect(host.playerCalls).toHaveLength(1);
    expect(host.judgePrompts).toHaveLength(2);
    expect(acceptedOutcomes(host)).toEqual([]);
    expect(host.statuses).not.toContain('→ branched');
    // The receipt proves `unchanged`, so the unresolved adjudication is an
    // ordinary retryable failure rather than a parked effect envelope.
    expect(receiptClassifications(host)).toEqual(['unchanged']);
    expect(runtime.unresolvedEffectEnvelopes?.()).toEqual([]);
    expect(runtime.describe?.().actions.map(({ id }) => id)).toEqual([
      'retry:START_BRANCH',
    ]);
    await runtime.dispose();
  });

  it.each([true, false])(
    'asks Boss about an ambiguous request and resumes the same Coder conversation (resumed=%s)',
    async (resumed) => {
      const question =
        'The request could refer to issue #12 or #14. Which one should I branch for?';
      const host = await harness({
        players: [
          {
            status: 'ok',
            finalText: question,
            ...(resumed ? { resumeToken: 'coder-question' } : {}),
          },
          {
            status: 'ok',
            finalText: `Created and checked out ${BRANCH_NAME}.\n${ISSUE_SUMMARY}`,
            resumeToken: 'coder-branched',
            repositoryEffect: 'branch',
          },
        ],
        judges: [
          { guard: 'needsBossReply' },
          { type: 'BOSS_REPLY' },
          BRANCHED_REPLY,
        ],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(rootSession(host.ports));

      const parked = await runtime.handleBossInput({
        text: 'Branch for the retry issue.',
        signal: new AbortController().signal,
      });
      expect(parked.outcome).toBe('quiescent');
      expect(parked.state.stateId).toBe('awaitBossReply');
      expect(acceptedOutcomes(host)).toEqual([
        {
          source: 'createBranch',
          target: 'awaitBossReply',
          acceptedOutcome: 'needsBossReply',
        },
      ]);
      // The Coder question is governed `unchanged`, not `deferred`: no
      // checkpoint-bound logical operation opens for it.
      expect(host.effectLedger.snapshot().logicalOperations).toEqual([]);
      expect(receiptClassifications(host)).toEqual(['unchanged']);

      const result = await runtime.handleBossInput({
        text: 'Issue #12.',
        signal: new AbortController().signal,
      });

      expect(result.outcome).toBe('terminal');
      if (result.outcome !== 'terminal') throw new Error('expected terminal');
      expect(result.output).toEqual({
        status: 'branched',
        branch: BRANCH_NAME,
        baseRevision: host.baseCommit,
        issueSummary: ISSUE_SUMMARY,
      });
      expect(host.playerCalls.map(({ resume }) => resume)).toEqual([
        false,
        resumed ? 'coder-question' : false,
      ]);
      const prompt = host.playerCalls[1]!.prompt;
      expect(prompt).toContain('Boss reply:\nIssue #12.');
      expect(prompt).toContain(
        '> Original request: Branch for the retry issue.',
      );
      expect(prompt.split('Branch for the retry issue.')).toHaveLength(2);
      expect(prompt.includes(`Your previous question:\n${question}`)).toBe(
        !resumed,
      );
      const full = host.playerCalls[1]!.freshPrompt ?? prompt;
      expect(full).toContain(`Your previous question:\n${question}`);
      expect(full).toContain('> Original request: Branch for the retry issue.');
      // The answer continuation is its own separately governed unchanged
      // boundary that keeps the original baseline.
      expect(receiptClassifications(host)).toEqual(['unchanged', 'unchanged']);
      expect(host.effectLedger.snapshot().logicalOperations).toEqual([]);
      await runtime.dispose();
    },
  );

  it('restarts a failed branching call with fresh caller context', async () => {
    const host = await harness({
      players: [
        { status: 'error', error: 'coder transport failed' },
        {
          status: 'ok',
          finalText: `Created and checked out ${BRANCH_NAME}.\n${ISSUE_SUMMARY}`,
          resumeToken: 'coder-restarted',
          repositoryEffect: 'branch',
        },
      ],
      // The failure state is a deterministic entry, so the restart makes no
      // classifier call — the only judge reply the turn consumes is the
      // restarted Coder's adjudication.
      judges: [BRANCHED_REPLY],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const failed = await runtime.handleBossInput({
      text: 'Branch for the old issue.',
      signal: new AbortController().signal,
    });
    expect(failed.outcome).toBe('failed');
    expect(runtime.describe!().lastError).toMatchObject({
      message: 'coder transport failed',
    });
    expect(runtime.describe!().actions.map(({ id }) => id)).toEqual([
      'retry:START_BRANCH',
    ]);

    const completed = await runtime.handleBossInput({
      text: 'Fix #12 instead.',
      signal: new AbortController().signal,
    });
    expect(completed.outcome).toBe('terminal');
    expect(completed.outcome === 'terminal' ? completed.output : undefined).toEqual({
      status: 'branched',
      branch: BRANCH_NAME,
      baseRevision: host.baseCommit,
      issueSummary: ISSUE_SUMMARY,
    });
    expect(host.playerCalls[1]?.prompt).toContain(
      '> Original request: Fix #12 instead.',
    );
    expect(host.playerCalls[1]?.prompt).not.toContain('old issue');
    expect(runtime.describe!().lastError).toBeUndefined();
    await runtime.dispose();
  });
});
