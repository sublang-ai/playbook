<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Configuring agents

Fresh launches and ordinary reopens read one config at
`${SPEX_HOME:-$HOME/.spex}/config/playbook.config.yaml`. The
first launch seeds it from the bundled starter and prints the path;
later launches reuse it untouched.

On the first launching command after upgrading Playbook, it moves a config from
either former location when the canonical path is absent — the root's
`playbook/playbook.config.yaml` first, then
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`. Exactly one
file moves; the one-time move preserves bytes and permissions, takes the former
file's directory with it when that leaves it empty, and leaves no compatibility
alias, so running an older Spex host afterward could seed a second file at the
path it still resolves.

The current guard rejects relocation when a former relative `sessions` value
or relative filesystem `playbooks.<id>.from` would resolve differently below
the new directory. It leaves the former file unchanged and names every
target-preserving absolute replacement. Apply those replacements and retry;
Playbook does not rewrite the user-authored file. `config/` sits at the depth
the root's `playbook/` did, so a relative locator reaching outside the directory
keeps its target across that move; only one pointing into the directory is
refused as above.

```sh
$EDITOR "${SPEX_HOME:-$HOME/.spex}/config/playbook.config.yaml"
```

## Anatomy

The config is top-level (no `config:` wrapper): a `captain` agent, one flat
`players` map of stable Captain-session agents, a `playbooks` map of enabled
workflows and their explicit role bindings, an optional `sessions` storage
locator, and optional `layout` / `notifications` / `theme`. The Captain runs
hidden control and judge calls and writes the replies you see in the Captain
pane or on headless stdout. The three presentation fields apply only to
interactive tmux; headless runs ignore them.

A **role** is local to a playbook artifact: CODE's `coder` and REVIEW's `coder`
have the same semantic name but remain separate declarations. A **player** is
a stable session-wide provider conversation with an exact ID such as
`dev.coder`. A role uses only the player named by its binding; matching role
names, nesting, and ancestry never infer a binding.

Each `captain` or `players.<player-id>` value is either an adapter shorthand
(`claude`, `codex`) or a block carrying that agent's own `adapter`, `model`,
`effort`, `fastMode`, `subagentModel`, `subagentEffort`, `instruction`, and
`permissions`. Settings are inline per stable agent
([DR-021](https://github.com/sublang-ai/playbook/blob/main/specs/decisions/021-inline-agent-settings.md)).
Dots in a player ID are literal characters, not YAML hierarchy. Other adapter
IDs pass through to `tmux-play` with a warning because `playbook` cannot
preflight their auth.

Within a `playbooks.<id>` block, `from` (the registry module), `command` (an
optional slash-command override), and `roles` are launcher-owned; every other
key is that playbook's option slice. `from` is required unless the launch
supplies that playbook's module with `--module <id>=<specifier>` (or an
embedding host's `modules` option), or a reopened session already records
one; see [Modules supplied at launch](#modules-supplied-at-launch). Every
manifest role must be present exactly once. The launcher injects the rest — you do not write host wiring by
hand.

The launcher seeds one adapter for the Captain and all stable players from
locally visible credentials: Claude first, then Codex. It uses Claude Opus 5.5
for Claude or GPT-6 Sol for Codex, with Captain and Coder at `high` effort
and Reviewer and Analyst at `xhigh`. If neither adapter is configured, it
seeds Claude and prints a notice. Credentials do not prove SDK availability
or remaining quota; launch still checks the configured adapter. Existing
configs are left unchanged.

The Claude default is shown below. A Codex seed also adds
`permissions.writablePaths: ['.git']` to each agent:

```yaml
captain:
  adapter: claude
  model: claude-opus-5-5
  effort: high
  permissions:
    mode: auto # protected auto mode for the Claude Captain

players:
  dev.coder:
    adapter: claude
    model: claude-opus-5-5
    effort: high
    permissions:
      mode: auto # protected auto mode for the Claude Coder

  dev.reviewer:
    adapter: claude
    model: claude-opus-5-5
    effort: xhigh
    permissions:
      mode: auto # protected auto mode for the Claude Reviewer

  dev.analyst:
    adapter: claude
    model: claude-opus-5-5
    effort: xhigh
    permissions:
      mode: auto # protected auto mode for the Claude Analyst

  inspect.inspector:
    adapter: claude
    model: claude-opus-5-5
    effort: high
    permissions:
      mode: auto

playbooks:
  code:
    from: '@sublang/playbook/code/registry'
    roles:
      coder: dev.coder

  review:
    from: '@sublang/playbook/review/registry'
    roles:
      coder: dev.coder
      reviewer: dev.reviewer

  decide:
    from: '@sublang/playbook/decide/registry'
    roles:
      coder: dev.coder
      reviewer: dev.reviewer

  dev:
    from: '@sublang/playbook/dev/registry'
    roles:
      analyst: dev.analyst

  # Pull-request delivery for DEV. BRANCH and PR bind Coder to the same
  # dev.coder player as CODE and REVIEW on purpose: the Coder that read the
  # issue and named the branch makes the commits and then describes them in
  # the pull request. Change an id to isolate its conversation.
  branch:
    from: '@sublang/playbook/branch/registry'
    roles:
      coder: dev.coder

  pr:
    from: '@sublang/playbook/pr/registry'
    roles:
      coder: dev.coder

  inspect:
    from: '@sublang/playbook/inspect/registry'
    roles:
      inspector: inspect.inspector
```

The current bundled workflows accept no workflow-specific options.
Each role's per-call prompt names its current `model`, else its player's
`adapter`
([[playbook-runtime-4](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-runtime.md#playbook-runtime-4)]),
so commit trailers credit the concrete model rather than the adapter
family.

## Role binding forms

The shortest binding is a scalar stable player ID:

```yaml
roles:
  coder: dev.coder
```

Use a block to override only that role invocation's model, effort, fast mode,
subagent model, or subagent effort:

```yaml
roles:
  coder:
    player: dev.coder
    model: claude-sonnet-5-5
    effort: false # explicitly reset to this provider's default
    fastMode: false # literal disabled request, not a default sentinel
  reviewer:
    player: dev.reviewer
    subagentModel: inherit # inherit | <model> | false
    subagentEffort: medium # <effort> | false
```

Omitting any override inherits that player's top-level default. For `model`,
`effort`, `subagentModel`, and `subagentEffort`, boolean `false` selects the
provider default explicitly, so a resumed conversation cannot accidentally
retain an earlier selection. For `fastMode`, `false` is a literal request to
disable fast mode; omitting the top-level setting selects the provider default.
A present fast-mode boolean, subagent model, or subagent effort is accepted
only for adapters Cligent reports as supporting it. A role binding cannot override adapter, instruction,
permissions, workspace, or tool posture; those define the stable player
envelope, so an overriding model must be one that player's adapter serves.

`subagentModel` makes every subagent the agent starts run on one model —
`inherit` names the agent's own, a model name pins another, and `false` on a
`captain` or `players.<player-id>` block switches delegation off — and tells
the agent to hand well-defined, fine-grained tasks to its subagents while
keeping the deep thinking, reasoning, and design work itself, without lowering
the quality of what it delivers
([DR-075](https://github.com/sublang-ai/playbook/blob/main/specs/decisions/075-subagent-model-is-tuning.md)).
`subagentEffort`, any effort the adapter accepts other than `ultracode`, pins
the effort the agent's delegated work runs at; left unset, the agent chooses an
effort per task. On Claude, a pinned effort governs Cligent's `delegate`
subagent and the `general-purpose` one it replaces, while an unpinned agent's
choice runs through `delegate-<effort>` subagents and a call naming no type
runs `general-purpose` at `medium`; `Explore` and `Plan` are never replaced and
keep the agent's own effort
([Cligent DR-029](https://github.com/sublang-ai/cligent/blob/main/specs/decisions/029-subagent-effort.md)).
An agent whose adapter serves a subagent model (Claude today) and whose block
leaves `subagentModel` unset resolves to `inherit`: it delegates by default.
The launcher resolves this on its own copy and never rewrites your config, and
the starter config names neither field
([DR-076](https://github.com/sublang-ai/playbook/blob/main/specs/decisions/076-subagents-delegate-by-default.md)).


## Sharing, isolation, and concurrency

Two bindings that name the same player ID deliberately share one sequential
provider conversation throughout the logical Captain session — across nested
calls, returns, and later root engagements. CODE's, REVIEW's, BRANCH's, and
PR's `coder` roles therefore share `dev.coder` in the starter — so on a `/dev`
pull-request path the Coder that read the issue and named the branch makes the
commits and then describes them in the pull request — and DECIDE and its
nested REVIEW share both starter players. DEV's `analyst` instead binds the
distinct `dev.analyst` player, so planning context does not bleed into the
shared review conversation. Disposal of one playbook frame does not clear that
session ledger.

Two distinct player IDs stay isolated even when their agent blocks are
byte-for-byte equal. To give standalone REVIEW an independent Coder, define a
second top-level player and change only its binding:

```yaml
players:
  review.coder:
    adapter: codex
    model: gpt-6-sol
    effort: ultra
    permissions:
      mode: auto
      writablePaths: ['.git'] # lets the Codex Coder commit its review fixes

playbooks:
  review:
    from: '@sublang/playbook/review/registry'
    roles:
      coder: review.coder
      reviewer: dev.reviewer
```

Roles a manifest may run concurrently must bind to distinct IDs. DECIDE's
`coder` and `reviewer` are concurrent, so aliasing both to one player rejects
before registry import, host creation, or agent work.

## Choosing the Captain agent

Ordinary Captain decisions, replies, question checks and adjudication are hidden and tool-free.
Claude and Gemini enforce the tool restriction at the
provider level. The Codex, Kimi, and OpenCode adapters cannot — they
reject any tool list — so a `captain:` using one of them falls back to a
prompt-level restriction
([DR-013](https://github.com/sublang-ai/playbook/blob/main/specs/decisions/013-routing-only-captain-control.md) A1).
Those adapters remain good choices for *players*, where full tools are wanted.

Recovery preparation is separate: Captain may use its configured tools and permissions to repair prerequisites for the paused step, within the existing task.
It may not finish the specialist’s task or invent a decision; discarding work or rewriting history requires your explicit instruction.
Preparation has a 150-second limit.

Adapter readiness is intentionally light: `claude` is ready with local
Claude Code auth or `ANTHROPIC_API_KEY`; `codex` with local Codex CLI
auth or `OPENAI_API_KEY`. A known adapter that is not ready blocks the
launch and prints the help text.

## Browser capability

A Captain or player agent block may set `browser: true` to make Cligent's managed
browser tools available to working calls. Existing configurations default to
false. This is an execution capability: reopening the same settled session with a
changed value applies it to the next accepted turn. Recovery of an uncertain turn
uses that attempt's recorded value. Agent permissions remain fixed and retain
their native precedence.

Ordinary Captain decisions, replies, question checks and judges always receive
`browser: false` and an empty MCP configuration. Enabling Browser does not turn
them into working actors. A working player, or bounded recovery preparation when
needed, can use the capability explicitly configured for its agent. An embedding
application should use Cligent's capability and browser-preparation APIs before
enabling its Browser control and report setup failures; Playbook does not invent a
successful setup or change permissions to make it succeed.

For browser inspection, enable `browser: true` on `players.inspect.inspector`
and ask `/inspect Open http://localhost:3000, capture a screenshot, and explain
the navigation.` Keep the application running and give its exact address. The
Inspector uses actual tool results and native images, asks about missing targets,
and reports unavailable evidence explicitly. Browser capture supports web pages;
it does not grant arbitrary operating-system desktop control.

## Per-launch overlays

To retune one launch without editing the file, overlay a fragment in
the same format with `--with` (repeatable, later files win; maps merge
recursively, other values replace):

```sh
playbook --with fast-lineup.yaml
playbook run --with fast-lineup.yaml "/code implement the approved change"
```

```yaml
# fast-lineup.yaml — retune the shared Coder; nothing is written back.
players:
  dev.coder:
    model: claude-sonnet-5-5
    effort: medium
    fastMode: false
```

Fragments merge into the agent block rather than replacing it, so
settings the base defines and the fragment omits — here the adapter,
instruction, and permissions — survive. Retuning a top-level player affects
every bound role that does not override that field. To retune only one role,
overlay its binding instead:

```yaml
playbooks:
  code:
    roles:
      coder:
        player: dev.coder
        effort: low
        subagentEffort: high # its delegates still run at high effort
```

The global file is never modified, and `--with` is not forwarded to
`tmux-play` ([[playbook-cli-25](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#playbook-cli-25)]).
Overlays apply when creating a fresh session and as current-config input for a
compatible ordinary reopen. A selected session keeps its stored catalog,
player roster, role bindings, adapter, instruction, permissions, and working
directory; only model, effort, fast mode, subagent model, and subagent effort
may change. The next call reapplies both complete model and effort selections,
the optional effective fast-mode boolean, and the optional effective subagent
model and subagent effort. An uncertain retry accepts no tuning overlay and only restores and reports the recorded attempt. Later turns use the current compatible settings.

## Session storage

Both front ends select canonical session manifests and write replay streams in
one directory, shared with embedding hosts. Set the
optional top-level `sessions` key to move that shared store:

```yaml
sessions: ./state/playbook-sessions
```

The value must be a nonempty filesystem path. When the key is absent, the
directory is
`${SPEX_HOME:-$HOME/.spex}/sessions`. An absolute path is
used as given; `~` and `~/...` expand from the home directory, while `~user`
is rejected. Every other value, including a bare relative path such as the one
above, resolves against the primary config file's directory rather than the
invocation directory. A `sessions` value in a `--with` overlay replaces the
primary value, with later overlays winning.

Launch validates that the resolved path can serve as the mode-`0700`, real,
non-symlink session store before selecting a record or starting agent work and
fails closed when it cannot. The non-launching `playbook --list` command still
validates the locator's syntax but does not inspect that directory's filesystem
usability. The resolved locator is launch configuration only: it never enters
a persisted structural or execution projection
([[playbook-cli-78](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#playbook-cli-78)]).

## Durable shared configuration

Fresh interactive and headless sessions use the same top-level Captain,
players, role bindings, and playbooks. Both persist the same logical-session
record, shell snapshot, player ledger, normalized catalog, structural agent
envelopes, last-applied tuning, and absolute working directory. A session
created by either front end can reopen through either front end with the same
public UUID. Presentation-only fields are inert headlessly.

An ordinary reopen reads current config and opening overlays, but first
projects them to the stored playbooks and referenced players. An unrelated new
entry cannot enter or invalidate the session. Structural drift fails closed;
compatible model, effort, fast-mode, subagent-model, or subagent-effort
changes apply on the next provider call. Legacy record, shell, runtime-snapshot, and trace schemas are rejected
rather than having role or player identity guessed.

## External playbooks

`slc playbook my-workflow.md` emits `my-workflow.ts` beside its artifact
directory. That file already default-exports the registry manifest Playbook
requires: `id`, `command`, `intent`, `requiredRoleIds`, `validateOptions`,
and `createRuntime`. Enable it under `playbooks`, bind every role listed in
its `requiredRoleIds`, and invoke its effective slash command through Captain:

```yaml
players:
  my.worker: claude

playbooks:
  my-workflow:
    from: /absolute/path/to/my-workflow.ts
    roles:
      worker: my.worker
```

```sh
playbook run "/my-workflow perform the task"
```

Importing a `.ts` registry uses Node's native type stripping, available
unflagged on Node 22.18+ and 23.6+; on the older Node versions this
package supports (>= 20.6), compile the registry and point `from` at the
emitted `.js` module instead.

A relative path-shaped `from` is resolved relative to the primary config
file, not the invocation directory; an absolute path is clearest for an SLC
entry emitted in a project working tree.
Before either front end imports a filesystem registry, the shared launcher
checks and, unless `--no-provision` is set, provisions its runtime engine
links as described in [Using the CLI](cli.md#external-playbooks-and-engine-provisioning).

### Modules supplied at launch

A config may leave `playbooks.<id>.from` out when the launch supplies the
module instead, so the shared file names no machine-specific path:

```yaml
playbooks:
  my-workflow:
    roles:
      worker: my.worker
```

```sh
playbook run --module my-workflow=/opt/env/my-workflow.js "/my-workflow perform the task"
```

A supplied module wins over a `from` the file does carry, and it is never
written back to your config files. A playbook with neither is refused before any import:
`playbooks.<id> names no module: set playbooks.<id>.from or supply a module for
<id> (--module <id>=<specifier>)`. A malformed `from` is still refused even
when a module is supplied. Reopening a recorded session needs neither: with
no `from` and no `--module`, it uses the module the session already records.
Otherwise the module so taken — the supplied one, else a present `from` — must
equal the stored module; a present `from` beside a supplied module is checked
for form only
([DR-083](https://github.com/sublang-ai/playbook/blob/main/specs/decisions/083-module-locations-supplied-at-launch.md)).

## Migrating per-playbook players

The former `playbooks.<id>.players` shape made agent configuration and local
workflow roles the same thing. It is removed. For example, this legacy config
gave CODE and REVIEW two separately configured `coder` entries:

```yaml
playbooks:
  code:
    from: '@sublang/playbook/code/registry'
    players:
      coder: { adapter: claude, model: claude-opus-5-5 }
  review:
    from: '@sublang/playbook/review/registry'
    players:
      coder: { adapter: claude, model: claude-opus-5-5 }
      reviewer: { adapter: codex, model: gpt-6-sol }
```

Move each provider agent into the flat top-level map, choose stable IDs, and
bind the local roles explicitly:

```yaml
players:
  dev.coder: { adapter: claude, model: claude-opus-5-5 }
  dev.reviewer: { adapter: codex, model: gpt-6-sol }

playbooks:
  code:
    from: '@sublang/playbook/code/registry'
    roles: { coder: dev.coder }
  review:
    from: '@sublang/playbook/review/registry'
    roles:
      coder: dev.coder
      reviewer: dev.reviewer
```

The launcher intentionally does **not** perform this migration for you. It
cannot know whether the two old `coder` blocks were meant to share one
conversation or remain isolated. Reusing `dev.coder` above chooses sharing;
using `code.coder` and `review.coder` would choose isolation. A surviving
per-playbook `players` block therefore rejects before profile migration,
registry preparation, or agent work.

## Migrating direct runs from 6.x

The top-level `run:` block is deliberately rejected rather than silently
ignored or rewritten, because doing otherwise could change the agents after
an upgrade. Re-express `run.captain`, `run.players`, and former `--player`
bindings as top-level stable player blocks and explicit role bindings above;
the old `run.player` catch-all has no shared equivalent, so configure every
required role at `playbooks.<id>.roles.<role>`. Use a `--with` fragment for
temporary compatible tuning changes. Move former `--option` values into their `playbooks.<id>`
block, run from the desired directory instead of passing `--cwd`, enable a
former positional `<from>` as a configured registry, and quote or pipe one
`/command task` Boss message. Replace `resume` and `--last` with `--continue`
or `--session`.

The JSON response is now exactly `{ "sessionId": "…", "reply": "…" }`.
Released direct-run session records are not complete Captain sessions and
cannot be continued by the new host ([[playbook-cli-19](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#playbook-cli-19)],
[[playbook-cli-22](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#playbook-cli-22)],
[[playbook-cli-28](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#playbook-cli-28)]).

## Migrating from `profiles`

Configs written before 3.0.0 carried a top-level `profiles` map. The
launcher rewrites such a config on the next launch — inlining each
profile's settings into the agent that named it, keeping your comments,
and saving the original as `<config>.bak` — then continues. Nothing to
do by hand.

## Using a raw tmux-play config

For a one-off, pass a raw `tmux-play` config explicitly. This bypasses
the seed, composition, and readiness gate, forwarding arguments to
`tmux-play` verbatim ([[playbook-cli-1](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#playbook-cli-1)]):

```sh
playbook --config ./tmux-play.config.yaml
```
