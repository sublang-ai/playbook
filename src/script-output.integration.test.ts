// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-103 §4 across the runtime/shell seam: what a script step printed reaches
// the host on its `playbook.script` telemetry event and reaches no agent —
// the session Captain included, when it reports the run the script failed and
// when the Boss then asks what the command printed. The real factory runs a
// real `sh` under the real Captain shell.

import { execFileSync } from 'node:child_process';
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
const gateMachine = (command: string) => createMachine({
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

const createGateRuntime = (command: string) =>
  createXStatePlaybookRuntime(gateMachine(command), {
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
      createGateRuntime(COMMAND)({ configuredOptions: {}, hostCapabilities }),
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

// DR-103 §2 on native Windows: a line that is not UTF-8 is read in the
// system code page, where the system has one for both its ANSI and OEM
// forms. The samples are each text's bytes in that code page, as octal
// `printf` escapes, so the command's own text never spells the text.
const CODE_PAGE_SAMPLES: Record<string, { text: string; bytes: string }> = {
  '874': {
    text: 'ไม่พบไฟล์ที่ระบุ',
    bytes: String.raw`\344\301\350\276\272\344\277\305\354\267\325\350\303\320\272\330`,
  },
  '932': {
    text: '指定されたパスが見つかりません。',
    bytes: String.raw`\216\167\222\350\202\263\202\352\202\275\203\160\203\130\202\252\214\251\202\302\202\251\202\350\202\334\202\271\202\361\201\102`,
  },
  '936': {
    text: '系统找不到指定的文件。',
    bytes: String.raw`\317\265\315\263\325\322\262\273\265\275\326\270\266\250\265\304\316\304\274\376\241\243`,
  },
  '949': {
    text: '지정된 경로를 찾을 수 없습니다.',
    bytes: String.raw`\301\366\301\244\265\310\040\260\346\267\316\270\246\040\303\243\300\273\040\274\366\040\276\370\275\300\264\317\264\331\056`,
  },
  '950': {
    text: '系統找不到指定的路徑。',
    bytes: String.raw`\250\164\262\316\247\344\244\243\250\354\253\374\251\167\252\272\270\364\256\174\241\103`,
  },
  '1258': {
    text: 'Không tìm thấy tệp',
    bytes: String.raw`\113\150\364\156\147\040\164\151\314\155\040\164\150\342\354\171\040\164\352\362\160`,
  },
};

// The system locale's two code pages, read through PowerShell rather than
// the registry value the runtime reads.
function systemCodePageSample(): { text: string; bytes: string } | undefined {
  if (process.platform !== 'win32') return undefined;
  const [ansi, oem] = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '$t = (Get-WinSystemLocale).TextInfo; "$($t.ANSICodePage) $($t.OEMCodePage)"',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
    .trim()
    .split(' ');
  return ansi === oem ? CODE_PAGE_SAMPLES[ansi!] : undefined;
}

const codePageSample = systemCodePageSample();

describe.skipIf(codePageSample === undefined)(
  'script output on native Windows (DR-103)',
  () => {
    it('reads a line that is not UTF-8 in the system code page, beside UTF-8 lines', async () => {
      const { text, bytes } = codePageSample!;
      // A UTF-8 line, a line in the system code page, and a UTF-16LE line:
      // U+9519 then `A`, whose NUL marks it as no code-page text.
      const command =
        String.raw`printf '\344\270\255\346\226\207 ok\n'; ` +
        `printf '${bytes}\\n'; ` +
        String.raw`printf '\031\225A\000\n\000'; exit 1`;
      const telemetry: { topic: string; payload: unknown }[] = [];
      const unused = async (): Promise<never> => {
        throw new Error('this fixture makes no agent call');
      };
      const runtime = createGateRuntime(command)({
        configuredOptions: {},
        hostCapabilities: hostCapabilities(),
      });
      await runtime.init({
        sessionId: '41000000-0000-4000-8000-0000000000a1',
        rootSessionId: '41000000-0000-4000-8000-0000000000a1',
        playbookId: 'gate',
        depth: 0,
        ports: {
          callPlayer: unused,
          callCaptain: unused,
          callJudge: unused,
          callPlaybook: unused,
          emitStatus: async () => {},
          emitTelemetry: async (event) => {
            telemetry.push({ topic: event.topic, payload: event.payload });
          },
        },
      });
      const result = await runtime.handleBossInput({
        text: 'run the gate',
        signal: new AbortController().signal,
      });

      expect(result.state.stateId).toBe('lintFailed');
      const outputs = telemetry
        .filter(({ topic }) => topic === 'playbook.script')
        .map(({ payload }) => (payload as { output: string }).output);
      expect(outputs.map((output) => output.normalize('NFC'))).toEqual([
        `中文 ok\n${text.normalize('NFC')}\n\u0019\uFFFDA\n`,
      ]);
      await runtime.dispose();
    });
  },
);
