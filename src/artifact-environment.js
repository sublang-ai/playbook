// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
/** Shared, compiler/host-owned environment for filesystem workflow bundles. */
import { inspectArtifactFiles } from './artifact-files.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile, } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const BUILD_MANIFEST_SCHEMA = 'sublang.slc.build.v1';
export const BUILD_MANIFEST_MARKER = '// @sublang/slc-build-manifest ';
const OWNER = 'sublangArtifactEnvironment';
const ROOTS = 'sublangRuntimeRoots';
const RUNTIME_KINDS = new Set(['entry', 'fsm', 'linked', 'runtime-support']);
export class ArtifactEnvironmentError extends Error {
    remedy;
    category = 'environment';
    constructor(message, remedy = 'restore the selected installation or recompile this workflow') {
        super(`${message}; ${remedy}`);
        this.remedy = remedy;
        this.name = 'ArtifactEnvironmentError';
    }
}
const absent = (error) => !!error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (data) => createHash('sha256').update(data).digest('hex');
const portable = (path) => path.split(sep).join('/');
const same = (a, b) => process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function inside(root, path) {
    const rel = relative(root, path);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
async function json(path) {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!record(value))
        throw new ArtifactEnvironmentError(`invalid JSON record at ${path}`);
    return value;
}
async function stat(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (absent(error))
            return undefined;
        throw error;
    }
}
async function packageRoot(entry, name) {
    for (let dir = dirname(await realpath(entry));; dir = dirname(dir)) {
        try {
            if ((await json(join(dir, 'package.json'))).name === name)
                return dir;
        }
        catch (error) {
            if (!absent(error))
                throw error;
        }
        if (dirname(dir) === dir)
            throw new ArtifactEnvironmentError(`cannot locate ${name} from ${entry}`);
    }
}
async function localImport(root, from, specifier) {
    if (!specifier.startsWith('.'))
        return [];
    const target = resolve(dirname(from), specifier);
    const paths = [target, `${target}.js`, `${target}.ts`, `${target}.d.ts`, join(target, 'index.js'), join(target, 'index.d.ts')];
    if (target.endsWith('.js'))
        paths.push(target.slice(0, -3) + '.d.ts', target.slice(0, -3) + '.ts');
    const out = [];
    for (const path of paths) {
        const info = await stat(path);
        if (info?.isFile()) {
            if (!inside(root, await realpath(path)))
                throw new ArtifactEnvironmentError(`runtime identity path escapes ${root}: ${path}`);
            out.push(path);
        }
    }
    return out;
}
async function identify(root, name, entries) {
    root = await realpath(root);
    const manifest = await json(join(root, 'package.json'));
    if (manifest.name !== name || typeof manifest.version !== 'string')
        throw new ArtifactEnvironmentError(`wrong package at ${root}; expected ${name}`);
    const pending = [join(root, 'package.json'), ...entries];
    for (const entry of entries) {
        if (entry.endsWith('.js')) {
            const declaration = entry.slice(0, -3) + '.d.ts';
            if ((await stat(declaration))?.isFile())
                pending.push(declaration);
        }
    }
    if (typeof manifest.types === 'string')
        pending.push(resolve(root, manifest.types));
    const sources = new Map();
    while (pending.length) {
        const path = pending.pop();
        const key = portable(relative(root, path));
        if (sources.has(key))
            continue;
        if (!inside(root, await realpath(path)))
            throw new ArtifactEnvironmentError(`runtime path escapes ${root}: ${path}`);
        const bytes = await readFile(path);
        sources.set(key, bytes);
        if (sources.size > 2048)
            throw new ArtifactEnvironmentError(`runtime identity closure is too large: ${root}`);
        if (!/\.(?:[cm]?js|[cm]?ts)$/.test(path))
            continue;
        const source = bytes.toString('utf8');
        const imports = /(?:\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?|\b(?:import|require)\s*\()\s*['"]([^'"]+)['"]/g;
        for (const match of source.matchAll(imports))
            pending.push(...await localImport(root, path, match[1]));
    }
    const hash = createHash('sha256');
    const identityFiles = [];
    for (const [path, bytes] of [...sources].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
        for (const part of [Buffer.from(path), bytes]) {
            const length = Buffer.alloc(8);
            length.writeBigUInt64BE(BigInt(part.length));
            hash.update(length).update(part);
        }
        identityFiles.push({ path, sha256: digest(bytes) });
    }
    return { name, version: manifest.version, root, identityFiles, contentHash: hash.digest('hex') };
}
/** Resolve both runtime packages from the selected Playbook, never from the user's cwd. */
export async function inspectArtifactEnvironment(options = {}) {
    const own = createRequire(import.meta.url);
    const playbookRoot = options.playbookRoot
        ? await realpath(options.playbookRoot)
        : await packageRoot(own.resolve('@sublang/playbook/xstate-runtime'), '@sublang/playbook');
    const req = createRequire(join(playbookRoot, 'package.json'));
    const engineEntry = req.resolve('@sublang/playbook/xstate-runtime');
    const runtimeEntry = req.resolve('@sublang/playbook/runtime');
    const xstateEntry = req.resolve('xstate');
    const xstateRoot = await packageRoot(xstateEntry, 'xstate');
    const engine = await import(pathToFileURL(engineEntry).href);
    const supported = engine.SUPPORTED_ARTIFACT_SCHEMAS;
    if (!Number.isSafeInteger(engine.RUNTIME_ABI) || !Array.isArray(supported) || !supported.every(Number.isSafeInteger)) {
        throw new ArtifactEnvironmentError(`runtime compatibility exports unavailable at ${engineEntry}`);
    }
    const [playbook, xstate] = await Promise.all([
        identify(playbookRoot, '@sublang/playbook', [engineEntry, runtimeEntry, req.resolve('@sublang/playbook/artifact-environment')]),
        identify(xstateRoot, 'xstate', [xstateEntry]),
    ]);
    return { playbook, xstate, runtimeAbi: engine.RUNTIME_ABI, supportedArtifactSchemas: [...supported] };
}
/** Preflight every destination before mutation; directory junctions need no Windows symlink privilege. */
export async function prepareArtifactEnvironment(options) {
    const artifactDir = resolve(options.artifactDir);
    const environment = options.environment ?? await inspectArtifactEnvironment();
    for (const path of [artifactDir, join(artifactDir, 'node_modules'), join(artifactDir, 'node_modules', '@sublang')]) {
        const info = await stat(path);
        if (info && (!info.isDirectory() || info.isSymbolicLink()))
            throw new ArtifactEnvironmentError(`unsafe environment directory: ${path}`);
    }
    const metaPath = join(artifactDir, 'package.json');
    const metaInfo = await stat(metaPath);
    let previous;
    if (metaInfo) {
        if (!metaInfo.isFile() || metaInfo.isSymbolicLink() || metaInfo.nlink !== 1)
            throw new ArtifactEnvironmentError(`occupied environment metadata: ${metaPath}`);
        previous = await json(metaPath);
        if (previous[OWNER] !== 1 || previous.type !== 'module' || previous.private !== true)
            throw new ArtifactEnvironmentError(`foreign package metadata: ${metaPath}`, 'choose a separate workflow output directory');
    }
    const roots = { playbook: environment.playbook.root, xstate: environment.xstate.root };
    const priorRoots = record(previous?.[ROOTS]) ? previous[ROOTS] : {};
    const destinations = [
        { path: join(artifactDir, 'node_modules', 'xstate'), target: roots.xstate, prior: priorRoots.xstate },
        { path: join(artifactDir, 'node_modules', '@sublang', 'playbook'), target: roots.playbook, prior: priorRoots.playbook },
    ];
    const changes = [];
    for (const item of destinations) {
        const info = await stat(item.path);
        if (!info) {
            changes.push(item);
            continue;
        }
        if (!info.isSymbolicLink() || !previous || typeof item.prior !== 'string')
            throw new ArtifactEnvironmentError(`occupied runtime path: ${item.path}`);
        const old = await readlink(item.path);
        let actual;
        try {
            actual = await realpath(item.path);
        }
        catch (error) {
            if (!absent(error))
                throw error;
        }
        if (actual && same(actual, item.target))
            continue;
        if (!same(resolve(dirname(item.path), old), item.prior))
            throw new ArtifactEnvironmentError(`foreign runtime link: ${item.path}`);
        if (options.authority !== 'compiler' && !same(item.prior, item.target))
            throw new ArtifactEnvironmentError(`recorded runtime changed at ${item.path}`, 'revalidate this workflow with its compiler');
        changes.push({ ...item, old });
    }
    if (options.provision === false && (!previous || changes.length))
        throw new ArtifactEnvironmentError(`workflow environment needs preparation at ${artifactDir}`, 'enable provisioning or restore its recorded runtime');
    if (previous && !changes.length)
        return { environment, createdLinks: [] };
    const completed = [];
    try {
        for (const item of changes) {
            await mkdir(dirname(item.path), { recursive: true });
            if (item.old !== undefined)
                await unlink(item.path);
            completed.push(item);
            await symlink(item.target, item.path, process.platform === 'win32' ? 'junction' : 'dir');
        }
        await mkdir(artifactDir, { recursive: true });
        const temp = `${metaPath}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify({ private: true, type: 'module', [OWNER]: 1, [ROOTS]: roots }, null, 2) + '\n', { flag: 'wx' });
        await rename(temp, metaPath);
    }
    catch (error) {
        for (const item of completed.reverse()) {
            await unlink(item.path).catch(() => { });
            if (item.old !== undefined)
                await symlink(item.old, item.path, process.platform === 'win32' ? 'junction' : 'dir').catch(() => { });
        }
        throw new ArtifactEnvironmentError(`cannot prepare ${artifactDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { environment, createdLinks: changes.map(({ path, target }) => ({ path, target })) };
}
export async function locateBuildManifest(entryPath) {
    entryPath = resolve(entryPath);
    const source = await readFile(entryPath, 'utf8');
    const lines = source.split(/\r?\n/);
    const markers = lines.filter((line) => line.trimStart().startsWith('//') && line.includes('@sublang/slc-build-manifest'));
    if (markers.length && !markers[0].startsWith(BUILD_MANIFEST_MARKER))
        throw new ArtifactEnvironmentError(`malformed build manifest marker in ${entryPath}`);
    if (markers.length && lines.slice(0, lines.indexOf(markers[0])).some((line) => line.trim() && !line.trimStart().startsWith('//') && !line.startsWith('#!')))
        throw new ArtifactEnvironmentError(`build manifest marker follows executable code in ${entryPath}`);
    if (markers.length) {
        if (markers.length !== 1)
            throw new ArtifactEnvironmentError(`duplicate build manifest marker in ${entryPath}`);
        let value;
        try {
            value = JSON.parse(markers[0].slice(BUILD_MANIFEST_MARKER.length));
        }
        catch {
            throw new ArtifactEnvironmentError(`malformed build manifest marker in ${entryPath}`);
        }
        if (typeof value !== 'string' || isAbsolute(value))
            throw new ArtifactEnvironmentError(`invalid build manifest path in ${entryPath}`);
        const path = resolve(dirname(entryPath), value);
        if (!inside(dirname(entryPath), path) || basename(path) !== 'build-manifest.json')
            throw new ArtifactEnvironmentError(`escaping build manifest reference in ${entryPath}`);
        if (!(await stat(path))?.isFile())
            throw new ArtifactEnvironmentError(`managed build manifest is missing: ${path}`);
        return path;
    }
    for (const dir of [dirname(entryPath), join(dirname(entryPath), `${basename(entryPath, extname(entryPath))}.playbook`)]) {
        try {
            if ((await json(join(dir, 'package.json')))[OWNER] === 1)
                throw new ArtifactEnvironmentError(`managed entry has no build manifest marker: ${entryPath}`);
        }
        catch (error) {
            if (!absent(error))
                throw error;
        }
    }
    return undefined;
}
/** Runtime validation intentionally does not read Source snapshots, GEARS, tests or compiler logs. */
export async function validateArtifactManifest(entryPath) {
    entryPath = resolve(entryPath);
    const path = await locateBuildManifest(entryPath);
    if (!path)
        return undefined;
    const raw = await json(path);
    const allowed = new Set(['schema', 'entry', 'compiler', 'runtime', 'inputs', 'files', 'verification']);
    if (raw.schema !== BUILD_MANIFEST_SCHEMA || Object.keys(raw).some((key) => !allowed.has(key)) ||
        !record(raw.entry) || typeof raw.entry.path !== 'string' || isAbsolute(raw.entry.path) ||
        raw.entry.format !== (extname(entryPath) === '.mjs' ? 'esm-javascript' : 'typescript') ||
        !record(raw.compiler) || !['package', 'version', 'buildIdentity'].every((key) => typeof raw.compiler[key] === 'string') ||
        !Array.isArray(raw.inputs) || raw.inputs.some((item) => !record(item) || !['path', 'sha256', 'snapshot'].every((key) => typeof item[key] === 'string') || !/^[a-f0-9]{64}$/.test(String(item.sha256))) ||
        !record(raw.runtime) || !record(raw.runtime.playbook) || typeof raw.runtime.playbook.root !== 'string' ||
        !Array.isArray(raw.files) || !record(raw.verification) || !Array.isArray(raw.verification.checks)) {
        throw new ArtifactEnvironmentError(`invalid managed build manifest: ${path}`);
    }
    const dir = dirname(path);
    if (!same(resolve(dir, raw.entry.path), entryPath))
        throw new ArtifactEnvironmentError(`manifest entry does not match ${entryPath}`);
    const environment = await inspectArtifactEnvironment({ playbookRoot: record(raw.runtime.playbook) ? raw.runtime.playbook.root : undefined });
    for (const key of ['playbook', 'xstate']) {
        const expected = raw.runtime[key];
        const actual = environment[key];
        if (!record(expected) || expected.name !== actual.name || expected.version !== actual.version ||
            typeof expected.root !== 'string' || !same(expected.root, actual.root) || expected.contentHash !== actual.contentHash || JSON.stringify(expected.identityFiles) !== JSON.stringify(actual.identityFiles)) {
            throw new ArtifactEnvironmentError(`selected ${key} identity changed for ${entryPath}`, 'revalidate this workflow with its compiler');
        }
    }
    if (raw.runtime.runtimeAbi !== environment.runtimeAbi || !environment.supportedArtifactSchemas.includes(raw.runtime.artifactSchema))
        throw new ArtifactEnvironmentError(`incompatible runtime ABI/schema in ${path}`);
    const kinds = new Set();
    for (const item of raw.files) {
        if (!record(item) || typeof item.kind !== 'string' || typeof item.path !== 'string' || ![...RUNTIME_KINDS, 'gears', 'checker-evidence'].includes(item.kind) || typeof item.format !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))
            throw new ArtifactEnvironmentError(`invalid file record in ${path}`);
        if (!RUNTIME_KINDS.has(item.kind))
            continue;
        const file = resolve(dir, item.path);
        if (!same(file, entryPath) && !inside(dir, file))
            throw new ArtifactEnvironmentError(`runtime path escapes bundle: ${file}`);
        if (!same(file, entryPath) && !inside(await realpath(dir), await realpath(file)))
            throw new ArtifactEnvironmentError(`runtime file link escapes bundle: ${file}`);
        if (typeof item.sha256 !== 'string' || digest(await readFile(file)) !== item.sha256)
            throw new ArtifactEnvironmentError(`runtime file missing or changed: ${file}`);
        if (extname(file) === '.ts' && !process.features.typescript)
            throw new ArtifactEnvironmentError(`host cannot load TypeScript runtime file ${file}`, 'use a Node runtime supporting native TypeScript');
        kinds.add(item.kind);
    }
    if (!['entry', 'fsm', 'linked'].every((kind) => kinds.has(kind)) || raw.verification.checks.length === 0 || typeof raw.verification.attemptRecord !== 'string' || raw.verification.checks.some((check) => !record(check) || check.status !== 'passed' || typeof check.name !== 'string' || typeof check.evidence !== 'string'))
        throw new ArtifactEnvironmentError(`incomplete accepted runtime record: ${path}`);
    const runtimeFiles = raw.files.filter((item) => record(item) && RUNTIME_KINDS.has(item.kind));
    const required = (kind) => {
        const matches = runtimeFiles.filter((item) => item.kind === kind);
        if (matches.length !== 1)
            throw new ArtifactEnvironmentError(`ambiguous ${kind} runtime record: ${path}`);
        return resolve(dir, matches[0].path);
    };
    if (!same(required('entry'), entryPath))
        throw new ArtifactEnvironmentError(`entry file record does not match ${entryPath}`);
    const closure = await inspectArtifactFiles({ artifactDir: dir, entry: entryPath, fsm: required('fsm'), linked: required('linked') });
    const declared = new Map(runtimeFiles.map((item) => [item.path, item]));
    for (const item of closure)
        if (declared.get(item.path)?.sha256 !== item.sha256 || declared.get(item.path)?.format !== item.format)
            throw new ArtifactEnvironmentError(`runtime dependency missing from accepted manifest: ${item.path}`);
    for (const [specifier, expected] of [['xstate', environment.xstate], ['@sublang/playbook/xstate-runtime', environment.playbook]]) {
        const from = same(dirname(entryPath), dir) ? entryPath : join(dir, 'runtime-resolution.mjs');
        const actual = await packageRoot(createRequire(from).resolve(specifier), expected.name);
        if (!same(actual, expected.root))
            throw new ArtifactEnvironmentError(`runtime import resolves to the wrong package: ${specifier}`);
    }
    return raw;
}
/** Canonical module path for host-side configured-registry integration. */
export function artifactEntryPath(specifier) {
    return specifier.startsWith('file:') ? fileURLToPath(specifier) : resolve(specifier);
}
export { importFreshArtifact } from './fresh-artifact.js';
export { inspectArtifactFiles } from './artifact-files.js';
