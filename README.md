<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook

[![npm version](https://img.shields.io/npm/v/@sublang/playbook)](https://www.npmjs.com/package/@sublang/playbook)
[![Node.js](https://img.shields.io/node/v/@sublang/playbook)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml)

_Skills made reliable through state machines and visualization._

playbook is a compiler stack and reference implementation for turning a
natural-language procedure into a runnable, inspectable state-machine
agent — a _playbook_ — that orchestrates other AI agents per a spec
written in plain prose. Instead of a free-form LLM deciding what to do
next, an explicit finite state machine drives the workflow, every
Captain-, player-, and nested-playbook-invoking state pinned 1:1 to a
human-readable spec item and contract-tested.

A quick vocabulary, used throughout: the **Boss** is you, the human in
charge; the **Captain** is the agent pane the Boss talks to;
**players** are the coding agents a playbook delegates work to; and a
hidden **judge** classifies free-text Boss input into state-machine
events, so playbooks need no slash commands of their own. Playbooks run
inside a *host* built on
[cligent](https://github.com/sublang-ai/cligent), the sibling SDK that
drives coding-agent CLIs; cligent's `tmux-play` terminal app is the
reference host.

Three phases take prose to runtime:

1. **text → GEARS** ([slc/text2gears.md](slc/text2gears.md)) — GEARS is
   the intermediate representation: normative spec items, one per state
   behavior, partitioned by trigger and prompt content.
2. **GEARS → FSM** ([slc/gears2fsm.md](slc/gears2fsm.md)) — an XState v5
   finite state machine; each gear maps to one direct-Captain,
   delegated-player, or nested-playbook state with a typed actor
   contract. The compiled FSM can be visualized and simulated with the
   bundled [XState sketch visualizer](views/sketch).
3. **FSM → runtime** ([slc/link.md](slc/link.md)) — a host-agnostic
   module that drives Boss turns through ports the host wires up
   (cligent's `tmux-play` is one such host).

The repository contains end-to-end worked examples. The generic default
Captain is generated from
[`reference/sdlc/captain.md`](reference/sdlc/captain.md), CODE — a
coder / reviewer / committer development loop — from
[`reference/sdlc/code.md`](reference/sdlc/code.md), and DISCUSS — two
agents converging on spec items — from
[`reference/sdlc/discuss.md`](reference/sdlc/discuss.md). Together they
show direct Captain work, sequential nested playbook calls, and
parallel players.

## Getting started — the reference CODE playbook

The reference is the canonical worked example —
[CODE source](reference/sdlc/code.md) →
[gears](reference/sdlc/code.playbook/code.gears.md) →
[FSM](reference/sdlc/code.playbook/code.fsm.ts) → runtime — with
the runtime registered behind the built-in Playbook Captain shell for
cligent's `tmux-play` host out of the box.
The compiled artifacts live under
[`reference/sdlc/code.playbook/`](reference/sdlc/code.playbook),
the [slc](https://github.com/sublang-ai/slc) compiler pipeline's
`<basename>.<pipeline>/` output directory.

> **Release status:** this README tracks `main`, which is heading to a
> breaking, 1.0-oriented release. The latest published release is
> [0.9.0](https://www.npmjs.com/package/@sublang/playbook) — it runs
> the CODE reference end to end, but the compiled default Captain,
> DISCUSS, nested playbook calls, and the six-port runtime contract
> (see [docs/embedding.md](docs/embedding.md)) are unreleased; see the
> [CHANGELOG](CHANGELOG.md).

### Requirements

- Node.js >= 20.6.0.
- `tmux` and [`glow`](https://github.com/charmbracelet/glow#installation)
  on `PATH` — the `tmux-play` host renders Markdown pane output with
  glow and fails fast without it.
- Auth for the seeded agents: a signed-in
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
  (`~/.claude`) or `ANTHROPIC_API_KEY`, and a signed-in
  [Codex CLI](https://github.com/openai/codex) (`~/.codex`) or
  `OPENAI_API_KEY`.

### Install (users)

Install the package globally. `@sublang/cligent`, the Claude and
Codex adapter SDKs, and `xstate` are direct dependencies, so a single
install pulls in the reference CODE playbook and its host:

```sh
npm install -g @sublang/playbook
```

Then launch the reference playbook in a `tmux-play` session:

```sh
playbook
```

For a one-shot run without a global install, invoke the scoped
package through npx (it runs the package's `playbook` bin):

```sh
npx @sublang/playbook
```

On first run, `playbook` creates a commented user config at
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`
from the bundled starter, prints that path to stderr, then composes a
`tmux-play` config and checks the declared adapters before launching.
Later runs reuse that file and do not overwrite it.

Known adapter readiness is intentionally light: `claude` is ready when
local Claude Code auth exists or `ANTHROPIC_API_KEY` is set; `codex` is
ready when local Codex CLI auth exists or `OPENAI_API_KEY` is set. If a
known adapter is not ready, `playbook` prints its own help text with the
config path, auth pointers, and agent-swap recipe, then exits without
launching. You can view the same recovery text at any time:

```sh
playbook --help
```

`playbook --list` prints the configured playbooks with their slash
commands and intents. Every seeded agent — the Captain and both roles —
runs in cligent's protected auto mode (`permissions.mode: auto`), so
routine in-session approval prompts are suppressed without switching to
bypass permissions. The seeded Codex Reviewer additionally grants
`permissions.writablePaths: [.git]` so git metadata writes stay
available under the Codex sandbox; the Claude agents need no such grant
under their auto mode.

### Run a playbook non-interactively

`playbook run <from> [task]` runs one playbook once, without tmux-play
and without a config entry — point it straight at a registry module:

```sh
playbook run @sublang/playbook/code/registry "add a test for parseArgs" \
  --player coder=claude --player reviewer=codex --cwd ./my-repo
```

`[task]` is read from stdin when omitted. Roles and the captain default
to `claude`; bind them with `--player <role>=<agent>` and `--captain
<agent>` (an adapter shorthand or `<adapter>:<model>`), pass a
playbook option with `--option <key>=<value>`, and add `--json` to print
the terminal output as JSON. It exits `0` on a terminal outcome, `2` on
failure, `3` when the playbook needs a Boss reply a one-shot cannot give,
and `1` on a bad argument or module. See
[PBCLI-18](specs/user/playbook-cli.md#pbcli-18).

### Configure agents

Edit the seeded user config when you want different coding agents:

```sh
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml"
```

The config is top-level (no `config:` wrapper): a `profiles` map of
reusable agent settings, a `captain` agent (it runs both visible
Captain work and hidden judge calls), optional `layout` /
`notifications` / `theme`, and a `playbooks` map of enabled playbooks.
Each `captain` or `players.<role>` value is a profile id or an adapter
shorthand (`claude`, `codex`); other adapter ids are passed through to
`tmux-play` with a warning because `playbook` cannot preflight their
auth. Name profiles by their underlying agent/model (e.g. `claude-opus`,
`codex-gpt`) so the profile ids read distinctly from the player roles
that reference them. Within a `playbooks.<id>` block, `from` (the
registry module), `command` (an optional slash-command override), and
`players` are launcher-owned; every other key is that playbook's option
slice. The launcher injects the rest — you do not write host wiring by
hand.

For example, the seeded config runs the Coder on Claude Opus 4.8 1m and
the Reviewer on GPT-5.5:

```yaml
profiles:
  claude-opus:
    adapter: claude
    model: claude-opus-4-8
    reasoningEffort: high
    permissions:
      mode: auto # protected auto mode for the Claude Captain
  claude-opus-1m:
    adapter: claude
    model: claude-opus-4-8[1m]
    reasoningEffort: xhigh
    permissions:
      mode: auto # protected auto mode for the Claude Coder
  codex-gpt:
    adapter: codex
    model: gpt-5.5
    reasoningEffort: xhigh
    permissions:
      mode: auto
      writablePaths:
        - .git # allow git metadata writes under Codex auto mode

captain: claude-opus

playbooks:
  code:
    from: '@sublang/playbook/code/registry'
    players:
      coder: claude-opus-1m
      reviewer: codex-gpt
    committer: coder # which role commits — `coder` or `reviewer`
```

`committer` is CODE's one option: an alias naming which role runs the
commit turn (fallback semantics:
[PBRT-8](specs/dev/playbook-runtime.md#pbrt-8)). Each role's per-run
prompt names its pinned `model`, else its `adapter`
([PBRT-4](specs/user/playbook-runtime.md#pbrt-4)), so commit trailers
can credit the concrete model (e.g. `claude-opus-4-8[1m]`) rather than
the adapter family.

If you need a separate config file for a one-off run, pass a raw
`tmux-play` config explicitly; this bypasses the seed, composition, and
readiness gate and forwards the arguments to `tmux-play` verbatim
([PBCLI-1](specs/user/playbook-cli.md#pbcli-1)):

```sh
playbook --config ./tmux-play.config.yaml
```

### Install (contributors / from source)

Source development currently links a sibling cligent checkout, built
locally, through the gitignored workspace override:

```sh
git clone https://github.com/sublang-ai/playbook.git
cd playbook
git clone https://github.com/sublang-ai/cligent.git ../cligent
(cd ../cligent && npm ci && npm run build)
cp pnpm-workspace.yaml.example pnpm-workspace.yaml
pnpm install
pnpm build
pnpm test
```

Why the override: the current Unreleased branch requires cligent
contracts beyond any published release — the explicit player-resume and
pre-close Captain contracts first shipped in cligent 0.14.0, plus the
isolated Captain control calls still on cligent main. This package's
dependency range and lockfile meanwhile pin the 0.13.0 registry
closure; they are updated only in the authorized release sequence under
[RELEASE-14](specs/dev/release.md#release-14), so no registry-only
install currently supports source development on main. Do not commit
the local lockfile rewrite produced by the override.

Drive a Boss turn against the source tree with the launcher, which
resolves `tmux-play`, the Playbook Captain shell, and the CODE registry
from the local package:

```sh
pnpm playbook
```

On first run this seeds the generic config at
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`
(see [Configure agents](#configure-agents)) and launches the composed
session, so this works whether or not `@sublang/cligent` is installed
globally.

### Running a Boss turn

The Boss pane starts at the Playbook Captain shell. Use `/code <task>`
to explicitly select the CODE playbook — on the published 0.9.0 this is
the way in — or, on `main`, use ordinary text and let the compiled
default Captain ask a material routing question or plan one or more
enabled playbook calls. It cannot answer the initial intent directly;
calls run sequentially so Captain can reassess after every child result
and then return a concrete result or actionable conclusion. Once a turn
reaches CODE, the CODE judge classifies it into an FSM event (start a coding
turn, continue or summarize an iteration, interrupt to a named state, or
nothing) per
[PBRT-1](specs/user/playbook-runtime.md#pbrt-1).
When a player surfaces a clarifying question
the FSM parks, the pane shows the question, and your
next turn is normally classified as the reply — or a fresh directive
abandons it ([PBRT-2](specs/user/playbook-runtime.md#pbrt-2)).

The Captain pane shows `/code` start/stop/finished status with `◇` lines
and streams CODE progress with captain-speech classification/questions
per [PBRT-3](specs/user/playbook-runtime.md#pbrt-3), while player
prompts ride their own panes.

### Embedding the runtime in your own host

The runtime is host-agnostic — the `tmux-play` adapter is one host. The
port and runtime contracts live in the type-only, semver-stable module
[`@sublang/playbook/runtime`](src/runtime.ts): a host satisfies the six
ports once and inherits every playbook. See
[docs/embedding.md](docs/embedding.md) for the contract surface, a
complete ports example, session/trace semantics, and how to read the
published compiler-phase specs from the package.

## Workflow

playbook is itself spec-driven: the compiler phases are specs in `slc/`,
and the reference playbook is regenerated from its prose source. The
loop:

1. **Edit source.** The worked examples include
   [`reference/sdlc/code.md`](reference/sdlc/code.md) and the generic
   [`reference/sdlc/captain.md`](reference/sdlc/captain.md).
2. **Recompile gears** per [`slc/text2gears.md`](slc/text2gears.md) into
   the source's `<name>.playbook/<name>.gears.md`.
3. **Recompile FSM and runtime** per
   [`slc/gears2fsm.md`](slc/gears2fsm.md) and
   [`slc/link.md`](slc/link.md) into that playbook artifact directory.
4. **Sync runtime, tests, and downstream specs** so `pnpm test` stays
   green and the introspect contract holds 1:1 between gear items and
   FSM direct-Captain, delegated-player, and nested-playbook states.
5. **Commit** with co-author trailers per
   [`specs/dev/git.md`](specs/dev/git.md).

The behavioral contract between gears and FSM
([PLAYBOOK-1..6](specs/dev/playbook.md)) and the runtime contract that
ports satisfy ([the PBRT dev items](specs/dev/playbook-runtime.md)) are
pinned in [`specs/dev/`](specs/dev/) and verified by tests under the
reference package.

## Contributing

We welcome contributions of all kinds.

- 🌟 Star our repo if you find playbook useful.
- [Open an issue](https://github.com/sublang-ai/playbook/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/playbook/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

## License

[Apache-2.0](LICENSE)
