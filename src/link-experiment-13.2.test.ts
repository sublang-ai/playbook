// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  copyFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const builder = join(root, "scripts/build-link-experiment-13.2.mjs");
const compiler = process.env.PLAYBOOK_EXPERIMENT_COMPILER;
const read = (file: string): string => readFileSync(file, "utf8");
const hash = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const run = (
  source: string,
  target: string,
  mode: "--full" | "--baseline",
): void => {
  execFileSync(process.execPath, [builder, source, target, mode], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

it("describes the two explicit experiment modes without assembling a candidate", () => {
  expect(
    execFileSync(process.execPath, [builder, "--help"], { encoding: "utf8" }),
  ).toContain("(--baseline | --full)");
  expect(() =>
    execFileSync(
      process.execPath,
      [builder, "unused", "unused", "--full", "--baseline"],
      { stdio: "pipe" },
    ),
  ).toThrow(/mutually exclusive/);
});

// Run against an actual frozen SLC installation. Only its declared file inputs
// are copied into rejection fixtures; no fabricated published definitions.
describe.runIf(compiler !== undefined)(
  "13.2 experiment CLI with real frozen semantic inputs",
  () => {
    function fixture(scratch: string): string {
      const destination = join(scratch, "compiler");
      const pipeline = join(compiler!, "pipelines/playbook");
      const sidecar = JSON.parse(read(join(pipeline, "slc.pin-inputs.json")));
      const files = new Set<string>([
        "node_modules/@sublang/playbook/package.json",
        "pipelines/playbook/slc.pin-inputs.json",
      ]);
      for (const phase of ["text2gears", "gears2fsm", "optimize", "link"]) {
        files.add(`pipelines/playbook/${phase}.md`);
        files.add(`node_modules/@sublang/playbook/slc/${phase}.md`);
        for (const locator of sidecar.closures[phase])
          files.add(relative(compiler!, resolve(pipeline, locator)));
      }
      for (const file of files) {
        mkdirSync(dirname(join(destination, file)), { recursive: true });
        writeFileSync(
          join(destination, file),
          readFileSync(join(compiler!, file)),
        );
      }
      return destination;
    }

    it("builds the one-section pair and retains every ordinary input through real SLC discovery/closure", async () => {
      const scratch = mkdtempSync(join(tmpdir(), "playbook-13.2-pair-"));
      try {
        const baseline = join(scratch, "baseline");
        const full = join(scratch, "full");
        run(compiler!, baseline, "--baseline");
        run(compiler!, full, "--full");
        const a = JSON.parse(read(join(baseline, "experiment-proof.json")));
        const b = JSON.parse(read(join(full, "experiment-proof.json")));
        const source = read(join(root, "slc/link.md"));
        const start = source.indexOf(
          "## Optional deterministic materialization\n",
        );
        const end = source.indexOf("## PlaybookRuntime contract\n", start);
        expect(read(join(full, "playbook/link.md"))).toBe(source);
        expect(read(join(baseline, "playbook/link.md"))).toBe(
          source.slice(0, start) + source.slice(end),
        );
        expect(a.ordinarySemanticInputs).toEqual(b.ordinarySemanticInputs);
        expect(a.compilerInventory).toEqual(b.compilerInventory);
        expect(a.compilerInventory["dist/pipeline.js"].sha256).toBe(
          hash(readFileSync(join(compiler!, "dist/pipeline.js"))),
        );
        expect(a.nestedCallSyntaxCorrection).toEqual(
          b.nestedCallSyntaxCorrection,
        );
        expect(a.nestedCallSyntaxCorrection.priorCommonSha256).toBe(
          "56f414ec3243fda97bb847871b460fdaaf0bba1585627e0897ccdf95a80d7aa4",
        );
        expect(a.nestedCallSyntaxCorrection.intent).toBe("IR-088");
        expect(a.sourceStateProducerCorrections).toEqual(
          b.sourceStateProducerCorrections,
        );
        expect(a.sourceStateProducerCorrections.priorCommonSha256).toBe(
          "4e840accb47c1924be6e63a483f928a592d36edb07c57be82dbecff59b022ce9",
        );
        expect(
          a.sourceStateProducerCorrections.edits.map(
            (edit: { intent: string }) => edit.intent,
          ),
        ).toEqual(["IR-091", "IR-091"]);
        expect(a.nestedCallProducerCorrections).toEqual(
          b.nestedCallProducerCorrections,
        );
        expect(a.nestedCallProducerCorrections.priorCommonSha256).toBe(
          "668b8aad77f16e6cdd0878dd34c536ba06825e3b3b1d0ae509e00aeacd9e1722",
        );
        expect(
          a.nestedCallProducerCorrections.edits.map(
            (edit: { intent: string }) => edit.intent,
          ),
        ).toEqual(["IR-087", "IR-087", "IR-088"]);
        expect(a.authoredQuestionCorrection).toEqual(
          b.authoredQuestionCorrection,
        );
        expect(a.authoredQuestionCorrection.priorCommonSha256).toBe(
          "c38555a7e5e1d33d0c1c71d34beb3b581e62abea819722905ae1af87775922ae",
        );
        expect(a.authoredQuestionCorrection.intent).toBe("IR-085");
        expect(a.representationCorrections).toEqual(
          b.representationCorrections,
        );
        expect(a.representationCorrections.priorCommonSha256).toBe(
          "1a7d9bb8b29bfa40de8ae14f001dd5eeedc51da140fcecfa61698f4282ce13db",
        );
        expect(a.boundaryCorrections).toEqual(b.boundaryCorrections);
        expect(a.boundaryCorrections.priorCommonHashes).toEqual({
          text2gears:
            "bbefc6806bd84c5b181ef1014a7cbe2d21663be3ce4e2098499b07b134835970",
          link: "89e40b53e2bbed25eabceb57a4e61ce27a2fbee14d0cd886215a66ef0160bc86",
          producer:
            "7059aefbdaee40a8fc9abb1973627e6ec891076a03c9571682b8a925ea1d139a",
          helper:
            "eeed4082c2bb0b0bdb9b8685b16ba4bdb6e70b418e171f851cfb1a9dd6c861bf",
        });
        expect(a.publicCatalog).toEqual(b.publicCatalog);
        expect(a.publicCatalog.literalTargetBindings).toEqual({
          review: "review",
          decide: "decide",
          code: "code",
          branch: "branch",
          pr: "pr",
        });
        for (const output of [baseline, full]) {
          expect(read(join(output, "playbook/text2gears.md"))).toBe(
            read(join(root, "slc/text2gears.md")),
          );
          expect(read(join(output, "playbook/text2gears.md"))).toContain(
            "When Source requires a terminal return to the caller",
          );
          expect(read(join(output, "playbook/text2gears.md"))).toContain(
            "a bare quoted prompt-content line, exactly `> <token>`, written as `> > <token>` in the GEARS file",
          );
          expect(read(join(output, "playbook/text2gears.md"))).toContain(
            "an explicit terminal-return clause in the relevant Results description",
          );
          expect(read(join(output, "playbook/text2gears.md"))).toContain(
            "A `Results:` block continues until the next item or section heading",
          );
          expect(read(join(output, "playbook/text2gears.md"))).toContain(
            "shall declare `question: <verbatim final text>` as an output property",
          );
          expect(read(join(output, "playbook/text2gears.md"))).toContain(
            "Text2gears shall not insert sequencing words such as `first`, `then`, `next`",
          );
          expect(read(join(output, "playbook/gears2fsm.md"))).toContain(
            "The call state and every ancestor state, including the machine root, shall omit",
          );
          expect(read(join(output, "playbook/gears2fsm.md"))).toContain(
            "omit an `onDone` transition whose guard",
          );
          expect(read(join(output, "playbook/gears2fsm.md"))).toContain(
            "deterministically knowable from execution state",
          );
          expect(read(join(output, "playbook/gears2fsm.md"))).toContain(
            "backend continuation token is not durable Source history",
          );
        }
        expect(Object.keys(a.outputs).sort()).toEqual(
          [
            ...[
              "text2gears.md",
              "gears2fsm.md",
              "optimize.md",
              "link.md",
              "materialize-link.mjs",
              "workflow-contracts.json",
              "slc.pin-inputs.json",
            ].map((name) => `playbook/${name}`),
            ...["text2gears.md", "gears2fsm.md", "link.md"].map(
              (name) =>
                `playbook/_inputs/node_modules/@sublang/playbook/slc/${name}`,
            ),
            "playbook/_inputs/node_modules/@sublang/spex/scaffold/specs/meta.md",
            "playbook/_inputs/node_modules/@sublang/spex/scaffold/i18n/zh/specs/meta.md",
            "playbook/_inputs/package-lock.json",
          ].sort(),
        );
        const discovery = await import(
          pathToFileURL(join(compiler!, "dist/pipeline.js")).href
        );
        const closureApi = await import(
          pathToFileURL(join(compiler!, "dist/pin-closure.js")).href
        );
        const markdown = await import(
          pathToFileURL(join(root, "scripts/check-links.mjs")).href
        );
        for (const output of [baseline, full]) {
          const proof = JSON.parse(read(join(output, "experiment-proof.json")));
          const directory = join(output, "playbook");
          expect(existsSync(join(directory, "slc.pins.json"))).toBe(false);
          const loaded = await discovery.loadPipeline(directory);
          expect(
            loaded.phases.map((phase: { name: string }) => phase.name),
          ).toEqual(["text2gears", "gears2fsm"]);
          expect(
            loaded.passes.map((phase: { name: string }) => phase.name),
          ).toEqual(["optimize"]);
          expect(loaded.linkFile).toBe(join(directory, "link.md"));
          for (const [name, record] of Object.entries(proof.outputs) as [
            string,
            { sha256: string; bytes: number },
          ][]) {
            const bytes = readFileSync(join(output, name));
            expect(hash(bytes), name).toBe(record.sha256);
            expect(bytes.length, name).toBe(record.bytes);
            if (name !== "playbook/link.md")
              expect(a.outputs[name], name).toEqual(b.outputs[name]);
          }
          const sidecar = JSON.parse(
            read(join(directory, "slc.pin-inputs.json")),
          );
          for (const phase of ["text2gears", "gears2fsm", "optimize", "link"]) {
            const actual: Set<string> = await closureApi.deriveClosure(
              directory,
              ".",
              `${phase}.md`,
              phase,
            );
            expect([...actual].sort()).toEqual(
              [
                join(directory, `${phase}.md`),
                ...sidecar.closures[phase].map((p: string) =>
                  join(directory, p),
                ),
              ].sort(),
            );
            // Follow the actual active definitions, not the copied published
            // evidence: every adjacent phase reference must be protected too.
            for (const { target } of markdown.linksOf(
              read(join(directory, `${phase}.md`)),
            )) {
              const local =
                /^(text2gears\.md|gears2fsm\.md|optimize\.md|link\.md|workflow-contracts\.json)(?:#|$)/.exec(
                  target,
                );
              if (local)
                expect(
                  actual.has(join(directory, local[1])),
                  `${phase} -> ${target}`,
                ).toBe(true);
            }
            expect(actual.has(join(directory, "workflow-contracts.json"))).toBe(
              true,
            );
            for (const input of proof.ordinarySemanticInputs[phase]) {
              expect(actual.has(join(directory, input.rewrittenLocator))).toBe(
                true,
              );
              expect(
                hash(
                  readFileSync(
                    resolve(
                      compiler!,
                      "pipelines/playbook",
                      input.originalLocator,
                    ),
                  ),
                ),
              ).toBe(input.sha256);
              expect(
                hash(readFileSync(join(directory, input.rewrittenLocator))),
              ).toBe(input.sha256);
            }
          }
          const linkClosure: Set<string> = await closureApi.deriveClosure(
            directory,
            ".",
            "link.md",
            "link",
          );
          expect(linkClosure.has(join(directory, "materialize-link.mjs"))).toBe(
            true,
          );
        }
        for (const name of [
          "text2gears.md",
          "gears2fsm.md",
          "optimize.md",
          "link.md",
        ]) {
          const text = read(join(baseline, "playbook", name));
          expect(text).not.toContain("materialize-link.mjs");
          expect(text).not.toContain("Optional deterministic materialization");
        }
        const saved = read(join(baseline, "experiment-proof.json"));
        expect(() => run(compiler!, baseline, "--baseline")).toThrow(
          /Output already exists/,
        );
        expect(read(join(baseline, "experiment-proof.json"))).toBe(saved);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 120_000);

    it.each(["text2gears", "gears2fsm", "optimize", "link"])(
      "rejects modified installed %s before output",
      (phase) => {
        const scratch = mkdtempSync(join(tmpdir(), "playbook-13.2-invalid-"));
        try {
          const copied = fixture(scratch);
          const destination = join(scratch, "refused");
          const definition = join(
            copied,
            `node_modules/@sublang/playbook/slc/${phase}.md`,
          );
          writeFileSync(definition, read(definition) + "\n");
          expect(() => run(copied, destination, "--full")).toThrow(
            /hash mismatch/,
          );
          expect(existsSync(destination)).toBe(false);
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    );

    it.each([
      "version",
      "ordinary-definition",
      "foreign-input",
      "symbolic-input",
    ])("rejects %s without an output or input modification", (fault) => {
      const scratch = mkdtempSync(join(tmpdir(), "playbook-13.2-invalid-"));
      try {
        const copied = fixture(scratch);
        const destination = join(scratch, "refused");
        if (fault === "version") {
          const file = join(
            copied,
            "node_modules/@sublang/playbook/package.json",
          );
          const data = JSON.parse(read(file));
          data.version = "13.1.0";
          writeFileSync(file, JSON.stringify(data));
        } else if (fault === "ordinary-definition") {
          const file = join(copied, "pipelines/playbook/link.md");
          writeFileSync(file, read(file) + "\n");
        } else if (fault === "foreign-input") {
          const file = join(copied, "pipelines/playbook/slc.pin-inputs.json");
          const data = JSON.parse(read(file));
          data.closures.link.push("../../../../foreign-oracle.md");
          writeFileSync(file, JSON.stringify(data));
        } else {
          const file = join(
            copied,
            "node_modules/@sublang/spex/scaffold/specs/meta.md",
          );
          const outside = join(scratch, "outside.md");
          copyFileSync(file, outside);
          unlinkSync(file);
          symlinkSync(outside, file);
        }
        const savedDefinition = read(
          join(copied, "pipelines/playbook/link.md"),
        );
        expect(() => run(copied, destination, "--baseline")).toThrow();
        expect(existsSync(destination)).toBe(false);
        expect(read(join(copied, "pipelines/playbook/link.md"))).toBe(
          savedDefinition,
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("refuses an output inside the frozen compiler root", () => {
      const scratch = mkdtempSync(join(tmpdir(), "playbook-13.2-boundary-"));
      try {
        const copied = fixture(scratch);
        const destination = join(copied, "refused");
        expect(() => run(copied, destination, "--full")).toThrow(
          /Output must be outside/,
        );
        expect(existsSync(destination)).toBe(false);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  },
);
