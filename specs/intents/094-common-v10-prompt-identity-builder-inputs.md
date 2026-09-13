<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-094: Common v10 Prompt Identity Builder Inputs

## Status

In progress.

## Intent

Prepare the Playbook 13.2 common v10 baseline/full experiment builder from immutable v9 plus the reviewed local-role prompt-identity placeholder exception, without changing previous cohorts or claiming provider acceptance.

## Deliverables

- [x] Builder recognizes the v10 FSM-producer hash and records exact inverse recovery to v9.
- [x] Builder acceptance checks the v10 emitted prompt-identity guidance and proof metadata.
- [x] Link-experiments spec records v10 identities and per-definition inverse recovery.
- [ ] Root-reviewed immutable v10 baseline/full outputs.

## Tasks

1. [x] Update the builder, test, and spec for the reviewed prompt-identity exception without rebuilding historical cohorts or selecting scaffold guidance.
2. [ ] Assemble immutable v10 baseline/full outputs from the reviewed commit and C8 compiler.

## Verification

- Focused builder acceptance with the supplied C8 compiler passed: `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-c8-compiler-ezn78503 ./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts --reporter=verbose` reported 11 passing tests.
- `/opt/homebrew/bin/spex lint` passed with 0 errors and 253 existing warnings.
- Immutable v10 roots are planned for `/private/tmp/playbook-13.2-common-v10-baseline` and `/private/tmp/playbook-13.2-common-v10-full` after root supplies the committed source state.
- No provider acceptance is claimed by this assembly.
