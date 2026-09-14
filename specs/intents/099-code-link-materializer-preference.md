<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-099: CODE Link Materializer Preference

## Status

Complete.

## Intent

Retain the accepted CODE labelled-profile materializer preference in the common link definition and specs without broadening the materializer's supported domain or performance claims.

## Deliverables

- [x] The common link definition preserves the tested preference paragraph and keeps the full contract byte-identical to the accepted `flat-labelled-relays` candidate input.
- [x] DR-051 records the accepted labelled CODE paired observation and keeps its scope limited to that observation.
- [x] The link-materialization package records supported-profile preference behavior and binds the existing packed-definition verification to it.

## Tasks

1. [x] Retain the tested preference, synchronize its scoped decision and requirements, and verify the builder and emitted definition boundary.

## Verification

- The accepted `flat-labelled-relays` CODE comparison is recorded in `scripts/experiments/c10-v13-code-link-pair-evidence.json` and used the same CODE source, accepted GEARS and FSM, immutable C10 engine, emitted public entry, strict typecheck, import check, all four generated suites and the 18-case runtime profile.
- The ordinary linked baseline `c10-v13-code-link-baseline` completed in 638,219 ms total, including 636,735 ms link compilation.
- The materializer candidate `c10-v13-code-link-prefer-materializer` completed in 206,865 ms total, including 205,227 ms link compilation.
- The updated `slc/link.md` SHA-256 is `680b0d2af76bf629c7f7c7417d27aa08205a5cde2ba2eb924389a2df0435642e`, matching the tested prefer-arm input.
- The stripped baseline contract remains expected at SHA-256 `9982d987e9747177876ac7cbac3628fce2afa6e6fec6012c1371b30a712fdad4`.
- The focused Vitest command `./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts src/link-materialization.test.ts src/link-materialization-labelled.test.ts src/compact-link-definition.test.ts` passed 29 tests with 11 environment-gated skips across materializer 22, labelled 5, compact, and builder smoke coverage.
- `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-c10-compiler-axfv25ji ./node_modules/.bin/vitest run src/link-experiment-13.2.test.ts` passed all 11 builder tests.
- `spex lint` passed with 0 errors and 253 existing sentence-boundary warnings.
