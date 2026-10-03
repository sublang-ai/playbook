<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-066: Compiled Builtins Keep Their Public Interface

## Status

Accepted (2026-09-24).
Amends [DR-055](055-public-workflow-contracts.md): the catalog binds the compiled side of a builtin as well as its callers, and `text2gears` joins `gears2fsm` and `link` in reading it.
Everything else of that record stands.
Input-owned reply retention clarified by [DR-082](082-retain-input-owned-boss-replies.md).

## Context

- [DR-055](055-public-workflow-contracts.md) publishes `slc/workflow-contracts.json`, the public output interfaces of the builtin REVIEW, DECIDE, CODE, BRANCH, and PR, so a caller compiles its child-output predicates against exact field names.
  It binds only the caller: `gears2fsm` reads the catalog for a nested target, and the record says a matching local filename establishes no binding.
- The builtin sources name none of those fields.
  `branch.md` says the workflow "returns the exact branch name, the exact base revision, and the issue summary"; the catalog calls them `branch`, `baseRevision`, and `issueSummary`, and the maintained artifact does so by a human's choice.
  A compile of `branch.md` through the current definitions named them `branchName`, `coderResult`, and `refusalReason`, and a compile of `pr.md` named the pull request `pullRequestNumber`; each is a defensible camel-casing of the prose, and each breaks the callers compiled against the catalog — DEV consumes `branch`'s `branch`, `baseRevision`, and `issueSummary` by name — and the package's own conformance matrices, which name the fields.
- The same compile declared a `refusalReason` output property beside `coderResult`: a judge-authored field no later item, terminal return, or interface consumes, because the reason is part of Coder's complete report, which the verbatim field already carries.
- Nothing in the sources can be edited to settle this without human approval, and nothing in the sources should have to: the names are the published interface of the package, not authored behavior.

## Decision

- Where the selected pipeline supplies the catalog and the compiled source's basename is one of its `literalTargetBindings`, the compiled workflow is held to that builtin's declared output interface: callers compiled against the catalog will address the artifact by that id, so the id reserves the interface.
- `text2gears` reads the catalog as one of its semantic inputs.
  A result property whose value the declared interface returns takes the interface's property name, whether the value is semantic, presentation, or effect-owned — `evaluatedRevision` for the revision a clean review round observes, `baseRevision` for the commit a branch was created from; only the commit a call itself creates keeps its canonical per-call name `latestCommit`, which the FSM projects into the interface's field (`lastCodeCommit`, `decideCommit`) as before.
  A Source placeholder that names such a value otherwise is an inconsistency between the source and the catalog, reported as an incompatible compiler input rather than resolved by renaming.
- `gears2fsm` declares the terminal output of such a workflow as exactly the interface: its variants, `status` constants, property names, and requiredness, derived from typed context.
  Authored outcomes the interface cannot express are the same inconsistency, reported the same way; the definition invents no outcome and renames none.
- A result declares an output property only where some consumer requires it: a later item's placeholder, the workflow's terminal return, or the declared interface.
  A detail the acting agent reports only within its final text travels in the result's verbatim final-text property.
- A source outside the catalog's ids is untouched: its names remain the compiler's judgment from the source's own words, as before.

## Consequences

- A builtin recompiled from its source reproduces the field names its callers and the package's conformance matrices rely on, without a human renaming pass and without editing the source.
- `workflow-contracts.json` enters `text2gears`'s declared semantic-input closure, so a catalog change re-pins that phase as it already re-pins `gears2fsm` and `link`; the phase's compiled bundle is unchanged, its `## Compiled execution` section relaying the definition at run time.
- A user who compiles an unrelated `review.md` or `branch.md` learns at compile time that the id is reserved by the catalog and either renames the source or keeps the interface, instead of shipping a callee that its callers cannot read.
- Judge-authored properties are declared for consumers only, so an adjudicator is never asked to extract a value nothing reads.
