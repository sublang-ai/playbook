// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
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

const playbookCode = await import(
  new URL('./bin/playbook-code.js', import.meta.url).href
);

const {
  runPlaybookCodeCli,
  resolveUserConfigPath,
  collectAdaptersFromConfig,
} = playbookCode;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe('playbook-code shim — config seeding', () => {
  it('seeds the user config from the bundled template and launches with it', async () => {
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
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    expect(result).toEqual({ code: 0 });
    await expect(readFile(configPath, 'utf8')).resolves.toContain(
      'PBRT-4 host-configuration invariants',
    );
    expect(stderr.text()).toContain(`created config at ${configPath}`);
    expect(spawn.calls).toEqual([
      {
        command: process.execPath,
        args: ['/tmp/tmux-play.js', '--config', configPath],
        options: { stdio: 'inherit' },
      },
    ]);
  });

  it('does not rewrite an existing user config', async () => {
    const home = await makeTempHome();
    const configPath = resolveUserConfigPath({}, home);
    await mkdir(join(home, '.config', 'playbook'), { recursive: true });
    await writeFile(configPath, existingConfig(), 'utf8');
    const before = await stat(configPath);
    const spawn = fakeSpawn();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: 'openai-key',
      },
      homeDir: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });

    const after = await stat(configPath);
    expect(result).toEqual({ code: 0 });
    expect(await readFile(configPath, 'utf8')).toBe(existingConfig());
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(spawn.calls[0]?.args).toEqual([
      '/tmp/tmux-play.js',
      '--config',
      configPath,
    ]);
  });

  it('forwards explicit --config arguments verbatim and bypasses setup', async () => {
    const home = await makeTempHome();
    const spawn = fakeSpawn();
    const configPath = resolveUserConfigPath({}, home);

    const result = await runPlaybookCodeCli({
      argv: ['--config', './custom.yaml', '--cwd', '/tmp/work'],
      env: {},
      homeDir: home,
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
    await writeFile(resolveUserConfigPath({}, home), existingConfig(), 'utf8');
    const spawn = fakeSpawn();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {},
      homeDir: home,
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
    await writeFile(configPath, existingConfig(), 'utf8');
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {},
      homeDir: home,
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
    expect(stderr.text()).toContain('roles[].id');
  });

  it('warns for unknown adapters without blocking launch', async () => {
    const home = await makeTempHome();
    await mkdir(join(home, '.config', 'playbook'), { recursive: true });
    await writeFile(
      resolveUserConfigPath({}, home),
      [
        'captain:',
        '  adapter: gemini',
        'roles:',
        '  - id: coder',
        '    adapter: gemini',
      ].join('\n'),
      'utf8',
    );
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCodeCli({
      argv: [],
      env: {},
      homeDir: home,
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
    expect(stdout.text()).toContain('roles[].id');
  });

  it('collects adapter ids from the config shape used by the template', () => {
    expect(
      collectAdaptersFromConfig(
        [
          'captain:',
          '  adapter: "claude" # comment',
          'roles:',
          '  - id: coder',
          "    adapter: 'codex'",
          '  - id: reviewer',
          '    adapter: codex',
        ].join('\n'),
      ),
    ).toEqual(['claude', 'codex']);
  });
});

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-code-test-'));
  tempDirs.push(dir);
  return dir;
}

function fakeSpawn() {
  const calls: {
    command: string;
    args: string[];
    options: { stdio: string };
  }[] = [];
  return {
    calls,
    fn: (command: string, args: string[], options: { stdio: string }) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
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

function existingConfig(): string {
  return [
    'captain:',
    '  from: "@sublang/playbook/code/tmux-play"',
    '  adapter: claude',
    '  options:',
    '    coderPlayer: claude',
    '    reviewerPlayer: codex',
    'roles:',
    '  - id: coder',
    '    adapter: claude',
    '  - id: reviewer',
    '    adapter: codex',
    '',
  ].join('\n');
}
