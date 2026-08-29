// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const fixture = fileURLToPath(
  new URL('./fixtures/headless-crash-child.mjs', import.meta.url),
);
const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const sessionId = '90000000-0000-4000-8000-000000000031';
const attemptId = '90000000-0000-4000-8000-000000000032';
const nextAttemptId = '90000000-0000-4000-8000-000000000033';

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function crashFixture() {
  const root = await mkdtemp(join(tmpdir(), 'playbook-crash-child-'));
  tempDirs.push(root);
  const sessionsDir = join(root, 'sessions');
  const registryPath = join(root, 'fixture-registry.mjs');
  const configPath = join(root, 'playbook.config.yaml');
  await writeFile(
    registryPath,
    [
      'export default {',
      "  id: 'fixture', command: 'fixture', intent: 'crash fixture',",
      '  artifactSchema: 2,',
      "  runtimeProfile: { kind: 'bespoke', artifactSchema: 2 },",
      "  requiredRoleIds: ['worker'],",
      '  concurrentRoleSets: [],',
      '  validateOptions(value) { return value; },',
      "  createRuntime() { throw new Error('fixture playbook must not start'); }",
      '};',
      '',
    ].join('\n'),
  );
  await writeFile(
    configPath,
    [
      'captain: claude',
      'players:',
      '  fixture.worker: claude',
      'playbooks:',
      '  fixture:',
      '    from: ./fixture-registry.mjs',
      '    roles: { worker: fixture.worker }',
      '',
    ].join('\n'),
  );
  return { root, sessionsDir, configPath };
}

function startChild(
  fixturePaths: Awaited<ReturnType<typeof crashFixture>>,
  mode: string,
  input: string,
) {
  const child = fork(fixture, [], {
    env: {
      ...process.env,
      PLAYBOOK_FIXTURE_MODE: mode,
      PLAYBOOK_FIXTURE_INPUT: input,
      PLAYBOOK_FIXTURE_SESSION_ID: sessionId,
      PLAYBOOK_FIXTURE_ATTEMPT_ID: attemptId,
      PLAYBOOK_FIXTURE_NEXT_ATTEMPT_ID: nextAttemptId,
      PLAYBOOK_FIXTURE_SESSIONS_DIR: fixturePaths.sessionsDir,
      PLAYBOOK_FIXTURE_CONFIG: fixturePaths.configPath,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForMessage(
  child: ChildProcess,
  predicate: (value: any) => boolean,
) {
  return await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for crash fixture IPC')),
      10_000,
    );
    const onMessage = (value: any) => {
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `crash fixture exited before IPC message: code=${code} signal=${signal}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode] as const;
  }
  return (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
}

describe('headless Captain process-crash recovery (PBCLI-24)', () => {
  it('leaves an uncertain marker on SIGKILL, rejects a live contender, and retries exact input after dead-PID reclaim', async () => {
    const paths = await crashFixture();
    const exactInput = '  child crash input\nwith exact bytes\n';
    const crashing = startChild(paths, 'crash', exactInput);
    expect(await waitForMessage(crashing.child, (value) => value.type === 'effect'))
      .toMatchObject({ input: exactInput, mode: 'crash' });

    const recordPath = join(paths.sessionsDir, `${sessionId}.json`);
    const uncertain = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(uncertain).toMatchObject({
      state: 'uncertain',
      uncertain: { input: exactInput, attemptId, attemptNumber: 1 },
    });
    expect(crashing.stdout()).toBe('');
    expect(await readdir(paths.sessionsDir)).toContain(`.${sessionId}.lock`);

    const contender = startChild(paths, 'retry-live', exactInput);
    const rejected = await waitForMessage(
      contender.child,
      (value) => value.type === 'result',
    );
    expect(rejected.result.code, contender.stderr()).toBe(1);
    expect(contender.stdout()).toBe('');
    expect(contender.stderr()).toMatch(/lease|locked|active|owner/i);
    await waitForExit(contender.child);

    crashing.child.kill('SIGKILL');
    const [code, signal] = await waitForExit(crashing.child);
    expect(code).toBeNull();
    expect(signal).toBe('SIGKILL');
    expect(JSON.parse(await readFile(recordPath, 'utf8')).state).toBe(
      'uncertain',
    );

    const retry = startChild(paths, 'retry', 'must not replace stored input');
    expect(await waitForMessage(retry.child, (value) => value.type === 'effect'))
      .toMatchObject({ input: exactInput, mode: 'retry' });
    const result = await waitForMessage(
      retry.child,
      (value) => value.type === 'result',
    );
    expect(result.result.code, retry.stderr()).toBe(0);
    await waitForExit(retry.child);
    const settled = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(settled.state).toBe('settled');
    expect(settled).not.toHaveProperty('uncertain');
    const names = await readdir(paths.sessionsDir);
    expect(names).not.toContain(`.${sessionId}.lock`);
    expect(
      names.filter((name) => name.startsWith(`.${sessionId}.lock.retired.`)),
    ).toHaveLength(2);
  }, 20_000);
});
