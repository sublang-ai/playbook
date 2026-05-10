<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-001: Parallel Cligents View

## Goal

Build a webpage under `views/` that visualises parallel [cligent](https://github.com/sublang-ai/cligent) instances coordinated by a Captain on behalf of the user (Boss). The leftmost panel is Boss's chat with Captain (user-editable). Each right panel is Captain's chat with a player (read-only). All conversations stream live with full prompts, replies, tool calls, and tool results.

## Layout

```text
┌──────────────────┬───────────────┬───────────────┬───────────────┐
│  Boss ↔ Captain  │ Captain ↔     │ Captain ↔     │ Captain ↔     │
│  (input-enabled) │ Coder         │ Reviewer      │ <player N>    │
│                  │ (read-only)   │ (read-only)   │ (read-only)   │
│  ...history...   │ ...history... │ ...history... │ ...history... │
│                  │               │               │               │
│  boss> _         │               │               │               │
└──────────────────┴───────────────┴───────────────┴───────────────┘
```

- Boss panel: input box at the bottom; submitting a line sends a prompt to Captain.
- Right panels: no input affordance; Captain owns the upper side of the conversation, the player's cligent owns the lower side.
- Number of right panels equals the number of configured players.

## Design

### Players

- **Boss** — the human user.
- **Captain** — a cligent instance that receives Boss prompts and orchestrates players via tools, one tool per player (e.g. `prompt_coder`, `prompt_reviewer`). Configured with a system prompt that names the configured players and describes when to use each.
- **Configured players** — one per right panel (e.g. Coder, Reviewer), each backed by a cligent instance and invoked when Captain calls the corresponding tool.

Players, adapters, and models live in a single config file (`views/config.ts`). Adding or removing a player is a config edit; the UI adds or removes the corresponding panel automatically.

### Orchestration

1. Boss submits a prompt → backend forwards it to Captain via `captain.run(prompt)`.
2. Captain's events stream into the Boss panel.
3. When Captain emits a `tool_use` for a player tool, the orchestrator:
   a. Renders the tool call in the Boss panel (so Boss can see what Captain delegated).
   b. Renders Captain's directive at the top of the matching right panel as a prompt bubble.
   c. Calls the player's cligent (`playerCligent.run(toolInput.prompt)`) and streams its events into that panel.
   d. Resolves Captain's tool call with the cligent's final text + status as the `tool_result` payload.
4. Captain may invoke multiple player tools within a single Boss turn; their right-panel runs proceed concurrently.

### Wire format

A single `WireEvent` envelope flows backend → frontend over WebSocket:

```ts
type WireEvent =
  | { kind: 'event';  panelId: string; event: CligentEvent }   // streamed cligent events
  | { kind: 'prompt'; panelId: string; from: 'boss' | 'captain'; text: string; ts: number };
```

Frontend → backend: `{ kind: 'boss_prompt'; text: string }`.

The orchestrator emits `prompt` envelopes when Boss submits and when Captain dispatches to a player; `event` envelopes carry every `CligentEvent` from the corresponding player's cligent.

### UI

Per-message rendering in each panel:

| Event | Render |
| --- | --- |
| `prompt` | Bubble on the upper-agent side; full prompt text; small player/model badge. |
| `text` / `text_delta` | Bubble on the lower-agent side; deltas concatenated; animated caret while streaming. |
| `thinking` | Dimmed italic note, collapsed by default. |
| `tool_use` | Collapsible card: tool name header + pretty-printed JSON input. |
| `tool_result` | Card linked to its `toolUseId` via `aria-controls`; status badge; output body (string, `{stdout}` extracted, else JSON-stringified). |
| `permission_request` | Inline notice (display only — Captain configures permissions; this view does not interactively grant them). |
| `error` | Red banner with `code` and `message`. |
| `done` | Subtle footer line: status, token usage, duration. |

Dynamic presentation:

- Smooth fade-in on each new message; animated streaming caret on the active text bubble.
- Pulsing border on a panel while its player's cligent has an active run; calmer state when idle.
- Auto-scroll to bottom on new content, paused if the user scrolled up; resumes on scroll-to-bottom.
- CSS grid: Boss panel a wider fixed minimum, player panels equal `1fr`; horizontal scroll if too many players.
- Dark theme by default; per-player accent colour applied to that panel's header and prompt bubbles.
- Monospace for tool JSON; sans-serif for chat text.

### Stack

- Backend: Node.js + TypeScript, importing `cligent` and the configured per-adapter modules. HTTP server with a WebSocket upgrade for the event channel.
- Frontend: Vite + TypeScript SPA. No heavy framework required; a small reactive state store plus DOM components is sufficient. The choice may be revisited if component complexity grows.
- One npm workspace rooted at `views/` (the playbook repo has no existing JS project).

### Out of scope

- Persisting conversation history across reloads.
- Multi-Boss / shared sessions.
- Authentication; the view is local-only.
- Editing or replaying past prompts.
- Configuring permissions or models from the UI (config file only).

## Deliverables

- [ ] `views/package.json` — workspace root with `dev`, `build`, `start` scripts; declares cligent + adapter peer deps.
- [ ] `views/tsconfig.json`, `views/vite.config.ts`.
- [ ] `views/index.html`, `views/src/main.ts` — frontend entry.
- [ ] `views/src/ui/` — panel, prompt-bubble, text-bubble, tool-use card, tool-result card, thinking note, error banner, done footer.
- [ ] `views/src/wire.ts` — WebSocket client + reducer turning `WireEvent`s into panel state.
- [ ] `views/server/index.ts` — HTTP + WebSocket server; serves the built frontend in production.
- [ ] `views/server/orchestrator.ts` — Captain ↔ player tool dispatch.
- [ ] `views/server/captain.ts` — Captain's cligent setup, player-tool definitions, system prompt.
- [ ] `views/config.ts` — player list (`id`, `label`, `accent`, `adapter`, `model`).
- [ ] `views/README.md` — quick start, env vars for adapter API keys, screenshot.

## Tasks

1. **Scaffold `views/`** — Vite + TypeScript app with backend folder; SPDX headers on every text source per [IR-000](000-spdx-headers.md).
2. **Define wire types** — `WireEvent`, `BossPrompt`; export from a shared module imported by both server and frontend.
3. **Backend skeleton** — HTTP server, WebSocket upgrade, accepts `BossPrompt`, broadcasts `WireEvent`s; serves the built frontend.
4. **Player config & cligents** — read `views/config.ts`, instantiate one cligent per player with `role: id` (cligent SDK field); fail fast on unknown adapter or missing API key.
5. **Captain setup** — instantiate Captain's cligent with player-named tools (one per player) and a system prompt naming the configured players and their purpose; declare tool input schema as `{ prompt: string }`.
6. **Orchestrator** — intercept Captain's `tool_use` events: emit a `prompt` `WireEvent` to the player panel, run the player's cligent, stream its events to the player panel, build a `tool_result` string from the cligent's final `text` + `done.status`, and resolve Captain's tool call with it.
7. **Concurrency** — allow concurrent cligent runs (one per player) within a single Boss turn while keeping ordering within each panel.
8. **Frontend layout** — CSS grid with Boss panel pinned left; per-player accent header; responsive rules.
9. **Message components** — implement the table in [§ UI](#ui); ensure `tool_use` and `tool_result` are paired by `toolUseId`.
10. **Reducer** — pure function `WireEvent → PanelState`: collapse `text_delta`s into a single streaming bubble keyed by event sequence; pair tool calls and results; surface `done` as a footer.
11. **Dynamic effects** — fade-in animation, streaming caret, panel pulse while active, auto-scroll with pause-on-scroll-up.
12. **Boss input** — input box with submit-on-Enter, disabled while Captain has an active run; right panels never receive input focus.
13. **README & screenshot** — quick start, env vars, screenshot of a populated multi-panel session.

## Acceptance criteria

- `npm run dev` in `views/` starts backend + frontend; opening the served URL renders the configured panels with a Boss input on the left and read-only player panels on the right.
- Submitting a prompt in the Boss panel streams Captain's response with visible `text_delta`, `tool_use`, and `tool_result` rendering.
- When Captain calls a player tool, the corresponding right panel renders Captain's prompt and then streams the reply from the player's cligent (text, tool calls, tool results, done).
- Multiple player tools called within one Boss turn populate their respective panels concurrently without cross-talk.
- Right panels have no input affordance and ignore keyboard input.
- All `views/**` source files carry SPDX headers per [LIC-3](../test/licensing.md#lic-3) and [LIC-4](../test/licensing.md#lic-4).
- The page remains interactive (no UI freeze) under sustained `text_delta` throughput.
