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

## Iterations

| ID | File | Goal |
| --- | --- | --- |
| IR-000 | [000-spdx-headers.md](iterations/000-spdx-headers.md) | Add SPDX headers to applicable files |
| IR-001 | [001-parallel-cligents-view.md](iterations/001-parallel-cligents-view.md) | Web view of parallel cligents with Captain orchestrating player panels |
| IR-003 | [003-sketch-controlled-shell.md](iterations/003-sketch-controlled-shell.md) | Cutover to Sketch-as-controlled-shell: fork patches, parent-side adapter, retire DR-002 renderer |
| IR-004 | [004-link-code-fsm-to-tmux-play.md](iterations/004-link-code-fsm-to-tmux-play.md) | Link CODE FSM to cligent's tmux-play Captain extension; ship `code.captain.ts` as the third compiler-phase output |

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

### SKETCH

| Group | File | Summary |
| --- | --- | --- |
| user | [sketch.md](user/sketch.md) | XState sketch visualizer: diagram and live-activity behavior |
| dev | [sketch.md](dev/sketch.md) | Architecture, telemetry protocol, and lifecycle contracts |
| test | [sketch.md](test/sketch.md) | Integration tests for diagram, telemetry derivation, and lifecycle |
