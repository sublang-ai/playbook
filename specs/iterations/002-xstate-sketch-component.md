<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-002: XState Sketch Component

## Goal

Build the XState visualizer specified by [DR-002](../decisions/002-in-page-xstate-visualizer.md): a component under `views/sketch/` factored into Diagram / Telemetry / Binding layers connected by the `SketchTelemetry` protocol. Same-page composition renders a machine as a Sketch-style diagram and, when bound to a running actor, highlights the active state and most-recently-fired transition. Cross-process deployment is out of scope for this iteration; the layers are independent so a future iteration can wire the sketch presenter against tmux-play without changing this iteration's deliverables.

The demo wires `coding.fsm.ts`, exercising its `planAndImplement → reviewCodeCommit` branch ambiguity and its per-state `Captain` child actors.

## Deliverables

- [x] `views/sketch/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`.
- [ ] `views/sketch/src/sketch.ts` — exports values `mountSketch`, `extractGraph`, `renderSketch`, `renderSketchToString`, `applySketchTelemetry`, `fromXStateActor`, `fromEventSource`; exports types `SketchTelemetry`, `SketchSource`, `SketchGraph`.
- [x] `views/sketch/src/graph.ts` — machine → graph (with `branchIndex`, `targetIndex`, `guardKey`); pure, DOM-free.
- [x] `views/sketch/src/layout.ts` — elkjs wrapper.
- [x] `views/sketch/src/render.ts` — `renderSketch(graph) → SVGSVGElement` and `renderSketchToString(graph) → string`; both produce SVG with `data-state-id`/`data-edge-id`.
- [x] `views/sketch/src/telemetry.ts` — `fromXStateActor` Telemetry-layer adapter consuming `@xstate.snapshot`/`@xstate.microstep`, emitting `SketchTelemetry` (`{ type: 'active'|'fired', seq, ... }`).
- [ ] `views/sketch/src/binding.ts` — `applySketchTelemetry`, plus `fromEventSource` (per-connection `seq` tracking, reset on reconnect).
- [ ] `views/sketch/src/styles.css` — theme.
- [ ] `views/sketch/src/main.ts` + `views/sketch/demo/coding-demo.ts` — demo wiring `coding.fsm.ts` with event-trigger buttons.
- [ ] `views/sketch/README.md` — install, usage, screenshot.
- [ ] SPDX headers on all sources per [LIC-1](../items/dev/licensing.md#lic-1) and [LIC-2](../items/dev/licensing.md#lic-2).

## Tasks

1. **Scaffold `views/sketch/`** — Vite + TS; empty exports for the public API listed in deliverables; build green; SPDX headers.
2. **Graph extraction** — `graph.ts` per [DR-002 §3](../decisions/002-in-page-xstate-visualizer.md#3-graph-extraction): stable IDs (`branchIndex`/`targetIndex`/`guardKey`), parent links, multi-target expansion, event labels. Walks every state (atomic/compound/root), assigning `edge.from = ownerState.id`.
   Unit tests use small machines constructed in-test (no cross-package imports): a branch-ambiguity machine where two guarded transitions share `(from, event, to)` yields distinct edge IDs; a parent-owned `target: ['#A', '#B']` descriptor expands into two edges sharing `branchIndex` but differing in `targetIndex`, both with `from = parent.id`.
3. **Layout + rendering** — `layout.ts` (elkjs) + `render.ts` per [DR-002 §4–5](../decisions/002-in-page-xstate-visualizer.md#4-layout-via-elkjs); both `renderSketch(graph) → SVGSVGElement` (DOM) and `renderSketchToString(graph) → string` (no DOM dependency) produce SVG with `data-state-id`/`data-edge-id`; compound parents and root render as visible containers.
   `mountSketch(container, { machine })` produces a static diagram.
   Unit test: `renderSketchToString` output, parsed by jsdom, has the same `data-state-id`/`data-edge-id` set as `renderSketch`.
4. **Telemetry layer** — `telemetry.ts` per [DR-002 §6–§7](../decisions/002-in-page-xstate-visualizer.md#6-telemetry-layer-highlight-derivation): `fromXStateActor({ machine, actor, inspector?, disambiguate?, signal? })` consumes `@xstate.snapshot`/`@xstate.microstep`, filters by `event.actorRef === boundActor` (not `rootId`), iterates `transitions[]` and `target[]` to build per-(entry × target) candidates narrowed first by "from on prev active path" then by "deepest matching owner", unions, applies `disambiguate`, and emits `SketchTelemetry` with monotone `seq`. Without an inspector, emits `active` only.
5. **Binding layer** — `binding.ts`: `applySketchTelemetry(svg, event, opts?)` toggles `.state.active`/`.transition.fired`; `fromEventSource(url)` returns a `SketchSource`, subscribes to `event: telemetry` SSE records, parses JSON, and resets per-connection `seq` tracking on disconnect/reconnect.
   `mountSketch(container, { machine | graph | svg, source?, highlightMs? })` composes the three layers via `source.subscribe(listener)`; on `dispose()` it unsubscribes and calls `source.dispose()`. Same-page convenience: `{ machine, source: fromXStateActor({ actor, inspector }) }` runs live; `dispose()` runs the three-step teardown idempotently.
6. **Demo page** — `main.ts` + `demo/coding-demo.ts`: wire `coding.fsm.ts` with `fromXStateActor`, render buttons for each Boss event, exercise `planAndImplement` ambiguity (default = both flash; with `disambiguate` = one).
7. **README** — covers install, usage, source adapters, the ambiguity model + `disambiguate`, and a mid-run screenshot.

## Acceptance criteria

- `npm run dev` from `views/sketch/` opens a page laying out `coding.fsm.ts` as nodes and labeled edges.
- Each event-button click emits an `active` event for the new state and a `fired` event for the firing edge; the binding briefly (~600ms) highlights the firing edge.
- The `planAndImplement → reviewCodeCommit` ambiguity case: both edges flash by default; `disambiguate` narrows to one.
- Multi-`transitions[]` / multi-`target[]` microsteps emit one `fired` event whose `firedEdgeIds` is the union of all per-(entry × target) candidates.
  The synthetic parent-owned `target: ['#A', '#B']` test asserts two distinct edge IDs (different `targetIndex`) within the same `fired` event, with `from = parent` (not the prev leaf).
- Deepest-owner test: a machine where parent and root both define `EVENT → #X` emits a `fired` event with only the parent edge; removing the parent descriptor causes the root edge to be emitted instead.
- Child-actor scope test (single passing test): for the demo machine, the `actorRef` filter accepts exactly the root-actor events (count = N_root); a `rootId`-only filter accepts strictly more events from the same captured stream.
- `mountSketch(container, { machine })` renders a static diagram with no source.
- `mountSketch(container, { machine, source: fromXStateActor({ actor, inspector }) })`'s `dispose()` runs the three-step teardown; double-`dispose()` is a no-op.
- `mountSketch(container, { machine, source: fromXStateActor({ actor }) })` (no inspector) emits `active` events only, no `fired`, and `dispose()` unsubscribes — verified by no further snapshot callbacks after `dispose()`.
- `seq` is monotone within one source instance; in `fromEventSource`, simulating an `EventSource` reconnect resets the binding's expected-seq state so the next connection's events are accepted regardless of their starting `seq`.
- `SketchSource` shape: a unit test asserts both `fromXStateActor` and `fromEventSource` return objects satisfying `SketchSource` (has `subscribe`, `dispose`). `subscribe` returns an unsubscribe function whose call detaches the listener. `dispose()` is idempotent; subscribing after `dispose` is a no-op.
- Latest-active retention (matcher): a unit test creates `fromXStateActor`, drives the actor through several state changes, then calls `subscribe(listener)` for the first time. The listener synchronously receives exactly one `active` event whose `activeStateIds` matches the actor's current snapshot, with a fresh (later) `seq`, before `subscribe` returns. Subscribing before any `active` has been produced delivers no synchronous callback. No stale `fired` events are ever replayed.
- Latest-active replay on connect (binding): a `fromEventSource` integration test runs against a fake SSE server that has already emitted an `active` followed by a `fired`, then a new `EventSource` connects. The first record the connection receives is the cached `active` (server side replays it before any live record); the binding applies `.state.active` to the matching node before any subsequent live event arrives. No `fired` is replayed.
- `renderSketchToString` runs in Node (no DOM globals); its output, parsed by jsdom, has the same `data-state-id`/`data-edge-id` set as `renderSketch`.
- All `views/sketch/**` sources carry SPDX headers per [LIC-3](../items/test/licensing.md#lic-3) and [LIC-4](../items/test/licensing.md#lic-4).
- The page stays interactive under sustained transitions; layout work runs once per machine, never per event.
