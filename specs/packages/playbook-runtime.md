<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook-runtime: Linked Playbook Runtime

## Intent

This package specifies the host-facing and internal contracts of linked playbook runtimes, including Boss turns, players, Captain calls, composition, tracing, persistence, control, and integration verification.

## External Behavior

### Turn input

#### playbook-runtime-1

Where a Boss turn reaches the CODE runtime, when the Boss submits
a non-empty turn while the runtime is not waiting for a Boss reply,
the runtime shall classify the text by consulting the judge.
The judge shall resolve it to one FSM Boss event — `START_CODING`,
`CONTINUE_IR`, `SUMMARIZE_IR`, or
`BOSS_INTERRUPT` — with the required payload, or to no FSM action.
For `BOSS_INTERRUPT`, the judge shall select the target from the
FSM's jumpable states.

The runtime shall define and recognize no in-playbook slash
commands.
Any `/command` playbook-selection UX happens before text
reaches the runtime; text beginning with `/` that does reach the
runtime is classified as ordinary Boss text.

#### playbook-runtime-2

Where a Boss turn reaches the CODE runtime, when the Boss submits
a non-empty turn while the actor is in the `awaitBossReply`
Boss-reply suspension state, the runtime shall classify the text by
consulting the judge with the pending question as context.
The judge shall resolve the text either to
`BOSS_REPLY` with the verbatim answer for the pending question, or
to a fresh Boss directive event that abandons the pending question
via `clearBossReplyContext`.

When the text is empty or whitespace-only, the runtime shall take
no FSM action and make no judge call.
When the judge does not resolve the text to a valid event and payload, the runtime shall
report the reason to the Boss and take no FSM action.

### Turn progress

#### playbook-runtime-3

While a Boss turn is in progress, the runtime shall surface a
human-readable status stream that lets the Boss follow the FSM
without reading the player panes. The runtime composes each line
as the meaningful content only; the host pane (e.g., tmux-play)
owns any speaker chrome, line wrapping, and visual nesting.
The judge's own JSON replies — classification and adjudication —
shall not appear on this stream; the runtime composes every line,
so the pane stays human-readable (the host runs judge calls
hidden per [[playbook-runtime-15](playbook-runtime.md#playbook-runtime-15)]).

The stream uses three glyphs and two captain-speech acts so each
line is parseable at a glance:

- Captain classification carries only the FSM event type the Boss
  turn was classified to (e.g., `START_CODING`), with no glyph.
  The host renders it as captain speech (e.g., prefixed
  `captain>`). The runtime shall not echo the verbatim Boss text —
  the Boss readline already shows it.
- A player question carries the full pending question attributed to
  the asking player, formatted `<player> asks: <question>`, with no
  glyph. The host renders it as captain speech. It is emitted only
  on entry to `awaitBossReply` (see the `◆` bullet) and carries the
  question verbatim and in full — not truncated — since the judge
  JSON that produced it is hidden.
- `⤷` for entry into any player-invoking state — the Coder,
  Reviewer, and Committer states — carrying `<Player>: <label>`
  where `<label>` is the state's human-readable label. The line
  shall carry no source-item tag and no FSM-context rider fields.
- `→` for the transition that drove the FSM into a new
  player-invoking state, carrying the guard that fired and
  `· <field>=<count>` tallies for any payload fields the guard
  populated. Visual nesting under the preceding `⤷` entry is the
  host presenter's concern; the runtime emits no leading
  whitespace.
- `◆` for entry into the failure state and into the
  `awaitBossReply` Boss-reply suspension state. The runtime shall
  emit no status line on entry to the idle state or the terminal
  state — the next `boss>` prompt is the implicit signal. On
  entry to the failure state the line shall additionally carry
  the error that caused it. On entry to `awaitBossReply` the
  runtime shall emit two lines: first the full pending question as
  the captain-speech act above (`<player> asks: <question>`), so
  the Boss sees exactly what's being asked; then the marker line
  `◆ awaiting Boss reply · <resumeStateId> · <player> ·
  <sourceItem>` carrying the routing metadata with no `q=` excerpt
  rider. The Boss replies with plain text that the runtime
  classifies as `BOSS_REPLY`.

### Host configuration

#### playbook-runtime-4

Where CODE runs under tmux-play through the Playbook Captain shell,
the shell shall bind CODE's local roles `coder` and `reviewer` to
the host players `code-coder` and `code-reviewer` and route each
CODE player call to the bound host player.
The host roster declaring those `code-coder` / `code-reviewer`
players and the `captain.from` value pointing at the published
Playbook Captain shell adapter `@sublang/playbook/playbook-captain`
are generated by the generic `playbook` launcher, so the user does
not write them by hand.
The CODE registry entry shall derive the per-run player identity
strings (`coderPlayer`, `reviewerPlayer`) from the bound host
player's `model` when pinned and fall back to its `adapter` when no
model is set, so player prompts carry the concrete model identity
(e.g. `claude-opus-4-8`) rather than the adapter family name (e.g.
`claude`) whenever the host has pinned a model.

#### playbook-runtime-29

Where CODE runs under tmux-play through the Playbook Captain shell,
CODE-specific runtime options shall be carried under
`captain.options.playbooks.code.options` as a namespaced object, and
no CODE option shall be placed elsewhere in the config.
A setting that changes host-observable behavior — theme, layout,
notifications, permissions, model or adapter routing, or timing —
shall be expressed through tmux-play's own top-level `theme` /
`layout` / `notifications` fields or its `captain` / `players`
fields rather than the CODE option slice.
The Committer alias is not such a setting: tmux-play models no
`Committer` player, so the alias selects which of the two existing
CODE roles the composite `Committer` binds to — CODE-internal role
resolution, not host pane/adapter/model routing — and is therefore
a legitimate `committer` member of the CODE option slice. It adds no
tmux-play player and changes no pane's adapter or model; the two
panes keep the `players` adapters they already declare.
CODE is enabled by an explicit `from: @sublang/playbook/code/registry`
module specifier the user keeps in the top-level generic config
(`playbooks.code.from`), which the generic `playbook` launcher
normalizes into `captain.options.playbooks.code.from`; this explicit
`from` is the local-configuration trust boundary
([DR-009](../decisions/009-generic-playbook-cli-and-registry.md) §2)
and the launcher shall neither invent nor hide it.
The `captain.from` adapter-module path and the `code-coder` /
`code-reviewer` host player ids, by contrast, are generated by the
launcher and shall not be required to appear in the user-edited
generic config; this supersedes the user-maintained-invariant framing
of [[playbook-runtime-4](#playbook-runtime-4)].
The generated `captain.from` value shall point at the published
Playbook Captain shell adapter specifier
`@sublang/playbook/playbook-captain`, not at a direct CODE adapter.
The package shall provide no `@sublang/playbook/code/tmux-play`
compatibility shim and no legacy `captain.options.code` host-config
contract.

### Module boundary

#### playbook-runtime-5

The runtime module shall import the FSM artifact, XState, and the
shared runtime contract types from `@sublang/playbook/runtime`
([[playbook-runtime-34](#playbook-runtime-34)]), hold no host-specific types, and interact
with its host exclusively through the `PlaybookPorts` interface
(`callPlayer`, `callCaptain`, `callJudge`, `callPlaybook`, `emitStatus`,
`emitTelemetry`). It shall
re-export the shared player, Captain-call, playbook-call, session, state, trace, and
runtime contract types from that module rather than redefining them,
so consumers of
`@sublang/playbook/code/playbook` resolve the same contract types. It
shall default-export a `createPlaybookRuntime(options)` factory
returning a `PlaybookRuntime` (`init`, `handleBossInput`,
`resumePlaybookCall`, `dispose`, and the optional control-surface pair
`describe`/`apply` of
[slc/link.md](../../slc/link.md#control-surface-optional), which every
runtime obtained from the shared factory implements),
typed `PlaybookRuntimeFactory<CodePlaybookOptions>`. The options shall
carry only per-run identity strings; the mapping from FSM players to
player-id strings shall be fixed in the runtime, not supplied at run
time.
The module shall obtain that runtime by passing the FSM machine and the
CODE-specific spec — options validation, player binding, prompt
composition, Boss-event classification, adjudication strategy, and
Captain-pane status formatting — to the shared
`createXStatePlaybookRuntime` factory of
`@sublang/playbook/xstate-runtime`
([DR-019](../decisions/019-shared-linked-runtime-factory.md)); it shall
not carry a per-artifact copy of the generic FSM-interpreter machinery.
This item binds the CODE runtime module, whose policy needs no host seam
beyond the six ports.
Where another compiled playbook's policy does need one — the session
Captain's controller port
([[captain-playbook-9](captain-playbook.md#captain-playbook-9)]) — it shall arrive as a
linker-exposed option member the artifact itself types, never as a seventh
`PlaybookPorts` member and never as a widened
`handleBossInput` ([[playbook-runtime-34](#playbook-runtime-34)]).

#### playbook-runtime-34

The package shall provide a type-only module resolvable as
`@sublang/playbook/runtime` that is the single authored source of the
runtime contract types `PlayerResult`, `PlayerCallOptions`,
`CaptainResult`, `CaptainCallOptions`,
`JsonValue`, `NormalizedError`,
`PlaybookCallRequest`, `PlaybookCallResult`, `PlaybookCallStart`,
`PlaybookStateValue`, `PlaybookState`, `PlaybookPendingCall`,
`PlaybookRunResult`, `PlaybookControlAction`, `PlaybookControlView`,
`PlaybookControlReceipt`, `PlaybookPorts`, `PlaybookSession`,
`PlaybookTraceType`, `PlaybookTraceEvent`,
`PlaybookRuntime`, and `PlaybookRuntimeFactory<Options = unknown>`, as
the TypeScript projection of
[slc/link.md](../../slc/link.md#playbookruntime-contract).
`PlayerResult.status` shall be the union `'ok' | 'aborted' | 'error'`,
`PlayerResult` shall expose optional `resumeToken`, `PlayerCallOptions`
shall require `resume: string | false`, `CaptainResult.status` shall be the
same union without a resume token, `CaptainCallOptions` shall require
`visibility: 'visible' | 'hidden'` and `resume: string | false`, and shall
expose optional `allowedTools?: readonly string[]` so an explicit empty list
requests tool isolation while omission preserves the host Captain's configured
tools. `PlaybookRuntime.init` shall
accept a `PlaybookSession`, and `PlaybookPorts` shall declare exactly
the members `callPlayer`,
`callCaptain`, `callJudge`, `callPlaybook`, `emitStatus`, and
`emitTelemetry`.
`PlaybookRuntime.handleBossInput` shall accept exactly `{ text, signal }`:
no FSM event, parsed decision, or other host-decided input shall enter a
runtime through it, so a host's per-turn resolution of a Boss turn reaches a
compiled runtime only as a linker-exposed option member whose type the
artifact itself declares
([slc/link.md](../../slc/link.md#playbookruntime-contract)), which that
runtime's own classification maps to an FSM entry event
([[playbook-runtime-7](#playbook-runtime-7)], [[captain-playbook-9](captain-playbook.md#captain-playbook-9)]).
That keeps the shared contract module free of host and playbook types while
leaving the injection path typed end to end at the artifact.
`PlaybookRuntime` shall declare the optional control-surface pair —
`describe?(): PlaybookControlView` and
`apply?(input: { actionId: string; key: string; signal: AbortSignal }):
Promise<PlaybookControlReceipt>` — implemented both or neither
([slc/link.md](../../slc/link.md#control-surface-optional));
`PlaybookControlView` shall carry `state`, the optional
runtime-published `stateDescription` naming what that state means
([[playbook-runtime-52](#playbook-runtime-52)]), the optional JSON-safe
`context` projection its runtime authors ([[playbook-runtime-52](#playbook-runtime-52)]),
`pendingQuestions`, optional `lastError`, and `actions` of
`PlaybookControlAction` (`id`, `label`), and `PlaybookControlReceipt`
shall discriminate exactly `rejected` (with `reason`, before any
effect), `executed` (with the `run` result), and `failed` (with the
normalized `error`, after effects may exist).
`PlaybookTraceType` shall include the paired `apply.started` and
`apply.finished` members alongside the existing boundary pairs.
The module shall import no CODE or FSM types, directly or
transitively, so it carries no dependency on any specific playbook;
the dependency runs one way, from `code.playbook` to this module
([[playbook-runtime-5](#playbook-runtime-5)]).
The module shall carry only type declarations and shall add no runtime
engine, linker, or host primitives.

### Runtime compatibility

#### playbook-runtime-50

The shared `@sublang/playbook/xstate-runtime` engine surface shall
export its compatibility self-report
([DR-022](../decisions/022-runtime-compatibility-contract.md)): the
integer `RUNTIME_ABI` it implements and the read-only integer array
`SUPPORTED_ARTIFACT_SCHEMAS` it accepts.
When `createXStatePlaybookRuntime(machine, spec)` is called with a
`spec.compat` declaration `{ artifactSchema, runtimeAbi }`, the factory
shall check that declaration against the self-report of the engine
instance actually loaded, before any machine interpretation: when
`artifactSchema` is not a member of `SUPPORTED_ARTIFACT_SCHEMAS`,
construction shall throw a `TypeError` naming the declared schema and
the supported set, also when `runtimeAbi` simultaneously disagrees;
when the schema is supported but `runtimeAbi` differs from
`RUNTIME_ABI`, construction shall throw a `TypeError` naming the
declared and the implemented value; when `compat` is present but not an
object carrying integer `artifactSchema` and `runtimeAbi` members,
construction shall throw a `TypeError` naming the offending member.
When `spec.compat` is absent, the factory shall construct the runtime
with no compatibility check, so linked modules emitted before the
contract stay loadable.

### Session lifecycle

#### playbook-runtime-6

When `init({ sessionId, playbookId, rootSessionId, parentSessionId,
parentCallId, depth, ports })` is called with valid identity fields, the
runtime shall bind that identity immutably for its
lifetime, construct the FSM actor from the options, and start it,
leaving the FSM in its idle
state. When `dispose()` is called, the runtime shall stop the
actor, abort a pending nested call, and drain any pending port
emissions; stopping the actor shall emit no status, no FSM-state
telemetry, and no state-transition trace, so the only boundary
disposal reports for a runtime parked outside a final state is its
own session disposal. Root sessions shall require
`rootSessionId === sessionId`,
no parent fields, and depth zero; child sessions shall require matching
parent session/call fields, positive depth, and a session id distinct from
both the root and immediate parent ids. When `handleBossInput`
or `resumePlaybookCall` is called before `init`, the runtime shall throw.

### Boss-event classification

#### playbook-runtime-7

When the runtime classifies a Boss turn, empty or whitespace-only
text shall produce no event, judge call, player call, status emission,
or FSM transition; session trace telemetry under [[playbook-runtime-37](#playbook-runtime-37)]
shall still record and settle that Boss input.
For every non-empty Boss turn, the runtime shall call `callJudge` with a fixed prompt that
names the current FSM state, the valid Boss-event types for that
state, and every required payload field.
The prompt shall require a JSON reply that either names a valid event with its payload or
names no FSM action.

Outside any scalar or branch-local Boss-reply wait (per
[[playbook-runtime-11](#playbook-runtime-11)]), the valid
Boss-event types are `START_CODING`, `CONTINUE_IR`,
`SUMMARIZE_IR`, and `BOSS_INTERRUPT`.
For `BOSS_INTERRUPT`, the prompt shall list the FSM's jumpable state ids and descriptions,
and the reply shall carry a valid `targetId`.

While the actor has one or more pending Boss questions, the prompt
shall include each question and its stable question id.
`BOSS_REPLY` is then a valid classification result and shall carry the
verbatim answer; it may omit `questionId` only when exactly one question
is pending, in which case the runtime shall fill that sole id.
When several questions are pending, an omitted or unknown question id
shall produce no FSM event.
The judge may instead return a fresh directive event, including
`BOSS_INTERRUPT`; the fresh transition shall clear the scalar pending
context or all pending branch context owned by the exited group.

The runtime shall parse the judge reply with the same tolerance
defined for adjudication ([[playbook-runtime-10](#playbook-runtime-10)]) — recovering the
intended JSON object even when it is wrapped in surrounding prose
or a Markdown code fence (including when the prose contains other
bracketed fragments), carries a trailing comma, or is truncated —
before validating the event.
A reply that does not name a valid event for the current state,
omits a required payload field, or from which no JSON value can be
recovered, shall produce one `emitStatus` call and no event;
classification thus degrades gracefully where adjudication
([[playbook-runtime-10](#playbook-runtime-10)]) instead throws.
The runtime shall define no slash-prefix fast path:
text beginning with `/` shall be sent to `callJudge` like any other
non-empty Boss text.

`BOSS_REPLY` shall be synthesized only while at least one scalar or
branch-local question is pending.

### Player binding

#### playbook-runtime-8

When resolving the player id for an FSM player invocation, the
runtime shall map `Coder` to `coder` and `Reviewer` to
`reviewer`. For the composite `Committer`, when a configured
committer alias is present — the validated
`captain.options.playbooks.code.options.committer`
([[playbook-runtime-30](#playbook-runtime-30)]) threaded into the runtime as
`CaptainInput.committerPlayer` — it shall resolve to that player id
(`coder` or `reviewer`). Absent a
configured alias it shall fall back to the
[DR-004](../decisions/004-link-code-fsm-to-playbook-runtime.md) §2
baked binding: `coder` when `CaptainInput.coderPlayer` is
populated, `reviewer` when only `reviewerPlayer` is populated, and
`coder` when neither is populated.
The alias selects only which host pane runs the commit; it is a
player id, not a [[playbook-runtime-4](playbook-runtime.md#playbook-runtime-4)]
identity string, so it shall not
affect the `<coder-llm>` / `<reviewer-llm>` substitutions, and the
state's `input.player` stays `Committer`
([[playbook-3](playbook.md#playbook-3)]).

### Captain bridge

#### playbook-runtime-9

While driving a Boss turn, for each FSM player invocation the
runtime shall resolve the player id ([[playbook-runtime-8](#playbook-runtime-8)]), compose
the player prompt ([[playbook-5](playbook.md#playbook-5)],
[[playbook-6](playbook.md#playbook-6)]), and call
`callPlayer(playerId, prompt, signal, options)` with the explicit
resume selection required by [[playbook-runtime-38](#playbook-runtime-38)]. When the result status is
`ok` with a non-empty, non-whitespace-only `finalText`, the
runtime shall adjudicate that text
([[playbook-runtime-10](#playbook-runtime-10)]) and return the adjudicated `CaptainOutput`
so the FSM advances. When the result status is `ok` but
`finalText` is missing, empty, or whitespace-only, the runtime
shall issue exactly one corrective re-ask
([DR-028](../decisions/028-empty-ok-result-re-ask.md)): the same
composed call repeated through the same boundary, with resume
selection again per [[playbook-runtime-38](#playbook-runtime-38)] — continuing the player
session when the first result carried a resume token, fresh when
it cleared one — traced as its own
player-call pair, and its result interpreted under these same
rules — except that a second missing, empty, or whitespace-only
`ok` `finalText` shall make the runtime throw with no further
re-ask. When the result status is not `ok`, the runtime shall
throw with no corrective re-ask. Either throw routes the FSM
through its error path to the failure state. A rejecting
player-call trace emission shall trigger no corrective re-ask; it
remains a control-plane error for the turn's drain, as at the
direct-Captain boundary ([[playbook-runtime-47](#playbook-runtime-47)]).

#### playbook-runtime-47

While driving a Boss turn, for each FSM direct-Captain invocation, when
`callCaptain` returns a host result whose status is not `ok` or whose
`finalText` is missing, empty, or whitespace-only — the same empty
predicate the delegated-player bridge applies ([[playbook-runtime-9](#playbook-runtime-9)]) — the
runtime shall record that failure on that call's single
`captain.call.finished` trace.
For the not-`ok` status the runtime shall then throw the failure from the
invoked actor with no corrective re-ask.
For the empty `ok` result the runtime shall first issue exactly one
corrective re-ask
([DR-028](../decisions/028-empty-ok-result-re-ask.md)) — the same
direct-Captain call repeated through the same boundary with the
originating call's continuity policy unchanged (DR-028's retry-continuity
bullet), traced as its own
`captain.call.started` / `captain.call.finished` pair — and interpret the
second result under these same rules, except that a second missing, empty,
or whitespace-only `ok` `finalText` shall throw with no further re-ask.
Either throw shall route the FSM through its error path to the failure
state and shall not be treated as a control-plane error.
`handleBossInput` shall therefore resolve the structured `failed` outcome
carrying that failure as the state's error, exactly as it does for the
equivalent delegated-player result ([[playbook-runtime-9](#playbook-runtime-9)]), rather than reject
([[playbook-runtime-41](#playbook-runtime-41)]).
A non-abort thrown `callCaptain` port, a malformed host result, and a rejecting
trace sink remain control-plane errors ([[playbook-runtime-41](#playbook-runtime-41)]) and shall trigger
no corrective re-ask; a transport
failure causally identical to the active signal remains ordinary abort
settlement ([[playbook-runtime-13](#playbook-runtime-13)]).

Where the required `captain.call.finished` emission itself rejects, the
runtime shall issue no corrective re-ask and shall keep the host-result
failure as the invoked actor's error so
the failure state records it, while the emission failure remains the
control-plane error the turn's drain surfaces ([[playbook-runtime-41](#playbook-runtime-41)]).

### Adjudication

#### playbook-runtime-10

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
the judge not to populate the verbatim fields. It shall identify the call as
hidden control work, prohibit tool use, file inspection, and external evidence,
direct the judge to decide only from the supplied player output and declared
outcomes, and require exactly one JSON object with no prose.
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

#### playbook-runtime-48

Where DISCUSS adjudicates the Committer result after the initial-discussion
commit, the `committed` guard description shall constrain an optional
`reviewScope` payload to exactly `specItems`, `decisionRecords`, or `mixed`.
The adjudicator prompt shall carry that domain verbatim, and the runtime shall
continue to reject any other supplied value rather than allowing free-form
prose to override the valid review scope already established when Host wrote
the agreed changes.

### Drive to quiescence

#### playbook-runtime-11

When `handleBossInput` sends a classified event to the FSM, the
runtime shall use XState `waitFor` to drive the actor until no state
tagged `playbook.busy` is active — the idle state, the failure state,
the terminal state, a nested-call suspension, or the
`awaitBossReply` Boss-reply suspension state (per
[slc/gears2fsm.md "Boss-reply suspension"](../../slc/gears2fsm.md#boss-reply-suspension))
— and only then return. Before returning it shall drain pending
port emissions and return the matching `PlaybookRunResult`.

#### playbook-runtime-12

When `handleBossInput` is called while the actor is in the
terminal state, the runtime shall classify the non-empty input first and shall
dispose and reconstruct the actor only after classification produces a real
event, so that event starts from the idle state. `NO_ACTION`, a classifier
failure, or malformed classification shall leave the terminal actor untouched.
Under the Playbook Captain shell, final CODE engagements are
disposed per [[playbook-captain-11](playbook-captain.md#playbook-captain-11)], so this
item remains the direct-runtime behavior.

### Abort

#### playbook-runtime-13

The runtime shall forward `handleBossInput`'s `signal` to every
`callPlayer`, `callCaptain`, and `callJudge` call by combining it with each
XState invocation-lifetime signal. On abort the runtime shall
take no synthetic FSM action: a cancelled player or direct-Captain call's
failure propagates through its invoked actor and the FSM's error path to the
failure state, whose `lastError` the runtime surfaces per
[[playbook-runtime-14](#playbook-runtime-14)].
A player, direct-Captain, or judge host call shall not start once its
combined signal has aborted — including an abort that lands while that
call's own started-trace emission drains: the already-started pair
finishes `aborted` with no host call made.
The runtime shall forward the XState playbook invocation's lifetime
signal to `callPlaybook`; after a later child return it shall forward
`resumePlaybookCall.signal` to any newly resumed player, Captain, or judge work.
The public boundary shall not resolve while its invocation is still running:
it shall await the natural error transition, quiescence, all paired finish
traces, and all ordered emissions so no work from the turn mutates state after
return.

### Status and telemetry

#### playbook-runtime-14

On every FSM transition the runtime shall call `emitTelemetry`
with topic `playbook.fsm.state` and a payload carrying structured
`from`, `to`, `event`, `previousState`, and `state` fields per
[[playbook-runtime-41](#playbook-runtime-41)].
Before that state telemetry, the runtime shall emit the corresponding
`playbook.trace` `fsm.transition` event per [[playbook-runtime-37](#playbook-runtime-37)].
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
([[playbook-runtime-3](playbook-runtime.md#playbook-runtime-3)]) the runtime shall
call `emitStatus` to render the Captain pane line for that event,
using the glyph vocabulary in playbook-runtime-3. Player-invoking state
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

On entry to the scalar `awaitBossReply` state or a parallel
branch-local wait, the runtime shall call `emitStatus` twice, in order:
first with the full pending question as a captain-speech act attributed to the asking player,
formatted `<player> asks: <question>` (no glyph, the host renders
it as captain speech), carrying the selected pending question verbatim
and in full; then with the routing marker
`◆ awaiting Boss reply · <resumeStateId> · <player> ·
<sourceItem>` carrying no `q=` excerpt rider. It shall
additionally call `emitTelemetry` with topic `playbook.fsm.state`
carrying the selected pending question verbatim alongside the other
transition fields, so non-tmux-play hosts can render their
own prompt.

All trace, status, and state-telemetry emissions shall use one runtime-owned
concurrency-one queue, be issued in order, each awaited before the next, and
never dropped. Sequence allocation and enqueueing shall be atomic; every public
runtime method shall drain the queue before resolving or rejecting.

### Host adapter and registry

#### playbook-runtime-15

Where CODE runs under tmux-play through the Playbook Captain shell,
the CODE registry entry shall derive `coderPlayer` and
`reviewerPlayer` from the host players bound to its local roles
`coder` and `reviewer` per the active binding
([[playbook-captain-10](playbook-captain.md#playbook-captain-10)]): for the host player
bound to each role, the registry entry shall use that player's
`model` when set and shall fall back to its `adapter` otherwise.
When the shell constructs a CODE engagement, the CODE registry
entry shall construct the runtime from the validated CODE options
merged with those derived identity strings.
Any `coderPlayer` / `reviewerPlayer` keys in the forwarded CODE
options shall be overridden by the derived values.
The CODE registry entry shall declare a `summaryPolicy`
([[playbook-captain-20](playbook-captain.md#playbook-captain-20)]) providing the
Playbook Captain shell's turn-summary aggregation labels:
`adjudicateChallenges` as `rebuttal`, and every CODE review state id
as `review round`.
The CODE `summaryPolicy` shall provide no summary-visible label for
any other state id, including `planAndImplement` or any tests-green
state id.
The CODE review state ids are `reviewBossCommitSpecs`,
`reviewBossCommitCode`, `reviewBossCommitMixed`,
`reviewIrTaskCommitSpecs`, `reviewIrTaskCommitCode`,
`reviewIrTaskCommitMixed`, `reviewChangesSpecs`,
`reviewChangesCode`, `reviewChangesMixed`,
`reviewChangesAndChallengesSpecs`,
`reviewChangesAndChallengesCode`, and
`reviewChangesAndChallengesMixed`.
The CODE `summaryPolicy` copy-paste guard names shall be exactly
`accepted`, `approved`, `challengeAccepted`, `challengeRejected`,
`challengesRaised`, `changesMadeCode`,
`changesMadeCodeAndChallenged`, `changesMadeMixed`,
`changesMadeMixedAndChallenged`, `changesMadeSpecs`,
`changesMadeSpecsAndChallenged`, `hasFindings`, `needsRevision`,
`noFindings`, and `noOpenItems`.
The CODE `summaryPolicy` shall supply the saved-counts line template
`Saved you X interruptions and Y copy-pastes across Z rounds of reviews/rebuttals.`
([[playbook-captain-19](playbook-captain.md#playbook-captain-19)]).
These labels and guard names refer to CODE FSM state ids and state
`result`-map guard keys transition-covered under
[[playbook-4](playbook.md#playbook-4)], adjudicated under
[[playbook-runtime-10](#playbook-runtime-10)], and emitted as telemetry under
[[playbook-runtime-14](#playbook-runtime-14)].
CODE port wiring under tmux-play is owned by the Playbook Captain
shell and specified in [[playbook-captain-10](playbook-captain.md#playbook-captain-10)].

#### playbook-runtime-16

Where CODE runs under tmux-play through composed config, the
compiled module imported by the host's `captain.from` shall be the
published Playbook Captain shell adapter specifier
`@sublang/playbook/playbook-captain`, whose behavior is specified
by [[playbook-captain-16](playbook-captain.md#playbook-captain-16)] and
[[playbook-captain-17](playbook-captain.md#playbook-captain-17)].
CODE shall be enabled like any other playbook through a
`captain.options.playbooks.code` entry whose `from` module specifier
is the published `@sublang/playbook/code/registry` export, whose
default export is the CODE registry entry the shell loads
([[playbook-captain-16](playbook-captain.md#playbook-captain-16)]).
When that shell dispatches a Boss turn to CODE, the CODE registry
entry shall map the dispatch to
`runtime.handleBossInput({ text, signal: context.signal })`.
The package shall provide no `@sublang/playbook/code/tmux-play`
compatibility shim and no legacy direct CODE adapter; the retired
shim and its exported CODE registry entry, label map, options
derivation helper, and validator are superseded by the
`@sublang/playbook/code/registry` module ([[playbook-runtime-30](#playbook-runtime-30)]).

#### playbook-runtime-30

During Playbook Captain shell `init`, the CODE registry entry shall
validate the normalized option slice the shell passes it — the
entry's `captain.options.playbooks.code.options` — against the CODE
options schema, reject unknown keys with an error that names the
offending path, and store the validated options for later CODE
engagements.
The CODE registry entry shall not extract its own namespace from the
full Captain options bag; the shell passes it only its own option
slice ([DR-009](../decisions/009-generic-playbook-cli-and-registry.md) §3).
When constructing the CODE runtime for an engagement, the CODE
registry entry shall pass those validated options into
`createPlaybookRuntime`.
The CODE options schema defines one key, `committer`: an optional
string whose value is the resolved Committer-alias player id and
shall be one of the baked local role ids `coder` or `reviewer`.
The registry entry shall reject any other value, and any unknown
key, with an error that names the offending path (e.g.
`captain.options.playbooks.code.options.committer`). A valid option
slice is absent, an empty object, or
`{ committer: 'coder' | 'reviewer' }`; the registry entry threads the
validated `committer` into `createPlaybookRuntime` as the runtime's
Committer player id ([[playbook-runtime-8](#playbook-runtime-8)]).
A further CODE option shall be introduced as its own
higher-numbered item that extends this schema; the validator still
fails closed on stray keys.
The external `@sublang/cligent` package shall not validate the CODE
option slice; the CODE registry entry is the sole validator.
The derived `coderPlayer` / `reviewerPlayer` identity strings
([[playbook-runtime-15](#playbook-runtime-15)]) shall continue to come from the host players
bound to the CODE local roles and override any same-named keys,
independent of the CODE option slice.

### Session trace and player continuation

#### playbook-runtime-37

Where a host initializes a linked playbook runtime with a
`PlaybookSession`, the runtime shall emit telemetry topic
`playbook.trace` carrying the immutable session and playbook ids and
the schema defined by
[DR-011](../decisions/011-composable-playbook-execution.md) §5,
including the session causality and version-2 extensions to
[DR-010](../decisions/010-playbook-session-tracing-and-resume.md) §2.
The trace sequence shall be contiguous and one-based for that session;
Boss turns and player/Captain/judge calls shall receive one-based ids, and a
call's started and finished events shall share its call id.
The runtime shall trace session start/disposal, exact Boss input and
settlement, exact player, Captain, and judge prompts and results, normalized
errors, every FSM transition, and every status emission.
Direct Captain calls shall use paired `captain.call.started` and
`captain.call.finished` events carrying state identity, exact prompt,
visibility, status, final text, and normalized error without player identity or
resume selection.
Trace emissions shall be awaited and shall precede the boundary call,
status, or state telemetry they describe; trace payloads shall never be
copied into Boss-visible status text.
Absent optional trace fields shall be omitted rather than stored as own
properties with value `undefined`, and one session shall never have two host
emissions in flight concurrently.
Empty Boss input shall still produce its received and settled trace
events while producing no judge call, player call, status emission, or
FSM action.
If initialization fails after binding the session and attempting
`session.started`, the runtime shall stop the actor, drain owned work, make one
best-effort `session.disposed` attempt, preserve the original initialization
error, clear the failed binding, and permit a fresh `init` attempt.

#### playbook-runtime-38

Where a linked runtime invokes a resolved player within one playbook
session, when no resume token is recorded for that player, the runtime
shall call `PlaybookPorts.callPlayer` with `{ resume: false }`; when a
token is recorded, it shall pass that exact token.
After every resolved call, before interpreting its status, the runtime
shall replace the player's token with a non-empty
`PlayerResult.resumeToken` or clear it when the result omits one.
An aborted or error result carrying a token shall therefore remain
resumable; a rejected call carrying no result shall preserve the prior
token and shall not trigger a silent fresh retry.
Before any of those reads or mutations, the runtime shall validate the host
result as the exact declared JSON-safe shape, detach it from caller mutation,
and freeze the accepted snapshot. After the host promise resolves, it shall
re-check the combined invocation/public signal before validation or token
adoption, so a late result from a port that ignored abort cannot mutate
continuity or be traced as success.
The runtime shall key tokens by the resolved player id, keep separate
players independent, preserve the map across parked turns and actor
reconstruction within the runtime session, and discard it on dispose.

### Structured and composed execution

#### playbook-runtime-40

Where an FSM contains a fixed set of independent player tasks whose
results join before later work, when the linked runtime drives that
state, the FSM shall represent the tasks as XState parallel regions
whose working leaves invoke their declared `player` actor and whose local final states join
through the parallel parent's `onDone` transition, per
[DR-011](../decisions/011-composable-playbook-execution.md) §1.
The runtime shall permit overlap only for distinct resolved player ids,
shall reject a concurrent call to a player id already in flight, and
shall serialize its concurrent hidden `callJudge` operations through one local
abort-aware FIFO with concurrency one. The host shall additionally serialize
all direct `callCaptain` and hidden `callJudge` port operations together
through its one Captain-session FIFO.
DISCUSS initial proposals and reconciliation rounds shall run Host and
Participant in parallel, stage each result independently, and promote
both results at the join so the next round receives one completed prior
round rather than completion-order-dependent inputs.
The `initialProposalRound` and `reconciliationRound` parallel parents shall be
Boss-interrupt targets; their four branch working leaves shall remain
branch-reply resume destinations but shall not be independently jumpable.
An interrupt may reenter either parent only when context already contains its
complete input: a non-empty topic for initial proposals, or both promoted
proposals for reconciliation. The scalar or branch-local wait state itself
shall never be an interrupt target.
Where one parallel DISCUSS branch needs a Boss reply, that branch shall
park in its own waiting state while its sibling continues; a reply shall
resume only the identified branch, and multiple pending branch questions
shall remain independently addressable.

#### playbook-runtime-41

Where a linked runtime observes an XState snapshot, the runtime shall
normalize it as a JSON-safe descriptor carrying the structured state
value, active stable state ids, tags, actor status, and quiescence.
Working states shall carry `playbook.busy`, Boss-waiting states shall
carry `playbook.parked`, and nested-call states shall carry
`playbook.suspended`.
The runtime shall use XState `waitFor` to settle its imperative drive
boundary only when no busy state remains or the actor is terminal or in
error; it shall not model workflow waiting with a polling loop, async
action, or runtime-owned join.
FSM telemetry and the matching `fsm.transition` trace shall carry
structured `from` and `to` values plus previous/current descriptors.
The described FSM telemetry payload shall be detached and recursively frozen
before delivery and shall not share its state object with the runtime's
authoritative previous-state record.
Session, status, and Boss-settlement trace payloads shall include the
current descriptor and may include `stateId` only when one
Boss-relevant state id is active.
`PlaybookRunResult` shall use its discriminated outcome exactly as
defined in [slc/link.md](../../slc/link.md#playbookruntime-contract):
only `suspended` shall carry a required pending call, only `terminal`
may carry output, `failed` shall mean a recoverable FSM failure state,
and control-plane errors shall reject the runtime method.
Every JSON boundary shall reject cycles, non-plain instances, accessors, symbol
keys, undefined or sparse values, and non-finite numbers instead of accepting a
value that serialization would change. The linked runtime shall use the shared
`@sublang/playbook/xstate-runtime` normalization helpers rather than weaker
per-artifact copies.
`handleBossInput` and `resumePlaybookCall` shall share one active-boundary
sentinel and drain and clear their error latches on every exit. Disposal shall
reject without starting while that sentinel is active, shall coalesce idle
concurrent requests onto one teardown promise, and shall prevent later public
work once teardown begins. A first non-abort control error shall take
precedence over a coincident abort or later emission failure while the runtime
still attempts the required finish and settlement boundaries exactly once.
Disposal requested during initialization shall wait for that initialization's
success or failure cleanup and emit at most one session-disposal trace;
disposal before initialization shall be terminal and retain the same teardown
promise for every later call.

#### playbook-runtime-42

Where an FSM invokes its provided `playbook` actor with a registered
child playbook id and JSON-safe input, when the child call starts, the
linked runtime shall allocate one stable call id, emit
`playbook.call.started`, and call `PlaybookPorts.callPlaybook` with that
id, target, input, and the invocation's abort signal.
When the port returns a settled successful call, the invoked actor shall
complete through `invoke.onDone`; when it returns or is resumed with an
aborted or error result, the actor shall reject through `invoke.onError`.
When the port returns a suspended child session, the runtime shall keep
the actor pending and return a `PlaybookRunResult` with outcome
`suspended` and the matching pending-call identity instead of holding
the Boss turn open.
Where a host later calls `resumePlaybookCall` with the pending call id,
the runtime shall validate the pending target and child session, bind the new
turn signal, emit and drain the paired `playbook.call.finished`, settle that
invocation, and drive the parent until it
is quiescent, suspended, failed, aborted, or terminal.
That resume boundary shall not allocate a new Boss-input turn id; the matching
finish and parent continuation shall retain the call-start turn id.
The runtime shall reject an unknown, stale, or already settled call id,
a result whose playbook id differs from the pending target, or a result
whose child session id differs from the suspended child session;
shall preserve the parent's player resume-token map while suspended;
and shall finish an outstanding call as aborted before parent session
disposal.
It shall use the shared nested bridge to validate the start discriminant,
target and child-session identity, state and normalized error shapes, and
JSON-safe output. Every path after `playbook.call.started` — including a thrown
port, malformed start/result, invocation abort, and disposal while opening —
shall drain exactly one matching finish event; validation failures shall reject
as control-plane errors without creating pending state or ordinary child
evidence.
If child abort cleanup rejects while the call is suspended, the bridge shall
emit the paired error finish and reject parent disposal with the original
cleanup error rather than swallowing it as an ordinary nested-call rejection.

### Parked-session snapshot

#### playbook-runtime-45

Where a linked runtime implements the optional durable-session
capability of `@sublang/playbook/runtime`
([DR-014](../decisions/014-durable-one-shot-run-sessions.md) §1),
the runtime shall implement `exportSnapshot` and `restore` together.
When `exportSnapshot` is called at a safe capture point — initialized,
not disposing or disposed, no active public boundary, no pending nested
playbook call, and the root actor quiescent with actor status `active` —
it shall return a JSON-safe `PlaybookRuntimeSnapshot` carrying schema
version `1`, the session's playbook id, the persisted machine snapshot
with any raw `Error` context value normalized to `{ name, message,
stack? }`, the player resume-token map, the trace/turn/judge-call/
player-call/playbook-call sequence counters, the direct-Captain-call
counter when the runtime supports direct Captain calls, the current normalized
state descriptor, and the pending Boss questions as
`{ questionId, player, question, sourceItem? }` entries; at any other
point it shall return `undefined`.
The `captainCall` member of `sequences` shall remain optional under
schema version `1`: a direct-Captain-capable runtime shall persist it, and
`restore` shall accept an older snapshot that omits it and use the persisted
global `trace` counter as a collision-safe floor for subsequent Captain call
ids.
When `restore` is called on an unused runtime instance with the same
immutable session identity the snapshot was exported under, the runtime
shall validate the snapshot's schema version and that its playbook id
equals `session.playbookId` — module identity stays a host check
([[playbook-cli-23](playbook-cli.md#playbook-cli-23)]) — bind the session, restore the
resume-token map,
sequence counters, and prior-state descriptor, reconstruct the actor
from the persisted machine snapshot, and start it without emitting
`session.started`, transition traces, or human status, so the next
public boundary continues the session's contiguous trace sequence.
`restore` shall reject a schema or playbook-id mismatch, a snapshot
whose restored actor is not `active`, and reuse of an initialized,
disposing, or disposed runtime, following the same failed-start cleanup
as `init` so `dispose` remains callable.
The compiled default Captain runtime shall not expose the capability
([DR-014](../decisions/014-durable-one-shot-run-sessions.md) §5).

### Control surface

#### playbook-runtime-52

Where a linked runtime implements the optional control-surface
capability of `@sublang/playbook/runtime` —
[DR-029](../decisions/029-session-scoped-conversational-captain.md)
and [slc/link.md](../../slc/link.md#control-surface-optional) — it
shall implement `describe` and `apply` together, and every runtime the
shared `createXStatePlaybookRuntime` factory constructs shall implement
the pair. The capability shall be feature-detected by member presence
like the parked-session snapshot capability, changing no runtime ABI
and no artifact or snapshot schema ([[playbook-runtime-50](#playbook-runtime-50)]); a runtime
without the pair advertises no actions and plain text delivery is the
only verb against it.
Per [DR-019](../decisions/019-shared-linked-runtime-factory.md), the
shared factory supports only single-region FSMs and shall reject at
construction any machine that declares a `type: 'parallel'` state.
`describe()` shall be side-effect free — no trace, status, telemetry,
or machine movement — and shall throw before `init`, while another
public boundary is active, and once disposal begins. It shall return a
detached view carrying the current normalized state descriptor, the
state description defined below, the
runtime-authored context projection defined below, the pending Boss
questions with their stable ids, the last recorded error in normalized
`{ name, message, stack? }` form, and the currently valid actions.
The view's `stateDescription` shall be the runtime's own Boss-facing
statement of what its current state means, written from the same source
state descriptions the action labels are written from, so a controller
host has grounding it can speak from without reading an internal
identifier ([[captain-playbook-5](captain-playbook.md#captain-playbook-5)],
[[playbook-captain-9](playbook-captain.md#playbook-captain-9)]). A state whose source
declares no description shall carry no `stateDescription`: the runtime
shall not promote a state id into a description, so a host is never
handed an identifier dressed as meaning.
The view's `context` shall be an explicit projection the linked
runtime authors — the FSM context members it names, in the order it
names them — and shall never be an allow-by-default serialization of
the FSM context. Only the runtime knows which of its context members
are safe and relevant for a controller prompt, while the host that
receives the view cannot inspect an opaque blob for the player
rosters, option values, and raw player output its own prompts must
exclude ([[playbook-captain-9](playbook-captain.md#playbook-captain-9)]); exporting by
default therefore makes the two obligations unsatisfiable together,
and every member added to an FSM later inherits the wrong default. A
runtime that names no member shall carry no `context`, so a member is
private until an artifact names it. A named member shall still be
sanitized — raw `Error` values normalized, a value that cannot be made
JSON-safe dropped rather than thrown — and the two members the view
surfaces first-class, the pending Boss question and the last error,
shall not be nameable; a projection naming either shall fail runtime
construction rather than be silently ignored.
Actions shall derive from the live snapshot only at the safe capture
point of [[playbook-runtime-45](#playbook-runtime-45)] (actor status `active`, quiescent, no
pending nested call) and shall be empty anywhere else. While the
singular state id is the recoverable failure state and the runtime
holds the recorded last classified event — the event a public Boss
boundary sent, kept with its recorded payload — whose type the live
snapshot accepts, the runtime shall advertise the `retry:<EVENT_TYPE>`
action replaying exactly that event; for each registered resumable
state id whose explicit-state-jump event (`BOSS_INTERRUPT` with that
`targetId` and optional textual fields omitted) the live snapshot
accepts, guards included, it shall advertise `jump:<stateId>`. Each
action shall carry a stable id and a label written from the source
state descriptions; a retry whose recorded event carries its own
`targetId` (the explicit-state-jump shape) shall be labeled from that
recorded target's description — the state its replay re-enters — never
from another configured arm of a guarded transition list; a candidate
whose event requires a payload the
runtime cannot source from recorded state shall be excluded — `apply`
shall never invent free text and shall never enter Boss-input
classification.
A label shall never fall back to an identifier, and a candidate whose
label could only be one shall be excluded on the same terms as one whose
payload cannot be sourced. The label is the only Boss-facing name the
action has: a controller host is required to name an executed or refused
action by it and never by the action id
([[playbook-captain-34](playbook-captain.md#playbook-captain-34)]), so a label that
*is* the target id or the replayed event type makes that substitution a
no-op and puts a machine identifier into Boss-facing text
([[captain-playbook-5](captain-playbook.md#captain-playbook-5)]). A jump whose
target publishes no description shall therefore not be advertised —
borrowing another state's description would name the wrong state — and a
retry shall fall back from its target's description to its own source
state's, and shall not be advertised when neither exists.
`apply({ actionId, key, signal })` shall revalidate against the live
state and settle `{ disposition: 'rejected', reason }` with no effect
when the action is not currently advertised; an accepted action shall
execute at most once per idempotency `key`, driving the validated event
through the same actor drive, boundaries, and emissions as a Boss turn,
and settle `executed` with the projected run result or `failed` with
the normalized error when the run parks in the failure state, aborts,
or a post-acceptance control-plane error lands (effects may exist).
The receipt shall be recorded under its key at acceptance, before the
settlement emissions, and a repeated key shall return the recorded
receipt verbatim with no revalidation, no execution, and no new trace
pair.
Acceptance is also the line past which `apply` shall not throw: the
action may have run, and a caller handed an exception instead of a
receipt is left with an effect it cannot record and a key it will not
reuse. Publication — the `apply.finished` emission — is the second such
line, and it is what decides which post-acceptance settlement failures
may change the receipt. A settlement failure after acceptance and
*before* publication — a rejecting emission drain — is one of the
post-acceptance control-plane errors above and shall settle the
`failed` receipt carrying its normalized error, replacing the receipt
recorded at acceptance, so that the finish trace, the returned receipt,
and any later replay of the key all report the same settlement.
A settlement failure at or after publication — a rejecting
`apply.finished` sink, or a drain that rejects after it — shall not
change the receipt: the disposition is already emitted, so no rewrite
can make the trace and the return agree, and a receipt is a statement
about the effect rather than about its telemetry. Such a failure is a
delivery failure, the run having succeeded and the ledger not having
heard of it; the runtime shall keep the published receipt, shall
return and replay exactly that receipt, and shall carry the delivery
failure on its emission-failure channel so it surfaces from the next
public boundary that drains rather than being discarded. Only
failures before acceptance surface by throwing, where no effect exists
and no receipt is owed. Only accepted receipts (`executed` or
`failed`) shall be recorded
and final for their key: a `rejected` receipt settles before acceptance
and shall record nothing, so a later call with that key revalidates
against the live state, traces its own pair, and may execute once the
action is advertised — while a call that threw before acceptance
(lifecycle misuse, invalid input, a pre-acceptance abort, or a rejected
start sink) shall likewise record nothing, so a later call with that
key may execute.
An abort that lands while the `apply.started` emission drains shall
settle before acceptance — no execution, no receipt, the machine
unmoved — with the pair finished `aborted` carrying the abort's
normalized error together with the canonical
rejected-before-any-effect receipt disposition and its reason, since
every apply finish adds the receipt disposition
([slc/link.md](../../slc/link.md#playbook-trace)).
A rejected `apply.started` sink shall likewise finish the pair
canonically: the best-effort `apply.finished` shall carry that same
rejected-before-any-effect disposition with its reason alongside the
transport error, and no apply finish shall carry a start-only field
such as `stateId`.
When the trace sink rejects that abort finish, the sink failure shall
surface from the boundary in place of the abort reason — matching the
settlement-drain precedence of the other public boundaries — while
the call still settles pre-acceptance: no receipt recorded, the key
free to execute later. `apply`
shall share the single active-boundary sentinel with `handleBossInput`
and `resumePlaybookCall`, shall honor its `AbortSignal` exactly as a
Boss-turn signal, and shall trace as the paired `apply.started` /
`apply.finished` events of
[slc/link.md](../../slc/link.md#playbook-trace) carrying the action id,
idempotency key, and — on finish — the receipt disposition with its
reason, normalized error, or projected run result, under a
session-unique `apply-<n>` call id whose counter restores from the
persisted trace floor. Recorded receipts and the recorded last
classified event shall stay process-local: the schema-1 parked snapshot
persists neither.

## Verification

### Runtime

#### playbook-runtime-17


When a free-text coding turn is driven through `createPlaybookRuntime`
with fake ports that classify the Boss text as `START_CODING` and
then return a valid guard from the judge, the test suite shall fail
unless `handleBossInput` drives the FSM through one captain
invocation and returns with the FSM at the idle state (verifying [[playbook-runtime-11](#playbook-runtime-11)]).

#### playbook-runtime-18


When the per-turn `signal` aborts mid-`callPlayer`, the test suite
shall fail unless the runtime drives the FSM to the failure state
with `lastError` populated, the port-observed combined signal aborts, and the
method waits for quiescence and paired emissions before returning. A deferred
Captain call and deferred child opening shall prove that no later state,
status, or trace mutation occurs after return.
When the abort lands while a classifier judge call's own
`judge.call.started` emission drains (fired from the trace sink), the
suite shall fail unless no host judge call starts, the pair finishes
`aborted`, the FSM stays unmoved, and the turn settles as an abort (verifying [[playbook-runtime-13](#playbook-runtime-13)]).

#### playbook-runtime-19


When a Boss turn is classified as `BOSS_INTERRUPT` with a valid
`targetId`, the test suite shall fail unless the FSM is redirected
to the named state and `handleBossInput` returns (verifying [[playbook-runtime-11](#playbook-runtime-11)]).

#### playbook-runtime-20


When a Boss turn is driven through the runtime, the test suite
shall fail unless: telemetry is emitted for every transition
under the `playbook.fsm.state` topic; the Captain-pane status
emits cover the bare classification line (the FSM event type with
no glyph and no echo of the verbatim Boss text), every
player-invoking state entry as `⤷ <Player>: <label>` with no
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
in enqueue order with at most one host emission in flight, contiguous trace
sequence, and the entering-state trace observed before its actor-call start (verifying [[playbook-runtime-14](#playbook-runtime-14)]).

### Host adapter

#### playbook-runtime-21


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
by [[playbook-runtime-15](playbook-runtime.md#playbook-runtime-15)], including
every CODE review state id as `review round` and
`adjudicateChallenges` as `rebuttal`, with no labels for any other
state id, including `planAndImplement` or any tests-green state id (verifying [[playbook-runtime-4](#playbook-runtime-4)], [[playbook-runtime-15](#playbook-runtime-15)], [[playbook-runtime-16](#playbook-runtime-16)]).

#### playbook-runtime-32


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
([[playbook-runtime-3](playbook-runtime.md#playbook-runtime-3)]) (verifying [[playbook-runtime-15](#playbook-runtime-15)]).

### Lifecycle and captain bridge

#### playbook-runtime-22


When the runtime is constructed by `createPlaybookRuntime`, `init`
is awaited, `handleBossInput` is invoked before `init` on a
separate runtime instance, and `dispose` is called on a started
runtime, the test suite shall fail unless `init` starts the actor
at the idle state, the pre-`init` `handleBossInput` call rejects,
`dispose` stops the actor, and `dispose` awaits any pending port
emissions before resolving (verifying [[playbook-runtime-6](#playbook-runtime-6)]).

When `dispose` is called on a runtime parked outside a final
state, the test suite shall fail unless the disposal emits no
status and no `playbook.fsm.state` telemetry, and the only trace it
appends is `session.disposed`. When a host disposes such a runtime
through a real Playbook Captain shell — the dismiss and switch
paths both do — the test suite shall fail unless the runtime emits
no further status for that disposal, so the parked state's line
reaches the host exactly once for that engagement.
The rule binds every linked runtime, not the shared factory alone, so
the suite shall drive the same disposal against each runtime that
builds its own actor — DISCUSS today — and shall fail unless that
disposal likewise appends only `session.disposed`. Because the
omission is a per-runtime convention rather than a shared code path,
the suite shall additionally discover, rather than enumerate, every
runtime source that constructs an actor and shall fail unless each
stops its actor at exactly one site that suppresses inspection
emissions first, so a later fat artifact is covered without amending
the check.

#### playbook-runtime-23


When the runtime's captain bridge is driven as an xstate actor
under fake ports, the test suite shall fail unless (verifying [[playbook-runtime-9](#playbook-runtime-9)], [[playbook-runtime-10](#playbook-runtime-10)]):

- the adjudicator prompt identifies hidden control work, prohibits tool use,
  file inspection, and external evidence, and requires exactly one JSON object
  with no prose;
- `PlayerResult` `status='ok'` with non-empty `finalText` advances
  the FSM through `onDone`;
- `status='aborted'` and `status='error'` each route the FSM to
  the failure state through `onError` with no repeated
  `callPlayer` call;
- `status='ok'` without non-empty `finalText` routes the FSM to
  the failure state through `onError` only after the single
  corrective re-ask of
  [[playbook-runtime-9](playbook-runtime.md#playbook-runtime-9)] returns a second
  such result;
- a `callJudge` reply that is malformed JSON, names an undeclared
  guard, or omits a required extracted (non-verbatim) payload
  field — for example `taskDescription` on `taskReady` or
  `question` on `needsBossReply` — lets XState route internally to the
  failure state for cleanup but then rejects the public runtime method with
  the original adjudicator control error;
- a `callJudge` reply that omits a verbatim payload field
  (`reviews` or `challenges`) does _not_ throw: the runtime
  substitutes the player's `finalText.trim()` into that field
  and the FSM advances; any judge-supplied value for those
  fields is overwritten by the verbatim text.

#### playbook-runtime-51


When the delegated-player bridge and the direct-Captain actor are
each driven under fake ports whose scripted first result is an
`ok` result with missing, `''`, or whitespace-only `finalText` —
or, for the final bullet, an `aborted` or `error` result — the
test suite shall fail unless (verifying [[playbook-runtime-9](#playbook-runtime-9)], [[playbook-runtime-47](#playbook-runtime-47)]):

- a second scripted `ok` result with non-empty `finalText` lets
  the turn recover after exactly two host calls — the player path
  adjudicates the second text and advances through `onDone`, and
  the direct-Captain path resolves the second result — with each
  call traced as its own started/finished pair;
- a second scripted empty result routes the FSM to the failure
  state through `onError` after exactly two host calls, and
  `handleBossInput` resolves the structured `failed` outcome
  rather than rejecting;
- both boundaries treat `''` and whitespace-only `finalText`
  exactly like a missing `finalText`;
- a first `status='aborted'` or `status='error'` result triggers
  no second host call;
- an abort that lands while the corrective call's own started emission
  drains (fired from the trace sink) triggers no second host call at
  either boundary: the corrective pair finishes `aborted` and the turn
  settles as an abort;
- the corrective call's prompt is byte-equal to the first call's
  prompt, at both boundaries;
- the corrective player call's resume selection follows
  [[playbook-runtime-38](playbook-runtime.md#playbook-runtime-38)]: it resumes the
  token the empty result carried and starts fresh when that result
  cleared the stored token.

#### playbook-runtime-49


The DISCUSS runtime suite shall fail unless the initial-discussion Committer
result metadata and resulting adjudicator prompt name all three exact
`reviewScope` values, each value is accepted when supplied, and a prose or
otherwise undeclared scope is rejected before it can select a review branch (verifying [[playbook-runtime-48](#playbook-runtime-48)]).

#### playbook-runtime-33


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
adjudication driven through the captain bridge lets the FSM settle at the
failure state and then rejects the public runtime method, while classification driven through
`handleBossInput` produces exactly one `emitStatus` call, makes no
player call, sends no event, and leaves the actor unmoved (verifying [[playbook-runtime-7](#playbook-runtime-7)], [[playbook-runtime-10](#playbook-runtime-10)]).

### Classification and flow

#### playbook-runtime-24


When the integration suite drives non-empty Boss turns whose
classifier replies name `START_CODING`, `CONTINUE_IR`,
`SUMMARIZE_IR`, and `BOSS_INTERRUPT`, the test suite shall fail
unless each reply maps to its declared FSM event with the
classifier-supplied payload.
For `BOSS_INTERRUPT`, the suite shall fail unless each reply
carries a valid `targetId` selected from the FSM's jumpable
states (verifying [[playbook-runtime-1](#playbook-runtime-1)]).

#### playbook-runtime-25


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
transition while still emitting the received/settled session trace (verifying [[playbook-runtime-1](#playbook-runtime-1)], [[playbook-runtime-7](#playbook-runtime-7)]).

#### playbook-runtime-26


When the runtime is driven through full multi-stage Boss turns
that reach each player-invoking state involved in player
binding — the single-commit flow (Coder, Committer CODE-15,
Reviewer, ending at the terminal state), the Reviewer-cleared
flow (CODE-16 with only `reviewerPlayer` populated), and the
joint-commit flow (CODE-17 with both `coderPlayer` and
`reviewerPlayer` populated) — the test suite shall fail unless
each player invocation resolves to the expected `playerId`:
`coder` for Coder, `reviewer` for Reviewer, `coder` for CODE-15,
`reviewer` for CODE-16, and `coder` for CODE-17.
In addition, when a configured committer alias
(`CaptainInput.committerPlayer`) is present, the test suite shall
fail unless every `Committer` state resolves to that player id
(`coder` or `reviewer`) regardless of which of `coderPlayer` /
`reviewerPlayer` is populated, while `input.player` stays
`Committer` (verifying [[playbook-runtime-8](#playbook-runtime-8)]).

#### playbook-runtime-27


When the runtime is driven to the FSM's terminal state and a
further Boss turn is submitted, the test suite shall fail unless
the runtime disposes and reconstructs the actor only after a real classified
event so the new turn is processed from the idle state. `NO_ACTION`, classifier
throw, and malformed classification shall leave the same terminal actor and
shall emit no reconstruction transition.
The direct runtime test verifies [[playbook-runtime-12](#playbook-runtime-12)].

#### playbook-runtime-28


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
The classifier prompt shall carry the exact pending question ids, questions,
and asking players; an initial or post-child answer shall resume the matching
task with the same original intent, plan, completed results, and exactly ordered
Q+A continuation blocks (verifying [[playbook-runtime-2](#playbook-runtime-2)], [[playbook-runtime-7](#playbook-runtime-7)]).

### Options validation

#### playbook-runtime-31


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
these assertions (verifying [[playbook-runtime-29](#playbook-runtime-29)], [[playbook-runtime-30](#playbook-runtime-30)]).

### Runtime contract module

#### playbook-runtime-35


The test suite shall fail unless the `@sublang/playbook/runtime`
contract agrees with
[slc/link.md](../../slc/link.md#playbookruntime-contract):
`PlayerResult.status` admits exactly the members `ok`, `aborted`, and
`error`, and `PlaybookPorts` declares exactly the members `callPlayer`,
`callCaptain`, `callJudge`, `callPlaybook`, `emitStatus`, and
`emitTelemetry`.
The test suite shall additionally fail unless the module exports
the player-call, Captain-call, nested-call, JSON value/error, structured-state,
session, trace, run-result, runtime, and runtime-factory contract types,
unless `PlayerResult`
exposes optional `resumeToken`, unless `callPlayer` requires explicit
resume options, unless `CaptainResult.status` admits `ok`, `aborted`, and
`error` without exposing a player resume token, unless `CaptainCallOptions`
requires visible-or-hidden visibility plus explicit resume selection and
exposes an optional tool allowlist whose omission is distinct from an explicit
empty list,
unless `PlaybookRuntime.init` accepts a causal
`PlaybookSession`, and unless `handleBossInput` and
`resumePlaybookCall` return `PlaybookRunResult`; its import graph
includes no CODE or FSM module.
The test suite shall additionally fail unless the linker contract
itself still states the clauses the shipped artifacts depend on, since
that contract is the source they are generated from and a rule stated
only in an artifact is one the next re-link can undo: its control
surface section shall state that the view's `context` is a projection
the linked runtime authors, shall name the `controlContextFields` spec
member that carries it, shall state that a runtime naming no member
carries no `context`, and shall no longer describe the view as a
sanitized serialization of the FSM context; and its output section
shall list `controlContextFields` among the members an emitted module
supplies, shall state that its default is nothing rather than
everything, and shall require the `_internal` composers the artifact's
own machine uses rather than a fixed player-and-Captain pair.
Matching type shapes shall not satisfy this: the retired text declared
the same optional `context` while describing the behavior the
projection replaced (verifying [[playbook-runtime-34](#playbook-runtime-34)]).

#### playbook-runtime-36


The test suite shall fail unless `@sublang/playbook/code/playbook`
obtains and re-exports its shared player, Captain-call, nested-call, state, session,
trace, result, and runtime contract types from
`@sublang/playbook/runtime` rather than declaring its own.
The check shall rest on observable declaration evidence: the shipped
`code.playbook.d.ts` shall import those names from the shared module and
shall carry no local declaration for them. A
mutual-assignability check alone shall not satisfy this item, because
TypeScript's structural typing makes a same-shaped local redefinition
assignable to the shared types and would therefore pass while CODE
still violated the re-export requirement of
[[playbook-runtime-5](playbook-runtime.md#playbook-runtime-5)] and
[DR-004](../decisions/004-link-code-fsm-to-playbook-runtime.md) Addendum A4 (verifying [[playbook-runtime-5](#playbook-runtime-5)]).

### Session Trace and Player Continuation Coverage

#### playbook-runtime-39


Where the integration suite drives CODE, DISCUSS, and a direct-Captain linked
runtime through real or generated runtimes with fake ports, the test suite shall fail unless each
init-to-dispose session keeps its supplied id immutable, two sessions
use distinct ids, and every trace event carries the session/playbook
ids, schema version, contiguous sequence, timestamp, and the required
turn/call ids.
The trace shall fail unless session, exact Boss input, judge/player/Captain
call pairs, FSM transitions, status emissions, settlement, normalized
failures, and disposal are present in boundary order; empty input shall
produce only its Boss received/settled trace around no runtime action.
Mutating the caller's session object after `init` shall not change later trace
identity, and invalid root/child causality, including a child reusing its root
or parent session id, shall reject before session start.
When a session-start sink records and rejects while the best-effort disposal
sink also rejects, CODE and DISCUSS shall each reject with the original start
error, record one start/disposal pair, clear the failed binding, and start a
replacement session with trace sequence one.
For each CODE, DISCUSS, and direct-Captain linked runtime, disposal requested
during initialization shall share one retained teardown promise, wait for
initialization cleanup, record at most one disposal boundary, and reject every
later initialization after teardown begins. Disposal before initialization
shall be terminal, and every later disposal shall return that same promise.
The player calls shall fail unless the first call for each resolved
player passes `resume: false`, the next same-player call passes the
last returned token, a rotated token replaces it, an omitted token
clears it, an aborted or error result can preserve a returned token,
separate players retain independent tokens, a Committer alias shares
the selected player's token, and a new runtime session starts fresh
rather than inheriting a prior token.
Host `PlayerResult` and `CaptainResult` objects shall fail unless they are
validated as exact JSON-safe shapes, detached, and frozen before final text,
errors, or resume tokens are consumed. A non-cooperative player promise that
resolves after its combined signal aborts shall be drained without adopting
its token or tracing success. A first non-abort port or result-validation
error shall remain the public failure when a coincident abort or the matching
finish-trace sink also fails, while each started call still has only one
finished boundary (verifying [[playbook-runtime-37](#playbook-runtime-37)], [[playbook-runtime-38](#playbook-runtime-38)]).

### Structured and Composed Execution Coverage

#### playbook-runtime-43


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
direct Captain and hidden judge calls never overlap.
It shall fail unless the four parallel branch working leaves are absent from
the Boss-interrupt catalog and interrupting either parallel round parent starts
both of that round's branches intentionally only after the required topic or
promoted proposals exist; a contextless parent interrupt and an interrupt that
targets a wait state shall leave the machine unmoved.
Structured state telemetry and trace shall remain JSON-safe, identify
all active leaves and tags, contain no `[object Object]` classifier
state, use contiguous trace sequence numbers, and settle only after all
in-flight calls and emissions from the turn drain.
Mutating or attempting to mutate described state telemetry shall not alter a
later transition's authoritative `from` state.
Strict JSON cases shall reject dates, maps, class/accessor/symbol objects,
undefined or sparse values, non-finite numbers, and cycles across options,
child output, trace payload, and terminal output rather than silently changing
them.
Disposal shall fail rather than race an active turn, concurrent idle disposal
shall share one teardown, and a canceled branch whose host ignores abort shall
finish draining before the turn settles without mutating its player token (verifying [[playbook-runtime-40](#playbook-runtime-40)], [[playbook-runtime-41](#playbook-runtime-41)]).

#### playbook-runtime-44


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
event preceding the parent transition caused by that return and retaining the
start event's turn id across a later resume.
Wrong immediate targets, empty suspended session ids, unknown start states,
malformed normalized errors, non-JSON output, and thrown ports shall each
reject as control-plane errors, create no stale pending identity, and still
pair every emitted call start exactly once. Disposal during a deferred opening
or suspended child shall order child disposal before parent call finish before
parent session disposal.
An exceptional resume shall drain its emissions, preserve the call-start turn
id, surface the first current-boundary control error, and clear its latches so
the next Boss turn cannot inherit that failure. Concurrent idle disposal shall
share one outcome, while disposal requested during a live public boundary
shall reject without starting teardown.
Suspended-child abort cleanup failure shall still emit the matching error
finish and shall reject disposal with the original cleanup error (verifying [[playbook-runtime-42](#playbook-runtime-42)]).

#### playbook-runtime-46


Where the integration suite drives the real CODE linked runtime through
scripted ports to `awaitBossReply` and calls `exportSnapshot`, the test
suite shall fail unless the snapshot is JSON-round-trip safe and carries
schema version `1`, the playbook id, the parked state descriptor, the
recorded player resume token, the live sequence counters, and one
pending Boss question with the asking player and verbatim question
text.
The test suite shall fail unless a fresh runtime instance created by
the same factory `restore`s that snapshot under the original session
identity without emitting `session.started`, and a following Boss reply
re-enters the recorded resume state, passes the pre-park resume token
to the resumed player call, and continues the trace with contiguous
sequence numbers across the export/restore boundary.
It shall fail unless `exportSnapshot` returns `undefined` during an
active turn and after disposal; unless `restore` rejects a
schema-version mismatch, a playbook-id mismatch, and an already
initialized instance; and unless the DISCUSS linked runtime round-trips
a parked branch question through the same export/restore surface (verifying [[playbook-runtime-45](#playbook-runtime-45)]).

### Control Surface Coverage

#### playbook-runtime-53


Where the integration suite drives shared-factory runtimes — synthetic
workflow machines plus the real linked CODE runtime, under fake ports
with scripted per-call results — the test suite shall fail unless every
factory-built runtime exposes `describe` and `apply` together, and
unless both members throw before `init`, during an active boundary,
and after disposal.
The suite shall also fail unless factory construction rejects the real
DISCUSS FSM because it declares parallel states.
The suite shall fail unless `describe()` is side-effect free (no
trace, status, or telemetry; back-to-back views deep-equal; the
machine snapshot unmoved) and its view carries the normalized state,
the state description its source publishes for that state — verbatim,
on synthetic machines and on the real CODE runtime parked at `failed`
alike — the runtime-authored context projection, the pending Boss
question with its stable id, and the last error as
`{ name, message }`-bearing normalized form.
The suite shall discover every linked playbook artifact in the
repository rather than listing them, and shall fail unless each
artifact built on the shared factory declares a `controlContextFields`
projection and each artifact's `_internal` exposes the prompt composers
its own machine uses — the player composer where and only where that
playbook calls players — so a re-link or a newly linked artifact cannot
ship without the declaration the privacy contract rests on
([slc/link.md](../../slc/link.md#output)).
The projection shall fail unless a factory runtime that declares no
context members carries no `context` at all while its FSM context is
populated; unless a runtime that declares members exports exactly
those, in declaration order, with a declared member that is absent or
not JSON-safe dropped and a declared raw `Error` normalized; unless
the real CODE runtime parked at `failed` exports exactly its four
declared classification members and none of the resolved player
roster, option value, or player-authored members its live context
holds; and unless naming a first-class-surfaced member fails runtime
construction.
Action derivation shall fail unless: the real CODE runtime parked in
`failed` advertises the `retry:<EVENT_TYPE>` action for the recorded
last classified event with a label written from the source state
description — resolved for a recorded `BOSS_INTERRUPT` from the
event's own `targetId` against the guarded multi-arm root transition,
never from the first configured arm — plus the `jump:<stateId>`
entries its live snapshot
accepts; a recorded event the current state does not accept produces
no retry entry; outside the failure state no retry entry appears; the
synthetic context-conditional target flips from excluded to included
once the live context gains its required input;
and jump events are sent with textual fields omitted, never with
invented text (an applied retry replays the recorded payload with no
classification call).
It shall further fail unless no advertised label is ever an identifier:
a registered resumable target whose source publishes no description
shall not be advertised at all — not advertised under its own target id
— while a described sibling target the same snapshot accepts still is;
and a retry whose transition target publishes no description shall be
labeled from its own source state's description, with neither the target
id nor the replayed event type appearing in the label.
Receipts shall fail unless the A29-17 engine-level twins hold against
real `apply()`: an advertised retry from `failed` settles
`executed` with the run result; the same `actionId` re-applied after
the state moved on settles `rejected` with a reason before any effect
— snapshot unchanged, zero player calls; a scripted player `error`
mid-action settles `failed` with the normalized error while its
effects stay visible in traces; and a repeated idempotency key returns
the recorded receipt with exactly one execution in total.
The suite shall also fail unless a key whose call threw before
acceptance (a pre-aborted signal, or an abort landing while the
`apply.started` emission drains — the machine unmoved, no host call,
the pair finished `aborted` with the canonical `rejected` disposition
and its reason) records no receipt and may execute later; unless a
finish sink rejecting that abort finish surfaces its failure from the
boundary in place of the abort reason, the call still recording no
receipt and its key still executing later; unless a key first settled
`rejected` while its action was not
advertised records no receipt and executes when re-applied after the
action becomes advertisable, each of the two calls tracing its own
pair; unless a settlement failure after acceptance settles rather than
throws, discriminated by whether the receipt was already published: a
rejecting emission drain over an otherwise clean run, landing before
the finish emission, shall resolve with a `failed` receipt carrying the
sink's normalized error while the effects stay visible, its
`apply.finished` pair shall carry that same `failed` disposition rather
than the pre-fold one, and the replayed key shall return that receipt
verbatim with no re-execution and no new pair — while a rejecting
`apply.finished` sink over an executed action shall leave the receipt
`executed`, the emitted disposition and the returned one shall be the
same value, the replayed key shall return that same `executed` receipt,
and the sink failure shall surface from the next public boundary that
drains rather than being discarded or recorded as the effect's
settlement; unless an abort mid-execution settles
a `failed` receipt whose error reflects the abort while the boundary
drains cleanly; and unless every executed or rejected `apply` traces
as one paired `apply.started`/`apply.finished` carrying the action id,
idempotency key, and receipt disposition under a session-unique
`apply-<n>` call id, with no new pair on a replayed key.
The suite shall assert those payloads over every `apply.finished` the
trace holds, never over a disposition-filtered subset: the executed
and rejected settlements, the pre-acceptance abort finish, and the
best-effort finish a rejected `apply.started` sink emits shall each
carry the receipt disposition with its reason, normalized error, or
projected run result and no start-only field, `stateId` appearing on
`apply.started` alone
([slc/link.md](../../slc/link.md#playbook-trace)) (verifying [[playbook-runtime-52](#playbook-runtime-52)]).

#### playbook-runtime-54

Where the integration suite loads a linked artifact through the real run host, when its compatibility declaration is malformed or disagrees with the loaded engine, the suite shall fail unless runtime construction rejects before any machine interpretation or agent call with a diagnostic naming the offending declaration and supported engine value; a compatible or declaration-free artifact shall construct normally (verifying [[playbook-runtime-50](#playbook-runtime-50)]).
