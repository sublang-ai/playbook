<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: CODE playbook runtime — Boss surface

## Intent

This spec defines the user-visible behavior of the CODE playbook
runtime: how a Boss's turn input is interpreted, what the Boss
observes as a turn progresses, and the host-configuration contract
for running the runtime under tmux-play.

The runtime module and its tmux-play host adapter live at the
repo root; the in-repo path is essential to the package's intent
per [META-15](../meta.md#meta-15). The
tmux-play surface depends on the external `@sublang/cligent`
package. System behavior is in
[dev/playbook-runtime.md](../dev/playbook-runtime.md).

## Turn input

### PBRT-1

When the Boss submits a non-empty turn while the runtime is not
waiting for a Boss reply, the runtime shall classify the text by
consulting the judge.
The judge shall resolve it to one FSM Boss event — `START_CODING`,
`CONTINUE_IR`, `SUMMARIZE_IR`, or
`BOSS_INTERRUPT` — with the required payload, or to no FSM action.
For `BOSS_INTERRUPT`, the judge shall select the target from the
FSM's jumpable states.

The runtime shall define and recognize no in-playbook slash
commands.
Any `/command` playbook-selection UX happens before text
reaches the runtime; text beginning with `/` that does reach the
runtime is classified as ordinary Boss text.

### PBRT-2

When the Boss submits a non-empty turn while the actor is in the
`awaitBossReply` Boss-reply suspension state, the runtime shall
classify the text by consulting the judge with the pending
question as context.
The judge shall resolve the text either to
`BOSS_REPLY` with the verbatim answer for the pending question, or
to a fresh Boss directive event that abandons the pending question
via `clearBossReplyContext`.

When the text is empty or whitespace-only, the runtime shall take
no FSM action and make no judge call.
When the judge does not resolve the text to a valid event and payload, the runtime shall
report the reason to the Boss and take no FSM action.

## Turn progress

### PBRT-3

While a Boss turn is in progress, the runtime shall surface a
human-readable status stream that lets the Boss follow the FSM
without reading the player panes. The stream uses four glyphs so
each line is parseable at a glance:

- `▸` for the Boss-input echo: the verbatim turn text and the
  FSM event it classified to.
- `⮕` for entry into any captain-invoking state — the Coder,
  Reviewer, and Committer states — carrying the state's
  human-readable label, the player, the CODE-N source item, and
  any rider field whose value is populated in the FSM context
  (`intent`, `irNumber`, `taskDescription`).
- `⤷` for the transition that drove the FSM into a new
  captain-invoking state: the guard that fired and item tallies
  for any payload fields the guard populated.
- `◆` for entry into the idle state, the failure state, the
  terminal state, and the `awaitBossReply` Boss-reply suspension
  state. On entry to the failure state the line shall
  additionally carry the error that caused it. On entry to
  `awaitBossReply` the line shall additionally carry
  `awaiting Boss reply · <resumeStateId> · <player> ·
  <sourceItem> · q="<first 80 chars of question>"`, so the
  Boss sees what's being asked and can reply with plain text
  that the runtime classifies as `BOSS_REPLY`.

## Host configuration

### PBRT-4

Where the runtime runs under tmux-play, the adapter shall route
each player call to the host player whose `id` equals the runtime's
baked player id (`coder` for Coder, `reviewer` for Reviewer),
performing no player-id remapping. The host configuration must
accordingly point `captain.from` at the adapter module and declare
`players[].id` values equal to those baked ids; the adapter shall
derive the per-run player identity strings (`coderPlayer`,
`reviewerPlayer`) from each player entry's `adapter` value at init
time, so the host configuration shall not be required to repeat them
under `captain.options`.
