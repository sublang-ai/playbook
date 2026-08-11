// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-23: settled headless Captain sessions are durable, host-neutral
// records. Concurrency exclusion and uncertain-turn write-ahead state belong
// to IR-041 Task 8; this store only replaces complete settled records.

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
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { snapshotJsonValue } from '../../../../src/xstate-runtime.js';

export const CAPTAIN_SESSION_RECORD_SCHEMA_VERSION = 2;
export const CAPTAIN_SESSION_RECORD_KIND = 'captain-session';
export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RECORD_KEYS = [
  'schemaVersion',
  'kind',
  'sessionId',
  'createdAt',
  'updatedAt',
  'cwd',
  'config',
  'snapshot',
];
const DEFAULT_FS_OPERATIONS = Object.freeze({
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
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
  const fs = { ...DEFAULT_FS_OPERATIONS, ...(options.fsOps ?? {}) };

  if (!isAbsolute(sessionsDir)) {
    throw new Error('Captain session store path must be absolute');
  }

  const pathFor = (sessionId) => {
    assertSessionId(sessionId);
    return join(sessionsDir, `${sessionId}.json`);
  };

  const read = async (sessionId) => {
    const path = pathFor(sessionId);
    let text;
    try {
      await assertPrivateDirectory(sessionsDir, fs);
      const pathStat = await fs.lstat(path);
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
        throw new Error('record path is not a real regular file');
      }
      const handle = await fs.open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw new Error('record path is not a regular file');
        }
        if ((stat.mode & 0o7777) !== 0o600) {
          throw new Error('record permissions must be 0600');
        }
        text = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        throw new Error(`Captain session ${JSON.stringify(sessionId)} does not exist`);
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
      // Canonically named files are store-owned. Fail closed rather than
      // silently falling back past a corrupt or tampered logical session.
      candidates.push(await read(sessionId));
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

  const commitNew = async ({ sessionId, cwd, config, snapshot }) => {
    assertSessionId(sessionId);
    const timestamp = timestampFrom(now(), 'session timestamp');
    const record = validateCaptainSessionRecord({
      schemaVersion: CAPTAIN_SESSION_RECORD_SCHEMA_VERSION,
      kind: CAPTAIN_SESSION_RECORD_KIND,
      sessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      cwd,
      config,
      snapshot,
    });
    try {
      await fs.lstat(pathFor(sessionId));
      throw new Error(`Captain session ${JSON.stringify(sessionId)} already exists`);
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
    }
    await replace(record, { noReplace: true });
    return record;
  };

  const commitNext = async (previous, snapshot) => {
    const prior = validateCaptainSessionRecord(previous);
    const updatedAt = nextTimestamp(now(), prior.updatedAt);
    const record = validateCaptainSessionRecord({
      ...prior,
      updatedAt,
      snapshot,
    });
    await replace(record, { noReplace: false });
    return record;
  };

  const replace = async (record, { noReplace }) => {
    const destination = pathFor(record.sessionId);
    await ensurePrivateDirectory(sessionsDir, fs);

    const tempId = createTempId();
    if (typeof tempId !== 'string' || !SESSION_ID_PATTERN.test(tempId)) {
      throw new Error('Captain session temporary id generator returned a non-UUID value');
    }
    const temporary = join(
      sessionsDir,
      `.${record.sessionId}.${process.pid}.${tempId}.tmp`,
    );
    let handle;
    let ownsTemporary = false;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      ownsTemporary = true;
      await handle.chmod(0o600);
      if (!(await handle.stat()).isFile()) {
        throw new Error('Captain session temporary path is not a regular file');
      }
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (noReplace) {
        try {
          await fs.link(temporary, destination);
        } catch (cause) {
          if (cause?.code === 'EEXIST') {
            throw new Error(
              `Captain session ${JSON.stringify(record.sessionId)} already exists`,
            );
          }
          throw cause;
        }
        await fs.unlink(temporary);
        ownsTemporary = false;
      } else {
        await fs.rename(temporary, destination);
        ownsTemporary = false;
      }
      await syncDirectory(sessionsDir, fs);
    } catch (cause) {
      try {
        await handle?.close();
      } catch {
        // Preserve the persistence failure.
      }
      if (ownsTemporary) {
        try {
          await fs.unlink(temporary);
        } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT') {
            // Preserve the persistence failure. The exact private temp path is
            // deliberately not broadened into a cleanup scan.
          }
        }
      }
      throw cause;
    }
  };

  return Object.freeze({ sessionsDir, read, latest, commitNew, commitNext });
}

export function validateCaptainSessionRecord(value) {
  const record = requireRecord(
    snapshotJsonValue(value, 'Captain session record'),
    'Captain session record',
  );
  rejectUnknownOrMissingKeys(record, RECORD_KEYS, 'Captain session record');
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
  if (typeof record.cwd !== 'string' || !isAbsolute(record.cwd)) {
    throw new Error('Captain session record cwd must be an absolute path');
  }
  if (resolve(record.cwd) !== record.cwd) {
    throw new Error('Captain session record cwd must be normalized');
  }
  requireRecord(record.config, 'Captain session record config');
  requireRecord(record.snapshot, 'Captain session record snapshot');

  return record;
}

function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new Error('Captain session id must be a UUID');
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
  if (typeof value !== 'string') {
    throw new Error(`Captain session record ${field} must be an ISO timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`Captain session record ${field} must be a canonical ISO timestamp`);
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
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
    }
    await assertDirectoryNotLink(directory, fs);
    await fs.chmod(directory, 0o700);
    await syncDirectory(dirname(directory), fs);
  }
  await assertDirectoryNotLink(path, fs);
  await fs.chmod(path, 0o700);
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
