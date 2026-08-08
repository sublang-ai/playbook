<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - Boss surface

## Intent

This spec defines the Boss-visible behavior of the built-in
Playbook Captain shell that runs under tmux-play and routes Boss
turns to registered playbook runtimes.
The session Captain — the compiled default Captain playbook
([CAPPLAY](captain-playbook.md)) — runs for the whole shell session
as an always-present controller outside the engagement stack and
decides every turn that deterministic command parsing does not
resolve; the hand-authored shell retains command parsing, action
validation and effects, lifecycle, visibility, and the causal
runtime stack.
The first registered playbook is CODE.
CODE runtime behavior after a turn reaches CODE remains specified
by [PBRT](playbook-runtime.md).

## Selection and chat

### CAPTAIN-1

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
([CAPPLAY-1](captain-playbook.md#capplay-1)): a conversational turn
settles as one visible captain reply with no engagement and no
lifecycle status line, and a task intent starts an enabled playbook
through the validated `start` action, with the specialized work
never performed by the Captain itself.
Empty or whitespace-only input shall produce no model call, no
session, no status line, and no telemetry event.

### CAPTAIN-2

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
both facts through the [CAPTAIN-3](#captain-3) status lines and the
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
([CAPPLAY-4](captain-playbook.md#capplay-4)): task-directed content
— an instruction, answer, or continuation for the working playbook —
is delivered as the original text unchanged to the active leaf
runtime; conversation, planning, or clarification addressed to the
Captain — a progress or status question included — settles as one
visible captain reply grounded in the observed runtime state, with
no state movement and the parked leaf and any pending player
question untouched, however many times such a question is asked; an
explicit stop request dismisses; an explicit replacement request
switches; and an explicit recovery or resume request may execute one
runtime-advertised action
([CAPTAIN-8](../dev/playbook-captain.md#captain-8)).
While a player question is pending on the active leaf, when the Boss
answers, the shell shall deliver the answer to that same leaf, which
shall resume its suspended state with the answer in context.

## Engagement progress

### CAPTAIN-3

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
Adapter teardown through [CAPTAIN-16](../dev/playbook-captain.md#captain-16)
is not a Boss-facing engagement disposal and need not emit a
Boss-visible status line.

### CAPTAIN-4

Where the Playbook Captain shell is running under tmux-play, while a
playbook is engaged, when the active leaf's descriptor is quiescent and
tagged `playbook.parked` or its run result is suspended, the shell shall
keep that engagement available for the next Boss turn.
Where the Playbook Captain shell is running under tmux-play, while a
root playbook is engaged, when the root run result is terminal or a
validated `dismiss` or `switch` dismisses the root engagement, the
shell shall dispose that engagement and return to its idle state;
for a validated `switch`, that idle state lasts only until the same
turn starts the target playbook ([CAPTAIN-2](#captain-2)).
Nested child completion and dismissal shall instead follow
[CAPTAIN-28](#captain-28).

### CAPTAIN-19

Where the Playbook Captain shell settles a Boss turn by executing a
validated action (an acting turn), the shell shall end the turn with
one visible captain closing reply after the action's ordered status
and telemetry emissions, and that closing reply shall be the turn
summary.
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
[CAPTAIN-20](../dev/playbook-captain.md#captain-20) — is nonzero,
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
entry declares no summary policy, or when the Boss turn executes no
action — a `respond` settle, a parse-resolved `respond`, or a rejected
selection — the saved-counts line shall not appear, so text
beginning `Saved you` never follows a turn that saved nothing.

## Active-playbook visibility

### CAPTAIN-25

Where the Playbook Captain shell is running under tmux-play with two
or more playbooks enabled, when the shell engages, resumes, or routes
a Boss turn to an enabled external playbook, the shell shall make that playbook's panes
the visible ones in the main tmux window and not the panes of the
other enabled playbooks.
The session Captain shall make no visibility request and may leave
the last external playbook's panes visible.
After the engaged playbook reaches its final state or the Boss
dismisses it, the shell may leave the visible panes on the last
selected playbook until the next selection.

## Nested playbooks

### CAPTAIN-28

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

## Failure recovery

### CAPTAIN-34

Where a session-Captain durable call fails so that the shell cannot
prove the conversation is synchronized — it throws, returns a
non-`ok` status, or returns `ok` without a resume token — the shell
shall recover per
[CAPTAIN-35](../dev/playbook-captain.md#captain-35) by re-issuing
only that call once on a reseeded conversation; the engagement
stack, player sessions, completed turn work, and the Boss-visible
transcript shall be unaffected, and the turn shall otherwise settle
normally.
When the re-issued call fails again, the turn shall settle with a
Boss-appropriate failure reply that names a concrete next step and
contains no internal control vocabulary such as `adjudicator`,
`guard`, `undeclared`, or hidden control JSON; the engagement stack
shall remain intact, and the Boss's next message or registered
command shall settle normally with no already-running refusal and no
lost work.
That reply shall assert only what the turn recorded.
Where no action settled, it shall state that nothing was changed and
name resending the request as the next step.
Where an action already settled, it shall name that settlement's
recorded facts, shall not state that nothing was changed, and shall
not name resending as the next step — a resend would repeat completed
work — naming asking for the current state instead.
Those facts shall be named in Boss-facing terms: an executed or refused
runtime action shall be named by the label its runtime advertised for
it, never by the action id, and the composed reply shall carry no
internal identifier or control vocabulary
([CAPTAIN-9](../dev/playbook-captain.md#captain-9)); where the recorded
facts cannot be stated that way — a runtime-authored refusal reason or
error message being foreign text — the reply shall omit the facts and
still state the settlement and the next step, rather than being
withheld or printed unchecked.
Every Boss turn shall reach exactly one visible settlement: captain
speech, the shell status line of a refused selection, or this failure
reply.
A selection the active runtime refuses shall reach that same status
line as one the shell refuses itself: the refusal ends the turn with no
action and no closing reply, and which side refused is not the Boss's
concern.
That status line is a Boss-visible settlement like the other two and
shall be held to the same rules: it shall carry no internal identifier
or control vocabulary, and where the refusal cannot be stated that way —
a runtime-authored reason being foreign text and a rejected name being
the model's — it shall state that the request was refused, that nothing
was changed, and the next step, rather than being withheld or printed
unchecked.
A refused selection shall also survive in the session's own memory, so
a follow-up such as "why?" or "do it anyway" is answered against it:
the next turn shall be able to name what was proposed, that it was
refused, and why, without the Boss restating any of it, and without the
refusal having cost a model call
([CAPTAIN-35](../dev/playbook-captain.md#captain-35)).
Where a turn ends with no selection submitted and no captain speech
surfaced — including where the session Captain's machine recovers to
its hub after a second malformed decision reply and reports a healthy
outcome
([CAPPLAY-18](../dev/captain-playbook.md#capplay-18)) — the shell
shall settle that turn with this failure reply rather than end it
with no action and no reply.
