<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-069: Captain prepares recovery at the interrupted step

## Status

Accepted.
Amends [DR-029](029-session-scoped-conversational-captain.md), [DR-034](034-durable-failure-retry-continuity.md), [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-051](051-host-selected-runtime-recovery.md).
Amended by [DR-073](073-durable-step-progress.md).

## Context

A restored machine is insufficient when its next invocation still encounters the repository or environment condition that stopped it.
Captain currently cannot inspect or repair that condition, and retrying the entry event can discard progress or be fenced by an earlier successful commit in the same turn.
The procedure author should not need to describe exception handling, and neither Captain nor Boss should need to edit saved machine state.
This record lets a model- or host-selected recovery action, bounded automatic recovery included, run a separate preparation call beside [DR-029](029-session-scoped-conversational-captain.md)'s tool-free Captain, refines [DR-034](034-durable-failure-retry-continuity.md)'s entry retry with a runtime-owned checkpoint of the actual interrupted invocation, adds saved-result assessment and verified read-only restoration to [DR-040](040-outcome-authority-effect-reconciliation.md), and adds automatic recovery after host-selected actions to [DR-051](051-host-selected-runtime-recovery.md).

## Decision

- Ordinary Captain decisions, replies, and adjudication remain tool-free.
- Starting or continuing a task authorizes bounded preparation of its next step; the host may select the same `recover` operation after a recoverable stop produced by an operation of the same turn without asking Boss to repeat that authorization, while resuming or adopting stopped work authorizes none ([DR-073](073-durable-step-progress.md)).
- Recovery is a contract between the host and the runtime, not a catalog of repair tools or error strings: the runtime supplies the interrupted task and an available continuation, Captain prepares prerequisites with its configured tools, and the runtime checks whether that continuation is now valid.
- One Boss turn permits at most two automatic recovery attempts and at most five minutes of preparation in total; an unsuccessful continuation ends automatic recovery, and cancellation stops it.
- Ordinary questions receive a tool-free check without a repository claim or preparation tools.
  A real question requiring a product decision or new authority remains for Boss; a question already answered by the current engagement's saved root request may continue using that exact instruction.
  The saved request and later delivered Boss input survive restoration and adoption; later input is nonselectable context that prevents reuse when relevant, and the same root request cannot be automatically delivered twice.
  Prior answers and unrelated engagements supply no candidate answer, and Captain tells Boss what it answered.
- A missing or contradictory workflow transition is a playbook defect to explain to Boss, never permission to invent a state, report success, or keep retrying.
  Governed judgment can report that no result fits; this preserves its explanation without forcing an outcome or spending a structural correction.
- Repository observations do not prove that an external publication or other outside action is safe to repeat.
  Captain checks that evidence before declaring preparation ready and asks Boss if repetition cannot be shown safe.
- Preparation uses a fresh Captain call with the configured permissions, the exact Boss instruction, and runtime-owned interrupted-step context.
  It may inspect and repair prerequisites, but may not perform the specialist's remaining task, invent an outcome, select an arbitrary state, edit session storage, or rewrite/discard work without Boss authorization.
- The shared runtime captures the current invocation before calling its actor and retains that checkpoint with a parked failure or Boss question.
  Retry reenters that invocation with its original context and input, preserving completed predecessor steps and parent/child ownership.
  Replay permission is established from that invocation's effect boundary, not from all work performed during the Boss turn.
- A missing judgment after a receipted commit is recovered from the saved player text and receipt, without repeating the player.
  The host appends only a validated missing semantic candidate and uses the established reconstructed-result delivery.
- Preparation does not prove completion or override repository-effect evidence.
  After preparation, the host re-reads the runtime's controls; a pending question receives the original Boss input, and a failed invocation uses the runtime's recovery action.
  A failure or unsatisfied continuation stays parked with its explanation.
- A read-only invocation that changed the worktree may be retried after preparation restores its exact original repository observation with no commit movement.
  The host appends that restoration separately from the original receipt; it authorizes another read-only invocation, not acceptance of the failed result.
- An unexpected child-runtime exception preserves a valid parked child and its parents instead of converting it to a completed workflow failure.
- Preparation, like every start of work, is recorded before it runs, and its result records what was done; an interrupted preparation restores the paused step for a Boss choice rather than dispatching preparation again ([DR-073](073-durable-step-progress.md)).
- Uncertain-turn recovery never chooses discard automatically and never replays a whole turn: it restores and reports the saved step, or settles lost progress in the shared host ([DR-073](073-durable-step-progress.md)).
- Recovery is host/runtime behavior, independent of individual workflow repair recipes; the default Captain source and compiled controller add `recover`, requiring SLC’s recovery-controller discriminator [[1]].
  Existing checkpoints without the new optional invocation checkpoint keep their existing advertised controls.

## Consequences

Captain can repair a missing prerequisite and resume the interrupted leaf without restarting its ancestors or completed phases.
The source language, artifact ABI, and ordinary player permissions are unchanged.
Release the supporting SLC verifier before compiling this Captain, and ship Spex’s Captain input and recovery controls with the corresponding Playbook SDK behavior; UI-only presentation remains in Spex.
Historical receipts and unresolved-effect fences remain evidence rather than editable instructions.
Unsupported or irreparable historical states are reported honestly rather than advanced by a guessed event.

## References

[1]: https://github.com/sublang-ai/slc/blob/main/specs/decisions/053-recovery-controller-discrimination.md "SLC DR-053: Recovery-capable controller discrimination"
