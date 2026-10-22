// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFixtureManifest, writeFixtureFile as writeFile } from './test-support/session-persistence.js';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const fixture = fileURLToPath(
  new URL('./fixtures/headless-crash-child.mjs', import.meta.url),
);
const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const childMessages = new WeakMap<ChildProcess, any[]>();
const sessionId = '90000000-0000-4000-8000-000000000031';
const attemptId = '90000000-0000-4000-8000-000000000032';
const nextAttemptId = '90000000-0000-4000-8000-000000000033';
const execFileAsync = promisify(execFile);

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
  const repositoryPath = join(root, 'repository');
  const registryPath = join(root, 'fixture-registry.mjs');
  const configPath = join(root, 'playbook.config.yaml');
  await mkdir(repositoryPath);
  await execFileAsync('git', ['init', '--quiet'], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, 'tracked.txt'), 'baseline\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repositoryPath });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Playbook Fixture',
      '-c',
      'user.email=fixture@sublang.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture baseline',
    ],
    { cwd: repositoryPath },
  );
  await writeFile(
    registryPath,
    [
      'export default {',
      "  id: 'fixture', command: 'fixture', intent: 'crash fixture',",
      '  artifactSchema: 3,',
      "  runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },",
      "  requiredRoleIds: ['worker'],",
      '  concurrentRoleSets: [],',
      '  validateOptions(value) { return value; },',
      '  createRuntime(options, hostCapabilities) {',
      '    return globalThis.__createCrashFixtureRuntime(options, hostCapabilities);',
      '  }',
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
  return { root, sessionsDir, configPath, repositoryPath };
}

function startChild(
  fixturePaths: Awaited<ReturnType<typeof crashFixture>>,
  mode: string,
  input: string,
) {
  const child = fork(fixture, [], {
    cwd: fixturePaths.repositoryPath,
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
  const messages: any[] = [];
  childMessages.set(child, messages);
  child.on('message', (value) => {
    messages.push(value);
  });
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
  const queued = childMessages.get(child) ?? [];
  const queuedIndex = queued.findIndex(predicate);
  if (queuedIndex >= 0) return queued.splice(queuedIndex, 1)[0];
  return await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for crash fixture IPC')),
      10_000,
    );
    const onMessage = (value: any) => {
      if (!predicate(value)) return;
      const index = queued.indexOf(value);
      if (index >= 0) queued.splice(index, 1);
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
  it('reconstructs an unchanged boundary and reports without whole-turn replay', async () => {
    const paths = await crashFixture();
    const exactInput = '  child crash input\nwith exact bytes\n';
    const crashing = startChild(paths, 'crash', exactInput);
    expect(await waitForMessage(crashing.child, (value) => value.type === 'effect'))
      .toMatchObject({ input: exactInput, mode: 'crash' });

    const recordPath = join(paths.sessionsDir, `${sessionId}.json`);
    const uncertain = await readFixtureManifest(recordPath);
    expect(uncertain).toMatchObject({
      state: 'uncertain',
      uncertain: { input: exactInput, attemptId, attemptNumber: 1 },
      effectLedger: {
        logicalOperations: [],
        boundaries: [
          {
            attemptId,
            attemptNumber: 1,
            boundaryId: '90000000-0000-4000-8000-000000000034',
          },
        ],
      },
    });
    expect(uncertain.effectLedger.boundaries[0]).not.toHaveProperty(
      'physicalReceipt',
    );
    expect(crashing.stdout()).toBe('');
    expect(await readdir(paths.sessionsDir)).toContain(`.${sessionId}.lock`);

    const contender = startChild(paths, 'retry-live', exactInput);
    const rejected = await waitForMessage(
      contender.child,
      (value) => value.type === 'result',
    );
    expect(rejected.result.code, contender.stderr()).toBe(1);
    expect(rejected.events).toEqual([]);
    expect(contender.stdout()).toBe('');
    expect(contender.stderr()).toMatch(/lease|locked|active|owner/i);
    await waitForExit(contender.child);

    crashing.child.kill('SIGKILL');
    const [code, signal] = await waitForExit(crashing.child);
    expect(code).toBeNull();
    expect(signal).toBe('SIGKILL');
    expect((await readFixtureManifest(recordPath)).state).toBe(
      'uncertain',
    );

    const retry = startChild(paths, 'retry', 'must not replace stored input');
    const result = await waitForMessage(retry.child, (value) => value.type === 'result');
    expect(result.result.code, retry.stderr()).toBe(0);
    expect(result.events).toEqual(['captain-runtime']);
    await waitForExit(retry.child);
    const settled = await readFixtureManifest(recordPath);
    expect(settled.state).toBe('settled');
    expect(settled).not.toHaveProperty('uncertain');
    expect(settled.effectLedger.boundaries).toMatchObject([
      {
        boundaryId: '90000000-0000-4000-8000-000000000034',
        attemptId,
        attemptNumber: 1,
        physicalReceipt: { classification: 'unchanged' },
      },
    ]);
    expect(settled.snapshot.effectLedger).toEqual(settled.effectLedger);
    expect(settled.effectLedger.logicalOperations).toEqual([]);
    const names = await readdir(paths.sessionsDir);
    expect(names).not.toContain(`.${sessionId}.lock`);
    expect(
      names.filter((name) => name.startsWith(`.${sessionId}.lock.retired.`)),
    ).toHaveLength(2);
  }, 20_000);

  it('settles a real worktree delta without starting a workflow or player', async () => {
    const paths = await crashFixture();
    const exactInput = 'effectful child crash input';
    const crashing = startChild(paths, 'crash-delta', exactInput);
    expect(
      await waitForMessage(
        crashing.child,
        (value) => value.type === 'effect',
      ),
    ).toMatchObject({ input: exactInput, mode: 'crash-delta' });

    const recordPath = join(paths.sessionsDir, `${sessionId}.json`);
    const beforeRecovery = await readFixtureManifest(recordPath);
    expect(beforeRecovery).toMatchObject({
      state: 'uncertain',
      uncertain: { attemptId, attemptNumber: 1, input: exactInput },
    });
    await writeFile(join(paths.repositoryPath, 'foreign-change.txt'), 'delta\n');

    crashing.child.kill('SIGKILL');
    const [code, signal] = await waitForExit(crashing.child);
    expect(code).toBeNull();
    expect(signal).toBe('SIGKILL');

    const retry = startChild(paths, 'retry-delta', 'ignored retry input');
    const refused = await waitForMessage(
      retry.child,
      (value) => value.type === 'result',
    );
    expect(refused.result.code, retry.stderr()).toBe(0);
    expect(refused.events).toEqual(['captain-runtime']);
    expect(retry.stdout()).not.toBe('');
    await waitForExit(retry.child);

    const recovered = await readFixtureManifest(recordPath);
    expect(recovered).toMatchObject({
      state: 'settled',
      snapshot: { mode: 'chat', lastSettlementStatus: 'ok' },
      unresolvedEffects: [{ classification: 'concurrent-or-foreign-change' }],
      effectLedger: {
        logicalOperations: [],
        boundaries: [
          {
            boundaryId: '90000000-0000-4000-8000-000000000034',
            attemptId,
            attemptNumber: 1,
            physicalReceipt: {
              classification: 'concurrent-or-foreign-change',
            },
          },
        ],
      },
    });
    expect(recovered.snapshot.effectLedger).toEqual(recovered.effectLedger);
    expect(recovered.effectLedger.boundaries).toHaveLength(1);
  }, 20_000);
});
