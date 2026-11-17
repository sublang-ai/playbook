// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { ArtifactEnvironmentError } from './artifact-environment.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const roots = new Map();
const entryTokens = new Map();
const aliases = new Map();
let installed = false;
const require = createRequire(import.meta.url);
/** Revision identity propagates through local imports; package runtimes keep their own identity. */
export function freshArtifactUrl(path, root = dirname(resolve(path))) {
    if (typeof nodeModule.registerHooks !== 'function')
        throw new ArtifactEnvironmentError(`fresh artifact loading requires Node synchronous loader hooks; current runtime is ${process.version}`, 'use Node >=23.6 (or a compatible Node 22 release) for managed workflow loading');
    if (!installed && typeof nodeModule.registerHooks === 'function') {
        nodeModule.registerHooks({ resolve(specifier, context, nextResolve) {
                const result = nextResolve(specifier, context);
                const parent = context.parentURL?.startsWith('file:') ? new URL(context.parentURL) : undefined;
                const token = parent?.searchParams.get('sublangRevision') ?? (parent ? aliases.get(parent.href)?.token : undefined) ?? (result.url.startsWith('file:') ? new URL(result.url).searchParams.get('sublangRevision') ?? entryTokens.get(result.url) : undefined);
                const scope = token ? roots.get(token) : undefined;
                if (scope && result.url.startsWith('file:')) {
                    const url = new URL(result.url);
                    const file = fileURLToPath(url);
                    const rel = relative(scope, file);
                    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !rel.split(sep).includes('node_modules')) {
                        delete require.cache[file];
                        if (result.format === 'commonjs' || file.endsWith('.cjs')) {
                            const alias = pathToFileURL(resolve(dirname(file), `.sublang-${token}-${basename(file)}`)).href;
                            aliases.set(alias, { original: file, token: token });
                            return { ...result, url: alias };
                        }
                        url.searchParams.set('sublangRevision', token);
                        return { ...result, url: url.href };
                    }
                }
                return result;
            }, load(url, context, nextLoad) {
                const alias = aliases.get(url);
                if (!alias)
                    return nextLoad(url, context);
                // A distinct CJS filename avoids Node's filename-keyed CJS parse cache.
                // Keep lexical __filename/__dirname and relative require semantics at the
                // original file, and preserve its directive prologue inside the wrapper.
                const source = readFileSync(alias.original, 'utf8').replace(/^#![^\n]*/, '');
                return { format: 'commonjs', shortCircuit: true,
                    source: `(function(exports, require, module, __filename, __dirname) {\n${source}\n}).call(exports, exports, require, module, ${JSON.stringify(alias.original)}, ${JSON.stringify(dirname(alias.original))});` };
            } });
        installed = true;
    }
    const token = randomUUID();
    roots.set(token, realpathSync(root));
    const url = pathToFileURL(realpathSync(path));
    delete require.cache[resolve(path)];
    url.searchParams.set('sublangRevision', token);
    return url.href;
}
/** Import one registry revision with the same scoped dependency identity. */
export async function importFreshArtifact(path, root) {
    return import(freshArtifactUrl(path, root));
}
/** Registry preparation preserves the host's canonical locator contract. */
export function canonicalFreshArtifactUrl(path, root) {
    const revision = new URL(freshArtifactUrl(path, root));
    const token = revision.searchParams.get('sublangRevision');
    revision.search = '';
    entryTokens.set(revision.href, token);
    return revision.href;
}
