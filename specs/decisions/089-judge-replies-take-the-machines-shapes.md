<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-089: Judge Replies Take the Machine's Shapes

## Status

Accepted (2026-10-11).
Amends [DR-025](025-resilient-captain-control-adjudication.md)'s consequence that the generic factory keeps single-call direct-Captain adjudication: it gains one corrective adjudication and a parked failure.
Refines [DR-040](040-outcome-authority-effect-reconciliation.md) §3: a semantic field's schema is the value shape the compiled machine admits.
Amended by [DR-091](091-an-unrevealed-shape-is-the-machines-to-judge.md) in §1's fallback: a field whose shape the machine does not reveal is left to the machine's own validator rather than enforced as a string.

## Context

In a ten-team simulation a step's work completed and committed, and the run then failed three times on its hidden adjudication:

- A compiled machine typed a semantic result field as a list of intent numbers, while the runtime admitted only string semantic fields; the judge's list was refused, the corrected string was refused by the machine, and the run failed as a runtime defect with the commit standing.
- A direct-Captain judge prompt named each outcome's meaning but not its exact reply, so the judge added a field the outcome does not declare, and the adjudicator threw it as an uncaught control-plane error after the Boss's answer was delivered.
- After the first failure the Captain's closing reply said nothing had been written or committed, because the turn's settlement facts named no commit once the failure followed an accepted receipt.

## Decision

### 1. The machine decides a semantic field's shape

The compiled machine's own validator is the one type contract for a semantic-owned field.
At construction the runtime presents each governed outcome to the machine's transition selection, evaluating guards only, with sample values of a closed set of shapes — string, array of strings, array of numbers, array of strings or numbers, number, boolean — and takes the first combination, fewest non-string fields first, whose selected arm carries that outcome's accepted-outcome marker.
A field the machine admits as a string, or whose shape it does not reveal, stays a string, so existing artifacts keep their contract.
The judge prompt states each non-string shape, the reconciler enforces it before delivery, and its validation error names it, so the one correction restates the shape the machine admits.

### 2. A direct-Captain judge reply is shaped and correctable

The direct-Captain adjudication prompt keeps each outcome's description and states its exact reply: `guard` plus the structural fields its output clause names, with the visible `question` and `response` named as runtime-supplied.
A reply that fails structural validation — no recoverable object, a missing or undeclared guard, an undeclared field, or a missing required field — earns exactly one corrective adjudication restating the reply and its error.
A second such reply parks the step in its failure state with a `judge-failed` cause for the Boss, never a control-plane error.
A judge transport failure keeps its existing behavior.

### 3. A failed turn states the commits it made

When a turn settles with its leaf parked in failure, the shell states every commit a receipt of that turn proved and no unresolved-effect entry already names, as a settlement fact the closing-reply prompt reads and as a deterministic Boss-visible report beside the failure report.

## Consequences

- An artifact whose machine admits a list now accepts the judge's list on the first reply; no recompilation is needed, only the current shared engine.
- Probing calls guard functions with sample outputs at construction; a guard that throws or depends on context the sample does not satisfy leaves its fields strings.
- The direct-Captain path spends at most one extra hidden judge call, and its exhausted correction becomes a recoverable failure with the step's ordinary controls.
- A closing reply can no longer read the absence of a commit fact as proof that nothing was written.
