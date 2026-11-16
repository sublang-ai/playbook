// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-106 §4 across the runtime/shell seam: what a script step printed reaches
// the host on its `playbook.script` telemetry event and reaches no agent —
// the session Captain included, when it reports the run the script failed and
// when the Boss then asks what the command printed. The real factory runs a
// real `sh` under the real Captain shell.
// DR-107 across the same seam: the Captain closing that run is told the
// command and its exit status, and a later Boss question still reads them.

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
import {
  CODE_PAGE_SAMPLES,
  windowsSystemCodePage,
  type CodePageSample,
} from './test-support/code-pages.ts';

// The command assembles the marker, so the command's own text never spells
// it: only the script's output can carry it anywhere.
const MARKER = 'IGNORE-PREVIOUS-INSTRUCTIONS-9d2e';
const COMMAND =
  'm=IGNORE-PREVIOUS; echo "lint: $m-INSTRUCTIONS-9d2e"; ' +
  'echo "fatal: $m-INSTRUCTIONS-9d2e" >&2; exit 1';
const FAILURE_DESCRIPTION =
  'gate ended in failure: the lint check reports problems';
// What the session Captain says to close the failed run.
const CLOSING_REPLY = 'The gate stopped at its lint check.';
// DR-107: the settlement fact the shell adds for that script step, as the
// closing call reads it and as the journal's recap — itself JSON — holds it.
const SCRIPT_FACT =
  `A script step of /gate exited with status 1 before the run ended; ` +
  `its command was ${JSON.stringify(COMMAND)}. The command's output is on ` +
  `the session's record for the host and was not given to Captain.`;
const SCRIPT_FACT_RECAP = JSON.stringify(SCRIPT_FACT).slice(1, -1);

// What one gate fixture varies.
interface GateOptions {
  /** The check's command. */
  readonly command: string;
  /**
   * Where a zero exit goes: the success terminal, or — for a run that fails
   * although its script passed — the failure terminal.
   */
  readonly passedTarget?: 'passed' | 'lintFailed';
  /** A second script step a nonzero exit runs before the failure terminal. */
  readonly cleanup?: string;
  /** Whether a nonzero exit parks for the Boss before the failure terminal. */
  readonly parks?: boolean;
  /**
   * Whether the event reaches the shell with no `command`, as a linked
   * runtime from before DR-107 emits it.
   */
  readonly withoutCommand?: boolean;
  /** Whether the Boss starts a playbook that calls the gate. */
  readonly nested?: boolean;
}

// A gate: one script step whose nonzero exit ends the run at a failure
// terminal with a description authored before the run.
const gateMachine = ({
  command,
  passedTarget = 'passed',
  cleanup,
  parks = false,
}: GateOptions) => createMachine({
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
          command,
          result: {
            lintPassed: 'The check exited zero.',
            lintFailed: 'The check exited nonzero.',
          },
        },
        onDone: [
          {
            guard: ({ event }) =>
              (event.output as { guard: string }).guard === 'lintPassed',
            target: passedTarget,
          },
          {
            target:
              cleanup !== undefined ? 'cleanUp' : parks ? 'held' : 'lintFailed',
          },
        ],
        onError: 'lintFailed',
      },
    },
    cleanUp: {
      meta: { playbook: { stateId: 'cleanUp', description: 'cleanup' } },
      tags: ['playbook.busy'],
      invoke: {
        src: 'script',
        input: {
          stateId: 'cleanUp',
          sourceItem: 'GATE-2',
          command: cleanup ?? 'true',
          result: {
            cleaned: 'The cleanup exited zero.',
            cleanupFailed: 'The cleanup exited nonzero.',
          },
        },
        onDone: 'lintFailed',
        onError: 'lintFailed',
      },
    },
    held: {
      meta: {
        playbook: { stateId: 'held', description: 'the check failed' },
      },
      tags: ['playbook.parked'],
      on: { START: 'lintFailed' },
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

const createGateRuntime = (options: GateOptions) =>
  createXStatePlaybookRuntime(gateMachine(options), {
    label: 'GATE',
    compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    roleStates: {},
    outcomeAuthority: { governedPlayerStates: {} },
  });

// The runtime with its `playbook.script` events stripped of `command` on
// their way to the host port, as a linked runtime from before DR-107 emits
// them.
function withoutCommand(runtime: PlaybookRuntime): PlaybookRuntime {
  return new Proxy(runtime, {
    get(target, property) {
      if (property !== 'init') {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const init: PlaybookRuntime['init'] = (session) =>
        target.init({
          ...session,
          ports: {
            ...session.ports,
            emitTelemetry: (event) => {
              if (event.topic !== 'playbook.script') {
                return session.ports.emitTelemetry(event);
              }
              const { command: _command, ...payload } = event.payload as {
                command: string;
              };
              return session.ports.emitTelemetry({ ...event, payload });
            },
          },
        });
      return init;
    },
  });
}

function registryEntry(options: GateOptions): PlaybookCaptainRegistryEntry {
  return {
    id: 'gate',
    command: 'gate',
    intent: 'script-output fixture',
    artifactSchema: 3,
    runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
    requiredRoleIds: [],
    concurrentRoleSets: [],
    validateOptions: (configured) => configured,
    createRuntime: (_options, hostCapabilities): PlaybookRuntime => {
      const runtime = createGateRuntime(options)({
        configuredOptions: {},
        hostCapabilities,
      });
      return options.withoutCommand === true
        ? withoutCommand(runtime)
        : runtime;
    },
  };
}

// A playbook whose one step calls the gate, and which ends at a failure
// terminal of its own when the gate has ended.
const OUTER_FAILURE_DESCRIPTION = 'outer ended in failure: its gate failed';
const createOuterRuntime = createXStatePlaybookRuntime(
  createMachine({
    id: 'outer',
    initial: 'ready',
    context: {},
    states: {
      ready: {
        meta: { playbook: { stateId: 'ready', description: 'ready' } },
        tags: ['playbook.parked'],
        on: { START: 'callGate' },
      },
      callGate: {
        meta: { playbook: { stateId: 'callGate', description: 'gate call' } },
        tags: ['playbook.suspended'],
        invoke: {
          src: 'playbook',
          input: {
            stateId: 'callGate',
            sourceItem: 'OUTER-1',
            playbookId: 'gate',
            text: 'run the gate',
          },
          onDone: 'gateFailed',
          onError: 'gateFailed',
        },
      },
      gateFailed: {
        meta: {
          playbook: {
            stateId: 'gateFailed',
            description: OUTER_FAILURE_DESCRIPTION,
            terminal: 'failure',
          },
        },
        type: 'final',
      },
    },
  }),
  {
    label: 'OUTER',
    compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    roleStates: {},
    outcomeAuthority: { governedPlayerStates: {} },
  },
);

const outerEntry: PlaybookCaptainRegistryEntry = {
  id: 'outer',
  command: 'outer',
  intent: 'script-output fixture: a playbook that calls the gate',
  artifactSchema: 3,
  runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
  requiredRoleIds: [],
  concurrentRoleSets: [],
  validateOptions: (configured) => configured,
  createRuntime: (_options, hostCapabilities): PlaybookRuntime =>
    createOuterRuntime({ configuredOptions: {}, hostCapabilities }),
};

function hostCapabilities(
  playbookId = 'gate',
): PlaybookHostConstructionCapabilities {
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
      playbookId,
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

function createHarness(options: GateOptions = { command: COMMAND }) {
  const entries: Record<string, PlaybookCaptainRegistryEntry> = {
    'test://gate': registryEntry(options),
    ...(options.nested === true ? { 'test://outer': outerEntry } : {}),
  };
  let id = 0;
  let captainIdIssued = false;
  const shell = createPlaybookCaptainShell(
    {
      playbooks: {
        gate: { from: 'test://gate', roles: {}, options: {} },
        ...(options.nested === true
          ? { outer: { from: 'test://outer', roles: {}, options: {} } }
          : {}),
      },
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
      loadModule: async (specifier) => ({ default: entries[specifier] }),
      hostCapabilities: {
        gate: hostCapabilities(),
        ...(options.nested === true
          ? { outer: hostCapabilities('outer') }
          : {}),
      },
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
  // Each Captain call's prompt and the conversation it resumed, beside the
  // text and the conversation token it returned.
  const captainCalls: {
    prompt: string;
    resume: unknown;
    text: string;
    resumeToken?: string;
  }[] = [];
  const replies: string[] = [];
  const captainReplies: CaptainRunResult[] = [];
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
    callCaptain: async (prompt, options): Promise<CaptainRunResult> => {
      agentPrompts.push(prompt);
      const scripted = captainReplies.shift() ?? {
        status: 'ok' as const,
        turnId: 1,
        finalText: 'Acknowledged.',
      };
      // A refused resume names no conversation; every other call names one.
      const resumeToken =
        scripted.status === 'ok'
          ? `conversation-${captainCalls.length + 1}`
          : undefined;
      captainCalls.push({
        prompt,
        resume: (options as { resume?: unknown } | undefined)?.resume,
        text: scripted.finalText ?? '',
        ...(resumeToken === undefined ? {} : { resumeToken }),
      });
      return {
        ...scripted,
        ...(resumeToken === undefined ? {} : { resumeToken }),
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
    captainCalls,
    replies,
    captainReplies,
  };
}

describe('a script step under the Captain shell (DR-106, DR-107)', () => {
  it('passes a failed script step\'s output to the host, tells the Captain its command and exit status, and gives the output to no agent call', async () => {
    const harness = createHarness();
    await harness.shell.init!(harness.session);

    // Turn 1: the gate runs, its check exits nonzero, and the run ends at
    // the failure terminal, which the session Captain reports.
    harness.captainReplies.push({
      status: 'ok',
      turnId: 1,
      finalText: CLOSING_REPLY,
    });
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
        command: COMMAND,
        exitStatus: 1,
        durationMs: expect.any(Number),
        output: `lint: ${MARKER}\nfatal: ${MARKER}\n`,
        outputTruncated: false,
      },
    ]);
    // The Boss was told what one Captain call said, and that call was
    // composed from the terminal's authored description…
    expect(
      harness.replies.some((reply) => reply.includes(CLOSING_REPLY)),
    ).toBe(true);
    const closingCall = harness.captainCalls.find(
      ({ text }) => text === CLOSING_REPLY,
    );
    expect(closingCall?.prompt).toContain(FAILURE_DESCRIPTION);
    // …followed by what the script step ran and how it exited (DR-107): the
    // command as executed and its exit status, with no state id.
    const facts = closingCall!.prompt
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(facts.at(-1)).toBe(`- ${SCRIPT_FACT}`);
    expect(facts.at(-2)).toContain(FAILURE_DESCRIPTION);
    expect(closingCall!.prompt).not.toContain('checkLint');

    // Turn 2: the Boss asks what the command printed. The decision call
    // resumes the conversation the closing call left, which holds that fact.
    const callsBeforeQuestion = harness.captainCalls.length;
    harness.captainReplies.push(
      captainJson({
        action: 'respond',
        text: 'The check exited with status 1; I was not given its output.',
      }),
    );
    await harness.shell.handleBossTurn(
      turn('Which command ran, and what did it print?', 2),
      harness.context,
    );
    expect(harness.captainCalls.length).toBe(callsBeforeQuestion + 1);
    expect(harness.captainCalls.at(-1)!.resume).toBe(closingCall!.resumeToken);

    // Turn 3: the adapter refuses that conversation, so the question is asked
    // again over the journal's recap, which carries the same fact.
    harness.captainReplies.push(
      {
        status: 'error',
        turnId: 3,
        error: 'the conversation is gone',
        errorCode: 'SESSION_RESUME_REJECTED',
      },
      captainJson({
        action: 'respond',
        text: 'It exited with status 1; its output is on the session record.',
      }),
    );
    await harness.shell.handleBossTurn(
      turn('And how did it exit?', 3),
      harness.context,
    );
    const recapCall = harness.captainCalls.at(-1)!;
    expect(recapCall.resume).toBe(false);
    expect(recapCall.prompt).toContain(SCRIPT_FACT_RECAP);

    // …and no agent call, in any turn, was handed the output.
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

// One Boss turn that the session Captain closes with `CLOSING_REPLY`, after
// the control replies `earlier` scripts: the facts that closing call was
// given, one per line.
async function closingFacts(
  harness: ReturnType<typeof createHarness>,
  bossTurn: BossTurn,
  earlier: readonly CaptainRunResult[] = [],
): Promise<string[]> {
  harness.captainReplies.push(...earlier, {
    status: 'ok',
    turnId: bossTurn.id,
    finalText: CLOSING_REPLY,
  });
  await harness.shell.handleBossTurn(bossTurn, harness.context);
  const closingCall = harness.captainCalls.find(
    ({ text }) => text === CLOSING_REPLY,
  );
  expect(closingCall).toBeDefined();
  expect(closingCall!.prompt).not.toContain('checkLint');
  return closingCall!.prompt
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

const scriptFacts = (facts: readonly string[]): string[] =>
  facts.filter((fact) => fact.startsWith('A script step of'));

// DR-107 §2, playbook-captain-94: which failed runs close with the
// script-step fact, and what the fact carries.
describe('the script-step fact of a failed run (DR-107)', () => {
  it('names the nested playbook whose script step exited nonzero', async () => {
    const harness = createHarness({ command: COMMAND, nested: true });
    await harness.shell.init!(harness.session);

    const facts = await closingFacts(harness, turn('/outer run the gate'));

    expect(harness.statuses).toContain(
      'Executed script for checkLint (exit 1).',
    );
    // The root ended at its own failure terminal; the fact after its
    // completion fact names the playbook the step belongs to.
    expect(facts.at(-2)).toContain(OUTER_FAILURE_DESCRIPTION);
    expect(facts.at(-1)).toBe(SCRIPT_FACT);

    await harness.shell.dispose!();
  });

  it('states no script step where the script exited zero', async () => {
    // The same gate, except that a passing check also ends at the failure
    // terminal: the run failed, and no script step of it exited nonzero.
    const harness = createHarness({
      command: 'echo fine',
      passedTarget: 'lintFailed',
    });
    await harness.shell.init!(harness.session);

    const facts = await closingFacts(harness, turn('/gate run the gate'));

    expect(harness.statuses).toContain(
      'Executed script for checkLint (exit 0).',
    );
    expect(facts.at(-1)).toContain(FAILURE_DESCRIPTION);
    expect(scriptFacts(facts)).toEqual([]);

    await harness.shell.dispose!();
  });

  it('states no script step where a later script step of the turn exited zero', async () => {
    const harness = createHarness({ command: 'exit 1', cleanup: 'echo cleaned' });
    await harness.shell.init!(harness.session);

    const facts = await closingFacts(harness, turn('/gate run the gate'));

    expect(harness.statuses).toEqual(
      expect.arrayContaining([
        'Executed script for checkLint (exit 1).',
        'Executed script for cleanUp (exit 0).',
      ]),
    );
    expect(facts.at(-1)).toContain(FAILURE_DESCRIPTION);
    expect(scriptFacts(facts)).toEqual([]);

    await harness.shell.dispose!();
  });

  it('states no script step where the event carries no command', async () => {
    const harness = createHarness({ command: COMMAND, withoutCommand: true });
    await harness.shell.init!(harness.session);

    const facts = await closingFacts(harness, turn('/gate run the gate'));

    expect(
      harness.telemetry
        .filter(({ topic }) => topic === 'playbook.script')
        .map(({ payload }) => payload),
    ).toEqual([
      expect.not.objectContaining({ command: expect.anything() }),
    ]);
    expect(facts.at(-1)).toContain(FAILURE_DESCRIPTION);
    expect(scriptFacts(facts)).toEqual([]);

    await harness.shell.dispose!();
  });

  it('states no script step where the run parked for the Boss after it', async () => {
    const harness = createHarness({ command: 'exit 1', parks: true });
    await harness.shell.init!(harness.session);

    // Turn 1: the check exits nonzero and the run parks.
    await harness.shell.handleBossTurn(
      turn('/gate run the gate'),
      harness.context,
    );
    expect(harness.statuses).toContain(
      'Executed script for checkLint (exit 1).',
    );
    // Turn 2: the Boss's word ends the run at its failure terminal. The
    // script step completed in the earlier turn, so this one states none.
    // The Captain delivers it, and the gate's judge reads it as the event.
    const facts = await closingFacts(harness, turn('end it', 2), [
      captainJson({ action: 'deliver' }),
      captainJson({ type: 'START' }),
    ]);

    expect(facts.at(-1)).toContain(FAILURE_DESCRIPTION);
    expect(scriptFacts(facts)).toEqual([]);
    for (const { prompt } of harness.captainCalls) {
      expect(prompt).not.toContain('A script step of');
    }

    await harness.shell.dispose!();
  });

  it('quotes a long command of several lines on one line, bounded and marked', async () => {
    const command = `echo one\n: ${'x'.repeat(450)}\nexit 3 # tail-of-command`;
    const harness = createHarness({ command });
    await harness.shell.init!(harness.session);

    const facts = await closingFacts(harness, turn('/gate run the gate'));

    // The host's event carries the command whole…
    expect(
      harness.telemetry
        .filter(({ topic }) => topic === 'playbook.script')
        .map(({ payload }) => (payload as { command: string }).command),
    ).toEqual([command]);
    // …and the Captain's fact carries its head on one line, marked as cut.
    const [fact, ...others] = scriptFacts(facts);
    expect(others).toEqual([]);
    expect(fact).toMatch(
      /^A script step of \/gate exited with status 3 before the run ended; its command was "echo one : x+… \(truncated\)"\. /,
    );
    expect(fact).not.toContain('tail-of-command');

    await harness.shell.dispose!();
  });
});

// DR-106 §2 on native Windows: a line that is not UTF-8 is read in the
// system code page, where the system has one for both its ANSI and OEM
// forms.
const codePageSample: CodePageSample | undefined =
  CODE_PAGE_SAMPLES[windowsSystemCodePage() ?? ''];

// One script step through the real runtime; its `playbook.script` payloads.
let gateSessions = 0;
async function runGate(
  command: string,
): Promise<{ output: string; outputTruncated: boolean }[]> {
  const payloads: { output: string; outputTruncated: boolean }[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('this fixture makes no agent call');
  };
  const runtime = createGateRuntime({ command })({
    configuredOptions: {},
    hostCapabilities: hostCapabilities(),
  });
  const sessionId = `41000000-0000-4000-8000-${String(0xa00 + ++gateSessions).padStart(12, '0')}`;
  await runtime.init({
    sessionId,
    rootSessionId: sessionId,
    playbookId: 'gate',
    depth: 0,
    ports: {
      callPlayer: unused,
      callCaptain: unused,
      callJudge: unused,
      callPlaybook: unused,
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.script') {
          payloads.push(
            event.payload as { output: string; outputTruncated: boolean },
          );
        }
      },
    },
  });
  await runtime.handleBossInput({
    text: 'run the gate',
    signal: new AbortController().signal,
  });
  await runtime.dispose();
  return payloads;
}

describe.skipIf(codePageSample === undefined)(
  'script output on native Windows (DR-106)',
  () => {
    it('reads a line that is not UTF-8 in the system code page, beside UTF-8 lines', async () => {
      const { text, bytes } = codePageSample!;
      // A UTF-8 line, a line in the system code page, and a UTF-16LE line:
      // U+9519 then `A`, whose NUL marks it as no code-page text.
      const payloads = await runGate(
        String.raw`printf '\344\270\255\346\226\207 ok\n'; ` +
          `printf '${bytes}\\n'; ` +
          String.raw`printf '\031\225A\000\n\000'; exit 1`,
      );

      expect(payloads.map(({ output }) => output.normalize('NFC'))).toEqual([
        `中文 ok\n${text.normalize('NFC')}\n\u0019\uFFFDA\n`,
      ]);
    });

    it('reads a code-page line that follows a UTF-16 line', async () => {
      const { text, bytes } = codePageSample!;
      // `WSL` and a CRLF in UTF-16LE, as `wsl.exe` prints a line, then a line
      // in the system code page: the newline's NUL is no part of that line.
      const payloads = await runGate(
        String.raw`printf 'W\000S\000L\000\r\000\n\000'; ` +
          `printf '${bytes}\\n'; exit 1`,
      );

      expect(payloads.map(({ output }) => output.normalize('NFC'))).toEqual([
        `WSL\r\n${text.normalize('NFC')}\n`,
      ]);
    });

    // A long localized diagnostic: one line of code-page characters, longer
    // than the 16384 bytes the record keeps.
    const repeated = (count: number, tail: string): string =>
      `LC_ALL=C awk 'BEGIN { for (i = 0; i < 100; i++) printf "x"; ` +
      `for (i = 0; i < ${count}; i++) printf "${codePageSample!.charBytes}"; ` +
      `printf "${tail}" }'`;

    it('keeps a cut code-page line intact where the cut falls between two characters', async () => {
      const { char, charWidth } = codePageSample!;
      // 100 ASCII bytes, then exactly 16384 bytes of the character: the
      // kept tail opens on a whole character.
      const kept = 16384 / charWidth;
      const payloads = await runGate(repeated(kept, ''));

      expect(payloads).toHaveLength(1);
      const { output, outputTruncated } = payloads[0]!;
      expect(outputTruncated).toBe(true);
      // Short facts first, so a failure names the damage, not 16 KiB of it.
      expect(output.slice(0, 4)).toBe(char.repeat(4));
      expect([...output]).toHaveLength(kept);
      expect(output === char.repeat(kept)).toBe(true);
    });

    it('keeps a cut code-page line aligned where ASCII follows it', async () => {
      const { char, charWidth } = codePageSample!;
      // The character run, then `ok` and a newline: the cut falls inside a
      // character, and the ASCII would complete a wrong reading of the line.
      const whole = Math.floor(16381 / charWidth);
      const payloads = await runGate(repeated(16384 / charWidth, 'ok\\n'));

      expect(payloads).toHaveLength(1);
      const { output, outputTruncated } = payloads[0]!;
      expect(outputTruncated).toBe(true);
      expect(output.slice(0, 4)).toBe(char.repeat(4));
      expect(output.slice(-5)).toBe(`${char.repeat(2)}ok\n`);
      expect([...output]).toHaveLength(whole + 3);
      expect(output === `${char.repeat(whole)}ok\n`).toBe(true);
    });

    it('keeps a whole code-page character that opens the kept tail', async () => {
      const { char, charBytes, charWidth } = codePageSample!;
      // 100 ASCII bytes, the character and a newline, then ASCII to the
      // bound: the kept tail opens exactly on the character.
      const ascii = 16384 - charWidth - 1;
      const payloads = await runGate(
        `LC_ALL=C awk 'BEGIN { for (i = 0; i < 100; i++) printf "x"; ` +
          `printf "${charBytes}\\n"; ` +
          `for (i = 0; i < ${ascii}; i++) printf "a" }'`,
      );

      expect(payloads).toHaveLength(1);
      const { output, outputTruncated } = payloads[0]!;
      expect(outputTruncated).toBe(true);
      expect(output.slice(0, 4)).toBe(`${char}\naa`);
      expect(output === `${char}\n${'a'.repeat(ascii)}`).toBe(true);
    });

    it('drops the partial character of a cut UTF-8 line before a code-page line', async () => {
      const { text, bytes } = codePageSample!;
      // 5000 ASCII bytes, 6000 three-byte UTF-8 characters, `ab`, then the
      // code-page line: the kept tail opens inside the UTF-8 run.
      // One escape per byte of the code-page line, and its newline.
      const codePageLine = bytes.split('\\').length - 1 + 1;
      const whole = Math.floor((16384 - codePageLine - 3) / 3);
      const payloads = await runGate(
        `LC_ALL=C awk 'BEGIN { for (i = 0; i < 5000; i++) printf "x"; ` +
          String.raw`for (i = 0; i < 6000; i++) printf "\344\270\255"; ` +
          `printf "ab\\n${bytes}\\n" }'`,
      );

      expect(payloads).toHaveLength(1);
      const { output, outputTruncated } = payloads[0]!;
      expect(outputTruncated).toBe(true);
      expect(output.slice(0, 4)).toBe('中'.repeat(4));
      expect(
        output.normalize('NFC') ===
          `${'中'.repeat(whole)}ab\n${text.normalize('NFC')}\n`,
      ).toBe(true);
    });

    it('drops only the partial character where the cut falls inside one', async () => {
      const { char, charWidth } = codePageSample!;
      // One more character and a newline: 16384 + width + 1 bytes after the
      // ASCII, so the kept tail opens one byte later than a whole character
      // would.
      const payloads = await runGate(repeated(16384 / charWidth + 1, '\\n'));

      expect(payloads).toHaveLength(1);
      const { output, outputTruncated } = payloads[0]!;
      const whole = Math.floor(16383 / charWidth);
      expect(outputTruncated).toBe(true);
      expect(output.slice(0, 4)).toBe(char.repeat(4));
      expect([...output]).toHaveLength(whole + 1);
      expect(output === `${char.repeat(whole)}\n`).toBe(true);
    });
  },
);
