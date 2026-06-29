// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const SLC_SPECS = ['link.md', 'gears2fsm.md', 'text2gears.md'];
const CLIGENT_DEP = '@sublang/cligent';
const LOCAL_OVERRIDE = new URL('../pnpm-workspace.yaml', import.meta.url);

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies: Record<string, string>;
};

const lockfile = parseYaml(
  readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
) as {
  importers: {
    '.': {
      dependencies: Record<string, { specifier: string; version: string }>;
    };
  };
};

describe('runtime dependency specifiers (RELEASE-19)', () => {
  it('keeps @sublang/cligent on a caret range with lockfile agreement', () => {
    const packageSpecifier = pkg.dependencies[CLIGENT_DEP];
    const lockEntry = lockfile.importers['.'].dependencies[CLIGENT_DEP];
    const hasLocalOverride = existsSync(LOCAL_OVERRIDE);
    const recordsConcreteVersion = /^\d+\.\d+\.\d+(?:\(|$)/.test(
      lockEntry.version,
    );
    const recordsLocalLink = lockEntry.version.startsWith('link:');

    expect(packageSpecifier).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(lockEntry.specifier).toBe(packageSpecifier);
    expect(
      hasLocalOverride
        ? recordsConcreteVersion || recordsLocalLink
        : recordsConcreteVersion,
    ).toBe(true);
  });
});

describe('public slc/* surface (RELEASE-17)', () => {
  // RELEASE-17 and the README name `import.meta.resolve` specifically.
  // vitest does not provide it (`__vite_ssr_import_meta__.resolve is not
  // a function`), so exercise the real Node API in a subprocess whose
  // package scope is this package — resolving each spec through the
  // published `./slc/*` export exactly as a consumer would.
  it('resolves all three slc specs via import.meta.resolve', () => {
    const script = `
      import { readFileSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      for (const name of ${JSON.stringify(SLC_SPECS)}) {
        const url = import.meta.resolve('@sublang/playbook/slc/' + name);
        if (readFileSync(fileURLToPath(url), 'utf8').length === 0) {
          throw new Error('empty spec: ' + name);
        }
      }
      process.stdout.write('OK');
    `;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(out).toContain('OK');
  });
});

describe('packed tarball contents (RELEASE-18)', () => {
  it('includes the /runtime artifacts and every slc/*.md', () => {
    const npmCache = mkdtempSync(join(tmpdir(), 'playbook-npm-cache-'));
    let out: string;
    try {
      out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: npmCache },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } finally {
      rmSync(npmCache, { recursive: true, force: true });
    }
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

describe('public CLI and registry surface (RELEASE-21)', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { bin: Record<string, string>; exports: Record<string, unknown> };
  const CODE_BASE = 'reference/sdlc/code.playbook/';

  it('declares the playbook bin and code/registry export, not the retired surfaces', () => {
    expect(manifest.bin).toHaveProperty('playbook');
    expect(manifest.bin).not.toHaveProperty('playbook-code');
    expect(manifest.exports).toHaveProperty('./code/registry');
    expect(manifest.exports).not.toHaveProperty('./code/tmux-play');
  });

  it('packs the launcher and code.registry artifacts and not the retired files', () => {
    const npmCache = mkdtempSync(join(tmpdir(), 'playbook-npm-cache-'));
    let out: string;
    try {
      out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: npmCache },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } finally {
      rmSync(npmCache, { recursive: true, force: true });
    }
    const packed: string[] = JSON.parse(out)[0].files.map(
      (f: { path: string }) => f.path,
    );
    for (const artifact of [
      `${CODE_BASE}bin/playbook.js`,
      `${CODE_BASE}code.registry.js`,
      `${CODE_BASE}code.registry.d.ts`,
    ]) {
      expect(packed, `tarball missing ${artifact}`).toContain(artifact);
    }
    for (const removed of [
      `${CODE_BASE}bin/playbook-code.js`,
      `${CODE_BASE}code.tmux-play.js`,
      `${CODE_BASE}code.tmux-play.d.ts`,
    ]) {
      expect(packed, `tarball still ships ${removed}`).not.toContain(removed);
    }
  });
});
