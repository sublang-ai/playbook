// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILD_MANIFEST_MARKER, BUILD_MANIFEST_SCHEMA,
  inspectArtifactEnvironment, prepareArtifactEnvironment,
  locateBuildManifest, validateArtifactManifest, inspectArtifactFiles,
  type WorkflowBuildManifest,
} from './artifact-environment.js';

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
  const p = await mkdtemp(join(tmpdir(), 'playbook-env-'));
  scratch.push(p);
  return p;
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const slash = (s: string): string => s.split(sep).join('/');

async function bundle(inside = false) {
  const root = await directory();
  const dir = join(root, 'flow.playbook');
  const entry = join(inside ? dir : root, 'flow.mjs');
  const { environment } = await prepareArtifactEnvironment({ artifactDir: dir, authority: 'compiler' });
  const manifestPath = join(dir, 'build-manifest.json');
  const texts = {
    entry: `${BUILD_MANIFEST_MARKER}${JSON.stringify('./' + slash(relative(inside ? dir : root, manifestPath)))}\nexport default {};\n`,
    fsm: 'export const machine = {};\n',
    linked: 'export default () => ({});\n',
  };
  await writeFile(entry, texts.entry);
  await writeFile(join(dir, 'flow.fsm.mjs'), texts.fsm);
  await writeFile(join(dir, 'flow.playbook.mjs'), texts.linked);
  const manifest: WorkflowBuildManifest = {
    schema: BUILD_MANIFEST_SCHEMA,
    entry: { path: slash(relative(dir, entry)), format: 'esm-javascript' },
    compiler: { package: '@sublang/slc', version: 'test', buildIdentity: 'fixture' },
    runtime: { playbook: environment.playbook, xstate: environment.xstate, runtimeAbi: environment.runtimeAbi, artifactSchema: 3 },
    inputs: [{ path: '/missing-original.md', sha256: sha('source'), snapshot: '.slc/missing-snapshot.md' }],
    files: [
      { path: slash(relative(dir, entry)), kind: 'entry', format: 'esm-javascript', sha256: sha(texts.entry) },
      { path: 'flow.fsm.mjs', kind: 'fsm', format: 'esm-javascript', sha256: sha(texts.fsm) },
      { path: 'flow.playbook.mjs', kind: 'linked', format: 'esm-javascript', sha256: sha(texts.linked) },
      { path: 'missing.gears.md', kind: 'gears', format: 'md', sha256: sha('archive') },
      { path: 'missing-check.json', kind: 'checker-evidence', format: 'json', sha256: sha('evidence') },
    ],
    verification: { checks: [{ name: 'lifecycle', status: 'passed', evidence: 'missing-check.json' }], attemptRecord: '.slc/missing-attempt.json' },
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, dir, entry, manifestPath, manifest };
}

describe('workflow-owned artifact environment integration', () => {
  it('isolates real Node imports from CommonJS and broken parent dependencies', async () => {
    const parent = await directory();
    const parentText = JSON.stringify({ type: 'commonjs', dependencies: { xstate: '0.0.0', '@sublang/playbook': '0.0.0' } });
    await writeFile(join(parent, 'package.json'), parentText);
    const artifactDir = join(parent, '空 工作流', 'flow.playbook');
    const result = await prepareArtifactEnvironment({ artifactDir, authority: 'compiler' });
    expect(result.createdLinks).toHaveLength(2);
    expect(JSON.parse(await readFile(join(artifactDir, 'package.json'), 'utf8')).type).toBe('module');
    expect((await lstat(join(artifactDir, 'node_modules', 'xstate'))).isSymbolicLink()).toBe(true);
    await writeFile(join(artifactDir, 'probe.mjs'), "import { createMachine } from 'xstate'; console.log(createMachine({initial:'idle',states:{idle:{}}}).config.initial);\n");
    expect(execFileSync(process.execPath, [join(artifactDir, 'probe.mjs')], { encoding: 'utf8' }).trim()).toBe('idle');
    expect(await readFile(join(parent, 'package.json'), 'utf8')).toBe(parentText);
    expect((await prepareArtifactEnvironment({ artifactDir, authority: 'compiler' })).createdLinks).toEqual([]);
  }, 30_000);

  it('preflights all occupied paths before writing metadata or the other link', async () => {
    const root = await directory();
    const dir = join(root, 'flow.playbook');
    await mkdir(join(dir, 'node_modules', 'xstate'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'xstate', 'user-data'), 'preserve');
    await expect(prepareArtifactEnvironment({ artifactDir: dir, authority: 'compiler' })).rejects.toThrow('occupied runtime path');
    await expect(lstat(join(dir, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(dir, 'node_modules', '@sublang', 'playbook'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(dir, 'node_modules', 'xstate', 'user-data'), 'utf8')).toBe('preserve');
  }, 30_000);

  it('does not overwrite a user manifest even when it already declares ESM', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'package.json'), '{"type":"module","private":true}');
    await expect(prepareArtifactEnvironment({ artifactDir: dir, authority: 'compiler' })).rejects.toThrow('foreign package metadata');
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('{"type":"module","private":true}');
  }, 30_000);

  it.each([false, true])('validates actual entry layout (inside=%s) without compiler archives', async (inside) => {
    const b = await bundle(inside);
    expect(await locateBuildManifest(b.entry)).toBe(b.manifestPath);
    expect((await validateArtifactManifest(b.entry))?.runtime.artifactSchema).toBe(3);
    await unlink(b.manifestPath);
    await expect(validateArtifactManifest(b.entry)).rejects.toThrow('managed build manifest is missing');
  }, 30_000);

  it('refuses changed executable bytes and a managed entry with its marker removed', async () => {
    const b = await bundle();
    await writeFile(join(b.dir, 'flow.fsm.mjs'), 'export const machine = {changed:true};');
    await expect(validateArtifactManifest(b.entry)).rejects.toThrow('runtime file missing or changed');
    await writeFile(b.entry, 'export default {};\n');
    await expect(locateBuildManifest(b.entry)).rejects.toThrow('managed entry has no build manifest marker');
  }, 30_000);

  it.each(['require', 'module.require'])('records %s closure and refuses changed or omitted helper bytes', async (loader) => {
    const b = await bundle();
    await writeFile(join(b.dir, 'flow.playbook.mjs'), "import value from './value.cjs'; export default value;\n");
    await writeFile(join(b.dir, 'value.cjs'), `module.exports = ${loader}('./helper.cjs');\n`);
    await writeFile(join(b.dir, 'helper.cjs'), 'module.exports = {value:1};\n');
    b.manifest.files = await inspectArtifactFiles({ artifactDir: b.dir, entry: b.entry, fsm: join(b.dir, 'flow.fsm.mjs'), linked: join(b.dir, 'flow.playbook.mjs') });
    expect(b.manifest.files.some(f => f.path === 'helper.cjs' && f.kind === 'runtime-support')).toBe(true);
    await writeFile(b.manifestPath, JSON.stringify(b.manifest));
    await expect(validateArtifactManifest(b.entry)).resolves.toBeDefined();
    await writeFile(join(b.dir, 'helper.cjs'), 'module.exports = {value:2};\n');
    await expect(validateArtifactManifest(b.entry)).rejects.toThrow('runtime file missing or changed');
    b.manifest.files = b.manifest.files.filter(f => f.path !== 'helper.cjs');
    await writeFile(b.manifestPath, JSON.stringify(b.manifest));
    await expect(validateArtifactManifest(b.entry)).rejects.toThrow(/runtime dependency missing from accepted manifest/);
  }, 30_000);

  it('refuses a runtime package shadowed at the actual nested importer', async () => {
    const b = await bundle();
    await mkdir(join(b.dir, 'sub', 'node_modules', 'xstate'), { recursive: true });
    await writeFile(join(b.dir, 'sub', 'node_modules', 'xstate', 'package.json'), JSON.stringify({ name: 'xstate', version: '0.0.0', type: 'module', exports: './index.js' }));
    await writeFile(join(b.dir, 'sub', 'node_modules', 'xstate', 'index.js'), 'export const foreign = true;');
    await writeFile(join(b.dir, 'sub', 'support.mjs'), "import { foreign } from 'xstate'; export default foreign;");
    await writeFile(join(b.dir, 'flow.playbook.mjs'), "export {default} from './sub/support.mjs';");
    await expect(inspectArtifactFiles({ artifactDir: b.dir, entry: b.entry, fsm: join(b.dir, 'flow.fsm.mjs'), linked: join(b.dir, 'flow.playbook.mjs') })).rejects.toThrow(/resolves to foreign/);
    await writeFile(join(b.dir, 'flow.playbook.mjs'), "import { createRequire as loader } from 'node:module'; const read = loader(import.meta.url); export default read('./helper.cjs');");
    await expect(inspectArtifactFiles({ artifactDir: b.dir, entry: b.entry, fsm: join(b.dir, 'flow.fsm.mjs'), linked: join(b.dir, 'flow.playbook.mjs') })).rejects.toThrow(/createRequire-derived loading/);
  }, 30_000);

  it('leaves genuinely historical modules without an owned footprint on the legacy path', async () => {
    const root = await directory();
    const entry = join(root, 'old.mjs');
    await writeFile(entry, 'export default {};\n');
    expect(await locateBuildManifest(entry)).toBeUndefined();
  });

  it('identifies actual installed roots rather than the caller project', async () => {
    const env = await inspectArtifactEnvironment();
    expect(env.playbook.name).toBe('@sublang/playbook');
    expect(env.xstate.name).toBe('xstate');
    expect(env.supportedArtifactSchemas).toContain(3);
    expect(env.playbook.identityFiles.some((f) => f.path === 'src/xstate-runtime.js')).toBe(true);
    expect(env.playbook.identityFiles.some((f) => f.path === 'src/xstate-runtime.d.ts')).toBe(true);
    expect(env.playbook.identityFiles.some((f) => /README|\.test\./.test(f.path))).toBe(false);
  }, 30_000);
  it('loads changed ESM and CommonJS dependencies or reports the actual missing host surface', async () => {
    const root = await directory();
    const script = `
      import assert from 'node:assert/strict';
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { importFreshArtifact, canonicalFreshArtifactUrl } from ${JSON.stringify(new URL('./fresh-artifact.js', import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      const entry = join(root, 'entry.mjs');
      if (typeof (await import('node:module')).registerHooks !== 'function') {
        await writeFile(entry, 'export default 1;');
        await assert.rejects(importFreshArtifact(entry), /fresh artifact loading requires/);
        console.log('fresh native revisions verified: explicit unsupported-host refusal');
        process.exit(0);
      }
      await writeFile(entry, "import value from './value.cjs'; export default value.value;\\n");
      await writeFile(join(root, 'value.cjs'), 'module.exports = { value: 1 };\\n');
      assert.equal((await importFreshArtifact(entry)).default, 1);
      await writeFile(join(root, 'value.cjs'), 'module.exports = { value: 2 };\\n');
      assert.equal((await importFreshArtifact(entry)).default, 2);
      await writeFile(entry, "import { value } from './value.mjs'; export default value;\\n");
      await writeFile(join(root, 'value.mjs'), 'export const value = 3;\\n');
      assert.equal((await importFreshArtifact(entry)).default, 3);
      await writeFile(join(root, 'value.mjs'), 'export const value = 4;\\n');
      assert.equal((await importFreshArtifact(entry)).default, 4);
      const first = canonicalFreshArtifactUrl(entry);
      assert.equal(first, (await import('node:url')).pathToFileURL(await (await import('node:fs/promises')).realpath(entry)).href);
      assert.equal((await import(first)).default, 4);
      await writeFile(join(root, 'value.mjs'), 'export const value = 5;\\n');
      assert.equal(canonicalFreshArtifactUrl(entry), first);
      assert.equal((await import(first)).default, 5);
      console.log('fresh native revisions verified');
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })).toContain('fresh native revisions verified');
  });

});
