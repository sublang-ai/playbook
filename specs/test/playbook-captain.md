<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - integration tests

## Intent

This spec defines integration tests for the built-in Playbook
Captain shell under tmux-play.
The tests drive the real shell adapter with CODE registered against
stubbed cligent Captain primitives and fake or real CODE runtime
ports as needed.
The conversational-controller items drive the real shell with the
real compiled session Captain and the real linked CODE and real
compiled DISCUSS artifacts as registry entries, with per-call
scripted player results and scripted captain replies (function-form
wherever captured prompt content is asserted).

## Routing

### CAPTAIN-12

Verifies: [CAPTAIN-1](../user/playbook-captain.md#captain-1), [CAPTAIN-2](../user/playbook-captain.md#captain-2), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-8](../dev/playbook-captain.md#captain-8)

Where the test suite drives the Playbook Captain shell with CODE and
a second enabled playbook registered, the test suite shall fail
unless the command parse table resolves deterministically: idle
`/code <text>` starts CODE and submits `<text>` through
`handleBossInput` with text rather than a pre-classified FSM event;
`/code <text>` while CODE is the active leaf delivers `<text>` to
the existing runtime without resetting, disposing, or reconstructing
it; an enabled command absent from the active path switches —
dismissal then start, in that order; a command naming an active
non-leaf ancestor produces a captain reply only, with no dispatch
and no restart; bare `/code` produces a captain reply and never
starts or restarts; and no parse-resolved turn makes a model call to
parse the command itself.
Unregistered slash-prefixed and near-miss command-like inputs shall
reach the session Captain's decision call rather than a negative
command path.
Whitespace-only idle input shall allocate no runtime, session, call,
status, visibility request, or telemetry event.

### CAPTAIN-13

Verifies: [CAPTAIN-1](../user/playbook-captain.md#captain-1), [CAPTAIN-2](../user/playbook-captain.md#captain-2), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-9](../dev/playbook-captain.md#captain-9)

Where the test suite drives ordinary Boss text through the Playbook
Captain shell with scripted decision replies, the test suite shall
fail unless every non-command turn produces exactly one hidden
durable decision call; the executable selections are exactly
`respond`, `start`, `switch`, `dismiss`, `deliver`, and `runtime`;
`deliver` hands the original text unchanged to the active leaf and
`dismiss` executes only as a validated selection; a selection
failing shell validation — an unknown target, `start` while
engaged, `switch` to an on-path target, or a `runtime` action id the
leaf does not advertise — settles `rejected` with a reason and no
effect; a malformed decision reply gets exactly one corrective
re-ask appending the rejection reason and the restated contract; a
second malformed reply settles the turn as a Boss-appropriate
failure reply with no action executed and the stack untouched; no
hidden lifecycle classification call exists; and no decision prompt
carries session or call UUIDs, resume tokens, trace payloads, module
specifiers, option values, player rosters, journal text, or ledger
JSON.

## Lifecycle and telemetry

### CAPTAIN-14

Verifies: [CAPTAIN-3](../user/playbook-captain.md#captain-3), [CAPTAIN-4](../user/playbook-captain.md#captain-4), [CAPTAIN-6](../dev/playbook-captain.md#captain-6), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), [CAPTAIN-11](../dev/playbook-captain.md#captain-11), [CAPTAIN-16](../dev/playbook-captain.md#captain-16)

Where the test suite drives CODE under the Playbook Captain shell,
the test suite shall fail unless sub-runtime status and telemetry
are passed through in order, `playbook.fsm.state` telemetry is
mirrored through its normalized state descriptor into the shell ledger
before pass-through, shell FSM
telemetry uses `playbook.captain.fsm.state` with `from`, `to`,
`event`, and ledger fields carrying no resume-token value, the
active registry entry's quiescent
parked states park the engagement, a later same-playbook
turn resumes the same runtime instance, CODE final state disposes
the engagement only after the active turn settles, and a validated
`dismiss` disposes the engagement and returns the shell to idle;
a later dispatch after final disposal or dismissal constructs a
replacement runtime; engagement, dismissal, and final-disposal
status lines use the registered slash command in the
`◇ /<command> started`, `◇ /<command> stopped`, and
`◇ /<command> finished` vocabulary and carry no structured status
data; a validated `switch` emits the dismissed root's stopped line
before the target's started line; the session Captain emits none of
those lifecycle lines; and shell `dispose()` disposes any active
runtime and the session Captain without
emitting shell status or shell FSM telemetry for adapter teardown.
A rejected runtime initialization shall emit a recovery transition
to `chat` whose ledger has stack depth zero, leaving the session
Captain and its durable conversation live.

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
and durable session-Captain calls and sub-runtime judge calls use
the same Captain configuration and queue and never overlap.

### CAPTAIN-32

Verifies: [CAPTAIN-9](../dev/playbook-captain.md#captain-9), [CAPTAIN-31](../dev/playbook-captain.md#captain-31)

Where the shell hosts the real compiled session Captain, when Boss
turns are decided and settled, the integration suite shall fail
unless every captured decision call carries the original Boss text
unchanged in its labeled block, every session-Captain call runs
hidden on the durable conversation — resuming the pinned token and
rotating the pin from each returned one — and carries
`allowedTools: []` unless the configured captain adapter has no
provider-enforced tool-restriction surface, in which case it omits
`allowedTools` per
[DR-013 A1](../decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement)
([CAPTAIN-33](#captain-33)), every hidden adjudication envelope
preserves the runtime judge prompt verbatim, treats quoted actor
output only as evidence, forbids real or simulated tool work and
transcripts, and requires one bare JSON object, calls remain
single-flight, and an adapter that is asked for the empty allowlist
and cannot enforce it fails before an investigative agent turn can
run.

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
never an empty set, before dispatching Boss text; the session Captain
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
as an unregistered command and does not dispatch; a later
same-playbook `/<command>` reuses the existing runtime rather than
reconstructing it; and the second playbook's `/<command> <text>`
while CODE is engaged switches — CODE's stack dismissed, the second
playbook started with `<text>`, both status facts emitted in order —
rather than being refused.

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

Verifies: [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-19](../user/playbook-captain.md#captain-19), [CAPTAIN-20](../dev/playbook-captain.md#captain-20)

Where the test suite drives the Playbook Captain shell with a
registered playbook runtime, the test suite shall fail unless an
acting turn — one that executes a validated action — ends with one
hidden result-phase call on the durable conversation, made after the
action's ordered status and telemetry emissions settle, whose prompt
carries the settlement's outcome-report facts verbatim, the exact
saved counts, and the instruction to compose the closing reply only
from that outcome report; the validated closing reply is the turn's
only summary; and, when the active registry entry declares a
`summaryPolicy` and the turn's counted activity is nonzero, the
prompt carries the exact supplied saved-counts line
`Saved you X interruptions and Y copy-pastes across Z rounds of reviews/rebuttals.`
with natural singular forms when a count is one.
The suite shall fail unless a do-nothing turn — a `respond` settle,
a parse-resolved `respond`, or a rejected selection — makes no
result-phase call and the literal substring `Saved you` appears
nowhere in the turn's Boss-visible text, a rejected selection's
reason surfacing as shell-owned status text and never as captain
speech; a zero-activity acting turn and an entry
without a `summaryPolicy` likewise produce no saved-counts line.
The suite shall fail unless completed
sub-runtime player replies increment the interruption count by one
per reply; adjudicated guards named by the active registry entry's
`summaryPolicy` copy-paste guard list increment the copy-paste count
by one per handoff; guards absent from that list,
classifier/event JSON, session-Captain decision and result-phase
calls, and
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
saved-counts line exactly when the supplied counted activity is
nonzero.

## Playbook session bridge

### CAPTAIN-27

Verifies: [CAPTAIN-26](../dev/playbook-captain.md#captain-26)

Where the test suite drives the Playbook Captain shell with an injected
session-id generator and resumable fake or real host players, the test
suite shall fail unless engagement creates a new UUID, parking and
same-runtime resume retain it, final completion or dismissal followed
by re-engagement creates a different UUID, and an injected collision
rejects.
The suite shall fail unless the session Captain receives its own
UUID playbook session id at `init`, distinct from every engagement
id and stable for the whole shell session.
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
The suite shall fail unless durable session-Captain calls resume the
pinned conversation token, each returned token replaces the pin, and
an interleaved sub-runtime judge call runs fresh and never replaces
the pin, the next durable call resuming the latest pinned token.
Visible status and closing replies shall remain unchanged and shall
contain neither session ids, resume tokens, nor trace payloads.
When runtime initialization rejects, the test shall fail unless the
shell disposes the partial runtime, clears it, and a later validated
`start` constructs a
different engagement instead of reusing the failed one, with the
session Captain and its durable conversation unaffected.
The failed engagement's shell telemetry shall finish in `chat` with no frame.

## Nested playbook stack

### CAPTAIN-30

Verifies: [CAPTAIN-28](../user/playbook-captain.md#captain-28), [CAPTAIN-29](../dev/playbook-captain.md#captain-29)

Where the integration suite drives test parent and child runtimes
through the real Playbook Captain shell, the test suite shall fail
unless an immediate child completion resumes its parent in the same
Boss turn, a parked child settles that turn and receives the next Boss
turn, and child completion then pops and continues the parent without
reconstructing it, restoring the parent's player visibility.
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
external leaf determines player visibility; the session Captain holds
no frame and no `callPlaybook` reaches or leaves it; and no
model-visible response,
status, or summary exposes stack or session ids.

### CAPTAIN-33
Verifies: [CAPTAIN-31](../dev/playbook-captain.md#captain-31)

When the test suite drives the shell's control calls with a recorded
captain bridge, the test suite shall fail unless a shell built with
`captain.options.captainAdapter` naming an adapter without a
provider-enforced tool-restriction surface omits `allowedTools` from every
durable session-Captain call and hidden adjudication call while still
resuming the pinned durable conversation on session-Captain calls,
requesting fresh isolation on judge calls, and using the
hidden-control envelope, and unless a shell built
with an enforcing adapter, with no `captainAdapter`, or with an
unrecognized one requests `allowedTools: []` on those same calls.

### CAPTAIN-36
Verifies: [CAPTAIN-34](../user/playbook-captain.md#captain-34), [CAPTAIN-35](../dev/playbook-captain.md#captain-35)

Where the integration suite forces durable session-Captain calls to
fail, the suite shall fail unless each of the three unsynchronized
shapes — a throw, a non-`ok` result, and an `ok` result without a
resume token — clears the pin and re-issues only the failed call,
exactly once, on a fresh conversation whose captured prompt carries
the journal digest plus the current ControlView digest; the
engagement stack, player sessions, journal, and completed turn work
survive; and the turn otherwise settles normally with the new token
pinned.
The suite shall fail unless a second consecutive continuity failure
fails the phase with a Boss-appropriate reply that names a concrete
next step and contains no `adjudicator`, `guard`, `undeclared`, or
hidden-control wording, the stack untouched and the next Boss turn
settling normally, with the raw diagnostic preserved on trace
telemetry and the boundary error's `cause`.
The suite shall also fail unless a parentless external root's
rejected turn retains its frame as the active leaf and propagates
its boundary error unchanged.

## Conversational controller

### CAPTAIN-37

Verifies: [CAPTAIN-2](../user/playbook-captain.md#captain-2), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-8](../dev/playbook-captain.md#captain-8), [CAPTAIN-9](../dev/playbook-captain.md#captain-9), [CAPTAIN-19](../user/playbook-captain.md#captain-19), [CAPTAIN-20](../dev/playbook-captain.md#captain-20)

Where the integration suite drives the real shell with the real
compiled session Captain and the real linked CODE artifact
registered, the test suite shall fail unless the observe–act–result
loop holds:
with CODE driven to `failed` by a scripted player `error` and the
four incident Boss turns of
`acceptance-fixtures/incident-boss-turns.ts` replayed under that
fixture's provenance marking — turn 1 verbatim; turns 2–4 as
recorded, or as marked reconstructions — turn 1 —
`Retry and continue the iteration` — produces exactly one hidden
decision call on the durable conversation (the pinned resume token
in the captured options) whose captured prompt carries the exact
Boss text plus the ControlView digest — the failed leaf state,
`lastError` `{ name, message }`, and the advertised retry action id
with its label — the validated `runtime` selection is that retry id,
exactly one real `apply()` executes with an `executed` receipt, and
the result-phase prompt carries the settlement facts verbatim, while
turns 2–4 settle grounded with no dead no-action turn and no
re-execution (idempotency key honored, the player-call count fixed).
The suite shall fail unless: with a player question pending, the
Boss's answer settles as `deliver` and `BOSS_REPLY` resumes the same
state with the answer in context, the full question having surfaced
as captain speech; a mid-run status question while busy or parked is
answered from `describe()` alone — zero `apply` calls, zero FSM
events, the snapshot identical before and after; and "what went
wrong?" asked twice after a failure carries the engine's
`ControlView.lastError` in both captured decision prompts with no
`apply` and the machine untouched.
The suite shall fail unless a scripted `failed` receipt with a
normalized error yields a captured result-phase call carrying the
disposition, the error `{ name, message }`, and the settlement facts
verbatim, and the emitted closing reply is exactly the scripted
validated prose surfaced through `emitReply`.
The suite shall fail unless a pure chat turn settles in exactly one
durable call (`respond`) with no separate summary call, while an
acting turn costs two durable calls plus bounded correctives.
The suite shall fail unless (a) the real compiled DISCUSS artifact
engaged as leaf — its bespoke runtime shipping without the
`describe`/`apply` pair — is reported by the DR-022 gate as lacking
the pair, advertises no actions, and answers a status question with
`deliver` as the only verb and zero `apply` calls, and (b) a
test-only parallel machine over the shared factory engaged as leaf
and driven into its `type: 'parallel'` state answers a status
question through `describe()` with the captured digest carrying the
full multi-region state value, every active region readable, zero
`apply` calls, and the machine untouched.
The suite shall fail unless a full Boss turn through the real shell
and real CODE artifact with a scripted empty-then-text player
recovers with normal lifecycle markers and exactly one turn summary,
the recovery invisible to the Boss surface except in traces.

### CAPTAIN-38

Verifies: [CAPTAIN-2](../user/playbook-captain.md#captain-2), [CAPTAIN-3](../user/playbook-captain.md#captain-3), [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-8](../dev/playbook-captain.md#captain-8)

Where the integration suite drives validated actions through the
real shell with real registry entries, the suite shall fail unless
"clear this and start `<target>` on X" settles as one `switch` —
dismissal then start, in that order — with a receipt-grounded
closing reply naming both facts; unless a switch whose target start
is scripted to fail reports both the completed dismissal and the
failed start with no rollback pretense, the shell idle after and the
next turn starting fresh; and unless a switch whose dismissed
entry's dispose is scripted to fail settles naming the dispose
failure and whether the target started, the shell landing in the
stated recoverable state and the next Boss turn settling.
The suite shall fail unless the command table holds with no model
call parsing any command: idle `/code x` starts; `/code x` at the
leaf delivers; `/discuss x` absent from the path switches; bare
`/code` produces a reply only; a command naming an active non-leaf
ancestor produces a reply only.
The suite shall fail unless a fake runtime without the
control-surface pair advertises no actions, `deliver` is the only
verb against it, no `runtime` action is fabricated, and the DR-022
gate reports the pair as absent, distinctly.
The suite shall fail unless receipts against real `apply()` hold:
an advertised retry from `failed` settles `executed` with the run
result; the same `actionId` re-applied after the state moved on
settles `rejected` with a reason before any effect — snapshot
unchanged, zero player calls; a scripted player `error` mid-action
settles `failed` with the normalized error while its effects stay
visible in traces; and the executed leg's idempotency key repeated
returns the recorded receipt with exactly one execution in total.
The suite shall fail unless, with CODE parked in `failed`, "resume
from `<named state>`" is decided from a captured digest advertising
the jump action — its id from the resumable targets and its label
from the source state description — the selection is that action,
real `apply()` lands the snapshot at the target with an `executed`
receipt, the result-phase prompt carries the jump fact, and the
scripted closing reply names the state.

### CAPTAIN-39

Verifies: [CAPTAIN-31](../dev/playbook-captain.md#captain-31), [CAPTAIN-34](../user/playbook-captain.md#captain-34), [CAPTAIN-35](../dev/playbook-captain.md#captain-35)

Where the integration suite drives the durable conversation through
the real shell and real compiled session Captain, the suite shall
fail unless the pin rotates across durable calls (A1 then A2) while
an interleaved sub-runtime judge call stays fresh and isolated and
never replaces the pin, the next durable call resuming A2 and never
the judge call's token.
The suite shall fail unless each of the three unsynchronized shapes
— a throw, a non-`ok` result, and an `ok` result without a token —
with no executed action in flight marks the conversation
unsynchronized, re-issues only the failed call on exactly one fresh
journal-seeded conversation, and leaves the stack, player sessions,
journal, and completed work intact.
The suite shall fail unless a nonce fact stated before a forced
reseed remains usable after it: the reseed prompt carries the
journal digest and the digest-outranks-memory instruction, and the
post-reseed reply proves the nonce.
The suite shall fail unless, when `apply()` executes and the
result-phase durable call then throws, the re-issued call's journal
digest carries the executed action and outcome records — the reseed
provably knows the action ran — no second `apply()` occurs, and the
stack, journal, and completed work survive.
The suite shall fail unless a durable controller call returning
empty `ok` with no token gets exactly one corrective call, and that
corrective call is the journal-seeded reseed — never a reseed plus
another retry.

### CAPTAIN-40

Verifies: [CAPTAIN-7](../dev/playbook-captain.md#captain-7), [CAPTAIN-9](../dev/playbook-captain.md#captain-9)

Where the integration suite injects hostile content through the real
shell, the suite shall fail unless player output carrying imperative
instructions, a serialized action object, and a receipt or nonce
spoof enters the conversation only as fenced quotes, no `apply` the
Boss turn did not request executes, no spoofed receipt is honored,
and the captain reply does not obey the quoted instruction.
The suite shall fail unless a durable `ok` result with empty text
gets exactly one corrective re-ask and then the failure path — never
an empty `captain_reply` reaching the Boss surface — and unless a
reply that is valid action JSON but leaks control syntax into its
visible prose gets one corrective re-ask and then Boss-appropriate
failure text, the leaked syntax never appearing on the Boss pane.
