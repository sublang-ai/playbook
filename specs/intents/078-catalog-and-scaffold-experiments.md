<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-078: Catalog-Aware Compiler Experiments

## Status

Completed.

## Intent

Prepare reproducible common public-interface inputs and an isolated FSM scaffold comparison without changing earlier cohorts or introducing maintained implementation oracles.

## Deliverables

- [x] Catalog-aware link baseline/full builder with complete active closures.
- [x] Separate matched fixed-GEARS baseline/scaffold pair builder.
- [x] Actual supplied-compiler discovery, closure and identity proofs from a newly frozen cohort.

## Tasks

1. [x] Implement the catalog-aware link builder and isolated scaffold-pair assembly under [[link-experiments-2](../packages/link-experiments.md#link-experiments-2)] and [[link-experiments-7](../packages/link-experiments.md#link-experiments-7)].
2. [x] Verify and freeze new common inputs with the next supplied compiler cohort, preserving prior experiments.

## Verification

All 14 real CLI/discovery/closure cases pass against the new frozen C3 compiler at `/private/tmp/slc-fidelity-compiler-ehkjoo54`, production and harness commit `b091e80c1dd7a3c745796495cf766c74bf69f3b5`; both test files pass strict TypeScript.
The parent cohort's 228-entry compiler inventory and pre-existing cache identity remain unchanged after these tests.
Each builder proof records and rechecks the 176 regular `dist/`, package and lock members it owns.
New roots `/private/tmp/playbook-13.2-common-v4-baseline`, `/private/tmp/playbook-13.2-common-v4-full` and `/private/tmp/playbook-13.2-fsm-scaffold-v1-pair` preserve every prior output.
The exact public catalog, retained Results guidance and terminal-return correction are common in every arm.
Independent output hashing confirms only `playbook/link.md` differs between link arms and only `playbook/gears2fsm.md` differs between scaffold arms.
[Sanitized final evidence](../../scripts/experiments/link-experiment-13.2-catalog-scaffold-evidence.json) retains all original semantic-input identities, output and proof hashes, correction identities and validation scope.
The retained Results-placement guidance is common to all new arms, preserving its separately measured comparison.
Assembly does not run providers, accept generated artifacts or prove performance improvement.
