<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-007: Resumable-state source annotation

## Goal

Make the `needsBossReply` opt-in a source-level annotation that the compiler expands, instead of prompt prose hand-authored into the GEARS output.
After this IR, `reference/sdlc/code.md` carries domain workflow prompts only, `code.gears.md` is once again a faithful `text2gears` output, and the player-facing Boss-question instruction is framework-injected rather than hand-written.

This closes a source-of-truth divergence found while reviewing IR-006: CODE-1/3/4 in `code.gears.md` carry a Boss-question blockquote line and a `needsBossReply` guard with no basis in `code.md`, so re-running `text2gears` on `code.md` would drop the behavior.

## Decisions baked in

- The opt-in moves from authored prose (DR-005 §4 as written) to a source-level **resumable annotation** — a recognized *non-prompt* line in a state's `text2gears` item, outside the blockquote.
  The exact syntax is finalized in `slc/text2gears.md` (Task 2); this IR bakes only that the annotation is non-prompt and per-state.
- The per-state audit from DR-005 §9 stands unchanged: `planAndImplement` / `continueIr` / `summarizeSpecs` are resumable; `commitCoderInitial` / `commitJoint` and all reviewer states are not.
- The standard player-facing instruction ("if a specific Boss answer is needed, ask the exact question and stop") is framework-fixed and injected by the runtime into a resumable state's *composed* prompt, outside the domain prompt body — reusing the DR-005 §5 composer-injection pattern already used for the resume preamble.
- `code.gears.md` represents a resumable state as result-map metadata (the `Result guard: needsBossReply` line, now a faithful compiler output of the annotation), never as a hand-authored blockquote line.
- The FSM contract is unchanged: `awaitBossReply`, `BOSS_REPLY`, the `needsBossReply` guard, `resumableStates`, and the §8 failure modes stay exactly as DR-005 §1-§3/§6/§8 specify.
  Only the guard's *origin* (source annotation, not authored prose) and the player instruction's *placement* (runtime-injected, not in the gears blockquote) change.

## Deliverables

- [x] [`slc/text2gears.md`](../../slc/text2gears.md) — define the
  resumable source annotation: a recognized non-prompt per-state
  marker, its syntax and semantics, and how `text2gears` carries
  it into the GEARS output as result metadata rather than prompt
  text.
- [x] [`slc/gears2fsm.md`](../../slc/gears2fsm.md) — define that a
  resumable-annotated GEARS item expands to the `needsBossReply`
  result guard and the `awaitBossReply` / `resumableStates`
  wiring.
- [x] [`slc/link.md`](../../slc/link.md) — define that the runtime
  injects the standard Boss-question instruction into a resumable
  state's composed player prompt, outside the domain prompt body.
- [x] [`specs/decisions/005-boss-reply-suspension-path.md`](../decisions/005-boss-reply-suspension-path.md)
  — amend §4/§5: opt-in is the source annotation + compiler
  expansion; the authored-prose mechanism is superseded and the
  resume preamble is runtime-composed.
- [x] [`reference/sdlc/code.md`](../../reference/sdlc/code.md) —
  add the resumable annotation to the CODE-1/3/4 source items
  (which carry domain-only prompts today).
- [x] [`code.gears.md`](../../reference/sdlc/code.playbook/code.gears.md)
  — re-derived: blockquotes carry domain prompts only; resumable
  carried as the `Result guard: needsBossReply` metadata line.
- [x] [`code.fsm.ts`](../../reference/sdlc/code.playbook/code.fsm.ts)
  — the three states' `invoke.input.prompt` no longer carries the
  Boss-question line; `result.needsBossReply` unchanged. Recompile
  siblings.
- [x] [`code.playbook.ts`](../../reference/sdlc/code.playbook/code.playbook.ts)
  — the runtime composes the framework Boss-question instruction
  into resumable states' prompts.
- [ ] Tests — `code.gears-fsm.test.ts`, `code.prompt-contract.test.ts`,
  `code.fsm.coverage.test.ts` updated for the new arrangement.
- [ ] [`specs/map.md`](../map.md) — IR-007 row reflects the final
  summary. *(Re-verify at close-out.)*

## Tasks

Each task is one commit.
Order keeps `main` building and test-green throughout: spec amendments land first to give the implementation a contract; the CODE migration moves gears, FSM, and runtime injection together so the Boss-question instruction relocates from gears blockquote to runtime injection atomically — no commit leaves the `needsBossReply` guard present while the player is no longer told it may ask; the deep test-conformance additions land after.

1. **Land IR-007 + map.md row.**
   This commit lands the IR doc and adds the IR-007 row to
   `specs/map.md`.
   No code or behavior changes.
2. **Spec amendments.**
   `slc/text2gears.md` (resumable annotation syntax + semantics);
   `slc/gears2fsm.md` (annotation → guard + `awaitBossReply`
   wiring); `slc/link.md` (runtime injection of the standard
   instruction); DR-005 §4 amendment.
   All prose; no code touched.
3. **CODE migration: source, gears, FSM, runtime (combined).**
   One commit relocates the Boss-question instruction from the
   gears blockquote to runtime injection, atomically — so no
   committed step has the `needsBossReply` guard present while
   the player is no longer told it may ask:
   - `reference/sdlc/code.md`: add the resumable annotation to
     the CODE-1/3/4 source items.
   - `code.gears.md`: re-derive — blockquotes carry domain
     prompts only, resumable carried as the `Result guard:`
     metadata line.
   - `code.fsm.ts`: the three states' `invoke.input.prompt`
     loses the Boss-question line; `result.needsBossReply`
     unchanged; recompile siblings.
   - `code.playbook.ts`: the runtime composes the standard
     Boss-question instruction into resumable states' player
     prompts, outside the domain prompt body (per the
     `slc/link.md` amendment).
   Any existing test that pins the composed prompt is adjusted
   in this same commit so `pnpm test` stays green; the new
   conformance assertions land in task 4.
4. **Tests.**
   Add the new conformance assertions: `code.gears-fsm.test.ts`
   fails if `code.gears.md` carries content not derivable from
   `code.md` — a blockquote line with no source blockquote
   line, or a `Result guard: needsBossReply` metadata line
   whose source item lacks the resumable annotation, or the
   converse (a resumable annotation with no `Result guard:`
   line). `code.prompt-contract.test.ts` asserts the injected
   instruction on the *composed* prompt, not the gears
   blockquote; reconcile `code.fsm.coverage.test.ts` fixtures.
5. **Close-out.**
   Update the `specs/map.md` IR-007 row to reflect any delta.
   Record any substantive divergence from DR-005 as a one-line
   addendum.

## Acceptance criteria

- `code.gears.md` blockquotes contain only domain prompt lines —
  no Boss-question instruction or guard prose hand-added.
- `code.gears-fsm.test.ts` fails immediately if `code.gears.md`
  carries content not derivable from the corresponding `code.md`
  item — a blockquote line with no source line, or a
  `Result guard: needsBossReply` metadata line whose source item
  lacks the resumable annotation (or the converse: a resumable
  annotation with no `Result guard:` line).
- A resumable state's *composed* player prompt (runtime output)
  contains the standard Boss-question instruction; a
  non-resumable state's composed prompt does not.
- `needsBossReply` end-to-end behavior is unchanged: a player
  question lands at `awaitBossReply`, `BOSS_REPLY` resumes, and
  the §8 failure modes still route to `failed`.
- `slc/text2gears.md` defines the resumable annotation so a
  future compiler run reproduces `code.gears.md` from `code.md`
  with no hand divergence.
- `pnpm test` from the repo root is green.
