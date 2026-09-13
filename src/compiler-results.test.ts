// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

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
  },
);
