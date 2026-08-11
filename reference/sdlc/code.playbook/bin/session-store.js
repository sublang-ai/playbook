// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-23: durable headless Captain sessions use one exact settled/uncertain
// record union and one exclusive, crash-recoverable lease per logical session.

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
import { snapshotJsonValue } from '../../../../src/xstate-runtime.js';

export const CAPTAIN_SESSION_RECORD_SCHEMA_VERSION = 2;
export const CAPTAIN_SESSION_RECORD_KIND = 'captain-session';
export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const COMMON_RECORD_KEYS = [
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
const UNCERTAIN_KEYS = [
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
          `Captain session ${JSON.stringify(sessionId)} does not exist`,
        );
      }
      throw new Error(
        `cannot read Captain session ${JSON.stringify(sessionId)}: ${errorMessage(cause)}`,
      );
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `Captain session ${JSON.stringify(sessionId)} is not valid JSON: ${errorMessage(cause)}`,
      );
    }
    const record = validateCaptainSessionRecord(value);
    if (record.sessionId !== sessionId) {
      throw new Error(
        `Captain session file ${JSON.stringify(sessionId)} contains record ` +
          JSON.stringify(record.sessionId),
      );
    }
    return record;
  };

  const read = (sessionId) => readRecord(sessionId);

  const latest = async () => {
    let names;
    try {
      await assertPrivateDirectory(sessionsDir, fs);
      names = await fs.readdir(sessionsDir);
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        throw new Error('no resumable Captain session exists');
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
      candidates.push(await readRecord(sessionId));
    }
    candidates.sort((left, right) => {
      const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (byUpdated !== 0) return byUpdated;
      if (right.sessionId === left.sessionId) return 0;
      return right.sessionId < left.sessionId ? -1 : 1;
    });
    if (candidates.length === 0) {
      throw new Error('no resumable Captain session exists');
    }
    return candidates[0];
  };

  const writeRecord = async (recordValue, { noReplace }) => {
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
          throw new Error(
            `Captain session lease is active in process ${existing.pid}`,
          );
        } catch (cause) {
          if (cause?.code !== 'ESRCH') {
            if (
              cause instanceof Error &&
              cause.message ===
                `Captain session lease is active in process ${existing.pid}`
            ) {
              throw cause;
            }
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

  const beginTurn = ({ input, attemptId, fresh } = {}) =>
    runExclusive(async () => {
      assertAcceptedInput(input);
      assertUuid(attemptId, 'Captain session attempt id');
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
          config: initial.config,
          snapshot: initial.snapshot,
          uncertain: {
            baseUpdatedAt: null,
            input,
            attemptId,
            attemptNumber: 1,
            markedAt: timestamp,
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
          schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
          kind: CAPTAIN_SESSION_RECORD_KIND,
          state: 'uncertain',
          sessionId,
          createdAt: prior.createdAt,
          updatedAt: timestamp,
          cwd: prior.cwd,
          config: prior.config,
          snapshot: prior.snapshot,
          uncertain: {
            baseUpdatedAt: prior.updatedAt,
            input,
            attemptId,
            attemptNumber: 1,
            markedAt: timestamp,
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
        schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
        kind: CAPTAIN_SESSION_RECORD_KIND,
        state: 'uncertain',
        sessionId,
        createdAt: prior.createdAt,
        updatedAt: timestamp,
        cwd: prior.cwd,
        config: prior.config,
        snapshot: prior.snapshot,
        uncertain: {
          baseUpdatedAt: prior.uncertain.baseUpdatedAt,
          input: prior.uncertain.input,
          attemptId: nextAttemptId,
          attemptNumber: prior.uncertain.attemptNumber + 1,
          markedAt: timestamp,
        },
      });
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return record;
    });

  const settle = ({ attemptId, snapshot } = {}) =>
    runExclusive(async () => {
      assertUuid(attemptId, 'Captain session attempt id');
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
        config: prior.config,
        snapshot,
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
        schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
        kind: CAPTAIN_SESSION_RECORD_KIND,
        state: 'settled',
        sessionId,
        createdAt: prior.createdAt,
        updatedAt: prior.uncertain.baseUpdatedAt,
        cwd: prior.cwd,
        config: prior.config,
        snapshot: prior.snapshot,
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
    beginTurn,
    beginRetry,
    settle,
    discard,
    assertOwner,
    release,
  });
}

export function validateCaptainSessionRecord(value) {
  const record = requireRecord(
    snapshotJsonValue(value, 'Captain session record'),
    'Captain session record',
  );
  if (record.state !== 'settled' && record.state !== 'uncertain') {
    throw new Error('Captain session record state is not supported');
  }
  rejectUnknownOrMissingKeys(
    record,
    record.state === 'uncertain'
      ? [...COMMON_RECORD_KEYS, 'uncertain']
      : COMMON_RECORD_KEYS,
    'Captain session record',
  );
  if (record.schemaVersion !== CAPTAIN_SESSION_RECORD_SCHEMA_VERSION) {
    throw new Error(
      `Captain session record schema ${JSON.stringify(record.schemaVersion)} is not supported`,
    );
  }
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

  return record;
}

function validateFreshBoundary(value) {
  const boundary = requireRecord(
    snapshotJsonValue(value, 'fresh Captain session boundary'),
    'fresh Captain session boundary',
  );
  rejectUnknownOrMissingKeys(
    boundary,
    ['cwd', 'config', 'snapshot'],
    'fresh Captain session boundary',
  );
  if (typeof boundary.cwd !== 'string' || !isAbsolute(boundary.cwd)) {
    throw new Error('fresh Captain session cwd must be an absolute path');
  }
  if (resolve(boundary.cwd) !== boundary.cwd) {
    throw new Error('fresh Captain session cwd must be normalized');
  }
  requireRecord(boundary.config, 'fresh Captain session config');
  requireRecord(boundary.snapshot, 'fresh Captain session snapshot');
  return boundary;
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
