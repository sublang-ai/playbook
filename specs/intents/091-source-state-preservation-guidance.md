<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-091: Source-State Preservation Guidance

## Status

In progress.

## Intent

Clarify gears2fsm guidance for generated FSMs that must preserve source-owned execution facts and earlier discussion context across Boss-reply continuations.

## Deliverables

- [x] Add compiler guidance for deterministic source-owned availability gates.
- [x] Add compiler guidance for source-required discussion history across fresh and resumed continuation.
- [x] Record the behavior in a cohesive compiler source-state spec package.
- [x] Validate focused definition and XState integration controls.
- [ ] Demonstrate the guidance in a fresh full DEV compilation.
- [x] Root review.

## Tasks

1. [x] Update gears2fsm guidance, specs, and focused tests for source-state preservation.

## Verification

- `vitest run src/compiler-source-state.test.ts --reporter=verbose` passed all 3 focused XState fixture controls.
- `spex lint` passed with zero errors and the existing 253 warnings.
- Root reviewed and approved the guidance, spec duties, and corrected restored-XState/shared-composer fixtures.
- Fresh real compilation evidence remains pending for a later measured compiler run; this intent currently validates guidance and XState fixtures.
