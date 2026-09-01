// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { anchorsOf, linksOf } from '../scripts/check-links.mjs';
import { checkCligentReleaseCapabilities } from '../scripts/cligent-release-capabilities.mjs';

const packageRootUrl = new URL('../', import.meta.url);
const repoRoot = fileURLToPath(packageRootUrl);
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
const BUNDLED_WORKFLOW_IDS = ['code', 'review', 'decide', 'dev'] as const;
const REQUIRED_WORKFLOW_ARTIFACT_SUFFIXES = [
  'gears.md',
  'fsm.ts',
  'fsm.js',
  'fsm.d.ts',
  'playbook.ts',
  'playbook.js',
  'playbook.d.ts',
  'registry.ts',
  'registry.js',
  'registry.d.ts',
] as const;

// The manifest dependency groups pnpm records in the root importer.
const DEPENDENCY_GROUPS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

// The lockfile `settings` snapshot pnpm resolves from tracked configuration
// — no `.npmrc` is tracked, so these are the defaults every CI install
// computes, and the values the verified frozen install runs against. A pnpm
// major that changes a default changes this line, deliberately.
const CI_LOCKFILE_SETTINGS = {
  autoInstallPeers: true,
  excludeLinksFromLockfile: false,
};

// The lockfile's structural sections. Every other top-level key pnpm writes
// is derived from configuration — `overrides`, and the checksums a
// `packageExtensions` or `patchedDependencies` block leaves behind — so a
// key outside this set with no tracked configuration to explain it is local
// state that reached a commit.
// The specifier protocols that resolve to a checkout on the running machine
// rather than to a published artifact.
const LOCAL_PROTOCOL = /^(?:link|file|portal):/;

const CARET_RANGE = /^\^\d+\.\d+\.\d+$/;

/**
 * Whether a lockfile resolution falls inside a declared caret range.
 *
 * Only caret ranges are interpreted — every range this manifest declares is
 * one — and a resolution whose numbers do not parse is treated as outside,
 * because an unreadable pin is not a verified one.
 *
 * A prerelease never satisfies one of these ranges. SemVer admits a
 * prerelease only where the range itself carries one on the same
 * `major.minor.patch`, and `CARET_RANGE` matches stable ranges only, so
 * `0.18.0-beta.1` is below `^0.18.0` rather than inside it. That is the
 * opposite of how cligent's own floor check orders a prerelease, and
 * deliberately: this compares a resolution against a dependency range npm
 * itself resolves, where SemVer's rule is the one that governs.
 */
function satisfiesCaret(version: string, range: string): boolean {
  // SemVer's numeric-identifier grammar, not `parseInt`, which would accept
  // a leading zero, interior whitespace, and trailing garbage that SemVer
  // rejects — reading `1.2.9zzz` as the in-range `1.2.9`.
  const numbers = (value: string): number[] =>
    value
      .split('.')
      .map((part) => (/^(?:0|[1-9]\d*)$/.test(part) ? Number(part) : Number.NaN));
  const compare = (left: number[], right: number[]): number => {
    for (let i = 0; i < 3; i += 1) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
  };
  // pnpm appends the peer suffix `(dep@1.2.3)`, whose package names carry
  // hyphens of their own, so it goes before any prerelease test. Build
  // metadata does not affect precedence and is dropped.
  const core = ((version.split('(')[0] ?? '').split('+')[0] ?? '').trim();
  if (core.includes('-')) return false;
  const resolved = numbers(core);
  if (
    resolved.length !== 3 ||
    resolved.some((part) => !Number.isSafeInteger(part))
  ) {
    return false;
  }
  const lower = numbers(range.slice(1));
  const [major = 0, minor = 0, patch = 0] = lower;
  // Caret pins the leftmost non-zero component, which is why a 0.x range
  // admits only patch moves — the rule that froze the SDK ranges DR-027
  // deletes.
  const upper =
    major > 0
      ? [major + 1, 0, 0]
      : minor > 0
        ? [0, minor + 1, 0]
        : [0, 0, patch + 1];
  return compare(resolved, lower) >= 0 && compare(resolved, upper) < 0;
}

const STRUCTURAL_LOCKFILE_KEYS = [
  'lockfileVersion',
  'settings',
  'overrides',
  'importers',
  'packages',
  'snapshots',
];

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  pnpm?: { overrides?: Record<string, string> };
  scripts: Record<string, string>;
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
    const declaredFloor = packageSpecifier.slice(1).split('.').map(Number);
    expect(
      declaredFloor[0] > 0 ||
        (declaredFloor[0] === 0 &&
          (declaredFloor[1] > 23 ||
            (declaredFloor[1] === 23 && declaredFloor[2] >= 0))),
      `${CLIGENT_DEP} declares ${packageSpecifier}, below the 0.23.0 capability floor`,
    ).toBe(true);
    // A pnpm override rewrites the importer's recorded specifier as well as
    // its resolution, so both checks admit the link only while the local
    // override file exists.
    expect(
      hasLocalOverride
        ? lockEntry.specifier === packageSpecifier || recordsLocalLink
        : lockEntry.specifier === packageSpecifier,
    ).toBe(true);
    expect(
      hasLocalOverride
        ? recordsConcreteVersion || recordsLocalLink
        : recordsConcreteVersion,
    ).toBe(true);
    if (!recordsLocalLink) {
      const resolvedFloor = lockEntry.version
        .split('(')[0]
        .split('.')
        .map(Number);
      expect(
        resolvedFloor[0] > 0 ||
          (resolvedFloor[0] === 0 &&
            (resolvedFloor[1] > 23 ||
              (resolvedFloor[1] === 23 && resolvedFloor[2] >= 0))),
        `${CLIGENT_DEP} pins ${lockEntry.version.split('(')[0]}, below the 0.23.0 capability floor`,
      ).toBe(true);
    }
  });

  it('never commits local install state into the lockfile', () => {
    // Every production and CI install consumes the COMMITTED lockfile
    // frozen, after dropping the override file, so local state that reached
    // a commit fails them all before any test runs. The working copy
    // legitimately carries that state while the override is active; the
    // commit never does — and a clean HEAD satisfies this whatever the
    // working copy holds, so no dirty-tree exemption is needed.
    //
    // Both sides come from HEAD, because CI installs the committed manifest
    // against the committed lockfile: that pair's agreement is the only one
    // that predicts it, and judging a committed lockfile against a working
    // manifest lets an uncommitted edit mask a broken commit. The `./`
    // anchors the paths to this package rather than to the top of whatever
    // repository happens to contain it, so an export vendored inside an
    // unrelated checkout skips instead of asserting against that repo.
    let headLock: string;
    let headManifest: string;
    try {
      [headLock, headManifest] = ['pnpm-lock.yaml', 'package.json'].map(
        (file) =>
          execFileSync('git', ['show', `HEAD:./${file}`], {
            cwd: repoRoot,
            encoding: 'utf8',
          }),
      ) as [string, string];
    } catch {
      // No git and no committed pair to read — an exported tree, say, where
      // the working-copy checks above are the whole contract.
      return;
    }
    const committed = parseYaml(headLock) as {
      overrides?: Record<string, string>;
      settings?: Record<string, unknown>;
      importers?: Record<
        string,
        Record<string, Record<string, { specifier?: string; version?: string }>>
      >;
    };
    const committedPkg = JSON.parse(headManifest) as typeof pkg;
    const declaredOverrides = committedPkg.pnpm?.overrides ?? {};

    // pnpm gates a frozen install on the lockfile's config snapshot matching
    // the config it resolves at install time, aborting with
    // ERR_PNPM_LOCKFILE_CONFIG_MISMATCH on any difference, whatever the
    // value. Both halves of that snapshot are checked by equality, never by
    // path or protocol: `overrides` against the committed manifest — the
    // only tracked source, since `pnpm-workspace.yaml` is git-ignored — and
    // `settings` against the values CI's install runs against. The settings
    // half is not hypothetical: `exclude-links-from-lockfile` is exactly
    // what a contributor reaches for to stop the RELEASE-11 override
    // rewriting their lockfile, and it silently hides the link from every
    // importer entry below.
    for (const key of new Set([
      ...Object.keys(declaredOverrides),
      ...Object.keys(committed.overrides ?? {}),
    ])) {
      const declaredValue = declaredOverrides[key];
      expect(
        declaredValue,
        `${key} override is recorded but the manifest does not declare it`,
      ).toBeTypeOf('string');
      // RELEASE-11 sanctions exactly one way to link a local checkout — the
      // git-ignored override file — so no tracked override may name a local
      // path, however it is spelled. Without this, the equality below would
      // admit a committed link by construction.
      expect(declaredValue, `${key} override names a local path`).not.toMatch(
        LOCAL_PROTOCOL,
      );
      // `$name` reuses that dependency's own declared range, and pnpm
      // expands it before writing, so only its presence is comparable —
      // but presence is still required. pnpm compares the whole resolved
      // overrides map against the lockfile's, so a declared override the
      // lockfile omits is the same config mismatch as one it invents.
      if (declaredValue?.startsWith('$')) {
        expect(
          committed.overrides?.[key],
          `${key} override is declared but the lockfile records none`,
        ).toBeTypeOf('string');
        continue;
      }
      expect(committed.overrides?.[key], `${key} override`).toBe(declaredValue);
    }
    expect(committed.settings ?? {}).toEqual(CI_LOCKFILE_SETTINGS);

    // A lockfile carries config-derived keys beyond those two — a
    // `packageExtensions` block in the same git-ignored override file leaves
    // `packageExtensionsChecksum` behind, and it aborts the install with the
    // same mismatch. Structural keys are known; anything else must be backed
    // by a tracked `pnpm` configuration block.
    if (committedPkg.pnpm === undefined) {
      expect(Object.keys(committed).sort()).toEqual(
        Object.keys(committed)
          .filter((key) => STRUCTURAL_LOCKFILE_KEYS.includes(key))
          .sort(),
      );
    }

    // RELEASE-14 governs the committed pair itself, not only the working
    // copy: agreement between a manifest and a lockfile that BOTH name a
    // local checkout is still agreement, and nothing downstream reports it
    // — the frozen install succeeds, prints the linked package at `0.0.0`,
    // and leaves a dangling symlink, while `npm pack` carries `link:` into
    // the published manifest, where consumers hit EUNSUPPORTEDPROTOCOL.
    // The caret range and the concrete resolution are therefore required of
    // HEAD directly, with no local-override exemption — that exemption
    // exists for a working copy mid-development, and RELEASE-11 forbids the
    // state it exempts from ever reaching a commit.
    expect(
      committedPkg.dependencies?.[CLIGENT_DEP],
      `committed ${CLIGENT_DEP} range`,
    ).toMatch(CARET_RANGE);
    expect(
      committed.importers?.['.']?.dependencies?.[CLIGENT_DEP]?.version ?? '',
      `committed ${CLIGENT_DEP} resolution`,
    ).toMatch(/^\d+\.\d+\.\d+(?:\(|$)/);

    // The importer must agree with the manifest exactly, which is what
    // rejects the link by its effect rather than by its spelling: the
    // override rewrites the recorded specifier, so a link at any depth or
    // an absolute one disagrees with the declared range, as does a dropped
    // entry or a stale hand-edit (ERR_PNPM_OUTDATED_LOCKFILE). A tracked
    // override legitimately rewrites its own dependency's specifier, so it
    // is the effective specifier that must match.
    const isOverridden = (name: string): boolean =>
      Object.keys(declaredOverrides).some((key) => {
        const target = key.split('>').pop() ?? key;
        return target === name || target.startsWith(`${name}@`);
      });

    for (const group of DEPENDENCY_GROUPS) {
      const declared = committedPkg[group] ?? {};
      const recorded = committed.importers?.['.']?.[group] ?? {};
      expect(Object.keys(recorded).sort(), `${group} entries`).toEqual(
        Object.keys(declared).sort(),
      );
      for (const [name, range] of Object.entries(declared)) {
        // An overridden dependency's recorded specifier is whatever pnpm's
        // own rewrite rules produce, which a literal comparison cannot
        // predict; the override itself was checked above.
        if (!isOverridden(name)) {
          expect(recorded[name]?.specifier, `${group}.${name} specifier`).toBe(
            range,
          );
        }
        // A manifest may declare a local path, but only one that travels
        // with the package: a vendored archive under the package root ships
        // inside the tarball, while a linked directory or a path climbing
        // out of it resolves to something no consumer and no CI runner has.
        // Declaring it in tracked config does not make it portable.
        const declaresLocalPath = LOCAL_PROTOCOL.test(range);
        if (declaresLocalPath) {
          const target = range.slice(range.indexOf(':') + 1);
          expect(
            range.startsWith('file:') &&
              !target.startsWith('/') &&
              !target.startsWith('~') &&
              !target.startsWith('../'),
            `${group}.${name} declares ${range}, which leaves the package`,
          ).toBe(true);
        }
        // The resolution is checked separately from the specifier, because a
        // lockfile can name the declared range and still resolve it to a
        // local checkout — a shape that installs a dangling symlink with no
        // error at all, and the one the guard's own subject escapes through.
        if (!declaresLocalPath) {
          expect(
            recorded[name]?.version ?? '',
            `${group}.${name} resolves to a local path`,
          ).not.toMatch(LOCAL_PROTOCOL);
        }
        // RELEASE-14 has the pin refreshed *within* the declared range. A
        // pin outside it is not a disagreement the install reports: pnpm
        // trusts the recorded resolution, so it installs the forbidden
        // version and exits 0, and the surface the manifest was raised to
        // require is simply absent at run time. An overridden dependency is
        // exempt, its resolution being the override's to decide.
        if (CARET_RANGE.test(range) && !isOverridden(name)) {
          const resolved = recorded[name]?.version ?? '';
          expect(
            satisfiesCaret(resolved, range),
            `${group}.${name} pins ${resolved.split('(')[0]}, outside its declared ${range}`,
          ).toBe(true);
        }
      }
    }
  });

  it('pins the complete cligent release capabilities', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'playbook-cligent-release-'));
    try {
      const result = checkCligentReleaseCapabilities({
        cligentRoot: join(repoRoot, 'node_modules', '@sublang', 'cligent'),
        workRoot: join(scratch, 'check'),
      });
      expect(result.otherDiagnostics).toEqual([]);
      expect(result.unproven).toEqual([]);
      expect(result.proven).toEqual([
        'CaptainContext.emitReply',
        'CaptainRunResult.resumeToken',
        'Captain.prepareDispose',
        'CaptainContext.callPlayer options',
        'CaptainContext.callCaptain options',
        'CallPlayerOptions.resume',
        'CallPlayerOptions.settings',
        'CallCaptainOptions.resume',
        'CallCaptainOptions.allowedTools',
        'CallCaptainOptions.settings',
        'AgentCallSettings.model',
        'AgentCallSettings.effort',
        'AgentCallSettings.fastMode',
        'AgentCallSettings.instruction',
        'AgentCallSettings.permissions',
        'AgentCallSettingsError',
        'isAgentCallSettingsError',
        'assertFastModeSupported',
        'launchManagedTmuxPlay signature',
        'ManagedTmuxPlayLaunchContext.workDirOwnedByLauncher',
        'runManagedTmuxPlaySession signature',
        'ManagedTmuxPlaySessionOptions.workDirOwnedByLauncher',
        'ManagedTmuxPlayAttachOptions.signal',
        'ManagedTmuxPlayAttachOptions.beforeNativeAttach',
        'PreparedManagedTmuxPlayLaunch.attach options',
        'loadTmuxPlayConfig segmented player id',
        'loadTmuxPlayConfig empty player roster',
        'createTmuxPlayRuntime empty player roster',
        'assertFastModeSupported runtime semantics',
        'launchManagedTmuxPlay runtime export',
        'runManagedTmuxPlaySession runtime export',
      ]);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('adapter SDK declarations (RELEASE-27)', () => {
  // DR-027: cligent's own optional-peer declaration is the single range npm
  // checks. Absence, not identity — a restated range here is a second copy
  // that can only drift, and the earlier identity requirement froze at
  // cligent's old floor the first time cligent's moved.
  const ADAPTER_SDKS = [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
  ] as const;

  it.each(ADAPTER_SDKS)('declares no runtime range for %s', (sdk) => {
    expect(pkg.peerDependencies?.[sdk]).toBeUndefined();
    expect(pkg.peerDependenciesMeta?.[sdk]).toBeUndefined();
    expect(pkg.dependencies[sdk]).toBeUndefined();
    expect(pkg.optionalDependencies?.[sdk]).toBeUndefined();
    // The repo's own tests, CI, and acceptance runs still need real SDKs.
    expect(pkg.devDependencies[sdk]).toBeTypeOf('string');
  });
});

describe('GEARS grammar provenance (RELEASE-23)', () => {
  const SPEX_DEP = '@sublang/spex';
  const GRAMMAR_SPECS = [
    '@sublang/spex/scaffold/specs/meta.md',
    '@sublang/spex/scaffold/i18n/zh/specs/meta.md',
  ];

  it('declares and locks @sublang/spex no lower than 3.0.0', () => {
    const specifier = pkg.dependencies[SPEX_DEP];
    const lockEntry = lockfile.importers['.'].dependencies[SPEX_DEP];

    expect(specifier).toMatch(/^\^\d+\.\d+\.\d+$/);
    const [major] = specifier.slice(1).split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(3);
    expect(lockEntry.specifier).toBe(specifier);
    const [lockedMajor] = lockEntry.version.split('.').map(Number);
    expect(lockedMajor).toBeGreaterThanOrEqual(3);
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

describe('normal test gate (RELEASE-32)', () => {
  it('fails on Spex lint before starting Vitest', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'playbook-test-gate-'));
    const bin = join(scratch, 'node_modules', '.bin');
    const callLog = join(scratch, 'calls.log');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ private: true, scripts: pkg.scripts }),
    );
    writeFileSync(
      join(bin, 'spex'),
      [
        '#!/usr/bin/env node',
        "const { appendFileSync } = require('node:fs');",
        "appendFileSync(process.env.GATE_LOG, 'spex ' + process.argv.slice(2).join(' ') + '\\n');",
        'process.exit(Number(process.env.SPEX_EXIT));',
      ].join('\n'),
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'vitest'),
      [
        '#!/usr/bin/env node',
        "const { appendFileSync } = require('node:fs');",
        "appendFileSync(process.env.GATE_LOG, 'vitest ' + process.argv.slice(2).join(' ') + '\\n');",
      ].join('\n'),
      { mode: 0o755 },
    );

    const runGate = (spexExit: number): void => {
      execFileSync('pnpm', ['test'], {
        cwd: scratch,
        env: {
          ...process.env,
          GATE_LOG: callLog,
          SPEX_EXIT: String(spexExit),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    };

    try {
      expect(() => runGate(1)).toThrow();
      expect(readFileSync(callLog, 'utf8')).toBe('spex lint\n');

      writeFileSync(callLog, '');
      runGate(0);
      const calls = readFileSync(callLog, 'utf8').trimEnd().split('\n');
      const lintIndex = calls.indexOf('spex lint');
      const vitestIndex = calls.findIndex((call) => call.startsWith('vitest '));
      expect(lintIndex).toBeGreaterThanOrEqual(0);
      expect(vitestIndex).toBeGreaterThan(lintIndex);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
        defaultBuildCaptainJudgePrompt,
        normalizeError,
        normalizePlaybookSnapshot,
        snapshotJsonValue,
        snapshotPlaybookSession,
        validateCaptainResult,
        validatePlayerResult,
        waitForPlaybookQuiescence,
        emptyPlaybookEffectLedger,
        RUNTIME_ABI,
        SUPPORTED_ARTIFACT_SCHEMAS,
      } from '@sublang/playbook/xstate-runtime';
      for (const value of [
        assertJsonSafe,
        combineAbortSignals,
        createNestedPlaybookBridge,
        createXStatePlaybookRuntime,
        defaultBuildCaptainJudgePrompt,
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
      // DR-025: compiled Captain artifacts compose their adjudication
      // prompts through this builder, so the reply contract cannot drift.
      const judgePrompt = defaultBuildCaptainJudgePrompt(
        {
          stateId: 'routing',
          sourceItem: 'CAPTAIN-1',
          result: { question: 'Captain asked the one material routing question.' },
        },
        'A visible routing decision.',
      );
      if (
        !judgePrompt.includes('- \`question\` — ') ||
        !judgePrompt.includes(
          'Pick exactly one outcome by \`guard\` and return JSON ' +
            '\`{ guard, …structuralPayloadFields }\`',
        )
      ) {
        throw new Error('missing captain judge prompt contract');
      }
      // DR-022: the engine compatibility self-report ships on the same
      // public engine subpath the factory does.
      if (RUNTIME_ABI !== 1) {
        throw new Error('unexpected RUNTIME_ABI');
      }
      if (
        !Array.isArray(SUPPORTED_ARTIFACT_SCHEMAS) ||
        !Object.isFrozen(SUPPORTED_ARTIFACT_SCHEMAS) ||
        SUPPORTED_ARTIFACT_SCHEMAS.length !== 1 ||
        SUPPORTED_ARTIFACT_SCHEMAS[0] !== 3
      ) {
        throw new Error('unexpected SUPPORTED_ARTIFACT_SCHEMAS');
      }
      // DR-029 / PBRT-52: every runtime the shipped shared factory
      // constructs implements the optional control-surface pair together.
      const { createMachine } = await import('xstate');
      const probeRuntime = createXStatePlaybookRuntime(
        createMachine({
          id: 'probe',
          initial: 'ready',
          states: {
            ready: {
              meta: { playbook: { stateId: 'ready', description: 'ready state' } },
            },
          },
        }),
        {
          label: 'probe',
          compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
          snapshotOptions: (value) => value ?? {},
          roleStates: {},
          outcomeAuthority: { governedPlayerStates: {} },
        },
      )({
        configuredOptions: {},
        hostCapabilities: {
          repository: {
            runExclusive() { throw new Error('unused'); },
            runDeferred() { throw new Error('unused'); },
          },
          effectLedger: {
            snapshot: () => emptyPlaybookEffectLedger(),
            writeAhead: async () => emptyPlaybookEffectLedger(),
          },
        },
      });
      if (
        typeof probeRuntime.describe !== 'function' ||
        typeof probeRuntime.apply !== 'function'
      ) {
        throw new Error('missing control-surface pair');
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

describe('artifact schema cutover (RELEASE-15)', () => {
  it('keeps every shipped runtime and registry sibling on schema 3', () => {
    const schemaDeclaration = /artifactSchema:\s*3/;
    const legacyDeclaration =
      /artifactSchema:\s*2|SchemaV2|RegistryEntryV2/;

    for (const id of BUNDLED_WORKFLOW_IDS) {
      const base = `reference/sdlc/${id}.playbook/`;
      const runtimeSource = readFileSync(
        join(repoRoot, `${base}${id}.playbook.ts`),
        'utf8',
      );
      const runtimeJavaScript = readFileSync(
        join(repoRoot, `${base}${id}.playbook.js`),
        'utf8',
      );
      const runtimeDeclaration = readFileSync(
        join(repoRoot, `${base}${id}.playbook.d.ts`),
        'utf8',
      );
      for (const [kind, contents] of [
        ['TypeScript', runtimeSource],
        ['JavaScript', runtimeJavaScript],
      ] as const) {
        const currentSchemaContract =
          id === 'decide'
            ? /authority\.artifactSchema !== 3/
            : schemaDeclaration;
        expect(
          contents,
          `${id} ${kind} runtime omits its artifact-schema-3 contract`,
        ).toMatch(currentSchemaContract);
        expect(
          contents,
          `${id} ${kind} runtime retains artifact schema 2`,
        ).not.toMatch(legacyDeclaration);
      }
      expect(runtimeDeclaration).not.toMatch(legacyDeclaration);
      if (id === 'code' || id === 'review' || id === 'dev') {
        expect(runtimeDeclaration).toMatch(
          /XStatePlaybookRuntimeFactory<[\s\S]*, 3>;/,
        );
      } else {
        expect(runtimeDeclaration).toContain(
          'PlaybookRuntimeFactory<DecidePlaybookRuntimeConstruction>',
        );
      }

      for (const extension of ['ts', 'js', 'd.ts'] as const) {
        const registry = readFileSync(
          join(repoRoot, `${base}${id}.registry.${extension}`),
          'utf8',
        );
        expect(
          registry,
          `${id} registry.${extension} omits artifact schema 3`,
        ).toMatch(schemaDeclaration);
        expect(registry).not.toMatch(legacyDeclaration);
      }
    }

    for (const extension of ['ts', 'js'] as const) {
      const captain = readFileSync(
        join(repoRoot, `${CAPTAIN_BASE}captain.playbook.${extension}`),
        'utf8',
      );
      expect(
        captain,
        `Captain ${extension} runtime omits artifact schema 3`,
      ).toMatch(schemaDeclaration);
      expect(captain).not.toMatch(legacyDeclaration);
    }
    const captainDeclaration = readFileSync(
      join(repoRoot, `${CAPTAIN_BASE}captain.playbook.d.ts`),
      'utf8',
    );
    expect(captainDeclaration).toContain(
      'createPlaybookRuntime(options: PlaybookRuntimeOptions)',
    );
    expect(captainDeclaration).not.toMatch(legacyDeclaration);
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
    const requiredWorkflowArtifacts = BUNDLED_WORKFLOW_IDS.flatMap((id) => [
      `reference/sdlc/${id}.md`,
      ...REQUIRED_WORKFLOW_ARTIFACT_SUFFIXES.map(
        (suffix) => `reference/sdlc/${id}.playbook/${id}.${suffix}`,
      ),
    ]);
    for (const artifact of [
      'src/runtime.js',
      'src/runtime.d.ts',
      'src/accepted-outcome.ts',
      'src/accepted-outcome.js',
      'src/accepted-outcome.d.ts',
      'src/xstate-runtime.js',
      'src/xstate-runtime.d.ts',
      'src/xstate-playbook-runtime.js',
      'src/xstate-playbook-runtime.d.ts',
      'reference/sdlc/captain.md',
      `${CAPTAIN_BASE}captain.gears.md`,
      `${CAPTAIN_BASE}captain.fsm.ts`,
      `${CAPTAIN_BASE}captain.fsm.js`,
      `${CAPTAIN_BASE}captain.fsm.d.ts`,
      `${CAPTAIN_BASE}captain.playbook.ts`,
      `${CAPTAIN_BASE}captain.playbook.js`,
      `${CAPTAIN_BASE}captain.playbook.d.ts`,
      ...requiredWorkflowArtifacts,
    ]) {
      expect(packed, `tarball missing ${artifact}`).toContain(artifact);
    }
    expect(packed).not.toContain('reference/sdlc/discuss.md');
    expect(
      packed.filter((path) =>
        path.startsWith('reference/sdlc/discuss.playbook/'),
      ),
      'tarball still carries retired DISCUSS artifacts',
    ).toEqual([]);
    // RELEASE-18/20: the README delegates usage to docs/, so an installed
    // copy must carry every guide it links to — otherwise those links point
    // at content the tarball does not have.
    const readme = readFileSync(
      new URL('../README.md', import.meta.url),
      'utf8',
    );
    const linkedDocs = [
      ...new Set(
        [...readme.matchAll(/\]\((docs\/[^)#]+\.md)[^)]*\)/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    expect(linkedDocs.length).toBeGreaterThan(0);
    for (const doc of linkedDocs) {
      expect(packed, `tarball missing ${doc} linked from README`).toContain(
        doc,
      );
    }
    for (const name of SLC_SPECS) {
      expect(packed, `tarball missing slc/${name}`).toContain(`slc/${name}`);
    }
  });

  // RELEASE-20: every Markdown file the tarball ships must be link-closed
  // over the packed file list — each relative link target and reference
  // definition in a packed .md resolves to a packed file (or a directory
  // containing packed files), and a fragment on a packed Markdown target
  // names an anchor that file renders. The first-hop README check above
  // cannot see a dead link inside docs/ or slc/; this recursive scan can,
  // so repository-only content must be cited by absolute repository URL.
  it('resolves every relative link in packed markdown against the packed list', () => {
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
    const packed = new Set<string>(
      JSON.parse(out)[0].files.map((f: { path: string }) => f.path),
    );
    const decode = (part: string): string => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    const anchorCache = new Map<string, Set<string>>();
    const anchorsFor = (doc: string): Set<string> => {
      let anchors = anchorCache.get(doc);
      if (anchors === undefined) {
        anchors = anchorsOf(readFileSync(join(repoRoot, doc), 'utf8'));
        anchorCache.set(doc, anchors);
      }
      return anchors;
    };
    const failures: string[] = [];
    let scanned = 0;
    for (const doc of [...packed].filter((path) => path.endsWith('.md'))) {
      // release-28 step 8 pins packed bytes to repository bytes, so the
      // repository copy is the packed content.
      for (const { line, target } of linksOf(
        readFileSync(join(repoRoot, doc), 'utf8'),
      )) {
        scanned += 1;
        const hash = target.indexOf('#');
        const filePart = decode(hash === -1 ? target : target.slice(0, hash));
        const fragment = hash === -1 ? '' : decode(target.slice(hash + 1));
        const dest =
          filePart === ''
            ? doc
            : posix.normalize(
                filePart.startsWith('/')
                  ? filePart.slice(1)
                  : posix.join(posix.dirname(doc), filePart),
              );
        const where = `${doc}:${line} (${target})`;
        // release-20: a packed SLC definition's citation into `specs/` is a
        // repository citation under the specs tree's own citation law
        // (meta-16 requires the relative form), exempt from the closure —
        // but not from verification (meta-33): the exempted target must be
        // a repository file, and its fragment a real anchor of that file.
        if (doc.startsWith('slc/') && dest.startsWith('specs/')) {
          const repositoryTarget = join(repoRoot, dest);
          if (
            !existsSync(repositoryTarget) ||
            !statSync(repositoryTarget).isFile()
          ) {
            failures.push(
              `${where} exempted slc→specs citation target is not a repository file: ${dest}`,
            );
          } else if (
            fragment !== '' &&
            dest.endsWith('.md') &&
            !anchorsFor(dest).has(fragment)
          ) {
            failures.push(
              `${where} exempted slc→specs citation anchor missing: #${fragment} in ${dest}`,
            );
          }
          continue;
        }
        if (dest.startsWith('..')) {
          failures.push(`${where} escapes the package`);
          continue;
        }
        const isPackedDir = [...packed].some((path) =>
          path.startsWith(`${dest}/`),
        );
        if (!packed.has(dest) && !isPackedDir) {
          failures.push(`${where} targets nothing packed: ${dest}`);
          continue;
        }
        if (fragment === '' || !dest.endsWith('.md') || !packed.has(dest)) {
          continue;
        }
        if (!anchorsFor(dest).has(fragment)) {
          failures.push(`${where} names no anchor #${fragment} in ${dest}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Guard against a vacuous pass: the packed docs really carry links.
    expect(scanned).toBeGreaterThan(50);
  });

  // RELEASE-20: repository-only content is cited from packed docs by
  // absolute repository URL on the repository's main line — a deliberate
  // living pointer. `linksOf` collects relative links only, so those URLs
  // escape both the closure above and scripts/check-links.mjs (meta-33);
  // this scan verifies each one against the repository tree: `blob` and
  // `tree` links both name this repository and exactly `main`, their path has
  // the right file/directory kind, and a fragment on a Markdown target names
  // an anchor that file renders. Other repositories remain ordinary external
  // citations; a foreign owner/repository naming a local path is a malformed
  // living pointer rather than an escape from this check.
  // The dry-pack plus full Markdown/anchor scan exceeds Vitest's five-second
  // default on slower Node 20 CI runners, so budget only this heavy case.
  it('resolves every living-pointer URL in packed markdown against the repository', () => {
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
    const packedDocs = (
      JSON.parse(out)[0].files as { path: string }[]
    )
      .map((f) => f.path)
      .filter((path) => path.endsWith('.md'));
    // check-links.mjs keeps its fence/code-span blanking private, so the
    // same masking is replicated minimally here: fenced blocks are blanked
    // line by line and inline code spans are overwritten with spaces (line
    // breaks preserved), so a URL quoted as code mints no check and match
    // offsets still map to the right line.
    const FENCE = /^ {0,3}(`{3,}|~{3,})/;
    const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?\1/g;
    const blankFences = (text: string): string => {
      let fence: string | null = null;
      return text
        .split('\n')
        .map((line) => {
          const match = FENCE.exec(line);
          if (match !== null) {
            const marker = match[1][0];
            if (fence === null) fence = marker;
            else if (fence === marker) fence = null;
            return '';
          }
          return fence === null ? line : '';
        })
        .join('\n');
    };
    const blankCodeSpans = (text: string): string =>
      text.replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, ' '));
    const GITHUB_CONTENT_POINTER =
      /https:\/\/github\.com\/([^/)\s]+)\/([^/)\s]+)\/(blob|tree)\/([^/]+)\/([^#)\s]+)(#[^)\s]*)?/g;
    const decode = (part: string): string => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    const failures: string[] = [];
    const forms = new Set<string>();
    let scanned = 0;
    for (const doc of packedDocs) {
      // release-28 step 8 pins packed bytes to repository bytes, so the
      // repository copy is the packed content.
      const body = blankCodeSpans(
        blankFences(readFileSync(join(repoRoot, doc), 'utf8')),
      );
      for (const match of body.matchAll(GITHUB_CONTENT_POINTER)) {
        const [url, owner, repository, form, branch, pathPart, fragmentPart] =
          match;
        const line = body.slice(0, match.index).split('\n').length;
        const where = `${doc}:${line} (${url})`;
        const dest = posix.normalize(decode(pathPart));
        const safePath = !dest.startsWith('..') && !posix.isAbsolute(dest);
        const repositoryTarget = join(repoRoot, dest);
        const targetExists = safePath && existsSync(repositoryTarget);
        const isThisRepository =
          owner === 'sublang-ai' && repository === 'playbook';
        if (!isThisRepository) {
          if (targetExists) {
            failures.push(
              `${where} points at local path ${dest} through ${owner}/${repository}, not sublang-ai/playbook`,
            );
          }
          continue;
        }
        scanned += 1;
        forms.add(form);
        if (branch !== 'main') {
          failures.push(
            `${where} pins branch ${branch}, not the main living pointer`,
          );
          continue;
        }
        if (!safePath) {
          failures.push(`${where} escapes the repository: ${dest}`);
          continue;
        }
        if (!targetExists) {
          failures.push(`${where} targets no repository path: ${dest}`);
          continue;
        }
        const target = statSync(repositoryTarget);
        if (form === 'blob' && !target.isFile()) {
          failures.push(`${where} blob target is not a file: ${dest}`);
          continue;
        }
        if (form === 'tree' && !target.isDirectory()) {
          failures.push(`${where} tree target is not a directory: ${dest}`);
          continue;
        }
        const fragment =
          fragmentPart === undefined ? '' : decode(fragmentPart.slice(1));
        if (fragment === '' || !dest.endsWith('.md')) {
          continue;
        }
        if (!anchorsOf(readFileSync(join(repoRoot, dest), 'utf8')).has(fragment)) {
          failures.push(`${where} names no anchor #${fragment} in ${dest}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Guard against a vacuous pass: packed docs really carry living pointers.
    expect(scanned).toBeGreaterThan(10);
    // Both URL forms occur in the packed docs; pin both parser branches so a
    // blob-only matcher cannot silently wave through a broken tree pointer.
    expect([...forms].sort()).toEqual(['blob', 'tree']);
  }, 30_000);
});

describe('public CLI and registry surface (RELEASE-21)', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { bin: Record<string, string>; exports: Record<string, unknown> };
  const CODE_BASE = 'reference/sdlc/code.playbook/';
  const REVIEW_BASE = 'reference/sdlc/review.playbook/';
  const DECIDE_BASE = 'reference/sdlc/decide.playbook/';
  const DEV_BASE = 'reference/sdlc/dev.playbook/';

  it('declares the playbook bin and registry exports, not the retired surfaces', () => {
    expect(manifest.bin).toEqual({
      playbook: 'reference/sdlc/code.playbook/bin/playbook.js',
    });
    expect(manifest.exports).toHaveProperty('./runtime');
    expect(manifest.exports).toHaveProperty('./xstate-runtime');
    expect(manifest.exports).toHaveProperty('./code/registry');
    expect(manifest.exports).toHaveProperty('./review/registry');
    expect(manifest.exports).toHaveProperty('./decide/registry');
    expect(manifest.exports).toHaveProperty('./dev/registry');
    expect(manifest.exports).toHaveProperty('./captain/playbook');
    expect(manifest.exports).not.toHaveProperty('./discuss/playbook');
    expect(manifest.exports).not.toHaveProperty('./discuss/registry');
    expect(manifest.exports).not.toHaveProperty('./captain/registry');
    expect(manifest.exports).not.toHaveProperty('./code/tmux-play');
    expect(manifest.exports).not.toHaveProperty('./interactive-session');
  });

  // RELEASE-20: the semver-stable unit of a public subpath is the module's
  // declared public API, not merely the `exports` entry. Pinning only the
  // entry is what let two named exports of `./captain/playbook` be removed
  // with every gate green and the question of whether that was breaking left
  // to be adjudicated after the fact. These sets are the recorded API: a
  // removal or rename goes red here and is decided as a release event before
  // the tag. `_internal` members are deliberately not pinned — the leading
  // underscore declares them subject to change.
  //
  // The JavaScript module and the declaration file are two sets, not one. The
  // first version of this gate compared one recorded set against both, which
  // forced its declaration scan to match only the forms the JavaScript also
  // carries — value declarations — and so left every exported interface, type
  // alias, and type re-export unpinned. Those are the whole public API of a
  // type-only subpath such as `./runtime`, and they are what a consumer of
  // `./captain/playbook` implements: `CaptainControllerPort` is the type of
  // `PlaybookRuntimeOptions.controller`, which every host must satisfy to
  // construct the runtime. Removing one breaks a consumer at compile time,
  // which is the same release event by a different mechanism.
  //
  // *Which* subpaths are pinned is derived from the manifest rather than
  // listed, because a literal list is the same bug one level up. Four
  // subpaths were named here while `./xstate-runtime` — a public,
  // semver-stable surface by RELEASE-15, with `createXStatePlaybookRuntime`
  // and `RUNTIME_ABI` on it — sat outside the gate entirely, along with
  // `./code/playbook`, `./playbook-captain`, and the bundled workflow
  // playbooks. Adding the missing name would have repeated the mistake;
  // deriving the set makes
  // a subpath added to `package.json` go red until it is recorded.
  const UNPINNABLE_SUBPATHS: Record<string, string> = {
    './slc/*':
      'a wildcard directory mapping to authored specs, not a module with an export set',
  };

  const publicSubpaths = (): string[] =>
    Object.keys(manifest.exports)
      .filter((subpath) => !(subpath in UNPINNABLE_SUBPATHS))
      .sort();

  const PUBLIC_MODULE_EXPORTS: Record<string, readonly string[]> = {
    './runtime': [],
    './xstate-runtime': [
      'BOSS_REPLY_ERRORS',
      'NestedPlaybookCallError',
      'PlaybookSemanticCandidateStructureError',
      'RUNTIME_ABI',
      'SUPPORTED_ARTIFACT_SCHEMAS',
      'activePlaybookStateMetadata',
      'adjudicatePlayerOutput',
      'assertJsonSafe',
      'assertPlaybookEffectLedger',
      'assertPlaybookRuntimeSnapshot',
      'combineAbortSignals',
      'createNestedPlaybookBridge',
      'createPlayerBridge',
      'createXStatePlaybookRuntime',
      'defaultBuildCaptainJudgePrompt',
      'defaultBuildJudgePrompt',
      'defaultComposeCaptainPrompt',
      'defaultComposePlayerPrompt',
      'defaultExtractRequiredFields',
      'detachPersistedMachineSnapshot',
      'emptyPlaybookEffectLedger',
      'extractJsonValue',
      'hiddenControlEnvelope',
      'isPlaybookEffectLedgerMonotonicExtension',
      'normalizeError',
      'normalizeErrorCompact',
      'normalizeErrorFull',
      'normalizePlaybookSnapshot',
      'parseJudgeJson',
      'pendingBossQuestionFromContext',
      'registerPlaybookAbortCleanup',
      'reconcilePlaybookSemanticEvidence',
      'resumableStateIdsFromMachine',
      'snapshotJsonValue',
      'snapshotPlaybookSession',
      'stateDescriptionsFromMachine',
      'stripCodeFence',
      'validateCaptainResult',
      'validatePlaybookCallResult',
      'validatePlaybookCallStart',
      'validatePlayerResult',
      'waitForPlaybookQuiescence',
    ],
    './captain/playbook': ['_internal', 'createPlaybookRuntime', 'default'],
    './code/playbook': ['_internal', 'default'],
    './code/registry': [
      'codeCopyPasteGuardNames',
      'codePlaybookRegistryEntry',
      'codeSavedCountsLine',
      'codeStateCountLabels',
      'codeSummaryPolicy',
      'default',
      'validateCodeOptions',
    ],
    './playbook-captain': [
      'assertPlaybookCaptainUnresolvedEffects',
      'assertPlaybookCaptainShellSnapshot',
      'createPlaybookCaptainShell',
      'default',
    ],
    './session-store': [
      'RECORDS_STREAM_VERSION',
      'defaultSessionsDir',
      'openSessionStore',
    ],
    './review/playbook': ['_internal', 'default'],
    './review/registry': [
      'default',
      'reviewCopyPasteGuardNames',
      'reviewPlaybookRegistryEntry',
      'reviewSavedCountsLine',
      'reviewStateCountLabels',
      'reviewSummaryPolicy',
      'validateReviewOptions',
    ],
    './decide/playbook': ['_internal', 'createPlaybookRuntime', 'default'],
    './decide/registry': [
      'decideCopyPasteGuardNames',
      'decidePlaybookRegistryEntry',
      'decideSavedCountsLine',
      'decideStateCountLabels',
      'decideSummaryPolicy',
      'default',
      'validateDecideOptions',
    ],
    './dev/playbook': ['_internal', 'default'],
    './dev/registry': [
      'default',
      'devCopyPasteGuardNames',
      'devPlaybookRegistryEntry',
      'devSavedCountsLine',
      'devStateCountLabels',
      'devSummaryPolicy',
      'validateDevOptions',
    ],
  };

  const PUBLIC_DECLARATION_EXPORTS: Record<string, readonly string[]> = {
    // Type-only by construction (`export {}` in the JavaScript): its whole
    // public API is declarations, so the old gate pinned none of it.
    './runtime': [
      'CaptainCallOptions',
      'CaptainResult',
      'JsonValue',
      'NormalizedError',
      'PlaybookAdoptionContext',
      'PlaybookCallRequest',
      'PlaybookCallResult',
      'PlaybookCallStart',
      'PlaybookControlAction',
      'PlaybookControlReceipt',
      'PlaybookControlView',
      'PlaybookEffectBoundary',
      'PlaybookEffectBoundaryStart',
      'PlaybookEffectLedger',
      'PlaybookEffectLedgerCapability',
      'PlaybookEffectLedgerCommand',
      'PlaybookEffectLedgerCommandBatch',
      'PlaybookEffectLogicalOperation',
      'PlaybookPendingBossQuestion',
      'PlaybookPendingCall',
      'PlaybookPorts',
      'PlaybookRunResult',
      'PlaybookRetainedGenerationMetadata',
      'PlaybookRuntime',
      'PlaybookRuntimeFactory',
      'PlaybookRuntimeSnapshot',
      'PlaybookRoleBinding',
      'PlaybookRepositoryDisposition',
      'PlaybookRepositoryObservation',
      'PlaybookRepositoryReceipt',
      'PlaybookSession',
      'PlaybookState',
      'PlaybookStateValue',
      'PlaybookSuspendedCall',
      'PlaybookTraceEvent',
      'PlaybookTraceType',
      'PlayerCallOptions',
      'PlayerResult',
      'PlayerSessionStore',
    ],
    // Reached through the one resolved wildcard in the package: this file
    // re-exports the engine module whole, so the engine's declarations are
    // part of this subpath's semver-stable surface and are recorded here.
    './xstate-runtime': [
      'BOSS_REPLY_ERRORS',
      'JudgePurpose',
      'NestedPlaybookBridge',
      'NestedPlaybookBridgeOptions',
      'NestedPlaybookCallError',
      'NestedPlaybookInput',
      'PendingCallObserver',
      'PlaybookActorOutput',
      'PlaybookCallFinished',
      'PlaybookCallStarted',
      'PlaybookCaptainInput',
      'PlaybookPendingBossQuestionContext',
      'PlaybookPlayerInput',
      'PlaybookRuntimeSnapshotValidationOptions',
      'PlaybookReconciledSemanticOutput',
      'PlaybookRetainedSemanticEvidence',
      'PlaybookSemanticCandidateStructureError',
      'PlaybookSemanticEvidenceInput',
      'PlaybookSemanticFieldAuthority',
      'PlaybookSemanticOutcomeSpec',
      'PlaybookSemanticReconciliation',
      'PlaybookSemanticReconciliationReason',
      'PlaybookScriptInput',
      'PlaybookStateMetadata',
      'PlayerAdjudicationSpec',
      'RUNTIME_ABI',
      'RuntimeBoundaryCalls',
      'SUPPORTED_ARTIFACT_SCHEMAS',
      'ScheduledStatus',
      'SnapshotNormalizationOptions',
      'WaitForPlaybookQuiescenceOptions',
      'XStateBossEventFieldSpec',
      'XStateBossEventSpec',
      'XStateCaptainCallOptions',
      'XStateCaptainStrategy',
      'XStateCaptainStrategyRun',
      'XStateGovernedOutcomeSpec',
      'XStateOutcomeAuthoritySpec',
      'XStateOutcomeFieldAuthority',
      'XStatePlaybookRuntimeConstruction',
      'XStatePlaybookRuntimeFactory',
      'XStatePlaybookRuntimeFactoryOptions',
      'XStatePlaybookRuntimeSpecV3',
      'XStatePromptIdentity',
      'XStateRoleStateStatus',
      'XStatePlaybookRuntimeCompat',
      'XStatePlaybookRuntimeSpec',
      'XStateRepositoryCapability',
      'XStateRepositoryDisposition',
      'activePlaybookStateMetadata',
      'adjudicatePlayerOutput',
      'assertJsonSafe',
      'assertPlaybookEffectLedger',
      'assertPlaybookRuntimeSnapshot',
      'combineAbortSignals',
      'createNestedPlaybookBridge',
      'createPlayerBridge',
      'createXStatePlaybookRuntime',
      'defaultBuildCaptainJudgePrompt',
      'defaultBuildJudgePrompt',
      'defaultComposeCaptainPrompt',
      'defaultComposePlayerPrompt',
      'defaultExtractRequiredFields',
      'detachPersistedMachineSnapshot',
      'emptyPlaybookEffectLedger',
      'extractJsonValue',
      'hiddenControlEnvelope',
      'isPlaybookEffectLedgerMonotonicExtension',
      'normalizeError',
      'normalizeErrorCompact',
      'normalizeErrorFull',
      'normalizePlaybookSnapshot',
      'parseJudgeJson',
      'pendingBossQuestionFromContext',
      'registerPlaybookAbortCleanup',
      'reconcilePlaybookSemanticEvidence',
      'resumableStateIdsFromMachine',
      'snapshotJsonValue',
      'snapshotPlaybookSession',
      'stateDescriptionsFromMachine',
      'stripCodeFence',
      'validateCaptainResult',
      'validatePlaybookCallResult',
      'validatePlaybookCallStart',
      'validatePlayerResult',
      'waitForPlaybookQuiescence',
    ],
    './captain/playbook': [
      'CaptainCallOptions',
      'CaptainControllerInput',
      'CaptainControllerPort',
      'CaptainControllerSelection',
      'CaptainParsedResolution',
      'CaptainResult',
      'DecisionAction',
      'EnabledPlaybook',
      'JsonValue',
      'NormalizedError',
      'ParsedActingDecision',
      'PlaybookCallRequest',
      'PlaybookCallResult',
      'PlaybookCallStart',
      'PlaybookControlReceipt',
      'PlaybookControlView',
      'PlaybookPendingCall',
      'PlaybookPorts',
      'PlaybookRunResult',
      'PlaybookRuntime',
      'PlaybookRuntimeFactory',
      'PlaybookRuntimeOptions',
      'PlaybookRuntimeSnapshot',
      'PlaybookSession',
      'PlaybookState',
      'PlaybookStateValue',
      'PlaybookTraceEvent',
      'PlaybookTraceType',
      'PlayerCallOptions',
      'PlayerResult',
      'SettlementEvidence',
      'SettlementReceiptEvidence',
      '_internal',
      'createPlaybookRuntime',
      'default',
    ],
    './code/playbook': [
      'CaptainCallOptions',
      'CaptainResult',
      'CodePlaybookHostCapabilities',
      'CodePlaybookOptions',
      'JsonValue',
      'NormalizedError',
      'PlaybookCallRequest',
      'PlaybookCallResult',
      'PlaybookCallStart',
      'PlaybookControlReceipt',
      'PlaybookControlView',
      'PlaybookPendingCall',
      'PlaybookPorts',
      'PlaybookRunResult',
      'PlaybookRuntime',
      'PlaybookRuntimeFactory',
      'PlaybookRuntimeSnapshot',
      'PlaybookSession',
      'PlaybookState',
      'PlaybookStateValue',
      'PlaybookTraceEvent',
      'PlaybookTraceType',
      'PlayerCallOptions',
      'PlayerResult',
      'PlayerSessionStore',
      '_internal',
      'default',
    ],
    './code/registry': [
      'CodeOptions',
      'CodePlaybookRegistryEntry',
      'PlaybookSummaryPolicy',
      'codeCopyPasteGuardNames',
      'codePlaybookRegistryEntry',
      'codeSavedCountsLine',
      'codeStateCountLabels',
      'codeSummaryPolicy',
      'default',
      'validateCodeOptions',
    ],
    './playbook-captain': [
      'PlaybookCaptainDeps',
      'PlaybookCaptainFrameSnapshot',
      'PlaybookCaptainRegistryEntry',
      'PlaybookCaptainRegistryEntryV3',
      'PlaybookCaptainRuntimeProfile',
      'PlaybookCaptainRetainedGeneration',
      'PlaybookCaptainRetentionUpdate',
      'PlaybookCaptainSettlement',
      'PlaybookCaptainShell',
      'PlaybookCaptainShellSnapshot',
      'PlaybookCaptainUnresolvedEffect',
      'PlaybookHostConstructionCapabilities',
      'assertPlaybookCaptainUnresolvedEffects',
      'assertPlaybookCaptainShellSnapshot',
      'createPlaybookCaptainShell',
      'default',
    ],
    './session-store': [
      'LeaseReplayStreamReadResult',
      'PlaybookSessionLease',
      'PlaybookSessionListResult',
      'PlaybookSessionStore',
      'PlaybookSessionSummary',
      'RECORDS_STREAM_VERSION',
      'ReplayJsonValue',
      'ReplayRecord',
      'ReplayStreamEntry',
      'ReplayStreamReadOptions',
      'ReplayStreamReadResult',
      'ReplayStreamStatus',
      'SkippedPlaybookSession',
      'defaultSessionsDir',
      'openSessionStore',
    ],
    './review/playbook': [
      'CaptainCallOptions',
      'CaptainResult',
      'JsonValue',
      'NormalizedError',
      'PlaybookCallRequest',
      'PlaybookCallResult',
      'PlaybookCallStart',
      'PlaybookControlReceipt',
      'PlaybookControlView',
      'PlaybookPendingCall',
      'PlaybookPorts',
      'PlaybookRunResult',
      'PlaybookRuntime',
      'PlaybookRuntimeFactory',
      'PlaybookRuntimeSnapshot',
      'PlaybookSession',
      'PlaybookState',
      'PlaybookStateValue',
      'PlaybookTraceEvent',
      'PlaybookTraceType',
      'PlayerCallOptions',
      'PlayerResult',
      'PlayerSessionStore',
      'ReviewPlaybookHostCapabilities',
      'ReviewPlaybookOptions',
      '_internal',
      'default',
    ],
    './review/registry': [
      'PlaybookSummaryPolicy',
      'ReviewOptions',
      'ReviewPlaybookRegistryEntry',
      'default',
      'reviewCopyPasteGuardNames',
      'reviewPlaybookRegistryEntry',
      'reviewSavedCountsLine',
      'reviewStateCountLabels',
      'reviewSummaryPolicy',
      'validateReviewOptions',
    ],
    './decide/playbook': [
      'CaptainCallOptions',
      'CaptainResult',
      'DecidePlaybookHostCapabilities',
      'DecidePlaybookRuntimeConstruction',
      'JsonValue',
      'NormalizedError',
      'PlaybookCallRequest',
      'PlaybookCallResult',
      'PlaybookCallStart',
      'PlaybookControlAction',
      'PlaybookControlReceipt',
      'PlaybookControlView',
      'PlaybookPendingCall',
      'PlaybookPorts',
      'PlaybookRunResult',
      'PlaybookRuntime',
      'PlaybookRuntimeFactory',
      'PlaybookRuntimeOptions',
      'PlaybookRuntimeSnapshot',
      'PlaybookSession',
      'PlaybookState',
      'PlaybookStateValue',
      'PlaybookTraceEvent',
      'PlaybookTraceType',
      'PlayerCallOptions',
      'PlayerResult',
      'PlayerSessionStore',
      '_internal',
      'createPlaybookRuntime',
      'default',
    ],
    './decide/registry': [
      'DecideOptions',
      'DecidePlaybookRegistryEntry',
      'PlaybookSummaryPolicy',
      'decideCopyPasteGuardNames',
      'decidePlaybookRegistryEntry',
      'decideSavedCountsLine',
      'decideStateCountLabels',
      'decideSummaryPolicy',
      'default',
      'validateDecideOptions',
    ],
    './dev/playbook': [
      'CaptainCallOptions',
      'CaptainResult',
      'DevPlaybookHostCapabilities',
      'DevPlaybookOptions',
      'JsonValue',
      'NormalizedError',
      'PlaybookCallRequest',
      'PlaybookCallResult',
      'PlaybookCallStart',
      'PlaybookControlReceipt',
      'PlaybookControlView',
      'PlaybookPendingCall',
      'PlaybookPorts',
      'PlaybookRunResult',
      'PlaybookRuntime',
      'PlaybookRuntimeFactory',
      'PlaybookRuntimeSnapshot',
      'PlaybookSession',
      'PlaybookState',
      'PlaybookStateValue',
      'PlaybookTraceEvent',
      'PlaybookTraceType',
      'PlayerCallOptions',
      'PlayerResult',
      'PlayerSessionStore',
      '_internal',
      'default',
    ],
    './dev/registry': [
      'DevOptions',
      'DevPlaybookRegistryEntry',
      'PlaybookSummaryPolicy',
      'default',
      'devCopyPasteGuardNames',
      'devPlaybookRegistryEntry',
      'devSavedCountsLine',
      'devStateCountLabels',
      'devSummaryPolicy',
      'validateDevOptions',
    ],
  };

  it('pins every public subpath the manifest declares', () => {
    const pinned = publicSubpaths();
    expect(Object.keys(PUBLIC_MODULE_EXPORTS).sort()).toEqual(pinned);
    expect(Object.keys(PUBLIC_DECLARATION_EXPORTS).sort()).toEqual(pinned);
    // An exclusion is a recorded decision with a stated reason, not a gap.
    for (const [subpath, reason] of Object.entries(UNPINNABLE_SUBPATHS)) {
      expect(manifest.exports, `${subpath} is no longer declared`).toHaveProperty(
        subpath,
      );
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  // Every top-level export a declaration file declares: value declarations
  // (`export declare function|const|class|let|var|enum|namespace`), type
  // declarations (`export interface|type`, with or without `declare`), the
  // brace re-export lists in both their value and `export type { … }` forms
  // — where the *exported* name is the one after `as` — and the default.
  function declaredExports(dts: string): string[] {
    const declared = new Set<string>();
    for (const match of dts.matchAll(
      /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:function|const|class|let|var|enum|namespace|interface|type)\s+(\w+)/gm,
    )) {
      declared.add(match[1]!);
    }
    for (const match of dts.matchAll(/^export\s+(?:type\s+)?\{([\s\S]*?)\}/gm)) {
      for (const entry of match[1]!.split(',')) {
        const raw = entry.trim().replace(/^type\s+/, '');
        if (raw.length === 0) continue;
        const parts = raw.split(/\s+as\s+/);
        declared.add(parts[parts.length - 1]!.trim());
      }
    }
    if (/^export default /m.test(dts)) declared.add('default');
    return [...declared].sort();
  }

  /**
   * Wildcard re-exports, in both the value form and the `export type *` form
   * TypeScript 5.0 added. The type form is the one that matters in a
   * *declaration* file, and the gate used to reject only the value form —
   * `export type * from './x.js'` matched neither the rejection nor the
   * extractor, so it added an unbounded type surface with every row green.
   *
   * A wildcard whose target is a relative path inside the package is resolved
   * and enumerated, so the re-exported names are recorded like any others. One
   * that is not — a bare package specifier, a missing target, or a target
   * outside the package root — cannot be enumerated, and it fails.
   */
  const WILDCARD_REEXPORT =
    /^[ \t]*export[ \t]+(?:type[ \t]+)?\*[ \t]+from[ \t]+(['"])([^'"]+)\1[ \t]*;?[ \t]*\r?$/gm;

  const isWithin = (root: string, target: string): boolean => {
    const path = relative(root, target);
    return (
      path === '' ||
      (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
    );
  };

  function resolveDeclarationExports(
    file: URL,
    packageRoot: URL = packageRootUrl,
    seen: ReadonlySet<string> = new Set(),
  ): string[] {
    const href = file.href;
    if (seen.has(href)) return [];
    const dts = readFileSync(file, 'utf8');
    const names = new Set(declaredExports(dts));
    for (const match of dts.matchAll(WILDCARD_REEXPORT)) {
      const specifier = match[2]!;
      if (!/^\.\.?\//.test(specifier)) {
        throw new Error(
          `${href} re-exports by wildcard from "${specifier}", which no single-file enumeration can resolve`,
        );
      }
      const target = new URL(specifier.replace(/\.js$/, '.d.ts'), file);
      const rootPath = fileURLToPath(packageRoot);
      const targetPath = fileURLToPath(target);
      if (!isWithin(rootPath, targetPath)) {
        throw new Error(
          `${href} re-exports by wildcard from "${specifier}", whose target is outside the package root`,
        );
      }
      if (!existsSync(target)) {
        throw new Error(
          `${href} re-exports by wildcard from "${specifier}", whose declaration file is missing`,
        );
      }
      for (const name of resolveDeclarationExports(
        target,
        packageRoot,
        new Set([...seen, href]),
      )) {
        names.add(name);
      }
    }
    return [...names].sort();
  }

  const declarationUrlOf = (subpath: string): URL =>
    new URL(
      `../${(manifest.exports[subpath] as { types: string }).types}`,
      import.meta.url,
    );

  const declarationSourceOf = (subpath: string): string =>
    readFileSync(declarationUrlOf(subpath), 'utf8');

  it.each(Object.entries(PUBLIC_MODULE_EXPORTS))(
    '%s declares exactly its recorded JavaScript exports',
    async (subpath, expected) => {
      const entry = manifest.exports[subpath] as { default: string };
      const loaded = (await import(
        new URL(`../${entry.default}`, import.meta.url).href
      )) as Record<string, unknown>;
      expect(Object.keys(loaded).sort()).toEqual([...expected].sort());
    },
  );

  it.each(Object.entries(PUBLIC_DECLARATION_EXPORTS))(
    '%s declares exactly its recorded declaration exports',
    (subpath, expected) => {
      expect(resolveDeclarationExports(declarationUrlOf(subpath))).toEqual(
        [...expected].sort(),
      );
    },
  );

  it('publishes a self-contained strict session-store declaration', () => {
    const declaration = declarationSourceOf('./session-store');
    expect(declaration).not.toMatch(/^\s*import\b/m);
    expect(declaration).not.toMatch(/\bfrom\s+['"]/);

    const scratch = mkdtempSync(join(tmpdir(), 'playbook-session-types-'));
    try {
      mkdirSync(join(scratch, 'node_modules', '@sublang'), { recursive: true });
      symlinkSync(
        repoRoot,
        join(scratch, 'node_modules', '@sublang', 'playbook'),
        'junction',
      );
      writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n');
      const fixture = join(scratch, 'consumer.ts');
      writeFileSync(
        fixture,
        `// @ts-expect-error the facade has no default export
import sessionStoreDefault, {
  RECORDS_STREAM_VERSION,
  defaultSessionsDir,
  openSessionStore,
  type LeaseReplayStreamReadResult,
  type PlaybookSessionLease,
  type PlaybookSessionStore,
  type ReplayStreamReadOptions,
  type ReplayStreamStatus,
} from '@sublang/playbook/session-store';

void sessionStoreDefault;
interface ObservedRecord {
  readonly type: 'player_event';
  readonly event: { readonly text: string };
}
declare const observed: ObservedRecord;
declare const lease: PlaybookSessionLease;

const version: 1 = RECORDS_STREAM_VERSION;
const sessionsDir: string = defaultSessionsDir();
const store: PlaybookSessionStore = openSessionStore(sessionsDir);
const appendResult: Promise<void> = lease.append(observed, 'coder');
const options: ReplayStreamReadOptions = { afterSeq: undefined };
const status: ReplayStreamStatus = lease.streamStatus();

async function consume(): Promise<void> {
  const summary = await store.read(lease.sessionId);
  const schemaVersion: number = summary.schemaVersion;
  const sessionId: string = summary.sessionId;
  const state: 'settled' | 'uncertain' = summary.state;
  const cwd: string = summary.cwd;
  const updatedAt: string = summary.updatedAt;
  // @ts-expect-error the facade cannot expose the canonical snapshot
  summary.snapshot;
  // @ts-expect-error the facade cannot expose provider credentials
  summary.resumeToken;

  const followed = await store.readStream(sessionId, options);
  const readable: number = followed.lastReadableSeq;
  // @ts-expect-error a lease-free reader cannot claim durability
  followed.lastDurableSeq;
  // @ts-expect-error a lease-free reader cannot claim incompleteness
  followed.incomplete;

  const bound: LeaseReplayStreamReadResult = await lease.readStream();
  const durable: number = bound.lastDurableSeq;
  const incomplete: boolean = bound.incomplete;
  void [schemaVersion, state, cwd, updatedAt, readable, durable, incomplete];
}

// @ts-expect-error callers cannot supply an envelope sequence
lease.append(observed, 'coder', 2);
// @ts-expect-error primitive records are outside the declaration boundary
lease.append('player_event');
void [version, store, appendResult, status, consume];
`,
      );
      const program = ts.createProgram([fixture], {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
        typeRoots: [join(repoRoot, 'node_modules', '@types')],
      });
      expect(
        ts.getPreEmitDiagnostics(program).map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        ),
      ).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('publishes unresolved-effect as an exact state-only run result', () => {
    const runtimeDeclaration = declarationSourceOf('./runtime');
    const runResult = runtimeDeclaration.match(
      /export type PlaybookRunResult\s*=([\s\S]*?\n};)\n/,
    )?.[1];
    expect(runResult).toBeDefined();
    const unresolvedEffect = runResult!.match(
      /\{[^{}]*outcome:\s*'unresolved-effect';[^{}]*\}/,
    )?.[0];
    expect(unresolvedEffect?.replace(/\s+/g, '')).toBe(
      "{outcome:'unresolved-effect';state:PlaybookState;}",
    );
    expect(unresolvedEffect).not.toMatch(
      /stateDescription|output|pendingCall|error|effectLedger|receipt|unresolvedEffects|semanticCandidate/,
    );
  });

  it('publishes exact bounded unresolved-effect Captain settlements', () => {
    const declaration = declarationSourceOf('./playbook-captain');
    const evidence = declaration.match(
      /export interface PlaybookCaptainUnresolvedEffect\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(evidence).toBeDefined();
    expect(evidence!.replace(/\s+/g, '')).toBe(
      "readonlyclassification:'one-descendant-commit'|'multiple-commits'|'rewritten-or-non-descendant'|'worktree-only-change'|'concurrent-or-foreign-change'|'observation-ambiguous'|'incomplete';readonlybaselineHead:string;readonlyafterHead?:string;readonlycommitOid?:string;",
    );
    expect(evidence).not.toMatch(
      /path|projection|digest|boundary|operation|call|session|player|semantic|budget|prose/i,
    );

    const settlement = declaration.match(
      /export interface PlaybookCaptainSettlement\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(settlement).toBeDefined();
    expect(settlement).toMatch(
      /readonly unresolvedEffects:\s*readonly PlaybookCaptainUnresolvedEffect\[\];/,
    );
    expect(declaration).toMatch(
      /export declare function assertPlaybookCaptainUnresolvedEffects\(value: unknown[^)]*\): readonly PlaybookCaptainUnresolvedEffect\[\];/,
    );
  });

  it('declares validated Captain shell snapshots recursively readonly', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'playbook-snapshot-types-'));
    try {
      mkdirSync(join(scratch, 'node_modules', '@sublang'), { recursive: true });
      symlinkSync(
        repoRoot,
        join(scratch, 'node_modules', '@sublang', 'playbook'),
        'junction',
      );
      const fixture = join(scratch, 'consumer.ts');
      writeFileSync(
        fixture,
        `import type { PlaybookCaptainShellSnapshot } from '@sublang/playbook/playbook-captain';

declare const snapshot: PlaybookCaptainShellSnapshot;

// @ts-expect-error validated player tokens are frozen
snapshot.playerSessions['dev.worker']!.resumeToken = 'next';
// @ts-expect-error validated permission path arrays are frozen
snapshot.playerSessions['dev.worker']!.permissions!.writablePaths!.push('tmp');
// @ts-expect-error validated Captain runtime snapshots are frozen
snapshot.captain.runtime.schemaVersion = 3;
if (snapshot.mode === 'engaged.parked') {
  // @ts-expect-error validated frame runtime snapshots are frozen
  snapshot.frames[0]!.runtime.state.status = 'done';
}
`,
      );
      const program = ts.createProgram([fixture], {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['node'],
        typeRoots: [join(repoRoot, 'node_modules', '@types')],
      });
      expect(
        ts.getPreEmitDiagnostics(program).map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        ),
      ).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // Building and diagnosing the complete consumer program can exceed Vitest's
  // five-second default on Node 20 CI, so budget only this compiler-heavy case.
  it('discriminates schema-gated factory and registry construction types', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'playbook-schema-types-'));
    try {
      mkdirSync(join(scratch, 'node_modules', '@sublang'), { recursive: true });
      symlinkSync(
        repoRoot,
        join(scratch, 'node_modules', '@sublang', 'playbook'),
        'junction',
      );
      const fixture = join(scratch, 'consumer.ts');
      writeFileSync(
        fixture,
        `import {
  createXStatePlaybookRuntime,
  type XStatePlaybookRuntimeSpec,
  type XStatePlaybookRuntimeSpecV3,
  type XStateRepositoryCapability,
} from '@sublang/playbook/xstate-runtime';
import type {
  PlaybookCaptainRegistryEntryV3,
  PlaybookCaptainRuntimeProfile,
  PlaybookHostConstructionCapabilities,
} from '@sublang/playbook/playbook-captain';
import type {
  PlaybookEffectBoundaryStart,
  PlaybookEffectLedgerCapability,
  PlaybookPorts,
} from '@sublang/playbook/runtime';
import { codePlaybookRegistryEntry } from '@sublang/playbook/code/registry';
import type { CodePlaybookHostCapabilities } from '@sublang/playbook/code/playbook';
import { reviewPlaybookRegistryEntry } from '@sublang/playbook/review/registry';
import type { ReviewPlaybookHostCapabilities } from '@sublang/playbook/review/playbook';
import { decidePlaybookRegistryEntry } from '@sublang/playbook/decide/registry';
import type {
  DecidePlaybookHostCapabilities,
  DecidePlaybookRuntimeConstruction,
} from '@sublang/playbook/decide/playbook';
import { devPlaybookRegistryEntry } from '@sublang/playbook/dev/registry';
import type { DevPlaybookHostCapabilities } from '@sublang/playbook/dev/playbook';

interface Options { readonly mode: string }
interface Capabilities {
  readonly observe: () => string;
  readonly effectLedger: PlaybookEffectLedgerCapability;
}
declare const machine: any;
declare const boundaryStart: PlaybookEffectBoundaryStart;
declare const effectLedger: PlaybookEffectLedgerCapability;
declare const repository: XStateRepositoryCapability;
declare const canonicalSpec: XStatePlaybookRuntimeSpec<Options>;
declare const v3Spec: XStatePlaybookRuntimeSpecV3<Options>;

// @ts-expect-error a start command cannot carry completion evidence
boundaryStart.finalText;

type ExclusiveOperation = Parameters<XStateRepositoryCapability['runExclusive']>[0]['operation'];
const exclusiveOperation: ExclusiveOperation = async ({ baseline, identity }) => {
  const head: string = baseline.head;
  void head;
  void identity;
};
declare const resumeShapedOperation: (resume?: string | false) => Promise<void>;
// @ts-expect-error repository context cannot bind to a resume-token parameter
const invalidExclusiveOperation: ExclusiveOperation = resumeShapedOperation;
void exclusiveOperation;
void invalidExclusiveOperation;

const canonicalFactory = createXStatePlaybookRuntime<Options, Capabilities>(machine, canonicalSpec);
canonicalFactory({ configuredOptions: { mode: 'safe' }, hostCapabilities: { observe: () => 'head', repository, effectLedger } });
const canonicalFactorySchema: 3 = canonicalFactory.compat.artifactSchema;
// @ts-expect-error the schema-3-only factory rejects raw configured options
canonicalFactory({ mode: 'safe' });

const v3Factory = createXStatePlaybookRuntime<Options, Capabilities>(machine, v3Spec);
v3Factory({ configuredOptions: { mode: 'safe' }, hostCapabilities: { observe: () => 'head', repository, effectLedger } });
const v3FactorySchema: 3 = v3Factory.compat.artifactSchema;
// @ts-expect-error schema 3 requires the disjoint construction object
v3Factory({ mode: 'safe' });
// @ts-expect-error schema 3 requires repository serialization around governed calls
v3Factory({ configuredOptions: { mode: 'safe' }, hostCapabilities: { observe: () => 'head', effectLedger } });
// @ts-expect-error live host capabilities must use an object type
createXStatePlaybookRuntime<Options, number>(machine, v3Spec);

const inferredV3Factory = createXStatePlaybookRuntime(machine, v3Spec);
inferredV3Factory({ configuredOptions: { mode: 'safe' }, hostCapabilities: { repository, effectLedger } });
// @ts-expect-error inferred schema 3 still rejects raw configured options
inferredV3Factory({ mode: 'safe' });
// @ts-expect-error inferred schema 3 still requires an object capability
inferredV3Factory({ configuredOptions: { mode: 'safe' }, hostCapabilities: 1 });

// @ts-expect-error schema 3 requires outcome authority metadata
const wrongV3: XStatePlaybookRuntimeSpecV3<Options> = { snapshotOptions: () => ({ mode: 'safe' }), compat: { artifactSchema: 3, runtimeAbi: 1 } };
void wrongV3;

declare const configuredOptions: unknown;
declare const hostCapabilities: PlaybookHostConstructionCapabilities;
declare const codeHostCapabilities: CodePlaybookHostCapabilities;
declare const reviewHostCapabilities: ReviewPlaybookHostCapabilities;
declare const decideHostCapabilities: DecidePlaybookHostCapabilities;
declare const devHostCapabilities: DevPlaybookHostCapabilities;
declare const ports: PlaybookPorts;
declare const v3Entry: PlaybookCaptainRegistryEntryV3;
// @ts-expect-error live construction capabilities are not runtime ports
ports.hostCapabilities;
const v3Profile: PlaybookCaptainRuntimeProfile = v3Entry.runtimeProfile;
// @ts-expect-error schema 3 registry construction requires capabilities
v3Entry.createRuntime(configuredOptions);
v3Entry.createRuntime(configuredOptions, hostCapabilities);
const codeSchema: 3 = codePlaybookRegistryEntry.artifactSchema;
const codeProfile: PlaybookCaptainRuntimeProfile = codePlaybookRegistryEntry.runtimeProfile;
const codeEntry: PlaybookCaptainRegistryEntryV3 = codePlaybookRegistryEntry;
const codeCapabilities: PlaybookHostConstructionCapabilities = codeHostCapabilities;
codePlaybookRegistryEntry.createRuntime({}, codeHostCapabilities);
// @ts-expect-error CODE is schema 3 and requires current-host capabilities
codePlaybookRegistryEntry.createRuntime({});
const reviewSchema: 3 = reviewPlaybookRegistryEntry.artifactSchema;
const reviewProfile: PlaybookCaptainRuntimeProfile = reviewPlaybookRegistryEntry.runtimeProfile;
const reviewEntry: PlaybookCaptainRegistryEntryV3 = reviewPlaybookRegistryEntry;
const reviewCapabilities: PlaybookHostConstructionCapabilities = reviewHostCapabilities;
reviewPlaybookRegistryEntry.createRuntime({}, reviewHostCapabilities);
// @ts-expect-error REVIEW is schema 3 and requires current-host capabilities
reviewPlaybookRegistryEntry.createRuntime({});
const decideSchema: 3 = decidePlaybookRegistryEntry.artifactSchema;
const decideProfile: PlaybookCaptainRuntimeProfile = decidePlaybookRegistryEntry.runtimeProfile;
const decideEntry: PlaybookCaptainRegistryEntryV3 = decidePlaybookRegistryEntry;
const decideCapabilities: PlaybookHostConstructionCapabilities = decideHostCapabilities;
const decideConstruction: DecidePlaybookRuntimeConstruction = {
  configuredOptions: {},
  hostCapabilities: decideHostCapabilities,
};
decidePlaybookRegistryEntry.createRuntime(
  decideConstruction.configuredOptions,
  decideConstruction.hostCapabilities,
);
// @ts-expect-error DECIDE is schema 3 and requires current-host capabilities
decidePlaybookRegistryEntry.createRuntime({});
const devSchema: 3 = devPlaybookRegistryEntry.artifactSchema;
const devProfile: PlaybookCaptainRuntimeProfile = devPlaybookRegistryEntry.runtimeProfile;
const devEntry: PlaybookCaptainRegistryEntryV3 = devPlaybookRegistryEntry;
const devCapabilities: PlaybookHostConstructionCapabilities = devHostCapabilities;
devPlaybookRegistryEntry.createRuntime({}, devHostCapabilities);
// @ts-expect-error DEV is schema 3 and requires current-host capabilities
devPlaybookRegistryEntry.createRuntime({});
void canonicalFactorySchema;
void v3FactorySchema;
void v3Profile;
void codeSchema;
void codeProfile;
void codeEntry;
void codeCapabilities;
void reviewSchema;
void reviewProfile;
void reviewEntry;
void reviewCapabilities;
void decideSchema;
void decideProfile;
void decideEntry;
void decideCapabilities;
void decideConstruction;
void devSchema;
void devProfile;
void devEntry;
void devCapabilities;
`,
      );
      const program = ts.createProgram([fixture], {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['node'],
        typeRoots: [join(repoRoot, 'node_modules', '@types')],
      });
      expect(
        ts.getPreEmitDiagnostics(program).map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        ),
      ).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(BUNDLED_WORKFLOW_IDS)(
    '%s visibly re-exports PlayerSessionStore from the shared contract',
    (id) => {
      const dts = declarationSourceOf(`./${id}/playbook`);
      const imported = dts.match(
        /import type \{([\s\S]*?)\} from '@sublang\/playbook\/runtime';/,
      );
      const reexported = dts.match(/^export type \{([\s\S]*?)\};$/m);
      const names = (body: string | undefined): string[] =>
        (body ?? '')
          .split(',')
          .map((entry) => entry.trim().split(/\s+as\s+/).at(-1) ?? '')
          .filter((entry) => entry.length > 0);

      expect(names(imported?.[1]), `${id} shared-contract import`).toContain(
        'PlayerSessionStore',
      );
      expect(
        names(reexported?.[1]),
        `${id} shared-contract re-export`,
      ).toContain('PlayerSessionStore');
      expect(dts).not.toMatch(
        /^export\s+(?:interface|type)\s+PlayerSessionStore\b/m,
      );
    },
  );

  // The gate's own falsifiability (RELEASE-21). The regression it was added
  // for was a removed export that every check stayed green through, so the
  // extractor is checked against removals of each form it must catch — the
  // type-only ones especially, which the first version of this gate could not
  // see at all.
  const removeFromDeclaration = (
    dts: string,
    pattern: RegExp,
  ): string => dts.replace(pattern, '');

  it.each([
    [
      'an exported interface',
      'CaptainControllerPort',
      (dts: string) =>
        removeFromDeclaration(
          dts,
          /^export interface CaptainControllerPort \{[\s\S]*?^\}\n/m,
        ),
    ],
    [
      'an exported type alias',
      'CaptainControllerSelection',
      (dts: string) =>
        removeFromDeclaration(
          dts,
          /^export type CaptainControllerSelection =[\s\S]*?^\};\n/m,
        ),
    ],
    [
      'a name dropped from a type re-export list',
      'SettlementEvidence',
      // Only inside the `export type { … }` list: the same name also appears
      // on the `import` line above it, and dropping it there changes nothing
      // about the module's public surface.
      (dts: string) =>
        dts.replace(
          /^export type \{([\s\S]*?)\};$/gm,
          (_whole, body: string) =>
            `export type {${body.replace('SettlementEvidence, ', '')}};`,
        ),
    ],
    [
      'an exported declared value',
      'createPlaybookRuntime',
      (dts: string) =>
        removeFromDeclaration(
          dts,
          /^export declare function createPlaybookRuntime\(.*\n/m,
        ),
    ],
  ])('goes red when %s is removed', (_form, name, mutate) => {
    const dts = declarationSourceOf('./captain/playbook');
    const recorded = [
      ...PUBLIC_DECLARATION_EXPORTS['./captain/playbook']!,
    ].sort();
    expect(declaredExports(dts)).toEqual(recorded);
    const without = mutate(dts);
    expect(without, `the ${name} removal matched nothing`).not.toBe(dts);
    expect(declaredExports(without)).not.toContain(name);
    expect(declaredExports(without)).not.toEqual(recorded);
  });

  // RELEASE-21's wildcard clause, in both forms. A wildcard the resolver can
  // follow contributes its names, so growing one cannot enlarge a pinned
  // surface silently; one it cannot follow fails, so it cannot be used to slip
  // past the pin either.
  it.each(['export *', 'export type *'])(
    'refuses an unresolvable `%s` re-export in a pinned declaration file',
    (form) => {
      const scratch = mkdtempSync(join(tmpdir(), 'playbook-wildcard-'));
      try {
        const file = join(scratch, 'entry.d.ts');
        writeFileSync(file, `${form} from '@somewhere/else';\n`);
        expect(() =>
          resolveDeclarationExports(
            pathToFileURL(file),
            pathToFileURL(scratch),
          ),
        ).toThrow(/no single-file enumeration can resolve/);
        writeFileSync(file, `${form} from './missing.js';\n`);
        expect(() =>
          resolveDeclarationExports(
            pathToFileURL(file),
            pathToFileURL(scratch),
          ),
        ).toThrow(/declaration file is missing/);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['single-quoted value wildcard', "export * from './inner.js';"],
    ['single-quoted type wildcard', "export type * from './inner.js';"],
    ['double-quoted value wildcard', 'export * from "./inner.js";'],
    ['double-quoted type wildcard', 'export type * from "./inner.js";'],
    ['indented semicolonless value wildcard', "  export * from './inner.js'"],
    [
      'indented semicolonless type wildcard',
      "\texport type * from './inner.js'",
    ],
  ])('enumerates a resolvable %s rather than ignoring it', (_shape, source) => {
    const scratch = mkdtempSync(join(tmpdir(), 'playbook-wildcard-'));
    try {
      writeFileSync(
        join(scratch, 'inner.d.ts'),
        'export interface Hidden {\n    member: string;\n}\n',
      );
      const file = join(scratch, 'entry.d.ts');
      writeFileSync(file, `${source}\n`);
      expect(
        resolveDeclarationExports(
          pathToFileURL(file),
          pathToFileURL(scratch),
        ),
      ).toEqual(['Hidden']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a relative wildcard target that escapes the package root', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'playbook-wildcard-'));
    try {
      const packageRoot = join(scratch, 'package');
      mkdirSync(packageRoot);
      writeFileSync(
        join(scratch, 'outside.d.ts'),
        'export type Escaped = true;\n',
      );
      const file = join(packageRoot, 'entry.d.ts');
      writeFileSync(file, "export * from '../outside.js';\n");
      expect(() =>
        resolveDeclarationExports(
          pathToFileURL(file),
          pathToFileURL(packageRoot),
        ),
      ).toThrow(/target is outside the package root/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('packs the launcher and bundled registry artifacts, not retired surfaces', () => {
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
      `${CODE_BASE}bin/launch-config.js`,
      `${CODE_BASE}bin/run.js`,
      `${CODE_BASE}bin/interactive-session.js`,
      `${CODE_BASE}bin/replay-observer.js`,
      `${CODE_BASE}bin/session-store.js`,
      `${CODE_BASE}bin/provision.js`,
      `${CODE_BASE}bin/adapter-sdk.js`,
      `${CODE_BASE}bin/repository-effects.js`,
      `${CODE_BASE}session-store.js`,
      `${CODE_BASE}session-store.d.ts`,
      `${CODE_BASE}code.registry.js`,
      `${CODE_BASE}code.registry.d.ts`,
      `${REVIEW_BASE}review.playbook.js`,
      `${REVIEW_BASE}review.playbook.d.ts`,
      `${REVIEW_BASE}review.registry.js`,
      `${REVIEW_BASE}review.registry.d.ts`,
      `${DECIDE_BASE}decide.playbook.js`,
      `${DECIDE_BASE}decide.playbook.d.ts`,
      `${DECIDE_BASE}decide.registry.js`,
      `${DECIDE_BASE}decide.registry.d.ts`,
      `${DEV_BASE}dev.playbook.js`,
      `${DEV_BASE}dev.playbook.d.ts`,
      `${DEV_BASE}dev.registry.js`,
      `${DEV_BASE}dev.registry.d.ts`,
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
