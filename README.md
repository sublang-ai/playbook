<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook

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

The repository ships an end-to-end worked example: an SDLC coding
workflow at [`reference/sdlc/code.playbook`](reference/sdlc/code.playbook)
that drives a coder/reviewer/committer loop.

## Getting started — the reference CODE playbook

The reference is the canonical worked example —
[CODE source](reference/sdlc/code.md) →
[gears](reference/sdlc/code.playbook/code.gears.md) →
[FSM](reference/sdlc/code.playbook/code.fsm.ts) → runtime — with the
runtime ported to cligent's `tmux-play` host out of the box.

Install:

```sh
cd reference/sdlc/code.playbook
pnpm install
```

This resolves `@sublang/cligent` (≥ 0.3.0, which exports `./tmux-play`)
from the registry; no local link required. To point pnpm at a local
`cligent` checkout instead, copy
[`pnpm-workspace.yaml.example`](reference/sdlc/code.playbook/pnpm-workspace.yaml.example)
into place; the override is gitignored so it never leaks into a
production install.

Build and test:

```sh
pnpm build
pnpm test
```

Drive a Boss turn under `tmux-play`:

```sh
pnpm build
tmux-play --config tmux-play.config.yaml
```

The Boss pane accepts four slash commands per
[PBRT-1](specs/user/playbook-runtime.md#pbrt-1):

- `/start <intent>` — begin a single coding turn
- `/continue <#>` — pick up an IR task
- `/summarize <#>` — turn an IR's commits into spec items
- `/interrupt <stateId> [intent]` — preempt the FSM into a named state

Anything else falls through to an LLM classifier. The Captain pane
streams the state machine progression with a four-glyph vocabulary —
`◆ ▸ ⮕ ⤷` per [PBRT-3](specs/user/playbook-runtime.md#pbrt-3) — while
player prompts ride their own panes.

### Embedding the runtime in your own host

The runtime is host-agnostic; the `tmux-play` adapter is one host.
Construct the runtime against your own ports:

```ts
import createPlaybookRuntime, {
  type PlaybookPorts,
} from './reference/sdlc/code.playbook/code.playbook.js';

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
  text: '/start fix the bug',
  signal: new AbortController().signal,
});
await runtime.dispose();
```

See
[`reference/sdlc/code.playbook/code.playbook.test.ts`](reference/sdlc/code.playbook/code.playbook.test.ts)
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

- Node.js ≥ 20
- pnpm 9 (for the reference package)
- A configured `tmux-play` host (for live Boss turns)

## Contributing

We welcome contributions of all kinds.

- 🌟 Star our repo if you find playbook useful.
- [Open an issue](https://github.com/sublang-ai/playbook/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/playbook/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

## License

[Apache-2.0](LICENSE)
