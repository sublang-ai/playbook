<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** `playbook-code` and the CODE tmux-play configs now match cligent's player terminology: config key `roles:` is now `players:`, help/spec text names `players[].id`, and the adapter calls `CaptainContext.callPlayer(...)`. This requires the cligent release that includes the tmux-play role-to-player rename.

## [0.2.0] - 2026-05-24

### Added

- Boss-reply suspension. Any captain-invoking state can now pause when the player surfaces a clarifying question for Boss: the FSM parks at `awaitBossReply` and the Captain pane shows the question; Boss's next turn is normally classified as the reply (a clearly fresh directive abandons the pending question instead), and the same state resumes with the Q+A in its prompt. DR-005 introduced the path, IR-006 implemented it, and IR-008 made it universal across every captain-invoking state.

### Changed

- **Boss turns are now plain language; the judge is the sole classifier.** Every non-empty Boss turn is passed to the judge, which classifies it into one of the FSM's events (or `NO_ACTION`); the judge picks `BOSS_INTERRUPT` targets from the FSM's jumpable states by their human-readable descriptions. There is no slash fast-path — text starting with `/` is treated as ordinary Boss content. (IR-009)
- Bundled `tmux-play` configs (dev and production) now set `permissions.mode: auto` on the captain and both roles, so each agent runs in cligent's protected auto mode (claude `permissionMode: 'auto'`, codex `on-request + auto_review`). Routine in-session approval prompts are suppressed.

### Removed

- The four slash commands `/start <intent>`, `/continue <#>`, `/summarize <#>`, and `/interrupt <stateId>` are no longer recognized by the runtime. Their behavior is now reached by typing the same intent in plain language (see Changed). The `/command` namespace is reserved for host-level playbook selection. (IR-009)
- Framework-injected "If a specific Boss answer is needed, ask the exact question and stop." player-prompt instruction. Boss-reply suspension still works: a clarifying question that naturally appears in player prose is detected by the adjudicator's `needsBossReply` classification — no nudge prompt is needed. (IR-010)

## [0.1.3] - 2026-05-17

### Changed

- Bump `@sublang/cligent` to `^0.4.0`. cligent 0.4.0 ships the new tmux-play look: Markdown-rendered pane output via [`glow`](https://github.com/charmbracelet/glow), a Catppuccin Mocha theme with per-adapter accent colors on pane borders and speaker prefixes, and a tool lifecycle prefix grammar (`tool>` invocation / `tool<` result). v0.1.2 pinned `^0.3.0` and missed all of it.
- **Requires `glow` on `PATH`.** cligent 0.4.0's tmux-play launcher fails fast when `glow` is missing. Install via `brew install glow` (macOS), `apt install glow`, or follow [the upstream installation guide](https://github.com/charmbracelet/glow#installation).

## [0.1.2] - 2026-05-17

### Fixed

- `playbook-code` after a global install (`npm install -g @sublang/playbook ...`) no longer fails with `ClaudeCodeAdapter requires @anthropic-ai/claude-agent-sdk`. v0.1.1 added the SDKs as dependencies, but global-install topology puts each top-level package in its own siloed `node_modules/` — so cligent (installed as a separate global package) couldn't walk up to find the SDKs sitting in `@sublang/playbook/node_modules/`. v0.1.2 moves `@sublang/cligent` into `dependencies` so it lands transitively inside playbook's tree; the SDK resolution walk now hits the deps. The single-command install is now `npm install -g @sublang/playbook` (cligent comes along).
- `bin/playbook-code` no longer requires `tmux-play` on `PATH`. The shim now resolves the CLI through `require.resolve('@sublang/cligent/tmux-play')` and execs it via `node`, so it works regardless of whether the user has cligent installed separately.

### Changed

- `engines.node` raised from `>=20` to `>=20.6.0`. The new `playbook-code` shim uses `import.meta.resolve` synchronously, unflagged only since Node 20.6.0; the previous declaration advertised Node 20.0–20.5 as supported but would crash there before `tmux-play` launched.
- CI's smoke job now uses a global-prefix install and probes adapter SDK resolution from cligent's installed location — the topology that surfaces the v0.1.1 regression. The previous local-style install hoisted everything into a shared `node_modules/`, masking the bug.

## [0.1.1] - 2026-05-17

### Fixed

- `playbook-code` no longer fails at runtime with `ClaudeCodeAdapter requires @anthropic-ai/claude-agent-sdk` (and the Codex equivalent). The bundled production config wires both adapters, so the SDKs are now declared as direct dependencies of `@sublang/playbook` and install automatically.

## [0.1.0] - 2026-05-17

### Added

- Three-phase playbook compiler stack as specs: `slc/text2gears.md` (prose → GEARS spec items, one per state behavior), `slc/gears2fsm.md` (GEARS → XState v5 finite state machine, one captain-invoking state per item), and `slc/link.md` (FSM → host-agnostic runtime driven by Boss turns through typed ports).
- Reference CODE playbook published as `@sublang/playbook` — a worked end-to-end example of the stack driving a coder / reviewer / committer loop. Source at `reference/sdlc/code.md`; compiled to gears `code.gears.md` (CODE-1..19), FSM `code.fsm.ts`, runtime `code.playbook.ts`, and `tmux-play` adapter `code.tmux-play.ts`.
- Captain-pane status stream with a four-glyph vocabulary (`◆` terminal/idle, `▸` Boss-input echo, `⮕` captain-invoking state entry with label + player + CODE-N + rider fields, `⤷` transition guard with payload tallies). Telemetry stream stays structured under topic `playbook.fsm.state`.
- `playbook-code` CLI bin — launches `tmux-play` with the bundled `tmux-play.production.config.yaml` so end users can run the reference playbook with one command after `npm install -g @sublang/playbook @sublang/cligent`.
- Conformance test suite (386 tests across six files) pinning the gears ↔ FSM 1:1 mapping (PLAYBOOK-1..6), runtime contract (PBRT-5..16), prompt composition, introspect helpers, and onDone arm coverage.
- Package exports `./code/playbook` (the host-agnostic `createPlaybookRuntime` factory) and `./code/tmux-play` (the cligent-bound Captain factory).

[Unreleased]: https://github.com/sublang-ai/playbook/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sublang-ai/playbook/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/sublang-ai/playbook/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sublang-ai/playbook/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sublang-ai/playbook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sublang-ai/playbook/releases/tag/v0.1.0
