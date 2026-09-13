#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Repository-only experiment assembly; no runtime/dependency adoption or pins.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  lstat,
  realpath,
  readdir,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: node scripts/build-link-experiment-13.2.mjs <frozen-compiler-root> <new-output-root> (--baseline | --full)";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(usage + "\n");
  process.exit(0);
}
assert(
  args.length === 3 && ["--baseline", "--full"].includes(args[2]),
  usage + "; modes are mutually exclusive",
);
const [compilerArgument, targetArgument, modeArgument] = args;
// Resolve system aliases (for example macOS /var) once at each trusted root;
// internal symbolic input paths remain forbidden by readRegular.
const compiler = await realpath(resolve(compilerArgument));
const requestedTarget = resolve(targetArgument);
const target = join(
  await realpath(dirname(requestedTarget)),
  basename(requestedTarget),
);
const mode = modeArgument.slice(2);
const sourceRoot = await realpath(
  fileURLToPath(new URL("../", import.meta.url)),
);
for (const boundary of [compiler, sourceRoot]) {
  const rel = relative(boundary, target);
  assert(
    rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel),
    "Output must be outside the supplied compiler and builder checkout",
  );
}
const pipeline = join(compiler, "pipelines/playbook");
const installed = join(compiler, "node_modules/@sublang/playbook");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const published = {
  "text2gears.md":
    "48a6a5d3f02a1d90dcc0883170da74e16c29b1554533913eb4fd7cefc49251bb",
  "gears2fsm.md":
    "c549458f39337b4ce1697e1103ee2010656ced0b8a08b2fe57a103f9186c2b1e",
  "link.md": "294f41c6ebeeb970fb53d2b801e2769dbff3c18a5910b7569c5b547b3daaea5d",
  "optimize.md":
    "dc8c59f02c73165f1e65b40187f2dc07def9ba43b884a04d992e400c20db6e66",
};
const commonHashes = {
  text2gears:
    "1f146b9cb00a6de016c5e02a528825daa5ce3bda055eae553e1545b6dde0b639",
  link: "a5c82f9aa30814039f5282d2644373134c076bf9795a6a7df030dc31b6d981a7",
  producer: "5aefade11a4f45b3ebb269b921f1f013363ee129a449b368ec7f83dd0cbf75ee",
  helper: "5024778548509370d899f3709829fd7609d67bc4fe5d72b2c76d5d0ab26f59eb",
  catalog: "de862f4b772ffb6860c2cab3ed75ab281b378dffa0a6217ebc8e049302c05dd3",
  optimizer: "4f3111e1a8a2124c8a174d63752be368ab763493b603f7a4df4bed60c264cfb9",
};
const v5Hashes = {
  text2gears:
    "bbefc6806bd84c5b181ef1014a7cbe2d21663be3ce4e2098499b07b134835970",
  link: "89e40b53e2bbed25eabceb57a4e61ce27a2fbee14d0cd886215a66ef0160bc86",
  producer: "7059aefbdaee40a8fc9abb1973627e6ec891076a03c9571682b8a925ea1d139a",
  helper: "eeed4082c2bb0b0bdb9b8685b16ba4bdb6e70b418e171f851cfb1a9dd6c861bf",
};
const boundaryCorrections = {
  text2gears: [
    {
      intent: "IR-083",
      current:
        "If Source names the relayed value but supplies no template, text2gears shall emit a bare quoted prompt-content line, exactly `> <token>`, written as `> > <token>` in the GEARS file because the first marker encloses the prompt and the second is literal content, without an added label or surrounding prose, and shall not summarize, paraphrase, or invent the relayed value.\n",
      prior:
        "If Source names the relayed value but supplies no template, text2gears shall emit a bare quoted placeholder line, exactly `> <token>`, without an added label or surrounding prose, and shall not summarize, paraphrase, or invent the relayed value.\n",
    },
  ],
  link: [
    {
      intent: "IR-082",
      current:
        "The linked module shall export public synchronous pure `validateOptions(value: unknown): PlaybookRuntimeOptions` and bind that same function as the shared spec's `snapshotOptions`.\nIt shall normalize only absent `undefined` to an empty option slice, retain actual required options and source-authored defaults, reject null, non-JSON values, unknown keys and invalid declared values, and return a detached immutable plain-JSON option record without runtime construction or live host capabilities.\nBoss text supplied by the entry event is not a required startup option unless Source independently requires it before the first Boss turn; a generated required type annotation alone is not that evidence.\nA source-appropriate optional seed may remain, and genuine required bootstrap catalogs or other options shall not be erased or filled with invented defaults.\n\n",
      prior: "",
    },
    {
      intent: "IR-082",
      current:
        "- Exports the public `validateOptions` function specified above and supplies\n  it as the spec's identical `snapshotOptions` callback:",
      prior:
        "- Supplies the spec's `snapshotOptions` with the same options-validation\n  semantics previously generated inline:",
    },
  ],
  producer: [
    {
      intent: "IR-082",
      current:
        "A generated required input annotation alone is not evidence of that independent Source bootstrap requirement.\n",
      prior: "",
    },
    {
      intent: "IR-081",
      current:
        "The artifact shall not bind or construct a runner or bake in concrete actor\nimplementations. A named stateless public boundary validator is permitted;\nimporting it shall not construct a runtime, bind host capabilities, or call ports.\nEach actor placeholder shall fail explicitly (for example,\n",
      prior:
        "The artifact shall not import a runner or bake in concrete actor\nimplementations. Each actor placeholder shall fail explicitly (for example,\n",
    },
    {
      intent: "IR-081",
      current:
        "Recognize authored rejected child results with the existing named\n`validatePlaybookCallResult` export from `@sublang/playbook/xstate-runtime`\nand the type-only `PlaybookCallResult` from `@sublang/playbook/runtime`:\n\n```typescript\nimport { validatePlaybookCallResult } from '@sublang/playbook/xstate-runtime';\nimport type { PlaybookCallResult } from '@sublang/playbook/runtime';\n\nexport function authoredChildResult(error: unknown, expectedPlaybookId: string): PlaybookCallResult | undefined {\n  if (!(error instanceof Error)) return undefined;\n  try {\n    const result = validatePlaybookCallResult(\n      (error as Error & { result?: unknown }).result,\n      expectedPlaybookId,\n    );\n    return result.status !== 'ok' || result.terminal?.kind === 'failure' ? result : undefined;\n  } catch {\n    return undefined;\n  }\n}\n```\n\nPass the actual selected target id from the same source-owned target used by\n`invoke.input`; do not fabricate a request or child-session identity for this\ncheck. The shared bridge owns invocation correlation. Its existing validator\nowns the complete [public result union](link.md#playbookports-contract),\nincluding terminal/state shapes, optional abort error, and JSON validity;\ndo not rewrite those structural checks or redeclare their public types.\nAn invalid result returns no authored outcome and takes the existing\ncontrol-error fallback. A validated successful child output still needs its\nseparate Source-owned acceptance predicate on `onDone`.\nValidate the full public result before projecting only the permitted compact\nevidence; evidence minimization shall not narrow the accepted public union.\nThe helper supplies no workflow route, child-domain predicate, runner or actor\nimplementation. Its ordinary package import is an explicit artifact dependency.\n\n",
      prior:
        "The outer trusted error is an actual `Error` instance and therefore is not a\nplain JSON object. The structural guard shall inspect its public `.result`\nproperty directly, then validate only that nested result before sanitizing it;\nit shall not require the outer error itself to pass a plain-object/JSON guard.\nValidation of that nested public result includes its status-specific required\nmembers and target identity: `playbookId` shall equal the current selected\ntarget, an `error` result shall carry a normalized error, and every optional\nmember that is present shall have the public contract's declared shape. A\nlook-alike such as `{ status: 'error' }` is malformed control data, not an\nauthored child failure, and shall take the fallback `failed` arm without\nappending evidence. The guard shall not fabricate missing identity or error\nmembers merely because the status string happens to be recognized.\nThe public result's declared optional `childSessionId` and `state` members are\nvalid when their shapes satisfy the shared contract; validate and then discard\nthem when building compact Captain evidence. They are not undeclared extras.\nLikewise, the public normalized error may carry its declared optional string\n`stack`; validate it and omit it from the compact `{ name, message }` evidence\nrather than rejecting an otherwise valid authored child result.\nApply the public union exactly: an `aborted` or `error` result shall reject an\n`output` member; `childSessionId`, when present, shall be non-empty; `error`\nshall contain only non-empty `name`, string `message`, and optional string\n`stack`; and `state`, when present, shall validate every declared\n`PlaybookState` member and reject unknown or missing members. Treating an\narbitrary JSON-safe object as a valid `state`, or checking only that these\nmembers have broad string/object types, is not complete public-result\nvalidation.\nIn other words, the guard validates the complete public result it received,\nwhile the action retains only the current selected playbook id, status, and\ncompact error. Do not implement evidence minimization by accepting only the\nthree keys that survive that projection.\n\n",
    },
  ],
  helper: [
    {
      intent: "IR-082",
      current:
        "export function validateOptions(value: unknown): PlaybookRuntimeOptions {",
      prior:
        "function snapshotOptions(value: unknown): PlaybookRuntimeOptions {",
    },
    {
      intent: "IR-082",
      current:
        "const captured = snapshotJsonValue(value === undefined ? {} : value, ${JSON.stringify(`${descriptor.label} runtime options`)});",
      prior:
        "const captured = snapshotJsonValue(value, ${JSON.stringify(`${descriptor.label} runtime options`)});",
    },
    {
      intent: "IR-082",
      current: "  snapshotOptions: validateOptions,\n  machineInput:",
      prior: "  snapshotOptions,\n  machineInput:",
    },
  ],
};
function beforeBoundaryCorrections(kind, text) {
  for (const correction of boundaryCorrections[kind]) {
    assert.equal(
      text.split(correction.current).length,
      2,
      `${kind}: ${correction.intent} correction must occur exactly once`,
    );
    text = text.replace(correction.current, correction.prior);
  }
  verify(
    text,
    v5Hashes[kind],
    `exact v5 ${kind} before common boundary corrections`,
  );
  return text;
}
const grammarInputs = [
  "node_modules/@sublang/spex/scaffold/specs/meta.md",
  "node_modules/@sublang/spex/scaffold/i18n/zh/specs/meta.md",
  "package-lock.json",
];
const packageDefinition = (name) =>
  `node_modules/@sublang/playbook/slc/${name}.md`;
const expectedInputs = {
  text2gears: grammarInputs,
  gears2fsm: [
    packageDefinition("text2gears"),
    packageDefinition("link"),
    ...grammarInputs,
  ],
  link: [
    packageDefinition("text2gears"),
    packageDefinition("gears2fsm"),
    ...grammarInputs,
  ],
  optimize: [
    packageDefinition("text2gears"),
    packageDefinition("gears2fsm"),
    packageDefinition("link"),
    ...grammarInputs,
  ],
};
function verify(bytes, hash, label) {
  assert.equal(sha(bytes), hash, `${label} hash mismatch`);
}
async function absent(destination) {
  try {
    await lstat(destination);
    throw new Error(`Output already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function readRegular(file, boundary) {
  const normalized = resolve(file);
  const rel = relative(boundary, normalized);
  assert(
    rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel),
    `Input escapes its boundary: ${file}`,
  );
  assert(
    (await lstat(normalized)).isFile(),
    `Input is not a regular file: ${file}`,
  );
  assert.equal(
    await realpath(normalized),
    normalized,
    `Input has a symbolic-link path: ${file}`,
  );
  return readFile(normalized);
}
await absent(target);
const packageBytes = await readRegular(
  join(installed, "package.json"),
  compiler,
);
const pkg = JSON.parse(packageBytes);
assert.equal(pkg.name, "@sublang/playbook");
assert.equal(
  pkg.version,
  "13.2.0",
  "This experiment requires installed Playbook 13.2.0",
);
const original = {};
for (const [name, hash] of Object.entries(published)) {
  original[name] = (
    await readRegular(join(installed, "slc", name), compiler)
  ).toString();
  verify(original[name], hash, `installed ${name}`);
  verify(
    await readRegular(join(pipeline, name), compiler),
    hash,
    `ordinary ${name}`,
  );
}
const text2gears = (
  await readRegular(join(sourceRoot, "slc/text2gears.md"), sourceRoot)
).toString();
const relayCorrection =
  "Apply each Source-authored relay to every acting behavior it governs, including relays described only in prose.\nMentioning a value in a condition, result contract, or machine context does not deliver it to the acting role; its complete prompt blockquote shall carry the required quoted placeholder.\n\n";
verify(text2gears, commonHashes.text2gears, "reviewed common text2gears");
const nestedCallSyntaxCorrection = {
  intent: "IR-088",
  current:
    "In both literal and dynamic nested-call forms, the behavior's verb phrase shall\n" +
    "be exact: `Captain shall call playbook ...:`.\n" +
    "Text2gears shall not insert sequencing words such as `first`, `then`, `next`,\n" +
    "or `finally` between `shall` and `call`; required sequencing belongs in the\n" +
    "`When` or `While` clause or in continuation prose around the item.\n",
  prior: "",
};
assert.equal(
  text2gears.split(nestedCallSyntaxCorrection.current).length,
  2,
  "Nested-call syntax correction must occur exactly once",
);
const beforeNestedCallSyntax = text2gears.replace(
  nestedCallSyntaxCorrection.current,
  nestedCallSyntaxCorrection.prior,
);
verify(
  beforeNestedCallSyntax,
  "56f414ec3243fda97bb847871b460fdaaf0bba1585627e0897ccdf95a80d7aa4",
  "v7 common text2gears before nested-call syntax correction",
);
const authoredQuestionCorrection = {
  intent: "IR-085",
  current:
    "When such an authored result asks Boss and waits, its `Results:` description\n" +
    "shall declare `question: <verbatim final text>` as an output property; the\n" +
    "result name or prose saying that a question is asked is not the field\n" +
    "declaration.\n\n",
  prior: "\n",
};
assert.equal(
  text2gears.split(authoredQuestionCorrection.current).length,
  2,
  "Authored-question field correction must occur exactly once",
);
const beforeAuthoredQuestion = beforeNestedCallSyntax.replace(
  authoredQuestionCorrection.current,
  authoredQuestionCorrection.prior,
);
verify(
  beforeAuthoredQuestion,
  "c38555a7e5e1d33d0c1c71d34beb3b581e62abea819722905ae1af87775922ae",
  "v6 common text2gears before authored-question correction",
);
const representationCorrections = [
  {
    current:
      "If Source names the relayed value but supplies no template, text2gears shall emit a bare quoted placeholder line, exactly `> <token>`, without an added label or surrounding prose, and shall not summarize, paraphrase, or invent the relayed value.",
    prior:
      "If Source names the relayed value but supplies no template, text2gears shall emit its canonical typed placeholder on a line beginning with literal `> ` and shall not summarize, paraphrase, or invent a value in its place.",
  },
  {
    current:
      "Keep this non-acting requirement outside prompt blockquotes, in the item's pre-prompt prose, an explicit terminal-return clause in the relevant Results description, or existing nested-call continuation; do not create a Captain action solely to restate the return.",
    prior:
      "Keep this non-acting requirement outside prompt blockquotes, in the item's pre-prompt prose or existing nested-call continuation; do not create a Captain action solely to restate the return.",
  },
];
let beforeRepresentations = beforeBoundaryCorrections(
  "text2gears",
  beforeAuthoredQuestion,
);
for (const correction of representationCorrections) {
  assert.equal(
    beforeRepresentations.split(correction.current).length,
    2,
    "Common representation correction must occur exactly once",
  );
  beforeRepresentations = beforeRepresentations.replace(
    correction.current,
    correction.prior,
  );
}
verify(
  beforeRepresentations,
  "1a7d9bb8b29bfa40de8ae14f001dd5eeedc51da140fcecfa61698f4282ce13db",
  "prior common producer before representation corrections",
);
const resultsSnippet = (
  await readRegular(
    join(sourceRoot, "scripts/experiments/results-boundary-guidance.md"),
    sourceRoot,
  )
).toString();
const resultsGuidance =
  resultsSnippet.slice(resultsSnippet.indexOf("\n\n") + 2).trimEnd() + "\n\n";
assert.equal(
  text2gears.split(resultsGuidance).length,
  2,
  "Retained common Results guidance must occur exactly once",
);
const terminalReturnGuidance =
  "When Source requires a terminal return to the caller, preserve every returned value or fact and its return condition as an explicit workflow output obligation in GEARS.\nMerely naming a value in a completion predicate or an acting result does not state that the workflow returns it.\nKeep this non-acting requirement outside prompt blockquotes, in the item's pre-prompt prose or existing nested-call continuation; do not create a Captain action solely to restate the return.\n\n";
assert.equal(
  beforeRepresentations.split(terminalReturnGuidance).length,
  2,
  "Prior common terminal-return guidance must occur exactly once",
);
const beforeTerminalReturn = beforeRepresentations.replace(
  terminalReturnGuidance,
  "",
);
verify(
  beforeTerminalReturn,
  "6cf4e2d5a8f72c9cdbadaf1d0d755c697133449216c707f4273cbc5c7ea13305",
  "prior producer before terminal-return correction",
);
const beforeResults = beforeTerminalReturn.replace(resultsGuidance, "");
verify(
  beforeResults,
  "c2fb447a4a3a4708ac75d4cba7364748260a32b6a33ef970dee4a5c79233be56",
  "prior producer before retained Results guidance",
);
assert.equal(
  beforeResults.split(relayCorrection).length,
  2,
  "Common relay correction must occur exactly once",
);
assert.equal(
  beforeResults.replace(relayCorrection, ""),
  original["text2gears.md"],
  "Only the reviewed relay, retained Results, terminal-return and representation guidance may change published text2gears",
);
const full = (
  await readRegular(join(sourceRoot, "slc/link.md"), sourceRoot)
).toString();
const recipeStart = full.indexOf("## Optional deterministic materialization\n");
const recipeEnd = full.indexOf("## PlaybookRuntime contract\n", recipeStart);
assert(
  recipeStart >= 0 &&
    recipeEnd > recipeStart &&
    full.lastIndexOf("## Optional deterministic materialization\n") ===
      recipeStart,
  "Exactly one optional helper section is required",
);
const recipe = full.slice(recipeStart, recipeEnd);
const baseline = full.slice(0, recipeStart) + full.slice(recipeEnd);
verify(baseline, commonHashes.link, "common corrected 13.2 link contract");
const beforeOptionContract = beforeBoundaryCorrections("link", baseline);
const guide =
  "At construction, the shared factory validates linked metadata and the shared construction shape; the Captain host owns registry-manifest and live authority-envelope validation at its construction boundary.\n" +
  "Do not audit the bare shared factory as if it owned that Captain-host boundary or synthesize host capabilities in the emitted artifact.\n\n";
assert.equal(
  baseline.split(guide).length,
  2,
  "Common host guidance must appear exactly once",
);
const effectPrefixes = [
  "The linker shall derive each disposition from ",
  "A completion that requires committing the result to Git ",
  "The absence of `latestCommit` or any other effect-owned field ",
];
const effects = baseline
  .split("\n")
  .filter((line) => effectPrefixes.some((prefix) => line.startsWith(prefix)));
assert.equal(
  effects.length,
  3,
  "Reviewed disposition correction must be exact",
);
const completionPrefix =
  "For a Captain-hosted schema-3 artifact, `hostCapabilities` shall contain exactly ";
const oldCompletion = original["link.md"]
  .split("\n")
  .filter((line) => line.startsWith(completionPrefix));
const newCompletion = baseline
  .split("\n")
  .filter((line) => line.startsWith(completionPrefix));
const childAcceptance =
  "`onDone` proves successful bridge delivery without a declared child failure;\nit does not establish every caller-owned domain condition. The caller shall\nenforce its own explicit Source-authored acceptance or relay predicates on\nthe delivered output before continuing, without inventing predicates from\ncallee implementation details or overriding the child's compiled terminal\nkind with output fields.\n";
const previousChildAcceptance =
  "Because the bridge routes a failure terminal to the error path, `onDone` alone\nproves the child succeeded and a caller never inspects a callee's output fields\nto decide that; a caller reads those fields only when its own Source relays\nthem.\n";
assert.equal(
  baseline.split(childAcceptance).length,
  2,
  "Reviewed child-acceptance correction must occur exactly once",
);
assert.equal(oldCompletion.length, 1);
assert.equal(newCompletion.length, 1);
assert.equal(
  beforeOptionContract
    .replace(guide, "")
    .replace(effects.join("\n") + "\n", "")
    .replace(newCompletion[0], oldCompletion[0])
    .replace(childAcceptance, previousChildAcceptance),
  original["link.md"],
  "Only reviewed common corrections may change the published link contract",
);
assert.equal(
  baseline.slice(0, recipeStart) + recipe + baseline.slice(recipeStart),
  full,
  "Optional-section restoration must be exact",
);
const producer = (
  await readRegular(join(sourceRoot, "slc/gears2fsm.md"), sourceRoot)
).toString();
const identityPlaceholderProducerCorrections = [
  {
    intent: "IR-093",
    current:
      "Except for a Source-declared local-role prompt-identity placeholder, every\n" +
      "runtime-value placeholder established by Source in a direct-Captain or\n" +
      "delegated-player prompt shall be backed by a typed ordinary actor-input field\n" +
      "populated from typed machine context, so the linker can substitute it with the\n" +
      "exact runtime value. Angle-bracketed metavariables quoted inside domain\n" +
      "instructions (for example the literal `<model>` in a commit-message format)\n" +
      "remain ordinary prompt text and are not runtime-value placeholders. For the\n" +
      "generic Captain forms, wire `<boss-intent>` from `bossIntent`,\n" +
      "`<enabled-playbooks>` from `enabledPlaybooks`, `<remaining-plan>` from\n" +
      "`remainingPlan`, and `<completed-call-results>` from\n" +
      "`completedCallResults`. Other non-identity placeholders shall retain the\n" +
      "semantic typed field established by Source (for example `<#>` from\n" +
      "`irNumber`). Leaving an ordinary runtime-value placeholder literal, replacing\n" +
      "it with an empty default because its field was omitted, or making the linker\n" +
      "recover it from untyped context is malformed.\n" +
      "The corresponding `invoke.input` object shall include that field beside `prompt`; storing it only in machine context does not satisfy the actor-input contract.\n" +
      "When Source declares a placeholder as the current identity of a local acting\n" +
      "role, preserve the placeholder literal in the FSM prompt and do not add any\n" +
      "identity-value field to machine input, runtime options, machine context, or\n" +
      "actor input, required or optional. The linker shall resolve the placeholder at\n" +
      "prompt-composition time by calling the invocation-scoped\n" +
      "`promptIdentity(roleId)` lookup for the declared local role identified by Source.\n",
    prior:
      "Every runtime-value placeholder established by Source in a direct-Captain or\n" +
      "delegated-player prompt shall be backed by a typed actor-input field populated\n" +
      "from typed machine context, so the linker can substitute it with the exact\n" +
      "runtime value. Angle-bracketed metavariables quoted inside domain instructions\n" +
      "(for example the literal `<model>` in a commit-message format) remain ordinary\n" +
      "prompt text and are not runtime-value placeholders. For the generic Captain\n" +
      "forms, wire `<boss-intent>` from `bossIntent`,\n" +
      "`<enabled-playbooks>` from `enabledPlaybooks`, `<remaining-plan>` from\n" +
      "`remainingPlan`, and `<completed-call-results>` from\n" +
      "`completedCallResults`. Other placeholders shall retain the semantic typed\n" +
      "field established by Source (for example `<#>` from `irNumber`). Leaving a\n" +
      "placeholder literal, replacing it with an empty default because its field was\n" +
      "omitted, or making the linker recover it from untyped context is malformed.\n" +
      "The corresponding `invoke.input` object shall include that field beside `prompt`; storing it only in machine context does not satisfy the actor-input contract.\n",
  },
  {
    intent: "IR-093",
    current:
      "A non-identity placeholder whose value Source assigns to the host — for\n" +
      "example the `<definition>` a phase host supplies to a compiled phase — is such\n" +
      "host-owned configuration: a required machine `input` field carried into typed\n" +
      "context and the acting actor's input, never a Boss-event or actor-output\n" +
      "payload. A Source-declared local-role prompt-identity placeholder is the\n" +
      "explicit exception; it resolves from the invocation-scoped `promptIdentity`\n" +
      "lookup and is not persisted as host configuration.\n",
    prior:
      "A placeholder whose value Source assigns to the host — for example the\n" +
      "`<definition>` a phase host supplies to a compiled phase — is such host-owned\n" +
      "configuration: a required machine `input` field carried into typed context and\n" +
      "the acting actor's input, never a Boss-event or actor-output payload.\n",
  },
];
let beforeIdentityPlaceholderProducerCorrection = producer;
for (const correction of identityPlaceholderProducerCorrections) {
  assert.equal(
    beforeIdentityPlaceholderProducerCorrection.split(correction.current)
      .length,
    2,
    "IR093 producer correction must occur exactly once",
  );
  beforeIdentityPlaceholderProducerCorrection =
    beforeIdentityPlaceholderProducerCorrection.replace(
      correction.current,
      correction.prior,
    );
}
verify(
  beforeIdentityPlaceholderProducerCorrection,
  "d6ce9eb0d1c012956a5df8691d66fd8fda0e5a827edd12eba288827af07e2ad0",
  "v9 common producer before identity-placeholder correction",
);
const sourceStateProducerCorrections = [
  {
    intent: "IR-091",
    current:
      "Where a Source outcome's availability condition is deterministically knowable from execution state, such as a prior Boss reply already received by the machine, the transition shall enforce that condition with authored guards or typed state before the result can be accepted; stating the condition only in a Results description, Judge prose, or prompt text is not enough.\n" +
      "The compiler shall update or reset those source-owned facts only at their actual Source lifecycle boundaries, and shall not attempt to mechanically decide semantic judgments that Source leaves to the acting agent.\n",
    prior: "",
  },
  {
    intent: "IR-091",
    current:
      "When Source requires earlier discussion or constraints on a later invocation, the compiler shall persist that source-owned history in serializable machine context before replacing or clearing the pending Q/A fields.\n" +
      "The later `invoke.input` shall relay that persisted context on both resumed and fresh calls that Source says need it, preserving Source-owned relevance and format without imposing all-history semantics on sources that do not require it.\n" +
      "Shared Boss-reply continuation carries only the latest Q/A pair, and a backend continuation token is not durable Source history.\n",
    prior: "",
  },
];
let beforeSourceStateProducerCorrection =
  beforeIdentityPlaceholderProducerCorrection;
for (const correction of sourceStateProducerCorrections) {
  assert.equal(
    beforeSourceStateProducerCorrection.split(correction.current).length,
    2,
    "IR091 producer correction must occur exactly once",
  );
  beforeSourceStateProducerCorrection =
    beforeSourceStateProducerCorrection.replace(
      correction.current,
      correction.prior,
    );
}
verify(
  beforeSourceStateProducerCorrection,
  "4e840accb47c1924be6e63a483f928a592d36edb07c57be82dbecff59b022ce9",
  "v8 common producer before source-state correction",
);
const nestedCallProducerCorrections = [
  {
    intent: "IR-087",
    current:
      "Every direct-Captain, delegated-player, or script working leaf — sequential\n" +
      "or parallel — shall carry the tag `playbook.busy`: the shared quiescence\n" +
      "helper derives busyness strictly from active-state tags, so an untagged\n" +
      "Captain, player, or script leaf reads as quiescent while its call is still in\n" +
      "flight.\n",
    prior:
      "Every invoking working leaf — sequential or parallel, whatever its actor\n" +
      "kind — shall carry the tag `playbook.busy`: the shared quiescence helper\n" +
      "derives busyness strictly from active-state tags, so an untagged working leaf\n" +
      "reads as quiescent while its call is still in flight.\n",
  },
  {
    intent: "IR-087",
    current:
      "The call state shall carry tag `playbook.suspended`.\n" +
      "The call state and every ancestor state, including the machine root, shall omit\n" +
      "tag `playbook.busy`.\n" +
      "An independently active sibling Captain, player, or script leaf may carry\n" +
      "`playbook.busy`.\n" +
      "The call state shall route `invoke.onDone` from child output and\n" +
      "`invoke.onError` from child failure.\n",
    prior:
      "The call state shall carry tag `playbook.suspended` and shall route\n" +
      "`invoke.onDone` from child output and `invoke.onError` from child failure.\n",
  },
  {
    intent: "IR-088",
    current:
      "After preserving Source-authored success acceptance and recovery cases plus the\n" +
      "public control-error `onError` fallback, omit an `onDone` transition whose guard\n" +
      "cannot be reached from any legal predecessor/context after the prior ordered\n" +
      "`onDone` arms.\n" +
      "This rule does not require arbitrary finite enumeration, drop valid failure\n" +
      "behavior, or relax verifier obligations.\n",
    prior: "",
  },
];
let beforeNestedCallProducerCorrections = beforeSourceStateProducerCorrection;
for (const correction of nestedCallProducerCorrections) {
  assert.equal(
    beforeNestedCallProducerCorrections.split(correction.current).length,
    2,
    `${correction.intent} producer correction must occur exactly once`,
  );
  beforeNestedCallProducerCorrections =
    beforeNestedCallProducerCorrections.replace(
      correction.current,
      correction.prior,
    );
}
verify(
  beforeNestedCallProducerCorrections,
  "668b8aad77f16e6cdd0878dd34c536ba06825e3b3b1d0ae509e00aeacd9e1722",
  "v7 common producer before nested-call corrections",
);
const optimizer = (
  await readRegular(join(sourceRoot, "slc/optimize.md"), sourceRoot)
).toString();
const helper = await readRegular(
  join(sourceRoot, "slc/materialize-link.mjs"),
  sourceRoot,
);
verify(producer, commonHashes.producer, "reviewed producer");
const beforeProducerBoundaries = beforeBoundaryCorrections(
  "producer",
  beforeNestedCallProducerCorrections,
);
verify(helper, commonHashes.helper, "reviewed helper");
beforeBoundaryCorrections("helper", helper.toString());
const catalogBytes = await readRegular(
  join(sourceRoot, "slc/workflow-contracts.json"),
  sourceRoot,
);
verify(catalogBytes, commonHashes.catalog, "reviewed public workflow catalog");
const catalog = JSON.parse(catalogBytes);
assert.equal(catalog.schema, "sublang.playbook.workflow-contracts.v1");
assert.deepEqual(catalog.literalTargetBindings, {
  review: "review",
  decide: "decide",
  code: "code",
  branch: "branch",
  pr: "pr",
});
const catalogStart = producer.indexOf(
  "The independently packaged [workflow contracts](workflow-contracts.json) describe\n",
);
const catalogEnd = producer.indexOf(
  "An item whose behavior is a literal or dynamic\n",
  catalogStart,
);
assert(
  catalogStart >= 0 && catalogEnd > catalogStart,
  "Unique catalog-consumption section is required",
);
const catalogGuidance = producer.slice(catalogStart, catalogEnd);
assert.equal(producer.split(catalogGuidance).length, 2);
verify(
  beforeProducerBoundaries.replace(catalogGuidance, ""),
  "9eb6e5c1ad681901730186e8f3f681940e16b8b22af748991d00c5bacf7a5a9e",
  "prior producer after removing only catalog guidance",
);
verify(optimizer, commonHashes.optimizer, "reviewed optimizer");
for (const [name, text] of Object.entries({
  "baseline link.md": baseline,
  "text2gears.md": text2gears,
  "gears2fsm.md": producer,
  "optimize.md": optimizer,
})) {
  for (const token of [
    "materialize-link.mjs",
    "Optional deterministic materialization",
    "sublang.playbook.link.v1",
    "flat-defaults",
    "flat-quoted-relays",
    "flat-labelled-relays",
    "references/link-contract.md",
  ])
    assert(
      !text.includes(token),
      `${name} must not instruct the baseline to use the helper: ${token}`,
    );
}
const sidecarBytes = await readRegular(
  join(pipeline, "slc.pin-inputs.json"),
  compiler,
);
const sidecar = JSON.parse(sidecarBytes);
assert.deepEqual(Object.keys(sidecar).sort(), ["closures", "schema"]);
assert.equal(sidecar.schema, "sublang.slc.pin-inputs.v1");
assert.deepEqual(
  Object.keys(sidecar.closures).sort(),
  Object.keys(expectedInputs).sort(),
);
const files = new Map([
  ["playbook/text2gears.md", text2gears],
  ["playbook/gears2fsm.md", producer],
  ["playbook/optimize.md", optimizer],
  ["playbook/link.md", mode === "full" ? full : baseline],
  ["playbook/materialize-link.mjs", helper],
  ["playbook/workflow-contracts.json", catalogBytes],
]);
const inputs = {};
const closures = {};
for (const [phase, expected] of Object.entries(expectedInputs)) {
  const locators = sidecar.closures[phase];
  assert(
    Array.isArray(locators) &&
      locators.every(
        (locator) =>
          typeof locator === "string" &&
          !isAbsolute(locator) &&
          !locator.includes("\\"),
      ) &&
      new Set(locators).size === locators.length,
    `Invalid ${phase} semantic-input locators`,
  );
  const normalized = locators.map((locator) =>
    relative(compiler, resolve(pipeline, locator)).split(sep).join("/"),
  );
  assert.deepEqual(
    [...normalized].sort(),
    [...expected].sort(),
    `${phase} ordinary semantic-input membership differs`,
  );
  inputs[phase] = [];
  closures[phase] = [];
  for (let index = 0; index < locators.length; index++) {
    const bytes = await readRegular(
      resolve(pipeline, locators[index]),
      compiler,
    );
    const rewrittenLocator = `_inputs/${normalized[index]}`;
    const destination = `playbook/${rewrittenLocator}`;
    const previous = files.get(destination);
    if (previous !== undefined)
      assert(
        Buffer.from(previous).equals(bytes),
        `Frozen semantic input changed during assembly: ${normalized[index]}`,
      );
    else files.set(destination, bytes);
    closures[phase].push(rewrittenLocator);
    inputs[phase].push({
      originalLocator: locators[index],
      compilerRelativePath: normalized[index],
      rewrittenLocator,
      bytes: bytes.length,
      sha256: sha(bytes),
    });
  }
}
const lock = JSON.parse(files.get("playbook/_inputs/package-lock.json"));
assert.equal(
  lock.packages?.["node_modules/@sublang/playbook"]?.version,
  "13.2.0",
  "Frozen lock must select Playbook 13.2.0",
);
// Adjacent definition references remain functional. The copied original package
// members retain their separate identities instead of masquerading as corrections.
closures.text2gears.push("gears2fsm.md", "link.md", "optimize.md");
closures.gears2fsm.push("text2gears.md", "link.md");
closures.optimize.push("text2gears.md", "gears2fsm.md", "link.md");
closures.link.push(
  "text2gears.md",
  "gears2fsm.md",
  "optimize.md",
  "materialize-link.mjs",
);
for (const phase of Object.keys(closures))
  closures[phase].push("workflow-contracts.json");
files.set(
  "playbook/slc.pin-inputs.json",
  JSON.stringify({ schema: sidecar.schema, closures }, null, 2) + "\n",
);
// Code identities supplement the ordinary semantic-input inventory. They are
// observations of the supplied frozen cohort, never an adopted dependency graph.
const compilerInventory = {};
async function inventoryTree(directory, inventory = compilerInventory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inventoryTree(path, inventory);
    else {
      const bytes = await readRegular(path, compiler);
      inventory[relative(compiler, path).split(sep).join("/")] = {
        bytes: bytes.length,
        sha256: sha(bytes),
      };
    }
  }
}
await inventoryTree(join(compiler, "dist"));
assert(
  Object.keys(compilerInventory).some((name) => name.endsWith("/pipeline.js")),
  "Frozen compiler dist inventory is incomplete",
);
for (const name of ["package.json", "package-lock.json"]) {
  const bytes = await readRegular(join(compiler, name), compiler);
  compilerInventory[name] = { bytes: bytes.length, sha256: sha(bytes) };
}
assert.equal(
  compilerInventory["package-lock.json"].sha256,
  sha(files.get("playbook/_inputs/package-lock.json")),
  "Frozen lock changed during assembly",
);
async function verifyCompilerInventory() {
  const current = {};
  await inventoryTree(join(compiler, "dist"), current);
  for (const name of ["package.json", "package-lock.json"]) {
    const bytes = await readRegular(join(compiler, name), compiler);
    current[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  assert.deepEqual(
    current,
    compilerInventory,
    "Frozen compiler inventory changed during assembly",
  );
}
const proof = {
  schema: "sublang.playbook.link-experiment.v1",
  version: "13.2.0",
  mode,
  status:
    "assembled candidate; no performance acceptance or dependency adoption",
  compilerRoot: compiler,
  ordinaryPipeline: pipeline,
  installedPackage: installed,
  packageManifestSha256: sha(packageBytes),
  ordinarySidecarSha256: sha(sidecarBytes),
  builderSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  publishedHashes: published,
  commonHashes,
  boundaryCorrections: {
    priorCommonHashes: v5Hashes,
    edits: Object.fromEntries(
      Object.entries(boundaryCorrections).map(([kind, edits]) => [
        kind,
        edits.map(({ intent, current, prior }) => ({
          intent,
          currentSha256: sha(current),
          priorSha256: sha(prior),
        })),
      ]),
    ),
  },
  ordinarySemanticInputs: inputs,
  compilerInventory,
  publicCatalog: {
    sha256: sha(catalogBytes),
    bytes: catalogBytes.length,
    literalTargetBindings: catalog.literalTargetBindings,
  },
  catalogGuidanceSha256: sha(catalogGuidance),
  nestedCallSyntaxCorrection: {
    priorCommonSha256: sha(beforeNestedCallSyntax),
    currentSha256: sha(nestedCallSyntaxCorrection.current),
    priorSha256: sha(nestedCallSyntaxCorrection.prior),
    intent: nestedCallSyntaxCorrection.intent,
  },
  authoredQuestionCorrection: {
    priorCommonSha256: sha(beforeAuthoredQuestion),
    currentSha256: sha(authoredQuestionCorrection.current),
    priorSha256: sha(authoredQuestionCorrection.prior),
    intent: authoredQuestionCorrection.intent,
  },
  commonRelayCorrectionSha256: sha(relayCorrection),
  commonResultsGuidanceSha256: sha(resultsGuidance),
  commonTerminalReturnGuidanceSha256: sha(
    terminalReturnGuidance.replace(
      representationCorrections[1].prior,
      representationCorrections[1].current,
    ),
  ),
  representationCorrections: {
    priorCommonSha256: sha(beforeRepresentations),
    sentences: representationCorrections.map(({ current, prior }) => ({
      currentSha256: sha(current),
      priorSha256: sha(prior),
    })),
  },
  identityPlaceholderProducerCorrections: {
    priorCommonSha256: sha(beforeIdentityPlaceholderProducerCorrection),
    edits: identityPlaceholderProducerCorrections.map(
      ({ intent, current, prior }) => ({
        intent,
        currentSha256: sha(current),
        priorSha256: sha(prior),
      }),
    ),
  },
  sourceStateProducerCorrections: {
    priorCommonSha256: sha(beforeSourceStateProducerCorrection),
    edits: sourceStateProducerCorrections.map(({ intent, current, prior }) => ({
      intent,
      currentSha256: sha(current),
      priorSha256: sha(prior),
    })),
  },
  nestedCallProducerCorrections: {
    priorCommonSha256: sha(beforeNestedCallProducerCorrections),
    edits: nestedCallProducerCorrections.map(({ intent, current, prior }) => ({
      intent,
      currentSha256: sha(current),
      priorSha256: sha(prior),
    })),
  },
  optionalHelperSectionSha256: sha(recipe),
  helperSha256: sha(helper),
  treatment:
    "Only playbook/link.md optional deterministic materialization instructions differ. Both arms retain identical helper and input closure bytes; undirected helper-file existence is not hidden.",
  execution:
    "Self-contained interpreted definitions; no compiled pins. Runtime and package-grammar citations resolve through the frozen benchmark workspace dependencies; rewritten semantic locators are snapshot locators, not the original locators. Active definition references resolve adjacent corrected files; copied published counterparts are protected evidence, not directed normative fallback.",
  outputs: Object.fromEntries(
    [...files].map(([name, bytes]) => [
      name,
      { sha256: sha(bytes), bytes: Buffer.byteLength(bytes) },
    ]),
  ),
};
// Preflight is complete. Targets are single-writer experiment roots; never
// replace an existing result. Proof sits outside the pipeline definition folder.
const staging = await mkdtemp(
  join(dirname(target), ".playbook-13.2-experiment-"),
);
try {
  for (const [name, bytes] of files) {
    await mkdir(dirname(join(staging, name)), { recursive: true });
    await writeFile(join(staging, name), bytes, { flag: "wx" });
  }
  await writeFile(
    join(staging, "experiment-proof.json"),
    JSON.stringify(proof, null, 2) + "\n",
    { flag: "wx" },
  );
  await verifyCompilerInventory();
  await absent(target);
  await rename(staging, target);
} finally {
  await rm(staging, { recursive: true, force: true });
}
process.stdout.write(
  JSON.stringify(
    { target, pipeline: join(target, "playbook"), ...proof },
    null,
    2,
  ) + "\n",
);
