<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# XState Sketch

A vanilla TS + SVG visualizer for XState v5 machines, with live
active-state and fired-transition highlights. Implements
[DR-002](../../specs/decisions/002-in-page-xstate-visualizer.md) as three
independently composable layers — **Diagram**, **Telemetry**, and
**Binding** — connected by the `SketchTelemetry` protocol.

## Install

```bash
cd views/sketch
npm install
npm run dev      # demo at http://localhost:5173
npm run build    # tsc --noEmit + vite build
npm test         # vitest
```

Peer deps: `xstate`, `@xstate/graph`. Runtime dep: `elkjs`.

## Usage

### Same-page: machine + actor in the browser

```ts
import { createActor } from 'xstate';
import { createSketchInspector, fromXStateActor, mountSketch } from './src/sketch';
import { myMachine } from './my-machine';

const inspector = createSketchInspector();
const actor = createActor(myMachine, { inspect: (e) => inspector.handle(e) });

const { dispose } = mountSketch(document.querySelector('#canvas')!, {
  machine: myMachine,
  source: fromXStateActor({ actor, machine: myMachine, inspector }),
});

actor.start();
// ... later: dispose() runs the three-step teardown idempotently.
```

The diagram lays out once per machine. Each microstep emits a `fired`
event; CSS transitions on `.transition.fired` absorb rapid streams.

### Static diagram (no actor)

```ts
mountSketch(container, { machine: myMachine });
```

### Cross-process: pre-rendered SVG + remote telemetry

```ts
import { fromEventSource } from './src/sketch';

mountSketch(container, {
  svg: serverShippedSvgString,
  source: fromEventSource('/events'),
});
```

The Captain side runs Diagram + Telemetry, ships the SVG once, and
streams `SketchTelemetry` records as SSE `event: telemetry` lines. See
[DR-002 §8](../../specs/decisions/002-in-page-xstate-visualizer.md#8-cross-process-deployment).

## Source adapters

| Adapter | Where it runs | Emits |
| --- | --- | --- |
| `fromXStateActor({ actor, inspector })` | Same process as the actor | `active` + `fired` |
| `fromXStateActor({ actor })` (no inspector) | Same process as the actor | `active` only |
| `fromEventSource(url)` | Browser binding host | Whatever the SSE server forwards |

Both satisfy `SketchSource` (`subscribe`, `dispose`). `subscribe` returns
an unsubscribe function. `dispose` is idempotent.

## Ambiguity model and `disambiguate`

XState v5's `inspect` hook does not expose the matched guard for a
`@xstate.microstep`. When two guarded transitions share
`(from, event, to)`, both are equally consistent with what the matcher
sees, so by default both edges flash. Pass a `disambiguate(prev, event,
next, candidates)` callback to narrow the set when your context can
pick the matched branch:

```ts
fromXStateActor({
  actor, machine, inspector,
  disambiguate: (_prev, _event, next, candidates) => {
    const guard = next.context.lastResult?.guard;
    return candidates.find((id) => id.includes(`::${branchOf(guard)}::`)) ?? candidates;
  },
});
```

Without `disambiguate`, all candidates appear in `firedEdgeIds` —
honest about the ambiguity. The demo (`demo/coding-demo.ts`) toggles
this on/off so you can see both behaviors against
`coding.fsm.ts`'s `planAndImplement → reviewCodeCommit` branch.

## Demo

`npm run dev` opens the bundled demo wiring `coding.fsm.ts` (vendored
under `demo/`) with `fromXStateActor`. Click a Boss event to drive the
machine; resolve the pending Captain invocation with a guard. Captain
buttons whose guard has no `onDone` branch in the active state are
disabled, so the actor never receives a done event it cannot match.

![mid-run screenshot of the demo](docs/screenshot.png)

> _Screenshot pending — capture once the layout warms up after a few
> Boss events; place at `views/sketch/docs/screenshot.png`._

## Layout

```text
src/
  graph.ts         machine → graph extraction (DR-002 §3)
  layout.ts        elkjs wrapper + placeholder layout
  render.ts        renderSketch / renderSketchToString (DR-002 §4–5)
  telemetry.ts     fromXStateActor matcher (DR-002 §6–7)
  binding.ts       applySketchTelemetry, fromEventSource, mountSketch
  sketch.ts        public re-exports
  styles.css       theme (.state.active, .transition.fired, …)
demo/
  coding.fsm.ts    vendored from demo/sdlc/src/.playbook/ for the standalone demo
  coding-demo.ts   buttons + Captain stub + disambiguate toggle
```
