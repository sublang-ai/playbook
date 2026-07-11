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

The runtime module shall import the FSM artifact, XState, and the
shared runtime contract types from `@sublang/playbook/runtime`
([PBRT-34](#pbrt-34)), hold no host-specific types, and interact
with its host exclusively through the `PlaybookPorts` interface
(`callPlayer`, `callJudge`, `emitStatus`, `emitTelemetry`). It shall
re-export `PlayerResult`, `PlaybookPorts`, `PlaybookSession`, and
`PlaybookRuntime` from that shared module rather than redefining them,
so consumers of
`@sublang/playbook/code/playbook` resolve the same contract types. It
shall default-export a `createPlaybookRuntime(options)` factory
returning a `PlaybookRuntime` (`init`, `handleBossInput`, `dispose`),
typed `PlaybookRuntimeFactory<CodePlaybookOptions>`. The options shall
carry only per-run identity strings; the mapping from FSM players to
player-id strings shall be fixed in the runtime, not supplied at run
time.

### PBRT-34

The package shall provide a type-only module resolvable as
`@sublang/playbook/runtime` that is the single authored source of the
runtime contract types `PlayerResult`, `PlayerCallOptions`,
`PlaybookPorts`, `PlaybookSession`, `PlaybookTraceEvent`,
`PlaybookRuntime`, and `PlaybookRuntimeFactory<Options = unknown>`, as
the TypeScript projection of
[slc/link.md](../../slc/link.md#playbookruntime-contract).
`PlayerResult.status` shall be the union `'ok' | 'aborted' | 'error'`,
`PlayerResult` shall expose optional `resumeToken`, `PlayerCallOptions`
shall require `resume: string | false`, `PlaybookRuntime.init` shall
accept a `PlaybookSession`, and `PlaybookPorts` shall declare exactly
the members `callPlayer`,
`callJudge`, `emitStatus`, and `emitTelemetry`.
The module shall import no CODE or FSM types, directly or
transitively, so it carries no dependency on any specific playbook;
the dependency runs one way, from `code.playbook` to this module
([PBRT-5](#pbrt-5)).
The module shall carry only type declarations and shall add no runtime
engine, linker, or host primitives.

## Session lifecycle

### PBRT-6

When `init({ sessionId, playbookId, ports })` is called with non-empty
identity fields, the runtime shall bind that identity immutably for its
lifetime, construct the FSM actor from the options, and start it,
leaving the FSM in its idle
state. When `dispose()` is called, the runtime shall stop the
actor and drain any pending port emissions. When `handleBossInput`
is called before `init`, the runtime shall throw.

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

While driving a Boss turn, for each FSM captain invocation the
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
[DR-010 §2](../decisions/010-playbook-session-tracing-and-resume.md#2-boundary-complete-trace).
The trace sequence shall be contiguous and one-based for that session;
Boss turns and player/judge calls shall receive one-based ids, and a
call's started and finished events shall share its call id.
The runtime shall trace session start/disposal, exact Boss input and
settlement, exact player and judge prompts and results, normalized
errors, every FSM transition, and every status emission.
Trace emissions shall be awaited and shall precede the boundary call,
status, or state telemetry they describe; trace payloads shall never be
copied into Boss-visible status text.
Empty Boss input shall still produce its received and settled trace
events while producing no judge call, player call, status emission, or
FSM action.

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
The runtime shall key tokens by the resolved player id, keep separate
players independent, preserve the map across parked turns and actor
reconstruction within the runtime session, and discard it on dispose.
