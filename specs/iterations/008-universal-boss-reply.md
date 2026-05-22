<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-008: Universal Boss-reply suspension

## Goal

Make `needsBossReply` a universal capability of every captain-invoking state, so a player may surface a Boss question from any state with no per-state opt-in.
The IR-007 `Resumable: Boss reply` source annotation was opaque jargon in the domain source; universal coverage removes the opt-in, and the annotation, entirely.

After IR-008, `code.md` carries domain prompts only, `code.gears.md` declares no `needsBossReply` guard metadata, and `gears2fsm` wires the suspend/resume path for every captain-invoking state.
IR-008 supersedes IR-007: the IR-007 record is deleted, while its commits stay in history because the branch is unpushed and Boss chose to supersede rather than rewrite.

## Decisions baked in

- Boss-reply suspension is universal — every captain-invoking state declares `needsBossReply`; there is no opt-in.
- The `Resumable: Boss reply` source annotation and the `text2gears` "Resumable Boss replies" rule are withdrawn.
- `needsBossReply` no longer appears in GEARS output: `gears2fsm` injects the guard for every captain-invoking state, so `code.gears.md` carries no `Result guard: needsBossReply` line.
- The standard Boss-question instruction is runtime-injected into every captain prompt, reusing the DR-005 §5 composer pattern.
- DR-005 §9's per-state resumability audit is removed — all captain-invoking states are resumable.
- DR-005 §4's rule that a state shall not declare both `needsBossReply` and `needsBossInput` is replaced: the two coexist — `needsBossReply` resumes the same state with an answer, `needsBossInput` routes to idle for rescoping. The CODE Committer states carry both.
- The FSM contract from DR-005 §1-§3 / §6 / §8 is otherwise unchanged — `awaitBossReply`, `BOSS_REPLY`, `resumableStates`, the §8 failure modes. Only the guard's scope changes, from per-state opt-in to universal.

## Deliverables

- [x] IR-008 doc and its `map.md` row landed; the IR-007 doc deleted and its `map.md` row removed.
- [x] [`specs/decisions/005-boss-reply-suspension-path.md`](../decisions/005-boss-reply-suspension-path.md) — §4 made universal; §1 drops the "resumable" qualifier; §9 per-state audit removed; the no-both rule replaced.
- [x] [`slc/text2gears.md`](../../slc/text2gears.md) — the "Resumable Boss replies" section removed.
- [x] [`slc/gears2fsm.md`](../../slc/gears2fsm.md) — `needsBossReply` and the `awaitBossReply` / `resumableStates` wiring made universal for captain-invoking states; annotation-driven language removed.
- [x] [`slc/link.md`](../../slc/link.md) — the standard Boss-question instruction injected into every captain prompt.
- [x] [`specs/dev/playbook.md`](../dev/playbook.md) — PLAYBOOK-12/13 reworded for universal coverage: every captain-invoking state declares `needsBossReply`; the "opts into" opt-in framing dropped.
- [x] [`specs/test/playbook.md`](../test/playbook.md) — PLAYBOOK-14/15 reworded so the conformance tests assert universal `needsBossReply` coverage.
- [x] [`reference/sdlc/code.md`](../../reference/sdlc/code.md) — the three `Resumable: Boss reply` lines removed.
- [x] [`code.gears.md`](../../reference/sdlc/code.playbook/code.gears.md) — the three `Result guard: needsBossReply` lines removed.
- [x] [`code.fsm.ts`](../../reference/sdlc/code.playbook/code.fsm.ts) — every captain-invoking state carries `needsBossReply` and is registered with `resumableStates`; recompile siblings.
- [x] [`code.playbook.ts`](../../reference/sdlc/code.playbook/code.playbook.ts) — the composer covers every captain prompt; verify whether the universal result map already satisfies the existing condition.
- [x] Tests — `code.gears-fsm.test.ts` and `code.prompt-contract.test.ts` updated for universal coverage; the source-annotation parser removed.
- [x] [`specs/map.md`](../map.md) — DR-005 row no longer says "opt-in" after the DR-005 amendment.

## Tasks

Each task is one commit.
Order keeps `main` building and test-green: spec amendments land first to give the implementation a contract; the CODE migration moves source, gears, FSM, and runtime together; the deep test-conformance changes land after.

1. **Land IR-008; retire IR-007.**
   Add this IR doc and its `map.md` row; delete the IR-007 doc and remove its `map.md` row.
   No code or behavior change.
2. **Spec amendments.**
   DR-005 (§4 universal, §1 wording, §9 audit removed, the no-both rule replaced); `slc/text2gears.md` (remove "Resumable Boss replies"); `slc/gears2fsm.md` (universal wiring); `slc/link.md` (inject into every captain prompt); `specs/dev/playbook.md` and `specs/test/playbook.md` (PLAYBOOK-12/13/14/15 reworded for universal coverage).
   All prose; no code touched.
3. **CODE migration (combined).**
   `code.md` drops the `Resumable: Boss reply` lines; `code.gears.md` drops the `Result guard: needsBossReply` lines; `code.fsm.ts` adds `needsBossReply` to every captain-invoking state with full `resumableStates` registration; `code.playbook.ts` covers every captain prompt; recompile siblings.
   Adjust any existing test that breaks so `pnpm test` stays green; the new universal assertions land in task 4.
4. **Tests.**
   Conformance: `needsBossReply` is expected on every captain-invoking state, with no `code.md` annotation or `code.gears.md` metadata to parse; the source-annotation parser is removed.
   Prompt-contract: every captain state's composed prompt carries the Boss-question instruction immediately before the domain body.
5. **Close-out.**
   Re-verify `map.md`; record any substantive divergence from DR-005 as a one-line addendum.

## Close-out

- `specs/map.md` re-verified; no substantive divergence from DR-005 remains after correcting DR-005's stale historical `needsBossInput` context note.

## Acceptance criteria

- No captain-invoking state requires a source annotation to be resumable; `code.md` and `code.gears.md` contain no Boss-reply opt-in marker or guard metadata.
- Every captain-invoking state in `code.fsm.ts` declares `needsBossReply` and is registered with `resumableStates`.
- No normative spec item frames `needsBossReply` as an opt-in: PLAYBOOK-12/13/14/15 describe universal coverage.
- Every captain state's composed player prompt carries the standard Boss-question instruction immediately before the domain prompt body; no GEARS blockquote carries that instruction.
- `needsBossReply` end-to-end behavior is unchanged: a player question lands at `awaitBossReply`, `BOSS_REPLY` resumes the originating state, and the DR-005 §8 failure modes still route to `failed`.
- The CODE Committer states retain `needsBossInput` alongside `needsBossReply`.
- `specs/iterations/007-resumable-state-annotation.md` no longer exists, and `map.md` has no IR-007 row.
- `pnpm test` from the repo root is green.
