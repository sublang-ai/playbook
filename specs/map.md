<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Spec Map

Quick-reference index for locating spec files.
Spec items are the source of truth.
Code can be inconsistent with specs during development.

## Layout

```text
decisions/  Decision records (DRs)
iterations/ Iteration records (IRs)
user/       User-visible behavior item files
dev/        Implementation requirements item files
test/       Acceptance testing item files
map.md      This index
meta.md     The spec of specs
```

## Decisions

| ID | File | Summary |
| --- | --- | --- |
| DR-000 | [000-spec-structure-format.md](decisions/000-spec-structure-format.md) | Spec structure, format, and naming conventions |
| DR-001 | [001-state-machine-tooling.md](decisions/001-state-machine-tooling.md) | XState + Stately Sketch for state machine modeling, visualization, and simulation |
| DR-002 | [002-in-page-xstate-visualizer.md](decisions/002-in-page-xstate-visualizer.md) | XState visualizer architecture (Diagram / Telemetry / Binding; `SketchTelemetry` protocol) — superseded by DR-003 |
| DR-003 | [003-sketch-controlled-shell.md](decisions/003-sketch-controlled-shell.md) | Stately Sketch as a controlled visual shell driven by `actor.system.inspect` and a postMessage protocol |
| DR-004 | [004-link-code-fsm-to-playbook-runtime.md](decisions/004-link-code-fsm-to-playbook-runtime.md) | CODE linker/runtime bindings: player binding (Committer alias config-driven per Addendum A2), free-text Boss-event classification with no in-playbook slash commands, adjudication, lifecycle, abort, telemetry, and direct CODE adapter wiring superseded by DR-008 shell target per Addendum A3; runtime contract types sourced from the shared `@sublang/playbook/runtime` module per Addendum A4 |
| DR-005 | [005-boss-reply-suspension-path.md](decisions/005-boss-reply-suspension-path.md) | Third Boss surface for `gears2fsm`: `awaitBossReply` quiescent state + `BOSS_REPLY` event + universal `needsBossReply` guard for captain-invoking states, so player questions suspend and resume the same state with the answer in context |
| DR-006 | [006-code-config-composition.md](decisions/006-code-config-composition.md) | CODE config via `captain.options.code` (namespaced, registry-validated) and `playbook-code` as a composer that overlays CODE invariants onto an optional base tmux-play config and targets the DR-008 shell adapter; base-inheritable host fields are `theme`, `layout`, `notifications`, and the captain-judge fields (§2.4); object-launcher deferred — superseded by DR-009 |
| DR-007 | [007-hidden-judge-captain-pane.md](decisions/007-hidden-judge-captain-pane.md) | No raw judge JSON on the Captain pane: route every CODE judge call through cligent's hidden `callCaptain({ visibility: 'hidden' })`, surface a suspended player's full question as captain speech then a rider-less marker (transitional augmentation + gated PBRT-32 test retired at the cligent 0.11.0 pin refresh) |
| DR-008 | [008-playbook-captain-shell.md](decisions/008-playbook-captain-shell.md) | Built-in Playbook Captain shell over registered sub-runtimes: `/code` as top-level selection, hidden routing plus visible chat in one Captain session, telemetry-mirrored sub-state, park/resume semantics, and `./code/tmux-play` compatibility shim; generic binary/discovery deferral superseded by DR-009 |
| DR-009 | [009-generic-playbook-cli-and-registry.md](decisions/009-generic-playbook-cli-and-registry.md) | Generic `playbook` CLI and multi-playbook registry enablement: explicit `from`-loaded registry modules, profile-based agent settings, playbook-scoped namespaced players, active-playbook tmux-play pane visibility, registry-owned park states and summary policy, and one active engagement preserved |

## Iterations

| ID | File | Goal |
| --- | --- | --- |
| IR-000 | [000-spdx-headers.md](iterations/000-spdx-headers.md) | Add SPDX headers to applicable files |
| IR-003 | [003-sketch-controlled-shell.md](iterations/003-sketch-controlled-shell.md) | Cutover to Sketch-as-controlled-shell: fork patches, parent-side adapter, retire DR-002 renderer |
| IR-004 | [004-link-code-fsm-to-playbook-runtime.md](iterations/004-link-code-fsm-to-playbook-runtime.md) | Compile CODE FSM into `code.playbook.ts` per `slc/link.md` and DR-004; ship the in-repo tmux-play adapter `code.tmux-play.ts` |
| IR-005 | [005-code-playbook-conformance-tests.md](iterations/005-code-playbook-conformance-tests.md) | Conformance tests pinning `code.fsm.ts` to `code.gears.md` (every CODE-N, every edge, every prompt) — replaces the dropped manual acceptance runbook |
| IR-006 | [006-boss-reply-suspension-path.md](iterations/006-boss-reply-suspension-path.md) | Implemented DR-005 end to end: `awaitBossReply` / `BOSS_REPLY` / `needsBossReply` suspension-resume path across specs, CODE gears/FSM/runtime, status/telemetry, and conformance/prompt/runtime tests |
| IR-008 | [008-universal-boss-reply.md](iterations/008-universal-boss-reply.md) | Make Boss-reply suspension universal across every captain-invoking state, withdrawing IR-007's source annotation and moving `needsBossReply` wiring from GEARS metadata into `gears2fsm` |
| IR-009 | [009-free-text-boss-input.md](iterations/009-free-text-boss-input.md) | Make every Boss turn free text classified by the judge, retiring in-playbook slash commands and reserving `/command` for playbook selection |
| IR-010 | [010-drop-boss-question-instruction.md](iterations/010-drop-boss-question-instruction.md) | Drop the injected Boss-question instruction from composed player prompts while retaining Boss-reply suspension |
| IR-011 | [011-playbook-code-onboarding.md](iterations/011-playbook-code-onboarding.md) | Seed a user-level `playbook-code.config.yaml` on first run, gate launch on a light per-adapter readiness check, and recover from missing auth by printing the shim's own `--help` |
| IR-012 | [012-hidden-judge-captain-pane.md](iterations/012-hidden-judge-captain-pane.md) | Implemented DR-007: every CODE judge call runs hidden via `callCaptain({ visibility: 'hidden' })`; `awaitBossReply` entry shows the full question as captain speech then a rider-less marker; temporary cligent augmentation + gated integration test |
| IR-013 | [013-player-alias-default-lineup.md](iterations/013-player-alias-default-lineup.md) | Add config-level player-alias support (Committer→Reviewer) and refresh the seeded CODE overlay: 4:6:6 column weights, 174×49 window, Captain Sonnet 4.6 / Coder GPT-5.5 xhigh / Reviewer Opus 4.8 xhigh |
| IR-014 | [014-playbook-captain-shell.md](iterations/014-playbook-captain-shell.md) | Implement DR-008: built-in Playbook Captain shell with CODE registered, `/code` selection, hidden routing, park/resume semantics, telemetry mirroring, and the `./code/tmux-play` compatibility shim |
| IR-015 | [015-slc-runtime-package-surface.md](iterations/015-slc-runtime-package-surface.md) | Publish the SLC-facing surface: authored type-only `@sublang/playbook/runtime` (`PlayerResult`, `PlaybookPorts`, `PlaybookRuntime`, `PlaybookRuntimeFactory`) as the single source CODE re-exports, `slc/**` shipped via a `./slc/*` export, and `/runtime` + `slc/*` marked public semver-stable surfaces |
| IR-016 | [016-generic-playbook-cli-and-registry.md](iterations/016-generic-playbook-cli-and-registry.md) | Decompose DR-009: generic `playbook` CLI, multi-playbook registry loaded via explicit `from` modules, profile-based settings, namespaced `<id>.<role>` players, active-playbook tmux-play visibility, registry-owned park states and summary policy, and retirement of `playbook-code` / `./code/tmux-play` / `captain.options.code` / PBCODE |

## Packages

### CAPTAIN

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-captain.md](user/playbook-captain.md) | Built-in Playbook Captain shell Boss surface: per-playbook slash selection, visible chat, active-engagement routing, active-playbook pane visibility, status pass-through, clear `/<command>` start/stop/finished status without JSON data, parking, dismissal, final disposal, and optional registry-owned turn-summary blocks whose saved-counts line combines interruption, copy-paste, and progress-round counts after sub-runtime turns |
| dev | [playbook-captain.md](dev/playbook-captain.md) | Playbook Captain shell system behavior: public `@sublang/playbook/playbook-captain` module, adapter lifecycle, registry-manifest entries loaded from `captain.options.playbooks` via `from` modules, local-role→host-player `<id>.<role>` binding, entry-owned park states, active-playbook `setVisiblePlayers` visibility, bounded ledger, hidden routing, prompt envelopes, port wrapping, optional registry-owned summary policy with saved counts and progress-round totals in one saved-counts line, telemetry mirroring, distinct shell telemetry carrying structured shell state, and park/resume/dispose lifecycle |
| test | [playbook-captain.md](test/playbook-captain.md) | Integration tests for shell routing, hidden/visible Captain calls, adapter lifecycle, public shell module resolution, registry loading from `captain.options.playbooks` with rejection rules, namespaced role→host-player binding, active-playbook visibility, status/telemetry pass-through, optional registry-owned turn-summary prompts/counts with saved counts and progress-round totals in one saved-counts line, human-readable shell status without structured data, telemetry mirroring, park/resume, dismiss, and final disposal |

### GIT

| Group | File | Summary |
| --- | --- | --- |
| dev | [git.md](dev/git.md) | Commit message format and AI co-authorship trailers |

### LIC

| Group | File | Summary |
| --- | --- | --- |
| dev | [licensing.md](dev/licensing.md) | SPDX header requirements and file-scope rules |
| test | [licensing.md](test/licensing.md) | Copyright and license header presence checks |

### PBCLI

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-cli.md](user/playbook-cli.md) | Generic `playbook` command: top-level `profiles`/`playbooks` config model (no `config:` wrapper, no top-level `players`), starter-config seeding that enables CODE via explicit `from`, `--config` raw pass-through, `--list`, `--help`, launcher-owned adapter readiness gate, exit/signal behavior, and launch under the Playbook Captain shell on tmux-play |
| dev | [playbook-cli.md](dev/playbook-cli.md) | Generic `playbook` launcher: tmux-play resolution and Node floor, `profiles`/`playbooks` normalization into `captain.options.playbooks` (`from`/optional `command`/`options` slice, profile-vs-adapter-shorthand collision rejection), namespaced `<id>.<role>` roster generation with manifest import and pre-launch loader rejections (missing `from`, failed import, invalid entry, duplicate id/command, unresolved or zero visible roles), launcher-owned `layout.initialVisible` and session column weights, seeded default lineup, and launcher-owned adapter readiness |
| test | [playbook-cli.md](test/playbook-cli.md) | Integration tests for starter-config seeding/no-reseed, composition (`captain.from`, per-playbook option slice, profile/adapter resolution, namespaced roster, `layout.initialVisible`), enablement rejection rules, readiness pass/fail/unknown-adapter warning, and the `--list`/`--help`/`--config`/exit-code CLI surface |

### PBRT

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-runtime.md](user/playbook-runtime.md) | CODE Boss surface after a turn reaches CODE: free-text classification, `awaitBossReply` reply-vs-directive behavior, Captain-pane progress, and tmux-play host configuration through `@sublang/playbook/playbook-captain` with host-owned fields such as notifications, namespaced `code.coder`/`code.reviewer` binding, plus CODE options under `captain.options.playbooks.code.options` and the Committer alias |
| dev | [playbook-runtime.md](dev/playbook-runtime.md) | CODE runtime system behavior: host-agnostic ports, free-text classifier/no slash fast path, tolerant judge-JSON parsing, session lifecycle, player binding (configurable Committer alias), captain bridge, adjudication, abort, telemetry, shell registry wiring including the CODE `summaryPolicy` (review/rebuttal labels, copy-paste guards, saved-counts line), `@sublang/playbook/code/registry` enablement, CODE option-slice validation under `captain.options.playbooks.code.options`, and the shared `@sublang/playbook/runtime` type-only contract module the CODE runtime re-exports |
| test | [playbook-runtime.md](test/playbook-runtime.md) | Integration tests for free-text classification, tolerant judge-JSON parsing, `awaitBossReply`, status/telemetry, lifecycle, player binding, shell/CODE `code/registry` wiring including `summaryPolicy` labels, option-slice validation under `captain.options.playbooks.code.options` with fake ports/stubbed cligent primitives, and runtime-contract consistency (`@sublang/playbook/runtime` vs slc/link.md) plus CODE type-identity |

### PLAYBOOK

| Group | File | Summary |
| --- | --- | --- |
| dev | [playbook.md](dev/playbook.md) | CODE playbook FSM ↔ GEARS conformance contract (source agreement, transition coverage, prompt composition, Reviewer review-only and spec-checklist prompts) |
| test | [playbook.md](test/playbook.md) | Integration tests pinning the FSM ↔ GEARS conformance contract and Reviewer prompt contracts under `pnpm test` |

### RELEASE

| Group | File | Summary |
| --- | --- | --- |
| dev | [release.md](dev/release.md) | npm publish + GitHub Release workflow for `@sublang/playbook` runtime, Playbook Captain shell, and the generic `playbook` CLI (semver, changelog, tag-driven CI, OIDC trusted publishing, cligent dependency range admitting the tmux-play dynamic-visibility surface), plus public semver-stable `/runtime`, `slc/*`, `playbook` bin, and `@sublang/playbook/code/registry` surfaces and the breaking removal of `playbook-code` / `./code/tmux-play` / legacy CODE configs |
| test | [release.md](test/release.md) | Integration tests for the published install closure (`@sublang/cligent` nested under playbook, adapter SDKs resolvable), cligent dependency specifier/lockfile agreement, and public surfaces (`slc/*` resolution via `import.meta.resolve`, `npm pack` inclusion of `/runtime` artifacts and `slc/**`, and the `playbook` bin / `./code/registry` presence with `playbook-code` / `./code/tmux-play` absent) |

### SKETCH

| Group | File | Summary |
| --- | --- | --- |
| user | [sketch.md](user/sketch.md) | XState sketch visualizer: diagram and live-activity behavior |
| dev | [sketch.md](dev/sketch.md) | Architecture, telemetry protocol, and lifecycle contracts |
| test | [sketch.md](test/sketch.md) | Integration tests for diagram, telemetry derivation, and lifecycle |
