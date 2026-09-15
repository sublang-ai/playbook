#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node scripts/build-fsm-scaffold-experiment-13.2.mjs <frozen-compiler-root> <new-pair-root>';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(usage + '\n');
  process.exit(0);
}
assert(args.length === 2, usage);
const compiler = await realpath(resolve(args[0]));
const requested = resolve(args[1]);
const target = join(await realpath(dirname(requested)), basename(requested));
const sourceRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const boundary of [compiler, sourceRoot]) {
  const rel = relative(boundary, target);
  assert(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel), 'Output must be outside the supplied compiler and builder checkout');
}
async function absent(path) {
  try {
    await lstat(path);
    throw new Error(`Output already exists: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
async function regular(path) {
  assert((await lstat(path)).isFile(), `Expected regular file: ${path}`);
  assert.equal(await realpath(path), path, `Symbolic input is forbidden: ${path}`);
  return readFile(path);
}
function checkedMember(name) {
  assert(name.startsWith('playbook/') && !isAbsolute(name) && !name.includes('\\') && !name.split('/').includes('..'), `Invalid baseline member: ${name}`);
  return name;
}
await absent(target);
const helperPath = join(sourceRoot, 'slc/scaffold-fsm.mjs');
const guidePath = join(sourceRoot, 'slc/experiments/fsm-scaffold-guidance.md');
const helper = await regular(helperPath);
const guide = await regular(guidePath);
const guideText = guide.toString();
const relativeHelperLink = '[scaffold-fsm.mjs](../scaffold-fsm.mjs)';
assert.equal(guideText.split(relativeHelperLink).length, 2, 'Guide must have one adjacent initializer link');
const appendix = '\n' + guideText.replace(relativeHelperLink, '[scaffold-fsm.mjs](scaffold-fsm.mjs)');
const baselineBuilder = join(sourceRoot, 'scripts/build-link-experiment-13.2.mjs');
const baselineBuilderBytes = await regular(baselineBuilder);
const staging = await mkdtemp(join(dirname(target), '.playbook-fsm-scaffold-pair-'));
try {
  const construction = join(staging, 'construction');
  execFileSync(process.execPath, [baselineBuilder, compiler, construction, '--baseline'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const baselineProof = JSON.parse(await readFile(join(construction, 'experiment-proof.json'), 'utf8'));
  assert.equal(baselineProof.schema, 'sublang.playbook.link-experiment.v1');
  assert.equal(baselineProof.mode, 'baseline');
  assert.equal(baselineProof.compilerRoot, compiler);
  assert.equal(baselineProof.builderSha256, sha(baselineBuilderBytes));
  const common = new Map();
  for (const [name, record] of Object.entries(baselineProof.outputs)) {
    const bytes = await regular(join(construction, checkedMember(name)));
    assert.equal(sha(bytes), record.sha256, `Baseline identity changed: ${name}`);
    assert.equal(bytes.length, record.bytes);
    common.set(name, bytes);
  }
  const helperMember = 'playbook/scaffold-fsm.mjs';
  const guideMember = 'playbook/experiments/fsm-scaffold-guidance.md';
  assert(!common.has(helperMember) && !common.has(guideMember), 'Baseline must not select the scaffold treatment');
  common.set(helperMember, helper);
  common.set(guideMember, guide);
  const sidecar = JSON.parse(common.get('playbook/slc.pin-inputs.json'));
  for (const phase of ['text2gears', 'gears2fsm', 'optimize', 'link']) {
    assert(Array.isArray(sidecar.closures[phase]));
    for (const locator of ['scaffold-fsm.mjs', 'experiments/fsm-scaffold-guidance.md']) {
      assert(!sidecar.closures[phase].includes(locator));
      sidecar.closures[phase].push(locator);
    }
  }
  common.set('playbook/slc.pin-inputs.json', Buffer.from(JSON.stringify(sidecar, null, 2) + '\n'));
  const producer = common.get('playbook/gears2fsm.md');
  assert(producer && !producer.toString().includes('scaffold-fsm.mjs'));
  const outputs = {};
  for (const arm of ['baseline', 'scaffold']) {
    outputs[arm] = {};
    for (const [name, baseBytes] of common) {
      const bytes = arm === 'scaffold' && name === 'playbook/gears2fsm.md'
        ? Buffer.concat([baseBytes, Buffer.from(appendix)]) : baseBytes;
      const destination = join(staging, arm, name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx' });
      outputs[arm][name] = { bytes: bytes.length, sha256: sha(bytes) };
    }
  }
  const changed = Object.keys(outputs.baseline).filter(name => outputs.baseline[name].sha256 !== outputs.scaffold[name].sha256);
  assert.deepEqual(changed, ['playbook/gears2fsm.md']);
  assert.equal(sha(await regular(helperPath)), sha(helper), 'Initializer changed during assembly');
  assert.equal(sha(await regular(guidePath)), sha(guide), 'Guide changed during assembly');
  assert.equal(sha(await regular(baselineBuilder)), sha(baselineBuilderBytes), 'Baseline builder changed during assembly');
  const inventoryNames = ["package.json", "package-lock.json"];
  async function distNames(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await distNames(path);
      else inventoryNames.push(relative(compiler, path).split(sep).join('/'));
    }
  }
  await distNames(join(compiler, 'dist'));
  assert.deepEqual(inventoryNames.sort(), Object.keys(baselineProof.compilerInventory).sort(), 'Frozen compiler inventory membership changed');
  for (const [name, record] of Object.entries(baselineProof.compilerInventory)) {
    assert(!isAbsolute(name) && !name.split('/').includes('..'));
    const bytes = await regular(join(compiler, name));
    assert.equal(sha(bytes), record.sha256, `Frozen compiler changed: ${name}`);
    assert.equal(bytes.length, record.bytes);
  }
  const proof = {
    schema: 'sublang.playbook.fsm-scaffold-experiment.v1',
    status: 'assembled candidate; no provider, runtime or performance acceptance',
    compilerRoot: compiler,
    builderSha256: sha(await regular(fileURLToPath(import.meta.url))),
    baselineConstruction: baselineProof,
    initializer: { bytes: helper.length, sha256: sha(helper) },
    guidance: { bytes: guide.length, sha256: sha(guide) },
    appendedGuidance: { bytes: Buffer.byteLength(appendix), sha256: sha(appendix), rebase: `${relativeHelperLink} -> [scaffold-fsm.mjs](scaffold-fsm.mjs)` },
    treatment: 'Only scaffold/playbook/gears2fsm.md appends optional initializer guidance. Both arms contain identical undirected initializer/guide files and complete semantic closures; no maintained workflow implementation is copied.',
    outputs,
  };
  await rm(construction, { recursive: true, force: true });
  await writeFile(join(staging, 'experiment-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  await absent(target);
  await rename(staging, target);
  process.stdout.write(JSON.stringify({ target, baseline: join(target, 'baseline'), scaffold: join(target, 'scaffold'), proof: join(target, 'experiment-proof.json') }) + '\n');
} finally {
  await rm(staging, { recursive: true, force: true });
}
