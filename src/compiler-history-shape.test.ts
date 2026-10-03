// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
import { describe, expect, it } from "vitest";
import {
  composePlayerContinuation,
  type PlaybookPlayerInput,
} from "./xstate-playbook-runtime.js";

type Exchange = { question: string; answer: string };
type Context = {
  callerInput: string;
  operatorDiscussion?: readonly Exchange[];
  pendingBossQuestion?: { question: string };
  bossReply?: string;
  approved: boolean;
};
type Input = PlaybookPlayerInput & Pick<Context, "callerInput" | "operatorDiscussion">;
type Event =
  | { type: "START"; callerInput: string }
  | { type: "RESET" }
  | { type: "BOSS_REPLY"; answer: string };
type Result =
  | { guard: "needsBossReply"; question: string }
  | { guard: "accepted" }
  | { guard: "rejected" };

function compose(input: Input, _identity?: unknown, resuming = false): string {
  if (typeof input.callerInput !== "string" || input.callerInput.length === 0)
    throw new TypeError("Caller input is required");
  const history = input.operatorDiscussion;
  if (history !== undefined && !Array.isArray(history))
    throw new TypeError("Operator discussion must be an array");
  for (const entry of history ?? []) {
    if (
      entry === null || typeof entry !== "object" ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      Object.keys(entry).length !== 2 ||
      typeof entry.question !== "string" || typeof entry.answer !== "string"
    ) throw new TypeError("Malformed Operator discussion entry");
  }
  const retained = (history ?? []).map((entry) =>
    `Earlier question:\n${entry.question}\nEarlier answer:\n${entry.answer}`
  ).join("\n\n");
  const body = input.prompt.replace(/<caller-input>/g, () =>
    input.callerInput.replace(/\r\n|\n/g, (separator) => `${separator}> `)
  );
  return composePlayerContinuation(
    input,
    retained === "" ? body : `${retained}\n\n${body}`,
    resuming,
  );
}

function fixture(typedHistory: boolean, accept = true, resuming = false) {
  const inputs: Input[] = [];
  const prompts: string[] = [];
  const empty = () => typedHistory ? [] : undefined;
  const machine = setup({
    types: {
      context: {} as Context,
      events: {} as Event,
    },
    actors: {
      player: fromPromise<Result, Input>(async ({ input }) => {
        inputs.push(input);
        prompts.push(compose(input, undefined, resuming));
        const answered = input.operatorDiscussion?.length ?? 0;
        return answered < 2
          ? { guard: "needsBossReply", question: `Question ${answered + 1}?` }
          : { guard: accept ? "accepted" : "rejected" };
      }),
    },
  }).createMachine({
    id: "history",
    context: {
      callerInput: "",
      operatorDiscussion: empty(),
      approved: false,
    },
    initial: "idle",
    on: {
      RESET: {
        target: ".idle",
        actions: assign({
          callerInput: "",
          operatorDiscussion: empty,
          pendingBossQuestion: undefined,
          bossReply: undefined,
          approved: false,
        }),
      },
    },
    states: {
      idle: {
        on: {
          START: {
            guard: ({ event }) => event.callerInput.length > 0,
            target: "work",
            actions: assign({ callerInput: ({ event }) => event.callerInput }),
          },
        },
      },
      work: {
        invoke: {
          src: "player",
          input: ({ context }): Input => ({
            stateId: "work",
            role: "operator",
            sourceItem: "HISTORY-1",
            prompt: "Inspect the request.\n\n> <caller-input>",
            result: {
              needsBossReply: "Ask for the next required choice.",
              accepted: "The acting role accepted the current choice.",
              rejected: "The acting role rejected the current choice.",
            },
            callerInput: context.callerInput,
            operatorDiscussion: context.operatorDiscussion,
            pendingBossQuestion: context.pendingBossQuestion,
            bossReply: context.bossReply,
          }),
          onDone: [
            {
              guard: ({ event }) => event.output.guard === "needsBossReply",
              target: "awaitBossReply",
              actions: assign({
                pendingBossQuestion: ({ event }) => event.output.guard === "needsBossReply"
                  ? { question: event.output.question } : undefined,
                bossReply: undefined,
              }),
            },
            {
              guard: ({ event }) => event.output.guard === "accepted",
              target: "done",
              actions: assign({ approved: true }),
            },
            { target: "refused" },
          ],
          onError: { target: "refused" },
        },
      },
      awaitBossReply: {
        tags: ["playbook.parked"],
        on: {
          BOSS_REPLY: {
            guard: ({ context, event }) =>
              context.pendingBossQuestion !== undefined && event.answer.length > 0,
            target: "work",
            actions: assign({
              operatorDiscussion: ({ context, event }) => [
                ...(context.operatorDiscussion ?? []),
                { question: context.pendingBossQuestion!.question, answer: event.answer },
              ],
              bossReply: ({ event }) => event.answer,
            }),
          },
        },
      },
      refused: { type: "final" },
      done: { type: "final" },
    },
  });
  return { machine, inputs, prompts };
}

async function run(typed: boolean, resuming: boolean, reset: boolean, accept = true) {
  const flow = fixture(typed, accept, resuming);
  const actor = createActor(flow.machine).start();
  try {
    if (reset) {
      actor.send({ type: "START", callerInput: "Old request" });
      await waitFor(actor, (s) => s.value === "awaitBossReply", { timeout: 1_000 });
      actor.send({ type: "BOSS_REPLY", answer: "Old answer" });
      await waitFor(actor, (s) => s.value === "awaitBossReply" && s.context.operatorDiscussion?.length === 1, { timeout: 1_000 });
      actor.send({ type: "RESET" });
      expect(actor.getSnapshot().context).toMatchObject({ approved: false, callerInput: "" });
      expect(actor.getSnapshot().context.operatorDiscussion).toEqual(typed ? [] : undefined);
      flow.inputs.length = flow.prompts.length = 0;
    }
    actor.send({ type: "START", callerInput: "Actual request\n$& <literal>\n" });
    for (const [index, answer] of ["First choice\r\n", "Second choice\n\n"].entries()) {
      await waitFor(actor, (s) => s.value === "awaitBossReply" && (s.context.operatorDiscussion?.length ?? 0) === index, { timeout: 1_000 });
      expect(actor.getSnapshot().context.approved).toBe(false);
      actor.send({ type: "BOSS_REPLY", answer });
    }
    await waitFor(actor, (s) => s.status === "done", { timeout: 1_000 });
    expect(flow.inputs).toHaveLength(3);
    return {
      prompts: flow.prompts,
      inputs: flow.inputs,
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
    };
  } finally {
    actor.stop();
  }
}

it("ships the structural history rule without supplying semantic prerequisites", () => {
  const guide = readFileSync(new URL("../slc/gears2fsm.md", import.meta.url), "utf8");
  expect(guide).toContain("initialize that context field to `[]` and reset it to `[]` only at its Source lifecycle boundaries");
  expect(guide).toContain("Carry its declared array shape through ordinary and continuation `invoke.input`");
  expect(guide).toContain("This empty history is not a default caller intent, prerequisite report, domain evidence, approval, or prior-stage result");
});

it.each([false, true])("preserves real repeated-question prompts and outcomes with resuming=%s", async (resuming) => {
  for (const reset of [false, true]) {
    const original = await run(false, resuming, reset);
    const typed = await run(true, resuming, reset);
    expect(typed.prompts).toEqual(original.prompts);
    expect(typed.context).toEqual(original.context);
    expect(typed.value).toBe(original.value);
    expect(typed.inputs[0]!.operatorDiscussion).toEqual([]);
    expect(original.inputs[0]!.operatorDiscussion).toBeUndefined();
    expect(typed.inputs[2]!.operatorDiscussion).toEqual([
      { question: "Question 1?", answer: "First choice\r\n" },
      { question: "Question 2?", answer: "Second choice\n\n" },
    ]);
  }
});

it("does not turn empty history or received replies into caller or approval evidence", async () => {
  const flow = fixture(true);
  const actor = createActor(flow.machine).start();
  try {
    actor.send({ type: "START", callerInput: "" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(flow.inputs).toHaveLength(0);
    expect(actor.getSnapshot().context.approved).toBe(false);
  } finally {
    actor.stop();
  }
  const refused = await run(true, false, false, false);
  expect(refused.value).toBe("refused");
  expect(refused.context.approved).toBe(false);
});

it.each(["not an array", null, {}, [null], [{ question: 1, answer: "A" }], [{ question: "Q", answer: "A", extra: true }]])(
  "still rejects malformed actual history %j",
  (history) => {
    const input = {
      stateId: "work", role: "operator", sourceItem: "HISTORY-1",
      prompt: "Inspect.", result: { accepted: "Accepted." }, callerInput: "Required request",
      operatorDiscussion: history,
    } as unknown as Input;
    expect(() => compose(input)).toThrow(/discussion/);
  },
);

const compiler = process.env.PLAYBOOK_EXPERIMENT_COMPILER;
describe.runIf(compiler !== undefined)("actual SLC initial-context prompt probe", () => {
  it("refuses the absent scalar-probed history and accepts initialized array shape", async () => {
    const { checkPromptComposition } = await import(pathToFileURL(join(compiler!, "dist/verify.js")).href);
    const inspect = (typed: boolean) => checkPromptComposition({
      config: fixture(typed).machine.config, compose, actor: "player", artifactSchema: 3,
    });
    expect(inspect(false)).toEqual([
      "work: composePlayerPrompt threw on an ordinary turn: Operator discussion must be an array",
      "work: composePlayerPrompt threw on a continuation turn: Operator discussion must be an array",
    ]);
    expect(inspect(true)).toEqual([]);
  });
});
