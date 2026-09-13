<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Controlled Playbook 13.2 link inputs

This repository-only builder creates ordinary and helper-instructed definition sets for a controlled interpreted link comparison.
It does not invoke a model, install or publish a package, rebuild compiled pipelines, or claim that the candidate improves performance.
The historical 12.3 builder remains unchanged and must use its documented historical source checkout.

## Inputs and invocation

Use a fixed checkout containing this script and a frozen SLC compiler tree with:

- `pipelines/playbook/`: all four exact published Playbook 13.2 definitions and the ordinary `slc.pin-inputs.json`.
- `node_modules/@sublang/playbook/`: package version `13.2.0` and those same published definitions.
- The ordinary sidecar's English and Chinese Spex grammar files and `package-lock.json`, with the lock selecting Playbook `13.2.0`.
- `dist/pipeline.js` and `dist/pin-closure.js` when running the integration tests.

The compiler root and builder checkout must remain unchanged while assembling a pair.
Choose two absent output paths outside both roots, with an existing parent directory.

```sh
node scripts/build-link-experiment-13.2.mjs /absolute/frozen-compiler /private/tmp/link-13.2-baseline --baseline
node scripts/build-link-experiment-13.2.mjs /absolute/frozen-compiler /private/tmp/link-13.2-full --full
```

Each output root contains `playbook/` and a separate `experiment-proof.json`.
Set `SLC_PIPELINE_PATH` to the output **root**, whose child is named `playbook`.
Use the same frozen compiler executable, workspace dependencies, fixed input FSM, execution mode and model settings for both arms.
No compiled pins are emitted: these are interpreted definition sets.
Ordinary relative definition crosslinks continue to resolve to adjacent phase files; package and grammar citations resolve through the frozen benchmark workspace's dependencies.
The builder neither copies those runtime dependencies nor alters their resolution.

## Exact comparison boundary

Both arms contain the same corrected producer and optimizer, the same full normative link contract and common host-boundary guidance, the same helper file, and the same declared semantic inputs.
Only the full arm's `playbook/link.md` contains the optional deterministic-materialization section.
The baseline has no helper-use instructions in any phase definition; the identical undirected helper file remains visible and is explicitly recorded as part of the comparison boundary.
This is a comparison of optional helper instructions, not a claim that the baseline agent cannot discover files.

The builder checks fixed published hashes for all four definitions, fixed hashes for the common corrected definitions, and exact inverse reconstruction of the original link contract.
The common corrections concern the already reviewed host/factory ownership boundary, commit disposition and deferred completion fields, current-directory Git initialization, machine-root and Boss-input production rules, explicit caller-owned child-acceptance predicates after successful bridge delivery, and delivery of every source-authored runtime relay to each governed acting prompt.
The terminal-return correctness paragraph and retained Results-placement snippet are now common to both arms; removing exactly the terminal-return paragraph restores the prior Results-guided definition; removing its exact 379 bytes restores the prior relay-corrected text-to-GEARS definition, and removing the two-sentence relay clarification then restores the published definition.
Earlier v1–v3 overlays and the separately measured Results pair remain unchanged.
The current helper and optional section are captured byte-for-byte and identified by their hashes in each proof; pin the source checkout to reproduce them.

Every ordinary per-phase semantic member is copied under `playbook/_inputs/<compiler-relative-path>` with its original locator, rewritten locator, byte length and SHA-256 recorded separately.
Published package-definition members remain distinct from their corrected adjacent counterparts.
The new sidecar includes all original members plus the local definition references and helper needed by each phase.
Both arms include the exact public `workflow-contracts.json` catalog, including its explicit `literalTargetBindings`, in every active phase closure because those phases reach the corrected FSM contract directly or through adjacent references.
Removing only the catalog-consumption section restores the prior FSM producer; the catalog contains public interfaces, not maintained implementation artifacts.
The current text-to-GEARS closure explicitly includes its adjacent `gears2fsm.md`, `link.md` and `optimize.md` references; earlier v1/v2 input snapshots retained the ordinary grammar-and-lock closure for that phase and are preserved unchanged.
Active Markdown references resolve to adjacent corrected definitions, never to the copied `_inputs` counterparts; those copies remain separately identified protected evidence rather than a directed normative fallback.
It intentionally uses snapshot locators and does not present them as the original ordinary locators.
Only these definition inputs are copied: no maintained CODE/DEV source, compiled answer, reference registry, runtime package or semantic oracle enters the output.

The proof records hashes for every emitted pipeline member and source provenance.
Before measurement, compare the two `outputs` maps: all entries except `playbook/link.md` must be identical.
Also compare `ordinarySemanticInputs`, `helperSha256` and `optionalHelperSectionSha256`.
Preserve each proof and the frozen compiler's independent dependency/runtime inventory alongside the measurement.
The builder records and rechecks every regular `dist/` file plus the compiler package and lock, rejecting changed contents or inventory membership before publication.
This inventory identifies the supplied code; it does not certify executable dependency resolution, provider settings, operational package pruning or runtime acceptance, which remain part of the frozen cohort and benchmark proofs.

## Local validation

```sh
PLAYBOOK_EXPERIMENT_COMPILER=/absolute/frozen-compiler \
  node node_modules/vitest/vitest.mjs run src/link-experiment-13.2.test.ts
```

The integration suite uses the supplied compiler's actual discovery and closure code, verifies the exact one-section difference and every preserved input, and exercises refusal of altered published definitions, wrong versions, foreign or symbolic inputs, existing outputs, and output placement inside the frozen compiler.
The checked-in [initial local assembly evidence](link-experiment-13.2-evidence.json) records the first successful 11-case run and is reproduced from source commit `128956f`; the later [child-acceptance correction evidence](link-experiment-13.2-child-acceptance-evidence.json) records a new pair sharing that normative correction.
The [relay-aware closure evidence](link-experiment-13.2-relay-closure-evidence.json) records the subsequent common relay correction and explicit text-to-GEARS closure additions.
These historical records retain exact candidate hashes and full original-member accounting, with no model measurement.
The [catalog-aware C3 closure evidence](link-experiment-13.2-catalog-scaffold-evidence.json) records new v4 link roots and the separate scaffold pair, sharing the public catalog, retained Results guidance and terminal-return correction; it does not rewrite those earlier records.
Without `PLAYBOOK_EXPERIMENT_COMPILER`, only the help/argument test runs; that is insufficient evidence of successful assembly.
Outputs use a staged sibling tree and an absent-target check under a single-writer assumption; there is no concurrent atomic no-replace guarantee.

Successful assembly and local correctness checks establish reproducibility only.
Retaining a performance technique requires a separately recorded same-input comparison and strict, source-fidelity and real-runtime acceptance of both generated artifacts.

The separate [FSM scaffold pair builder](fsm-scaffold-experiment-13.2.md) reuses this corrected baseline and isolates only optional initialization guidance.
