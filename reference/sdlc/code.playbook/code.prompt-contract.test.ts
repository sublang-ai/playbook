// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// IR-005 Task 5 — table-driven prompt contract.
// For each captain-invoking state, pin: (a) player binding,
// (b) sourceItem, (c) which context fields are wired into the
// CaptainInput, (d) which placeholders appear in the prompt
// body, (e) the composer substitutes every declared placeholder
// using the wired context value, and (f) labelled blocks appear
// in DR-004 §6 order.
//
// This complements `code.gears-fsm.test.ts` (which pins the
// prompt body verbatim against `code.gears.md`) by pinning the
// *structured-field plumbing* between context, the input thunk,
// and `composePlayerPrompt` — drift in field wiring would not
// show up in the gears check.

import { describe, expect, it } from 'vitest';

import { codingMachine } from './code.fsm.js';
import type { CodingContext } from './code.fsm.js';
import { enumerateCaptainStates } from './code.fsm.introspect.js';
import { _internal } from './code.playbook.js';

const { composePlayerPrompt } = _internal;

type Player = 'Coder' | 'Reviewer' | 'Committer';
type ContextField =
  | 'intent'
  | 'irNumber'
  | 'taskDescription'
  | 'reviews'
  | 'challenges'
  | 'coderPlayer'
  | 'reviewerPlayer';
type Placeholder = '<#>' | '<coder-llm>' | '<reviewer-llm>';

const CONTINUATION_PREAMBLE =
  'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';
const CONTINUATION_QUESTION = 'Which scope should I use?';
const CONTINUATION_REPLY = 'Use the narrow scope.';
const REMOVED_BOSS_QUESTION_INSTRUCTION =
  'If a specific Boss answer is needed, ask the exact question and stop.';

const ALL_FIELDS: readonly ContextField[] = [
  'intent',
  'irNumber',
  'taskDescription',
  'reviews',
  'challenges',
  'coderPlayer',
  'reviewerPlayer',
];
const ALL_PLACEHOLDERS: readonly Placeholder[] = [
  '<#>',
  '<coder-llm>',
  '<reviewer-llm>',
];

const FULL_CONTEXT: Required<{ [K in ContextField]: string }> = {
  intent: 'INTENT_VALUE',
  irNumber: 'IR42',
  taskDescription: 'TASK_DESCRIPTION_VALUE',
  reviews: 'REVIEWS_VALUE',
  challenges: 'CHALLENGES_VALUE',
  coderPlayer: 'CODER_LLM_VALUE',
  reviewerPlayer: 'REVIEWER_LLM_VALUE',
};

const PLACEHOLDER_SOURCE: Record<Placeholder, ContextField> = {
  '<#>': 'irNumber',
  '<coder-llm>': 'coderPlayer',
  '<reviewer-llm>': 'reviewerPlayer',
};

const LABEL_FOR_FIELD: Partial<Record<ContextField, string>> = {
  intent: 'Boss intent:',
  reviews: 'Review items:',
  challenges: 'Rebuttals:',
  taskDescription: 'Task description:',
};

// Order in which labelled blocks may appear in a composed prompt
// per DR-004 §6: context blocks above the prompt body, action
// blocks below it. The body itself isn't a labelled marker, so the
// list interleaves only the labels we can locate by string search.
const BLOCK_ORDER: readonly string[] = [
  'Boss intent:',
  'Task description:',
  'Review items:',
  'Rebuttals:',
];

interface Contract {
  stateId: string;
  player: Player;
  sourceItem: string;
  wiredFields: readonly ContextField[];
  placeholders: readonly Placeholder[];
}

const contracts: readonly Contract[] = [
  {
    stateId: 'planAndImplement',
    player: 'Coder',
    sourceItem: 'CODE-1',
    wiredFields: ['intent'],
    placeholders: [],
  },
  {
    stateId: 'respondToReview',
    player: 'Coder',
    sourceItem: 'CODE-2',
    wiredFields: ['reviews'],
    placeholders: [],
  },
  {
    stateId: 'continueIr',
    player: 'Coder',
    sourceItem: 'CODE-3',
    wiredFields: ['irNumber'],
    placeholders: ['<#>'],
  },
  {
    stateId: 'summarizeSpecs',
    player: 'Coder',
    sourceItem: 'CODE-4',
    wiredFields: ['irNumber'],
    placeholders: ['<#>'],
  },
  {
    stateId: 'reviewBossCommitSpecs',
    player: 'Reviewer',
    sourceItem: 'CODE-5',
    wiredFields: ['intent'],
    placeholders: [],
  },
  {
    stateId: 'reviewBossCommitCode',
    player: 'Reviewer',
    sourceItem: 'CODE-6',
    wiredFields: ['intent'],
    placeholders: [],
  },
  {
    stateId: 'reviewBossCommitMixed',
    player: 'Reviewer',
    sourceItem: 'CODE-7',
    wiredFields: ['intent'],
    placeholders: [],
  },
  {
    stateId: 'reviewIrTaskCommitSpecs',
    player: 'Reviewer',
    sourceItem: 'CODE-8',
    wiredFields: ['irNumber', 'taskDescription'],
    placeholders: [],
  },
  {
    stateId: 'reviewIrTaskCommitCode',
    player: 'Reviewer',
    sourceItem: 'CODE-9',
    wiredFields: ['irNumber', 'taskDescription'],
    placeholders: [],
  },
  {
    stateId: 'reviewIrTaskCommitMixed',
    player: 'Reviewer',
    sourceItem: 'CODE-10',
    wiredFields: ['irNumber', 'taskDescription'],
    placeholders: [],
  },
  {
    stateId: 'reviewChangesSpecs',
    player: 'Reviewer',
    sourceItem: 'CODE-11',
    wiredFields: [],
    placeholders: [],
  },
  {
    stateId: 'reviewChangesCode',
    player: 'Reviewer',
    sourceItem: 'CODE-12',
    wiredFields: [],
    placeholders: [],
  },
  {
    stateId: 'reviewChangesMixed',
    player: 'Reviewer',
    sourceItem: 'CODE-13',
    wiredFields: [],
    placeholders: [],
  },
  {
    stateId: 'adjudicateChallenges',
    player: 'Reviewer',
    sourceItem: 'CODE-14',
    wiredFields: ['reviews', 'challenges'],
    placeholders: [],
  },
  {
    stateId: 'reviewChangesAndChallengesSpecs',
    player: 'Reviewer',
    sourceItem: 'CODE-15',
    wiredFields: ['reviews', 'challenges'],
    placeholders: [],
  },
  {
    stateId: 'reviewChangesAndChallengesCode',
    player: 'Reviewer',
    sourceItem: 'CODE-16',
    wiredFields: ['reviews', 'challenges'],
    placeholders: [],
  },
  {
    stateId: 'reviewChangesAndChallengesMixed',
    player: 'Reviewer',
    sourceItem: 'CODE-17',
    wiredFields: ['reviews', 'challenges'],
    placeholders: [],
  },
  {
    stateId: 'commitCoderInitial',
    player: 'Committer',
    sourceItem: 'CODE-18',
    wiredFields: ['coderPlayer'],
    placeholders: ['<coder-llm>'],
  },
  {
    stateId: 'commitJoint',
    player: 'Committer',
    sourceItem: 'CODE-19',
    wiredFields: ['coderPlayer', 'reviewerPlayer'],
    placeholders: ['<coder-llm>', '<reviewer-llm>'],
  },
];

const stateById = new Map(
  enumerateCaptainStates(codingMachine).map((s) => [s.stateId, s] as const),
);

function inputField(
  input: ReturnType<NonNullable<ReturnType<typeof stateById.get>>['getInput']>,
  field: ContextField,
): string | undefined {
  return (input as unknown as Record<ContextField, string | undefined>)[field];
}

function continuationContext(
  stateId: string,
): Pick<CodingContext, 'pendingBossQuestion' | 'bossReply'> {
  const state = stateById.get(stateId);
  const input = state?.getInput({});
  return {
    pendingBossQuestion: {
      questionId: stateId as never,
      resumeStateId: stateId as never,
      sourceItem: input?.sourceItem ?? 'CODE-X',
      player: (input?.player ?? 'Coder') as never,
      question: CONTINUATION_QUESTION,
    },
    bossReply: CONTINUATION_REPLY,
  };
}

function substitutedPrompt(prompt: string): string {
  return prompt
    .replaceAll('<#>', FULL_CONTEXT.irNumber)
    .replaceAll('<coder-llm>', FULL_CONTEXT.coderPlayer)
    .replaceAll('<reviewer-llm>', FULL_CONTEXT.reviewerPlayer);
}

function substitutedPromptFirstLine(prompt: string): string {
  return substitutedPrompt(prompt).split('\n')[0];
}

describe('prompt contract — per state', () => {
  for (const contract of contracts) {
    describe(`${contract.stateId} (${contract.sourceItem})`, () => {
      const state = stateById.get(contract.stateId);

      it('is enumerated as a captain-invoking state', () => {
        expect(state, contract.stateId).toBeDefined();
      });

      if (!state) return;

      it(`input.player === '${contract.player}'`, () => {
        expect(state.getInput({}).player).toBe(contract.player);
      });

      it(`input.sourceItem === '${contract.sourceItem}'`, () => {
        expect(state.getInput({}).sourceItem).toBe(contract.sourceItem);
      });

      it('wires exactly the declared context fields, no others', () => {
        const input = state.getInput(FULL_CONTEXT as Partial<CodingContext>);
        for (const f of ALL_FIELDS) {
          const expected = contract.wiredFields.includes(f)
            ? FULL_CONTEXT[f]
            : undefined;
          expect(inputField(input, f), `${contract.stateId}.${f}`).toBe(
            expected,
          );
        }
      });

      it('prompt body has exactly the declared placeholders', () => {
        const { prompt } = state.getInput({});
        for (const p of ALL_PLACEHOLDERS) {
          const expected = contract.placeholders.includes(p);
          expect(
            prompt.includes(p),
            `${contract.stateId}: ${p} ${expected ? 'expected in' : 'not expected in'} prompt`,
          ).toBe(expected);
        }
      });

      it('composer substitutes every declared placeholder with the wired context value', () => {
        const composed = composePlayerPrompt(
          state.getInput(FULL_CONTEXT as Partial<CodingContext>),
        );
        for (const p of contract.placeholders) {
          const replacement = FULL_CONTEXT[PLACEHOLDER_SOURCE[p]];
          expect(
            composed,
            `${contract.stateId}: ${p} should be substituted`,
          ).not.toContain(p);
          expect(
            composed,
            `${contract.stateId}: ${replacement} should appear (substituted from ${p})`,
          ).toContain(replacement);
        }
      });

      it('composer prepends a labelled block for each wired structured field', () => {
        const composed = composePlayerPrompt(
          state.getInput(FULL_CONTEXT as Partial<CodingContext>),
        );
        for (const f of ALL_FIELDS) {
          const label = LABEL_FOR_FIELD[f];
          if (!label) continue;
          const expected = contract.wiredFields.includes(f);
          expect(
            composed.includes(label),
            `${contract.stateId}: '${label}' ${expected ? 'expected' : 'not expected'} in composed prompt`,
          ).toBe(expected);
        }
      });

      it('composer output orders labelled blocks per DR-004 §6', () => {
        const composed = composePlayerPrompt(
          state.getInput(FULL_CONTEXT as Partial<CodingContext>),
        );
        const present = BLOCK_ORDER.map((m) => composed.indexOf(m)).filter(
          (i) => i !== -1,
        );
        expect(
          present,
          `${contract.stateId}: labelled blocks in DR-004 §6 order`,
        ).toEqual([...present].sort((a, b) => a - b));
      });
    });
  }
});

describe('prompt contract — structural', () => {
  it('every captain-invoking state has a contract row', () => {
    const enumerated = [...stateById.keys()].sort();
    const declared = [...contracts.map((c) => c.stateId)].sort();
    expect(enumerated).toEqual(declared);
  });

  it('contract count equals captain-invoking state count', () => {
    expect(contracts.length).toBe(stateById.size);
  });

  it('every state with a `<#>` / `<coder-llm>` / `<reviewer-llm>` placeholder wires its source field', () => {
    const orphans: string[] = [];
    for (const c of contracts) {
      for (const p of c.placeholders) {
        const required = PLACEHOLDER_SOURCE[p];
        if (!c.wiredFields.includes(required)) {
          orphans.push(
            `${c.stateId}: placeholder ${p} but ${required} is not wired`,
          );
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  it('no composed captain prompt carries the removed Boss-question instruction', () => {
    for (const contract of contracts) {
      const state = stateById.get(contract.stateId);
      expect(state, contract.stateId).toBeDefined();
      if (!state) continue;

      const ordinary = composePlayerPrompt(
        state.getInput(FULL_CONTEXT as Partial<CodingContext>),
      );
      const resumed = composePlayerPrompt(
        state.getInput({
          ...FULL_CONTEXT,
          ...continuationContext(contract.stateId),
        } as Partial<CodingContext>),
      );

      expect(ordinary, `${contract.stateId}: ordinary prompt`).not.toContain(
        REMOVED_BOSS_QUESTION_INSTRUCTION,
      );
      expect(resumed, `${contract.stateId}: resumed prompt`).not.toContain(
        REMOVED_BOSS_QUESTION_INSTRUCTION,
      );
    }
  });
});

describe('prompt contract — Boss-reply continuation', () => {
  for (const contract of contracts) {
    const state = stateById.get(contract.stateId);
    if (!state) continue;

    it(`${contract.stateId} renders continuation preamble and Q/A before ordinary blocks`, () => {
      const input = state.getInput({
        ...FULL_CONTEXT,
        ...continuationContext(contract.stateId),
      } as Partial<CodingContext>);
      const composed = composePlayerPrompt(input);

      // Per DR-004 §6: continuation preamble + Q/A first, then
      // context blocks (Boss intent / Task description), then the
      // prompt body, then action blocks (Review items / Rebuttals).
      const contextLabels = ['Boss intent:', 'Task description:'];
      const actionLabels = ['Review items:', 'Rebuttals:'];
      const markers = [
        CONTINUATION_PREAMBLE,
        `Boss question:\n${CONTINUATION_QUESTION}`,
        `Boss reply:\n${CONTINUATION_REPLY}`,
        ...contextLabels.filter((label) => composed.includes(label)),
        substitutedPromptFirstLine(input.prompt),
        ...actionLabels.filter((label) => composed.includes(label)),
      ];
      const positions = markers.map((marker) => composed.indexOf(marker));
      expect(
        positions.every((position) => position !== -1),
        `${contract.stateId}: all continuation markers should render`,
      ).toBe(true);
      expect(
        positions,
        `${contract.stateId}: continuation → context blocks → body → action blocks`,
      ).toEqual([...positions].sort((a, b) => a - b));
    });

    it(`${contract.stateId} suppresses continuation blocks unless both fields are present`, () => {
      const full = continuationContext(contract.stateId);
      const pendingOnly = composePlayerPrompt(
        state.getInput({
          ...FULL_CONTEXT,
          pendingBossQuestion: full.pendingBossQuestion,
        } as Partial<CodingContext>),
      );
      const replyOnly = composePlayerPrompt(
        state.getInput({
          ...FULL_CONTEXT,
          bossReply: full.bossReply,
        } as Partial<CodingContext>),
      );

      for (const [label, composed] of [
        ['pendingOnly', pendingOnly],
        ['replyOnly', replyOnly],
      ] as const) {
        expect(
          composed,
          `${contract.stateId} ${label}: no preamble`,
        ).not.toContain(CONTINUATION_PREAMBLE);
        expect(
          composed,
          `${contract.stateId} ${label}: no question block`,
        ).not.toContain('Boss question:');
        expect(
          composed,
          `${contract.stateId} ${label}: no reply block`,
        ).not.toContain('Boss reply:');
      }
    });
  }
});
