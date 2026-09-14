<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PR: Pull-Request Delivery Workflow

Roles:

- Coder

The caller supplies the original request including the issue it names, if any; the issue summary; the branch to deliver and the base revision it was created from; the last `code`-owned commit and the exact evaluated repository revision; and optional relevant context.
`pr` delivers a reviewed branch into the repository default branch through a GitHub pull request: it publishes the branch, waits for the pull request's checks, fixes red checks through playbook `code` no more than once, and merges.
It changes no files and owns no repository commit; the one fix it may request is owned by `code`.
The check waits, the fix publication, the merge, and the local update are mechanical steps: each runs one fixed command whose exit status alone decides its two outcomes, reads no conversation, and produces no prose.
`gh` infers the pull request from the checked-out branch, which the run does not own: the nested `code` call suspends across Boss turns, so the checkout can change before the fix is published or the merge runs.
The two steps that act on the pull request itself therefore carry one runtime value — the pull request `pr` published — and refuse unless the checkout still infers exactly it.

## Coder

### PR-1

When the caller gives its input, Captain shall relay the complete caller input in quotes (`>`) to Coder, along with the following instruction:

> > Original request: <caller-input>
>
> Publish the branch and open its pull request without changing any file or making any commit.
> Confirm that the working tree is clean and that the checked-out branch is the branch to deliver, not the repository default branch.
> Push the branch to the repository's GitHub remote with its upstream set; never force-push.
> If an open pull request for this branch already exists, use it; otherwise open one against the repository default branch with `gh pr create`.
> Give the pull request a title naming the change and a body with a summary of what changed and why from the base revision to the last commit, the verification the commits report, and a `Closes #N` line for issue number N when the request names one.
> Report the pull request number and URL exactly.
> If the working tree is not clean, the checked-out branch is wrong, the push is rejected, or the pull request cannot be opened, open nothing further and report the failure with its reason.

Results:
- `opened`: Coder pushed the branch with its upstream set and reported the open pull request for it. Output shall include `pullRequest: <pull request number>` and `pullRequestUrl: <pull request URL>`.
- `notPublished`: Coder reported that the branch could not be published or its pull request could not be opened, with the reason. Output shall include `coderOutput: <verbatim final text>`.

Workflow outcomes:
- The result has two semantic outcomes: opened and not published.
- Each outcome requires affirmative support in Coder's result, and no outcome depends on a fixed presentation format of Coder's reply.
- Every outcome keeps the repository exact: pushing a branch and opening a pull request change neither HEAD's commit nor the working tree.
- For not published, `pr` fails and reports Coder's complete result with its reason to its caller.

## Checks, the one fix, and the merge

### PR-2

When the pull request is open and no fix has been attempted, Captain shall run:

> n=0
> while gh pr checks 2>&1 | grep -q 'no checks reported'; do
> n=$((n + 1))
> [ "$n" -ge 6 ] && exit 0
> sleep 10
> done
> gh pr checks --watch --fail-fast >/dev/null 2>&1

Results:
- `checksPassed`: The command exited with status zero: the pull request's checks passed, or the repository still reported no checks after a brief wait for them to register.
- `checksFailed`: The command exited with a nonzero status: the pull request's checks failed.

Workflow outcomes:
- The wait has exactly two outcomes decided by the command's exit status alone: checks passed on status zero and checks failed otherwise.
- A pull request whose repository still reports no checks after a brief wait for them to register counts as passed.
- Checks passed continues with the merge; checks failed continues with the one `code` fix attempt.

### PR-3

When the checks fail before any fix attempt, Captain shall call playbook `code`:

> > Original request: <caller-input>
> > Pull request: <pull-request-url>
> > Coding request: The pull request's checks are red on the checked-out branch. Inspect the failing checks with `gh pr checks` and `gh run view --log-failed`, fix their cause on this branch with a minimal change, and make the checks pass.

Workflow outcomes:
- `pr` makes no more than one fix attempt.
- Only after `code` succeeds does `pr` publish the fix and wait for the checks again.
- An authored `code` abort or failure, or a terminal `code` result that does not prove its success, terminates `pr` with that canonical result relayed and the pull request left open.
- Any other nested-call error parks `pr` as failed and retains the control-plane error.

### PR-4

When `code` succeeds, Captain shall run:

> [ "$(gh pr view --json url --jq .url)" = "<pull-request-url>" ] || exit 1
> git push || exit 1
> n=0
> until [ "$(gh pr view --json headRefOid --jq .headRefOid 2>/dev/null)" = "$(git rev-parse HEAD)" ]; do
> n=$((n + 1))
> [ "$n" -ge 12 ] && exit 1
> sleep 5
> done

Results:
- `fixPublished`: The command exited with status zero: the fix is pushed and the pull request's head is the pushed commit.
- `fixNotPublished`: The command exited with a nonzero status: the checkout no longer infers the published pull request, the push was rejected, or the pull request's head did not advance to the pushed commit.

Workflow outcomes:
- The publication has exactly two outcomes decided by the exit status alone: fix published on status zero, once the pull request's head is the pushed commit, and fix not published otherwise.
- The command pushes nothing until the checked-out branch infers the pull request `pr` published, so a checkout that changed while `code` ran publishes to no other branch.
- Fix not published is an authored failure that leaves the pull request open.

### PR-5

When the fix is published, Captain shall run:

> n=0
> while gh pr checks 2>&1 | grep -q 'no checks reported'; do
> n=$((n + 1))
> [ "$n" -ge 6 ] && exit 0
> sleep 10
> done
> gh pr checks --watch --fail-fast >/dev/null 2>&1

Results:
- `checksPassed`: The command exited with status zero: the pull request's checks passed after the fix, or the repository still reported no checks after a brief wait for them to register.
- `checksStillFailing`: The command exited with a nonzero status: the pull request's checks are still failing after the one fix attempt.

Workflow outcomes:
- This wait has exactly two outcomes decided by the exit status alone: checks passed on status zero and checks still failing otherwise.
- Checks still failing is an authored failure that leaves the pull request open; there is no second fix attempt.

### PR-6

When the checks pass, before or after the one fix attempt, Captain shall run:

> pr=$(gh pr view --json url --jq .url) || exit 1
> [ "$pr" = "<pull-request-url>" ] || exit 1
> base=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name) || exit 1
> [ -n "$base" ] || exit 1
> [ "$(gh pr view "$pr" --json baseRefName --jq .baseRefName)" = "$base" ] || exit 1
> gh pr merge --merge --delete-branch --match-head-commit "$(git rev-parse HEAD)" || exit 1
> [ "$(gh pr view "$pr" --json state --jq .state)" = MERGED ] || exit 1
> [ "$(git branch --show-current)" = "$base" ]

Results:
- `merged`: The command exited with status zero: the pull request targeted the repository default branch and is merged into it with a merge commit, deletion of the remote and local branch was requested, and the local default branch is checked out.
- `mergeRefused`: The command exited with a nonzero status: the checkout no longer infers the published pull request, the pull request does not target the repository default branch, GitHub refused the merge, its merged state could not be confirmed, or the local switch to the default branch or the branch deletion failed.

Workflow outcomes:
- The merge creates a merge commit on the repository default branch, requests deletion of the remote and local branch, and checks out the local default branch; GitHub closes the linked issue on merge.
- The merge has exactly two outcomes decided by the exit status alone: merged on status zero and merge refused otherwise.
- The command requires the inferred pull request to be the one `pr` published and to target the repository default branch before the irreversible merge, and confirms that same pull request's merged state and the default-branch checkout after the merge command succeeds; a queued pull request is not a merged result.
- Merge refused is an authored failure that leaves the pull request in the state GitHub reports: the checkout no longer infers the published pull request, the pull request targets another branch, GitHub refused the merge for a conflict, a branch protection, a forbidden merge method, or a head that moved, or the merge may have landed while its confirmation, the local switch to the default branch, or the branch deletion failed.
- A refused merge does not establish that the pull request is unmerged, so `pr` reports it as an unconfirmed merge rather than as not merged, and no outcome claims a branch was deleted, because `gh` skips the remote deletion for a pull request from another repository or one already merged and exits zero anyway.

### PR-7

When the pull request is merged, Captain shall run:

> git pull --ff-only

Results:
- `localDefaultUpdated`: The command exited with status zero: the local default branch is fast-forwarded to the merged head.
- `localDefaultNotUpdated`: The command exited with a nonzero status: the local default branch was not fast-forwarded to the merged head.

Workflow outcomes:
- The update has exactly two outcomes decided by the exit status alone: local default updated on status zero and local default not updated otherwise.
- Both complete `pr`: the pull request is merged either way, and the result states whether the local default branch was fast-forwarded to the merged head.
- On completion, `pr` returns the pull request number and URL, the fact that the pull request is merged, and whether the local default branch was fast-forwarded to the merged head.

## Optimizations

- PR-2: captain → script
- PR-4: captain → script
- PR-5: captain → script
- PR-6: captain → script
- PR-7: captain → script
