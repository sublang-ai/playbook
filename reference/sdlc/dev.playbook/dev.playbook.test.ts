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
  type PlaybookCallStart,
  type PlaybookPorts,
  type PlaybookSession,
  type PlayerResult,
} from './dev.playbook.js';
import devPlaybookRegistryEntry, {
  devCopyPasteGuardNames,
  devStateCountLabels,
  validateDevOptions,
} from './dev.registry.js';
import { createRepositoryEffectCapabilities } from '../code.playbook/bin/repository-effects.js';

const CODE_COMPLETE = {
  status: 'complete',
  lastCodeCommit: 'code123',
  finalEvaluatedRevision: 'code-rev',
  allReviewsPassed: true,
} as const;

const DECIDE_COMPLETE = {
  decideCommit: 'decide123',
  evaluatedRevision: 'rev456',
  noUnsettledFindings: true,
} as const;

type RepositoryEffect = 'unchanged' | 'commit' | 'worktree';

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
  const repo = await mkdtemp(join(tmpdir(), 'dev-authority-'));
  tempDirs.push(repo);
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'user.name', 'DEV Authority Test');
  await git(repo, 'config', 'user.email', 'dev@example.invalid');
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
              throw new Error('DEV test effect-ledger replacement is stale');
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
              throw new Error('DEV test logical-operation replacement is stale');
            }
            logicalOperations[index] = replacement.next;
          }
          continue;
        }
        throw new Error(`unsupported DEV test ledger command ${command.kind}`);
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
    await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'planning');
  };
  const ports: PlaybookPorts = {
    async callPlayer(playerId, prompt, _signal, options) {
      playerCalls.push({ playerId, prompt, resume: options.resume });
      const fixture = players.shift();
      if (fixture === undefined) throw new Error('missing player fixture');
      // DEV owns no repository commit, so planning fixtures default to the
      // unchanged repository the governed disposition requires.
      const { repositoryEffect = 'unchanged', ...result } = fixture;
      await applyRepositoryEffect(repositoryEffect);
      return result;
    },
    async callCaptain() {
      throw new Error('DEV has no direct Captain state');
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
      dev: {
        id: 'dev',
        artifactSchema: 3,
        requiredRoleIds: ['analyst'],
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
    effectLedger: ledgerService,
    hostCapabilities: capabilities.dev,
  };
}

type DevHarness = Awaited<ReturnType<typeof harness>>;

function linkedRuntime(host: DevHarness, options: unknown = {}) {
  return createPlaybookRuntime({
    configuredOptions: options,
    hostCapabilities: host.hostCapabilities,
  });
}

function acceptedOutcomes(host: DevHarness): unknown[] {
  return host.telemetry
    .filter(({ topic }) => topic === 'playbook.trace')
    .map(({ payload }) => payload as { type?: string; payload?: unknown })
    .filter(({ type }) => type === 'outcome.accepted')
    .map(({ payload }) => payload);
}

function rootSession(ports: PlaybookPorts): PlaybookSession {
  return {
    sessionId: '40000000-0000-4000-8000-000000000001',
    playbookId: 'dev',
    rootSessionId: '40000000-0000-4000-8000-000000000001',
    depth: 0,
    roleBindings: {
      analyst: { playerId: 'dev.analyst', promptIdentity: 'Claude Opus 5' },
    },
    ports,
  };
}

function settledChild(
  playbookId: 'code' | 'decide',
  index: number,
  output: unknown,
): PlaybookCallStart {
  return {
    state: 'settled',
    result: {
      status: 'ok',
      playbookId,
      childSessionId: `${playbookId}-${index}`,
      output: output as never,
    },
  };
}

describe('linked DEV runtime', () => {
  it('labels only the planning rounds DEV itself owns', () => {
    expect(devStateCountLabels).toEqual({ planAnalysis: 'planning round' });
    expect(devCopyPasteGuardNames).toEqual(['code', 'decideThenCode']);
  });

  it('advertises the schema-3 local-role manifest', async () => {
    const host = await harness();
    expect(devPlaybookRegistryEntry).toMatchObject({
      id: 'dev',
      command: 'dev',
      artifactSchema: 3,
      runtimeProfile: {
        kind: 'shared-factory',
        compat: { artifactSchema: 3, runtimeAbi: 1 },
      },
      requiredRoleIds: ['analyst'],
      concurrentRoleSets: [],
    });
    expect(devPlaybookRegistryEntry.runtimeProfile.compat).toBe(
      createPlaybookRuntime.compat,
    );
    expect(validateDevOptions(undefined)).toEqual({});
    expect(() => validateDevOptions({ extra: 1 })).toThrow(
      'captain.options.playbooks.dev.options.extra',
    );
    expect(
      devPlaybookRegistryEntry.createRuntime(
        validateDevOptions({}),
        host.hostCapabilities,
      ),
    ).toBeDefined();
  });

  it('plans one code path under an unchanged receipt and relays the CODE result', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'Proceed under the existing decisions.',
          resumeToken: 'analyst-1',
        },
      ],
      judges: [{ guard: 'code' }],
      children: [settledChild('code', 1, CODE_COMPLETE)],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Add the new command.\nKeep the CLI stable.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      "The selected development path completed with the final child playbook's successful result.",
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'complete',
      childPlaybookId: 'code',
      childOutput: CODE_COMPLETE,
    });
    expect(host.playerCalls).toHaveLength(1);
    // The port receives the canonical local role id; the host binding maps
    // it to the stable `dev.analyst` player.
    expect(host.playerCalls[0]).toMatchObject({
      playerId: 'analyst',
      resume: false,
    });
    expect(host.playerCalls[0]?.prompt).toContain(
      '> Add the new command.\n> Keep the CLI stable.',
    );
    expect(host.playerCalls[0]?.prompt).toContain(
      'Do not change files or commit while planning or discussing the request.',
    );
    expect(host.childRequests).toEqual([
      {
        callId: expect.any(String),
        playbookId: 'code',
        text:
          '> Add the new command.\n> Keep the CLI stable.\n' +
          '> Proceed under the existing decisions.',
      },
    ]);
    expect(host.statuses).toContain('→ code');
    expect(acceptedOutcomes(host)).toContainEqual({
      source: 'planAnalysis',
      target: 'callCode',
      acceptedOutcome: 'code',
    });
    expect(
      host.effectLedger.snapshot().boundaries[0]?.physicalReceipt,
    ).toMatchObject({ classification: 'unchanged' });
    expect(host.effectLedger.snapshot().logicalOperations).toEqual([]);
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('done');
    expect(view.stateDescription).toBe(
      "The selected development path completed with the final child playbook's successful result.",
    );
    await runtime.dispose();
  });

  // Under DEV's all-`unchanged` authority, any repository delta during a
  // planning call — a commit or a bare worktree edit alike — is change the
  // declared disposition cannot own, so it classifies as foreign.
  it.each([
    ['commit', 'concurrent-or-foreign-change'],
    ['worktree', 'concurrent-or-foreign-change'],
  ] as const)(
    'parks planning that mutates the repository (%s) as unresolved',
    async (repositoryEffect, classification) => {
      const host = await harness({
        players: [
          {
            status: 'ok',
            finalText: 'Planned and edited files.',
            repositoryEffect,
          },
        ],
        judges: [{ guard: 'code' }],
      });
      const runtime = linkedRuntime(host);
      await runtime.init(rootSession(host.ports));

      const result = await runtime.handleBossInput({
        text: 'Plan the request.',
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
      expect(
        host.effectLedger.snapshot().boundaries[0]?.physicalReceipt,
      ).toMatchObject({ classification });
      expect(host.statuses).not.toContain('→ code');
      await runtime.dispose();
    },
  );

  it('sequences decide then code and quotes the decide identities', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'A durable decision is required first.',
          resumeToken: 'analyst-1',
        },
      ],
      judges: [{ guard: 'decideThenCode' }],
      children: [
        settledChild('decide', 1, DECIDE_COMPLETE),
        settledChild('code', 1, CODE_COMPLETE),
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Introduce a new workflow.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'complete',
      childPlaybookId: 'code',
      childOutput: CODE_COMPLETE,
    });
    expect(
      host.childRequests.map(({ playbookId }) => playbookId),
    ).toEqual(['decide', 'code']);
    expect(host.childRequests[0]?.text).toBe(
      '> Introduce a new workflow.\n> A durable decision is required first.',
    );
    expect(host.childRequests[1]?.text).toBe(
      [
        '> Introduce a new workflow.',
        '> A durable decision is required first.',
        '> decide123',
        '> rev456',
      ].join('\n'),
    );
    expect(acceptedOutcomes(host)).toContainEqual({
      source: 'planAnalysis',
      target: 'callDecide',
      acceptedOutcome: 'decideThenCode',
    });
    await runtime.dispose();
  });

  it('keeps one Analyst conversation through a Boss question', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'Should this wait for the release freeze?',
          resumeToken: 'analyst-question',
        },
        {
          status: 'ok',
          finalText: 'Understood, no repository work follows.',
          resumeToken: 'analyst-2',
        },
      ],
      judges: [
        { guard: 'needsBossReply' },
        { type: 'BOSS_REPLY' },
        { guard: 'discussionComplete' },
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const parked = await runtime.handleBossInput({
      text: 'Should we redesign the trace format?',
      signal: new AbortController().signal,
    });
    expect(parked.outcome).toBe('quiescent');
    expect(parked.state.stateId).toBe('awaitBossReply');
    // The Analyst question is governed `unchanged`, not `deferred`: no
    // checkpoint-bound logical operation opens for it.
    expect(host.effectLedger.snapshot().logicalOperations).toEqual([]);

    const result = await runtime.handleBossInput({
      text: 'Yes, wait for the freeze and stop planning.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      'The planning discussion concluded after a Boss reply with no repository work to follow.',
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'discussion-complete',
    });
    expect(host.playerCalls.map(({ resume }) => resume)).toEqual([
      false,
      'analyst-question',
    ]);
    expect(host.playerCalls[1]?.prompt).toContain(
      'Boss question:\nShould this wait for the release freeze?\n\n' +
        'Boss reply:\nYes, wait for the freeze and stop planning.',
    );
    expect(host.childRequests).toEqual([]);
    await runtime.dispose();
  });

  it('relays an authored DECIDE failure without starting CODE', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'A durable decision is required first.',
        },
      ],
      judges: [{ guard: 'decideThenCode' }],
      children: [
        {
          state: 'settled',
          result: {
            status: 'error',
            playbookId: 'decide',
            childSessionId: 'decide-error',
            error: { name: 'DecideError', message: 'review rejected' },
          },
        },
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Introduce a new workflow.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      "The development workflow relayed a child playbook's authored abort, failure, or insufficient terminal result.",
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'child-failed',
      childResult: {
        playbookId: 'decide',
        status: 'error',
        error: { name: 'DecideError', message: 'review rejected' },
      },
    });
    expect(host.childRequests).toHaveLength(1);
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('reportedChildFailure');
    await runtime.dispose();
  });

  it('relays a terminal CODE result that does not prove success', async () => {
    const insufficient = {
      status: 'review-failed',
      lastCodeCommit: 'code123',
      error: { name: 'Error', message: 'unsettled findings' },
    };
    const host = await harness({
      players: [
        { status: 'ok', finalText: 'Proceed under the existing decisions.' },
      ],
      judges: [{ guard: 'code' }],
      children: [settledChild('code', 1, insufficient)],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Implement it.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'child-failed',
      childResult: { playbookId: 'code', status: 'ok', output: insufficient },
    });
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      "The development workflow relayed a child playbook's authored abort, failure, or insufficient terminal result.",
    );
    await runtime.dispose();
  });

  it('suspends on a nested child and resumes from its canonical result', async () => {
    const host = await harness({
      players: [
        {
          status: 'ok',
          finalText: 'A durable decision is required first.',
        },
      ],
      judges: [{ guard: 'decideThenCode' }],
      children: [
        { state: 'suspended', childSessionId: 'decide-suspended' },
        settledChild('code', 1, CODE_COMPLETE),
      ],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));
    const suspended = await runtime.handleBossInput({
      text: 'Introduce a new workflow.',
      signal: new AbortController().signal,
    });
    expect(suspended.outcome).toBe('suspended');
    if (suspended.outcome !== 'suspended') {
      throw new Error('expected suspension');
    }
    expect(suspended.pendingCall.playbookId).toBe('decide');

    const resumed = await runtime.resumePlaybookCall({
      callId: suspended.pendingCall.callId,
      signal: new AbortController().signal,
      result: {
        status: 'ok',
        playbookId: 'decide',
        childSessionId: 'decide-suspended',
        output: DECIDE_COMPLETE,
      },
    });
    expect(resumed.outcome).toBe('terminal');
    expect(resumed.outcome === 'terminal' ? resumed.output : undefined).toEqual(
      {
        status: 'complete',
        childPlaybookId: 'code',
        childOutput: CODE_COMPLETE,
      },
    );
    expect(host.childRequests[1]?.text).toContain('> decide123\n> rev456');
    await runtime.dispose();
  });

  it('parks a raw nested-call rejection as a control-plane failure', async () => {
    const host = await harness({
      players: [
        { status: 'ok', finalText: 'Proceed under the existing decisions.' },
      ],
      judges: [{ guard: 'code' }],
      children: [new Error('nested CODE bridge failed')],
    });
    const runtime = linkedRuntime(host);
    await runtime.init(rootSession(host.ports));

    await expect(
      runtime.handleBossInput({
        text: 'Implement it.',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('nested CODE bridge failed');
    expect(host.childRequests).toHaveLength(1);
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    await runtime.dispose();
  });
});
