<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-067: Parallel Proposals Through the Shared Factory

## Status

Accepted (2026-09-24).
Amends [DR-019](019-shared-linked-runtime-factory.md) §1 and §4: the shared factory's domain gains the one parallel shape [gears2fsm](../../slc/gears2fsm.md) compiles, and DECIDE joins the factory-backed artifacts, so no maintained artifact keeps its own machinery.
Amends [DR-011](011-composable-playbook-execution.md) §1 in one respect: the runtime that interprets the parallel proposal pair is the shared engine, not a linked runtime of its own.
Everything else of both records stands.
Recovery is refined by [DR-073](073-durable-step-progress.md): parallel regions record work without a single-invocation retry, while sequential steps after the join use saved-step recovery.
Compiler question-storage selection clarified by [DR-079](079-topology-selects-question-storage.md).

## Context

- DECIDE's linked runtime is a hand-maintained 5,287-line module.
  Read against the shared engine, about 80% of it restates engine code — construction, emission and trace plumbing, session binding, the effect-ledger projection, the reconciler, deferred continuation, the control surface, snapshot export and restore, `handleBossInput`, `resumePlaybookCall`, `dispose` — and about 14% (some 750 lines) is what a parallel proposal pair needs and the engine lacks: one repository claim for both proposals, several pending Boss questions at once, statuses for two newly entered role states, and cancellation of a sibling call.
- The restated parts have drifted from the engine and from the specs the engine follows.
  DECIDE binds a deferred continuation to the player's resume token and resumes from it after the session store changed, where [[playbook-runtime-69](../packages/playbook-runtime.md#playbook-runtime-69)] requires the token-free `{v:1,playerId}` descriptor; it parks an `unchanged` boundary whose semantics fail behind reconcile and abandon actions, where [[playbook-runtime-77](../packages/playbook-runtime.md#playbook-runtime-77)] routes it to the ordinary failure state; it rejects a turn whose governed judge call fails, where the engine settles the turn as failed with a retry; and it rewinds a failed deferred continuation to a checkpointed actor, where the engine closes the runtime until recovery.
  Each drift is pinned by a DECIDE test as if it were the contract.
- Recompiling DECIDE through `slc playbook` cannot regenerate such a module: the linker's one recorded attempt produced 5,800 lines with a composer that threw on the first turn, after a three-hour call.
  Every other maintained artifact links as a thin module the materializer emits in seconds, and an engine fix reaches it by release rather than by re-linking.
- DR-019 §4 anticipated this: "Converging DECIDE onto the shared factory requires a future parallel profile."
  The FSM shape is already fixed: [gears2fsm](../../slc/gears2fsm.md) compiles a parallel group as one root `type: 'parallel'` state whose regions each hold one player-invoking working leaf, one branch-local Boss-reply wait leaf, and one local final leaf, with keyed pending questions and the parent as the one interrupt target.

## Decision

### 1. The shared factory interprets the compiled parallel shape

- `createXStatePlaybookRuntime(machine, spec)` accepts a machine whose root states are flat except for root states of `type: 'parallel'` in the compiled shape: each region a compound state with exactly one working leaf that invokes the typed `player` actor and carries `playbook.busy`, exactly one wait leaf tagged `playbook.parked` whose `BOSS_REPLY` arms target that working leaf, and exactly one `type: 'final'` leaf, every leaf carrying a stable `meta.playbook.stateId` distinct from every other state's, and the parent's `onDone` the join.
  The factory derives the regions, their leaves, and the cohort of working leaves from the machine and the FSM's exported `concurrentRoleSets`; the linker declares nothing new.
  Any other compound state is rejected as before.
- Pending Boss questions are a set: the keyed `context.pendingBossQuestions` and `context.bossReplies` of gears2fsm's Boss-reply suspension, a question pending only while its own wait leaf is active.
  For a machine that declares a parallel state, telemetry, the exported snapshot, and the control view carry the plural `pendingBossQuestions`; the classifier is offered every pending question and requires `questionId` when more than one is pending; statuses are emitted for each newly entered Boss-relevant state, and a status trace names a `stateId` only when exactly one Boss-relevant state is active.
  A flat machine's observable output is unchanged.
- The working leaves of one parallel state entered in one macrostep run as one declared all-`unchanged` cohort through the host's `runCohort` transaction of [[playbook-runtime-73](../packages/playbook-runtime.md#playbook-runtime-73)], at most once per turn: each member's result is adjudicated through the one reconciler of [[playbook-runtime-77](../packages/playbook-runtime.md#playbook-runtime-77)] in serial, a spent correction replaces every member's boundary in one acknowledged batch because the ledger's cohort invariant of [[playbook-runtime-69](../packages/playbook-runtime.md#playbook-runtime-69)] admits no half-complete cohort, members are acknowledged and their results released in completion order so the accepted-outcome marker names the target the machine actually reached, a member's failure cancels its siblings, and the cohort's failure carries the cause decided first, a runtime-issued cancellation deciding no cause of its own ([[playbook-55](../packages/playbook.md#playbook-55)]).
  An empty-`ok` corrective re-ask and a single region resuming after its Boss reply run exclusively, as every flat call does.
- Aborts are classified per call, so a trace sink rejecting with a sibling's cancellation is forgiven for that call alone; actor settlements queue rather than occupy one slot; and a turn's drain waits for every call it started, including a cancelled sibling whose port ignores its signal.

### 2. Where the bespoke runtime deviated, the engine's semantics apply

- A deferred `needsBossReply` on the merge call binds the token-free `{v:1,playerId}` continuation, publishes the continuation inline, and closes the runtime on an indeterminate settlement, as [[playbook-runtime-69](../packages/playbook-runtime.md#playbook-runtime-69)] and [[playbook-runtime-73](../packages/playbook-runtime.md#playbook-runtime-73)] require of every artifact.
- An `unchanged` boundary whose semantic reply is unacceptable takes the ordinary failure path with only the saved-step controls the engine can support; a governed judge outage settles the turn as failed rather than rejecting it.
- Retained-snapshot adoption ([DR-038](038-universal-run-resumption.md)) stays in the flat domain: the factory omits `adopt` for a machine that declares a parallel state, and member absence remains the capability boundary of [[playbook-runtime-61](../packages/playbook-runtime.md#playbook-runtime-61)].
- The DECIDE conformance suites pin the parallel contract — blind concurrent proposals and their join, branch-local waits with several pending questions, the interrupt restart, completion-order markers, sibling cancellation and the first-decided cause, the nested REVIEW handoff, the pre-existing-changes block — and are rebaselined to the engine's wording and to the semantics above where they pinned the drift.

### 3. Every maintained artifact links as a thin module

- [link](../../slc/link.md) emits the thin shared-factory module for a parallel FSM of the compiled shape exactly as for a flat one; bespoke linked machinery is no longer the prescribed output for any FSM gears2fsm produces.
  The `bespoke` registry profile remains a valid declaration for an artifact outside this package, so hosts keep accepting it.
- The maintained DECIDE artifact becomes a thin module of the review-module kind — its FSM import, options snapshot, `roleStates`, `outcomeAuthority`, the quoted-relay prompt composer, and the factory call — and its registry declares the `shared-factory` profile.

## Consequences

- One engine interprets every maintained workflow, so a governed-boundary, continuation, failure-cause, or snapshot fix ships once and reaches DECIDE by release; the 5,000 lines that duplicated it are deleted rather than maintained.
- Recompiling DECIDE through `slc playbook` is the same deterministic link step as for CODE, REVIEW, DEV, BRANCH, and PR, which is what lets the maintained set be regenerated from its sources.
- The parallel contract is verified twice: by the engine's own suites over a synthetic parallel machine and by the maintained DECIDE suites over the real artifact.
- The DECIDE runtime loses four behaviors that contradicted the specs it was held to; nothing the sources or the package specs promise is lost.
