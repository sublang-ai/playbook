<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-080: Relay and Return Representations

## Status

In progress; producer clarification with live efficacy pending.

## Intent

Align prose-required relay and terminal-return guidance with the existing Source-fidelity and Results contracts, without changing authored behavior or weakening checks.

## Deliverables

- [x] Explicit bare-placeholder guidance and lawful terminal-return placement.
- [x] Actual Source-fidelity and Results parser representation cases.
- [ ] New immutable common input assembly and separately adjudicated observations.

## Tasks

1. [x] Clarify untemplated relay rendering under [[compiler-prompt-relays-3](../packages/compiler-prompt-relays.md#compiler-prompt-relays-3)] and terminal-return placement under [[compiler-results-3](../packages/compiler-results.md#compiler-results-3)].
2. [ ] Adopt the same correction in new comparison inputs without changing historical runs and report live efficacy separately.

## Verification

- C3 restored REVIEW `phase-S7Qx6S` retained the exact terminal return in all three complete-result descriptions but added sixteen un-authored labels to otherwise required quoted runtime values.
- The SLC Source-fidelity contract accepts a bare quoted placeholder in that case; the checker matched its existing contract while the phase wording left the lack of a label insufficiently explicit.
- Preserve Source-authored labels exactly; do not infer labels from field names or change the original source to satisfy the compiler.
- An explicit return clause in a complete Results description states caller-visible output, whereas a completion predicate alone does not.
- This is a correctness clarification, not a demonstrated latency improvement; preserve the failed run and every prior definition overlay.
- Eight integration cases pass against the actual C3 parser/checker and runtime composer, including bare versus un-authored labelled relays, exact Source-authored labels, and explicit return clauses inside complete Results descriptions.
