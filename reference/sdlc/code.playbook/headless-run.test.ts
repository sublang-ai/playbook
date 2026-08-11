// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
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
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PlaybookCallResult,
  PlaybookRuntime,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
} from '../../../src/runtime.js';

const { runPlaybookCli } = await import(
  new URL('./bin/playbook.js', import.meta.url).href
);
const { parseRunArgs } = await import(
  new URL('./bin/run.js', import.meta.url).href
);

const tempDirs: string[] = [];

afterEach(async () => {
  FakeAdapter.calls = [];
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
  readonly agent = 'claude-code';

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    FakeAdapter.calls.push({ prompt, resume: options?.resume });
    const result = prompt.includes(
      'Select exactly one action from the closed set',
    )
      ? JSON.stringify({
          action: 'respond',
          text: 'Shipped Captain answered the Boss.',
        })
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
        usage: { inputTokens: 1, outputTokens: 1, toolUses: 0 },
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
    schemaVersion: 2,
    playbookId,
    machine: { value: state.value, status: state.status },
    playerResumeTokens: {},
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
) {
  return ({ controller }: any): PlaybookRuntime => {
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
        return runtimeSnapshot('captain', turns);
      },
      async handleBossInput({ text, signal }) {
        turns += 1;
        inputs.push(text);
        await session.ports.emitTelemetry({
          topic: 'fixture.captain',
          payload: { turn: turns },
        });
        const parsed = controller.resolveParsedTurn(text);
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
    requiredRoleIds: ['coder'],
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
    requiredRoleIds: ['coder', 'reviewer'],
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
    'playbooks:',
    '  code:',
    '    from: mod://code',
    '    players:',
    '      coder: { adapter: claude, model: coder-model }',
    '  review:',
    '    from: mod://review',
    '    players:',
    '      coder: { adapter: claude, model: review-coder-fallback }',
    '      reviewer: { adapter: codex, model: reviewer-model }',
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
    expect(out.result.snapshot).toMatchObject({
      mode: 'chat',
      sequences: { turn: 1 },
    });
    expect(out.result.sessionId).not.toBe(
      out.result.snapshot.captain.sessionId,
    );
    expect(out.result.config).toMatchObject({
      captain: { model: 'captain-model' },
      players: [
        { id: 'code-coder', model: 'coder-model' },
        { id: 'review-coder', model: 'review-coder-fallback' },
        { id: 'review-reviewer', model: 'reviewer-model' },
      ],
      catalog: {
        code: { id: 'code', command: 'code' },
        review: { id: 'review', command: 'review' },
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
    const setup = await headlessHarness(['run', 'hello'], {
      createHostRuntime: async () => {
        throw new Error('synthetic host init failed');
      },
    });
    expect(setup.result.code).toBe(1);
    expect(setup.stdout).toBe('');
    expect(setup.stderr).toContain('synthetic host init failed');

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
    expect(stderr.text()).toContain('playbooks.<id>.players');
  });

  it('rejects invalid shared agent config before prepare, import, or host creation', async () => {
    const configPath = await writeConfig(
      [
        'captain: { adapter: claude, model: { invalid: true } }',
        'playbooks:',
        '  code:',
        '    from: mod://code',
        '    players: { coder: codex }',
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
  requiredRoleIds: [], validateOptions(value) { return value; },
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
      'playbooks:',
      '  fixture:',
      '    from: ./registry.mjs',
      '    players: { worker: claude }',
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
      stdout: writer(),
      stderr: interactiveErr,
    });
    expect(launched.code).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(interactiveErr.text()).toContain('playbook: provisioned');

    const headlessErr = writer();
    const inputs: string[] = [];
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
