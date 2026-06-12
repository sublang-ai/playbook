<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: CODE playbook runtime — system behavior

## Intent

This spec defines the system behavior of the CODE playbook
runtime — the host-agnostic module that drives the CODE FSM
(`code.fsm.ts`) as a runnable playbook — and of the CODE registry
entry used by the Playbook Captain shell under tmux-play.

Both live at the repo root; the in-repo path is
essential to the package's intent per
[META-15](../meta.md#meta-15). The shell binds the registry entry
to the external `@sublang/cligent` package per
[CAPTAIN](playbook-captain.md). User-visible behavior is in
[user/playbook-runtime.md](../user/playbook-runtime.md). Player
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

The runtime shall parse the judge reply with the same tolerance
defined for adjudication ([PBRT-10](#pbrt-10)) — recovering the
intended JSON object even when it is wrapped in surrounding prose
or a Markdown code fence (including when the prose contains other
bracketed fragments), carries a trailing comma, or is truncated —
before validating the event.
A reply that does not name a valid event for the current state,
omits a required payload field, or from which no JSON value can be
recovered, shall produce one `emitStatus` call and no event;
classification thus degrades gracefully where adjudication
([PBRT-10](#pbrt-10)) instead throws.
The runtime shall define no slash-prefix fast path:
text beginning with `/` shall be sent to `callJudge` like any other
non-empty Boss text.

`BOSS_REPLY` shall be synthesized only while the actor is in
`awaitBossReply`.

## Player binding

### PBRT-8

When resolving the player id for an FSM captain invocation, the
runtime shall map `Coder` to `coder` and `Reviewer` to
`reviewer`. For the composite `Committer`, when a configured
committer alias is present — the validated
`captain.options.code.committer` ([PBRT-30](#pbrt-30)) threaded
into the runtime as `CaptainInput.committerPlayer` — it shall
resolve to that player id (`coder` or `reviewer`). Absent a
configured alias it shall fall back to the
[DR-004 §2](../decisions/004-link-code-fsm-to-playbook-runtime.md)
baked binding: `coder` when `CaptainInput.coderPlayer` is
populated, `reviewer` when only `reviewerPlayer` is populated, and
`coder` when neither is populated.
The alias selects only which host pane runs the commit; it is a
player id, not a [PBRT-4](../user/playbook-runtime.md#pbrt-4)
identity string, so it shall not
affect the `<coder-llm>` / `<reviewer-llm>` substitutions, and the
state's `input.player` stays `Committer`
([PLAYBOOK-3](playbook.md#playbook-3)).

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
the judge not to populate the verbatim fields.
The runtime shall parse the judge reply tolerantly before
validating it: it shall recover the intended JSON object even when
that object is wrapped in surrounding prose or a Markdown code
fence — including when the surrounding prose contains other
bracketed fragments (an aside such as `see [1]` shall not mask the
real object) — carries a trailing comma before a closing brace or
bracket, or is truncated with an unterminated string or an unclosed
object/array (completing the unclosed structures). When the reply
contains more than one recoverable JSON object, the runtime shall
return the first in document order, preferring a strict parse at
each candidate position and only then a repaired one, so an earlier
intended object that needs repair is not overridden by a later,
cleanly-formed object. A reply is malformed only when no JSON value
can be recovered from it.
A reply that is malformed, names an undeclared guard, or omits a
required extracted (non-verbatim) field shall cause the runtime to
throw.

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
Under the Playbook Captain shell, final CODE engagements are
disposed per [CAPTAIN-11](playbook-captain.md#captain-11), so this
item remains the direct-runtime behavior.

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

## Host adapter and registry

### PBRT-15

Where CODE runs under tmux-play through the Playbook Captain shell,
the CODE registry entry shall derive `coderPlayer` and
`reviewerPlayer` from `session.players`: for each entry whose `id`
is `coder` / `reviewer`, the registry entry shall use that entry's
`model` when set and shall fall back to its `adapter` otherwise.
When the shell constructs a CODE engagement, the CODE registry
entry shall construct the runtime from the validated CODE options
merged with those derived identity strings.
Any `coderPlayer` / `reviewerPlayer` keys in the forwarded CODE
options shall be overridden by the derived values.
CODE port wiring under tmux-play is owned by the Playbook Captain
shell and specified in [CAPTAIN-10](playbook-captain.md#captain-10).

### PBRT-16

Where CODE runs under tmux-play through composed config, the
compiled module imported by the host's `captain.from` shall be the
Playbook Captain shell adapter specified by
[CAPTAIN-16](playbook-captain.md#captain-16).
When that shell dispatches a Boss turn to CODE, the CODE registry
entry shall map the dispatch to
`runtime.handleBossInput({ text, signal: context.signal })`.
The public `./code/tmux-play` export shall remain resolvable as a
compatibility shim delegating to the same shell with CODE
registered.

### PBRT-30

During Playbook Captain shell `init`, the CODE registry entry shall
read CODE options from `captain.options.code`, validate them
against the CODE options schema, reject unknown keys with an error
that names the offending path, and store the validated options for
later CODE engagements.
When constructing the CODE runtime for an engagement, the CODE
registry entry shall pass those validated options into
`createPlaybookRuntime`.
The CODE options schema defines one key, `committer`: an optional
string whose value is the resolved Committer-alias player id and
shall be one of the baked player ids `coder` or `reviewer`.
The registry entry shall reject any other value, and any unknown
key, with an error that names the offending path (e.g.
`captain.options.code.committer`). A valid `captain.options.code`
is absent, an empty object, or `{ committer: 'coder' | 'reviewer' }`;
the registry entry threads the validated `committer` into
`createPlaybookRuntime` as the runtime's Committer player id
([PBRT-8](#pbrt-8)).
A further CODE option shall be introduced as its own
higher-numbered item that extends this schema; the validator still
fails closed on stray keys.
The external `@sublang/cligent` package shall not validate
`captain.options.code`; the CODE registry entry is the sole
validator.
The derived `coderPlayer` / `reviewerPlayer` identity strings
([PBRT-15](#pbrt-15)) shall continue to come from
`session.players` and override any same-named keys, independent
of `captain.options.code`.
