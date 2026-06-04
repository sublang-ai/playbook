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
| DR-004 | [004-link-code-fsm-to-playbook-runtime.md](decisions/004-link-code-fsm-to-playbook-runtime.md) | CODE linker/runtime bindings: baked player binding, free-text Boss-event classification with no in-playbook slash commands, adjudication, lifecycle, abort, telemetry, and tmux-play adapter wiring |
| DR-005 | [005-boss-reply-suspension-path.md](decisions/005-boss-reply-suspension-path.md) | Third Boss surface for `gears2fsm`: `awaitBossReply` quiescent state + `BOSS_REPLY` event + universal `needsBossReply` guard for captain-invoking states, so player questions suspend and resume the same state with the answer in context |
| DR-006 | [006-code-config-composition.md](decisions/006-code-config-composition.md) | CODE config via `captain.options.code` (namespaced, adapter-validated) and `playbook-code` as a composer that overlays CODE invariants onto an optional base tmux-play config; object-launcher deferred |

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

## Packages

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
| user | [playbook-code.md](user/playbook-code.md) | `playbook-code` global/npx command: explicit-config pass-through, first-run CODE-overlay seed, readiness gate, help, exit/signal behavior, and config composition (overlay + optional base → launched tmux-play config) |
| dev | [playbook-code.md](dev/playbook-code.md) | `playbook-code` shim: cligent CLI resolution, overlay-template seeding, readiness heuristic, config composition (base discovery, role→`players[]` mapping, owned YAML serialization), Node engine floor |
| test | [playbook-code.md](test/playbook-code.md) | Integration tests for config seeding, no-reseed, explicit-config bypass, readiness pass/fail, unknown-adapter warning, help, and config composition |

### PBRT

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-runtime.md](user/playbook-runtime.md) | CODE Boss surface: free-text turn classification, `awaitBossReply` reply-vs-directive behavior, Captain-pane progress, and tmux-play host configuration including the `captain.options.code` surface |
| dev | [playbook-runtime.md](dev/playbook-runtime.md) | CODE runtime system behavior: host-agnostic ports, free-text classifier/no slash fast path, session lifecycle, binding, captain bridge, adjudication, abort, telemetry, tmux-play adapter, and `captain.options.code` validation |
| test | [playbook-runtime.md](test/playbook-runtime.md) | Integration tests for free-text classification, `awaitBossReply`, status/telemetry, lifecycle, player binding, tmux-play adapter wiring, and `options.code` validation with fake ports/stubbed cligent primitives |

### PLAYBOOK

| Group | File | Summary |
| --- | --- | --- |
| dev | [playbook.md](dev/playbook.md) | CODE playbook FSM ↔ GEARS conformance contract (source agreement, transition coverage, prompt composition, Reviewer review-only prompts) |
| test | [playbook.md](test/playbook.md) | Integration tests pinning the FSM ↔ GEARS conformance contract and Reviewer review-only prompts under `pnpm test` |

### RELEASE

| Group | File | Summary |
| --- | --- | --- |
| dev | [release.md](dev/release.md) | npm publish + GitHub Release workflow for `@sublang/playbook` (semver, changelog, tag-driven CI, OIDC trusted publishing, `latest`-tracking cligent dep) |
| test | [release.md](test/release.md) | Integration test for the published install closure: `@sublang/cligent` nested under playbook, adapter SDKs resolvable |

### SKETCH

| Group | File | Summary |
| --- | --- | --- |
| user | [sketch.md](user/sketch.md) | XState sketch visualizer: diagram and live-activity behavior |
| dev | [sketch.md](dev/sketch.md) | Architecture, telemetry protocol, and lifecycle contracts |
| test | [sketch.md](test/sketch.md) | Integration tests for diagram, telemetry derivation, and lifecycle |
