// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultComposePlayerPrompt } from "./xstate-runtime.js";

const compiler = process.env.PLAYBOOK_EXPERIMENT_COMPILER;
const exactEvidence =
  "Runtime evidence $& <unrelated-token>, preserved exactly.";
const definition = readFileSync(
  new URL("../slc/text2gears.md", import.meta.url),
  "utf8",
);

it("clarifies that prose-authored relays govern every applicable complete acting prompt", () => {
  expect(definition).toContain(
    "Apply each Source-authored relay to every acting behavior it governs, including relays described only in prose.",
  );
  expect(definition).toContain(
    "Mentioning a value in a condition, result contract, or machine context does not deliver it to the acting role; its complete prompt blockquote shall carry the required quoted placeholder.",
  );
});

describe.runIf(compiler !== undefined)(
  "actual parsed prompts and runtime composition preserve the delivery boundary",
  () => {
    it("accepts a bare prose-required relay and only Source-authored labels", async () => {
      const { checkSourceGearsContract, parseGearsContract } = await import(
        pathToFileURL(join(compiler!, "dist/verify-source.js")).href
      );
      const source =
        "# Inspect\n\nCaptain shall give Inspector this instruction:\n\n```markdown\nInspect the supplied evidence.\n```\n\nCaptain shall relay the evidence in quotes (`>`).\n";
      const gears = (relay: string) =>
        `# Inspect\n\n### INSPECT-1\n\nWhen inspection starts, Captain shall prompt Inspector:\n\n> Inspect the supplied evidence.\n>\n> ${relay}\n`;
      expect(checkSourceGearsContract(source, gears("> <evidence>"))).toEqual(
        [],
      );
      expect(
        checkSourceGearsContract(source, gears("<evidence>")),
      ).toHaveLength(1);
      const [parsed] = parseGearsContract(gears("> <evidence>"));
      const input = {
        stateId: "inspect",
        role: "inspector",
        sourceItem: parsed.id,
        prompt: parsed.prompt.join("\n"),
        result: { done: "Inspection is complete." },
        evidence: exactEvidence,
      };
      expect(defaultComposePlayerPrompt(input)).toBe(
        `Inspect the supplied evidence.\n\n> ${exactEvidence}`,
      );
      expect(
        checkSourceGearsContract(source, gears("> Evidence: <evidence>")),
      ).toEqual([
        'INSPECT-1: prompt line is not an authored fragment: "> Evidence: <evidence>"',
      ]);
      expect(
        checkSourceGearsContract(
          source + "\n> Evidence: <evidence>\n",
          gears("> Evidence: <evidence>"),
        ),
      ).toEqual([]);
    });

    it.each([true, false])(
      "quoted relay present in each governed item: %s",
      async (deliver) => {
        const { parseGearsItems, checkGearsResultContract } = await import(
          pathToFileURL(join(compiler!, "dist/verify.js")).href
        );
        const parts = ["Writer", "Reviewer"].map(
          (role, index) =>
            `### EXAMPLE-${index + 1}\n\nThe evidence <evidence> is authoritative.\nWhen this step starts, Captain shall prompt ${role}:\n\n> Examine the supplied evidence.\n${deliver ? ">\n> > <evidence>\n" : ""}\nResults:\n- \`done\`: The evidence was examined.\n`,
        );
        const gears =
          "# Example\n\nRoles:\n\n- Writer\n- Reviewer\n\n" + parts.join("\n");
        expect(checkGearsResultContract(gears)).toEqual([]);
        const items = parseGearsItems(gears);
        expect(items).toHaveLength(2);
        for (const item of items) {
          const input = {
            stateId: item.id,
            role: item.player.toLowerCase(),
            sourceItem: item.id,
            prompt: item.prompt,
            result: item.result,
            evidence: exactEvidence,
          };
          const prompt = defaultComposePlayerPrompt(input);
          expect(prompt).toBe(
            deliver
              ? `Examine the supplied evidence.\n\n> ${exactEvidence}`
              : "Examine the supplied evidence.",
          );
          expect(prompt.includes(exactEvidence)).toBe(deliver);
        }
      },
    );
  },
);
