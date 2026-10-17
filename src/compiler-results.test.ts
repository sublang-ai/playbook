// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { getInitialSnapshot, type AnyStateMachine } from "xstate";
import { codeMachine } from "../reference/sdlc/code.playbook/code.fsm.js";
import { reviewMachine } from "../reference/sdlc/review.playbook/review.fsm.js";
import { decideMachine } from "../reference/sdlc/decide.playbook/decide.fsm.js";
import { devMachine } from "../reference/sdlc/dev.playbook/dev.fsm.js";
import { branchMachine } from "../reference/sdlc/branch.playbook/branch.fsm.js";
import { prMachine } from "../reference/sdlc/pr.playbook/pr.fsm.js";
import { inspectMachine } from "../reference/sdlc/inspect.playbook/inspect.fsm.js";
import { parseGearsContract } from "../scripts/check-slc-source-gears.mjs";

const referenceGearsFiles = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    files: string[];
  }
).files.filter((path) => path.startsWith("reference/") && path.endsWith(".gears.md"));

it.each(referenceGearsFiles)("%s reserves Boss-reply results for compiled state maps", (path) => {
  const items = parseGearsContract(
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
  );
  expect(items.length).toBeGreaterThan(0);
  expect(items.flatMap((item) => item.results
    .filter(({ guard }) => guard === "needsBossReply")
    .map(() => item.id))).toEqual([]);
});

const workflowMachines: Readonly<Record<string, AnyStateMachine>> = {
  code: codeMachine, review: reviewMachine, decide: decideMachine,
  dev: devMachine, branch: branchMachine, pr: prMachine, inspect: inspectMachine,
};
const standardBossReplyDescription =
  "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.";

it.each(referenceGearsFiles.filter(path => !path.includes("/captain.playbook/")))(
  "%s uses the compiler's standard question contract in every acting state",
  path => {
    const workflow = path.split("/").at(-1)!.replace(".gears.md", "");
    const machine = workflowMachines[workflow];
    expect(machine, workflow).toBeDefined();
    const { context } = getInitialSnapshot(machine, {});
    const pending = [machine.config];
    let actingStates = 0;
    for (const state of pending) {
      pending.push(...Object.values(state.states ?? {}));
      for (const invoke of [state.invoke ?? []].flat()) {
        if (invoke.src !== "player" && invoke.src !== "captain") continue;
        const input = typeof invoke.input === "function"
          ? invoke.input({ context, event: { type: "xstate.init" }, self: undefined as never })
          : invoke.input;
        expect(input.result.needsBossReply, `${workflow}:${input.stateId}`).toBe(standardBossReplyDescription);
        actingStates++;
      }
    }
    expect(actingStates).toBeGreaterThan(0);
    expect(readFileSync(new URL("../slc/gears2fsm.md", import.meta.url), "utf8"))
      .toContain(`\`\`\`text\n${standardBossReplyDescription}\n\`\`\``);
  },
);

const compiler = process.env.PLAYBOOK_EXPERIMENT_COMPILER;
const guidance = readFileSync(
  new URL(
    "../scripts/experiments/results-boundary-guidance.md",
    import.meta.url,
  ),
  "utf8",
);
const condition = "The selected evidence remains immutable.";
const acting =
  "When a request arrives, Captain shall inspect it:\n\n> Inspect the supplied evidence.";
const result = "Results:\n- `done`: The inspection is complete.";
const heading = "# Example\n\n### EXAMPLE-1\n\n";

it("activates the measured guidance exactly once and preserves the nested-call exception", () => {
  expect(guidance).toContain(
    "after the label, emit only result bullets and blank lines",
  );
  expect(guidance).toContain("Nested-call items remain without `Results:`");
  const common = readFileSync(
    new URL("../slc/text2gears.md", import.meta.url),
    "utf8",
  );
  const measuredSnippet = guidance
    .split("\n\n")
    .slice(1)
    .join("\n\n")
    .trimEnd();
  expect(common.split(measuredSnippet)).toHaveLength(2);
  expect(common).toContain(
    "A nested-call item shall carry no `Results:` label",
  );
});

describe.runIf(compiler !== undefined)(
  "the supplied SLC parser checks the existing Results boundary",
  () => {
    it("reserves output-clause backticks for declarations without reinterpreting ambiguous guidance", async () => {
      const { checkGearsResultContract, parseGearsItems } = await import(
        pathToFileURL(join(compiler!, "dist/verify.js")).href
      );
      const { defaultExtractRequiredFields } = await import(
        new URL("./xstate-playbook-runtime.js", import.meta.url).href
      );
      for (const description of [
        "Implemented (`code` owns the receipt). Output shall include `codeCommit` (new code-owned commit) and `coderOutput: <verbatim final text>`.",
        "Implemented. Output shall include `codeCommit: <new (code-owned) commit>` and `coderOutput: <verbatim final text>`.",
      ]) {
        const gears = `${heading}${acting}\n\nResults:\n- \`done\`: ${description}\n`;
        expect(checkGearsResultContract(gears)).toEqual([]);
        expect(parseGearsItems(gears)[0].result.done).toBe(description);
        expect(defaultExtractRequiredFields(description)).toEqual([
          "codeCommit",
          "coderOutput",
        ]);
      }
      const malformed =
        "Implemented. Output shall include `codeCommit` (new `code`-owned commit) and `coderOutput: <verbatim final text>`.";
      const gears = `${heading}${acting}\n\nResults:\n- \`done\`: ${malformed}\n`;
      expect(checkGearsResultContract(gears).join("\n")).toContain(
        "inside parenthetical output guidance",
      );
      expect(parseGearsItems(gears)[0].result.done).toBe(malformed);
      expect(defaultExtractRequiredFields(malformed)).toEqual([
        "codeCommit",
        "code",
        "coderOutput",
      ]);
    });

    it("accepts before-prompt invariants and rejects both observed illegal placements without changing prompt or result semantics", async () => {
      const { checkGearsResultContract, parseGearsItems } = await import(
        pathToFileURL(join(compiler!, "dist/verify.js")).href
      );
      const legal = `${heading}${condition}\n\n${acting}\n\n${result}\n`;
      const between = `${heading}${acting}\n\n${condition}\n\n${result}\n`;
      const after = `${heading}${acting}\n\n${result}\n\n${condition}\n`;
      expect(checkGearsResultContract(legal)).toEqual([]);
      expect(checkGearsResultContract(between).join("\n")).toMatch(
        /immediately follow the acting blockquote/,
      );
      expect(checkGearsResultContract(after).join("\n")).toMatch(
        /malformed Results entry/,
      );
      for (const candidate of [between, after]) {
        expect(parseGearsItems(candidate)[0].prompt).toBe(
          parseGearsItems(legal)[0].prompt,
        );
        expect(parseGearsItems(candidate)[0].result).toEqual(
          parseGearsItems(legal)[0].result,
        );
      }
    });

    it("keeps child continuation after a nested-call prompt without inventing Results", async () => {
      const { checkGearsResultContract, parseGearsItems } = await import(
        pathToFileURL(join(compiler!, "dist/verify.js")).href
      );
      const gears = `${heading}When inspection is needed, Captain shall call playbook \`review\`:\n\n> Inspect the supplied evidence.\n\nWhen the review succeeds, the workflow completes.\n`;
      expect(checkGearsResultContract(gears)).toEqual([]);
      const [item] = parseGearsItems(gears);
      expect(item.playbookId).toBe("review");
      expect(item.prompt).toBe("Inspect the supplied evidence.");
      expect(item.result).toBeUndefined();
    });

    it("preserves terminal-return prose without adding an actor or altering its prompt and result", async () => {
      const { checkGearsResultContract, parseGearsItems } = await import(
        pathToFileURL(join(compiler!, "dist/verify.js")).href
      );
      const returnDuty =
        "When inspection completes, the workflow returns the inspected document identity and the fact that it satisfies the requested criteria to its caller.";
      const delegated =
        "When inspection is needed, Captain shall prompt Inspector:\n\n> Inspect the supplied evidence.";
      const nested =
        "When inspection is needed, Captain shall call playbook `inspect`:\n\n> Inspect the supplied evidence.";
      for (const [withoutReturn, withReturn] of [
        [
          `${heading}${delegated}\n\n${result}\n`,
          `${heading}${returnDuty}\n\n${delegated}\n\n${result}\n`,
        ],
        [`${heading}${nested}\n`, `${heading}${nested}\n\n${returnDuty}\n`],
      ]) {
        const original = parseGearsItems(withoutReturn);
        const preserved = parseGearsItems(withReturn);
        expect(checkGearsResultContract(withReturn)).toEqual([]);
        expect(preserved).toHaveLength(1);
        expect(preserved[0].prompt).toBe(original[0].prompt);
        expect(preserved[0].result).toEqual(original[0].result);
        expect(preserved[0].playbookId).toBe(original[0].playbookId);
      }
      const complete = "Results:\n- `complete`: The inspection is complete.";
      const described = `${heading}${delegated}\n\n${complete} ${returnDuty}\n`;
      const [before] = parseGearsItems(
        `${heading}${delegated}\n\n${complete}\n`,
      );
      const after = parseGearsItems(described);
      expect(checkGearsResultContract(described)).toEqual([]);
      expect(after).toHaveLength(1);
      expect(after[0].prompt).toBe(before.prompt);
      expect(Object.keys(after[0].result)).toEqual(Object.keys(before.result));
      expect(after[0].result.complete).toContain(returnDuty);
    });

    it("represents an authored routing question as a whole-final-text field without changing the authored guard", async () => {
      const { checkGearsResultContract, parseGearsItems } = await import(
        pathToFileURL(join(compiler!, "dist/verify.js")).href
      );
      const { defaultExtractRequiredFields, renderGovernedOutcomeContract } =
        await import(
          pathToFileURL(
            join(
              compiler!,
              "node_modules/@sublang/playbook/src/xstate-runtime.js",
            ),
          ).href
        );
      // The routing contract's own `question` result: the one authored Boss
      // question text2gears declares (compiler-results-5).
      const prompt =
        "When Boss gives an intent, Captain shall decide how to handle it:\n\n> Ask Boss which IR to continue when the intent names none.";
      const continuation =
        "When Boss answers, the same routing decision resumes with the answer.";
      const unannotated = `${heading}${prompt}\n\nResults:\n- \`question\`: Captain asked which IR to continue and waits. Output shall include \`question\` and \`selectedIr: <IR identity>\`. ${continuation}\n`;
      const annotated = unannotated.replace(
        "`question` and `selectedIr: <IR identity>`",
        "`question: <verbatim final text>` and `selectedIr: <IR identity>`",
      );

      expect(checkGearsResultContract(annotated)).toEqual([]);
      const [before] = parseGearsItems(unannotated);
      const [after] = parseGearsItems(annotated);
      expect(after.prompt).toBe(before.prompt);
      expect(Object.keys(after.result)).toEqual(["question"]);
      expect(after.result.question).toContain(
        "Output shall include `question: <verbatim final text>`",
      );
      expect(after.result.question).toContain("`selectedIr: <IR identity>`");
      expect(defaultExtractRequiredFields(after.result.question)).toEqual([
        "question",
        "selectedIr",
      ]);

      const rendered = renderGovernedOutcomeContract(
        "question",
        after.result.question,
        {
          fields: { question: "presentation", selectedIr: "semantic" },
          repositoryDisposition: "deferred",
        },
      );
      expect(rendered).toContain(
        '  Reply exactly: { "guard": "question", "selectedIr": <IR identity> }',
      );
      expect(rendered.join("\n")).toContain(
        "Semantic fields as authored: `selectedIr: <IR identity>`",
      );
      expect(rendered).toContain(
        "  Runtime-supplied, do not include: `question` (presentation-owned)",
      );
      expect(rendered.join("\n")).not.toContain("needsBossReply");
      expect(annotated).toContain(continuation);
    });
  },
);

it("shows <value> for a bare-name semantic field with no recorded shape, <string> only for a recorded string", async () => {
  const { renderGovernedOutcomeContract } = await import("./xstate-playbook-runtime.js");
  // DR-091: a shape the probe did not reveal is the machine's to judge,
  // so the example asserts none; a recorded string stays `<string>`.
  const description =
    "Coder committed the task as one new commit. Output shall include `latestCommit: <commit identity>`, `irNumber` identifying the IR and `irTask: <the implemented task>`.";
  const outcome = {
    fields: { latestCommit: "effect", irNumber: "semantic", irTask: "semantic" },
    repositoryDisposition: "one-descendant-commit",
  } as const;
  const unrecorded = renderGovernedOutcomeContract("complete", description, outcome);
  expect(unrecorded).toContain(
    '  Reply exactly: { "guard": "complete", "irNumber": <value>, "irTask": <the implemented task> }',
  );
  expect(unrecorded.join("\n")).not.toContain("JSON value shape");
  const asString = renderGovernedOutcomeContract("complete", description, outcome, { irNumber: "string" });
  expect(asString).toContain(
    '  Reply exactly: { "guard": "complete", "irNumber": <string>, "irTask": <the implemented task> }',
  );
  expect(asString.join("\n")).not.toContain("JSON value shape");
  const asList = renderGovernedOutcomeContract("complete", description, outcome, { irNumber: "string-array" });
  expect(asList).toContain(
    '  Reply exactly: { "guard": "complete", "irNumber": <JSON array of strings>, "irTask": <the implemented task> }',
  );
  expect(asList.join("\n")).toContain("JSON value shape: `irNumber` is a JSON array of strings");
});

it("keeps a delegated Boss question framework-owned and confines output properties to consumed values", () => {
  const definition = readFileSync(
    new URL("../slc/text2gears.md", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  // compiler-results-5: no second guard beside the universal needsBossReply.
  expect(definition).toContain(
    "an authored Boss question is the framework-owned `needsBossReply` outcome",
  );
  expect(definition).toContain("shall declare no result for it");
  expect(definition).toContain(
    "Only the routing contract's own `question` and `followUpQuestion` results declare the question",
  );
  // compiler-results-9: properties for consumers only.
  expect(definition).toContain(
    "shall declare an output property only where a consumer requires it: a later item's `<placeholder>`, the workflow's terminal return, or the workflow's declared public interface",
  );
  expect(definition).toContain(
    "travels in the result's verbatim final-text property and is not a separate judge-authored property",
  );
});

it("keeps a created commit under latestCommit while the Source reads it through its own placeholder", () => {
  const flat = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8").replace(/\s+/g, " ");
  expect(flat("../slc/text2gears.md")).toContain(
    "its producer declares `latestCommit: <commit identity>` whatever placeholder a later prompt reads it through",
  );
  expect(flat("../slc/gears2fsm.md")).toContain(
    "binds to a typed context field named by its canonical mapping, assigned from that call's accepted `latestCommit`",
  );
  for (const [workflow, placeholder] of [
    ["code", "<code-commit>"],
    ["decide", "<decide-commit>"],
  ] as const) {
    const gears = readFileSync(
      new URL(`../reference/sdlc/${workflow}.playbook/${workflow}.gears.md`, import.meta.url),
      "utf8",
    );
    expect(gears).toContain("`latestCommit: <commit identity>`");
    expect(gears).toContain(placeholder);
    expect(gears).not.toMatch(/`(codeCommit|decideCommit)[:`]/);
  }
});

it("carries domain evidence qualifications while preserving the framework question rule", () => {
  const definition = readFileSync(
    new URL("../slc/text2gears.md", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  expect(definition).toContain(
    "shall be carried in that outcome's result description, the only text the adjudicator reads when it selects the guard",
  );
  expect(definition).toContain("left in the item's prose, it reaches no judge");
  expect(definition).toContain("qualifies an authored domain outcome's evidence");
  expect(definition).toContain("qualifies the one authored domain outcome's evidence");
  expect(definition).toContain("The framework-owned question is interpreted under the runtime's current-call adjudication rule");
  expect(definition).toContain("it is not an authored domain outcome whose description Source overrides");
  // A single qualified outcome still gets its one bullet (DECIDE-1's `proposed`).
  expect(definition).toContain(
    "the behavior carries exactly one `Results:` bullet naming that outcome and carrying the qualification",
  );
});

it("marks every accepted governed arm so the runtime publishes the outcome", () => {
  const definition = readFileSync(
    new URL("../slc/gears2fsm.md", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  expect(definition).toContain(
    "every accepted `onDone` arm — each arm that routes a declared outcome, not the malformed-output fallback — shall carry, first among its actions, the root-machine action `{ type: 'playbook.acceptedOutcome'",
  );
  for (const workflow of ["code", "review", "decide", "dev", "branch", "pr"]) {
    const fsm = readFileSync(
      new URL(`../reference/sdlc/${workflow}.playbook/${workflow}.fsm.ts`, import.meta.url),
      "utf8",
    );
    expect(fsm, `${workflow} declares the marker action`).toContain("'playbook.acceptedOutcome':");
    expect(
      fsm.split("type: 'playbook.acceptedOutcome'").length - 1,
      `${workflow} marks its accepted arms`,
    ).toBeGreaterThan(0);
  }
});
