// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const SLC_SPECS = ['link.md', 'gears2fsm.md', 'text2gears.md'];

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
      dependencies: Record<string, { specifier: string }>;
    };
  };
};

describe('runtime dependency specifiers (RELEASE-19)', () => {
  it('pins @sublang/cligent to the release-approved caret range', () => {
    expect(pkg.dependencies['@sublang/cligent']).toBe('^0.12.0');
    expect(
      lockfile.importers['.'].dependencies['@sublang/cligent'].specifier,
    ).toBe('^0.12.0');
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
