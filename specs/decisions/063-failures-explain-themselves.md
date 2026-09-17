<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-063: Failures Explain Themselves

## Status

Accepted (2026-09-17).
Amends [DR-040](040-outcome-authority-effect-reconciliation.md) §4 in one scope: beside the bounded unresolved-effect list, a parked failure carries a structured cause, and the advertised recovery actions carry a standing.
Amends [DR-051](051-host-selected-runtime-recovery.md) and [DR-052](052-host-selected-give-up.md) in one scope: the `{ id, label }` pairs a host reads gain `standing` and its `reason`.
Everything else of those records stands.

## Context

- A `/code` run parked with `CODE governed outcome remains unresolved: repository-disposition-mismatch`.
  The runtime held the whole diagnosis — both projections, the required and the observed disposition — and reduced it to one reason string.
  The Boss saw "workflow failed; awaiting Boss recovery", a closing reply that hedged over two commit hashes, and an effect report that names no path by design.
- The run advertised two actions, "Retry unresolved effect reconciliation" and "Abandon unresolved workflow attempt", with nothing to say which could work.
  Reconciliation only re-reads the host's ledger; over a complete receipt it can never resolve anything, yet it read exactly like a retry.
  The embedding host took the first advertised action as its Retry and offered nothing for the second.
- Every host reinvents the explanation: the CLI Boss reads the closing reply, the desktop Boss reads a notice, and both depend on a model composing prose from facts it may drop.
- The facts already exist as data at the moment each failure is decided: the reconciliation reason, the receipt with its `preExisting` accounting ([DR-062](062-pre-existing-changes-are-context.md)), the player or judge error, the aborted signal, the child's own failure.

## Decision

1. **One closed cause contract.**
   A failure cause is `{ code, evidence }` with `code` from one exported closed list and `evidence` a closed JSON object whose members depend on the code:

   | Code | Meaning | Evidence |
   | --- | --- | --- |
   | `commit-missing` | the outcome required one commit and the receipt proved `unchanged` or `worktree-only-change` | `required`, `observed`, `baselineHead`, `afterHead`, `paths.uncommitted` |
   | `commit-residual` | one commit was made but uncommitted changes remain beside it | `required`, `observed`, `baselineHead`, `afterHead`, `commitOid?`, `paths.uncommitted`, `paths.altered` |
   | `pre-existing-lost` | a pre-existing change vanished without being committed | `required`, `observed`, `baselineHead`, `afterHead?`, `paths.lost` |
   | `commits-more-than-one` | more than one descendant commit | `required`, `observed`, `baselineHead`, `afterHead` |
   | `history-rewritten` | ancestry lost or HEAD names no commit | `required`, `observed`, `baselineHead`, `afterHead` |
   | `foreign-change` | a call declared `unchanged` saw the repository change | `required`, `observed`, `baselineHead`, `afterHead`, `paths.changed` |
   | `observation-unstable` | the observation itself failed closed | `required`, `observed`, `baselineHead` |
   | `attribution-ambiguous` | any other ambiguous receipt | `required`, `observed`, `baselineHead`, `afterHead?` |
   | `receipt-missing` | a boundary holds no complete receipt | `baselineHead` |
   | `judge-failed` | adjudication transport failed or its candidate stayed invalid | `reason`, `error?` |
   | `player-failed` | a player call errored or reported a non-`ok` result | `roleId`, `playerId?`, `error`, `errorCode?` |
   | `aborted` | the turn's signal aborted the work | none |
   | `child-failed` | a nested playbook failed | `playbookId`, `cause?` |
   | `runtime-defect` | a runtime or host invariant failed | `reason` |

   Every path list is sorted, unique, bounded to 32 paths with `truncated` carrying the omitted count, and holds repository paths only, never content.
   `required` and `observed` are repository dispositions and classifications.
   There is no unknown code: an unrecognized failure is `runtime-defect` with its message as `reason`.
2. **Attached where the failure is decided.**
   The runtime attaches the cause to the error it marks as the FSM failure, so it reaches the artifact's `lastError`, the failed-state status line's data, the transition and settled-input telemetry, and the control view; a normalized error carries `cause` exactly when the underlying error carries a valid one.
   A nested call's failure carries the child's cause inside `child-failed`.
3. **Every advertised action carries its standing.**
   A control action is `{ id, label, standing, reason? }` with `standing` `ready`, `no-op`, or `blocked` and `reason` a code from a closed list.
   Reconciliation is `no-op` with reason `receipt-complete` when re-reading the host's ledger, which the control view has just done, leaves reconciliation unresolved and no checkpoint restoration is eligible; abandonment, the shell's give-up, a jump, and a retry of a failed call are `ready`, since the runtime cannot see whether the Boss changed the outside world.
   The Captain's decision digest names each action's standing, so a model is never invited to select a no-op.
4. **Every host sees the same report.**
   When a Boss turn settles with the leaf parked in its failure state or behind the retained-effect fence, the shell appends one deterministic Boss-visible report through the presentation seam: the cause as one sentence per code with its bounded evidence, and each advertised action with its standing and reason.
   The report supplements the unresolved-effect report and the pre-existing-changes report; it exposes no content, prose, or internal identity.

## Consequences

- A host can say what failed, why, and what each control will do without a model composing it, and a host without a phrase catalogue still gets the shell's sentence.
- Hosts that pick the first advertised action lose their excuse: the list says which action is a no-op.
- The cause enters stored session records inside `lastError`, so a parked failure explains itself after a restart.
- The closed code list is the contract a host catalogue is tested against; adding a failure kind means adding a code, never an unexplained failure.
- The cost is one closed validator, one evidence builder per decision site, and a standing computed from state the control view already reads.
