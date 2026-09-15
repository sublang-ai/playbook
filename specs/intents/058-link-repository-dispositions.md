<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-058: Preserve Required Repository Effects at Link Time

## Status

Done (2026-09-12)

## Intent

Clarify disposition authoring so a generic completion result preserves its source-required Git commit.

## Deliverables

- [x] Source-effect disposition rule in the linker and authority specifications.
- [x] Auditable live failure motivating the correction.

## Tasks

1. [x] Clarify commit-required completion metadata independently of result payload fields.

## Verification

The live `compile-hmOuZA` workflow explicitly required a commit but linked `done` as `unchanged` because the result had no effect-owned field; executing it created one real commit and then failed reconciliation.
The existing runtime correctly rejected that mismatch, so this correction changes compiler authoring guidance rather than effect validation.
