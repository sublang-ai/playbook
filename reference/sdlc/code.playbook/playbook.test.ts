// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_RUNTIME_TARGETS,
  classifyRuntime,
  type RuntimeReadiness,
  type RuntimeTarget,
} from '@sublang/cligent';
import { loadTmuxPlayConfig } from '@sublang/cligent/tmux-play';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const playbook = await import(
  new URL('./bin/playbook.js', import.meta.url).href
);
const adapterSdk = await import(
  new URL('./bin/adapter-sdk.js', import.meta.url).href
);
const {
  EngineProvisioningError,
  prepareConfiguredRegistries,
  provisionEngine,
} = await import(
  new URL('./bin/provision.js', import.meta.url).href
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
  it('normalizes inline agents/playbooks into a composed tmux-play config', async () => {
    const top = {
      captain: { adapter: 'claude', model: 'm-judge' },
      layout: { window: { columns: 100, rows: 40 } },
      notifications: { player_finished: 'bell', turn_finished: 'desktop' },
      theme: 'mocha',
      playbooks: {
        code: {
          from: 'mod://code',
          players: {
            coder: { adapter: 'codex', model: 'm-agent' },
            reviewer: { adapter: 'claude' },
          },
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
    // Option slice carries non-launcher keys (committer); no players.
    expect(config.captain.options.playbooks.code).toEqual({
      from: 'mod://code',
      command: 'code',
      options: { committer: 'coder' },
    });
    // Namespaced <id>-<role> roster; scalar profile + full block resolved.
    expect(config.players).toEqual([
      { id: 'code-coder', adapter: 'codex', model: 'm-agent' },
      { id: 'code-reviewer', adapter: 'claude' },
    ]);
    // Launcher owns initialVisible (first playbook's generated players);
    // user window field carried through.
    expect(config.layout).toMatchObject({
      window: { columns: 100, rows: 40 },
      initialVisible: ['code-coder', 'code-reviewer'],
    });
    // Top-level host fields (notifications, theme) use cligent normalization.
    expect(config.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
      turn_aborted: 'off',
    });
    expect(config.theme).toBe('mocha');
    // DR-013 A1: the shell cannot read its captain's adapter from the
    // tmux-play context, so the launcher passes the resolved one through.
    expect(config.captain.options.captainAdapter).toBe('claude');
    expect(playbooks).toEqual([
      { id: 'code', command: 'code', intent: fakeEntry.intent },
    ]);
  });

  it('applies a command override and a full inline captain block', async () => {
    const top = {
      captain: { adapter: 'claude', model: 'm', effort: 'high' },
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
      effort: 'high',
    });
    expect(config.captain).not.toHaveProperty('profile');
    expect(config.captain.options.playbooks.code.command).toBe('dev');
    expect(playbooks[0].command).toBe('dev');
  });
});

// PBCLI-32: the live release gate (RELEASE-24) is excluded from `pnpm test`
// and CI, so a config-model change can break its fixture and only surface
// during a manual pre-tag run. Compose that exact fixture here.
// PBCLI-33 (DR-021 §3): an existing profiles-based config rewrites itself
// once, keeping the original, so a user launches without hand-editing.
describe('playbook launcher — config migration (PBCLI-33)', () => {
  const legacyConfig = [
    '# SPDX-License-Identifier: Apache-2.0',
    '',
    '# Generic `playbook` launcher config.',
    '',
    '# Reusable agent settings.',
    'profiles:',
    '  claude-opus:',
    '    adapter: claude',
    '    model: m-captain',
    '    permissions:',
    '      mode: auto',
    '  codex-gpt:',
    '    adapter: codex',
    '    model: m-review',
    '',
    '# Host notifications.',
    'notifications:',
    '  player_finished: bell',
    'captain: claude-opus',
    'playbooks:',
    '  code:',
    '    from: "@sublang/playbook/code/registry"',
    '    players:',
    '      coder: { profile: claude-opus, model: m-coder }',
    '      reviewer: codex-gpt',
    '    committer: coder',
    '',
  ].join('\n');

  async function launchWith(config: string) {
    const home = await makeTempHome();
    const configPath = resolveUserConfigPath({}, home);
    await writeUserConfig(home, config);
    const spawn = fakeSpawn();
    const stderr = writer();
    const result = await runPlaybookCli({
      argv: ['--list'],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stdout: writer() as never,
      stderr: stderr as never,
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });
    return { home, configPath, result, stderr: stderr.text() };
  }

  it('inlines profiles in place, keeps a backup, and launches', async () => {
    const { configPath, result, stderr } = await launchWith(legacyConfig);

    expect(result).toEqual({ code: 0 });
    expect(stderr).toContain('migrated');
    expect(stderr).toContain(`${configPath}.bak`);

    const migrated = parseYaml(await readFile(configPath, 'utf8'));
    expect(migrated.profiles).toBeUndefined();
    expect(migrated.captain).toEqual({
      adapter: 'claude',
      model: 'm-captain',
      permissions: { mode: 'auto' },
    });
    // A `profile`-bearing block keeps its own fields over the profile's.
    expect(migrated.playbooks.code.players.coder).toEqual({
      adapter: 'claude',
      model: 'm-coder',
      permissions: { mode: 'auto' },
    });
    expect(migrated.playbooks.code.players.reviewer).toEqual({
      adapter: 'codex',
      model: 'm-review',
    });
    // Untouched keys and the user's comments survive the rewrite.
    expect(migrated.notifications).toEqual({ player_finished: 'bell' });
    const text = await readFile(configPath, 'utf8');
    expect(text).toContain('# SPDX-License-Identifier: Apache-2.0');
    expect(text).toContain('# Host notifications.');
    expect(text).toContain('Migrated by playbook 3.0.0');

    // The backup is the pre-migration file, byte for byte.
    expect(await readFile(`${configPath}.bak`, 'utf8')).toBe(legacyConfig);
  });

  it('keeps comments attached to a scalar agent', async () => {
    const { configPath } = await launchWith(
      [
        'profiles:',
        '  base: { adapter: claude, model: m1 }',
        '# why this captain',
        'captain: base # the judge agent',
        'playbooks:',
        '  code:',
        '    from: "@sublang/playbook/code/registry"',
        '    players:',
        '      coder: base',
        '      reviewer: codex',
        '',
      ].join('\n'),
    );
    const text = await readFile(configPath, 'utf8');
    // Both the line above the agent and the note on the agent itself.
    expect(text).toContain('# why this captain');
    expect(text).toContain('# the judge agent');
  });

  it('carries a profile setting\'s own comments into every agent', async () => {
    const { configPath } = await launchWith(
      [
        'profiles:',
        '  base:',
        '    adapter: claude',
        '    # the codex sandbox needs git metadata',
        '    permissions:',
        '      mode: auto',
        'captain: base',
        'playbooks:',
        '  code:',
        '    from: "@sublang/playbook/code/registry"',
        '    players:',
        '      coder: { profile: base, effort: xhigh }',
        '      reviewer: codex',
        '',
      ].join('\n'),
    );
    const text = await readFile(configPath, 'utf8');
    // Once for the scalar captain, once for the profile-bearing block: both
    // paths carry the comment that rode on the setting's key.
    expect(
      text.split('# the codex sandbox needs git metadata').length - 1,
    ).toBe(2);
  });

  it('rejects an unresolvable profile without touching the config', async () => {
    const broken = [
      'profiles:',
      '  base: { adapter: claude }',
      'captain: base',
      'playbooks:',
      '  code:',
      '    from: "@sublang/playbook/code/registry"',
      '    players:',
      '      coder: { profile: nope, model: m2 }',
      '      reviewer: codex',
      '',
    ].join('\n');
    const { configPath, result, stderr } = await launchWith(broken);

    expect(result.code).not.toBe(0);
    expect(stderr).toContain('nope');
    expect(stderr).toContain(configPath);
    // The active config is untouched and no backup was written, so the
    // user still has exactly one file to fix.
    expect(await readFile(configPath, 'utf8')).toBe(broken);
    await expect(readFile(`${configPath}.bak`, 'utf8')).rejects.toThrow();
  });

  it('migrates once and never overwrites an existing backup', async () => {
    const { home, configPath } = await launchWith(legacyConfig);
    const afterFirst = await readFile(configPath, 'utf8');

    // A second launch has nothing to migrate.
    const spawn = fakeSpawn();
    const stderr = writer();
    await runPlaybookCli({
      argv: ['--list'],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stdout: writer() as never,
      stderr: stderr as never,
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
    });
    expect(stderr.text()).not.toContain('migrated');
    expect(await readFile(configPath, 'utf8')).toBe(afterFirst);

    // A fresh legacy config beside an existing .bak picks the next free name.
    await writeUserConfig(home, legacyConfig);
    const second = fakeSpawn();
    await runPlaybookCli({
      argv: ['--list'],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stdout: writer() as never,
      stderr: writer() as never,
      spawn: second.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    });
    expect(await readFile(`${configPath}.bak.2`, 'utf8')).toBe(legacyConfig);
  });
});

describe('live acceptance gate config (PBCLI-32)', () => {
  it('composes through the real launcher with the real registries', async () => {
    const { liveConfig } = await import(
      new URL('../../../acceptance/live-config.ts', import.meta.url).href
    );
    const top = parseYaml(liveConfig());
    const { config, playbooks } = await composeGenericConfig(
      top,
      (specifier: string) => import(specifier),
    );

    expect(playbooks.map((p: any) => p.id).sort()).toEqual([
      'code',
      'decide',
      'review',
    ]);
    expect(config.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(config.captain.adapter).toBe('claude');
    // The pane titles the gate asserts derive from these generated ids.
    expect(config.players.map((p: any) => `${p.id} ${p.adapter}`)).toEqual([
      'code-coder claude',
      'review-coder claude',
      'review-reviewer codex',
      'decide-coder claude',
      'decide-reviewer codex',
    ]);
  });

  it('composes the conversational config with its real fixture modules', async () => {
    const { conversationConfig } = await import(
      new URL('../../../acceptance/live-config.ts', import.meta.url).href
    );
    const { checklistFixtureSource, notesFixtureSource } = await import(
      new URL('../../../acceptance/live-fixtures.ts', import.meta.url).href
    );
    // Compose the way the gate does: the generated fixture modules on disk
    // under the exact names the config's `from` URLs name, resolved by the
    // real loader. Stub entries would make the ids and commands below
    // self-fulfilling; importing the sources instead builds both machines
    // and applies the runtime factory at module scope, so a fixture that no
    // longer links fails here rather than during a manual pre-tag run.
    // Scope: a fixture's own `@sublang/playbook/xstate-runtime` import
    // resolves through the package export to the committed `src/*.js`
    // sibling, not to the `.ts` this suite loads, so what fails here is
    // fixture drift against the released engine surface — engine *source*
    // drift stays the CI sibling drift check's job (RELEASE-10).
    const repo = await mkdtemp(join(tmpdir(), 'playbook-live-conversation-'));
    tempDirs.push(repo);
    await writeFile(
      join(repo, 'checklist.registry.mjs'),
      checklistFixtureSource(join(repo, 'checklist.flag')),
      'utf8',
    );
    await writeFile(
      join(repo, 'notes.registry.mjs'),
      notesFixtureSource(),
      'utf8',
    );

    const top = parseYaml(conversationConfig(repo));
    const { config, playbooks } = await composeGenericConfig(
      top,
      (specifier: string) => import(specifier),
    );

    // Both fixtures enable, and the commands the Captain offers are the
    // fixture modules' own — the session drives `/checklist` and switches to
    // `notes` by name.
    expect(playbooks.map((p: any) => `${p.id} ${p.command}`)).toEqual([
      'checklist checklist',
      'notes notes',
    ]);
    expect(config.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(config.captain.adapter).toBe('claude');
    // One bound-but-unused claude role per fixture, namespaced the same way.
    expect(config.players.map((p: any) => `${p.id} ${p.adapter}`)).toEqual([
      'checklist-worker claude',
      'notes-worker claude',
    ]);
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
    // DR-021: the user's own config migrates (PBCLI-33); anything that still
    // carries the retired model here — a --with overlay, say — is rejected
    // rather than silently misread, since a scalar that named a profile now
    // reads as an adapter shorthand.
    await expect(
      composeGenericConfig(
        {
          profiles: { 'claude-opus': { adapter: 'claude' } },
          captain: 'claude',
          playbooks: { code: { from: 'mod://code', players } },
        },
        ld,
      ),
    ).rejects.toThrow(/top-level "profiles" was removed/);
    await expect(
      composeGenericConfig(
        {
          captain: { profile: 'base' },
          playbooks: { code: { from: 'mod://code', players } },
        },
        ld,
      ),
    ).rejects.toThrow(/captain\.profile was removed/);
    await expect(
      composeGenericConfig(
        {
          captain: 'claude',
          playbooks: {
            code: {
              from: 'mod://code',
              players: { coder: { profile: 'base' }, reviewer: 'codex' },
            },
          },
        },
        ld,
      ),
    ).rejects.toThrow(/playbooks\.code\.players\.coder\.profile was removed/);
  });

  it('rejects the reserved captain role with a diagnostic naming it', async () => {
    // Manifest fault: the entry itself requires the reserved role, so the
    // diagnostic names it even though the players map satisfies coverage.
    await expect(
      composeGenericConfig(
        {
          captain: 'claude',
          playbooks: {
            t2g: { from: 'mod://t2g', players: { worker: 'claude' } },
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

  it('rejects the reserved internal Captain id and command', async () => {
    await expect(
      composeGenericConfig(
        {
          captain: 'claude',
          playbooks: {
            captain: {
              from: 'mod://code',
              players,
            },
          },
        },
        ld,
      ),
    ).rejects.toThrow(/reserved internal Captain id/);

    await expect(
      composeGenericConfig(
        {
          captain: 'claude',
          playbooks: {
            code: {
              from: 'mod://code',
              command: 'captain',
              players,
            },
          },
        },
        ld,
      ),
    ).rejects.toThrow(/reserved internal Captain command/);
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
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
    });

    expect(result).toEqual({ code: 0 });
    const seeded = await readFile(configPath, 'utf8');
    expect(seeded).toContain('@sublang/playbook/code/registry');
    expect(seeded).toContain('@sublang/playbook/review/registry');
    expect(seeded).toContain('@sublang/playbook/decide/registry');
    expect(seeded).toContain('claude-opus-4-8[1m]');
    expect(seeded).toContain('gpt-5.5');
    expect(seeded).not.toContain('committer:');
    expect(seeded).toContain('.git');
    expect(stderr.text()).toContain(`created config at ${configPath}`);

    // PBCLI-11/13 (DR-021): the seed writes each agent's settings inline
    // and ships no profiles map, so retuning one player cannot move another.
    const seededParsed = parseYaml(seeded);
    expect(seededParsed.profiles).toBeUndefined();
    expect(seededParsed.captain).toMatchObject({
      adapter: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
      permissions: { mode: 'auto' },
    });
    expect(seededParsed.playbooks.code.players).toEqual({
      coder: {
        adapter: 'claude',
        model: 'claude-opus-4-8[1m]',
        effort: 'xhigh',
        permissions: { mode: 'auto' },
      },
    });
    expect(seededParsed.playbooks.review.players).toEqual({
      coder: {
        adapter: 'claude',
        model: 'claude-opus-4-8[1m]',
        effort: 'xhigh',
        permissions: { mode: 'auto' },
      },
      reviewer: {
        adapter: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        permissions: { mode: 'auto', writablePaths: ['.git'] },
      },
    });
    expect(seededParsed.playbooks.decide.players).toEqual(
      seededParsed.playbooks.review.players,
    );

    expect(spawn.calls).toHaveLength(1);
    const composed = parseYaml(spawn.configs[0].content);
    expect(composed.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(composed.captain).toMatchObject({
      adapter: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
      // PBCLI-11: every seeded agent, including the claude Captain, runs in
      // cligent's protected auto mode.
      permissions: { mode: 'auto' },
    });
    expect(composed.players).toEqual([
      {
        id: 'code-coder',
        adapter: 'claude',
        model: 'claude-opus-4-8[1m]',
        effort: 'xhigh',
        // PBCLI-11: seeded claude roles get auto mode, no writablePaths.
        permissions: { mode: 'auto' },
      },
      {
        id: 'review-coder',
        adapter: 'claude',
        model: 'claude-opus-4-8[1m]',
        effort: 'xhigh',
        permissions: { mode: 'auto' },
      },
      {
        id: 'review-reviewer',
        adapter: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        permissions: { mode: 'auto', writablePaths: ['.git'] },
      },
      {
        id: 'decide-coder',
        adapter: 'claude',
        model: 'claude-opus-4-8[1m]',
        effort: 'xhigh',
        permissions: { mode: 'auto' },
      },
      {
        id: 'decide-reviewer',
        adapter: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        permissions: { mode: 'auto', writablePaths: ['.git'] },
      },
    ]);
    expect(composed.layout.initialVisible).toEqual(['code-coder']);
    expect(composed.captain.options.playbooks.code).toEqual({
      from: '@sublang/playbook/code/registry',
      command: 'code',
      options: {},
    });

    // The composed config is valid input to cligent's own loader.
    const loaded = await loadComposedConfig(spawn.configs[0].content);
    expect(loaded.config.captain.from).toBe(PLAYBOOK_CAPTAIN_MODULE);
    expect(loaded.config.players.map((p: { id: string }) => p.id)).toEqual([
      'code-coder',
      'review-coder',
      'review-reviewer',
      'decide-coder',
      'decide-reviewer',
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
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
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
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
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
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
    });

    expect(result).toEqual({ code: 0 });
    expect(stderr.text()).toContain(
      'no readiness check for adapter "gemini"',
    );
    expect(spawn.calls).toHaveLength(1);
  });
});

// PBCLI-41 (DR-027): the agent runtimes are cligent's to know; a launch
// must render cligent's verdict — absent and below-floor distinctly, each
// with its pinned repair — instead of letting a runtime fail mid-turn.
// Expectations derive from cligent's descriptor, never restated literals.
const CLAUDE_TARGET = AGENT_RUNTIME_TARGETS.claude[0];
const CODEX_TARGET = AGENT_RUNTIME_TARGETS.codex[0];
const [OPENCODE_SDK, OPENCODE_CLI] = AGENT_RUNTIME_TARGETS.opencode;

// Drives cligent's real classifier from an injected version table rather
// than the host's installed runtimes, so a missing or below-floor verdict
// is reproducible on any machine. An absent key classifies as missing —
// built directly, because `classifyRuntime`'s version parameter defaults
// on an explicit `undefined` and would read the host's runtimes.
function classifyWith(versions: Record<string, string>) {
  return (target: RuntimeTarget, available: boolean): RuntimeReadiness => {
    const installed = versions[target.package];
    if (installed === undefined) {
      return {
        state: available ? 'unknown' : 'missing',
        target,
        repair: { spec: target.repairSpec, steps: target.steps ?? [] },
      };
    }
    return classifyRuntime(target, available, installed);
  };
}

describe('playbook launcher — adapter SDK preflight (PBCLI-41)', () => {
  function fakeProbe(unavailable: string[]) {
    const probed: string[] = [];
    return {
      probed,
      fn: async (adapter: string) => {
        probed.push(adapter);
        return !unavailable.includes(adapter);
      },
    };
  }

  it('launches unchanged when every adapter SDK probes available', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const spawn = fakeSpawn();
    const probe = fakeProbe([]);

    const result = await runPlaybookCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
      probeAdapterSdk: probe.fn,
    });

    expect(result).toEqual({ code: 0 });
    expect(spawn.calls).toHaveLength(1);
  });

  it('blocks with the adapter id and its exact install command', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const spawn = fakeSpawn();
    const stderr = writer();

    const result = await runPlaybookCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
      probeAdapterSdk: fakeProbe(['codex']).fn,
      classifyRuntime: classifyWith({
        [CLAUDE_TARGET.package]: CLAUDE_TARGET.tested,
      }),
    });

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(127);
    expect(stderr.text()).toContain(
      `Adapter runtimes not usable: codex (${CODEX_TARGET.bundles} not installed)`,
    );
    expect(stderr.text()).toContain(
      `npm install -g ${CODEX_TARGET.repairSpec}`,
    );
    // The available vendor's SDK is not advertised as a remedy.
    expect(stderr.text()).not.toContain(
      `npm install -g ${CLAUDE_TARGET.repairSpec}`,
    );
    expect(spawn.calls).toHaveLength(0);
  });

  it('reports a below-floor runtime with versions, never as absent', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const spawn = fakeSpawn();
    const stderr = writer();

    // Codex's runtime IS installed — at the version DR-013 was written
    // about — so the report must carry the installed and required versions
    // with the same pinned repair; "not installed" would send the user
    // hunting for something already present.
    const result = await runPlaybookCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
      probeAdapterSdk: fakeProbe(['codex']).fn,
      classifyRuntime: classifyWith({
        [CLAUDE_TARGET.package]: CLAUDE_TARGET.tested,
        [CODEX_TARGET.package]: '0.139.0',
      }),
    });

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(127);
    expect(stderr.text()).toContain(
      `Adapter runtimes not usable: codex (${CODEX_TARGET.bundles} 0.139.0 ` +
        `installed, >=${CODEX_TARGET.supportedFrom} required)`,
    );
    expect(stderr.text()).toContain(
      `npm install -g ${CODEX_TARGET.repairSpec}`,
    );
    expect(stderr.text()).not.toContain('not installed');
    expect(spawn.calls).toHaveLength(0);
  });

  it('reports a missing credential and a missing SDK together', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const spawn = fakeSpawn();
    const stderr = writer();

    // No credentials at all, and claude's SDK absent: two independent
    // failures with two different remedies — reporting one would send the
    // user round the loop twice.
    const result = await runPlaybookCli({
      argv: [],
      env: {},
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
      probeAdapterSdk: fakeProbe(['claude']).fn,
      classifyRuntime: classifyWith({
        [CODEX_TARGET.package]: CODEX_TARGET.tested,
      }),
    });

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(127);
    expect(stderr.text()).toContain(
      `Adapter runtimes not usable: claude (${CLAUDE_TARGET.bundles} not installed)`,
    );
    expect(stderr.text()).toContain(
      `npm install -g ${CLAUDE_TARGET.repairSpec}`,
    );
    expect(stderr.text()).toContain('Adapters not ready:');
    expect(spawn.calls).toHaveLength(0);
  });

  it('gates gemini too and probes each declared adapter once', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, geminiConfig());
    const spawn = fakeSpawn();
    const stderr = writer();
    const probe = fakeProbe([]);

    const result = await runPlaybookCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'a' },
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
      probeAdapterSdk: probe.fn,
    });

    expect(result).toEqual({ code: 0 });
    // The config declares captain claude plus two gemini players. DR-027
    // ends gemini's exemption — cligent publishes its CLI target — and each
    // distinct adapter is probed once, not once per declaration.
    expect([...probe.probed].sort()).toEqual(['claude', 'gemini']);
    // PBCLI-12 still warns about gemini's absent credential check; the
    // runtime gate adds no second warning.
    expect(
      stderr.text().match(/no readiness check for adapter "gemini"/g),
    ).toHaveLength(1);
    expect(spawn.calls).toHaveLength(1);
  });

  it('excludes an adapter cligent publishes no targets for', async () => {
    const probe = fakeProbe([]);
    const { unusableAdapters } = await adapterSdk.checkAdapterSdks(
      ['claude', 'mystery'],
      probe.fn,
    );
    expect(unusableAdapters).toEqual([]);
    // The unknown adapter stays with PBCLI-12's unknown-adapter warning;
    // probing it would import a module path that cannot exist.
    expect(probe.probed).toEqual(['claude']);
  });

  it('runs no probe for a raw --config launch', async () => {
    const home = await makeTempHome();
    const spawn = fakeSpawn();
    const probe = fakeProbe(['claude', 'codex']);

    const result = await runPlaybookCli({
      argv: ['--config', '/tmp/raw.yaml'],
      env: {},
      homeDir: home,
      stderr: writer(),
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
      probeAdapterSdk: probe.fn,
    });

    expect(result).toEqual({ code: 0 });
    expect(probe.probed).toEqual([]);
    expect(spawn.calls).toHaveLength(1);
  });

  it('maps every descriptor adapter by module path alone', () => {
    // DR-027: the map is API-shape knowledge — module and export — and
    // nothing else. Version knowledge living here is exactly the copy this
    // decision deletes, so its absence is asserted structurally.
    expect(Object.keys(adapterSdk.ADAPTER_MODULES).sort()).toEqual(
      Object.keys(AGENT_RUNTIME_TARGETS).sort(),
    );
    for (const entry of Object.values(adapterSdk.ADAPTER_MODULES)) {
      expect(Object.keys(entry as object).sort()).toEqual([
        'export',
        'module',
      ]);
      expect((entry as { module: string }).module).toMatch(
        /^@sublang\/cligent\/adapters\//,
      );
    }
  });

  it('names both installs for an adapter that also needs a CLI', () => {
    const verdicts = AGENT_RUNTIME_TARGETS.opencode.map((target) =>
      classifyWith({})(target, false),
    );
    const lines = adapterSdk.adapterSdkFailureLines(
      [{ adapter: 'opencode', verdicts }],
      { ephemeralNpx: false },
    );
    expect(lines).toEqual([
      `Adapter runtimes not usable: opencode (${OPENCODE_SDK.package} ` +
        `not installed; ${OPENCODE_CLI.package} not installed)`,
      `  npm install -g ${OPENCODE_SDK.repairSpec}`,
      `  npm install -g ${OPENCODE_CLI.repairSpec}`,
      '',
    ]);
  });

  it('names only the opencode half actually at fault', async () => {
    // The CLI is present and in range; only the SDK is absent. Naming the
    // healthy half sends the user to install what is already there, so the
    // verdict set carries the faulty runtime alone.
    const probe = fakeProbe(['opencode']);
    const { unusableAdapters } = await adapterSdk.checkAdapterSdks(
      ['opencode'],
      probe.fn,
      classifyWith({ [OPENCODE_CLI.package]: OPENCODE_CLI.tested }),
    );
    const lines = adapterSdk.adapterSdkFailureLines(unusableAdapters, {
      ephemeralNpx: false,
    });
    expect(lines).toEqual([
      `Adapter runtimes not usable: opencode (${OPENCODE_SDK.package} not installed)`,
      `  npm install -g ${OPENCODE_SDK.repairSpec}`,
      '',
    ]);
  });

  it('detects an npm exec tree and prints the multi-package re-run', () => {
    // A global SDK install is not on the ephemeral tree's ancestor walk, so
    // an `npm install -g` remedy there is a command that cannot work.
    expect(
      adapterSdk.detectEphemeralNpxInstall(
        'file:///home/dev/.npm/_npx/9ce5e27bec6c6909/node_modules/@sublang/playbook/reference/sdlc/code.playbook/bin/adapter-sdk.js',
      ),
    ).toBe(true);
    expect(adapterSdk.detectEphemeralNpxInstall()).toBe(false);

    // The partial-tree case that alternated forever: claude is present in
    // THIS tree, codex is not. The re-run must still name BOTH — a fresh
    // exec tree starts empty — at cligent's pinned repair specs, and must
    // carry the original arguments instead of a literal `...` no surface
    // accepts.
    const lines = adapterSdk.adapterSdkFailureLines(
      [
        {
          adapter: 'codex',
          verdicts: [classifyWith({})(CODEX_TARGET, false)],
        },
      ],
      {
        ephemeralNpx: true,
        requiredSdks: adapterSdk.mappedSdksFor(['claude', 'codex']),
        invocation: ['run', 'do the thing'],
      },
    );
    expect(lines).toContain(
      `    npx -y -p ${pkgSelfSpec()} -p ${CLAUDE_TARGET.repairSpec} ` +
        `-p ${CODEX_TARGET.repairSpec} playbook run 'do the thing'`,
    );
    // One re-run line — not one npx line per SDK, no literal `...`, and no
    // npm install command that would land outside the tree.
    expect(lines.filter((l: string) => l.includes('npx -y'))).toHaveLength(1);
    expect(lines.some((l: string) => l.includes('...'))).toBe(false);
    expect(
      lines.some((l: string) => l.trim().startsWith('npm install')),
    ).toBe(false);
  });

  it('prints prerequisite CLI installs before the ephemeral re-run', () => {
    // The re-run probes the CLI again, so following the output
    // top-to-bottom must install it first — printed after the re-run, the
    // user's first hop fails and needs another.
    const lines = adapterSdk.adapterSdkFailureLines(
      [
        {
          adapter: 'opencode',
          verdicts: AGENT_RUNTIME_TARGETS.opencode.map((target) =>
            classifyWith({})(target, false),
          ),
        },
      ],
      {
        ephemeralNpx: true,
        requiredSdks: [OPENCODE_SDK.repairSpec],
        invocation: ['run', 'mod://x'],
      },
    );
    const cliIndex = lines.findIndex((l: string) =>
      l.includes(`npm install -g ${OPENCODE_CLI.repairSpec}`),
    );
    const rerunIndex = lines.findIndex((l: string) => l.includes('npx -y'));
    expect(cliIndex).toBeGreaterThan(-1);
    expect(rerunIndex).toBeGreaterThan(cliIndex);
    expect(lines[rerunIndex - 1]).toContain('Then re-run');
  });

  it('dedupes and orders the lineup SDK set canonically', () => {
    // captain and a player sharing an adapter must not produce a repeated
    // -p flag. gemini is descriptor-gated but CLI-kind, so it contributes
    // no -p sibling: PATH persists across exec trees.
    expect(
      adapterSdk.mappedSdksFor(['codex', 'claude', 'codex', 'gemini']),
    ).toEqual([CLAUDE_TARGET.repairSpec, CODEX_TARGET.repairSpec]);
  });

  it('prints a one-hop re-run for a partially supplied exec tree', async () => {
    const home = await makeTempHome();
    await writeUserConfig(home, minimalConfig());
    const spawn = fakeSpawn();
    const stderr = writer();

    // Claude's SDK is present in this exec tree, codex's is not.
    const result = await runPlaybookCli({
      argv: [],
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      stderr,
      stdout: writer(),
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
      probeAdapterSdk: async (adapter: string) => adapter !== 'codex',
      classifyRuntime: classifyWith({
        [CLAUDE_TARGET.package]: CLAUDE_TARGET.tested,
      }),
      ephemeralNpx: true,
    });

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(127);
    const rerun = stderr
      .text()
      .split('\n')
      .find((l) => l.includes('npx -y'));
    expect(rerun).toContain(`-p ${CLAUDE_TARGET.repairSpec}`);
    expect(rerun).toContain(`-p ${CODEX_TARGET.repairSpec}`);
    // With no original arguments the command ends at the bin — never a
    // literal `...`, which tmux-play rejects as a positional.
    expect(rerun?.trimEnd().endsWith('playbook')).toBe(true);
    expect(spawn.calls).toHaveLength(0);
  });
});

function pkgSelfSpec(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { name: string; version: string };
  return `${manifest.name}@${manifest.version}`;
}

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
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
    });

    expect(result).toEqual({ code: 0 });
    expect(stdout.text()).toContain('/code');
    expect(stdout.text()).toContain('code');
    expect(stdout.text()).toContain('coding intent');
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
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
    });

    expect(result).toEqual({ code: 0 });
    expect(stdout.text()).toContain('Usage:');
    expect(stdout.text()).toContain(
      'playbook run (--continue | --session <id>) [reply]',
    );
    expect(stdout.text()).toContain('--retry-uncertain');
    expect(stdout.text()).toContain('fresh launch only');
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
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
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
      // PBCLI-39: the real probe reads host state (installed SDKs, the
      // gemini/opencode CLIs on PATH), so a gated lineup would pass or fail
      // by machine. Gate behaviour has its own tests, which inject their own.
      probeAdapterSdk: async () => true,
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
    'captain: claude',
    'playbooks:',
    '  code:',
    '    from: "@sublang/playbook/code/registry"',
    '    players:',
    '      coder: claude',
    '      reviewer: codex',
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

describe('playbook --with overlays (PBCLI-27)', () => {
  const GLOBAL_CONFIG = [
    'captain: claude',
    'playbooks:',
    '  code:',
    '    from: "mod://code"',
    '    players:',
    '      coder: claude',
    '      reviewer: codex',
    '    committer: coder',
    '',
  ].join('\n');

  async function withHarness() {
    const home = await makeTempHome();
    const configPath = resolveUserConfigPath({}, home);
    await mkdir(join(home, '.config', 'playbook'), { recursive: true });
    await writeFile(configPath, GLOBAL_CONFIG, 'utf8');
    const overlayDir = await mkdtemp(join(tmpdir(), 'playbook-with-'));
    tempDirs.push(overlayDir);
    return { home, configPath, overlayDir };
  }

  function launch(
    argv: string[],
    home: string,
    spawn: ReturnType<typeof fakeSpawn>,
    modules: Record<string, unknown> = { 'mod://code': { default: fakeEntry } },
  ) {
    const stdout = writer();
    const stderr = writer();
    return runPlaybookCli({
      argv,
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
      homeDir: home,
      loadModule: loader(modules),
      stdout: stdout as never,
      stderr: stderr as never,
      spawn: spawn.fn,
      tmuxPlayBin: '/tmp/tmux-play.js',
    }).then((result: any) => ({
      code: result.code,
      stdout: stdout.text(),
      stderr: stderr.text(),
    }));
  }

  it('merges a fragment over the global config without touching it or forwarding --with', async () => {
    const { home, configPath, overlayDir } = await withHarness();
    const overlay = join(overlayDir, 'tune.yaml');
    await writeFile(
      overlay,
      [
        'playbooks:',
        '  code:',
        '    players:',
        '      coder: { adapter: codex, model: m-turbo, effort: xhigh }',
        '',
      ].join('\n'),
      'utf8',
    );
    const spawn = fakeSpawn();

    const out = await launch(['--with', overlay], home, spawn);

    expect(out.code).toBe(0);
    const composed = parseYaml(spawn.configs[0].content);
    expect(composed.players).toEqual([
      { id: 'code-coder', adapter: 'codex', model: 'm-turbo', effort: 'xhigh' },
      { id: 'code-reviewer', adapter: 'codex' },
    ]);
    // The global config is byte-identical after the overlaid launch.
    await expect(readFile(configPath, 'utf8')).resolves.toBe(GLOBAL_CONFIG);
    // The consumed flag is not forwarded to tmux-play.
    expect(spawn.calls[0].args.join(' ')).not.toContain('--with');
    expect(spawn.calls[0].args.join(' ')).not.toContain(overlay);
  });

  it('applies fragments in argument order, later files winning', async () => {
    const { home, overlayDir } = await withHarness();
    const first = join(overlayDir, 'first.yaml');
    const second = join(overlayDir, 'second.yaml');
    await writeFile(
      first,
      'playbooks: { code: { players: { coder: { adapter: codex, model: m-one } } } }\n',
      'utf8',
    );
    await writeFile(
      second,
      'playbooks: { code: { players: { coder: { adapter: codex, model: m-two } } } }\n',
      'utf8',
    );
    const spawn = fakeSpawn();

    const out = await launch(['--with', first, '--with', second], home, spawn);

    expect(out.code).toBe(0);
    const composed = parseYaml(spawn.configs[0].content);
    expect(composed.players[0]).toMatchObject({ id: 'code-coder', model: 'm-two' });
  });

  it('reflects an overlay-enabled playbook in --list', async () => {
    const { home, overlayDir } = await withHarness();
    const overlay = join(overlayDir, 'discuss.yaml');
    await writeFile(
      overlay,
      [
        'playbooks:',
        '  discuss:',
        '    from: "mod://discuss"',
        '    players: { host: claude, participant: codex }',
        '',
      ].join('\n'),
      'utf8',
    );
    const discussEntry = {
      ...fakeEntry,
      id: 'discuss',
      command: 'discuss',
      intent: 'two agents converge',
      requiredRoleIds: ['host', 'participant'],
    };
    const spawn = fakeSpawn();

    const out = await launch(['--list', '--with', overlay], home, spawn, {
      'mod://code': { default: fakeEntry },
      'mod://discuss': { default: discussEntry },
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain('/code');
    expect(out.stdout).toContain('/discuss');
    expect(spawn.calls).toHaveLength(0);
  });

  it('rejects --with combined with --config, missing fragments, and non-map fragments', async () => {
    const { home, overlayDir } = await withHarness();
    const spawn = fakeSpawn();

    const conflict = await launch(
      ['--with', join(overlayDir, 'x.yaml'), '--config', '/tmp/raw.yaml'],
      home,
      spawn,
    );
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('cannot combine');

    const missing = await launch(
      ['--with', join(overlayDir, 'absent.yaml')],
      home,
      spawn,
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read --with overlay');

    const listFile = join(overlayDir, 'list.yaml');
    await writeFile(listFile, '- a\n- b\n', 'utf8');
    const nonMap = await launch(['--with', listFile], home, spawn);
    expect(nonMap.code).toBe(1);
    expect(nonMap.stderr).toContain('must be a YAML map');

    expect(spawn.calls).toHaveLength(0);
  });
});

// PBCLI-38: engine provisioning over synthetic filesystem registry
// modules and injected host package roots.

const SYNTHETIC_XSTATE = {
  'package.json': `${JSON.stringify({
    name: 'xstate',
    version: '0.0.0',
    main: 'index.js',
  })}\n`,
  'index.js': 'module.exports = {};\n',
};

const SYNTHETIC_PLAYBOOK = {
  'package.json': `${JSON.stringify({
    name: '@sublang/playbook',
    version: '0.0.0',
    exports: { './xstate-runtime': './xstate-runtime.js' },
  })}\n`,
  'xstate-runtime.js': 'export const SYNTHETIC = true;\n',
};

async function writePackage(dir: string, files: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
}

async function syntheticHostRoots() {
  const root = await mkdtemp(join(tmpdir(), 'playbook-host-roots-'));
  tempDirs.push(root);
  const xstate = join(root, 'xstate');
  const playbookRoot = join(root, 'playbook');
  await writePackage(xstate, SYNTHETIC_XSTATE);
  await writePackage(playbookRoot, SYNTHETIC_PLAYBOOK);
  return { xstate, '@sublang/playbook': playbookRoot };
}

async function provisionFixtureDir() {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-provision-'));
  tempDirs.push(dir);
  const modulePath = join(dir, 'registry.mjs');
  await writeFile(modulePath, 'export {};\n', 'utf8');
  return { dir, modulePath };
}

async function provisioningError(options: {
  modulePath: string;
  enabled?: boolean;
  hostRoots?: Record<string, string>;
}) {
  try {
    await provisionEngine(options);
  } catch (error) {
    expect(error).toBeInstanceOf(EngineProvisioningError);
    return error as Error & { code: string };
  }
  throw new Error('expected engine provisioning to fail');
}

describe('engine provisioning core (PBCLI-38)', () => {
  it('leaves locally resolvable engine directories untouched', async () => {
    const hostRoots = await syntheticHostRoots();
    const { dir, modulePath } = await provisionFixtureDir();
    await writePackage(join(dir, 'node_modules', 'xstate'), SYNTHETIC_XSTATE);
    await writePackage(
      join(dir, 'node_modules', '@sublang', 'playbook'),
      SYNTHETIC_PLAYBOOK,
    );

    await expect(
      provisionEngine({ modulePath, hostRoots }),
    ).resolves.toEqual({ createdLinks: [] });
    expect(
      (await lstat(join(dir, 'node_modules', 'xstate'))).isSymbolicLink(),
    ).toBe(false);
    expect(
      (
        await lstat(join(dir, 'node_modules', '@sublang', 'playbook'))
      ).isSymbolicLink(),
    ).toBe(false);
  });

  it('returns exactly the two links it provisions in a bare directory, once', async () => {
    const hostRoots = await syntheticHostRoots();
    const { dir, modulePath } = await provisionFixtureDir();
    const xstateLink = join(dir, 'node_modules', 'xstate');
    const playbookLink = join(dir, 'node_modules', '@sublang', 'playbook');

    await expect(
      provisionEngine({ modulePath, hostRoots }),
    ).resolves.toEqual({
      createdLinks: [
        { path: xstateLink, target: hostRoots.xstate },
        {
          path: playbookLink,
          target: hostRoots['@sublang/playbook'],
        },
      ],
    });
    expect((await lstat(xstateLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(playbookLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(xstateLink)).toBe(hostRoots.xstate);
    expect(await readlink(playbookLink)).toBe(
      hostRoots['@sublang/playbook'],
    );

    await expect(
      provisionEngine({ modulePath, hostRoots }),
    ).resolves.toEqual({ createdLinks: [] });
  });

  it('--no-provision leaves a bare directory unchanged', async () => {
    const { dir, modulePath } = await provisionFixtureDir();

    await expect(
      provisionEngine({ modulePath, enabled: false }),
    ).resolves.toEqual({ createdLinks: [] });
    expect(await readdir(dir)).toEqual(['registry.mjs']);
  });

  it('does not provision a bare package specifier', async () => {
    const stderr = writer();
    const prepare = prepareConfiguredRegistries({
      stderr,
      hostRoots: await syntheticHostRoots(),
    });

    await expect(
      prepare({ from: '@example/playbook-registry' }),
    ).resolves.toBe('@example/playbook-registry');
    expect(stderr.text()).toBe('');
  });

  it('refuses to shadow a manifest that declares @sublang/playbook', async () => {
    const hostRoots = await syntheticHostRoots();
    const { dir, modulePath } = await provisionFixtureDir();
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({
        name: 'consumer',
        private: true,
        dependencies: { '@sublang/playbook': '^3.0.0' },
      })}\n`,
      'utf8',
    );

    const error = await provisioningError({ modulePath, hostRoots });
    expect(error).toMatchObject({ code: 'declared-install-missing' });
    expect(error.message).toContain('declares @sublang/playbook');
    expect(error.message).toContain('npm install');
    expect((await readdir(dir)).sort()).toEqual([
      'package.json',
      'registry.mjs',
    ]);
  });

  it('replaces a dangling link by default and names it when disabled', async () => {
    const hostRoots = await syntheticHostRoots();
    const { dir, modulePath } = await provisionFixtureDir();
    const xstateLink = join(dir, 'node_modules', 'xstate');
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await symlink(join(dir, 'gone'), xstateLink, 'dir');

    const result = await provisionEngine({ modulePath, hostRoots });
    expect(result.createdLinks).toContainEqual({
      path: xstateLink,
      target: hostRoots.xstate,
    });
    expect(await readlink(xstateLink)).toBe(hostRoots.xstate);

    const second = await provisionFixtureDir();
    const staleLink = join(second.dir, 'node_modules', 'xstate');
    const missingTarget = join(second.dir, 'gone');
    await mkdir(join(second.dir, 'node_modules'), { recursive: true });
    await symlink(missingTarget, staleLink, 'dir');

    const error = await provisioningError({
      modulePath: second.modulePath,
      enabled: false,
      hostRoots,
    });
    expect(error).toMatchObject({ code: 'stale-link' });
    expect(error.message).toContain(staleLink);
    expect(error.message).toContain('stale engine link');
    expect(error.message).toContain(missingTarget);
  });

  it('never overwrites a real directory occupying a link path', async () => {
    const hostRoots = await syntheticHostRoots();
    const { dir, modulePath } = await provisionFixtureDir();
    const occupied = join(dir, 'node_modules', 'xstate');
    await mkdir(occupied, { recursive: true });

    const error = await provisioningError({ modulePath, hostRoots });
    expect(error).toMatchObject({ code: 'occupied-link' });
    expect(error.message).toContain(`cannot provision ${occupied}`);
    expect((await lstat(occupied)).isDirectory()).toBe(true);
    expect(await readdir(join(dir, 'node_modules'))).toEqual(['xstate']);
  });

  it('creates no sibling link when the second destination is occupied', async () => {
    const hostRoots = await syntheticHostRoots();
    const { dir, modulePath } = await provisionFixtureDir();
    const occupied = join(dir, 'node_modules', '@sublang', 'playbook');
    await mkdir(occupied, { recursive: true });

    const error = await provisioningError({ modulePath, hostRoots });
    expect(error).toMatchObject({ code: 'occupied-link' });
    expect(error.message).toContain(`cannot provision ${occupied}`);
    // Validation precedes every mutation: the resolvable-in-isolation
    // xstate link must not have been created before the refusal.
    expect(await readdir(join(dir, 'node_modules'))).toEqual(['@sublang']);
  });

  it('reports a filesystem failure as a coded provisioning error', async () => {
    const hostRoots = await syntheticHostRoots();
    const { dir, modulePath } = await provisionFixtureDir();
    const nodeModules = join(dir, 'node_modules');
    await mkdir(nodeModules, { recursive: true });
    await chmod(nodeModules, 0o555);
    try {
      const error = await provisioningError({ modulePath, hostRoots });
      expect(error).toMatchObject({ code: 'filesystem' });
      expect(error.message).toContain('cannot provision engine links:');
    } finally {
      await chmod(nodeModules, 0o755);
    }
  });
});
