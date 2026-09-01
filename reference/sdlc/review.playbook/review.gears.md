<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# REVIEW: Scoped Committed-Work Review Workflow

Roles:

- Coder
- Reviewer

The caller supplies one caller input carrying the original intent, the review scope in the caller's own words, and optional relevant context and run results.
The caller's review scope is the baseline for every round, and each review-fix commit joins that scope as it lands, so every later round reviews the cumulative committed state.
`review` examines committed work only.
Captain takes the evaluated repository revision from repository authority, not from either player's prose: the repository-effect receipt is the authoritative identity of any review-fix commit, and a clean round's `unchanged` receipt proves the observed revision it evaluated.
Finding numbers are references within this review only; no review transition depends on numbering or any fixed presentation format of either player's reply.
Rounds continue until Reviewer affirmatively reports that the requested review is complete and no unsettled findings remain; `review` then returns the exact repository revision at which the review scope was evaluated and the fact that no unsettled findings remain within that scope.

### REVIEW-1

When the caller starts a review, Captain shall relay the complete caller input to Reviewer with the first-round and shared review instructions:

> A new review begins for the review scope.
> Keep to the original intent and follow what it asks.
> When the scope names commits, read each commit message for its context and rationale; otherwise use repository history and commit messages wherever they help establish that context.
>
> > <caller-input>
>
> Understand the full picture and think systematically about the underlying design.
> Continue to identify issues or improvements, if any, without duplication.
> Number the findings consistently across rounds.
> Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.
> For specs, flag stale, missing, over-specified, or under-specified ones, if any.
> Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.
>
> If an issue represents a class of defect, find every instance within the review scope worth fixing rather than surfacing one or two per round, which drags out the review.
> For any rebuttal, accept or challenge it.
> Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.
>
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Do not edit files or commit; report findings only.
>
> Consult @specs/map.md for context if needed; verify it remains accurate.
> Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.

Results:
- `hasFindings`: Reviewer raised one or more unsettled findings. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer affirmatively reported the requested review complete with no unsettled findings remaining; a progress report, status update, or promise of a later result supports no review outcome. Output shall include `evaluatedRevision: <repository revision>`.

### REVIEW-2

When Reviewer raises or keeps any finding, Captain shall relay the caller input and Reviewer's findings to Coder with the disposition prompt:

> > <caller-input>
> > <reviewer-output>
>
> For each review item, accept or reject it.
> Before deciding, understand the full picture and think systematically about the underlying design.
> Keep to the original intent and follow what it asks.
> Reject anything that is not essential or is not worth fixing now.
> If you accept an item, fix its root cause, including any fundamental design flaw — do not patch around it; if it represents a class of defect, find every instance within the review scope worth fixing rather than addressing one or two per round, which drags out the review.
> If you reject an item, give the reasoning and cite code or test output that supports it.
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
>
> If you accept any item, make minimal changes and add one new review-fix commit; never rewrite any existing commit.
> Follow @specs/packages/git.md.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Identify every new commit you make.
> Coder is <coder-llm>; Reviewer is <reviewer-llm>.
>
> If you reject every item, change nothing and make no commit.
> Report every disposition, all relevant run results, and every rebuttal.

Results:
- `committed`: Coder accepted at least one item and added one new review-fix commit. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.
- `rejectedAll`: Coder rejected every item and made no commit. Output shall include `coderOutput: <verbatim final text>`.

### REVIEW-3

When Coder makes a review-fix commit, Captain shall relay the caller input, the review-fix commit, and Coder's feedback to Reviewer with the next-round and shared review instructions:

> A new review round begins for the review scope in the cumulative committed state, with particular attention to the latest review-fix commit.
> Keep to the original intent and follow what it asks.
> Read the latest review-fix commit's message and see Coder's feedback below.
>
> > <caller-input>
> > <latest-commit>
> > <coder-output>
>
> Understand the full picture and think systematically about the underlying design.
> Continue to identify issues or improvements, if any, without duplication.
> Number the findings consistently across rounds.
> Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.
> For specs, flag stale, missing, over-specified, or under-specified ones, if any.
> Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.
>
> If an issue represents a class of defect, find every instance within the review scope worth fixing rather than surfacing one or two per round, which drags out the review.
> For any rebuttal, accept or challenge it.
> Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.
>
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Do not edit files or commit; report findings only.
>
> Consult @specs/map.md for context if needed; verify it remains accurate.
> Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.

Results:
- `hasFindings`: Reviewer raised one or more unsettled findings. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer affirmatively reported the requested review complete with no unsettled findings remaining; a progress report, status update, or promise of a later result supports no review outcome. Output shall include `evaluatedRevision: <repository revision>`.

### REVIEW-4

When Coder rejects every finding and makes no commit, Captain shall relay the caller input and Coder's feedback to Reviewer with the rebuttal and shared review instructions:

> No new commit was made because Coder rejected every finding.
> See Coder's feedback below.
>
> > <caller-input>
> > <coder-output>
>
> Understand the full picture and think systematically about the underlying design.
> Continue to identify issues or improvements, if any, without duplication.
> Number the findings consistently across rounds.
> Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.
> For specs, flag stale, missing, over-specified, or under-specified ones, if any.
> Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.
>
> If an issue represents a class of defect, find every instance within the review scope worth fixing rather than surfacing one or two per round, which drags out the review.
> For any rebuttal, accept or challenge it.
> Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.
>
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Do not edit files or commit; report findings only.
>
> Consult @specs/map.md for context if needed; verify it remains accurate.
> Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.

Results:
- `hasFindings`: Reviewer kept one or more unsettled findings. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer accepted the rebuttals and affirmatively reported the requested review complete with no unsettled findings remaining; a progress report, status update, or promise of a later result supports no review outcome. Output shall include `evaluatedRevision: <repository revision>`.
