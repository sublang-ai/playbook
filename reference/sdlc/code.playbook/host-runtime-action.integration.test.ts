// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// CAPTAIN-61: an embedding host reads the parked leaf's advertised runtime
// actions and selects one as the session's next turn. Everything but the
// provider is real here — the store, the lease, the durable turn transaction,
// the Captain shell, the compiled session Captain, and the CODE artifact whose
// failure advertises the retry — so "no decision call" is observed at the one
// place a decision call would appear: the adapter.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createEvent,
  type AgentAdapter,
  type AgentEvent,
  type AgentOptions,
} from '@sublang/cligent';
import { describe, expect, it } from 'vitest';
import codePlaybookRegistryEntry from './code.registry.js';
import { createSessionStore } from './session-store.js';
import { openSessionHost } from './session-host.js';
import { loadLaunchPlan } from './bin/launch-config.js';
import { executionConfigFromPlan } from './bin/run.js';

const execFileAsync = promisify(execFile);

/**
 * One provider for every call the session makes. The Captain's own calls are
 * recognized by the verbatim compiled prompts the shell wraps; what is left
 * under the hidden-control marker is CODE's adjudication, and everything else
 * is the coder. A scripted `error` is the failing coder call that parks CODE
 * in its recoverable failure state.
 */
class ScriptedAdapter implements AgentAdapter {
  static playerScript: Array<'ok' | 'error'> = [];
  static playerCalls = 0;
  static decisionCalls = 0;
  readonly agent = 'claude-code';

  async *run(
    prompt: string,
    _options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    const decision = prompt.includes(
      'Select exactly one action from the closed set',
    );
    const closing = prompt.includes(
      'An action just settled for the current Boss turn',
    );
    const commandReply = prompt.includes(
      'Boss issued a registered command that produces no action this turn',
    );
    const adjudication =
      prompt.includes('This is hidden control work.') &&
      !decision &&
      !closing &&
      !commandReply;
    const player = !decision && !closing && !commandReply && !adjudication;
    if (decision) ScriptedAdapter.decisionCalls += 1;
    if (player) {
      const fate =
        ScriptedAdapter.playerScript[ScriptedAdapter.playerCalls] ?? 'ok';
      ScriptedAdapter.playerCalls += 1;
      if (fate === 'error') {
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
    }
    const result = decision
      ? // A decision call here is the defect this test exists to catch; keep
        // it well-formed so the count, not a control-plane failure, reports it.
        JSON.stringify({ action: 'respond', text: 'No decision was expected.' })
      : adjudication
        ? JSON.stringify({ guard: 'needsBossReply' })
        : closing
          ? 'The retry ran; CODE is waiting on your answer.'
          : commandReply
            ? 'Here is where things stand.'
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
) as never;

async function initializeTestRepository(root: string) {
  const cwd = join(root, 'repository');
  await mkdir(cwd);
  await execFileAsync('git', ['init', '--quiet'], { cwd });
  await writeFile(join(cwd, 'tracked.txt'), 'baseline\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Playbook Test',
      '-c',
      'user.email=playbook-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'baseline',
    ],
    { cwd },
  );
  return cwd;
}

function withFixture(prefix: string, run: (dir: string) => Promise<void>) {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

describe('host-selected runtime recovery over a real session host', () => {
  it(
    'advertises the parked leaf’s actions and runs the selected one with no decision call',
    withFixture('playbook-host-action-', async (dir) => {
      ScriptedAdapter.playerScript = ['error'];
      ScriptedAdapter.playerCalls = 0;
      ScriptedAdapter.decisionCalls = 0;
      const cwd = await initializeTestRepository(dir);
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
      const loadModule = async (specifier: string) => {
        if (specifier === 'mod://code') {
          return { default: codePlaybookRegistryEntry };
        }
        throw new Error(`no module ${specifier}`);
      };
      const store = createSessionStore({ sessionsDir: join(dir, 'sessions') });
      const plan = await loadLaunchPlan({ userConfigPath: configPath, loadModule });
      const prompts: string[] = [];
      const controller = await openSessionHost({
        store,
        mode: 'new',
        cwd,
        config: executionConfigFromPlan(plan),
        loadModule,
        adapterImports,
        observers: [
          {
            onRecord(record: { type: string; turn?: { prompt: string } }) {
              if (record.type === 'turn_started' && record.turn) {
                prompts.push(record.turn.prompt);
              }
            },
          },
        ],
      } as never);

      try {
        // An idle shell has no leaf, so it advertises nothing.
        expect(controller.listRuntimeActions()).toEqual([]);

        // One parse-resolved command turn parks CODE in its failure state.
        const parked = await controller.handleBossTurn(
          '/code rename the widget module',
        );
        expect(parked.state).toBe('settled');
        expect(parked.snapshot.frames?.[0]?.runtime.state.stateId).toBe(
          'failed',
        );
        expect(ScriptedAdapter.playerCalls).toBe(1);

        // The host reads the same actions the leaf advertises to the Captain.
        const advertised = controller.listRuntimeActions();
        const retry = advertised.find(
          (action) => action.id === 'retry:START_CODE',
        );
        expect(retry).toBeDefined();
        expect(retry!.label.length).toBeGreaterThan(0);
        expect(retry!.label).not.toBe(retry!.id);
        expect(Object.isFrozen(advertised)).toBe(true);

        // An id the leaf does not advertise starts no turn at all.
        await expect(
          controller.submitRuntimeAction('retry:NOTHING'),
        ).rejects.toThrow(/does not advertise/);
        expect(prompts).toHaveLength(1);
        expect((await controller.read())!.state).toBe('settled');

        // The advertised selection runs as the session's next turn.
        const recovered = await controller.submitRuntimeAction(
          'retry:START_CODE',
        );
        expect(recovered.state).toBe('settled');
        expect(prompts).toEqual([
          '/code rename the widget module',
          retry!.label,
        ]);
        expect(ScriptedAdapter.playerCalls).toBe(2);
        expect(recovered.snapshot.frames?.[0]?.playbookId).toBe('code');
        expect(recovered.snapshot.frames?.[0]?.runtime.state.stateId).toBe(
          'awaitBossReply',
        );
        // The selection was the turn's decision: no decision call was made,
        // for this turn or the parse-resolved one before it.
        expect(ScriptedAdapter.decisionCalls).toBe(0);
      } finally {
        await controller.dispose();
      }
    }),
    60_000,
  );
});
