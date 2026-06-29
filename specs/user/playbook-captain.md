<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPTAIN: Playbook Captain shell - Boss surface

## Intent

This spec defines the Boss-visible behavior of the built-in
Playbook Captain shell that runs under tmux-play and routes Boss
turns to registered playbook runtimes.
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
or a near-miss command-like input, the shell shall route the turn by
hidden Captain routing; a low-confidence or near-miss selection
shall produce visible clarification rather than dispatching to a
playbook.

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
submits ordinary text, the shell shall route the turn by hidden
Captain routing and shall either continue the existing runtime,
respond in visible Captain chat, or dispose the engagement and
return to Captain chat.

## Engagement progress

### CAPTAIN-3

Where the Playbook Captain shell is running under tmux-play, while
a playbook is engaged, when the engaged runtime emits status or
telemetry, the shell shall pass those emissions through to the host
in order.
Where the Playbook Captain shell is running under tmux-play, when
the shell engages, dismisses, or disposes a playbook engagement,
the shell shall emit Boss-visible Captain status lines
`◇ /<command> started` when it engages the playbook,
`◇ /<command> stopped` when Boss dismisses the engagement, and
`◇ /<command> finished` when it disposes the playbook after final
completion, using the registered slash command such as `/code`
rather than the internal playbook id, without changing or reusing
the engaged runtime's glyph vocabulary.
Those shell-owned status lines shall be complete human-readable
messages and shall not attach structured status data that the host
could render as raw JSON.
Adapter teardown through [CAPTAIN-16](../dev/playbook-captain.md#captain-16)
is not a Boss-facing engagement disposal and need not emit a
Boss-visible status line.

### CAPTAIN-4

Where the Playbook Captain shell is running under tmux-play, while a
playbook is engaged, when the engaged playbook parks at its registry
entry's idle state or one of its park states (for CODE, its idle,
failed, or `awaitBossReply` state), the shell shall keep that
engagement available for the next Boss turn.
Where the Playbook Captain shell is running under tmux-play, while a
playbook is engaged, when the engaged playbook reaches its registry
entry's final state or the Boss explicitly dismisses the engagement,
the shell shall dispose that engagement and return to Captain chat.

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
Where the Playbook Captain shell handles a Boss turn as Captain chat,
clarification, bare playbook selection without sub-runtime
submission, or routing failure recovery, the shell shall not append
a turn-summary block for that Boss turn.
