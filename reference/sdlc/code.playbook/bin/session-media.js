// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { externalizeAgentEvent } from '../session-assets.js';

/** Externalize authentic observed media before the opaque replay writer sees it. */
export function createSessionMediaProjector({ lease, onEvidence }) {
  const players = new Map();
  let preparation;
  const seen = new Map();
  const beginPreparation = (runtimeSessionId) => {
    if (preparation) throw new Error('a preparation media scope is already active');
    const scope = { callId: randomUUID(), origin: { kind: 'preparation', actorId: 'captain', runtimeSessionId } };
    preparation = scope;
    return () => { if (preparation === scope) preparation = undefined; seen.delete(scope.callId); };
  };
  const project = async (record) => {
    if (record.type === 'captain_telemetry' && record.topic === 'playbook.trace') {
      const trace = record.payload;
      if (trace?.schemaVersion === 4 && trace.type === 'player.call.started' && typeof trace.callId === 'string' && typeof trace.sessionId === 'string' && typeof trace.payload?.playerId === 'string') {
        players.set(trace.payload.playerId, { callId: trace.callId, origin: { kind: 'player', actorId: trace.payload.playerId, runtimeSessionId: trace.sessionId } });
      }
    }
    if (record.type === 'player_prompt' && !players.has(record.playerId)) players.set(record.playerId, { callId: randomUUID(), origin: { kind: 'player', actorId: record.playerId } });
    if (record.type === 'player_finished') { const scope = players.get(record.playerId); if (scope) seen.delete(scope.callId); players.delete(record.playerId); }
    if (record.type !== 'player_event' && record.type !== 'captain_event') return [record];
    const event = record.event;
    const scope = record.type === 'player_event' ? players.get(record.playerId) : preparation;
    try {
      const { event: projected, asset } = await externalizeAgentEvent(lease, event);
      const stored = projected === event ? record : { ...record, event: projected };
      if (!asset || !scope || typeof record.turnId !== 'number') return [stored];
      let emitted = seen.get(scope.callId);
      if (!emitted) { emitted = new Set(); seen.set(scope.callId, emitted); }
      if (emitted.has(asset.assetId)) return [stored];
      emitted.add(asset.assetId);
      const origin = { ...scope.origin, ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}) };
      await onEvidence?.(asset, origin);
      return [stored, { type: 'playbook_evidence', timestamp: record.timestamp, turnId: record.turnId, callId: scope.callId, origin, asset }];
    } catch (error) {
      return [{ type: 'runtime_error', timestamp: record.timestamp, turnId: record.turnId, sourceRecordType: record.type, message: `Media could not be saved: ${error instanceof Error ? error.message : String(error)}` }];
    }
  };
  return Object.freeze({ project, beginPreparation });
}
