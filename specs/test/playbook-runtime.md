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
Verifies: [PBRT-6](../dev/playbook-runtime.md#pbrt-6), [PBRT-8](../dev/playbook-runtime.md#pbrt-8), [PBRT-9](../dev/playbook-runtime.md#pbrt-9), [PBRT-10](../dev/playbook-runtime.md#pbrt-10), [PBRT-11](../dev/playbook-runtime.md#pbrt-11)

When a `/start` turn is driven through `createPlaybookRuntime`
with fake ports, the test suite shall fail unless the runtime
advances the FSM through one captain invocation — calling
`callPlayer` for the `coder` player and then `callJudge` — and
`handleBossInput` returns with the FSM at a quiescent state.

### PBRT-18
Verifies: [PBRT-13](../dev/playbook-runtime.md#pbrt-13), [PBRT-14](../dev/playbook-runtime.md#pbrt-14)

When the per-turn `signal` aborts mid-`callPlayer`, the test suite
shall fail unless the runtime drives the FSM to the failure state
with `lastError` populated and returns from the turn.

### PBRT-19
Verifies: [PBRT-1](../user/playbook-runtime.md#pbrt-1), [PBRT-2](../user/playbook-runtime.md#pbrt-2), [PBRT-7](../dev/playbook-runtime.md#pbrt-7)

When an `/interrupt <stateId>` turn is driven through the runtime,
the test suite shall fail unless the FSM is redirected to the
named state; when an unrecognized slash command is driven through
the runtime, the test suite shall fail unless a status is surfaced
and the FSM is left unmoved.

### PBRT-20
Verifies: [PBRT-14](../dev/playbook-runtime.md#pbrt-14)

When a Boss turn is driven through the runtime, the test suite
shall fail unless telemetry is emitted for every transition under
the `playbook.fsm.state` topic, status is emitted only for
Boss-relevant states, the failure-state status carries
`lastError`, and emissions are observed in enqueue order.

## Host adapter

### PBRT-21
Verifies: [PBRT-15](../dev/playbook-runtime.md#pbrt-15), [PBRT-16](../dev/playbook-runtime.md#pbrt-16)

When the tmux-play adapter is driven through an
`init` → `handleBossTurn` → `dispose` lifecycle with stubbed
cligent `CaptainContext` / `CaptainSession` primitives, the test
suite shall fail unless player calls reach `context.callRole`,
adjudication reaches `context.callCaptain`, status and telemetry
reach the session, the per-turn `signal` flows into the runtime,
and `handleBossTurn` invoked before `init` rejects.

## Coverage gaps

> **Missing test.** [PBRT-12](../dev/playbook-runtime.md#pbrt-12)
> (dispose-and-reconstruct on a Boss turn that arrives while the
> FSM is in the terminal state) has no integration test. No
> existing test drives the FSM to the terminal state and then
> submits a further turn.
