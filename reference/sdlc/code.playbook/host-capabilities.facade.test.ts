// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-046 / playbook-cli-90: the public host-capabilities facade, driven
// against real throwaway Git repositories and validated with the engine's own
// ledger validator and semantic reconciler, so the facade is proven to carry
// the one implementation the CLI host runs.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertPlaybookEffectLedger,
  emptyPlaybookEffectLedger,
  reconcilePlaybookSemanticEvidence,
} from '../../../src/xstate-runtime.js';
import * as implementation from './bin/repository-effects.js';
import * as facade from './host-capabilities.js';
import type {
  EffectBoundarySeed,
  PlaybookEffectLedger,
  PlaybookRepositoryDisposition,
  PlaybookRepositoryReceipt,
  RepositoryCompletionEvidence,
  WorktreeHostCapabilities,
} from './host-capabilities.js';

const PLAYBOOK_ID = 'facade-test';
const NULL_OID = '0'.repeat(40);
const FACADE_VALUE_EXPORTS = [
  'REPOSITORY_RECEIPT_CLASSIFICATIONS',
  'captureRepositoryReceipt',
  'classifyRepositoryReceipt',
  'createFailClosedHostCapabilities',
  'createWorktreeHostCapabilities',
  'observeGitRepository',
];

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'playbook-host-capabilities-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Repo {
  readonly dir: string;
  readonly git: (...args: string[]) => string;
  readonly head: () => string;
}

async function makeRepo(name: string): Promise<Repo> {
  const dir = join(scratch, name);
  await mkdir(dir);
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'facade@sublang.ai');
  git('config', 'user.name', 'Host Capabilities Facade');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, git, head: () => git('rev-parse', 'HEAD').trim() };
}

function seed(
  dispositions: readonly PlaybookRepositoryDisposition[],
  runtimeSessionId = randomUUID(),
): EffectBoundarySeed {
  return {
    boundaryId: randomUUID(),
    runtimeSessionId,
    turnId: 1,
    callId: 'player-1',
    roleId: 'coder',
    sourceStateId: 'work',
    sourceOutcomeSchema: {},
    dispositions,
    correctionBudget: { limit: 1, spent: false },
  };
}

function capabilitiesFor(
  dir: string,
  extra: Partial<Parameters<typeof facade.createWorktreeHostCapabilities>[0]> = {},
): Promise<WorktreeHostCapabilities> {
  return facade.createWorktreeHostCapabilities({
    cwd: dir,
    playbookId: PLAYBOOK_ID,
    requiredRoleIds: ['coder'],
    ...extra,
  });
}

function runBoundary(
  capabilities: WorktreeHostCapabilities,
  dispositions: readonly PlaybookRepositoryDisposition[],
  operation: () => Promise<unknown>,
  completeEffectBoundary: () => RepositoryCompletionEvidence = () => ({
    finalText: 'done',
  }),
) {
  return capabilities.repository.runExclusive({
    effectBoundary: seed(dispositions),
    operation,
    completeEffectBoundary,
  });
}

function reconcileFor(
  receipt: PlaybookRepositoryReceipt,
  disposition: 'unchanged' | 'one-descendant-commit',
): { status: string; reason?: string } {
  return reconcilePlaybookSemanticEvidence({
    outcomes: { done: { fields: {}, repositoryDisposition: disposition } },
    semanticCandidate: { guard: 'done' },
    finalText: 'done',
    receipt,
  }) as { status: string; reason?: string };
}

function claimIsActive(dir: string): boolean {
  return existsSync(
    join(dir, '.git', implementation._internal.claimRootName, 'active'),
  );
}

describe('host-capabilities facade surface (playbook-cli-87, playbook-cli-89)', () => {
  it('exports exactly the declared values, each resolving to the single implementation', async () => {
    expect(Object.keys(facade).sort()).toEqual(FACADE_VALUE_EXPORTS);
    expect(facade.createWorktreeHostCapabilities).toBe(
      implementation.createWorktreeHostCapabilities,
    );
    expect(facade.createFailClosedHostCapabilities).toBe(
      implementation.createFailClosedHostCapabilities,
    );
    expect(facade.REPOSITORY_RECEIPT_CLASSIFICATIONS).toBe(
      implementation.REPOSITORY_RECEIPT_CLASSIFICATIONS,
    );
    const source = await readFile(
      new URL('./host-capabilities.js', import.meta.url),
      'utf8',
    );
    const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    expect(specifiers).toEqual(['./bin/repository-effects.js']);
    expect(source).not.toMatch(/child_process|execFile|spawn/);
  });

  it('narrows receipt options to the declared dispositions and rejects a missing option object', async () => {
    const repo = await makeRepo('options');
    const baseline = await facade.observeGitRepository(repo.dir);
    await writeFile(join(repo.dir, 'next.txt'), 'next\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'next');
    // An undeclared `cohort` member is dropped rather than reinterpreted, so
    // the commit classifies as the exclusive-call contract says it must.
    const captured = await facade.captureRepositoryReceipt(baseline, {
      allowedDispositions: ['one-descendant-commit'],
      cohort: true,
    } as never);
    expect(captured.classification).toBe('one-descendant-commit');
    expect(captured.commitOid).toBe(repo.head());
    await expect(
      facade.captureRepositoryReceipt(baseline, undefined as never),
    ).rejects.toThrow(TypeError);
    await expect(
      facade.classifyRepositoryReceipt(baseline, baseline, {
        allowedDispositions: [],
      }),
    ).rejects.toThrow(/nonempty/);
    await expect(
      facade.observeGitRepository(join(scratch, 'missing')),
    ).rejects.toThrow();
  });

  it('observes a directory that is not a repository yet as the null HEAD over its content', async () => {
    const plain = join(scratch, 'plain');
    await mkdir(plain);
    await writeFile(join(plain, '.gitignore'), 'ignored.log\n');
    await writeFile(join(plain, 'ignored.log'), 'ignored\n');
    await writeFile(join(plain, 'kept.txt'), 'kept\n');
    const worktree = await realpath(plain);
    const observed = await facade.observeGitRepository(plain);
    expect(observed).toMatchObject({
      worktree,
      gitDir: join(worktree, '.git'),
      head: NULL_OID,
    });
    expect(Object.keys(observed.projection)).toEqual(['.gitignore', 'kept.txt']);
    expect(existsSync(join(plain, '.git'))).toBe(false);
    // `git init` sees exactly the same content, so the two observations agree.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: plain });
    const initialized = await facade.observeGitRepository(plain);
    expect(initialized).toEqual(observed);
    expect(
      (
        await facade.captureRepositoryReceipt(observed, {
          allowedDispositions: ['unchanged'],
        })
      ).classification,
    ).toBe('unchanged');
  });
});

describe('createWorktreeHostCapabilities (playbook-cli-88)', () => {
  it('constructs a frozen capability with exactly the declared members over the canonical worktree', async () => {
    const repo = await makeRepo('construct');
    const capabilities = await capabilitiesFor(repo.dir);
    expect(Object.keys(capabilities).sort()).toEqual([
      'effectLedger',
      'repository',
    ]);
    expect(Object.keys(capabilities.repository).sort()).toEqual([
      'identity',
      'observe',
      'runDeferred',
      'runExclusive',
    ]);
    expect(Object.keys(capabilities.effectLedger).sort()).toEqual([
      'snapshot',
      'writeAhead',
    ]);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.repository)).toBe(true);
    expect(capabilities.repository.identity).toEqual(
      await implementation.resolveCanonicalGitWorktree(repo.dir),
    );
    expect(capabilities.effectLedger.snapshot()).toEqual(
      emptyPlaybookEffectLedger(),
    );
    const observed = await capabilities.repository.observe();
    expect(observed).toEqual(await facade.observeGitRepository(repo.dir));
    expect(observed.head).toBe(repo.head());
    expect(observed.projection).toEqual({});
  });

  it.each([
    [
      'an unrecognized option',
      { sessionLease: {} },
      /option "sessionLease" is not supported/,
    ],
    ['an empty working directory', { cwd: '' }, /working directory/],
    ['an empty playbook id', { playbookId: '' }, /playbookId/],
    ['missing required roles', { requiredRoleIds: undefined }, /required roles/],
    [
      'a malformed concurrent role set',
      { concurrentRoleSets: [['coder']] },
      /concurrent roles/,
    ],
    [
      'a ledger seed that is not a ledger',
      { effectLedger: { schemaVersion: 1 } },
      /effect ledger seed/,
    ],
  ])('rejects %s before touching the worktree', async (_label, extra, pattern) => {
    const repo = await makeRepo('reject');
    await expect(
      capabilitiesFor(repo.dir, extra as never),
    ).rejects.toThrow(pattern);
    expect(claimIsActive(repo.dir)).toBe(false);
  });

  it('rejects a missing working directory and a seed naming another playbook or worktree', async () => {
    await expect(capabilitiesFor(join(scratch, 'missing'))).rejects.toThrow(
      /not an existing directory/,
    );
    const source = await makeRepo('seed-source');
    const sourceCapabilities = await capabilitiesFor(source.dir);
    const result = await runBoundary(
      sourceCapabilities,
      ['unchanged'],
      async () => 'idle',
    );
    const other = await makeRepo('seed-other');
    await expect(
      capabilitiesFor(other.dir, { effectLedger: result.effectLedger }),
    ).rejects.toThrow(/names another playbook or worktree/);
    await expect(
      capabilitiesFor(source.dir, {
        playbookId: 'another',
        effectLedger: result.effectLedger,
      }),
    ).rejects.toThrow(/names another playbook or worktree/);
  });
});

describe('exclusive governed calls (playbook-cli-88)', () => {
  it.each([
    [
      'one clean commit',
      ['one-descendant-commit'],
      async (repo: Repo) => {
        await writeFile(join(repo.dir, 'work.txt'), 'work\n');
        repo.git('add', '-A');
        repo.git('commit', '-qm', 'work');
      },
      'one-descendant-commit',
      { commitOid: true, reconcile: ['one-descendant-commit', 'resolved'] },
    ],
    [
      'two commits',
      ['one-descendant-commit'],
      async (repo: Repo) => {
        await writeFile(join(repo.dir, 'one.txt'), '1\n');
        repo.git('add', '-A');
        repo.git('commit', '-qm', 'one');
        await writeFile(join(repo.dir, 'two.txt'), '2\n');
        repo.git('add', '-A');
        repo.git('commit', '-qm', 'two');
      },
      'multiple-commits',
      {
        commitOid: false,
        reconcile: ['one-descendant-commit', 'unresolved'],
      },
    ],
    [
      'an amended HEAD',
      ['one-descendant-commit'],
      async (repo: Repo) => {
        await writeFile(join(repo.dir, 'base.txt'), 'amended\n');
        repo.git('add', '-A');
        repo.git('commit', '-q', '--amend', '-m', 'base amended');
      },
      'rewritten-or-non-descendant',
      { commitOid: false },
    ],
    [
      'a commit that leaves the worktree dirty',
      ['one-descendant-commit'],
      async (repo: Repo) => {
        await writeFile(join(repo.dir, 'work.txt'), 'work\n');
        repo.git('add', 'work.txt');
        repo.git('commit', '-qm', 'work');
        await writeFile(join(repo.dir, 'stray.txt'), 'leftover\n');
      },
      'observation-ambiguous',
      { commitOid: false },
    ],
    [
      'a stray file under unchanged-only dispositions',
      ['unchanged'],
      async (repo: Repo) => {
        await writeFile(join(repo.dir, 'stray.txt'), 'oops\n');
      },
      'concurrent-or-foreign-change',
      { commitOid: false, reconcile: ['unchanged', 'unresolved'] },
    ],
    [
      'an uncommitted rewrite of a tracked file under unchanged-only dispositions',
      ['unchanged'],
      async (repo: Repo) => {
        await writeFile(join(repo.dir, 'base.txt'), 'silently rewritten\n');
      },
      'concurrent-or-foreign-change',
      { commitOid: false, reconcile: ['unchanged', 'unresolved'] },
    ],
    [
      'no change under unchanged-only dispositions',
      ['unchanged'],
      async () => undefined,
      'unchanged',
      { commitOid: false, reconcile: ['unchanged', 'resolved'] },
    ],
    [
      'a same-HEAD superset change with a commit arm declared',
      ['unchanged', 'one-descendant-commit'],
      async (repo: Repo) => {
        await writeFile(join(repo.dir, 'draft.txt'), 'draft\n');
      },
      'worktree-only-change',
      { commitOid: false },
    ],
  ] as const)(
    'classifies %s',
    async (_label, dispositions, mutate, classification, expectation) => {
      const repo = await makeRepo('matrix');
      const capabilities = await capabilitiesFor(repo.dir);
      const result = await runBoundary(
        capabilities,
        dispositions,
        async () => {
          await mutate(repo);
          return { status: 'ok', finalText: 'done' };
        },
      );
      expect(result.receipt.classification).toBe(classification);
      if (expectation.commitOid) {
        expect(result.receipt.commitOid).toBe(repo.head());
        expect(result.receipt.after?.head).toBe(repo.head());
      } else {
        expect(result.receipt).not.toHaveProperty('commitOid');
      }
      expect(() => assertPlaybookEffectLedger(result.effectLedger)).not.toThrow();
      expect(result.effectLedger.revision).toBe(2);
      const [boundary] = result.effectLedger.boundaries;
      expect(boundary?.physicalReceipt).toEqual(result.receipt);
      expect(boundary?.after).toEqual(result.receipt.after);
      expect(boundary?.finalText).toBe('done');
      expect(capabilities.effectLedger.snapshot()).toEqual(result.effectLedger);
      if ('reconcile' in expectation) {
        const [disposition, status] = expectation.reconcile;
        const reconciled = reconcileFor(result.receipt, disposition);
        expect(reconciled.status).toBe(status);
        if (status === 'unresolved') {
          expect(reconciled.reason).toBe('repository-disposition-mismatch');
        }
      }
      expect(claimIsActive(repo.dir)).toBe(false);
    },
  );

  it('sees a re-modified already-dirty file and a reverted baseline-dirty entry', async () => {
    const redirtied = await makeRepo('redirtied');
    await writeFile(join(redirtied.dir, 'base.txt'), 'dirty before\n');
    const first = await runBoundary(
      await capabilitiesFor(redirtied.dir),
      ['unchanged'],
      async () => {
        await writeFile(join(redirtied.dir, 'base.txt'), 'dirty after\n');
      },
    );
    expect(first.receipt.classification).toBe('concurrent-or-foreign-change');

    const reverted = await makeRepo('reverted');
    await writeFile(join(reverted.dir, 'base.txt'), 'dirty at baseline\n');
    const second = await runBoundary(
      await capabilitiesFor(reverted.dir),
      ['unchanged', 'one-descendant-commit'],
      async () => {
        reverted.git('checkout', '--', 'base.txt');
        await writeFile(join(reverted.dir, 'other.txt'), 'other\n');
      },
    );
    expect(second.receipt.classification).toBe('observation-ambiguous');
    expect(() => assertPlaybookEffectLedger(second.effectLedger)).not.toThrow();
  });

  it('retains a mid-completion correction-budget spend with the completion evidence', async () => {
    const repo = await makeRepo('budget');
    const capabilities = await capabilitiesFor(repo.dir);
    let ledgerInsideCompletion: PlaybookEffectLedger | undefined;
    const result = await capabilities.repository.runExclusive({
      effectBoundary: seed(['one-descendant-commit']),
      operation: async () => {
        await writeFile(join(repo.dir, 'work.txt'), 'work\n');
        repo.git('add', '-A');
        repo.git('commit', '-qm', 'work');
        return 'committed';
      },
      completeEffectBoundary: async ({ boundary, operation, receipt }) => {
        expect(operation).toEqual({ status: 'fulfilled', value: 'committed' });
        expect(receipt.classification).toBe('one-descendant-commit');
        expect(boundary.correctionBudget).toEqual({ limit: 1, spent: false });
        expect(boundary).not.toHaveProperty('physicalReceipt');
        ledgerInsideCompletion = await capabilities.effectLedger.writeAhead([
          {
            kind: 'replace-boundaries',
            replacements: [
              {
                expected: boundary,
                next: {
                  ...boundary,
                  correctionBudget: { limit: 1, spent: true },
                },
              },
            ],
          },
        ]);
        return { finalText: 'done', semanticCandidate: { guard: 'done' } };
      },
    });
    expect(ledgerInsideCompletion?.revision).toBe(2);
    expect(result.effectLedger.revision).toBe(3);
    const [boundary] = result.effectLedger.boundaries;
    expect(boundary?.correctionBudget).toEqual({ limit: 1, spent: true });
    expect(boundary?.semanticCandidate).toEqual({ guard: 'done' });
    expect(boundary?.finalText).toBe('done');
    expect(boundary?.physicalReceipt?.commitOid).toBe(repo.head());
    expect(() => assertPlaybookEffectLedger(result.effectLedger)).not.toThrow();
    expect(reconcileFor(result.receipt, 'one-descendant-commit').status).toBe(
      'resolved',
    );
  });

  it('serializes overlapping calls in invocation order with contiguous sequences', async () => {
    const repo = await makeRepo('overlap');
    const capabilities = await capabilitiesFor(repo.dir);
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let leaderStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      leaderStarted = resolve;
    });
    // The cross-process claim guarantees mutual exclusion, not acquisition
    // order: whichever call publishes the claim first leads, and the other
    // must neither observe nor operate until the leader's receipt and release.
    const operation = (name: string) => async () => {
      order.push(`${name}:start`);
      if (order.length === 1) {
        leaderStarted();
        await gate;
      }
      order.push(`${name}:end`);
      return name;
    };
    const first = runBoundary(capabilities, ['unchanged'], operation('first'));
    const second = runBoundary(capabilities, ['unchanged'], operation('second'));
    await started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toHaveLength(1);
    release();
    const results = await Promise.all([first, second]);
    const leader = order[0]!.split(':')[0];
    const follower = leader === 'first' ? 'second' : 'first';
    expect(order).toEqual([
      `${leader}:start`,
      `${leader}:end`,
      `${follower}:start`,
      `${follower}:end`,
    ]);
    const final = results.find(
      (result) => result.effectLedger.boundaries.length === 2,
    );
    expect(final).toBeDefined();
    expect(final!.effectLedger.boundaries.map((b) => b.sequence)).toEqual([
      1, 2,
    ]);
    expect(
      new Set(final!.effectLedger.boundaries.map((b) => b.attemptId)).size,
    ).toBe(1);
    expect(() => assertPlaybookEffectLedger(final!.effectLedger)).not.toThrow();
    expect(capabilities.effectLedger.snapshot()).toEqual(final!.effectLedger);
    expect(claimIsActive(repo.dir)).toBe(false);
  });

  it('rejects an already-aborted call before observing or operating', async () => {
    const repo = await makeRepo('pre-aborted');
    const capabilities = await capabilitiesFor(repo.dir);
    const controller = new AbortController();
    const reason = new Error('pre-aborted boundary');
    controller.abort(reason);
    await expect(
      capabilities.repository.runExclusive({
        signal: controller.signal,
        effectBoundary: seed(['unchanged']),
        operation: async () => {
          throw new Error('operation must not run');
        },
        completeEffectBoundary: () => ({}),
      }),
    ).rejects.toBe(reason);
    expect(capabilities.effectLedger.snapshot().revision).toBe(0);
    expect(claimIsActive(repo.dir)).toBe(false);
  });

  it('rejects an undeclared role at boundary start and keeps the claim quarantined', async () => {
    const repo = await makeRepo('undeclared-role');
    const capabilities = await capabilitiesFor(repo.dir);
    let operated = false;
    await expect(
      capabilities.repository.runExclusive({
        effectBoundary: { ...seed(['unchanged']), roleId: 'reviewer' },
        operation: async () => {
          operated = true;
        },
        completeEffectBoundary: () => ({}),
      }),
    ).rejects.toThrow(/does not match its schema-3 host authority/);
    expect(operated).toBe(false);
    expect(capabilities.effectLedger.snapshot()).toEqual(
      emptyPlaybookEffectLedger(),
    );
    // A rejected write after the boundary became effect-possible quarantines
    // the worktree claim exactly as the CLI host does: only process death
    // may release it around evidence the host could not record.
    expect(claimIsActive(repo.dir)).toBe(true);
  });
});

describe('deferred Boss-question operations (playbook-cli-88)', () => {
  const question = (text: string) => ({
    questionId: 'work',
    asker: { kind: 'role', roleId: 'coder' } as const,
    question: text,
  });

  async function bind(
    capabilities: WorktreeHostCapabilities,
    runtimeSessionId: string,
    operationId: string,
  ) {
    return capabilities.repository.runExclusive({
      effectBoundary: seed(['one-descendant-commit', 'deferred'], runtimeSessionId),
      operation: async () => 'asked',
      completeEffectBoundary: () => ({
        finalText: 'What color?',
        semanticCandidate: { guard: 'needsBossReply', question: 'What color?' },
        deferred: {
          operationId,
          pendingQuestion: question('What color?'),
          playerContinuation: false,
        },
      }),
    });
  }

  it('binds the question, clears the binding on park, and refuses restoring a cleared binding', async () => {
    const repo = await makeRepo('deferred-park');
    const capabilities = await capabilitiesFor(repo.dir);
    const operationId = randomUUID();
    const bound = await bind(capabilities, randomUUID(), operationId);
    expect(bound.deferredStatus).toBe('bound');
    expect(bound.receipt.classification).toBe('unchanged');
    expect(() => assertPlaybookEffectLedger(bound.effectLedger)).not.toThrow();
    expect(bound.effectLedger.boundaries[0]?.logicalOperationId).toBe(
      operationId,
    );
    const [operation] = bound.effectLedger.logicalOperations;
    expect(operation).toMatchObject({
      operationId,
      boundaryIds: [bound.effectLedger.boundaries[0]?.boundaryId],
      checkpoint: bound.receipt.after,
      pendingQuestion: question('What color?'),
      playerContinuation: false,
      checkpointRestorationEligible: false,
    });

    const parked = await capabilities.repository.runDeferred({
      mode: 'park',
      operationId,
    });
    expect(parked.status).toBe('parked');
    expect(() => assertPlaybookEffectLedger(parked.effectLedger)).not.toThrow();
    const [parkedOperation] = parked.effectLedger.logicalOperations;
    expect(parkedOperation).not.toHaveProperty('checkpoint');
    expect(parkedOperation).not.toHaveProperty('pendingQuestion');
    expect(parkedOperation).not.toHaveProperty('playerContinuation');
    expect(parkedOperation?.checkpointRestorationEligible).toBe(false);

    const restored = await capabilities.repository.runDeferred({
      mode: 'restore',
      operationId,
    });
    expect(restored.status).toBe('ineligible');
    expect(restored.effectLedger).toEqual(parked.effectLedger);
    expect(claimIsActive(repo.dir)).toBe(false);
  });

  it('marks eligibility on a mismatched continuation, restores on equality, and continues with a cumulative receipt', async () => {
    const repo = await makeRepo('deferred-continue');
    const capabilities = await capabilitiesFor(repo.dir);
    const runtimeSessionId = randomUUID();
    const operationId = randomUUID();
    await bind(capabilities, runtimeSessionId, operationId);

    await writeFile(join(repo.dir, 'meddled.txt'), 'foreign change\n');
    const continuation = () => ({
      mode: 'continue' as const,
      operationId,
      effectBoundary: seed(['one-descendant-commit', 'deferred'], runtimeSessionId),
      operation: async ({
        playerContinuation,
      }: {
        readonly playerContinuation: unknown;
      }) => {
        expect(playerContinuation).toBe(false);
        return 'answered';
      },
      completeEffectBoundary: () => ({
        finalText: 'blue',
        semanticCandidate: { guard: 'done' },
      }),
    });
    const mismatched = await capabilities.repository.runDeferred(continuation());
    expect(mismatched.status).toBe('checkpoint-mismatch');
    expect(
      mismatched.effectLedger.logicalOperations[0]?.checkpointRestorationEligible,
    ).toBe(true);
    expect(mismatched.effectLedger.boundaries).toHaveLength(1);

    await unlink(join(repo.dir, 'meddled.txt'));
    const restored = await capabilities.repository.runDeferred({
      mode: 'restore',
      operationId,
    });
    expect(restored.status).toBe('restored');
    expect(
      restored.effectLedger.logicalOperations[0]?.checkpointRestorationEligible,
    ).toBe(false);
    expect(restored.effectLedger.logicalOperations[0]).toHaveProperty(
      'pendingQuestion',
    );

    const continued = await capabilities.repository.runDeferred(continuation());
    expect(continued.status).toBe('continued');
    if (continued.status !== 'continued') return;
    expect(continued.operation).toEqual({
      status: 'fulfilled',
      value: 'answered',
    });
    expect(continued.receipt.classification).toBe('unchanged');
    expect(continued.logicalReceipt?.classification).toBe('unchanged');
    expect(continued.effectLedger.boundaries).toHaveLength(2);
    const [operation] = continued.effectLedger.logicalOperations;
    expect(operation?.boundaryIds).toEqual(
      continued.effectLedger.boundaries.map((boundary) => boundary.boundaryId),
    );
    expect(operation?.logicalReceipt).toEqual(continued.logicalReceipt);
    expect(operation).not.toHaveProperty('pendingQuestion');
    expect(() => assertPlaybookEffectLedger(continued.effectLedger)).not.toThrow();
    expect(claimIsActive(repo.dir)).toBe(false);
  });
});

describe('seeded continuation (playbook-cli-88)', () => {
  it('continues sequences under a fresh attempt over a prior snapshot', async () => {
    const repo = await makeRepo('seeded');
    const first = await capabilitiesFor(repo.dir);
    const before = await runBoundary(first, ['unchanged'], async () => 'a');
    const second = await capabilitiesFor(repo.dir, {
      effectLedger: first.effectLedger.snapshot(),
    });
    expect(second.effectLedger.snapshot()).toEqual(before.effectLedger);
    const after = await runBoundary(second, ['unchanged'], async () => 'b');
    expect(
      after.effectLedger.boundaries.map((boundary) => [
        boundary.sequence,
        boundary.attemptNumber,
      ]),
    ).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(after.effectLedger.boundaries[0]?.attemptId).not.toBe(
      after.effectLedger.boundaries[1]?.attemptId,
    );
    expect(after.effectLedger.revision).toBe(before.effectLedger.revision + 2);
    expect(() => assertPlaybookEffectLedger(after.effectLedger)).not.toThrow();
  });
});

describe('a working directory that is not a repository yet (playbook-cli-88)', () => {
  const gitIn =
    (dir: string) =>
    (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  async function plainDirectory(name: string) {
    const dir = join(scratch, name);
    await mkdir(dir);
    const worktree = await realpath(dir);
    return {
      dir,
      git: gitIn(dir),
      identity: { worktree, gitDir: join(worktree, '.git') },
    };
  }

  function initialize(git: ReturnType<typeof gitIn>): void {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'facade@sublang.ai');
    git('config', 'user.name', 'Host Capabilities Facade');
    git('config', 'commit.gpgsign', 'false');
  }

  it('governs git init, the first root commit, and an idle call under one identity', async () => {
    const { dir, git, identity } = await plainDirectory('fresh');
    const capabilities = await capabilitiesFor(dir);
    expect(capabilities.repository.identity).toEqual(identity);
    const observed = await capabilities.repository.observe();
    expect(observed).toMatchObject({ ...identity, head: NULL_OID, projection: {} });

    // The workflow's own first step initializes the directory in place: a
    // `.git` directory is not worktree content, so nothing changed.
    const initialized = await runBoundary(capabilities, ['unchanged'], async () => {
      initialize(git);
    });
    expect(initialized.receipt.classification).toBe('unchanged');
    expect(initialized.receipt.baseline).toEqual(observed);
    expect(initialized.receipt.after).toMatchObject({ ...identity, head: NULL_OID });
    expect(reconcileFor(initialized.receipt, 'unchanged').status).toBe('resolved');
    expect(existsSync(join(dir, '.git'))).toBe(true);
    // Before the repository existed the claim was process-local: nothing was
    // published into the `.git` the operation created.
    expect(existsSync(join(dir, '.git', implementation._internal.claimRootName))).toBe(false);

    // The second step makes the repository's first commit: a root commit is
    // the one descendant of the null HEAD.
    const committed = await runBoundary(
      capabilities,
      ['one-descendant-commit'],
      async () => {
        await writeFile(join(dir, 'change.txt'), 'first change\n');
        git('add', '-A');
        git('commit', '-qm', 'first');
      },
    );
    const rootCommit = git('rev-parse', 'HEAD').trim();
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(committed.receipt.classification).toBe('one-descendant-commit');
    expect(committed.receipt.commitOid).toBe(rootCommit);
    expect(committed.receipt.baseline.head).toBe(NULL_OID);
    expect(committed.receipt.after?.head).toBe(rootCommit);
    expect(reconcileFor(committed.receipt, 'one-descendant-commit').status).toBe('resolved');
    // Once the repository exists, the claim is the published cross-process
    // one, retired on release.
    expect(claimIsActive(dir)).toBe(false);
    expect(existsSync(join(dir, '.git', implementation._internal.claimRootName))).toBe(true);

    const idle = await runBoundary(capabilities, ['unchanged'], async () => 'idle');
    expect(idle.receipt.classification).toBe('unchanged');
    expect(idle.receipt.baseline.head).toBe(rootCommit);
    expect(idle.receipt.after?.head).toBe(rootCommit);
    expect(reconcileFor(idle.receipt, 'unchanged').status).toBe('resolved');

    const ledger = capabilities.effectLedger.snapshot();
    expect(() => assertPlaybookEffectLedger(ledger)).not.toThrow();
    expect(ledger).toEqual(idle.effectLedger);
    expect(ledger.revision).toBe(6);
    expect(ledger.boundaries.map((boundary) => boundary.sequence)).toEqual([1, 2, 3]);
    expect(new Set(ledger.boundaries.map((boundary) => boundary.attemptId)).size).toBe(1);
    for (const boundary of ledger.boundaries) {
      expect(boundary.canonicalWorktree).toEqual(identity);
      expect(boundary.physicalReceipt?.baseline).toEqual(boundary.baseline);
    }
    expect(ledger.boundaries.map((boundary) => boundary.physicalReceipt?.classification)).toEqual([
      'unchanged',
      'one-descendant-commit',
      'unchanged',
    ]);
    expect(claimIsActive(dir)).toBe(false);
  });

  it('sees content before the repository exists and keeps every fail-closed classification', async () => {
    const { dir, git } = await plainDirectory('content');
    await writeFile(join(dir, 'draft.txt'), 'draft\n');
    const capabilities = await capabilitiesFor(dir);
    const edited = await runBoundary(capabilities, ['unchanged'], async () => {
      await writeFile(join(dir, 'draft.txt'), 'silently rewritten\n');
    });
    expect(edited.receipt.classification).toBe('concurrent-or-foreign-change');
    expect(edited.receipt.baseline.projection['draft.txt']).not.toEqual(
      edited.receipt.after?.projection['draft.txt'],
    );

    // Initializing a directory that already has content changes nothing.
    const initialized = await runBoundary(capabilities, ['unchanged'], async () => {
      initialize(git);
    });
    expect(initialized.receipt.classification).toBe('unchanged');
    expect(Object.keys(initialized.receipt.after?.projection ?? {})).toEqual(['draft.txt']);

    // Two root-descended commits are not one descendant of the null HEAD.
    const twice = await runBoundary(capabilities, ['one-descendant-commit'], async () => {
      git('add', '-A');
      git('commit', '-qm', 'one');
      await writeFile(join(dir, 'two.txt'), '2\n');
      git('add', '-A');
      git('commit', '-qm', 'two');
    });
    expect(twice.receipt.classification).toBe('multiple-commits');
    expect(() => assertPlaybookEffectLedger(twice.effectLedger)).not.toThrow();
    expect(twice.effectLedger.boundaries).toHaveLength(3);

    // A HEAD that stops naming a commit lost its history: the identity rebinds
    // to the same prospective root and observes the null HEAD again.
    const committed = twice.receipt.after!;
    await rm(join(dir, '.git'), { recursive: true, force: true });
    const lost = await facade.captureRepositoryReceipt(committed, {
      allowedDispositions: ['one-descendant-commit'],
    });
    expect(lost.classification).toBe('rewritten-or-non-descendant');
    expect(lost.after).toMatchObject({
      worktree: committed.worktree,
      gitDir: committed.gitDir,
      head: NULL_OID,
    });
    expect(Object.keys(lost.after?.projection ?? {})).toEqual(['draft.txt', 'two.txt']);
  });

  it('binds the nearest enclosing worktree until the directory becomes its own root', async () => {
    // The demo host's shape: an enclosing repository with no commit, and a
    // nested plain directory the workflow's ungoverned setup script turns into
    // its own repository before the first governed player call.
    const outer = await plainDirectory('outer');
    initialize(outer.git);
    const nestedDir = join(outer.dir, 'nested');
    await mkdir(nestedDir);
    const nested = {
      git: gitIn(nestedDir),
      identity: {
        worktree: join(outer.identity.worktree, 'nested'),
        gitDir: join(outer.identity.worktree, 'nested', '.git'),
      },
    };
    const capabilities = await capabilitiesFor(nestedDir);
    expect(capabilities.repository.identity).toEqual(
      await implementation.resolveCanonicalGitWorktree(outer.dir),
    );
    expect(await capabilities.repository.observe()).toMatchObject({
      ...capabilities.repository.identity,
      head: NULL_OID,
      projection: {},
    });

    initialize(nested.git);
    expect(await capabilities.repository.observe()).toMatchObject({
      ...nested.identity,
      head: NULL_OID,
      projection: {},
    });
    const committed = await runBoundary(
      capabilities,
      ['one-descendant-commit'],
      async () => {
        await writeFile(join(nestedDir, 'change.txt'), 'demo change\n');
        nested.git('add', '-A');
        nested.git('commit', '-qm', 'demo: smoke change');
      },
    );
    const rootCommit = nested.git('rev-parse', 'HEAD').trim();
    expect(committed.receipt.classification).toBe('one-descendant-commit');
    expect(committed.receipt.commitOid).toBe(rootCommit);
    expect(() => assertPlaybookEffectLedger(committed.effectLedger)).not.toThrow();
    expect(committed.effectLedger.boundaries[0]?.canonicalWorktree).toEqual(nested.identity);
    // The enclosing repository was never the governed one: it is still unborn
    // and sees the nested repository only as an untracked directory.
    expect(() => outer.git('rev-parse', '--verify', '--quiet', 'HEAD^{commit}')).toThrow();
    expect(outer.git('status', '--porcelain').trim()).toBe('?? nested/');
    expect(claimIsActive(nestedDir)).toBe(false);
  });
});

describe('createFailClosedHostCapabilities (playbook-cli-89)', () => {
  it('rejects every governed operation and write while reporting the empty ledger', async () => {
    const capabilities = facade.createFailClosedHostCapabilities();
    expect(Object.keys(capabilities).sort()).toEqual([
      'effectLedger',
      'repository',
    ]);
    expect(Object.keys(capabilities.repository).sort()).toEqual([
      'runDeferred',
      'runExclusive',
    ]);
    expect(Object.keys(capabilities.effectLedger).sort()).toEqual([
      'snapshot',
      'writeAhead',
    ]);
    expect(Object.isFrozen(capabilities.repository)).toBe(true);
    await expect(
      capabilities.repository.runExclusive({
        effectBoundary: seed(['unchanged']),
        operation: async () => undefined,
        completeEffectBoundary: () => ({}),
      }),
    ).rejects.toThrow(/fail-closed/);
    await expect(
      capabilities.repository.runDeferred({
        mode: 'park',
        operationId: randomUUID(),
      }),
    ).rejects.toThrow(/fail-closed/);
    await expect(
      capabilities.effectLedger.writeAhead([
        { kind: 'start-boundaries', boundaries: [{} as never] },
      ]),
    ).rejects.toThrow(/fail-closed/);
    expect(capabilities.effectLedger.snapshot()).toEqual(
      emptyPlaybookEffectLedger(),
    );
    expect(() =>
      assertPlaybookEffectLedger(capabilities.effectLedger.snapshot()),
    ).not.toThrow();
  });
});
