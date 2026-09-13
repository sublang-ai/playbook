<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-064: Clarify Canonical Question Storage

## Status

Completed (2026-09-12).

## Intent

Make the existing scalar and keyed context paths explicit in the FSM producer so private helper factoring cannot hide pending Boss questions from the runtime under [DR-005](../decisions/005-boss-reply-suspension-path.md).

## Deliverables

- [x] Exact canonical storage paths and private-wrapper prohibition in the producer definition.
- [x] Real XState/question-reader regression cases and reproducible future experiment overlay.

## Tasks

1. Clarify storage placement, verify the real reader and singular input projection, and update the exact-version experiment builder.

## Verification

The unchanged `compile-9wgFW3` FSM passes strict types but stores its pending question only under `context.continuation`.
Driving its real XState machine to the wait produces a complete nested record that the installed shared reader cannot see; the current SLC canonical-continuation check reports both affected working states.
The private audit is `/private/tmp/slc-question-storage-audit/`.
The six real XState/shared-reader Captain/Player × scalar/keyed/private-wrapper cases pass in `src/compiler-continuation.test.ts`; the three existing public-state-identity cases also pass.
The package/builder and runtime suites pass 12 cases; the builder suite was rerun after preserving the rejected compact producer's exact earlier bytes.
`tsc --noEmit --project tsconfig.json`, the relative-link checker, and `git diff --check` pass; Spex 3.0 reports zero errors and 232 pre-existing advisory warnings.
The checked-in builder recreates `/private/tmp/playbook-materializer-full-canonical-storage-12.3` with `--full` from the exact installed 12.3 package.
Its proof and the preceding full-v3 proof independently verify every member: only `gears2fsm.md` changes, to SHA-256 `98d6a28c7309a8933ea7057aec03e0f651a2f9e66c8095ced844fd17bd4e5f8f`.
Independent review confirmed the canonical storage boundary and the archived compact-input preservation.
Future compilation timing remains a separate experiment; this correctness clarification has no isolated speed claim.
