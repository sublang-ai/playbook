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
const commonGuide = 'At construction, the shared factory validates linked metadata and the shared construction shape; the Captain host owns registry-manifest and live authority-envelope validation at its construction boundary.\n'
  + 'Do not audit the bare shared factory as if it owned that Captain-host boundary or synthesize host capabilities in the emitted artifact.\n\n';

it('ships the full contract and keeps the rejected compact recipe outside the package', () => {
  const cache = mkdtempSync(join(tmpdir(), 'playbook-compact-pack-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache },
      stdio: ['ignore', 'pipe', 'ignore'],
    }))[0].files.map((file: { path: string }) => file.path);
    for (const file of ['slc/link.md', 'slc/materialize-link.mjs', 'slc/slc.pin-inputs.json']) {
      expect(packed).toContain(file);
    }
    expect(packed).not.toContain('slc/references/link-contract.md');
    expect(packed).not.toContain('scripts/experiments/rejected-compact-link.md');
    expect(packed).not.toContain('scripts/experiments/materialize-link-v2.mjs');
    expect(packed).not.toContain('scripts/experiments/materializer-v2-recipe.md');
    const recipe = read('scripts/experiments/rejected-compact-link.md');
    const full = read('slc/link.md');
    expect(full).toContain('## Optional deterministic materialization');
    expect(full).not.toContain('## Supported recipe');
    expect(sha(recipe)).toBe('a00a5b7996d1449bff312299f804906256c6dcd5fef18d472dd99833c6d0f7dc');
    // The current helper includes an accepted labelled/nested CODE profile.
    // Frozen historical inputs remain unshipped reproduction artifacts.
    expect(sha(read('slc/materialize-link.mjs'))).toBe('5024778548509370d899f3709829fd7609d67bc4fe5d72b2c76d5d0ab26f59eb');
    expect(sha(read('scripts/experiments/materialize-link-v2.mjs'))).toBe('fe7336bc4c1511c4170ac3cdaeda4ffc30f3848b40ae7301f6660c20067e58e0');
    expect(sha(full)).toBe('139aaa9b245ea6421ba998573bec3c5e21f605d24710fe56fc73e23017a8e4d2');
    const preferenceGuide = [
      'For an FSM that satisfies one of the materializer profiles above, derive its',
      'complete source-owned descriptor and run `materialize-link.mjs` before writing',
      'an ordinary linked module by hand. Use the supported profile whose composer',
      'matches the actual source. An unsupported-profile exit continues ordinary',
      'linking under this definition; invalid metadata must be corrected. Never',
      'widen an option, omit a required custom strategy, change the FSM, or relax a',
      'verification check to make a profile fit.',
      '',
      '',
      '',
    ].join('\n');
    expect(full.split(preferenceGuide)).toHaveLength(2);
    const beforePreferenceGuide = full.replace(preferenceGuide, '');
    expect(sha(beforePreferenceGuide)).toBe('dfbdaf1d8f5d44151da9a04ab52953e687f9ccfb203585becc017e71295fb263');
    const entryGuardGuide = "A generated entry guard that requires the text already in context is likewise\nnot independent Source evidence; it is a producer defect when the entry action\nhas yet to copy the event's text. Do not compensate with a required option or\ninvented startup task. `entryEvent.contextField` supplies failure-retry text;\nit does not populate fresh entry context before FSM guards execute.\n";
    expect(beforePreferenceGuide.split(entryGuardGuide)).toHaveLength(2);
    const beforeEntryGuard = beforePreferenceGuide.replace(entryGuardGuide, '');
    expect(sha(beforeEntryGuard)).toBe('b54dcf041d5d7bff6dc8ba5f9e1f49034292b5cf91900b593009cbd8699c3fc5');
    const currentValidatorGuide = [
      "The linked module shall export public synchronous pure `validateOptions(value: unknown): PlaybookRuntimeOptions` and bind that same function as the shared spec's `snapshotOptions`.",
      "The validator shall first capture `value === undefined ? {} : value` with the public `snapshotJsonValue` exported by `@sublang/playbook/xstate-runtime`, before reading option members, applying defaults, or constructing a replacement record; only top-level `undefined` is normalized, and non-JSON input rejects through that shared boundary.",
      "It shall then validate the artifact's actual option shape, requiredness, source-authored defaults, unknown keys, and declared values against the detached snapshot, reject null and invalid options, and return a detached immutable plain-JSON option record without runtime construction or live host capabilities.",
    ].join('\n') + '\n';
    const previousValidatorGuide = [
      "The linked module shall export public synchronous pure `validateOptions(value: unknown): PlaybookRuntimeOptions` and bind that same function as the shared spec's `snapshotOptions`.",
      "It shall normalize only absent `undefined` to an empty option slice, retain actual required options and source-authored defaults, reject null, non-JSON values, unknown keys and invalid declared values, and return a detached immutable plain-JSON option record without runtime construction or live host capabilities.",
    ].join('\n') + '\n';
    expect(beforePreferenceGuide.split(currentValidatorGuide)).toHaveLength(2);
    expect(beforePreferenceGuide.indexOf(currentValidatorGuide)).toBeGreaterThan(beforePreferenceGuide.indexOf('## PlaybookRuntime contract'));
    const historicalFull = beforeEntryGuard.replace(currentValidatorGuide, previousValidatorGuide);
    expect(sha(historicalFull)).toBe('0436874384ff96d45a4fa5558ae9a8dd821e1c6cafde6aeededbfe57a65d5985');
    const validatorGuide = previousValidatorGuide + [
      'Boss text supplied by the entry event is not a required startup option unless Source independently requires it before the first Boss turn; a generated required type annotation alone is not that evidence.',
      'A source-appropriate optional seed may remain, and genuine required bootstrap catalogs or other options shall not be erased or filled with invented defaults.',
      '',
    ].join('\n') + '\n';
    expect(historicalFull.split(validatorGuide)).toHaveLength(2);
    const beforeValidator = historicalFull.replace(validatorGuide, '').replace([
      '- Exports the public `validateOptions` function specified above and supplies',
      "  it as the spec's identical `snapshotOptions` callback:",
    ].join('\n'), [
      "- Supplies the spec's `snapshotOptions` with the same options-validation",
      '  semantics previously generated inline:',
    ].join('\n'));
    expect(sha(beforeValidator)).toBe('f8c779eaa41645eb385bfeede03d0098839bfb1d9a6fc9b3003c7e0d82dd8d29');
    const currentRecipe = beforePreferenceGuide.slice(beforePreferenceGuide.indexOf('## Optional deterministic materialization\n'), beforePreferenceGuide.indexOf('## PlaybookRuntime contract\n'));
    const childAcceptance = "`onDone` proves successful bridge delivery without a declared child failure;\nit does not establish every caller-owned domain condition. The caller shall\nenforce its own explicit Source-authored acceptance or relay predicates on\nthe delivered output before continuing, without inventing predicates from\ncallee implementation details or overriding the child's compiled terminal\nkind with output fields.\n";
    const previousChildAcceptance = "Because the bridge routes a failure terminal to the error path, `onDone` alone\nproves the child succeeded and a caller never inspects a callee's output fields\nto decide that; a caller reads those fields only when its own Source relays\nthem.\n";
    expect(beforePreferenceGuide.split(childAcceptance)).toHaveLength(2);
    const archivedRecipe = read('scripts/experiments/materializer-v2-recipe.md')
      .replace(/^(?:<!-- SPDX-[^\n]+ -->\n)+\n/, '');
    const fullV2 = beforeValidator.replace(childAcceptance, previousChildAcceptance).replace(currentRecipe, archivedRecipe);
    expect(sha(fullV2)).toBe('26c57c00d18bca474ee965d4574660cfb6e6e6b6755642dc55f75cfe950c4700');
    const previousGuide = 'Its factory preflight checks linked metadata; the Captain host owns registry\n'
      + 'manifest and live authority-envelope validation at its construction boundary.\n'
      + 'Do not audit the bare shared factory as if it owned that Captain-host boundary\n'
      + 'or synthesize host capabilities in the emitted artifact.\n';
    const previousFull = fullV2.replace(commonGuide, '').replace('Its factory preflight checks linked metadata.\n', previousGuide);
    expect(sha(previousFull)).toBe('8ab43c44b1f3a9bf17b69d7d70dac91a0ad5a8ec299d1718f3bd88f69452c460');
    const previousClause = 'whose optional live completion mapper may return only detached `finalText`, `semanticCandidate`, `logicalOperationId`, and additional typed ledger commands for the same atomic completion;';
    const currentClause = 'whose optional live completion mapper may return only detached `finalText`, `semanticCandidate`, `logicalOperationId`, additional typed ledger commands for the same atomic completion, one `deferred` binding carrying optional UUID `operationId` plus exact `pendingQuestion` and `playerContinuation`, or literal `unresolved: true`, where `deferred` shall be mutually exclusive with `unresolved`, `logicalOperationId`, and commands;';
    expect(sha(previousFull.replace(currentClause, previousClause))).toBe('5ac5b619dbe1443b8bc3f44d145d4f146bd5e6b0ffb2b69286a1c37d37ba3b6c');
    const entryAnchors = anchorsOf(recipe);
    // The rejected archive covers its original contract, not later optional profiles.
    for (const anchor of anchorsOf(fullV2)) expect(entryAnchors.has(anchor), anchor).toBe(true);
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
    expect(closure).not.toContain('references/link-contract.md');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}, 120_000);

// Optional exact-version experiment acceptance: supply the actual installed
// package, not a fabricated baseline or a runtime/dependency adoption.
const baselinePackage = process.env.PLAYBOOK_MATERIALIZATION_BASELINE;
// The exact 12.3 builder belongs to its historical source commit; the evolving
// 13.2 helper/definitions are intentionally not substituted into that archive.
const archiveSource = process.env.PLAYBOOK_MATERIALIZATION_ARCHIVE_SOURCE;
it.runIf(baselinePackage !== undefined && archiveSource !== undefined)('reconstructs the reviewed 12.3 candidate and refuses modified baselines or existing output', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'playbook-compact-builder-'));
  const installed = baselinePackage!;
  const sourceRoot = archiveSource!;
  const read = (file: string) => readFileSync(join(sourceRoot, file), 'utf8');
  const builder = join(sourceRoot, 'scripts/build-link-experiment-12.3.mjs');
  const run = (source: string, output: string, mode?: '--full' | '--baseline' | '--compact') => execFileSync(process.execPath, [builder, source, output, ...(mode ? [mode] : [])], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const original = readFileSync(join(installed, 'slc/link.md'), 'utf8');
    const target = join(scratch, 'candidate');
    run(installed, target, '--compact');
    expect(readFileSync(join(target, 'link.md'), 'utf8')).toBe(read('scripts/experiments/rejected-compact-link.md'));
    expect(readFileSync(join(target, 'optimize.md'), 'utf8')).toBe(read('slc/optimize.md'));
    expect(sha(readFileSync(join(target, 'gears2fsm.md'), 'utf8'))).toBe('3e42baf526a46bbda89f20c3a3db250648e99e381e303925724ca6d62839a619');
    expect(readFileSync(join(target, 'materialize-link.mjs'), 'utf8')).toBe(read('scripts/experiments/materialize-link-v2.mjs'));
    const proof = readFileSync(join(target, 'experiment-proof.json'), 'utf8');
    const record = JSON.parse(proof);
    const fullTarget = join(scratch, 'full-candidate');
    run(installed, fullTarget, '--full');
    expect(readFileSync(join(fullTarget, 'link.md'), 'utf8')).toBe(rebaseContract(readFileSync(join(fullTarget, 'references/link-contract.md'), 'utf8'), true));
    expect(sha(readFileSync(join(target, 'references/link-contract.md'), 'utf8'))).toBe('05bcbc67c28a3a4a65b17872c5fdafcaa0aa3e98ced0e34b188a060282c76021');
    expect(readFileSync(join(fullTarget, 'gears2fsm.md'), 'utf8')).toBe(read('slc/gears2fsm.md'));
    const fullProof = JSON.parse(readFileSync(join(fullTarget, 'experiment-proof.json'), 'utf8'));
    const defaultTarget = join(scratch, 'default-candidate');
    run(installed, defaultTarget);
    expect(readFileSync(join(defaultTarget, 'link.md'), 'utf8')).toBe(readFileSync(join(fullTarget, 'link.md'), 'utf8'));
    for (const [file, digest] of Object.entries(record.outputs)) {
      if (!['link.md', 'references/link-contract.md', 'materialize-link.mjs', 'gears2fsm.md'].includes(file)) expect(fullProof.outputs[file], file).toBe(digest);
    }
    const baselineTarget = join(scratch, 'baseline-candidate');
    run(installed, baselineTarget, '--baseline');
    const controlEntry = readFileSync(join(baselineTarget, 'link.md'), 'utf8');
    const fullEntry = readFileSync(join(fullTarget, 'link.md'), 'utf8');
    const helperStart = fullEntry.indexOf('## Optional deterministic materialization\n');
    const helperEnd = fullEntry.indexOf('## PlaybookRuntime contract\n', helperStart);
    expect(controlEntry).toBe(fullEntry.slice(0, helperStart) + fullEntry.slice(helperEnd));
    for (const entry of [controlEntry, fullEntry]) {
      expect(entry.split(commonGuide)).toHaveLength(2);
      expect(entry.indexOf(commonGuide)).toBeLessThan(entry.indexOf('## Formats\n'));
    }
    expect(fullEntry.slice(helperStart, helperEnd)).not.toContain('Captain-host boundary');
    for (const token of ['materialize-link.mjs', 'Optional deterministic materialization', 'sublang.playbook.link.v1', 'flat-defaults', 'references/link-contract.md']) expect(controlEntry).not.toContain(token);
    const baselineProof = JSON.parse(readFileSync(join(baselineTarget, 'experiment-proof.json'), 'utf8'));
    expect(baselineProof.mode).toBe('baseline');
    expect(sha(controlEntry)).toBe(baselineProof.baselineContractSha256);
    for (const [file, digest] of Object.entries(fullProof.outputs)) {
      if (file !== 'link.md') expect(baselineProof.outputs[file], file).toBe(digest);
    }
    const conflicting = join(scratch, 'conflicting');
    expect(() => execFileSync(process.execPath, [builder, installed, conflicting, '--full', '--baseline'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow(/mutually exclusive/);
    expect(existsSync(conflicting)).toBe(false);
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
