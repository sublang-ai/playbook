<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-096: Common v11 Option Snapshot Builder Inputs

## Status

Complete.

## Intent

Prepare the Playbook 13.2 common v11 baseline/full experiment builder from immutable v10 plus the reviewed public option JSON snapshot guidance, without changing previous cohorts or claiming provider acceptance.

## Deliverables

- [x] Builder recognizes the v11 common link hash and records exact inverse recovery to v10.
- [x] Builder acceptance checks the v11 emitted option-snapshot guidance and proof metadata.
- [x] Link-experiments spec records v11 identities and per-definition inverse recovery.
- [x] Root-reviewed immutable v11 baseline/full outputs.
- [x] Private v11 materializer-preference preparation script records the reviewed preference paragraph and post-assembly proof checks.

## Tasks

1. [x] Update the builder, tests, and spec for the reviewed option JSON snapshot guidance without rebuilding historical cohorts.
2. [x] Assemble immutable v11 baseline/full outputs from the reviewed commit and C8 compiler, then execute the private materializer-preference variant without upstream adoption.

## Verification

- Focused builder acceptance with the supplied C8 compiler passed: `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-c8-compiler-ezn78503 ./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts src/compact-link-definition.test.ts --reporter=verbose` reported 12 passing tests and 1 skipped historical optional test; `src/link-experiment-13.2.test.ts` supplied the 11 builder acceptance cases.
- `/opt/homebrew/bin/spex lint` passed with 0 errors and 253 existing warnings.
- Private preference preparation script `/private/tmp/playbook-13.2-common-v11-prefer-materializer-prepare.mjs` passed `node --check` and has SHA-256 `30b9ea98856b6a46dad96d671f8aaecd333536df96e4724d2c29d4acc8eb39af`.
- Immutable v11 roots were assembled from upstream commit `4a76086f27286e4e59ea7a88f4141b0c04e1009c` with the C8 compiler at `/private/tmp/slc-c8-compiler-ezn78503`: `/private/tmp/playbook-13.2-common-v11-baseline` proof SHA-256 `0461efa61ec9e542a5cafcc25e409c6450f62049bc8dd027b8c002691183cc24`, `/private/tmp/playbook-13.2-common-v11-full` proof SHA-256 `e6bb08aa7c37528ae3673e2ea605341d6d35769ac479a049d0260a94ba8ece80`, and private `/private/tmp/playbook-13.2-common-v11-prefer-materializer` proof SHA-256 `9c48ff5123b9551178087d1f7c3c201eece7f294b3674d2cf234a03aa391ffb3`.
- Assembly readiness is recorded at `/private/tmp/playbook-13.2-common-v11-readiness/assembly-readiness.json` with SHA-256 `5207354ef29f174b3368202a36330da4ae8e37c6b550d0b6ee8729b83f60a41b`; the final run design is `/private/tmp/slc-c8-v11-final-run-design.json.final` with SHA-256 `c4250f1bc461fab5fa5df6e59b4b4054e1633483af9ac751be882b8a2707d525`.
- The assembled v11 baseline/full roots differ only in `playbook/link.md` plus `experiment-proof.json`; comparing v10 baseline/full to v11 baseline/full changes only `playbook/link.md` plus `experiment-proof.json`; comparing v11 full to private preference changes only `playbook/link.md` plus `experiment-proof.json`.
- The combined C8 compiler and dependency inventories checked 11,905 records with zero changes, and the v10 baseline/full inventories had zero changes after assembly.
- No provider acceptance is claimed by this assembly.
