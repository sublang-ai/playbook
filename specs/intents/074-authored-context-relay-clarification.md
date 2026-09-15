<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-074: Authored Context Relay Clarification

## Status

In progress

## Intent

Clarify the existing producer obligation after a REVIEW output retained revision authority in conditions but omitted the required revision from every acting prompt.

## Deliverables

- [x] Minimal common definition clarification with real-parser/composer delivery checks.
- [x] Identical common correction in both Results experiment arms and both full-compilation link arms.
- [ ] Source-aware REVIEW clean, mutant, and restored observations after the correction, preserving the original failure.

## Tasks

1. [x] Clarify delivery to every governed prompt and verify the distinction from metadata-only mention.
2. [ ] Freeze corrected comparison inputs and independently adjudicate new REVIEW observations without assuming the wording cures model omissions.

## Verification

- Original restored REVIEW run `/private/tmp/slc-current-corpus-evidence/phase-i1aKuK` remains a phase-success/source-fidelity-failure observation: source lines 60 and 86 require quoted exact revision in all four acting prompts, while emitted conditions and result contracts alone retain it.
- Preserve source and artifact hashes in `/private/tmp/slc-current-code-adjudication/cases-006-009.json`.
- Keep this correctness clarification separate from the unmeasured Results-boundary treatment.
- Preserve the compiled-execution contract and add no model call, natural-language checker heuristic, or new author question for the generated omission.
- The immutable `/private/tmp/playbook-13.2-relay-common-v3-{baseline,full}` link pair and `/private/tmp/slc-results-boundary-pair-v1/{baseline,treatment}` phase pair share the common correction; only the latter treatment adds the separate Results reminder.
