<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: Linked playbook runtime — system behavior

## Intent

This spec defines shared linked-runtime behavior, the CODE runtime that
drives `code.fsm.ts`, DISCUSS composition behavior, the compiled default
Captain runtime, and the registry
integration used by the Playbook Captain shell under tmux-play.

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

The runtime module shall import the FSM artifact, XState, and the
shared runtime contract types from `@sublang/playbook/runtime`
([PBRT-34](#pbrt-34)), hold no host-specific types, and interact
with its host exclusively through the `PlaybookPorts` interface
(`callPlayer`, `callCaptain`, `callJudge`, `callPlaybook`, `emitStatus`,
`emitTelemetry`). It shall
re-export the shared player, Captain-call, playbook-call, session, state, trace, and
runtime contract types from that module rather than redefining them,
so consumers of
`@sublang/playbook/code/playbook` resolve the same contract types. It
shall default-export a `createPlaybookRuntime(options)` factory
returning a `PlaybookRuntime` (`init`, `handleBossInput`,
`resumePlaybookCall`, `dispose`),
typed `PlaybookRuntimeFactory<CodePlaybookOptions>`. The options shall
carry only per-run identity strings; the mapping from FSM players to
player-id strings shall be fixed in the runtime, not supplied at run
time.

### PBRT-34

The package shall provide a type-only module resolvable as
`@sublang/playbook/runtime` that is the single authored source of the
runtime contract types `PlayerResult`, `PlayerCallOptions`,
`CaptainResult`, `CaptainCallOptions`,
`JsonValue`, `NormalizedError`,
`PlaybookCallRequest`, `PlaybookCallResult`, `PlaybookCallStart`,
`PlaybookStateValue`, `PlaybookState`, `PlaybookPendingCall`,
`PlaybookRunResult`, `PlaybookPorts`, `PlaybookSession`,
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
The module shall import no CODE or FSM types, directly or
transitively, so it carries no dependency on any specific playbook;
the dependency runs one way, from `code.playbook` to this module
([PBRT-5](#pbrt-5)).
The module shall carry only type declarations and shall add no runtime
engine, linker, or host primitives.

## Session lifecycle

### PBRT-6

When `init({ sessionId, playbookId, rootSessionId, parentSessionId,
parentCallId, depth, ports })` is called with valid identity fields, the
runtime shall bind that identity immutably for its
lifetime, construct the FSM actor from the options, and start it,
leaving the FSM in its idle
state. When `dispose()` is called, the runtime shall stop the
actor, abort a pending nested call, and drain any pending port
emissions. Root sessions shall require `rootSessionId === sessionId`,
no parent fields, and depth zero; child sessions shall require matching
parent session/call fields, positive depth, and a session id distinct from
both the root and immediate parent ids. When `handleBossInput`
or `resumePlaybookCall` is called before `init`, the runtime shall throw.

## Boss-event classification

### PBRT-7

When the runtime classifies a Boss turn, empty or whitespace-only
text shall produce no event, judge call, player call, status emission,
or FSM transition; session trace telemetry under [PBRT-37](#pbrt-37)
shall still record and settle that Boss input.
For every non-empty Boss turn, the runtime shall call `callJudge` with a fixed prompt that
names the current FSM state, the valid Boss-event types for that
state, and every required payload field.
The prompt shall require a JSON reply that either names a valid event with its payload or
names no FSM action.

Outside any scalar or branch-local Boss-reply wait (per
[PBRT-11](#pbrt-11)), the valid
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

`BOSS_REPLY` shall be synthesized only while at least one scalar or
branch-local question is pending.

## Player binding

### PBRT-8

When resolving the player id for an FSM player invocation, the
runtime shall map `Coder` to `coder` and `Reviewer` to
`reviewer`. For the composite `Committer`, when a configured
committer alias is present — the validated
`captain.options.playbooks.code.options.committer`
([PBRT-30](#pbrt-30)) threaded into the runtime as
`CaptainInput.committerPlayer` — it shall resolve to that player id
(`coder` or `reviewer`). Absent a
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

While driving a Boss turn, for each FSM player invocation the
runtime shall resolve the player id ([PBRT-8](#pbrt-8)), compose
the player prompt ([PLAYBOOK-5](playbook.md#playbook-5),
[PLAYBOOK-6](playbook.md#playbook-6)), and call
`callPlayer(playerId, prompt, signal, options)` with the explicit
resume selection required by [PBRT-38](#pbrt-38). When the result status is
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
runtime shall use XState `waitFor` to drive the actor until no state
tagged `playbook.busy` is active — the idle state, the failure state,
the terminal state, a nested-call suspension, or the
`awaitBossReply` Boss-reply suspension state (per
[slc/gears2fsm.md "Boss-reply suspension"](../../slc/gears2fsm.md#boss-reply-suspension))
— and only then return. Before returning it shall drain pending
port emissions and return the matching `PlaybookRunResult`.

### PBRT-12

When `handleBossInput` is called while the actor is in the
terminal state, the runtime shall classify the non-empty input first and shall
dispose and reconstruct the actor only after classification produces a real
event, so that event starts from the idle state. `NO_ACTION`, a classifier
failure, or malformed classification shall leave the terminal actor untouched.
Under the Playbook Captain shell, final CODE engagements are
disposed per [CAPTAIN-11](playbook-captain.md#captain-11), so this
item remains the direct-runtime behavior.

## Abort

### PBRT-13

The runtime shall forward `handleBossInput`'s `signal` to every
`callPlayer`, `callCaptain`, and `callJudge` call by combining it with each
XState invocation-lifetime signal. On abort the runtime shall
take no synthetic FSM action: a cancelled player or direct-Captain call's
failure propagates through its invoked actor and the FSM's error path to the
failure state, whose `lastError` the runtime surfaces per
[PBRT-14](#pbrt-14).
The runtime shall forward the XState playbook invocation's lifetime
signal to `callPlaybook`; after a later child return it shall forward
`resumePlaybookCall.signal` to any newly resumed player, Captain, or judge work.
The public boundary shall not resolve while its invocation is still running:
it shall await the natural error transition, quiescence, all paired finish
traces, and all ordered emissions so no work from the turn mutates state after
return.

## Status and telemetry

### PBRT-14

On every FSM transition the runtime shall call `emitTelemetry`
with topic `playbook.fsm.state` and a payload carrying structured
`from`, `to`, `event`, `previousState`, and `state` fields per
[PBRT-41](#pbrt-41).
Before that state telemetry, the runtime shall emit the corresponding
`playbook.trace` `fsm.transition` event per [PBRT-37](#pbrt-37).
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
using the glyph vocabulary in PBRT-3. Player-invoking state
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

## Host adapter and registry

### PBRT-15

Where CODE runs under tmux-play through the Playbook Captain shell,
the CODE registry entry shall derive `coderPlayer` and
`reviewerPlayer` from the host players bound to its local roles
`coder` and `reviewer` per the active binding
([CAPTAIN-10](playbook-captain.md#captain-10)): for the host player
bound to each role, the registry entry shall use that player's
`model` when set and shall fall back to its `adapter` otherwise.
When the shell constructs a CODE engagement, the CODE registry
entry shall construct the runtime from the validated CODE options
merged with those derived identity strings.
Any `coderPlayer` / `reviewerPlayer` keys in the forwarded CODE
options shall be overridden by the derived values.
The CODE registry entry shall declare a `summaryPolicy`
([CAPTAIN-20](playbook-captain.md#captain-20)) providing the
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
([CAPTAIN-19](../user/playbook-captain.md#captain-19)).
These labels and guard names refer to CODE FSM state ids and state
`result`-map guard keys transition-covered under
[PLAYBOOK-4](playbook.md#playbook-4), adjudicated under
[PBRT-10](#pbrt-10), and emitted as telemetry under
[PBRT-14](#pbrt-14).
CODE port wiring under tmux-play is owned by the Playbook Captain
shell and specified in [CAPTAIN-10](playbook-captain.md#captain-10).

### PBRT-16

Where CODE runs under tmux-play through composed config, the
compiled module imported by the host's `captain.from` shall be the
published Playbook Captain shell adapter specifier
`@sublang/playbook/playbook-captain`, whose behavior is specified
by [CAPTAIN-16](playbook-captain.md#captain-16) and
[CAPTAIN-17](playbook-captain.md#captain-17).
CODE shall be enabled like any other playbook through a
`captain.options.playbooks.code` entry whose `from` module specifier
is the published `@sublang/playbook/code/registry` export, whose
default export is the CODE registry entry the shell loads
([CAPTAIN-16](playbook-captain.md#captain-16)).
When that shell dispatches a Boss turn to CODE, the CODE registry
entry shall map the dispatch to
`runtime.handleBossInput({ text, signal: context.signal })`.
The package shall provide no `@sublang/playbook/code/tmux-play`
compatibility shim and no legacy direct CODE adapter; the retired
shim and its exported CODE registry entry, label map, options
derivation helper, and validator are superseded by the
`@sublang/playbook/code/registry` module ([PBRT-30](#pbrt-30)).

### PBRT-30

During Playbook Captain shell `init`, the CODE registry entry shall
validate the normalized option slice the shell passes it — the
entry's `captain.options.playbooks.code.options` — against the CODE
options schema, reject unknown keys with an error that names the
offending path, and store the validated options for later CODE
engagements.
The CODE registry entry shall not extract its own namespace from the
full Captain options bag; the shell passes it only its own option
slice ([DR-009 §3](../decisions/009-generic-playbook-cli-and-registry.md)).
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
Committer player id ([PBRT-8](#pbrt-8)).
A further CODE option shall be introduced as its own
higher-numbered item that extends this schema; the validator still
fails closed on stray keys.
The external `@sublang/cligent` package shall not validate the CODE
option slice; the CODE registry entry is the sole validator.
The derived `coderPlayer` / `reviewerPlayer` identity strings
([PBRT-15](#pbrt-15)) shall continue to come from the host players
bound to the CODE local roles and override any same-named keys,
independent of the CODE option slice.

## Session trace and player continuation

### PBRT-37

Where a host initializes a linked playbook runtime with a
`PlaybookSession`, the runtime shall emit telemetry topic
`playbook.trace` carrying the immutable session and playbook ids and
the schema defined by
[DR-011 §5](../decisions/011-composable-playbook-execution.md#5-trace-causality),
including the session causality and version-2 extensions to
[DR-010 §2](../decisions/010-playbook-session-tracing-and-resume.md#2-boundary-complete-trace).
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

### PBRT-38

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

## Structured and composed execution

### PBRT-40

Where an FSM contains a fixed set of independent player tasks whose
results join before later work, when the linked runtime drives that
state, the FSM shall represent the tasks as XState parallel regions
whose working leaves invoke their declared `player` actor and whose local final states join
through the parallel parent's `onDone` transition, per
[DR-011 §1](../decisions/011-composable-playbook-execution.md#1-structured-parallel-work).
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

### PBRT-41

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

### PBRT-42

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

## Parked-session snapshot

### PBRT-45

Where a linked runtime implements the optional durable-session
capability of `@sublang/playbook/runtime`
([DR-014 §1](../decisions/014-durable-one-shot-run-sessions.md#1-parked-session-snapshot-capability)),
the runtime shall implement `exportSnapshot` and `restore` together.
When `exportSnapshot` is called at a safe capture point — initialized,
not disposing or disposed, no active public boundary, no pending nested
playbook call, and the root actor quiescent with actor status `active` —
it shall return a JSON-safe `PlaybookRuntimeSnapshot` carrying schema
version `1`, the session's playbook id, the persisted machine snapshot
with any raw `Error` context value normalized to `{ name, message,
stack? }`, the player resume-token map, the trace/turn/judge-call/
player-call/playbook-call sequence counters, the current normalized
state descriptor, and the pending Boss questions as
`{ questionId, player, question, sourceItem? }` entries; at any other
point it shall return `undefined`.
When `restore` is called on an unused runtime instance with the same
immutable session identity the snapshot was exported under, the runtime
shall validate the snapshot's schema version and that its playbook id
equals `session.playbookId` — module identity stays a host check
([PBCLI-23](playbook-cli.md#pbcli-23)) — bind the session, restore the
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
([DR-014 §5](../decisions/014-durable-one-shot-run-sessions.md#5-preserved-scope)).
