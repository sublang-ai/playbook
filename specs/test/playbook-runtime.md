<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: CODE playbook runtime — integration tests

## Intent

This spec defines the integration tests that verify the CODE
playbook runtime and its tmux-play host adapter behaviors in
[dev/playbook-runtime.md](../dev/playbook-runtime.md). Each test
drives the real FSM through the runtime — or the real adapter and
runtime together — against fake `PlaybookPorts` or stubbed cligent
primitives. The package targets the repo root; the in-repo path
is essential to the package's intent per
[META-15](../meta.md#meta-15).

## Runtime

### PBRT-17
Verifies: [PBRT-11](../dev/playbook-runtime.md#pbrt-11)

When a `/start` turn is driven through `createPlaybookRuntime`
with fake ports that return a valid guard from the judge, the
test suite shall fail unless `handleBossInput` drives the FSM
through one captain invocation and returns with the FSM at the
idle state.

### PBRT-18
Verifies: [PBRT-13](../dev/playbook-runtime.md#pbrt-13)

When the per-turn `signal` aborts mid-`callPlayer`, the test suite
shall fail unless the runtime drives the FSM to the failure state
with `lastError` populated and returns from the turn.

### PBRT-19
Verifies: [PBRT-11](../dev/playbook-runtime.md#pbrt-11)

When an `/interrupt <stateId>` turn is driven through the runtime,
the test suite shall fail unless the FSM is redirected to the
named state and `handleBossInput` returns.

### PBRT-20
Verifies: [PBRT-14](../dev/playbook-runtime.md#pbrt-14)

When a Boss turn is driven through the runtime, the test suite
shall fail unless: telemetry is emitted for every transition
under the `playbook.fsm.state` topic; the four-glyph Captain-pane
status emits cover the Boss-input echo, every captain-invoking
state entry (with label + player + CODE-N + any populated rider
field), every transition guard that drove an entry (with payload
item tallies when applicable), and the idle / failure / terminal
markers; the failure-state status carries `lastError`; and
emissions are observed in enqueue order.

## Host adapter

### PBRT-21
Verifies: [PBRT-4](../user/playbook-runtime.md#pbrt-4), [PBRT-15](../dev/playbook-runtime.md#pbrt-15), [PBRT-16](../dev/playbook-runtime.md#pbrt-16)

When the tmux-play adapter is driven through an
`init` → `handleBossTurn` → `dispose` lifecycle with stubbed
cligent `CaptainContext` / `CaptainSession` primitives, the test
suite shall fail unless player calls reach `context.callRole`
with role ids matching the runtime's baked player ids (both
`coder` via the `/start` happy path and `reviewer` via a
multi-stage flow that drives the FSM through a Reviewer state),
adjudication reaches `context.callCaptain`, status and telemetry
reach the session, the per-turn `signal` flows into the runtime,
and `handleBossTurn` invoked before `init` rejects.

## Lifecycle and captain bridge

### PBRT-22
Verifies: [PBRT-6](../dev/playbook-runtime.md#pbrt-6)

When the runtime is constructed by `createPlaybookRuntime`, `init`
is awaited, `handleBossInput` is invoked before `init` on a
separate runtime instance, and `dispose` is called on a started
runtime, the test suite shall fail unless `init` starts the actor
at the idle state, the pre-`init` `handleBossInput` call rejects,
`dispose` stops the actor, and `dispose` awaits any pending port
emissions before resolving.

### PBRT-23
Verifies: [PBRT-9](../dev/playbook-runtime.md#pbrt-9), [PBRT-10](../dev/playbook-runtime.md#pbrt-10)

When the runtime's captain bridge is driven as an xstate actor
under fake ports, the test suite shall fail unless:

- `PlayerResult` `status='ok'` with `finalText` advances the FSM
  through `onDone`;
- `status='ok'` without `finalText`, `status='aborted'`, and
  `status='error'` each route the FSM to the failure state
  through `onError`;
- a `callJudge` reply that is malformed JSON, names an
  undeclared guard, or omits a required payload field also
  routes the FSM to the failure state.

## Classification and flow

### PBRT-24
Verifies: [PBRT-1](../user/playbook-runtime.md#pbrt-1)

When the integration suite drives `/start <intent>`,
`/continue <#>`, `/summarize <#>`, and `/interrupt <stateId>`
turns through `handleBossInput`, the test suite shall fail unless
each form maps to its declared FSM event with the trailing text
extracted as the payload.

### PBRT-25
Verifies: [PBRT-2](../user/playbook-runtime.md#pbrt-2), [PBRT-7](../dev/playbook-runtime.md#pbrt-7)

When the runtime is driven through `handleBossInput` with
non-slash text, with a classifier reply that names no valid event
type, with a classifier reply that names a valid event type but
omits a required payload field, with `/interrupt` lacking a
target state, and with empty or whitespace-only text, the test
suite shall fail unless non-slash text routes through `callJudge`
and lands on the classifier-named FSM event, each invalid reply
surfaces one `emitStatus` call and leaves the FSM unmoved,
`/interrupt` without a target state surfaces one `emitStatus`
call and leaves the FSM unmoved, and empty text makes no port
calls.

### PBRT-26
Verifies: [PBRT-8](../dev/playbook-runtime.md#pbrt-8)

When the runtime is driven through full multi-stage Boss turns
that reach each captain-invoking state involved in player
binding — the single-commit flow (Coder, Committer CODE-15,
Reviewer, ending at the terminal state), the Reviewer-cleared
flow (CODE-16 with only `reviewerPlayer` populated), and the
joint-commit flow (CODE-17 with both `coderPlayer` and
`reviewerPlayer` populated) — the test suite shall fail unless
each captain invocation resolves to the expected `playerId`:
`coder` for Coder, `reviewer` for Reviewer, `coder` for CODE-15,
`reviewer` for CODE-16, and `coder` for CODE-17.

### PBRT-27
Verifies: [PBRT-12](../dev/playbook-runtime.md#pbrt-12)

When the runtime is driven to the FSM's terminal state and a
further Boss turn is submitted, the test suite shall fail unless
the runtime disposes and reconstructs the actor so the new turn
is processed from the idle state.
