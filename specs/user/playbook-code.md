<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCODE: playbook-code CLI

## Intent

This spec defines the user-facing behavior of the `playbook-code`
command shipped by the `@sublang/playbook` npm package, including
global installs and one-shot `npx` invocations.

## Command

### PBCODE-1

Where `@sublang/playbook` is installed globally, the package
shall expose a `playbook-code` executable.
When the user invokes `playbook-code` without `--help` or `-h`,
and the invocation is not stopped by a readiness failure under
[PBCODE-6](#pbcode-6), the shim shall start the reference CODE
playbook by invoking cligent's `tmux-play` with stdin, stdout, and
stderr inherited from the caller and shall forward every
user-supplied command-line argument verbatim to it.
When the user supplies `--config <path>`, the shim shall use that
path as the runtime config, shall not add another runtime config
argument, and shall bypass the user-config seeding and readiness
gate defined in [PBCODE-5](#pbcode-5) and [PBCODE-6](#pbcode-6).

### PBCODE-2

When the CODE playbook process exits, `playbook-code` shall exit
with the same status code, or re-raise the same signal on itself
if that process was terminated by a signal; when it cannot launch
the playbook at all, it shall print a diagnostic to stderr and
exit with code 127.

### PBCODE-5

Where `playbook-code` is invoked without `--config`, the shim
shall resolve its user config path as
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook-code.config.yaml`.
Where `playbook-code` is invoked without `--config`, `--help`, or
`-h`, when the file at the resolved user config path is absent, the
shim shall create it from the bundled template, creating parent
directories as needed, and shall print one stderr line naming the
resolved path.
The seeded template shall carry the default Captain, Coder, Reviewer,
and Committer-alias settings defined by
[PBCODE-7](../dev/playbook-code.md#pbcode-7).
Where `playbook-code` is invoked without `--config`, `--help`, or
`-h`, when the file at the resolved user config path is already
present and already has a top-level `notifications` block, the shim
shall not modify or overwrite it.
Where `playbook-code` is invoked without `--config`, `--help`, or
`-h`, when the file at the resolved user config path is already
present and either parses to a YAML mapping that lacks a top-level
`notifications` block or contains no YAML document, the shim shall
update that file in place by adding
`notifications: { player_finished: bell, turn_finished: desktop }`
as the tmux-play host notification defaults, and shall print one
stderr line naming the resolved path.
Where `playbook-code` is invoked without `--config`, `--help`, or
`-h`, when the file at the resolved user config path is already
present but fails YAML parsing or parses to a YAML scalar or
sequence, the shim shall leave that file unchanged and shall not run
the notification migration.
The resolved user config is the CODE overlay (the composer input
of [PBCODE-16](#pbcode-16)), not the config launched directly.
After resolving the user config and applying any required seeding
or migration, the shim shall compose the launched config from it per
[PBCODE-16](#pbcode-16) and launch the reference CODE playbook with
the composed config if the readiness gate passes.

### PBCODE-6

Where `playbook-code` is invoked with `--help` or `-h`, the shim
shall print its own help text to stdout, exit with status `0`, and
shall not seed config, run readiness checks, or launch `tmux-play`.
The help text shall include the resolved user config path, the
auth or CLI setup pointers for known adapters, and an agent-swap
recipe showing that users may change the judge's `captain.adapter`
and `captain.model` and each role's `adapter` and `model` under
`players.coder` / `players.reviewer` (the specific model id; the
substitution into `<coder-llm>` / `<reviewer-llm>` player prompts
uses `model` when pinned and `adapter` otherwise). The overlay
carries no `captain.from` (the composer injects it) and the role
keys `coder` / `reviewer` are fixed. The recipe shall not name
`captain.options.coderPlayer` / `reviewerPlayer`, since the
adapter derives those identity strings from each role's `model`
(or `adapter` when no model is pinned) per
[PBRT-4](playbook-runtime.md#pbrt-4).
Where `playbook-code` is invoked without `--config`, `--help`, or
`-h`, the shim shall run a readiness gate for the adapters in the
composed config ([PBCODE-16](#pbcode-16)) — including any
captain-judge adapter inherited from a base config — before
launching `tmux-play`.
When any declared adapter with a known readiness predicate is not
ready, the shim shall print the same help content to stderr,
additionally include every failing adapter id, exit non-zero with a
status distinct from `127`, and shall not launch `tmux-play`.
When a declared adapter has no known readiness predicate, the shim
shall print one stderr warning for that adapter and shall not block
launch on that adapter.

## Composition

### PBCODE-16

The CODE overlay is a YAML config of the tmux-play shape with two
differences: it omits `captain.from`, and its `players` is a
mapping keyed by the role names `coder` and `reviewer` rather than
an array of entries with an `id`.
Its `captain` block holds the judge fields: `captain.adapter` is
required in the composed config but may be omitted from the overlay
when a base config supplies it, while `model`, `reasoningEffort`,
and `permissions` are optional.
Each `players.<role>` block holds that role's `adapter` (required,
not inherited) and optional `model`, `reasoningEffort`,
`permissions`; CODE options, if any, live under
`captain.options.code`; optional top-level `theme`, `layout`, and
`notifications` blocks may be set. The `layout` block (window size
and column weights) and `notifications` block (maps notification
events to `off`, `bell`, or `desktop` sinks) are host-observable
tmux-play fields, not CODE options; the composer carries them
through to the composed config without interpreting them.
The `players` mapping may additionally carry an optional
`committer` key — the Committer alias — whose value is a string
naming an existing role, `coder` or `reviewer`. It is a reference,
not a player block: it declares no `adapter` and adds no pane,
selecting only which existing role runs the commit. An unknown
target is rejected with a path-named error (`players.committer`).
`players.committer` is the only overlay surface for the alias: the
composer is the sole writer of the composed
`captain.options.code.committer`, so an overlay that sets
`captain.options.code.committer` directly is rejected with a
path-named error rather than carried through.
Where `playbook-code` is invoked without `--config`, the shim
shall compose the runtime config rather than launch the overlay
directly: it shall inject `captain.from` =
`@sublang/playbook/playbook-captain`, the Playbook Captain shell
adapter module with CODE registered;
convert the `players` mapping into a `players[]` array, one entry
per role with `id` set to the role key (`coder`, `reviewer`) and
that role's `adapter`, `model`, `reasoningEffort`, and
`permissions` copied across (the `coder` and `reviewer` roles
only; the `committer` alias is resolved, not rostered); carry the
overlay's `captain.options.code` through, resolving any
`players.committer` alias into `captain.options.code.committer`
(the named role id) without emitting a `players[]` entry for it;
carry the overlay's top-level `layout` or `notifications` block
through unchanged; materialize the composed config to
a temporary file; launch `tmux-play --config <temp>`; and remove
the temporary file before the shim exits — on normal exit, on
non-zero child exit, and before re-raising a forwarded signal per
[PBCODE-2](#pbcode-2).
Where an existing base tmux-play config is present, the shim shall
inherit from it only the `theme`, the top-level `layout` and
`notifications` blocks, and any captain-judge `adapter`, `model`,
`reasoningEffort`, and `permissions` the overlay leaves unset, and
shall not map the base `players[]` roster onto `coder` /
`reviewer`.
An inherited `layout` is adapted to CODE's `coder` + `reviewer`
panes rather than copied verbatim, since a base config's `layout` is
recorded against that config's own players: the base's
initial-visible-pane selection is dropped so CODE starts with its
full set of panes, while the window size and column weights are
preserved. An inherited `notifications` block is carried whole.
For `layout` and `notifications`, precedence shall be whole-block:
when the overlay sets either block, that block replaces the base
block rather than merging nested layout fields or notification event
keys.
When neither the overlay nor a base config supplies
`captain.adapter`, composition shall fail with a path-named error
(`captain.adapter`).
When the user supplies `--config <path>`, the shim shall bypass
composition and launch that path directly per
[PBCODE-1](#pbcode-1).
