// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertWorkflowTerminal } from '../../../scripts/test-support/workflow-contracts.mjs';

import {
  assertPlaybookEffectLedger,
  emptyPlaybookEffectLedger,
} from '../../../src/xstate-runtime.js';
import createPlaybookRuntime, {
  type PlaybookCallRequest,
  type PlaybookCallStart,
  type PlaybookPorts,
  type PlaybookRuntime,
  type PlaybookSession,
  type PlayerResult,
} from './pr.playbook.js';
import prPlaybookRegistryEntry, {
  prCopyPasteGuardNames,
  prStateCountLabels,
  validatePrOptions,
} from './pr.registry.js';
import { createRepositoryEffectCapabilities } from '../code.playbook/bin/repository-effects.js';

// Every test drives the real linked runtime against a fresh temporary Git
// repository with a bare "origin" remote. `git` is real; `gh` and `sleep`
// are PATH shims that record their calls and answer from control files, so
// no test reaches GitHub and the wait loops' poll intervals are instant.
vi.setConfig({ testTimeout: 60_000 });

const PULL_REQUEST_URL = 'https://github.com/acme/widgets/pull/12';
const OPENED = {
  guard: 'opened',
  pullRequest: '12',
  pullRequestUrl: PULL_REQUEST_URL,
} as const;
const BRANCH = 'issue-12-fix-retry';
const CALLER_INPUT = [
  'Original request: fix #12 — the retry loop gives up after one attempt.',
  'Issue summary: retries must back off three times before failing.',
  `Branch: ${BRANCH}`,
].join('\n');
const FIX_CODING_REQUEST =
  "The pull request's checks are red on the checked-out branch. Inspect the failing checks with `gh pr checks` and `gh run view --log-failed`, fix their cause on this branch with a minimal change, and make the checks pass.";

const MERGED_DESCRIPTION =
  'The pull request is merged with a merge commit on the repository default branch, which is checked out and fast-forwarded to the merged head; the merge requested deletion of the remote and local branch.';

type RepositoryEffect = 'publish' | 'unchanged' | 'commit' | 'worktree';

type PlayerFixture = PlayerResult & {
  readonly repositoryEffect?: RepositoryEffect;
};

type ChildFixture =
  | PlaybookCallStart
  | Error
  | ((request: PlaybookCallRequest) => Promise<PlaybookCallStart | Error>);

interface Fixtures {
  players: PlayerFixture[];
  judges: unknown[];
  children: ChildFixture[];
}

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};

afterEach(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8' },
  );
  return stdout.trim();
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
}

// A working repository on the feature branch with one reviewed commit past
// `main`, and a bare remote holding `main` — the state CODE leaves for PR.
async function initRepository(): Promise<{
  root: string;
  repo: string;
  remote: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-')));
  tempDirs.push(root);
  const remote = join(root, 'origin.git');
  const repo = join(root, 'work');
  await mkdir(repo);
  await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  await git(repo, 'init', '--quiet', '--initial-branch=main');
  await git(repo, 'config', 'user.name', 'PR Delivery Test');
  await git(repo, 'config', 'user.email', 'pr@example.invalid');
  await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8');
  await git(repo, 'add', '--all');
  await git(repo, 'commit', '--quiet', '-m', 'base');
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  await git(repo, 'checkout', '--quiet', '-b', BRANCH);
  await writeFile(join(repo, 'retry.txt'), 'retry three times\n', 'utf8');
  await git(repo, 'add', '--all');
  await git(repo, 'commit', '--quiet', '-m', 'Retry three times before failing');
  return { root, repo, remote };
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
              throw new Error('PR test effect-ledger replacement is stale');
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
              throw new Error('PR test logical-operation replacement is stale');
            }
            logicalOperations[index] = replacement.next;
          }
          continue;
        }
        throw new Error(`unsupported PR test ledger command ${command.kind}`);
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

// The fake GitHub merge performs, against the temporary remote, what
// `gh pr merge --merge --delete-branch --match-head-commit` does: it refuses
// a moved head, merges the branch into `main` with a merge commit, switches
// the local checkout to `main` (left behind, as gh leaves it when its own
// fast-forward is only a warning), and deletes the local and remote branch.
function successfulMergeScript(repo: string, remote: string): string {
  return [
    '#!/bin/sh',
    'set -e',
    `[ "$(git rev-parse --show-toplevel)" = '${repo}' ] || { echo 'fake gh: wrong worktree' >&2; exit 70; }`,
    '[ "$6" = "$(git rev-parse HEAD)" ] || { echo "fake gh: head moved" >&2; exit 1; }',
    'branch=$(git rev-parse --abbrev-ref HEAD)',
    'scratch=$(mktemp -d)',
    `git clone -q '${remote}' "$scratch"`,
    'git -C "$scratch" -c user.name=GitHub -c user.email=noreply@github.invalid merge -q --no-ff -m "Merge pull request #12 from acme/$branch" "origin/$branch"',
    'git -C "$scratch" push -q origin HEAD:main',
    'rm -rf "$scratch"',
    'git checkout -q main',
    'git branch -q -D "$branch"',
    'git push -q origin --delete "$branch"',
    `echo MERGED > '${repo}/../control/pr.state'`,
    '',
  ].join('\n');
}

const REFUSED_MERGE_SCRIPT = [
  '#!/bin/sh',
  "echo 'X Pull request acme/widgets#12 is not mergeable: the base branch requires a review.' >&2",
  'exit 1',
  '',
].join('\n');

async function harness(fixtures: Partial<Fixtures> = {}) {
  const { root, repo, remote } = await initRepository();
  const control = join(root, 'control');
  const shim = join(root, 'bin');
  await mkdir(control);
  await mkdir(shim);
  await writeExecutable(
    join(shim, 'gh'),
    [
      '#!/bin/sh',
      '# Fake GitHub CLI for the PR conformance suite: records every call with',
      '# its working directory and answers from the control files the harness',
      '# wrote. It never reaches GitHub.',
      `control='${control}'`,
      `printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$control/gh.log"`,
      'case "$1 $2" in',
      "  'pr checks')",
      "    if [ \"$3\" = '--watch' ]; then",
      '      exit "$(cat "$control/watch.exit")"',
      '    fi',
      '    cat "$control/checks.out"',
      '    exit 0',
      '    ;;',
      "  'repo view')",
      '    echo main; exit 0',
      '    ;;',
      "  'pr view')",
      '    case "$*" in',
      `      *'--json url'*) cat "$control/pr.url"; exit $? ;;`,
      `      *'--json state'*) cat "$control/pr.state"; exit $? ;;`,
      `      *'--json baseRefName'*) cat "$control/pr.base"; exit $? ;;`,
      '    esac',
      '    if [ -f "$control/head.oid" ]; then cat "$control/head.oid"; else git rev-parse HEAD; fi',
      '    exit 0',
      '    ;;',
      "  'pr merge')",
      '    exec sh "$control/merge.sh" "$@"',
      '    ;;',
      'esac',
      `printf 'fake gh: unexpected invocation: %s\\n' "$*" >&2`,
      'exit 64',
      '',
    ].join('\n'),
  );
  await writeExecutable(
    join(shim, 'sleep'),
    [
      '#!/bin/sh',
      '# Fake sleep: the wait scripts poll instantly; each call is recorded so a',
      '# test can assert how many polls a loop made before its bound.',
      `printf '%s\\n' "$*" >> '${control}/sleep.log'`,
      'exit 0',
      '',
    ].join('\n'),
  );
  const setChecks = async ({
    output = '✓ ci  pass  12s  https://github.com/acme/widgets/actions/runs/1',
    watchExit = 0,
  }: { output?: string; watchExit?: number } = {}): Promise<void> => {
    await writeFile(join(control, 'checks.out'), `${output}\n`, 'utf8');
    await writeFile(join(control, 'watch.exit'), `${watchExit}\n`, 'utf8');
  };
  const setMerge = async (script: string): Promise<void> => {
    await writeFile(join(control, 'merge.sh'), script, 'utf8');
  };
  // The branch the pull request targets, as `gh pr view` reports it.
  const setPullRequestBase = async (base: string): Promise<void> => {
    await writeFile(join(control, 'pr.base'), `${base}\n`, 'utf8');
  };
  // The pull request `gh` infers from the checked-out branch. A test changes
  // it to model a checkout that moved to another branch mid-run.
  const setInferredPullRequest = async (url: string): Promise<void> => {
    await writeFile(join(control, 'pr.url'), `${url}\n`, 'utf8');
  };
  await writeFile(join(control, 'pr.state'), 'OPEN\n');
  await setPullRequestBase('main');
  await setInferredPullRequest(PULL_REQUEST_URL);
  await setChecks();
  await setMerge(successfulMergeScript(repo, remote));

  process.env.PATH = `${shim}${delimiter}${ORIGINAL_ENV.PATH ?? ''}`;
  // The spawned shells and the observer's git ignore the developer's global
  // configuration (signing, push defaults), so the suite is hermetic.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';

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
  const applyRepositoryEffect = async (
    effect: RepositoryEffect,
  ): Promise<void> => {
    if (effect === 'unchanged') return;
    if (effect === 'publish') {
      // What PR-1 asks of Coder: push the branch with its upstream set. That
      // moves remote-tracking refs and branch configuration only.
      await git(repo, 'push', '--quiet', '-u', 'origin', BRANCH);
      return;
    }
    if (effect === 'worktree') {
      await writeFile(join(repo, 'stray.txt'), 'changed\n', 'utf8');
      return;
    }
    await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'publication');
  };
  const ports: PlaybookPorts = {
    async callPlayer(playerId, prompt, _signal, options) {
      playerCalls.push({ playerId, prompt, resume: options.resume });
      const fixture = players.shift();
      if (fixture === undefined) throw new Error('missing player fixture');
      const { repositoryEffect = 'publish', ...result } = fixture;
      await applyRepositoryEffect(repositoryEffect);
      return result;
    },
    async callCaptain() {
      throw new Error('PR has no direct Captain state');
    },
    async callJudge(prompt) {
      judgePrompts.push(prompt);
      if (judges.length === 0) throw new Error('missing judge fixture');
      return JSON.stringify(judges.shift());
    },
    async callPlaybook(request) {
      childRequests.push(request);
      const fixture = children.shift();
      if (fixture === undefined) throw new Error('missing child fixture');
      const start = typeof fixture === 'function' ? await fixture(request) : fixture;
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
      pr: {
        id: 'pr',
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
    root,
    repo,
    remote,
    control,
    ports,
    playerCalls,
    judgePrompts,
    childRequests,
    statuses,
    telemetry,
    effectLedger: ledgerService,
    hostCapabilities: capabilities.pr,
    setChecks,
    setMerge,
    setPullRequestBase,
    setInferredPullRequest,
    ghLog: () => readLines(join(control, 'gh.log')),
    sleepLog: () => readLines(join(control, 'sleep.log')),
  };
}

type PrHarness = Awaited<ReturnType<typeof harness>>;

function linkedRuntime(host: PrHarness): PlaybookRuntime {
  return createPlaybookRuntime({
    configuredOptions: { cwd: host.repo },
    hostCapabilities: host.hostCapabilities,
  });
}

function acceptedOutcomes(host: PrHarness): unknown[] {
  return host.telemetry
    .filter(({ topic }) => topic === 'playbook.trace')
    .map(({ payload }) => payload as { type?: string; payload?: unknown })
    .filter(({ type }) => type === 'outcome.accepted')
    .map(({ payload }) => payload);
}

function scriptEvents(host: PrHarness): unknown[] {
  return host.telemetry
    .filter(({ topic }) => topic === 'playbook.script')
    .map(({ payload }) => payload);
}

// The gh log records `<pwd>\t<args>`; the commands each script ran, in order.
async function ghCommands(host: PrHarness): Promise<string[]> {
  const lines = await host.ghLog();
  for (const line of lines) {
    expect(line.split('\t')[0]).toBe(host.repo);
  }
  return lines.map((line) => line.split('\t')[1]!);
}

function rootSession(ports: PlaybookPorts): PlaybookSession {
  return {
    sessionId: '40000000-0000-4000-8000-000000000001',
    playbookId: 'pr',
    rootSessionId: '40000000-0000-4000-8000-000000000001',
    depth: 0,
    roleBindings: {
      coder: { playerId: 'dev.coder', promptIdentity: 'Claude Opus 5' },
    },
    ports,
  };
}

const publishedCoder: PlayerFixture = {
  status: 'ok',
  finalText: `Pushed ${BRANCH} with upstream origin/${BRANCH} and opened pull request #12: ${PULL_REQUEST_URL}`,
  resumeToken: 'coder-1',
};

function settledCode(index: number, output: unknown): PlaybookCallStart {
  return {
    state: 'settled',
    result: {
      status: 'ok',
      playbookId: 'code',
      childSessionId: `code-${index}`,
      output: output as never,
    },
  };
}

function codeComplete(lastCodeCommit: string) {
  return {
    status: 'complete',
    lastCodeCommit,
    finalEvaluatedRevision: lastCodeCommit,
    allReviewsPassed: true,
  };
}

// What the nested CODE call leaves behind when it succeeds: one fix commit on
// the checked-out branch and, in the real world, green checks for it.
async function simulateFix(
  host: PrHarness,
  {
    breakRemote = false,
    checksAfterFix = 0,
  }: { breakRemote?: boolean; checksAfterFix?: number } = {},
): Promise<string> {
  await writeFile(join(host.repo, 'retry.txt'), 'retry three times, backing off\n', 'utf8');
  await git(host.repo, 'add', '--all');
  await git(host.repo, 'commit', '--quiet', '-m', 'Back off between retries');
  if (breakRemote) {
    await git(host.repo, 'remote', 'set-url', 'origin', join(host.root, 'missing.git'));
  }
  await host.setChecks({ watchExit: checksAfterFix });
  return git(host.repo, 'rev-parse', 'HEAD');
}

function terminalOf(result: Awaited<ReturnType<PlaybookRuntime['handleBossInput']>>) {
  expect(result.outcome).toBe('terminal');
  assertWorkflowTerminal('pr', result);
  if (result.outcome !== 'terminal') throw new Error('expected a terminal result');
  return result;
}

describe('linked PR runtime', () => {
  it.each(['queued', 'unreadable state', 'unchanged checkout'] as const)(
    'refuses a zero-exit merge with %s', async (scenario) => {
    const host = await harness({ players: [publishedCoder], judges: [OPENED] });
    const merge = successfulMergeScript(host.repo, host.remote);
    await host.setMerge(scenario === 'queued'
      ? '#!/bin/sh\necho "Already queued to merge" >&2\nexit 0\n'
      : scenario === 'unreadable state'
        ? `${merge}rm '${host.control}/pr.state'\n`
        : merge.replace('git checkout -q main', `echo MERGED > '${host.control}/pr.state'\nexit 0\ngit checkout -q main`));
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));
    const result = terminalOf(await runtime.handleBossInput({
      text: CALLER_INPUT, signal: new AbortController().signal,
    }));
    expect(result.output).toEqual({
      status: 'merge-unconfirmed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    expect(scriptEvents(host)).not.toContainEqual(expect.objectContaining({ stateId: 'updateLocalDefault' }));
    expect(await git(host.repo, 'branch', '--show-current')).toBe(scenario === 'unreadable state' ? 'main' : BRANCH);
    await runtime.dispose();
  });

  it('labels only the publication round PR itself owns', () => {
    expect(prStateCountLabels).toEqual({ openPullRequest: 'publication round' });
    expect(prCopyPasteGuardNames).toEqual(['opened']);
  });

  it('advertises the schema-3 local-role manifest', async () => {
    const host = await harness();
    expect(prPlaybookRegistryEntry).toMatchObject({
      id: 'pr',
      command: 'pr',
      artifactSchema: 3,
      runtimeProfile: {
        kind: 'shared-factory',
        compat: { artifactSchema: 3, runtimeAbi: 1 },
      },
      requiredRoleIds: ['coder'],
      concurrentRoleSets: [],
    });
    expect(prPlaybookRegistryEntry.intent).toContain('pull request');
    expect(prPlaybookRegistryEntry.runtimeProfile.compat).toBe(
      createPlaybookRuntime.compat,
    );
    expect(validatePrOptions(undefined)).toEqual({});
    expect(() => validatePrOptions({ cwd: '/elsewhere' })).toThrow(
      'captain.options.playbooks.pr.options.cwd',
    );
    expect(() =>
      createPlaybookRuntime({
        configuredOptions: { extra: 1 },
        hostCapabilities: host.hostCapabilities,
      }),
    ).toThrow('PR runtime options.extra is not declared');
    expect(
      prPlaybookRegistryEntry.createRuntime(
        validatePrOptions({}),
        host.hostCapabilities,
      ),
    ).toBeDefined();
  });

  it('publishes under an unchanged receipt, waits, merges, and fast-forwards the local default branch', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
    });
    const branchHead = await git(host.repo, 'rev-parse', 'HEAD');
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.stateDescription).toBe(MERGED_DESCRIPTION);
    expect(result.output).toEqual({
      status: 'merged',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      localDefaultUpdated: true,
    });
    // The port receives the canonical local role id; the host binding maps
    // it to the stable `dev.coder` player. The whole caller input is quoted.
    expect(host.playerCalls).toHaveLength(1);
    expect(host.playerCalls[0]).toMatchObject({ playerId: 'coder', resume: false });
    expect(host.playerCalls[0]?.prompt).toContain(
      `> Original request: ${CALLER_INPUT.replaceAll('\n', '\n> ')}\n\nPublish the branch`,
    );
    expect(host.playerCalls[0]?.prompt).toContain('never force-push.');
    // The judge is asked for the two semantic fields it owns and nothing else.
    expect(host.judgePrompts).toHaveLength(1);
    expect(host.judgePrompts[0]).toContain('pullRequestUrl');
    expect(host.childRequests).toEqual([]);

    // Pushing the branch changed neither HEAD nor the worktree projection:
    // the one governed boundary proves `unchanged`, and the scripts hold none.
    const ledger = host.effectLedger.snapshot();
    expect(ledger.boundaries).toHaveLength(1);
    expect(ledger.boundaries[0]?.physicalReceipt).toMatchObject({
      classification: 'unchanged',
    });
    expect(ledger.logicalOperations).toEqual([]);
    expect(host.statuses).toContain('→ opened');
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'openPullRequest',
        target: 'waitForChecks',
        acceptedOutcome: 'opened',
      },
    ]);

    // The three mechanical steps ran as scripts: one status line and one
    // telemetry event each, no agent call, no adjudication.
    expect(
      host.statuses.filter((line) => line.startsWith('Executed script')),
    ).toEqual([
      'Executed script for waitForChecks (exit 0).',
      'Executed script for mergePullRequest (exit 0).',
      'Executed script for updateLocalDefault (exit 0).',
    ]);
    expect(scriptEvents(host)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2', exitStatus: 0 },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6', exitStatus: 0 },
      { stateId: 'updateLocalDefault', sourceItem: 'PR-7', exitStatus: 0 },
    ]);
    expect(await ghCommands(host)).toEqual([
      'pr checks',
      'pr checks --watch --fail-fast',
      'pr view --json url --jq .url',
      'repo view --json defaultBranchRef --jq .defaultBranchRef.name',
      `pr view ${PULL_REQUEST_URL} --json baseRefName --jq .baseRefName`,
      `pr merge --merge --delete-branch --match-head-commit ${branchHead}`,
      `pr view ${PULL_REQUEST_URL} --json state --jq .state`,
    ]);
    expect(await host.sleepLog()).toEqual([]);

    // The repository ends where the source says: default branch checked out
    // and fast-forwarded to the merged head, both branches gone.
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    const remoteMain = await git(host.repo, 'rev-parse', 'origin/main');
    expect(await git(host.repo, 'rev-parse', 'HEAD')).toBe(remoteMain);
    expect(await git(host.repo, 'rev-list', '--count', `${branchHead}..HEAD`)).toBe('1');
    expect(await git(host.repo, 'branch', '--list', BRANCH)).toBe('');
    expect(await git(host.repo, 'ls-remote', '--heads', 'origin', BRANCH)).toBe('');
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('merged');
    expect(view.stateDescription).toBe(MERGED_DESCRIPTION);
    await runtime.dispose();
  });

  it('runs its scripts in the host authority working directory when created through the registry', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
    });
    const runtime = prPlaybookRegistryEntry.createRuntime(
      validatePrOptions(undefined),
      host.hostCapabilities,
    );
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toMatchObject({ status: 'merged', localDefaultUpdated: true });
    // Every gh invocation ran in the governed repository, not the process cwd.
    expect((await host.ghLog()).map((line) => line.split('\t')[0])).toEqual(
      Array.from({ length: 7 }, () => host.repo),
    );
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    await runtime.dispose();
  });

  it('reports a merged pull request whose local default branch stayed behind', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
    });
    // GitHub merged, but the local default branch diverged meanwhile.
    await host.setMerge(
      successfulMergeScript(host.repo, host.remote) +
        'git -c user.name=Local -c user.email=local@example.invalid commit -q --allow-empty -m "local divergence"\n',
    );
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.stateDescription).toBe(
      'The pull request is merged with a merge commit on the repository default branch, which is checked out but could not be fast-forwarded to the merged head; the merge requested deletion of the remote and local branch.',
    );
    expect(result.output).toEqual({
      status: 'merged',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      localDefaultUpdated: false,
    });
    expect(scriptEvents(host).at(-1)).toMatchObject({
      stateId: 'updateLocalDefault',
      sourceItem: 'PR-7',
    });
    expect((scriptEvents(host).at(-1) as { exitStatus: number }).exitStatus).not.toBe(0);
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await git(host.repo, 'rev-parse', 'HEAD')).not.toBe(
      await git(host.repo, 'rev-parse', 'origin/main'),
    );
    await runtime.dispose();
  });

  it('counts a pull request that still reports no checks after the brief wait as passed', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
    });
    await host.setChecks({
      output: `no checks reported on the '${BRANCH}' branch`,
      watchExit: 1,
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toMatchObject({ status: 'merged' });
    const commands = await ghCommands(host);
    // Six polls, then the wait exits zero without ever watching.
    expect(commands.filter((command) => command === 'pr checks')).toHaveLength(6);
    expect(commands).not.toContain('pr checks --watch --fail-fast');
    expect(commands.at(-2)).toMatch(/^pr merge /);
    expect(commands.at(-1)).toBe(`pr view ${PULL_REQUEST_URL} --json state --jq .state`);
    expect(await host.sleepLog()).toEqual(['10', '10', '10', '10', '10']);
    await runtime.dispose();
  });

  it('reports an unpublished branch with the Coder result verbatim and runs no script', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText:
            'The working tree is not clean: retry.txt has unstaged changes. Nothing was pushed and no pull request was opened.',
          repositoryEffect: 'unchanged',
        },
      ],
      judges: [{ guard: 'notPublished' }],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.stateDescription).toBe(
      'The branch was not published or its pull request could not be opened; Coder reported the reason and no pull request is guaranteed to exist.',
    );
    expect(result.output).toEqual({
      status: 'not-merged',
      reason: 'not-published',
      coderOutput:
        'The working tree is not clean: retry.txt has unstaged changes. Nothing was pushed and no pull request was opened.',
    });
    expect(host.statuses).toContain('→ notPublished');
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'openPullRequest',
        target: 'notPublished',
        acceptedOutcome: 'notPublished',
      },
    ]);
    expect(await host.ghLog()).toEqual([]);
    expect(scriptEvents(host)).toEqual([]);
    expect(host.childRequests).toEqual([]);
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    await runtime.dispose();
  });

  // Under PR's all-`unchanged` authority, any repository delta during the
  // publication call — a commit or a bare worktree edit alike — is change the
  // declared disposition cannot own, so it classifies as foreign and no
  // mechanical step runs on an unproven publication.
  it.each([
    ['commit', 'concurrent-or-foreign-change'],
    ['worktree', 'concurrent-or-foreign-change'],
  ] as const)(
    'parks a publication that mutates the repository (%s) as unresolved',
    async (repositoryEffect, classification) => {
      const host = await harness({
        players: [{ ...publishedCoder, repositoryEffect }],
        judges: [OPENED],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(rootSession(host.ports));

      const result = await runtime.handleBossInput({
        text: CALLER_INPUT,
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
      expect(
        host.effectLedger.snapshot().boundaries[0]?.physicalReceipt,
      ).toMatchObject({ classification });
      expect(host.statuses).not.toContain('→ opened');
      expect(await host.ghLog()).toEqual([]);
      expect(scriptEvents(host)).toEqual([]);
      await runtime.dispose();
    },
  );

  it('requires the judge to supply both semantic pull request fields', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [
        // The first candidate omits the URL: one corrective judge call, then
        // the complete candidate is accepted.
        { guard: 'opened', pullRequest: '12' },
        OPENED,
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toMatchObject({
      status: 'merged',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    expect(host.judgePrompts).toHaveLength(2);
    expect(host.playerCalls).toHaveLength(1);
    await runtime.dispose();
  });

  it('parks for a Boss reply and resumes the publication with the answer in the same conversation', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'Two GitHub remotes are configured, origin and upstream. Which one should receive the branch?',
          resumeToken: 'coder-question',
          repositoryEffect: 'unchanged',
        },
        { ...publishedCoder, resumeToken: 'coder-2' },
      ],
      judges: [{ guard: 'needsBossReply' }, { type: 'BOSS_REPLY' }, OPENED],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const parked = await runtime.handleBossInput({
      text: CALLER_INPUT,
      signal: new AbortController().signal,
    });
    expect(parked.outcome).toBe('quiescent');
    expect(parked.state.stateId).toBe('awaitBossReply');
    // The Coder question is governed `unchanged`, not `deferred`: no
    // checkpoint-bound logical operation opens for it.
    expect(host.effectLedger.snapshot().logicalOperations).toEqual([]);
    expect(await host.ghLog()).toEqual([]);

    const result = terminalOf(
      await runtime.handleBossInput({
        text: 'Push to origin.',
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toMatchObject({ status: 'merged', localDefaultUpdated: true });
    expect(host.playerCalls.map(({ resume }) => resume)).toEqual([
      false,
      'coder-question',
    ]);
    const prompt = host.playerCalls[1]!.prompt;
    expect(prompt).toContain('Boss reply:\nPush to origin.');
    expect(prompt).toContain(`> Original request: ${CALLER_INPUT.replaceAll('\n', '\n> ')}`);
    expect(prompt.split(CALLER_INPUT.split('\n')[0]!)).toHaveLength(2);
    expect(acceptedOutcomes(host)).toEqual([
      {
        source: 'openPullRequest',
        target: 'awaitBossReply',
        acceptedOutcome: 'needsBossReply',
      },
      {
        source: 'openPullRequest',
        target: 'waitForChecks',
        acceptedOutcome: 'opened',
      },
    ]);
    expect(host.effectLedger.snapshot().boundaries).toHaveLength(2);
    await runtime.dispose();
  });

  it('fixes red checks once through CODE, republishes the fix, waits again, and merges', async () => {
    let fixCommit = '';
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [
        async () => {
          fixCommit = await simulateFix(host);
          return settledCode(1, codeComplete(fixCommit));
        },
      ],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.stateDescription).toBe(MERGED_DESCRIPTION);
    expect(result.output).toEqual({
      status: 'merged',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      localDefaultUpdated: true,
    });
    // PR-3's composed input: the caller input, the pull request the Coder
    // reported, and the static coding request — quoted line by line.
    expect(host.childRequests).toEqual([
      {
        callId: expect.any(String),
        playbookId: 'code',
        text: [
          `> Original request: ${CALLER_INPUT.replaceAll('\n', '\n> ')}`,
          `> Pull request: ${PULL_REQUEST_URL}`,
          `> Coding request: ${FIX_CODING_REQUEST}`,
        ].join('\n'),
      },
    ]);
    expect(scriptEvents(host)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2', exitStatus: 1 },
      { stateId: 'publishFix', sourceItem: 'PR-4', exitStatus: 0 },
      { stateId: 'waitForChecksAfterFix', sourceItem: 'PR-5', exitStatus: 0 },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6', exitStatus: 0 },
      { stateId: 'updateLocalDefault', sourceItem: 'PR-7', exitStatus: 0 },
    ]);
    expect(await ghCommands(host)).toEqual([
      'pr checks',
      'pr checks --watch --fail-fast',
      'pr view --json url --jq .url',
      'pr view --json headRefOid --jq .headRefOid',
      'pr checks',
      'pr checks --watch --fail-fast',
      'pr view --json url --jq .url',
      'repo view --json defaultBranchRef --jq .defaultBranchRef.name',
      `pr view ${PULL_REQUEST_URL} --json baseRefName --jq .baseRefName`,
      `pr merge --merge --delete-branch --match-head-commit ${fixCommit}`,
      `pr view ${PULL_REQUEST_URL} --json state --jq .state`,
    ]);
    // The fix reached the remote before the merge and is in the merged head.
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await git(host.repo, 'merge-base', '--is-ancestor', fixCommit, 'HEAD')).toBe('');
    expect(await git(host.repo, 'rev-parse', 'HEAD')).toBe(
      await git(host.repo, 'rev-parse', 'origin/main'),
    );
    // The nested CODE call is the child's boundary, not PR's: PR's ledger
    // still holds only the publication boundary.
    expect(host.effectLedger.snapshot().boundaries).toHaveLength(1);
    await runtime.dispose();
  });

  it('suspends on the nested CODE call and resumes from its canonical result', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [{ state: 'suspended', childSessionId: 'code-suspended' }],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const suspended = await runtime.handleBossInput({
      text: CALLER_INPUT,
      signal: new AbortController().signal,
    });
    expect(suspended.outcome).toBe('suspended');
    if (suspended.outcome !== 'suspended') throw new Error('expected suspension');
    expect(suspended.pendingCall.playbookId).toBe('code');
    expect(suspended.pendingCall.childSessionId).toBe('code-suspended');
    expect(host.childRequests[0]?.text).toContain(`> Pull request: ${PULL_REQUEST_URL}`);
    expect(await ghCommands(host)).toEqual(['pr checks', 'pr checks --watch --fail-fast']);

    const fixCommit = await simulateFix(host);
    const resumed = await runtime.resumePlaybookCall({
      callId: suspended.pendingCall.callId,
      signal: new AbortController().signal,
      result: {
        status: 'ok',
        playbookId: 'code',
        childSessionId: 'code-suspended',
        output: codeComplete(fixCommit),
      },
    });

    expect(resumed.outcome).toBe('terminal');
    assertWorkflowTerminal('pr', resumed);
    expect(resumed.outcome === 'terminal' ? resumed.output : undefined).toEqual({
      status: 'merged',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      localDefaultUpdated: true,
    });
    expect((await ghCommands(host)).at(-1)).toBe(
      `pr view ${PULL_REQUEST_URL} --json state --jq .state`,
    );
    await runtime.dispose();
  });

  it('relays an authored CODE failure and leaves the pull request open', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [
        {
          state: 'settled',
          result: {
            status: 'error',
            playbookId: 'code',
            childSessionId: 'code-error',
            error: { name: 'CodeError', message: 'review rejected the fix' },
          },
        },
      ],
    });
    await host.setChecks({ watchExit: 1 });
    const branchHead = await git(host.repo, 'rev-parse', 'HEAD');
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.stateDescription).toBe(
      "The pull request's checks were red and the single CODE fix attempt returned an authored abort, failure, or insufficient terminal result; the pull request remains open.",
    );
    expect(result.output).toEqual({
      status: 'not-merged',
      reason: 'fix-failed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      childResult: {
        playbookId: 'code',
        status: 'error',
        error: { name: 'CodeError', message: 'review rejected the fix' },
      },
    });
    expect(host.childRequests).toHaveLength(1);
    expect(await ghCommands(host)).toEqual(['pr checks', 'pr checks --watch --fail-fast']);
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(await git(host.repo, 'rev-parse', 'HEAD')).toBe(branchHead);
    expect(runtime.describe!().state.stateId).toBe('fixFailed');
    await runtime.dispose();
  });

  // DR-048: CODE's `reportedReviewFailure` is a declared failure terminal, so
  // the bridge rejects PR's actor with the child's own public result and PR
  // relays that output without reading CODE's fields for success.
  it('relays a CODE failure terminal delivered through the error path', async () => {
    const insufficient = {
      status: 'review-failed',
      lastCodeCommit: 'fix123',
      error: { name: 'Error', message: 'unsettled findings' },
    };
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [
        {
          state: 'settled',
          result: {
            status: 'ok',
            playbookId: 'code',
            childSessionId: 'code-1',
            output: insufficient,
            terminal: {
              stateId: 'reportedReviewFailure',
              kind: 'failure',
              description: 'CODE reports the review failure.',
            },
          },
        },
      ],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toEqual({
      status: 'not-merged',
      reason: 'fix-failed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      childResult: { playbookId: 'code', status: 'ok', output: insufficient },
    });
    expect(scriptEvents(host)).toHaveLength(1);
    await runtime.dispose();
  });

  it('relays a resolved CODE result that does not prove success', async () => {
    const insufficient = {
      status: 'review-failed',
      lastCodeCommit: 'fix123',
      error: { name: 'Error', message: 'unsettled findings' },
    };
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [settledCode(1, insufficient)],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toEqual({
      status: 'not-merged',
      reason: 'fix-failed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
      childResult: { playbookId: 'code', status: 'ok', output: insufficient },
    });
    expect(runtime.describe!().state.stateId).toBe('fixFailed');
    await runtime.dispose();
  });

  it('reports a fix whose push was rejected', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [
        async () => {
          const fixCommit = await simulateFix(host, { breakRemote: true });
          return settledCode(1, codeComplete(fixCommit));
        },
      ],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.stateDescription).toBe(
      "The fix could not be published: the checked-out branch no longer carries the published pull request, the push was rejected, or the pull request's head did not advance to the pushed commit; the pull request remains open.",
    );
    expect(result.output).toEqual({
      status: 'not-merged',
      reason: 'fix-not-published',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    expect(scriptEvents(host)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2', exitStatus: 1 },
      { stateId: 'publishFix', sourceItem: 'PR-4', exitStatus: 1 },
    ]);
    // The publication bound itself to the published pull request, then
    // `git push || exit 1` failed before the head-sync poll.
    expect(await ghCommands(host)).toEqual([
      'pr checks',
      'pr checks --watch --fail-fast',
      'pr view --json url --jq .url',
    ]);
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    await runtime.dispose();
  });

  it('reports a fix whose pull request head never advanced within the poll bound', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [
        async () => {
          const fixCommit = await simulateFix(host);
          // GitHub keeps reporting the previous head for the pull request.
          await writeFile(
            join(host.control, 'head.oid'),
            `${'0'.repeat(40)}\n`,
            'utf8',
          );
          return settledCode(1, codeComplete(fixCommit));
        },
      ],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toEqual({
      status: 'not-merged',
      reason: 'fix-not-published',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    const commands = await ghCommands(host);
    // Twelve head polls at five-second intervals, then the bound gives up.
    expect(
      commands.filter((command) => command === 'pr view --json headRefOid --jq .headRefOid'),
    ).toHaveLength(12);
    expect(await host.sleepLog()).toEqual(Array.from({ length: 11 }, () => '5'));
    expect(commands).not.toContainEqual(expect.stringMatching(/^pr merge /));
    // The push itself landed: the remote branch carries the fix.
    expect(await git(host.repo, 'rev-parse', `origin/${BRANCH}`)).toBe(
      await git(host.repo, 'rev-parse', 'HEAD'),
    );
    await runtime.dispose();
  });

  it('reports checks still failing after the one fix attempt without a second CODE call', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [
        async () => {
          const fixCommit = await simulateFix(host, { checksAfterFix: 1 });
          return settledCode(1, codeComplete(fixCommit));
        },
      ],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.stateDescription).toBe(
      "The pull request's checks are still failing after the one fix attempt; the pull request remains open.",
    );
    expect(result.output).toEqual({
      status: 'not-merged',
      reason: 'checks-failed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    expect(host.childRequests).toHaveLength(1);
    expect(scriptEvents(host)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2', exitStatus: 1 },
      { stateId: 'publishFix', sourceItem: 'PR-4', exitStatus: 0 },
      { stateId: 'waitForChecksAfterFix', sourceItem: 'PR-5', exitStatus: 1 },
    ]);
    expect(await ghCommands(host)).not.toContainEqual(expect.stringMatching(/^pr merge /));
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    await runtime.dispose();
  });

  it('reports a refused merge and leaves the branch checked out', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
    });
    await host.setMerge(REFUSED_MERGE_SCRIPT);
    const branchHead = await git(host.repo, 'rev-parse', 'HEAD');
    const remoteMain = await git(host.repo, 'rev-parse', 'origin/main');
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.stateDescription).toBe(
      'The merge did not complete: the checked-out branch no longer carries the published pull request, the pull request does not target the repository default branch, GitHub refused the merge, or the merge may have landed while its confirmation, the local switch to the default branch, or the branch deletion failed; the pull request is in the state GitHub reports.',
    );
    // The merge command ran, so the result claims no merged state either way.
    expect(result.output).toEqual({
      status: 'merge-unconfirmed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    expect(scriptEvents(host)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2', exitStatus: 0 },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6', exitStatus: 1 },
    ]);
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(await git(host.repo, 'rev-parse', 'HEAD')).toBe(branchHead);
    await git(host.repo, 'fetch', '--quiet', 'origin');
    expect(await git(host.repo, 'rev-parse', 'origin/main')).toBe(remoteMain);
    await runtime.dispose();
  });

  it('publishes no fix when the suspended CODE call left another branch checked out', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [{ state: 'suspended', childSessionId: 'code-suspended' }],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const suspended = await runtime.handleBossInput({
      text: CALLER_INPUT,
      signal: new AbortController().signal,
    });
    expect(suspended.outcome).toBe('suspended');
    if (suspended.outcome !== 'suspended') throw new Error('expected suspension');

    // The nested call spans Boss turns. Boss checks out another branch at the
    // same commit meanwhile, so `gh` now infers that branch's pull request.
    const branchHead = await git(host.repo, 'rev-parse', 'HEAD');
    await git(host.repo, 'checkout', '--quiet', '-b', 'issue-99-other');
    await git(host.repo, 'push', '--quiet', '-u', 'origin', 'issue-99-other');
    const otherHead = await git(host.repo, 'rev-parse', 'origin/issue-99-other');
    await host.setInferredPullRequest('https://github.com/acme/widgets/pull/99');
    const fixCommit = await simulateFix(host);

    const resumed = await runtime.resumePlaybookCall({
      callId: suspended.pendingCall.callId,
      signal: new AbortController().signal,
      result: {
        status: 'ok',
        playbookId: 'code',
        childSessionId: 'code-suspended',
        output: codeComplete(fixCommit),
      },
    });

    // PR-4 refuses: it pushed nothing and never reached the merge, so the
    // other branch's pull request was neither published to nor merged.
    expect(terminalOf(resumed).output).toEqual({
      status: 'not-merged',
      reason: 'fix-not-published',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    const commands = await ghCommands(host);
    expect(commands.at(-1)).toBe('pr view --json url --jq .url');
    expect(commands.some((command) => command.startsWith('pr merge'))).toBe(false);
    expect(scriptEvents(host)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2', exitStatus: 1 },
      { stateId: 'publishFix', sourceItem: 'PR-4', exitStatus: 1 },
    ]);
    await git(host.repo, 'fetch', '--quiet', 'origin');
    expect(await git(host.repo, 'rev-parse', 'origin/' + BRANCH)).toBe(branchHead);
    // Neither branch received the fix: the drifted branch's remote head is
    // exactly where it was before `code` ran.
    expect(await git(host.repo, 'rev-parse', 'origin/issue-99-other')).toBe(otherHead);
    expect(await git(host.repo, 'rev-parse', 'origin/issue-99-other')).not.toBe(fixCommit);
    await runtime.dispose();
  });

  it('never merges when the checkout no longer infers the published pull request', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
    });
    await host.setInferredPullRequest('https://github.com/acme/widgets/pull/99');
    const branchHead = await git(host.repo, 'rev-parse', 'HEAD');
    const remoteMain = await git(host.repo, 'rev-parse', 'origin/main');
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toEqual({
      status: 'merge-unconfirmed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    // The identity check precedes the base check and the merge itself.
    const commands = await ghCommands(host);
    expect(commands.at(-1)).toBe('pr view --json url --jq .url');
    expect(commands.some((command) => command.startsWith('pr merge'))).toBe(false);
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(await git(host.repo, 'rev-parse', 'HEAD')).toBe(branchHead);
    await git(host.repo, 'fetch', '--quiet', 'origin');
    expect(await git(host.repo, 'rev-parse', 'origin/main')).toBe(remoteMain);
    await runtime.dispose();
  });

  it('binds a Coder-reported pull request URL as data, never as shell syntax', async () => {
    // The URL is Coder's reported text. This one carries a command
    // substitution that would run `touch` and expand to nothing, leaving the
    // comparison equal to the pull request the checkout really infers.
    const hostile = `${PULL_REQUEST_URL}$(touch pwned.txt)`;
    const host = await harness({
      players: [
        {
          ...publishedCoder,
          finalText: `Pushed ${BRANCH} and opened pull request #12: ${hostile}`,
        },
      ],
      judges: [{ guard: 'opened', pullRequest: '12', pullRequestUrl: hostile }],
    });
    const branchHead = await git(host.repo, 'rev-parse', 'HEAD');
    const remoteMain = await git(host.repo, 'rev-parse', 'origin/main');
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    // The substitution never ran, and the literal it stayed matches no pull
    // request, so the merge refused instead of merging on a forged equality.
    await expect(access(join(host.repo, 'pwned.txt'))).rejects.toThrow();
    expect(result.output).toEqual({
      status: 'merge-unconfirmed',
      pullRequest: '12',
      pullRequestUrl: hostile,
    });
    const commands = await ghCommands(host);
    expect(commands.some((command) => command.startsWith('pr merge'))).toBe(false);
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    await git(host.repo, 'fetch', '--quiet', 'origin');
    expect(await git(host.repo, 'rev-parse', 'origin/main')).toBe(remoteMain);
    expect(await git(host.repo, 'rev-parse', 'HEAD')).toBe(branchHead);
    await runtime.dispose();
  });

  it('never merges a reused pull request that targets another branch', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
    });
    // PR-1 may reuse an open pull request someone opened against `release`.
    await host.setPullRequestBase('release');
    const branchHead = await git(host.repo, 'rev-parse', 'HEAD');
    const remoteMain = await git(host.repo, 'rev-parse', 'origin/main');
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = terminalOf(
      await runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    );

    expect(result.output).toEqual({
      status: 'merge-unconfirmed',
      pullRequest: '12',
      pullRequestUrl: PULL_REQUEST_URL,
    });
    // The base check precedes the irreversible merge, so `gh pr merge` never
    // ran and nothing was merged into the branch the pull request targets.
    const commands = await ghCommands(host);
    expect(commands.at(-1)).toBe(
      `pr view ${PULL_REQUEST_URL} --json baseRefName --jq .baseRefName`,
    );
    expect(commands.some((command) => command.startsWith('pr merge'))).toBe(false);
    expect(scriptEvents(host)).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2', exitStatus: 0 },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6', exitStatus: 1 },
    ]);
    expect(await git(host.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(await git(host.repo, 'rev-parse', 'HEAD')).toBe(branchHead);
    await git(host.repo, 'fetch', '--quiet', 'origin');
    expect(await git(host.repo, 'rev-parse', 'origin/main')).toBe(remoteMain);
    await runtime.dispose();
  });

  it('parks a raw nested-call rejection as a control-plane failure', async () => {
    const host = await harness({
      players: [publishedCoder],
      judges: [OPENED],
      children: [new Error('nested CODE bridge failed')],
    });
    await host.setChecks({ watchExit: 1 });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    await expect(
      runtime.handleBossInput({
        text: CALLER_INPUT,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('nested CODE bridge failed');
    expect(host.childRequests).toHaveLength(1);
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(scriptEvents(host)).toHaveLength(1);
    await runtime.dispose();
  });
});
