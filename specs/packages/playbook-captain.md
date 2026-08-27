<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook-captain: Playbook Captain Shell

## Intent

This package specifies the Playbook Captain shell's Boss-visible behavior, registry and engagement-stack host contract, durable session-Captain control, and integration verification.

## External Behavior

### Selection and chat

#### playbook-captain-1

Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while no playbook is engaged, when the
Boss submits `/<command> <text>` for an enabled playbook's command
(such as `/code`), the shell shall start that playbook and submit
`<text>` to its runtime as ordinary Boss text, with no model call
parsing the command.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, when the Boss submits a bare `/<command>`
for an enabled playbook, the shell shall answer in visible captain
speech with that playbook's status or a clarification and shall
neither start nor restart it.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while no playbook is engaged, when the
Boss submits ordinary text, an unregistered slash-prefixed command,
or a near-miss command-like input, the shell shall settle the turn
through the session Captain's decision
([[captain-playbook-1](captain-playbook.md#captain-playbook-1)]): a conversational turn
settles as one visible captain reply with no engagement and no
lifecycle status line, and a task intent starts an enabled playbook
through the validated `start` action, with the specialized work
never performed by the Captain itself.
Empty or whitespace-only input shall produce no model call, no
session, no status line, and no telemetry event.

#### playbook-captain-2

Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while a playbook is engaged, when the Boss
submits `/<command> <text>` for the active leaf playbook's command
(such as `/code` while CODE is the active leaf), the shell shall
submit `<text>` to the existing leaf runtime and shall not reset,
dispose, or reconstruct it.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while a playbook is engaged, when the Boss
submits `/<command> <text>` for an enabled playbook absent from the
active engagement path, the shell shall switch: dismiss the current
engagement stack, then start that playbook with `<text>`, reporting
both facts through the [[playbook-captain-3](#playbook-captain-3)] status lines and the
closing reply.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while a playbook is engaged, when the Boss
submits `/<command> <text>` naming an active non-leaf ancestor, the
shell shall answer in visible captain speech and shall not dispatch,
restart, or reorder the stack.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while a playbook is engaged, when the Boss
submits ordinary text, the shell shall settle the turn through the
session Captain's decision over the closed action set, guided by the
message's addressee and intent
([[captain-playbook-4](captain-playbook.md#captain-playbook-4)]): task-directed content
— an instruction, answer, or continuation for the working playbook —
is delivered as the original text unchanged to the active leaf
runtime; conversation, planning, or clarification addressed to the
Captain — a progress or status question included — settles as one
visible captain reply grounded in the observed runtime state, with
no state movement and the parked leaf and any pending acting-agent
question untouched, however many times such a question is asked; an
explicit stop request dismisses; an explicit replacement request
switches; and an explicit recovery or resume request may execute one
runtime-advertised action
([[playbook-captain-8](playbook-captain.md#playbook-captain-8)]).
While an acting-agent question is pending on the active leaf, when the Boss
answers, the shell shall deliver the answer to that same leaf, which
shall resume its suspended state with the answer in context.

### Engagement progress

#### playbook-captain-3

Where the Playbook Captain shell is running under tmux-play, while
a playbook is engaged, when the engaged runtime emits status or
telemetry, the shell shall pass those emissions through to the host
in order.
Where the Playbook Captain shell is running under tmux-play, when
the shell engages, dismisses, or disposes an enabled external root playbook,
the shell shall emit Boss-visible Captain status lines
`◇ /<command> started` when it engages the playbook,
`◇ /<command> stopped` when the engagement is dismissed, and
`◇ /<command> finished` when it disposes the playbook after final
completion, using the registered slash command such as `/code`
rather than the internal playbook id, without changing or reusing
the engaged runtime's glyph vocabulary.
When a validated `switch` replaces the engagement, the shell shall
emit the dismissed root's `◇ /<command> stopped` line before the
target's `◇ /<command> started` line; when the target's start then
fails, the stopped line shall still appear and the failed start
shall be reported in the closing reply rather than by a started
line.
The session Captain is never an engagement and shall emit none of
these lifecycle lines.
Those shell-owned status lines shall be complete human-readable
messages and shall not attach structured status data that the host
could render as raw JSON.
Adapter teardown through [[playbook-captain-16](playbook-captain.md#playbook-captain-16)]
is not a Boss-facing engagement disposal and need not emit a
Boss-visible status line.

#### playbook-captain-4

Where the Playbook Captain shell is running under tmux-play, while a
playbook is engaged, when the active leaf's descriptor is quiescent and
tagged `playbook.parked` or its run result is suspended, the shell shall
keep that engagement available for the next Boss turn.
Where the Playbook Captain shell is running under tmux-play, while a
root playbook is engaged, when the root run result is terminal or a
validated `dismiss` or `switch` dismisses the root engagement, the
shell shall dispose that engagement and return to its idle state;
for a validated `switch`, that idle state lasts only until the same
turn starts the target playbook ([[playbook-captain-2](#playbook-captain-2)]).
Nested child completion and dismissal shall instead follow
[[playbook-captain-28](#playbook-captain-28)].

#### playbook-captain-19

Where the Playbook Captain shell settles a Boss turn with a
non-`respond` selection, including a rejected, failed, or partly
completed selection, the shell shall make one attempt to present a
captain closing reply after the action's ordered status and telemetry
emissions, and that reply shall be the turn summary.
When presentation accepts, exactly one closing reply shall be visible.
When presentation rejects, the shell shall surface the boundary failure
without retrying the reply through another channel or repeating the
action.
This single-attempt rule applies to every captain reply, including a
`respond` reply and a recovery failure reply.
The closing reply shall use a natural chat-like tone and clear
formatting while remaining brief.
It shall state only what was done or what changed, composed from the
turn's reported outcome — the settlement facts — and shall claim no
work the outcome report does not contain.
When the closing reply mentions progress detail, it shall use only
aggregate counts whose labels the active playbook registry entry
declares summary-visible.
For CODE, those counts are review/rebuttal round counts, for
example:
`2 review rounds, 1 rebuttal`.
The closing reply shall not include counts for plan or
implementation steps, tests-green state ids, other internal states,
raw state names, transitions, guard names, prompts, tools, hidden
calls, or reasoning.
Where the engaged playbook's registry entry declares a summary
policy, while the turn's counted activity — the saved interruptions,
saved copy-pastes, and summary-visible rounds counted per
[[playbook-captain-20](playbook-captain.md#playbook-captain-20)] — is nonzero,
the closing reply shall then append one saved-counts line whose
wording the engaged playbook's registry entry supplies through its
summary policy; for CODE that line has the format:
`Saved you X interruptions and Y copy-pastes across Z rounds of reviews/rebuttals.`
The saved-counts line shall use natural singular forms when a count
is one.
In that line, `X`, `Y`, and `Z` are decimal counts for that turn.
Interruptions are player replies that Boss did not have to relay,
copy-pastes are inter-player handoffs — including reviews,
rebuttals, revisions, approvals, and passes — that Boss did not
have to transfer manually, and review/rebuttal rounds are the
counted review-round and rebuttal occurrences for that turn.
When the turn's counted activity is zero, when the active registry
entry declares no summary policy, or when the Boss turn settles as
`respond`, the saved-counts line shall not appear, so text
beginning `Saved you` never follows a turn that saved nothing.

### Active-playbook visibility

#### playbook-captain-25

Where the Playbook Captain shell is running under tmux-play with two
or more playbooks enabled, when the shell engages, resumes, or routes
a Boss turn to an enabled external playbook with one or more bound roles, the shell shall make that playbook's panes
the visible ones in the main tmux window and not the panes of the
other enabled playbooks.
The session Captain shall make no visibility request and may leave
the last external playbook's panes visible.
After the engaged playbook reaches its final state or the Boss
dismisses it, the shell may leave the visible panes on the last
selected playbook until the next selection.

### Nested playbooks

#### playbook-captain-28

Where an engaged playbook calls another enabled playbook, when the
child begins, the Playbook Captain shell shall make the child the active
playbook for Boss input and player-pane visibility while preserving the
parent for automatic return.
The shell shall emit `◇ /<child> called by /<parent>` when it enters
the child and `◇ /<child> returned to /<parent>` when the child
finishes and its result resumes the parent.
Where a child is parked for Boss input, the next Boss turn shall reach
that same child session; where the Boss dismisses a child, the shell
shall emit `◇ /<child> stopped; returning to /<parent>`, abort the
child call, and resume the parent rather than discard the root
engagement.
Where the Boss dismisses the root engagement, the shell shall stop the
complete nested stack.
The session Captain never calls a playbook and never appears as a
parent in these lines.
The shell shall not expose playbook session ids, call ids, child output,
or stack ledger data in those status lines.

### Failure recovery

#### playbook-captain-34

Where a session-Captain call loses conversation continuity, the shell
shall recover through [[playbook-captain-35](playbook-captain.md#playbook-captain-35)]
without replacing the engagement stack, player sessions, completed
turn work, or remembered Boss transcript.
The recovered conversation shall know the failed turn and every action
outcome already established before the failure.
No recovery or reply failure shall cause an action to run again.

When a selected action is rejected, fails, or completes only in part,
the shell shall return that result to the session Captain and attempt
one natural closing reply grounded in all facts the result establishes.
An accepted presentation shall make exactly that reply visible; a
rejected presentation shall surface its boundary failure and shall not
be retried.
A rejection shall not end through a separate shell-status or deferred
memory path.
A follow-up such as “why?” or “do it anyway” shall therefore continue
from the remembered result without requiring the Boss to restate it.

When the Captain cannot produce the normal reply after bounded
recovery, the shell shall attempt one Boss-appropriate failure reply
that states only established facts, preserves the engagement, and
names a safe next step.
If that presentation rejects, the shell shall surface the boundary
failure without another presentation attempt.
It shall not claim that nothing changed or invite a retry when work may
already have completed, and shall expose no internal control data
([[playbook-captain-9](playbook-captain.md#playbook-captain-9)]).

### Registry and shell state

#### playbook-captain-5

Where the package exposes the Playbook Captain shell as a tmux-play
Captain, the shell shall own a registry of playbook entries.
Each entry shall be a manifest carrying `id` (stable playbook id and
default options-namespace key), `command` (default slash command
without `/`, overridable by config), `intent` (routing description
for the compiled Captain catalog), required integer `artifactSchema` (the linked runtime profile schema under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]), `requiredRoleIds` (local role ids the
runtime may pass to `callPlayer`), `concurrentRoleSets` (ordered arrays of at least two pairwise-distinct `requiredRoleIds` members whose calls may overlap), an optional `summaryPolicy`
([[playbook-captain-20](#playbook-captain-20)]), a `validateOptions` function for that
entry's own option slice, and a `createRuntime` factory for the
linked runtime.
The CODE entry shall declare `id` and command `code` with artifact schema `2`, required role `coder`, and no concurrent role set; REVIEW shall declare `review` with schema `2`, roles `coder` and `reviewer`, and no concurrent role set; and DECIDE shall declare `decide` with schema `2`, roles `coder` and `reviewer`, and exact concurrent role sets `[['coder', 'reviewer']]`.
The shell shall reject a missing or unsupported advertisement or a shared-factory entry whose advertised artifact schema differs from its factory `spec.compat.artifactSchema` under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)] before runtime construction; a bespoke runtime profile shall advertise the schema it implements directly.
The shell shall take each playbook's artifact schema, required roles, concurrent role sets, summary policy,
option validator, and runtime factory
from its manifest entry.
The shell shall take each enabled playbook's option slice and exact role-to-player map from its normalized `captain.options.playbooks.<id>` config ([[playbook-captain-16](#playbook-captain-16)]), require artifact schema `2` under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)], require the role keys to equal that entry's `requiredRoleIds`, validate the options against that entry, and retain the bindings under [[playbook-captain-10](#playbook-captain-10)].
The shell shall use run-result outcomes and normalized descriptor tags
for lifecycle and shall not hardcode CODE state ids or CODE-specific
summary labels.
The shell shall support one active root engagement with the nested LIFO
frames permitted by [[playbook-captain-29](#playbook-captain-29)] and shall keep only a
bounded control ledger: root and leaf playbook/session ids, bounded
frame path and depth, shell mode, latest leaf runtime state descriptor,
pending Boss questions when mirrored from telemetry, normalized last
error when mirrored from telemetry, the last validated action and its
settlement status, the pinned durable-conversation resume token and
recovery-history handle ([[playbook-captain-35](#playbook-captain-35)]), and the session
Captain's own playbook session id created at `init`
([[playbook-captain-16](#playbook-captain-16)]).
The normalized last error shall carry only `{ name, message }`.
The pinned conversation token value shall appear in no model prompt,
visible status message, turn summary, or shell FSM telemetry
payload.
The shell shall not duplicate the full Boss conversation in its
ledger.

#### playbook-captain-6

Where the Playbook Captain shell handles Boss turns, the shell FSM
shall model durable modes `chat`, `engaged.driving`, and
`engaged.parked`.
When the shell emits its own FSM telemetry, it shall use topic
`playbook.captain.fsm.state`, not `playbook.fsm.state`.
The shell FSM telemetry payload shall carry `from`, `to`, `event`,
and a snapshot of the bounded control ledger.
That ledger snapshot shall identify the durable conversation and
recovery history by presence only and shall carry no resume-token
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

### Routing

#### playbook-captain-7

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
([[captain-playbook-6](captain-playbook.md#captain-playbook-6)]), and validation,
execution, the outcome report, and the closing reply shall flow
through the controller loop identically to a model-decided turn; the
shell shall execute no parsed action outside that loop.
For a parse-resolved `respond`, the session Captain's one durable
prose call settles the turn as captain speech
([[playbook-captain-9](#playbook-captain-9)]), and the shell shall execute no action for
that turn regardless of that call's reply.
Empty or whitespace-only input shall allocate no call, session, or
telemetry.
The shell shall submit every other non-empty Boss turn to the
session Captain for its hidden decision call, and every selection —
parse-injected or model-decided — arrives through the host-supplied
controller port ([[captain-playbook-9](captain-playbook.md#captain-playbook-9)]) as one
of `respond`, `start`, `switch`, `dismiss`, `deliver`, or `runtime`,
a model-decided `respond` carrying the turn's reply prose so a chat
turn settles in that one decision call.
The shell shall validate a selection against host state before any
effect: `start` and `switch` targets shall be enabled registry
entries; `start` and `switch` inputs shall be nonempty standalone
request strings ([[captain-playbook-9](captain-playbook.md#captain-playbook-9)]); `start` shall require
an idle shell; `switch` shall require
an active root and a target absent from the active path; `dismiss`,
`deliver`, and `runtime` shall require an active leaf; and `runtime`
shall require the active leaf's current `describe()` to advertise
the selected action id.
An invalid selection shall settle `rejected` with a reason and no
effect; that result shall return through the same result-phase Captain
call and closing-reply path as every other non-`respond` selection.
The shell shall create no separate refusal status or deferred refusal
notice.
For a validated `deliver`, the shell shall be authoritative for the
delivered text — the exact Boss text of the decided turn, or the
parsed remainder of a same-command turn — and shall ignore, never
delivering, any text carried on the selection
([[captain-playbook-9](captain-playbook.md#captain-playbook-9)]).
For a validated `start` or `switch`, the shell shall pass the scalar
`input` unchanged as the child's initial request.
The deterministic command path supplies its parsed remainder, while a
model-decided path may supply the complete request agreed across the
remembered conversation; the recovery history retains the original
Boss turns and the handed-off request ([[playbook-captain-35](#playbook-captain-35)]).
A missing, empty, or non-string `input` shall settle `rejected` with a
reason and no effect at the controller port, and shall be a malformed
required payload field for decision validation and its corrective
re-ask ([[captain-playbook-18](captain-playbook.md#captain-playbook-18)]).
The shell shall execute at most one validated action per Boss turn and settle
the selection with `status`, outcome-report facts, an optional rejection
reason, the receipt where a `runtime` action executed, and the resulting
`leafStateSummary` ([[playbook-captain-20](#playbook-captain-20)]); settlements shall carry no
reply-prose or counted-activity field.
The shell shall keep counted activity in its turn report and supply it
separately to the result-phase prompt under [[playbook-captain-20](#playbook-captain-20)].
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

#### playbook-captain-8

Where the Playbook Captain shell submits text to an engaged
playbook runtime, the shell shall call the active leaf runtime's
`handleBossInput` with text and the Boss-turn signal and consume its
`PlaybookRunResult`; delivery shall carry text only, and that text
shall be the shell-authoritative Boss text of
[[playbook-captain-7](#playbook-captain-7)] — a `deliver` selection carries no text
payload, and any text carried on one shall be ignored and never
delivered.
Where the validated selection is a `runtime` action, the shell shall
execute it only through the active leaf's
`apply({ actionId, key, signal })` with the advertised action id and
a previously unused idempotency key, consuming its receipt
([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)]); the shell shall fabricate
no action id and shall pass no free text into `apply`.
The shell shall not pre-classify playbook events, choose
`BOSS_INTERRUPT` targets, expose jumpable state lists through the
registry, or otherwise decide in-playbook FSM events.

### Captain calls and ports

#### playbook-captain-9

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
prompt references ([[captain-playbook-7](captain-playbook.md#captain-playbook-7)]):
the ControlView digest — the active path as commands root to leaf,
the leaf state as the description its runtime published for that state
([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)]) together with its tags,
quiescence, and status, and never the state's internal id: the digest
is the grounding a status answer reflects, and an id is not text a
reply may repeat
([[captain-playbook-5](captain-playbook.md#captain-playbook-5)]). Where the leaf's
runtime publishes no description for its current state, the digest
shall say so and shall not substitute the id for it. It also carries the
context members the
leaf's runtime authored into its ControlView projection
([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)]),
pending questions verbatim with their question ids, the last error
as `{ name, message }`, and the advertised actions as id plus label,
composed from the active leaf's `describe()`
([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)]) — and the catalog digest —
each enabled playbook's id, effective command, and intent.
Where the active leaf's runtime implements no control surface, the shell
shall compose the degraded ControlView digest rather than omit the block:
the engagement frame — the active path as commands root to leaf — plus the
facts the shell already mirrors from that leaf's telemetry
([[playbook-captain-10](#playbook-captain-10)]): its normalized state descriptor stated as
publishing no description — a leaf with no control view publishes none,
and the shell shall say so rather than fall back to the state id it
holds — its pending
questions verbatim with their ids, and its last error as
`{ name, message }`, with an explicitly empty action list and no ControlView
context fields.
That digest shall state that the leaf advertises no actions, so plain text
delivery is the only machine verb against it
([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)]) and a `runtime` selection is
invalid; capability absence shall bound the machine verbs alone and shall
never bound the conversation, `respond` staying valid for any turn
([[captain-playbook-4](captain-playbook.md#captain-playbook-4)]).
Capability absence is member absence, which is how the capability is
feature-detected ([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)]). A
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
That property is owed by every foreign value the shell composes into a
digest line and not by the context members alone: an advertised action's
id and label are the runtime's strings and an enabled playbook's id,
command, and intent are the registry's, and a newline in any of them
opens a labeled block the model reads as host-authored. The shell shall
therefore escape and bound at the one seam through which a value it did
not author becomes part of a digest line, so a line added to a digest
later carries the property without restating it.
Digests and session-Captain prompts shall exclude session and call
UUIDs, resume tokens, trace payloads, module specifiers, option
values, player rosters, raw recovery records, and ledger JSON; player
output shall enter the conversation only as fenced quotes.
A raw recovery record shall reach no prompt, ever; the sole
history-derived text any prompt may carry is the deterministic
reseed digest the shell composes from those records
([[playbook-captain-35](#playbook-captain-35)]), permitted on exactly the first call of a
replacement conversation and on no other call, so on the healthy
path — no reseed — no history-derived text enters any prompt
([DR-029](../decisions/029-session-scoped-conversational-captain.md)).
That digest shall itself observe the exclusions above.
The shell shall validate every durable call's returned prose with
the missing-or-empty predicate and its single corrective re-ask
([DR-028](../decisions/028-empty-ok-result-re-ask.md)) and shall
surface exactly two kinds of validated prose as captain speech
through cligent `CaptainContext.emitReply`: a `respond` selection's
`text` and an acting turn's closing reply; a reply carrying control
JSON, internal control vocabulary, a live session identifier — the
session Captain's own session id or any engagement frame's — a live
internal state identifier of the engagement stack, or a machine-shaped
identifier the shell itself placed in one of this turn's prompts shall
not be surfaced, and the shell shall read all three identifier sets
from live shell state and from its own record of what it composed this
turn rather than from a fixed list, so an identifier minted or
recompiled later is covered without one.
The state-identifier duty holds only because the grounding no longer
depends on the identifier: the digest's state line supplies the
runtime's published state description
([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)]), so nothing a status answer is
meant to reflect is an id, and an id in a visible reply is text the
model was never given. An advertised action still carries its id, which
the decision reply selects by, so the decision prompt does hand the
model that id, as it hands it each pending question's id. That the host
supplied a string is evidence it is not confidential; it is no evidence
that it is Boss-appropriate, which is the property
[[captain-playbook-5](captain-playbook.md#captain-playbook-5)] and
[[playbook-captain-34](playbook-captain.md#playbook-captain-34)] regulate — the
same shell that composes the outcome report replaces an action id with
its advertised label there precisely because the id is control data.
The supplied set shall therefore be rejectable: the exact advertised
action ids and pending-question ids this turn's prompts carried, plus the
fragment each id carries after its `<verb>:` prefix, that grammar being
one [[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)] publishes and the fragment
being what a reply actually repeats. A `jump:<stateId>` id names a
state the machine is by construction not in, so no live-state check can
reach it.
Boss-facing action labels, question text, player names, catalog prose,
and recovery facts shall not enter that set merely because their text
resembles an identifier.
Membership shall follow the prompt and not the composing call site.
Whichever block placed the id — a read control view's advertised
actions, the mirrored pending questions of a degraded digest, or the
reseed digest replaying an action the session took turns ago — the id
was supplied this turn and is in the set; registration named at each
composing site instead leaves whichever site nobody named outside a duty
the others are inside. Text the *Boss* supplied is outside it either
way: repeating the Boss's own words is not repeating an identifier the
shell supplied.
A reply repeats a supplied identifier when it carries that identifier as
a token of its own, not merely as a substring: a supplied `5` occurs
inside `1.5.2` and refusing that reply would refuse it for text it did
not repeat. The duty shall carry no minimum identifier length — the
criterion is the character class below and nothing else, and a runtime's
`q1` or `5` is exactly the id a length rule would silently excuse.
This takes no interpretation the shell is not allowed: it is a
string-identity test over the shell's own supply, exactly the form the
live-session-id check already takes, and the shell still need not know
what any id means. Keeping an action id out of visible prose stays a
compiled-prompt instruction as well
([[captain-playbook-16](captain-playbook.md#captain-playbook-16)]); the host check is what
makes it verifiable. The duty shall stay narrow in the other direction
too. The shell
shall reject only identifiers it can tell apart from ordinary English —
those carrying an internal capital, digit, underscore, dot, hyphen, or
the colon of the `<verb>:<target>` action grammar
([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)]) —
and shall not reject a bare lowercase state id such as `ready` or
`failed`, which Boss may hear in any sentence; keeping even those out
of visible prose stays that same model instruction.
Every Captain reply shall leave the shell through one presentation
seam and pass this same validation there, including a normal result
reply, a rejection reply, and a recovery failure reply
([[playbook-captain-34](playbook-captain.md#playbook-captain-34)]).
The seam shall attempt each reply once; a rejection shall surface as a
boundary failure and shall not be retried through another channel.
Where foreign result text prevents a safe factual reply, the Captain
shall state the established outcome and next step without quoting that
text rather than print it unchecked.
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
([[captain-playbook-9](captain-playbook.md#captain-playbook-9)]); it shall not infer a call's
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

#### playbook-captain-10

Where the Playbook Captain shell constructs a sub-runtime, the
shell shall wrap that runtime's `PlaybookPorts` and shall apply the
active frame's effective local-role-to-host-player binding.
The frame shall resolve each local role only through its persisted explicit map, with no same-name, ancestor, or generated fallback ([DR-032](../decisions/032-explicit-roles-session-players.md)).
Before each call, the shell shall combine the current normalized player instruction and permissions with that binding's complete model and effort selections, require the player's adapter to equal any established ledger adapter, and call `context.callPlayer(playerId, prompt, { resume, settings: { model, effort, instruction?, permissions? } })` with those complete tmux-play host settings and the selected token.
The host shall interpret a value selection literally and a provider-default selection as an explicit reset rather than omission; inability to enforce either selection on the resumed conversation shall reject the call.
The wrapper shall route a sub-runtime `callPlayer(localRole, …, { resume })` to `context.callPlayer(<effectiveHostPlayerId>, …)`, return the host result's `resumeToken`, and reject a setting or provider-continuation failure without clearing the prior token or retrying fresh.
The shell shall track one delegated-call transaction by resolved player id across the logical session and reject a simultaneous second call to the same id rather than fork or serialize its continuation.
A token-changing result shall remain logically in flight after the host promise resolves until the owning runtime synchronously validates it and `PlayerSessionStore.update` atomically publishes the exact returned transition ([[playbook-runtime-55](playbook-runtime.md#playbook-runtime-55)], [[playbook-runtime-58](playbook-runtime.md#playbook-runtime-58)]); no other frame, role, or unsourced store call may publish, clear, cancel, or reuse that lane meanwhile.
A resolved result that is malformed, arrives after its runtime operation, or is not committed by that exact update shall quarantine the player lane for the rest of the logical session, block later calls on its uncertain prior token, and make snapshot capture unsafe; a rejected call that produced no result shall preserve and release the prior token after the provider promise settles.
The wrapper shall route sub-runtime
`callCaptain(prompt, signal, options)` through the shared Captain queue to
`context.callCaptain(prompt, options)`, preserving the required `visibility`
and `resume` selections and whether optional `allowedTools` was supplied or
omitted, and return Playbook's Captain status,
final text, and error without player or resume-token fields, route
sub-runtime `callJudge` through that same queue to hidden
`context.callCaptain`, route `callPlaybook` through the stack protocol
in [[playbook-captain-29](#playbook-captain-29)], and pass sub-runtime
`emitStatus` and `emitTelemetry` calls through to the host in order.
Hidden sub-runtime judge calls shall stay fresh and isolated and
shall never resume or replace the pinned durable-conversation token
([[playbook-captain-31](#playbook-captain-31)]).
The shell shall derive each local role's current prompt identity from that binding's concrete model value or, for a provider-default selection, from the established player's adapter, and shall initialize the created runtime with `PlaybookSession.roleBindings` carrying exactly that prompt identity and the resolved player id, so compiled prompts and traces distinguish semantic role from conversation owner without persisting host identity in FSM options or context ([[playbook-runtime-15](playbook-runtime.md#playbook-runtime-15)]).
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
([[playbook-captain-29](#playbook-captain-29)]) and a runtime's last emissions therefore
still find their frame at the top of the stack. Either payload shall
pass through to the host unchanged and shall update neither the leaf
ledger nor the authoritative shell mode, so a dropped engagement can
never re-mark an emptied stack `engaged.parked` after dismissal has
selected `chat`. This is the shell's own guard and shall not rest on
any runtime's disposal hygiene
([[playbook-runtime-6](playbook-runtime.md#playbook-runtime-6)]): it shall hold for a runtime the
shell did not author.

#### playbook-captain-31

Where the shell hosts the session Captain, every session-Captain call — the per-turn decision call, the result-phase closing-reply call, and a parse-resolved `respond` call — shall run hidden on the one durable conversation: the shell shall request `resume` with the pinned token, shall request a fresh conversation (`resume: false`) for the session's first call and for the [[playbook-captain-35](#playbook-captain-35)] reseed, shall use the retained token or `false` selected by that item's typed settings-preflight catch-up, and shall pin each returned `resumeToken` in place of the prior state.
Once the Captain conversation is established, ordinary reopen shall require its configured adapter, instruction, and permissions to remain unchanged, pass `{ resume, settings: { model, effort, instruction?, permissions? } }` with the complete effective settings on the next `context.callCaptain`, and preserve the prior pin without a fresh fallback when the provider rejects those settings.
The shell shall preserve the runtime prompt as the exact host prompt
and shall pass the original Boss text unchanged into the decision
call's labeled block; no model call shall replace or paraphrase Boss
text before entry.
Every such call shall keep the DR-013 A1 tool posture: request
`allowedTools: []`; where the authoritative session Captain's adapter
has no provider-enforced tool-restriction surface, omit
`allowedTools` from those calls instead of sending the empty list,
degrading that adapter's isolation to the [[playbook-captain-9](#playbook-captain-9)]
hidden-control envelope per
[DR-013](../decisions/013-routing-only-captain-control.md) A1;
where the adapter is unrecognized it shall keep requesting
the empty allowlist.
The shell shall reject the call if the configured adapter is asked
for the empty allowlist and cannot enforce it; the shared queue
shall serialize these calls.

#### playbook-captain-20

Where the Playbook Captain shell settles a non-`respond` selection for
a Boss turn, the shell shall collect turn-summary counts only for the
duration of any action execution — the sub-runtime
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
phrase for the result-phase prompt, including descendant frames but counting each state only under the registry entry of the frame that emitted it.
The summary-visible progress phrase shall be `none` when no
summary-visible state occurred.
The summary-visible progress round total shall be the sum of all
summary-visible state counts collected for the turn.
When the emitting frame's `summaryPolicy` provides a state-count label for a state id, the shell shall count that state
under the provided label.
When that frame's `summaryPolicy` does not provide a state-count label for a
state id, the shell shall not count that state in the result-phase
prompt and shall not derive a fallback label from the state id.
When a wrapped sub-runtime `callPlayer` call returns a player
reply, the shell shall count one saved interruption for that reply.
When a wrapped hidden sub-runtime adjudication call returns a guard
whose name appears in that frame registry entry's `summaryPolicy`
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
After the selection settles, including where it is rejected, fails, or
partly completes, the session Captain's one
result-phase closing-reply call
([[captain-playbook-6](captain-playbook.md#captain-playbook-6)]) runs hidden on the
durable conversation ([[playbook-captain-31](#playbook-captain-31)]); the shell shall
not make that call itself, and shall supply, inside that call's
[[playbook-captain-9](#playbook-captain-9)] envelope, the settlement's outcome-report
facts verbatim, the exact saved interruption and copy-paste counts,
and the aggregate summary-visible progress phrase and round total,
and shall instruct Captain to compose the closing reply required by
[[playbook-captain-19](playbook-captain.md#playbook-captain-19)] only from that
outcome report.
While the turn's counted activity — the saved interruptions plus
saved copy-pastes plus the summary-visible round total — is nonzero,
the result-phase prompt shall instruct Captain to append the active
entry's `summaryPolicy` saved-counts line verbatim with the supplied
counts and natural singular forms when a count is one; when that
counted activity is zero or the entry declares no `summaryPolicy`,
it shall instruct Captain to append no saved-counts line.
When the Boss turn settles as `respond`, the shell shall supply no
result-phase outcome report and no result-phase call shall occur
([[captain-playbook-6](captain-playbook.md#captain-playbook-6)]).
The result-phase prompt shall instruct Captain not to include counts
for state ids the `summaryPolicy` does not label and not to repeat
the exact summary-visible progress round count outside the
saved-counts line.
The result-phase prompt shall include no shell ledger JSON and shall
not render the current or resulting runtime state by raw state id;
state meaning shall come from the runtime-published description and
the `summaryPolicy` labels above.
Before disposing a terminal root, the shell shall append exactly one settlement fact stating that the root command completed and carrying the escaped, bounded Boss-facing `stateDescription` from its terminal result under [[playbook-runtime-41](playbook-runtime.md#playbook-runtime-41)]; when an older runtime omits that optional field, the shell shall fall back to the still-live control view and then to an honest no-description statement, never to a state id or opaque `PlaybookRunResult.output`; this central fact shall apply whether completion follows start, delivery, a runtime action, or a nested return and shall survive in the durable outcome journal.

### Lifecycle

#### playbook-captain-11

Where the Playbook Captain shell has an active leaf runtime, when its
normalized state is quiescent and tagged `playbook.parked` or its run
result is suspended, the shell shall park the root engagement in
`engaged.parked`.
Where the active root runtime returns terminal or a validated
`dismiss` or `switch` dismisses the root, the shell shall dispose the
complete stack and return to its idle `chat` mode — for a `switch`,
idle only until the same turn's start phase engages the target
([[playbook-captain-7](#playbook-captain-7)]); where a child
returns terminal or is dismissed, the shell shall return it to its
parent per [[playbook-captain-29](#playbook-captain-29)].
The shell shall defer terminal disposal until the active runtime call
settles.
Where the Boss submits text while a leaf is parked, the shell shall
reuse that exact leaf runtime rather than constructing a replacement.
Where the Playbook Captain shell has no active stack, when a
validated `start` — parse-injected or model-decided
([[playbook-captain-7](#playbook-captain-7)]) — selects an enabled external playbook, the
shell shall
construct a new root runtime from that registry entry's
`createRuntime` function and the validated options captured during
`init`, generate a previously unissued UUID playbook session id, and
initialize the runtime with that id, its playbook id, and the
wrapped ports; ordinary idle text shall construct no runtime by
itself.
The session Captain shall never be constructed as an engagement: its
runtime exists from `init` ([[playbook-captain-16](#playbook-captain-16)]), holds no
stack frame, and `callPlaybook` shall not be reachable from it.
Where the Playbook Captain shell has disposed an active root stack
because it reached its final state or was dismissed, when a later
validated `start` engages the same playbook id, the shell shall
construct a replacement sub-runtime.

### Adapter lifecycle

#### playbook-captain-16

Where tmux-play calls the Playbook Captain shell adapter's
`init(session)`, the shell shall store the session, load the enabled
playbook registry entries from `captain.options.playbooks`, derive
each entry's local-role-to-host-player binding
([[playbook-captain-10](#playbook-captain-10)]) from its normalized explicit role map,
validate each entry's own option slice through that entry's
`validateOptions`, enter `chat`, open the session recovery history
([[playbook-captain-35](#playbook-captain-35)]), and construct, initialize, and start
the session Captain runtime — the compiled default Captain
([[captain-playbook-6](captain-playbook.md#captain-playbook-6)]) — with its own
generated playbook session id ([[playbook-captain-26](#playbook-captain-26)]) and the
controller port, while constructing no working-playbook sub-runtime.
The shell shall require `captain.options.playbooks` and shall reject
`init` when it is missing or empty; it shall not infer a CODE-only
default from `captain.options.code`.
Each `captain.options.playbooks.<id>` entry in the normalized shell config shall carry a `from` module specifier, an optional `command` override, exact `roles: Readonly<Record<roleId, { playerId: string; model: TuningSelection; effort: TuningSelection }>>`, and an `options` slice, where `TuningSelection` has the exact shape defined by [[playbook-cli-8](playbook-cli.md#playbook-cli-8)].
The shell shall require `captain.options.sessionAgents` from [[playbook-cli-8](playbook-cli.md#playbook-cli-8)] to be exactly `{ captain: SessionAgent; players: Readonly<Record<playerId, SessionAgent>> }`, with each `SessionAgent` carrying the top-level defaults `{ adapter: string; model: TuningSelection; effort: TuningSelection; instruction?: string; permissions?: PermissionPolicy }` under that same normalized contract, and shall reject a referenced player absent from that exact map or any unreferenced entry.
The shell shall consume those exact blocks and bindings without deriving a binding from names, and every call shall pass both normalized selections even when either requests the provider default.
For each enabled playbook the shell shall import the module named by
`from` and read its default export as the registry entry, treating a
module whose default export is not a manifest entry carrying the
[[playbook-captain-5](#playbook-captain-5)] fields as exposing no valid registry entry.
The `captain.options.playbooks` map key is the playbook `<id>` the
shell binds with ([[playbook-captain-10](#playbook-captain-10)]) and shall equal that
module's manifest `id`.
The shell shall compute each playbook's effective command as the
entry's config `command` when present and the manifest's default
`command` otherwise.
The shell shall reject `init` when `from` is missing, the import
fails, the module exposes no valid registry entry, a map key differs
from its module's manifest `id`, two enabled playbooks share an `id`,
two enabled playbooks resolve to the same effective command, or an enabled
playbook's id or effective command is the reserved internal name `captain`, or the manifest omits artifact schema `2`.
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

### Playbook session bridge

#### playbook-captain-26

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
([[playbook-captain-16](#playbook-captain-16)]); that identity shall serve the whole
shell session and shall never be reissued to an engagement.
The shell shall include root and leaf session ids in its bounded ledger
and shell FSM telemetry, keep the pinned durable-conversation token
and recovery-history handle in the ledger under the [[playbook-captain-5](#playbook-captain-5)]
exclusion rule, pass sub-runtime
`playbook.trace` telemetry through unchanged, forward every explicit
player `resume` selection to cligent's `context.callPlayer`, and
return the authoritative host `resumeToken` unchanged.
The logical Captain session shall own one player ledger keyed by explicit player id, initialized for every referenced player with immutable adapter, instruction, and permissions plus an optional resume token, and the shell shall initialize every frame runtime with a `PlayerSessionStore` view that resolves local roles through that common ledger per [[playbook-runtime-55](playbook-runtime.md#playbook-runtime-55)] and [[playbook-runtime-58](playbook-runtime.md#playbook-runtime-58)].
Child return, frame disposal, root completion or dismissal, return to chat, later root engagement, process hand-off, and front-end changes shall retain that ledger; only final disposal of the logical Captain session may end its in-memory ownership after durable hand-off.
The shell shall put neither resume tokens nor trace payloads in model
prompts, visible status messages, or turn summaries.
If engagement initialization rejects, the shell shall clear the broken
engagement, best-effort dispose its partially initialized runtime while
preserving the original failure, and let a later validated `start`
construct a new engagement with a new session id; the session Captain,
its durable conversation, and the recovery history shall be unaffected.
Its recovery shell telemetry shall show `chat` and an empty stack rather
than leaving observers at the earlier attempted engagement.

### Nested playbook stack

#### playbook-captain-29

Where the active runtime calls `PlaybookPorts.callPlaybook`, when the
target id names an enabled registry entry and does not form an
active-path cycle, the shell shall construct and initialize a distinct child
runtime, push it above its caller, switch visibility to the child's
players, and submit the call input as the child's initial Boss text.
The child shall retain its own runtime, `PlaybookSession` identity, and explicit role bindings while sharing continuation with another frame only where both maps name the same player id under [[playbook-captain-10](#playbook-captain-10)] and [[playbook-captain-26](#playbook-captain-26)].
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

### Active-playbook Visibility Contract

#### playbook-captain-22

Where the Playbook Captain shell runs under tmux-play with one or more
playbooks enabled, when the shell selects, resumes, routes a Boss turn to,
pushes, or returns to an enabled external leaf with one or more bound roles, the shell shall request tmux-play
visibility for that leaf playbook's explicitly bound player ids through
`setVisiblePlayers` before dispatching Boss text to the playbook
runtime.
The requested visible set shall be the external leaf's distinct effective
host player ids and shall never be empty.
When the selected external leaf is roleless, the shell shall make no visibility request and may leave the prior pane selection unchanged.
The playerless session Captain shall make no visibility request;
when an external child is active, that child's non-empty explicit set
shall apply.
Because the launcher has already validated those bound player
ids against the composed tmux-play roster, a `setVisiblePlayers`
validation rejection shall be treated as an internal shell or
composition error rather than a Boss input error.
A tmux pane reconciliation failure reported by tmux-play shall be
treated as display-only and shall not block dispatch to the playbook
runtime.
After a playbook reaches final completion or is dismissed, the
visible panes may remain on the last selected playbook until the
next selection.

### Public module surface

#### playbook-captain-17

Where `@sublang/playbook` exposes the Playbook Captain shell for
tmux-play, the package shall expose the public module specifier
`@sublang/playbook/playbook-captain`.
That module's default export shall be a tmux-play Captain factory
for the Playbook Captain shell, which loads its enabled playbooks
from `captain.options.playbooks` at `init`
([[playbook-captain-16](#playbook-captain-16)]) rather than hardcoding any playbook.

### Durable conversation and failure recovery

#### playbook-captain-35

Where the shell hosts the session Captain, it shall keep one complete,
chronological recovery history for the shell session.
That history shall preserve every accepted Boss turn, every Captain reply
attempted for presentation together with its delivery result, every submitted
selection, and every established action result, including rejection, failure,
and partial completion.
Boss-authored requests and shell-authored result facts shall be retained
whole; quoted foreign evidence may be bounded before it enters the
history.

Every non-`respond` action result shall reach the healthy durable
conversation through the result-phase call of the same turn
([[playbook-captain-20](#playbook-captain-20)]).
There shall be no separate refusal notice, status-only refusal path, or
second memory channel.
The recovery history shall never be Boss-visible and shall be used to
restore a replacement conversation, not as an additional prompt on a
healthy one.
After every durable session-Captain call the shell shall pin the
returned `resumeToken`, replacing the prior pin.
When a durable call throws for a reason other than a typed complete-settings preflight rejection, returns a non-`ok` status, or returns `ok` without a token, the shell shall treat the conversation as unsynchronized and re-issue only that failed call once on a fresh conversation seeded from the complete recovery history and current runtime observation.
When the exact Captain host call instead rejects with the typed complete-settings preflight error before provider work, the shell shall make no same-turn fresh fallback, retain the selected token or `false`, and record the latest journal sequence already represented to that conversation.
The next supported durable call shall use that retained resume selection and one deterministic authoritative suffix containing only later journal records; repeated preflight rejections shall retain the same safe watermark so missed turns accumulate, while a successful call shall pin its new token and clear the catch-up obligation.
An abort shall take precedence even when its reason carries the typed marker and shall propagate the exact signal reason.
An abort before Captain host-call admission shall preserve an existing catch-up obligation, while an abort after that boundary shall require full reseeding because provider advancement is uncertain.
A player-call settings rejection shall never force fresh Captain continuity: when normal Captain reporting succeeds it shall advance continuity normally, and when that exact rejection reaches the shell fallback the shell shall retain the prior Captain resume target and mark only the missed journal suffix for catch-up.
When reply presentation rejects, the shell shall make no second presentation attempt and shall treat the conversation that produced that reply as unsynchronized; the next session-Captain call shall start fresh with recovery history containing the exact attempted reply and its uncertain delivery.
The conversation shall remain unsynchronized until a call establishes
new continuity, so a later turn is seeded when the immediate recovery
also fails.
Continuity recovery, empty-result correction
([DR-028](../decisions/028-empty-ok-result-re-ask.md)), and malformed
decision correction ([[captain-playbook-18](captain-playbook.md#captain-playbook-18)])
shall each remain bounded to the fault they answer and shall never
repeat an action or recurse indefinitely.
The replacement conversation shall receive a deterministic rendering
of the complete recovery history that observes the prompt exclusions
of [[playbook-captain-9](#playbook-captain-9)].
Only the model-side conversation shall be replaced: the engagement
stack, player sessions, recovery history, and completed turn work shall
survive, and an action whose outcome is already established shall never
be re-executed.
When a selected action's turn fails, its outcome-report facts shall say
the action may have changed the session only when that same error
escaped the effect invocation itself. A failure outside that invocation
shall make no such claim, and every completed sub-step shall remain an
explicit established fact.
When recovery also fails, the shell shall preserve that state for the
next turn and attempt the truthful failure reply required by
[[playbook-captain-34](playbook-captain.md#playbook-captain-34)], while retaining
the underlying diagnostic outside Boss-visible prose.

### Complete shell snapshots

#### playbook-captain-41

Where `@sublang/playbook/playbook-captain` exposes the Playbook Captain shell, the module shall export `PlaybookCaptainShellSnapshot`, `assertPlaybookCaptainShellSnapshot(value: unknown): PlaybookCaptainShellSnapshot`, `PlaybookCaptainFrameSnapshot`, `PlaybookCaptainRetainedGeneration`, `PlaybookCaptainRetentionUpdate`, `PlaybookCaptainSettlement`, and `PlaybookCaptainShell`, with `PlaybookCaptainShell` extending tmux-play's `Captain` by exactly `exportSnapshot(): PlaybookCaptainShellSnapshot | undefined`, `exportSettlement(): PlaybookCaptainSettlement | undefined`, and `restore(session: CaptainSession, snapshot: PlaybookCaptainShellSnapshot): Promise<void>`.
The module's default shell factory shall return `PlaybookCaptainShell`.
`PlaybookCaptainShellSnapshot` shall be a detached JSON-safe schema-version-3 value with these exact common and mode-discriminated members:

| Part | Exact content |
| --- | --- |
| Common | `schemaVersion: 3`; `captain: { sessionId: UUID, runtime: PlaybookRuntimeSnapshot, agent: { adapter, instruction?, permissions? }, conversation }`; `playerSessions: Readonly<Record<playerId, { adapter, instruction?, permissions?, resumeToken? }>>`; `issuedSessionIds: readonly UUID[]`; nonnegative-integer `sequences: { turn, journal }`; `journal: readonly JournalRecord[]`; optional `lastAction: 'respond' \| 'start' \| 'switch' \| 'dismiss' \| 'deliver' \| 'runtime'`; optional `lastSettlementStatus: 'ok' \| 'rejected' \| 'failed'` |
| Captain conversation | Exactly `{ kind: 'unopened' }`, `{ kind: 'pinned', token: nonempty string }`, `{ kind: 'needsCatchUp', resume: nonempty string \| false, afterJournalSeq: nonnegative integer }`, or `{ kind: 'needsSeeding' }` |
| Journal record | `{ seq, turnId, kind, payload }`, where `kind` is `boss`, `reply`, `handoff`, `action`, or `outcome`, and `payload` is JSON-safe |
| `mode: 'chat'` | No frame, pending-question, last-error, or separately derived control-ledger member |
| `mode: 'engaged.parked'` | Nonempty ordered `frames`; optional JSON-safe `pendingBossQuestions` whose entries use the runtime snapshot's discriminated Captain-or-role asker; optional `lastError: { name: string, message: string }`; and no separately derived control-ledger member |
| Frame | Exactly `playbookId: string`, `sessionId: UUID`, `rootSessionId: UUID`, nonnegative-integer `depth`, optional `parentSessionId: UUID`, optional nonempty `parentCallId: string`, JSON-safe `options`, exact `roleBindings: Readonly<Record<roleId, playerId>>`, and `runtime: PlaybookRuntimeSnapshot` |

The Captain and frame `runtime` members shall be complete `PlaybookRuntimeSnapshot` values exported under [[playbook-runtime-45](playbook-runtime.md#playbook-runtime-45)].
`issuedSessionIds` shall contain every UUID the logical shell session has issued, including the Captain identity, live frame identities, and identities of removed frames, so restoration cannot make a historical identity reusable ([[playbook-captain-26](#playbook-captain-26)]).
`sequences` and the full ordered journal shall preserve the shell's turn and recovery-history ownership: an empty journal shall coincide exactly with turn zero; each contiguous turn from one through the saved turn sequence shall begin with exactly one `boss` record before any other record for that turn; journal record sequence numbers shall be contiguous from one; and the journal sequence shall equal the record count ([[playbook-captain-35](#playbook-captain-35)]).
Empty history shall coincide exactly with an unopened Captain conversation.
For `needsCatchUp`, the watermark shall precede the current journal sequence, `resume: false` shall coincide exactly with watermark zero, and a retained token shall require a positive watermark.
The Captain agent envelope shall preserve its established adapter, instruction, and permissions, and the Captain conversation shall preserve its exact unopened, pinned, catch-up-required, or reseed-required state ([[playbook-captain-35](#playbook-captain-35)]).
The Captain runtime snapshot's turn sequence shall equal the shell snapshot's turn sequence.
The common player ledger shall preserve every referenced player id and its fixed agent envelope in chat and engaged modes, and every frame runtime's local-role token view shall equal the projection of that ledger through its exact saved bindings; two roles bound to one player shall project the same optional token ([[playbook-captain-26](#playbook-captain-26)]).
For each adjacent parent and child frame, the child's `parentSessionId` shall equal the parent's `sessionId`, the child's `parentCallId` shall equal the parent runtime's suspended `callId`, and that descriptor's `playbookId` and `childSessionId` shall equal the child's `playbookId` and `sessionId`; the root shall have no parent fields, every child shall use the root's `rootSessionId` at the next depth, and the leaf shall have no suspended child ([[playbook-captain-29](#playbook-captain-29)]).
When `exportSnapshot()` is called after initialization and between Boss turns, while the shell is in `chat` or `engaged.parked`, no child is opening, no turn-summary or controller-call transient remains, the Captain queue, host calls, emission drains, and frame removals are idle, disposal has not begun, and every included runtime exports a safe snapshot, the shell shall return that complete snapshot without moving state or emitting any record.
At any other point, or when an identity, token projection, frame edge, nested-call descriptor, or runtime safe point is inconsistent, `exportSnapshot()` shall return `undefined` without changing the shell.
`assertPlaybookCaptainShellSnapshot` shall be a pure boundary that performs all intrinsic closed-schema, JSON, conversation, journal, Captain-runtime contribution, identity, frame-topology, suspended-edge, role-question, player-token projection, and leaf-projection validation without reading configuration, importing modules, or constructing runtimes; it shall return a detached recursively frozen snapshot.

#### playbook-captain-42

Where a fresh unused Playbook Captain shell was constructed from the authoritative stored catalog and the compatible current settings projection already checked against the durable session record under [[playbook-cli-23](playbook-cli.md#playbook-cli-23)], when `restore(session, snapshot)` receives a `PlaybookCaptainShellSnapshot`, the shell shall first apply [[playbook-captain-41](#playbook-captain-41)]'s pure intrinsic validator before reading configuration, importing a module, or constructing a runtime.
Validation shall reject cycles, accessors, symbol or unknown keys, non-plain instances, sparse or undefined values, non-finite numbers, a schema or mode mismatch, malformed Captain envelope, conversation, player ledger, or journal data, an empty history whose conversation is not unopened, an absent, duplicate, out-of-order, or out-of-range turn owner in the journal, a journal-counter mismatch, a Captain-runtime/shell turn-sequence mismatch, malformed or duplicate UUIDs, a Captain identity reused by a live frame, another duplicate live identity, a live identity absent from `issuedSessionIds`, a Captain contribution inconsistent with [[captain-playbook-21](captain-playbook.md#captain-playbook-21)], a current Captain or referenced-player adapter, instruction, or permissions different from its saved envelope, an active frame whose current manifest, options, required-role set, or role-to-player map differs from its saved structure, a runtime/playbook mismatch, an invalid frame chain, a parent/child suspended-call mismatch, a non-leaf runtime without its matching suspended call, a leaf that is suspended or is not active, quiescent, and tagged `playbook.parked`, or a live frame's local token view different from the saved ledger projection.
Only current-config compatibility — enabled catalog membership, fixed Captain and player envelopes, frame options, and exact role maps — shall remain restore-owned; current model and effort selections may differ and shall govern the next call without changing the snapshot.
After validation, the shell shall rebuild the same compiled Captain, catalog, and controller, reconstruct working frames from root to leaf under their saved options, bindings, session, root, parent-call, and depth identities, and give every frame a view of the one restored Captain-session player ledger ([[playbook-captain-26](#playbook-captain-26)], [[playbook-captain-29](#playbook-captain-29)]).
The shell shall keep every host-facing emission and call gate closed while it restores the Captain runtime and each working runtime through [[playbook-runtime-45](playbook-runtime.md#playbook-runtime-45)], and shall verify before commit that no restore-time host emission or call was attempted, every restored normalized runtime state equals its snapshot, and every local and session-ledger token view remains exact.
`PlayerSessionStore.restore` shall mutate the common ledger only for the exact frame while the shell awaits that frame's runtime restore ([[playbook-runtime-55](playbook-runtime.md#playbook-runtime-55)], [[playbook-runtime-58](playbook-runtime.md#playbook-runtime-58)]); the same call during initialization, a Boss turn, resume, apply, or disposal shall reject before mutation.
Only after every validation, reconstruction, restore, and verification succeeds shall the shell install the saved mode, conversation, recovery journal, counters, issued identities, last action, and last settlement status and open the host gate as a final non-failing commit.
Successful restore shall emit no session start, transition, status, telemetry, reply, player-visibility, model-call, nested-call-start, or nested-call-finish record; allocate no replacement identity; and leave the next Boss turn to continue the same chat or active leaf through the ordinary routing and settlement paths.
Where a nested stack was restored, the eventual leaf result shall return through the saved edges and resume each parent exactly once without starting any child again, while roles sharing an explicit player id shall continue through that ledger entry.
Each restored child frame shall carry no synthesized process-crossing invocation signal or abort listener; only its saved call edge shall identify the later parent resume, and teardown before a child result shall dispose the stack without resuming that caller.
When validation or any pre-commit reconstruction, restore, emission-gate, state, or token check fails, the shell shall keep the host gate closed, attempt to dispose every partially restored working runtime from leaf to root and the Captain runtime last, aggregate any cleanup rejection, discard every partial reference, and reject, with no host record, model or player call, controller submission, child abort, or false nested-call finish escaping.
When that cleanup succeeds, the shell shall remain fresh for a later `init` or `restore`; when cleanup rejects, the shell shall remain closed and reject later initialization or restoration rather than claim safe reuse.
`restore` shall reject reuse after successful `init` or `restore` and shall reject once disposal has begun.

### Retained generation settlement

#### playbook-captain-44

After a nonempty Boss turn settles at the same safe boundary where the complete shell snapshot can be exported ([[playbook-captain-41](#playbook-captain-41)]), `exportSettlement()` shall return one detached JSON-safe `PlaybookCaptainSettlement` containing that snapshot and zero or more unique per-root `PlaybookCaptainRetentionUpdate` values; before a turn, during work, after unsafe settlement, or after disposal it shall return `undefined`.
`PlaybookCaptainRetainedGeneration` shall contain the exact nonempty root-to-leaf `PlaybookCaptainFrameSnapshot` stack from [[playbook-captain-41](#playbook-captain-41)], including each nested call bridge and active quiescent schema-3 runtime snapshot exported under [[playbook-runtime-45](playbook-runtime.md#playbook-runtime-45)], and shall never contain a final runtime snapshot.
A frame shall participate only when its runtime exposes the `retainedGenerationMetadata` capability marker from [[playbook-runtime-34](playbook-runtime.md#playbook-runtime-34)]; a capability-less root shall emit `clear`, while a capability-bearing root with a capability-less descendant shall retain the last complete candidate captured before that descendant opened; when the turn began with that descendant already live or the root began during the turn, the shell shall emit no update for that root; and the shell shall never retain a partial stack.
Before controller work can dismiss or complete an existing root, the shell shall capture the latest eligible generation from a live root that has previously settled active and quiescent, without moving a runtime or emitting a host record.
Outside the capability-gating exceptions above and subject to the capture-safety rule below, when the root remains parked, the shell shall emit `retain` with its current complete generation; when dismissal removes the root, it shall emit `retain` with the captured generation; and when a terminal result removes the root, it shall emit `retain` with the captured generation exactly when the terminal state's stable id belongs to the root runtime's immutable `unfinishedFinalStateIds` ([[playbook-runtime-34](playbook-runtime.md#playbook-runtime-34)]), otherwise `clear`.
An initialized root that has not yet reached a post-input quiescent settlement shall not count as carrying unfinished work; if it reaches a declared unfinished terminal first, the shell shall settle without a retention update for that root rather than retain its initial state or emit `clear`.
Whenever the preceding rules require a capability-bearing frame to supply a complete candidate, failure to capture it shall fail the settlement boundary; a runtime claiming the marker but unable to supply a stable terminal state id shall likewise fail rather than classify the terminal as clean.
Child return or dismissal shall produce no independent retained root: the resulting live root stack, or the eventual root terminal decision, shall remain authoritative.

## Verification

### Routing Coverage

#### playbook-captain-12


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
status, visibility request, or telemetry event (verifying [[playbook-captain-1](#playbook-captain-1)], [[playbook-captain-2](#playbook-captain-2)], [[playbook-captain-7](#playbook-captain-7)], [[playbook-captain-8](#playbook-captain-8)]).

#### playbook-captain-13


Where the test suite drives ordinary Boss text through the Playbook
Captain shell with scripted decision replies, the test suite shall
fail unless every non-command turn produces exactly one hidden
durable decision call; the executable selections are exactly
`respond`, `start`, `switch`, `dismiss`, `deliver`, and `runtime`;
`deliver` hands the shell-supplied original Boss text unchanged to
the active leaf — a scripted `deliver` selection carrying a
divergent text payload still delivers the exact Boss text, the
carried text ignored — and
`dismiss` executes only as a validated selection; a selection
failing shell validation — an unknown target, `start` while
engaged, `switch` to an on-path target, or a `runtime` action id the
leaf does not advertise — settles `rejected` with a reason and no
effect, then returns through the result-phase Captain call and closing
reply with no separate refusal status; a malformed decision reply gets exactly one corrective
re-ask appending the rejection reason and the restated contract; a
second malformed reply settles the turn as a Boss-appropriate
failure reply with no action executed and the stack untouched; no
hidden lifecycle classification call exists; and no decision prompt
carries session or call UUIDs, resume tokens, trace payloads, module
specifiers, option values, player rosters, ledger JSON, or any
history-derived text — neither a raw recovery record nor the reseed
digest, since no call on this unbroken path is a reseed
([[playbook-captain-35](playbook-captain.md#playbook-captain-35)]).
The suite shall also fail unless every `start` or `switch` selection
carries one nonempty scalar input: a parse-resolved selection carries
its command remainder unchanged, a model-decided selection after
several planning turns may carry the complete agreed request, and a
missing, empty, or non-string input is rejected before any effect (verifying [[playbook-captain-1](#playbook-captain-1)], [[playbook-captain-2](#playbook-captain-2)], [[playbook-captain-7](#playbook-captain-7)], [[playbook-captain-9](#playbook-captain-9)]).

### Lifecycle and telemetry

#### playbook-captain-14


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
Captain and its durable conversation live (verifying [[playbook-captain-3](#playbook-captain-3)], [[playbook-captain-4](#playbook-captain-4)], [[playbook-captain-6](#playbook-captain-6)], [[playbook-captain-10](#playbook-captain-10)], [[playbook-captain-11](#playbook-captain-11)], [[playbook-captain-16](#playbook-captain-16)]).

### Registry and options

#### playbook-captain-15


Where the test suite initializes the shell with the real CODE, REVIEW, and DECIDE registries, it shall fail unless every registry declares artifact schema `2`, a missing, other, or shared-factory-disagreeing schema rejects before runtime construction, CODE declares role `coder`, REVIEW and DECIDE declare `coder` and `reviewer`, CODE and REVIEW declare no concurrent role set, DECIDE declares exactly `[['coder', 'reviewer']]`, malformed concurrent sets reject, each normalized role map covers the exact required set, each current empty option schema is validated without constructing a runtime, each runtime init receives exact role bindings whose prompt identities use the concrete model value or the established adapter for `provider-default`, and each later player call reaches only its explicitly bound player id (verifying [[playbook-captain-5](#playbook-captain-5)], [[playbook-captain-10](#playbook-captain-10)], and [[playbook-captain-16](#playbook-captain-16)]).
The suite shall reject an absent `sessionAgents` projection, a referenced player missing from it, or an extra unreferenced player before runtime construction (verifying [[playbook-captain-16](#playbook-captain-16)]).
The suite shall also fail unless runtime Captain and judge calls preserve their visibility, resume, and optional tool-isolation selections through the shared single-flight Captain queue (verifying [[playbook-captain-9](#playbook-captain-9)] and [[playbook-captain-10](#playbook-captain-10)]).

#### playbook-captain-32


Where the shell hosts the real compiled session Captain, when Boss
turns are decided and settled, the integration suite shall fail
unless every captured decision call carries the original Boss text
unchanged in its labeled block, every session-Captain call runs
hidden on the durable conversation — resuming the pinned token and
rotating the pin from each returned one — and carries
`allowedTools: []` unless the configured captain adapter has no
provider-enforced tool-restriction surface, in which case it omits
`allowedTools` per
[DR-013](../decisions/013-routing-only-captain-control.md) A1
([[playbook-captain-33](#playbook-captain-33)]), every hidden adjudication envelope
preserves the runtime judge prompt verbatim, treats quoted actor
output only as evidence, forbids real or simulated tool work and
transcripts, and requires one bare JSON object, calls remain
single-flight, and an adapter that is asked for the empty allowlist
and cannot enforce it fails before an investigative agent turn can
run (verifying [[playbook-captain-9](#playbook-captain-9)], [[playbook-captain-31](#playbook-captain-31)]).

### Registry loading and visibility

#### playbook-captain-23


Where the test suite initializes the Playbook Captain shell with
`captain.options.playbooks` enabling one or more playbooks by `from`
module specifier, the test suite shall fail unless: a missing
`captain.options.playbooks`, a missing `from`, a failed import, a
module exposing no valid registry entry, a map key differing from its
module's manifest `id`, two enabled playbooks sharing an `id`, and two
enabled playbooks resolving to the same effective command, or any
configured id or effective command equal to reserved `captain` each
reject `init`; each role resolves through its exact configured player id with no missing, extra, same-name, ancestor, or generated fallback;
on engaging, resuming, or routing to an enabled external playbook with bound roles the shell calls `setVisiblePlayers` with that playbook's distinct effective host player ids before dispatching Boss text;
a roleless playbook contributes no player and makes no visibility request;
the session Captain causes no visibility request; a
`setVisiblePlayers` validation rejection surfaces as an internal
shell error rather than a Boss input error; and a tmux pane
reconciliation failure does not block dispatch to the playbook
runtime (verifying [[playbook-captain-16](#playbook-captain-16)], [[playbook-captain-22](#playbook-captain-22)], [[playbook-captain-10](#playbook-captain-10)], [[playbook-captain-25](#playbook-captain-25)]).

### Generic command dispatch

#### playbook-captain-24


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
rather than being refused (verifying [[playbook-captain-1](#playbook-captain-1)], [[playbook-captain-2](#playbook-captain-2)], [[playbook-captain-16](#playbook-captain-16)]).

### Public Module Surface Coverage

#### playbook-captain-18


Where the test suite resolves `@sublang/playbook` through its
package exports, the test suite shall fail unless
`@sublang/playbook/playbook-captain` resolves and default-exports
a tmux-play Captain factory for the Playbook Captain shell that
loads its enabled playbooks from `captain.options.playbooks` rather
than hardcoding any playbook (verifying [[playbook-captain-17](#playbook-captain-17)]).

### Turn summary

#### playbook-captain-21


Where the test suite drives the Playbook Captain shell with a
registered playbook runtime, the test suite shall fail unless every
non-`respond` selection, including rejection or partial completion,
ends with one
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
The suite shall fail unless a `respond` or parse-resolved `respond`
makes no result-phase call, while a rejected selection makes the normal
result-phase call with no action effect; the literal substring
`Saved you` shall appear nowhere on either zero-activity turn.
A zero-activity accepted action and an entry without a `summaryPolicy`
shall likewise produce no saved-counts line.
The suite shall fail unless completed
sub-runtime player replies increment the interruption count by one
per reply; adjudicated guards named by their emitting frame's
`summaryPolicy` copy-paste guard list increment the copy-paste count
by one per handoff; guards absent from that list,
classifier/event JSON, session-Captain decision and result-phase
calls, and
malformed adjudication replies do not increment the copy-paste
count; sub-runtime state telemetry during the turn contributes only
an aggregate summary-visible progress phrase and round total,
counting each root or descendant frame under its own registry `summaryPolicy` labels exactly as
supplied and deriving no fallback label from state ids; unlabeled plan or
implementation steps, tests-green state ids, and other internal
states do not contribute to that phrase or total; and the prompt
instructs Captain to render a brief what-was-done summary, without
raw state /
transition / guard names, internal state counts, or how-it-was-done
narration, and without shell ledger JSON, followed by the
saved-counts line exactly when the supplied counted activity is
nonzero (verifying [[playbook-captain-7](#playbook-captain-7)], [[playbook-captain-19](#playbook-captain-19)], [[playbook-captain-20](#playbook-captain-20)]).
The suite shall fail unless a root that reaches final completion on its first input contributes exactly one completion fact carrying its quoted terminal-result meaning before disposal, an older runtime that omits the field falls back to its live control-view description and then the no-description statement, the hidden prompt and surfaced reply contain no opaque run output, and a root that instead parks and then finishes on delivery retains the established delivery fact plus the same single central completion fact without a second disposal-only completion message (verifying [[playbook-captain-20](#playbook-captain-20)]).

### Playbook Session Bridge Coverage

#### playbook-captain-27


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
The shell bridge shall forward `resume: false` and explicit tokens to the bound host player and preserve the host's returned `resumeToken` (verifying [[playbook-captain-10](#playbook-captain-10)]).
A real tmux-play integration shall prove that a later root engagement resumes an earlier token exactly when its role names the same player id, while a distinct id starts fresh even under identical settings (verifying [[playbook-captain-10](#playbook-captain-10)] and [[playbook-captain-26](#playbook-captain-26)]).
The suite shall fail unless explicit equal ids make CODE and REVIEW share Coder continuity and DECIDE and REVIEW share Coder and Reviewer continuity; a child-only player remains continuous after return and in a later root; root or child disposal does not clear the Captain-session ledger; a current player model or effort value or provider-default selection reaches the next call with the stored token; an adapter, active player-id, instruction, or permissions change rejects before a host call; every player call reapplies the complete settings; and an unsupported selection preserves the prior token without a fresh fallback (verifying [[playbook-captain-10](#playbook-captain-10)] and [[playbook-captain-26](#playbook-captain-26)]).
The suite shall also start two simultaneous calls through different local roles bound to one player id and fail unless the second rejects before the host, while simultaneous calls to distinct player ids may overlap (verifying [[playbook-captain-10](#playbook-captain-10)]).
It shall fail unless the same-player lane remains locked between host resolution and the owning runtime's exact update; an absent, repeated, stale, mismatched-role, mismatched-frame, or aborted update cannot publish or cancel another owner; `ok` without a token clears while non-`ok` without a token preserves; and a transition-worthy uncommitted, late, or malformed resolved result quarantines the lane so no later call uses its old token and no snapshot claims safety (verifying [[playbook-captain-10](#playbook-captain-10)]).
It shall also fail unless a runtime's attempt to invoke `PlayerSessionStore.restore` outside its exact shell-restoration callback rejects without changing the common token or an active transaction (verifying [[playbook-captain-10](#playbook-captain-10)] and [[playbook-captain-42](#playbook-captain-42)]).
The real host shall also prove
that final completion and active host teardown each deliver exactly one
`session.disposed` trace before session emissions close, without a
second disposal from the post-close Captain hook.
The suite shall fail unless durable session-Captain calls resume the
pinned conversation token with the current model and effort selection, preserve the pin without fresh fallback when either selection rejects, each returned token replaces the pin, and
an interleaved sub-runtime judge call runs fresh and never replaces
the pin, the next durable call resuming the latest pinned token (verifying [[playbook-captain-31](#playbook-captain-31)]).
Visible status and closing replies shall remain unchanged and shall
contain neither session ids, resume tokens, nor trace payloads.
When runtime initialization rejects, the test shall fail unless the
shell disposes the partial runtime, clears it, and a later validated
`start` constructs a
different engagement instead of reusing the failed one, with the
session Captain and its durable conversation unaffected.
The failed engagement's shell telemetry shall finish in `chat` with no frame (verifying [[playbook-captain-26](#playbook-captain-26)] and [[playbook-captain-31](#playbook-captain-31)]).

### Nested Playbook Stack Coverage

#### playbook-captain-30


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
The suite shall fail unless the child retains its own exact role map, its visible panes equal the distinct bound player ids, equal ids share the Captain-session ledger regardless of role spelling, and same-named roles with distinct ids remain independent (verifying [[playbook-captain-22](#playbook-captain-22)], [[playbook-captain-26](#playbook-captain-26)], and [[playbook-captain-29](#playbook-captain-29)]).
The test suite shall fail unless disabled targets, active-path cycles,
a second child from one frame, initialization failure, and stale return
ids reject without corrupting the caller; child dismissal
resumes the parent with an aborted result; root dismissal and teardown
dispose leaf to root; only the leaf receives Boss text and only an active
external leaf determines player visibility; the session Captain holds
no frame and no `callPlaybook` reaches or leaves it; and no
model-visible response,
status, or summary exposes stack or session ids (verifying [[playbook-captain-28](#playbook-captain-28)], [[playbook-captain-29](#playbook-captain-29)]).

#### playbook-captain-33

When the test suite drives the shell's control calls with a recorded
captain bridge, the test suite shall fail unless a shell built with
an authoritative session Captain adapter without a
provider-enforced tool-restriction surface omits `allowedTools` from every
durable session-Captain call and hidden adjudication call while still
resuming the pinned durable conversation on session-Captain calls,
requesting fresh isolation on judge calls, and using the
hidden-control envelope, and unless a shell built
with an enforcing or unrecognized adapter requests `allowedTools: []` on those same calls (verifying [[playbook-captain-31](#playbook-captain-31)]).

#### playbook-captain-36

Where the integration suite forces durable session-Captain calls to
fail, the suite shall fail unless each of the three unsynchronized
shapes — a throw, a non-`ok` result, and an `ok` result without a
resume token — clears the pin and re-issues only the failed call,
exactly once, on a fresh conversation whose captured prompt carries
the reseed digest plus the current ControlView digest; the
engagement stack, player sessions, journal, and completed turn work
survive; and the turn otherwise settles normally with the new token
pinned.
The suite shall fail unless the reseed digest is confined to that one
re-issued call: no captured prompt before the reseed carries it, no
later call on the replacement conversation carries it again, no
captured prompt at all carries a raw journal record, and the same
journal renders the same digest twice
([[playbook-captain-9](playbook-captain.md#playbook-captain-9)]).
The suite shall fail unless a second consecutive continuity failure
fails the phase with a Boss-appropriate reply that names a concrete
next step and contains no `adjudicator`, `guard`, `undeclared`, or
hidden-control wording, the stack untouched and the next Boss turn
settling normally, with the raw diagnostic preserved on trace
telemetry and the boundary error's `cause`.
The suite shall also fail unless a parentless external root's
rejected turn retains its frame as the active leaf and propagates
its boundary error unchanged (verifying [[playbook-captain-34](#playbook-captain-34)], [[playbook-captain-35](#playbook-captain-35)]).

### Conversational controller

#### playbook-captain-37


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
Boss text plus the ControlView digest — the failed leaf state carried
as the description CODE's own source publishes for it and never as its
state id, the
context members CODE's own projection exports rendered one bounded
line each, with none of its resolved player roster, option value, or
player-authored members appearing anywhere in the prompt
([[playbook-captain-9](playbook-captain.md#playbook-captain-9)]),
`lastError` `{ name, message }`, and the advertised retry action id
with its label — the validated `runtime` selection is that retry id,
exactly one real `apply()` executes with an `executed` receipt, and
the result-phase prompt carries the settlement facts verbatim and the
settled leaf's published description in place of its state id, while
turns 2–4 settle grounded with no dead no-action turn and no
re-execution (idempotency key honored, the player-call count fixed),
each of those replies reflecting the state's published meaning and
carrying no raw state id.
The suite shall fail unless: with an acting-agent question pending, the
Boss's answer settles as `deliver` and `BOSS_REPLY` resumes the same
state with the answer in context, the full question having surfaced
as captain speech; a mid-run status question while busy or parked is
answered from `describe()` alone — zero `apply` calls, zero FSM
events, the snapshot identical before and after, the surfaced reply
reflecting the state's published meaning and the pending question and
carrying no raw state id; and "what went
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
The suite shall fail unless the real compiled DECIDE artifact
engaged as leaf — its bespoke runtime shipping without the
`describe`/`apply` pair — is reported by the DR-022 gate as lacking
the pair, advertises no actions, and bounds only the machine verbs
against that leaf: plain text delivery is the only one, and a
`runtime` selection is invalid with zero `apply` calls.
The suite shall fail unless a status question on that capability-less
leaf still settles as `respond` — no `deliver`,
no FSM event, the leaf snapshot identical before and after — grounded
in the degraded ControlView digest the shell composes from the
engagement frame and its mirrored leaf facts
([[playbook-captain-9](playbook-captain.md#playbook-captain-9)]), the captured
decision prompt carrying that digest with its empty action list and
with the leaf state stated as publishing no description rather than
falling back to the state id the shell holds from telemetry.
The suite shall further fail unless the real pair-less DECIDE runtime reaches both its approval-backed and REVIEW-failure final states with the exact authored `stateDescription` on each terminal result, and the real shell's one completion fact carries that meaning before disposal without reading opaque output (verifying [[playbook-captain-20](#playbook-captain-20)]).
The suite shall fail unless a full Boss turn through the real shell
and real CODE artifact with a scripted empty-then-text player
recovers with normal lifecycle markers and exactly one turn summary,
the recovery invisible to the Boss surface except in traces (verifying [[playbook-captain-2](#playbook-captain-2)], [[playbook-captain-7](#playbook-captain-7)], [[playbook-captain-8](#playbook-captain-8)], [[playbook-captain-9](#playbook-captain-9)], [[playbook-captain-19](#playbook-captain-19)], [[playbook-captain-20](#playbook-captain-20)]).

#### playbook-captain-38


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
leaf delivers; `/decide x` absent from the path switches; bare
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
The suite shall fail unless a receipt the runtime refused returns
through the result-phase call and attempts one captain closing reply
grounded in the advertised action label and the refusal; when accepted,
exactly that reply is visible, with no effect, no separate refusal
status, and the refusal available to the next conversational turn.
The suite shall fail unless a `runtime` selection against a leaf whose
`describe()` throws at revalidation follows that same result path — no
`apply` call, no effect, and no exception escaping the Boss turn, a
control view that cannot be read being no evidence that an effect was
attempted.
The suite shall fail unless that same recovery survives a process
boundary: with the real CODE artifact driven to its recoverable failure
state, a fresh shell restoring only that exported snapshot composes a
digest advertising the same retry action id and label, applies it once
for real, and settles with the executed receipt naming it — the
restored leaf's runtime sourcing that action from the persisted machine
snapshot rather than from anything the first process held (verifying [[playbook-captain-2](#playbook-captain-2)], [[playbook-captain-3](#playbook-captain-3)], [[playbook-captain-7](#playbook-captain-7)], [[playbook-captain-8](#playbook-captain-8)]).

#### playbook-captain-39


Where the integration suite drives the durable conversation through
the real shell and real compiled session Captain, the suite shall
fail unless the pin rotates across durable calls (A1 then A2) while
an interleaved sub-runtime judge call stays fresh and isolated and
never replaces the pin, the next durable call resuming A2 and never
the judge call's token.
The suite shall fail unless a throw, non-`ok` result, or missing token
replaces only the model conversation from the complete recovery
history, preserving the engagement stack, player sessions, and
completed work.
A fact and a long Boss requirement accepted before that replacement
shall remain usable afterward without restatement, and a turn whose
model call failed shall appear in the recovered conversation rather
than disappear between adjacent turns (verifying [[playbook-captain-31](#playbook-captain-31)], [[playbook-captain-34](#playbook-captain-34)], [[playbook-captain-35](#playbook-captain-35)]).
The suite shall fail unless a typed Captain settings-preflight rejection on an unopened or pinned conversation makes no immediate fresh call, retains the exact resume selection and safe journal watermark through export and restore, and the next supported call sends that selection with exactly the missed journal suffix once.
It shall cover a closing-call rejection after a successful decision, repeated rejections that accumulate later records, a rejection while already needing a full reseed, a typed abort reason, retained-conversation telemetry, and a caught player settings rejection followed by a distinct runtime failure.
The abort shall propagate its exact signal reason and a host-admitted catch-up call aborted after resolving shall require a fresh full-history reseed rather than reuse the retained token.
The distinct failure shall retain its own classification; a player rejection reaching shell fallback shall retain the prior Captain resume target, mark only missed journal records for catch-up, and never force a fresh Captain conversation (verifying [[playbook-captain-31](#playbook-captain-31)] and [[playbook-captain-35](#playbook-captain-35)]).

The suite shall fail unless an action that completed before its
result-phase or presentation call failed is recorded with its outcome
and is never executed again during recovery.
It shall also fail unless a retainable root-runtime `aborted` result settles
as an uncertain failure, is recorded that way, and is never reported as
successful or repeated automatically.
A rejecting presentation shall have exactly one attempted reply, no
alternate-channel retry, and a surfaced boundary failure; the next
session-Captain call shall start fresh from a recovery recap containing the
exact attempted reply and its uncertain delivery rather than resuming a
conversation whose transcript may disagree with Boss.
A partial switch shall remain remembered as its separate dismissal and
start results, and its recovery reply shall claim neither rollback nor
unperformed work.
The suite shall fail unless a shell failure before a runtime invocation
causes no invocation and no claim that the runtime may have changed the
session; an error escaping the runtime invocation reports that
uncertainty and is not repeated; and a shell failure after a successful
invocation preserves the completed-work fact without adding that
uncertainty or repeating the invocation.

The suite shall fail unless a rejected selection returns through the
same result-phase conversation as any other selection, appears in the
recovery history, and lets a following “why?” continue from the
rejection without a separate refusal notice.
When immediate conversation recovery also fails, the next turn shall
still recover the prior history, leave the engagement untouched, and
surface only the truthful fallback allowed by
[[playbook-captain-34](playbook-captain.md#playbook-captain-34)].

#### playbook-captain-40


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
The suite shall fail unless that corrective re-ask is a real call for
a model-decided `respond` too: the captured re-ask shall resume the
decision call's own pinned token and carry the rejection reason, and a
clean second answer shall be the surfaced captain speech.
The suite shall fail unless a reply carrying an engagement's live
generated session id is refused with one corrective re-ask naming the
leaked identifier, that id never reaching the Boss surface.
The suite shall fail unless a reply carrying the live leaf's own
machine-shaped state id is refused the same way — one corrective
re-ask naming the leaked internal state identifier, the id never
reaching the Boss surface and never having reached the decision prompt
either — and unless a reply naming a live state id that is an ordinary
English word (`failed`, `ready`) is surfaced unchanged with no
corrective at all, the duty being narrow by construction rather than a
list of literals.
The suite shall fail unless a rejected action's result-phase closing
reply passes this same validation: with the runtime's reason naming an
internal state its advertised jump id embeds, the Captain shall state
the rejection and next step without exposing that identifier.
The suite shall fail unless the same holds for a machine-shaped
identifier the host itself supplied this turn, which no live-state check
can reach: with the real CODE artifact parked in its failure state and
the digest advertising `jump:<stateId>`, a closing reply repeating that
target name shall get exactly one corrective re-ask naming the repeated
supplied identifier, only the corrected prose shall reach the Boss
surface, and neither the id nor its `<verb>:`-stripped fragment shall
appear in any surfaced reply.
The suite shall fail unless the same holds for an identifier the shell
supplied through a block other than a read control view's advertised
actions: a mirrored pending question shall reach the degraded digest with
its id under the contract's own field name and a reply repeating that id
shall be refused; and a reseed digest replaying an action record shall
put that action's id back in the turn's prompt with nothing live
advertising it, a reply repeating it never reaching the Boss surface.
The suite shall fail unless a one-character supplied id is guarded like
any other, and unless a reply carrying that id only inside a longer token
is surfaced unchanged — the duty following the token a reply repeats
rather than a substring match a length floor had to compensate for.
It shall also fail unless a Boss-facing action label that resembles an
identifier is surfaced unchanged while that action's distinct control id
remains guarded.
The shell's own composition of the ControlView block shall be pinned
against whatever a runtime exports: the suite shall fail unless each
exported context member appears as its own line carrying its name and
its escaped, bounded value rather than as an inlined JSON document,
unless a long exported value is truncated like every other quoted
foreign span, and unless an exported value spelling out a second
labeled block opens no such block in either the decision or the
closing-reply prompt.
The same shall hold for every other foreign string the shell composes
into a digest line, enumerated from the declarations that define them
rather than from a remembered list: the suite shall fail unless a
newline-bearing sentinel placed in any string-typed member of the
advertised-action record, of the pending-question record, or of an
enabled playbook's registry entry leaves the composed prompt's labeled
blocks exactly as a clean prompt's.
The suite shall fail unless a leaf whose control view reads cleanly and
publishes no description for its current state has that stated as a
published absence, with the state id the same view carries never
substituted for it and never reaching the prompt — the missing-member
branch of the same rule the capability-less leaf covers, and the branch
that decides whether an identifier the host would later refuse in a
reply was one the host itself supplied.
The suite shall fail unless a leaf whose `describe()` is implemented
and throws is reported as a control view that could not be read —
naming the normalized failure, reporting the advertised actions as
unknown rather than none, and never claiming the leaf advertises no
control surface — while `respond` stays valid for that turn (verifying [[playbook-captain-7](#playbook-captain-7)], [[playbook-captain-9](#playbook-captain-9)]).

### Complete shell snapshot coverage

#### playbook-captain-43

Where the integration suite drives the public Playbook Captain shell through safe and unsafe boundaries, exports snapshots, JSON-round-trips them, and restores them into fresh shells built from current configuration, the test suite shall fail unless all cases hold:

- A fresh `chat` shell and a `chat` shell after a healthy Captain reply export the exact mode union with no engagement members; the latter preserves the Captain runtime, pinned conversation token, complete journal, sequences, last action and settlement, and issued identities; restore allocates no identity and attempts no host emission, model or player call, controller submission, or visibility change; and the next turn continues the saved conversation, journal, and counters rather than starting a replacement session (verifying [[playbook-captain-41](#playbook-captain-41)] and [[playbook-captain-42](#playbook-captain-42)]).
- A `chat` shell whose presentation failure made the durable conversation require reseeding restores that exact state, and its next Captain call starts fresh with the saved recovery history once rather than resuming a suspect token or losing the failed turn (verifying [[playbook-captain-41](#playbook-captain-41)] and [[playbook-captain-42](#playbook-captain-42)]).
- A typed settings rejection before Captain provider work, including an exact player rejection that reaches shell fallback, exports and restores `needsCatchUp` with the exact retained resume selection and watermark, and its next supported call replays the missed suffix once without changing snapshot structure for current model or effort tuning (verifying [[playbook-captain-35](#playbook-captain-35)], [[playbook-captain-41](#playbook-captain-41)], and [[playbook-captain-42](#playbook-captain-42)]).
- A parked root carrying explicit role bindings, a session-ledger token, saved options, pending Boss question, mirrored last error, and prior issued frame id restores the same frame and runtime state under the same identities; the next Boss reply reaches that saved player id and resumes its token; and a later generated identity cannot reuse any historical id (verifying [[playbook-captain-41](#playbook-captain-41)] and [[playbook-captain-42](#playbook-captain-42)]).
- A parent parked behind a nested child exports ordered frames whose exact edge is the parent's suspended-call descriptor, whose leaf has no dangling descriptor, and whose explicit equal-id bindings project one shared session token; restore calls no child again and emits no second start; the child's eventual result emits the one original finish, resumes the parent exactly once, preserves original call and turn ownership, and leaves both frames on that same player continuation (verifying [[playbook-captain-41](#playbook-captain-41)] and [[playbook-captain-42](#playbook-captain-42)]).
- Export during an active Boss turn, an opening child, a turn-summary or controller-call transient, queued or in-flight host work, frame removal, `engaged.driving`, or disposal returns `undefined` without an emission or state change, as does an export whose runtime or nested edge cannot provide a consistent safe snapshot (verifying [[playbook-captain-41](#playbook-captain-41)]).
- The public package surface exposes every snapshot, retained-generation, retention-update, settlement, validator, and shell declaration required by [[playbook-captain-41](#playbook-captain-41)], and types the default factory as returning `PlaybookCaptainShell` (verifying [[playbook-captain-41](#playbook-captain-41)]).
- Direct pure-validator mutations covering the schema and mode discriminants, unknown keys and non-JSON structures, fixed Captain and player envelopes without model or effort, every conversation shape and catch-up invariant, complete contiguous turn ownership and exact journal count, Captain-runtime/shell turn equality and Captain contribution, UUID uniqueness, Captain/frame distinction, issued-id inclusion, runtime/playbook identity, frame topology and parked leaf, suspended-call edges and leaf absence, role-question ownership, shell/leaf pending-question equality, and local/session token projection each reject before a configuration read, module import, runtime construction, or host operation; restore-only mutations cover enabled catalog, saved options and role maps, and current adapter, instruction, and permissions compatibility; an already initialized, restored, disposing, or disposed shell also rejects restore (verifying [[playbook-captain-41](#playbook-captain-41)] and [[playbook-captain-42](#playbook-captain-42)]).
- When the Captain restore, a root restore, or a later child restore throws, mutates a token projection, restores a different state, or attempts any gated emission or call, the shell rejects with no host record or external call, attempts all partial-runtime disposal in leaf-to-root then Captain order under the closed gate, retains no partial identity, frame, token, journal, or conversation reference, and accepts a subsequent valid `init` or `restore` only when cleanup succeeded; a rejecting cleanup is aggregated and leaves the shell closed (verifying [[playbook-captain-42](#playbook-captain-42)]).
- A restored child carries no replacement invocation signal or abort listener, resumes its parent only by the saved call id when it actually returns, and is disposed without parent resume when teardown wins (verifying [[playbook-captain-42](#playbook-captain-42)]).

#### playbook-captain-45

Where the integration suite drives the public shell through retained-generation-capable and capability-less runtimes, it shall fail unless a parked root exports its current active generation with the shell snapshot, an artifact-declared unfinished terminal exports the last active pre-terminal generation rather than its final state, a same-turn unfinished terminal with no prior work-bearing generation settles in chat with no retain or clear update, a clean terminal emits `clear`, and a capability-less root emits `clear` without a partial generation (verifying [[playbook-captain-44](#playbook-captain-44)]).
The suite shall also fail unless dismissal preserves the exact previously parked generation, a nested parked stack exports both frame snapshots and both halves of every call bridge as one root generation, a capable root that begins and opens a capability-less child in the same turn emits no retention update, a capable existing root that opens such a child retains its exact complete turn-start generation without a partial stack while a later settlement that begins with that child emits no update for the root, and an unsafe claimed-capable generation or missing stable terminal id prevents settlement rather than preserving stale state (verifying [[playbook-captain-44](#playbook-captain-44)]).
