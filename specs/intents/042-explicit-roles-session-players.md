<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-042: Explicit roles and session players

## Status

Done

## Intent

Implement explicit playbook-local roles bound to stable Captain-session players, including compatible model and effort retuning across durable interactive and headless continuation.

## Deliverables

- [x] Authored and compiled workflows carry canonical local roles and parallel-role constraints without host player identity.
- [x] The runtime accepts explicit role bindings, emits distinct role and player trace identity, and persists only schema-version-3 local-role continuation projections.
- [x] The Captain shell owns one durable player ledger per logical session and shares a conversation only where role bindings name the same player id.
- [x] Shared config declares flat session players and exact per-playbook role bindings, including segmented ids and launch-time concurrent-role validation.
- [x] Ordinary reopen retains stored structure while applying compatible current model and effort, and uncertain retry retains its exact attempted settings.
- [x] Fresh interactive sessions use the same durable record, lease, and write-ahead boundary as headless sessions and can reopen across either front end.
- [x] Required cligent host capabilities, migration guidance, deterministic gates, packed smoke, and selected acceptance checks pass without publishing or tagging a release.

## Tasks

1. Record this implementation sequence and its map entry in one commit.
2. Add segmented player ids, atomic complete per-call player and Captain settings with explicit provider-default selection, and an embedding-owned transactional interactive lifecycle to cligent with its governing specs and focused compatibility tests in one cligent-repository commit.
3. Cut over the complete published workflow/runtime surface atomically: introduce canonical role bindings, invocation-scoped prompt identity, trace and runtime-snapshot schema `3`, artifact schema `2`, resolved-player concurrency, and safe token preservation in the shared runtime; migrate the playerless session-Captain plus CODE, REVIEW, and DECIDE source, GEARS, FSM, linked or bespoke runtime, registries, generated siblings, and conformance tests; and leave no public schema-1 adapter or legacy player metadata in one commit.
   This combines the former workflow-specific tasks because a strict schema-2 factory committed before its exported workflows would make the public package unusable.
4. Replace the launch plan's per-playbook player blocks with flat top-level players, exact role bindings, complete tuning selections, referenced-player-only projection, and pre-host concurrent-role validation, updating the starter and focused config tests in one commit.
5. Prepare cligent `0.21.0` as the unreleased feature candidate that contains task 2, including exact version metadata, changelog rollover, deterministic packed-artifact evidence, and release smoke in one cligent-repository commit without tagging, pushing, or publishing it.
6. Atomically replace root-frame token ownership and same-role inheritance with the Captain-session player ledger, explicit frame bindings, complete per-call settings, the prepared cligent capability floor, and shell snapshot schema `3`, while upgrading durable records and ordinary headless continuation to record schema `3`, authoritative stored-catalog projection, compatible current tuning, exact uncertain-attempt settings, and fail-closed legacy rejection in one commit.
   This combines the former shell and durable-headless tasks because a schema-3 shell committed atop the schema-2 store would persist fresh sessions that the same checkout cannot reopen.
7. Make cligent's prepared managed attachment accept an activation `AbortSignal` plus a synchronous native-client hand-off callback, retire its managed child before rejecting an interrupted activation, and preserve cleanup failures without changing the launcher's session lifecycle in one cligent-repository commit.
8. Make fresh and selected interactive sessions use the durable UUID, pane-child-owned lease, turn-zero settlement, per-turn write-ahead, authoritative selected-session restoration, cancellation-safe attachment, and cross-front-end hand-off boundaries, with focused interactive integration tests in one commit.
9. Update public documentation, CLI help, configuration migration guidance, and changelog for explicit roles and session players in one commit.
10. Update deterministic release guards, packed smoke, and selected live acceptance for segmented ids, explicit sharing and isolation, cross-process retuning, and both-front session continuation in one commit.
11. Prepare the next-major candidate metadata and run sufficient deterministic, packed, acceptance, and any conditionally required manual verification; record this intent complete and stop for review without tagging, pushing, publishing, or creating a release in one commit.

## Verification

- CODE, REVIEW, and DECIDE expose canonical local roles and registry-derived concurrent role sets, with no host player identity in machine state.
- Two roles bound to one player reuse one sequential provider conversation across nested and later root engagements, while distinct player ids remain isolated.
- A configuration that aliases concurrently active DECIDE roles rejects before host or agent work.
- A session created by either front end reopens through either front end with one public id, one exclusive writer, and no replay of settled or pending effects.
- A stored player token created with one model resumes under a compatible current model or effort selection, while adapter, instruction, permissions, working directory, and active bindings remain protected.
- Adding an unrelated current playbook or player cannot invalidate or enter a reopened stored catalog and causes no preparation, import, readiness, or host work.
- Legacy artifact, trace, runtime snapshot, shell snapshot, and durable record schemas reject before effects rather than guessing role or player identity.
- The packed candidate passes deterministic release smoke and selected real-agent acceptance without publication or tagging.
