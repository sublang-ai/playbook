// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { catalog } from "../scripts/test-support/workflow-contracts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const types = {
  review: "ReviewOutput",
  decide: "DecideOutput",
  code: "CodeOutput",
  branch: "BranchPlaybookOutput",
  pr: "PrPlaybookOutput",
  inspect: "MachineOutput",
};

type Schema = {
  $ref?: string;
  anyOf?: Schema[];
  const?: string | boolean;
  enum?: string[];
  type?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: Schema | false;
  description?: string;
};
function asType(schema: Schema): string {
  if (schema.$ref) return schema.$ref.slice("#/$defs/".length);
  if (schema.anyOf) return "(" + schema.anyOf.map(asType).join(" | ") + ")";
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum)
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.type === "array") return `ReadonlyArray<${asType(schema.items!)}>`;
  if (schema.type === "object") {
    if (!schema.properties)
      return `{ readonly [key: string]: ${asType(schema.additionalProperties as Schema)} }`;
    return (
      "{ " +
      Object.entries(schema.properties)
        .map(
          ([key, value]) =>
            `readonly ${JSON.stringify(key)}${schema.required!.includes(key) ? "" : "?"}: ${asType(value)}`,
        )
        .join("; ") +
      " }"
    );
  }
  if (!["string", "boolean", "null", "number"].includes(schema.type!))
    throw new Error("Unsupported catalog type");
  return schema.type!;
}
function typeDiagnostics(input: typeof catalog) {
  const filename = join(root, "catalog-consumer.mts");
  const declarations = Object.entries(input.$defs).map(
    ([key, value]) => `type ${key} = ${asType(value as Schema)};`,
  );
  const pairs = Object.entries(types).flatMap(([id, name]) => [
    `import type { ${name} as Actual_${id} } from './reference/sdlc/${id}.playbook/${id}.fsm.js';`,
    `type Declared_${id} = ${asType(input.workflows[id].output)};`,
    `export const forward_${id}: [Declared_${id}] extends [Actual_${id}] ? true : false = true;`,
    `export const backward_${id}: [Actual_${id}] extends [Declared_${id}] ? true : false = true;`,
  ]);
  const text = [...declarations, ...pairs].join("\n");
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    types: ["node"],
    typeRoots: [join(root, "node_modules/@types")],
  };
  const host = ts.createCompilerHost(options);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (path, language, onError, fresh) =>
    path === filename
      ? ts.createSourceFile(path, text, language, true)
      : getSource(path, language, onError, fresh);
  return ts
    .getPreEmitDiagnostics(ts.createProgram([filename], options, host))
    .map((d) => ({
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    }));
}

it("publishes exact builtin public interface shapes without an implementation dependency", () => {
  expect(Object.keys(catalog).sort()).toEqual(
    [
      "$defs",
      "artifactSchema",
      "description",
      "literalTargetBindings",
      "package",
      "runtimeAbi",
      "schema",
      "workflows",
    ].sort(),
  );
  expect(catalog).toMatchObject({
    schema: "sublang.playbook.workflow-contracts.v1",
    package: "@sublang/playbook",
    artifactSchema: 3,
    runtimeAbi: 1,
  });
  expect(Object.keys(catalog.workflows).sort()).toEqual(
    Object.keys(types).sort(),
  );
  expect(catalog.literalTargetBindings).toEqual(
    Object.fromEntries(Object.keys(types).map((id) => [id, id])),
  );
  const allowed = new Set([
    "$ref",
    "anyOf",
    "const",
    "enum",
    "type",
    "items",
    "properties",
    "required",
    "additionalProperties",
    "description",
  ]);
  const inspect = (schema: Schema): void => {
    expect(Object.keys(schema).every((key) => allowed.has(key))).toBe(true);
    if (schema.$ref)
      expect(
        Object.hasOwn(catalog.$defs, schema.$ref.slice("#/$defs/".length)),
      ).toBe(true);
    for (const child of schema.anyOf ?? []) inspect(child);
    for (const child of Object.values(schema.properties ?? {})) inspect(child);
    if (schema.items) inspect(schema.items);
    if (schema.additionalProperties) inspect(schema.additionalProperties);
  };
  for (const member of Object.values(catalog.workflows) as Array<{
    callInput: string;
    output: Schema;
  }>) {
    expect(Object.keys(member).sort()).toEqual(["callInput", "output"]);
    expect(member.callInput).toBe("text");
    inspect(member.output);
  }
  for (const value of Object.values(catalog.$defs)) inspect(value as Schema);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(manifest.files).toContain("slc/workflow-contracts.json");
  expect(manifest.exports["./slc/*"]).toBe("./slc/*");
  expect(
    createRequire(join(root, "package.json")).resolve(
      "@sublang/playbook/slc/workflow-contracts.json",
    ),
  ).toBe(join(root, "slc/workflow-contracts.json"));
});

it("agrees bidirectionally with all exported public output types and catches an invented REVIEW interface", () => {
  expect(typeDiagnostics(catalog)).toEqual([]);
  const wrong = structuredClone(catalog);
  wrong.workflows.review.output = {
    type: "object",
    properties: {
      reviewedCommit: { type: "string" },
      unsettledFindings: { type: "number" },
      revision: { type: "string" },
    },
    required: ["reviewedCommit", "unsettledFindings", "revision"],
    additionalProperties: false,
  };
  expect(typeDiagnostics(wrong).some((d) => d.code === 2322)).toBe(true);
}, 30000);

it("keeps dependency-interface failures distinct from authored behavioral ambiguity", () => {
  const definition = readFileSync(join(root, "slc/gears2fsm.md"), "utf8");
  expect(definition).toContain("[workflow contracts](workflow-contracts.json)");
  expect(definition).toContain(
    "catalog's `literalTargetBindings` as its default",
  );
  expect(definition).toContain(
    "binding overrides a default and requires the replacement's own public interface",
  );
  expect(definition).toContain(
    "Runtime hosts shall honor the compiled dependency bindings as external ABIs",
  );
  expect(definition).toContain("read its exact\noutput interface");
  expect(definition).toContain(
    "The shared bridge correlates the invocation and its supplied input scope",
  );
  expect(definition).toContain(
    "report `BLOCKED` with that missing\ncompiler input",
  );
  expect(definition).toContain(
    "still requires the host's source-clarification protocol",
  );
});

it("holds a builtin compiled under its own id to the catalog's interface", () => {
  const flat = (file: string) =>
    readFileSync(join(root, file), "utf8").replace(/\s+/g, " ");
  const text2gears = flat("slc/text2gears.md");
  expect(text2gears).toContain("[workflow contracts](workflow-contracts.json)");
  expect(text2gears).toContain(
    "the compiled workflow is held to that builtin's declared output interface",
  );
  expect(text2gears).toContain(
    "shall take the interface's property name",
  );
  expect(text2gears).toContain(
    "whether the value is semantic, presentation, or effect-owned, while the commit a call itself creates keeps the canonical `latestCommit`",
  );
  expect(text2gears).toContain(
    "report it as an incompatible compiler input rather than rename or invent",
  );
  const gears2fsm = flat("slc/gears2fsm.md");
  expect(gears2fsm).toContain(
    "the declared terminal output shall be exactly that builtin's public interface",
  );
  expect(gears2fsm).toContain(
    "reported as an incompatible compiler input under [Nested playbook calls](#nested-playbook-calls) rather than expressed by an invented or renamed outcome",
  );
  const sidecar = JSON.parse(
    readFileSync(join(root, "slc/slc.pin-inputs.json"), "utf8"),
  );
  expect(sidecar.closures.text2gears).toContain("workflow-contracts.json");

  // The maintained GEARS already name the returned semantic and presentation
  // values as the catalog does; a recompile must keep doing so.
  const declared = (workflow: string): Set<string> => {
    const gears = readFileSync(
      join(root, `reference/sdlc/${workflow}.playbook/${workflow}.gears.md`),
      "utf8",
    );
    const names = new Set<string>();
    for (const line of gears.split("\n")) {
      const marker = line.indexOf("Output shall include");
      if (marker === -1) continue;
      for (const match of line.slice(marker).matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)(?::|`)/g)) {
        names.add(match[1]);
      }
    }
    return names;
  };
  const returned: Record<string, string[]> = {
    branch: ["branch", "issueSummary", "coderOutput"],
    pr: ["pullRequest", "pullRequestUrl", "coderOutput"],
    review: ["evaluatedRevision"],
    inspect: ["report"],
  };
  for (const [workflow, names] of Object.entries(returned)) {
    const gears = declared(workflow);
    for (const name of names) {
      expect(gears.has(name), `${workflow} declares ${name}`).toBe(true);
      expect(
        catalog.workflows[workflow as keyof typeof catalog.workflows].output,
        `${workflow} interface returns ${name}`,
      ).toSatisfy((output: unknown) => JSON.stringify(output).includes(`"${name}"`));
    }
  }
});

const compiler = process.env.PLAYBOOK_EXPERIMENT_COMPILER;
describe.runIf(compiler !== undefined)("real SLC closure discovery", () => {
  it("includes the packaged catalog and changes identity when that external interface changes", async () => {
    const harness = await import(
      pathToFileURL(join(compiler!, "scripts/benchmark-compile.mjs")).href
    );
    const discovery = await harness.pipelineInputDiscovery(compiler);
    const directory = await mkdtemp(
      join(tmpdir(), "workflow-contract-closure-"),
    );
    try {
      const pipeline = join(directory, "playbook");
      await mkdir(pipeline);
      await writeFile(
        join(pipeline, "gears2fsm.md"),
        "# Compile\n\n[Public interface](workflow-contracts.json)\n",
      );
      await writeFile(
        join(pipeline, "workflow-contracts.json"),
        JSON.stringify(catalog),
      );
      await writeFile(
        join(pipeline, "slc.pin-inputs.json"),
        JSON.stringify({
          schema: "sublang.slc.pin-inputs.v1",
          closures: { gears2fsm: ["workflow-contracts.json"] },
        }),
      );
      const before = await harness.pipelineInputIdentity(pipeline, discovery);
      const changed = structuredClone(catalog);
      changed.workflows.review.output.properties.evaluatedRevision.description +=
        " Published clarification.";
      await writeFile(
        join(pipeline, "workflow-contracts.json"),
        JSON.stringify(changed),
      );
      const after = await harness.pipelineInputIdentity(pipeline, discovery);
      expect(before.status).toBe("complete");
      expect(after.status).toBe("complete");
      expect(JSON.stringify(before)).toContain("workflow-contracts.json");
      expect(before).not.toEqual(after);
      const sidecar = JSON.parse(
        await readFile(join(root, "slc/slc.pin-inputs.json"), "utf8"),
      );
      expect(sidecar.closures.gears2fsm).toContain("workflow-contracts.json");
      expect(sidecar.closures.link).toContain("workflow-contracts.json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
