<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-001: State Machine Tooling — XState + Stately Sketch

## Status

Accepted

## Context

SDLC workflows (e.g., the documentation workflow in `demo/sdlc/src/doc.md`) can be modeled as composable state machines — a top-level workflow machine invoking reusable sub-machines for review cycles. We need tooling to **define**, **visualize**, **simulate**, and eventually **run and monitor** these state machines.

We evaluated four open-source frameworks by implementing the same two-machine model (`docWorkflow` + `reviewCycle`) in each:

- **XState** (v5) [[1]] — JavaScript state machine / statechart library with Stately Sketch [[2]] visualizer
- **Kestra** [[4]] — Java-based workflow orchestrator with YAML flow definitions
- **Windmill** [[5]] — Python/TypeScript workflow engine with OpenFlow YAML definitions
- **Prefect** [[10]] — Python workflow orchestrator (eliminated early — poor state machine fit)

We also surveyed the broader landscape of state machine tools [[6]] [[7]] [[8]] [[9]] for any competitor offering both concise text-based definitions and interactive visual simulation.

## Decision

Adopt **XState v5** [[1]] as the state machine definition and runtime, with **Stately Sketch** [[2]] (MIT) as the native visualizer/simulator, and **@statelyai/inspect** [[3]] for runtime monitoring.

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

| Tool | Visible graph edges | Step-by-step simulation | License | Deployment |
| --- | :---: | :---: | --- | --- |
| **XState + Stately Sketch** | Card layout (no arrows) | Click events to walk states | MIT | Self-host (Vite SSR) |
| **XState + custom D3 graph** | Force-directed with arrows | Click events to walk states | MIT | Self-host (static HTML) |
| **Kestra topology view** | DAG arrows | Execute only (no dry-run sim) | Apache-2.0 | Self-host (server) |
| **Windmill flow canvas** | DAG arrows | Execute only (no dry-run sim) | AGPLv3 | Self-host (server) |
| **sketch.systems** [[8]] | Graph with arrows | Click to walk | Not advertised | Hosted web app |
| **itemis CREATE** [[7]] | Graphical editor | Trigger-based simulation | Commercial | Desktop, cloud |
| **Robot3 + robot3-viz** [[11]] [[12]] | SVG via DAGre | No simulation | BSD-2-Clause | Self-host |
| **Sismic** | PlantUML export only | API only (no GUI) | LGPL | Library (CLI) |
| **state-machine-cat** | Graphviz SVG | No simulation | MIT | Self-host |

Among off-the-shelf tools, only XState + Stately Sketch [[2]] combines all of: concise text DSL, interactive visual charts, click-to-step simulation, permissive open-source license, and self-hostable. The custom D3 graph (built during this evaluation) also meets these criteria but is a bespoke prototype, not a reusable project. Excluded alternatives: sketch.systems [[8]] supports click-through exploration but is labeled Alpha and is presented as a hosted web app on its public site; itemis CREATE [[7]] offers simulation and visual debugging across desktop and cloud, but is commercially licensed (from €510/year per [[7b]]) with no open-source edition for the current product.

#### 3. Lightweight footprint

Off-the-shelf native visualizers:

| Framework | Native visualizer | Footprint |
| --- | --- | ---: |
| **XState + Sketch** [[2]] | Stately Sketch (Vite SSR build) | 20 MB |
| **Kestra** [[4]] | Topology view (requires server) | ~110 MB |
| **Windmill** [[5]] | Flow canvas (requires server) | ~575 MB |

Internal prototypes (built during this evaluation, not reusable):

| Prototype | Approach | Footprint |
| --- | --- | ---: |
| XState + D3 graph | Custom force-directed graph | 316 KB |
| Kestra Mermaid mirror | Static Mermaid rendering of flow YAML | 4.1 MB |
| Windmill Mermaid mirror | Static Mermaid rendering of flow YAML | 6.3 MB |

The Mermaid mirrors lack the interactive features of their native visualizers (see `claude/README.md` for caveats).

#### 4. Desktop embedding path

Stately Sketch's Vite SSR build can be embedded in a Tauri or Electron desktop shell, providing an offline-capable state machine IDE. `@statelyai/inspect` supports iframe embedding [[3b]] and WebSocket mode [[3]] for runtime monitoring. No desktop packaging was performed during this evaluation; actual bundle sizes would need to be measured.

### Components adopted

| Component | Role | License |
| --- | --- | --- |
| `xstate` (npm) | State machine definitions and runtime | MIT |
| Stately Sketch (`statelyai/sketch`) | Native visualizer and simulator | MIT |
| `@statelyai/inspect` | Runtime state inspection | MIT |
| D3.js (optional) | Force-directed graph with visible edges | ISC |

### Self-hosting feasibility (verified)

Sketch's client defaults to the `stately.ai` cloud registry. Self-hosting requires two changes, validated during prototyping (see `claude/xstate/deps/sketch/`):

- **Upstream-clean:** Set `VITE_REGISTRY_API_URL="/api/viz"` at build time to redirect API calls to the local Nitro server. This uses an existing env-var hook in the upstream source (`api.ts:6`).
- **Requires local patch:** Add a `<link>` to `public/local-overrides.css` in the root route config (`__root.tsx`) to hide non-functional cloud UI (login, share). This is a 4-line source modification not available upstream.

## Consequences

- SDLC workflows are defined as XState v5 machines in JavaScript/TypeScript, version-controlled as code.
- Visualization and simulation use Stately Sketch (self-hosted) for design-time exploration, and optionally a D3-based force-directed graph for topological overview with visible edges.
- Self-hosting Sketch carries a local 4-line patch to `__root.tsx` (see [Self-hosting feasibility](#self-hosting-feasibility-verified)). This creates upgrade friction: each upstream Sketch update must be checked for compatibility with the patch, and a route-config restructure could break it. Until upstream provides a configuration hook for injecting custom stylesheets, this patch must be maintained.
- Runtime monitoring uses `@statelyai/inspect` to observe live state transitions.
- Kestra and Windmill remain available for DAG-style workflow orchestration where their server-based execution model is needed, but are not used for state machine modeling.

## References

[1]: https://github.com/statelyai/xstate "XState v5 — MIT, active (v5.30, Apr 2026)"
[2]: https://github.com/statelyai/sketch "Stately Sketch — MIT, active"
[3]: https://github.com/statelyai/inspect "@statelyai/inspect — MIT (WebSocket inspector)"
[3b]: https://stately.ai/docs/inspector "Stately Inspector docs — iframe embedding"
[4]: https://github.com/kestra-io/kestra "Kestra — Apache-2.0"
[5]: https://github.com/windmill-labs/windmill "Windmill — AGPLv3"
[6]: https://github.com/sverweij/state-machine-cat "state-machine-cat — MIT"
[7]: https://www.itemis.com/en/products/itemis-create/ "itemis CREATE — commercial"
[7b]: https://www.itemis.com/en/products/itemis-create/licenses "itemis CREATE licenses — pricing and platform details"
[8]: https://sketch.systems/ "sketch.systems homepage"
[9]: https://github.com/AlexandreDecan/sismic "Sismic — LGPL"
[10]: https://github.com/PrefectHQ/prefect "Prefect — Apache-2.0"
[11]: https://github.com/matthewp/robot "Robot — BSD-2-Clause"
[12]: https://github.com/jbreckmckye/robot3-viz "robot3-viz — BSD-2-Clause"
