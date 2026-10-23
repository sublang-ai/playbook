// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The merge-gate audit (release-44, DR-095).

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The required status checks the operator sets on `main` (release-40). */
const REQUIRED_CHECKS = [
  'playbook (Node 20)',
  'playbook (Node 22)',
  'SPDX headers (LIC-3, LIC-4)',
  'Smoke install (global tarball)',
];

type Matrix = Record<string, unknown> & {
  exclude?: Record<string, unknown>[];
};
type Job = { name?: string; strategy?: { matrix?: Matrix } };

/** The check name of every job the workflow runs for a pull request. */
const checkNames = (jobs: Record<string, Job>): string[] =>
  Object.entries(jobs).flatMap(([id, job]) => {
    const { exclude = [], ...axes } = job.strategy?.matrix ?? {};
    let rows: Record<string, unknown>[] = [{}];
    for (const [axis, values] of Object.entries(axes)) {
      rows = rows.flatMap((row) =>
        (values as unknown[]).map((value) => ({ ...row, [axis]: value })),
      );
    }
    rows = rows.filter(
      (row) =>
        !exclude.some((rule) =>
          Object.entries(rule).every(([axis, value]) => row[axis] === value),
        ),
    );
    return rows.map((row) =>
      job.name === undefined
        ? Object.keys(row).length === 0
          ? id
          : `${id} (${Object.values(row).join(', ')})`
        : job.name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, axis) =>
            String(row[axis]),
          ),
    );
  });

describe('merge gate (release-44)', () => {
  const workflow = parse(
    readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
  );

  it('runs one run per pull-request head, cancelled by its next push and never for main (release-41)', () => {
    expect(workflow.concurrency).toEqual({
      group:
        'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
    expect(Object.keys(workflow.on)).toContain('pull_request');
  });

  it('requires exactly the checks of the jobs a pull request runs (release-40)', () => {
    expect(
      Object.values(workflow.jobs as Record<string, { if?: unknown }>).every(
        (job) => job.if === undefined,
      ),
    ).toBe(true);
    expect(checkNames(workflow.jobs).sort()).toEqual(
      [...REQUIRED_CHECKS].sort(),
    );
  });

  it('refuses a tree holding a conflict marker before any other check (release-42)', () => {
    expect(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts
        .prepush,
    ).toBe('bash scripts/prepush.sh');

    const dir = mkdtempSync(join(tmpdir(), 'playbook-prepush-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      mkdirSync(join(dir, 'scripts'));
      copyFileSync(
        join(root, 'scripts/prepush.sh'),
        join(dir, 'scripts/prepush.sh'),
      );
      writeFileSync(
        join(dir, 'left.ts'),
        'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> origin/main\n',
      );
      execFileSync('git', ['-C', dir, 'add', '-A']);

      const run = spawnSync('bash', [join(dir, 'scripts/prepush.sh')], {
        encoding: 'utf8',
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/conflict markers left in the tree/);
      expect(run.stderr).toMatch(/^left\.ts:2:<<<<<<< HEAD$/m);
      expect(run.stdout).not.toMatch(/prepush: clean/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
