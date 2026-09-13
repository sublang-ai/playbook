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
    "c2fb447a4a3a4708ac75d4cba7364748260a32b6a33ef970dee4a5c79233be56",
  link: "89e40b53e2bbed25eabceb57a4e61ce27a2fbee14d0cd886215a66ef0160bc86",
  producer: "9eb6e5c1ad681901730186e8f3f681940e16b8b22af748991d00c5bacf7a5a9e",
  optimizer: "4f3111e1a8a2124c8a174d63752be368ab763493b603f7a4df4bed60c264cfb9",
};
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
assert.equal(
  text2gears.split(relayCorrection).length,
  2,
  "Common relay correction must occur exactly once",
);
assert.equal(
  text2gears.replace(relayCorrection, ""),
  original["text2gears.md"],
  "Only the reviewed relay correction may change published text2gears",
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
  baseline
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
const optimizer = (
  await readRegular(join(sourceRoot, "slc/optimize.md"), sourceRoot)
).toString();
const helper = await readRegular(
  join(sourceRoot, "slc/materialize-link.mjs"),
  sourceRoot,
);
verify(producer, commonHashes.producer, "reviewed producer");
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
files.set(
  "playbook/slc.pin-inputs.json",
  JSON.stringify({ schema: sidecar.schema, closures }, null, 2) + "\n",
);
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
  ordinarySemanticInputs: inputs,
  commonRelayCorrectionSha256: sha(relayCorrection),
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
