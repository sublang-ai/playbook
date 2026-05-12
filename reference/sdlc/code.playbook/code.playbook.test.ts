// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import type { CaptainInput } from './code.fsm.js';
import { _internal, type PlaybookPorts } from './code.playbook.js';

const { composePlayerPrompt, resolvePlayerId, adjudicate } = _internal;

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
    it('CODE-15: only coderPlayer set → "coder"', () => {
      expect(
        resolvePlayerId(
          makeInput({
            player: 'Committer',
            sourceItem: 'CODE-15',
            coderPlayer: 'claude',
          }),
        ),
      ).toBe('coder');
    });

    it('CODE-16: only reviewerPlayer set → "reviewer"', () => {
      expect(
        resolvePlayerId(
          makeInput({
            player: 'Committer',
            sourceItem: 'CODE-16',
            reviewerPlayer: 'codex',
          }),
        ),
      ).toBe('reviewer');
    });

    it('CODE-17: both fields set → "coder" (Coder is first in alias declaration)', () => {
      expect(
        resolvePlayerId(
          makeInput({
            player: 'Committer',
            sourceItem: 'CODE-17',
            coderPlayer: 'claude',
            reviewerPlayer: 'codex',
          }),
        ),
      ).toBe('coder');
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
