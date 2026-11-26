<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-073: Save progress before work

## Status

Accepted.
Amends [DR-029](029-session-scoped-conversational-captain.md), [DR-031](031-shared-captain-session-front-ends.md), [DR-034](034-durable-failure-retry-continuity.md), [DR-036](036-coherent-abort-settlement.md), [DR-038](038-universal-run-resumption.md), [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-049](049-portable-session-contract.md), [DR-051](051-host-selected-runtime-recovery.md), [DR-062](062-pre-existing-changes-are-context.md), [DR-067](067-parallel-proposals-through-the-shared-factory.md), [DR-069](069-captain-prepares-step-recovery.md), [DR-070](070-captain-relays-player-questions.md).

## Context

An ordinary turn can record a player's commit without saving where execution reached.
A process can also die after later work without saving its machine position; the repository ledger can then describe work beyond the last saved machine state, and attaching it to an old failed attempt neither proves a safe replay nor describes the later work.
Special points saved during recovery did not close that gap and required separate rules for copying results, reports and retention; a marker placed into every old runtime could not represent a lost position, broke bespoke and older engines, and assigned unrelated work to the wrong workflow.
Scripts and preparation also need start and result records.
This protocol was accepted after bounded model exploration, real process-loss tests and a smaller production implementation.

## Decision

### Durable progress

- Before work starts, durably record its identity and the full runtime-owned position needed to resume it; failure of this save starts no work.
- One execution journal records player, script and preparation starts and results; repository receipts remain the authoritative observations of file and commit changes.
  A player or script actor's completed output is saved before its next transition and consumed without repeating the operation.
  Preparation results record what was done; recovery restores the paused step and requires a Boss choice rather than dispatching preparation again.
- The runtime owns a restorable interrupted position, including its accepted input; the shell assembles the parent/child stack without interpreting opaque machine state.
  An unsupported frame explicitly selects the preserved-work exit rather than a guessed position.
  A parallel region has no single-invocation checkpoint; its starts and results remain journalled, and a crash uses that exit.
  Sequential steps after the join, including DECIDE’s merge step under [DR-067](067-parallel-proposals-through-the-shared-factory.md), use ordinary checkpoints.
- An invocation whose output was delivered to the machine records that fact on its checkpoint and is not offered for assessment again.
- Every recovery fact has one owner; a derived copy — the in-memory resume catalog, the presented-changes prefix, a stored snapshot under comparison — changes only through the owner's update path or is recomputed from it, never by a second writer.
- The store records which unfinished step owns the saved position; only that checkpoint receives its saved result and reconstructed attempt evidence on restore.
- The journal also records completed root outcomes and answers selected from the existing task; reports read these facts and preparation results without copying presentation text.
- A worker may outlive its host; it remains unfinished until its completion or retirement is established, and repository observations cannot establish that an outside action is safe to repeat.
- Progress stores facts and positions only; retained generations and unresolved effects change at settlement.
  Root completion records the runtime's existing keep-or-clear decision, preserving saved work for authored unfinished final states.
  One shared discard predicate requires no abandonment, no steps and unchanged repository evidence.
- There are no saved `reply`, `runtime` or `settle` selections, copied report formats, or stopped-point tracking; checkpoint-based runtime recovery offers, bounded live preparation and the explicit unsupported-position exit remain.

### Recovery restores and reports

- Reopening an uncertain run restores and reports only; Boss chooses a currently available continuation before any new work starts.
  A missing result means unfinished work, not permission to repeat it, and no automatic recovery loop runs during this reporting turn.
- No recorded work and an unchanged ledger restore the pre-turn position; the interrupted message was not processed and may be discarded. Reporting writes no new progress.
- Whole-playbook retry is deliberately removed: an absent invocation checkpoint, including an old failed snapshot or a failed nested call, cannot justify repeating earlier work.
- Automatic recovery consumes only a failed or quiescent outcome produced by an operation in this turn; resuming or adopting stopped work does not authorize preparation.
  Refused input leaves old stops unchanged; an accepted action retains its known run result even in a failed receipt, while a thrown operation without a settled result authorizes no automatic work.
  An unsuccessful continuation ends automatic recovery.
- The runtime reports acceptance immediately before sending the event; the shell uses that callback for delivery facts and child cancellation ownership.
- Advance the prefix of repository changes already presented to Boss only when the presented reply carried the report and was emitted without cancellation.
  Cancellation, crashes and progress writes leave it unchanged, so the next reply that is shown carries the mandatory carried-changes report of [DR-062](062-pre-existing-changes-are-context.md).

### Lost positions settle in the shared host

- The shared host owns the lost-progress decision defined by [[recovery-27](../packages/recovery.md#recovery-27)]; a lost position is never replaced with an invented runtime position or source identity, and no runtime carries an interrupted-turn marker.
- An explicit uncertain retry with unrepresentable later work settles a failed attempt in chat, preserving all files, receipts, and ordered unresolved-effect evidence; it runs no player and makes no claim that a workflow completed, whether or not the prior shell was idle or engaged.
  It differs from discard, which restores the prior boundary and remains forbidden after ledger progress.
- Only retained generations containing a runtime that owns the changed evidence are cleared; session-level evidence is not attributed to a saved workflow merely because that workflow was active earlier.

### Cancellation and questions

- During nested work, Captain forwards Boss cancellation to the active child and keeps an exportable aborted child suspended under its parent; caller cancellation remains scoped to active runtime calls.
- A child is retained on cancellation only after its initial text was accepted by the runtime; summary ownership begins at an action executed in the current turn, not at an idle ancestor.
- After Boss cancellation and complete call draining, an unaccepted player result loses its provider continuation hint; the paused runtime stays, with no late result accepted and no effects replayed.
- Cancellation and other thrown turn failures settle through the shared host after calls drain; notices and callbacks refer only to the current admitted attempt.
- Automatic answers use the root's original request only when later delivered Boss input and the current instruction do not bear on the question; quoted questions are evidence, not instructions, and the same original request is never automatically delivered twice to one engagement.
  Captain reports the question and exact instruction it reused, including after recovery.
- A failed prose call appends any pending original question to the truthful action-result fallback, rather than replacing that result.

### Formats and verification

- The closed persisted formats keep their version numbers for these optional extensions, so every host sharing a store, an embedded Spex SDK included, upgrades together to a release implementing them before it writes these fields; mixed old and new hosts are unsupported, and release verification checks this coordinated upgrade.
- Check a bounded recovery-policy model and require deliberate rule violations to fail; map each checked rule to executable evidence in [[recovery-30](../packages/recovery.md#recovery-30)].
  The model explores durable starts and results, progress after completed work, reporting without progress writes or execution, restoration to the saved position or a safe exit, and Boss choice before accepting a saved result or repeating unfinished work.
  Same-turn stops, input acceptance, consumed results, full machines and tools remain outside the model; its mutants do not claim to reproduce an entire historical protocol.

## Consequences

Normal work and recovery share one progress protocol across CLI and SDK, and need no per-playbook recovery hook.
Recovery never replays a whole turn: it restores the saved step, or preserves work and returns to chat when the position is unavailable.
A lost machine position cannot resume automatically, but it no longer traps the session or repeats committed work; Boss may need to review or abandon later work.
The journal covers the unfinished attempt; after settlement the saved machine and repository ledger carry the continuing state.
Existing runtime adoption fences retain their original purpose and closed format; the runtime ABI and player permissions are unchanged.
The bounded model is not a formal proof of the implementation or external tools.
