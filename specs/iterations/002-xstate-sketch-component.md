<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-002: XState Sketch Component

## Goal

Build a reusable, embeddable component under `views/sketch/` that renders an
XState v5 machine as a Sketch-style diagram and, when bound to a running actor,
highlights the current state and the most-recently-fired transition.

This complements [DR-001](../decisions/001-state-machine-tooling.md): Stately
Sketch remains the design-time visualizer/simulator and `@statelyai/inspect`
remains the external runtime monitor; this IR delivers the missing piece — a
visualization that can be **embedded in any application page** and driven by a
locally running machine.

## Design

### Modes

| Mode | API | Highlights |
| --- | --- | --- |
| Dynamic (preferred) | `mountSketch(container, { actor })` | Active state + fired transition, live |
| Dynamic, no actor | `mountSketch(container, { machine })` | Static diagram only |
| Static (script) | `npx tsx scripts/render-static.ts <machine.ts>` → `<id>.sketch.svg` + runtime helper | Page embedding the SVG drives highlights via the helper given a running actor |

`mountSketch` returns a `dispose()` handle that unsubscribes from the actor and
clears the container.

### Graph extraction

A pure function `machine → { nodes, edges }`:

- Nodes carry `id`, `parentId` (for compound/parallel states), `type`
  (`atomic | compound | parallel | final | history`), and `initial` flag.
- Edges carry `from`, `to`, `event` label, and `kind` (`external | internal | self`).
- IDs are the dotted XState path (e.g. `coding.respondToReview`) so they match
  `actor.getSnapshot().value` after normalization.

### Layout

- Use [`elkjs`](https://github.com/kieler/elkjs) (EPL-2.0) for layered layout.
- Compound states become container nodes; their children lay out within.
- Layout is async; `mountSketch` shows a placeholder until it resolves.
- Layout is computed once per machine; not on every actor transition.

### Rendering

- SVG only — no canvas, no framework.
- States: rounded rectangles, label = state id; final states get a double
  border; initial states a stub arrow from the parent.
- Transitions: polylines with arrowheads, labeled with the event name;
  self-transitions render as a loop.
- Theme is in `styles.css`; classes `.state.active` and `.transition.fired`
  drive the live look.

### Live highlighting

- `.state.active` toggles on the node matching the resolved active path of
  `snapshot.value`. For parallel regions, all active leaves get the class.
- On every transition, identify the edge `(prevState, event) → newState` and
  apply `.transition.fired` for `highlightMs` (default 600ms), then remove it.
- A reentry or self-transition still flashes the node + edge; the active class
  remains continuously applied.
- Highlighting uses CSS transitions so rapid event streams degrade gracefully
  (no layout work per event).

### Static-render script

`scripts/render-static.ts` accepts a machine module path, imports it, runs the
extraction + layout, and writes:

- `<id>.sketch.svg` — the diagram with stable element IDs (`data-state-id`,
  `data-edge-id`).
- A tiny runtime helper (`<id>.sketch.helper.js`) exporting
  `bindSketchSvg(svgEl, actor, opts?)` that subscribes to the actor and
  toggles the same CSS classes against the static SVG.

The static path is for sites that prefer not to bundle elkjs; the dynamic
component is the recommended default.

### Stack

- Vite + TypeScript (per [IR-001](001-parallel-cligents-view.md)'s stack
  choice; tsconfig and tooling can be shared if `views/` later becomes a
  workspace root).
- Peer deps: `xstate`, `@xstate/graph`.
- Direct dep: `elkjs`.
- No UI framework — the component is small enough that vanilla TS + SVG keeps
  the bundle and the API minimal.

### Layout placement

This IR places the component under `views/sketch/`. IR-001 reserves `views/`
itself as a workspace root for the parallel-cligents view; that IR may, when
implemented, hoist `views/package.json` and pull `views/sketch/` in as a
workspace member. Until then, `views/sketch/` is a standalone Vite project.

### Out of scope

- Editing the machine in the browser (Sketch's authoring features).
- Auth, multi-user sessions, persistence across reloads.
- Replacing `@statelyai/inspect` for cross-process runtime inspection.
- Time-travel / step-back through past transitions.

## Deliverables

- [ ] `views/sketch/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`.
- [ ] `views/sketch/src/sketch.ts` — exports `mountSketch`.
- [ ] `views/sketch/src/graph.ts` — machine → normalized graph.
- [ ] `views/sketch/src/layout.ts` — elkjs wrapper producing positioned nodes + edge polylines.
- [ ] `views/sketch/src/render.ts` — SVG node/edge rendering.
- [ ] `views/sketch/src/highlight.ts` — actor subscription + active/fired class management.
- [ ] `views/sketch/src/styles.css` — theme and highlight transitions.
- [ ] `views/sketch/src/main.ts` + `views/sketch/demo/coding-demo.ts` — demo page wiring `demo/sdlc/src/.playbook/coding.fsm.ts` with event-trigger buttons.
- [ ] `views/sketch/scripts/render-static.ts` — CLI emitting `<id>.sketch.svg` and a runtime helper.
- [ ] `views/sketch/README.md` — install, dynamic and static usage, screenshot.
- [ ] All files carry SPDX headers per [IR-000](000-spdx-headers.md).

## Tasks

1. **Scaffold `views/sketch/`** — Vite + TypeScript project; empty `mountSketch` export; build succeeds; SPDX headers on every text source.
2. **Graph extraction** — implement `graph.ts` with stable IDs, parent links for compound/parallel states, and event labels. Unit-tested against `coding.fsm.ts`.
3. **Layout + SVG rendering** — `layout.ts` (elkjs) + `render.ts` (SVG nodes, edges, labels) + `styles.css`. `mountSketch(container, { machine })` produces a static diagram.
4. **Live highlighting** — `highlight.ts` subscribes to an actor; toggles `.state.active` and briefly `.transition.fired`. `mountSketch(container, { actor })` shows live updates and exposes `dispose()`.
5. **Demo page** — `main.ts` + `demo/coding-demo.ts`: mount the sketch with `coding.fsm.ts`, render buttons for each Boss event, exercise the full path; visually verify highlights in the browser.
6. **Static-render script + README** — `scripts/render-static.ts` emits SVG + helper for any machine module; README covers install, both modes, and includes a screenshot of the demo page mid-run.

## Acceptance criteria

- `npm run dev` from `views/sketch/` opens a page that lays out `coding.fsm.ts` as nodes and labeled edges.
- Clicking an event button advances the actor; the corresponding state node visibly highlights and the firing transition edge highlights briefly (~600ms) before fading.
- `mountSketch(container, { machine })` renders a static diagram with no highlights and no actor subscription.
- `mountSketch(container, { actor })` returns a `dispose()` that removes the subscription and DOM nodes.
- `npx tsx views/sketch/scripts/render-static.ts <machine.ts>` writes `<id>.sketch.svg` and `<id>.sketch.helper.js`; embedding the SVG and calling `bindSketchSvg(svgEl, actor)` highlights states and transitions identically to the dynamic component.
- All `views/sketch/**` source files carry SPDX headers per [LIC-3](../items/test/licensing.md#lic-3) and [LIC-4](../items/test/licensing.md#lic-4).
- The page remains interactive (no UI freeze) under sustained transitions; layout work does not run on every event.
