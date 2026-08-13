<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Configuring agents

Fresh launches and ordinary reopens read one config at
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`. The
first launch seeds it from the bundled starter and prints the path;
later launches reuse it untouched.

```sh
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml"
```

## Anatomy

The config is top-level (no `config:` wrapper): a `captain` agent, one flat
`players` map of stable Captain-session agents, a `playbooks` map of enabled
workflows and their explicit role bindings, and optional `layout` /
`notifications` / `theme`. The Captain runs hidden control and judge calls and
writes the replies you see in the Captain pane or on headless stdout. The three
presentation fields apply only to interactive tmux; headless runs ignore them.

A **role** is local to a playbook artifact: CODE's `coder` and REVIEW's `coder`
have the same semantic name but remain separate declarations. A **player** is
a stable session-wide provider conversation with an exact ID such as
`dev.coder`. A role uses only the player named by its binding; matching role
names, nesting, and ancestry never infer a binding.

Each `captain` or `players.<player-id>` value is either an adapter shorthand
(`claude`, `codex`) or a block carrying that agent's own `adapter`, `model`,
`effort`, `instruction`, and `permissions`. Settings are inline per stable
agent ([DR-021](../specs/decisions/021-inline-agent-settings.md)). Dots in a
player ID are literal characters, not YAML hierarchy. Other adapter IDs pass
through to `tmux-play` with a warning because `playbook` cannot preflight their
auth.

Within a `playbooks.<id>` block, `from` (the registry module), `command` (an
optional slash-command override), and `roles` are launcher-owned; every other
key is that playbook's option slice. Every manifest role must be present
exactly once. The launcher injects the rest — you do not write host wiring by
hand.

The seeded config runs the stable Coder player on Claude Opus 4.8 1m and the
stable Reviewer player on GPT-5.5:

```yaml
captain:
  adapter: claude
  model: claude-opus-4-8
  effort: high
  permissions:
    mode: auto # protected auto mode for the Claude Captain

players:
  dev.coder:
    adapter: claude
    model: claude-opus-4-8[1m]
    effort: xhigh
    permissions:
      mode: auto # protected auto mode for the Claude Coder

  dev.reviewer:
    adapter: codex
    model: gpt-5.5
    effort: xhigh
    permissions:
      mode: auto
      writablePaths:
        - .git # allow git metadata writes under Codex auto mode

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
```

The current bundled workflows accept no workflow-specific options.
Each role's per-call prompt names its current `model`, else its player's
`adapter`
([[playbook-runtime-4](../specs/packages/playbook-runtime.md#playbook-runtime-4)]),
so commit trailers credit the concrete model rather than the adapter
family.

## Role binding forms

The shortest binding is a scalar stable player ID:

```yaml
roles:
  coder: dev.coder
```

Use a block to override only that role invocation's model or effort:

```yaml
roles:
  coder:
    player: dev.coder
    model: claude-opus-4-8[1m]
    effort: false # explicitly reset to this provider's default
```

Omitting `model` or `effort` inherits that player's top-level default. The
boolean `false` is different: it selects the provider default explicitly, so a
resumed conversation cannot accidentally retain an earlier selection. A role
binding cannot override adapter, instruction, permissions, workspace, or tool
posture; those define the stable player envelope.

## Sharing, isolation, and concurrency

Two bindings that name the same player ID deliberately share one sequential
provider conversation throughout the logical Captain session — across nested
calls, returns, and later root engagements. CODE's and REVIEW's `coder` roles
therefore share `dev.coder` in the starter, and DECIDE and its nested REVIEW
share both starter players. Disposal of one playbook frame does not clear that
session ledger.

Two distinct player IDs stay isolated even when their agent blocks are
byte-for-byte equal. To give standalone REVIEW an independent Coder, define a
second top-level player and change only its binding:

```yaml
players:
  review.coder:
    adapter: claude
    model: claude-opus-4-8[1m]
    effort: xhigh

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

Every session-Captain call and adjudication call is hidden and runs
tool-free, which is what keeps the Captain deciding and reporting
instead of doing the work itself. Claude enforces
that at the provider level. The Codex adapter cannot — it rejects any
tool list — so a `captain:` on `codex` falls back to a prompt-level
restriction
([DR-013](../specs/decisions/013-routing-only-captain-control.md) A1).
Codex remains a good choice for *players*, where full tools are wanted.

Adapter readiness is intentionally light: `claude` is ready with local
Claude Code auth or `ANTHROPIC_API_KEY`; `codex` with local Codex CLI
auth or `OPENAI_API_KEY`. A known adapter that is not ready blocks the
launch and prints the help text.

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
    model: claude-opus-4-8
    effort: medium
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
```

The global file is never modified, and `--with` is not forwarded to
`tmux-play` ([[playbook-cli-25](../specs/packages/playbook-cli.md#playbook-cli-25)]).
Overlays apply when creating a fresh session and as current-config input for a
compatible ordinary reopen. A selected session keeps its stored catalog,
player roster, role bindings, adapter, instruction, permissions, and working
directory; only model and effort may change. The next call reapplies both
complete selections. An uncertain retry accepts no tuning overlay and uses the
exact attempted selections already stored with that turn.

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
compatible model or effort changes apply on the next provider call. Legacy
record, shell, runtime-snapshot, and trace schemas are rejected rather than
having role or player identity guessed.

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

A relative path-shaped `from` is resolved relative to the primary config
file, not the invocation directory; an absolute path is clearest for an SLC
entry emitted in a project working tree.
Before either front end imports a filesystem registry, the shared launcher
checks and, unless `--no-provision` is set, provisions its runtime engine
links as described in [Using the CLI](cli.md#external-playbooks-and-engine-provisioning).

## Migrating per-playbook players

The former `playbooks.<id>.players` shape made agent configuration and local
workflow roles the same thing. It is removed. For example, this legacy config
gave CODE and REVIEW two separately configured `coder` entries:

```yaml
playbooks:
  code:
    from: '@sublang/playbook/code/registry'
    players:
      coder: { adapter: claude, model: claude-opus-4-8[1m] }
  review:
    from: '@sublang/playbook/review/registry'
    players:
      coder: { adapter: claude, model: claude-opus-4-8[1m] }
      reviewer: { adapter: codex, model: gpt-5.5 }
```

Move each provider agent into the flat top-level map, choose stable IDs, and
bind the local roles explicitly:

```yaml
players:
  dev.coder: { adapter: claude, model: claude-opus-4-8[1m] }
  dev.reviewer: { adapter: codex, model: gpt-5.5 }

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
cannot be continued by the new host ([[playbook-cli-19](../specs/packages/playbook-cli.md#playbook-cli-19)],
[[playbook-cli-22](../specs/packages/playbook-cli.md#playbook-cli-22)],
[[playbook-cli-28](../specs/packages/playbook-cli.md#playbook-cli-28)]).

## Migrating from `profiles`

Configs written before 3.0.0 carried a top-level `profiles` map. The
launcher rewrites such a config on the next launch — inlining each
profile's settings into the agent that named it, keeping your comments,
and saving the original as `<config>.bak` — then continues. Nothing to
do by hand.

## Using a raw tmux-play config

For a one-off, pass a raw `tmux-play` config explicitly. This bypasses
the seed, composition, and readiness gate, forwarding arguments to
`tmux-play` verbatim ([[playbook-cli-1](../specs/packages/playbook-cli.md#playbook-cli-1)]):

```sh
playbook --config ./tmux-play.config.yaml
```
