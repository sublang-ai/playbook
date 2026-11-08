<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-088: A Commit Outcome Takes Every New Commit, or the Commit Already at HEAD

## Status

Accepted (2026-10-11).
Amends [DR-040](040-outcome-authority-effect-reconciliation.md) in three scopes: §2's `one-descendant-commit` proof covers one or more new commits, §1 lets the reconciler read `finalText` for exactly one designation — whether it names the commit an `unchanged` receipt observed at HEAD — and §5's `unchanged` receipt for a claimed commit resolves under that designation.
Amends [DR-062](062-pre-existing-changes-are-context.md) §2 in one scope: its accounting applies to the whole advance rather than to exactly one commit.
The three dispositions, the exclusive claim, the cohort and exclusively-`unchanged` rules, the deferred chain, and the fail-closed treatment of rewritten, residual, foreign, lost, and unstable evidence stand.
[DR-090](090-every-role-hears-the-boss.md) amends §3: each statement names the branch the commits landed on, and a step's one new commit joins the closing reply's facts.
[DR-102](102-code-reviews-the-intent-once.md) amends the consequence on CODE's review request: it names every phase's receipt-owned commit, oldest first, in the one review after the intent.

## Context

- A schema-3 outcome that must commit accepts only a receipt proving exactly one new descendant commit; an `unchanged` receipt and a `multiple-commits` receipt both fail the run.
- In a ten-team simulation, three real runs met that limit:
  - `/design` committed the approved design in one turn, asked the Boss about a missing credit in the next, and when told to keep that commit its final step failed with "the step had to commit its work and committed nothing", although the work stood at HEAD.
  - `/verify` committed its tests and then its own audit fixes in one step and failed with "the step made more than one commit"; the files stand uncounted.
  - Authoring could not link "draft in the working tree, review, commit once at the end", because no step may end with its changes uncommitted.
- The repository facts were never in doubt: HEAD descended from the baseline by two commits, or stood unchanged at the commit that held the work.
  What failed was a rule that counted to exactly one.
- Considered and declined:
  - a disposition per count, such as "one or more commits": a new closed value in every compiled artifact, the linker, and the registry for a rule the observation already decides;
  - a semantic field naming the commit: [DR-040](040-outcome-authority-effect-reconciliation.md) §1 keeps commit identity out of the semantic plane, and judge-written OIDs are rejected;
  - satisfying an unchanged step from a commit an earlier step of the session proved: a step that did nothing after an earlier commit would pass without saying so.

## Decision

1. **New commits satisfy a commit outcome.**
   For an effect-authorized call, a receipt proves `one-descendant-commit` when its after HEAD descends from its baseline HEAD by one or more new commits — those reachable from the after HEAD and not from the baseline HEAD, every reachable commit for the null HEAD — and [DR-062](062-pre-existing-changes-are-context.md)'s accounting holds over the whole advance.
   The receipt carries the after HEAD as `commitOid` and, where more than one commit is new, a `commits` list of every one, oldest first and ending at `commitOid`; a receipt of one new commit keeps its shape.
   The identifier `one-descendant-commit` stays, because compiled artifacts, ledgers, and hosts name it; it now reads "HEAD advanced by new commits".
   A merge needs no rule of its own: the commits it brings are new to HEAD and are listed.
   No new receipt classifies `multiple-commits`; a recorded one stays readable and keeps failing.
2. **A named HEAD satisfies a commit outcome.**
   A commit outcome reconciles with an `unchanged` receipt — or a deferred chain's cumulative `unchanged` receipt — whose HEAD names a commit when the player's final text names that commit as a word, by its full OID or by an abbreviation of at least seven leading hex digits, and the call declares no `unchanged` outcome; effect-owned fields take that HEAD.
   The receipt still proves every fact: HEAD and the tree did not move.
   The prose only designates which commit is the work, so it cannot establish a fact the receipt did not prove.
   A call that declares an `unchanged` outcome, such as REVIEW's `rejectedAll`, already has the outcome for "I changed nothing"; accepting a claimed commit there would blur the distinction its author drew.
   Uncommitted changes, a different named commit, or an unborn HEAD keep the existing `commit-missing` failure.
3. **The Boss sees every commit.**
   Beside [DR-062](062-pre-existing-changes-are-context.md) §5's report, each presented reply states, for each step completed since the last one presented, the new commits when more than one, oldest first, and, for a step reconciled by a named HEAD, that it made no new commit and named the commit already at HEAD.
   The report of the commits a failed turn made ([DR-089](089-judge-replies-take-the-machines-shapes.md) §3) lists them the same way.
   An unresolved-effect entry or failure cause over a receipt listing more than one commit reads as `multiple-commits` and `commits-more-than-one`, so their existing phrases stay exact, and the failed-turn report does not restate a receipt such an entry already names.
4. **Uncommitted work is not an outcome (non-goal).**
   A step ending "working tree changed, uncommitted" needs more than a classification:
   - a fourth disposition in the closed schema-3 set that the linker derives and every compiled artifact and registry validates;
   - a failure-retry fence that replays only over `unchanged` receipts, so a failed draft step could never be retried;
   - [DR-062](062-pre-existing-changes-are-context.md), which would report the later commit of those drafts as carrying the Boss's own pre-existing changes and misattribute them.

   Drafts keep travelling as text between steps, or each drafting step commits.

## Consequences

- `/design`'s final step reconciles as already at its commit, and `/verify`'s two commits reconcile as its outcome with both listed.
- CODE's Coder and DECIDE's merge accept several commits and a named HEAD; REVIEW's Coder accepts several commits but not a named HEAD.
- CODE's review request still names one commit, the phase's last, with its resulting repository state; its prompts still ask for one commit per phase.
- Player prompts, compiled artifacts, the artifact schema, the runtime ABI, and configuration are unchanged; the linker's description of the shared reconciler names the two new cases.
- A Playbook release before this one rejects a ledger whose receipt carries `commits`; hosts sharing a session store upgrade together.
- The evidence still proves neither authorship of a commit nor completion of a workflow; the listed commits and the named commit are what the Boss reviews.
