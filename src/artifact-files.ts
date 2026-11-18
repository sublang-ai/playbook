// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from '@babel/parser';
import type { BuildFile } from './artifact-environment.js';
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };

/** Parse executable imports, excluding quoted prompt examples and erased types. */
function imports(source: string, path: string): string[] {
  const tree = parse(source, { sourceType: path.endsWith('.cjs') || path.endsWith('.cts') ? 'script' : 'module', plugins: /\.[cm]?ts$/.test(path) ? ['typescript'] : [], allowReturnOutsideFunction: true, createImportExpressions: true });
  const found: string[] = [];
  const memberName = (node: Record<string, unknown> | undefined): unknown => node?.computed ? (node.property as {value?: unknown})?.value : (node?.property as {name?: unknown})?.name;
  const refuseLoader = () => { throw new Error(`unverified: createRequire-derived loading cannot be statically bound at ${path}; use literal module imports or CommonJS require`); };
  const add = (node: Record<string, unknown> | undefined) => {
    if (!node || typeof node.value !== 'string') throw new Error(`unverified: dynamic module dependency cannot be identified at ${path}`);
    found.push(node.value);
  };
  const visit = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const node = raw as Record<string, unknown>;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(String(node.type)) && node.source) {
      const specifiers = node.specifiers as { importKind?: string; exportKind?: string }[] | undefined;
      const erased = node.importKind === 'type' || node.exportKind === 'type' || (!!specifiers?.length && specifiers.every((item) => item.importKind === 'type' || item.exportKind === 'type'));
      if (!erased) add(node.source as Record<string, unknown>);
    }
    if (node.type === 'ImportSpecifier' && (node.imported as {name?: string})?.name === 'createRequire') refuseLoader();
    if (node.type === 'MemberExpression' && memberName(node) === 'createRequire') refuseLoader();
    if (node.type === 'ObjectProperty' && (node.key as {name?: string;value?: string})?.name === 'createRequire' && (node.value as {type?: string})?.type === 'Identifier') refuseLoader();
    if (node.type === 'ImportExpression') add(node.source as Record<string, unknown>);
    if (node.type === 'CallExpression') {
      const callee = node.callee as Record<string, unknown>;
      if (callee?.name === 'require' || (callee?.type === 'MemberExpression' && memberName(callee) === 'require' && (callee.object as {name?: string})?.name === 'module')) add((node.arguments as Record<string, unknown>[])[0]);
      else if (callee?.type === 'MemberExpression' && memberName(callee) === 'require') throw new Error(`unverified: module loader base cannot be identified at ${path}`);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(tree);
  return found;
}

async function packageRoot(importer: string, specifier: string, name: string): Promise<string> {
  let candidate = dirname(createRequire(importer).resolve(specifier));
  for (;;) {
    try { if (JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')).name === name) return realpath(candidate); } catch {}
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`environment: cannot establish ${name} identity for ${specifier} from ${importer}`);
    candidate = parent;
  }
}

/** The executable closure is shared by publication and pre-import validation. */
export async function inspectArtifactFiles(options: { artifactDir: string; entry: string; fsm: string; linked: string }): Promise<BuildFile[]> {
  const dir = await realpath(resolve(options.artifactDir));
  const physical = dir;
  const entry = await realpath(resolve(options.entry));
  const pending = [{ path: entry, kind: 'entry' }, { path: await realpath(resolve(options.fsm)), kind: 'fsm' }, { path: await realpath(resolve(options.linked)), kind: 'linked' }];
  const primaryKinds = new Map(pending.map((item) => [item.path, item.kind]));
  const files: BuildFile[] = [];
  const selectedRoots = new Map<string, string>();
  const seen = new Set<string>();
  while (pending.length) {
    const { path, kind } = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (seen.size > 2048) throw new Error('unverified: artifact module closure exceeds 2048 files');
    if (path !== entry && (!inside(dir, path) || !inside(physical, await realpath(path)))) throw new Error(`artifact: runtime dependency escapes workflow bundle: ${path}`);
    const data = await readFile(path);
    const extension = extname(path);
    if (!['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].includes(extension)) throw new Error(`environment: unsupported runtime file format: ${path}`);
    files.push({ path: relative(dir, path).split(sep).join('/'), kind: (primaryKinds.get(path) ?? kind) as BuildFile['kind'], format: /ts$/.test(extension) ? 'typescript' : extension === '.cjs' ? 'commonjs' : extension === '.json' ? 'json' : 'esm-javascript', sha256: createHash('sha256').update(data).digest('hex') });
    if (extension === '.json') continue;
    for (const specifier of imports(data.toString('utf8'), path)) {
      if (specifier.startsWith('node:') || builtins.has(specifier)) continue;
      const allowedPackage = specifier === 'xstate' || specifier.startsWith('xstate/') ? 'xstate' : specifier === '@sublang/playbook' || specifier.startsWith('@sublang/playbook/') ? '@sublang/playbook' : undefined;
      if (allowedPackage) {
        const surface = allowedPackage === 'xstate' ? 'xstate' : '@sublang/playbook/xstate-runtime';
        if (!selectedRoots.has(allowedPackage)) selectedRoots.set(allowedPackage, await packageRoot(join(dir, 'package.json'), surface, allowedPackage));
        const actual = await packageRoot(path, specifier, allowedPackage);
        if (actual !== selectedRoots.get(allowedPackage)) throw new Error(`environment: runtime import ${specifier} from ${path} resolves to foreign ${actual}; expected selected ${selectedRoots.get(allowedPackage)}`);
        continue;
      }
      if (!specifier.startsWith('.')) throw new Error(`environment: unowned runtime import ${specifier} in ${path}; generated code must use the selected Playbook/XState environment`);
      pending.push({ path: createRequire(path).resolve(specifier), kind: 'runtime-support' });
    }
  }
  return files;
}
