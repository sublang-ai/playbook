<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-039: Unified Captain Results

## Goal

Complete [DR-029](../decisions/029-session-scoped-conversational-captain.md) by replacing the Captain shell's separate refusal and recovery paths with one conversational action-result path, complete recovery history, and faithful multi-turn task handoff.

## Deliverables

- [x] Every non-response selection, including rejection, failure, and partial completion, returns its result to the durable Captain conversation before the turn reply.
- [x] Recovery preserves every accepted Boss turn and completed action outcome without repeating an action.
- [x] A start or switch after conversational planning can hand the target the complete agreed request.
- [x] The compiled Captain source and artifacts express the unified loop.
- [x] CAPTAIN, CAPPLAY, release documentation, and acceptance coverage agree with the implemented behavior.

## Tasks

1. Align the Captain and Captain-playbook items with DR-029 and retire the status-only refusal and separate refusal-memory path.
2. Route every selected action through one shell result path and keep action execution final before any reply or recovery attempt.
3. Make session recovery cover missed Boss turns, replies, and action results while preserving the working-playbook stack.
4. Permit a Captain-authored start or switch handoff to carry the complete request agreed across the remembered conversation.
5. Rewrite and recompile the Captain playbook where the controller contract changes, then update integration and release coverage.

## Acceptance criteria

- A fact stated before a forced conversation replacement remains understood afterward without being restated.
- A failed or aborted turn is present in the recovered conversation, while completed work and the engagement stack remain unchanged.
- A rejected runtime action and a switch whose start fails both receive one natural reply grounded in the complete reported result; a later “why?” continues from that result.
- Failure while composing or presenting a result never repeats the selected action.
- After several planning turns, starting or switching hands the target the complete agreed task rather than only the last Boss message.
- Status chat while a playbook is parked leaves it untouched, and an advertised recovery action executes at most once.
- A turn with zero counted activity never prints a `Saved you 0` line.
