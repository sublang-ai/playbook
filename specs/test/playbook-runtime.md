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

When a free-text coding turn is driven through `createPlaybookRuntime`
with fake ports that classify the Boss text as `START_CODING` and
then return a valid guard from the judge, the test suite shall fail
unless `handleBossInput` drives the FSM through one captain
invocation and returns with the FSM at the idle state.

### PBRT-18
Verifies: [PBRT-13](../dev/playbook-runtime.md#pbrt-13)

When the per-turn `signal` aborts mid-`callPlayer`, the test suite
shall fail unless the runtime drives the FSM to the failure state
with `lastError` populated and returns from the turn.

### PBRT-19
Verifies: [PBRT-11](../dev/playbook-runtime.md#pbrt-11)

When a Boss turn is classified as `BOSS_INTERRUPT` with a valid
`targetId`, the test suite shall fail unless the FSM is redirected
to the named state and `handleBossInput` returns.

### PBRT-20
Verifies: [PBRT-14](../dev/playbook-runtime.md#pbrt-14)

When a Boss turn is driven through the runtime, the test suite
shall fail unless: telemetry is emitted for every transition
under the `playbook.fsm.state` topic; the Captain-pane status
emits cover the bare classification line (the FSM event type with
no glyph and no echo of the verbatim Boss text), every
captain-invoking state entry as `⤷ <Player>: <label>` with no
source-item tag and no FSM-context rider field, every transition
guard that drove an entry as `→ <guard>` with `· <field>=<count>`
tallies when applicable and no leading whitespace, the
failure-state marker, and the `awaitBossReply` entry's two lines;
entry to the idle state or the terminal state emits no status
line; the failure-state status carries `lastError` normalized to
the compact `{ name, message }` shape (never a raw Error
instance); the failure-state telemetry payload carries both a
full `{ name, message, stack }` form of `lastError` and a
normalized `event.error` with the same full shape; entry to
`awaitBossReply` emits two status lines — the full pending
question as captain speech `<player> asks: <question>` (verbatim
and untruncated) followed by the rider-less marker `◆ awaiting
Boss reply · <resumeStateId> · <player> · <sourceItem>` with no
`q=` excerpt — and the corresponding `playbook.fsm.state`
telemetry carries `pendingBossQuestion.question` verbatim
alongside the other transition fields; and emissions are observed
in enqueue order.

## Host adapter

### PBRT-21
Verifies: [PBRT-4](../user/playbook-runtime.md#pbrt-4), [PBRT-15](../dev/playbook-runtime.md#pbrt-15), [PBRT-16](../dev/playbook-runtime.md#pbrt-16)

When the tmux-play adapter is driven through an
`init` → `handleBossTurn` → `dispose` lifecycle with stubbed
cligent `CaptainContext` / `CaptainSession` primitives, the test
suite shall fail unless player calls reach `context.callPlayer`
with player ids matching the runtime's baked player ids (both
`coder` via the free-text coding happy path and `reviewer` via a
multi-stage flow that drives the FSM through a Reviewer state),
adjudication reaches `context.callCaptain`, every `callCaptain`
invocation — classification and adjudication alike — passes
`{ visibility: 'hidden' }`, status and telemetry reach the
session, the per-turn `signal` flows into the runtime,
the per-run player identity strings substituted into the
Committer prompt's `<coder-llm>` / `<reviewer-llm>` placeholders
come from `session.players[].model` when each entry pins a model
and fall back to `session.players[].adapter` when no model is
pinned (both branches exercised), and `handleBossTurn` invoked
before `init` rejects.

### PBRT-32
Verifies: [PBRT-15](../dev/playbook-runtime.md#pbrt-15)

When the tmux-play adapter is driven end to end against a real
tmux-play runtime and pane presenter through a Boss turn that
triggers both classification and adjudication judge calls, the
test suite shall fail unless none of the judge's JSON replies
reach the Boss pane — only the runtime-composed status lines do.
This integration test is gated on host support for hidden Captain
visibility via `describe.skipIf(!CLIGENT_SUPPORTS_HIDDEN_CAPTAIN)`:
until the host's `callCaptain` honors `{ visibility: 'hidden' }`
(per [PBRT-15](../dev/playbook-runtime.md#pbrt-15)), the flag is
`false` and the suite shall skip rather than fail, standing in as
a gated placeholder.
The end-to-end harness asserting the behavior above shall be
authored when that support ships — the harness cannot run against
a host that lacks the option — at which point the flag flips to
`true`.

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
- a `callJudge` reply that is malformed JSON, names an undeclared
  guard, or omits a required extracted (non-verbatim) payload
  field — for example `taskDescription` on `taskReady` or
  `question` on `needsBossReply` — also routes the FSM to the
  failure state;
- a `callJudge` reply that omits a verbatim payload field
  (`reviews` or `challenges`) does *not* throw: the runtime
  substitutes the player's `finalText.trim()` into that field
  and the FSM advances; any judge-supplied value for those
  fields is overwritten by the verbatim text.

### PBRT-33
Verifies: [PBRT-7](../dev/playbook-runtime.md#pbrt-7), [PBRT-10](../dev/playbook-runtime.md#pbrt-10)

When the runtime is driven through a Boss turn whose `callJudge`
reply carries a valid JSON object that is wrapped in surrounding
prose (including prose containing other bracketed fragments),
wrapped in a Markdown code fence amid prose, carries a trailing
comma before a closing brace or bracket, or is truncated with an
unclosed object or an unterminated string, the test suite shall
fail unless the runtime recovers the intended object and advances:
a messy adjudication reply driven through the captain bridge as an
xstate actor advances the FSM under the named guard, and a messy
classification reply driven through `handleBossInput` maps to the
named FSM event and advances the actor. When a reply carries no
recoverable JSON value, the test suite shall fail unless
adjudication driven through the captain bridge routes the FSM to
the failure state and classification driven through
`handleBossInput` produces exactly one `emitStatus` call, makes no
player call, sends no event, and leaves the actor unmoved.

## Classification and flow

### PBRT-24
Verifies: [PBRT-1](../user/playbook-runtime.md#pbrt-1)

When the integration suite drives non-empty Boss turns whose
classifier replies name `START_CODING`, `CONTINUE_IR`,
`SUMMARIZE_IR`, and `BOSS_INTERRUPT`, the test suite shall fail
unless each reply maps to its declared FSM event with the
classifier-supplied payload.
For `BOSS_INTERRUPT`, the suite shall fail unless each reply
carries a valid `targetId` selected from the FSM's jumpable
states.

### PBRT-25
Verifies: [PBRT-1](../user/playbook-runtime.md#pbrt-1), [PBRT-7](../dev/playbook-runtime.md#pbrt-7)

When the runtime is driven through `handleBossInput` while the
actor is outside `awaitBossReply`, with non-empty text, with text
beginning with `/`, with a classifier reply that names no valid event type, with a
classifier reply that names a valid event type but omits a
required payload field, with a `BOSS_INTERRUPT` reply lacking a
target state, and with empty or whitespace-only text, the test
suite shall fail unless every non-empty text routes through
`callJudge` and lands on the classifier-named FSM event, text
beginning with `/` receives no special parsing, each invalid reply
surfaces one `emitStatus` call and leaves the FSM unmoved, and
empty text makes no port calls.

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

### PBRT-28
Verifies: [PBRT-2](../user/playbook-runtime.md#pbrt-2), [PBRT-7](../dev/playbook-runtime.md#pbrt-7)

When the runtime is driven through `handleBossInput` while the
actor is in `awaitBossReply`, with text that the classifier names
as `BOSS_REPLY`, with text that the classifier names as a fresh
directive event, with a classifier reply that is invalid for the
current state, with text beginning with `/`, and with empty or
whitespace-only text, the test suite shall fail unless every
non-empty text routes through `callJudge`, `BOSS_REPLY` carries the
verbatim answer and resumes the pending state, a fresh directive
event transitions out of `awaitBossReply` and clears the pending
reply context, text beginning with `/` receives no special parsing,
invalid replies surface one `emitStatus` call and leave the FSM
unmoved, and empty text makes no port calls.

## Options validation

### PBRT-31
Verifies: [PBRT-29](../user/playbook-runtime.md#pbrt-29), [PBRT-30](../dev/playbook-runtime.md#pbrt-30)

When the tmux-play adapter is initialized with `captain.options.code`
set to the empty object `{}`, set to an object carrying an unknown
key, and absent, the test suite shall fail unless the `{}` and
absent cases initialize and pass an empty options set into
`createPlaybookRuntime`, the unknown-key case causes `init` to
reject with an error naming the offending path, and the derived
`coderPlayer` / `reviewerPlayer` identity strings still come from
`session.players` regardless of `captain.options.code`.
