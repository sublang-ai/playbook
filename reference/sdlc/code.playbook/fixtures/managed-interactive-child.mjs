// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createEvent } from '@sublang/cligent';
import { runManagedTmuxPlaySession } from '@sublang/cligent/tmux-play';
import { createManagedInteractiveLifecycle } from '../bin/interactive-session.js';
import { createCaptainSessionStore } from '../bin/session-store.js';

const payload = JSON.parse(requiredEnv('PLAYBOOK_MANAGED_PAYLOAD'));
const tokenNamespace = requiredEnv('PLAYBOOK_TOKEN_NAMESPACE');
const failReplyObserver = process.env.PLAYBOOK_FAIL_REPLY_OBSERVER === '1';
const store = createCaptainSessionStore({ sessionsDir: payload.sessionsDir });
const input = new PassThrough();
const output = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const releaseReadiness = deferred();
let sessionIdSequence = 0;
let attemptSequence = 0;
let playerCallSequence = 0;
let captainCallSequence = 0;

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
        : `Cross-front durable reply ${tokenNamespace}:${sequence}`;
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result,
        resumeToken: `${kind}-token:${tokenNamespace}:${sequence}`,
        usage: { inputTokens: 1, outputTokens: 1, toolUses: 0 },
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
  sessionStore: store,
  loadModule: async (specifier) => {
    if (specifier !== 'mod://code') {
      throw new Error(`unexpected registry module ${JSON.stringify(specifier)}`);
    }
    return { default: fixtureRegistryEntry() };
  },
  adapterImports,
  createCaptainRuntime: fixtureCaptainRuntime,
  createCaptainSessionId: () =>
    `70000000-0000-4000-8000-${String(++sessionIdSequence).padStart(12, '0')}`,
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
    artifactSchema: 2,
    requiredRoleIds: ['coder'],
    concurrentRoleSets: [],
    validateOptions(value) {
      return value;
    },
    createRuntime() {
      let session;
      return {
        async init(next) {
          session = next;
        },
        async handleBossInput({ text, signal }) {
          const result = await session.ports.callPlayer(
            'coder',
            `cross-front-player:${text}`,
            signal,
            { resume: session.playerSessions.select('coder') },
          );
          session.playerSessions.update('coder', result.resumeToken);
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
    schemaVersion: 3,
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
