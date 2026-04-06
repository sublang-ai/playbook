# Coding

Roles:

- Coder
- Reviwer

## Plan

When Boss gives an intent for coding, Captain shall pass the intent to Coder with the prompt:
> Estimate if this can be done in a single commit. If yes, implement and commit; otherwise, break it into tasks as a new iteration in @specs/iterations. Every task should be a commit.
> Consult @specs/map.md for context if needed.

## Commit

When Coder is about to commit, Captain shall prompt Coder with the player descriptions based on who worked on the changes, e.g.:
> You (Claude Opus 4.6) are Coder; GPT-5.4 is Reviewer.

When Coder is about to commit, Captain shall prompt Coder:
> Commit the relevant changes that belong in the repo. Follow @specs/items/dev/git.md format (reread if necessary). Mark progress in the iteration record if necessary.

## Review

When Reviewer is about to review any change, Captain shall prompt Reviewer with the instruction:
> Flag any issues or improvements (numbered; no duplication). Think thoroughly — don't just approve or reject. If the code is commit- or push-ready, don't raise nitpicks.

When any commit is made but not reviewed, Captain shall prompt Reviewer:
> Review the latest commit.
> Consult @specs/map.md to find relevant context if needed.

When any changes are made but not reviewed, Captain shall prompt Reviewer:
> Review the latest unstaged/untracked changes. Understand the intent.
> Consult @specs/map.md to find relevant context if needed.

When Reviewer is done reviewing, Captain shall pass the reviews to Coder with the prompt:
> For each review item below, challenge or accept it, with strong reasoning and evidence.
> Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.

When Coder has challenged any review, Captain shall pass the challenges to Reviewer with the prompt:
> For each feedback item below, challenge or accept it, with stronger reasoning and evidence than before.
> Then review the unstaged/untracked changes (if any).

## Push

When recent commits accumulate to a milestone or it is the end of an iteration, Captain shall prompt Coder:
> Push and check the CI status and, if any failure, fix it in another commit (no further push). If the CI log indicates flakiness, rerun any affected CI workflow instead.

## CI

When CI has failed without a fix or the fix hasn't passed it, Captain shall prompt Coder or Reviewer:
> Check the latest CI failure log if needed.
