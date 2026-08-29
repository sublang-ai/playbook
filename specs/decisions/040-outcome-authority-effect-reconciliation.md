<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-040: Outcome authority and effect reconciliation

## Status

Accepted.
Refines the registry construction and summary ownership of [DR-009](009-generic-playbook-cli-and-registry.md), transition evidence of [DR-010](010-playbook-session-tracing-and-resume.md), corrective retries of [DR-025](025-resilient-captain-control-adjudication.md) and [DR-028](028-empty-ok-result-re-ask.md), result grounding of [DR-029](029-session-scoped-conversational-captain.md), uncertain recovery of [DR-031](031-shared-captain-session-front-ends.md), failure retry of [DR-034](034-durable-failure-retry-continuity.md), and retained resumption of [DR-038](038-universal-run-resumption.md).
Refines [DR-005](005-boss-reply-suspension-path.md)'s Boss-reply path for an effect-authorized call by binding the question and its continuation to one cumulative repository operation.
Refines [DR-011](011-composable-playbook-execution.md)'s same-worktree call coordination while preserving its concurrent blind proposal pair.
Refines the artifact compatibility rollout of [DR-022](022-runtime-compatibility-contract.md) without changing its shared-engine ABI rule.
Preserves [DR-020](020-spec-layout-agnostic-code-prompts.md): no repository layout or informal intent-progress notation becomes a generic effect fact.
Preserves [DR-035](035-truthful-terminal-meaning.md) and [DR-037](037-terminal-result-meaning.md): unresolved-effect abandonment is not an FSM terminal outcome and publishes no invented final-state meaning.

## Context

- A player reply currently serves simultaneously as human presentation, semantic evidence for a hidden adjudicator, and proof of repository effects.
- CODE and DECIDE validate a commit by finding one exact `Commit:` line in that prose, while REVIEW trusts semantic `committed` or `rejectedAll` output without observing the repository.
- A transport may preserve the complete player messages yet join their text without a separator, so correct work and a correct semantic judgment can fail a prose parser after the commit already exists.
- The default status emits the guard claimed by an actor output before proving which guarded arm the FSM accepted, and Captain saved-count telemetry reparses the judge reply instead of consuming settled runtime evidence.
- Repository effects outlive missing, empty, malformed, aborted, or interrupted result transport, but the current empty-`ok`, failure-state, uncertain-turn, and retained-generation recovery paths may replay the effectful player.
- An effect-authorized player may legitimately ask Boss after creating an uncommitted worktree delta, while Reviewer and proposal calls explicitly forbid file changes and become stale or unattributable when their observation changes.
- Effect-authorized calls have no enforceable predeclared path scope, so a player's residual edit and the same concurrent foreign edit are observationally indistinguishable after the call.
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
Every outcome arm of each governed delegated-player call shall also declare exactly one repository disposition in schema-3 artifact metadata: `unchanged`, `one-descendant-commit`, or `deferred`.
`unchanged` and `one-descendant-commit` are exact effect predicates, while `deferred` makes no final repository claim and shall be valid only for a `needsBossReply` arm of a call whose other declared arm permits `one-descendant-commit`.
A call shall be effect-authorized when any declared arm permits `one-descendant-commit`; `deferred`, a role name, prompt instruction, player prose, or semantic reply shall never weaken or establish that classification.
The CODE Coder calls, REVIEW Coder reconciliation call, and DECIDE merge call shall be effect-authorized; their commit arms shall declare `one-descendant-commit`, REVIEW's `rejectedAll` shall declare `unchanged`, and their `needsBossReply` arms shall declare `deferred`.
The REVIEW Reviewer calls and DECIDE's concurrent Coder and Reviewer proposal calls, including their `needsBossReply` arms, shall declare only `unchanged`.

### 2. Repository effects use durable observations and cooperative coordination

The schema-3 registry construction boundary shall keep two inputs disjoint: configured options are the registry-validated plain-JSON workflow slice governed by [[playbook-runtime-29](../packages/playbook-runtime.md#playbook-runtime-29)], while host construction capabilities are current-host repository observation, coordination, atomic write-ahead, and canonical-worktree operations.
The registry shall compose the artifact's typed factory options from those inputs only at runtime construction rather than widen the semver-stable `PlaybookPorts` surface; configuration shall never supply a capability member, and no live callback, lease, or store handle shall enter FSM input or context, a runtime or shell snapshot, a launch projection, or continuation equality.
Fresh, restored, and adopted schema-3 runtimes shall each receive capabilities rebuilt by the current lease-owning host only after stored configured-option and working-directory compatibility succeeds, and an absent or mismatched capability authority shall reject before governed work.
The current host, not `PlaybookRuntime.exportSnapshot`, shall own the ledger's atomic write-ahead channel; a Captain front end shall extend [DR-031](031-shared-captain-session-front-ends.md)'s leased uncertain record with it, while another schema-3 host shall supply equivalent operations through its construction-capability input or reject before governed work.
Before each governed call, the host shall append a durably started boundary to an ordered per-turn effect ledger with the call identity, declared outcome dispositions, source outcome schema, canonical Git worktree identity, and detached baseline observation; after every resolution, rejection, abort, or recovery from interruption, it shall complete or reconstruct that boundary's receipt before releasing its coordination claim.
One durable logical-operation identity shall link every physical boundary in a deferred question chain across successive turn ledgers until final reconciliation or abandonment, and ordinary turn settlement shall not retire its original baseline.
A repository-relevant worktree projection shall be a detached path-keyed, content-addressed view of Git-visible deviations from that observation's own HEAD: index entries that differ from the HEAD tree, tracked worktree content or modes that differ from the index, and non-ignored untracked paths under Git's resolved excludes; ignored-only untracked paths, Git administrative data, and timestamps shall not enter it.
A receipt shall prove `unchanged` only when after-HEAD equals baseline HEAD and the after projection equals the baseline projection, so byte- and mode-identical pre-existing dirt remains zero delta while any introduced staged, tracked, or non-ignored-untracked overlay does not.
A receipt shall prove `one-descendant-commit` only when after-HEAD is exactly one commit descended from baseline HEAD and the after projection equals the baseline projection; an altered pre-existing overlay, residual worktree change, or overlap that cannot be attributed uniquely shall be observation ambiguity.
The observer shall otherwise classify multiple commits, rewritten or non-descendant HEAD, worktree-only change, detected concurrent or foreign change, and observation ambiguity without treating an ignored-only output as repository evidence.
Every governed call shall acquire an exclusive cooperative claim keyed by canonical Git worktree identity before its baseline and hold it through durable receipt capture.
Only calls in one invocation of an artifact-declared concurrent group whose role set appears in `concurrentRoleSets` and whose roles all declare exclusively `unchanged` may instead share a cohort-scoped claim; the host shall durably start every boundary from one common baseline before starting any cohort call, complete every receipt from an after observation taken only after all cohort calls resolve, and admit no same-worktree call outside that cohort until every boundary completes.
Separate runtime invocations or sessions shall be separate cohorts, and a common after observation that does not prove `unchanged` shall make every cohort receipt ambiguous.
Callers participating under different canonical-worktree keys shall not block one another.
The lease does not prove the absence of writes by a human or another nonparticipating process; independently detected concurrent or foreign evidence and otherwise ambiguous observations shall fail closed.

### 3. Semantic adjudication is exact and bounded

The hidden adjudicator shall return exactly one declared semantic outcome in its closed schema, with every required semantic field and no undeclared field.
A first structurally invalid adjudication reply shall make one corrective hidden judge call eligible with the schema and validation error restated over the same retained evidence.
Before crossing the corrective judge boundary, the runtime shall await the host channel's idempotent durable spend of that boundary's correction budget; a failed or indeterminate spend shall start no judge call, and a successful spend shall permit the call only while the applicable abort signal remains live.
A second structurally invalid reply, a previously spent correction budget, or abort before the corrective call begins shall fail closed.
A judge transport failure or non-`ok` result shall not trigger another corrective call, and a player abort, error, non-`ok` result, or missing `finalText` shall trigger no adjudication.
This extends [DR-025](025-resilient-captain-control-adjudication.md)'s bounded structural correction to delegated-player adjudication without turning transport recovery into another player call.

### 4. A possible effect closes replay, with bound continuations

The host and runtime shall preserve every unresolved or deferred boundary in the ordered per-turn ledger as a reconciliation envelope containing the baseline and after evidence available so far, the optional opaque `finalText`, source state and outcome schema, any semantic candidate, the adjudication correction budget, any open logical-operation checkpoint, and its current checkpoint-restoration eligibility.
A durably started boundary lacking a complete `unchanged` receipt shall be effect-possible even when no after observation was persisted, and host recovery shall construct or restore its envelope before restoring the source state.
A schema-valid `deferred` candidate shall enter the authored Boss-reply wait instead of resolving an effect predicate only when its complete after observation keeps HEAD at the operation baseline and shows neither a rewritten or multiple-commit history nor detected foreign overlap or observation ambiguity; its repository-relevant worktree projection may differ.
Before releasing the exclusive claim and publishing that question, the host shall durably bind the pending question, player continuation, original operation baseline, and complete after observation as one open logical operation.
On each valid Boss answer, the host shall reacquire the exclusive same-worktree claim and start exactly one authored question-and-answer continuation only after the current HEAD and projection equal the latest saved after observation; no other later player-call path is permitted, and a mismatch shall start no player and enter unresolved reconciliation.
Repeated validated questions shall update the saved checkpoint without changing the original baseline, and the eventual `unchanged` or `one-descendant-commit` predicate shall reconcile the cumulative operation from that original baseline.
Every physical boundary in that chain shall retain its own baseline and after receipt for checkpoint and replay safety, while a separate logical-operation receipt computed from the original operation baseline and final after observation shall alone reconcile the eventual semantic arm.
An empty, malformed, mismatched-question, or otherwise invalid Boss answer shall start no player and leave the checkpoint-bound wait unchanged; a fresh directive or any other exit from that wait shall enter unresolved reconciliation rather than ordinary failure, retry, or bypass.
The question-and-answer call is an authored continuation, not an automatic retry or replay.
For an envelope neither eligible for that bound continuation nor carrying a complete consistent final disposition, where any evidence proves a nonzero repository delta or cannot exclude one, the runtime shall enter an explicit effect-possible, outcome-unresolved state, shall invoke no player while that state remains active, and shall never replay that boundary's player call.
That state shall advertise only an explicit reconciliation retry and a Boss abandonment action; reconciliation may retry repository observation and hidden semantic adjudication over retained evidence but shall itself start no player.
When that state was entered solely because a valid Boss answer encountered a checkpoint mismatch for a still-open deferred logical operation, the host shall durably mark the unresolved episode as checkpoint-restoration-eligible, preserve the bound pending question, stable question and logical-operation identities, player continuation, original baseline, and latest checkpoint, and shall neither bind nor reuse that Boss answer as continuation input.
Every other entrance to unresolved reconciliation shall record that eligibility absent.
On an explicit reconciliation retry carrying that eligibility, the host shall reacquire the exclusive same-worktree claim and compare current HEAD and projection with the latest saved after observation.
If both are exact, the host shall consume that eligibility by durably restoring the same checkpoint-bound authored wait before republishing the same pending question, shall start no player or adjudicator and redeliver no semantic candidate, and shall require a later valid Boss answer to authorize the one bound authored continuation; if either differs, the state shall remain unresolved with its eligibility intact and start no call.
Explicit abandonment shall return the distinct public run result `{ outcome: 'unresolved-effect', state }`, which shall carry neither `stateDescription` nor `output`, reach no FSM final state, and claim no workflow outcome or completion.
The host-owned `PlaybookCaptainSettlement` shall carry a required `unresolvedEffects` list in ledger order whose entries contain exactly `{ classification, baselineHead, afterHead?, commitOid? }`; `classification` shall be `one-descendant-commit`, `multiple-commits`, `rewritten-or-non-descendant`, `worktree-only-change`, `concurrent-or-foreign-change`, `observation-ambiguous`, or `incomplete`.
Every entry shall carry `baselineHead`, shall carry `afterHead` exactly when a complete after-HEAD was observed, and shall carry `commitOid` if and only if its classification is `one-descendant-commit`, in which case both OIDs shall be equal.
The list shall project each currently outstanding effect-possible, outcome-unresolved envelope in ledger order, exclude every reconciled or finalized boundary, and represent an open deferred chain once from its current logical-operation evidence rather than repeat its internal physical receipts.
The list shall be nonempty exactly when the settlement leaves at least one such episode parked or records unresolved-effect abandonment, and shall be empty otherwise; abandonment shall freeze the same final projection before disposal.
That bounded settlement evidence shall omit repository paths and projection contents, raw ledger, call, or session identities, player prose, semantic candidates, and correction budgets, and shall not be copied into the runtime-owned `PlaybookRunResult`.
A successfully persisted and disposed abandonment shall return controller `status: 'ok'` with control receipt `disposition: 'executed'`; disposal or persistence failure shall remain `failed`, no fourth controller status shall exist, and `unresolvedEffects` alone shall describe the workflow's effect disposition.
The Captain shall durably mark abandonment started, dispose the complete engagement stack without restoring source state, replaying a player, translating the result into a nested `PlaybookCallResult`, or resuming a parent FSM, and atomically record the canonical unresolved settlement with the existing per-root `clear` retention update before Boss presentation.
That `clear` shall apply to the complete root even when the unresolved boundary belonged to a nested leaf, and recovery of a started abandonment shall complete the settlement and clear before any prior retained generation can be advertised or adopted.
For every controller settlement with a nonempty `unresolvedEffects` list, the Captain's deterministic result-phase Boss reply shall report that evidence in the same turn and before any later recovery action, distinguish a proved nonzero repository delta from a possible effect that could not be excluded, report the exact baseline and available after HEAD plus a proven commit OID when present, and claim neither workflow completion nor semantic ownership of the commit.
When retained semantic and effect evidence establish a complete consistent final disposition for the reconciled envelope, reconciliation may deliver it once to the FSM.
Every reconciled envelope taking neither that final-disposition exit nor the exact wait-restoration exit shall remain parked as effect-possible and outcome-unresolved until the Boss abandons it.

For a player call governed by this decision, [DR-028](028-empty-ok-result-re-ask.md) and [[playbook-runtime-9](../packages/playbook-runtime.md#playbook-runtime-9)] retain their one identical player re-ask only when the call's complete durable receipt proves `unchanged`; an observed, nonzero, incomplete, or ambiguous receipt takes the reconciliation path instead.
[DR-034](034-durable-failure-retry-continuity.md)'s entry-event retry shall not be advertised from the unresolved state, whose only retry is reconciliation.
[DR-031](031-shared-captain-session-front-ends.md)'s uncertain-turn recovery shall reconcile every durably started governed boundary since the snapshot that whole-turn retry would restore and shall permit replay only when every boundary has a complete receipt proving `unchanged`; any nonzero, ambiguous, or incomplete boundary shall enter parked reconciliation.
[DR-038](038-universal-run-resumption.md)'s retained generation shall preserve and reenter an unresolved reconciliation state, prevent adopted work from resuming or exposing ordinary actions until every outstanding effect boundary resolves, and prevent a retained pre-effect generation from bypassing the ledger rather than using its duplicate-effect warning as permission to replay the player; explicit unresolved abandonment shall clear that root instead of retaining a turn-start dismissal candidate.

### 5. Workflow commit outcomes reconcile semantics with effects

For the maintained CODE and DECIDE artifacts, a commit outcome shall require a receipt proving `one-descendant-commit` and shall take `latestCommit` only from the observed OID.
For the maintained REVIEW artifact, `committed` shall require that same predicate, while `rejectedAll` shall require a receipt proving `unchanged`.
An `unchanged` receipt for a claimed commit, a nonzero receipt for a claimed no-commit outcome, multiple commits, rewritten or non-descendant history, concurrent or foreign changes, and ambiguous evidence shall not select either claimed outcome.
The semantic plane continues to decide CODE's direct-versus-intent and remaining-task meaning; repository evidence corroborates only the declared repository disposition.

### 6. Canonical runtime evidence grounds status, metrics, and Captain control

Each CODE, REVIEW, and DECIDE adjudicated outcome arm governed by this decision shall carry stable linker- or artifact-authored acceptance instrumentation naming its declared outcome independently of the internal guard-function name.
Only instrumentation executed by the selected arm and confirmed by the corresponding public root-machine snapshot shall produce an accepted-outcome receipt `{ source, target, acceptedOutcome }`; ordinary non-outcome state changes need no such receipt.
The runtime shall implement that contract through public XState surfaces or explicit artifact instrumentation, not underscore-prefixed inspection members.
It shall publish and drain accepted-outcome evidence before the public boundary settles, derive default `→ <outcome>` status from it, and emit neither an accepted-outcome receipt nor claimed-outcome status when stricter validation selects a fallback with no governed outcome.
Captain saved-count metrics shall consume accepted outcomes rather than raw judge JSON.
Session-Captain control shall consume canonical structured settlement, terminal-result, and bounded unresolved-effect facts; an aggregate transcript may remain conversation or presentation context but shall not establish an action result.
Before each controller result-phase presentation, the host shall freeze one canonical `unresolvedEffects` list from the applicable durable envelopes, schema-3 `SettlementEvidence` shall carry an exact validated copy, and the result-phase facts shall be only a deterministic bounded rendering of that structure.
At that turn's later safe settlement boundary, `PlaybookCaptainSettlement` and Captain session-record schema `5` shall carry exact validated copies of the frozen controller list without another repository observation; a safe settlement with no controller settlement shall instead carry the current canonical list from its durable envelopes in those two host shapes without another repository observation and without fabricating `SettlementEvidence` or result-phase facts.

### 7. Compatibility and release ordering are explicit

The shared engine, registries, and CLI artifact validators shall add artifact schema `3` alongside schema `2`, and the engine shall retain runtime ABI `1`, because the authority metadata and current-host construction capabilities are schema-gated additions that neither widen `PlaybookPorts` nor change the schema-2 factory contract.
Schema `2` shall retain legacy behavior during implementation, while schema `3` shall require exact authority and repository-disposition metadata for every governed delegated-player outcome and an explicit empty governed set for an artifact with none.
No shipped artifact shall declare schema `3` before satisfying that contract, and every artifact shall migrate atomically with its governed behavior before the candidate gate removes schema `2` from the supported set.
Removing schema `2` shall be the breaking next-major cutover under [DR-022](022-runtime-compatibility-contract.md).
The closed public `PlaybookRunResult` union shall add the `unresolved-effect` variant, `PlaybookCaptainSettlement` shall add its required `unresolvedEffects` list, and schema-3 Captain `SettlementEvidence` shall require the same list in that next-major release, with the SLC, maintained runtimes, Captain host, CLI, package declarations, and exhaustive consumers shipping together.
Runtime snapshots, trace events, and complete shell snapshots shall advance from schema `3` to schema `4`; the Captain session record shall advance to schema `5` because record schema `4` already names the compatible historical retained-generation shape.
Older persisted artifacts, snapshots, retained generations, and session records shall be migrated only by an explicit validator that can preserve every authority fact; otherwise they shall reject before governed work rather than fabricate evidence.
Trace schema `4` shall distinguish the accepted-outcome event contract for consumers, which shall not treat an earlier trace event as authority-bearing evidence.
Consumption and packed acceptance of the upstream message-boundary repair require a published Cligent release, and the Playbook release shall remain gated on that artifact under [[release-14](../packages/release.md#release-14)].
The authority model, observer, reconciliation, workflow migration, and canonical reporting may proceed independently while that external release is unavailable.

## Consequences

- Equivalent semantic answers select the same outcome regardless of `Commit:` formatting, while repository facts come from Git rather than prose.
- A real or possible repository effect can park for explicit reconciliation, but no automatic, failure-state, uncertain-turn, or retained-generation path repeats its player call or bypasses an earlier boundary in the same turn; only a checkpoint-identical authored Boss-question continuation may call that player again.
- Missing semantic evidence may leave work explicitly unresolved instead of claiming success or automatically completing from repository layout conventions.
- A parked unresolved episode reports bounded receipt identity before the Boss selects recovery, while unresolved-effect abandonment is a host-level disposal result outside the `terminal` variant that clears prior retained work for the root, reports the final bounded receipt identity, and ends the attempt without inventing an authored final state or resuming a parent workflow.
- Cooperative leasing reduces collisions among Playbook hosts, while foreign writes remain outside its guarantee and fail closed when detected or when they make observation ambiguous.
- Status, summary counts, and Captain control agree with the outcome the machine accepted.
- The durable envelope expands persisted sensitive data and requires the same user-only protection as the containing Captain session record, while the Boss-visible unresolved summary excludes paths, prose, and internal identifiers.
- Artifact support, the public run-result union, trace events, runtime snapshots, shell snapshots, and durable records change together in a next-major cutover while the shared-engine ABI remains `1`.
