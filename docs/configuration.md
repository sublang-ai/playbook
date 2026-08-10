<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Configuring agents

`playbook` reads one config at
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`. The
first launch seeds it from the bundled starter and prints the path;
later launches reuse it untouched.

```sh
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml"
```

## Anatomy

The config is top-level (no `config:` wrapper): a `captain` agent (it
runs the session Captain's hidden control calls, the hidden judge calls,
and the replies you see in the Captain pane), optional
`layout` / `notifications` / `theme`, and a `playbooks` map of enabled
playbooks.

Each `captain` or `players.<role>` value is either an adapter shorthand
(`claude`, `codex`) or a block carrying that agent's own `adapter`,
`model`, `effort`, and `permissions`. Settings are inline per agent, so
tuning one player never changes another
([DR-021](../specs/decisions/021-inline-agent-settings.md)). Other
adapter ids pass through to `tmux-play` with a warning, because
`playbook` cannot preflight their auth.

Within a `playbooks.<id>` block, `from` (the registry module), `command`
(an optional slash-command override), and `players` are launcher-owned;
every other key is that playbook's option slice. The launcher injects
the rest — you do not write host wiring by hand.

The seeded config runs each Coder on Claude Opus 4.8 1m and each
Reviewer on GPT-5.5:

```yaml
captain:
  adapter: claude
  model: claude-opus-4-8
  effort: high
  permissions:
    mode: auto # protected auto mode for the Claude Captain

playbooks:
  code:
    from: '@sublang/playbook/code/registry'
    players:
      coder:
        adapter: claude
        model: claude-opus-4-8[1m]
        effort: xhigh
        permissions:
          mode: auto # protected auto mode for the Claude Coder

  review:
    from: '@sublang/playbook/review/registry'
    players:
      coder:
        adapter: claude
        model: claude-opus-4-8[1m]
        effort: xhigh
        permissions:
          mode: auto
      reviewer:
        adapter: codex
        model: gpt-5.5
        effort: xhigh
        permissions:
          mode: auto
          writablePaths:
            - .git # allow git metadata writes under Codex auto mode

  decide:
    from: '@sublang/playbook/decide/registry'
    players:
      coder:
        adapter: claude
        model: claude-opus-4-8[1m]
        effort: xhigh
        permissions:
          mode: auto
      reviewer:
        adapter: codex
        model: gpt-5.5
        effort: xhigh
        permissions:
          mode: auto
          writablePaths:
            - .git
```

The current bundled workflows accept no workflow-specific options.
Each role's per-run prompt names its pinned `model`, else its `adapter`
([[playbook-runtime-4](../specs/packages/playbook-runtime.md#playbook-runtime-4)]),
so commit trailers credit the concrete model rather than the adapter
family.

## Nested roles and sessions

The launcher creates a namespaced fallback player for every configured
playbook role, but a nested call maps an exact same-name role to the
nearest ancestor's effective player and backend conversation. CODE's
nested REVIEW therefore continues CODE's `coder` and uses REVIEW's
configured `reviewer`; DECIDE's nested REVIEW continues both of
DECIDE's roles. A standalone REVIEW starts with REVIEW's own configured
players, and every new root engagement starts fresh
([DR-030](../specs/decisions/030-shared-mapped-player-continuity.md)).

The separate fallback entries are still required because tmux creates
its roster at launch time. The host changes which existing panes are
visible as the active nested leaf changes; it does not create a new
host player or backend agent session for a mapped role.

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
```

```yaml
# fast-lineup.yaml — swap the Coder for one run; nothing is written back.
playbooks:
  code:
    players:
      coder:
        adapter: codex
        model: gpt-5.5
        effort: medium
        permissions:
          mode: auto
          # CODE's Coder commits, so Codex needs the `.git` grant to write
          # repository metadata.
          writablePaths:
            - .git
```

Fragments merge into the agent block rather than replacing it, so
settings the base defines and the fragment omits — here `mode: auto` —
survive. Anything the adapter itself requires must still be stated: a
role switched to `codex` needs its own `writablePaths` grant, because
the base Claude block had no reason to carry one.

The global file is never modified, and `--with` is not forwarded to
`tmux-play` ([[playbook-cli-25](../specs/packages/playbook-cli.md#playbook-cli-25)]).

## Defaults for `playbook run`

An optional top-level `run` block supplies the non-interactive host's
lineup so you stop retyping flags — `run.captain`, `run.players.<role>`,
and a `run.player` catch-all for any other required role, each an
`<adapter>[:<model>][@<effort>]` string. Flags win per role, and
`resume` always keeps the lineup stored with the parked session
([[playbook-cli-28](../specs/packages/playbook-cli.md#playbook-cli-28)],
[DR-017](../specs/decisions/017-run-defaults-config.md)).

```yaml
run:
  captain: claude:claude-opus-4-8@high
  players:
    coder: claude:claude-opus-4-8[1m]@xhigh
    reviewer: codex:gpt-5.5@xhigh
```

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
