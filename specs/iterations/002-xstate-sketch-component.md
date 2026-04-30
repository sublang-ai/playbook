<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-002: XState Sketch Component

## Goal

Build the embeddable in-page XState visualizer specified by [DR-002](../decisions/002-in-page-xstate-visualizer.md): a component under `views/sketch/` that renders an XState v5 machine as a Sketch-style diagram and, when bound to a running actor, highlights the active state and most-recently-fired transition.

The demo wires `coding.fsm.ts`, exercising its `planAndImplement → reviewCodeCommit` branch ambiguity and its per-state `Captain` child actors.

## Deliverables

- [ ] `views/sketch/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`.
- [ ] `views/sketch/src/sketch.ts` — exports `mountSketch` and `createSketchInspector`.
- [ ] `views/sketch/src/graph.ts` — machine → graph (with `branchIndex`, `targetIndex`, `guardKey`).
- [ ] `views/sketch/src/layout.ts` — elkjs wrapper.
- [ ] `views/sketch/src/render.ts` — SVG nodes/edges with `data-state-id`/`data-edge-id`.
- [ ] `views/sketch/src/inspect.ts` — `createSketchInspector` consuming `@xstate.snapshot`/`@xstate.microstep`, emitting `(activeStateIds, firedEdgeIds)`.
- [ ] `views/sketch/src/highlight.ts` — applies `.state.active`/`.transition.fired`.
- [ ] `views/sketch/src/styles.css` — theme.
- [ ] `views/sketch/src/main.ts` + `views/sketch/demo/coding-demo.ts` — demo wiring `coding.fsm.ts` with event-trigger buttons.
- [ ] `views/sketch/README.md` — install, usage, screenshot.
- [ ] SPDX headers on all sources per [LIC-1](../items/dev/licensing.md#lic-1) and [LIC-2](../items/dev/licensing.md#lic-2).

## Tasks

1. **Scaffold `views/sketch/`** — Vite + TS; empty `mountSketch`/`createSketchInspector`; build green; SPDX headers.
2. **Graph extraction** — `graph.ts` per [DR-002 §2](../decisions/002-in-page-xstate-visualizer.md#2-graph-extraction): stable IDs (`branchIndex`/`targetIndex`/`guardKey`), parent links, multi-target expansion, event labels. Walks every state (atomic/compound/root), assigning `edge.from = ownerState.id`.
   Unit tests: against `coding.fsm.ts`, the two `planAndImplement → reviewCodeCommit` branches yield distinct edge IDs; against a synthetic machine with a parent-owned `target: ['#A', '#B']`, two edges share `branchIndex` but differ in `targetIndex` and both have `from = parent.id`.
3. **Layout + rendering** — `layout.ts` (elkjs) + `render.ts` (SVG) + `styles.css` per [DR-002 §3–4](../decisions/002-in-page-xstate-visualizer.md#3-layout-via-elkjs); `data-state-id`/`data-edge-id` attached; compound parents and root render as visible containers.
   `mountSketch(container, { machine })` produces a static diagram.
4. **Inspector + highlighting** — `inspect.ts` per [DR-002 §5–6](../decisions/002-in-page-xstate-visualizer.md#5-live-highlighting): consumes `@xstate.snapshot`/`@xstate.microstep`, filters by `event.actorRef === boundActor` (not `rootId`), iterates `transitions[]` and `target[]` to build per-(entry × target) candidates narrowed first by "from on prev active path" then by "deepest matching owner", unions, applies `disambiguate`.
   `highlight.ts` toggles classes.
   `mountSketch(container, { actor, inspector })` runs live; `dispose()` runs the four-step teardown idempotently.
5. **Demo page** — `main.ts` + `demo/coding-demo.ts`: wire `coding.fsm.ts` with `createSketchInspector`, render buttons for each Boss event, exercise `planAndImplement` ambiguity (default = both flash; with `disambiguate` = one).
6. **README** — covers install, usage, the inspector wiring, the ambiguity model + `disambiguate`, and a mid-run screenshot.

## Acceptance criteria

- `npm run dev` from `views/sketch/` opens a page laying out `coding.fsm.ts` as nodes and labeled edges.
- Each event-button click highlights the new active state and briefly (~600ms) the firing edge.
- The `planAndImplement → reviewCodeCommit` ambiguity case: both edges flash by default; `disambiguate` narrows to one.
- Multi-`transitions[]` / multi-`target[]` microsteps flash the union of all per-(entry × target) candidates in one `highlightMs` window.
  The synthetic parent-owned `target: ['#A', '#B']` test asserts two distinct fired edges (different `targetIndex`) within the same microstep, with `from = parent` (not the prev leaf).
- Deepest-owner test: a machine where parent and root both define `EVENT → #X` flashes only the parent edge; removing the parent descriptor causes the root edge to flash instead.
- Child-actor scope test (single passing test): for the demo machine, the `actorRef` filter accepts exactly the root-actor events (count = N_root); a `rootId`-only filter accepts strictly more events from the same captured stream.
- `mountSketch(container, { machine })` renders a static diagram with no actor wiring.
- `mountSketch(container, { actor, inspector })`'s `dispose()` runs the four-step teardown; double-`dispose()` is a no-op.
- `mountSketch(container, { actor })` (no inspector) tracks active state via subscribe, emits no transition highlights, and `dispose()` unsubscribes — verified by no further snapshot callbacks after `dispose()`.
- All `views/sketch/**` sources carry SPDX headers per [LIC-3](../items/test/licensing.md#lic-3) and [LIC-4](../items/test/licensing.md#lic-4).
- The page stays interactive under sustained transitions; layout work runs once per machine, never per event.
