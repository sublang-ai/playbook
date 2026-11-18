// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('./bin/playbook.js', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  // Inside the project so the fixtures use the repository's ordinary module
  // resolution. The packed CLI's standalone provisioning is tested separately.
  const root = mkdtempSync(join(dirname(cli), '.add-integration-'));
  roots.push(root);
  const config = join(root, 'config', 'playbook.config.yaml');
  const workflows = join(root, '订单 flow');
  mkdirSync(workflows);
  const entryPath = join(workflows, 'flow.mjs');
  const initial = {
    captain: { adapter: 'claude', model: 'shared-captain-model' },
    players: { 'shared.inspector': { adapter: 'codex', model: 'shared-player-model' } },
    playbooks: {
      inspect: {
        from: '@sublang/playbook/inspect/registry',
        roles: { inspector: 'shared.inspector' },
      },
    },
  };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, SPEX_HOME: root, XDG_CONFIG_HOME: join(root, 'xdg') },
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return {
    config, initial, entryPath, workflows, root, run,
    add: (path = './订单 flow/flow.mjs', model = 'gpt-6.2-sol') =>
      run('add', path, '--agent', 'codex', '--model', model),
  };
}

function entry(id: string, command: string, overrides = '{}') {
  return `const base = {
    id: ${JSON.stringify(id)}, command: ${JSON.stringify(command)}, intent: 'Count paid orders',
    artifactSchema: 3, runtimeProfile: {kind: 'bespoke', artifactSchema: 3},
    requiredRoleIds: ['checker', 'second-checker'],
    concurrentRoleSets: [['checker', 'second-checker']],
    validateOptions() { throw Error('registration must not validate runtime options'); },
    createRuntime() { throw Error('registration must never start a runtime'); }
  };
  export default {...base, ...(${overrides})};`;
}

describe('playbook add', () => {
  it('registers an entry and its exact roles while preserving the existing catalog', () => {
    const f = fixture();
    writeFileSync(f.entryPath, entry('flow', 'orders'));
    mkdirSync(dirname(f.config));
    writeFileSync(f.config, '# Keep this comment\n' + JSON.stringify(f.initial));
    expect(f.add()).toMatchObject({ code: 0, out: expect.stringContaining('registered /orders') });
    const saved = readFileSync(f.config, 'utf8');
    expect(saved).toContain('# Keep this comment');
    const after = parse(saved);
    expect(after.captain).toEqual(f.initial.captain);
    expect(after.players['shared.inspector']).toEqual(f.initial.players['shared.inspector']);
    expect(after.playbooks.inspect).toEqual(f.initial.playbooks.inspect);
    expect(after.playbooks.flow).toMatchObject({
      from: realpathSync(f.entryPath),
      command: 'orders',
    });
    expect(after.workflowCaptains.flow).toEqual({ adapter: 'codex', model: 'gpt-6.2-sol' });
    const roles = after.playbooks.flow.roles;
    expect(Object.keys(roles)).toEqual(['checker', 'second-checker']);
    expect(roles.checker).not.toBe(roles['second-checker']);
    for (const player of Object.values(roles) as string[]) {
      expect(after.players[player]).toEqual({ adapter: 'codex', model: 'gpt-6.2-sol' });
    }
    expect(f.run('--list')).toMatchObject({ code: 0, out: expect.stringContaining('/orders  flow') });
    expect(f.add()).toMatchObject({ code: 0, out: expect.stringContaining('already registered') });
    expect(readFileSync(f.config, 'utf8')).toBe(saved);

    writeFileSync(join(f.workflows, 'same-id.mjs'), entry('flow', 'other'));
    writeFileSync(join(f.workflows, 'same-command.mjs'), entry('other', 'orders'));
    writeFileSync(join(f.workflows, 'invalid.mjs'), 'export default {};');
    for (const [path, model, error] of [
      ['./订单 flow/same-id.mjs', undefined, 'playbook id "flow"'],
      ['./订单 flow/same-command.mjs', undefined, 'duplicate effective command "orders"'],
      ['./订单 flow/invalid.mjs', undefined, 'invalid entry'],
      ['./订单 flow/flow.mjs', 'different-model', 'different entry or settings'],
    ] as const) {
      expect(f.add(path, model)).toMatchObject({ code: 1, err: expect.stringContaining(error) });
      expect(readFileSync(f.config, 'utf8')).toBe(saved);
    }
  });

  it('prepares a first config only after a valid registration', () => {
    const f = fixture();
    expect(f.run('add', '--help')).toMatchObject({
      code: 0, out: expect.stringContaining('only the new workflow'),
    });
    expect(f.add()).toMatchObject({ code: 1 });
    expect(() => readFileSync(f.config)).toThrow(/ENOENT/);
    writeFileSync(f.entryPath, entry('flow', 'orders'));
    expect(f.add()).toMatchObject({ code: 0 });
    const config = parse(readFileSync(f.config, 'utf8'));
    expect(config.playbooks.flow.command).toBe('orders');
    expect(config.playbooks.inspect.from).toBe('@sublang/playbook/inspect/registry');
  });

  it('accepts a roleless shared-factory entry and retains its independent command', () => {
    const f = fixture();
    mkdirSync(dirname(f.config));
    writeFileSync(f.config, JSON.stringify(f.initial));
    writeFileSync(f.entryPath, entry('artifact-2026', 'show-orders', `{
      runtimeProfile: Object.freeze({kind: 'shared-factory', compat: Object.freeze({artifactSchema: 3, runtimeAbi: 1})}),
      requiredRoleIds: [], concurrentRoleSets: []
    }`));
    expect(f.add()).toMatchObject({ code: 0, out: expect.stringContaining('/show-orders') });
    const after = parse(readFileSync(f.config, 'utf8'));
    expect(after.players).toEqual(f.initial.players);
    expect(after.playbooks['artifact-2026']).toMatchObject({ command: 'show-orders', roles: {} });
    expect(f.run('--list')).toMatchObject({ code: 0, out: expect.stringContaining('/show-orders  artifact-2026') });
    const saved = readFileSync(f.config, 'utf8');
    expect(f.run('add', f.entryPath, '--agent', 'unknown', '--model', 'test')).toMatchObject({
      code: 1, err: expect.stringContaining('unsupported --agent'),
    });
    expect(readFileSync(f.config, 'utf8')).toBe(saved);
  });

  it('retains Unicode and punctuated role ids even when their player names collide', () => {
    const f = fixture();
    mkdirSync(dirname(f.config));
    writeFileSync(f.config, JSON.stringify(f.initial));
    const declared = ['核对者', '复核者', '2nd', 'a:b', 'a.b'];
    writeFileSync(f.entryPath, entry('订单-flow', 'Order_Check-2', JSON.stringify({
      requiredRoleIds: declared,
      concurrentRoleSets: [declared.slice(0, 2), declared.slice(2)],
    })));
    expect(f.add()).toMatchObject({ code: 0, out: expect.stringContaining('/Order_Check-2') });
    const registered = parse(readFileSync(f.config, 'utf8'));
    const roles = registered.playbooks['订单-flow'].roles;
    expect(Object.keys(roles)).toEqual(declared);
    const players = Object.values(roles) as string[];
    expect(new Set(players).size).toBe(declared.length);
    for (const player of players) {
      expect(player).toMatch(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/);
      expect(registered.players[player]).toEqual({ adapter: 'codex', model: 'gpt-6.2-sol' });
    }
    expect(f.add()).toMatchObject({ code: 0, out: expect.stringContaining('already registered') });
  });

  it.each([false, true])('preserves existing workflow values backed by a YAML alias (top alias %s)', topAlias => {
    const f = fixture();
    mkdirSync(dirname(f.config));
    const localPlayers = '  shared.inspector: { adapter: codex, model: shared-player-model }';
    const inspect = '    from: "@sublang/playbook/inspect/registry"\n    roles: { inspector: shared.inspector }';
    const before = topAlias
      ? `captain: codex\nplaybooks:\n  inspect:\n${inspect}\n    savedPlayers: &original\n    ${localPlayers}\nplayers: *original\n`
      : `captain: codex\nplayers: &original\n${localPlayers}\nplaybooks:\n  inspect:\n${inspect}\n    savedPlayers: *original\n`;
    writeFileSync(f.config, before);
    writeFileSync(f.entryPath, entry('new-flow', 'news'));
    const added = f.add();
    expect(added.code, added.err).toBe(0);
    const after = parse(readFileSync(f.config, 'utf8'));
    expect(after.playbooks.inspect).toEqual(parse(before).playbooks.inspect);
    expect(after.players['shared.inspector']).toEqual(parse(before).players['shared.inspector']);
    expect(f.add()).toMatchObject({ code: 0, out: expect.stringContaining('already registered') });
  });

  it('refuses a config edit made while the entry was being loaded', () => {
    const f = fixture();
    mkdirSync(dirname(f.config));
    const before = JSON.stringify(f.initial);
    const concurrent = '# another writer\n' + before;
    writeFileSync(f.config, before);
    writeFileSync(f.entryPath, `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(f.config)}, ${JSON.stringify(concurrent)});
      ${entry('flow', 'orders')}`);
    expect(f.add()).toMatchObject({ code: 1, err: expect.stringContaining('config changed during registration') });
    expect(readFileSync(f.config, 'utf8')).toBe(concurrent);
  });

  it.each([
    ['missing id', '{id: undefined}', 'id must be'],
    ['noncanonical id', '{id: " flow "}', 'id must be'],
    ['reserved id', '{id: "captain"}', 'reserved internal Captain id'],
    ['missing command', '{command: undefined}', 'command must be'],
    ['multi-token command', '{command: "two tokens"}', 'routable slash command name'],
    ['prefixed command', '{command: "/orders"}', 'routable slash command name'],
    ['unroutable command', '{command: "orders.v1"}', 'routable slash command name'],
    ['reserved command', '{command: "captain"}', 'reserved internal Captain command'],
    ['invalid intent', '{intent: 42}', 'intent must be'],
    ['unsupported schema', '{artifactSchema: 2}', 'artifactSchema must be 3'],
    ['missing profile', '{runtimeProfile: undefined}', 'runtimeProfile must be a plain object'],
    ['invalid compatibility', '{runtimeProfile: {kind: "shared-factory", compat: {artifactSchema: 2, runtimeAbi: 1}}}', 'artifactSchema must match'],
    ['wrong role type', '{requiredRoleIds: [42]}', 'requiredRoleIds must contain only strings'],
    ['duplicate roles', '{requiredRoleIds: ["checker", "checker"]}', 'roles that collide'],
    ['noncanonical role', '{requiredRoleIds: ["Checker"]}', 'noncanonical role'],
    ['reserved role', '{requiredRoleIds: ["captain"]}', 'reserved local role'],
    ['unknown concurrent role', '{concurrentRoleSets: [["checker", "ghost"]]}', 'only required canonical local roles'],
    ['duplicate concurrent role', '{concurrentRoleSets: [["checker", "checker"]]}', 'pairwise-distinct roles'],
    ['missing option validator', '{validateOptions: undefined}', 'validateOptions must be a function'],
    ['missing runtime factory', '{createRuntime: undefined}', 'createRuntime must be a function'],
  ])('rejects %s with the configured YAML untouched', (_kind, override, diagnostic) => {
    const f = fixture();
    mkdirSync(dirname(f.config));
    const before = '# untouched\n' + JSON.stringify(f.initial);
    writeFileSync(f.config, before);
    writeFileSync(f.entryPath, entry('flow', 'orders', override));
    expect(f.add()).toMatchObject({ code: 1, err: expect.stringContaining(diagnostic) });
    expect(readFileSync(f.config, 'utf8')).toBe(before);
  });
});
