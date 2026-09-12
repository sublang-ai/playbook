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
const [installedArgument, targetArgument] = process.argv.slice(2);
if (!installedArgument || !targetArgument || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/build-link-experiment-12.3.mjs <installed-playbook-package-root> <new-definition-directory>');
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
  full13: '75e2e6e51a49a8621dd713d4d081db001a6256b28fc565a2ca192471ad084043',
  full12: '20f223c1ff58f2f59f69f250d47aa385fafabfcef63bfb6e2e0080cf5d7cc9dd',
  helper: 'fe7336bc4c1511c4170ac3cdaeda4ffc30f3848b40ae7301f6660c20067e58e0',
  entry: 'a00a5b7996d1449bff312299f804906256c6dcd5fef18d472dd99833c6d0f7dc',
  companion: 'f3ae15ae1da1335a16d262171a20f50973af7a7300a2592e5af6d78c65aa292a',
  optimizer: '4f3111e1a8a2124c8a174d63752be368ab763493b603f7a4df4bed60c264cfb9',
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
const full12 = baseline['link.md'].replace(anchor, anchor + effectRule)
  .replace('## PlaybookRuntime contract\n', legacyRecipe + '## PlaybookRuntime contract\n');
assert.equal(full12.replace(legacyRecipe, '').replace(effectRule, ''), baseline['link.md'], 'Only the reviewed recipe and effect sentences may augment the full contract');
verify(full12, expected.full12, 'reconstructed complete 12.3 helper contract');
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
const sidecar = JSON.stringify({
  schema: 'sublang.slc.pin-inputs.v1',
  closures: { link: ['text2gears.md', 'gears2fsm.md', 'optimize.md', 'materialize-link.mjs', 'references/link-contract.md'] },
}, null, 2) + '\n';
const outputs = {
  'link.md': entry,
  'text2gears.md': baseline['text2gears.md'],
  'gears2fsm.md': baseline['gears2fsm.md'],
  'optimize.md': optimizer,
  'materialize-link.mjs': helper,
  'references/link-contract.md': companion,
  'slc.pin-inputs.json': sidecar,
};
const proof = {
  experiment: 'Playbook 12.3 compact helper recipe; no engine or dependency adoption',
  installedPackage: installed,
  version: pkg.version,
  baselineHashes,
  changes: ['unchanged helper v2', 'compact semantic recipe', 'exact full-contract relocation plus existing helper recipe and three source-effect sentences', 'independent optimizer exact-root and valid-GEARS corrections f0f032b/40d8538', 'explicit helper and companion link closure'],
  fullContractSha256: hash(full12),
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
