<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-098: Entry Guard Input Order

## Status

Complete.

## Intent

Ensure workflows accept per-turn caller text without turning a generated entry guard into a startup-option requirement.

## Deliverables

- [x] Clarify event-before-action validation in the FSM producer and the linker's independent Source-bootstrap rule.
- [x] Verify guarded entry through an emitted module and the actual shared runtime while retaining genuinely required options.
- [x] Preserve exact earlier definition bytes in immutable experiment assembly.
- [x] Complete and runtime-validate CODE using the corrected compilation stages, with actual resumption scope and cost distinguished from a cold full run.

## Tasks

1. [x] Clarify and verify entry event ordering and Source-owned construction inputs.
2. [x] Record accepted resumed compilation and matched link evidence.

## Verification

- C10/v12 `compile-9tWwI3` compiled in 651864 ms and completed its benchmark in 659530 ms, with six Opus 5 calls and eight generated tests passing.
- Its FSM guard `hasCallerInput` reads only context before the entry action copies `event.callerInput`, and its linker incorrectly uses that generated guard as evidence that `callerInput` is a required startup option.
- The actual public entry rejects both absent options and an empty record, recorded in `/private/tmp/slc-c10-9tWwI3-entry-option-control.json`; this is a generated-artifact defect, not Source ambiguity.
- `entryEvent.contextField` supplies failure-retry text from context; it does not copy a fresh entry event's text before the FSM guard.
- No original artifact will be edited, no fixture will pre-seed the caller task to waive the defect, and no uncompiled control will be reported as a successful fresh compilation.
- `/private/tmp/slc-c10-9tWwI3-entry-guard-control.json` runs the original unchanged FSM through XState with empty caller-text context: its original guard remains idle after a valid `START` event, while a separately provided counterfactual event-aware guard enters `firstPhase` with the exact supplied text and one captured player input.
- The materializer suite passed 22 tests, including both real shared-runtime guard controls and preservation of a genuinely required option; the initial new positive test attempted to export a terminal snapshot, then was corrected to assert the real terminal output instead.
- Eleven builder tests and six result-contract tests passed with the frozen C10 compiler supplied explicitly; one compact packaging/inverse test passed with one historical skip.
- The builder recovers the exact prior common link SHA-256 `27f94324b90454f7f960e84d192600fcf59813ba90012bade3b3fdad1c51e42f` and prior producer SHA-256 `5aefade11a4f45b3ebb269b921f1f013363ee129a449b368ec7f83dd0cbf75ee` by removing only the new guidance.
- Global Spex reports zero errors and 253 existing warnings; live resumed-compilation acceptance remains pending.

- The [accepted C10/v13 CODE pair](../../scripts/experiments/c10-v13-code-link-pair-evidence.json) preserves original Source and accepted GEARS, then uses real resumed FSM `2E2YFN` and links `crYwRj` / `aMUkFr`; each ordinary emitted entry passes strict TypeScript, import, eight generated tests, and all eighteen runtime cases with real Git and controlled player/child responses.
- The real FSM accepts exact caller text through START_CODE with empty startup options; both public entries preserve this behavior without a pre-seeded caller task.
- Post-runtime checks preserve all 11921 baseline and 11922 candidate wrapper inputs; this is accepted resumed phase-chain correctness and a matched link measurement, not a cold full-source CODE timing.
