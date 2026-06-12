<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `playbook-code` CODE overlays and bundled tmux-play configs now support cligent's top-level `notifications` block. Fresh seeds include cligent's generated-home defaults (`player_finished: bell`, `turn_finished: desktop`), and composition carries `notifications` from the overlay or inherits it from a discovered base config with the same precedence as `theme` and `layout`.

## [0.5.0] - 2026-06-09

### Added

- **CODE config composition (DR-006).** Without `--config`, `playbook-code` composes the launched `tmux-play` config from the user's CODE overlay plus an optional base config discovered via cligent's `findTmuxPlayConfig`. The overlay's `players` map (carrying the CODE invariants) maps to `players[]` + `captain.from`, and `theme`, the captain-judge fields, and the top-level `layout` block (window size + column weights) are inherited from the base when the overlay omits them. Specs: [PBCODE-16..18](specs/dev/playbook-code.md), [DR-006](specs/decisions/006-code-config-composition.md).
- **Configurable Committer alias (IR-013).** A CODE overlay may set `players.committer: coder | reviewer`, composed into `captain.options.code.committer`, to run the Committer's commit turn on the named player's pane (validated with a path-named error). Player identity strings stay session-derived (PBRT-4), so the alias is a pane selector only. Specs: [PBRT-8/29/30/31](specs/dev/playbook-runtime.md), [IR-013](specs/iterations/013-player-alias-default-lineup.md).
- **`playbook-code-dev` CLI** — a development entrypoint that rebuilds the reference playbook from `code.*.ts` on launch, for iterating without a separate build step.

### Changed

- **Bump pinned `@sublang/cligent` 0.8 → 0.11.** The repo `pnpm-lock.yaml` pin is refreshed to the release tagged `latest` ([RELEASE-14](specs/dev/release.md#release-14)); the published `package.json` keeps the `latest` specifier, so fresh installs already resolved this version. cligent 0.11 types the `visibility` option on `callCaptain` natively (`CallCaptainOptions`), so DR-007's transitional module augmentation and the `CLIGENT_SUPPORTS_HIDDEN_CAPTAIN`-gated test are removed and [PBRT-32](specs/test/playbook-runtime.md#pbrt-32) now runs the "judge JSON never reaches the Boss pane" proof end to end ([DR-007 §3](specs/decisions/007-hidden-judge-captain-pane.md)). cligent 0.11's `tmux-play` loader also now preserves a config's top-level `layout` (rather than dropping it, which makes the shim's layout recovery inert) and validates `layout.columnWeights` length against pane count (1 Boss/Captain column + one per player); the bundled and seeded configs already satisfy this.
- **Refreshed seeded defaults.** The first-run CODE overlay now pins Captain `claude-sonnet-4-6` (`high`), Coder `codex`/`gpt-5.5` (`xhigh`, with `.git` in `writablePaths`), and Reviewer `claude`/`claude-opus-4-8` (`xhigh`); aliases the Committer to the Reviewer (`players.committer: reviewer`); and sizes the window 174×49 with `columnWeights: [4, 6, 6]`. Existing user configs are untouched per PBCODE-5.
- **Reviewer prompts are review-only.** The Reviewer states instruct surfacing findings without editing code; the FSM / GEARS / `code.md` Reviewer prompts and the conformance suite are updated in sync ([PLAYBOOK](specs/dev/playbook.md)).

### Fixed

- **Judge-JSON robustness.** The runtime tolerates messy judge replies (code-fenced or prefixed JSON), trims and recovers the JSON object, and normalizes parse/transport errors instead of failing the turn; together with DR-007 the judge's control-plane JSON is kept off the Boss pane.
- The composed config recovers a base `layout` block that cligent's pre-0.11 loader dropped during discovery, so base inheritance holds end to end (now inert under the 0.11 loader, which preserves `layout`).
- GEARS ↔ FSM kept in sync with refined `code.md` wording, and IR-drafting prompts kept free of task work.

## [0.4.2] - 2026-05-28

### Changed

- Bump `@sublang/cligent` from `^0.6.0` to `^0.8.0`. The 0.7 and 0.8 releases keep the `@sublang/cligent/tmux-play` and `@sublang/cligent/adapters/{claude-code,codex}` surfaces used by `code.tmux-play.ts` and `scripts/smoke-adapters.mjs` byte-identical (verified by diff of published `.d.ts`); the `playbook-code` shim's `import.meta.resolve('@sublang/cligent/tmux-play')` + sibling `cli.js` lookup still resolves under 0.8's restored `bin/tmux-play.mjs`. New optional `tmux-play` `theme` config field defaults to `'auto'` flavor detection — existing bundled and user configs without a `theme:` key keep working unchanged. README updated.
- Relax the `@sublang/cligent` range in published `package.json` from `^0.8.0` to the `latest` dist-tag (new spec item [RELEASE-14](specs/dev/release.md#release-14)). Fresh `npm install -g @sublang/playbook` runs (no lockfile) now resolve whichever cligent release currently carries the `latest` tag, so cligent bumps reach end users without waiting for a playbook release. The repo's own `pnpm-lock.yaml` still pins a specific resolved version per [RELEASE-7](specs/dev/release.md#release-7), so CI's `pnpm install --frozen-lockfile` stays reproducible until a developer runs `pnpm install` to refresh the pin. The trade-off is intentional and accepted: cligent's 0.x line can ship breaking changes in a minor bump, in which case a fresh install of an older playbook release may need a CHANGELOG-noted cligent floor before the next playbook bump.

## [0.4.1] - 2026-05-28

### Changed

- Bundled configs (seed template, dev `tmux-play.config.yaml`, bundled production yaml) now pin `model` and `reasoningEffort` on every entry instead of falling through to each adapter SDK's defaults: Captain is `claude-sonnet-4-6` at `reasoningEffort: high`, Coder is `claude-opus-4-7` at `reasoningEffort: xhigh`, Reviewer is `gpt-5.5` at `reasoningEffort: xhigh`. Fresh first-run seeds get these out of the box; existing user configs at `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook-code.config.yaml` are untouched per PBCODE-5 — edit them by hand to opt in.
- tmux-play adapter now derives the player identity strings (substituted into `<coder-llm>` / `<reviewer-llm>` placeholders in player prompts) from each `players[]` entry's `model` when pinned and falls back to its `adapter` only when no model is set. Combined with the defaults above, the Committer's prompt now reads `Coder is claude-opus-4-7; Reviewer is gpt-5.5.` rather than `Coder is claude; Reviewer is codex.`, so commit-message trailers can name the concrete model per GIT-4. PBRT-4 and PBRT-15 updated.
- CODE-18 / CODE-19 Committer prompts now carry a one-line directive telling the Committer to format the `Co-authored-by` `<model>` token as the conventional human form of the substituted id (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`), so commit-message trailers stay deterministic across runs instead of relying on the Committer's ad-hoc humanization. Added to `code.md`, `code.gears.md`, and `code.fsm.ts` in sync; conformance suite (GEARS ↔ FSM line presence + prompt-body verbatim equality) passes unchanged.

## [0.4.0] - 2026-05-28

### Changed

- **Breaking:** `captain.options.coderPlayer` / `reviewerPlayer` are no longer required in the host configuration. The tmux-play adapter now derives the per-run player identity strings (substituted into `<coder-llm>` / `<reviewer-llm>` placeholders in player prompts) from `players[].adapter` at init time per PBRT-4, removing the duplication with the `players:` section. Stale `captain.options.coderPlayer` / `reviewerPlayer` keys in existing user configs are silently ignored; delete them at your convenience. The bundled template, dev config, production config, and `playbook-code --help` text no longer mention these keys.
- Captain-pane status stream redesigned per PBRT-3: glyph vocabulary shrinks to three (`⤷` state entry as `<Player>: <label>`, `→` guard outcome as `→ <guard>[ · field=N]`, `◆` failure/awaitBossReply only). The `◆ ready` and `◆ done` tombstones are no longer emitted — the next `boss>` prompt is the implicit turn-over signal. The Boss-input echo is replaced with a bare classification line carrying only the FSM event type (e.g., `START_CODING`), which the host renders as captain speech. State entries no longer carry the source-item tag (`CODE-N`) or the rider fields (`intent=…`, `irNumber=…`, `taskDescription=…`); the Boss readline already shows the verbatim Boss text. The runtime emits each line as bare content with no leading whitespace; speaker chrome (the current cligent `captain> [status] …` prefix) and any visual nesting under parent lines are presentation concerns and remain the host's responsibility.

### Fixed

- Player-prompt composer now arranges labelled blocks around the body based on the body's directional language: `Boss intent:` and `Task description:` stay above the body as prior context, while `Review items:` and `Rebuttals:` are appended below the body so the CODE-N prompts' "for each review item below" / "for each rebuttal below" phrasing matches the rendered layout. Previously every labelled block was prepended, contradicting the body's instructions. The continuation preamble + Q/A blocks still precede every ordinary block. PLAYBOOK-5 and DR-004 §6 updated.

## [0.3.0] - 2026-05-27

### Added

- `playbook-code` first-run onboarding (IR-011). Without `--config`, the shim resolves a user-level config at `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook-code.config.yaml`, seeds it from a bundled template if absent (with one stderr line naming the path), and launches against it instead of the in-package production yaml. A readiness gate inspects the declared `captain.adapter` and `players[].adapter` values and refuses to launch when a known adapter (`claude`, `codex`) lacks its API key or local CLI directory; unknown adapters emit a warning but don't block. `--help` / `-h` prints the resolved config path, per-adapter auth pointers, and the agent-swap recipe, then exits without seeding or launching. Specs: [PBCODE-5..8](specs/user/playbook-code.md).

### Changed

- **Breaking:** `playbook-code` and the CODE tmux-play configs now match cligent's player terminology: config key `roles:` is now `players:`, help/spec text names `players[].id`, and the adapter calls `CaptainContext.callPlayer(...)`. Requires `@sublang/cligent` ≥ 0.6.0 (the tmux-play role-to-player rename). Existing user configs must rename the top-level `roles:` key to `players:`; `players[].id` values stay `coder` and `reviewer` per PBRT-4.
- Captain prompts now cite `meta.md` so the Captain can ground its judgments in the spec-of-specs vocabulary.

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

[Unreleased]: https://github.com/sublang-ai/playbook/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/sublang-ai/playbook/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/sublang-ai/playbook/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/sublang-ai/playbook/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/sublang-ai/playbook/compare/v0.2.0...v0.4.0
[0.3.0]: https://github.com/sublang-ai/playbook/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sublang-ai/playbook/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/sublang-ai/playbook/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sublang-ai/playbook/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sublang-ai/playbook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sublang-ai/playbook/releases/tag/v0.1.0
