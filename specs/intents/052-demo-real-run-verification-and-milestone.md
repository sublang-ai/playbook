<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-052: Demo Real-Run Verification and Milestone Release

## Status

In progress

## Intent

Before the demo, prove the four maintained workflows on real development scenarios over the Academy spec tree (`../spex/demo`) through the released CLI, fix what the runs expose, and publish the milestone the demo depends on.

## Deliverables

- [x] A small set of real scenarios over `../spex/demo`, one or more per workflow, each run locally on its own branch and never pushed.
- [x] `/review`, `/code`, and `/decide` complete their scenarios; `/dev` completes its chain but its Coder's task choice failed on the fixture's open IRs — `/dev`, `/review`, `/code`, and `/decide` each complete a scenario with truthful terminal outcomes and receipt-proven commits.
- [x] Every defect the runs expose is fixed at its root with a regression test, or recorded here as an accepted limitation.
- [ ] The milestone release is published with all gates and the live acceptance green.

## Tasks

1. [x] Record this ledger.
2. [x] Select the scenarios and run each workflow over them; record outcomes and defects here:
   - Scenarios (Academy, `../spex/demo`): `/decide` closing the demoted-admin window (DR-003 amendment), `/code` previous/next lesson navigation, `/review` a planted lesson-count commit with four seeded defects, `/dev` custom course slugs.
   - `/code` passed on branch `demo/code-lesson-navigation` (18 min, published 12.1.0, seeded lineup): parked on a legitimate Boss question (the tree ships in-progress IRs), then direct implementation, nested REVIEW, receipt-proven commits.
   - Defect (product): the judge prompt asks the judge to output presentation-owned fields (`question`, `planningResult`) and effect-owned fields (`evaluatedRevision`) that the candidate validator rejects, spending the single corrective re-ask; fix once in the engine's judge-facing contract.
   - `/review` passed on branch `demo/review-lesson-count-commit` (27 min): the planted defects were found as one class, one review-fix commit, closed with the exact evaluated revision — after exposing a product deadlock (below) and one usage-window interruption.
   - `/decide` passed on branch `demo/decide-admin-rotation-window` (31 min): blind parallel proposals, one synthesized DECIDE-owned commit adding DR-004 and rewriting access-control items, nested review clean.
   - `/dev` did not pass in two attempts (65 + 92 min): the engine chain dev → code → review ran as designed, but the Codex Coder treated the spec-only request as IR-002 task 1 because the demo tree ships in-progress IRs with open code tasks, and the review spiralled into over-specification; classified as model behavior plus fixture — pick demo requests that do not collide with open IRs, or mark the demo's IRs planned.
   - Product defects fixed with regression tests: the judge-contract rendering (engine and DECIDE), the unchanged-receipt failure deadlock, continuation trace ordering, and the Captain's saved-counts line on Boss-question suspensions.
   - Recorded, not fixed here (cligent-level): Codex `writablePaths` cannot cover a linked worktree's external git dir; the replay stream omits Codex sub-agent tool activity.
   - Environment: concurrent scenarios exhausted the Claude session quota once and hit a Codex capacity error once; the runtime parked truthfully each time.
3. [x] Fix the exposed defects with tests; re-run the affected scenarios (the `/dev` re-run reproduced only the model and fixture causes).
4. [ ] Prepare and publish the milestone release.

## Verification

- Each scenario's session record shows the expected nested lifecycle markers, governed receipts, and terminal description; the branch holds the expected commits.
- `npm test`, the release smoke, and the live acceptance pass on the milestone commit.
