// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createEvent } from '@sublang/cligent';
import { runManagedTmuxPlaySession } from '@sublang/cligent/tmux-play';
import { createManagedInteractiveLifecycle } from '../bin/interactive-session.js';
import { createCaptainSessionHost } from '../bin/run.js';
import { createCaptainSessionStore } from '../bin/session-store.js';

const payload = JSON.parse(requiredEnv('PLAYBOOK_MANAGED_PAYLOAD'));
const tokenNamespace = requiredEnv('PLAYBOOK_TOKEN_NAMESPACE');
const failReplyObserver = process.env.PLAYBOOK_FAIL_REPLY_OBSERVER === '1';
const failReplayAppend = process.env.PLAYBOOK_FAIL_REPLAY_APPEND === '1';
const retainParked = process.env.PLAYBOOK_RETAIN_PARKED === '1';
const resumeArbitration = process.env.PLAYBOOK_RESUME_ARBITRATION === '1';
const sessionIdPrefix =
  process.env.PLAYBOOK_SESSION_ID_PREFIX ?? '70000000';
const store = createCaptainSessionStore({ sessionsDir: payload.sessionsDir });
const lifecycleStore = failReplayAppend ? replayFailingStore(store) : store;
const input = new PassThrough();
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (failReplayAppend) {
      send({ type: 'presentation-output', text: String(chunk) });
    }
    callback();
  },
});
const releaseReadiness = deferred();
let sessionIdSequence = 0;
let attemptSequence = 0;
let playerCallSequence = 0;
let captainCallSequence = 0;
let replayTraceSequence = 0;
let replayCallSequence = 0;

class FixtureAdapter {
  agent = 'claude-code';

  async *run(prompt, options) {
    const kind = prompt.includes('cross-front-player:') ? 'player' : 'captain';
    const sequence =
      kind === 'player' ? ++playerCallSequence : ++captainCallSequence;
    const durable = await store.read(payload.sessionId);
    send({
      type: 'effect',
      kind,
      prompt,
      resume: options?.resume,
      model: options?.model,
      effort: options?.effort,
      durableState: durable.state,
    });
    const result =
      kind === 'player'
        ? `worker result ${sequence}`
        : resumeArbitration &&
            prompt.includes('Select exactly one action from the closed set')
          ? captainDecision(prompt)
          : `Cross-front durable reply ${tokenNamespace}:${sequence}`;
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result,
        resumeToken: `${kind}-token:${tokenNamespace}:${sequence}`,
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      `transport:${tokenNamespace}:${kind}:${sequence}`,
    );
  }

  async isAvailable() {
    return true;
  }
}

const adapterImports = Object.fromEntries(
  ['claude', 'codex', 'gemini', 'kimi', 'opencode'].map((adapter) => [
    adapter,
    async () => FixtureAdapter,
  ]),
);

const baseLifecycle = createManagedInteractiveLifecycle(payload, {
  sessionStore: lifecycleStore,
  loadModule: async (specifier) => {
    if (specifier !== 'mod://code') {
      throw new Error(`unexpected registry module ${JSON.stringify(specifier)}`);
    }
    return { default: fixtureRegistryEntry() };
  },
  adapterImports,
  createSessionHost: createObservedSessionHost,
  ...(resumeArbitration
    ? {}
    : { createCaptainRuntime: fixtureCaptainRuntime }),
  createCaptainSessionId: () =>
    `${sessionIdPrefix}-0000-4000-8000-${String(++sessionIdSequence).padStart(12, '0')}`,
  createAttemptId: () =>
    `71000000-0000-4000-8000-${String(++attemptSequence).padStart(12, '0')}`,
});

const lifecycle = {
  async initializeRuntime(context) {
    const runtime = await baseLifecycle.initializeRuntime(context);
    send({ type: 'initialized', pid: process.pid });
    await releaseReadiness.promise;
    return runtime;
  },
  beforeNonEmptyTurn: (context) => baseLifecycle.beforeNonEmptyTurn(context),
  afterTurn: (context) => baseLifecycle.afterTurn(context),
  shutdown: (context) => baseLifecycle.shutdown(context),
};

process.on('message', (message) => {
  if (message?.type === 'release-readiness') {
    releaseReadiness.resolve();
  } else if (message?.type === 'submit') {
    input.write(`${message.text}\n`);
  } else if (message?.type === 'close') {
    input.end();
  }
});

try {
  await runManagedTmuxPlaySession({
    sessionId: payload.sessionId,
    workDir: payload.workDir,
    workDirOwnedByLauncher: payload.workDirOwnedByLauncher,
    cwd: payload.cwd,
    readinessPath: payload.readinessPath,
    inputGatePath: payload.inputGatePath,
    inputActivePath: payload.inputActivePath,
    shutdownRequestPath: payload.shutdownRequestPath,
    shutdownCompletePath: payload.shutdownCompletePath,
    lifecycle,
    input,
    output,
    adapterImports,
    observers: [
      {
        async onRecord(record) {
          if (record.type !== 'captain_reply') return;
          const durable = await store.read(payload.sessionId);
          send({
            type: 'reply-visible',
            text: record.text,
            turnId: record.turnId,
            durableState: durable.state,
            durableSnapshot: durable.snapshot,
            durableRecord: durable,
          });
          if (failReplyObserver) {
            throw new Error('synthetic post-settlement observer failure');
          }
        },
      },
    ],
    signalTarget: new EventEmitter(),
    queryPaneWidths: () => new Map(),
    createTimingObserver: () => ({
      onRecord() {},
      refresh() {},
      async dispose() {},
    }),
    killSession() {},
    removeWorkDir() {},
  });
  send({ type: 'complete' });
} catch (error) {
  send({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
}

function fixtureRegistryEntry() {
  return {
    id: 'code',
    command: 'code',
    intent: 'exercise one durable player',
    artifactSchema: 3,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
    requiredRoleIds: ['coder'],
    concurrentRoleSets: [],
    validateOptions(value) {
      return value;
    },
    createRuntime(_configuredOptions, _hostCapabilities) {
      let session;
      let turns = 0;
      return {
        ...(retainParked
          ? {
              retainedGenerationMetadata: Object.freeze({
                unfinishedFinalStateIds: Object.freeze([]),
              }),
              async adopt(next, snapshot) {
                session = next;
                turns = snapshot.sequences.turn;
                send({ type: 'runtime-lifecycle', method: 'adopt' });
              },
            }
          : {}),
        async init(next) {
          session = next;
          send({ type: 'runtime-lifecycle', method: 'init' });
        },
        async restore(next, snapshot) {
          session = next;
          turns = snapshot.sequences.turn;
          send({ type: 'runtime-lifecycle', method: 'restore' });
        },
        exportSnapshot() {
          if (!retainParked) return undefined;
          const state = activeState();
          return {
            schemaVersion: 4,
            playbookId: 'code',
            machine: { value: state.value, status: state.status },
            roleResumeTokens: session.playerSessions.snapshot(),
            sequences: {
              trace: 0,
              turn: turns,
              judgeCall: 0,
              playerCall: turns,
              playbookCall: 0,
              captainCall: 0,
            },
            state,
            pendingBossQuestions: [],
            effectLedger: emptyEffectLedger(),
          };
        },
        async handleBossInput({ text, signal }) {
          turns += 1;
          const result = await session.ports.callPlayer(
            'coder',
            `cross-front-player:${text}`,
            signal,
            { resume: session.playerSessions.select('coder') },
          );
          session.playerSessions.update('coder', result.resumeToken);
          if (retainParked) {
            return { outcome: 'quiescent', state: activeState() };
          }
          return {
            outcome: 'terminal',
            state: terminalState(),
            output: { response: result.finalText },
          };
        },
        async resumePlaybookCall() {
          return { outcome: 'no-action', state: activeState() };
        },
        async dispose() {},
      };
    },
  };
}

function createObservedSessionHost(options) {
  const sourceObservers = [...options.observers];
  const activeCalls = new Map();
  let replaySourceInjected = false;
  const forward = async (record) => {
    for (const observer of sourceObservers) await observer.onRecord(record);
    send({ type: 'observed-record', record });
  };
  const traceRecord = (record, type, frame) => ({
    type: 'captain_telemetry',
    turnId: record.turnId,
    timestamp: record.timestamp,
    topic: 'playbook.trace',
    payload: {
      schemaVersion: 4,
      sessionId: 'managed-replay-role-session',
      playbookId: 'managed-replay-role-playbook',
      rootSessionId: 'managed-replay-role-session',
      depth: 0,
      sequence: ++replayTraceSequence,
      timestamp: record.timestamp,
      type,
      turnId: record.turnId,
      callId: frame.callId,
      payload: {
        playerId: record.playerId,
        roleId: frame.roleId,
        resume: false,
        ...(type === 'player.call.started'
          ? { prompt: record.prompt }
          : { status: 'ok' }),
      },
    },
  });
  return createCaptainSessionHost({
    ...options,
    observers: [
      {
        async onRecord(record) {
          if (failReplayAppend && !replaySourceInjected) {
            replaySourceInjected = true;
            await forward({
              type: 'captain_event',
              turnId: record.turnId,
              timestamp: Date.now(),
              visibility: 'visible',
              event: createEvent(
                'text_delta',
                'claude-code',
                { delta: 'replay source before warning' },
                'transport:replay-warning',
              ),
            });
          }
          if (record.type === 'player_prompt') {
            const frame = {
              callId: `managed-player-${++replayCallSequence}`,
              roleId: 'coder',
            };
            activeCalls.set(record.playerId, frame);
            await forward(traceRecord(record, 'player.call.started', frame));
          }
          await forward(record);
          if (record.type === 'player_finished') {
            const frame = activeCalls.get(record.playerId);
            if (frame !== undefined) {
              await forward(traceRecord(record, 'player.call.finished', frame));
              activeCalls.delete(record.playerId);
            }
          }
        },
      },
    ],
  });
}

function replayFailingStore(baseStore) {
  return Object.freeze({
    ...baseStore,
    async acquire(sessionId) {
      const lease = await baseStore.acquire(sessionId);
      let failed = false;
      return Object.freeze({
        ...lease,
        async append(record, role) {
          if (
            !failed &&
            record?.type === 'captain_event' &&
            record.visibility === 'visible' &&
            record.event?.type === 'text_delta'
          ) {
            failed = true;
            return lease.append(new Date('2026-08-31T00:00:00.000Z'));
          }
          return lease.append(record, role);
        },
      });
    },
  });
}

function captainDecision(prompt) {
  if (prompt.includes('[Boss message]\ncontinue')) {
    return JSON.stringify({ action: 'resume', playbookId: 'code' });
  }
  if (prompt.includes('[Boss message]\ndismiss')) {
    return JSON.stringify({ action: 'dismiss' });
  }
  throw new Error(`unexpected arbitration prompt ${JSON.stringify(prompt)}`);
}

function fixtureCaptainRuntime({ controller }) {
  let session;
  let turns = 0;
  return {
    async init(next) {
      session = next;
    },
    async restore(next, snapshot) {
      session = next;
      turns = snapshot.sequences.turn;
    },
    exportSnapshot() {
      return runtimeSnapshot(turns);
    },
    async handleBossInput({ text, signal }) {
      turns += 1;
      const parsed = controller.resolveParsedTurn(text);
      if (parsed?.kind !== 'action') {
        throw new Error('cross-front fixture requires one slash action');
      }
      await controller.submit(parsed.decision, signal);
      await session.ports.emitTelemetry({
        topic: 'playbook.trace',
        payload: {
          type: 'captain.call.started',
          payload: { stateId: 'reporting' },
        },
      });
      await session.ports.callCaptain(
        `cross-front-captain:${text}`,
        signal,
        { visibility: 'hidden', resume: false, allowedTools: [] },
      );
      return { outcome: 'quiescent', state: activeState() };
    },
    async resumePlaybookCall() {
      return { outcome: 'no-action', state: activeState() };
    },
    async dispose() {},
  };
}

function runtimeSnapshot(turn) {
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
    effectLedger: emptyEffectLedger(),
  };
}

function emptyEffectLedger() {
  return {
    schemaVersion: 1,
    revision: 0,
    boundaries: [],
    logicalOperations: [],
  };
}

function activeState() {
  return {
    value: 'playbook.parked',
    activeStateIds: ['playbook.parked'],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId: 'playbook.parked',
  };
}

function terminalState() {
  return {
    value: 'done',
    activeStateIds: ['done'],
    tags: [],
    status: 'done',
    quiescent: true,
    stateId: 'done',
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function send(message) {
  process.send?.(message);
}
