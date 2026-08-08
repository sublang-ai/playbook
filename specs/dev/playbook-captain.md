<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - system behavior

## Intent

This spec defines implementation requirements for the built-in
Playbook Captain shell that runs as the tmux-play Captain and hosts
registered playbook runtimes.
The shell is a meta-level Captain over playbooks; it does not
replace the CODE runtime contract in [PBRT](playbook-runtime.md).
The shell hosts the session Captain — the compiled default Captain
playbook ([CAPPLAY](captain-playbook.md)) — for the whole shell
session as a controller outside the engagement stack, and owns
host-level validation and effects: stack, registry, presentation,
and the session journal.
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
error when mirrored from telemetry, the last validated action and its
settlement status, the pinned durable-conversation resume token and
session journal handle ([CAPTAIN-35](#captain-35)), and the session
Captain's own playbook session id created at `init`
([CAPTAIN-16](#captain-16)).
The normalized last error shall carry only `{ name, message }`.
The pinned conversation token value shall appear in no model prompt,
visible status message, turn summary, or shell FSM telemetry
payload.
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
That ledger snapshot shall identify the durable conversation and
session journal by presence only and shall carry no resume-token
value.
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
shall parse registered commands first and resolve the parse
deterministically, with no model call parsing the command:

| Input | Shell state | Resolution |
| --- | --- | --- |
| `/<command> <text>`, enabled command | idle | `start` that playbook with `<text>` |
| `/<command> <text>`, command names the active leaf | engaged | `deliver` `<text>` to the leaf |
| `/<command> <text>`, enabled command absent from the active path | engaged | `switch` to that playbook with `<text>` |
| `/<command> <text>`, command names an active non-leaf ancestor | engaged | `respond` only |
| bare `/<command>`, enabled command | any | `respond` only — status or clarification, never a restart |
| unregistered `/<x>` or ordinary text | any | the session Captain's decision call |

A parse-resolved turn shall bypass only the decision model call: the
shell shall inject the parsed resolution into the session Captain's
controller FSM as that turn's decision object
([CAPPLAY-6](captain-playbook.md#capplay-6)), and validation,
execution, the outcome report, and the closing reply shall flow
through the controller loop identically to a model-decided turn; the
shell shall execute no parsed action outside that loop.
For a parse-resolved `respond`, the session Captain's one durable
prose call settles the turn as captain speech
([CAPTAIN-9](#captain-9)), and the shell shall execute no action for
that turn regardless of that call's reply.
Empty or whitespace-only input shall allocate no call, session, or
telemetry.
The shell shall submit every other non-empty Boss turn to the
session Captain for its hidden decision call, and every selection —
parse-injected or model-decided — arrives through the host-supplied
controller port ([CAPPLAY-9](captain-playbook.md#capplay-9)) as one
of `respond`, `start`, `switch`, `dismiss`, `deliver`, or `runtime`,
a model-decided `respond` carrying the turn's reply prose so a chat
turn settles in that one decision call.
The shell shall validate a selection against host state before any
effect: `start` and `switch` targets shall be enabled registry
entries; `start` and `switch` inputs shall carry an explicit
`origin` of `'boss'` or `'captain'`
([CAPPLAY-9](captain-playbook.md#capplay-9)); `start` shall require
an idle shell; `switch` shall require
an active root and a target absent from the active path; `dismiss`,
`deliver`, and `runtime` shall require an active leaf; and `runtime`
shall require the active leaf's current `describe()` to advertise
the selected action id.
An invalid selection shall settle `rejected` with a reason and no
effect; the shell shall surface that rejection reason to the Boss as
shell-owned human-readable status message text
([CAPTAIN-6](#captain-6)), never as captain speech
([CAPTAIN-9](#captain-9)).
For a validated `deliver`, the shell shall be authoritative for the
delivered text — the exact Boss text of the decided turn, or the
parsed remainder of a same-command turn — and shall ignore, never
delivering, any text carried on the selection
([CAPPLAY-9](captain-playbook.md#capplay-9)).
For a validated `start` or `switch`, the shell shall resolve the
child's initial Boss text from the selection's tagged `input`: under
`origin: 'boss'` it shall be authoritative exactly as for `deliver`,
starting the target with that same shell-held text and ignoring any
divergent text carried on the selection, so a model restatement of
the current turn can never reach the child; under
`origin: 'captain'` it shall pass the composed text through and
shall record the Captain origin in the settlement facts and the
session journal ([CAPTAIN-35](#captain-35)), keeping
Captain-composed input distinguishable from Boss text downstream.
A selection reaching the port with a missing or unknown `origin`
shall settle `rejected` with a reason and no effect — never defaulted
silently — while a decision reply whose `input` omits `origin` or
names an unknown one is a malformed required payload field for the
runtime's own contract validation and its single corrective re-ask
([CAPPLAY-18](captain-playbook.md#capplay-18)).
The shell shall execute at most one validated action per Boss turn
and settle the selection with `status`, the outcome-report facts —
what was dismissed, started, delivered, applied, or rejected, plus
the resulting leaf-state summary — the receipt where a `runtime`
action executed, and the turn's counted activity
([CAPTAIN-20](#captain-20)); settlements shall carry no prose field.
A settlement with status `ok` shall be final for that turn: the
shell shall never re-execute the executed action, and retries stay
phase-local.
`switch` shall dismiss the stack, then start the target, with no
rollback; a failing start shall settle with both facts.
A failing dispose during dismissal shall not resurrect the
engagement: the entry leaves the stack with its dispose failure
recorded as a normalized error, dismissal continues down the stack,
a `switch` still proceeds to start, the settlement names each
dispose failure and whether the target started, and the shell lands
idle or newly engaged so the next Boss turn settles normally.
The shell shall make no hidden lifecycle classification call: no
turn is routed through a deliver-or-dismiss classifier, and engaged
ordinary text shall reach the session Captain's decision unchanged.

### CAPTAIN-8

Where the Playbook Captain shell submits text to an engaged
playbook runtime, the shell shall call the active leaf runtime's
`handleBossInput` with text and the Boss-turn signal and consume its
`PlaybookRunResult`; delivery shall carry text only, and that text
shall be the shell-authoritative Boss text of
[CAPTAIN-7](#captain-7) — a `deliver` selection carries no text
payload, and any text carried on one shall be ignored and never
delivered.
Where the validated selection is a `runtime` action, the shell shall
execute it only through the active leaf's
`apply({ actionId, key, signal })` with the advertised action id and
a previously unused idempotency key, consuming its receipt
([PBRT-52](playbook-runtime.md#pbrt-52)); the shell shall fabricate
no action id and shall pass no free text into `apply`.
The shell shall not pre-classify playbook events, choose
`BOSS_INTERRUPT` targets, expose jumpable state lists through the
registry, or otherwise decide in-playbook FSM events.

## Captain calls and ports

### CAPTAIN-9

Where the Playbook Captain shell uses cligent Captain primitives,
the shell shall use one Captain agent configuration and shall
serialize durable session-Captain calls and hidden sub-runtime judge
calls through one abort-aware concurrency-one queue.
Every session-Captain call and sub-runtime judge call shall pass
`{ visibility: 'hidden' }` to `callCaptain`; no visible Captain call
shall exist.
Hidden control calls shall use a prompt envelope that identifies the
call as control work; for a session-Captain decision call the shell
shall append, inside that envelope, the exact Boss text as a labeled
block plus the two shell-composed labeled digest blocks the compiled
prompt references ([CAPPLAY-7](captain-playbook.md#capplay-7)):
the ControlView digest — the active path as commands root to leaf,
the leaf state as the description its runtime published for that state
([PBRT-52](playbook-runtime.md#pbrt-52)) together with its tags,
quiescence, and status, and never the state's internal id: the digest
is the grounding a status answer reflects, and an id is not text a
reply may repeat
([CAPPLAY-5](../user/captain-playbook.md#capplay-5)). Where the leaf's
runtime publishes no description for its current state, the digest
shall say so and shall not substitute the id for it. That absence is
also what the digest shall state while the leaf occupies a
`type: 'parallel'` state whose runtime publishes no description
covering every active region: the state line shall carry a description
per active region or none at all, and shall never carry one region's
description as the meaning of the whole state, which is the same false
statement to the model as substituting an id for a description and is
equally undetectable at the receiving end, the carrier being one string
([PBRT-52](playbook-runtime.md#pbrt-52)). The covering form is the
runtime's to publish and the digest's to relay unchanged. No runtime
with a control surface enters a parallel state today — DISCUSS declares
one and ships without the `describe`/`apply` pair, so it takes the
degraded path below, while CODE and the session Captain are scalar — so
only the absent form carries a hermetic row
([CAPTAIN-37](../test/playbook-captain.md#captain-37)). It also carries
the context members the
leaf's runtime authored into its ControlView projection
([PBRT-52](playbook-runtime.md#pbrt-52),
[DR-029 §3](../decisions/029-session-scoped-conversational-captain.md)),
pending questions verbatim with their question ids, the last error
as `{ name, message }`, and the advertised actions as id plus label,
composed from the active leaf's `describe()`
([PBRT-52](playbook-runtime.md#pbrt-52)) — and the catalog digest —
each enabled playbook's id, effective command, and intent.
Where the active leaf's runtime implements no control surface, the shell
shall compose the degraded ControlView digest rather than omit the block:
the engagement frame — the active path as commands root to leaf — plus the
facts the shell already mirrors from that leaf's telemetry
([CAPTAIN-10](#captain-10)): its normalized state descriptor stated as
publishing no description — a leaf with no control view publishes none,
and the shell shall say so rather than fall back to the state id it
holds — its pending
questions verbatim with their ids, and its last error as
`{ name, message }`, with an explicitly empty action list and no ControlView
context fields.
That digest shall state that the leaf advertises no actions, so plain text
delivery is the only machine verb against it
([PBRT-52](playbook-runtime.md#pbrt-52)) and a `runtime` selection is
invalid; capability absence shall bound the machine verbs alone and shall
never bound the conversation, `respond` staying valid for any turn
([CAPPLAY-4](../user/captain-playbook.md#capplay-4)).
Capability absence is member absence, which is how the capability is
feature-detected ([PBRT-52](playbook-runtime.md#pbrt-52)). A
`describe()` the leaf implements and that then throws is not absence,
and the shell shall not report it as such: it shall compose the same
degraded facts under a statement naming the read failure with its
normalized `{ name, message }`, shall report the advertised actions as
unknown rather than as none, and shall bound the machine verbs for
that turn on the unreadable view rather than on a capability the leaf
may well have. The conversation stays unbounded there too.
Whatever the leaf's runtime exports, the shell composes this block and
owns what it may contain: it shall render each exported context member
as its own line carrying the member name and its escaped, bounded
value, and shall never insert a runtime's context as an opaque JSON
document. A value the shell did not author — of any length, carrying
any newline — shall therefore be unable to forge a second labeled
block into the envelope or to crowd the rest of the digest out of it.
Digests and session-Captain prompts shall exclude session and call
UUIDs, resume tokens, trace payloads, module specifiers, option
values, player rosters, raw journal records, and ledger JSON; player
output shall enter the conversation only as fenced quotes.
A raw journal record shall reach no prompt, ever; the sole
journal-derived text any prompt may carry is the deterministic
reseed digest the shell composes from those records
([CAPTAIN-35](#captain-35)), permitted on exactly the first call of a
replacement conversation and on no other call, so on the healthy
path — no reseed — no journal-derived text enters any prompt
([DR-029 §2](../decisions/029-session-scoped-conversational-captain.md)).
That digest shall itself observe the exclusions above.
The shell shall validate every durable call's returned prose with
the missing-or-empty predicate and its single corrective re-ask
([DR-028](../decisions/028-empty-ok-result-re-ask.md)) and shall
surface exactly two kinds of validated prose as captain speech
through cligent `CaptainContext.emitReply`: a `respond` selection's
`text` and an acting turn's closing reply; a reply carrying control
JSON, internal control vocabulary, a live session identifier — the
session Captain's own session id or any engagement frame's — or a live
internal state identifier of the engagement stack shall not
be surfaced, and the shell shall read both identifier sets from live
shell state rather than from a fixed list, so an identifier minted or
recompiled later is covered without one.
The state-identifier duty holds only because the grounding no longer
depends on the identifier: the digest's state line supplies the
runtime's published state description
([PBRT-52](playbook-runtime.md#pbrt-52)), so nothing a status answer is
meant to reflect is an id, and an id in a visible reply is text the
model was never given. An advertised action still carries its id, which
the decision reply selects by, so the decision prompt does hand the
model that id. The shell shall therefore take no rejection duty over
advertised action ids: presence is no evidence of a leak for text the
host itself supplied, and keeping an action id out of visible prose
stays an instruction the compiled decision prompt gives the model
([CAPPLAY-16](captain-playbook.md#capplay-16)). The duty shall stay
narrow in the other direction too. The shell
shall reject only identifiers it can tell apart from ordinary English —
those carrying an internal capital, digit, underscore, dot, or hyphen —
and shall not reject a bare lowercase state id such as `ready` or
`failed`, which Boss may hear in any sentence; keeping even those out
of visible prose stays that same model instruction.
Every Boss-visible Captain reply shall leave the shell through one
presentation seam, host-authored replies included, and shall pass this
same validation there: the shell's own
[CAPTAIN-34](../user/playbook-captain.md#captain-34) failure reply
interpolates settlement facts that quote runtime-authored text no one
validated, so where the composed reply fails validation the shell shall
speak the fact-free form of it rather than withhold the turn's only
remaining settlement.
The shell's own `callCaptain` implementation is that presentation seam: the
session Captain runtime returns no prose to its machine and injects no
presentation field
([slc/link.md](../../slc/link.md#captain-adjudication)), so the prose the
shell validates is the `CaptainResult` it just produced itself.
The shell shall identify which durable call it is serving from the runtime's
paired `captain.call.started` boundary — emitted before the port invocation
and carrying the invoking `stateId` and `sourceItem`
([slc/link.md](../../slc/link.md#playbook-trace)) — or, for a model-decided
`respond`, from the selection the controller port delivers
([CAPPLAY-9](captain-playbook.md#capplay-9)); it shall not infer a call's
kind from the shape of its prose.
`emitStatus` shall never carry captain prose; the shell shall
suppress the session Captain runtime's human status stream while
forwarding its structured telemetry.
For a hidden sub-runtime judge call, the envelope shall preserve the
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
Hidden sub-runtime judge calls shall stay fresh and isolated and
shall never resume or replace the pinned durable-conversation token
([CAPTAIN-31](#captain-31)).
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
It shall mirror only what is evidence about a live leaf. Two payloads
are not: one whose state descriptor reports an actor status other than
`active` — a stopped actor is a teardown artifact, never a parked
engagement the Boss can act on — and any payload from a frame whose
disposal the shell has already begun, that disposal being under way
from before the frame's runtime is asked to dispose, since the shell
disposes a frame before it pops it
([CAPTAIN-29](#captain-29)) and a runtime's last emissions therefore
still find their frame at the top of the stack. Either payload shall
pass through to the host unchanged and shall update neither the leaf
ledger nor the authoritative shell mode, so a dropped engagement can
never re-mark an emptied stack `engaged.parked` after dismissal has
selected `chat`. This is the shell's own guard and shall not rest on
any runtime's disposal hygiene
([PBRT-6](playbook-runtime.md#pbrt-6)): it shall hold for a runtime the
shell did not author.

### CAPTAIN-31

Where the shell hosts the session Captain, every session-Captain
call — the per-turn decision call, the result-phase closing-reply
call, and a parse-resolved `respond` call — shall run hidden on the one
durable conversation: the shell shall request `resume` with the
pinned token, shall request a fresh conversation (`resume: false`)
only for the session's first call and for the
[CAPTAIN-35](#captain-35) reseed, and shall pin each returned
`resumeToken` in place of the prior pin.
The shell shall preserve the runtime prompt as the exact host prompt
and shall pass the original Boss text unchanged into the decision
call's labeled block; no model call shall replace or paraphrase Boss
text before entry.
Every such call shall keep the DR-013 A1 tool posture: request
`allowedTools: []`; where the launcher has supplied the resolved
captain adapter as `captain.options.captainAdapter` and that adapter
has no provider-enforced tool-restriction surface, omit
`allowedTools` from those calls instead of sending the empty list,
degrading that adapter's isolation to the [CAPTAIN-9](#captain-9)
hidden-control envelope per
[DR-013 A1](../decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement);
where the adapter is absent or unrecognized it shall keep requesting
the empty allowlist.
The shell shall reject the call if the configured adapter is asked
for the empty allowlist and cannot enforce it; the shared queue
shall serialize these calls.

### CAPTAIN-20

Where the Playbook Captain shell executes a validated action for a
Boss turn, the shell shall collect turn-summary counts only for the
duration of that action's execution — the sub-runtime
`handleBossInput` call, the `apply()` call, or a `switch`'s
dismissals and start — and only when the active registry entry
declares a `summaryPolicy`.
When the active registry entry declares no `summaryPolicy`, the
shell shall skip turn-summary counting for that turn.
The `summaryPolicy` maps counted state ids and adjudication guard
names to Boss-visible labels and supplies the saved-counts line
template or equivalent wording policy.
For that same duration, the shell shall aggregate sub-runtime
`playbook.fsm.state` telemetry into a summary-visible progress
phrase for the result-phase prompt, counting only state ids that the
active registry entry's `summaryPolicy` labels.
The summary-visible progress phrase shall be `none` when no
summary-visible state occurred.
The summary-visible progress round total shall be the sum of all
summary-visible state counts collected for the turn.
When the active registry entry's `summaryPolicy` provides a
state-count label for a state id, the shell shall count that state
under the provided label.
When the `summaryPolicy` does not provide a state-count label for a
state id, the shell shall not count that state in the result-phase
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
The shell shall not count session-Captain decision, reply, or
result-phase calls, sub-runtime classifier/event JSON, or malformed
adjudication replies as saved copy-pastes.
After the executed action settles, the session Captain's one
result-phase closing-reply call
([CAPPLAY-6](captain-playbook.md#capplay-6)) runs hidden on the
durable conversation ([CAPTAIN-31](#captain-31)); the shell shall
not make that call itself, and shall supply, inside that call's
[CAPTAIN-9](#captain-9) envelope, the settlement's outcome-report
facts verbatim, the exact saved interruption and copy-paste counts,
and the aggregate summary-visible progress phrase and round total,
and shall instruct Captain to compose the closing reply required by
[CAPTAIN-19](../user/playbook-captain.md#captain-19) only from that
outcome report.
While the turn's counted activity — the saved interruptions plus
saved copy-pastes plus the summary-visible round total — is nonzero,
the result-phase prompt shall instruct Captain to append the active
entry's `summaryPolicy` saved-counts line verbatim with the supplied
counts and natural singular forms when a count is one; when that
counted activity is zero or the entry declares no `summaryPolicy`,
it shall instruct Captain to append no saved-counts line.
When the Boss turn executes no action, the shell shall supply no
result-phase outcome report and no result-phase call shall occur
([CAPPLAY-6](captain-playbook.md#capplay-6)).
The result-phase prompt shall instruct Captain not to include counts
for state ids the `summaryPolicy` does not label and not to repeat
the exact summary-visible progress round count outside the
saved-counts line.
The result-phase prompt shall not include shell ledger JSON or raw
state ids for states that are not counted in the summary-visible
progress phrase.

## Lifecycle

### CAPTAIN-11

Where the Playbook Captain shell has an active leaf runtime, when its
normalized state is quiescent and tagged `playbook.parked` or its run
result is suspended, the shell shall park the root engagement in
`engaged.parked`.
Where the active root runtime returns terminal or a validated
`dismiss` or `switch` dismisses the root, the shell shall dispose the
complete stack and return to its idle `chat` mode — for a `switch`,
idle only until the same turn's start phase engages the target
([CAPTAIN-7](#captain-7)); where a child
returns terminal or is dismissed, the shell shall return it to its
parent per [CAPTAIN-29](#captain-29).
The shell shall defer terminal disposal until the active runtime call
settles.
Where the Boss submits text while a leaf is parked, the shell shall
reuse that exact leaf runtime rather than constructing a replacement.
Where the Playbook Captain shell has no active stack, when a
validated `start` — parse-injected or model-decided
([CAPTAIN-7](#captain-7)) — selects an enabled external playbook, the
shell shall
construct a new root runtime from that registry entry's
`createRuntime` function and the validated options captured during
`init`, generate a previously unissued UUID playbook session id, and
initialize the runtime with that id, its playbook id, and the
wrapped ports; ordinary idle text shall construct no runtime by
itself.
The session Captain shall never be constructed as an engagement: its
runtime exists from `init` ([CAPTAIN-16](#captain-16)), holds no
stack frame, and `callPlaybook` shall not be reachable from it.
Where the Playbook Captain shell has disposed an active root stack
because it reached its final state or was dismissed, when a later
validated `start` engages the same playbook id, the shell shall
construct a replacement sub-runtime.

## Adapter lifecycle

### CAPTAIN-16

Where tmux-play calls the Playbook Captain shell adapter's
`init(session)`, the shell shall store the session, load the enabled
playbook registry entries from `captain.options.playbooks`, derive
each entry's local-role-to-host-player binding
([CAPTAIN-10](#captain-10)) from its generated host player ids,
validate each entry's own option slice through that entry's
`validateOptions`, enter `chat`, open the session journal
([CAPTAIN-35](#captain-35)), and construct, initialize, and start
the session Captain runtime — the compiled default Captain
([CAPPLAY-6](captain-playbook.md#capplay-6)) — with its own
generated playbook session id ([CAPTAIN-26](#captain-26)) and the
controller port, while constructing no working-playbook sub-runtime.
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
each final trace can drain, dispose the session Captain last, clear
the active turn context, emit no shell status or shell FSM telemetry
for the adapter teardown itself, and resolve only after every
runtime's `dispose()` call returns. The shell's later
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
At `init` the shell shall likewise generate the session Captain's own
previously unissued UUID playbook session id
([CAPTAIN-16](#captain-16)); that identity shall serve the whole
shell session and shall never be reissued to an engagement.
The shell shall include root and leaf session ids in its bounded ledger
and shell FSM telemetry, keep the pinned durable-conversation token
and journal handle in the ledger under the [CAPTAIN-5](#captain-5)
exclusion rule, pass sub-runtime
`playbook.trace` telemetry through unchanged, forward every explicit
player `resume` selection to cligent's `context.callPlayer`, and
return the authoritative host `resumeToken` unchanged.
The shell shall put neither resume tokens nor trace payloads in model
prompts, visible status messages, or turn summaries.
If engagement initialization rejects, the shell shall clear the broken
engagement, best-effort dispose its partially initialized runtime while
preserving the original failure, and let a later validated `start`
construct a new engagement with a new session id; the session Captain,
its durable conversation, and the journal shall be unaffected.
Its recovery shell telemetry shall show `chat` and an empty stack rather
than leaving observers at the earlier attempted engagement.

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
The session Captain shall hold no frame on this stack and its
wrapped ports shall expose no reachable `callPlaybook`; the stack
holds only working playbooks.
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
shell shall dispose and pop it, restore the parent's player
visibility, and call the parent's `resumePlaybookCall` with the same call id
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
session-Captain prompts, shell-owned prompts, status, and closing
replies shall contain neither the
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
The playerless session Captain shall make no visibility request;
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

## Durable conversation and failure recovery

### CAPTAIN-35

Where the shell hosts the session Captain, the shell shall keep one
host-side session journal per shell session: append-only, JSON-safe
records
`{ seq, turnId, kind: 'boss' | 'reply' | 'action' | 'outcome', payload }`
covering Boss text, every Boss-visible Captain reply, validated actions
with their targets, and settlement facts.
A `reply` record shall cover every reply the Boss saw, whoever composed
it — validated model prose and the host's own
[CAPTAIN-34](../user/playbook-captain.md#captain-34) failure reply
alike — because the reseed exists to keep the replacement conversation
in step with the Boss transcript, not to record provenance: a reply the
Boss saw and the journal did not hold leaves the replacement Captain
reading the Boss's next message against a turn it was never told about.
The shell shall therefore surface Boss-visible Captain prose through
one presentation seam that writes the record and marks the turn
together ([CAPTAIN-9](#captain-9)), rather than journaling at each
call site.
The journal shall never be Boss-visible, shall feed only the
conversation reseed, and shall be complete for the session lifetime:
the shell shall drop no record, and the only bounding shall be a
deterministic truncation applied where the shell quotes long player or
sub-runtime output into a payload.
Boss text, Boss-visible captain replies, validated actions, and the
shell-composed settlement facts surrounding such a quote are
host-authored, and the reseed digest shall render them whole: a long
Boss requirement shall reach the replacement conversation complete,
never abbreviated by a per-record bound the renderer applies without
knowing whose text it is.
Every recorded action shall be followed by a record of how that action
ended, including where the executed effect throws before reporting; no
action record shall stand in the journal without its outcome record,
so a reseeded conversation is never shown a dispatched action whose
result it is not told.
After every durable session-Captain call the shell shall pin the
returned `resumeToken`, replacing the prior pin.
When a durable call throws, returns a non-`ok` status, or returns
`ok` without a token, the shell shall treat the conversation as
unsynchronized: clear the pin, re-issue that call exactly once on a
fresh conversation (`resume: false`) seeded with the reseed digest
plus the current ControlView digest, and pin the new token.
The conversation shall stay unsynchronized until some call returns a
token, so where the re-issue also fails, the next durable call of the
session — on that turn or any later one — shall itself be a seeded
one, running `resume: false` and carrying the reseed digest.
Apart from the session's first call, no durable call shall run both
unpinned and unseeded.
The reseed shall be the re-issued call's single corrective for the
fault it answers — an unusable *result*
([DR-028 §26](../decisions/028-empty-ok-result-re-ask.md)): where the
reseeded result is itself empty or its prose unusable, the shell shall
fail that phase and shall issue no further corrective call for it,
neither the boundary's empty-`ok` re-ask nor its own prose re-ask,
those being the two correctives that answer the same symptom the reseed
already answered.
It shall not spend the corrective of a different fault class. A
decision reply that arrives whole and is malformed as control JSON is a
content fault the runtime owns, and it shall keep its own single
corrective re-ask
([CAPPLAY-18](captain-playbook.md#capplay-18),
[DR-029 §4](../decisions/029-session-scoped-conversational-captain.md))
even on a turn whose transport already spent a reseed — the corrective
prompt is the only thing that tells the model why its reply was
rejected, and a transport fault is no evidence about reply quality.
A decision phase therefore costs at most one original call plus one
corrective per fault class raised, each class bounded to one and none
of them recursive; no item caps the per-turn total across classes.
The reseed digest shall be the shell's own deterministic rendering of
the journal records — the same records shall always render the same
digest — and shall be the only journal-derived text any prompt ever
carries: raw journal records shall enter no prompt, the digest shall
appear on the seeded call that opens a replacement conversation and on
no later call of that conversation — so a pinned conversation carries
no journal-derived text at all — and it shall observe the
[CAPTAIN-9](#captain-9) prompt exclusions, carrying no session or
call UUID, resume token, trace payload, module specifier, option
value, player roster, or ledger JSON
([DR-029 §2](../decisions/029-session-scoped-conversational-captain.md)).
Only the model-side conversation shall be replaced: the engagement
stack, player sessions, journal, and the turn's completed work —
including an already-executed action, which shall never be
re-executed — shall survive.
When the re-issued call fails again, the shell shall fail that phase
without touching the stack, surfacing the
[CAPTAIN-34](../user/playbook-captain.md#captain-34) failure reply;
the underlying diagnostic shall remain available on trace telemetry
and as the boundary error's `cause` and shall appear in no
Boss-visible chat or status text.
Where a parentless external root's delivered turn rejects, the shell
shall retain the frame for later Boss recovery and shall propagate
the boundary error unchanged.
