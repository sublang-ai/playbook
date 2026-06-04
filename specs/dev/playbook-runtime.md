<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: CODE playbook runtime — system behavior

## Intent

This spec defines the system behavior of the CODE playbook
runtime — the host-agnostic module that drives the CODE FSM
(`code.fsm.ts`) as a runnable playbook — and of its tmux-play
host adapter.

Both live at the repo root; the in-repo path is
essential to the package's intent per
[META-15](../meta.md#meta-15). The adapter binds the runtime to
the external `@sublang/cligent` package. User-visible behavior is
in [user/playbook-runtime.md](../user/playbook-runtime.md). Player
prompt composition is specified by
[PLAYBOOK-5](playbook.md#playbook-5) and
[PLAYBOOK-6](playbook.md#playbook-6).

## Module boundary

### PBRT-5

The runtime module shall import only the FSM artifact and XState,
hold no host-specific types, and interact with its host
exclusively through the `PlaybookPorts` interface (`callPlayer`,
`callJudge`, `emitStatus`, `emitTelemetry`). It shall
default-export a `createPlaybookRuntime(options)` factory
returning a `PlaybookRuntime` (`init`, `handleBossInput`,
`dispose`). The options shall carry only per-run identity strings;
the mapping from FSM players to player-id strings shall be fixed
in the runtime, not supplied at run time.

## Session lifecycle

### PBRT-6

When `init(ports)` is called, the runtime shall construct the FSM
actor from the options and start it, leaving the FSM in its idle
state. When `dispose()` is called, the runtime shall stop the
actor and drain any pending port emissions. When `handleBossInput`
is called before `init`, the runtime shall throw.

## Boss-event classification

### PBRT-7

When the runtime classifies a Boss turn, empty or whitespace-only
text shall produce no event and no port call.
For every non-empty Boss turn, the runtime shall call `callJudge` with a fixed prompt that
names the current FSM state, the valid Boss-event types for that
state, and every required payload field.
The prompt shall require a JSON reply that either names a valid event with its payload or
names no FSM action.

Outside `awaitBossReply` (per [PBRT-11](#pbrt-11)), the valid
Boss-event types are `START_CODING`, `CONTINUE_IR`,
`SUMMARIZE_IR`, and `BOSS_INTERRUPT`.
For `BOSS_INTERRUPT`, the prompt shall list the FSM's jumpable state ids and descriptions,
and the reply shall carry a valid `targetId`.

While the actor is in `awaitBossReply`, the prompt shall also
include the pending Boss question.
In that state, `BOSS_REPLY` is a valid classification result and shall carry the verbatim answer.
The judge may instead return a fresh directive event, including
`BOSS_INTERRUPT`; the transition out of `awaitBossReply` shall run
the `clearBossReplyContext` action declared there.

A reply that does not name a valid event for the current state, or
omits a required payload field, shall produce one `emitStatus` call
and no event.
The runtime shall define no slash-prefix fast path:
text beginning with `/` shall be sent to `callJudge` like any other
non-empty Boss text.

`BOSS_REPLY` shall be synthesized only while the actor is in
`awaitBossReply`.

## Player binding

### PBRT-8

When resolving the player id for an FSM captain invocation, the
runtime shall map `Coder` to `coder` and `Reviewer` to
`reviewer`. For the composite `Committer`, it shall resolve to
`coder` when `CaptainInput.coderPlayer` is populated, to
`reviewer` when only `reviewerPlayer` is populated, and to `coder`
when neither is populated.

## Captain bridge

### PBRT-9

While driving a Boss turn, for each FSM captain invocation the
runtime shall resolve the player id ([PBRT-8](#pbrt-8)), compose
the player prompt ([PLAYBOOK-5](playbook.md#playbook-5),
[PLAYBOOK-6](playbook.md#playbook-6)), and call
`callPlayer(playerId, prompt, signal)`. When the result status is
`ok` with a `finalText`, the runtime shall adjudicate that text
([PBRT-10](#pbrt-10)) and return the adjudicated `CaptainOutput`
so the FSM advances. When the result status is not `ok`, or
`finalText` is absent, the runtime shall throw so the FSM routes
through its error path to the failure state.

## Adjudication

### PBRT-10

When adjudicating a player's `finalText`, the runtime shall call
`callJudge` with a prompt that names the invoked player, includes
the player's output verbatim, and lists every guard key of the
FSM state's `result` map with its description verbatim. It shall
require a JSON object reply carrying a `guard` field equal to one
of those keys, and a string value for every payload field the
chosen guard's description marks as required, except for the
verbatim payload fields `reviews` and `challenges` — for those
the runtime shall carry `finalText.trim()` into the resulting
`CaptainOutput` regardless of any judge-supplied value, so the
long-form prose is not round-tripped through judge JSON.
Short extracted fields such as `question` and `taskDescription`
shall stay judge-extracted (the judge supplies the value; the
runtime validates it is a string). The judge prompt shall direct
the judge not to populate the verbatim fields. A reply that is
malformed, names an undeclared guard, or omits a required
extracted (non-verbatim) field shall cause the runtime to throw.

## Drive to quiescence

### PBRT-11

When `handleBossInput` sends a classified event to the FSM, the
runtime shall drive the actor until its state is quiescent — the
idle state, the failure state, the terminal state, or the
`awaitBossReply` Boss-reply suspension state (per
[slc/gears2fsm.md "Boss-reply suspension"](../../slc/gears2fsm.md#boss-reply-suspension))
— and only then return. Before returning it shall drain pending
port emissions.

### PBRT-12

When `handleBossInput` is called while the actor is in the
terminal state, the runtime shall dispose and reconstruct the
actor before sending the classified event, so the turn starts
from the idle state.

## Abort

### PBRT-13

The runtime shall forward `handleBossInput`'s `signal` to every
`callPlayer` and `callJudge` call. On abort the runtime shall take
no synthetic FSM action: the cancelled player call's failure
propagates through the captain bridge ([PBRT-9](#pbrt-9)) and the
FSM's error path to the failure state, whose `lastError` the
runtime surfaces per [PBRT-14](#pbrt-14).

## Status and telemetry

### PBRT-14

On every FSM transition the runtime shall call `emitTelemetry`
with topic `playbook.fsm.state` and payload `{ from, to, event }`.
Where the transition is a failed-transition event carrying an
`error` field (e.g., `xstate.error.actor.*`), the runtime shall
normalize that `event.error` to a full `{ name, message, stack }`
shape; on entry to the failure state it shall additionally
include the context-level `lastError` in the telemetry payload
in the same full `{ name, message, stack }` shape, so observers
can debug fail-stop paths without losing the original stack.
`context.lastError` itself stays unchanged as the original Error
instance for downstream FSM consumers; normalization happens only
at emission boundaries.

For transitions into a Boss-relevant state
([PBRT-3](../user/playbook-runtime.md#pbrt-3)) the runtime shall
call `emitStatus` to render the Captain pane line for that event,
using the glyph vocabulary in PBRT-3. Captain-invoking state
entries shall be formatted `⤷ <Player>: <label>` carrying only
the player and the state's human-readable label, with no
source-item tag and no FSM-context rider fields. Transition
emissions shall be formatted `→ <guard>[ · <field>=<count>]…`,
with `· reviews=N` / `· challenges=N` tallies when the guard's
payload populates those fields, and shall carry no leading
whitespace — visual nesting under the preceding state entry is
the host presenter's concern. Entry to the failure state shall
pass `lastError` as the `emitStatus` data argument normalized to
a compact `{ name, message }` shape so the Captain pane never
leaks a raw Error instance. The runtime shall not call
`emitStatus` on entry to the idle state or the terminal state.

For each Boss turn whose text classifies to an FSM event, the
runtime shall additionally call `emitStatus` once with the bare
FSM event type (e.g., `START_CODING`), before the FSM advances,
so the host can render it as captain speech. The runtime shall not
echo the verbatim Boss text.

On entry to the `awaitBossReply` state the runtime shall call
`emitStatus` twice, in order: first with the full pending
question as a captain-speech act attributed to the asking player,
formatted `<player> asks: <question>` (no glyph, the host renders
it as captain speech), carrying `pendingBossQuestion.question`
verbatim and in full; then with the routing marker
`◆ awaiting Boss reply · <resumeStateId> · <player> ·
<sourceItem>` carrying no `q=` excerpt rider. It shall
additionally call `emitTelemetry` with topic `playbook.fsm.state`
carrying `pendingBossQuestion.question` verbatim alongside the
other transition fields, so non-tmux-play hosts can render their
own prompt.

All port emissions shall be issued in order, each awaited before
the next, and never dropped.

## Host adapter

### PBRT-15

The tmux-play adapter shall be the only module in the package
that imports `@sublang/cligent`. It shall default-export a
Captain factory that, on `init(session)`, constructs the runtime
from the forwarded options merged with `coderPlayer` and
`reviewerPlayer` derived from `session.players`: for each entry
whose `id` is `coder` / `reviewer`, the adapter shall use that
entry's `model` when set and shall fall back to its `adapter`
otherwise. It shall build `PlaybookPorts` by wiring `callPlayer`
to `context.callPlayer`, `callJudge` to `context.callCaptain`
invoked with the hidden-visibility option
(`callCaptain(prompt, { visibility: 'hidden' })`) so the judge's
JSON reply runs without streaming to the Boss pane — keeping the
pane human-readable per
[PBRT-3](../user/playbook-runtime.md#pbrt-3) — and throwing when
the captain result status is not `ok`, and `emitStatus` /
`emitTelemetry` to `session.emitStatus` / `session.emitTelemetry`.
Every judge call — classification and adjudication — shall pass
`{ visibility: 'hidden' }`. Any `coderPlayer` / `reviewerPlayer`
keys in the forwarded options shall be overridden by the derived
values.

### PBRT-16

The adapter shall map cligent's Captain lifecycle onto the
runtime — `init(session)` to `runtime.init(ports)`,
`handleBossTurn(turn, context)` to
`runtime.handleBossInput({ text: turn.prompt, signal: context.signal })`,
and `dispose()` to `runtime.dispose()` — and shall be resolvable
as the compiled module that the host's `captain.from` imports.

### PBRT-30

When constructing the runtime, the tmux-play adapter shall read
CODE options from `captain.options.code`, validate them against
the CODE options schema, reject unknown keys with an error that
names the offending path, and pass the validated options into
`createPlaybookRuntime`.
The CODE options schema defines no keys at present: a valid
`captain.options.code` is an empty object or absent, every key is
unknown and rejected, and the adapter passes an empty options set
into `createPlaybookRuntime`.
A new CODE option shall be introduced as its own higher-numbered
item that extends this schema; until then the validator exists to
establish the seam and fail closed on stray keys.
The external `@sublang/cligent` package shall not validate
`captain.options.code`; the adapter is the sole validator.
The derived `coderPlayer` / `reviewerPlayer` identity strings
([PBRT-15](#pbrt-15)) shall continue to come from
`session.players` and override any same-named keys, independent
of `captain.options.code`.
