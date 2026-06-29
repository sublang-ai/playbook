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
for hidden Captain selection), `requiredRoleIds` (local role ids the
runtime may pass to `callPlayer`), `idleStateId` (the idle
return-to-Boss state id), `finalStateId` (the final-completion state
id), `parkStateIds` (additional state ids that park the engagement
and wait for another Boss turn), an optional `summaryPolicy`
([CAPTAIN-20](#captain-20)), a `validateOptions` function for that
entry's own option slice, and a `createRuntime` factory for the
linked runtime.
The CODE entry shall declare `id` `code`, `command` `code`, intent
text for a software-development / SDLC coding workflow,
`requiredRoleIds` `coder` and `reviewer`, `idleStateId` `ready`,
`finalStateId` `done`, and `parkStateIds` `failed` and
`awaitBossReply`.
CODE's Committer alias shall remain a CODE-owned option validated by
the CODE entry ([PBRT-30](playbook-runtime.md#pbrt-30)), not a
shell-level concept.
The shell shall take each playbook's idle / final / park state ids,
required roles, summary policy, option validator, and runtime factory
from its manifest entry.
The shell shall take each enabled playbook's option slice from its
normalized `captain.options.playbooks.<id>` config
([CAPTAIN-16](#captain-16)) validated against that entry, and shall
derive the role binding from the entry's `id` and roles
([CAPTAIN-10](#captain-10)).
The shell shall not hardcode CODE state ids such as `failed` or
`awaitBossReply` or CODE-specific summary labels.
The shell shall support one active engagement and shall keep only
a bounded control ledger: active playbook id, shell mode, latest
sub-runtime state id, pending Boss question when mirrored from
telemetry, normalized last error when mirrored from telemetry, and
last route decision.
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
The shell shall put Boss-visible shell state in human-readable
status message text and shall not attach structured data to
shell-owned status emissions; structured shell state shall be
carried through shell FSM telemetry instead.
The shell shall reserve `playbook.fsm.state` for sub-runtime
telemetry that it passes through.

## Routing

### CAPTAIN-7

Where the Playbook Captain shell receives a Boss turn, the shell
shall route by registered command parsing before using hidden
Captain routing.
The hidden router prompt shall receive the bounded ledger plus the
registry command list and intent descriptions, and shall return one
closed decision: `chat`, `dispatch`, `sub`, or `dismiss`.
When the router chooses `dispatch`, the decision shall carry the
target playbook id and text to submit to that playbook.
When the router chooses `sub`, the decision shall carry text for
the active sub-runtime.
The shell shall treat unregistered slash-prefixed text as router
input rather than as a failed command namespace.
The shell shall handle near-miss command-like text as visible chat
clarification rather than as low-confidence dispatch.
When the hidden router reply is malformed, names an unknown
decision, names an unknown playbook id, or omits text required by
the chosen decision, the shell shall produce visible clarification
and shall not dispatch to a sub-runtime.
When the hidden router call returns a non-`ok` status or an `ok`
status without `finalText`, the shell shall produce visible
clarification and shall not dispatch to a sub-runtime.

### CAPTAIN-8

Where the Playbook Captain shell submits text to an engaged
playbook runtime, the shell shall call that runtime's
`handleBossInput` with text and the Boss-turn signal.
The shell shall not pre-classify playbook events, choose
`BOSS_INTERRUPT` targets, expose jumpable state lists through the
registry, or otherwise decide in-playbook FSM events.

## Captain calls and ports

### CAPTAIN-9

Where the Playbook Captain shell uses cligent Captain primitives,
the shell shall use one underlying Captain session for visible
Boss chat, hidden router calls, and hidden sub-runtime judge calls.
Hidden router and sub-runtime judge calls shall pass
`{ visibility: 'hidden' }` to `callCaptain`.
Visible Boss chat shall use a separate prompt envelope that permits
normal conversation and forbids exposing hidden control JSON.
Hidden control calls shall use a prompt envelope that identifies
the call as control work and asks for control JSON only.

### CAPTAIN-10

Where the Playbook Captain shell constructs a sub-runtime, the
shell shall wrap that runtime's `PlaybookPorts` and shall apply the
active entry's local-role-to-host-player binding.
The binding for local role `<role>` in playbook `<id>` shall be the
host player id `<id>-<role>`, so CODE's `coder` and `reviewer` bind
to host players `code-coder` and `code-reviewer`.
The wrapper shall route a sub-runtime `callPlayer(localRole, …)` to
`context.callPlayer(<id>-<localRole>, …)`, route sub-runtime
`callJudge` to hidden `context.callCaptain`, and pass sub-runtime
`emitStatus` and `emitTelemetry` calls through to the host in order.
The shell shall also pass the resolved binding in the metadata given
to the entry's `createRuntime`, so a playbook such as CODE can derive
prompt identity strings from the host player actually bound to each
local role ([PBRT-15](playbook-runtime.md#pbrt-15)).
When hidden `context.callCaptain` returns a non-`ok` status or an
`ok` status without `finalText`, the wrapper shall throw for that
sub-runtime `callJudge`; otherwise it shall return `finalText`.
Before passing through `playbook.fsm.state` telemetry, the wrapper
shall mirror the active sub-runtime state and any pending Boss
question or normalized error fields needed for the shell ledger.

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
phrase for the turn-summary prompt, excluding the active registry
entry's idle and final state ids.
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
The shell shall not count hidden router calls, visible chat calls,
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

Where the Playbook Captain shell has an active sub-runtime, when
the mirrored sub-runtime state is the registry entry's `idleStateId`
or any of the entry's `parkStateIds`, the shell shall park the
engagement in `engaged.parked`.
Where the Playbook Captain shell has an active sub-runtime, when
the mirrored sub-runtime state is the registry entry's final state
or the router chooses `dismiss`, the shell shall dispose the active
sub-runtime and return to `chat`.
When the mirrored sub-runtime state is the registry entry's final
state during a dispatched Boss turn, the shell shall defer disposal
until that sub-runtime `handleBossInput` call settles.
Where the Playbook Captain shell has an active sub-runtime, when
the Boss submits text for the same playbook while it is parked, the
shell shall reuse the existing sub-runtime rather than constructing
a replacement.
Where the Playbook Captain shell has no active sub-runtime, when a
registered command or router decision engages a playbook id, the
shell shall construct a new sub-runtime from that registry entry's
`createRuntime` function and the validated options captured during
`init`.
Where the Playbook Captain shell has disposed an active sub-runtime
because it reached its final state or was dismissed, when a later
registered command or router decision engages the same playbook id,
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
or two enabled playbooks resolve to the same effective command.
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
Where tmux-play calls `dispose()`, the shell shall dispose any
active sub-runtime, clear the active turn context, emit no shell
status or shell FSM telemetry for the adapter teardown itself, and
resolve only after the active sub-runtime's `dispose()` call
returns.

## Active-playbook visibility

### CAPTAIN-22

Where the Playbook Captain shell runs under tmux-play with one or
more playbooks enabled, when the shell selects, resumes, or routes a
Boss turn to a playbook, the shell shall request tmux-play
visibility for that playbook's generated host player ids through
`setVisiblePlayers` before dispatching Boss text to the playbook
runtime.
The requested visible set shall be the active playbook's generated
host player ids and shall never be empty.
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
