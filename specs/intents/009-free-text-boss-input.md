<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-009: Free-text Boss turn input

## Goal

Make every Boss turn free text classified by the judge, and retire the in-playbook slash commands `/start`, `/continue`, `/summarize`, and `/interrupt`.
The `/command` namespace is reserved for selecting playbooks; a playbook's runtime shall not define slash commands for its own states or features.

After IR-009 the runtime has a single Boss-input path — `callJudge` — with no slash-prefix fast-path; the FSM's typed Boss events are unchanged.

## Decisions baked in

- Slash commands are reserved for playbook-level selection; a playbook runtime defines none for its own states or features.
- `callJudge` is the sole classifier of Boss turn input — there is no slash-prefix fast-path and no deterministic prefix mapping.
- The judge resolves Boss text to one FSM Boss event — `START_CODING`, `CONTINUE_IR`, `SUMMARIZE_IR`, or `BOSS_INTERRUPT` — or to no FSM action; for `BOSS_INTERRUPT` it selects the target from the FSM's jumpable states and their descriptions.
- At `awaitBossReply` the judge is state-aware: Boss text is taken as the `BOSS_REPLY` answer unless it is unambiguously a fresh directive, which the judge classifies as the corresponding event and which abandons the pending question via `clearBossReplyContext`.
- The FSM contract is unchanged — the typed Boss events and `awaitBossReply` stay; only the runtime's input classification changes, so `code.fsm.ts`, `code.gears.md`, and `code.md` are untouched.

## Deliverables

- [x] IR-009 doc and its `map.md` row landed.
- [x] [`slc/link.md`](../../slc/link.md) — the Linker-inputs strategy line, the Boss-event-mapping section, and the session-lifecycle classify step: free-text judge classification becomes the sole strategy, slash-prefix is removed, and the `/command` reservation is recorded.
- [x] [`slc/gears2fsm.md`](../../slc/gears2fsm.md) — the `awaitBossReply` "Boss-reply suspension" prose: `/interrupt <stateId>` and "a slash command from Boss" reworded as slash-free Boss-interrupt / fresh-directive wording, with the FSM mechanics unchanged.
- [x] [`specs/decisions/004-link-code-fsm-to-playbook-runtime.md`](../decisions/004-link-code-fsm-to-playbook-runtime.md) — the CODE Boss-event mapping follows `slc/link.md`'s free-text classification; the `/start` … `/interrupt` slash mapping is dropped.
- [x] [`specs/decisions/005-boss-reply-suspension-path.md`](../decisions/005-boss-reply-suspension-path.md) — the Context paragraph and `awaitBossReply` entry-event references reworded for free-text classification, with no `/start` … `/interrupt`.
- [x] [`specs/user/playbook-runtime.md`](../user/playbook-runtime.md) — PBRT-1/PBRT-2 reworked: all turn input is free text, judge-classified, plus the `awaitBossReply` reply-vs-directive rule.
- [x] [`specs/dev/playbook-runtime.md`](../dev/playbook-runtime.md) — PBRT-7 reworked: `callJudge` sole classifier, `BOSS_INTERRUPT` target selection, `awaitBossReply` state-aware classification.
- [x] [`specs/test/playbook-runtime.md`](../test/playbook-runtime.md) — drop the slash-form test items; add judge-classification and `awaitBossReply` items.
- [x] [`code.playbook.ts`](../../reference/sdlc/code.playbook/code.playbook.ts) — remove slash parsing; route every non-empty turn through `callJudge`; recompile siblings.
- [x] `code.playbook.test.ts` (and `code.tmux-play.test.ts` if affected) — updated for the free-text path and Task 4 coverage.
- [x] [`specs/map.md`](../map.md) — DR-004 and PBRT row summaries refreshed.

## Tasks

Each task is one commit.
Order keeps `main` building and test-green: spec amendments land first to give the implementation a contract; the runtime change follows; the deep test-conformance changes land after.

1. **Land IR-009 + map.md row.**
   Add this IR doc and its `map.md` row.
   No code or behavior change.
2. **Spec amendments.**
   `slc/link.md` (Boss-event mapping → free-text-only, `/command` reservation); `slc/gears2fsm.md` (the `awaitBossReply` prose drops the slash spellings); DR-004 (CODE Boss-event mapping follows `slc/link.md`); DR-005 (Context and `awaitBossReply` references); PBRT user PBRT-1/PBRT-2; PBRT dev PBRT-7; PBRT test items.
   All prose; no code touched.
3. **Runtime change.**
   `code.playbook.ts` drops slash parsing and routes every non-empty Boss turn through `callJudge`, which selects the `BOSS_INTERRUPT` target and performs the `awaitBossReply` reply-vs-directive classification; recompile siblings.
   Adjust any existing test that breaks so `pnpm test` stays green; the new conformance assertions land in task 4.
4. **Tests.**
   Cover free-text classification of every Boss event, `BOSS_INTERRUPT` target selection, and the `awaitBossReply` reply-vs-directive split; assert no slash form is specially recognized.
5. **Close-out.**
   Re-verify `map.md`; record any substantive divergence from DR-004 or DR-005 as a one-line addendum.

Close-out addendum: Re-verified `map.md` against DR-004, DR-005, and PBRT; no substantive divergence found.

## Acceptance criteria

- The runtime defines and recognizes no slash commands; no `/start`, `/continue`, `/summarize`, or `/interrupt` handling remains.
- `slc/link.md` defines Boss-event classification as free-text judge classification only, and no slc spec names a `/`-prefixed command for in-playbook Boss input.
- Every non-empty Boss turn is classified by `callJudge`; empty or whitespace-only text produces no FSM action and no judge call.
- The judge resolves `START_CODING`, `CONTINUE_IR`, `SUMMARIZE_IR`, and `BOSS_INTERRUPT` from free text, selecting the `BOSS_INTERRUPT` target from the FSM's jumpable states.
- At `awaitBossReply`, plain free text resumes the pending question via `BOSS_REPLY`, and a free-text fresh directive abandons it via `clearBossReplyContext`.
- `code.fsm.ts`, `code.gears.md`, and `code.md` are unchanged.
- `pnpm test` from the repo root is green.
