// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Test-only Captain session boundaries for storage tests: one Captain, one
// player, the CODE catalog entry and a quiescent routing snapshot.
import { projectCaptainSessionStructure } from '../session-store.js';

const captainRuntimeId = '80000000-0000-4000-8000-000000000001';
export function executionProjection() {
  return {
    schemaVersion: 2,
    captain: { adapter: 'claude', model: { kind: 'provider-default' }, effort: { kind: 'provider-default' }, permissions: { mode: 'auto' } },
    players: [{ id: 'dev.coder', adapter: 'codex', model: { kind: 'provider-default' }, effort: { kind: 'value', value: 'high' }, permissions: { fileWrite: 'ask' } }],
    catalog: { code: {
      id: 'code', from: '@sublang/playbook/code/registry', manifestCommand: 'code', command: 'code', intent: 'Implement a requested change.',
      artifactSchema: 3, requiredRoleIds: ['coder'], concurrentRoleSets: [],
      roles: { coder: { playerId: 'dev.coder', model: { kind: 'provider-default' }, effort: { kind: 'value', value: 'high' } } }, options: {},
    } },
  };
}
export const effectLedger = () => ({ schemaVersion: 1, revision: 0, boundaries: [], logicalOperations: [] });
export function shellSnapshot(turn = 0, payload = 'next') {
  const structural = projectCaptainSessionStructure(executionProjection() as any);
  const state = { value: 'routing', activeStateIds: ['routing'], tags: ['playbook.parked'], status: 'active', quiescent: true, stateId: 'routing' };
  const journal = Array.from({ length: turn }, (_, index) => ({ seq: index + 1, turnId: index + 1, kind: 'boss', payload }));
  return {
    schemaVersion: 4,
    captain: {
      sessionId: captainRuntimeId,
      runtime: { schemaVersion: 4, playbookId: 'captain', machine: { value: state.value, status: state.status }, roleResumeTokens: {},
        sequences: { trace: 0, turn, judgeCall: 0, playerCall: 0, playbookCall: 0, captainCall: 0 }, state, pendingBossQuestions: [], effectLedger: effectLedger() },
      agent: structural.captain, conversation: turn === 0 ? { kind: 'unopened' } : { kind: 'needsSeeding' },
    },
    playerSessions: Object.fromEntries(structural.players.map(({ id, ...agent }: any) => [id, agent])),
    issuedSessionIds: [captainRuntimeId], sequences: { turn, journal: journal.length }, journal, effectLedger: effectLedger(),
    ...(turn ? { lastAction: 'respond', lastSettlementStatus: 'ok' } : {}), mode: 'chat',
  };
}
export function freshBoundary() {
  const execution = executionProjection();
  return { cwd: process.cwd(), structuralProjection: projectCaptainSessionStructure(execution as any), executionProjection: execution, snapshot: shellSnapshot(0) };
}
