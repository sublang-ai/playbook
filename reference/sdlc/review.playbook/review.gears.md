<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# review: Review

## Intent

`review` has Reviewer examine committed work against the caller's intent and Coder answer each finding, for at most three review rounds, and tells its caller whether any finding remains unsettled.

Roles:

- Coder
- Reviewer

## External Behavior

### review-5

When a caller starts `review`, the caller shall supply:

- the original intent;
- the review scope in the caller's own words;
- optional relevant context and run results.

### review-6

When Reviewer affirmatively reports that the requested review is complete and no unsettled findings remain [[review-1](#review-1)] [[review-3](#review-3)] [[review-4](#review-4)], `review` shall return:

- the exact repository revision at which the review scope was evaluated [[review-11](#review-11)];
- the fact that no unsettled findings remain within that scope.

### review-7

While the current review round is the third [[review-10](#review-10)], when Reviewer raises or keeps any finding [[review-3](#review-3)] [[review-4](#review-4)], `review` shall end with those findings unsettled, asking Coder for no further disposition, and return:

- Reviewer's findings;
- the fact that unsettled findings remain within that scope.

### review-8

`review` shall examine committed work only.

### review-9

`review` shall review in every round the cumulative committed state: the caller's review scope [[review-5](#review-5)] as the baseline, joined by each review-fix commit as it lands [[review-2](#review-2)].

## Internal Behavior

### review-1

When the caller starts a review with its input [[review-5](#review-5)], Captain shall prompt Reviewer:

> A new review begins for the review scope.
> Keep to the original intent and follow what it asks.
> When the scope names commits, read each commit message for its context and rationale; otherwise use repository history and commit messages wherever they help establish that context.
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
>
> > Original request: <caller-input>

Results:
- `hasFindings`: Reviewer raised one or more unsettled findings; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer affirmatively reported that the requested review is complete and no unsettled findings remain; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. On this outcome the workflow returns the exact repository revision at which the review scope was evaluated, taken from repository authority and not from either player's prose, as evaluatedRevision, and the fact that no unsettled findings remain within that scope, as noUnsettledFindings true. Output shall include `evaluatedRevision: <repository revision>`.

### review-2

While the current review round is the first or the second [[review-10](#review-10)], when Reviewer raises or keeps any finding [[review-1](#review-1)] [[review-3](#review-3)] [[review-4](#review-4)], Captain shall prompt Coder:

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
> Credit every AI that contributed to this commit: Coder <coder-llm> and Reviewer <reviewer-llm>, whose findings it answers.
>
> If you reject every item, change nothing and make no commit.
> Report every disposition, all relevant run results, and every rebuttal.
>
> > Original request: <caller-input>
> > Reviewer findings: <reviewer-output>

Results:
- `committed`: Coder made one new review-fix commit; the outcome does not depend on finding numbering or any fixed presentation format of Coder's reply. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.
- `rejectedAll`: Coder rejected every finding, changed nothing, and made no commit; the outcome does not depend on finding numbering or any fixed presentation format of Coder's reply. Output shall include `coderOutput: <verbatim final text>`.

### review-3

When Coder makes a new review-fix commit [[review-2](#review-2)], Captain shall prompt Reviewer:

> A new review round begins for the review scope in the cumulative committed state, with particular attention to the latest review-fix commit.
> Keep to the original intent and follow what it asks.
> Read the latest review-fix commit's message and see Coder's feedback below.
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
>
> > Original request: <caller-input>
> > Latest commit: <latest-commit>
> > Coder output: <coder-output>

Results:
- `hasFindings`: Reviewer raised or kept one or more unsettled findings; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer affirmatively reported that the requested review is complete and no unsettled findings remain; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. On this outcome the workflow returns the exact repository revision at which the review scope was evaluated, taken from repository authority and not from either player's prose, as evaluatedRevision, and the fact that no unsettled findings remain within that scope, as noUnsettledFindings true. Output shall include `evaluatedRevision: <repository revision>`.

### review-4

When Coder rejects every finding and makes no commit [[review-2](#review-2)], Captain shall prompt Reviewer:

> No new commit was made because Coder rejected every finding.
> See Coder's feedback below.
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
>
> > Original request: <caller-input>
> > Coder output: <coder-output>

Results:
- `hasFindings`: Reviewer raised or kept one or more unsettled findings; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer affirmatively reported that the requested review is complete and no unsettled findings remain; a progress report, status update, or promise of a later result supports no review outcome, and the outcome does not depend on finding numbering or any fixed presentation format of Reviewer's reply. On this outcome the workflow returns the exact repository revision at which the review scope was evaluated, taken from repository authority and not from either player's prose, as evaluatedRevision, and the fact that no unsettled findings remain within that scope, as noUnsettledFindings true. Output shall include `evaluatedRevision: <repository revision>`.

### review-10

`review` shall continue through at most three review rounds: the first review [[review-1](#review-1)] and one further round after each of at most two Coder dispositions [[review-3](#review-3)] [[review-4](#review-4)].

### review-11

`review` shall take the evaluated repository revision from repository authority, not from either player's prose.

### review-12

`review` shall use the repository-effect receipt as the authoritative identity of any review-fix commit [[review-2](#review-2)].

### review-13

`review` shall treat a progress report, status update, or promise of a later result as supporting no review outcome [[review-1](#review-1)] [[review-2](#review-2)] [[review-3](#review-3)] [[review-4](#review-4)].

### review-20

`review` shall let what follows either player's reply depend on no numbering or fixed presentation format of that reply [[review-1](#review-1)] [[review-2](#review-2)] [[review-3](#review-3)] [[review-4](#review-4)]: finding numbers are references within this review only.

### review-14

Reviewer shall read the context information [[review-1](#review-1)] [[review-3](#review-3)] [[review-4](#review-4)] and follow the corresponding instructions.

## Verification

### review-15

While the current review round is the first, when Reviewer reports that the review is complete with no unsettled findings, a `review` run shall:

- prompt Reviewer once with the caller's input relayed [[review-1](#review-1)] [[review-5](#review-5)] [[review-14](#review-14)] and prompt Coder never;
- return the evaluated revision taken from repository authority and the fact that no unsettled findings remain [[review-6](#review-6)] [[review-11](#review-11)].

### review-16

While Reviewer has raised a finding and Coder has answered it with one review-fix commit, when Reviewer reports no unsettled findings, a `review` run shall:

- prompt Coder with Reviewer's findings [[review-2](#review-2)];
- identify the new commit from the repository-effect receipt [[review-12](#review-12)];
- prompt Reviewer again with that commit and Coder's output, over the cumulative committed state [[review-3](#review-3)] [[review-8](#review-8)] [[review-9](#review-9)];
- return the evaluated repository revision and the fact that no unsettled findings remain [[review-6](#review-6)].

### review-17

While Reviewer has raised a finding, when Coder rejects every finding and makes no commit, a `review` run shall prompt Reviewer again with Coder's output and no latest commit [[review-4](#review-4)].

### review-18

While Reviewer has raised or kept a finding in each of the first two rounds, when Reviewer raises or keeps a finding in the third round, a `review` run shall:

- prompt Reviewer three times and Coder twice [[review-2](#review-2)] [[review-10](#review-10)];
- end after the third round with the findings unsettled and return Reviewer's findings [[review-7](#review-7)].

### review-19

When a player replies, a `review` run shall treat the reply as follows:

- a reply that is a progress report, a status update, or a promise of a later result supports no review outcome [[review-13](#review-13)];
- replies that differ only in finding numbering or presentation format lead to the same next step [[review-20](#review-20)].
