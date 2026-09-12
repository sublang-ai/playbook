<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-056: Preserve Optimized Repository Predicates

## Status

Done (2026-09-12)

## Intent

Correct the optimizer's repository example so an explicit current-directory root requirement survives mechanical rewriting.

## Deliverables

- [x] Exact predicate-preservation rule and distinct membership versus own-root examples.
- [x] Real-shell integration evidence for the examples' observable behavior.

## Tasks

1. [x] Correct the definition, record its contract, and verify both scripts with real Git fixtures.

## Verification

- Cold SLC runs `compile-iS1Lmh` and `compile-k6mg7y` preserved the own-root requirement through raw GEARS but weakened it to ancestor-accepting worktree membership during optimization.
- The shell matrix executes scripts extracted from `slc/optimize.md`; it performs no model call and records no compilation-speed claim.
- Six integration tests pass, including nested-directory own-root initialization and linked-worktree preservation; Spex 3.0.0 reports no errors and all 2,664 repository links resolve.
- The pre-change definition matches installed Playbook 12.3.0 byte for byte, allowing the corrected definition alone to be overlaid for a same-engine compiler measurement.
