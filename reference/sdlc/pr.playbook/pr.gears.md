<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# pr: PR

## Intent

`pr` delivers a reviewed branch into the repository default branch through a GitHub pull request: it publishes the branch, waits for the pull request's checks, has `code` fix red checks no more than once, and merges.
It completes once the pull request is merged, whether or not the local default branch could then be fast-forwarded, and fails where the delivery stops earlier.

Roles:

- Coder

## External Behavior

### pr-8

When a caller starts `pr`, the caller shall supply:

- the original request, including the issue it names, if any;
- the issue summary;
- the branch to deliver and the base revision it was created from;
- the last `code`-owned commit and the exact evaluated repository revision;
- optional relevant context.

### pr-9

When the local update ends [[pr-7](#pr-7)], whether or not it fast-forwarded the local default branch, `pr` shall complete and return:

- the pull request number and URL [[pr-1](#pr-1)];
- the fact that the pull request is merged;
- whether the local default branch was fast-forwarded to the merged head.

### pr-10

When Coder reports that the branch or its pull request was not published [[pr-1](#pr-1)], `pr` shall fail and report Coder's complete result with its reason to its caller.

### pr-11

When `code` returns an authored abort or failure, or a terminal result that does not prove its success [[pr-3](#pr-3)], `pr` shall fail relaying that canonical result and leave the pull request open.

### pr-12

When the nested `code` call [[pr-3](#pr-3)] fails outside its authored result contract, `pr` shall park as failed and retain the control-plane error instead of reporting an authored outcome.

### pr-13

When the fix is not published [[pr-4](#pr-4)], `pr` shall fail with an authored failure that leaves the pull request open.

### pr-14

When the checks are still failing after the published fix [[pr-5](#pr-5)], `pr` shall fail with an authored failure that leaves the pull request open.

### pr-15

When the merge is refused [[pr-6](#pr-6)], `pr` shall fail with an authored failure that leaves the pull request in the state GitHub reports, in each of these cases:

- the checkout no longer infers the published pull request [[pr-28](#pr-28)];
- the pull request targets another branch [[pr-28](#pr-28)];
- GitHub refused the merge for a conflict, a branch protection, a forbidden merge method, or a head that moved;
- the merge may have landed while its confirmation [[pr-29](#pr-29)], the local switch to the default branch, or the branch deletion failed.

### pr-16

`pr` shall report a refused merge [[pr-6](#pr-6)] as an unconfirmed merge rather than as not merged, because a refused merge does not establish that the pull request is unmerged.

### pr-17

`pr` shall claim in no outcome that a branch was deleted, because `gh` skips the remote deletion [[pr-6](#pr-6)] for a pull request from another repository or one already merged and exits zero anyway.

### pr-18

`pr` shall change no files and own no repository commit, the one fix it may request [[pr-3](#pr-3)] being owned by `code`.

### pr-19

`pr` shall keep the repository exact in every outcome of the publication [[pr-1](#pr-1)]: pushing a branch and opening a pull request change neither HEAD's commit nor the working tree.

### pr-20

`pr` shall merge [[pr-6](#pr-6)] by creating a merge commit on the repository default branch, requesting deletion of the remote and local branch, and checking out the local default branch: GitHub closes the linked issue on merge.

## Internal Behavior

### pr-1

When the caller gives its input [[pr-8](#pr-8)], Captain shall relay the complete caller input in quotes (`>`) to Coder, along with the following instruction:

> Publish the branch and open its pull request without changing any file or making any commit.
> Confirm that the working tree is clean and that the checked-out branch is the branch to deliver, not the repository default branch.
> Push the branch to the repository's GitHub remote with its upstream set; never force-push.
> If an open pull request for this branch already exists, use it; otherwise open one against the repository default branch with `gh pr create`.
> Give the pull request a title naming the change and a body with a summary of what changed and why from the base revision to the last commit, the verification the commits report, and a `Closes #N` line for issue number N when the request names one.
> Report the pull request number and URL exactly.
> If the working tree is not clean, the checked-out branch is wrong, the push is rejected, or the pull request cannot be opened, open nothing further and report the failure with its reason.
>
> > Original request: <caller-input>

Results:
- `opened`: Coder's result affirmatively supports that the pull request is open. Output shall include `pullRequest: <exact pull request number as reported>` and `pullRequestUrl: <exact pull request URL as reported>`.
- `notPublished`: Coder's result affirmatively supports that the branch or its pull request was not published; the workflow fails and returns Coder's complete result with its reason to its caller. Output shall include `coderOutput: <verbatim final text>`.

### pr-2

While no fix has been attempted, when the pull request is open [[pr-1](#pr-1)], Captain shall run:

> n=0
> while gh pr checks 2>&1 | grep -q 'no checks reported'; do
> n=$((n + 1))
> [ "$n" -ge 6 ] && exit 0
> sleep 10
> done
> gh pr checks --watch --fail-fast >/dev/null 2>&1

Results:
- `checksPassed`: The command exited with status zero: the checks passed; a pull request whose repository still reports no checks after a brief wait for them to register counts as passed.
- `checksFailed`: The command exited with a nonzero status: the checks failed.

### pr-3

While no fix has been attempted, when the pull request's checks fail [[pr-2](#pr-2)], Captain shall call playbook `code`:

> > Original request: <caller-input>
> > Pull request: <pull-request-url>
> > Coding request: The pull request's checks are red on the checked-out branch. Inspect the failing checks with `gh pr checks` and `gh run view --log-failed`, fix their cause on this branch with a minimal change, and make the checks pass.

### pr-4

When `code` succeeds [[pr-3](#pr-3)], Captain shall run:

> [ "$(gh pr view --json url --jq .url)" = '<pull-request-url>' ] || exit 1
> git push || exit 1
> n=0
> until [ "$(gh pr view --json headRefOid --jq .headRefOid 2>/dev/null)" = "$(git rev-parse HEAD)" ]; do
> n=$((n + 1))
> [ "$n" -ge 12 ] && exit 1
> sleep 5
> done

Results:
- `fixPublished`: The command exited with status zero, once the pull request's head is the pushed commit: the fix is published.
- `fixNotPublished`: The command exited with a nonzero status: the fix is not published, an authored failure of the workflow that leaves the pull request open.

### pr-5

When the fix is published [[pr-4](#pr-4)], Captain shall run:

> n=0
> while gh pr checks 2>&1 | grep -q 'no checks reported'; do
> n=$((n + 1))
> [ "$n" -ge 6 ] && exit 0
> sleep 10
> done
> gh pr checks --watch --fail-fast >/dev/null 2>&1

Results:
- `checksPassed`: The command exited with status zero: the checks passed.
- `checksStillFailing`: The command exited with a nonzero status: the checks are still failing, an authored failure of the workflow that leaves the pull request open; there is no second fix attempt.

### pr-6

When the pull request's checks pass, before any fix attempt [[pr-2](#pr-2)] or after the one published fix [[pr-5](#pr-5)], Captain shall run:

> pr=$(gh pr view --json url --jq .url) || exit 1
> [ "$pr" = '<pull-request-url>' ] || exit 1
> base=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name) || exit 1
> [ -n "$base" ] || exit 1
> [ "$(gh pr view "$pr" --json baseRefName --jq .baseRefName)" = "$base" ] || exit 1
> gh pr merge --merge --delete-branch --match-head-commit "$(git rev-parse HEAD)" || exit 1
> [ "$(gh pr view "$pr" --json state --jq .state)" = MERGED ] || exit 1
> [ "$(git branch --show-current)" = "$base" ]

Results:
- `merged`: The command exited with status zero: the pull request is merged.
- `mergeRefused`: The command exited with a nonzero status: the merge is refused, an authored failure of the workflow that leaves the pull request in the state GitHub reports, because the checkout no longer infers the published pull request, the pull request targets another branch, GitHub refused the merge for a conflict, a branch protection, a forbidden merge method, or a head that moved, or the merge may have landed while its confirmation, the local switch to the default branch, or the branch deletion failed; a refused merge does not establish that the pull request is unmerged, so the workflow reports it as an unconfirmed merge rather than as not merged.

### pr-7

When the pull request is merged [[pr-6](#pr-6)], Captain shall run:

> git pull --ff-only

Results:
- `localDefaultUpdated`: The command exited with status zero: the local default branch is updated; the workflow completes, returning the pull request number and URL, the fact that the pull request is merged, and that the local default branch was fast-forwarded to the merged head.
- `localDefaultNotUpdated`: The command exited with a nonzero status: the local default branch is not updated; the workflow completes, since the pull request is merged either way, returning the pull request number and URL, the fact that the pull request is merged, and that the local default branch was not fast-forwarded to the merged head.

### pr-21

`pr` shall make no more than one fix attempt [[pr-3](#pr-3)].

### pr-22

`pr` shall publish the fix [[pr-4](#pr-4)] and wait for the checks again [[pr-5](#pr-5)] only after `code` succeeds [[pr-3](#pr-3)].

### pr-23

`pr` shall perform the check waits [[pr-2](#pr-2)] [[pr-5](#pr-5)], the fix publication [[pr-4](#pr-4)], the merge [[pr-6](#pr-6)] and the local update [[pr-7](#pr-7)] as mechanical steps, each of which:

- runs exactly its one fixed command in the repository, with no other action;
- has exactly two outcomes, decided by the command's exit status alone, without reading its output;
- reads no conversation and produces no prose.

### pr-24

`pr` shall count a pull request whose repository still reports no checks after a brief wait for them to register [[pr-2](#pr-2)] as passed.

### pr-25

`pr` shall carry one runtime value, the pull request it published [[pr-1](#pr-1)], into the fix publication [[pr-4](#pr-4)] and the merge [[pr-6](#pr-6)], because `gh` infers the pull request from the checked-out branch, which the run does not own.

### pr-26

`pr` shall bind that runtime value [[pr-25](#pr-25)], which is reported text, as a single-quoted shell literal that the command compares as data and never executes as shell syntax.

### pr-27

`pr` shall refuse the fix publication [[pr-4](#pr-4)], pushing nothing, unless the checked-out branch still infers exactly the pull request it published [[pr-25](#pr-25)], so that a checkout that changed while `code` ran publishes to no other branch.

### pr-28

`pr` shall refuse the merge [[pr-6](#pr-6)], before the irreversible merge command runs, unless the checked-out branch still infers exactly the pull request it published [[pr-25](#pr-25)] and that pull request targets the repository default branch.

### pr-29

When the merge command of the merge step [[pr-6](#pr-6)] succeeds, `pr` shall confirm that the pull request it published [[pr-25](#pr-25)] is in the merged state and that the local default branch is checked out: a queued pull request is not a merged result.

### pr-30

`pr` shall select an outcome of the publication [[pr-1](#pr-1)] only on affirmative support in Coder's result, never on a fixed presentation format of Coder's reply.

### pr-31

`pr` shall count the fix as published [[pr-4](#pr-4)] only once the pull request's head is the pushed commit.

## Verification

### pr-32

While Coder has reported the pull request open, its checks have passed on the first wait and the merge has succeeded, when the local update succeeds, a `pr` run shall:

- relay the caller's complete input to Coder once [[pr-1](#pr-1)] [[pr-8](#pr-8)] and call `code` never [[pr-3](#pr-3)];
- change no file, make no commit of its own, and leave HEAD's commit and the working tree as they were through the publication [[pr-18](#pr-18)] [[pr-19](#pr-19)];
- run the check wait, the merge and the local update in that order [[pr-2](#pr-2)] [[pr-6](#pr-6)] [[pr-7](#pr-7)], each as its one fixed command decided by the exit status alone [[pr-23](#pr-23)];
- leave a merge commit on the repository default branch and the local default branch checked out [[pr-20](#pr-20)];
- complete, returning the pull request number and URL, the fact that it is merged, and that the local default branch was fast-forwarded [[pr-9](#pr-9)], with no claim that a branch was deleted [[pr-17](#pr-17)].

### pr-33

A `pr` run shall complete despite each of the following:

| Case | Observable result |
| --- | --- |
| The repository still reports no checks after the brief wait for them to register | The run goes on to the merge as for passed checks [[pr-24](#pr-24)] |
| The local update fails after the pull request is merged | The run completes, returning the pull request number and URL, the fact that it is merged, and that the local default branch was not fast-forwarded [[pr-9](#pr-9)] |

### pr-34

When Coder's result does not affirmatively support that the pull request is open, a `pr` run shall wait for no checks [[pr-2](#pr-2)] and treat that result as follows:

| Case | Observable result |
| --- | --- |
| Coder reports that the branch or its pull request was not published | `pr` fails, reporting Coder's complete result with its reason to its caller [[pr-10](#pr-10)] |
| Coder's reply gives affirmative support to neither outcome of the publication | `pr` selects no outcome from it, whatever its presentation format [[pr-30](#pr-30)] |

### pr-35

While the checks have failed on the first wait and `code` has succeeded, when the checks pass on the second wait, a `pr` run shall:

- call `code` once, with the original request, the pull request and the coding request [[pr-3](#pr-3)] [[pr-21](#pr-21)];
- publish the fix only after `code` succeeds [[pr-4](#pr-4)] [[pr-22](#pr-22)];
- wait for the checks again only once the pull request's head is the pushed commit [[pr-5](#pr-5)] [[pr-31](#pr-31)];
- merge, update the local default branch and complete as for checks that passed on the first wait [[pr-6](#pr-6)] [[pr-7](#pr-7)] [[pr-9](#pr-9)].

### pr-36

When the one fix attempt does not end in passing checks, a `pr` run shall call `code` no second time [[pr-21](#pr-21)] and end as follows:

| Case | Observable result |
| --- | --- |
| `code` returns an authored abort or failure, or a terminal result that does not prove its success | `pr` fails relaying that result, the pull request left open and no fix published [[pr-11](#pr-11)] [[pr-22](#pr-22)] |
| The nested `code` call fails outside its authored result contract | `pr` parks as failed with the control-plane error retained and no authored outcome reported [[pr-12](#pr-12)] |
| The push fails, or the pull request's head does not become the pushed commit | `pr` fails with the pull request left open and waits for no checks again [[pr-13](#pr-13)] [[pr-31](#pr-31)] |
| The checks fail on the second wait | `pr` fails with the pull request left open [[pr-14](#pr-14)] |

### pr-37

A `pr` run shall act in the fix publication and the merge only on the pull request it published, as follows:

| Case | Observable result |
| --- | --- |
| The suspended `code` call left another branch checked out | Nothing is pushed, no other branch is published to, and `pr` fails with the pull request left open [[pr-27](#pr-27)] [[pr-13](#pr-13)] |
| At the merge, the checkout no longer infers the published pull request | No merge is attempted, and `pr` fails as for a refused merge [[pr-28](#pr-28)] [[pr-15](#pr-15)] |
| The published pull request targets a branch other than the repository default branch | No merge is attempted, and `pr` fails as for a refused merge [[pr-28](#pr-28)] [[pr-15](#pr-15)] |
| The reported pull request URL holds shell syntax | The URL reaches both commands as their one runtime value [[pr-25](#pr-25)], compared as data with nothing in it executed [[pr-26](#pr-26)] |

### pr-38

When the merge is refused, a `pr` run shall fail, leaving the pull request in the state GitHub reports [[pr-15](#pr-15)] and reporting an unconfirmed merge rather than a pull request not merged [[pr-16](#pr-16)], in each of these cases:

- GitHub refuses the merge for a conflict, a branch protection, a forbidden merge method, or a head that moved;
- the merge command succeeds while the pull request is only queued [[pr-29](#pr-29)];
- the merge lands but the local default branch is not checked out afterwards [[pr-29](#pr-29)].
