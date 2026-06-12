<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - system behavior

## Intent

This spec defines implementation requirements for the built-in
Playbook Captain shell that runs as the tmux-play Captain and hosts
registered playbook runtimes.
The shell is a meta-level Captain over playbooks; it does not
replace the CODE runtime contract in [PBRT](playbook-runtime.md).

## Registry and shell state

### CAPTAIN-5

Where the package exposes the Playbook Captain shell as a tmux-play
Captain, the shell shall own a registry of playbook entries whose
CODE entry has id `code`, command `code`, intent text for software
development / SDLC coding workflow, idle state id `ready`, final
state id `done`, a `createRuntime` function for the CODE runtime,
and a `validateOptions` function for `captain.options.code`.
The shell shall support one active engagement and shall keep only
a bounded control ledger: active playbook id, latest sub-runtime
state id, pending Boss question when mirrored from telemetry,
normalized last error when mirrored from telemetry, and last route
decision.
The shell shall not duplicate the full Boss conversation in its
ledger.

### CAPTAIN-6

Where the Playbook Captain shell handles Boss turns, the shell FSM
shall model durable modes `chat`, `engaged.driving`, and
`engaged.parked`.
When the shell emits its own FSM telemetry, it shall use topic
`playbook.captain.fsm.state`, not `playbook.fsm.state`.
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
Before passing through `playbook.fsm.state` telemetry, the wrapper
shall mirror the active sub-runtime state and any pending Boss
question or normalized error fields needed for the shell ledger.

## Lifecycle

### CAPTAIN-11

Where the Playbook Captain shell has an active sub-runtime, when
the mirrored sub-runtime state is the registry entry's idle state,
the failed state, or `awaitBossReply`, the shell shall park the
engagement in `engaged.parked`.
Where the Playbook Captain shell has an active sub-runtime, when
the mirrored sub-runtime state is the registry entry's final state
or the router chooses `dismiss`, the shell shall dispose the active
sub-runtime and return to `chat`.
Where the Playbook Captain shell has an active sub-runtime, when
the Boss submits text for the same playbook while it is parked, the
shell shall reuse the existing sub-runtime rather than constructing
a replacement.
