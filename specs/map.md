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
| DR-004 | [004-link-code-fsm-to-playbook-runtime.md](decisions/004-link-code-fsm-to-playbook-runtime.md) | CODE linker/runtime bindings: player binding (Committer alias config-driven per Addendum A2), free-text Boss-event classification with no in-playbook slash commands, adjudication, lifecycle, abort, telemetry, and direct CODE adapter wiring superseded by DR-008 shell target per Addendum A3 |
| DR-005 | [005-boss-reply-suspension-path.md](decisions/005-boss-reply-suspension-path.md) | Third Boss surface for `gears2fsm`: `awaitBossReply` quiescent state + `BOSS_REPLY` event + universal `needsBossReply` guard for captain-invoking states, so player questions suspend and resume the same state with the answer in context |
| DR-006 | [006-code-config-composition.md](decisions/006-code-config-composition.md) | CODE config via `captain.options.code` (namespaced, registry-validated) and `playbook-code` as a composer that overlays CODE invariants onto an optional base tmux-play config and targets the DR-008 shell adapter; base-inheritable host fields are `theme`, `layout`, `notifications`, and the captain-judge fields (§2.4); object-launcher deferred |
| DR-007 | [007-hidden-judge-captain-pane.md](decisions/007-hidden-judge-captain-pane.md) | No raw judge JSON on the Captain pane: route every CODE judge call through cligent's hidden `callCaptain({ visibility: 'hidden' })`, surface a suspended player's full question as captain speech then a rider-less marker (transitional augmentation + gated PBRT-32 test retired at the cligent 0.11.0 pin refresh) |
| DR-008 | [008-playbook-captain-shell.md](decisions/008-playbook-captain-shell.md) | Built-in Playbook Captain shell over registered sub-runtimes: `/code` as top-level selection, hidden routing plus visible chat in one Captain session, telemetry-mirrored sub-state, park/resume semantics, and `./code/tmux-play` compatibility shim |

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

## Packages

### CAPTAIN

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-captain.md](user/playbook-captain.md) | Built-in Playbook Captain shell Boss surface: `/code` selection, visible chat, active-engagement routing, status pass-through, human-readable shell status without JSON data, parking, dismissal, and final disposal |
| dev | [playbook-captain.md](dev/playbook-captain.md) | Playbook Captain shell system behavior: public `@sublang/playbook/playbook-captain` module, adapter lifecycle, CODE registry entry, bounded ledger, hidden routing, prompt envelopes, port wrapping, telemetry mirroring, distinct shell telemetry carrying structured shell state, and park/resume/dispose lifecycle |
| test | [playbook-captain.md](test/playbook-captain.md) | Integration tests for shell routing, hidden/visible Captain calls, adapter lifecycle, public shell module resolution, CODE registry wiring, status/telemetry pass-through, human-readable shell status without structured data, telemetry mirroring, park/resume, dismiss, and final disposal |

### GIT

| Group | File | Summary |
| --- | --- | --- |
| dev | [git.md](dev/git.md) | Commit message format and AI co-authorship trailers |

### LIC

| Group | File | Summary |
| --- | --- | --- |
| dev | [licensing.md](dev/licensing.md) | SPDX header requirements and file-scope rules |
| test | [licensing.md](test/licensing.md) | Copyright and license header presence checks |

### PBCODE

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-code.md](user/playbook-code.md) | `playbook-code` global/npx command: explicit-config pass-through, first-run CODE-overlay seed, existing-overlay notification migration, readiness gate, help, exit/signal behavior, and config composition (overlay + optional base → launched tmux-play config targeting `@sublang/playbook/playbook-captain`, incl. the Committer alias plus `layout` and `notifications` blocks) |
| dev | [playbook-code.md](dev/playbook-code.md) | `playbook-code` shim: cligent CLI resolution, overlay-template seeding with Codex `.git` writablePaths and notification defaults, append-only notification migration, readiness heuristic, config composition (base discovery, exact shell `captain.from`, role→`players[]` mapping, Committer-alias resolution, `theme`/`layout`/`notifications` inheritance, owned YAML serialization), Node engine floor |
| test | [playbook-code.md](test/playbook-code.md) | Integration tests for config seeding including Codex `.git` writablePaths and notification defaults, existing-overlay notification migration, no-reseed, explicit-config bypass, readiness pass/fail, unknown-adapter warning, help, and exact shell-targeted config composition |

### PBRT

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-runtime.md](user/playbook-runtime.md) | CODE Boss surface after a turn reaches CODE: free-text classification, `awaitBossReply` reply-vs-directive behavior, Captain-pane progress, and tmux-play host configuration through `@sublang/playbook/playbook-captain` with host-owned fields such as notifications plus `captain.options.code` and the Committer alias |
| dev | [playbook-runtime.md](dev/playbook-runtime.md) | CODE runtime system behavior: host-agnostic ports, free-text classifier/no slash fast path, tolerant judge-JSON parsing, session lifecycle, player binding (configurable Committer alias), captain bridge, adjudication, abort, telemetry, shell registry wiring, `@sublang/playbook/code/tmux-play` compatibility, and registry-owned `options.code` validation |
| test | [playbook-runtime.md](test/playbook-runtime.md) | Integration tests for free-text classification, tolerant judge-JSON parsing, `awaitBossReply`, status/telemetry, lifecycle, player binding, shell/CODE registry and compatibility-shim wiring, and `options.code` validation with fake ports/stubbed cligent primitives |

### PLAYBOOK

| Group | File | Summary |
| --- | --- | --- |
| dev | [playbook.md](dev/playbook.md) | CODE playbook FSM ↔ GEARS conformance contract (source agreement, transition coverage, prompt composition, Reviewer review-only and spec-checklist prompts) |
| test | [playbook.md](test/playbook.md) | Integration tests pinning the FSM ↔ GEARS conformance contract and Reviewer prompt contracts under `pnpm test` |

### RELEASE

| Group | File | Summary |
| --- | --- | --- |
| dev | [release.md](dev/release.md) | npm publish + GitHub Release workflow for `@sublang/playbook` runtime, Playbook Captain shell, and tmux-play compatibility shim (semver, changelog, tag-driven CI, OIDC trusted publishing, `latest`-tracking cligent dep) |
| test | [release.md](test/release.md) | Integration test for the published install closure: `@sublang/cligent` nested under playbook, adapter SDKs resolvable |

### SKETCH

| Group | File | Summary |
| --- | --- | --- |
| user | [sketch.md](user/sketch.md) | XState sketch visualizer: diagram and live-activity behavior |
| dev | [sketch.md](dev/sketch.md) | Architecture, telemetry protocol, and lifecycle contracts |
| test | [sketch.md](test/sketch.md) | Integration tests for diagram, telemetry derivation, and lifecycle |
