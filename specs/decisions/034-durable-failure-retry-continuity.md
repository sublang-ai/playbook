<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-034: Durable failure-retry continuity

## Status

Accepted.
Extends [DR-029](029-session-scoped-conversational-captain.md)'s runtime-owned recovery actions to the recovery a parked failure state still offers after the process that reached it ends.

## Context

- [DR-029](029-session-scoped-conversational-captain.md) made each working runtime the owner of the recovery actions valid from its current state, and the compiled Captain routes an explicit Boss recovery or resume request only to an action that runtime currently advertises.
- The failure-state retry action replays the last classified Boss event, which the runtime records in process memory and the durable snapshot deliberately excludes [[playbook-runtime-52](../packages/playbook-runtime.md#playbook-runtime-52)].
- A continued session therefore restores a playbook parked in the recoverable failure state with no retry, because restoring a frame rebuilds its runtime without that record.
- The same gate also withholds retry inside the live process whenever the last Boss boundary was a reply that resumed the work which then failed, since a failure state accepts only its entry event and refuses the recorded reply.
- The explicit-state-jump alternative covers neither case: a jump probe omits textual fields because `apply` never invents free text, so a target stays unadvertised both where its guard requires nonempty Boss intent and where the machine declares no jump event at all.
- A playbook parked in the recoverable failure state — a nested REVIEW leaf after a reviewer player error under a headless CODE run, for example — therefore advertises zero actions, and the Captain can only dismiss and restart it.
- The input a retry needs is nonetheless durable already: both maintained workflows copy the exact Boss entry text into an FSM context member that the persisted machine snapshot carries, in both failure shapes.
- The gap is a process boundary rather than a front-end difference, so [DR-031](031-shared-captain-session-front-ends.md)'s one durable session recovers differently depending only on whether the hosting process survived the turn.

## Decision

1. **A failure-state retry is sourced from the persisted machine snapshot.**
   Where an artifact declares which FSM context member its entry action copies the exact Boss text into, the runtime shall build the retry candidate's payload from that member of the live snapshot instead of from the recorded event.
   The same action then derives in the process that exported the snapshot and in every process that restores it, and a failure reached after a Boss reply becomes recoverable in both.
   Where an artifact declares no such member, the recorded last classified event remains the source and today's behavior is unchanged.

2. **The durable runtime snapshot is unchanged.**
   No snapshot member is added, reinterpreted, or removed, so the schema version and the validator's closed key set stay as they are, and the recovery input keeps the single home the machine snapshot already gives it.
   The declaration is one optional member of the artifact's entry-event contract, and no Boss text enters a record whose machine snapshot did not already carry it.

   The source is declared rather than inferred from a context member that happens to match the entry event's text field, because an inferred match would silently turn a same-named member of any artifact into a replay payload and change what that artifact advertises without its author saying so.

3. **Candidate exclusion and the free-text invariants are unchanged.**
   A candidate whose sourced text is absent or empty, whose event the live snapshot refuses, or whose label could only be an identifier shall be excluded exactly as today.
   The jump probe still omits textual fields, and `apply` still never invents free text and never enters Boss-input classification.

4. **The recorded event and the apply receipts stay process-local.**
   Cross-process at-most-once execution rests on the per-session lease and the host's write-ahead uncertain record ([DR-031](031-shared-captain-session-front-ends.md) §4), which is never continued automatically and whose explicit retry already warns that effects may duplicate.

Considered and rejected: persisting the recorded last classified Boss event in the durable snapshot.
It leaves a failure reached after a Boss reply unrecoverable, because the failure state refuses the recorded reply however durably it was kept, so it fixes half of one defect while buying a replay generality no maintained workflow needs.
It also stores a second copy of text the machine snapshot already carries, spreads the snapshot's closed key set across the exporting runtime, the shared validator, and the shell's restore comparison, and gives the replayed event a provenance the validator cannot re-check, since a rehydrated event carries whatever the record file says rather than what the runtime classified.

Considered and rejected: letting an explicit recovery request fall back to classification-backed delivery when the runtime advertises no action.
That changes the compiled Captain's closed selection semantics and restarts the work under freshly classified text instead of the input the Boss already gave.

## Consequences

- A playbook parked in the recoverable failure state, root or nested leaf, advertises the same retry to a continued session as to the live process, so the Captain's recovery policy reaches it through either front end without dismissing the engagement.
- A failure reached after a Boss reply resumed the work becomes recoverable, where today it advertises nothing in either process.
- Retry re-enters the failure state's declared target under the recorded input, so a workflow that clears in-flight progress on re-entry still does, and the action's label continues to name that target's meaning rather than what re-entry discards.
- An artifact that declares no context member keeps today's process-local behavior, so the guarantee is per-artifact rather than engine-wide.
- [[playbook-runtime-52](../packages/playbook-runtime.md#playbook-runtime-52)]'s retry clause and its verification item, the matching control-surface text of [slc/link.md](../../slc/link.md#control-surface-optional), and the CODE and REVIEW artifacts require coordinated amendment, shipped as a minor release.
- [[playbook-runtime-45](../packages/playbook-runtime.md#playbook-runtime-45)] and the durable-record items are unaffected, because the decision persists nothing new, and a record written under it stays readable by any engine that accepts the current schema.
