<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-005: CODE playbook conformance tests

## Goal

Add automated tests that catch drift between the GEARS source for
the CODE playbook
([`code.gears.md`](../../code.gears.md))
and the emitted FSM
([`code.fsm.ts`](../../code.fsm.ts)),
and that exercise every declared FSM edge at least once.
IR-004's acceptance gate was a manual e2e runbook
([dropped in `9c36355`](../../));
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

- [x] `code.fsm.introspect.ts` —
  helper exporting `enumerateCaptainStates(codingMachine)` returning
  `{ stateId, sourceItem, getInput(context), transitions: Array<{
  index, target, guard }> }[]` plus the root-level event table
  (`START_CODING`, `CONTINUE_IR`, `SUMMARIZE_IR`,
  `BOSS_INTERRUPT[targetId]`).
  Each `transitions` entry corresponds to one `onDone` arm — the
  same `result`-map guard string may appear in multiple entries
  when the FSM splits on `context.reviewSubject` /
  `context.afterReview` / `context.changeOrigin`
  (e.g., `noFindings` routes to `continueIr` / `summarizeSpecs` /
  `done` per `noFindingsAfter` in
  [`code.fsm.ts:138`](../../code.fsm.ts#L138)).
  `guard` is the raw transition predicate function; the helper
  stays a pure structural introspector and does not synthesize
  fixture data.
  The `(context, CaptainOutput)` pair that fires each arm lives
  in Task 4's coverage test as a hand-maintained table keyed by
  `(stateId, transitionIndex)` (the `index` field above), kept
  honest by a structural assertion that fails the test if any
  helper-enumerated arm is missing a fixture (or if a fixture is
  left unused).
  May land as an `_internal` export of `code.playbook.ts` if a
  separate file feels heavyweight.
- [x] `code.gears-fsm.test.ts` —
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
- [x] `code.fsm.coverage.test.ts` —
  edge coverage.
  Maintains a fixture table mapping each captain-invoking
  `(stateId, transitionIndex)` — matching the helper's
  `transitions[i].index` — to a `(context override, CaptainOutput)`
  pair that satisfies that arm's guard *and* falsifies every
  earlier arm (xstate's `onDone` is first-match-wins, so a
  context that satisfies multiple arms still only fires the
  earliest one).
  `(stateId, target)` is *not* unique: four states have
  same-target arms (`planAndImplement` / `commitCoderInitial`
  with two same-target arms each, plus `commitReviewerCleared`
  and `commitJoint` each routing both `committed && afterReview
  === 'done'` and `noRelevantChanges` to `done`), so the index is
  the keying discipline.
  For each transition returned by the helper, drives a fake
  `captain` actor with the fixture's `CaptainOutput` under the
  fixture's context; asserts the FSM lands at the declared
  `target`.
  This pins context-qualified edges (`noFindings` / `accepted` /
  `committed*`) where the same guard string routes to different
  targets depending on `context.afterReview` /
  `context.reviewSubject` / `context.changeOrigin`.
  Also exercises each state's `onError` path (Captain bridge
  throws → `#failed`) and every root-level event
  (`/start`, `/continue`, `/summarize`, each `BOSS_INTERRUPT`
  target).
  A structural assertion fails the test if any helper-enumerated
  `onDone` arm lacks a fixture, or if any fixture is left unused
  by the helper.
- [x] `code.prompt-contract.test.ts` —
  table-driven prompt contract.
  For each captain-invoking state and each relevant context fixture
  (Boss-intent vs IR-task; specs / code / mixed scope; with and
  without prior reviews / challenges), invokes the state's
  `input(context)` thunk and asserts the composed `CaptainInput`
  carries the expected `player`, `sourceItem`, structured fields,
  placeholder substitution, and labelled-block ordering per
  DR-004 §6.
- [x] `specs/dev/playbook.md` — declare the FSM-side conformance
  invariants the implementation commits to: source agreement
  (CODE-N validity, prompt body verbatim, player binding),
  transition coverage (every `onDone` arm exercisable under
  xstate's first-match-wins), and prompt composition (block
  ordering per DR-004 §6, placeholder ↔ source-field wiring).
  Required by META-20 as the verification target for the test
  items below.
- [x] `specs/test/playbook.md` — declare the observable acceptance
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
- [x] `specs/map.md` — register `dev/playbook.md` and
  `test/playbook.md` under a new `PLAYBOOK` package row and add
  the IR-005 row.

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
   Write `specs/dev/playbook.md` (six conformance invariants the
   FSM commits to, PLAYBOOK-1..6) and `specs/test/playbook.md`
   (five test items PLAYBOOK-7..11, each `Verifies:` a dev item
   per META-20); finalize `specs/map.md` with the new `PLAYBOOK`
   package row.

## Acceptance criteria

- `pnpm test` from `` is green and the
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
