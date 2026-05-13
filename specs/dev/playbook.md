<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PLAYBOOK: CODE playbook FSM/GEARS conformance

## Intent

This spec pins the conformance contract between the CODE playbook's
emitted state machine (`reference/sdlc/code.playbook/code.fsm.ts`)
and its canonical source
(`reference/sdlc/code.playbook/code.gears.md`).
The two in-repo file paths are essential to the package's intent
per [META-15](../meta.md#meta-15); the package shall not be reused
outside this project.

## Source agreement

### PLAYBOOK-1

Where `code.fsm.ts` declares a captain-invoking state, the state's
`sourceItem` shall be a CODE-N identifier declared in
`code.gears.md` under a `### CODE-N` heading.

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
`reviews`, `challenges`, or `taskDescription`) into the
`CaptainInput`, the composer shall prepend a labelled block
(`Boss intent:`, `Review items:`, `Rebuttals:`, or
`Task description:`) carrying that field's value, ordered
Boss intent → Review items → Rebuttals → Task description →
prompt body.

### PLAYBOOK-6

Where a captain-invoking state's prompt body contains a placeholder
(`<#>`, `<coder-llm>`, or `<reviewer-llm>`), the state shall wire
the corresponding source field (`irNumber`, `coderPlayer`, or
`reviewerPlayer`) into the `CaptainInput`, and the composer shall
substitute the placeholder with the wired field's value.
