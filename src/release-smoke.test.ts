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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

import { _testing } from '../scripts/release-smoke.mjs';

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
