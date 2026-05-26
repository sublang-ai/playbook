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
Where `playbook-code` is invoked without `--config`, `--help`, or
`-h`, when the file at the resolved user config path is already
present, the shim shall not modify or overwrite it.
After resolving the user config and applying any required seeding,
the shim shall launch the reference CODE playbook with that config
if the readiness gate passes.

### PBCODE-6

Where `playbook-code` is invoked with `--help` or `-h`, the shim
shall print its own help text to stdout, exit with status `0`, and
shall not seed config, run readiness checks, or launch `tmux-play`.
The help text shall include the resolved user config path, the
auth or CLI setup pointers for known adapters, and an agent-swap
recipe showing that users may change `captain.adapter`,
`captain.model`, each player's `adapter`, and
`captain.options.coderPlayer` / `reviewerPlayer` to match the
chosen player adapters while keeping `captain.from` and `players[].id`
fixed.
Where `playbook-code` is invoked without `--config`, `--help`, or
`-h`, the shim shall run a readiness gate for the adapters declared
in the resolved user config before launching `tmux-play`.
When any declared adapter with a known readiness predicate is not
ready, the shim shall print the same help content to stderr,
additionally include every failing adapter id, exit non-zero with a
status distinct from `127`, and shall not launch `tmux-play`.
When a declared adapter has no known readiness predicate, the shim
shall print one stderr warning for that adapter and shall not block
launch on that adapter.
