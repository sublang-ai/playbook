// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const catalog = JSON.parse(
  readFileSync(
    new URL("../../slc/workflow-contracts.json", import.meta.url),
    "utf8",
  ),
);

// Test-only interpreter for the catalog's documented vocabulary. The runtime
// keeps its existing validators and does not import this module or the catalog.
export function matches(schema, value) {
  if (schema.$ref)
    return matches(catalog.$defs[schema.$ref.slice("#/$defs/".length)], value);
  if (schema.anyOf)
    return schema.anyOf.some((member) => matches(member, value));
  if (Object.hasOwn(schema, "const")) return value === schema.const;
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === "null") return value === null;
  if (schema.type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "string" || schema.type === "boolean")
    return typeof value === schema.type;
  if (schema.type === "array")
    return (
      Array.isArray(value) && value.every((item) => matches(schema.items, item))
    );
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return false;
    const properties = schema.properties ?? {};
    if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key)))
      return false;
    return Object.entries(value).every(([key, item]) =>
      Object.hasOwn(properties, key)
        ? matches(properties[key], item)
        : schema.additionalProperties !== false &&
          matches(schema.additionalProperties, item),
    );
  }
  throw new Error("Unknown catalog schema");
}

export function assertWorkflowTerminal(id, result) {
  assert.equal(result.outcome, "terminal");
  const schema = catalog.workflows[id].output;
  assert(
    matches(schema, result.output),
    `${id} public runtime output drifted from its catalog`,
  );
  // Negative controls derive from actual returned data, not a second fixture
  // pretending to implement the workflow's output.
  const branches = schema.anyOf ?? [schema];
  const accepted = branches.filter((branch) => matches(branch, result.output));
  for (const key of new Set(
    accepted.flatMap((branch) => branch.required ?? []),
  )) {
    const missing = { ...result.output };
    delete missing[key];
    assert(!matches(schema, missing), `${id} accepts missing required ${key}`);
    assert(
      !matches(schema, { ...result.output, [key]: [] }),
      `${id} accepts ill-typed ${key}`,
    );
  }
  assert(
    !matches(schema, { ...result.output, inventedInterfaceField: true }),
    `${id} accepts an undeclared interface field`,
  );
}
