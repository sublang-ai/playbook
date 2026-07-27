<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook

[![npm version](https://img.shields.io/npm/v/@sublang/playbook)](https://www.npmjs.com/package/@sublang/playbook)
[![Node.js](https://img.shields.io/node/v/@sublang/playbook)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml)

_Skills made reliable through state machines and visualization._

playbook turns a natural-language procedure into a runnable,
inspectable state-machine agent — a _playbook_ — that orchestrates other
AI agents per a spec written in plain prose. Instead of a free-form LLM
deciding what to do next, an explicit finite state machine drives the
workflow, every agent-invoking state pinned 1:1 to a human-readable spec
item and contract-tested.

Vocabulary: the **Boss** is you; the **Captain** is the agent pane you
talk to; **players** are the coding agents a playbook delegates to; a
hidden **judge** classifies your free text into state-machine events.
Playbooks run inside a *host* built on
[cligent](https://github.com/sublang-ai/cligent), the sibling SDK that
drives coding-agent CLIs; its `tmux-play` terminal app is the reference
host.

## Quick start

Requires Node.js >= 20.6.0, `tmux` and
[`glow`](https://github.com/charmbracelet/glow#installation) on `PATH`,
and auth for the seeded agents — signed-in
[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
or `ANTHROPIC_API_KEY`, and signed-in
[Codex CLI](https://github.com/openai/codex) or `OPENAI_API_KEY`.

```sh
npm install -g @sublang/playbook
playbook
```

The first launch seeds a commented config at
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`,
composes a `tmux-play` config, checks the declared adapters, and opens
the session. Then type a task, or `/code <task>` to select the CODE
playbook directly.

Every agent carries its own settings, so retuning one player never
changes another:

```yaml
playbooks:
  code:
    from: '@sublang/playbook/code/registry'
    players:
      coder: { adapter: claude, model: 'claude-opus-4-8[1m]', effort: xhigh }
      reviewer: { adapter: codex, model: gpt-5.5, effort: xhigh }
```

To run once without tmux — for scripts and CI — point `run` straight at
a registry module:

```sh
playbook run @sublang/playbook/code/registry "add a test for parseArgs" --json
```

- **[docs/cli.md](docs/cli.md)** — both surfaces: Boss turns, flags,
  exit codes, and resuming a parked `run`.
- **[docs/configuration.md](docs/configuration.md)** — the config file,
  per-launch `--with` overlays, and choosing the Captain agent.
- **[docs/embedding.md](docs/embedding.md)** — the six-port runtime
  contract for hosts other than `tmux-play`.

> **Current release:** 3.1.0. The composed system — the compiled default
> Captain, CODE and DISCUSS, nested playbook calls, script actors and the
> GEARS optimize pass, the semver-stable six-port runtime contract, and
> non-interactive `playbook run` with parked-session resume — landed in
> 1.0.0. Since then, `playbook run` gained defaults in the user config,
> 3.0.0 replaced the top-level `profiles` map with inline agent settings
> (existing configs migrate themselves on the next launch), and 3.1.0
> added the linked-artifact/engine compatibility check. See the
> [CHANGELOG](CHANGELOG.md).

## How it compiles

Three phases take prose to runtime, plus an optional optimizer:

1. **text → GEARS** ([slc/text2gears.md](slc/text2gears.md)) — normative
   spec items, one per state behavior, partitioned by trigger and prompt
   content.
2. **GEARS → FSM** ([slc/gears2fsm.md](slc/gears2fsm.md)) — an XState v5
   machine; each gear maps to one direct-Captain, delegated-player, or
   nested-playbook state with a typed actor contract. The compiled FSM
   can be visualized and simulated with the bundled
   [XState sketch visualizer](views/sketch).
3. **FSM → runtime** ([slc/link.md](slc/link.md)) — a host-agnostic
   module that drives Boss turns through ports the host wires up.

Between the first two, [slc/optimize.md](slc/optimize.md) may rewrite a
deterministic mechanical gear — canonically git repository setup — into a
*script item* the runtime executes directly, with no agent call.
Unoptimized compiles are byte-identical, so the pass is opt-in.

The repository carries end-to-end worked examples: the generic default
Captain from [`reference/sdlc/captain.md`](reference/sdlc/captain.md),
CODE — a coder / reviewer / committer loop — from
[`reference/sdlc/code.md`](reference/sdlc/code.md), and DISCUSS — two
agents converging on spec items — from
[`reference/sdlc/discuss.md`](reference/sdlc/discuss.md). Together they
show direct Captain work, sequential nested playbook calls, and parallel
players. Compiled artifacts live beside each source in
`<basename>.playbook/`, the [slc](https://github.com/sublang-ai/slc)
pipeline's output directory.

## Contributing

We welcome contributions of all kinds.

- 🌟 Star our repo if you find playbook useful.
- [Open an issue](https://github.com/sublang-ai/playbook/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/playbook/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

From source:

```sh
git clone https://github.com/sublang-ai/playbook.git
cd playbook
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm playbook   # drive a Boss turn against the source tree
```

To co-develop against an unreleased cligent checkout, clone it beside
this repository, build it, and copy `pnpm-workspace.yaml.example` to the
gitignored `pnpm-workspace.yaml`. Do not commit the lockfile rewrite it
produces ([RELEASE-11](specs/dev/release.md#release-11)).

playbook is itself spec-driven: the compiler phases are specs in
[`slc/`](slc), and the reference playbooks are regenerated from their
prose sources. Edit a source, recompile gears then FSM and runtime into
its artifact directory, sync tests and downstream specs until
`pnpm test` is green, and commit with co-author trailers per
[`specs/dev/git.md`](specs/dev/git.md). The gears↔FSM contract
([the PLAYBOOK dev items](specs/dev/playbook.md)) and the runtime
contract ([the PBRT dev items](specs/dev/playbook-runtime.md)) are
pinned in [`specs/dev/`](specs/dev) and verified by the test suite.

## License

[Apache-2.0](LICENSE)
