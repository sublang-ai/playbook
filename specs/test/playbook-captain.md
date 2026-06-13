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
engaged produces visible resolution guidance without dispatch,
ordinary text while CODE is engaged, including while parked, routes
through hidden router decisions, and every dispatch to CODE calls
`handleBossInput` with text rather than a pre-classified FSM event.

### CAPTAIN-13
Verifies: [CAPTAIN-1](../user/playbook-captain.md#captain-1), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-9](../dev/playbook-captain.md#captain-9)

Where the test suite drives ordinary Boss text through the Playbook
Captain shell, the test suite shall fail unless hidden router
decisions `chat`, `dispatch`, `sub`, and `dismiss` are parsed as
closed decisions, invalid router JSON, non-`ok` router calls, and
`ok` router calls without `finalText` degrade to visible
clarification without sub-runtime dispatch, every hidden router
call passes `{ visibility: 'hidden' }`, and visible chat calls use
a separate envelope that does not request or expose control JSON.

## Lifecycle and telemetry

### CAPTAIN-14
Verifies: [CAPTAIN-3](../user/playbook-captain.md#captain-3), [CAPTAIN-4](../user/playbook-captain.md#captain-4), [CAPTAIN-6](../dev/playbook-captain.md#captain-6), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), [CAPTAIN-11](../dev/playbook-captain.md#captain-11), [CAPTAIN-16](../dev/playbook-captain.md#captain-16)

Where the test suite drives CODE under the Playbook Captain shell,
the test suite shall fail unless sub-runtime status and telemetry
are passed through in order, `playbook.fsm.state` telemetry is
mirrored into the shell ledger before pass-through, shell FSM
telemetry uses `playbook.captain.fsm.state` with `from`, `to`,
`event`, and ledger fields, CODE idle / failed /
`awaitBossReply` states park the engagement, a later same-playbook
turn resumes the same runtime instance, CODE final state disposes
the engagement only after the active turn settles, and router
`dismiss` disposes the engagement and returns the shell to chat;
a later dispatch after final disposal or dismissal constructs a
replacement runtime; engagement, dismissal, and final-disposal
status lines use the registered slash command in the
`◇ /<command> started`, `◇ /<command> stopped`, and
`◇ /<command> finished` vocabulary and carry no structured status
data; and shell `dispose()` disposes any active runtime without
emitting shell status or shell FSM telemetry for adapter teardown.

## Registry and options

### CAPTAIN-15
Verifies: [CAPTAIN-5](../dev/playbook-captain.md#captain-5), [CAPTAIN-9](../dev/playbook-captain.md#captain-9), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), [CAPTAIN-16](../dev/playbook-captain.md#captain-16)

Where the test suite initializes the Playbook Captain shell with
CODE registered, the test suite shall fail unless the CODE registry
entry is present with id `code`, command `code`, idle state `ready`,
and final state `done`; CODE option validation is delegated to the
CODE registry entry during shell `init`; invalid CODE options cause
`init` to reject; valid CODE options do not construct a runtime
until engagement; `handleBossTurn` before `init` rejects; CODE
player calls reach `context.callPlayer`;
CODE judge calls reach `context.callCaptain` with
`{ visibility: 'hidden' }`; and all Captain chat, routing, and
sub-runtime judge calls use the same Captain session primitives.

## Public module surface

### CAPTAIN-18
Verifies: [CAPTAIN-17](../dev/playbook-captain.md#captain-17)

Where the test suite resolves `@sublang/playbook` through its
package exports, the test suite shall fail unless
`@sublang/playbook/playbook-captain` resolves and default-exports
a tmux-play Captain factory for the Playbook Captain shell with
CODE registered.

## Turn summary

### CAPTAIN-21
Verifies: [CAPTAIN-19](../user/playbook-captain.md#captain-19), [CAPTAIN-20](../dev/playbook-captain.md#captain-20)

Where the test suite drives the Playbook Captain shell with a
registered playbook runtime, the test suite shall fail unless a
visible Captain turn-summary call is made after registered-command,
hidden-router `dispatch`, and hidden-router `sub` submissions
settle and after the sub-runtime's ordered status and telemetry
emissions for the turn; no turn-summary call is made after Captain
chat, clarification, bare playbook selection, or routing failure
recovery turns that do not submit to a sub-runtime; the
turn-summary prompt contains the exact supplied saved-counts line
`Saved you X interruptions and Y copy-pastes across Z rounds of reviews/rebuttals.`
with natural singular forms when a count is one; completed
sub-runtime player replies increment the interruption count by one
per reply; adjudicated guards named by the active playbook registry
entry's copy-paste guard list increment the copy-paste count by one
per handoff; guards absent from that registry list,
classifier/event JSON, hidden router calls, visible chat, and
malformed adjudication replies do not increment the copy-paste
count; sub-runtime state telemetry during the turn contributes only
an aggregate summary-visible progress phrase and round total,
counting active registry entry labels exactly as supplied and
deriving no fallback label from state ids; unlabeled plan or
implementation steps, tests-green state ids, and other internal
states do not contribute to that phrase or total; and the prompt
instructs Captain to render a brief what-was-done summary, without
raw state /
transition / guard names, internal state counts, or how-it-was-done
narration, and without shell ledger JSON, followed by the
saved-counts line in a natural chat-like tone with clear
formatting.
