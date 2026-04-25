# Coding

## Roles

- Coder
- Reviewer

## Plan & Implement

### CODE-1

When Boss gives an intent for coding, Captain shall pass the intent to Coder with the prompt:
> Estimate if this can be done in a single commit, following best practices.
> If yes, implement, test, and commit; otherwise, break it into tasks as a new iteration in @specs/iterations (every task should be a commit), and commit the IR.
> Consult @specs/map.md to find relevant if needed.

### CODE-2

When Coder is about to implement an IR task, Captain shall prompt Coder:
> Every task is a commit (including corresponding tests if any).
> Stop after each commit for review.

### CODE-3

When an IR is ready (drafted & reviewed), Captain shall prompt Coder with the IR number:
> Implement IR-<#>.

### CODE-4

When a task of IR is done (review passed), Captain shall prompt Coder with the IR number:
> Continue to implement IR-<#> if not all deliverables and tasks are done.

## Review Code

### CODE-5

When Reviewer is about to review any code change, Captain shall prompt Reviewer:
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> If the change is ready to commit or push, don't raise nitpicks.
> Consult @specs/map.md to find relevant context if needed.

### CODE-6

When any code commit is made but not reviewed, Captain shall prompt Reviewer:
> Review the latest commit.

### CODE-7

When any code changes are made but not reviewed, Captain shall prompt Reviewer:
> Review the latest unstaged/untracked changes.
> Understand the intent.

### CODE-8

When Reviewer has finished code review, Captain shall pass the reviews to Coder with the prompt:
> For each review item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.

### CODE-9

When Coder has challenged any code review, Captain shall pass the challenges to Reviewer with the prompt:
> For each feedback item below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Then review the latest unstaged/untracked changes (if any).

## Commit

### CODE-10

When Coder is about to commit, Captain shall prompt Coder with the player descriptions based on who worked on the changes, e.g.:
> You (Claude Opus 4.7) are Coder; GPT-5.5 is Reviewer.

### CODE-11

When Coder is about to commit, Captain shall prompt Coder:
> Finally, commit the relevant changes that belong in the repo, following @specs/items/dev/git.md format (reread if necessary).
> If relevant, mark progress in the IR.

## Push

### CODE-12

When recent commits accumulate to a milestone or it is the end of an iteration, Captain shall prompt Coder:
> Push and check the CI status and, if any failure, fix it in another commit (no further push), with local verification if possible.
> If the CI log indicates flakiness, rerun any affected CI workflow instead.

### CODE-13

When CI has failed and the fix hasn't passed it, Captain shall prompt Reviewer:
> Check the latest CI failure log if needed.

## Summarize

### CODE-14

When an IR is done and pushed, Captain shall prompt Coder with the IR number and have it commit:
> Read IR-<#> and corresponding commits.
> According to @specs/meta.md, add or update spec items to fully capture:
>
> - the user requirements in @specs/items/user,
> - the system behavior in @specs/items/dev, and
> - the integration/system test cases in @specs/items/test.
>
> The spec items should be the *minimal* set needed to reimplement code without the IR.
> The set should be complete and coherent.
> Avoid implementation specifics.
> Avoid redundant spec items.
> Consult @specs/map.md for relevant context and update it to reflect your changes.

### CODE-15

When Reviewer is about to review any spec change, Captain shall prompt Reviewer with the IR number:
> Review the unstaged/untracked changes. Verify the spec items for IR-<#> are:
>
> - Complete & coherent: sufficient for you to reimplement code without the IR.
> - Right level: user requirements (in @specs/items/user) or behavior (in @specs/items/dev), not implementation specifics; integration/system testing (in @specs/items/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Consult @specs/map.md for relevant context and verify it reflects the changes.
