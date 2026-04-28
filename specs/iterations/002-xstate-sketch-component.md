<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-002: XState Sketch Component

## Goal

An embeddable component under `views/sketch/` that renders an XState v5 machine as a Sketch-style diagram and, when bound to a running actor, highlights the active state and most-recently-fired transition.

Complements [DR-001](../decisions/001-state-machine-tooling.md): Stately Sketch is design-time; `@statelyai/inspect` is the external monitor; this IR fills the in-page, in-process visualizer gap.

## Design

### Modes

| Mode | API | Highlights |
| --- | --- | --- |
| Dynamic (preferred) | `mountSketch(container, { actor, inspector })`; consumer wires `createActor(machine, { inspect: inspector.handle })` | Active state + fired transition |
| Dynamic, no actor | `mountSketch(container, { machine })` | Static diagram |
| Static (script) | `npx tsx scripts/render-static.ts <machine.ts>` → self-contained `<id>.sketch.svg` + helper | `bindSketchSvg(svgEl, { actor, inspector })`; same inspect contract |

`mountSketch` returns idempotent `dispose()` that, in order:

1. Unsubscribes the `actor.subscribe` listener (used in both paths for active-state tracking).
2. Detaches the inspector listener if any.
3. Cancels pending `.transition.fired` timers.
4. Clears the container.

The inspector is a passive event sink; attach order vs `actor.start()` does not matter.

### Graph extraction

Pure function `machine → { nodes, edges }`:

- Nodes: `id`, `parentId`, `type` (`atomic | compound | parallel | final | history`), `initial`.
  Node id is the dotted XState path so it matches `actor.getSnapshot().value`.
- Edges: `id`, `from`, `to`, `event`, `kind` (`external | internal | self`), `branchIndex` (position in the source's transition list for that event), `targetIndex` (position in the descriptor's normalized `target[]`, `0` if single), `guardKey?` (guard name or source position).
- Edge id is `${from}::${event}::${branchIndex}::${targetIndex}` — distinguishes guarded branches sharing `(from, event, to)` and the multiple targets of one descriptor.
- Multi-target descriptors (e.g. `target: ['#A', '#B']`) **expand into one edge per target**, sharing `from`/`event`/`branchIndex`/`guardKey`, differing in `to`/`targetIndex`.
- `from` is the **state that owns the descriptor** — not necessarily a leaf.
  Multi-target transitions canonically live on the common-ancestor parent or machine root, so extraction walks every state (atomic, compound, root) and enumerates `on`/`onDone`/`after`/`always`/`invoke.onDone|onError`/etc.
  The machine root's id is the machine id (e.g., `'coding'`) — no synthetic node.
- Compound parents and the machine root render as **visible containers**; parent/root-origin edges originate from the container perimeter.
- Branch-ambiguity case in `coding.fsm.ts`: `planAndImplement.invoke.onDone` has two guarded branches (`singleCommitCommitted`, `iterationCommitted`) both targeting `#reviewCodeCommit`.

### Layout

- [`elkjs`](https://github.com/kieler/elkjs) (EPL-2.0), layered.
- Compound states are containers; children lay out within.
- Async; placeholder until resolved.
- Computed once per machine, never per transition.

### Rendering

- SVG only — no canvas, no framework.
- States: rounded rectangles labeled by id; final = double border; initial = stub arrow.
- Transitions: polylines with arrowheads, event labels; self-transitions loop.
- Theme via `styles.css`; classes `.state.active`, `.transition.fired`.

### Live highlighting

XState v5 does not expose a fully unique transition descriptor (see [Inspect contract](#inspect-contract)).
The matcher recovers what it can:

- `.state.active` toggles on the node matching `snapshot.value` (all leaves for parallel regions).
- On each `@xstate.microstep` for the bound actor, iterate `microstep.transitions[]` and, within each, every path in `entry.target[]`.
  Resolve candidates in two steps:
  1. **Match**: `event === entry.eventType`, `to === targetPath`, `from` lies on the prev active path (leaf, any ancestor, or root).
  2. **Deepest owner**: group by `from`, keep only the group with the deepest `from` (longest dotted path).
     Mirrors XState's deepest-first selection — an ancestor descriptor never fires when a descendant has a matching one for the same event.
     Without this, a root-owned and parent-owned `EVENT → #X` would both flash.

  The kept group (possibly several edges differing in `branchIndex` for guarded ambiguity or `targetIndex` for multi-target descriptors) joins the union.
  The unioned set gets `.transition.fired` for `highlightMs` (default 600ms).
- Optional `disambiguate(prev, event, next, candidates) → edgeId | edgeId[]` narrows when context can pick the matched branch (e.g., `next.context.lastResult.guard` in `coding.fsm.ts`); invoked once per microstep.
  Without it, all candidates flash — honest about the ambiguity.
- Reentries and self-transitions flash node + edge; active class stays on.
- CSS transitions absorb rapid streams; no layout work per event.

### Inspect contract

`actor.subscribe` gives only snapshots (no event, no source, no guard).
The `inspect` channel's `@xstate.microstep` gives `eventType` + `transitions[].target` but no source state or matched guard.
Therefore:

- Consumer wires the inspector at actor creation: `createActor(machine, { inspect: inspector.handle })`.
  The inspector caches the prior `@xstate.snapshot` to recover the source.
- **Scopes events by `actorRef` identity to the bound root.**
  A single `inspect` hook receives events for every actor in the system, including invoke'd children (e.g., the per-state `Captain` actors in `coding.fsm.ts`).
  The inspector captures a reference to the bound actor on attach and drops any event whose `event.actorRef !== boundActor` (equivalently, `event.actorRef.sessionId !== boundActor.sessionId`).
  **`rootId` is *not* a usable filter** — every actor in the system tree shares it, so a `rootId === boundSessionId` comparison would let every Captain child event through.
  Child snapshots, child microsteps, and `@xstate.actor` lifecycle events for children are dropped silently.
- Without an inspector: active-state tracking via subscribe still works; no `.transition.fired` highlights.
- Unresolvable events (no candidate edge after filters) are no-ops, not errors.

### Static-render script

`scripts/render-static.ts` imports a machine module, runs extraction + layout, and writes:

- `<id>.sketch.svg` — diagram with `data-state-id`/`data-edge-id` and an inlined `<style>` block carrying the default theme, so the file is self-contained; consumers override via a higher-specificity stylesheet.
- `<id>.sketch.helper.js` — exports `bindSketchSvg(svgEl, { actor, inspector? }, opts?)`, using the same inspect contract as `mountSketch`.

For sites that prefer not to bundle elkjs; the dynamic component is the recommended default.

### Stack

- Vite + TypeScript (per [IR-001](001-parallel-cligents-view.md); shareable if `views/` becomes a workspace root).
- Peer deps: `xstate`, `@xstate/graph`. Dep: `elkjs`.
- No UI framework — vanilla TS + SVG keeps the bundle and API minimal.

### Layout placement

Component lives at `views/sketch/`.
IR-001 reserves `views/` as a workspace root; that IR may later hoist `views/package.json` and pull `views/sketch/` in as a member.
Until then, `views/sketch/` is a standalone Vite project.

### Out of scope

- Authoring the machine in the browser (Sketch's editing features).
- Auth, multi-user sessions, persistence across reloads.
- Replacing `@statelyai/inspect` for cross-process inspection.
- Time-travel through past transitions.

## Deliverables

- [ ] `views/sketch/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`.
- [ ] `views/sketch/src/sketch.ts` — exports `mountSketch` and `createSketchInspector`.
- [ ] `views/sketch/src/graph.ts` — machine → graph (with `branchIndex`, `targetIndex`, `guardKey`).
- [ ] `views/sketch/src/layout.ts` — elkjs wrapper.
- [ ] `views/sketch/src/render.ts` — SVG nodes/edges with `data-state-id`/`data-edge-id`.
- [ ] `views/sketch/src/inspect.ts` — `createSketchInspector` consuming `@xstate.snapshot`/`@xstate.microstep`, emitting `(activeStateIds, firedEdgeIds)`.
- [ ] `views/sketch/src/highlight.ts` — applies `.state.active`/`.transition.fired`.
- [ ] `views/sketch/src/styles.css` — theme; **also exported as a string for static inlining**.
- [ ] `views/sketch/src/main.ts` + `views/sketch/demo/coding-demo.ts` — demo wiring `coding.fsm.ts` with event-trigger buttons.
- [ ] `views/sketch/scripts/render-static.ts` — CLI emitting SVG + helper.
- [ ] `views/sketch/README.md` — install, both modes, screenshot.
- [ ] SPDX headers on all sources per [IR-000](000-spdx-headers.md).

## Tasks

1. **Scaffold `views/sketch/`** — Vite + TS; empty `mountSketch`/`createSketchInspector`; build green; SPDX headers.
2. **Graph extraction** — `graph.ts` with stable IDs (`branchIndex`/`targetIndex`/`guardKey`), parent links, multi-target expansion, event labels.
   Walks every state (atomic/compound/root), assigning `edge.from = ownerState.id`.
   Unit tests: against `coding.fsm.ts`, the two `planAndImplement → reviewCodeCommit` branches yield distinct edge IDs; against a synthetic machine with a parent-owned `target: ['#A', '#B']`, two edges share `branchIndex` but differ in `targetIndex` and both have `from = parent.id`.
3. **Layout + rendering** — `layout.ts` (elkjs) + `render.ts` (SVG) + `styles.css`; `data-state-id`/`data-edge-id` attached; compound parents and root render as visible containers.
   `mountSketch(container, { machine })` produces a static diagram.
4. **Inspector + highlighting** — `inspect.ts` consumes `@xstate.snapshot`/`@xstate.microstep`, filters by `event.actorRef === boundActor` (not `rootId`), iterates `transitions[]` and `target[]` to build per-(entry × target) candidates narrowed first by "from on prev active path" then by "deepest matching owner", unions, applies `disambiguate`.
   `highlight.ts` toggles classes.
   `mountSketch(container, { actor, inspector })` runs live; `dispose()` runs the four-step teardown idempotently.
5. **Demo page** — `main.ts` + `demo/coding-demo.ts`: wire `coding.fsm.ts` with `createSketchInspector`, render buttons for each Boss event, exercise `planAndImplement` ambiguity (default = both flash; with `disambiguate` = one).
6. **Static-render script + README** — `scripts/render-static.ts` emits self-contained SVG + helper.
   Smoke test: load SVG into a fresh page (no extra stylesheet); class toggles produce visible color changes.
   README covers install, both modes, the inspector wiring, the ambiguity model + `disambiguate`, and a mid-run screenshot.

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
- `npx tsx views/sketch/scripts/render-static.ts <machine.ts>` writes a self-contained SVG + helper; embedding only those two files (no extra stylesheet) and calling `bindSketchSvg(svgEl, { actor, inspector })` produces highlights identical to the dynamic component.
- All `views/sketch/**` sources carry SPDX headers per [LIC-3](../items/test/licensing.md#lic-3) and [LIC-4](../items/test/licensing.md#lic-4).
- The page stays interactive under sustained transitions; layout work runs once per machine, never per event.
