<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-001: State Machine Tooling — XState

## Status

Accepted.
Amended by [DR-033](033-sketch-view-retirement.md).

## Context

SDLC workflows (e.g., a documentation workflow) can be modeled as composable state machines — a top-level workflow machine invoking reusable sub-machines for review cycles.
We need tooling to **define** and **run** these state machines.

We evaluated four open-source frameworks by implementing the same two-machine model (`docWorkflow` + `reviewCycle`) in each:

- **XState** (v5) [[1]] — JavaScript state machine / statechart library
- **Kestra** [[2]] — Java-based workflow orchestrator with YAML flow definitions
- **Windmill** [[3]] — Python/TypeScript workflow engine with OpenFlow YAML definitions
- **Prefect** [[4]] — Python workflow orchestrator (eliminated early — poor state machine fit)

XState's primitives (states, events, transitions, invoke) map directly to state machine concepts.
Kestra and Windmill are DAG/workflow engines that require structural containers to express branching and looping, inflating the definition:

| Metric | XState | Kestra | Windmill |
| --- | ---: | ---: | ---: |
| Files for same model | 1 | 3 | 2 |
| Meaningful lines (no comments/blanks) | 100 | 175 | 198 |
| Structural wrappers (non-semantic) | 0 | 8 | 6 |

- **Branching.** XState: two events on one state (2 lines). Windmill: `branchone` container + `default` block + `branches` array (12+ lines). Kestra: `Switch` with `cases` map (10+ lines).
- **Looping (back-edge).** XState: one transition `ReviewerReconsidering → WriterResponding` (1 line). Windmill: `whileloopflow` wrapper + condition block (8+ lines). Kestra: an entire additional file with recursive `If` + `Subflow` (47 lines), because Kestra has no native while-loop and DAG tasks are acyclic by definition.
- **Sub-machine invocation.** Roughly equivalent across all three (~4–5 lines each).

XState is also MIT-licensed, a library rather than a server, and the only evaluated option with a permissive, self-hostable click-to-step visualizer.

## Decision

- Adopt **XState v5** [[1]] (`xstate` on npm, MIT) as the state machine definition and runtime.
- This repository defines and runs machines; drawing and monitoring running machines belongs to the host application, which reads the runtime's machine-describing telemetry ([DR-033](033-sketch-view-retirement.md)).

## Consequences

- SDLC workflows are defined as XState v5 machines in JavaScript/TypeScript, version-controlled as code; the code definition is the single source of truth.
- Kestra and Windmill remain available for DAG-style workflow orchestration where their server-based execution model is needed, but are not used for state machine modeling.

## References

[1]: https://github.com/statelyai/xstate "XState v5 — MIT, active (v5.30, Apr 2026)"
[2]: https://github.com/kestra-io/kestra "Kestra — Apache-2.0"
[3]: https://github.com/windmill-labs/windmill "Windmill — AGPLv3"
[4]: https://github.com/PrefectHQ/prefect "Prefect — Apache-2.0"
