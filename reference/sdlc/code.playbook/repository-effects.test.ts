// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPlaybookEffectLedger,
  emptyPlaybookEffectLedger,
} from '../../../src/xstate-runtime.js';

import {
  RepositoryObservationAmbiguousError,
  _internal,
  captureRepositoryReceipt,
  classifyRepositoryReceipt,
  createRepositoryEffectCapabilities,
  createRepositoryEffectCoordinator,
  observeGitRepository,
  recoverIncompleteRepositoryEffects,
  resolveCanonicalGitWorktree,
} from './bin/repository-effects.js';
import { createCaptainSessionHost } from './bin/run.js';

const tempDirs: string[] = [];
const childProcesses = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of childProcesses) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  childProcesses.clear();
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function exec(
  command: string,
  args: string[],
  options: { cwd: string; input?: string | Buffer } = { cwd: process.cwd() },
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      command,
      args,
      { cwd: options.cwd, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(
            new Error(
              `${command} ${args.join(' ')} failed: ${stderr || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function git(repo: string, ...args: string[]): Promise<string> {
  return exec('git', args, { cwd: repo });
}

async function initRepository(prefix = 'playbook-effects-'): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(repo);
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'user.name', 'Repository Effect Test');
  await git(repo, 'config', 'user.email', 'effects@example.invalid');
  await git(repo, 'config', 'core.filemode', 'true');
  await writeFile(join(repo, '.gitignore'), 'ignored.log\n', 'utf8');
  await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8');
  await git(repo, 'add', '--all');
  await git(repo, 'commit', '--quiet', '-m', 'base');
  return repo;
}

async function commitFile(
  repo: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(repo, path), content, 'utf8');
  await git(repo, 'add', '--', path);
  await git(repo, 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function fakeEffectLedgerService(
  initial = emptyPlaybookEffectLedger(),
) {
  let ledger = assertPlaybookEffectLedger(initial);
  const writeAhead = vi.fn(async (_authority: unknown, commands: any[]) => {
    let boundaries = [...ledger.boundaries] as any[];
    let logicalOperations = [...ledger.logicalOperations] as any[];
    for (const command of commands) {
      if (command.kind === 'start-boundaries') {
        const attemptSequence = boundaries.length + 1;
        const attemptId = `00000000-0000-4000-8000-${String(attemptSequence).padStart(12, '0')}`;
        for (const seed of command.boundaries) {
          const sequence = boundaries.length + 1;
          boundaries.push({
            sequence,
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
            (boundary) => boundary.boundaryId === replacement.expected.boundaryId,
          );
          expect(index).toBeGreaterThanOrEqual(0);
          expect(boundaries[index]).toEqual(replacement.expected);
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
          expect(index).toBeGreaterThanOrEqual(0);
          expect(logicalOperations[index]).toEqual(replacement.expected);
          logicalOperations[index] = replacement.next;
        }
        continue;
      }
      throw new Error(`unsupported fake ledger command ${command.kind}`);
    }
    ledger = assertPlaybookEffectLedger({
      ...ledger,
      revision: ledger.revision + 1,
      boundaries,
      logicalOperations,
    });
    return ledger;
  });
  return {
    service: {
      snapshot: () => ledger,
      writeAhead,
    },
    writeAhead,
  };
}

function fileBackedEffectLedgerService(
  ledgerPath: string,
  beforeWrite: () => void = () => undefined,
) {
  let ledger = assertPlaybookEffectLedger(
    JSON.parse(readFileSync(ledgerPath, 'utf8')),
  );
  return {
    snapshot: () => ledger,
    writeAhead: async (_authority: unknown, commands: any[]) => {
      beforeWrite();
      let boundaries = [...ledger.boundaries] as any[];
      for (const command of commands) {
        if (command.kind === 'start-boundaries') {
          for (const seed of command.boundaries) {
            const sequence = boundaries.length + 1;
            boundaries.push({
              sequence,
              ...seed,
              attemptId: `60000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
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
              throw new Error('file-backed ledger replacement is stale');
            }
            boundaries[index] = replacement.next;
          }
          continue;
        }
        throw new Error(`unsupported file-backed ledger command ${command.kind}`);
      }
      ledger = assertPlaybookEffectLedger({
        ...ledger,
        revision: ledger.revision + 1,
        boundaries,
      });
      const stagePath = `${ledgerPath}.${process.pid}.stage`;
      writeFileSync(stagePath, `${JSON.stringify(ledger)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(stagePath, ledgerPath);
      return ledger;
    },
  };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once('exit', () => resolvePromise());
    child.once('error', rejectPromise);
  });
}

async function waitForLine(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolvePromise(buffer.slice(0, newline));
    };
    const onExit = () => {
      cleanup();
      rejectPromise(new Error(`claim child exited before reporting: ${buffer}`));
    };
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const cleanup = () => {
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function startClaimChild(repo: string): Promise<{
  child: ChildProcess;
  ownerToken: string;
}> {
  const moduleUrl = new URL('./bin/repository-effects.js', import.meta.url).href;
  const source = `
    import { createRepositoryEffectCoordinator } from ${JSON.stringify(moduleUrl)};
    const coordinator = createRepositoryEffectCoordinator({ pollIntervalMs: 2 });
    const claim = await coordinator.acquire(${JSON.stringify(repo)});
    process.stdout.write(claim.ownerToken + '\\n');
    process.stdin.once('data', async () => {
      await claim.release();
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  childProcesses.add(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const ownerToken = await waitForLine(child);
    return { child, ownerToken };
  } catch (error) {
    throw new Error(`claim child failed: ${stderr}`, { cause: error });
  }
}

describe('repository-relevant Git observations (PBRT-68)', () => {
  it('uses canonical linked-worktree roots and detached immutable observations', async () => {
    const repo = await initRepository();
    const aliasRoot = await mkdtemp(join(tmpdir(), 'playbook-effects-alias-'));
    tempDirs.push(aliasRoot);
    const alias = join(aliasRoot, 'repo');
    await symlink(repo, alias);
    await mkdir(join(repo, 'nested'));

    const identity = await resolveCanonicalGitWorktree(join(alias, 'nested'));
    expect(identity.worktree).toBe(await realpath(repo));
    expect(identity.gitDir).toBe(await realpath(join(repo, '.git')));

    const observation = await observeGitRepository(alias);
    expect(observation.head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(observation.projection).toEqual({});
    expect(observation.projectionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.projection)).toBe(true);
  });

  it('projects index, tracked-worktree, mode, and nonignored-untracked layers but not ignored output', async () => {
    const repo = await initRepository();
    const clean = await observeGitRepository(repo);

    await writeFile(join(repo, 'ignored.log'), 'ignored\n', 'utf8');
    expect((await observeGitRepository(repo)).projectionDigest).toBe(
      clean.projectionDigest,
    );
    await utimes(join(repo, 'base.txt'), new Date(1_000), new Date(2_000));
    expect((await observeGitRepository(repo)).projectionDigest).toBe(
      clean.projectionDigest,
    );

    await writeFile(join(repo, 'base.txt'), 'tracked change\n', 'utf8');
    const tracked = await observeGitRepository(repo);
    expect(tracked.projection['base.txt']).toMatchObject({
      kind: 'ordinary',
      worktree: {
        kind: 'file',
        mode: '100644',
        content: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    const trackedContent = tracked.projection['base.txt'].worktree.content;
    expect(Object.isFrozen(tracked.projection['base.txt'])).toBe(true);
    expect(Object.isFrozen(tracked.projection['base.txt'].worktree)).toBe(true);

    await chmod(join(repo, 'base.txt'), 0o755);
    const modeChanged = await observeGitRepository(repo);
    expect(modeChanged.projection['base.txt'].worktree.mode).toBe('100755');
    expect(tracked.projection['base.txt'].worktree.content).toBe(trackedContent);

    await writeFile(join(repo, 'staged.txt'), 'staged\n', 'utf8');
    await git(repo, 'add', '--', 'staged.txt');
    const staged = await observeGitRepository(repo);
    expect(staged.projection['staged.txt']).toMatchObject({
      kind: 'ordinary',
      indexMode: '100644',
    });
    expect(staged.projection['staged.txt'].indexOid).toMatch(/^[0-9a-f]{40,64}$/);

    await writeFile(join(repo, 'untracked.txt'), 'untracked\n', 'utf8');
    const untracked = await observeGitRepository(repo);
    expect(untracked.projection['untracked.txt']).toMatchObject({
      kind: 'untracked',
      worktree: {
        kind: 'file',
        mode: '100644',
      },
    });
    expect(untracked.projection['untracked.txt'].worktree.content).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('fails closed instead of collapsing a non-UTF-8 Git path', async () => {
    const repo = await initRepository();
    const oid = await exec('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      input: 'indexed content\n',
    });
    const indexRecord = Buffer.concat([
      Buffer.from(`100644 ${oid}\tinvalid-`, 'utf8'),
      Buffer.from([0xff, 0]),
    ]);
    await exec('git', ['update-index', '-z', '--index-info'], {
      cwd: repo,
      input: indexRecord,
    });
    await expect(observeGitRepository(repo)).rejects.toThrow(
      'not lossless UTF-8',
    );
  });

  it('fails closed when index flags hide tracked-worktree inspection', async () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const repo = await initRepository(`playbook-effects-hidden-${flag.slice(2)}-`);
      await git(repo, 'update-index', flag, '--', 'base.txt');
      await writeFile(join(repo, 'base.txt'), `${flag} content\n`, 'utf8');
      await expect(observeGitRepository(repo)).rejects.toThrow(
        'suppress exact tracked-worktree observation',
      );
    }
  });

  it('content-addresses dirty bytes inside an embedded Git worktree', async () => {
    const repo = await initRepository();
    const embedded = join(repo, 'embedded');
    await mkdir(embedded);
    await git(embedded, 'init', '--quiet');
    await git(embedded, 'config', 'user.name', 'Embedded Test');
    await git(embedded, 'config', 'user.email', 'embedded@example.invalid');
    await writeFile(join(embedded, 'nested.txt'), 'base\n', 'utf8');
    await git(embedded, 'add', '--all');
    await git(embedded, 'commit', '--quiet', '-m', 'nested base');

    await writeFile(join(embedded, 'nested.txt'), 'dirty one\n', 'utf8');
    const first = await observeGitRepository(repo);
    await writeFile(join(embedded, 'nested.txt'), 'dirty two\n', 'utf8');
    const second = await observeGitRepository(repo);
    expect(first.projection['embedded/']).toMatchObject({
      kind: 'untracked',
      worktree: { kind: 'directory', mode: '040000' },
    });
    expect(second.projection['embedded/'].worktree.content).not.toBe(
      first.projection['embedded/'].worktree.content,
    );
    expect(second.projectionDigest).not.toBe(first.projectionDigest);
  });

  it('proves unchanged and one descendant only against the complete baseline projection', async () => {
    const repo = await initRepository();
    await writeFile(join(repo, 'base.txt'), 'pre-existing dirt\n', 'utf8');
    const dirtyBaseline = await observeGitRepository(repo);
    await writeFile(join(repo, 'ignored.log'), 'ignored-only\n', 'utf8');
    const unchangedAfter = await observeGitRepository(repo);
    const unchangedReceipt = await classifyRepositoryReceipt(
      dirtyBaseline,
      unchangedAfter,
      {
        allowedDispositions: ['unchanged', 'one-descendant-commit'],
      },
    );
    expect(unchangedReceipt).toEqual({
      classification: 'unchanged',
      baseline: dirtyBaseline,
      after: unchangedAfter,
    });
    expect(unchangedReceipt.baseline).toBe(dirtyBaseline);
    expect(unchangedReceipt.after).toBe(unchangedAfter);

    const commitOid = await commitFile(
      repo,
      'new.txt',
      'new tracked file\n',
      'one descendant',
    );
    const committedAfter = await observeGitRepository(repo);
    const committedReceipt = await classifyRepositoryReceipt(
      dirtyBaseline,
      committedAfter,
      {
        allowedDispositions: ['unchanged', 'one-descendant-commit'],
      },
    );
    expect(committedReceipt).toMatchObject({
      classification: 'one-descendant-commit',
      commitOid,
    });
    expect(committedReceipt.after).toBe(committedAfter);
    expect(committedReceipt.commitOid).toBe(committedAfter.head);

    const cleanRepo = await initRepository('playbook-effects-clean-');
    const cleanBaseline = await observeGitRepository(cleanRepo);
    const cleanCommit = await commitFile(
      cleanRepo,
      'created.txt',
      'created\n',
      'created and committed',
    );
    const cleanAfter = await observeGitRepository(cleanRepo);
    await expect(
      classifyRepositoryReceipt(cleanBaseline, cleanAfter, {
        allowedDispositions: ['one-descendant-commit'],
      }),
    ).resolves.toMatchObject({
      classification: 'one-descendant-commit',
      commitOid: cleanCommit,
    });
  });

  it('classifies worktree-only and declared-zero deltas without path attribution', async () => {
    const repo = await initRepository();
    const baseline = await observeGitRepository(repo);
    await writeFile(join(repo, 'untracked.txt'), 'delta\n', 'utf8');
    const after = await observeGitRepository(repo);

    await expect(
      classifyRepositoryReceipt(baseline, after, {
        allowedDispositions: ['unchanged', 'one-descendant-commit'],
      }),
    ).resolves.toMatchObject({ classification: 'worktree-only-change' });
    await expect(
      classifyRepositoryReceipt(baseline, after, {
        allowedDispositions: ['unchanged'],
      }),
    ).resolves.toMatchObject({
      classification: 'concurrent-or-foreign-change',
    });
  });

  it('classifies staged, tracked, and nonignored-untracked deltas by the same complete predicate', async () => {
    const cases = [
      {
        name: 'staged',
        mutate: async (repo: string) => {
          await writeFile(join(repo, 'delta.txt'), 'staged\n', 'utf8');
          await git(repo, 'add', '--', 'delta.txt');
        },
      },
      {
        name: 'tracked',
        mutate: (repo: string) =>
          writeFile(join(repo, 'base.txt'), 'tracked\n', 'utf8'),
      },
      {
        name: 'mode',
        mutate: async (repo: string) => {
          await git(repo, 'config', 'core.fileMode', 'false');
          await chmod(join(repo, 'base.txt'), 0o755);
        },
      },
      {
        name: 'tracked-deletion',
        mutate: (repo: string) => rm(join(repo, 'base.txt')),
      },
      {
        name: 'untracked',
        mutate: (repo: string) =>
          writeFile(join(repo, 'delta.txt'), 'untracked\n', 'utf8'),
      },
    ];
    for (const testCase of cases) {
      const repo = await initRepository(`playbook-effects-${testCase.name}-`);
      const baseline = await observeGitRepository(repo);
      await testCase.mutate(repo);
      const after = await observeGitRepository(repo);
      const effectReceipt = await classifyRepositoryReceipt(baseline, after, {
          allowedDispositions: ['unchanged', 'one-descendant-commit'],
        });
      expect(effectReceipt).toMatchObject({
        classification: 'worktree-only-change',
      });
      expect(effectReceipt).not.toHaveProperty('commitOid');
      const zeroReceipt = await classifyRepositoryReceipt(baseline, after, {
          allowedDispositions: ['unchanged'],
        });
      expect(zeroReceipt).toMatchObject({
        classification: 'concurrent-or-foreign-change',
      });
      expect(zeroReceipt).not.toHaveProperty('commitOid');
    }
  });

  it('fails closed on altered or consumed overlays, residual changes, multiple commits, and rewritten history', async () => {
    const alteredRepo = await initRepository('playbook-effects-altered-');
    await writeFile(join(alteredRepo, 'base.txt'), 'first overlay\n', 'utf8');
    const alteredBaseline = await observeGitRepository(alteredRepo);
    await writeFile(join(alteredRepo, 'base.txt'), 'altered overlay\n', 'utf8');
    const alteredAfter = await observeGitRepository(alteredRepo);
    await expect(
      classifyRepositoryReceipt(alteredBaseline, alteredAfter, {
        allowedDispositions: ['unchanged', 'one-descendant-commit'],
      }),
    ).resolves.toMatchObject({ classification: 'observation-ambiguous' });

    const consumedRepo = await initRepository('playbook-effects-consumed-');
    await writeFile(join(consumedRepo, 'base.txt'), 'consume me\n', 'utf8');
    const consumedBaseline = await observeGitRepository(consumedRepo);
    await git(consumedRepo, 'add', '--', 'base.txt');
    await git(consumedRepo, 'commit', '--quiet', '-m', 'consume overlay');
    const consumedAfter = await observeGitRepository(consumedRepo);
    await expect(
      classifyRepositoryReceipt(consumedBaseline, consumedAfter, {
        allowedDispositions: ['unchanged', 'one-descendant-commit'],
      }),
    ).resolves.toMatchObject({ classification: 'observation-ambiguous' });

    const residualRepo = await initRepository('playbook-effects-residual-');
    const residualBaseline = await observeGitRepository(residualRepo);
    await commitFile(residualRepo, 'committed.txt', 'commit\n', 'commit');
    await writeFile(join(residualRepo, 'residual.txt'), 'residual\n', 'utf8');
    const residualAfter = await observeGitRepository(residualRepo);
    await expect(
      classifyRepositoryReceipt(residualBaseline, residualAfter, {
        allowedDispositions: ['one-descendant-commit'],
      }),
    ).resolves.toMatchObject({ classification: 'observation-ambiguous' });

    const multipleRepo = await initRepository('playbook-effects-multiple-');
    const multipleBaseline = await observeGitRepository(multipleRepo);
    await commitFile(multipleRepo, 'one.txt', 'one\n', 'one');
    await commitFile(multipleRepo, 'two.txt', 'two\n', 'two');
    const multipleAfter = await observeGitRepository(multipleRepo);
    await expect(
      classifyRepositoryReceipt(multipleBaseline, multipleAfter, {
        allowedDispositions: ['one-descendant-commit'],
      }),
    ).resolves.toMatchObject({ classification: 'multiple-commits' });

    const rewrittenRepo = await initRepository('playbook-effects-rewritten-');
    const rewrittenBaseline = await observeGitRepository(rewrittenRepo);
    await git(rewrittenRepo, 'checkout', '--quiet', '--orphan', 'rewritten');
    await rm(join(rewrittenRepo, 'base.txt'));
    await rm(join(rewrittenRepo, '.gitignore'));
    await writeFile(join(rewrittenRepo, 'other.txt'), 'other root\n', 'utf8');
    await git(rewrittenRepo, 'add', '--all');
    await git(rewrittenRepo, 'commit', '--quiet', '-m', 'unrelated root');
    const rewrittenAfter = await observeGitRepository(rewrittenRepo);
    await expect(
      classifyRepositoryReceipt(rewrittenBaseline, rewrittenAfter, {
        allowedDispositions: ['one-descendant-commit'],
      }),
    ).resolves.toMatchObject({
      classification: 'rewritten-or-non-descendant',
    });
  });

  it('rejects a mixed observation and captures it as ambiguous evidence', async () => {
    const repo = await initRepository();
    await expect(
      observeGitRepository(repo, {
        afterFirstSample: () =>
          writeFile(join(repo, 'raced.txt'), 'arrived mid-sample\n', 'utf8'),
      }),
    ).rejects.toBeInstanceOf(RepositoryObservationAmbiguousError);

    await rm(join(repo, 'raced.txt'));
    const baseline = await observeGitRepository(repo);
    const receipt = await captureRepositoryReceipt(baseline, {
      allowedDispositions: ['unchanged', 'one-descendant-commit'],
      observation: {
        afterFirstSample: () =>
          writeFile(join(repo, 'overlap.txt'), 'overlap\n', 'utf8'),
      },
    });
    expect(receipt).toMatchObject({ classification: 'observation-ambiguous' });
    expect(receipt).not.toHaveProperty('after');
  });

  it.runIf(process.platform !== 'win32')(
    'fails closed when reported content cannot be read',
    async () => {
      const repo = await initRepository();
      const unreadable = join(repo, 'unreadable.txt');
      await writeFile(unreadable, 'private\n', 'utf8');
      await chmod(unreadable, 0o000);
      await expect(observeGitRepository(repo)).rejects.toBeInstanceOf(
        RepositoryObservationAmbiguousError,
      );
      await chmod(unreadable, 0o600);
    },
  );
});

describe('canonical-worktree cooperative claims (PBCLI-58)', () => {
  it('serializes same-worktree claims across processes and permanently retires owners', async () => {
    const repo = await initRepository();
    const aliasRoot = await mkdtemp(join(tmpdir(), 'playbook-effects-claim-alias-'));
    tempDirs.push(aliasRoot);
    const alias = join(aliasRoot, 'repo');
    await symlink(repo, alias);
    const childClaim = await startClaimChild(repo);
    const identity = await resolveCanonicalGitWorktree(repo);
    const activeOwner = JSON.parse(
      await readFile(
        join(identity.gitDir, _internal.claimRootName, 'active', 'owner.json'),
        'utf8',
      ),
    );
    expect(Object.keys(activeOwner).sort()).toEqual([
      'hostname',
      'ownerToken',
      'pid',
      'schema',
    ]);
    expect(activeOwner).toMatchObject({
      ownerToken: childClaim.ownerToken,
      pid: childClaim.child.pid,
      schema: 1,
    });
    expect(activeOwner.hostname).toEqual(expect.any(String));
    const attempted = deferred<number>();
    const coordinator = createRepositoryEffectCoordinator({
      pollIntervalMs: 2,
      probeProcess: (pid: number) => {
        attempted.resolve(pid);
        return 'live';
      },
    });
    let parentAcquired = false;
    const parentPromise = coordinator.acquire(alias).then((claim) => {
      parentAcquired = true;
      return claim;
    });
    expect(await attempted.promise).toBe(childClaim.child.pid);
    expect(parentAcquired).toBe(false);

    childClaim.child.stdin?.end('\n');
    await waitForExit(childClaim.child);
    childProcesses.delete(childClaim.child);
    const parentClaim = await parentPromise;
    expect(parentAcquired).toBe(true);
    const parentToken = parentClaim.ownerToken;
    await parentClaim.release();

    const retired = await readdir(join(identity.gitDir, _internal.claimRootName));
    expect(retired).toContain(`retired-${childClaim.ownerToken}`);
    expect(retired).toContain(`retired-${parentToken}`);
    expect(retired).not.toContain('active');
  });

  it('retires a published claim after acquisition failure and rejects token reuse', async () => {
    const repo = await initRepository();
    const ownerToken = '10000000-0000-4000-8000-000000000001';
    const failed = createRepositoryEffectCoordinator({
      createOwnerToken: () => ownerToken,
      _testAfterClaimPublished: () => {
        throw new Error('injected post-publication failure');
      },
    });
    await expect(failed.acquire(repo)).rejects.toThrow(
      'injected post-publication failure',
    );

    const identity = await resolveCanonicalGitWorktree(repo);
    const root = join(identity.gitDir, _internal.claimRootName);
    expect(await readdir(root)).toContain(`retired-${ownerToken}`);
    expect((await lstat(root)).mode & 0o7777).toBe(0o700);
    expect(
      (await lstat(join(root, `retired-${ownerToken}`))).mode & 0o7777,
    ).toBe(0o700);
    expect(
      (
        await lstat(join(root, `retired-${ownerToken}`, 'owner.json'))
      ).mode & 0o7777,
    ).toBe(0o600);
    await expect(
      createRepositoryEffectCoordinator({
        createOwnerToken: () => ownerToken,
      }).acquire(repo),
    ).rejects.toThrow('already retired');

    const successor = await createRepositoryEffectCoordinator().acquire(repo);
    await successor.release();
    expect(await readdir(root)).not.toContain('active');
  });

  it('reclaims only a same-host owner whose process is definitively dead', async () => {
    const repo = await initRepository();
    const childClaim = await startClaimChild(repo);
    childClaim.child.kill('SIGKILL');
    await waitForExit(childClaim.child);
    childProcesses.delete(childClaim.child);

    const coordinator = createRepositoryEffectCoordinator({ pollIntervalMs: 2 });
    const successor = await coordinator.acquire(repo);
    await successor.release();
    const identity = await resolveCanonicalGitWorktree(repo);
    const retired = await readdir(join(identity.gitDir, _internal.claimRootName));
    expect(retired).toContain(`retired-${childClaim.ownerToken}`);

    const foreignRepo = await initRepository('playbook-effects-foreign-');
    const foreign = createRepositoryEffectCoordinator({ hostname: 'host-a' });
    const foreignClaim = await foreign.acquire(foreignRepo);
    await expect(
      createRepositoryEffectCoordinator({ hostname: 'host-b' }).acquire(
        foreignRepo,
      ),
    ).rejects.toThrow('foreign host');
    await foreignClaim.release();

    const unknownRepo = await initRepository('playbook-effects-unknown-');
    const live = await coordinator.acquire(unknownRepo);
    await expect(
      createRepositoryEffectCoordinator({
        probeProcess: () => 'unknown',
      }).acquire(unknownRepo),
    ).rejects.toThrow('cannot be ruled dead');
    await live.release();
  });

  it('prevents a delayed stale-owner reclaimer from disturbing a successor', async () => {
    const repo = await initRepository();
    const hostname = 'delayed-reclaimer-host';
    const predecessor = await createRepositoryEffectCoordinator({
      hostname,
      pid: 10_001,
    }).acquire(repo);
    const sawPredecessor = deferred();
    const permitRetirement = deferred();
    const sawSuccessor = deferred();
    const stop = new AbortController();
    const delayed = createRepositoryEffectCoordinator({
      hostname,
      pid: 10_002,
      pollIntervalMs: 2,
      probeProcess: async (pid: number) => {
        if (pid === 10_001) {
          sawPredecessor.resolve();
          await permitRetirement.promise;
          return 'dead';
        }
        if (pid === 10_003) {
          sawSuccessor.resolve();
          return 'live';
        }
        return 'unknown';
      },
    });
    const delayedAcquire = delayed.acquire(repo, { signal: stop.signal });
    const delayedRejection = expect(delayedAcquire).rejects.toThrow(
      'test completed',
    );
    await sawPredecessor.promise;

    await predecessor.release();
    const successor = await createRepositoryEffectCoordinator({
      hostname,
      pid: 10_003,
    }).acquire(repo);
    permitRetirement.resolve();
    await sawSuccessor.promise;
    await successor.assertOwner();
    stop.abort(new Error('test completed'));
    await delayedRejection;
    await successor.release();
  });

  it('fails closed on a malformed active owner', async () => {
    const repo = await initRepository();
    const coordinator = createRepositoryEffectCoordinator();
    await coordinator.acquire(repo);
    const identity = await resolveCanonicalGitWorktree(repo);
    await writeFile(
      join(identity.gitDir, _internal.claimRootName, 'active', 'owner.json'),
      '{malformed\n',
      'utf8',
    );
    await expect(coordinator.acquire(repo)).rejects.toThrow('malformed JSON');
  });

  it('fails closed on nonprivate claim directories and owner files', async () => {
    const repo = await initRepository();
    const coordinator = createRepositoryEffectCoordinator();
    const claim = await coordinator.acquire(repo);
    const identity = await resolveCanonicalGitWorktree(repo);
    const active = join(identity.gitDir, _internal.claimRootName, 'active');
    const owner = join(active, 'owner.json');

    await chmod(active, 0o755);
    await expect(coordinator.acquire(repo)).rejects.toThrow(
      'permissions must be 0700',
    );
    await chmod(active, 0o700);
    await chmod(owner, 0o644);
    await expect(coordinator.acquire(repo)).rejects.toThrow(
      'private regular file',
    );
    await chmod(owner, 0o600);
    await claim.release();
  });

  it('does not let release overlap an in-progress claim observation', async () => {
    const repo = await initRepository();
    const claim = await createRepositoryEffectCoordinator().acquire(repo);
    const sampled = deferred();
    const finish = deferred();
    const observation = claim.observe({
      afterFirstSample: () => {
        sampled.resolve();
        return finish.promise;
      },
    });
    await sampled.promise;
    await expect(claim.release()).rejects.toThrow('already in progress');
    finish.resolve();
    await observation;
    await claim.release();
  });

  it('holds an exclusive claim through its receipt and captures rejected work', async () => {
    const repo = await initRepository();
    const afterStarted = deferred();
    const finishAfter = deferred();
    const coordinator = createRepositoryEffectCoordinator({ pollIntervalMs: 2 });
    const exclusivePromise = coordinator.runExclusive({
      cwd: repo,
      allowedDispositions: ['unchanged'],
      operation: () => 'complete',
      afterObservation: {
        afterFirstSample: () => {
          afterStarted.resolve();
          return finishAfter.promise;
        },
      },
    });
    await afterStarted.promise;

    const outsiderAttempted = deferred();
    const outsiderCoordinator = createRepositoryEffectCoordinator({
      pollIntervalMs: 2,
      probeProcess: () => {
        outsiderAttempted.resolve();
        return 'live';
      },
    });
    let outsiderAcquired = false;
    const outsiderPromise = outsiderCoordinator.acquire(repo).then((claim) => {
      outsiderAcquired = true;
      return claim;
    });
    await outsiderAttempted.promise;
    expect(outsiderAcquired).toBe(false);

    finishAfter.resolve();
    const exclusive = await exclusivePromise;
    expect(exclusive.operation).toEqual({
      status: 'fulfilled',
      value: 'complete',
    });
    expect(exclusive.receipt.classification).toBe('unchanged');
    const outsider = await outsiderPromise;
    await outsider.release();

    const failure = new Error('operation failed');
    const rejected = await coordinator.runExclusive({
      cwd: repo,
      allowedDispositions: ['unchanged'],
      operation: () => {
        throw failure;
      },
    });
    expect(rejected.operation).toEqual({ status: 'rejected', reason: failure });
    expect(rejected.receipt.classification).toBe('unchanged');
    const afterRejected = await coordinator.acquire(repo);
    await afterRejected.release();
  });

  it('runs only a declared all-unchanged cohort from one baseline while outsiders wait', async () => {
    const repo = await initRepository();
    const coordinator = createRepositoryEffectCoordinator({ pollIntervalMs: 2 });
    const bothStarted = deferred();
    const finishOperations = deferred();
    const afterStarted = deferred();
    const finishAfter = deferred();
    const baselines: unknown[] = [];
    let afterSampling = false;
    let started = 0;
    const operation = async ({ baseline, invocationId, roleId }: {
      baseline: unknown;
      invocationId: string;
      roleId: string;
    }) => {
      baselines.push(baseline);
      expect(invocationId).toBe('invocation-a');
      started += 1;
      if (started === 2) bothStarted.resolve();
      await finishOperations.promise;
      return roleId;
    };
    const cohortPromise = coordinator.runCohort({
      cwd: repo,
      invocationId: 'invocation-a',
      roleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [['coder', 'reviewer']],
      dispositionsByRole: {
        coder: ['unchanged'],
        reviewer: ['unchanged'],
      },
      operations: { coder: operation, reviewer: operation },
      afterObservation: {
        afterFirstSample: () => {
          afterSampling = true;
          afterStarted.resolve();
          return finishAfter.promise;
        },
      },
    });
    await bothStarted.promise;
    expect(afterSampling).toBe(false);
    finishOperations.resolve();
    await afterStarted.promise;
    expect(baselines[0]).toBe(baselines[1]);

    const outsiderAttempted = deferred();
    const outsiderCoordinator = createRepositoryEffectCoordinator({
      pollIntervalMs: 2,
      probeProcess: () => {
        outsiderAttempted.resolve();
        return 'live';
      },
    });
    let outsiderAcquired = false;
    const outsiderPromise = outsiderCoordinator.runExclusive({
      cwd: repo,
      allowedDispositions: ['unchanged'],
      operation: () => {
        outsiderAcquired = true;
        return 'outsider';
      },
    });
    await outsiderAttempted.promise;
    expect(outsiderAcquired).toBe(false);
    finishAfter.resolve();

    const cohort = await cohortPromise;
    expect(cohort.invocationId).toBe('invocation-a');
    expect(cohort.baseline).toBe(cohort.receipts.coder.baseline);
    expect(cohort.receipts.coder.classification).toBe('unchanged');
    expect(cohort.receipts.reviewer.classification).toBe('unchanged');
    const outsider = await outsiderPromise;
    expect(outsiderAcquired).toBe(true);
    expect(outsider.receipt.classification).toBe('unchanged');
  });

  it('marks every cohort member ambiguous on a common-after delta', async () => {
    const repo = await initRepository();
    const coordinator = createRepositoryEffectCoordinator();
    const cohort = await coordinator.runCohort({
      cwd: repo,
      invocationId: 'invocation-delta',
      roleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [['coder', 'reviewer']],
      dispositionsByRole: {
        coder: ['unchanged'],
        reviewer: ['unchanged'],
      },
      operations: {
        coder: () => writeFile(join(repo, 'foreign.txt'), 'delta\n', 'utf8'),
        reviewer: async () => undefined,
      },
    });
    expect(cohort.receipts.coder.classification).toBe(
      'observation-ambiguous',
    );
    expect(cohort.receipts.reviewer).toBe(cohort.receipts.coder);
  });

  it('rejects undeclared, duplicate, incomplete, and effect-authorized cohorts before work', async () => {
    const repo = await initRepository();
    const coordinator = createRepositoryEffectCoordinator();
    let starts = 0;
    const operation = async () => {
      starts += 1;
    };
    const base = {
      cwd: repo,
      invocationId: 'invocation-validation',
      roleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [['coder', 'reviewer']],
      dispositionsByRole: {
        coder: ['unchanged'],
        reviewer: ['unchanged'],
      },
      operations: { coder: operation, reviewer: operation },
    };
    await expect(
      coordinator.runCohort({ ...base, concurrentRoleSets: [] }),
    ).rejects.toThrow('not one declared');
    await expect(
      coordinator.runCohort({ ...base, invocationId: '' }),
    ).rejects.toThrow('invocationId');
    await expect(
      coordinator.runCohort({
        ...base,
        roleIds: ['coder', 'coder'],
      }),
    ).rejects.toThrow('distinct');
    await expect(
      coordinator.runCohort({
        ...base,
        operations: { coder: operation },
      }),
    ).rejects.toThrow('exactly match');
    await expect(
      coordinator.runCohort({
        ...base,
        dispositionsByRole: {
          coder: ['one-descendant-commit'],
          reviewer: ['unchanged'],
        },
      }),
    ).rejects.toThrow('exclusively unchanged');
    expect(starts).toBe(0);
  });

  it('keeps different canonical worktrees independent', async () => {
    const firstRepo = await initRepository('playbook-effects-first-');
    const linkedRoot = await mkdtemp(join(tmpdir(), 'playbook-effects-linked-'));
    tempDirs.push(linkedRoot);
    const secondRepo = join(linkedRoot, 'worktree');
    await git(
      firstRepo,
      'worktree',
      'add',
      '--quiet',
      '--detach',
      secondRepo,
      'HEAD',
    );
    const coordinator = createRepositoryEffectCoordinator({ pollIntervalMs: 2 });
    const first = await coordinator.acquire(firstRepo);
    let secondAcquired = false;
    const second = await coordinator.acquire(secondRepo).then((claim) => {
      secondAcquired = true;
      return claim;
    });
    expect(secondAcquired).toBe(true);
    expect(first.identity.worktree).not.toBe(second.identity.worktree);
    await Promise.all([first.release(), second.release()]);
  });
});

describe('schema-3 repository host capabilities', () => {
  it('leaves schema-2-only catalogs independent of Git, leases, and ledgers', async () => {
    const capabilities = await createRepositoryEffectCapabilities({
      cwd: '/not/a/repository',
      catalog: {
        code: { id: 'code', artifactSchema: 2 },
      },
    });

    expect(capabilities).toEqual({});
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'recovers a child process boundary before source-state restoration',
    async () => {
      const repo = await initRepository('playbook-effects-recovery-');
      const ledgerDir = await mkdtemp(join(tmpdir(), 'playbook-effect-ledger-'));
      tempDirs.push(ledgerDir);
      const ledgerPath = join(ledgerDir, 'ledger.json');
      await writeFile(
        ledgerPath,
        `${JSON.stringify(emptyPlaybookEffectLedger())}\n`,
        'utf8',
      );
      const moduleUrl = new URL(
        './bin/repository-effects.js',
        import.meta.url,
      ).href;
      const source = `
        import { readFileSync, renameSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { createRepositoryEffectCapabilities } from ${JSON.stringify(moduleUrl)};

        const ledgerPath = ${JSON.stringify(ledgerPath)};
        const readLedger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'));
        const ledgerService = {
          snapshot: readLedger,
          writeAhead: async (_authority, commands) => {
            const ledger = readLedger();
            let boundaries = [...ledger.boundaries];
            for (const command of commands) {
              if (command.kind === 'start-boundaries') {
                for (const seed of command.boundaries) {
                  boundaries.push({
                    sequence: boundaries.length + 1,
                    ...seed,
                    attemptId: '60000000-0000-4000-8000-000000000001',
                    attemptNumber: 1,
                  });
                }
                continue;
              }
              if (command.kind === 'replace-boundaries') {
                for (const replacement of command.replacements) {
                  const index = boundaries.findIndex(
                    (boundary) => boundary.boundaryId === replacement.expected.boundaryId,
                  );
                  if (
                    index < 0 ||
                    JSON.stringify(boundaries[index]) !== JSON.stringify(replacement.expected)
                  ) throw new Error('child ledger replacement is stale');
                  boundaries[index] = replacement.next;
                }
                continue;
              }
              throw new Error('unsupported child ledger command');
            }
            const next = {
              ...ledger,
              revision: ledger.revision + 1,
              boundaries,
            };
            const stagePath = ledgerPath + '.' + process.pid + '.stage';
            writeFileSync(stagePath, JSON.stringify(next) + '\\n', {
              encoding: 'utf8',
              mode: 0o600,
            });
            renameSync(stagePath, ledgerPath);
            return next;
          },
        };
        const catalog = {
          code: {
            id: 'code',
            artifactSchema: 3,
            requiredRoleIds: ['coder'],
            concurrentRoleSets: [],
          },
        };
        const capabilities = await createRepositoryEffectCapabilities({
          cwd: ${JSON.stringify(repo)},
          catalog,
          sessionId: '10000000-0000-4000-8000-000000000001',
          sessionLease: {
            sessionId: '10000000-0000-4000-8000-000000000001',
            ownerToken: '20000000-0000-4000-8000-000000000002',
            assertOwner: async () => undefined,
          },
          createWriteAhead: () => ledgerService,
        });
        const keepAlive = setInterval(() => undefined, 1_000);
        await capabilities.code.repository.runExclusive({
          effectBoundary: {
            boundaryId: '30000000-0000-4000-8000-000000000003',
            runtimeSessionId: '40000000-0000-4000-8000-000000000004',
            turnId: 1,
            callId: 'coder:1',
            roleId: 'coder',
            sourceStateId: 'code.coder',
            sourceOutcomeSchema: { type: 'object' },
            dispositions: ['unchanged'],
            correctionBudget: { limit: 1, spent: false },
          },
          operation: async () => {
            writeFileSync(join(${JSON.stringify(repo)}, 'child-effect.txt'), 'effect\\n', 'utf8');
            process.stdout.write('effect-written\\n');
            await new Promise(() => undefined);
          },
        });
        clearInterval(keepAlive);
      `;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '--eval', source],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      childProcesses.add(child);
      let childStderr = '';
      child.stderr?.on('data', (chunk) => {
        childStderr += chunk.toString();
      });
      try {
        await expect(waitForLine(child)).resolves.toBe('effect-written');
      } catch (error) {
        throw new Error(`boundary child failed: ${childStderr}`, {
          cause: error,
        });
      }

      const started = assertPlaybookEffectLedger(
        JSON.parse(await readFile(ledgerPath, 'utf8')),
      );
      expect(started).toMatchObject({
        revision: 1,
        boundaries: [
          {
            boundaryId: '30000000-0000-4000-8000-000000000003',
            baseline: { projection: {} },
          },
        ],
      });
      expect(started.boundaries[0]).not.toHaveProperty('physicalReceipt');
      const identity = await resolveCanonicalGitWorktree(repo);
      const claimRoot = join(identity.gitDir, _internal.claimRootName);
      const childOwner = JSON.parse(
        await readFile(join(claimRoot, 'active', 'owner.json'), 'utf8'),
      );
      expect(childOwner.pid).toBe(child.pid);

      child.kill('SIGKILL');
      await waitForExit(child);
      childProcesses.delete(child);

      let sourceRestorationStarted = false;
      const ledgerService = fileBackedEffectLedgerService(ledgerPath, () => {
        if (sourceRestorationStarted) {
          throw new Error('receipt persistence followed source restoration');
        }
      });
      const catalog = {
        code: {
          id: 'code',
          artifactSchema: 3,
          requiredRoleIds: ['coder'],
          concurrentRoleSets: [],
        },
      };
      const capabilities = await createRepositoryEffectCapabilities({
        cwd: repo,
        catalog,
        sessionId: '10000000-0000-4000-8000-000000000001',
        sessionLease: {
          sessionId: '10000000-0000-4000-8000-000000000001',
          ownerToken: '70000000-0000-4000-8000-000000000007',
          assertOwner: async () => undefined,
        },
        createWriteAhead: () => ledgerService,
      });
      const recovered = await recoverIncompleteRepositoryEffects({
        catalog,
        capabilities,
      });
      expect(sourceRestorationStarted).toBe(false);
      expect(recovered).toMatchObject({
        revision: 2,
        boundaries: [
          {
            boundaryId: '30000000-0000-4000-8000-000000000003',
            after: {
              projection: {
                'child-effect.txt': { kind: 'untracked' },
              },
            },
            physicalReceipt: {
              classification: 'concurrent-or-foreign-change',
            },
          },
        ],
      });
      expect(
        assertPlaybookEffectLedger(
          JSON.parse(await readFile(ledgerPath, 'utf8')),
        ),
      ).toEqual(recovered);
      const claimsAfterRecovery = await readdir(claimRoot);
      expect(claimsAfterRecovery).not.toContain('active');
      expect(claimsAfterRecovery).toContain(
        `retired-${childOwner.ownerToken}`,
      );
      expect(
        claimsAfterRecovery.filter((entry) => entry.startsWith('retired-')),
      ).toHaveLength(2);

      sourceRestorationStarted = true;
    },
  );

  it('recovers an incomplete cohort from one observation and one write', async () => {
    const repo = await initRepository('playbook-effects-cohort-recovery-');
    const baseline = await observeGitRepository(repo);
    const common = {
      attemptId: '60000000-0000-4000-8000-000000000006',
      attemptNumber: 1,
      playbookId: 'decide',
      runtimeSessionId: '40000000-0000-4000-8000-000000000004',
      turnId: 1,
      sourceOutcomeSchema: { type: 'object' },
      dispositions: ['unchanged'] as const,
      canonicalWorktree: {
        worktree: baseline.worktree,
        gitDir: baseline.gitDir,
      },
      baseline,
      correctionBudget: { limit: 1 as const, spent: false },
    };
    const initial = assertPlaybookEffectLedger({
      schemaVersion: 1,
      revision: 1,
      boundaries: [
        {
          ...common,
          sequence: 1,
          boundaryId: '30000000-0000-4000-8000-000000000003',
          callId: 'coder:1',
          roleId: 'coder',
          sourceStateId: 'decide.coder',
          cohortId: '70000000-0000-4000-8000-000000000007',
        },
        {
          ...common,
          sequence: 2,
          boundaryId: '50000000-0000-4000-8000-000000000005',
          callId: 'reviewer:1',
          roleId: 'reviewer',
          sourceStateId: 'decide.reviewer',
          cohortId: '70000000-0000-4000-8000-000000000007',
        },
        {
          ...common,
          sequence: 3,
          boundaryId: '80000000-0000-4000-8000-000000000008',
          callId: 'coder:2',
          roleId: 'coder',
          sourceStateId: 'decide.coder',
          cohortId: '90000000-0000-4000-8000-000000000009',
        },
        {
          ...common,
          sequence: 4,
          boundaryId: 'a0000000-0000-4000-8000-00000000000a',
          callId: 'reviewer:2',
          roleId: 'reviewer',
          sourceStateId: 'decide.reviewer',
          cohortId: '90000000-0000-4000-8000-000000000009',
        },
      ],
      logicalOperations: [],
    });
    const { service, writeAhead } = fakeEffectLedgerService(initial);
    const catalog = {
      decide: {
        id: 'decide',
        artifactSchema: 3,
        requiredRoleIds: ['coder', 'reviewer'],
        concurrentRoleSets: [['coder', 'reviewer']],
      },
    };
    const capabilities = await createRepositoryEffectCapabilities({
      cwd: repo,
      catalog,
      sessionId: '10000000-0000-4000-8000-000000000001',
      sessionLease: {
        sessionId: '10000000-0000-4000-8000-000000000001',
        ownerToken: '20000000-0000-4000-8000-000000000002',
        assertOwner: async () => undefined,
      },
      createWriteAhead: () => service,
    });
    await writeFile(join(repo, 'foreign-effect.txt'), 'effect\n', 'utf8');

    const recovered = await recoverIncompleteRepositoryEffects({
      catalog,
      capabilities,
    });

    expect(recovered.revision).toBe(3);
    expect(
      recovered.boundaries.map(
        (boundary) => boundary.physicalReceipt?.classification,
      ),
    ).toEqual([
      'observation-ambiguous',
      'observation-ambiguous',
      'observation-ambiguous',
      'observation-ambiguous',
    ]);
    expect(recovered.boundaries[0]!.after).toEqual(
      recovered.boundaries[1]!.after,
    );
    expect(recovered.boundaries[2]!.after).toEqual(
      recovered.boundaries[3]!.after,
    );
    expect(writeAhead).toHaveBeenCalledTimes(2);
    for (const call of writeAhead.mock.calls) {
      expect(call[1]).toMatchObject([
        {
          kind: 'replace-boundaries',
          replacements: [{}, {}],
        },
      ]);
    }
  });

  it.each(['before', 'after'] as const)(
    'authoritatively recovers a live claim when completion fails %s acknowledgement',
    async (failurePoint) => {
      const repo = await initRepository('playbook-effects-live-recovery-');
      const backing = fakeEffectLedgerService();
      let failCompletion = true;
      const service = {
        snapshot: backing.service.snapshot,
        writeAhead: vi.fn(async (authority: unknown, commands: any[]) => {
          if (
            failCompletion &&
            commands[0]?.kind === 'replace-boundaries'
          ) {
            failCompletion = false;
            if (failurePoint === 'after') {
              await backing.service.writeAhead(authority, commands);
            }
            throw new Error(`completion failed ${failurePoint} acknowledgement`);
          }
          return backing.service.writeAhead(authority, commands);
        }),
      };
      const catalog = {
        code: {
          id: 'code',
          artifactSchema: 3,
          requiredRoleIds: ['coder'],
          concurrentRoleSets: [],
        },
      };
      const semanticCandidate = { guard: 'ok' };
      const operationId = '50000000-0000-4000-8000-000000000005';
      const capabilities = await createRepositoryEffectCapabilities({
        cwd: repo,
        catalog,
        sessionId: '10000000-0000-4000-8000-000000000001',
        sessionLease: {
          sessionId: '10000000-0000-4000-8000-000000000001',
          ownerToken: '20000000-0000-4000-8000-000000000002',
          assertOwner: async () => undefined,
        },
        createWriteAhead: () => service,
      });

      await expect(
        capabilities.code.repository.runExclusive({
          effectBoundary: {
            boundaryId: '30000000-0000-4000-8000-000000000003',
            runtimeSessionId: '40000000-0000-4000-8000-000000000004',
            turnId: 1,
            callId: 'coder:1',
            roleId: 'coder',
            sourceStateId: 'code.coder',
            sourceOutcomeSchema: { type: 'object' },
            dispositions: ['unchanged'],
            correctionBudget: { limit: 1, spent: false },
          },
          operation: async () => {
            await writeFile(join(repo, 'effect.txt'), 'effect\n', 'utf8');
            return 'player output';
          },
          completeEffectBoundary: ({ boundary, operation }: any) => ({
            finalText: operation.value,
            semanticCandidate,
            logicalOperationId: operationId,
            commands: [
              {
                kind: 'append-logical-operations',
                operations: [
                  {
                    operationId,
                    playbookId: 'code',
                    runtimeSessionId: boundary.runtimeSessionId,
                    boundaryIds: [boundary.boundaryId],
                    originalBaseline: boundary.baseline,
                    checkpointRestorationEligible: false,
                  },
                ],
              },
            ],
          }),
        }),
      ).rejects.toThrow(`completion failed ${failurePoint} acknowledgement`);
      semanticCandidate.guard = 'mutated';

      const recovered = await recoverIncompleteRepositoryEffects({
        catalog,
        capabilities,
      });
      expect(recovered).toMatchObject({
        revision: 2,
        boundaries: [
          {
            finalText: 'player output',
            semanticCandidate: { guard: 'ok' },
            logicalOperationId: operationId,
            physicalReceipt: {
              classification: 'concurrent-or-foreign-change',
            },
          },
        ],
        logicalOperations: [
          {
            operationId,
            boundaryIds: ['30000000-0000-4000-8000-000000000003'],
          },
        ],
      });
      const claim = await createRepositoryEffectCoordinator().acquire(repo);
      await claim.release();
    },
  );

  it.each(['exclusive', 'cohort'] as const)(
    'keeps a live %s claim quarantined when completion mapping cannot produce an exact batch',
    async (mode) => {
      const repo = await initRepository('playbook-effects-mapper-failure-');
      const backing = fakeEffectLedgerService();
      const operation = vi.fn(async ({ roleId }: { roleId?: string }) =>
        roleId ?? 'coder',
      );
      const completeEffectBoundary = vi.fn(() => {
        throw new Error('synthetic completion mapping failure');
      });
      const playbookId = mode === 'exclusive' ? 'code' : 'decide';
      const catalog = {
        [playbookId]: {
          id: playbookId,
          artifactSchema: 3,
          requiredRoleIds:
            mode === 'exclusive' ? ['coder'] : ['coder', 'reviewer'],
          concurrentRoleSets:
            mode === 'exclusive' ? [] : [['coder', 'reviewer']],
        },
      };
      const capabilities = await createRepositoryEffectCapabilities({
        cwd: repo,
        catalog,
        sessionId: '10000000-0000-4000-8000-000000000001',
        sessionLease: {
          sessionId: '10000000-0000-4000-8000-000000000001',
          ownerToken: '20000000-0000-4000-8000-000000000002',
          assertOwner: async () => undefined,
        },
        createWriteAhead: () => backing.service,
      });
      const boundary = (roleId: string, boundaryId: string) => ({
        boundaryId,
        runtimeSessionId: '40000000-0000-4000-8000-000000000004',
        turnId: 1,
        callId: `${roleId}:1`,
        roleId,
        sourceStateId: `${playbookId}.${roleId}`,
        sourceOutcomeSchema: { type: 'object' },
        dispositions: ['unchanged'],
        correctionBudget: { limit: 1, spent: false },
      });

      const run =
        mode === 'exclusive'
          ? capabilities[playbookId].repository.runExclusive({
              effectBoundary: boundary(
                'coder',
                '30000000-0000-4000-8000-000000000003',
              ),
              operation,
              completeEffectBoundary,
            })
          : capabilities[playbookId].repository.runCohort({
              invocationId: 'proposal-pair',
              roleIds: ['coder', 'reviewer'],
              dispositionsByRole: {
                coder: ['unchanged'],
                reviewer: ['unchanged'],
              },
              effectBoundaries: {
                coder: boundary(
                  'coder',
                  '30000000-0000-4000-8000-000000000003',
                ),
                reviewer: boundary(
                  'reviewer',
                  '50000000-0000-4000-8000-000000000005',
                ),
              },
              operations: { coder: operation, reviewer: operation },
              completeEffectBoundary,
            });

      await expect(run).rejects.toThrow(/synthetic completion mapping failure/);
      expect(operation).toHaveBeenCalledTimes(mode === 'exclusive' ? 1 : 2);
      expect(backing.writeAhead).toHaveBeenCalledTimes(1);
      expect(
        backing.service.snapshot().boundaries.every(
          (saved) => saved.physicalReceipt === undefined,
        ),
      ).toBe(true);
      await expect(
        recoverIncompleteRepositoryEffects({ catalog, capabilities }),
      ).rejects.toThrow(
        /live post-operation repository claim has no exact completion batch/,
      );
      expect(operation).toHaveBeenCalledTimes(mode === 'exclusive' ? 1 : 2);
      expect(backing.writeAhead).toHaveBeenCalledTimes(1);

      const identity = await resolveCanonicalGitWorktree(repo);
      const claimNames = await readdir(
        join(identity.gitDir, _internal.claimRootName),
      );
      expect(claimNames).toContain('active');
      expect(claimNames.some((name) => name.startsWith('retired-'))).toBe(false);
    },
  );

  it.each(['before', 'after'] as const)(
    'resolves an indeterminate boundary start %s acknowledgement without player work',
    async (failurePoint) => {
      const repo = await initRepository('playbook-effects-start-recovery-');
      const backing = fakeEffectLedgerService();
      let failStart = true;
      const service = {
        snapshot: backing.service.snapshot,
        writeAhead: vi.fn(async (authority: unknown, commands: any[]) => {
          if (failStart && commands[0]?.kind === 'start-boundaries') {
            failStart = false;
            if (failurePoint === 'after') {
              await backing.service.writeAhead(authority, commands);
            }
            throw new Error(`start failed ${failurePoint} acknowledgement`);
          }
          return backing.service.writeAhead(authority, commands);
        }),
      };
      const catalog = {
        code: {
          id: 'code',
          artifactSchema: 3,
          requiredRoleIds: ['coder'],
          concurrentRoleSets: [],
        },
      };
      const capabilities = await createRepositoryEffectCapabilities({
        cwd: repo,
        catalog,
        sessionId: '10000000-0000-4000-8000-000000000001',
        sessionLease: {
          sessionId: '10000000-0000-4000-8000-000000000001',
          ownerToken: '20000000-0000-4000-8000-000000000002',
          assertOwner: async () => undefined,
        },
        createWriteAhead: () => service,
      });
      const operation = vi.fn(async () => 'must not run');

      await expect(
        capabilities.code.repository.runExclusive({
          effectBoundary: {
            boundaryId: '30000000-0000-4000-8000-000000000003',
            runtimeSessionId: '40000000-0000-4000-8000-000000000004',
            turnId: 1,
            callId: 'coder:1',
            roleId: 'coder',
            sourceStateId: 'code.coder',
            sourceOutcomeSchema: { type: 'object' },
            dispositions: ['unchanged'],
            correctionBudget: { limit: 1, spent: false },
          },
          operation,
        }),
      ).rejects.toThrow(`start failed ${failurePoint} acknowledgement`);
      expect(operation).not.toHaveBeenCalled();

      const recovered = await recoverIncompleteRepositoryEffects({
        catalog,
        capabilities,
      });
      expect(recovered).toMatchObject({
        revision: 2,
        boundaries: [
          { physicalReceipt: { classification: 'unchanged' } },
        ],
      });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('persists recovery before the shared host refuses stale source restoration', async () => {
    const repo = await initRepository('playbook-effects-host-recovery-');
    const baseline = await observeGitRepository(repo);
    const initial = assertPlaybookEffectLedger({
      schemaVersion: 1,
      revision: 1,
      boundaries: [
        {
          sequence: 1,
          boundaryId: '30000000-0000-4000-8000-000000000003',
          attemptId: '60000000-0000-4000-8000-000000000006',
          attemptNumber: 1,
          playbookId: 'code',
          runtimeSessionId: '40000000-0000-4000-8000-000000000004',
          turnId: 1,
          callId: 'coder:1',
          roleId: 'coder',
          sourceStateId: 'code.coder',
          sourceOutcomeSchema: { type: 'object' },
          dispositions: ['unchanged'],
          canonicalWorktree: {
            worktree: baseline.worktree,
            gitDir: baseline.gitDir,
          },
          baseline,
          correctionBudget: { limit: 1, spent: false },
        },
      ],
      logicalOperations: [],
    });
    const { service } = fakeEffectLedgerService(initial);
    const catalog = {
      code: {
        id: 'code',
        artifactSchema: 3,
        requiredRoleIds: ['coder'],
        concurrentRoleSets: [],
      },
    };
    const createHostRuntime = vi.fn();

    await expect(
      createCaptainSessionHost({
        config: { catalog },
        sessionId: '10000000-0000-4000-8000-000000000001',
        cwd: repo,
        sessionLease: {
          sessionId: '10000000-0000-4000-8000-000000000001',
          ownerToken: '20000000-0000-4000-8000-000000000002',
          assertOwner: async () => undefined,
        },
        loadModule: vi.fn(),
        observers: [],
        createHostRuntime,
        createEffectLedgerWriteAhead: () => service,
        restoreSnapshot: { effectLedger: initial },
      } as any),
    ).rejects.toThrow(
      /effect ledger requires reconciliation before source-state restoration/,
    );
    expect(service.snapshot().boundaries[0]).toHaveProperty(
      'physicalReceipt.classification',
      'unchanged',
    );
    expect(createHostRuntime).not.toHaveBeenCalled();
  });

  it('rejects a stored worktree outside current host authority before claiming it', async () => {
    const authorityRepo = await initRepository('playbook-effects-authority-');
    const foreignRepo = await initRepository('playbook-effects-foreign-');
    const baseline = await observeGitRepository(foreignRepo);
    const initial = assertPlaybookEffectLedger({
      schemaVersion: 1,
      revision: 1,
      boundaries: [
        {
          sequence: 1,
          boundaryId: '30000000-0000-4000-8000-000000000003',
          attemptId: '60000000-0000-4000-8000-000000000006',
          attemptNumber: 1,
          playbookId: 'code',
          runtimeSessionId: '40000000-0000-4000-8000-000000000004',
          turnId: 1,
          callId: 'coder:1',
          roleId: 'coder',
          sourceStateId: 'code.coder',
          sourceOutcomeSchema: { type: 'object' },
          dispositions: ['unchanged'],
          canonicalWorktree: {
            worktree: baseline.worktree,
            gitDir: baseline.gitDir,
          },
          baseline,
          correctionBudget: { limit: 1, spent: false },
        },
      ],
      logicalOperations: [],
    });
    const { service, writeAhead } = fakeEffectLedgerService(initial);
    const catalog = {
      code: {
        id: 'code',
        artifactSchema: 3,
        requiredRoleIds: ['coder'],
        concurrentRoleSets: [],
      },
    };
    const capabilities = await createRepositoryEffectCapabilities({
      cwd: authorityRepo,
      catalog,
      sessionId: '10000000-0000-4000-8000-000000000001',
      sessionLease: {
        sessionId: '10000000-0000-4000-8000-000000000001',
        ownerToken: '20000000-0000-4000-8000-000000000002',
        assertOwner: async () => undefined,
      },
      createWriteAhead: () => service,
    });

    await expect(
      recoverIncompleteRepositoryEffects({ catalog, capabilities }),
    ).rejects.toThrow(/does not match current host authority/);
    expect(writeAhead).not.toHaveBeenCalled();
    await expect(
      lstat(join(baseline.gitDir, _internal.claimRootName)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('assembles immutable artifact-bound facilities from the active lease', async () => {
    const repo = await initRepository();
    const authorityOrder: string[] = [];
    const assertOwner = vi.fn(async () => {
      authorityOrder.push('lease');
    });
    const sessionLease = Object.freeze({
      sessionId: '10000000-0000-4000-8000-000000000001',
      ownerToken: '20000000-0000-4000-8000-000000000002',
      assertOwner,
    });
    const { service: ledgerService, writeAhead } =
      fakeEffectLedgerService();
    const capabilities = await createRepositoryEffectCapabilities({
      cwd: repo,
      catalog: {
        decide: {
          id: 'decide',
          artifactSchema: 3,
          requiredRoleIds: ['coder', 'reviewer'],
          concurrentRoleSets: [['coder', 'reviewer']],
        },
      },
      sessionId: sessionLease.sessionId,
      sessionLease,
      createWriteAhead: () => {
        authorityOrder.push('writer');
        return ledgerService;
      },
    });
    const capability = capabilities.decide;

    expect(assertOwner).toHaveBeenCalledTimes(2);
    expect(authorityOrder).toEqual(['lease', 'writer', 'lease']);
    expect(Object.keys(capabilities)).toEqual(['decide']);
    expect(capability.authority).toMatchObject({
      playbookId: 'decide',
      artifactSchema: 3,
      cwd: repo,
      sessionId: sessionLease.sessionId,
      leaseOwnerToken: sessionLease.ownerToken,
      requiredRoleIds: ['coder', 'reviewer'],
      concurrentRoleSets: [['coder', 'reviewer']],
    });
    expect(capability.repository.identity).toBe(
      capability.authority.canonicalWorktree,
    );
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.authority.concurrentRoleSets[0])).toBe(
      true,
    );

    const observation = await capability.repository.observe();
    expect(observation.worktree).toBe(
      capability.authority.canonicalWorktree.worktree,
    );
    const cohort = await capability.repository.runCohort({
      invocationId: 'decide-proposal',
      roleIds: ['coder', 'reviewer'],
      dispositionsByRole: {
        coder: ['unchanged'],
        reviewer: ['unchanged'],
      },
      operations: {
        coder: async () => 'coder',
        reviewer: async () => 'reviewer',
      },
      effectBoundaries: {
        coder: {
          boundaryId: '30000000-0000-4000-8000-000000000003',
          runtimeSessionId: '40000000-0000-4000-8000-000000000004',
          turnId: 1,
          callId: 'coder:1',
          roleId: 'coder',
          sourceStateId: 'decide.coder',
          sourceOutcomeSchema: { type: 'object' },
          dispositions: ['unchanged'],
          correctionBudget: { limit: 1, spent: false },
        },
        reviewer: {
          boundaryId: '50000000-0000-4000-8000-000000000005',
          runtimeSessionId: '40000000-0000-4000-8000-000000000004',
          turnId: 1,
          callId: 'reviewer:1',
          roleId: 'reviewer',
          sourceStateId: 'decide.reviewer',
          sourceOutcomeSchema: { type: 'object' },
          dispositions: ['unchanged'],
          correctionBudget: { limit: 1, spent: false },
        },
      },
      completeEffectBoundary: ({ operation, roleId }: any) => ({
        finalText: operation.value,
        semanticCandidate: { roleId },
      }),
    });
    expect(cohort.receipts.coder.classification).toBe('unchanged');
    expect(cohort.receipts.reviewer).toBe(cohort.receipts.coder);
    await expect(
      capability.repository.runCohort({
        cwd: repo,
        concurrentRoleSets: [],
      }),
    ).rejects.toThrow(/cannot override host-owned cwd/);

    expect(capability.effectLedger.snapshot()).toEqual(cohort.effectLedger);
    expect(cohort.effectLedger).toMatchObject({
      schemaVersion: 1,
      revision: 2,
      boundaries: [
        {
          roleId: 'coder',
          finalText: 'coder',
          semanticCandidate: { roleId: 'coder' },
          physicalReceipt: { classification: 'unchanged' },
        },
        {
          roleId: 'reviewer',
          finalText: 'reviewer',
          semanticCandidate: { roleId: 'reviewer' },
          physicalReceipt: { classification: 'unchanged' },
        },
      ],
    });
    expect(writeAhead).toHaveBeenCalledTimes(2);
    expect(writeAhead.mock.calls.map(([, commands]) => commands[0].kind)).toEqual(
      ['start-boundaries', 'replace-boundaries'],
    );
    for (const [authority] of writeAhead.mock.calls) {
      expect(authority).toBe(capability.authority);
    }
  });

  it('binds repeated deferred checkpoints and reconciles one cumulative receipt', async () => {
    const repo = await initRepository('playbook-deferred-chain-');
    const backing = fakeEffectLedgerService();
    const sessionId = '10000000-0000-4000-8000-000000000001';
    const runtimeSessionId = '40000000-0000-4000-8000-000000000004';
    const operationId = '50000000-0000-4000-8000-000000000005';
    const capability = (
      await createRepositoryEffectCapabilities({
        cwd: repo,
        catalog: {
          code: {
            id: 'code',
            artifactSchema: 3,
            requiredRoleIds: ['coder'],
            concurrentRoleSets: [],
          },
        },
        sessionId,
        sessionLease: {
          sessionId,
          ownerToken: '20000000-0000-4000-8000-000000000002',
          assertOwner: async () => undefined,
        },
        createWriteAhead: () => backing.service,
      })
    ).code;
    const effectBoundary = (
      boundaryId: string,
      turnId: number,
      callId: string,
    ) => ({
      boundaryId,
      runtimeSessionId,
      turnId,
      callId,
      roleId: 'coder',
      sourceStateId: 'code.coder',
      sourceOutcomeSchema: { needsBossReply: {}, committed: {} },
      dispositions: ['deferred', 'one-descendant-commit'],
      correctionBudget: { limit: 1, spent: false },
    });

    const first = await capability.repository.runExclusive({
      effectBoundary: effectBoundary(
        '30000000-0000-4000-8000-000000000003',
        1,
        'player-1',
      ),
      operation: async () => ({
        status: 'ok',
        finalText: 'Which file should I edit?',
        resumeToken: 'thread-1',
      }),
      completeEffectBoundary: ({ operation }: any) => ({
        finalText: operation.value.finalText,
        semanticCandidate: {
          guard: 'needsBossReply',
          question: operation.value.finalText,
        },
        deferred: {
          operationId,
          pendingQuestion: {
            questionId: 'code.coder',
            asker: { kind: 'role', roleId: 'coder' },
            question: operation.value.finalText,
            sourceItem: 'playbook-1',
          },
          playerContinuation: operation.value.resumeToken,
        },
      }),
    });
    expect(first.deferredStatus).toBe('bound');
    expect(first.effectLedger.logicalOperations[0]).toMatchObject({
      operationId,
      boundaryIds: ['30000000-0000-4000-8000-000000000003'],
      checkpointRestorationEligible: false,
      pendingQuestion: { question: 'Which file should I edit?' },
      playerContinuation: 'thread-1',
    });
    const originalBaseline = first.effectLedger.logicalOperations[0]
      .originalBaseline;

    const repeated = await capability.repository.runDeferred({
      mode: 'continue',
      operationId,
      effectBoundary: effectBoundary(
        '60000000-0000-4000-8000-000000000006',
        2,
        'player-2',
      ),
      operation: async ({ playerContinuation }: any) => {
        expect(playerContinuation).toBe('thread-1');
        await writeFile(join(repo, 'draft.txt'), 'draft\n', 'utf8');
        return {
          status: 'ok',
          finalText: 'Should the draft be committed?',
          resumeToken: 'thread-2',
        };
      },
      completeEffectBoundary: ({ operation }: any) => ({
        finalText: operation.value.finalText,
        semanticCandidate: {
          guard: 'needsBossReply',
          question: operation.value.finalText,
        },
        deferred: {
          pendingQuestion: {
            questionId: 'code.coder',
            asker: { kind: 'role', roleId: 'coder' },
            question: operation.value.finalText,
            sourceItem: 'playbook-1',
          },
          playerContinuation: operation.value.resumeToken,
        },
      }),
    });
    expect(repeated).toMatchObject({
      status: 'continued',
      deferredStatus: 'bound',
      receipt: { classification: 'worktree-only-change' },
    });
    expect(repeated.effectLedger.logicalOperations[0]).toMatchObject({
      operationId,
      boundaryIds: [
        '30000000-0000-4000-8000-000000000003',
        '60000000-0000-4000-8000-000000000006',
      ],
      originalBaseline,
      pendingQuestion: { question: 'Should the draft be committed?' },
      playerContinuation: 'thread-2',
    });
    expect(repeated.effectLedger.boundaries[1]).toMatchObject({
      logicalOperationId: operationId,
      physicalReceipt: { classification: 'worktree-only-change' },
    });

    const final = await capability.repository.runDeferred({
      mode: 'continue',
      operationId,
      effectBoundary: effectBoundary(
        '70000000-0000-4000-8000-000000000007',
        3,
        'player-3',
      ),
      operation: async ({ playerContinuation }: any) => {
        expect(playerContinuation).toBe('thread-2');
        await git(repo, 'add', '--', 'draft.txt');
        await git(repo, 'commit', '--quiet', '-m', 'finish draft');
        return {
          status: 'ok',
          finalText: 'Committed.',
          resumeToken: 'thread-3',
        };
      },
      completeEffectBoundary: ({ operation }: any) => ({
        finalText: operation.value.finalText,
        semanticCandidate: { guard: 'committed' },
      }),
    });
    expect(final).toMatchObject({
      status: 'continued',
      receipt: { classification: 'observation-ambiguous' },
      logicalReceipt: { classification: 'one-descendant-commit' },
    });
    expect(final.effectLedger.logicalOperations[0]).toMatchObject({
      operationId,
      originalBaseline,
      boundaryIds: [
        '30000000-0000-4000-8000-000000000003',
        '60000000-0000-4000-8000-000000000006',
        '70000000-0000-4000-8000-000000000007',
      ],
      logicalReceipt: { classification: 'one-descendant-commit' },
    });
    expect(final.effectLedger.logicalOperations[0]).not.toHaveProperty(
      'pendingQuestion',
    );
    expect(final.effectLedger.boundaries).toHaveLength(3);
  });

  it('fences mismatched deferred checkpoints and restores or parks without a call', async () => {
    const repo = await initRepository('playbook-deferred-mismatch-');
    const backing = fakeEffectLedgerService();
    const sessionId = '10000000-0000-4000-8000-000000000001';
    const runtimeSessionId = '40000000-0000-4000-8000-000000000004';
    const operationId = '50000000-0000-4000-8000-000000000005';
    const capability = (
      await createRepositoryEffectCapabilities({
        cwd: repo,
        catalog: {
          code: {
            id: 'code',
            artifactSchema: 3,
            requiredRoleIds: ['coder'],
            concurrentRoleSets: [],
          },
        },
        sessionId,
        sessionLease: {
          sessionId,
          ownerToken: '20000000-0000-4000-8000-000000000002',
          assertOwner: async () => undefined,
        },
        createWriteAhead: () => backing.service,
      })
    ).code;
    await capability.repository.runExclusive({
      effectBoundary: {
        boundaryId: '30000000-0000-4000-8000-000000000003',
        runtimeSessionId,
        turnId: 1,
        callId: 'player-1',
        roleId: 'coder',
        sourceStateId: 'code.coder',
        sourceOutcomeSchema: { needsBossReply: {}, committed: {} },
        dispositions: ['deferred', 'one-descendant-commit'],
        correctionBudget: { limit: 1, spent: false },
      },
      operation: async () => 'question',
      completeEffectBoundary: () => ({
        deferred: {
          operationId,
          pendingQuestion: {
            questionId: 'code.coder',
            asker: { kind: 'role', roleId: 'coder' },
            question: 'May I proceed?',
          },
          playerContinuation: false,
        },
      }),
    });
    await writeFile(join(repo, 'foreign.txt'), 'foreign\n', 'utf8');
    const player = vi.fn(async () => 'must not run');
    const mismatched = await capability.repository.runDeferred({
      mode: 'continue',
      operationId,
      effectBoundary: {
        boundaryId: '60000000-0000-4000-8000-000000000006',
        runtimeSessionId,
        turnId: 2,
        callId: 'player-2',
        roleId: 'coder',
        sourceStateId: 'code.coder',
        sourceOutcomeSchema: { needsBossReply: {}, committed: {} },
        dispositions: ['deferred', 'one-descendant-commit'],
        correctionBudget: { limit: 1, spent: false },
      },
      operation: player,
      completeEffectBoundary: () => ({ unresolved: true }),
    });
    expect(mismatched.status).toBe('checkpoint-mismatch');
    expect(player).not.toHaveBeenCalled();
    expect(mismatched.effectLedger.logicalOperations[0]).toMatchObject({
      checkpointRestorationEligible: true,
      pendingQuestion: { question: 'May I proceed?' },
      playerContinuation: false,
    });
    const reused = await capability.repository.runDeferred({
      mode: 'continue',
      operationId,
      effectBoundary: {
        boundaryId: '70000000-0000-4000-8000-000000000007',
        runtimeSessionId,
        turnId: 2,
        callId: 'player-3',
        roleId: 'coder',
        sourceStateId: 'code.coder',
        sourceOutcomeSchema: { needsBossReply: {}, committed: {} },
        dispositions: ['deferred', 'one-descendant-commit'],
        correctionBudget: { limit: 1, spent: false },
      },
      operation: player,
      completeEffectBoundary: () => ({ unresolved: true }),
    });
    expect(reused.status).toBe('ineligible');
    expect(player).not.toHaveBeenCalled();
    expect(
      await capability.repository.runDeferred({
        mode: 'restore',
        operationId,
      }),
    ).toMatchObject({ status: 'checkpoint-mismatch' });
    await rm(join(repo, 'foreign.txt'));
    const restored = await capability.repository.runDeferred({
      mode: 'restore',
      operationId,
    });
    expect(restored).toMatchObject({
      status: 'restored',
      effectLedger: {
        logicalOperations: [{ checkpointRestorationEligible: false }],
      },
    });
    const parked = await capability.repository.runDeferred({
      mode: 'park',
      operationId,
    });
    expect(parked.status).toBe('parked');
    expect(parked.effectLedger.logicalOperations[0]).not.toHaveProperty(
      'checkpoint',
    );
    expect(
      await capability.repository.runDeferred({
        mode: 'restore',
        operationId,
      }),
    ).toMatchObject({ status: 'ineligible' });
    expect(player).not.toHaveBeenCalled();
    expect(parked.effectLedger.boundaries).toHaveLength(1);
  });

  it('withholds an initial deferred binding when its completed checkpoint is ineligible', async () => {
    const repo = await initRepository('playbook-deferred-ineligible-');
    const backing = fakeEffectLedgerService();
    const sessionId = '10000000-0000-4000-8000-000000000001';
    const operationId = '50000000-0000-4000-8000-000000000005';
    const capability = (
      await createRepositoryEffectCapabilities({
        cwd: repo,
        catalog: {
          code: {
            id: 'code',
            artifactSchema: 3,
            requiredRoleIds: ['coder'],
            concurrentRoleSets: [],
          },
        },
        sessionId,
        sessionLease: {
          sessionId,
          ownerToken: '20000000-0000-4000-8000-000000000002',
          assertOwner: async () => undefined,
        },
        createWriteAhead: () => backing.service,
      })
    ).code;
    const result = await capability.repository.runExclusive({
      effectBoundary: {
        boundaryId: '30000000-0000-4000-8000-000000000003',
        runtimeSessionId: '40000000-0000-4000-8000-000000000004',
        turnId: 1,
        callId: 'player-1',
        roleId: 'coder',
        sourceStateId: 'code.coder',
        sourceOutcomeSchema: { needsBossReply: {}, committed: {} },
        dispositions: ['deferred', 'one-descendant-commit'],
        correctionBudget: { limit: 1, spent: false },
      },
      operation: async () => {
        await commitFile(repo, 'committed.txt', 'committed\n', 'effect');
        return 'May I continue?';
      },
      completeEffectBoundary: ({ operation }: any) => ({
        finalText: operation.value,
        semanticCandidate: {
          guard: 'needsBossReply',
          question: operation.value,
        },
        deferred: {
          operationId,
          pendingQuestion: {
            questionId: 'code.coder',
            asker: { kind: 'role', roleId: 'coder' },
            question: operation.value,
          },
          playerContinuation: 'thread-1',
        },
      }),
    });
    expect(result).toMatchObject({
      deferredStatus: 'unresolved',
      receipt: { classification: 'one-descendant-commit' },
      effectLedger: {
        boundaries: [
          {
            logicalOperationId: operationId,
            semanticCandidate: { guard: 'needsBossReply' },
          },
        ],
        logicalOperations: [
          {
            operationId,
            checkpointRestorationEligible: false,
          },
        ],
      },
    });
    expect(result.effectLedger.logicalOperations[0]).not.toHaveProperty(
      'pendingQuestion',
    );
  });

  it.each(['before', 'after'] as const)(
    'recovers an indeterminate deferred checkpoint fence %s acknowledgement without a call',
    async (failurePoint) => {
      const repo = await initRepository('playbook-deferred-recovery-');
      const backing = fakeEffectLedgerService();
      let failFence = true;
      const service = {
        snapshot: backing.service.snapshot,
        writeAhead: vi.fn(async (authority: unknown, commands: any[]) => {
          if (
            failFence &&
            commands[0]?.kind === 'replace-logical-operations'
          ) {
            failFence = false;
            if (failurePoint === 'after') {
              await backing.service.writeAhead(authority, commands);
            }
            throw new Error(`deferred fence failed ${failurePoint} acknowledgement`);
          }
          return backing.service.writeAhead(authority, commands);
        }),
      };
      const sessionId = '10000000-0000-4000-8000-000000000001';
      const runtimeSessionId = '40000000-0000-4000-8000-000000000004';
      const operationId = '50000000-0000-4000-8000-000000000005';
      const catalog = {
        code: {
          id: 'code',
          artifactSchema: 3,
          requiredRoleIds: ['coder'],
          concurrentRoleSets: [],
        },
      };
      const capabilities = await createRepositoryEffectCapabilities({
        cwd: repo,
        catalog,
        sessionId,
        sessionLease: {
          sessionId,
          ownerToken: '20000000-0000-4000-8000-000000000002',
          assertOwner: async () => undefined,
        },
        createWriteAhead: () => service,
      });
      const capability = capabilities.code;
      await capability.repository.runExclusive({
        effectBoundary: {
          boundaryId: '30000000-0000-4000-8000-000000000003',
          runtimeSessionId,
          turnId: 1,
          callId: 'player-1',
          roleId: 'coder',
          sourceStateId: 'code.coder',
          sourceOutcomeSchema: { needsBossReply: {}, committed: {} },
          dispositions: ['deferred', 'one-descendant-commit'],
          correctionBudget: { limit: 1, spent: false },
        },
        operation: async () => 'question',
        completeEffectBoundary: () => ({
          deferred: {
            operationId,
            pendingQuestion: {
              questionId: 'code.coder',
              asker: { kind: 'role', roleId: 'coder' },
              question: 'May I continue?',
            },
            playerContinuation: false,
          },
        }),
      });
      await writeFile(join(repo, 'foreign.txt'), 'foreign\n', 'utf8');
      const player = vi.fn(async () => 'must not run');
      await expect(
        capability.repository.runDeferred({
          mode: 'continue',
          operationId,
          effectBoundary: {
            boundaryId: '60000000-0000-4000-8000-000000000006',
            runtimeSessionId,
            turnId: 2,
            callId: 'player-2',
            roleId: 'coder',
            sourceStateId: 'code.coder',
            sourceOutcomeSchema: { needsBossReply: {}, committed: {} },
            dispositions: ['deferred', 'one-descendant-commit'],
            correctionBudget: { limit: 1, spent: false },
          },
          operation: player,
          completeEffectBoundary: () => ({ unresolved: true }),
        }),
      ).rejects.toThrow(
        `deferred fence failed ${failurePoint} acknowledgement`,
      );
      expect(player).not.toHaveBeenCalled();

      const recovered = await recoverIncompleteRepositoryEffects({
        catalog,
        capabilities,
      });
      expect(recovered.logicalOperations[0]).toMatchObject({
        operationId,
        checkpointRestorationEligible: true,
        pendingQuestion: { question: 'May I continue?' },
      });
      const claim = await createRepositoryEffectCoordinator().acquire(repo);
      await claim.release();
    },
  );

  it('rejects a lease for a different logical session before host work', async () => {
    const assertOwner = vi.fn(async () => undefined);
    const writeAhead = vi.fn(async () => undefined);

    await expect(
      createRepositoryEffectCapabilities({
        cwd: '/must/not/reach/git',
        catalog: {
          code: {
            id: 'code',
            artifactSchema: 3,
            requiredRoleIds: ['coder'],
            concurrentRoleSets: [],
          },
        },
        sessionId: '10000000-0000-4000-8000-000000000001',
        sessionLease: {
          sessionId: '10000000-0000-4000-8000-000000000002',
          ownerToken: '20000000-0000-4000-8000-000000000003',
          assertOwner,
        },
        createWriteAhead: () => writeAhead,
      }),
    ).rejects.toThrow(/lease authority does not match its logical session/);
    expect(assertOwner).not.toHaveBeenCalled();
    expect(writeAhead).not.toHaveBeenCalled();
  });
});
