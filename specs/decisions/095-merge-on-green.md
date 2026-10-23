<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-095: Merge on Green

## Status

Accepted (2026-10-23) on the owner's direction to make merging timely while several people and agents land work on `main` at once.

## Context

Several branches now land on `main` in one day.
A pull request's checks run against the pull request merged with `main` as it stands, so a run goes stale the moment `main` moves, and waiting for a fresh run before each merge gives `main` time to move again.
`main` is not protected: a merge needs no check, so a red test or a duplicate spec item ID merged into `main` turns every open pull request red.
Every push to a pull request's branch queues a full run beside the runs it supersedes.
Deleting a base branch can close the pull requests stacked on it.
The suites spawn real CLI and Git processes and sync durable storage, so an assumption the CI runner does not share fails only there, a full round after the push.
A wall-clock bound is one such assumption: CPU-count scheduling once pushed four existing deadlines past their limits until the suite's workers were capped at two.
The CI workflow runs on Linux alone — the tests on Node 20 and 22, the SPDX check and the global-install smoke — so no macOS runner queue slows a pull request's run.

## Decision

- `main` is protected: a merge into it requires every job of the CI workflow to have passed on the pull request's head, with no requirement that the branch be up to date with `main`, so a green run stands until the branch itself changes.
- A pull request merges with a merge commit by GitHub's auto-merge once its checks pass, the maintainer having asked for the merge when the pull request was ready, so no interval stands between green and merged for `main` to move in.
- The CI workflow runs one run per pull-request head: a push to the branch cancels the run of the head it supersedes, while a push to `main` cancels nothing.
- The CI matrix stays as it is: with no macOS job, a pull request's run is the whole workflow, and no reduced pull-request matrix or nightly run is introduced.
- A base branch is never deleted while a pull request still targets it.
- Before a push, the developer/agent runs the pre-push check — no conflict marker left in the tree, `spex lint` and the type check — so a push never carries what the first CI minute would refuse.
- A test a change adds or changes is deterministic by construction: it takes no order from a tool's or a directory's listing but sorts both sides or reads the order its subject promises, bounds no step by wall-clock time but by the event the behavior names, counts no tool's calls exactly but asserts where they went, and scripts a fault to outlast every call that may consume it before the call under test.

## Consequences

- A red test on `main` blocks every merge until `main` is fixed, which is what keeps `main` green: a fix for `main` is a pull request like any other, and it merges once its own checks pass.
- A conflicting pull request waits until its branch merges `main` and passes again; a merely stale one does not.
- The required checks are the workflow's check names, so renaming, adding or removing a CI job changes them: the merge-gate audit fails until its list follows, and the branch protection must follow too, since a renamed job's old check never reports and blocks every merge.
- Existing tests are not swept for the determinism rule; a test that breaks it comes under it when a change touches it.
- `release` states the merge rule, the run per head, the pre-push check and the determinism rule; its merge-gate audit asserts the cancellation rule, that the required checks are the workflow's jobs and that the pre-push check refuses a conflict marker, and a review audits each added or changed test for determinism.
- The branch protection on `main` and the repository's permission to auto-merge are the operator's to set; the record names them so a person can check them against the specs.
