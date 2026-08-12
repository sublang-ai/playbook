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
The seeded starter config shall enable CODE, REVIEW, and DECIDE through their explicit public registry modules and
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
The only accepted top-level keys shall be `captain`, `playbooks`, `layout`, `notifications`, and `theme`; the retired `run` key shall receive the migration diagnostic of [[playbook-cli-28](#playbook-cli-28)], and every other key shall be rejected before preparation or import.
Within a `playbooks.<id>` block, `from`, `command`, and `players` are
launcher-owned keys and every other key
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
The launcher shall validate and normalize those agent blocks and the presentation fields through the installed cligent tmux-play config loader before preparing or importing a registry, so both front ends consume the same adapter, effort, permission, layout, notification, and theme semantics.
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

When the user invokes `playbook run [input]`, the command shall create one logical session over the same configured compiled Captain, catalog, nested engagement stack, and mapped players as interactive `playbook` ([[playbook-cli-20](#playbook-cli-20)]).
The command shall accept exactly zero or one positional value: a present value is the exact Boss text, while zero values reads stdin completely as UTF-8 text and submits that verbatim stream as one Boss turn.
The command shall use whitespace only to reject empty input and shall never trim or otherwise rewrite accepted argv or stdin text.
The command shall drain omitted positional input from stdin before config preparation, registry import, credential readiness, or SDK readiness, so a producer such as `spex scaffold --update` cannot deadlock behind a full pipe.
The argument list shall support a `--` end-of-options terminator, after which a single flag-shaped value is Boss text; more than one positional, an empty input, an unknown option, or a retired run-only option shall print a diagnostic and exit `1` with no stdout.
After one settled Boss turn, plain stdout shall contain exactly the one non-empty Boss-visible `captain_reply` plus one line feed, while statuses and diagnostics use stderr and telemetry topics use stderr only under `--verbose`.
With `--json`, stdout shall instead contain exactly one object with keys `sessionId` and `reply`, followed by one line feed; it shall expose no outcome envelope, hidden control result, player output, telemetry payload, or internal Captain or playbook identifier.
Config, preparation, import, and host-construction failures shall print a `playbook run:` diagnostic and exit `1`; readiness shall print its complete prefixed credential and SDK report per [[playbook-cli-40](#playbook-cli-40)] and exit `1`.
A started-turn, reply-cardinality, snapshot, settled-record, or lease-release failure before presentation shall keep stdout empty, print a diagnostic, and exit `2`; presentation shall be one awaited buffered write only after the settled record is durable and the exclusive lease is durably retired, and a write failure shall be diagnosed with exit `2` without retrying the reply.
`playbook run --help` and `playbook run -h` shall print the resolved config path and current grammar to stdout, exit `0`, and shall not read stdin, seed or read config, prepare or import a registry, run readiness, or create a host.

#### playbook-cli-44

Where REVIEW is enabled in the shared config with Coder and Reviewer mappings, when the user invokes `playbook run "/review <request>"`, the shared Captain shall run REVIEW as a root engagement and print Captain's grounded reply without requiring CODE or DECIDE to be active.

#### playbook-cli-19

Where `playbook run` resolves Captain and player agents, it shall use the same normalized top-level `captain` and `playbooks.<id>.players.<role>` blocks as interactive `playbook`, including model, instruction, permissions, and adapter-scoped effort ([[playbook-cli-4](#playbook-cli-4)]).
The command shall reject the retired `--player`, `--captain`, `--option`, `--cwd`, `--last`, and raw `--config` surfaces with a diagnostic directing the user to the shared config or a `--with` overlay.
A single positional value such as `resume` or `mod://registry` shall remain ordinary Boss text; the former `resume <id>` and `<from> [task]` forms have no special parsing and fail only when they supply more than one positional.

#### playbook-cli-36

Where either front end prepares a configured filesystem `playbooks.<id>.from` module whose `xstate` or `@sublang/playbook/xstate-runtime` import does not resolve from the module's own directory, the shared launch path shall provision the missing engine links before importing any configured registry ([DR-024](../decisions/024-runtime-engine-provisioning.md)).
The path shall create `node_modules/xstate` and `node_modules/@sublang/playbook` beside the module as symbolic links to the running host's own installed packages and shall print one front-end-prefixed stderr line naming each created link and target.
Where both imports already resolve, the path shall change nothing, because an existing project-local installation always wins; a repeated launch over a provisioned directory shall likewise print no provisioning line.
`--no-provision` shall disable new links for that interactive or headless launch, while retaining a named stale-link diagnostic for a dangling link.
Where a `package.json` at or above the module declares `@sublang/playbook` while resolution fails, the path shall refuse provisioning with a diagnostic recommending the project's dependency install.
The path shall replace a dangling link only when provisioning is enabled and shall never remove or overwrite a real file, real directory, or live foreign symlink occupying a destination.
Every provisioning failure shall be a structured preparation failure that receives exactly one `playbook:` or `playbook run:` prefix from its front end and exits `1` before any registry import or agent call.

#### playbook-cli-22

Where a complete logical Captain session has been persisted ([[playbook-cli-23](#playbook-cli-23)]), when the user invokes `playbook run --continue [reply]`, the command shall select the latest resumable session and submit the exact argument or verbatim UTF-8 stdin text as its next Boss turn.
When the user invokes `playbook run --session <id> [reply]`, the command shall select that logical session explicitly instead of the latest one; `--session` and `--continue` shall be mutually exclusive.
Continuation shall use the frozen normalized execution config and absolute working directory stored when the logical session was created, shall restore the complete Captain shell through [[playbook-cli-20](#playbook-cli-20)], and shall never re-read current presentation config or replay a previously settled effect.
`--json`, `--verbose`, the one-input grammar, output-channel rules, and readiness gate shall apply as on a new turn.
An uncertain record shall never be continued automatically.
The command shall exit `1` before host or agent work and print the exact explicit `playbook run --session <id> --retry-uncertain` and `playbook run --session <id> --discard-uncertain` remedies, warning that retry may duplicate external effects and discard abandons the attempted turn.
Both recovery flags shall require one explicit `--session <id>`, be mutually exclusive, reject positional input, and never read stdin.
Retry shall restore the stored pre-turn snapshot, reuse the exact stored input, durably increment the attempt before effects, and then follow the normal settlement boundary.
Discard shall run no config, preparation, import, readiness, host, or agent work and shall either restore the exact prior settled boundary or durably delete a never-settled fresh session; because it presents no turn, discard shall also reject the inert `--json`, `--verbose`, and `--no-provision` flags.
The retired `resume <session-id>`, `--last`, and runtime-only snapshot formats shall not select a shared Captain session.

#### playbook-cli-28

Where the shared config at the resolved top-level path carries the retired top-level `run` key, when either front end resolves the config, the command shall reject it before preparation, import, readiness, or host creation.
The diagnostic shall name the removed `run` key and direct the user to the shared top-level `captain` and `playbooks.<id>.players` blocks.
The command shall never silently ignore the retired defaults, because doing so could bind a different Captain or player lineup after a major-version upgrade.

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
Where `playbook run` consumed Captain input from stdin before the gate fired, the re-run shall preserve the complete original run argv and append that exact input behind an effective `--` end-of-options terminator ([[playbook-cli-18](#playbook-cli-18)]).
The input shall be shell-quoted because the original pipe will not exist when the printed command runs and a flag-shaped value such as `--json` or a `-`-leading bullet must remain Boss text.
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

Where the user invokes either shared front end without a raw `--config`, when the invocation carries one or more `--with <path>` flags, the command shall
load each file as a YAML fragment in the top-level generic-config
format ([[playbook-cli-4](#playbook-cli-4)]), merge the fragments over the resolved —
and, when absent, freshly seeded ([[playbook-cli-3](#playbook-cli-3)]) — top-level
config in argument order, and use the merged config for composition,
headless execution, `--list`, and the readiness gate.
Merging shall be recursive for maps and replacement for every other
value (scalars, sequences, and `null`), so a later fragment or the
fragment side of any non-map collision wins.
`--with` and its value are launcher-owned: the command shall consume them and shall not forward them to tmux-play or submit them as Boss input.
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
canonical prepared `from`, the normalized effective `command`, and an
`options` slice built from every non-launcher key of the block; `from`, `command`, and `players` shall not
appear in the option slice.
The command shall resolve a scalar `captain` or `players.<role>` value
as an adapter shorthand and shall normalize a full block as a self-contained tmux-play agent block through the installed cligent loader
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
`notifications` and `theme` fields, when present, through cligent's normalization into the composed
config, so the seeded notification defaults
([[playbook-cli-11](#playbook-cli-11)]) reach the host.
A raw tmux-play config launched through `--config` retains direct
access to `layout.initialVisible`
([[playbook-cli-1](playbook-cli.md#playbook-cli-1)]).

### Seeding and readiness

#### playbook-cli-11

Where `playbook` seeds the starter generic config
([[playbook-cli-3](playbook-cli.md#playbook-cli-3)]), the bundled starter
config shall enable CODE, REVIEW, and DECIDE with their `playbooks.<id>.from` values set to the matching public registry modules.
CODE shall configure `coder`, while REVIEW and DECIDE shall each configure `coder` and `reviewer` under the same role names used for nested inheritance.
The seeded lineup shall configure Captain with adapter `claude`, model
`claude-opus-4-8`, and reasoning effort `high`; Coder with adapter
`claude`, model `claude-opus-4-8[1m]`, and reasoning effort `xhigh`;
and Reviewer with adapter `codex`, model `gpt-5.5`, and reasoning
effort `xhigh`.
The starter config shall carry no `profiles` map: each agent's
settings are written inline under the top-level `captain` and each
`playbooks.<id>.players.<role>` block
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

Where either shared front end runs the readiness gate
([[playbook-cli-1](playbook-cli.md#playbook-cli-1)],
[[playbook-cli-6](playbook-cli.md#playbook-cli-6)]), the command shall collect
the declared `adapter` values from the normalized launch plan — the
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
Where `playbook run` hosts a new Captain turn ([[playbook-cli-20](#playbook-cli-20)]), the probe shall run over the same normalized Captain and player adapter values as interactive mode, after installed-cligent config validation and complete catalog preparation/import but before host construction, so no agent call or turn work precedes it.
A failure shall exit with the argument exit code and the same named remedy, with stdout empty.

### Non-interactive Run Host

#### playbook-cli-20

Where `playbook run` executes ([[playbook-cli-18](#playbook-cli-18)]), the command shall construct the exact `createPlaybookCaptainShell` ([[playbook-captain-17](playbook-captain.md#playbook-captain-17)]) over the normalized catalog and host it through cligent's `createTmuxPlayRuntime` core without constructing a tmux presenter or a separate `PlaybookPorts` implementation.
The execution-only projection shall be detached and JSON-safe and shall retain the normalized Captain, namespaced players, and complete catalog identity — id, canonical prepared `from`, manifest command, effective command, intent, required roles, mapped player ids, and options — while excluding layout, notifications, and theme.
The shell shall receive each catalog entry's effective command explicitly, so neither front end can silently re-read a changed registry default after planning.
The host shall use the normalized Captain config and `{ id, ...agent }` players, the same adapter imports and working directory as the launch plan, and the shell's ordinary player, Captain, nested-call, mapped-continuity, status, telemetry, and presentation boundaries.
The command shall observe only host records: it shall buffer `captain_reply`, send `captain_status` to stderr, send only telemetry topic names to stderr under `--verbose`, and never write player or Captain events directly to stdout.
The command shall submit exactly one Boss turn, require exactly one non-empty matching reply after it settles, and export the complete shell snapshot ([[playbook-captain-41](playbook-captain.md#playbook-captain-41)]) before durable hand-off or stdout presentation.
The public logical `sessionId` shall be a fresh UUID distinct from every internal Captain and playbook runtime UUID.
Headless driving and stdout presentation shall be separate operations so a persistence layer can durably hand off the snapshot before releasing the buffered reply.
Where a restored snapshot is supplied by a continuation layer, the core host's one `captain.init(session)` call shall dispatch to `shell.restore(session, snapshot)` instead of `shell.init(session)` ([[playbook-captain-42](playbook-captain.md#playbook-captain-42)]), because a shell must be fresh when restored.
Host setup or initialization failure shall exit `1`; once the Boss turn starts, turn, reply, snapshot, persistence, safe failure-disposal, and output failures shall exit `2`.
After a successful durable hand-off, the one-turn process shall not invoke semantic host or shell disposal, because the stored logical session remains continuable; process exit owns only ephemeral transport teardown.
The normal CLI entry shall allow stdout and stderr to drain before process exit, and a backpressured buffered reply shall not report success before the stream's drain boundary.

#### playbook-cli-23

Before every new, continued, or explicitly retried headless Boss turn, the command shall atomically persist an uncertain write-ahead record under `${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions/`; after a non-empty turn settles, it shall atomically replace that marker with the complete settled logical Captain session and durably retire the exclusive lease before releasing the buffered reply ([[playbook-cli-18](#playbook-cli-18)]).
Each store-owned filename shall be the canonical lowercase `<session-id>.json`; the embedded id shall equal that filename, the managed sessions directory shall be a real non-symlink directory with mode `0700`, and every record shall be a regular non-symlink file with mode `0600`.
The record shall be a closed, strictly plain-JSON Captain-session schema version `2`, distinct from the released direct-run-only boundary, and be an exact `settled` / `uncertain` union carrying the public logical session id, complete Captain shell snapshot, detached normalized execution config, normalized absolute working directory, and canonical creation and update timestamps.
An uncertain record's common snapshot shall be the complete pre-turn baseline.
Its exact `uncertain` member shall carry the prior settled `updatedAt` or null for a fresh never-settled session, exact input, UUID attempt id, positive attempt number, and marker timestamp equal to the root `updatedAt`.
Retry shall preserve the baseline, input, and prior-boundary identity while replacing the attempt id, incrementing the attempt number, and advancing the marker time.
Creation time shall remain fixed for the logical session; every forward marker, retry, and settlement update time shall be strictly newer than its predecessor even when the wall clock is equal or moves backward.
Explicit discard is the sole rollback: it restores the exact prior settled `updatedAt` and bytes.
The shell snapshot shall include the Captain runtime and durable conversation, recovery journal, issued internal UUIDs and counters, every active engagement frame and runtime snapshot, pending nested-call identity, mapped-player continuation tokens, pending Boss questions, and last settlement evidence as applicable ([[playbook-captain-41](playbook-captain.md#playbook-captain-41)]).
The execution config shall retain the normalized Captain, namespaced players, and complete catalog identity required by [[playbook-cli-20](#playbook-cli-20)], including the registry-authored default command even where configuration freezes a different effective command, and shall exclude presentation-only layout, notification, and theme values.
Persistence shall use an unpredictable same-directory `0600` exclusive temporary regular file, sync its contents, publish only the initial fresh uncertain marker with an atomic no-replace operation, replace every later same-session state transition by atomic rename, and sync the containing directory as required for the platform contract; a fresh UUID shall never overwrite an existing record.
A failed write-ahead marker before its durability call returns shall keep stdout empty, dispose the host safely, print a setup diagnostic, and exit `1`.
Once that call returns, every abort, signal, turn, capture, or settlement failure before atomic replacement shall leave the marker uncertain, keep stdout empty, dispose safely, and exit `2`; a successful settlement and lease retirement shall release the buffered reply without semantic disposal.
Where the complete settled replacement has been atomically renamed but syncing the containing directory reports failure, the command shall likewise keep stdout empty, dispose safely, and exit `2`, but shall not overwrite that complete visible replacement with the earlier uncertain marker.
A later process shall accept whichever complete pre-settlement or post-settlement record the filesystem retained across the durability failure; it shall never accept partial bytes or infer the boundary from the failed command's diagnostic.
Every logical session shall have at most one cooperative writer.
The store shall acquire an exclusive, complete, nonempty, private per-session lease before the authoritative record read and shall verify the owner token before every record mutation and immediately before model work.
A live, foreign-host, permission-unknown, malformed, or non-private lease shall fail closed before host or agent work.
A lease may be reclaimed only when its recorded host is the current host and probing its PID definitively returns `ESRCH`; age alone shall never make a lease stale.
Normal release and stale reclaim shall both atomically rename the canonical lease directory to a permanent, nonempty, token-specific retired path and sync the sessions directory.
Retired paths are never reused or removed: two reclaimers that observed old token O therefore target the same occupied retired-O path, so an arbitrarily delayed reader cannot move, delete, or replace successor N.
Lease publication shall use a fully synced private staging directory with a synced `0600` owner record, atomic no-replace rename, and post-publication token verification.
SIGINT, SIGTERM, and SIGHUP observed before settlement shall abort the active host and preserve the already-written uncertain record; a signal arriving during a noncancellable atomic settlement may leave that record settled.
In both cases the command shall retire the owned lease, withhold stdout, and then re-raise the signal.
SIGKILL may leave the uncertain record and canonical lease for the same-host dead-PID recovery rule.
Where [[playbook-cli-22](#playbook-cli-22)] selects a record, the command shall reject an unsafe id, missing or malformed record, unsupported schema, invalid frozen config, mismatched current registry manifest, or unrestorable shell snapshot ([[playbook-captain-42](playbook-captain.md#playbook-captain-42)]) with exit `1` before a Boss turn.
`--continue` shall select by canonical `updatedAt` with a deterministic session-id tie-break and shall fail closed on a malformed canonically named store record rather than silently falling back past corruption.
The command shall never read current user config or overlays while continuing; it shall use the frozen effective command, mapped roles, agents, options, and absolute working directory while revalidating that each stored canonical module still exposes the recorded id, default command, intent, required roles, and compatible options, so a package or config change cannot silently rewire a conversation.

#### playbook-cli-26

Where the `playbook` launcher handles `--with`
([[playbook-cli-25](playbook-cli.md#playbook-cli-25)]), the command shall parse
and remove each `--with <path>` pair from the argument vector before
any arguments are forwarded to tmux-play, resolve each path against the
process working directory, and apply the fragments to the parsed
top-level config with a merge that recurses only into plain maps on
both sides, replaces every other collision with the fragment's value,
and never mutates the parsed global config or the fragment objects.
Where either front end normalizes an overlaid inline agent block ([[playbook-cli-19](#playbook-cli-19)]), the shared launch path shall validate its adapter-scoped `effort` and every other agent field through the installed cligent loader before registry preparation or import.
The path shall normalize the deprecated `reasoningEffort` alias to `effort` only in its isolated projection and shall leave the primary config and overlays byte-identical; specifying both keys shall be rejected as a conflict.
The normalized effort and permissions shall reach both interactive projection and headless execution config unchanged, and complete session records shall freeze them per [[playbook-cli-23](#playbook-cli-23)].

#### playbook-cli-29

Where `playbook run` resolves its shared config, the command shall use the same resolved or injected user-config path, primary-relative registry canonicalization, seeding, migration, overlays, and installed-cligent normalization as interactive `playbook` ([[playbook-cli-3](#playbook-cli-3)], [[playbook-cli-46](#playbook-cli-46)]).
A missing file shall be seeded from the same starter rather than treated as an empty direct-run default set.
A surviving top-level `run` block shall fail closed through [[playbook-cli-28](#playbook-cli-28)] and shall never be used to derive a second lineup.

#### playbook-cli-37

Where the shared launch path prepares a configured filesystem module ([[playbook-cli-36](#playbook-cli-36)]), it shall first probe resolution of `xstate` and `@sublang/playbook/xstate-runtime` with the module's canonical file path as parent via `module.createRequire(<module path>).resolve(...)`, and shall skip provisioning entirely when both resolve.
A bare package or custom `playbooks.<id>.from` specifier shall be neither probed nor provisioned.
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
The provisioning core shall return structured created-link notices and throw structured failures without a CLI prefix, and each front end shall add exactly its own `playbook:` or `playbook run:` prefix while preserving the same guard behavior.
Both front ends shall accept injected host package roots so tests can drive provisioning against synthetic trees.

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

### Shared launch configuration

#### playbook-cli-46

Where either front end prepares a new Captain session from the generic config, when the launcher resolves that config, it shall use one leaf launch-config module to perform the following ordered pipeline:

1. Resolve the primary path per [[playbook-cli-3](#playbook-cli-3)], seed and migrate that primary file before applying overlays, and merge every [[playbook-cli-25](#playbook-cli-25)] overlay in argument order without mutating an input.
2. Resolve a relative configured filesystem `playbooks.<id>.from` against the primary config's directory, including one introduced by an overlay, canonicalize an absolute filesystem path to a file URL, and preserve an existing file URL, bare package specifier, or custom specifier unchanged.
3. Reject non-JSON data, retired or unknown root keys, malformed launcher-owned structure, blank identities, authority-key smuggling, and colliding generated `<playbook>-<role>` ids before an external side effect.
4. Serialize a detached provisional tmux-play config to an isolated explicit temporary path, validate and normalize it through the installed cligent `loadTmuxPlayConfig`, feed its Captain, player, layout, notification, and theme values back into the authoritative plan, and remove the temporary path without modifying the primary config or overlays.
5. Canonicalize and prepare every configured registry module before importing any of them, use a preparation hook's returned canonical specifier for both the one import and normalized catalog, and perform no registry import when validation or any preparation fails.
6. Validate registry manifests and launcher-owned identities, resolve and freeze each effective command, and produce one detached, deeply frozen, JSON-safe plan separating Captain, namespaced players, complete catalog, and presentation with no imported function retained.
7. Derive adapter readiness from the plan's Captain and players independently of presentation, project a detached tmux-play config only for the interactive host, and project a detached presentation-free execution config only for the headless host while keeping `--list` ahead of readiness.

The module shall import neither CLI host, both CLI hosts shall resolve the user-config path through it without a circular import, both shall use the same preparation hook and normalized effective commands, and the packed package shall include the module.

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
file enables CODE, REVIEW, and DECIDE through their matching public registry modules with the
[[playbook-cli-11](playbook-cli.md#playbook-cli-11)] lineup (Captain
`claude` / `claude-opus-4-8`, Coder `claude` / `claude-opus-4-8[1m]`,
Reviewer `codex` / `gpt-5.5`, each written inline under `captain` and
the `coder` / `reviewer` roles with no `profiles` map,
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
that block's canonical prepared `from`, normalized effective `command`, and an `options` slice built
from the block's non-launcher keys with no `from` / `command` / `players` in the slice; resolves scalar
`captain` and `players.<role>` values as adapter shorthands and
normalizes a full inline agent block through the installed cligent loader; generates the
top-level roster as the union of each playbook's `<id>-<role>` host
players with separate instances when two playbooks name the same
adapter and model;
sets `layout.initialVisible` to the first enabled playbook's
generated player ids while carrying through the window and
column-weight fields; sets `captain.options.captainAdapter` to the
resolved captain adapter; and carries the user config's top-level
`notifications` and `theme` fields into the composed config in cligent-normalized form (verifying [[playbook-cli-4](#playbook-cli-4)], [[playbook-cli-8](#playbook-cli-8)], [[playbook-cli-9](#playbook-cli-9)], [[playbook-cli-10](#playbook-cli-10)]).

### Validation

#### playbook-cli-15

When the test suite composes top-level configs carrying pre-import faults — a missing or blank `from`, top-level `profiles` or `run`, an agent `profile`, an unknown root key, non-map `layout`, malformed or unknown agent fields, unknown adapter, conflicting or unsupported effort, malformed permissions, invalid layout / notification / theme, reserved or blank configured identities, an empty visible role map, authority-key smuggling, or a generated host-id collision — the suite shall fail unless each is rejected before registry preparation or import with a diagnostic naming the fault.
When the suite composes configs carrying registry-dependent faults — a failed import, invalid default export, key / manifest-id mismatch, duplicate manifest id or effective command, reserved manifest role or effective command, or missing required mapped role — the suite shall fail unless each is rejected after only the imports needed to discover it and before readiness, host creation, or agent calls (verifying [[playbook-cli-8](#playbook-cli-8)], [[playbook-cli-9](#playbook-cli-9)]).

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

When the integration suite exercises `playbook run` through the actual `createPlaybookCaptainShell` and actual no-presenter cligent runtime with deterministic adapters and synthetic configured registries, the suite shall fail unless one positional and verbatim stdin each enter one exact Captain Boss turn; `/code` completes a nested REVIEW and resumes the same mapped Coder token; statuses stay on stderr and telemetry appears only under `--verbose`; plain and JSON stdout carry only the one Captain reply in their exact formats; the public session id differs from internal UUIDs; and no tmux process or presenter is created (verifying [[playbook-cli-18](#playbook-cli-18)], [[playbook-cli-19](#playbook-cli-19)], [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-24

When the integration suite exercises complete shared-Captain persistence and continuation in isolated state directories, the suite shall fail unless chat-only, completed-root, and nested-parked turns atomically persist the full shell snapshot, frozen execution config, normalized absolute working directory, manifest command, stable creation time, and monotonic update time with exact private permissions before stdout and without successful semantic disposal; `--continue` selects the latest logical session deterministically; `--session <id>` selects one explicitly; stdin and argv replies preserve exact text; restore occurs instead of init and does not repeat a settled or pending child start; current config cannot rewire the frozen lineup or effective command; a changed manifest default is rejected even under a command override; fresh id collision, malformed plain-JSON mutations, unsafe path-shaped frozen modules, symlink/non-private storage, corrupt latest records, and unwritable hand-off fail with the specified channel and exit behavior; a post-rename directory-sync failure exposes only one complete pre- or post-settlement record while withholding stdout; and the packed package carries the store leaf.
The suite shall further fail unless every turn exposes a durable uncertain baseline before its first effect; a failed or killed turn remains uncertain with stdout empty; ordinary continuation refuses it; retry reads no stdin, reuses its byte-exact input, advances the attempt before effects, and settles only once; discard restores the exact prior bytes or deletes a fresh record without config or host work; and SIGINT, SIGTERM, and SIGHUP cleanly retire ownership before the executable re-raises them.
Mutation-sensitive store and real-child crash rows shall prove one writer, authoritative reread after selection, live/foreign/EPERM/malformed fail-closed behavior, same-host ESRCH recovery, persistent normal-release and stale-O tombstones, owner-exact mutation/release, and the delayed two-reclaimer interleaving in which R2 retires O and publishes N before R1 resumes yet R1 cannot move N and no third writer starts (verifying [[playbook-cli-18](#playbook-cli-18)], [[playbook-cli-22](#playbook-cli-22)], [[playbook-cli-23](#playbook-cli-23)]).

#### playbook-cli-27

When the integration suite exercises launch-time tuning through `--with`, the suite shall fail unless both front ends merge fragments in order over the same primary config; a fragment retuning one inline agent changes only that binding; scalar, sequence, and null collisions replace; the primary and overlays remain byte-identical; installed-cligent normalization rejects invalid adapter, model, instruction, effort, permission, layout, notification, and theme values before preparation/import; a legacy `reasoningEffort` normalizes only in the detached plan; interactive forwarding and headless Boss input contain no consumed `--with`; and the retired run-only binding flags fail with a shared-config migration diagnostic (verifying [[playbook-cli-19](#playbook-cli-19)], [[playbook-cli-25](#playbook-cli-25)], [[playbook-cli-26](#playbook-cli-26)]).

#### playbook-cli-30

When the integration suite gives either front end a top-level `run` block, the suite shall fail unless resolution exits `1` naming the retired key and shared inline replacement before preparation, registry import, readiness, host creation, spawn, or agent call; the same injected path and home environment shall resolve identically for both front ends; and an absent primary config shall seed the same starter rather than create an implicit direct-run lineup (verifying [[playbook-cli-28](#playbook-cli-28)], [[playbook-cli-29](#playbook-cli-29)]).

#### playbook-cli-31

When the integration suite runs the shipped compiled Captain through the actual headless shell/core boundary, the suite shall fail unless ordinary Boss text reaches the compiled closed-set selection prompt and its accepted `respond` text becomes the sole reply; adapter-specific tool restriction, hidden-control envelopes, durable Captain calls, and result re-asks remain the same shell-owned behavior as interactive mode; and no replacement direct-host judge or Captain adapter is constructed (verifying [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-35

When the integration suite selects a configured playbook whose runtime factory rejects an unsupported compatibility declaration, the suite shall fail unless the shared Captain records that action failure and presents its grounded failure reply through the ordinary headless reply boundary without calling a player; where the same rejection occurs during host construction before a Boss turn, it shall instead produce the setup diagnostic and exit `1` (verifying [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-32

Where the live release gate writes top-level configs for its fixture repositories, when the normal
test suite runs, the test suite shall fail unless each of those exact
configs composes through the launcher against the real modules it
enables.
It shall fail unless the workflow config composes against the real CODE, REVIEW, and DECIDE registry modules and generates `code-coder`, `review-coder`, `review-reviewer`, `decide-coder`, and `decide-reviewer` with their expected adapters.
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

When the integration suite exercises configured filesystem registry preparation over synthetic host roots, the suite shall fail unless interactive and headless launches create the same missing `xstate` and `@sublang/playbook` links before import and use only their own single diagnostic prefix; an already-resolvable or already-provisioned module changes nothing; bare and custom specifiers are untouched; `--no-provision`, declared-install refusal, dangling replacement, occupied real or foreign-link refusal, complete-destination prevalidation, and filesystem failures preserve their guard outcomes; the core returns structured notices/errors; and no failed complete-catalog preparation imports any registry or calls an agent (verifying [[playbook-cli-36](#playbook-cli-36)], [[playbook-cli-37](#playbook-cli-37)]).

#### playbook-cli-41

When the integration suite exercises the adapter SDK preflight over an injected probe, the suite shall fail unless both front ends derive the same deduplicated adapter set from the normalized plan; available runtimes proceed; missing and unsupported runtimes block before host construction with cligent's exact pinned repairs and distinguish absence from version skew; credential and SDK failures report together; descriptor coverage includes `gemini` and precise `opencode` culprits; raw interactive `--config` bypasses the gate; and each adapter is probed at most once (verifying [[playbook-cli-40](#playbook-cli-40)], [[playbook-cli-39](#playbook-cli-39)]).
Where the run is in an ephemeral npm exec tree, the suite shall further fail unless stdin is drained before preparation, import, and readiness; the remedy includes every lineup SDK, the pinned running package, and the complete original run argv; consumed stdin is appended verbatim and shell-quoted behind one effective terminator; an already active terminator is reused; a `--` consumed as `--with`'s value is not mistaken for a terminator; and prerequisite CLI installs precede the replay (verifying [[playbook-cli-40](#playbook-cli-40)], [[playbook-cli-18](#playbook-cli-18)]).

#### playbook-cli-42

Where a packed candidate is installed without a top-level `tmux-play` executable, when the model-free installed-CLI gate invokes `playbook --help`, the gate shall fail unless the command resolves `@sublang/cligent/tmux-play` from the candidate's own dependency tree and the package declares the Node `>=20.6.0` floor required by its synchronous `import.meta.resolve` call (verifying [[playbook-cli-7](#playbook-cli-7)] and [[playbook-cli-43](#playbook-cli-43)]).

#### playbook-cli-45

Where REVIEW is enabled in the shared config, when the CLI integration suite sends `/review <request>` through `playbook run`, the suite shall fail unless the shared Captain binds both mapped roles, REVIEW reaches its approved terminal result, Captain presents the grounded reply, and no tmux session or presenter is created (verifying [[playbook-cli-44](#playbook-cli-44)]).

### Shared launch configuration verification

#### playbook-cli-47

When the integration suite exercises the shared launch-config pipeline over temporary primary configs, overlays, and synthetic registries and dry-packs the public package, it shall fail unless relative, absolute, file-URL, bare, and custom registry specifiers follow their defined resolution cases; installed-cligent normalization precedes every preparation/import; all preparation precedes every import; the prepared specifier, registry-authored manifest command, and frozen effective command reach interactive and headless projections; overlays and legacy-effort normalization leave source files unchanged; the plan is detached, deeply frozen, JSON-round-trippable, and free of imported functions; execution and presentation projections cannot mutate it; malformed host fields, authority-key smuggling, blank identities, collisions, accessors, sparse arrays, symbols, undefined values, non-finite numbers, cycles, and non-plain objects are rejected before external hooks; readiness derives from the plan; the leaf module has no host import and is re-exported compatibly; and the packed file list includes it (verifying [[playbook-cli-46](#playbook-cli-46)]).

#### playbook-cli-48

When the focused headless integration suite exercises argv, stdin, output, and failure boundaries over the actual shared shell/core, it shall fail unless help has no input/config/probe side effect; zero or one positional and `--` follow the exact grammar; stdin drains before prepare/import/readiness; a shipped compiled-Captain turn and deterministic nested CODE-to-REVIEW turn each emit one reply; JSON has only `sessionId` and `reply`; statuses and opt-in telemetry stay on stderr; output awaits persistence and stream backpressure; invalid config and host setup exit `1`; started-turn and zero, multiple, empty reply, or persistence failures exit `2`; the settled shell snapshot and full execution config exist before durable hand-off; successful hand-off performs no semantic disposal; and interactive/headless filesystem provisioning is equivalent (verifying [[playbook-cli-18](#playbook-cli-18)], [[playbook-cli-20](#playbook-cli-20)], [[playbook-cli-36](#playbook-cli-36)], [[playbook-cli-46](#playbook-cli-46)]).
