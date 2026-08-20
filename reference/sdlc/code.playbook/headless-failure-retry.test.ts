// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// DR-034: a headless run whose real CODE artifact parks in the recoverable
// failure state must offer that recovery to the next process, so
// `playbook run --continue` can retry it in place instead of dismissing it.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEvent,
  type AgentAdapter,
  type AgentEvent,
  type AgentOptions,
} from '@sublang/cligent';
import { afterEach, describe, expect, it } from 'vitest';
import codePlaybookRegistryEntry from './code.registry.js';
import type {
  PlaybookRuntime,
  PlaybookRuntimeSnapshot,
  PlaybookSession,
  PlaybookState,
} from '../../../src/runtime.js';

const { runPlaybookCli } = await import(
  new URL('./bin/playbook.js', import.meta.url).href
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function writer() {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}

/**
 * The coder fails in the first process and works in the second — the shape
 * of every real recovery, where the Boss fixed something between the two.
 */
class ScriptedAdapter implements AgentAdapter {
  static coderFails = true;
  static playerCalls = 0;
  readonly agent = 'claude-code';

  async *run(
    prompt: string,
    _options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    // Every Captain call is hidden control work, so the composer markers —
    // which this test's own scripted Captain sends — decide first; what is
    // left under the marker is CODE's adjudication judge call.
    const closing =
      prompt.includes('compose closing reply') ||
      prompt.includes('An action just settled for the current Boss turn');
    const conversational = prompt.includes('compose conversational reply');
    const adjudication =
      prompt.includes('This is hidden control work.') &&
      !closing &&
      !conversational;
    const player = !closing && !conversational && !adjudication;
    if (player) ScriptedAdapter.playerCalls += 1;
    if (player && ScriptedAdapter.coderFails) {
      yield createEvent(
        'done',
        this.agent,
        {
          status: 'error',
          error: 'coder exploded',
          usage: { toolUses: 0 },
          durationMs: 1,
        },
        'transport:error',
      );
      return;
    }
    const result = adjudication
      ? JSON.stringify({
          guard: 'needsBossReply',
          question: 'May I proceed with the risky rename?',
        })
      : closing
        ? 'The retry ran; CODE is waiting on your answer.'
        : conversational
          ? 'Captain acknowledged the message.'
          : 'Rename drafted; one question for Boss.';
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result,
        resumeToken: `token:${ScriptedAdapter.playerCalls}`,
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      `transport:${ScriptedAdapter.playerCalls}`,
    );
  }

  async isAvailable() {
    return true;
  }
}

const adapterImports = Object.fromEntries(
  ['claude', 'codex', 'gemini', 'kimi', 'opencode'].map((adapter) => [
    adapter,
    async () => ScriptedAdapter,
  ]),
) as any;

function activeState(stateId = 'ready'): PlaybookState {
  return {
    value: stateId,
    activeStateIds: [stateId],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId,
  };
}

function runtimeSnapshot(turns: number): PlaybookRuntimeSnapshot {
  return {
    schemaVersion: 3,
    playbookId: 'captain',
    machine: { value: 'hub', status: 'active' },
    roleResumeTokens: {},
    sequences: {
      trace: 0,
      turn: turns,
      judgeCall: 0,
      playerCall: 0,
      playbookCall: 0,
      captainCall: 0,
    },
    state: activeState('hub'),
    pendingBossQuestions: [],
  } as PlaybookRuntimeSnapshot;
}

/**
 * A Captain that starts CODE on a slash turn and, on any later turn, selects
 * the retry the leaf advertises. Selecting it by its exact id is the point:
 * the shell refuses an action the restored leaf does not advertise, so this
 * turn settles only because the recovery survived the process boundary.
 */
function scriptedCaptainRuntime(receipts: unknown[]) {
  return ({ controller }: any): PlaybookRuntime => {
    let session: PlaybookSession;
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
        const decision =
          parsed?.kind === 'action'
            ? parsed.decision
            : { action: 'runtime', actionId: 'retry:START_CODE' };
        receipts.push(await controller.submit(decision, signal));
        // The shell reads this trace to serve the next Captain call as the
        // turn's closing reply rather than another decision.
        await session.ports.emitTelemetry({
          topic: 'playbook.trace',
          payload: {
            type: 'captain.call.started',
            payload: { stateId: 'reporting' },
          },
        });
        await session.ports.callCaptain('compose closing reply', signal, {
          visibility: 'hidden',
          resume: false,
          allowedTools: [],
        });
        return { outcome: 'quiescent', state: activeState('playbook.parked') };
      },
      async resumePlaybookCall() {
        return { outcome: 'no-action', state: activeState() };
      },
      async dispose() {},
    };
  };
}

describe('headless failure retry across a continued session (DR-034)', () => {
  it('advertises and applies the retry the first process could not keep', async () => {
    ScriptedAdapter.coderFails = true;
    ScriptedAdapter.playerCalls = 0;
    const dir = await mkdtemp(join(tmpdir(), 'playbook-retry-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'playbook.config.yaml');
    await writeFile(
      configPath,
      [
        'captain: { adapter: claude, model: captain-model }',
        'players:',
        '  dev.coder: { adapter: claude, model: coder-model }',
        'playbooks:',
        '  code:',
        '    from: mod://code',
        '    roles: { coder: dev.coder }',
        '',
      ].join('\n'),
      'utf8',
    );
    const sessionsDir = join(dir, 'sessions');
    const sessionId = '90000000-0000-4000-8000-000000000001';
    const receipts: unknown[] = [];
    const options = () => ({
      userConfigPath: configPath,
      env: { ANTHROPIC_API_KEY: 'a' },
      loadModule: async (specifier: string) => {
        if (specifier === 'mod://code') {
          return { default: codePlaybookRegistryEntry };
        }
        throw new Error(`no module ${specifier}`);
      },
      adapterImports,
      createCaptainRuntime: scriptedCaptainRuntime(receipts),
      createLogicalSessionId: () => sessionId,
      createCaptainSessionId: (() => {
        let value = 0;
        return () =>
          `10000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
      })(),
      probeAdapterSdk: async () => true,
      sessionsDir,
      spawn: () => {
        throw new Error('headless run must not spawn tmux-play');
      },
    });

    // Process one: the coder errors and CODE parks in its failure state.
    const firstOut = writer();
    const first = await runPlaybookCli({
      argv: ['run', '/code rename the widget module'],
      ...options(),
      stdout: firstOut,
      stderr: writer(),
    });
    expect(first.code).toBe(0);
    const parked = JSON.parse(
      await readFile(join(sessionsDir, `${sessionId}.json`), 'utf8'),
    );
    expect(parked.state).toBe('settled');
    expect(parked.snapshot.frames[0].runtime.state.stateId).toBe('failed');
    expect(ScriptedAdapter.playerCalls).toBe(1);

    // Process two: nothing carries over but the record. The restored leaf
    // still advertises `retry:START_CODE`, so the selection is accepted and
    // executed rather than refused as unadvertised.
    ScriptedAdapter.coderFails = false;
    const secondOut = writer();
    const secondErr = writer();
    const second = await runPlaybookCli({
      argv: ['run', '--continue', 'Retry and continue the iteration'],
      ...options(),
      stdout: secondOut,
      stderr: secondErr,
    });
    expect(secondErr.text()).not.toContain('does not advertise');
    expect(second.code).toBe(0);
    // The shell's own settlement: the action was accepted, executed, and
    // named by its Boss-facing label rather than refused as unadvertised.
    expect(receipts.at(-1)).toMatchObject({
      status: 'ok',
      receipt: { disposition: 'executed' },
      facts: ['Applied "retry:START_CODE" on /code.'],
    });
    expect(ScriptedAdapter.playerCalls).toBe(2);
    expect(secondOut.text()).toContain('The retry ran');

    // The retry moved the real machine off its failure state, in place: the
    // engagement is still CODE, on the same logical session.
    const recovered = JSON.parse(
      await readFile(join(sessionsDir, `${sessionId}.json`), 'utf8'),
    );
    expect(recovered.state).toBe('settled');
    expect(recovered.snapshot.frames[0].playbookId).toBe('code');
    expect(recovered.snapshot.frames[0].runtime.state.stateId).toBe(
      'awaitBossReply',
    );
  });
});
