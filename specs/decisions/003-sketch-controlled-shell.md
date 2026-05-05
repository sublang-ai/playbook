<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-003: Sketch as a Controlled Visual Shell

## Status

Accepted. Supersedes [DR-002](002-in-page-xstate-visualizer.md).

## Context

[DR-001](001-state-machine-tooling.md) adopted Stately Sketch [[1]] (MIT,
self-hostable) for design-time visualization and `@statelyai/inspect` [[2]] for
runtime monitoring. [DR-002] then built a custom in-page visualizer
(`views/sketch/`) because neither off-the-shelf tool offered diagram-with-live-
highlights for runtime actors.

After DR-002 shipped, evaluation reopened on two questions: whether DR-002's
custom rendering was the right choice given upstream evolution, and whether
self-hostable upstream UIs could be reused.

Findings:

- **Stately Inspector UI is closed-source.** `https://stately.ai/inspect` is an
  internal route inside Stately Studio's Next.js cloud bundle. Confirmed by
  enumerating `statelyai/*` GitHub repos (no `/inspect` route in `sketch`,
  `xstate-viz` archived, `inspect` is protocol-only) and `@statelyai/*` npm
  scope (8 packages, all protocol/SDK/utility code, none ships a UI bundle).
  No Docker image. There is no equivalent of DR-001's Sketch self-host pattern
  for the runtime Inspector UI.
- **Stately Cloud is excluded by privacy policy.** `@statelyai/sdk/inspect`
  ships the raw triggering event in every `@statelyai.system.actorSnapshot`
  frame, including Captain prompts under `event.input.prompt`. The SDK has no
  `serializeEvent` hook (only `serializeSnapshot` and `extractMachineConfig`).
  Cloud-hosted Inspector with redaction is materially harder than a flag.
- **Stately Sketch is reusable as a controlled shell.** Its appStore exposes
  `simSend`, and its rendering subscribes to `simActiveIds` via `useSelector`.
  A small postMessage patch turns Sketch into a remotely-driven visual shell.
  A spike validated this end-to-end: `coding.fsm.ts` parses cleanly via
  Sketch's `parseCode`, the live-truth path (parent actor → setLiveActiveIds
  → Sketch render) works without replay drift, and a side-by-side visual
  comparison of `coding.fsm.ts` rendered by DR-002's elkjs arrow diagram vs
  Sketch's card layout judged the latter materially better.
- **XState v5's `actor.system.inspect` carries everything we need.**
  `@xstate.snapshot` events expose the firing event verbatim;
  `@xstate.microstep` events expose the post-selection `_transitions[]`
  (XState has already performed deepest-owner selection and guard matching).
  This obsoletes DR-002's matcher: the parent-side adapter no longer
  reconstructs from microstep candidates and no longer needs a disambiguator
  callback. SKETCH-12 (deepest-owner) becomes an observed consequence rather
  than implemented behavior.
- **Microsteps remain load-bearing for fired-edge truth.** Snapshots collapse
  macrosteps (e.g. `event E → microstep E→A → microstep (always) A→B →
  snapshot at B`). Snapshot-only matching loses the always edge. The adapter
  must consume both `@xstate.snapshot` (for active state) and
  `@xstate.microstep._transitions` (for fired edges).

## Decision

Adopt **Stately Sketch as a controlled visual shell** for runtime XState
visualization. The architecture has three parts:

1. **Forked, self-hosted Sketch** with a small additive patch ledger (~150
   LOC, six files; all spike-validated for the architectural items).
2. **Parent-side adapter** (~80 LOC) that subscribes to
   `actor.system.inspect`, derives active-state ids and fired-edge ids, and
   emits a typed postMessage protocol.
3. **postMessage protocol** between parent and iframe — origin-checked,
   with explicit `ready`/`dispose` lifecycle. Live-telemetry frames carry
   id-only payloads (the privacy-load-bearing rule); setup frames
   (`loadCode`) and explore-mode frames (`simSend`) carry richer payloads
   and are scoped separately (see §2).

### 1. Topology

```text
Parent app process
  ┌─ XState actor (machine + actor + Captain children)
  ┌─ Sketch parent-side adapter
  │    actor.system.inspect((event) => …)
  │      filtered: event.actorRef === boundActor          // SKETCH-11
  │      @xstate.snapshot   → activeIds + cache → post sketch:setLiveActiveIds
  │      @xstate.microstep  → _transitions → edge-id index → post sketch:flashTransitions
  │    on adapter.start():
  │      actor.getSnapshot() → cache + post sketch:setLiveActiveIds
  │    on inbound sketch:ready:
  │      re-post cached latestActiveIds                   // late-mount replay
  │    fired events are never replayed                    // SKETCH-10 retention rule survives
  └─ <iframe src="…/?iframe=true&mode=viz"> (controlled Sketch)
       postMessage receiver in __root.tsx →
         appStore.trigger.<setLiveActiveIds | flashTransitions | …>
       StateNodeViz reads simActiveIds (compound parents included)
       TransitionViz reads firedTransitionIds with TTL-decayed CSS class
```

### 2. PostMessage protocol

| Direction | Type | Payload | Purpose |
| --- | --- | --- | --- |
| iframe → parent | `sketch:ready` | `{}` | iframe announces mount/reload; parent re-posts cached active state |
| parent → iframe | `sketch:loadCode` | `{ code: string, format?: string }` | load machine source (tsBlankSpace + new Function sandbox) |
| parent → iframe | `sketch:setLiveActiveIds` | `{ ids: string[] }` | overwrite active-state set; ids include leaves and ancestors so compound parents render active |
| parent → iframe | `sketch:flashTransitions` | `{ ids: string[], ttlMs?: number }` | add ids to fired-transition set; consumer styling decays via CSS transition |
| parent → iframe | `sketch:clearFiredTransitions` | `{ ids: string[] }` | remove ids after the parent's TTL fires |
| parent → iframe | `sketch:startSim`/`stopSim`/`restartSim` | `{}` | enter/leave Sketch's simulator; explore-mode toggle |
| parent → iframe | `sketch:simSend` | `{ event: AnyEventObject }` | explore-mode click forward; live mode does not use this |
| parent → iframe | `sketch:setMode` | `{ mode: 'live' \| 'explore' }` | gate iframe-side click handlers; live mode disables clicks or forwards them as parent commands |

**Live-telemetry frames** (`sketch:setLiveActiveIds`, `sketch:flashTransitions`,
`sketch:clearFiredTransitions`) carry only state-id and edge-id arrays — no
actor context, no runtime event payloads cross the iframe boundary. This is
the privacy-load-bearing rule: live-actor data (Captain prompts, contexts,
event payloads) never leaves the parent process via this protocol.

**Setup frames** (`sketch:loadCode`) carry the machine source string by
necessity — Sketch parses the same text it would parse from any code-load
flow. This is configuration data, not live actor data.

**Explore-mode frames** (`sketch:simSend`) carry user-driven event objects
the human deliberately authors in the iframe for hypothetical exploration;
they never reflect a running actor's events. Live mode (the production
default) does not use `sketch:simSend`.

Origin is pinned in production (parameterized for the spike).

### 3. Edge-id index

The parent's adapter and Sketch's `machineToGraph` agree on a 4-segment edge id:
`${stateId}:${eventType}:${branchIndex}:${targetIndex}`.

This preserves enough information to disambiguate guarded sibling branches
that target the same state — the case DR-002's disambiguator was meant to
handle. Sketch's upstream `machineToGraph` collapses to `${state}:${event}:
${index}` and only emits `transition.target?.[0]?.id`; both gaps are closed by
the patch ledger (see Consequences). The adapter's index is keyed by
`TransitionDefinition` reference (or its `(stateNode, eventType, branchIndex,
targetIndex)` tuple), not by `(source, event, target)`, so microstep
`_transitions[]` resolve to the exact edge XState selected.

### 4. Sketch fork patch ledger

Additive to DR-001's existing `AppLayout.tsx` cloud-only-UI patch. All sized
against current `statelyai/sketch`:

| # | File | LOC | Purpose |
| --- | --- | --- | --- |
| 1 | `src/lib/store.ts` | ~30 | New reducers `setLiveActiveIds`, `flashTransitions`, `clearFiredTransitions`; new context field `firedTransitionIds: Set<string>` |
| 2 | `src/components/StateNodeViz.tsx` | 2 | Drop the `(isAtomic \|\| isFinal)` gate from the `data-sim-active` attribute and the `border-primary bg-primary/10` class so compound containers render active |
| 3 | `src/routes/__root.tsx` | ~70 | `useSpikePostMessageReceiver` hook with origin check, ready announcement, and trigger dispatch |
| 4 | `src/components/TransitionViz.tsx` | ~10 | Read `firedTransitionIds` and apply a `data-fired` attribute with CSS transition for decay |
| 5 | `src/components/AppLayout.tsx` | ~20 | `?iframe=true` query-param check that hides header / share / sign-in / help / footer / editor toggle |
| 6 | `src/lib/machine.ts` | ~15 | Expand `transition.target?.[]` to one edge per target; emit 4-segment edge ids carrying `branchIndex` and `targetIndex` |

Net: ~150 LOC across 6 files. Items 1–3 were validated end-to-end in a
throwaway spike: a real XState actor driving `coding.fsm.ts` through
`ready → planAndImplement → reviewCodeCommit` was wired into a forked
Sketch via patches 1–3; the parent's `setLiveActiveIds` calls populated
`appStore.context.simActiveIds = ['reviewCodeCommit', 'coding']` (leaf
plus ancestor) without engaging Sketch's replay simulator
(`simEvents.length` stayed at 1 — the initial `xstate.init` from
`startSim`); a sample edge id `planAndImplement:xstate.done.actor.0:0`
flowed cleanly through `flashTransitions` into `firedTransitionIds`. The
forked-Sketch `pnpm build` succeeded with all three patches applied.
Items 4–6 are sized but not yet executed; they land as cutover task
commits.

### 5. What we borrow from `@statelyai/inspect` / `@statelyai/sdk`

**Patterns, not the package.** No `@statelyai/sdk` or `@statelyai/inspect`
runtime dependency. Reasons: their WebSocket/cloud transport doesn't apply to
in-page iframe; their `inspector.actors` map and machineConfig serialization
target the Stately Inspector UI which Sketch's shell doesn't render; the
SDK + `createInspectorServer` pair is incompatible at the handshake level
(spike-confirmed). What we adopt:

- `actor.system.inspect((event) => …)` as the parent-side telemetry hook
  (XState-native; the SDK uses the same hook).
- The principle that microstep `_transitions[]` is the authoritative
  fired-edge source — XState has already performed deepest-owner selection
  and guard matching.
- Filter-style actor scoping (`event.actorRef === boundActor`).
- The discipline of id-only wire payloads.

Deferred / not in MVP:

- `sanitizeEvent`/`sanitizeContext` redaction hooks. Production payloads stay
  id-only; if a future feature ships context preview into the iframe, hooks
  land then.
- Optional dev-only `@statelyai/inspect` tee (off by default; sanitized).
- SDK actor-tree adoption (root focus, child relationships) — deferred to a
  future runtime-debug-panel feature.

### 6. Lifecycle

- **Parent adapter `start(actor)`**: subscribe to `actor.system.inspect`;
  cache `actor.getSnapshot()`-derived active ids; post the cached active
  ids; return a `dispose()` function.
- **Iframe `ready`**: parent receives `sketch:ready`, re-posts the cached
  `latestActiveIds`. Fired ids are never replayed.
- **Iframe reload (Cmd-R)**: same as `ready` — the cached active state
  resyncs without waiting for the next state change.
- **Adapter `dispose()`**: unsubscribes inspect, clears any in-flight
  fired-decay timers, drains the bounded fired set, idempotent.
- **Bounded fired set**: cap on in-flight `firedTransitionIds`; if exceeded,
  drop oldest. Prevents pathological microstep streams from unbounded growth.

### 7. Live mode vs explore mode

Sketch's existing simulator (`startSim` / `simSend` / `restartSim`) survives
intact. The shell adds a `sketch:setMode` toggle:

- **Live mode** (default for runtime visualization): clicks on transitions
  are no-ops (or forwarded to the parent as commands; product decision per
  consumer). Active state and fired transitions are entirely parent-driven.
- **Explore mode**: Sketch's existing click-to-walk behavior is enabled;
  `simSend` advances the local replay simulator. Useful for hypothetical
  exploration of paths not yet taken by the live actor.

The two modes share the same render pipeline (`simActiveIds`,
`firedTransitionIds`); live-mode parent pushes; explore-mode local clicks
push. Mixing within a session is possible but discouraged — flipping from
explore back to live re-syncs to the parent's truth on the next snapshot.

## Consequences

- DR-002's custom Diagram, Telemetry, and Binding layers retire.
  `views/sketch/src/{graph,layout,render,binding,sketch,telemetry,styles.css}`
  delete during the cutover iteration. The `elkjs` runtime dependency
  drops. The Diagram-layer
  Node-side renderer (`renderSketchToString`) and the screenshot capture
  script also retire — Sketch renders in the browser; static SVG snapshots
  are no longer load-bearing for documentation.
- The **SKETCH spec package** ([user](../items/user/sketch.md),
  [dev](../items/dev/sketch.md), [test](../items/test/sketch.md))
  updates correspondingly. The user-visible items (SKETCH-1..5) survive
  unchanged in spirit, with SKETCH-4's `disambiguator` mention dropped
  because XState's transition selection is now the source of truth.
  Dev-side items reframe per the bullets below; test items retire those
  whose dev counterparts retire.
- **DR-001's Sketch self-host patch ledger grows from 1 to 7 patches.** Each
  upstream Sketch update must be checked for compatibility with all seven.
  All patches are additive and surgical; rebase ergonomics are favorable.
- The parent-side adapter inherits the actorRef-identity-filter responsibility
  (SKETCH-11) and the latest-active retention rule (SKETCH-10). Both survive
  unchanged in spirit; their implementation moves from `views/sketch/`'s
  Telemetry layer into the new ~80-LOC adapter.
- **Microsteps replace DR-002's matcher.** `deriveFiredEdges` and its
  deepest-owner / candidate-union / disambiguator logic delete. The adapter
  iterates microstep `_transitions[]` and looks up edge ids in the index.
- **Privacy posture unchanged.** No Stately Cloud dependency. Self-hosted
  Sketch fork. `coding.fsm.ts` source loads via `loadCode` (setup-time;
  same source the editor would load). Live-telemetry frames carry
  state-id and edge-id arrays only; runtime actor data — Captain
  prompts, contexts, event payloads — never leaves the parent process
  via the live-telemetry channel.
- **Cross-process Captain deployment** (DR-002 §8 / DR-004 wiring) reshapes:
  Captain runs the parent-side adapter directly against its actor, emits
  postMessage frames over a small SSE-or-WebSocket relay (presenter), browser
  receives and forwards to the iframe. The protocol surface is the same;
  only the transport between Captain and browser changes from DR-002's SSE
  to whatever the presenter chooses (still single-direction, still id-only).
- **Inspector-less degradation no longer applies.** SKETCH-13 drops because
  `actor.system.inspect` always exists; there is no separate "inspector
  supplied" concept.
- **DOM-free production drops.** SKETCH-7 retires. Sketch is React/DOM; the
  Diagram layer can no longer be produced outside a browser. Cross-process
  deployment renders in the browser, not on the Captain side.
- **Deferred future work**: dev-only `@statelyai/inspect` tee for
  development workflows; SDK actor-tree adoption for a runtime debug panel;
  redaction hooks if context preview becomes a product need.
- **Out of scope**: replacing Sketch's parser sandbox; multi-machine
  visualization; sequence-diagram rendering; replay/time-travel.

## References

[1]: https://github.com/statelyai/sketch "Stately Sketch — MIT, design-time visualizer/simulator for XState"
[2]: https://github.com/statelyai/inspect "@statelyai/inspect — protocol/SDK package, Stately Inspector wire format"
