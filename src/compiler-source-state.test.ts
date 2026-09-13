// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from "node:fs";
import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
import { expect, it } from "vitest";
import { composePlayerContinuation } from "./xstate-playbook-runtime.js";

const definition = readFileSync(
  new URL("../slc/gears2fsm.md", import.meta.url),
  "utf8",
);

it("guards deterministic source-owned outcome availability before accepting a result", async () => {
  expect(definition).toContain(
    "Where a Source outcome's availability condition is deterministically knowable from execution state",
  );
  expect(definition).toContain(
    "stating the condition only in a Results description, Judge prose, or prompt text is not enough",
  );
  type Context = { bossReplySeen: boolean; attempts: number };
  type Event = { type: "BOSS_REPLY"; answer: string };
  type Result =
    { guard: "discussionComplete" } | { guard: "question"; question: string };
  const scripted = (outputs: Result[]) => {
    const inputs: Context[] = [];
    const machine = setup({
      types: { context: {} as Context, events: {} as Event },
      actors: {
        analyst: fromPromise<Result, Context>(async ({ input }) => {
          inputs.push(input);
          const output = outputs.shift();
          if (output === undefined)
            throw new Error("exhausted scripted outputs");
          return output;
        }),
      },
    }).createMachine({
      context: { bossReplySeen: false, attempts: 0 },
      initial: "analyze",
      states: {
        analyze: {
          invoke: {
            src: "analyst",
            input: ({ context }) => context,
            onDone: [
              {
                guard: ({ context, event }) =>
                  event.output.guard === "discussionComplete" &&
                  context.bossReplySeen,
                target: "done",
              },
              {
                guard: ({ event }) => event.output.guard === "question",
                target: "awaitBossReply",
              },
              { target: "failed" },
            ],
          },
        },
        awaitBossReply: {
          tags: ["playbook.parked"],
          on: {
            BOSS_REPLY: {
              target: "analyze",
              actions: assign(({ context }) => ({
                bossReplySeen: true,
                attempts: context.attempts + 1,
              })),
            },
          },
        },
        failed: { tags: ["playbook.parked"] },
        done: { type: "final" },
      },
    });
    return { inputs, machine };
  };
  const premature = scripted([{ guard: "discussionComplete" }]);
  const prematureActor = createActor(premature.machine).start();
  try {
    await waitFor(prematureActor, (snapshot) => snapshot.value === "failed");
    expect(prematureActor.getSnapshot().status).toBe("active");
    expect(prematureActor.getSnapshot().context.bossReplySeen).toBe(false);
    expect(premature.inputs).toHaveLength(1);
  } finally {
    prematureActor.stop();
  }
  const valid = scripted([
    { guard: "question", question: "Which constraint applies?" },
    { guard: "discussionComplete" },
  ]);
  const validActor = createActor(valid.machine).start();
  try {
    await waitFor(
      validActor,
      (snapshot) => snapshot.value === "awaitBossReply",
    );
    validActor.send({ type: "BOSS_REPLY", answer: "Use the CLI-only path." });
    await waitFor(validActor, (snapshot) => snapshot.status === "done");
    expect(validActor.getSnapshot().context).toMatchObject({
      bossReplySeen: true,
      attempts: 1,
    });
    expect(valid.inputs).toHaveLength(2);
  } finally {
    validActor.stop();
  }
});

it.each([
  { name: "resumed", resuming: true },
  { name: "fresh", resuming: false },
])(
  "persists earlier source-required Boss context across $name continuation",
  async ({ resuming }) => {
    expect(definition).toContain(
      "persist that source-owned history in serializable machine context before replacing or clearing the pending Q/A fields",
    );
    expect(definition).toContain(
      "relay that persisted context on both resumed and fresh calls",
    );
    expect(definition).toContain(
      "Shared Boss-reply continuation carries only the latest Q/A pair, and a backend continuation token is not durable Source history.",
    );
    type Pending = {
      questionId: string;
      resumeStateId: string;
      sourceItem: string;
      asker: { kind: "role"; roleId: string };
      question: string;
    };
    type SourceTurn = { question: string; answer: string };
    type Context = {
      sourceDiscussion: SourceTurn[];
      pendingBossQuestion?: Pending;
      bossReply?: string;
    };
    type Event = { type: "BOSS_REPLY"; answer: string };
    type Input = {
      prompt: string;
      sourceDiscussion: SourceTurn[];
      pendingBossQuestion?: Pending;
      bossReply?: string;
    };
    type Output =
      { guard: "question"; question: string } | { guard: "complete" };
    const inputs: Input[] = [];
    const questions = [
      "Which interface must stay CLI-only?",
      "Which UI output must be preserved?",
    ];
    const firstTurn = {
      question: questions[0]!,
      answer: "Keep the CLI-only path.",
    };
    const secondTurn = {
      question: questions[1]!,
      answer: "Preserve the current UI output.",
    };
    const pending = (question: string): Pending => ({
      questionId: "analyze",
      resumeStateId: "analyze",
      sourceItem: "DEV-5",
      asker: { kind: "role", roleId: "analyst" },
      question,
    });
    const machine = setup({
      types: { context: {} as Context, events: {} as Event },
      actors: {
        analyst: fromPromise<Output, Input>(async ({ input }) => {
          inputs.push(input);
          if (input.sourceDiscussion.length >= 2) return { guard: "complete" };
          return {
            guard: "question",
            question: questions[input.sourceDiscussion.length]!,
          };
        }),
      },
    }).createMachine({
      context: { sourceDiscussion: [] },
      initial: "analyze",
      states: {
        analyze: {
          invoke: {
            src: "analyst",
            input: ({ context }) => ({
              prompt:
                "Continue the planning discussion with Source-required context.",
              sourceDiscussion: context.sourceDiscussion,
              ...(context.pendingBossQuestion
                ? { pendingBossQuestion: context.pendingBossQuestion }
                : {}),
              ...(context.bossReply ? { bossReply: context.bossReply } : {}),
            }),
            onDone: [
              {
                guard: ({ event }) => event.output.guard === "question",
                target: "awaitBossReply",
                actions: assign(({ event }) => ({
                  pendingBossQuestion: pending(event.output.question),
                  bossReply: undefined,
                })),
              },
              { target: "done" },
            ],
          },
        },
        awaitBossReply: {
          tags: ["playbook.parked"],
          on: {
            BOSS_REPLY: {
              target: "analyze",
              actions: assign(({ context, event }) => ({
                sourceDiscussion: context.pendingBossQuestion
                  ? [
                      ...context.sourceDiscussion,
                      {
                        question: context.pendingBossQuestion.question,
                        answer: event.answer,
                      },
                    ]
                  : context.sourceDiscussion,
                bossReply: event.answer,
              })),
            },
          },
        },
        done: { type: "final" },
      },
    });
    const actor = createActor(machine).start();
    try {
      await waitFor(actor, (snapshot) => snapshot.value === "awaitBossReply");
      actor.send({ type: "BOSS_REPLY", answer: firstTurn.answer });
      await waitFor(
        actor,
        (snapshot) =>
          snapshot.value === "awaitBossReply" &&
          snapshot.context.sourceDiscussion.length === 1,
      );
      expect(actor.getSnapshot().context.sourceDiscussion).toEqual([firstTurn]);
      expect(actor.getSnapshot().context.pendingBossQuestion).toEqual(
        pending(secondTurn.question),
      );
      const beforeInputs = inputs.length;
      const persisted = actor.getPersistedSnapshot();
      const restoredSnapshot = JSON.parse(JSON.stringify(persisted));
      const restored = createActor(machine, {
        snapshot: restoredSnapshot,
      }).start();
      try {
        expect(inputs).toHaveLength(beforeInputs);
        restored.send({ type: "BOSS_REPLY", answer: secondTurn.answer });
        await waitFor(restored, (snapshot) => snapshot.status === "done");
        expect(inputs).toHaveLength(beforeInputs + 1);
        const delivered = inputs.at(-1)!;
        expect(delivered.sourceDiscussion).toEqual([firstTurn, secondTurn]);
        expect(delivered.pendingBossQuestion).toEqual(
          pending(secondTurn.question),
        );
        expect(delivered.bossReply).toBe(secondTurn.answer);
        const body = [
          "Earlier discussion:",
          ...delivered.sourceDiscussion.map(
            (turn) => `Q: ${turn.question}\nA: ${turn.answer}`,
          ),
          delivered.prompt,
        ].join("\n");
        const composed = composePlayerContinuation(delivered, body, resuming);
        expect(composed).toContain("Earlier discussion:");
        expect(composed).toContain(firstTurn.answer);
        expect(composed).toContain(secondTurn.answer);
        expect(composed).toContain(
          "Boss reply:\nPreserve the current UI output.",
        );
        if (resuming) expect(composed).not.toContain("Your previous question:");
        else
          expect(composed).toContain(
            "Your previous question:\nWhich UI output must be preserved?",
          );
      } finally {
        restored.stop();
      }
    } finally {
      actor.stop();
    }
  },
);
