// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createEvent } from '@sublang/cligent';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
} from '@sublang/cligent';
import { createTmuxPlayRuntime } from '@sublang/cligent/tmux-play';
import type {
  BossTurn,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  PlayerAdapterImports,
  PlayerRunResult,
  TmuxPlayRecord,
} from '@sublang/cligent/tmux-play';
import createCodeTmuxPlayCaptain, {
  codeCopyPasteGuardNames,
  codePlaybookRegistryEntry,
  codeStateCountLabels,
  createCodeRuntimeOptions,
  validateCodeOptions,
} from './code.tmux-play.js';

interface StubSession {
  session: CaptainSession;
  statuses: { message: string; data?: unknown }[];
  telemetry: { topic: string; payload: unknown }[];
}

interface StubContext {
  context: CaptainContext;
  controller: AbortController;
  playerCalls: { playerId: string; prompt: string }[];
  captainCalls: string[];
  captainOptions: unknown[];
}

function stubSession(
  players: CaptainSession['players'] = [
    { id: 'coder', adapter: 'claude' },
    { id: 'reviewer', adapter: 'codex' },
  ],
): StubSession {
  const statuses: StubSession['statuses'] = [];
  const telemetry: StubSession['telemetry'] = [];
  return {
    session: {
      signal: new AbortController().signal,
      players,
      emitStatus: async (message, data) => {
        statuses.push({ message, data });
      },
      emitTelemetry: async (event) => {
        telemetry.push({ topic: event.topic, payload: event.payload });
      },
    },
    statuses,
    telemetry,
  };
}

function isClassifierPrompt(prompt: string): boolean {
  return prompt.startsWith('Classify the following Boss message');
}

function isTurnSummaryPrompt(prompt: string): boolean {
  return prompt.includes('turn-summary block') &&
    prompt.includes('Saved you ');
}

function classifierReplyForTestPrompt(prompt: string): Record<string, unknown> {
  const message =
    prompt.match(/Boss message:\n```\n([\s\S]*?)\n```/)?.[1] ?? '';
  const trimmed = message.trim();
  const awaiting = prompt.includes('Current state: awaitBossReply');
  const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (slash) {
    const [, command, rest = ''] = slash;
    const arg = rest.trim();
    if (command === 'start') {
      return { event: 'START_CODING', payload: { intent: arg } };
    }
    if (command === 'continue') {
      return { event: 'CONTINUE_IR', payload: { irNumber: arg } };
    }
    if (command === 'summarize') {
      return { event: 'SUMMARIZE_IR', payload: { irNumber: arg } };
    }
    if (command === 'interrupt') {
      const firstSpace = arg.search(/\s/);
      const targetId = firstSpace === -1 ? arg : arg.slice(0, firstSpace);
      const intent = firstSpace === -1 ? '' : arg.slice(firstSpace).trim();
      return {
        event: 'BOSS_INTERRUPT',
        payload: { targetId, ...(intent ? { intent } : {}) },
      };
    }
  }
  if (awaiting) {
    return { event: 'BOSS_REPLY', payload: { answer: message } };
  }
  return { event: 'START_CODING', payload: { intent: trimmed } };
}

function stubContext(overrides: {
  playerResult?: (
    playerId: string,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<PlayerRunResult>;
  captainResult?: (
    prompt: string,
    signal: AbortSignal,
  ) => Promise<CaptainRunResult>;
} = {}): StubContext {
  const controller = new AbortController();
  const playerCalls: StubContext['playerCalls'] = [];
  const captainCalls: StubContext['captainCalls'] = [];
  const captainOptions: StubContext['captainOptions'] = [];
  const defaultCaptainReplies = [
    { guard: 'singleCommitReady' },
    { guard: 'committedSpecs' },
    { guard: 'noFindings' },
  ];
  let defaultCaptainIndex = 0;
  return {
    context: {
      signal: controller.signal,
      players: [],
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        if (overrides.playerResult) {
          return overrides.playerResult(playerId, prompt, controller.signal);
        }
        return {
          status: 'ok',
          playerId,
          turnId: 1,
          finalText: 'no progress - needs Boss input',
        };
      },
      callCaptain: async (prompt: string, options?: unknown) => {
        captainCalls.push(prompt);
        captainOptions.push(options);
        if (isTurnSummaryPrompt(prompt)) {
          return {
            status: 'ok',
            turnId: 1,
            finalText:
              'Summary: CODE finished this turn.\n\nSaved you 3 interruptions and 1 copy-paste across 0 rounds of reviews/rebuttals.',
          };
        }
        if (isClassifierPrompt(prompt)) {
          return {
            status: 'ok',
            turnId: 1,
            finalText: JSON.stringify(classifierReplyForTestPrompt(prompt)),
          };
        }
        if (overrides.captainResult) {
          return overrides.captainResult(prompt, controller.signal);
        }
        const reply = defaultCaptainReplies[defaultCaptainIndex++];
        if (!reply) {
          return {
            status: 'error',
            turnId: 1,
            error: `unexpected extra captain call #${defaultCaptainIndex}`,
          };
        }
        return {
          status: 'ok',
          turnId: 1,
          finalText: JSON.stringify(reply),
        };
      },
    },
    controller,
    playerCalls,
    captainCalls,
    captainOptions,
  };
}

function turn(prompt: string, id = 1): BossTurn {
  return { id, prompt, timestamp: 0 };
}

function committerPrompt(c: StubContext): string | undefined {
  return c.playerCalls.find((r) =>
    r.prompt.includes('Make a commit of the changes'),
  )?.prompt;
}

describe('code/tmux-play compatibility shim (PBRT-16/31)', () => {
  it('re-exports CODE registry metadata and option validation helpers', () => {
    expect(codePlaybookRegistryEntry).toEqual(
      expect.objectContaining({
        id: 'code',
        command: 'code',
        intent: 'software development / SDLC coding workflow',
        idleStateId: 'ready',
        finalStateId: 'done',
        copyPasteGuardNames: codeCopyPasteGuardNames,
        stateCountLabels: codeStateCountLabels,
        validateOptions: validateCodeOptions,
      }),
    );
    expect(codeCopyPasteGuardNames).toEqual([
      'accepted',
      'approved',
      'challengeAccepted',
      'challengeRejected',
      'challengesRaised',
      'changesMadeCode',
      'changesMadeCodeAndChallenged',
      'changesMadeMixed',
      'changesMadeMixedAndChallenged',
      'changesMadeSpecs',
      'changesMadeSpecsAndChallenged',
      'hasFindings',
      'needsRevision',
      'noFindings',
      'noOpenItems',
    ]);
    expect(codeStateCountLabels).toEqual({
      adjudicateChallenges: 'rebuttal',
      reviewBossCommitSpecs: 'review round',
      reviewBossCommitCode: 'review round',
      reviewBossCommitMixed: 'review round',
      reviewIrTaskCommitSpecs: 'review round',
      reviewIrTaskCommitCode: 'review round',
      reviewIrTaskCommitMixed: 'review round',
      reviewChangesSpecs: 'review round',
      reviewChangesCode: 'review round',
      reviewChangesMixed: 'review round',
      reviewChangesAndChallengesSpecs: 'review round',
      reviewChangesAndChallengesCode: 'review round',
      reviewChangesAndChallengesMixed: 'review round',
    });
    expect(validateCodeOptions({ code: { committer: 'reviewer' } })).toEqual({
      committer: 'reviewer',
    });
    expect(validateCodeOptions({ code: { committer: 'coder' } })).toEqual({
      committer: 'coder',
    });
    expect(
      createCodeRuntimeOptions({
        captainOptions: { code: { committer: 'reviewer' } },
        players: [
          { id: 'coder', adapter: 'codex', model: 'gpt-5.5' },
          { id: 'reviewer', adapter: 'claude' },
        ],
      }),
    ).toEqual({
      coderPlayer: 'gpt-5.5',
      reviewerPlayer: 'claude',
      committerPlayer: 'reviewer',
    });
  });

  it('accepts absent captain options through shell init and CODE engagement', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain(undefined);

    await expect(captain.init!(s.session)).resolves.toBeUndefined();
    await captain.handleBossTurn(turn('/code /start fix the bug'), c.context);

    expect(c.playerCalls.map((call) => call.playerId)).toContain('coder');
  });

  it('rejects unknown captain.options.code keys during shell init', async () => {
    const captain = createCodeTmuxPlayCaptain({ code: { tempo: 5 } });
    await expect(captain.init!(stubSession().session)).rejects.toThrow(
      /captain\.options\.code\.tempo/,
    );
  });

  it('rejects an invalid captain.options.code.committer value during shell init', async () => {
    const captain = createCodeTmuxPlayCaptain({
      code: { committer: 'boss' },
    });
    await expect(captain.init!(stubSession().session)).rejects.toThrow(
      /captain\.options\.code\.committer/,
    );
  });

  it('delegates explicit /code turns to the shell-registered CODE runtime', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({});

    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/code /start fix the bug'), c.context);

    expect(s.statuses).toContainEqual({
      message: '◇ /code started',
      data: undefined,
    });
    expect(s.statuses.map((st) => st.message)).toContain('START_CODING');
    expect(c.playerCalls.map((call) => call.playerId)).toContain('coder');
    expect(c.captainCalls.length).toBeGreaterThan(0);
    for (const [index, options] of c.captainOptions.entries()) {
      if (isTurnSummaryPrompt(c.captainCalls[index] ?? '')) {
        expect(options).toBeUndefined();
        continue;
      }
      expect(options).toEqual({ visibility: 'hidden' });
    }
  });

  it('threads captain.options.code through the shell registry entry', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      code: { committer: 'reviewer' },
    });

    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/code /start fix the bug'), c.context);

    const commitCall = c.playerCalls.find((r) =>
      r.prompt.includes('Make a commit of the changes'),
    );
    expect(commitCall?.playerId).toBe('reviewer');
    expect(committerPrompt(c)).toContain('Coder is claude.');
  });

  it('derives model-pinned identity strings from the tmux-play session', async () => {
    const s = stubSession([
      { id: 'coder', adapter: 'claude', model: 'claude-opus-4-7' },
      { id: 'reviewer', adapter: 'codex', model: 'gpt-5.5' },
    ]);
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({});

    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/code /start fix the bug'), c.context);

    expect(committerPrompt(c)).toContain('Coder is claude-opus-4-7.');
    expect(committerPrompt(c)).not.toMatch(/Coder is claude[.;,]/);
  });

  it('passes context.signal into CODE through the shell shim', async () => {
    const s = stubSession();
    const c = stubContext({
      playerResult: async (_id, _prompt, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 'aborted',
          playerId: 'coder',
          turnId: 1,
          error: 'aborted via context.signal',
        };
      },
    });
    const captain = createCodeTmuxPlayCaptain({});

    await captain.init!(s.session);
    setTimeout(() => c.controller.abort(), 5);
    await captain.handleBossTurn(turn('/code /start x'), c.context);

    expect(
      s.statuses.find((st) => st.message === '◆ failed'),
    ).toBeDefined();
  });
});

type RunScript = (
  prompt: string,
  options?: AgentOptions,
) => AsyncGenerator<AgentEvent, void, void>;

function textEvent(agent: string, content: string): AgentEvent {
  return createEvent('text', agent, { content }, 'sid');
}

function doneEvent(agent: string, result: string | undefined): AgentEvent {
  return createEvent(
    'done',
    agent,
    {
      status: 'success',
      result,
      usage: { inputTokens: 1, outputTokens: 1, toolUses: 0 },
      durationMs: 1,
    },
    'sid',
  );
}

function adapterClass(agent: string, run: RunScript): new () => AgentAdapter {
  return class implements AgentAdapter {
    readonly agent = agent;
    run(prompt: string, options?: AgentOptions) {
      return run(prompt, options);
    }
    async isAvailable(): Promise<boolean> {
      return true;
    }
  };
}

function adapterImports(
  scripts: Partial<Record<'claude' | 'codex' | 'gemini' | 'opencode', RunScript>>,
): PlayerAdapterImports {
  const fallback: RunScript = async function* () {
    yield doneEvent('test-agent', 'unused');
  };
  const make =
    (name: 'claude' | 'codex' | 'gemini' | 'opencode', agent: string) =>
    async () =>
      adapterClass(agent, scripts[name] ?? fallback);
  return {
    claude: make('claude', 'claude-code'),
    codex: make('codex', 'codex'),
    gemini: make('gemini', 'gemini'),
    opencode: make('opencode', 'opencode'),
  };
}

function visibilityOf(record: TmuxPlayRecord): string | undefined {
  return (record as { visibility?: string }).visibility;
}

function isCaptainCallRecord(record: TmuxPlayRecord): boolean {
  return (
    record.type === 'captain_prompt' ||
    record.type === 'captain_event' ||
    record.type === 'captain_finished'
  );
}

describe('judge JSON through compatibility shim (PBRT-32 / DR-007)', () => {
  it('drives a real tmux-play turn and keeps judge replies off the Boss pane', async () => {
    const records: TmuxPlayRecord[] = [];
    const judgeReplies: string[] = [];
    const adjudications = [
      { guard: 'singleCommitReady' },
      { guard: 'needsBossInput' },
    ];
    let adjIndex = 0;

    const judgeScript: RunScript = async function* (prompt) {
      if (isTurnSummaryPrompt(prompt)) {
        const summary =
          'CODE finished the routed turn and stopped for Boss input.\n\nSaved you 1 interruption and 0 copy-pastes across 0 rounds of reviews/rebuttals.';
        yield textEvent('claude-code', summary);
        yield doneEvent('claude-code', summary);
        return;
      }
      const reply = isClassifierPrompt(prompt)
        ? classifierReplyForTestPrompt(prompt)
        : (adjudications[adjIndex++] ?? { guard: 'needsBossInput' });
      const json = JSON.stringify(reply);
      judgeReplies.push(json);
      yield textEvent('claude-code', json);
      yield doneEvent('claude-code', json);
    };

    const playerScript: RunScript = async function* () {
      yield doneEvent('codex', 'no progress - needs Boss input');
    };

    const runtime = await createTmuxPlayRuntime({
      captain: createCodeTmuxPlayCaptain({}),
      captainConfig: { adapter: 'claude' },
      players: [
        { id: 'coder', adapter: 'codex' },
        { id: 'reviewer', adapter: 'gemini' },
      ],
      observers: [{ onRecord: (r) => records.push(r as TmuxPlayRecord) }],
      adapterImports: adapterImports({
        claude: judgeScript,
        codex: playerScript,
        gemini: playerScript,
      }),
    });

    await runtime.runBossTurn('/code /start fix the bug');
    await runtime.dispose();

    expect(judgeReplies.length).toBeGreaterThanOrEqual(2);
    const captainRecords = records.filter(isCaptainCallRecord);
    expect(captainRecords.length).toBeGreaterThan(0);
    const hiddenCaptainRecords = captainRecords.filter(
      (record) => visibilityOf(record) === 'hidden',
    );
    expect(hiddenCaptainRecords.length).toBeGreaterThan(0);
    for (const record of hiddenCaptainRecords) {
      expect(visibilityOf(record)).toBe('hidden');
    }

    const bossPaneVisible = records.filter(
      (record) =>
        record.type === 'captain_status' ||
        (isCaptainCallRecord(record) && visibilityOf(record) !== 'hidden'),
    );
    expect(bossPaneVisible.length).toBeGreaterThan(0);
    const paneText = JSON.stringify(bossPaneVisible);
    for (const reply of judgeReplies) {
      expect(paneText).not.toContain(reply);
    }
  });
});
