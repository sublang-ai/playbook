<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-048: Outcome authority and effect reconciliation

## Status

Planned

## Intent

Separate player presentation, semantic adjudication, observable repository effects, and runtime settlement so CODE, REVIEW, and DECIDE select and report only outcomes justified by schema-validated semantic decisions and durable host evidence, without replaying an effectful player when the outcome remains unresolved.
Implementation is gated on a published Cligent release containing the already-landed complete-message separation repair.

## Deliverables

- [ ] A published Cligent patch preserves complete-message boundaries, and Playbook's dependency floor, lockfile, and packaged integration exercise that published artifact with Codex-shaped commentary followed by a final response.
- [ ] The authority model classifies presentation-, semantic-, effect-, and runtime-owned fields; `finalText` remains opaque to FSM guards and cannot establish an observable effect.
- [ ] Effectful artifact calls run under an exclusive workspace lease and capture a durable reconciliation envelope with opaque player output, source outcome schema, and before-and-after repository evidence for explicit zero, one, multiple, rewritten or non-descendant, and concurrent-change outcomes.
- [ ] Semantic adjudication returns exactly one schema-valid declared outcome, receives at most one corrective re-ask, and otherwise fails closed.
- [ ] CODE and DECIDE derive commit existence and identity from repository evidence; REVIEW permits `committed` only with a qualifying effect and `rejectedAll` only with unchanged HEAD and relevant worktree evidence.
- [ ] An observed effect followed by missing or malformed transport or adjudication persists as unresolved and resumes reconciliation only, never the player effect.
- [ ] Human status and saved-count metrics derive from the transition actually accepted by the FSM, while session-Captain control consumes canonical structured settlement and terminal-result evidence rather than an aggregate transcript or raw player or judge output.
- [ ] Specs, authored and generated artifacts, deterministic and integration suites, release gates, changelog, and candidate metadata agree and pass.

## Tasks

1. **Consume the published transport repair.**
   One Playbook commit: raise the Cligent dependency floor and lock to the published patch, amend the `release` package contract, and add a packed integration case whose Codex-shaped commentary and final response remain separate through the installed dependency.
2. **Record the outcome-authority model.**
   One spec commit: record the narrow decision and its map row, then update the `playbook`, `playbook-runtime`, `playbook-captain`, `captain-playbook`, `playbook-cli`, and `release` packages plus the SLC contracts with the presentation, semantic, effect, and runtime ownership taxonomy; the opaque-`finalText` rule; the typed artifact-option boundary; the effect matrix, lease, and recovery rules; artifact, ABI, SemVer, snapshot, continuation, and retained-generation compatibility; exact IR-evidence rules; accepted-transition multiplicity and outcome mapping; and canonical session-Captain control input.
3. **Build repository observation and leasing.**
   One commit: add the decision's detached repository observer and exclusive workspace-lease primitives, classify zero, one, multiple, rewritten or non-descendant, worktree-only, and concurrent deltas fail closed, and keep their focused specs and tests aligned without yet changing a workflow.
4. **Inject the repository capability.**
   One commit: thread the decision's artifact-specific typed capability and working-directory identity through the CLI, Captain registry, and every fresh, restored, or adopted runtime-construction path without widening `PlaybookPorts`, keeping the runtime, Captain, and CLI specs aligned with construction-path integration tests.
5. **Persist unresolved reconciliation.**
   One commit: persist the repository receipt, opaque player `finalText`, source state and outcome schema, and required semantic fields as an effect-observed, outcome-unresolved envelope across safe snapshot export, host teardown, restore, process restart, and continuation; implement the decided snapshot migration or rejection behavior; prohibit a second player invocation; and update the corresponding runtime and CLI behavior, snapshot, and continuation evidence.
6. **Centralize semantic reconciliation.**
   One commit: centralize exact declared-outcome schema validation, issue exactly one corrective hidden adjudication re-ask after a structurally invalid semantic reply but none for abort, transport failure, or a non-`ok` result, reconcile semantic output with the persisted effect envelope, fail closed without replaying the player, and update the linker and runtime contracts plus boundary tests.
7. **Migrate CODE to effect authority.**
   One commit: remove CODE's `Commit:` response instruction and parser, source `latestCommit` only from a qualifying one-descendant receipt, derive `irNumber`, the current and next `irTask`, and `moreTasks` versus `finalTask` under the decision's exact committed-artifact rules with absent or ambiguous evidence failing closed, update its authoritative source and generated artifacts, keep the `playbook` package aligned, and cover formatting invariance, every effect case, and post-effect reconciliation failure.
8. **Migrate REVIEW to effect authority.**
   One commit: allow `committed` only for its qualifying observed commit and `rejectedAll` only when HEAD and the relevant worktree delta are unchanged, route mismatched or ambiguous evidence fail closed without replaying Coder, update its authoritative source and generated artifacts, keep the `playbook` package aligned, and cover the complete reconciliation matrix.
9. **Migrate DECIDE to effect authority.**
   One commit: remove DECIDE's `Commit:` response instruction and parser, derive `latestCommit` from a qualifying repository receipt, reuse the shared semantic reconciliation contract in its parallel runtime, update its authoritative source and generated artifacts, keep the `playbook` package aligned, and cover the same formatting and effect matrix.
10. **Publish only accepted transition evidence.**
    One commit: emit the decision's complete ordered accepted-transition evidence at each accepted XState microstep in the shared and DECIDE runtimes, preserving parallel and multi-target multiplicity and mapping machine guard names to declared outcomes; derive default transition status from that evidence; drain it before the public boundary settles; and update runtime specs and integration tests for rejected-guard fallback.
11. **Ground Captain control and metrics.**
    One commit: give session-Captain control only canonical structured settlement and terminal-result evidence rather than an aggregate transcript, derive canonical outcome facts and saved-count telemetry only from accepted transitions, remove raw-judge guard parsing, and update the `playbook-captain` and `captain-playbook` contracts plus shell and compiled-Captain integration tests.
12. **Gate and close the intent.**
    One commit: add the final packed and cross-process acceptance matrix through the published Cligent dependency, update public documentation, changelog, and candidate metadata, run Spex, deterministic, build, fidelity, and packed gates, mark this intent complete, and stop without tagging, pushing, or publishing Playbook.

## Verification

- Missing, glued, fenced, quoted, duplicated, or misleading `Commit:` prose cannot change a transition when semantic and repository evidence are otherwise equal.
- CODE and DECIDE accept only the specified qualifying repository delta and take `latestCommit` from its observed OID; REVIEW cannot choose `rejectedAll` after a relevant change or `committed` without one.
- Zero, one, multiple, rewritten or non-descendant, worktree-only, and concurrently introduced changes have explicit deterministic fail-closed outcomes.
- A real effect followed by missing or malformed player transport or adjudication survives restart and completes by reconciliation without another player call.
- An adjudicator selects exactly one declared outcome after no more than one corrective re-ask, and invalid output cannot enter another outcome through answer formatting.
- Status and saved-count telemetry name or count only the transition the FSM accepted, including when stricter validation routes a claimed guard to a malformed-output path; session-Captain control receives only canonical structured settlement and terminal-result evidence.
- Packed acceptance installs the published Cligent dependency and passes Spex lint, deterministic suites, build and fidelity checks, release smoke, and the cross-process recovery gate.
