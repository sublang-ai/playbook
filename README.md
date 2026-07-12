<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook

[![npm version](https://img.shields.io/npm/v/@sublang/playbook)](https://www.npmjs.com/package/@sublang/playbook)
[![Node.js](https://img.shields.io/node/v/@sublang/playbook)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml)

_Skills made reliable through state machines and visualization._

playbook is a compiler stack and reference implementation for turning a
natural-language procedure into a runnable, inspectable state-machine
agent — a _playbook_ — that orchestrates other AI agents (players) per a
spec written in plain prose. Three phases take prose to runtime:

1. **text → GEARS** ([slc/text2gears.md](slc/text2gears.md)) — normative
   spec items, one per state behavior, partitioned by trigger and prompt
   content.
2. **GEARS → FSM** ([slc/gears2fsm.md](slc/gears2fsm.md)) — an XState v5
   finite state machine; each gear maps to one direct-Captain,
   delegated-player, or nested-playbook state with a typed actor contract.
3. **FSM → runtime** ([slc/link.md](slc/link.md)) — a host-agnostic
   module that drives Boss turns through ports the host wires up
   (cligent's `tmux-play` is one such host).

The repository contains end-to-end worked examples. The generic default
Captain is generated from
[`reference/sdlc/captain.md`](reference/sdlc/captain.md), CODE from
[`reference/sdlc/code.md`](reference/sdlc/code.md), and DISCUSS from
[`reference/sdlc/discuss.md`](reference/sdlc/discuss.md). Together they show
direct Captain work, sequential nested playbook calls, parallel players, and a
coder / reviewer / committer loop.

## Getting started — the reference CODE playbook

The reference is the canonical worked example —
[CODE source](reference/sdlc/code.md) →
[gears](reference/sdlc/code.playbook/code.gears.md) →
[FSM](reference/sdlc/code.playbook/code.fsm.ts) → runtime — with
the runtime registered behind the built-in Playbook Captain shell for
cligent's `tmux-play` host out of the box.
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

### Configure agents

Edit the seeded user config when you want different coding agents:

```sh
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml"
```

The config is top-level (no `config:` wrapper): a `profiles` map of
reusable agent settings, a `captain` Judge agent, optional `layout` /
`notifications` / `theme`, and a `playbooks` map of enabled playbooks. Each
`captain` or `players.<role>` value is a profile id or an adapter
shorthand (`claude`, `codex`); other adapter ids are passed through to
`tmux-play` with a warning because `playbook` cannot preflight their
auth. Name profiles by their underlying agent/model (e.g. `claude-opus`,
`codex-gpt`) so the profile ids read distinctly from the `coder` /
`reviewer` player roles that reference them. Within a `playbooks.<id>` block, `from` (the registry module),
`command` (an optional slash-command override), and `players` are
launcher-owned; every other key (e.g. CODE's `committer`) is that
playbook's option slice. The launcher injects `captain.from` and the
namespaced `<id>-<role>` host players, so you do not write those by
hand.

CODE's per-run `<coder-llm>` / `<reviewer-llm>` prompt strings come from
each role's pinned `model`, else its `adapter`
([PBRT-4](specs/user/playbook-runtime.md#pbrt-4)) — so the Committer's
commit-message trailers can name the concrete model
(e.g. `claude-opus-4-8[1m]`) rather than the adapter family (`claude`).
`committer` is an optional CODE alias naming which role — `coder` or
`reviewer` — runs the commit turn; the seeded config points it at the
Coder, and absent the alias the Committer falls back to the Coder
([PBRT-8](specs/dev/playbook-runtime.md#pbrt-8)).

For example, the seeded config runs the Coder on Claude Opus 4.8 1m and
the Reviewer on GPT-5.5, with the Committer aliased to the Coder:

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

If you need a separate config file for a one-off run, pass a raw
`tmux-play` config explicitly; this bypasses the seed, composition, and
readiness gate and forwards the arguments to `tmux-play` verbatim
([PBCLI-1](specs/user/playbook-cli.md#pbcli-1)):

```sh
playbook --config ./tmux-play.config.yaml
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
`^0.13.0`, so an end-user install with no lockfile (e.g., `npm
install -g @sublang/playbook`) resolves a compatible cligent 0.13.x
release (see [RELEASE-14](specs/dev/release.md#release-14)). To
refresh the contributor pin within that range, run
`pnpm update @sublang/cligent` and commit the resulting
`pnpm-lock.yaml` change. To adopt a later cligent minor, update the
`package.json` specifier and lockfile together.
No local link required for any of this. To point pnpm at a local
`cligent` checkout
instead, copy
[`pnpm-workspace.yaml.example`](pnpm-workspace.yaml.example)
into place; the override is gitignored so it never leaks into a
production install.

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
to explicitly select the CODE playbook, or use ordinary text and let the
compiled default Captain answer, ask a material routing question, or plan
one or more enabled playbook calls. Calls run sequentially so Captain can
reassess after every child result. Once a turn reaches CODE, the CODE judge classifies it
into an FSM event (start a coding turn, continue or summarize an IR,
interrupt to a named state, or nothing) per
[PBRT-1](specs/user/playbook-runtime.md#pbrt-1).
When a player surfaces a clarifying question
the FSM parks at `awaitBossReply` and the pane shows the question; your
next turn is normally classified as the reply, or a fresh directive
abandons it ([PBRT-2](specs/user/playbook-runtime.md#pbrt-2)).

The Captain pane shows `/code` start/stop/finished status with `◇` lines
and streams CODE with captain-speech classification/questions plus the
three-glyph vocabulary `⤷ → ◆` per
[PBRT-3](specs/user/playbook-runtime.md#pbrt-3), while player prompts
ride their own panes.

Published configs import the shell adapter from
`@sublang/playbook/playbook-captain` and enable CODE through a
`captain.options.playbooks.code` block whose `from` is
`@sublang/playbook/code/registry`. The generic `playbook` launcher
composes this for you from the top-level `profiles` / `playbooks`
config above.

### Embedding the runtime in your own host

The runtime is host-agnostic; the `tmux-play` adapter is one host.
The port and runtime contracts live in the type-only module
[`@sublang/playbook/runtime`](src/runtime.ts) — a public, semver-stable
surface (`PlayerResult`, `PlaybookPorts`, `PlaybookRuntime`,
`PlaybookSession`, `PlayerCallOptions`, `CaptainCallOptions`,
`CaptainResult`, `PlaybookTraceEvent`, and
`PlaybookRuntimeFactory`) that imports no CODE or FSM types, so a host
satisfies it once and inherits every playbook. The CODE runtime
re-exports `PlayerResult`, `PlaybookPorts`, `PlaybookSession`, and
`PlaybookRuntime` from
`@sublang/playbook/code/playbook`; `PlaybookRuntimeFactory` is available
from `@sublang/playbook/runtime`.
Generated linked runtimes reuse the XState integration engine exposed as
`@sublang/playbook/xstate-runtime`, including strict JSON validation,
normalized snapshots, quiescence waiting, and the nested-playbook bridge.
Construct the runtime against your own ports:

```ts
import createPlaybookRuntime from '@sublang/playbook/code/playbook';
import type { PlaybookPorts } from '@sublang/playbook/runtime';
import { randomUUID } from 'node:crypto';

const ports: PlaybookPorts = {
  callPlayer: async (playerId, prompt, signal, { resume }) => {
    // `resume === false` starts fresh; a string selects that player's
    // prior backend conversation. Return the adapter's next token.
    return { status: 'ok', finalText: 'done', resumeToken: 'next-token' };
  },
  callCaptain: async (prompt, signal, { visibility }) => {
    return { status: 'ok', finalText: 'done' };
  },
  callJudge: async (prompt, signal) => '{}',
  callPlaybook: async (request, signal) => {
    throw new Error('No nested playbook host configured');
  },
  emitStatus: async (message, data) => {
    /* … */
  },
  emitTelemetry: async ({ topic, payload }) => {
    /* … */
  },
};

const runtime = createPlaybookRuntime({
  coderPlayer: 'claude',
  reviewerPlayer: 'codex',
});

const playbookSessionId = randomUUID();
await runtime.init({
  sessionId: playbookSessionId,
  playbookId: 'code',
  rootSessionId: playbookSessionId,
  depth: 0,
  ports,
});
await runtime.handleBossInput({
  text: 'Start fixing the bug',
  signal: new AbortController().signal,
});
await runtime.dispose();
```

Every init-to-dispose lifecycle is one playbook session. Its
`playbook.trace` telemetry carries that immutable ID plus a contiguous
sequence across exact Boss input, judge/player calls, FSM transitions,
visible Captain work, nested playbook calls, status, settlement, and
disposal. Each resolved player starts fresh in
a new playbook session and then resumes only from the latest opaque
`resumeToken` its adapter returned; trace data and tokens never enter
Boss-visible status text. Because trace observers do receive opaque
resume tokens, persisted traces should be protected as sensitive data.

See
[`code.playbook.test.ts`](reference/sdlc/code.playbook/code.playbook.test.ts)
for the full range of port shapes (classifier, judge, abort, interrupt,
status/telemetry) the runtime is contract-tested against.

### Reading the published spec contracts

The authored compiler-phase specs ship in the package and are exposed
as a public, semver-stable surface under `@sublang/playbook/slc/*`.
Resolve and read one with `import.meta.resolve` plus `fs`:

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const url = import.meta.resolve('@sublang/playbook/slc/link.md');
const link = await readFile(fileURLToPath(url), 'utf8');
```

The three specs are [`slc/text2gears.md`](slc/text2gears.md),
[`slc/gears2fsm.md`](slc/gears2fsm.md), and [`slc/link.md`](slc/link.md)
— the FSM-to-runtime contract that `@sublang/playbook/runtime` projects
into TypeScript.

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
ports satisfy ([PBRT-5..16](specs/dev/playbook-runtime.md)) are pinned
in [`specs/dev/`](specs/dev/) and verified by tests under the reference
package.

## Requirements

- Node.js ≥ 20.6.0 (the `playbook` launcher uses
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
