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

import { readFileSync, readdirSync } from 'node:fs';
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
import {
  createXStatePlaybookRuntime,
  RUNTIME_ABI,
} from './xstate-playbook-runtime.js';
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
  compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {},
  classificationStatus: () => undefined,
  statusesForState: (state) =>
    state.stateId === undefined || state.stateId === 'ready'
      ? []
      : state.stateId === 'failed'
        ? [{ message: '◆ failed' }]
        : [{ message: `⤷ ${state.stateId}` }],
});

const createNotesRuntime = createXStatePlaybookRuntime(notesMachine, {
  label: 'NOTES',
  compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'topic' },
  roleStates: {},
  classificationStatus: () => undefined,
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
    artifactSchema: 2,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 2 },
    requiredRoleIds: [],
    concurrentRoleSets: [],
    validateOptions: (options) => options,
    createRuntime,
  };
}

interface ShellTransition {
  from: string;
  to: string;
  event: string;
  ledger: {
    mode: string;
    stackDepth: number;
    latestSubRuntimeState?: { status: string };
  };
}

interface Harness {
  shell: ReturnType<typeof createPlaybookCaptainShell>;
  session: CaptainSession;
  context: CaptainContext;
  statuses: string[];
  captainReplies: CaptainRunResult[];
  shellTransitions: ShellTransition[];
}

function captainJson(value: unknown): CaptainRunResult {
  return { status: 'ok', turnId: 1, finalText: JSON.stringify(value) };
}

function createHarness(
  entries: readonly PlaybookCaptainRegistryEntry[],
): Harness {
  const modules: Record<string, unknown> = {};
  const playbooks: Record<string, { from: string; roles: object; options: object }> = {};
  for (const entry of entries) {
    const from = `test://${entry.id}`;
    modules[from] = { default: entry };
    playbooks[entry.id] = { from, roles: {}, options: {} };
  }
  let id = 0;
  let captainIdIssued = false;
  const shell = createPlaybookCaptainShell(
    {
      playbooks,
      sessionAgents: {
        captain: {
          adapter: 'claude',
          model: { kind: 'provider-default' },
          effort: { kind: 'provider-default' },
        },
        players: {},
      },
      captainAdapter: 'claude',
    },
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
  const shellTransitions: ShellTransition[] = [];
  let captainCalls = 0;
  const controller = new AbortController();
  const session: CaptainSession = {
    signal: controller.signal,
    players: [],
    emitStatus: async (message) => {
      statuses.push(message);
    },
    emitTelemetry: async (event) => {
      if (event.topic === 'playbook.captain.fsm.state') {
        shellTransitions.push(event.payload as unknown as ShellTransition);
      }
    },
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
  return {
    shell,
    session,
    context,
    statuses,
    captainReplies,
    shellTransitions,
  };
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

// The second half of the same class, and the load-bearing half: whatever a
// runtime emits on the way down, the shell must not read it as evidence
// about a live leaf. `disposeStack` selects `chat` *before* it unwinds, and
// `removeTopFrame` disposes the frame *before* it pops — so a snapshot
// arriving from inside `dispose()` still finds itself the leaf and, mirrored,
// re-marks an emptied stack `engaged.parked`. These runtimes are
// hand-written rather than factory-built on purpose: the guard has to hold
// for a third-party runtime with no disposal hygiene at all.
const parkedLeafState = (status: 'active' | 'stopped') => ({
  value: 'outline',
  activeStateIds: ['outline'],
  tags: ['playbook.parked'],
  status,
  quiescent: true,
  stateId: 'outline',
});

function createDisposalEmittingRuntime(
  disposalStatus: 'active' | 'stopped',
): PlaybookRuntime {
  let emitTelemetry:
    | ((event: { topic: string; payload: unknown }) => Promise<void>)
    | undefined;
  const live = parkedLeafState('active');
  return {
    async init(session) {
      emitTelemetry = session.ports.emitTelemetry;
      await emitTelemetry({
        topic: 'playbook.fsm.state',
        payload: { to: 'outline', state: live },
      });
    },
    async handleBossInput() {
      return { outcome: 'quiescent' as const, state: live };
    },
    async resumePlaybookCall() {
      throw new Error('unused');
    },
    async dispose() {
      // The phantom: one more snapshot for the unchanged state, emitted
      // while the shell still holds this frame as its leaf.
      await emitTelemetry?.({
        topic: 'playbook.fsm.state',
        payload: {
          from: 'outline',
          to: 'outline',
          state: parkedLeafState(disposalStatus),
        },
      });
    },
  };
}

describe('leaf telemetry mirrored during disposal (shell guard)', () => {
  it.each([
    ['a stopped snapshot', 'stopped' as const],
    ['a still-active snapshot', 'active' as const],
  ])('leaves the stack empty and the shell in chat after %s', async (
    _label,
    disposalStatus,
  ) => {
    const harness = createHarness([
      registryEntry('notes', 'notes', () =>
        createDisposalEmittingRuntime(disposalStatus),
      ),
    ]);
    await harness.shell.init!(harness.session);

    await harness.shell.handleBossTurn(
      turn('/notes draft the release notes'),
      harness.context,
    );
    expect(harness.shellTransitions.at(-1)?.ledger.mode).toBe('engaged.parked');

    const beforeDismissal = harness.shellTransitions.length;
    harness.captainReplies.push(captainJson({ action: 'dismiss' }));
    await harness.shell.handleBossTurn(
      turn('That is enough for now — stop what is running and stand by.', 2),
      harness.context,
    );

    // Dismissal selected `chat`; nothing the dropped runtime emitted may
    // move it back. A mode move the leaf mirror caused is tagged
    // `sub-runtime:<stateId>` — the dismissal turn must contain none.
    const dismissal = harness.shellTransitions.slice(beforeDismissal);
    expect(
      dismissal.filter((transition) => transition.event.startsWith('sub-runtime:')),
    ).toEqual([]);
    const settled = harness.shellTransitions.at(-1)!;
    expect(settled.to).toBe('chat');
    expect(settled.ledger.mode).toBe('chat');
    expect(harness.statuses).toEqual(['◇ /notes started', '◇ /notes stopped']);

    await harness.shell.dispose!();
  });

  // The status half of the same guard, reachable without any disposal: a
  // runtime that stops and rebuilds its actor mid-turn (DECIDE does exactly
  // this when a finished actor must accept a new event) emits the teardown
  // snapshot while the frame is live. A stopped actor is not a parked
  // engagement, so it may neither become the mirrored leaf state nor move the
  // shell's authoritative mode.
  it('never mirrors a stopped snapshot emitted outside disposal', async () => {
    let emitTelemetry:
      | ((event: { topic: string; payload: unknown }) => Promise<void>)
      | undefined;
    const live = parkedLeafState('active');
    const midTurnStopRuntime: PlaybookRuntime = {
      async init(session) {
        emitTelemetry = session.ports.emitTelemetry;
        await emitTelemetry({
          topic: 'playbook.fsm.state',
          payload: { to: 'outline', state: live },
        });
      },
      async handleBossInput() {
        await emitTelemetry?.({
          topic: 'playbook.fsm.state',
          payload: {
            from: 'outline',
            to: 'outline',
            state: parkedLeafState('stopped'),
          },
        });
        return { outcome: 'quiescent' as const, state: live };
      },
      async resumePlaybookCall() {
        throw new Error('unused');
      },
      async dispose() {},
    };

    const harness = createHarness([
      registryEntry('notes', 'notes', () => midTurnStopRuntime),
    ]);
    await harness.shell.init!(harness.session);
    await harness.shell.handleBossTurn(
      turn('/notes draft the release notes'),
      harness.context,
    );

    harness.captainReplies.push(
      captainJson({ action: 'deliver', text: 'keep going' }),
    );
    await harness.shell.handleBossTurn(turn('keep going', 2), harness.context);

    expect(
      harness.shellTransitions.filter(
        (transition) =>
          transition.ledger.latestSubRuntimeState !== undefined &&
          transition.ledger.latestSubRuntimeState.status !== 'active',
      ),
    ).toEqual([]);
    expect(
      harness.shellTransitions.filter((transition) =>
        transition.event.startsWith('sub-runtime:'),
      ),
    ).toEqual([]);

    await harness.shell.dispose!();
  });
});

// Fat-artifact parity (PBRT-6). "Suppress inspection before stopping the
// actor" was an unenforced convention duplicated per runtime, which is why
// the shared factory's fix could not reach DECIDE's own runtime. Every
// runtime that builds an XState actor is discovered here rather than listed,
// so a future fat artifact — or a new stop site in an existing one — is
// covered without anyone remembering to extend this file.
function runtimeSourcesBuildingActors(): Array<[string, string]> {
  const root = new URL('../', import.meta.url);
  const candidates = ['src/xstate-playbook-runtime.ts'];
  const artifacts = readdirSync(new URL('reference/sdlc/', root), {
    withFileTypes: true,
  });
  for (const artifact of artifacts) {
    if (!artifact.isDirectory() || !artifact.name.endsWith('.playbook')) {
      continue;
    }
    const dir = `reference/sdlc/${artifact.name}/`;
    for (const file of readdirSync(new URL(dir, root))) {
      if (file.endsWith('.playbook.ts')) candidates.push(`${dir}${file}`);
    }
  }
  return candidates
    .map(
      (path) =>
        [path, readFileSync(new URL(path, root), 'utf8')] as [string, string],
    )
    .filter(([, source]) => source.includes('createActor('));
}

describe('actor stop hygiene across every runtime that builds one', () => {
  const sources = runtimeSourcesBuildingActors();

  it('discovers the engine and every fat artifact that builds its own actor', () => {
    expect(sources.map(([path]) => path)).toEqual([
      'src/xstate-playbook-runtime.ts',
      'reference/sdlc/decide.playbook/decide.playbook.ts',
    ]);
  });

  it.each(sources)(
    '%s stops its actor only inside a suppressing seam',
    (_path, source) => {
      const stops = source
        .split('\n')
        .map((line) => line.trim())
        .filter(
          (line) =>
            /(^|[^.\w])actor\??\.stop\(\)/.test(line) &&
            !line.startsWith('//') &&
            !line.startsWith('*'),
        );
      expect(stops).toEqual(['actor.stop();']);

      const seam =
        /stopActor\s*(?:\(\)\s*:\s*void|=\s*\(\)\s*:\s*void\s*=>)\s*\{([\s\S]*?)\n\s{2,4}\}/.exec(
          source,
        );
      expect(seam).not.toBeNull();
      const body = seam![1];
      expect(body).toContain('suppressInspectionEmissions = true;');
      expect(body.indexOf('suppressInspectionEmissions = true;')).toBeLessThan(
        body.indexOf('actor.stop()'),
      );
    },
  );
});
