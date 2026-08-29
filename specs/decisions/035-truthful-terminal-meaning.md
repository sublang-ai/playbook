<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-035: Truthful Terminal Meaning

## Status

Accepted.
Extends [DR-029](029-session-scoped-conversational-captain.md)'s evidence contract to the terminal meaning a compiled workflow publishes about itself.
[DR-040](040-outcome-authority-effect-reconciliation.md) preserves the authored-final-state rule by representing unresolved-effect abandonment as a host disposal result outside the `terminal` variant rather than an FSM outcome.

## Context

- A compiled workflow's run output is opaque to the session Captain: [DR-029](029-session-scoped-conversational-captain.md) admits only settlement facts as Captain evidence, and a workflow's machine output stays runtime-to-runtime data the Captain never reads.
- The one Boss-facing thing a terminating root does publish is the description of the final state it reached, which the host escapes, bounds, and quotes as that turn's outcome fact.
- A final state's description is therefore a published terminal meaning rather than documentation: it is the sole grounding for what the Boss is told a finished workflow did.
- CODE routed three arms into one `done` state described as completion after REVIEW found no unsettled findings — exact approval, an authored REVIEW abort or failure, and a terminal REVIEW result that does not prove approval.
- Dismissing a parked nested REVIEW consequently drove CODE to `done` and announced "completed after REVIEW found no unsettled findings", while the `review-failed` status and its abort error remained visible only to a caller that reads run output.
- DECIDE already compiles the same authored outcomes onto two final states, so the divergence is a per-workflow accident rather than a contract, and no compiler rule forbids the overload.

## Decision

1. **A final state's description shall be true of every arm that enters it.**
   A description only one incoming arm satisfies is a defect of the same class as a wrong result field, because a host with no access to run output cannot detect the difference.

2. **Materially different terminal outcomes shall reach distinct final states.**
   Where Source declares a terminal failure — the workflow starts no further work and reports a failure to its caller instead of parking for recovery — that outcome takes its own `type: 'final'` state whose description names the failure, alongside the success state.
   A machine may therefore declare more than one final state: the existing requirement is a floor of one, not a ceiling.

3. **The rule binds the compiler, not one workflow.**
   `slc/gears2fsm.md` states it, so every machine compiled from a Source declaring distinct terminal outcomes satisfies it by construction and conformance can check it.

4. **Declared machine output is unchanged.**
   A terminal result contract keeps deriving its status and fields from typed context, so a caller that does read run output sees exactly what it saw before.
   Splitting a state changes only what the workflow publishes about itself.

Considered and rejected: retaining one final state and widening its description to cover every outcome.
A description true of both approval and failure carries no outcome at all, so the Boss-facing fact degrades into an announcement that something ended, which is the same failure of meaning stated more carefully.

## Consequences

- CODE gains a terminal review-failure state, so a REVIEW failure — including a Boss dismissal of the nested review — is announced as a failure instead of as a clean success.
- Conformance gains a terminal-meaning check, which is what keeps this defect class from returning at the next compile; REVIEW and DECIDE already satisfy it.
- Hosts that quote the published description need no change: the correction lands inside the artifact whose published meaning was wrong.
- A workflow's terminal state id becomes outcome-bearing, so a trace consumer grouping by state id sees a distinct id for an outcome that previously shared one.
