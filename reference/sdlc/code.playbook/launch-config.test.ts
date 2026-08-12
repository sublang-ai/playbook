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
) {
  return {
    id,
    command,
    intent: `${id} intent`,
    artifactSchema: 2,
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
          artifactSchema: 2,
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
        return `${from}?prepared`;
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
    expect(plan.catalog.code.from).toBe(`${expectedCode}?prepared`);
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
      {
        ...oneRoleConfig(),
        players: { 'dev.coder': { adapter: 'codex', extra: true } },
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
    ]);
    expect(template.playbooks.code.roles).toEqual({ coder: 'dev.coder' });
    expect(template.playbooks.review.roles).toEqual({
      coder: 'dev.coder',
      reviewer: 'dev.reviewer',
    });
    expect(template.playbooks.decide.roles).toEqual(
      template.playbooks.review.roles,
    );
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
      }),
    });
    expect(plan.players.map((player: { id: string }) => player.id)).toEqual([
      'dev.coder',
      'dev.reviewer',
    ]);
  });
});
