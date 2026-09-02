<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-052: Demo Real-Run Verification and Milestone Release

## Status

In progress

## Intent

Before the demo, prove the four maintained workflows on real development scenarios over the Academy spec tree (`../spex/demo`) through the released CLI, fix what the runs expose, and publish the milestone the demo depends on.

## Deliverables

- [ ] A small set of real scenarios over `../spex/demo`, one or more per workflow, each run locally on its own branch and never pushed.
- [ ] `/dev`, `/review`, `/code`, and `/decide` each complete a scenario with truthful terminal outcomes and receipt-proven commits.
- [ ] Every defect the runs expose is fixed at its root with a regression test, or recorded here as an accepted limitation.
- [ ] The milestone release is published with all gates and the live acceptance green.

## Tasks

1. [x] Record this ledger.
2. [ ] Select the scenarios and run each workflow over them; record outcomes and defects here.
3. [ ] Fix the exposed defects with tests; re-run the affected scenarios.
4. [ ] Prepare and publish the milestone release.

## Verification

- Each scenario's session record shows the expected nested lifecycle markers, governed receipts, and terminal description; the branch holds the expected commits.
- `npm test`, the release smoke, and the live acceptance pass on the milestone commit.
