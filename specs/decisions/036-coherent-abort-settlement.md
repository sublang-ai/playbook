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
   Every site that latches or reports a failure classifies it there, against the boundary signal applicable at that moment; a cancellation-identical failure is the abort's own evidence and is dropped, never latched, never carried to a later boundary.
   Read-point forgiveness remains as defense, but correctness never depends on a read point remembering to classify.

3. **A boundary settles on the machine's state at its quiescence point.**
   Precedence: a suspended pending call, then a distinct actor error, then terminal completion, then a coincident abort, then the recoverable failure state.
   Terminal completion outranks the abort because reporting `aborted` over a completed machine hides a terminal state that the next turn silently restarts, duplicating the workflow's side effects.
   An abort observed after the outcome is computed does not rewrite it: the returned result and the already-emitted settlement trace state one fact.

4. **A cancellation-coupled channel failure settles as the abort it evidences.**
   A started-trace sink, finish sink, drain, or delivery rejection causally identical to the applicable reason finishes its pair `aborted`, latches nothing, and lets the turn settle as an abort; a distinct failure in the same place keeps full control-error precedence.

5. **A boundary entered with an already-aborted signal delivers nothing.**
   Text classifies nothing, a script spawns nothing, and a resume consumes nothing — the validated child result is not delivered, no finish is emitted, and the pending call survives for a later resume with a fresh signal.

6. **Invocation ownership spans the invocation.**
   Resources an invocation acquires — the script's process group, its abort listener and escalation timer — stay owned until the invocation settles, not until an intermediate milestone such as shell exit; on abort, settlement additionally awaits confirmed teardown, bounded by the same grace that bounds escalation.

7. **Outside any boundary, observed errors ride the emission channel.**
   A startup actor error latches onto the channel `init` and `restore` drain, so the failed-start cleanup runs and the boundary rejects with the original error instead of resolving over a dead machine.

Considered and rejected: name-based (`AbortError`) classification — a fresh failure can wear the name and a cancellation can arrive without it; abort-over-terminal precedence — it converts a completed workflow into a silent rerun; rewriting a computed outcome when an abort lands during settlement emission — the return would disagree with the settlement trace already on the wire.

## Consequences

- The shared engine and DECIDE's bespoke runtime implement one model, and review checks conformance to this record instead of re-deriving the design each round.
- A cancellation that races completion now reports `terminal` with the machine's output; hosts that treated any aborted signal as "nothing happened" must consult the outcome.
- An aborted resume leaves the child call resumable; hosts that assumed abort consumed the result must retry the resume to deliver it.
- An aborted script settles only after its process group stops being signalable, adding bounded milliseconds to abort settlement in exchange for no surviving group member.
