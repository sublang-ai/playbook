<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-032: Conversational First-Turn Resilience

## Goal

Implement [DR-025](../decisions/025-resilient-captain-control-adjudication.md): the compiled default Captain adjudicates through the engine's exported explicit `{ guard, … }` judge contract with one corrective re-ask on a malformed control reply, and the shell resets a failed internal Captain root, so a conversational first message routes cleanly and can no longer strand the session.

## Deliverables

- [x] DR-025, new [CAPPLAY-18](../dev/captain-playbook.md#capplay-18)/[CAPPLAY-19](../test/captain-playbook.md#capplay-19) and [CAPTAIN-34](../user/playbook-captain.md#captain-34)/[CAPTAIN-35](../dev/playbook-captain.md#captain-35)/[CAPTAIN-36](../test/playbook-captain.md#captain-36), the amended [RELEASE-15](../dev/release.md#release-15), this record, the map rows, and the `[Unreleased]` CHANGELOG entries per [RELEASE-4](../dev/release.md#release-4).
- [x] `defaultBuildCaptainJudgePrompt` exported from the engine, reused by the compiled Captain's `makeJudgePrompt`, and the corrective re-ask in its captain actor.
- [x] Internal-root failure disposal with the Boss-appropriate boundary error, shared by the `handleBossInput` and `resumePlaybookCall` boundaries in the Playbook Captain shell.
- [x] Integration tests per CAPPLAY-19 and CAPTAIN-36, with compiled siblings rebuilt.

## Tasks

1. **Spec surface.** _[done]_ Author DR-025, the CAPPLAY and CAPTAIN items, this record, and the map rows.
2. **Engine and compiled Captain.** _[done]_ Export the builder from `src/xstate-playbook-runtime.ts`, delegate `makeJudgePrompt` to it, add the corrective re-ask around `adjudicateCaptainOutput`, extend the captain.playbook integration suite, and rebuild compiled siblings.
3. **Shell reset.** _[done]_ Add the `failure` disposal path and wrapped boundary error to `playbook-captain.ts` as one parentless-boundary helper reached from both `submitToActive` and `returnBoundaryFailure`, with tests per CAPTAIN-36.

## Acceptance criteria

- A scripted conversational routing turn whose first adjudication reply omits `guard` settles as the declared `question` outcome after exactly one corrective judge call; two malformed replies park the recoverable `failed` state after exactly two adjudication calls, with each judge call traced as its own pair.
- After an internal-root turn failure — whether the rejecting boundary is the delivered `handleBossInput` or the `resumePlaybookCall` returning a completed child — the shell is back in idle `chat`: a following registered command engages its playbook with no already-running refusal, and the surfaced failure text names a concrete next step without internal control vocabulary.
- `pnpm test` passes with the compiled `.js` / `.d.ts` siblings showing no drift after `pnpm build`.
