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
without reading the player panes. The runtime composes each line
as the meaningful content only; the host pane (e.g., tmux-play)
owns any speaker chrome, line wrapping, and visual nesting.

The stream uses three glyphs and one captain-speech act so each
line is parseable at a glance:

- Captain classification carries only the FSM event type the Boss
  turn was classified to (e.g., `START_CODING`), with no glyph.
  The host renders it as captain speech (e.g., prefixed
  `captain>`). The runtime shall not echo the verbatim Boss text —
  the Boss readline already shows it.
- `⤷` for entry into any captain-invoking state — the Coder,
  Reviewer, and Committer states — carrying `<Player>: <label>`
  where `<label>` is the state's human-readable label. The line
  shall carry no source-item tag and no FSM-context rider fields.
- `→` for the transition that drove the FSM into a new
  captain-invoking state, carrying the guard that fired and
  `· <field>=<count>` tallies for any payload fields the guard
  populated. Visual nesting under the preceding `⤷` entry is the
  host presenter's concern; the runtime emits no leading
  whitespace.
- `◆` for entry into the failure state and into the
  `awaitBossReply` Boss-reply suspension state. The runtime shall
  emit no status line on entry to the idle state or the terminal
  state — the next `boss>` prompt is the implicit signal. On
  entry to the failure state the line shall additionally carry
  the error that caused it. On entry to `awaitBossReply` the line
  shall additionally carry `awaiting Boss reply · <resumeStateId>
  · <player> · <sourceItem> · q="<first 80 chars of question>"`,
  so the Boss sees what's being asked and can reply with plain
  text that the runtime classifies as `BOSS_REPLY`.

## Host configuration

### PBRT-4

Where the runtime runs under tmux-play, the adapter shall route
each player call to the host player whose `id` equals the runtime's
baked player id (`coder` for Coder, `reviewer` for Reviewer),
performing no player-id remapping. The host configuration must
accordingly point `captain.from` at the adapter module and declare
`players[].id` values equal to those baked ids; the adapter shall
derive the per-run player identity strings (`coderPlayer`,
`reviewerPlayer`) from each player entry's `model` when pinned and
fall back to its `adapter` when no model is set, so the host
configuration shall not be required to repeat them under
`captain.options` and player prompts carry the concrete model
identity (e.g. `claude-opus-4-7`) rather than the adapter family
name (e.g. `claude`) whenever the host has pinned a model.

### PBRT-29

Where the runtime runs under tmux-play, CODE-specific runtime
options shall be carried under `captain.options.code` as a
namespaced object, and no CODE option shall be placed elsewhere
in the config.
A setting that changes host-observable behavior — theme, layout,
permissions, model or adapter routing, or timing — shall be
expressed through tmux-play's own `captain` / `players` fields
rather than `captain.options.code`.
The `captain.from` adapter-module path and the `coder` /
`reviewer` `players[].id` values are supplied by the
`playbook-code` composer ([PBCODE-16](playbook-code.md#pbcode-16))
and shall not be required to appear in the user-edited CODE
overlay; this supersedes the user-maintained-invariant framing of
[PBRT-4](#pbrt-4).
