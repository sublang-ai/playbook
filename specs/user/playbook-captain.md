<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - Boss surface

## Intent

This spec defines the Boss-visible behavior of the built-in
Playbook Captain shell that runs under tmux-play and routes Boss
turns to registered playbook runtimes.
Ordinary idle text is handled by the lazy compiled default Captain; the
hand-authored shell retains command selection, lifecycle, visibility, and the
causal runtime stack.
The first registered playbook is CODE.
CODE runtime behavior after a turn reaches CODE remains specified
by [PBRT](playbook-runtime.md).

## Selection and chat

### CAPTAIN-1

Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while no playbook is engaged, when the
Boss submits `/<command> <text>` for an enabled playbook's command
(such as `/code`), the shell shall engage that playbook and submit
`<text>` to its runtime as ordinary Boss text.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while no playbook is engaged, when the
Boss submits a bare `/<command>` for an enabled playbook (such as
`/code`), the shell shall engage that playbook and respond in
visible Captain chat asking for the task to run.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while no playbook is engaged, when the
Boss submits ordinary text, an unregistered slash-prefixed command,
or a near-miss command-like input, the shell shall lazily run the
default Captain playbook, which shall ask one material routing question or
select one or more enabled playbooks in sequence without performing the
specialized work itself.

### CAPTAIN-2

Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while a playbook is engaged, when the Boss
submits `/<command> <text>` for the engaged playbook's command (such
as `/code` while CODE is engaged), the shell shall submit `<text>` to
the existing runtime and shall not reset, dispose, or reconstruct it.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while a playbook is engaged, when the Boss
submits the engaged playbook's bare `/<command>`, the shell shall
respond in visible Captain chat with clarification or current
engagement status and shall not reset, dispose, or reconstruct the
runtime.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while a playbook is engaged, when the Boss
submits a different enabled playbook's command, the shell shall not
dispatch that command and shall ask the Boss to finish, dismiss, or
resolve the current engagement first.
Where the Playbook Captain shell is running under tmux-play with one
or more playbooks enabled, while a playbook is engaged, when the Boss
submits ordinary text, the shell shall deliver the original text to
the active leaf runtime unless its hidden lifecycle classifier selects
dismissal; classifier failure or malformed output shall deliver rather
than discard or rewrite the turn.

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
`◇ /<command> stopped` when Boss dismisses the engagement, and
`◇ /<command> finished` when it disposes the playbook after final
completion, using the registered slash command such as `/code`
rather than the internal playbook id, without changing or reusing
the engaged runtime's glyph vocabulary.
The internal default Captain root shall emit none of these lifecycle lines.
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
root playbook is engaged, when the root run result is terminal or the
Boss explicitly dismisses the root engagement, the
shell shall dispose that engagement and return to its idle state; completion
of the internal Captain root shall not trigger a second visible chat call.
Nested child completion and dismissal shall instead follow
[CAPTAIN-28](#captain-28).

### CAPTAIN-19

Where the Playbook Captain shell is running under tmux-play, while
a playbook is engaged, when the shell submits a Boss turn to the
engaged playbook and that playbook finishes processing the
submitted turn, the shell shall append a visible Captain
turn-summary block after the sub-runtime's ordered status and
telemetry emissions for that turn, but only when the engaged
playbook's registry entry declares a summary policy.
When the engaged playbook's registry entry declares no summary
policy, the shell shall append no turn-summary block for that turn.
The summary block shall use a natural chat-like tone and clear
formatting while remaining brief.
The summary block shall first state only what was done or what
changed during the completed sub-runtime turn, not how it was done.
When the summary block mentions progress detail, it shall use only
aggregate counts whose labels the active playbook registry entry
declares summary-visible.
For CODE, those counts are review/rebuttal round counts, for
example:
`2 review rounds, 1 rebuttal`.
The summary block shall not include counts for plan or
implementation steps, tests-green state ids, other internal states,
raw state names, transitions, guard names, prompts, tools, hidden
calls, or reasoning.
The summary block shall then include one saved-counts line whose
wording the engaged playbook's registry entry supplies through its
summary policy; for CODE that line has the format:
`Saved you X interruptions and Y copy-pastes across Z rounds of reviews/rebuttals.`
The saved-counts line shall use natural singular forms when a count
is one.
In that line, `X`, `Y`, and `Z` are decimal counts for that
completed sub-runtime turn.
Interruptions are player replies that Boss did not have to relay,
copy-pastes are inter-player handoffs — including reviews,
rebuttals, revisions, approvals, and passes — that Boss did not
have to transfer manually, and review/rebuttal rounds are the
counted review-round and rebuttal occurrences for that turn.
Where the Playbook Captain shell handles a Boss turn in the internal Captain,
as shell-owned command guidance, as a bare playbook selection without
sub-runtime submission, or as lifecycle recovery, the shell shall not append
a turn-summary block for that Boss turn.

## Active-playbook visibility

### CAPTAIN-25

Where the Playbook Captain shell is running under tmux-play with two
or more playbooks enabled, when the shell engages, resumes, or routes
a Boss turn to an enabled external playbook, the shell shall make that playbook's panes
the visible ones in the main tmux window and not the panes of the
other enabled playbooks.
The internal default Captain root shall make no visibility request and may
leave the last external playbook's panes visible.
After the engaged playbook reaches its final state or the Boss
dismisses it, the shell may leave the visible panes on the last
selected playbook until the next selection.

## Nested playbooks

### CAPTAIN-28

Where an engaged playbook calls another enabled playbook, when the
child begins, the Playbook Captain shell shall make the child the active
playbook for Boss input and player-pane visibility while preserving the
parent for automatic return.
Where the parent is an enabled external playbook, the shell shall emit
`◇ /<child> called by /<parent>` when it enters the child and
`◇ /<child> returned to /<parent>` when the child finishes and its result
resumes the parent.
Where the parent is the internal default Captain, those lines shall instead be
`◇ /<child> called by Captain` and `◇ /<child> returned to Captain`.
Where a child is parked for Boss input, the next Boss turn shall reach
that same child session; where the Boss dismisses a child, the shell
shall emit `◇ /<child> stopped; returning to /<parent>` for an external
parent or `◇ /<child> stopped; returning to Captain` for the internal parent, abort the child
call, and resume the parent rather than discard the root engagement.
Where the Boss dismisses the root engagement, the shell shall stop the
complete nested stack.
The shell shall not expose playbook session ids, call ids, child output,
or stack ledger data in those status lines.
