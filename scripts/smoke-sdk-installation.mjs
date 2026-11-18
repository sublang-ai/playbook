#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
export function verifySdkInstallShapes(tarball, root, existingGlobalPrefix, sharedCache = join(root, 'npm-cache')) {
  mkdirSync(root, { recursive: true });
  let sequence = 0;
  function run(command, args, cwd = root) {
    const start = Date.now();
    console.log(`[SDK installation ${sequence + 1}] ${command} ${args.join(' ')}`);
    const env = { ...process.env, NODE_PATH: '', npm_config_fund: 'false', npm_config_cache: sharedCache };
    delete env.npm_config_prefix;
    delete env.NPM_CONFIG_PREFIX;
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      timeout: command === 'npm' ? 300000 : 30000, env });
    writeFileSync(join(root, String(++sequence).padStart(3, '0') + '.json'), JSON.stringify({
      command, args, cwd, startedAt: new Date(start).toISOString(), elapsedMs: Date.now() - start,
      exitCode: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
    }, null, 2));
    if (result.error || result.status !== 0) throw Error(`SDK installation check failed: ${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  }
  function probe(owner, allowedRoot, expectation = 'available') {
    writeFileSync(join(owner, 'smoke-adapters.mjs'), readFileSync(join(scriptRoot, 'smoke-adapters.mjs')));
    return JSON.parse(run('node', ['./smoke-adapters.mjs', expectation, allowedRoot], owner));
  }
  function frontendFault(playbookRoot, cligentRoot, adapter) {
    const home = join(root, 'fault-home-' + adapter);
    mkdirSync(join(home, '.spex/config'), { recursive: true });
    writeFileSync(join(home, '.spex/config/playbook.config.yaml'), JSON.stringify({
      captain: { adapter: 'claude', model: 'claude-fable-5-2' },
      players: {
        'sdk.coder': { adapter: 'claude', model: 'claude-fable-5-2' },
        'sdk.reviewer': { adapter: 'codex', model: 'gpt-6.1-sol' },
      },
      playbooks: {
        code: { from: '@sublang/playbook/code/registry', roles: { coder: 'sdk.coder' } },
        review: { from: '@sublang/playbook/review/registry', roles: { coder: 'sdk.coder', reviewer: 'sdk.reviewer' } },
      },
    }));
    const driver = join(playbookRoot, '.sdk-fault-guard.mjs');
    writeFileSync(driver, `
import { runPlaybookCli } from './reference/sdlc/code.playbook/bin/playbook.js';
let launches = 0, stderr = '';
const home = ${JSON.stringify(home)};
const result = await runPlaybookCli({ argv: [], homeDir: home,
  env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home + '/.config',
    ANTHROPIC_API_KEY: 'sdk-smoke-unused', OPENAI_API_KEY: 'sdk-smoke-unused', CODEX_API_KEY: 'sdk-smoke-unused' },
  stdout: { write() { return true; } }, stderr: { write(text) { stderr += text; return true; } },
  spawn() { launches++; throw Error('PRE_AGENT_BOUNDARY_CROSSED'); },
});
console.log(JSON.stringify({ code: result.code, launches, stderr }));
if (!result.code || result.code === 127 || launches !== 0) throw Error('Installed readiness gate did not stop before Agent launch');
if (!stderr.includes(${JSON.stringify(join(realpathSync(cligentRoot), 'bin/repair-included-runtimes.mjs'))}))
  throw Error('Installed readiness diagnostic did not target its Cligent owner');
if (stderr.includes('npm install -g @anthropic-ai/claude-agent-sdk') || stderr.includes('npm install -g @openai/codex-sdk'))
  throw Error('Installed help still advertises an ineffective sibling SDK install');
if (!stderr.includes(${JSON.stringify(join(realpathSync(playbookRoot), 'reference/sdlc/code.playbook/bin/playbook.js'))}))
  throw Error('Installed repair did not preserve the same runnable frontend');
`);
    return JSON.parse(run('node', [driver]));
  }
  const globalPrefix = existingGlobalPrefix ?? join(root, 'global');
  if (!existingGlobalPrefix) run('npm', ['install', '-g', '--prefix', globalPrefix,
    '--no-audit', '--no-fund', '--prefer-offline', tarball]);
  const playbook = join(globalPrefix, 'lib/node_modules/@sublang/playbook');
  const owner = join(playbook, 'node_modules/@sublang/cligent');
  const first = probe(owner, playbook);

  for (const name of ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk']) {
    const decoy = join(globalPrefix, 'lib/node_modules', name); mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, 'package.json'), JSON.stringify({ name, version: '99.0.0', main: 'index.js' }));
    writeFileSync(join(decoy, 'index.js'), "throw Error('UNRELATED SDK MUST NOT LOAD');");
  }
  const shadow = probe(owner, playbook);
  if (JSON.stringify(first.records.map(x => x.sdkRoot)) !== JSON.stringify(shadow.records.map(x => x.sdkRoot)))
    throw Error('Sibling SDK shadowed included ownership');

  const nested = join(root, 'nested'); mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'package.json'), '{"private":true}');
  run('npm', ['install', '--install-strategy=nested', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', tarball], nested);
  const nestedOwner = join(nested, 'node_modules/@sublang/playbook/node_modules/@sublang/cligent');
  const nestedReport = probe(nestedOwner, nested);
  for (const item of nestedReport.records) {
    const held = item.sdkRoot + '.smoke-held'; renameSync(item.sdkRoot, held);
    try {
      probe(nestedOwner, nested, 'missing-' + item.id);
      frontendFault(join(nested, 'node_modules/@sublang/playbook'), nestedOwner, item.id);
    }
    finally { renameSync(held, item.sdkRoot); }
  }
  probe(nestedOwner, nested);

  const ephemeral = join(root, 'ephemeral'); mkdirSync(ephemeral, { recursive: true });
  writeFileSync(join(ephemeral, 'package.json'), '{"private":true}');
  const bin = run('npm', ['exec', '--yes', '--package=' + tarball, '--call', 'command -v playbook'], ephemeral);
  const cacheRelative = relative(realpathSync(sharedCache), realpathSync(bin));
  if (cacheRelative === '..' || cacheRelative.startsWith('../') || isAbsolute(cacheRelative))
    throw Error('Ephemeral command was not acquired in the isolated npm cache');
  const execModules = dirname(dirname(bin));
  probe(join(execModules, '@sublang/cligent'), execModules);
  const result = { global: first, nested: nestedReport, ephemeral: bin,
    siblingSdkIgnored: true, damagedIncludedSdkControls: ['claude', 'codex'], agentCalls: 0 };
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
  return ['global, nested and ephemeral tarball-only SDK acquisition verified',
    'SDK/native owner and Cligent readiness agree; sibling and damage controls passed'];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tarball = resolve(process.argv[2]);
  const root = process.env.PLAYBOOK_SDK_SMOKE_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'playbook-sdk-installation-'));
  console.log('SDK installation evidence: ' + root);
  console.log(verifySdkInstallShapes(tarball, root).join('\n'));
}
