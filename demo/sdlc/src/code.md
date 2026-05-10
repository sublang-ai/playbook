<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Code

Players:

- Coder
- Reviewer
- Committer = Coder | Reviewer

## Coder

When Boss gives a coding intent, Captain shall relay it to Coder along with the following prompt:
> Assess whether this can be completed in a single commit, following best practices.
> If yes, implement and test, updating both code and specs; otherwise, decompose into tasks as a new IR under @specs/iterations.
> Consult @specs/map.md for relevant context if needed; ensure it reflects the changes.
> Do not commit.
The resulting changes are regarded as Initial Changes.

When Reviewer raises any findings, Captain shall relay them to Coder along with the following prompt:
> For each review item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.

When a new IR or IR task passes review and is committed, Captain shall prompt Coder:
> Continue to implement IR-<#> if not all deliverables and tasks are done.
> Implement one task at a time (including corresponding tests if any).
> Stop after each task for review — do not commit yet.
> If relevant, mark progress in the IR.
The resulting changes are regarded as Initial Changes.

When an IR is done, Captain shall prompt Coder:
> Read IR-<#> and corresponding commits.
> According to @specs/meta.md, add or update spec items to fully capture:
>
> - the user requirements in @specs/user,
> - the system behavior in @specs/dev, and
> - the integration/system test cases in @specs/test.
>
> The spec items should be the *minimal* set needed to reimplement code without the IR.
> The set should be complete and coherent.
> Avoid implementation specifics.
> Avoid redundant spec items.
> Consult @specs/map.md for relevant context and update it to reflect your changes.

## Reviewer

For each finding in a review round, Coder either addresses it with changes or challenges it with a rebuttal.
Rounds continue until Reviewer raises no findings.

When Reviewer begins the first review round on changes from a Boss coding intent, Captain shall relay the intent to Reviewer.

When Reviewer begins the first review round on changes from an IR task, Captain shall relay the IR's task description to Reviewer.

When Committer commits Initial Changes, Captain shall prompt Reviewer to begin a review round:
> Review the latest commit.
> Refer to the commit message.

When any changes are made by Coder but not reviewed (outside of any Initial Changes), Captain shall prompt Reviewer to begin a review round:
> Review the unstaged/untracked changes.
> Understand the intent.

When Reviewer begins a review round involving @specs/user/, @specs/dev/, or @specs/test/, Captain shall prompt Reviewer:
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
>
> Flag anything missing, redundant, over-specified, or under-specified.

When Reviewer begins a review round involving any changes outside @specs/user/, @specs/dev/, and @specs/test/, Captain shall prompt Reviewer:
> For code or spec changes, flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.

When Reviewer begins any review round, Captain shall prompt Reviewer:
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

When Coder raises any rebuttals, Captain shall relay them to Reviewer along with the following prompt:
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.

## Committer

When Coder makes any Initial Changes or Reviewer raises no findings on uncommitted changes, Captain shall prompt Committer:
> Commit the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).

When Captain prompts Committer, Captain shall also append the player identities to that prompt (which LLM played each role since last commit):
> Coder is Claude Opus 4.7; Reviewer is GPT-5.5.
