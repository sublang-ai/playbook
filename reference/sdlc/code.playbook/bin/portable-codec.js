// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  validateCaptainSessionRecord,
  validateCaptainSessionExecutionProjection,
  sanitizeReplayRecord,
  SESSION_ID_PATTERN,
} from './session-store.js';

export const SESSION_MANIFEST_VERSION = 7;
export const EMPTY_REPLAY_SHA256 = createHash('sha256').digest('hex');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const COMMON = ['schemaVersion', 'kind', 'sessionId', 'cwd', 'createdAt', 'updatedAt', 'state', 'replay', 'contextSeq'];
const RECOVERY = ['structuralProjection', 'lastAppliedExecutionProjection', 'snapshot', 'effectLedger', 'unresolvedEffects'];
const OPTIONAL = ['retainedGenerations', 'settledAbandonment'];
const HEX = /^[0-9a-f]{64}$/;
const clone = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.length > 0;
function exact(value, required, optional = []) {
  if (!object(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error('invalid or unknown session format fields');
}
function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('session timestamp must be canonical ISO UTC');
}
export function validateReplayCheckpoint(value) {
  exact(value, ['seq', 'sha256', 'incomplete']);
  if (!Number.isSafeInteger(value.seq) || value.seq < 0 || !HEX.test(value.sha256) || typeof value.incomplete !== 'boolean' || (value.seq === 0 && value.sha256 !== EMPTY_REPLAY_SHA256)) throw new Error('invalid replay checkpoint');
  return clone(value);
}

// The schema-6 validator remains the legacy decoder and the shared in-memory
// recovery validator. Portable metadata never enters the runtime's snapshots.
export function validateSessionManifest(value) {
  if (!object(value) || value.schemaVersion !== 7) throw new Error(`unsupported session manifest schema ${value?.schemaVersion}`);
  const history = value.state === 'history-only';
  exact(value, [...COMMON, ...(history ? ['reason'] : RECOVERY), ...(value.state === 'uncertain' ? ['uncertain'] : [])], history ? [] : OPTIONAL);
  if (value.kind !== 'captain-session' || !SESSION_ID_PATTERN.test(value.sessionId) || !isAbsolute(value.cwd) || resolve(value.cwd) !== value.cwd) throw new Error('invalid session manifest identity');
  iso(value.createdAt); iso(value.updatedAt);
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new Error('session update precedes creation');
  validateReplayCheckpoint(value.replay);
  if (!(history && value.contextSeq === null) && (!Number.isSafeInteger(value.contextSeq) || value.contextSeq <= 0 || value.contextSeq > value.replay.seq)) throw new Error('invalid session context reference');
  if (history) {
    if (!nonempty(value.reason)) throw new Error('history-only session needs a reason');
  } else {
    const recovery = recoveryFromManifestUnchecked(value);
    validateCaptainSessionRecord(recovery);
    if (!isDeepStrictEqual(projectRecovery(recovery), recovery)) throw new Error('portable recovery contains provider continuation fields');
  }
  return clone(value);
}
function recoveryFromManifestUnchecked(value) {
  const { replay, contextSeq, ...recovery } = value;
  return { ...recovery, schemaVersion: 6 };
}
export function recoveryFromManifest(value) {
  const manifest = validateSessionManifest(value);
  if (manifest.state === 'history-only') throw new Error(manifest.reason);
  return validateCaptainSessionRecord(recoveryFromManifestUnchecked(manifest));
}
export function manifestFromRecovery(value, replay, contextSeq) {
  const recovery = projectRecovery(validateCaptainSessionRecord(value));
  return validateSessionManifest({ ...recovery, schemaVersion: 7, replay, contextSeq });
}
export function projectRecovery(value) {
  const source = clone(value);
  for (const key of ['snapshot', 'effectLedger', 'retainedGenerations']) {
    if (source[key] !== undefined) source[key] = clone(sanitizeReplayRecord(source[key]));
  }
  const catalog = source.structuralProjection.catalog;
  const continuation = (operation, ledger) => {
    if (!Object.hasOwn(operation, 'playerContinuation')) return;
    const binding = operation.playerContinuation;
    const entry = catalog[operation.playbookId];
    const roleId = operation.pendingQuestion?.asker?.kind === 'role'
      ? operation.pendingQuestion.asker.roleId
      : ledger.boundaries.find((item) => operation.boundaryIds.includes(item.boundaryId))?.roleId;
    const playerId = entry?.roles?.[roleId]?.playerId;
    if (!nonempty(playerId)) throw new Error('pending operation has ambiguous player identity');
    if (object(binding) && (!isDeepStrictEqual(binding, { v: 1, playerId }))) throw new Error('unsupported deferred player continuation binding');
    if (!object(binding) && binding !== false && !nonempty(binding)) throw new Error('unsupported deferred player continuation binding');
    operation.playerContinuation = { v: 1, playerId };
  };
  const visit = (node) => {
    if (!object(node)) return;
    if (object(node.captain) && object(node.playerSessions) && Array.isArray(node.journal)) {
      node.captain.conversation = { kind: node.journal.length === 0 ? 'unopened' : 'needsSeeding' };
      for (const entry of Object.values(node.playerSessions)) delete entry.resumeToken;
    }
    if (object(node.roleResumeTokens)) node.roleResumeTokens = {};
    if (node.schemaVersion === 1 && Array.isArray(node.boundaries) && Array.isArray(node.logicalOperations)) {
      for (const operation of node.logicalOperations) continuation(operation, node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'journal' && Array.isArray(child)) {
        node[key] = child.map((entry) => ({ ...entry, ...(object(entry.payload) ? { payload: sanitizeReplayRecord(entry.payload) } : {}) }));
      } else if (key !== 'configuration' && key !== 'structuralProjection' && key !== 'lastAppliedExecutionProjection' && key !== 'attemptedExecutionProjection') {
        if (Array.isArray(child)) child.forEach(visit); else visit(child);
      }
    }
  };
  visit(source);
  return source;
}
export function validateSessionContext(value) {
  exact(value, ['type', 'timestamp', 'contextVersion', 'captainId', 'configuration', 'graphs', 'initialVisible']);
  if (value.type !== 'session_context' || value.contextVersion !== 1 || !Number.isFinite(value.timestamp) || !SESSION_ID_PATTERN.test(value.captainId)) throw new Error('unsupported session context');
  const configuration = validateCaptainSessionExecutionProjection(value.configuration);
  const players = new Set(configuration.players.map(({ id }) => id));
  if (!Array.isArray(value.initialVisible) || value.initialVisible.some((id) => !players.has(id)) || new Set(value.initialVisible).size !== value.initialVisible.length) throw new Error('invalid initially visible players');
  if (!Array.isArray(value.graphs) || value.graphs.length !== Object.keys(configuration.catalog).length) throw new Error('context graphs must cover the catalog');
  const ids = new Set();
  for (const item of value.graphs) {
    exact(item, ['playbookId', 'graph']);
    if (!Object.hasOwn(configuration.catalog, item.playbookId) || ids.has(item.playbookId)) throw new Error('invalid context graph identity');
    ids.add(item.playbookId);
    if (item.graph !== null) validateGraph(item.graph);
  }
  return clone(value);
}
function validateGraph(graph) {
  exact(graph, ['initial', 'nodes', 'edges']);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('invalid graph arrays');
  const nodes = new Map();
  for (const node of graph.nodes) {
    exact(node, ['id', 'kind', 'tags'], ['parent', 'role', 'description']);
    if (!nonempty(node.id) || nodes.has(node.id) || !['state', 'final'].includes(node.kind) || !Array.isArray(node.tags) || node.tags.some((tag) => typeof tag !== 'string') || ['parent', 'role', 'description'].some((key) => Object.hasOwn(node, key) && typeof node[key] !== 'string')) throw new Error('invalid graph node');
    nodes.set(node.id, node);
  }
  if (!nodes.has(graph.initial)) throw new Error('graph initial node is absent');
  for (const node of nodes.values()) {
    const visited = new Set([node.id]);
    let parent = node.parent;
    while (parent !== undefined) {
      if (!nodes.has(parent) || visited.has(parent)) throw new Error('graph parent is absent or cyclic');
      visited.add(parent); parent = nodes.get(parent).parent;
    }
  }
  const edges = new Set();
  for (const edge of graph.edges) {
    exact(edge, ['id', 'from', 'to', 'event']);
    if (!nonempty(edge.id) || edges.has(edge.id) || !nodes.has(edge.from) || !nodes.has(edge.to) || typeof edge.event !== 'string') throw new Error('invalid graph edge');
    edges.add(edge.id);
  }
}
export function contextFromRecovery(record, graphs = [], initialVisible = []) {
  const configuration = record.state === 'uncertain' ? record.uncertain.attemptedExecutionProjection : record.lastAppliedExecutionProjection;
  return validateSessionContext({ type: 'session_context', timestamp: Date.now(), contextVersion: 1, captainId: record.snapshot.captain.sessionId, configuration, graphs: Object.keys(configuration.catalog).map((playbookId) => ({ playbookId, graph: graphs.find((item) => item.playbookId === playbookId)?.graph ?? null })), initialVisible });
}
export function validateSessionHints(value, manifestBytes, manifest) {
  exact(value, ['v', 'sessionId', 'checkpointSha256', 'players'], ['captain']);
  if (value.v !== 1 || value.sessionId !== manifest.sessionId || value.checkpointSha256 !== sha256(manifestBytes) || !object(value.players)) throw new Error('provider hints do not match the checkpoint');
  const players = new Set(manifest.structuralProjection?.players.map(({ id }) => id) ?? []);
  for (const [id, token] of Object.entries(value.players)) if (!players.has(id) || !nonempty(token)) throw new Error('invalid player hint');
  if (value.captain !== undefined) {
    const captain = value.captain;
    if (captain.kind === 'pinned') { exact(captain, ['kind', 'token']); if (!nonempty(captain.token)) throw new Error('invalid Captain hint'); }
    else if (captain.kind === 'needsCatchUp') { exact(captain, ['kind', 'resume', 'afterJournalSeq']); if (!(captain.resume === false || nonempty(captain.resume)) || !Number.isSafeInteger(captain.afterJournalSeq) || captain.afterJournalSeq < 0 || captain.afterJournalSeq > manifest.snapshot.sequences.journal) throw new Error('invalid Captain catch-up hint'); }
    else throw new Error('invalid Captain conversation hint');
  }
  return clone(value);
}
export function attachSessionHints(snapshot, hints) {
  const result = clone(snapshot);
  if (hints?.captain) result.captain.conversation = clone(hints.captain);
  for (const [id, token] of Object.entries(hints?.players ?? {})) if (result.playerSessions[id]) result.playerSessions[id].resumeToken = token;
  const visit = (node, inheritedBindings = {}) => {
    if (!object(node)) return;
    const bindings = node.roleBindings ?? inheritedBindings;
    if (object(node.roleResumeTokens)) {
      node.roleResumeTokens = Object.fromEntries(Object.entries(bindings).flatMap(([role, binding]) => {
        const token = hints?.players?.[typeof binding === 'string' ? binding : binding.playerId];
        return token === undefined ? [] : [[role, token]];
      }));
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach((item) => visit(item, bindings)); else visit(child, bindings);
  };
  visit(result);
  return result;
}
