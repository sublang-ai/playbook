#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Narrow experiment fixture. Never modifies or adopts the supplied installation.
// The output is a new definition directory, not a package or runtime engine.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactDefinition, rebaseContract } from './compact-link-definition.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const [installedArgument, targetArgument, mode] = process.argv.slice(2);
const fullMode = mode === '--full';
const baselineMode = mode === '--baseline';
const modeName = baselineMode ? 'baseline' : fullMode ? 'full' : 'compact';
if (!installedArgument || !targetArgument || process.argv.length > 5 || (mode !== undefined && !fullMode && !baselineMode)) {
  throw new Error('Usage: node scripts/build-link-experiment-12.3.mjs <installed-playbook-package-root> <new-definition-directory> [--full | --baseline] (mutually exclusive)');
}
const installed = resolve(installedArgument);
const target = resolve(targetArgument);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baselineHashes = {
  'link.md': '9d125da89dfafecfe5c4fe495364dd210b5a018989b76463cbe1d54d2dce5067',
  'text2gears.md': '48a6a5d3f02a1d90dcc0883170da74e16c29b1554533913eb4fd7cefc49251bb',
  'gears2fsm.md': 'c549458f39337b4ce1697e1103ee2010656ced0b8a08b2fe57a103f9186c2b1e',
  'optimize.md': 'dc8c59f02c73165f1e65b40187f2dc07def9ba43b884a04d992e400c20db6e66',
};
const expected = {
  full13: '55456b21dab8484f03a868f3816d3d05a0fbc4e626ea86be10e93861529239cf',
  full12: '683e4fbe489c8e70e03651ae725c1f85d9bdd93e4e4ebcf4bd51eee55173d8ec',
  baseline12: 'cc81015ddcae5d7c6cb58f9932e9ffd5d765dc6f0489c5a0915f79e4daaec117',
  helper: 'fe7336bc4c1511c4170ac3cdaeda4ffc30f3848b40ae7301f6660c20067e58e0',
  entry: 'a00a5b7996d1449bff312299f804906256c6dcd5fef18d472dd99833c6d0f7dc',
  companion: '05bcbc67c28a3a4a65b17872c5fdafcaa0aa3e98ced0e34b188a060282c76021',
  optimizer: '4f3111e1a8a2124c8a174d63752be368ab763493b603f7a4df4bed60c264cfb9',
  producer: '3e42baf526a46bbda89f20c3a3db250648e99e381e303925724ca6d62839a619',
};
const verify = (bytes, digest, label) => assert.equal(hash(bytes), digest, `${label} hash mismatch; this fixture requires its exact reviewed inputs`);
try {
  await lstat(target);
  throw new Error(`Output already exists: ${target}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@sublang/playbook');
assert.equal(pkg.version, '12.3.0', 'This experiment is pinned to installed Playbook 12.3.0');
const baseline = {};
for (const [file, digest] of Object.entries(baselineHashes)) {
  baseline[file] = await readFile(join(installed, 'slc', file), 'utf8');
  verify(baseline[file], digest, `installed ${file}`);
}
const full13 = rebaseContract(await readFile(join(repo, 'slc/references/link-contract.md'), 'utf8'), true);
verify(full13, expected.full13, 'committed complete 13.1 contract');
const recipeStart = full13.indexOf('## Optional deterministic materialization\n');
const recipeEnd = full13.indexOf('## PlaybookRuntime contract\n', recipeStart);
assert(recipeStart >= 0 && recipeEnd > recipeStart, 'Legacy helper recipe must be present');
const legacyRecipe = full13.slice(recipeStart, recipeEnd);
const prefixes = [
  'The linker shall derive each disposition from ',
  'A completion that requires committing the result to Git ',
  'The absence of `latestCommit` or any other effect-owned field ',
];
const effectLines = full13.split('\n').filter((line) => prefixes.some((prefix) => line.startsWith(prefix)));
assert.equal(effectLines.length, 3, 'Exactly the reviewed three source-effect sentences are required');
const effectRule = effectLines.join('\n') + '\n';
const dispositionAnchor = baseline['link.md'].split('\n').filter((line) => line.startsWith('Each repository disposition shall be exactly '));
assert.equal(dispositionAnchor.length, 1);
const anchor = dispositionAnchor[0] + '\n';
const completionPrefix = 'For a Captain-hosted schema-3 artifact, `hostCapabilities` shall contain exactly ';
const oldCompletion = baseline['link.md'].split('\n').filter((line) => line.startsWith(completionPrefix));
const currentCompletion = full13.split('\n').filter((line) => line.startsWith(completionPrefix));
assert.equal(oldCompletion.length, 1);
assert.equal(currentCompletion.length, 1);
const full12 = baseline['link.md'].replace(oldCompletion[0], currentCompletion[0]).replace(anchor, anchor + effectRule)
  .replace('## PlaybookRuntime contract\n', legacyRecipe + '## PlaybookRuntime contract\n');
assert.equal(full12.replace(legacyRecipe, '').replace(effectRule, '').replace(currentCompletion[0], oldCompletion[0]), baseline['link.md'], 'Only the reviewed recipe, effect sentences and completion-mapper correction may augment the full contract');
verify(full12, expected.full12, 'reconstructed complete 12.3 helper contract');
const baselineDefinition = full12.replace(legacyRecipe, '');
verify(baselineDefinition, expected.baseline12, 'complete 12.3 contract without helper instructions');
assert.equal(baselineDefinition.replace(effectRule, '').replace(currentCompletion[0], oldCompletion[0]), baseline['link.md'], 'Only the reviewed correctness corrections may alter the control entry');
for (const token of ['materialize-link.mjs', '## Optional deterministic materialization', 'sublang.playbook.link.v1', 'flat-defaults', 'references/link-contract.md']) {
  assert(!baselineDefinition.includes(token), `Control entry must not cite helper or compact instructions: ${token}`);
}
const entrySource = await readFile(join(repo, 'slc/link.md'), 'utf8');
const entry = compactDefinition(full12, entrySource.split('## Compiled execution\n')[0]);
const companion = rebaseContract(full12);
assert.equal(rebaseContract(companion, true), full12, 'Companion relocation must be reversible');
verify(entry, expected.entry, 'compact entry');
verify(companion, expected.companion, '12.3 companion');
const helper = await readFile(join(repo, 'slc/materialize-link.mjs'), 'utf8');
verify(helper, expected.helper, 'unchanged v2 helper');
const optimizer = await readFile(join(repo, 'slc/optimize.md'), 'utf8');
verify(optimizer, expected.optimizer, 'independent exact-root and valid-GEARS optimizer correction');
const producer = await readFile(join(repo, 'slc/gears2fsm.md'), 'utf8');
verify(producer, expected.producer, 'machine-root public-state namespace correction');
const rootNamespaceRule = 'Public `meta.playbook` state metadata belongs only to nodes declared under `states`; the machine root shall omit `meta.playbook`, while its XState `id`, description, and metadata outside that namespace remain unrestricted.\n';
assert.equal(producer.replace(rootNamespaceRule, ''), baseline['gears2fsm.md'], 'Only the reviewed root namespace sentence may change the FSM producer');
const sidecar = JSON.stringify({
  schema: 'sublang.slc.pin-inputs.v1',
  closures: { link: ['text2gears.md', 'gears2fsm.md', 'optimize.md', 'materialize-link.mjs', 'references/link-contract.md'] },
}, null, 2) + '\n';
const outputs = {
  'link.md': baselineMode ? baselineDefinition : fullMode ? full12 : entry,
  'text2gears.md': baseline['text2gears.md'],
  'gears2fsm.md': producer,
  'optimize.md': optimizer,
  'materialize-link.mjs': helper,
  'references/link-contract.md': companion,
  'slc.pin-inputs.json': sidecar,
};
const proof = {
  experiment: `Playbook 12.3 ${modeName} link-definition experiment; no engine or dependency adoption`,
  mode: modeName,
  installedPackage: installed,
  version: pkg.version,
  baselineHashes,
  changes: ['unchanged helper v2', baselineMode ? 'complete contract without helper instructions' : fullMode ? 'complete helper-backed definition' : 'compact semantic recipe', 'exact full-contract relocation plus existing helper recipe, three source-effect sentences and canonical completion-mapper correction', 'independent optimizer exact-root and valid-GEARS corrections f0f032b/40d8538', 'machine-root public-state namespace correction', 'explicit helper and companion link closure'],
  fullContractSha256: hash(full12),
  baselineContractSha256: hash(baselineDefinition),
  baselineDelta: 'Only the optional deterministic materialization section differs from full; other declared semantic inputs match',
  outputs: Object.fromEntries(Object.entries(outputs).map(([name, bytes]) => [name, hash(bytes)])),
};
// All input/version/content checks precede any output write. A new sibling
// directory is staged and renamed after a complete successful build.
const staging = await mkdtemp(join(dirname(target), '.playbook-link-experiment-'));
try {
  await mkdir(join(staging, 'references'));
  for (const [file, bytes] of Object.entries(outputs)) await writeFile(join(staging, file), bytes);
  await writeFile(join(staging, 'experiment-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  // Recheck before rename; this fixture assumes a single writer for its target.
  try { await lstat(target); throw new Error(`Output already exists: ${target}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(staging, target);
} finally {
  await rm(staging, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ target, ...proof }, null, 2) + '\n');
