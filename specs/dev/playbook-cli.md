<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCLI: generic playbook CLI

## Intent

This spec defines the implementation requirements of the generic
`playbook` command in the `@sublang/playbook` package: how it resolves
cligent's tmux-play, seeds and composes config, validates enablement,
and gates launch on adapter readiness.
User-visible behavior is in
[user/playbook-cli.md](../user/playbook-cli.md).

## Resolution

### PBCLI-7

The `playbook` command shall resolve cligent's `tmux-play` CLI via
`import.meta.resolve('@sublang/cligent/tmux-play')` from within
`@sublang/playbook`'s own module tree — not from `PATH`, since a
global install links executables only for top-level packages.
`package.json` `engines.node` shall be `>=20.6.0`, the floor at which
the synchronous `import.meta.resolve` used here is available; adopting
a newer Node API in the command shall raise this floor in the same
change.

## Composition

### PBCLI-8

Where `playbook` composes the runtime config
([PBCLI-1](../user/playbook-cli.md#pbcli-1)), the command shall
normalize the top-level `playbooks` map into a
tmux-play config whose `captain.from` is
`@sublang/playbook/playbook-captain` and whose
`captain.options.playbooks` holds one normalized entry per enabled
playbook.
The command shall also set `captain.options.captainAdapter` to the resolved
captain agent's adapter, which the shell cannot otherwise read from the
tmux-play Captain context and needs to decide whether an explicit empty tool
allowlist can be enforced
([DR-013 A1](../decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement)).
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
[PBCLI-33](#pbcli-33) migration, such as one introduced by a `--with`
overlay, because a scalar that formerly named a profile now reads as an
adapter shorthand and would otherwise fail far downstream as an unknown
adapter.

### PBCLI-9

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
([CAPTAIN-5](playbook-captain.md#captain-5)) and, before launching
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
[CAPTAIN-16](playbook-captain.md#captain-16) — missing `from`, failed
import, invalid entry, key / manifest-`id` mismatch, duplicate id, and
duplicate effective command, plus the reserved playbook id and effective
command.
The roster-resolution, reserved-role, and visible-role checks above
are launcher-owned
([DR-009 §4](../decisions/009-generic-playbook-cli-and-registry.md));
the shell relies on that validation and treats any residual
`setVisiblePlayers` rejection as an internal or composition error
([CAPTAIN-22](playbook-captain.md#captain-22)) rather than
re-validating the roster itself.

### PBCLI-10

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
([PBCLI-11](#pbcli-11)) reach the host.
A raw tmux-play config launched through `--config` retains direct
access to `layout.initialVisible`
([PBCLI-1](../user/playbook-cli.md#pbcli-1)).

## Seeding and readiness

### PBCLI-11

Where `playbook` seeds the starter generic config
([PBCLI-3](../user/playbook-cli.md#pbcli-3)), the bundled starter
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
these `adapter` / `model` / `reasoningEffort` values are defaults and
remain user-tunable in place per
[PBCLI-6](../user/playbook-cli.md#pbcli-6).

### PBCLI-12

Where `playbook` runs the readiness gate
([PBCLI-1](../user/playbook-cli.md#pbcli-1),
[PBCLI-6](../user/playbook-cli.md#pbcli-6)), the command shall collect
the declared `adapter` values from the composed config — the
`captain.adapter` and every generated player's `adapter` — and treat
`claude` as ready when `ANTHROPIC_API_KEY` is set or `$HOME/.claude/`
exists, and `codex` as ready when `OPENAI_API_KEY` is set or
`$HOME/.codex/` exists.
When any declared adapter with a known readiness predicate is not
ready, the command shall block the launch per
[PBCLI-6](../user/playbook-cli.md#pbcli-6).
For every distinct adapter value other than `claude` or `codex`, the
command shall emit one stderr warning and shall exclude that adapter
from the blocking readiness result.
Playbook registry entries shall not define adapter or credential
readiness predicates; readiness remains launcher-owned
([DR-009 §7](../decisions/009-generic-playbook-cli-and-registry.md)).

## Non-interactive run

### PBCLI-20

Where `playbook run` ([PBCLI-18](../user/playbook-cli.md#pbcli-18))
executes, the command shall import the `<from>` module, validate its
default export with the same structural registry check as
[PBCLI-9](#pbcli-9), resolving a relative filesystem `<from>` against
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
[DR-013 A1](../decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement)
rather than fail every judge call, and `callCaptain` forwards its requested
resume and tool-allowlist options exactly, preserving omission rather than
creating an own `allowedTools: undefined` property; `callPlaybook`
shall return a suspended start with a fresh synthetic child-session id
without launching a child, so the linked runtime reports the nested pause
that the one-shot host cannot answer; `emitStatus` shall write to stderr
and `emitTelemetry` shall be dropped unless `--verbose`.
The command shall initialize a depth-zero `PlaybookSession` whose
`sessionId` and `rootSessionId` are the same fresh UUID, run one
`handleBossInput` turn under an abort signal, and map the
`PlaybookRunResult` outcome to an exit status: `terminal`
→ `0` (printing `output`), `failed` or
`aborted` → `2`, `suspended` and `quiescent`/`no-action` → `3`.
The command shall `dispose` the runtime on every path except a parked
turn it persists per [PBCLI-23](#pbcli-23), which hands the session off
without disposal ([DR-014 §2](../decisions/014-durable-one-shot-run-sessions.md#2-a-session-may-park-across-processes)).
The default agent shall run each `Cligent` in protected auto mode
(`permissions.mode: auto`, as the seeded lineup uses per
[PBCLI-11](#pbcli-11)) so a one-shot run does not block on routine
approval prompts. Where Cligent's terminal `done` event omits `result`,
the agent drain shall derive `finalText` from the ordered `text` event
`content` and `text_delta` event `delta` payloads. Player and Captain
result adapters shall omit absent optional fields rather than emitting
own properties whose value is `undefined`.
The `run` subcommand shall accept an injected agent-run function so
tests can drive it without real adapters, defaulting to cligent's
`Cligent`.

### PBCLI-23

Where a `playbook run` turn settles `quiescent` and the runtime's
`exportSnapshot` ([PBRT-45](playbook-runtime.md#pbrt-45)) returns a
snapshot with at least one pending Boss question, the command shall
write one session file at
`${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions/<sessionId>.json`
with file mode `0600` (parent directories mode `0700`), skip runtime
disposal, print each pending question's text to stdout, and print one
stderr hint naming the session id and the resume command
([PBCLI-18](../user/playbook-cli.md#pbcli-18)).
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
([PBCLI-22](../user/playbook-cli.md#pbcli-22)), the command shall
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

### PBCLI-26

Where the `playbook` launcher handles `--with`
([PBCLI-25](../user/playbook-cli.md#pbcli-25)), the command shall parse
and remove each `--with <path>` pair from the argument vector before
any arguments are forwarded to tmux-play, resolve each path against the
process working directory, and apply the fragments to the parsed
top-level config with a merge that recurses only into plain maps on
both sides, replaces every other collision with the fragment's value,
and never mutates the parsed global config or the fragment objects.
Where `playbook run` binds efforts
([PBCLI-19](../user/playbook-cli.md#pbcli-19)), the command shall split
the effort at the last `@` of the `<agent>` value and the adapter at
the first colon of the remainder — so the model keeps every interior
colon — validate each spec's effort through cligent's adapter-scoped
effort support metadata for the spec's adapter shorthand, and name the
adapter's supported values in the rejection diagnostic.
The default agent shall pass a bound effort to its `Cligent` as the
`effort` option alongside the model; the injected agent-run function
([PBCLI-20](#pbcli-20)) shall receive the effort in its spec so tests
can observe it.
Session records ([PBCLI-23](#pbcli-23)) shall carry each spec's
optional `effort` and resume validation shall accept and re-validate
it.

### PBCLI-29

Where `playbook run` resolves config defaults
([PBCLI-28](../user/playbook-cli.md#pbcli-28)), the command shall read
the user config from the same resolved path as the interactive
launcher ([PBCLI-3](../user/playbook-cli.md#pbcli-3)), treat a missing
file as an empty default set, parse each `run.captain`, `run.player`,
and `run.players.<role>` string through the same agent-spec parser as
`--player`/`--captain`, and validate the specs it binds through the
same adapter and effort path as flag-bound specs
([PBCLI-26](#pbcli-26)); a structural fault — a non-map `run` or
`run.players`, a non-string agent value, or an unparseable agent
string — shall name the faulty config key in its diagnostic.
The `playbook` launcher shall forward its resolved — or injected —
user-config path to the `run` subcommand, so both surfaces read one
file under the same environment and home overrides.
The `run` subcommand shall accept an injected user-config path so
tests can drive config defaults in isolation, like the injected
session store ([PBCLI-23](#pbcli-23)).

### PBCLI-33

Where `playbook` resolves its top-level config for a launch and that
file still carries a top-level `profiles` map or an agent-block
`profile` key, the command shall migrate it in place before composing
([DR-021 §3](../decisions/021-inline-agent-settings.md#3-an-existing-config-migrates-itself-once)):
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
