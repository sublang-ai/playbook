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
[PBCLI-9](#pbcli-9), and call `entry.createRuntime({ captainOptions,
players })`, where `players` binds each `requiredRoleIds` entry to its
resolved agent under the entry's own local role id and `captainOptions`
carries `{ playbooks: { <id>: { from, options } } }` built from the
`--option` slice so the entry's `validateOptions` sees its own options.
The command shall host the runtime through a headless `PlaybookPorts`
([PBRT](playbook-runtime.md)) backed by cligent: `callPlayer` runs the
bound role's agent through a per-role `Cligent`, threading each call's
`resumeToken` into the next `resume`; `callJudge` and `callCaptain` run
the captain agent, and `callCaptain` starts a fresh session with an
empty tool allowlist whenever its options request one; `callPlaybook`
shall reject, since a one-shot run hosts no sub-playbooks; `emitStatus`
shall write to stderr and `emitTelemetry` shall be dropped unless
`--verbose`.
The command shall run one `handleBossInput` turn under an abort signal,
`dispose` the runtime, and map the `PlaybookRunResult` outcome to an
exit status: `terminal` → `0` (printing `output`), `failed` or
`aborted` → `2`, `suspended` and `quiescent`/`no-action` → `3`.
The `run` subcommand shall accept an injected agent-run function so
tests can drive it without real adapters, defaulting to cligent's
`Cligent`.
