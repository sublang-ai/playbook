<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-118: CODE Record Maintenance

## Status

Implemented; automated release gates passed, manual UX and integration pending (2026-10-25).

## Intent

Let CODE assess standalone documentation or status maintenance through its existing new-change path when it implements no identified unfinished IR task, including a record update to an IR with no unfinished task.

## Deliverables

- [x] Align the source, GEARS and FSM descriptions without adding a state or outcome.
- [x] Verify a real status-only commit reaches exact-scope nested REVIEW while existing receipt and incomplete-task checks remain unchanged.
- [x] Generate shipping artifacts and pass the normal, packed and fresh real-agent gates.
- [ ] Complete manual UX and integration before release.

## Tasks

1. Specify, implement and verify request-scoped CODE record maintenance in one focused commit.

## Verification

- Frozen installation of public Cligent 0.36.1 and the normal TypeScript build passed; only the expected CODE FSM and linked-runtime JavaScript siblings changed, with no declaration drift.
- Specification lint passed with zero errors and 311 advisory warnings.
- The six-file focused CODE and package-surface run passed all 166 tests in 82.32 seconds with one worker.
  It includes the new real CODE/REVIEW status-only commit case, exact receipt-owned scope and clean REVIEW, and existing incomplete-task refusal cases.
- The separate Cligent release-capability suite passed all 146 tests in 98.14 seconds.
- The focused record-maintenance provider responses are scripted; this proves the CODE/REVIEW contract and receipt plumbing, not live semantic reliability for that specific request.
- The first full run failed 13 tests: 12 stale current-CODE fixture selectors or labels and one fixed-permission fixture masked by umask 077.
  Its failure evidence remains preserved; the reviewed fixture-only corrections retain the original restore, receipt and permission assertions.
- The changed-input normal gate passed 114 files with 2,900 tests passed and 24 skipped, followed by 146 Cligent capability tests.
- The model-free packed smoke passed all 11 steps, including 2,007 artifact conformance tests and all 30 required suite files.
- Fresh real-agent release acceptance passed all 14 cases with Claude Opus 5.5 and GPT-6.1 Sol: seven installed scenarios, two question-relay cases and five recovery cases.
- Manual packed-tmux UX and integration remain pending; the candidate metadata is 18.0.1 and required prepush passed with spec lint and type checking clean.
The observed native status-only commit and its failed outcome remain preserved; no replay or repair of that saved run is claimed.

The full normal, packed smoke and live gates preceded the version-only 18.0.1 metadata preparation; unchanged model suites were not rerun.
The 18.0.1 tag/changelog validation and 25 selected metadata/package tests passed, with 85 unrelated package cases not selected.
