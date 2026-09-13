<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# link-experiments: Controlled Link Definition Inputs

## Intent

This package defines the repository-only Playbook 13.2 experiment builder used to compare optional deterministic materialization with ordinary linking and an optional FSM authoring scaffold with ordinary FSM compilation.
It does not publish a runtime, alter dependencies, or retain a performance technique without separate measurements.

## External Behavior

### link-experiments-1

When invoked with a frozen compiler root, an absent output root outside that compiler and the builder checkout, and exactly one of `--baseline` or `--full`, the builder shall require `node_modules/@sublang/playbook/package.json` to declare `@sublang/playbook` version `13.2.0` and each definition in both that package's `slc/` directory and the compiler's `pipelines/playbook/` directory to match its published SHA-256 before constructing an experimental pipeline:

| Definition      | Published SHA-256                                                  |
| --------------- | ------------------------------------------------------------------ |
| `text2gears.md` | `48a6a5d3f02a1d90dcc0883170da74e16c29b1554533913eb4fd7cefc49251bb` |
| `gears2fsm.md`  | `c549458f39337b4ce1697e1103ee2010656ced0b8a08b2fe57a103f9186c2b1e` |
| `link.md`       | `294f41c6ebeeb970fb53d2b801e2769dbff3c18a5910b7569c5b547b3daaea5d` |
| `optimize.md`   | `dc8c59f02c73165f1e65b40187f2dc07def9ba43b884a04d992e400c20db6e66` |

### link-experiments-2

The builder shall construct both arms from the same reviewed corrected local text-to-GEARS and FSM producers, optimizer and complete link contract, extracting only the unique `## Optional deterministic materialization` section before `## PlaybookRuntime contract` from the current checkout's link definition as the full-mode treatment and checking these common SHA-256 identities:

| Common member                            | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `text2gears.md`                          | `1f146b9cb00a6de016c5e02a528825daa5ce3bda055eae553e1545b6dde0b639` |
| Link after removing the optional section | `a5c82f9aa30814039f5282d2644373134c076bf9795a6a7df030dc31b6d981a7` |
| `gears2fsm.md`                           | `d6ce9eb0d1c012956a5df8691d66fd8fda0e5a827edd12eba288827af07e2ad0` |
| `materialize-link.mjs`                   | `5024778548509370d899f3709829fd7609d67bc4fe5d72b2c76d5d0ab26f59eb` |
| `workflow-contracts.json`                | `de862f4b772ffb6860c2cab3ed75ab281b378dffa0a6217ebc8e049302c05dd3` |
| `optimize.md`                            | `4f3111e1a8a2124c8a174d63752be368ab763493b603f7a4df4bed60c264cfb9` |

The builder shall first undo only the nested-call fixed verb-phrase guidance [[compiler-nested-calls-1](compiler-nested-calls.md#compiler-nested-calls-1)] to recover the exact v7 text-to-GEARS SHA-256 `56f414ec3243fda97bb847871b460fdaaf0bba1585627e0897ccdf95a80d7aa4`.
The builder shall first undo only the source-state preservation guidance [[compiler-source-state-1](compiler-source-state.md#compiler-source-state-1)] [[compiler-source-state-2](compiler-source-state.md#compiler-source-state-2)] to recover the exact v8 FSM-producer SHA-256 `4e840accb47c1924be6e63a483f928a592d36edb07c57be82dbecff59b022ce9`.
The builder shall then undo only the nested-call busy-tag and unreachable `onDone` guidance [[compiler-nested-tags-1](compiler-nested-tags.md#compiler-nested-tags-1)] [[compiler-nested-calls-2](compiler-nested-calls.md#compiler-nested-calls-2)] to recover the exact v7 FSM-producer SHA-256 `668b8aad77f16e6cdd0878dd34c536ba06825e3b3b1d0ae509e00aeacd9e1722`.
The builder shall then undo only the authored Boss-question field declaration [[compiler-results-5](compiler-results.md#compiler-results-5)] to recover the exact v6 text-to-GEARS SHA-256 `c38555a7e5e1d33d0c1c71d34beb3b581e62abea819722905ae1af87775922ae` before the existing inverse chain.
The builder shall then undo only the public child-validator import and authored-error recipe [[compiler-child-validation-1](compiler-child-validation.md#compiler-child-validation-1)], public linked-validator and bootstrap guidance [[compiler-entry-options-1](compiler-entry-options.md#compiler-entry-options-1)] [[compiler-entry-options-3](compiler-entry-options.md#compiler-entry-options-3)], and explicit outer-versus-inner quote wording [[compiler-prompt-relays-3](compiler-prompt-relays.md#compiler-prompt-relays-3)] to recover the exact v5 identities before the remaining inverse chain:

| Prior common member | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `text2gears`        | `bbefc6806bd84c5b181ef1014a7cbe2d21663be3ce4e2098499b07b134835970` |
| `link`              | `89e40b53e2bbed25eabceb57a4e61ce27a2fbee14d0cd886215a66ef0160bc86` |
| `producer`          | `7059aefbdaee40a8fc9abb1973627e6ec891076a03c9571682b8a925ea1d139a` |
| `helper`            | `eeed4082c2bb0b0bdb9b8685b16ba4bdb6e70b418e171f851cfb1a9dd6c861bf` |

Each inverse shall match its reviewed current text exactly once, and the proof shall record every correction's intent and before/after text hashes.
The builder shall prove exact reconstruction of the published link bytes by undoing only the common authority-boundary guidance, three repository-disposition lines, corrected completion-mapper clause and caller-owned child-acceptance paragraph, and prove exact full-entry restoration by reinserting the extracted optional section.
The builder shall prove that removing only the public-catalog consumption section recovers the prior producer SHA-256 `9eb6e5c1ad681901730186e8f3f681940e16b8b22af748991d00c5bacf7a5a9e`.
After recovering v5, the builder shall recover the prior common text-to-GEARS SHA-256 `1a7d9bb8b29bfa40de8ae14f001dd5eeedc51da140fcecfa61698f4282ce13db` by undoing only the bare-untemplated-relay wording [[compiler-prompt-relays-3](compiler-prompt-relays.md#compiler-prompt-relays-3)] and the explicit terminal-return placement in a Results description [[compiler-results-3](compiler-results.md#compiler-results-3)].
The builder shall then recover the exact published text-to-GEARS bytes by removing only the common terminal-return preservation paragraph [[compiler-results-3](compiler-results.md#compiler-results-3)] to recover SHA-256 `6cf4e2d5a8f72c9cdbadaf1d0d755c697133449216c707f4273cbc5c7ea13305`, then the retained common Results-placement guidance [[compiler-results-1](compiler-results.md#compiler-results-1)], first recovering SHA-256 `c2fb447a4a3a4708ac75d4cba7364748260a32b6a33ef970dee4a5c79233be56`, and then its two-sentence common authored-relay clarification.
Both arms shall contain the same retained Results guidance; its earlier measured comparison remains a separate unchanged experiment.

### link-experiments-3

The builder shall require the supplied pipeline's `slc.pin-inputs.json` to declare schema `sublang.slc.pin-inputs.v1` and exactly the following original member sets, copying their exact regular-file bytes to `_inputs/<compiler-relative-path>`, recording each original and rewritten locator with byte length and SHA-256, and declaring those copies plus the indicated adjacent members in its emitted sidecar:

| Phase        | Original members                                                             | Additional adjacent members                                                                       |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `text2gears` | Both Spex grammars and lock                                                  | `gears2fsm.md`, `link.md`, `optimize.md`, `workflow-contracts.json`                               |
| `gears2fsm`  | Published `text2gears.md`, `link.md`, both grammars and lock                 | `text2gears.md`, `link.md`, `workflow-contracts.json`                                             |
| `optimize`   | Published `text2gears.md`, `gears2fsm.md`, `link.md`, both grammars and lock | `text2gears.md`, `gears2fsm.md`, `link.md`, `workflow-contracts.json`                             |
| `link`       | Published `text2gears.md`, `gears2fsm.md`, both grammars and lock            | `text2gears.md`, `gears2fsm.md`, `optimize.md`, `materialize-link.mjs`, `workflow-contracts.json` |

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
