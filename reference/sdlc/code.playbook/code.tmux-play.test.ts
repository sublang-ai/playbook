// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
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
import { createEvent } from '@sublang/cligent';
import type { AgentAdapter, AgentEvent, AgentOptions } from '@sublang/cligent';
import createCodeTmuxPlayCaptain, {
  validateCodeOptions,
} from './code.tmux-play.js';

// ─── Stub builders ──────────────────────────────────────────────

interface StubSession {
  session: CaptainSession;
  statuses: { message: string; data?: unknown }[];
  telemetry: { topic: string; payload: unknown }[];
  controller: AbortController;
}

function stubSession(): StubSession {
  const controller = new AbortController();
  const statuses: StubSession['statuses'] = [];
  const telemetry: StubSession['telemetry'] = [];
  return {
    session: {
      signal: controller.signal,
      // PBRT-4: the adapter derives coderPlayer/reviewerPlayer from
      // these entries (find by id, take the adapter name) instead of
      // reading captain.options.
      players: [
        { id: 'coder', adapter: 'claude' },
        { id: 'reviewer', adapter: 'codex' },
      ],
      emitStatus: async (message, data) => {
        statuses.push({ message, data });
      },
      emitTelemetry: async (event) => {
        telemetry.push({ topic: event.topic, payload: event.payload });
      },
    },
    statuses,
    telemetry,
    controller,
  };
}

interface StubContext {
  context: CaptainContext;
  controller: AbortController;
  playerCalls: { playerId: string; prompt: string }[];
  captainCalls: string[];
  // The options object passed alongside each `callCaptain` prompt,
  // recorded in call order so tests can assert hidden visibility
  // (PBRT-15 / PBRT-21). `undefined` when no options were passed.
  captainOptions: unknown[];
}

function isClassifierPrompt(prompt: string): boolean {
  return prompt.startsWith('Classify the following Boss message');
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

function adjudicationPrompts(context: StubContext): string[] {
  return context.captainCalls.filter((prompt) => !isClassifierPrompt(prompt));
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
  signal?: AbortSignal;
} = {}): StubContext {
  const controller = new AbortController();
  const signal = overrides.signal ?? controller.signal;
  const playerCalls: StubContext['playerCalls'] = [];
  const captainCalls: StubContext['captainCalls'] = [];
  const captainOptions: StubContext['captainOptions'] = [];
  const defaultCaptainReplies = [
    { guard: 'singleCommitReady' },
    { guard: 'needsBossInput' },
  ];
  let defaultCaptainIndex = 0;
  return {
    context: {
      signal,
      players: [],
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        if (overrides.playerResult) {
          return overrides.playerResult(playerId, prompt, signal);
        }
        return {
          status: 'ok',
          playerId,
          turnId: 1,
          finalText: 'no progress — needs Boss input',
        };
      },
      callCaptain: async (prompt: string, options?: unknown) => {
        captainCalls.push(prompt);
        captainOptions.push(options);
        if (isClassifierPrompt(prompt)) {
          return {
            status: 'ok',
            turnId: 1,
            finalText: JSON.stringify(classifierReplyForTestPrompt(prompt)),
          };
        }
        if (overrides.captainResult) {
          return overrides.captainResult(prompt, signal);
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

const turn = (prompt: string, id = 1): BossTurn => ({
  id,
  prompt,
  timestamp: 0,
});

// ─── Tests ──────────────────────────────────────────────────────

describe('createCodeTmuxPlayCaptain — lifecycle (IR-004 Task 11)', () => {
  it('init → handleBossTurn → dispose drives through callPlayer + callCaptain', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);
    await captain.dispose!();

    expect(c.playerCalls).toHaveLength(2);
    expect(c.captainCalls).toHaveLength(3);
    expect(s.statuses.length).toBeGreaterThan(0);
    expect(s.telemetry.length).toBeGreaterThan(0);
  });

  it('handleBossTurn before init rejects with the runtime guard error', async () => {
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await expect(
      captain.handleBossTurn(turn('/start x'), c.context),
    ).rejects.toThrow(/init must be called first/);
  });

  it('dispose stops the underlying runtime cleanly', async () => {
    const s = stubSession();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await expect(captain.dispose!()).resolves.toBeUndefined();
  });
});

describe('createCodeTmuxPlayCaptain — port wiring (DR-004 §11)', () => {
  it('callPlayer forwards (playerId, prompt) to context.callPlayer', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start add a button'), c.context);

    expect(c.playerCalls[0].playerId).toBe('coder');
    expect(c.playerCalls[0].prompt).toContain('add a button');
  });

  it('callJudge forwards the adjudication prompt to context.callCaptain', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start something'), c.context);

    const adjudication = adjudicationPrompts(c);
    expect(adjudication[0]).toContain('needsBossReply'); // result key in prompt
    expect(adjudication[0]).toContain('Pick exactly one outcome');
  });

  it('every callCaptain (classification + adjudication) runs hidden', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start something'), c.context);

    // PBRT-15 / DR-007: the judge's JSON must never stream to the Boss
    // pane, so every callCaptain — classification and adjudication
    // alike — passes { visibility: 'hidden' }. One options object is
    // recorded per callCaptain call.
    expect(c.captainCalls.length).toBeGreaterThan(0);
    expect(c.captainOptions).toHaveLength(c.captainCalls.length);
    for (const options of c.captainOptions) {
      expect(options).toEqual({ visibility: 'hidden' });
    }
  });

  it('callJudge throws when callCaptain status !== "ok"', async () => {
    const s = stubSession();
    const c = stubContext({
      captainResult: async () => ({
        status: 'error',
        turnId: 1,
        error: 'captain crashed',
      }),
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    // The captain bridge re-wraps the thrown error and routes through
    // onError → #failed; the turn completes (no throw), but FSM lands
    // at failed. We surface the cause via emitStatus.
    await captain.handleBossTurn(turn('/start x'), c.context);

    const failedStatus = s.statuses.find(
      (st) => st.message === '◆ failed',
    );
    expect(failedStatus).toBeDefined();
  });

  it('emitStatus forwards verbatim to session.emitStatus', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    // init no longer emits a `◆ ready` tombstone (PBRT-3). Drive
    // one turn so the captain produces a real status line and
    // verify session.emitStatus is the recipient.
    await captain.handleBossTurn(turn('/start x'), c.context);
    expect(s.statuses.map((x) => x.message)).toContain('START_CODING');
  });

  it('emitTelemetry forwards verbatim to session.emitTelemetry', async () => {
    const s = stubSession();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    expect(s.telemetry[0].topic).toBe('playbook.fsm.state');
    expect(s.telemetry[0].payload).toEqual(
      expect.objectContaining({ to: 'ready' }),
    );
  });
});

describe('createCodeTmuxPlayCaptain — PlayerRunResult ↔ PlayerResult identity (TMUX-033)', () => {
  it('status="ok" with finalText round-trips and drives the FSM', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start x'), c.context);
    // PBRT-3: ready/done entries are suppressed; verify the turn
    // produced a classification line and reached the idle FSM state.
    expect(s.statuses.map((st) => st.message)).toContain('START_CODING');
    expect(
      s.statuses.map((st) => st.message).filter((m) => /^◆ (ready|done)/.test(m)),
    ).toEqual([]);
  });

  it('status="aborted" surfaces and lands FSM at #failed', async () => {
    const s = stubSession();
    const c = stubContext({
      playerResult: async () => ({
        status: 'aborted',
        playerId: 'coder',
        turnId: 1,
        error: 'host aborted',
      }),
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start x'), c.context);

    const failedStatus = s.statuses.find(
      (st) => st.message === '◆ failed',
    );
    expect(failedStatus).toBeDefined();
    expect(failedStatus?.data).toEqual(
      expect.objectContaining({ lastError: expect.anything() }),
    );
  });

  it('status="error" surfaces and lands FSM at #failed', async () => {
    const s = stubSession();
    const c = stubContext({
      playerResult: async () => ({
        status: 'error',
        playerId: 'coder',
        turnId: 1,
        error: 'coder crashed',
      }),
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start x'), c.context);
    expect(
      s.statuses.find((st) => st.message === '◆ failed'),
    ).toBeDefined();
  });
});

describe('createCodeTmuxPlayCaptain — multi-stage Boss turn', () => {
  it('reaches the reviewer player through a full /start single-commit flow', async () => {
    const s = stubSession();
    const guards = ['singleCommitReady', 'committedSpecs', 'noFindings'];
    let i = 0;
    const c = stubContext({
      captainResult: async () => ({
        status: 'ok',
        turnId: 1,
        finalText: JSON.stringify({ guard: guards[i++] }),
      }),
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);

    const playerIds = c.playerCalls.map((r) => r.playerId);
    expect(playerIds).toContain('coder');
    expect(playerIds).toContain('reviewer');
    // Turn-completion proof: the final telemetry transitions back to
    // `ready` (PBRT-3 suppresses the `◆ done` tombstone, so the
    // status stream no longer carries one).
    expect(
      s.telemetry.some(
        (t) => (t.payload as { to?: string }).to === 'ready',
      ),
    ).toBe(true);
  });
});

describe('createCodeTmuxPlayCaptain — identity strings derived from session.players (PBRT-4)', () => {
  // Drives the FSM from /start into the Committer (CODE-18) state,
  // whose prompt template includes `Coder is <coder-llm>.`. The
  // adapter is responsible for filling `<coder-llm>` from
  // session.players[id=coder].adapter, *not* from captain.options.
  function singleCommitContext(): StubContext {
    const guards = ['singleCommitReady', 'committedSpecs', 'noFindings'];
    let i = 0;
    return stubContext({
      captainResult: async () => ({
        status: 'ok',
        turnId: 1,
        finalText: JSON.stringify({ guard: guards[i++] }),
      }),
    });
  }

  function committerPrompt(c: StubContext): string | undefined {
    return c.playerCalls.find((r) =>
      r.prompt.includes('Make a commit of the changes'),
    )?.prompt;
  }

  function sessionWith(coder: string, reviewer: string): StubSession {
    const base = stubSession();
    return {
      ...base,
      session: {
        ...base.session,
        players: [
          { id: 'coder', adapter: coder as never },
          { id: 'reviewer', adapter: reviewer as never },
        ],
      },
    };
  }

  function sessionWithModels(
    coder: { adapter: string; model: string },
    reviewer: { adapter: string; model: string },
  ): StubSession {
    const base = stubSession();
    return {
      ...base,
      session: {
        ...base.session,
        players: [
          { id: 'coder', adapter: coder.adapter as never, model: coder.model },
          {
            id: 'reviewer',
            adapter: reviewer.adapter as never,
            model: reviewer.model,
          },
        ],
      },
    };
  }

  it('overrides stale captain.options with session.players adapters in the Committer prompt', async () => {
    // Swap session.players so the derived adapters disagree with the
    // stale captain.options values. The new implementation must
    // substitute the session-derived strings; the previous
    // options-only implementation would substitute the STALE-* values.
    const s = sessionWith('codex', 'claude');
    const c = singleCommitContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'STALE-CODER',
      reviewerPlayer: 'STALE-REVIEWER',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);

    const prompt = committerPrompt(c);
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Coder is codex.');
    expect(prompt).not.toContain('STALE-CODER');
    expect(prompt).not.toContain('STALE-REVIEWER');
  });

  it('derives identity strings when captain.options omits them entirely', async () => {
    // No coderPlayer / reviewerPlayer in the forwarded options — the
    // adapter must still produce a substituted prompt from
    // session.players, leaving no raw <coder-llm> placeholder behind.
    const s = sessionWith('claude', 'codex');
    const c = singleCommitContext();
    const captain = createCodeTmuxPlayCaptain({});
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);

    const prompt = committerPrompt(c);
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Coder is claude.');
    expect(prompt).not.toContain('<coder-llm>');
  });

  it('prefers session.players[].model over .adapter for identity strings', async () => {
    // PBRT-4: when a player entry pins a model, the derived identity
    // string is the model id (e.g. `claude-opus-4-7`), not the
    // adapter family name (e.g. `claude`). This is what lets a
    // Committer's commit-message trailer name the concrete model.
    const s = sessionWithModels(
      { adapter: 'claude', model: 'claude-opus-4-7' },
      { adapter: 'codex', model: 'gpt-5.5' },
    );
    const c = singleCommitContext();
    const captain = createCodeTmuxPlayCaptain({});
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);

    const prompt = committerPrompt(c);
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Coder is claude-opus-4-7.');
    // No bare adapter family name from the substitution itself —
    // matches `Coder is claude` only as a prefix of the model id.
    expect(prompt).not.toMatch(/Coder is claude[.;,]/);
  });
});

describe('createCodeTmuxPlayCaptain — captain.options.code validation (PBRT-29/30/31)', () => {
  // Drives /start through the single-commit flow so the Committer
  // (CODE-18) prompt is produced; its `Coder is <coder-llm>.` line lets
  // us prove identity still comes from session.players, independent of
  // captain.options.code.
  function singleCommitContext(): StubContext {
    const guards = ['singleCommitReady', 'committedSpecs', 'noFindings'];
    let i = 0;
    return stubContext({
      captainResult: async () => ({
        status: 'ok',
        turnId: 1,
        finalText: JSON.stringify({ guard: guards[i++] }),
      }),
    });
  }

  function committerPrompt(c: StubContext): string | undefined {
    return c.playerCalls.find((r) =>
      r.prompt.includes('Make a commit of the changes'),
    )?.prompt;
  }

  it('validateCodeOptions returns an empty set for {}, an absent namespace, and absent options', () => {
    expect(validateCodeOptions({ code: {} })).toEqual({});
    expect(validateCodeOptions({})).toEqual({});
    expect(validateCodeOptions(undefined)).toEqual({});
  });

  it('validateCodeOptions rejects an unknown key with a path-named error', () => {
    expect(() => validateCodeOptions({ code: { tempo: 5 } })).toThrow(
      /captain\.options\.code\.tempo/,
    );
  });

  it('init with captain.options.code = {} initializes and derives identity from session.players', async () => {
    const s = stubSession();
    const c = singleCommitContext();
    const captain = createCodeTmuxPlayCaptain({ code: {} });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);

    const prompt = committerPrompt(c);
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Coder is claude.');
    expect(prompt).not.toContain('<coder-llm>');
  });

  it('init with captain.options absent initializes the same way', async () => {
    const s = stubSession();
    const c = singleCommitContext();
    const captain = createCodeTmuxPlayCaptain({});
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);

    const prompt = committerPrompt(c);
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Coder is claude.');
  });

  it('init rejects when captain.options.code carries an unknown key', async () => {
    const s = stubSession();
    const captain = createCodeTmuxPlayCaptain({ code: { tempo: 5 } });
    await expect(captain.init!(s.session)).rejects.toThrow(
      /captain\.options\.code\.tempo/,
    );
  });

  it('validateCodeOptions accepts committer alias coder / reviewer', () => {
    expect(validateCodeOptions({ code: { committer: 'coder' } })).toEqual({
      committer: 'coder',
    });
    expect(validateCodeOptions({ code: { committer: 'reviewer' } })).toEqual({
      committer: 'reviewer',
    });
  });

  it('validateCodeOptions rejects an out-of-range committer with a path-named error', () => {
    expect(() =>
      validateCodeOptions({ code: { committer: 'boss' } }),
    ).toThrow(/captain\.options\.code\.committer/);
  });

  it('init with committer alias routes the Committer commit to the named pane while identity stays session-derived', async () => {
    // PBRT-31: the validated alias threads into the runtime as
    // committerPlayer, so the CODE-18 commit call runs on the
    // 'reviewer' pane. The `<coder-llm>` placeholder still resolves
    // from session.players (coder→claude), proving the alias is a
    // host-pane selector, not a PBRT-4 identity string.
    const s = stubSession();
    const c = singleCommitContext();
    const captain = createCodeTmuxPlayCaptain({ code: { committer: 'reviewer' } });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);

    const committerCall = c.playerCalls.find((r) =>
      r.prompt.includes('Make a commit of the changes'),
    );
    expect(committerCall).toBeDefined();
    expect(committerCall!.playerId).toBe('reviewer');
    expect(committerCall!.prompt).toContain('Coder is claude.');
    expect(committerCall!.prompt).not.toContain('<coder-llm>');
  });

  it('init rejects an out-of-range committer alias', async () => {
    const s = stubSession();
    const captain = createCodeTmuxPlayCaptain({ code: { committer: 'boss' } });
    await expect(captain.init!(s.session)).rejects.toThrow(
      /captain\.options\.code\.committer/,
    );
  });
});

// PBRT-32 / DR-007 §3 — end-to-end proof that the judge's control-plane
// JSON never reaches the Boss pane. `@sublang/cligent` now ships
// `callCaptain(prompt, { visibility: 'hidden' })` (CallCaptainOptions),
// so this drives the *real* tmux-play runtime in-process: our Captain
// over fake player + captain adapters, with a RecordObserver capturing
// the full trace. The tmux presenter skips records tagged
// `visibility: 'hidden'`, so asserting every judge-call Captain record
// is hidden — and that no Boss-pane-visible record carries a raw judge
// reply — is the faithful proxy for "only the runtime-composed status
// lines reach the pane" (PBRT-3/14). Mirrors cligent's own
// runtime.test.ts fake-adapter + observer harness.

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
  scripts: Partial<
    Record<'claude' | 'codex' | 'gemini' | 'opencode', RunScript>
  >,
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

describe('judge JSON never reaches the Boss pane (PBRT-32 / DR-007)', () => {
  it('drives a real tmux-play turn and keeps every judge reply off the Boss pane', async () => {
    const records: TmuxPlayRecord[] = [];
    const judgeReplies: string[] = [];
    // Mirror stubContext's default: classification derived from the
    // prompt, then the singleCommitReady → needsBossInput adjudication
    // sequence the lifecycle test proves drives /start to completion.
    const adjudications = [
      { guard: 'singleCommitReady' },
      { guard: 'needsBossInput' },
    ];
    let adjIndex = 0;

    const judgeScript: RunScript = async function* (prompt) {
      const reply = isClassifierPrompt(prompt)
        ? classifierReplyForTestPrompt(prompt)
        : (adjudications[adjIndex++] ?? { guard: 'needsBossInput' });
      const json = JSON.stringify(reply);
      judgeReplies.push(json);
      // The judge streams its control-plane JSON as text *and* as the
      // final result — both must land in HIDDEN Captain records.
      yield textEvent('claude-code', json);
      yield doneEvent('claude-code', json);
    };

    const playerScript: RunScript = async function* () {
      yield doneEvent('codex', 'no progress — needs Boss input');
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

    await runtime.runBossTurn('/start fix the bug');
    await runtime.dispose();

    // The judge ran: one classification + at least one adjudication.
    expect(judgeReplies.length).toBeGreaterThanOrEqual(2);

    // Every Captain record — the only records that can carry judge JSON —
    // is tagged hidden, so the tmux presenter skips it.
    const captainRecords = records.filter(isCaptainCallRecord);
    expect(captainRecords.length).toBeGreaterThan(0);
    for (const record of captainRecords) {
      expect(visibilityOf(record)).toBe('hidden');
    }

    // The Boss pane therefore receives only the runtime-composed
    // captain_status lines — no visible Captain record at all — and none
    // of those lines contains a raw judge JSON reply.
    const bossPaneVisible = records.filter(
      (record) =>
        record.type === 'captain_status' ||
        (isCaptainCallRecord(record) && visibilityOf(record) !== 'hidden'),
    );
    expect(bossPaneVisible.every((r) => r.type === 'captain_status')).toBe(true);
    const paneText = JSON.stringify(bossPaneVisible);
    for (const reply of judgeReplies) {
      expect(paneText).not.toContain(reply);
    }
  });
});

describe('createCodeTmuxPlayCaptain — signal propagation (DR-004 §11)', () => {
  it('context.signal flows into runtime.handleBossInput via handleBossTurn', async () => {
    // Use a callPlayer that resolves only when the signal aborts; the
    // FSM lands at #failed via the aborted status, proving that the
    // adapter wired context.signal into the player call.
    const s = stubSession();
    const c = stubContext({
      playerResult: async (_id, _p, signal) => {
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
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    setTimeout(() => c.controller.abort(), 5);
    await captain.handleBossTurn(turn('/start x'), c.context);

    expect(
      s.statuses.find((st) => st.message === '◆ failed'),
    ).toBeDefined();
  });
});
