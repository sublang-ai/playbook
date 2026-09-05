// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
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
  concurrentRoleSets: string[][] = [],
  artifactSchema = 3,
  runtimeProfile: unknown = { kind: 'bespoke', artifactSchema },
) {
  return {
    id,
    command,
    intent: `${id} intent`,
    artifactSchema,
    runtimeProfile,
    requiredRoleIds,
    concurrentRoleSets,
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

function oneRoleConfig() {
  return {
    captain: 'claude',
    players: { 'dev.coder': 'codex' },
    playbooks: {
      code: { from: 'mod://code', roles: { coder: 'dev.coder' } },
    },
  };
}

async function writeSessionsConfig(configPath: string, sessions?: string) {
  await mkdir(dirname(configPath), { recursive: true });
  const source =
    sessions === undefined
      ? '{}\n'
      : `sessions: ${JSON.stringify(sessions)}\n`;
  await writeFile(configPath, source, 'utf8');
  return source;
}

function structuralProjection(plan: any) {
  const fixed = (agent: any) => ({
    adapter: agent.adapter,
    ...(agent.instruction === undefined
      ? {}
      : { instruction: agent.instruction }),
    ...(agent.permissions === undefined
      ? {}
      : { permissions: agent.permissions }),
  });
  return {
    schemaVersion: 1,
    captain: fixed(plan.captain),
    players: plan.players.map(({ id, agent }: any) => ({ id, ...fixed(agent) })),
    catalog: Object.fromEntries(
      Object.entries(plan.catalog).map(([id, item]: any) => [
        id,
        {
          id: item.id,
          from: item.from,
          manifestCommand: item.manifestCommand,
          command: item.command,
          intent: item.intent,
          artifactSchema: item.artifactSchema,
          requiredRoleIds: item.requiredRoleIds,
          concurrentRoleSets: item.concurrentRoleSets,
          roles: Object.fromEntries(
            Object.entries(item.roles).map(([role, binding]: any) => [
              role,
              { playerId: binding.playerId },
            ]),
          ),
          options: item.options,
        },
      ]),
    ),
  };
}

describe('sessions locator bootstrap (PBCLI-78)', () => {
  it('keeps the unset locator under Spex home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-sessions-default-'));
    tempDirs.push(root);
    const configPath = join(root, 'config', 'playbook.config.yaml');
    await writeSessionsConfig(configPath);

    expect(
      await launchConfig.resolveLaunchSessionsDir({
        userConfigPath: configPath,
        env: { SPEX_HOME: join(root, 'spex-home') },
        homeDir: join(root, 'home'),
      }),
    ).toBe(join(root, 'spex-home', 'sessions'));
    expect(
      await launchConfig.resolveLaunchSessionsDir({
        userConfigPath: configPath,
        env: {},
        homeDir: join(root, 'home'),
      }),
    ).toBe(
      join(root, 'home', '.spex', 'sessions'),
    );
  });

  it('expands only the current-user tilde forms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-sessions-tilde-'));
    tempDirs.push(root);
    const configPath = join(root, 'config', 'playbook.config.yaml');
    const homeDir = join(root, 'home');

    await writeSessionsConfig(configPath, '~');
    expect(
      await launchConfig.resolveLaunchSessionsDir({
        userConfigPath: configPath,
        homeDir,
      }),
    ).toBe(homeDir);

    await writeSessionsConfig(configPath, '~/shared/sessions');
    expect(
      await launchConfig.resolveLaunchSessionsDir({
        userConfigPath: configPath,
        homeDir,
      }),
    ).toBe(join(homeDir, 'shared', 'sessions'));

    await writeSessionsConfig(configPath, '~//shared/sessions');
    expect(
      await launchConfig.resolveLaunchSessionsDir({
        userConfigPath: configPath,
        homeDir,
      }),
    ).toBe(join(homeDir, 'shared', 'sessions'));

    for (const sessions of ['~peer', '~peer/sessions']) {
      await writeSessionsConfig(configPath, sessions);
      await expect(
        Promise.resolve().then(() =>
          launchConfig.resolveLaunchSessionsDir({
            userConfigPath: configPath,
            homeDir,
          }),
        ),
      ).rejects.toThrow();
    }
  });

  it(
    'preserves absolute spelling and anchors every relative form to the primary config',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'playbook-sessions-paths-'));
      tempDirs.push(root);
      const configPath = join(root, 'config', 'playbook.config.yaml');
      const primaryDir = dirname(configPath);
      const absolute = `${root}/absolute/../sessions`;

      await writeSessionsConfig(configPath, absolute);
      expect(
        await launchConfig.resolveLaunchSessionsDir({
          userConfigPath: configPath,
        }),
      ).toBe(absolute);

      for (const sessions of ['./dot-relative', 'bare-relative']) {
        await writeSessionsConfig(configPath, sessions);
        expect(
          await launchConfig.resolveLaunchSessionsDir({
            userConfigPath: configPath,
          }),
        ).toBe(join(primaryDir, sessions));
      }
    },
  );

  it(
    'applies overlays in order from the primary anchor without rewriting inputs',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'playbook-sessions-overlay-'));
      tempDirs.push(root);
      const configPath = join(root, 'config', 'playbook.config.yaml');
      const firstOverlayPath = join(root, 'overlays', 'first.yaml');
      const lastOverlayPath = join(root, 'elsewhere', 'last.yaml');
      const primary = await writeSessionsConfig(configPath, 'primary');
      const firstOverlay = 'sessions: "first"\n';
      const lastOverlay = 'sessions: "../last"\n';
      await mkdir(dirname(firstOverlayPath), { recursive: true });
      await mkdir(dirname(lastOverlayPath), { recursive: true });
      await writeFile(firstOverlayPath, firstOverlay, 'utf8');
      await writeFile(lastOverlayPath, lastOverlay, 'utf8');

      expect(
        await launchConfig.resolveLaunchSessionsDir({
          userConfigPath: configPath,
          overlayPaths: [firstOverlayPath, lastOverlayPath],
        }),
      ).toBe(join(root, 'last'));
      expect(await readFile(configPath, 'utf8')).toBe(primary);
      expect(await readFile(firstOverlayPath, 'utf8')).toBe(firstOverlay);
      expect(await readFile(lastOverlayPath, 'utf8')).toBe(lastOverlay);
    },
  );

  it('lets an injected directory precede an invalid configured locator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-sessions-injected-'));
    tempDirs.push(root);
    const configPath = join(root, 'config', 'playbook.config.yaml');
    const sessionsDir = join(root, 'injected');
    await writeSessionsConfig(configPath, '~peer');

    expect(
      await launchConfig.resolveLaunchSessionsDir({
        userConfigPath: configPath,
        sessionsDir,
      }),
    ).toBe(sessionsDir);
  });

  it(
    'does not prepare or traverse unrelated roots for selected bootstrap',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'playbook-sessions-selected-'));
      tempDirs.push(root);
      const configPath = join(root, 'config', 'playbook.config.yaml');
      await mkdir(dirname(configPath), { recursive: true });
      const source = [
        'sessions: selected-sessions',
        'playbooks:',
        '  poisoned: { players: { retired: missing-profile } }',
        '',
      ].join('\n');
      await writeFile(configPath, source, 'utf8');
      const onNotice = vi.fn();

      expect(
        await launchConfig.resolveLaunchSessionsDir({
          userConfigPath: configPath,
          preparePrimary: false,
          onNotice,
        }),
      ).toBe(join(dirname(configPath), 'selected-sessions'));
      expect(onNotice).not.toHaveBeenCalled();
      expect(await readFile(configPath, 'utf8')).toBe(source);
      await expect(access(`${configPath}.bak`)).rejects.toThrow();
    },
  );

  it('keeps sessions out of normalized and host projections', async () => {
    const plan = await launchConfig.normalizeLaunchPlan(
      { ...oneRoleConfig(), sessions: './shared-sessions' },
      {
        loadModule: moduleLoader({
          'mod://code': entry('code', ['coder']),
        }),
      },
    );
    const structural = structuralProjection(plan);
    const tmux = launchConfig.projectTmuxConfig(plan);

    expect(plan).not.toHaveProperty('sessions');
    expect(structural).not.toHaveProperty('sessions');
    expect(tmux).not.toHaveProperty('sessions');
    expect(tmux.captain.options).not.toHaveProperty('sessions');
  });
});

describe('shared launch-config plan (PBCLI-47)', () => {
  it('builds detached tagged session agents and an exact tmux projection', async () => {
    const top = {
      captain: { adapter: 'claude', model: 'captain-model' },
      players: {
        'dev.coder': {
          adapter: 'codex',
          model: 'coder-default',
          effort: 'high',
        },
        'dev.reviewer': { adapter: 'claude', instruction: 'Review carefully.' },
      },
      layout: { window: { columns: 120, rows: 42 } },
      notifications: { turn_finished: 'desktop' },
      theme: 'mocha',
      playbooks: {
        code: {
          from: 'mod://code',
          roles: {
            reviewer: 'dev.reviewer',
            coder: { player: 'dev.coder', model: 'coder-for-code' },
          },
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
    top.players['dev.coder'].model = 'mutated';
    top.playbooks.code.roles.coder.model = 'mutated';
    top.layout.window.columns = 1;

    expect(plan).toMatchObject({
      schemaVersion: 1,
      captain: {
        adapter: 'claude',
        model: { kind: 'value', value: 'captain-model' },
        effort: { kind: 'provider-default' },
      },
      players: [
        {
          id: 'dev.coder',
          agent: {
            adapter: 'codex',
            model: { kind: 'value', value: 'coder-default' },
            effort: { kind: 'value', value: 'high' },
          },
        },
        {
          id: 'dev.reviewer',
          agent: {
            adapter: 'claude',
            model: { kind: 'provider-default' },
            effort: { kind: 'provider-default' },
            instruction: 'Review carefully.',
          },
        },
      ],
      catalog: {
        code: {
          from: 'mod://code',
          manifestCommand: 'code',
          command: 'code',
          artifactSchema: 3,
          requiredRoleIds: ['coder', 'reviewer'],
          concurrentRoleSets: [],
          roles: {
            coder: {
              playerId: 'dev.coder',
              model: { kind: 'value', value: 'coder-for-code' },
              effort: { kind: 'value', value: 'high' },
            },
            reviewer: {
              playerId: 'dev.reviewer',
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
          },
          options: { policy: { levels: ['strict'] } },
        },
      },
      presentation: {
        layout: {
          window: { columns: 120, rows: 42 },
          initialVisible: ['dev.coder', 'dev.reviewer'],
          singlePlayerColumnWeights: [1, 1],
          multiPlayerColumnWeights: [1, 1, 1],
          columnWeights: [1, 1, 1],
        },
        notifications: {
          player_finished: 'off',
          turn_finished: 'desktop',
          turn_aborted: 'off',
        },
        theme: 'mocha',
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.players[0].agent.model)).toBe(true);
    expect(Object.isFrozen(plan.catalog.code.options.policy.levels)).toBe(true);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);

    const tmux = launchConfig.projectTmuxConfig(plan);
    expect(tmux.captain).toMatchObject({
      from: launchConfig.PLAYBOOK_CAPTAIN_MODULE,
      adapter: 'claude',
      model: 'captain-model',
    });
    expect(tmux.captain).not.toHaveProperty('effort');
    expect(tmux.captain.options).toEqual({
      playbooks: {
        code: {
          from: 'mod://code',
          command: 'code',
          roles: plan.catalog.code.roles,
          options: { policy: { levels: ['strict'] } },
        },
      },
      sessionAgents: {
        captain: plan.captain,
        players: {
          'dev.coder': plan.players[0].agent,
          'dev.reviewer': plan.players[1].agent,
        },
      },
      captainAdapter: 'claude',
    });
    expect(tmux.players).toEqual([
      {
        id: 'dev.coder',
        adapter: 'codex',
        model: 'coder-default',
        effort: 'high',
      },
      {
        id: 'dev.reviewer',
        adapter: 'claude',
        instruction: 'Review carefully.',
      },
    ]);
    expect(launchConfig.projectHostAgent(plan.players[1].agent)).toEqual({
      adapter: 'claude',
      instruction: 'Review carefully.',
    });
    expect(tmux.layout).not.toHaveProperty('columnWeights');
    await expect(launchConfig.normalizeHostConfig(tmux)).resolves.toMatchObject({
      layout: plan.presentation.layout,
    });

    tmux.captain.options.playbooks.code.roles.coder.playerId = 'changed';
    tmux.captain.options.sessionAgents.players['dev.coder'].adapter = 'claude';
    expect(plan.catalog.code.roles.coder.playerId).toBe('dev.coder');
    expect(plan.players[0].agent.adapter).toBe('codex');
  });

  it('accepts and projects a schema-3 registry advertisement', async () => {
    const plan = await launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
      loadModule: moduleLoader({
        'mod://code': entry('code', ['coder'], 'code', [], 3, {
          kind: 'shared-factory',
          compat: { artifactSchema: 3, runtimeAbi: 17 },
        }),
      }),
    });

    const structural = structuralProjection(plan);
    expect(plan.catalog.code.artifactSchema).toBe(3);
    expect(structural.catalog.code.artifactSchema).toBe(3);
    await expect(
      launchConfig.normalizeSelectedLaunchPlanDataOnly(oneRoleConfig(), {
        configPath: '/tmp/playbook.config.yaml',
        stored: structural,
      }),
    ).resolves.toMatchObject({
      catalog: { code: { artifactSchema: 3 } },
    });
  });

  it('snapshots every consumed registry member once before validation and projection', async () => {
    const consumed = [
      'id',
      'command',
      'intent',
      'artifactSchema',
      'runtimeProfile',
      'requiredRoleIds',
      'concurrentRoleSets',
      'validateOptions',
      'createRuntime',
    ] as const;
    const reads = Object.fromEntries(consumed.map((key) => [key, 0]));
    const manifest = new Proxy(entry('code', ['coder']), {
      get(target, key, receiver) {
        if (typeof key === 'string' && key in reads) {
          reads[key] += 1;
          if (key === 'artifactSchema' && reads[key] > 1) return 3;
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const plan = await launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
      loadModule: async () => ({ default: manifest }),
    });

    expect(reads).toEqual(
      Object.fromEntries(consumed.map((key) => [key, 1])),
    );
    expect(plan.catalog.code.artifactSchema).toBe(3);
  });

  it('rejects host capabilities from a stored structural projection', async () => {
    const plan = await launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
      loadModule: moduleLoader({
        'mod://code': entry('code', ['coder']),
      }),
    });
    const structural = structuralProjection(plan);
    structural.catalog.code.options = { hostCapabilities: {} };

    await expect(
      launchConfig.normalizeSelectedLaunchPlanDataOnly(oneRoleConfig(), {
        configPath: '/tmp/playbook.config.yaml',
        stored: structural,
      }),
    ).rejects.toThrow(
      'stored structural catalog.code.options.hostCapabilities is host-owned and cannot be configured',
    );
  });

  it('shares exact referenced ids and excludes unused players from roster and readiness', async () => {
    const plan = await launchConfig.normalizeLaunchPlan(
      {
        captain: 'claude',
        players: {
          'dev.shared': 'codex',
          'dev.reviewer': 'claude',
          'unused.offline': 'gemini',
        },
        playbooks: {
          code: {
            from: 'mod://code',
            roles: { coder: 'dev.shared' },
          },
          review: {
            from: 'mod://review',
            roles: {
              coder: 'dev.shared',
              reviewer: 'dev.reviewer',
            },
          },
        },
      },
      {
        loadModule: moduleLoader({
          'mod://code': entry('code', ['coder']),
          'mod://review': entry('review', ['coder', 'reviewer']),
        }),
      },
    );

    expect(plan.players.map((player: { id: string }) => player.id)).toEqual([
      'dev.shared',
      'dev.reviewer',
    ]);
    expect(plan.catalog.code.roles.coder.playerId).toBe('dev.shared');
    expect(plan.catalog.review.roles.coder.playerId).toBe('dev.shared');
    expect(plan.presentation.layout.initialVisible).toEqual(['dev.shared']);
    expect(launchConfig.adaptersFromLaunchPlan(plan)).toEqual([
      'claude',
      'codex',
    ]);
    expect(launchConfig.projectTmuxConfig(plan).players).toHaveLength(2);
  });

  it('lets one role explicitly reset shared concrete tuning to provider defaults', async () => {
    const plan = await launchConfig.normalizeLaunchPlan(
      {
        captain: 'claude',
        players: {
          // This authored id collides with the first validation-only tuning
          // candidate; two overridden roles also require distinct checks.
          'binding-check-0': 'claude',
          'dev.shared': {
            adapter: 'codex',
            model: 'shared-model',
            effort: 'high',
          },
        },
        playbooks: {
          review: {
            from: 'mod://review',
            roles: {
              coder: { player: 'dev.shared', effort: 'xhigh' },
              reviewer: {
                player: 'dev.shared',
                model: false,
                effort: false,
              },
            },
          },
        },
      },
      {
        loadModule: moduleLoader({
          'mod://review': entry('review', ['coder', 'reviewer']),
        }),
      },
    );

    expect(plan.players[0].agent).toMatchObject({
      model: { kind: 'value', value: 'shared-model' },
      effort: { kind: 'value', value: 'high' },
    });
    expect(plan.catalog.review.roles.coder).toMatchObject({
      model: { kind: 'value', value: 'shared-model' },
      effort: { kind: 'value', value: 'xhigh' },
    });
    expect(plan.catalog.review.roles.reviewer).toMatchObject({
      model: { kind: 'provider-default' },
      effort: { kind: 'provider-default' },
    });
    expect(
      launchConfig.projectTmuxConfig(plan).players[0],
    ).toMatchObject({ model: 'shared-model', effort: 'high' });
    expect(plan.players.map((player: { id: string }) => player.id)).toEqual([
      'dev.shared',
    ]);
  });

  it.each([
    ['an empty authored roster', {}],
    ['an unreferenced authored player', { 'release.worker': 'codex' }],
  ])(
    'keeps a manifest with no delegated work exactly roleless with %s',
    async (_case, players) => {
      const plan = await launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          players,
          playbooks: {
            checklist: { from: 'mod://checklist', roles: {} },
          },
        },
        {
          loadModule: moduleLoader({
            'mod://checklist': entry('checklist', []),
          }),
        },
      );

      expect(plan.catalog.checklist.requiredRoleIds).toEqual([]);
      expect(plan.catalog.checklist.roles).toEqual({});
      expect(plan.players).toEqual([]);
      expect(plan.presentation.layout.initialVisible).toEqual([]);
      expect(plan.presentation.layout.columnWeights).toEqual([1]);
      expect(launchConfig.adaptersFromLaunchPlan(plan)).toEqual(['claude']);
      const tmux = launchConfig.projectTmuxConfig(plan);
      expect(tmux.players).toEqual([]);
      expect(tmux.layout.initialVisible).toEqual([]);
      await expect(
        launchConfig.normalizeHostConfig(tmux),
      ).resolves.toMatchObject({
        players: [],
        layout: { initialVisible: [], columnWeights: [1] },
      });
    },
  );

  it('validates an authored player even when no role references it', async () => {
    const prepareRegistryModule = vi.fn();
    const loadModule = vi.fn();
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          players: {
            'unused.worker': { adapter: 'codex', effort: 'impossible' },
          },
          playbooks: {
            checklist: { from: 'mod://checklist', roles: {} },
          },
        },
        { prepareRegistryModule, loadModule },
      ),
    ).rejects.toThrow(/effort/);
    expect(prepareRegistryModule).not.toHaveBeenCalled();
    expect(loadModule).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rejects unsupported role fastMode=%s before registry work',
    async (fastMode) => {
      const prepareRegistryModule = vi.fn();
      const loadModule = vi.fn();
      await expect(
        launchConfig.normalizeLaunchPlan(
          {
            captain: 'claude',
            players: { 'dev.coder': 'gemini' },
            playbooks: {
              code: {
                from: 'mod://code',
                roles: {
                  coder: { player: 'dev.coder', fastMode },
                },
              },
            },
          },
          { prepareRegistryModule, loadModule },
        ),
      ).rejects.toThrow(/fastMode.*not supported.*gemini/i);
      expect(prepareRegistryModule).not.toHaveBeenCalled();
      expect(loadModule).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'rejects unsupported selected role fastMode=%s before registry work',
    async (fastMode) => {
      const initial = await launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          players: { 'dev.coder': 'gemini' },
          playbooks: {
            code: {
              from: 'mod://code',
              roles: { coder: 'dev.coder' },
            },
          },
        },
        {
          loadModule: moduleLoader({
            'mod://code': entry('code', ['coder']),
          }),
        },
      );
      const prepareRegistryModule = vi.fn();
      const loadModule = vi.fn();
      await expect(
        launchConfig.normalizeSelectedLaunchPlanDataOnly(
          {
            captain: 'claude',
            players: { 'dev.coder': 'gemini' },
            playbooks: {
              code: {
                from: 'mod://code',
                roles: {
                  coder: { player: 'dev.coder', fastMode },
                },
              },
            },
          },
          {
            configPath: '/tmp/playbook.config.yaml',
            stored: structuralProjection(initial),
            prepareRegistryModule,
            loadModule,
          },
        ),
      ).rejects.toThrow(/fastMode.*not supported.*gemini/i);
      expect(prepareRegistryModule).not.toHaveBeenCalled();
      expect(loadModule).not.toHaveBeenCalled();
    },
  );

  it('rejects configured host capabilities before registry preparation', async () => {
    const prepareRegistryModule = vi.fn();
    const loadModule = vi.fn();
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          ...oneRoleConfig(),
          playbooks: {
            code: {
              ...oneRoleConfig().playbooks.code,
              hostCapabilities: {},
            },
          },
        },
        { prepareRegistryModule, loadModule },
      ),
    ).rejects.toThrow(
      'playbooks.code.hostCapabilities is host-owned and cannot be configured',
    );
    expect(prepareRegistryModule).not.toHaveBeenCalled();
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('shows the first roleful playbook when a roleless one is enabled first', async () => {
    const plan = await launchConfig.normalizeLaunchPlan(
      {
        captain: 'claude',
        players: {
          'dev.coder': 'codex',
          'unused.reviewer': 'claude',
        },
        playbooks: {
          checklist: { from: 'mod://checklist', roles: {} },
          code: { from: 'mod://code', roles: { coder: 'dev.coder' } },
        },
      },
      {
        loadModule: moduleLoader({
          'mod://checklist': entry('checklist', []),
          'mod://code': entry('code', ['coder']),
        }),
      },
    );

    expect(plan.presentation.layout.initialVisible).toEqual(['dev.coder']);
    expect(plan.presentation.layout.columnWeights).toEqual([1, 1]);
    expect(plan.players.map((player: { id: string }) => player.id)).toEqual([
      'dev.coder',
    ]);
    await expect(
      launchConfig.normalizeHostConfig(
        launchConfig.projectTmuxConfig(plan),
      ),
    ).resolves.toMatchObject({
      layout: { initialVisible: ['dev.coder'] },
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
    expect(launchConfig.canonicalizeRegistrySpecifier(from, configPath)).toBe(
      expected,
    );
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

  it('canonicalizes once, prepares every registry before importing any', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-launch-config-'));
    tempDirs.push(root);
    const configPath = join(root, 'config', 'playbook.config.yaml');
    const overlayPath = join(root, 'overlays', 'last.yaml');
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(overlayPath), { recursive: true });
    await writeFile(
      configPath,
      [
        'captain: claude',
        'players: { dev.coder: codex, dev.reviewer: claude }',
        'playbooks:',
        '  code: { from: ./base.js, roles: { coder: dev.coder } }',
        '  review: { from: ./review.js, roles: { reviewer: dev.reviewer } }',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      overlayPath,
      'playbooks: { code: { from: ../registries/code.js } }\n',
      'utf8',
    );

    const events: string[] = [];
    const plan = await launchConfig.loadLaunchPlan({
      userConfigPath: configPath,
      overlayPaths: [overlayPath],
      prepareRegistryModule: async ({ id, from }) => {
        events.push(`prepare:${id}:${from}`);
        return from.startsWith('file:')
          ? `${from.replace(/\.js$/, '.prepared.js')}`
          : `${from}?prepared`;
      },
      loadModule: async (specifier) => {
        events.push(`load:${specifier}`);
        const id = specifier.includes('code') ? 'code' : 'review';
        return {
          default: entry(id, id === 'code' ? ['coder'] : ['reviewer']),
        };
      },
    });

    expect(events.map((event) => event.split(':')[0])).toEqual([
      'prepare',
      'prepare',
      'load',
      'load',
    ]);
    const expectedCode = pathToFileURL(
      join(dirname(configPath), '..', 'registries', 'code.js'),
    ).href;
    expect(plan.catalog.code.from).toBe(
      expectedCode.replace(/\.js$/, '.prepared.js'),
    );
  });

  it.each([
    ['whitespace', ' mod://code', /canonical trimmed module specifier/],
    ['relative path', '../rewired.js', /canonical module specifier/],
    ['absolute path', '/tmp/rewired.js', /canonical module specifier/],
  ])('rejects a noncanonical prepared %s before import', async (_case, prepared, expected) => {
    const loadModule = vi.fn();
    await expect(
      launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
        prepareRegistryModule: async () => prepared,
        loadModule,
      }),
    ).rejects.toThrow(expected);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it.each([
    ['playbook id', { ...oneRoleConfig(), playbooks: { ' code': oneRoleConfig().playbooks.code } }],
    [
      'configured module',
      {
        ...oneRoleConfig(),
        playbooks: {
          code: { ...oneRoleConfig().playbooks.code, from: ' mod://code' },
        },
      },
    ],
    [
      'command override',
      {
        ...oneRoleConfig(),
        playbooks: {
          code: { ...oneRoleConfig().playbooks.code, command: ' code' },
        },
      },
    ],
  ])('rejects a noncanonical %s before preparation', async (_case, config) => {
    const prepareRegistryModule = vi.fn();
    const loadModule = vi.fn();
    await expect(
      launchConfig.normalizeLaunchPlan(config, {
        prepareRegistryModule,
        loadModule,
      }),
    ).rejects.toThrow(/canonical trimmed/);
    expect(prepareRegistryModule).not.toHaveBeenCalled();
    expect(loadModule).not.toHaveBeenCalled();
  });

  it.each([
    ['manifest id', { id: ' code' }],
    ['manifest command', { command: ' code' }],
  ])('rejects a noncanonical %s immediately after import', async (_case, mutation) => {
    await expect(
      launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
        loadModule: async () => ({
          default: { ...entry('code', ['coder']), ...mutation },
        }),
      }),
    ).rejects.toThrow(/canonical trimmed/);
  });

  it('normalizes legacy player effort only in the detached overlay plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-legacy-effort-'));
    tempDirs.push(root);
    const configPath = join(root, 'playbook.config.yaml');
    const overlayPath = join(root, 'legacy-effort.yaml');
    const source = [
      'captain: claude',
      'players:',
      '  dev.coder: { adapter: codex }',
      'playbooks:',
      '  code: { from: mod://code, roles: { coder: dev.coder } }',
      '',
    ].join('\n');
    const overlay = [
      'players:',
      '  dev.coder: { reasoningEffort: high }',
      '',
    ].join('\n');
    await writeFile(configPath, source, 'utf8');
    await writeFile(overlayPath, overlay, 'utf8');

    const plan = await launchConfig.loadLaunchPlan({
      userConfigPath: configPath,
      overlayPaths: [overlayPath],
      loadModule: moduleLoader({
        'mod://code': entry('code', ['coder']),
      }),
    });

    expect(plan.players[0].agent.effort).toEqual({
      kind: 'value',
      value: 'high',
    });
    expect(plan.players[0].agent).not.toHaveProperty('reasoningEffort');
    expect(launchConfig.projectTmuxConfig(plan).players[0]).toMatchObject({
      id: 'dev.coder',
      effort: 'high',
    });
    expect(await readFile(configPath, 'utf8')).toBe(source);
    expect(await readFile(overlayPath, 'utf8')).toBe(overlay);
  });

  it('rejects legacy per-playbook players before profile migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-legacy-players-'));
    tempDirs.push(root);
    const configPath = join(root, 'playbook.config.yaml');
    const source = [
      'profiles:',
      '  worker: { adapter: codex }',
      'captain: claude',
      'playbooks:',
      '  code:',
      '    from: mod://code',
      '    players: { coder: worker }',
      '',
    ].join('\n');
    await writeFile(configPath, source, 'utf8');
    const loadModule = vi.fn();

    await expect(
      launchConfig.loadLaunchPlan({ userConfigPath: configPath, loadModule }),
    ).rejects.toThrow(/explicit-session-player major release.*top-level players.*roles/);
    expect(loadModule).not.toHaveBeenCalled();
    expect(await readFile(configPath, 'utf8')).toBe(source);
    await expect(access(`${configPath}.bak`)).rejects.toThrow();
  });

  it('migrates retired profiles only for Captain and top-level players', () => {
    const source = [
      'profiles:',
      '  judge: { adapter: claude, model: judge-model }',
      '  worker: { adapter: codex, model: worker-model }',
      'captain: judge',
      'players:',
      '  dev.coder: { profile: worker, model: role-default }',
      'playbooks:',
      '  code: { from: mod://code, roles: { coder: dev.coder } }',
      '',
    ].join('\n');
    const migratedText = launchConfig.migrateRetiredProfiles(source);
    const migrated = parseYaml(migratedText!);

    expect(migrated.profiles).toBeUndefined();
    expect(migrated.captain).toEqual({
      adapter: 'claude',
      model: 'judge-model',
    });
    expect(migrated.players['dev.coder']).toEqual({
      adapter: 'codex',
      model: 'role-default',
    });
    expect(migratedText).toContain('Migrated by playbook 3.0.0');
  });

  it('projects stored members before access, cloning, validation, or hooks', async () => {
    class UnselectedValue {
      invalid = undefined;
    }
    const poison = vi.fn(() => {
      throw new Error('unselected member was accessed');
    });
    const players: Record<string, unknown> = {
      'dev.coder': 'codex',
      'unused.class': new UnselectedValue(),
    };
    Object.defineProperty(players, 'Bad Player', {
      enumerable: true,
      get: poison,
    });
    const playbooks: Record<string, unknown> = {
      code: { from: 'mod://code', roles: { coder: 'dev.coder' } },
      classed: new UnselectedValue(),
    };
    Object.defineProperty(playbooks, 'poison', {
      enumerable: true,
      get: poison,
    });
    const events: string[] = [];

    const plan = await launchConfig.normalizeLaunchPlan(
      { captain: 'claude', players, playbooks },
      {
        selectedMembers: {
          playbookIds: ['code'],
          playerIds: ['dev.coder'],
        },
        prepareRegistryModule: async ({ id, from }) => {
          events.push(`prepare:${id}`);
          return from;
        },
        loadModule: async () => {
          events.push('load:code');
          return { default: entry('code', ['coder']) };
        },
      },
    );

    expect(poison).not.toHaveBeenCalled();
    expect(events).toEqual(['prepare:code', 'load:code']);
    expect(Object.keys(plan.catalog)).toEqual(['code']);
    expect(plan.players.map((player: { id: string }) => player.id)).toEqual([
      'dev.coder',
    ]);
  });

  it.each(['config', 'playbooks', 'players'])(
    'rejects a selected %s class instance before hooks',
    async (path) => {
      class ConfigRecord {
        captain = 'claude';
        players: Record<string, unknown> = { 'dev.coder': 'codex' };
        playbooks: Record<string, unknown> = {
          code: { from: 'mod://code', roles: { coder: 'dev.coder' } },
        };
      }
      const plain = oneRoleConfig();
      const top: Record<string, unknown> =
        path === 'config'
          ? (new ConfigRecord() as unknown as Record<string, unknown>)
          : {
              ...plain,
              [path]: Object.assign(
                Object.create(ConfigRecord.prototype),
                plain[path as 'playbooks' | 'players'],
              ),
            };
      const prepareRegistryModule = vi.fn();
      const loadModule = vi.fn();

      await expect(
        launchConfig.normalizeLaunchPlan(top, {
          selectedMembers: {
            playbookIds: ['code'],
            playerIds: ['dev.coder'],
          },
          prepareRegistryModule,
          loadModule,
        }),
      ).rejects.toThrow(/must contain only plain JSON objects/);
      expect(prepareRegistryModule).not.toHaveBeenCalled();
      expect(loadModule).not.toHaveBeenCalled();
    },
  );

  it('reopens only stored members without rewriting or inspecting additions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-selected-reopen-'));
    tempDirs.push(root);
    const configPath = join(root, 'playbook.config.yaml');
    const source = [
      'captain: claude',
      'theme: mocha',
      'players:',
      '  dev.coder: codex',
      '  Bad Player: { adapter: unknown, extra: true }',
      'playbooks:',
      '  code: { from: mod://code, roles: { coder: dev.coder } }',
      '  added:',
      '    from: mod://added',
      '    players: { legacy: missing-profile }',
      '',
    ].join('\n');
    await writeFile(configPath, source, 'utf8');
    const notices: string[] = [];
    const prepareRegistryModule = vi.fn(async ({ from }) => from);
    const loadModule = vi.fn(async () => ({
      default: entry('code', ['coder']),
    }));

    const plan = await launchConfig.loadLaunchPlan({
      userConfigPath: configPath,
      selectedMembers: {
        playbookIds: ['code'],
        playerIds: ['dev.coder'],
      },
      prepareRegistryModule,
      loadModule,
      onNotice: (notice: string) => notices.push(notice),
    });

    expect(Object.keys(plan.catalog)).toEqual(['code']);
    expect(plan.players.map((player: { id: string }) => player.id)).toEqual([
      'dev.coder',
    ]);
    expect(plan.presentation.theme).toBe('mocha');
    expect(prepareRegistryModule).toHaveBeenCalledTimes(1);
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
    expect(await readFile(configPath, 'utf8')).toBe(source);
    await expect(access(`${configPath}.bak`)).rejects.toThrow();
  });

  it('projects a selected launch from stored catalog data without preparation or import', async () => {
    const initial = await launchConfig.normalizeLaunchPlan(
      {
        captain: 'claude',
        players: {
          'dev.coder': 'codex',
          'dev.reviewer': 'claude',
        },
        playbooks: {
          code: {
            from: 'mod://code',
            roles: {
              coder: 'dev.coder',
              reviewer: 'dev.reviewer',
            },
          },
        },
      },
      {
        loadModule: moduleLoader({
          'mod://code': entry('code', ['coder', 'reviewer']),
        }),
      },
    );
    const structural = structuralProjection(initial);
    const root = await mkdtemp(join(tmpdir(), 'playbook-selected-data-only-'));
    tempDirs.push(root);
    const configPath = join(root, 'playbook.config.yaml');
    await writeFile(
      configPath,
      [
        'captain: { adapter: claude, model: current-captain }',
        'players:',
        '  dev.coder: { adapter: codex, model: current-player, effort: high }',
        '  dev.reviewer: { adapter: claude, model: current-reviewer }',
        'playbooks:',
        '  code:',
        '    from: mod://code',
        '    roles: { reviewer: dev.reviewer, coder: dev.coder }',
        '',
      ].join('\n'),
      'utf8',
    );
    const prepareRegistryModule = vi.fn();
    const loadModule = vi.fn();

    const plan = await launchConfig.loadSelectedLaunchPlanDataOnly({
      userConfigPath: configPath,
      structuralProjection: structural,
      prepareRegistryModule,
      loadModule,
    });

    expect(prepareRegistryModule).not.toHaveBeenCalled();
    expect(loadModule).not.toHaveBeenCalled();
    expect(plan.captain.model).toEqual({
      kind: 'value',
      value: 'current-captain',
    });
    expect(plan.players[0].agent).toMatchObject({
      model: { kind: 'value', value: 'current-player' },
      effort: { kind: 'value', value: 'high' },
    });
    expect(plan.catalog.code).toMatchObject({
      from: 'mod://code',
      manifestCommand: 'code',
      requiredRoleIds: ['coder', 'reviewer'],
      roles: {
        coder: {
          playerId: 'dev.coder',
          model: { kind: 'value', value: 'current-player' },
          effort: { kind: 'value', value: 'high' },
        },
        reviewer: {
          playerId: 'dev.reviewer',
          model: { kind: 'value', value: 'current-reviewer' },
          effort: { kind: 'provider-default' },
        },
      },
    });
  });

  it('merges selected overlay members without traversing poisoned additions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-selected-overlay-'));
    tempDirs.push(root);
    const configPath = join(root, 'playbook.config.yaml');
    const overlayPath = join(root, 'selected.yaml');
    await writeFile(
      configPath,
      [
        'captain: claude',
        'players:',
        '  dev.coder: codex',
        '  added.bad: { adapter: missing }',
        'playbooks:',
        '  code: { from: mod://code, roles: { coder: dev.coder } }',
        '  added: { from: mod://added, roles: { coder: added.bad } }',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      overlayPath,
      [
        'players:',
        '  dev.coder: { adapter: codex, model: current-model }',
        '  added.bad: { permissions: { mode: impossible } }',
        'playbooks:',
        '  code: { roles: { coder: dev.coder }, option: current }',
        '  added: { players: { retired: true } }',
        '',
      ].join('\n'),
      'utf8',
    );
    const events: string[] = [];
    const plan = await launchConfig.loadLaunchPlan({
      userConfigPath: configPath,
      overlayPaths: [overlayPath],
      selectedMembers: {
        playbookIds: ['code'],
        playerIds: ['dev.coder'],
      },
      prepareRegistryModule: async ({ id, from }) => {
        events.push(`prepare:${id}`);
        return from;
      },
      loadModule: async (specifier: string) => {
        events.push(`load:${specifier}`);
        return { default: entry('code', ['coder']) };
      },
    });

    expect(events).toEqual(['prepare:code', 'load:mod://code']);
    expect(plan.players).toMatchObject([
      {
        id: 'dev.coder',
        agent: { model: { kind: 'value', value: 'current-model' } },
      },
    ]);
    expect(plan.catalog.code.options).toEqual({ option: 'current' });
    expect(plan.catalog).not.toHaveProperty('added');
  });

  it('admits a selected member first supplied by a later overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playbook-selected-late-overlay-'));
    tempDirs.push(root);
    const configPath = join(root, 'playbook.config.yaml');
    const overlayPath = join(root, 'selected.yaml');
    await writeFile(
      configPath,
      ['captain: claude', 'players: {}', 'playbooks: {}', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      overlayPath,
      [
        'players: { dev.coder: codex }',
        'playbooks:',
        '  code: { from: mod://code, roles: { coder: dev.coder } }',
        '',
      ].join('\n'),
      'utf8',
    );

    const plan = await launchConfig.loadLaunchPlan({
      userConfigPath: configPath,
      overlayPaths: [overlayPath],
      selectedMembers: {
        playbookIds: ['code'],
        playerIds: ['dev.coder'],
      },
      loadModule: moduleLoader({
        'mod://code': entry('code', ['coder']),
      }),
    });

    expect(Object.keys(plan.catalog)).toEqual(['code']);
    expect(plan.players.map((player: { id: string }) => player.id)).toEqual([
      'dev.coder',
    ]);
  });

  it('rejects a missing selected member before preparation or import', async () => {
    const prepareRegistryModule = vi.fn();
    const loadModule = vi.fn();
    await expect(
      launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
        selectedMembers: {
          playbookIds: ['code', 'review'],
          playerIds: ['dev.coder'],
        },
        prepareRegistryModule,
        loadModule,
      }),
    ).rejects.toThrow(/selected playbooks member "review" is missing/);
    expect(prepareRegistryModule).not.toHaveBeenCalled();
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('rejects an unknown selected-members key before hooks', async () => {
    const prepareRegistryModule = vi.fn();
    const loadModule = vi.fn();
    await expect(
      launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
        selectedMembers: {
          playbookIds: ['code'],
          playerIds: ['dev.coder'],
          players: ['dev.coder'],
        },
        prepareRegistryModule,
        loadModule,
      }),
    ).rejects.toThrow(/selectedMembers has unknown key "players"/);
    expect(prepareRegistryModule).not.toHaveBeenCalled();
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('rejects a selected accessor without invoking it', async () => {
    const getter = vi.fn(() => 'codex');
    const players: Record<string, unknown> = {};
    Object.defineProperty(players, 'dev.coder', {
      enumerable: true,
      get: getter,
    });
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          players,
          playbooks: oneRoleConfig().playbooks,
        },
        {
          selectedMembers: {
            playbookIds: ['code'],
            playerIds: ['dev.coder'],
          },
          loadModule: vi.fn(),
        },
      ),
    ).rejects.toThrow(/players\.dev\.coder must be an enumerable data property/);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects malformed retained config through installed cligent before hooks', async () => {
    const invalid: unknown[] = [
      { ...oneRoleConfig(), layoutt: {} },
      { ...oneRoleConfig(), layout: 'wide' },
      { ...oneRoleConfig(), captain: { adapter: 'missing' } },
      { ...oneRoleConfig(), captain: { adapter: 'claude', model: '' } },
      {
        ...oneRoleConfig(),
        players: { 'dev.coder': { adapter: 'codex', extra: true } },
      },
      {
        ...oneRoleConfig(),
        players: { 'dev.coder': { adapter: 'codex', model: '' } },
      },
      {
        ...oneRoleConfig(),
        playbooks: {
          code: {
            from: 'mod://code',
            roles: { coder: { player: 'dev.coder', adapter: 'claude' } },
          },
        },
      },
      {
        ...oneRoleConfig(),
        playbooks: {
          code: {
            from: 'mod://code',
            roles: { coder: { player: 'dev.coder', model: true } },
          },
        },
      },
      {
        ...oneRoleConfig(),
        players: { captain: 'codex' },
        playbooks: {
          code: { from: 'mod://code', roles: { coder: 'captain' } },
        },
      },
      {
        ...oneRoleConfig(),
        players: { 'dev.coder': { adapter: 'codex', effort: 'extreme' } },
      },
    ];
    for (const config of invalid) {
      const prepareRegistryModule = vi.fn();
      const loadModule = vi.fn();
      await expect(
        launchConfig.normalizeLaunchPlan(config, {
          prepareRegistryModule,
          loadModule,
        }),
      ).rejects.toThrow();
      expect(prepareRegistryModule).not.toHaveBeenCalled();
      expect(loadModule).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['artifact schema 1', { artifactSchema: 1 }],
    [
      'artifact schema 2',
      {
        artifactSchema: 2,
        runtimeProfile: { kind: 'bespoke', artifactSchema: 2 },
      },
    ],
    ['artifact schema 4', { artifactSchema: 4 }],
    ['missing runtime profile', { runtimeProfile: undefined }],
    [
      'shared-factory schema skew',
      {
        runtimeProfile: {
          kind: 'shared-factory',
          compat: { artifactSchema: 2, runtimeAbi: 1 },
        },
      },
    ],
    [
      'bespoke schema skew',
      { runtimeProfile: { kind: 'bespoke', artifactSchema: 2 } },
    ],
    [
      'malformed shared-factory compat',
      {
        runtimeProfile: {
          kind: 'shared-factory',
          compat: { artifactSchema: 3, runtimeAbi: 1, extra: true },
        },
      },
    ],
    [
      'noninteger shared-factory ABI',
      {
        runtimeProfile: {
          kind: 'shared-factory',
          compat: { artifactSchema: 3, runtimeAbi: 1.5 },
        },
      },
    ],
    ['missing concurrent sets', { concurrentRoleSets: undefined }],
    ['one-role concurrent set', { concurrentRoleSets: [['coder']] }],
    ['unknown concurrent role', { concurrentRoleSets: [['coder', 'other']] }],
    ['duplicate concurrent role', { concurrentRoleSets: [['coder', 'coder']] }],
    ['noncanonical role', { requiredRoleIds: ['Coder'] }],
    ['canonical collision', { requiredRoleIds: ['coder', 'Coder'] }],
  ])('rejects a registry with %s', async (_case, mutation) => {
    const malformed = { ...entry('code', ['coder']), ...mutation };
    await expect(
      launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
        loadModule: async () => ({ default: malformed }),
      }),
    ).rejects.toThrow(/no valid registry entry/);
  });

  it('binds non-ASCII canonical local role ids and refuses noncanonical ones', async () => {
    const loadModule = moduleLoader({
      'mod://zh': entry('zh', ['编码者', '审查者'], 'zh'),
    });
    const zhConfig = () => ({
      captain: 'claude',
      players: { 'dev.coder': 'codex', 'dev.reviewer': 'claude' },
      playbooks: {
        zh: {
          from: 'mod://zh',
          roles: { 编码者: 'dev.coder', 审查者: 'dev.reviewer' },
        },
      },
    });

    const plan = await launchConfig.normalizeLaunchPlan(zhConfig(), {
      loadModule,
    });
    expect(plan.catalog.zh.requiredRoleIds).toEqual(['编码者', '审查者']);
    expect(Object.keys(plan.catalog.zh.roles)).toEqual(['编码者', '审查者']);
    expect(plan.catalog.zh.roles.编码者.playerId).toBe('dev.coder');
    expect(plan.catalog.zh.roles.审查者.playerId).toBe('dev.reviewer');
    expect(plan.players.map((player: any) => player.id)).toEqual([
      'dev.coder',
      'dev.reviewer',
    ]);

    const refused: Array<[string, RegExp]> = [
      ['Coder', /must be a canonical lowercase local role id/],
      ['code r', /must be a canonical lowercase local role id/],
      ['captain', /binds local role "captain", which is reserved/],
    ];
    for (const [roleKey, message] of refused) {
      const config: any = oneRoleConfig();
      config.playbooks.code.roles = { [roleKey]: 'dev.coder' };
      const rejectingLoad = vi.fn();
      await expect(
        launchConfig.normalizeLaunchPlan(config, {
          loadModule: rejectingLoad,
        }),
      ).rejects.toThrow(message);
      expect(rejectingLoad).not.toHaveBeenCalled();
    }
    await expect(
      launchConfig.normalizeLaunchPlan(oneRoleConfig(), {
        loadModule: moduleLoader({ 'mod://code': entry('code', ['编码 者']) }),
      }),
    ).rejects.toThrow(/no valid registry entry/);
  });

  it('requires exact role coverage and distinct concurrent players', async () => {
    const loadDecide = moduleLoader({
      'mod://decide': entry(
        'decide',
        ['coder', 'reviewer'],
        'decide',
        [['coder', 'reviewer']],
      ),
    });
    const base = {
      captain: 'claude',
      players: { 'dev.shared': 'codex', 'dev.other': 'claude' },
    };
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          ...base,
          playbooks: {
            decide: {
              from: 'mod://decide',
              roles: { coder: 'dev.shared' },
            },
          },
        },
        { loadModule: loadDecide },
      ),
    ).rejects.toThrow(/must exactly cover requiredRoleIds.*missing "reviewer"/);
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          ...base,
          playbooks: {
            decide: {
              from: 'mod://decide',
              roles: {
                coder: 'dev.shared',
                reviewer: 'dev.other',
                observer: 'dev.other',
              },
            },
          },
        },
        { loadModule: loadDecide },
      ),
    ).rejects.toThrow(/must exactly cover requiredRoleIds.*extra "observer"/);
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          ...base,
          playbooks: {
            decide: {
              from: 'mod://decide',
              roles: {
                coder: 'dev.shared',
                reviewer: 'dev.shared',
              },
            },
          },
        },
        { loadModule: loadDecide },
      ),
    ).rejects.toThrow(/pairwise-distinct player ids/);
  });

  it('carries option slices without duplicating shell-owned validation', async () => {
    const validateOptions = vi.fn(() => {
      throw new Error('shell-owned validator ran in launcher');
    });
    const manifest = {
      ...entry('code', ['coder']),
      validateOptions,
    };
    const plan = await launchConfig.normalizeLaunchPlan(
      {
        ...oneRoleConfig(),
        playbooks: {
          code: {
            from: 'mod://code',
            roles: { coder: 'dev.coder' },
            workflowOption: { exact: true },
          },
        },
      },
      { loadModule: async () => ({ default: manifest }) },
    );
    expect(validateOptions).not.toHaveBeenCalled();
    expect(plan.catalog.code.options).toEqual({
      workflowOption: { exact: true },
    });
  });

  it('rejects unknown players and non-JSON retained values before hooks', async () => {
    const loadModule = vi.fn();
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          ...oneRoleConfig(),
          playbooks: {
            code: { from: 'mod://code', roles: { coder: 'dev.missing' } },
          },
        },
        { loadModule },
      ),
    ).rejects.toThrow(/unknown player "dev\.missing"/);

    const getterConfig = oneRoleConfig();
    getterConfig.players['dev.coder'] = { adapter: 'codex' } as never;
    Object.defineProperty(getterConfig.players['dev.coder'], 'model', {
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
          ...oneRoleConfig(),
          playbooks: {
            code: {
              from: 'mod://code',
              roles: { coder: 'dev.coder' },
              sparse,
            },
          },
        },
        { loadModule },
      ),
    ).rejects.toThrow(/sparse array slots/);
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
    expect(launchConfig.projectHostAgent).toBeTypeOf('function');
  });

  it('ships the explicit shared-player starter topology', async () => {
    const template = parseYaml(
      readFileSync(
        fileURLToPath(
          new URL('./playbook.config.template.yaml', import.meta.url),
        ),
        'utf8',
      ),
    );
    expect(Object.keys(template.players)).toEqual([
      'dev.coder',
      'dev.reviewer',
      'dev.analyst',
    ]);
    expect(template.playbooks.code.roles).toEqual({ coder: 'dev.coder' });
    expect(template.playbooks.review.roles).toEqual({
      coder: 'dev.coder',
      reviewer: 'dev.reviewer',
    });
    expect(template.playbooks.decide.roles).toEqual(
      template.playbooks.review.roles,
    );
    // DR-044: the DEV planner binds a distinct seeded player, so planning
    // context cannot bleed into the shared review conversation.
    expect(template.playbooks.dev.roles).toEqual({ analyst: 'dev.analyst' });
    expect(template.players['dev.analyst']).toEqual({
      adapter: 'claude',
      model: 'claude-opus-5',
      effort: 'xhigh',
      permissions: { mode: 'auto' },
    });
    for (const block of Object.values(template.playbooks)) {
      expect(block).not.toHaveProperty('players');
    }
    const plan = await launchConfig.normalizeLaunchPlan(template, {
      loadModule: moduleLoader({
        '@sublang/playbook/code/registry': entry('code', ['coder']),
        '@sublang/playbook/review/registry': entry('review', [
          'coder',
          'reviewer',
        ]),
        '@sublang/playbook/decide/registry': entry(
          'decide',
          ['coder', 'reviewer'],
          'decide',
          [['coder', 'reviewer']],
        ),
        '@sublang/playbook/dev/registry': entry('dev', ['analyst']),
      }),
    });
    expect(plan.players.map((player: { id: string }) => player.id)).toEqual([
      'dev.coder',
      'dev.reviewer',
      'dev.analyst',
    ]);
  });
});

describe('adapter-scoped fast mode', () => {
  it('composes player and role fast mode, and erases it from structure', async () => {
    const plan: any = await launchConfig.normalizeLaunchPlan(
      {
        captain: { adapter: 'claude', fastMode: true },
        players: {
          'dev.coder': { adapter: 'codex', fastMode: true },
          'dev.reviewer': { adapter: 'claude' },
        },
        playbooks: {
          code: {
            from: 'mod://code',
            roles: {
              // `false` is a literal request, not an inherited omission.
              coder: { player: 'dev.coder', fastMode: false },
              reviewer: 'dev.reviewer',
            },
          },
        },
      },
      {
        loadModule: moduleLoader({
          'mod://code': entry('code', ['coder', 'reviewer']),
        }),
      },
    );

    expect(plan.captain.fastMode).toBe(true);
    const coder = plan.players.find((p: any) => p.id === 'dev.coder');
    expect(coder.agent.fastMode).toBe(true);
    const reviewer = plan.players.find((p: any) => p.id === 'dev.reviewer');
    expect(reviewer.agent).not.toHaveProperty('fastMode');

    // The role override beats the player default; an omitted role inherits.
    expect(plan.catalog.code.roles.coder.fastMode).toBe(false);
    expect(plan.catalog.code.roles.reviewer).not.toHaveProperty('fastMode');

    // It reaches cligent through the host projection...
    const tmux: any = launchConfig.projectTmuxConfig(plan);
    expect(tmux.captain.fastMode).toBe(true);

    // ...but never participates in structural identity, so toggling it
    // cannot force a fresh Captain session.
    expect(JSON.stringify(structuralProjection(plan))).not.toContain(
      'fastMode',
    );
  });

  it('inherits the player default when a role omits fast mode', async () => {
    const plan: any = await launchConfig.normalizeLaunchPlan(
      {
        captain: 'claude',
        players: { 'dev.coder': { adapter: 'codex', fastMode: true } },
        playbooks: {
          code: { from: 'mod://code', roles: { coder: 'dev.coder' } },
        },
      },
      {
        loadModule: moduleLoader({ 'mod://code': entry('code', ['coder']) }),
      },
    );
    expect(plan.catalog.code.roles.coder.fastMode).toBe(true);
  });

  it('refuses a non-boolean fast mode on a player or a role', async () => {
    const load = {
      loadModule: moduleLoader({ 'mod://code': entry('code', ['coder']) }),
    };
    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          players: { 'dev.coder': { adapter: 'codex', fastMode: 'yes' } },
          playbooks: {
            code: { from: 'mod://code', roles: { coder: 'dev.coder' } },
          },
        },
        load,
      ),
    ).rejects.toThrow(/fastMode/);

    await expect(
      launchConfig.normalizeLaunchPlan(
        {
          captain: 'claude',
          players: { 'dev.coder': 'codex' },
          playbooks: {
            code: {
              from: 'mod://code',
              roles: { coder: { player: 'dev.coder', fastMode: 'yes' } },
            },
          },
        },
        load,
      ),
    ).rejects.toThrow(/fastMode must be a boolean/);
  });
});
