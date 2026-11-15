// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGearsContract } from "../scripts/check-slc-source-gears.mjs";
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

// compiler-prompt-relays-9: the derivation a compiled FSM carries for a
// placeholder defined as a labelled section, exactly as gears2fsm states it;
// the definition names the opening label and the labels that end the section.
function labelledSection(text: string, label: string, endings: readonly string[]): string {
  const raw = text.split("\n");
  const quoted = raw.every((line) => line.trim() === "" || line.startsWith(">"));
  const lines = quoted ? raw.map((line) => line.replace(/^> ?/, "")) : raw;
  const whole = lines.join("\n").trim();
  const start = lines.findIndex((line) => line.startsWith(label));
  if (start === -1) return whole;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => endings.some((ending) => line.startsWith(ending)));
  const section = [lines[start]!.slice(label.length), ...(end === -1 ? rest : rest.slice(0, end))]
    .join("\n")
    .trim();
  return section === "" ? whole : section;
}

it("derives a Source-defined labelled section wherever the relayed text is stored", async () => {
  const producer = collapseWhitespace(text2gearsDefinition);
  const fsm = collapseWhitespace(gears2fsmDefinition);
  // compiler-prompt-relays-7: a requirement item keeping the Source's words,
  // named as authored, no producer.
  expect(producer).toContain(
    "A placeholder the Source defines as a labelled section of another relayed value, naming the label that opens the section and the labels that end it — `<original-intent>` as the `Original intent:` section of the caller's request, which runs to the `Review scope:` line or to the end of the request, for instance — is derived, not produced: text2gears shall state that definition in a requirement item that keeps the Source's defining words, name the placeholder as the Source does, and declare no result property for it",
  );
  // compiler-prompt-relays-9: the rule, cited where placeholder binding is
  // described.
  expect(fsm).toContain(
    "a created-commit or labelled-section placeholder binds as [Context and prompts](#context-and-prompts) states",
  );
  for (const clause of [
    "A placeholder the GEARS defines as a labelled section of another relayed text binds to a typed context field named by its canonical mapping.",
    "The definition names the label that opens the section and the labels that end it",
    "The machine derives the field deterministically in the entry action or transition that stores the text and again in every action that replaces it",
    "the text as read is the text itself, except that where every non-blank line begins with `>`, each line is read without that marker and one optional space after it",
    "the section is the lines of the text as read from the first line that begins with the opening label, the label removed, through the line before the first later line that begins with an ending label, or through the last line, with the result trimmed; a line that merely looks labelled, such as `Note:` or `Constraints:`, stays in the section",
    "where no line begins with the opening label, or the section is empty once trimmed — its label directly followed by an ending label or by the end of the text — the field is the whole text as read, trimmed",
    "The derived field is ordinary context that actor inputs relay, never a player or judge output",
  ]) {
    expect(fsm).toContain(clause);
  }

  // No maintained Source relays a derived section in this release (DR-068
  // records why), so the stated derivation is checked against its cases
  // through the reference implementation above.
  const cases = [
    {
      name: "a caller's quoted labelled request",
      text:
        "> Original intent: Fix the bug.\n" +
        "> Review scope: the commit abc123 from this coding phase and its resulting repository state.\n" +
        "> Coder output: Committed the change.",
      section: "Fix the bug.",
    },
    {
      name: "a multi-line quoted section whose look-alike labelled lines stay in it",
      text:
        "> Original intent: Ship the parser.\n> Constraints: keep the grammar stable.\n>\n" +
        "> Note: docs follow.\n> Review scope: the commit def456.\n> Coder output: Done.\n\n" +
        "> Current IR task: Task 2.",
      section: "Ship the parser.\nConstraints: keep the grammar stable.\n\nNote: docs follow.",
    },
    {
      name: "an unquoted request whose section runs to the end and keeps its quoted lines",
      text:
        "Context: see IR-070.\nOriginal intent:\n  Rename the flag.\n> Error: flag unknown\n" +
        "Run results: suite passed.\n",
      section: "Rename the flag.\n> Error: flag unknown\nRun results: suite passed.",
    },
    {
      name: "an empty section",
      text: "> Original intent:\n> Review scope: the commit abc123.",
      section: "Original intent:\nReview scope: the commit abc123.",
    },
    {
      name: "an unlabelled request",
      text: "  Review the latest commit.\n",
      section: "Review the latest commit.",
    },
    {
      name: "an unlabelled quoted request",
      text: "> Review the branch.\n> Mind the docs.",
      section: "Review the branch.\nMind the docs.",
    },
  ];
  for (const { name, text, section } of cases) {
    expect(labelledSection(text, "Original intent:", ["Review scope:"]), name).toBe(section);
  }
});
