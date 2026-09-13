<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-097: Output Field Guidance

## Status

In progress.

## Intent

Prevent generated result guidance from accidentally declaring extra required output fields and preserve exact runtime authority validation.

## Deliverables

- [x] Specify unambiguous output-clause guidance and update the common producer definition.
- [x] Verify legal representations and the observed malformed representation through SLC and the real runtime extractor.
- [x] Extend immutable experiment assembly with exact prior-definition recovery.
- [ ] Record a corrected real CODE compilation and runtime acceptance.

## Tasks

1. [x] Update and verify the producer boundary and experiment assembly.
2. [ ] Record immutable real-run acceptance evidence.

## Verification

- Preserved C9 CODE `compile-LoUfNr` compiled successfully in 594547 ms but failed runtime acceptance before its first player call because two result descriptions contained explanatory `code` backticks inside output-clause parentheses.
- The runtime correctly counted each such token as a required property; linked outcome authority omitted it.
- No runtime parsing or field-authority relaxation is part of this change, and this compiler-generated defect is not a Source clarification.
- Six result-contract integration tests and eleven immutable-builder tests passed with the updated real SLC installation supplied explicitly.
- Removing the exact new guidance recovers the v11 common text2gears SHA-256 `1f146b9cb00a6de016c5e02a528825daa5ce3bda055eae553e1545b6dde0b639`; the current producer is `2500c1ad4601f7a32bb8d44e7ec1e32d15df7875d4972acfcd6d273358d84b0f`.
- A separate retrospective LoUfNr copy with only explanatory backtick pairs removed from its GEARS and FSM passed all 18 actual runtime scenarios under a corrected private child-fixture profile; that control does not count as a successful compilation or a speed comparison.
