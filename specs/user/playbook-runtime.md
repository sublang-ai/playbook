<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBRT: CODE playbook runtime — Boss surface

## Intent

This spec defines the user-visible behavior of the CODE playbook
runtime: how a Boss's turn input is interpreted, what the Boss
observes as a turn progresses, and the host-configuration contract
for running the runtime under tmux-play.

The runtime module and its tmux-play host adapter live at
``; the in-repo path is essential to
the package's intent per [META-15](../meta.md#meta-15). The
tmux-play surface depends on the external `@sublang/cligent`
package. System behavior is in
[dev/playbook-runtime.md](../dev/playbook-runtime.md).

## Turn input

### PBRT-1

When the Boss submits a turn whose text begins with a recognized
slash command, the runtime shall map it to the corresponding FSM
event and extract the trailing text as the event payload:
`/start <intent>` to `START_CODING`; `/continue <#>` and
`/summarize <#>` to `CONTINUE_IR` and `SUMMARIZE_IR`;
`/interrupt <stateId> [intent]` to `BOSS_INTERRUPT` with the first
token as the target state and any remaining text as the intent.

### PBRT-2

When the Boss submits turn text that is not a recognized slash
command, the runtime shall classify it into one FSM event by
consulting the judge. When the text is an unrecognized slash
command, an `/interrupt` command with no target state, or text
the judge does not resolve to a valid event, the runtime shall
report the reason to the Boss and take no FSM action. When the
text is empty or whitespace-only, the runtime shall take no FSM
action. The `/start`, `/continue`, and `/summarize` commands
shall map to their event even when their payload is empty.

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
- `◆` for entry into the idle state, the failure state, and the
  terminal state. On entry to the failure state the line shall
  additionally carry the error that caused it.

## Host configuration

### PBRT-4

Where the runtime runs under tmux-play, the adapter shall route
each player call to the host role whose `id` equals the runtime's
baked player id (`coder` for Coder, `reviewer` for Reviewer),
performing no role-id remapping. The host configuration must
accordingly point `captain.from` at the adapter module, declare
`roles[].id` values equal to those baked ids, and supply the
per-run player identity strings (`coderPlayer`, `reviewerPlayer`)
under `captain.options`.
