#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));

// Vitest bail counts failed tests, not a file's failed beforeAll hook. Separate
// processes make every file's exit status a gate before spending later calls.
export async function runLiveAcceptance({ cwd = repoRoot, env = process.env } = {}) {
  cwd = await realpath(cwd);
  const config = join(cwd, 'vitest.acceptance.config.ts');
  const cache = await mkdtemp(join(tmpdir(), 'playbook-acceptance-npm-'));
  const childEnv = { ...env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache };
  let current;
  let stopping;
  let cancellationCleanup;
  let succeeded = false;

  const killOwned = (child, signal) => {
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const ownedGroupExists = (child) => {
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const stop = (signal) => {
    if (stopping) return;
    stopping = signal;
    const child = current;
    if (!child?.pid) return;
    killOwned(child, signal);
    // Keep the captured group alive in our cleanup scope after Vitest exits:
    // a descendant may ignore the first signal and outlive its direct parent.
    cancellationCleanup = (async () => {
      const deadline = Date.now() + 5_000;
      while (ownedGroupExists(child)) {
        if (Date.now() >= deadline) {
          killOwned(child, 'SIGKILL');
          break;
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
      }
    })();
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);

  const run = (args, capture = false) => new Promise((resolveResult, reject) => {
    if (stopping) return resolveResult({ code: stopping === 'SIGINT' ? 130 : 143, stdout: '' });
    const child = spawn(process.execPath, [vitest, ...args], {
      cwd, env: childEnv,
      detached: process.platform !== 'win32',
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    current = child;
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (current === child) current = undefined;
      resolveResult({ code: stopping === 'SIGINT' ? 130 : stopping === 'SIGTERM' ? 143 : code ?? (signal ? 1 : 0), stdout });
    });
  });

  try {
    console.log(`[acceptance gate] fresh npm cache: ${cache}`);
    const listed = await run(['list', '--config', config, '--filesOnly', '--json'], true);
    if (listed.code !== 0) return listed.code;
    const records = JSON.parse(listed.stdout);
    if (!Array.isArray(records) || records.some((record) => typeof record?.file !== 'string'))
      throw new Error('Vitest returned an invalid acceptance file inventory');
    const files = records.map((record) => resolve(cwd, record.file));
    const installed = join(cwd, 'acceptance', 'playbook-live.acceptance.test.ts');
    if (!files.includes(installed) || new Set(files).size !== files.length)
      throw new Error('Acceptance inventory must include the installed suite exactly once');
    files.sort((left, right) => left === installed ? -1 : right === installed ? 1 : left < right ? -1 : left > right ? 1 : 0);
    for (const file of files) {
      if (stopping) return stopping === 'SIGINT' ? 130 : 143;
      console.log(`[acceptance gate] ${file}`);
      const result = await run(['run', '--config', config, '--bail', '1', '--no-file-parallelism', file]);
      if (result.code !== 0) return result.code;
    }
    succeeded = true;
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await cancellationCleanup;
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    if (succeeded) await rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    else console.error(`[acceptance gate] npm cache preserved at ${cache}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLiveAcceptance();
}
