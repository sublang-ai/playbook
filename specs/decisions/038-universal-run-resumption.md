<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-038: Universal Run Resumption from Retained Snapshots

## Status

Accepted.

## Context

Playbook authors describe only the normal procedure; GEARS sources carry no interruption states, and universal concerns are synthesized below the authored text rather than written per playbook — Boss-question suspension reaches every captain-invoking state that way per [DR-005](005-boss-reply-suspension-path.md), and a parked failure already retries from the persisted machine snapshot per [DR-034](034-durable-failure-retry-continuity.md).
Every quiescent state is durably persisted and provably re-enterable: restore depends on it per [DR-010](010-playbook-session-tracing-and-resume.md) and [DR-031](031-shared-captain-session-front-ends.md).
Resumption nevertheless exists only while an engagement lives: when a root completes on a reported failure, is dismissed, or a structural player change forces a fresh session per [DR-032](032-explicit-roles-session-players.md), the final runtime snapshot is dropped with its frame, and re-entry must pass through the procedure's initial state.
An initial state's outcome vocabulary describes only the normal first phase (CODE: a direct commit or a new intent record), so a continuation input has no truthful classification: adjudication must stretch an outcome over the continuation report, re-entry into mid-procedure loops varies with the acting model's report style, and each interruption costs one Boss turn per remaining unit of work plus hand-written recovery instructions.
Half-settled work compounds this: an interruption between a commit and its review settlement leaves re-review dependent on the Boss remembering to ask for it.
Final states cannot host this recovery: terminal actors export no snapshot, a final state has no continuation edge, and a terminal result's authored meaning per [DR-037](037-terminal-result-meaning.md) is Boss-facing prose, not a machine discriminator.

## Decision

Resumption is a machine property synthesized below GEARS; authored sources continue to describe only the normal procedure, and no per-playbook resume outcome is added.

1. **Adoption is an optional public runtime capability.**
   Like the optional control-surface pair, a runtime may implement snapshot adoption — constructing a fresh runtime from a retained snapshot under a new engagement — and the shared linked-runtime factory implements it for every artifact it hosts.
   A runtime without the capability retains nothing and advertises nothing, and the shell degrades exactly as it does for a capability-less control surface; DECIDE's bespoke runtime remains without it.

2. **Retention captures the last unfinished pre-terminal generation, atomically with its nested stack.**
   At each settlement — abort settlement included per [DR-036](036-coherent-abort-settlement.md) — the Captain session record retains, per enabled root playbook id, the latest quiescent generation that carries unfinished work: the root frame's snapshot together with every nested descendant frame's snapshot and the call bridges between them, as one indivisible generation.
   Final-state snapshots are never retained; a root that completes terminally retains the generation captured before completion when its final state is artifact-declared unfinished, and clears retention otherwise.
   A capability-less root clears its retained generation.
   When a capability-bearing root's stack contains a capability-less descendant, Captain retains the last complete generation captured before that descendant opened; when the turn began with that descendant already live or the root began during the turn, Captain emits no update; and Captain never retains the partial stack.
   When a root starts and reaches a declared unfinished terminal in the same turn, before any work-bearing generation can settle, the Captain settles without a retention update for that root rather than retain the initialized state or clear unfinished retention.
   An existing root whose turn-start stack is fully capability-bearing but whose previous generation cannot be captured safely still leaves a boundary that requires that previous candidate unsettled.
   The linked artifact declares its unfinished final-state ids as link-time metadata beside the resumable-state registry — mechanical metadata, not procedure text.
   A later settlement of the same root playbook replaces the generation in place; clean completion clears it.

3. **A retained generation may cross sessions under an exact structural envelope and single-transfer ownership.**
   A fresh session's launch may adopt the retained generation from its predecessor: the newest settled session record with the same working directory, read under the store's lease discipline; adoption moves the generation into the adopting record and clears it at the source in the same guarded exchange, so no generation is adopted twice.
   Adoption validates an exact envelope: working directory, root playbook id and its complete catalog-entry structure — registry module identity, manifest command, options, and role set — and the artifact schema of every frame in the generation.
   A referenced player's own structural members may differ; such a role resumes with a fresh conversation, while model and effort retune exactly as ordinary continuation allows.

4. **The Captain-session player ledger is the sole conversation authority.**
   Adoption never restores the retained snapshots' role-token projections: a shared player may have advanced through another playbook after capture, so the adopting runtime binds each role from the current ledger, and a role the ledger cannot supply starts a fresh conversation and re-grounds from the procedure's externalized effects.

5. **Adoption starts a new trace lineage.**
   An adopted generation runs under fresh runtime session UUIDs and fresh counters, and the adoption boundary is traced with the source session and generation identity, so no trace begins mid-sequence and causal lineage stays explicit.

6. **The shell advertises resumption and the Captain selects it as one validated action.**
   A retained generation is advertised beside runtime-advertised actions, labeled by the retained root state's published description per [DR-035](035-truthful-terminal-meaning.md); the Captain's closed action set per [DR-029](029-session-scoped-conversational-captain.md) gains a distinct resume selection validated like a start.
   Arbitration is fixed: headless uncertain retry precedes all host work; a live engagement's advertised actions precede adoption; adoption precedes fresh start; explicit Boss intent overrides, and a bare continuation request for a playbook with a retained generation selects resumption.
   An adopted state advances through its class's existing affordances — a Boss question awaits its answer, a failure advertises retry per [DR-034](034-durable-failure-retry-continuity.md), a suspended parent continues through its restored child — with no initial-state classification anywhere.

7. **Durable facts belong to the world, not to conversations.**
   A procedure whose effects are externalized (commits, records, files) resumes losslessly; this is the stated authoring principle rather than a per-procedure corner case.

## Consequences

- Author burden is unchanged; interruption recovery becomes uniform across playbooks, front ends, and sessions, and no longer depends on outcome classification or the acting model's report style.
- A resumed run re-enters mid-procedure states directly, so an interrupted review re-runs from its own state and half-settled work needs no Boss-side instructions.
- The session record grows by at most one retained generation per enabled root playbook id, bounded and replaced in place; nested descendants ride inside their root's generation and cannot dangle.
- A root that reaches an unfinished terminal before it has a work-bearing generation still settles and preserves its terminal meaning; the absent retention update leaves any earlier generation untouched.
- A capability-less descendant can prevent the current stack from becoming a retained generation but neither erases an earlier complete generation nor blocks ordinary same-session snapshot continuation.
- Runtimes without the adoption capability keep today's behavior; universality is the mechanism and its gating, not a claim about bespoke runtimes.
- Cross-adapter resumption cannot restore a player's conversation; fidelity rests on externalized effects, per the stated authoring principle.
- A retained generation can be stale against a world that moved on; the resumed state's own first act observes the world, so staleness surfaces through normal review and failure paths rather than silently.
- Like uncertain retry, resumption may duplicate external effects attempted in the interrupted span, and the shell's warnings say so; the runtime's at-most-once apply semantics are unchanged.
- Extends [DR-034](034-durable-failure-retry-continuity.md) from the failure state to every retained pre-terminal generation; supersedes nothing.
