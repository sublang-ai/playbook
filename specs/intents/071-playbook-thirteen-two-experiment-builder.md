<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-071: Playbook 13.2 Experiment Inputs

## Status

Completed.

## Intent

Reproduce an isolated comparison of ordinary and helper-instructed linking against exact published Playbook 13.2 definitions and a supplied frozen compiler's semantic inputs, without changing the historical 12.3 experiment or adopting a candidate [[link-experiments-1](../packages/link-experiments.md#link-experiments-1)].

## Deliverables

- [x] A separate 13.2 builder with common reviewed correctness corrections and a single optional-helper-instruction treatment.
- [x] Self-contained copies of every ordinary per-phase semantic input, with original locators and exact identities recorded separately from rewritten locators.
- [x] Real CLI and SLC discovery/closure checks, immutable output refusal, and complete reproduction documentation.

## Tasks

1. [x] Implement and verify the bounded builder and its evidence under [[link-experiments-6](../packages/link-experiments.md#link-experiments-6)].

## Verification

The real CLI matrix passes all 11 cases against the frozen ordinary SLC compiler, including its actual discovery and per-phase closure implementation.
Both assembled arms preserve all 19 original per-phase member occurrences and have exactly one different pipeline member, `link.md`.
The test itself passes strict TypeScript checking; Spex reports zero errors, with the new manifest/proof item reviewed as one cohesive concern under meta-29.
The historical 12.3 builder is byte-identical to its prior committed version.
The [reproduction guide](../../scripts/experiments/link-experiment-13.2.md) and [sanitized local evidence](../../scripts/experiments/link-experiment-13.2-evidence.json) retain the exact treatment and identities.
No provider runs, performance acceptance, dependency adoption, or runtime package modification are part of this intent.
