<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-091: Source-State Preservation Guidance

## Status

Complete.

## Intent

Clarify gears2fsm guidance for generated FSMs that must preserve source-owned execution facts and earlier discussion context across Boss-reply continuations.

## Deliverables

- [x] Add compiler guidance for deterministic source-owned availability gates.
- [x] Add compiler guidance for source-required discussion history across fresh and resumed continuation.
- [x] Record the behavior in a cohesive compiler source-state spec package.
- [x] Validate focused definition and XState integration controls.
- [x] Demonstrate the guidance in a fresh full DEV compilation.
- [x] Root review.

## Tasks

1. [x] Update gears2fsm guidance, specs, and focused tests for source-state preservation.

## Verification

- `vitest run src/compiler-source-state.test.ts --reporter=verbose` passed all 3 focused XState fixture controls.
- `spex lint` passed with zero errors and the existing 253 warnings.
- Root reviewed and approved the guidance, spec duties, and corrected restored-XState/shared-composer fixtures.
- Fresh C7-v9 DEV run `compile-wm3i4U` passed full compilation, strict checking, entry import, and all 8 emitted tests without source clarification; compilation took 851.017 seconds and the complete benchmark 858.323 seconds.
- The unchanged generated public entry passed all 24 source-aware runtime scenarios, including premature discussion-completion rejection and restored discussion-history preservation; all 11,660 C7 dependency entries remained unchanged.
- Compiler summary: `/private/tmp/slc-c7-complex-full-evidence/compile-wm3i4U/summary.json`, SHA-256 `964bed784c2d8d616fa19efe1c14554f7e08fd136c1ac494c913fb8a18444415`.
- Runtime summary: `/private/tmp/slc-c7-dev-wm3i4U-runtime-acceptance/summary.json`, SHA-256 `82ff7c803b8272d0a2227400d1b2aa6b7edbd6396d1444ebcef2d346ea2472ff`.
- C7 uses the separately documented private runtime fix from IR-090; this run proves source-state behavior, not a causal compilation speed improvement.
