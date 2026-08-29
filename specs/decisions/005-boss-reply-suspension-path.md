<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-005: Boss-reply suspension path

## Status

Accepted.
[DR-010](010-playbook-session-tracing-and-resume.md) permits the resumed player call to continue its backend conversation in addition to receiving explicit question-and-answer context.
[DR-011](011-composable-playbook-execution.md) extends the same contract to independently parked parallel branches.
[DR-032](032-explicit-roles-session-players.md) replaces the question record's overloaded player label with a discriminated Captain-or-local-role asker.
[DR-040](040-outcome-authority-effect-reconciliation.md) binds an effect-authorized question to one cumulative repository operation, permits only a checkpoint-identical authored continuation, and sends any other exit to unresolved reconciliation while leaving read-only question calls on their unchanged predicate.

## Context

A player may need a specific fact or decision from Boss before the current workflow step can continue.
A general interrupt abandons the current invocation, while an ordinary entry event begins from an idle or recoverable state, so neither preserves the paused step and its exact question.
The runtime must yield the active Boss turn before a human can answer, otherwise the workflow deadlocks waiting inside the turn that owns the input channel.

## Decision

### 1. Explicit suspension state

A player-invoking state may declare a `needsBossReply` result carrying the player's verbatim question.
The FSM shall park that invocation in a quiescent Boss-reply state that records the originating state, player, source item, question, and stable question id.
A parallel workflow shall park only the branch that asked while other branches continue, and multiple pending questions shall remain independently addressable.

### 2. Boss reply event

While a question is pending, the runtime shall classify a Boss answer as `BOSS_REPLY` for one identified question and shall carry the Boss text verbatim as the answer.
The FSM shall reenter only the originating player state with the original prompt context plus explicit labeled question and answer blocks [[1]].
An omitted question id is valid only when exactly one question is pending.
An empty answer, an unknown question id, or a reply for a state not registered as resumable shall not resume a player.

### 3. Abandonment and interruption

A fresh directive may leave the wait through an artifact-declared interrupt or entry path and shall clear every pending question owned by the exited scalar state or parallel group.
Every non-`needsBossReply` exit from a player state and every non-reply exit from a wait shall clear its pending reply context.
No timeout shall expire a Boss question because a human pause has no workflow deadline.

### 4. Runtime and host boundary

The runtime shall treat a Boss-reply wait as quiescent, drain its ordered emissions, return control to the host, and expose each pending question in its structured result and telemetry.
On entering the wait, the runtime shall surface the full question as player-attributed Captain speech and a separate routing marker without truncating the question.
The next Boss turn shall reach the active leaf runtime, and only the selected pending branch or scalar state shall resume.

### 5. Player continuity

The resumed prompt shall always carry the explicit question and answer so behavior remains deterministic across adapters.
Where the player result supplied a continuation token, the resumed call may additionally continue that backend conversation under [DR-010](010-playbook-session-tracing-and-resume.md) and [DR-030](030-shared-mapped-player-continuity.md).
Under [DR-032](032-explicit-roles-session-players.md), the host resolves that continuation from the explicit session player rather than same-role inheritance.

## Consequences

- A workflow can ask Boss a precise mid-step question without discarding its state or blocking the input loop.
- Parallel siblings need not restart when one branch waits for Boss.
- Explicit prompt context remains the portable source of truth, while backend continuation preserves additional conversation and tool context when available.

## References

[1]: https://stately.ai/docs/transitions#external-transitions "XState — external transitions and `reenter`"
