// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createEvent } from '@sublang/cligent';
import { runPlaybookCli } from '../bin/playbook.js';

const sessionId = process.env.PLAYBOOK_FIXTURE_SESSION_ID;
const attemptId = process.env.PLAYBOOK_FIXTURE_ATTEMPT_ID;
const nextAttemptId = process.env.PLAYBOOK_FIXTURE_NEXT_ATTEMPT_ID;
const sessionsDir = process.env.PLAYBOOK_FIXTURE_SESSIONS_DIR;
const configPath = process.env.PLAYBOOK_FIXTURE_CONFIG;
const mode = process.env.PLAYBOOK_FIXTURE_MODE;
const events = [];
let activePlayerInput = '';

function recordEvent(event) {
  events.push(event);
}

class FixtureAdapter {
  agent = 'claude-code';

  async *run(prompt) {
    if (prompt === 'fixture governed player') {
      recordEvent('player');
      process.send?.({
        type: 'effect',
        input: activePlayerInput,
        mode,
      });
      if (mode.startsWith('crash')) {
        await new Promise(() => {
          // Keep the process alive after the governed boundary is durable but
          // before the operation can publish its physical receipt.
          setInterval(() => {}, 1_000);
        });
      }
    }
    yield createEvent('done', this.agent, {
      status: 'success',
      result: `fixture:${prompt}`,
      resumeToken: 'fixture-token',
      usage: { toolUses: 0 },
      durationMs: 1,
    });
  }

  async isAvailable() {
    return true;
  }
}

function runtimeSnapshot(
  playbookId,
  turn,
  state,
  effectLedger,
  roleResumeTokens = {},
) {
  return {
    schemaVersion: 4,
    playbookId,
    machine: { value: state.value, status: state.status },
    roleResumeTokens,
    sequences: {
      trace: 0,
      turn,
      judgeCall: 0,
      playerCall: turn,
      playbookCall: 0,
      captainCall: 0,
    },
    state,
    pendingBossQuestions: [],
    effectLedger,
  };
}

globalThis.__createCrashFixtureRuntime = (_options, hostCapabilities) => {
  recordEvent('fixture-runtime');
  let session;
  let turn = 0;
  let state = activeState();
  return {
    async init(next) {
      session = next;
    },
    async restore(next, snapshot) {
      session = next;
      turn = snapshot.sequences.turn;
      state = snapshot.state;
    },
    exportSnapshot() {
      return runtimeSnapshot(
        'fixture',
        turn,
        state,
        hostCapabilities.effectLedger.snapshot(),
        session?.playerSessions?.snapshot() ?? {},
      );
    },
    async handleBossInput({ text, signal }) {
      turn += 1;
      activePlayerInput = text;
      const retrying = mode.startsWith('retry');
      const boundaryId = retrying
        ? '90000000-0000-4000-8000-000000000035'
        : '90000000-0000-4000-8000-000000000034';
      const exclusive = await hostCapabilities.repository.runExclusive({
        signal,
        effectBoundary: {
          boundaryId,
          runtimeSessionId: session.sessionId,
          turnId: turn,
          callId: retrying ? 'worker:retry' : 'worker:initial',
          roleId: 'worker',
          sourceStateId: 'fixture.work',
          sourceOutcomeSchema: { type: 'object' },
          dispositions: ['unchanged'],
          correctionBudget: { limit: 1, spent: false },
        },
        operation: () =>
          session.ports.callPlayer('worker', 'fixture governed player', signal, {
            resume: false,
          }),
        completeEffectBoundary: ({ operation }) =>
          operation.status === 'fulfilled'
            ? { finalText: operation.value.finalText }
            : {},
      });
      if (exclusive.operation.status !== 'fulfilled') {
        throw exclusive.operation.reason;
      }
      session.playerSessions?.update(
        'worker',
        exclusive.operation.value.resumeToken,
      );
      state = activeState();
      return {
        outcome: 'quiescent',
        state,
      };
    },
    async resumePlaybookCall() {
      return { outcome: 'no-action', state };
    },
    async dispose() {},
  };
};

function activeState() {
  return {
    value: 'ready',
    activeStateIds: ['ready'],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId: 'ready',
  };
}

function createFixtureCaptainRuntime({ controller }) {
  recordEvent('captain-runtime');
  let turn = 0;
  let session;
  return {
    async init(next) {
      session = next;
    },
    async restore(next, snapshot) {
      session = next;
      turn = snapshot.sequences.turn;
    },
    exportSnapshot() {
      const state = activeState();
      return {
        schemaVersion: 4,
        playbookId: 'captain',
        machine: { value: state.value, status: state.status },
        roleResumeTokens: {},
        sequences: {
          trace: 0,
          turn,
          judgeCall: 0,
          playerCall: 0,
          playbookCall: 0,
          captainCall: 0,
        },
        state,
        pendingBossQuestions: [],
        effectLedger: {
          schemaVersion: 1,
          revision: 0,
          boundaries: [],
          logicalOperations: [],
        },
      };
    },
    async handleBossInput({ text, signal }) {
      turn += 1;
      await controller.submit(
        { action: 'start', playbookId: 'fixture', input: text },
        signal,
      );
      await session.ports.emitTelemetry({
        topic: 'playbook.trace',
        payload: {
          type: 'captain.call.started',
          payload: { stateId: 'reporting' },
        },
      });
      await session.ports.callCaptain('fixture recovery reply', signal, {
        visibility: 'hidden',
        resume: false,
        allowedTools: [],
      });
      return { outcome: 'quiescent', state: activeState() };
    },
    async resumePlaybookCall() {
      return { outcome: 'no-action', state: activeState() };
    },
    async dispose() {},
  };
}

const argv =
  mode.startsWith('crash')
    ? ['run', process.env.PLAYBOOK_FIXTURE_INPUT]
    : ['run', '--session', sessionId, '--retry-uncertain'];

const result = await runPlaybookCli({
  argv,
  userConfigPath: configPath,
  env: { ANTHROPIC_API_KEY: 'fixture' },
  adapterImports: { claude: async () => FixtureAdapter },
  createCaptainRuntime: createFixtureCaptainRuntime,
  createLogicalSessionId: () => sessionId,
  createCaptainSessionId: (() => {
    let value = mode.startsWith('retry') ? 2 : 0;
    return () =>
      `10000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
  })(),
  createAttemptId: () =>
    mode.startsWith('crash') ? attemptId : nextAttemptId,
  probeAdapterSdk: async () => true,
  sessionsDir,
  readStdin: async () => {
    process.send?.({ type: 'stdin-read' });
    throw new Error('recovery must not read stdin');
  },
});

process.send?.({ type: 'result', result, events });
