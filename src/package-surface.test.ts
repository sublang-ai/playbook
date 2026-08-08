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
        defaultBuildCaptainJudgePrompt,
        normalizeError,
        normalizePlaybookSnapshot,
        snapshotJsonValue,
        snapshotPlaybookSession,
        validateCaptainResult,
        validatePlayerResult,
        waitForPlaybookQuiescence,
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
      if (!Number.isSafeInteger(RUNTIME_ABI)) {
        throw new Error('missing RUNTIME_ABI');
      }
      if (
        !Array.isArray(SUPPORTED_ARTIFACT_SCHEMAS) ||
        SUPPORTED_ARTIFACT_SCHEMAS.length === 0 ||
        !SUPPORTED_ARTIFACT_SCHEMAS.every(Number.isSafeInteger)
      ) {
        throw new Error('missing SUPPORTED_ARTIFACT_SCHEMAS');
      }
      // DR-029 §3 / PBRT-52: every runtime the shipped shared factory
      // constructs implements the optional control-surface pair together.
      const { createMachine } = await import('xstate');
      const probeRuntime = createXStatePlaybookRuntime(
        createMachine({ id: 'probe', initial: 'ready', states: { ready: {} } }),
        { label: 'probe', snapshotOptions: (value) => value ?? {} },
      )({});
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

  // RELEASE-20: the semver-stable unit of a public subpath is the module's
  // declared public API, not merely the `exports` entry. Pinning only the
  // entry is what let two named exports of `./captain/playbook` be removed
  // with every gate green and the question of whether that was breaking left
  // to be adjudicated after the fact. These sets are the recorded API: a
  // removal or rename goes red here and is decided as a release event before
  // the tag. `_internal` members are deliberately not pinned — the leading
  // underscore declares them subject to change.
  const PUBLIC_MODULE_EXPORTS: Record<string, readonly string[]> = {
    './captain/playbook': ['_internal', 'createPlaybookRuntime', 'default'],
    './code/registry': [
      'codeCopyPasteGuardNames',
      'codePlaybookRegistryEntry',
      'codeSavedCountsLine',
      'codeStateCountLabels',
      'codeSummaryPolicy',
      'createCodeRuntimeOptions',
      'default',
      'validateCodeOptions',
    ],
    './discuss/registry': [
      'createDiscussRuntimeOptions',
      'default',
      'discussPlaybookRegistryEntry',
      'discussSavedCountsLine',
      'discussSummaryPolicy',
      'validateDiscussOptions',
    ],
  };

  it.each(Object.entries(PUBLIC_MODULE_EXPORTS))(
    '%s declares exactly its recorded public exports',
    async (subpath, expected) => {
      const entry = manifest.exports[subpath] as {
        types: string;
        default: string;
      };
      const loaded = (await import(
        new URL(`../${entry.default}`, import.meta.url).href
      )) as Record<string, unknown>;
      expect(Object.keys(loaded).sort()).toEqual([...expected].sort());

      // The declaration file is the other half of the same public API: a
      // consumer who imports a name TypeScript declares breaks when it goes,
      // whether or not the JavaScript still carries it.
      const dts = readFileSync(
        new URL(`../${entry.types}`, import.meta.url),
        'utf8',
      );
      const declared = new Set<string>();
      for (const match of dts.matchAll(
        /^export\s+declare\s+(?:function|const|class|let|var)\s+(\w+)/gm,
      )) {
        declared.add(match[1]);
      }
      if (/^export default /m.test(dts)) declared.add('default');
      expect([...declared].sort()).toEqual([...expected].sort());
    },
  );

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
      `${CODE_BASE}bin/run.js`,
      `${CODE_BASE}bin/provision.js`,
      `${CODE_BASE}bin/adapter-sdk.js`,
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
