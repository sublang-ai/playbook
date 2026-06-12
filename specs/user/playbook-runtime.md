<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: CODE playbook runtime — Boss surface

## Intent

This spec defines the user-visible behavior of the CODE playbook
runtime: how a Boss's turn input is interpreted after it reaches
CODE, what the Boss observes as a CODE turn progresses, and the
host-configuration contract for running CODE under tmux-play
through the Playbook Captain shell.

The runtime module and its tmux-play shell registry entry live at
the repo root; the in-repo path is essential to the package's
intent per [META-15](../meta.md#meta-15).
The tmux-play surface depends on the external `@sublang/cligent`
package and the Playbook Captain shell specified in
[CAPTAIN](playbook-captain.md).
System behavior is in
[dev/playbook-runtime.md](../dev/playbook-runtime.md).

## Turn input

### PBRT-1

Where a Boss turn reaches the CODE runtime, when the Boss submits
a non-empty turn while the runtime is not waiting for a Boss reply,
the runtime shall classify the text by consulting the judge.
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

Where a Boss turn reaches the CODE runtime, when the Boss submits
a non-empty turn while the actor is in the `awaitBossReply`
Boss-reply suspension state, the runtime shall classify the text by
consulting the judge with the pending question as context.
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
The judge's own JSON replies — classification and adjudication —
shall not appear on this stream; the runtime composes every line,
so the pane stays human-readable (the host runs judge calls
hidden per [PBRT-15](../dev/playbook-runtime.md#pbrt-15)).

The stream uses three glyphs and two captain-speech acts so each
line is parseable at a glance:

- Captain classification carries only the FSM event type the Boss
  turn was classified to (e.g., `START_CODING`), with no glyph.
  The host renders it as captain speech (e.g., prefixed
  `captain>`). The runtime shall not echo the verbatim Boss text —
  the Boss readline already shows it.
- A player question carries the full pending question attributed to
  the asking player, formatted `<player> asks: <question>`, with no
  glyph. The host renders it as captain speech. It is emitted only
  on entry to `awaitBossReply` (see the `◆` bullet) and carries the
  question verbatim and in full — not truncated — since the judge
  JSON that produced it is hidden.
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
  the error that caused it. On entry to `awaitBossReply` the
  runtime shall emit two lines: first the full pending question as
  the captain-speech act above (`<player> asks: <question>`), so
  the Boss sees exactly what's being asked; then the marker line
  `◆ awaiting Boss reply · <resumeStateId> · <player> ·
  <sourceItem>` carrying the routing metadata with no `q=` excerpt
  rider. The Boss replies with plain text that the runtime
  classifies as `BOSS_REPLY`.

## Host configuration

### PBRT-4

Where CODE runs under tmux-play through the Playbook Captain shell,
the shell's CODE registry entry shall route each player call to the
host player whose `id` equals the runtime's baked player id
(`coder` for Coder, `reviewer` for Reviewer), performing no
player-id remapping.
The host configuration must accordingly point `captain.from` at the
Playbook Captain shell adapter — the published package specifier
`@sublang/playbook/playbook-captain` — and declare `players[].id`
values equal to those baked ids; the CODE registry entry shall
derive the per-run player identity strings (`coderPlayer`,
`reviewerPlayer`) from each player entry's `model` when pinned and
fall back to its `adapter` when no model is set, so the host
configuration shall not be required to repeat them under
`captain.options` and player prompts carry the concrete model
identity (e.g. `claude-opus-4-7`) rather than the adapter family
name (e.g. `claude`) whenever the host has pinned a model.

### PBRT-29

Where CODE runs under tmux-play through the Playbook Captain shell,
CODE-specific runtime options shall be carried under
`captain.options.code` as a namespaced object, and no CODE option
shall be placed elsewhere in the config.
A setting that changes host-observable behavior — theme, layout,
permissions, model or adapter routing, or timing — shall be
expressed through tmux-play's own `captain` / `players` fields
rather than `captain.options.code`.
The Committer alias is not such a setting: tmux-play models no
`Committer` player, so the alias selects which of the two existing
CODE roles the composite `Committer` binds to — CODE-internal role
resolution, not host pane/adapter/model routing — and is therefore
a legitimate `captain.options.code.committer` member. It adds no
tmux-play player and changes no pane's adapter or model; the two
panes keep the `players` adapters they already declare.
The `captain.from` adapter-module path and the `coder` /
`reviewer` `players[].id` values are supplied by the
`playbook-code` composer ([PBCODE-16](playbook-code.md#pbcode-16))
and shall not be required to appear in the user-edited CODE
overlay; this supersedes the user-maintained-invariant framing of
[PBRT-4](#pbrt-4).
The composer-supplied `captain.from` value shall point at the
published Playbook Captain shell adapter specifier
`@sublang/playbook/playbook-captain`, not at a direct CODE adapter;
the public `@sublang/playbook/code/tmux-play` export remains a
compatibility shim for explicit configs.
