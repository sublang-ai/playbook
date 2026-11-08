<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-102: CODE Reviews the Intent Once, in at Most Three Rounds

## Status

Accepted (2026-11-08).
Amends [DR-004](004-link-code-fsm-to-playbook-runtime.md) §3 in one scope: CODE invokes REVIEW once, after the direct phase or the final IR-task phase, over every `code`-owned commit of the run, instead of after each commit.
Supersedes [DR-081](081-code-prior-review-relay.md): with no review between IR tasks there is no prior-phase review to relay, so the frozen record, its relay, and the Coder instructions that read it are retired.
Amends [DR-088](088-a-commit-outcome-takes-every-new-commit.md)'s consequence that CODE's review request names one commit: it now names each phase's receipt-owned commit, oldest first.
Extends [DR-035](035-truthful-terminal-meaning.md) and [DR-048](048-typed-terminal-outcomes.md) to REVIEW: its bounded rounds end at a distinct failure terminal.

## Context

- CODE called REVIEW after every phase: the new-IR commit and each IR-task commit each received a full nested review, and REVIEW ran its own review-and-fix rounds until the Reviewer reported no unsettled findings, with no bound.
- A review of each task repeats the Reviewer's reading of the intent, the IR, and the specs once per task, and a Reviewer who finds something in task one and again in task two reviews the same design twice; the maintainer measured this as the dominant cost of a multi-task intent (2026-11-08).
- The intent is what the Boss asked for and what the IR records; a task is a commit-sized slice of it, and a finding about one slice is usually a finding about the intent's design, which the final task settles or exposes.
- An unbounded review loop has no terminal of its own: a Reviewer and a Coder who disagree keep exchanging rounds until the Boss interrupts, and the run publishes no meaning for that outcome.
- [DR-081](081-code-prior-review-relay.md) existed only because a later task's Coder saw an IR that truthfully said earlier work awaited review; with one review at the end, that statement is simply true until the end.
- Considered and declined:
  - a per-task review that skips REVIEW's fix loop and reviews only at the end: two review protocols for one artifact;
  - counting rounds in CODE: REVIEW owns the rounds and the review-fix commits, so the bound belongs where the loop runs, and DECIDE and standalone REVIEW gain the same bound for free;
  - a Boss-supplied bound: a tuning knob for a workflow property that one number has served every team.

## Decision

### 1. One review per intent

CODE shall run its phases — a direct implementation, or a new-IR phase followed by one phase per IR task, or an existing IR's remaining tasks — each ending with one `code`-owned commit, and shall call REVIEW once after the direct phase or the final IR-task phase.
A new-IR or nonfinal IR-task phase continues to the next IR-task phase without a review.
The review request names the original intent, every phase's receipt-owned commit oldest first with the resulting repository state as the scope, the final phase's Coder output, and, for an IR, the IR number.
A single-task intent therefore behaves as before: one commit, one review.

### 2. Retired prior-phase relay

CODE freezes no prior-phase review record and relays none to a later IR-task phase.
The later IR-task prompt instead tells the Coder that the intent's earlier phases await the one REVIEW that follows its final task, so the Coder neither asks the Boss to review them nor treats an IR's pending-review status as an obstacle.

### 3. REVIEW runs at most three rounds

REVIEW shall run at most three Reviewer rounds: the first review and one further round after each of at most two Coder dispositions, a review-fix commit or an all-rejected rebuttal alike.
When the Reviewer raises or keeps any finding at the third round, REVIEW shall end at a distinct failure terminal, `unsettled`, whose description states that findings remain unsettled and no further fix round runs, returning `{ noUnsettledFindings: false, reviewerOutput }` with the Reviewer's final findings; the Coder makes no further disposition.
A Boss interruption that restarts the first review resets the round count; one that redoes a later round keeps it.

### 4. Callers route the bound through the existing failure path

CODE and DECIDE receive REVIEW's `unsettled` terminal through their `invoke.onError` authored-outcome arms under [DR-048](048-typed-terminal-outcomes.md) and settle at their existing review-failure terminals, whose descriptions name the failure and whose outputs carry the last owned commit and REVIEW's compact error naming the terminal's description.
No caller reads REVIEW's state id or output fields to route the outcome.

## Consequences

- Reviewer calls per intent fall from one REVIEW call per phase, each unbounded, to one REVIEW call of at most three Reviewer rounds: an intent of one new-IR phase and three tasks moves from four REVIEW calls to one.
- REVIEW's public output interface gains a second variant; a caller that reads the output still sees the success variant unchanged.
- CODE's GEARS carry three items — the first phase, the later IR-task phase, and the one REVIEW call — and the FSM has one nested-call state.
- The `code-prior-review` integration suite and spec items `playbook-60` and `playbook-61` retire with DR-081; their request-scoped record-maintenance case moves into the remaining CODE integration coverage.
- The Boss sees a review stopped at its bound as a failure with the findings attached, and decides what to do with them.
