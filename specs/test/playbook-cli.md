<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCLI: generic playbook CLI - integration tests

## Intent

This spec defines the integration tests for the generic `playbook`
command in `@sublang/playbook`: config seeding, composition,
enablement validation, readiness gating, and the CLI surface.
The tests drive the real command against a temporary config root and
stubbed cligent tmux-play resolution as needed.

## Seeding

### PBCLI-13
Verifies: [PBCLI-3](../user/playbook-cli.md#pbcli-3), [PBCLI-11](../dev/playbook-cli.md#pbcli-11)

Where the test suite invokes `playbook` without `--config` against a
config root with no `playbook/playbook.config.yaml`, the test suite
shall fail unless the command creates that file from the bundled
starter config, prints the resolved path to stderr, and the seeded
file enables CODE through `playbooks.code.from`
`@sublang/playbook/code/registry` with the
[PBCLI-11](../dev/playbook-cli.md#pbcli-11) lineup (Captain
`claude` / `claude-opus-4-8`, Coder `claude` / `claude-opus-4-8[1m]`,
Reviewer `codex` / `gpt-5.5`, each written inline under `captain` and
the `coder` / `reviewer` roles with no `profiles` map,
`committer: coder`,
`permissions.mode: auto` on every seeded agent with the Codex
Reviewer's additional `.git` writable path, and the notification
defaults).
When the file is already present, the test suite shall fail unless the
command leaves it unchanged and does not reseed.

## Composition

### PBCLI-14
Verifies: [PBCLI-4](../user/playbook-cli.md#pbcli-4), [PBCLI-8](../dev/playbook-cli.md#pbcli-8), [PBCLI-9](../dev/playbook-cli.md#pbcli-9), [PBCLI-10](../dev/playbook-cli.md#pbcli-10)

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
`notifications` and `theme` fields into the composed config unchanged.

## Validation

### PBCLI-15
Verifies: [PBCLI-8](../dev/playbook-cli.md#pbcli-8), [PBCLI-9](../dev/playbook-cli.md#pbcli-9)

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
naming the fault.

## Readiness and CLI surface

### PBCLI-16
Verifies: [PBCLI-1](../user/playbook-cli.md#pbcli-1), [PBCLI-12](../dev/playbook-cli.md#pbcli-12)

When the test suite runs the readiness gate over a composed config,
the test suite shall fail unless: a config whose adapters all have
credentials present launches tmux-play; a config with a missing
`claude` or `codex` credential blocks the launch, prints the help
content plus every failing adapter id to stderr, and exits non-zero
with a status distinct from `127`; and a declared adapter with no
known predicate produces one stderr warning without blocking launch.

### PBCLI-17
Verifies: [PBCLI-1](../user/playbook-cli.md#pbcli-1), [PBCLI-2](../user/playbook-cli.md#pbcli-2), [PBCLI-5](../user/playbook-cli.md#pbcli-5), [PBCLI-6](../user/playbook-cli.md#pbcli-6)

When the test suite exercises the `playbook` CLI surface, the test
suite shall fail unless: `--list` prints each configured playbook's
id, effective command, and intent without launching; `--help` prints
help to stdout and exits `0` without seeding or launching;
`--config <path>` launches that raw config directly without seeding,
composition, or the readiness gate; and the command propagates the
tmux-play exit code, re-raises a terminating signal on itself, and
exits `127` when it cannot launch tmux-play.

### PBCLI-21
Verifies: [PBCLI-18](../user/playbook-cli.md#pbcli-18), [PBCLI-19](../user/playbook-cli.md#pbcli-19), [PBCLI-20](../dev/playbook-cli.md#pbcli-20)

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
an unrequired `--player` role exits `1`.

### PBCLI-24
Verifies: [PBCLI-18](../user/playbook-cli.md#pbcli-18), [PBCLI-22](../user/playbook-cli.md#pbcli-22), [PBCLI-23](../dev/playbook-cli.md#pbcli-23)

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
nothing.

### PBCLI-27
Verifies: [PBCLI-19](../user/playbook-cli.md#pbcli-19), [PBCLI-25](../user/playbook-cli.md#pbcli-25), [PBCLI-26](../dev/playbook-cli.md#pbcli-26)

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
launching.

### PBCLI-30
Verifies: [PBCLI-28](../user/playbook-cli.md#pbcli-28), [PBCLI-29](../dev/playbook-cli.md#pbcli-29)

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
keeps the `claude` defaults.

### PBCLI-31
Verifies: [PBCLI-20](../dev/playbook-cli.md#pbcli-20)

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
prompt-level isolation [DR-013 A1](../decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement)
substitutes when the allowlist is omitted.

### PBCLI-35
Verifies: [PBCLI-20](../dev/playbook-cli.md#pbcli-20), [PBRT-50](../dev/playbook-runtime.md#pbrt-50)

When the test suite exercises `playbook run` with an injected agent-run
function over a synthetic registry entry whose `createRuntime` invokes
the shared `createXStatePlaybookRuntime` factory with a `spec.compat`
declaration the loaded engine does not support, the test suite shall
fail unless the command prints one `playbook run:` stderr diagnostic
naming the declared and supported compatibility values and exits `1`
without any agent call.

### PBCLI-32
Verifies: [PBCLI-8](../dev/playbook-cli.md#pbcli-8), [RELEASE-24](../dev/release.md#release-24)

Where the live release gate ([RELEASE-24](../dev/release.md#release-24))
writes a top-level config for its fixture repositories, when the normal
test suite runs, the test suite shall fail unless that exact config
composes through the launcher against the real CODE and DISCUSS
registry modules, enabling both playbooks and generating the
`code-coder` / `code-reviewer` / `discuss-host` / `discuss-participant`
roster with their expected adapters.
The gate itself is excluded from `pnpm test` and CI, so without this
check a config-model change would break the release gate silently and
surface only during a manual pre-tag run.

### PBCLI-34
Verifies: [PBCLI-33](../dev/playbook-cli.md#pbcli-33)

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
rather than overwriting it.

### PBCLI-38

Verifies: [PBCLI-36](../user/playbook-cli.md#pbcli-36), [PBCLI-37](../dev/playbook-cli.md#pbcli-37)

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
raw exception.

### PBCLI-41

Verifies: [PBCLI-40](../user/playbook-cli.md#pbcli-40), [PBCLI-39](../dev/playbook-cli.md#pbcli-39)

When the test suite exercises the adapter SDK preflight over an
injected probe, the test suite shall fail unless: a config whose
adapters all probe available launches tmux-play unchanged; a config
with one unavailable adapter SDK blocks the launch, prints that
adapter id and its exact `npm install -g <sdk>` remedy to stderr,
exits non-zero with a status distinct from `127`, and spawns nothing;
a config that is simultaneously missing a credential and an SDK
reports both failures rather than only one; an adapter with no known
SDK mapping is excluded from the probe without emitting a second
unknown-adapter warning; a `--config <path>` launch runs no probe;
each distinct adapter is probed at most once per invocation;
`playbook run` with an unavailable SDK exits non-zero naming the same
remedy before constructing the runtime, on a first run and on a
resumed one alike, with no agent call made; an unavailable `opencode`
names both its SDK and its external CLI install; the probe map holds
exactly the adapters backed by cligent's optional peer SDKs (`claude`,
`codex`, `opencode`); a run detected inside npm's ephemeral exec tree
prints one multi-package re-run rather than any `npm install` command;
that re-run names the SDK of every mapped adapter the lineup requires
even when only some are missing — the partially supplied exec tree
case — pins the running package's own version, ends with the original
invocation's arguments shell-quoted rather than placeholder text, and
therefore succeeds in one hop; and the lineup SDK set is deduplicated
when the captain and a player share an adapter.
