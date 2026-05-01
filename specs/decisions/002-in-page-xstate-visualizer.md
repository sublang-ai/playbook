<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-002: XState Visualizer Architecture

## Status

Accepted

## Context

[DR-001](001-state-machine-tooling.md) adopted XState v5 + Stately Sketch + `@statelyai/inspect`:
Sketch is design-time/external, `@statelyai/inspect` is the cross-process generic monitor. Neither
offers a state-diagram visualizer with live active-state and fired-transition highlights. The gap
exists in two deployments: same-page (machine and actor in the browser) and split-process (actor
in a Node host such as a tmux-play XState Captain, diagram in a browser).

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

A vanilla TS + SVG component under `views/sketch/`, factored into three independent layers:
**Diagram** turns a machine into SVG, **Telemetry** turns a live actor into a normalized event
stream, and **Binding** mounts the SVG and applies telemetry. Each layer is independently usable.
The Diagram layer can run anywhere the machine module is available — browser, build script,
Captain startup; the Telemetry layer must run beside the actor; the Binding layer runs in the
browser host page. Same-page composition binds them in one process; cross-process composition
(e.g., a tmux-play XState Captain) runs Diagram + Telemetry on the Captain side and ships SVG +
telemetry to the browser.

### 1. API

Public primitives:

- `extractGraph(machine) → SketchGraph` — pure machine→graph extraction (§3).
- `renderSketch(graph) → SVGSVGElement` — DOM-target render; for browser hosts (§4–§5).
- `renderSketchToString(graph) → string` — Node-target render; serializes the same SVG with `data-state-id`/`data-edge-id` for cross-process shipping (no DOM dependency).
- `applySketchTelemetry(svg, event, opts?)` — DOM class toggles for one telemetry event.
- `fromXStateActor({ machine, actor, inspector?, disambiguate?, signal? }) → SketchSource` —
  Telemetry-layer adapter; runs the matcher locally (§6–§7). Without `inspector`, emits `active` only.
- `fromEventSource(url, init?) → SketchSource` — Binding-layer adapter; subscribes to a remote
  SSE endpoint emitting `SketchTelemetry` (§8).
- `mountSketch(container, options) → { dispose() }` — convenience composition.

Source interface:

```ts
interface SketchSource {
  subscribe(listener: (event: SketchTelemetry) => void): () => void; // returns unsubscribe
  dispose(): void;                                                   // idempotent
}
```

Single-listener push.
`fired` events are never retained or replayed (transient, TTL-bounded).
Late-subscribe replay of `active` is adapter-specific:

- `fromXStateActor`: synchronously re-emits the latest `active` to the new listener with a **fresh** `seq`, then streams live. No-op when no `active` has been produced. Covers same-page late mounts and cross-process Captains that subscribe from `init(session)` before the actor produces state. No separate replay method needed.
- `fromEventSource`: forwards records as received, preserving the upstream `seq`. The presenter handles cached-active replay (§8); the binding resets its expected-`seq` tracking on each connection.

`dispose()` ends the source.

Telemetry protocol (the public rendering contract):

```ts
type SketchTelemetry =
  | { type: 'active'; seq: number; activeStateIds: string[] }
  | { type: 'fired';  seq: number; firedEdgeIds: string[]; eventType?: string; ttlMs?: number };
```

`seq` is monotone per source per connection. The Binding layer tracks the highest seen `seq`
within one connection and ignores any later event whose `seq` is not strictly greater. On
disconnect/reconnect (`fromEventSource` re-establishes the `EventSource`), the adapter resets
its tracking — the new connection is a fresh stream and may begin at any `seq`. The protocol
specifies neither replay nor persistence; if events were missed during disconnect, they stay
missed (the next `active` event re-syncs the visible state).

`mountSketch` accepts:

```ts
mountSketch(container, {
  // diagram input — exactly one of:
  machine?, graph?, svg?,
  // telemetry source — optional:
  source?: SketchSource,
  // binding option:
  highlightMs?: number,  // default 600; per-event ttlMs on `fired` overrides
});
```

Convenience matrix:

| Diagram input | Source | Result |
| --- | --- | --- |
| `machine` | `fromXStateActor({ actor, inspector })` | Same-page live diagram with active + fired highlights |
| `machine` | `fromXStateActor({ actor })` | Same-page diagram, active state only |
| `machine` | omitted | Static diagram, in-process render |
| `graph` | `fromEventSource(url)` | Pre-extracted graph, remote telemetry; binding renders |
| `svg` | `fromEventSource(url)` | Pre-rendered SVG, remote telemetry; binding only toggles classes (no elkjs/`@xstate/graph` on the binding side) |

`mountSketch` returns idempotent `dispose()` that, in order:

1. Detaches the source (cancels actor/inspector subscriptions for `fromXStateActor`; closes the
   `EventSource` for `fromEventSource`).
2. Cancels pending `.transition.fired` timers.
3. Clears the container.

### 2. Diagram layer

`extractGraph` (§3) + elkjs layout (§4) + `renderSketch` (§5) form the Diagram layer. No actor,
no inspector, no telemetry, no network. `xstate` and `@xstate/graph` are used only for machine
typing and graph traversal helpers. The layer can run in any JS host: browser at page load,
Node script at build time, or Captain at startup. The output (graph or SVG) is serializable, so
a Captain may pre-render once and ship the SVG to the browser, freeing the binding host from
bundling elkjs.

### 3. Graph extraction

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

### 4. Layout via elkjs

`elkjs` [[1]] (EPL-2.0), layered. Compound states are containers;
children lay out within. Async; placeholder until resolved. Computed once per machine, never per
transition.

### 5. SVG rendering, no framework

SVG only — no canvas, no UI framework. States: rounded rectangles labeled by id; final = double
border; initial = stub arrow. Transitions: polylines with arrowheads, event labels;
self-transitions loop. Theme via `styles.css`; classes `.state.active`, `.transition.fired`. CSS
transitions absorb rapid event streams; no layout work per event.

### 6. Telemetry layer: highlight derivation

`fromXStateActor` consumes a live actor + inspector and emits `SketchTelemetry`. It runs in the
actor's process. XState v5 does not expose a fully unique transition descriptor (see
[§7 Telemetry: inspect contract](#7-telemetry-layer-inspect-contract)); the matcher recovers what it can:

- `active` event on every snapshot: `activeStateIds` is the node(s) matching `snapshot.value` (all leaves for parallel regions).
- On each `@xstate.microstep` for the bound actor, iterate `microstep.transitions[]` and, within each, every path in `entry.target[]`.
  Resolve candidates in two steps:
  1. **Match**: `event === entry.eventType`, `to === targetPath`, `from` lies on the prev active path (leaf, any ancestor, or root).
  2. **Deepest owner**: group by `from`, keep only the group with the deepest `from` (longest dotted path).
     Mirrors XState's deepest-first selection — an ancestor descriptor never fires when a descendant has a matching one for the same event.
     Without this, a root-owned and parent-owned `EVENT → #X` would both flash.

  The kept group (possibly several edges differing in `branchIndex` for guarded ambiguity or `targetIndex` for multi-target descriptors) joins the union and is emitted as one `fired` event (carrying `eventType` for context; per-event `ttlMs` may override the binding default).
- Optional `disambiguate(prev, event, next, candidates) → edgeId | edgeId[]` narrows when context can pick the matched branch (e.g., `next.context.lastResult.guard` in `coding.fsm.ts`); invoked once per microstep.
  Without it, all candidates appear in `firedEdgeIds` — honest about the ambiguity.
- Reentries and self-transitions emit both a new `active` and a `fired`.
- `seq` is incremented per emission; the source never reorders.
- The source retains the most recent `active` event it produced as **latest-active state**.
  On every `subscribe(listener)`, it synchronously re-emits that event with a fresh `seq`
  before returning (no-op when none has been produced) — see §1 for the per-adapter rule.
  `fired` events are never retained or replayed; they are transient by design (TTL-bounded)
  and a stale replay would falsely flash an old transition.
- `signal` (AbortSignal) detaches all subscriptions and stops emission.

### 7. Telemetry layer: inspect contract

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
- Without an inspector: `active` events still emit via subscribe; no `fired` events.
- Unresolvable events (no candidate edge after filters) are no-ops, not errors.

### 8. Cross-process deployment

When the actor lives outside the browser (e.g., a tmux-play XState Captain), the Captain runs Diagram + Telemetry in its own process and publishes both through the host runtime's generic telemetry channel — for tmux-play, [DR-004](../../../cligent/specs/decisions/004-tmux-play-captain-architecture.md)'s `emitTelemetry({ topic, payload })`.
A separate **sketch presenter**, registered as a runtime observer alongside the tmux presenter, consumes the records and owns the browser-facing transport.
The Captain stays out of network plumbing; the presenter stays out of XState.

#### Captain side

DR-004's `CaptainSession` makes `emitTelemetry` session-scoped.
The Captain lives entirely in the `init` / `dispose` lifecycle — no per-turn binding.

In `init(session)`:

- Pre-render the diagram with `renderSketchToString(extractGraph(machine))` and emit it on `sketch.diagram`. The presenter caches the latest payload for late browsers.
- Start the matcher with `fromXStateActor`, passing `session.signal` so it detaches on shutdown.
- Subscribe once and forward each event on `sketch.highlight`. The fresh-`seq` initial emit (§1, §6) delivers latest-active synchronously when the actor has already produced state.

`handleBossTurn` is unaffected by sketch emission.
`Captain.dispose()` calls `source.dispose()`; per DR-004's shutdown order, the matcher has already detached via `session.signal` and emissions have drained.

Microsteps during a turn carry the active `turnId`; microsteps between turns (timers, idle work) carry `turnId: null`.
Late browsers re-sync from the presenter's cached diagram and latest-active.

#### Sketch presenter

A runtime observer that:

- Filters `captain_telemetry` by topic. Caches the latest `sketch.diagram` payload, caches
  the latest `sketch.highlight` payload of `type: 'active'` (overwriting on each new one),
  and appends each `sketch.highlight` payload to an internal in-memory queue keyed per
  connected SSE client. `fired` payloads are not cached for replay — they are transient by
  design (TTL-bounded), and replaying a stale `fired` would falsely flash an old transition.
- Returns synchronously from each observer callback after enqueuing — it does **not** block
  the runtime dispatcher on browser writes (DR-004 dispatcher contract).
- Serves a localhost HTTP endpoint with two routes:
  - `GET /` returns the visualizer page (HTML + cached SVG + a binding script that calls
    `mountSketch(container, { svg, source: fromEventSource('/events') })`).
  - `GET /events` is Server-Sent Events. On each new connection, the presenter first
    writes the cached latest `active` payload (if any) so a late-joining browser
    synchronizes with the current state immediately, then forwards subsequent live
    payloads. Each emission writes a real SSE record:

    ```text
    event: telemetry
    data: {"type":"fired","seq":42,"firedEdgeIds":["..."],"eventType":"DONE"}

    ```

    (one blank line terminator). `data:` carries one JSON-encoded `SketchTelemetry` object.
    The `seq` on the cached-active replay is the original `seq` from the source; the
    browser-side `fromEventSource` resets its expected-seq tracking on each new connection
    (§1) so this is accepted regardless of value.
- Owns its own lifecycle (binds at session startup, closes at session end). Its URL is
  surfaced by whatever wiring the host has — for tmux-play, the launcher prints it once the
  server is up; the Captain does not need to know.

`fromEventSource` subscribes to `event: telemetry` records, parses JSON, applies the per-
connection `seq` rule from §1. On EventSource disconnect/reconnect, it resets `seq` tracking
to fresh. The server does not buffer; replay and session continuity are out of scope for this
DR.

### 9. Stack and placement

- Vite + TypeScript, matching the broader `views/` toolchain.
- Peer deps: `xstate`, `@xstate/graph`. Dep: `elkjs`.
- No UI framework — vanilla TS + SVG keeps the bundle and API minimal.
- Component lives at `views/sketch/` so it can later be hoisted into a `views/` workspace if shared tooling emerges. Until then, `views/sketch/` is a standalone Vite project.

## Consequences

- The component complements the DR-001 stack: Stately Sketch remains design-time/external, `@statelyai/inspect` remains the cross-process generic monitor, and this DR fills the diagram-with-live-highlights gap for both same-page and cross-process deployments.
- `SketchTelemetry` is the public rendering contract. Diagram, Telemetry, and Binding layers are independently composable; the Diagram layer can run anywhere a machine module is available, the Telemetry layer must run beside the actor, the Binding layer runs in the browser.
- elkjs is a runtime dependency for the Diagram layer only. The Binding layer accepts a pre-rendered SVG, so cross-process deployments (Captain pre-renders) do not bundle elkjs in the browser.
- The Telemetry layer's inspect contract requires consumers to wire the inspector at actor creation. Inspector-less use degrades cleanly: `active` events still emit via `actor.subscribe`; only `fired` events are lost.
- Without `disambiguate`, all candidate edges appear in a single `fired` event on guarded branches sharing `(from, event, to)` — honest about the ambiguity rather than guessing.
- `actorRef`-identity filtering (not `rootId`) is mandatory: any actor system that invokes children would otherwise leak child events into the bound visualizer.
- Cross-process deployment splits along DR-004's coordination/presentation boundary: the Captain runs Diagram + Telemetry and emits through [DR-004](../../../cligent/specs/decisions/004-tmux-play-captain-architecture.md)'s session-scoped `emitTelemetry`, wired once in `Captain.init(session)`; a sketch presenter (runtime observer) owns SSE/HTTP transport and the browser page. The source's subscribe-time initial emit covers same-page late binders; the presenter's cached `active` covers late SSE clients. No per-turn emit binding, slot, or replay method.
- Out of scope for this architecture: authoring the machine in the browser (Sketch's editing features); auth, multi-user sessions, persistence across reloads; replacing `@statelyai/inspect` for cross-process inspection; time-travel through past transitions; SSE replay or reconnect-with-resume.

## References

[1]: https://github.com/kieler/elkjs "elkjs — EPL-2.0, layered graph layout"
