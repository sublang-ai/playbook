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

Where the Playbook Captain shell is running under tmux-play with
CODE registered, while no playbook is engaged, when the Boss
submits `/code <text>`, the shell shall engage CODE and submit
`<text>` to the CODE runtime as ordinary Boss text.
Where the Playbook Captain shell is running under tmux-play with
CODE registered, while no playbook is engaged, when the Boss
submits bare `/code`, the shell shall engage CODE and respond in
visible Captain chat asking for the task to run.
Where the Playbook Captain shell is running under tmux-play with
CODE registered, while no playbook is engaged, when the Boss
submits ordinary text, an unregistered slash-prefixed command, or
a near-miss command-like input, the shell shall route the turn by
hidden Captain routing; a low-confidence or near-miss selection
shall produce visible clarification rather than dispatching to a
playbook.

### CAPTAIN-2

Where the Playbook Captain shell is running under tmux-play with
CODE registered, while CODE is engaged, when the Boss submits
`/code <text>`, the shell shall submit `<text>` to the existing
CODE runtime and shall not reset, dispose, or reconstruct that
runtime.
Where the Playbook Captain shell is running under tmux-play with
CODE registered, while CODE is engaged, when the Boss submits bare
`/code`, the shell shall respond in visible Captain chat with
clarification or current engagement status and shall not reset,
dispose, or reconstruct the CODE runtime.
Where the Playbook Captain shell is running under tmux-play with
CODE registered, while CODE is engaged, when the Boss submits a
different registered playbook command, the shell shall not dispatch
that command and shall ask the Boss to finish, dismiss, or resolve
the current engagement first.
Where the Playbook Captain shell is running under tmux-play with
CODE registered, while CODE is engaged, when the Boss submits
ordinary text, the shell shall route the turn by hidden Captain
routing and shall either continue the existing CODE runtime,
respond in visible Captain chat, or dispose the CODE engagement and
return to shell chat.

## Engagement progress

### CAPTAIN-3

Where the Playbook Captain shell is running under tmux-play, while
a playbook is engaged, when the engaged runtime emits status or
telemetry, the shell shall pass those emissions through to the host
in order.
Where the Playbook Captain shell is running under tmux-play, when
the shell engages, dismisses, or disposes a playbook engagement,
the shell shall emit Boss-visible Captain status lines
`◇ shell engaged <playbookId>`, `◇ shell dismissed <playbookId>`,
and `◇ shell disposed <playbookId>` for those shell events without
changing or reusing the engaged runtime's glyph vocabulary.
Those shell-owned status lines shall be complete human-readable
messages and shall not attach structured status data that the host
could render as raw JSON.
Adapter teardown through [CAPTAIN-16](../dev/playbook-captain.md#captain-16)
is not a Boss-facing engagement disposal and need not emit a
Boss-visible status line.

### CAPTAIN-4

Where the Playbook Captain shell is running under tmux-play, while
CODE is engaged, when CODE parks at its idle state, failed state,
or `awaitBossReply` state, the shell shall keep the CODE engagement
available for the next Boss turn.
Where the Playbook Captain shell is running under tmux-play, while
CODE is engaged, when CODE reaches its final state or the Boss
explicitly dismisses the engagement, the shell shall dispose that
CODE engagement and return to shell chat.
