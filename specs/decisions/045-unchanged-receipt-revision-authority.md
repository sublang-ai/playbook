<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-045: Unchanged-Receipt Revision Authority

## Status

Accepted

## Context

REVIEW's authored contract returns the exact repository revision at which the review scope was evaluated, and CODE and DECIDE complete only when the nested `review` result gives that revision; REVIEW also forbids taking it from player prose.
Under [DR-040](040-outcome-authority-effect-reconciliation.md) the engine injects effect-owned fields only from a `one-descendant-commit` receipt's commit OID, and construction rejects an effect-owned field on any `unchanged` arm.
A review that closes clean with no review-fix commit therefore has no authoritative source for the evaluated revision: semantic authority is prose-derived and banned by the source, so the compiled output had to omit the member, and every caller that requires it — the composed happy path — would fail by construction.
The `unchanged` receipt itself already proves an observed repository state whose HEAD is exactly the revision the clean round evaluated.

## Decision

An outcome arm whose repository disposition is `unchanged` may declare effect-owned fields, and the reconciler shall inject each of them with the matching `unchanged` receipt's observed HEAD OID.
A `one-descendant-commit` arm's effect-owned fields keep their existing meaning — the exact OID of the one new descendant commit.
Effect-owned fields remain forbidden on `deferred` arms, and injection by authority never depends on a field's name.
REVIEW's compiled artifacts declare `evaluatedRevision` as an effect-owned field on every `noFindings` arm, so its terminal output always carries the exact receipt-proven revision — the last review-fix commit when one landed, or the observed clean-round HEAD when none did — and CODE and DECIDE validate the member as required.

## Consequences

- The composed clean-review happy path settles with repository-authoritative evidence instead of failing or falling back to prose.
- Artifacts using the new declaration require an engine carrying this rule; artifact schema `3` and runtime ABI `1` are unchanged, and the maintained artifacts ship with their engine.
- [DR-040](040-outcome-authority-effect-reconciliation.md)'s effect-authority matrix is extended, not replaced: every other disposition and rejection rule stands.
