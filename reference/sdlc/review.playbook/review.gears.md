<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# REVIEW: Commit Review Workflow

Players:

- Coder
- Reviewer

### REVIEW-1

When the caller starts a review, Captain shall relay the complete caller input to Reviewer with the first-round and shared review instructions:

> A new review begins on the latest commit.
> Review the latest commit and resulting repository state; read the commit message first for its intent, scope, and rationale.
>
> > <caller-input>
>
> Understand the full picture and think systematically about the underlying design.
> Continue to identify issues or improvements, if any (numbered; no duplication).
> For any rebuttal, accept or challenge it.
> Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.
> Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.
> For specs, flag stale, missing, over-specified, or under-specified ones.
> Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.
>
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Do not edit files or commit; report findings only.
>
> Consult @specs/map.md for context if needed; verify it remains accurate.
> Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.

Results:
- `hasFindings`: Reviewer raised one or more unsettled findings. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer raised no unsettled findings.

### REVIEW-2

When Reviewer raises or keeps any finding, Captain shall relay Reviewer's output to Coder with the disposition instruction:

> > <reviewer-output>
>
> For each review item, accept or reject it.
> Before deciding, understand the full picture and think systematically about the underlying design.
> Reject anything that is not essential or is not worth fixing now.
> If you accept an item, fix its root cause, including any fundamental design flaw - do not patch around it.
> If you reject an item, give the reasoning and cite code or test output that supports it.
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
>
> If you accept any item, make minimal changes and commit them as one new commit; never amend the reviewed commit.
> Follow @specs/packages/git.md.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Coder is <coder-llm>; Reviewer is <reviewer-llm>; format model tokens in conventional human form.
>
> If you reject every item, change nothing and make no commit.
> Report every disposition, all relevant run results, and every rebuttal.

Results:
- `committed`: Coder accepted at least one item and made one new commit. Output shall include `coderOutput: <verbatim final text>`.
- `rejectedAll`: Coder rejected every item and made no commit. Output shall include `coderOutput: <verbatim final text>`.

### REVIEW-3

When Coder makes a review-fix commit, Captain shall relay Coder's output to Reviewer with the next-round and shared review instructions:

> Review the latest commit and resulting repository state; read the commit message first for its intent, scope, and rationale.
>
> > <coder-output>
>
> Understand the full picture and think systematically about the underlying design.
> Continue to identify issues or improvements, if any (numbered; no duplication).
> For any rebuttal, accept or challenge it.
> Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.
> Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.
> For specs, flag stale, missing, over-specified, or under-specified ones.
> Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.
>
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Do not edit files or commit; report findings only.
>
> Consult @specs/map.md for context if needed; verify it remains accurate.
> Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.

Results:
- `hasFindings`: Reviewer raised one or more unsettled findings. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer raised no unsettled findings.

### REVIEW-4

When Coder rejects every finding and makes no commit, Captain shall relay Coder's output to Reviewer with the rebuttal and shared review instructions:

> No new commit was made because Coder rejected every finding.
>
> > <coder-output>
>
> Understand the full picture and think systematically about the underlying design.
> Continue to identify issues or improvements, if any (numbered; no duplication).
> For any rebuttal, accept or challenge it.
> Treat as settled, and do not raise again, any finding in this review rejected twice with reasoning.
> Flag only what materially affects correctness, behavior, or spec quality — not style, equally valid alternatives, or theoretical threats.
> For specs, flag stale, missing, over-specified, or under-specified ones.
> Avoid unnecessary complexity in code or tests, but flag any fundamental design flaw when leaving it would cost more in later patches than fixing it now.
>
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Do not edit files or commit; report findings only.
>
> Consult @specs/map.md for context if needed; verify it remains accurate.
> Consult @specs/meta.md for spec requirements if needed; verify affected specs follow it.

Results:
- `hasFindings`: Reviewer kept one or more unsettled findings. Output shall include `reviewerOutput: <verbatim final text>`.
- `noFindings`: Reviewer accepted the rebuttals and no unsettled findings remain.
