<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-063: Failures Explain Themselves

## Status

Accepted (2026-09-17); revised (2026-11-08).
Amends [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-051](051-host-selected-runtime-recovery.md), [DR-052](052-host-selected-give-up.md).
Amended by [DR-090](090-every-role-hears-the-boss.md).

## Context

- A `/code` run parked with `CODE governed outcome remains unresolved: repository-disposition-mismatch`.
  The runtime held the whole diagnosis — both projections, the required and the observed disposition — and reduced it to one reason string.
  The Boss saw "workflow failed; awaiting Boss recovery", a closing reply that hedged over two commit hashes, and an effect report that names no path by design.
- The run advertised two actions, "Retry unresolved effect reconciliation" and "Abandon unresolved workflow attempt", with nothing to say which could work.
  Reconciliation only re-reads the host's ledger; over a complete receipt it can never resolve anything, yet it read exactly like a retry.
  The embedding host took the first advertised action as its Retry and offered nothing for the second.
- Every host reinvents the explanation: the CLI Boss reads the closing reply, the desktop Boss reads a notice, and both depend on a model composing prose from facts it may drop.
- This record adds to DR-040 §4 a structured cause beside the bounded unresolved-effect list and a standing on every advertised recovery action, and adds `standing` and its `reason` to the `{ id, label }` pairs of DR-051 and DR-052; everything else of those records stands.
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
   | `player-failed` | a player call errored or reported an `error` result | `roleId`, `playerId?`, `error`, `errorCode?` |
   | `aborted` | the turn's signal aborted the work, or a player or Captain call reported an `aborted` result | none |
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
   When a Boss turn settles with the leaf parked in its failure state or behind the retained-effect fence, the shell appends one deterministic Boss-visible report through the presentation seam: the cause as one marked failure line of its code and the identities its evidence carries, and each advertised action as one marked control line with its standing and reason identifiers, in the marks of [DR-090](090-every-role-hears-the-boss.md) §5; the cause's words stay in the turn's settlement facts.
   The report supplements the unresolved-effect report and the pre-existing-changes report; it exposes no file content, player output, or internal identity.
   It says each thing once, in Boss's words, by rules that hold by construction rather than by heuristics:
   - one renderer puts every failure into words, for the Boss and for the turn's facts, as `<Subject> failed: <reason>.`, the reason being the phrase of its cause code, else the phrase of a reason the runtime mints from its own literal text — its refusal of an action it no longer advertises, the judge's, the governed settlement's, and the player and Captain calls' reasons, its own invariant reasons behind its diagnostic label, and its stand-ins for a missing player or error message, each listed with its phrase in a closed set — else any other recorded reason, a player's or script's message included, quoted where it reads as prose, else that whole reason shown once as recorded in a code span, never replaced by a sentence that hides it; prose begins with no error-class name, holds a space, begins with a capital letter, ends in a terminal mark, holds no word the reply validation's own identifier grammar tells apart from English, and passes that validation, while a reason behind an error-class name is machine text by origin, shown whole in a code span however the rest reads; and the leaf's cause restates in place the fact that already stated its failure;
   - one report assembly composes every Boss-facing text the shell writes itself from three kinds of statement — listed facts, numbered unresolved-effect entries, and the failure line — and the kinds, not the words' length, decide what is dropped: an entry records a boundary of its own and is never dropped or merged, while a fact or the failure line is dropped where an entry, or an earlier fact, carries its reason, so of two facts the earlier stays;
   - each statement is weighed by the reply validation on its own, outside its code spans: a code span naming a live or supplied identifier reads `an internal error`, a phrased reason whose own words fail is withheld the same way, and a failure subject or action label whose own words fail reads `The step` or `the selected action`, and no statement is ever left out, whatever words are left;
   - after a model-composed reply the failure line stays, once, as the shell's exact record beside the model's prose, since the shell cannot tell whether that prose stated the failure faithfully.

   Residuals accepted by design:
   - two different failures with an identical reason, the same phrase or the same recorded text, are said once, since the assembly weighs reasons and not their sources;
   - a cause fact and an evidence entry about the same boundary are two statements, cause and evidence, not a repeat, wherever the entry does not carry the cause's reason word for word.

## Consequences

- A host can say what failed, why, and what each control will do without a model composing it, and a host without a phrase catalogue still gets the shell's sentence.
- Hosts that pick the first advertised action lose their excuse: the list says which action is a no-op.
- The cause enters stored session records inside `lastError`, so a parked failure explains itself after a restart.
- The closed code list is the contract a host catalogue is tested against; adding a failure kind means adding a code, never an unexplained failure.
- The cost is one closed validator, one evidence builder per decision site, and a standing computed from state the control view already reads.
