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
const fullMode = mode === undefined || mode === '--full';
const compactMode = mode === '--compact';
const baselineMode = mode === '--baseline';
const modeName = baselineMode ? 'baseline' : fullMode ? 'full' : 'compact';
if (!installedArgument || !targetArgument || process.argv.length > 5 || (!fullMode && !baselineMode && !compactMode)) {
  throw new Error('Usage: node scripts/build-link-experiment-12.3.mjs <installed-playbook-package-root> <new-definition-directory> [--full | --baseline | --compact] (mutually exclusive)');
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
  full13: '60061f7e0a54281f883a429ec84a0685a7990e886c0d289c23b70e7c160ab2c2',
  full12: '532b0ad904203200d971b1d4794a7f412db96e151e6c00e49ef2017d8ab22706',
  baseline12: '60d287dfa19061ef682e36f596879c7c9f4223198ee55b9fa769a361ce99be5c',
  helper: '0d3163b79757e48abd9e2f90a1156309a572e540d2b458a442a2c14c0ee4c253',
  helperV2: 'fe7336bc4c1511c4170ac3cdaeda4ffc30f3848b40ae7301f6660c20067e58e0',
  helperV2Recipe: '1d96e73164adf8f195807007fea260d9fda3e3dc581e98091855b9e2fc365f90',
  entry: 'a00a5b7996d1449bff312299f804906256c6dcd5fef18d472dd99833c6d0f7dc',
  companion: '406541706fad41b89d5afa0118d7ad0a79e104afefb43959820ea84230792e74',
  rejectedFull12: '683e4fbe489c8e70e03651ae725c1f85d9bdd93e4e4ebcf4bd51eee55173d8ec',
  rejectedCompanion: '05bcbc67c28a3a4a65b17872c5fdafcaa0aa3e98ced0e34b188a060282c76021',
  optimizer: '4f3111e1a8a2124c8a174d63752be368ab763493b603f7a4df4bed60c264cfb9',
  rejectedProducer: '3e42baf526a46bbda89f20c3a3db250648e99e381e303925724ca6d62839a619',
  producer: '98d6a28c7309a8933ea7057aec03e0f651a2f9e66c8095ced844fd17bd4e5f8f',
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
const full13 = await readFile(join(repo, 'slc/link.md'), 'utf8');
verify(full13, expected.full13, 'committed complete 13.1 contract');
const recipeStart = full13.indexOf('## Optional deterministic materialization\n');
const recipeEnd = full13.indexOf('## PlaybookRuntime contract\n', recipeStart);
assert(recipeStart >= 0 && recipeEnd > recipeStart, 'Optional helper recipe must be present');
const helperRecipe = full13.slice(recipeStart, recipeEnd);
const commonGuide = 'At construction, the shared factory validates linked metadata and the shared construction shape; the Captain host owns registry-manifest and live authority-envelope validation at its construction boundary.\n'
  + 'Do not audit the bare shared factory as if it owned that Captain-host boundary or synthesize host capabilities in the emitted artifact.\n\n';
const commonAnchor = 'The adapter shall speak only `PlaybookPorts` to the runtime and shall not leak host types back into it.\n\n';
assert.equal(full13.split(commonGuide).length, 2, 'Exactly one common host-boundary guide is required');
assert(full13.includes(commonAnchor + commonGuide), 'The guide belongs to the common introduction');
assert(!helperRecipe.includes('Captain-host boundary'), 'The optional tool instructions must not duplicate common ownership guidance');
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
  .replace(commonAnchor, commonAnchor + commonGuide)
  .replace('## PlaybookRuntime contract\n', helperRecipe + '## PlaybookRuntime contract\n');
assert.equal(full12.replace(helperRecipe, '').replace(commonGuide, '').replace(effectRule, '').replace(currentCompletion[0], oldCompletion[0]), baseline['link.md'], 'Only the reviewed helper recipe, common ownership guide, effect sentences and completion-mapper correction may augment the full contract');
verify(full12, expected.full12, 'reconstructed complete 12.3 helper contract');
const baselineDefinition = full12.replace(helperRecipe, '');
verify(baselineDefinition, expected.baseline12, 'complete 12.3 contract without helper instructions');
assert.equal(baselineDefinition.replace(commonGuide, '').replace(effectRule, '').replace(currentCompletion[0], oldCompletion[0]), baseline['link.md'], 'Only the common ownership guide and reviewed correctness corrections may alter the control entry');
for (const token of ['materialize-link.mjs', '## Optional deterministic materialization', 'sublang.playbook.link.v1', 'flat-defaults', 'references/link-contract.md']) {
  assert(!baselineDefinition.includes(token), `Control entry must not cite helper or compact instructions: ${token}`);
}
const entrySource = await readFile(join(repo, 'scripts/experiments/rejected-compact-link.md'), 'utf8');
// Preserve the rejected compact experiment's exact earlier full contract.
// Current full/baseline comparisons share the common guide instead.
const rejectedHelperGuide = 'Its factory preflight checks linked metadata; the Captain host owns registry\n'
  + 'manifest and live authority-envelope validation at its construction boundary.\n'
  + 'Do not audit the bare shared factory as if it owned that Captain-host boundary\n'
  + 'or synthesize host capabilities in the emitted artifact.\n';
const helperV2Recipe = await readFile(join(repo, 'scripts/experiments/materializer-v2-recipe.md'), 'utf8');
verify(helperV2Recipe, expected.helperV2Recipe, 'unchanged v2 helper recipe');
const rejectedFull12 = full12.replace(helperRecipe, helperV2Recipe).replace(commonGuide, '').replace('Its factory preflight checks linked metadata.\n', rejectedHelperGuide);
verify(rejectedFull12, expected.rejectedFull12, 'unchanged rejected compact full contract');
const entry = compactDefinition(rejectedFull12, entrySource.split('## Compiled execution\n')[0]);
const companionContract = compactMode ? rejectedFull12 : full12;
const companion = rebaseContract(companionContract);
assert.equal(rebaseContract(companion, true), companionContract, 'Companion relocation must be reversible');
verify(entry, expected.entry, 'compact entry');
verify(companion, compactMode ? expected.rejectedCompanion : expected.companion, '12.3 companion');
const helper = await readFile(join(repo, compactMode ? 'scripts/experiments/materialize-link-v2.mjs' : 'slc/materialize-link.mjs'), 'utf8');
verify(helper, compactMode ? expected.helperV2 : expected.helper, compactMode ? 'unchanged v2 helper' : 'quoted-relay v3 helper');
const optimizer = await readFile(join(repo, 'slc/optimize.md'), 'utf8');
verify(optimizer, expected.optimizer, 'independent exact-root and valid-GEARS optimizer correction');
const producer = await readFile(join(repo, 'slc/gears2fsm.md'), 'utf8');
verify(producer, expected.producer, 'machine-root namespace and canonical question-storage corrections');
const rootNamespaceRule = 'Public `meta.playbook` state metadata belongs only to nodes declared under `states`; the machine root shall omit `meta.playbook`, while its XState `id`, description, and metadata outside that namespace remain unrestricted.\n';
const questionStorageRule = "The canonical storage paths are `context.pendingBossQuestion` and `context.bossReply` for the scalar form, or `context.pendingBossQuestions[stateId]` and `context.bossReplies[stateId]` for the keyed form.\nA private wrapper such as `context.continuation` shall not replace these fields directly on machine context.\n\n";
assert.equal(producer.replace(rootNamespaceRule, '').replace(questionStorageRule, ''), baseline['gears2fsm.md'], 'Only the reviewed root namespace and question-storage clarifications may change the FSM producer');
const rejectedProducer = producer.replace(questionStorageRule, '');
verify(rejectedProducer, expected.rejectedProducer, 'unchanged rejected-experiment FSM producer');
const sidecar = JSON.stringify({
  schema: 'sublang.slc.pin-inputs.v1',
  closures: { link: ['text2gears.md', 'gears2fsm.md', 'optimize.md', 'materialize-link.mjs', 'references/link-contract.md'] },
}, null, 2) + '\n';
const outputs = {
  'link.md': baselineMode ? baselineDefinition : fullMode ? full12 : entry,
  'text2gears.md': baseline['text2gears.md'],
  'gears2fsm.md': compactMode ? rejectedProducer : producer,
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
  changes: [compactMode ? 'unchanged helper v2' : 'helper v3 with explicit quoted-relay profile and unchanged default-profile output', baselineMode ? 'complete contract without helper instructions' : fullMode ? 'complete helper-backed definition' : 'rejected compact semantic recipe with its unchanged earlier full contract', 'exact full-contract relocation plus existing helper recipe, three source-effect sentences and canonical completion-mapper correction', compactMode ? 'original helper-local host-boundary guidance preserved for rejected experiment reproduction' : 'identical common host-boundary guidance outside the helper recipe', 'independent optimizer exact-root and valid-GEARS corrections f0f032b/40d8538', compactMode ? 'unchanged earlier producer with machine-root public-state namespace correction' : 'machine-root public-state namespace and canonical question-storage clarifications', 'explicit helper and companion link closure'],
  fullContractSha256: hash(companionContract),
  baselineContractSha256: hash(baselineDefinition),
  baselineDelta: compactMode ? 'Rejected experiment reproduction; not a current baseline/full comparison' : 'Only the optional deterministic materialization section differs from full; common host-boundary guidance and all other declared semantic inputs match',
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
