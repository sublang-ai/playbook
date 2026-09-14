// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// CAPTAIN-64: an embedding host reads the shell's own give-up control and
// selects it as the session's next turn. Everything but the provider is real
// here — the store, the lease, the durable turn transaction, the Captain
// shell, the compiled session Captain, and the CODE artifact whose failure
// parks the run — so "no model call" is observed at the one place any call
// would appear: the adapter. The give-up exists because the failure a Boss
// gives up on is sometimes the provider itself, so this adapter refuses every
// call the give-up turn could make, and the turn must still settle.

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
 * One provider for every call the session makes, recognized the way the
 * sibling runtime-action fixture recognizes them: by the verbatim compiled
 * prompts the shell wraps.
 *
 * `refuseCaptain` turns every session-Captain call — decision and closing
 * reply alike — into a hard provider refusal. It models the safeguard refusal
 * that parked a workflow in production: once it is on, nothing that needs the
 * Captain can settle, which is the whole reason the give-up may not need it.
 */
class ScriptedAdapter implements AgentAdapter {
  static playerScript: Array<'ok' | 'error'> = [];
  static playerCalls = 0;
  static decisionCalls = 0;
  static closingCalls = 0;
  static refuseCaptain = false;
  static changeBeforeFailure: string | undefined;
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
    if (closing) ScriptedAdapter.closingCalls += 1;
    if (ScriptedAdapter.refuseCaptain && (decision || closing || commandReply)) {
      yield createEvent(
        'done',
        this.agent,
        {
          status: 'error',
          error: 'provider refused this request',
          usage: { toolUses: 0 },
          durationMs: 1,
        },
        'transport:refused',
      );
      return;
    }
    if (player) {
      const fate =
        ScriptedAdapter.playerScript[ScriptedAdapter.playerCalls] ?? 'ok';
      ScriptedAdapter.playerCalls += 1;
      if (fate === 'error') {
        if (ScriptedAdapter.changeBeforeFailure) {
          await writeFile(ScriptedAdapter.changeBeforeFailure, 'unresolved edit\n');
        }
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
      ? JSON.stringify({ action: 'respond', text: 'No decision was expected.' })
      : adjudication
        ? JSON.stringify({ guard: 'needsBossReply' })
        : closing
          ? 'A closing reply nobody should have needed.'
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

async function openParkedSession(dir: string, unresolved = false) {
  ScriptedAdapter.playerScript = ['error'];
  ScriptedAdapter.playerCalls = 0;
  ScriptedAdapter.decisionCalls = 0;
  ScriptedAdapter.closingCalls = 0;
  ScriptedAdapter.refuseCaptain = false;
  const cwd = await initializeTestRepository(dir);
  ScriptedAdapter.changeBeforeFailure = unresolved ? join(cwd, 'tracked.txt') : undefined;
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
  const replies: string[] = [];
  const controller = await openSessionHost({
    store,
    mode: 'new',
    cwd,
    config: executionConfigFromPlan(plan),
    loadModule,
    adapterImports,
    observers: [
      {
        onRecord(record: {
          type: string;
          turn?: { prompt: string };
          text?: string;
        }) {
          if (record.type === 'turn_started' && record.turn) {
            prompts.push(record.turn.prompt);
          }
          if (record.type === 'captain_reply' && typeof record.text === 'string') {
            replies.push(record.text);
          }
        },
      },
    ],
  } as never);
  return { controller, prompts, replies };
}

describe('host-selected give-up over a real session host', () => {
  it(
    'durably abandons unresolved work before clearing its root',
    withFixture('playbook-host-giveup-effects-', async (dir) => {
      const { controller, replies } = await openParkedSession(dir, true);
      try {
        const parked = await controller.handleBossTurn('/code edit the widget');
        expect(parked.unresolvedEffects).toHaveLength(1);
        ScriptedAdapter.refuseCaptain = true;
        const callsBefore = ScriptedAdapter.closingCalls;
        const stopped = await controller.submitShellAction('give-up');
        expect(stopped.state).toBe('settled');
        expect(stopped.snapshot.mode).toBe('chat');
        expect(stopped.retainedGenerations?.code).toBeUndefined();
        expect(stopped.unresolvedEffects).toEqual(parked.unresolvedEffects);
        expect(stopped.settledAbandonment).toBeDefined();
        expect(await controller.read()).toEqual(stopped);
        expect(replies.at(-1)).toContain('Observed repository change');
        expect(ScriptedAdapter.closingCalls).toBe(callsBefore);
        expect(ScriptedAdapter.decisionCalls).toBe(0);
      } finally {
        await controller.dispose();
      }
    }),
    60_000,
  );

  it(
    'ends the parked run with no model call of any kind and offers no resumption',
    withFixture('playbook-host-giveup-', async (dir) => {
      const { controller, prompts, replies } = await openParkedSession(dir);

      try {
        // An idle shell has no root, so it offers no control of its own.
        expect(controller.listShellActions()).toEqual([]);

        const parked = await controller.handleBossTurn(
          '/code rename the widget module',
        );
        expect(parked.state).toBe('settled');
        expect(parked.snapshot.frames?.[0]?.runtime.state.stateId).toBe(
          'failed',
        );
        // The parked root is retained, which is what the give-up must undo.
        expect(parked.retainedGenerations?.code).toBeDefined();

        // Exactly one control, naming the run the Boss started rather than the
        // frame parked inside it, and never its own id.
        const offered = controller.listShellActions();
        expect(offered).toHaveLength(1);
        expect(offered[0]!.label).toBe('Stop /code');
        expect(offered[0]!.label).not.toBe(offered[0]!.id);
        expect(Object.isFrozen(offered)).toBe(true);

        // A control the shell does not advertise starts no turn at all.
        await expect(controller.submitShellAction('stop-everything')).rejects.toThrow(
          /does not advertise/,
        );
        expect(prompts).toHaveLength(1);
        expect((await controller.read())!.state).toBe('settled');

        // From here the provider refuses every session-Captain call. The
        // give-up must settle anyway; that is the control's whole purpose.
        ScriptedAdapter.refuseCaptain = true;
        const decisionsBefore = ScriptedAdapter.decisionCalls;
        const closingsBefore = ScriptedAdapter.closingCalls;

        const stopped = await controller.submitShellAction(offered[0]!.id);
        expect(stopped.state).toBe('settled');

        // Neither call was made for this turn — not merely "not answered".
        // The parking turn legitimately spent one closing reply, so the
        // give-up is proven by the absence of a second, and by the decision
        // count that was never nonzero.
        expect(closingsBefore).toBe(1);
        expect(ScriptedAdapter.closingCalls).toBe(closingsBefore);
        expect(ScriptedAdapter.decisionCalls).toBe(decisionsBefore);
        expect(ScriptedAdapter.decisionCalls).toBe(0);

        // The conversation still records what was asked, in the control's own
        // words, and answers in the shell's.
        expect(prompts).toEqual(['/code rename the widget module', 'Stop /code']);
        expect(replies.at(-1)).toContain('Stopped that workflow');

        // The run is gone and is not offered back.
        expect(stopped.snapshot.frames ?? []).toHaveLength(0);
        expect(stopped.retainedGenerations?.code).toBeUndefined();
      } finally {
        await controller.dispose();
      }
    }),
    60_000,
  );

  it(
    'drops the selection when another turn carries other text',
    withFixture('playbook-host-giveup-drop-', async (dir) => {
      const { controller, prompts } = await openParkedSession(dir);

      try {
        await controller.handleBossTurn('/code rename the widget module');
        const offered = controller.listShellActions();
        expect(offered).toHaveLength(1);

        // Arm the selection on the shell without submitting its turn.
        const armed = controller.shell.submitShellAction!(offered[0]!.id);
        expect(armed).toBe('Stop /code');

        // A turn carrying other text is decided the ordinary way, and the
        // armed give-up is dropped rather than applied to it.
        const other = await controller.handleBossTurn('where do things stand?');
        expect(other.state).toBe('settled');
        expect(ScriptedAdapter.decisionCalls).toBe(1);
        expect(other.snapshot.frames?.[0]?.playbookId).toBe('code');
        expect(other.retainedGenerations?.code).toBeDefined();
        expect(prompts).toEqual([
          '/code rename the widget module',
          'where do things stand?',
        ]);
      } finally {
        await controller.dispose();
      }
    }),
    60_000,
  );
});
