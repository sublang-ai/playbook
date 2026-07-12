<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCLI: generic playbook CLI

## Intent

This spec defines the user-facing behavior of the generic `playbook`
command shipped by the `@sublang/playbook` npm package, including
global installs and one-shot `npx` invocations.
The `playbook` command enables one or more playbooks through a single
top-level config and launches them under the Playbook Captain shell
([CAPTAIN](playbook-captain.md)) on cligent's tmux-play.
The references to `@sublang/playbook` and its `playbook-captain` and
`code/registry` modules are essential to this package's intent per
[META-15](../meta.md#meta-15).

## Command

### PBCLI-1

Where `@sublang/playbook` is installed, the package shall expose a
`playbook` executable.
When the user invokes `playbook` without `--config`, `--help`, `-h`,
or `--list`, the command shall resolve its top-level config (seeding
it when absent per [PBCLI-3](#pbcli-3)), compose a tmux-play config
whose Captain is `@sublang/playbook/playbook-captain`
([PBCLI-8](../dev/playbook-cli.md#pbcli-8)), run the launcher-owned
adapter readiness gate ([PBCLI-12](../dev/playbook-cli.md#pbcli-12)),
and, when readiness passes, launch cligent's `tmux-play` with that
composed config and with stdin, stdout, and stderr inherited from the
caller, forwarding every other user-supplied argument verbatim.
When the user supplies `--config <path>`, the command shall launch
`tmux-play` with that path as a raw tmux-play config directly,
bypassing config seeding, composition, and the readiness gate, and
shall not add another config argument.

### PBCLI-2

When the launched tmux-play process exits, `playbook` shall exit with
the same status code, or re-raise the same signal on itself if that
process was terminated by a signal.
When `playbook` cannot launch tmux-play at all, it shall print a
diagnostic to stderr and exit with code 127.

### PBCLI-3

Where `playbook` is invoked without `--config`, the command shall
resolve its top-level config path as
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`.
Where `playbook` is invoked without `--config`, `--help`, or `-h`,
when the file at the resolved path is absent, the command shall create
it from the bundled starter generic config, creating parent
directories as needed, print one stderr line naming the resolved path,
and then continue with that seeded config.
The seeded starter config shall enable CODE through an explicit
`playbooks.code.from` set to `@sublang/playbook/code/registry` and
carry the default agent lineup defined by
[PBCLI-11](../dev/playbook-cli.md#pbcli-11).
When the file at the resolved path is already present, the command
shall use it unchanged and shall not reseed or overwrite it.

### PBCLI-4

Where the user authors the top-level generic config, the config shall
keep tmux-play host fields at the top level and shall not wrap
`profiles`, `playbooks`, `captain`, `layout`, `notifications`, or
`theme` in a `config:` key.
The config shall declare enabled playbooks under a top-level
`playbooks` map and reusable agent settings under an optional
top-level `profiles` map, and shall not declare a top-level `players`
roster.
Within a `playbooks.<id>` block, `from`, `command`, and `players` are
launcher-owned keys and every other key (such as CODE's `committer`)
is that playbook's option slice; `from` is the explicit registry
module specifier, `command` optionally overrides the playbook's
default slash command, and the `<id>` key shall be the enabled
playbook's own id, matching the registry module's manifest `id`.
The enabled playbook id and effective command shall not equal the reserved
internal name `captain`.
A scalar `captain` value or a scalar `players.<role>` value shall name
either a profile id from `profiles` or an adapter shorthand such as
`claude` or `codex`; a full `captain` or `players.<role>` block shall
follow the host tmux-play agent-block schema and may carry an optional
`profile` key naming a `profiles` entry, whose settings the launcher
applies beneath the block's own explicit fields.

### PBCLI-5

When the user invokes `playbook --list`, the command shall print each
configured playbook's id, effective command, and intent, and shall not
launch tmux-play.
The effective command shall be the `playbooks.<id>` block's `command`
override when present and the registry entry's default command
otherwise.

### PBCLI-6

When the user invokes `playbook` with `--help` or `-h`, the command
shall print its own help text to stdout, exit with status `0`, and
shall not seed config, compose, run readiness checks, or launch
tmux-play.
The help text shall include the resolved top-level config path, the
auth or CLI setup pointers for known adapters, and an agent-swap
recipe showing that users may retune `profiles`, the top-level
`captain`, and each `playbooks.<id>.players` map.
When the readiness gate ([PBCLI-12](../dev/playbook-cli.md#pbcli-12))
blocks a launch, the command shall print the same help content to
stderr, additionally name every failing adapter id, exit non-zero with
a status distinct from `127`, and shall not launch tmux-play.
