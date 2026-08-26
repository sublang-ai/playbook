<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-036: Coherent Abort Settlement

## Status

Accepted.
Records the abort-settlement model the post-[DR-034](034-durable-failure-retry-continuity.md) review rounds converged on piecemeal, so conformance replaces per-round design relitigation.

## Context

- The linked runtime races two authorities at every public boundary: the machine, which settles by reaching quiescence, and the Boss signal, which may abort at any instant — including from inside the runtime's own emission sinks.
- Review rounds amended the classification and settlement rules one sentence at a time, and the sentences drifted into conflict: an unconditional start-sink error law contradicted the exact-identity cancellation carve-out, and abort-over-terminal ordering contradicted the rule that a computed outcome stands.
- Each round re-derived the design from scratch, so every fix minted new read points and new sentences for a reviewer to probe, without a recorded decision to check conformance against.
- Empirical probes established the failure classes: a cancellation echoed through a sink surfaced as a control-plane failure, a completed machine hid behind an `aborted` settlement that a later turn silently restarted, an already-aborted resume consumed the child result it should have preserved, and a script's kill duty ended at shell exit while its invocation kept running.

## Decision

1. **Cancellation is exact causal identity.**
   A failure is cancellation if and only if it is the applicable boundary signal's own reason object; names, shapes, and coincident signal state prove nothing.
   The applicable signals are the invocation-lifetime combined signal and, while a resume settles, the resume boundary's own signal.

2. **Classification lives at the latch.**
   Every site that latches or reports a failure classifies it there, against the boundary signal applicable at that moment; a cancellation-identical failure is the abort's own evidence and is handled according to decision 4, never mislabeled as a distinct failure or carried to an unrelated later boundary.
   Once a failure is latched as distinct, a later read point shall not reinterpret it against another boundary's signal, even if that signal later uses the same object as its abort reason.

3. **Ordinary boundary settlement follows the machine's state at its quiescence point.**
   Precedence: a suspended pending call, then a distinct actor error, then terminal completion, then a coincident abort, then the recoverable failure state.
   Terminal completion outranks the abort because reporting `aborted` over a completed machine hides a terminal state that the next turn silently restarts, duplicating the workflow's side effects.
   An abort observed after the outcome is computed does not rewrite it: the returned result and the already-emitted settlement trace state one fact.
   Decision 5 is an entry refusal before this precedence: a pre-aborted resume reports `aborted` while preserving its suspended pending call rather than reporting `suspended` for work it did not deliver.

4. **Cancellation-coupled channels neither mint failures nor rewrite committed facts.**
   The handling point is fixed by this phase matrix:
   - **Before a host call or effect starts (and before apply acceptance):** a start-channel rejection identical to the applicable abort reason starts no host call or effect and latches no control error. If the start was recorded, it receives one best-effort `aborted` finish. An ordinary run boundary then settles through decision 3; a pre-acceptance `apply` instead rejects with that exact reason, records no receipt, and leaves its key reusable.
   - **After a host call or effect starts but before its finish or outcome is recorded:** a rejection identical to an applicable abort reason, including from abort cleanup or an in-flight emission, is cancellation evidence: invocation-owned cleanup completes, any started trace pair receives one `aborted` finish, and the ordinary boundary settles through decision 3. Every distinct host, cleanup, observer, or emission rejection remains a control failure, produces the applicable error finish, and takes distinct-error precedence.
   - **After a call finish is recorded but before the enclosing non-apply outcome is computed:** an identical finish-sink or drain rejection leaves the recorded finish unchanged, emits no corrective second finish, latches nothing, and lets the enclosing boundary settle through decision 3.
   - **After apply acceptance but before receipt publication:** every settlement failure, the exact apply abort reason included, is folded into the current `failed` receipt. Acceptance forbids throwing; the replacement receipt is published, returned, and replayed, and the failure is not carried as a later delivery error.
   - **After a non-apply outcome is computed or an apply receipt is published:** an identical rejection is dropped without rewriting the outcome or receipt and without poisoning a later boundary. A distinct non-apply settlement rejection retains current-boundary control-error precedence; a distinct post-publication apply rejection retains the published receipt and travels on the delivery-failure channel to the next boundary that drains.

5. **A boundary entered with an already-aborted signal delivers nothing.**
   Text classifies nothing, a script spawns nothing, and a resume consumes nothing — the validated child result is not delivered, no finish is emitted, and the pending call survives for a later resume with a fresh signal.

6. **Invocation ownership spans the invocation.**
   Resources an invocation acquires — the script's process group, its abort listener and escalation timer — stay owned until the invocation settles, not until an intermediate milestone such as shell exit; on abort, clean cancellation settlement additionally awaits confirmed teardown, bounded by the same grace that bounds escalation.
   Only an `ESRCH` liveness probe confirms disappearance. If the bound expires while the group remains signalable, or confirmation itself fails, the boundary surfaces a distinct teardown control error instead of claiming a clean abort over an unconfirmed survivor.

7. **Outside any boundary, observed errors ride the emission channel.**
   A startup actor error latches onto the channel `init` and `restore` drain, so the failed-start cleanup runs and the boundary rejects with the original error instead of resolving over a dead machine.

Considered and rejected: name-based (`AbortError`) classification — a fresh failure can wear the name and a cancellation can arrive without it; abort-over-terminal precedence — it converts a completed workflow into a silent rerun; rewriting a computed outcome when an abort lands during settlement emission — the return would disagree with the settlement trace already on the wire.

## Consequences

- The shared engine and DECIDE's bespoke runtime implement one model, and review checks conformance to this record instead of re-deriving the design each round.
- A cancellation that races completion now reports `terminal` with the machine's output; hosts that treated any aborted signal as "nothing happened" must consult the outcome.
- An aborted resume leaves the child call resumable; hosts that assumed abort consumed the result must retry the resume to deliver it.
- A script reports a clean abort only after its process group stops being signalable; an unconfirmed teardown instead reports a distinct bounded control failure.
