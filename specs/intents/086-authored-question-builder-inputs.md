<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-086: Authored Question Builder Inputs

## Status

Complete.

## Intent

Adopt the reviewed text-to-GEARS authored-question field declaration into the Playbook 13.2 link-experiment builder as a new v7 ordinary/helper pair while preserving the exact inverse to v6 and leaving previous cohorts untouched.

## Deliverables

- [x] Builder recognizes the v7 text-to-GEARS hash and records the authored-question inverse to the v6 hash.
- [x] Builder acceptance checks the v7 emitted text-to-GEARS guidance and proof metadata.
- [x] Link-experiments spec records the v7 text-to-GEARS identity and inverse.
- [x] Root-reviewed immutable v7 baseline/full outputs.

## Tasks

1. [x] Update the builder, test, spec, assembly note, and immutable v7 baseline/full outputs for the reviewed authored-question field declaration without selecting scaffold-v3 or rebuilding historical cohorts.

## Verification

- Focused builder acceptance passed with 11 tests: `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-fidelity-compiler-ehkjoo54 ./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts`.
- The baseline proof at `/private/tmp/playbook-13.2-common-v7-baseline/experiment-proof.json` has SHA-256 `fe2d7d513abbbc0f8b61cded75289fa2ff6e9a2659f5abd43505efc489c7f37c`.
- The full proof at `/private/tmp/playbook-13.2-common-v7-full/experiment-proof.json` has SHA-256 `ceeb56f50e91b61fa5a7f6e859c6d28fca0420bab785d7bb52a87d263eae817b`.
- Both v7 outputs carry text-to-GEARS SHA-256 `56f414ec3243fda97bb847871b460fdaaf0bba1585627e0897ccdf95a80d7aa4` and record exact recovery of v6 SHA-256 `c38555a7e5e1d33d0c1c71d34beb3b581e62abea819722905ae1af87775922ae` before older inverses run.
- The generated proof records the authored-question correction hash `3d175da602a2517c3bcc74705ad293575aa6c7547acc3fe6b9dd73a15c5b8664`, its original paragraph-separator prior hash `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b`, equal ordinary semantic inputs, equal compiler inventory, and equal common hashes for both arms.
- Only `playbook/link.md` differs between the baseline and full emitted output members; this assembly retains materializer guidance in the full arm, leaves scaffold-v3 unselected, and makes no provider, dependency, runtime, or performance claim.
