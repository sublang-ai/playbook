<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-075: Relay-Aware Experiment Closure

## Status

Completed.

## Intent

Carry the common prompt-relay correction into both link-experiment arms and track the active text-to-GEARS definition's adjacent references while preserving every historical pair and original published semantic-input identity.

## Deliverables

- [x] Exact inverse proof for the common text-to-GEARS correction, excluding the separate Results performance treatment.
- [x] Sidecar coverage and real discovery/closure checks for active adjacent definition references.
- [x] A new immutable matched pair and explicit provenance for its changes from the prior inputs.

## Tasks

1. [x] Update and verify the assembly boundary under [[link-experiments-6](../packages/link-experiments.md#link-experiments-6)] after the common producer correction is ready.

## Verification

All 11 CLI/discovery/closure cases pass against the frozen C2 compiler, and the test passes strict TypeScript checking.
The suite uses the maintained Markdown-link parser to confirm that every active adjacent phase reference belongs to the real SLC closure, including text-to-GEARS references to `gears2fsm.md`, `link.md` and `optimize.md`.
The new pair differs only in its optional link section; compared with the prior pair, only the common text-to-GEARS definition and sidecar change, with every original semantic-input member unchanged.
The exact two-sentence common relay removal recovers the published definition, and neither arm contains the Results-boundary performance snippet.
The [new local evidence](../../scripts/experiments/link-experiment-13.2-relay-closure-evidence.json) records the supplied compiler cohort, exact output identities, explicit closure additions and separation from preserved historical inputs.
No provider calls or performance acceptance are part of this assembly intent.
