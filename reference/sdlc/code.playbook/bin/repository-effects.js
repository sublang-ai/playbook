// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { hostname as systemHostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const CLAIM_SCHEMA = 1;
const CLAIM_OWNER_FILE = 'owner.json';
const CLAIM_ROOT_NAME = 'playbook-effect-claims';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CLAIM_COLLISION_CODES = new Set(['EEXIST', 'ENOTEMPTY']);

export const REPOSITORY_RECEIPT_CLASSIFICATIONS = Object.freeze([
  'unchanged',
  'one-descendant-commit',
  'multiple-commits',
  'rewritten-or-non-descendant',
  'worktree-only-change',
  'concurrent-or-foreign-change',
  'observation-ambiguous',
]);

export class RepositoryObservationAmbiguousError extends Error {
  constructor(
    message = 'repository observation changed while it was sampled',
    options,
  ) {
    super(message, options);
    this.name = 'RepositoryObservationAmbiguousError';
  }
}

function errorCode(error) {
  return typeof error === 'object' && error !== null ? error.code : undefined;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertOid(value, label) {
  if (typeof value !== 'string' || !OID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a Git commit OID`);
  }
}

function assertSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('repository claim signal must be an AbortSignal');
  }
}

function assertAllowedDispositions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('allowedDispositions must be a nonempty array');
  }
  const allowed = new Set([
    'unchanged',
    'one-descendant-commit',
    'deferred',
  ]);
  for (const disposition of value) {
    if (typeof disposition !== 'string' || !allowed.has(disposition)) {
      throw new TypeError(
        'allowedDispositions entries must be unchanged, one-descendant-commit, or deferred',
      );
    }
  }
  return Object.freeze([...new Set(value)]);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: 'buffer',
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          ...options.env,
        },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          Object.defineProperties(error, {
            stdout: { value: stdout },
            stderr: { value: stderr },
          });
          rejectPromise(error);
          return;
        }
        resolvePromise(Buffer.from(stdout));
      },
    );
  });
}

function runGit(cwd, args, options = {}) {
  return runCommand('git', ['--literal-pathspecs', ...args], {
    ...options,
    cwd,
  });
}

async function runGitText(cwd, args) {
  const raw = await runGit(cwd, args);
  const content = raw.at(-1) === 0x0a ? raw.subarray(0, -1) : raw;
  const value = content.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(content)) {
    throw new RepositoryObservationAmbiguousError(
      'Git returned text that is not lossless UTF-8',
    );
  }
  return value;
}

async function syncDirectory(path) {
  let directory;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } finally {
    await directory?.close();
  }
}

function pathInside(root, path) {
  const absolute = resolve(root, path);
  const suffix = relative(root, absolute);
  if (suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))) {
    return absolute;
  }
  throw new RepositoryObservationAmbiguousError(
    `Git reported a path outside the canonical worktree: ${JSON.stringify(path)}`,
  );
}

function splitFixedFields(record, count) {
  const fields = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const separator = record.indexOf(' ', offset);
    if (separator < 0) {
      throw new RepositoryObservationAmbiguousError(
        'Git returned a malformed porcelain-v2 record',
      );
    }
    fields.push(record.slice(offset, separator));
    offset = separator + 1;
  }
  fields.push(record.slice(offset));
  return fields;
}

function splitNulRecords(raw) {
  if (raw.length === 0) return [];
  if (raw.at(-1) !== 0) {
    throw new RepositoryObservationAmbiguousError(
      'Git returned an unterminated porcelain-v2 record',
    );
  }
  const records = [];
  let offset = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    records.push(raw.subarray(offset, index));
    offset = index + 1;
  }
  return records;
}

function decodeGitRecord(raw) {
  const value = raw.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(raw)) {
    throw new RepositoryObservationAmbiguousError(
      'Git returned a path that is not lossless UTF-8',
    );
  }
  return value;
}

function parseStatusRecords(raw) {
  const tokens = splitNulRecords(raw).map(decodeGitRecord);
  const records = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record.startsWith('? ')) {
      records.push({ kind: 'untracked', path: record.slice(2) });
      continue;
    }
    if (record.startsWith('1 ')) {
      const fields = splitFixedFields(record, 8);
      records.push({
        kind: 'ordinary',
        xy: fields[1],
        submodule: fields[2],
        headMode: fields[3],
        indexMode: fields[4],
        worktreeMode: fields[5],
        headOid: fields[6],
        indexOid: fields[7],
        path: fields[8],
      });
      continue;
    }
    if (record.startsWith('2 ')) {
      const fields = splitFixedFields(record, 9);
      const originalPath = tokens[index + 1];
      if (originalPath === undefined) {
        throw new RepositoryObservationAmbiguousError(
          'Git returned a rename without its original path',
        );
      }
      index += 1;
      records.push({
        kind: 'rename-or-copy',
        xy: fields[1],
        submodule: fields[2],
        headMode: fields[3],
        indexMode: fields[4],
        worktreeMode: fields[5],
        headOid: fields[6],
        indexOid: fields[7],
        score: fields[8],
        path: fields[9],
        originalPath,
      });
      continue;
    }
    if (record.startsWith('u ')) {
      const fields = splitFixedFields(record, 10);
      records.push({
        kind: 'unmerged',
        xy: fields[1],
        submodule: fields[2],
        stage1Mode: fields[3],
        stage2Mode: fields[4],
        stage3Mode: fields[5],
        worktreeMode: fields[6],
        stage1Oid: fields[7],
        stage2Oid: fields[8],
        stage3Oid: fields[9],
        path: fields[10],
      });
      continue;
    }
    throw new RepositoryObservationAmbiguousError(
      `Git returned an unsupported porcelain-v2 record ${JSON.stringify(record)}`,
    );
  }
  return records;
}

async function worktreePathIdentity(worktree, path, modeHint, allowMissing) {
  const absolute = pathInside(worktree, path);
  let before;
  try {
    before = await lstat(absolute, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && allowMissing) {
      return Object.freeze({ kind: 'missing' });
    }
    throw new RepositoryObservationAmbiguousError(
      `cannot inspect reported repository path: ${JSON.stringify(path)}`,
      { cause: error },
    );
  }

  let identity;
  if (before.isFile()) {
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      throw new RepositoryObservationAmbiguousError(
        `cannot read reported repository file: ${JSON.stringify(path)}`,
        { cause: error },
      );
    }
    identity = {
      kind: 'file',
      mode: (before.mode & 0o111n) === 0n ? '100644' : '100755',
      content: `sha256:${sha256(bytes)}`,
    };
  } else if (before.isSymbolicLink()) {
    let target;
    try {
      target = await readlink(absolute, { encoding: 'buffer' });
    } catch (error) {
      throw new RepositoryObservationAmbiguousError(
        `cannot read reported repository symlink: ${JSON.stringify(path)}`,
        { cause: error },
      );
    }
    identity = {
      kind: 'symlink',
      mode: '120000',
      content: `sha256:${sha256(target)}`,
    };
  } else if (before.isDirectory()) {
    let nested;
    try {
      const nestedIdentity = await resolveCanonicalGitWorktree(absolute);
      if (nestedIdentity.worktree !== (await realpath(absolute))) {
        throw new Error('directory is not a nested Git worktree root');
      }
      nested = await observeResolvedWorktree(nestedIdentity);
    } catch (error) {
      throw new RepositoryObservationAmbiguousError(
        `cannot address repository directory content: ${JSON.stringify(path)}`,
        { cause: error },
      );
    }
    identity = {
      kind: 'directory',
      mode: modeHint === '160000' ? '160000' : '040000',
      content: `sha256:${sha256(
        JSON.stringify([nested.head, nested.projectionDigest]),
      )}`,
    };
  } else {
    throw new RepositoryObservationAmbiguousError(
      `cannot address special repository path content: ${JSON.stringify(path)}`,
    );
  }

  let after;
  try {
    after = await lstat(absolute, { bigint: true });
  } catch (error) {
    throw new RepositoryObservationAmbiguousError(
      `repository path changed while sampled: ${JSON.stringify(path)}`,
      { cause: error },
    );
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new RepositoryObservationAmbiguousError(
      `repository path changed while sampled: ${JSON.stringify(path)}`,
    );
  }
  return Object.freeze(identity);
}

async function projectionFromStatus(worktree, rawStatus) {
  const records = parseStatusRecords(rawStatus);
  const entries = [];
  for (const record of records) {
    if (typeof record.path !== 'string' || record.path.length === 0) {
      throw new RepositoryObservationAmbiguousError(
        'Git returned an empty repository path',
      );
    }
    const base = { ...record };
    delete base.path;
    const needsWorktreeIdentity =
      record.kind === 'untracked' ||
      record.kind === 'unmerged' ||
      record.xy?.[1] !== '.' ||
      (record.submodule !== undefined && record.submodule !== 'N...');
    entries.push([
      record.path,
      {
        ...base,
        ...(needsWorktreeIdentity
          ? {
              worktree: await worktreePathIdentity(
                worktree,
                record.path,
                record.worktreeMode,
                record.xy?.[1] === 'D',
              ),
            }
          : {}),
      },
    ]);
  }
  entries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const projection = Object.create(null);
  for (const [path, entry] of entries) {
    if (Object.prototype.hasOwnProperty.call(projection, path)) {
      throw new RepositoryObservationAmbiguousError(
        `Git returned duplicate status for ${JSON.stringify(path)}`,
      );
    }
    projection[path] = deepFreeze(entry);
  }
  return Object.freeze(projection);
}

function projectionText(projection) {
  return JSON.stringify(projection);
}

function projectionPreservesBaseline(baseline, after) {
  return Object.entries(baseline).every(
    ([path, entry]) =>
      Object.prototype.hasOwnProperty.call(after, path) &&
      JSON.stringify(after[path]) === JSON.stringify(entry),
  );
}

async function rawRepositoryStatus(worktree) {
  return runGit(worktree, [
    '-c',
    'core.fileMode=true',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.ignoreStat=false',
    '-c',
    'core.trustctime=true',
    '-c',
    'core.checkStat=default',
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--ignored=no',
    '--ignore-submodules=none',
    '--no-renames',
  ]);
}

async function rawIndexVisibility(worktree) {
  return runGit(worktree, ['ls-files', '-v', '-z']);
}

function assertIndexVisibility(raw) {
  for (const record of splitNulRecords(raw)) {
    if (record.length < 3 || record[1] !== 0x20) {
      throw new RepositoryObservationAmbiguousError(
        'Git returned malformed index-visibility data',
      );
    }
    const tag = record[0];
    if (tag === 0x53 || (tag >= 0x61 && tag <= 0x7a)) {
      throw new RepositoryObservationAmbiguousError(
        'Git index flags suppress exact tracked-worktree observation',
      );
    }
  }
}

export async function resolveCanonicalGitWorktree(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('repository working directory must be a nonempty string');
  }
  const inside = await runGitText(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    throw new Error(`${JSON.stringify(cwd)} is not inside a Git worktree`);
  }
  const [reportedRoot, reportedGitDir] = await Promise.all([
    runGitText(cwd, ['rev-parse', '--show-toplevel']),
    runGitText(cwd, ['rev-parse', '--absolute-git-dir']),
  ]);
  const [worktree, gitDir] = await Promise.all([
    realpath(reportedRoot),
    realpath(reportedGitDir),
  ]);
  return Object.freeze({ worktree, gitDir });
}

async function observeResolvedWorktree(identity, options = {}) {
  const headBefore = await runGitText(identity.worktree, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);
  assertOid(headBefore, 'repository HEAD');
  const indexVisibilityBefore = await rawIndexVisibility(identity.worktree);
  assertIndexVisibility(indexVisibilityBefore);
  const statusBefore = await rawRepositoryStatus(identity.worktree);
  const projectionBefore = await projectionFromStatus(
    identity.worktree,
    statusBefore,
  );
  await options.afterFirstSample?.();
  const headAfter = await runGitText(identity.worktree, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);
  const indexVisibilityAfter = await rawIndexVisibility(identity.worktree);
  assertIndexVisibility(indexVisibilityAfter);
  const statusAfter = await rawRepositoryStatus(identity.worktree);
  const projectionAfter = await projectionFromStatus(
    identity.worktree,
    statusAfter,
  );
  const beforeText = projectionText(projectionBefore);
  if (
    headBefore !== headAfter ||
    !indexVisibilityBefore.equals(indexVisibilityAfter) ||
    !statusBefore.equals(statusAfter) ||
    beforeText !== projectionText(projectionAfter)
  ) {
    throw new RepositoryObservationAmbiguousError();
  }
  return deepFreeze({
    worktree: identity.worktree,
    gitDir: identity.gitDir,
    head: headBefore,
    projection: projectionBefore,
    projectionDigest: `sha256:${sha256(beforeText)}`,
  });
}

export async function observeGitRepository(cwd, options = {}) {
  const identity = await resolveCanonicalGitWorktree(cwd);
  return observeResolvedWorktree(identity, options);
}

function assertObservation(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a repository observation`);
  }
  if (typeof value.worktree !== 'string' || typeof value.gitDir !== 'string') {
    throw new TypeError(`${label} must carry canonical worktree identity`);
  }
  assertOid(value.head, `${label}.head`);
  if (!isPlainObject(value.projection)) {
    throw new TypeError(`${label}.projection must be path-keyed`);
  }
  if (
    typeof value.projectionDigest !== 'string' ||
    value.projectionDigest !== `sha256:${sha256(projectionText(value.projection))}`
  ) {
    throw new TypeError(`${label}.projectionDigest does not match its projection`);
  }
}

async function isAncestor(worktree, baselineHead, afterHead) {
  try {
    await runGit(worktree, [
      'merge-base',
      '--is-ancestor',
      baselineHead,
      afterHead,
    ]);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && error.code === 1) {
      return false;
    }
    throw error;
  }
}

async function descendantCount(worktree, baselineHead, afterHead) {
  const value = await runGitText(worktree, [
    'rev-list',
    '--count',
    `${baselineHead}..${afterHead}`,
  ]);
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RepositoryObservationAmbiguousError(
      'Git returned an invalid descendant count',
    );
  }
  return count;
}

function receipt(classification, baseline, after, commitOid) {
  return deepFreeze({
    classification,
    baseline,
    ...(after === undefined ? {} : { after }),
    ...(commitOid === undefined ? {} : { commitOid }),
  });
}

export async function classifyRepositoryReceipt(
  baseline,
  after,
  options = {},
) {
  assertObservation(baseline, 'baseline');
  assertObservation(after, 'after');
  if (baseline.worktree !== after.worktree || baseline.gitDir !== after.gitDir) {
    throw new TypeError('repository observations name different worktrees');
  }
  const allowed = assertAllowedDispositions(options.allowedDispositions);
  const sameProjection =
    baseline.projectionDigest === after.projectionDigest &&
    projectionText(baseline.projection) === projectionText(after.projection);
  const sameHead = baseline.head === after.head;
  if (sameHead && sameProjection) {
    return receipt('unchanged', baseline, after);
  }
  if (options.cohort === true) {
    return receipt('observation-ambiguous', baseline, after);
  }
  if (allowed.every((value) => value === 'unchanged')) {
    return receipt('concurrent-or-foreign-change', baseline, after);
  }
  if (sameHead) {
    if (!projectionPreservesBaseline(baseline.projection, after.projection)) {
      return receipt('observation-ambiguous', baseline, after);
    }
    return receipt(
      allowed.includes('one-descendant-commit')
        ? 'worktree-only-change'
        : 'observation-ambiguous',
      baseline,
      after,
    );
  }
  if (!(await isAncestor(after.worktree, baseline.head, after.head))) {
    return receipt('rewritten-or-non-descendant', baseline, after);
  }
  const count = await descendantCount(after.worktree, baseline.head, after.head);
  if (count > 1) return receipt('multiple-commits', baseline, after);
  if (count !== 1) {
    return receipt('rewritten-or-non-descendant', baseline, after);
  }
  if (!sameProjection) {
    return receipt('observation-ambiguous', baseline, after);
  }
  return receipt('one-descendant-commit', baseline, after, after.head);
}

export async function captureRepositoryReceipt(baseline, options = {}) {
  assertObservation(baseline, 'baseline');
  try {
    const after = await observeResolvedWorktree(
      Object.freeze({
        worktree: baseline.worktree,
        gitDir: baseline.gitDir,
      }),
      options.observation,
    );
    return classifyRepositoryReceipt(baseline, after, options);
  } catch (error) {
    if (error instanceof RepositoryObservationAmbiguousError) {
      return receipt('observation-ambiguous', baseline);
    }
    throw error;
  }
}

function ownerPath(activePath) {
  return join(activePath, CLAIM_OWNER_FILE);
}

function assertOwnerShape(value) {
  if (!isPlainObject(value)) {
    throw new Error('repository claim owner must be an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'hostname,ownerToken,pid,schema') {
    throw new Error('repository claim owner has malformed members');
  }
  if (value.schema !== CLAIM_SCHEMA) {
    throw new Error('repository claim owner schema is not supported');
  }
  if (typeof value.ownerToken !== 'string' || !UUID_PATTERN.test(value.ownerToken)) {
    throw new Error('repository claim owner token is malformed');
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error('repository claim owner PID is malformed');
  }
  if (typeof value.hostname !== 'string' || value.hostname.length === 0) {
    throw new Error('repository claim owner hostname is malformed');
  }
  return Object.freeze({ ...value });
}

async function assertPrivateDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a private directory`);
  }
  if ((info.mode & 0o7777) !== 0o700) {
    throw new Error(`${label} permissions must be 0700`);
  }
  return info;
}

async function ensureClaimRoot(path) {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  if (created) {
    await chmod(path, 0o700);
    await syncDirectory(resolve(path, '..'));
  }
  await assertPrivateDirectory(path, 'repository claim root');
}

async function readClaimOwner(activePath) {
  await assertPrivateDirectory(activePath, 'repository active claim');
  const names = await readdir(activePath);
  if (names.length !== 1 || names[0] !== CLAIM_OWNER_FILE) {
    throw new Error('repository active claim has malformed contents');
  }
  const filePath = ownerPath(activePath);
  const pathInfo = await lstat(filePath);
  if (
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    (pathInfo.mode & 0o7777) !== 0o600
  ) {
    throw new Error('repository claim owner is not a private regular file');
  }
  let handle;
  let source;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o7777) !== 0o600 ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino
    ) {
      throw new Error('repository claim owner changed during validation');
    }
    source = await handle.readFile('utf8');
  } finally {
    await handle?.close();
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error('repository claim owner is malformed JSON', { cause: error });
  }
  return assertOwnerShape(parsed);
}

async function createClaimStage(root, owner) {
  const stagePath = join(root, `.stage-${owner.ownerToken}`);
  await mkdir(stagePath, { mode: 0o700 });
  await chmod(stagePath, 0o700);
  let handle;
  try {
    handle = await open(ownerPath(stagePath), 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(stagePath);
    return stagePath;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function defaultProbeProcess(pid) {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'dead';
    if (errorCode(error) === 'EPERM') return 'unknown';
    throw error;
  }
}

function waitForRetry(milliseconds, signal) {
  assertSignal(signal);
  if (signal?.aborted) return Promise.reject(signal.reason);
  let timeout;
  let onAbort;
  return new Promise((resolvePromise, rejectPromise) => {
    const settle = () => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    };
    timeout = setTimeout(settle, milliseconds);
    onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      rejectPromise(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal !== undefined) {
      void Promise.resolve().then(() => {
        if (signal.aborted) onAbort();
      });
    }
  });
}

async function retireClaim(root, activePath, owner) {
  const retiredPath = join(root, `retired-${owner.ownerToken}`);
  try {
    await rename(activePath, retiredPath);
  } catch (error) {
    if (CLAIM_COLLISION_CODES.has(errorCode(error))) return false;
    throw error;
  }
  const retired = await readClaimOwner(retiredPath);
  if (retired.ownerToken !== owner.ownerToken) {
    throw new Error('repository retired claim owner token changed');
  }
  await syncDirectory(root);
  return true;
}

async function assertOwnerTokenAvailable(root, ownerToken) {
  try {
    await lstat(join(root, `retired-${ownerToken}`));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new Error('repository claim owner token was already retired');
}

function sameOrderedSet(left, right) {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function validateCohort(options) {
  if (typeof options.invocationId !== 'string' || options.invocationId.length === 0) {
    throw new TypeError('cohort invocationId must be a nonempty string');
  }
  const roleIds = options.roleIds;
  if (
    !Array.isArray(roleIds) ||
    roleIds.length < 2 ||
    roleIds.some((role) => typeof role !== 'string' || role.length === 0) ||
    new Set(roleIds).size !== roleIds.length
  ) {
    throw new TypeError('cohort roleIds must be distinct nonempty strings');
  }
  if (
    !Array.isArray(options.concurrentRoleSets) ||
    !options.concurrentRoleSets.some(
      (candidate) => Array.isArray(candidate) && sameOrderedSet(candidate, roleIds),
    )
  ) {
    throw new TypeError('cohort roleIds are not one declared concurrent role set');
  }
  if (!isPlainObject(options.dispositionsByRole)) {
    throw new TypeError('cohort dispositionsByRole must be an object');
  }
  if (!isPlainObject(options.operations)) {
    throw new TypeError('cohort operations must be an object');
  }
  const dispositionKeys = Object.keys(options.dispositionsByRole).sort();
  const operationKeys = Object.keys(options.operations).sort();
  const expected = [...roleIds].sort();
  if (
    !sameOrderedSet(dispositionKeys, expected) ||
    !sameOrderedSet(operationKeys, expected)
  ) {
    throw new TypeError('cohort members must exactly match roles, dispositions, and operations');
  }
  for (const role of roleIds) {
    const dispositions = assertAllowedDispositions(options.dispositionsByRole[role]);
    if (!dispositions.every((value) => value === 'unchanged')) {
      throw new TypeError('cohort roles must declare exclusively unchanged outcomes');
    }
    if (typeof options.operations[role] !== 'function') {
      throw new TypeError(`cohort operation ${role} must be a function`);
    }
  }
  return Object.freeze([...roleIds]);
}

export function createRepositoryEffectCoordinator(options = {}) {
  const currentHostname = options.hostname ?? systemHostname();
  const currentPid = options.pid ?? process.pid;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const probeProcess = options.probeProcess ?? defaultProbeProcess;
  const createOwnerToken = options.createOwnerToken ?? randomUUID;
  const afterClaimPublished = options._testAfterClaimPublished;
  if (typeof currentHostname !== 'string' || currentHostname.length === 0) {
    throw new TypeError('repository coordinator hostname must be nonempty');
  }
  if (!Number.isSafeInteger(currentPid) || currentPid <= 0) {
    throw new TypeError('repository coordinator PID must be positive');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError('repository coordinator poll interval must be nonnegative');
  }
  if (typeof probeProcess !== 'function') {
    throw new TypeError('repository coordinator process probe must be a function');
  }
  if (typeof createOwnerToken !== 'function') {
    throw new TypeError('repository coordinator owner-token generator must be a function');
  }
  if (
    afterClaimPublished !== undefined &&
    typeof afterClaimPublished !== 'function'
  ) {
    throw new TypeError('repository coordinator publication hook must be a function');
  }

  const acquire = async (cwd, claimOptions = {}) => {
    assertSignal(claimOptions.signal);
    const identity = await resolveCanonicalGitWorktree(cwd);
    const root = join(identity.gitDir, CLAIM_ROOT_NAME);
    await ensureClaimRoot(root);
    const activePath = join(root, 'active');
    const ownerToken = createOwnerToken();
    if (typeof ownerToken !== 'string' || !UUID_PATTERN.test(ownerToken)) {
      throw new TypeError('repository coordinator owner-token generator returned an invalid token');
    }
    const owner = Object.freeze({
      schema: CLAIM_SCHEMA,
      ownerToken,
      pid: currentPid,
      hostname: currentHostname,
    });

    while (true) {
      if (claimOptions.signal?.aborted) throw claimOptions.signal.reason;
      let activeOwner;
      try {
        activeOwner = await readClaimOwner(activePath);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      if (activeOwner !== undefined) {
        if (activeOwner.ownerToken === owner.ownerToken) {
          throw new Error('repository claim owner token was reused');
        }
        if (activeOwner.hostname !== currentHostname) {
          throw new Error(
            `repository claim is owned by foreign host ${JSON.stringify(activeOwner.hostname)}`,
          );
        }
        const state = await probeProcess(activeOwner.pid);
        if (state === 'unknown') {
          throw new Error('repository claim owner process cannot be ruled dead');
        }
        if (state === 'live') {
          await waitForRetry(pollIntervalMs, claimOptions.signal);
          continue;
        }
        if (state !== 'dead') {
          throw new Error('repository process probe returned an invalid state');
        }
        if (!(await retireClaim(root, activePath, activeOwner))) continue;
        continue;
      }

      await assertOwnerTokenAvailable(root, owner.ownerToken);
      const stagePath = await createClaimStage(root, owner);
      let published = false;
      try {
        try {
          await rename(stagePath, activePath);
          published = true;
        } catch (error) {
          if (CLAIM_COLLISION_CODES.has(errorCode(error))) {
            await rm(stagePath, { recursive: true, force: true });
            continue;
          }
          throw error;
        }
        await afterClaimPublished?.({ activePath, identity, owner });
        await syncDirectory(root);
        const publishedOwner = await readClaimOwner(activePath);
        if (publishedOwner.ownerToken !== owner.ownerToken) {
          throw new Error('repository claim owner token changed during publication');
        }
      } catch (error) {
        let cleanupError;
        try {
          if (published) {
            const activeOwner = await readClaimOwner(activePath);
            if (activeOwner.ownerToken !== owner.ownerToken) {
              throw new Error(
                'repository claim owner changed before failed publication cleanup',
              );
            }
            if (!(await retireClaim(root, activePath, owner))) {
              throw new Error(
                'repository claim could not retire after publication failure',
              );
            }
          } else {
            await rm(stagePath, { recursive: true, force: true });
          }
        } catch (cleanupCause) {
          cleanupError = cleanupCause;
        }
        if (cleanupError !== undefined) {
          throw new AggregateError(
            [error, cleanupError],
            'repository claim publication failed and ownership could not be retired',
          );
        }
        throw error;
      }
      break;
    }

    let released = false;
    let operationInProgress = false;
    const assertOwnerUnserialized = async () => {
      if (released) throw new Error('repository claim was already released');
      const activeOwner = await readClaimOwner(activePath);
      if (activeOwner.ownerToken !== owner.ownerToken) {
        throw new Error('repository claim is owned by a different token');
      }
    };
    const runClaimOperation = async (operation) => {
      if (released) throw new Error('repository claim was already released');
      if (operationInProgress) {
        throw new Error('repository claim operation is already in progress');
      }
      operationInProgress = true;
      try {
        return await operation();
      } finally {
        operationInProgress = false;
      }
    };
    const assertOwner = () => runClaimOperation(assertOwnerUnserialized);
    const observe = (observationOptions = {}) =>
      runClaimOperation(async () => {
        await assertOwnerUnserialized();
        const observation = await observeResolvedWorktree(
          identity,
          observationOptions,
        );
        await assertOwnerUnserialized();
        return observation;
      });
    const capture = (baseline, receiptOptions = {}) =>
      runClaimOperation(async () => {
        await assertOwnerUnserialized();
        assertObservation(baseline, 'baseline');
        if (
          baseline.worktree !== identity.worktree ||
          baseline.gitDir !== identity.gitDir
        ) {
          throw new TypeError(
            'repository receipt baseline does not match the active claim',
          );
        }
        const result = await captureRepositoryReceipt(baseline, receiptOptions);
        await assertOwnerUnserialized();
        return result;
      });
    const release = () =>
      runClaimOperation(async () => {
        await assertOwnerUnserialized();
        if (!(await retireClaim(root, activePath, owner))) {
          throw new Error('repository claim retirement target is occupied');
        }
        released = true;
      });
    return Object.freeze({
      identity,
      ownerToken: owner.ownerToken,
      assertOwner,
      observe,
      capture,
      release,
    });
  };

  const runExclusive = async (runOptions) => {
    if (!isPlainObject(runOptions) || typeof runOptions.operation !== 'function') {
      throw new TypeError('exclusive repository operation must be a function');
    }
    const allowedDispositions = assertAllowedDispositions(
      runOptions.allowedDispositions,
    );
    const claim = await acquire(runOptions.cwd, { signal: runOptions.signal });
    let primaryError;
    try {
      const baseline = await claim.observe(runOptions.observation);
      let operation;
      try {
        operation = Object.freeze({
          status: 'fulfilled',
          value: await runOptions.operation({
            baseline,
            identity: claim.identity,
          }),
        });
      } catch (error) {
        operation = Object.freeze({ status: 'rejected', reason: error });
      }
      const effectReceipt = await claim.capture(baseline, {
        allowedDispositions,
        observation: runOptions.afterObservation,
      });
      return Object.freeze({ baseline, operation, receipt: effectReceipt });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await claim.release();
      } catch (releaseError) {
        if (primaryError === undefined) throw releaseError;
        throw new AggregateError(
          [primaryError, releaseError],
          'repository operation failed and its claim could not be released',
        );
      }
    }
  };

  const runCohort = async (runOptions) => {
    if (!isPlainObject(runOptions)) {
      throw new TypeError('repository cohort options must be an object');
    }
    const roleIds = validateCohort(runOptions);
    const claim = await acquire(runOptions.cwd, { signal: runOptions.signal });
    let primaryError;
    try {
      const baseline = await claim.observe(runOptions.observation);
      const settled = await Promise.allSettled(
        roleIds.map((roleId) =>
          Promise.resolve().then(() =>
            runOptions.operations[roleId]({
              baseline,
              identity: claim.identity,
              invocationId: runOptions.invocationId,
              roleId,
            }),
          ),
        ),
      );
      const effectReceipt = await claim.capture(baseline, {
        allowedDispositions: ['unchanged'],
        cohort: true,
        observation: runOptions.afterObservation,
      });
      const operations = Object.create(null);
      const receipts = Object.create(null);
      for (const [index, roleId] of roleIds.entries()) {
        operations[roleId] = settled[index];
        receipts[roleId] = effectReceipt;
      }
      return Object.freeze({
        baseline,
        invocationId: runOptions.invocationId,
        operations: Object.freeze(operations),
        receipts: Object.freeze(receipts),
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await claim.release();
      } catch (releaseError) {
        if (primaryError === undefined) throw releaseError;
        throw new AggregateError(
          [primaryError, releaseError],
          'repository cohort failed and its claim could not be released',
        );
      }
    }
  };

  return Object.freeze({ acquire, runExclusive, runCohort });
}

export const _internal = Object.freeze({
  claimRootName: CLAIM_ROOT_NAME,
});
