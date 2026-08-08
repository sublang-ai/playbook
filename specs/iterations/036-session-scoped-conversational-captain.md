<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-036: Session-Scoped Conversational Captain

## Goal

Implement [DR-029](../decisions/029-session-scoped-conversational-captain.md): make the compiled Captain a session-long conversational controller outside the working-playbook stack, backed by a recoverable conversation and runtime-owned recovery actions.

## Deliverables

- [x] Optional runtime `describe` / `apply` capabilities with validated, keyed action receipts.
- [x] A recompiled session-loop Captain and a shell that routes deterministic commands and model decisions through the same controller.
- [x] Durable Captain continuity using cligent's resume token and validated reply surface.
- [x] Grounded, nonzero-only turn summaries.
- [x] Hermetic integration coverage, a live conversational acceptance scenario, and a model-free release smoke.
- [x] A release gate for the required cligent contract and public package surfaces.

## Tasks

1. Add the runtime control capability and its public contract.
2. Align the CAPTAIN and CAPPLAY item packages with DR-029.
3. Rewrite and recompile the Captain playbook as a persistent controller.
4. Rework the interactive shell around the durable controller conversation.
5. Raise the cligent floor to the release providing `resumeToken` and `emitReply`.
6. Add the conversational live-acceptance scenario.
7. Add the packed, model-free release smoke and public-surface gates.

The later review found that separate refusal, failure, and recovery branches still broke the intended single result path and that conversational handoff could omit earlier intent.
[IR-039](039-unified-captain-results.md) records that focused correction.

## Acceptance criteria

- The Captain can chat while a working playbook is parked without moving it.
- It can start, switch, dismiss, deliver to, or apply an advertised recovery action to the working stack.
- Loss of model continuity restores the Captain conversation without replacing working playbooks or repeating completed work.
- Replies and summaries are grounded in recorded outcomes, and zero activity produces no saved-counts line.
- `playbook run` behavior remains unchanged.
- Unit and integration tests, the packed release smoke, and the live conversational acceptance scenario pass on the release candidate.
