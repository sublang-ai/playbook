<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-040: Outcome authority and effect reconciliation

## Status

Accepted.
Refines the summary ownership of [DR-009](009-generic-playbook-cli-and-registry.md), transition evidence of [DR-010](010-playbook-session-tracing-and-resume.md), corrective retries of [DR-025](025-resilient-captain-control-adjudication.md) and [DR-028](028-empty-ok-result-re-ask.md), result grounding of [DR-029](029-session-scoped-conversational-captain.md), uncertain recovery of [DR-031](031-shared-captain-session-front-ends.md), failure retry of [DR-034](034-durable-failure-retry-continuity.md), and retained resumption of [DR-038](038-universal-run-resumption.md).
Refines the artifact compatibility rollout of [DR-022](022-runtime-compatibility-contract.md) without changing its shared-engine ABI rule.
Preserves [DR-020](020-spec-layout-agnostic-code-prompts.md): no repository layout or informal intent-progress notation becomes a generic effect fact.

## Context

- A player reply currently serves simultaneously as human presentation, semantic evidence for a hidden adjudicator, and proof of repository effects.
- CODE and DECIDE validate a commit by finding one exact `Commit:` line in that prose, while REVIEW trusts semantic `committed` or `rejectedAll` output without observing the repository.
- A transport may preserve the complete player messages yet join their text without a separator, so correct work and a correct semantic judgment can fail a prose parser after the commit already exists.
- The default status emits the guard claimed by an actor output before proving which guarded arm the FSM accepted, and Captain saved-count telemetry reparses the judge reply instead of consuming settled runtime evidence.
- Repository effects outlive missing, empty, malformed, aborted, or interrupted result transport, but the current empty-`ok`, failure-state, uncertain-turn, and retained-generation recovery paths may replay the effectful player.
- A per-session writer lease protects one durable session record but neither serializes effectful calls from different sessions in the same worktree nor excludes nonparticipating writers.
- XState snapshot inspection proves the resulting public state but does not expose a stable public identifier for the selected guarded arm.

## Decision

### 1. Four authority planes stay separate

| Plane | Owns | Does not establish |
| --- | --- | --- |
| Presentation | The player's exact optional `finalText` and other human-facing prose | A transition, repository effect, or commit identity |
| Semantic | One schema-valid declared outcome and its semantic fields, including CODE's direct-versus-intent and remaining-task judgments | Commit existence, ancestry, count, or OID |
| Effect | A host-observed repository receipt | The meaning of player prose, intent progress, or another semantic workflow choice |
| Runtime | Reconciliation of the semantic candidate with effect evidence, the transition the FSM accepts, and the canonical settlement or terminal result | New facts inferred from presentation text |

`finalText` shall remain opaque to FSM guards and effect validation; the hidden adjudicator may read it as semantic evidence, and presentation may relay it, but neither path may parse it for a repository fact.
Every delegated-player outcome field in CODE, REVIEW, and DECIDE governed by this decision shall declare exactly one authority in versioned artifact metadata, and runtime reconciliation shall reject a missing required, extra, wrongly owned, or mutually inconsistent field before FSM delivery.
`latestCommit` and the qualifying commit delta are effect-owned.
`irNumber`, `irTask`, and `moreTasks` versus `finalTask` remain semantic and shall not be inferred from an informal task-completion marker.

### 2. Repository effects use durable observations and cooperative coordination

An effectful artifact shall receive its repository capability through typed artifact options rather than widening the semver-stable `PlaybookPorts` surface.
Before an effectful player call, the host shall append a durably started boundary to an ordered per-turn effect ledger with the call identity, source outcome schema, canonical Git worktree identity, and detached baseline observation; after every resolution, rejection, abort, or recovery from interruption, it shall complete or reconstruct that boundary's receipt before authorizing another player call.
The observer shall classify at least unchanged HEAD and relevant worktree, one descendant commit, multiple commits, rewritten or non-descendant HEAD, worktree-only change, detected concurrent or foreign change, and observation ambiguity.
Where reliable attribution requires coordination among Playbook writers, the host shall acquire a cooperative lease keyed by canonical Git worktree identity before the baseline observation and hold it through durable receipt capture.
Callers participating under the same canonical-worktree key shall serialize, while callers under different canonical-worktree keys shall not block one another.
The lease does not prove the absence of writes by a human or another nonparticipating process; independently detected concurrent or foreign evidence and otherwise ambiguous observations shall fail closed.

### 3. Semantic adjudication is exact and bounded

The hidden adjudicator shall return exactly one declared semantic outcome in its closed schema, with every required semantic field and no undeclared field.
A first structurally invalid adjudication reply shall make one corrective hidden judge call eligible with the schema and validation error restated over the same retained evidence.
The runtime shall durably spend that correction budget before crossing the call boundary and shall start the call only while the applicable abort signal remains live.
A second structurally invalid reply, a spent or indeterminate correction budget, or abort before the corrective call begins shall fail closed.
A judge transport failure or non-`ok` result shall not trigger another corrective call, and a player abort, error, non-`ok` result, or missing `finalText` shall trigger no adjudication.
This extends [DR-025](025-resilient-captain-control-adjudication.md)'s bounded structural correction to delegated-player adjudication without turning transport recovery into another player call.

### 4. A possible effect permanently closes the player-call gate

The host and runtime shall preserve every unresolved boundary in the ordered per-turn ledger as a reconciliation envelope containing the baseline and after evidence available so far, the optional opaque `finalText`, source state and outcome schema, any semantic candidate, and the adjudication correction budget.
A durably started boundary lacking a complete zero-delta receipt shall be effect-possible even when no after observation was persisted, and host recovery shall construct or restore its envelope before restoring the source state.
Where any envelope proves a relevant change or cannot exclude one, the runtime shall enter an explicit effect-possible, outcome-unresolved state and shall never invoke that effectful player again for the attempt.
That state shall advertise only an explicit reconciliation retry and a Boss abandonment action; reconciliation may retry repository observation and hidden semantic adjudication over retained evidence, while abandonment shall terminate the attempt with an unresolved-effect result without restoring source state, replaying a player, or claiming completion.
When retained semantic and effect evidence establish a complete consistent outcome, reconciliation may deliver it once to the FSM; otherwise the state shall remain parked as effect-possible and outcome-unresolved until the Boss abandons it.

[DR-028](028-empty-ok-result-re-ask.md) and [[playbook-runtime-9](../packages/playbook-runtime.md#playbook-runtime-9)] retain their one identical player re-ask only for a non-effectful call or an effectful call whose durable receipt proves zero relevant delta; an observed or ambiguous effect takes the reconciliation path instead.
[DR-034](034-durable-failure-retry-continuity.md)'s entry-event retry shall not be advertised from the unresolved state, whose only retry is reconciliation.
[DR-031](031-shared-captain-session-front-ends.md)'s uncertain-turn recovery shall reconcile every durably started effect boundary since the snapshot that whole-turn retry would restore and shall permit replay only when every boundary has a complete receipt proving zero relevant delta; any observed, ambiguous, or incomplete boundary shall enter parked reconciliation.
[DR-038](038-universal-run-resumption.md)'s retained generation shall preserve and reenter an unresolved reconciliation state, resolve every outstanding effect boundary before adoption, and prevent a retained pre-effect generation from bypassing the ledger rather than using its duplicate-effect warning as permission to replay the player.

### 5. Workflow commit outcomes reconcile semantics with effects

For the maintained CODE and DECIDE artifacts, a commit outcome shall require exactly one descendant commit with no unexplained relevant worktree change and shall take `latestCommit` only from the observed OID.
For the maintained REVIEW artifact, `committed` shall require that same one-descendant predicate, while `rejectedAll` shall require both HEAD and the relevant worktree observation to be unchanged.
Zero effect for a claimed commit, an effect for a claimed no-commit outcome, multiple commits, rewritten or non-descendant history, concurrent or foreign changes, and ambiguous evidence shall not select either claimed outcome.
The semantic plane continues to decide CODE's direct-versus-intent and remaining-task meaning; repository evidence corroborates only the declared effect predicate.

### 6. Canonical runtime evidence grounds status, metrics, and Captain control

Each CODE, REVIEW, and DECIDE adjudicated outcome arm governed by this decision shall carry stable linker- or artifact-authored acceptance instrumentation naming its declared outcome independently of the internal guard-function name.
Only instrumentation executed by the selected arm and confirmed by the corresponding public root-machine snapshot shall produce an accepted-outcome receipt `{ source, target, acceptedOutcome }`; ordinary non-outcome state changes need no such receipt.
The runtime shall implement that contract through public XState surfaces or explicit artifact instrumentation, not underscore-prefixed inspection members.
It shall publish and drain accepted-outcome evidence before the public boundary settles, derive default `→ <outcome>` status from it, and emit neither an accepted-outcome receipt nor claimed-outcome status when stricter validation selects a fallback with no governed outcome.
Captain saved-count metrics shall consume accepted outcomes rather than raw judge JSON.
Session-Captain control shall consume canonical structured settlement and terminal-result facts; an aggregate transcript may remain conversation or presentation context but shall not establish an action result.

### 7. Compatibility and release ordering are explicit

The shared engine, registries, and CLI artifact validators shall add artifact schema `3` alongside schema `2`, and the engine shall retain runtime ABI `1`, because the authority metadata and artifact-specific options are schema-gated additions that neither widen `PlaybookPorts` nor change the schema-2 factory contract.
Schema `2` shall retain legacy behavior during implementation, while schema `3` shall require exact authority metadata for every governed delegated-player outcome and an explicit empty governed set for an artifact with none.
No shipped artifact shall declare schema `3` before satisfying that contract, and every artifact shall migrate atomically with its governed behavior before the candidate gate removes schema `2` from the supported set.
Removing schema `2` shall be the breaking next-major cutover under [DR-022](022-runtime-compatibility-contract.md).
Runtime snapshots, trace events, and complete shell snapshots shall advance from schema `3` to schema `4`; the Captain session record shall advance to schema `5` because record schema `4` already names the compatible historical retained-generation shape.
Older persisted artifacts, snapshots, retained generations, and session records shall be migrated only by an explicit validator that can preserve every authority fact; otherwise they shall reject before effectful work rather than fabricate evidence.
Trace schema `4` shall distinguish the accepted-outcome event contract for consumers, which shall not treat an earlier trace event as authority-bearing evidence.
Consumption and packed acceptance of the upstream message-boundary repair require a published Cligent release, and the Playbook release shall remain gated on that artifact under [[release-14](../packages/release.md#release-14)].
The authority model, observer, reconciliation, workflow migration, and canonical reporting may proceed independently while that external release is unavailable.

## Consequences

- Equivalent semantic answers select the same outcome regardless of `Commit:` formatting, while repository facts come from Git rather than prose.
- A real or possible repository effect can park for explicit reconciliation, but no automatic, failure-state, uncertain-turn, or retained-generation path repeats its player call or bypasses an earlier boundary in the same turn.
- Missing semantic evidence may leave work explicitly unresolved instead of claiming success or automatically completing from repository layout conventions.
- Cooperative leasing reduces collisions among Playbook hosts, while foreign writes remain outside its guarantee and fail closed when detected or when they make observation ambiguous.
- Status, summary counts, and Captain control agree with the outcome the machine accepted.
- The durable envelope expands persisted sensitive data and requires the same user-only protection as the containing Captain session record.
- Artifact support, trace events, runtime snapshots, shell snapshots, and durable records change together in a next-major cutover while the shared-engine ABI remains `1`.
