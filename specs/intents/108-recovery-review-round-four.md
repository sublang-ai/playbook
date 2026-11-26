<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-108: Recovery review round four

## Status

Complete; one review-fix commit on the existing branch, without merge or release.

## Intent

Resolve the fourth recovery review with shared-host recovery and complete saved settlements, without merging the branches.

## Deliverables

- [x] Resolve every finding and record its disposition.
- [x] Verify changed behavior without repeating unchanged checks.
- [x] Create one new review-fix commit.

## Tasks

1. Fix accepted recovery findings, align specs and generated artifacts, and record verification in one review-fix commit.

## Verification

### Dispositions

All 17 active finding numbers are accepted; the request to publish SLC immediately is rejected separately below.
Previously closed findings are unchanged.
The shared design is recorded in [DR-073](../decisions/073-durable-step-progress.md).

| Finding | Disposition and fix | Evidence |
| --- | --- | --- |
| 3 | Accept. A crash after starting from chat now ends the lost attempt in chat, preserving work and evidence without repeating a player call. | [Process-loss suite](../../reference/sdlc/code.playbook/captain-process-loss.integration.test.ts): `from-chat`, `before-receipt`. |
| 6 | Accept. The summary belongs to a frame that acted this turn; a parent takes ownership only if it actually resumes. | [Progress suite](../../reference/sdlc/code.playbook/captain-recovery-progress.integration.test.ts): `counts`, `child-only-counts`; captain-19/20. |
| 11, 28 | Accept both. Updated point names, idle reporting recovery, public signatures, optional inputs, saved-result format and stale citations. | [Recovery contract](../packages/recovery.md), captain-7/41, CLI and storage specs; build and link checks below. |
| 15 | Accept. Added actual process kills during preparation and retry, before receipt saving, and in nested DECIDE; added later child cancellation and saved-report checks. Marker validation and empty-evidence abandonment are removed with the marker, so they need no new test. Empty-effect host settlement is tested instead. | Process-loss and progress suites; recovery-17/19/23–28. |
| 25 | Accept. Automatic answers, saved replies and current Boss input have separate truthful delivery facts. | Progress suite: `start-prepares-question`; process-loss suite: `automatic-answer`. |
| 29 | Accept. Reporting points preserve retention changes, unresolved effects, counts, carried-change disclosure and the computed status, with closed validation and token removal. | Process-loss suite: `root-complete`, `closing-cancel`, `retry-save`; malformed saved-result cases in the same fixture. |
| 30 | Accept. Parent cancellation pauses only when the child accepts its initial input. Cancellation before delivery disposes that child. After a later cancelled call drains, its unsafe provider hint is dropped so the paused child can continue. | [Shell suite](../../reference/sdlc/code.playbook/playbook-captain.test.ts): ordinary-error/visibility-abort matrix; progress suite: `child-later-cancel`. |
| 33 | Accept. Retrying a recorded selection adds no automatic question check. The whole starting turn is excluded from later Boss input, including after preparation. | Process-loss suite: `retry-question`; progress suite: `start-prepares-question`; [shell implementation](../../reference/sdlc/code.playbook/playbook-captain.ts). |
| 34 | Accept the SLC defect. Only a distinct parked failure leaf shared with the final unconditional error path is excluded. Guarded error paths and real action routes remain checked. | Companion SLC review report; rebuilt checker copied by SLC's emitter; Captain transition coverage passes. See release rebuttal below. |
| 36 | Accept. Added the coordinated-upgrade release gate and its required audit; corrected the promise about older hosts reading these same-version extensions. | [[release-35](../packages/release.md#release-35)] and [[release-36](../packages/release.md#release-36)], [[session-storage-2](../packages/session-storage.md#session-storage-2)], DR-073/049. |
| 37 | Accept. SDK recovery checks busy/closing state before and after its store read; a newly uncertain live controller consistently requires reopening in recovery mode. | [SDK recovery suite](../../reference/sdlc/code.playbook/captain-recovery.integration.test.ts): timeout/checkpoint-observer case; [shared host](../../reference/sdlc/code.playbook/bin/session-host.js). |
| 38 | Accept. Removed the invented runtime marker. The shared host can end a lost attempt without restoring any stale runtime, including DECIDE or an older engine. | Actual maintained DECIDE root and nested process-loss cases; runtime restoration suites. |
| 39 | Accept. Lost-work reporting is selected only for this retry's unmatched progress. It leaves no persistent marker to swallow later input and adds no claim that a result was saved. | Process-loss suite: `later-chat`; [shared recovery decision](../../reference/sdlc/code.playbook/bin/run.js). |
| 40 | Accept. Evidence uses the shared projection, and retained generations are cleared only when their runtime identities own changed evidence. An earlier generation of the same playbook is also kept when unrelated. | Process-loss suite: `switch`, `same-root`; shared recovery decision. |
| 41 | Accept. recovery-27 owns the lost-progress behavior. CLI, runtime, shell and storage contracts now agree on replay, reporting and retained evidence. | [[recovery-27](../packages/recovery.md#recovery-27)]; spec lint below. |
| 42 | Accept. Completed the amendment chain for DR-036/038/040/049/066/067 and their map entries; DR-073 now records the replacement. | [Decision map](../map.md#decisions) and amended records. |

### Release rebuttal for finding 34

Reject publication during this review-fix round; keep it as a gate before the eventual Captain compilation and release.
[DR-069](../decisions/069-captain-prepares-step-recovery.md) requires the supporting SLC release before compiling Captain.
This round does not compile or change Captain's source, GEARS, FSM, linked module or package version.
SLC's `emitVerifierSupport` only copies the built checker closure; [Captain's coverage test](../../reference/sdlc/captain.playbook/captain.fsm.coverage.test.ts) exercises that copy successfully.
All six copied files match the built SLC inputs after the emitter's source-map removal.
SLC DR-053 identifies this as verifier compatibility, independent of the runtime and pipeline assets.
Publishing now is unnecessary for validating unmerged fixes; release the supporting SLC and re-emit from that release before the eventual Captain build/release gate.

### Run results

Logs are under `/private/tmp/review4-*.log`.
Later runs select only new cases or cases affected by changed inputs; no unchanged build or suite was repeated merely for a final green summary.

| Run/log suffix | Result and follow-up |
| --- | --- |
| `build-1` through `build-4` | Passed after successive source changes. The final build contains the delivery-fact fix and all generated JS/declarations. |
| `tests-1` | 47 passed, 7 failed. Found a saved report/status mismatch and summary ownership bug; three assertions still expected cancellation to overwrite a completed status. |
| `tests-2` | 56 passed, 3 failed. Code fixes passed; the three stale status assertions remained and were corrected. |
| `progress-3` | 4 passed, 1 failed, 6 skipped. Corrected status and child-only counts passed; later child cancellation exposed the blocked provider lane. |
| `later-cancel-2`, `later-debug` | One failure each while isolating that lane; diagnostic edits were removed. |
| `later-cancel-3` | 1 passed, 10 skipped after clearing only drained cancelled hints. |
| `cancel-before` | 1 passed, 1 failed, 249 skipped; corrected the new fixture's visibility player id. |
| `busy` | No tests ran: a new fixture callback needed `async`; fixed. |
| `busy-cancel-2` | 2 passed, 287 skipped: corrected pre-delivery cancellation and SDK busy guidance. |
| `process-3` | 3 passed, 12 skipped: switching roots and actual DECIDE root/nested crashes. |
| `broad` | 735 passed, 4 failed across 8 suites. The four failures expected the former refusal before host creation; updated them to verify host-only settlement, no player calls and preserved evidence. |
| `matrix-2` | All 4 corrected headless cases passed; 1 new carried-report assertion failed, 93 skipped. Corrected that assertion to inspect the mandatory reply suffix. |
| `report-chat` | 2 passed, 14 skipped: saved carried-change report and later chat replay. |
| `owner-generation` | 1 failed, 16 skipped; the new fixture killed the first failed call before the intended commit. Fixed its kill condition. |
| `final-focused` | 3 passed, 63 skipped: malformed saved settlements, cancelled-child hint reset and SDK busy/reopen checks. |
| `context-owner` | 1 passed, 1 failed, 27 skipped. Preserving an older generation of the same playbook passed; automatic answer delivery wording failed and was fixed. |
| `context-final` | 1 passed, 11 skipped after that wording fix. |
| `retry-question` | 1 passed, 17 skipped: retry leaves a newly asked question for Boss without an extra automatic answer check. |
| `contracts`, `links-final` | 27 link checks passed in each run, the latter after adding the completed reports and their links. An incorrectly named coverage selector selected nothing; the correctly named test ran separately below. |
| `captain-coverage` | Captain transition coverage passed with the re-emitted SLC checker. |
| `live-recovery` | Real Claude Opus 5.5 and GPT-5.6 Sol preparation-interruption acceptance passed in 104.97 seconds; 4 unrelated cases skipped. Evidence: `/var/folders/_r/s32qffsx21g__4nzbx4p6q940000gn/T/captain-recovery-live-DN9YnB`. |
| `spec-lint-1` | 1 citation error and 279 warnings; corrected the citation to the external recovery contract. |
| `spec-lint-2`, `spec-lint-3`, `spec-final-2` | 0 errors, 279 advisory warnings. The first completed-report lint found 7 citation-format errors; those were corrected. The sentence warnings are compatible with the repository's multi-statement meta-29. |

The process-loss matrix now contains 18 cases, including empty-effect loss, preparation-only retry, retry point refresh, later chat and unrelated retained-generation preservation.
The broad run covers both runtimes, the shell, CLI, host actions, portable storage and frontend parity.
Both repositories' whitespace checks pass.
SLC's detailed results are in its companion review report.
