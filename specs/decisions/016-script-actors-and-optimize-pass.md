<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-016: Script actors and the GEARS optimize pass

## Status

Accepted.
Amended by [DR-019](019-shared-linked-runtime-factory.md): the `script` actor implementation moved from each emitted module into the shared linked-runtime factory — the linker emits no script executor inside a factory-backed module, and `node:child_process` is imported by the shared engine rather than per artifact.

## Context

Every working state a compiled playbook reaches today runs an agent: direct Captain work through `callCaptain`, delegated work through `callPlayer`, nested calls through `callPlaybook` ([slc/gears2fsm.md "Setup"](../../slc/gears2fsm.md#setup)).
Some compiled behaviors need none of that.
A workflow that commits to Git implicitly requires its working directory to be a repository; the setup step that checks and establishes that state is a fixed shell command with a success/failure outcome — no judgment, no language, no context.
Running it through an LLM burns tokens and latency on a deterministic action, and makes the playbook's cheapest step its least reliable one.

slc is growing an LLVM-style optimization surface: format-preserving *pass phases* that a compile opts into (slc DR-013 [[1]]), sitting between ordinary phases.
The natural pass for the `playbook` pipeline rewrites mechanical GEARS items so the linked runtime executes them directly.
That needs an execution primitive the definitions do not have: a state kind that runs without any agent.

## Decision

### 1. A fourth actor kind: `script`

- GEARS gains an optimizer-introduced item kind, written `Captain shall run:` with a blockquoted static POSIX shell script and exactly two `Results:` guards — first zero exit status, second nonzero ([slc/text2gears.md "Script behaviors"](../../slc/text2gears.md#script-behaviors-optimizer-introduced)).
  `text2gears` itself never emits the kind; only the optimize pass introduces it.
- `gears2fsm` compiles a script item to a `script` actor invocation with typed `ScriptInput` (`stateId`, `sourceItem`, `command`, `result`) and discriminated `ScriptOutput` carrying `exitStatus` ([slc/gears2fsm.md "Setup"](../../slc/gears2fsm.md#setup)).
  Script states are not agent-invoking: no `needsBossReply`, no resume registration.
- The linker provides the `script` actor implementation inside the emitted module: `sh -c` execution in the runtime's working directory (`PlaybookRuntimeOptions.cwd`, defaulting to the process working directory), mechanical exit-status-to-guard mapping, no port call, no adjudication, abort by child termination ([slc/link.md "Script execution"](../../slc/link.md#script-execution)).

### 2. Observability without new trace types

- Script execution emits one status line (`Executed script for <stateId> (exit <status>).`) and one telemetry event under the `playbook.script` topic.
- No `*.call.*` trace pair is added: trace consumers ([DR-010](010-playbook-session-tracing-and-resume.md), as advanced to schema `3` by [DR-032](032-explicit-roles-session-players.md)) are unaffected; the FSM transition trace plus the `playbook.script` topic record the step.
- Script stdout/stderr never enter machine context, prompts, or traces; a script's effect is on the environment plus its exit status.

### 3. The `optimize` pass definition

- A new definition `slc/optimize.md` (gears → gears, format-preserving) rewrites eligible items into script items: mechanical, static-command, environment-only effects, two-way exit-status outcome.
  Uncertain items stay unchanged — the pass is conservative by construction, and an unoptimized playbook has identical observable behavior.
- Provenance is explicit: rewritten items are listed in one appended `## Optimizations` section.
- The definition ships in the package beside the other three (`./slc/*` export) and is compilable by `slc slc` like any phase definition; whether and when a compile runs it is the driver's concern (slc `-O`), not the definitions'.

### 4. Contract impact

- No change to `@sublang/playbook/runtime`: no new port, no new runtime method.
  The `script` actor is runtime-internal; `node:child_process` is imported by an emitted module only when its FSM declares a script state.
- `PlaybookRuntimeOptions` for a script-bearing playbook gains an optional `cwd` knob, emitted per playbook by the linker as with other per-run options.

## Consequences

- Deterministic setup steps stop costing agent calls; a compiled workflow's Git bootstrap runs in milliseconds with a mechanical outcome.
- Hosts and trace consumers need no changes; a checker can observe scripted execution through the `playbook.script` telemetry topic and the status line.
- The GEARS item-syntax contract now has four behavior kinds; conformance tooling that parses acting clauses adds one literal form (`Captain shall run:`).
- Optimization is opt-in per compile: pipelines and hosts that never request the pass see byte-identical behavior to today.

## References

[1]: https://github.com/sublang-ai/slc/blob/main/specs/decisions/013-normalize-and-pass-phases.md "slc DR-013 — generic input normalization and optimization pass phases"
