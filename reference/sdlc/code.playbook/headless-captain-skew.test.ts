// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// playbook-cli-35 / slc/link.md §Output: the compiled session Captain module
// defers its factory call to the first runtime request. This suite proves it
// behaviorally against the real compiled module: with the engine factory
// rejecting the Captain's construction — the skew a forgotten re-link under
// a bumped ABI would produce — importing the module and serving `run --help`
// still succeed, while the first Boss turn settles as the caught
// `playbook run:` setup diagnostic rather than a module-load crash. A
// re-link that restores an eager module-scope factory call fails here at
// the import assertions.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createEvent,
  type AgentAdapter,
  type AgentEvent,
} from '@sublang/cligent';

vi.mock('../../../src/xstate-runtime.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const realFactory = actual.createXStatePlaybookRuntime as (
    machine: unknown,
    spec: unknown,
  ) => unknown;
  return {
    ...actual,
    // Surgical skew: only the Captain's construction rejects, with the
    // DR-022 TypeError shape; every other artifact constructs for real.
    createXStatePlaybookRuntime: (
      machine: unknown,
      spec: { label?: string },
    ) => {
      if (spec?.label === 'CAPTAIN') {
        throw new TypeError(
          'CAPTAIN spec.compat.runtimeAbi 999 does not match engine RUNTIME_ABI 1',
        );
      }
      return realFactory(machine, spec);
    },
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
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

class StubAdapter implements AgentAdapter {
  readonly agent = 'claude-code';

  async *run(): AsyncGenerator<AgentEvent, void, void> {
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result: 'stub',
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      'transport:stub',
    );
  }

  async isAvailable() {
    return true;
  }
}

const adapterImports = Object.fromEntries(
  ['claude', 'codex', 'gemini', 'kimi', 'opencode'].map((adapter) => [
    adapter,
    async () => StubAdapter,
  ]),
) as never;

it('imports the compiled Captain and serves help under a rejecting factory', async () => {
  // Import survives: the module makes no factory call at evaluation. An
  // eager re-link would reject this import with the mocked TypeError.
  const captain = await import('../captain.playbook/captain.playbook.js');
  expect(typeof captain.default).toBe('function');
  // The first runtime request is where the rejection lands.
  expect(() => captain.createPlaybookRuntime({} as never)).toThrow(/999/);

  const { runPlaybookCli } = await import(
    new URL('./bin/playbook.js', import.meta.url).href
  );
  const home = await mkdtemp(join(tmpdir(), 'playbook-skew-help-'));
  tempDirs.push(home);
  const stdout = writer();
  const stderr = writer();
  const help = await runPlaybookCli({
    argv: ['run', '--help'],
    homeDir: home,
    stdout,
    stderr,
  });
  expect(help.code).toBe(0);
  expect(stdout.text()).toContain('playbook run [--with <path>]');
});

it('settles the Captain construction rejection as the prefixed setup diagnostic', async () => {
  const { runPlaybookCli } = await import(
    new URL('./bin/playbook.js', import.meta.url).href
  );
  const { default: codePlaybookRegistryEntry } = await import(
    './code.registry.js'
  );
  const dir = await mkdtemp(join(tmpdir(), 'playbook-skew-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'playbook.config.yaml');
  await writeFile(
    configPath,
    [
      'captain: { adapter: claude, model: captain-model }',
      'players:',
      '  dev.coder: { adapter: claude, model: coder-model }',
      'playbooks:',
      '  code:',
      '    from: mod://code',
      '    roles: { coder: dev.coder }',
      '',
    ].join('\n'),
    'utf8',
  );
  const stdout = writer();
  const stderr = writer();
  const result = await runPlaybookCli({
    argv: ['run', 'hello'],
    userConfigPath: configPath,
    env: { ANTHROPIC_API_KEY: 'a' },
    loadModule: async (specifier: string) => {
      if (specifier === 'mod://code') {
        return { default: codePlaybookRegistryEntry };
      }
      throw new Error(`no module ${specifier}`);
    },
    adapterImports,
    probeAdapterSdk: async () => true,
    sessionsDir: join(dir, 'sessions'),
    stdout,
    stderr,
    spawn: () => {
      throw new Error('headless run must not spawn tmux-play');
    },
  });
  expect(result.code).toBe(1);
  expect(stdout.text()).toBe('');
  expect(stderr.text()).toContain('playbook run:');
  expect(stderr.text()).toContain('999');
});
