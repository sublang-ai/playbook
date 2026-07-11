<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: Linked playbook runtime — integration tests

## Intent

This spec defines integration tests for the shared linked-runtime
contract, CODE, DISCUSS composition, and tmux-play shell registry
behavior in [dev/playbook-runtime.md](../dev/playbook-runtime.md).
Each test drives a real or test-only FSM through a linked runtime — or
CODE through the Playbook Captain shell — against fake
`PlaybookPorts` or stubbed cligent primitives. The package targets
the repo root; the in-repo path is essential to the package's
intent per
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
failure-state marker, and each scalar or branch-local Boss-reply wait's
two lines;
entry to the idle state or the terminal state emits no status
line; the failure-state status carries `lastError` normalized to
the compact `{ name, message }` shape (never a raw Error
instance); the failure-state telemetry payload carries both a
full `{ name, message, stack }` form of `lastError` and a
normalized `event.error` with the same full shape; entry to a
Boss-reply wait emits two status lines — the full pending
question as captain speech `<player> asks: <question>` (verbatim
and untruncated) followed by the rider-less marker `◆ awaiting
Boss reply · <resumeStateId> · <player> · <sourceItem>` with no
`q=` excerpt — and the corresponding `playbook.fsm.state`
telemetry carries the selected pending question verbatim
alongside the other transition fields; and emissions are observed
in enqueue order.

## Host adapter

### PBRT-21
Verifies: [PBRT-4](../user/playbook-runtime.md#pbrt-4), [PBRT-15](../dev/playbook-runtime.md#pbrt-15), [PBRT-16](../dev/playbook-runtime.md#pbrt-16), [CAPTAIN-9](../dev/playbook-captain.md#captain-9), [CAPTAIN-10](../dev/playbook-captain.md#captain-10)

When CODE is driven through the Playbook Captain shell with CODE
enabled via a `captain.options.playbooks.code` entry whose `from`
resolves the `@sublang/playbook/code/registry` module, over stubbed
cligent `CaptainContext` / `CaptainSession` primitives, the test
suite shall fail unless the shell loads the CODE registry entry from
that module, player calls reach `context.callPlayer` with the bound
host player ids `code-coder` (via the free-text coding happy path)
and `code-reviewer` (via a multi-stage flow that drives the FSM
through a Reviewer state), adjudication reaches
`context.callCaptain`, every CODE `callCaptain` invocation —
classification and adjudication alike — passes
`{ visibility: 'hidden' }`, status and telemetry reach the
session, the per-turn `signal` flows into the runtime, the per-run
player identity strings substituted into the Committer prompt's
`<coder-llm>` / `<reviewer-llm>` placeholders come from the bound
host player's `model` when it pins a model and fall back to its
`adapter` when no model is pinned (both branches exercised), and the
CODE registry entry's `summaryPolicy` carries the labels specified
by [PBRT-15](../dev/playbook-runtime.md#pbrt-15), including
every CODE review state id as `review round` and
`adjudicateChallenges` as `rebuttal`, with no labels for any other
state id, including `planAndImplement` or any tests-green state id.

### PBRT-32
Verifies: [PBRT-15](../dev/playbook-runtime.md#pbrt-15), [CAPTAIN-9](../dev/playbook-captain.md#captain-9), [CAPTAIN-10](../dev/playbook-captain.md#captain-10)

When the Playbook Captain shell adapter is driven end to end
against a real `createTmuxPlayRuntime` instance — over fake player
and captain adapters with a `RecordObserver` capturing the full
record trace — through a `/code` Boss turn that triggers both CODE
classification and adjudication judge calls, the test suite shall
fail unless every CODE judge Captain-call record (`captain_prompt`,
`captain_event`, `captain_finished`) carries `visibility: 'hidden'`
and no Boss-pane-visible record carries a raw judge reply.
Hidden-tagged records are exactly the ones the tmux pane presenter
skips, so this is the standing proof that the judge's JSON never
reaches the Boss pane — only the runtime-composed status lines do
([PBRT-3](../user/playbook-runtime.md#pbrt-3)).

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
empty text makes no judge call, player call, status emission, or FSM
transition while still emitting the received/settled session trace.

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
In addition, when a configured committer alias
(`CaptainInput.committerPlayer`) is present, the test suite shall
fail unless every `Committer` state resolves to that player id
(`coder` or `reviewer`) regardless of which of `coderPlayer` /
`reviewerPlayer` is populated, while `input.player` stays
`Committer`.

### PBRT-27
Verifies: [PBRT-12](../dev/playbook-runtime.md#pbrt-12)

When the runtime is driven to the FSM's terminal state and a
further Boss turn is submitted, the test suite shall fail unless
the runtime disposes and reconstructs the actor so the new turn
is processed from the idle state.
The shell's final-engagement disposal behavior is covered by
[CAPTAIN-14](playbook-captain.md#captain-14), not by this direct
runtime test.

### PBRT-28
Verifies: [PBRT-2](../user/playbook-runtime.md#pbrt-2), [PBRT-7](../dev/playbook-runtime.md#pbrt-7)

When the runtime is driven through `handleBossInput` while the actor
has one scalar or one or more branch-local pending Boss questions, with
text that the classifier names
as `BOSS_REPLY`, with text that the classifier names as a fresh
directive event, with a classifier reply that is invalid for the
current state, with text beginning with `/`, and with empty or
whitespace-only text, the test suite shall fail unless every
non-empty text routes through `callJudge`, `BOSS_REPLY` carries the
verbatim answer and resumes only the identified pending task, a sole
pending question permits an omitted id, multiple questions require a
known id, a fresh directive exits the wait and clears its relevant
pending reply context, text beginning with `/` receives no special parsing,
invalid replies surface one `emitStatus` call and leave the FSM
unmoved, and empty text makes no judge call, player call, status
emission, or FSM transition while still emitting the received/settled
session trace.

## Options validation

### PBRT-31
Verifies: [PBRT-29](../user/playbook-runtime.md#pbrt-29), [PBRT-30](../dev/playbook-runtime.md#pbrt-30)

When the Playbook Captain shell initializes the CODE registry entry
with the option slice `captain.options.playbooks.code.options` set to
the empty object `{}`, set to `{ committer: 'coder' }` and
`{ committer: 'reviewer' }`, set to a `committer` value that is
neither `coder` nor `reviewer`, set to an object carrying an unknown
key, and absent, the test suite shall fail unless the `{}` and
absent cases initialize and record an empty validated options set
for the next CODE engagement; the valid-`committer` cases record
that role id to pass into `createPlaybookRuntime` as the Committer
player id when CODE is engaged; the invalid-`committer` case and the
unknown-key case each cause `init` to reject with an error naming
the offending path
(`captain.options.playbooks.code.options.committer` for the invalid
value); and the derived `coderPlayer` / `reviewerPlayer` identity
strings still come from the host players bound to the CODE local
roles regardless of the option slice.
The test suite shall also fail unless the
`@sublang/playbook/code/registry` module exposes the CODE registry
entry — with its `summaryPolicy` and `validateOptions` — used by
these assertions.

## Runtime contract module

### PBRT-35
Verifies: [PBRT-34](../dev/playbook-runtime.md#pbrt-34)

The test suite shall fail unless the `@sublang/playbook/runtime`
contract agrees with
[slc/link.md](../../slc/link.md#playbookruntime-contract):
`PlayerResult.status` admits exactly the members `ok`, `aborted`, and
`error`, and `PlaybookPorts` declares exactly the members `callPlayer`,
`callJudge`, `callPlaybook`, `emitStatus`, and `emitTelemetry`.
The test suite shall additionally fail unless the module exports
the player-call, nested-call, JSON value/error, structured-state,
session, trace, run-result, runtime, and runtime-factory contract types,
unless `PlayerResult`
exposes optional `resumeToken`, unless `callPlayer` requires explicit
resume options, unless `PlaybookRuntime.init` accepts a causal
`PlaybookSession`, and unless `handleBossInput` and
`resumePlaybookCall` return `PlaybookRunResult`; its import graph
includes no CODE or FSM module.

### PBRT-36
Verifies: [PBRT-5](../dev/playbook-runtime.md#pbrt-5)

The test suite shall fail unless `@sublang/playbook/code/playbook`
obtains and re-exports its shared player, nested-call, state, session,
trace, result, and runtime contract types from
`@sublang/playbook/runtime` rather than declaring its own.
The check shall rest on observable declaration evidence: the shipped
`code.playbook.d.ts` shall import those names from the shared module and
shall carry no local declaration for them. A
mutual-assignability check alone shall not satisfy this item, because
TypeScript's structural typing makes a same-shaped local redefinition
assignable to the shared types and would therefore pass while CODE
still violated the re-export requirement of
[PBRT-5](../dev/playbook-runtime.md#pbrt-5) and
[DR-004 Addendum A4](../decisions/004-link-code-fsm-to-playbook-runtime.md#a4-runtime-contract-types-sourced-from-a-shared-module).

## Session trace and player continuation

### PBRT-39
Verifies: [PBRT-37](../dev/playbook-runtime.md#pbrt-37), [PBRT-38](../dev/playbook-runtime.md#pbrt-38)

Where the integration suite drives CODE and DISCUSS through real linked
runtimes with fake ports, the test suite shall fail unless each
init-to-dispose session keeps its supplied id immutable, two sessions
use distinct ids, and every trace event carries the session/playbook
ids, schema version, contiguous sequence, timestamp, and the required
turn/call ids.
The trace shall fail unless session, exact Boss input, judge/player
call pairs, FSM transitions, status emissions, settlement, normalized
failures, and disposal are present in boundary order; empty input shall
produce only its Boss received/settled trace around no runtime action.
The player calls shall fail unless the first call for each resolved
player passes `resume: false`, the next same-player call passes the
last returned token, a rotated token replaces it, an omitted token
clears it, an aborted or error result can preserve a returned token,
separate players retain independent tokens, a Committer alias shares
the selected player's token, and a new runtime session starts fresh
rather than inheriting a prior token.

## Structured and composed execution

### PBRT-43
Verifies: [PBRT-40](../dev/playbook-runtime.md#pbrt-40), [PBRT-41](../dev/playbook-runtime.md#pbrt-41)

Where the integration suite drives DISCUSS through its real linked
runtime with gated Host and Participant ports, the test suite shall
fail unless both players enter each initial and reconciliation round
before either result is required, both completion orders yield the same
joined next-round inputs, and no next round begins before both prior
branches finish.
The test suite shall fail unless one or two branch-local Boss questions
park and resume independently without restarting a completed or still
waiting sibling, a branch failure stops its sibling and reaches
`failed`, distinct players overlap, same-player overlap rejects, and
hidden judge calls never overlap.
Structured state telemetry and trace shall remain JSON-safe, identify
all active leaves and tags, contain no `[object Object]` classifier
state, use contiguous trace sequence numbers, and settle only after all
in-flight calls and emissions from the turn drain.

### PBRT-44
Verifies: [PBRT-42](../dev/playbook-runtime.md#pbrt-42)

Where the integration suite drives a test linked parent and child
through the real Playbook Captain shell and the parent's XState machine
invokes the `playbook` actor, the test suite shall fail unless
an immediately completed child reaches parent `onDone`, a parked child
returns parent outcome `suspended` without holding the Boss turn open,
and a later matching resume drives the parent from the child output.
The test suite shall fail unless child aborted/error results reach
parent `onError`, unknown or duplicate call ids reject, parent disposal
aborts a pending call, the parent's player token map survives
suspension, and `playbook.call.started` / `playbook.call.finished` form
one causally ordered trace pair around the child session, with the finish
event preceding the parent transition caused by that return.
