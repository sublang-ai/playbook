<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-092: Common v9 Source-State Builder Inputs

## Status

Complete.

## Intent

Prepare the Playbook 13.2 common v9 baseline/full experiment builder from immutable v8 plus the reviewed source-state preservation guidance, without changing previous cohorts or claiming provider acceptance.

## Deliverables

- [x] Builder recognizes the v9 FSM-producer hash and records exact inverse recovery to v8.
- [x] Builder acceptance checks the v9 emitted source-state guidance and proof metadata.
- [x] Link-experiments spec records v9 identities and inverse recovery.
- [x] Root-reviewed immutable v9 baseline/full outputs.

## Tasks

1. [x] Update the builder, test, spec, and immutable v9 baseline/full outputs for the reviewed source-state guidance without rebuilding historical cohorts or selecting scaffold guidance.

## Verification

- Focused builder acceptance with the supplied C7 compiler passed: `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-c7-compiler-y4iln8vx ./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts --reporter=verbose` reported 11 passing tests.
- Immutable v9 roots were assembled at `/private/tmp/playbook-13.2-common-v9-baseline` and `/private/tmp/playbook-13.2-common-v9-full`; their proof SHA-256 values are `a7cec2eb8efc8d4bc3a3def53060eade59fd92e43a904a9ddebffb6bf8abe1dc` and `e9f9ad9603a9866c18b320a06078a20a3680bc106df56eaa1b8389da27edfab5`, and readiness was recorded at `/private/tmp/playbook-13.2-common-v9-readiness/readiness.json` with SHA-256 `bfe705884ef3c2c821c5e848b1040c65d6faad2fe8e8ac266c54665bc68ca616`.
- The v9 baseline/full pipeline definitions differ only in `playbook/link.md`, and comparing v8 to v9 changes only `playbook/gears2fsm.md` among pipeline definitions; v9 `gears2fsm.md` is `d6ce9eb0d1c012956a5df8691d66fd8fda0e5a827edd12eba288827af07e2ad0` with inverse proof to v8 producer `4e840accb47c1924be6e63a483f928a592d36edb07c57be82dbecff59b022ce9`.
- The supplied C7 compiler records a private IR090 runtime overlay in `/private/tmp/slc-c7-compiler-y4iln8vx-evidence/cohort.json`; package and lock metadata remain `@sublang/playbook` 13.2.0, but readiness shall not describe the C7 dependency as an unmodified published install.
- The supplied C7 compiler evidence records passed artifact verification and passed interpreted/compiled selection probes with no provider calls; `selection-evidence.json` SHA-256 is `3dbc2a431fb638538d3d29f9e95f79d71a078fc5be879b0f8f6236d2bddb08a3`.
- `./node_modules/.bin/spex lint` passed with 0 errors and 253 existing warnings.
- No provider acceptance is claimed by this assembly.
