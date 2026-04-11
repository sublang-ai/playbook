<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-001: State Machine Tooling — XState + Stately Sketch

## Status

Accepted

## Context

SDLC workflows (e.g., the documentation workflow in `demo/sdlc/src/doc.md`) can be modeled as composable state machines — a top-level workflow machine invoking reusable sub-machines for review cycles. We need tooling to **define**, **visualize**, **simulate**, and eventually **run and monitor** these state machines.

We evaluated four open-source frameworks by implementing the same two-machine model (`docWorkflow` + `reviewCycle`) in each:

- **XState** (v5) — JavaScript state machine / statechart library with Stately Sketch visualizer
- **Kestra** — Java-based workflow orchestrator with YAML flow definitions
- **Windmill** — Python/TypeScript workflow engine with OpenFlow YAML definitions
- **Prefect** — Python workflow orchestrator (eliminated early — poor state machine fit)

We also surveyed the broader landscape of state machine tools for any competitor offering both concise text-based definitions and interactive visual simulation.

## Decision

Adopt **XState v5** as the state machine definition and runtime, with **Stately Sketch** (MIT) as the native visualizer/simulator, and **@statelyai/inspect** for runtime monitoring.

### Rationale

#### 1. Conciseness

XState's primitives (states, events, transitions, invoke) map directly to state machine concepts. Kestra and Windmill are DAG/workflow engines that require structural containers to express branching and looping, inflating the definition.

| Metric | XState | Kestra | Windmill |
| --- | ---: | ---: | ---: |
| Files for same model | 1 | 3 | 2 |
| Meaningful lines (no comments/blanks) | 100 | 175 | 198 |
| Structural wrappers (non-semantic) | 0 | 8 | 6 |

Specific patterns where the gap is most pronounced:

- **Branching.** XState: two events on one state (2 lines). Windmill: `branchone` container + `default` block + `branches` array (12+ lines). Kestra: `Switch` with `cases` map (10+ lines).
- **Looping (back-edge).** XState: one transition `ReviewerReconsidering → WriterResponding` (1 line). Windmill: `whileloopflow` wrapper + condition block (8+ lines). Kestra: an entire additional file with recursive `If` + `Subflow` (47 lines), because Kestra has no native while-loop and DAG tasks are acyclic by definition.
- **Sub-machine invocation.** Roughly equivalent across all three (~4–5 lines each).

#### 2. Interactive visualization with simulation

| Tool | Visible graph edges | Step-by-step simulation | Open source | Self-hostable |
| --- | :---: | :---: | :---: | :---: |
| **XState + Stately Sketch** | Card layout (no arrows) | Click events to walk states | MIT | Yes (Vite SSR build) |
| **XState + custom D3 graph** | Force-directed with arrows | Click events to walk states | MIT | Yes (single HTML + D3) |
| **Kestra topology view** | DAG arrows | Execute only (no dry-run sim) | Apache-2.0 | Requires ~107 MB server |
| **Windmill flow canvas** | DAG arrows | Execute only (no dry-run sim) | AGPLv3 | Requires ~569 MB server |
| **sketch.systems** | Graph with arrows | Click to walk | Closed source | No |
| **itemis CREATE** | Graphical editor | Trigger-based simulation | EPL | Eclipse/VSCode plugin only |
| **Robot3 + robot3-viz** | SVG via DAGre | No simulation | MIT | Yes, but unmaintained |
| **Sismic** | PlantUML export only | API only (no GUI) | LGPL | CLI/library only |
| **state-machine-cat** | Graphviz SVG | No simulation | MIT | Yes |

Only XState + Stately Sketch combines all of: concise text DSL, interactive visual charts, click-to-step simulation, MIT license, and self-hostable. sketch.systems is the closest competitor but is closed-source and unmaintained ("Alpha").

#### 3. Lightweight footprint

| Framework | Runtime footprint (to render charts) | Full server install |
| --- | ---: | ---: |
| **XState + Sketch** | 20 MB (Vite SSR build) | 20 MB (same) |
| **XState + D3 graph** | 316 KB | 316 KB |
| Kestra | 4.1 MB (Mermaid static) | ~110 MB (107 MB server JAR) |
| Windmill | 6.3 MB (Mermaid static) | ~575 MB (569 MB server binary) |

#### 4. Desktop embedding path

Stately Sketch's Vite SSR build can be embedded in a Tauri desktop app (~25 MB total) or an Electron app (~150 MB), providing an offline-capable state machine IDE. `@statelyai/inspect` supports both iframe embedding and WebSocket mode for runtime monitoring.

### Components adopted

| Component | Role | License |
| --- | --- | --- |
| `xstate` (npm) | State machine definitions and runtime | MIT |
| Stately Sketch (`statelyai/sketch`) | Native visualizer and simulator | MIT |
| `@statelyai/inspect` | Runtime state inspection | MIT |
| D3.js (optional) | Force-directed graph with visible edges | ISC |

### Self-hosting notes for Stately Sketch

Sketch's client defaults to fetching source files from `stately.ai` (the cloud registry). For self-hosted mode:

- Rebuild with `VITE_REGISTRY_API_URL="/api/viz"` so the client fetches from the local Nitro server.
- Non-functional UI (login, share, help links to stately.ai) can be hidden via a `public/local-overrides.css` file injected through a `<link>` in the root route head config — no component code changes required.

## Consequences

- SDLC workflows are defined as XState v5 machines in JavaScript/TypeScript, version-controlled as code.
- Visualization and simulation use Stately Sketch (self-hosted) for design-time exploration, and optionally a D3-based force-directed graph for topological overview with visible edges.
- Runtime monitoring uses `@statelyai/inspect` to observe live state transitions.
- Kestra and Windmill remain available for DAG-style workflow orchestration where their server-based execution model is needed, but are not used for state machine modeling.

## References

- [XState v5](https://github.com/statelyai/xstate) — MIT, active (v5.30, Apr 2026)
- [Stately Sketch](https://github.com/statelyai/sketch) — MIT, active
- [@statelyai/inspect](https://github.com/statelyai/inspect) — MIT
- [Kestra](https://github.com/kestra-io/kestra) — Apache-2.0
- [Windmill](https://github.com/windmill-labs/windmill) — AGPLv3
- [state-machine-cat](https://github.com/sverweij/state-machine-cat) — MIT
- [sketch.systems](https://sketch.systems/) — closed source
- [itemis CREATE](https://www.itemis.com/en/products/itemis-create/) — EPL
- Prototype implementations: `claude/xstate/`, `claude/kestra/`, `claude/windmill/`, `claude/xstate-graph/`
