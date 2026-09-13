<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# link-experiments: Controlled Link Definition Inputs

## Intent

This package defines the repository-only Playbook 13.2 experiment builder used to compare optional deterministic materialization with ordinary linking and an optional FSM authoring scaffold with ordinary FSM compilation.
It does not publish a runtime, alter dependencies, or retain a performance technique without separate measurements.

## External Behavior

### link-experiments-1

When invoked with a frozen compiler root, an absent output root outside that compiler and the builder checkout, and exactly one of `--baseline` or `--full`, the builder shall require `node_modules/@sublang/playbook/package.json` to declare `@sublang/playbook` version `13.2.0` and each definition in both that package's `slc/` directory and the compiler's `pipelines/playbook/` directory to match its published SHA-256 before constructing an experimental pipeline:

| Definition | Published SHA-256 |
| --- | --- |
| `text2gears.md` | `48a6a5d3f02a1d90dcc0883170da74e16c29b1554533913eb4fd7cefc49251bb` |
| `gears2fsm.md` | `c549458f39337b4ce1697e1103ee2010656ced0b8a08b2fe57a103f9186c2b1e` |
| `link.md` | `294f41c6ebeeb970fb53d2b801e2769dbff3c18a5910b7569c5b547b3daaea5d` |
| `optimize.md` | `dc8c59f02c73165f1e65b40187f2dc07def9ba43b884a04d992e400c20db6e66` |

### link-experiments-2

The builder shall construct both arms from the same reviewed corrected local text-to-GEARS and FSM producers, optimizer and complete link contract, extracting only the unique `## Optional deterministic materialization` section before `## PlaybookRuntime contract` from the current checkout's link definition as the full-mode treatment and checking these common SHA-256 identities:

| Common member | SHA-256 |
| --- | --- |
| `text2gears.md` | `6cf4e2d5a8f72c9cdbadaf1d0d755c697133449216c707f4273cbc5c7ea13305` |
| Link after removing the optional section | `89e40b53e2bbed25eabceb57a4e61ce27a2fbee14d0cd886215a66ef0160bc86` |
| `gears2fsm.md` | `7059aefbdaee40a8fc9abb1973627e6ec891076a03c9571682b8a925ea1d139a` |
| `workflow-contracts.json` | `de862f4b772ffb6860c2cab3ed75ab281b378dffa0a6217ebc8e049302c05dd3` |
| `optimize.md` | `4f3111e1a8a2124c8a174d63752be368ab763493b603f7a4df4bed60c264cfb9` |

The builder shall prove exact reconstruction of the published link bytes by undoing only the common authority-boundary guidance, three repository-disposition lines, corrected completion-mapper clause and caller-owned child-acceptance paragraph, and prove exact full-entry restoration by reinserting the extracted optional section.
The builder shall prove that removing only the public-catalog consumption section recovers the prior producer SHA-256 `9eb6e5c1ad681901730186e8f3f681940e16b8b22af748991d00c5bacf7a5a9e`.
The builder shall recover the exact published text-to-GEARS bytes by removing only the retained common Results-placement guidance [[compiler-results-1](compiler-results.md#compiler-results-1)], first recovering SHA-256 `c2fb447a4a3a4708ac75d4cba7364748260a32b6a33ef970dee4a5c79233be56`, and then its two-sentence common authored-relay clarification.
Both arms shall contain the same retained Results guidance; its earlier measured comparison remains a separate unchanged experiment.

### link-experiments-3

The builder shall require the supplied pipeline's `slc.pin-inputs.json` to declare schema `sublang.slc.pin-inputs.v1` and exactly the following original member sets, copying their exact regular-file bytes to `_inputs/<compiler-relative-path>`, recording each original and rewritten locator with byte length and SHA-256, and declaring those copies plus the indicated adjacent members in its emitted sidecar:

| Phase | Original members | Additional adjacent members |
| --- | --- | --- |
| `text2gears` | Both Spex grammars and lock | `gears2fsm.md`, `link.md`, `optimize.md`, `workflow-contracts.json` |
| `gears2fsm` | Published `text2gears.md`, `link.md`, both grammars and lock | `text2gears.md`, `link.md`, `workflow-contracts.json` |
| `optimize` | Published `text2gears.md`, `gears2fsm.md`, `link.md`, both grammars and lock | `text2gears.md`, `gears2fsm.md`, `link.md`, `workflow-contracts.json` |
| `link` | Published `text2gears.md`, `gears2fsm.md`, both grammars and lock | `text2gears.md`, `gears2fsm.md`, `optimize.md`, `materialize-link.mjs`, `workflow-contracts.json` |

The builder shall resolve published members under `node_modules/@sublang/playbook/slc/`, the two grammars at `node_modules/@sublang/spex/scaffold/specs/meta.md` and `node_modules/@sublang/spex/scaffold/i18n/zh/specs/meta.md`, and the lock at `package-lock.json`, rejecting duplicate locators, members outside this matrix, nonregular or internally symbolic paths, any repeated member whose bytes change during assembly, and a lock selecting another Playbook version.

### link-experiments-4

The emitted experiment shall contain only a `playbook/` directory holding the four phase definitions, the current helper's exact bytes, the independently packaged public catalog including its default literal target bindings [[compiler-workflow-contracts-1](compiler-workflow-contracts.md#compiler-workflow-contracts-1)], copied semantic inputs and sidecar, plus a sibling `experiment-proof.json` recording schema `sublang.playbook.link-experiment.v1`, mode, source provenance, treatment and every output member's byte length and SHA-256, without compiled pins, runtime packages, maintained workflow sources, generated workflow outputs, or helper-use instructions outside the full-mode optional section.
The proof shall record the supplied compiler package, lock and complete regular-file `dist/` inventory and reject a change to those identities before publication.
The proof shall identify rewritten semantic locators as snapshot locators, dependency resolution as the frozen workspace's responsibility, and assembly as no performance acceptance or dependency adoption.

### link-experiments-5

The builder shall validate all inputs before writing a staged sibling tree and rename the completed tree to an absent output root, refusing existing outputs and cleaning failed staging under a single-writer target assumption without modifying any supplied input or historical 12.3 builder.

### link-experiments-7

When invoked with a frozen compiler root and absent external output root, the scaffold-pair builder shall reuse the corrected link baseline [[link-experiments-1](#link-experiments-1)] [[link-experiments-2](#link-experiments-2)] [[link-experiments-3](#link-experiments-3)] and emit `baseline/playbook/` and `scaffold/playbook/` with identical members except the latter's appended optional FSM initializer guidance [[fsm-scaffolding-1](fsm-scaffolding.md#fsm-scaffolding-1)] in `gears2fsm.md`.
It shall embed the same initializer and subdirectory guidance bytes in both arms, rebase only the guide's relative helper link when appending it, and include both helper and guide in every phase's declared closure because each reaches the active FSM definition directly or through existing adjacent references.

### link-experiments-8

The scaffold-pair builder shall publish a sibling proof recording schema `sublang.playbook.fsm-scaffold-experiment.v1`, the reused baseline proof, the exact appended text hash and every per-arm member identity, verify that only `playbook/gears2fsm.md` differs, and reject changed inputs or existing outputs before publishing through staged sibling assembly [[link-experiments-5](#link-experiments-5)].
Both builders shall leave previous cohorts and outputs untouched and make no compiler, dependency, runtime or performance acceptance claim from assembly alone.

## Verification

### link-experiments-6

When the integration suite constructs both modes through the real CLI and inspects them with the supplied SLC's actual pipeline discovery and semantic closure, it shall verify the exact one-section treatment and identical other members [[link-experiments-2](#link-experiments-2)], source identities, complete per-phase input accounting and protection of every active adjacent phase reference [[link-experiments-3](#link-experiments-3)], absence of undeclared files or helper guidance from the baseline definitions [[link-experiments-4](#link-experiments-4)], and rejection without output for altered published files, invalid roots or locators [[link-experiments-1](#link-experiments-1)] and existing targets [[link-experiments-5](#link-experiments-5)].

### link-experiments-9

When the real CLI constructs the scaffold pair and the supplied SLC discovers and derives its closures, the integration suite shall verify exactly the existing phase set, all active reference and helper inputs, exact common catalog and initializer bytes, only the appended FSM guidance as treatment, complete proof accounting, unchanged source inputs and rejection of existing or internal output paths [[link-experiments-7](#link-experiments-7)] [[link-experiments-8](#link-experiments-8)].
