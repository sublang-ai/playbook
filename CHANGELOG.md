<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Playbooks can now compose concurrent work and nested playbook calls.** DISCUSS runs Host and Participant proposals as XState parallel regions with branch-local Boss waits and deterministic joins. A playbook may invoke another enabled playbook, suspend across Boss turns, and resume from its output through the Captain's causal LIFO session stack ([DR-011](specs/decisions/011-composable-playbook-execution.md), [PBRT-40](specs/dev/playbook-runtime.md#pbrt-40), [CAPTAIN-28](specs/user/playbook-captain.md#captain-28)).
- **Every playbook runtime session now has an immutable UUID and a complete ordered boundary trace.** The new `PlaybookSession` init contract supplies the session/playbook identity, while `playbook.trace` records exact Boss input, player and judge calls, FSM transitions, status emissions, settlement, normalized failures, and disposal with contiguous sequence and paired call IDs. The Captain closes an active runtime in tmux-play's live pre-close hook so the terminal trace reaches observers during host shutdown ([DR-010](specs/decisions/010-playbook-session-tracing-and-resume.md), [PBRT-37](specs/dev/playbook-runtime.md#pbrt-37)).
- **Players resume explicitly within a playbook session.** Linked runtimes force each resolved player fresh on first contact, retain only that adapter's returned `resumeToken`, and select it on later calls; replacement engagements cannot inherit an earlier host-player conversation. CODE and DISCUSS share the contract, and the Playbook Captain correlates the same UUID across its bounded ledger and telemetry ([PBRT-38](specs/dev/playbook-runtime.md#pbrt-38), [CAPTAIN-26](specs/dev/playbook-captain.md#captain-26)).
- **The DISCUSS playbook ships in the package.** `reference/sdlc/discuss.playbook/` carries the slc-compiled artifacts (`discuss.gears.md`, `discuss.fsm.ts`, `discuss.playbook.ts`) compiled from `reference/sdlc/discuss.md` by `slc playbook` through slc's pinned compiled meta-phase playbooks, plus the hand-written registry entry with a turn-summary policy. The registry module is a public export — configure `playbooks.discuss.from: "@sublang/playbook/discuss/registry"` — and the config template documents the block ([RELEASE-20](specs/dev/release.md#release-20), [RELEASE-21](specs/test/release.md#release-21)).

### Changed

- **Breaking: the public `@sublang/playbook/runtime` contract now carries causal `PlaybookSession` identity, requires explicit player resume selection, returns structured run state, and adds `callPlaybook` / `resumePlaybookCall`.** Hosts must implement the five-port boundary and nested-call start/resume protocol. Trace payloads advance to schema version 2 with nested call pairs and session causality ([PBRT-34](specs/dev/playbook-runtime.md#pbrt-34), [PBRT-42](specs/dev/playbook-runtime.md#pbrt-42), [RELEASE-15](specs/dev/release.md#release-15)).

### Fixed

- **The generic `playbook` launcher now rejects the reserved `captain` role before launching.** A registry entry declaring `requiredRoleIds` containing `captain` (e.g. a compiler-phase playbook whose linked runtime binds its sole player as `captain`) previously composed a tmux-play session that could silently lose the Captain console pane — the session came up with only the other playbooks' player panes and no boss prompt, with no diagnostic. The launcher now rejects a manifest `requiredRoleIds` or a `playbooks.<id>.players` map that names `captain` — reserved for the tmux-play host Captain — with a pre-launch diagnostic naming the reserved role ([PBCLI-9](specs/dev/playbook-cli.md#pbcli-9), [PBCLI-15](specs/test/playbook-cli.md#pbcli-15)).
- **DISCUSS no longer fails right after the Committer commits.** The reference DISCUSS runtime's adjudication parser dropped every required payload field after the first named in one "Output shall include ..." sentence, so DISCUSS-5's `reviewScope` never reached the FSM context, and it also discarded non-required judge payload fields (e.g. a volunteered `reviewScope` on the DISCUSS-14 commit adjudication), so the commit state's onDone guards could never match a review scope and the machine fell to `failed`. Both holes are closed per [slc/link.md §Captain adjudication](slc/link.md) — required fields are extracted per sentence span and judge payload fields flow through (with `reviewScope` still validated) — and a malformed `CaptainOutput` remembered as `lastError` now surfaces as serialized JSON instead of `[object Object]`.

## [0.9.0] - 2026-06-30

### Added

- **Generic `playbook` CLI and multi-playbook registry** ([DR-009](specs/decisions/009-generic-playbook-cli-and-registry.md), [IR-016](specs/iterations/016-generic-playbook-cli-and-registry.md)). A new `playbook` executable seeds and composes a top-level `profiles` / `playbooks` config into a `tmux-play` config under the Playbook Captain shell: each enabled playbook is loaded from an explicit `from` module, bound to namespaced `<id>-<role>` host players, and made visible per active playbook through cligent 0.13.0 `setVisiblePlayers`. `playbook --list` prints the configured playbooks, and the CODE registry entry is published at `@sublang/playbook/code/registry`.

### Changed

- **CODE options move to `captain.options.playbooks.code.options`** (from `captain.options.code`), and CODE players are namespaced `code-coder` / `code-reviewer` in the composed `tmux-play` roster ([PBRT-4](specs/user/playbook-runtime.md#pbrt-4), [PBRT-29](specs/user/playbook-runtime.md#pbrt-29), [PBRT-30](specs/dev/playbook-runtime.md#pbrt-30)). The Playbook Captain shell now requires `captain.options.playbooks` and no longer infers a CODE-only default from `captain.options.code`.
- **Seeded `profiles` ids now name the agent/model instead of the player role.** The starter config renamed `judge` / `coder` / `reviewer` to `claude-opus` / `claude-opus-1m` / `codex-gpt`, so a profile id reads distinctly from the `captain` / `coder` / `reviewer` roles that reference it (e.g. `players.coder: claude-opus-1m`). Existing user configs are untouched; this only changes freshly seeded configs ([PBCLI-11](specs/dev/playbook-cli.md#pbcli-11)).

### Removed

- **Breaking: removed the `playbook-code` bin, the `@sublang/playbook/code/tmux-play` export and compatibility shim, and the bundled legacy CODE `tmux-play` configs and overlay template** in favor of the generic `playbook` CLI and `@sublang/playbook/code/registry` ([RELEASE-20](specs/dev/release.md#release-20)). Launch with `playbook` and the top-level `profiles` / `playbooks` config; pass a raw `tmux-play` config with `playbook --config <path>`.

### Fixed

- **Seeded Claude agents now run in protected auto mode.** When the generic `playbook` starter config replaced the `playbook-code` overlay template, the `permissions.mode: auto` grant previously carried by the Claude Captain and Coder was dropped, leaving only the Codex Reviewer in auto mode; the Claude agents fell back to cligent's default approval-prompting posture. The starter config now sets `permissions.mode: auto` on every seeded agent — the Captain and both roles — while keeping the Codex Reviewer's `writablePaths: ['.git']` grant for git metadata writes ([PBCLI-11](specs/dev/playbook-cli.md#pbcli-11)).

## [0.8.0] - 2026-06-29

### Changed

- **Bump `@sublang/cligent` `^0.12.0` → `^0.13.0`.** The published `package.json` specifier and the checked-in `pnpm-lock.yaml` pin are raised together to cligent 0.13.0 ([RELEASE-14](specs/dev/release.md#release-14)). cligent 0.13.0's `tmux-play` loader adds dynamic player visibility (`layout.initialVisible`) and the shape-specific `layout.singlePlayerColumnWeights` / `layout.multiPlayerColumnWeights` fields alongside the `layout.columnWeights` compatibility alias. Under the prior `^0.12.0` floor, a base `tmux-play` config authored by cligent 0.13.0 (whose loader emits `multiPlayerColumnWeights`) was rejected on load with `Unknown config field layout.multiPlayerColumnWeights`; the raised floor accepts it. The seeded CODE overlay keeps `columnWeights: [4, 6, 6]`, still accepted as the multi-player alias ([PBCODE-16/17](specs/dev/playbook-code.md), [IR-013](specs/iterations/013-player-alias-default-lineup.md)).
- **Refresh `playbook-code` default CODE lineup.** Fresh first-run overlays and bundled tmux-play configs now pin Captain `claude`/`claude-opus-4-8` at `high`, Coder `claude`/`claude-opus-4-8[1m]` at `xhigh`, Reviewer `codex`/`gpt-5.5` at `xhigh`, and Committer to the Coder (`players.committer: coder` in overlays and `captain.options.code.committer: coder` in full tmux-play configs). The seeded Codex role's `.git` writable path grant follows the Reviewer after the Codex role moves there. Existing user configs are untouched per PBCODE-5.

### Fixed

- **`playbook-code` base-`layout` inheritance now round-trips on cligent 0.13.0.** When a default launch inherited the `layout` block from a discovered base `tmux-play` config, the composer carried cligent's normalized layout through wholesale — including a `layout.initialVisible` keyed to the base config's players and both the `columnWeights` alias and the canonical `multiPlayerColumnWeights`. cligent 0.13.0 rejected the composed config at launch (`layout.initialVisible[…] "…" is not a configured player id`, or `layout.columnWeights conflicts with layout.multiPlayerColumnWeights`). The composer now owns `layout.initialVisible` (omitting it so cligent shows the full composed `coder` + `reviewer` roster) and drops the redundant `columnWeights` alias when the canonical shape field is present ([PBCODE-17](specs/dev/playbook-code.md#pbcode-17), [PBCODE-18](specs/test/playbook-code.md#pbcode-18)). Seeded-overlay launches, whose `layout` block carries only `columnWeights`, are unaffected.

## [0.7.0] - 2026-06-22

### Added

- Expose the host-agnostic runtime contract at `@sublang/playbook/runtime` (`PlayerResult`, `PlaybookPorts`, `PlaybookRuntime`, `PlaybookRuntimeFactory`) and publish the authored compiler-phase specs at `@sublang/playbook/slc/*` so downstream consumers can resolve and read `slc/link.md`, `slc/gears2fsm.md`, and `slc/text2gears.md` directly.

### Fixed

- Pin the published `@sublang/cligent` dependency specifier to `^0.12.0` instead of the moving `latest` dist-tag, and align the release spec, lockfile, README, and release tests with that policy.

## [0.6.0] - 2026-06-14

### Added

- **Playbook Captain shell (DR-008).** A built-in Captain shell is now the tmux-play Captain: it owns Boss chat, engages a registered playbook by explicit command (`/code`) or inferred intent, drives the engaged sub-runtime, and returns to chat when that runtime parks, finishes, or fails. CODE is the first registered playbook. A single Captain LLM session backs visible Boss chat, hidden routing, and the sub-runtime's judge calls, keeping control-plane JSON off the Boss pane ([DR-007](specs/decisions/007-hidden-judge-captain-pane.md)). The shell emits Boss-visible engagement status lines (`◇ /code started`, `stopped`, `finished`), and the public `./code/tmux-play` export remains a compatibility shim that delegates to the shell. Specs: [CAPTAIN](specs/user/playbook-captain.md), [DR-008](specs/decisions/008-playbook-captain-shell.md), [IR-014](specs/iterations/014-playbook-captain-shell.md).
- **Visible turn-summary blocks (CAPTAIN-19).** After an engaged playbook finishes a Boss turn, the shell appends a brief, chat-like summary of what changed (not how), using only the aggregate counts the playbook registry marks summary-visible — for CODE, review/rebuttal rounds (e.g. `2 review rounds, 1 rebuttal`). It closes with a saved-counts line, `Saved you X interruptions and Y copy-pastes across Z rounds of reviews/rebuttals.` (natural singular forms when a count is one). Captain chat, clarification, and bare-selection turns get no summary block.
- `playbook-code` CODE overlays and bundled tmux-play configs now support cligent's top-level `notifications` block. Fresh seeds include cligent's generated-home defaults (`player_finished: bell`, `turn_finished: desktop`), existing user overlays missing `notifications` are migrated on the next default launch, and composition carries `notifications` from the overlay or inherits it from a discovered base config with the same precedence as `theme` and `layout`.

### Changed

- **Bump pinned `@sublang/cligent` 0.11 → 0.12.** The repo `pnpm-lock.yaml` pin is refreshed to the release tagged `latest` ([RELEASE-14](specs/dev/release.md#release-14)); the published `package.json` keeps the `latest` specifier. cligent 0.12 adds the top-level `notifications` block to its `tmux-play` loader, so the inheritance above resolves through `loadTmuxPlayConfig` end to end. Its raised `@openai/codex-sdk` peer floor (`>=0.138.0`) bumps that wired-adapter dependency ([RELEASE-12](specs/dev/release.md#release-12)) to `^0.139.0`.
- Retired the inert raw-YAML recovery path for base `layout` fields now that the pinned cligent loader returns normalized host fields directly; `playbook-code` inherits base `layout` and `notifications` from cligent's loaded config.
- Playbook Captain shell-owned status lines no longer attach structured status data that tmux-play renders as raw JSON; the shell state remains available through `playbook.captain.fsm.state` telemetry.
- The CODE Reviewer's spec-review checklist gains a **Well organized** item (spec packages finely scoped — high cohesion, low coupling) and tightens its *Right level* wording to *system behavior*, retiring the legacy phrasing; pinned by [PLAYBOOK-18](specs/dev/playbook.md#playbook-18) and the conformance suite ([PLAYBOOK-19](specs/test/playbook.md#playbook-19)).

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

[Unreleased]: https://github.com/sublang-ai/playbook/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/sublang-ai/playbook/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/sublang-ai/playbook/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/sublang-ai/playbook/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/sublang-ai/playbook/compare/v0.5.0...v0.6.0
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
