<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-082: Public Linked Option Validator

## Status

Complete.

## Intent

Expose the existing linked option snapshot for deterministic entry validation without changing engine or workflow behavior.

## Deliverables

- [x] Synchronize the public validator and genuine-bootstrap contract.
- [x] Emit and verify the additive public validator in the optional helper.

## Tasks

1. Specify and implement the public validator export with real emitted-module validation and preserved historical experiment reconstruction.

## Verification

Targeted helper, labelled-profile and package-surface suites pass: 26 tests and one historical opt-in skip, including 57 unchanged maintained CODE/DEV runtime assertions.
Strict TypeScript passes; Spex reports zero errors and 251 existing advisory warnings; all relative links resolve.
Independent review found no actionable issue in the public contract, exact shared function binding, bootstrap distinction or historical inverse.
Frozen overlays and the exact-version 12.3 builder remain unchanged; the next common builder revision is a separate integration task.
The CKr2Ni authored `question` outcome's missing payload authority remains a separate quality finding; this intent does not claim that artifact is accepted.
