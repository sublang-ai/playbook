<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-085: Authored Question Result Field

## Status

Complete.

## Intent

Clarify that a source-authored result which asks Boss and waits must declare the question payload field explicitly, preserving the authored guard and continuation while avoiding the framework-owned fallback result.

## Deliverables

- [x] text2gears Boss-reply continuation wording.
- [x] compiler-results behavior and representation-test coverage.
- [x] Root-reviewed wording, spec, and representation-test change.

## Tasks

1. [x] Add the wording, spec items, and actual-parser representation test without rebuilding frozen experiment inputs.
2. [x] Complete the reviewed wording, spec, and representation-test change. Future compiler-input assembly is tracked separately.

## Verification

- The representation case parses the GEARS through immutable C3 parser APIs and confirms the annotated `question: <verbatim final text>` field is represented as runtime-supplied whole-final-text metadata when the runtime contract is given an explicit `question` presentation-owned outcome-authority mapping.
- The same case confirms an unannotated typed field remains judge-owned through the explicit semantic outcome-authority mapping.
- The check preserves the authored prompt, guard name, and Boss-wait semantics.
- This one-commit change is a wording/spec/test fix only, not a claim that annotation automatically infers ownership, that the parser detects omitted semantics, or that a future model will choose the right output.
