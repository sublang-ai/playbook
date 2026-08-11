<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook-runtime: Linked Playbook Runtime

## Intent

This package specifies the host-facing and internal contracts of linked playbook runtimes, including Boss turns, players, Captain calls, composition, tracing, persistence, control, and integration verification.

## External Behavior

### Turn input

#### playbook-runtime-1

Where a fresh nonempty Boss turn reaches CODE, REVIEW, or DECIDE while the runtime is ready, failed, or terminal and has no pending Boss question, the runtime shall send the artifact's deterministic initial event with the exact Boss text in its declared input field: `START_CODE.callerInput`, `START_REVIEW.callerInput`, or `START_DECIDE.callerTopic`.
The runtime shall make no judge call for that entry and shall treat slash-prefixed text that reaches it as ordinary Boss text.

#### playbook-runtime-2

Where a nonempty Boss turn reaches a runtime with one or more pending Boss questions, the runtime shall ask the judge to select `BOSS_REPLY` for one identified question, an artifact-declared interrupt for a fresh directive, or no action, while the runtime itself supplies the Boss text verbatim as the answer or replacement intent.
When the text is empty or whitespace-only, the runtime shall take no FSM action and make no judge call.
When the judge returns no valid event and payload, the runtime shall report the reason and take no FSM action.

### Turn progress

#### playbook-runtime-3

Where a factory-backed artifact supplies linker-emitted `playerStates` and no artifact-specific status override, while a Boss turn is in progress, the runtime shall surface the canonical human-readable status stream below without exposing judge JSON, raw state-id fallbacks, or the Boss text already visible at the prompt:

- Before sending a selected Boss event, emit its bare type such as `START_CODE` as Captain speech.
- Whenever a settling actor output carries a guard, emit exactly `→ <guard>` with no payload tally, rider, or leading whitespace.
- On entry to a state named by `playerStates`, emit `⤷ <Player>: <label>` from that metadata with no source-item or context rider.
- On entry to a Boss-reply wait, emit the untruncated `<player> asks: <question>` as Captain speech followed by `◆ awaiting Boss reply · <resumeStateId> · <player> · <sourceItem>` with no question excerpt.
- On entry to failure, emit `◆ workflow failed; awaiting Boss recovery.` with the compact normalized error as status data.
- Emit no canonical status on entry to an idle, terminal, or other unlisted state.

The runtime shall compose only each line's meaningful content, while the host owns speaker chrome, wrapping, and visual nesting and keeps judge calls hidden per [[playbook-runtime-15](#playbook-runtime-15)].

### Host configuration

#### playbook-runtime-4

Where CODE, REVIEW, or DECIDE runs through the Playbook Captain shell, the shell shall bind each local role through that frame's effective player binding and route each player call to the resulting host player per [[playbook-captain-10](playbook-captain.md#playbook-captain-10)].
The CODE registry shall require `coder`, and the REVIEW and DECIDE registries shall require `coder` and `reviewer`.
Each registry shall derive a prompt's player identity from the effective binding's model when present and its adapter otherwise.

#### playbook-runtime-29

The current CODE, REVIEW, and DECIDE registries accept no workflow-specific options and shall reject every nonempty option slice.
Host-observable agent, layout, notification, permission, and presentation settings shall remain host configuration rather than workflow options.

### Module boundary

#### playbook-runtime-5

Each linked workflow runtime shall import its FSM and the shared runtime contract types from `@sublang/playbook/runtime`, hold no host-specific type, and interact with its host only through `PlaybookPorts`.
Each public workflow module shall default-export a `createPlaybookRuntime(options)` factory and shall re-export rather than redefine the shared runtime types.
A single-region artifact shall use `createXStatePlaybookRuntime` from `@sublang/playbook/xstate-runtime`, while a parallel artifact may emit bespoke linked machinery that implements the same public contract per [DR-019](../decisions/019-shared-linked-runtime-factory.md).
An artifact-specific host capability shall enter through that artifact's typed options and shall not widen `PlaybookPorts` or `handleBossInput`.

#### playbook-runtime-34

The package shall provide a type-only module resolvable as
`@sublang/playbook/runtime` that is the single authored source of the
runtime contract types `PlayerResult`, `PlayerCallOptions`,
`PlayerSessionStore`, `CaptainResult`, `CaptainCallOptions`,
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
accept a `PlaybookSession` whose optional `playerSessions` implements the exact synchronous store contract in [[playbook-runtime-58](#playbook-runtime-58)], and `PlaybookPorts` shall declare exactly
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

#### playbook-runtime-58

Where `PlaybookSession.playerSessions` is supplied, the `PlayerSessionStore` shall expose exactly four synchronous operations keyed by the runtime-resolved frame-local role id:

| Operation | Contract |
| --- | --- |
| `select(playerId: string): string \| false` | Return the current nonempty resume token for that local role or `false` when none exists. |
| `update(playerId: string, resumeToken?: string): void` | Replace that local role's token with the supplied nonempty token, or clear it when the token is omitted. |
| `snapshot(): Readonly<Record<string, string>>` | Return the complete current view as local-role keys mapped to nonempty tokens. |
| `restore(tokens: Readonly<Record<string, string>>): void` | Replace the complete current view by clearing every binding visible to the frame and then installing exactly the supplied local-role entries. |
| Host-provided frame view | Reject an unknown local role, map every accepted local role through the frame's effective host-player binding before accessing the root-owned token map, and leave effective bindings outside that frame view unchanged during `restore`. |

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

When a runtime receives empty or whitespace-only Boss text, it shall record and settle the input trace but shall produce no event, judge call, player call, status emission, or FSM transition.
When no Boss question is pending, the current CODE, REVIEW, and DECIDE runtimes shall use their deterministic initial event under [[playbook-runtime-1](#playbook-runtime-1)].
While one or more Boss questions are pending, the runtime shall call `callJudge` with the current structured state, every pending question and stable id, and the artifact-declared reply, interrupt, and no-action contracts.
The runtime shall accept an omitted `questionId` only when exactly one question is pending, attach the Boss text verbatim to the selected event, and clear pending context abandoned by an interrupt.
The runtime shall parse the judge reply with the tolerance of [[playbook-runtime-10](#playbook-runtime-10)] and shall emit one status with no FSM event when the reply is malformed or invalid for the live state.

### Player binding

#### playbook-runtime-8

When resolving a compiled workflow's player invocation, the runtime shall map source role `Coder` to local role `coder` and source role `Reviewer` to local role `reviewer`, while leaving the host to resolve that local role to the frame's effective binding per [[playbook-captain-10](playbook-captain.md#playbook-captain-10)].

### Captain bridge

#### playbook-runtime-9

While driving a Boss turn, for each FSM player invocation the
runtime shall resolve the player id ([[playbook-runtime-8](#playbook-runtime-8)]), compose
the player prompt ([[playbook-5](playbook.md#playbook-5)] and
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
chosen guard's description marks as required, except for each field
marked `<verbatim final text>` — for such a field the runtime shall carry
`finalText.trim()` into the resulting `CaptainOutput` regardless of any
judge-supplied value, so player prose is not round-tripped through judge JSON.
Other declared fields shall stay judge-extracted and type-validated.
The judge prompt shall direct the judge not to populate verbatim fields. It shall identify the call as
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
terminal state, the runtime shall leave the actor untouched for empty input and shall
dispose and reconstruct it only after a nonempty input produces the artifact's valid
initial event, so that event starts from the idle state.
Under the Playbook Captain shell, final root engagements are
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

Where a factory-backed artifact supplies linker-emitted `playerStates` and no artifact-specific status override, the runtime shall emit the canonical stream of [[playbook-runtime-3](#playbook-runtime-3)]: the selected event type before dispatch, exact `→ <guard>` for every settling actor output carrying a guard, metadata-derived player entry, failure, and two-line Boss-wait statuses, with no payload tally or raw state-id fallback.
The canonical failure status shall carry `lastError` as compact `{ name, message }` data rather than a raw Error.
The corresponding Boss-wait telemetry shall carry the selected pending question verbatim alongside the other transition fields so a non-tmux host can render it.

All trace, status, and state-telemetry emissions shall use one runtime-owned
concurrency-one queue, be issued in order, each awaited before the next, and
never dropped. Sequence allocation and enqueueing shall be atomic; every public
runtime method shall drain the queue before resolving or rejecting.

#### playbook-runtime-57

Where a factory-backed artifact supplies neither `playerStates` nor an artifact-specific status override, the runtime shall preserve the metadata-absent legacy defaults: no classification line or settling-guard line, `Entered <stateId>.` for each ordinary non-suppressed state, one untruncated `<player> asks: <question>` line with no routing marker, and the unglyphed `Workflow failed; awaiting Boss recovery.` line carrying full normalized `lastError` data.

### Host adapter and registry

#### playbook-runtime-15

Where the shell constructs CODE, REVIEW, or DECIDE, the registry shall derive each player-identity prompt field from the frame's effective role bindings per [[playbook-captain-10](playbook-captain.md#playbook-captain-10)] and shall override any caller-supplied identity value.
Each registry shall publish only the summary labels and handoff guards its current FSM owns, with CODE excluding REVIEW's child rounds, REVIEW labeling its review and rebuttal rounds, and DECIDE labeling its independent-proposal round.

#### playbook-runtime-16

Where CODE, REVIEW, or DECIDE runs through composed config, the host Captain module shall be `@sublang/playbook/playbook-captain` and the enabled entry shall use the matching public `@sublang/playbook/<id>/registry` module per [[playbook-captain-16](playbook-captain.md#playbook-captain-16)] and [[playbook-captain-17](playbook-captain.md#playbook-captain-17)].
Each registry shall map a dispatched Boss turn to `runtime.handleBossInput({ text, signal })` and shall expose no direct tmux-play adapter.

#### playbook-runtime-30

During shell initialization, each CODE, REVIEW, and DECIDE registry shall accept an absent or empty object as its option slice and shall reject a non-object or any unknown key with a diagnostic naming `captain.options.playbooks.<id>.options` and the offending key when present.
The registry shall validate only the option slice the shell passes it and shall retain the validated value for later runtime construction.

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

#### playbook-runtime-55

Where `PlaybookSession.playerSessions` is supplied, when a linked runtime invokes a player, the runtime shall call the synchronous store with that frame's resolved local role id, select continuity before the player-start trace and host call, then update or clear it from the validated host result before the player-finish trace and result interpretation.
Where the runtime exports or restores its parked snapshot with that store supplied, it shall use the store's snapshot and restore operations instead of a private token map.
Where no store is supplied, the runtime shall retain the private per-session continuity of [[playbook-runtime-38](#playbook-runtime-38)].

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
DECIDE's independent-proposal state shall invoke Coder and Reviewer in parallel, stage their results separately, and join only after both finish so neither prompt receives the other's proposal.
When a Boss interrupt replaces the topic during that state, DECIDE shall restart the complete parallel pair with the new topic and shall retain neither prior branch result.
Where one parallel branch needs a Boss reply, that branch shall park independently while its sibling continues, and a reply shall resume only the identified branch.

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
Before starting an actor reconstructed from a runtime snapshot, the restore path shall arm the shared nested bridge with `prepareRestore`, supplying either the snapshot's complete suspended-call descriptor or no descriptor when the snapshot owns no suspended child.
While restore remains prepared, the bridge shall not allocate a call id, drain start emissions, emit `playbook.call.started`, invoke `callPlaybook`, publish pending identity, or attach ordinary child-abort settlement.
Where a suspended-call descriptor was supplied, exactly one reconstructed `playbook` actor shall claim its call id, source state, target playbook, exact handed-off text, child session id, and optional positive turn id; a mismatched or second claim shall reject as a control-plane error.
Where no suspended-call descriptor was supplied, any reconstructed `playbook` actor invocation shall reject rather than opening a child.
Only `confirmRestore` after complete actor validation shall publish the claimed pending identity and arm its ordinary resume and abort behavior; it shall reject an unclaimed descriptor or a prior failed claim, while a prepared zero-call restore shall confirm only when no nested actor appeared.
Before confirmation, `abortPending`, disposal, or an aborted reconstructed invocation shall roll back a provisional claim locally, reject its actor logic, and release its provisional used call id without emitting a finish boundary or aborting the authoritative child.
After confirmation, the eventual exact child result shall use the ordinary resume path, emit the one matching `playbook.call.finished` under the original call and turn ownership, and settle the reconstructed actor exactly once.
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
The public `PlaybookRuntimeSnapshot` contract shall also admit schema version `2`, whose optional `suspendedCall` descriptor carries `callId`, `stateId`, `playbookId`, exact `text`, `childSessionId`, and optional positive `turnId`; schema version `1` shall not carry that member.
The shared snapshot validator shall capture the complete supplied value once as detached frozen JSON, reject accessors and undeclared snapshot, sequence, pending-question, or suspended-call fields, and preserve schema-version-1 snapshots that contain no suspended call.
The validator shall reject a schema-version-2 suspended call unless its caller explicitly opts into handling it, its playbook-call counter is positive, its optional turn id does not exceed the turn counter, and its normalized state is active, quiescent, tagged `playbook.suspended`, and contains the descriptor's source state among its active state ids.
Conversely, the validator shall reject any snapshot whose normalized state is tagged `playbook.suspended` without a schema-version-2 suspended-call descriptor.
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
The compiled default Captain runtime shall expose the shared factory's snapshot methods, while the interactive shell shall neither persist nor restore Captain snapshots ([DR-014](../decisions/014-durable-one-shot-run-sessions.md) §5).

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


When a fresh nonempty turn is driven through CODE, REVIEW, or DECIDE with fake ports, the test suite shall fail unless the runtime sends its deterministic initial event with the exact Boss text, makes no classifier call, and drives to a quiescent, suspended, failed, aborted, or terminal result (verifying [[playbook-runtime-1](#playbook-runtime-1)] and [[playbook-runtime-11](#playbook-runtime-11)]).

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


When the integration suite drives transition and status profiles, it shall fail unless every case in this matrix holds:

- Every runtime emits `playbook.fsm.state` telemetry for each transition, normalizes transition and failure errors, and preserves enqueue order, single-flight emission, contiguous trace sequence, and trace-before-actor-call ordering (verifying [[playbook-runtime-14](#playbook-runtime-14)]).
- A factory-backed fixture with complete `playerStates` and no status override emits the bare classification before dispatch, only metadata-backed `⤷ <Player>: <label>` entries, exact `→ <guard>` for every settling actor output carrying a guard with no tally, rider, or leading whitespace, the compact-data failure marker, and both exact Boss-wait lines, while idle, terminal, and unlisted states produce no canonical fallback (verifying [[playbook-runtime-3](#playbook-runtime-3)] and [[playbook-runtime-14](#playbook-runtime-14)]).
- A factory-backed schema-1 fixture with neither `playerStates` nor a status override emits no classification or settling-guard line, preserves `Entered <stateId>.` for ordinary entries, emits only the single question line for a Boss wait, and emits the unglyphed legacy failure line with full normalized error data (verifying [[playbook-runtime-57](#playbook-runtime-57)]).

### Host adapter

#### playbook-runtime-21


When CODE, REVIEW, and DECIDE are driven through the shell from their real registry modules, the test suite shall fail unless each registry declares its current required roles, player calls reach the frame's effective host bindings, model-or-adapter identities reach the compiled placeholders, hidden adjudication reaches the shared Captain queue, and each registry exposes only its own current summary labels and handoff guards (verifying [[playbook-runtime-4](#playbook-runtime-4)], [[playbook-runtime-15](#playbook-runtime-15)], and [[playbook-runtime-16](#playbook-runtime-16)]).

#### playbook-runtime-32


When the Playbook Captain shell adapter is driven end to end
against a real `createTmuxPlayRuntime` instance — over fake player
and captain adapters with a `RecordObserver` capturing the full
record trace — through a workflow turn that triggers adjudication,
the test suite shall fail unless every judge Captain-call record (`captain_prompt`,
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
builds its own actor — DECIDE today — and shall fail unless that
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
  guard, or omits a required extracted non-verbatim payload field
  lets XState route internally to the
  failure state for cleanup but then rejects the public runtime method with
  the original adjudicator control error;
- a `callJudge` reply that omits a field marked `<verbatim final text>` does _not_ throw: the runtime
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

#### playbook-runtime-33


When the runtime is driven through a Boss turn whose `callJudge`
reply carries a valid JSON object that is wrapped in surrounding
prose (including prose containing other bracketed fragments),
wrapped in a Markdown code fence amid prose, carries a trailing
comma before a closing brace or bracket, or is truncated with an
unclosed object or an unterminated string, the test suite shall
fail unless the runtime recovers the intended object and advances:
a messy adjudication reply driven through the captain bridge advances
the FSM under the named guard, and a messy pending-question classifier
reply maps to the named reply or interrupt event. When a reply carries no
recoverable JSON value, the test suite shall fail unless
adjudication driven through the captain bridge lets the FSM settle at the
failure state and then rejects the public runtime method, while pending-question classification produces exactly one `emitStatus` call, makes no
player call, sends no event, and leaves the actor unmoved (verifying [[playbook-runtime-7](#playbook-runtime-7)], [[playbook-runtime-10](#playbook-runtime-10)]).

### Classification and flow

#### playbook-runtime-24


When the integration suite drives a fresh nonempty Boss turn through CODE, REVIEW, and DECIDE, it shall fail unless each runtime sends its declared deterministic initial event with the exact Boss text and no judge call (verifying [[playbook-runtime-1](#playbook-runtime-1)]).

#### playbook-runtime-25


When a runtime is driven outside a Boss-reply wait with nonempty ordinary or slash-prefixed text and with empty or whitespace-only text, the test suite shall fail unless every nonempty input enters through the artifact's deterministic event with no classifier call and every empty input produces only the received and settled trace pair (verifying [[playbook-runtime-1](#playbook-runtime-1)] and [[playbook-runtime-7](#playbook-runtime-7)]).

#### playbook-runtime-26


When the CODE, REVIEW, and DECIDE suites drive every player-invoking state, they shall fail unless every Coder invocation uses local role `coder` and every Reviewer invocation uses local role `reviewer` (verifying [[playbook-runtime-8](#playbook-runtime-8)]).

#### playbook-runtime-27


When the runtime is driven to the FSM's terminal state and a
further Boss turn is submitted, the test suite shall fail unless
the runtime leaves the terminal actor unchanged for empty input and disposes and reconstructs it only for the artifact's valid initial event so the new nonempty turn is processed from idle.
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


When the shell initializes each real CODE, REVIEW, and DECIDE registry with an absent slice, `{}`, a non-object, and an object carrying an unknown key, the test suite shall fail unless only the absent and empty slices pass and every rejection names that playbook's option path and offending key when present (verifying [[playbook-runtime-29](#playbook-runtime-29)] and [[playbook-runtime-30](#playbook-runtime-30)]).

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
the player-call, player-session-store, Captain-call, nested-call, JSON value/error, structured-state,
session, trace, run-result, runtime, and runtime-factory contract types,
unless `PlayerResult`
exposes optional `resumeToken`, unless `callPlayer` requires explicit
resume options, unless `CaptainResult.status` admits `ok`, `aborted`, and
`error` without exposing a player resume token, unless `CaptainCallOptions`
requires visible-or-hidden visibility plus explicit resume selection and
exposes an optional tool allowlist whose omission is distinct from an explicit
empty list,
unless `PlaybookRuntime.init` accepts a causal
`PlaybookSession` with the optional `PlayerSessionStore` whose four methods have the exact synchronous signatures and local-role snapshot shape of [[playbook-runtime-58](#playbook-runtime-58)], and unless `handleBossInput` and
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
shall list `controlContextFields` and complete `playerStates` among the members an emitted module
supplies, shall state that the context projection's default is nothing rather than
everything, and shall require the `_internal` composers the artifact's
own machine uses rather than a fixed player-and-Captain pair.
Matching type shapes shall not satisfy this: the retired text declared
the same optional `context` while describing the behavior the
projection replaced (verifying [[playbook-runtime-34](#playbook-runtime-34)] and [[playbook-runtime-58](#playbook-runtime-58)]).

#### playbook-runtime-36


The test suite shall fail unless each public CODE, REVIEW, and DECIDE playbook module obtains and re-exports its shared player, player-session-store, Captain-call, nested-call, state, session, trace, result, and runtime contract types from `@sublang/playbook/runtime` rather than declaring its own.
The check shall rest on observable declaration evidence in each shipped `*.playbook.d.ts` and not on mutual assignability alone.
A
mutual-assignability check alone shall not satisfy this item, because
TypeScript's structural typing makes a same-shaped local redefinition
assignable to the shared types and would therefore pass while an artifact still violated [[playbook-runtime-5](#playbook-runtime-5)] (verifying [[playbook-runtime-5](#playbook-runtime-5)]).

### Session Trace and Player Continuation Coverage

#### playbook-runtime-39


Where the integration suite drives CODE, REVIEW, DECIDE, and a direct-Captain runtime through complete sessions, it shall fail unless session identity is immutable, causality is validated, trace sequences are contiguous and boundary-complete, initialization and disposal faults preserve their first causal error, and every started call has exactly one finish (verifying [[playbook-runtime-37](#playbook-runtime-37)]).
The suite shall fail unless a standalone runtime starts each player fresh, resumes and rotates that player's validated token, clears an omitted token, keeps different players independent, preserves continuity across parked turns, and discards it on disposal (verifying [[playbook-runtime-38](#playbook-runtime-38)]).
Host results shall fail unless they are validated, detached, and frozen before any final text, error, or resume token is consumed, and a late result after abort shall not mutate continuity or trace success (verifying [[playbook-runtime-37](#playbook-runtime-37)] and [[playbook-runtime-38](#playbook-runtime-38)]).

#### playbook-runtime-56

Where the integration suite initializes a runtime with a fake `PlayerSessionStore` and drives a host-mapped nested frame, it shall fail unless the declared store methods have the exact synchronous signatures of [[playbook-runtime-58](#playbook-runtime-58)], every call uses the frame-local role key, the host view maps that key to the effective root binding, selection occurs before the player-start trace and call, update or clearing occurs before the player-finish trace and adjudication, snapshot returns local-role keys, restore replaces exactly the frame view without clearing another binding, and a rejected host call preserves the prior selection (verifying [[playbook-runtime-55](#playbook-runtime-55)] and [[playbook-runtime-58](#playbook-runtime-58)]).

### Structured and Composed Execution Coverage

#### playbook-runtime-43


Where the integration suite drives DECIDE through its real linked
runtime with gated Coder and Reviewer ports, the test suite shall
fail unless both independent proposals start before either result is required, both completion orders yield the same joined inputs, neither proposal prompt contains the other's output, and the Coder commit starts only after both finish.
The test suite shall fail unless one or two branch-local Boss questions
park and resume independently without restarting a completed or still
waiting sibling, a branch failure stops its sibling and reaches
`failed`, distinct players overlap, same-player overlap rejects, and
direct Captain and hidden judge calls never overlap.
It shall fail unless a Boss interrupt restarts both proposal branches with the replacement topic, clears both prior branch results and questions, and does not target an individual branch or wait state.
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
initialized instance; and unless the DECIDE linked runtime round-trips
a parked branch question through the same export/restore surface (verifying [[playbook-runtime-45](#playbook-runtime-45)]).
The suite shall also fail unless the compiled default Captain exposes both snapshot methods while its shell performs no Captain snapshot persistence (verifying [[playbook-runtime-45](#playbook-runtime-45)]).

#### playbook-runtime-59


Where the integration suite arms the shared nested bridge and starts a real XState parent in its nested promise actor's invoking state, the test suite shall fail unless an exact descriptor remains unpublished before confirmation, confirms without allocating or emitting a second start or invoking the host port, preserves its detached full identity, and eventually emits one finish before the parent's `onDone` transition.
The suite shall fail unless mismatched state, target, or text, a second claim, an invoke without a descriptor, and an unclaimed descriptor each reject; unless a failed or aborted pre-confirmation attempt emits no finish and leaves its call id reusable; and unless a confirmed call id remains spent after exact resume (verifying [[playbook-runtime-42](#playbook-runtime-42)]).
Where the suite validates public runtime snapshots, it shall fail unless schema version `1` remains accepted without a suspended call, schema version `2` requires explicit suspended-call support on the handling path, the returned snapshot and descriptor are detached and frozen, and malformed ownership, impossible state/counter combinations, undeclared fields, and accessors are rejected (verifying [[playbook-runtime-45](#playbook-runtime-45)]).

### Control Surface Coverage

#### playbook-runtime-53


Where the integration suite drives shared-factory runtimes — synthetic
workflow machines plus the real linked CODE runtime, under fake ports
with scripted per-call results — the test suite shall fail unless every
factory-built runtime exposes `describe` and `apply` together, and
unless both members throw before `init`, during an active boundary,
and after disposal.
The suite shall also fail unless factory construction rejects the real
DECIDE FSM because it declares parallel states.
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
the real CODE runtime parked at `failed` exports only its declared
`phase` when present and no `context` when `phase` is absent, without
exposing the resolved player roster, option value, or player-authored
members its live context holds; and unless naming a first-class-surfaced
member fails runtime construction.
Action derivation shall fail unless: the real CODE runtime parked in
`failed` advertises only the `retry:START_CODE` action for its recorded
entry event with a label written from the source state description;
a synthetic guarded multi-arm `BOSS_INTERRUPT` matrix exercises a
non-first `targetId` and labels its retry from the recorded target's
description, never from the first configured arm; a recorded event the current state does not accept produces no
retry entry; outside the failure state no retry entry appears; the
synthetic context-conditional target flips from excluded to included
once the live context gains its required input; and jump events are
sent with textual fields omitted, never with invented text (an applied
retry replays the recorded payload with no classification call).
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
