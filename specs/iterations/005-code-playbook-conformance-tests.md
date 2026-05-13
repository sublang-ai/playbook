<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-005: CODE playbook conformance tests

## Goal

Add automated tests that catch drift between the GEARS source for
the CODE playbook
([`reference/sdlc/code.playbook/code.gears.md`](../../reference/sdlc/code.playbook/code.gears.md))
and the emitted FSM
([`code.fsm.ts`](../../reference/sdlc/code.playbook/code.fsm.ts)),
and that exercise every declared FSM edge at least once.
IR-004's acceptance gate was a manual e2e runbook
([dropped in `9c36355`](../../reference/sdlc/code.playbook/));
this IR replaces it with type-checked, in-CI verification of the
invariants that runbook was meant to spot-check.

## Decisions baked in

These are scoped enough to live in the IR rather than a separate DR.

- `code.gears.md` is the canonical source for CODE-N item IDs and
  player prompts.
  Each `### CODE-N` heading is a stable ID; the `> …` blockquote
  that follows is the canonical prompt body.
  `reference/sdlc/code.md` remains the human-facing prose summary
  and is not load-bearing for tests.
- Three orthogonal test files, separated by concern: conformance
  (gears ↔ FSM), edge coverage (every guard fires), prompt contract
  (per-state `CaptainInput` shape).
  All share one FSM-introspection helper.
- Coverage means every edge fires once, not path enumeration.
  Review loops are non-finite and full path coverage is not a goal.
- Tests drive `codingMachine` directly (xstate-level) where possible,
  not through `createPlaybookRuntime`.
  The existing 60 runtime-level tests stay narrow as integration
  smoke; this IR does not expand them.

## Deliverables

- [x] `reference/sdlc/code.playbook/code.fsm.introspect.ts` —
  helper exporting `enumerateCaptainStates(codingMachine)` returning
  `{ stateId, sourceItem, getInput(context), transitions: Array<{
  target, guardName, contextFixture? }> }[]` plus the root-level
  event table (`START_CODING`, `CONTINUE_IR`, `SUMMARIZE_IR`,
  `BOSS_INTERRUPT[targetId]`).
  Each `transitions` entry corresponds to one `onDone` arm — the
  same `result`-map guard string may appear in multiple entries
  when the FSM splits on `context.reviewSubject` /
  `context.afterReview` / `context.changeOrigin`
  (e.g., `noFindings` routes to `continueIr` / `summarizeSpecs` /
  `done` per `noFindingsAfter` in
  [`code.fsm.ts:138`](../../reference/sdlc/code.playbook/code.fsm.ts#L138)).
  `contextFixture` is the minimal context override needed to make
  that transition's guard fire; the coverage test consumes it
  verbatim.
  May land as an `_internal` export of `code.playbook.ts` if a
  separate file feels heavyweight.
- [ ] `reference/sdlc/code.playbook/code.gears-fsm.test.ts` —
  conformance.
  Parses `code.gears.md` into `Map<CODE-N, { player, promptBody }>`
  (player is the `## Coder` / `## Reviewer` / `## Committer`
  section heading the CODE-N falls under); walks `codingMachine`
  via the helper.
  Asserts (a) every CODE-N from gears has at least one FSM state
  with matching `sourceItem`, (b) every FSM `sourceItem` resolves
  to a known CODE-N, (c) each state's `input.player` matches the
  player parsed from the CODE-N's gears section, (d) each state's
  `input.prompt` body equals the CODE-N blockquote body modulo
  declared placeholders (`<#>`, `<coder-llm>`, `<reviewer-llm>`).
- [ ] `reference/sdlc/code.playbook/code.fsm.coverage.test.ts` —
  edge coverage.
  For each captain-invoking state and each transition returned by
  the helper, drives a fake `captain` actor that returns the
  transition's `CaptainOutput` (with required payload fields) under
  the transition's `contextFixture`; asserts the FSM lands at the
  declared `target`.
  This pins context-qualified edges (`noFindings` /  `accepted` /
  `committed*`) where the same guard string routes to different
  targets depending on `context.afterReview` or
  `context.reviewSubject`.
  Also exercises each state's `onError` path (Captain bridge throws
  → `#failed`) and every root-level event
  (`/start`, `/continue`, `/summarize`, each `BOSS_INTERRUPT`
  target).
  A structural assertion fails the test if any `onDone` transition
  lacks a fixture.
- [ ] `reference/sdlc/code.playbook/code.prompt-contract.test.ts` —
  table-driven prompt contract.
  For each captain-invoking state and each relevant context fixture
  (Boss-intent vs IR-task; specs / code / mixed scope; with and
  without prior reviews / challenges), invokes the state's
  `input(context)` thunk and asserts the composed `CaptainInput`
  carries the expected `player`, `sourceItem`, structured fields,
  placeholder substitution, and labelled-block ordering per
  DR-004 §6.
- [ ] `specs/test/playbook.md` — declare the observable acceptance
  behaviors the CODE playbook commits to per META-21:
  `pnpm test` fails when (i) an FSM state's `sourceItem` is not a
  known CODE-N in `code.gears.md`, (ii) a CODE-N prompt body
  diverges from its state's `input.prompt`, (iii) a CODE-N's player
  binding diverges from its state's `input.player`, (iv) any
  declared `onDone` transition has no exercising fixture, or (v) a
  state's composed prompt drops a required structured field or
  fails to substitute a declared placeholder.
  Internal test-file layout is implementation detail and is not
  part of the spec.
- [ ] `specs/map.md` — register `test/playbook.md` under a new
  `PLAYBOOK` package row and add the IR-005 row.

## Tasks

Each task is a commit.
Order keeps `main` building at every commit.

1. **Land IR-005 + map.md.**
   This commit lands the IR doc and adds the IR-005 row to
   `specs/map.md`.
   No code changes.
2. **Introspection helper.**
   Add the helper (separate file or `_internal` export).
   Unit-test it against `codingMachine` directly (enumerated
   sourceItems, transitions count per state, root-event targets).
3. **GEARS ↔ FSM conformance test.**
   Add `code.gears-fsm.test.ts`.
   If any prompt or sourceItem has drifted between gears and FSM,
   fix the drift in the same commit; gears is authoritative for
   prompt text unless the FSM body is clearly newer, in which case
   update gears and call it out in the commit message.
4. **Edge coverage test.**
   Add `code.fsm.coverage.test.ts`.
   Surfaces uncovered `result`-map guards or unreachable transitions
   if any; small one-line fixes land here, larger fixes are flagged
   for follow-up.
5. **Prompt contract test.**
   Add `code.prompt-contract.test.ts` with a fixture row per
   captain-invoking state (~14 rows).
6. **Spec items.**
   Write `specs/test/playbook.md`; finalize `specs/map.md` with the
   new `PLAYBOOK` package row.

## Acceptance criteria

- `pnpm test` from `reference/sdlc/code.playbook/` is green and the
  test count grows by at least one row per CODE-N item plus one row
  per declared root-level event.
- The conformance test fails immediately if a CODE-N is added to
  gears without a corresponding `sourceItem` in `code.fsm.ts`, or
  vice versa, or if a prompt body diverges.
- The coverage test fails immediately if a new `result`-map guard is
  added to a state without an outgoing transition, or if any
  declared transition becomes unreachable.
- The prompt contract test fails immediately if a state's composed
  prompt drops a required structured field
  (`intent` / `reviews` / `challenges` / `taskDescription`) or fails
  to substitute a declared placeholder.
- `specs/map.md` lists `test/playbook.md` under a new `PLAYBOOK`
  package, and the Iterations table has the IR-005 row.
