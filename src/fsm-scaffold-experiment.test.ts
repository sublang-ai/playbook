// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const builder = join(root, 'scripts/build-fsm-scaffold-experiment-13.2.mjs');
const compiler = process.env.PLAYBOOK_EXPERIMENT_COMPILER;
const read = (path: string) => readFileSync(path, 'utf8');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const run = (input: string, output: string) => execFileSync(process.execPath, [builder, input, output], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

it('describes an explicit two-arm assembly without a provider call', () => {
  expect(execFileSync(process.execPath, [builder, '--help'], { encoding: 'utf8' })).toContain('<frozen-compiler-root> <new-pair-root>');
  expect(() => execFileSync(process.execPath, [builder], { stdio: 'pipe' })).toThrow(/Usage:/);
});

describe.runIf(compiler !== undefined)('fixed-GEARS scaffold pair with the supplied real compiler', () => {
  it('isolates the appended guidance and preserves complete inventories through actual discovery and closure', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'fsm-scaffold-pair-test-'));
    try {
      const destination = join(scratch, 'pair');
      const before = hash(readFileSync(join(compiler!, 'package-lock.json')));
      const result = JSON.parse(run(compiler!, destination));
      expect(result.baseline).toBe(join(realpathSync(destination), 'baseline'));
      expect(result.scaffold).toBe(join(realpathSync(destination), 'scaffold'));
      const proof = JSON.parse(read(join(destination, 'experiment-proof.json')));
      expect(proof.schema).toBe('sublang.playbook.fsm-scaffold-experiment.v1');
      expect(proof.baselineConstruction.compilerRoot).toBe(compiler);
      expect(proof.baselineConstruction.publicCatalog.literalTargetBindings).toEqual({ review: 'review', decide: 'decide', code: 'code', branch: 'branch', pr: 'pr' });
      expect(existsSync(join(destination, 'construction'))).toBe(false);
      expect(Object.keys(proof.outputs.baseline).sort()).toEqual(Object.keys(proof.outputs.scaffold).sort());
      expect(Object.keys(proof.outputs.baseline).filter(name => proof.outputs.baseline[name].sha256 !== proof.outputs.scaffold[name].sha256)).toEqual(['playbook/gears2fsm.md']);
      const discovery = await import(pathToFileURL(join(compiler!, 'dist/pipeline.js')).href);
      const closureApi = await import(pathToFileURL(join(compiler!, 'dist/pin-closure.js')).href);
      const markdown = await import(pathToFileURL(join(root, 'scripts/check-links.mjs')).href);
      const guidance = read(join(root, 'slc/experiments/fsm-scaffold-guidance.md'));
      const appendix = '\n' + guidance.replace('[scaffold-fsm.mjs](../scaffold-fsm.mjs)', '[scaffold-fsm.mjs](scaffold-fsm.mjs)');
      expect(proof.appendedGuidance.sha256).toBe(hash(appendix));
      expect(read(join(destination, 'scaffold/playbook/gears2fsm.md'))).toBe(read(join(destination, 'baseline/playbook/gears2fsm.md')) + appendix);
      for (const arm of ['baseline', 'scaffold']) {
        const pipeline = join(destination, arm, 'playbook');
        const loaded = await discovery.loadPipeline(pipeline);
        expect(loaded.phases.map((phase: { name: string }) => phase.name)).toEqual(['text2gears', 'gears2fsm']);
        expect(loaded.passes.map((phase: { name: string }) => phase.name)).toEqual(['optimize']);
        expect(loaded.linkFile).toBe(join(pipeline, 'link.md'));
        expect(read(join(pipeline, 'experiments/fsm-scaffold-guidance.md'))).toBe(guidance);
        expect(hash(readFileSync(join(pipeline, 'scaffold-fsm.mjs')))).toBe(proof.initializer.sha256);
        const sidecar = JSON.parse(read(join(pipeline, 'slc.pin-inputs.json')));
        for (const [name, record] of Object.entries(proof.outputs[arm]) as [string, { sha256: string; bytes: number }][]) {
          const bytes = readFileSync(join(destination, arm, name));
          expect(hash(bytes), name).toBe(record.sha256);
          expect(bytes.length, name).toBe(record.bytes);
          expect(name).not.toMatch(/reference\/|\.fsm\.(ts|js)|\.playbook\.(ts|js)|slc\.pins\.json/);
        }
        for (const phase of ['text2gears', 'gears2fsm', 'optimize', 'link']) {
          const closure: Set<string> = await closureApi.deriveClosure(pipeline, '.', `${phase}.md`, phase);
          expect([...closure].sort()).toEqual([join(pipeline, `${phase}.md`), ...sidecar.closures[phase].map((path: string) => join(pipeline, path))].sort());
          for (const local of ['workflow-contracts.json', 'scaffold-fsm.mjs', 'experiments/fsm-scaffold-guidance.md']) expect(closure.has(join(pipeline, local))).toBe(true);
          for (const { target } of markdown.linksOf(read(join(pipeline, `${phase}.md`)))) {
            const local = /^(text2gears\.md|gears2fsm\.md|optimize\.md|link\.md|workflow-contracts\.json|scaffold-fsm\.mjs)(?:#|$)/.exec(target);
            if (local) expect(closure.has(join(pipeline, local[1]))).toBe(true);
          }
        }
      }
      for (const [name, record] of Object.entries(proof.baselineConstruction.compilerInventory) as [string, { sha256: string }][]) expect(hash(readFileSync(join(compiler!, name)))).toBe(record.sha256);
      expect(hash(readFileSync(join(compiler!, 'package-lock.json')))).toBe(before);
      const saved = read(join(destination, 'experiment-proof.json'));
      expect(() => run(compiler!, destination)).toThrow(/Output already exists/);
      expect(read(join(destination, 'experiment-proof.json'))).toBe(saved);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses outputs inside the frozen compiler or builder checkout', () => {
    for (const target of [join(compiler!, 'refused-scaffold-pair'), join(root, 'refused-scaffold-pair')]) {
      expect(() => run(compiler!, target)).toThrow(/Output must be outside/);
      expect(existsSync(target)).toBe(false);
    }
  });
});
