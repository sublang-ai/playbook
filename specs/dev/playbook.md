<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PLAYBOOK: CODE playbook FSM/GEARS conformance

## Intent

This spec pins the conformance contract between the CODE playbook's
emitted state machine (`code.fsm.ts`)
and its canonical source
(`code.gears.md`).
The two in-repo file paths are essential to the package's intent
per [META-15](../meta.md#meta-15); the package shall not be reused
outside this project.

## Source agreement

### PLAYBOOK-1

The set of CODE-N identifiers declared in `code.gears.md` under
`### CODE-N` headings shall equal the set of `sourceItem` values
across captain-invoking states in `code.fsm.ts`.

### PLAYBOOK-2

Where a captain-invoking state references CODE-N via `sourceItem`,
the state's `input.prompt` body shall equal the CODE-N blockquote
body in `code.gears.md` verbatim, including any `<#>`,
`<coder-llm>`, and `<reviewer-llm>` placeholder tokens.

### PLAYBOOK-3

Where a captain-invoking state references CODE-N via `sourceItem`,
the state's `input.player` shall equal the section heading
(`Coder` / `Reviewer` / `Committer`) under which CODE-N is declared
in `code.gears.md`.

## Transition coverage

### PLAYBOOK-4

Where `code.fsm.ts` declares an `onDone` arm for a captain-invoking
state, the arm shall be exercisable by some
`(context, CaptainOutput)` pair that satisfies its guard and
falsifies every earlier arm in the same state's `onDone` list,
honoring xstate's first-match-wins semantics.

## Prompt composition

### PLAYBOOK-5

Where a captain-invoking state wires a structured field (`intent`,
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

### PLAYBOOK-6

Where a captain-invoking state's prompt body contains a placeholder
(`<#>`, `<coder-llm>`, or `<reviewer-llm>`), the state shall wire
the corresponding source field (`irNumber`, `coderPlayer`, or
`reviewerPlayer`) into the `CaptainInput`, and the composer shall
substitute the placeholder with the wired field's value.

### PLAYBOOK-16

Every Reviewer captain-invoking prompt in `code.gears.md` and
`code.fsm.ts` shall include the line
`Do not edit files or commit; report findings only.`.

## Boss-reply suspension

### PLAYBOOK-12

Every captain-invoking state shall declare `needsBossReply` in its
`result` map (per
[slc/gears2fsm.md "Boss-reply suspension"](../../slc/gears2fsm.md#boss-reply-suspension)),
and the FSM shall declare a matching arm in
`awaitBossReply.on.BOSS_REPLY` guarded on
`context.pendingBossQuestion?.resumeStateId === '<state-id>'`
that targets `'#<state-id>'` with `reenter: true`.

### PLAYBOOK-13

For every captain-invoking state, every
non-`needsBossReply` arm in that state's `onDone` shall carry
`actions: clearBossReplyContext`. Where the FSM declares the
`awaitBossReply` state, every transition out of it other than a
`BOSS_REPLY` resume arm shall carry
`actions: clearBossReplyContext`.
