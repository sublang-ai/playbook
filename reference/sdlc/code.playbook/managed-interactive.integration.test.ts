// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvent } from '@sublang/cligent';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PlaybookCallResult,
  PlaybookRuntime,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
} from '../../../src/runtime.js';
import { executionConfigFromPlan, runPlaybookRun } from './bin/run.js';
import { loadLaunchPlan, projectTmuxConfig } from './bin/launch-config.js';
import { createCaptainSessionStore } from './bin/session-store.js';

const childFixture = fileURLToPath(
  new URL('./fixtures/managed-interactive-child.mjs', import.meta.url),
);
const sessionIds = [
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000002',
  '92000000-0000-4000-8000-000000000003',
] as const;
// Match Cligent's production managed-activation bound.
const CROSS_PROCESS_BOUNDARY_TIMEOUT_MS = 30_000;
const CROSS_FRONT_TEST_TIMEOUT_MS = 45_000;
const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  }
  FixtureAdapter.reset();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('managed interactive cross-front durability (PBCLI-50)', () => {
  it('reopens an interactive-fresh session headlessly with current tuning and prior player continuity', async () => {
    const fixture = await crossFrontFixture(sessionIds[0]);
    const first = await startManagedChild(fixture, {
      mode: 'fresh',
      executionProjection: fixture.executionA,
      tmuxConfig: fixture.tmuxA,
      namespace: 'interactive-a',
    });

    const initialized = await first.waitFor('initialized');
    expect(initialized.pid).toBe(first.child.pid);
    await expectLeaseOwner(fixture, first.child.pid!);
    await assertSettledTurnZero(fixture);
    await expect(readFile(fixture.controls.readinessPath)).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    await expect(fixture.store.acquire(fixture.sessionId)).rejects.toThrow(
      /lease is active/,
    );

    first.send({ type: 'release-readiness' });
    await waitForFile(fixture.controls.readinessPath);
    await publishInputGate(fixture.controls.inputGatePath);
    await waitForFile(fixture.controls.inputActivePath);
    first.send({ type: 'submit', text: '/code interactive-first' });
    const effect = await first.waitFor(
      'effect',
      (message) => message.kind === 'player',
    );
    expect(effect).toMatchObject({
      durableState: 'uncertain',
      model: 'player-model-a',
      effort: 'high',
    });
    expect(effect).not.toHaveProperty('resume');
    const visible = await first.waitFor('reply-visible');
    expect(visible.durableState).toBe('settled');
    expect(visible.durableSnapshot.playerSessions['dev.coder']).toMatchObject({
      resumeToken: 'player-token:interactive-a:1',
    });
    const interactiveCaptainSessionId =
      visible.durableSnapshot.captain.sessionId;

    first.send({ type: 'close' });
    await first.waitFor('complete');
    first.child.disconnect();
    await waitForExit(first.child);
    expect((await fixture.store.read(fixture.sessionId)).state).toBe('settled');

    FixtureAdapter.observe(fixture.store, fixture.sessionId, 'headless-b');
    const stdout = writer();
    const stderr = writer();
    const headless = await runPlaybookRun({
      argv: ['--session', fixture.sessionId, '/code headless-second'],
      userConfigPath: fixture.configBPath,
      sessionsDir: fixture.sessionsDir,
      stdout,
      stderr,
      env: { ANTHROPIC_API_KEY: 'fixture' },
      loadModule: fixture.loadModule,
      adapterImports,
      createCaptainRuntime: fixtureCaptainRuntime,
      createCaptainSessionId: uuidSequence('73000000'),
      createAttemptId: uuidSequence('74000000'),
      probeAdapterSdk: async () => true,
    });

    expect(headless.code, stderr.text()).toBe(0);
    expect(headless.sessionId).toBe(fixture.sessionId);
    expect(headless.cwd).toBe(fixture.cwd);
    expect(stdout.text()).toContain('Cross-front durable reply headless-b:');
    expect(FixtureAdapter.effects.find((item) => item.kind === 'player'))
      .toMatchObject({
        durableState: 'uncertain',
        resume: 'player-token:interactive-a:1',
        model: 'player-model-b',
        effort: 'max',
      });
    expect(FixtureAdapter.effects.find((item) => item.kind === 'captain'))
      .toMatchObject({
        resume: 'captain-token:interactive-a:1',
        model: 'captain-model-b',
        effort: 'max',
      });
    const settled = await fixture.store.read(fixture.sessionId);
    expect(settled.state).toBe('settled');
    expect(settled.cwd).toBe(fixture.cwd);
    expect(settled.lastAppliedExecutionProjection).toEqual(fixture.executionB);
    expect(settled.snapshot.captain.sessionId).toBe(
      interactiveCaptainSessionId,
    );
    expect(settled.snapshot.sequences.turn).toBe(2);
    expect(settled.snapshot.playerSessions['dev.coder']).toMatchObject({
      resumeToken: 'player-token:headless-b:1',
    });
  }, CROSS_FRONT_TEST_TIMEOUT_MS);

  it('reopens a headless-fresh session interactively, fences its reply, and holds ownership until child shutdown', async () => {
    const fixture = await crossFrontFixture(sessionIds[1]);
    FixtureAdapter.observe(fixture.store, fixture.sessionId, 'headless-a');
    const firstStdout = writer();
    const firstStderr = writer();
    const headless = await runPlaybookRun({
      argv: ['/code headless-first'],
      userConfigPath: fixture.configAPath,
      sessionsDir: fixture.sessionsDir,
      stdout: firstStdout,
      stderr: firstStderr,
      env: { ANTHROPIC_API_KEY: 'fixture' },
      loadModule: fixture.loadModule,
      adapterImports,
      createCaptainRuntime: fixtureCaptainRuntime,
      createLogicalSessionId: () => fixture.sessionId,
      createCaptainSessionId: uuidSequence('75000000'),
      createAttemptId: uuidSequence('76000000'),
      probeAdapterSdk: async () => true,
      cwd: fixture.cwd,
    });
    expect(headless.code, firstStderr.text()).toBe(0);
    expect(headless.sessionId).toBe(fixture.sessionId);
    const headlessRecord = await fixture.store.read(fixture.sessionId);
    expect(headlessRecord.snapshot.playerSessions).toMatchObject({
      'dev.coder': { resumeToken: 'player-token:headless-a:1' },
    });
    const headlessCaptainSessionId = headlessRecord.snapshot.captain.sessionId;

    const selected = await startManagedChild(fixture, {
      mode: 'selected',
      executionProjection: fixture.executionB,
      tmuxConfig: fixture.tmuxB,
      namespace: 'interactive-b',
    });
    await selected.waitFor('initialized');
    await expectLeaseOwner(fixture, selected.child.pid!);
    await expect(fixture.store.acquire(fixture.sessionId)).rejects.toThrow(
      /lease is active/,
    );
    const contenderStdout = writer();
    const contenderStderr = writer();
    const effectsBeforeContender = FixtureAdapter.effects.length;
    const contender = await runPlaybookRun({
      argv: ['--session', fixture.sessionId, '/code blocked-contender'],
      userConfigPath: fixture.configBPath,
      sessionsDir: fixture.sessionsDir,
      stdout: contenderStdout,
      stderr: contenderStderr,
      env: { ANTHROPIC_API_KEY: 'fixture' },
      loadModule: fixture.loadModule,
      adapterImports,
      createCaptainRuntime: fixtureCaptainRuntime,
      createCaptainSessionId: uuidSequence('77000000'),
      createAttemptId: uuidSequence('78000000'),
      probeAdapterSdk: async () => true,
    });
    expect(contender.code).toBe(1);
    expect(contenderStdout.text()).toBe('');
    expect(contenderStderr.text()).toMatch(/lease|active|owner/i);
    expect(FixtureAdapter.effects).toHaveLength(effectsBeforeContender);

    selected.send({ type: 'release-readiness' });
    await waitForFile(fixture.controls.readinessPath);
    await publishInputGate(fixture.controls.inputGatePath);
    await waitForFile(fixture.controls.inputActivePath);
    selected.send({ type: 'submit', text: '/code interactive-second' });
    const effect = await selected.waitFor(
      'effect',
      (message) => message.kind === 'player',
    );
    expect(effect).toMatchObject({
      durableState: 'uncertain',
      resume: 'player-token:headless-a:1',
      model: 'player-model-b',
      effort: 'max',
    });
    const captainEffect = await selected.waitFor(
      'effect',
      (message) => message.kind === 'captain',
    );
    expect(captainEffect).toMatchObject({
      resume: 'captain-token:headless-a:1',
      model: 'captain-model-b',
      effort: 'max',
    });
    const visible = await selected.waitFor('reply-visible');
    expect(visible.durableState).toBe('settled');
    expect(visible.durableSnapshot.playerSessions['dev.coder']).toMatchObject({
      resumeToken: 'player-token:interactive-b:1',
    });
    await expect(fixture.store.acquire(fixture.sessionId)).rejects.toThrow(
      /lease is active/,
    );

    selected.send({ type: 'close' });
    await selected.waitFor('complete');
    selected.child.disconnect();
    await waitForExit(selected.child);
    const reopened = await fixture.store.acquire(fixture.sessionId);
    await reopened.release();
    const settled = await fixture.store.read(fixture.sessionId);
    expect(settled.state).toBe('settled');
    expect(settled.sessionId).toBe(fixture.sessionId);
    expect(settled.cwd).toBe(fixture.cwd);
    expect(settled.lastAppliedExecutionProjection).toEqual(fixture.executionB);
    expect(settled.snapshot.captain.sessionId).toBe(headlessCaptainSessionId);
    expect(settled.snapshot.sequences.turn).toBe(2);
  }, CROSS_FRONT_TEST_TIMEOUT_MS);

  it('keeps the durable turn settled when ordered reply release later fails', async () => {
    const fixture = await crossFrontFixture(sessionIds[2]);
    const child = await startManagedChild(fixture, {
      mode: 'fresh',
      executionProjection: fixture.executionA,
      tmuxConfig: fixture.tmuxA,
      namespace: 'post-fence-failure',
      failReplyObserver: true,
    });

    await child.waitFor('initialized');
    child.send({ type: 'release-readiness' });
    await waitForFile(fixture.controls.readinessPath);
    await publishInputGate(fixture.controls.inputGatePath);
    await waitForFile(fixture.controls.inputActivePath);
    child.send({ type: 'submit', text: '/code settle-before-presentation' });

    const visible = await child.waitFor('reply-visible');
    expect(visible.durableState).toBe('settled');
    expect(visible.durableSnapshot.sequences.turn).toBe(1);
    const failure = await child.waitFor('error');
    expect(failure.message).toContain(
      'synthetic post-settlement observer failure',
    );
    child.child.disconnect();
    await waitForExit(child.child);

    const record = await fixture.store.read(fixture.sessionId);
    expect(record).toEqual(visible.durableRecord);
    expect(record).toMatchObject({
      state: 'settled',
      sessionId: fixture.sessionId,
      snapshot: { sequences: { turn: 1 } },
    });
    expect(record).not.toHaveProperty('uncertain');
    const next = await fixture.store.acquire(fixture.sessionId);
    await next.release();
  }, CROSS_FRONT_TEST_TIMEOUT_MS);
});

async function crossFrontFixture(sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), 'playbook-cross-front-'));
  tempDirs.push(root);
  const cwd = join(root, 'working-directory');
  const sessionsDir = join(root, 'sessions');
  await mkdir(cwd);
  const controls = await managedControlBoundary(root, sessionId);
  const configAPath = join(root, 'playbook-a.yaml');
  const configBPath = join(root, 'playbook-b.yaml');
  await writeFile(configAPath, configText('a'));
  await writeFile(configBPath, configText('b'));
  const modules = { 'mod://code': { default: fixtureRegistryEntry() } };
  const loadModule = async (specifier: string) => {
    if (!(specifier in modules)) throw new Error(`no module ${specifier}`);
    return modules[specifier as keyof typeof modules];
  };
  const planA = await loadLaunchPlan({
    userConfigPath: configAPath,
    loadModule,
  });
  const planB = await loadLaunchPlan({
    userConfigPath: configBPath,
    loadModule,
  });
  const executionA = executionConfigFromPlan(planA);
  const executionB = executionConfigFromPlan(planB);
  const tmuxA = projectTmuxConfig(planA);
  const tmuxB = projectTmuxConfig(planB);
  await writeFile(
    join(controls.workDir, 'tmux-play.config.snapshot.json'),
    `${JSON.stringify(tmuxA)}\n`,
  );
  return {
    root,
    cwd,
    sessionsDir,
    sessionId,
    controls,
    configAPath,
    configBPath,
    executionA,
    executionB,
    tmuxA,
    tmuxB,
    loadModule,
    store: createCaptainSessionStore({ sessionsDir }),
  };
}

async function startManagedChild(
  fixture: Awaited<ReturnType<typeof crossFrontFixture>>,
  options: {
    mode: 'fresh' | 'selected';
    executionProjection: unknown;
    tmuxConfig: unknown;
    namespace: string;
    failReplyObserver?: boolean;
  },
) {
  await writeFile(
    join(fixture.controls.workDir, 'tmux-play.config.snapshot.json'),
    `${JSON.stringify(options.tmuxConfig)}\n`,
  );
  const payload = {
    schemaVersion: 1,
    kind: 'playbook-managed-interactive-launch',
    mode: options.mode,
    sessionId: fixture.sessionId,
    cwd: fixture.cwd,
    sessionsDir: fixture.sessionsDir,
    noProvision: false,
    executionProjection: options.executionProjection,
    ...fixture.controls,
    workDirOwnedByLauncher: false,
  };
  const child = fork(childFixture, [], {
    env: {
      PLAYBOOK_MANAGED_PAYLOAD: JSON.stringify(payload),
      PLAYBOOK_TOKEN_NAMESPACE: options.namespace,
      ...(options.failReplyObserver
        ? { PLAYBOOK_FAIL_REPLY_OBSERVER: '1' }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const messages: any[] = [];
  const waiters = new Set<{
    type: string;
    predicate: (value: any) => boolean;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  child.on('message', (message) => {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (message?.type !== waiter.type || !waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });
  child.on('exit', (code, signal) => {
    if (code === 0 && signal === null) return;
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(
        new Error(
          `managed child exited before ${waiter.type}: code=${code} signal=${signal}; stderr=${stderr}; messages=${JSON.stringify(messages)}`,
        ),
      );
    }
  });
  return {
    child,
    send: (message: unknown) => child.send(message),
    waitFor(type: string, predicate = (_value: any) => true) {
      const prior = messages.find(
        (message) => message?.type === type && predicate(message),
      );
      if (prior !== undefined) return Promise.resolve(prior);
      return new Promise<any>((resolve, reject) => {
        const waiter = {
          type,
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `timed out waiting for ${type}; stderr=${stderr}; messages=${JSON.stringify(messages)}`,
              ),
            );
          }, CROSS_PROCESS_BOUNDARY_TIMEOUT_MS),
        };
        waiters.add(waiter);
      });
    },
  };
}

async function managedControlBoundary(root: string, sessionId: string) {
  const workDir = join(root, 'managed-work');
  const coordinationDir = join(root, 'managed-control');
  await mkdir(workDir, { mode: 0o700 });
  await mkdir(coordinationDir, { mode: 0o700 });
  await chmod(workDir, 0o700);
  await chmod(coordinationDir, 0o700);
  return {
    workDir,
    readinessPath: join(coordinationDir, 'status.json'),
    inputGatePath: join(coordinationDir, 'input-ready'),
    inputActivePath: join(coordinationDir, 'input-active'),
    shutdownRequestPath: join(coordinationDir, 'shutdown-request'),
    shutdownCompletePath: join(coordinationDir, 'shutdown-complete'),
  };
}

async function assertSettledTurnZero(
  fixture: Awaited<ReturnType<typeof crossFrontFixture>>,
) {
  const record = await fixture.store.read(fixture.sessionId);
  expect(record).toMatchObject({
    state: 'settled',
    sessionId: fixture.sessionId,
    cwd: fixture.cwd,
    snapshot: {
      schemaVersion: 3,
      sequences: { turn: 0, journal: 0 },
      playerSessions: { 'dev.coder': { adapter: 'claude' } },
    },
  });
  expect(record.snapshot.playerSessions['dev.coder']).not.toHaveProperty(
    'resumeToken',
  );
}

async function expectLeaseOwner(
  fixture: Awaited<ReturnType<typeof crossFrontFixture>>,
  expectedPid: number,
) {
  const owner = JSON.parse(
    await readFile(
      join(
        fixture.sessionsDir,
        `.${fixture.sessionId}.lock`,
        'owner.json',
      ),
      'utf8',
    ),
  );
  expect(owner).toMatchObject({
    sessionId: fixture.sessionId,
    pid: expectedPid,
  });
}

function configText(tuning: 'a' | 'b') {
  const settings =
    tuning === 'a'
      ? {
          captainModel: 'captain-model-a',
          captainEffort: 'high',
          playerModel: 'player-model-a',
          playerEffort: 'high',
        }
      : {
          captainModel: 'captain-model-b',
          captainEffort: 'max',
          playerModel: 'player-model-b',
          playerEffort: 'max',
        };
  return [
    `captain: { adapter: claude, model: ${settings.captainModel}, effort: ${settings.captainEffort} }`,
    'players:',
    `  dev.coder: { adapter: claude, model: ${settings.playerModel}, effort: ${settings.playerEffort} }`,
    'playbooks:',
    '  code:',
    '    from: mod://code',
    '    roles: { coder: dev.coder }',
    '',
  ].join('\n');
}

class FixtureAdapter {
  static namespace = 'headless';
  static effects: Array<Record<string, unknown>> = [];
  static playerCalls = 0;
  static captainCalls = 0;
  static store: ReturnType<typeof createCaptainSessionStore> | undefined;
  static sessionId: string | undefined;
  readonly agent = 'claude-code';

  static observe(
    store: ReturnType<typeof createCaptainSessionStore>,
    sessionId: string,
    namespace: string,
  ) {
    this.store = store;
    this.sessionId = sessionId;
    this.namespace = namespace;
  }

  static reset() {
    this.namespace = 'headless';
    this.effects = [];
    this.playerCalls = 0;
    this.captainCalls = 0;
    this.store = undefined;
    this.sessionId = undefined;
  }

  async *run(prompt: string, options?: any) {
    const kind = prompt.includes('cross-front-player:') ? 'player' : 'captain';
    const sequence =
      kind === 'player'
        ? ++FixtureAdapter.playerCalls
        : ++FixtureAdapter.captainCalls;
    const durable =
      FixtureAdapter.store === undefined ||
      FixtureAdapter.sessionId === undefined
        ? undefined
        : await FixtureAdapter.store.read(FixtureAdapter.sessionId);
    FixtureAdapter.effects.push({
      kind,
      prompt,
      resume: options?.resume,
      model: options?.model,
      effort: options?.effort,
      durableState: durable?.state,
    });
    const result =
      kind === 'player'
        ? `worker result ${sequence}`
        : `Cross-front durable reply ${FixtureAdapter.namespace}:${sequence}`;
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result,
        resumeToken: `${kind}-token:${FixtureAdapter.namespace}:${sequence}`,
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      `transport:${FixtureAdapter.namespace}:${kind}:${sequence}`,
    );
  }

  async isAvailable() {
    return true;
  }
}

const adapterImports = Object.fromEntries(
  ['claude', 'codex', 'gemini', 'kimi', 'opencode'].map((adapter) => [
    adapter,
    async () => FixtureAdapter,
  ]),
) as any;

function fixtureRegistryEntry() {
  return {
    id: 'code',
    command: 'code',
    intent: 'exercise one durable player',
    artifactSchema: 2 as const,
    requiredRoleIds: ['coder'],
    concurrentRoleSets: [] as const,
    validateOptions: (value: unknown) => value,
    createRuntime(): PlaybookRuntime {
      let session: PlaybookSession;
      return {
        async init(next) {
          session = next;
        },
        async handleBossInput({ text, signal }) {
          const result = await session.ports.callPlayer(
            'coder',
            `cross-front-player:${text}`,
            signal,
            { resume: session.playerSessions!.select('coder') },
          );
          session.playerSessions!.update('coder', result.resumeToken);
          return {
            outcome: 'terminal',
            state: terminalState(),
            output: { response: result.finalText },
          };
        },
        async resumePlaybookCall(_input: {
          callId: string;
          result: PlaybookCallResult;
        }) {
          return { outcome: 'no-action', state: activeState() };
        },
        async dispose() {},
      };
    },
  };
}

function fixtureCaptainRuntime({ controller }: any): PlaybookRuntime {
  let session: PlaybookSession;
  let turns = 0;
  return {
    async init(next) {
      session = next;
    },
    async restore(next, snapshot) {
      session = next;
      turns = snapshot.sequences.turn;
    },
    exportSnapshot() {
      return runtimeSnapshot(turns);
    },
    async handleBossInput({ text, signal }) {
      turns += 1;
      const parsed = controller.resolveParsedTurn(text);
      if (parsed?.kind !== 'action') {
        throw new Error('cross-front fixture requires one slash action');
      }
      await controller.submit(parsed.decision, signal);
      await session.ports.emitTelemetry({
        topic: 'playbook.trace',
        payload: {
          type: 'captain.call.started',
          payload: { stateId: 'reporting' },
        },
      });
      await session.ports.callCaptain(
        `cross-front-captain:${text}`,
        signal,
        { visibility: 'hidden', resume: false, allowedTools: [] },
      );
      return { outcome: 'quiescent', state: activeState() };
    },
    async resumePlaybookCall() {
      return { outcome: 'no-action', state: activeState() };
    },
    async dispose() {},
  };
}

function runtimeSnapshot(turn: number): PlaybookRuntimeSnapshot {
  const state = activeState();
  return {
    schemaVersion: 3,
    playbookId: 'captain',
    machine: { value: state.value, status: state.status },
    roleResumeTokens: {},
    sequences: {
      trace: 0,
      turn,
      judgeCall: 0,
      playerCall: 0,
      playbookCall: 0,
      captainCall: 0,
    },
    state,
    pendingBossQuestions: [],
  };
}

function activeState(): PlaybookState {
  return {
    value: 'playbook.parked',
    activeStateIds: ['playbook.parked'],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId: 'playbook.parked',
  };
}

function terminalState(): PlaybookState {
  return {
    value: 'done',
    activeStateIds: ['done'],
    tags: [],
    status: 'done',
    quiescent: true,
    stateId: 'done',
  };
}

function uuidSequence(prefix: string) {
  let value = 0;
  return () =>
    `${prefix}-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function writer() {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}

// Publish the input gate atomically, mirroring Cligent's own
// publishManagedControlMarker: land the bytes in a temp file, then link the
// complete inode into place. A bare writeFile makes the pathname visible at
// open('wx') before the bytes land, and the consumer's 10ms poll reads the
// empty file as an invalid gate — the recurring input-active timeout. link
// (unlike rename) also keeps the create-once EEXIST boundary.
async function publishInputGate(path: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, 'ready\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function waitForFile(path: string) {
  const deadline = Date.now() + CROSS_PROCESS_BOUNDARY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode] as const;
  }
  return (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
}
