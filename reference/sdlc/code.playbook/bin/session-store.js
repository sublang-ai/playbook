// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-23: durable headless Captain sessions use one exact settled/uncertain
// record union and one exclusive, crash-recoverable lease per logical session.
// PBCLI-53: a fresh lease may move its newest same-directory predecessor's
// complete retained-generation map under guarded source-first publication.

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
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
  assertPlaybookEffectLedger,
  assertPlaybookRuntimeSnapshot,
  emptyPlaybookEffectLedger,
  isPlaybookEffectLedgerMonotonicExtension,
  snapshotJsonValue,
} from '../../../../src/xstate-runtime.js';
import {
  assertPlaybookCaptainShellSnapshot,
  assertPlaybookCaptainUnresolvedEffects,
} from '../playbook-captain.js';

export const CAPTAIN_SESSION_RECORD_SCHEMA_VERSION = 6;
export const CAPTAIN_SESSION_RECORD_KIND = 'captain-session';
export const RECORDS_STREAM_VERSION = 1;
const LEGACY_CAPTAIN_SESSION_RECORD_SCHEMA_VERSION = 3;
// The interrupted retention change emitted this required-member shape before
// canonical writes returned to additive schema 3. Both pre-effect shapes and
// the pre-unresolved-effects schema-5 shape are projected in memory only far
// enough to validate malformed data before the effect-authority cutover
// classifies them as nonresumable.
const COMPATIBLE_RETENTION_RECORD_SCHEMA_VERSION = 4;
const PRE_UNRESOLVED_EFFECTS_RECORD_SCHEMA_VERSION = 5;
const CURRENT_ARTIFACT_SCHEMAS = new Set([3]);
const PRE_EFFECT_ARTIFACT_SCHEMAS = new Set([2, 3]);
export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CAPTAIN_SESSION_STRUCTURAL_PROJECTION_SCHEMA_VERSION = 1;
export const CAPTAIN_SESSION_EXECUTION_PROJECTION_SCHEMA_VERSION = 2;

const PLAYER_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const RESERVED_ID = 'captain';
const HOST_CAPABILITIES_OPTION_KEY = 'hostCapabilities';
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
  'effectLedger',
  'unresolvedEffects',
];
const LEGACY_COMMON_RECORD_KEYS = COMMON_RECORD_KEYS.filter(
  (key) => key !== 'effectLedger' && key !== 'unresolvedEffects',
);
const UNCERTAIN_KEYS = [
  'baseUpdatedAt',
  'input',
  'attemptId',
  'attemptNumber',
  'markedAt',
  'attemptedExecutionProjection',
];
const UNCERTAIN_ABANDONMENT_KEYS = [
  'phase',
  'rootPlaybookId',
  'unresolvedEffects',
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
const PLAYBOOK_SESSION_NOT_FOUND = 'PLAYBOOK_SESSION_NOT_FOUND';
const PLAYBOOK_SESSION_LEASE_ACTIVE = 'PLAYBOOK_SESSION_LEASE_ACTIVE';
const ACTIVE_LEASE_ERROR = Symbol('active Playbook session lease');
const DEFAULT_FS_OPERATIONS = Object.freeze({
  access,
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
const EMPTY_REPLAY_PREFIX_DIGEST = createHash('sha256').digest('hex');
const REPLAY_READ_CHUNK_SIZE = 64 * 1024;

class ReplaySnapshotChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplaySnapshotChangedError';
  }
}

class CaptainSessionRecordSchemaError extends Error {
  constructor(schemaVersion, message, cause) {
    super(message);
    this.name = 'CaptainSessionRecordSchemaError';
    this.schemaVersion = schemaVersion;
    this.cause = cause;
  }
}

class CaptainSessionRecordNonresumableError extends
  CaptainSessionRecordSchemaError {
  constructor(schemaVersion, message, orderingBoundary, cause) {
    super(schemaVersion, message, cause);
    this.name = 'CaptainSessionRecordNonresumableError';
    this.orderingBoundary = orderingBoundary;
  }
}

class CaptainSessionNotFoundError extends Error {
  constructor(sessionId, path) {
    super(
      `Captain session ${JSON.stringify(sessionId)} at ${JSON.stringify(path)} does not exist`,
    );
    this.name = 'CaptainSessionNotFoundError';
    this.code = PLAYBOOK_SESSION_NOT_FOUND;
  }
}

class CaptainSessionLeaseActiveError extends Error {
  constructor(sessionId, pid) {
    super(
      `cannot acquire Captain session ${JSON.stringify(sessionId)} lease: Captain session lease is active in process ${pid}`,
    );
    this.name = 'CaptainSessionLeaseActiveError';
    this.code = PLAYBOOK_SESSION_LEASE_ACTIVE;
    this[ACTIVE_LEASE_ERROR] = true;
    this.sessionId = sessionId;
    this.pid = pid;
  }
}

function foreignCaptainSessionLeaseActiveError(sessionId, hostname) {
  const error = new Error(
    `Captain session ${JSON.stringify(sessionId)} lease is owned by foreign host ${JSON.stringify(hostname)}`,
  );
  error.code = PLAYBOOK_SESSION_LEASE_ACTIVE;
  error[ACTIVE_LEASE_ERROR] = true;
  return error;
}

function isActiveLeaseError(value) {
  return value?.[ACTIVE_LEASE_ERROR] === true;
}

export function defaultCaptainSessionsDir(
  env = process.env,
  home = env.HOME ?? homedir(),
) {
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return join(stateHome, 'playbook', 'sessions');
}

// PBCLI-78: front-end bootstrap checks the same private filesystem boundary
// as later store operations without creating an otherwise-unused directory.
// A missing leaf is usable because the first lease publication creates it.
export async function assertCaptainSessionsDirectoryUsable(
  sessionsDir,
  options = {},
) {
  if (typeof sessionsDir !== 'string' || !isAbsolute(sessionsDir)) {
    throw new Error('Captain session store path must be absolute');
  }
  const fs = { ...DEFAULT_FS_OPERATIONS, ...(options.fsOps ?? {}) };
  try {
    await assertPrivateDirectory(sessionsDir, fs);
    await fs.access(
      sessionsDir,
      constants.R_OK | constants.W_OK | constants.X_OK,
    );
    return;
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
  }

  // Reject a symlink or non-directory anywhere in an otherwise missing path;
  // mode 0700 becomes mandatory once the sessions directory itself exists.
  let cursor = sessionsDir;
  for (;;) {
    try {
      await assertDirectoryNotLink(cursor, fs);
      await fs.access(cursor, constants.W_OK | constants.X_OK);
      return;
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
      const parent = dirname(cursor);
      if (parent === cursor) throw cause;
      cursor = parent;
    }
  }
}

// PBCLI-73: caller-shape rejection precedes the PBCLI-75 sanitizer so Task 3
// can keep non-latching argument errors distinct from latching data failures.
export function assertReplayAppendArguments(record, role) {
  if (
    typeof record !== 'object' ||
    record === null ||
    Array.isArray(record)
  ) {
    throw new TypeError('replay append record must be an object');
  }
  if (
    role !== undefined &&
    (typeof role !== 'string' || role.length === 0)
  ) {
    throw new TypeError('replay append role must be a nonempty string');
  }
  return record;
}

export function sanitizeReplayRecord(value) {
  const sanitized = sanitizeReplayValue(value, 'replay record', new Set());
  return requireRecord(sanitized, 'replay record');
}

// PBCLI-75/76/83: one lease-owned writer repairs the retained prefix, queues
// appends, and keeps replay durability fail-soft beside canonical settlement.
async function createLeaseReplayWriter({
  sessionsDir,
  path,
  fs,
  assertOwner,
  readStream,
}) {
  let lastReadableSeq = null;
  let lastDurableSeq = null;
  let incomplete = true;
  let identity;
  let completeOffset = 0;
  let writerHandle;
  let operationTail = Promise.resolve();
  let appendAdmissionClosed = false;

  const status = () =>
    Object.freeze({ lastReadableSeq, lastDurableSeq, incomplete });

  const enqueue = (operation) => {
    const result = operationTail.then(operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const latch = () => {
    if (lastReadableSeq !== null) incomplete = true;
  };

  const updateReadableFromDisk = async () => {
    if (lastReadableSeq === null) return;
    try {
      const snapshot = await readReplayWriterSnapshot({
        sessionsDir,
        path,
        identity,
        fs,
      });
      if (snapshot.absent) return;
      const parsed = parseReplayLines(
        snapshot.bytes,
        0,
        EMPTY_REPLAY_PREFIX_DIGEST,
      );
      lastReadableSeq = parsed.sequence;
      completeOffset = parsed.completeBytes;
      identity = snapshot.identity;
    } catch {
      // The already-established boundary remains the only trustworthy one.
    }
  };

  const initialize = async () => {
    let snapshot;
    await assertOwner();
    try {
      snapshot = await readReplayWriterSnapshot({
        sessionsDir,
        path,
        fs,
      });
      if (snapshot.absent) {
        lastReadableSeq = 0;
        lastDurableSeq = 0;
        incomplete = false;
        completeOffset = 0;
        return;
      }

      const parsed = parseReplayLines(
        snapshot.bytes,
        0,
        EMPTY_REPLAY_PREFIX_DIGEST,
      );
      const prefixSequence = parsed.sequence;
      lastReadableSeq = prefixSequence;
      lastDurableSeq = prefixSequence;
      incomplete = false;
      identity = snapshot.identity;
      completeOffset = parsed.completeBytes;
      const tail = snapshot.bytes.subarray(parsed.completeBytes);
      if (tail.length === 0) return;

      let retainTail = false;
      try {
        parseReplayEnvelope(tail, prefixSequence + 1);
        retainTail = true;
      } catch {
        // Every other torn tail is discarded at the complete-prefix boundary.
      }

      if (retainTail) {
        try {
          writerHandle = await mutateReplayWriterFile({
            sessionsDir,
            path,
            identity,
            expectedSize: snapshot.bytes.length,
            expectedFinalSize: snapshot.bytes.length + 1,
            fs,
            retainHandle: true,
            operation: async (handle) => {
              await writeReplayRange(
                handle,
                Buffer.from('\n'),
                snapshot.bytes.length,
              );
              completeOffset = snapshot.bytes.length + 1;
              lastReadableSeq = prefixSequence + 1;
              await handle.sync();
            },
          });
          lastDurableSeq = prefixSequence + 1;
        } catch {
          await updateReadableFromDisk();
          latch();
        }
        return;
      }

      try {
        writerHandle = await mutateReplayWriterFile({
          sessionsDir,
          path,
          identity,
          expectedSize: snapshot.bytes.length,
          expectedFinalSize: parsed.completeBytes,
          fs,
          retainHandle: true,
          operation: async (handle) => {
            await handle.truncate(parsed.completeBytes);
            completeOffset = parsed.completeBytes;
            await handle.sync();
          },
        });
      } catch {
        await updateReadableFromDisk();
        latch();
      }
    } catch {
      lastReadableSeq = null;
      lastDurableSeq = null;
      incomplete = true;
      identity = undefined;
      completeOffset = 0;
    }
  };

  const appendAtQueueHead = async (record, role) => {
    if (lastReadableSeq === null || incomplete) return undefined;

    let sanitized;
    let sanitizationFailed = false;
    let sanitizationFailure;
    try {
      sanitized = sanitizeReplayRecord(record);
    } catch (cause) {
      sanitizationFailed = true;
      sanitizationFailure = cause;
    }
    // Sanitization may invoke caller-controlled Proxy traps. This one owner
    // check is the append's cooperative-lease linearization point.
    await assertOwner();
    if (sanitizationFailed) {
      latch();
      throw sanitizationFailure;
    }

    if (lastReadableSeq >= Number.MAX_SAFE_INTEGER) {
      latch();
      throw new Error('replay stream sequence exhausted its safe integer range');
    }
    const sequence = lastReadableSeq + 1;
    const line = Buffer.from(
      `${JSON.stringify({
        v: RECORDS_STREAM_VERSION,
        seq: sequence,
        ...(role === undefined ? {} : { role }),
        record: sanitized,
      })}\n`,
    );
    const publishing = identity === undefined;
    try {
      if (publishing) {
        const published = await publishReplayWriterFile({
          sessionsDir,
          path,
          bytes: line,
          fs,
        });
        identity = published.identity;
        writerHandle = published.handle;
        completeOffset = line.length;
        lastReadableSeq = sequence;
        await syncDirectory(sessionsDir, fs);
      } else if (writerHandle === undefined) {
        writerHandle = await mutateReplayWriterFile({
          sessionsDir,
          path,
          identity,
          expectedSize: completeOffset,
          expectedFinalSize: completeOffset + line.length,
          fs,
          retainHandle: true,
          operation: (handle) =>
            writeReplayRange(handle, line, completeOffset),
        });
        completeOffset += line.length;
        lastReadableSeq = sequence;
      } else {
        await appendReplayWriterFile({
          handle: writerHandle,
          identity,
          expectedSize: completeOffset,
          bytes: line,
        });
        completeOffset += line.length;
        lastReadableSeq = sequence;
      }
      return undefined;
    } catch (cause) {
      await updateReadableFromDisk();
      latch();
      throw cause;
    }
  };

  const append = (record, role) => {
    if (appendAdmissionClosed) {
      return Promise.reject(
        new Error('replay append admission is closed for release'),
      );
    }
    if (lastReadableSeq === null || incomplete) return Promise.resolve();
    try {
      assertReplayAppendArguments(record, role);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return enqueue(() => appendAtQueueHead(record, role));
  };

  const read = (options) => {
    if (appendAdmissionClosed) {
      return Promise.reject(new Error('replay writer is closing'));
    }
    return enqueue(async () => {
      await assertOwner();
      if (lastReadableSeq === null) {
        throw new Error('replay stream is unavailable for this lease');
      }
      const result = await readStream(options);
      lastReadableSeq = result.lastReadableSeq;
      return freezeReplayLeaseReadResult(
        result.entries,
        lastReadableSeq,
        lastDurableSeq,
        incomplete,
      );
    });
  };

  const checkpointAtQueueHead = async () => {
    if (
      lastReadableSeq === null ||
      incomplete ||
      lastReadableSeq === lastDurableSeq
    ) {
      return;
    }
    try {
      await assertOwner();
      if (writerHandle === undefined) {
        throw new Error('replay stream checkpoint has no writer handle');
      }
      await checkpointReplayWriterFile({
        sessionsDir,
        path,
        handle: writerHandle,
        identity,
        expectedSize: completeOffset,
        fs,
      });
      await assertOwner();
      lastDurableSeq = lastReadableSeq;
    } catch {
      await updateReadableFromDisk();
      latch();
    }
  };

  const checkpoint = () => enqueue(checkpointAtQueueHead);

  const closeAppendAdmission = () => {
    appendAdmissionClosed = true;
  };

  const prepareRelease = () =>
    enqueue(async () => {
      try {
        await checkpointAtQueueHead();
      } finally {
        const handle = writerHandle;
        writerHandle = undefined;
        try {
          await handle?.close();
        } catch {
          // A completed checkpoint owns durability; descriptor cleanup cannot
          // broaden the latch trigger set or block canonical lease retirement.
        }
      }
    });

  await initialize();
  return Object.freeze({
    append,
    read,
    status,
    checkpoint,
    closeAppendAdmission,
    prepareRelease,
  });
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
  const replayReadCursors = new Map();
  const replayReadQueues = new Map();

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
  const recordsPathFor = (sessionId) => {
    assertSessionId(sessionId);
    return join(sessionsDir, `${sessionId}.records.jsonl`);
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
        throw new CaptainSessionNotFoundError(sessionId, path);
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
        const nonresumable =
          cause instanceof CaptainSessionRecordNonresumableError;
        if (
          nonresumable &&
          value.sessionId !== sessionId
        ) {
          throw new Error(
            `Captain session file ${JSON.stringify(path)} contains record ` +
              JSON.stringify(value.sessionId),
          );
        }
        if (nonresumable) {
          throw new CaptainSessionRecordNonresumableError(
            cause.schemaVersion,
            `${context}: ${cause.message}`,
            cause.orderingBoundary,
            cause,
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

  const readStream = async (sessionId, options) => {
    assertSessionId(sessionId);
    const afterSeq = validateReplayReadOptions(options);
    const previous = replayReadQueues.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(() =>
      readReplayStream({
        sessionsDir,
        path: recordsPathFor(sessionId),
        afterSeq,
        cursor: replayReadCursors.get(sessionId),
        fs,
      }),
    );
    const drained = operation.then(
      (result) => {
        if (result.cursor === undefined) {
          replayReadCursors.delete(sessionId);
        } else {
          replayReadCursors.set(sessionId, result.cursor);
        }
        return undefined;
      },
      () => undefined,
    );
    replayReadQueues.set(sessionId, drained);
    void drained.then(() => {
      if (replayReadQueues.get(sessionId) === drained) {
        replayReadQueues.delete(sessionId);
      }
    });
    const result = await operation;
    return result.value;
  };

  const listRecords = async ({
    onLegacyRecord,
    onLegacyOrderingBoundary,
    onInvalidRecord,
    skipInvalidRecords = false,
  } = {}) => {
    if (
      onLegacyRecord !== undefined &&
      typeof onLegacyRecord !== 'function'
    ) {
      throw new Error(
        'Captain session legacy-record observer must be a function',
      );
    }
    if (
      onLegacyOrderingBoundary !== undefined &&
      typeof onLegacyOrderingBoundary !== 'function'
    ) {
      throw new Error(
        'Captain session legacy ordering-boundary observer must be a function',
      );
    }
    if (
      onInvalidRecord !== undefined &&
      typeof onInvalidRecord !== 'function'
    ) {
      throw new Error(
        'Captain session invalid-record observer must be a function',
      );
    }
    if (typeof skipInvalidRecords !== 'boolean') {
      throw new Error(
        'Captain session invalid-record skip option must be a boolean',
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
        if (error instanceof CaptainSessionRecordNonresumableError) {
          await onLegacyOrderingBoundary?.(error.orderingBoundary);
          await onLegacyRecord?.(
            Object.freeze({
              sessionId,
              path: recordPathFor(sessionId),
              schemaVersion: error.schemaVersion,
            }),
          );
          continue;
        }
        if (skipInvalidRecords) {
          await onInvalidRecord?.(
            Object.freeze({
              sessionId,
              path: recordPathFor(sessionId),
              reason: errorMessage(error),
            }),
          );
          continue;
        }
        throw error;
      }
    }
    return candidates;
  };

  const latest = async ({ onLegacyRecord, preferredCwd } = {}) => {
    const candidates = sortCaptainSessionRecords(
      await listRecords({ onLegacyRecord }),
    );
    if (candidates.length === 0) {
      throw new Error('no resumable Captain session exists');
    }
    return (
      candidates.find((candidate) => candidate.cwd === preferredCwd) ??
      candidates[0]
    );
  };

  const readSummary = async (sessionId) =>
    projectPlaybookSessionSummary(await readRecord(sessionId));

  const listSummaries = async () => {
    const skipped = [];
    const records = await listRecords({
      onLegacyRecord: ({ sessionId, schemaVersion }) => {
        skipped.push(
          Object.freeze({
            sessionId,
            reason:
              `Captain session schema ${schemaVersion} is below current ` +
              `schema ${CAPTAIN_SESSION_RECORD_SCHEMA_VERSION}`,
          }),
        );
      },
      onInvalidRecord: ({ sessionId, reason }) => {
        skipped.push(Object.freeze({ sessionId, reason }));
      },
      skipInvalidRecords: true,
    });
    return Object.freeze({
      sessions: Object.freeze(
        sortCaptainSessionRecords(records).map(projectPlaybookSessionSummary),
      ),
      skipped: Object.freeze(
        skipped.sort((left, right) =>
          left.sessionId.localeCompare(right.sessionId),
        ),
      ),
    });
  };

  const scanAdoptionPredecessor = async (
    target,
    { onLegacyRecord, onInvalidRecord } = {},
  ) => {
    let orderingUnproved = false;
    const legacyOrderingBoundaries = [];
    const observeInvalid = async (record) => {
      orderingUnproved = true;
      await onInvalidRecord?.(record);
    };
    const records = await listRecords({
      onLegacyRecord,
      onLegacyOrderingBoundary: (record) => {
        legacyOrderingBoundaries.push(record);
      },
      onInvalidRecord: observeInvalid,
      skipInvalidRecords: true,
    });
    const resumableCandidates = records.filter(
      (candidate) =>
        candidate.sessionId !== target.sessionId &&
        candidate.state === 'settled' &&
        candidate.cwd === target.cwd,
    );
    const resumableById = new Map(
      resumableCandidates.map((candidate) => [candidate.sessionId, candidate]),
    );
    const orderedBoundaries = sortCaptainSessionRecords([
      ...resumableCandidates,
      ...legacyOrderingBoundaries.filter(
        (candidate) =>
          candidate.sessionId !== target.sessionId &&
          candidate.state === 'settled' &&
          candidate.cwd === target.cwd,
      ),
    ]);
    const newestBoundary = orderedBoundaries[0];
    const candidate =
      orderingUnproved || newestBoundary === undefined
        ? undefined
        : resumableById.get(newestBoundary.sessionId);
    const adoptionDeclined =
      orderingUnproved ||
      (newestBoundary !== undefined && candidate === undefined);
    // A fully validated legacy record has a trustworthy place in the
    // same-cwd predecessor order even though it cannot resume. Only a record
    // whose contents cannot be validated leaves that order globally unproved.
    return {
      candidate,
      newestBoundaryUpdatedAt: newestBoundary?.updatedAt,
      adoptionDeclined,
    };
  };

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

  const activeLeaseErrorFor = async (sessionId, owner) => {
    if (owner.hostname !== localHostname) {
      return foreignCaptainSessionLeaseActiveError(
        sessionId,
        owner.hostname,
      );
    }
    try {
      await probeProcess(owner.pid);
      return new CaptainSessionLeaseActiveError(sessionId, owner.pid);
    } catch (cause) {
      if (cause?.code === 'ESRCH') return undefined;
      throw new Error(
        `Captain session lease owner process cannot be ruled dead: ${errorMessage(cause)}`,
      );
    }
  };

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
    try {
      await assertPathMissing(
        canonicalPath,
        fs,
        'Captain session lease became active before publication',
      );
      // Program-created canonical lease directories are nonempty. Therefore a
      // racing rename cannot replace one; it fails closed instead. Static empty
      // or malformed destinations are rejected by the preflight above.
      await fs.rename(stage.stagePath, canonicalPath);
      onRenamed();
    } catch (cause) {
      try {
        const winner = await readLeaseOwner(sessionId);
        const active = await activeLeaseErrorFor(sessionId, winner);
        if (active !== undefined) throw active;
      } catch (winnerCause) {
        if (isActiveLeaseError(winnerCause)) {
          throw winnerCause;
        }
      }
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
        const active = await activeLeaseErrorFor(sessionId, existing);
        if (active !== undefined) throw active;
        await retireObservedLease(sessionId, existing);
      } else {
        // Preserve the explicit local solely for easier audit of the no-owner
        // publication boundary.
        void canonicalPath;
      }

      await publishLeaseStage(sessionId, stage, () => {
        stagePublished = true;
      });
      return await createLease({
        sessionId,
        owner: stage.owner,
        sessionsDir,
        replayPath: recordsPathFor(sessionId),
        replayFs: fs,
        readReplayStream: (options) => readStream(sessionId, options),
        readRecord,
        writeRecord,
        syncRecordDirectory: () => syncDirectory(sessionsDir, fs),
        deleteRecord,
        scanAdoptionPredecessor,
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
      if (isActiveLeaseError(cause)) throw cause;
      throw new Error(
        `cannot acquire Captain session ${JSON.stringify(sessionId)} lease: ${errorMessage(cause)}`,
      );
    }
  };

  return Object.freeze({
    sessionsDir,
    listSummaries,
    readSummary,
    read,
    readStream,
    latest,
    acquire,
  });
}

async function readReplayStream({
  sessionsDir,
  path,
  afterSeq,
  cursor,
  fs,
}) {
  let forceFullRead = false;
  let snapshot;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      snapshot = await readReplaySnapshot({
        sessionsDir,
        path,
        afterSeq,
        cursor,
        forceFullRead,
        fs,
      });
      break;
    } catch (cause) {
      if (!(cause instanceof ReplaySnapshotChangedError) || attempt === 1) {
        throw cause;
      }
      if (cursor !== undefined) cursor.reusable = false;
      forceFullRead = true;
    }
  }

  if (snapshot === undefined) {
    throw new Error('replay stream changed during both read snapshots');
  }
  if (snapshot.absent) {
    if (cursor !== undefined) cursor.reusable = false;
    if (cursor !== undefined && cursor.sequence > 0) {
      throw new Error('replay stream rolled back below its observed prefix');
    }
    if (afterSeq !== 0) {
      throw new Error(
        `replay stream afterSeq ${afterSeq} exceeds last readable sequence 0`,
      );
    }
    return {
      cursor: undefined,
      value: freezeReplayReadResult([], 0),
    };
  }

  const initialSequence = snapshot.incremental ? cursor.sequence : 0;
  const initialDigest = snapshot.incremental
    ? cursor.digest
    : EMPTY_REPLAY_PREFIX_DIGEST;
  const parsed = parseReplayLines(
    snapshot.bytes,
    initialSequence,
    initialDigest,
    snapshot.incremental ? undefined : cursor?.sequence,
  );
  const lastReadableSeq = parsed.sequence;

  if (!snapshot.incremental && cursor !== undefined && cursor.sequence > 0) {
    if (
      lastReadableSeq < cursor.sequence ||
      parsed.observedDigest !== cursor.digest
    ) {
      throw new Error('replay stream rolled back or changed its observed prefix');
    }
  }
  if (afterSeq > lastReadableSeq) {
    throw new Error(
      `replay stream afterSeq ${afterSeq} exceeds last readable sequence ${lastReadableSeq}`,
    );
  }

  const completeOffset = snapshot.startOffset + parsed.completeBytes;
  const nextCursor = {
    identity: snapshot.identity,
    offset: completeOffset,
    sequence: lastReadableSeq,
    digest: parsed.digest,
    reusable: true,
  };
  const entries = parsed.entries.filter((entry) => entry.seq > afterSeq);
  return {
    cursor: nextCursor,
    value: freezeReplayReadResult(entries, lastReadableSeq),
  };
}

async function readReplaySnapshot({
  sessionsDir,
  path,
  afterSeq,
  cursor,
  forceFullRead,
  fs,
}) {
  try {
    await assertPrivateDirectory(sessionsDir, fs);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { absent: true };
    throw cause;
  }

  let pathStat;
  try {
    pathStat = await assertPrivateRegularPath(path, 0o600, fs, 'replay stream');
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { absent: true };
    throw cause;
  }

  let handle;
  try {
    handle = await fs.open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new ReplaySnapshotChangedError(
        'replay stream disappeared while opening its snapshot',
      );
    }
    throw cause;
  }

  try {
    const openedStat = await handle.stat();
    assertPrivateRegularStat(openedStat, 0o600, 'replay stream');
    if (!sameFileIdentity(pathStat, openedStat)) {
      throw new ReplaySnapshotChangedError(
        'replay stream was replaced while opening its snapshot',
      );
    }
    const snapshotLength = requireReplayFileSize(openedStat.size);
    const identity = replayFileIdentity(openedStat);
    const cursorBoundaryChanged =
      cursor !== undefined &&
      (!sameReplayIdentity(cursor.identity, identity) ||
        snapshotLength < cursor.offset);
    if (cursorBoundaryChanged) cursor.reusable = false;
    const incremental =
      !forceFullRead &&
      cursor !== undefined &&
      cursor.reusable &&
      sameReplayIdentity(cursor.identity, identity) &&
      snapshotLength >= cursor.offset &&
      afterSeq >= cursor.sequence;
    const startOffset = incremental ? cursor.offset : 0;
    const bytes = await readReplayRange(handle, startOffset, snapshotLength);

    const finalHandleStat = await handle.stat();
    assertPrivateRegularStat(finalHandleStat, 0o600, 'replay stream');
    if (
      !sameFileIdentity(openedStat, finalHandleStat) ||
      requireReplayFileSize(finalHandleStat.size) < snapshotLength
    ) {
      throw new ReplaySnapshotChangedError(
        'replay stream was truncated within its pinned snapshot',
      );
    }

    let finalPathStat;
    try {
      finalPathStat = await assertPrivateRegularPath(
        path,
        0o600,
        fs,
        'replay stream',
      );
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        throw new ReplaySnapshotChangedError(
          'replay stream disappeared within its pinned snapshot',
        );
      }
      throw cause;
    }
    if (!sameFileIdentity(openedStat, finalPathStat)) {
      throw new ReplaySnapshotChangedError(
        'replay stream was replaced within its pinned snapshot',
      );
    }
    await assertPrivateDirectory(sessionsDir, fs);

    return {
      absent: false,
      bytes,
      identity,
      incremental,
      startOffset,
    };
  } finally {
    await handle.close();
  }
}

async function readReplayRange(handle, start, end) {
  const buffer = Buffer.allocUnsafe(end - start);
  let offset = 0;
  while (offset < buffer.length) {
    const length = Math.min(REPLAY_READ_CHUNK_SIZE, buffer.length - offset);
    const result = await handle.read(buffer, offset, length, start + offset);
    if (
      result === null ||
      typeof result !== 'object' ||
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead <= 0 ||
      result.bytesRead > length
    ) {
      throw new ReplaySnapshotChangedError(
        'replay stream ended before its pinned snapshot boundary',
      );
    }
    offset += result.bytesRead;
  }
  return buffer;
}

async function writeReplayRange(handle, bytes, start) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      start + offset,
    );
    if (
      result === null ||
      typeof result !== 'object' ||
      !Number.isSafeInteger(result.bytesWritten) ||
      result.bytesWritten <= 0 ||
      result.bytesWritten > bytes.length - offset
    ) {
      throw new Error('replay stream append did not write its complete bytes');
    }
    offset += result.bytesWritten;
  }
}

async function readReplayWriterSnapshot({
  sessionsDir,
  path,
  identity,
  fs,
}) {
  await assertPrivateDirectory(sessionsDir, fs);
  let pathStat;
  try {
    pathStat = await assertPrivateRegularPath(path, 0o600, fs, 'replay stream');
  } catch (cause) {
    if (cause?.code === 'ENOENT' && identity === undefined) {
      return { absent: true };
    }
    throw cause;
  }
  let handle;
  try {
    handle = await fs.open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const openedStat = await handle.stat();
    assertPrivateRegularStat(openedStat, 0o600, 'replay stream');
    if (
      !sameFileIdentity(pathStat, openedStat) ||
      (identity !== undefined && !sameReplayIdentity(identity, openedStat))
    ) {
      throw new Error('replay stream identity changed for its writer');
    }
    const size = requireReplayFileSize(openedStat.size);
    const bytes = await readReplayRange(handle, 0, size);
    const finalHandleStat = await handle.stat();
    assertPrivateRegularStat(finalHandleStat, 0o600, 'replay stream');
    if (
      !sameFileIdentity(openedStat, finalHandleStat) ||
      requireReplayFileSize(finalHandleStat.size) !== size
    ) {
      throw new Error('replay stream changed during writer validation');
    }
    const finalPathStat = await assertPrivateRegularPath(
      path,
      0o600,
      fs,
      'replay stream',
    );
    if (!sameFileIdentity(openedStat, finalPathStat)) {
      throw new Error('replay stream path changed during writer validation');
    }
    await assertPrivateDirectory(sessionsDir, fs);
    return {
      absent: false,
      bytes,
      identity: replayFileIdentity(openedStat),
    };
  } finally {
    await handle?.close();
  }
}

async function mutateReplayWriterFile({
  sessionsDir,
  path,
  identity,
  expectedSize,
  expectedFinalSize,
  fs,
  retainHandle = false,
  operation,
}) {
  await assertPrivateDirectory(sessionsDir, fs);
  const pathStat = await assertPrivateRegularPath(
    path,
    0o600,
    fs,
    'replay stream',
  );
  if (!sameReplayIdentity(identity, pathStat)) {
    throw new Error('replay stream identity changed for its writer');
  }
  let handle;
  try {
    handle = await fs.open(
      path,
      constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const openedStat = await handle.stat();
    assertPrivateRegularStat(openedStat, 0o600, 'replay stream');
    if (
      !sameFileIdentity(pathStat, openedStat) ||
      !sameReplayIdentity(identity, openedStat) ||
      requireReplayFileSize(openedStat.size) !== expectedSize
    ) {
      throw new Error('replay stream changed before writer mutation');
    }
    await operation(handle);
    const finalStat = await handle.stat();
    assertPrivateRegularStat(finalStat, 0o600, 'replay stream');
    if (
      !sameFileIdentity(openedStat, finalStat) ||
      (expectedFinalSize !== undefined &&
        requireReplayFileSize(finalStat.size) !== expectedFinalSize)
    ) {
      throw new Error('replay stream changed during writer mutation');
    }
    const finalPathStat = await assertPrivateRegularPath(
      path,
      0o600,
      fs,
      'replay stream',
    );
    if (!sameFileIdentity(openedStat, finalPathStat)) {
      throw new Error('replay stream path changed during writer mutation');
    }
    await assertPrivateDirectory(sessionsDir, fs);
    if (retainHandle) {
      const retained = handle;
      handle = undefined;
      return retained;
    }
  } finally {
    await handle?.close();
  }
}

async function appendReplayWriterFile({
  handle,
  identity,
  expectedSize,
  bytes,
}) {
  const openedStat = await handle.stat();
  assertPrivateRegularStat(openedStat, 0o600, 'replay stream');
  if (
    !sameReplayIdentity(identity, openedStat) ||
    requireReplayFileSize(openedStat.size) !== expectedSize
  ) {
    throw new Error('replay stream changed before writer append');
  }
  await writeReplayRange(handle, bytes, expectedSize);
}

async function checkpointReplayWriterFile({
  sessionsDir,
  path,
  handle,
  identity,
  expectedSize,
  fs,
}) {
  await assertPrivateDirectory(sessionsDir, fs);
  const pathStat = await assertPrivateRegularPath(
    path,
    0o600,
    fs,
    'replay stream',
  );
  const openedStat = await handle.stat();
  assertPrivateRegularStat(openedStat, 0o600, 'replay stream');
  if (
    !sameFileIdentity(pathStat, openedStat) ||
    !sameReplayIdentity(identity, openedStat) ||
    requireReplayFileSize(openedStat.size) !== expectedSize
  ) {
    throw new Error('replay stream changed before writer checkpoint');
  }
  await handle.sync();
  const finalStat = await handle.stat();
  assertPrivateRegularStat(finalStat, 0o600, 'replay stream');
  if (
    !sameFileIdentity(openedStat, finalStat) ||
    requireReplayFileSize(finalStat.size) !== expectedSize
  ) {
    throw new Error('replay stream changed during writer checkpoint');
  }
  const finalPathStat = await assertPrivateRegularPath(
    path,
    0o600,
    fs,
    'replay stream',
  );
  if (!sameFileIdentity(openedStat, finalPathStat)) {
    throw new Error('replay stream path changed during writer checkpoint');
  }
  await assertPrivateDirectory(sessionsDir, fs);
}

async function publishReplayWriterFile({ sessionsDir, path, bytes, fs }) {
  await assertPrivateDirectory(sessionsDir, fs);
  let handle;
  try {
    handle = await fs.open(
      path,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    const openedStat = await handle.stat();
    assertPrivateRegularStat(openedStat, 0o600, 'replay stream');
    if (requireReplayFileSize(openedStat.size) !== 0) {
      throw new Error('new replay stream is not empty');
    }
    await writeReplayRange(handle, bytes, 0);
    const finalStat = await handle.stat();
    assertPrivateRegularStat(finalStat, 0o600, 'replay stream');
    if (
      !sameFileIdentity(openedStat, finalStat) ||
      requireReplayFileSize(finalStat.size) !== bytes.length
    ) {
      throw new Error('new replay stream did not retain its complete append');
    }
    const pathStat = await assertPrivateRegularPath(
      path,
      0o600,
      fs,
      'replay stream',
    );
    if (!sameFileIdentity(openedStat, pathStat)) {
      throw new Error('new replay stream path changed during publication');
    }
    await assertPrivateDirectory(sessionsDir, fs);
    const retained = handle;
    handle = undefined;
    return {
      handle: retained,
      identity: replayFileIdentity(openedStat),
    };
  } finally {
    await handle?.close();
  }
}

function parseReplayLines(bytes, initialSequence, initialDigest, observedSeq) {
  const entries = [];
  let sequence = initialSequence;
  let digest = initialDigest;
  let observedDigest = observedSeq === 0 ? initialDigest : undefined;
  let lineStart = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const line = bytes.subarray(lineStart, index);
    const entry = parseReplayEnvelope(line, sequence + 1);
    sequence = entry.seq;
    digest = digestReplayEntry(digest, entry);
    if (sequence === observedSeq) observedDigest = digest;
    entries.push(entry);
    lineStart = index + 1;
  }

  return {
    completeBytes: lineStart,
    digest,
    entries,
    observedDigest,
    sequence,
  };
}

function parseReplayEnvelope(bytes, expectedSequence) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(
      `replay stream sequence ${expectedSequence} is not valid UTF-8: ${errorMessage(cause)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `replay stream sequence ${expectedSequence} is not valid JSON: ${errorMessage(cause)}`,
    );
  }
  const envelope = requireRecord(
    snapshotJsonValue(parsed, `replay stream sequence ${expectedSequence}`),
    `replay stream sequence ${expectedSequence}`,
  );
  exactOptionalKeys(
    envelope,
    ['v', 'seq', 'record'],
    ['role'],
    `replay stream sequence ${expectedSequence}`,
  );
  if (envelope.v !== RECORDS_STREAM_VERSION) {
    throw new Error(
      `replay stream sequence ${expectedSequence} version must be ${RECORDS_STREAM_VERSION}`,
    );
  }
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= 0) {
    throw new Error(
      `replay stream sequence ${expectedSequence} seq must be a positive safe integer`,
    );
  }
  if (envelope.seq !== expectedSequence) {
    throw new Error(
      `replay stream expected sequence ${expectedSequence}, received ${envelope.seq}`,
    );
  }
  if (envelope.role !== undefined && typeof envelope.role !== 'string') {
    throw new Error(
      `replay stream sequence ${expectedSequence} role must be a string`,
    );
  }
  requireRecord(
    envelope.record,
    `replay stream sequence ${expectedSequence} record`,
  );
  return envelope;
}

function validateReplayReadOptions(options) {
  if (
    options === undefined ||
    isExactUndefinedReplayReadOption(options)
  ) {
    return 0;
  }
  const value = requireRecord(
    snapshotJsonValue(options, 'replay stream read options'),
    'replay stream read options',
  );
  exactOptionalKeys(value, [], ['afterSeq'], 'replay stream read options');
  const afterSeq = Object.hasOwn(value, 'afterSeq') ? value.afterSeq : 0;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error(
      'replay stream read options afterSeq must be a nonnegative safe integer',
    );
  }
  return afterSeq;
}

function isExactUndefinedReplayReadOption(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== 'afterSeq') return false;
  const descriptor = descriptors.afterSeq;
  return (
    descriptor.enumerable &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value === undefined
  );
}

function freezeReplayReadResult(entries, lastReadableSeq) {
  return Object.freeze({
    entries: Object.freeze(entries),
    lastReadableSeq,
  });
}

function projectPlaybookSessionSummary(record) {
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    sessionId: record.sessionId,
    state: record.state,
    cwd: record.cwd,
    updatedAt: record.updatedAt,
  });
}

function freezeReplayLeaseReadResult(
  entries,
  lastReadableSeq,
  lastDurableSeq,
  incomplete,
) {
  return Object.freeze({
    entries: Object.freeze(entries),
    lastReadableSeq,
    lastDurableSeq,
    incomplete,
  });
}

function replayFileIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameReplayIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireReplayFileSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('replay stream size must be a nonnegative safe integer');
  }
  return value;
}

function assertPrivateRegularStat(stat, mode, label) {
  if (!stat.isFile()) {
    throw new Error(`${label} path is not a regular file`);
  }
  if ((stat.mode & 0o7777) !== mode) {
    throw new Error(`${label} permissions must be ${octal(mode)}`);
  }
}

function digestReplayEntry(previous, entry) {
  return createHash('sha256')
    .update(previous)
    .update('\u0000')
    .update(canonicalReplayJson(entry))
    .digest('hex');
}

function canonicalReplayJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalReplayJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalReplayJson(value[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sanitizeReplayValue(value, path, ancestors) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain a finite JSON number`);
    }
    if (Object.is(value, -0)) {
      throw new TypeError(`${path} must not contain negative zero`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${path} must be a plain JSON array`);
    }
    if (ancestors.has(value)) {
      throw new TypeError(`${path} must not contain a JSON cycle`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === 'symbol')) {
      throw new TypeError(`${path} must not contain symbol-keyed properties`);
    }
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throw new TypeError(`${path} must be a plain JSON array`);
    }
    const length = lengthDescriptor.value;
    const nextAncestors = new Set(ancestors).add(value);
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new TypeError(`${path} must not be a sparse JSON array`);
      }
      copy.push(
        sanitizeReplayValue(
          descriptor.value,
          `${path}[${index}]`,
          nextAncestors,
        ),
      );
    }
    const extra = keys.find(
      (key) =>
        typeof key === 'string' &&
        key !== 'length' &&
        (!Number.isSafeInteger(Number(key)) ||
          Number(key) < 0 ||
          Number(key) >= length ||
          String(Number(key)) !== key),
    );
    if (extra !== undefined) {
      throw new TypeError(`${path}.${extra} is not a JSON array index`);
    }
    return Object.freeze(copy);
  }
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${path} must be a JSON value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a JSON value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain a JSON cycle`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${path} must not contain symbol-keyed properties`);
  }
  const nextAncestors = new Set(ancestors).add(value);
  const copy = {};
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    if (key === 'resumeToken') continue;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(
        `${path}.${key} must be an enumerable JSON data property`,
      );
    }
    if (key === 'resume' && typeof descriptor.value === 'string') continue;
    Object.defineProperty(copy, key, {
      value: sanitizeReplayValue(
        descriptor.value,
        `${path}.${key}`,
        nextAncestors,
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze(copy);
}

async function createLease({
  sessionId,
  owner,
  sessionsDir,
  replayPath,
  replayFs,
  readReplayStream,
  readRecord,
  writeRecord,
  syncRecordDirectory,
  deleteRecord,
  scanAdoptionPredecessor,
  acquireSession,
  readLeaseOwner,
  retireObservedLease,
  validateRetiredLeases,
  now,
}) {
  let released = false;
  let operationActive = false;
  let indeterminateEffectLedgerWrite;

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

  const replayWriter = await createLeaseReplayWriter({
    sessionsDir,
    path: replayPath,
    fs: replayFs,
    assertOwner: assertOwnerUnchecked,
    readStream: readReplayStream,
  });

  const finishSettlement = async (record) => {
    await replayWriter.checkpoint();
    return record;
  };

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
      effectLedger: emptyPlaybookEffectLedger(),
      unresolvedEffects: [],
      retainedGenerations: {},
    });
  };

  const laterTimestamp = (left, right) =>
    right !== undefined && Date.parse(right) > Date.parse(left) ? right : left;

  const emptyFreshTargetAfter = (target, predecessorUpdatedAt) => {
    if (predecessorUpdatedAt === undefined) return target;
    return settledRecordWithRetainedGenerations(
      target,
      {},
      nextTimestamp(
        now(),
        laterTimestamp(target.updatedAt, predecessorUpdatedAt),
      ),
    );
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
      const reportedSkippedRecords = new Set();
      const reportOnce = (observer, label) => {
        if (observer === undefined) return undefined;
        if (typeof observer !== 'function') {
          throw new Error(`Captain session ${label} observer must be a function`);
        }
        return async (record) => {
          const key = `${record.sessionId}\u0000${record.path}`;
          if (reportedSkippedRecords.has(key)) return;
          reportedSkippedRecords.add(key);
          await observer(record);
        };
      };
      const predecessorScanOptions = {
        onLegacyRecord: reportOnce(
          options.onLegacyRecord,
          'legacy-record',
        ),
        onInvalidRecord: reportOnce(
          options.onInvalidRecord,
          'invalid-record',
        ),
      };
      const initialScan = await scanAdoptionPredecessor(
        target,
        predecessorScanOptions,
      );
      if (initialScan.adoptionDeclined) {
        const emptyTarget = emptyFreshTargetAfter(
          target,
          initialScan.newestBoundaryUpdatedAt,
        );
        await publishEmptyFreshTarget(emptyTarget);
        await assertOwnerUnchecked();
        return emptyTarget;
      }
      const selected = initialScan.candidate;
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
            const currentScan = await scanAdoptionPredecessor(
              target,
              predecessorScanOptions,
            );
            return {
              kind: 'declined',
              predecessorUpdatedAt: laterTimestamp(
                selected.updatedAt,
                currentScan.newestBoundaryUpdatedAt,
              ),
            };
          }
          await assertOwnerUnchecked();
          if (
            (await readRecord(sessionId, { missing: 'undefined' })) !==
            undefined
          ) {
            throw new Error('Captain session adoption target changed');
          }
          const currentScan = await scanAdoptionPredecessor(
            target,
            predecessorScanOptions,
          );
          if (currentScan.candidate?.sessionId !== source.sessionId) {
            return {
              kind: 'declined',
              predecessorUpdatedAt: laterTimestamp(
                source.updatedAt,
                currentScan.newestBoundaryUpdatedAt,
              ),
            };
          }

          const retainedGenerations = source.retainedGenerations ?? {};
          try {
            assertAdoptionTransferEnvelope(
              source.structuralProjection,
              target.structuralProjection,
              retainedGenerations,
              source.effectLedger,
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
            source.effectLedger,
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
      const emptyTarget = emptyFreshTargetAfter(
        target,
        result.predecessorUpdatedAt,
      );
      await publishEmptyFreshTarget(emptyTarget);
      await assertOwnerUnchecked();
      return emptyTarget;
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
      if (prior === undefined) {
        throw new Error('Captain session does not exist for continuation');
      }
      if (prior.state !== 'settled') {
        throw new Error('Captain session already has an uncertain turn');
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
        effectLedger: prior.effectLedger,
        unresolvedEffects: prior.unresolvedEffects,
        ...retainedGenerationsMember(prior),
        ...settledAbandonmentMember(prior),
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
      if (Object.hasOwn(prior.uncertain, 'abandonment')) {
        throw new Error(
          'Captain session unresolved-effect abandonment must recover before retry',
        );
      }
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
        effectLedger: prior.effectLedger,
        unresolvedEffects: prior.unresolvedEffects,
        ...retainedGenerationsMember(prior),
        ...settledAbandonmentMember(prior),
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

  const requireAbandonmentSettlement = (
    abandonment,
    unresolvedEffects,
    retentionUpdates,
    snapshot,
    retainedGenerations,
  ) => {
    if (
      !isDeepStrictEqual(
        abandonment.unresolvedEffects,
        unresolvedEffects,
      )
    ) {
      throw new Error(
        'Captain session abandonment settlement differs from its durable unresolved effects',
      );
    }
    if (
      !retentionUpdates.some(
        (update) =>
          update.kind === 'clear' &&
          update.rootPlaybookId === abandonment.rootPlaybookId,
      ) ||
      retentionUpdates.some(
        (update) =>
          update.kind !== 'clear' ||
          (update.rootPlaybookId !== abandonment.rootPlaybookId &&
            Object.hasOwn(retainedGenerations, update.rootPlaybookId)),
      )
    ) {
      throw new Error(
        'Captain session abandonment settlement must clear its durable root without changing another retained generation',
      );
    }
    if (
      snapshot.mode !== 'chat' ||
      snapshot.lastAction !== 'runtime' ||
      snapshot.lastSettlementStatus !== 'ok'
    ) {
      throw new Error(
        'Captain session abandonment settlement requires a successful host-disposal snapshot',
      );
    }
  };

  const unresolvedEffectAbandonmentInput = (value) => {
    const input = requireRecord(
      snapshotJsonValue(value, 'Captain unresolved-effect abandonment'),
      'Captain unresolved-effect abandonment',
    );
    rejectUnknownOrMissingKeys(
      input,
      ['rootPlaybookId', 'unresolvedEffects'],
      'Captain unresolved-effect abandonment',
    );
    const rootPlaybookId = requireCanonicalNonblank(
      input.rootPlaybookId,
      'Captain unresolved-effect abandonment.rootPlaybookId',
    );
    const unresolvedEffects = assertPlaybookCaptainUnresolvedEffects(
      input.unresolvedEffects,
    );
    if (unresolvedEffects.length === 0) {
      throw new Error(
        'Captain unresolved-effect abandonment requires nonempty unresolved effects',
      );
    }
    return { rootPlaybookId, unresolvedEffects };
  };

  const beginUnresolvedEffectAbandonment = (value) =>
    runExclusive(async () => {
      const input = unresolvedEffectAbandonmentInput(value);
      await assertOwnerUnchecked();
      const prior = await requireUncertainRecord(
        await readRecord(sessionId, { missing: 'undefined' }),
      );
      if (Object.hasOwn(prior.uncertain, 'abandonment')) {
        const existing = prior.uncertain.abandonment;
        if (
          existing.phase === 'started' &&
          existing.rootPlaybookId === input.rootPlaybookId &&
          isDeepStrictEqual(existing.unresolvedEffects, input.unresolvedEffects)
        ) {
          await assertOwnerUnchecked();
          await syncRecordDirectory();
          await assertOwnerUnchecked();
          return prior;
        }
        throw new Error(
          'Captain session unresolved-effect abandonment is already in progress',
        );
      }
      if (
        prior.snapshot.mode !== 'engaged.parked' ||
        prior.snapshot.frames[0]?.playbookId !== input.rootPlaybookId
      ) {
        throw new Error(
          'Captain session unresolved-effect abandonment root does not match its durable engagement',
        );
      }
      const record = validateCaptainSessionRecord({
        ...prior,
        uncertain: {
          ...prior.uncertain,
          abandonment: {
            phase: 'started',
            rootPlaybookId: input.rootPlaybookId,
            unresolvedEffects: input.unresolvedEffects,
          },
        },
      });
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return record;
    });

  const completeUnresolvedEffectAbandonment = (value) =>
    runExclusive(async () => {
      const input = unresolvedEffectAbandonmentInput(value);
      await assertOwnerUnchecked();
      const prior = await requireUncertainRecord(
        await readRecord(sessionId, { missing: 'undefined' }),
      );
      const abandonment = prior.uncertain.abandonment;
      if (
        abandonment === undefined ||
        abandonment.rootPlaybookId !== input.rootPlaybookId ||
        !isDeepStrictEqual(
          abandonment.unresolvedEffects,
          input.unresolvedEffects,
        )
      ) {
        throw new Error(
          'Captain session unresolved-effect abandonment completion differs from its durable start',
        );
      }
      if (abandonment.phase === 'disposed') {
        await assertOwnerUnchecked();
        await syncRecordDirectory();
        await assertOwnerUnchecked();
        return prior;
      }
      const record = validateCaptainSessionRecord({
        ...prior,
        unresolvedEffects: input.unresolvedEffects,
        retainedGenerations: applyRetainedGenerationUpdates(
          prior.retainedGenerations ?? {},
          [{ kind: 'clear', rootPlaybookId: input.rootPlaybookId }],
          prior.structuralProjection,
        ),
        uncertain: {
          ...prior.uncertain,
          abandonment: {
            phase: 'disposed',
            rootPlaybookId: input.rootPlaybookId,
            unresolvedEffects: input.unresolvedEffects,
          },
        },
      });
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return record;
    });

  const recoverUnresolvedEffectAbandonment = () =>
    runExclusive(async () => {
      await assertOwnerUnchecked();
      const prior = await readRecord(sessionId, { missing: 'undefined' });
      if (
        prior === undefined ||
        prior.state !== 'uncertain' ||
        !Object.hasOwn(prior.uncertain, 'abandonment')
      ) {
        await assertOwnerUnchecked();
        if (
          prior?.state === 'settled' &&
          Object.hasOwn(prior, 'settledAbandonment')
        ) {
          await syncRecordDirectory();
          await assertOwnerUnchecked();
        }
        return prior;
      }
      const abandonment = prior.uncertain.abandonment;
      const {
        frames: _frames,
        retainedEffectReconciliation: _retainedEffectReconciliation,
        pendingBossQuestions: _pendingBossQuestions,
        lastError: _lastError,
        ...snapshotCommon
      } = prior.snapshot;
      const snapshot = assertPlaybookCaptainShellSnapshot({
        ...snapshotCommon,
        effectLedger: prior.effectLedger,
        mode: 'chat',
        lastAction: 'runtime',
        lastSettlementStatus: 'ok',
      });
      const retainedGenerations = applyRetainedGenerationUpdates(
        prior.retainedGenerations ?? {},
        [{ kind: 'clear', rootPlaybookId: abandonment.rootPlaybookId }],
        prior.structuralProjection,
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
        effectLedger: prior.effectLedger,
        unresolvedEffects: abandonment.unresolvedEffects,
        retainedGenerations,
        settledAbandonment: {
          phase: 'recovered',
          attemptId: prior.uncertain.attemptId,
          rootPlaybookId: abandonment.rootPlaybookId,
          unresolvedEffects: abandonment.unresolvedEffects,
        },
      });
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return record;
    });

  const settle = ({
    attemptId,
    snapshot,
    unresolvedEffects,
    retentionUpdates = [],
  } = {}) =>
    runExclusive(async () => {
      assertUuid(attemptId, 'Captain session attempt id');
      const updates = validateRetainedGenerationUpdates(retentionUpdates);
      const settledUnresolvedEffects = assertPlaybookCaptainUnresolvedEffects(
        unresolvedEffects,
      );
      await assertOwnerUnchecked();
      const current = await readRecord(sessionId, { missing: 'undefined' });
      const settledAbandonment =
        current?.state === 'settled' &&
        Object.hasOwn(current, 'settledAbandonment')
          ? current.settledAbandonment
          : undefined;
      const prior =
        settledAbandonment === undefined
          ? await requireUncertainRecord(current, attemptId)
          : undefined;
      if (
        settledAbandonment !== undefined &&
        settledAbandonment.attemptId !== attemptId
      ) {
        throw new Error(
          'Captain session abandonment settlement attempt differs from its durable marker',
        );
      }
      const settledSnapshot = assertPlaybookCaptainShellSnapshot(snapshot);
      if (settledAbandonment !== undefined) {
        requireAbandonmentSettlement(
          settledAbandonment,
          settledUnresolvedEffects,
          updates,
          settledSnapshot,
          current.retainedGenerations ?? {},
        );
        if (
          !isDeepStrictEqual(
            settledSnapshot.effectLedger,
            current.effectLedger,
          )
        ) {
          throw new Error(
            'Captain session settlement snapshot effect ledger differs from its durable ledger',
          );
        }
        const retainedGenerations = applyRetainedGenerationUpdates(
          current.retainedGenerations ?? {},
          updates,
          current.structuralProjection,
        );
        const settlementIsExact =
          isDeepStrictEqual(current.snapshot, settledSnapshot) &&
          isDeepStrictEqual(
            current.unresolvedEffects,
            settledUnresolvedEffects,
          ) &&
          isDeepStrictEqual(
            current.retainedGenerations ?? {},
            retainedGenerations,
          );
        if (
          settledAbandonment.phase === 'final' &&
          settlementIsExact
        ) {
          await assertOwnerUnchecked();
          await syncRecordDirectory();
          await assertOwnerUnchecked();
          return finishSettlement(current);
        }
        if (settledAbandonment.phase === 'final') {
          throw new Error(
            'Captain session abandonment settlement differs from its finalized durable record',
          );
        }
        const record = validateCaptainSessionRecord({
          schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
          kind: CAPTAIN_SESSION_RECORD_KIND,
          state: 'settled',
          sessionId,
          createdAt: current.createdAt,
          updatedAt: nextTimestamp(now(), current.updatedAt),
          cwd: current.cwd,
          structuralProjection: current.structuralProjection,
          lastAppliedExecutionProjection:
            current.lastAppliedExecutionProjection,
          snapshot: settledSnapshot,
          effectLedger: current.effectLedger,
          unresolvedEffects: settledUnresolvedEffects,
          retainedGenerations,
          settledAbandonment: {
            ...settledAbandonment,
            phase: 'final',
          },
        });
        await assertOwnerUnchecked();
        await writeRecord(record, { noReplace: false });
        await assertOwnerUnchecked();
        return finishSettlement(record);
      }
      if (Object.hasOwn(prior.uncertain, 'abandonment')) {
        const abandonment = prior.uncertain.abandonment;
        if (abandonment.phase !== 'disposed') {
          throw new Error(
            'Captain session unresolved-effect abandonment has not completed disposal',
          );
        }
        requireAbandonmentSettlement(
          abandonment,
          settledUnresolvedEffects,
          updates,
          settledSnapshot,
          prior.retainedGenerations ?? {},
        );
      }
      if (!isDeepStrictEqual(settledSnapshot.effectLedger, prior.effectLedger)) {
        throw new Error(
          'Captain session settlement snapshot effect ledger differs from its durable ledger',
        );
      }
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
        snapshot: settledSnapshot,
        effectLedger: prior.effectLedger,
        unresolvedEffects: settledUnresolvedEffects,
        retainedGenerations: applyRetainedGenerationUpdates(
          prior.retainedGenerations ?? {},
          updates,
          prior.structuralProjection,
        ),
        ...(Object.hasOwn(prior.uncertain, 'abandonment')
          ? {
              settledAbandonment: {
                phase: 'final',
                attemptId: prior.uncertain.attemptId,
                rootPlaybookId:
                  prior.uncertain.abandonment.rootPlaybookId,
                unresolvedEffects:
                  prior.uncertain.abandonment.unresolvedEffects,
              },
            }
          : {}),
      });
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return finishSettlement(record);
    });

  const writeEffectLedger = (authorityValue, commandsValue) =>
    runExclusive(async () => {
      await assertOwnerUnchecked();
      const prior = await readRecord(sessionId, { missing: 'undefined' });
      if (prior === undefined) {
        throw new Error('Captain session does not exist for effect-ledger write-ahead');
      }
      const settledRecovery =
        prior.state === 'settled' &&
        prior.snapshot.mode === 'chat' &&
        (Object.keys(prior.retainedGenerations ?? {}).length > 0 ||
          prior.unresolvedEffects.length > 0);
      if (prior.state !== 'uncertain' && !settledRecovery) {
        throw new Error(
          'Captain session effect-ledger write-ahead requires an uncertain turn or a settled chat recovery boundary',
        );
      }
      const authority = validateEffectLedgerAuthority(
        authorityValue,
        prior,
        owner,
      );
      const commands = snapshotJsonValue(
        commandsValue,
        'effect-ledger write commands',
      );
      if (settledRecovery) assertSettledEffectRecoveryCommands(commands);
      if (
        indeterminateEffectLedgerWrite !== undefined &&
        isDeepStrictEqual(commands, indeterminateEffectLedgerWrite.commands) &&
        isDeepStrictEqual(
          prior.effectLedger,
          indeterminateEffectLedgerWrite.ledger,
        )
      ) {
        await assertOwnerUnchecked();
        await syncRecordDirectory();
        await assertOwnerUnchecked();
        indeterminateEffectLedgerWrite = undefined;
        return prior.effectLedger;
      }
      indeterminateEffectLedgerWrite = undefined;
      const nextLedger = applyEffectLedgerCommands(
        prior.effectLedger,
        authority,
        prior.uncertain,
        commands,
      );
      if (isDeepStrictEqual(nextLedger, prior.effectLedger)) {
        await assertOwnerUnchecked();
        return prior.effectLedger;
      }
      const record = validateCaptainSessionRecord({
        ...prior,
        effectLedger: nextLedger,
        ...(settledRecovery
          ? { snapshot: { ...prior.snapshot, effectLedger: nextLedger } }
          : {}),
      });
      indeterminateEffectLedgerWrite = {
        commands,
        ledger: record.effectLedger,
      };
      await assertOwnerUnchecked();
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      indeterminateEffectLedgerWrite = undefined;
      return record.effectLedger;
    });

  const discard = ({ attemptId } = {}) =>
    runExclusive(async () => {
      assertUuid(attemptId, 'Captain session attempt id');
      await assertOwnerUnchecked();
      const prior = await requireUncertainRecord(
        await readRecord(sessionId, { missing: 'undefined' }),
        attemptId,
      );
      if (Object.hasOwn(prior.uncertain, 'abandonment')) {
        throw new Error(
          'Captain session unresolved-effect abandonment must recover before discard',
        );
      }
      if (!isDeepStrictEqual(prior.effectLedger, prior.snapshot.effectLedger)) {
        throw new Error(
          'Captain session uncertain effect ledger differs from its pre-turn checkpoint and cannot be discarded',
        );
      }
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
        effectLedger: prior.effectLedger,
        unresolvedEffects: prior.unresolvedEffects,
        ...retainedGenerationsMember(prior),
        ...settledAbandonmentMember(prior),
      });
      await writeRecord(record, { noReplace: false });
      await assertOwnerUnchecked();
      return record;
    });

  const release = () => {
    replayWriter.closeAppendAdmission();
    return runExclusive(async () => {
      await replayWriter.prepareRelease();
      const current = await assertOwnerUnchecked();
      await retireObservedLease(sessionId, current);
      released = true;
      return replayWriter.status();
    });
  };

  return Object.freeze({
    sessionId,
    ownerToken: owner.ownerToken,
    append: replayWriter.append,
    readStream: replayWriter.read,
    streamStatus: replayWriter.status,
    read,
    initializeSettledWithPredecessor,
    abandonFreshSettled,
    beginTurn,
    beginRetry,
    beginUnresolvedEffectAbandonment,
    completeUnresolvedEffectAbandonment,
    recoverUnresolvedEffectAbandonment,
    writeEffectLedger,
    settle,
    discard,
    assertOwner,
    release,
  });
}

export function validateCaptainSessionExecutionProjection(
  value,
  path = 'Captain session execution projection',
) {
  return validateCaptainSessionExecutionProjectionWithSchemas(
    value,
    path,
    CURRENT_ARTIFACT_SCHEMAS,
  );
}

function validateCaptainSessionExecutionProjectionWithSchemas(
  value,
  path,
  artifactSchemas,
) {
  const projection = requireRecord(snapshotJsonValue(value, path), path);
  validateCaptainSessionProjection(projection, {
    path,
    structural: false,
    artifactSchemas,
  });
  return projection;
}

export function validateCaptainSessionStructuralProjection(
  value,
  path = 'Captain session structural projection',
) {
  return validateCaptainSessionStructuralProjectionWithSchemas(
    value,
    path,
    CURRENT_ARTIFACT_SCHEMAS,
  );
}

function validateCaptainSessionStructuralProjectionWithSchemas(
  value,
  path,
  artifactSchemas,
) {
  const projection = requireRecord(snapshotJsonValue(value, path), path);
  validateCaptainSessionProjection(projection, {
    path,
    structural: true,
    artifactSchemas,
  });
  return projection;
}

export function projectCaptainSessionStructure(value) {
  return projectCaptainSessionStructureWithSchemas(
    value,
    CURRENT_ARTIFACT_SCHEMAS,
  );
}

function projectCaptainSessionStructureWithSchemas(value, artifactSchemas) {
  const execution = validateCaptainSessionExecutionProjectionWithSchemas(
    value,
    'Captain session execution projection',
    artifactSchemas,
  );
  const fixedAgent = (agent) => ({
    adapter: agent.adapter,
    ...(agent.instruction === undefined
      ? {}
      : { instruction: agent.instruction }),
    ...(agent.permissions === undefined
      ? {}
      : { permissions: agent.permissions }),
  });
  return validateCaptainSessionStructuralProjectionWithSchemas(
    {
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
    },
    'Captain session structural projection',
    artifactSchemas,
  );
}

export function assertCaptainSessionExecutionCompatible(
  structuralProjection,
  executionProjection,
) {
  return assertCaptainSessionExecutionCompatibleWithSchemas(
    structuralProjection,
    executionProjection,
    CURRENT_ARTIFACT_SCHEMAS,
  );
}

function assertCaptainSessionExecutionCompatibleWithSchemas(
  structuralProjection,
  executionProjection,
  artifactSchemas,
) {
  const structural = validateCaptainSessionStructuralProjectionWithSchemas(
    structuralProjection,
    'Captain session structural projection',
    artifactSchemas,
  );
  const execution = validateCaptainSessionExecutionProjectionWithSchemas(
    executionProjection,
    'Captain session execution projection',
    artifactSchemas,
  );
  const projected = projectCaptainSessionStructureWithSchemas(
    execution,
    artifactSchemas,
  );
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
  if (record.schemaVersion === 2) {
    assertReleasedSchema2CaptainSessionRecord(record);
    throw new CaptainSessionRecordNonresumableError(
      record.schemaVersion,
      'Captain session record schema 2 has incompatible root-owned player identity; schema 6 is required',
      captainSessionOrderingBoundary(record),
    );
  }
  if (
    record.schemaVersion === LEGACY_CAPTAIN_SESSION_RECORD_SCHEMA_VERSION ||
    record.schemaVersion === COMPATIBLE_RETENTION_RECORD_SCHEMA_VERSION
  ) {
    const projectedRecord = validateCanonicalCaptainSessionRecord(
      projectPreEffectCaptainSessionRecordForValidation(record),
      PRE_EFFECT_ARTIFACT_SCHEMAS,
    );
    throw new CaptainSessionRecordNonresumableError(
      record.schemaVersion,
      `Captain session record schema ${record.schemaVersion} predates the artifact-schema-3 effect-authority cutover and is not resumable`,
      captainSessionOrderingBoundary(projectedRecord),
    );
  }
  if (
    record.schemaVersion === PRE_UNRESOLVED_EFFECTS_RECORD_SCHEMA_VERSION
  ) {
    const hasUnresolvedEffects = Object.hasOwn(record, 'unresolvedEffects');
    if (
      !hasUnresolvedEffects &&
      (Object.hasOwn(record, 'settledAbandonment') ||
        (typeof record.uncertain === 'object' &&
          record.uncertain !== null &&
          Object.hasOwn(record.uncertain, 'abandonment')))
    ) {
      throw new Error(
        'Captain session record schema 5 pre-unresolved-effects shape has an unknown abandonment field',
      );
    }
    const projectedRecord = validateCanonicalCaptainSessionRecord(
      {
        ...record,
        schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
        ...(hasUnresolvedEffects ? {} : { unresolvedEffects: [] }),
      },
      hasUnresolvedEffects
        ? CURRENT_ARTIFACT_SCHEMAS
        : PRE_EFFECT_ARTIFACT_SCHEMAS,
    );
    throw new CaptainSessionRecordNonresumableError(
      record.schemaVersion,
      'Captain session record schema 5 predates the canonical schema-6 unresolved-effect settlement boundary for the artifact-schema-3 effect-authority cutover and is not resumable',
      captainSessionOrderingBoundary(projectedRecord),
    );
  }
  if (record.schemaVersion !== CAPTAIN_SESSION_RECORD_SCHEMA_VERSION) {
    throw new CaptainSessionRecordSchemaError(
      record.schemaVersion,
      `Captain session record schema ${JSON.stringify(record.schemaVersion)} is not supported`,
    );
  }
  return validateCanonicalCaptainSessionRecord(record);
}

function captainSessionOrderingBoundary(record) {
  return Object.freeze({
    sessionId: record.sessionId,
    state: record.state,
    cwd: record.cwd,
    updatedAt: record.updatedAt,
  });
}

function validateCanonicalCaptainSessionRecord(
  record,
  artifactSchemas = CURRENT_ARTIFACT_SCHEMAS,
) {
  record = requireRecord(
    snapshotJsonValue(record, 'Captain session record'),
    'Captain session record',
  );
  if (record.state !== 'settled' && record.state !== 'uncertain') {
    throw new Error('Captain session record state is not supported');
  }
  exactOptionalKeys(
    record,
    record.state === 'uncertain'
      ? [...COMMON_RECORD_KEYS, 'uncertain']
      : COMMON_RECORD_KEYS,
    ['retainedGenerations', 'settledAbandonment'],
    'Captain session record',
  );
  if (record.schemaVersion !== CAPTAIN_SESSION_RECORD_SCHEMA_VERSION) {
    throw new Error(
      `Captain session record schemaVersion must be ${CAPTAIN_SESSION_RECORD_SCHEMA_VERSION}`,
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
  const structural = validateCaptainSessionStructuralProjectionWithSchemas(
    record.structuralProjection,
    'Captain session record structuralProjection',
    artifactSchemas,
  );
  const lastApplied = assertCaptainSessionExecutionCompatibleWithSchemas(
    structural,
    record.lastAppliedExecutionProjection,
    artifactSchemas,
  );
  void lastApplied;
  const snapshot = assertPlaybookCaptainShellSnapshot(record.snapshot);
  assertSnapshotMatchesStructure(snapshot, structural, artifactSchemas);
  const effectLedger = assertPlaybookEffectLedger(
    record.effectLedger,
    'Captain session record effectLedger',
  );
  const unresolvedEffects = assertPlaybookCaptainUnresolvedEffects(
    record.unresolvedEffects,
  );
  void unresolvedEffects;
  assertEffectLedgerMatchesCatalog(effectLedger, structural.catalog);
  if (record.state === 'settled') {
    if (!isDeepStrictEqual(effectLedger, snapshot.effectLedger)) {
      throw new Error(
        'settled Captain session effect ledger differs from its shell snapshot mirror',
      );
    }
  } else if (
    !isPlaybookEffectLedgerMonotonicExtension(
      snapshot.effectLedger,
      effectLedger,
    )
  ) {
    throw new Error(
      'uncertain Captain session effect ledger is not a monotonic extension of its pre-turn shell snapshot mirror',
    );
  }
  if (Object.hasOwn(record, 'retainedGenerations')) {
    validateRetainedGenerations(
      record.retainedGenerations,
      structural,
      effectLedger,
      artifactSchemas,
    );
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
    exactOptionalKeys(
      uncertain,
      UNCERTAIN_KEYS,
      ['abandonment'],
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
    const newBoundaries = effectLedger.boundaries.slice(
      snapshot.effectLedger.boundaries.length,
    );
    const attemptIds = new Map();
    const attemptNumbersById = new Map();
    for (const boundary of newBoundaries) {
      if (boundary.attemptNumber > uncertain.attemptNumber) {
        throw new Error(
          'Captain session post-checkpoint effect boundary names a future uncertain attempt',
        );
      }
      const priorId = attemptIds.get(boundary.attemptNumber);
      if (priorId !== undefined && priorId !== boundary.attemptId) {
        throw new Error(
          'Captain session post-checkpoint effect boundaries use inconsistent ids for one attempt number',
        );
      }
      const priorNumber = attemptNumbersById.get(boundary.attemptId);
      if (priorNumber !== undefined && priorNumber !== boundary.attemptNumber) {
        throw new Error(
          'Captain session post-checkpoint effect attempts reuse one id across attempt numbers',
        );
      }
      attemptIds.set(boundary.attemptNumber, boundary.attemptId);
      attemptNumbersById.set(boundary.attemptId, boundary.attemptNumber);
      if (
        boundary.attemptNumber === uncertain.attemptNumber
          ? boundary.attemptId !== uncertain.attemptId
          : boundary.attemptId === uncertain.attemptId
      ) {
        throw new Error(
          'Captain session post-checkpoint effect boundary attempt identity conflicts with the current uncertain marker',
        );
      }
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
    const attempted = assertCaptainSessionExecutionCompatibleWithSchemas(
      structural,
      uncertain.attemptedExecutionProjection,
      artifactSchemas,
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
    if (Object.hasOwn(uncertain, 'abandonment')) {
      const abandonment = requireRecord(
        uncertain.abandonment,
        'Captain session record uncertain.abandonment',
      );
      rejectUnknownOrMissingKeys(
        abandonment,
        UNCERTAIN_ABANDONMENT_KEYS,
        'Captain session record uncertain.abandonment',
      );
      if (abandonment.phase !== 'started' && abandonment.phase !== 'disposed') {
        throw new Error(
          'Captain session record uncertain.abandonment.phase must be "started" or "disposed"',
        );
      }
      const rootPlaybookId = requireCanonicalNonblank(
        abandonment.rootPlaybookId,
        'Captain session record uncertain.abandonment.rootPlaybookId',
      );
      if (!Object.hasOwn(structural.catalog, rootPlaybookId)) {
        throw new Error(
          `Captain session unresolved-effect abandonment names unknown stored playbook ${JSON.stringify(rootPlaybookId)}`,
        );
      }
      if (
        snapshot.mode !== 'engaged.parked' ||
        snapshot.frames[0]?.playbookId !== rootPlaybookId
      ) {
        throw new Error(
          'Captain session unresolved-effect abandonment root differs from its durable engagement',
        );
      }
      const abandonmentEffects = assertPlaybookCaptainUnresolvedEffects(
        abandonment.unresolvedEffects,
      );
      if (abandonmentEffects.length === 0) {
        throw new Error(
          'Captain session unresolved-effect abandonment requires nonempty unresolved effects',
        );
      }
      if (abandonment.phase === 'disposed') {
        if (!isDeepStrictEqual(unresolvedEffects, abandonmentEffects)) {
          throw new Error(
            'Captain session disposed abandonment unresolved effects differ from the record settlement evidence',
          );
        }
        if (Object.hasOwn(record.retainedGenerations ?? {}, rootPlaybookId)) {
          throw new Error(
            'Captain session disposed abandonment retained its cleared root generation',
          );
        }
      }
    }
  }
  if (Object.hasOwn(record, 'settledAbandonment')) {
    const settledAbandonment = requireRecord(
      record.settledAbandonment,
      'Captain session record settledAbandonment',
    );
    rejectUnknownOrMissingKeys(
      settledAbandonment,
      ['phase', 'attemptId', 'rootPlaybookId', 'unresolvedEffects'],
      'Captain session record settledAbandonment',
    );
    if (
      settledAbandonment.phase !== 'recovered' &&
      settledAbandonment.phase !== 'final'
    ) {
      throw new Error(
        'Captain session record settledAbandonment.phase must be "recovered" or "final"',
      );
    }
    assertUuid(
      settledAbandonment.attemptId,
      'Captain session record settledAbandonment.attemptId',
    );
    const rootPlaybookId = requireCanonicalNonblank(
      settledAbandonment.rootPlaybookId,
      'Captain session record settledAbandonment.rootPlaybookId',
    );
    if (!Object.hasOwn(structural.catalog, rootPlaybookId)) {
      throw new Error(
        `Captain session recovered unresolved-effect abandonment names unknown stored playbook ${JSON.stringify(rootPlaybookId)}`,
      );
    }
    const settledEffects = assertPlaybookCaptainUnresolvedEffects(
      settledAbandonment.unresolvedEffects,
    );
    if (
      settledEffects.length === 0 ||
      !isDeepStrictEqual(unresolvedEffects, settledEffects)
    ) {
      throw new Error(
        'Captain session settled unresolved-effect abandonment must preserve its nonempty settlement evidence',
      );
    }
    if (
      snapshot.mode !== 'chat' ||
      snapshot.lastAction !== 'runtime' ||
      snapshot.lastSettlementStatus !== 'ok' ||
      Object.hasOwn(record.retainedGenerations ?? {}, rootPlaybookId)
    ) {
      throw new Error(
        'Captain session settled unresolved-effect abandonment must carry a successful host-disposal chat snapshot with its root generation cleared',
      );
    }
  }

  return record;
}

function projectPreEffectCaptainSessionRecordForValidation(record) {
  if (record.state !== 'settled' && record.state !== 'uncertain') {
    throw new Error('Captain session record state is not supported');
  }
  const recordKeys =
    record.schemaVersion === COMPATIBLE_RETENTION_RECORD_SCHEMA_VERSION
      ? [...LEGACY_COMMON_RECORD_KEYS, 'retainedGenerations']
      : LEGACY_COMMON_RECORD_KEYS;
  exactOptionalKeys(
    record,
    record.state === 'uncertain'
      ? [...recordKeys, 'uncertain']
      : recordKeys,
    record.schemaVersion === LEGACY_CAPTAIN_SESSION_RECORD_SCHEMA_VERSION
      ? ['retainedGenerations']
      : [],
    'Captain session record',
  );
  validateCaptainSessionStructuralProjectionWithSchemas(
    record.structuralProjection,
    'Captain session record structuralProjection',
    PRE_EFFECT_ARTIFACT_SCHEMAS,
  );
  const effectLedger = emptyPlaybookEffectLedger();
  const migrated = {
    ...record,
    schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
    snapshot: migratePreEffectShellSnapshot(record.snapshot, effectLedger),
    effectLedger,
    unresolvedEffects: [],
    ...(Object.hasOwn(record, 'retainedGenerations')
      ? {
          retainedGenerations: migratePreEffectRetainedGenerations(
            record.retainedGenerations,
          ),
        }
      : {}),
  };
  return migrated;
}

function migratePreEffectShellSnapshot(value, effectLedger) {
  const snapshot = requireRecord(value, 'legacy Captain shell snapshot');
  if (snapshot.schemaVersion !== 3) {
    throw new CaptainSessionRecordSchemaError(
      snapshot.schemaVersion,
      `legacy Captain shell snapshot schema ${JSON.stringify(snapshot.schemaVersion)} cannot migrate to schema 4`,
    );
  }
  if (Object.hasOwn(snapshot, 'effectLedger')) {
    throw new CaptainSessionRecordSchemaError(
      snapshot.schemaVersion,
      'legacy Captain shell snapshot must not contain an effect ledger',
    );
  }
  const captain = requireRecord(
    snapshot.captain,
    'legacy Captain shell snapshot.captain',
  );
  const frames =
    snapshot.frames === undefined
      ? undefined
      : Array.isArray(snapshot.frames)
        ? snapshot.frames.map((frame, index) => {
            const captured = requireRecord(
              frame,
              `legacy Captain shell snapshot.frames[${index}]`,
            );
            return {
              ...captured,
              runtime: migratePreEffectRuntimeSnapshot(
                captured.runtime,
                `legacy Captain shell snapshot.frames[${index}].runtime`,
              ),
            };
          })
        : snapshot.frames;
  return {
    ...snapshot,
    schemaVersion: 4,
    captain: {
      ...captain,
      runtime: migratePreEffectRuntimeSnapshot(
        captain.runtime,
        'legacy Captain shell snapshot.captain.runtime',
      ),
    },
    effectLedger,
    ...(frames === undefined ? {} : { frames }),
  };
}

function migratePreEffectRuntimeSnapshot(value, path) {
  const snapshot = requireRecord(value, path);
  if (snapshot.schemaVersion !== 3) {
    throw new CaptainSessionRecordSchemaError(
      snapshot.schemaVersion,
      `${path} schema ${JSON.stringify(snapshot.schemaVersion)} cannot migrate to schema 4`,
    );
  }
  if (Object.hasOwn(snapshot, 'effectLedger')) {
    throw new CaptainSessionRecordSchemaError(
      snapshot.schemaVersion,
      `${path} must not contain an effect ledger`,
    );
  }
  return {
    ...snapshot,
    schemaVersion: 4,
    effectLedger: emptyPlaybookEffectLedger(),
  };
}

function migratePreEffectRetainedGenerations(value) {
  const retained = requireRecord(
    value,
    'legacy Captain session retainedGenerations',
  );
  return Object.fromEntries(
    Object.entries(retained).map(([rootPlaybookId, rawGeneration]) => {
      const path =
        'legacy Captain session retainedGenerations' +
        `[${JSON.stringify(rootPlaybookId)}]`;
      const generation = requireRecord(rawGeneration, path);
      if (
        Object.hasOwn(generation, 'effectLedger') ||
        Object.hasOwn(generation, 'retainedEffectReconciliation')
      ) {
        throw new Error(
          `${path} must not contain pre-migration effect evidence`,
        );
      }
      if (!Array.isArray(generation.frames)) {
        return [
          rootPlaybookId,
          { ...generation, effectLedger: emptyPlaybookEffectLedger() },
        ];
      }
      return [
        rootPlaybookId,
        {
          ...generation,
          effectLedger: emptyPlaybookEffectLedger(),
          frames: generation.frames.map((rawFrame, index) => {
            const frame = requireRecord(rawFrame, `${path}.frames[${index}]`);
            return {
              ...frame,
              runtime: migratePreEffectRuntimeSnapshot(
                frame.runtime,
                `${path}.frames[${index}].runtime`,
              ),
            };
          }),
        },
      ];
    }),
  );
}

const EFFECT_AUTHORITY_KEYS = [
  'playbookId',
  'artifactSchema',
  'cwd',
  'sessionId',
  'leaseOwnerToken',
  'canonicalWorktree',
  'requiredRoleIds',
  'concurrentRoleSets',
];
const EFFECT_BOUNDARY_START_KEYS = [
  'boundaryId',
  'playbookId',
  'runtimeSessionId',
  'turnId',
  'callId',
  'roleId',
  'sourceStateId',
  'sourceOutcomeSchema',
  'dispositions',
  'canonicalWorktree',
  'baseline',
  'correctionBudget',
];
const EFFECT_BOUNDARY_IDENTITY_KEYS = [
  'sequence',
  'boundaryId',
  'attemptId',
  'attemptNumber',
  'playbookId',
  'runtimeSessionId',
  'turnId',
  'callId',
  'roleId',
  'sourceStateId',
  'sourceOutcomeSchema',
  'dispositions',
  'canonicalWorktree',
  'baseline',
];
const EFFECT_BOUNDARY_OPTIONAL_KEYS = [
  'after',
  'physicalReceipt',
  'finalText',
  'semanticCandidate',
  'initialSemanticCandidate',
  'cohortId',
  'logicalOperationId',
];
const EFFECT_LOGICAL_START_KEYS = [
  'operationId',
  'playbookId',
  'runtimeSessionId',
  'boundaryIds',
  'originalBaseline',
  'checkpointRestorationEligible',
];
const EFFECT_LOGICAL_OPTIONAL_KEYS = [
  'checkpoint',
  'pendingQuestion',
  'playerContinuation',
  'logicalReceipt',
];

function assertEffectLedgerMatchesCatalog(ledger, catalog) {
  const cohorts = new Map();
  for (const boundary of ledger.boundaries) {
    const entry = catalog[boundary.playbookId];
    if (
      entry?.artifactSchema !== 3 ||
      !entry.requiredRoleIds.includes(boundary.roleId)
    ) {
      throw new Error(
        `Captain session effect boundary ${JSON.stringify(boundary.boundaryId)} does not match its stored schema-3 catalog role`,
      );
    }
    if (boundary.cohortId === undefined) continue;
    const members = cohorts.get(boundary.cohortId) ?? [];
    members.push(boundary);
    cohorts.set(boundary.cohortId, members);
  }
  for (const [cohortId, members] of cohorts) {
    const entry = catalog[members[0].playbookId];
    const roles = members.map((boundary) => boundary.roleId);
    if (
      !members.every(
        (boundary) => boundary.playbookId === members[0].playbookId,
      ) ||
      !entry.concurrentRoleSets.some((candidate) =>
        isDeepStrictEqual(candidate, roles),
      )
    ) {
      throw new Error(
        `Captain session effect cohort ${JSON.stringify(cohortId)} is not one stored declared concurrent role set`,
      );
    }
  }
}

function validateEffectLedgerAuthority(value, record, owner) {
  const authority = requireRecord(
    snapshotJsonValue(value, 'effect-ledger write authority'),
    'effect-ledger write authority',
  );
  rejectUnknownOrMissingKeys(
    authority,
    EFFECT_AUTHORITY_KEYS,
    'effect-ledger write authority',
  );
  const identity = requireRecord(
    authority.canonicalWorktree,
    'effect-ledger write authority.canonicalWorktree',
  );
  rejectUnknownOrMissingKeys(
    identity,
    ['worktree', 'gitDir'],
    'effect-ledger write authority.canonicalWorktree',
  );
  const entry = record.structuralProjection.catalog[authority.playbookId];
  if (
    authority.artifactSchema !== 3 ||
    authority.sessionId !== record.sessionId ||
    authority.sessionId !== owner.sessionId ||
    authority.leaseOwnerToken !== owner.ownerToken ||
    authority.cwd !== record.cwd ||
    entry?.artifactSchema !== 3 ||
    entry.id !== authority.playbookId ||
    !isDeepStrictEqual(authority.requiredRoleIds, entry.requiredRoleIds) ||
    !isDeepStrictEqual(
      authority.concurrentRoleSets,
      entry.concurrentRoleSets,
    )
  ) {
    throw new Error(
      'effect-ledger write authority does not match the current Captain session lease and stored schema-3 playbook',
    );
  }
  for (const [key, path] of [
    ['worktree', 'effect-ledger write authority canonical worktree'],
    ['gitDir', 'effect-ledger write authority canonical Git directory'],
  ]) {
    if (
      typeof identity[key] !== 'string' ||
      !isAbsolute(identity[key]) ||
      resolve(identity[key]) !== identity[key]
    ) {
      throw new Error(`${path} must be a normalized absolute path`);
    }
  }
  return authority;
}

function applyEffectLedgerCommands(
  ledgerValue,
  authority,
  uncertain,
  commandsValue,
) {
  const previous = assertPlaybookEffectLedger(
    ledgerValue,
    'Captain session effect ledger',
  );
  const commands = requireNonemptyBatch(
    snapshotJsonValue(commandsValue, 'effect-ledger write commands'),
    'effect-ledger write commands',
  );
  let candidate = previous;
  for (const [index, commandValue] of commands.entries()) {
    candidate = applyEffectLedgerCommand(
      candidate,
      authority,
      uncertain,
      commandValue,
      `effect-ledger write commands[${index}]`,
    );
  }
  if (isDeepStrictEqual(candidate, previous)) return previous;
  return validateNextEffectLedger(previous, {
    ...candidate,
    revision: previous.revision + 1,
  });
}

function assertSettledEffectRecoveryCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error(
      'settled Captain session effect-ledger recovery requires boundary completion evidence',
    );
  }
  for (const command of commands) {
    if (
      command === null ||
      typeof command !== 'object' ||
      Array.isArray(command) ||
      command.kind !== 'replace-boundaries' ||
      !Array.isArray(command.replacements) ||
      command.replacements.length === 0
    ) {
      throw new Error(
        'settled Captain session effect-ledger recovery may only complete existing physical boundaries',
      );
    }
    for (const replacement of command.replacements) {
      const expected = replacement?.expected;
      const next = replacement?.next;
      if (
        expected === null ||
        typeof expected !== 'object' ||
        Array.isArray(expected) ||
        next === null ||
        typeof next !== 'object' ||
        Array.isArray(next) ||
        expected.physicalReceipt !== undefined ||
        next.physicalReceipt === undefined
      ) {
        throw new Error(
          'settled Captain session effect-ledger recovery requires one new physical receipt for each incomplete boundary',
        );
      }
      const preserved = { ...next };
      delete preserved.after;
      delete preserved.physicalReceipt;
      if (!isDeepStrictEqual(preserved, expected)) {
        throw new Error(
          'settled Captain session effect-ledger recovery cannot change boundary semantics or identity',
        );
      }
    }
  }
}

function applyEffectLedgerCommand(
  ledger,
  authority,
  uncertain,
  commandValue,
  path,
) {
  const command = requireRecord(
    commandValue,
    path,
  );
  if (command.kind === 'start-boundaries') {
    rejectUnknownOrMissingKeys(
      command,
      ['kind', 'boundaries'],
      path,
    );
    return startEffectBoundaries(ledger, authority, uncertain, command.boundaries);
  }
  if (command.kind === 'replace-boundaries') {
    rejectUnknownOrMissingKeys(
      command,
      ['kind', 'replacements'],
      path,
    );
    return replaceEffectBoundaries(ledger, authority, command.replacements);
  }
  if (command.kind === 'append-logical-operations') {
    rejectUnknownOrMissingKeys(
      command,
      ['kind', 'operations'],
      path,
    );
    return appendEffectLogicalOperations(
      ledger,
      authority,
      command.operations,
    );
  }
  if (command.kind === 'replace-logical-operations') {
    rejectUnknownOrMissingKeys(
      command,
      ['kind', 'replacements'],
      path,
    );
    return replaceEffectLogicalOperations(
      ledger,
      authority,
      command.replacements,
    );
  }
  throw new Error(
    `${path}.kind ${JSON.stringify(command.kind)} is not supported`,
  );
}

function requireNonemptyBatch(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a nonempty array`);
  }
  return value;
}

function startEffectBoundaries(ledger, authority, uncertain, value) {
  const inputs = requireNonemptyBatch(
    value,
    'effect-ledger start command boundaries',
  ).map((raw, index) => {
    const path = `effect-ledger start command boundaries[${index}]`;
    const input = requireRecord(raw, path);
    exactOptionalKeys(
      input,
      EFFECT_BOUNDARY_START_KEYS,
      ['cohortId', 'logicalOperationId'],
      path,
    );
    assertBoundaryAuthority(input, authority, path);
    return input;
  });
  assertDistinctCommandIdentities(inputs, 'boundaryId', 'boundary start');
  const existingById = new Map(
    ledger.boundaries.map((boundary) => [boundary.boundaryId, boundary]),
  );
  const existing = inputs.map((input) => existingById.get(input.boundaryId));
  if (existing.some((boundary) => boundary !== undefined)) {
    if (
      existing.every((boundary) => boundary !== undefined) &&
      existing.every((boundary, index) => {
        const payload = { ...boundary };
        const sequence = payload.sequence;
        delete payload.sequence;
        delete payload.attemptId;
        delete payload.attemptNumber;
        return (
          sequence === ledger.boundaries.length - inputs.length + index + 1 &&
          isDeepStrictEqual(payload, inputs[index])
        );
      })
    ) {
      return ledger;
    }
    throw new Error(
      'effect-ledger boundary start reuses an existing boundary id with different data',
    );
  }
  const cohorts = new Map();
  for (const input of inputs) {
    if (input.cohortId === undefined) continue;
    const members = cohorts.get(input.cohortId) ?? [];
    members.push(input);
    cohorts.set(input.cohortId, members);
  }
  for (const [cohortId, members] of cohorts) {
    if (
      members.length < 2 ||
      !authority.concurrentRoleSets.some((roles) =>
        isDeepStrictEqual(
          roles,
          members.map((boundary) => boundary.roleId),
        ),
      ) ||
      ledger.boundaries.some((boundary) => boundary.cohortId === cohortId)
    ) {
      throw new Error(
        `effect-ledger boundary cohort ${JSON.stringify(cohortId)} is not one new declared concurrent role set`,
      );
    }
  }
  let sequence = ledger.boundaries.at(-1)?.sequence ?? 0;
  const additions = inputs.map((input) => ({
    sequence: ++sequence,
    boundaryId: input.boundaryId,
    attemptId: uncertain.attemptId,
    attemptNumber: uncertain.attemptNumber,
    playbookId: input.playbookId,
    runtimeSessionId: input.runtimeSessionId,
    turnId: input.turnId,
    callId: input.callId,
    roleId: input.roleId,
    sourceStateId: input.sourceStateId,
    sourceOutcomeSchema: input.sourceOutcomeSchema,
    dispositions: input.dispositions,
    canonicalWorktree: input.canonicalWorktree,
    baseline: input.baseline,
    correctionBudget: input.correctionBudget,
    ...(input.cohortId === undefined ? {} : { cohortId: input.cohortId }),
    ...(input.logicalOperationId === undefined
      ? {}
      : { logicalOperationId: input.logicalOperationId }),
  }));
  return {
    ...ledger,
    boundaries: [...ledger.boundaries, ...additions],
  };
}

function replaceEffectBoundaries(ledger, authority, value) {
  const replacements = captureReplacements(
    value,
    'boundaryId',
    'effect-ledger boundary replacement command',
  );
  const byId = new Map(
    ledger.boundaries.map((boundary, index) => [
      boundary.boundaryId,
      { boundary, index },
    ]),
  );
  let alreadyApplied = true;
  const nextBoundaries = [...ledger.boundaries];
  for (const [index, replacement] of replacements.entries()) {
    const path = `effect-ledger boundary replacement command.replacements[${index}]`;
    assertBoundaryCommandShape(replacement.expected, `${path}.expected`);
    assertBoundaryCommandShape(replacement.next, `${path}.next`);
    assertBoundaryAuthority(replacement.expected, authority, `${path}.expected`);
    assertBoundaryAuthority(replacement.next, authority, `${path}.next`);
    assertMonotonicBoundaryReplacement(
      replacement.expected,
      replacement.next,
      path,
    );
    const current = byId.get(replacement.expected.boundaryId);
    if (current === undefined) {
      throw new Error(`${path} names an absent boundary`);
    }
    if (!isDeepStrictEqual(current.boundary, replacement.expected)) {
      throw new Error(`${path}.expected does not match the durable boundary`);
    }
    if (isDeepStrictEqual(current.boundary, replacement.next)) continue;
    alreadyApplied = false;
    nextBoundaries[current.index] = replacement.next;
  }
  if (alreadyApplied) return ledger;
  return {
    ...ledger,
    boundaries: nextBoundaries,
  };
}

function appendEffectLogicalOperations(ledger, authority, value) {
  const inputs = requireNonemptyBatch(
    value,
    'effect-ledger logical-operation append command operations',
  ).map((raw, index) => {
    const path = `effect-ledger logical-operation append command operations[${index}]`;
    const input = requireRecord(raw, path);
    exactOptionalKeys(
      input,
      EFFECT_LOGICAL_START_KEYS,
      EFFECT_LOGICAL_OPTIONAL_KEYS,
      path,
    );
    assertLogicalOperationAuthority(input, authority, path);
    return input;
  });
  assertDistinctCommandIdentities(
    inputs,
    'operationId',
    'logical-operation append',
  );
  const existingById = new Map(
    ledger.logicalOperations.map((operation) => [
      operation.operationId,
      operation,
    ]),
  );
  const existing = inputs.map((input) => existingById.get(input.operationId));
  if (existing.some((operation) => operation !== undefined)) {
    if (
      existing.every((operation) => operation !== undefined) &&
      existing.every((operation, index) => {
        const { sequence, ...payload } = operation;
        return (
          sequence ===
            ledger.logicalOperations.length - inputs.length + index + 1 &&
          isDeepStrictEqual(payload, inputs[index])
        );
      })
    ) {
      return ledger;
    }
    throw new Error(
      'effect-ledger logical-operation append reuses an existing operation id with different data',
    );
  }
  let sequence = ledger.logicalOperations.at(-1)?.sequence ?? 0;
  const additions = inputs.map((input) => ({ sequence: ++sequence, ...input }));
  return {
    ...ledger,
    logicalOperations: [...ledger.logicalOperations, ...additions],
  };
}

function replaceEffectLogicalOperations(ledger, authority, value) {
  const replacements = captureReplacements(
    value,
    'operationId',
    'effect-ledger logical-operation replacement command',
  );
  const byId = new Map(
    ledger.logicalOperations.map((operation, index) => [
      operation.operationId,
      { operation, index },
    ]),
  );
  let alreadyApplied = true;
  const nextOperations = [...ledger.logicalOperations];
  for (const [index, replacement] of replacements.entries()) {
    const path = `effect-ledger logical-operation replacement command.replacements[${index}]`;
    assertLogicalOperationCommandShape(
      replacement.expected,
      `${path}.expected`,
    );
    assertLogicalOperationCommandShape(replacement.next, `${path}.next`);
    assertLogicalOperationAuthority(
      replacement.expected,
      authority,
      `${path}.expected`,
    );
    assertLogicalOperationAuthority(
      replacement.next,
      authority,
      `${path}.next`,
    );
    assertMonotonicLogicalReplacement(
      replacement.expected,
      replacement.next,
      path,
    );
    const current = byId.get(replacement.expected.operationId);
    if (current === undefined) {
      throw new Error(`${path} names an absent logical operation`);
    }
    if (!isDeepStrictEqual(current.operation, replacement.expected)) {
      throw new Error(`${path}.expected does not match the durable logical operation`);
    }
    if (isDeepStrictEqual(current.operation, replacement.next)) continue;
    alreadyApplied = false;
    nextOperations[current.index] = replacement.next;
  }
  if (alreadyApplied) return ledger;
  return {
    ...ledger,
    logicalOperations: nextOperations,
  };
}

function captureReplacements(value, identityKey, path) {
  const replacements = requireNonemptyBatch(value, `${path}.replacements`).map(
    (raw, index) => {
      const replacementPath = `${path}.replacements[${index}]`;
      const replacement = requireRecord(raw, replacementPath);
      rejectUnknownOrMissingKeys(
        replacement,
        ['expected', 'next'],
        replacementPath,
      );
      const expected = requireRecord(
        replacement.expected,
        `${replacementPath}.expected`,
      );
      const next = requireRecord(replacement.next, `${replacementPath}.next`);
      if (expected[identityKey] !== next[identityKey]) {
        throw new Error(
          `${replacementPath} cannot change ${identityKey}`,
        );
      }
      return { expected, next };
    },
  );
  assertDistinctCommandIdentities(
    replacements.map(({ expected }) => expected),
    identityKey,
    path,
  );
  return replacements;
}

function assertBoundaryAuthority(boundary, authority, path) {
  if (
    boundary.playbookId !== authority.playbookId ||
    !isDeepStrictEqual(
      boundary.canonicalWorktree,
      authority.canonicalWorktree,
    ) ||
    !authority.requiredRoleIds.includes(boundary.roleId)
  ) {
    throw new Error(`${path} does not match its schema-3 host authority`);
  }
}

function assertBoundaryCommandShape(boundary, path) {
  exactOptionalKeys(
    boundary,
    [...EFFECT_BOUNDARY_IDENTITY_KEYS, 'correctionBudget'],
    EFFECT_BOUNDARY_OPTIONAL_KEYS,
    path,
  );
}

function assertLogicalOperationAuthority(operation, authority, path) {
  if (operation.playbookId !== authority.playbookId) {
    throw new Error(`${path} does not match its schema-3 host authority`);
  }
}

function assertLogicalOperationCommandShape(operation, path) {
  exactOptionalKeys(
    operation,
    ['sequence', ...EFFECT_LOGICAL_START_KEYS],
    EFFECT_LOGICAL_OPTIONAL_KEYS,
    path,
  );
}

function assertDistinctCommandIdentities(values, key, label) {
  const identities = values.map((value) => value[key]);
  if (new Set(identities).size !== identities.length) {
    throw new Error(`effect-ledger ${label} contains duplicate ${key}`);
  }
}

function assertMonotonicBoundaryReplacement(expected, next, path) {
  for (const key of EFFECT_BOUNDARY_IDENTITY_KEYS) {
    if (!isDeepStrictEqual(expected[key], next[key])) {
      throw new Error(`${path}.next cannot change boundary field ${key}`);
    }
  }
  for (const key of [
    'after',
    'physicalReceipt',
    'finalText',
    'initialSemanticCandidate',
  ]) {
    if (
      expected[key] !== undefined &&
      !isDeepStrictEqual(expected[key], next[key])
    ) {
      throw new Error(`${path}.next cannot remove or replace boundary field ${key}`);
    }
  }
  if (
    expected.cohortId !== next.cohortId
  ) {
    throw new Error(`${path}.next cannot change boundary field cohortId`);
  }
  if (
    expected.logicalOperationId !== undefined &&
    expected.logicalOperationId !== next.logicalOperationId
  ) {
    throw new Error(
      `${path}.next cannot remove or replace boundary field logicalOperationId`,
    );
  }
  const expectedBudget = requireRecord(
    expected.correctionBudget,
    `${path}.expected.correctionBudget`,
  );
  const nextBudget = requireRecord(
    next.correctionBudget,
    `${path}.next.correctionBudget`,
  );
  if (
    expectedBudget.limit !== nextBudget.limit ||
    (expectedBudget.spent === true && nextBudget.spent !== true)
  ) {
    throw new Error(`${path}.next cannot replenish its correction budget`);
  }
  const candidateChanged =
    expected.semanticCandidate !== undefined &&
    !isDeepStrictEqual(
      expected.semanticCandidate,
      next.semanticCandidate,
    );
  if (expected.semanticCandidate === undefined) {
    if (next.initialSemanticCandidate !== undefined) {
      throw new Error(
        `${path}.next cannot add initialSemanticCandidate without replacing a prior candidate`,
      );
    }
  } else if (!candidateChanged) {
    if (
      expected.initialSemanticCandidate === undefined &&
      next.initialSemanticCandidate !== undefined
    ) {
      throw new Error(
        `${path}.next cannot add initialSemanticCandidate without replacing semanticCandidate`,
      );
    }
  } else if (
    next.semanticCandidate === undefined ||
    expected.initialSemanticCandidate !== undefined ||
    expectedBudget.spent !== true ||
    nextBudget.spent !== true ||
    !isDeepStrictEqual(
      next.initialSemanticCandidate,
      expected.semanticCandidate,
    )
  ) {
    throw new Error(
      `${path}.next cannot replace semanticCandidate without its spent one-way correction provenance`,
    );
  }
}

function assertMonotonicLogicalReplacement(expected, next, path) {
  for (const key of [
    'sequence',
    'operationId',
    'playbookId',
    'runtimeSessionId',
    'originalBaseline',
  ]) {
    if (!isDeepStrictEqual(expected[key], next[key])) {
      throw new Error(`${path}.next cannot change logical-operation field ${key}`);
    }
  }
  if (
    !Array.isArray(expected.boundaryIds) ||
    !Array.isArray(next.boundaryIds) ||
    expected.boundaryIds.some(
      (boundaryId, index) => next.boundaryIds[index] !== boundaryId,
    )
  ) {
    throw new Error(
      `${path}.next boundaryIds must preserve the existing ordered prefix`,
    );
  }
  if (
    expected.logicalReceipt !== undefined &&
    !isDeepStrictEqual(expected.logicalReceipt, next.logicalReceipt)
  ) {
    throw new Error(`${path}.next cannot remove or replace logicalReceipt`);
  }
}

function validateNextEffectLedger(previous, candidate) {
  if (!Number.isSafeInteger(previous.revision + 1)) {
    throw new Error('Captain session effect-ledger revision cannot advance');
  }
  const next = assertPlaybookEffectLedger(
    candidate,
    'Captain session next effect ledger',
  );
  if (!isPlaybookEffectLedgerMonotonicExtension(previous, next)) {
    throw new Error(
      'Captain session next effect ledger is not a monotonic extension',
    );
  }
  return next;
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
  { path, structural, artifactSchemas },
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
    if (!artifactSchemas.has(item.artifactSchema)) {
      const expected = artifactSchemas === CURRENT_ARTIFACT_SCHEMAS
        ? '3'
        : '2 or 3';
      throw new Error(`${itemPath}.artifactSchema must be ${expected}`);
    }
    if (
      item.options !== null &&
      typeof item.options === 'object' &&
      !Array.isArray(item.options) &&
      Object.prototype.hasOwnProperty.call(
        item.options,
        HOST_CAPABILITIES_OPTION_KEY,
      )
    ) {
      throw new Error(
        `${itemPath}.options.${HOST_CAPABILITIES_OPTION_KEY} is host-owned and cannot be persisted`,
      );
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

function assertSnapshotMatchesStructure(
  snapshot,
  structural,
  artifactSchemas = CURRENT_ARTIFACT_SCHEMAS,
) {
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
    const expectedLedger =
      artifactSchemas === PRE_EFFECT_ARTIFACT_SCHEMAS &&
      item.artifactSchema === 2
        ? emptyPlaybookEffectLedger()
        : snapshot.effectLedger;
    if (!isDeepStrictEqual(frame.runtime.effectLedger, expectedLedger)) {
      throw new Error(
        `Captain session snapshot frame ${JSON.stringify(frame.playbookId)} effect ledger differs from its structural schema authority`,
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

function settledAbandonmentMember(record) {
  return Object.hasOwn(record, 'settledAbandonment')
    ? { settledAbandonment: record.settledAbandonment }
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
  effectLedger,
) {
  assertEffectLedgerMatchesCatalog(effectLedger, targetStructural.catalog);
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
  effectLedger = record.effectLedger,
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
    snapshot: isDeepStrictEqual(record.snapshot.effectLedger, effectLedger)
      ? record.snapshot
      : { ...record.snapshot, effectLedger },
    effectLedger,
    unresolvedEffects: record.unresolvedEffects,
    retainedGenerations,
    ...(Object.hasOwn(record, 'settledAbandonment')
      ? { settledAbandonment: record.settledAbandonment }
      : {}),
  });
}

function validateRetainedGenerations(
  value,
  structural,
  authoritativeLedger,
  artifactSchemas = CURRENT_ARTIFACT_SCHEMAS,
) {
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
      ['effectLedger', 'frames'],
      ['retainedEffectReconciliation', 'rootStateDescription'],
      path,
    );
    const generationLedger = assertPlaybookEffectLedger(
      generation.effectLedger,
      `${path}.effectLedger`,
    );
    if (
      generationLedger.boundaries.some(
        ({ physicalReceipt }) => physicalReceipt === undefined,
      )
    ) {
      throw new Error(
        `${path}.effectLedger contains an incomplete physical boundary`,
      );
    }
    assertEffectLedgerMatchesCatalog(generationLedger, structural.catalog);
    if (
      !isPlaybookEffectLedgerMonotonicExtension(
        generationLedger,
        authoritativeLedger,
      )
    ) {
      throw new Error(
        `${path}.effectLedger is not a monotonic checkpoint of the authoritative Captain session effect ledger`,
      );
    }
    const generationReconciliation =
      generation.retainedEffectReconciliation === undefined
        ? undefined
        : requireRecord(
            generation.retainedEffectReconciliation,
            `${path}.retainedEffectReconciliation`,
          );
    if (generationReconciliation !== undefined) {
      rejectUnknownOrMissingKeys(
        generationReconciliation,
        ['sourceGenerationId'],
        `${path}.retainedEffectReconciliation`,
      );
      assertUuid(
        generationReconciliation.sourceGenerationId,
        `${path}.retainedEffectReconciliation.sourceGenerationId`,
      );
    }
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
        generationLedger,
        authoritativeLedger,
        sessionIds,
        `${path}.frames[${index}]`,
        artifactSchemas,
      ),
    );
    const schema3Frames = frames.filter(
      ({ playbookId }) =>
        structural.catalog[playbookId].artifactSchema === 3,
    );
    const markedFrames = frames.filter(
      ({ runtime }) =>
        runtime.retainedEffectReconciliation !== undefined,
    );
    const markedCaptureLedger = markedFrames[0]?.runtime.effectLedger;
    const sourceGenerationId =
      generationReconciliation?.sourceGenerationId;
    if (
      markedCaptureLedger !== undefined &&
      markedFrames.some(
        ({ runtime }) =>
          !isDeepStrictEqual(runtime.effectLedger, markedCaptureLedger),
      )
    ) {
      throw new Error(
        `${path} schema-3 frames differ from the marked generation capture mirror`,
      );
    }
    if (
      (sourceGenerationId === undefined && markedFrames.length !== 0) ||
      (sourceGenerationId !== undefined &&
        markedFrames.length !== schema3Frames.length) ||
      (sourceGenerationId !== undefined &&
        structural.catalog[frames[0].playbookId].artifactSchema === 3 &&
        frames[0].runtime.retainedEffectReconciliation?.sourceSessionId !==
          sourceGenerationId)
    ) {
      throw new Error(
        `${path}.retainedEffectReconciliation is inconsistent with its schema-3 frame markers`,
      );
    }
    validateRetainedGenerationPath(frames, rootPlaybookId, path);
  }
  return retained;
}

function validateRetainedGenerationFrame(
  value,
  index,
  rootPlaybookId,
  structural,
  generationLedger,
  authoritativeLedger,
  sessionIds,
  path,
  artifactSchemas = CURRENT_ARTIFACT_SCHEMAS,
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
  const runtimeReconciliation = runtime.retainedEffectReconciliation;
  if (
    artifactSchemas === PRE_EFFECT_ARTIFACT_SCHEMAS &&
    catalogItem.artifactSchema === 2 &&
    (!isDeepStrictEqual(runtime.effectLedger, emptyPlaybookEffectLedger()) ||
      runtimeReconciliation !== undefined ||
      runtime.retainedEffectSourceSessionId !== undefined)
  ) {
    throw new Error(
      `${path}.runtime schema-2 effect state must be empty`,
    );
  } else if (
    runtimeReconciliation === undefined &&
    !isDeepStrictEqual(runtime.effectLedger, generationLedger)
  ) {
    throw new Error(
      `${path}.runtime effect ledger differs from its retained-generation checkpoint`,
    );
  } else if (
    runtimeReconciliation !== undefined &&
    (!isDeepStrictEqual(runtimeReconciliation.checkpoint, generationLedger) ||
      isDeepStrictEqual(runtime.effectLedger, generationLedger) ||
      !isPlaybookEffectLedgerMonotonicExtension(
        runtime.effectLedger,
        authoritativeLedger,
      ))
  ) {
    throw new Error(
      `${path}.runtime retained-effect evidence differs from its generation checkpoint or capture-time authority`,
    );
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
  if (
    attemptId !== undefined &&
    record.uncertain.attemptId !== attemptId
  ) {
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
