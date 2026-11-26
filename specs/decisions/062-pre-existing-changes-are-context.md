<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-062: Pre-Existing Changes Are the Boss's Context

## Status

Accepted (2026-09-17).
Amends [DR-040](040-outcome-authority-effect-reconciliation.md).
Amended by [DR-073](073-durable-step-progress.md), [DR-088](088-a-commit-outcome-takes-every-new-commit.md).

## Context

- A `/code` run in an embedding host started on a working tree holding four modified files and three untracked seeds that a scaffold update had left.
  Ten Coder commits that left them untouched passed their receipts.
  The eleventh carried the four modified files, which its intent-record task required, and was classified `observation-ambiguous`; the outcome became `repository-disposition-mismatch` and the run parked after hours of work.
- The classifier proves `one-descendant-commit` only when the after projection is byte-equal to the baseline projection.
  Committing a pre-existing change removes its entry from the projection, so every such commit trips the rule, and the conformance suites pin "consumed or altered pre-existing overlays" as fail-closed.
  Reproduced against the shipped classifier: a commit carrying a pre-existing modified or untracked file classifies ambiguous, while the same dirt left untouched beside a fresh commit classifies `one-descendant-commit`.
- DR-040 §2 called an altered pre-existing overlay "overlap that cannot be attributed uniquely".
  An absorbed entry can be attributed: the commit was made under the call's exclusive claim, and its tree carries exactly the content the baseline recorded for that path.
  What the runtime could not prove was only whether the Boss wanted that content committed, which is not a repository fact.
- The Coder is never told which changes were present before its call.
  `git status` shows changes, not their age, so the Coder cannot judge them, and the rule then punished any judgment.
- Alternatives considered and rejected:
  a host preflight that refuses or commits the Boss's tree imposes a commit on the Boss to run any workflow;
  an isolated worktree hides the Boss's uncommitted inputs, which this very task needed, and is a host's choice at session start rather than a runtime rule;
  stashing and restoring conflicts whenever the call touches the same files and hides inputs the same way;
  a runtime judgment of relevance would put a model between the Boss and a repository fact.
- This record changes DR-040 §2 only in how a receipt treats the baseline projection entries a governed call absorbs into its commits, alters, or loses; the observation itself, the exclusive claim, the exclusively-`unchanged` and cohort rules, and the fail-closed treatment of residual, rewritten, foreign, and unstable evidence stand.

## Decision

1. **Fate by content.**
   Each baseline projection entry ends a governed call in exactly one state: *preserved* when the after projection holds the byte-equal entry; *absorbed* when the entry is gone from the after projection and the after HEAD tree carries the content the baseline recorded for that path — the worktree content of a modified or untracked entry, the index content of a staged entry, or the absence of a deleted one; *altered* when the entry stands in the after projection with a different entry — a worktree deletion only where the index or the after HEAD tree still holds the content the baseline recorded — or the commit carries the path with content other than the baseline's; *lost* when the Boss's content is nowhere — the after projection holds the path as a worktree deletion with that content in neither the index nor the after HEAD tree, or the entry is gone from the after projection and the commit does not carry the path's change, which a commit that drops the path never does.
   A rename, an unmerged path, a submodule, or a nested worktree is preserved when byte-equal and otherwise lost: no content matching is attempted for them.
   Content is compared by the projection's own content addressing, never by Git object id alone.
2. **Classification.**
   For an effect-authorized call whose after HEAD descends from the baseline HEAD by one or more new commits ([DR-088](088-a-commit-outcome-takes-every-new-commit.md)), the receipt proves `one-descendant-commit` when every baseline entry is preserved, absorbed, or altered and carried by the advance, and the after projection holds nothing else; the accounting applies to the whole advance.
   A baseline entry altered but left uncommitted, a lost entry, or a new uncommitted entry keeps the receipt `observation-ambiguous`, named by path.
   For a same-HEAD delta from an effect-authorized call, `worktree-only-change` admits altered pre-existing entries beside new ones; a lost entry keeps it `observation-ambiguous`.
   A call declared exclusively `unchanged`, and every cohort call, keeps DR-040's rules unchanged.
3. **The receipt records the accounting.**
   A physical receipt gains a closed optional `preExisting` member `{ absorbed, altered, lost }` of sorted unique baseline paths, present exactly when one list is nonempty; the deferred chain's cumulative receipt applies the same rule from the original baseline; a pure projection of an open chain never downgrades a classification the physical receipt proved.
4. **The Coder is told.**
   Every effect-authorized player prompt carries the pre-existing changes of the call's own baseline as a bounded path list grouped by kind, with one rule: they existed before this call and belong to the Boss; leave them exactly as they are unless the task or the Boss's request requires building on them; never revert or delete them; when you commit any of them, name them in your final report.
   An empty baseline adds nothing.
5. **The Boss is told.**
   A settled turn whose accepted commits absorbed or altered pre-existing changes reports it deterministically, bounded to paths, beside the unresolved-effect report DR-040 §4 already requires, in that turn's Boss-visible reply or, where that reply was not presented because the turn was cancelled or lost, in the next reply that is shown ([DR-073](073-durable-step-progress.md)).

## Consequences

- A workflow runs on the Boss's tree as it stands, and the Boss commits nothing to run it.
- Absorbing unrelated work is visible to the Boss and to review and is reversible; losing the Boss's work is a failure named by path.
- The reviewer receives no separate list: it reviews the whole commit, and the Boss reads provenance from the turn's report.
- Stored receipts stay valid, since the member is optional and absent means empty.
- A fixture that produced ambiguity by absorbing pre-existing dirt now needs a stray file or a lost entry to do so.
- Each missing baseline path costs the classifier one tree lookup and one blob read at the after HEAD.
