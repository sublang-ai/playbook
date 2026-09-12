// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, cpSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { anchorsOf, linksOf } from '../scripts/check-links.mjs';
import { rebaseContract } from '../scripts/compact-link-definition.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

it('ships the compact recipe with the exact helper and reversibly relocated complete contract', () => {
  const cache = mkdtempSync(join(tmpdir(), 'playbook-compact-pack-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache },
      stdio: ['ignore', 'pipe', 'ignore'],
    }))[0].files.map((file: { path: string }) => file.path);
    for (const file of ['slc/link.md', 'slc/materialize-link.mjs', 'slc/references/link-contract.md', 'slc/slc.pin-inputs.json']) {
      expect(packed).toContain(file);
    }
    const recipe = read('slc/link.md');
    const full = read('slc/references/link-contract.md');
    // The helper stays at v2; the full contract adds only the canonical mapper correction.
    expect(sha(read('slc/materialize-link.mjs'))).toBe('fe7336bc4c1511c4170ac3cdaeda4ffc30f3848b40ae7301f6660c20067e58e0');
    expect(sha(rebaseContract(full, true))).toBe('55456b21dab8484f03a868f3816d3d05a0fbc4e626ea86be10e93861529239cf');
    const previousClause = 'whose optional live completion mapper may return only detached `finalText`, `semanticCandidate`, `logicalOperationId`, and additional typed ledger commands for the same atomic completion;';
    const currentClause = 'whose optional live completion mapper may return only detached `finalText`, `semanticCandidate`, `logicalOperationId`, additional typed ledger commands for the same atomic completion, one `deferred` binding carrying optional UUID `operationId` plus exact `pendingQuestion` and `playerContinuation`, or literal `unresolved: true`, where `deferred` shall be mutually exclusive with `unresolved`, `logicalOperationId`, and commands;';
    expect(sha(rebaseContract(full, true).replace(currentClause, previousClause))).toBe('75e2e6e51a49a8621dd713d4d081db001a6256b28fc565a2ca192471ad084043');
    const entryAnchors = anchorsOf(recipe);
    for (const anchor of anchorsOf(full)) expect(entryAnchors.has(anchor), anchor).toBe(true);
    for (const { target } of linksOf(recipe).filter(({ target }: { target: string }) => target.startsWith('references/link-contract.md#'))) {
      expect(anchorsOf(full).has(target.split('#')[1]), target).toBe(true);
    }
    for (const member of ['schema', 'profile', 'machineExport', 'label', 'options', 'inputMapping', 'entryEvent', 'bossEvents', 'outcomeAuthority', 'placeholderFields', 'transitionEventFields', 'verbatimPayloadFields', 'resumableStateIds', 'unfinishedFinalStateIds', 'controlContextFields']) {
      expect(recipe).toContain(`\`${member}\``);
    }
    expect(recipe).toContain('Existing compiler source/FSM/link conformance checks remain mandatory');
    expect(recipe).toContain('parallel/compound states');
    expect(recipe).toContain('custom classification/composition/extraction/status requirements');
    expect(recipe).toContain('does not mean `unchanged`');
    expect(Buffer.byteLength(recipe)).toBeLessThan(16_000);
    const closure = JSON.parse(read('slc/slc.pin-inputs.json')).closures.link;
    expect(closure).toContain('materialize-link.mjs');
    expect(closure).toContain('references/link-contract.md');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}, 120_000);

// Optional exact-version experiment acceptance: supply the actual installed
// package, not a fabricated baseline or a runtime/dependency adoption.
const baselinePackage = process.env.PLAYBOOK_MATERIALIZATION_BASELINE;
it.runIf(baselinePackage !== undefined)('reconstructs the reviewed 12.3 candidate and refuses modified baselines or existing output', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'playbook-compact-builder-'));
  const installed = baselinePackage!;
  const builder = join(root, 'scripts/build-link-experiment-12.3.mjs');
  const run = (source: string, output: string, mode?: '--full') => execFileSync(process.execPath, [builder, source, output, ...(mode ? [mode] : [])], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const original = readFileSync(join(installed, 'slc/link.md'), 'utf8');
    const target = join(scratch, 'candidate');
    run(installed, target);
    expect(readFileSync(join(target, 'link.md'), 'utf8')).toBe(read('slc/link.md'));
    expect(readFileSync(join(target, 'optimize.md'), 'utf8')).toBe(read('slc/optimize.md'));
    expect(readFileSync(join(target, 'gears2fsm.md'), 'utf8')).toBe(read('slc/gears2fsm.md'));
    expect(readFileSync(join(target, 'materialize-link.mjs'), 'utf8')).toBe(read('slc/materialize-link.mjs'));
    const proof = readFileSync(join(target, 'experiment-proof.json'), 'utf8');
    const record = JSON.parse(proof);
    const fullTarget = join(scratch, 'full-candidate');
    run(installed, fullTarget, '--full');
    expect(readFileSync(join(fullTarget, 'link.md'), 'utf8')).toBe(rebaseContract(readFileSync(join(target, 'references/link-contract.md'), 'utf8'), true));
    const fullProof = JSON.parse(readFileSync(join(fullTarget, 'experiment-proof.json'), 'utf8'));
    for (const [file, digest] of Object.entries(record.outputs)) {
      if (file !== 'link.md') expect(fullProof.outputs[file], file).toBe(digest);
    }
    expect(sha(rebaseContract(readFileSync(join(target, 'references/link-contract.md'), 'utf8'), true))).toBe(record.fullContractSha256);
    expect(() => run(installed, target)).toThrow(/Output already exists/);
    expect(readFileSync(join(target, 'experiment-proof.json'), 'utf8')).toBe(proof);
    const modified = join(scratch, 'modified-baseline');
    mkdirSync(modified);
    cpSync(join(installed, 'package.json'), join(modified, 'package.json'));
    cpSync(join(installed, 'slc'), join(modified, 'slc'), { recursive: true });
    writeFileSync(join(modified, 'slc/link.md'), original + '\n<!-- baseline mutation -->\n');
    const refused = join(scratch, 'refused');
    expect(() => run(modified, refused)).toThrow(/installed link.md hash mismatch/);
    expect(existsSync(refused)).toBe(false);
    expect(readFileSync(join(installed, 'slc/link.md'), 'utf8')).toBe(original);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
