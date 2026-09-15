// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { assign, createActor, fromPromise, setup, waitFor } from 'xstate';
import { expect, it } from 'vitest';
import { pendingBossQuestionFromContext } from './xstate-runtime.js';

const definition = readFileSync(new URL('../slc/gears2fsm.md', import.meta.url), 'utf8');
type Question = {
  questionId: string; resumeStateId: string; sourceItem: string;
  asker: { kind: 'captain' } | { kind: 'role'; roleId: string }; question: string;
};
type Continuation = { pendingBossQuestion?: Question; bossReply?: string };
type Context = Continuation & {
  continuation?: Continuation;
  pendingBossQuestions?: Record<string, Question>;
  bossReplies?: Record<string, string>;
};
type Output = { guard: 'needsBossReply'; question: string } | { guard: 'done' };
const cases = (['captain', 'player'] as const).flatMap(actor =>
  (['scalar', 'keyed', 'private-wrapper'] as const).map(storage => ({ actor, storage })),
);

it.each(cases)('keeps $actor/$storage suspension visible at its canonical boundary', async ({ actor: kind, storage }) => {
  expect(definition).toContain('`context.pendingBossQuestion` and `context.bossReply`');
  expect(definition).toContain('`context.pendingBossQuestions[stateId]` and `context.bossReplies[stateId]`');
  expect(definition).toContain('A private wrapper such as `context.continuation` shall not replace these fields directly on machine context.');
  const question: Question = {
    questionId: 'work', resumeStateId: 'work', sourceItem: 'TASK-1',
    asker: kind === 'captain' ? { kind: 'captain' } : { kind: 'role', roleId: 'agent' },
    question: 'Which file should I change?\nPlease give the exact name.',
  };
  const reply = 'Use example.txt.\nPreserve its name.';
  const selected = (context: Context): Continuation => storage === 'private-wrapper'
    ? context.continuation ?? {}
    : storage === 'keyed'
      ? { pendingBossQuestion: context.pendingBossQuestions?.work, bossReply: context.bossReplies?.work }
      : context;
  const inputs: Continuation[] = [];
  const machine = setup({
    types: { context: {} as Context, events: {} as { type: 'REPLY'; answer: string } },
    actors: {
      work: fromPromise<Output, Continuation>(async ({ input }) => {
        inputs.push(input);
        return inputs.length === 1
          ? { guard: 'needsBossReply', question: question.question }
          : { guard: 'done' };
      }),
    },
  }).createMachine({
    context: {}, initial: 'work',
    states: {
      work: {
        invoke: {
          src: 'work', input: ({ context }) => selected(context),
          onDone: [
            {
              guard: ({ event }) => event.output.guard === 'needsBossReply',
              target: 'awaitBossReply',
              actions: assign(() => storage === 'private-wrapper'
                ? { continuation: { pendingBossQuestion: question } }
                : storage === 'keyed'
                  ? { pendingBossQuestions: { work: question } }
                  : { pendingBossQuestion: question }),
            },
            { target: 'done' },
          ],
        },
      },
      awaitBossReply: {
        on: {
          REPLY: {
            target: 'work',
            actions: assign(({ context, event }) => storage === 'private-wrapper'
              ? { continuation: { ...context.continuation, bossReply: event.answer } }
              : storage === 'keyed'
                ? { bossReplies: { work: event.answer } }
                : { bossReply: event.answer }),
          },
        },
      },
      done: { type: 'final' },
    },
  });
  const actor = createActor(machine).start();
  try {
    await waitFor(actor, snapshot => snapshot.value === 'awaitBossReply');
    const context = actor.getSnapshot().context;
    // The flat factory reads scalar context directly. A keyed branch projects
    // its selected record into the same singular invocation-input contract.
    const visible = pendingBossQuestionFromContext(storage === 'keyed' ? selected(context) : context);
    expect(visible).toEqual(storage === 'private-wrapper' ? undefined : question);
    actor.send({ type: 'REPLY', answer: reply });
    await waitFor(actor, snapshot => snapshot.status === 'done');
    expect(inputs[1]).toMatchObject({ pendingBossQuestion: question, bossReply: reply });
    // A private wrapper can pass manually injected reply tests yet remain
    // invisible to the host; that was the repeated generated-FSM failure.
    expect(inputs).toHaveLength(2);
  } finally { actor.stop(); }
});
