// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { assign, createActor, fromPromise, setup, waitFor } from 'xstate';
import { expect, it } from 'vitest';
import { defaultComposePlayerPrompt } from './xstate-runtime.js';

const definition = readFileSync(new URL('../slc/gears2fsm.md', import.meta.url), 'utf8');
const TASK = 'Make the exact change.\nPreserve $& and <other-token> literally.';
const SEED = 'Source-permitted initial task seed.';
const PROMPT = 'Carry out the task and commit.\n<input-task>';
type MachineInput = { inputTask?: string };
type PlayerInput = { prompt: string; result: Record<string, string>; inputTask?: string };
const cases = [
  { name: 'empty initial input', seed: undefined, text: TASK, relay: true },
  { name: 'new Boss text replaces an optional seed', seed: SEED, text: TASK, relay: true },
  { name: 'omitted event text preserves a permitted seed', seed: SEED, text: undefined, relay: true },
  { name: 'context-only task fails the actor relay', seed: undefined, text: TASK, relay: false },
];

it.each(cases)('$name', async ({ seed, text, relay }) => {
  expect(definition).toContain('Boss text supplied by an entry event shall not become a required machine-construction input unless Source independently requires that value before the first Boss turn; an optional source-appropriate seed may remain.');
  expect(definition).toContain('The corresponding `invoke.input` object shall include that field beside `prompt`; storing it only in machine context does not satisfy the actor-input contract.');
  const inputs: PlayerInput[] = [];
  const machine = setup({
    types: {
      input: {} as MachineInput,
      context: {} as { inputTask: string },
      events: {} as { type: 'START'; inputTask?: string },
    },
    actors: {
      player: fromPromise<{ guard: 'done' }, PlayerInput>(async ({ input }) => {
        inputs.push(input);
        return { guard: 'done' };
      }),
    },
  }).createMachine({
    context: ({ input }) => ({ inputTask: input?.inputTask ?? '' }),
    initial: 'ready',
    states: {
      ready: {
        tags: ['playbook.parked'],
        on: {
          START: {
            target: 'work',
            guard: ({ context, event }) => Boolean(event.inputTask ?? context.inputTask),
            actions: assign(({ context, event }) => ({ inputTask: event.inputTask ?? context.inputTask })),
          },
        },
      },
      work: {
        invoke: {
          src: 'player',
          input: ({ context }): PlayerInput => ({
            prompt: PROMPT, result: { done: 'Completed the task.' },
            ...(relay ? { inputTask: context.inputTask } : {}),
          }),
          onDone: 'done',
        },
      },
      done: { type: 'final' },
    },
  });
  const actor = createActor(machine, { input: seed === undefined ? {} : { inputTask: seed } }).start();
  try {
    expect(actor.getSnapshot().value).toBe('ready');
    expect(inputs).toEqual([]);
    actor.send({ type: 'START', ...(text === undefined ? {} : { inputTask: text }) });
    await waitFor(actor, snapshot => snapshot.status === 'done');
    expect(inputs).toHaveLength(1);
    const expectedTask = text ?? seed;
    expect(actor.getSnapshot().context.inputTask).toBe(expectedTask);
    expect(inputs[0]!.prompt).toBe(PROMPT);
    const rendered = defaultComposePlayerPrompt(inputs[0]!);
    expect(rendered).toBe(relay ? `Carry out the task and commit.\n${expectedTask}` : PROMPT);
    if (relay) expect(inputs[0]!.inputTask).toBe(expectedTask);
    else expect(inputs[0]).not.toHaveProperty('inputTask');
  } finally { actor.stop(); }
});
