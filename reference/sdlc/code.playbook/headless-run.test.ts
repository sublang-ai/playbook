// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  createEvent,
  type AgentAdapter,
  type AgentEvent,
  type AgentOptions,
  type RuntimeReadiness,
  type RuntimeTarget,
} from '@sublang/cligent';
import { createTmuxPlayRuntime } from '@sublang/cligent/tmux-play';
import { createXStatePlaybookRuntime } from '@sublang/playbook/xstate-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captainMachine } from '../captain.playbook/captain.fsm.js';
import type {
  PlaybookCallResult,
  PlaybookRuntime,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
} from '../../../src/runtime.js';
import { emptyPlaybookEffectLedger } from '../../../src/xstate-runtime.js';

const { runPlaybookCli, runPlaybookCliEntry } = await import(
  new URL('./bin/playbook.js', import.meta.url).href
);
const {
  installRetainedGenerationsForLaunch,
  parseRunArgs,
  validateFrozenExecutionConfig,
} = await import(new URL('./bin/run.js', import.meta.url).href);
const { createCaptainSessionStore, sanitizeReplayRecord } = await import(
  new URL('./bin/session-store.js', import.meta.url).href
);
const { createRepositoryEffectCapabilities } = await import(
  new URL('./bin/repository-effects.js', import.meta.url).href
);

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  FakeAdapter.calls = [];
  FakeAdapter.options = [];
  FakeAdapter.decision = undefined;
  FakeAdapter.failure = undefined;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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

class FakeAdapter implements AgentAdapter {
  static calls: Array<{ prompt: string; resume: string | undefined }> = [];
  static options: Array<AgentOptions | undefined> = [];
  static failure: 'rejected' | 'ambiguous' | undefined;
  static decision: ((prompt: string) => unknown) | undefined;
  readonly agent = 'claude-code';

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    FakeAdapter.calls.push({ prompt, resume: options?.resume });
    FakeAdapter.options.push(options);
    if (options?.resume && FakeAdapter.failure) {
      yield createEvent('error', this.agent, {
        code: FakeAdapter.failure === 'rejected' ? 'SESSION_RESUME_REJECTED' : 'PROVIDER_ERROR',
        message: 'fixture provider failure', recoverable: true,
      });
      yield createEvent('done', this.agent, { status: 'error', usage: { toolUses: 0 }, durationMs: 1 });
      return;
    }
    const result = prompt.includes(
      'Select exactly one action from the closed set',
    )
      ? JSON.stringify(
          FakeAdapter.decision?.(prompt) ?? {
            action: 'respond',
            text: 'Shipped Captain answered the Boss.',
          },
        )
      : prompt.includes('compose closing reply')
        ? 'Nested CODE and REVIEW completed.'
        : prompt.includes('compose conversational reply')
          ? 'Captain acknowledged the message.'
          : `result:${prompt}`;
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result,
        resumeToken: `token:${prompt}`,
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      `transport:${FakeAdapter.calls.length}`,
    );
  }

  async isAvailable() {
    return true;
  }
}

const adapterImports = Object.fromEntries(
  ['claude', 'codex', 'gemini', 'kimi', 'opencode'].map((adapter) => [
    adapter,
    async () => FakeAdapter,
  ]),
) as any;

function activeState(stateId = 'ready'): PlaybookState {
  return {
    value: stateId,
    activeStateIds: [stateId],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId,
  };
}

function terminalState(stateId = 'done'): PlaybookState {
  return {
    value: stateId,
    activeStateIds: [stateId],
    tags: [],
    status: 'done',
    quiescent: true,
    stateId,
  };
}

function runtimeSnapshot(
  playbookId: string,
  turn: number,
): PlaybookRuntimeSnapshot {
  const state = activeState('playbook.parked');
  return {
    schemaVersion: 4,
    playbookId,
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
    effectLedger: emptyPlaybookEffectLedger(),
  };
}

function preEffectSessionRecord(
  value: any,
  schemaVersion: 3 | 4,
  retainGenerations: boolean,
) {
  const record = JSON.parse(JSON.stringify(value));
  const downgradeRuntime = (runtime: any) => {
    runtime.schemaVersion = 3;
    delete runtime.effectLedger;
  };
  record.schemaVersion = schemaVersion;
  delete record.replay;
  delete record.contextSeq;
  delete record.effectLedger;
  delete record.unresolvedEffects;
  record.snapshot.schemaVersion = 3;
  delete record.snapshot.effectLedger;
  downgradeRuntime(record.snapshot.captain.runtime);
  for (const frame of record.snapshot.frames ?? []) {
    downgradeRuntime(frame.runtime);
  }
  if (!retainGenerations) {
    delete record.retainedGenerations;
  } else {
    for (const generation of Object.values(
      record.retainedGenerations ?? {},
    ) as any[]) {
      for (const frame of generation.frames ?? []) {
        downgradeRuntime(frame.runtime);
      }
    }
  }
  return record;
}

function preUnresolvedEffectsSessionRecord(value: any) {
  const record = JSON.parse(JSON.stringify(value));
  record.schemaVersion = 5;
  delete record.replay;
  delete record.contextSeq;
  delete record.unresolvedEffects;
  for (const projection of [
    record.structuralProjection,
    record.lastAppliedExecutionProjection,
    record.uncertain?.attemptedExecutionProjection,
  ]) {
    for (const item of Object.values(projection?.catalog ?? {}) as any[]) {
      item.artifactSchema = 2;
    }
  }
  return record;
}

function scriptedCaptainRuntime(
  inputs: string[],
  selectedDecision?: { action: string; playbookId?: string },
  selectAfterInit = false,
) {
  return ({ controller }: any): PlaybookRuntime => {
    let session: PlaybookSession;
    let turns = 0;
    let restored = false;
    return {
      async init(next) {
        session = next;
      },
      async restore(next, snapshot) {
        session = next;
        turns = snapshot.sequences.turn;
        restored = true;
      },
      exportSnapshot() {
        return runtimeSnapshot('captain', turns);
      },
      async handleBossInput({ text, signal }) {
        turns += 1;
        inputs.push(text);
        await session.ports.emitTelemetry({
          topic: 'fixture.captain',
          payload: { turn: turns },
        });
        const parsed =
          selectedDecision !== undefined && (restored || selectAfterInit)
            ? { kind: 'action', decision: selectedDecision }
            : controller.resolveParsedTurn(text);
        if (parsed?.kind === 'action') {
          await controller.submit(parsed.decision, signal);
          // The real compiled Captain marks and performs the reporting call;
          // this deterministic runtime drives that same shell seam.
          await session.ports.emitTelemetry({
            topic: 'playbook.trace',
            payload: {
              type: 'captain.call.started',
              payload: { stateId: 'reporting' },
            },
          });
          await session.ports.callCaptain('compose closing reply', signal, {
            visibility: 'hidden',
            resume: false,
            allowedTools: [],
          });
        } else {
          const decision = await session.ports.callCaptain(
            'compose conversational reply',
            signal,
            { visibility: 'hidden', resume: false, allowedTools: [] },
          );
          await controller.submit(
            { action: 'respond', text: decision.finalText },
            signal,
          );
        }
        return { outcome: 'quiescent', state: activeState('playbook.parked') };
      },
      async resumePlaybookCall() {
        return { outcome: 'no-action', state: activeState() };
      },
      async dispose() {},
    };
  };
}

function nestedEntries(events: string[]) {
  const code = {
    id: 'code',
    command: 'code',
    intent: 'implement with review',
    artifactSchema: 3 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 3 } as const,
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
          events.push(`code:${text}`);
          const first = await session.ports.callPlayer(
            'coder',
            'code-before-review',
            signal,
            { resume: session.playerSessions!.select('coder') },
          );
          session.playerSessions!.update('coder', first.resumeToken);
          const child = await session.ports.callPlaybook(
            {
              callId: 'code:review:1',
              playbookId: 'review',
              text: 'review the implementation',
            },
            signal,
          );
          if (child.state !== 'settled') {
            throw new Error('synthetic REVIEW unexpectedly parked');
          }
          events.push(`child:${child.result.status}`);
          const after = await session.ports.callPlayer(
            'coder',
            'code-after-review',
            signal,
            { resume: session.playerSessions!.select('coder') },
          );
          session.playerSessions!.update('coder', after.resumeToken);
          return {
            outcome: 'terminal',
            state: terminalState(),
            output: { response: 'implemented and reviewed' },
          };
        },
        async resumePlaybookCall(_input: {
          callId: string;
          result: PlaybookCallResult;
          signal: AbortSignal;
        }) {
          throw new Error('immediate nested result should resume in-call');
        },
        async dispose() {},
      };
    },
  };
  const review = {
    id: 'review',
    command: 'review',
    intent: 'review work',
    artifactSchema: 3 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 3 } as const,
    requiredRoleIds: ['coder', 'reviewer'],
    concurrentRoleSets: [] as const,
    validateOptions: (value: unknown) => value,
    createRuntime(): PlaybookRuntime {
      let session: PlaybookSession;
      return {
        async init(next) {
          session = next;
        },
        async handleBossInput({ text, signal }) {
          events.push(`review:${text}`);
          const coder = await session.ports.callPlayer(
            'coder',
            'review-coder',
            signal,
            { resume: session.playerSessions!.select('coder') },
          );
          session.playerSessions!.update('coder', coder.resumeToken);
          const reviewer = await session.ports.callPlayer(
            'reviewer',
            'review-reviewer',
            signal,
            { resume: session.playerSessions!.select('reviewer') },
          );
          session.playerSessions!.update('reviewer', reviewer.resumeToken);
          return {
            outcome: 'terminal',
            state: terminalState(),
            output: { approved: true },
          };
        },
        async resumePlaybookCall() {
          return { outcome: 'no-action', state: activeState() };
        },
        async dispose() {},
      };
    },
  };
  return { code, review };
}

function retainedRootEntry(
  events: string[],
  lifecycle: { inits: number; restores: number; adopts: number },
) {
  return {
    id: 'code',
    command: 'code',
    intent: 'retain a parked root',
    artifactSchema: 3 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 3 } as const,
    requiredRoleIds: ['coder'],
    concurrentRoleSets: [] as const,
    validateOptions: (value: unknown) => value,
    createRuntime(): PlaybookRuntime {
      let state = activeState();
      let turnCount = 0;
      return {
        retainedGenerationMetadata: { unfinishedFinalStateIds: [] },
        async init() {
          lifecycle.inits += 1;
        },
        async restore(_session, snapshot) {
          lifecycle.restores += 1;
          state = snapshot.state;
          turnCount = snapshot.sequences.turn;
        },
        async adopt(_session, snapshot) {
          lifecycle.adopts += 1;
          state = snapshot.state;
          turnCount = snapshot.sequences.turn;
        },
        exportSnapshot() {
          return {
            schemaVersion: 4,
            playbookId: 'code',
            machine: { value: state.value, status: state.status },
            roleResumeTokens: {},
            sequences: {
              trace: 0,
              turn: turnCount,
              judgeCall: 0,
              playerCall: 0,
              playbookCall: 0,
              captainCall: 0,
            },
            state,
            pendingBossQuestions: [],
            effectLedger: emptyPlaybookEffectLedger(),
          } as PlaybookRuntimeSnapshot;
        },
        async handleBossInput({ text }) {
          turnCount += 1;
          events.push(`code:park:${text}`);
          state = activeState('editing');
          return { outcome: 'quiescent', state };
        },
        async resumePlaybookCall() {
          return { outcome: 'no-action', state };
        },
        async dispose() {},
      };
    },
  };
}

function nestedParkedEntries(
  events: string[],
  lifecycle: {
    childCalls: number;
    parentResumes: number;
    codeInits: number;
    codeRestores: number;
    reviewInits: number;
    reviewRestores: number;
  },
) {
  const callId = 'code:review:durable';
  const waiting = {
    ...activeState('waitingForReview'),
    tags: ['playbook.suspended'],
  };
  const code = {
    id: 'code',
    command: 'code',
    intent: 'park on nested review',
    artifactSchema: 3 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 3 } as const,
    requiredRoleIds: ['coder'],
    concurrentRoleSets: [] as const,
    validateOptions: (value: unknown) => value,
    createRuntime(): PlaybookRuntime {
      let session: PlaybookSession;
      let state = activeState();
      let turnCount = 0;
      let suspendedCall: any;
      return {
        retainedGenerationMetadata: { unfinishedFinalStateIds: [] },
        async init(next) {
          lifecycle.codeInits += 1;
          session = next;
        },
        async restore(next, snapshot) {
          lifecycle.codeRestores += 1;
          session = next;
          state = snapshot.state;
          turnCount = snapshot.sequences.turn;
          suspendedCall = snapshot.suspendedCall;
        },
        async adopt(next, snapshot) {
          lifecycle.codeRestores += 1;
          session = next;
          state = snapshot.state;
          turnCount = snapshot.sequences.turn;
          suspendedCall = snapshot.suspendedCall;
        },
        exportSnapshot() {
          return {
            schemaVersion: 4,
            playbookId: 'code',
            machine: { value: state.value, status: state.status },
            roleResumeTokens: {},
            sequences: {
              trace: 0,
              turn: turnCount,
              judgeCall: 0,
              playerCall: 0,
              playbookCall: suspendedCall === undefined ? 0 : 1,
              captainCall: 0,
            },
            state,
            pendingBossQuestions: [],
            effectLedger: emptyPlaybookEffectLedger(),
            ...(suspendedCall === undefined ? {} : { suspendedCall }),
          } as PlaybookRuntimeSnapshot;
        },
        async handleBossInput({ text, signal }) {
          turnCount += 1;
          events.push(`code:start:${text}`);
          lifecycle.childCalls += 1;
          const child = await session.ports.callPlaybook(
            { callId, playbookId: 'review', text: 'review durable work' },
            signal,
          );
          if (child.state !== 'suspended') {
            throw new Error('durable REVIEW must park');
          }
          suspendedCall = {
            callId,
            stateId: 'waitingForReview',
            playbookId: 'review',
            text: 'review durable work',
            childSessionId: child.childSessionId,
            turnId: turnCount,
          };
          state = waiting;
          return {
            outcome: 'suspended',
            state,
            pendingCall: {
              callId,
              playbookId: 'review',
              childSessionId: child.childSessionId,
            },
          };
        },
        async resumePlaybookCall(input: {
          callId: string;
          result: PlaybookCallResult;
        }) {
          lifecycle.parentResumes += 1;
          events.push(`code:resume:${input.callId}:${input.result.status}`);
          suspendedCall = undefined;
          state = terminalState();
          return {
            outcome: 'terminal',
            state,
            output: { response: 'nested durable review completed' },
          };
        },
        async dispose() {},
      };
    },
  };
  const review = {
    id: 'review',
    command: 'review',
    intent: 'park then accept exact Boss reply',
    artifactSchema: 3 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 3 } as const,
    requiredRoleIds: ['coder', 'reviewer'],
    concurrentRoleSets: [] as const,
    validateOptions: (value: unknown) => value,
    createRuntime(): PlaybookRuntime {
      let state = activeState();
      let turnCount = 0;
      let restored = false;
      return {
        retainedGenerationMetadata: { unfinishedFinalStateIds: [] },
        async init() {
          lifecycle.reviewInits += 1;
        },
        async restore(_session, snapshot) {
          lifecycle.reviewRestores += 1;
          restored = true;
          state = snapshot.state;
          turnCount = snapshot.sequences.turn;
        },
        async adopt(_session, snapshot) {
          lifecycle.reviewRestores += 1;
          restored = true;
          state = snapshot.state;
          turnCount = snapshot.sequences.turn;
        },
        exportSnapshot() {
          return {
            schemaVersion: 4,
            playbookId: 'review',
            machine: { value: state.value, status: state.status },
            roleResumeTokens: {},
            sequences: {
              trace: 0,
              turn: turnCount,
              judgeCall: 0,
              playerCall: 0,
              playbookCall: 0,
              captainCall: 0,
            },
            state,
            pendingBossQuestions: [],
            effectLedger: emptyPlaybookEffectLedger(),
          } as PlaybookRuntimeSnapshot;
        },
        async handleBossInput({ text }) {
          turnCount += 1;
          if (!restored) {
            events.push(`review:park:${text}`);
            state = activeState();
            return { outcome: 'quiescent', state };
          }
          events.push(`review:finish:${text}`);
          state = terminalState();
          return {
            outcome: 'terminal',
            state,
            output: { approved: true },
          };
        },
        async resumePlaybookCall() {
          return { outcome: 'no-action', state };
        },
        async dispose() {},
      };
    },
  };
  return { code, review };
}

async function writeConfig(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-headless-'));
  tempDirs.push(dir);
  const path = join(dir, 'playbook.config.yaml');
  await writeFile(path, contents, 'utf8');
  return path;
}

async function initHeadlessTestRepository(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(cwd);
  await initializeHeadlessTestRepository(cwd);
  return cwd;
}

async function initializeHeadlessTestRepository(cwd: string) {
  await execFileAsync('git', ['init', '-q', cwd]);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'Playbook Test']);
  await execFileAsync('git', [
    '-C',
    cwd,
    'config',
    'user.email',
    'playbook-test@example.invalid',
  ]);
  await writeFile(join(cwd, 'tracked.txt'), 'baseline\n', 'utf8');
  await execFileAsync('git', ['-C', cwd, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline']);
}

function sharedConfig() {
  return [
    'captain: { adapter: claude, model: captain-model }',
    'players:',
    '  dev.coder: { adapter: claude, model: coder-model }',
    '  dev.reviewer: { adapter: codex, model: reviewer-model }',
    'playbooks:',
    '  code:',
    '    from: mod://code',
    '    roles: { coder: dev.coder }',
    '  review:',
    '    from: mod://review',
    '    roles:',
    '      coder: { player: dev.coder, model: review-coder-fallback }',
    '      reviewer: dev.reviewer',
    '',
  ].join('\n');
}

function sharedProfilesConfig() {
  return [
    'profiles:',
    '  captain-default: { adapter: claude, model: captain-model }',
    '  coder-default: { adapter: claude, model: coder-model }',
    '  reviewer-default: { adapter: codex, model: reviewer-model }',
    'captain: captain-default',
    'players:',
    '  dev.coder: coder-default',
    '  dev.reviewer: reviewer-default',
    'playbooks:',
    '  code:',
    '    from: mod://code',
    '    roles: { coder: dev.coder }',
    '  review:',
    '    from: mod://review',
    '    roles:',
    '      coder: { player: dev.coder, model: review-coder-fallback }',
    '      reviewer: dev.reviewer',
    '',
  ].join('\n');
}

async function headlessHarness(
  argv: string[],
  extra: Record<string, unknown> = {},
) {
  const entryTransform =
    (extra.entryTransform as
      | ((entry: ReturnType<typeof nestedEntries>['code']) => unknown)
      | undefined) ?? ((entry: unknown) => entry);
  const runOptions = { ...extra };
  delete runOptions.entryTransform;
  const injectSessionsDir = runOptions.injectSessionsDir !== false;
  delete runOptions.injectSessionsDir;
  const events: string[] = [];
  const inputs: string[] = [];
  const entries = nestedEntries(events);
  const configPath = await writeConfig(sharedConfig());
  const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-headless-state-'));
  tempDirs.push(stateRoot);
  const sessionsDir = join(stateRoot, 'sessions');
  const stdout = writer();
  const stderr = writer();
  const modules: Record<string, unknown> = {
    'mod://code': { default: entryTransform(entries.code) },
    'mod://review': { default: entryTransform(entries.review) },
  };
  const result = await runPlaybookCli({
    argv,
    userConfigPath: configPath,
    env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
    loadModule: async (specifier: string) => {
      if (!(specifier in modules)) throw new Error(`no module ${specifier}`);
      return modules[specifier];
    },
    adapterImports,
    createCaptainRuntime: scriptedCaptainRuntime(inputs),
    createLogicalSessionId: () =>
      '90000000-0000-4000-8000-000000000001',
    createCaptainSessionId: uuidSequence(),
    probeAdapterSdk: async () => true,
    ...(injectSessionsDir ? { sessionsDir } : {}),
    stdout,
    stderr,
    spawn: () => {
      throw new Error('headless run must not spawn tmux-play');
    },
    ...runOptions,
  });
  return {
    result,
    stdout: stdout.text(),
    stderr: stderr.text(),
    events,
    inputs,
    sessionsDir: (extra.sessionsDir as string | undefined) ?? sessionsDir,
    configPath,
  };
}

function uuidSequence() {
  let value = 0;
  return () =>
    `10000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

async function readReplayEntries(sessionsDir: string, sessionId: string) {
  const text = await readFile(
    join(sessionsDir, `${sessionId}.records.jsonl`),
    'utf8',
  );
  expect(text.endsWith('\n')).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line));
}

function headlessReplayWarning(sessionId: string) {
  return (
    `playbook run: warning: replay history for session ` +
    `${JSON.stringify(sessionId)} may be incomplete; recording has stopped\n`
  );
}

function warningCount(text: string, warning: string) {
  return text.split(warning).length - 1;
}

async function formerDefaultSession(useXdg = true) {
  const home = await mkdtemp(join(tmpdir(), 'playbook-former-default-'));
  tempDirs.push(home);
  const env = {
    ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o',
    ...(useXdg ? { XDG_STATE_HOME: join(home, 'xdg') } : {}),
  };
  const sourceDir = join(
    useXdg ? join(home, 'xdg') : join(home, '.local', 'state'),
    'playbook', 'sessions',
  );
  const first = await headlessHarness(['run', 'remember the original task'], {
    sessionsDir: sourceDir, homeDir: home, env,
    createCaptainRuntime: undefined,
  });
  expect(first.result.code, first.stderr).toBe(0);
  const id = first.result.sessionId;
  const record = await createCaptainSessionStore({ sessionsDir: sourceDir }).read(id);
  expect(record.schemaVersion).toBe(6);
  const sourcePath = join(sourceDir, `${id}.json`);
  const sourceBytes = `${JSON.stringify(record)}\n`;
  await writeFile(sourcePath, sourceBytes);
  const replayBytes = await readFile(join(sourceDir, `${id}.records.jsonl`));
  return { home, env, sourceDir, sourcePath, sourceBytes, replayBytes, id, configPath: first.configPath };
}

describe('former-default headless migration', () => {
  it.each([false, true])('migrates and continues complete history (XDG override: %s)', async (useXdg) => {
    const f = await formerDefaultSession(useXdg);
    const callOffset = FakeAdapter.calls.length;
    const continued = await headlessHarness(['run', '--session', f.id, 'continue the original task'], {
      injectSessionsDir: false, homeDir: f.home, env: f.env,
      userConfigPath: f.configPath, createCaptainRuntime: undefined,
    });
    expect(continued.result.code, continued.stderr).toBe(0);
    expect(continued.result.sessionId).toBe(f.id);
    expect(continued.stderr).toContain(`migrated 1 sessions from ${f.sourceDir}`);
    const calls = FakeAdapter.calls.slice(callOffset);
    expect(calls).toHaveLength(1);
    expect(calls[0].resume).toBeUndefined();
    expect(calls[0].prompt).toContain('remember the original task');
    const destination = join(f.home, '.spex', 'sessions');
    const record = JSON.parse(await readFile(join(destination, `${f.id}.json`), 'utf8'));
    expect(record).toMatchObject({ schemaVersion: 7, state: 'settled' });
    expect(record.snapshot.sequences.turn).toBe(2);
    const replay = await readFile(join(destination, `${f.id}.records.jsonl`));
    expect(replay.subarray(0, f.replayBytes.length)).toEqual(f.replayBytes);
    await expect(stat(f.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(f.sourceDir, `${f.id}.records.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['SPEX_HOME', 'directory', 'store', 'config', 'overlay'] as const)(
    'leaves the former default untouched with an explicit %s', async (kind) => {
      const f = await formerDefaultSession();
      const destination = join(f.home, 'explicit', 'sessions');
      const extra: Record<string, unknown> = {
        injectSessionsDir: false, homeDir: f.home, env: f.env,
        userConfigPath: f.configPath,
      };
      const argv = ['run', '--session', f.id, 'must not start'];
      if (kind === 'SPEX_HOME') extra.env = { ...f.env, SPEX_HOME: join(f.home, 'explicit') };
      if (kind === 'directory') extra.sessionsDir = destination;
      if (kind === 'store') extra.sessionStore = createCaptainSessionStore({ sessionsDir: destination });
      if (kind === 'config') {
        extra.userConfigPath = await writeConfig(`sessions: ${JSON.stringify(destination)}\n${sharedConfig()}`);
      }
      if (kind === 'overlay') {
        const overlay = await writeConfig(`sessions: ${JSON.stringify(destination)}\n`);
        argv.splice(1, 0, '--with', overlay);
      }
      const beforeCalls = FakeAdapter.calls.length;
      const result = await headlessHarness(argv, extra);
      expect(result.result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain('does not exist');
      expect(result.stderr).not.toContain('migrated');
      expect(FakeAdapter.calls).toHaveLength(beforeCalls);
      expect(await readFile(f.sourcePath, 'utf8')).toBe(f.sourceBytes);
      expect(await readFile(join(f.sourceDir, `${f.id}.records.jsonl`))).toEqual(f.replayBytes);
      await expect(stat(join(destination, `${f.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

describe('headless sessions locator (PBCLI-78/81)', () => {
  it('selects and persists through a configured relative directory without projecting the locator', async () => {
    const configPath = await writeConfig(
      ['sessions: replay-sessions', sharedConfig()].join('\n'),
    );
    const configuredSessionsDir = join(
      dirname(configPath),
      'replay-sessions',
    );
    const first = await headlessHarness(['run', 'first turn'], {
      injectSessionsDir: false,
      userConfigPath: configPath,
    });

    expect(first.result.code, first.stderr).toBe(0);
    const recordPath = join(
      configuredSessionsDir,
      `${first.result.sessionId}.json`,
    );
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.structuralProjection).not.toHaveProperty('sessions');
    expect(record.lastAppliedExecutionProjection).not.toHaveProperty(
      'sessions',
    );

    const hostFactory = vi.fn((options: any) =>
      createTmuxPlayRuntime(options),
    );
    const continued = await headlessHarness(
      ['run', '--continue', 'second turn'],
      {
        injectSessionsDir: false,
        userConfigPath: configPath,
        createHostRuntime: hostFactory,
      },
    );

    expect(continued.result.code, continued.stderr).toBe(0);
    expect(continued.result.sessionId).toBe(first.result.sessionId);
    expect(continued.inputs).toEqual(['second turn']);
    expect(hostFactory).toHaveBeenCalledOnce();
  });

  it('gives an injected store precedence over an invalid configured locator', async () => {
    const configPath = await writeConfig(
      ['sessions: "~another-user/replay"', sharedConfig()].join('\n'),
    );
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'playbook-injected-session-store-'),
    );
    tempDirs.push(stateRoot);
    const injectedSessionsDir = join(stateRoot, 'sessions');
    const sessionStore = createCaptainSessionStore({
      sessionsDir: injectedSessionsDir,
    });
    const out = await headlessHarness(['run', 'injected store'], {
      injectSessionsDir: false,
      userConfigPath: configPath,
      sessionStore,
    });

    expect(out.result.code, out.stderr).toBe(0);
    await expect(
      stat(join(injectedSessionsDir, `${out.result.sessionId}.json`)),
    ).resolves.toBeDefined();
  });

  it('rejects an unusable configured directory before agent or host work', async () => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'playbook-unusable-sessions-'),
    );
    tempDirs.push(stateRoot);
    const unusablePath = join(stateRoot, 'not-a-directory');
    await writeFile(unusablePath, 'occupied\n', 'utf8');
    const configPath = await writeConfig(
      [`sessions: ${JSON.stringify(unusablePath)}`, sharedConfig()].join(
        '\n',
      ),
    );
    const calls = { prepare: 0, load: 0, host: 0 };
    const out = await headlessHarness(['run', 'must not run'], {
      injectSessionsDir: false,
      userConfigPath: configPath,
      prepareRegistryModule: async ({ from }: any) => {
        calls.prepare += 1;
        return from;
      },
      loadModule: async () => {
        calls.load += 1;
        return {};
      },
      createHostRuntime: async () => {
        calls.host += 1;
        throw new Error('must not construct host');
      },
    });

    expect(out.result.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(calls).toEqual({ prepare: 0, load: 0, host: 0 });
    expect(out.stderr).toContain(
      'session permission preparation refuses unsafe ownership, links, type, or owner access',
    );
  });

  it('rejects a missing directory below an unwritable parent before host work', async () => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'playbook-unwritable-sessions-'),
    );
    tempDirs.push(stateRoot);
    const lockedParent = join(stateRoot, 'locked');
    await mkdir(lockedParent, { mode: 0o700 });
    const configPath = await writeConfig(
      [
        `sessions: ${JSON.stringify(join(lockedParent, 'sessions'))}`,
        sharedConfig(),
      ].join('\n'),
    );
    const calls = { prepare: 0, load: 0, host: 0 };
    await chmod(lockedParent, 0o500);
    let out;
    try {
      out = await headlessHarness(['run', 'must not run'], {
        injectSessionsDir: false,
        userConfigPath: configPath,
        prepareRegistryModule: async ({ from }: any) => {
          calls.prepare += 1;
          return from;
        },
        loadModule: async () => {
          calls.load += 1;
          return {};
        },
        createHostRuntime: async () => {
          calls.host += 1;
          throw new Error('must not construct host');
        },
      });
    } finally {
      await chmod(lockedParent, 0o700);
    }

    expect(out.result.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(calls).toEqual({ prepare: 0, load: 0, host: 0 });
    expect(out.stderr).toMatch(/permission denied|EACCES/);
  });
});

describe('headless replay tee (PBCLI-74/77/79/80/84)', () => {
  const replaySessionId = '90000000-0000-4000-8000-000000000071';

  it('tees every hidden and visible record with roles across two turns', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-headless-replay-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const observed: any[] = [];
    let traceSequence = 0;
    let callSequence = 0;
    const activeCalls = new Map<string, { callId: string; roleId: string }>();
    const createHostRuntime = async (options: any) => {
      const forward = async (record: any) => {
        for (const observer of options.observers) {
          await observer.onRecord(record);
        }
        observed.push(record);
      };
      const traceRecord = (
        record: any,
        type: 'player.call.started' | 'player.call.finished',
        frame: { callId: string; roleId: string },
      ) => ({
        type: 'captain_telemetry',
        turnId: record.turnId,
        timestamp: record.timestamp,
        topic: 'playbook.trace',
        payload: {
          schemaVersion: 4,
          sessionId: 'headless-replay-role-session',
          playbookId: 'headless-replay-role-playbook',
          rootSessionId: 'headless-replay-role-session',
          depth: 0,
          sequence: ++traceSequence,
          timestamp: record.timestamp,
          type,
          turnId: record.turnId,
          callId: frame.callId,
          payload: {
            playerId: record.playerId,
            roleId: frame.roleId,
            resume: false,
            ...(type === 'player.call.started'
              ? { prompt: record.prompt }
              : {
                  status: 'ok',
                  ...(typeof record.result?.finalText === 'string'
                    ? { finalText: record.result.finalText }
                    : {}),
                }),
          },
        },
      });
      return createTmuxPlayRuntime({
        ...options,
        observers: [
          {
            async onRecord(record: any) {
              if (record.type === 'player_prompt') {
                const frame = {
                  callId: `headless-player-${++callSequence}`,
                  roleId:
                    record.playerId === 'dev.reviewer' ? 'reviewer' : 'coder',
                };
                activeCalls.set(record.playerId, frame);
                await forward(traceRecord(record, 'player.call.started', frame));
              }
              await forward(record);
              if (record.type === 'player_finished') {
                const frame = activeCalls.get(record.playerId);
                if (frame !== undefined) {
                  await forward(
                    traceRecord(record, 'player.call.finished', frame),
                  );
                  activeCalls.delete(record.playerId);
                }
              }
            },
          },
        ],
      });
    };

    const first = await headlessHarness(['run', '/code record everything'], {
      sessionsDir,
      createLogicalSessionId: () => replaySessionId,
      createHostRuntime,
    });
    expect(first.result.code).toBe(0);
    expect(first.stdout).toBe('Nested CODE and REVIEW completed.\n');
    expect(first.stderr).not.toContain('replay history');

    const firstObservedCount = observed.length;
    const firstEntries = await readReplayEntries(sessionsDir, replaySessionId);
    expect(firstEntries.filter(({ record }: any) => !['session_context', 'continuity_reset'].includes(record.type))).toHaveLength(firstObservedCount);
    expect(firstEntries[0]?.record.type).toBe('session_context');
    expect(firstEntries.map(({ seq }: any) => seq)).toEqual(
      Array.from({ length: firstEntries.length }, (_, index) => index + 1),
    );

    const second = await headlessHarness(
      ['run', '--session', replaySessionId, 'one more turn'],
      {
        sessionsDir,
        userConfigPath: first.configPath,
        createHostRuntime,
      },
    );
    expect(second.result.code).toBe(0);
    expect(second.stdout).toBe('Captain acknowledged the message.\n');
    expect(second.stderr).not.toContain('replay history');

    const entries = await readReplayEntries(sessionsDir, replaySessionId);
    expect(entries.length).toBeGreaterThan(firstEntries.length);
    expect(entries.slice(0, firstEntries.length)).toEqual(firstEntries);
    expect(entries.map(({ seq }: any) => seq)).toEqual(
      Array.from({ length: entries.length }, (_, index) => index + 1),
    );
    expect(entries.filter(({ record }: any) => !['session_context', 'continuity_reset'].includes(record.type)).map(({ record: { contextSeq: _contextSeq, ...record } }: any) => record)).toEqual(
      observed.map((record, index) => sanitizeReplayRecord(index < firstObservedCount || typeof record.turnId !== 'number' ? record : {
        ...record, turnId: record.turnId + 1,
        ...(record.type === 'turn_started' ? { turn: { ...record.turn, id: record.turn.id + 1 } } : {}),
      })),
    );

    const types = new Set(entries.map(({ record }: any) => record.type));
    for (const type of [
      'turn_started',
      'player_prompt',
      'player_event',
      'player_finished',
      'captain_prompt',
      'captain_event',
      'captain_finished',
      'captain_reply',
      'captain_telemetry',
      'turn_finished',
    ]) {
      expect(types.has(type), type).toBe(true);
    }
    expect(
      entries.some(
        ({ record }: any) =>
          record.type === 'captain_prompt' && record.visibility === 'hidden',
      ),
    ).toBe(true);

    const playerEntries = entries.filter(({ record }: any) =>
      ['player_prompt', 'player_event', 'player_finished'].includes(record.type),
    );
    expect(playerEntries.length).toBeGreaterThan(0);
    expect(new Set(playerEntries.map(({ role }: any) => role))).toEqual(
      new Set(['coder', 'reviewer']),
    );
    for (const entry of entries) {
      if (
        !['player_prompt', 'player_event', 'player_finished'].includes(
          entry.record.type,
        )
      ) {
        expect(entry).not.toHaveProperty('role');
      }
    }
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('resumeToken');
    expect(serialized).toContain('"resume":false');
  });

  it('refuses a new session when its required context cannot be recorded', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-headless-invalid-replay-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    await mkdir(sessionsDir, { mode: 0o700 });
    const streamPath = join(sessionsDir, `${replaySessionId}.records.jsonl`);
    const invalid = '{"v":1,"seq":1,"record":[]}\n';
    await writeFile(streamPath, invalid, { mode: 0o600 });
    let turns = 0;
    const out = await headlessHarness(['run', 'cannot record context'], {
      sessionsDir,
      createLogicalSessionId: () => replaySessionId,
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return { runBossTurn: async (...args: Parameters<typeof host.runBossTurn>) => { turns += 1; return host.runBossTurn(...args); }, dispose: () => host.dispose() };
      },
    });
    expect(out.result.code, out.stderr).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('cannot persist session execution context');
    expect(turns).toBe(0);
    expect(await readFile(streamPath, 'utf8')).toBe(invalid);
  });

  it('keeps a sanitizer failure outside dispatch and swallows warning failure', async () => {
    const run = async (failWarning: boolean) => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'playbook-headless-replay-warning-'),
      );
      tempDirs.push(stateRoot);
      const sessionsDir = join(stateRoot, 'sessions');
      const baseStore = createCaptainSessionStore({ sessionsDir });
      const sessionStore = {
        ...baseStore,
        async acquire(sessionId: string) {
          const lease = await baseStore.acquire(sessionId);
          let first = true;
          return {
            ...lease,
            async append(record: any, role?: string) {
              if (!first) return lease.append(record, role);
              first = false;
              return lease.append(new Date('2026-08-31T00:00:00.000Z'));
            },
          };
        },
      };
      const warning = headlessReplayWarning(replaySessionId);
      const stderrChunks: string[] = [];
      let warningAttempts = 0;
      let hostTurnActive = false;
      let warningDuringHostTurn = false;
      const out = await headlessHarness(['run', 'survive replay failure'], {
        sessionsDir,
        sessionStore,
        createLogicalSessionId: () => replaySessionId,
        stderr: {
          write(chunk: string) {
            const text = String(chunk);
            if (text === warning) {
              warningAttempts += 1;
              warningDuringHostTurn ||= hostTurnActive;
              if (failWarning) throw new Error('synthetic warning sink failure');
            }
            stderrChunks.push(text);
            return true;
          },
        },
        createHostRuntime: async (options: any) => {
          const host = await createTmuxPlayRuntime(options);
          return {
            async runBossTurn(input: string) {
              hostTurnActive = true;
              try {
                return await host.runBossTurn(input);
              } finally {
                hostTurnActive = false;
              }
            },
            dispose: () => host.dispose(),
          };
        },
      });
      return {
        out,
        warning,
        warningAttempts,
        warningDuringHostTurn,
        stderr: stderrChunks.join(''),
      };
    };

    const writable = await run(false);
    expect(writable.out.result.code).toBe(0);
    expect(writable.out.stdout).toBe('Captain acknowledged the message.\n');
    expect(writable.warningAttempts).toBe(1);
    expect(writable.warningDuringHostTurn).toBe(false);
    expect(writable.stderr).toBe(writable.warning);

    const failed = await run(true);
    expect(failed.out.result.code).toBe(0);
    expect(failed.out.stdout).toBe('Captain acknowledged the message.\n');
    expect(failed.warningAttempts).toBe(1);
    expect(failed.warningDuringHostTurn).toBe(false);
    expect(failed.stderr).toBe('');
  });

  it.each([
    'initialization',
    'sanitization',
    'append',
    'first-publication directory sync',
    'torn-tail repair',
    'settlement checkpoint',
    'release checkpoint',
  ] as const)(
    'adds only the native warning for a %s failure',
    async (boundary) => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'playbook-headless-replay-boundary-'),
      );
      tempDirs.push(stateRoot);
      const sessionsDir = join(stateRoot, 'sessions');
      const baseStore = createCaptainSessionStore({ sessionsDir });
      const sessionStore = {
        ...baseStore,
        async acquire(sessionId: string) {
          const owned = await baseStore.acquire(sessionId);
          let sourceFailurePending = [
            'sanitization',
            'append',
            'first-publication directory sync',
          ].includes(boundary);
          let liveStatus = owned.streamStatus();
          if (
            boundary === 'initialization' ||
            boundary === 'torn-tail repair'
          ) {
            liveStatus = { ...liveStatus, incomplete: true };
          }
          const latch = () => {
            liveStatus = { ...liveStatus, incomplete: true };
          };
          const adopt = (status: typeof liveStatus) => {
            if (!liveStatus.incomplete) liveStatus = status;
            return liveStatus;
          };
          return {
            ...owned,
            async append(record: any, role?: string) {
              if (liveStatus.incomplete) return;
              if (sourceFailurePending) {
                sourceFailurePending = false;
                if (boundary === 'sanitization') {
                  try {
                    await owned.append(
                      new Date('2026-08-31T00:00:00.000Z'),
                    );
                  } catch (error) {
                    liveStatus = owned.streamStatus();
                    throw error;
                  }
                }
                if (boundary === 'first-publication directory sync') {
                  await owned.append(record, role);
                  liveStatus = owned.streamStatus();
                }
                latch();
                throw new Error(`synthetic replay ${boundary} failure`);
              }
              await owned.append(record, role);
              adopt(owned.streamStatus());
            },
            streamStatus: () => liveStatus,
            async settle(value: any) {
              const record = await owned.settle(value);
              adopt(owned.streamStatus());
              if (boundary === 'settlement checkpoint') latch();
              return record;
            },
            async release() {
              adopt(await owned.release());
              if (boundary === 'release checkpoint') latch();
              return liveStatus;
            },
          };
        },
      };
      const out = await headlessHarness(
        ['run', `${boundary} still succeeds`],
        {
          sessionsDir,
          sessionStore,
          createLogicalSessionId: () => replaySessionId,
        },
      );
      const warning = headlessReplayWarning(replaySessionId);
      expect(out.result.code).toBe(0);
      expect(out.stdout).toBe('Captain acknowledged the message.\n');
      expect(warningCount(out.stderr, warning)).toBe(1);
      expect(out.stderr.replace(warning, '')).toBe('');
    },
  );
});

describe('playbook run shared Captain host (PBCLI-48)', () => {
  it('runs configured CODE through nested REVIEW on the real headless host', async () => {
    const out = await headlessHarness(['run', '/code implement it']);

    expect(out.result.code).toBe(0);
    expect(out.stdout).toBe('Nested CODE and REVIEW completed.\n');
    expect(out.inputs).toEqual(['/code implement it']);
    expect(out.events).toEqual([
      'code:implement it',
      'review:review the implementation',
      'child:ok',
    ]);
    expect(out.stderr).toContain('\u25c7 /code started');
    expect(out.stderr).toContain('\u25c7 /review called by /code');
    expect(out.stderr).not.toContain('\u00b7 playbook.trace');
    expect(FakeAdapter.calls.slice(0, 4)).toEqual([
      { prompt: 'code-before-review', resume: undefined },
      { prompt: 'review-coder', resume: 'token:code-before-review' },
      { prompt: 'review-reviewer', resume: undefined },
      { prompt: 'code-after-review', resume: 'token:review-coder' },
    ]);
    expect(FakeAdapter.calls[4]?.prompt).toContain('compose closing reply');
    expect(FakeAdapter.calls[4]?.resume).toBeUndefined();
    expect(FakeAdapter.options.slice(0, 5).map((options) => options?.model))
      .toEqual([
        'coder-model',
        'review-coder-fallback',
        'reviewer-model',
        'coder-model',
        'captain-model',
      ]);
    expect(out.result.snapshot).toMatchObject({
      mode: 'chat',
      sequences: { turn: 1 },
    });
    expect(out.result.sessionId).not.toBe(
      out.result.snapshot.captain.sessionId,
    );
    expect(out.result.config).toMatchObject({
      schemaVersion: 2,
      captain: { model: { kind: 'value', value: 'captain-model' } },
      players: [
        {
          id: 'dev.coder',
          model: { kind: 'value', value: 'coder-model' },
        },
        {
          id: 'dev.reviewer',
          model: { kind: 'value', value: 'reviewer-model' },
        },
      ],
      catalog: {
        code: {
          id: 'code',
          command: 'code',
          roles: { coder: { playerId: 'dev.coder' } },
        },
        review: {
          id: 'review',
          command: 'review',
          roles: {
            coder: { playerId: 'dev.coder' },
            reviewer: { playerId: 'dev.reviewer' },
          },
        },
      },
    });
    expect(out.result.config).not.toHaveProperty('presentation');
  });

  it('injects current-lease capabilities into schema-3 root and nested runtimes', async () => {
    const constructed: Array<{
      playbookId: string;
      options: unknown;
      capability: any;
    }> = [];
    let writerLease: any;
    const out = await headlessHarness(['run', '/code implement it'], {
      entryTransform: (entry: any) => ({
        ...entry,
        artifactSchema: 3,
        runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
        createRuntime(options: unknown, capability: unknown) {
          constructed.push({ playbookId: entry.id, options, capability });
          return entry.createRuntime(options);
        },
      }),
      createEffectLedgerWriteAhead: (lease: unknown) => {
        writerLease = lease;
        const effectLedger = emptyPlaybookEffectLedger();
        return {
          snapshot: () => effectLedger,
          writeAhead: async () => effectLedger,
        };
      },
    });

    expect(out.result.code, out.stderr).toBe(0);
    expect(constructed.map(({ playbookId }) => playbookId)).toEqual([
      'code',
      'review',
    ]);
    for (const construction of constructed) {
      expect(construction.options).toEqual({});
      expect(construction.capability.authority).toMatchObject({
        playbookId: construction.playbookId,
        artifactSchema: 3,
        cwd: process.cwd(),
        sessionId: out.result.sessionId,
        leaseOwnerToken: writerLease.ownerToken,
      });
      expect(construction.capability.repository.identity).toBe(
        construction.capability.authority.canonicalWorktree,
      );
      expect(construction.capability.effectLedger.writeAhead).toEqual(
        expect.any(Function),
      );
    }
    expect(JSON.stringify(out.result.config)).not.toContain(
      writerLease.ownerToken,
    );
    expect(JSON.stringify(out.result.snapshot)).not.toContain(
      writerLease.ownerToken,
    );
    expect(out.result.config).not.toHaveProperty('hostCapabilities');
  });

  it('runs configured REVIEW as a root through the same Captain', async () => {
    const out = await headlessHarness(['run', '/review check it']);

    expect(out.result.code).toBe(0);
    expect(out.stdout).toBe('Nested CODE and REVIEW completed.\n');
    expect(out.events).toEqual(['review:check it']);
    expect(FakeAdapter.calls.slice(0, 2)).toEqual([
      { prompt: 'review-coder', resume: undefined },
      { prompt: 'review-reviewer', resume: undefined },
    ]);
    expect(FakeAdapter.calls[2]?.prompt).toContain('compose closing reply');
    expect(out.stderr).toContain('◇ /review started');
  });

  it('uses the shipped compiled Captain for ordinary Boss text', async () => {
    const out = await headlessHarness(['run', 'XYZ'], {
      createCaptainRuntime: undefined,
    });

    expect(out.result.code).toBe(0);
    expect(out.stdout).toBe('Shipped Captain answered the Boss.\n');
    expect(out.inputs).toEqual([]);
    expect(FakeAdapter.calls).toHaveLength(1);
    expect(FakeAdapter.calls[0]?.prompt).toContain(
      'Select exactly one action from the closed set',
    );
  });

  it('drains and preserves stdin, overlays config, and exposes only JSON reply keys', async () => {
    const input = '  spex indicator\nself-contained prompt\n';
    const order: string[] = [];
    const overlay = await writeConfig(
      'captain: { adapter: claude, model: overlaid-captain }\n',
    );
    let hostOptions: any;
    const out = await headlessHarness(
      ['run', '--json', '--verbose', '--with', overlay],
      {
        readStdin: async () => {
          order.push('stdin');
          return input;
        },
        createHostRuntime: async (options: any) => {
          order.push('host');
          hostOptions = options;
          return createTmuxPlayRuntime(options);
        },
      },
    );

    // The harness's loader is intentionally retained by object spread when
    // `undefined` is omitted in production; verify pipe drain precedes host.
    expect(order).toEqual(['stdin', 'host']);
    expect(out.inputs).toEqual([input]);
    expect(JSON.parse(out.stdout)).toEqual({
      sessionId: '90000000-0000-4000-8000-000000000001',
      reply: 'Captain acknowledged the message.',
    });
    expect(Object.keys(JSON.parse(out.stdout))).toEqual(['sessionId', 'reply']);
    expect(hostOptions.captainConfig.model).toBe('overlaid-captain');
    expect(out.stderr).toContain('\u00b7 fixture.captain');
    expect(out.stderr).not.toContain('result:');
  });

  it('treats terminator content as one literal input and rejects retired surfaces', async () => {
    const literal = await headlessHarness(['run', '--', '--json']);
    expect(literal.result.code).toBe(0);
    expect(literal.inputs).toEqual(['--json']);
    expect(literal.stdout).toBe('Captain acknowledged the message.\n');

    for (const argv of [
      ['run', '--player', 'coder=claude', 'x'],
      ['run', '--captain=codex', 'x'],
      ['run', '--config', 'raw.yaml', 'x'],
      ['run', 'resume', 'old-session'],
      ['run', 'mod://code', 'old task'],
    ]) {
      const rejected = await headlessHarness(argv);
      expect(rejected.result.code).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.inputs).toEqual([]);
    }
    expect(parseRunArgs(['mod://code']).input).toBe('mod://code');
    expect(parseRunArgs(['resume']).input).toBe('resume');
    expect(parseRunArgs(['--', '--with'])).toMatchObject({
      input: '--with',
      withPaths: [],
    });
    expect(() => parseRunArgs(['one', 'two'])).toThrow(
      /at most one \[input\]/,
    );
  });

  it('keeps help side-effect free and rejects whitespace without stdin fallback', async () => {
    let reads = 0;
    let loads = 0;
    let probes = 0;
    const home = await mkdtemp(join(tmpdir(), 'playbook-headless-help-'));
    tempDirs.push(home);
    const legacy = join(home, '.config', 'playbook', 'playbook.config.yaml');
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, sharedConfig(), 'utf8');
    const stdout = writer();
    const stderr = writer();
    const help = await runPlaybookCli({
      argv: ['run', '--help'],
      homeDir: home,
      readStdin: async () => {
        reads += 1;
        return 'must not read';
      },
      loadModule: async () => {
        loads += 1;
        return {};
      },
      probeAdapterSdk: async () => {
        probes += 1;
        return true;
      },
      stdout,
      stderr,
    });
    expect(help.code).toBe(0);
    expect(stdout.text()).toContain('playbook run [--with <path>]');
    expect(stdout.text()).toContain('Stable agents live under top-level players');
    expect(stdout.text()).toContain('playbooks.<id>.roles');
    expect(stdout.text()).toContain('Equal player ids share one');
    expect(stdout.text()).toContain('distinct ids remain isolated');
    expect(stdout.text()).toContain('playbooks.<id>.players is rejected');
    expect(stdout.text()).toContain('not auto-migrated');
    expect(stdout.text()).toContain(
      'prefer this working directory, else global newest',
    );
    expect({ reads, loads, probes }).toEqual({ reads: 0, loads: 0, probes: 0 });
    expect(await readFile(legacy, 'utf8')).toBe(sharedConfig());
    await expect(
      readFile(join(home, '.spex', 'playbook', 'playbook.config.yaml')),
    ).rejects.toThrow();

    let fallbackReads = 0;
    const emptyStdout = writer();
    const empty = await runPlaybookCli({
      argv: ['run', '   '],
      env: { HOME: home },
      homeDir: home,
      readStdin: async () => {
        fallbackReads += 1;
        return 'fallback';
      },
      stdout: emptyStdout,
      stderr: writer(),
    });
    expect(empty.code).toBe(1);
    expect(fallbackReads).toBe(0);
    expect(emptyStdout.text()).toBe('');
    expect(await readFile(legacy, 'utf8')).toBe(sharedConfig());
    await expect(
      readFile(join(home, '.spex', 'playbook', 'playbook.config.yaml')),
    ).rejects.toThrow();
  });

  it('relocates through default run delegation before config preparation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'playbook-headless-relocate-'));
    tempDirs.push(home);
    const legacy = join(home, '.config', 'playbook', 'playbook.config.yaml');
    const canonical = join(home, '.spex', 'playbook', 'playbook.config.yaml');
    const source =
      `# delegated run relocation\nsessions: ../../session-state\n` +
      sharedConfig();
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, source, 'utf8');
    await chmod(legacy, 0o600);

    const out = await headlessHarness(['run', 'hello'], {
      userConfigPath: undefined,
      homeDir: home,
      env: {
        HOME: home,
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: 'o',
      },
    });

    expect(out.result.code).toBe(0);
    expect(await readFile(canonical, 'utf8')).toBe(source);
    expect((await stat(canonical)).mode & 0o777).toBe(0o600);
    await expect(readFile(legacy, 'utf8')).rejects.toThrow();
    expect(out.stderr).toContain(
      `playbook: moved config from ${legacy} to ${canonical}\n`,
    );
    expect(out.stderr).not.toContain('created config');
  });

  it('uses canonical and keeps legacy readable after interrupted publication', async () => {
    const home = await mkdtemp(
      join(tmpdir(), 'playbook-headless-relocate-interrupted-'),
    );
    tempDirs.push(home);
    const legacy = join(home, '.config', 'playbook', 'playbook.config.yaml');
    const canonical = join(home, '.spex', 'playbook', 'playbook.config.yaml');
    const legacyBytes = 'unknown-legacy-key: must-not-load\n';
    const canonicalBytes = `# already published\n${sharedConfig()}`;
    await mkdir(dirname(legacy), { recursive: true });
    await mkdir(dirname(canonical), { recursive: true });
    await writeFile(legacy, legacyBytes, 'utf8');
    await chmod(legacy, 0o600);
    await writeFile(canonical, canonicalBytes, 'utf8');
    await chmod(canonical, 0o644);

    const out = await headlessHarness(['run', 'hello'], {
      userConfigPath: undefined,
      homeDir: home,
      env: {
        HOME: home,
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: 'o',
      },
    });

    expect(out.result.code).toBe(0);
    expect(await readFile(canonical, 'utf8')).toBe(canonicalBytes);
    expect((await stat(canonical)).mode & 0o777).toBe(0o644);
    expect(await readFile(legacy, 'utf8')).toBe(legacyBytes);
    expect((await stat(legacy)).mode & 0o777).toBe(0o600);
    expect(out.stderr).not.toMatch(/moved config|created config/);
  });

  it('relocates before migrating profiles through the headless front end', async () => {
    const home = await mkdtemp(
      join(tmpdir(), 'playbook-headless-relocate-profiles-'),
    );
    tempDirs.push(home);
    const legacy = join(home, '.config', 'playbook', 'playbook.config.yaml');
    const canonical = join(home, '.spex', 'playbook', 'playbook.config.yaml');
    const source = `# move before content migration\n${sharedProfilesConfig()}`;
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, source, 'utf8');

    const out = await headlessHarness(['run', 'hello'], {
      userConfigPath: undefined,
      homeDir: home,
      env: {
        HOME: home,
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: 'o',
      },
    });

    expect(out.result.code).toBe(0);
    await expect(readFile(legacy, 'utf8')).rejects.toThrow();
    expect(await readFile(`${canonical}.bak`, 'utf8')).toBe(source);
    expect(await readFile(canonical, 'utf8')).not.toContain('profiles:');
    const moveNotice =
      `playbook: moved config from ${legacy} to ${canonical}\n`;
    expect(out.stderr).toContain(moveNotice);
    expect(out.stderr.indexOf(moveNotice)).toBeLessThan(
      out.stderr.indexOf(`playbook: migrated ${canonical}`),
    );
    expect(out.stderr).not.toContain('created config');
  });

  it('awaits stdout backpressure before reporting success', async () => {
    const stdout = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
    };
    let output = '';
    let announceWrite!: () => void;
    const wrote = new Promise<void>((resolve) => {
      announceWrite = resolve;
    });
    stdout.write = (chunk: string) => {
      output += chunk;
      announceWrite();
      return false;
    };

    let settled = false;
    const pending = headlessHarness(['run', 'hello'], { stdout }).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await wrote;
    await Promise.resolve();
    expect(settled).toBe(false);
    stdout.emit('drain');

    const out = await pending;
    expect(settled).toBe(true);
    expect(out.result.code).toBe(0);
    expect(output).toBe('Captain acknowledged the message.\n');
  });

  it('classifies host setup separately from turn and reply-boundary failures', async () => {
    let invalidAttemptHosts = 0;
    const invalidAttempt = await headlessHarness(['run', 'hello'], {
      createAttemptId: () => 'not-a-uuid',
      createHostRuntime: async () => {
        invalidAttemptHosts += 1;
        throw new Error('must not construct host');
      },
    });
    expect(invalidAttempt.result.code).toBe(1);
    expect(invalidAttempt.stdout).toBe('');
    expect(invalidAttempt.stderr).toContain('attempt id generator');
    expect(invalidAttemptHosts).toBe(0);

    const setup = await headlessHarness(['run', 'hello'], {
      createHostRuntime: async () => {
        throw new Error('synthetic host init failed');
      },
    });
    expect(setup.result.code).toBe(1);
    expect(setup.stdout).toBe('');
    expect(setup.stderr).toContain('synthetic host init failed');

    // PBCLI-35: the compiled session Captain's own compat rejection is a
    // host-construction failure like any other — the real DR-022 gate
    // throws during factory construction against the real Captain machine,
    // and the front end owes the Boss the setup diagnostic, not an
    // uncaught load error. The lazy module (pinned in the artifact-schema
    // suite) is what keeps this construction inside the caught boundary.
    const captainSkew = await headlessHarness(['run', 'hello'], {
      createCaptainRuntime: () =>
        createXStatePlaybookRuntime(captainMachine, {
          label: 'CAPTAIN',
          compat: { artifactSchema: 3, runtimeAbi: 999 },
          snapshotOptions: () => ({}),
          machineInput: () => ({ enabledPlaybooks: [] }),
          roleStates: {},
          outcomeAuthority: { governedPlayerStates: {} },
        })({} as never),
    });
    expect(captainSkew.result.code).toBe(1);
    expect(captainSkew.stdout).toBe('');
    expect(captainSkew.stderr).toContain('playbook run:');
    expect(captainSkew.stderr).toContain('999');

    const turn = await headlessHarness(['run', 'hello'], {
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          runBossTurn: async () => {
            throw new Error('synthetic turn failed');
          },
          dispose: () => host.dispose(),
        };
      },
    });
    expect(turn.result.code).toBe(2);
    expect(turn.stdout).toBe('');
    expect(turn.stderr).toContain('synthetic turn failed');

    for (const { count, text, expected } of [
      { count: 0, text: undefined, expected: 0 },
      { count: 1, text: '   ', expected: 1 },
      { count: 2, text: undefined, expected: 2 },
    ]) {
      const replyBoundary = await headlessHarness(['run', 'hello'], {
        createHostRuntime: async (options: any) =>
          createTmuxPlayRuntime({
            ...options,
            observers: options.observers.map((observer: any) => ({
              async onRecord(record: any) {
                if (record.type !== 'captain_reply') {
                  await observer.onRecord(record);
                  return;
                }
                for (let index = 0; index < count; index += 1) {
                  await observer.onRecord(
                    text === undefined ? record : { ...record, text },
                  );
                }
              },
            })),
          }),
      });
      expect(replyBoundary.result.code).toBe(2);
      expect(replyBoundary.stdout).toBe('');
      expect(replyBoundary.stderr).toContain(
        `Captain turn produced ${expected} usable Boss-visible replies`,
      );
    }
  });

  it('retains the writer lease when headless host cleanup is incomplete', async () => {
    for (const phase of ['setup', 'turn', 'settle'] as const) {
      const stateRoot = await mkdtemp(
        join(tmpdir(), `playbook-cleanup-quarantine-${phase}-`),
      );
      tempDirs.push(stateRoot);
      const sessionsDir = join(stateRoot, 'sessions');
      const store = createCaptainSessionStore({ sessionsDir });
      let ownedLease: any;
      const sessionStore = {
        ...store,
        async acquire(sessionId: string) {
          const lease = await store.acquire(sessionId);
          ownedLease = lease;
          if (phase !== 'settle') return lease;
          return {
            ...lease,
            async settle() {
              throw new Error('synthetic settlement failed');
            },
          };
        },
      };

      const out = await headlessHarness(['run', 'cleanup must quarantine'], {
        sessionsDir,
        sessionStore,
        createLogicalSessionId: () =>
          '90000000-0000-4000-8000-000000000091',
        createHostRuntime: async (options: any) => {
          const host = await createTmuxPlayRuntime(options);
          return {
            async runBossTurn(input: string) {
              if (phase === 'setup') {
                throw new Error('setup sentinel must not run');
              }
              if (phase === 'turn') {
                throw new Error('synthetic turn failed');
              }
              await host.runBossTurn(input);
            },
            async dispose() {
              throw new Error('synthetic dispose failed');
            },
          };
        },
        ...(phase === 'setup'
          ? {
              createCaptainSessionId: () =>
                '90000000-0000-4000-8000-000000000091',
            }
          : {}),
      });

      expect(out.result.code).toBe(phase === 'setup' ? 1 : 2);
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain('synthetic dispose failed');
      expect(out.stderr).toContain(
        'writer lease retained until process exit because host cleanup was incomplete',
      );
      if (phase !== 'setup') {
        expect(
          JSON.parse(
            await readFile(
              join(
                sessionsDir,
                '90000000-0000-4000-8000-000000000091.json',
              ),
              'utf8',
            ),
          ).state,
        ).toBe('uncertain');
      }
      await expect(
        store.acquire('90000000-0000-4000-8000-000000000091'),
      ).rejects.toThrow(/lease is active/);
      await ownedLease.release();
    }
  });

  it('drains stdin before config preparation, import, and readiness', async () => {
    const input = 'piped prompt';
    const order: string[] = [];
    const entries = nestedEntries([]);
    const modules: Record<string, unknown> = {
      'mod://code': { default: entries.code },
      'mod://review': { default: entries.review },
    };
    const out = await headlessHarness(['run'], {
      readStdin: async () => {
        order.push('stdin');
        return input;
      },
      prepareRegistryModule: async ({ id, from }: any) => {
        order.push(`prepare:${id}`);
        return from;
      },
      loadModule: async (specifier: string) => {
        order.push(`load:${specifier}`);
        return modules[specifier];
      },
      probeAdapterSdk: async () => {
        order.push('probe');
        return false;
      },
      classifyRuntime: classifyMissing,
      ephemeralNpx: true,
    });

    expect(out.result.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(order).toEqual([
      'stdin',
      'prepare:code',
      'prepare:review',
      'load:mod://code',
      'load:mod://review',
      'probe',
      'probe',
    ]);
    expect(FakeAdapter.calls).toEqual([]);
  });

  it('preserves the full run argv and replays consumed stdin behind an effective terminator', async () => {
    const input = '--flag-shaped prompt';
    const first = await writeConfig(
      'captain: { adapter: claude, model: replay-one }\n',
    );
    const second = await writeConfig(
      'captain: { adapter: claude, model: replay-two }\n',
    );
    const argv = [
      'run',
      '--json',
      '--verbose',
      '--no-provision',
      '--with',
      first,
      `--with=${second}`,
    ];
    const out = await headlessHarness(argv, {
      readStdin: async () => input,
      probeAdapterSdk: async () => false,
      classifyRuntime: classifyMissing,
      ephemeralNpx: true,
    });

    expect(out.result.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(FakeAdapter.calls).toEqual([]);
    expect(out.stderr).toContain(
      `playbook run --json --verbose --no-provision --with ${first} ` +
        `--with=${second} -- '${input}'`,
    );
    expect(parseRunArgs(['--with', '--'])).toMatchObject({
      terminated: false,
      withPaths: ['--'],
    });
  });

  it('rejects a retired top-level run block instead of silently rebinding', async () => {
    const configPath = await writeConfig(
      `${sharedConfig()}run:\n  captain: codex\n`,
    );
    const stdout = writer();
    const stderr = writer();
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-invalid-run-'));
    tempDirs.push(stateRoot);
    const result = await runPlaybookCli({
      argv: ['run', 'hello'],
      userConfigPath: configPath,
      sessionsDir: join(stateRoot, 'sessions'),
      stdout,
      stderr,
    });
    expect(result.code).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toContain('top-level "run" was removed');
    expect(stderr.text()).toContain('playbooks.<id>.roles');
  });

  it('rejects invalid shared agent config before prepare, import, or host creation', async () => {
    const configPath = await writeConfig(
      [
        'captain: { adapter: claude, model: { invalid: true } }',
        'players: { dev.coder: codex }',
        'playbooks:',
        '  code:',
        '    from: mod://code',
        '    roles: { coder: dev.coder }',
        '',
      ].join('\n'),
    );
    const calls = { prepare: 0, load: 0, host: 0 };
    const stdout = writer();
    const stderr = writer();
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-invalid-agent-'));
    tempDirs.push(stateRoot);
    const result = await runPlaybookCli({
      argv: ['run', 'hello'],
      userConfigPath: configPath,
      sessionsDir: join(stateRoot, 'sessions'),
      prepareRegistryModule: async ({ from }: any) => {
        calls.prepare += 1;
        return from;
      },
      loadModule: async () => {
        calls.load += 1;
        return {};
      },
      createHostRuntime: async () => {
        calls.host += 1;
        throw new Error('must not create host');
      },
      stdout,
      stderr,
    });

    expect(result.code).toBe(1);
    expect(calls).toEqual({ prepare: 0, load: 0, host: 0 });
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toContain('captain.model must be a string');
  });
});

describe('durable Captain continuation (PBCLI-24)', () => {
  it('retracts an unchanged fresh boundary after pre-turn setup fails', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-abandon-state-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const failed = await headlessHarness(['run', 'must not run'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      installRetainedGenerationsForLaunch: async (options: any) => {
        await installRetainedGenerationsForLaunch(options);
        throw new Error('synthetic post-initialization failure');
      },
    });

    expect(failed.result.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.inputs).toEqual([]);
    expect(failed.stderr).toContain('synthetic post-initialization failure');
    await expect(
      stat(join(sessionsDir, `${firstId}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const retried = await headlessHarness(['run', 'now run'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
    });
    expect(retried.result.code).toBe(0);
    expect(retried.inputs).toEqual(['now run']);
  });

  it('starts fresh while the newest settled predecessor lease is live', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-live-state-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const first = await headlessHarness(['run', 'first session'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
    });
    expect(first.result.code).toBe(0);
    const sourcePath = join(sessionsDir, `${firstId}.json`);
    const sourceBytes = await readFile(sourcePath, 'utf8');
    const store = createCaptainSessionStore({ sessionsDir });
    const held = await store.acquire(firstId);

    const second = await headlessHarness(['run', 'unrelated work'], {
      sessionsDir,
      createLogicalSessionId: () => secondId,
    });

    expect(second.result.code).toBe(0);
    expect(second.inputs).toEqual(['unrelated work']);
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
    await held.release();
  });

  it('skips a pre-cutover record for fresh work and explains explicit selection', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-pre-cutover-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const first = await headlessHarness(['run', 'first session'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
    });
    expect(first.result.code).toBe(0);
    const preCutoverPath = join(sessionsDir, `${firstId}.json`);
    const canonical = JSON.parse(await readFile(preCutoverPath, 'utf8'));
    const preCutoverBytes = `${JSON.stringify(
      preUnresolvedEffectsSessionRecord(canonical),
    )}\n`;
    await writeFile(preCutoverPath, preCutoverBytes, 'utf8');

    let explicitHosts = 0;
    const explicit = await headlessHarness(
      ['run', '--session', firstId, 'must not run'],
      {
        sessionsDir,
        createHostRuntime: async () => {
          explicitHosts += 1;
          throw new Error('must not construct a pre-cutover host');
        },
      },
    );
    expect(explicit.result.code).toBe(1);
    expect(explicit.stdout).toBe('');
    expect(explicit.inputs).toEqual([]);
    expect(explicitHosts).toBe(0);
    expect(explicit.stderr).toContain(
      'schema 5 predates the canonical schema-6 unresolved-effect settlement boundary for the artifact-schema-3 effect-authority cutover',
    );
    expect(explicit.stderr).not.toContain(
      'missing field "unresolvedEffects"',
    );

    const fresh = await headlessHarness(['run', 'unrelated fresh work'], {
      sessionsDir,
      createLogicalSessionId: () => secondId,
    });
    expect(fresh.result.code).toBe(0);
    expect(fresh.result.sessionId).toBe(secondId);
    expect(fresh.inputs).toEqual(['unrelated fresh work']);
    expect(fresh.stderr).toContain(
      `skipping legacy Captain session "${firstId}" at "${preCutoverPath}"`,
    );
    expect(fresh.stderr).toContain(
      'schema 5 predates the canonical schema-6 unresolved-effect settlement boundary for the artifact-schema-3 effect-authority cutover and is not resumable',
    );
    expect(fresh.stderr).toContain(
      'move it outside the sessions directory or remove it',
    );
    expect(await readFile(preCutoverPath, 'utf8')).toBe(preCutoverBytes);
  });

  it('starts fresh when the predecessor root options no longer match', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-drift-state-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const events: string[] = [];
    const lifecycle = { inits: 0, restores: 0, adopts: 0 };
    const code = retainedRootEntry(events, lifecycle);
    const review = nestedEntries([]).review;
    const loadModule = async (specifier: string) => ({
      default: specifier === 'mod://code' ? code : review,
    });
    const parked = await headlessHarness(['run', '/code retain it'], {
      sessionsDir,
      loadModule,
      createLogicalSessionId: () => firstId,
      createCaptainRuntime: undefined,
    });
    expect(parked.result.code).toBe(0);
    const sourcePath = join(sessionsDir, `${firstId}.json`);
    const sourceBytes = await readFile(sourcePath, 'utf8');
    const overlay = await writeConfig(
      ['playbooks:', '  code: { changedOption: true }', ''].join('\n'),
    );
    const prompts: string[] = [];
    FakeAdapter.decision = (prompt) => {
      prompts.push(prompt);
      return { action: 'respond', text: 'Started unrelated fresh work.' };
    };

    const fresh = await headlessHarness(
      ['run', '--with', overlay, 'unrelated work'],
      {
        sessionsDir,
        userConfigPath: parked.configPath,
        loadModule,
        createLogicalSessionId: () => secondId,
        createCaptainRuntime: undefined,
      },
    );

    expect(fresh.result.code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Retained resumptions: none.');
    expect(lifecycle.adopts).toBe(0);
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
    expect(
      JSON.parse(
        await readFile(join(sessionsDir, `${secondId}.json`), 'utf8'),
      ).retainedGenerations,
    ).toEqual({});
  });

  const firstId = '90000000-0000-4000-8000-000000000011';
  const secondId = '90000000-0000-4000-8000-000000000012';
  const thirdId = '90000000-0000-4000-8000-000000000013';
  const fourthId = '90000000-0000-4000-8000-000000000014';

  it('persists a closed v7 record before stdout without semantic disposal', async () => {
    const order: string[] = [];
    let disposals = 0;
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-order-state-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const baseStore = createCaptainSessionStore({
      sessionsDir,
      now: () => new Date('2026-08-11T20:00:00.000Z'),
    });
    const out = await headlessHarness(['run', 'hello'], {
      sessionsDir,
      sessionStore: {
        ...baseStore,
        async acquire(sessionId: string) {
          const lease = await baseStore.acquire(sessionId);
          return {
            ...lease,
            async settle(value: any) {
              const committed = await lease.settle(value);
              order.push('persisted');
              return committed;
            },
            async release() {
              await lease.release();
              order.push('released');
            },
          };
        },
      },
      createLogicalSessionId: () => firstId,
      stdout: {
        write(chunk: string) {
          order.push(`stdout:${chunk}`);
          return true;
        },
      },
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          runBossTurn: (...args: any[]) => host.runBossTurn(...args),
          async dispose() {
            disposals += 1;
            await host.dispose();
          },
        };
      },
    });

    expect(out.result.code).toBe(0);
    expect(disposals).toBe(0);
    const path = join(out.sessionsDir, `${firstId}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    expect(order).toEqual([
      'persisted',
      'released',
      'stdout:Captain acknowledged the message.\n',
    ]);
    expect(record).toMatchObject({
      schemaVersion: 7,
      kind: 'captain-session',
      state: 'settled',
      sessionId: firstId,
      createdAt: '2026-08-11T20:00:00.000Z',
      updatedAt: '2026-08-11T20:00:00.003Z',
      cwd: process.cwd(),
      structuralProjection: {
        schemaVersion: 1,
        catalog: {
          code: { manifestCommand: 'code', command: 'code' },
        },
      },
      lastAppliedExecutionProjection: {
        schemaVersion: 2,
        catalog: {
          code: { manifestCommand: 'code', command: 'code' },
        },
      },
      snapshot: {
        schemaVersion: 4,
        mode: 'chat',
        effectLedger: emptyPlaybookEffectLedger(),
      },
      effectLedger: emptyPlaybookEffectLedger(),
      retainedGenerations: {},
    });
    expect((await stat(out.sessionsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rejects a fresh logical-id collision before the Boss turn without changing prior bytes', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-id-collision-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const first = await headlessHarness(['run', 'first turn'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
    });
    expect(first.result.code).toBe(0);
    const path = join(sessionsDir, `${firstId}.json`);
    const before = await readFile(path, 'utf8');

    const collision = await headlessHarness(['run', 'must not run'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => thirdId,
    });
    expect(collision.result.code).toBe(1);
    expect(collision.stdout).toBe('');
    expect(collision.inputs).toEqual([]);
    expect(collision.stderr).toContain(
      `Captain session "${firstId}" already exists`,
    );
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('restores an explicit session instead of init and preserves cwd and timestamps', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-continue-'));
    const frozenCwd = await initHeadlessTestRepository(
      'playbook-frozen-cwd-',
    );
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const lifecycle = { init: 0, restore: 0 };
    const seen: string[] = [];
    const createRuntime = (args: any) => {
      const runtime = scriptedCaptainRuntime(seen)(args);
      return {
        ...runtime,
        async init(session: PlaybookSession) {
          lifecycle.init += 1;
          await runtime.init(session);
        },
        async restore(session: PlaybookSession, snapshot: any) {
          lifecycle.restore += 1;
          await runtime.restore!(session, snapshot);
        },
      };
    };
    const frozen = new Date('2026-08-11T20:10:00.000Z');

    const first = await headlessHarness(['run', 'first'], {
      sessionsDir,
      cwd: frozenCwd,
      createLogicalSessionId: () => firstId,
      createCaptainRuntime: createRuntime,
      now: () => frozen,
    });
    expect(first.result.code).toBe(0);
    const tuningOverlay = await writeConfig(
      [
        'captain: { model: captain-next }',
        'players:',
        '  dev.coder: { model: coder-next }',
        '',
      ].join('\n'),
    );
    let reopenedHostOptions: any;

    const second = await headlessHarness(
      [
        'run',
        '--session',
        firstId,
        '--with',
        tuningOverlay,
        '  exact follow-up  ',
      ],
      {
        sessionsDir,
        cwd: '/must/not/replace/frozen/cwd',
        userConfigPath: first.configPath,
        createCaptainRuntime: createRuntime,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        createHostRuntime: async (options: any) => {
          reopenedHostOptions = options;
          return createTmuxPlayRuntime(options);
        },
      },
    );

    expect(second.result.code).toBe(0);
    expect(second.result.sessionId).toBe(firstId);
    expect(second.result.cwd).toBe(frozenCwd);
    expect(seen).toEqual(['first', '  exact follow-up  ']);
    expect(lifecycle).toEqual({ init: 1, restore: 1 });
    expect(reopenedHostOptions).toMatchObject({
      captainConfig: { model: 'captain-next' },
      players: [
        { id: 'dev.coder', model: 'coder-next' },
        { id: 'dev.reviewer', model: 'reviewer-model' },
      ],
    });
    expect(FakeAdapter.options.at(-1)?.model).toBe('captain-next');
    const record = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(record.createdAt).toBe('2026-08-11T20:10:00.000Z');
    expect(record.updatedAt).toBe('2026-08-11T20:10:00.005Z');
    expect(record.cwd).toBe(frozenCwd);
    expect(record.snapshot.sequences.turn).toBe(2);
    expect(record.lastAppliedExecutionProjection.captain.model).toEqual({
      kind: 'value',
      value: 'captain-next',
    });
    expect(
      record.lastAppliedExecutionProjection.players.find(
        (player: any) => player.id === 'dev.coder',
      ).model,
    ).toEqual({ kind: 'value', value: 'coder-next' });
  });

  it('prunes additive current config members before continuation hooks', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-pruned-reopen-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const first = await headlessHarness(['run', 'settle selected catalog'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
    });
    expect(first.result.code).toBe(0);

    await writeFile(
      first.configPath,
      [
        'captain: { adapter: claude, model: captain-model }',
        'players:',
        '  dev.coder: { adapter: claude, model: coder-model }',
        '  dev.reviewer: { adapter: codex, model: reviewer-model }',
        '  ignored.worker: { adapter: gemini, model: poison-primary }',
        'playbooks:',
        '  code:',
        '    from: mod://code',
        '    roles: { coder: dev.coder }',
        '  review:',
        '    from: mod://review',
        '    roles:',
        '      coder: { player: dev.coder, model: review-coder-fallback }',
        '      reviewer: dev.reviewer',
        '  ignored:',
        '    from: mod://ignored-primary',
        '    roles: { worker: ignored.worker }',
        '',
      ].join('\n'),
      'utf8',
    );
    const overlay = await writeConfig(
      [
        'captain: { model: captain-current }',
        'players:',
        '  ignored.worker: { model: poison-overlay }',
        'playbooks:',
        '  ignored: { from: mod://ignored-malformed }',
        '',
      ].join('\n'),
    );
    const entries = nestedEntries([]);
    const prepares: string[] = [];
    const imports: string[] = [];
    const probes: string[] = [];
    let hostPlayers: string[] = [];

    const continued = await headlessHarness(
      [
        'run',
        '--session',
        firstId,
        '--with',
        overlay,
        'continue selected catalog',
      ],
      {
        sessionsDir,
        userConfigPath: first.configPath,
        prepareRegistryModule: async ({ id, from }: any) => {
          prepares.push(id);
          return from;
        },
        loadModule: async (specifier: string) => {
          imports.push(specifier);
          if (specifier === 'mod://code') return { default: entries.code };
          if (specifier === 'mod://review') return { default: entries.review };
          return { default: { id: 'ignored' } };
        },
        probeAdapterSdk: async (adapter: string) => {
          probes.push(adapter);
          return true;
        },
        createHostRuntime: async (options: any) => {
          hostPlayers = options.players.map((player: any) => player.id);
          return createTmuxPlayRuntime(options);
        },
      },
    );

    expect(continued.result.code).toBe(0);
    expect(continued.inputs).toEqual(['continue selected catalog']);
    expect(prepares).toEqual(['code', 'review']);
    expect(imports).toEqual(['mod://code', 'mod://review']);
    expect(probes).toEqual(['claude', 'codex']);
    expect(hostPlayers).toEqual(['dev.coder', 'dev.reviewer']);
    expect(continued.result.config.captain.model).toEqual({
      kind: 'value',
      value: 'captain-current',
    });
    expect(Object.keys(continued.result.config.catalog)).toEqual([
      'code',
      'review',
    ]);
    expect(continued.result.config.players.map((player: any) => player.id))
      .toEqual(['dev.coder', 'dev.reviewer']);
  });

  it('persists completed-root settlement evidence as a continuable chat snapshot', async () => {
    const out = await headlessHarness(['run', '/review complete it'], {
      createLogicalSessionId: () => firstId,
    });
    expect(out.result.code).toBe(0);
    const record = JSON.parse(
      await readFile(join(out.sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(record.snapshot).toMatchObject({
      mode: 'chat',
      lastAction: 'start',
      lastSettlementStatus: 'ok',
    });
    expect(record.snapshot.journal.map((item: any) => item.kind)).toContain(
      'outcome',
    );
  });

  it('restores a nested parked stack across CLI hosts without repeating the child start', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-nested-state-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const events: string[] = [];
    const lifecycle = {
      childCalls: 0,
      parentResumes: 0,
      codeInits: 0,
      codeRestores: 0,
      reviewInits: 0,
      reviewRestores: 0,
    };
    const schema2Entries = nestedParkedEntries(events, lifecycle);
    schema2Entries.review.validateOptions = () => ({
      normalizedByRegistry: true,
    });
    const constructions: Array<{
      playbookId: string;
      options: unknown;
      capability: any;
    }> = [];
    const promoteEntry = (entry: any) => ({
      ...entry,
      artifactSchema: 3,
      runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
      createRuntime(options: unknown, capability: unknown) {
        constructions.push({ playbookId: entry.id, options, capability });
        return entry.createRuntime(options);
      },
    });
    const entries = {
      code: promoteEntry(schema2Entries.code),
      review: promoteEntry(schema2Entries.review),
    };
    const writerLeases: any[] = [];
    const createEffectLedgerWriteAhead = (lease: unknown) => {
      writerLeases.push(lease);
      const effectLedger = emptyPlaybookEffectLedger();
      return {
        snapshot: () => effectLedger,
        writeAhead: async () => effectLedger,
      };
    };
    const captainRuntime = scriptedCaptainRuntime([], { action: 'deliver' });
    const loadModule = async (specifier: string) => ({
      default: specifier === 'mod://code' ? entries.code : entries.review,
    });

    const first = await headlessHarness(['run', '/code inspect it'], {
      sessionsDir,
      loadModule,
      createCaptainRuntime: captainRuntime,
      createLogicalSessionId: () => firstId,
      createEffectLedgerWriteAhead,
    });
    expect(first.result.code).toBe(0);
    const parked = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(parked.snapshot).toMatchObject({
      mode: 'engaged.parked',
      frames: [
        { playbookId: 'code', runtime: { suspendedCall: { callId: 'code:review:durable' } } },
        {
          playbookId: 'review',
          parentCallId: 'code:review:durable',
          options: { normalizedByRegistry: true },
        },
      ],
    });
    expect(parked.retainedGenerations.code).toMatchObject({
      frames: [
        {
          playbookId: 'code',
          runtime: {
            suspendedCall: { callId: 'code:review:durable' },
          },
        },
        {
          playbookId: 'review',
          parentCallId: 'code:review:durable',
          options: { normalizedByRegistry: true },
        },
      ],
    });
    expect(parked.structuralProjection.catalog.review.options).toEqual({});
    expect(lifecycle.childCalls).toBe(1);
    const parkedProjection = JSON.stringify(parked);
    for (const key of [
      'hostCapabilities',
      'leaseOwnerToken',
    ]) {
      expect(parkedProjection).not.toContain(`"${key}"`);
    }
    expect(parked.effectLedger).toEqual(emptyPlaybookEffectLedger());

    const exactReply = '  exact review reply\nwith context\n';
    const second = await headlessHarness(
      ['run', '--session', firstId],
      {
        sessionsDir,
        loadModule,
        createCaptainRuntime: captainRuntime,
        readStdin: async () => exactReply,
        cwd: '/must/not/replace/stored/schema-3/cwd',
        createEffectLedgerWriteAhead,
      },
    );
    expect(second.result.code).toBe(0);
    expect(second.result.sessionId).toBe(firstId);
    expect(events).toEqual([
      'code:start:inspect it',
      'review:park:review durable work',
      `review:finish:${exactReply}`,
      'code:resume:code:review:durable:ok',
    ]);
    expect(lifecycle).toMatchObject({
      childCalls: 1,
      parentResumes: 1,
      codeInits: 1,
      codeRestores: 1,
      reviewInits: 1,
      reviewRestores: 1,
    });
    expect(writerLeases).toHaveLength(2);
    expect(writerLeases[0].ownerToken).not.toBe(writerLeases[1].ownerToken);
    expect(constructions.map(({ playbookId }) => playbookId)).toEqual([
      'code',
      'review',
      'code',
      'review',
    ]);
    for (const [index, construction] of constructions.entries()) {
      const lease = writerLeases[index < 2 ? 0 : 1];
      expect(construction.capability.authority).toMatchObject({
        playbookId: construction.playbookId,
        sessionId: firstId,
        leaseOwnerToken: lease.ownerToken,
        cwd: process.cwd(),
      });
      expect(construction.capability.authority.canonicalWorktree.worktree).toBe(
        process.cwd(),
      );
    }
    expect(second.stderr).not.toContain('/review called by /code');
    const settled = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    const settledProjection = JSON.stringify(settled);
    for (const key of [
      'hostCapabilities',
      'leaseOwnerToken',
    ]) {
      expect(settledProjection).not.toContain(`"${key}"`);
    }
    for (const lease of writerLeases) {
      expect(settledProjection).not.toContain(lease.ownerToken);
    }
    expect(settled.snapshot.mode).toBe('chat');
    expect(settled.effectLedger).toEqual(emptyPlaybookEffectLedger());
    expect(settled.retainedGenerations).toEqual({});
  });

  it('lets explicit start beat an offer before bare --continue adopts it (PBCLI-56)', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-resume-state-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const events: string[] = [];
    const lifecycle = { inits: 0, restores: 0, adopts: 0 };
    const code = retainedRootEntry(events, lifecycle);
    const review = nestedEntries([]).review;
    const createCaptainSessionId = uuidSequence();
    const loadModule = async (specifier: string) => ({
      default: specifier === 'mod://code' ? code : review,
    });

    const parked = await headlessHarness(['run', '/code retain it'], {
      sessionsDir,
      loadModule,
      createLogicalSessionId: () => firstId,
      createCaptainSessionId,
      createCaptainRuntime: undefined,
    });
    expect(parked.result.code).toBe(0);

    FakeAdapter.decision = () => ({ action: 'dismiss' });
    const dismissed = await headlessHarness(
      ['run', '--session', firstId, 'leave it for later'],
      {
        sessionsDir,
        loadModule,
        createCaptainSessionId,
        createCaptainRuntime: undefined,
      },
    );
    expect(dismissed.result.code).toBe(0);
    expect(dismissed.result.snapshot).toMatchObject({
      mode: 'chat',
      lastAction: 'dismiss',
    });
    const retained = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(retained).toMatchObject({
      state: 'settled',
      snapshot: { mode: 'chat' },
      retainedGenerations: { code: { frames: [{ playbookId: 'code' }] } },
    });

    FakeAdapter.decision = () => {
      throw new Error('explicit fresh start must bypass Captain arbitration');
    };
    const restarted = await headlessHarness(
      ['run', '--session', firstId, '/code fresh replacement'],
      {
        sessionsDir,
        loadModule,
        createCaptainSessionId,
        createCaptainRuntime: undefined,
      },
    );
    expect(restarted.result.code).toBe(0);
    expect(events).toEqual([
      'code:park:retain it',
      'code:park:fresh replacement',
    ]);
    expect(restarted.result.snapshot).toMatchObject({
      mode: 'engaged.parked',
      lastAction: 'start',
    });
    expect(lifecycle).toMatchObject({
      inits: 2,
      restores: 1,
      adopts: 0,
    });

    FakeAdapter.decision = () => ({ action: 'dismiss' });
    const redismissed = await headlessHarness(
      ['run', '--session', firstId, 'leave the replacement for later'],
      {
        sessionsDir,
        loadModule,
        createCaptainSessionId,
        createCaptainRuntime: undefined,
      },
    );
    expect(redismissed.result.code).toBe(0);

    const degradedPrompts: string[] = [];
    FakeAdapter.decision = (prompt) => {
      degradedPrompts.push(prompt);
      return {
        action: 'respond',
        text: 'The retained offer is temporarily unavailable.',
      };
    };
    const degradedInstall = await headlessHarness(
      ['run', '--session', firstId, 'continue later'],
      {
        sessionsDir,
        createCaptainSessionId,
        createCaptainRuntime: undefined,
        loadModule: async (specifier: string) => ({
          default:
            specifier === 'mod://code'
              ? {
                  ...code,
                  createRuntime() {
                    throw new Error('retained probe construction failed');
                  },
                }
              : review,
        }),
      },
    );
    expect(degradedInstall.result.code).toBe(0);
    expect(degradedInstall.stderr).not.toContain(
      'retained probe construction failed',
    );
    expect(degradedPrompts).toHaveLength(1);
    expect(degradedPrompts[0]).toContain('Retained resumptions: none.');
    expect(degradedInstall.result.snapshot).toMatchObject({
      mode: 'chat',
      lastAction: 'respond',
    });
    expect(
      JSON.parse(
        await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
      ).retainedGenerations,
    ).toHaveProperty('code');

    const resumePrompts: string[] = [];
    FakeAdapter.decision = (prompt) => {
      resumePrompts.push(prompt);
      return { action: 'resume', playbookId: 'code' };
    };
    const resumed = await headlessHarness(
      ['run', '--continue', 'continue'],
      {
        sessionsDir,
        loadModule,
        createCaptainSessionId,
        createCaptainRuntime: undefined,
      },
    );
    expect(resumed.result.code).toBe(0);
    expect(resumed.result.sessionId).toBe(firstId);
    expect(resumePrompts).toHaveLength(1);
    expect(resumePrompts[0]).toContain('[Boss message]\ncontinue');
    expect(resumePrompts[0]).toContain(
      'Retained resumptions:\n- code (/code):',
    );
    expect(lifecycle).toMatchObject({
      inits: 2,
      restores: 2,
      adopts: 1,
    });
    expect(events).toEqual([
      'code:park:retain it',
      'code:park:fresh replacement',
    ]);
    expect(resumed.result.snapshot).toMatchObject({
      mode: 'engaged.parked',
      lastAction: 'resume',
      frames: [{ playbookId: 'code' }],
    });

    FakeAdapter.decision = () => ({ action: 'dismiss' });
    const pausedForRetry = await headlessHarness(
      ['run', '--session', firstId, 'pause before retry'],
      {
        sessionsDir,
        loadModule,
        createCaptainSessionId,
        createCaptainRuntime: undefined,
      },
    );
    expect(pausedForRetry.result.snapshot).toMatchObject({
      mode: 'chat',
      lastAction: 'dismiss',
    });
    const retryStore = createCaptainSessionStore({ sessionsDir });
    const retryLease = await retryStore.acquire(firstId);
    const retryBoundary = await retryLease.read();
    await retryLease.beginTurn({
      input: 'continue',
      attemptId: thirdId,
      attemptedExecutionProjection:
        retryBoundary.lastAppliedExecutionProjection,
    });
    await retryLease.release();
    expect(await retryStore.read(firstId)).toMatchObject({
      state: 'uncertain',
      retainedGenerations: { code: { frames: [{ playbookId: 'code' }] } },
    });

    const retryPrompts: string[] = [];
    FakeAdapter.decision = (prompt) => {
      retryPrompts.push(prompt);
      return { action: 'resume', playbookId: 'code' };
    };
    const retried = await headlessHarness(
      ['run', '--session', firstId, '--retry-uncertain'],
      {
        sessionsDir,
        loadModule,
        createCaptainSessionId,
        createAttemptId: () => fourthId,
        createCaptainRuntime: undefined,
      },
    );
    expect(retried.result.code).toBe(0);
    expect(retryPrompts).toHaveLength(1);
    expect(retryPrompts[0]).toContain('[Boss message]\ncontinue');
    expect(retried.result.snapshot).toMatchObject({
      mode: 'engaged.parked',
      lastAction: 'resume',
    });
    expect(lifecycle.adopts).toBe(2);

    const adoptionPrompts: string[] = [];
    FakeAdapter.decision = (prompt) => {
      adoptionPrompts.push(prompt);
      return { action: 'resume', playbookId: 'code' };
    };
    const adopted = await headlessHarness(['run', 'continue'], {
      sessionsDir,
      loadModule,
      createLogicalSessionId: () => secondId,
      createCaptainSessionId,
      createCaptainRuntime: undefined,
    });
    expect(adopted.result.code).toBe(0);
    expect(adopted.result.sessionId).toBe(secondId);
    expect(adoptionPrompts).toHaveLength(1);
    expect(adoptionPrompts[0]).toContain('[Boss message]\ncontinue');
    expect(adoptionPrompts[0]).toContain(
      'Retained resumptions:\n- code (/code):',
    );
    expect(lifecycle.adopts).toBe(3);
    expect(adopted.result.snapshot).toMatchObject({
      mode: 'engaged.parked',
      lastAction: 'resume',
      frames: [{ playbookId: 'code' }],
    });
    expect(
      JSON.parse(
        await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
      ).retainedGenerations,
    ).toEqual({});
    expect(
      JSON.parse(
        await readFile(join(sessionsDir, `${secondId}.json`), 'utf8'),
      ).retainedGenerations,
    ).toHaveProperty('code');
  });

  it('prefers same-cwd continuation, reports global fallback, and honors explicit selection', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-cwd-select-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const localCwd = join(stateRoot, 'local');
    const foreignCwd = join(stateRoot, 'foreign');
    const unmatchedCwd = join(stateRoot, 'unmatched');
    await Promise.all(
      [localCwd, foreignCwd, unmatchedCwd].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    await Promise.all(
      [localCwd, foreignCwd, unmatchedCwd].map((path) =>
        initializeHeadlessTestRepository(path),
      ),
    );

    const local = await headlessHarness(['run', 'local session'], {
      sessionsDir,
      cwd: localCwd,
      createLogicalSessionId: () => firstId,
      now: () => new Date('2026-08-11T20:19:00.000Z'),
    });
    const foreign = await headlessHarness(['run', 'foreign session'], {
      sessionsDir,
      cwd: foreignCwd,
      createLogicalSessionId: () => secondId,
      now: () => new Date('2026-08-11T20:19:01.000Z'),
    });
    expect([local.result.code, foreign.result.code]).toEqual([0, 0]);

    const preferred = await headlessHarness(
      ['run', '--continue', 'local follow-up'],
      {
        sessionsDir,
        cwd: localCwd,
        now: () => new Date('2026-08-11T20:19:02.000Z'),
      },
    );
    expect(preferred.result.code).toBe(0);
    expect(preferred.result.sessionId).toBe(firstId);
    expect(preferred.result.cwd).toBe(localCwd);
    expect(preferred.inputs).toEqual(['local follow-up']);
    expect(preferred.stderr).not.toContain(
      'no same-directory Captain session exists',
    );

    const fallback = await headlessHarness(
      ['run', '--continue', 'global follow-up'],
      {
        sessionsDir,
        cwd: unmatchedCwd,
        now: () => new Date('2026-08-11T20:19:03.000Z'),
      },
    );
    expect(fallback.result.code).toBe(0);
    expect(fallback.result.sessionId).toBe(firstId);
    expect(fallback.result.cwd).toBe(localCwd);
    expect(fallback.inputs).toEqual(['global follow-up']);
    expect(fallback.stderr).toContain(
      `no same-directory Captain session exists for invoking working directory "${unmatchedCwd}"`,
    );
    expect(fallback.stderr).toContain(
      `selecting globally newest Captain session "${firstId}" with stored working directory "${localCwd}"`,
    );

    const explicit = await headlessHarness(
      ['run', '--session', secondId, 'foreign by id'],
      {
        sessionsDir,
        cwd: localCwd,
        now: () => new Date('2026-08-11T20:19:04.000Z'),
      },
    );
    expect(explicit.result.code).toBe(0);
    expect(explicit.result.sessionId).toBe(secondId);
    expect(explicit.result.cwd).toBe(foreignCwd);
    expect(explicit.inputs).toEqual(['foreign by id']);
    expect(explicit.stderr).not.toContain(
      'no same-directory Captain session exists',
    );
  });

  it('selects the newest resumable same-cwd session and refuses pre-effect records', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-latest-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const first = await headlessHarness(['run', 'older'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      now: () => new Date('2026-08-11T20:20:00.000Z'),
    });
    const second = await headlessHarness(['run', 'newer'], {
      sessionsDir,
      createLogicalSessionId: () => secondId,
      now: () => new Date('2026-08-11T20:20:01.000Z'),
    });
    expect([first.result.code, second.result.code]).toEqual([0, 0]);
    const legacyPath = join(sessionsDir, `${thirdId}.json`);
    const memberlessSchema3Path = join(sessionsDir, `${fourthId}.json`);
    const settledRecord = JSON.parse(
      await readFile(join(sessionsDir, `${secondId}.json`), 'utf8'),
    );
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        schemaVersion: 2,
        kind: settledRecord.kind,
        state: settledRecord.state,
        sessionId: thirdId,
        createdAt: settledRecord.createdAt,
        updatedAt: settledRecord.updatedAt,
        cwd: settledRecord.cwd,
        config: {},
        snapshot: {},
      })}\n`,
      { mode: 0o600 },
    );
    const memberlessSchema3 = preEffectSessionRecord(
      {
        ...settledRecord,
        sessionId: fourthId,
      },
      3,
      false,
    );
    const memberlessSchema3Bytes = `${JSON.stringify(memberlessSchema3)}\n`;
    await writeFile(memberlessSchema3Path, memberlessSchema3Bytes, {
      mode: 0o600,
    });

    let explicitLegacyHosts = 0;
    const explicitLegacy = await headlessHarness(
      ['run', '--session', thirdId, 'must not run'],
      {
        sessionsDir,
        createHostRuntime: async () => {
          explicitLegacyHosts += 1;
          throw new Error('must not construct host for schema 2');
        },
      },
    );
    expect(explicitLegacy.result.code).toBe(1);
    expect(explicitLegacy.stdout).toBe('');
    expect(explicitLegacy.inputs).toEqual([]);
    expect(explicitLegacyHosts).toBe(0);
    expect(explicitLegacy.stderr).toContain(
      'schema 2 has incompatible root-owned player identity',
    );

    const continued = await headlessHarness(
      ['run', '--continue', 'latest reply'],
      {
        sessionsDir,
        now: () => new Date('2026-08-11T20:20:02.000Z'),
      },
    );
    expect(continued.result.code, continued.stderr).toBe(0);
    expect(continued.result.sessionId).toBe(secondId);
    expect(continued.inputs).toEqual(['latest reply']);
    expect(continued.stderr).toContain(
      `skipping legacy Captain session "${thirdId}" at "${legacyPath}"`,
    );
    expect(continued.stderr).toContain(
      'schema 2 has incompatible player identity',
    );
    expect(continued.stderr).toContain(
      `skipping legacy Captain session "${fourthId}" at "${memberlessSchema3Path}"`,
    );
    expect(continued.stderr).toContain(
      'schema 3 predates the artifact-schema-3 effect-authority cutover and is not resumable',
    );
    expect(continued.stderr).toContain(
      'move it outside the sessions directory or remove it',
    );
    expect(await readFile(memberlessSchema3Path, 'utf8')).toBe(
      memberlessSchema3Bytes,
    );

    let explicitPreEffectHosts = 0;
    const explicitPreEffect = await headlessHarness(
      ['run', '--session', fourthId, 'must not run'],
      {
        sessionsDir,
        now: () => new Date('2026-08-11T20:20:03.000Z'),
        createHostRuntime: async () => {
          explicitPreEffectHosts += 1;
          throw new Error('must not construct host for schema 3');
        },
      },
    );
    expect(explicitPreEffect.result.code).toBe(1);
    expect(explicitPreEffect.stdout).toBe('');
    expect(explicitPreEffect.inputs).toEqual([]);
    expect(explicitPreEffectHosts).toBe(0);
    expect(explicitPreEffect.stderr).toContain(
      'schema 3 predates the artifact-schema-3 effect-authority cutover',
    );

    const transientSchema4 = preEffectSessionRecord(
      { ...settledRecord, sessionId: fourthId },
      4,
      true,
    );
    const transientSchema4Bytes = `${JSON.stringify(transientSchema4)}\n`;
    await writeFile(memberlessSchema3Path, transientSchema4Bytes, 'utf8');
    let explicitSchema4Hosts = 0;
    const continuedSchema4 = await headlessHarness(
      ['run', '--session', fourthId, 'must not run'],
      {
        sessionsDir,
        now: () => new Date('2026-08-11T20:20:04.000Z'),
        createHostRuntime: async () => {
          explicitSchema4Hosts += 1;
          throw new Error('must not construct host for schema 4');
        },
      },
    );
    expect(continuedSchema4.result.code).toBe(1);
    expect(continuedSchema4.stdout).toBe('');
    expect(continuedSchema4.inputs).toEqual([]);
    expect(explicitSchema4Hosts).toBe(0);
    expect(continuedSchema4.stderr).toContain(
      'schema 4 predates the artifact-schema-3 effect-authority cutover',
    );
    expect(await readFile(memberlessSchema3Path, 'utf8')).toBe(
      transientSchema4Bytes,
    );

    const malformedPreEffect = preEffectSessionRecord(
      { ...settledRecord, sessionId: fourthId },
      3,
      false,
    );
    malformedPreEffect.snapshot.captain.runtime.schemaVersion = 2;
    await writeFile(
      memberlessSchema3Path,
      `${JSON.stringify(malformedPreEffect)}\n`,
      'utf8',
    );
    let malformedHosts = 0;
    const malformed = await headlessHarness(
      ['run', '--session', fourthId, 'must not run'],
      {
        sessionsDir,
        createHostRuntime: async () => {
          malformedHosts += 1;
          throw new Error('must not construct host for malformed schema 3');
        },
      },
    );
    expect(malformed.result.code).toBe(1);
    expect(malformed.stdout).toBe('');
    expect(malformed.inputs).toEqual([]);
    expect(malformedHosts).toBe(0);
    expect(malformed.stderr).toContain(
      'runtime schema 2 cannot migrate to schema 4',
    );
    expect(malformed.stderr).not.toContain(
      'predates the artifact-schema-3 effect-authority cutover',
    );
  });

  it.each([
    {
      name: 'shell schema 1',
      mutate(record: any) {
        record.snapshot.schemaVersion = 1;
        delete record.snapshot.playerSessions;
        delete record.snapshot.captain.agent;
        const runtime = record.snapshot.captain.runtime;
        runtime.schemaVersion = 2;
        runtime.playerResumeTokens = runtime.roleResumeTokens;
        delete runtime.roleResumeTokens;
      },
      diagnostic:
        'Captain shell snapshot schemaVersion 1 has incompatible player identity',
    },
    {
      name: 'runtime schema 1',
      mutate(record: any) {
        const runtime = record.snapshot.captain.runtime;
        runtime.schemaVersion = 1;
        runtime.playerResumeTokens = runtime.roleResumeTokens;
        delete runtime.roleResumeTokens;
      },
      diagnostic:
        'runtime snapshot schemaVersion 1 is not supported (expected 4)',
    },
    {
      name: 'runtime schema 2',
      mutate(record: any) {
        const runtime = record.snapshot.captain.runtime;
        runtime.schemaVersion = 2;
        runtime.playerResumeTokens = runtime.roleResumeTokens;
        delete runtime.roleResumeTokens;
      },
      diagnostic:
        'runtime snapshot schemaVersion 2 is not supported (expected 4)',
    },
  ])('rejects explicit released $name before host work', async ({
    mutate,
    diagnostic,
  }) => {
    const first = await headlessHarness(['run', 'settled selection'], {
      createLogicalSessionId: () => firstId,
    });
    expect(first.result.code).toBe(0);
    const recordPath = join(first.sessionsDir, `${firstId}.json`);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    mutate(record);
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, 'utf8');

    let hosts = 0;
    const rejected = await headlessHarness(
      ['run', '--session', firstId, 'must not run'],
      {
        sessionsDir: first.sessionsDir,
        createHostRuntime: async () => {
          hosts += 1;
          throw new Error('must not construct host for a released schema');
        },
      },
    );

    expect(rejected.result.code).toBe(1);
    expect(rejected.stdout).toBe('');
    expect(rejected.inputs).toEqual([]);
    expect(hosts).toBe(0);
    expect(rejected.stderr).toContain(diagnostic);
  });

  it('rejects frozen unsupported fast mode before prepare or import', async () => {
    const first = await headlessHarness(['run', 'settled selection'], {
      createLogicalSessionId: () => firstId,
    });
    expect(first.result.code).toBe(0);

    for (const fastMode of [false, true]) {
      const structural = JSON.parse(
        JSON.stringify(first.result.record.structuralProjection),
      );
      const execution = JSON.parse(
        JSON.stringify(first.result.record.lastAppliedExecutionProjection),
      );
      const playerId = execution.catalog.code.roles.coder.playerId;
      structural.players.find((player: any) => player.id === playerId).adapter =
        'gemini';
      execution.players.find((player: any) => player.id === playerId).adapter =
        'gemini';
      execution.catalog.code.roles.coder.fastMode = fastMode;

      const prepareRegistryModule = vi.fn();
      const loadModule = vi.fn();
      await expect(
        validateFrozenExecutionConfig(structural, execution, {
          prepareRegistryModule,
          loadModule,
        }),
      ).rejects.toThrow(/fast.*gemini|gemini.*fast/i);
      expect(prepareRegistryModule).not.toHaveBeenCalled();
      expect(loadModule).not.toHaveBeenCalled();
    }
  });

  it('rereads the selected session under its lease before deciding whether to run', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-reread-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const first = await headlessHarness(['run', 'settled selection'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
    });
    expect(first.result.code).toBe(0);

    const baseStore = createCaptainSessionStore({ sessionsDir });
    let hosts = 0;
    const raced = await headlessHarness(
      ['run', '--continue', 'must not run'],
      {
        sessionsDir,
        sessionStore: {
          ...baseStore,
          async acquire(sessionId: string) {
            const lease = await baseStore.acquire(sessionId);
            await lease.beginTurn({
              input: 'concurrent uncertain boundary',
              attemptId: thirdId,
              attemptedExecutionProjection:
                first.result.record.lastAppliedExecutionProjection,
            });
            return lease;
          },
        },
        createHostRuntime: async () => {
          hosts += 1;
          throw new Error('must not construct host from stale selection');
        },
      },
    );
    expect(raced.result.code).toBe(1);
    expect(raced.stdout).toBe('');
    expect(hosts).toBe(0);
    expect(raced.stderr).toContain('will not be replayed automatically');
    expect(
      JSON.parse(
        await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
      ).state,
    ).toBe('uncertain');
  });

  it('rejects a changed manifest default even under a frozen command override', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-manifest-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const overrideConfig = await writeConfig(
      sharedConfig().replace(
        '    from: mod://code\n',
        '    from: mod://code\n    command: ship\n',
      ),
    );
    const first = await headlessHarness(['run', '/ship do it'], {
      sessionsDir,
      userConfigPath: overrideConfig,
      createLogicalSessionId: () => firstId,
    });
    expect(first.result.code).toBe(0);
    expect(first.result.config.catalog.code).toMatchObject({
      manifestCommand: 'code',
      command: 'ship',
    });
    expect(first.result.config.catalog.code).not.toHaveProperty(
      'commandOverride',
    );

    const frozenCommand = await headlessHarness(
      ['run', '--session', firstId, '/ship continue'],
      {
        sessionsDir,
        userConfigPath: overrideConfig,
      },
    );
    expect(frozenCommand.result.code).toBe(0);
    expect(frozenCommand.result.config.catalog.code.command).toBe('ship');

    const changed = nestedEntries([]);
    changed.code.command = 'changed';
    const rejected = await headlessHarness(
      ['run', '--session', firstId, 'continue'],
      {
        sessionsDir,
        userConfigPath: overrideConfig,
        loadModule: async (specifier: string) => ({
          default:
            specifier === 'mod://code' ? changed.code : changed.review,
        }),
      },
    );
    expect(rejected.result.code).toBe(1);
    expect(rejected.stdout).toBe('');
    expect(rejected.stderr).toContain(
      'does not reproduce the stored structural projection',
    );
    expect(rejected.inputs).toEqual([]);
  });

  it('keeps stdout empty and disposes safely when durable hand-off fails', async () => {
    let disposals = 0;
    let output = '';
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-failing-store-'));
    tempDirs.push(stateRoot);
    const sessionStore = createCaptainSessionStore({
      sessionsDir: join(stateRoot, 'sessions'),
      fsOps: {
        async link() {
          throw new Error('synthetic durable replacement failed');
        },
      },
    });
    const failed = await headlessHarness(['run', 'hello'], {
      sessionStore,
      stdout: {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          runBossTurn: (...args: any[]) => host.runBossTurn(...args),
          async dispose() {
            disposals += 1;
            await host.dispose();
          },
        };
      },
    });
    expect(failed.result.code).toBe(1);
    expect(output).toBe('');
    expect(disposals).toBe(1);
    expect(failed.stderr).toContain('synthetic durable replacement failed');
  });

  it('leaves uncertainty and withholds output when settlement persistence fails', async () => {
    let disposals = 0;
    let output = '';
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-settle-fail-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const recordPath = join(sessionsDir, `${firstId}.json`);
    let replacementWrites = 0;
    const sessionStore = createCaptainSessionStore({
      sessionsDir,
      fsOps: {
        async rename(from: string, to: string) {
          if (
            from.endsWith('.tmp') &&
            to === recordPath &&
            ++replacementWrites === 2
          ) {
            throw new Error('synthetic settlement rename failure');
          }
          return rename(from, to);
        },
      },
    });
    const failed = await headlessHarness(['run', 'hello'], {
      sessionsDir,
      sessionStore,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
      stdout: {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          runBossTurn: (...args: any[]) => host.runBossTurn(...args),
          async dispose() {
            disposals += 1;
            await host.dispose();
          },
        };
      },
    });
    expect(failed.result.code).toBe(2);
    expect(output).toBe('');
    expect(disposals).toBe(1);
    expect(failed.stderr).toContain('synthetic settlement rename failure');
    expect(JSON.parse(await readFile(recordPath, 'utf8')).state).toBe(
      'uncertain',
    );
  });

  it('settles a same-turn unfinished terminal without retaining its initialized state', async () => {
    const fixtures = nestedEntries([]);
    const unfinished = {
      id: 'code',
      command: 'code',
      intent: 'finish unsuccessfully on the first turn',
      artifactSchema: 3 as const,
      runtimeProfile: { kind: 'bespoke', artifactSchema: 3 } as const,
      requiredRoleIds: ['coder'],
      concurrentRoleSets: [] as const,
      validateOptions: (value: unknown) => value,
      createRuntime(): PlaybookRuntime {
        let session: PlaybookSession | undefined;
        let state = activeState('ready');
        let turns = 0;
        return {
          retainedGenerationMetadata: {
            unfinishedFinalStateIds: ['reportedReviewFailure'],
          },
          async init(next) {
            session = next;
          },
          async restore(next, snapshot) {
            session = next;
            state = snapshot.state;
            turns = snapshot.sequences.turn;
          },
          async adopt(next, snapshot) {
            session = next;
            state = snapshot.state;
            turns = snapshot.sequences.turn;
          },
          exportSnapshot() {
            if (session === undefined) return undefined;
            return {
              ...runtimeSnapshot('code', turns),
              machine: { value: state.value, status: state.status },
              state,
            };
          },
          async handleBossInput() {
            turns += 1;
            state = terminalState('reportedReviewFailure');
            return {
              outcome: 'terminal',
              state,
              output: { status: 'review-failed' },
            };
          },
          async resumePlaybookCall() {
            return { outcome: 'no-action', state };
          },
          async dispose() {},
        };
      },
    };
    const input = '/code fail review immediately';
    const out = await headlessHarness(['run', input], {
      loadModule: async (specifier: string) => ({
        default: specifier === 'mod://code' ? unfinished : fixtures.review,
      }),
    });

    expect(out.result.code).toBe(0);
    expect(out.stdout).toBe('Nested CODE and REVIEW completed.\n');
    expect(out.stderr).not.toContain(
      'Captain turn settled without an exportable session settlement',
    );
    const record = JSON.parse(
      await readFile(
        join(
          out.sessionsDir,
          '90000000-0000-4000-8000-000000000001.json',
        ),
        'utf8',
      ),
    );
    expect(record).toMatchObject({
      state: 'settled',
      snapshot: { mode: 'chat' },
      retainedGenerations: {},
    });
    expect(record).not.toHaveProperty('uncertain');
  });

  it('withholds output but preserves a complete settlement after post-rename sync failure', async () => {
    let disposals = 0;
    let output = '';
    let failSessionSync = false;
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-settle-sync-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const baseStore = createCaptainSessionStore({
      sessionsDir,
      fsOps: {
        async open(path: string, flags: string | number, mode?: number) {
          const handle = await open(path, flags as any, mode);
          if (path !== sessionsDir || flags !== 'r') return handle;
          return {
            async sync() {
              if (failSessionSync) {
                throw new Error('synthetic post-rename sync failure');
              }
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      },
    });
    const sessionStore = {
      ...baseStore,
      async acquire(sessionId: string) {
        const lease = await baseStore.acquire(sessionId);
        return {
          ...lease,
          async settle(value: any) {
            failSessionSync = true;
            try {
              return await lease.settle(value);
            } finally {
              failSessionSync = false;
            }
          },
        };
      },
    };
    const failed = await headlessHarness(['run', 'hello'], {
      sessionsDir,
      sessionStore,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
      stdout: {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          runBossTurn: (...args: any[]) => host.runBossTurn(...args),
          async dispose() {
            disposals += 1;
            await host.dispose();
          },
        };
      },
    });
    expect(failed.result.code).toBe(2);
    expect(output).toBe('');
    expect(disposals).toBe(1);
    expect(failed.stderr).toContain('synthetic post-rename sync failure');
    const record = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(record.state).toBe('settled');
    expect(record.snapshot.sequences.turn).toBe(1);
  });

  it('writes uncertainty before effects, refuses implicit replay, and retries exact stored input', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-uncertain-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const exactInput = '  uncertain input\nwith exact bytes\n';
    let markerDuringTurn: any;
    const failed = await headlessHarness(['run', exactInput], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          async runBossTurn() {
            markerDuringTurn = JSON.parse(
              await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
            );
            throw new Error('synthetic crash after first effect boundary');
          },
          dispose: () => host.dispose(),
        };
      },
    });
    expect(failed.result.code).toBe(2);
    expect(failed.stdout).toBe('');
    expect(markerDuringTurn).toMatchObject({
      state: 'uncertain',
      sessionId: firstId,
      snapshot: { sequences: { turn: 0 } },
      uncertain: {
        baseUpdatedAt: expect.any(String),
        input: exactInput,
        attemptId: secondId,
        attemptNumber: 1,
      },
    });
    expect(markerDuringTurn.uncertain.markedAt).toBe(
      markerDuringTurn.updatedAt,
    );
    expect(markerDuringTurn.uncertain.baseUpdatedAt).not.toBe(
      markerDuringTurn.updatedAt,
    );

    let reads = 0;
    let hosts = 0;
    const refused = await headlessHarness(['run', '--session', firstId], {
      sessionsDir,
      readStdin: async () => {
        reads += 1;
        return 'must not read';
      },
      createHostRuntime: async () => {
        hosts += 1;
        throw new Error('must not create host');
      },
    });
    expect(refused.result.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect({ reads, hosts }).toEqual({ reads: 0, hosts: 0 });
    expect(refused.stderr).toContain('will not be replayed automatically');
    expect(refused.stderr).toContain('may duplicate external effects');
    expect(refused.stderr).toContain(
      `playbook run --session ${firstId} --retry-uncertain`,
    );
    expect(refused.stderr).toContain(
      `playbook run --session ${firstId} --discard-uncertain`,
    );

    let retryMarker: any;
    const retried = await headlessHarness(
      ['run', '--session', firstId, '--retry-uncertain'],
      {
        sessionsDir,
        userConfigPath: join(stateRoot, 'must-not-read-current.yaml'),
        createAttemptId: () => thirdId,
        readStdin: async () => {
          reads += 1;
          return 'must not read';
        },
        createHostRuntime: async (options: any) => {
          const host = await createTmuxPlayRuntime(options);
          return {
            async runBossTurn(input: string) {
              retryMarker = JSON.parse(
                await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
              );
              await host.runBossTurn(input);
            },
            dispose: () => host.dispose(),
          };
        },
      },
    );
    expect(retried.result.code).toBe(0);
    expect(retried.inputs).toEqual([exactInput]);
    expect(reads).toBe(0);
    expect(retryMarker).toMatchObject({
      state: 'uncertain',
      uncertain: {
        input: exactInput,
        attemptId: thirdId,
        attemptNumber: 2,
      },
    });
    expect(retryMarker.uncertain.markedAt).toBe(retryMarker.updatedAt);
    expect(retryMarker.uncertain.attemptedExecutionProjection).toEqual(
      markerDuringTurn.uncertain.attemptedExecutionProjection,
    );
    expect(retried.result.config).toEqual(
      markerDuringTurn.uncertain.attemptedExecutionProjection,
    );
    expect(Date.parse(retryMarker.updatedAt)).toBeGreaterThan(
      Date.parse(markerDuringTurn.updatedAt),
    );
    const settled = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(settled.state).toBe('settled');
    expect(settled).not.toHaveProperty('uncertain');
    expect(settled.lastAppliedExecutionProjection).toEqual(
      markerDuringTurn.uncertain.attemptedExecutionProjection,
    );
  });

  it('replays only an all-unchanged multi-attempt suffix and rebases schema-3 frame mirrors', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-effect-retry-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const repositoryCwd = await initHeadlessTestRepository(
      'playbook-effect-retry-repo-',
    );
    const events: string[] = [];
    const lifecycle = {
      childCalls: 0,
      parentResumes: 0,
      codeInits: 0,
      codeRestores: 0,
      reviewInits: 0,
      reviewRestores: 0,
    };
    const baseEntries = nestedParkedEntries(events, lifecycle);
    const restoredFrameLedgers: Array<{
      playbookId: string;
      ledger: unknown;
    }> = [];
    const promoteEntry = (entry: any) => ({
      ...entry,
      artifactSchema: 3,
      runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
      createRuntime(options: unknown, capability: any) {
        const runtime = entry.createRuntime(options);
        return {
          ...runtime,
          async restore(session: unknown, snapshot: any) {
            restoredFrameLedgers.push({
              playbookId: entry.id,
              ledger: snapshot.effectLedger,
            });
            return runtime.restore(session, snapshot);
          },
          exportSnapshot() {
            return {
              ...runtime.exportSnapshot(),
              effectLedger: capability.effectLedger.snapshot(),
            };
          },
        };
      },
    });
    const entries = {
      code: promoteEntry(baseEntries.code),
      review: promoteEntry(baseEntries.review),
    };
    const loadModule = async (specifier: string) => ({
      default: specifier === 'mod://code' ? entries.code : entries.review,
    });
    const captainInputs: string[] = [];
    const captainRuntime = scriptedCaptainRuntime(captainInputs, {
      action: 'deliver',
    });
    const createCaptainSessionId = uuidSequence();
    const first = await headlessHarness(['run', '/code inspect it'], {
      sessionsDir,
      loadModule,
      createCaptainRuntime: captainRuntime,
      createCaptainSessionId,
      createLogicalSessionId: () => firstId,
      cwd: repositoryCwd,
    });
    expect(first.result.code, first.stderr).toBe(0);
    expect(first.result.snapshot).toMatchObject({
      mode: 'engaged.parked',
      frames: [
        { playbookId: 'code' },
        { playbookId: 'review' },
      ],
    });

    const store = createCaptainSessionStore({ sessionsDir });
    const lease = await store.acquire(firstId);
    const settled = await lease.read();
    const checkpoint = settled.snapshot.effectLedger;
    await lease.beginTurn({
      input: 'finish recovered review',
      attemptId: secondId,
      attemptedExecutionProjection:
        settled.lastAppliedExecutionProjection,
    });
    let mirror = (await lease.read()).effectLedger;
    const capabilities = await createRepositoryEffectCapabilities({
      cwd: settled.cwd,
      catalog: settled.structuralProjection.catalog,
      sessionId: firstId,
      sessionLease: lease,
      createWriteAhead: () => ({
        snapshot: () => mirror,
        async writeAhead(authority: unknown, commands: unknown[]) {
          mirror = await lease.writeEffectLedger(authority, commands);
          return mirror;
        },
      }),
    });
    const appendUnchanged = async (boundaryId: string, turnId: number) => {
      await capabilities.code.repository.runExclusive({
        effectBoundary: {
          boundaryId,
          runtimeSessionId:
            '40000000-0000-4000-8000-000000000004',
          turnId,
          callId: `coder:${turnId}`,
          roleId: 'coder',
          sourceStateId: 'implementing',
          sourceOutcomeSchema: { type: 'object' },
          dispositions: ['unchanged'],
          correctionBudget: { limit: 1, spent: false },
        },
        operation: async () => undefined,
      });
    };
    await appendUnchanged(
      '30000000-0000-4000-8000-000000000003',
      1,
    );
    await lease.beginRetry({
      expectedAttemptId: secondId,
      nextAttemptId: thirdId,
    });
    await appendUnchanged(
      '30000000-0000-4000-8000-000000000005',
      2,
    );
    const beforeRetry = await lease.read();
    expect(beforeRetry.snapshot.effectLedger).toEqual(checkpoint);
    expect(
      beforeRetry.effectLedger.boundaries.map(
        (boundary: any) => boundary.physicalReceipt.classification,
      ),
    ).toEqual(['unchanged', 'unchanged']);
    expect(
      beforeRetry.effectLedger.boundaries.map(
        (boundary: any) => boundary.attemptNumber,
      ),
    ).toEqual([1, 2]);
    await lease.release();

    const retried = await headlessHarness(
      ['run', '--session', firstId, '--retry-uncertain'],
      {
        sessionsDir,
        loadModule,
        createCaptainRuntime: captainRuntime,
        createCaptainSessionId,
        createAttemptId: () => fourthId,
      },
    );
    expect(retried.result.code, retried.stderr).toBe(0);
    expect(captainInputs).toEqual([
      '/code inspect it',
      'finish recovered review',
    ]);
    expect(restoredFrameLedgers).toEqual([
      { playbookId: 'code', ledger: beforeRetry.effectLedger },
      { playbookId: 'review', ledger: beforeRetry.effectLedger },
    ]);
    expect(retried.result.snapshot.captain.runtime.effectLedger).toEqual(
      emptyPlaybookEffectLedger(),
    );
    expect(retried.result.record.effectLedger.boundaries).toHaveLength(2);
    expect(retried.result.snapshot.effectLedger).toEqual(
      retried.result.record.effectLedger,
    );
    for (const frame of retried.result.snapshot.frames ?? []) {
      expect(frame.runtime.effectLedger).toEqual(
        retried.result.record.effectLedger,
      );
    }
  });

  it('parks when any earlier attempt has a non-unchanged receipt before retry work', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-effect-park-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const repositoryCwd = await initHeadlessTestRepository(
      'playbook-effect-park-repo-',
    );
    const promoteEntry = (entry: any) => ({
      ...entry,
      artifactSchema: 3,
      runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
    });
    const first = await headlessHarness(['run', 'settle baseline'], {
      sessionsDir,
      entryTransform: promoteEntry,
      createLogicalSessionId: () => firstId,
      cwd: repositoryCwd,
    });
    expect(first.result.code, first.stderr).toBe(0);

    const store = createCaptainSessionStore({ sessionsDir });
    const lease = await store.acquire(firstId);
    const settled = await lease.read();
    await lease.beginTurn({
      input: 'must remain parked',
      attemptId: secondId,
      attemptedExecutionProjection:
        settled.lastAppliedExecutionProjection,
    });
    let mirror = (await lease.read()).effectLedger;
    const capabilities = await createRepositoryEffectCapabilities({
      cwd: settled.cwd,
      catalog: settled.structuralProjection.catalog,
      sessionId: firstId,
      sessionLease: lease,
      createWriteAhead: () => ({
        snapshot: () => mirror,
        async writeAhead(authority: unknown, commands: unknown[]) {
          mirror = await lease.writeEffectLedger(authority, commands);
          return mirror;
        },
      }),
    });
    const ambiguousBoundaryId =
      '30000000-0000-4000-8000-000000000013';
    const baseline = await capabilities.code.repository.observe();
    await capabilities.code.effectLedger.writeAhead([
      {
        kind: 'start-boundaries',
        boundaries: [
          {
            boundaryId: ambiguousBoundaryId,
            playbookId: 'code',
            runtimeSessionId:
              '40000000-0000-4000-8000-000000000014',
            turnId: 1,
            callId: 'coder:ambiguous',
            roleId: 'coder',
            sourceStateId: 'implementing',
            sourceOutcomeSchema: { type: 'object' },
            dispositions: ['unchanged'],
            canonicalWorktree:
              capabilities.code.authority.canonicalWorktree,
            baseline,
            correctionBudget: { limit: 1, spent: false },
          },
        ],
      },
    ]);
    const started = capabilities.code.effectLedger
      .snapshot()
      .boundaries.at(-1);
    await capabilities.code.effectLedger.writeAhead([
      {
        kind: 'replace-boundaries',
        replacements: [
          {
            expected: started,
            next: {
              ...started,
              physicalReceipt: {
                classification: 'observation-ambiguous',
                baseline,
              },
            },
          },
        ],
      },
    ]);
    await lease.beginRetry({
      expectedAttemptId: secondId,
      nextAttemptId: thirdId,
    });
    await capabilities.code.repository.runExclusive({
      effectBoundary: {
        boundaryId: '30000000-0000-4000-8000-000000000015',
        runtimeSessionId:
          '40000000-0000-4000-8000-000000000016',
        turnId: 2,
        callId: 'coder:unchanged',
        roleId: 'coder',
        sourceStateId: 'implementing',
        sourceOutcomeSchema: { type: 'object' },
        dispositions: ['unchanged'],
        correctionBudget: { limit: 1, spent: false },
      },
      operation: async () => undefined,
    });
    const beforeRetry = await lease.read();
    await lease.release();
    const beforeBytes = await readFile(
      join(sessionsDir, `${firstId}.json`),
      'utf8',
    );

    const captainFactory = vi.fn(scriptedCaptainRuntime([]));
    const hostFactory = vi.fn();
    const retried = await headlessHarness(
      ['run', '--session', firstId, '--retry-uncertain'],
      {
        sessionsDir,
        userConfigPath: first.configPath,
        entryTransform: promoteEntry,
        createAttemptId: () => fourthId,
        createCaptainRuntime: captainFactory,
        createHostRuntime: hostFactory,
      },
    );
    expect(retried.result.code).toBe(1);
    expect(retried.stdout).toBe('');
    expect(retried.stderr).toContain(ambiguousBoundaryId);
    expect(retried.stderr).toContain('observation-ambiguous');
    expect(retried.stderr).toContain('remains parked for reconciliation');
    expect(captainFactory).not.toHaveBeenCalled();
    expect(hostFactory).not.toHaveBeenCalled();
    expect(await readFile(join(sessionsDir, `${firstId}.json`), 'utf8')).toBe(
      beforeBytes,
    );
    expect(await store.read(firstId)).toMatchObject({
      state: 'uncertain',
      uncertain: {
        attemptId: beforeRetry.uncertain.attemptId,
        attemptNumber: 2,
      },
    });
  });

  it('parks logical-only deferred progress without reusing the stored Boss turn', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-logical-park-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const repositoryCwd = await initHeadlessTestRepository(
      'playbook-logical-park-repo-',
    );
    const promoteEntry = (entry: any) => ({
      ...entry,
      artifactSchema: 3,
      runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
    });
    const first = await headlessHarness(['run', 'settle baseline'], {
      sessionsDir,
      entryTransform: promoteEntry,
      createLogicalSessionId: () => firstId,
      cwd: repositoryCwd,
    });
    expect(first.result.code, first.stderr).toBe(0);

    const store = createCaptainSessionStore({ sessionsDir });
    const lease = await store.acquire(firstId);
    const settled = await lease.read();
    await lease.beginTurn({
      input: 'bind a question',
      attemptId: secondId,
      attemptedExecutionProjection:
        settled.lastAppliedExecutionProjection,
    });
    let mirror = (await lease.read()).effectLedger;
    const capabilities = await createRepositoryEffectCapabilities({
      cwd: settled.cwd,
      catalog: settled.structuralProjection.catalog,
      sessionId: firstId,
      sessionLease: lease,
      createWriteAhead: () => ({
        snapshot: () => mirror,
        async writeAhead(authority: unknown, commands: unknown[]) {
          mirror = await lease.writeEffectLedger(authority, commands);
          return mirror;
        },
      }),
    });
    const operationId = '50000000-0000-4000-8000-000000000021';
    await capabilities.code.repository.runExclusive({
      effectBoundary: {
        boundaryId: '30000000-0000-4000-8000-000000000023',
        runtimeSessionId:
          '40000000-0000-4000-8000-000000000024',
        turnId: 1,
        callId: 'coder:question',
        roleId: 'coder',
        sourceStateId: 'implementing',
        sourceOutcomeSchema: { type: 'object' },
        dispositions: ['unchanged', 'deferred'],
        correctionBudget: { limit: 1, spent: false },
      },
      operation: async () => undefined,
      completeEffectBoundary: async () => ({
        finalText: 'May I continue?',
        deferred: {
          operationId,
          pendingQuestion: {
            questionId: 'question-1',
            asker: { kind: 'role', roleId: 'coder' },
            question: 'May I continue?',
          },
          playerContinuation: { v: 1, playerId: 'dev.coder' },
        },
      }),
    });
    const checkpointRecord = await lease.settle({
      attemptId: secondId,
      unresolvedEffects: [],
      snapshot: {
        ...settled.snapshot,
        effectLedger: mirror,
      },
    });
    await lease.beginTurn({
      input: 'yes, but from the wrong checkpoint',
      attemptId: thirdId,
      attemptedExecutionProjection:
        checkpointRecord.lastAppliedExecutionProjection,
    });
    const expectedOperation = mirror.logicalOperations[0];
    await capabilities.code.effectLedger.writeAhead([
      {
        kind: 'replace-logical-operations',
        replacements: [
          {
            expected: expectedOperation,
            next: {
              ...expectedOperation,
              checkpointRestorationEligible: true,
            },
          },
        ],
      },
    ]);
    const beforeRetry = await lease.read();
    expect(beforeRetry.effectLedger.boundaries).toEqual(
      beforeRetry.snapshot.effectLedger.boundaries,
    );
    expect(beforeRetry.effectLedger.logicalOperations).not.toEqual(
      beforeRetry.snapshot.effectLedger.logicalOperations,
    );
    await lease.release();
    const beforeBytes = await readFile(
      join(sessionsDir, `${firstId}.json`),
      'utf8',
    );

    const captainFactory = vi.fn(scriptedCaptainRuntime([]));
    const hostFactory = vi.fn();
    const retried = await headlessHarness(
      ['run', '--session', firstId, '--retry-uncertain'],
      {
        sessionsDir,
        userConfigPath: first.configPath,
        entryTransform: promoteEntry,
        createAttemptId: () => fourthId,
        createCaptainRuntime: captainFactory,
        createHostRuntime: hostFactory,
      },
    );
    expect(retried.result.code).toBe(1);
    expect(retried.stdout).toBe('');
    expect(retried.stderr).toContain('deferred logical-operation progress');
    expect(retried.stderr).toContain('cannot replay the Boss turn');
    expect(captainFactory).not.toHaveBeenCalled();
    expect(hostFactory).not.toHaveBeenCalled();
    expect(await readFile(join(sessionsDir, `${firstId}.json`), 'utf8')).toBe(
      beforeBytes,
    );
  });

  it('parks when recovery changes a boundary inside the restorable checkpoint', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-prefix-park-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const repositoryCwd = await initHeadlessTestRepository(
      'playbook-prefix-park-repo-',
    );
    const promoteEntry = (entry: any) => ({
      ...entry,
      artifactSchema: 3,
      runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
    });
    const first = await headlessHarness(['run', 'settle baseline'], {
      sessionsDir,
      entryTransform: promoteEntry,
      createLogicalSessionId: () => firstId,
      cwd: repositoryCwd,
    });
    expect(first.result.code, first.stderr).toBe(0);

    const store = createCaptainSessionStore({ sessionsDir });
    const lease = await store.acquire(firstId);
    const settled = await lease.read();
    await lease.beginTurn({
      input: 'establish incomplete checkpoint',
      attemptId: secondId,
      attemptedExecutionProjection:
        settled.lastAppliedExecutionProjection,
    });
    let mirror = (await lease.read()).effectLedger;
    const capabilities = await createRepositoryEffectCapabilities({
      cwd: settled.cwd,
      catalog: settled.structuralProjection.catalog,
      sessionId: firstId,
      sessionLease: lease,
      createWriteAhead: () => ({
        snapshot: () => mirror,
        async writeAhead(authority: unknown, commands: unknown[]) {
          mirror = await lease.writeEffectLedger(authority, commands);
          return mirror;
        },
      }),
    });
    const baseline = await capabilities.code.repository.observe();
    await capabilities.code.effectLedger.writeAhead([
      {
        kind: 'start-boundaries',
        boundaries: [
          {
            boundaryId: '30000000-0000-4000-8000-000000000033',
            playbookId: 'code',
            runtimeSessionId:
              '40000000-0000-4000-8000-000000000034',
            turnId: 1,
            callId: 'coder:checkpoint',
            roleId: 'coder',
            sourceStateId: 'implementing',
            sourceOutcomeSchema: { type: 'object' },
            dispositions: ['unchanged'],
            canonicalWorktree:
              capabilities.code.authority.canonicalWorktree,
            baseline,
            correctionBudget: { limit: 1, spent: false },
          },
        ],
      },
    ]);
    const checkpointRecord = await lease.settle({
      attemptId: secondId,
      unresolvedEffects: [],
      snapshot: { ...settled.snapshot, effectLedger: mirror },
    });
    await lease.beginTurn({
      input: 'must not replay changed checkpoint',
      attemptId: thirdId,
      attemptedExecutionProjection:
        checkpointRecord.lastAppliedExecutionProjection,
    });
    const incomplete = mirror.boundaries[0];
    await capabilities.code.effectLedger.writeAhead([
      {
        kind: 'replace-boundaries',
        replacements: [
          {
            expected: incomplete,
            next: {
              ...incomplete,
              after: baseline,
              physicalReceipt: {
                classification: 'unchanged',
                baseline,
                after: baseline,
              },
            },
          },
        ],
      },
    ]);
    await lease.release();
    const beforeBytes = await readFile(
      join(sessionsDir, `${firstId}.json`),
      'utf8',
    );

    const captainFactory = vi.fn(scriptedCaptainRuntime([]));
    const hostFactory = vi.fn();
    const retried = await headlessHarness(
      ['run', '--session', firstId, '--retry-uncertain'],
      {
        sessionsDir,
        userConfigPath: first.configPath,
        entryTransform: promoteEntry,
        createAttemptId: () => fourthId,
        createCaptainRuntime: captainFactory,
        createHostRuntime: hostFactory,
      },
    );
    expect(retried.result.code).toBe(1);
    expect(retried.stdout).toBe('');
    expect(retried.stderr).toContain('cannot restore a changed pre-turn boundary');
    expect(captainFactory).not.toHaveBeenCalled();
    expect(hostFactory).not.toHaveBeenCalled();
    expect(await readFile(join(sessionsDir, `${firstId}.json`), 'utf8')).toBe(
      beforeBytes,
    );
  });

  it('retries the exact attempted tuning instead of settled or current tuning', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-retuned-retry-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const first = await headlessHarness(['run', 'settle configuration A'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
    });
    expect(first.result.code).toBe(0);
    const baselineA = first.result.record.lastAppliedExecutionProjection;
    const overlayB = await writeConfig(
      [
        'captain: { model: captain-B, fastMode: true }',
        'players:',
        '  dev.coder: { model: coder-B, fastMode: false }',
        '  dev.reviewer: { model: reviewer-B, fastMode: true }',
        'playbooks:',
        '  code:',
        '    roles:',
        '      coder: { player: dev.coder, fastMode: true }',
        '',
      ].join('\n'),
    );
    const attemptedInput = 'attempt configuration B';
    let hostB: any;
    let markerB: any;

    const failed = await headlessHarness(
      [
        'run',
        '--session',
        firstId,
        '--with',
        overlayB,
        attemptedInput,
      ],
      {
        sessionsDir,
        userConfigPath: first.configPath,
        createAttemptId: () => secondId,
        createHostRuntime: async (options: any) => {
          hostB = options;
          const host = await createTmuxPlayRuntime(options);
          return {
            async runBossTurn() {
              markerB = JSON.parse(
                await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
              );
              throw new Error('synthetic configuration B crash');
            },
            dispose: () => host.dispose(),
          };
        },
      },
    );

    expect(failed.result.code).toBe(2);
    expect(failed.stdout).toBe('');
    expect(hostB).toMatchObject({
      captainConfig: { model: 'captain-B', fastMode: true },
      players: [
        { id: 'dev.coder', model: 'coder-B', fastMode: false },
        { id: 'dev.reviewer', model: 'reviewer-B', fastMode: true },
      ],
    });
    expect(markerB.lastAppliedExecutionProjection).toEqual(baselineA);
    expect(markerB.uncertain).toMatchObject({
      input: attemptedInput,
      attemptId: secondId,
      attemptNumber: 1,
      attemptedExecutionProjection: {
        captain: {
          model: { kind: 'value', value: 'captain-B' },
          fastMode: true,
        },
        players: [
          {
            id: 'dev.coder',
            model: { kind: 'value', value: 'coder-B' },
            fastMode: false,
          },
          {
            id: 'dev.reviewer',
            model: { kind: 'value', value: 'reviewer-B' },
            fastMode: true,
          },
        ],
        catalog: {
          code: { roles: { coder: { fastMode: true } } },
        },
      },
    });
    const attemptedB = markerB.uncertain.attemptedExecutionProjection;
    expect(attemptedB).not.toEqual(baselineA);

    const configC = await writeConfig(
      sharedConfig()
        .replace('captain-model }', 'captain-C, fastMode: false }')
        .replace('coder-model }', 'coder-C, fastMode: true }')
        .replace('reviewer-model }', 'reviewer-C, fastMode: false }')
        .replace(
          'roles: { coder: dev.coder }',
          'roles: { coder: { player: dev.coder, fastMode: false } }',
        ),
    );
    let retryHost: any;
    const retried = await headlessHarness(
      ['run', '--session', firstId, '--retry-uncertain'],
      {
        sessionsDir,
        userConfigPath: configC,
        createAttemptId: () => thirdId,
        createHostRuntime: async (options: any) => {
          retryHost = options;
          return createTmuxPlayRuntime(options);
        },
      },
    );

    expect(retried.result.code).toBe(0);
    expect(retried.inputs).toEqual([attemptedInput]);
    expect(retryHost).toMatchObject({
      captainConfig: { model: 'captain-B', fastMode: true },
      players: [
        { id: 'dev.coder', model: 'coder-B', fastMode: false },
        { id: 'dev.reviewer', model: 'reviewer-B', fastMode: true },
      ],
    });
    expect(retried.result.config).toEqual(attemptedB);
    const settled = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(settled.state).toBe('settled');
    expect(settled).not.toHaveProperty('uncertain');
    expect(settled.lastAppliedExecutionProjection).toEqual(attemptedB);
  });

  it('rechecks lease ownership after the marker and immediately before model work', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-owner-swap-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const baseStore = createCaptainSessionStore({ sessionsDir });
    let bossTurns = 0;
    const out = await headlessHarness(['run', 'must remain uncertain'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
      sessionStore: {
        ...baseStore,
        async acquire(sessionId: string) {
          const lease = await baseStore.acquire(sessionId);
          return {
            ...lease,
            async beginTurn(value: any) {
              const record = await lease.beginTurn(value);
              const ownerPath = join(
                sessionsDir,
                `.${sessionId}.lock`,
                'owner.json',
              );
              const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
              await writeFile(
                ownerPath,
                `${JSON.stringify({ ...owner, ownerToken: thirdId })}\n`,
                'utf8',
              );
              return record;
            },
          };
        },
      },
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          async runBossTurn(input: string) {
            bossTurns += 1;
            await host.runBossTurn(input);
          },
          dispose: () => host.dispose(),
        };
      },
    });
    expect(out.result.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(bossTurns).toBe(0);
    expect(out.stderr).toContain('owned by a different token');
    expect(
      JSON.parse(
        await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
      ).state,
    ).toBe('uncertain');
  });

  it('discards to the exact settled boundary without input, config, readiness, or host work', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-discard-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const first = await headlessHarness(['run', 'settled input'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
    });
    expect(first.result.code).toBe(0);
    const path = join(sessionsDir, `${firstId}.json`);
    const settledBytes = await readFile(path, 'utf8');

    const failed = await headlessHarness(
      ['run', '--session', firstId, 'attempted continuation'],
      {
        sessionsDir,
        createAttemptId: () => thirdId,
        createHostRuntime: async (options: any) => {
          const host = await createTmuxPlayRuntime(options);
          return {
            async runBossTurn() {
              throw new Error('synthetic continued crash');
            },
            dispose: () => host.dispose(),
          };
        },
      },
    );
    expect(failed.result.code).toBe(2);
    expect(
      JSON.parse(await readFile(path, 'utf8')).state,
    ).toBe('uncertain');

    const calls = { stdin: 0, load: 0, probe: 0, host: 0 };
    const discarded = await headlessHarness(
      ['run', '--session', firstId, '--discard-uncertain'],
      {
        sessionsDir,
        readStdin: async () => {
          calls.stdin += 1;
          return 'must not read';
        },
        loadModule: async () => {
          calls.load += 1;
          throw new Error('must not import');
        },
        probeAdapterSdk: async () => {
          calls.probe += 1;
          return false;
        },
        createHostRuntime: async () => {
          calls.host += 1;
          throw new Error('must not host');
        },
      },
    );
    expect(discarded.result.code).toBe(0);
    expect(discarded.stdout).toBe('');
    expect(discarded.stderr).toContain('discarded uncertain turn');
    expect(calls).toEqual({ stdin: 0, load: 0, probe: 0, host: 0 });
    expect(await readFile(path, 'utf8')).toBe(settledBytes);

    const freshFailed = await headlessHarness(['run', 'fresh turn-zero crash'], {
      sessionsDir,
      createLogicalSessionId: () => secondId,
      createAttemptId: () => thirdId,
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          async runBossTurn() {
            throw new Error('synthetic fresh crash');
          },
          dispose: () => host.dispose(),
        };
      },
    });
    expect(freshFailed.result.code).toBe(2);
    const freshCalls = { stdin: 0, load: 0, probe: 0, host: 0 };
    const freshDiscarded = await headlessHarness(
      ['run', '--session', secondId, '--discard-uncertain'],
      {
        sessionsDir,
        readStdin: async () => {
          freshCalls.stdin += 1;
          return 'must not read';
        },
        loadModule: async () => {
          freshCalls.load += 1;
          throw new Error('must not import');
        },
        probeAdapterSdk: async () => {
          freshCalls.probe += 1;
          return false;
        },
        createHostRuntime: async () => {
          freshCalls.host += 1;
          throw new Error('must not host');
        },
      },
    );
    expect(freshDiscarded.result.code).toBe(0);
    expect(freshDiscarded.stdout).toBe('');
    expect(freshCalls).toEqual({ stdin: 0, load: 0, probe: 0, host: 0 });
    expect(
      JSON.parse(
        await readFile(join(sessionsDir, `${secondId}.json`), 'utf8'),
      ),
    ).toMatchObject({
      state: 'settled',
      snapshot: { sequences: { turn: 0 } },
      retainedGenerations: {},
    });

    const settledTurnZero = JSON.parse(
      await readFile(join(sessionsDir, `${secondId}.json`), 'utf8'),
    );
    const {
      retainedGenerations: _retainedGenerations,
      ...legacyNeverSettled
    } = settledTurnZero;
    const legacyMarkedAt = '2026-08-11T20:59:00.000Z';
    const legacyPath = join(sessionsDir, `${fourthId}.json`);
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        ...legacyNeverSettled,
        state: 'uncertain',
        sessionId: fourthId,
        createdAt: legacyMarkedAt,
        updatedAt: legacyMarkedAt,
        uncertain: {
          baseUpdatedAt: null,
          input: 'legacy never-settled turn',
          attemptId: thirdId,
          attemptNumber: 1,
          markedAt: legacyMarkedAt,
          attemptedExecutionProjection:
            settledTurnZero.lastAppliedExecutionProjection,
        },
      })}\n`,
      { mode: 0o600 },
    );
    const legacyCalls = { stdin: 0, load: 0, probe: 0, host: 0 };
    const legacyDiscarded = await headlessHarness(
      ['run', '--session', fourthId, '--discard-uncertain'],
      {
        sessionsDir,
        readStdin: async () => {
          legacyCalls.stdin += 1;
          return 'must not read';
        },
        loadModule: async () => {
          legacyCalls.load += 1;
          throw new Error('must not import');
        },
        probeAdapterSdk: async () => {
          legacyCalls.probe += 1;
          return false;
        },
        createHostRuntime: async () => {
          legacyCalls.host += 1;
          throw new Error('must not host');
        },
      },
    );
    expect(legacyDiscarded.result.code).toBe(0);
    expect(legacyDiscarded.stdout).toBe('');
    expect(legacyCalls).toEqual({ stdin: 0, load: 0, probe: 0, host: 0 });
    await expect(readFile(legacyPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a concurrent writer while the first turn owns the session lease', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-exclusive-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    let announceEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      announceEntered = resolve;
    });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const first = headlessHarness(['run', 'first writer'], {
      sessionsDir,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
      createHostRuntime: async (options: any) => {
        const host = await createTmuxPlayRuntime(options);
        return {
          async runBossTurn(input: string) {
            announceEntered();
            await blocked;
            await host.runBossTurn(input);
          },
          dispose: () => host.dispose(),
        };
      },
    });
    await entered;

    let secondHosts = 0;
    const second = await headlessHarness(
      ['run', '--session', firstId, 'second writer'],
      {
        sessionsDir,
        createHostRuntime: async () => {
          secondHosts += 1;
          throw new Error('concurrent host must not start');
        },
      },
    );
    expect(second.result.code).toBe(1);
    expect(second.stdout).toBe('');
    expect(secondHosts).toBe(0);
    expect(second.stderr).toMatch(/lease|locked|active|owner/i);

    unblock();
    expect((await first).result.code).toBe(0);
  });

  it('aborts a signaled turn, preserves uncertainty, retires ownership, and lets a second signal escape', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-signal-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const configPath = await writeConfig(sharedConfig());
    const entries = nestedEntries([]);
    const modules: Record<string, unknown> = {
      'mod://code': { default: entries.code },
      'mod://review': { default: entries.review },
    };
    const processLike = new EventEmitter() as any;
    processLike.argv = ['node', 'playbook', 'run', 'signal me'];
    processLike.pid = 4242;
    const killed: string[] = [];
    processLike.kill = (_pid: number, signal: string) => {
      killed.push(signal);
    };
    let announceTurn!: () => void;
    const turnEntered = new Promise<void>((resolve) => {
      announceTurn = resolve;
    });
    const stdout = writer();
    const stderr = writer();
    const pending = runPlaybookCliEntry({
      processLike,
      argv: ['run', 'signal me'],
      userConfigPath: configPath,
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      loadModule: async (specifier: string) => modules[specifier],
      adapterImports,
      createCaptainRuntime: scriptedCaptainRuntime([]),
      createLogicalSessionId: () => firstId,
      createCaptainSessionId: uuidSequence(),
      createAttemptId: () => secondId,
      probeAdapterSdk: async () => true,
      sessionsDir,
      stdout,
      stderr,
      createHostRuntime: async (options: any) => {
        // Deliberately omit the external signal from the underlying host to
        // prove the CLI's post-turn boundary still withholds settlement.
        const host = await createTmuxPlayRuntime({
          ...options,
          signal: undefined,
        });
        return {
          async runBossTurn(input: string) {
            announceTurn();
            await new Promise<void>((resolve) => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            await host.runBossTurn(input);
          },
          dispose: () => host.dispose(),
        };
      },
    });
    await turnEntered;
    processLike.emit('SIGTERM');
    expect(await pending).toEqual({ signal: 'SIGTERM' });
    expect(stdout.text()).toBe('');
    expect(killed).toEqual([]);
    expect(processLike.listenerCount('SIGTERM')).toBe(0);
    const record = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(record.state).toBe('uncertain');
    const store = createCaptainSessionStore({ sessionsDir });
    const lease = await store.acquire(firstId);
    expect((await lease.read())?.state).toBe('uncertain');
    await lease.release();

    const stalledProcess = new EventEmitter() as any;
    stalledProcess.argv = ['node', 'playbook', 'run'];
    stalledProcess.pid = 4343;
    const secondKills: string[] = [];
    stalledProcess.kill = (_pid: number, signal: string) => {
      secondKills.push(signal);
    };
    const stalled = runPlaybookCliEntry({
      processLike: stalledProcess,
      argv: ['run'],
      readStdin: () => new Promise(() => {}),
      stdout: writer(),
      stderr: writer(),
    });
    stalledProcess.emit('SIGINT');
    stalledProcess.emit('SIGHUP');
    expect(secondKills).toEqual(['SIGHUP']);
    expect(await stalled).toEqual({ signal: 'SIGINT' });
  });

  it('withholds stdout when a signal arrives during atomic settlement', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-late-signal-'));
    tempDirs.push(stateRoot);
    const sessionsDir = join(stateRoot, 'sessions');
    const controller = new AbortController();
    const baseStore = createCaptainSessionStore({ sessionsDir });
    const sessionStore = {
      ...baseStore,
      async acquire(sessionId: string) {
        const lease = await baseStore.acquire(sessionId);
        return {
          ...lease,
          async settle(value: any) {
            const record = await lease.settle(value);
            controller.abort(new Error('synthetic late SIGTERM'));
            return record;
          },
        };
      },
    };
    const out = await headlessHarness(['run', 'settle then signal'], {
      sessionsDir,
      sessionStore,
      signal: controller.signal,
      createLogicalSessionId: () => firstId,
      createAttemptId: () => secondId,
    });
    expect(out.result.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('reply withheld');
    expect(
      JSON.parse(
        await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
      ).state,
    ).toBe('settled');
    const probe = await baseStore.acquire(firstId);
    await probe.release();
  });

  it('rejects an unrestorable or id-colliding record before host or agent work', async () => {
    const first = await headlessHarness(['run', 'hello'], {
      createLogicalSessionId: () => firstId,
    });
    expect(first.result.code).toBe(0);
    const originalPath = join(first.sessionsDir, `${firstId}.json`);
    const record = JSON.parse(await readFile(originalPath, 'utf8'));
    const internalId = record.snapshot.captain.sessionId;
    record.sessionId = internalId;
    await writeFile(
      join(first.sessionsDir, `${internalId}.json`),
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );
    let hosts = 0;
    const rejected = await headlessHarness(
      ['run', '--session', internalId, 'must not run'],
      {
        sessionsDir: first.sessionsDir,
        createHostRuntime: async () => {
          hosts += 1;
          throw new Error('must not construct host');
        },
      },
    );
    expect(rejected.result.code).toBe(1);
    expect(rejected.stdout).toBe('');
    expect(rejected.stderr).toContain('collides with an internal Captain session id');
    expect(hosts).toBe(0);
    expect(rejected.inputs).toEqual([]);

    const pathShaped = JSON.parse(await readFile(originalPath, 'utf8'));
    pathShaped.sessionId = secondId;
    pathShaped.structuralProjection.catalog.code.from = '../rewired.js';
    pathShaped.lastAppliedExecutionProjection.catalog.code.from = '../rewired.js';
    await writeFile(
      join(first.sessionsDir, `${secondId}.json`),
      `${JSON.stringify(pathShaped)}\n`,
      { mode: 0o600 },
    );
    const unsafe = await headlessHarness(
      ['run', '--session', secondId, 'must not run'],
      { sessionsDir: first.sessionsDir },
    );
    expect(unsafe.result.code).toBe(1);
    expect(unsafe.stdout).toBe('');
    expect(unsafe.stderr).toContain('must be a canonical module specifier');
    expect(unsafe.inputs).toEqual([]);

    const malformedRecord = JSON.parse(await readFile(originalPath, 'utf8'));
    malformedRecord.sessionId = thirdId;
    malformedRecord.snapshot.mode = 'corrupt';
    await writeFile(
      join(first.sessionsDir, `${thirdId}.json`),
      `${JSON.stringify(malformedRecord)}\n`,
      { mode: 0o600 },
    );
    const malformed = await headlessHarness(
      ['run', '--session', thirdId, 'must not run'],
      { sessionsDir: first.sessionsDir },
    );
    expect(malformed.result.code).toBe(1);
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toContain('snapshot.mode');
    expect(malformed.inputs).toEqual([]);
  });

  it('parses only the two explicit continuation selectors', () => {
    expect(parseRunArgs(['--continue', 'yes'])).toMatchObject({
      continue: true,
      input: 'yes',
    });
    expect(parseRunArgs([`--session=${firstId}`, 'yes'])).toMatchObject({
      sessionId: firstId,
      input: 'yes',
    });
    expect(() =>
      parseRunArgs(['--continue', '--session', firstId, 'yes']),
    ).toThrow(/mutually exclusive/);
    expect(parseRunArgs(['--continue', '--with', 'x', 'yes'])).toMatchObject({
      continue: true,
      withPaths: ['x'],
      input: 'yes',
    });
    expect(() => parseRunArgs(['--session', '../escape', 'yes']))
      .toThrow(/canonical UUID/);
    expect(parseRunArgs(['--', '--continue'])).toMatchObject({
      continue: false,
      input: '--continue',
    });
    expect(
      parseRunArgs(['--session', firstId, '--retry-uncertain']),
    ).toMatchObject({
      sessionId: firstId,
      retryUncertain: true,
      input: undefined,
    });
    expect(
      parseRunArgs(['--session', firstId, '--discard-uncertain']),
    ).toMatchObject({
      sessionId: firstId,
      discardUncertain: true,
      input: undefined,
    });
    expect(() => parseRunArgs(['--retry-uncertain'])).toThrow(
      /require --session/,
    );
    expect(() =>
      parseRunArgs(['--session', firstId, '--retry-uncertain', 'input']),
    ).toThrow(/no input/);
    expect(() =>
      parseRunArgs([
        '--session',
        firstId,
        '--retry-uncertain',
        '--with',
        'x',
      ]),
    ).toThrow(/unavailable during uncertain-turn recovery/);
    expect(() =>
      parseRunArgs([
        '--session',
        firstId,
        '--retry-uncertain',
        '--discard-uncertain',
      ]),
    ).toThrow(/mutually exclusive/);
    for (const inert of ['--json', '--verbose', '--no-provision']) {
      expect(() =>
        parseRunArgs([
          '--session',
          firstId,
          '--discard-uncertain',
          inert,
        ]),
      ).toThrow(/does not accept/);
    }
  });
});

function classifyMissing(
  target: RuntimeTarget,
  available: boolean,
): RuntimeReadiness {
  return {
    state: available ? 'unknown' : 'missing',
    target,
    repair: { spec: target.repairSpec, steps: target.steps ?? [] },
  };
}

const ENGINE_REGISTRY = `import 'xstate';
import '@sublang/playbook/xstate-runtime';
const active = {
  value: 'ready', activeStateIds: ['ready'], tags: ['playbook.parked'],
  status: 'active', quiescent: true, stateId: 'ready'
};
export default {
  id: 'fixture', command: 'fixture', intent: 'filesystem fixture',
  artifactSchema: 3,
  runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
  requiredRoleIds: [], validateOptions(value) { return value; },
  concurrentRoleSets: [],
  createRuntime() {
    return {
      async init() {},
      async handleBossInput() {
        return {
          outcome: 'terminal',
          state: { ...active, tags: [], status: 'done' },
          output: 'done'
        };
      },
      async resumePlaybookCall() { return { outcome: 'no-action', state: active }; },
      async dispose() {}
    };
  }
};
`;

async function syntheticRoots() {
  const root = await mkdtemp(join(tmpdir(), 'playbook-host-roots-'));
  tempDirs.push(root);
  const xstate = join(root, 'xstate');
  const playbook = join(root, 'playbook');
  await mkdir(xstate, { recursive: true });
  await mkdir(playbook, { recursive: true });
  await writeFile(
    join(xstate, 'package.json'),
    JSON.stringify({ name: 'xstate', version: '0.0.0', main: 'index.js' }),
  );
  await writeFile(join(xstate, 'index.js'), 'module.exports = {};\n');
  await writeFile(
    join(playbook, 'package.json'),
    JSON.stringify({
      name: '@sublang/playbook',
      version: '0.0.0',
      type: 'module',
      exports: { './xstate-runtime': './xstate-runtime.js' },
    }),
  );
  await writeFile(join(playbook, 'xstate-runtime.js'), 'export const ok = true;\n');
  return { xstate, '@sublang/playbook': playbook };
}

async function filesystemConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-filesystem-config-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'registry.mjs'), ENGINE_REGISTRY, 'utf8');
  const configPath = join(dir, 'playbook.config.yaml');
  await writeFile(
    configPath,
    [
      'captain: claude',
      'players: {}',
      'playbooks:',
      '  fixture:',
      '    from: ./registry.mjs',
      '    roles: {}',
      '',
    ].join('\n'),
  );
  return { dir, configPath };
}

describe('configured engine provisioning parity (PBCLI-38/48)', () => {
  it('prepares filesystem registries for interactive and headless front ends', async () => {
    const roots = await syntheticRoots();
    const interactive = await filesystemConfig();
    const headless = await filesystemConfig();
    const interactiveErr = writer();
    const spawnCalls: unknown[] = [];
    const spawn = () => {
      spawnCalls.push(true);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    const interactiveStateRoot = await mkdtemp(
      join(tmpdir(), 'playbook-engine-interactive-state-'),
    );
    tempDirs.push(interactiveStateRoot);
    const launched = await runPlaybookCli({
      argv: [],
      userConfigPath: interactive.configPath,
      env: { ANTHROPIC_API_KEY: 'a' },
      hostRoots: roots,
      sessionsDir: join(interactiveStateRoot, 'sessions'),
      probeAdapterSdk: async () => true,
      tmuxPlayBin: '/tmp/tmux-play.js',
      spawn,
      createLogicalSessionId: () =>
        '90000000-0000-4000-8000-000000000001',
      launchManagedTmuxPlay: async (options: any) => {
        spawnCalls.push(true);
        const workDir = await mkdtemp(
          join(tmpdir(), 'playbook-engine-managed-work-'),
        );
        const coordinationDir = await mkdtemp(
          join(tmpdir(), 'playbook-engine-managed-coordination-'),
        );
        tempDirs.push(workDir, coordinationDir);
        await options.createSessionCommand({
          sessionId: options.sessionId,
          cwd: options.cwd,
          workDir,
          workDirOwnedByLauncher: true,
          readinessPath: join(coordinationDir, 'status.json'),
          inputGatePath: join(coordinationDir, 'input-ready'),
          inputActivePath: join(coordinationDir, 'input-active'),
          shutdownRequestPath: join(coordinationDir, 'shutdown-request'),
          shutdownCompletePath: join(coordinationDir, 'shutdown-complete'),
        });
        return {
          sessionId: options.sessionId,
          workDir,
          async attach() {},
          async cancel() {},
        };
      },
      publishManagedReadinessWitness: async () => {},
      stdout: writer(),
      stderr: interactiveErr,
    });
    expect(launched.code, interactiveErr.text()).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(interactiveErr.text()).toContain('playbook: provisioned');

    const headlessErr = writer();
    const inputs: string[] = [];
    const stateRoot = await mkdtemp(join(tmpdir(), 'playbook-engine-state-'));
    tempDirs.push(stateRoot);
    const ran = await runPlaybookCli({
      argv: ['run', '/fixture work'],
      userConfigPath: headless.configPath,
      env: { ANTHROPIC_API_KEY: 'a' },
      hostRoots: roots,
      probeAdapterSdk: async () => true,
      adapterImports,
      createCaptainRuntime: scriptedCaptainRuntime(inputs),
      createCaptainSessionId: uuidSequence(),
      createLogicalSessionId: () =>
        '90000000-0000-4000-8000-000000000002',
      sessionsDir: join(stateRoot, 'sessions'),
      stdout: writer(),
      stderr: headlessErr,
    });
    expect(ran.code).toBe(0);
    expect(inputs).toEqual(['/fixture work']);
    expect(headlessErr.text()).toContain('playbook run: provisioned');

    for (const fixture of [interactive, headless]) {
      expect(await readlink(join(fixture.dir, 'node_modules', 'xstate')))
        .toBe(roots.xstate);
      expect(
        await readlink(
          join(fixture.dir, 'node_modules', '@sublang', 'playbook'),
        ),
      ).toBe(roots['@sublang/playbook']);
    }
  });
});


describe('portable CLI provider hints', () => {
  it.each(['missing', 'rejected', 'ambiguous'] as const)(
    'continues a saved Captain with a %s local hint safely', async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'playbook-cli-hints-'));
      tempDirs.push(root);
      const sessionsDir = join(root, 'sessions');
      const id = '95000000-0000-4000-8000-000000000011';
      const initial = await headlessHarness(['run', 'remember the original task'], {
        sessionsDir, createLogicalSessionId: () => id, createCaptainRuntime: undefined,
      });
      expect(initial.result.code, initial.stderr).toBe(0);
      const hintPath = join(sessionsDir, `${id}.hints.json`);
      const hints = JSON.parse(await readFile(hintPath, 'utf8'));
      expect(hints.captain.kind).toBe('pinned');
      const priorRecords = await readReplayEntries(sessionsDir, id);
      if (mode === 'missing') await rm(hintPath);
      else FakeAdapter.failure = mode;
      const callOffset = FakeAdapter.calls.length;
      const continued = await headlessHarness(['run', '--session', id, 'continue safely'], {
        sessionsDir, userConfigPath: initial.configPath, createCaptainRuntime: undefined,
      });
      expect(continued.result.code, continued.stderr).toBe(0);
      const calls = FakeAdapter.calls.slice(callOffset);
      expect(calls.map(({ resume }) => resume)).toEqual(
        mode === 'missing' ? [undefined] : mode === 'rejected' ? [hints.captain.token, undefined] : [hints.captain.token],
      );
      if (mode !== 'ambiguous') expect(calls.at(-1)?.prompt).toContain('remember the original task');
      const manifest = JSON.parse(await readFile(join(sessionsDir, `${id}.json`), 'utf8'));
      expect(manifest.schemaVersion).toBe(7);
      expect(manifest.snapshot.captain.conversation).toEqual({ kind: 'needsSeeding' });
      expect(JSON.stringify(manifest)).not.toContain(hints.captain.token);
      const resets = (await readReplayEntries(sessionsDir, id)).slice(priorRecords.length)
        .filter(({ record }: any) => record.type === 'continuity_reset').map(({ record }: any) => ({ participantId: record.participantId, reason: record.reason }));
      expect(resets).toEqual(mode === 'ambiguous' ? [] : [{ participantId: 'captain', reason: `${mode}_hint` }]);
    },
  );
});
