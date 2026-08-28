// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-23: durable headless Captain sessions use one exact settled/uncertain
// record union and one exclusive, crash-recoverable lease per logical session.
// PBCLI-53: a fresh lease may move its newest same-directory predecessor's
// complete retained-generation map under guarded source-first publication.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { homedir, hostname as systemHostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertSupportedEffort } from '@sublang/cligent';
import { KNOWN_PLAYER_ADAPTERS } from '@sublang/cligent/tmux-play';
import {
  assertPlaybookRuntimeSnapshot,
  snapshotJsonValue,
} from '../../../../src/xstate-runtime.js';
import { assertPlaybookCaptainShellSnapshot } from '../playbook-captain.js';

export const CAPTAIN_SESSION_RECORD_SCHEMA_VERSION = 3;
export const CAPTAIN_SESSION_RECORD_KIND = 'captain-session';
// The interrupted retention change emitted this compatible required-member
// shape before canonical writes returned to additive schema 3.
const COMPATIBLE_RETENTION_RECORD_SCHEMA_VERSION = 4;
export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CAPTAIN_SESSION_STRUCTURAL_PROJECTION_SCHEMA_VERSION = 1;
export const CAPTAIN_SESSION_EXECUTION_PROJECTION_SCHEMA_VERSION = 2;

const PLAYER_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const RESERVED_ID = 'captain';
const KNOWN_ADAPTERS = new Set(KNOWN_PLAYER_ADAPTERS);

const COMMON_RECORD_KEYS = [
  'schemaVersion',
  'kind',
  'state',
  'sessionId',
  'createdAt',
  'updatedAt',
  'cwd',
  'structuralProjection',
  'lastAppliedExecutionProjection',
  'snapshot',
];
const UNCERTAIN_KEYS = [
  'baseUpdatedAt',
  'input',
  'attemptId',
  'attemptNumber',
  'markedAt',
  'attemptedExecutionProjection',
];
const RELEASED_SCHEMA_2_COMMON_RECORD_KEYS = [
  'schemaVersion',
  'kind',
  'state',
  'sessionId',
  'createdAt',
  'updatedAt',
  'cwd',
  'config',
  'snapshot',
];
const RELEASED_SCHEMA_2_UNCERTAIN_KEYS = [
  'baseUpdatedAt',
  'input',
  'attemptId',
  'attemptNumber',
  'markedAt',
];
const LEASE_SCHEMA_VERSION = 1;
const LEASE_KIND = 'captain-session-lease';
const LEASE_OWNER_FILE = 'owner.json';
const LEASE_OWNER_KEYS = [
  'schemaVersion',
  'kind',
  'sessionId',
  'ownerToken',
  'pid',
  'hostname',
  'acquiredAt',
];
const DEFAULT_FS_OPERATIONS = Object.freeze({
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
});

class CaptainSessionRecordSchemaError extends Error {
  constructor(schemaVersion, message, cause) {
    super(message);
    this.name = 'CaptainSessionRecordSchemaError';
    this.schemaVersion = schemaVersion;
    this.cause = cause;
  }
}

class CaptainSessionLeaseActiveError extends Error {
  constructor(sessionId, pid) {
    super(
      `cannot acquire Captain session ${JSON.stringify(sessionId)} lease: Captain session lease is active in process ${pid}`,
    );
    this.name = 'CaptainSessionLeaseActiveError';
    this.sessionId = sessionId;
    this.pid = pid;
  }
}

export function defaultCaptainSessionsDir(
  env = process.env,
  home = env.HOME ?? homedir(),
) {
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return join(stateHome, 'playbook', 'sessions');
}

export function createCaptainSessionStore(options = {}) {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const sessionsDir =
    options.sessionsDir ?? defaultCaptainSessionsDir(env, home);
  const now = options.now ?? (() => new Date());
  const createTempId = options.createTempId ?? randomUUID;
  const createLeaseToken = options.createLeaseToken ?? randomUUID;
  const localHostname = options.hostname ?? systemHostname();
  const localPid = options.pid ?? process.pid;
  const probeProcess =
    options.probeProcess ?? ((pid) => process.kill(pid, 0));
  const fs = { ...DEFAULT_FS_OPERATIONS, ...(options.fsOps ?? {}) };

  if (!isAbsolute(sessionsDir)) {
    throw new Error('Captain session store path must be absolute');
  }
  if (
    typeof localHostname !== 'string' ||
    localHostname.trim().length === 0
  ) {
    throw new Error('Captain session lease hostname must be a non-empty string');
  }
  if (!Number.isSafeInteger(localPid) || localPid <= 0) {
    throw new Error('Captain session lease pid must be a positive integer');
  }
  if (typeof probeProcess !== 'function') {
    throw new Error('Captain session process probe must be a function');
  }

  const recordPathFor = (sessionId) => {
    assertSessionId(sessionId);
    return join(sessionsDir, `${sessionId}.json`);
  };
  const leasePathFor = (sessionId) => {
    assertSessionId(sessionId);
    return join(sessionsDir, `.${sessionId}.lock`);
  };
  const retiredPathFor = (sessionId, ownerToken) => {
    assertSessionId(sessionId);
    assertUuid(ownerToken, 'Captain session lease owner token');
    return join(sessionsDir, `.${sessionId}.lock.retired.${ownerToken}`);
  };

  const readRecord = async (sessionId, { missing = 'error' } = {}) => {
    const path = recordPathFor(sessionId);
    let text;
    try {
      await assertPrivateDirectory(sessionsDir, fs);
      text = await readPrivateRegularFile(path, 0o600, fs, 'record');
    } catch (cause) {
      if (cause?.code === 'ENOENT' && missing === 'undefined') return undefined;
      if (cause?.code === 'ENOENT') {
        throw new Error(
          `Captain session ${JSON.stringify(sessionId)} at ${JSON.stringify(path)} does not exist`,
        );
      }
      throw new Error(
        `cannot read Captain session ${JSON.stringify(sessionId)} at ${JSON.stringify(path)}: ${errorMessage(cause)}`,
      );
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `Captain session ${JSON.stringify(sessionId)} at ${JSON.stringify(path)} is not valid JSON: ${errorMessage(cause)}`,
      );
    }
    let record;
    try {
      record = validateCaptainSessionRecord(value);
    } catch (cause) {
      const context =
        `Captain session ${JSON.stringify(sessionId)} at ` +
        `${JSON.stringify(path)}`;
      if (cause instanceof CaptainSessionRecordSchemaError) {
        if (
          cause.schemaVersion === 2 &&
          value.sessionId !== sessionId
        ) {
          throw new Error(
            `Captain session file ${JSON.stringify(path)} contains record ` +
              JSON.stringify(value.sessionId),
          );
        }
        throw new CaptainSessionRecordSchemaError(
          cause.schemaVersion,
          `${context}: ${cause.message}`,
          cause,
        );
      }
      throw new Error(`${context} is invalid: ${errorMessage(cause)}`, {
        cause,
      });
    }
    if (record.sessionId !== sessionId) {
      throw new Error(
        `Captain session file ${JSON.stringify(path)} contains record ` +
          JSON.stringify(record.sessionId),
      );
    }
    return record;
  };

  const read = (sessionId) => readRecord(sessionId);

  const listRecords = async ({ onLegacyRecord } = {}) => {
    if (
      onLegacyRecord !== undefined &&
      typeof onLegacyRecord !== 'function'
    ) {
      throw new Error(
        'Captain session legacy-record observer must be a function',
      );
    }
    let names;
    try {
      await assertPrivateDirectory(sessionsDir, fs);
      names = await fs.readdir(sessionsDir);
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        return [];
      }
      throw new Error(`cannot list Captain sessions: ${errorMessage(cause)}`);
    }
    const candidates = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const sessionId = name.slice(0, -'.json'.length);
      if (!SESSION_ID_PATTERN.test(sessionId)) continue;
      // Canonically named records are store-owned. Corruption must not make
      // --continue silently select an older logical session.
      try {
        candidates.push(await readRecord(sessionId));
      } catch (error) {
        if (
          error instanceof CaptainSessionRecordSchemaError &&
          error.schemaVersion === 2
        ) {
          await onLegacyRecord?.(
            Object.freeze({
              sessionId,
              path: recordPathFor(sessionId),
              schemaVersion: error.schemaVersion,
            }),
          );
          continue;
        }
        throw error;
      }
    }
    return candidates;
  };

  const latest = async ({ onLegacyRecord } = {}) => {
    const candidates = sortCaptainSessionRecords(
      await listRecords({ onLegacyRecord }),
    );
    if (candidates.length === 0) {
      throw new Error('no resumable Captain session exists');
    }
    return candidates[0];
  };

  const selectAdoptionPredecessor = async (
    target,
    { onLegacyRecord } = {},
  ) =>
    sortCaptainSessionRecords(
      (await listRecords({ onLegacyRecord })).filter(
        (candidate) =>
          candidate.sessionId !== target.sessionId &&
          candidate.state === 'settled' &&
          candidate.cwd === target.cwd,
      ),
    )[0];

  const writeRecord = async (
    recordValue,
    { noReplace, onPublished },
  ) => {
    const record = validateCaptainSessionRecord(recordValue);
    const destination = recordPathFor(record.sessionId);
    await ensurePrivateDirectory(sessionsDir, fs);

    if (noReplace) {
      await assertPathMissing(
        destination,
        fs,
        `Captain session ${JSON.stringify(record.sessionId)} already exists`,
      );
    } else {
      await assertPrivateRegularPath(destination, 0o600, fs, 'record');
    }

    const tempId = createTempId();
    assertUuid(tempId, 'Captain session temporary id');
    const temporary = join(
      sessionsDir,
      `.${record.sessionId}.${localPid}.${tempId}.tmp`,
    );
    let handle;
    let ownsTemporary = false;
    let published = false;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      ownsTemporary = true;
      await handle.chmod(0o600);
      const tempStat = await handle.stat();
      if (!tempStat.isFile() || (tempStat.mode & 0o7777) !== 0o600) {
        throw new Error('Captain session temporary path is not a private regular file');
      }
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;

      if (noReplace) {
        try {
          await fs.link(temporary, destination);
          published = true;
          onPublished?.();
        } catch (cause) {
          if (cause?.code === 'EEXIST') {
            throw new Error(
              `Captain session ${JSON.stringify(record.sessionId)} already exists`,
            );
          }
          throw cause;
        }
        // Once the no-replace link exists, failure to remove the ignored temp
        // name cannot make the logical publication fail or become ambiguous.
        try {
          await fs.unlink(temporary);
          ownsTemporary = false;
        } catch {
          // Leave only this unpredictable store-owned temp path behind.
        }
      } else {
        await fs.rename(temporary, destination);
        ownsTemporary = false;
        published = true;
        onPublished?.();
      }
      await syncDirectory(sessionsDir, fs);
      return record;
    } catch (cause) {
      try {
        await handle?.close();
      } catch {
        // Preserve the persistence failure.
      }
      if (ownsTemporary && !published) {
        try {
          await fs.unlink(temporary);
        } catch {
          // Preserve the persistence failure and never broaden cleanup.
        }
      }
      throw cause;
    }
  };

  const deleteRecord = async (sessionId) => {
    const path = recordPathFor(sessionId);
    await assertPrivateRegularPath(path, 0o600, fs, 'record');
    await fs.unlink(path);
    await syncDirectory(sessionsDir, fs);
  };

  const readLeaseDirectory = async (
    sessionId,
    path,
    expectedNames,
  ) => {
    let text;
    try {
      const directoryStat = await fs.lstat(path);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        (directoryStat.mode & 0o7777) !== 0o700
      ) {
        throw new Error('lease path is not a private real directory');
      }
      const names = (await fs.readdir(path)).sort();
      if (
        names.length !== expectedNames.length ||
        expectedNames.some((name, index) => names[index] !== name)
      ) {
        throw new Error('lease directory is incomplete or malformed');
      }
      text = await readPrivateRegularFile(
        join(path, LEASE_OWNER_FILE),
        0o600,
        fs,
        'lease owner',
      );
    } catch (cause) {
      if (cause?.code === 'ENOENT') throw cause;
      throw new Error(
        `cannot inspect Captain session lease: ${errorMessage(cause)}`,
      );
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `Captain session lease owner is not valid JSON: ${errorMessage(cause)}`,
      );
    }
    const owner = validateLeaseOwner(value);
    if (owner.sessionId !== sessionId) {
      throw new Error('Captain session lease owner id does not match its path');
    }
    return owner;
  };

  const readLeaseOwner = (sessionId, path = leasePathFor(sessionId)) =>
    readLeaseDirectory(sessionId, path, [LEASE_OWNER_FILE]);

  const readRetiredLease = async (sessionId, path, expectedToken) => {
    const owner = await readLeaseDirectory(
      sessionId,
      path,
      [LEASE_OWNER_FILE],
    );
    if (owner.ownerToken !== expectedToken) {
      throw new Error('Captain session retired lease owner token is mismatched');
    }
    return owner;
  };

  const validateRetiredLeases = async (sessionId) => {
    const prefix = `.${sessionId}.lock.retired`;
    const exactPrefix = `${prefix}.`;
    const names = await fs.readdir(sessionsDir);
    for (const name of names.sort()) {
      if (!name.startsWith(prefix)) continue;
      if (!name.startsWith(exactPrefix)) {
        throw new Error('Captain session retired lease name is malformed');
      }
      const ownerToken = name.slice(exactPrefix.length);
      assertUuid(ownerToken, 'Captain session retired lease token');
      await readRetiredLease(
        sessionId,
        join(sessionsDir, name),
        ownerToken,
      );
    }
  };

  const cleanOwnStage = async (stagePath) => {
    try {
      const ownerPath = join(stagePath, LEASE_OWNER_FILE);
      let ownerStat;
      try {
        ownerStat = await fs.lstat(ownerPath);
      } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause;
      }
      if (
        ownerStat !== undefined &&
        !ownerStat.isSymbolicLink() &&
        ownerStat.isFile()
      ) {
        await fs.unlink(ownerPath);
      }
      await fs.rmdir(stagePath);
    } catch {
      // Preserve the acquisition failure. Never scan or broaden cleanup.
    }
  };

  const makeLeaseStage = async (sessionId) => {
    await ensurePrivateDirectory(sessionsDir, fs);
    const ownerToken = createLeaseToken();
    assertUuid(ownerToken, 'Captain session lease owner token');
    const retiredPath = retiredPathFor(sessionId, ownerToken);
    await assertPathMissing(
      retiredPath,
      fs,
      'Captain session lease owner token was already retired',
    );
    const stagePath = join(
      sessionsDir,
      `.${sessionId}.lock.stage.${ownerToken}`,
    );
    await assertPathMissing(
      stagePath,
      fs,
      'Captain session lease owner token is already staged',
    );
    const owner = validateLeaseOwner({
      schemaVersion: LEASE_SCHEMA_VERSION,
      kind: LEASE_KIND,
      sessionId,
      ownerToken,
      pid: localPid,
      hostname: localHostname,
      acquiredAt: timestampFrom(now(), 'lease timestamp'),
    });
    let handle;
    let created = false;
    try {
      await fs.mkdir(stagePath, { mode: 0o700 });
      created = true;
      await fs.chmod(stagePath, 0o700);
      const stageStat = await fs.lstat(stagePath);
      if (
        stageStat.isSymbolicLink() ||
        !stageStat.isDirectory() ||
        (stageStat.mode & 0o7777) !== 0o700
      ) {
        throw new Error('Captain session lease stage is not a private directory');
      }
      handle = await fs.open(join(stagePath, LEASE_OWNER_FILE), 'wx', 0o600);
      await handle.chmod(0o600);
      const ownerStat = await handle.stat();
      if (!ownerStat.isFile() || (ownerStat.mode & 0o7777) !== 0o600) {
        throw new Error('Captain session lease owner is not a private regular file');
      }
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(stagePath, fs);
      return { owner, stagePath };
    } catch (cause) {
      try {
        await handle?.close();
      } catch {
        // Preserve the stage failure.
      }
      if (created) await cleanOwnStage(stagePath);
      throw cause;
    }
  };

  const retireObservedLease = async (sessionId, observedOwner) => {
    const owner = validateLeaseOwner(observedOwner);
    if (owner.sessionId !== sessionId) {
      throw new Error('Captain session lease owner id changed before retirement');
    }
    const canonicalPath = leasePathFor(sessionId);
    const retiredPath = retiredPathFor(sessionId, owner.ownerToken);
    await assertPathMissing(
      retiredPath,
      fs,
      'Captain session lease retired path is already occupied',
    );
    try {
      await fs.rename(canonicalPath, retiredPath);
    } catch (cause) {
      throw new Error(
        `Captain session lease changed before retirement: ${errorMessage(cause)}`,
      );
    }
    const retiredOwner = await readLeaseDirectory(
      sessionId,
      retiredPath,
      [LEASE_OWNER_FILE],
    );
    if (retiredOwner.ownerToken !== owner.ownerToken) {
      throw new Error('Captain session retired lease owner token changed');
    }
    await syncDirectory(sessionsDir, fs);
    return retiredPath;
  };

  const publishLeaseStage = async (sessionId, stage, onRenamed) => {
    const canonicalPath = leasePathFor(sessionId);
    await validateRetiredLeases(sessionId);
    await assertPathMissing(
      canonicalPath,
      fs,
      'Captain session lease became active before publication',
    );
    try {
      // Program-created canonical lease directories are nonempty. Therefore a
      // racing rename cannot replace one; it fails closed instead. Static empty
      // or malformed destinations are rejected by the preflight above.
      await fs.rename(stage.stagePath, canonicalPath);
      onRenamed();
    } catch (cause) {
      throw new Error(
        `Captain session lease publication lost its race: ${errorMessage(cause)}`,
      );
    }
    await syncDirectory(sessionsDir, fs);
    const publishedOwner = await readLeaseOwner(sessionId);
    if (publishedOwner.ownerToken !== stage.owner.ownerToken) {
      throw new Error('Captain session lease publication owner token changed');
    }
    return publishedOwner;
  };

  const acquire = async (sessionId) => {
    assertSessionId(sessionId);
    let stage;
    let stagePublished = false;
    try {
      stage = await makeLeaseStage(sessionId);
      const canonicalPath = leasePathFor(sessionId);
      let existing;
      try {
        existing = await readLeaseOwner(sessionId);
      } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause;
      }

      if (existing !== undefined) {
        if (existing.ownerToken === stage.owner.ownerToken) {
          throw new Error('Captain session lease owner token was reused');
        }
        if (existing.hostname !== localHostname) {
          throw new Error(
            `Captain session lease is owned by foreign host ${JSON.stringify(existing.hostname)}`,
          );
        }
        try {
          await probeProcess(existing.pid);
          throw new CaptainSessionLeaseActiveError(
            sessionId,
            existing.pid,
          );
        } catch (cause) {
          if (cause?.code !== 'ESRCH') {
            if (cause instanceof CaptainSessionLeaseActiveError) throw cause;
            throw new Error(
              `Captain session lease owner process cannot be ruled dead: ${errorMessage(cause)}`,
            );
          }
        }
        await retireObservedLease(sessionId, existing);
      } else {
        // Preserve the explicit local solely for easier audit of the no-owner
        // publication boundary.
        void canonicalPath;
      }

      await publishLeaseStage(sessionId, stage, () => {
        stagePublished = true;
      });
      return createLease({
        sessionId,
        owner: stage.owner,
        readRecord,
        writeRecord,
        deleteRecord,
        selectAdoptionPredecessor,
        acquireSession: acquire,
        readLeaseOwner,
        retireObservedLease,
        validateRetiredLeases,
        now,
      });
    } catch (cause) {
      let cleanupError;
      if (stage !== undefined && stagePublished) {
        try {
          const current = await readLeaseOwner(sessionId);
          if (current.ownerToken === stage.owner.ownerToken) {
            await retireObservedLease(sessionId, current);
          }
        } catch (error) {
          cleanupError = error;
        }
      } else if (stage !== undefined) {
        await cleanOwnStage(stage.stagePath);
      }
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [cause, cleanupError],
          `cannot acquire Captain session ${JSON.stringify(sessionId)} lease without leaving ownership uncertain`,
        );
      }
      if (cause instanceof CaptainSessionLeaseActiveError) throw cause;
      throw new Error(
        `cannot acquire Captain session ${JSON.stringify(sessionId)} lease: ${errorMessage(cause)}`,
      );
    }
  };

  return Object.freeze({ sessionsDir, read, latest, acquire });
}

function createLease({
  sessionId,
  owner,
  readRecord,
  writeRecord,
  deleteRecord,
  selectAdoptionPredecessor,
  acquireSession,
  readLeaseOwner,
  retireObservedLease,
  validateRetiredLeases,
  now,
}) {
  let released = false;
  let operationActive = false;

  const requireActive = () => {
    if (released) throw new Error('Captain session lease was already released');
    if (operationActive) {
      throw new Error('Captain session lease operation is already in progress');
    }
  };

  const runExclusive = async (operation) => {
    requireActive();
    operationActive = true;
    try {
      return await operation();
    } finally {
      operationActive = false;
    }
  };

  const assertOwnerUnchecked = async () => {
    if (released) throw new Error('Captain session lease was already released');
    const current = await readLeaseOwner(sessionId);
    if (current.ownerToken !== owner.ownerToken) {
      throw new Error('Captain session lease is owned by a different token');
    }
    return current;
  };

  const assertOwner = () => runExclusive(assertOwnerUnchecked);

  const read = () =>
    runExclusive(async () => {
      await assertOwnerUnchecked();
      const record = await readRecord(sessionId, { missing: 'undefined' });
      await assertOwnerUnchecked();
      return record;
    });

  const freshSettledRecord = ({
    cwd,
    structuralProjection,
    executionProjection,
    snapshot,
  } = {}) => {
    const initial = validateFreshBoundary({
      cwd,
      structuralProjection,
      snapshot,
    });
    const applied = assertCaptainSessionExecutionCompatible(
      initial.structuralProjection,
      executionProjection,
    );
    const createdAt = timestampFrom(now(), 'session timestamp');
    const updatedAt = nextTimestamp(now(), createdAt);
    return validateCaptainSessionRecord({
      schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
      kind: CAPTAIN_SESSION_RECORD_KIND,
      state: 'settled',
      sessionId,
      createdAt,
      updatedAt,
      cwd: initial.cwd,
      structuralProjection: initial.structuralProjection,
      lastAppliedExecutionProjection: applied,
      snapshot: initial.snapshot,
      retainedGenerations: {},
    });
  };

  const publishEmptyFreshTarget = async (target) => {
    try {
      await assertOwnerUnchecked();
      await writeRecord(target, {
        noReplace: true,
      });
    } catch (cause) {
      throw new Error(
        `cannot publish empty Captain session adoption target: ${errorMessage(cause)}`,
        { cause },
      );
    }
  };

  const useAcquiredSession = async (sourceSessionId, operation) => {
    const sourceLease = await acquireSession(sourceSessionId);
    let result;
    let operationFailed = false;
    let operationError;
    try {
      result = await operation(sourceLease);
    } catch (cause) {
      operationFailed = true;
      operationError = cause;
    }
    try {
      await sourceLease.release();
    } catch (releaseError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, releaseError],
          'Captain session adoption predecessor operation failed and its lease could not be released',
        );
      }
      throw releaseError;
    }
    if (operationFailed) throw operationError;
    return result;
  };

  const useAvailableSession = async (sourceSessionId, operation) => {
    try {
      return await useAcquiredSession(sourceSessionId, operation);
    } catch (error) {
      if (error instanceof CaptainSessionLeaseActiveError) return undefined;
      throw error;
    }
  };

  const predecessor = ({ onLegacyRecord } = {}) =>
    runExclusive(async () => {
      await assertOwnerUnchecked();
      const target = await readRecord(sessionId, { missing: 'undefined' });
      assertFreshAdoptionTarget(target);
      const selected = await selectAdoptionPredecessor(target, {
        onLegacyRecord,
      });
      if (selected === undefined) return undefined;
      const descriptor = await useAvailableSession(
        selected.sessionId,
        async (sourceLease) => {
          const source = await sourceLease.read();
          if (source === undefined) {
            throw new Error(
              'Captain session adoption predecessor disappeared',
            );
          }
          await assertOwnerUnchecked();
          const currentTarget = await readRecord(sessionId);
          if (!isDeepStrictEqual(currentTarget, target)) {
            throw new Error('Captain session adoption target changed');
          }
          const current = await selectAdoptionPredecessor(currentTarget);
          if (current?.sessionId !== source.sessionId) {
            throw new Error('Captain session adoption predecessor changed');
          }
          return adoptionPredecessorDescriptor(source);
        },
      );
      await assertOwnerUnchecked();
      return descriptor;
    });

  const transferPredecessorGenerations = ({ predecessor: value } = {}) =>
    runExclusive(async () => {
      const expected = validateAdoptionPredecessorDescriptor(value);
      await assertOwnerUnchecked();
      const target = await readRecord(sessionId, { missing: 'undefined' });
      assertFreshAdoptionTarget(target);
      const selected = await selectAdoptionPredecessor(target);
      if (selected?.sessionId !== expected.sessionId) {
        throw new Error('Captain session adoption predecessor changed');
      }
      const result = await useAvailableSession(
        expected.sessionId,
        async (sourceLease) => {
          const source = await sourceLease.read();
          if (source === undefined) {
            throw new Error(
              'Captain session adoption predecessor disappeared',
            );
          }
          await assertOwnerUnchecked();
          const currentTarget = await readRecord(sessionId);
          if (!isDeepStrictEqual(currentTarget, target)) {
            throw new Error('Captain session adoption target changed');
          }
          const current = await selectAdoptionPredecessor(currentTarget);
          if (current?.sessionId !== source.sessionId) {
            throw new Error('Captain session adoption predecessor changed');
          }
          if (
            !isDeepStrictEqual(
              adoptionPredecessorDescriptor(source),
              expected,
            )
          ) {
            throw new Error('Captain session adoption predecessor changed');
          }

          const retainedGenerations = source.retainedGenerations ?? {};
          assertAdoptionTransferEnvelope(
            source.structuralProjection,
            currentTarget.structuralProjection,
            retainedGenerations,
          );
          if (Object.keys(retainedGenerations).length === 0) {
            return adoptionTransferResult(source, retainedGenerations);
          }
          const sourceNext = settledRecordWithRetainedGenerations(
            source,
            {},
            nextTimestamp(now(), source.updatedAt),
          );
          const targetTimestampFloor =
            Date.parse(currentTarget.updatedAt) >
            Date.parse(sourceNext.updatedAt)
              ? currentTarget.updatedAt
              : sourceNext.updatedAt;
          const targetNext = settledRecordWithRetainedGenerations(
            currentTarget,
            retainedGenerations,
            nextTimestamp(now(), targetTimestampFloor),
          );

          await sourceLease.assertOwner();
          await assertOwnerUnchecked();
          let sourcePublished = false;
          try {
            await writeRecord(sourceNext, {
              noReplace: false,
              onPublished: () => {
                sourcePublished = true;
              },
            });
          } catch (cause) {
            throw new Error(
              `cannot clear Captain session adoption predecessor: ${errorMessage(cause)}`,
              { cause },
            );
          }
          if (!sourcePublished) {
            throw new Error(
              'Captain session adoption predecessor clear did not publish',
            );
          }
          await sourceLease.assertOwner();
          await assertOwnerUnchecked();

          let targetPublished = false;
          try {
            await writeRecord(targetNext, {
              noReplace: false,
              onPublished: () => {
                targetPublished = true;
              },
            });
          } catch (cause) {
            if (!targetPublished) {
              try {
                await sourceLease.assertOwner();
                await assertOwnerUnchecked();
                await writeRecord(source, { noReplace: false });
                await sourceLease.assertOwner();
                await assertOwnerUnchecked();
              } catch (rollbackError) {
                throw new AggregateError(
                  [cause, rollbackError],
                  'Captain session adoption transfer failed and its predecessor could not be restored',
                );
              }
            }
            throw new Error(
              `cannot install Captain session adoption generations: ${errorMessage(cause)}`,
              { cause },
            );
          }
          await sourceLease.assertOwner();
          await assertOwnerUnchecked();
          return adoptionTransferResult(source, retainedGenerations);
        },
      );
      await assertOwnerUnchecked();
      return result;
    });

  const initializeSettledWithPredecessor = (options = {}) =>
    runExclusive(async () => {
      const target = freshSettledRecord(options);
      await assertOwnerUnchecked();
      if (
        (await readRecord(sessionId, { missing: 'undefined' })) !== undefined
      ) {
        throw new Error(
          `Captain session ${JSON.stringify(sessionId)} already exists`,
        );
      }
      const selected = await selectAdoptionPredecessor(target, {
        onLegacyRecord: options.onLegacyRecord,
      });
      if (selected === undefined) {
        await publishEmptyFreshTarget(target);
        await assertOwnerUnchecked();
        return target;
      }

      let result = await useAvailableSession(
        selected.sessionId,
        async (sourceLease) => {
          const source = await sourceLease.read();
          if (source === undefined) {
            const current = await selectAdoptionPredecessor(target);
            return {
              kind: 'declined',
              predecessorUpdatedAt:
                current !== undefined &&
                Date.parse(current.updatedAt) > Date.parse(selected.updatedAt)
                  ? current.updatedAt
                  : selected.updatedAt,
            };
          }
          await assertOwnerUnchecked();
          if (
            (await readRecord(sessionId, { missing: 'undefined' })) !==
            undefined
          ) {
            throw new Error('Captain session adoption target changed');
          }
          const current = await selectAdoptionPredecessor(target);
          if (current?.sessionId !== source.sessionId) {
            return {
              kind: 'declined',
              predecessorUpdatedAt:
                current !== undefined &&
                Date.parse(current.updatedAt) > Date.parse(source.updatedAt)
                  ? current.updatedAt
                  : source.updatedAt,
            };
          }

          const retainedGenerations = source.retainedGenerations ?? {};
          try {
            assertAdoptionTransferEnvelope(
              source.structuralProjection,
              target.structuralProjection,
              retainedGenerations,
            );
          } catch {
            return {
              kind: 'declined',
              predecessorUpdatedAt: source.updatedAt,
            };
          }
          if (Object.keys(retainedGenerations).length === 0) {
            return {
              kind: 'empty',
              predecessorUpdatedAt: source.updatedAt,
            };
          }

          const sourceNext = settledRecordWithRetainedGenerations(
            source,
            {},
            nextTimestamp(now(), source.updatedAt),
          );
          const targetTimestampFloor =
            Date.parse(target.updatedAt) > Date.parse(sourceNext.updatedAt)
              ? target.updatedAt
              : sourceNext.updatedAt;
          const targetNext = settledRecordWithRetainedGenerations(
            target,
            retainedGenerations,
            nextTimestamp(now(), targetTimestampFloor),
          );

          await sourceLease.assertOwner();
          await assertOwnerUnchecked();
          let sourcePublished = false;
          try {
            await writeRecord(sourceNext, {
              noReplace: false,
              onPublished: () => {
                sourcePublished = true;
              },
            });
          } catch (cause) {
            throw new Error(
              `cannot clear Captain session adoption predecessor: ${errorMessage(cause)}`,
              { cause },
            );
          }
          if (!sourcePublished) {
            throw new Error(
              'Captain session adoption predecessor clear did not publish',
            );
          }
          await sourceLease.assertOwner();
          await assertOwnerUnchecked();

          let targetPublished = false;
          try {
            await writeRecord(targetNext, {
              noReplace: true,
              onPublished: () => {
                targetPublished = true;
              },
            });
          } catch (cause) {
            if (!targetPublished) {
              try {
                await sourceLease.assertOwner();
                await assertOwnerUnchecked();
                await writeRecord(source, { noReplace: false });
                await sourceLease.assertOwner();
                await assertOwnerUnchecked();
              } catch (rollbackError) {
                throw new AggregateError(
                  [cause, rollbackError],
                  'Captain session adoption transfer failed and its predecessor could not be restored',
                );
              }
            }
            throw new Error(
              `cannot install Captain session adoption generations: ${errorMessage(cause)}`,
              { cause },
            );
          }
          await sourceLease.assertOwner();
          await assertOwnerUnchecked();
          return { kind: 'transferred', target: targetNext };
        },
      );
      if (result === undefined) {
        result = {
          kind: 'declined',
          predecessorUpdatedAt: selected.updatedAt,
        };
      }

      if (result.kind === 'transferred') return result.target;
      await assertOwnerUnchecked();
      if (
        (await readRecord(sessionId, { missing: 'undefined' })) !== undefined
      ) {
        throw new Error('Captain session adoption target changed');
      }
      const timestampFloor =
        Date.parse(target.updatedAt) >
        Date.parse(result.predecessorUpdatedAt)
          ? target.updatedAt
          : result.predecessorUpdatedAt;
      const emptyTarget = settledRecordWithRetainedGenerations(
        target,
        {},
        nextTimestamp(now(), timestampFloor),
      );
      await publishEmptyFreshTarget(emptyTarget);
      await assertOwnerUnchecked();
      return emptyTarget;
    });

  const initializeSettled = ({
    cwd,
    structuralProjection,
    executionProjection,
    snapshot,
  } = {}) =>
    runExclusive(async () => {
      const record = freshSettledRecord({
        cwd,
        structuralProjection,
        executionProjection,
        snapshot,
      });
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: true });
      await assertOwnerUnchecked();
      return record;
    });

  const abandonFreshSettled = ({ expected: value } = {}) =>
    runExclusive(async () => {
      const expected = validateCaptainSessionRecord(value);
      if (expected.sessionId !== sessionId) {
        throw new Error('fresh Captain session abandonment id is mismatched');
      }
      assertFreshAdoptionTarget(expected);
      await assertOwnerUnchecked();
      const current = await readRecord(sessionId, { missing: 'undefined' });
      if (!isDeepStrictEqual(current, expected)) return false;
      await assertOwnerUnchecked();
      await deleteRecord(sessionId);
      await assertOwnerUnchecked();
      return true;
    });

  const beginTurn = ({
    input,
    attemptId,
    attemptedExecutionProjection,
    fresh,
  } = {}) =>
    runExclusive(async () => {
      assertAcceptedInput(input);
      assertUuid(attemptId, 'Captain session attempt id');
      const attempted = validateCaptainSessionExecutionProjection(
        attemptedExecutionProjection,
        'Captain session attempted execution projection',
      );
      await assertOwnerUnchecked();
      const prior = await readRecord(sessionId, { missing: 'undefined' });
      let record;
      if (fresh !== undefined) {
        if (prior !== undefined) {
          throw new Error('fresh Captain session record already exists');
        }
        const initial = validateFreshBoundary(fresh);
        const timestamp = timestampFrom(now(), 'session timestamp');
        record = validateCaptainSessionRecord({
          schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
          kind: CAPTAIN_SESSION_RECORD_KIND,
          state: 'uncertain',
          sessionId,
          createdAt: timestamp,
          updatedAt: timestamp,
          cwd: initial.cwd,
          structuralProjection: initial.structuralProjection,
          lastAppliedExecutionProjection: attempted,
          snapshot: initial.snapshot,
          retainedGenerations: {},
          uncertain: {
            baseUpdatedAt: null,
            input,
            attemptId,
            attemptNumber: 1,
            markedAt: timestamp,
            attemptedExecutionProjection: attempted,
          },
        });
        await assertOwnerUnchecked();
        await writeRecord(record, { noReplace: true });
      } else {
        if (prior === undefined) {
          throw new Error('Captain session does not exist for continuation');
        }
        if (prior.state !== 'settled') {
          throw new Error('Captain session already has an uncertain turn');
        }
        const timestamp = nextTimestamp(now(), prior.updatedAt);
        record = validateCaptainSessionRecord({
          schemaVersion: prior.schemaVersion,
          kind: CAPTAIN_SESSION_RECORD_KIND,
          state: 'uncertain',
          sessionId,
          createdAt: prior.createdAt,
          updatedAt: timestamp,
          cwd: prior.cwd,
          structuralProjection: prior.structuralProjection,
          lastAppliedExecutionProjection:
            prior.lastAppliedExecutionProjection,
          snapshot: prior.snapshot,
          ...retainedGenerationsMember(prior),
          uncertain: {
            baseUpdatedAt: prior.updatedAt,
            input,
            attemptId,
            attemptNumber: 1,
            markedAt: timestamp,
            attemptedExecutionProjection: attempted,
          },
        });
        await assertOwnerUnchecked();
        await writeRecord(record, { noReplace: false });
      }
      await assertOwnerUnchecked();
      return record;
    });

  const beginRetry = ({ expectedAttemptId, nextAttemptId } = {}) =>
    runExclusive(async () => {
      assertUuid(expectedAttemptId, 'Captain session expected attempt id');
      assertUuid(nextAttemptId, 'Captain session next attempt id');
      if (expectedAttemptId === nextAttemptId) {
        throw new Error('Captain session retry requires a fresh attempt id');
      }
      await assertOwnerUnchecked();
      const prior = await requireUncertainRecord(
        await readRecord(sessionId, { missing: 'undefined' }),
        expectedAttemptId,
      );
      if (!Number.isSafeInteger(prior.uncertain.attemptNumber + 1)) {
        throw new Error('Captain session attempt number cannot be incremented');
      }
      const timestamp = nextTimestamp(now(), prior.updatedAt);
      const record = validateCaptainSessionRecord({
        schemaVersion: prior.schemaVersion,
        kind: CAPTAIN_SESSION_RECORD_KIND,
        state: 'uncertain',
        sessionId,
        createdAt: prior.createdAt,
        updatedAt: timestamp,
        cwd: prior.cwd,
        structuralProjection: prior.structuralProjection,
        lastAppliedExecutionProjection:
          prior.lastAppliedExecutionProjection,
        snapshot: prior.snapshot,
        ...retainedGenerationsMember(prior),
        uncertain: {
          baseUpdatedAt: prior.uncertain.baseUpdatedAt,
          input: prior.uncertain.input,
          attemptId: nextAttemptId,
          attemptNumber: prior.uncertain.attemptNumber + 1,
          markedAt: timestamp,
          attemptedExecutionProjection:
            prior.uncertain.attemptedExecutionProjection,
        },
      });
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return record;
    });

  const settle = ({ attemptId, snapshot, retentionUpdates = [] } = {}) =>
    runExclusive(async () => {
      assertUuid(attemptId, 'Captain session attempt id');
      const updates = validateRetainedGenerationUpdates(retentionUpdates);
      await assertOwnerUnchecked();
      const prior = await requireUncertainRecord(
        await readRecord(sessionId, { missing: 'undefined' }),
        attemptId,
      );
      const timestamp = nextTimestamp(now(), prior.updatedAt);
      const record = validateCaptainSessionRecord({
        schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
        kind: CAPTAIN_SESSION_RECORD_KIND,
        state: 'settled',
        sessionId,
        createdAt: prior.createdAt,
        updatedAt: timestamp,
        cwd: prior.cwd,
        structuralProjection: prior.structuralProjection,
        lastAppliedExecutionProjection:
          prior.uncertain.attemptedExecutionProjection,
        snapshot,
        retainedGenerations: applyRetainedGenerationUpdates(
          prior.retainedGenerations ?? {},
          updates,
          prior.structuralProjection,
        ),
      });
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return record;
    });

  const discard = ({ attemptId } = {}) =>
    runExclusive(async () => {
      assertUuid(attemptId, 'Captain session attempt id');
      await assertOwnerUnchecked();
      const prior = await requireUncertainRecord(
        await readRecord(sessionId, { missing: 'undefined' }),
        attemptId,
      );
      await assertOwnerUnchecked();
      if (prior.uncertain.baseUpdatedAt === null) {
        await deleteRecord(sessionId);
        await assertOwnerUnchecked();
        return undefined;
      }
      // writeRecord's stable key order reconstructs the exact prior settled
      // bytes from the baseline carried by the uncertain record.
      const record = validateCaptainSessionRecord({
        schemaVersion: prior.schemaVersion,
        kind: CAPTAIN_SESSION_RECORD_KIND,
        state: 'settled',
        sessionId,
        createdAt: prior.createdAt,
        updatedAt: prior.uncertain.baseUpdatedAt,
        cwd: prior.cwd,
        structuralProjection: prior.structuralProjection,
        lastAppliedExecutionProjection:
          prior.lastAppliedExecutionProjection,
        snapshot: prior.snapshot,
        ...retainedGenerationsMember(prior),
      });
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return record;
    });

  const release = () =>
    runExclusive(async () => {
      const current = await assertOwnerUnchecked();
      await retireObservedLease(sessionId, current);
      released = true;
    });

  return Object.freeze({
    sessionId,
    ownerToken: owner.ownerToken,
    read,
    initializeSettled,
    initializeSettledWithPredecessor,
    abandonFreshSettled,
    beginTurn,
    beginRetry,
    settle,
    discard,
    predecessor,
    transferPredecessorGenerations,
    assertOwner,
    release,
  });
}

export function validateCaptainSessionExecutionProjection(
  value,
  path = 'Captain session execution projection',
) {
  const projection = requireRecord(snapshotJsonValue(value, path), path);
  validateCaptainSessionProjection(projection, { path, structural: false });
  return projection;
}

export function validateCaptainSessionStructuralProjection(
  value,
  path = 'Captain session structural projection',
) {
  const projection = requireRecord(snapshotJsonValue(value, path), path);
  validateCaptainSessionProjection(projection, { path, structural: true });
  return projection;
}

export function projectCaptainSessionStructure(value) {
  const execution = validateCaptainSessionExecutionProjection(value);
  const fixedAgent = (agent) => ({
    adapter: agent.adapter,
    ...(agent.instruction === undefined
      ? {}
      : { instruction: agent.instruction }),
    ...(agent.permissions === undefined
      ? {}
      : { permissions: agent.permissions }),
  });
  return validateCaptainSessionStructuralProjection({
    schemaVersion: CAPTAIN_SESSION_STRUCTURAL_PROJECTION_SCHEMA_VERSION,
    captain: fixedAgent(execution.captain),
    players: execution.players.map(({ id, ...agent }) => ({
      id,
      ...fixedAgent(agent),
    })),
    catalog: Object.fromEntries(
      Object.entries(execution.catalog).map(([id, item]) => [
        id,
        {
          id: item.id,
          from: item.from,
          manifestCommand: item.manifestCommand,
          command: item.command,
          intent: item.intent,
          artifactSchema: item.artifactSchema,
          requiredRoleIds: item.requiredRoleIds,
          concurrentRoleSets: item.concurrentRoleSets,
          roles: Object.fromEntries(
            Object.entries(item.roles).map(([roleId, binding]) => [
              roleId,
              { playerId: binding.playerId },
            ]),
          ),
          options: item.options,
        },
      ]),
    ),
  });
}

export function assertCaptainSessionExecutionCompatible(
  structuralProjection,
  executionProjection,
) {
  const structural = validateCaptainSessionStructuralProjection(
    structuralProjection,
  );
  const execution = validateCaptainSessionExecutionProjection(
    executionProjection,
  );
  const projected = projectCaptainSessionStructure(execution);
  if (!isDeepStrictEqual(projected, structural)) {
    throw new Error(
      'Captain session execution projection does not reproduce the stored structural projection',
    );
  }
  return execution;
}

export function captainSessionSelectedMembers(value) {
  const structural = validateCaptainSessionStructuralProjection(value);
  return snapshotJsonValue(
    {
      playbookIds: Object.keys(structural.catalog),
      playerIds: referencedPlayerIds(structural.catalog),
    },
    'Captain session selected members',
  );
}

export function validateCaptainSessionRecord(value) {
  const record = requireRecord(
    snapshotJsonValue(value, 'Captain session record'),
    'Captain session record',
  );
  if (
    record.schemaVersion !== CAPTAIN_SESSION_RECORD_SCHEMA_VERSION &&
    record.schemaVersion !== COMPATIBLE_RETENTION_RECORD_SCHEMA_VERSION
  ) {
    if (record.schemaVersion === 2) {
      assertReleasedSchema2CaptainSessionRecord(record);
      throw new CaptainSessionRecordSchemaError(
        record.schemaVersion,
        'Captain session record schema 2 has incompatible root-owned player identity; schema 3 is required',
      );
    }
    throw new CaptainSessionRecordSchemaError(
      record.schemaVersion,
      `Captain session record schema ${JSON.stringify(record.schemaVersion)} is not supported`,
    );
  }
  if (record.state !== 'settled' && record.state !== 'uncertain') {
    throw new Error('Captain session record state is not supported');
  }
  const recordKeys =
    record.schemaVersion === COMPATIBLE_RETENTION_RECORD_SCHEMA_VERSION
      ? [...COMMON_RECORD_KEYS, 'retainedGenerations']
      : COMMON_RECORD_KEYS;
  exactOptionalKeys(
    record,
    record.state === 'uncertain'
      ? [...recordKeys, 'uncertain']
      : recordKeys,
    record.schemaVersion === CAPTAIN_SESSION_RECORD_SCHEMA_VERSION
      ? ['retainedGenerations']
      : [],
    'Captain session record',
  );
  if (record.kind !== CAPTAIN_SESSION_RECORD_KIND) {
    throw new Error('Captain session record kind is not supported');
  }
  assertSessionId(record.sessionId);
  const createdAt = canonicalTimestamp(record.createdAt, 'createdAt');
  const updatedAt = canonicalTimestamp(record.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('Captain session record updatedAt precedes createdAt');
  }
  if (record.state === 'settled' && updatedAt === createdAt) {
    throw new Error(
      'settled Captain session updatedAt must follow its creation marker',
    );
  }
  if (typeof record.cwd !== 'string' || !isAbsolute(record.cwd)) {
    throw new Error('Captain session record cwd must be an absolute path');
  }
  if (resolve(record.cwd) !== record.cwd) {
    throw new Error('Captain session record cwd must be normalized');
  }
  const structural = validateCaptainSessionStructuralProjection(
    record.structuralProjection,
    'Captain session record structuralProjection',
  );
  const lastApplied = assertCaptainSessionExecutionCompatible(
    structural,
    record.lastAppliedExecutionProjection,
  );
  void lastApplied;
  const snapshot = assertPlaybookCaptainShellSnapshot(record.snapshot);
  assertSnapshotMatchesStructure(snapshot, structural);
  if (Object.hasOwn(record, 'retainedGenerations')) {
    validateRetainedGenerations(record.retainedGenerations, structural);
  }
  if (
    snapshot.captain.sessionId === record.sessionId ||
    snapshot.issuedSessionIds.includes(record.sessionId)
  ) {
    throw new Error(
      'Captain session public id collides with an internal Captain session id',
    );
  }

  if (record.state === 'uncertain') {
    const uncertain = requireRecord(
      record.uncertain,
      'Captain session record uncertain',
    );
    rejectUnknownOrMissingKeys(
      uncertain,
      UNCERTAIN_KEYS,
      'Captain session record uncertain',
    );
    if (uncertain.baseUpdatedAt !== null) {
      canonicalTimestamp(uncertain.baseUpdatedAt, 'uncertain.baseUpdatedAt');
      if (
        Date.parse(uncertain.baseUpdatedAt) <= Date.parse(createdAt) ||
        Date.parse(uncertain.baseUpdatedAt) >= Date.parse(updatedAt)
      ) {
        throw new Error(
          'Captain session uncertain baseUpdatedAt must identify an earlier settled boundary',
        );
      }
    } else {
      const isFirstAttempt = uncertain.attemptNumber === 1;
      if (isFirstAttempt !== (updatedAt === createdAt)) {
        throw new Error(
          'fresh Captain session retry timestamps must match the attempt boundary',
        );
      }
    }
    assertAcceptedInput(uncertain.input);
    assertUuid(uncertain.attemptId, 'Captain session attempt id');
    if (
      !Number.isSafeInteger(uncertain.attemptNumber) ||
      uncertain.attemptNumber <= 0
    ) {
      throw new Error('Captain session attempt number must be a positive integer');
    }
    const markedAt = canonicalTimestamp(
      uncertain.markedAt,
      'uncertain.markedAt',
    );
    if (markedAt !== updatedAt) {
      throw new Error(
        'Captain session uncertain markedAt must equal updatedAt',
      );
    }
    const attempted = assertCaptainSessionExecutionCompatible(
      structural,
      uncertain.attemptedExecutionProjection,
    );
    if (uncertain.baseUpdatedAt === null) {
      if (!isDeepStrictEqual(lastApplied, attempted)) {
        throw new Error(
          'fresh Captain session baseline and attempted execution projections must match',
        );
      }
      assertTurnZeroSnapshot(
        snapshot,
        'fresh Captain session record snapshot',
      );
    }
  }

  return record;
}

function assertReleasedSchema2CaptainSessionRecord(record) {
  if (record.state !== 'settled' && record.state !== 'uncertain') {
    throw new Error('Captain session record state is not supported');
  }
  rejectUnknownOrMissingKeys(
    record,
    record.state === 'uncertain'
      ? [...RELEASED_SCHEMA_2_COMMON_RECORD_KEYS, 'uncertain']
      : RELEASED_SCHEMA_2_COMMON_RECORD_KEYS,
    'Captain session record',
  );
  if (record.kind !== CAPTAIN_SESSION_RECORD_KIND) {
    throw new Error('Captain session record kind is not supported');
  }
  assertSessionId(record.sessionId);
  const createdAt = canonicalTimestamp(record.createdAt, 'createdAt');
  const updatedAt = canonicalTimestamp(record.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('Captain session record updatedAt precedes createdAt');
  }
  if (record.state === 'settled' && updatedAt === createdAt) {
    throw new Error(
      'settled Captain session updatedAt must follow its creation marker',
    );
  }
  if (typeof record.cwd !== 'string' || !isAbsolute(record.cwd)) {
    throw new Error('Captain session record cwd must be an absolute path');
  }
  if (resolve(record.cwd) !== record.cwd) {
    throw new Error('Captain session record cwd must be normalized');
  }
  requireRecord(record.config, 'Captain session record config');
  requireRecord(record.snapshot, 'Captain session record snapshot');

  if (record.state !== 'uncertain') return;
  const uncertain = requireRecord(
    record.uncertain,
    'Captain session record uncertain',
  );
  rejectUnknownOrMissingKeys(
    uncertain,
    RELEASED_SCHEMA_2_UNCERTAIN_KEYS,
    'Captain session record uncertain',
  );
  if (uncertain.baseUpdatedAt !== null) {
    canonicalTimestamp(uncertain.baseUpdatedAt, 'uncertain.baseUpdatedAt');
    if (
      Date.parse(uncertain.baseUpdatedAt) < Date.parse(createdAt) ||
      Date.parse(uncertain.baseUpdatedAt) >= Date.parse(updatedAt)
    ) {
      throw new Error(
        'Captain session uncertain baseUpdatedAt must identify an earlier settled boundary',
      );
    }
  } else {
    const isFirstAttempt = uncertain.attemptNumber === 1;
    if (isFirstAttempt !== (updatedAt === createdAt)) {
      throw new Error(
        'fresh Captain session retry timestamps must match the attempt boundary',
      );
    }
  }
  assertAcceptedInput(uncertain.input);
  assertUuid(uncertain.attemptId, 'Captain session attempt id');
  if (
    !Number.isSafeInteger(uncertain.attemptNumber) ||
    uncertain.attemptNumber <= 0
  ) {
    throw new Error('Captain session attempt number must be a positive integer');
  }
  const markedAt = canonicalTimestamp(
    uncertain.markedAt,
    'uncertain.markedAt',
  );
  if (markedAt !== updatedAt) {
    throw new Error(
      'Captain session uncertain markedAt must equal updatedAt',
    );
  }
}

function validateFreshBoundary(value) {
  const boundary = requireRecord(
    snapshotJsonValue(value, 'fresh Captain session boundary'),
    'fresh Captain session boundary',
  );
  rejectUnknownOrMissingKeys(
    boundary,
    ['cwd', 'structuralProjection', 'snapshot'],
    'fresh Captain session boundary',
  );
  if (typeof boundary.cwd !== 'string' || !isAbsolute(boundary.cwd)) {
    throw new Error('fresh Captain session cwd must be an absolute path');
  }
  if (resolve(boundary.cwd) !== boundary.cwd) {
    throw new Error('fresh Captain session cwd must be normalized');
  }
  const structural = validateCaptainSessionStructuralProjection(
    boundary.structuralProjection,
    'fresh Captain session structuralProjection',
  );
  const snapshot = assertPlaybookCaptainShellSnapshot(boundary.snapshot);
  assertSnapshotMatchesStructure(snapshot, structural);
  assertTurnZeroSnapshot(snapshot, 'fresh Captain session boundary snapshot');
  return boundary;
}

function assertTurnZeroSnapshot(snapshot, path) {
  if (
    snapshot.sequences.turn !== 0 ||
    snapshot.sequences.journal !== 0 ||
    snapshot.journal.length !== 0 ||
    snapshot.captain.conversation.kind !== 'unopened'
  ) {
    throw new Error(`${path} must be an initialized turn-zero shell snapshot`);
  }
}

function validateCaptainSessionProjection(
  projection,
  { path, structural },
) {
  rejectUnknownOrMissingKeys(
    projection,
    ['schemaVersion', 'captain', 'players', 'catalog'],
    path,
  );
  const expectedSchema = structural
    ? CAPTAIN_SESSION_STRUCTURAL_PROJECTION_SCHEMA_VERSION
    : CAPTAIN_SESSION_EXECUTION_PROJECTION_SCHEMA_VERSION;
  if (projection.schemaVersion !== expectedSchema) {
    throw new Error(
      `${path}.schemaVersion ${JSON.stringify(projection.schemaVersion)} is not supported (expected ${expectedSchema})`,
    );
  }
  validateProjectedAgent(projection.captain, `${path}.captain`, {
    structural,
  });
  if (!Array.isArray(projection.players)) {
    throw new Error(`${path}.players must be an array`);
  }
  const playerIds = [];
  for (let index = 0; index < projection.players.length; index += 1) {
    const playerPath = `${path}.players[${index}]`;
    const player = requireRecord(projection.players[index], playerPath);
    exactOptionalKeys(
      player,
      structural
        ? ['id', 'adapter']
        : ['id', 'adapter', 'model', 'effort'],
      ['instruction', 'permissions'],
      playerPath,
    );
    assertPlayerId(player.id, `${playerPath}.id`);
    validateProjectedAgent(player, playerPath, { structural, hasId: true });
    playerIds.push(player.id);
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw new Error(`${path}.players contains a duplicate player id`);
  }

  const catalog = requireRecord(projection.catalog, `${path}.catalog`);
  const catalogEntries = Object.entries(catalog);
  if (catalogEntries.length === 0) {
    throw new Error(`${path}.catalog must not be empty`);
  }
  const commands = new Set();
  for (const [id, rawItem] of catalogEntries) {
    const itemPath = `${path}.catalog.${id}`;
    const item = requireRecord(rawItem, itemPath);
    rejectUnknownOrMissingKeys(
      item,
      [
        'id',
        'from',
        'manifestCommand',
        'command',
        'intent',
        'artifactSchema',
        'requiredRoleIds',
        'concurrentRoleSets',
        'roles',
        'options',
      ],
      itemPath,
    );
    if (requireCanonicalNonblank(item.id, `${itemPath}.id`) !== id) {
      throw new Error(`${itemPath}.id must equal its catalog key`);
    }
    if (id === RESERVED_ID) {
      throw new Error(`${itemPath}.id uses reserved id "captain"`);
    }
    validateCanonicalModuleSpecifier(item.from, `${itemPath}.from`);
    requireCanonicalNonblank(
      item.manifestCommand,
      `${itemPath}.manifestCommand`,
    );
    const command = requireCanonicalNonblank(
      item.command,
      `${itemPath}.command`,
    );
    if (command === RESERVED_ID) {
      throw new Error(`${itemPath}.command uses reserved command "captain"`);
    }
    if (commands.has(command)) {
      throw new Error(`${path}.catalog contains duplicate command ${JSON.stringify(command)}`);
    }
    commands.add(command);
    if (typeof item.intent !== 'string') {
      throw new Error(`${itemPath}.intent must be a string`);
    }
    if (item.artifactSchema !== 2) {
      throw new Error(`${itemPath}.artifactSchema must be exactly 2`);
    }
    const requiredRoleIds = validateRoleIds(
      item.requiredRoleIds,
      `${itemPath}.requiredRoleIds`,
    );
    validateConcurrentRoleSets(
      item.concurrentRoleSets,
      requiredRoleIds,
      `${itemPath}.concurrentRoleSets`,
    );
    const roles = requireRecord(item.roles, `${itemPath}.roles`);
    if (!isDeepStrictEqual(Object.keys(roles), requiredRoleIds)) {
      throw new Error(`${itemPath}.roles must exactly follow requiredRoleIds`);
    }
    for (const roleId of requiredRoleIds) {
      const bindingPath = `${itemPath}.roles.${roleId}`;
      const binding = requireRecord(roles[roleId], bindingPath);
      rejectUnknownOrMissingKeys(
        binding,
        structural
          ? ['playerId']
          : ['playerId', 'model', 'effort'],
        bindingPath,
      );
      assertPlayerId(binding.playerId, `${bindingPath}.playerId`);
      if (!structural) {
        validateTuningSelection(binding.model, `${bindingPath}.model`);
        const player = projection.players.find(
          (candidate) => candidate.id === binding.playerId,
        );
        if (player === undefined) {
          throw new Error(
            `${bindingPath}.playerId names a player absent from ${path}.players`,
          );
        }
        validateEffortSelection(
          binding.effort,
          player.adapter,
          `${bindingPath}.effort`,
        );
      }
    }
    for (const [setIndex, set] of item.concurrentRoleSets.entries()) {
      const concurrentPlayers = set.map(
        (roleId) => roles[roleId].playerId,
      );
      if (new Set(concurrentPlayers).size !== concurrentPlayers.length) {
        throw new Error(
          `${itemPath}.concurrentRoleSets[${setIndex}] binds one player more than once`,
        );
      }
    }
    requireRecord(item.options, `${itemPath}.options`);
  }
  const referenced = referencedPlayerIds(catalog);
  if (!isDeepStrictEqual(playerIds, referenced)) {
    throw new Error(
      `${path}.players must equal the ordered player ids referenced by catalog roles`,
    );
  }
}

function validateProjectedAgent(value, path, { structural, hasId = false }) {
  const agent = requireRecord(value, path);
  if (!hasId) {
    exactOptionalKeys(
      agent,
      structural ? ['adapter'] : ['adapter', 'model', 'effort'],
      ['instruction', 'permissions'],
      path,
    );
  }
  const adapter = requireCanonicalNonblank(agent.adapter, `${path}.adapter`);
  if (!KNOWN_ADAPTERS.has(adapter)) {
    throw new Error(`${path}.adapter ${JSON.stringify(adapter)} is not supported`);
  }
  if (!structural) {
    validateTuningSelection(agent.model, `${path}.model`);
    validateEffortSelection(agent.effort, adapter, `${path}.effort`);
  }
  if (agent.instruction !== undefined && typeof agent.instruction !== 'string') {
    throw new Error(`${path}.instruction must be a string`);
  }
  if (agent.permissions !== undefined) {
    validatePermissionPolicy(agent.permissions, `${path}.permissions`);
  }
}

function validateTuningSelection(value, path) {
  const selection = requireRecord(value, path);
  if (selection.kind === 'provider-default') {
    rejectUnknownOrMissingKeys(selection, ['kind'], path);
    return;
  }
  if (selection.kind === 'value') {
    rejectUnknownOrMissingKeys(selection, ['kind', 'value'], path);
    requireNonblank(selection.value, `${path}.value`);
    return;
  }
  throw new Error(`${path}.kind is not supported`);
}

function validateEffortSelection(value, adapter, path) {
  validateTuningSelection(value, path);
  if (value.kind !== 'value') return;
  try {
    assertSupportedEffort(adapter, value.value, `${path}.value`);
  } catch (cause) {
    throw new Error(errorMessage(cause));
  }
}

function validatePermissionPolicy(value, path) {
  const permissions = requireRecord(value, path);
  exactOptionalKeys(
    permissions,
    [],
    [
      'mode',
      'fileWrite',
      'shellExecute',
      'networkAccess',
      'writablePaths',
    ],
    path,
  );
  if (
    permissions.mode !== undefined &&
    permissions.mode !== 'auto' &&
    permissions.mode !== 'bypass'
  ) {
    throw new Error(`${path}.mode must be "auto" or "bypass"`);
  }
  for (const key of ['fileWrite', 'shellExecute', 'networkAccess']) {
    if (
      permissions[key] !== undefined &&
      !['allow', 'ask', 'deny'].includes(permissions[key])
    ) {
      throw new Error(`${path}.${key} must be "allow", "ask", or "deny"`);
    }
  }
  if (permissions.writablePaths !== undefined) {
    if (
      !Array.isArray(permissions.writablePaths) ||
      permissions.writablePaths.some(
        (entry) => typeof entry !== 'string' || entry.length === 0,
      )
    ) {
      throw new Error(
        `${path}.writablePaths must be an array of non-empty strings`,
      );
    }
  }
}

function validateRoleIds(value, path) {
  if (
    !Array.isArray(value) ||
    value.some(
      (roleId) =>
        typeof roleId !== 'string' ||
        !ROLE_ID_PATTERN.test(roleId) ||
        roleId === RESERVED_ID,
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${path} must contain distinct canonical local role ids`);
  }
  return value;
}

function validateConcurrentRoleSets(value, requiredRoleIds, path) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  const required = new Set(requiredRoleIds);
  const signatures = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const set = value[index];
    if (
      !Array.isArray(set) ||
      set.length < 2 ||
      set.some((roleId) => !required.has(roleId)) ||
      new Set(set).size !== set.length
    ) {
      throw new Error(
        `${path}[${index}] must contain at least two distinct required roles`,
      );
    }
    const signature = JSON.stringify(set);
    if (signatures.has(signature)) {
      throw new Error(`${path} contains duplicate set ${signature}`);
    }
    signatures.add(signature);
  }
}

function referencedPlayerIds(catalog) {
  const seen = new Set();
  const ids = [];
  for (const item of Object.values(catalog)) {
    for (const roleId of item.requiredRoleIds) {
      const playerId = item.roles[roleId].playerId;
      if (!seen.has(playerId)) {
        seen.add(playerId);
        ids.push(playerId);
      }
    }
  }
  return ids;
}

function assertSnapshotMatchesStructure(snapshot, structural) {
  if (!isDeepStrictEqual(snapshot.captain.agent, structural.captain)) {
    throw new Error(
      'Captain session snapshot Captain envelope differs from structuralProjection',
    );
  }
  const structuralPlayers = new Map(
    structural.players.map(({ id, ...agent }) => [id, agent]),
  );
  if (
    !isDeepStrictEqual(
      Object.keys(snapshot.playerSessions),
      [...structuralPlayers.keys()],
    )
  ) {
    throw new Error(
      'Captain session snapshot player ledger differs from structuralProjection roster',
    );
  }
  for (const [playerId, agent] of structuralPlayers) {
    const { resumeToken: _resumeToken, ...savedAgent } =
      snapshot.playerSessions[playerId];
    if (!isDeepStrictEqual(savedAgent, agent)) {
      throw new Error(
        `Captain session snapshot player ${JSON.stringify(playerId)} envelope differs from structuralProjection`,
      );
    }
  }
  if (snapshot.mode !== 'engaged.parked') return;
  for (const frame of snapshot.frames) {
    const item = structural.catalog[frame.playbookId];
    if (item === undefined) {
      throw new Error(
        `Captain session snapshot frame names unknown stored playbook ${JSON.stringify(frame.playbookId)}`,
      );
    }
    const roleBindings = Object.fromEntries(
      item.requiredRoleIds.map((roleId) => [
        roleId,
        item.roles[roleId].playerId,
      ]),
    );
    if (!isDeepStrictEqual(frame.roleBindings, roleBindings)) {
      throw new Error(
        `Captain session snapshot frame ${JSON.stringify(frame.playbookId)} role bindings differ from structuralProjection`,
      );
    }
  }
}

function validateRetainedGenerationUpdates(value) {
  const updates = snapshotJsonValue(
    value,
    'Captain session retained-generation updates',
  );
  if (!Array.isArray(updates)) {
    throw new Error(
      'Captain session retained-generation updates must be an array',
    );
  }
  const roots = new Set();
  for (const [index, value] of updates.entries()) {
    const path = `Captain session retained-generation updates[${index}]`;
    const update = requireRecord(value, path);
    if (update.kind === 'retain') {
      rejectUnknownOrMissingKeys(
        update,
        ['kind', 'rootPlaybookId', 'generation'],
        path,
      );
      requireRecord(update.generation, `${path}.generation`);
    } else if (update.kind === 'clear') {
      rejectUnknownOrMissingKeys(
        update,
        ['kind', 'rootPlaybookId'],
        path,
      );
    } else {
      throw new Error(`${path}.kind must be "retain" or "clear"`);
    }
    const rootPlaybookId = requireCanonicalNonblank(
      update.rootPlaybookId,
      `${path}.rootPlaybookId`,
    );
    if (roots.has(rootPlaybookId)) {
      throw new Error(
        'Captain session retained-generation updates contain a duplicate root playbook id',
      );
    }
    roots.add(rootPlaybookId);
  }
  return updates;
}

function applyRetainedGenerationUpdates(
  retainedGenerations,
  updates,
  structural,
) {
  const next = new Map(Object.entries(retainedGenerations));
  for (const update of updates) {
    if (!Object.hasOwn(structural.catalog, update.rootPlaybookId)) {
      throw new Error(
        `Captain session retained-generation update names unknown stored playbook ${JSON.stringify(update.rootPlaybookId)}`,
      );
    }
    if (update.kind === 'clear') {
      next.delete(update.rootPlaybookId);
    } else {
      next.set(update.rootPlaybookId, update.generation);
    }
  }
  return Object.fromEntries(next);
}

function retainedGenerationsMember(record) {
  return Object.hasOwn(record, 'retainedGenerations')
    ? { retainedGenerations: record.retainedGenerations }
    : {};
}

function sortCaptainSessionRecords(records) {
  return [...records].sort((left, right) => {
    const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    if (right.sessionId === left.sessionId) return 0;
    return right.sessionId < left.sessionId ? -1 : 1;
  });
}

function adoptionPredecessorDescriptor(record) {
  return validateAdoptionPredecessorDescriptor({
    sessionId: record.sessionId,
    updatedAt: record.updatedAt,
    cwd: record.cwd,
    structuralProjection: record.structuralProjection,
    retainedGenerations: record.retainedGenerations ?? {},
  });
}

function validateAdoptionPredecessorDescriptor(value) {
  const descriptor = requireRecord(
    snapshotJsonValue(value, 'Captain session adoption predecessor'),
    'Captain session adoption predecessor',
  );
  rejectUnknownOrMissingKeys(
    descriptor,
    [
      'sessionId',
      'updatedAt',
      'cwd',
      'structuralProjection',
      'retainedGenerations',
    ],
    'Captain session adoption predecessor',
  );
  assertSessionId(descriptor.sessionId);
  canonicalTimestamp(
    descriptor.updatedAt,
    'Captain session adoption predecessor updatedAt',
  );
  if (typeof descriptor.cwd !== 'string' || !isAbsolute(descriptor.cwd)) {
    throw new Error(
      'Captain session adoption predecessor cwd must be an absolute path',
    );
  }
  if (resolve(descriptor.cwd) !== descriptor.cwd) {
    throw new Error(
      'Captain session adoption predecessor cwd must be normalized',
    );
  }
  const structural = validateCaptainSessionStructuralProjection(
    descriptor.structuralProjection,
    'Captain session adoption predecessor structuralProjection',
  );
  validateRetainedGenerations(
    descriptor.retainedGenerations,
    structural,
  );
  return descriptor;
}

function assertFreshAdoptionTarget(record) {
  if (record === undefined) {
    throw new Error('Captain session adoption target does not exist');
  }
  if (Object.keys(record.retainedGenerations ?? {}).length !== 0) {
    throw new Error(
      'Captain session adoption target already retains generations',
    );
  }
  if (record.snapshot.mode !== 'chat') {
    throw new Error(
      'Captain session adoption target must have no live engagement',
    );
  }
  if (record.state !== 'settled') {
    throw new Error(
      'Captain session adoption target must be settled at turn zero',
    );
  }
  assertTurnZeroSnapshot(
    record.snapshot,
    'Captain session adoption target snapshot',
  );
}

function assertAdoptionTransferEnvelope(
  sourceStructural,
  targetStructural,
  retainedGenerations,
) {
  for (const [rootPlaybookId, generation] of Object.entries(
    retainedGenerations,
  )) {
    const sourceRoot = sourceStructural.catalog[rootPlaybookId];
    const targetRoot = targetStructural.catalog[rootPlaybookId];
    if (targetRoot === undefined) {
      throw new Error(
        `Captain session adoption target has no root playbook ${JSON.stringify(rootPlaybookId)}`,
      );
    }
    const rootEnvelope = (item) => ({
      from: item.from,
      manifestCommand: item.manifestCommand,
      options: item.options,
      requiredRoleIds: item.requiredRoleIds,
      concurrentRoleSets: item.concurrentRoleSets,
    });
    if (
      !isDeepStrictEqual(
        rootEnvelope(sourceRoot),
        rootEnvelope(targetRoot),
      )
    ) {
      throw new Error(
        `Captain session adoption target root envelope differs for ${JSON.stringify(rootPlaybookId)}`,
      );
    }
    for (const frame of generation.frames) {
      const sourceFrame = sourceStructural.catalog[frame.playbookId];
      const targetFrame = targetStructural.catalog[frame.playbookId];
      if (targetFrame === undefined) {
        throw new Error(
          `Captain session adoption target has no frame playbook ${JSON.stringify(frame.playbookId)}`,
        );
      }
      if (targetFrame.artifactSchema !== sourceFrame.artifactSchema) {
        throw new Error(
          `Captain session adoption target artifact schema differs for ${JSON.stringify(frame.playbookId)}`,
        );
      }
    }
  }
}

function settledRecordWithRetainedGenerations(
  record,
  retainedGenerations,
  updatedAt,
) {
  if (record.state !== 'settled') {
    throw new Error('Captain session adoption exchange requires settled records');
  }
  return validateCaptainSessionRecord({
    schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
    kind: record.kind,
    state: record.state,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    updatedAt,
    cwd: record.cwd,
    structuralProjection: record.structuralProjection,
    lastAppliedExecutionProjection: record.lastAppliedExecutionProjection,
    snapshot: record.snapshot,
    retainedGenerations,
  });
}

function adoptionTransferResult(source, retainedGenerations) {
  return snapshotJsonValue(
    {
      sourceSessionId: source.sessionId,
      retainedGenerations,
    },
    'Captain session adoption transfer result',
  );
}

function validateRetainedGenerations(value, structural) {
  const retained = requireRecord(
    value,
    'Captain session record retainedGenerations',
  );
  const sessionIds = new Set();
  for (const [rootPlaybookId, value] of Object.entries(retained)) {
    const path =
      `Captain session record retainedGenerations` +
      `[${JSON.stringify(rootPlaybookId)}]`;
    if (!Object.hasOwn(structural.catalog, rootPlaybookId)) {
      throw new Error(
        `Captain session retained generation names unknown stored playbook ${JSON.stringify(rootPlaybookId)}`,
      );
    }
    const generation = requireRecord(value, path);
    exactOptionalKeys(
      generation,
      ['frames'],
      ['rootStateDescription'],
      path,
    );
    if (generation.rootStateDescription !== undefined) {
      requireNonblank(
        generation.rootStateDescription,
        `${path}.rootStateDescription`,
      );
    }
    if (!Array.isArray(generation.frames) || generation.frames.length === 0) {
      throw new Error(`${path}.frames must be a non-empty array`);
    }
    const frames = generation.frames.map((value, index) =>
      validateRetainedGenerationFrame(
        value,
        index,
        rootPlaybookId,
        structural,
        sessionIds,
        `${path}.frames[${index}]`,
      ),
    );
    validateRetainedGenerationPath(frames, rootPlaybookId, path);
  }
  return retained;
}

function validateRetainedGenerationFrame(
  value,
  index,
  rootPlaybookId,
  structural,
  sessionIds,
  path,
) {
  const frame = requireRecord(value, path);
  exactOptionalKeys(
    frame,
    [
      'playbookId',
      'sessionId',
      'rootSessionId',
      'depth',
      'options',
      'roleBindings',
      'runtime',
    ],
    ['parentSessionId', 'parentCallId'],
    path,
  );
  const playbookId = requireCanonicalNonblank(
    frame.playbookId,
    `${path}.playbookId`,
  );
  const catalogItem = structural.catalog[playbookId];
  if (catalogItem === undefined) {
    throw new Error(
      `${path}.playbookId names unknown stored playbook ${JSON.stringify(playbookId)}`,
    );
  }
  assertUuid(frame.sessionId, `${path}.sessionId`);
  assertUuid(frame.rootSessionId, `${path}.rootSessionId`);
  if (sessionIds.has(frame.sessionId)) {
    throw new Error(
      'Captain session retained generation frame session ids must be unique',
    );
  }
  sessionIds.add(frame.sessionId);
  if (!Number.isSafeInteger(frame.depth) || frame.depth !== index) {
    throw new Error(`${path}.depth must equal its root-to-leaf index`);
  }
  if (frame.parentSessionId !== undefined) {
    assertUuid(frame.parentSessionId, `${path}.parentSessionId`);
  }
  if (frame.parentCallId !== undefined) {
    requireNonblank(frame.parentCallId, `${path}.parentCallId`);
  }
  const roleBindings = requireRecord(
    frame.roleBindings,
    `${path}.roleBindings`,
  );
  rejectUnknownOrMissingKeys(
    roleBindings,
    catalogItem.requiredRoleIds,
    `${path}.roleBindings`,
  );
  for (const roleId of catalogItem.requiredRoleIds) {
    assertPlayerId(roleBindings[roleId], `${path}.roleBindings.${roleId}`);
  }
  let runtime;
  try {
    runtime = assertPlaybookRuntimeSnapshot(frame.runtime, playbookId, {
      allowSuspendedCall: true,
    });
  } catch (cause) {
    throw new Error(`${path}.runtime is invalid: ${errorMessage(cause)}`, {
      cause,
    });
  }
  if (
    runtime.state.status !== 'active' ||
    !runtime.state.quiescent ||
    runtime.state.stateId === undefined
  ) {
    throw new Error(
      `${path}.runtime must capture one active quiescent pre-terminal state`,
    );
  }
  for (const roleId of Object.keys(runtime.roleResumeTokens)) {
    if (!Object.hasOwn(roleBindings, roleId)) {
      throw new Error(
        `${path}.runtime role token names an unbound role ${JSON.stringify(roleId)}`,
      );
    }
  }
  for (const question of runtime.pendingBossQuestions) {
    if (
      question.asker.kind === 'role' &&
      !Object.hasOwn(roleBindings, question.asker.roleId)
    ) {
      throw new Error(
        `${path}.runtime pending question names an unbound role ${JSON.stringify(question.asker.roleId)}`,
      );
    }
  }
  if (index === 0 && playbookId !== rootPlaybookId) {
    throw new Error(
      `${path}.playbookId must equal retained root ${JSON.stringify(rootPlaybookId)}`,
    );
  }
  return {
    ...frame,
    playbookId,
    runtime,
  };
}

function validateRetainedGenerationPath(frames, rootPlaybookId, path) {
  const rootSessionId = frames[0].sessionId;
  const playbookIds = new Set();
  for (const [index, frame] of frames.entries()) {
    if (playbookIds.has(frame.playbookId)) {
      throw new Error(`${path}.frames must not contain a playbook cycle`);
    }
    playbookIds.add(frame.playbookId);
    if (frame.rootSessionId !== rootSessionId) {
      throw new Error(
        `${path}.frames[${index}].rootSessionId must equal the root session id`,
      );
    }
    if (index === 0) {
      if (
        frame.sessionId !== frame.rootSessionId ||
        frame.parentSessionId !== undefined ||
        frame.parentCallId !== undefined
      ) {
        throw new Error(
          `${path}.frames[0] has child-only or inconsistent root identity`,
        );
      }
      continue;
    }
    const parent = frames[index - 1];
    const suspendedCall = parent.runtime.suspendedCall;
    if (
      frame.parentSessionId !== parent.sessionId ||
      frame.parentCallId === undefined
    ) {
      throw new Error(
        `${path}.frames[${index}] does not identify its immediate parent`,
      );
    }
    if (
      suspendedCall === undefined ||
      suspendedCall.callId !== frame.parentCallId ||
      suspendedCall.playbookId !== frame.playbookId ||
      suspendedCall.childSessionId !== frame.sessionId
    ) {
      throw new Error(
        `${path}.frames[${index - 1}] suspended call does not match its child edge`,
      );
    }
  }
  const leaf = frames.at(-1).runtime;
  if (
    leaf.suspendedCall !== undefined ||
    !leaf.state.tags.includes('playbook.parked')
  ) {
    throw new Error(
      `Captain session retained generation ${JSON.stringify(rootPlaybookId)} leaf must be parked without a suspended child call`,
    );
  }
}

function validateLeaseOwner(value) {
  const owner = requireRecord(
    snapshotJsonValue(value, 'Captain session lease owner'),
    'Captain session lease owner',
  );
  rejectUnknownOrMissingKeys(
    owner,
    LEASE_OWNER_KEYS,
    'Captain session lease owner',
  );
  if (owner.schemaVersion !== LEASE_SCHEMA_VERSION) {
    throw new Error('Captain session lease schema is not supported');
  }
  if (owner.kind !== LEASE_KIND) {
    throw new Error('Captain session lease kind is not supported');
  }
  assertSessionId(owner.sessionId);
  assertUuid(owner.ownerToken, 'Captain session lease owner token');
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error('Captain session lease pid must be a positive integer');
  }
  if (typeof owner.hostname !== 'string' || owner.hostname.trim().length === 0) {
    throw new Error('Captain session lease hostname must be a non-empty string');
  }
  canonicalTimestamp(owner.acquiredAt, 'lease acquiredAt');
  return owner;
}

async function requireUncertainRecord(record, attemptId) {
  if (record === undefined) throw new Error('Captain session does not exist');
  if (record.state !== 'uncertain') {
    throw new Error('Captain session has no uncertain turn');
  }
  if (record.uncertain.attemptId !== attemptId) {
    throw new Error('Captain session uncertain attempt id changed');
  }
  return record;
}

function assertAcceptedInput(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Captain session input must be a non-empty string');
  }
}

function assertSessionId(value) {
  assertUuid(value, 'Captain session id');
}

function assertPlayerId(value, path) {
  if (
    typeof value !== 'string' ||
    !PLAYER_ID_PATTERN.test(value) ||
    value === RESERVED_ID
  ) {
    throw new Error(
      `${path} must be a non-reserved player id matching ${PLAYER_ID_PATTERN.source}`,
    );
  }
}

function assertUuid(value, path) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new Error(`${path} must be a UUID`);
  }
}

function requireRecord(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function rejectUnknownOrMissingKeys(value, expected, path) {
  const actual = Object.keys(value);
  const expectedSet = new Set(expected);
  const unknown = actual.find((key) => !expectedSet.has(key));
  if (unknown !== undefined) {
    throw new Error(`${path} has unknown field ${JSON.stringify(unknown)}`);
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    throw new Error(`${path} is missing field ${JSON.stringify(missing)}`);
  }
}

function exactOptionalKeys(value, required, optional, path) {
  rejectUnknownOrMissingKeys(
    value,
    [
      ...required,
      ...optional.filter((key) => Object.hasOwn(value, key)),
    ],
    path,
  );
}

function requireNonblank(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a nonblank string`);
  }
  return value;
}

function requireCanonicalNonblank(value, path) {
  const text = requireNonblank(value, path);
  if (text !== text.trim()) {
    throw new Error(`${path} must be in canonical trimmed form`);
  }
  return text;
}

function validateCanonicalModuleSpecifier(value, path) {
  const specifier = requireCanonicalNonblank(value, path);
  if (
    isAbsolute(specifier) ||
    /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(specifier)
  ) {
    throw new Error(`${path} must be a canonical module specifier`);
  }
  if (!specifier.startsWith('file:')) return specifier;
  let canonical;
  try {
    canonical = pathToFileURL(fileURLToPath(specifier)).href;
  } catch {
    throw new Error(`${path} must be a canonical file URL`);
  }
  if (canonical !== specifier) {
    throw new Error(`${path} must be a canonical file URL`);
  }
  return specifier;
}

function canonicalTimestamp(value, field) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new Error(`Captain session record ${field} must be an ISO timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(
      `Captain session record ${field} must be a canonical ISO timestamp`,
    );
  }
  return value;
}

function timestampFrom(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} generator returned an invalid date`);
  }
  return date.toISOString();
}

function nextTimestamp(value, previous) {
  const candidate = timestampFrom(value, 'session timestamp');
  if (Date.parse(candidate) > Date.parse(previous)) return candidate;
  return new Date(Date.parse(previous) + 1).toISOString();
}

async function readPrivateRegularFile(path, mode, fs, label) {
  await assertPrivateRegularPath(path, mode, fs, label);
  const handle = await fs.open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${label} path is not a regular file`);
    }
    if ((stat.mode & 0o7777) !== mode) {
      throw new Error(`${label} permissions must be ${octal(mode)}`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function assertPrivateRegularPath(path, mode, fs, label) {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} path is not a real regular file`);
  }
  if ((stat.mode & 0o7777) !== mode) {
    throw new Error(`${label} permissions must be ${octal(mode)}`);
  }
  return stat;
}

function octal(mode) {
  return `0${mode.toString(8)}`;
}

async function assertPathMissing(path, fs, message) {
  try {
    await fs.lstat(path);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return;
    throw cause;
  }
  throw new Error(message);
}

async function syncDirectory(path, fs) {
  let directory;
  try {
    directory = await fs.open(path, 'r');
    await directory.sync();
  } finally {
    await directory?.close();
  }
}

async function ensurePrivateDirectory(path, fs) {
  try {
    await assertPrivateDirectory(path, fs);
    return;
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
  }

  const missing = [];
  let cursor = path;
  for (;;) {
    try {
      await assertDirectoryNotLink(cursor, fs);
      break;
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw cause;
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    let created = false;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
    }
    const stat = await assertDirectoryNotLink(directory, fs);
    if (created) {
      await fs.chmod(directory, 0o700);
      await syncDirectory(dirname(directory), fs);
    } else if (
      directory === path &&
      (stat.mode & 0o7777) !== 0o700
    ) {
      throw new Error('Captain session store directory permissions must be 0700');
    }
  }
  await assertPrivateDirectory(path, fs);
}

async function assertPrivateDirectory(path, fs) {
  const stat = await assertDirectoryNotLink(path, fs);
  if ((stat.mode & 0o7777) !== 0o700) {
    throw new Error('Captain session store directory permissions must be 0700');
  }
}

async function assertDirectoryNotLink(path, fs) {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Captain session store path is not a real directory');
  }
  return stat;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
