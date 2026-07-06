// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTmuxPlayConfig } from '@sublang/cligent/tmux-play';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const playbook = await import(
  new URL('./bin/playbook.js', import.meta.url).href
);

const {
  runPlaybookCli,
  resolveUserConfigPath,
  composeGenericConfig,
  PLAYBOOK_CAPTAIN_MODULE,
} = playbook;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const fakeEntry = {
  id: 'code',
  command: 'code',
  intent: 'software development / SDLC coding workflow',
  requiredRoleIds: ['coder', 'reviewer'],
  idleStateId: 'ready',
  finalStateId: 'done',
  parkStateIds: ['failed', 'awaitBossReply'],
  validateOptions: () => ({}),
  createRuntime: () => ({}),
};

function loader(modules: Record<string, unknown>) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier in modules) return modules[specifier];
    throw new Error(`no module ${specifier}`);
  };
}

describe('playbook launcher — composition (PBCLI-14)', () => {
  it('normalizes profiles/playbooks into a composed tmux-play config', async () => {
    const top = {
      profiles: {
        judge: { adapter: 'claude', model: 'm-judge' },
        agent: { adapter: 'codex', model: 'm-agent' },
      },
      captain: 'judge',
      layout: { window: { width: 100, height: 40 } },
      notifications: { player_finished: 'bell', turn_finished: 'desktop' },
      theme: { accent: 'cyan' },
      playbooks: {
        code: {
          from: 'mod://code',
          players: { coder: 'agent', reviewer: { adapter: 'claude' } },
          committer: 'coder',
        },
      },
    };
    const { config, playbooks } = await composeGenericConfig(
      top,
      loader({ 'mod://code': { default: fakeEntry } }),
    );

    expect(config.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(config.captain).toMatchObject({ adapter: 'claude', model: 'm-judge' });
    // Option slice carries non-launcher keys (committer); no from/players.
    expect(config.captain.options.playbooks.code).toEqual({
      from: 'mod://code',
      options: { committer: 'coder' },
    });
    // Namespaced <id>-<role> roster; scalar profile + full block resolved.
    expect(config.players).toEqual([
      { id: 'code-coder', adapter: 'codex', model: 'm-agent' },
      { id: 'code-reviewer', adapter: 'claude' },
    ]);
    // Launcher owns initialVisible (first playbook's generated players);
    // user window field carried through.
    expect(config.layout).toEqual({
      window: { width: 100, height: 40 },
      initialVisible: ['code-coder', 'code-reviewer'],
    });
    // Top-level host fields (notifications, theme) carried through unchanged.
    expect(config.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
    });
    expect(config.theme).toEqual({ accent: 'cyan' });
    expect(playbooks).toEqual([
      { id: 'code', command: 'code', intent: fakeEntry.intent },
    ]);
  });

  it('applies a command override and a full-block profile reference', async () => {
    const top = {
      profiles: { base: { adapter: 'claude', model: 'm' } },
      captain: { profile: 'base', reasoningEffort: 'high' },
      playbooks: {
        code: {
          from: 'mod://code',
          command: 'dev',
          players: { coder: 'claude', reviewer: 'codex' },
        },
      },
    };
    const { config, playbooks } = await composeGenericConfig(
      top,
      loader({ 'mod://code': { default: fakeEntry } }),
    );
    // Profile is the base; block fields override; no `profile` key emitted.
    expect(config.captain).toMatchObject({
      adapter: 'claude',
      model: 'm',
      reasoningEffort: 'high',
    });
    expect(config.captain).not.toHaveProperty('profile');
    expect(config.captain.options.playbooks.code.command).toBe('dev');
    expect(playbooks[0].command).toBe('dev');
  });
});

describe('playbook launcher — validation (PBCLI-15)', () => {
  // A compiler-phase playbook whose linked runtime binds its sole player as
  // `captain` — the reserved-role fault of PBCLI-9.
  const captainRoleEntry = {
    ...fakeEntry,
    id: 't2g',
    command: 't2g',
    intent: 'compile text into GEARS items',
    requiredRoleIds: ['captain'],
  };
  const ld = loader({
    'mod://code': { default: fakeEntry },
    'mod://invalid': { default: { id: 'code' } },
    'mod://t2g': { default: captainRoleEntry },
  });
  const players = { coder: 'claude', reviewer: 'codex' };

  it('rejects each enablement fault', async () => {
    await expect(
      composeGenericConfig({ captain: 'claude', playbooks: {} }, ld),
    ).rejects.toThrow(/at least one playbook/);
    await expect(
      composeGenericConfig(
        { captain: 'claude', playbooks: { code: { players } } },
        ld,
      ),
    ).rejects.toThrow(/from must be a module specifier/);
    await expect(
      composeGenericConfig(
        { captain: 'claude', playbooks: { code: { from: 'mod://x', players } } },
        ld,
      ),
    ).rejects.toThrow(/failed to import/);
    await expect(
      composeGenericConfig(
        {
          captain: 'claude',
          playbooks: { code: { from: 'mod://invalid', players } },
        },
        ld,
      ),
    ).rejects.toThrow(/no valid registry entry/);
    await expect(
      composeGenericConfig(
        { captain: 'claude', playbooks: { foo: { from: 'mod://code', players } } },
        ld,
      ),
    ).rejects.toThrow(/manifest id/);
    await expect(
      composeGenericConfig(
        {
          captain: 'claude',
          playbooks: { code: { from: 'mod://code', players: { coder: 'claude' } } },
        },
        ld,
      ),
    ).rejects.toThrow(/required role "reviewer"/);
    await expect(
      composeGenericConfig(
        { captain: 'claude', playbooks: { code: { from: 'mod://code', players: {} } } },
        ld,
      ),
    ).rejects.toThrow(/no visible local role/);
    await expect(
      composeGenericConfig(
        {
          profiles: { claude: { adapter: 'claude' } },
          captain: 'claude',
          playbooks: { code: { from: 'mod://code', players } },
        },
        ld,
      ),
    ).rejects.toThrow(/collides with the "claude" adapter shorthand/);
  });

  it('rejects the reserved captain role with a diagnostic naming it', async () => {
    // Manifest fault: the entry itself requires the reserved role, so the
    // diagnostic names it even though the players map satisfies coverage.
    await expect(
      composeGenericConfig(
        {
          captain: 'claude',
          playbooks: {
            t2g: { from: 'mod://t2g', players: { captain: 'claude' } },
          },
        },
        ld,
      ),
    ).rejects.toThrow(
      /playbooks\.t2g requires local role "captain", which is reserved for the tmux-play Captain/,
    );
    // Config fault: a players map may not bind `captain` even when the
    // manifest does not require it.
    await expect(
      composeGenericConfig(
        {
          captain: 'claude',
          playbooks: {
            code: {
              from: 'mod://code',
              players: { ...players, captain: 'claude' },
            },
          },
        },
        ld,
      ),
    ).rejects.toThrow(
      /playbooks\.code\.players\.captain binds local role "captain", which is reserved for the tmux-play Captain/,
    );
  });
});

describe('playbook launcher — seeding and launch (PBCLI-13)', () => {
  it('seeds the starter config, composes, and launches the composed config', async () => {
    const home = await makeTempHome();
    const spawn = fakeSpawn();
    const stderr = writer();
    const configPath = resolveUserConfigPath({}, home);

    const result = await runPlaybookCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    const seeded = await readFile(configPath, 'utf8');
    expect(seeded).toContain('@sublang/playbook/code/registry');
    expect(seeded).toContain('claude-opus-4-8[1m]');
    expect(seeded).toContain('gpt-5.5');
    expect(seeded).toContain('committer: coder');
    expect(seeded).toContain('.git');
    expect(stderr.text()).toContain(`created config at ${configPath}`);

    // PBCLI-11/13: the seed names profiles by agent/model and wires the
    // captain / roles to those ids, not to role-named profiles. A revert to
    // judge / coder / reviewer profile ids would fail here.
    const seededParsed = parseYaml(seeded);
    expect(seededParsed.profiles).toMatchObject({
      'claude-opus': { adapter: 'claude' },
      'claude-opus-1m': { adapter: 'claude' },
      'codex-gpt': { adapter: 'codex' },
    });
    expect(seededParsed.captain).toBe('claude-opus');
    expect(seededParsed.playbooks.code.players).toEqual({
      coder: 'claude-opus-1m',
      reviewer: 'codex-gpt',
    });

    expect(spawn.calls).toHaveLength(1);
    const composed = parseYaml(spawn.configs[0].content);
    expect(composed.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(composed.captain).toMatchObject({
      adapter: 'claude',
      model: 'claude-opus-4-8',
      reasoningEffort: 'high',
      // PBCLI-11: every seeded agent, including the claude Captain, runs in
      // cligent's protected auto mode.
      permissions: { mode: 'auto' },
    });
    expect(composed.players).toEqual([
      {
        id: 'code-coder',
        adapter: 'claude',
        model: 'claude-opus-4-8[1m]',
        reasoningEffort: 'xhigh',
        // PBCLI-11: seeded claude roles get auto mode, no writablePaths.
        permissions: { mode: 'auto' },
      },
      {
        id: 'code-reviewer',
        adapter: 'codex',
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        permissions: { mode: 'auto', writablePaths: ['.git'] },
      },
    ]);
    expect(composed.layout.initialVisible).toEqual([
      'code-coder',
      'code-reviewer',
    ]);
    expect(composed.captain.options.playbooks.code).toEqual({
      from: '@sublang/playbook/code/registry',
      options: { committer: 'coder' },
    });

    // The composed config is valid input to cligent's own loader.
    const loaded = await loadComposedConfig(spawn.configs[0].content);
    expect(loaded.config.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(loaded.config.players.map((p: { id: string }) => p.id)).toEqual([
      'code-coder',
      'code-reviewer',
    ]);
  });

  it('does not reseed an existing config', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const spawn = fakeSpawn();
    const stderr = writer();

    await runPlaybookCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(stderr.text()).not.toContain('created config');
    const kept = await readFile(resolveUserConfigPath({}, home), 'utf8');
    expect(kept).toBe(minimalConfig());
  });
});

describe('playbook launcher — readiness (PBCLI-16)', () => {
  it('blocks launch with help and a non-127 exit when an adapter is unready', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCli({
      argv: [],
      env: {},
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(127);
    expect(stderr.text()).toContain('Adapters not ready:');
    expect(stderr.text()).toMatch(/claude|codex/);
    expect(spawn.calls).toHaveLength(0);
  });

  it('warns on an unknown adapter without blocking launch', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, geminiConfig());
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'a' },
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    expect(stderr.text()).toContain(
      'no readiness check for adapter "gemini"',
    );
    expect(spawn.calls).toHaveLength(1);
  });
});

describe('playbook launcher — CLI surface (PBCLI-17)', () => {
  it('lists configured playbooks without launching', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const spawn = fakeSpawn();
    const stdout = writer();

    const result = await runPlaybookCli({
      argv: ['--list'],
      env: {},
      homeDir: home,
      stderr: writer(),
      stdout,
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    expect(stdout.text()).toContain('/code');
    expect(stdout.text()).toContain('code');
    expect(stdout.text()).toContain('SDLC');
    expect(spawn.calls).toHaveLength(0);
  });

  it('prints help and exits 0 without seeding or launching', async () => {
    const home = await makeTempHome();
    const spawn = fakeSpawn();
    const stdout = writer();

    const result = await runPlaybookCli({
      argv: ['--help'],
      env: {},
      homeDir: home,
      stderr: writer(),
      stdout,
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    expect(stdout.text()).toContain('Usage:');
    expect(stdout.text()).toContain('Agent swap recipe:');
    expect(spawn.calls).toHaveLength(0);
  });

  it('passes an explicit --config through without composing', async () => {
    const home = await makeTempHome();
    const spawn = fakeSpawn();

    const result = await runPlaybookCli({
      argv: ['--config', '/tmp/raw.yaml'],
      env: {},
      homeDir: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].args).toEqual([
      '/tmp/tmux-play.js',
      '--config',
      '/tmp/raw.yaml',
    ]);
  });

  it('propagates the tmux-play exit code, signal, and 127 launch failure', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
    const base = {
      argv: [],
      env,
      homeDir: home,
      stderr: writer(),
      stdout: writer(),
      tmuxPlayBin: '/tmp/tmux-play.js',
    };

    const exit3 = await runPlaybookCli({ ...base, spawn: fakeSpawn({ exitCode: 3 }).fn });
    expect(exit3).toEqual({ code: 3 });

    const sig = await runPlaybookCli({
      ...base,
      spawn: fakeSpawn({ signal: 'SIGTERM' }).fn,
    });
    expect(sig).toEqual({ signal: 'SIGTERM' });

    const fail = await runPlaybookCli({
      ...base,
      spawn: () => {
        throw new Error('spawn boom');
      },
    });
    expect(fail).toEqual({ code: 127 });
  });
});

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

async function writeUserConfig(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config', 'playbook'), { recursive: true });
  await writeFile(resolveUserConfigPath({}, home), contents, 'utf8');
}

async function loadComposedConfig(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-cli-rt-'));
  tempDirs.push(dir);
  const path = join(dir, 'tmux-play.config.yaml');
  await writeFile(path, content, 'utf8');
  return loadTmuxPlayConfig({ configPath: path });
}

function minimalConfig(): string {
  return [
    'profiles:',
    '  claude-agent:',
    '    adapter: claude',
    '  codex-agent:',
    '    adapter: codex',
    'captain: claude-agent',
    'playbooks:',
    '  code:',
    '    from: "@sublang/playbook/code/registry"',
    '    players:',
    '      coder: claude-agent',
    '      reviewer: codex-agent',
    '    committer: coder',
    '',
  ].join('\n');
}

function geminiConfig(): string {
  return [
    'captain: claude',
    'playbooks:',
    '  code:',
    '    from: "@sublang/playbook/code/registry"',
    '    players:',
    '      coder: gemini',
    '      reviewer: gemini',
    '',
  ].join('\n');
}

function fakeSpawn(opts: { exitCode?: number; signal?: string } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const configs: { path: string; content: string }[] = [];
  return {
    calls,
    configs,
    fn: (command: string, args: string[]) => {
      calls.push({ command, args });
      const idx = args.indexOf('--config');
      if (idx !== -1 && args[idx + 1]) {
        const path = args[idx + 1];
        let content = '';
        try {
          content = readFileSync(path, 'utf8');
        } catch {
          content = '';
        }
        configs.push({ path, content });
      }
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit('exit', opts.exitCode ?? 0, opts.signal ?? null),
      );
      return child;
    },
  };
}

function writer() {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}
