<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-096: Common v11 Option Snapshot Builder Inputs

## Status

In progress.

## Intent

Prepare the Playbook 13.2 common v11 baseline/full experiment builder from immutable v10 plus the reviewed public option JSON snapshot guidance, without changing previous cohorts or claiming provider acceptance.

## Deliverables

- [x] Builder recognizes the v11 common link hash and records exact inverse recovery to v10.
- [x] Builder acceptance checks the v11 emitted option-snapshot guidance and proof metadata.
- [x] Link-experiments spec records v11 identities and per-definition inverse recovery.
- [ ] Root-reviewed immutable v11 baseline/full outputs.
- [x] Private v11 materializer-preference preparation script records the reviewed preference paragraph and post-assembly proof checks.

## Tasks

1. [x] Update the builder, tests, and spec for the reviewed option JSON snapshot guidance without rebuilding historical cohorts.
2. [ ] Assemble immutable v11 baseline/full outputs from the reviewed commit and C8 compiler, then execute the private materializer-preference variant without upstream adoption.

## Verification

- Focused builder acceptance with the supplied C8 compiler passed: `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-c8-compiler-ezn78503 ./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts src/compact-link-definition.test.ts --reporter=verbose` reported 12 passing tests and 1 skipped historical optional test; `src/link-experiment-13.2.test.ts` supplied the 11 builder acceptance cases.
- `/opt/homebrew/bin/spex lint` passed with 0 errors and 253 existing warnings.
- Private preference preparation script `/private/tmp/playbook-13.2-common-v11-prefer-materializer-prepare.mjs` passed `node --check` and has SHA-256 `30b9ea98856b6a46dad96d671f8aaecd333536df96e4724d2c29d4acc8eb39af`.
- No provider acceptance is claimed by this builder preparation.
