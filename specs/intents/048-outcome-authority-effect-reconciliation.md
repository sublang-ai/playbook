<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-048: Outcome authority and effect reconciliation

## Status

Planned

## Intent

Implement [DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) so CODE, REVIEW, and DECIDE select and report outcomes from schema-validated semantics, durable repository evidence, and accepted runtime settlement rather than player-answer formatting.
Consumption and packed acceptance of the upstream transport repair gate only tasks 16 and 17; tasks 1 through 15 may proceed while that Cligent release is unavailable.

## Deliverables

- [ ] Versioned authority metadata separates presentation, semantic, effect, and runtime-owned delegated-player outcome fields in CODE, REVIEW, and DECIDE without changing unrelated transition paths.
- [ ] Repository observation and cooperative Playbook-writer coordination produce durable, fail-closed effect receipts without claiming to exclude or identify every foreign writer.
- [ ] Effect-possible unresolved work and every earlier effect boundary in its turn survive process boundaries and every recovery path without replaying a player.
- [ ] Exact bounded semantic adjudication reconciles with effect evidence while CODE's intent identity and progress fields remain semantic.
- [ ] CODE, REVIEW, and DECIDE use the effect predicates and commit identities decided by [DR-040](../decisions/040-outcome-authority-effect-reconciliation.md).
- [ ] Accepted-outcome evidence is the single source for governed transition status and saved-count metrics, while Captain control consumes canonical structured settlement and terminal-result facts.
- [ ] A published Cligent patch preserves complete-message boundaries, and Playbook's dependency floor, lockfile, and packaged integration exercise that published artifact with Codex-shaped commentary followed by a final response.
- [ ] Specs, authored and generated artifacts, deterministic and integration suites, release gates, changelog, and candidate metadata agree and pass.

## Tasks

1. **Add schema-3 authority contracts.**
   One commit: extend the SLC, linker, shared engine, registry, and CLI artifact contracts to accept artifact schema `3` alongside legacy schema `2` under runtime ABI `1`, validate exact authority metadata or an explicit empty governed set without migrating workflow behavior, and land the corresponding `playbook`, `playbook-runtime`, `playbook-captain`, `playbook-cli`, and `release` items plus conformance tests.
2. **Build repository observation and cooperative leasing.**
   One commit: add detached repository-observer and canonical-worktree lease primitives, classify the complete effect matrix fail closed, prove that participating Playbook calls serialize while different worktrees remain independent, require detected concurrent or foreign mutation and observation ambiguity to fail closed without claiming universal attribution, and land the corresponding runtime and CLI items and focused tests.
3. **Inject the repository capability.**
   One commit: thread the decision's artifact-specific typed capability and working-directory identity through the CLI, Captain registry, and every fresh, restored, or adopted runtime-construction path without widening `PlaybookPorts`, keeping the runtime, Captain, and CLI specs aligned with construction-path integration tests.
4. **Persist unresolved reconciliation.**
   One commit: persist the ordered per-turn ledger of started boundaries, complete effect envelopes, and correction budgets across safe export, host teardown, restore, continuation, and retained-generation adoption; reconstruct incomplete boundaries before source-state restoration; advance the decided runtime, shell, and durable-record schemas with explicit migration or pre-effect rejection; and land the `playbook-runtime`, `playbook-captain`, and `playbook-cli` items plus snapshot and cross-process tests.
5. **Close runtime-local replay gates.**
   One commit: make empty-`ok` player correction and failure-state retry in the shared and DECIDE runtimes conditional on non-effectful work or a complete zero-delta receipt, route effect-possible calls to reconciliation, and land the runtime and playbook items plus focused tests.
6. **Fence uncertain whole-turn retry.**
   One commit: reconcile every started boundary since the restorable pre-turn snapshot, permit CLI whole-turn replay only when every complete receipt proves zero relevant delta, park observed, ambiguous, or incomplete boundaries, and land the `playbook-cli` items plus cross-process recovery tests.
7. **Fence retained-generation adoption.**
   One commit: preserve effect ledgers with retained generations, require outstanding boundaries to reconcile before adoption, prevent a retained pre-effect generation from bypassing an effect-possible boundary, and land the `playbook-captain` and `playbook-cli` items plus adoption tests.
8. **Centralize semantic reconciliation.**
   One commit: centralize exact declared-outcome validation and its durable one-call correction budget, start a corrective judge only while its abort signal remains live, retain opaque presentation and semantic evidence without parsing repository facts, reconcile complete evidence or park unresolved, and land the linker and runtime contracts plus malformed, transport, abort, restart, and missing-evidence tests.
9. **Expose unresolved-effect controls.**
   One commit: advertise only explicit reconciliation retry and Boss abandonment while effect evidence remains unresolved, make abandonment return an unresolved-effect terminal result without restoring source state, replaying a player, or claiming completion, and land the runtime, Captain, and CLI items plus control and continuation tests.
10. **Stage accepted-outcome consumers.**
    One commit: teach the shared and DECIDE runtimes to consume schema-3 artifact markers, publish only markers executed by XState and confirmed by the corresponding public root snapshot, emit no accepted outcome for rejected-guard fallback, derive schema-3 status without private inspection fields, retain the schema-2 legacy status path, drain evidence before public settlement, advance trace events to schema `4`, and land the runtime items plus fallback tests.
11. **Stage canonical Captain consumers.**
    One commit: give schema-3 session-Captain control canonical structured settlement and terminal-result evidence rather than an aggregate transcript, derive schema-3 saved-count telemetry only from accepted outcomes, retain raw-judge parsing only as a schema-2 legacy path, move the compiled Captain artifact to schema `3` with its explicit empty governed set, and update the `playbook-captain` and `captain-playbook` contracts plus integration tests.
12. **Migrate CODE to effect authority.**
    One commit: remove CODE's `Commit:` response instruction and parser, source `latestCommit` only from its one-descendant receipt, keep `irNumber`, `irTask`, and `moreTasks` versus `finalTask` semantic, attach stable accepted-outcome markers for the staged consumers, move CODE atomically to artifact schema `3`, update the authoritative and generated artifacts, and land the `playbook` items plus formatting and effect-matrix tests.
13. **Migrate REVIEW to effect authority.**
    One commit: allow `committed` only for its one-descendant receipt and `rejectedAll` only when HEAD and the relevant worktree delta are unchanged, route mismatched or ambiguous evidence to unresolved reconciliation without replaying Coder, attach stable accepted-outcome markers for the staged consumers, move REVIEW atomically to artifact schema `3`, update the authoritative and generated artifacts, and land the `playbook` items plus reconciliation-matrix tests.
14. **Migrate DECIDE to effect authority.**
    One commit: remove DECIDE's `Commit:` response instruction and parser, derive `latestCommit` from its one-descendant receipt, reuse shared semantic reconciliation in its parallel runtime, attach stable accepted-outcome markers for the staged consumers, move DECIDE atomically to artifact schema `3`, update the authoritative and generated artifacts, and land the `playbook` items plus formatting and effect-matrix tests.
15. **Complete the artifact-schema cutover.**
    One commit: prove every shipped artifact, registry, generated sibling, packed fixture, CLI launch projection, and durable artifact reference uses schema `3`, remove schema `2` from the engine, registries, and CLI validators, delete the schema-2-only raw status and judge-parser fallbacks, retain runtime ABI `1`, update the runtime, Captain, CLI, and release contracts, and cover rejection of legacy artifacts before effectful work.
16. **Consume the published transport repair.**
    One commit: when the repaired Cligent release is public, raise the dependency floor and lock, amend the `release` package contract, and add a packed integration case whose Codex-shaped commentary and final response remain separate through the installed dependency.
17. **Gate and close the intent.**
    One commit: add the final packed and cross-process acceptance matrix through the published Cligent dependency, update public documentation, changelog, and candidate metadata, run Spex, deterministic, build, fidelity, packed, and conditional manual tmux UX gates, mark this intent complete, and stop without tagging, pushing, or publishing Playbook.

## Verification

- Missing, glued, fenced, quoted, duplicated, or misleading `Commit:` prose cannot change a transition when semantic and repository evidence are otherwise equal.
- CODE and DECIDE accept only the specified qualifying repository delta and take `latestCommit` from its observed OID; REVIEW cannot choose `rejectedAll` after a relevant change or `committed` without one.
- Zero, one, multiple, rewritten or non-descendant, worktree-only, and detected or observationally ambiguous concurrent changes have explicit deterministic fail-closed outcomes.
- Two participating Playbook sessions cannot overlap effectful calls in one canonical worktree, calls in different canonical worktrees remain independent, and detected nonparticipating mutation or observation ambiguity fails closed without claiming that every foreign write can be identified.
- A real or possible effect followed by empty player output, failed adjudication, failure-state retry, uncertain-turn recovery, or retained resumption survives restart without another player call; every started boundary since a restorable snapshot must prove zero relevant delta before whole-turn replay, complete retained evidence reconciles, and missing semantic evidence remains parked with only reconciliation retry or Boss abandonment.
- Boss abandonment returns an explicit unresolved-effect result without restoring source state, replaying a player, or claiming workflow completion.
- `irNumber`, `irTask`, and `moreTasks` versus `finalTask` remain schema-validated semantic fields and are never inferred from an unspecified intent-progress marker.
- An adjudicator selects exactly one declared outcome after at most one corrective judge call, with one call after a structurally invalid reply when its boundary remains live and none after abort, transport failure, non-`ok`, or missing presentation evidence; restart cannot restore a spent or indeterminate correction budget.
- Status and saved-count telemetry consume only governed artifact markers confirmed by public root snapshots, emit no claimed outcome when stricter validation selects a fallback, and require no underscore-prefixed XState inspection field.
- Session-Captain control receives only canonical structured settlement and terminal-result facts for outcome authority, never an aggregate transcript.
- Artifact schema `3` coexists with legacy schema `2` under runtime ABI `1` only during migration; no artifact declares schema `3` before its governed behavior agrees, and the next-major candidate ships only schema-3 artifacts with schema `2` rejected.
- Packed acceptance installs the published Cligent dependency and passes Spex lint, deterministic suites, build and fidelity checks, release smoke, and the cross-process recovery gate.
