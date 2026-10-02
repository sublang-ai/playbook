// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

import { _testing } from '../scripts/release-smoke.mjs';
import { createSessionStore } from '@sublang/playbook/session-store';
import { executionConfigFromPlan, loadLaunchPlan, openSessionHost } from '@sublang/playbook/session-host';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const calls = [
  ['first', 'closing', null, null, 'release-smoke-captain-a', 'low', false],
  [
    'continued',
    'selection',
    null,
    'release-smoke:closing:first:1',
    'release-smoke-captain-a',
    'low',
    false,
  ],
  ['lane-a', 'player', 'first', null, 'release-player-a', 'high', true],
  [
    'lane-a',
    'player',
    'second',
    'release-lane:shared:1',
    'release-second-a',
    'low',
    false,
  ],
  ['lane-a', 'player', 'isolated', null, 'release-player-a', 'high', null],
  [
    'lane-a',
    'closing',
    null,
    'release-smoke:selection:continued:1',
    'release-smoke-captain-a',
    'low',
    false,
  ],
  [
    'lane-b',
    'player',
    'second',
    'release-lane:shared:2',
    null,
    null,
    true,
  ],
  [
    'lane-b',
    'player',
    'first',
    'release-lane:shared:3',
    'release-player-b',
    'max',
    false,
  ],
  [
    'lane-b',
    'player',
    'isolated',
    'release-lane:isolated:1',
    'release-player-b',
    'max',
    true,
  ],
  [
    'lane-b',
    'closing',
    null,
    'release-smoke:closing:lane-a:4',
    'release-smoke-captain-b',
    'max',
    true,
  ],
].map(([process, kind, role, resume, model, effort, fastMode]) => ({
  process,
  kind,
  role,
  resume,
  model,
  effort,
  fastMode,
}));

const sessionStoreConsumerFixture = {
  sessionsDir: '/tmp/packed-session-store-consumer/sessions',
  sessionId: '11111111-1111-4111-8111-111111111111',
  oldSessionId: '22222222-2222-4222-8222-222222222222',
  expectedSummary: {
    schemaVersion: 6,
    sessionId: '11111111-1111-4111-8111-111111111111',
    state: 'settled',
    cwd: '/tmp/packed-session-store-consumer/repository',
    updatedAt: '2026-08-31T12:34:56.789Z',
  },
  credentials: ['captain-resume-token', 'player-resume-token'],
};

describe('deterministic packed release lane smoke', () => {
  it('records forbidden effect calls before the fixture rejects them', () => {
    const source = _testing.installedEffectReconciliationDriverSource();
    const playerRecordAt = source.indexOf(
      "const resumeToken = recordCall('player'",
    );
    const playerRejectionAt = source.indexOf(
      'an unresolved-effect control replayed the player',
    );
    const judgeRecordAt = source.indexOf(
      'recordedResumeToken = recordCall(kind',
    );
    const judgeRejectionAt = source.indexOf(
      'an unresolved-effect control started a judge',
    );

    expect(playerRecordAt).toBeGreaterThan(-1);
    expect(playerRecordAt).toBeLessThan(playerRejectionAt);
    expect(judgeRecordAt).toBeGreaterThan(-1);
    expect(judgeRecordAt).toBeLessThan(judgeRejectionAt);
  });

  it('constructs bundled runtimes with their current declared options', () => {
    const source = _testing.compiledRuntimeImportProbeSource();

    expect(source).toContain(
      "runtime: codeFactory(construction('code', ['coder'], []))",
    );
    expect(source).toContain(
      "runtime: reviewFactory(construction('review', ['coder', 'reviewer'], []))",
    );
    expect(source).toContain(
      "construction('decide', ['coder', 'reviewer'], [['coder', 'reviewer']])",
    );
    expect(source).toContain(
      "runtime: devFactory(construction('dev', ['analyst'], []))",
    );
    expect(source).toContain(
      "runtime: branchFactory(construction('branch', ['coder'], []))",
    );
    expect(source).toContain(
      "runtime: prFactory(construction('pr', ['coder'], []))",
    );
    expect(source).toContain(
      "runtime: inspectFactory(construction('inspect', ['inspector'], []))",
    );
    expect(source).toContain('artifactSchema: 3');
    expect(source).toContain('emptyPlaybookEffectLedger');
    expect(source).toContain("const adoptionMembers = ['adopt']");
    expect(source).toContain('absentMembers: adoptionMembers');
    expect(source).not.toContain('coderLlm');
    expect(source).not.toContain('reviewerLlm');
  });

  it('keeps the packed session-store consumer on the public facade', () => {
    const source = _testing.sessionStoreConsumerSource(
      sessionStoreConsumerFixture,
    );
    const importSpecifiers = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]);

    expect(importSpecifiers).toEqual(['@sublang/playbook/session-store']);
    expect(source).not.toMatch(/(?:bin\/session-store|reference\/sdlc|src\/)/);

    expect(source).toContain(
      "['cwd', 'schemaVersion', 'sessionId', 'state', 'updatedAt']",
    );
    for (const value of [
      sessionStoreConsumerFixture.sessionsDir,
      sessionStoreConsumerFixture.sessionId,
      sessionStoreConsumerFixture.oldSessionId,
      sessionStoreConsumerFixture.expectedSummary.cwd,
      sessionStoreConsumerFixture.expectedSummary.updatedAt,
      ...sessionStoreConsumerFixture.credentials,
    ]) {
      expect(source).toContain(JSON.stringify(value));
    }

    expect(source).toContain('lastReadableSeq');
    expect(source).toContain('lastDurableSeq');
    expect(source).toContain('incomplete');
    expect(source).toContain(
      "sameJson(listedSummary, expectedSummary, 'listed summary')",
    );
    expect(source).toContain(
      "sameJson(direct, expectedSummary, 'direct summary')",
    );
    expect(source).toContain(
      "'CLI-written replay exposed a resume credential'",
    );
    expect(source).toContain(
      "!hasOwnKey(baselineRead, 'resumeToken')",
    );
    expect(source).toContain(
      "!hasStringOwnValue(baselineRead, 'resume')",
    );
    expect(source).toMatch(
      /const followed = await follower\.readStream\(sessionId, \{ afterSeq: baseline \}\)/,
    );
    expect(source).toContain("'readable-ahead-of-durable status'");
    expect(source).toContain("'equalized release status'");
    expect(source).toMatch(/@ts-expect-error[^\n]*durab/i);
    expect(source).toMatch(/@ts-expect-error[^\n]*incomplete/i);
    expect(source).toMatch(/old[- ]schema[^\n]*(?:reject|migrat)/i);
    expect(source).toContain('await store.read(oldSessionId)');
    expect(source).toContain(
      "check(oldSchemaRejected, 'schema-5 record was not rejected')",
    );

    const typedRecord =
      /const\s+(\w+)\s*:\s*(\w*Record)\s*=/.exec(source);
    expect(typedRecord).not.toBeNull();
    expect(source).toMatch(
      new RegExp(`interface\\s+${typedRecord![2]}\\b`),
    );
    expect(source).toMatch(
      new RegExp(`\\.append\\(\\s*${typedRecord![1]}\\s*,`),
    );
  });

  it('configures the packed session-store consumer for strict emit', () => {
    const tsconfig = _testing.sessionStoreConsumerTsconfig();

    expect(tsconfig.compilerOptions).toMatchObject({
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      skipLibCheck: false,
      types: [],
      noEmitOnError: true,
      outDir: 'dist',
    });
    expect(tsconfig.compilerOptions.noEmit).not.toBe(true);
    expect(tsconfig.compilerOptions.emitDeclarationOnly).not.toBe(true);
    expect(tsconfig.files).toEqual(['consumer.ts']);
  });

  it('keeps packed asset ownership checks on the public facades', () => {
    const source = _testing.sessionAssetsConsumerSource({
      sessionsDir: sessionStoreConsumerFixture.sessionsDir,
      sessionId: sessionStoreConsumerFixture.sessionId,
      assetRoot: '/tmp/packed-session-store-consumer/owned-assets',
    });
    const packageImports = [...source.matchAll(/\bfrom\s+['"](@sublang\/[^'"]+)['"]/g)]
      .map((match) => match[1]);
    expect(packageImports).toEqual([
      '@sublang/playbook/session-assets',
      '@sublang/playbook/session-store',
    ]);
    expect(source).not.toMatch(/(?:bin\/session-store|reference\/sdlc|src\/)/);
    for (const operation of ['source.importAsset', 'source.resolveAttachment', 'copied.copyAsset',
      'copied.prepare', 'copied.openAsset', 'lease.resolveAttachments', 'store.exportBundle',
      'reopened.readAsset']) expect(source).toContain(operation);
  });

  it('executes the asset consumer against a real durable session without provider calls', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'playbook-packed-assets-'));
    const cwd = join(scratch, 'repo');
    let host: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
      mkdirSync(cwd);
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'baseline'], { cwd });
      mkdirSync(join(scratch, 'node_modules', '@sublang'), { recursive: true });
      symlinkSync(repoRoot, join(scratch, 'node_modules', '@sublang', 'playbook'), 'junction');
      const configPath = join(scratch, 'config.yaml');
      writeFileSync(configPath, 'captain: { adapter: claude, model: unused }\nplayers:\n  inspector: { adapter: claude, model: unused }\nplaybooks:\n  inspect: { from: "@sublang/playbook/inspect/registry", roles: { inspector: inspector } }\n');
      const config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath }));
      const sessionsDir = join(scratch, 'sessions');
      const store = createSessionStore({ sessionsDir });
      class NoProvider {
        readonly agent = 'claude-code' as const;
        async *run(): AsyncGenerator<never> { throw new Error('asset smoke must make no provider call'); }
      }
      host = await openSessionHost({ store, cwd, config, mode: 'new', adapterImports: { claude: async () => NoProvider } as never });
      const initial = await host.lease.importAsset({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/octet-stream' });
      await host.handleBossTurn({ text: '', attachments: [initial] });
      const sessionId = host.sessionId;
      await host.dispose(); host = undefined;
      const source = join(scratch, 'consumer.mjs');
      writeFileSync(source, _testing.sessionAssetsConsumerSource({ sessionsDir, sessionId, assetRoot: join(scratch, 'owned-assets') }));
      execFileSync(process.execPath, [source], { cwd: scratch, timeout: 30_000, stdio: 'pipe' });
    } finally {
      await host?.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it(
    'strictly compiles and emits the packed session-store consumer',
    () => {
      const scratch = mkdtempSync(join(tmpdir(), 'playbook-release-consumer-'));
      try {
        mkdirSync(join(scratch, 'node_modules', '@sublang'), {
          recursive: true,
        });
        symlinkSync(
          repoRoot,
          join(scratch, 'node_modules', '@sublang', 'playbook'),
          'junction',
        );
        writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n');
        writeFileSync(
          join(scratch, 'consumer.ts'),
          _testing.sessionStoreConsumerSource(sessionStoreConsumerFixture),
        );

        const configPath = join(scratch, 'tsconfig.json');
        const parsed = ts.parseJsonConfigFileContent(
          _testing.sessionStoreConsumerTsconfig(),
          ts.sys,
          scratch,
          undefined,
          configPath,
        );
        const program = ts.createProgram(parsed.fileNames, parsed.options);
        const emit = program.emit();
        const diagnostics = [
          ...parsed.errors,
          ...ts.getPreEmitDiagnostics(program),
          ...emit.diagnostics,
        ].map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        );

        expect(diagnostics).toEqual([]);
        expect(emit.emitSkipped).toBe(false);
        expect(existsSync(join(scratch, 'dist', 'consumer.js'))).toBe(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    30_000,
  );

  const hostCapabilitiesConsumerFixture = {
    repo: '/tmp/playbook-release-smoke/host-capabilities-worktree',
    baselineHead: 'a'.repeat(40),
  };

  it('keeps the packed host-capabilities consumer on the public facade', () => {
    const source = _testing.hostCapabilitiesConsumerSource(
      hostCapabilitiesConsumerFixture,
    );
    const importSpecifiers = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]);

    expect(importSpecifiers.filter((name) => !name.startsWith('node:'))).toEqual(
      ['@sublang/playbook/host-capabilities'],
    );
    expect(source).not.toMatch(/(?:bin\/repository-effects|reference\/sdlc|src\/)/);
    for (const value of [
      hostCapabilitiesConsumerFixture.repo,
      hostCapabilitiesConsumerFixture.baselineHead,
    ]) {
      expect(source).toContain(JSON.stringify(value));
    }
    expect(source).toContain(
      "['identity', 'observe', 'acquire', 'runExclusive', 'runDeferred']",
    );
    expect(source).toContain("['snapshot', 'writeAhead']");
    expect(source).toContain("kind: 'replace-boundaries'");
    expect(source).toContain("correctionBudget: { limit: 1, spent: true }");
    expect(source).toContain(
      "committed.receipt.classification === 'one-descendant-commit'",
    );
    expect(source).toContain("idle.receipt.classification === 'unchanged'");
    expect(source).toContain('createFailClosedHostCapabilities()');
    expect(source).toContain("'the worktree claim was not released'");
    expect(source).toMatch(/@ts-expect-error[^\n]*lease/i);
    expect(source).toMatch(/@ts-expect-error[^\n]*cohort/i);
  });

  it('configures the packed host-capabilities consumer for strict emit', () => {
    const tsconfig = _testing.hostCapabilitiesConsumerTsconfig();

    expect(tsconfig.compilerOptions).toMatchObject({
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      skipLibCheck: false,
      types: ['node'],
      noEmitOnError: true,
      outDir: 'dist',
    });
    expect(tsconfig.compilerOptions.noEmit).not.toBe(true);
    expect(tsconfig.compilerOptions.emitDeclarationOnly).not.toBe(true);
    expect(tsconfig.files).toEqual(['consumer.ts']);
  });

  it(
    'strictly compiles and emits the packed host-capabilities consumer',
    () => {
      const scratch = mkdtempSync(join(tmpdir(), 'playbook-release-consumer-'));
      try {
        mkdirSync(join(scratch, 'node_modules', '@sublang'), {
          recursive: true,
        });
        symlinkSync(
          repoRoot,
          join(scratch, 'node_modules', '@sublang', 'playbook'),
          'junction',
        );
        writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n');
        writeFileSync(
          join(scratch, 'consumer.ts'),
          _testing.hostCapabilitiesConsumerSource(
            hostCapabilitiesConsumerFixture,
          ),
        );

        const configPath = join(scratch, 'tsconfig.json');
        const parsed = ts.parseJsonConfigFileContent(
          _testing.hostCapabilitiesConsumerTsconfig(),
          ts.sys,
          scratch,
          undefined,
          configPath,
        );
        const program = ts.createProgram(parsed.fileNames, parsed.options);
        const emit = program.emit();
        const diagnostics = [
          ...parsed.errors,
          ...ts.getPreEmitDiagnostics(program),
          ...emit.diagnostics,
        ].map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        );

        expect(diagnostics).toEqual([]);
        expect(emit.emitSkipped).toBe(false);
        expect(existsSync(join(scratch, 'dist', 'consumer.js'))).toBe(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('keeps distinct segmented ids equal-configured and retunes both', () => {
    const primary = parseYaml(_testing.smokeConfig('a'));
    const overlay = parseYaml(_testing.smokeRetuneOverlay());

    expect(primary.players['release.shared']).toEqual(
      primary.players['release.isolated'],
    );
    expect(primary.captain).toMatchObject({
      model: 'release-smoke-captain-a',
      effort: 'low',
      fastMode: false,
    });
    expect(primary.players['release.shared']).toMatchObject({
      model: 'release-player-a',
      effort: 'high',
    });
    expect(primary.playbooks.lanes.roles.first).toEqual({
      player: 'release.shared',
      fastMode: true,
    });
    expect(primary.playbooks.lanes.roles.isolated).toBe('release.isolated');
    expect(overlay.players['release.shared']).toEqual(
      overlay.players['release.isolated'],
    );
    expect(overlay.captain).toMatchObject({
      model: 'release-smoke-captain-b',
      effort: 'max',
      fastMode: true,
    });
    expect(overlay.players['release.shared']).toMatchObject({
      model: 'release-player-b',
      effort: 'max',
      fastMode: false,
    });
    expect(primary.playbooks.lanes.roles.second).toMatchObject({
      player: 'release.shared',
      model: 'release-second-a',
      effort: 'low',
      fastMode: false,
    });
    expect(overlay.playbooks.lanes.roles.second).toMatchObject({
      player: 'release.shared',
      model: false,
      effort: false,
      fastMode: true,
    });
    expect(overlay.playbooks.lanes.roles.first).toEqual({
      player: 'release.shared',
      fastMode: false,
    });
    expect(overlay.playbooks.lanes.roles.isolated).toEqual({
      player: 'release.isolated',
      fastMode: true,
    });
  });

  it('packs both unsupported fast-mode literals behind every external hook', () => {
    for (const fastMode of [false, true]) {
      const config = parseYaml(_testing.unsupportedFastModeConfig(fastMode));
      expect(config.playbooks.unsupported.roles.worker).toEqual({
        player: 'release.unsupported',
        fastMode,
      });
      expect(config.players['release.unsupported'].adapter).toBe(
        _testing.unsupportedFastModeAdapterMarker,
      );
    }

    const source = _testing.installedFastModeBoundaryDriverSource();
    for (const hook of [
      'prepareRegistryModule',
      'loadModule',
      'probeAdapterSdk',
      'createCaptainRuntime',
      'createHostRuntime',
      'session-store',
    ]) {
      expect(source).toContain(hook);
    }
    expect(source).toContain('hooks.length !== 0');
    expect(source).toContain("from '@sublang/cligent'");
    expect(source).toContain('FAST_MODE_SUPPORT');
    expect(source).toContain('capability.requestSupported === false');
    expect(source).toContain('replaceAll(adapterMarker, unsupportedAdapter)');
    expect(source).not.toContain('gemini');
  });

  it('pins both shared-role directions, isolated tokens, and current tuning', () => {
    expect(() => _testing.assertSmokeCalls(calls)).not.toThrow();

    for (const index of [3, 6, 7, 8]) {
      const mutated = structuredClone(calls);
      mutated[index]!.resume = 'mutated-token';
      expect(() => _testing.assertSmokeCalls(mutated)).toThrow(
        /shared\/isolated tokens and tuning/,
      );
    }
    for (const index of [3, 6, 7, 8, 9]) {
      const mutated = structuredClone(calls);
      mutated[index]!.model = 'mutated-model';
      expect(() => _testing.assertSmokeCalls(mutated)).toThrow(
        /shared\/isolated tokens and tuning/,
      );
    }
    for (const index of [0, 2, 3, 4, 6, 7, 8, 9]) {
      const mutated = structuredClone(calls);
      mutated[index]!.fastMode = 'mutated-fast-mode';
      expect(() => _testing.assertSmokeCalls(mutated)).toThrow(
        /shared\/isolated tokens and tuning/,
      );
    }
  });
});
