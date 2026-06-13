<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - system behavior

## Intent

This spec defines implementation requirements for the built-in
Playbook Captain shell that runs as the tmux-play Captain and hosts
registered playbook runtimes.
The shell is a meta-level Captain over playbooks; it does not
replace the CODE runtime contract in [PBRT](playbook-runtime.md).
The published `@sublang/playbook` module surface is essential to
this package's intent because tmux-play configs import the shell by
package specifier.

## Registry and shell state

### CAPTAIN-5

Where the package exposes the Playbook Captain shell as a tmux-play
Captain, the shell shall own a registry of playbook entries whose
CODE entry has id `code`, command `code`, intent text for software
development / SDLC coding workflow, idle state id `ready`, final
state id `done`, a `createRuntime` function for the CODE runtime,
copy-paste guard names for CODE inter-player handoffs, optional
state-count labels, and a `validateOptions` function for
`captain.options.code`.
The CODE entry's copy-paste guard names shall be exactly
`accepted`, `approved`, `challengeAccepted`, `challengeRejected`,
`challengesRaised`, `changesMadeCode`,
`changesMadeCodeAndChallenged`, `changesMadeMixed`,
`changesMadeMixedAndChallenged`, `changesMadeSpecs`,
`changesMadeSpecsAndChallenged`, `hasFindings`, `needsRevision`,
`noFindings`, and `noOpenItems`.
These names are CODE FSM guard keys from the state `result` maps
adjudicated under [PBRT-10](playbook-runtime.md#pbrt-10) and
transition-covered under [PLAYBOOK-4](playbook.md#playbook-4).
The shell shall support one active engagement and shall keep only
a bounded control ledger: active playbook id, shell mode, latest
sub-runtime state id, pending Boss question when mirrored from
telemetry, normalized last error when mirrored from telemetry, and
last route decision.
The normalized last error shall carry only `{ name, message }`.
The shell shall not duplicate the full Boss conversation in its
ledger.

### CAPTAIN-6

Where the Playbook Captain shell handles Boss turns, the shell FSM
shall model durable modes `chat`, `engaged.driving`, and
`engaged.parked`.
When the shell emits its own FSM telemetry, it shall use topic
`playbook.captain.fsm.state`, not `playbook.fsm.state`.
The shell FSM telemetry payload shall carry `from`, `to`, `event`,
and a snapshot of the bounded control ledger.
The shell shall put Boss-visible shell state in human-readable
status message text and shall not attach structured data to
shell-owned status emissions; structured shell state shall be
carried through shell FSM telemetry instead.
The shell shall reserve `playbook.fsm.state` for sub-runtime
telemetry that it passes through.

## Routing

### CAPTAIN-7

Where the Playbook Captain shell receives a Boss turn, the shell
shall route by registered command parsing before using hidden
Captain routing.
The hidden router prompt shall receive the bounded ledger plus the
registry command list and intent descriptions, and shall return one
closed decision: `chat`, `dispatch`, `sub`, or `dismiss`.
When the router chooses `dispatch`, the decision shall carry the
target playbook id and text to submit to that playbook.
When the router chooses `sub`, the decision shall carry text for
the active sub-runtime.
The shell shall treat unregistered slash-prefixed text as router
input rather than as a failed command namespace.
The shell shall handle near-miss command-like text as visible chat
clarification rather than as low-confidence dispatch.
When the hidden router reply is malformed, names an unknown
decision, names an unknown playbook id, or omits text required by
the chosen decision, the shell shall produce visible clarification
and shall not dispatch to a sub-runtime.
When the hidden router call returns a non-`ok` status or an `ok`
status without `finalText`, the shell shall produce visible
clarification and shall not dispatch to a sub-runtime.

### CAPTAIN-8

Where the Playbook Captain shell submits text to an engaged
playbook runtime, the shell shall call that runtime's
`handleBossInput` with text and the Boss-turn signal.
The shell shall not pre-classify playbook events, choose
`BOSS_INTERRUPT` targets, expose jumpable state lists through the
registry, or otherwise decide in-playbook FSM events.

## Captain calls and ports

### CAPTAIN-9

Where the Playbook Captain shell uses cligent Captain primitives,
the shell shall use one underlying Captain session for visible
Boss chat, hidden router calls, and hidden sub-runtime judge calls.
Hidden router and sub-runtime judge calls shall pass
`{ visibility: 'hidden' }` to `callCaptain`.
Visible Boss chat shall use a separate prompt envelope that permits
normal conversation and forbids exposing hidden control JSON.
Hidden control calls shall use a prompt envelope that identifies
the call as control work and asks for control JSON only.

### CAPTAIN-10

Where the Playbook Captain shell constructs a sub-runtime, the
shell shall wrap that runtime's `PlaybookPorts`.
The wrapper shall route `callPlayer` to `context.callPlayer`, route
sub-runtime `callJudge` to hidden `context.callCaptain`, and pass
sub-runtime `emitStatus` and `emitTelemetry` calls through to the
host in order.
When hidden `context.callCaptain` returns a non-`ok` status or an
`ok` status without `finalText`, the wrapper shall throw for that
sub-runtime `callJudge`; otherwise it shall return `finalText`.
Before passing through `playbook.fsm.state` telemetry, the wrapper
shall mirror the active sub-runtime state and any pending Boss
question or normalized error fields needed for the shell ledger.

### CAPTAIN-20

Where the Playbook Captain shell submits text to an engaged
playbook runtime, the shell shall collect turn-summary counts only
for the duration of that sub-runtime `handleBossInput` call.
For that same duration, the shell shall aggregate sub-runtime
`playbook.fsm.state` telemetry into a state-count phrase for the
turn-summary prompt, excluding the active registry entry's idle and
final state ids.
The state-count phrase shall be `none` when no counted state
occurred.
When the active registry entry provides a state-count label for a
state id, the shell shall count that state under the provided
label.
When the active registry entry does not provide a state-count label
for a state id, the shell shall derive a fallback label by
splitting camel-case / delimiter-separated words and counting the
state as `<words> state`, omitting the duplicate suffix when the
words already end in `state`.
When a wrapped sub-runtime `callPlayer` call returns a player
reply, the shell shall count one saved interruption for that reply.
When a wrapped hidden sub-runtime adjudication call returns a guard
whose name appears in the active playbook registry entry's
copy-paste guard names, the shell shall count one saved copy-paste
for that inter-player handoff.
The shell shall count one saved copy-paste per adjudicated
handoff, regardless of how many individual review findings or
rebuttal items the handoff text contains.
Each playbook registry entry shall own its exact copy-paste guard
names.
The shell shall derive copy-paste eligibility from the active
playbook registry entry's copy-paste guard names, so an adjudicated
guard removed from that registry list is not counted.
The shell shall not count hidden router calls, visible chat calls,
sub-runtime classifier/event JSON, or malformed adjudication
replies as saved copy-pastes.
After the sub-runtime `handleBossInput` call settles, the shell
shall make one visible Captain call with a turn-summary prompt
envelope.
The turn-summary prompt envelope shall provide the exact saved
interruption and copy-paste counts, shall provide the aggregate
state-count phrase, and shall instruct Captain to write the
Boss-visible block required by
[CAPTAIN-19](../user/playbook-captain.md#captain-19), including the
paragraph prefix `Saved you: X interruptions and Y copy-pastes`
with the supplied counts.

## Lifecycle

### CAPTAIN-11

Where the Playbook Captain shell has an active sub-runtime, when
the mirrored sub-runtime state is the registry entry's idle state,
the linker-level literal state id `failed`, or the linker-level
literal state id `awaitBossReply`, the shell shall park the
engagement in `engaged.parked`.
Where the Playbook Captain shell has an active sub-runtime, when
the mirrored sub-runtime state is the registry entry's final state
or the router chooses `dismiss`, the shell shall dispose the active
sub-runtime and return to `chat`.
When the mirrored sub-runtime state is the registry entry's final
state during a dispatched Boss turn, the shell shall defer disposal
until that sub-runtime `handleBossInput` call settles.
Where the Playbook Captain shell has an active sub-runtime, when
the Boss submits text for the same playbook while it is parked, the
shell shall reuse the existing sub-runtime rather than constructing
a replacement.
Where the Playbook Captain shell has no active sub-runtime, when a
registered command or router decision engages a playbook id, the
shell shall construct a new sub-runtime from that registry entry's
`createRuntime` function and the validated options captured during
`init`.
Where the Playbook Captain shell has disposed an active sub-runtime
because it reached its final state or was dismissed, when a later
registered command or router decision engages the same playbook id,
the shell shall construct a replacement sub-runtime.

## Adapter lifecycle

### CAPTAIN-16

Where tmux-play calls the Playbook Captain shell adapter's
`init(session)`, the shell shall store the session, derive any
session-scoped registry bindings from `session.players`, validate
registered options, enter `chat`, and not construct a sub-runtime.
When registered option validation fails during `init(session)`, the
shell shall reject `init`.
Where tmux-play calls `handleBossTurn(turn, context)` after `init`,
the shell shall route `turn.prompt` with `context.signal` and use
`context` as the active per-turn target for player and Captain
calls until that turn settles.
When tmux-play calls `handleBossTurn(turn, context)` before
`init(session)`, the shell shall reject the call.
Where tmux-play calls `dispose()`, the shell shall dispose any
active sub-runtime, clear the active turn context, emit no shell
status or shell FSM telemetry for the adapter teardown itself, and
resolve only after the active sub-runtime's `dispose()` call
returns.

## Public module surface

### CAPTAIN-17

Where `@sublang/playbook` exposes the Playbook Captain shell for
tmux-play, the package shall expose the public module specifier
`@sublang/playbook/playbook-captain`.
That module's default export shall be a tmux-play Captain factory
for the Playbook Captain shell with CODE registered.
