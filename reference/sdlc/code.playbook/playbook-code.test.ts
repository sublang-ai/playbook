// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const playbookCode = await import(
  new URL('./bin/playbook-code.js', import.meta.url).href
);

const {
  runPlaybookCodeCli,
  resolveUserConfigPath,
  resolveConfigHome,
  composeRuntimeConfig,
  adaptersFromComposedConfig,
  PLAYBOOK_CAPTAIN_MODULE,
} = playbookCode;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe('playbook-code shim — config seeding (PBCODE-5/9)', () => {
  it('seeds the CODE overlay from the bundled template and launches the composed temp config', async () => {
    const home = await makeTempHome();
    const spawn = fakeSpawn();
    const stderr = writer();
    const configPath = resolveUserConfigPath({}, home);

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: 'openai-key',
      },
      homeDir: home,
      cwd: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    const seeded = await readFile(configPath, 'utf8');
    expect(seeded).toContain('CODE overlay');
    expect(seeded).toContain('players.coder');
    expect(seeded).toContain('PBRT-4');
    expect(seeded).toContain('writablePaths');
    expect(seeded).toContain('- .git');
    expect(seeded).toContain('notifications:');
    expect(seeded).toContain('player_finished: bell');
    expect(seeded).toContain('turn_finished: desktop');
    expect(stderr.text()).toContain(`created config at ${configPath}`);

    // Launches the *composed temp* config, not the user overlay path.
    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0].args;
    expect(args[0]).toBe('/tmp/tmux-play.js');
    expect(args[1]).toBe('--config');
    expect(args[2]).not.toBe(configPath);
    expect(args[2].endsWith('.yaml')).toBe(true);

    const composed = parseYaml(spawn.configs[0].content);
    expect(composed.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(composed.players.map((p: { id: string }) => p.id)).toEqual([
      'coder',
      'reviewer',
    ]);
    expect(
      composed.players.find((p: { id: string }) => p.id === 'coder')
        ?.permissions,
    ).toEqual({ mode: 'auto', writablePaths: ['.git'] });
    // PBCODE-16/17: the seeded template carries a layout block, carried
    // through to the composed config (174×49 window, 4:6:6 columns).
    expect(composed.layout).toEqual({
      window: { columns: 174, rows: 49 },
      columnWeights: [4, 6, 6],
    });
    // PBCODE-16/17: notification settings are host-owned tmux-play
    // config and pass through from the CODE overlay to the composed
    // runtime config.
    expect(composed.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
    });
    // PBCODE-16/17 + PBRT-8: the seeded Committer alias resolves into
    // captain.options.code.committer without adding a players[] entry,
    // so commit turns route to the reviewer pane.
    expect(composed.captain.options.code.committer).toBe('reviewer');

    // Temp config removed before the shim exits.
    expect(spawn.configs[0].existedAtSpawn).toBe(true);
    expect(existsSync(args[2])).toBe(false);
  });

  it('does not rewrite an existing user overlay and launches the composed config', async () => {
    const home = await makeTempHome();
    const configPath = resolveUserConfigPath({}, home);
    await mkdir(join(home, '.config', 'playbook'), { recursive: true });
    await writeFile(configPath, existingOverlay(), 'utf8');
    const before = await stat(configPath);
    const spawn = fakeSpawn();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: 'openai-key',
      },
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    const after = await stat(configPath);
    expect(result).toEqual({ code: 0 });
    expect(await readFile(configPath, 'utf8')).toBe(existingOverlay());
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // Launches the composed temp config, not the overlay file itself.
    expect(spawn.calls[0]?.args[2]).not.toBe(configPath);
    expect(spawn.calls[0]?.args[2].endsWith('.yaml')).toBe(true);
  });

  it('migrates an existing user overlay missing notifications before launch', async () => {
    const home = await makeTempHome();
    const configPath = resolveUserConfigPath({}, home);
    await mkdir(join(home, '.config', 'playbook'), { recursive: true });
    await writeFile(configPath, legacyOverlay(), 'utf8');
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: 'openai-key',
      },
      homeDir: home,
      cwd: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    const migrated = await readFile(configPath, 'utf8');
    expect(migrated.startsWith(legacyOverlay())).toBe(true);
    expect(migrated).toContain('notifications:');
    expect(migrated).toContain('player_finished: bell');
    expect(migrated).toContain('turn_finished: desktop');
    expect(stderr.text()).toContain(
      `added notifications defaults to config at ${configPath}`,
    );

    const composed = parseYaml(spawn.configs[0].content);
    expect(composed.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
    });
  });

  it('forwards explicit --config arguments verbatim and bypasses composition', async () => {
    const home = await makeTempHome();
    const spawn = fakeSpawn();
    const configPath = resolveUserConfigPath({}, home);

    const result = await runPlaybookCodeCli({
      argv: ['--config', './custom.yaml', '--cwd', '/tmp/work'],
      env: {},
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
    expect(result).toEqual({ code: 0 });
    expect(spawn.calls).toEqual([
      {
        command: process.execPath,
        args: ['/tmp/tmux-play.js', '--config', './custom.yaml', '--cwd', '/tmp/work'],
        options: { stdio: 'inherit' },
      },
    ]);
  });
});

describe('playbook-code shim — readiness and help', () => {
  it('passes readiness via local auth directories', async () => {
    const home = await makeTempHome();
    await mkdir(join(home, '.config', 'playbook'), { recursive: true });
    await mkdir(join(home, '.claude'));
    await mkdir(join(home, '.codex'));
    await writeFile(resolveUserConfigPath({}, home), existingOverlay(), 'utf8');
    const spawn = fakeSpawn();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {},
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    expect(spawn.calls).toHaveLength(1);
  });

  it('fails readiness with help text and no launch', async () => {
    const home = await makeTempHome();
    await mkdir(join(home, '.config', 'playbook'), { recursive: true });
    const configPath = resolveUserConfigPath({}, home);
    await writeFile(configPath, existingOverlay(), 'utf8');
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {},
      homeDir: home,
      cwd: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 2 });
    expect(spawn.calls).toEqual([]);
    expect(stderr.text()).toContain(`Default config: ${configPath}`);
    expect(stderr.text()).toContain('Adapters not ready: claude, codex');
    expect(stderr.text()).toContain('ANTHROPIC_API_KEY');
    expect(stderr.text()).toContain('OPENAI_API_KEY');
    expect(stderr.text()).toContain('captain.adapter');
    expect(stderr.text()).toContain('players.coder');
  });

  it('warns for unknown adapters without blocking launch', async () => {
    const home = await makeTempHome();
    await mkdir(join(home, '.config', 'playbook'), { recursive: true });
    await writeFile(
      resolveUserConfigPath({}, home),
      [
        'captain:',
        '  adapter: gemini',
        'players:',
        '  coder:',
        '    adapter: gemini',
        '  reviewer:',
        '    adapter: gemini',
        '',
      ].join('\n'),
      'utf8',
    );
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {},
      homeDir: home,
      cwd: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    expect(stderr.text()).toContain('no readiness check for adapter "gemini"');
    expect(spawn.calls).toHaveLength(1);
  });

  it('prints shim help without side effects', async () => {
    const home = await makeTempHome();
    const configPath = resolveUserConfigPath({}, home);
    const spawn = fakeSpawn();
    const stdout = writer();

    const result = await runPlaybookCodeCli({
      argv: ['--help'],
      env: {},
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout,
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
    expect(spawn.calls).toEqual([]);
    expect(stdout.text()).toContain(`Default config: ${configPath}`);
    expect(stdout.text()).toContain('ANTHROPIC_API_KEY');
    expect(stdout.text()).toContain('OPENAI_API_KEY');
    expect(stdout.text()).toContain('captain.adapter');
    expect(stdout.text()).toContain('players.coder');
    expect(stdout.text()).toContain('players.reviewer');
    // The composer injects captain.from; the recipe no longer tells the
    // user to keep it fixed.
    expect(stdout.text()).not.toContain('players[].id');
  });

  it('accepts -h as the short help alias', async () => {
    const home = await makeTempHome();
    const spawn = fakeSpawn();
    const stdout = writer();

    const result = await runPlaybookCodeCli({
      argv: ['-h'],
      env: {},
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout,
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    expect(stdout.text()).toContain('Usage:');
    expect(spawn.calls).toEqual([]);
  });

  it('collects adapter ids from a composed config', () => {
    expect(
      adaptersFromComposedConfig({
        captain: { from: PLAYBOOK_CAPTAIN_MODULE, adapter: 'claude' },
        players: [
          { id: 'coder', adapter: 'claude' },
          { id: 'reviewer', adapter: 'codex' },
        ],
      }),
    ).toEqual(['claude', 'codex']);
  });
});

describe('playbook-code shim — config composition (PBCODE-16/17/18)', () => {
  it('maps the overlay roles to a players[] roster and injects the invariants', () => {
    const composed = composeRuntimeConfig(fullOverlay());

    expect(composed.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(composed.captain.adapter).toBe('claude');
    expect(composed.captain.options).toEqual({ code: { } });
    expect(composed.players).toEqual([
      {
        id: 'coder',
        adapter: 'claude',
        model: 'claude-opus-4-7',
        reasoningEffort: 'xhigh',
        permissions: { mode: 'auto' },
      },
      {
        id: 'reviewer',
        adapter: 'codex',
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        permissions: { mode: 'auto' },
      },
    ]);
  });

  it('carries captain.options.code through unchanged', () => {
    const overlay = fullOverlay();
    overlay.captain.options = { code: { } };
    const composed = composeRuntimeConfig(overlay);
    expect(composed.captain.options).toEqual({ code: { } });
  });

  it('inherits only host fields and captain-judge fields from the base, never the base roster', () => {
    const overlay = {
      captain: { adapter: 'claude' },
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
      },
    };
    const base = {
      theme: 'latte',
      notifications: {
        player_finished: 'bell',
        turn_finished: 'desktop',
        turn_aborted: 'off',
      },
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'codex',
        model: 'base-judge-model',
        reasoningEffort: 'medium',
        permissions: { mode: 'auto' },
      },
      players: [{ id: 'solo', adapter: 'gemini' }],
    };

    const composed = composeRuntimeConfig(overlay, base);

    // captain.adapter present in the overlay wins; the unset judge
    // fields and theme are inherited from the base.
    expect(composed.captain.adapter).toBe('claude');
    expect(composed.captain.model).toBe('base-judge-model');
    expect(composed.captain.reasoningEffort).toBe('medium');
    expect(composed.theme).toBe('latte');
    expect(composed.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
      turn_aborted: 'off',
    });
    // The base roster is not mapped onto coder / reviewer.
    expect(composed.players.map((p: { id: string }) => p.id)).toEqual([
      'coder',
      'reviewer',
    ]);
    expect(composed.players.map((p: { adapter: string }) => p.adapter)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('carries a top-level layout block through from the overlay', () => {
    const composed = composeRuntimeConfig({
      captain: { adapter: 'claude' },
      layout: { window: { columns: 174, rows: 49 }, columnWeights: [4, 6, 6] },
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
      },
    });
    expect(composed.layout).toEqual({
      window: { columns: 174, rows: 49 },
      columnWeights: [4, 6, 6],
    });
  });

  it('inherits layout from the base when the overlay omits it, like theme', () => {
    const overlay = {
      captain: { adapter: 'claude' },
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
      },
    };
    const base = {
      layout: { window: { columns: 200, rows: 60 }, columnWeights: [1, 1, 1] },
      captain: { from: 'x', adapter: 'codex' },
      players: [{ id: 'solo', adapter: 'gemini' }],
    };
    const composed = composeRuntimeConfig(overlay, base);
    expect(composed.layout).toEqual({
      window: { columns: 200, rows: 60 },
      columnWeights: [1, 1, 1],
    });
  });

  it('prefers the overlay layout over the base layout', () => {
    const overlay = {
      captain: { adapter: 'claude' },
      layout: { window: { columns: 174, rows: 49 }, columnWeights: [4, 6, 6] },
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
      },
    };
    const base = {
      layout: { window: { columns: 80, rows: 24 }, columnWeights: [1, 1, 1] },
      captain: { from: 'x', adapter: 'codex' },
      players: [{ id: 'solo', adapter: 'gemini' }],
    };
    const composed = composeRuntimeConfig(overlay, base);
    expect(composed.layout).toEqual({
      window: { columns: 174, rows: 49 },
      columnWeights: [4, 6, 6],
    });
  });

  it('carries a top-level notifications block through from the overlay', () => {
    const composed = composeRuntimeConfig({
      captain: { adapter: 'claude' },
      notifications: { player_finished: 'bell', turn_finished: 'desktop' },
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
      },
    });
    expect(composed.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
    });
  });

  it('inherits notifications from the base when the overlay omits them, like theme', () => {
    const overlay = {
      captain: { adapter: 'claude' },
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
      },
    };
    const base = {
      notifications: {
        player_finished: 'off',
        turn_finished: 'desktop',
        turn_aborted: 'bell',
      },
      captain: { from: 'x', adapter: 'codex' },
      players: [{ id: 'solo', adapter: 'gemini' }],
    };
    const composed = composeRuntimeConfig(overlay, base);
    expect(composed.notifications).toEqual({
      player_finished: 'off',
      turn_finished: 'desktop',
      turn_aborted: 'bell',
    });
  });

  it('prefers overlay notifications over base notifications', () => {
    const overlay = {
      captain: { adapter: 'claude' },
      notifications: { player_finished: 'bell' },
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
      },
    };
    const base = {
      notifications: {
        player_finished: 'off',
        turn_finished: 'desktop',
        turn_aborted: 'bell',
      },
      captain: { from: 'x', adapter: 'codex' },
      players: [{ id: 'solo', adapter: 'gemini' }],
    };
    const composed = composeRuntimeConfig(overlay, base);
    expect(composed.notifications).toEqual({ player_finished: 'bell' });
  });

  it('inherits captain.adapter from the base when the overlay omits it', () => {
    const overlay = {
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
      },
    };
    const base = {
      captain: { from: 'x', adapter: 'gemini' },
      players: [{ id: 'solo', adapter: 'gemini' }],
    };
    const composed = composeRuntimeConfig(overlay, base);
    expect(composed.captain.adapter).toBe('gemini');
  });

  it('rejects an overlay missing a CODE role with a path-named error', () => {
    expect(() =>
      composeRuntimeConfig({
        captain: { adapter: 'claude' },
        players: { coder: { adapter: 'claude' } },
      }),
    ).toThrow(/players\.reviewer/);
  });

  it('rejects an overlay naming a non-CODE role id with a path-named error', () => {
    expect(() =>
      composeRuntimeConfig({
        captain: { adapter: 'claude' },
        players: {
          coder: { adapter: 'claude' },
          reviewer: { adapter: 'codex' },
          maintainer: { adapter: 'claude' },
        },
      }),
    ).toThrow(/players\.maintainer/);
  });

  // The CODE overlay with a `players.committer` alias. Built inline
  // (not via fullOverlay) so the loosely-typed literal can carry the
  // optional alias key; the composer param is untyped.
  function committerOverlay(committer: string, code?: Record<string, unknown>) {
    return {
      captain: { adapter: 'claude', ...(code ? { options: { code } } : {}) },
      players: {
        coder: { adapter: 'claude' },
        reviewer: { adapter: 'codex' },
        committer,
      },
    };
  }

  it('resolves players.committer into captain.options.code without a players[] entry', () => {
    // PBCODE-17/18: the alias names an existing role; the composer
    // emits it under captain.options.code.committer and leaves the
    // roster at coder + reviewer (no third players[] entry).
    const composed = composeRuntimeConfig(committerOverlay('reviewer'));
    expect(composed.captain.options).toEqual({ code: { committer: 'reviewer' } });
    expect(composed.players.map((p: { id: string }) => p.id)).toEqual([
      'coder',
      'reviewer',
    ]);
  });

  it('resolves players.committer: coder the same way', () => {
    const composed = composeRuntimeConfig(committerOverlay('coder'));
    expect(composed.captain.options).toEqual({ code: { committer: 'coder' } });
  });

  it('rejects players.committer naming a non-role with a path-named error', () => {
    expect(() => composeRuntimeConfig(committerOverlay('boss'))).toThrow(
      /players\.committer/,
    );
  });

  it('rejects a directly-set captain.options.code.committer (composer-owned)', () => {
    const overlay = fullOverlay();
    overlay.captain.options = { code: { committer: 'reviewer' } };
    expect(() => composeRuntimeConfig(overlay)).toThrow(
      /captain\.options\.code\.committer/,
    );
  });

  it('layers the resolved alias on top of a carried-through code block', () => {
    // The composer carries the overlay's captain.options.code through
    // unchanged (it does not validate non-committer keys — that is the
    // adapter's job per PBRT-30) and layers the resolved alias on top.
    const composed = composeRuntimeConfig(
      committerOverlay('reviewer', { future: 'value' }),
    );
    expect(composed.captain.options).toEqual({
      code: { future: 'value', committer: 'reviewer' },
    });
  });

  it('rejects an overlay missing captain.adapter with no base config', () => {
    expect(() =>
      composeRuntimeConfig({
        players: {
          coder: { adapter: 'claude' },
          reviewer: { adapter: 'codex' },
        },
      }),
    ).toThrow(/captain\.adapter/);
  });

  it('rejects a role block that omits adapter with a path-named error', () => {
    expect(() =>
      composeRuntimeConfig({
        captain: { adapter: 'claude' },
        players: {
          coder: {},
          reviewer: { adapter: 'codex' },
        },
      }),
    ).toThrow(/players\.coder\.adapter/);
  });

  it('locates the base via findTmuxPlayConfig without writing a default config', async () => {
    const home = await makeTempHome();
    await writeOverlay(home, existingOverlay());
    const spawn = fakeSpawn();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    // No base existed, so the loader must not have written a default
    // tmux-play config under the config home.
    expect(
      existsSync(join(resolveConfigHome({}, home), 'tmux-play', 'config.yaml')),
    ).toBe(false);
  });

  it('inherits theme + judge defaults from a discovered base config end to end', async () => {
    const home = await makeTempHome();
    await writeOverlay(
      home,
      [
        'captain:',
        '  adapter: claude',
        'players:',
        '  coder:',
        '    adapter: claude',
        '  reviewer:',
        '    adapter: codex',
        '',
      ].join('\n'),
    );
    await writeBaseConfig(
      home,
      [
        'theme: latte',
        'captain:',
        '  from: "@sublang/cligent/captains/fanout"',
        '  adapter: codex',
        '  model: base-judge-model',
        '  reasoningEffort: medium',
        'players:',
        '  - id: solo',
        '    adapter: gemini',
        '',
      ].join('\n'),
    );
    const spawn = fakeSpawn();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    const composed = parseYaml(spawn.configs[0].content);
    expect(composed.theme).toBe('latte');
    expect(composed.captain.adapter).toBe('claude');
    expect(composed.captain.model).toBe('base-judge-model');
    expect(composed.captain.reasoningEffort).toBe('medium');
    expect(composed.players.map((p: { id: string }) => p.id)).toEqual([
      'coder',
      'reviewer',
    ]);
  });

  it('migrates a legacy overlay before base notification inheritance end to end', async () => {
    const home = await makeTempHome();
    await writeOverlay(
      home,
      [
        'captain:',
        '  adapter: claude',
        'players:',
        '  coder:',
        '    adapter: claude',
        '  reviewer:',
        '    adapter: codex',
        '',
      ].join('\n'),
    );
    await writeBaseConfig(
      home,
      [
        'notifications:',
        '  player_finished: off',
        '  turn_finished: desktop',
        '  turn_aborted: bell',
        'captain:',
        '  from: "@sublang/cligent/captains/fanout"',
        '  adapter: codex',
        'players:',
        '  - id: solo',
        '    adapter: gemini',
        '',
      ].join('\n'),
    );
    const spawn = fakeSpawn();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    const composed = parseYaml(spawn.configs[0].content);
    // Default launch migrates the user overlay before composition, so
    // the new overlay block wins whole over any base notifications.
    expect(composed.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
    });
  });

  it('inherits a base layout block when the overlay omits it, end to end', async () => {
    const home = await makeTempHome();
    await writeOverlay(
      home,
      [
        'captain:',
        '  adapter: claude',
        'players:',
        '  coder:',
        '    adapter: claude',
        '  reviewer:',
        '    adapter: codex',
        '',
      ].join('\n'),
    );
    await writeBaseConfig(
      home,
      [
        'theme: latte',
        'layout:',
        '  window:',
        '    columns: 200',
        '    rows: 60',
        '  columnWeights: [1, 1, 1]',
        'captain:',
        '  from: "@sublang/cligent/captains/fanout"',
        '  adapter: codex',
        'players:',
        '  - id: solo',
        '    adapter: gemini',
        '  - id: duo',
        '    adapter: codex',
        '',
      ].join('\n'),
    );
    const spawn = fakeSpawn();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    const composed = parseYaml(spawn.configs[0].content);
    // The overlay omits layout, so the composed config inherits the
    // base's layout end to end. The base declares two players, so its
    // 3-entry columnWeights satisfies cligent's pane-count validation on
    // load (1 Boss/Captain column + 2 player columns).
    expect(composed.layout).toEqual({
      window: { columns: 200, rows: 60 },
      columnWeights: [1, 1, 1],
    });
  });

  it('rejects a malformed overlay at launch with a path-named error and no spawn', async () => {
    const home = await makeTempHome();
    await writeOverlay(
      home,
      ['captain:', '  adapter: claude', 'players:', '  coder:', '    adapter: claude', ''].join(
        '\n',
      ),
    );
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      homeDir: home,
      cwd: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result.code).not.toBe(0);
    expect(spawn.calls).toEqual([]);
    expect(stderr.text()).toContain('players.reviewer');
  });

  it('removes the temp config on a non-zero child exit', async () => {
    const home = await makeTempHome();
    await writeOverlay(home, existingOverlay());
    const spawn = fakeSpawn({ exitCode: 3 });

    const result = await runPlaybookCodeCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 3 });
    expect(spawn.configs[0].existedAtSpawn).toBe(true);
    expect(existsSync(spawn.calls[0].args[2])).toBe(false);
  });

  it('removes the temp config on the signal-forwarding path', async () => {
    const home = await makeTempHome();
    await writeOverlay(home, existingOverlay());
    const spawn = fakeSpawn({ signal: 'SIGINT' });

    const result = await runPlaybookCodeCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      homeDir: home,
      cwd: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ signal: 'SIGINT' });
    expect(spawn.configs[0].existedAtSpawn).toBe(true);
    expect(existsSync(spawn.calls[0].args[2])).toBe(false);
  });
});

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-code-test-'));
  tempDirs.push(dir);
  return dir;
}

async function writeOverlay(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config', 'playbook'), { recursive: true });
  await writeFile(resolveUserConfigPath({}, home), contents, 'utf8');
}

async function writeBaseConfig(home: string, contents: string): Promise<void> {
  const dir = join(home, '.config', 'tmux-play');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), contents, 'utf8');
}

function fakeSpawn(opts: { exitCode?: number; signal?: string } = {}) {
  const calls: {
    command: string;
    args: string[];
    options: { stdio: string };
  }[] = [];
  const configs: {
    path: string;
    content: string;
    existedAtSpawn: boolean;
  }[] = [];
  return {
    calls,
    configs,
    fn: (command: string, args: string[], options: { stdio: string }) => {
      calls.push({ command, args, options });
      const idx = args.indexOf('--config');
      if (idx !== -1 && args[idx + 1]) {
        const path = args[idx + 1];
        let content = '';
        let existedAtSpawn = false;
        try {
          content = readFileSync(path, 'utf8');
          existedAtSpawn = true;
        } catch {
          existedAtSpawn = false;
        }
        configs.push({ path, content, existedAtSpawn });
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

// The user-level CODE overlay: tmux-play shape minus captain.from, with
// players keyed by role rather than an array with ids (PBCODE-16).
function existingOverlay(): string {
  return [
    legacyOverlay().trimEnd(),
    'notifications:',
    '  player_finished: bell',
    '  turn_finished: desktop',
    '',
  ].join('\n');
}

function legacyOverlay(): string {
  return [
    'captain:',
    '  adapter: claude',
    'players:',
    '  coder:',
    '    adapter: claude',
    '  reviewer:',
    '    adapter: codex',
    '',
  ].join('\n');
}

function fullOverlay() {
  return {
    captain: {
      adapter: 'claude',
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'high',
      permissions: { mode: 'auto' },
      options: { code: {} },
    },
    players: {
      coder: {
        adapter: 'claude',
        model: 'claude-opus-4-7',
        reasoningEffort: 'xhigh',
        permissions: { mode: 'auto' },
      },
      reviewer: {
        adapter: 'codex',
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        permissions: { mode: 'auto' },
      },
    },
  };
}
