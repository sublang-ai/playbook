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

When the runtime classifies a Boss turn, it shall first try the
slash forms in [PBRT-1](../user/playbook-runtime.md#pbrt-1). The
`/start`, `/continue`, and `/summarize` forms shall map to their
event even when the trailing payload is empty. An `/interrupt`
command with no target state, or an unrecognized slash command,
shall produce one `emitStatus` call and no event. On non-slash
text the runtime shall call `callJudge` with a fixed prompt naming
the FSM's four Boss-event types and their payload fields, then
parse the JSON `{ event, payload }` reply; a reply that does not
name a valid event with its required payload shall produce one
`emitStatus` call and no event. Empty or whitespace-only text
shall produce no event and no port call.

While the actor is in `awaitBossReply` (per
[PBRT-11](#pbrt-11)), the runtime shall apply this precedence
instead (each rule consumes the input; later rules do not run):

- Recognized slash command (`/start`, `/continue`, `/summarize`,
  `/interrupt <id>`): emit the slash's normal event so the
  transition out of `awaitBossReply` runs the
  `clearBossReplyContext` action declared there.
- Unrecognized slash command, or `/interrupt` with no target:
  one `emitStatus` call, no event.
- Empty or whitespace-only text: no event, no port call.
- All other text: emit
  `{ type: 'BOSS_REPLY', answer: <verbatim text> }`.

`BOSS_REPLY` shall be synthesized only by this branch.

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
chosen guard's description marks as required. A reply that is
malformed, names an undeclared guard, or omits a required field
shall cause the runtime to throw.

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

For transitions into a Boss-relevant state
([PBRT-3](../user/playbook-runtime.md#pbrt-3)) the runtime shall
call `emitStatus` to render the Captain pane line for that event,
using the four-glyph vocabulary in PBRT-3. State entries shall
include the state's human-readable label, the state's player, the
state's CODE-N source item, and any rider field whose value is
populated in the FSM context (`intent`, `irNumber`,
`taskDescription`). Transition emissions shall include the FSM
guard that fired and per-payload-field item tallies (`reviews=N`,
`challenges=N`) when the guard's payload populates those fields.
Entry to the failure state shall pass `lastError` as the
`emitStatus` data argument.

For each Boss turn whose text classifies to an FSM event, the
runtime shall additionally call `emitStatus` once with a Boss-input
echo that names the verbatim turn text and the classified event
type, before the FSM advances.

On entry to the `awaitBossReply` state the runtime shall call
`emitStatus` with a single-line summary `awaiting Boss reply ·
<resumeStateId> · <player> · <sourceItem> · q="<first 80
chars of question>"` so Boss has enough context to compose a
reply, and shall additionally call `emitTelemetry` with topic
`playbook.fsm.state` carrying `pendingBossQuestion.question`
verbatim alongside the other transition fields, so non-tmux-play
hosts can render their own prompt.

All port emissions shall be issued in order, each awaited before
the next, and never dropped.

## Host adapter

### PBRT-15

The tmux-play adapter shall be the only module in the package
that imports `@sublang/cligent`. It shall default-export a
Captain factory that constructs the runtime from the forwarded
options and builds `PlaybookPorts` by wiring `callPlayer` to
`context.callRole`, `callJudge` to `context.callCaptain` (throwing
when the captain result status is not `ok`), and `emitStatus` /
`emitTelemetry` to `session.emitStatus` / `session.emitTelemetry`.

### PBRT-16

The adapter shall map cligent's Captain lifecycle onto the
runtime — `init(session)` to `runtime.init(ports)`,
`handleBossTurn(turn, context)` to
`runtime.handleBossInput({ text: turn.prompt, signal: context.signal })`,
and `dispose()` to `runtime.dispose()` — and shall be resolvable
as the compiled module that the host's `captain.from` imports.
