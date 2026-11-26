<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-107: Recovery review, round three

## Status

Completed on `codex/captain-recovery`; not merged.

## Intent

Answer every active round-three finding against Playbook `57b45c8` and SLC `6b7a4e8`, preserving the original recovery scope.

## Deliverables

- [x] Resolve every active review item and record its disposition.
- [x] Test hard process loss and nested cancellation through real hosts and stores.
- [x] Synchronize specs and regenerate verification support from SLC.
- [x] Verify real Opus 5.5 and GPT-5.6 Sol runs.

All 18 active items are accepted; none is rejected and no rebuttal remains.

| Item | Disposition and result | Evidence |
| --- | --- | --- |
| 3 | Accept. Lost machine position enters the existing review/abandon path; unchanged work, commits, repeated retry and completed roots keep an exit. | `captain-process-loss.integration.test.ts`: real SIGKILL, zero abort cleanup, preserved calls/commits, ordinary reopening and abandonment. |
| 6 | Accept. The outermost participating summary policy counts the child's automatic answer and resumed parent work together. | `captain-recovery-progress.integration.test.ts`, auto-child and counts cases. |
| 11 | Accept. General saved-point wording, discard guidance and linker action descriptions now match behavior. | Specs, CLI/embedding docs, store diagnostics and linker contract checks. |
| 15 | Accept. Added independent pre-delivery disposal, request/input validation, legacy empty candidates, exact action attribution, SDK routing and signal-lifetime checks; split verification flows. | Shell, recovery, frontend-parity and progress integration suites. |
| 16 | Accept. Failure-reply item 34 owns appending the original question; DR-073 records the decision and item 37 cites it. | Existing failed-reply checks in the passing shell suite. |
| 22 | Accept in SLC. Fold verification-11 into one statement. | SLC's round-three record; spec lint has no warnings. |
| 25 | Accept. Saved continuations retain preparation and automatic-answer facts; one spec owns disclosure. | SIGKILL before dispatch, followed by retry with exact disclosure. |
| 26 | Accept. The question check uses the standard hidden-control envelope. | All five adapter cases and explicit quoted-evidence instruction checks. |
| 28 | Accept. Align stopped-turn wording and separate preparation, settlement, presentation and SDK requirements. | Recovery items 7, 20–26 and DR-069/068. |
| 29 | Accept. Finished or paused actions save a reporting-only point; retry starts no preparation or player work. | Progress cases and completed-root SIGKILL case. |
| 30 | Accept. Cancellation retains an exportable child under its suspended parent, including later child turns. | Real nested cancellation followed by child-only recovery. |
| 31 | Accept. An optional save failure cannot change the completed action's status. | Save-failure case checks successful reply and outcome journal. |
| 32 | Accept. Saved-settlement lookup requires the current attempt ID. | A later checkpoint callback failure stays uncertain and reports no prior settlement. |
| 33 | Accept. Later delivered Boss text and current instructions are nonselectable context; an original answer is never sent twice automatically. | Repeated question, changed Boss input and legacy reopening cases. |
| 34 | Accept in both repos. SLC excludes only the final defensive failure sink; Captain's six verifier files are copied from built SLC. | SLC's positive/negative fallback fixture; regenerated Captain checks. |
| 35 | Accept. Headless saved-work notices require this attempt's actual settlement. | Fresh-boundary retraction, existing-session setup refusal and interrupted CLI cases. |
| 36 | Accept. Record coordinated upgrade of every host sharing the store, including Spex. | DR-073 and both user guides; no release is performed here. |
| 37 | Accept. An open controller newly left uncertain consistently requires disposal and reopening with `mode:'recover'`. | `recover()`, `recover(text)` and `retry()` refusals plus successful reopening. |

The review's already-closed items 4, 7, 10, 12, 13, 14, 24 and 27 remain closed; 19 and 23 retain their accepted earlier dispositions, and 20 stays folded into 10/24.

## Tasks

1. Implement accepted findings, verify changed inputs, and add one review-fix commit with GPT-6 Astra coder and Claude Opus 5.5 reviewer credit; do not merge or rewrite prior commits.

## Verification

Final results:

- TypeScript build passed after the final TypeScript changes; JavaScript-only wording and retry-admission edits require no rebuild.
- Broad regression run: 869 passed across 16 runtime, shell, CLI, SDK, interactive, storage and recovery files.
- Hard process-loss run: 7 passed, including unchanged and committed work, whole-turn retry, completed-root reporting, a second loss, preparation disclosure and automatic-answer disclosure; the final run also checks marker validation.
- Contract run: 49 passed, 1 failed, 1 skipped; the single failure was the frozen linker checksum after the intended wording change. Updating the exact current hash and historical normalization fixed it; its focused rerun passed. The unrelated skipped experiment stayed skipped.
- Regenerated Captain verifier checks: 6 passed; after SLC formatting changed only the generated coverage file, that coverage check passed again within the contract run.
- SLC checker: 135 passed; build and ESLint passed. Details are in SLC's round-three record.
- Live SDK question relay: passed with Opus 5.5 as Captain and GPT-5.6 Sol as worker; Boss clarified, reopened, relayed a follow-up and answered using Captain alone. The CLI variant was not selected for this live run; scripted frontend parity passed both directions.
- Live preparation interruption: passed with the same models and no repeated commit; the other four live recovery cases were not selected.
- The first live attempt failed because sandboxing blocked Codex's state database and Claude's login state. The authorized run with provider access passed; evidence directories are `captain-question-live-vNd5ts` and `captain-recovery-live-WtuV9q` under the machine's temporary directory.
- Tests used the declared Cligent 0.26 dependency; the pre-existing link to the local Cligent checkout is restored afterward. No dependency manifest or lockfile changed.

Earlier development runs, all followed by changed code or fixtures before retry:

| Check | Results before final passing checks | What changed |
| --- | --- | --- |
| Initial runtime/host implementation | 265 passed / 27 failed; then 42/8; then 42/7 | Fixed restored snapshot consistency, settlement fields and reporting-only expectations; updated question-prompt fixtures. |
| Extended reply and progress checks | 283/11; progress 7/2; then 46/1; then 12/0 | Fixed fixture envelope assertions, callback placement, governed question output and optional-save assertions. |
| New hard-kill fixture | Two 0/5 runs, then 0/5; initial five cases passed in the 283-test run | Fixed fixture syntax/metadata/continuity and the real empty-evidence abandonment gap. |
| Extended hard-kill fixture | Two 0/7 runs; then 6/1; then 7/0; final validator extension 7/0 | Removed a Node-incompatible fixture import, fixed optional question metadata and recognized resumed player prompts. |
| Builds | Initial build passed; next build caught one missing report type field; subsequent changed-input builds passed | Included status and facts in the internal report, excluding them from the public closed settlement shape. |

No unchanged test or build was repeated for reassurance.
The six generated verifier files remain exact SLC output; `git diff --check` reports three compiler-generated trailing spaces in `verify.js`/`verify.d.ts`, while authored changes pass that check.
Final spec lint: 0 errors, 276 sentence warnings from the installed checker; changed items were reviewed under the cohesive-item rule in meta-29.
Two initial lint errors were cross-repository intent names interpreted as local citations; removing those names fixed them.
Configured commit author in both repositories: `Σ* <alph@sublang.ai>`; messages use the required conventional subject, intent reference and both AI trailers.
