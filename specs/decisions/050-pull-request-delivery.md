<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-050: Pull-Request Delivery Through BRANCH and PR

## Status

Accepted.
Amends [DR-044](044-dev-planning-workflow.md): DEV's planning result gains the `code via pull request` and `decide then code via pull request` outcomes, and on those outcomes DEV calls `branch` before, and `pr` after, its existing `code` or `decide`-then-`code` path.
Amends [DR-009](009-generic-playbook-cli-and-registry.md) §6 as extended by DR-044: the starter config also enables BRANCH and PR, binding both `coder` roles to the seeded `dev.coder` player.

## Context

- DEV, CODE, and DECIDE commit on whatever branch is checked out; a development request that names a GitHub issue, or asks for a pull request, has no path that ends in a merged pull request with the issue closed, so Boss performs the branch, push, pull request, check wait, and merge by hand around the run.
- That delivery is work of two kinds: judgment-bearing steps — reading an issue and its comments, naming a branch, writing a pull-request description, fixing red checks — and mechanical steps — waiting for checks, pushing a fix, merging, fast-forwarding — that one fixed `gh` or `git` command performs completely, because `gh` infers the pull request from the checked-out branch.
- The maintained pipeline already owns every needed capability: `unchanged` governance proves a call left HEAD and the worktree exact ([DR-040](040-outcome-authority-effect-reconciliation.md)), an `unchanged` arm can return the receipt's observed HEAD as an effect-owned field ([DR-045](045-unchanged-receipt-revision-authority.md)), every final state is typed so a caller learns a child's failure through its error path ([DR-048](048-typed-terminal-outcomes.md)), and the optimize pass turns a static-command item into an agent-free `script` state ([DR-016](016-script-actors-and-optimize-pass.md)).
- Scripts carry no placeholder and their output never enters context, so no mechanical step may need the issue or pull-request number, and nothing a script learns — the merge commit in particular — can become an output field.
- Each way Git or GitHub can refuse — a dirty tree, an unauthenticated `gh`, an unreadable issue, a branch-name collision, a rejected push, absent or late-registering checks, red checks, a conflict, branch protection, a forbidden merge method — needs an authored outcome rather than a guess.

## Decision

BRANCH and PR join CODE, REVIEW, DECIDE, and DEV as maintained workflows compiled from `reference/sdlc/branch.md` and `reference/sdlc/pr.md` into `reference/sdlc/branch.playbook` and `reference/sdlc/pr.playbook` under artifact schema 3 and the shared flat runtime factory, and DEV composes them.

- Each declares exactly one local role, `Coder`, and no concurrent role set; each owns no repository commit and changes no files.
- BRANCH is one governed Coder call (`BRANCH-1`): read the named issue and its comments, require a clean tree and an authenticated `gh`, and create and check out `issue-N-short-kebab-slug` — or a request slug — at the current commit.
  Every arm, including the Boss question for an ambiguous request, declares `unchanged`, because a new branch at the current commit changes neither HEAD's OID nor the worktree projection.
  Its success output is `branch` and `issueSummary` as semantic fields and `baseRevision` as an effect-owned field injected from the `unchanged` receipt's observed HEAD, never from prose.
  A dirty tree, an unauthenticated `gh`, an unreadable issue, or a name collision is the single authored `refused` failure terminal carrying Coder's report; the reason is presentation rather than a typed enum because no caller branches on it.
- PR's one governed Coder call (`PR-1`) confirms the checked-out branch, pushes it with upstream and never by force, opens — or reuses — the pull request against the default branch with a summary, verification notes, and `Closes #N` [[3]], and reports `pullRequest` and `pullRequestUrl` as semantic fields; every arm declares `unchanged`.
- PR's remaining steps are mechanical and are authored as direct-Captain items whose prompt is exactly one static, placeholder-free POSIX command: wait for checks (`PR-2`), publish the fix (`PR-4`), wait again (`PR-5`), merge (`PR-6`), and fast-forward the local default branch (`PR-7`).
  The maintained PR artifact is compiled with the optimize pass, so those five items are `script` states with no agent call, no adjudication, and no governance boundary; conformance fails a maintained PR artifact whose GEARS `## Optimizations` section does not list exactly those five items as `captain → script` or whose FSM invokes any other actor for them.
  An unoptimized compile is a valid GEARS package whose mechanical steps run through the host Captain's own tools — the tool restriction is source-owned and applies only to a routing-only Captain — but it is not a release form.
- The check wait polls `gh pr checks` while it reports no checks, for about a minute, so checks registering after creation or after a push are not mistaken for absence; a pull request whose repository still reports no checks then counts as passed, and otherwise `gh pr checks --watch --fail-fast` decides [[1]].
  The fix publication pushes and then waits until the pull request's head equals the local HEAD [[4]], so a check result for the previous head is never watched.
  The merge captures the inferred pull-request URL and repository default branch, runs `gh pr merge --merge --delete-branch --match-head-commit "$(git rev-parse HEAD)"` [[2]], then requires that same pull request to report `MERGED` and the checkout to name the default branch before reporting success.
  An already queued pull request can make `gh pr merge` exit zero without merging, so command success alone is insufficient; an unconfirmed merge or checkout takes the existing merge-refused outcome without a local pull.
- Red checks call playbook `code` exactly once (`PR-3`) with a coding request, so the fix commit and its review are owned by `code` and `review`; the bound is structural — a second wait item whose failure is terminal — not a runtime counter.
- PR's terminals are typed per [DR-048](048-typed-terminal-outcomes.md): success `merged` and `mergedLocalBehind`, distinguished by `localDefaultUpdated`, because the pull request is merged either way and only the local checkout differs; failure `notPublished`, `fixFailed` (relaying `code`'s canonical result), `fixNotPublished`, `checksStillFailing`, and `mergeRefused`, each leaving the pull request in the state GitHub reports.
  PR returns no merge-commit identity: only a script observes the merge, script output never enters context, and no governed call follows it, so the field is omitted rather than fabricated.
- DEV's planning prompt gains one instruction: a request naming a GitHub issue or asking for pull-request delivery reads the issue and its comments during planning — still `unchanged`-governed — and selects `code via pull request` or `decide then code via pull request`; the planning result has six semantic outcomes.
  On either outcome DEV calls `branch` (`DEV-5`) before its existing path and `pr` (`DEV-6`) after `code` succeeds, consuming `branch`, `baseRevision`, `issueSummary`, `lastCodeCommit`, and `finalEvaluatedRevision` only from canonical child outputs.
  `DEV-1` through `DEV-4` keep their ids and prompts; the pull-request path enters `DEV-2` and `DEV-3` through a typed routing field, DEV's three final states are unchanged, and a plain request compiles to the same prompts, edges, and composed child inputs as before.
- The starter config enables `branch` and `pr` from their public registries and binds both `coder` roles to the existing `dev.coder` player; no player is added.
  Equal ids deliberately share one provider conversation ([DR-032](032-explicit-roles-session-players.md)): the Coder that read the issue and named the branch is the one that makes the commits in CODE and REVIEW and then describes them in the pull request, while `dev.analyst` stays distinct as [DR-044](044-dev-planning-workflow.md) requires.
- The host surface adopts both completely: public `./branch/*` and `./pr/*` subpaths, packaged artifact files, `/branch` and `/pr` commands, and an authenticated `gh` for the repository's GitHub remote as a documented prerequisite of BRANCH, PR, and issue-aware DEV planning.

Considered and rejected:

- Delegating the mechanical steps to Coder: before optimization they would be governed player calls, and the merge moves HEAD to the default branch, which fits neither exact disposition.
- Relaying the branch and issue summary into the `code` and `decide` calls: the branch is already checked out and the planning result carries the Analyst's reading, while the relay would change `DEV-2` through `DEV-4` and rely on empty-relay omission on the plain path.
- Requiring the current commit to be the fetched default-branch head before branching: the base is the current commit by decision, and a stale base surfaces as `mergeRefused` with the pull request open.
- One check-wait item routed by a fix counter: the unrolled pair compiles to the same edges without a context counter.

## Consequences

- `/dev` on a request such as "fix #12" ends with a merged pull request and a closed issue when checks and branch protection allow it, and with a named typed failure and an open pull request when they do not; every other `/dev` request behaves exactly as before.
- BRANCH and PR are usable directly through their commands; a rerun of `/pr` on a branch that already has an open pull request reuses it, while a rerun of `/dev` on the same issue refuses at `branch` until the stale branch is removed.
- The conformance, registry, CLI, and release specs extend their maintained-workflow sets to six: playbook item sets `BRANCH-1`, `PR-1` through `PR-7`, and `DEV-1` through `DEV-6`; the starter-config lineup and seeding checks; the CLI documentation of Boss turns and repository-effect reconciliation; and a conformance test that the maintained PR artifact's five mechanical items are script states, which makes the optimize pass part of the maintained compile for the first time.
- A check wait runs under the turn's abort signal with no authored timeout: a long pipeline holds the Boss turn, and a Boss interrupt kills the script and leaves the pull request open for a later `/pr`.
- A repository without checks merges on the strength of CODE's nested review alone; one that forbids merge commits or requires a review ends at `mergeRefused`, and one that uses a merge queue may report a queued merge as refused, until the source is revised.
- The DEV `done` output may carry `childPlaybookId: 'pr'`, and a relayed child failure may name `branch` or `pr`.

## References

[1]: https://cli.github.com/manual/gh_pr_checks "gh pr checks — --watch, --fail-fast, and exit statuses"
[2]: https://cli.github.com/manual/gh_pr_merge "gh pr merge — --merge, --delete-branch, --match-head-commit"
[3]: https://cli.github.com/manual/gh_pr_create "gh pr create — default base branch and Closes #N linking"
[4]: https://cli.github.com/manual/gh_pr_view "gh pr view — headRefOid JSON field"
