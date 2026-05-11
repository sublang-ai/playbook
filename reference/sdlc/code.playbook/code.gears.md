<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODE: Coding Workflow

Players:

- Coder
- Reviewer
- Committer = Coder | Reviewer

## Coder

### CODE-1

When Boss gives a coding intent, Captain shall relay it to Coder along with the following prompt:
> Assess whether this can be completed in a single commit, following best practices.
> If yes, implement and test, updating both code and specs; otherwise, decompose into tasks as a new IR under @specs/iterations.
> Consult @specs/map.md for relevant context if needed; ensure it reflects the changes.
> Do not commit.

The resulting changes are Initial Changes.

### CODE-2

When Reviewer raises any findings, Captain shall relay them to Coder along with the following prompt:
> For each review item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.

### CODE-3

When a new IR or IR task passes review and is committed, Captain shall prompt Coder:
> Continue to implement IR-<#> if not all deliverables and tasks are done.
> Implement one task at a time (including corresponding tests if any).
> Stop after each task for review — do not commit yet.
> If relevant, mark progress in the IR.

The resulting changes are Initial Changes.

### CODE-4

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

### CODE-5

When Committer commits Initial Changes from a Boss coding intent involving changes only in @specs/user/, @specs/dev/, or @specs/test/, Captain shall relay the Boss's coding intent to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-6

When Committer commits Initial Changes from a Boss coding intent involving changes only outside @specs/user/, @specs/dev/, and @specs/test/, Captain shall relay the Boss's coding intent to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-7

When Committer commits Initial Changes from a Boss coding intent involving changes both in and outside @specs/user/, @specs/dev/, and @specs/test/, Captain shall relay the Boss's coding intent to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-8

When Committer commits Initial Changes from an IR task involving changes only in @specs/user/, @specs/dev/, or @specs/test/, Captain shall relay the IR's task description to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-9

When Committer commits Initial Changes from an IR task involving changes only outside @specs/user/, @specs/dev/, and @specs/test/, Captain shall relay the IR's task description to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-10

When Committer commits Initial Changes from an IR task involving changes both in and outside @specs/user/, @specs/dev/, and @specs/test/, Captain shall relay the IR's task description to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-11

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes only in @specs/user/, @specs/dev/, or @specs/test/, Captain shall prompt Reviewer to begin a review round:
> Review the unstaged/untracked changes.
> Understand the intent.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-12

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes only outside @specs/user/, @specs/dev/, and @specs/test/, Captain shall prompt Reviewer to begin a review round:
> Review the unstaged/untracked changes.
> Understand the intent.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-13

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes both in and outside @specs/user/, @specs/dev/, and @specs/test/, Captain shall prompt Reviewer to begin a review round:
> Review the unstaged/untracked changes.
> Understand the intent.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Consult @specs/map.md for relevant context if needed; verify it reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.

### CODE-14

When Coder raises any rebuttals, Captain shall relay them to Reviewer along with the following prompt:
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.

## Committer

### CODE-15

When Coder makes any Initial Changes and Reviewer has not played since the last commit, Captain shall prompt Committer:
> Commit the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).
> Coder is <coder-llm>.

### CODE-16

When Reviewer raises no findings on uncommitted changes and Coder has not played since the last commit, Captain shall prompt Committer:
> Commit the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).
> Reviewer is <reviewer-llm>.

### CODE-17

When Coder makes any Initial Changes and Reviewer has played since the last commit, or Reviewer raises no findings on uncommitted changes and Coder has played since the last commit, Captain shall prompt Committer:
> Commit the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).
> Coder is <coder-llm>; Reviewer is <reviewer-llm>.
