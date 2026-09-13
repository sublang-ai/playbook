#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Optional cross-package integration check: pass an installed/built SLC root.
// Real discovery, closure, hashing, and build-history selection run unchanged;
// only the model-backed file transformation is a deterministic fixture.
// The fixture reuses the maintained Captain's GEARS/FSM/runtime, rebases its
// imports, and explicitly declares its empty cohort list. Current SLC's real
// source, FSM, and linked-module gates all remain enabled.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const slcRoot = process.argv[2];
if (!slcRoot) throw new Error('Usage: node scripts/check-slc-definition-closure.mjs <built-slc-root> [definition-dir]');
const loadSlc = (file) => import(pathToFileURL(join(resolve(slcRoot), 'dist', file)).href);
const { loadPipeline } = await loadSlc('pipeline.js');
const { deriveClosure } = await loadSlc('pin-closure.js');
const { runSlc } = await loadSlc('runner.js');
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const definitionRoot = process.argv[3] ? resolve(process.argv[3]) : join(packageRoot, 'slc');
const scratch = await mkdtemp(join(tmpdir(), 'playbook-slc-closure-'));
const pipelineDir = join(scratch, 'pipeline');
const source = join(scratch, 'case.text.md');
const contract = join(scratch, 'fixture-contract.ts');
const fixtureDir = join(packageRoot, 'reference/sdlc/captain.playbook');
const sourceText = await readFile(join(fixtureDir, 'captain.gears.md'), 'utf8');
const fsmText = `${await readFile(join(fixtureDir, 'captain.fsm.ts'), 'utf8')}\nexport const concurrentRoleSets: readonly (readonly string[])[] = [];\n`;
const linkedText = (await readFile(join(fixtureDir, 'captain.playbook.ts'), 'utf8'))
  .replaceAll('./captain.fsm.js', './case.fsm.ts')
  .replaceAll('../../../src/xstate-runtime.js', '@sublang/playbook/xstate-runtime');
try {
  await cp(definitionRoot, pipelineDir, { recursive: true });
  await mkdir(join(scratch, 'node_modules/@sublang'), { recursive: true });
  await symlink(packageRoot, join(scratch, 'node_modules/@sublang/playbook'), 'dir');
  await symlink(join(packageRoot, 'node_modules/xstate'), join(scratch, 'node_modules/xstate'), 'dir');
  const pipeline = await loadPipeline(pipelineDir);
  assert.deepEqual(pipeline.phases.map((phase) => phase.name), ['text2gears', 'gears2fsm']);
  assert.deepEqual(pipeline.passes.map((phase) => phase.name), ['optimize']);
  assert.equal(pipeline.linkFile, join(pipelineDir, 'link.md'));
  const helper = join(pipelineDir, 'materialize-link.mjs');
  const companion = join(pipelineDir, 'references/link-contract.md');
  const hasCompanion = existsSync(companion);
  for (const phase of ['link']) {
    const closure = await deriveClosure(pipelineDir, '.', `${phase}.md`, phase);
    assert(closure.has(helper), `${phase} must include the helper`);
    if (hasCompanion) assert(closure.has(companion), `${phase} must include the full contract`);
  }
  await writeFile(source, sourceText);
  await writeFile(contract, 'export {};\n');
  const run = async () => {
    const calls = [];
    const result = await runSlc(['probe', source, '--link', contract], {
      resolver: (name) => name === 'probe' ? [pipelineDir] : [],
      cwd: scratch,
      executor: {
        async run(request) {
          calls.push(basename(request.definitionPath));
          if (request.kind === 'link') {
            await writeFile(request.linked, linkedText);
            return { status: 'ok', diagnostics: [] };
          }
          await writeFile(request.target, request.target.endsWith('.ts')
            ? fsmText
            : sourceText);
          return { status: 'ok', diagnostics: [] };
        },
      },
    });
    assert.equal(result.ok, true, result.diagnostics.join('\n'));
    return { result, calls };
  };
  const first = await run();
  assert.deepEqual(first.calls, ['text2gears.md', 'optimize.md', 'gears2fsm.md', 'link.md']);
  const second = await run();
  assert.equal(second.result.outcome, 'up-to-date');
  assert.deepEqual(second.calls, []);
  await writeFile(helper, `${await readFile(helper, 'utf8')}\n// semantic-input mutation probe\n`);
  const third = await run();
  assert.notEqual(third.result.outcome, 'up-to-date');
  assert.deepEqual(third.calls, ['link.md'], 'helper changes must invalidate only link reuse');
  let changedContractCalls = null;
  if (hasCompanion) {
    const fourth = await run();
    assert.equal(fourth.result.outcome, 'up-to-date');
    assert.deepEqual(fourth.calls, []);
    await writeFile(companion, `${await readFile(companion, 'utf8')}\n<!-- semantic-input mutation probe -->\n`);
    const fifth = await run();
    assert.deepEqual(fifth.calls, ['link.md'], 'contract changes must invalidate only link reuse');
    changedContractCalls = fifth.calls;
  }
  process.stdout.write(JSON.stringify({
    discovery: 'two phases, one pass, one link; helper and companion excluded',
    closure: hasCompanion ? 'link declaration includes helper and full contract' : 'link declaration includes helper',
    firstCalls: first.calls,
    unchangedCalls: second.calls,
    changedHelperCalls: third.calls,
    changedContractCalls,
  }, null, 2) + '\n');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
