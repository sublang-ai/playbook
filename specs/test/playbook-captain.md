<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - integration tests

## Intent

This spec defines integration tests for the built-in Playbook
Captain shell under tmux-play.
The tests drive the real shell adapter with CODE registered against
stubbed cligent Captain primitives and fake or real CODE runtime
ports as needed.

## Routing

### CAPTAIN-12

Verifies: [CAPTAIN-1](../user/playbook-captain.md#captain-1), [CAPTAIN-2](../user/playbook-captain.md#captain-2), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-8](../dev/playbook-captain.md#captain-8)

Where the test suite drives the Playbook Captain shell with CODE
registered, while no playbook is engaged and while CODE is already
engaged, the test suite shall fail unless `/code <text>` dispatches
to CODE with `<text>`, bare `/code` produces visible chat without
resetting an existing CODE runtime, unregistered slash-prefixed and
near-miss command-like inputs lazily reach the default Captain rather than a
negative command path, a different registered command while CODE is
engaged produces visible resolution guidance without dispatch,
ordinary text while CODE is engaged, including while parked, routes
unchanged to the active leaf after lifecycle classification, and every
dispatch to CODE calls `handleBossInput` with text rather than a
pre-classified FSM event.
Whitespace-only idle input shall allocate no internal Captain runtime,
session, call, status, visibility request, or telemetry event.

### CAPTAIN-13

Verifies: [CAPTAIN-1](../user/playbook-captain.md#captain-1), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-9](../dev/playbook-captain.md#captain-9)

Where the test suite drives ordinary Boss text through the Playbook
Captain shell, the test suite shall fail unless idle text lazily enters
the compiled default Captain; engaged lifecycle decisions `deliver`
and `dismiss` are closed and only an explicit stop or dismissal request may
dismiss; a rejected or thrown call, invalid JSON, unknown decision, non-`ok`
result, and `ok` result without `finalText` each fail open by delivering the
original text unchanged to the active leaf; extra replacement or dismissal
text is never used; and every lifecycle call is hidden and contains no
registry, ledger, frame, session, or call identity.

## Lifecycle and telemetry

### CAPTAIN-14

Verifies: [CAPTAIN-3](../user/playbook-captain.md#captain-3), [CAPTAIN-4](../user/playbook-captain.md#captain-4), [CAPTAIN-6](../dev/playbook-captain.md#captain-6), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), [CAPTAIN-11](../dev/playbook-captain.md#captain-11), [CAPTAIN-16](../dev/playbook-captain.md#captain-16)

Where the test suite drives CODE under the Playbook Captain shell,
the test suite shall fail unless sub-runtime status and telemetry
are passed through in order, `playbook.fsm.state` telemetry is
mirrored through its normalized state descriptor into the shell ledger
before pass-through, shell FSM
telemetry uses `playbook.captain.fsm.state` with `from`, `to`,
`event`, and ledger fields, the active registry entry's quiescent
parked states park the engagement, a later same-playbook
turn resumes the same runtime instance, CODE final state disposes
the engagement only after the active turn settles, and lifecycle
`dismiss` disposes the engagement and returns the shell to idle;
a later dispatch after final disposal or dismissal constructs a
replacement runtime; engagement, dismissal, and final-disposal
status lines use the registered slash command in the
`◇ /<command> started`, `◇ /<command> stopped`, and
`◇ /<command> finished` vocabulary and carry no structured status
data; the internal Captain root emits none of those lifecycle lines and its
terminal response causes no second visible chat call; and shell `dispose()` disposes any active runtime without
emitting shell status or shell FSM telemetry for adapter teardown.
An initial malformed Captain classification shall retain the real Captain's
quiescent parked `ready` root, and a rejected runtime initialization shall
emit a recovery transition to `chat` whose ledger has stack depth zero.

## Registry and options

### CAPTAIN-15

Verifies: [CAPTAIN-5](../dev/playbook-captain.md#captain-5), [CAPTAIN-9](../dev/playbook-captain.md#captain-9), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), [CAPTAIN-16](../dev/playbook-captain.md#captain-16)

Where the test suite initializes the Playbook Captain shell with
CODE enabled through a `captain.options.playbooks.code` entry whose
`from` resolves the CODE registry module, the test suite shall fail
unless the loaded CODE registry entry carries id `code`, command
`code`, `requiredRoleIds` `coder` and `reviewer`, and no manifest
lifecycle state-id fields; lifecycle behavior shall follow runtime
results and descriptors; the entry's option slice
(`captain.options.playbooks.code.options`) is validated by the entry
during shell `init`; invalid CODE options cause `init` to reject;
valid CODE options do not construct a runtime until engagement;
`handleBossTurn` before `init` rejects; CODE player calls reach
`context.callPlayer` with the bound host player ids `code-coder` /
`code-reviewer`; CODE judge calls reach `context.callCaptain` with
their requested hidden visibility and isolation options; a runtime
`callCaptain` reaches `context.callCaptain` with its exact prompt and
requested visibility and resume, preserving either an explicit tool allowlist
or its omission, and
returns Captain status, final text, or error without a player resume token;
and compiled Captain work, lifecycle classification, shell-owned visible
calls, and sub-runtime judge calls use the same Captain configuration and
queue and never overlap.

### CAPTAIN-32

Verifies: [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-9](../dev/playbook-captain.md#captain-9), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), [CAPTAIN-31](../dev/playbook-captain.md#captain-31)

Where the shell hosts the real compiled default Captain, when an ordinary idle Boss turn is routed and adjudicated, the integration suite shall fail unless the runtime receives the original text unchanged, every visible decision and hidden adjudication call carries `resume: false`, and carries `allowedTools: []` unless the configured captain adapter has no provider-enforced tool-restriction surface, in which case it omits `allowedTools` per [DR-013 A1](../decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement) ([CAPTAIN-33](#captain-33)), every hidden adjudication envelope preserves the runtime judge prompt verbatim, treats quoted actor output only as evidence, forbids real or simulated tool work and transcripts, and requires one bare JSON object, calls remain single-flight, and an adapter that is asked for the empty allowlist and cannot enforce it fails before an investigative agent turn can run.

## Registry loading and visibility

### CAPTAIN-23

Verifies: [CAPTAIN-16](../dev/playbook-captain.md#captain-16), [CAPTAIN-22](../dev/playbook-captain.md#captain-22), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), [CAPTAIN-25](../user/playbook-captain.md#captain-25)

Where the test suite initializes the Playbook Captain shell with
`captain.options.playbooks` enabling one or more playbooks by `from`
module specifier, the test suite shall fail unless: a missing
`captain.options.playbooks`, a missing `from`, a failed import, a
module exposing no valid registry entry, a map key differing from its
module's manifest `id`, two enabled playbooks sharing an `id`, and two
enabled playbooks resolving to the same effective command, or any
configured id or effective command equal to reserved `captain` each
reject `init`; each enabled playbook's local
roles bind to host players `<id>-<role>` so a sub-runtime
`callPlayer(<role>, …)` reaches `context.callPlayer(<id>-<role>, …)`;
on engaging, resuming, or routing to an enabled external playbook the shell
calls `setVisiblePlayers` with that playbook's generated host player ids,
never an empty set, before dispatching Boss text; the internal Captain root
causes no visibility request; a
`setVisiblePlayers` validation rejection surfaces as an internal
shell error rather than a Boss input error; and a tmux pane
reconciliation failure does not block dispatch to the playbook
runtime.

## Generic command dispatch

### CAPTAIN-24

Verifies: [CAPTAIN-1](../user/playbook-captain.md#captain-1), [CAPTAIN-2](../user/playbook-captain.md#captain-2), [CAPTAIN-16](../dev/playbook-captain.md#captain-16)

Where the test suite initializes the Playbook Captain shell with CODE
and a second, test-only playbook both enabled by `from` module
specifier, and with the second playbook's `command` overridden in its
`captain.options.playbooks.<id>` config, the test suite shall fail
unless: the Boss's `/<command>` for the second playbook engages that
playbook and submits the text to its runtime rather than to CODE; the
overriding `command` is the effective command that engages the
playbook while the playbook's manifest default `command` is treated
as an unregistered command and does not dispatch; and a later
same-playbook `/<command>` reuses the existing runtime rather than
reconstructing it.

## Public module surface

### CAPTAIN-18

Verifies: [CAPTAIN-17](../dev/playbook-captain.md#captain-17)

Where the test suite resolves `@sublang/playbook` through its
package exports, the test suite shall fail unless
`@sublang/playbook/playbook-captain` resolves and default-exports
a tmux-play Captain factory for the Playbook Captain shell that
loads its enabled playbooks from `captain.options.playbooks` rather
than hardcoding any playbook.

## Turn summary

### CAPTAIN-21

Verifies: [CAPTAIN-19](../user/playbook-captain.md#captain-19), [CAPTAIN-20](../dev/playbook-captain.md#captain-20)

Where the test suite drives the Playbook Captain shell with a
registered playbook runtime, the test suite shall fail unless a
visible Captain turn-summary call is made — when the active registry
entry declares a summary policy — after registered-command and
engaged lifecycle-delivery submissions
settle and after the sub-runtime's ordered status and telemetry
emissions for the turn; no turn-summary call is made for the internal
Captain, after shell-owned command guidance, bare playbook selection, or lifecycle
recovery turns that do not submit to a sub-runtime, or when the
active registry entry declares no summary policy; the
turn-summary prompt contains the exact supplied saved-counts line
`Saved you X interruptions and Y copy-pastes across Z rounds of reviews/rebuttals.`
with natural singular forms when a count is one; completed
sub-runtime player replies increment the interruption count by one
per reply; adjudicated guards named by the active registry entry's
`summaryPolicy` copy-paste guard list increment the copy-paste count
by one per handoff; guards absent from that list,
classifier/event JSON, hidden lifecycle calls, shell-owned visible calls, and
malformed adjudication replies do not increment the copy-paste
count; sub-runtime state telemetry during the turn contributes only
an aggregate summary-visible progress phrase and round total,
counting active registry entry `summaryPolicy` labels exactly as
supplied and deriving no fallback label from state ids; unlabeled plan or
implementation steps, tests-green state ids, and other internal
states do not contribute to that phrase or total; and the prompt
instructs Captain to render a brief what-was-done summary, without
raw state /
transition / guard names, internal state counts, or how-it-was-done
narration, and without shell ledger JSON, followed by the
saved-counts line in a natural chat-like tone with clear
formatting.

## Playbook session bridge

### CAPTAIN-27

Verifies: [CAPTAIN-26](../dev/playbook-captain.md#captain-26)

Where the test suite drives the Playbook Captain shell with an injected
session-id generator and resumable fake or real host players, the test
suite shall fail unless engagement creates a new UUID, parking and
same-runtime resume retain it, final completion or dismissal followed
by re-engagement creates a different UUID, and an injected collision
rejects.
The root runtime init argument, bounded ledger, shell FSM telemetry,
and passed-through `playbook.trace` shall carry the active id as both
session and root-session id with depth zero.
The shell bridge shall forward `resume: false` and explicit tokens to
the bound host player and preserve the host's returned `resumeToken`;
a real tmux-play integration shall prove an old host-player token is
not inherited by a new playbook session and that the next call in that
session resumes its own returned token. The real host shall also prove
that final completion and active host teardown each deliver exactly one
`session.disposed` trace before session emissions close, without a
second disposal from the post-close Captain hook.
Visible status and turn summaries shall remain unchanged and shall
contain neither session ids, resume tokens, nor trace payloads.
When runtime initialization rejects, the test shall fail unless the
shell disposes the partial runtime, clears it, and a later command constructs a
different external engagement or a later ordinary idle turn constructs a
different internal Captain root instead of reusing the failed one.
The failed engagement's shell telemetry shall finish in `chat` with no frame.

## Nested playbook stack

### CAPTAIN-30

Verifies: [CAPTAIN-28](../user/playbook-captain.md#captain-28), [CAPTAIN-29](../dev/playbook-captain.md#captain-29)

Where the integration suite drives test parent and child runtimes
through the real Playbook Captain shell, the test suite shall fail
unless an immediate child completion resumes its parent in the same
Boss turn, a parked child settles that turn and receives the next Boss
turn, and child completion then pops and continues the parent without
reconstructing it; external-parent visibility is restored when applicable,
while return to the internal Captain makes no visibility request.
An initial or later child `failed` result shall remain the active leaf only
when its descriptor is quiescent and tagged `playbook.parked`; an inconsistent
non-parked or non-quiescent failure shall be disposed and returned to its
parent as an error rather than retained as a dead leaf.
Every frame shall fail unless it receives a distinct UUID and the
correct root, parent, call, and depth fields; trace pass-through shall
preserve those fields and order child disposal before the parent's call
finish.
The test suite shall fail unless disabled targets, active-path cycles,
a second child from one frame, initialization failure, and stale return
ids reject without corrupting the caller; child dismissal
resumes the parent with an aborted result; root dismissal and teardown
dispose leaf to root; only the leaf receives Boss text and only an active
external leaf determines player visibility; and no model-visible response,
status, or summary exposes stack or session ids.
Where the internal Captain is the parent, child lifecycle status shall use
literal `Captain` in `◇ /<child> called by Captain`,
`◇ /<child> returned to Captain`, and
`◇ /<child> stopped; returning to Captain`, and shall never expose
`/captain`.

### CAPTAIN-33
Verifies: [CAPTAIN-31](../dev/playbook-captain.md#captain-31)

When the test suite drives the shell's control calls with a recorded
captain bridge, the test suite shall fail unless a shell built with
`captain.options.captainAdapter` naming an adapter without a
provider-enforced tool-restriction surface omits `allowedTools` from every
visible routing and hidden adjudication call while still requesting
`resume: false` and the hidden-control envelope, and unless a shell built
with an enforcing adapter, with no `captainAdapter`, or with an
unrecognized one requests `allowedTools: []` on those same calls.
