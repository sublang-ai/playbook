<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Playbook: Reliability Is All You Need

[![npm version](https://img.shields.io/npm/v/@sublang/playbook)](https://www.npmjs.com/package/@sublang/playbook)
[![Node.js](https://img.shields.io/node/v/@sublang/playbook)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml)

_Skills made reliable through state machines and diverse LLMs._

Natural-language skills are flexible and easy to use, but less predictable than scripted workflows, especially on long-horizon jobs.
And even the best LLMs make mistakes, partly because plain-language descriptions rarely eliminate vagueness or guarantee completeness.

SubLang Playbook addresses both:

- The companion [SLC compiler](https://github.com/sublang-ai/slc) turns plain-language procedures, such as a `SKILL.md`, into playbooks with deterministic state-machine control flow.
- A playbook can assign different agents or LLMs to its steps and have them review and challenge one another, helping catch mistakes before delivery.

![Venn diagram: Skill is flexible, Workflow is deterministic, and Playbook sits in the intersection as both.](docs/assets/playbook-venn.svg)

Vocabulary: the **Boss** is you; the **Captain** is the coordinating agent you talk to; **players** are the agents a playbook delegates work to.

Run `playbook` for an interactive tmux UI powered by [cligent](https://github.com/sublang-ai/cligent), or `playbook run` for one-shot scripts and CI.

## Quick start

Out of the box, Playbook includes **CODE**, a coding-and-review loop, and **DISCUSS**, in which two agents develop, reconcile, and review a specification.

The interactive starter config uses Claude as both Captain and Coder, and Codex as Reviewer.

```sh
npm install -g @sublang/playbook
npm install -g @anthropic-ai/claude-agent-sdk @openai/codex-sdk
```

Custom configurations need the SDKs required by their providers; see [Configuring agents](docs/configuration.md).
If an SDK is missing or older than cligent supports, Playbook prints the pinned install command before launching anything; see [Installing agent SDKs](docs/cli.md#installing-agent-sdks) for upgrades, `npx`, and other adapters.

Prerequisites:

- Node.js >= 20.6.0
- `tmux` and [`glow`](https://github.com/charmbracelet/glow#installation) on `PATH`
- Authenticated [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) or `ANTHROPIC_API_KEY`
- Authenticated [Codex CLI](https://github.com/openai/codex) or `OPENAI_API_KEY`

CODE works in the current directory and can edit and commit autonomously, so use a clean branch or worktree.

```sh
cd /path/to/your/project
playbook
```

Type a task, or enter `/code <task>` to select CODE directly.

On first launch, Playbook writes its config to `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`.

One-shot runs use separate defaults instead of the interactive lineup.
Without configured `run` defaults, the Captain and every player use Claude; retain the Codex Reviewer with:

```sh
playbook run @sublang/playbook/code/registry "add a test for parseArgs" --player reviewer=codex --json
```

See [Using the CLI](docs/cli.md) for flags and session resume, [Configuring agents](docs/configuration.md) for lineups, [Embedding](docs/embedding.md) for custom hosts, and the [changelog](CHANGELOG.md) for releases.

## Create your own playbook

The separate [SLC compiler](https://github.com/sublang-ai/slc) requires Node.js >= 23.6 and compiles a plain-language `.md` or `.txt` procedure:

```sh
npm install -g @sublang/slc
slc playbook my-workflow.md
playbook run ./my-workflow.ts "<your task>"
```

SLC writes `my-workflow.ts` beside the source, and the inspectable intermediates and tests under `my-workflow.playbook/`; see the [SLC documentation](https://github.com/sublang-ai/slc#quick-start) for setup and phase commands.

## How it compiles

SLC's `playbook` pipeline has three phases:

1. **text → GEARS** ([slc/text2gears.md](slc/text2gears.md)) — makes each behavior explicit with its trigger, actor, prompt, and outcomes.
2. **GEARS → FSM** ([slc/gears2fsm.md](slc/gears2fsm.md)) — maps each item to an XState state that invokes the Captain, a player, another playbook, or a local script.
3. **FSM → runtime** ([slc/link.md](slc/link.md)) — links the machine to a host-independent interface for user input, agent calls, status, and telemetry.

The default [optimization pass](slc/optimize.md) replaces eligible mechanical steps with local shell scripts; `--no-optimize` skips it.
Inspect the complete [Captain](reference/sdlc/captain.md), [CODE](reference/sdlc/code.md), and [DISCUSS](reference/sdlc/discuss.md) examples.

## Contributing

We welcome contributions of all kinds.

- 🌟 Star our repo if you find Playbook useful.
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

Playbook is itself spec-driven: the compiler phases are specs in [`slc/`](slc), and the reference playbooks are regenerated from their prose sources.
Edit a source, regenerate its GEARS, FSM, and runtime artifacts, sync the tests and downstream specs until `pnpm test` passes, and commit with co-author trailers per [`specs/dev/git.md`](specs/dev/git.md).
The gears↔FSM contract ([the PLAYBOOK dev items](specs/dev/playbook.md)) and the runtime contract ([the PBRT dev items](specs/dev/playbook-runtime.md)) are pinned in [`specs/dev/`](specs/dev) and verified by the test suite.

## License

[Apache-2.0](LICENSE)
