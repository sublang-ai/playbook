<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-055: Compact Link Definition

## Status

In progress; prototype awaits controlled live compilation evidence before adoption.

## Intent

Evaluate [DR-050](../decisions/050-compact-link-definition.md) as an independently measurable compiler-performance technique.

## Deliverables

- [x] Compact link entry and exact runtime companion with preserved citations.
- [x] Published companion surface and full-closure contract checks.
- [ ] Controlled same-engine, same-Source compilation evidence.
- [ ] Retain the technique only when improvement and conformance are demonstrated, or discard it.

## Tasks

1. [x] Split the definition, record its dependency contract, and verify exact moved bytes, package closure, and runtime-contract conformance.
2. [ ] Run the controlled compilation experiment and record the retain-or-discard decision with its evidence.

## Verification

- The parent revision supplies the exact section-byte baseline for the split audit.
- The normal package-surface and runtime-contract suites exercise the published companion and real runtime declarations.
- Live performance comparisons must hold the engine, Source, agent/model, and correctness checks constant and include complete compilation timing.
- Prototype checks passed: all 24 original top-level sections match their destination byte for byte; 81 package-surface and runtime-contract tests pass; 2,668 repository links resolve; Spex 3.0.0 reports no errors.
- The original entry is 154,025 bytes and the compact entry is 29,930 bytes; input-size reduction is 80.6%, not yet a measured compilation-time improvement.
