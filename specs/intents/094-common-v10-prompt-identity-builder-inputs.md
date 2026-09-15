<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-094: Common v10 Prompt Identity Builder Inputs

## Status

Complete.

## Intent

Prepare the Playbook 13.2 common v10 baseline/full experiment builder from immutable v9 plus the reviewed local-role prompt-identity placeholder exception, without changing previous cohorts or claiming provider acceptance.

## Deliverables

- [x] Builder recognizes the v10 FSM-producer hash and records exact inverse recovery to v9.
- [x] Builder acceptance checks the v10 emitted prompt-identity guidance and proof metadata.
- [x] Link-experiments spec records v10 identities and per-definition inverse recovery.
- [x] Root-reviewed immutable v10 baseline/full outputs.

## Tasks

1. [x] Update the builder, test, and spec for the reviewed prompt-identity exception without rebuilding historical cohorts or selecting scaffold guidance.
2. [x] Assemble immutable v10 baseline/full outputs from the reviewed commit and C8 compiler.

## Verification

- Focused builder acceptance with the supplied C8 compiler passed: `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-c8-compiler-ezn78503 ./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts --reporter=verbose` reported 11 passing tests.
- `/opt/homebrew/bin/spex lint` passed with 0 errors and 253 existing warnings.
- Immutable v10 roots were assembled from upstream commit `7658f48b9972e5c474468197be0add6c97ce313f` with the C8 compiler at `/private/tmp/slc-c8-compiler-ezn78503`: `/private/tmp/playbook-13.2-common-v10-baseline` proof SHA-256 `d1fb63560bb84e59726aa70e41354bc24fcf7fd6cb995b3e521781461687911d`, and `/private/tmp/playbook-13.2-common-v10-full` proof SHA-256 `7935acd1feab7eec17a2138df0b7ff7c37e13e9639c733a35578263672d0dbc9`.
- The assembled v10 baseline/full roots differ only in `playbook/link.md` plus `experiment-proof.json`; comparing v9 baseline/full to v10 baseline/full changes only `playbook/gears2fsm.md` plus `experiment-proof.json`.
- The C8 compiler inventory checked 245 records and the C8 dependency inventory checked 11,660 records with zero changes against `/private/tmp/slc-c8-compiler-ezn78503-evidence` after assembly.
- No provider acceptance is claimed by this assembly.
