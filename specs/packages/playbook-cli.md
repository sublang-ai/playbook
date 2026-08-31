<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook-cli: Playbook CLI

## Intent

This package specifies the generic `playbook` launcher and non-interactive `playbook run` command, their configuration and provisioning behavior, the shared session store and replay stream they publish for other hosts, and integration verification.

## External Behavior

### Command

#### playbook-cli-1

Where `@sublang/playbook` is installed, the package shall expose a `playbook` executable.
When the user invokes `playbook` without `--config`, `--help`, `-h`, `--list`, or `--theme-diagnostics`, the command shall resolve its top-level config (seeding it when absent per [[playbook-cli-3](#playbook-cli-3)]), compose the Captain projection of [[playbook-cli-8](#playbook-cli-8)], run the launcher-owned readiness gate of [[playbook-cli-12](#playbook-cli-12)], and, when readiness passes, prepare and attach the gated managed tmux-play presenter ([[release-14](release.md#release-14)]) of [[playbook-cli-49](#playbook-cli-49)], consuming launcher-owned session, working-directory, provisioning, and overlay arguments rather than forwarding them.
The managed grammar shall accept only optional repeated `--with <path>`, optional `--no-provision`, optional `--cwd <path>` on a fresh launch, and one optional `--session <id>` selector, and shall reject unknown tmux-play options rather than forwarding them across the managed durability boundary.
When the user invokes `--theme-diagnostics` without `--config`, the command shall perform the same shared-config composition and readiness gate, launch the stock tmux-play diagnostic subprocess ([[release-14](release.md#release-14)]) with the composed config and inherited streams, consume launcher-owned overlay and provisioning arguments, and forward the remaining diagnostic arguments verbatim.
When the user supplies `--config <path>`, the command shall launch the stock tmux-play subprocess ([[release-14](release.md#release-14)]) with that path and inherited streams, bypass config seeding, composition, readiness, durable-session preparation, and managed attachment, reject every managed selector or overlay, and add no second config argument.

#### playbook-cli-2

When a raw-config or composed theme-diagnostic stock tmux-play subprocess exits, `playbook` shall exit with the same status code or re-raise the same signal on itself.
When `playbook` cannot spawn that stock subprocess, it shall print a diagnostic to stderr and exit with code `127`.
When managed preparation, child initialization or restoration, identity reporting, attachment, or required cleanup fails, `playbook` shall print the primary diagnostic plus any cleanup diagnostic, exit nonzero, and shall not reinterpret the failure as a stock subprocess status.
When a managed attachment completes normally or the outer client detaches while its pane child remains live, the outer command shall exit `0`; the pane child shall remain the durable session owner until its own shutdown under [[playbook-cli-49](#playbook-cli-49)].

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

Where the user authors the top-level generic config, the config shall keep tmux-play host fields at the top level and shall not wrap `playbooks`, `players`, `captain`, `layout`, `notifications`, or `theme` in a `config:` key.
The config shall declare concrete session players under one flat top-level `players` map and enabled playbooks under one top-level `playbooks` map, while retaining no top-level `profiles` map ([DR-032](../decisions/032-explicit-roles-session-players.md)).
The only accepted top-level keys shall be `captain`, `players`, `playbooks`, `sessions`, `layout`, `notifications`, and `theme`; the retired `run` key shall receive the migration diagnostic of [[playbook-cli-28](#playbook-cli-28)], and every other key shall be rejected before preparation or import.
Within a `playbooks.<id>` block, `from`, `command`, and `roles` shall be launcher-owned keys and every other key shall be that playbook's option slice; `from` is the explicit registry module specifier, `command` optionally overrides the playbook's default slash command, and the `<id>` key shall be the enabled playbook's own id, matching the registry module's manifest `id` under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)].
The enabled playbook id, effective command, player id, and local role id shall not equal the reserved internal name `captain`.
A player id shall match `[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*`; dots shall remain literal characters rather than config hierarchy.
Interactive and headless host projections shall preserve that exact id under [[playbook-cli-8](#playbook-cli-8)] and shall reject a host implementation that cannot represent the segmented grammar rather than mangle it.
A scalar `captain` or `players.<player-id>` value shall name an adapter shorthand such as `claude` or `codex`; a full block shall follow the host tmux-play agent-block schema and shall carry its own adapter and default model, effort, instruction, and permissions as needed.
Each `playbooks.<id>.roles.<role>` value shall be either a scalar player id or a block containing exactly `player` plus optional `model` and `effort`; each tuning override shall be a nonempty concrete string or boolean `false` selecting `provider-default`, omission shall inherit the top-level player default, and adapter, instruction, permissions, workspace, and tool settings shall be forbidden in a role binding.
Every binding shall resolve each model and effort field from its own override or the player default into an explicit concrete-value or provider-default selection, so each resumed call can reapply complete tuning rather than inherit another role's provider state.
Every enabled playbook's `roles` map shall cover its manifest `requiredRoleIds` under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)] exactly, and no role shall bind by matching names, ancestry, or an inferred fallback.
The roles in each manifest `concurrentRoleSets` member under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)] shall bind to pairwise-distinct player ids.
An unreferenced top-level player shall remain valid but shall enter neither the host roster nor readiness checks.
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

When the user invokes `playbook` with `--help` or `-h`, the command shall print its own help text to stdout, exit with status `0`, and shall not seed config, compose, run readiness checks, prepare a managed session, or launch a stock tmux-play subprocess.
The help text shall include the resolved top-level config path, the auth or CLI setup pointers for known adapters, and a recipe showing how to retune top-level `captain` and `players` blocks while binding each playbook role explicitly.
The help text shall distinguish fresh managed `playbook [--cwd <path>] [--with <path>...] [--no-provision]`, selected managed `playbook --session <id> [--with <path>...] [--no-provision]`, raw `playbook --config <path> [tmux-play arguments...]`, and composed `playbook --theme-diagnostics [diagnostic arguments...]` forms.
The help text shall state that only the fresh managed form accepts `--cwd`, that a selected form retains its stored working directory and accepts overlays only as opening current-config inputs, and that `playbook --session <id>` and `playbook run --session <id> [reply]` reopen one logical Captain session through [[playbook-cli-49](#playbook-cli-49)].
When the readiness gate of [[playbook-cli-12](#playbook-cli-12)] blocks a composed launch, the command shall print the same help content to stderr, additionally name every failing adapter id, exit nonzero with a status distinct from `127`, and shall not prepare a managed session or launch a stock tmux-play subprocess.

#### playbook-cli-49

When a managed interactive invocation has no selector, the outer front end shall generate a fresh public logical-session UUID, resolve an optional `--cwd` to a normalized absolute working directory or otherwise use its current working directory, resolve shared config plus opening overlays under [[playbook-cli-22](#playbook-cli-22)], and prepare a presenter whose Boss input gate remains closed.
Where a settled logical Captain session exists, when the user invokes `playbook --session <id>`, the outer front end shall reject `--cwd`, provisionally read the record only to select its stored members and working directory, resolve compatible current config plus opening overlays under [[playbook-cli-22](#playbook-cli-22)] without preparing or importing a registry, and prepare a presenter for the same public id; that provisional read shall confer no lease or mutation authority.
The managed pane child shall acquire the exclusive writer lease under its own process identity and authoritatively reread the absent fresh target or selected settled record; before any registry import, it shall validate the public id, working directory, structural projection, and current execution projection; it shall prepare the complete retained catalog before importing any member; and it shall validate every imported manifest identity and registry-owned runtime option before restoration completes, model work, turn-zero publication, or Boss-input readiness under [[playbook-cli-23](#playbook-cli-23)].
After those authoritative compatibility checks and under that same child-owned lease, the managed host shall reconstruct incomplete effect boundaries under [[playbook-cli-63](#playbook-cli-63)], require the recovered synchronous mirror and atomic write-ahead channel, assemble the same current artifact-specific schema-3 repository and ledger capabilities as the headless host under [[playbook-cli-20](#playbook-cli-20)], and pass them only through the shared shell construction boundary; absent writer authority, a logical-session mismatch, lost lease ownership, or failed recovery shall fail before shell initialization or restoration and before readiness.
The child launch descriptor shall be one owner-only, singly linked regular file at the exact managed work-directory basename; the child shall open it without following links, validate its exact public identity and nonoverlapping managed-control and durable-store topology through that opened inode, consume that same inode once before registry import or host work, and reject every path, owner, mode, link, identity, or replacement mismatch failure-atomically.
The descriptor shall carry the managed launch context's required `workDirOwnedByLauncher` boolean unchanged to the direct child runner, without deriving authority from a filesystem marker whose private format belongs to Cligent; that runner shall corroborate the public authority before recursive cleanup under [[release-14](release.md#release-14)].
For a fresh target, the child shall initialize the shared shell of [[playbook-cli-20](#playbook-cli-20)], ask the store to publish its complete turn-zero settled record and transfer any predecessor in the one guarded initialization of [[playbook-cli-53](#playbook-cli-53)], then install the resulting target map exactly once through [[playbook-captain-46](playbook-captain.md#playbook-captain-46)] before reporting readiness.
For a selected target, the child shall restore that shell and the stored working directory while applying the compatible current tuning selected by [[playbook-cli-22](#playbook-cli-22)], then install the selected record's retention map exactly once through [[playbook-captain-46](playbook-captain.md#playbook-captain-46)] before reporting readiness.
The managed presenter shall report a prepared launch only after child initialization or restoration and input-handler installation complete with the Boss input gate still closed, and the outer front end shall verify the returned public id, drain exactly one matching `playbook: session <id>` stderr line, and only then begin attachment and open Boss input.
For a fresh target, after accepting matching child readiness, the outer front end shall require the returned work directory to equal the private path embedded for that child, atomically claim the fixed readiness-witness path there, and persist the exact session-id witness before reporting that operational line, while the child shall atomically claim the same absent path before retracting an unused empty target at shutdown.
Where the child abandonment claim wins, the outer front end shall cancel the prepared launch without an operational line or attachment; where the outer readiness claim wins, coordination-directory cleanup, client detachment, and later child shutdown shall preserve the settled session record.
A descriptor, identity, authoritative-read, initialization, or restoration failure before successful reporting shall withhold a completed operational report, attachment, and Boss input; cancel the prepared child when one exists; await its shutdown and lease cleanup; and preserve the primary failure while reporting any secondary cleanup failure.
A signal or failure after the operational line has drained but before native-client hand-off may leave that one valid line visible for the durably initialized session, but shall abort attachment, join the child, open no Boss input, and retire the lease without deleting or corrupting the settled record.
While a managed interactive launch has not transferred native-client ownership, the outer front end shall retain SIGHUP, SIGINT, and SIGTERM handlers, record the first signal, abort the prepared attachment through its activation signal, await managed child shutdown, acknowledgement, Boss-pane exit, and coordination cleanup, and only then remove its handlers and re-raise that exact signal.
When the prepared attachment synchronously invokes its native-client hand-off callback, the outer front end shall remove those handlers and mark ownership transferred before the inherited-terminal tmux client starts, after which it shall neither request managed cancellation nor re-raise a signal handled by the native client or session.
The pane child, not the attached outer client, shall retain exclusive ownership across turns and client detachments until child shutdown or an explicit durable hand-off.
Before every submitted nonempty Boss turn, the child shall durably mark the record uncertain; only one matching nonempty reply, one accepted `turn_finished` terminal, one safe shell snapshot, and successful atomic settlement may open that turn's reply gate under [[playbook-cli-23](#playbook-cli-23)].
A `turn_aborted` terminal, absent or mismatched terminal or reply, host or snapshot failure, or settlement failure before that fence shall withhold the reply, leave the complete record uncertain once write-ahead returned, and shut down the child after joining active work and releasing its lease.
Where an accepted `turn_finished` turn reaches durable settlement but ordered reply release or a later shutdown step fails, the child shall preserve the complete settled record, shut down, and shall not rewrite the session to uncertain; presentation may already have begun according to the ordered observer dispatch boundary.
A signal observed by the lease-owning child before settlement shall abort active work and preserve the uncertain record; a signal racing noncancellable settlement may leave the record settled; either case shall withhold the interrupted reply, join child work, retire the lease, and re-raise that signal as specified by [[playbook-cli-23](#playbook-cli-23)].
The managed interactive command shall reject `--continue`, uncertain-session recovery flags, a selected `--cwd`, a session selector combined with raw `--config`, `--list`, or theme diagnostics, and repeated or otherwise combined selectors before config resolution, lease acquisition, import, or host work, and it shall never create a second logical session merely because presentation changed.
The durable session shall impose no age, turn-count, completed-root-count, or model-change limit while provider continuation and stored compatibility remain valid.

### Non-interactive run

#### playbook-cli-18

When the user invokes `playbook run [input]` without a continuation selector, the command shall create one logical session over the same configured compiled Captain, catalog, nested engagement stack, and players as interactive `playbook` ([[playbook-cli-20](#playbook-cli-20)]).
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

Where REVIEW is enabled with explicit `coder` and `reviewer` role bindings, when the user invokes `playbook run "/review <request>"`, the shared Captain shall run REVIEW as a root engagement and print Captain's grounded reply without requiring CODE or DECIDE to be active.

#### playbook-cli-19

Where `playbook run` resolves Captain, players, and role bindings, it shall use the same normalized top-level `captain`, top-level `players`, and `playbooks.<id>.roles` blocks as interactive `playbook`, including every effective per-call override ([[playbook-cli-4](#playbook-cli-4)]).
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

Where a complete logical Captain session has been persisted ([[playbook-cli-23](#playbook-cli-23)]), when the user invokes `playbook run --continue [reply]`, the command shall select the newest valid durable record whose stored normalized absolute working directory equals the normalized invoking working directory and submit the exact argument or verbatim UTF-8 stdin text as its next Boss turn; where no such record exists, it shall select the globally newest valid record and print one stderr notice that no same-directory Captain session exists for the invoking working directory, naming the selected session id and stored working directory ([DR-041](../decisions/041-working-directory-aware-continuation.md)).
When the user invokes `playbook run --session <id> [reply]`, the command shall select that logical session explicitly without applying the working-directory preference or fallback notice; `--session` and `--continue` shall be mutually exclusive.
Ordinary continuation shall restore the complete Captain shell through [[playbook-cli-20](#playbook-cli-20)], keep its stored normalized absolute working directory, enabled catalog, and structural projection authoritative, and resolve the current shared config plus any invocation overlays before the next call.
After restoration and before retry marking, ordinary turn marking, or Boss work, the command shall install exactly once the selected record's `retainedGenerations` map through [[playbook-captain-46](playbook-captain.md#playbook-captain-46)], interpreting an absent member as an empty map.
Before launcher validation, registry preparation or import, readiness, or host normalization, the command shall project that current config to the stored playbook ids, Captain, and players referenced by the stored catalog; require every retained manifest, effective command, runtime option, required role, concurrent role set under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)], exact role-to-player id, adapter, instruction, and permission to match; and perform no work for additional current playbooks or their additional players.
The command shall use current normalized model and effort for the stored identities on the next call and shall fail without a fresh fallback when the provider rejects those settings on the stored token.
`--json`, `--verbose`, the one-input grammar, output-channel rules, and readiness gate shall apply as on a new turn.
An uncertain record shall never be continued automatically.
The command shall exit `1` before host or agent work and print the exact explicit `playbook run --session <id> --retry-uncertain` and `playbook run --session <id> --discard-uncertain` remedies, warning that retry may duplicate external effects and discard abandons the attempted turn.
Both recovery flags shall require one explicit `--session <id>`, be mutually exclusive, reject positional input, and never read stdin.
Retry shall apply the whole-turn repository reconciliation fence of [[playbook-cli-67](#playbook-cli-67)]; only an authorized replay shall restore the saved source state, reuse the exact stored input and attempted config, durably increment the attempt before effects, and follow the normal settlement boundary without applying current config or overlays.
Discard shall run no config, preparation, import, readiness, host, or agent work and shall either restore the exact prior settled boundary only when the authoritative ledger still equals its pre-turn checkpoint, or durably delete a compatible pre-turn-zero never-settled fresh session with that same equality; a monotonic ledger extension shall reject discard rather than erase effect evidence, and because discard presents no turn it shall also reject the inert `--json`, `--verbose`, and `--no-provision` flags.
The retired `resume <session-id>`, `--last`, and runtime-only snapshot formats shall not select a shared Captain session.
An explicitly selected released Captain-session record schema `2` shall receive an incompatible-player-identity diagnostic rather than an inferred conversion to record schema version `6`.
An explicitly selected shell snapshot schema `1` or runtime snapshot schema `1` or `2` shall receive an incompatible-player-identity diagnostic rather than an inferred conversion to its respective schema version `4`.
A record schema `3`, historical schema `4`, or either otherwise valid pre-release schema-`5` shape shall receive no inferred migration and shall reject before registry construction or governed work; the earlier schema-`5` shape lacks required `unresolvedEffects`, while the later shape carrying that member still predates the canonical schema-`6` record boundary.
When implicit `--continue` scans the durable store, it shall report and skip each fully validated released record schema `2`, `3`, or `4` and each recognized pre-release schema-`5` record by exact session id and path with the same applicable incompatibility or effect-authority-cutover reason as explicit selection and an archive-or-remove remedy; complete canonical schema `6` shall remain selectable, while other malformed or unsafe records and unknown schemas remain fail-closed.

#### playbook-cli-28

Where the shared config at the resolved top-level path carries the retired top-level `run` key, when either front end resolves the config, the command shall reject it before preparation, import, readiness, or host creation.
The diagnostic shall name the removed `run` key and direct the user to the shared top-level `captain`, top-level `players`, and `playbooks.<id>.roles` blocks.
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
`TuningSelection` shall be exactly `{ kind: 'value'; value: string } | { kind: 'provider-default' }` and shall map without loss to cligent's public complete-call setting selection.
Each normalized `captain.options.playbooks.<id>` entry shall carry the canonical prepared `from`, normalized effective `command`, exact `roles: Readonly<Record<roleId, { playerId: string; model: TuningSelection; effort: TuningSelection }>>`, and an `options` slice built from every non-launcher key of the block; `from`, `command`, and `roles` shall not appear in the option slice.
`hostCapabilities` shall be a reserved host-owned key and shall be rejected rather than copied into that configured option slice.
`PermissionPolicy` shall be the exact normalized cligent shape `{ mode?: 'auto' | 'bypass'; fileWrite?: 'allow' | 'ask' | 'deny'; shellExecute?: 'allow' | 'ask' | 'deny'; networkAccess?: 'allow' | 'ask' | 'deny'; writablePaths?: readonly string[] }`.
The launcher shall also set `captain.options.sessionAgents` to exactly `{ captain: SessionAgent; players: Readonly<Record<playerId, SessionAgent>> }`, where `SessionAgent` is the normalized top-level default `{ adapter: string; model: TuningSelection; effort: TuningSelection; instruction?: string; permissions?: PermissionPolicy }`, `players` contains exactly referenced ids, and each role's independently resolved model and effort remain in its own binding; the shell uses the agent envelope plus that binding to form cligent's atomic complete-call settings for player calls under [[playbook-captain-10](playbook-captain.md#playbook-captain-10)], Captain calls under [[playbook-captain-31](playbook-captain.md#playbook-captain-31)], and durable envelopes under [[playbook-captain-41](playbook-captain.md#playbook-captain-41)].
The command shall resolve a scalar `captain` or `players.<player-id>` value as an adapter shorthand and shall normalize a full block as a self-contained tmux-play agent block through the installed cligent loader ([DR-021](../decisions/021-inline-agent-settings.md)).
Before composing, the command shall reject — with a path-named
diagnostic naming the offending key and the inline replacement, and
without launching — a top-level `profiles` map or any `captain` /
`players.<player-id>` block carrying a `profile` key that survives the
[[playbook-cli-33](#playbook-cli-33)] migration, such as one introduced by a `--with`
overlay, because a scalar that formerly named a profile now reads as an
adapter shorthand and would otherwise fail far downstream as an unknown
adapter.

#### playbook-cli-9

Where `playbook` composes the runtime config, the command shall generate the top-level tmux-play roster as the ordered union of player ids referenced by enabled playbook role bindings, with one host player per exact id and no entry for an unreferenced player.
Two roles naming the same player id shall use that one host player and continuation lane, while two distinct ids shall remain separate even when their agent blocks are equal.
The command shall import each enabled playbook's `from` module to read
its registry entry manifest
([[playbook-captain-5](playbook-captain.md#playbook-captain-5)]) and, before launching
tmux-play, shall reject — with a diagnostic and without launching — a
missing `from`, a failed import, a module exposing no valid registry
entry, a `playbooks.<id>` config key that does not equal the imported
manifest's `id`, two playbooks sharing an `id`, two playbooks
resolving to the same effective command, an enabled playbook id or effective
command equal to the reserved internal name `captain`, an artifact schema other than exactly `3`, a missing or malformed exact plain-data `runtimeProfile`, disagreement between the advertised artifact schema and either a shared-factory profile's safe-integer `{ artifactSchema, runtimeAbi }` compatibility declaration or a bespoke profile's safe-integer `artifactSchema`, a player id or local role id `captain`, two manifest role names that collide after canonical lowercase derivation, or `captain` in
a manifest's `requiredRoleIds`, `concurrentRoleSets`, top-level `players`, or `playbooks.<id>.roles` map —
`captain` is reserved for the tmux-play host Captain, and the
diagnostic shall name whether the reserved collision is an internal playbook
name or player/role identity — a manifest `requiredRoleIds`
entry that is missing from the exact role-binding map, a malformed concurrent role set, a role binding naming an unknown player, an extra configured role, or two roles in one concurrent role set bound to the same player id.
An enabled playbook whose manifest requires no roles shall carry the exact empty `roles: {}` map and contribute no player to the referenced roster; the launcher shall not invent a visible role or fallback player for it.
At runtime `init` the Playbook Captain shell re-validates only the loading checks it shares with [[playbook-captain-16](playbook-captain.md#playbook-captain-16)] and the registry-schema checks under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)] — missing `from`, failed import, invalid entry, an absent or non-`3` artifact-schema advertisement, a missing or malformed exact plain-data `runtimeProfile`, disagreement between the artifact-schema advertisement and runtime profile, key / manifest-`id` mismatch, duplicate id, duplicate effective command, and the reserved playbook id and effective command.
The roster-resolution, reserved-role, exact-binding, and concurrent-player checks above
are launcher-owned
([DR-009](../decisions/009-generic-playbook-cli-and-registry.md) §4);
the shell relies on that validation and treats any residual
`setVisiblePlayers` rejection as an internal or composition error
([[playbook-captain-22](playbook-captain.md#playbook-captain-22)]) rather than
re-validating the roster itself.

#### playbook-cli-10

Where `playbook` composes the runtime config, the command shall set the composed tmux-play `layout.initialVisible` from the first enabled playbook with any bound players, using that playbook's distinct player ids in role order, and shall own that field even when the user config sets other `layout` fields; a catalog whose playbooks are all exactly roleless shall retain an empty host-neutral visible set without inventing a player.
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
The starter shall define players `dev.coder` and `dev.reviewer`; CODE shall bind `coder` to `dev.coder`, while REVIEW and DECIDE shall bind `coder` to `dev.coder` and `reviewer` to `dev.reviewer`.
The seeded lineup shall configure Captain with adapter `claude`, model
`claude-opus-4-8`, and reasoning effort `high`; Coder with adapter
`claude`, model `claude-opus-4-8[1m]`, and reasoning effort `xhigh`;
and Reviewer with adapter `codex`, model `gpt-5.5`, and reasoning
effort `xhigh`.
The starter config shall carry no `profiles` map: Captain settings shall be inline under top-level `captain`, player settings shall be inline under top-level `players`, and each playbook shall contain only explicit role bindings ([DR-032](../decisions/032-explicit-roles-session-players.md)).
Every seeded agent — the Captain and both players — shall set
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
`captain.adapter` and every referenced player's `adapter` — and treat
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
The execution-only projection shall be detached and JSON-safe and shall retain the normalized Captain, referenced players, explicit role bindings, and complete catalog identity — id, canonical prepared `from`, artifact schema, manifest command, effective command, intent, required roles, concurrent role sets under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)], and configured options — while excluding layout, notifications, theme, and every live host capability, function, or handle.
After the selected configured-option and working-directory compatibility checks succeed under the current logical-session lease, the headless host shall first require that lease's session id to equal the selected logical id, then resolve that working directory's canonical Git identity once, require the lease-owned atomic effect-ledger writer and synchronous detached mirror of [[playbook-cli-63](#playbook-cli-63)], and assemble one frozen artifact-specific capability per catalog id from the current session id and owner token, detached manifest roles and cohorts, bound repository observer and coordinator, mirror, and writer; an absent writer or mismatched lease shall reject before shell construction ([[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)], [[playbook-runtime-67](playbook-runtime.md#playbook-runtime-67)], [[playbook-cli-23](#playbook-cli-23)], [[playbook-cli-57](#playbook-cli-57)]).
The shell shall receive each catalog entry's effective command explicitly, so neither front end can silently re-read a changed registry default after planning.
The host shall use the normalized Captain config and one `{ id, ...agent }` entry per referenced player, the same adapter imports and working directory as the launch plan, and the shell's ordinary role binding, player continuation, Captain, nested-call, status, telemetry, and presentation boundaries.
The command shall observe only host records: it shall buffer `captain_reply`, send `captain_status` to stderr, send only telemetry topic names to stderr under `--verbose`, and never write player or Captain events directly to stdout.
The command shall submit exactly one Boss turn, require exactly one non-empty matching reply after it settles, and export the complete shell snapshot ([[playbook-captain-41](playbook-captain.md#playbook-captain-41)]) before durable hand-off or stdout presentation.
For a new session, the public logical `sessionId` shall be a fresh UUID distinct from every internal Captain and playbook runtime UUID; a restored session shall retain its existing public id.
Headless driving and stdout presentation shall be separate operations so a persistence layer can durably hand off the snapshot before releasing the buffered reply.
Where a restored snapshot is supplied by a continuation layer, the core host's one `captain.init(session)` call shall dispatch to `shell.restore(session, snapshot)` instead of `shell.init(session)` ([[playbook-captain-42](playbook-captain.md#playbook-captain-42)]), because a shell must be fresh when restored.
Host setup or initialization failure shall exit `1`; once the Boss turn starts, turn, reply, snapshot, persistence, safe failure-disposal, and output failures shall exit `2`.
After a successful durable hand-off, the one-turn process shall not invoke semantic host or shell disposal, because the stored logical session remains continuable; process exit owns only ephemeral transport teardown.
The normal CLI entry shall allow stdout and stderr to drain before process exit, and a backpressured buffered reply shall not report success before the stream's drain boundary.

#### playbook-cli-23

Before every new, continued, or explicitly retried headless Boss turn, the command shall atomically persist an uncertain write-ahead record under the resolved sessions directory of [[playbook-cli-78](#playbook-cli-78)]; after a nonempty turn settles, it shall atomically replace that marker with the complete settled logical Captain session and durably retire the exclusive lease before releasing buffered stdout under [[playbook-cli-18](#playbook-cli-18)].
Before a fresh managed interactive session created through [[playbook-cli-49](#playbook-cli-49)] accepts Boss input, its lease-owning pane child shall atomically persist the complete settled turn-zero record under the same store contract.
Before each submitted nonempty managed interactive turn, that child shall atomically replace the settled record with the same uncertain marker; only its matching terminal `turn_finished`, one matching nonempty reply, safe shell snapshot, and successful atomic settled replacement shall release the reply, and the child shall retain its exclusive lease across turns and outer-client detachments until shutdown or durable hand-off.
The managed pane child shall own the lease and host lifetime; the presenter shall dispose the runtime before lifecycle shutdown releases the lease, and a host-construction rollback or runtime-disposal failure that cannot prove host retirement shall leave the canonical lease quarantined until process death rather than admit another writer.
Each store-owned filename shall be the canonical lowercase `<session-id>.json`; the embedded id shall equal that filename, the managed sessions directory shall be a real non-symlink directory with mode `0700`, and every record shall be a regular non-symlink file with mode `0600`.
The canonical record shall be a closed, strictly plain-JSON Captain-session schema version `6`, distinct from the released direct-run-only, root-owned-player, pre-effect-ledger, and pre-unresolved-effects boundaries.
A settled record shall contain exactly `schemaVersion`, `kind`, `state`, `sessionId`, `createdAt`, `updatedAt`, `cwd`, `structuralProjection`, `lastAppliedExecutionProjection`, `snapshot`, required `effectLedger`, and required `unresolvedEffects`, with optional `retainedGenerations` and `settledAbandonment` members; an uncertain record shall contain those same common fields, optional `retainedGenerations`, optional prior-settlement `settledAbandonment`, and exactly one `uncertain` member.
The required `effectLedger` shall be the exact schema-version-1 value of [[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)]; a settled record shall require it to equal its schema-version-4 shell snapshot member, while an uncertain record shall require it to be a monotonic extension of the immutable pre-turn shell-snapshot checkpoint, admit boundaries from the current or an earlier attempt only, require every current-attempt-number boundary to carry the marker's attempt id, and require each earlier attempt number to carry one stable UUID distinct from every other attempt.
The required `unresolvedEffects` shall be the exact ordered bounded list of [[playbook-captain-58](playbook-captain.md#playbook-captain-58)] and shall obey the persistence, abandonment, and recovery invariants of [[playbook-cli-71](#playbook-cli-71)].
Record schemas `3` and `4` and both otherwise valid pre-release schema-`5` shapes shall receive no migration; the earlier schema-`5` shape shall use its closed key set without `unresolvedEffects` or abandonment members, the later shape shall use the canonical closed members now carried by schema `6`, and either fully validated shape may be classified as nonresumable for implicit selection or unrelated fresh discovery, while explicit selection and every direct pre-ledger shell or runtime snapshot shall reject before registry import, runtime construction, source-state restoration, or governed work rather than fabricate or infer a current record boundary.
The structural projection shall be schema version `1` and shall retain exactly the normalized Captain and referenced-player adapter, instruction, and permission envelopes plus the complete catalog while omitting only model and effort; the last-applied and attempted execution projections shall be schema version `2` and shall retain those same envelopes with every model and effort represented explicitly as a tagged concrete value or `provider-default` selection.
Each projection's catalog entry shall retain exactly `id`, canonical prepared `from`, registry-authored `manifestCommand`, effective `command`, `intent`, artifact schema `3` under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)], required roles, concurrent role sets, exact role bindings, and the configured-only plain-JSON launcher option slice; `hostCapabilities` shall reject rather than participate in structural identity, execution identity, or continuation equality, and each execution role binding shall add its own complete tagged model and effort selections to the structural player id.
The live schema-3 capability and its atomic write-ahead adapter shall exist only behind the current lease-owning host boundary, shall be rebuilt after each process's authoritative compatibility checks, and shall never become a member of a settled or uncertain record, its projections, its shell snapshot, or its retained generations; only its detached acknowledged ledger data and canonical identities may occupy the exact versioned ledger members ([[playbook-captain-5](playbook-captain.md#playbook-captain-5)]).
The projection player roster shall equal the ordered distinct union of player ids referenced by catalog role bindings, including no unreferenced configured player and permitting an empty roster only when every enabled playbook is roleless.
An uncertain record's common snapshot shall be the complete pre-turn baseline and its ledger member shall be the immutable effect-ledger checkpoint for that attempt.
Its exact `uncertain` member shall contain `baseUpdatedAt`, `input`, `attemptId`, `attemptNumber`, `markedAt`, and `attemptedExecutionProjection`, carrying the prior settled `updatedAt` or null only for a compatible pre-turn-zero never-settled fresh session, exact input, UUID attempt id, positive attempt number, marker timestamp equal to the root `updatedAt`, and exact execution settings about to be used, and may additionally carry only the `abandonment` member of [[playbook-cli-71](#playbook-cli-71)].
A fresh headless turn-zero record shall use the initialized execution projection as its last-applied baseline, and its first uncertain marker shall use that same projection as the attempted projection; a continued marker shall retain the prior last-applied projection while recording the newly resolved current projection as attempted.
Retry shall preserve the baseline, input, prior-boundary identity, byte-exact attempted execution projection, and authoritative ledger while replacing the attempt id, incrementing the attempt number, and advancing the marker time; settlement shall promote that attempted projection to `lastAppliedExecutionProjection` only with a shell snapshot whose ledger equals the authoritative record ledger.
Creation time shall remain fixed for the logical session; every forward marker, retry, and settlement update time shall be strictly newer than its predecessor even when the wall clock is equal or moves backward.
Where an uncertain marker carries a prior settled boundary and its authoritative ledger still equals the snapshot checkpoint, explicit discard shall be its sole rollback and shall restore the exact prior settled `updatedAt` and bytes; any ledger extension shall reject discard without mutation.
A failure or shutdown after guarded fresh initialization but before the first headless marker or the managed readiness-claim boundary of [[playbook-cli-49](#playbook-cli-49)] may delete only that launch's byte-exact empty turn-zero record after safe host cleanup while the launch still owns it; a changed, nonempty, or ambiguously owned target shall remain durable.
The shell snapshot shall include the Captain runtime and durable conversation, Captain-session player ledger, recovery journal, issued internal UUIDs and counters, every active engagement frame with its exact role bindings and runtime snapshot, the complete effect-ledger mirror, pending nested-call identity, pending Boss questions, and last settlement evidence as applicable ([[playbook-captain-41](playbook-captain.md#playbook-captain-41)]).
The store shall detach and strictly validate every record and projection before registry preparation, import, host normalization, readiness, or model work, reject unknown or missing fields and noncanonical stored module or agent values, and require each execution projection to reproduce the structural projection exactly after erasing only model and effort.
It shall validate the snapshot through the public shell validator, require its ledger relationship to match its settled or uncertain state, require its Captain and player fixed envelopes and exact roster to match the structural projection, and require every active frame to name a stored catalog member with the exact stored role-to-player bindings; registry-owned option validation and normalization shall remain with shell initialization or restoration rather than comparing a normalized frame option value with the raw launcher slice.
The stored execution projections shall thereby retain the normalized Captain, referenced players, explicit role bindings, and complete catalog identity required by [[playbook-cli-20](#playbook-cli-20)], including the registry-authored default command, while separating live structural compatibility and an uncertain attempt's exact settings from model and effort tuning that ordinary continuation may refresh.
Persistence shall use an unpredictable same-directory `0600` exclusive temporary regular file, sync its contents, publish every fresh session's empty or transferred turn-zero settled record as the final target step of guarded initialization with an atomic no-replace operation, replace every later same-session state transition by atomic rename, and sync the containing directory as required for the platform contract; a fresh UUID shall never overwrite an existing record.
A failed headless write-ahead call before its durability operation returns shall keep stdout empty, dispose the host safely, print a setup diagnostic, and exit `1`.
Once a headless write-ahead call returns, every abort, signal, turn, capture, or settlement failure before atomic replacement shall leave the marker uncertain, keep stdout empty, dispose safely, and exit `2`; a successful settlement and lease retirement shall release the buffered reply without semantic disposal.
Where headless host construction rollback or failure disposal cannot prove host retirement, the command shall report the primary and cleanup failures, retain its canonical writer lease until process death, keep stdout empty, and preserve the setup-versus-started-turn exit class rather than admit another writer.
Where the complete settled replacement has been atomically renamed but syncing the containing directory reports failure, the command shall withhold the reply and report failure but shall not overwrite that complete visible replacement with the earlier uncertain marker.
A later process shall accept whichever complete pre-settlement or post-settlement record the filesystem retained across the durability failure; it shall never accept partial bytes or infer the boundary from the failed command's diagnostic.
Where a managed interactive before-turn write fails, the child shall withhold the reply and shut down after joining active work and retiring its lease; the record may remain at its prior settled value or a complete uncertain value according to the store's atomic durability boundary, but it shall never expose partial bytes.
Once a managed interactive before-turn write returns, `turn_aborted`, missing or mismatched terminal or reply evidence, host failure, unsafe snapshot, or settlement failure before atomic replacement shall leave the record uncertain, withhold the reply, and shut down after joining active work and retiring the lease.
Where an accepted interactive `turn_finished` reaches a successful settled replacement but ordered reply release or later cleanup fails, the record shall remain settled and shutdown shall not rewrite it to uncertain; presentation may already have begun according to ordered observer dispatch.
Every logical session shall have at most one cooperative writer.
The store shall acquire an exclusive, complete, nonempty, private per-session lease before the authoritative record read and shall verify the owner token before every record mutation and immediately before model work.
A live, foreign-host, permission-unknown, malformed, or non-private lease shall fail closed before host or agent work.
A lease may be reclaimed only when its recorded host is the current host and probing its PID definitively returns `ESRCH`; age alone shall never make a lease stale.
Normal release and stale reclaim shall both atomically rename the canonical lease directory to a permanent, nonempty, token-specific retired path and sync the sessions directory.
Retired paths are never reused or removed: two reclaimers that observed old token O therefore target the same occupied retired-O path, so an arbitrarily delayed reader cannot move, delete, or replace successor N.
Lease publication shall use a fully synced private staging directory with a synced `0600` owner record, atomic no-replace rename, and post-publication token verification.
SIGINT, SIGTERM, and SIGHUP observed by the lease-owning headless process or pane child before settlement shall abort active work and preserve the already-written uncertain record; a signal arriving during noncancellable atomic settlement may leave the record settled.
The lease-owning process shall in either case join active child work, retire its lease, withhold the interrupted reply, and then re-raise the signal.
A signal received by the non-owning outer interactive client before native-client hand-off shall abort the prepared attachment and await child retirement before re-raising, while a signal received after that hand-off shall not retire the pane child's lease.
SIGKILL may leave the uncertain record and canonical lease for the same-host dead-PID recovery rule.
Where [[playbook-cli-22](#playbook-cli-22)] explicitly selects a record, the command shall reject an unsafe id, missing or malformed record, unsupported schema, invalid stored projection, incompatible current projection of a stored structural member, or unrestorable shell snapshot ([[playbook-captain-42](playbook-captain.md#playbook-captain-42)]) with exit `1` before a Boss turn.
`--continue` shall validate every canonically named record before partitioning candidates, report and skip the exact nonresumable set of [[playbook-cli-22](#playbook-cli-22)], fail closed on any other malformed or unsafe record, a canonical record carrying a legacy artifact schema, or an unknown schema rather than silently falling back past corruption, and select within the same-working-directory pool or, when that pool is empty, the global pool by canonical `updatedAt` with a deterministic session-id tie-break; the global fallback shall emit the notice of [[playbook-cli-22](#playbook-cli-22)].
Ordinary continuation shall read current user config and explicit opening overlays, preserve the stored working directory and catalog, project to its stored playbooks and referenced players before validation or side effects, require every retained structural member to remain exact, and apply current model and effort to stored identities on the next call; uncertain retry shall instead use the attempt's exact stored projection.

#### playbook-cli-51

At each Captain-session settlement, the store shall atomically persist the required `unresolvedEffects` list and apply zero or more unique per-root retention updates in the same record replacement as the settled shell snapshot: retain replaces that enabled root's prior generation as one unit, clear removes it, and roots without an update remain unchanged.
Both front ends shall pass the snapshot, unresolved-effects list, and retention-update array from the shell's single `exportSettlement()` result ([[playbook-captain-44](playbook-captain.md#playbook-captain-44)]) unchanged to that one store settlement, so later host, shell, runtime, lease, or process disposal cannot change the recorded evidence or clear a retained generation.
Each retained generation shall contain one required capture-time `effectLedger` checkpoint and exactly one nonempty root-to-leaf frame stack of the shell's frame shape ([[playbook-captain-41](playbook-captain.md#playbook-captain-41)]), with each frame carrying its playbook and engagement identities, depth, options, role bindings, and active quiescent schema-4 runtime snapshot exported under [[playbook-runtime-45](playbook-runtime.md#playbook-runtime-45)]; the root shall match the map key, every frame shall name the stored catalog and required role set, every parent suspended-call descriptor shall exactly match its child edge, and the leaf shall be parked without a suspended child.
A retained generation may additionally carry an exact `retainedEffectReconciliation` source-generation marker and a nonblank `rootStateDescription`; either absence shall remain valid and mean respectively that the generation was not captured under a retained-effect fence or that no root-state description was retained.
The store shall require the record's authoritative ledger to be an exact or monotonic extension of every generation checkpoint; every frame mirror in an unmarked generation shall equal that checkpoint, while a marked generation shall preserve its original checkpoint and source generation and carry one common capture-time authoritative mirror that strictly extends the checkpoint, remains an exact or monotonic baseline of the record ledger, and has matching runtime markers in every frame under [[playbook-captain-54](playbook-captain.md#playbook-captain-54)].
The store shall reject final, nonquiescent, malformed, cyclic, duplicate-session, unknown-playbook, or dangling generations before persistence and shall never retain a final-state snapshot.
A proposed fresh turn-zero boundary shall begin with an empty retention map; guarded predecessor transfer under [[playbook-cli-53](#playbook-cli-53)] may make its first published record nonempty, uncertain marking and retry shall preserve the complete prior map, discard shall restore it byte-exactly, successful settlement shall replace or clear only the named roots, and process, lease, host, or runtime disposal shall not clear it.
A canonical schema-version-6 record may omit `retainedGenerations`; the store shall interpret absence as an empty map for explicit selection, latest-session selection, ordinary continuation, and retention updates while preserving the absent member through uncertain marking, retry, and exact discard.

#### playbook-cli-53

Where a lease owns an absent target id and has validated its proposed fresh settled turn-zero Captain-session boundary with an empty retention map under [[playbook-cli-51](#playbook-cli-51)], when the store selects its cross-session predecessor, the store shall choose the newest other settled compatible record with the same normalized working directory by canonical `updatedAt` and the deterministic session-id tie-break of [[playbook-cli-23](#playbook-cli-23)]; uncertain candidates and different-directory records shall be ineligible, while discovery shall leave intact and skip each nonresumable, malformed, unsafe, or unknown-schema canonical record without blocking the fresh target.
Each front end shall report every record skipped by fresh discovery once with its exact session id and path, applicable cutover or validation reason, and an archive-or-remove remedy.
A fully validated nonresumable record shall contribute its authenticated session id, lifecycle state, working directory, and update time only to predecessor ordering; a settled same-working-directory record shall decline adoption when it is the newest boundary, while an older or different-directory record shall not prevent adoption from a newer resumable predecessor.
A malformed, unsafe, unknown-schema, or otherwise unvalidatable store-owned record shall leave its working directory and predecessor order unproved, so initial discovery or an authoritative rescan shall publish the intentional empty target strictly after every valid settled same-working-directory predecessor boundary it can observe without falling through to older retained work.
The store shall select that predecessor before inspecting its optional retention map, so no predecessor or an absent or empty map publishes the proposed empty target without falling through to an older nonempty record, advancing that target after the selected predecessor when one exists.
The initial scan shall only nominate the predecessor; the store shall acquire that candidate's exclusive lease, authoritatively reread it, and rescan while that lease is held before publishing the target.
A candidate that disappeared or was superseded by another newest valid boundary during guarded initialization shall be declined, publish the proposed empty target strictly after every boundary observed, and neither retry nor fall through.
An initially nominated candidate proved to have a live lease shall likewise publish the proposed empty target and yield no transfer without falling through or blocking launch; foreign-host, permission-unknown, malformed, or otherwise unprovable ownership of that candidate shall fail closed with the target absent.
Before a nonempty transfer, the store shall hold the absent target's lease, authoritatively read the predecessor, rescan the candidates, require the selected boundary and target absence to remain exact, and verify both owner tokens immediately before each mutation.
The store shall validate the whole predecessor retention map of [[playbook-cli-51](#playbook-cli-51)] before mutation: every root id shall name the target catalog of [[playbook-cli-23](#playbook-cli-23)]; that root's canonical registry module identity, manifest command, raw options, required-role id sequence, and concurrent-role topology shall equal the predecessor exactly; and every retained frame's playbook shall exist with the same artifact schema in the target catalog.
Target Captain and player envelopes, model and effort selections, player identities, descendant raw options, role-to-player bindings, effective commands, and intents shall not participate in that generation-envelope comparison.
An exact generation-envelope mismatch shall decline adoption, leave the predecessor byte-exact, and publish the proposed empty target strictly after it without falling through or blocking launch.
A successful exchange shall move the complete detached retention map and the source record's complete authoritative effect ledger into the target's first record, clear only the complete source map while preserving the source ledger and source `unresolvedEffects`, keep the fresh target's `unresolvedEffects` canonically empty, and rebase only the target turn-zero shell's ledger mirror to that transferred ledger while keeping its internal Captain mirror empty; it shall transfer no compatible subset and shall change neither record's projections or lifecycle state nor any generation checkpoint, frame, marker, or unrelated member except `updatedAt`, and the source snapshot shall remain unchanged.
Before that exchange the store shall require every boundary and logical-operation playbook in the transferred ledger to name compatible schema-3 authority in the target catalog and every retained checkpoint to be its valid monotonic baseline under [[playbook-cli-69](#playbook-cli-69)]; an authority mismatch shall decline adoption with the source byte-exact and publish the intentional empty target under the existing envelope-mismatch rule.
Both publications shall use canonical schema version `6`, source clear shall advance its prior timestamp, and target install shall advance strictly after both its proposed timestamp and the source clear so the new owner is the next deterministic predecessor under [[playbook-cli-23](#playbook-cli-23)].
Malformed input, ambiguous ownership, target change before source publication, or write failure before either source or target publication may have occurred shall leave the predecessor unchanged and the target absent or preserve an intervening target byte-exact.
If the source-clear write reports failure after publication may have occurred, the store shall stop without restoring the source or installing the target.
After the source clear returns successfully, where the target-install write fails while definitively unpublished, the store shall reverify both owner tokens immediately before attempting to restore the exact pre-exchange source record.
The store shall report that transfer as failed whether the guarded source restoration succeeds or fails, and shall leave the target absent or preserve an intervening no-replace collision byte-exact.
Once target publication may have occurred, the store shall not compensate.
The guarded exchange shall publish the source clear before the target install, hold both leases through its final checks, and report success only after the target install and both post-write owner checks, so no failure boundary leaves the same generation transferable from both records.

#### playbook-cli-55

For a fresh `playbook run` target, after constructing the shared Captain shell, the command shall ask the store to publish its settled turn-zero record and transfer any predecessor in the one guarded initialization of [[playbook-cli-53](#playbook-cli-53)], then install the resulting target map exactly once through [[playbook-captain-46](playbook-captain.md#playbook-captain-46)] before its first uncertain marker or Boss and model work.
Across selected and uncertain-retry headless launches under [[playbook-cli-22](#playbook-cli-22)], managed launches under [[playbook-cli-49](#playbook-cli-49)], and fresh headless launches above, both front ends shall preserve the exact Boss text for the shared Captain and shall add no lexical resumption router ahead of its validated arbitration: a live engagement's action wins, explicit valid fresh-start intent wins over an installed offer, and a bare continuation request with an advertised generation selects its `resume` action ([[captain-playbook-23](captain-playbook.md#captain-playbook-23)] and [[playbook-captain-47](playbook-captain.md#playbook-captain-47)]).
A definitively live, disappeared, or superseded predecessor or deterministic generation-envelope mismatch shall install an empty map and continue fresh without retrying or falling through, and a cleanup-safe retained-runtime construction rejection shall omit only its affected offer under [[playbook-captain-46](playbook-captain.md#playbook-captain-46)] without blocking either front end.
If guarded initialization, transfer, structural installation, or cleanup fails otherwise, the front end shall perform no Boss work, the managed child shall expose no readiness, and both shall preserve the target absence or complete settled target and transfer ownership outcome already established by [[playbook-cli-53](#playbook-cli-53)].
After safe host cleanup, a headless launch shall retract its own byte-exact empty turn-zero target when a later pre-marker failure aborts launch; a managed launch shall retract directly when child initialization fails before readiness can be published and shall otherwise retract only by winning the child-shutdown claim before the accepted-readiness witness of [[playbook-cli-49](#playbook-cli-49)]; either front end shall preserve a changed, nonempty, or ambiguously owned target.

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
The normalized model and effort shall reach both interactive and headless execution projections unchanged and may refresh from current config on an ordinary reopen; normalized instruction and permissions shall also reach both projections unchanged but shall remain structurally equal to the saved session; an uncertain retry shall retain every attempted setting exactly per [[playbook-cli-23](#playbook-cli-23)].

#### playbook-cli-29

Where either front end creates a session or ordinarily reopens a settled session, the command shall use the same resolved or injected user-config path, primary-relative registry canonicalization, seeding, migration, opening overlays, and installed-cligent normalization ([[playbook-cli-3](#playbook-cli-3)], [[playbook-cli-46](#playbook-cli-46)]).
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
Where any `playbooks.<id>.players` block remains, the command shall reject it before profile migration with a major-version diagnostic requiring explicit top-level player ids and `playbooks.<id>.roles`; it shall not choose session-sharing semantics by rewriting that block.

### Shared session store

#### playbook-cli-73

Where the package publishes the shared session store, `@sublang/playbook/session-store` shall have exactly the JavaScript named exports `RECORDS_STREAM_VERSION`, `defaultSessionsDir`, and `openSessionStore`, with no default export.
Its self-contained declaration shall import nothing, shall export exactly those three values plus `ReplayJsonValue`, `ReplayRecord`, `ReplayStreamEntry`, `ReplayStreamReadOptions`, `ReplayStreamReadResult`, `LeaseReplayStreamReadResult`, `ReplayStreamStatus`, `PlaybookSessionSummary`, `SkippedPlaybookSession`, `PlaybookSessionListResult`, `PlaybookSessionStore`, and `PlaybookSessionLease`, and shall assign them these exact signatures:

```ts
export declare const RECORDS_STREAM_VERSION: 1;
export declare function defaultSessionsDir(): string;
export declare function openSessionStore(
  sessionsDir: string,
): PlaybookSessionStore;

export type ReplayJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReplayJsonValue[]
  | ReplayRecord;
export type ReplayRecord = {
  readonly [key: string]: ReplayJsonValue;
};
export interface ReplayStreamEntry {
  readonly v: 1;
  readonly seq: number;
  readonly role?: string;
  readonly record: ReplayRecord;
}
export interface ReplayStreamReadOptions {
  readonly afterSeq?: number;
}
export interface ReplayStreamReadResult {
  readonly entries: readonly ReplayStreamEntry[];
  readonly lastReadableSeq: number;
}
export interface LeaseReplayStreamReadResult
  extends ReplayStreamReadResult {
  readonly lastDurableSeq: number;
  readonly incomplete: boolean;
}
export type ReplayStreamStatus =
  | {
      readonly lastReadableSeq: number;
      readonly lastDurableSeq: number;
      readonly incomplete: boolean;
    }
  | {
      readonly lastReadableSeq: null;
      readonly lastDurableSeq: null;
      readonly incomplete: true;
    };
export interface PlaybookSessionSummary {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly state: 'settled' | 'uncertain';
  readonly cwd: string;
  readonly updatedAt: string;
}
export interface SkippedPlaybookSession {
  readonly sessionId: string;
  readonly reason: string;
}
export interface PlaybookSessionListResult {
  readonly sessions: readonly PlaybookSessionSummary[];
  readonly skipped: readonly SkippedPlaybookSession[];
}
export interface PlaybookSessionStore {
  readonly sessionsDir: string;
  list(): Promise<PlaybookSessionListResult>;
  read(sessionId: string): Promise<PlaybookSessionSummary>;
  readStream(
    sessionId: string,
    options?: ReplayStreamReadOptions,
  ): Promise<ReplayStreamReadResult>;
  acquire(sessionId: string): Promise<PlaybookSessionLease>;
}
export interface PlaybookSessionLease {
  readonly sessionId: string;
  readonly ownerToken: string;
  append(record: object, role?: string): Promise<void>;
  readStream(
    options?: ReplayStreamReadOptions,
  ): Promise<LeaseReplayStreamReadResult>;
  streamStatus(): ReplayStreamStatus;
  release(): Promise<ReplayStreamStatus>;
}
```

Each `defaultSessionsDir()` call shall resolve and return the exact unset-key directory of [[playbook-cli-78](#playbook-cli-78)] from the process environment at that call, while `openSessionStore(sessionsDir)` shall require an absolute directory and synchronously return the store capability.
`ReplayStreamReadOptions` shall have no other member: omitted options, an omitted `afterSeq`, or an own `afterSeq: undefined` data member shall mean `afterSeq: 0`, and every other supplied value shall be a nonnegative safe integer no greater than the stream's complete readable boundary.
Both `readStream` methods shall return complete version-1 envelopes rather than payloads alone; the lease-free result shall have exactly `entries` and `lastReadableSeq`, while a successful lease-bound result shall add exactly numeric `lastDurableSeq` and `incomplete`.
An unavailable writer's lease-bound read shall reject, while `streamStatus()` and `release()` shall return the exact null-boundary variant; `streamStatus()` shall be synchronous live state and `release()` shall resolve to the final status after its checkpoint attempt.
`append(record, role?)` shall accept one observed object and an optional role, shall return no sequence or status, and shall accept no caller-supplied envelope version or sequence because the writer owns both; the sanitizer of [[playbook-cli-75](#playbook-cli-75)] shall remain the runtime trust boundary, while the declaration shall neither import nor re-export Cligent's observed-record type.
For a numerically initialized writer whose live status has `incomplete: false`, before invoking the sanitizer, assigning a sequence, or writing, `append` shall require the record argument to have JavaScript type `object`, be non-null and non-array, and require a supplied role to be a nonempty string.
Either argument-boundary rejection shall reject only the append promise, write no bytes, leave the whole live status unchanged without entering the latch, and keep a corrected append eligible for the same next sequence; once those checks pass, inability to produce a JSON-safe `ReplayRecord` remains the sanitizer failure of [[playbook-cli-75](#playbook-cli-75)] and latch-and-stop behavior of [[playbook-cli-76](#playbook-cli-76)].
After that argument boundary admits a call, the published lease shall serialize its sanitizer and append work through promise settlement in JavaScript invocation order under [[playbook-cli-76](#playbook-cli-76)] even when calls overlap, so callers need not await one append before invoking the next and each call retains its own promise outcome.
The invocation that begins `release()` shall synchronously close append admission, make every later `append` reject before argument validation, sanitization, sequence assignment, or I/O without changing live status, await settlement of every earlier `append` invocation regardless of outcome, and only then perform the applicable final checkpoint and canonical lease retirement of [[playbook-cli-23](#playbook-cli-23)]; its resolved status shall reflect every earlier call, and no replay append or checkpoint shall occur through that released lease after it resolves.
After that first release resolves successfully, the published lease shall retain its final status values: `streamStatus()` shall return them synchronously without I/O, every later `release()` shall resolve them without another checkpoint, ownership probe, retirement, or filesystem I/O, and `readStream()` shall reject before option validation or I/O because lease-bound durability and incompleteness are no longer live.
Every `sessionId` argument shall be a canonical lowercase UUID.
The facade shall reserve stable `Error.code` strings for exactly these two control-flow rejections, while their concrete classes, names, messages, and other properties shall remain noncontractual:

| Rejected operation | `code` |
| --- | --- |
| `read(sessionId)` when its canonical Playbook manifest does not exist | `PLAYBOOK_SESSION_NOT_FOUND` |
| `acquire(sessionId)` when a valid canonical lease of [[playbook-cli-23](#playbook-cli-23)] is held by a verified-live current-host process or a foreign host, or when a valid foreign-host or verified-live current-host winning owner is observed after a publication race | `PLAYBOOK_SESSION_LEASE_ACTIVE` |

An invalid argument, malformed or unsafe directory, manifest, or lease, current-host owner with an indeterminate process probe, or storage failure shall carry neither facade code.
Manifest absence shall not gate lease-free stream reading under [[playbook-cli-82](#playbook-cli-82)] or lease acquisition under [[playbook-cli-83](#playbook-cli-83)].

Validators, staging, publication, retirement, effect-ledger writing ([[playbook-cli-63](#playbook-cli-63)]), and every turn-lifecycle operation of [[playbook-cli-23](#playbook-cli-23)] — beginning a turn, beginning a retry, settling, discarding, and abandonment — shall remain unexported, so the published lease is a narrower handle than the internal one.
Listing shall consider only canonical lowercase `<session-id>.json` Playbook manifests, fully validate every such record through the private reader, return the summary above for each valid record, and report every skipped record with its filename-derived session id and a nonempty human-readable reason identifying the validation or cutover failure rather than fail the listing; direct summary reading shall perform that same validation, and a record below the current schema shall be rejected rather than migrated ([[playbook-cli-23](#playbook-cli-23)]).
The facade shall expose neither the canonical manifest nor its snapshot, provider resume tokens, structural or execution projections, effect ledger, recovery data, unresolved effects, or retained generations at any depth.
A replay stream or host-owned sidecar without that manifest shall not create a listable Playbook session, and every unrecognized host file shall remain unadopted, undeleted, and byte-identical.
The facade and both front ends shall use the same private store implementation and validators, so an external consumer applies the same validation the CLI applies rather than a copy of it, while the front ends retain their richer private lifecycle leases and need not use the facade as their access path.

#### playbook-cli-74

Where a session has a replay stream, that stream shall be one file beside the session record in the same sessions directory, under this frozen contract:

| Element | Contract |
| --- | --- |
| File | `<session-id>.records.jsonl`, a regular non-symlink file with mode `0600` in the mode `0700` real non-symlink sessions directory of [[playbook-cli-23](#playbook-cli-23)] |
| Envelope | one closed JSON object per line, `{"v": 1, "seq": <n>, "role"?: <string>, "record": <sanitized record>}`, with no missing required or unknown member |
| Record | one opaque recursively sanitized JSON object, preserved without interpreting or gating its `type` or members; a missing or non-object value shall be rejected as a malformed envelope |
| Sequence | assigned by the writer, contiguous from 1 across the session's whole life, so a reader may resume incrementally from a known sequence |
| Role | optional, naming the local Playbook role a player record's call served and distinct from the host player identity in `record.playerId` or `record.event.role`; when absent a reader needing roles refolds it from trace telemetry carrying the events of [[playbook-runtime-37](playbook-runtime.md#playbook-runtime-37)] |
| Readable content | the complete newline-terminated prefix, of which at most the final line may be torn |
| Version | a line whose `v` is missing or not `1` shall be rejected rather than migrated or skipped |

Because the writer assigns the sequence, contiguity shall be an invariant rather than a signal, and a missing sequence shall be malformed input rather than a loss report.
The store shall reject an incompatible mode, symlink, or non-regular file rather than relax the file and directory privacy boundary.
A trace bracket shall be observed as a `captain_telemetry` record whose `topic` is `playbook.trace` and whose `payload` is the schema-4 trace event of [[playbook-runtime-37](playbook-runtime.md#playbook-runtime-37)].
Because the CLI's explicit role bindings of [[playbook-cli-4](#playbook-cli-4)] reach runtime trace with their resolved host player identities under [[playbook-captain-10](playbook-captain.md#playbook-captain-10)], the Playbook writer shall key each active player-call frame by that event's `(sessionId, callId)`, retain its `payload.playerId` and `payload.roleId`, and close only the exactly matching frame; it shall add envelope `role` to each observed `player_prompt`, `player_event`, and `player_finished` only when the active frames for that player establish exactly one local role, and shall omit it from every other, malformed, or indeterminate record.

#### playbook-cli-75

Where the writer prepares a record for the replay stream, it shall write a token-free projection: it shall strip every `resumeToken` field at any depth and every string-valued `resume` selection of [[playbook-runtime-34](playbook-runtime.md#playbook-runtime-34)], including those in schema-4 trace-event payloads carried by `captain_telemetry` records with topic `playbook.trace` under [[playbook-runtime-37](playbook-runtime.md#playbook-runtime-37)], while retaining `resume: false` as semantics rather than as a token.
The session record's snapshot shall remain the only durable home for a provider resume token ([[playbook-cli-23](#playbook-cli-23)]), and the stream shall be insufficient to resume a conversation.
An entry whose record cannot be sanitized into JSON-safe data shall reject the append promise, be treated as an append failure, and not be written, causing the latch-and-stop behavior of [[playbook-cli-76](#playbook-cli-76)].

#### playbook-cli-76

Where the shared replay writer admits an append either after the published-lease argument boundary of [[playbook-cli-73](#playbook-cli-73)] or through either front end's richer private lease under [[playbook-cli-77](#playbook-cli-77)], and its numeric live status has `incomplete: false` under [[playbook-cli-83](#playbook-cli-83)], it shall place that call behind every earlier admitted call and serialize its sanitizer and append work through promise settlement in JavaScript invocation order, assigning the next sequence one past the then-current `lastReadableSeq` only when the call reaches the queue head.
The queue shall remain drainable after any call rejects, so calls already admitted shall settle according to the resulting live latch and the release barrier of [[playbook-cli-73](#playbook-cli-73)] shall drain them rather than inherit that rejection.
Every append invoked before release begins and suppressed by a live latch, whether already queued or invoked after the latch, shall resolve `undefined` without argument validation, sanitization, sequence assignment, or I/O and leave the live status unchanged.
When the writer first publishes the stream pathname, it shall synchronize the containing sessions directory before the first append promise resolves successfully.
Each successful completed append shall advance `lastReadableSeq` without advancing `lastDurableSeq`, and the writer shall synchronize accumulated completed lines as one content checkpoint after each successful private session-record settlement of [[playbook-cli-23](#playbook-cli-23)] and before a normal lease release returns; only a successful checkpoint shall advance `lastDurableSeq` to `lastReadableSeq`.
After a trustworthy numeric boundary is established, sanitization, append, first-publication directory-synchronization, torn-tail-repair, or content-checkpoint failure shall set `incomplete: true`, suppress every later replay append and checkpoint for that lease, and leave the numeric `lastDurableSeq` unchanged, but shall neither fail nor undo the agent turn, a successful private session-record settlement, or an otherwise valid canonical lease release.
The readable content shall remain the clean contiguous complete prefix of [[playbook-cli-74](#playbook-cli-74)], with only its permitted torn final line outside that prefix.
Where an append or content-checkpoint failure leaves complete visible lines beyond `lastDurableSeq`, the writer shall not roll them back, and the live reader shall derive `lastReadableSeq` from the actual complete prefix without repairing it.
Every successful lease-bound stream read shall return the complete readable prefix or its requested incremental suffix together with the writer's numeric `lastReadableSeq`, `lastDurableSeq`, and `incomplete`, and stream status shall report those same three live values; after latching, both shall report `incomplete: true` while the read still returns every requested complete line through `lastReadableSeq`.
A normal release of a numerically initialized writer shall, after the close-and-drain barrier of [[playbook-cli-73](#playbook-cli-73)], return its final numeric status after the applicable checkpoint attempt, including an incomplete status when that attempt fails.

#### playbook-cli-77

Where either front end hosts a Captain session, it shall tee every observed host record to that session's replay stream as the record occurs, registering its record observer outside the presentation gate so presentation drops or reorders nothing: the headless host through its own run observer, and the managed interactive pane child through the host observer list it forwards under [[playbook-cli-49](#playbook-cli-49)].
Successful teeing shall change neither buffered stdout nor stderr, nor the turn, reply, settlement, attachment, release, or exit outcome of [[playbook-cli-18](#playbook-cli-18)] and [[playbook-cli-20](#playbook-cli-20)].

#### playbook-cli-78

Where the shared launch configuration carries an optional top-level `sessions` key ([[playbook-cli-4](#playbook-cli-4)]), the launcher shall resolve it at bootstrap to the one sessions directory both front ends use, by these cases:

| Case | Resolution |
| --- | --- |
| Key unset | `${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions` |
| Leading `~` or `~/` | expanded from the home directory, with no `~user` form accepted |
| Absolute path | accepted as given |
| Relative path | every other non-absolute value, including bare `sessions/here` without `./`, is a filesystem path resolved against the primary config's directory |
| Per-launch overlay | overrides the primary value under [[playbook-cli-25](#playbook-cli-25)] |
| Explicitly injected store | takes precedence over the key |
| Unusable directory | prints a diagnostic and fails closed, launching nothing |

The key shall never enter a persisted structural or execution projection ([[playbook-cli-23](#playbook-cli-23)]), and where the key is unset the resolved directory shall equal the previous default exactly.

#### playbook-cli-82

A lease-free stream read shall pin one fresh filesystem snapshot per call: it shall validate the opened file's identity and the boundary of [[playbook-cli-74](#playbook-cli-74)], capture the snapshot byte length, read no bytes beyond it, and restart from a new snapshot or reject if replacement or truncation is observed during the operation rather than combine generations.
It shall return the complete readable prefix or its requested incremental suffix with only `lastReadableSeq`, equal to the final sequence of the whole prefix or `0` when the stream is absent or empty, and shall expose no `lastDurableSeq` or `incomplete` member, mutate nothing, and repair nothing because writer-live facts are not observable across processes.
For monotonic incremental reads, the store shall cache a fully validated newline-terminated boundary consisting of the opened-file identity, byte offset immediately after the final validated line feed, and final sequence; while that identity is unchanged and the snapshot length is not below the offset, it shall validate only bytes from that boundary and require the first new completed envelope to carry the next sequence.
It shall advance that cursor only after the whole newly completed suffix validates, shall never cache a torn final line as complete, shall reread such a tail from the preceding complete-line boundary, and shall reject an invalid suffix without returning partial history or advancing the cursor.
The reader shall neither inspect canonical lease ownership nor couple cursor validity to lease turnover, because a conforming writer under [[playbook-cli-76](#playbook-cli-76)] never rewrites a completed envelope and torn-tail repair under [[playbook-cli-83](#playbook-cli-83)] changes only bytes after the cached complete-line boundary.
Replacement or truncation below the validated offset shall invalidate the cursor and require validation from byte zero; if that validation does not preserve a complete prefix this store already observed, the live store shall reject the rollback, while a new store with no prior observation may accept the actual retained prefix.

#### playbook-cli-83

After acquiring the valid exclusive session lease of [[playbook-cli-23](#playbook-cli-23)], the replay writer shall rescan the stream from byte zero without reusing a follower cursor, validate through the final newline-terminated envelope, establish the resulting complete-prefix byte boundary with byte zero for an empty prefix, call its final sequence `N` with `N = 0` for that empty prefix, and provisionally seed both `lastReadableSeq` and `lastDurableSeq` to `N` before applying these exact trailing-byte cases:

| Trailing bytes after the complete-prefix boundary | Required action |
| --- | --- |
| None | mutate nothing and retain both sequence values at `N` |
| The entire tail parses and validates as exactly one envelope of [[playbook-cli-74](#playbook-cli-74)] with sequence `N + 1` | preserve the tail byte-for-byte, append exactly one line feed without reserializing it, synchronize the file, and then advance both sequence values to `N + 1` |
| Any other nonempty tail | truncate exactly to the complete-prefix boundary, synchronize the file, and retain both sequence values at `N` |

Absence of a torn tail, or successful repair and synchronization under that matrix, shall complete initialization with `incomplete: false`, while repair or repair-synchronization failure shall enter the numeric latch-and-stop state of [[playbook-cli-76](#playbook-cli-76)].
Its live status shall be exactly the union of `{lastReadableSeq: <nonnegative integer>, lastDurableSeq: <nonnegative integer>, incomplete: <boolean>}` after establishing that trustworthy prefix and `{lastReadableSeq: null, lastDurableSeq: null, incomplete: true}` when replay-only initialization cannot validate the stream file boundary or complete prefix; both sequence fields shall be null together if and only if no trustworthy whole-stream boundary was established.
In the unavailable variant, the already-acquired canonical lease shall remain usable while the replay writer performs no append or checkpoint, leaves the stream byte-identical, and retains the strict read rejection of [[playbook-cli-74](#playbook-cli-74)] rather than returning partial history; status and normal release shall return that variant without preventing canonical lease retirement.
This replay-only isolation shall begin only after the canonical directory and lease pass the fail-closed boundary of [[playbook-cli-23](#playbook-cli-23)]; manifest existence shall not be a prerequisite, and an independently requested manifest read shall retain its strict behavior.
Each successor lease shall repeat the byte-zero rescan: where a valid retained prefix's required repair succeeds, it shall seed both numeric boundaries, carry no inherited latch, and resume one past `lastReadableSeq`, while an unchanged invalid stream shall independently produce the unavailable status again.

#### playbook-cli-84

On the first transition to an incomplete replay status under [[playbook-cli-76](#playbook-cli-76)] or [[playbook-cli-83](#playbook-cli-83)], each CLI front end shall schedule exactly one best-effort warning for that acquired writer lease, mark delivery attempted immediately before its one attempt, swallow delivery failure, and never retry; a successor lease that independently becomes incomplete shall schedule its own warning, while the facade shall emit none because its caller owns presentation through the returned status.
Substituting `JSON.stringify(sessionId)` for `<session>`, the headless host shall write `playbook run: warning: replay history for session <session> may be incomplete; recording has stopped\n` directly to stderr outside the record dispatcher.
The managed replay observer shall follow the forwarded presentation gate of [[playbook-cli-49](#playbook-cli-49)] in host-observer order; after that gate completes the triggering source record, it shall deliver directly to the gate, without re-entering the host record dispatcher, one presentation-only `captain_status` carrying `turnId: null`, its `timestamp` set at delivery, no `data`, and exact message `warning: replay history for session <session> may be incomplete; recording has stopped`.
A managed warning caused by initialization, settlement, or release shall use that same status record at the completed lifecycle boundary where no host-record dispatch is active; the synthetic status shall not pass through the replay observer or enter the replay stream.
Successful replay shall add no diagnostic; with a writable headless sink or successful managed presentation, degraded replay shall add exactly its channel's one warning and no other output, while warning-delivery failure shall be swallowed without retry; neither delivery nor its failure shall change the turn, reply, settlement, attachment, canonical release, or exit outcome of [[playbook-cli-18](#playbook-cli-18)] and [[playbook-cli-20](#playbook-cli-20)].

## Internal Behavior

### Repository effect coordination

#### playbook-cli-57

When the private repository-effect coordinator receives one Git working directory and detached call metadata carrying the governed outcomes' repository dispositions under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)], it shall key one exclusive cooperative claim by the canonical worktree identity under [[playbook-runtime-67](playbook-runtime.md#playbook-runtime-67)], acquire it before the baseline observation, and hold it through the complete after observation and receipt.
An exclusive call shall run alone; a cohort call shall require one nonempty invocation identity, an exact role set matching one supplied detached `concurrentRoleSets` member under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)], and exclusively `unchanged` dispositions for every exact participating role; it shall capture one common baseline before any member begins, await every member before one common after observation, and classify any repository delta as `observation-ambiguous` for every member.
A same-worktree call outside an active cohort shall wait through every cohort receipt, separate coordinator calls shall acquire separate claims, and different canonical worktree identities shall not block one another.
The coordinator shall reject malformed or unauthorized cohort metadata before a member starts and shall neither claim to exclude nor identify a nonparticipating writer.

#### playbook-cli-59

When the private coordinator manages a cross-process claim, it shall publish one private exact owner token, host, and PID atomically; reject malformed, nonprivate, foreign-host, permission-unknown, reused-token, or otherwise unprovable ownership; reclaim only a current-host owner whose PID probe definitively returns `ESRCH`; and retire normal, reclaimed, or post-publication-failed ownership to permanent token-specific paths after verifying the exact active token.
Every staging, active, and retired claim path shall be materialized outside the repository-relevant projection under [[playbook-runtime-67](playbook-runtime.md#playbook-runtime-67)] of the canonical worktree it keys.
One issued claim handle shall reject overlapping observation, receipt, ownership-check, or release methods, and a delayed stale-owner reclaimer shall not disturb a successor protected by the retired token.

#### playbook-cli-60

When the package candidate is assembled, it shall carry the private repository-observation and coordination module without adding a package export or executable.

#### playbook-cli-63

Where the current process owns a schema-version-6 Captain record's exact session lease, the store shall expose one private `writeEffectLedger(authority, commands)` that validates the artifact schema, logical session, lease-owner token, canonical worktree, and current schema-3 catalog membership before each atomic mutation and shall persist no authority or live handle ([[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)]).
The writer shall accept one nonempty ordered batch drawn from the four exact nonempty command variants of [[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)], apply its commands as one transition with final cross-reference validation only after the complete batch, make an exact start or append identity-and-payload replay idempotent without another record write or revision, recognize an exact indeterminate completion retry from the same live lease, reject the complete batch on conflicting identity reuse, stale compare-and-swap, undeclared or reused cohort identity, or another unlawful transition, assign each new boundary its ordered sequence plus the current uncertain marker's `attemptId` and `attemptNumber`, assign each new logical operation its sequence, and atomically replace the complete record with one revision increment before acknowledging one detached frozen ledger.
The writer shall require a record to be uncertain before every ordinary ledger mutation, shall preserve the pre-turn shell ledger as its immutable checkpoint, and shall keep every write a monotonic extension of that checkpoint.
As the sole exception, before retained-generation adoption or restoration of a settled chat record carrying final nonempty unresolved-effect evidence, a lease-owned settled `chat` record may accept one recovery batch that only replaces currently incomplete physical boundaries by adding their reconstructed `after` and `physicalReceipt` members, including one all-member cohort batch; the writer shall reject a start, append, logical-operation replacement, already-complete boundary, or any identity, semantic, envelope, correction-budget, or other evidence change, and shall atomically advance both the record ledger and its chat-shell mirror without rewriting that record's frozen `unresolvedEffects` before acknowledgement.
For an exclusive governed call, the coordinator shall invoke one-command write-ahead batches containing `start-boundaries` with the captured baseline and await its durable acknowledgement before starting the player, then `replace-boundaries` with the complete after observation, receipt, and available envelope evidence and await durability before releasing the repository claim; one cohort shall perform each phase as one all-member command inside one write-ahead batch ([[playbook-cli-57](#playbook-cli-57)]).
Where a start write fails or is indeterminate, no player shall begin; where a receipt or post-effect envelope write fails or is indeterminate after an exact completion batch exists, the host shall withhold settlement and quarantine that repository claim with the batch until authoritative same-process recovery or process death. Where the player has started but capture, completion mapping, or detached-batch construction fails before that exact batch exists, the same process shall keep the claim quarantined and shall neither synthesize a completion nor release it.
When the current owner recovers such a live claim, it shall retry the exact proposed batch or retire an already acknowledged claim before restoration; when a later lease owner reads an uncertain record with incomplete boundaries, it shall first require each saved boundary and baseline identity to equal the current artifact capability's canonical-worktree authority, then reacquire that authority's claim, in ledger order observe from the persisted baseline, construct the corresponding complete receipt and after evidence, and atomically replace that boundary before shell validation, runtime construction, source-state restoration, or any player call; it shall reconstruct every incomplete cohort identified by one persisted `cohortId` from one common recovery observation and classify it ambiguous when exact common-baseline proof is unavailable.
Recovery shall preserve boundary, operation, attempt, original-baseline, checkpoint, semantic, question, continuation, eligibility, and spent-budget data exactly, and a failed or indeterminate recovery write shall preserve the record's existing uncertain or settled-chat lifecycle state, start no runtime or player, and quarantine the applicable claim.
At settlement the store shall require exact equality among the authoritative ledger, shell schema-version-4 mirror, and every frame mirror; ordinary continuation shall restore that same value, while the internal Captain mirror remains empty ([[playbook-captain-50](playbook-captain.md#playbook-captain-50)]).

#### playbook-cli-65

Where the current process owns a schema-version-6 Captain record and services the deferred Boss-question operation of [[playbook-runtime-73](playbook-runtime.md#playbook-runtime-73)], the private host capability shall hold the exclusive canonical-worktree claim while it compares a saved checkpoint, starts or completes a physical boundary, binds or replaces the logical operation, marks checkpoint-restoration eligibility, or consumes that eligibility.
The initial and each repeated question shall be bound in the same atomic completion batch as its physical receipt before claim release, and a valid exact-checkpoint answer shall clear the prior wait and append and reciprocally link its new started boundary in one atomic batch before the player begins, using the compare-and-swap writer of [[playbook-cli-63](#playbook-cli-63)] and the exact ledger transitions of [[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)].
Where comparison fails, the host shall persist the applicable eligibility transition before claim release and start no player; where explicit reconciliation finds equality, it shall persist eligibility consumption before republishing the wait and start no player or judge; and a rejected, failed, or indeterminate write shall retain the existing uncertain-record and claim-quarantine guarantees of [[playbook-cli-63](#playbook-cli-63)].
The record shall persist the bound token-or-false player continuation but no Boss answer, callback, claim, lease token, or live store handle.

#### playbook-cli-67

Where an explicitly selected schema-version-6 Captain record is uncertain, the private headless retry gate shall first reconstruct every incomplete governed boundary under [[playbook-cli-63](#playbook-cli-63)] and inspect the complete ordered physical-boundary suffix after the immutable ledger checkpoint in the stored pre-turn shell snapshot of [[playbook-cli-23](#playbook-cli-23)], including boundaries from every attempted replay; an empty suffix shall satisfy the boundary predicate.
The gate shall authorize whole-turn replay only when the authoritative `boundaries` prefix through the checkpoint length remains deep-equal to the checkpoint, every suffix boundary carries a complete physical receipt whose classification is exactly `unchanged`, and the authoritative `logicalOperations` list remains deep-equal to the checkpoint list under [[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)]; ledger revision may advance with the suffix.
For an eligible suffix, the gate shall preserve the stored snapshot checkpoint and authoritative suffix without truncation, derive a detached in-memory restore snapshot by replacing its shell-root ledger and every active schema-3 frame ledger mirror defined by [[playbook-captain-41](playbook-captain.md#playbook-captain-41)] with the current authoritative ledger of [[playbook-captain-50](playbook-captain.md#playbook-captain-50)] while leaving every other snapshot member unchanged, require exact mirror equality before shell restoration under [[playbook-captain-42](playbook-captain.md#playbook-captain-42)], and durably begin the next attempt under [[playbook-cli-23](#playbook-cli-23)] before player work.
A changed checkpoint boundary or logical-operation list, a non-`unchanged` receipt, an incomplete boundary after recovery, recovery failure, or an invalid mirror rebase shall leave the record uncertain and its attempt marker unchanged with every acknowledged reconstruction durable, print a repository-reconciliation diagnostic with the exit-`1` empty-stdout setup refusal of [[playbook-cli-18](#playbook-cli-18)], and start no shell, runtime, or player.

#### playbook-cli-69

Where a schema-version-6 Captain record retains a generation, the store shall validate the generation's required complete capture-time effect-ledger checkpoint and optional retained-effect marker together with its frame snapshots, require the record's authoritative ledger to be an exact or monotonic extension of that checkpoint, require every ordinary frame mirror to equal the checkpoint, and require every marked frame to carry one common capture-time authoritative mirror that strictly extends the checkpoint, remains an exact or monotonic baseline of the record's current ledger, and has matching source-lineage and checkpoint evidence under [[playbook-captain-54](playbook-captain.md#playbook-captain-54)].
The guarded predecessor exchange of [[playbook-cli-53](#playbook-cli-53)] shall preserve the source record's authoritative ledger and unresolved-effects list while atomically moving its complete retention map, install that ledger in the target record and turn-zero shell mirror while keeping the target unresolved-effects list and internal-Captain mirror empty, and preserve each generation and capture checkpoint byte-for-byte; the target catalog shall supply compatible schema-3 authority for every ledger boundary and logical operation before either transfer publication.
The source clear, target install, rollback, publication-ambiguity, owner-check, no-subset, and single-transfer rules shall apply to the ledger-map-snapshot unit while each record retains its own settlement list, so every visible target is either the intentional empty boundary or one complete target whose authoritative ledger, empty unresolved-effects list, shell mirror, and retained checkpoints are mutually lawful, and no failure shall erase the source ledger or list or publish an effect-free target around a transferred generation.
Before a selected or transferred generation is adopted, the current lease-owning host shall refresh its capability from the selected record, complete authoritative incomplete-boundary reconstruction through the settled-chat exception of [[playbook-cli-63](#playbook-cli-63)], give the shell the resulting current mirror, and let the root-wide retained-adoption fence of [[playbook-captain-54](playbook-captain.md#playbook-captain-54)] authorize only an exact or all-complete-`unchanged` rebase; every schema-3 adoption shall preserve its original source-session lineage under [[playbook-runtime-75](playbook-runtime.md#playbook-runtime-75)] so source-owned deferred logical operations of [[playbook-runtime-73](playbook-runtime.md#playbook-runtime-73)] remain addressable after transfer and fresh target allocation, while an unsafe valid extension shall additionally persist and restore its original checkpoint and start no ordinary shell, runtime, or player work.

#### playbook-cli-71

Every schema-version-6 Captain record shall carry required `unresolvedEffects` validated through the pure public boundary of [[playbook-captain-58](playbook-captain.md#playbook-captain-58)]; a fresh boundary shall use the canonical empty list, a settled record shall carry the shell settlement's exact detached copy, and uncertain marking, retry, authoritative reread, and exact discard shall preserve the prior settled copy byte-for-byte until a later safe settlement replaces it.
The record list shall be nonempty exactly when its last durable settlement parked an effect-possible outcome-unresolved episode or recorded unresolved-effect abandonment and shall be empty otherwise, except that an ordinary uncertain turn preserves its prior list while new evidence remains unsettled.
At every ordinary safe settlement, both front ends shall pass the snapshot, unresolved-effects list, and retention updates from one shell settlement unchanged to the single atomic record replacement of [[playbook-cli-51](#playbook-cli-51)] without another repository observation or a projection from the raw ledger.
When an active turn requests unresolved-effect abandonment, the current lease owner's idempotent begin operation shall atomically add to its uncertain record the exact optional member `abandonment: { phase: 'started', rootPlaybookId, unresolvedEffects }`, where the nonblank enabled root id equals the pre-turn parked snapshot's root and the list is the shell's frozen nonempty final projection; an exact repeated begin shall re-synchronize the record directory before acknowledgement, and a mismatched or stale-owner begin, retry, discard, or ordinary settlement shall reject without mutation.
After the shell disposes the complete stack and stages that root's `clear`, the same owner's idempotent completion operation shall atomically change only that marker's phase to `disposed`, persist the same list as the record's required top-level `unresolvedEffects`, and apply the root clear to the complete retained-generation map before acknowledging durability, while preserving the immutable pre-turn snapshot, effect ledger, attempt, input, and execution projections; an exact repeated completion shall re-synchronize the record directory before acknowledgement.
Only a `disposed` marker may pass the matching ordinary settlement, whose safe chat snapshot, unresolved-effects list, and required root-clear update shall equal the durable abandonment data; additional clear updates shall be valid only where they are no-ops against the current retained map. Successful durable completion authorizes controller `ok` and `executed` before presentation, while a begin, disposal, completion, or validation failure shall produce neither claim and preserve the latest complete uncertain boundary; a later ordinary-record replacement or reply-release failure cannot retroactively change that controller receipt and shall instead preserve the latest recoverable record and fail or withhold presentation.
On acquiring a record with either abandonment phase, each front end shall complete recovery before config preparation, shell restoration, generation installation, readiness, or Boss, runtime, player, or controller work by atomically replacing it with a settled chat snapshot over the authoritative ledger, the same nonempty `unresolvedEffects`, the complete root removed from retention, and exact `settledAbandonment: { phase: 'recovered', attemptId, rootPlaybookId, unresolvedEffects }` identifying that recovered boundary; selected interactive advisory planning shall acquire, recover, and release that record first, and its lease-owning child shall repeat the authoritative recovery check.
The `settledAbandonment` marker shall occur only over a successful host-disposal chat snapshot with its named root absent; uncertain marking, retry, authoritative reread, and exact discard shall preserve it with that prior settled boundary. A recovered marker shall permit one exact late settlement for the same attempt, root, list, safe snapshot, and root clear to advance it to `phase: 'final'`, while a directly published matching settlement shall start at `final`; an exact replay of either recovered or final publication shall re-synchronize the record directory before acknowledgement and perform no record write, any differing attempt or settlement shall reject, and the marker shall disappear only when a later safe settlement replaces its prior boundary.
Guarded predecessor transfer shall preserve the source record's list and `settledAbandonment` marker and the fresh target's empty list with no marker because unresolved evidence and retry provenance belong to the record's own active settlement rather than its transferred retention map; selected continuation and ordinary restore shall preserve the owning record's exact list, and a later retained-adoption settlement shall derive and persist its own current list, so same-process, restored, and adopted parking cannot lose, reorder, regenerate, or bless unresolved evidence or advertise the cleared generation.

### Shared launch configuration

#### playbook-cli-46

Where either front end prepares a new or ordinarily reopened Captain session from the generic config, when the launcher resolves that config, it shall use one leaf launch-config module to perform the following ordered pipeline:

1. Resolve the primary path per [[playbook-cli-3](#playbook-cli-3)]; for a new session, seed and migrate that primary file before applying overlays and merge every [[playbook-cli-25](#playbook-cli-25)] overlay in argument order without mutating an input, then resolve the merged `sessions` locator of [[playbook-cli-78](#playbook-cli-78)] as a filesystem path — including a bare relative value — before any record is selected, because selection reads that directory.
2. For an ordinary reopen, skip whole-file migration and use the selected record's ordered playbook ids and referenced player ids to project each primary or overlay layer to its optional own selected map members before recursively merging that layer, so a later overlay may supply a selected member while no unselected member is cloned or inspected; after all layers merge, require every selected id to exist, and neither inspect nor admit an additional current entry.
3. Resolve a relative retained filesystem `playbooks.<id>.from` against the primary config's directory, including one introduced by an overlay, canonicalize an absolute filesystem path to a file URL, and preserve an existing file URL, bare package specifier, or custom specifier unchanged.
4. Reject non-JSON data, retired or unknown root keys, malformed retained launcher-owned structure, invalid or reserved retained player and role ids, unknown retained players, incomplete or extra retained role bindings, adapter overrides, and authority-key smuggling through an own `hostCapabilities` key in a raw playbook block or stored or derived option slice before an external side effect.
5. Serialize a detached provisional tmux-play config to an isolated explicit temporary path, validate and normalize it through the installed cligent `loadTmuxPlayConfig`, feed its Captain, player, layout, notification, and theme values back into the authoritative plan, and remove the temporary path without modifying the primary config or overlays.
6. Canonicalize and prepare every retained registry module before importing any of them, require a preparation hook's returned specifier to remain trimmed and any file URL to remain canonical, use that returned specifier for both the one import and normalized catalog, and perform no registry import when validation or any preparation fails.
7. Snapshot every consumed top-level member of each retained imported registry manifest exactly once, then validate and project only that detached snapshot without invoking its runtime-option validator, whose one semantic owner is shell initialization under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)]; accept exactly artifact schema `3`; require an exact plain-data `runtimeProfile` of either `{ kind: 'shared-factory', compat: { artifactSchema: 3, runtimeAbi: safe integer } }` or `{ kind: 'bespoke', artifactSchema: 3 }`; reject disagreement between its artifact schema and the manifest advertisement; reject any `concurrentRoleSets` member whose roles do not bind to pairwise-distinct players; resolve each effective command and exact role binding; carry the detached option slice unchanged; and produce one deeply frozen, JSON-safe plan separating Captain, referenced players, complete catalog, and presentation with no imported function or live host capability retained.
8. Derive adapter readiness from the plan's Captain and referenced players independently of presentation, project a detached tmux-play config only for the interactive host, and project a detached presentation-free execution config only for the headless host while keeping `--list` ahead of readiness.

The module shall import neither CLI host, both CLI hosts shall resolve the user-config path through it without a circular import, both shall use the same preparation hook and normalized effective commands, and the packed package shall include the module.

### Dependency resolution

#### playbook-cli-43

When the launcher resolves cligent's `tmux-play` CLI, it shall call synchronous `import.meta.resolve('@sublang/cligent/tmux-play')` from within the `@sublang/playbook` module tree and shall raise the declared Node floor in the same change if a newer Node API replaces it.

## Verification

### Seeding

#### playbook-cli-13

Where the test suite invokes `playbook` without `--config` against a
config root with no `playbook/playbook.config.yaml`, the test suite
shall fail unless the command creates that file from the bundled starter config, prints the resolved path to stderr, and the seeded file enables CODE, REVIEW, and DECIDE through their matching public registry modules with the [[playbook-cli-11](playbook-cli.md#playbook-cli-11)] lineup: Captain `claude` / `claude-opus-4-8`; player `dev.coder` on `claude` / `claude-opus-4-8[1m]`; player `dev.reviewer` on `codex` / `gpt-5.5`; explicit CODE, REVIEW, and DECIDE role bindings; no `profiles` map; `permissions.mode: auto` on every seeded agent; the Codex Reviewer's additional `.git` writable path; and the notification defaults.
When the file is already present, the test suite shall fail unless the
command leaves it unchanged and does not reseed (verifying [[playbook-cli-3](#playbook-cli-3)], [[playbook-cli-11](#playbook-cli-11)]).

### Composition Coverage

#### playbook-cli-14

When the test suite composes a top-level config enabling one or more playbooks, the test suite shall fail unless a dotted player id survives both interactive and headless projections byte-for-byte and an incapable host rejects it; the composed tmux-play config sets `captain.from` to `@sublang/playbook/playbook-captain`; carries exact `captain.options.sessionAgents` with one complete Captain block and exactly the referenced player blocks; carries one `captain.options.playbooks.<id>` entry per playbook with canonical prepared `from`, normalized effective `command`, exact closed role values `{ playerId, model, effort }` using the tagged tuning selections, and an option slice containing no launcher key; resolves scalar Captain and player values as adapter shorthands; normalizes full agent blocks; generates one roster entry per referenced player id; shares an entry only when role bindings name the same id; sets `layout.initialVisible` from the first enabled playbook with any bound players while leaving an all-roleless host-neutral plan empty; sets `captain.options.captainAdapter`; and carries normalized presentation fields (verifying [[playbook-cli-4](#playbook-cli-4)], [[playbook-cli-8](#playbook-cli-8)], [[playbook-cli-9](#playbook-cli-9)], [[playbook-cli-10](#playbook-cli-10)]).

### Validation

#### playbook-cli-15

When the test suite composes top-level configs carrying pre-import faults — a missing or blank `from`, top-level `profiles` or `run`, retired per-playbook `players`, an agent `profile`, an unknown root key, non-map `layout`, malformed or unknown agent fields, unknown adapter, conflicting or unsupported effort, malformed permissions, invalid presentation fields, invalid or reserved player or role ids, unknown bound players, role overrides outside model and effort, unresolved complete per-player tuning, authority-key smuggling, or non-JSON data — the suite shall fail unless each is rejected before registry preparation or import with a diagnostic naming the fault (verifying [[playbook-cli-4](#playbook-cli-4)], [[playbook-cli-8](#playbook-cli-8)], [[playbook-cli-9](#playbook-cli-9)], [[playbook-cli-28](#playbook-cli-28)], [[playbook-cli-33](#playbook-cli-33)], and [[playbook-cli-46](#playbook-cli-46)]).
An own `hostCapabilities` key shall be one such authority-smuggling fault and shall reject before registry preparation or import (verifying [[playbook-cli-8](#playbook-cli-8)] and [[playbook-cli-46](#playbook-cli-46)]).
When the suite composes configs carrying registry-dependent faults — a failed import, invalid default export, key / manifest-id mismatch, duplicate manifest id or effective command, reserved manifest role or effective command, an artifact schema other than `3`, a missing, malformed, or advertisement-disagreeing runtime profile, malformed `concurrentRoleSets`, a role map that does not exactly cover `requiredRoleIds`, or two roles in one concurrent set bound to the same player — the suite shall fail unless each is rejected after only the imports needed to discover it and before readiness, host creation, or agent calls (verifying [[playbook-cli-8](#playbook-cli-8)], [[playbook-cli-9](#playbook-cli-9)]).

### Readiness and CLI surface

#### playbook-cli-16

When the test suite runs the readiness gate over a composed config,
the test suite shall fail unless: a config whose adapters all have
credentials present launches tmux-play; a config with a missing
`claude` or `codex` credential blocks the launch, prints the help
content plus every failing adapter id to stderr, and exits non-zero
with a status distinct from `127`; and a declared adapter with no
known predicate produces one stderr warning without blocking launch (verifying [[playbook-cli-1](#playbook-cli-1)], [[playbook-cli-12](#playbook-cli-12)]).
An unreferenced top-level player's unavailable or uncredentialed adapter shall not enter either readiness result (verifying [[playbook-cli-12](#playbook-cli-12)]).

#### playbook-cli-17

When the CLI suite exercises raw `--config` and composed `--theme-diagnostics`, it shall fail unless each stock tmux-play subprocess receives the exact expected arguments and inherited streams, mirrors ordinary exit status and signal termination, and maps spawn failure to the exact stderr diagnostic and status `127` without entering managed preparation (verifying [[playbook-cli-1](#playbook-cli-1)] and [[playbook-cli-2](#playbook-cli-2)]).
When the CLI suite exercises help, listing, and managed grammar, it shall fail unless `--list` prints each configured playbook's id, effective command, and intent without launching; `--help` prints the four presentation forms and exits `0` without seeding or launching; unsupported or conflicting managed selectors reject before config or host work; and a managed launch validates its prepared identity, awaits report backpressure, preserves primary and cleanup failures, aborts and joins on a pre-handoff signal, and removes outer signal handlers synchronously at native-client hand-off (verifying [[playbook-cli-1](#playbook-cli-1)], [[playbook-cli-2](#playbook-cli-2)], [[playbook-cli-5](#playbook-cli-5)], [[playbook-cli-6](#playbook-cli-6)], and [[playbook-cli-49](#playbook-cli-49)]).

#### playbook-cli-21

When the integration suite exercises `playbook run` through the actual `createPlaybookCaptainShell` and actual no-presenter cligent runtime with deterministic adapters and synthetic configured registries, the suite shall fail unless one positional and verbatim stdin each enter one exact Captain Boss turn; `/code` completes nested REVIEW and resumes the same Coder token only because both role maps bind that role to one player id; statuses stay on stderr and telemetry appears only under `--verbose`; plain and JSON stdout carry only the one Captain reply in their exact formats; the public session id differs from internal UUIDs; and no tmux process or presenter is created (verifying [[playbook-cli-18](#playbook-cli-18)], [[playbook-cli-19](#playbook-cli-19)], [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-24

When the integration suite exercises complete shared-Captain persistence and continuation in isolated state directories, the suite shall fail unless chat-only, completed-root, and nested-parked turns atomically persist Captain-session record schema `6`, the full schema-version-4 shell snapshot and effect ledger, structural and last-applied execution projections whose complete catalogs use artifact schema `3`, normalized absolute working directory, registry manifest command, stable creation time, and monotonic update time with exact private permissions before stdout and without successful semantic disposal; explicit selection of released record schemas `2`, `3`, or `4`, both recognized pre-release schema-`5` shapes, shell schema `1`, and runtime schemas `1` and `2` rejects before host work with the applicable incompatibility or cutover diagnostic rather than a raw missing-member message; explicit and implicit selection each continue a complete schema-6 record without `retainedGenerations` while treating absence as empty; implicit continuation skips a fully validated nonresumable record beside a valid schema-6 record with the matching applicable reason and an exact archive-or-remove warning; other malformed or unknown records remain fail-closed; `--continue` selects the newest same-working-directory logical session over a globally newer foreign-directory record, reports and selects the globally newest record when no same-directory record exists, and `--session <id>` bypasses both preference and fallback notice; stdin and argv replies preserve exact text; restore occurs instead of init and does not repeat a settled or pending child start; ordinary continuation reuses the prior token with a changed current model and effort under the same adapter; provider rejection preserves that token; changing or removing a stored artifact schema, catalog member, runtime option, concurrent role set, role-to-player binding, adapter, instruction, or permission rejects before host work; a changed stored manifest default is rejected even under a command override; poisoned additive playbooks and their additional players cause no validation, preparation, import, readiness, or host work and do not enter the reopened session; fresh id collision, malformed plain-JSON mutations, unsafe path-shaped stored modules, symlink/non-private storage, corrupt latest records, and unwritable hand-off fail with the specified channel and exit behavior; a post-rename directory-sync failure exposes only one complete pre- or post-settlement record while withholding stdout; and the packed package carries the store leaf (verifying [[playbook-cli-22](#playbook-cli-22)] and [[playbook-cli-23](#playbook-cli-23)]).
The persistence suite shall also accept exactly stored artifact schema `3`, reject schema `2` and every other artifact schema before host work, and reject a stored `options.hostCapabilities` key before host work (verifying [[playbook-cli-23](#playbook-cli-23)]).
The suite shall further fail unless every turn exposes a durable uncertain baseline before its first effect; a failed or killed turn remains uncertain with stdout empty; ordinary continuation refuses it; retry reads no stdin, reuses its byte-exact input and attempted settings despite current config changes, advances the attempt before effects, and settles only once; discard restores the exact prior bytes or deletes a compatible pre-turn-zero fresh record without config or host work; and SIGINT, SIGTERM, and SIGHUP cleanly retire ownership before the executable re-raises them (verifying [[playbook-cli-22](#playbook-cli-22)] and [[playbook-cli-23](#playbook-cli-23)]).
Mutation-sensitive store and real-child crash rows shall prove one writer, authoritative reread after selection, live/foreign/EPERM/malformed fail-closed behavior, same-host ESRCH recovery, persistent normal-release and stale-O tombstones, owner-exact mutation/release, and the delayed two-reclaimer interleaving in which R2 retires O and publishes N before R1 resumes yet R1 cannot move N and no third writer starts (verifying [[playbook-cli-18](#playbook-cli-18)], [[playbook-cli-22](#playbook-cli-22)], [[playbook-cli-23](#playbook-cli-23)]).
The focused headless suite shall inject cleanup failure during setup, a started turn, and settlement failure, and shall fail unless stdout remains empty, the original setup-versus-started-turn exit class is preserved, every primary and cleanup failure is diagnosed, and the canonical lease rejects a same-process contender until process death permits stale-owner recovery (verifying [[playbook-cli-23](#playbook-cli-23)]).
It shall further fail unless a continued session recovers a real engaged workflow parked in its recoverable failure state: with the real CODE registry driven to that state by a failing player in one invocation — or by a player that fails only after an answered Boss question resumed it, whose parked record then settles carrying no pending question — the next `--continue` invocation selects the retry that leaf still advertises, settles it as executed against exactly one further player call, and persists the same logical session with the same engagement moved off its failure state rather than dismissed (verifying [[playbook-cli-22](#playbook-cli-22)] and [[playbook-cli-23](#playbook-cli-23)]).

#### playbook-cli-27

When the integration suite exercises launch-time and ordinary-reopen tuning through `--with`, the suite shall fail unless both front ends merge fragments in order over the same primary config; a fragment retuning one shared player default affects every bound role lacking that override, while a fragment retuning one role binding affects only that invocation; scalar, sequence, and null collisions replace; the primary and overlays remain byte-identical; installed-cligent normalization rejects invalid adapter, model, instruction, effort, permission, layout, notification, and theme values before preparation/import; a legacy `reasoningEffort` normalizes only in the detached plan; interactive forwarding and headless Boss input contain no consumed `--with`; and the retired run-only binding flags fail with a shared-config migration diagnostic (verifying [[playbook-cli-19](#playbook-cli-19)], [[playbook-cli-25](#playbook-cli-25)], [[playbook-cli-26](#playbook-cli-26)]).

#### playbook-cli-30

When the integration suite gives either front end a top-level `run` block, the suite shall fail unless resolution exits `1` naming the retired key and shared inline replacement before preparation, registry import, readiness, host creation, spawn, or agent call; the same injected path and home environment shall resolve identically for both front ends; and an absent primary config shall seed the same starter rather than create an implicit direct-run lineup (verifying [[playbook-cli-28](#playbook-cli-28)], [[playbook-cli-29](#playbook-cli-29)]).

#### playbook-cli-31

When the integration suite runs the shipped compiled Captain through the actual headless shell/core boundary, the suite shall fail unless ordinary Boss text reaches the compiled closed-set selection prompt and its accepted `respond` text becomes the sole reply; adapter-specific tool restriction, hidden-control envelopes, durable Captain calls, and result re-asks remain the same shell-owned behavior as interactive mode; and no replacement direct-host judge or Captain adapter is constructed (verifying [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-35

When the integration suite selects a configured playbook whose runtime factory rejects an unsupported compatibility declaration, the suite shall fail unless the shared Captain records that action failure and presents its grounded failure reply through the ordinary headless reply boundary without calling a player; where the same rejection occurs during host construction before a Boss turn, it shall instead produce the setup diagnostic and exit `1` (verifying [[playbook-cli-20](#playbook-cli-20)]).
The suite shall further fail unless the compiled session Captain's own factory construction rejecting a compatibility declaration during host construction produces that same prefixed setup diagnostic and exit `1` with nothing on stdout; and unless, with a factory that rejects the Captain's construction in place, importing the compiled Captain module — its committed compiled-JavaScript bytes included, outside any source-redirecting test resolution — still succeeds and `run --help` still serves ([[playbook-cli-18](#playbook-cli-18)]) while the first runtime request raises the rejection, because the front ends import that one module statically and an eager module-scope construction would surface the rejection as an uncaught module-load error instead ([slc/link.md](../../slc/link.md#output)) (verifying [[playbook-cli-18](#playbook-cli-18)] and [[playbook-cli-20](#playbook-cli-20)]).

#### playbook-cli-32

Where the live release gate writes top-level configs for its fixture repositories, when the normal
test suite runs, the test suite shall fail unless each of those exact
configs composes through the launcher against the real modules it
enables.
It shall fail unless the workflow config composes against the real CODE, REVIEW, and DECIDE registry modules, defines its named top-level players once, and binds every required role explicitly with the expected shared or independent identity (verifying [[playbook-cli-4](#playbook-cli-4)], [[playbook-cli-8](#playbook-cli-8)], and [[playbook-cli-9](#playbook-cli-9)]).
It shall further fail unless the conversational config composes against
the fixture playbook modules the gate generates from its own sources,
written to the paths that config names, enabling `checklist` and `notes`
under those effective commands with exact empty role maps because neither fixture delegates player work (verifying [[playbook-cli-4](#playbook-cli-4)], [[playbook-cli-8](#playbook-cli-8)], and [[playbook-cli-9](#playbook-cli-9)]).
The gate itself is excluded from `pnpm test` and CI, so without this
check a config-model change would break the release gate silently and
surface only during a manual pre-tag run.

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
The suite shall fail unless migrated agent values land only under `captain` and top-level `players`, while a config containing legacy `playbooks.<id>.players` rejects without rewriting or selecting whether sessions share (verifying [[playbook-cli-33](#playbook-cli-33)]).

#### playbook-cli-38

When the integration suite exercises configured filesystem registry preparation over synthetic host roots, the suite shall fail unless interactive and headless launches create the same missing `xstate` and `@sublang/playbook` links before import and use only their own single diagnostic prefix; an already-resolvable or already-provisioned module changes nothing; bare and custom specifiers are untouched; `--no-provision`, declared-install refusal, dangling replacement, occupied real or foreign-link refusal, complete-destination prevalidation, and filesystem failures preserve their guard outcomes; the core returns structured notices/errors; and no failed complete-catalog preparation imports any registry or calls an agent (verifying [[playbook-cli-36](#playbook-cli-36)], [[playbook-cli-37](#playbook-cli-37)]).

#### playbook-cli-41

When the integration suite exercises the adapter SDK preflight over an injected probe, the suite shall fail unless both front ends derive the same deduplicated adapter set from the normalized plan; available runtimes proceed; missing and unsupported runtimes block before host construction with cligent's exact pinned repairs and distinguish absence from version skew; credential and SDK failures report together; descriptor coverage includes `gemini` and precise `opencode` culprits; raw interactive `--config` bypasses the gate; and each adapter is probed at most once (verifying [[playbook-cli-40](#playbook-cli-40)], [[playbook-cli-39](#playbook-cli-39)]).
Where the run is in an ephemeral npm exec tree, the suite shall further fail unless stdin is drained before preparation, import, and readiness; the remedy includes every lineup SDK, the pinned running package, and the complete original run argv; consumed stdin is appended verbatim and shell-quoted behind one effective terminator; an already active terminator is reused; a `--` consumed as `--with`'s value is not mistaken for a terminator; and prerequisite CLI installs precede the replay (verifying [[playbook-cli-40](#playbook-cli-40)], [[playbook-cli-18](#playbook-cli-18)]).

#### playbook-cli-42

Where a packed candidate is installed without a top-level `tmux-play` executable, when the model-free installed-CLI gate invokes `playbook --help`, the gate shall fail unless the command resolves `@sublang/cligent/tmux-play` from the candidate's own dependency tree and the package declares the Node `>=20.6.0` floor required by its synchronous `import.meta.resolve` call (verifying [[playbook-cli-7](#playbook-cli-7)] and [[playbook-cli-43](#playbook-cli-43)]).

#### playbook-cli-45

Where REVIEW is enabled in the shared config, when the CLI integration suite sends `/review <request>` through `playbook run`, the suite shall fail unless the shared Captain binds both roles to their explicit player ids, REVIEW reaches its approved terminal result, Captain presents the grounded reply, and no tmux session or presenter is created (verifying [[playbook-cli-44](#playbook-cli-44)]).

### Shared launch configuration verification

#### playbook-cli-47

When the integration suite exercises the shared launch-config pipeline over temporary primary configs, overlays, synthetic schema-3 registries, legacy schema-2 rejection fixtures, and a selected stored projection and dry-packs the public package, it shall fail unless relative, absolute, file-URL, bare, and custom registry specifiers follow their defined resolution cases; an ordinary reopen drops every non-stored playbook and its additional players before validation or hooks, including malformed additions that would fail a fresh launch; installed-cligent normalization precedes every retained preparation/import; all retained preparation precedes every retained import; every consumed imported manifest member is read once before validation and projection; schema `2` and missing, malformed, or advertisement-disagreeing shared-factory and bespoke runtime profiles reject before host work; the prepared specifier, registry-authored manifest command, effective command, artifact schema `3`, required roles, concurrent role sets, referenced players, and exact role bindings reach interactive, headless, and stored projections; overlays and legacy-effort normalization leave source files unchanged; the plan is detached, deeply frozen, JSON-round-trippable, and free of imported functions and live capabilities; execution and presentation projections cannot mutate it; malformed retained host fields, an own `hostCapabilities` key, invalid identities or bindings, accessors, sparse arrays, symbols, undefined values, non-finite numbers, cycles, and non-plain objects are rejected before external hooks; readiness derives only from retained referenced agents; the leaf module has no host import and is re-exported compatibly; and the packed file list includes it (verifying [[playbook-cli-46](#playbook-cli-46)]).

#### playbook-cli-48

When the focused headless integration suite exercises argv, stdin, output, and failure boundaries over the actual shared shell/core, it shall fail unless help has no input/config/probe side effect; zero or one positional and `--` follow the exact grammar; stdin drains before prepare/import/readiness; a shipped compiled-Captain turn and deterministic nested CODE-to-REVIEW turn each emit one reply; JSON has only `sessionId` and `reply`; statuses and opt-in telemetry stay on stderr; output awaits persistence and stream backpressure; invalid config and host setup exit `1`; started-turn and zero, multiple, empty reply, or persistence failures exit `2`; the settled shell snapshot and structural plus last-applied execution projections exist before durable hand-off; successful hand-off performs no semantic disposal; and interactive/headless filesystem provisioning is equivalent (verifying [[playbook-cli-18](#playbook-cli-18)], [[playbook-cli-20](#playbook-cli-20)], [[playbook-cli-36](#playbook-cli-36)], [[playbook-cli-46](#playbook-cli-46)]).

#### playbook-cli-50

When the integration suite creates fresh managed interactive and headless sessions and reopens each through both front ends, it shall fail unless a fresh interactive pane child owns the lease and authoritative record read, persists a complete turn-zero settled record before the outer process receives one matching operational line or opens Boss input, a selected child retains the stored id and working directory while applying only a compatible current-config overlay, and either front end preserves the same shell state and player ledger without age, turn-count, completed-root-count, or compatible-retuning limits (verifying [[playbook-cli-22](#playbook-cli-22)], [[playbook-cli-23](#playbook-cli-23)], and [[playbook-cli-49](#playbook-cli-49)]).
The focused suites shall further fail unless schema-2 catalogs reject before a repository capability or host dependency begins, while synthetic schema-3 fresh and restored root and nested construction through the real headless host and schema-3 shell initialization through the managed host each receive frozen current-lease, canonical-worktree, observer, coordinator, and injected write-ahead authority only after compatibility and leave the execution projection, durable record, and shell snapshot free of that authority; a live lease naming another logical session shall reach neither writer creation nor host construction (verifying [[playbook-cli-20](#playbook-cli-20)], [[playbook-cli-23](#playbook-cli-23)], and [[playbook-cli-49](#playbook-cli-49)]).
The suite shall inspect the durable record while a managed turn is blocked in agent work and before reply release, and shall fail unless every nonempty turn exposes its exact uncertain marker first; only one matching `turn_finished`, one matching reply, safe snapshot, and durable settlement begin ordered reply release; abort, terminal mismatch, host failure, or pre-fence settlement failure release no reply and leave the record uncertain; and a post-fence reply-release or cleanup failure preserves the settled record without rewriting it uncertain even where presentation already began (verifying [[playbook-cli-23](#playbook-cli-23)] and [[playbook-cli-49](#playbook-cli-49)]).
The suite shall signal the outer process before preparation completes, after operational reporting but before native-client hand-off, and after hand-off, and shall fail unless the first two interruption phases open no input, join the child, retire its lease, preserve the primary signal despite cleanup failure, and never attach, while the post-handoff signal retains native client semantics and does not request managed cancellation (verifying [[playbook-cli-49](#playbook-cli-49)]).
The suite shall exercise fresh `--cwd`, selected stored cwd, opening overlays, and the raw and diagnostic stock launch paths, and shall fail unless selected `--cwd`, interactive `--continue`, uncertain recovery flags, a selector combined with raw config, list, or diagnostics, and repeated or combined selectors reject before config resolution, lease acquisition, registry import, or host work, while stock raw and diagnostic exits and signals retain their distinct subprocess behavior (verifying [[playbook-cli-1](#playbook-cli-1)], [[playbook-cli-2](#playbook-cli-2)], [[playbook-cli-6](#playbook-cli-6)], and [[playbook-cli-49](#playbook-cli-49)]).
The focused suite shall fail unless the pane child consumes one schema-versioned `0600` descriptor by a securely held non-symlink inode after validating the required cleanup-authority boolean, carries both boolean values unchanged from managed launch context to direct runner, and validates control basenames, private owner directories, durable-store disjointness, and payload-to-presentation execution match; arbitrary, replaced, multiply linked, symlinked, non-private, overlapping, or mismatched paths shall run no host work and shall not unlink caller-chosen data (verifying [[playbook-cli-49](#playbook-cli-49)]).
The focused suite shall fail unless selected and fresh current registry drift rejects under the child-owned lease before Captain host work or turn-zero publication; complete retained-catalog preparation precedes any import; each exact prompt receives one matching reply and terminal fence; runtime disposal precedes lease release; cleanup-incomplete hosts quarantine ownership; child cleanup precedes signal re-raise; and the packed private child leaf remains neither a public export nor an additional executable (verifying [[playbook-cli-23](#playbook-cli-23)] and [[playbook-cli-49](#playbook-cli-49)]).

#### playbook-cli-52

When the persistence integration suite exercises retained generations through real record files, the real Captain shell, both front-end settlement callers, and successive leases, the suite shall fail unless a nested root-to-leaf schema-3 stack, its required capture-time effect checkpoint, optional retained-effect marker and nonblank root-state description, both call-bridge halves, and its runtime ledger mirrors round-trip as one detached unit across settlement, host and runtime disposal, reread, uncertain retry, and exact discard; a generation omitting either optional member remains valid; a member-less schema-6 record remains selectable and restores byte-exactly after discard; a later settlement replaces only its named root; shell-derived clean completion clears only its named root; malformed, final, nonquiescent, cyclic, duplicate, unknown, dangling, ledger-inconsistent, or legacy-artifact stacks and duplicate or malformed updates reject without settlement; and pre-rename or post-rename durability faults expose only a complete old or new snapshot-generation-ledger unit (verifying [[playbook-cli-23](#playbook-cli-23)] and [[playbook-cli-51](#playbook-cli-51)]).

#### playbook-cli-54

When the persistence integration suite selects cross-session predecessors through real record files and successive exclusive leases, the suite shall fail unless settled, uncertain, different-directory, deterministic-tie, malformed, unsafe, unknown-schema, nonresumable, member-less, explicitly empty, and live-leased boundaries prove exact newest-predecessor selection; invalid discovery records and a newest settled same-working-directory nonresumable boundary shall remain byte-exact, be reported once, publish the empty fresh target, and never fall through to an older nonempty map; older same-working-directory and different-directory nonresumable boundaries shall remain byte-exact, be reported once across initial discovery and authoritative rescan, and permit transfer from a newer resumable predecessor; an empty or live newest valid predecessor shall likewise never fall through, the live case shall publish an empty fresh target without changing either source, and foreign or permission-unknown ownership shall still fail closed (verifying [[playbook-cli-23](#playbook-cli-23)] and [[playbook-cli-53](#playbook-cli-53)]).
The suite shall further fail unless a nested multi-root map and the predecessor's authoritative effect ledger move whole and detached into an absent fresh target while preserving the source ledger, every generation identity and checkpoint, and every unrelated record member; the target turn-zero shell mirror shall equal that ledger while its internal Captain mirror remains empty; source then target shall advance monotonically under a tied or regressed clock, leave the target as the selected predecessor, and restore that target boundary exactly after a later uncertain marker is discarded; guarded initialization shall decline every exercised root-envelope, ledger-authority, and missing descendant catalog mismatch with the source byte-exact and an empty target, every permitted Captain, player, tuning, descendant-option, role-binding, command, and intent difference shall remain accepted, target reuse or owner loss shall reject under authoritative reread, predecessor disappearance or supersession shall decline with an empty newest target, and two contenders shall transfer at most one copy (verifying [[playbook-cli-51](#playbook-cli-51)] and [[playbook-cli-53](#playbook-cli-53)]).
At the four publication fault boundaries, the suite shall fail unless a source pre-publication failure leaves the source byte-exact and target absent, a source post-publication durability failure leaves the source cleared and target absent, a target pre-publication failure restores the source byte-exact and leaves the target absent, and a target post-publication durability failure leaves the source cleared and complete map at the target, with every visible record valid, at most one transferable owner, no temporary-file leak, and no partial success (verifying [[playbook-cli-23](#playbook-cli-23)] and [[playbook-cli-53](#playbook-cli-53)]).
The suite shall also fail unless a post-publication durability failure for an intentional empty target reports failure while preserving that complete visible target, and exact empty-target abandonment rechecks ownership immediately before deletion (verifying [[playbook-cli-23](#playbook-cli-23)] and [[playbook-cli-53](#playbook-cli-53)]).

#### playbook-cli-56

When the focused front-end suites exercise retained generations through real Captain-session records and the shared shell boundary, they shall fail unless selected and uncertain-retry headless records use their own nonempty maps before resumption, a member-less schema-version-6 record remains continuable with one empty-map installation, a fresh launch first publishes either its intentional empty boundary or complete transferred map through guarded initialization, fresh and selected managed launches install exactly once before initialization returns, both fresh front ends remain usable while the newest settled predecessor lease is live or an invalid or recognized pre-cutover record coexists, each skipped file is diagnosed once and left unchanged, the managed suite installs the empty map and leaves an older retained generation unchanged when a recognized pre-cutover record is the newest settled same-working-directory boundary, deterministic predecessor-envelope drift continues with no offer while preserving the source generation, cleanup-safe construction failure omits only that offer while preserving its durable generation for a later process, and each of a fatal pre-marker headless failure, a managed initialization failure before readiness can be published, and a child-won managed readiness claim retracts only an unchanged owned empty target while preserving any transferred target and ownership outcome (verifying [[playbook-cli-22](#playbook-cli-22)], [[playbook-cli-23](#playbook-cli-23)], [[playbook-cli-49](#playbook-cli-49)], [[playbook-cli-53](#playbook-cli-53)], and [[playbook-cli-55](#playbook-cli-55)]).
The managed lifecycle suite shall further fail unless child-won abandonment retracts the exact empty fresh target after runtime disposal, outer-won readiness preserves it after launcher coordination cleanup and detached EOF, and a readiness-witness collision cancels without an operational line or attachment (verifying [[playbook-cli-23](#playbook-cli-23)], [[playbook-cli-49](#playbook-cli-49)], and [[playbook-cli-55](#playbook-cli-55)]).
The headless and managed cross-process suites shall further fail unless an installed offer leaves exact explicit `/command` input on the fresh-start path without adoption and a later bare continuation reaches the shared Captain's advertised-offer arbitration, adopts the retained runtime without calling its initial entry point, and persists the newly adopted stack (verifying [[playbook-cli-55](#playbook-cli-55)]).

### Repository effect coordination coverage

#### playbook-cli-58

When the repository-coordination integration suite runs real concurrent claims, it shall fail unless exclusive calls through the after receipt serialize across process and canonical-path aliases; one valid supplied all-`unchanged` cohort overlaps only its own exact invocation members from one common baseline through one common after observation; a same-worktree outsider waits for all cohort receipts; a cohort delta makes every receipt ambiguous; malformed, undeclared, duplicate-role, missing-invocation, or effect-authorized cohorts reject before a member starts; and claims in different linked Git worktrees overlap independently (verifying [[playbook-cli-57](#playbook-cli-57)]).

#### playbook-cli-61

When the claim-lifecycle integration suite exercises real Git administrative directories and processes, it shall fail unless owner publication is exact, private, and outside the observed worktree projection; post-publication failure retires its owner; overlapping handle methods reject without releasing; malformed and nonprivate owners, foreign hosts, unknown process probes, and retired-token reuse fail closed; a same-host dead PID is reclaimed; normal and reclaimed tokens remain retired; and a delayed old-owner reclaimer leaves its live successor authoritative (verifying [[playbook-cli-59](#playbook-cli-59)]).

#### playbook-cli-62

When the package-surface suite dry-packs the candidate, it shall fail unless the private coordination module is present while the exact package exports and executable map remain unchanged (verifying [[playbook-cli-60](#playbook-cli-60)]).

#### playbook-cli-64

When the session-store integration suite writes schema-version-6 settled and uncertain records, it shall fail unless the exact ledger validator runs before every mutation, a settled record and shell mirror are equal, an uncertain authoritative ledger is an exact monotonic extension of its pre-turn shell checkpoint, every start receives the marker's attempt identity and next sequence, all four command kinds are atomic, exact start and append replay across the same or a later uncertain attempt changes neither bytes nor revision, an exact same-lease indeterminate completion retry re-establishes record-directory durability before acknowledgement, repeated durability failure remains indeterminate, and conflicting identity reuse or stale compare-and-swap rejects unchanged (verifying [[playbook-cli-23](#playbook-cli-23)] and [[playbook-cli-63](#playbook-cli-63)]).
The legacy-record matrix shall fail unless fully validated record schemas `2`, `3`, and `4` and both recognized pre-release schema-`5` shapes are nonresumable and receive no migration, implicit selection and unrelated fresh discovery report and skip them beside a complete schema-6 record, explicit selection rejects them before registry import or host work with the applicable explanation, and a complete canonical schema-6 record carrying artifact schema `2`, a direct pre-ledger shell or runtime snapshot, malformed ledger data, and an unknown schema each fail closed (verifying [[playbook-cli-22](#playbook-cli-22)] and [[playbook-cli-23](#playbook-cli-23)]).
The repository-effect cross-process and shared-host integration suites shall kill a real child after a boundary start is durable and after a repository effect but before its receipt write, then fail unless a successor lease owner reclaims the canonical-worktree claim, reconstructs every incomplete boundary in order into one durable receipt before attempted shell restoration, invokes no player or runtime during recovery, preserves the immutable pre-turn snapshot, and leaves the host closed on its recovered-ledger mismatch; two same-turn cohorts shall retain distinct identities and common observations per cohort (verifying [[playbook-cli-20](#playbook-cli-20)], [[playbook-cli-49](#playbook-cli-49)], and [[playbook-cli-63](#playbook-cli-63)]).
The same suite shall fail unless one cohort's starts and receipts are each indivisible all-member batches, a post-effect persistence failure leaves its claim unavailable until authoritative live recovery or dead-process recovery, a live post-operation failure before exact completion-batch construction permits neither synthesized completion nor claim release, available envelope evidence plus spent correction budget and deferred logical-operation baseline, physical chain, checkpoint, question, continuation, and eligibility survive reread exactly, and no callback, lease token, claim, or store handle enters the record or either snapshot (verifying [[playbook-cli-63](#playbook-cli-63)]).
The recovery-control matrix shall fail unless exact-checkpoint discard preserves the previous settled bytes, an extended ledger makes discard reject unchanged, settlement rejects a shell-ledger mismatch, ordinary continuation restores the exact settled ledger, and a failed reconstruction write leaves the record uncertain and starts no runtime or player (verifying [[playbook-cli-22](#playbook-cli-22)], [[playbook-cli-23](#playbook-cli-23)], and [[playbook-cli-63](#playbook-cli-63)]).

#### playbook-cli-66

When the repository-effect and deferred-runtime integration matrices drive one deferred schema-3 question chain through successive Boss turns and an export-and-restore boundary, they shall fail unless the initial and repeated questions preserve one stable operation id and original baseline, an ordered reciprocal physical chain, exact latest checkpoint and pending question, the token-or-false bound player continuation, and a final cumulative receipt while each valid exact-checkpoint answer starts at most its one authorized continuation (verifying [[playbook-cli-65](#playbook-cli-65)]).
Those matrices shall fail unless an invalid answer changes neither record nor player count; another exit records the nonrestorable unresolved shape; a valid-answer checkpoint mismatch records eligibility without the answer or a new boundary; an unequal reconciliation retry stays eligible; restoration of the exact saved checkpoint republishes the byte-identical question without a player or judge and consumes eligibility; and only a later answer may start one continuation (verifying [[playbook-cli-65](#playbook-cli-65)]).
The generic boundary-start and completion recovery and four-command atomicity matrices of [[playbook-cli-64](#playbook-cli-64)], together with focused before-and-after failure of the logical-operation replacement shared by eligibility and restoration, shall fail unless every deferred batch preserves atomic record bytes, withholds unsafe settlement and question publication, and retains the exact uncertain-record or quarantined-claim recovery state (verifying [[playbook-cli-63](#playbook-cli-63)] and [[playbook-cli-65](#playbook-cli-65)]).

#### playbook-cli-68

When the cross-process uncertain-retry suite kills a real child after a governed boundary starts durably and before its receipt is written, it shall fail unless the successor lease owner reconstructs that incomplete boundary before retry classification, an `unchanged` reconstruction permits exactly one replay using the saved input, and a reconstructed nonzero delta leaves the attempt marker unchanged, retains the acknowledged receipt, emits an exit-`1` empty-stdout reconciliation refusal, and starts no shell, runtime, or player (verifying [[playbook-cli-67](#playbook-cli-67)]).
The headless uncertain-retry matrix shall exercise an empty suffix, a complete all-`unchanged` suffix spanning two attempts, an earlier ambiguous receipt followed by a later `unchanged` receipt, a logical-operation-only eligibility replacement, and a completed change inside the checkpoint boundary prefix; each ineligible case shall fail unless it leaves the attempt marker and stdout unchanged, retains acknowledged evidence, emits the reconciliation refusal with exit `1`, and starts no shell, runtime, player, or next attempt (verifying [[playbook-cli-67](#playbook-cli-67)]).
For the authorized replay, the suite shall fail unless the stored pre-turn snapshot and complete authoritative suffix remain intact, only the detached restore copy's shell-root and active frame mirrors are rebased, the internal-Captain mirror remains empty, the attempt increments once before one Boss-turn replay using the exact saved input and attempted config, and settlement retains the complete ledger (verifying [[playbook-cli-67](#playbook-cli-67)]).

#### playbook-cli-70

When the retained-generation persistence suite settles exact and fenced generations, it shall fail unless every stored generation carries a valid complete capture-time checkpoint, the record ledger is its exact or monotonic extension, ordinary frame mirrors equal that checkpoint, every fenced frame preserves one byte-identical capture-time mirror that strictly extends the checkpoint and remains an exact or monotonic baseline of a later record ledger, and the pure record validator rejects an incomplete checkpoint or mutation of the checkpoint, source marker, frame marker, shared capture mirror, ledger authority, monotonic relationship, or legacy artifact schema before persistence (verifying [[playbook-cli-69](#playbook-cli-69)]).
When the guarded predecessor suite transfers a generation whose source ledger advanced after capture, it shall fail unless the source clear preserves its authoritative ledger, the target atomically receives that ledger with the byte-identical generation map, and only the target turn-zero shell mirror is rebased while its internal Captain mirror stays empty; the existing reread and exact-discard matrix shall preserve transferred generation bytes, and a later authority advance shall preserve a marked generation's captured mirror (verifying [[playbook-cli-69](#playbook-cli-69)]).
The transfer fault matrix shall exercise incompatible target authority for a ledger participant plus every source-clear, target-install, rollback, ambiguous-publication, and ownership boundary; it shall fail unless authority mismatch leaves the source byte-exact with an intentional empty target, no failure erases the source ledger or publishes a partial target, and at most one complete retained map remains transferable (verifying [[playbook-cli-69](#playbook-cli-69)]).
Across the settled-recovery, shared front-end launch-order, runtime-adoption, and Captain-adoption suites, the matrix shall complete an incomplete selected-record boundary into both authoritative and chat-shell mirrors, refresh a transferred record after guarded exchange and before generation installation, and exercise exact adoption plus all-complete-`unchanged`, incomplete, completed `observation-ambiguous`, earlier-incomplete-then-later-`unchanged`, later-created-child, legacy-schema rejection, and source-owned deferred-operation cases; it shall fail unless only exact and all-`unchanged` evidence reaches ordinary adopted work, original source-session lineage remains exact through safe and fenced settlement, restore, and readoption, source-owned deferred work remains addressable under fresh targets, and every unsafe case retains the acknowledged authoritative ledger and original checkpoint while starting no ordinary shell, runtime, or player work (verifying [[playbook-cli-69](#playbook-cli-69)]).

#### playbook-cli-72

When the schema-version-6 persistence matrix drives both front ends through empty, parked-unresolved, reconciled, same-process, restored, and retained-adopted settlements, it shall fail unless every fresh record starts with required empty `unresolvedEffects`, every safe settlement atomically persists the exact shell list with its snapshot and retention updates, uncertain marking, retry, reread, and discard preserve the prior bytes, guarded transfer preserves the source list while the fresh target stays empty and only a later adopted settlement derives its own list, and omission, unknown fields, malformed OIDs, unlawful classification or commit presence, reordered evidence, or mutation of any copied list rejects before host work or record replacement (verifying [[playbook-cli-23](#playbook-cli-23)], [[playbook-cli-51](#playbook-cli-51)], [[playbook-cli-53](#playbook-cli-53)], [[playbook-cli-69](#playbook-cli-69)], and [[playbook-cli-71](#playbook-cli-71)]).
The root and nested-leaf abandonment matrix shall fail unless durable begin writes one exact nonempty `started` marker before disposal, an exact replay re-synchronizes durability without rewriting, mismatched identity or evidence rejects unchanged, complete leaf-to-root disposal precedes one atomic `disposed` transition that persists the frozen list and clears the entire root, only its matching successful host-disposal chat settlement removes the uncertain marker, and every begin, disposal, completion, validation, or owner-loss fault preserves one complete recoverable record without an exportable shell settlement, `ok`, or `executed` claim; later replacement and reply-release faults shall preserve that boundary and fail or withhold presentation without rewriting the already-issued controller receipt (verifying [[playbook-cli-23](#playbook-cli-23)] and [[playbook-cli-71](#playbook-cli-71)]).
The durable crash and successor-lease rows shall stop after durable begin and after durable disposal, then fail unless the abandonment-recovery transition itself starts no shell, runtime, player, controller, or repository observation, atomically publishes one settled chat record with the exact list, authoritative ledger, cleared root, and exact recovered-phase `settledAbandonment` marker before config preparation, generation installation, or readiness, and never advertises or adopts the older generation; before later source restoration, current-host ledger recovery may complete an incomplete boundary only while leaving that frozen list byte-exact. The matrix shall exercise post-publication directory-sync failure and exact re-synchronizing replay at started, disposed, recovered, and final phases, accept only the authenticated recovered-to-final late settlement and its identical retry, preserve a source marker through unrelated predecessor transfer, and reject a retry, discard, failed-disposal snapshot, or mismatched attempt, root, evidence, or settlement without losing the durable boundary (verifying [[playbook-cli-63](#playbook-cli-63)] and [[playbook-cli-71](#playbook-cli-71)]).

### Shared session store coverage

#### playbook-cli-79

Where the shared-session-store positive compatibility suite runs against the repository, it shall fail unless every case satisfies its required evidence:

| Case | Required evidence |
| --- | --- |
| Facade exports and capabilities | The JavaScript export set equals exactly `RECORDS_STREAM_VERSION`, `defaultSessionsDir`, and `openSessionStore` with no default; the declaration imports nothing and exports exactly those names plus `ReplayJsonValue`, `ReplayRecord`, `ReplayStreamEntry`, `ReplayStreamReadOptions`, `ReplayStreamReadResult`, `LeaseReplayStreamReadResult`, `ReplayStreamStatus`, `PlaybookSessionSummary`, `SkippedPlaybookSession`, `PlaybookSessionListResult`, `PlaybookSessionStore`, and `PlaybookSessionLease`; one `defaultSessionsDir()` call with `XDG_STATE_HOME` set and a second call after clearing it and changing `HOME` return their respective call-time defaults rather than one import-time value; the version and every call signature equal [[playbook-cli-73](#playbook-cli-73)]; and the own-member sets of an opened store and acquired narrow lease equal respectively `sessionsDir`, `list`, `read`, `readStream`, `acquire` and `sessionId`, `ownerToken`, `append`, `readStream`, `streamStatus`, `release`, with no lifecycle, validator, effect-ledger, staging, publication, or retirement member reachable. The module graph shall prove the facade and both front ends depend on one private store and validator definition rather than parallel implementations ([[playbook-cli-73](#playbook-cli-73)]). |
| Summary listing and reading | `list()` returns exactly `sessions` and `skipped`; each valid row and direct `read()` result is one detached frozen summary with exactly `schemaVersion`, `sessionId`, `state`, `cwd`, and `updatedAt`; each skipped canonical manifest is reported with exactly `sessionId` and nonempty `reason` identifying the exercised validation or cutover failure without aborting other rows; a valid manifest carrying Captain and player resume credentials exposes no credential, snapshot, projection, ledger, recovery, unresolved-effect, or retained-generation data at any depth; direct reading rejects a below-schema record; and stream-only or foreign-sidecar files remain unlisted and byte-identical ([[playbook-cli-73](#playbook-cli-73)]). |
| Replay declarations and results | A strict declaration consumer passes an interface-typed observed record with no string index signature directly to `append(record, role?)` without a cast, receives `Promise<void>`, and can supply neither envelope version nor sequence; the awaited successful runtime result is exactly `undefined`; read entries use only the declaration-owned recursive JSON types and have exactly `v`, `seq`, optional `role`, and `record`. Omitted read options and exact `{afterSeq}` select the required full prefix and suffix; the lease-free result has exactly `entries` and numeric `lastReadableSeq`; a successful lease-bound read has those keys plus numeric `lastDurableSeq` and boolean `incomplete`; numeric `streamStatus()` and `release()` results have exactly those three live keys; and unavailable status has exactly both sequence keys null and `incomplete: true`, while unavailable lease reading rejects ([[playbook-cli-73](#playbook-cli-73)], [[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-82](#playbook-cli-82)], [[playbook-cli-83](#playbook-cli-83)]). |
| Both front ends | Two successive turns through the headless run observer and through the managed pane child's forwarded host observer list create the exact `<session-id>.records.jsonl` file; it replays every observed record in order, including player prompts and events, with sequences contiguous from `1` across both turns and envelope `role` present on each unambiguously trace-associated player record and absent from other records; nested sessions may reuse one runtime-local call id without cross-association, and a rejected overlapping same-player start/finish pair does not clear the outer frame; reply, settlement, buffered stdout, and buffered stderr are unchanged ([[playbook-cli-74](#playbook-cli-74)], [[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-77](#playbook-cli-77)]). |
| Fixture and sanitizer | Recursive sanitization removes every `resumeToken` and string-valued `resume` while preserving `resume: false`; an opaque record with an unknown `type` and additional members round-trips unchanged; and the checked-in cross-repository fixture parses and rewrites to semantically equal envelopes with one terminating line feed per envelope regardless of JSON member order or source-checkout mode, including a role-omitting record whose role remains derivable from its trace ([[playbook-cli-74](#playbook-cli-74)], [[playbook-cli-75](#playbook-cli-75)]). |
| Checkpoint progression | Acquiring against an absent or empty stream initializes both reported sequence values to `0`, acquiring against an existing valid complete prefix seeds both to its final sequence, each facade append advances only `lastReadableSeq`, a successful private settlement checkpoint advances `lastDurableSeq` to it, later appends again advance only readability, and a normal facade release directly proves its pending content synchronization before returning final status with both values equal and `incomplete: false` ([[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-83](#playbook-cli-83)]). |
| Independent follower | Absent and empty streams each return no entries with exactly `lastReadableSeq: 0`; an independent reader then first validates a nonempty complete prefix, and across successive headless-style writer leases that each append a complete line and retire, every monotonic read validates only bytes from its cached complete-line boundary despite canonical lease turnover, returns exactly the requested suffix with `lastReadableSeq` equal to the whole prefix's final sequence, exposes no durable-sequence or incomplete-state member, and performs no canonical-lease read; acquiring the lease after that follower read still rescans from byte zero rather than seeding from follower state ([[playbook-cli-82](#playbook-cli-82)], [[playbook-cli-83](#playbook-cli-83)]). |

#### playbook-cli-80

Where the shared-session-store negative and recovery compatibility suite runs against the repository declarations, real filesystem, and front-end boundaries, it shall fail unless every case satisfies its required evidence:

| Case | Required evidence |
| --- | --- |
| Reader rejection | A missing or unknown envelope version, missing required or unknown envelope member, missing or non-object `record`, non-string `role`, nonpositive, duplicate, missing, or noncontiguous sequence, malformed completed line, symlink or non-regular stream, wrong stream mode, or non-private or symlinked sessions directory rejects without returning a partial history or mutating the stream and leaves every unrecognized host sidecar byte-identical ([[playbook-cli-73](#playbook-cli-73)], [[playbook-cli-74](#playbook-cli-74)], [[playbook-cli-82](#playbook-cli-82)]). |
| Facade closure and arguments | A strict declaration consumer shall fail when importing a default or any name outside the exact export set, reaching any omitted store or lease member, reading any non-summary manifest field, reading durability or incompleteness from a lease-free result, supplying a caller-controlled envelope version or sequence argument to `append`, or assigning a primitive append input; an exact read option object with its own `afterSeq: undefined` data member shall return the same full-prefix result as omission, while the runtime shall reject a nonabsolute `openSessionStore` directory, a malformed session id, and a read option object with an unknown member, a negative, non-safe-integer, or beyond-prefix `afterSeq`, without exposing a partial result ([[playbook-cli-73](#playbook-cli-73)], [[playbook-cli-82](#playbook-cli-82)]). |
| Facade append classification | On separate fresh numerically initialized leases for every case, `null`, another JavaScript primitive, a callable, a JSON-safe array, and a valid record paired with an empty or non-string role shall each reject only to the caller before sanitization, sequence assignment, or writing, leave the file and exact live status unchanged, write no diagnostic, and allow a corrected valid append to resolve `undefined` at the unconsumed next sequence. By contrast, on their own separate fresh numerically initialized leases, a `Date` and a plain cyclic record shall each reject because sanitization cannot produce a JSON-safe record, leave the file and both sequence boundaries unchanged, set `incomplete: true`, suppress a later valid append, and write no facade diagnostic; a successor lease shall accept the unchanged clean prefix with no inherited latch and reuse the unconsumed next sequence ([[playbook-cli-73](#playbook-cli-73)], [[playbook-cli-75](#playbook-cli-75)], [[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-83](#playbook-cli-83)], [[playbook-cli-84](#playbook-cli-84)]). |
| Facade append concurrency | On one numerically initialized unlatched lease at sequence `N`, the suite shall hold a first valid append before its write, invoke a second valid append without awaiting the first, invoke `release()` without awaiting either append, and then invoke a third valid append. While the first remains held, the second append and release shall remain pending and the third shall reject before argument validation, sanitization, sequence assignment, or I/O without changing the file or live status; after the first is unblocked, the first two promises shall each resolve `undefined`, their distinguishable records shall be written at `N + 1` and `N + 2` in invocation order, and release shall wait for both, checkpoint through `N + 2`, retire canonical ownership, return exactly `{lastReadableSeq: N + 2, lastDurableSeq: N + 2, incomplete: false}`, and permit no later append or checkpoint through that lease. On a separate fresh lease starting at `N`, the suite shall hold a first admitted append immediately before an injected pre-byte write failure, invoke another valid append and release while both are demonstrably pending behind that call, and then trigger the failure; the first promise shall reject and latch, the queued successor shall resolve `undefined` without writing, and release shall drain both calls, retire ownership, and return exactly `{lastReadableSeq: N, lastDurableSeq: N, incomplete: true}` rather than inherit the append rejection ([[playbook-cli-23](#playbook-cli-23)], [[playbook-cli-73](#playbook-cli-73)], [[playbook-cli-74](#playbook-cli-74)], [[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-83](#playbook-cli-83)]). |
| Retired facade lease | After a numeric final release and separately after an unavailable null-boundary final release, the suite shall acquire a successor canonical lease before exercising the retired facade handle. The retired handle's `streamStatus()` shall synchronously return exactly its cached final status without I/O, its repeated `release()` shall resolve exactly that status without another checkpoint, ownership probe, retirement, or filesystem I/O, and its `readStream()` shall reject before option validation or I/O; those calls shall leave the stream byte-identical and successor ownership intact so that the successor's own release still succeeds ([[playbook-cli-23](#playbook-cli-23)], [[playbook-cli-73](#playbook-cli-73)], [[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-83](#playbook-cli-83)]). |
| Facade expected control flow | For a canonical id with no Playbook manifest, direct `read()` shall reject an `Error` whose `code` is exactly `PLAYBOOK_SESSION_NOT_FOUND`, while an absent `readStream()` shall return exactly empty entries and `lastReadableSeq: 0` and `acquire()` shall remain usable; a valid stream written through that manifestless lease shall replay normally through `readStream()` and remain unlisted, while a malformed or unsafe directory or manifest shall not carry the not-found code. A competing acquisition against a verified-live current-host owner, a valid foreign-host owner, and a valid foreign-host or verified-live current-host winner observed after a publication race shall each reject an `Error` whose `code` is exactly `PLAYBOOK_SESSION_LEASE_ACTIVE` and preserve that owner, while a malformed or unsafe directory or lease, a current-host owner with an indeterminate process probe, an invalid argument, and a storage fault shall carry neither facade code; no assertion shall depend on error class, name, message, or any other property ([[playbook-cli-23](#playbook-cli-23)], [[playbook-cli-73](#playbook-cli-73)], [[playbook-cli-82](#playbook-cli-82)], [[playbook-cli-83](#playbook-cli-83)]). |
| Writer initialization | After the canonical private directory and lease have passed [[playbook-cli-23](#playbook-cli-23)], each malformed completed envelope or payload, unknown version, invalid sequence, unreadable stream, symlink, non-regular stream, or wrong stream-file mode makes replay-writer initialization leave the stream byte-identical, suppress every replay append and checkpoint, and report exactly `{lastReadableSeq: null, lastDurableSeq: null, incomplete: true}` while both front ends still complete launch, turn, reply, private settlement, and canonical release with their channel-specific warning; store and lease stream reading still reject without partial history, release returns that unavailable status, and each successor reopening the unchanged invalid stream reproduces the unavailable state and signals once through its own channel, while an invalid underlying sessions directory or canonical lease instead retains the existing fail-closed pre-work behavior ([[playbook-cli-74](#playbook-cli-74)], [[playbook-cli-83](#playbook-cli-83)], [[playbook-cli-84](#playbook-cli-84)]). |
| Fail-soft writer | Where either front end observes an entry that cannot become JSON-safe or a stream append, first-publication directory synchronization, torn-tail repair, settlement checkpoint, or release checkpoint fails, the turn, reply, successful private settlement, and otherwise valid release still complete; the readable file remains a clean contiguous prefix; no later replay append or checkpoint occurs; the live read returns every complete line through `lastReadableSeq` while both read and status report `incomplete: true` and the unchanged `lastDurableSeq`; complete lines visible at the failure boundary are not rolled back; and a release-checkpoint failure returns that final incomplete status ([[playbook-cli-75](#playbook-cli-75)], [[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-77](#playbook-cli-77)], [[playbook-cli-83](#playbook-cli-83)]). |
| Degradation signaling | At failed replay initialization and each injected sanitization, append, first-publication synchronization, torn-tail-repair, settlement-checkpoint, and release-checkpoint boundary, headless with a writable sink adds only its exact warning to stderr with stdout unchanged, while managed writes nothing raw to stderr and delivers exactly one presentation-only status through the forwarded gate. A managed source-record failure shall be exercised with an open presenter text block and shall flush and present the triggering source content before the warning status and every later record after it; initialization, settlement, and release warnings shall occur at their completed lifecycle boundaries; the synthetic status shall carry the exact type, null turn, timestamp, omitted data, and message of [[playbook-cli-84](#playbook-cli-84)] and shall never enter replay. Later suppressed work shall add no duplicate, a successor lease shall signal once again, and headless-sink or managed-gate failure shall be swallowed without retry or any changed turn or lifecycle outcome ([[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-77](#playbook-cli-77)], [[playbook-cli-83](#playbook-cli-83)], [[playbook-cli-84](#playbook-cli-84)]). |
| Facade degradation | Through the facade alone, unavailable initialization and an injected post-validation stream-write failure expose only their required live and release status, suppress later replay work, and write no diagnostic to stdout or stderr; presentation remains the external caller's responsibility ([[playbook-cli-73](#playbook-cli-73)], [[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-83](#playbook-cli-83)], [[playbook-cli-84](#playbook-cli-84)]). |
| Follower cursor invalidation | Replacement or truncation below a validated complete-line offset invalidates the incremental cursor and starts validation from byte zero, while canonical-lease turnover alone does neither; replacement or truncation during a read restarts from one snapshot or rejects; a torn tail is reread from its preceding complete-line boundary; an invalid new suffix or an observed rollback rejects without a partial result or cursor advancement; and no result combines file generations ([[playbook-cli-82](#playbook-cli-82)]). |
| Torn tail and successor | A lease-free read omits any nonempty tail and leaves the file byte-identical. After a prefix ending at sequence `N`, with `N = 0` for an empty prefix, held-lease initialization retains an otherwise valid sequence-`N + 1` tail byte-for-byte with exactly one synchronized line feed appended, seeds both sequence values to `N + 1`, and assigns `N + 2` to the next append; every other nonempty tail, including one after an empty prefix, is truncated exactly at the complete-prefix boundary and synchronized without changing prior prefix bytes, seeds both values to `N`, and assigns `N + 1` next. The same invalid envelope when already newline-terminated is complete-prefix corruption, remains byte-identical, and produces unavailable initialization rather than repair. Append without exact ownership is refused; an independent follower of a latched writer sees every intact complete line but no writer-live status; after a normal or post-initialization failed writer, a successor accepts the valid complete prefix actually retained and appends at its next sequence; and a newly acquired lease rescans from byte zero and seeds both reported sequence values from that prefix while reporting no prior process's live-only incomplete latch ([[playbook-cli-74](#playbook-cli-74)], [[playbook-cli-76](#playbook-cli-76)], [[playbook-cli-82](#playbook-cli-82)], [[playbook-cli-83](#playbook-cli-83)]). |

#### playbook-cli-81

Where a config sets `sessions`, the suite shall fail unless both front ends resolve and use that one directory before selecting any record, every resolution case holds — unset default, `~` expansion with `~user` rejected, absolute, dot-relative and bare-relative against the primary config directory, overlay override, injected-store precedence, and fail-closed launch on an unusable directory — the existing managed-child sessions-directory descriptor carries the resolved value unchanged, and the persisted record's structural and execution projections carry no `sessions` member ([[playbook-cli-78](#playbook-cli-78)]).
