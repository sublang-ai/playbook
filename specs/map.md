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
| DR-004 | [004-link-code-fsm-to-playbook-runtime.md](decisions/004-link-code-fsm-to-playbook-runtime.md) | CODE playbook linker bindings (player binding, Boss-event mapping, adjudication, session lifecycle, captain bridge, abort) and tmux-play host adapter wiring |
| DR-005 | [005-boss-reply-suspension-path.md](decisions/005-boss-reply-suspension-path.md) | Third Boss surface for `gears2fsm`: `awaitBossReply` quiescent state + `BOSS_REPLY` event + `needsBossReply` opt-in guard, so player questions suspend and resume the same state with the answer in context |

## Iterations

| ID | File | Goal |
| --- | --- | --- |
| IR-000 | [000-spdx-headers.md](iterations/000-spdx-headers.md) | Add SPDX headers to applicable files |
| IR-001 | [001-parallel-cligents-view.md](iterations/001-parallel-cligents-view.md) | Web view of parallel cligents with Captain orchestrating player panels |
| IR-003 | [003-sketch-controlled-shell.md](iterations/003-sketch-controlled-shell.md) | Cutover to Sketch-as-controlled-shell: fork patches, parent-side adapter, retire DR-002 renderer |
| IR-004 | [004-link-code-fsm-to-playbook-runtime.md](iterations/004-link-code-fsm-to-playbook-runtime.md) | Compile CODE FSM into `code.playbook.ts` per `slc/link.md` and DR-004; ship the in-repo tmux-play adapter `code.tmux-play.ts` |
| IR-005 | [005-code-playbook-conformance-tests.md](iterations/005-code-playbook-conformance-tests.md) | Conformance tests pinning `code.fsm.ts` to `code.gears.md` (every CODE-N, every edge, every prompt) — replaces the dropped manual acceptance runbook |
| IR-006 | [006-boss-reply-suspension-path.md](iterations/006-boss-reply-suspension-path.md) | Implemented DR-005 end to end: `awaitBossReply` / `BOSS_REPLY` / `needsBossReply` suspension-resume path across specs, CODE gears/FSM/runtime, status/telemetry, and conformance/prompt/runtime tests |
| IR-008 | [008-universal-boss-reply.md](iterations/008-universal-boss-reply.md) | Plan universal Boss-reply suspension for every captain-invoking state, removing IR-007's source annotation and moving `needsBossReply` wiring out of GEARS metadata into `gears2fsm` |

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

### PBRT

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-runtime.md](user/playbook-runtime.md) | CODE playbook runtime Boss surface: turn input, turn progress, tmux-play host configuration |
| dev | [playbook-runtime.md](dev/playbook-runtime.md) | CODE playbook runtime system behavior: module boundary, session lifecycle, classification, binding, captain bridge, adjudication, abort, telemetry, tmux-play adapter |
| test | [playbook-runtime.md](test/playbook-runtime.md) | Integration tests driving the runtime and tmux-play adapter against fake ports and stubbed cligent primitives |

### PLAYBOOK

| Group | File | Summary |
| --- | --- | --- |
| dev | [playbook.md](dev/playbook.md) | CODE playbook FSM ↔ GEARS conformance contract (source agreement, transition coverage, prompt composition) |
| test | [playbook.md](test/playbook.md) | Integration tests pinning the FSM ↔ GEARS conformance contract under `pnpm test` |

### RELEASE

| Group | File | Summary |
| --- | --- | --- |
| dev | [release.md](dev/release.md) | npm publish + GitHub Release workflow for `@sublang/playbook` (semver, changelog, tag-driven CI, OIDC trusted publishing) |

### SKETCH

| Group | File | Summary |
| --- | --- | --- |
| user | [sketch.md](user/sketch.md) | XState sketch visualizer: diagram and live-activity behavior |
| dev | [sketch.md](dev/sketch.md) | Architecture, telemetry protocol, and lifecycle contracts |
| test | [sketch.md](test/sketch.md) | Integration tests for diagram, telemetry derivation, and lifecycle |
