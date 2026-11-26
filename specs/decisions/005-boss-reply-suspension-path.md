<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-005: Boss-reply suspension path

## Status

Accepted.
Amended by [DR-010](010-playbook-session-tracing-and-resume.md), [DR-011](011-composable-playbook-execution.md), [DR-032](032-explicit-roles-session-players.md), [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-079](079-topology-selects-question-storage.md), [DR-082](082-retain-input-owned-boss-replies.md), [DR-090](090-every-role-hears-the-boss.md).

## Context

A player may need a specific fact or decision from Boss before the current workflow step can continue.
A general interrupt abandons the current invocation, while an ordinary entry event begins from an idle or recoverable state, so neither preserves the paused step and its exact question.
The runtime must yield the active Boss turn before a human can answer, otherwise the workflow deadlocks waiting inside the turn that owns the input channel.

## Decision

### 1. Explicit suspension state

A player-invoking state may declare a `needsBossReply` result carrying the player's verbatim question.
The FSM shall park that invocation in a quiescent Boss-reply state that records the originating state, the asker — the Captain or a local role ([DR-032](032-explicit-roles-session-players.md)) — the source item, the question, and a stable question id.
A parallel workflow shall park only the branch that asked while other branches continue, and multiple pending questions shall remain independently addressable.
The canonical machine-context storage is `context.pendingBossQuestion` and `context.bossReply` for scalar suspension, or `context.pendingBossQuestions[stateId]` and `context.bossReplies[stateId]` for keyed suspension; a machine without a root parallel group uses the scalar form, and one declaring a root parallel group uses the keyed form throughout ([DR-079](079-topology-selects-question-storage.md)).
A private wrapper cannot replace these fields: the shared factory reads the scalar record directly, while branch-local invocation inputs select their keyed record into the same singular question/reply contract.
This placement clarification preserves the existing compiler/runtime boundary rather than adding a storage adapter or a new runtime strategy.

### 2. Boss reply event

While a question is pending, the runtime shall classify a Boss answer as `BOSS_REPLY` for one identified question and shall carry the Boss text verbatim as the answer.
The FSM shall reenter only the originating player state with the original prompt context plus explicit question and answer blocks, marked by the lines `? ⟶` and `Boss ⟶` with no other framing words [[1]] ([DR-090](090-every-role-hears-the-boss.md)).
An omitted question id is valid only when exactly one question is pending.
An empty answer, an unknown question id, or a reply for a state not registered as resumable shall not resume a player.
Where Source requires the reply retained, the generated FSM retains the exact canonical reply at the semantically accepted boundary before clearing the question and answer, without a Judge-extracted echo field ([DR-082](082-retain-input-owned-boss-replies.md)).

### 3. Abandonment and interruption

A fresh directive may leave the wait through an artifact-declared interrupt or entry path and shall clear every pending question owned by the exited scalar state or parallel group.
Every non-`needsBossReply` exit from a player state and every non-reply exit from a wait shall clear its pending reply context.
No timeout shall expire a Boss question because a human pause has no workflow deadline.
An effect-authorized question binds to one cumulative repository operation: only a checkpoint-identical authored continuation resumes it, and any other exit goes to unresolved reconciliation, while read-only question calls keep their `unchanged` predicate ([DR-040](040-outcome-authority-effect-reconciliation.md)).

### 4. Runtime and host boundary

The runtime shall treat a Boss-reply wait as quiescent, drain its ordered emissions, return control to the host, and expose each pending question in its structured result and telemetry.
On entering the wait, the runtime shall surface the full question as player-attributed Captain speech and a separate routing marker without truncating the question.
The next Boss turn shall reach the active leaf runtime, and only the selected pending branch or scalar state shall resume.

### 5. Player continuity

The resumed prompt shall always carry the explicit question and answer so behavior remains deterministic across adapters.
Every later player call of the run, whatever its role, also carries the run's exchanges so far under the same markers ([DR-090](090-every-role-hears-the-boss.md)).
Where the player result supplied a continuation token, the resumed call may additionally continue that backend conversation under [DR-010](010-playbook-session-tracing-and-resume.md), with the host resolving that continuation from the explicit session player under [DR-032](032-explicit-roles-session-players.md).

## Consequences

- A workflow can ask Boss a precise mid-step question without discarding its state or blocking the input loop.
- Parallel siblings need not restart when one branch waits for Boss.
- Explicit prompt context remains the portable source of truth, while backend continuation preserves additional conversation and tool context when available.

## References

[1]: https://stately.ai/docs/transitions#external-transitions "XState — external transitions and `reenter`"
