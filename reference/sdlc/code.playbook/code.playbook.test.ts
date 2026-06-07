// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { assign, createActor, setup } from 'xstate';
import { codingMachine, type CaptainInput } from './code.fsm.js';
import {
  enumerateCaptainStates,
  enumerateRootEvents,
} from './code.fsm.introspect.js';
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
  normalizeErrorCompact,
  normalizeErrorFull,
  normalizeEventForTelemetry,
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

    it('appends "Review items:" after the body when input.reviews is set', () => {
      const out = composePlayerPrompt(
        makeInput({ reviews: '1. nit\n2. blocker', prompt: 'respond' }),
      );
      expect(out).toBe('respond\n\nReview items:\n1. nit\n2. blocker');
    });

    it('appends "Rebuttals:" after the body when input.challenges is set', () => {
      const out = composePlayerPrompt(
        makeInput({ challenges: '1. nope\n2. agreed', prompt: 'adjudicate' }),
      );
      expect(out).toBe('adjudicate\n\nRebuttals:\n1. nope\n2. agreed');
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

    it('orders blocks per DR-004 §6: intent → taskDescription → body → reviews → challenges', () => {
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
        'Boss intent:\nI\n\nTask description:\nT\n\nBODY\n\nReview items:\nR\n\nRebuttals:\nC',
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

  it('recovers JSON wrapped in surrounding prose', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        'Sure — here is the outcome:\n{"guard":"foo"}\nHope that helps!',
    });
    const out = await adjudicate(
      makeInput({ result: { foo: 'desc' } }),
      'out',
      ports,
      new AbortController().signal,
    );
    expect(out.guard).toBe('foo');
  });

  it('recovers JSON from a code fence surrounded by prose', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        'My decision:\n```json\n{"guard":"foo"}\n```\nLet me know.',
    });
    const out = await adjudicate(
      makeInput({ result: { foo: 'desc' } }),
      'out',
      ports,
      new AbortController().signal,
    );
    expect(out.guard).toBe('foo');
  });

  it('tolerates a trailing comma before a closing brace', async () => {
    const ports = makeFakePorts({
      callJudge: async () => '{"guard":"foo","taskDescription":"do it",}',
    });
    const out = await adjudicate(
      makeInput({
        result: { foo: 'Output shall include `taskDescription`: the task.' },
      }),
      'out',
      ports,
      new AbortController().signal,
    );
    expect(out.guard).toBe('foo');
    expect(out.taskDescription).toBe('do it');
  });

  it('completes a truncated object missing its closing brace', async () => {
    const ports = makeFakePorts({
      callJudge: async () => '{"guard":"foo","taskDescription":"do it"',
    });
    const out = await adjudicate(
      makeInput({
        result: { foo: 'Output shall include `taskDescription`: the task.' },
      }),
      'out',
      ports,
      new AbortController().signal,
    );
    expect(out.guard).toBe('foo');
    expect(out.taskDescription).toBe('do it');
  });

  it('completes a truncated unterminated string', async () => {
    const ports = makeFakePorts({
      callJudge: async () => '{"guard":"foo","taskDescription":"do it',
    });
    const out = await adjudicate(
      makeInput({
        result: { foo: 'Output shall include `taskDescription`: the task.' },
      }),
      'out',
      ports,
      new AbortController().signal,
    );
    expect(out.guard).toBe('foo');
    expect(out.taskDescription).toBe('do it');
  });

  it('recovers the object past a bracketed fragment in the prose', async () => {
    // The prose contains an earlier `[…]` that is not the answer; the
    // parser must not stop at it and must reach the real object.
    for (const raw of [
      'Notes [not JSON], final: {"guard":"foo"}',
      'see item [1] then {"guard":"foo"}',
      '{n/a} then {"guard":"foo"}',
    ]) {
      const ports = makeFakePorts({ callJudge: async () => raw });
      const out = await adjudicate(
        makeInput({ result: { foo: 'desc' } }),
        'out',
        ports,
        new AbortController().signal,
      );
      expect(out.guard, raw).toBe('foo');
    }
  });

  it('prefers the first object in document order over a later clean one', async () => {
    // The intended object comes first but needs repair (trailing
    // comma); a pristine decoy follows in trailing prose. Document
    // order must win so the earlier intended object is not overridden.
    const ports = makeFakePorts({
      callJudge: async () =>
        'Decision: {"guard":"foo",}\nExample shape: {"guard":"bar"}',
    });
    const out = await adjudicate(
      makeInput({ result: { foo: 'desc', bar: 'desc' } }),
      'out',
      ports,
      new AbortController().signal,
    );
    expect(out.guard).toBe('foo');
  });

  it('throws when no JSON value can be recovered', async () => {
    const ports = makeFakePorts({
      callJudge: async () => 'no json here, just words',
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
    // CODE-3 / `taskReady` declares a required `taskDescription`
    // field — a short extracted value that stays judge-extracted
    // (i.e. NOT in VERBATIM_PAYLOAD_FIELDS), so it exercises the
    // judge-validates path.
    const code3TaskReady =
      'Coder produced uncommitted changes for the next IR task (Initial Changes). Output shall include `taskDescription: <one-line description of the task just implemented>`.';

    it('throws when the chosen guard requires an extracted field the response omits', async () => {
      const ports = makeFakePorts({
        callJudge: async () => JSON.stringify({ guard: 'taskReady' }),
      });
      await expect(
        adjudicate(
          makeInput({ result: { taskReady: code3TaskReady } }),
          'out',
          ports,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/required field "taskDescription"/);
    });

    it('accepts the response when every extracted required field is present as a string', async () => {
      const ports = makeFakePorts({
        callJudge: async () =>
          JSON.stringify({
            guard: 'taskReady',
            taskDescription: 'rename foo to bar',
          }),
      });
      const out = await adjudicate(
        makeInput({ result: { taskReady: code3TaskReady } }),
        'out',
        ports,
        new AbortController().signal,
      );
      expect(out.guard).toBe('taskReady');
      expect(out.taskDescription).toBe('rename foo to bar');
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

    it('throws when an extracted required field is present but not a string', async () => {
      const ports = makeFakePorts({
        callJudge: async () =>
          JSON.stringify({ guard: 'taskReady', taskDescription: 42 }),
      });
      await expect(
        adjudicate(
          makeInput({ result: { taskReady: code3TaskReady } }),
          'out',
          ports,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/required field "taskDescription"/);
    });
  });

  describe('verbatim payload-field substitution (reviews / challenges)', () => {
    // Reviewer states whose `result` description requires `reviews`
    // (or `challenges`) get the player's verbatim `finalText.trim()`
    // injected by the runtime — the judge does not round-trip the
    // long-form prose through JSON.
    const reviewsRequired =
      'The review produced findings for Coder. Output shall include `reviews: <numbered list of findings, no duplication>`.';
    const challengesRequired =
      'Coder challenged one or more review items. Output shall include `challenges: <numbered rebuttals, one per challenged item>`.';

    it('substitutes finalText.trim() for `reviews` even when the judge omits it', async () => {
      const ports = makeFakePorts({
        callJudge: async () => JSON.stringify({ guard: 'hasFindings' }),
      });
      const finalText =
        '  1. Add missing tests.\n2. Rename function.\n3. Extract helper.  ';
      const out = await adjudicate(
        makeInput({ result: { hasFindings: reviewsRequired } }),
        finalText,
        ports,
        new AbortController().signal,
      );
      expect(out.guard).toBe('hasFindings');
      expect(out.reviews).toBe(finalText.trim());
    });

    it('overrides any judge-supplied `reviews` value with finalText.trim()', async () => {
      const ports = makeFakePorts({
        callJudge: async () =>
          JSON.stringify({
            guard: 'hasFindings',
            reviews: 'a paraphrased and truncated copy from the judge',
          }),
      });
      const finalText = '  1. Originally written reviewer prose.  ';
      const out = await adjudicate(
        makeInput({ result: { hasFindings: reviewsRequired } }),
        finalText,
        ports,
        new AbortController().signal,
      );
      expect(out.reviews).toBe(finalText.trim());
    });

    it('substitutes finalText.trim() for `challenges` even when the judge omits it', async () => {
      const ports = makeFakePorts({
        callJudge: async () =>
          JSON.stringify({ guard: 'challengesRaised' }),
      });
      const finalText = '  1. Counter-evidence A.\n2. Counter-evidence B.  ';
      const out = await adjudicate(
        makeInput({ result: { challengesRaised: challengesRequired } }),
        finalText,
        ports,
        new AbortController().signal,
      );
      expect(out.guard).toBe('challengesRaised');
      expect(out.challenges).toBe(finalText.trim());
    });

    it('judge prompt instructs against round-tripping reviews / challenges', async () => {
      let prompt = '';
      const ports = makeFakePorts({
        callJudge: async (p) => {
          prompt = p;
          return JSON.stringify({ guard: 'hasFindings' });
        },
      });
      await adjudicate(
        makeInput({ result: { hasFindings: reviewsRequired } }),
        'output',
        ports,
        new AbortController().signal,
      );
      expect(prompt).toContain('`reviews`');
      expect(prompt).toContain('`challenges`');
      expect(prompt).toMatch(/runtime[^\n]*verbatim/i);
    });
  });
});

describe('error normalization at emission boundaries', () => {
  describe('normalizeErrorCompact', () => {
    it('returns undefined for nullish input', () => {
      expect(normalizeErrorCompact(undefined)).toBeUndefined();
      expect(normalizeErrorCompact(null)).toBeUndefined();
    });

    it('extracts { name, message } from an Error instance, dropping stack', () => {
      const err = new TypeError('boom');
      const out = normalizeErrorCompact(err);
      expect(out).toEqual({ name: 'TypeError', message: 'boom' });
      expect(out as Record<string, unknown>).not.toHaveProperty('stack');
    });

    it('extracts { name, message } from an error-shaped plain object', () => {
      expect(
        normalizeErrorCompact({ name: 'CustomErr', message: 'msg', stack: 's' }),
      ).toEqual({ name: 'CustomErr', message: 'msg' });
    });

    it('defaults name to "Error" when missing on an object with message', () => {
      expect(normalizeErrorCompact({ message: 'msg' })).toEqual({
        name: 'Error',
        message: 'msg',
      });
    });

    it('falls back to String(err) for non-Error, non-shaped values', () => {
      expect(normalizeErrorCompact('plain string')).toEqual({
        name: 'Error',
        message: 'plain string',
      });
      expect(normalizeErrorCompact(42)).toEqual({ name: 'Error', message: '42' });
    });
  });

  describe('normalizeErrorFull', () => {
    it('returns undefined for nullish input', () => {
      expect(normalizeErrorFull(undefined)).toBeUndefined();
      expect(normalizeErrorFull(null)).toBeUndefined();
    });

    it('includes stack from an Error instance', () => {
      const err = new Error('boom');
      const out = normalizeErrorFull(err);
      expect(out?.name).toBe('Error');
      expect(out?.message).toBe('boom');
      expect(typeof out?.stack).toBe('string');
    });

    it('includes stack from an error-shaped plain object when present', () => {
      const out = normalizeErrorFull({
        name: 'CustomErr',
        message: 'msg',
        stack: 'fake-stack',
      });
      expect(out).toEqual({
        name: 'CustomErr',
        message: 'msg',
        stack: 'fake-stack',
      });
    });

    it('omits stack when source does not carry one', () => {
      expect(normalizeErrorFull({ message: 'msg' })).toEqual({
        name: 'Error',
        message: 'msg',
      });
    });
  });

  describe('normalizeEventForTelemetry', () => {
    it('passes through events that carry no error field', () => {
      const event = { type: 'xstate.snapshot', value: 'ready' };
      expect(normalizeEventForTelemetry(event)).toBe(event);
    });

    it('replaces Error in event.error with full normalized form', () => {
      const err = new TypeError('boom');
      const event = { type: 'xstate.error.actor.captain', error: err };
      const out = normalizeEventForTelemetry(event) as {
        error: { name: string; message: string; stack?: unknown };
      };
      expect(out.error.name).toBe('TypeError');
      expect(out.error.message).toBe('boom');
      expect(typeof out.error.stack).toBe('string');
      expect(out.error).not.toBeInstanceOf(Error);
    });

    it('returns nullish primitives unchanged', () => {
      expect(normalizeEventForTelemetry(undefined)).toBeUndefined();
      expect(normalizeEventForTelemetry(null)).toBeNull();
    });
  });
});

describe('classifyBossText (free-text classifier — DR-004 §3)', () => {
  const sig = () => new AbortController().signal;

  it('slash-looking text routes through callJudge and lands on START_CODING', async () => {
    let prompt = '';
    let called = false;
    const ports = makeFakePorts({
      callJudge: async (p) => {
        called = true;
        prompt = p;
        return JSON.stringify({
          event: 'START_CODING',
          payload: { intent: 'fix the bug' },
        });
      },
    });
    expect(
      await classifyBossText('/start fix the bug', ports, sig()),
    ).toEqual({ type: 'START_CODING', intent: 'fix the bug' });
    expect(called).toBe(true);
    expect(prompt).toContain('/start fix the bug');
  });

  it('free-form text routes through callJudge and lands on CONTINUE_IR', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        JSON.stringify({
          event: 'CONTINUE_IR',
          payload: { irNumber: '4' },
        }),
    });
    expect(
      await classifyBossText('continue IR 4', ports, sig()),
    ).toEqual({ type: 'CONTINUE_IR', irNumber: '4' });
  });

  it('classifier reply wrapped in prose with a trailing comma still classifies', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        'Classification:\n```json\n{"event":"CONTINUE_IR",' +
        '"payload":{"irNumber":"4",}}\n```\nDone.',
    });
    expect(
      await classifyBossText('continue IR 4', ports, sig()),
    ).toEqual({ type: 'CONTINUE_IR', irNumber: '4' });
  });

  it('free-form text routes through callJudge and lands on SUMMARIZE_IR', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        JSON.stringify({
          event: 'SUMMARIZE_IR',
          payload: { irNumber: '7' },
        }),
    });
    expect(
      await classifyBossText('summarize IR 7', ports, sig()),
    ).toEqual({ type: 'SUMMARIZE_IR', irNumber: '7' });
  });

  it('free-form text routes through callJudge and lands on BOSS_INTERRUPT', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        JSON.stringify({
          event: 'BOSS_INTERRUPT',
          payload: { targetId: 'ready' },
        }),
    });
    expect(
      await classifyBossText('pause and return to ready', ports, sig()),
    ).toEqual({ type: 'BOSS_INTERRUPT', targetId: 'ready' });
  });

  it('BOSS_INTERRUPT attaches optional intent from classifier payload', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        JSON.stringify({
          event: 'BOSS_INTERRUPT',
          payload: {
            targetId: 'planAndImplement',
            intent: 'fix the bug',
          },
        }),
    });
    expect(
      await classifyBossText(
        'switch to implementing the fix',
        ports,
        sig(),
      ),
    ).toEqual({
      type: 'BOSS_INTERRUPT',
      targetId: 'planAndImplement',
      intent: 'fix the bug',
    });
  });

  it('classifier no-action reply returns undefined', async () => {
    const ports = makeFakePorts({
      callJudge: async () =>
        JSON.stringify({ event: 'NO_ACTION', payload: {} }),
    });
    expect(
      await classifyBossText('/bogus rest', ports, sig()),
    ).toBeUndefined();
  });

  it('invalid BOSS_INTERRUPT target emits status and returns undefined', async () => {
    const statuses: string[] = [];
    const ports = makeFakePorts({
      callJudge: async () =>
        JSON.stringify({
          event: 'BOSS_INTERRUPT',
          payload: { targetId: 'notAState' },
        }),
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    expect(
      await classifyBossText('jump to notAState', ports, sig()),
    ).toBeUndefined();
    expect(statuses[0]).toContain('notAState');
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

  it('fixed prompt names all Boss event types plus no-action', async () => {
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
    expect(prompt).toContain('BOSS_REPLY');
    expect(prompt).toContain('NO_ACTION');
    expect(prompt).toContain('targetId must be one of these jumpable states');
    for (const target of enumerateRootEvents(codingMachine)
      .bossInterruptTargetDescriptions) {
      expect(prompt).toContain(`${target.stateId}: ${target.description}`);
    }
  });

  it('unknown event type from classifier → emitStatus + undefined', async () => {
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

describe('classifyBossText (awaitBossReply branch — DR-005 §6)', () => {
  const sig = () => new AbortController().signal;

  it('plain text in awaitBossReply uses the state-aware classifier to become BOSS_REPLY', async () => {
    let judgeCalled = false;
    let prompt = '';
    const ports = makeFakePorts({
      callJudge: async (p) => {
        judgeCalled = true;
        prompt = p;
        return JSON.stringify({
          event: 'BOSS_REPLY',
          payload: { answer: 'Use the narrow scope.' },
        });
      },
    });

    await expect(
      classifyBossText('Use the narrow scope.', ports, sig(), 'awaitBossReply'),
    ).resolves.toEqual({
      type: 'BOSS_REPLY',
      answer: 'Use the narrow scope.',
    });
    expect(judgeCalled).toBe(true);
    expect(prompt).toContain('Current state: awaitBossReply');
  });

  it('classifier prompt includes pending Boss question when snapshot context carries it', async () => {
    let prompt = '';
    const ports = makeFakePorts({
      callJudge: async (p) => {
        prompt = p;
        return JSON.stringify({
          event: 'BOSS_REPLY',
          payload: { answer: 'Use the narrow scope.' },
        });
      },
    });

    await expect(
      classifyBossText('Use the narrow scope.', ports, sig(), {
        value: 'awaitBossReply',
        context: {
          pendingBossQuestion: {
            resumeStateId: 'planAndImplement',
            sourceItem: 'CODE-1',
            player: 'Coder',
            question: 'Which scope should I use?',
          },
        },
      }),
    ).resolves.toEqual({
      type: 'BOSS_REPLY',
      answer: 'Use the narrow scope.',
    });
    expect(prompt).toContain('Pending Boss question: Which scope should I use?');
    expect(prompt).toContain('Pending resume state: planAndImplement');
  });

  it('BOSS_REPLY outside awaitBossReply emits status and returns undefined', async () => {
    const statuses: string[] = [];
    const ports = makeFakePorts({
      callJudge: async () => {
        return JSON.stringify({
          event: 'BOSS_REPLY',
          payload: { answer: 'Use the narrow scope.' },
        });
      },
      emitStatus: async (message) => {
        statuses.push(message);
      },
    });

    await expect(
      classifyBossText('Use the narrow scope.', ports, sig(), 'ready'),
    ).resolves.toBeUndefined();
    expect(statuses).toEqual([
      'Classifier returned BOSS_REPLY outside awaitBossReply',
    ]);
  });

  it('fresh directive while awaiting Boss reply can classify to another Boss event', async () => {
    const ports = makeFakePorts({
      callJudge: async () => {
        return JSON.stringify({
          event: 'CONTINUE_IR',
          payload: { irNumber: '7' },
        });
      },
    });

    await expect(
      classifyBossText(
        'Actually continue IR 7 instead.',
        ports,
        sig(),
        'awaitBossReply',
      ),
    ).resolves.toEqual({ type: 'CONTINUE_IR', irNumber: '7' });
  });
});

// The judge-reply damage kinds PBRT-33 requires the runtime to recover
// from, each a transform on a canonical JSON reply. None touches a
// value-bearing field, so the recovered object is equivalent for the
// parts the runtime reads. Shared by the adjudication (captain-bridge)
// and classification (handleBossInput) integration tests below so both
// runtime paths exercise every kind, not just a representative one.
const PBRT33_DAMAGE_KINDS: ReadonlyArray<{
  name: string;
  damage: (json: string) => string;
}> = [
  { name: 'prose-wrapped', damage: (j) => `Here is the outcome:\n${j}\nThanks.` },
  {
    name: 'code-fenced amid prose',
    damage: (j) => 'My call:\n```json\n' + j + '\n```\nDone.',
  },
  {
    name: 'prose with a bracketed fragment',
    damage: (j) => `See note [1] before the verdict: ${j}`,
  },
  { name: 'trailing-comma', damage: (j) => j.replace(/\}\s*$/, ',}') },
  { name: 'truncated unclosed object', damage: (j) => j.replace(/\}\s*$/, '') },
  {
    name: 'truncated unterminated string',
    damage: (j) => j.replace(/\}\s*$/, ',"_note":"detail that got cut o'),
  },
];

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

  function buildBridgeValidationActor(
    input: CaptainInput,
    ports: PlaybookPorts,
  ) {
    const machine = setup({
      types: {} as {
        context: { lastError?: unknown };
      },
      actors: { captain: captainBridge(ports) },
    }).createMachine({
      context: {},
      initial: 'ask',
      states: {
        ask: {
          invoke: {
            src: 'captain',
            input: () => input,
            onDone: { target: 'done' },
            onError: {
              target: 'failed',
              actions: assign({
                lastError: ({ event }) => event.error,
              }),
            },
          },
        },
        done: {},
        failed: {},
      },
    });
    return createActor(machine);
  }

  const needsBossReplyDescription =
    "The player's prose surfaces a clarifying question for Boss that the player cannot answer alone. Output shall include `question: <verbatim question text from the player's prose>`.";

  function expectLastErrorMessage(
    actor: ReturnType<typeof createActor>,
    message: string,
  ): void {
    const lastError = actor.getSnapshot().context.lastError;
    expect((lastError as Error).message).toBe(message);
  }

  it('drives a valid fake path through callPlayer + callJudge and advances the FSM', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    const judgeCalls: string[] = [];
    const judge = judgeSequence([
      { guard: 'singleCommitReady' },
      { guard: 'needsBossInput' },
    ]);

    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return {
          status: 'ok',
          finalText: 'Progress noted.',
        };
      },
      callJudge: async (prompt) => {
        judgeCalls.push(prompt);
        return judge();
      },
    });

    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'START_CODING', intent: 'add a button' });

    await settleAt(actor, ['ready', 'failed', 'done']);

    expect(actor.getSnapshot().value).toBe('ready');
    expect(playerCalls).toHaveLength(2);
    expect(playerCalls[0].playerId).toBe('coder');
    expect(playerCalls[0].prompt).toContain('add a button');
    expect(judgeCalls).toHaveLength(2);
    expect(judgeCalls[0]).toContain('needsBossReply');
    expect(judgeCalls[1]).toContain('needsBossInput');
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

  it.each(PBRT33_DAMAGE_KINDS)(
    'advances (not #failed) when the adjudication reply is $name but recoverable (PBRT-33)',
    async ({ damage }) => {
      // Same happy path as the valid run above, but every adjudicator
      // reply is damaged with this kind so recovery is exercised end to
      // end through the real captain bridge — not just at the helper.
      const clean = judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'needsBossInput' },
      ]);
      const ports = makeFakePorts({
        callPlayer: async () => ({ status: 'ok', finalText: 'Progress noted.' }),
        callJudge: async (prompt) => damage(await clean(prompt)),
      });

      const actor = buildActor(ports);
      actor.start();
      actor.send({ type: 'START_CODING', intent: 'add a button' });

      await settleAt(actor, ['ready', 'failed', 'done']);

      expect(actor.getSnapshot().value).toBe('ready');
    },
  );

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

  it('lands at #failed with the documented error when needsBossReply omits question', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'question needed' }),
      callJudge: async () => JSON.stringify({ guard: 'needsBossReply' }),
    });
    const actor = buildActor(ports);
    actor.start();
    actor.send({ type: 'START_CODING', intent: 'do' });

    await settleAt(actor, ['failed', 'ready', 'done']);

    expect(actor.getSnapshot().value).toBe('failed');
    expectLastErrorMessage(
      actor,
      "needsBossReply outcome missing 'question' field",
    );
  });

  it('lands at #failed with the documented error when needsBossReply comes from an unregistered state', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'question needed' }),
      callJudge: async () =>
        JSON.stringify({
          guard: 'needsBossReply',
          question: 'Which scope should I use?',
        }),
    });
    const actor = buildBridgeValidationActor(
      makeInput({
        sourceItem: 'CODE-X',
        result: { needsBossReply: needsBossReplyDescription },
      }),
      ports,
    );
    actor.start();

    await settleAt(actor, ['failed', 'done']);

    expect(actor.getSnapshot().value).toBe('failed');
    expectLastErrorMessage(
      actor,
      'state CODE-X declared needsBossReply but is not registered as resumable',
    );
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
      return {
        event: 'START_CODING',
        payload: { intent: arg },
      };
    }
    if (command === 'continue') {
      return {
        event: 'CONTINUE_IR',
        payload: { irNumber: arg },
      };
    }
    if (command === 'summarize') {
      return {
        event: 'SUMMARIZE_IR',
        payload: { irNumber: arg },
      };
    }
    if (command === 'interrupt') {
      const firstSpace = arg.search(/\s/);
      const targetId = firstSpace === -1 ? arg : arg.slice(0, firstSpace);
      const intent = firstSpace === -1 ? '' : arg.slice(firstSpace).trim();
      return {
        event: 'BOSS_INTERRUPT',
        payload: {
          targetId,
          ...(intent ? { intent } : {}),
        },
      };
    }
  }
  if (awaiting) {
    return {
      event: 'BOSS_REPLY',
      payload: { answer: message },
    };
  }
  return {
    event: 'START_CODING',
    payload: { intent: trimmed },
  };
}

function judgeSequence(replies: Array<Record<string, unknown>>) {
  let i = 0;
  return async (prompt = '') => {
    if (isClassifierPrompt(prompt)) {
      return JSON.stringify(classifierReplyForTestPrompt(prompt));
    }
    const reply = replies[i++];
    if (!reply) {
      throw new Error(`unexpected extra judge call #${i}`);
    }
    return JSON.stringify(reply);
  };
}

describe('handleBossInput drive-to-quiescence (Task 9)', () => {
  const FIRST_BOSS_QUESTION = 'Which scope should I use?';
  const FOLLOW_UP_BOSS_QUESTION = 'Should I update docs too?';

  it('clean run: /start drives FSM through one captain turn back to ready', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    let classifierCalls = 0;
    let adjudicatorCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'no progress — need more input' };
      },
      callJudge: async (prompt) => {
        if (isClassifierPrompt(prompt)) {
          classifierCalls++;
          return JSON.stringify(classifierReplyForTestPrompt(prompt));
        }
        adjudicatorCalls++;
        return prompt.includes('singleCommitReady')
          ? JSON.stringify({ guard: 'singleCommitReady' })
          : JSON.stringify({ guard: 'needsBossInput' });
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/start add a button', signal: sig() });

    expect(playerCalls).toHaveLength(2);
    expect(playerCalls[0].playerId).toBe('coder');
    expect(playerCalls[0].prompt).toContain('add a button');
    expect(classifierCalls).toBe(1);
    expect(adjudicatorCalls).toBe(2);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it.each(PBRT33_DAMAGE_KINDS)(
    'recovers a $name classifier reply and drives the FSM (PBRT-33)',
    async ({ damage }) => {
      const statuses: string[] = [];
      const cleanClassifier = JSON.stringify({
        event: 'START_CODING',
        payload: { intent: 'add a button' },
      });
      const ports = makeFakePorts({
        callPlayer: async () => ({
          status: 'ok',
          finalText: 'no progress — need more input',
        }),
        callJudge: async (prompt) => {
          if (isClassifierPrompt(prompt)) return damage(cleanClassifier);
          return prompt.includes('singleCommitReady')
            ? JSON.stringify({ guard: 'singleCommitReady' })
            : JSON.stringify({ guard: 'needsBossInput' });
        },
        emitStatus: async (m) => {
          statuses.push(m);
        },
      });
      const runtime = makeRuntimeWithInternals();
      await runtime.init(ports);

      await runtime.handleBossInput({ text: 'please add a button', signal: sig() });

      expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
      expect(statuses).toContain('START_CODING');
    },
  );

  it('classifier reply with no recoverable JSON: one status, no event, FSM unmoved (PBRT-7)', async () => {
    const statuses: string[] = [];
    let playerCalled = false;
    const ports = makeFakePorts({
      callPlayer: async () => {
        playerCalled = true;
        return { status: 'ok', finalText: 'x' };
      },
      callJudge: async () => 'no json here, just prose',
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    const before = runtime._getActor()?.getSnapshot().value;

    await expect(
      runtime.handleBossInput({ text: 'do something', signal: sig() }),
    ).resolves.toBeUndefined();

    expect(statuses).toHaveLength(1);
    expect(playerCalled).toBe(false);
    expect(runtime._getActor()?.getSnapshot().value).toBe(before);
  });

  it('returns when a player question lands at awaitBossReply', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({
        status: 'ok',
        finalText: 'I need Boss to choose the scope.',
      }),
      callJudge: judgeSequence([
        { guard: 'needsBossReply', question: FIRST_BOSS_QUESTION },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: '/start ambiguous task',
      signal: sig(),
    });

    const snap = runtime._getActor()?.getSnapshot();
    expect(snap?.value).toBe('awaitBossReply');
    expect(
      (snap?.context as { pendingBossQuestion?: unknown })
        .pendingBossQuestion,
    ).toEqual({
      resumeStateId: 'planAndImplement',
      sourceItem: 'CODE-1',
      player: 'Coder',
      question: FIRST_BOSS_QUESTION,
    });
  });

  it('slash abandon from awaitBossReply clears pending Boss-reply context', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({
        status: 'ok',
        finalText: 'I need Boss to choose the scope.',
      }),
      callJudge: judgeSequence([
        { guard: 'needsBossReply', question: FIRST_BOSS_QUESTION },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({
      text: '/start ambiguous task',
      signal: sig(),
    });
    expect(runtime._getActor()?.getSnapshot().value).toBe('awaitBossReply');

    await runtime.handleBossInput({
      text: '/interrupt ready',
      signal: sig(),
    });

    const snap = runtime._getActor()?.getSnapshot();
    expect(snap?.value).toBe('ready');
    expect(
      (snap?.context as { pendingBossQuestion?: unknown })
        .pendingBossQuestion,
    ).toBeUndefined();
    expect((snap?.context as { bossReply?: unknown }).bossReply).toBeUndefined();
  });

  it('follow-up needsBossReply overwrites the question and clears the prior reply', async () => {
    const playerPrompts: string[] = [];
    const ports = makeFakePorts({
      callPlayer: async (_playerId, prompt) => {
        playerPrompts.push(prompt);
        return { status: 'ok', finalText: 'I still need Boss.' };
      },
      callJudge: judgeSequence([
        { guard: 'needsBossReply', question: FIRST_BOSS_QUESTION },
        { guard: 'needsBossReply', question: FOLLOW_UP_BOSS_QUESTION },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: '/start ambiguous task',
      signal: sig(),
    });
    await runtime.handleBossInput({
      text: 'Use the narrow scope.',
      signal: sig(),
    });

    const snap = runtime._getActor()?.getSnapshot();
    expect(snap?.value).toBe('awaitBossReply');
    expect(
      (snap?.context as { pendingBossQuestion?: unknown })
        .pendingBossQuestion,
    ).toEqual({
      resumeStateId: 'planAndImplement',
      sourceItem: 'CODE-1',
      player: 'Coder',
      question: FOLLOW_UP_BOSS_QUESTION,
    });
    expect((snap?.context as { bossReply?: unknown }).bossReply).toBeUndefined();
    expect(playerPrompts[1]).toContain(
      `Boss question:\n${FIRST_BOSS_QUESTION}`,
    );
    expect(playerPrompts[1]).toContain('Boss reply:\nUse the narrow scope.');
  });

  it('signal-abort mid-callPlayer lands at #failed with lastError captured', async () => {
    const controller = new AbortController();
    let classifierCalls = 0;
    let adjudicatorCalls = 0;
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
      callJudge: async (prompt) => {
        if (isClassifierPrompt(prompt)) {
          classifierCalls++;
          return JSON.stringify(classifierReplyForTestPrompt(prompt));
        }
        adjudicatorCalls++;
        return JSON.stringify({ guard: 'singleCommitReady' });
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
    expect(classifierCalls).toBe(1);
    expect(adjudicatorCalls).toBe(0); // callPlayer aborted; adjudication never reached
  });

  it('classifier BOSS_INTERRUPT redirects the FSM to the target state', async () => {
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'needsBossInput' },
      ]),
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

  it('classifier BOSS_INTERRUPT payload carries intent into the target state', async () => {
    // planAndImplement (CODE-1) wires `context.intent` into the
    // captain prompt, so the trailing text shows up downstream.
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'need input' };
      },
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'needsBossInput' },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: '/interrupt planAndImplement add a sparkly button',
      signal: sig(),
    });

    expect(playerCalls).toHaveLength(2);
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

  it('classifier no-action returns without sending anything', async () => {
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
        return JSON.stringify({ event: 'NO_ACTION', payload: {} });
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/bogus stuff', signal: sig() });

    expect(playerCalls).toBe(0);
    expect(judgeCalls).toBe(1);
    // PBRT-3: ready entry is suppressed (the next `boss>` prompt is
    // the implicit "turn over" signal); no-action classifier also
    // produces no classification line. Status stream stays empty.
    expect(statuses).toEqual([]);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('known slash-looking forms are ordinary text and obey classifier no-action', async () => {
    for (const text of [
      '/start fix the bug',
      '/continue 7',
      '/summarize 8',
      '/interrupt failed',
    ]) {
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
        callJudge: async (prompt) => {
          expect(isClassifierPrompt(prompt)).toBe(true);
          expect(prompt).toContain(text);
          judgeCalls++;
          return JSON.stringify({ event: 'NO_ACTION', payload: {} });
        },
      });
      const runtime = makeRuntimeWithInternals();
      await runtime.init(ports);

      await runtime.handleBossInput({ text, signal: sig() });

      expect(playerCalls, text).toBe(0);
      expect(judgeCalls, text).toBe(1);
      expect(statuses, text).toEqual([]);
      expect(runtime._getActor()?.getSnapshot().value, text).toBe('ready');
    }
  });

  it('classifier CONTINUE_IR drives the FSM through continueIr back to ready', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'need more input' };
      },
      callJudge: judgeSequence([
        { guard: 'taskReady', taskDescription: 'continue IR-7' },
        { guard: 'needsBossInput' },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/continue 7', signal: sig() });

    expect(playerCalls).toHaveLength(2);
    expect(playerCalls[0].playerId).toBe('coder');
    expect(playerCalls[0].prompt).toContain('IR-7');
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('classifier SUMMARIZE_IR drives the FSM through summarizeSpecs back to ready', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'need more input' };
      },
      callJudge: judgeSequence([
        { guard: 'specsReady' },
        { guard: 'needsBossInput' },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/summarize 8', signal: sig() });

    expect(playerCalls).toHaveLength(2);
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
        return prompt.includes('singleCommitReady')
          ? JSON.stringify({ guard: 'singleCommitReady' })
          : JSON.stringify({ guard: 'needsBossInput' });
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

  it('classifier BOSS_INTERRUPT without a target state surfaces status and takes no FSM action', async () => {
    const statuses: string[] = [];
    let playerCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok', finalText: '' };
      },
      callJudge: async () =>
        JSON.stringify({ event: 'BOSS_INTERRUPT', payload: {} }),
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({ text: '/interrupt', signal: sig() });

    expect(
      statuses.some((m) => m.includes('targetId')),
    ).toBe(true);
    expect(playerCalls).toBe(0);
    expect(runtime._getActor()?.getSnapshot().value).toBe('ready');
  });

  it('classifier BOSS_INTERRUPT with an invalid target state surfaces status and takes no FSM action', async () => {
    const statuses: string[] = [];
    let playerCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok', finalText: '' };
      },
      callJudge: async () =>
        JSON.stringify({
          event: 'BOSS_INTERRUPT',
          payload: { targetId: 'notAState' },
        }),
      emitStatus: async (m) => {
        statuses.push(m);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: 'Jump to notAState.',
      signal: sig(),
    });

    expect(
      statuses.some((m) => m.includes('notAState')),
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

  it('awaitBossReply BOSS_REPLY resumes through the classifier and clears reply context', async () => {
    const classifierPrompts: string[] = [];
    const playerPrompts: string[] = [];
    const adjudicatorReplies: Array<Record<string, unknown>> = [
      { guard: 'needsBossReply', question: FIRST_BOSS_QUESTION },
      { guard: 'singleCommitReady' },
      { guard: 'needsBossInput' },
    ];
    let adjudicatorIndex = 0;
    const ports = makeFakePorts({
      callPlayer: async (_playerId, prompt) => {
        playerPrompts.push(prompt);
        return { status: 'ok', finalText: 'progress' };
      },
      callJudge: async (prompt) => {
        if (isClassifierPrompt(prompt)) {
          classifierPrompts.push(prompt);
          if (classifierPrompts.length === 1) {
            return JSON.stringify({
              event: 'START_CODING',
              payload: { intent: 'ambiguous task' },
            });
          }
          return JSON.stringify({
            event: 'BOSS_REPLY',
            payload: { answer: '/continue 9' },
          });
        }
        return JSON.stringify(adjudicatorReplies[adjudicatorIndex++]);
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: 'Please do the ambiguous task.',
      signal: sig(),
    });
    expect(runtime._getActor()?.getSnapshot().value).toBe('awaitBossReply');

    await runtime.handleBossInput({
      text: '/continue 9',
      signal: sig(),
    });

    const snap = runtime._getActor()?.getSnapshot();
    expect(classifierPrompts).toHaveLength(2);
    expect(classifierPrompts[1]).toContain('Current state: awaitBossReply');
    expect(classifierPrompts[1]).toContain(
      `Pending Boss question: ${FIRST_BOSS_QUESTION}`,
    );
    expect(playerPrompts[1]).toContain(
      `Boss question:\n${FIRST_BOSS_QUESTION}`,
    );
    expect(playerPrompts[1]).toContain('Boss reply:\n/continue 9');
    expect(snap?.value).toBe('ready');
    expect(
      (snap?.context as { pendingBossQuestion?: unknown })
        .pendingBossQuestion,
    ).toBeUndefined();
    expect(
      (snap?.context as { bossReply?: unknown }).bossReply,
    ).toBeUndefined();
  });

  it('awaitBossReply fresh directive abandons the question and clears reply context', async () => {
    const classifierPrompts: string[] = [];
    const ports = makeFakePorts({
      callPlayer: async () => ({
        status: 'ok',
        finalText: 'I need Boss to choose the scope.',
      }),
      callJudge: async (prompt) => {
        if (isClassifierPrompt(prompt)) {
          classifierPrompts.push(prompt);
          if (classifierPrompts.length === 1) {
            return JSON.stringify({
              event: 'START_CODING',
              payload: { intent: 'ambiguous task' },
            });
          }
          return JSON.stringify({
            event: 'BOSS_INTERRUPT',
            payload: { targetId: 'ready' },
          });
        }
        return JSON.stringify({
          guard: 'needsBossReply',
          question: FIRST_BOSS_QUESTION,
        });
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: 'Please do the ambiguous task.',
      signal: sig(),
    });
    expect(runtime._getActor()?.getSnapshot().value).toBe('awaitBossReply');

    await runtime.handleBossInput({
      text: 'Actually stop and go back to ready.',
      signal: sig(),
    });

    const snap = runtime._getActor()?.getSnapshot();
    expect(classifierPrompts).toHaveLength(2);
    expect(classifierPrompts[1]).toContain('Current state: awaitBossReply');
    expect(snap?.value).toBe('ready');
    expect(
      (snap?.context as { pendingBossQuestion?: unknown })
        .pendingBossQuestion,
    ).toBeUndefined();
    expect((snap?.context as { bossReply?: unknown }).bossReply).toBeUndefined();
  });

  it('awaitBossReply invalid classifier reply emits status and leaves the pending question in place', async () => {
    const statuses: string[] = [];
    const ports = makeFakePorts({
      emitStatus: async (m) => {
        statuses.push(m);
      },
      callPlayer: async () => ({
        status: 'ok',
        finalText: 'I need Boss to choose the scope.',
      }),
      callJudge: (() => {
        let classifierCount = 0;
        return async (prompt) => {
          if (isClassifierPrompt(prompt)) {
            classifierCount++;
            if (classifierCount === 1) {
              return JSON.stringify({
                event: 'START_CODING',
                payload: { intent: 'ambiguous task' },
              });
            }
            return JSON.stringify({ event: 'BOGUS', payload: {} });
          }
          return JSON.stringify({
            guard: 'needsBossReply',
            question: FIRST_BOSS_QUESTION,
          });
        };
      })(),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: 'Please do the ambiguous task.',
      signal: sig(),
    });
    await runtime.handleBossInput({
      text: 'not enough information',
      signal: sig(),
    });

    const snap = runtime._getActor()?.getSnapshot();
    expect(statuses.some((m) => m.includes('BOGUS'))).toBe(true);
    expect(snap?.value).toBe('awaitBossReply');
    expect(
      (snap?.context as { pendingBossQuestion?: { question?: string } })
        .pendingBossQuestion?.question,
    ).toBe(FIRST_BOSS_QUESTION);
  });

  it('awaitBossReply empty input takes no action and makes no extra port calls', async () => {
    let judgeCalls = 0;
    let playerCalls = 0;
    const ports = makeFakePorts({
      callPlayer: async () => {
        playerCalls++;
        return {
          status: 'ok',
          finalText: 'I need Boss to choose the scope.',
        };
      },
      callJudge: async (prompt) => {
        judgeCalls++;
        if (isClassifierPrompt(prompt)) {
          return JSON.stringify({
            event: 'START_CODING',
            payload: { intent: 'ambiguous task' },
          });
        }
        return JSON.stringify({
          guard: 'needsBossReply',
          question: FIRST_BOSS_QUESTION,
        });
      },
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: 'Please do the ambiguous task.',
      signal: sig(),
    });
    expect(runtime._getActor()?.getSnapshot().value).toBe('awaitBossReply');
    const judgeCallsBeforeEmpty = judgeCalls;
    const playerCallsBeforeEmpty = playerCalls;

    await runtime.handleBossInput({ text: ' \n\t ', signal: sig() });

    expect(judgeCalls).toBe(judgeCallsBeforeEmpty);
    expect(playerCalls).toBe(playerCallsBeforeEmpty);
    expect(runtime._getActor()?.getSnapshot().value).toBe('awaitBossReply');
  });

  it('turn arriving after the FSM reaches done disposes and reconstructs the actor', async () => {
    let classifierInvocation = 0;
    let guardInvocation = 0;
    const ports = makeFakePorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'x' }),
      callJudge: async (prompt) => {
        if (isClassifierPrompt(prompt)) {
          classifierInvocation++;
          return JSON.stringify(classifierReplyForTestPrompt(prompt));
        }
        guardInvocation++;
        if (guardInvocation === 1) {
          return JSON.stringify({ guard: 'noSpecChanges' });
        }
        if (guardInvocation === 2) {
          return JSON.stringify({ guard: 'singleCommitReady' });
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

    expect(classifierInvocation).toBe(2);
    expect(guardInvocation).toBe(3);
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

  it('emits no status line on initial entry to ready (PBRT-3)', async () => {
    const { ports, statuses } = makeRecordingPorts();
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    // The boss readline returning is the implicit "ready" signal;
    // a `◆ ready` tombstone is suppressed per PBRT-3.
    expect(statuses).toEqual([]);
  });

  it('emits telemetry on every transition with topic playbook.fsm.state', async () => {
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'needsBossInput' },
      ]),
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
    //   planAndImplement → commitCoderInitial
    //   commitCoderInitial → ready
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
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'needsBossInput' },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({
      text: '/start fix',
      signal: sig(),
    });
    const messages = statuses.map((s) => s.message);
    // The Coder state on the /start happy path surfaces as
    // `⤷ <Player>: <label>` with no CODE-N tag and no rider
    // (PBRT-3).
    expect(messages).toContain('⤷ Coder: plan & implement');
    // ready (initial + return) is suppressed — no `◆ ready` line.
    expect(messages.filter((m) => m.startsWith('◆ ready'))).toEqual([]);
    // Classification line is the bare FSM event type (no glyph, no
    // verbatim Boss-text echo).
    expect(messages).toContain('START_CODING');
  });

  it('awaitBossReply entry emits the full-question speech line, the rider-less marker, and full-question telemetry', async () => {
    const question =
      'Which scope should I use?\nPlease answer with the exact package boundary.';
    const { ports, statuses, telemetry } = makeRecordingPorts({
      callPlayer: async () => ({
        status: 'ok',
        finalText: 'I need Boss to choose the scope.',
      }),
      callJudge: judgeSequence([{ guard: 'needsBossReply', question }]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);

    await runtime.handleBossInput({
      text: '/start ambiguous task',
      signal: sig(),
    });

    const messages = statuses.map((s) => s.message);
    // PBRT-3/14: the full question rides a captain-speech line
    // attributed to the asking player — verbatim and untruncated.
    expect(messages).toContain(`Coder asks: ${question}`);
    // The marker carries only routing metadata; the old
    // `q="<first 80 chars>"` rider is dropped.
    const marker = '◆ awaiting Boss reply · planAndImplement · Coder · CODE-1';
    expect(messages).toContain(marker);
    expect(messages.some((m) => m.includes('q='))).toBe(false);
    // The question-speech line precedes the marker line.
    const questionIdx = messages.indexOf(`Coder asks: ${question}`);
    const markerIdx = messages.indexOf(marker);
    expect(questionIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(questionIdx);
    // Telemetry still carries the full question verbatim.
    const awaitTelemetry = telemetry.find(
      (t) => (t.payload as { to?: string }).to === 'awaitBossReply',
    );
    expect(awaitTelemetry).toBeDefined();
    expect(
      (awaitTelemetry?.payload as {
        pendingBossQuestion?: { question?: string };
      }).pendingBossQuestion?.question,
    ).toBe(question);
  });

  it('emitStatus on entry to failed includes normalized compact lastError in data', async () => {
    const controller = new AbortController();
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async (_id, _p, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 'aborted', error: 'host signal' };
      },
      callJudge: judgeSequence([]),
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
    // Status data carries the compact `{ name, message }` shape so
    // the Captain pane renders legibly and never leaks a raw Error
    // instance (with non-serializable fields like `stack`) into the
    // status channel.
    const data = failedStatus?.data as {
      lastError?: { name?: unknown; message?: unknown; stack?: unknown };
    };
    expect(typeof data.lastError?.name).toBe('string');
    expect(typeof data.lastError?.message).toBe('string');
    expect((data.lastError as Record<string, unknown>).stack).toBeUndefined();
  });

  it('failed-state telemetry carries full normalized error in event.error and lastError', async () => {
    const controller = new AbortController();
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async (_id, _p, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 'aborted', error: 'host signal' };
      },
      callJudge: judgeSequence([]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    setTimeout(() => controller.abort(), 5);
    await runtime.handleBossInput({
      text: '/start x',
      signal: controller.signal,
    });
    const failedTelemetry = telemetry.find(
      (t) => (t.payload as { to?: string }).to === 'failed',
    );
    expect(failedTelemetry).toBeDefined();
    const payload = failedTelemetry?.payload as {
      lastError?: { name?: unknown; message?: unknown; stack?: unknown };
      event?: { error?: { name?: unknown; message?: unknown; stack?: unknown } };
    };
    // Telemetry carries the full `{ name, message, stack }` shape on
    // both `lastError` (context-level snapshot) and `event.error`
    // (failed-transition cause), so observers can debug fail-stop
    // paths without losing the original stack.
    expect(typeof payload.lastError?.name).toBe('string');
    expect(typeof payload.lastError?.message).toBe('string');
    expect(typeof payload.lastError?.stack).toBe('string');
    expect(typeof payload.event?.error?.name).toBe('string');
    expect(typeof payload.event?.error?.message).toBe('string');
    // event.error is normalized too — never a bare Error instance.
    expect(payload.event?.error).not.toBeInstanceOf(Error);
  });

  it('non-failed telemetry payloads preserve their event shape (no spurious error key)', async () => {
    const { ports, telemetry } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'needsBossInput' },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({ text: '/start x', signal: sig() });
    for (const t of telemetry) {
      const payload = t.payload as {
        to: string;
        event: Record<string, unknown>;
        lastError?: unknown;
      };
      if (payload.to !== 'failed') {
        expect('lastError' in payload).toBe(false);
      }
      // Plain xstate events never carry an `error` field; the
      // normalizer leaves them untouched.
      expect('error' in payload.event).toBe(false);
    }
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
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'needsBossInput' },
      ]),
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
    // Telemetry emitted first per transition; the initial `ready`
    // entry no longer emits a status line per PBRT-3, so the first
    // status entry corresponds to the Boss-turn classification.
    expect(ordered[0]).toBe('t:ready');
    expect(ordered.filter((e) => e.startsWith('s:◆ ready'))).toEqual([]);
    expect(ordered).toContain('s:START_CODING');
  });

  it('STATE_LABELS covers every captain-invoking state in the FSM', () => {
    // Compare against the canonical FSM enumeration rather than
    // stateMetadata: the metadata builder skips/throws on missing
    // labels, so iterating its keys would never catch a captain
    // state that has no label entry. PBRT-3's widening to "every
    // captain-invoking state" is what we're enforcing here.
    const fsmStates = enumerateCaptainStates(codingMachine);
    for (const s of fsmStates) {
      expect(
        _internal.STATE_LABELS[s.stateId],
        `${s.stateId} missing from STATE_LABELS`,
      ).toBeDefined();
    }
  });

  it('transition guard line precedes state entry with payload tallies', async () => {
    // Per the verbatim-payload contract, `reviews` is filled by the
    // runtime from the player's verbatim `finalText.trim()` — not
    // by the judge JSON. The Reviewer-state call therefore needs
    // its `finalText` to carry the numbered list whose tally we
    // assert on the transition line; the other player calls keep
    // their unrelated `finalText` so we don't perturb other tests.
    const finalTextByGuard: Record<string, string> = {
      singleCommitReady: 'done',
      committedSpecs: 'done',
      hasFindings: '1. tweak\n2. another',
      accepted: 'done',
    };
    let nextGuard = 'singleCommitReady';
    const guardOrder = [
      'singleCommitReady',
      'committedSpecs',
      'hasFindings',
      'accepted',
    ];
    let guardIndex = 0;
    const { ports, statuses } = makeRecordingPorts({
      // Drive: /start → planAndImplement → singleCommitReady →
      //   commitCoderInitial → committedSpecs →
      //   reviewBossCommitSpecs → hasFindings (with 2 reviews) →
      //   respondToReview → accepted → done
      callPlayer: async () => {
        nextGuard = guardOrder[guardIndex] ?? 'accepted';
        return { status: 'ok', finalText: finalTextByGuard[nextGuard] };
      },
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'committedSpecs' },
        { guard: 'hasFindings' },
        { guard: 'accepted' },
      ]),
    });
    // Increment after the judge runs so the next callPlayer picks
    // the right finalText for its state.
    const origJudge = ports.callJudge;
    ports.callJudge = async (prompt, signal) => {
      const result = await origJudge(prompt, signal);
      if (!isClassifierPrompt(prompt)) guardIndex++;
      return result;
    };
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({ text: '/start x', signal: sig() });
    const messages = statuses.map((s) => s.message);
    // The hasFindings transition carries `· reviews=2` as a tally
    // suffix; no leading whitespace (visual nesting is the host
    // presenter's concern per PBRT-3).
    expect(messages).toContain('→ hasFindings · reviews=2');
  });

  it('state entry carries only Player + label (no CODE-N, no rider)', async () => {
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'needsBossInput' },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({
      text: '/start add a settings toggle',
      signal: sig(),
    });
    const messages = statuses.map((s) => s.message);
    // Exact form per PBRT-3: ⤷ <Player>: <label>; no `CODE-N`, no
    // `intent="…"` suffix (the Boss readline already carries the
    // verbatim intent).
    expect(messages).toContain('⤷ Coder: plan & implement');
    expect(messages.some((m) => m.includes('CODE-1'))).toBe(false);
    expect(messages.some((m) => m.includes('intent='))).toBe(false);
  });

  it('classification line is the bare FSM event type (no Boss-text echo)', async () => {
    const { ports, statuses } = makeRecordingPorts({
      callPlayer: async () => ({ status: 'ok', finalText: 'no progress' }),
      callJudge: judgeSequence([
        { guard: 'taskReady', taskDescription: 'continue IR-7' },
        { guard: 'needsBossInput' },
      ]),
    });
    const runtime = makeRuntimeWithInternals();
    await runtime.init(ports);
    await runtime.handleBossInput({ text: '/continue 7', signal: sig() });
    const messages = statuses.map((s) => s.message);
    // Just the event type; no glyph, no verbatim Boss text.
    expect(messages).toContain('CONTINUE_IR');
    expect(messages.some((m) => m.includes('/continue 7'))).toBe(false);
    expect(messages.some((m) => m.startsWith('▸ '))).toBe(false);
  });
});

describe('Multi-stage Boss turn (DR-004 §7 + §9)', () => {
  it('full /start single-commit flow exercises coder, committer (CODE-18), and reviewer routing in one turn', async () => {
    const playerCalls: Array<{ playerId: string; prompt: string }> = [];
    // Per-state judge replies, in transition order:
    //   1. planAndImplement → singleCommitReady → commitCoderInitial
    //   2. commitCoderInitial → committedSpecs → reviewBossCommitSpecs
    //   3. reviewBossCommitSpecs → noFindings → done (afterReview='done')
    const ports = makeFakePorts({
      callPlayer: async (playerId, prompt) => {
        playerCalls.push({ playerId, prompt });
        return { status: 'ok', finalText: 'progress noted' };
      },
      callJudge: judgeSequence([
        { guard: 'singleCommitReady' },
        { guard: 'committedSpecs' },
        { guard: 'noFindings' },
      ]),
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
    const playerCalls: Array<{ playerId: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId) => {
        playerCalls.push({ playerId });
        return { status: 'ok', finalText: 'progress' };
      },
      callJudge: judgeSequence(judgeReplies),
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
    const playerCalls: Array<{ playerId: string }> = [];
    const ports = makeFakePorts({
      callPlayer: async (playerId) => {
        playerCalls.push({ playerId });
        return { status: 'ok', finalText: 'progress' };
      },
      callJudge: judgeSequence(judgeReplies),
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
