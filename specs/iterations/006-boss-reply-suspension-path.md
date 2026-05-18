<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-006: Boss-reply suspension path

## Goal

Implement [DR-005](../decisions/005-boss-reply-suspension-path.md)
end to end: amend the relevant specs, audit and migrate the CODE
gears, add the `awaitBossReply` quiescent state and `BOSS_REPLY`
event to `code.fsm.ts`, wire the runtime classifier branch and
prompt-composer preamble in `code.playbook.ts`, and extend the
conformance / coverage / prompt-contract / runtime tests so the
new contracts are pinned.

After this IR, a player turn in an opted-in CODE state can
surface a question that lands at `awaitBossReply`, Boss can type
a free-form answer that becomes `BOSS_REPLY`, and the same FSM
state re-enters with the question + reply in the prompt — all
without losing context to `#ready` and without leaking pending
context across abandon/follow-up paths.

## Decisions baked in

These are scoped enough to live in the IR rather than a separate
DR.

- **Per-state audit of the 5 existing `needsBossInput` paths
  (DR-005 §9):**
  - `planAndImplement`, `continueIr`, `summarizeSpecs` →
    convert to `needsBossReply → #awaitBossReply`. The player's
    typical reason for needing Boss input in these states is a
    specific clarifying question (which IR task, which scope,
    which ambiguity to resolve).
  - `commitCoderInitial`, `commitJoint` → keep as
    `needsBossInput → #ready`. The player's typical reason for
    needing Boss input here is "I cannot form a clean commit
    boundary, please rescope" — a redirect intent, not a
    question to answer. Per DR-005 §11, this pattern remains
    valid.
- **Status frame for `awaitBossReply` (DR-005 §10.2):** the
  status emission shall carry, on a single line:
  `awaiting Boss reply · <state-id> · <player> · CODE-N · q="<first 80 chars of question>"`.
  The full question is also emitted on the telemetry channel
  (`playbook.fsm.state` topic) with `pendingBossQuestion.question`
  verbatim — single-line in the user-facing pane to fit the
  four-glyph vocabulary, full text in telemetry for hosts that
  surface their own prompt.
- **Glyph for `awaitBossReply` entry in the four-glyph
  vocabulary (PBRT-3):** reuse `◆` (terminal/idle) — the
  state is quiescent from the runtime's perspective, and adding
  a fifth glyph would inflate the vocabulary for one state.
  The preceding label (`awaiting Boss reply ·`) disambiguates
  from `#ready` / `#done` / `#failed`.

## Deliverables

- [ ] [`slc/gears2fsm.md`](../../slc/gears2fsm.md) —
  amended with a new "Boss-reply suspension" subsection under
  "Boss control", documenting the `awaitBossReply` quiescent
  state pattern, the `BOSS_REPLY` typed event, the
  `needsBossReply` opt-in guard convention with its parseable
  `Output shall include` marker, the `resumableStates(ids)`
  helper, the `setPendingBossQuestion` / `clearBossReplyContext`
  assigners, and the input-function discipline that prepends the
  continuation preamble + Q/A labelled blocks.
- [ ] [`specs/dev/playbook-runtime.md`](../dev/playbook-runtime.md)
  — three amendments:
  - PBRT-7: classifier branch when actor state is
    `awaitBossReply` (precedence per DR-005 §6).
  - PBRT-11: extend quiescent-state set to include
    `awaitBossReply`.
  - PBRT-14: status emission on `awaitBossReply` entry carries
    the structured fields per DR-005 §10.2.
- [ ] [`specs/user/playbook-runtime.md`](../user/playbook-runtime.md)
  — PBRT-3 vocabulary section amended to document the
  `awaiting Boss reply · …` line shape under the `◆` glyph.
- [ ] [`specs/decisions/004-link-code-fsm-to-playbook-runtime.md`](../decisions/004-link-code-fsm-to-playbook-runtime.md)
  — §8 quiescent values extended to
  `'ready' | 'failed' | 'done' | 'awaitBossReply'`. Recorded as
  a one-paragraph addendum at the bottom of DR-004 citing
  DR-005, not a substantive rewrite.
- [ ] [`specs/dev/playbook.md`](../dev/playbook.md) — two
  new PLAYBOOK conformance items (PLAYBOOK-7, PLAYBOOK-8) per
  META-20:
  - PLAYBOOK-7: every captain-invoking state whose `result` map
    declares `needsBossReply` shall have a matching arm in
    `awaitBossReply.on.BOSS_REPLY` keyed by `resumeStateId`.
  - PLAYBOOK-8: every transition out of `awaitBossReply` other
    than the `BOSS_REPLY` resume arm shall declare
    `actions: clearBossReplyContext`; every transition out of a
    resumable state's `onDone` other than its `needsBossReply`
    arm shall declare `actions: clearBossReplyContext`.
- [ ] [`specs/test/playbook.md`](../test/playbook.md) — two
  new test items (PLAYBOOK-9, PLAYBOOK-10) per META-21,
  verifying PLAYBOOK-7 and PLAYBOOK-8 via the existing
  conformance / coverage test family.
- [ ] [`code.gears.md`](../../code.gears.md) — per-state
  audit applied: `planAndImplement` / `continueIr` /
  `summarizeSpecs` declare `needsBossReply` (with the parseable
  marker); `commitCoderInitial` / `commitJoint` keep
  `needsBossInput`. CODE-N prompts updated where the gears item
  needs to tell the player to surface a specific question when
  the new guard is the right outcome.
- [ ] [`code.fsm.ts`](../../code.fsm.ts) — new
  `awaitBossReply` state with one `BOSS_REPLY` arm per
  resumable state via `resumableStates(ids)` helper; new
  `BOSS_REPLY` event in the events union; new
  `pendingBossQuestion` and `bossReply` context fields; new
  `setPendingBossQuestion` and `clearBossReplyContext` assigner
  actions; transitions on the three converted states updated to
  call `setPendingBossQuestion` on `needsBossReply` and
  `clearBossReplyContext` on every other `onDone` arm; root-level
  Boss entry events re-declared on `awaitBossReply` with
  `clearBossReplyContext`; BOSS_INTERRUPT handler on
  `awaitBossReply` adds `clearBossReplyContext` action.
  Recompile `code.fsm.js` / `code.fsm.d.ts` siblings.
- [ ] [`code.fsm.introspect.ts`](../../code.fsm.introspect.ts) —
  surface `awaitBossReply` and its `BOSS_REPLY` arms via the
  existing `enumerateCaptainStates` / root-event tables so the
  coverage test can pin them.
- [ ] [`code.playbook.ts`](../../code.playbook.ts) — five
  changes:
  - Drive-loop quiescent set extended to include
    `'awaitBossReply'` (DR-005 §10.1).
  - Classifier branch: when actor snapshot state is
    `awaitBossReply`, apply the precedence table from DR-005 §6.
  - `setPendingBossQuestion` action wired in CODE machine
    composes `pendingBossQuestion` from the invoking state's
    `id` / `CaptainInput.sourceItem` / `CaptainInput.player` +
    adjudicated `CaptainOutput.question` (per DR-005 §3
    provenance — never from raw player prose).
  - Prompt composer prepends the continuation preamble + Q/A
    labelled blocks when both `pendingBossQuestion` and
    `bossReply` are present in context (DR-005 §5).
  - Status emission on `awaitBossReply` entry produces the
    single-line pane string and the structured telemetry record
    (per "Decisions baked in" above).
- [ ] Three new failure-mode error messages in the runtime per
  DR-005 §8: missing `question` field, unregistered resumable
  state, empty `BOSS_REPLY` answer.
- [ ] Tests — added or extended:
  - `code.gears-fsm.test.ts`: every CODE-N opted into
    `needsBossReply` in gears matches a state whose `result`
    map carries the guard + the parseable marker.
  - `code.fsm.coverage.test.ts`: fixture coverage for every
    new `needsBossReply` arm and every new `BOSS_REPLY` arm
    in `awaitBossReply`; structural assertion catches
    unregistered resumable states.
  - `code.prompt-contract.test.ts`: row per resumable state
    asserting the continuation preamble + Q/A blocks render
    in the documented order when both context fields are
    populated, and do NOT render when either is absent.
  - `code.playbook.test.ts`: classifier branch routes plain
    text to `BOSS_REPLY` only in `awaitBossReply`;
    `handleBossInput` returns at `awaitBossReply`; status
    emission carries the structured fields; abandon-via-slash
    clears both context fields; follow-up `needsBossReply`
    overwrites question and clears the prior reply; the three
    failure modes from DR-005 §8 each route to `failed` with
    the documented error.
- [ ] [`specs/map.md`](../map.md) — IR-006 row reflects the
  final summary; DR-005 row already present from the prior
  commit. *(Re-verify at close-out.)*

## Tasks

Each task is one commit.
Order keeps `main` building at every commit; spec amendments
land first so the implementation tasks have something to point
at, then the FSM scaffolding lands before the runtime work that
consumes it.

1. **Land IR-006 + map.md row.**
   This commit lands the IR doc and adds the IR-006 row to
   `specs/map.md`.
   No code or behavior changes.
2. **Spec amendments.**
   `slc/gears2fsm.md` (new Boss-reply suspension subsection);
   `specs/dev/playbook-runtime.md` (PBRT-7 branch, PBRT-11
   quiescence, PBRT-14 status);
   `specs/user/playbook-runtime.md` (PBRT-3 line shape);
   DR-004 §8 addendum;
   `specs/dev/playbook.md` (PLAYBOOK-7, PLAYBOOK-8);
   `specs/test/playbook.md` (PLAYBOOK-9, PLAYBOOK-10).
   All prose; no code touched.
3. **CODE gears audit and update.**
   Apply the §9 / "Decisions baked in" audit to
   `code.gears.md`: convert `planAndImplement` /
   `continueIr` / `summarizeSpecs` to `needsBossReply` with the
   parseable marker; leave `commitCoderInitial` / `commitJoint`
   as `needsBossInput`. Update CODE-N prompts where needed so
   the gears item tells the player to surface a specific
   question when this guard is the right outcome.
4. **FSM scaffolding.**
   Extend `code.fsm.ts`: `awaitBossReply` state,
   `resumableStates(ids)` helper, `BOSS_REPLY` event,
   `pendingBossQuestion` / `bossReply` context fields,
   `setPendingBossQuestion` / `clearBossReplyContext`
   assigners; wire the three converted states' `onDone` arms
   and the awaitBossReply transitions per DR-005 §1 and §5;
   recompile siblings.
   Extend `code.fsm.introspect.ts` so coverage tests can
   enumerate the new arms.
   Verify `pnpm build` is clean and existing tests still pass
   (new tests come in tasks 7-8); failing tests in this commit
   are by design — they show the new arms have no fixtures yet.
5. **Runtime: drive-loop quiescence + classifier branch.**
   Extend `code.playbook.ts`'s quiescent-state check to include
   `'awaitBossReply'` (DR-005 §10.1) and add the classifier
   branch from DR-005 §6 with the precedence table. Add the
   three failure-mode error messages from DR-005 §8.
   Verify `handleBossInput` returns from `awaitBossReply` in a
   one-off integration check (added to the test commit later).
6. **Runtime: context assigns + prompt composer.**
   Wire `setPendingBossQuestion` so the assign function reads
   the invoking state's `id` / `CaptainInput.sourceItem` /
   `CaptainInput.player` and the adjudicated
   `CaptainOutput.question` (never from raw player prose, per
   DR-005 §3 provenance).
   Extend the prompt composer to prepend the continuation
   preamble + `Boss question:` / `Boss reply:` labelled blocks
   when both context fields are present (DR-005 §5); ordering
   per PLAYBOOK-5 grammar.
7. **Runtime: status emission on awaitBossReply entry.**
   Emit the single-line pane string and structured telemetry
   record per PBRT-14 amendment and "Decisions baked in" above.
   This is the change that lets Boss actually see what's being
   asked.
8. **Tests: conformance + coverage.**
   Extend `code.gears-fsm.test.ts` and
   `code.fsm.coverage.test.ts` to pin the new gears ↔ FSM
   mapping, the new `BOSS_REPLY` arms, the new failure modes,
   and the clearing-action discipline (PLAYBOOK-7, PLAYBOOK-8).
9. **Tests: prompt-contract + runtime.**
   Extend `code.prompt-contract.test.ts` with rows for the
   resumable states verifying the continuation preamble + Q/A
   blocks render in the documented order, and that absence of
   either field suppresses both.
   Extend `code.playbook.test.ts` to cover: classifier branch
   in `awaitBossReply`, `handleBossInput` returns from
   `awaitBossReply`, status emission carries the structured
   fields, abandon-via-slash clears both context fields,
   follow-up `needsBossReply` overwrites question and clears
   stale reply, the three failure modes route to `failed` with
   the documented errors.
10. **Close-out.**
    Update `specs/map.md` IR-006 row summary to reflect any
    delta from this plan.
    If anything diverged substantively from DR-005, record the
    delta in a one-paragraph addendum at the bottom of DR-005
    (or open a follow-up DR if it warrants more than that).

## Acceptance criteria

- `pnpm test` from the repo root is green; the test count grows
  by at least one row per resumable state plus one row per
  declared `BOSS_REPLY` arm plus one row per new failure mode.
- The conformance test fails immediately if a CODE-N gears
  item declares `needsBossReply` without the FSM state's
  `result` map carrying it, or vice versa.
- The coverage test fails immediately if a state declares
  `needsBossReply` but is not registered with
  `resumableStates(ids)` (so no matching `BOSS_REPLY` arm
  exists in `awaitBossReply`), or if any new
  `awaitBossReply.on.BOSS_REPLY` arm has no exercising
  fixture, or if any transition out of `awaitBossReply` (other
  than the resume arm) lacks `clearBossReplyContext`.
- The prompt-contract test fails immediately if a resumable
  state's composed prompt omits the continuation preamble when
  both context fields are populated, or includes a stale
  preamble when only one is populated.
- The runtime test fails immediately if `handleBossInput` does
  not return from `awaitBossReply`, if plain Boss text in
  `awaitBossReply` does not produce `BOSS_REPLY`, if a slash
  command abandon does not clear both context fields, or if a
  follow-up `needsBossReply` does not clear the prior
  `bossReply`.
- `specs/map.md` lists IR-006 in the Iterations table.
- DR-005 stays Proposed only until task 10; if no substantive
  delta is recorded as an addendum, the close-out commit
  promotes DR-005 to Accepted in the same commit that updates
  map.md.
