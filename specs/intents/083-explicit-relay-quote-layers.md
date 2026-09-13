<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-083: Explicit Relay Quote Layers

## Status

Completed; live efficacy remains separately unmeasured.

## Intent

Distinguish the GEARS blockquote delimiter from the literal quote marker of a prose-required relay without changing Source-authored fragments.

## Deliverables

- [x] Explicit file-versus-prompt rendering guidance.
- [x] Actual parser, composer and Source-fidelity representation controls.
- [x] New guidance identity for later immutable input adoption.

## Tasks

1. [x] Clarify the existing bare-relay representation under [[compiler-prompt-relays-3](../packages/compiler-prompt-relays.md#compiler-prompt-relays-3)] and verify its two quote layers.

## Verification

- C3 v5 REVIEW `phase-AegKvB` retained only the GEARS outer marker on seven added relay tokens and was correctly rejected; preserved REVIEW `phase-V4nTvl` had already used two markers successfully.
- The correction concerns representation, not an ambiguous source or an additional required value.
- Compare the actual parsed prompt and exact runtime composition for `> > <evidence>` with rejection of `> <evidence>` and an un-authored label, retaining exact authored templates.
- Preserve every historical overlay and failed artifact; live efficacy remains a separate future observation with newly frozen inputs.
- Four integration cases pass with the unchanged C3 compiler's real parser/checker and the actual runtime composer; strict TypeScript and Spex 3 checks pass.
- Independent observed-run adjudication remains at `/private/tmp/slc-review-v5-007-008-adjudication/evidence.json`, SHA256 `82b77f524cfcfe1a35a57f1df9e100d70118170ac1718ab75823994aec41e05c`.
- The corrected text-to-GEARS input is 22,183 bytes, SHA256 `c38555a7e5e1d33d0c1c71d34beb3b581e62abea819722905ae1af87775922ae`; reversing only the clarified sentence restores the exact v5 SHA `bbefc6806bd84c5b181ef1014a7cbe2d21663be3ce4e2098499b07b134835970`.
