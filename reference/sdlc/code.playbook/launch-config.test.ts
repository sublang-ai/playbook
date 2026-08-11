// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as launchConfig from './bin/launch-config.js';
import * as launcher from './bin/playbook.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function entry(
  id: string,
  requiredRoleIds: string[],
  command = id,
) {
  return {
    id,
    command,
    intent: `${id} intent`,
    requiredRoleIds,
    validateOptions: () => ({}),
    createRuntime: () => ({}),
  };
}

function moduleLoader(entries: Record<string, ReturnType<typeof entry>>) {
  return async (specifier: string) => {
    const value = entries[specifier];
    if (value === undefined) throw new Error(`missing ${specifier}`);
    return { default: value };
  };
}

describe('shared launch-config plan (PBCLI-47)', () => {
  it('builds one detached frozen JSON plan and a separate tmux projection', async () => {
    const top = {
      captain: { adapter: 'claude', model: 'captain-model' },
      layout: { window: { width: 120, height: 42 } },
      notifications: { turn_finished: 'desktop' },
      theme: { palette: { accent: 'cyan' } },
      playbooks: {
        code: {
          from: 'mod://code',
          players: {
            coder: { adapter: 'codex', model: 'coder-model' },
            reviewer: 'claude',
          },
          committer: 'coder',
          policy: { levels: ['strict'] },
        },
      },
    };
    const plan = await launchConfig.normalizeLaunchPlan(top, {
      loadModule: moduleLoader({
        'mod://code': entry('code', ['coder', 'reviewer']),
      }),
    });

    top.captain.model = 'mutated';
    top.playbooks.code.players.coder.model = 'mutated';
    top.layout.window.width = 1;

    expect(plan).toMatchObject({
      schemaVersion: 1,
      captain: { adapter: 'claude', model: 'captain-model' },
      players: [
        {
          id: 'code-coder',
          playbookId: 'code',
          roleId: 'coder',
          agent: { adapter: 'codex', model: 'coder-model' },
        },
        {
          id: 'code-reviewer',
          playbookId: 'code',
          roleId: 'reviewer',
          agent: { adapter: 'claude' },
        },
      ],
      catalog: {
        code: {
          from: 'mod://code',
          command: 'code',
          playerIds: {
            coder: 'code-coder',
            reviewer: 'code-reviewer',
          },
          options: {
            committer: 'coder',
            policy: { levels: ['strict'] },
          },
        },
      },
      presentation: {
        layout: {
          window: { width: 120, height: 42 },
          initialVisible: ['code-coder', 'code-reviewer'],
        },
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.players[0].agent)).toBe(true);
    expect(Object.isFrozen(plan.catalog.code.options.policy.levels)).toBe(true);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);

    const tmux = launchConfig.projectTmuxConfig(plan);
    expect(tmux.captain).toMatchObject({
      from: launchConfig.PLAYBOOK_CAPTAIN_MODULE,
      adapter: 'claude',
      model: 'captain-model',
    });
    expect(tmux.captain.options).toEqual({
      playbooks: {
        code: {
          from: 'mod://code',
          options: {
            committer: 'coder',
            policy: { levels: ['strict'] },
          },
        },
      },
      captainAdapter: 'claude',
    });
    expect(tmux.players).toEqual([
      { id: 'code-coder', adapter: 'codex', model: 'coder-model' },
      { id: 'code-reviewer', adapter: 'claude' },
    ]);
    tmux.layout.window.width = 2;
    tmux.theme.palette.accent = 'red';
    tmux.captain.options.playbooks.code.options.policy.levels[0] = 'loose';
    expect(plan.presentation.layout.window.width).toBe(120);
    expect(plan.presentation.theme.palette.accent).toBe('cyan');
    expect(plan.catalog.code.options.policy.levels[0]).toBe('strict');

    expect(launchConfig.adaptersFromLaunchPlan(plan)).toEqual([
      'claude',
      'codex',
    ]);
    expect(
      launchConfig.deriveLaunchReadiness(
        plan,
        { ANTHROPIC_API_KEY: 'ready' },
        '/missing-home',
      ),
    ).toEqual({
      adapters: ['claude', 'codex'],
      failingAdapters: ['codex'],
      unknownAdapters: [],
    });
  });

  it.each([
    ['relative', './registry.js', 'config/registry.js'],
    ['parent-relative', '../registry.js', 'registry.js'],
    ['absolute', '/tmp/shared-registry.js', '/tmp/shared-registry.js'],
  ])('anchors a %s configured filesystem module to the primary config', (_case, from, expectedPath) => {
    const configPath = '/tmp/config/playbook.config.yaml';
    const expected = pathToFileURL(
      expectedPath.startsWith('/') ? expectedPath : join('/tmp', expectedPath),
    ).href;
    expect(
      launchConfig.canonicalizeRegistrySpecifier(from, configPath),
    ).toBe(expected);
  });

  it.each([
    ['file URL', 'file:///tmp/registry.js'],
    ['bare package', '@scope/playbook/registry'],
    ['custom specifier', 'mod://registry'],
  ])('preserves a %s configured module specifier', (_case, from) => {
    expect(
      launchConfig.canonicalizeRegistrySpecifier(
        from,
        '/tmp/config/playbook.config.yaml',
      ),
    ).toBe(from);
  });

  it('canonicalizes once, prepares before import, and uses the prepared specifier in the catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-launch-config-'));
    tempDirs.push(root);
    const configPath = join(root, 'config', 'playbook.config.yaml');
    const firstOverlay = join(root, 'overlays', 'first.yaml');
    const secondOverlay = join(root, 'overlays', 'second.yaml');
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(firstOverlay), { recursive: true });
    const base = [
      'captain: claude',
      'playbooks:',
      '  code:',
      '    from: ./base-registry.js',
      '    players:',
      '      coder: { adapter: codex, model: base }',
      '',
    ].join('\n');
    await writeFile(configPath, base, 'utf8');
    await writeFile(
      firstOverlay,
      'playbooks: { code: { players: { coder: { adapter: codex, model: one } } } }\n',
      'utf8',
    );
    await writeFile(
      secondOverlay,
      [
        'playbooks:',
        '  code:',
        '    from: ../registries/code.js',
        '    players:',
        '      coder: { adapter: codex, model: two }',
        '',
      ].join('\n'),
      'utf8',
    );

    const events: string[] = [];
    const expected = pathToFileURL(
      join(dirname(configPath), '..', 'registries', 'code.js'),
    ).href;
    const prepared = `${expected}?prepared=1`;
    const plan = await launchConfig.loadLaunchPlan({
      userConfigPath: configPath,
      overlayPaths: [firstOverlay, secondOverlay],
      prepareRegistryModule: async ({ from, authoredFrom }) => {
        events.push(`prepare:${from}:${authoredFrom}`);
        return prepared;
      },
      loadModule: async (specifier) => {
        events.push(`load:${specifier}`);
        return { default: entry('code', ['coder']) };
      },
    });

    expect(events).toEqual([
      `prepare:${expected}:../registries/code.js`,
      `load:${prepared}`,
    ]);
    expect(plan.catalog.code.from).toBe(prepared);
    expect(plan.players[0].agent.model).toBe('two');
    expect(await readFile(configPath, 'utf8')).toBe(base);
    expect(
      launchConfig.projectTmuxConfig(plan).captain.options.playbooks.code.from,
    ).toBe(prepared);
  });

  it('keeps launcher authority and rejects ambiguous generated identities', async () => {
    const load = moduleLoader({
      'mod://code': entry('code', ['coder']),
    });
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: { adapter: 'claude', from: 'attacker' },
          playbooks: {
            code: {
              from: 'mod://code',
              players: { coder: 'codex' },
            },
          },
        },
        { loadModule: load },
      ),
    ).rejects.toThrow(/captain\.from is launcher-owned/);
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          playbooks: {
            code: {
              from: 'mod://code',
              players: { coder: { adapter: 'codex', id: 'attacker' } },
            },
          },
        },
        { loadModule: load },
      ),
    ).rejects.toThrow(/players\.coder\.id is launcher-owned/);
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: '   ',
          playbooks: {
            code: {
              from: 'mod://code',
              players: { coder: 'codex' },
            },
          },
        },
        { loadModule: load },
      ),
    ).rejects.toThrow(/captain must name an adapter/);

    const collisionLoader = moduleLoader({
      'mod://a-b': entry('a-b', ['c']),
      'mod://a': entry('a', ['b-c']),
    });
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          playbooks: {
            'a-b': { from: 'mod://a-b', players: { c: 'claude' } },
            a: { from: 'mod://a', players: { 'b-c': 'codex' } },
          },
        },
        { loadModule: collisionLoader },
      ),
    ).rejects.toThrow(/generated host player id "a-b-c" is not unique/);

    const projected = launchConfig.projectTmuxConfig({
      captain: { adapter: 'claude', from: 'attacker', options: {} },
      players: [
        {
          id: 'code-coder',
          agent: { adapter: 'codex', id: 'attacker' },
        },
      ],
      catalog: {},
      presentation: { layout: {} },
    });
    expect(projected.captain.from).toBe(
      launchConfig.PLAYBOOK_CAPTAIN_MODULE,
    );
    expect(projected.players[0].id).toBe('code-coder');
  });

  it('treats prototype-shaped ids and option keys as own data', async () => {
    const players = Object.fromEntries([['__proto__', 'codex']]);
    const block = Object.fromEntries([
      ['from', 'mod://prototype'],
      ['players', players],
      ['__proto__', { safe: true }],
    ]);
    const playbooks = Object.fromEntries([['__proto__', block]]);
    const plan = await launchConfig.normalizeLaunchPlan(
      { captain: 'claude', playbooks },
      {
        loadModule: async () => ({
          default: entry('__proto__', ['__proto__'], 'prototype'),
        }),
      },
    );

    expect(Object.hasOwn(plan.catalog, '__proto__')).toBe(true);
    expect(Object.hasOwn(plan.catalog.__proto__.playerIds, '__proto__')).toBe(
      true,
    );
    expect(Object.hasOwn(plan.catalog.__proto__.options, '__proto__')).toBe(
      true,
    );
    expect(plan.catalog.__proto__.options.__proto__).toEqual({ safe: true });
  });

  it.each([
    [
      'command',
      {
        captain: 'claude',
        playbooks: {
          code: {
            from: 'mod://code',
            command: '   ',
            players: { coder: 'codex' },
          },
        },
      },
    ],
    [
      'role',
      {
        captain: 'claude',
        playbooks: {
          code: {
            from: 'mod://code',
            players: { '   ': 'codex' },
          },
        },
      },
    ],
    [
      'player adapter',
      {
        captain: 'claude',
        playbooks: {
          code: {
            from: 'mod://code',
            players: { coder: '   ' },
          },
        },
      },
    ],
  ])('rejects a blank %s before registry import', async (_case, config) => {
    const loadModule = vi.fn();
    await expect(
      launchConfig.normalizeLaunchPlan(config, { loadModule }),
    ).rejects.toThrow();
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('prepares the complete catalog before importing any registry', async () => {
    const loadModule = vi.fn();
    const prepareRegistryModule = vi.fn(async ({ id }: { id: string }) => {
      if (id === 'review') throw new Error('cannot provision review');
    });
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          playbooks: {
            code: {
              from: 'mod://code',
              players: { coder: 'codex' },
            },
            review: {
              from: 'mod://review',
              players: { reviewer: 'claude' },
            },
          },
        },
        { loadModule, prepareRegistryModule },
      ),
    ).rejects.toThrow(/cannot provision review/);
    expect(prepareRegistryModule).toHaveBeenCalledTimes(2);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('orders every successful preparation before the first import', async () => {
    const events: string[] = [];
    await launchConfig.normalizeLaunchPlan(
      {
        captain: 'claude',
        playbooks: {
          code: {
            from: 'mod://code',
            players: { coder: 'codex' },
          },
          review: {
            from: 'mod://review',
            players: { reviewer: 'claude' },
          },
        },
      },
      {
        prepareRegistryModule: async ({ id, from }) => {
          events.push(`prepare:${id}`);
          return `${from}?ready`;
        },
        loadModule: async (from) => {
          events.push(`load:${from}`);
          const id = from.includes('code') ? 'code' : 'review';
          return {
            default: entry(
              id,
              id === 'code' ? ['coder'] : ['reviewer'],
            ),
          };
        },
      },
    );
    expect(events).toEqual([
      'prepare:code',
      'prepare:review',
      'load:mod://code?ready',
      'load:mod://review?ready',
    ]);
  });

  it('rejects non-JSON config before loading a registry', async () => {
    const loadModule = vi.fn();
    const getterConfig = {
      captain: { adapter: 'claude' },
      playbooks: {
        code: { from: 'mod://code', players: { coder: 'codex' } },
      },
    };
    Object.defineProperty(getterConfig.captain, 'model', {
      enumerable: true,
      get: () => 'surprise',
    });
    await expect(
      launchConfig.normalizeLaunchPlan(getterConfig, { loadModule }),
    ).rejects.toThrow(/enumerable data property/);

    const sparse = new Array(2);
    sparse[1] = 'value';
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          playbooks: {
            code: {
              from: 'mod://code',
              players: { coder: 'codex' },
              sparse,
            },
          },
        },
        { loadModule },
      ),
    ).rejects.toThrow(/sparse array slots/);

    const accessorArray = ['safe'];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => 'surprise',
    });
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          playbooks: {
            code: {
              from: 'mod://code',
              players: { coder: 'codex' },
              accessorArray,
            },
          },
        },
        { loadModule },
      ),
    ).rejects.toThrow(/enumerable data property/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const invalid of [
      undefined,
      Number.NaN,
      Symbol('value'),
      new Date('2026-01-01T00:00:00Z'),
      cyclic,
    ]) {
      await expect(
        launchConfig.normalizeLaunchPlan(
          {
            captain: 'claude',
            playbooks: {
              code: {
                from: 'mod://code',
                players: { coder: 'codex' },
                invalid,
              },
            },
          },
          { loadModule },
        ),
      ).rejects.toThrow();
    }
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('keeps the config module leaf-only and re-exports compatibility helpers', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./bin/launch-config.js', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain("from './playbook.js'");
    expect(source).not.toContain("from './run.js'");
    for (const name of [
      'PLAYBOOK_CAPTAIN_MODULE',
      'canonicalizeRegistrySpecifier',
      'composeGenericConfig',
      'loadLaunchPlan',
      'normalizeLaunchPlan',
      'projectTmuxConfig',
      'resolveUserConfigPath',
    ]) {
      expect(launcher[name as keyof typeof launcher]).toBe(
        launchConfig[name as keyof typeof launchConfig],
      );
    }
  });
});
