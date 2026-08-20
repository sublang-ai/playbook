// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// A headless run whose real CODE artifact parks at a coder
// Boss question must settle durably and release the question as the reply.

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

class ScriptedAdapter implements AgentAdapter {
  static calls: Array<{ prompt: string; resume: string | undefined }> = [];
  readonly agent = 'claude-code';

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    ScriptedAdapter.calls.push({ prompt, resume: options?.resume });
    const result = prompt.includes('This is hidden control work.')
      ? JSON.stringify({
          guard: 'needsBossReply',
          question: 'May I proceed with the risky rename?',
        })
      : prompt.includes('compose closing reply')
        ? 'Coder needs a Boss answer before continuing.'
        : prompt.includes('compose conversational reply')
          ? 'Captain acknowledged the message.'
          : 'May I proceed with the risky rename?';
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result,
        resumeToken: `token:${ScriptedAdapter.calls.length}`,
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      `transport:${ScriptedAdapter.calls.length}`,
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

function runtimeSnapshot(
  playbookId: string,
  turns: number,
): PlaybookRuntimeSnapshot {
  return {
    schemaVersion: 3,
    playbookId,
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

function scriptedCaptainRuntime(inputs: string[]) {
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
        return runtimeSnapshot('captain', turns);
      },
      async handleBossInput({ text, signal }) {
        turns += 1;
        inputs.push(text);
        const parsed = controller.resolveParsedTurn(text);
        if (parsed?.kind === 'action') {
          await controller.submit(parsed.decision, signal);
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
        } else {
          const decision = await session.ports.callCaptain(
            'compose conversational reply',
            signal,
            { visibility: 'hidden', resume: false, allowedTools: [] },
          );
          await controller.submit(
            { action: 'respond', text: decision.finalText },
            signal,
          );
        }
        return { outcome: 'quiescent', state: activeState('playbook.parked') };
      },
      async resumePlaybookCall() {
        return { outcome: 'no-action', state: activeState() };
      },
      async dispose() {},
    };
  };
}

describe('headless Boss-question settlement', () => {
  it('settles durably when the real CODE artifact parks at a coder question', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playbook-bossq-'));
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
    const stdout = writer();
    const stderr = writer();
    const inputs: string[] = [];
    const result = await runPlaybookCli({
      argv: ['run', '/code implement the tricky thing'],
      userConfigPath: configPath,
      env: { ANTHROPIC_API_KEY: 'a' },
      loadModule: async (specifier: string) => {
        if (specifier === 'mod://code') {
          return { default: codePlaybookRegistryEntry };
        }
        throw new Error(`no module ${specifier}`);
      },
      adapterImports,
      createCaptainRuntime: scriptedCaptainRuntime(inputs),
      createLogicalSessionId: () => '90000000-0000-4000-8000-000000000001',
      createCaptainSessionId: (() => {
        let value = 0;
        return () =>
          `10000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
      })(),
      probeAdapterSdk: async () => true,
      sessionsDir,
      stdout,
      stderr,
      spawn: () => {
        throw new Error('headless run must not spawn tmux-play');
      },
    });
    expect(stderr.text()).not.toContain('exportable session snapshot');
    expect(result.code).toBe(0);
    expect(stdout.text()).toContain('Coder needs a Boss answer');
    const record = JSON.parse(
      await readFile(
        join(sessionsDir, '90000000-0000-4000-8000-000000000001.json'),
        'utf8',
      ),
    );
    expect(record.state).toBe('settled');
    const frames = record.snapshot?.frames ?? [];
    expect(frames).toHaveLength(1);
    expect(frames[0]?.runtime?.state?.stateId).toBe('awaitBossReply');
    expect(frames[0]?.runtime?.pendingBossQuestions?.length).toBe(1);
  });
});
