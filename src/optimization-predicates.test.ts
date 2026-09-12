// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const definition = readFileSync(new URL('../slc/optimize.md', import.meta.url), 'utf8');
const scripts = [...definition.matchAll(/^Captain shall run:\n\n((?:>[^\n]*\n)+)\nResults:\n\n- `ok`: The command exits zero\.\n- `failed`: The command exits nonzero\./gm)]
  .map((match) => match[1].replace(/^> ?/gm, ''));
// These are the actual published examples, not separately authored substitutes.
expect(scripts).toHaveLength(2);
const [insideWorkingTree, ownRepositoryRoot] = scripts;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
env.GIT_CONFIG_NOSYSTEM = '1';
env.GIT_CONFIG_GLOBAL = '/dev/null';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(script: string, cwd: string): number | null {
  const result = spawnSync('sh', ['-c', script], { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.status;
}

describe('optimizer environmental predicates (compiler-optimization-3)', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'playbook-optimize-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ['working-tree membership', insideWorkingTree],
    ['own repository root', ownRepositoryRoot],
  ])('initializes a plain directory for %s', (_label, script) => {
    expect(run(script, root)).toBe(0);
    expect(git(root, 'rev-parse', '--show-toplevel')).toBe(root);
    expect(statSync(join(root, '.git')).isDirectory()).toBe(true);
  });

  it('distinguishes ancestor membership from an own-root requirement', () => {
    git(root, 'init', '-q');
    const parentConfig = readFileSync(join(root, '.git/config'), 'utf8');
    const member = join(root, 'member');
    const own = join(root, 'own');
    mkdirSync(member);
    mkdirSync(own);

    expect(run(insideWorkingTree, member)).toBe(0);
    expect(existsSync(join(member, '.git'))).toBe(false);
    expect(git(member, 'rev-parse', '--show-toplevel')).toBe(root);

    expect(run(ownRepositoryRoot, own)).toBe(0);
    expect(statSync(join(own, '.git')).isDirectory()).toBe(true);
    expect(git(own, 'rev-parse', '--show-toplevel')).toBe(own);
    expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(parentConfig);
    expect(git(root, 'rev-parse', '--show-toplevel')).toBe(root);
  });

  it('preserves an existing repository root under both predicates', () => {
    git(root, 'init', '-q');
    git(root, 'config', 'fixture.preserved', 'yes');
    const config = readFileSync(join(root, '.git/config'), 'utf8');
    for (const script of scripts) {
      expect(run(script, root)).toBe(0);
      expect(git(root, 'rev-parse', '--show-toplevel')).toBe(root);
      expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(config);
    }
  });

  it('accepts a linked-worktree root without replacing its .git file', () => {
    const primary = join(root, 'primary');
    const worktree = join(root, 'linked');
    mkdirSync(primary);
    git(primary, 'init', '-q');
    git(primary, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
    git(primary, 'worktree', 'add', '--detach', worktree);
    const gitFile = readFileSync(join(worktree, '.git'), 'utf8');
    const commonDir = git(worktree, 'rev-parse', '--git-common-dir');
    for (const script of scripts) {
      expect(run(script, worktree)).toBe(0);
      expect(statSync(join(worktree, '.git')).isFile()).toBe(true);
      expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(gitFile);
      expect(git(worktree, 'rev-parse', '--show-toplevel')).toBe(worktree);
      expect(git(worktree, 'rev-parse', '--git-common-dir')).toBe(commonDir);
    }
  });

  it('refuses to treat an invalid existing .git as a proven own root', () => {
    writeFileSync(join(root, '.git'), 'not a Git worktree pointer\n');
    expect(run(ownRepositoryRoot, root)).not.toBe(0);
    expect(readFileSync(join(root, '.git'), 'utf8')).toBe('not a Git worktree pointer\n');
  });
});
