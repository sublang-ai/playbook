<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-010: Drop the injected Boss-question instruction

## Goal

Remove the framework-injected Boss-question instruction — `If a specific Boss answer is needed, ask the exact question and stop.` — from every composed player prompt.
The nudge prompts unnecessary questions: told it *may* ask, the player asks more than it needs to.

A genuine clarifying question is still caught by the `needsBossReply` adjudicator when one naturally arises; the player needs no instruction to ask.
The Boss-reply suspend/resume machinery is unchanged — only the player-facing instruction is removed.

## Decisions baked in

- The `needsBossReply` guard, `awaitBossReply` state, `BOSS_REPLY` event, and the DR-005 §1-§3 / §6 / §8 suspend/resume machinery stay exactly as specified.
- The runtime prompt composer injects no Boss-question instruction; the composed prompt keeps the continuation preamble and Q&A blocks (when resuming), the ordinary structured blocks, and the GEARS-derived domain prompt — only the Boss-question instruction is removed.
- A genuine player question is still detected by the [PBRT-10](../dev/playbook-runtime.md#pbrt-10) adjudicator via the `needsBossReply` guard description — no player-facing instruction is needed for the player to ask.

## Deliverables

- [x] IR-010 doc and its `map.md` row landed.
- [x] [`specs/decisions/005-boss-reply-suspension-path.md`](../decisions/005-boss-reply-suspension-path.md) — §4/§5: the player-visible Boss-question instruction is removed; the guard and resume mechanics are retained.
- [x] [`slc/link.md`](../../slc/link.md) — "Player prompt composition": the Boss-question instruction injection is removed.
- [x] [`slc/gears2fsm.md`](../../slc/gears2fsm.md) — "Boss-reply suspension": the reference to a runtime-supplied player-visible instruction is removed.
- [x] [`code.playbook.ts`](../../reference/sdlc/code.playbook/code.playbook.ts) — `BOSS_QUESTION_INSTRUCTION` and its injection are removed from `composePlayerPrompt`; recompile siblings.
- [ ] [`code.prompt-contract.test.ts`](../../reference/sdlc/code.playbook/code.prompt-contract.test.ts) — the instruction-injection assertions are removed; the continuation-prompt test reconciled.

## Tasks

Each task is one commit.
Order keeps `main` building and test-green: spec amendments land first, the runtime change follows, the test reconciliation lands after.

1. **Land IR-010 + map.md row.**
   Add this IR doc and its `map.md` row.
   No code or behavior change.
2. **Spec amendments.**
   DR-005 §4/§5 (remove the player-visible instruction); `slc/link.md` "Player prompt composition" (remove the injection); `slc/gears2fsm.md` "Boss-reply suspension" (remove the instruction reference).
   All prose; no code touched.
3. **Runtime change.**
   `code.playbook.ts` drops `BOSS_QUESTION_INSTRUCTION` and its `composePlayerPrompt` injection; recompile siblings.
   Adjust any existing test that breaks so `pnpm test` stays green; the new assertion lands in task 4.
4. **Tests.**
   Drop the instruction-injection conformance; assert no composed player prompt carries a Boss-question instruction.
5. **Close-out.**
   Re-verify `map.md`; record any substantive divergence from DR-005 as a one-line addendum.

## Acceptance criteria

- No composed player prompt contains a Boss-question instruction.
- `code.playbook.ts` defines and injects no `BOSS_QUESTION_INSTRUCTION`.
- The `needsBossReply` / `awaitBossReply` / `BOSS_REPLY` suspend-resume path still works: a genuine player question lands at `awaitBossReply`, `BOSS_REPLY` resumes the originating state, and the DR-005 §8 failure modes route to `failed`.
- DR-005, `slc/link.md`, and `slc/gears2fsm.md` no longer specify a player-facing Boss-question instruction.
- `pnpm test` from the repo root is green.
