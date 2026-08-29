// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import {
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
import { join } from 'node:path';
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
import { afterEach, describe, expect, it } from 'vitest';
import { captainMachine } from '../captain.playbook/captain.fsm.js';
import type {
  PlaybookCallResult,
  PlaybookRuntime,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
} from '../../../src/runtime.js';

const { runPlaybookCli, runPlaybookCliEntry } = await import(
  new URL('./bin/playbook.js', import.meta.url).href
);
const { installRetainedGenerationsForLaunch, parseRunArgs } = await import(
  new URL('./bin/run.js', import.meta.url).href
);
const { createCaptainSessionStore } = await import(
  new URL('./bin/session-store.js', import.meta.url).href
);

const tempDirs: string[] = [];

afterEach(async () => {
  FakeAdapter.calls = [];
  FakeAdapter.options = [];
  FakeAdapter.decision = undefined;
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
  static decision: ((prompt: string) => unknown) | undefined;
  readonly agent = 'claude-code';

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    FakeAdapter.calls.push({ prompt, resume: options?.resume });
    FakeAdapter.options.push(options);
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
    schemaVersion: 3,
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
  };
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
    artifactSchema: 2 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 2 } as const,
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
    artifactSchema: 2 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 2 } as const,
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
    artifactSchema: 2 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 2 } as const,
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
            schemaVersion: 3,
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
    artifactSchema: 2 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 2 } as const,
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
            schemaVersion: 3,
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
    artifactSchema: 2 as const,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 2 } as const,
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
            schemaVersion: 3,
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

async function headlessHarness(
  argv: string[],
  extra: Record<string, unknown> = {},
) {
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
    'mod://code': { default: entries.code },
    'mod://review': { default: entries.review },
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
    sessionsDir,
    stdout,
    stderr,
    spawn: () => {
      throw new Error('headless run must not spawn tmux-play');
    },
    ...extra,
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
    await expect(readFile(join(home, '.config', 'playbook', 'playbook.config.yaml')))
      .rejects.toThrow();

    let fallbackReads = 0;
    const empty = await headlessHarness(['run', '   '], {
      readStdin: async () => {
        fallbackReads += 1;
        return 'fallback';
      },
    });
    expect(empty.result.code).toBe(1);
    expect(fallbackReads).toBe(0);
    expect(empty.stdout).toBe('');
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
          compat: { artifactSchema: 2, runtimeAbi: 999 },
          snapshotOptions: () => ({}),
          machineInput: () => ({ enabledPlaybooks: [] }),
          roleStates: {},
        })({}),
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
    const result = await runPlaybookCli({
      argv: ['run', 'hello'],
      userConfigPath: configPath,
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
    const result = await runPlaybookCli({
      argv: ['run', 'hello'],
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

  it('persists a closed v3 record before stdout without semantic disposal', async () => {
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
      schemaVersion: 3,
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
      snapshot: { schemaVersion: 3, mode: 'chat' },
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
    const frozenCwd = await mkdtemp(join(tmpdir(), 'playbook-frozen-cwd-'));
    tempDirs.push(stateRoot, frozenCwd);
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
    const entries = nestedParkedEntries(events, lifecycle);
    entries.review.validateOptions = () => ({ normalizedByRegistry: true });
    const captainRuntime = scriptedCaptainRuntime([], { action: 'deliver' });
    const loadModule = async (specifier: string) => ({
      default: specifier === 'mod://code' ? entries.code : entries.review,
    });

    const first = await headlessHarness(['run', '/code inspect it'], {
      sessionsDir,
      loadModule,
      createCaptainRuntime: captainRuntime,
      createLogicalSessionId: () => firstId,
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

    const exactReply = '  exact review reply\nwith context\n';
    const second = await headlessHarness(
      ['run', '--session', firstId],
      {
        sessionsDir,
        loadModule,
        createCaptainRuntime: captainRuntime,
        readStdin: async () => exactReply,
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
    expect(second.stderr).not.toContain('/review called by /code');
    const settled = JSON.parse(
      await readFile(join(sessionsDir, `${firstId}.json`), 'utf8'),
    );
    expect(settled.snapshot.mode).toBe('chat');
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

  it('selects the newest valid same-cwd session by updatedAt for --continue', async () => {
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
    const {
      retainedGenerations: _retainedGenerations,
      ...memberlessSchema3
    } = settledRecord;
    await writeFile(
      memberlessSchema3Path,
      `${JSON.stringify({
        ...memberlessSchema3,
        schemaVersion: 3,
        sessionId: fourthId,
      })}\n`,
      { mode: 0o600 },
    );
    const memberlessInstalls: unknown[] = [];
    const observeMemberlessInstall = async (options: any) => {
      memberlessInstalls.push(options.retainedGenerations);
      return installRetainedGenerationsForLaunch(options);
    };

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
        installRetainedGenerationsForLaunch: observeMemberlessInstall,
      },
    );
    expect(continued.result.code).toBe(0);
    expect(continued.result.sessionId).toBe(fourthId);
    expect(continued.inputs).toEqual(['latest reply']);
    expect(memberlessInstalls).toEqual([{}]);
    expect(continued.stderr).toContain(
      `skipping legacy Captain session "${thirdId}" at "${legacyPath}"`,
    );
    expect(continued.stderr).toContain(
      'schema 2 has incompatible player identity',
    );
    expect(continued.stderr).not.toContain(
      `skipping legacy Captain session "${fourthId}"`,
    );
    expect(continued.stderr).toContain(
      'move it outside the sessions directory or remove it',
    );
    const canonicalized = JSON.parse(
      await readFile(memberlessSchema3Path, 'utf8'),
    );
    expect(canonicalized).toMatchObject({
      schemaVersion: 3,
      retainedGenerations: {},
    });
    const {
      retainedGenerations: _canonicalRetainedGenerations,
      ...memberlessAgain
    } = canonicalized;
    await writeFile(
      memberlessSchema3Path,
      `${JSON.stringify(memberlessAgain)}\n`,
      'utf8',
    );

    const explicitCompatible = await headlessHarness(
      ['run', '--session', fourthId, 'member-less reply'],
      {
        sessionsDir,
        now: () => new Date('2026-08-11T20:20:03.000Z'),
        installRetainedGenerationsForLaunch: observeMemberlessInstall,
      },
    );
    expect(explicitCompatible.result.code).toBe(0);
    expect(explicitCompatible.result.sessionId).toBe(fourthId);
    expect(explicitCompatible.inputs).toEqual(['member-less reply']);
    expect(memberlessInstalls).toEqual([{}, {}]);
    expect(explicitCompatible.stderr).not.toContain(
      'no retained-generation state',
    );

    const transientSchema4 = JSON.parse(
      await readFile(memberlessSchema3Path, 'utf8'),
    );
    await writeFile(
      memberlessSchema3Path,
      `${JSON.stringify({ ...transientSchema4, schemaVersion: 4 })}\n`,
      'utf8',
    );
    const continuedSchema4 = await headlessHarness(
      ['run', '--session', fourthId, 'schema-4 reply'],
      {
        sessionsDir,
        now: () => new Date('2026-08-11T20:20:04.000Z'),
      },
    );
    expect(continuedSchema4.result.code).toBe(0);
    expect(continuedSchema4.result.sessionId).toBe(fourthId);
    expect(continuedSchema4.inputs).toEqual(['schema-4 reply']);
    expect(continuedSchema4.stderr).not.toContain('schema 4 is unsupported');
    expect(
      JSON.parse(await readFile(memberlessSchema3Path, 'utf8')),
    ).toMatchObject({ schemaVersion: 3, retainedGenerations: {} });
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
        'runtime snapshot schemaVersion 1 has incompatible player identity',
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
        'runtime snapshot schemaVersion 2 has incompatible player identity',
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
      artifactSchema: 2 as const,
      runtimeProfile: { kind: 'bespoke', artifactSchema: 2 } as const,
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
        'captain: { model: captain-B }',
        'players:',
        '  dev.coder: { model: coder-B }',
        '  dev.reviewer: { model: reviewer-B }',
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
      captainConfig: { model: 'captain-B' },
      players: [
        { id: 'dev.coder', model: 'coder-B' },
        { id: 'dev.reviewer', model: 'reviewer-B' },
      ],
    });
    expect(markerB.lastAppliedExecutionProjection).toEqual(baselineA);
    expect(markerB.uncertain).toMatchObject({
      input: attemptedInput,
      attemptId: secondId,
      attemptNumber: 1,
      attemptedExecutionProjection: {
        captain: { model: { kind: 'value', value: 'captain-B' } },
        players: [
          {
            id: 'dev.coder',
            model: { kind: 'value', value: 'coder-B' },
          },
          {
            id: 'dev.reviewer',
            model: { kind: 'value', value: 'reviewer-B' },
          },
        ],
      },
    });
    const attemptedB = markerB.uncertain.attemptedExecutionProjection;
    expect(attemptedB).not.toEqual(baselineA);

    const configC = await writeConfig(
      sharedConfig()
        .replace('captain-model', 'captain-C')
        .replace('coder-model', 'coder-C')
        .replace('reviewer-model', 'reviewer-C'),
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
      captainConfig: { model: 'captain-B' },
      players: [
        { id: 'dev.coder', model: 'coder-B' },
        { id: 'dev.reviewer', model: 'reviewer-B' },
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
  artifactSchema: 2,
  runtimeProfile: { kind: 'bespoke', artifactSchema: 2 },
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
    const launched = await runPlaybookCli({
      argv: [],
      userConfigPath: interactive.configPath,
      env: { ANTHROPIC_API_KEY: 'a' },
      hostRoots: roots,
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
    expect(launched.code).toBe(0);
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
