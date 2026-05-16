// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { codingMachine, type CaptainInput } from './code.fsm.js';
import createPlaybookRuntime, {
  _internal,
  type PlaybookPorts,
} from './code.playbook.js';

const {
  composePlayerPrompt,
  resolvePlayerId,
  adjudicate,
  classifyBossText,
  captainBridge,
} = _internal;

function makeFakePorts(
  overrides: Partial<PlaybookPorts> = {},
): PlaybookPorts {
  return {
    callPlayer: async () => {
      throw new Error('callPlayer not used in this test');
    },
    callJudge: async () => '{}',
    emitStatus: async () => {},
    emitTelemetry: async () => {},
    ...overrides,
  };
}

function makeInput(overrides: Partial<CaptainInput> = {}): CaptainInput {
  return {
    player: 'Coder',
    sourceItem: 'TEST-1',
    prompt: 'do the thing',
    result: { ok: 'fine' },
    ...overrides,
  };
}

describe('composePlayerPrompt', () => {
  describe('placeholder substitution', () => {
    it('substitutes <#> from input.irNumber', () => {
      const out = composePlayerPrompt(
        makeInput({ prompt: 'Continue IR-<#>.', irNumber: '7' }),
      );
      expect(out).toBe('Continue IR-7.');
    });

    it('substitutes <coder-llm> from input.coderPlayer', () => {
      const out = composePlayerPrompt(
        makeInput({ prompt: 'Coder is <coder-llm>.', coderPlayer: 'claude' }),
      );
      expect(out).toBe('Coder is claude.');
    });

    it('substitutes <reviewer-llm> from input.reviewerPlayer', () => {
      const out = composePlayerPrompt(
        makeInput({
          prompt: 'Reviewer is <reviewer-llm>.',
          reviewerPlayer: 'codex',
        }),
      );
      expect(out).toBe('Reviewer is codex.');
    });

    it('substitutes all three placeholders in one prompt', () => {
      const out = composePlayerPrompt(
        makeInput({
          prompt: 'Coder=<coder-llm>, Reviewer=<reviewer-llm>, IR=<#>.',
          irNumber: '4',
          coderPlayer: 'claude',
          reviewerPlayer: 'codex',
        }),
      );
      expect(out).toBe('Coder=claude, Reviewer=codex, IR=4.');
    });

    it('replaces every occurrence of the same placeholder', () => {
      const out = composePlayerPrompt(
        makeInput({ prompt: 'IR-<#> is task <#>.', irNumber: '4' }),
      );
      expect(out).toBe('IR-4 is task 4.');
    });

    it('leaves a placeholder unchanged when its source field is undefined', () => {
      const out = composePlayerPrompt(
        makeInput({ prompt: 'IR-<#> stays.' }),
      );
      expect(out).toBe('IR-<#> stays.');
    });
  });

  describe('labelled blocks', () => {
    it('prepends "Boss intent:" when input.intent is set', () => {
      const out = composePlayerPrompt(
        makeInput({ intent: 'fix the bug', prompt: 'do it' }),
      );
      expect(out).toBe('Boss intent:\nfix the bug\n\ndo it');
    });

    it('prepends "Review items:" when input.reviews is set', () => {
      const out = composePlayerPrompt(
        makeInput({ reviews: '1. nit\n2. blocker', prompt: 'respond' }),
      );
      expect(out).toBe('Review items:\n1. nit\n2. blocker\n\nrespond');
    });

    it('prepends "Rebuttals:" when input.challenges is set', () => {
      const out = composePlayerPrompt(
        makeInput({ challenges: '1. nope\n2. agreed', prompt: 'adjudicate' }),
      );
      expect(out).toBe('Rebuttals:\n1. nope\n2. agreed\n\nadjudicate');
    });

    it('prepends "Task description:" when input.taskDescription is set', () => {
      const out = composePlayerPrompt(
        makeInput({
          taskDescription: 'rename foo to bar',
          prompt: 'review the change',
        }),
      );
      expect(out).toBe(
        'Task description:\nrename foo to bar\n\nreview the change',
      );
    });

    it('orders blocks per DR-004 §6: intent, reviews, challenges, taskDescription', () => {
      const out = composePlayerPrompt(
        makeInput({
          intent: 'I',
          reviews: 'R',
          challenges: 'C',
          taskDescription: 'T',
          prompt: 'BODY',
        }),
      );
      expect(out).toBe(
        'Boss intent:\nI\n\nReview items:\nR\n\nRebuttals:\nC\n\nTask description:\nT\n\nBODY',
      );
    });

    it('omits a labelled block when its field is undefined', () => {
      const out = composePlayerPrompt(
        makeInput({ intent: 'I', prompt: 'BODY' }),
      );
      expect(out).toBe('Boss intent:\nI\n\nBODY');
    });
  });

  describe('substitution scope', () => {
    it('substitutes placeholders only in the prompt body, not in labelled block content', () => {
      const out = composePlayerPrompt(
        makeInput({
          intent: 'add IR-<#>',
          prompt: 'Continue IR-<#>.',
          irNumber: '5',
        }),
      );
      expect(out).toBe('Boss intent:\nadd IR-<#>\n\nContinue IR-5.');
    });

    it('returns just the prompt body when no structured fields are set', () => {
      const out = composePlayerPrompt(makeInput({ prompt: 'hello' }));
      expect(out).toBe('hello');
    });
  });
});

describe('resolvePlayerId', () => {
  it('returns "coder" for non-composite Coder', () => {
    expect(resolvePlayerId(makeInput({ player: 'Coder' }))).toBe('coder');
  });

  it('returns "reviewer" for non-composite Reviewer', () => {
    expect(resolvePlayerId(makeInput({ player: 'Reviewer' }))).toBe(
      'reviewer',
    );
  });

  describe('Committer composite (DR-004 §2)', () => {
    it('CODE-18: only coderPlayer set → "coder"', () => {
      expect(
        resolvePlayerId(
          makeInput({
            player: 'Committer',
            sourceItem: 'CODE-18',
            coderPlayer: 'claude',
          }),
        ),
      ).toBe('coder');
    });

    it('CODE-19: both fields set → "coder" (Coder is first in alias declaration)', () => {
      expect(
        resolvePlayerId(
          makeInput({
            player: 'Committer',
            sourceItem: 'CODE-19',
            coderPlayer: 'claude',
            reviewerPlayer: 'codex',
          }),
        ),
      ).toBe('coder');
    });

    it('only reviewerPlayer set → "reviewer" (PBRT-8 runtime contract, even if no current gear ships such an input)', () => {
      // Pins the reviewerPlayer fallback branch in resolvePlayerId
      // (specs/dev/playbook-runtime.md PBRT-8). No CODE-N currently
      // emits a Committer input with only reviewerPlayer set — the
      // old reviewer-only Committer item was pruned as a dead
      // disjunct — but the runtime contract still requires this
      // path so a future gear (or a hand-built test harness) can
      // rely on it without an FSM round-trip.
      expect(
        resolvePlayerId(
          makeInput({
            player: 'Committer',
            reviewerPlayer: 'codex',
          }),
        ),
      ).toBe('reviewer');
    });

    it('neither field set → "coder" (alias first-alternative fallback per slc/link.md)', () => {
      expect(resolvePlayerId(makeInput({ player: 'Committer' }))).toBe(
        'coder',
      );
    });
  });
});

describe('adjudicate', () => {
  it('prompt contains every input.result key with its description verbatim', async () => {
    let prompt = '';
    const ports = makeFakePorts({
      callJudge: async (p) => {
        prompt = p;
        return JSON.stringify({ guard: 'firstKey' });
      },
    });
    const input = makeInput({
      result: {
        firstKey: 'First outcome description with detail.',
        secondKey:
          'Second outcome — Coder challenged the items; output includes `challenges: <numbered rebuttals>`.',
        thirdKey: 'Third outcome described tersely.',
      },
    });
    await adjudicate(input, 'player text', ports, new AbortController().signal);
    for (const [key, description] of Object.entries(input.result)) {
      expect(prompt).toContain(`\`${key}\``);
      expect(prompt).toContain(description);
    }
  });

  it('includes the player\'s verbatim output in the prompt', async () => {
    let prompt = '';
    const ports = makeFakePorts({
      callJudge: async (p) => {
        prompt = p;
        return JSON.stringify({ guard: 'foo' });
      },
    });
    const verbatim =
      'Multi-line\nplayer reply with\nbackticks like `x` preserved.';
    await adjudicate(
      makeInput({ result: { foo: 'desc' } }),
      verbatim,
      ports,
      new AbortController().signal,
    );
    expect(prompt).toContain(verbatim);
  });

  it('names the player in the prompt', async () => {
    let prompt = '';
    const ports = makeFakePorts({
      callJudge: async (p) => {
        prompt = p;
        return JSON.stringify({ guard: 'k' });
      },
    });
    await adjudicate(
      makeInput({ player: 'Reviewer', result: { k: 'desc' } }),
      'out',
      ports,
      new AbortController().signal,
    );
    expect(prompt).toContain('Reviewer');
  });

  it('returns the parsed JSON with all payload fields', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        JSON.stringify({ guard: 'foo', reviews: 'numbered list', extra: 1 }),
    });
    const out = await adjudicate(
      makeInput({ result: { foo: 'description' } }),
      'output',
      ports,
      new AbortController().signal,
    );
    expect(out.guard).toBe('foo');
    expect(out.reviews).toBe('numbered list');
    expect(out.extra).toBe(1);
  });

  it('strips a ```json code fence from the judge response', async () => {
    const ports = makeFakePorts({
      callJudge: async () => '```json\n{"guard":"foo"}\n```',
    });
    const out = await adjudicate(
      makeInput({ result: { foo: 'desc' } }),
      'out',
      ports,
      new AbortController().signal,
    );
    expect(out.guard).toBe('foo');
  });

  it('throws on an unknown guard', async () => {
    const ports = makeFakePorts({
      callJudge: async () => JSON.stringify({ guard: 'wrong' }),
    });
    await expect(
      adjudicate(
        makeInput({ result: { foo: 'desc', bar: 'desc' } }),
        'out',
        ports,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unknown guard "wrong"/);
  });

  it('throws when guard is missing or non-string', async () => {
    const ports = makeFakePorts({
      callJudge: async () => JSON.stringify({ noGuard: true }),
    });
    await expect(
      adjudicate(
        makeInput({ result: { foo: 'desc' } }),
        'out',
        ports,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/missing string "guard"/);
  });

  it('throws on malformed JSON response', async () => {
    const ports = makeFakePorts({
      callJudge: async () => 'this is not json at all',
    });
    await expect(
      adjudicate(
        makeInput({ result: { foo: 'desc' } }),
        'out',
        ports,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the response is a JSON array or non-object', async () => {
    const ports = makeFakePorts({
      callJudge: async () => '["foo", "bar"]',
    });
    await expect(
      adjudicate(
        makeInput({ result: { foo: 'desc' } }),
        'out',
        ports,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not a JSON object/);
  });

  it('passes the abort signal through to ports.callJudge', async () => {
    let received: AbortSignal | undefined;
    const ports = makeFakePorts({
      callJudge: async (_p, signal) => {
        received = signal;
        return JSON.stringify({ guard: 'k' });
      },
    });
    const controller = new AbortController();
    await adjudicate(
      makeInput({ result: { k: 'desc' } }),
      'out',
      ports,
      controller.signal,
    );
    expect(received).toBe(controller.signal);
  });

  describe('required payload-field validation (slc/link.md)', () => {
    const code2ChallengesRaised =
      'Coder challenged one or more review items. Output shall include `challenges: <numbered rebuttals, one per challenged item>`.';

    it('throws when the chosen guard requires a field the response omits', async () => {
      const ports = makeFakePorts({
        callJudge: async () =>
          JSON.stringify({ guard: 'challengesRaised' }),
      });
      await expect(
        adjudicate(
          makeInput({ result: { challengesRaised: code2ChallengesRaised } }),
          'out',
          ports,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/required field "challenges"/);
    });

    it('accepts the response when every required field is present as a string', async () => {
      const ports = makeFakePorts({
        callJudge: async () =>
          JSON.stringify({
            guard: 'challengesRaised',
            challenges: '1. counter-evidence',
          }),
      });
      const out = await adjudicate(
        makeInput({ result: { challengesRaised: code2ChallengesRaised } }),
        'out',
        ports,
        new AbortController().signal,
      );
      expect(out.guard).toBe('challengesRaised');
      expect(out.challenges).toBe('1. counter-evidence');
    });

    it('does not validate fields when the description names none', async () => {
      const ports = makeFakePorts({
        callJudge: async () => JSON.stringify({ guard: 'accepted' }),
      });
      const out = await adjudicate(
        makeInput({
          result: { accepted: 'Coder accepted without further edits.' },
        }),
        'out',
        ports,
        new AbortController().signal,
      );
      expect(out.guard).toBe('accepted');
    });

    it('throws when a required field is present but not a string', async () => {
      const ports = makeFakePorts({
        callJudge: async () =>
          JSON.stringify({ guard: 'challengesRaised', challenges: 42 }),
      });
      await expect(
        adjudicate(
          makeInput({ result: { challengesRaised: code2ChallengesRaised } }),
          'out',
          ports,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/required field "challenges"/);
    });
  });
});

describe('classifyBossText (slash forms — DR-004 §3)', () => {
  const sig = () => new AbortController().signal;

  it('/start <text> → START_CODING with intent', async () => {
    expect(
      await classifyBossText('/start fix the bug', makeFakePorts(), sig()),
    ).toEqual({ type: 'START_CODING', intent: 'fix the bug' });
  });

  it('/continue <#> → CONTINUE_IR with irNumber', async () => {
    expect(
      await classifyBossText('/continue 4', makeFakePorts(), sig()),
    ).toEqual({ type: 'CONTINUE_IR', irNumber: '4' });
  });

  it('/summarize <#> → SUMMARIZE_IR with irNumber', async () => {
    expect(
      await classifyBossText('/summarize 7', makeFakePorts(), sig()),
    ).toEqual({ type: 'SUMMARIZE_IR', irNumber: '7' });
  });

  it('/interrupt <stateId> → BOSS_INTERRUPT with targetId only', async () => {
    expect(
      await classifyBossText('/interrupt ready', makeFakePorts(), sig()),
    ).toEqual({ type: 'BOSS_INTERRUPT', targetId: 'ready' });
  });

  it('/interrupt <stateId> <rest> attaches rest as intent', async () => {
    expect(
      await classifyBossText(
        '/interrupt planAndImplement fix the bug',
        makeFakePorts(),
        sig(),
      ),
    ).toEqual({
      type: 'BOSS_INTERRUPT',
      targetId: 'planAndImplement',
      intent: 'fix the bug',
    });
  });

  it('unknown slash → emitStatus + undefined (slc/link.md "not silently dropped")', async () => {
    const statuses: string[] = [];
    const ports = makeFakePorts({
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    expect(await classifyBossText('/bogus rest', ports, sig())).toBeUndefined();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toContain('/bogus');
  });

  it('empty (whitespace-only) text → undefined, no port calls', async () => {
    let judgeCalled = false;
    let statusCalled = false;
    const ports = makeFakePorts({
      callJudge: async () => {
        judgeCalled = true;
        return '';
      },
      emitStatus: async () => {
        statusCalled = true;
      },
    });
    expect(await classifyBossText('   \n  ', ports, sig())).toBeUndefined();
    expect(judgeCalled).toBe(false);
    expect(statusCalled).toBe(false);
  });

  it('slash forms do not call ports.callJudge', async () => {
    let called = false;
    const ports = makeFakePorts({
      callJudge: async () => {
        called = true;
        return '';
      },
    });
    await classifyBossText('/start anything', ports, sig());
    expect(called).toBe(false);
  });
});

describe('classifyBossText (LLM fallback — DR-004 §3)', () => {
  const sig = () => new AbortController().signal;

  it('free-form text routes through callJudge and lands on START_CODING', async () => {
    let prompt = '';
    const ports = makeFakePorts({
      callJudge: async (p) => {
        prompt = p;
        return JSON.stringify({
          event: 'START_CODING',
          payload: { intent: 'fix the bug' },
        });
      },
    });
    const out = await classifyBossText('please fix the bug', ports, sig());
    expect(out).toEqual({ type: 'START_CODING', intent: 'fix the bug' });
    expect(prompt).toContain('please fix the bug');
  });

  it('fixed prompt names all four event types', async () => {
    let prompt = '';
    const ports = makeFakePorts({
      callJudge: async (p) => {
        prompt = p;
        return JSON.stringify({
          event: 'START_CODING',
          payload: { intent: 'x' },
        });
      },
    });
    await classifyBossText('something', ports, sig());
    expect(prompt).toContain('START_CODING');
    expect(prompt).toContain('CONTINUE_IR');
    expect(prompt).toContain('SUMMARIZE_IR');
    expect(prompt).toContain('BOSS_INTERRUPT');
  });

  it('unknown event type from LLM → emitStatus + undefined', async () => {
    const statuses: string[] = [];
    const ports = makeFakePorts({
      callJudge: async () =>
        JSON.stringify({ event: 'BOGUS', payload: {} }),
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    expect(
      await classifyBossText('please do something', ports, sig()),
    ).toBeUndefined();
    expect(statuses[0]).toContain('BOGUS');
  });
});

describe('captainBridge (DR-004 §7) — actor end-to-end', () => {
  function buildActor(ports: PlaybookPorts) {
    return createActor(
      codingMachine.provide({ actors: { captain: captainBridge(ports) } }),
      { input: { coderPlayer: 'claude', reviewerPlayer: 'codex' } },
    );
  }

  function settleAt(actor: ReturnType<typeof createActor>, values: readonly string[]) {
    return new Promise<void>((resolve) => {
      const sub = actor.subscribe((snap) => {
        if (typeof snap.value === 'string' && values.includes(snap.value)) {
          sub.unsubscribe();
          resolve();
        }
      });
    });
  }

  it('drives one fake turn through callPlayer + callJudge and advances the FSM', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    const judgeCalls: string[] = [];

    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return {
          status: 'ok',
          finalText: 'I cannot proceed without more input from Boss.',
        };
      },
      callJudge: async (prompt) => {
        judgeCalls.push(prompt);
        return JSON.stringify({ guard: 'needsBossInput' });
      },
    });

    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'START_CODING', intent: 'add a button' });

    await settleAt(actor, ['ready', 'failed', 'done']);

    expect(actor.getSnapshot().value).toBe('ready');
    expect(playerCalls).toHaveLength(1);
    expect(playerCalls[0].playerId).toBe('coder');
    expect(playerCalls[0].prompt).toContain('add a button');
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]).toContain('needsBossInput');
  });

  it('lands at #failed when callPlayer returns status="aborted"', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'aborted', error: 'host signal' }),
    });
    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'START_CODING', intent: 'do something' });

    await settleAt(actor, ['failed', 'ready', 'done']);

    expect(actor.getSnapshot().value).toBe('failed');
  });

  it('lands at #failed when callPlayer returns status="error"', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'error', error: 'player crashed' }),
    });
    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'START_CODING', intent: 'do' });

    await settleAt(actor, ['failed', 'ready', 'done']);

    expect(actor.getSnapshot().value).toBe('failed');
  });

  it('lands at #failed when callPlayer returns status="ok" with no finalText', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok' }),
    });
    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'START_CODING', intent: 'do' });

    await settleAt(actor, ['failed', 'ready', 'done']);

    expect(actor.getSnapshot().value).toBe('failed');
  });

  it('lands at #failed when callJudge returns malformed JSON', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'x' }),
      callJudge: async () => 'not json at all',
    });
    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'START_CODING', intent: 'do' });

    await settleAt(actor, ['failed', 'ready', 'done']);

    expect(actor.getSnapshot().value).toBe('failed');
  });

  it('lands at #failed when callJudge picks an undeclared guard', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'x' }),
      callJudge: async () => JSON.stringify({ guard: 'notAGuard' }),
    });
    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'START_CODING', intent: 'do' });

    await settleAt(actor, ['failed', 'ready', 'done']);

    expect(actor.getSnapshot().value).toBe('failed');
  });

  it('lands at #failed when callJudge omits a required payload field', async () => {
    // CODE-3 (continueIr) declares `taskReady` with a required
    // `taskDescription` field. Driving /CONTINUE_IR there and
    // returning the guard without the field exercises the
    // payload-required check.
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'x' }),
      callJudge: async () => JSON.stringify({ guard: 'taskReady' }),
    });
    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'CONTINUE_IR', irNumber: '4' });

    await settleAt(actor, ['failed', 'ready', 'done']);

    expect(actor.getSnapshot().value).toBe('failed');
  });
});

describe('createPlaybookRuntime.init (Task 8 wiring)', () => {
  it('constructs and starts the actor without throwing', async () => {
    const runtime = createPlaybookRuntime({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await expect(runtime.init(makeFakePorts())).resolves.toBeUndefined();
  });
});

// _getActor is an @internal escape hatch on the runtime; Task 10 will
// supersede it with proper status/telemetry assertions.
type RuntimeWithInternals = ReturnType<typeof createPlaybookRuntime> & {
  _getActor(): ReturnType<typeof createActor> | undefined;
};

function makeRuntimeWithInternals(): RuntimeWithInternals {
  return createPlaybookRuntime({
    coderPlayer: 'claude',
    reviewerPlayer: 'codex',
  }) as RuntimeWithInternals;
}

const sig = () => new AbortController().signal;

describe('handleBossInput drive-to-quiescence (Task 9)', () => {
  it('clean run: /start drives FSM through one captain turn back to ready', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    let judgeCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'no progress — need more input' };
      },
      callJudge: async () => {
        judgeCalls++;
        return JSON.stringify({ guard: 'needsBossInput' });
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/start add a button', signal: sig() });

    expect(playerCalls).toHaveLength(1);
    expect(playerCalls[0].playerId).toBe('coder');
    expect(playerCalls[0].prompt).toContain('add a button');
    expect(judgeCalls).toBe(1);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('signal-abort mid-callPlayer lands at #failed with lastError captured', async () => {
    const controller = new AbortController();
    let judgeCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async (_id, _p, signal) => {
        if (signal.aborted) {
          return { status: 'aborted', error: 'aborted before start' };
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 'aborted', error: 'host signal' };
      },
      callJudge: async () => {
        judgeCalls++;
        return '';
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    setTimeout(() => controller.abort(), 5);
    await runtime.handleBossInput({
      text: '/start do something',
      signal: controller.signal,
    });

    const snap = runtime._getActor()?.getSnapshot();
    expect(snap?.value).toBe('failed');
    expect((snap?.context as { lastError?: unknown }).lastError).toBeDefined();
    expect(judgeCalls).toBe(0); // callPlayer aborted; judge never reached
  });

  it('/interrupt <stateId> sends BOSS_INTERRUPT and redirects the FSM', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    // Normal turn lands at ready first.
    await runtime.handleBossInput({ text: '/start anything', signal: sig() });
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');

    // Interrupt redirects to failed (a quiescent target with no
    // captain invoke — no extra port calls required).
    await runtime.handleBossInput({
      text: '/interrupt failed',
      signal: sig(),
    });
    expect(runtime._getActor()?.getSnapshot().value).toBe('failed');
  });

  it('/interrupt <stateId> <intent> attaches the trailing text as intent', async () => {
    // planAndImplement (CODE-1) wires `context.intent` into the
    // captain prompt, so the trailing text shows up downstream.
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'need input' };
      },
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: '/interrupt planAndImplement add a sparkly button',
      signal: sig(),
    });

    expect(playerCalls).toHaveLength(1);
    expect(playerCalls[0].playerId).toBe('coder');
    expect(playerCalls[0].prompt).toContain('add a sparkly button');
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('throws when handleBossInput is called before init', async () => {
    const runtime = makeRuntimeWithInternals();
    await expect(
      runtime.handleBossInput({ text: '/start x', signal: sig() }),
    ).rejects.toThrow(/init must be called first/);
  });

  it('dispose stops the actor and clears state', async () => {
    const runtime = makeRuntimeWithInternals();
    await runtime.init(makeFakePorts());
    expect(runtime._getActor()).toBeDefined();
    await runtime.dispose();
    expect(runtime._getActor()).toBeUndefined();
  });

  it('classifier-undefined text (unknown slash) returns without sending anything', async () => {
    const statuses: string[] = [];
    let playerCalls = 0;
    let judgeCalls = 0;
    const ports = makeFakePorts({
      emitStatus: async (m) => {
        statuses.push(m);
      },
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok', finalText: '' };
      },
      callJudge: async () => {
        judgeCalls++;
        return '';
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/bogus stuff', signal: sig() });

    expect(statuses.some((m) => m.includes('/bogus'))).toBe(true);
    expect(playerCalls).toBe(0);
    expect(judgeCalls).toBe(0);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('/continue <#> drives the FSM through continueIr back to ready', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'need more input' };
      },
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/continue 7', signal: sig() });

    expect(playerCalls).toHaveLength(1);
    expect(playerCalls[0].playerId).toBe('coder');
    expect(playerCalls[0].prompt).toContain('IR-7');
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('/summarize <#> drives the FSM through summarizeSpecs back to ready', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'need more input' };
      },
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/summarize 8', signal: sig() });

    expect(playerCalls).toHaveLength(1);
    expect(playerCalls[0].playerId).toBe('coder');
    expect(playerCalls[0].prompt).toContain('IR-8');
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('non-slash text routes through callJudge classifier and advances the FSM', async () => {
    let classifyCalled = false;
    let adjudicateCalled = false;
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: async (prompt) => {
        if (prompt.startsWith('Classify the following Boss message')) {
          classifyCalled = true;
          return JSON.stringify({
            event: 'START_CODING',
            payload: { intent: 'fix the bug' },
          });
        }
        adjudicateCalled = true;
        return JSON.stringify({ guard: 'needsBossInput' });
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: 'please fix the bug',
      signal: sig(),
    });

    expect(classifyCalled).toBe(true);
    expect(adjudicateCalled).toBe(true);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('invalid classifier reply surfaces status and takes no FSM action', async () => {
    const statuses: string[] = [];
    let playerCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok', finalText: '' };
      },
      callJudge: async () =>
        JSON.stringify({ event: 'BOGUS', payload: {} }),
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: 'please do something',
      signal: sig(),
    });

    expect(statuses.some((m) => m.includes('BOGUS'))).toBe(true);
    expect(playerCalls).toBe(0);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('classifier reply naming a valid event but omitting its required payload surfaces status and takes no FSM action', async () => {
    const statuses: string[] = [];
    let playerCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok', finalText: '' };
      },
      // START_CODING requires payload.intent (string); omit it.
      callJudge: async () =>
        JSON.stringify({ event: 'START_CODING', payload: {} }),
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: 'please do something',
      signal: sig(),
    });

    expect(statuses.some((m) => m.includes('intent'))).toBe(true);
    expect(playerCalls).toBe(0);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('/interrupt without a target state surfaces status and takes no FSM action', async () => {
    const statuses: string[] = [];
    let playerCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok', finalText: '' };
      },
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/interrupt', signal: sig() });

    expect(
      statuses.some((m) => m.includes('requires a stateId')),
    ).toBe(true);
    expect(playerCalls).toBe(0);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('empty input takes no FSM action and makes no port calls', async () => {
    const statuses: string[] = [];
    let judgeCalls = 0;
    let playerCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok', finalText: '' };
      },
      callJudge: async () => {
        judgeCalls++;
        return '';
      },
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    const statusesAtInit = statuses.length;

    await runtime.handleBossInput({ text: '   \n  ', signal: sig() });

    expect(judgeCalls).toBe(0);
    expect(playerCalls).toBe(0);
    expect(statuses.length).toBe(statusesAtInit);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('turn arriving after the FSM reaches done disposes and reconstructs the actor', async () => {
    let judgeInvocation = 0;
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'x' }),
      callJudge: async () => {
        judgeInvocation++;
        if (judgeInvocation === 1) {
          return JSON.stringify({ guard: 'noSpecChanges' });
        }
        return JSON.stringify({ guard: 'needsBossInput' });
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    // Drive /summarize → summarizeSpecs → done (terminal/final).
    await runtime.handleBossInput({ text: '/summarize 9', signal: sig() });
    expect(runtime._getActor()?.getSnapshot().status).toBe('done');

    // Next Boss turn must trigger dispose + reconstruct so the FSM
    // can accept new events from the idle state.
    await runtime.handleBossInput({ text: '/start fresh', signal: sig() });

    expect(judgeInvocation).toBe(2);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
    expect(runtime._getActor()?.getSnapshot().status).toBe('active');
  });

  it('dispose awaits in-flight port emissions before resolving', async () => {
    let release: (() => void) | undefined;
    const order: string[] = [];
    const ports = makeFakePorts({
      emitTelemetry: async () => {
        order.push('t-start');
        await new Promise<void>((r) => {
          release = r;
        });
        order.push('t-end');
      },
    });
    const runtime = makeRuntimeWithInternals();
    // Do not await init — let the initial-transition telemetry start,
    // then stall in-flight.
    const initPromise = runtime.init(ports);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual(['t-start']);

    let disposed = false;
    const disposePromise = runtime.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(disposed).toBe(false);

    release!();
    await initPromise;
    await disposePromise;
    expect(order).toContain('t-end');
  });
});

describe('status and telemetry (Task 10 — DR-004 §9)', () => {
  type StatusCall = { message: string; data?: unknown };
  type TelemetryCall = { topic: string; payload: unknown };

  function makeRecordingPorts(
    overrides: Partial<PlaybookPorts> = {},
  ): {
    ports: PlaybookPorts;
    statuses: StatusCall[];
    telemetry: TelemetryCall[];
  } {
    const statuses: StatusCall[] = [];
    const telemetry: TelemetryCall[] = [];
    return {
      ports: makeFakePorts({
        emitStatus: async (message, data) => {
          statuses.push({ message, data });
        },
        emitTelemetry: async (event) => {
          telemetry.push(event);
        },
        ...overrides,
      }),
      statuses,
      telemetry,
    };
  }

  it('emits one terminal status on initial entry to ready', async () => {
    const { ports, statuses } = makeRecordingPorts();
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    expect(statuses.map((s) => s.message)).toContain('◆ ready');
  });

  it('emits telemetry on every transition with topic playbook.fsm.state', async () => {
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({
      text: '/start fix',
      signal: sig(),
    });
    // Expect at least 3 telemetry events:
    //   ⊥ → ready (initial)
    //   ready → planAndImplement
    //   planAndImplement → ready
    expect(telemetry.length).toBeGreaterThanOrEqual(3);
    for (const t of telemetry) {
      expect(t.topic).toBe('playbook.fsm.state');
      const payload = t.payload as Record<string, unknown>;
      expect(payload).toHaveProperty('from');
      expect(payload).toHaveProperty('to');
      expect(payload).toHaveProperty('event');
    }
    const transitions = telemetry.map(
      (t) => (t.payload as { to: string }).to,
    );
    expect(transitions).toContain('planAndImplement');
    expect(transitions).toContain('ready');
  });

  it('emitStatus surfaces every captain-invoking state (PBRT-3 widened)', async () => {
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({
      text: '/start fix',
      signal: sig(),
    });
    const messages = statuses.map((s) => s.message);
    // The Coder state on the /start happy path now surfaces with
    // its label + player + CODE-N tag.
    expect(
      messages.some((m) => m.startsWith('⮕ plan & implement  Coder per CODE-1')),
    ).toBe(true);
    // ready (initial + return) is terminal and rendered with ◆.
    expect(messages.filter((m) => m.startsWith('◆ ready')).length).toBeGreaterThanOrEqual(1);
    // Boss echo lands before the FSM advances.
    expect(messages.some((m) => m.startsWith('▸ BOSS  /start fix'))).toBe(true);
  });

  it('emitStatus on entry to failed includes lastError in data', async () => {
    const controller = new AbortController();
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async (_id, _p, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 'aborted', error: 'host signal' };
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    setTimeout(() => controller.abort(), 5);
    await runtime.handleBossInput({
      text: '/start x',
      signal: controller.signal,
    });
    const failedStatus = statuses.find((s) => s.message.startsWith('◆ failed'));
    expect(failedStatus).toBeDefined();
    expect(failedStatus?.data).toEqual(
      expect.objectContaining({ lastError: expect.anything() }),
    );
  });

  it('emissions are ordered and awaited (drainer serializes the queue)', async () => {
    const ordered: string[] = [];
    let inFlight = 0;
    const trackingEmit = async (label: string) => {
      inFlight++;
      // If anything else is already running, ordering broke.
      expect(inFlight).toBe(1);
      await new Promise<void>((r) => setTimeout(r, 0));
      ordered.push(label);
      inFlight--;
    };
    const { ports } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
      emitStatus: async (m) => trackingEmit(`s:${m}`),
      emitTelemetry: async (e) => {
        const p = e.payload as { to: string };
        return trackingEmit(`t:${p.to}`);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({
      text: '/start fix',
      signal: sig(),
    });
    // Telemetry emitted first per transition, then status; enqueue
    // order is preserved.
    expect(ordered[0]).toBe('t:ready');
    expect(ordered[1]).toBe('s:◆ ready');
  });

  it('STATE_LABELS covers every captain-invoking state', () => {
    for (const [stateId] of _internal.stateMetadata) {
      expect(_internal.STATE_LABELS[stateId], `${stateId} missing label`).toBeDefined();
    }
  });

  it('transition guard line precedes state entry with payload tallies', async () => {
    const { ports, statuses } = makeRecordingPorts({
      // Drive: /start → planAndImplement → singleCommitReady →
      //   commitCoderInitial → committedSpecs →
      //   reviewBossCommitSpecs → hasFindings (with 2 reviews) →
      //   respondToReview → accepted → done
      callPlayer: async () => ({ status: 'ok', finalText: 'done' }),
      callJudge: (() => {
        const replies = [
          { guard: 'singleCommitReady' },
          { guard: 'committedSpecs' },
          { guard: 'hasFindings', reviews: '1. tweak\n2. another' },
          { guard: 'accepted' },
        ];
        let i = 0;
        return async () => JSON.stringify(replies[i++]);
      })(),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({ text: '/start x', signal: sig() });
    const messages = statuses.map((s) => s.message);
    // The hasFindings transition carries `reviews=2`.
    expect(
      messages.some(
        (m) => m.includes('⤷ hasFindings') && m.includes('reviews=2'),
      ),
    ).toBe(true);
  });

  it('state entry includes the intent rider on planAndImplement', async () => {
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({
      text: '/start add a settings toggle',
      signal: sig(),
    });
    const entry = statuses
      .map((s) => s.message)
      .find((m) => m.startsWith('⮕ plan & implement'));
    expect(entry).toBeDefined();
    expect(entry).toContain('Coder per CODE-1');
    expect(entry).toContain('intent="add a settings toggle"');
  });

  it('Boss echo includes the verbatim text and the classified event type', async () => {
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: async () => JSON.stringify({ guard: 'needsBossInput' }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({ text: '/continue 7', signal: sig() });
    const echo = statuses
      .map((s) => s.message)
      .find((m) => m.startsWith('▸ BOSS'));
    expect(echo).toBeDefined();
    expect(echo).toContain('/continue 7');
    expect(echo).toContain('→ CONTINUE_IR');
  });
});

describe('Multi-stage Boss turn (DR-004 §7 + §9)', () => {
  it('full /start single-commit flow exercises coder, committer (CODE-18), and reviewer routing in one turn', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    // Per-state judge replies, in transition order:
    //   1. planAndImplement → singleCommitReady → commitCoderInitial
    //   2. commitCoderInitial → committedSpecs → reviewBossCommitSpecs
    //   3. reviewBossCommitSpecs → noFindings → done (afterReview='done')
    const guards = ['singleCommitReady', 'committedSpecs', 'noFindings'];
    let guardIdx = 0;
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'progress noted' };
      },
      callJudge: async () => JSON.stringify({ guard: guards[guardIdx++] }),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/start fix-bug', signal: sig() });

    // Three captain invocations, with the player ids exercising:
    //   - Coder → 'coder' (planAndImplement)
    //   - Committer composite CODE-18 (coderPlayer set) → 'coder'
    //   - Reviewer → 'reviewer' (reviewBossCommitSpecs)
    expect(playerCalls.map((c) => c.playerId)).toEqual([
      'coder',
      'coder',
      'reviewer',
    ]);
    // The second call is the Committer state; CODE-18's prompt body
    // names "Make a commit of the changes ...".
    expect(playerCalls[1].prompt).toContain('Make a commit of the changes');
    // The third call is Reviewer; CODE-5's prompt body opens with
    // "Review the latest commit."
    expect(playerCalls[2].prompt).toContain('Review the latest commit');
    expect(runtime._getActor()?.getSnapshot().status).toBe('done');
  });

  it('drives a Reviewer-cleared flow exercising Committer composite CODE-19 via reviewChangesSpecs', async () => {
    // Path: /start → planAndImplement → commitCoderInitial →
    //   reviewBossCommitSpecs (hasFindings) → respondToReview
    //   (changesMadeSpecs) → reviewChangesSpecs (noFindings) →
    //   commitJoint (committed, afterReview='done') → done
    const judgeReplies: Array<Record<string, unknown>> = [
      { guard: 'singleCommitReady' },
      { guard: 'committedSpecs' },
      { guard: 'hasFindings', reviews: '1. tweak X' },
      { guard: 'changesMadeSpecs' },
      { guard: 'noFindings' },
      { guard: 'committed' },
    ];
    let i = 0;
    const playerCalls: Array<{ playerId: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId) => {
        playerCalls.push({ playerId });
        return { status: 'ok', finalText: 'progress' };
      },
      callJudge: async () => JSON.stringify(judgeReplies[i++]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({ text: '/start spec-tweak', signal: sig() });

    // Per-invocation player resolution:
    //   1. CODE-1 planAndImplement → Coder      → 'coder'
    //   2. CODE-18 commitCoderInitial → Committer(coderPlayer) → 'coder'
    //   3. CODE-5 reviewBossCommitSpecs → Reviewer  → 'reviewer'
    //   4. CODE-2 respondToReview → Coder       → 'coder'
    //   5. CODE-11 reviewChangesSpecs → Reviewer → 'reviewer'
    //   6. CODE-19 commitJoint → Committer(coder+reviewer) → 'coder'
    expect(playerCalls.map((c) => c.playerId)).toEqual([
      'coder',
      'coder',
      'reviewer',
      'coder',
      'reviewer',
      'coder',
    ]);
    expect(runtime._getActor()?.getSnapshot().status).toBe('done');
  });

  it('drives a joint-commit flow exercising Committer composite CODE-19 (coder + reviewer)', async () => {
    // Path: /start → planAndImplement → commitCoderInitial →
    //   reviewBossCommitSpecs (hasFindings) → respondToReview
    //   (changesMadeSpecs) → reviewChangesSpecs (hasFindings) →
    //   respondToReview (accepted, reviewSubject='changes') →
    //   commitJoint (committed, afterReview='done') → done
    const judgeReplies: Array<Record<string, unknown>> = [
      { guard: 'singleCommitReady' },
      { guard: 'committedSpecs' },
      { guard: 'hasFindings', reviews: '1. tweak X' },
      { guard: 'changesMadeSpecs' },
      { guard: 'hasFindings', reviews: '1. one more tweak' },
      { guard: 'accepted' },
      { guard: 'committed' },
    ];
    let i = 0;
    const playerCalls: Array<{ playerId: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId) => {
        playerCalls.push({ playerId });
        return { status: 'ok', finalText: 'progress' };
      },
      callJudge: async () => JSON.stringify(judgeReplies[i++]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({ text: '/start joint', signal: sig() });

    // Step 7 is CODE-19 commitJoint with both coderPlayer and
    // reviewerPlayer set → composite resolves to 'coder'.
    expect(playerCalls.map((c) => c.playerId)).toEqual([
      'coder',
      'coder',
      'reviewer',
      'coder',
      'reviewer',
      'coder',
      'coder',
    ]);
    expect(runtime._getActor()?.getSnapshot().status).toBe('done');
  });
});
