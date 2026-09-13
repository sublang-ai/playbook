<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-078: Catalog-Aware Compiler Experiments

## Status

In progress.

## Intent

Prepare reproducible common public-interface inputs and an isolated FSM scaffold comparison without changing earlier cohorts or introducing maintained implementation oracles.

## Deliverables

- [x] Catalog-aware link baseline/full builder with complete active closures.
- [x] Separate matched fixed-GEARS baseline/scaffold pair builder.
- [ ] Actual supplied-compiler discovery, closure and identity proofs from a newly frozen cohort.

## Tasks

1. [x] Implement the catalog-aware link builder and isolated scaffold-pair assembly under [[link-experiments-2](../packages/link-experiments.md#link-experiments-2)] and [[link-experiments-7](../packages/link-experiments.md#link-experiments-7)].
2. [ ] Verify and freeze new common inputs with the next supplied compiler cohort, preserving prior experiments.

## Verification

The 14 real CLI/discovery/closure cases pass using the prior frozen compiler only as a temporary rehearsal, and both test files pass strict TypeScript.
Final acceptance and retained output proofs await the next supplied frozen compiler root.
The retained Results-placement guidance is common to all new arms, preserving its separately measured comparison.
Assembly does not run providers, accept generated artifacts or prove performance improvement.
