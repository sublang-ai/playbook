<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-081: Prior phase review context

## Status

Accepted.

## Context

CODE retains a successful nested REVIEW's exact evaluated revision and advances to the next IR task, but that next Coder prompt carries only caller input, IR identity and caller-supplied run results.
Two actual workshop teams consequently asked Boss to provide already established bound review reports while their committed IR still truthfully said the earlier work awaited review.

## Decision

CODE freezes a prior phase record only from its accepted canonical clean REVIEW result and that phase's receipt-owned CODE commit, kind and exact IR/task scope.
Every later IR-task prompt receives that record as quoted evidence, with the CODE scope commit and REVIEW evaluated revision distinct because review fixes can create descendants.
The record survives permitted snapshot restoration and Boss-answer continuation of that task, is cleared on a fresh run or explicit interrupt, and has no public option or player-produced override.
The Coder verifies clean current HEAD equals that evaluated revision before treating it as current review evidence; mismatch is not approval.
The evidence neither satisfies a new task's independent review nor replaces an owner decision or release approval.

## Consequences

Later Coder tasks can use machine-established review context without asking Boss to certify it manually.
The relay adds no receipt, repository disposition, registry ABI or review authority.
Canonical Source, GEARS and generated artifacts retain the same quoted relay and lifecycle.
