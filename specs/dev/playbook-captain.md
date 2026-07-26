<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - system behavior

## Intent

This spec defines implementation requirements for the built-in
Playbook Captain shell that runs as the tmux-play Captain and hosts
registered playbook runtimes.
The shell is a meta-level Captain over playbooks; it does not
replace the CODE runtime contract in [PBRT](playbook-runtime.md).
The published `@sublang/playbook` module surface is essential to
this package's intent because tmux-play configs import the shell by
package specifier.

## Registry and shell state

### CAPTAIN-5

Where the package exposes the Playbook Captain shell as a tmux-play
Captain, the shell shall own a registry of playbook entries.
Each entry shall be a manifest carrying `id` (stable playbook id and
default options-namespace key), `command` (default slash command
without `/`, overridable by config), `intent` (routing description
for the compiled Captain catalog), `requiredRoleIds` (local role ids the
runtime may pass to `callPlayer`), an optional `summaryPolicy`
([CAPTAIN-20](#captain-20)), a `validateOptions` function for that
entry's own option slice, and a `createRuntime` factory for the
linked runtime.
The CODE entry shall declare `id` `code`, `command` `code`, intent
text for a software-development / SDLC coding workflow,
and `requiredRoleIds` `coder` and `reviewer`.
CODE's Committer alias shall remain a CODE-owned option validated by
the CODE entry ([PBRT-30](playbook-runtime.md#pbrt-30)), not a
shell-level concept.
The shell shall take each playbook's required roles, summary policy,
option validator, and runtime factory
from its manifest entry.
The shell shall take each enabled playbook's option slice from its
normalized `captain.options.playbooks.<id>` config
([CAPTAIN-16](#captain-16)) validated against that entry, and shall
derive the role binding from the entry's `id` and roles
([CAPTAIN-10](#captain-10)).
The shell shall use run-result outcomes and normalized descriptor tags
for lifecycle and shall not hardcode CODE state ids or CODE-specific
summary labels.
The shell shall support one active root engagement with the nested LIFO
frames permitted by [CAPTAIN-29](#captain-29) and shall keep only a
bounded control ledger: root and leaf playbook/session ids, bounded
frame path and depth, shell mode, latest leaf runtime state descriptor,
pending Boss questions when mirrored from telemetry, normalized last
error when mirrored from telemetry, and last lifecycle decision.
The normalized last error shall carry only `{ name, message }`.
The shell shall not duplicate the full Boss conversation in its
ledger.

### CAPTAIN-6

Where the Playbook Captain shell handles Boss turns, the shell FSM
shall model durable modes `chat`, `engaged.driving`, and
`engaged.parked`.
When the shell emits its own FSM telemetry, it shall use topic
`playbook.captain.fsm.state`, not `playbook.fsm.state`.
The shell FSM telemetry payload shall carry `from`, `to`, `event`,
and a snapshot of the bounded control ledger.
If engagement initialization fails after entering `engaged.parked`, the shell
shall pop the broken frame and emit a best-effort recovery transition back to
`chat` with stack depth zero while preserving the original failure.
The shell shall put Boss-visible shell state in human-readable
status message text and shall not attach structured data to
shell-owned status emissions; structured shell state shall be
carried through shell FSM telemetry instead.
The shell shall reserve `playbook.fsm.state` for sub-runtime
telemetry that it passes through.

## Routing

### CAPTAIN-7

Where the Playbook Captain shell receives a Boss turn, the shell
shall parse registered commands before runtime routing. While idle, a
registered command shall select that external playbook directly and
all other non-empty text shall lazily create the compiled default
Captain root. Empty or whitespace-only idle text shall return without
allocating a session or runtime. While a stack exists, the shell shall select its active
leaf from host state and shall not let a command replace the root.
For engaged ordinary text, a hidden lifecycle-only classifier may
return exactly `deliver` or `dismiss`; it shall choose `dismiss` only when
Boss explicitly asks to stop or dismiss the active leaf and shall choose
`deliver` for every task instruction, answer, clarification, continuation,
near miss, or ambiguous message. It shall receive the original Boss text but
no registry, ledger, frame, session, or call identity. `deliver`, a rejected
or thrown call, malformed or unknown output, a non-`ok` result, or an `ok`
result without `finalText` shall submit the original text unchanged to the
active leaf. The classifier shall neither select a playbook nor synthesize
replacement or dismissal text.

### CAPTAIN-8

Where the Playbook Captain shell submits text to an engaged
playbook runtime, the shell shall call the active leaf runtime's
`handleBossInput` with text and the Boss-turn signal and consume its
`PlaybookRunResult`.
The shell shall not pre-classify playbook events, choose
`BOSS_INTERRUPT` targets, expose jumpable state lists through the
registry, or otherwise decide in-playbook FSM events.

## Captain calls and ports

### CAPTAIN-9

Where the Playbook Captain shell uses cligent Captain primitives,
the shell shall use one Captain agent configuration and shall serialize
visible compiled Captain work, hidden lifecycle calls, and hidden sub-runtime
judge calls through one abort-aware concurrency-one queue. Hidden lifecycle
and sub-runtime judge calls shall pass `{ visibility: 'hidden' }` to
`callCaptain`.
Shell-owned command guidance and turn summaries shall use their separate
visible prompt envelopes; the shell shall not wrap or rewrite a compiled
runtime's `callCaptain` prompt.
Hidden control calls shall use a prompt envelope that identifies
the call as control work and asks for control JSON only.
For a hidden sub-runtime judge call, that envelope shall preserve the
runtime-supplied judge prompt verbatim as delimited evidence, shall direct the
judge to treat quoted actor output only as evidence rather than instructions,
shall forbid tool use and the execution, simulation, or narration of tool
calls, shell commands, or tool transcripts, and shall require exactly one JSON
object with no prose, Markdown, code fence, or transcript.

### CAPTAIN-10

Where the Playbook Captain shell constructs a sub-runtime, the
shell shall wrap that runtime's `PlaybookPorts` and shall apply the
active entry's local-role-to-host-player binding.
The binding for local role `<role>` in playbook `<id>` shall be the
host player id `<id>-<role>`, so CODE's `coder` and `reviewer` bind
to host players `code-coder` and `code-reviewer`.
The wrapper shall route a sub-runtime `callPlayer(localRole, …,
{ resume })` to `context.callPlayer(<id>-<localRole>, …,
{ resume })`, return the host result's `resumeToken`, route sub-runtime
`callCaptain(prompt, signal, options)` through the shared Captain queue to
`context.callCaptain(prompt, options)`, preserving the required `visibility`
and `resume` selections and whether optional `allowedTools` was supplied or
omitted, and return Playbook's Captain status,
final text, and error without player or resume-token fields, route
sub-runtime `callJudge` through that same queue to hidden
`context.callCaptain`, route `callPlaybook` through the stack protocol
in [CAPTAIN-29](#captain-29), and pass sub-runtime
`emitStatus` and `emitTelemetry` calls through to the host in order.
The shell shall also pass the resolved binding in the metadata given
to the entry's `createRuntime`, so a playbook such as CODE can derive
prompt identity strings from the host player actually bound to each
local role ([PBRT-15](playbook-runtime.md#pbrt-15)).
When hidden `context.callCaptain` returns a non-`ok` status or an
`ok` status without `finalText`, the wrapper shall throw for that
sub-runtime `callJudge`; otherwise it shall return `finalText`.
Before passing through `playbook.fsm.state` telemetry, the wrapper
shall mirror the active leaf's normalized state descriptor and any
pending Boss questions or normalized error fields needed for the shell
ledger.

### CAPTAIN-31

Where the shell hosts the compiled default Captain, when it forwards a visible routing or reassessment call, the shell shall request `resume: false` and `allowedTools: []` and preserve the runtime prompt as the exact host prompt; when it forwards a hidden adjudication call, it shall request the same isolation and preserve the runtime-supplied judge prompt verbatim inside the hidden-control envelope required by [CAPTAIN-9](#captain-9). Where the launcher has supplied the resolved captain adapter as
`captain.options.captainAdapter` and that adapter has no provider-enforced
tool-restriction surface, the shell shall omit `allowedTools` from those calls
instead of sending the empty list, degrading that adapter's isolation to the
[CAPTAIN-9](#captain-9) hidden-control envelope per
[DR-013 A1](../decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement);
where the adapter is absent or unrecognized it shall keep requesting the empty
allowlist.
The shell shall reject either call if the configured adapter is asked for the empty allowlist and cannot enforce it; the shared queue shall serialize these isolated calls without treating an agent conversation as workflow memory.
Where the shell submits an ordinary idle turn to the default Captain runtime,
it shall pass the original Boss text unchanged and shall not make a model call
that can replace or paraphrase that text before runtime entry.

### CAPTAIN-20

Where the Playbook Captain shell submits text to an engaged
playbook runtime, the shell shall collect turn-summary counts only
for the duration of that sub-runtime `handleBossInput` call, and
only when the active registry entry declares a `summaryPolicy`.
When the active registry entry declares no `summaryPolicy`, the
shell shall skip turn-summary counting and shall not make the
visible turn-summary Captain call for that turn
([CAPTAIN-19](../user/playbook-captain.md#captain-19)).
The `summaryPolicy` maps counted state ids and adjudication guard
names to Boss-visible labels and supplies the saved-counts line
template or equivalent wording policy.
For that same duration, the shell shall aggregate sub-runtime
`playbook.fsm.state` telemetry into a summary-visible progress
phrase for the turn-summary prompt, counting only state ids that the
active registry entry's `summaryPolicy` labels.
The summary-visible progress phrase shall be `none` when no
summary-visible state occurred.
The summary-visible progress round total shall be the sum of all
summary-visible state counts collected for the completed
sub-runtime turn.
When the active registry entry's `summaryPolicy` provides a
state-count label for a state id, the shell shall count that state
under the provided label.
When the `summaryPolicy` does not provide a state-count label for a
state id, the shell shall not count that state in the turn-summary
prompt and shall not derive a fallback label from the state id.
When a wrapped sub-runtime `callPlayer` call returns a player
reply, the shell shall count one saved interruption for that reply.
When a wrapped hidden sub-runtime adjudication call returns a guard
whose name appears in the active registry entry's `summaryPolicy`
copy-paste guard names, the shell shall count one saved copy-paste
for that inter-player handoff.
The shell shall count one saved copy-paste per adjudicated
handoff, regardless of how many individual review findings or
rebuttal items the handoff text contains.
Each registry entry's `summaryPolicy` shall own its exact copy-paste
guard names, so an adjudicated guard removed from that list is not
counted.
The shell shall not count hidden lifecycle calls, shell-owned command-guidance calls,
sub-runtime classifier/event JSON, or malformed adjudication
replies as saved copy-pastes.
After the sub-runtime `handleBossInput` call settles, the shell
shall make one visible Captain call with a turn-summary prompt
envelope.
The turn-summary prompt envelope shall provide the exact saved
interruption and copy-paste counts, shall provide the aggregate
summary-visible progress phrase and round total, and shall instruct
Captain to write the Boss-visible block required by
[CAPTAIN-19](../user/playbook-captain.md#captain-19) using the
active entry's `summaryPolicy` wording, including its saved-counts
line template with the supplied counts and natural singular forms
when a count is one.
The turn-summary prompt envelope shall instruct Captain not to
include counts for state ids the `summaryPolicy` does not label.
The turn-summary prompt envelope shall instruct Captain not to
repeat the exact summary-visible progress round count outside the
saved-counts line.
The turn-summary prompt envelope shall not include shell ledger JSON
or raw state ids for states that are not counted in the
summary-visible progress phrase.

## Lifecycle

### CAPTAIN-11

Where the Playbook Captain shell has an active leaf runtime, when its
normalized state is quiescent and tagged `playbook.parked` or its run
result is suspended, the shell shall park the root engagement in
`engaged.parked`.
Where the active root runtime returns terminal or the lifecycle classifier dismisses
the root, the shell shall dispose the complete stack and return to
its idle `chat` mode without making another visible chat call; where a child returns terminal or is dismissed, the shell shall
return it to its parent per [CAPTAIN-29](#captain-29).
The shell shall defer terminal disposal until the active runtime call
settles.
Where the Boss submits text while a leaf is parked, the shell shall
reuse that exact leaf runtime rather than constructing a replacement.
Where the Playbook Captain shell has no active stack, when a registered
command selects an enabled external playbook, the shell shall construct a new
root runtime from that registry entry's `createRuntime` function and the
validated options captured during `init`; when any other non-empty idle text
arrives, it shall instead lazily construct the internal default Captain root.
In either case it shall generate a previously unissued UUID playbook session
id and initialize the runtime with that id, its playbook id, and the wrapped
ports.
Where the Playbook Captain shell has disposed an active root stack
because it reached its final state or was dismissed, when a later
registered command or compiled Captain call engages the same playbook id,
the shell shall construct a replacement sub-runtime.

## Adapter lifecycle

### CAPTAIN-16

Where tmux-play calls the Playbook Captain shell adapter's
`init(session)`, the shell shall store the session, load the enabled
playbook registry entries from `captain.options.playbooks`, derive
each entry's local-role-to-host-player binding
([CAPTAIN-10](#captain-10)) from its generated host player ids,
validate each entry's own option slice through that entry's
`validateOptions`, enter `chat`, and not construct a sub-runtime.
The shell shall require `captain.options.playbooks` and shall reject
`init` when it is missing or empty; it shall not infer a CODE-only
default from `captain.options.code`.
Each `captain.options.playbooks.<id>` entry in the normalized shell
config shall carry a `from` module specifier, an optional `command`
override, and an `options` slice (the entry's namespaced option
object).
The generic `playbook` launcher produces this normalized shape from
its user-facing playbook block, hoisting that block's `players` into
the top-level tmux-play roster and folding non-launcher keys into
`options`; the shell consumes only the normalized shape and does not
re-derive it.
For each enabled playbook the shell shall import the module named by
`from` and read its default export as the registry entry, treating a
module whose default export is not a manifest entry carrying the
[CAPTAIN-5](#captain-5) fields as exposing no valid registry entry.
The `captain.options.playbooks` map key is the playbook `<id>` the
shell binds with ([CAPTAIN-10](#captain-10)) and shall equal that
module's manifest `id`.
The shell shall compute each playbook's effective command as the
entry's config `command` when present and the manifest's default
`command` otherwise.
The shell shall reject `init` when `from` is missing, the import
fails, the module exposes no valid registry entry, a map key differs
from its module's manifest `id`, two enabled playbooks share an `id`,
two enabled playbooks resolve to the same effective command, or an enabled
playbook's id or effective command is the reserved internal name `captain`.
The shell shall pass each entry only its normalized option slice and
shall not extract an entry's namespace from the full Captain options
bag.
When any entry's option validation fails during `init(session)`, the
shell shall reject `init`.
Where tmux-play calls `handleBossTurn(turn, context)` after `init`,
the shell shall route `turn.prompt` with `context.signal` and use
`context` as the active per-turn target for player and Captain
calls until that turn settles.
When tmux-play calls `handleBossTurn(turn, context)` before
`init(session)`, the shell shall reject the call.
Where tmux-play calls `prepareDispose()` while session emissions remain
live, the shell shall dispose every active frame from leaf to root so
each final trace can drain, clear the active turn context, emit no shell
status or shell FSM telemetry for the adapter teardown itself, and
resolve only after every runtime's `dispose()` call returns. The shell's later
`dispose()` hook shall retain the same operation as an idempotent
fallback for older or non-tmux hosts.

## Playbook session bridge

### CAPTAIN-26

Where the Playbook Captain shell constructs a new root engagement, when
it initializes the linked runtime, the shell shall generate a
non-empty, previously unissued UUID, store it as both active and root
playbook session id, and call `runtime.init` with that id,
`rootSessionId` equal to it, depth zero, the playbook id, and ports.
The same parked runtime shall retain that id; a replacement engagement
after final completion or dismissal shall receive a new one; and a
collision from an injected id generator shall reject rather than reuse
an earlier id.
The shell shall include root and leaf session ids in its bounded ledger
and shell FSM telemetry, pass sub-runtime `playbook.trace` telemetry
through unchanged, forward every explicit player `resume` selection to
cligent's `context.callPlayer`, and return the authoritative host
`resumeToken` unchanged.
The shell shall put neither resume tokens nor trace payloads in model
prompts, visible status messages, or turn summaries.
If engagement initialization rejects, the shell shall clear the broken
engagement, best-effort dispose its partially initialized runtime while
preserving the original failure, and let a later command construct a
new external engagement with a new session id or a later ordinary idle turn
construct a new internal Captain root with a new session id.
Its recovery shell telemetry shall show `chat` and an empty stack rather than
leaving observers at the earlier attempted engagement.

## Nested playbook stack

### CAPTAIN-29

Where the active runtime calls `PlaybookPorts.callPlaybook`, when the
target id names an enabled registry entry and does not form an
active-path cycle, the shell shall construct and initialize a distinct child
runtime, push it above its caller, switch visibility to the child's
players, and submit the call input as the child's initial Boss text.
The child `PlaybookSession` shall receive a fresh UUID plus
`rootSessionId`, `parentSessionId`, `parentCallId`, and depth; the root
shall use its own UUID as root id and depth zero.
The shell shall permit one outstanding child per frame, reject a target
already present anywhere on the active frame path (including the
caller), and reject a target absent from
the enabled registry without leaving a partial frame.
The active-path cycle rule shall bound depth by the finite enabled
registry without imposing a separate numeric limit.
When the initial child turn parks or suspends, `callPlaybook` shall
return its suspended child session id so the parent runtime can settle
its Boss turn; only the top frame shall receive later Boss turns.
When a child returns terminal output, rejects at the runtime boundary,
is aborted, or is dismissed, the
shell shall dispose and pop it, restore external-parent visibility when
applicable, and call the parent's `resumePlaybookCall` with the same call id
and current-turn signal, continuing until the top frame parks, suspends, or waits for
Boss, or the root finishes.
Where a child returns workflow outcome `failed` in a recoverable parked
state, the shell shall retain it as the active leaf for later Boss recovery
rather than return an error to its parent.
Child initialization failure shall dispose and remove the partial child
and return an error result to the parent without replacing the parent
frame.
Root dismissal and adapter teardown shall dispose frames from leaf to
root; teardown shall not resume callers after disposal begins.
The shell's bounded ledger and shell telemetry shall identify the root
and top session and contain only bounded causal frame metadata; hidden
lifecycle prompts, compiled Captain prompts, shell-owned visible prompts,
status, and summaries shall contain neither the
stack ledger nor session/call ids.
The shell shall pass each frame's `playbook.trace` through unchanged,
including the causal fields on child `session.started` and parent
`playbook.call.*` events.

## Active-playbook visibility

### CAPTAIN-22

Where the Playbook Captain shell runs under tmux-play with one or more
playbooks enabled, when the shell selects, resumes, routes a Boss turn to,
pushes, or returns to an enabled external leaf, the shell shall request tmux-play
visibility for that leaf playbook's generated host player ids through
`setVisiblePlayers` before dispatching Boss text to the playbook
runtime.
The requested visible set shall be the external leaf's generated
host player ids and shall never be empty.
The playerless internal Captain root shall make no visibility request;
when an external child is active, that child's non-empty generated set
shall apply.
Because the launcher has already validated those generated player
ids against the composed tmux-play roster, a `setVisiblePlayers`
validation rejection shall be treated as an internal shell or
composition error rather than a Boss input error.
A tmux pane reconciliation failure reported by tmux-play shall be
treated as display-only and shall not block dispatch to the playbook
runtime.
After a playbook reaches final completion or is dismissed, the
visible panes may remain on the last selected playbook until the
next selection.

## Public module surface

### CAPTAIN-17

Where `@sublang/playbook` exposes the Playbook Captain shell for
tmux-play, the package shall expose the public module specifier
`@sublang/playbook/playbook-captain`.
That module's default export shall be a tmux-play Captain factory
for the Playbook Captain shell, which loads its enabled playbooks
from `captain.options.playbooks` at `init`
([CAPTAIN-16](#captain-16)) rather than hardcoding any playbook.
