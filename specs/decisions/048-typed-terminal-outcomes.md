<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-048: Typed Terminal Outcomes for Nested Calls

## Status

Accepted

## Context

A workflow source describes a nested call's failure in its own terms: "a terminal result that does not prove the success required for the selected path" ends the caller.
[DR-035](035-truthful-terminal-meaning.md) makes every distinct terminal outcome a distinct final state, and [DR-037](037-terminal-result-meaning.md) makes a final state's description the run's published meaning, but nothing records whether a final state means success or failure.
The runtime delivers a completed child to its caller as `status: 'ok'` with the child's raw output, whatever final state the child reached, so a caller can tell success from an authored failure only by inspecting fields it has no source for.
The maintained `dev` artifact does so because its author read `code.md`; a compiler given `dev.md` alone accepted any child output as success.
Putting the callee's field names into the caller's source would make an end user write implementation detail, and letting the called agent declare its own success would hand outcome authority to prose, which [DR-040](040-outcome-authority-effect-reconciliation.md) forbids.
The machine state is the outcome, and the compiler already decides at compile time which final state each source outcome reaches.

## Decision

- Every final state of a schema-3 artifact declares its terminal kind, `success` or `failure`, in its `meta.playbook` metadata; the compiler derives the kind from the source's own outcome wording, exactly as it derives the state's description, and the maintained artifacts declare theirs.
- A completed child's public call result carries its reached final state's `terminal` record — state id, kind, and description — as runtime-owned data read from the artifact, never from an agent reply.
- The nested-call bridge delivers a success terminal through the caller's `playbook` actor; a failure terminal rejects through its existing error path with an `Error` carrying that same public result, so the caller's first `onError` arm accepts an authored abort, an authored error, or a completed child whose terminal kind is `failure`.
- `onDone` proves successful bridge delivery without a declared child failure, not satisfaction of every caller-owned domain condition: the caller still enforces any explicit source-authored acceptance or relay predicates on the delivered output, without inventing predicates from callee implementation details or reclassifying the child's compiled terminal kind.
- An artifact whose final states declare no kind keeps today's delivery: its completion resolves the actor and carries no `terminal` record.
- No agent call is added: the kind is fixed at compile time and read at run time from the reached state.

## Consequences

- A generic child-success requirement uses the terminal kind and needs no invented callee field contract; an additional source-authored requirement, such as CODE's evaluated-review evidence, remains a caller-owned predicate after successful delivery.
- A caller that relays a failed child's canonical result still receives the child's output inside the rejected result.
- The distinction between an authored abort, an authored error, and a completed failure terminal stays visible to the caller and in the trace, so nothing collapses into an invented enum.
