<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-002: In-page XState Visualizer Architecture

## Status

Accepted

## Context

[DR-001](001-state-machine-tooling.md) adopted XState v5 + Stately Sketch + `@statelyai/inspect`:
Sketch is design-time/external, `@statelyai/inspect` is the cross-process monitor. Neither covers
the in-page, in-process visualizer gap — a component embedded directly in a host page that renders
a machine and highlights a running actor's active state and most-recently-fired transition.

The XState v5 inspect API imposes constraints any in-page visualizer must work around:

- `actor.subscribe` yields snapshots only — no event, no source, no guard.
- The `@xstate.microstep` event yields `eventType` and `transitions[].target`, but not the source
  state or matched guard.
- A single `inspect` hook receives events for every actor in the system, including invoke'd children
  (e.g., the per-state `Captain` actors in `coding.fsm.ts`). All actors share the same `rootId`, so
  `rootId` is not a usable filter.

Concrete cases the architecture must handle:

- **Branch ambiguity.** `planAndImplement.invoke.onDone` in `coding.fsm.ts` has two guarded branches
  (`singleCommitCommitted`, `iterationCommitted`) targeting `#reviewCodeCommit`.
- **Multi-target descriptors.** `target: ['#A', '#B']` is one descriptor with two destinations.
- **Parent-owned descriptors.** Multi-target transitions canonically live on the common-ancestor
  parent or machine root; an event can be matched by descriptors on multiple owners.
- **Child actor traffic.** The per-state `Captain` invokes share the inspect hook with the bound root.

## Decision

Build a vanilla TS + SVG component under `views/sketch/` that performs graph extraction + elkjs
layout + SVG rendering, with a passive inspector that filters by actor identity.

### 1. API

| Call | Highlights |
| --- | --- |
| `mountSketch(container, { actor, inspector })`; consumer wires `createActor(machine, { inspect: inspector.handle })` | Active state + fired transition |
| `mountSketch(container, { actor })` | Active state only |
| `mountSketch(container, { machine })` | Static diagram |

`mountSketch` returns idempotent `dispose()` that, in order:

1. Unsubscribes the `actor.subscribe` listener.
2. Detaches the inspector listener if any.
3. Cancels pending `.transition.fired` timers.
4. Clears the container.

The inspector is a passive event sink; attach order vs `actor.start()` does not matter.

### 2. Graph extraction

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

### 3. Layout via elkjs

`elkjs` [[1]] (EPL-2.0), layered. Compound states are containers;
children lay out within. Async; placeholder until resolved. Computed once per machine, never per
transition.

### 4. SVG rendering, no framework

SVG only — no canvas, no UI framework. States: rounded rectangles labeled by id; final = double
border; initial = stub arrow. Transitions: polylines with arrowheads, event labels;
self-transitions loop. Theme via `styles.css`; classes `.state.active`, `.transition.fired`. CSS
transitions absorb rapid event streams; no layout work per event.

### 5. Live highlighting

XState v5 does not expose a fully unique transition descriptor (see [§6 Inspect contract](#6-inspect-contract)).
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

### 6. Inspect contract

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

### 7. Stack and placement

- Vite + TypeScript, matching the broader `views/` toolchain.
- Peer deps: `xstate`, `@xstate/graph`. Dep: `elkjs`.
- No UI framework — vanilla TS + SVG keeps the bundle and API minimal.
- Component lives at `views/sketch/` so it can later be hoisted into a `views/` workspace if shared tooling emerges. Until then, `views/sketch/` is a standalone Vite project.

## Consequences

- The component complements the DR-001 stack: Stately Sketch remains design-time/external, `@statelyai/inspect` remains the cross-process monitor, and this DR fills the in-page, in-process gap.
- elkjs is a runtime dependency; consumers must bundle it.
- The inspect contract requires consumers to wire the inspector at actor creation. Inspector-less use degrades cleanly: active-state tracking still works via `actor.subscribe`; only transition highlights are lost.
- Without `disambiguate`, all candidate edges flash on guarded branches sharing `(from, event, to)` — the matcher is honest about the ambiguity rather than guessing. Consumers that can read context to narrow the branch supply `disambiguate`.
- `actorRef`-identity filtering (not `rootId`) is mandatory: any actor system that invokes children would otherwise leak child events into the bound visualizer.
- Out of scope for this architecture: authoring the machine in the browser (Sketch's editing features); auth, multi-user sessions, persistence across reloads; replacing `@statelyai/inspect` for cross-process inspection; time-travel through past transitions.

## References

[1]: https://github.com/kieler/elkjs "elkjs — EPL-2.0, layered graph layout"
