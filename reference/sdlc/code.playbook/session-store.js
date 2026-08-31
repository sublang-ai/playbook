// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  RECORDS_STREAM_VERSION,
  createCaptainSessionStore,
  defaultCaptainSessionsDir,
} from './bin/session-store.js';

export { RECORDS_STREAM_VERSION };

export function defaultSessionsDir() {
  return defaultCaptainSessionsDir();
}

export function openSessionStore(sessionsDir) {
  if (typeof sessionsDir !== 'string') {
    throw new TypeError('session store path must be a string');
  }
  return wrapStore(createCaptainSessionStore({ sessionsDir }));
}

function wrapStore(store) {
  return Object.freeze({
    sessionsDir: store.sessionsDir,
    list: async () => projectListResult(await store.listSummaries()),
    read: async (sessionId) =>
      projectSummary(await store.readSummary(sessionId)),
    readStream: async (sessionId, options) =>
      projectReadResult(await store.readStream(sessionId, options)),
    acquire: async (sessionId) => wrapLease(await store.acquire(sessionId)),
  });
}

function wrapLease(lease) {
  let finalStatus;
  let releaseInFlight;

  const release = () => {
    if (finalStatus !== undefined) return Promise.resolve(finalStatus);
    if (releaseInFlight !== undefined) return releaseInFlight;
    const operation = lease.release();
    releaseInFlight = operation.then(
      (status) => {
        finalStatus = projectStatus(status);
        return finalStatus;
      },
      (cause) => {
        releaseInFlight = undefined;
        throw cause;
      },
    );
    return releaseInFlight;
  };

  return Object.freeze({
    sessionId: lease.sessionId,
    ownerToken: lease.ownerToken,
    append: (record, role) => lease.append(record, role),
    readStream: async (options) => {
      if (finalStatus !== undefined) {
        throw new Error('released session lease has no live replay reader');
      }
      return projectLeaseReadResult(await lease.readStream(options));
    },
    streamStatus: () => finalStatus ?? projectStatus(lease.streamStatus()),
    release,
  });
}

function projectListResult(result) {
  return Object.freeze({
    sessions: Object.freeze(result.sessions.map(projectSummary)),
    skipped: Object.freeze(
      result.skipped.map(({ sessionId, reason }) =>
        Object.freeze({ sessionId, reason }),
      ),
    ),
  });
}

function projectSummary(summary) {
  return Object.freeze({
    schemaVersion: summary.schemaVersion,
    sessionId: summary.sessionId,
    state: summary.state,
    cwd: summary.cwd,
    updatedAt: summary.updatedAt,
  });
}

function projectReadResult(result) {
  return Object.freeze({
    entries: Object.freeze([...result.entries]),
    lastReadableSeq: result.lastReadableSeq,
  });
}

function projectLeaseReadResult(result) {
  return Object.freeze({
    ...projectReadResult(result),
    lastDurableSeq: result.lastDurableSeq,
    incomplete: result.incomplete,
  });
}

function projectStatus(status) {
  return Object.freeze({
    lastReadableSeq: status.lastReadableSeq,
    lastDurableSeq: status.lastDurableSeq,
    incomplete: status.incomplete,
  });
}
