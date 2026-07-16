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
normalize the top-level `profiles` and `playbooks` maps into a
tmux-play config whose `captain.from` is
`@sublang/playbook/playbook-captain` and whose
`captain.options.playbooks` holds one normalized entry per enabled
playbook.
Each normalized `captain.options.playbooks.<id>` entry shall carry the
`playbooks.<id>` block's `from`, its optional `command`, and an
`options` slice built from every non-launcher key of the block (such
as CODE's `committer`); `from`, `command`, and `players` shall not
appear in the option slice.
The command shall resolve a scalar `captain` or `players.<role>` value
as a profile id from `profiles` or as an adapter shorthand.
A full `captain` or `players.<role>` block's optional `profile` key
shall name a `profiles` entry only — not an adapter shorthand — and the
block shall set any adapter through the agent block's own `adapter`
field; the command shall reject a `profile` value that names no known
profile with a path-named error.
When an agent block references a profile, the command shall compose the
resolved tmux-play agent block from the profile's settings as the base
and the block's own explicit fields as overrides, and shall emit no
`profile` key in the composed config, since the tmux-play agent-block
schema does not define one.
The command shall reject a `profiles` id that collides with a known
adapter shorthand id such as `claude` or `codex` with a path-named
error, rather than let a profile silently shadow an adapter shorthand.

### PBCLI-9

Where `playbook` composes the runtime config, the command shall
generate the top-level tmux-play `players` roster as the launch-time
union of every enabled playbook's players, binding local role
`<role>` of playbook `<id>` to a host player whose `id` is
`<id>-<role>`, where `<id>` is the `playbooks.<id>` config key.
When two playbooks reference the same profile, the command shall still
emit separate playbook-scoped host players.
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
The seeded `profiles` shall be `claude-opus` (Captain),
`claude-opus-1m` (Coder), and `codex-gpt` (Reviewer): profile ids that
name the underlying agent/model rather than a player role.
The seeded `captain` shall reference `claude-opus`, `players.coder`
shall reference `claude-opus-1m`, and `players.reviewer` shall
reference `codex-gpt`, so the profile ids stay distinct from the
`captain` / `coder` / `reviewer` roles that reference them.
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
these profile ids and their `adapter` / `model` / `reasoningEffort`
values are defaults and remain user-tunable per
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
the captain agent, `callJudge` always starts a fresh session with an
explicit empty tool allowlist, and `callCaptain` forwards its requested
resume and tool-allowlist options exactly; `callPlaybook`
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
