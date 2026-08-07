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

The seeded config runs the Coder on Claude Opus 4.8 1m and the Reviewer
on GPT-5.5:

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
      reviewer:
        adapter: codex
        model: gpt-5.5
        effort: xhigh
        permissions:
          mode: auto
          writablePaths:
            - .git # allow git metadata writes under Codex auto mode
    committer: coder # which role commits — `coder` or `reviewer`
```

`committer` is CODE's one option: an alias naming which role runs the
commit turn (fallback semantics:
[PBRT-8](../specs/dev/playbook-runtime.md#pbrt-8)). Each role's per-run
prompt names its pinned `model`, else its `adapter`
([PBRT-4](../specs/user/playbook-runtime.md#pbrt-4)), so commit trailers
credit the concrete model rather than the adapter family.

## Choosing the Captain agent

Every session-Captain call and adjudication call is hidden and runs
tool-free, which is what keeps the Captain deciding and reporting
instead of doing the work itself. Claude enforces
that at the provider level. The Codex adapter cannot — it rejects any
tool list — so a `captain:` on `codex` falls back to a prompt-level
restriction
([DR-013 A1](../specs/decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement)).
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
          # The seeded `committer` is `coder`, so this role runs the commit
          # turn; a Codex agent needs the `.git` grant to write git metadata.
          writablePaths:
            - .git
```

Fragments merge into the agent block rather than replacing it, so
settings the base defines and the fragment omits — here `mode: auto` —
survive. Anything the adapter itself requires must still be stated: a
role switched to `codex` needs its own `writablePaths` grant, because
the base Claude block had no reason to carry one.

The global file is never modified, and `--with` is not forwarded to
`tmux-play` ([PBCLI-25](../specs/user/playbook-cli.md#pbcli-25)).

## Defaults for `playbook run`

An optional top-level `run` block supplies the non-interactive host's
lineup so you stop retyping flags — `run.captain`, `run.players.<role>`,
and a `run.player` catch-all for any other required role, each an
`<adapter>[:<model>][@<effort>]` string. Flags win per role, and
`resume` always keeps the lineup stored with the parked session
([PBCLI-28](../specs/user/playbook-cli.md#pbcli-28),
[DR-017](../specs/decisions/017-run-defaults-config.md)).

```yaml
run:
  captain: claude:claude-opus-4-8@high
  players:
    coder: claude:claude-opus-4-8[1m]@xhigh
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
`tmux-play` verbatim ([PBCLI-1](../specs/user/playbook-cli.md#pbcli-1)):

```sh
playbook --config ./tmux-play.config.yaml
```
