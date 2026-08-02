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
Its `run` subcommand ([PBCLI-18](#pbcli-18)) runs a single playbook
once, non-interactively and without tmux-play, and does not require the
playbook to be enabled in config.
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
`playbooks`, `captain`, `layout`, `notifications`, or `theme` in a
`config:` key.
The config shall declare enabled playbooks under a top-level
`playbooks` map, and shall declare neither a top-level `players`
roster nor a top-level `profiles` map
([DR-021](../decisions/021-inline-agent-settings.md)).
Within a `playbooks.<id>` block, `from`, `command`, and `players` are
launcher-owned keys and every other key (such as CODE's `committer`)
is that playbook's option slice; `from` is the explicit registry
module specifier, `command` optionally overrides the playbook's
default slash command, and the `<id>` key shall be the enabled
playbook's own id, matching the registry module's manifest `id`.
The enabled playbook id and effective command shall not equal the reserved
internal name `captain`.
A scalar `captain` value or a scalar `players.<role>` value shall name
an adapter shorthand such as `claude` or `codex`; a full `captain` or
`players.<role>` block shall follow the host tmux-play agent-block
schema and shall carry its own settings — `adapter`, and as needed
`model`, `effort`, and `permissions` — so each agent is tunable
without affecting another.
A config that still carries a top-level `profiles` map or an agent-block
`profile` key shall be migrated in place on the next launch, with the
pre-migration file kept beside it as a `.bak`
([PBCLI-33](../dev/playbook-cli.md#pbcli-33)).

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
recipe showing that users may retune the top-level `captain` and each
`playbooks.<id>.players` map in place.
When the readiness gate ([PBCLI-12](../dev/playbook-cli.md#pbcli-12))
blocks a launch, the command shall print the same help content to
stderr, additionally name every failing adapter id, exit non-zero with
a status distinct from `127`, and shall not launch tmux-play.

## Non-interactive run

### PBCLI-18

When the user invokes `playbook run <from> [task]`, the command shall
run the one playbook exported by module `<from>` a single time, without
tmux-play and without requiring a `playbooks.<id>` config block.
`<from>` is a registry module specifier (a bare package subpath, a file
path, or a `file:` URL); `[task]` is the Boss intent, read from stdin
when the argument is omitted.
The argument list shall support a `--` end-of-options terminator:
every argument after `--` is positional, so a task or reply that
begins with `-` can be passed on the command line, and the `run` help
text shall name the terminator.
The command shall load the registry entry, bind its required roles and
a captain agent ([PBCLI-19](#pbcli-19)), drive one Boss turn to a
terminal outcome, print that outcome to stdout, and exit `0`.
It shall print progress to stderr and, with `--json`, print one JSON
envelope to stdout carrying the `outcome`, the playbook `sessionId`,
and the outcome's payload — the terminal `output`, or the pending
`questions` on a parked run ([PBCLI-22](#pbcli-22)) — rather than the
plain text.
On a failed or aborted turn the command shall print the error to stderr
and exit `2`.
When the playbook parks awaiting a Boss reply and the runtime supports
durable sessions, the command shall print each pending question's text
to stdout, persist the parked session, print one stderr hint naming the
session id and the exact resume command, and exit `3`
([PBCLI-22](#pbcli-22)); when the playbook suspends for a nested
playbook call — which a one-shot run cannot answer — or parks without a
persistable session, it shall print a diagnostic and exit `3`.
An invalid `<from>`, a module exposing no valid registry entry, or a
malformed argument shall print a diagnostic and exit `1`.
`playbook run --help` and `playbook run -h` shall print `run` usage —
including the `resume` form — and exit `0`.

### PBCLI-19

Where `playbook run` binds agents, every required role and the captain
shall default to adapter `claude`, unless the user config supplies a
run default for it ([PBCLI-28](#pbcli-28)).
`--player <role>=<agent>` shall bind a required role and `--captain
<agent>` shall set the captain agent, where `<agent>` is
`<adapter>[:<model>][@<effort>]` — an adapter shorthand such as
`claude` or `codex`, optionally followed by a colon and a model (which
may itself contain colons), optionally followed by `@` and an
adapter-scoped reasoning effort; `claude@high` shall select the
adapter's default model while still setting effort, and an `@` with an
empty effort shall be rejected.
`--option <key>=<value>` shall supply the playbook's option slice (such
as CODE's `committer=coder`), and `--cwd <dir>` shall set the agents'
working directory, defaulting to the process working directory.
The command shall validate every supplied effort against the adapter's
supported values before running any agent; an unsupported effort shall
exit `1` with a diagnostic naming the supported values.
A parked session shall store each agent spec as bound — adapter,
optional model, optional effort — and a resume shall rebuild that exact
lineup ([PBCLI-22](#pbcli-22)).
A `--player` role that the entry does not require, or an unresolvable
adapter, shall exit `1` with a path-named diagnostic.

### PBCLI-36

Where `playbook run` loads a filesystem `<from>` module (a relative or
absolute path or a `file:` URL) whose engine imports — `xstate` and
`@sublang/playbook/xstate-runtime` — do not resolve from the module's
own directory, the command shall provision them before loading
([DR-024](../decisions/024-runtime-engine-provisioning.md)): it shall
create `node_modules/xstate` and `node_modules/@sublang/playbook`
beside the module as symbolic links to the running host's own installed
packages and print one stderr line naming each created link and its
target.
Where both imports already resolve, the command shall create and change
nothing — an existing project-local installation always wins — and a
repeated run over a provisioned directory shall likewise create nothing
further and print no provisioning line.
`--no-provision` shall disable provisioning on first runs and on
`resume`; an unresolvable import then surfaces as the ordinary load
diagnostic with exit `1` ([PBCLI-18](#pbcli-18)).
Where a `package.json` at or above the module's directory declares
`@sublang/playbook` among its dependencies while the import does not
resolve, the command shall not provision: it shall print a diagnostic
recommending the project's own dependency install and exit `1`.
Where a previously provisioned link's target no longer exists, the
command shall replace the dangling link when provisioning is enabled
and shall otherwise print a diagnostic naming the stale link and its
missing target; a real (non-symlink) file or directory occupying either
link path shall never be removed or overwritten — provisioning shall
instead refuse with a diagnostic naming the occupied path and exit `1`.

### PBCLI-22

Where a `playbook run` turn parked awaiting a Boss reply and persisted
its session ([PBCLI-18](#pbcli-18)), when the user invokes
`playbook run resume <session-id> [reply]`, the command shall continue
that session with the reply as the next Boss turn, using the agent
bindings, option slice, and working directory stored with the session.
`playbook run resume --last [reply]` shall select the most recently
updated persisted session instead of naming one; `[reply]` is read from
stdin when the argument is omitted, like `[task]`.
A terminal outcome shall print the output to stdout, remove the
persisted session, and exit `0`; a turn that parks again for another
Boss reply shall update the persisted session, print the new question(s)
and hint per [PBCLI-18](#pbcli-18), and exit `3`; a failed or aborted
turn shall keep the persisted session, print the error to stderr, and
exit `2`.
`--json` and `--verbose` apply as on a first run.
An unknown or malformed session id, `--last` with no persisted session,
a persisted session the current module can no longer resume, or a
`--player`, `--captain`, `--option`, or `--cwd` flag on `resume` —
bindings are stored with the session — shall print a diagnostic and
exit `1`.

### PBCLI-28

Where the config file at the resolved top-level path
([PBCLI-3](#pbcli-3)) carries a top-level `run` map, when
`playbook run` binds agents for a first run, the command shall default
each required role to the agent named by `run.players.<role>`, falling
back to the `run.player` catch-all when that key is absent, and shall
default the captain to `run.captain`; a role or captain that no `run`
key covers shall keep the built-in `claude` default, and a `--player`
or `--captain` flag ([PBCLI-19](#pbcli-19)) shall override the config
default for its role or the captain.
Each `run.captain`, `run.player`, and `run.players.<role>` value shall
be an `<adapter>[:<model>][@<effort>]` agent string with the exact
[PBCLI-19](#pbcli-19) grammar and validation.
A `run.players` key naming a role the loaded entry does not require
shall be ignored without a diagnostic — the config is global across
playbooks — unlike an unrequired `--player` flag, which stays an
error.
When the config file is absent or carries no `run` map, the command
shall keep the built-in `claude` defaults.
An unparseable config file, a `run` or `run.players` value that is not
a map, a non-string agent value, an invalid agent string, or an
unsupported effort shall print a diagnostic and exit `1` before any
agent runs.
`playbook run resume` shall not read the `run` map: a resumed session
rebuilds the lineup stored with it ([PBCLI-22](#pbcli-22)).

## Adapter SDK availability

### PBCLI-40

The agent SDK backing each adapter is an optional peer dependency
([RELEASE-12](../dev/release.md#release-12)), so an install carries only
the agent stacks the user asked for and an unconfigured vendor's stack
is never downloaded.

Where `playbook` runs the readiness gate ([PBCLI-1](#pbcli-1)) or binds
agents for `playbook run` ([PBCLI-18](#pbcli-18)), when a declared
adapter's SDK is not loadable, the command shall block before launching
tmux-play or making any agent call, print to stderr a line naming every
such adapter and, for each, the exact command that supplies it, and
exit non-zero with a status distinct from `127`.
For an installed tree, that command is `npm install -g <sdk>`, plus the
global install of any external CLI the adapter's availability probe
also requires.
Where the running installation is npm's ephemeral exec tree (`npx` /
`npm exec`), no install command reaches the tree the adapters resolve
from, so the command shall instead be one multi-package re-run naming
the running package at its own version and, as sibling `-p` packages,
the SDK of **every** mapped adapter the lineup requires — not only the
missing ones: a fresh exec tree starts empty, and a missing-only list
drops the SDKs this tree does have, alternating between vendors
forever.
The re-run shall end with the original invocation's arguments, quoted
where the shell requires it, so the printed command is executable
exactly as printed and completes in one hop; it shall never carry
placeholder text such as a literal `...`, which the launch surfaces
reject as an argument.
Where `playbook run` consumed its task, or `run resume` its reply,
from stdin before the gate fired, the re-run shall carry that resolved
input appended behind a `--` end-of-options terminator
([PBCLI-18](#pbcli-18)), quoted — the pipe that supplied it will not
exist when the printed command runs, and quoting alone cannot keep a
flag-shaped value such as `--json`, `--last`, or a `-`-leading bullet
from being reinterpreted as an option on the replay.
Where the original invocation itself already activated a terminator —
one the parser treated as end-of-options, not a `--` consumed as an
option's value — the re-run shall reuse it rather than append a
second: parsing stops at the first `--`, so a doubled terminator is
itself positional data and turns a `--json` task into `-- --json`.
External CLI installs stay global, because the exec tree inherits
`PATH`, and shall be printed **before** the re-run: the re-run probes
the CLI again, so following the output top-to-bottom must install it
first.

This check is independent of the credential check
([PBCLI-12](../dev/playbook-cli.md#pbcli-12)): a missing SDK and a
missing credential are separate failures with separate remedies, and
where both apply the command shall report both rather than only the
first.
A raw `--config <path>` launch bypasses this check along with the rest
of the gate ([PBCLI-1](#pbcli-1)).

## Config overlays

### PBCLI-25

Where the user invokes `playbook` without `--config`, when the
invocation carries one or more `--with <path>` flags, the command shall
load each file as a YAML fragment in the top-level generic-config
format ([PBCLI-4](#pbcli-4)), merge the fragments over the resolved —
and, when absent, freshly seeded ([PBCLI-3](#pbcli-3)) — top-level
config in argument order, and use the merged config for composition,
`--list`, and the readiness gate.
Merging shall be recursive for maps and replacement for every other
value (scalars, sequences, and `null`), so a later fragment or the
fragment side of any non-map collision wins.
`--with` and its value are launcher-owned, extending the launcher-owned
argument set of [PBCLI-1](#pbcli-1): the command shall consume them and
shall not forward them to tmux-play.
An overlaid launch shall leave the global config file unchanged.
A `--with` flag combined with `--config`, a missing or unreadable
fragment, an unparseable fragment, or a fragment that is not a YAML map
shall print a diagnostic and exit `1` without launching tmux-play.
