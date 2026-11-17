// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { ArtifactEnvironmentError } from './artifact-environment.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

type RevisionFile = { original: string; token: string };
interface CommonJsModule { require(id: string): unknown }
interface LexicalRequire { (id: string): unknown; resolve(id: string): string }
const roots = new Map<string, string>();
const entryTokens = new Map<string, string>();
const aliases = new Map<string, RevisionFile>();
const requests = new Map<string, RevisionFile>();
const wrappedModules = new WeakSet<CommonJsModule>();
let installed = false;
let nativeResolving = false;

function owned(root: string | undefined, file: string): boolean {
  if (!root || !isAbsolute(file)) return false;
  const path = relative(root, file);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep) && !path.split(sep).includes('node_modules');
}
function aliasUrl(file: RevisionFile): string {
  const url = pathToFileURL(resolve(dirname(file.original), `.sublang-${file.token}-${basename(file.original)}`)).href;
  aliases.set(url, file);
  return url;
}
function fileUrl(specifier: string): URL | undefined {
  return specifier.startsWith('file:') ? new URL(specifier) : isAbsolute(specifier) ? pathToFileURL(specifier) : undefined;
}

// CJS export pre-parsing can omit its known format from nextLoad. Explicit
// extensions and an explicit package type supply deterministic evidence only.
function explicitFormat(file: string): string | undefined {
  const extension = extname(file);
  const formats: Record<string, string> = {'.cjs':'commonjs','.cts':'commonjs-typescript','.mjs':'module','.mts':'module-typescript','.json':'json'};
  if (formats[extension]) return formats[extension];
  if (extension !== '.js' && extension !== '.ts') return undefined;
  const path = nodeModule.findPackageJSON?.(pathToFileURL(file));
  if (!path || basename(path) !== 'package.json') return undefined;
  const type = JSON.parse(readFileSync(path, 'utf8')).type;
  return type === 'module' ? (extension === '.ts' ? 'module-typescript' : 'module') : type === 'commonjs' ? (extension === '.ts' ? 'commonjs-typescript' : 'commonjs') : undefined;
}

/** @internal Keep native Module objects and delegate through a revision-unique request. */
export function installRevisionRequire(module: CommonJsModule, lexicalRequire: LexicalRequire, url: string): void {
  if (wrappedModules.has(module)) return;
  wrappedModules.add(module);
  const original = module.require;
  const parent = aliases.get(url);
  module.require = function (this: CommonJsModule, request: string): unknown {
    const expected = lexicalRequire.resolve(request);
    const known = fileUrl(expected);
    const file = (known ? aliases.get(known.href)?.original : undefined) ?? expected;
    let target = request;
    if (parent && owned(roots.get(parent.token), file)) {
      target = 'sublang-revision:' + parent.token + ':' + encodeURIComponent(file);
      requests.set(target, { original: file, token: parent.token });
    }
    // Do not replace Module.prototype.require or delete another revision's cache.
    return original.call(this, target);
  };
}

/** Revision identity propagates through owned files; package runtimes keep their own identity. */
export function freshArtifactUrl(path: string, root = dirname(resolve(path))): string {
  if (typeof nodeModule.registerHooks !== 'function') throw new ArtifactEnvironmentError(`fresh artifact loading requires Node synchronous loader hooks; current runtime is ${process.version}`, 'use Node >=23.6 (or a compatible Node 22 release) for managed workflow loading');
  if (!installed) {
    nodeModule.registerHooks({ resolve(specifier, context, nextResolve) {
      if (nativeResolving) return nextResolve(specifier, context);
      const known = fileUrl(specifier);
      if (known && aliases.has(known.href)) return { url: known.href, shortCircuit: true };
      const requested = requests.get(specifier);
      const parentUrl = context.parentURL?.startsWith('file:') ? new URL(context.parentURL) : undefined;
      const parent = parentUrl ? aliases.get(parentUrl.href) : undefined;
      const url = requested ? pathToFileURL(requested.original) : known ??
        (specifier.startsWith('.') && parentUrl ? new URL(specifier, parent ? pathToFileURL(parent.original) : parentUrl) : undefined);
      const token = requested?.token ?? parent?.token ?? parentUrl?.searchParams.get('sublangRevision') ?? url?.searchParams.get('sublangRevision') ?? (url ? entryTokens.get(url.href) : undefined);
      const scope = token ? roots.get(token) : undefined;
      if (url && scope && token) {
        let file = fileURLToPath(url);
        try {
          if (!requested && context.conditions.includes('require') && parentUrl) {
            nativeResolving = true;
            try { file = createRequire(parent?.original ?? fileURLToPath(parentUrl)).resolve(specifier); }
            finally { nativeResolving = false; }
          }
          file = realpathSync(file);
        } catch {
          return nextResolve(specifier, context);
        }
        if (owned(scope, file)) {
          // Node 26 must see an actual short circuit, not a URL changed after
          // nextResolve: its CJS translator otherwise tries the nonexistent alias.
          return { url: aliasUrl({ original: file, token }), shortCircuit: true };
        }
      }
      return nextResolve(requested?.original ?? specifier, context);
    }, load(url, context, nextLoad) {
      const alias = aliases.get(url);
      if (!alias) return nextLoad(url, context);
      // Let Node determine the real format (including .js/.cts/JSON); resolver
      // results from CommonJS do not necessarily carry a format.
      const loaded = nextLoad(pathToFileURL(alias.original).href, context);
      const format = loaded.format ?? explicitFormat(alias.original);
      if (format === 'module' || format === 'module-typescript' || format === 'json') return { ...loaded, format, shortCircuit: true };
      if (format !== 'commonjs' && format !== 'commonjs-typescript') throw new ArtifactEnvironmentError(`unsupported managed runtime format ${String(format)} at ${alias.original}`);
      const source = (loaded.source == null ? readFileSync(alias.original, 'utf8') : typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source)).replace(/^#![^\n]*/, '');
      // Preserve native Module identity/graph, CJS lexical file names and the
      // user's directive prologue; installation is idempotent for cyclic loads.
      const service = JSON.stringify(fileURLToPath(import.meta.url));
      return { format, shortCircuit: true,
        source: `require(${service}).installRevisionRequire(module, require, ${JSON.stringify(url)});\n(function(exports, require, module, __filename, __dirname) {\n${source}\n}).call(exports, exports, require, module, ${JSON.stringify(alias.original)}, ${JSON.stringify(dirname(alias.original))});` };
    } });
    installed = true;
  }
  const token = randomUUID();
  roots.set(token, realpathSync(root));
  const url = pathToFileURL(realpathSync(path));
  url.searchParams.set('sublangRevision', token);
  return url.href;
}

/** Import one registry revision with the same scoped dependency identity. */
export async function importFreshArtifact(path: string, root?: string): Promise<Record<string, unknown>> {
  return import(freshArtifactUrl(path, root));
}

/** Registry preparation preserves the host's canonical locator contract. */
export function canonicalFreshArtifactUrl(path: string, root?: string): string {
  const revision = new URL(freshArtifactUrl(path, root));
  const token = revision.searchParams.get('sublangRevision')!;
  revision.search = '';
  entryTokens.set(revision.href, token);
  return revision.href;
}
