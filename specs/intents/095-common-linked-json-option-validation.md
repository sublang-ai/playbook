<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-095: Common Linked JSON Option Validation

## Status

Complete.

## Intent

Prevent generated public option validators from accepting non-JSON inputs by directing the common link contract to the existing shared JSON snapshot boundary before artifact-specific validation.

## Deliverables

- [x] Common link guidance and the public option-validation spec require shared JSON capture before option inspection or normalization beyond top-level absence.
- [x] Existing emitted-validator integration coverage verifies invalid property descriptors and valid option preservation.
- [x] Paired real-artifact controls record the original failure and shared-helper behavior without altering either artifact.

## Tasks

1. [x] Update the common definition and existing spec, verify the existing public helper through emitted-validator integration, and preserve actual failed-artifact evidence.
2. [x] Record the real paired artifact controls and subsequent compilation acceptance under the combined guidance.

## Verification

- The unchanged C8 DEV baseline `compile-oQuUMT` passed normal staged entry emission, strict typechecking, import, and four emitted suites with eight tests before its independent public option control.
- `/private/tmp/slc-c8-oQuUMT-option-control.json` records the normal staged entry's public validator accepting a non-enumerable `developmentRequest` string and returning it enumerable, while the same input through C8's public `snapshotJsonValue` throws `TypeError`; ten protected source, artifact, entry, and engine file hashes remained unchanged.
- `/private/tmp/slc-c8-tKSZCs-option-control.json` records the materialized candidate's normal staged public validator rejecting the identical input with the same `TypeError` as the shared helper; the corresponding ten protected file hashes remained unchanged.
- Both independently staged artifacts passed the existing 24 DEV public runtime cases, recorded by `/private/tmp/slc-c8-dev-oQuUMT-runtime-postrun.json` and `/private/tmp/slc-c8-dev-tKSZCs-runtime-postrun.json`; those cases are separate from the baseline's failed option contract and from measured link time.
- `/opt/homebrew/bin/spex lint` passed with 0 errors and 253 existing warnings; scoped `git diff --check` passed.
- The existing `src/link-materialization.test.ts` integration suite passed all 20 tests, including actual emitted public validators rejecting non-enumerable, accessor, and symbol-keyed properties without evaluating getters while retaining valid options as detached frozen records.
- The existing `src/compact-link-definition.test.ts` suite passed one packaging and historical inverse-recovery test with one historical skip after correcting a local test-string syntax error; previous definition hashes remain unchanged.
- `/private/tmp/playbook-13.2-common-v11-readiness/readiness.json` records those focused results and the separately passing 11-test C8 builder suite.
- Subsequent compilation under the combined v11 guidance remains pending.
- The baseline's compiler success and source/runtime checks do not establish full option-contract acceptance; no provider run or speed improvement is claimed by this guidance change.

- The [accepted C10/v13 CODE pair](../../scripts/experiments/c10-v13-code-link-pair-evidence.json) preserves original Source and accepted GEARS, then uses real resumed FSM `2E2YFN` and links `crYwRj` / `aMUkFr`; each ordinary emitted entry passes strict TypeScript, import, eight generated tests, and all eighteen runtime cases with real Git and controlled player/child responses.
- Both public validators accept empty options and optional caller/run-results strings, reject unknown and non-JSON values including non-enumerable/accessor properties, and perform zero getter reads.
- Post-runtime checks preserve all 11921 baseline and 11922 candidate wrapper inputs; this is accepted resumed phase-chain correctness and a matched link measurement, not a cold full-source CODE timing.
