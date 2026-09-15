<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-089: Common v8 Builder Inputs

## Status

Complete.

## Intent

Prepare the Playbook 13.2 common v8 baseline/full experiment builder from immutable v7 plus the reviewed nested-call busy-tag and definition corrections, without selecting scaffold guidance or changing previous cohorts.

## Deliverables

- [x] Builder recognizes the v8 text-to-GEARS and FSM-producer hashes and records exact inverse recovery to v7.
- [x] Builder acceptance checks the v8 emitted nested-call guidance and proof metadata.
- [x] Link-experiments spec records v8 identities and inverse recovery.
- [x] Root-reviewed immutable v8 baseline/full outputs.

## Tasks

1. [x] Update the builder, test, spec, and immutable v8 baseline/full outputs for the reviewed nested-call corrections without rebuilding historical cohorts or selecting scaffold guidance.

## Verification

- `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-coverage-compiler-p6olqovu ./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts --reporter=verbose` passed 11 focused tests.
- `spex lint` passed with zero errors and the existing warning profile.
- `git diff --check -- scripts/build-link-experiment-13.2.mjs src/link-experiment-13.2.test.ts specs/packages/link-experiments.md specs/intents/089-common-v8-builder-inputs.md` passed.
- The baseline proof at `/private/tmp/playbook-13.2-common-v8-baseline/experiment-proof.json` has SHA-256 `0d6f0ffb8c7f101e053bc72d1b2aa655cc6cef224fe9e7722e95faafe9b977ca`.
- The full proof at `/private/tmp/playbook-13.2-common-v8-full/experiment-proof.json` has SHA-256 `c86d23c1d2b5f472e205219eacadf7ca117f19413f6282642df6382ac089af59`.
- The readiness evidence at `/private/tmp/playbook-13.2-common-v8-readiness/evidence.json` has SHA-256 `7a9e79aa28611d2ab2dd95377c06158db84e20443d3d5c2c2f634ea4f2509f85`.
- Root reviewed and approved the v8 source hashes, inverse chain, upstream diff, and immutable output proofs before commit.
- The builder source bytes committed here are the same bytes used to produce the recorded v8 proofs; no v8 proof was rewritten for the commit.
