// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-103 §4 across the runtime/shell seam: what a script step printed reaches
// the host on its `playbook.script` telemetry event and reaches no agent —
// the session Captain included, when it reports the run the script failed and
// when the Boss then asks what the command printed. The real factory runs a
// real `sh` under the real Captain shell.

import { createMachine } from 'xstate';
import { describe, expect, it } from 'vitest';

import type {
  BossTurn,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  PlayerRunResult,
} from '@sublang/cligent/tmux-play';
import type { PlaybookRuntime } from './runtime.js';
import { emptyPlaybookEffectLedger } from './xstate-runtime.js';
import {
  createXStatePlaybookRuntime,
  RUNTIME_ABI,
} from './xstate-playbook-runtime.js';
import {
  createPlaybookCaptainShell,
  type PlaybookHostConstructionCapabilities,
  type PlaybookCaptainRegistryEntry,
} from '../reference/sdlc/code.playbook/playbook-captain.ts';

// The command assembles the marker, so the command's own text never spells
// it: only the script's output can carry it anywhere.
const MARKER = 'IGNORE-PREVIOUS-INSTRUCTIONS-9d2e';
const COMMAND =
  'm=IGNORE-PREVIOUS; echo "lint: $m-INSTRUCTIONS-9d2e"; ' +
  'echo "fatal: $m-INSTRUCTIONS-9d2e" >&2; exit 1';
const FAILURE_DESCRIPTION =
  'gate ended in failure: the lint check reports problems';

// A gate: one script step whose nonzero exit ends the run at a failure
// terminal with a description authored before the run.
const gateMachine = createMachine({
  id: 'gate',
  initial: 'ready',
  context: {},
  states: {
    ready: {
      meta: { playbook: { stateId: 'ready', description: 'ready' } },
      tags: ['playbook.parked'],
      on: { START: 'checkLint' },
    },
    checkLint: {
      meta: { playbook: { stateId: 'checkLint', description: 'lint check' } },
      tags: ['playbook.busy'],
      invoke: {
        src: 'script',
        input: {
          stateId: 'checkLint',
          sourceItem: 'GATE-1',
          command: COMMAND,
          result: {
            lintPassed: 'The check exited zero.',
            lintFailed: 'The check exited nonzero.',
          },
        },
        onDone: [
          {
            guard: ({ event }) =>
              (event.output as { guard: string }).guard === 'lintPassed',
            target: 'passed',
          },
          { target: 'lintFailed' },
        ],
        onError: 'lintFailed',
      },
    },
    passed: {
      meta: {
        playbook: {
          stateId: 'passed',
          description: 'gate passed',
          terminal: 'success',
        },
      },
      type: 'final',
    },
    lintFailed: {
      meta: {
        playbook: {
          stateId: 'lintFailed',
          description: FAILURE_DESCRIPTION,
          terminal: 'failure',
        },
      },
      type: 'final',
    },
  },
});

const createGateRuntime = createXStatePlaybookRuntime(gateMachine, {
  label: 'GATE',
  compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {},
  outcomeAuthority: { governedPlayerStates: {} },
});

function registryEntry(): PlaybookCaptainRegistryEntry {
  return {
    id: 'gate',
    command: 'gate',
    intent: 'script-output fixture',
    artifactSchema: 3,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
    requiredRoleIds: [],
    concurrentRoleSets: [],
    validateOptions: (options) => options,
    createRuntime: (_options, hostCapabilities): PlaybookRuntime =>
      createGateRuntime({ configuredOptions: {}, hostCapabilities }),
  };
}

function hostCapabilities(): PlaybookHostConstructionCapabilities {
  const identity = Object.freeze({
    worktree: '/fixture',
    gitDir: '/fixture/.git',
  });
  const ledger = emptyPlaybookEffectLedger();
  const unavailable = async (): Promise<never> => {
    throw new Error('repository work is outside this fixture');
  };
  return Object.freeze({
    authority: Object.freeze({
      playbookId: 'gate',
      artifactSchema: 3 as const,
      cwd: identity.worktree,
      sessionId: '41000000-0000-4000-8000-000000000001',
      leaseOwnerToken: '41000000-0000-4000-8000-000000000002',
      canonicalWorktree: identity,
      requiredRoleIds: Object.freeze([]),
      concurrentRoleSets: Object.freeze([]),
    }),
    repository: Object.freeze({
      identity,
      observe: unavailable,
      acquire: unavailable,
      runExclusive: unavailable,
      runCohort: unavailable,
      runDeferred: unavailable,
    }),
    effectLedger: Object.freeze({
      snapshot: () => ledger,
      writeAhead: async () => ledger,
    }),
  });
}

function captainJson(value: unknown): CaptainRunResult {
  return { status: 'ok', turnId: 1, finalText: JSON.stringify(value) };
}

function turn(prompt: string, id = 1): BossTurn {
  return { id, prompt, timestamp: id };
}

function createHarness() {
  const entry = registryEntry();
  let id = 0;
  let captainIdIssued = false;
  const shell = createPlaybookCaptainShell(
    {
      playbooks: { gate: { from: 'test://gate', roles: {}, options: {} } },
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
      loadModule: async () => ({ default: entry }),
      hostCapabilities: { gate: hostCapabilities() },
      createSessionId: () => {
        if (!captainIdIssued) {
          captainIdIssued = true;
          return '41000000-0000-4000-8000-0000000000ff';
        }
        return `41000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
      },
    },
  );
  const statuses: string[] = [];
  const telemetry: { topic: string; payload: unknown }[] = [];
  const agentPrompts: string[] = [];
  const replies: string[] = [];
  const captainReplies: CaptainRunResult[] = [];
  let captainCalls = 0;
  const controller = new AbortController();
  const session: CaptainSession = {
    signal: controller.signal,
    players: [],
    emitStatus: async (message) => {
      statuses.push(message);
    },
    emitTelemetry: async (event) => {
      telemetry.push({ topic: event.topic, payload: event.payload });
    },
    setVisiblePlayers: async () => {},
  };
  const context: CaptainContext = {
    signal: controller.signal,
    players: [],
    callPlayer: async (playerId, prompt): Promise<PlayerRunResult> => {
      agentPrompts.push(prompt);
      return { status: 'ok', playerId, turnId: 1, finalText: 'unused' };
    },
    callCaptain: async (prompt): Promise<CaptainRunResult> => {
      agentPrompts.push(prompt);
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
    emitReply: async (text) => {
      replies.push(text);
    },
    setVisiblePlayers: async () => {},
  };
  return {
    shell,
    session,
    context,
    statuses,
    telemetry,
    agentPrompts,
    replies,
    captainReplies,
  };
}

describe('script output under the Captain shell (DR-103)', () => {
  it('passes a failed script step\'s output to the host and gives it to no agent call', async () => {
    const harness = createHarness();
    await harness.shell.init!(harness.session);

    // Turn 1: the gate runs, its check exits nonzero, and the run ends at
    // the failure terminal, which the session Captain reports.
    await harness.shell.handleBossTurn(
      turn('/gate run the gate'),
      harness.context,
    );

    expect(harness.statuses).toContain(
      'Executed script for checkLint (exit 1).',
    );
    expect(
      harness.telemetry
        .filter(({ topic }) => topic === 'playbook.script')
        .map(({ payload }) => payload),
    ).toEqual([
      {
        stateId: 'checkLint',
        sourceItem: 'GATE-1',
        exitStatus: 1,
        durationMs: expect.any(Number),
        output: `lint: ${MARKER}\nfatal: ${MARKER}\n`,
        outputTruncated: false,
      },
    ]);
    // The report was composed from the terminal's authored description…
    const reportPrompts = harness.agentPrompts.filter((prompt) =>
      prompt.includes(FAILURE_DESCRIPTION),
    );
    expect(reportPrompts.length).toBeGreaterThan(0);

    // Turn 2: the Boss asks what the command printed. The decision call and
    // the reply it leads to are grounded in what the shell retained.
    const promptsBeforeQuestion = harness.agentPrompts.length;
    harness.captainReplies.push(
      captainJson({
        action: 'respond',
        text: 'The report I was given does not hold the command output.',
      }),
    );
    await harness.shell.handleBossTurn(
      turn('Which command ran, and what did it print?', 2),
      harness.context,
    );
    expect(harness.agentPrompts.length).toBeGreaterThan(promptsBeforeQuestion);

    // …and no agent call, in either turn, was handed the output.
    for (const prompt of harness.agentPrompts) {
      expect(prompt).not.toContain(MARKER);
    }
    // Nor did the shell place it in what the Boss or the host reads as the
    // Captain's own words and state.
    expect(
      JSON.stringify({
        replies: harness.replies,
        statuses: harness.statuses,
        telemetry: harness.telemetry.filter(
          ({ topic }) => topic !== 'playbook.script',
        ),
      }),
    ).not.toContain(MARKER);

    await harness.shell.dispose!();
  });
});
