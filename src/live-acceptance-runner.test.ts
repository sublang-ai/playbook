// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const repo = fileURLToPath(new URL('../', import.meta.url));
const runner = new URL('../scripts/run-live-acceptance.mjs', import.meta.url).href;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function fixture(first: string, later = true) {
  const root = await mkdtemp(join(tmpdir(), 'playbook-acceptance-runner-'));
  roots.push(root);
  await mkdir(join(root, 'acceptance'));
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'vitest.acceptance.config.ts'), `export default { test: { include: ['acceptance/**/*.acceptance.test.ts'], bail: 1, fileParallelism: false } };`);
  const prefix = `import { beforeAll, it } from 'vitest'; import { writeFileSync, appendFileSync } from 'node:fs';\n`;
  await writeFile(join(root, 'acceptance/playbook-live.acceptance.test.ts'), prefix + first);
  if (later) {
    await mkdir(join(root, 'acceptance/nested'));
    for (const name of ['z-last', 'nested/a-second']) {
      await writeFile(join(root, `acceptance/${name}.acceptance.test.ts`), prefix + `appendFileSync(${JSON.stringify(join(root, 'later-started'))}, ${JSON.stringify(name + '\n')}); it('passes', () => {});`);
    }
  }
  await writeFile(join(root, 'run.mjs'), `import { runLiveAcceptance } from ${JSON.stringify(runner)}; process.exitCode = await runLiveAcceptance({ cwd: ${JSON.stringify(root)} });`);
  return root;
}

function start(root: string) {
  const child = spawn(process.execPath, [join(root, 'run.mjs')], {
    cwd: root,
    env: { ...process.env, npm_config_cache: '/inherited/lowercase', NPM_CONFIG_CACHE: '/inherited/uppercase' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', text => { output += text; });
  child.stderr.setEncoding('utf8').on('data', text => { output += text; });
  const done = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  return { child, done, output: () => output };
}

async function collectCache(output: string) {
  const match = output.match(/fresh npm cache: ([^\r\n]+)/);
  expect(match).not.toBeNull();
  roots.push(match![1]!);
  return match![1]!;
}

it('stops after a real beforeAll failure before importing any later provider file (release-37)', async () => {
  const root = await fixture(`beforeAll(() => { throw new Error('fixture setup failed'); }); it('never starts', () => { throw new Error('must not execute'); });`);
  const run = start(root);
  expect(await run.done, run.output()).toBe(1);
  expect(run.output()).toContain('fixture setup failed');
  expect(existsSync(join(root, 'later-started'))).toBe(false);
  const cache = await collectCache(run.output());
  expect(existsSync(cache)).toBe(true);
});

it('discovers every configured file, runs installed first, and owns cache without changing auth roots', async () => {
  const root = await fixture(`it('records its environment before later files', () => {
    writeFileSync('environment.json', JSON.stringify({ lower: process.env.npm_config_cache, upper: process.env.NPM_CONFIG_CACHE, home: process.env.HOME, codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }));
    writeFileSync('later-started', 'installed\\n');
  });`);
  const run = start(root);
  expect(await run.done, run.output()).toBe(0);
  expect(await readFile(join(root, 'later-started'), 'utf8')).toBe('installed\nnested/a-second\nz-last\n');
  const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
  const cache = await collectCache(run.output());
  expect(environment).toEqual({ lower: cache, upper: cache, home: process.env.HOME, codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR });
  expect(existsSync(cache)).toBe(false);
});

it.each(['SIGINT', 'SIGTERM'] as const)('forwards %s and never starts a later file', async (signal) => {
  const root = await fixture(`it('waits until interrupted', async () => { writeFileSync('ready', 'ready'); await new Promise(() => {}); }, 60000);`);
  const run = start(root);
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(root, 'ready')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(join(root, 'ready')), run.output()).toBe(true);
    run.child.kill(signal);
    expect(await run.done, run.output()).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(existsSync(join(root, 'later-started'))).toBe(false);
    const cache = await collectCache(run.output());
    expect(existsSync(cache)).toBe(true);
  } finally { run.child.kill('SIGKILL'); }
});

it('reaps an owned descendant that ignores termination after Vitest closes', async () => {
  const root = await fixture(`it('spawns a stubborn owned child', async () => {
    const { spawn } = await import('node:child_process');
    spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('descendant.pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
    await new Promise(() => {});
  }, 60000);`);
  const run = start(root);
  let descendant: number | undefined;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(root, 'descendant.pid')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(join(root, 'descendant.pid')), run.output()).toBe(true);
    descendant = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
    run.child.kill('SIGTERM');
    expect(await run.done, run.output()).toBe(143);
    const reapedDeadline = Date.now() + 2_000;
    const alive = () => { try { process.kill(descendant!, 0); return true; } catch { return false; } };
    while (alive() && Date.now() < reapedDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
    expect(existsSync(join(root, 'later-started'))).toBe(false);
    await collectCache(run.output());
  } finally {
    run.child.kill('SIGKILL');
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* Already reaped. */ } }
  }
}, 20_000);

it('routes the release command through the fail-fast process gate', async () => {
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  expect(manifest.scripts['test:acceptance']).toBe('node scripts/run-live-acceptance.mjs');
});
