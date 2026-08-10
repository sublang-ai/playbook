<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook: CODE Playbook Conformance

## Intent

This project-local package specifies and verifies agreement among the maintained CODE source, its GEARS and FSM artifacts, and its compiled prompts and transitions.

## External Behavior

### Source agreement

#### playbook-1

The set of CODE-N identifiers declared in `code.gears.md` under
`### CODE-N` headings shall equal the set of `sourceItem` values
across player-invoking states in `code.fsm.ts`.

#### playbook-2

Where a player-invoking state references CODE-N via `sourceItem`,
the state's `input.prompt` body shall equal the CODE-N blockquote
body in `code.gears.md` verbatim, including any `<#>`,
`<coder-llm>`, and `<reviewer-llm>` placeholder tokens.

#### playbook-3

Where a player-invoking state references CODE-N via `sourceItem`,
the state's `input.player` shall equal the section heading
(`Coder` / `Reviewer` / `Committer`) under which CODE-N is declared
in `code.gears.md`.
A configured Committer alias
([[playbook-runtime-8](playbook-runtime.md#playbook-runtime-8)]) changes only the player id
`resolvePlayerId` returns for a `Committer` state; it shall not
change `input.player`, which stays `Committer` for every
Committer-section CODE-N, so the gears `Committer = Coder |
Reviewer` agreement holds.

### Transition coverage

#### playbook-4

Where `code.fsm.ts` declares an `onDone` arm for a player-invoking
state, the arm shall be exercisable by some
`(context, CaptainOutput)` pair that satisfies its guard and
falsifies every earlier arm in the same state's `onDone` list,
honoring xstate's first-match-wins semantics.

### Prompt composition

#### playbook-5

Where a player-invoking state wires a structured field (`intent`,
`taskDescription`, `reviews`, or `challenges`) into the
`CaptainInput`, the composer shall emit a labelled block
(`Boss intent:`, `Task description:`, `Review items:`, or
`Rebuttals:`) carrying that field's value, ordered
Boss intent → Task description → prompt body → Review items →
Rebuttals. Context blocks the prompt body refers to as prior
material (`Boss intent:`, `Task description:`) precede the body;
action blocks the prompt body refers to as material below
(`Review items:`, `Rebuttals:`) follow the body so the CODE-N
"review item below" / "rebuttal below" phrasing matches the
rendered layout.

#### playbook-6

Where a player-invoking state's prompt body contains a placeholder
(`<#>`, `<coder-llm>`, or `<reviewer-llm>`), the state shall wire
the corresponding source field (`irNumber`, `coderPlayer`, or
`reviewerPlayer`) into the `CaptainInput`, and the composer shall
substitute the placeholder with the wired field's value.

#### playbook-16

Every Reviewer player-invoking prompt in `code.gears.md` and
`code.fsm.ts` shall include the line
`Do not edit files or commit; report findings only.`.

#### playbook-18

Where a Reviewer player-invoking prompt in `code.gears.md` or
`code.fsm.ts` includes `Verify any affected spec items are:`,
the prompt shall include the complete spec-review checklist:

- `Complete & coherent: sufficient for you to reimplement code.`
- `Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.`
- `Minimal: essential and concise; every item earns its place; also check with other items.`
- `Well organized: spec packages are finely scoped, with high cohesion and low coupling.`

The prompt shall not include either legacy line
`Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.` or
`Right level: user requirements (in @specs/user) or behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.`
([DR-020](../decisions/020-spec-layout-agnostic-code-prompts.md)).

### Boss-reply suspension

#### playbook-12

Every player-invoking state shall declare `needsBossReply` in its
`result` map (per
[slc/gears2fsm.md "Boss-reply suspension"](../../slc/gears2fsm.md#boss-reply-suspension)),
and the FSM shall declare a matching arm in
`awaitBossReply.on.BOSS_REPLY` guarded on
`context.pendingBossQuestion?.resumeStateId === '<state-id>'`
that targets `'#<state-id>'` with `reenter: true`.

#### playbook-13

For every player-invoking state, every
non-`needsBossReply` arm in that state's `onDone` shall carry
`actions: clearBossReplyContext`. Where the FSM declares the
`awaitBossReply` state, every transition out of it other than a
`BOSS_REPLY` resume arm shall carry
`actions: clearBossReplyContext`.

## Verification

### Source Agreement Coverage

#### playbook-7

When `pnpm test` runs from the repo root, the
test suite shall fail if any player-invoking state's `sourceItem`
is not a known CODE-N declared in `code.gears.md`, or if any
CODE-N declared in `code.gears.md` has no player-invoking state
with matching `sourceItem` (verifying [[playbook-1](#playbook-1)]).

#### playbook-8

When `pnpm test` runs, the test suite shall fail if any
player-invoking state's `input.prompt` body diverges from the
corresponding CODE-N blockquote body in `code.gears.md` (verifying [[playbook-2](#playbook-2)]).

#### playbook-9

When `pnpm test` runs, the test suite shall fail if any
player-invoking state's `input.player` does not match the section
heading under which the state's `sourceItem` CODE-N is declared in
`code.gears.md` (verifying [[playbook-3](#playbook-3)]).

### Verification transition coverage

#### playbook-10

When `pnpm test` runs, the test suite shall fail if any declared
`onDone` arm in `code.fsm.ts` lacks an exercising fixture, or if
any declared fixture is unused by the helper's structural
enumeration (verifying [[playbook-4](#playbook-4)]).

### Prompt Composition Coverage

#### playbook-11

When `pnpm test` runs, the test suite shall fail if a
player-invoking state's composed prompt drops a labelled block
whose source field is wired, fails to substitute a declared
placeholder with its wired source field's value, or emits labelled
blocks out of DR-004 §6 order (verifying [[playbook-5](#playbook-5)], [[playbook-6](#playbook-6)]).

#### playbook-17

When `pnpm test` runs, the test suite shall fail if any Reviewer
player-invoking prompt in `code.gears.md` or `code.fsm.ts` omits
the review-only instruction that forbids editing files or
committing (verifying [[playbook-16](#playbook-16)]).

#### playbook-19

When `pnpm test` runs, the test suite shall fail if any Reviewer
player-invoking prompt in `code.gears.md` or `code.fsm.ts` asks
Reviewer to verify affected spec items but omits any item from the
current spec-review checklist, or if it includes either retired
`Right level` wording that names the legacy
`@specs/{user,dev,test}` folders (verifying [[playbook-18](#playbook-18)]).

### Boss-reply Suspension Coverage

#### playbook-14

When `pnpm test` runs, the test suite shall fail if any
player-invoking state does not declare `needsBossReply` in its
`result` map, if any player-invoking state lacks a matching arm
in `awaitBossReply.on.BOSS_REPLY` keyed by `resumeStateId`, or
if any arm in `awaitBossReply.on.BOSS_REPLY` targets a state that
is not player-invoking or does not declare `needsBossReply` (verifying [[playbook-12](#playbook-12)]).

#### playbook-15

When `pnpm test` runs, the test suite shall fail if any
non-`needsBossReply` arm in a player-invoking state's `onDone` omits
`actions: clearBossReplyContext`, or if any transition out of
`awaitBossReply` other than its `BOSS_REPLY` resume arm omits
`actions: clearBossReplyContext` (verifying [[playbook-13](#playbook-13)]).
