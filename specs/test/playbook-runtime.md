<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: CODE playbook runtime — integration tests

## Intent

This spec defines the integration tests that verify the CODE
playbook runtime and its tmux-play host adapter behaviors in
[dev/playbook-runtime.md](../dev/playbook-runtime.md). Each test
drives the real FSM through the runtime — or the real adapter and
runtime together — against fake `PlaybookPorts` or stubbed cligent
primitives. The package targets `reference/sdlc/code.playbook/`;
the in-repo path is essential to the package's intent per
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
shall fail unless telemetry is emitted for every transition under
the `playbook.fsm.state` topic, status is emitted only for
Boss-relevant states, the failure-state status carries
`lastError`, and emissions are observed in enqueue order.

## Host adapter

### PBRT-21
Verifies: [PBRT-4](../user/playbook-runtime.md#pbrt-4), [PBRT-15](../dev/playbook-runtime.md#pbrt-15), [PBRT-16](../dev/playbook-runtime.md#pbrt-16)

When the tmux-play adapter is driven through an
`init` → `handleBossTurn` → `dispose` lifecycle with stubbed
cligent `CaptainContext` / `CaptainSession` primitives, the test
suite shall fail unless player calls reach `context.callRole`
with role ids matching the runtime's baked player ids,
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
and `dispose` stops the actor.

### PBRT-23
Verifies: [PBRT-9](../dev/playbook-runtime.md#pbrt-9)

When the runtime's captain bridge is driven as an xstate actor
under fake ports that return a `PlayerResult` for each status
kind, the test suite shall fail unless `status='ok'` causes the
bridge to call `callPlayer` and `callJudge` and advance the FSM
through `onDone`, while `status='aborted'` and `status='error'`
each route the FSM to the failure state through `onError`.

## Coverage gaps

> **Missing test.** [PBRT-12](../dev/playbook-runtime.md#pbrt-12)
> (dispose-and-reconstruct on a Boss turn that arrives while the
> FSM is in the terminal state) has no integration test. No
> existing test drives the FSM to the terminal state and then
> submits a further turn.

> **Partial coverage.** [PBRT-1](../user/playbook-runtime.md#pbrt-1):
> the suite exercises only the `/start` mapping
> ([PBRT-17](#pbrt-17)) and the `/interrupt` mapping
> ([PBRT-19](#pbrt-19)) through the runtime; the `/continue` and
> `/summarize` mappings have no integration test.

> **Partial coverage.** [PBRT-2](../user/playbook-runtime.md#pbrt-2)
> and [PBRT-7](../dev/playbook-runtime.md#pbrt-7): the suite
> includes a test asserting that an unrecognized slash command
> through the runtime produces one `emitStatus` call and leaves
> the FSM unmoved, but it is not currently specced as a
> standalone test item; the non-slash judge-classification route,
> invalid judge replies, `/interrupt` with no target state, and
> empty input have no integration test.

> **Partial coverage.** [PBRT-4](../user/playbook-runtime.md#pbrt-4):
> [PBRT-21](#pbrt-21) exercises only the `coder` routing path
> through the adapter (the adapter integration scenarios all
> drive `/start` turns, which the FSM routes to a Coder
> invocation). The `reviewer` routing path has no integration
> test.

> **Partial coverage.** [PBRT-6](../dev/playbook-runtime.md#pbrt-6):
> [PBRT-22](#pbrt-22) verifies that `init` starts the actor at
> the idle state, pre-`init` `handleBossInput` rejects, and
> `dispose` stops the actor. The dispose-drains-pending-port-
> emissions sub-clause has no direct integration test (the
> drainer is exercised mid-turn by [PBRT-20](#pbrt-20), but not
> on dispose).

> **Partial coverage.** [PBRT-8](../dev/playbook-runtime.md#pbrt-8):
> [PBRT-17](#pbrt-17) and [PBRT-23](#pbrt-23) exercise only the
> `Coder → coder` mapping. `Reviewer → reviewer` and the
> `Committer` composite resolutions are not reachable through the
> existing integration scenarios (which do not drive the FSM past
> `planAndImplement`) and have no integration test.

> **Partial coverage.** [PBRT-9](../dev/playbook-runtime.md#pbrt-9):
> [PBRT-23](#pbrt-23) exercises the captain bridge under
> `PlayerResult` `status='ok'` with `finalText`, `status='aborted'`,
> and `status='error'`. The `status='ok'` with absent `finalText`
> case — which the contract also routes through the FSM's error
> path — has no integration test.

> **Partial coverage.** [PBRT-10](../dev/playbook-runtime.md#pbrt-10):
> [PBRT-17](#pbrt-17) and [PBRT-23](#pbrt-23) exercise only the
> happy adjudication path (the judge returns a valid guard and
> the FSM advances). The fail-loud paths — malformed JSON, an
> undeclared guard, or an omitted required payload field driving
> the FSM to the failure state — have no integration test.
