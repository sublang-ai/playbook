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

class FixtureAdapter {
  agent = 'claude-code';

  async *run(prompt) {
    yield createEvent('done', this.agent, {
      status: 'success',
      result: `fixture:${prompt}`,
      resumeToken: 'fixture-token',
      usage: { inputTokens: 1, outputTokens: 1, toolUses: 0 },
      durationMs: 1,
    });
  }

  async isAvailable() {
    return true;
  }
}

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
        schemaVersion: 2,
        playbookId: 'captain',
        machine: { value: state.value, status: state.status },
        playerResumeTokens: {},
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
    },
    async handleBossInput({ text, signal }) {
      turn += 1;
      process.send?.({ type: 'effect', input: text, mode });
      if (mode === 'crash') {
        await new Promise(() => {
          // A bare unresolved promise does not keep Node alive. The interval
          // models a genuinely wedged adapter until the parent sends SIGKILL.
          setInterval(() => {}, 1_000);
        });
      }
      await session.ports.callCaptain('fixture recovery reply', signal, {
        visibility: 'hidden',
        resume: false,
        allowedTools: [],
      });
      await controller.submit(
        { action: 'respond', text: 'Recovered exact uncertain turn.' },
        signal,
      );
      return { outcome: 'quiescent', state: activeState() };
    },
    async resumePlaybookCall() {
      return { outcome: 'no-action', state: activeState() };
    },
    async dispose() {},
  };
}

const argv =
  mode === 'crash'
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
    let value = 0;
    return () =>
      `10000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
  })(),
  createAttemptId: () => (mode === 'crash' ? attemptId : nextAttemptId),
  probeAdapterSdk: async () => true,
  sessionsDir,
  readStdin: async () => {
    process.send?.({ type: 'stdin-read' });
    throw new Error('recovery must not read stdin');
  },
});

process.send?.({ type: 'result', result });
