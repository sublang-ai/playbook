<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-043: Truthful terminal meaning

## Status

Done

## Intent

Implement DR-035 so a compiled workflow publishes a terminal meaning true of the outcome it actually reached, correcting CODE's overloaded `done` state.

## Deliverables

- [x] `slc/gears2fsm.md` requires one final state per authored terminal outcome and a description true of every arm entering it.
- [x] The workflow spec package states that guarantee for CODE and DECIDE and verifies it.
- [x] CODE routes its authored REVIEW-failure outcomes to their own final state, leaving `done` entered only by exact approval.
- [x] CODE and DECIDE conformance pin each terminal state, its published description, and every arm entering it.

## Tasks

1. Record DR-035 and this intent with their map rows, state the compiler rule and the spec item, split CODE's terminal states, and extend the CODE conformance suites in one commit.

## Verification

- A CODE run whose nested REVIEW is aborted, fails, or returns a terminal result that does not prove approval reaches the review-failure final state and publishes a description naming that failure.
- A CODE run that REVIEW approves reaches `done` and publishes the approval description.
- The declared machine output is unchanged: `complete` and `review-failed` carry the same fields and errors as before.
- REVIEW and DECIDE already satisfy the compiler rule and need no artifact change.
