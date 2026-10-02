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
const fixture = fileURLToPath(new URL('./fixtures/worker-evidence-adoption.mjs', import.meta.url));

it('playbook-captain-80: reports exact adopted-root observations after completion, disposal and process loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-evidence-adoption-'));
  try {
    const stopped = await exec(process.execPath, [fixture, dir, 'start']).catch((error) => error);
    expect(stopped.signal, stopped.stderr).toBe('SIGKILL');
    const recovered = await exec(process.execPath, [fixture, dir, 'recover']);
    expect(JSON.parse(recovered.stdout)).toEqual({ settled: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
