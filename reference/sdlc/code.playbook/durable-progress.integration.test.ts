// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/durable-progress-loss.mjs', import.meta.url));
it.each(['completed-report-budget', 'repeated-player-boundary', 'completed-clear', 'completed-unfinished', 'validation-matrix', 'consumed-result', 'completed-exact', 'player-before-change', 'exact-answer', 'command-override', 'give-up', 'later-step', 'player-result', 'player-before-receipt', 'script-result', 'script-before-result', 'nested-player', 'nested-script', 'preparation', 'completed', 'completed-terminal-only', 'automatic-answer', 'script-before-rename', 'script-after-rename', 'carried', 'accepted-answer', 'waiting-question', 'reserved-question', 'before-first-step', 'retention-switch', 'retention-lost-switch', 'retention-lost-same-root'])(
  'restores %s after SIGKILL without repeating work', async (scenario) => {
    const dir = await mkdtemp(join(tmpdir(), 'durable-progress-'));
    try {
      const stopped = await exec(process.execPath, [fixture, dir, scenario, 'start']).catch((error) => error);
      expect(stopped.signal, stopped.stderr).toBe('SIGKILL');
      const result = await exec(process.execPath, [fixture, dir, scenario, 'exit']);
      expect(JSON.parse(result.stdout)).toEqual({ settled: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000,
);

it.each(['second-crash', 'player-second-crash', 'lost-position-second-crash', 'cli'])('reports safely through %s', async (kind) => {
  const scenario = kind === 'lost-position-second-crash' ? 'retention-lost-switch' : kind === 'player-second-crash' ? 'player-result' : 'nested-script';
  const dir = await mkdtemp(join(tmpdir(), 'durable-reopen-'));
  try {
    await expect(exec(process.execPath, [fixture, dir, scenario, 'start'])).rejects.toMatchObject({ signal: 'SIGKILL' });
    if (kind !== 'cli') await expect(exec(process.execPath, [fixture, dir, scenario, 'again'])).rejects.toMatchObject({ signal: 'SIGKILL' });
    const result = await exec(process.execPath, [fixture, dir, scenario, kind === 'cli' ? 'cli' : 'exit']);
    expect(JSON.parse(result.stdout)).toEqual({ settled: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

it.each(['live-retain-none', 'live-retain-earlier', 'carried-cancel-command', 'carried-cancel-decision-error', 'carried-cancel-malformed', 'carried-cancel-cli-command', 'carried-cancel-cli-decision-error', 'carried-cancel-cli-malformed', 'carried-after-reply', 'parent-accepted-child-failed', 'carried-cancel', 'carried-cancel-cli', 'cancelled-stop', 'old-stop', 'resume-stop', 'no-work-discard'])('settles %s without losing work', async (scenario) => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-settle-'));
  try {
    if (scenario === 'no-work-discard') {
      await expect(exec(process.execPath, [fixture, dir, 'before-first-step', 'start'])).rejects.toMatchObject({ signal: 'SIGKILL' });
      expect(JSON.parse((await exec(process.execPath, [fixture, dir, 'before-first-step', 'discard'])).stdout)).toEqual({ settled: true });
    } else expect(JSON.parse((await exec(process.execPath, [fixture, dir, scenario, 'start'])).stdout)).toEqual({ settled: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
