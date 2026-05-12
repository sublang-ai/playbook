<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# @sublang/playbook — CODE playbook

Runtime module for the CODE playbook plus the tmux-play host
adapter. Compiles the FSM at [`code.fsm.ts`](./code.fsm.ts) into a
host-agnostic `PlaybookRuntime` per
[slc/link.md](../../../slc/link.md), with CODE-specific bindings
pinned by
[DR-004](../../../specs/decisions/004-link-code-fsm-to-playbook-runtime.md).

Two consumable surfaces:

- **`createPlaybookRuntime(options)` → `PlaybookRuntime`** —
  host-agnostic. Drive Boss turns through `init`, `handleBossInput`,
  `dispose`, speaking only the `PlaybookPorts` interface. No host
  imports.
- **`createCodeTmuxPlayCaptain(options)` → `Captain`** — the
  tmux-play adapter that wires `PlaybookPorts` to cligent's
  `CaptainContext` / `CaptainSession` primitives. The *only* file
  in this package that imports `@sublang/cligent/tmux-play`.

## Install (development)

```bash
cd reference/sdlc/code.playbook
pnpm install
```

This resolves `@sublang/cligent` (≥ 0.3.0, which exports
`./tmux-play`) from the registry; no local link required.

## Quickstart — drive a turn with fake ports

```ts
import createPlaybookRuntime, {
  type PlaybookPorts,
  type PlayerResult,
} from '@sublang/playbook/code/playbook';
// (Within this repo before publish, import from './code.playbook.js'.)

const ports: PlaybookPorts = {
  callPlayer: async (playerId, prompt, _signal): Promise<PlayerResult> => {
    // Forward to your player adapter. Return PlayerResult; the
    // runtime treats status !== 'ok' as a Captain error and routes
    // through onError → #failed (DR-004 §7).
    console.log(`[player:${playerId}] ${prompt.slice(0, 60)}…`);
    return { status: 'ok', finalText: 'no progress — need more Boss input.' };
  },
  callJudge: async (prompt, _signal): Promise<string> => {
    // Adjudicate via your judge LLM. The runtime parses the
    // returned JSON per DR-004 §4 and validates the chosen guard
    // plus any payload fields named in the result description.
    // Real adjudicators vary their answer per state; for this
    // quickstart we always return 'needsBossInput' — CODE-1
    // (planAndImplement, the destination of `/start`) declares
    // it, and the guard targets #ready, so the FSM lands back
    // at #ready after one captain turn.
    console.log(`[judge] ${prompt.slice(0, 60)}…`);
    return JSON.stringify({ guard: 'needsBossInput' });
  },
  emitStatus: async (message, data) => {
    console.log(`status: ${message}`, data ?? '');
  },
  emitTelemetry: async ({ topic, payload }) => {
    console.log(`telemetry: ${topic}`, payload);
  },
};

const runtime = createPlaybookRuntime({
  coderPlayer: 'claude',
  reviewerPlayer: 'codex',
});

await runtime.init(ports);
await runtime.handleBossInput({
  text: '/start add a button',
  signal: new AbortController().signal,
});
await runtime.dispose();
```

The runtime classifies `/start <text>` as `START_CODING` (DR-004 §3),
drives the FSM through one captain turn, and stops at the next
quiescent state (`ready`, `failed`, or `done`). See
[`code.playbook.test.ts`](./code.playbook.test.ts) for the full
range of shapes the fake ports cover (classifier, judge, abort,
interrupt, status/telemetry).

## Public API

| Export | Shape |
| --- | --- |
| `createPlaybookRuntime` (default) | `(options: CodePlaybookOptions) => PlaybookRuntime` |
| `PlaybookRuntime` | `{ init(ports), handleBossInput({text, signal}), dispose() }` per [slc/link.md](../../../slc/link.md) |
| `PlaybookPorts` | `{ callPlayer, callJudge, emitStatus, emitTelemetry }` |
| `PlayerResult` | `{ status: 'ok' \| 'aborted' \| 'error', finalText?, error? }` |
| `CodePlaybookOptions` | alias for `CodingInput` from `./code.fsm.ts` |

The runtime emits `emitTelemetry` on every FSM transition under
the `playbook.fsm.state` topic with payload `{ from, to, event }`,
and `emitStatus("State → <name>")` on every entry to a
Boss-relevant state (DR-004 §9). Entry to `failed` carries
`{ lastError }` in the status `data` argument.

## Running under tmux-play

The bundled config — [`tmux-play.config.yaml`](./tmux-play.config.yaml)
— declares the Captain factory and the two roles the CODE
playbook expects (`coder`, `reviewer`):

```bash
pnpm build
tmux-play --config reference/sdlc/code.playbook/tmux-play.config.yaml
```

Once running, the Boss pane accepts slash commands per DR-004 §3:
`/start <intent>`, `/continue <#>`, `/summarize <#>`,
`/interrupt <stateId>`. Anything else falls through to the
LLM-classifier.

## Release usage (post-publish)

After `@sublang/playbook` ships, `captain.from` in the YAML swaps
to the package specifier:

```yaml
captain:
  from: "@sublang/playbook/code/tmux-play"   # was: ./code.tmux-play.js
  # adapter, options, roles unchanged
```

The final specifier shape is confirmed at publish time
(DR-004 §11). Source consumers swap their imports the same way:

```ts
import createPlaybookRuntime from '@sublang/playbook/code/playbook';
```

## Scripts

- `pnpm build` — `tsc`; emits `code.playbook.js`,
  `code.tmux-play.js`, and their `.d.ts` siblings next to source.
- `pnpm test` — `vitest run` against the `.ts` sources
  (alias-resolved by [`vitest.config.ts`](./vitest.config.ts) so
  no prior build is required).

## Source

- [`code.gears.md`](./code.gears.md) — GEARS source items
- [`code.fsm.ts`](./code.fsm.ts) — XState v5 FSM (generated)
- [`code.playbook.ts`](./code.playbook.ts) — runtime module
- [`code.tmux-play.ts`](./code.tmux-play.ts) — tmux-play adapter
- [`tmux-play.config.yaml`](./tmux-play.config.yaml) — example
  config
