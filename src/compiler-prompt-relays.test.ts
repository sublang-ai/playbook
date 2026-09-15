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
const text2gearsDefinition = readFileSync(
  new URL("../slc/text2gears.md", import.meta.url),
  "utf8",
);
const gears2fsmDefinition = readFileSync(
  new URL("../slc/gears2fsm.md", import.meta.url),
  "utf8",
);
const playbookSpec = readFileSync(
  new URL("../specs/packages/playbook.md", import.meta.url),
  "utf8",
);
const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ");

it("clarifies that prose-authored relays govern every applicable complete acting prompt", () => {
  expect(text2gearsDefinition).toContain(
    "Apply each Source-authored relay to every acting behavior it governs, including relays described only in prose.",
  );
  expect(text2gearsDefinition).toContain(
    "Mentioning a value in a condition, result contract, or machine context does not deliver it to the acting role; its complete prompt blockquote shall carry the required quoted placeholder.",
  );
});

it("distinguishes ordinary runtime placeholders from local-role prompt identity placeholders", () => {
  const fsmDefinition = collapseWhitespace(gears2fsmDefinition);
  const spec = collapseWhitespace(playbookSpec);
  expect(fsmDefinition).toContain(
    "Except for a Source-declared local-role prompt-identity placeholder, every runtime-value placeholder established by Source in a direct-Captain or delegated-player prompt shall be backed by a typed ordinary actor-input field populated from typed machine context",
  );
  expect(fsmDefinition).toContain(
    "Leaving an ordinary runtime-value placeholder literal, replacing it with an empty default because its field was omitted, or making the linker recover it from untyped context is malformed.",
  );
  expect(fsmDefinition).toContain(
    "When Source declares a placeholder as the current identity of a local acting role, preserve the placeholder literal in the FSM prompt and do not add any identity-value field to machine input, runtime options, machine context, or actor input, required or optional.",
  );
  expect(fsmDefinition).toContain(
    "The linker shall resolve the placeholder at prompt-composition time by calling the invocation-scoped `promptIdentity(roleId)` lookup for the declared local role identified by Source.",
  );
  expect(fsmDefinition).toContain(
    "A non-identity placeholder whose value Source assigns to the host",
  );
  expect(fsmDefinition).toContain(
    "A Source-declared local-role prompt-identity placeholder is the explicit exception; it resolves from the invocation-scoped `promptIdentity` lookup and is not persisted as host configuration.",
  );
  expect(spec).toContain(
    "Typed actor-input field backed by typed machine context, using the canonical kebab-token-to-camel-field mapping unless the compiler contract declares an explicit exception.",
  );
  expect(spec).toContain(
    "Preserve the literal token in the FSM prompt without an identity-value field in machine input, options, context, or actor input, whether required or optional.",
  );
  expect(spec).toContain(
    "Resolve only through the invocation-scoped `promptIdentity(roleId)` lookup for the declared local role identified by Source under [[playbook-runtime-15](playbook-runtime.md#playbook-runtime-15)]",
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
