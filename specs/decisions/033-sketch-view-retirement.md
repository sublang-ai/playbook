<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-033: Sketch View Retirement

## Status

Accepted.
Supersedes [DR-003](003-sketch-controlled-shell.md) and narrows [DR-001](001-state-machine-tooling.md)'s visualization scope: this repository defines and runs machines; drawing them live belongs to the host application.

## Context

- `views/sketch` was this repository's in-page XState visualizer: DR-002's three-layer Diagram/Telemetry/Binding renderer, later re-planned by DR-003 as a controlled Stately Sketch shell whose cutover never landed.
- The Spex desktop app now draws running playbooks natively in its Captain pane — live statechart cards folded from the runtime's `playbook.trace` telemetry, with the machine graph served over its own protocol — recorded there as its DR-028.
- The sketch view's load-bearing ideas moved with it: the stable edge identity (owner, event, branch, target), layout computed once per machine, active-state and fired-transition emphasis with decay.
- What remains here is a standalone demo no product surfaces, carrying its own npm tree, CI job, and spec package — maintenance without an audience.

## Decision

- `views/sketch` is removed entirely, with its CI job and its spec package (`specs/packages/sketch.md`).
- The never-landed cutover plan's intent record is disposed of with it — intent records are disposable by design.
- The runtime keeps emitting the machine-describing telemetry the host visualization rides on — `playbook.trace` with machine identity, depth, transitions, and call attribution — as the durable contract this repository owns.
- Visualization requests land on the host application's specs from now on; this repository accepts none.

## Consequences

- DR-002 and DR-003 stay as historical records; DR-003's references to the sketch package become prose, and its Status names this record.
- The repository's CI drops the `views/sketch` job; nothing else built against the view.
- The vendored demo machine (`views/sketch/demo/coding.fsm.ts`) disappears with the view; the canonical machines live under `reference/sdlc/` untouched.
