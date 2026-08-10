<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook-cli: Playbook CLI

## Intent

This package specifies the generic `playbook` launcher and non-interactive `playbook run` command, their configuration and provisioning behavior, and integration verification.

## External Behavior

### Command

#### playbook-cli-1

Where `@sublang/playbook` is installed, the package shall expose a
`playbook` executable.
When the user invokes `playbook` without `--config`, `--help`, `-h`,
or `--list`, the command shall resolve its top-level config (seeding
it when absent per [[playbook-cli-3](#playbook-cli-3)]), compose a tmux-play config
whose Captain is `@sublang/playbook/playbook-captain`
([[playbook-cli-8](playbook-cli.md#playbook-cli-8)]), run the launcher-owned
adapter readiness gate ([[playbook-cli-12](playbook-cli.md#playbook-cli-12)]),
and, when readiness passes, launch cligent's `tmux-play` with that
composed config and with stdin, stdout, and stderr inherited from the
caller, forwarding every other user-supplied argument verbatim.
When the user supplies `--config <path>`, the command shall launch
`tmux-play` with that path as a raw tmux-play config directly,
bypassing config seeding, composition, and the readiness gate, and
shall not add another config argument.

#### playbook-cli-2

When the launched tmux-play process exits, `playbook` shall exit with
the same status code, or re-raise the same signal on itself if that
process was terminated by a signal.
When `playbook` cannot launch tmux-play at all, it shall print a
diagnostic to stderr and exit with code 127.

#### playbook-cli-3

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
[[playbook-cli-11](playbook-cli.md#playbook-cli-11)].
When the file at the resolved path is already present, the command
shall use it unchanged and shall not reseed or overwrite it.

#### playbook-cli-4

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
([[playbook-cli-33](playbook-cli.md#playbook-cli-33)]).

#### playbook-cli-5

When the user invokes `playbook --list`, the command shall print each
configured playbook's id, effective command, and intent, and shall not
launch tmux-play.
The effective command shall be the `playbooks.<id>` block's `command`
override when present and the registry entry's default command
otherwise.

#### playbook-cli-6

When the user invokes `playbook` with `--help` or `-h`, the command
shall print its own help text to stdout, exit with status `0`, and
shall not seed config, compose, run readiness checks, or launch
tmux-play.
The help text shall include the resolved top-level config path, the
auth or CLI setup pointers for known adapters, and an agent-swap
recipe showing that users may retune the top-level `captain` and each
`playbooks.<id>.players` map in place.
When the readiness gate ([[playbook-cli-12](playbook-cli.md#playbook-cli-12)])
blocks a launch, the command shall print the same help content to
stderr, additionally name every failing adapter id, exit non-zero with
a status distinct from `127`, and shall not launch tmux-play.

### Non-interactive run

#### playbook-cli-18

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
a captain agent ([[playbook-cli-19](#playbook-cli-19)]), drive one Boss turn to a
terminal outcome, print that outcome to stdout, and exit `0`.
It shall print progress to stderr and, with `--json`, print one JSON
envelope to stdout carrying the `outcome`, the playbook `sessionId`,
and the outcome's payload — the terminal `output`, or the pending
`questions` on a parked run ([[playbook-cli-22](#playbook-cli-22)]) — rather than the
plain text.
On a failed or aborted turn the command shall print the error to stderr
and exit `2`.
When the playbook parks awaiting a Boss reply and the runtime supports
durable sessions, the command shall print each pending question's text
to stdout, persist the parked session, print one stderr hint naming the
session id and the exact resume command, and exit `3`
([[playbook-cli-22](#playbook-cli-22)]); when the playbook suspends for a nested
playbook call — which a one-shot run cannot answer — or parks without a
persistable session, it shall print a diagnostic and exit `3`.
An invalid `<from>`, a module exposing no valid registry entry, or a
malformed argument shall print a diagnostic and exit `1`.
`playbook run --help` and `playbook run -h` shall print `run` usage —
including the `resume` form — and exit `0`.

#### playbook-cli-19

Where `playbook run` binds agents, every required role and the captain
shall default to adapter `claude`, unless the user config supplies a
run default for it ([[playbook-cli-28](#playbook-cli-28)]).
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
lineup ([[playbook-cli-22](#playbook-cli-22)]).
A `--player` role that the entry does not require, or an unresolvable
adapter, shall exit `1` with a path-named diagnostic.

#### playbook-cli-36

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
diagnostic with exit `1` ([[playbook-cli-18](#playbook-cli-18)]).
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

#### playbook-cli-22

Where a `playbook run` turn parked awaiting a Boss reply and persisted
its session ([[playbook-cli-18](#playbook-cli-18)]), when the user invokes
`playbook run resume <session-id> [reply]`, the command shall continue
that session with the reply as the next Boss turn, using the agent
bindings, option slice, and working directory stored with the session.
`playbook run resume --last [reply]` shall select the most recently
updated persisted session instead of naming one; `[reply]` is read from
stdin when the argument is omitted, like `[task]`.
A terminal outcome shall print the output to stdout, remove the
persisted session, and exit `0`; a turn that parks again for another
Boss reply shall update the persisted session, print the new question(s)
and hint per [[playbook-cli-18](#playbook-cli-18)], and exit `3`; a failed or aborted
turn shall keep the persisted session, print the error to stderr, and
exit `2`.
`--json` and `--verbose` apply as on a first run.
An unknown or malformed session id, `--last` with no persisted session,
a persisted session the current module can no longer resume, or a
`--player`, `--captain`, `--option`, or `--cwd` flag on `resume` —
bindings are stored with the session — shall print a diagnostic and
exit `1`.

#### playbook-cli-28

Where the config file at the resolved top-level path
([[playbook-cli-3](#playbook-cli-3)]) carries a top-level `run` map, when
`playbook run` binds agents for a first run, the command shall default
each required role to the agent named by `run.players.<role>`, falling
back to the `run.player` catch-all when that key is absent, and shall
default the captain to `run.captain`; a role or captain that no `run`
key covers shall keep the built-in `claude` default, and a `--player`
or `--captain` flag ([[playbook-cli-19](#playbook-cli-19)]) shall override the config
default for its role or the captain.
Each `run.captain`, `run.player`, and `run.players.<role>` value shall
be an `<adapter>[:<model>][@<effort>]` agent string with the exact
[[playbook-cli-19](#playbook-cli-19)] grammar and validation.
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
rebuilds the lineup stored with it ([[playbook-cli-22](#playbook-cli-22)]).

### Adapter SDK availability

#### playbook-cli-40

The agent SDK backing each adapter is an optional peer dependency
([[release-12](release.md#release-12)]), so an install carries only
the agent stacks the user asked for and an unconfigured vendor's stack
is never downloaded.

Where `playbook` runs the readiness gate ([[playbook-cli-1](#playbook-cli-1)]) or binds
agents for `playbook run` ([[playbook-cli-18](#playbook-cli-18)]), when a declared
adapter's runtime is not loadable or is installed below the version
cligent supports, the command shall block before launching tmux-play or
making any agent call, print to stderr a line naming every such adapter
and, for each affected runtime, the exact command that supplies it, and
exit non-zero with a status distinct from `127`.
An absent runtime shall be reported as not installed; a runtime
installed below cligent's floor shall be reported as unsupported with
its installed and required versions, and shall not be reported as
absent, because that sends the user to install what is already present.
For an installed tree, the remedy is `npm install -g <spec>` where
`<spec>` is cligent's pinned repair specifier for that runtime, so a
printed repair installs a version the gate accepts; only the runtimes
at fault are named.
Where the running installation is npm's ephemeral exec tree (`npx` /
`npm exec`), no install command reaches the tree the adapters resolve
from, so the command shall instead be one multi-package re-run naming
the running package at its own version and, as sibling `-p` packages,
the pinned repair specifier of **every** descriptor-backed adapter the
lineup requires — not only the
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
([[playbook-cli-18](#playbook-cli-18)]), quoted — the pipe that supplied it will not
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
([[playbook-cli-12](playbook-cli.md#playbook-cli-12)]): a missing SDK and a
missing credential are separate failures with separate remedies, and
where both apply the command shall report both rather than only the
first.
A raw `--config <path>` launch bypasses this check along with the rest
of the gate ([[playbook-cli-1](#playbook-cli-1)]).

### Config overlays

#### playbook-cli-25

Where the user invokes `playbook` without `--config`, when the
invocation carries one or more `--with <path>` flags, the command shall
load each file as a YAML fragment in the top-level generic-config
format ([[playbook-cli-4](#playbook-cli-4)]), merge the fragments over the resolved —
and, when absent, freshly seeded ([[playbook-cli-3](#playbook-cli-3)]) — top-level
config in argument order, and use the merged config for composition,
`--list`, and the readiness gate.
Merging shall be recursive for maps and replacement for every other
value (scalars, sequences, and `null`), so a later fragment or the
fragment side of any non-map collision wins.
`--with` and its value are launcher-owned, extending the launcher-owned
argument set of [[playbook-cli-1](#playbook-cli-1)]: the command shall consume them and
shall not forward them to tmux-play.
An overlaid launch shall leave the global config file unchanged.
A `--with` flag combined with `--config`, a missing or unreadable
fragment, an unparseable fragment, or a fragment that is not a YAML map
shall print a diagnostic and exit `1` without launching tmux-play.

### Resolution

#### playbook-cli-7

Where `playbook` is installed globally, when the command starts, it shall resolve cligent's `tmux-play` CLI from `@sublang/playbook`'s own dependency tree without requiring a top-level executable on `PATH`, and `package.json` shall declare the Node `>=20.6.0` compatibility floor required by that resolution.

### Composition

#### playbook-cli-8

Where `playbook` composes the runtime config
([[playbook-cli-1](playbook-cli.md#playbook-cli-1)]), the command shall
normalize the top-level `playbooks` map into a
tmux-play config whose `captain.from` is
`@sublang/playbook/playbook-captain` and whose
`captain.options.playbooks` holds one normalized entry per enabled
playbook.
The command shall also set `captain.options.captainAdapter` to the resolved
captain agent's adapter, which the shell cannot otherwise read from the
tmux-play Captain context and needs to decide whether an explicit empty tool
allowlist can be enforced
([DR-013](../decisions/013-routing-only-captain-control.md) A1).
Each normalized `captain.options.playbooks.<id>` entry shall carry the
`playbooks.<id>` block's `from`, its optional `command`, and an
`options` slice built from every non-launcher key of the block (such
as CODE's `committer`); `from`, `command`, and `players` shall not
appear in the option slice.
The command shall resolve a scalar `captain` or `players.<role>` value
as an adapter shorthand, and a full block as a self-contained tmux-play
agent block carried through as authored
([DR-021](../decisions/021-inline-agent-settings.md)).
Before composing, the command shall reject — with a path-named
diagnostic naming the offending key and the inline replacement, and
without launching — a top-level `profiles` map or any `captain` /
`players.<role>` block carrying a `profile` key that survives the
[[playbook-cli-33](#playbook-cli-33)] migration, such as one introduced by a `--with`
overlay, because a scalar that formerly named a profile now reads as an
adapter shorthand and would otherwise fail far downstream as an unknown
adapter.

#### playbook-cli-9

Where `playbook` composes the runtime config, the command shall
generate the top-level tmux-play `players` roster as the launch-time
union of every enabled playbook's players, binding local role
`<role>` of playbook `<id>` to a host player whose `id` is
`<id>-<role>`, where `<id>` is the `playbooks.<id>` config key.
When two playbooks bind agents with identical settings, the command
shall still emit separate playbook-scoped host players.
The generated config shall not bind a playbook's role to a player from
another playbook or to a shared top-level host player.
The command shall import each enabled playbook's `from` module to read
its registry entry manifest
([[playbook-captain-5](playbook-captain.md#playbook-captain-5)]) and, before launching
tmux-play, shall reject — with a diagnostic and without launching — a
missing `from`, a failed import, a module exposing no valid registry
entry, a `playbooks.<id>` config key that does not equal the imported
manifest's `id`, two playbooks sharing an `id`, two playbooks
resolving to the same effective command, an enabled playbook id or effective
command equal to the reserved internal name `captain`, a local role id `captain` in
a manifest's `requiredRoleIds` or a `playbooks.<id>.players` map —
`captain` is reserved for the tmux-play host Captain, and the
diagnostic shall name whether the reserved collision is an internal playbook
name or player role — a manifest `requiredRoleIds`
entry that does not resolve to a generated roster id, or an enabled
playbook that resolves no visible local role.
At runtime `init` the Playbook Captain shell re-validates only the
loading checks it shares with
[[playbook-captain-16](playbook-captain.md#playbook-captain-16)] — missing `from`, failed
import, invalid entry, key / manifest-`id` mismatch, duplicate id, and
duplicate effective command, plus the reserved playbook id and effective
command.
The roster-resolution, reserved-role, and visible-role checks above
are launcher-owned
([DR-009](../decisions/009-generic-playbook-cli-and-registry.md) §4);
the shell relies on that validation and treats any residual
`setVisiblePlayers` rejection as an internal or composition error
([[playbook-captain-22](playbook-captain.md#playbook-captain-22)]) rather than
re-validating the roster itself.

#### playbook-cli-10

Where `playbook` composes the runtime config, the command shall set
the composed tmux-play `layout.initialVisible` to the generated host
player ids of the first enabled playbook in config order, and shall
own that field even when the user config sets other `layout` fields.
The command shall carry through the user config's tmux-play `layout`
window size and column-weight fields, including cligent's
`singlePlayerColumnWeights` and `multiPlayerColumnWeights`, which are
session-level per visible-column shape rather than per playbook.
The command shall likewise carry the user config's top-level tmux-play
`notifications` and `theme` fields, when present, into the composed
config unchanged, so the seeded notification defaults
([[playbook-cli-11](#playbook-cli-11)]) reach the host.
A raw tmux-play config launched through `--config` retains direct
access to `layout.initialVisible`
([[playbook-cli-1](playbook-cli.md#playbook-cli-1)]).

### Seeding and readiness

#### playbook-cli-11

Where `playbook` seeds the starter generic config
([[playbook-cli-3](playbook-cli.md#playbook-cli-3)]), the bundled starter
config shall enable CODE with `playbooks.code.from` set to
`@sublang/playbook/code/registry`, a `players` map carrying `coder`
and `reviewer` roles, and `committer: coder` as CODE's option slice.
The seeded lineup shall configure Captain with adapter `claude`, model
`claude-opus-4-8`, and reasoning effort `high`; Coder with adapter
`claude`, model `claude-opus-4-8[1m]`, and reasoning effort `xhigh`;
and Reviewer with adapter `codex`, model `gpt-5.5`, and reasoning
effort `xhigh`.
The starter config shall carry no `profiles` map: each agent's
settings are written inline under the top-level `captain` and each
`playbooks.code.players.<role>` block
([DR-021](../decisions/021-inline-agent-settings.md)), so retuning one
player cannot change another.
Every seeded agent — the Captain and both roles — shall set
`permissions.mode: auto`, so each runs in cligent's profile-scoped
protected auto mode (claude maps `auto` to `permissionMode: auto`,
codex to on-request + auto_review) without routine in-session approval
prompts.
For every seeded agent on adapter `codex`, the starter config shall
additionally set `permissions.writablePaths: ['.git']`, so the default
Codex player can write git metadata under the codex sandbox; seeded
`claude` agents need no writablePaths grant under their auto mode.
The starter config shall set top-level
`notifications: { player_finished: bell, turn_finished: desktop }`;
these `adapter` / `model` / `effort` values are defaults and
remain user-tunable in place per
[[playbook-cli-6](playbook-cli.md#playbook-cli-6)].

#### playbook-cli-12

Where `playbook` runs the readiness gate
([[playbook-cli-1](playbook-cli.md#playbook-cli-1)],
[[playbook-cli-6](playbook-cli.md#playbook-cli-6)]), the command shall collect
the declared `adapter` values from the composed config — the
`captain.adapter` and every generated player's `adapter` — and treat
`claude` as ready when `ANTHROPIC_API_KEY` is set or `$HOME/.claude/`
exists, and `codex` as ready when `OPENAI_API_KEY` is set or
`$HOME/.codex/` exists.
When any declared adapter with a known readiness predicate is not
ready, the command shall block the launch per
[[playbook-cli-6](playbook-cli.md#playbook-cli-6)].
For every distinct adapter value other than `claude` or `codex`, the
command shall emit one stderr warning and shall exclude that adapter
from the blocking readiness result.
Playbook registry entries shall not define adapter or credential
readiness predicates; readiness remains launcher-owned
([DR-009](../decisions/009-generic-playbook-cli-and-registry.md) §7).

#### playbook-cli-39

Where the command determines adapter runtime availability
([[playbook-cli-40](playbook-cli.md#playbook-cli-40)]), it shall probe each
distinct declared adapter by constructing cligent's corresponding
adapter and awaiting its `isAvailable()`.
The gate shall derive each adapter's runtimes, supported floors, and
repair specifiers from cligent's shipped runtime descriptor
(`@sublang/cligent/runtime-targets`) and shall hold no adapter-to-SDK
version knowledge of its own; only the cligent module path that exports
each adapter class is this package's to know
([DR-027](../decisions/027-runtime-compatibility-from-cligent.md)).
The gate shall cover every declared adapter for which the descriptor
publishes runtime targets. `gemini`'s former exemption ends: its
missing-SDK rationale was true but incomplete, because its CLI can be
absent or below cligent's floor, and the descriptor names both.
Where an adapter is unavailable, the gate shall classify each of its
descriptor runtimes through cligent's structured verdict and shall
report only the runtimes at fault: an `opencode` failure whose CLI is
present and in range names the SDK alone.
The probe shall be the adapter's own loader rather than a resolution
check: it performs the same dynamic import the adapter performs at run
time, from the same installed module scope, so a passing probe cannot
disagree with a failing run
([DR-026](../decisions/026-optional-adapter-sdks.md) §4).
A resolution-based probe shall not be substituted: neither SDK exports
`./package.json` and `@openai/codex-sdk` is ESM-only, so
`createRequire(...).resolve()` reports both absent when present.

An adapter whose module cannot be imported at all shall be treated as
unavailable, not as an internal error.
An adapter with no published runtime targets shall be excluded from the
result and shall reuse the single unknown-adapter warning of
[[playbook-cli-12](#playbook-cli-12)] rather than emitting a second one.
Each probe shall run at most once per distinct adapter per invocation.

Where the interactive launcher runs the gate, the probe shall run over
the adapters of the composed config, alongside the
[[playbook-cli-12](#playbook-cli-12)] credential check, and both results shall be
reported together before returning the non-`127` readiness exit code.
Where `playbook run` binds agents ([[playbook-cli-20](#playbook-cli-20)]), the probe
shall run over the resolved captain and player adapter values — on a
first run and on a resumed one alike — after adapter-name and effort
validation and before the runtime is constructed, so no agent call and
no turn work precede it.
The lineup is only known once the `<from>` module has been loaded, so
the probe necessarily follows that load and any engine provisioning it
required; a failure shall exit with the argument exit code and the same
named remedy, leaving the session store untouched.

### Non-interactive Run Host

#### playbook-cli-20

Where `playbook run` ([[playbook-cli-18](playbook-cli.md#playbook-cli-18)])
executes, the command shall import the `<from>` module, validate its
default export with the same structural registry check as
[[playbook-cli-9](#playbook-cli-9)], resolving a relative filesystem `<from>` against
the caller's process working directory, and call
`entry.createRuntime({ captainOptions,
players })`, where `players` binds each `requiredRoleIds` entry to its
resolved agent under the entry's own local role id and `captainOptions`
is the `--option` slice itself — the same shape the shell passes as
`optionInput`, so the entry's `validateOptions` sees its own options.
The command shall host the runtime through a headless `PlaybookPorts`
([PBRT](playbook-runtime.md)) backed by cligent: `callPlayer` runs the
bound role's agent through a per-role `Cligent`, threading each call's
`resumeToken` into the next `resume`; `callJudge` and `callCaptain` run
the captain agent, `callJudge` always starts a fresh session and requests
an explicit empty tool allowlist unless the bound captain adapter has no
provider-enforced tool-restriction surface, in which case it omits
`allowedTools` per
[DR-013](../decisions/013-routing-only-captain-control.md) A1
rather than fail every judge call, and `callCaptain` forwards its requested
resume and tool-allowlist options exactly, preserving omission rather than
creating an own `allowedTools: undefined` property; `callPlaybook`
shall return a suspended start with a fresh synthetic child-session id
without launching a child, so the linked runtime reports the nested pause
that the one-shot host cannot answer; `emitStatus` shall write to stderr
and `emitTelemetry` shall be dropped unless `--verbose`.
When `entry.createRuntime` throws — including the shared factory's
construction-time rejection of an incompatible linked artifact
([[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]) — the command shall print
`playbook run: <message>` to stderr and exit `1` without calling any
agent.
The command shall initialize a depth-zero `PlaybookSession` whose
`sessionId` and `rootSessionId` are the same fresh UUID, run one
`handleBossInput` turn under an abort signal, and map the
`PlaybookRunResult` outcome to an exit status: `terminal`
→ `0` (printing `output`), `failed` or
`aborted` → `2`, `suspended` and `quiescent`/`no-action` → `3`.
The command shall `dispose` the runtime on every path except a parked
turn it persists per [[playbook-cli-23](#playbook-cli-23)], which hands the session off
without disposal ([DR-014](../decisions/014-durable-one-shot-run-sessions.md) §2).
The default agent shall run each `Cligent` in protected auto mode
(`permissions.mode: auto`, as the seeded lineup uses per
[[playbook-cli-11](#playbook-cli-11)]) so a one-shot run does not block on routine
approval prompts. Where Cligent's terminal `done` event omits `result`,
the agent drain shall derive `finalText` from the ordered `text` event
`content` and `text_delta` event `delta` payloads. Player and Captain
result adapters shall omit absent optional fields rather than emitting
own properties whose value is `undefined`.
The `run` subcommand shall accept an injected agent-run function so
tests can drive it without real adapters, defaulting to cligent's
`Cligent`.

#### playbook-cli-23

Where a `playbook run` turn settles `quiescent` and the runtime's
`exportSnapshot` ([[playbook-runtime-45](playbook-runtime.md#playbook-runtime-45)]) returns a
snapshot with at least one pending Boss question, the command shall
write one session file at
`${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions/<sessionId>.json`
with file mode `0600` (parent directories mode `0700`), skip runtime
disposal, print each pending question's text to stdout, and print one
stderr hint naming the session id and the resume command
([[playbook-cli-18](playbook-cli.md#playbook-cli-18)]).
The session file shall be written through a same-directory temporary
file and rename, so an interrupted write can never truncate the only
durable copy; when persisting fails, the command shall print the error,
dispose the runtime, and exit `2` — an unpersisted park is not a
hand-off.
The session file shall carry a schema version, the session and playbook
ids, the resolved `<from>` specifier, the captain and per-role agent
specs, the `--option` slice, the agents' working directory resolved to
an absolute path, creation and update timestamps, and the exported
runtime snapshot; the snapshot embeds player resume tokens, which is
why the file is user-only.
Where the user invokes `playbook run resume`
([[playbook-cli-22](playbook-cli.md#playbook-cli-22)]), the command shall
reject with exit `1` a `<session-id>` argument that is not a bare
file-name-safe id (no path separators — the id joins the store path),
then load the named session file (`--last` selects the readable record
with the newest stored update timestamp), rejecting with exit `1` a
missing or unreadable file, a schema version it does not understand,
malformed stored agent specs, a stored module whose registry entry no
longer validates, a reloaded entry whose `id` differs from the stored
playbook id — a different playbook cannot rehydrate the snapshot — or a
runtime that lacks `restore`; otherwise it shall rebuild the agents and
headless ports from the stored specs exactly as a first run does, call
`entry.createRuntime` with the stored option slice and players, call
`runtime.restore` with the stored session identity and snapshot, and
drive the reply through one `handleBossInput` turn.
A terminal outcome shall delete the session file and dispose the
runtime, and a deletion failure shall warn on stderr without masking
the terminal output or exit `0`; a turn that parks again with pending
questions shall rewrite the session file (updating its timestamp and
snapshot) and again skip disposal; failed, aborted, and
nested-`suspended` outcomes shall leave the session file unchanged and
dispose the runtime.
The `--json` envelope shall be one stdout JSON object with `outcome`
and `sessionId` fields, plus `output` on `terminal` and a `questions`
array of `{ questionId, player, question }` on a parked run; failed and
aborted turns keep their stderr-only reporting.
Where the runtime does not implement `exportSnapshot`, or the snapshot
carries no pending question, the parked turn shall keep the pre-DR-014
diagnostic path — dispose, stderr diagnostic, exit `3` — and persist
nothing.
The session store location shall honor `XDG_STATE_HOME` at invocation
time, and the `run` subcommand shall accept an injected store directory
so tests can drive the full park/resume lifecycle in isolation.

#### playbook-cli-26

Where the `playbook` launcher handles `--with`
([[playbook-cli-25](playbook-cli.md#playbook-cli-25)]), the command shall parse
and remove each `--with <path>` pair from the argument vector before
any arguments are forwarded to tmux-play, resolve each path against the
process working directory, and apply the fragments to the parsed
top-level config with a merge that recurses only into plain maps on
both sides, replaces every other collision with the fragment's value,
and never mutates the parsed global config or the fragment objects.
Where `playbook run` binds efforts
([[playbook-cli-19](playbook-cli.md#playbook-cli-19)]), the command shall split
the effort at the last `@` of the `<agent>` value and the adapter at
the first colon of the remainder — so the model keeps every interior
colon — validate each spec's effort through cligent's adapter-scoped
effort support metadata for the spec's adapter shorthand, and name the
adapter's supported values in the rejection diagnostic.
The default agent shall pass a bound effort to its `Cligent` as the
`effort` option alongside the model; the injected agent-run function
([[playbook-cli-20](#playbook-cli-20)]) shall receive the effort in its spec so tests
can observe it.
Session records ([[playbook-cli-23](#playbook-cli-23)]) shall carry each spec's
optional `effort` and resume validation shall accept and re-validate
it.

#### playbook-cli-29

Where `playbook run` resolves config defaults
([[playbook-cli-28](playbook-cli.md#playbook-cli-28)]), the command shall read
the user config from the same resolved path as the interactive
launcher ([[playbook-cli-3](playbook-cli.md#playbook-cli-3)]), treat a missing
file as an empty default set, parse each `run.captain`, `run.player`,
and `run.players.<role>` string through the same agent-spec parser as
`--player`/`--captain`, and validate the specs it binds through the
same adapter and effort path as flag-bound specs
([[playbook-cli-26](#playbook-cli-26)]); a structural fault — a non-map `run` or
`run.players`, a non-string agent value, or an unparseable agent
string — shall name the faulty config key in its diagnostic.
The `playbook` launcher shall forward its resolved — or injected —
user-config path to the `run` subcommand, so both surfaces read one
file under the same environment and home overrides.
The `run` subcommand shall accept an injected user-config path so
tests can drive config defaults in isolation, like the injected
session store ([[playbook-cli-23](#playbook-cli-23)]).

#### playbook-cli-37

Where `playbook run` imports a filesystem `<from>` module
([[playbook-cli-20](#playbook-cli-20)]) — on first runs and on `resume`, whose stored
`from` is the same resolved `file:` URL — the command shall first probe
resolution of `xstate` and `@sublang/playbook/xstate-runtime` with the
module's resolved path as parent, via
`module.createRequire(<module path>).resolve(...)`, and shall skip
provisioning entirely when both resolve.
A bare package `<from>` specifier resolves from the host's own module
tree and shall be neither probed nor provisioned.
For each specifier that does not resolve, the command shall create the
missing `<module dir>/node_modules/` entry — `xstate`, or
`@sublang/playbook` under a created `@sublang/` scope directory — as a
symbolic link through direct `node:fs` symlink calls, pointing at the
running host's own installed package root for that name resolved from
the host's module scope; it shall never shell out to `npm link` and
shall never install from the registry
([DR-024](../decisions/024-runtime-engine-provisioning.md) §2).
Before creating links the command shall apply the
[[playbook-cli-36](playbook-cli.md#playbook-cli-36)] guard order: a
`package.json` at or above the module's directory declaring
`@sublang/playbook` in its `dependencies`, `devDependencies`,
`peerDependencies`, or `optionalDependencies` refuses provisioning with
an instructive diagnostic and exit `1`; an existing dangling symlink at
a link path is replaced; an existing non-symlink entry refuses with a
diagnostic naming the occupied path and exit `1`.
The command shall validate every link destination before creating any
link, so an occupied-path refusal leaves the module directory
unmutated.
The one provisioning stderr line shall name each created link path and
its target; a run that creates no link shall print no provisioning
line.
Provisioning failures are load faults: they shall use the
`playbook run: <message>` diagnostic form and exit `1` without calling
any agent.
The `run` subcommand shall accept injected host package roots so tests
can drive provisioning against synthetic trees, like the injected
session store ([[playbook-cli-23](#playbook-cli-23)]).

#### playbook-cli-33

Where `playbook` resolves its top-level config for a launch and that
file still carries a top-level `profiles` map or an agent-block
`profile` key, the command shall migrate it in place before composing
([DR-021](../decisions/021-inline-agent-settings.md) §3):
replace each agent value that named a profile with that profile's
settings, merge a `profile`-bearing block over its named profile with
the block's own fields winning, remove the `profiles` map, and continue
the launch with the migrated config.
The command shall write the pre-migration text to `<config>.bak`, or to
the first free `<config>.bak.<n>` when that path exists, before
rewriting the config, so no prior backup is lost.
The rewrite shall preserve the user's comments by editing the YAML
document rather than re-serializing a parsed value, shall carry the
file's leading comment block — its SPDX header and overview — past the
removed `profiles` section, and shall prepend a note recording the
migration and naming the backup.
Where a `profile` key names no entry the `profiles` map defines, the
command shall migrate nothing: it shall exit non-zero with a diagnostic
naming the config path and the unresolvable reference, and shall leave
the config and any backup untouched, so the user has one file to fix
rather than a rewritten config missing that agent's settings.
The command shall print one stderr line naming the config path and the
backup path on a successful migration, and shall exit non-zero with a
diagnostic naming the config path when the migration otherwise fails.
A migrated config shall present nothing to migrate on the next launch.

## Internal Behavior

### Dependency resolution

#### playbook-cli-43

When the launcher resolves cligent's `tmux-play` CLI, it shall call synchronous `import.meta.resolve('@sublang/cligent/tmux-play')` from within the `@sublang/playbook` module tree and shall raise the declared Node floor in the same change if a newer Node API replaces it.

## Verification

### Seeding

#### playbook-cli-13

Where the test suite invokes `playbook` without `--config` against a
config root with no `playbook/playbook.config.yaml`, the test suite
shall fail unless the command creates that file from the bundled
starter config, prints the resolved path to stderr, and the seeded
file enables CODE through `playbooks.code.from`
`@sublang/playbook/code/registry` with the
[[playbook-cli-11](playbook-cli.md#playbook-cli-11)] lineup (Captain
`claude` / `claude-opus-4-8`, Coder `claude` / `claude-opus-4-8[1m]`,
Reviewer `codex` / `gpt-5.5`, each written inline under `captain` and
the `coder` / `reviewer` roles with no `profiles` map,
`committer: coder`,
`permissions.mode: auto` on every seeded agent with the Codex
Reviewer's additional `.git` writable path, and the notification
defaults).
When the file is already present, the test suite shall fail unless the
command leaves it unchanged and does not reseed (verifying [[playbook-cli-3](#playbook-cli-3)], [[playbook-cli-11](#playbook-cli-11)]).

### Composition Coverage

#### playbook-cli-14

When the test suite composes a top-level config enabling one or more
playbooks, the test suite shall fail unless the composed tmux-play
config sets `captain.from` to `@sublang/playbook/playbook-captain`;
carries one `captain.options.playbooks.<id>` entry per playbook with
that block's `from`, optional `command`, and an `options` slice built
from the block's non-launcher keys (CODE's `committer` among them and
no `from` / `command` / `players` in the slice); resolves scalar
`captain` and `players.<role>` values as adapter shorthands and
carries a full inline agent block through as authored; generates the
top-level roster as the union of each playbook's `<id>-<role>` host
players with separate instances when two playbooks name the same
adapter and model;
sets `layout.initialVisible` to the first enabled playbook's
generated player ids while carrying through the window and
column-weight fields; sets `captain.options.captainAdapter` to the
resolved captain adapter; and carries the user config's top-level
`notifications` and `theme` fields into the composed config unchanged (verifying [[playbook-cli-4](#playbook-cli-4)], [[playbook-cli-8](#playbook-cli-8)], [[playbook-cli-9](#playbook-cli-9)], [[playbook-cli-10](#playbook-cli-10)]).

### Validation

#### playbook-cli-15

When the test suite composes top-level configs that each carry one
fault — a missing `from`, a `from` whose import fails, a module
exposing no valid registry entry, a `playbooks.<id>` key not equal to
the imported manifest's `id`, two playbooks sharing an `id`, two
playbooks resolving to the same effective command, a top-level
`profiles` map, an agent block carrying a `profile` key, a manifest
`requiredRoleIds`
naming the reserved `captain` role, a `playbooks.<id>.players` map
binding the reserved `captain` role, a configured playbook id equal to
`captain`, an effective command equal to `captain`, a manifest required role with no
generated roster id, and an enabled playbook with no visible local
role — the test suite shall fail unless the
command rejects each before launching tmux-play with a diagnostic
naming the fault (verifying [[playbook-cli-8](#playbook-cli-8)], [[playbook-cli-9](#playbook-cli-9)]).

### Readiness and CLI surface

#### playbook-cli-16

When the test suite runs the readiness gate over a composed config,
the test suite shall fail unless: a config whose adapters all have
credentials present launches tmux-play; a config with a missing
`claude` or `codex` credential blocks the launch, prints the help
content plus every failing adapter id to stderr, and exits non-zero
with a status distinct from `127`; and a declared adapter with no
known predicate produces one stderr warning without blocking launch (verifying [[playbook-cli-1](#playbook-cli-1)], [[playbook-cli-12](#playbook-cli-12)]).

#### playbook-cli-17

When the test suite exercises the `playbook` CLI surface, the test
suite shall fail unless: `--list` prints each configured playbook's
id, effective command, and intent without launching; `--help` prints
help to stdout and exits `0` without seeding or launching;
`--config <path>` launches that raw config directly without seeding,
composition, or the readiness gate; and the command propagates the
tmux-play exit code, re-raises a terminating signal on itself, and
exits `127` when it cannot launch tmux-play (verifying [[playbook-cli-1](#playbook-cli-1)], [[playbook-cli-2](#playbook-cli-2)], [[playbook-cli-5](#playbook-cli-5)], [[playbook-cli-6](#playbook-cli-6)]).

#### playbook-cli-21

When the test suite exercises `playbook run` with an injected
agent-run function over a fake registry entry, the test suite shall
fail unless: a terminal turn prints its output to stdout and exits `0`;
`--json` prints one stdout envelope object carrying `outcome`,
`sessionId`, and that output; `callPlayer` routes to the agent
bound for each required role and threads the returned resume token into
the next call; the depth-zero session uses one fresh UUID as both its
session and root-session id; a relative `<from>` file path resolves from
the caller's process working directory; `callCaptain` requesting
isolation and every `callJudge` run fresh and tool-free, while a
`callCaptain` that omits `allowedTools` preserves that omission; player and
Captain failures omit absent optional text fields; the default Cligent drain
preserves `text` and `text_delta` output when terminal `done` omits a
`result`; the `--option` slice reaches the entry's `validateOptions`; a
failed or aborted turn exits `2`; a suspended, quiescent, or nested-call
outcome exits `3`; and a missing `<from>`, an invalid registry entry, or
an unrequired `--player` role exits `1` (verifying [[playbook-cli-18](#playbook-cli-18)], [[playbook-cli-19](#playbook-cli-19)], [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-24

When the test suite exercises the `playbook run` park/resume lifecycle
with an injected agent-run function, an injected session-store
directory, and a fake registry entry whose runtime implements
`exportSnapshot` and `restore`, the test suite shall fail unless: a
turn that parks with a pending Boss question writes
`<sessionId>.json` mode `0600` under the injected store, prints the
question text to stdout, prints a stderr hint naming the session id,
exits `3`, and does not dispose the runtime; `--json` prints one
stdout envelope with `outcome`, `sessionId`, and a `questions` array;
`run resume <session-id> "answer"` recreates the runtime with the
stored option slice and players, calls `restore` with the stored
session identity and snapshot, feeds the reply to `handleBossInput`,
and on a terminal outcome prints the output, deletes the session file,
disposes the runtime, and exits `0`; a resumed turn that parks again
rewrites the session file and exits `3`; a failed resumed turn keeps
the session file and exits `2`; `resume --last` selects the most
recently updated stored session by its stored update timestamp even
when another session file carries a newer filesystem mtime; a reply
arrives from stdin when the argument is omitted; a park whose
session-file write fails exits `2` and still disposes the runtime; and
an unknown session id, a path-shaped session id, a schema-version
mismatch, malformed stored agent specs, a reloaded entry whose `id`
differs from the stored playbook id, a stored runtime without
`restore`, or a `--player`, `--captain`, `--option`, or `--cwd` flag on
`resume` exits `1` while a parked turn over a runtime without
`exportSnapshot` keeps the diagnostic exit-`3` path and persists
nothing (verifying [[playbook-cli-18](#playbook-cli-18)], [[playbook-cli-22](#playbook-cli-22)], [[playbook-cli-23](#playbook-cli-23)]).

#### playbook-cli-27

When the test suite exercises per-run agent tuning, the test suite
shall fail unless: `playbook run --player <role>=<adapter>:<model>@<effort>`
reaches the injected agent factory with that model and effort;
`<adapter>@<effort>` sets effort with no model; a model containing
colons binds intact with and without a trailing `@<effort>`; an effort
the adapter does not support exits `1` naming the supported values
before any agent factory call; a parked session stores the bound efforts and a
resumed run rebuilds them; `playbook --with <path>` composes with the
fragment merged over the global config — a fragment retuning one
player's agent block changes only that binding, two fragments merge in
argument order, and non-map collisions take the fragment value — while
the global config file stays byte-identical and the spawned tmux-play
argument vector carries no `--with`; `--list` reflects a fragment that
enables another playbook; and `--with` combined with `--config`, a
missing fragment, and a non-map fragment each exit `1` without
launching (verifying [[playbook-cli-19](#playbook-cli-19)], [[playbook-cli-25](#playbook-cli-25)], [[playbook-cli-26](#playbook-cli-26)]).

#### playbook-cli-30

When the test suite exercises `playbook run` config defaults over an
injected agent factory and an injected user-config path, the test
suite shall fail unless: a config-only `run` block reaches the agent
factory with its adapter, model, and effort; a `run.player` catch-all
binds every required role without a `run.players.<role>` entry; a
`--player` or `--captain` flag beats the config default for its role
or the captain; `run.players.<role>` beats `run.player`; a
`run.players` role the entry does not require is ignored; an
unsupported config effort exits `1` naming the supported values
before any agent factory call; an unparseable config file, a non-map
`run` or `run.players` value, and a non-string agent value each exit
`1`; a resumed session rebuilds its stored lineup even when the
injected config binds different agents; and an absent config file
keeps the `claude` defaults (verifying [[playbook-cli-28](#playbook-cli-28)], [[playbook-cli-29](#playbook-cli-29)]).

#### playbook-cli-31

When the test suite exercises `playbook run` with an injected agent-run
function, the test suite shall fail unless a run whose captain binds an
adapter without a provider-enforced tool-restriction surface issues its
`callJudge` calls with no `allowedTools` property, and unless a run whose
captain binds an enforcing adapter issues them with `allowedTools: []`;
both shall still request `resume: false`.
The test suite shall further fail unless every headless judge prompt,
whatever the adapter, reaches the captain agent inside the hidden-control
envelope — forbidding tool use, delimiting the runtime prompt, and refusing
instructions found in quoted actor output — since that envelope is the
prompt-level isolation [DR-013](../decisions/013-routing-only-captain-control.md) A1
substitutes when the allowlist is omitted (verifying [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-35

When the test suite exercises `playbook run` with an injected agent-run
function over a synthetic registry entry whose `createRuntime` invokes
the shared `createXStatePlaybookRuntime` factory with a `spec.compat`
declaration the loaded engine does not support, the test suite shall
fail unless the command prints one `playbook run:` stderr diagnostic
naming the declared and supported compatibility values and exits `1`
without any agent call (verifying [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-32

Where the live release gate writes top-level configs for its fixture repositories, when the normal
test suite runs, the test suite shall fail unless each of those exact
configs composes through the launcher against the real modules it
enables.
It shall fail unless the workflow config composes against the real CODE
and DISCUSS registry modules, enabling both playbooks and generating the
`code-coder` / `code-reviewer` / `discuss-host` / `discuss-participant`
roster with their expected adapters.
It shall further fail unless the conversational config composes against
the fixture playbook modules the gate generates from its own sources,
written to the paths that config names, enabling `checklist` and `notes`
under those effective commands and generating the `checklist-worker` /
`notes-worker` roster on the `claude` adapter.
The gate itself is excluded from `pnpm test` and CI, so without this
check a config-model change would break the release gate silently and
surface only during a manual pre-tag run (verifying [[playbook-cli-8](#playbook-cli-8)]).

#### playbook-cli-34

Where the test suite launches `playbook` against a config carrying a
top-level `profiles` map, a scalar agent naming a profile, and a
`profile`-bearing agent block, the test suite shall fail unless the
command rewrites that config in place with each agent's settings
inlined and the block's own fields winning over its named profile's,
removes the `profiles` map, leaves every untouched key and the user's
comments intact, records the migration at the top of the file, writes
the pre-migration text unchanged to `<config>.bak`, names both paths on
stderr, and launches.
It shall further fail unless a comment on a scalar agent's own line
survives the rewrite, unless a comment carried on a profile setting's
key reaches every agent that profile fills, whether named by a scalar
or by a `profile`-bearing block, unless a `profile` naming no defined entry exits
non-zero leaving the config byte-identical and writing no backup, and
unless a second launch migrates nothing and
leaves the file byte-identical, and unless a fresh legacy config beside
an existing backup is backed up to the next free `<config>.bak.<n>`
rather than overwriting it (verifying [[playbook-cli-33](#playbook-cli-33)]).

#### playbook-cli-38


When the test suite exercises `playbook run` engine provisioning over
synthetic filesystem registry modules and injected host package roots,
the test suite shall fail unless: a module beside a resolvable
project-local engine runs with its directory byte-identical and no
provisioning line; a module in a bare directory gains exactly the
missing `node_modules/xstate` and `node_modules/@sublang/playbook`
symbolic links pointing at the injected host roots, with one stderr
line naming each created link and target; a second run over the
provisioned directory creates nothing further and prints no
provisioning line; `--no-provision` leaves the bare directory unchanged
and exits `1` with the ordinary load diagnostic; a bare `<from>`
package specifier is neither probed nor provisioned; a `package.json`
above the module declaring `@sublang/playbook` refuses provisioning
with an instructive diagnostic and exit `1` before any agent call; a
dangling previously provisioned link is replaced under default
provisioning and named in a diagnostic under `--no-provision`; a
real directory occupying either link path is left untouched — with no
sibling link created — while the command exits `1` naming the occupied
path; and a filesystem failure while creating links surfaces the
`playbook run: <message>` diagnostic form with exit `1` rather than a
raw exception (verifying [[playbook-cli-36](#playbook-cli-36)], [[playbook-cli-37](#playbook-cli-37)]).

#### playbook-cli-41


When the test suite exercises the adapter SDK preflight over an
injected probe, the test suite shall fail unless: a config whose
adapters all probe available launches tmux-play unchanged; a config
with one absent adapter runtime blocks the launch, prints that adapter
id and cligent's pinned `npm install -g <spec>` remedy to stderr,
exits non-zero with a status distinct from `127`, and spawns nothing;
a config with a runtime installed below cligent's floor blocks the
same way, naming the installed and required versions rather than
reporting the runtime absent;
a config that is simultaneously missing a credential and an SDK
reports both failures rather than only one; an adapter with no known
SDK mapping is excluded from the probe without emitting a second
unknown-adapter warning; a `--config <path>` launch runs no probe;
each distinct adapter is probed at most once per invocation;
`playbook run` with an unavailable SDK exits non-zero naming the same
remedy before constructing the runtime, on a first run and on a
resumed one alike, with no agent call made; an `opencode` failure
names only the runtime at fault when the other is present and in
range, and names both when both are absent; the gate covers exactly
the declared adapters with published runtime targets, `gemini`
included; a run detected inside npm's ephemeral exec tree
prints one multi-package re-run rather than any `npm install` command;
that re-run names cligent's pinned repair specifier of every
descriptor-backed adapter the lineup requires even when only some are
missing — the partially supplied exec tree
case — pins the running package's own version, ends with the original
invocation's arguments shell-quoted rather than placeholder text, and
therefore succeeds in one hop; the lineup SDK set is deduplicated
when the captain and a player share an adapter; a task or reply the
command consumed from stdin is appended to the re-run as a quoted
positional behind a `--` end-of-options terminator, on first runs and
resumes alike; a flag-shaped stdin value survives the round trip —
replaying the emitted invocation delivers a `--json` task or a
`--last` reply as Boss text with no option semantics; an invocation
whose own terminator is already active — trailing or mid-argv, on
first runs and resumes alike — gets no second `--`, while a `--`
consumed as an option's value does not count as active; and a missing
adapter's external CLI install is printed before the ephemeral re-run
rather than after it (verifying [[playbook-cli-40](#playbook-cli-40)], [[playbook-cli-39](#playbook-cli-39)]).

#### playbook-cli-42

Where a packed candidate is installed without a top-level `tmux-play` executable, when the model-free installed-CLI gate invokes `playbook --help`, the gate shall fail unless the command resolves `@sublang/cligent/tmux-play` from the candidate's own dependency tree and the package declares the Node `>=20.6.0` floor required by its synchronous `import.meta.resolve` call (verifying [[playbook-cli-7](#playbook-cli-7)] and [[playbook-cli-43](#playbook-cli-43)]).
