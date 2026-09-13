<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# link-experiments: Controlled Link Definition Inputs

## Intent

This package defines the repository-only Playbook 13.2 experiment builder used to compare optional deterministic materialization with ordinary linking.
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

The builder shall construct both arms from the same reviewed corrected local producer, optimizer and complete link contract, extracting only the unique `## Optional deterministic materialization` section before `## PlaybookRuntime contract` from the current checkout's link definition as the full-mode treatment and checking these common SHA-256 identities:

| Common member | SHA-256 |
| --- | --- |
| Link after removing the optional section | `89e40b53e2bbed25eabceb57a4e61ce27a2fbee14d0cd886215a66ef0160bc86` |
| `gears2fsm.md` | `9eb6e5c1ad681901730186e8f3f681940e16b8b22af748991d00c5bacf7a5a9e` |
| `optimize.md` | `4f3111e1a8a2124c8a174d63752be368ab763493b603f7a4df4bed60c264cfb9` |

The builder shall prove exact reconstruction of the published link bytes by undoing only the common authority-boundary guidance, three repository-disposition lines, corrected completion-mapper clause and caller-owned child-acceptance paragraph, and prove exact full-entry restoration by reinserting the extracted optional section.

### link-experiments-3

The builder shall require the supplied pipeline's `slc.pin-inputs.json` to declare schema `sublang.slc.pin-inputs.v1` and exactly the following original member sets, copying their exact regular-file bytes to `_inputs/<compiler-relative-path>`, recording each original and rewritten locator with byte length and SHA-256, and declaring those copies plus the indicated adjacent members in its emitted sidecar:

| Phase | Original members | Additional adjacent members |
| --- | --- | --- |
| `text2gears` | Both Spex grammars and lock | None |
| `gears2fsm` | Published `text2gears.md`, `link.md`, both grammars and lock | `text2gears.md`, `link.md` |
| `optimize` | Published `text2gears.md`, `gears2fsm.md`, `link.md`, both grammars and lock | `text2gears.md`, `gears2fsm.md`, `link.md` |
| `link` | Published `text2gears.md`, `gears2fsm.md`, both grammars and lock | `text2gears.md`, `gears2fsm.md`, `optimize.md`, `materialize-link.mjs` |

The builder shall resolve published members under `node_modules/@sublang/playbook/slc/`, the two grammars at `node_modules/@sublang/spex/scaffold/specs/meta.md` and `node_modules/@sublang/spex/scaffold/i18n/zh/specs/meta.md`, and the lock at `package-lock.json`, rejecting duplicate locators, members outside this matrix, nonregular or internally symbolic paths, any repeated member whose bytes change during assembly, and a lock selecting another Playbook version.

### link-experiments-4

The emitted experiment shall contain only a `playbook/` directory holding the four phase definitions, the current helper's exact bytes, copied semantic inputs and sidecar, plus a sibling `experiment-proof.json` recording schema `sublang.playbook.link-experiment.v1`, mode, source provenance, treatment and every output member's byte length and SHA-256, without compiled pins, runtime packages, maintained workflow sources, generated workflow outputs, or helper-use instructions outside the full-mode optional section.
The proof shall identify rewritten semantic locators as snapshot locators, dependency resolution as the frozen workspace's responsibility, and assembly as no performance acceptance or dependency adoption.

### link-experiments-5

The builder shall validate all inputs before writing a staged sibling tree and rename the completed tree to an absent output root, refusing existing outputs and cleaning failed staging under a single-writer target assumption without modifying any supplied input or historical 12.3 builder.

## Verification

### link-experiments-6

When the integration suite constructs both modes through the real CLI and inspects them with the supplied SLC's actual pipeline discovery and semantic closure, it shall verify the exact one-section treatment and identical other members [[link-experiments-2](#link-experiments-2)], source identities and complete per-phase input accounting [[link-experiments-3](#link-experiments-3)], absence of undeclared files or helper guidance from the baseline definitions [[link-experiments-4](#link-experiments-4)], and rejection without output for altered published files, invalid roots or locators [[link-experiments-1](#link-experiments-1)] and existing targets [[link-experiments-5](#link-experiments-5)].
