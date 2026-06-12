<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - integration tests

## Intent

This spec defines integration tests for the built-in Playbook
Captain shell under tmux-play.
The tests drive the real shell adapter with CODE registered against
stubbed cligent Captain primitives and fake or real CODE runtime
ports as needed.

## Routing

### CAPTAIN-12
Verifies: [CAPTAIN-1](../user/playbook-captain.md#captain-1), [CAPTAIN-2](../user/playbook-captain.md#captain-2), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-8](../dev/playbook-captain.md#captain-8)

Where the test suite drives the Playbook Captain shell with CODE
registered, while no playbook is engaged and while CODE is already
engaged, the test suite shall fail unless `/code <text>` dispatches
to CODE with `<text>`, bare `/code` produces visible chat without
resetting an existing CODE runtime, unregistered slash-prefixed and
near-miss command-like inputs reach hidden routing rather than a
negative command path, a different registered command while CODE is
engaged produces visible resolution guidance without dispatch, and
every dispatch to CODE calls `handleBossInput` with text rather
than a pre-classified FSM event.

### CAPTAIN-13
Verifies: [CAPTAIN-1](../user/playbook-captain.md#captain-1), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-9](../dev/playbook-captain.md#captain-9)

Where the test suite drives ordinary Boss text through the Playbook
Captain shell, the test suite shall fail unless hidden router
decisions `chat`, `dispatch`, `sub`, and `dismiss` are parsed as
closed decisions, invalid router JSON degrades to visible
clarification without sub-runtime dispatch, every hidden router
call passes `{ visibility: 'hidden' }`, and visible chat calls use
a separate envelope that does not request or expose control JSON.

## Lifecycle and telemetry

### CAPTAIN-14
Verifies: [CAPTAIN-3](../user/playbook-captain.md#captain-3), [CAPTAIN-4](../user/playbook-captain.md#captain-4), [CAPTAIN-6](../dev/playbook-captain.md#captain-6), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), [CAPTAIN-11](../dev/playbook-captain.md#captain-11)

Where the test suite drives CODE under the Playbook Captain shell,
the test suite shall fail unless sub-runtime status and telemetry
are passed through in order, `playbook.fsm.state` telemetry is
mirrored into the shell ledger before pass-through, shell FSM
telemetry uses `playbook.captain.fsm.state`, CODE idle / failed /
`awaitBossReply` states park the engagement, a later same-playbook
turn resumes the same runtime instance, CODE final state disposes
the engagement, and router `dismiss` disposes the engagement and
returns the shell to chat.

## Registry and options

### CAPTAIN-15
Verifies: [CAPTAIN-5](../dev/playbook-captain.md#captain-5), [CAPTAIN-9](../dev/playbook-captain.md#captain-9), [CAPTAIN-10](../dev/playbook-captain.md#captain-10)

Where the test suite initializes the Playbook Captain shell with
CODE registered, the test suite shall fail unless the CODE registry
entry is present with id `code`, command `code`, idle state `ready`,
and final state `done`; CODE option validation is delegated to the
CODE registry entry; CODE player calls reach `context.callPlayer`;
CODE judge calls reach `context.callCaptain` with
`{ visibility: 'hidden' }`; and all shell chat, routing, and
sub-runtime judge calls use the same Captain session primitives.
