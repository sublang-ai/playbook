// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

const PLAYER_RECORD_TYPES = new Set([
  'player_prompt',
  'player_event',
  'player_finished',
]);

export function createReplayRecordObserver({ lease, onIncomplete, onStored }) {
  const activeFrames = new Map();
  let incompleteReported = false;
  let lastIncomplete = readIncomplete(lease);
  let lastDeliveredSeq = 0;
  try { lastDeliveredSeq = lease.streamStatus().lastReadableSeq ?? 0; } catch { /* Unavailable replay has no delivery cursor. */ }
  let deliveryQueue = Promise.resolve();
  const flushStoredRecords = () => {
    if (!onStored) return Promise.resolve();
    const operation = deliveryQueue.then(async () => {
      const result = await lease.readStream({ afterSeq: lastDeliveredSeq });
      for (const entry of result.entries) {
        await onStored(entry, lease.streamStatus());
        lastDeliveredSeq = entry.seq;
      }
    });
    deliveryQueue = operation.catch(() => reportIfIncomplete());
    return deliveryQueue;
  };

  const reportIfIncomplete = async (knownStatus) => {
    if (incompleteReported) return;
    const incomplete = readIncomplete(lease, knownStatus);
    if (incomplete === undefined) return;
    lastIncomplete = incomplete;
    if (!incomplete) return;
    incompleteReported = true;
    try {
      await onIncomplete();
    } catch {
      // Replay warnings are presentation-only and never change host outcome.
    }
  };

  const observer = Object.freeze({
    async onRecord(record) {
      let role;
      try {
        role = roleForReplayRecord(activeFrames, record);
      } catch {
        // The writer sanitizer remains authoritative for hostile values.
      }
      try {
        await lease.append(record, ...(role === undefined ? [] : [role]));
        await flushStoredRecords();
      } catch {
        // The replay writer records failure in its live latch. The observer
        // remains installed so later host records and lifecycle work continue.
      }
      const incomplete = readIncomplete(lease);
      if (incomplete === undefined) return;
      const transitioned = lastIncomplete === false && incomplete;
      lastIncomplete = incomplete;
      if (transitioned) await reportIfIncomplete({ incomplete: true });
    },
  });

  return Object.freeze({ observer, reportIfIncomplete, flushStoredRecords });
}

function readIncomplete(lease, knownStatus) {
  try {
    const status = knownStatus ?? lease.streamStatus();
    return typeof status?.incomplete === 'boolean'
      ? status.incomplete
      : undefined;
  } catch {
    return undefined;
  }
}

export function replayIncompleteMessage(sessionId) {
  return `warning: replay history for session ${JSON.stringify(sessionId)} may be incomplete; recording has stopped`;
}

function roleForReplayRecord(activeFrames, record) {
  let trace;
  try {
    trace = playerTraceFrame(record);
  } catch {
    return undefined;
  }
  if (trace !== undefined) {
    const sessionFrames = activeFrames.get(trace.sessionId);
    if (trace.type === 'player.call.started') {
      if (sessionFrames?.has(trace.callId)) return undefined;
      const frames = sessionFrames ?? new Map();
      frames.set(trace.callId, {
        playerId: trace.playerId,
        roleId: trace.roleId,
      });
      if (sessionFrames === undefined) activeFrames.set(trace.sessionId, frames);
    } else {
      const frame = sessionFrames?.get(trace.callId);
      if (
        frame?.playerId === trace.playerId &&
        frame.roleId === trace.roleId
      ) {
        sessionFrames.delete(trace.callId);
        if (sessionFrames.size === 0) activeFrames.delete(trace.sessionId);
      }
    }
    return undefined;
  }

  if (!isRecord(record) || !PLAYER_RECORD_TYPES.has(record.type)) {
    return undefined;
  }
  if (!isNonemptyString(record.playerId)) return undefined;

  const roles = new Set();
  for (const sessionFrames of activeFrames.values()) {
    for (const frame of sessionFrames.values()) {
      if (frame.playerId === record.playerId) roles.add(frame.roleId);
      if (roles.size > 1) return undefined;
    }
  }
  return roles.size === 1 ? roles.values().next().value : undefined;
}

function playerTraceFrame(record) {
  if (
    !isRecord(record) ||
    record.type !== 'captain_telemetry' ||
    record.topic !== 'playbook.trace' ||
    !isRecord(record.payload)
  ) {
    return undefined;
  }
  const trace = record.payload;
  if (
    !isSchema4PlayerTraceEvent(trace) ||
    (trace.type !== 'player.call.started' &&
      trace.type !== 'player.call.finished') ||
    (trace.type === 'player.call.started'
      ? typeof trace.payload.prompt !== 'string'
      : !['ok', 'aborted', 'error'].includes(trace.payload.status))
  ) {
    return undefined;
  }
  return {
    type: trace.type,
    sessionId: trace.sessionId,
    callId: trace.callId,
    playerId: trace.payload.playerId,
    roleId: trace.payload.roleId,
  };
}

function isSchema4PlayerTraceEvent(trace) {
  if (
    !hasOwnValue(trace, 'schemaVersion', 4) ||
    !hasOwnNonemptyString(trace, 'sessionId') ||
    !hasOwnNonemptyString(trace, 'playbookId') ||
    !hasOwnNonemptyString(trace, 'rootSessionId') ||
    !hasOwnNonnegativeSafeInteger(trace, 'depth') ||
    !hasOwnPositiveSafeInteger(trace, 'sequence') ||
    !hasOwnFiniteNonnegativeNumber(trace, 'timestamp') ||
    !optionalPositiveSafeInteger(trace, 'turnId') ||
    !hasOwnNonemptyString(trace, 'callId') ||
    !optionalNonemptyString(trace, 'parentSessionId') ||
    !optionalNonemptyString(trace, 'parentCallId') ||
    !isRecord(trace.payload) ||
    !hasOwnNonemptyString(trace.payload, 'playerId') ||
    !hasOwnNonemptyString(trace.payload, 'roleId') ||
    !hasOwnResumeSelection(trace.payload)
  ) {
    return false;
  }
  return true;
}

function hasOwnValue(value, key, expected) {
  return Object.hasOwn(value, key) && value[key] === expected;
}

function hasOwnNonemptyString(value, key) {
  return Object.hasOwn(value, key) && isNonemptyString(value[key]);
}

function optionalNonemptyString(value, key) {
  return !Object.hasOwn(value, key) || isNonemptyString(value[key]);
}

function optionalPositiveSafeInteger(value, key) {
  return !Object.hasOwn(value, key) || hasOwnPositiveSafeInteger(value, key);
}

function hasOwnNonnegativeSafeInteger(value, key) {
  return (
    Object.hasOwn(value, key) &&
    Number.isSafeInteger(value[key]) &&
    value[key] >= 0
  );
}

function hasOwnPositiveSafeInteger(value, key) {
  return (
    Object.hasOwn(value, key) &&
    Number.isSafeInteger(value[key]) &&
    value[key] > 0
  );
}

function hasOwnFiniteNonnegativeNumber(value, key) {
  return (
    Object.hasOwn(value, key) &&
    typeof value[key] === 'number' &&
    Number.isFinite(value[key]) &&
    value[key] >= 0
  );
}

function hasOwnResumeSelection(value) {
  return (
    Object.hasOwn(value, 'resume') &&
    (value.resume === false ||
      (typeof value.resume === 'string' && value.resume.trim().length > 0))
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
