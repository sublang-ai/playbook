<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-003: Sketch Controlled Shell Cutover

## Goal

Implement the runtime XState visualizer specified by
[DR-003](../decisions/003-sketch-controlled-shell.md): a forked self-hosted
Stately Sketch driven by a parent-side adapter via a typed postMessage
protocol. Retire DR-002's custom Diagram/Telemetry/Binding stack
(`views/sketch/src/{graph,layout,render,binding,sketch,telemetry,styles.css}`,
`elkjs` dep, screenshot capture script) and the demo wiring built on top of
it. Update the SKETCH spec package to reflect the new contracts.

The cutover is the *replacement* of DR-002's renderer. The Captain machine
(`coding.fsm.ts`), the Boss-event/Captain-output demo controls, and the
overall left-pane visualizer + right-pane app shell layout survive in shape;
only the visualizer renderer and its telemetry transport change.

## Deliverables

### Sketch fork (six patches; ~150 LOC)

- [ ] **Patch 1** — `src/lib/store.ts`: add `setLiveActiveIds`,
  `flashTransitions`, `clearFiredTransitions` reducers; extend context with
  `firedTransitionIds: Set<string>`.
- [ ] **Patch 2** — `src/components/StateNodeViz.tsx`: relax the
  `(isAtomic || isFinal)` gate from the `data-sim-active` attribute and the
  active-styling class so compound containers render active when in
  `simActiveIds`.
- [ ] **Patch 3** — `src/routes/__root.tsx`: install an origin-checked
  `window.addEventListener('message', …)` that dispatches a typed
  `sketch:*` protocol into `appStore.trigger.<reducer>()`, and posts a
  `sketch:ready` frame to its parent on mount.
- [ ] **Patch 4** — `src/components/TransitionViz.tsx`: read
  `firedTransitionIds` and apply a `data-fired` attribute with a CSS
  transition for decay; visual style matches the `.transition.fired`
  emphasis we had in DR-002.
- [ ] **Patch 5** — `src/components/AppLayout.tsx`: `?iframe=true`
  query-param check that hides header, share/sign-in/help controls, footer,
  and editor toggle. Acceptance: `?iframe=true` renders only the
  `MachineViz` + `SimulationPanel` panes.
- [ ] **Patch 6** — `src/lib/machine.ts`: in `addTransitionGroup`, expand
  `transition.target?.[]` into one edge per target; emit ids in the format
  `${stateId}:${eventType}:${branchIndex}:${targetIndex}`. Targetless
  transitions preserve current self-edge behavior with `targetIndex: 0`.

### Repo additions

- [ ] **Vendor or reference the Sketch fork.** Either commit the fork as a
  git submodule under `views/sketch-fork/`, or reference a published-but-
  pinned npm tarball. Decision deferred to first task in §Tasks; either is
  compatible with this IR.
- [ ] **Parent-side adapter** (`views/sketch/src/adapter.ts`, ~80 LOC).
  Subscribes to `actor.system.inspect` with `event.actorRef === boundActor`
  filter; emits postMessage frames to a target iframe. Caches latest active
  ids; replays them on inbound `sketch:ready`. Builds a
  `TransitionDefinition`-keyed edge-id index from the machine. Bounded
  fired-set with TTL decay. Explicit `start(actor, iframe)` /
  `dispose()` lifecycle.
- [ ] **Demo update** (`views/sketch/demo/coding-demo.ts`). Reuses existing
  Boss-event and Captain-output button rendering; replaces `mountSketch`
  call with iframe creation + adapter wiring.
- [ ] **Demo shell** (`views/sketch/index.html` and `src/main.ts`). Two-pane
  grid; left pane is the iframe pointed at the Sketch fork's
  `?iframe=true&mode=viz` route; right pane is the existing controls.
- [ ] **README update**. Drop references to elkjs, the SVG renderer, and the
  screenshot capture; document the iframe shell + adapter wiring; document
  how to run the Sketch fork locally.

### Repo deletions

- [ ] `views/sketch/src/graph.ts`, `graph.test.ts`.
- [ ] `views/sketch/src/layout.ts`, `layout.test.ts`.
- [ ] `views/sketch/src/render.ts`, `render.test.ts`.
- [ ] `views/sketch/src/binding.ts`, `binding.test.ts` (replaced by adapter).
- [ ] `views/sketch/src/telemetry.ts`, `telemetry.test.ts` (replaced by
  adapter).
- [ ] `views/sketch/src/sketch.ts` (public re-export module).
- [ ] `views/sketch/src/styles.css` (DR-002's SVG theme).
- [ ] `views/sketch/scripts/capture-mid-run.ts` and
  `views/sketch/docs/coding-fsm-mid-run.svg` (DR-002 screenshot generator
  and output).
- [ ] `elkjs` dependency in `views/sketch/package.json`.
- [ ] `@types/jsdom`/`jsdom` devDependencies if no longer referenced.

### Spec updates (SKETCH package)

- [ ] **`specs/user/sketch.md`** — items survive in spirit:
  - SKETCH-1 (render): unchanged.
  - SKETCH-2 (active state): unchanged.
  - SKETCH-3 (fired transitions): unchanged.
  - SKETCH-4 (ambiguity): user-visible behavior unchanged; **drop the
    `disambiguator` mention** since the firing event resolves ambiguity at
    the source.
  - SKETCH-5 (late-mount current state): unchanged.
- [ ] **`specs/dev/sketch.md`** — substantive changes:
  - SKETCH-6 (separable layers): reframe — the layers are now Diagram
    (Sketch fork) / Adapter (parent) / Binding (postMessage). Cross-process
    splittability survives.
  - SKETCH-7 (DOM-free production): **drop**. Sketch is React/DOM;
    cross-process deployment renders in the browser.
  - SKETCH-8 (telemetry kinds + monotone seq): reframe to the postMessage
    subset; keep the two event kinds (`active`, `fired`) at the protocol
    level; **drop** the seq-monotonicity requirement (in-page postMessage
    is ordered).
  - SKETCH-9 (seq reset on reconnect): **drop**. Replaced by `sketch:ready`
    replay of cached `latestActiveIds`.
  - SKETCH-10 (latest-active retention; no fired replay): unchanged in
    spirit; lives in the parent-side adapter.
  - SKETCH-11 (actorRef-identity filter): unchanged.
  - SKETCH-12 (deepest-owner): reframe — "the visualizer shall reflect
    XState's transition selection; deepest-owner is an observed
    consequence, not implemented logic."
  - SKETCH-13 (no-inspector → active only): **drop**. `actor.system.inspect`
    always exists; there is no separate inspector concept.
  - SKETCH-14 (dispose three-step): retain; reframe to the adapter's
    teardown (unsubscribe inspect; clear decay timers; drain fired set).
- [ ] **`specs/test/sketch.md`** — drop tests verifying retired items
  (T for SKETCH-9, SKETCH-13, SKETCH-7); update Verifies citations on
  reframed items; keep the integration tests for SKETCH-1..5, SKETCH-10..12,
  SKETCH-14.
- [ ] **`specs/map.md`** — add IR-003 row; the SKETCH package summary
  remains accurate.

## Tasks

Each task is a commit. Tasks are ordered to keep `main` building at every
commit; the deletions land *after* the adapter ships.

1. **Decide Sketch-fork strategy** (no code change yet; record the
   decision in this IR's Goal section if needed). Submodule
   `views/sketch-fork/` vs published-pinned tarball. Either choice supports
   the rest of the IR; submodule is preferred for spike-local maintenance,
   tarball for downstream packaging.
2. **Apply Patches 1–3** to the Sketch fork (the architectural patches the
   spike already validated). Push to a `dr003/controlled-shell` branch on
   the fork. Each patch is a small commit on the fork.
3. **Apply Patch 4** (TransitionViz fired-edge styling). Verify by manual
   `flashTransitions({ ids: ['planAndImplement:xstate.done.actor.0:0:0'] })`
   call from devtools console; observe the styled edge.
4. **Apply Patch 5** (`?iframe=true` chrome suppression). Verify
   `http://localhost:3000/?iframe=true` renders only the visualizer + sim
   panel.
5. **Apply Patch 6** (`machineToGraph` multi-target expansion). Add a unit
   test in the Sketch fork's `machine.test.ts` against a synthetic
   `target: ['#a', '#b']` machine; assert two distinct edges with stable
   ids carrying `branchIndex`/`targetIndex`. Verify `coding.fsm.ts` still
   produces 18 nodes / now-larger-or-equal-than-108 edge count.
6. **Vendor the Sketch fork** into the repo per task 1's decision.
7. **Author the parent-side adapter** at `views/sketch/src/adapter.ts`.
   Implement `start(actor, iframe)` returning `{ dispose() }`. Microstep
   handler iterates `_transitions[]` and looks up the edge id in a
   `TransitionDefinition`-keyed index built once per machine. Snapshot
   handler caches `latestActiveIds`. `sketch:ready` listener replays the
   cache. Bounded fired-set with `setTimeout`-driven `clearFiredTransitions`
   posting.
8. **Author adapter tests** at `views/sketch/src/adapter.test.ts`. Drive a
   small XState machine through guarded sibling branches; assert posted
   `setLiveActiveIds` and `flashTransitions` payloads include the right
   ids and the right indices. Use a fake postMessage target.
9. **Update demo shell** — `views/sketch/index.html`, `src/main.ts`,
   `demo/coding-demo.ts`. Replace `mountSketch` with iframe + adapter wiring.
   Confirm `npm run dev` opens a working two-pane page; user can drive
   `coding.fsm.ts` end-to-end via the existing Boss/Captain buttons.
10. **Delete DR-002 renderer files** in one sweep commit:
    `views/sketch/src/{graph,layout,render,binding,sketch,telemetry}.{ts,test.ts}`,
    `views/sketch/src/styles.css`, `views/sketch/scripts/capture-mid-run.ts`,
    `views/sketch/docs/coding-fsm-mid-run.svg`. Drop `elkjs`, jsdom from
    `package.json`. Update `tsconfig` if needed. Run `npm test` to confirm
    only adapter tests remain and pass.
11. **Update README** — install, two-pane usage, adapter wiring, how to run
    the Sketch fork locally. Drop the elkjs / SVG / screenshot sections.
12. **Spec deltas (single commit)** — update
    `specs/{user,dev,test}/sketch.md` per the deliverable list; update
    `specs/map.md`. Mark IR-003 deliverables progressively as the IR lands.

## Acceptance criteria

- `npm run dev` from `views/sketch/` opens a two-pane page. The left pane is
  the Sketch fork iframe rendering `coding.fsm.ts` in card layout. The right
  pane is the existing Boss/Captain controls.
- Click `START_CODING`. The active-state highlight transitions from `ready`
  to `planAndImplement` (compound parent + leaf both styled active per
  Patch 2). The transition `coding:START_CODING:0:0` flashes briefly and
  decays.
- Resolve the Captain promise with `singleCommitCommitted`. Active state
  transitions to `reviewCodeCommit`; the
  `planAndImplement:xstate.done.actor.0.planAndImplement:0:0` edge flashes.
  No false flash on the `iterationCommitted` edge — XState's selection is
  the only edge that flashes; no DR-002 disambiguator needed.
- Iframe reload (Cmd-R in the iframe's devtools or programmatic reload):
  the active state immediately re-syncs to the parent's
  `latestActiveIds`. No fired flash replays.
- Switch the iframe's `?mode=` to `explore` (or via a `sketch:setMode`
  message): clicking a transition in the iframe walks the local simulator
  via Sketch's existing `simSend`; switching back to `live` resyncs to the
  parent's truth on the next snapshot.
- The synthetic multi-target test machine produces two distinct edges with
  stable ids; both flash when the firing event matches both target paths.
- Adapter `dispose()` unsubscribes inspect, clears decay timers, and drains
  the bounded fired set. Double-`dispose()` is a no-op.
- **Live-telemetry frames carry id-only payloads.** Verified by
  console-logging every received `MessageEvent` in the iframe in live
  mode and asserting that frames whose type is `sketch:setLiveActiveIds`,
  `sketch:flashTransitions`, or `sketch:clearFiredTransitions` carry
  payloads of shape `{ ids: string[] }` (plus `ttlMs?: number` for
  flash). No actor context, no runtime event payloads, appear in any
  live-telemetry frame. **Setup frames** (`sketch:loadCode`) carry the
  machine source string by necessity; **explore-mode frames**
  (`sketch:simSend`) carry user-authored event objects. Both are
  separately allowed by DR-003 and do not violate the live-telemetry
  rule.
- All `views/sketch/**` and Sketch-fork patch sources carry SPDX headers per
  [LIC-1](../dev/licensing.md#lic-1) and
  [LIC-2](../dev/licensing.md#lic-2).
- After Task 10's deletion sweep, `npm run build` and `npm test` succeed
  with no references to the retired modules.
