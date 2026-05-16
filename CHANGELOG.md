<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-17

### Added

- Three-phase playbook compiler stack as specs: `slc/text2gears.md` (prose → GEARS spec items, one per state behavior), `slc/gears2fsm.md` (GEARS → XState v5 finite state machine, one captain-invoking state per item), and `slc/link.md` (FSM → host-agnostic runtime driven by Boss turns through typed ports).
- Reference CODE playbook at `reference/sdlc/code.playbook/` — a worked end-to-end example of the stack driving a coder / reviewer / committer loop. Source at `reference/sdlc/code.md`; compiled to gears `code.gears.md` (CODE-1..19), FSM `code.fsm.ts`, runtime `code.playbook.ts`, and `tmux-play` adapter `code.tmux-play.ts`.
- Captain-pane status stream with a four-glyph vocabulary (`◆` terminal/idle, `▸` Boss-input echo, `⮕` captain-invoking state entry with label + player + CODE-N + rider fields, `⤷` transition guard with payload tallies). Telemetry stream stays structured under topic `playbook.fsm.state`.
- `playbook-code` CLI bin — launches `tmux-play` with the bundled `tmux-play.production.config.yaml` so end users can run the reference playbook with one command after `npm install -g @sublang/playbook @sublang/cligent`.
- Conformance test suite (386 tests across six files) pinning the gears ↔ FSM 1:1 mapping (PLAYBOOK-1..6), runtime contract (PBRT-5..16), prompt composition, introspect helpers, and onDone arm coverage.
- Package exports `./code/playbook` (the host-agnostic `createPlaybookRuntime` factory) and `./code/tmux-play` (the cligent-bound Captain factory).

[Unreleased]: https://github.com/sublang-ai/playbook/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sublang-ai/playbook/releases/tag/v0.1.0
