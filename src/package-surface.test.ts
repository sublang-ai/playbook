// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const SLC_SPECS = ['link.md', 'gears2fsm.md', 'text2gears.md'];

describe('public slc/* surface (RELEASE-17)', () => {
  // createRequire(...).resolve uses Node's own resolver (not Vite's), so
  // it consults the same package `exports` map that a consumer's
  // import.meta.resolve('@sublang/playbook/slc/<name>') resolves through.
  it('resolves all three slc specs through the ./slc/* export', () => {
    for (const name of SLC_SPECS) {
      const resolved = nodeRequire.resolve(`@sublang/playbook/slc/${name}`);
      expect(existsSync(resolved), `${name} resolved to a missing file`).toBe(
        true,
      );
      expect(readFileSync(resolved, 'utf8').length).toBeGreaterThan(0);
    }
  });
});

describe('packed tarball contents (RELEASE-18)', () => {
  it('includes the /runtime artifacts and every slc/*.md', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const packed: string[] = JSON.parse(out)[0].files.map(
      (f: { path: string }) => f.path,
    );
    for (const artifact of ['src/runtime.js', 'src/runtime.d.ts']) {
      expect(packed, `tarball missing ${artifact}`).toContain(artifact);
    }
    for (const name of SLC_SPECS) {
      expect(packed, `tarball missing slc/${name}`).toContain(`slc/${name}`);
    }
  });
});
