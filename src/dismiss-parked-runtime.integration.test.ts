// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Hermetic pin for the class the live conversational gate caught: the shell
// dismisses (or switches away from) a *real* linked runtime that is parked at
// its failure state, and the runtime's `dispose()` stops the XState actor
// without suppressing inspection emissions — so the actor's `xstate.stop`
// snapshot re-runs `statusesForState` for the unchanged state and re-emits the
// state's Captain-pane line a second time, immediately before the shell's own
// `◇ /<command> stopped`.
//
// The pre-existing shell dismissal tests all drive a hand-written
// `FakeRuntime` whose `dispose()` emits nothing, so the seam between
// `createXStatePlaybookRuntime` and the shell was never exercised. These
// cases use the real factory.

import { assign, createMachine } from 'xstate';
import { describe, expect, it } from 'vitest';

import type {
  BossTurn,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  PlayerRunResult,
} from '@sublang/cligent/tmux-play';
import type { PlaybookRuntime } from './runtime.js';
import { createXStatePlaybookRuntime } from './xstate-playbook-runtime.js';
import {
  createPlaybookCaptainShell,
  type PlaybookCaptainRegistryEntry,
} from '../reference/sdlc/code.playbook/playbook-captain.ts';

const meta = (stateId: string) => ({
  playbook: { stateId, description: `${stateId} state` },
});

// The acceptance fixture's checklist, reduced to its deterministic skeleton:
// one Boss entry event parks the machine straight at the recoverable `failed`
// sink, which emits `◆ failed` exactly once on entry.
const checklistMachine = createMachine({
  id: 'checklist',
  initial: 'ready',
  context: {
    task: undefined as string | undefined,
    lastError: undefined as unknown,
  },
  states: {
    ready: {
      meta: meta('ready'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'failed',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
            lastError: () => new Error('the verify step failed'),
          }),
        },
      },
    },
    failed: {
      meta: meta('failed'),
      tags: ['playbook.parked'],
      on: { START: { target: 'failed', reenter: true } },
    },
  },
});

// The release-notes switch target: entry parks it at a non-failure state, so
// the same case also proves the re-emission is not failure-specific.
const notesMachine = createMachine({
  id: 'notes',
  initial: 'ready',
  context: { topic: undefined as string | undefined },
  states: {
    ready: {
      meta: meta('ready'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'outline',
          actions: assign({
            topic: ({ event }) => (event as { topic: string }).topic,
          }),
        },
      },
    },
    outline: {
      meta: meta('outline'),
      tags: ['playbook.parked'],
      on: { START: { target: 'outline', reenter: true } },
    },
  },
});

const createChecklistRuntime = createXStatePlaybookRuntime(checklistMachine, {
  label: 'CHECKLIST',
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  statusesForState: (state) =>
    state.stateId === undefined || state.stateId === 'ready'
      ? []
      : state.stateId === 'failed'
        ? [{ message: '◆ failed' }]
        : [{ message: `⤷ ${state.stateId}` }],
});

const createNotesRuntime = createXStatePlaybookRuntime(notesMachine, {
  label: 'NOTES',
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'topic' },
  statusesForState: (state) =>
    state.stateId === undefined || state.stateId === 'ready'
      ? []
      : [{ message: `⤷ ${state.stateId}` }],
});

function registryEntry(
  id: string,
  command: string,
  createRuntime: () => PlaybookRuntime,
): PlaybookCaptainRegistryEntry {
  return {
    id,
    command,
    intent: `${id} dismissal-status fixture`,
    requiredRoleIds: [],
    validateOptions: (options) => options,
    createRuntime,
  };
}

interface Harness {
  shell: ReturnType<typeof createPlaybookCaptainShell>;
  session: CaptainSession;
  context: CaptainContext;
  statuses: string[];
  captainReplies: CaptainRunResult[];
}

function captainJson(value: unknown): CaptainRunResult {
  return { status: 'ok', turnId: 1, finalText: JSON.stringify(value) };
}

function createHarness(
  entries: readonly PlaybookCaptainRegistryEntry[],
): Harness {
  const modules: Record<string, unknown> = {};
  const playbooks: Record<string, { from: string; options: object }> = {};
  for (const entry of entries) {
    const from = `test://${entry.id}`;
    modules[from] = { default: entry };
    playbooks[entry.id] = { from, options: {} };
  }
  let id = 0;
  let captainIdIssued = false;
  const shell = createPlaybookCaptainShell(
    { playbooks },
    {
      loadModule: async (specifier) => modules[specifier],
      createSessionId: () => {
        if (!captainIdIssued) {
          captainIdIssued = true;
          return '40000000-0000-4000-8000-0000000000ff';
        }
        return `40000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
      },
    },
  );
  const statuses: string[] = [];
  const captainReplies: CaptainRunResult[] = [];
  let captainCalls = 0;
  const controller = new AbortController();
  const session: CaptainSession = {
    signal: controller.signal,
    players: [],
    emitStatus: async (message) => {
      statuses.push(message);
    },
    emitTelemetry: async () => {},
    setVisiblePlayers: async () => {},
  };
  const context: CaptainContext = {
    signal: controller.signal,
    players: [],
    callPlayer: async (playerId): Promise<PlayerRunResult> => ({
      status: 'ok',
      playerId,
      turnId: 1,
      finalText: 'unused',
    }),
    callCaptain: async (): Promise<CaptainRunResult> => {
      const scripted = captainReplies.shift();
      const resumeToken = `conversation-${++captainCalls}`;
      if (scripted !== undefined) return { ...scripted, resumeToken };
      return {
        status: 'ok',
        turnId: 1,
        finalText: 'Acknowledged.',
        resumeToken,
      };
    },
    emitReply: async () => {},
    setVisiblePlayers: async () => {},
  };
  return { shell, session, context, statuses, captainReplies };
}

function turn(prompt: string, id = 1): BossTurn {
  return { id, prompt, timestamp: id };
}

describe('dismissing a parked linked runtime (live-gate regression)', () => {
  it('emits the failure line once when a switch drops a runtime parked at failed', async () => {
    const harness = createHarness([
      registryEntry('checklist', 'checklist', () => createChecklistRuntime({})),
      registryEntry('notes', 'notes', () => createNotesRuntime({})),
    ]);
    await harness.shell.init!(harness.session);

    // Turn 1: deterministic command parse — no model call. The checklist
    // machine parks at `failed` and emits `◆ failed` on entry.
    await harness.shell.handleBossTurn(
      turn('/checklist run the release checklist'),
      harness.context,
    );
    expect(harness.statuses).toEqual(['◇ /checklist started', '◆ failed']);

    // Turn 2: the Boss switches to the release notes. Nothing failed at this
    // moment — an enabled command absent from the active path switches with
    // no model call at all (CAPTAIN-38), so the only thing under test is what
    // the dismissed runtime's disposal emits.
    await harness.shell.handleBossTurn(
      turn('/notes discuss the release notes with me instead', 2),
      harness.context,
    );

    expect(harness.statuses).toEqual([
      '◇ /checklist started',
      '◆ failed',
      '◇ /checklist stopped',
      '◇ /notes started',
      '⤷ outline',
    ]);
    expect(harness.statuses.filter((line) => line === '◆ failed')).toHaveLength(
      1,
    );

    await harness.shell.dispose!();
  });

  it('emits no extra state line when a dismiss drops a runtime parked at a non-failure state', async () => {
    const harness = createHarness([
      registryEntry('notes', 'notes', () => createNotesRuntime({})),
    ]);
    await harness.shell.init!(harness.session);

    await harness.shell.handleBossTurn(
      turn('/notes draft the release notes'),
      harness.context,
    );
    expect(harness.statuses).toEqual(['◇ /notes started', '⤷ outline']);

    harness.captainReplies.push(captainJson({ action: 'dismiss' }));
    await harness.shell.handleBossTurn(
      turn('That is enough for now — stop what is running and stand by.', 2),
      harness.context,
    );

    expect(harness.statuses).toEqual([
      '◇ /notes started',
      '⤷ outline',
      '◇ /notes stopped',
    ]);

    await harness.shell.dispose!();
  });
});
