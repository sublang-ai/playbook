<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-081: Reuse Canonical Child-Result Validation

## Status

Completed

## Intent

Remove repeated generated public-union rewrites by reusing the existing pure boundary validator while preserving source-owned behavior.

## Deliverables

- [x] Normative guidance and optional scaffold reuse the canonical validator without runner binding.
- [x] Strict standalone import and real bridge case matrix pass with failed historical artifacts unchanged.
- [x] Structural byte comparison and future-cohort limitation are recorded without a latency claim.

## Tasks

1. Implement the shared-validation guidance/scaffold and their integration evidence.

## Verification

Root review passed; 22 focused integration tests include 15 actual-bridge envelope cases and strict standalone NodeNext imports.
Upstream strict TypeScript, 2,877 relative links in 158 files, and Spex 3.0.0 (0 errors) pass.
The structural comparison in `scripts/experiments/child-validator-reuse-evidence.json` replaces 2,899 bytes with a 591-byte wrapper and imports, without a provider or latency-improvement claim.
The original CKr2Ni FSM remains unchanged; future live compilation is required to measure adoption and performance.
