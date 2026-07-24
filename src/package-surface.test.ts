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
const SLC_SPECS = ['link.md', 'gears2fsm.md', 'text2gears.md', 'optimize.md'];
const CLIGENT_DEP = '@sublang/cligent';
const LOCAL_OVERRIDE = new URL('../pnpm-workspace.yaml', import.meta.url);
const CAPTAIN_BASE = 'reference/sdlc/captain.playbook/';
const CAPTAIN_GENERATED_BUNDLE = [
  `${CAPTAIN_BASE}captain.gears.md`,
  `${CAPTAIN_BASE}captain.fsm.ts`,
  `${CAPTAIN_BASE}captain.fsm.js`,
  `${CAPTAIN_BASE}captain.fsm.d.ts`,
  `${CAPTAIN_BASE}captain.playbook.ts`,
  `${CAPTAIN_BASE}captain.playbook.js`,
  `${CAPTAIN_BASE}captain.playbook.d.ts`,
  `${CAPTAIN_BASE}captain.gears-fsm.test.ts`,
  `${CAPTAIN_BASE}captain.fsm.introspect.test.ts`,
  `${CAPTAIN_BASE}captain.fsm.coverage.test.ts`,
  `${CAPTAIN_BASE}captain.prompt-contract.test.ts`,
  `${CAPTAIN_BASE}.slc-verify/hash.js`,
  `${CAPTAIN_BASE}.slc-verify/hash.d.ts`,
  `${CAPTAIN_BASE}.slc-verify/verify.js`,
  `${CAPTAIN_BASE}.slc-verify/verify.d.ts`,
  `${CAPTAIN_BASE}.slc-verify/verify-coverage.js`,
  `${CAPTAIN_BASE}.slc-verify/verify-coverage.d.ts`,
] as const;

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

  it('pins cligent lifecycle and isolated call contracts', () => {
    const script = `
      import { readFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const entry = fileURLToPath(import.meta.resolve('@sublang/cligent/tmux-play'));
      const contract = readFileSync(join(dirname(entry), 'contract.d.ts'), 'utf8');
      const captainOptionsStart = contract.indexOf('export interface CallCaptainOptions {');
      const playerOptionsStart = contract.indexOf('export interface CallPlayerOptions {');
      const captainContextStart = contract.indexOf('export interface CaptainContext {');
      if (
        captainOptionsStart < 0 ||
        playerOptionsStart <= captainOptionsStart ||
        captainContextStart <= playerOptionsStart
      ) {
        throw new Error('cligent tmux-play call option contracts are missing');
      }
      const captainOptions = contract.slice(captainOptionsStart, playerOptionsStart);
      const playerOptions = contract.slice(playerOptionsStart, captainContextStart);
      if (!/prepareDispose\\?\\(\\): Promise<void>/.test(contract)) {
        throw new Error('cligent Captain contract lacks prepareDispose');
      }
      if (!captainOptions.includes('readonly resume?: string | false;')) {
        throw new Error('cligent CallCaptainOptions lacks explicit resume selection');
      }
      if (!captainOptions.includes('readonly allowedTools?: readonly string[];')) {
        throw new Error('cligent CallCaptainOptions lacks an explicit tool allowlist');
      }
      if (!playerOptions.includes('readonly resume?: string | false;')) {
        throw new Error('cligent CallPlayerOptions lacks explicit resume selection');
      }
      if (!contract.includes('callPlayer(playerId: string, prompt: string, options?: CallPlayerOptions): Promise<PlayerRunResult>;')) {
        throw new Error('cligent CaptainContext.callPlayer does not accept CallPlayerOptions');
      }
      if (!contract.includes('callCaptain(prompt: string, options?: CallCaptainOptions): Promise<CaptainRunResult>;')) {
        throw new Error('cligent CaptainContext.callCaptain does not accept CallCaptainOptions');
      }
      process.stdout.write('OK');
    `;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(out).toBe('OK');
  });
});

describe('GEARS grammar provenance (RELEASE-23)', () => {
  const SPEX_DEP = '@sublang/spex';
  const GRAMMAR_SPECS = [
    '@sublang/spex/scaffold/specs/meta.md',
    '@sublang/spex/scaffold/i18n/zh/specs/meta.md',
  ];

  it('declares @sublang/spex on a caret range no lower than 0.3.0', () => {
    const specifier = pkg.dependencies[SPEX_DEP];
    const lockEntry = lockfile.importers['.'].dependencies[SPEX_DEP];

    expect(specifier).toMatch(/^\^\d+\.\d+\.\d+$/);
    const [major, minor] = specifier.slice(1).split('.').map(Number);
    expect(major > 0 || (major === 0 && minor >= 3)).toBe(true);
    expect(lockEntry.specifier).toBe(specifier);
  });

  it('resolves both GEARS definition localizations from the repo root', () => {
    const script = `
      import { readFileSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      for (const name of ${JSON.stringify(GRAMMAR_SPECS)}) {
        const url = import.meta.resolve(name);
        if (readFileSync(fileURLToPath(url), 'utf8').length === 0) {
          throw new Error('empty GEARS definition: ' + name);
        }
      }
      process.stdout.write('OK');
    `;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(out).toBe('OK');
  });
});

describe('public slc/* surface (RELEASE-17)', () => {
  // RELEASE-17 and the README name `import.meta.resolve` specifically.
  // vitest does not provide it (`__vite_ssr_import_meta__.resolve is not
  // a function`), so exercise the real Node API in a subprocess whose
  // package scope is this package — resolving each spec through the
  // published `./slc/*` export exactly as a consumer would.
  it('resolves every published slc spec via import.meta.resolve', () => {
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

describe('public XState runtime surface (RELEASE-15)', () => {
  it('resolves the shared engine through the package export', () => {
    const script = `
      import {
        assertJsonSafe,
        combineAbortSignals,
        createNestedPlaybookBridge,
        createXStatePlaybookRuntime,
        normalizeError,
        normalizePlaybookSnapshot,
        snapshotJsonValue,
        snapshotPlaybookSession,
        validateCaptainResult,
        validatePlayerResult,
        waitForPlaybookQuiescence,
      } from '@sublang/playbook/xstate-runtime';
      for (const value of [
        assertJsonSafe,
        combineAbortSignals,
        createNestedPlaybookBridge,
        createXStatePlaybookRuntime,
        normalizeError,
        normalizePlaybookSnapshot,
        snapshotJsonValue,
        snapshotPlaybookSession,
        validateCaptainResult,
        validatePlayerResult,
        waitForPlaybookQuiescence,
      ]) {
        if (typeof value !== 'function') throw new Error('missing helper');
      }
      process.stdout.write('OK');
    `;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(out).toBe('OK');
  });
});

describe('canonical Captain compiler bundle (CAPPLAY-11)', () => {
  it('retains every generated artifact and its hermetic verifier support', () => {
    for (const artifact of CAPTAIN_GENERATED_BUNDLE) {
      expect(
        existsSync(join(repoRoot, artifact)),
        `canonical Captain bundle missing ${artifact}`,
      ).toBe(true);
    }
  });
});

describe('packed tarball contents (RELEASE-18)', () => {
  it('includes runtime, Captain, and slc artifacts', () => {
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
      'src/runtime.js',
      'src/runtime.d.ts',
      'src/xstate-runtime.js',
      'src/xstate-runtime.d.ts',
      'src/xstate-playbook-runtime.js',
      'src/xstate-playbook-runtime.d.ts',
      'reference/sdlc/captain.md',
      'reference/sdlc/code.md',
      'reference/sdlc/discuss.md',
      `${CAPTAIN_BASE}captain.gears.md`,
      `${CAPTAIN_BASE}captain.fsm.ts`,
      `${CAPTAIN_BASE}captain.fsm.js`,
      `${CAPTAIN_BASE}captain.fsm.d.ts`,
      `${CAPTAIN_BASE}captain.playbook.ts`,
      `${CAPTAIN_BASE}captain.playbook.js`,
      `${CAPTAIN_BASE}captain.playbook.d.ts`,
    ]) {
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

  it('declares the playbook bin and registry exports, not the retired surfaces', () => {
    expect(manifest.bin).toHaveProperty('playbook');
    expect(manifest.bin).not.toHaveProperty('playbook-code');
    expect(manifest.exports).toHaveProperty('./runtime');
    expect(manifest.exports).toHaveProperty('./xstate-runtime');
    expect(manifest.exports).toHaveProperty('./code/registry');
    expect(manifest.exports).toHaveProperty('./discuss/registry');
    expect(manifest.exports).toHaveProperty('./captain/playbook');
    expect(manifest.exports).not.toHaveProperty('./captain/registry');
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
      'reference/sdlc/discuss.playbook/discuss.registry.js',
      'reference/sdlc/discuss.playbook/discuss.registry.d.ts',
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
