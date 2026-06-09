<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook

[![npm version](https://img.shields.io/npm/v/@sublang/playbook)](https://www.npmjs.com/package/@sublang/playbook)
[![Node.js](https://img.shields.io/node/v/@sublang/playbook)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml)

*Skills made reliable through state machines and visualization.*

playbook is a compiler stack and reference implementation for turning a
natural-language procedure into a runnable, inspectable state-machine
agent — a *playbook* — that orchestrates other AI agents (players) per a
spec written in plain prose. Three phases take prose to runtime:

1. **text → GEARS** ([slc/text2gears.md](slc/text2gears.md)) — normative
   spec items, one per state behavior, partitioned by trigger and prompt
   content.
2. **GEARS → FSM** ([slc/gears2fsm.md](slc/gears2fsm.md)) — an XState v5
   finite state machine; each gear maps to one captain-invoking state
   with a typed Captain actor contract.
3. **FSM → runtime** ([slc/link.md](slc/link.md)) — a host-agnostic
   module that drives Boss turns through ports the host wires up
   (cligent's `tmux-play` is one such host).

The repository is itself an end-to-end worked example: this
package — `@sublang/playbook` — is the SDLC coding workflow,
generated from [`reference/sdlc/code.md`](reference/sdlc/code.md)
as its prose source. The runtime drives a coder / reviewer /
committer loop end to end.

## Getting started — the reference CODE playbook

The reference is the canonical worked example —
[CODE source](reference/sdlc/code.md) →
[gears](reference/sdlc/code.playbook/code.gears.md) →
[FSM](reference/sdlc/code.playbook/code.fsm.ts) → runtime — with
the runtime ported to cligent's `tmux-play` host out of the box.
The compiled artifacts live under
[`reference/sdlc/code.playbook/`](reference/sdlc/code.playbook),
the slc pipeline's `<basename>.<pipeline>/` output directory.

### Install (users)

Install the package globally. `@sublang/cligent`, the Claude and
Codex adapter SDKs, and `xstate` are direct dependencies, so a single
install pulls in the reference CODE playbook and its host:

```sh
npm install -g @sublang/playbook
```

Then launch the reference playbook in a `tmux-play` session:

```sh
playbook-code
```

For a one-shot run without a global install, use the same command
through npx:

```sh
npx playbook-code
```

On first run, `playbook-code` creates a commented user config at
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook-code.config.yaml`
from the bundled template, prints that path to stderr, then checks the
declared adapters before launching. Later runs reuse that file and do
not overwrite it.

Known adapter readiness is intentionally light: `claude` is ready when
local Claude Code auth exists or `ANTHROPIC_API_KEY` is set; `codex` is
ready when local Codex CLI auth exists or `OPENAI_API_KEY` is set. If a
known adapter is not ready, `playbook-code` prints its own help text
with the config path, auth pointers, and agent-swap recipe, then exits
without launching. You can view the same recovery text at any time:

```sh
playbook-code --help
```

The seed template runs each agent in cligent's protected auto mode
(`permissions.mode: auto`), suppressing routine approval prompts. Its
Codex Coder also grants `permissions.writablePaths: [.git]` so git
metadata writes stay available under auto mode without switching to
bypass permissions.

### Configure agents

Edit the seeded user config when you want different coding agents:

```sh
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook-code.config.yaml"
```

Both CODE players can use `claude` or `codex`; other adapter ids are
passed through to `tmux-play` with a warning because `playbook-code`
does not know how to preflight their auth. The safe tuning points are
`captain.adapter`, `captain.model`, and each role's `adapter` and
`model` under `players.coder` / `players.reviewer`. The composer owns
`captain.from` and the `coder` / `reviewer` role keys, so leave those
keys as-is; the runtime binds to those host-configuration invariants
per [PBRT-4](specs/user/playbook-runtime.md#pbrt-4) and derives the
`<coder-llm>` / `<reviewer-llm>` substitution strings from each role's
`model` when pinned and `adapter` otherwise — so the Committer's
commit-message trailers can name the concrete model
(e.g. `claude-opus-4-8`) rather than the adapter family (`claude`).

`players.committer` is an optional alias naming which role — `coder`
or `reviewer` — runs the commit turn; the seeded overlay points it at
the Reviewer. Absent the alias the Committer falls back to the Coder
([PBRT-8](specs/user/playbook-runtime.md#pbrt-8)).

For example, the seeded overlay runs the Coder on Codex and the
Reviewer on Claude, with the Committer aliased to the Reviewer:

```yaml
captain:
  adapter: claude
  model: claude-sonnet-4-6
  reasoningEffort: high
  permissions:
    mode: auto

players:
  coder:              # role key must stay `coder` — see PBRT-4
    adapter: codex
    model: gpt-5.5
    reasoningEffort: xhigh
    permissions:
      mode: auto
      writablePaths:
        - .git          # allow git metadata writes under Codex auto mode
  reviewer:           # role key must stay `reviewer` — see PBRT-4
    adapter: claude
    model: claude-opus-4-8
    reasoningEffort: xhigh
    permissions:
      mode: auto
  committer: reviewer   # which role commits — `coder` or `reviewer`
```

Normal `playbook-code` runs use the seeded path above. If you need a
separate config file for a one-off run, pass it explicitly; this bypasses
the seed and readiness gate and forwards the arguments to `tmux-play`
verbatim, as pinned in
[PBCODE-1](specs/user/playbook-code.md#pbcode-1):

```sh
playbook-code --config ./playbook-code.config.yaml
```

### Install (contributors / from source)

Clone, install, and run the suite locally:

```sh
git clone https://github.com/sublang-ai/playbook.git
cd playbook
pnpm install
pnpm build
pnpm test
```

`pnpm install` here installs the `@sublang/cligent` version pinned
in the checked-in `pnpm-lock.yaml` — the same version CI installs
via `--frozen-lockfile`, so contributor checkouts and CI agree.
The published `package.json` declares `@sublang/cligent` as
`latest`, so an end-user install with no lockfile (e.g., `npm
install -g @sublang/playbook`) instead resolves whichever cligent
release currently carries the `latest` dist-tag at install time
(see [RELEASE-14](specs/dev/release.md#release-14)). To bump the
contributor pin to today's `latest`, run
`pnpm update @sublang/cligent` and commit the resulting
`pnpm-lock.yaml` change — a plain `pnpm install` won't refresh the
pin, since pnpm sees `specifier: latest` in the lockfile as
already matching `package.json` and skips re-resolving the tag.
No local link required for any of this. To point pnpm at a local
`cligent` checkout
instead, copy
[`pnpm-workspace.yaml.example`](pnpm-workspace.yaml.example)
into place; the override is gitignored so it never leaks into a
production install.

Drive a Boss turn against the source tree (uses the developer
[`tmux-play.config.yaml`](reference/sdlc/code.playbook/tmux-play.config.yaml)
that imports the compiled adapter via relative path):

```sh
pnpm exec tmux-play --config reference/sdlc/code.playbook/tmux-play.config.yaml
```

`pnpm exec` resolves `tmux-play` from the package's local
`node_modules/.bin/`, so this works whether or not `@sublang/cligent` is
installed globally.

### Running a Boss turn

The Boss pane takes plain-language turns; the judge classifies each
into an FSM event (start a coding turn, continue or summarize an IR,
interrupt to a named state, or nothing) per
[PBRT-1](specs/user/playbook-runtime.md#pbrt-1).
When a player surfaces a clarifying question
the FSM parks at `awaitBossReply` and the pane shows the question; your
next turn is normally classified as the reply, or a fresh directive
abandons it ([PBRT-2](specs/user/playbook-runtime.md#pbrt-2)).

The Captain pane streams the state machine with a four-glyph vocabulary —
`◆ ▸ ⮕ ⤷` per [PBRT-3](specs/user/playbook-runtime.md#pbrt-3) — while
player prompts ride their own panes.

### Embedding the runtime in your own host

The runtime is host-agnostic; the `tmux-play` adapter is one host.
Construct the runtime against your own ports:

```ts
import createPlaybookRuntime, {
  type PlaybookPorts,
} from '@sublang/playbook/code/playbook';

const ports: PlaybookPorts = {
  callPlayer: async (playerId, prompt, signal) => { /* … */ },
  callJudge: async (prompt, signal) => { /* … */ },
  emitStatus: async (message, data) => { /* … */ },
  emitTelemetry: async ({ topic, payload }) => { /* … */ },
};

const runtime = createPlaybookRuntime({
  coderPlayer: 'claude',
  reviewerPlayer: 'codex',
});

await runtime.init(ports);
await runtime.handleBossInput({
  text: 'Start fixing the bug',
  signal: new AbortController().signal,
});
await runtime.dispose();
```

See
[`code.playbook.test.ts`](reference/sdlc/code.playbook/code.playbook.test.ts)
for the full range of port shapes (classifier, judge, abort, interrupt,
status/telemetry) the runtime is contract-tested against.

## Workflow

playbook is itself spec-driven: the compiler phases are specs in `slc/`,
and the reference playbook is regenerated from its prose source. The
loop:

1. **Edit source.** For the reference, that's
   [`reference/sdlc/code.md`](reference/sdlc/code.md).
2. **Recompile gears** per [`slc/text2gears.md`](slc/text2gears.md) into
   the package's `code.gears.md`.
3. **Recompile FSM** per [`slc/gears2fsm.md`](slc/gears2fsm.md) into
   the package's `code.fsm.ts`.
4. **Sync runtime, tests, and downstream specs** so `pnpm test` stays
   green and the introspect contract holds 1:1 between gear items and
   FSM captain-invoking states.
5. **Commit** with co-author trailers per
   [`specs/dev/git.md`](specs/dev/git.md).

The behavioral contract between gears and FSM
([PLAYBOOK-1..6](specs/dev/playbook.md)) and the runtime contract that
ports satisfy ([PBRT-5..16](specs/dev/playbook-runtime.md)) are pinned
in [`specs/dev/`](specs/dev/) and verified by tests under the reference
package.

## Requirements

- Node.js ≥ 20.6.0 (the `playbook-code` shim uses
  `import.meta.resolve`, unflagged since this release)
- pnpm 9 (for the reference package)
- A configured `tmux-play` host (for live Boss turns) — requires
  `tmux` and [`glow`](https://github.com/charmbracelet/glow#installation)
  on `PATH`; cligent 0.4+ uses `glow` to render Markdown pane
  output and fails fast without it

## Contributing

We welcome contributions of all kinds.

- 🌟 Star our repo if you find playbook useful.
- [Open an issue](https://github.com/sublang-ai/playbook/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/playbook/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

## License

[Apache-2.0](LICENSE)
