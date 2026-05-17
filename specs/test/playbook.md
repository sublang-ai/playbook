<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PLAYBOOK: CODE playbook FSM/GEARS conformance

## Intent

This spec defines integration tests that verify the FSM ↔ GEARS
conformance invariants in [dev/playbook.md](../dev/playbook.md).
The package targets the repo root; the in-repo path is essential
to the package's intent per [META-15](../meta.md#meta-15).

## Source agreement

### PLAYBOOK-7
Verifies: [PLAYBOOK-1](../dev/playbook.md#playbook-1)

When `pnpm test` runs from the repo root, the
test suite shall fail if any captain-invoking state's `sourceItem`
is not a known CODE-N declared in `code.gears.md`, or if any
CODE-N declared in `code.gears.md` has no captain-invoking state
with matching `sourceItem`.

### PLAYBOOK-8
Verifies: [PLAYBOOK-2](../dev/playbook.md#playbook-2)

When `pnpm test` runs, the test suite shall fail if any
captain-invoking state's `input.prompt` body diverges from the
corresponding CODE-N blockquote body in `code.gears.md`.

### PLAYBOOK-9
Verifies: [PLAYBOOK-3](../dev/playbook.md#playbook-3)

When `pnpm test` runs, the test suite shall fail if any
captain-invoking state's `input.player` does not match the section
heading under which the state's `sourceItem` CODE-N is declared in
`code.gears.md`.

## Transition coverage

### PLAYBOOK-10
Verifies: [PLAYBOOK-4](../dev/playbook.md#playbook-4)

When `pnpm test` runs, the test suite shall fail if any declared
`onDone` arm in `code.fsm.ts` lacks an exercising fixture, or if
any declared fixture is unused by the helper's structural
enumeration.

## Prompt composition

### PLAYBOOK-11
Verifies: [PLAYBOOK-5](../dev/playbook.md#playbook-5), [PLAYBOOK-6](../dev/playbook.md#playbook-6)

When `pnpm test` runs, the test suite shall fail if a
captain-invoking state's composed prompt drops a labelled block
whose source field is wired, fails to substitute a declared
placeholder with its wired source field's value, or emits labelled
blocks out of DR-004 §6 order.
