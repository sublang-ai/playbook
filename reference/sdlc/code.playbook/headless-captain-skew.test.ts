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

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

it('keeps the committed compiled-JavaScript Captain lazy in plain Node', async () => {
  // The vitest resolver redirects `.js` imports to their `.ts` sources, so
  // the two tests around this one prove the source module. This leg proves
  // the committed compiled bytes themselves: a plain `node` subprocess —
  // no test resolution — imports the published module graph beside a stub
  // engine whose factory rejects, and the import must survive while the
  // first runtime request raises the rejection. An eagerly compiled module
  // dies at import here.
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const sandbox = await mkdtemp(join(tmpdir(), 'playbook-compiled-skew-'));
  tempDirs.push(sandbox);
  const artifactDir = join(sandbox, 'reference', 'sdlc', 'captain.playbook');
  await mkdir(artifactDir, { recursive: true });
  await mkdir(join(sandbox, 'src'), { recursive: true });
  // The published package declares `"type": "module"`, and the sandbox must
  // say so too: `--input-type=module` covers only the `-e` script, and on
  // supported Nodes older than 20.19 — the engines floor is 20.6 — a bare
  // `.js` beside no package.json parses as CommonJS instead of being
  // syntax-detected, failing the probe before laziness is ever tested.
  await writeFile(
    join(sandbox, 'package.json'),
    `${JSON.stringify({ type: 'module' })}\n`,
  );
  for (const file of ['captain.playbook.js', 'captain.fsm.js']) {
    await copyFile(
      join(repoRoot, 'reference', 'sdlc', 'captain.playbook', file),
      join(artifactDir, file),
    );
  }
  // Proxy the current engine surface and skew only factory construction, so
  // this fixture tests lazy construction without pinning the Captain's named
  // imports or pressuring production code to duplicate engine constants.
  const realEngineUrl = pathToFileURL(
    join(repoRoot, 'src', 'xstate-runtime.js'),
  ).href;
  await writeFile(
    join(sandbox, 'src', 'xstate-runtime.js'),
    [
      `export * from ${JSON.stringify(realEngineUrl)};`,
      'export function createXStatePlaybookRuntime(machine, spec) {',
      "  throw new TypeError('CAPTAIN spec.compat.runtimeAbi 999 does not match engine RUNTIME_ABI 1');",
      '}',
      '',
    ].join('\n'),
  );
  await symlink(join(repoRoot, 'node_modules'), join(sandbox, 'node_modules'));

  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        `const mod = await import(${JSON.stringify(
          join(artifactDir, 'captain.playbook.js'),
        )});`,
        "console.log('imported:' + typeof mod.default);",
        'try {',
        '  mod.createPlaybookRuntime({});',
        "  console.log('constructed');",
        '} catch (error) {',
        "  console.log('rejected:' + error.message);",
        '}',
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  expect(probe.stderr).toBe('');
  expect(probe.status).toBe(0);
  expect(probe.stdout).toContain('imported:function');
  expect(probe.stdout).toContain('rejected:CAPTAIN spec.compat.runtimeAbi 999');
  expect(probe.stdout).not.toContain('constructed');
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
