// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assign, createMachine } from 'xstate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PlayerResult,
  PlayerSessionStore,
  PlaybookEffectBoundary,
  PlaybookEffectLedger,
  PlaybookPorts,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
} from './runtime.js';
import { assertPlaybookEffectLedger } from './xstate-runtime.js';
import {
  createXStatePlaybookRuntime,
  RUNTIME_ABI,
  type XStatePlaybookRuntimeSpecV3,
} from './xstate-playbook-runtime.js';
import { createWorktreeHostCapabilities } from '../reference/sdlc/code.playbook/host-capabilities.js';

interface EmptyOptions {}

const PLAYBOOK_ID = 'question-origin-fixture';
const ROLE_ID = 'coder';
const STATE_ID = 'work';
const SOURCE_ITEM = 'QO-1';
const QUESTION = 'Which format should I use?';
const SESSION_ID = '30000000-0000-4000-8000-000000000001';

let scratch: string | undefined;

const stateMeta = (stateId: string, description: string) => ({
  playbook: { stateId, description },
});

const roleMeta = (stateId: string, role: string, description: string) => ({
  playbook: { stateId, role, description },
});

const pendingQuestion = (question = QUESTION) => ({
  questionId: STATE_ID,
  resumeStateId: STATE_ID,
  sourceItem: SOURCE_ITEM,
  asker: { kind: 'role' as const, roleId: ROLE_ID },
  question,
});

const resultDescriptions = {
  question:
    "The acting agent asks Boss and waits without changing the repository. Output shall include `question: <verbatim question text from the acting agent's prose>`.",
  needsBossReply:
    "The acting agent needs Boss input before completing a repository change. Output shall include `question: <verbatim question text from the acting agent's prose>`.",
  complete: 'The task is complete. Output shall include no additional fields.',
};

const questionOriginMachine = createMachine({
  id: PLAYBOOK_ID,
  context: {
    task: '',
    pendingBossQuestion: undefined as
      ReturnType<typeof pendingQuestion> | undefined,
    bossReply: undefined as string | undefined,
  },
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for work.'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: STATE_ID,
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
            pendingBossQuestion: () => undefined,
            bossReply: () => undefined,
          }),
        },
      },
    },
    [STATE_ID]: {
      meta: roleMeta(STATE_ID, ROLE_ID, 'Resolve the question-origin fixture.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: STATE_ID,
          role: ROLE_ID,
          sourceItem: SOURCE_ITEM,
          prompt: `Resolve ${context.task}.`,
          result: resultDescriptions,
          ...(context.pendingBossQuestion === undefined
            ? {}
            : { pendingBossQuestion: context.pendingBossQuestion }),
          ...(context.bossReply === undefined
            ? {}
            : { bossReply: context.bossReply }),
        }),
        onDone: [
          {
            guard: ({ event }) =>
              (event as { output?: { guard?: string } }).output?.guard ===
              'question',
            target: 'awaitBossReply',
            actions: assign({
              pendingBossQuestion: ({ event }) =>
                pendingQuestion(
                  (event as { output: { question: string } }).output.question,
                ),
              bossReply: () => undefined,
            }),
          },
          {
            guard: ({ event }) =>
              (event as { output?: { guard?: string } }).output?.guard ===
              'needsBossReply',
            target: 'awaitBossReply',
            actions: assign({
              pendingBossQuestion: ({ event }) =>
                pendingQuestion(
                  (event as { output: { question: string } }).output.question,
                ),
              bossReply: () => undefined,
            }),
          },
          {
            target: 'ready',
            actions: assign({
              pendingBossQuestion: () => undefined,
              bossReply: () => undefined,
            }),
          },
        ],
        onError: 'ready',
      },
    },
    awaitBossReply: {
      meta: stateMeta('awaitBossReply', 'Waiting for Boss to answer Coder.'),
      tags: ['playbook.parked'],
      on: {
        BOSS_REPLY: {
          guard: ({ context, event }) => {
            const reply = event as { questionId?: string; answer?: string };
            return (
              typeof reply.answer === 'string' &&
              reply.answer.trim().length > 0 &&
              (reply.questionId === undefined ||
                reply.questionId === context.pendingBossQuestion?.questionId)
            );
          },
          target: STATE_ID,
          reenter: true,
          actions: assign({
            bossReply: ({ event }) => (event as { answer: string }).answer,
          }),
        },
      },
    },
  },
});

function runtimeSpec(): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return {
    label: 'QUESTION-ORIGIN',
    compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    roleStates: {
      [STATE_ID]: {
        role: ROLE_ID,
        label: 'Resolve the question-origin fixture.',
      },
    },
    classifyBossText: async (text) => ({
      type: 'BOSS_REPLY',
      questionId: STATE_ID,
      answer: text,
    }),
    verbatimPayloadFields: new Set(['question']),
    outcomeAuthority: {
      governedPlayerStates: {
        [STATE_ID]: {
          question: {
            fields: { question: 'presentation' },
            repositoryDisposition: 'unchanged',
          },
          needsBossReply: {
            fields: { question: 'presentation' },
            repositoryDisposition: 'deferred',
          },
          complete: {
            fields: {},
            repositoryDisposition: 'one-descendant-commit',
          },
        },
      },
    },
  };
}

function bossTurn(text: string) {
  return { text, signal: new AbortController().signal };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}

async function makeRepo(name: string): Promise<string> {
  if (scratch === undefined)
    scratch = await mkdtemp(join(tmpdir(), 'pending-question-origin-'));
  const dir = join(scratch, name);
  await mkdir(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'pending-question-origin@sublang.ai');
  git(dir, 'config', 'user.name', 'Pending Question Origin');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

function makePlayerStore(
  initial: string | false = false,
): PlayerSessionStore & {
  set(next: string | false): void;
} {
  let token = initial;
  return {
    select: () => token,
    update: (_roleId, next) => {
      token = next ?? false;
    },
    snapshot: () => (token === false ? {} : { [ROLE_ID]: token }),
    restore: (tokens) => {
      token = tokens[ROLE_ID] ?? false;
    },
    set: (next) => {
      token = next;
    },
  };
}

function portsFor(
  repoDir: string,
  playerResults: PlayerResult[],
  judgeGuards: string[],
) {
  const resumes: Array<string | false> = [];
  const prompts: string[] = [];
  const playerCalls: Array<{
    roleId: string;
    options: { resume: string | false };
  }> = [];
  let commitIndex = 0;
  const ports: PlaybookPorts = {
    callPlayer: vi.fn(async (roleId, prompt, _signal, options) => {
      resumes.push(options.resume);
      prompts.push(prompt);
      playerCalls.push({ roleId, options });
      const result = playerResults.shift();
      if (result === undefined) throw new Error('unexpected player call');
      if (result.finalText === 'Committed.') {
        commitIndex += 1;
        await writeFile(
          join(repoDir, `commit-${commitIndex}.txt`),
          `commit ${commitIndex}\n`,
        );
        git(repoDir, 'add', '-A');
        git(repoDir, 'commit', '-qm', `commit ${commitIndex}`);
      }
      return result;
    }),
    callJudge: vi.fn(async () => {
      const guard = judgeGuards.shift();
      if (guard === undefined) throw new Error('unexpected judge call');
      return JSON.stringify({ guard });
    }),
    callCaptain: vi.fn(async () => ({ status: 'ok', finalText: 'unused' })),
    callPlaybook: vi.fn(async () => {
      throw new Error('nested playbook calls are outside this fixture');
    }),
    emitStatus: vi.fn(async () => undefined),
    emitTelemetry: vi.fn(async () => undefined),
  };
  return { ports, resumes, prompts, playerCalls };
}

function session(
  ports: PlaybookPorts,
  playerSessions: PlayerSessionStore,
): PlaybookSession {
  return {
    sessionId: SESSION_ID,
    playbookId: PLAYBOOK_ID,
    rootSessionId: SESSION_ID,
    depth: 0,
    roleBindings: {
      [ROLE_ID]: { playerId: ROLE_ID, promptIdentity: ROLE_ID },
    },
    playerSessions,
    ports,
  };
}

async function capabilitiesFor(
  repoDir: string,
  effectLedger?: PlaybookEffectLedger,
) {
  return createWorktreeHostCapabilities({
    cwd: repoDir,
    playbookId: PLAYBOOK_ID,
    requiredRoleIds: [ROLE_ID],
    ...(effectLedger === undefined ? {} : { effectLedger }),
  });
}

async function createRuntime(
  repoDir: string,
  effectLedger?: PlaybookEffectLedger,
) {
  const hostCapabilities = await capabilitiesFor(repoDir, effectLedger);
  const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
    questionOriginMachine,
    runtimeSpec(),
  )({ configuredOptions: {}, hostCapabilities });
  return { runtime, hostCapabilities };
}

async function parkedFixture(
  variant: 'authored' | 'canonical',
  repoName = variant,
) {
  const repoDir = await makeRepo(repoName);
  const playerStore = makePlayerStore();
  const harness = portsFor(
    repoDir,
    [{ status: 'ok', finalText: QUESTION, resumeToken: 'question-token' }],
    [variant === 'authored' ? 'question' : 'needsBossReply'],
  );
  const { runtime, hostCapabilities } = await createRuntime(repoDir);
  await runtime.init(session(harness.ports, playerStore));
  await expect(
    runtime.handleBossInput(bossTurn('original task')),
  ).resolves.toMatchObject({
    outcome: 'quiescent',
    state: { stateId: 'awaitBossReply' },
  });
  const snapshot = runtime.exportSnapshot!()!;
  const ledger = hostCapabilities.effectLedger.snapshot();
  await runtime.dispose();
  return { repoDir, snapshot, ledger, playerStore, harness };
}

function appendStandaloneBoundary(
  ledger: PlaybookEffectLedger,
  boundary: Partial<PlaybookEffectBoundary> = {},
): PlaybookEffectLedger {
  const base = ledger.boundaries.at(-1)!;
  const nextBoundary: PlaybookEffectBoundary = {
    ...base,
    sequence: (ledger.boundaries.at(-1)?.sequence ?? 0) + 1,
    boundaryId: randomUUID(),
    callId: randomUUID(),
    sourceStateId: STATE_ID,
    roleId: ROLE_ID,
    physicalReceipt: {
      classification: 'unchanged',
      baseline: base.physicalReceipt?.after ?? base.baseline,
      after: base.physicalReceipt?.after ?? base.baseline,
    },
    finalText: QUESTION,
    semanticCandidate: { guard: 'question' },
    sourceOutcomeSchema: resultDescriptions,
    correctionBudget: { limit: 1, spent: false },
    ...boundary,
  };
  delete (nextBoundary as { logicalOperationId?: string }).logicalOperationId;
  return assertPlaybookEffectLedger({
    ...ledger,
    revision: ledger.revision + 1,
    boundaries: [...ledger.boundaries, nextBoundary],
  });
}

function replaceLatestBoundary(
  ledger: PlaybookEffectLedger,
  mutate: (boundary: PlaybookEffectBoundary) => PlaybookEffectBoundary,
): PlaybookEffectLedger {
  const boundaries = [...ledger.boundaries];
  boundaries[boundaries.length - 1] = mutate(
    boundaries[boundaries.length - 1]!,
  );
  return assertPlaybookEffectLedger({
    ...ledger,
    revision: ledger.revision + 1,
    boundaries,
  });
}

function removeCanonicalOperation(
  ledger: PlaybookEffectLedger,
): PlaybookEffectLedger {
  return assertPlaybookEffectLedger({
    ...ledger,
    revision: ledger.revision + 1,
    boundaries: ledger.boundaries.map((boundary) => {
      const next = { ...boundary } as {
        logicalOperationId?: string;
      } & PlaybookEffectBoundary;
      delete next.logicalOperationId;
      return next;
    }),
    logicalOperations: [],
  });
}

function publicPendingQuestion(question = QUESTION) {
  return {
    questionId: STATE_ID,
    sourceItem: SOURCE_ITEM,
    asker: { kind: 'role' as const, roleId: ROLE_ID },
    question,
  };
}

function snapshotWithLedger(
  snapshot: PlaybookRuntimeSnapshot,
  ledger: PlaybookEffectLedger,
  token: string | false = 'question-token',
): PlaybookRuntimeSnapshot {
  return {
    ...snapshot,
    roleResumeTokens: token === false ? {} : { [ROLE_ID]: token },
    pendingBossQuestions: [publicPendingQuestion()],
    effectLedger: ledger,
  };
}

async function restoreAndAnswer(options: {
  repoDir: string;
  snapshot: PlaybookRuntimeSnapshot;
  effectLedger: PlaybookEffectLedger;
  token: string | false;
}) {
  const playerStore = makePlayerStore(options.token);
  const harness = portsFor(
    options.repoDir,
    [{ status: 'ok', finalText: 'Committed.', resumeToken: 'complete-token' }],
    ['complete'],
  );
  const { runtime, hostCapabilities } = await createRuntime(
    options.repoDir,
    options.effectLedger,
  );
  await runtime.restore!(
    session(harness.ports, playerStore),
    snapshotWithLedger(options.snapshot, options.effectLedger, options.token),
  );
  return { runtime, hostCapabilities, harness };
}

afterEach(async () => {
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

describe('pending question origin restore', () => {
  it.each([
    ['authored', 'backend-token'] as const,
    ['authored', false] as const,
    ['canonical', 'backend-token'] as const,
    ['canonical', false] as const,
  ])('resumes %s question with current token %s', async (variant, token) => {
    const fixture = await parkedFixture(variant, `${variant}-${String(token)}`);
    const { runtime, hostCapabilities, harness } = await restoreAndAnswer({
      repoDir: fixture.repoDir,
      snapshot: fixture.snapshot,
      effectLedger: fixture.ledger,
      token,
    });

    await expect(
      runtime.handleBossInput(bossTurn('Use Markdown.')),
    ).resolves.toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'ready' },
    });

    const completed = hostCapabilities.effectLedger.snapshot();
    expect(harness.resumes).toEqual([token]);
    expect(harness.playerCalls).toHaveLength(1);
    expect(harness.prompts[0]).toContain('Use Markdown.');
    if (token === false) expect(harness.prompts[0]).toContain(QUESTION);
    else expect(harness.prompts[0]).not.toContain(QUESTION);
    expect(completed.boundaries).toHaveLength(2);
    expect(completed.boundaries[1]?.physicalReceipt?.classification).toBe(
      'one-descendant-commit',
    );
    if (variant === 'authored') {
      expect(completed.logicalOperations).toEqual([]);
    } else {
      expect(completed.logicalOperations).toHaveLength(1);
      expect(completed.logicalOperations[0]).toMatchObject({
        boundaryIds: completed.boundaries.map(({ boundaryId }) => boundaryId),
        logicalReceipt: { classification: 'one-descendant-commit' },
      });
    }
    await runtime.dispose();
  });

  it.each([
    [
      'latest owned boundary source mismatch',
      (ledger: PlaybookEffectLedger) =>
        appendStandaloneBoundary(ledger, { sourceStateId: 'otherWork' }),
      QUESTION,
    ],
    [
      'latest owned boundary role mismatch',
      (ledger: PlaybookEffectLedger) =>
        replaceLatestBoundary(ledger, (boundary) => ({
          ...boundary,
          roleId: 'reviewer',
        })),
      QUESTION,
    ],
    [
      'runtime-owned boundary absent',
      (ledger: PlaybookEffectLedger) =>
        replaceLatestBoundary(ledger, (boundary) => ({
          ...boundary,
          runtimeSessionId: randomUUID(),
        })),
      QUESTION,
    ],
    [
      'retained question text mismatch',
      (ledger: PlaybookEffectLedger) =>
        replaceLatestBoundary(ledger, (boundary) => ({
          ...boundary,
          finalText: 'Which different format should I use?',
        })),
      QUESTION,
    ],
  ])('rejects authored unchanged origin when %s', async (_name, mutate) => {
    const fixture = await parkedFixture(
      'authored',
      `reject-${_name.replaceAll(' ', '-')}`,
    );
    const mutated = mutate(fixture.ledger);
    const restored = await restoreAndAnswer({
      repoDir: fixture.repoDir,
      snapshot: fixture.snapshot,
      effectLedger: mutated,
      token: 'backend-token',
    });

    await expect(
      restored.runtime.handleBossInput(bossTurn('Use Markdown.')),
    ).rejects.toThrow(/deferred|logical operation|retained|continuation/i);
    expect(restored.harness.playerCalls).toHaveLength(0);
    expect(restored.hostCapabilities.effectLedger.snapshot()).toEqual(mutated);
    await restored.runtime.dispose();
  });

  it('keeps an open canonical operation ahead of a later matching authored boundary', async () => {
    const fixture = await parkedFixture('canonical', 'open-operation-shadow');
    const shadowed = appendStandaloneBoundary(fixture.ledger);
    const { runtime, hostCapabilities, harness } = await restoreAndAnswer({
      repoDir: fixture.repoDir,
      snapshot: fixture.snapshot,
      effectLedger: shadowed,
      token: 'backend-token',
    });

    await expect(
      runtime.handleBossInput(bossTurn('Use Markdown.')),
    ).resolves.toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'ready' },
    });
    const completed = hostCapabilities.effectLedger.snapshot();
    expect(harness.resumes).toEqual(['backend-token']);
    expect(completed.logicalOperations).toHaveLength(1);
    expect(completed.logicalOperations[0]).toMatchObject({
      operationId: fixture.ledger.logicalOperations[0]?.operationId,
      logicalReceipt: { classification: 'one-descendant-commit' },
    });
    expect(completed.logicalOperations[0]?.boundaryIds).toEqual([
      fixture.ledger.boundaries[0]?.boundaryId,
      completed.boundaries[2]?.boundaryId,
    ]);
    await runtime.dispose();
  });

  it('marks canonical checkpoint mismatch without starting the player', async () => {
    const fixture = await parkedFixture('canonical', 'checkpoint-mismatch');
    const { runtime, hostCapabilities, harness } = await restoreAndAnswer({
      repoDir: fixture.repoDir,
      snapshot: fixture.snapshot,
      effectLedger: fixture.ledger,
      token: 'backend-token',
    });
    await writeFile(join(fixture.repoDir, 'foreign.txt'), 'foreign\n');

    await expect(
      runtime.handleBossInput(bossTurn('Use Markdown.')),
    ).resolves.toMatchObject({
      outcome: 'no-action',
    });
    expect(harness.playerCalls).toHaveLength(0);
    expect(
      hostCapabilities.effectLedger.snapshot().logicalOperations[0],
    ).toMatchObject({
      checkpointRestorationEligible: true,
    });
    const view = runtime.describe?.();
    expect(view?.pendingQuestions).toEqual([]);
    expect(view?.actions.map(({ id }) => id)).toContain(
      'reconcile:unresolved-effect',
    );
    await runtime.dispose();
  });

  it('rejects a canonical pending question whose operation was removed', async () => {
    const fixture = await parkedFixture('canonical', 'missing-operation');
    const mutated = removeCanonicalOperation(fixture.ledger);
    const { runtime, hostCapabilities, harness } = await restoreAndAnswer({
      repoDir: fixture.repoDir,
      snapshot: fixture.snapshot,
      effectLedger: mutated,
      token: 'backend-token',
    });

    await expect(
      runtime.handleBossInput(bossTurn('Use Markdown.')),
    ).rejects.toThrow(/deferred|logical operation|continuation/i);
    expect(harness.playerCalls).toHaveLength(0);
    expect(hostCapabilities.effectLedger.snapshot()).toEqual(mutated);
    await runtime.dispose();
  });
});
