<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-016: Script actors and the GEARS optimize pass

## Status

Accepted.
Amended by [DR-019](019-shared-linked-runtime-factory.md), [DR-050](050-pull-request-delivery.md), [DR-106](106-a-script-step-records-its-output.md), [DR-108](108-compiled-gears-is-a-spec-package.md).

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

- GEARS gains an optimizer-introduced item kind, written `Captain shall run:` with a blockquoted POSIX shell script and exactly two `Results:` guards — first zero exit status, second nonzero ([slc/text2gears.md "Script behaviors"](../../slc/text2gears.md#script-behaviors-optimizer-introduced)).
  `text2gears` itself never emits the kind; only the optimize pass introduces it.
  The script is static apart from `<placeholder>`s relaying runtime values the machine retains; each occupies a single-quoted shell word and binds as a single-quoted literal, so reported text stays data, and the script still reads no conversation and produces no prose ([DR-050](050-pull-request-delivery.md)).
- `gears2fsm` compiles a script item to a `script` actor invocation with typed `ScriptInput` (`stateId`, `sourceItem`, `command`, `result`) and discriminated `ScriptOutput` carrying `exitStatus` ([slc/gears2fsm.md "Setup"](../../slc/gears2fsm.md#setup)).
  Script states are not agent-invoking: no `needsBossReply`, no resume registration.
- The shared linked-runtime factory provides the `script` actor implementation, so the linker emits no executor inside a factory-backed module ([DR-019](019-shared-linked-runtime-factory.md)): `sh -c` execution in the runtime's working directory (`PlaybookRuntimeOptions.cwd`, defaulting to the process working directory), mechanical exit-status-to-guard mapping, no port call, no adjudication, abort by child termination ([slc/link.md "Script execution"](../../slc/link.md#script-execution)).

### 2. Observability without new trace types

- Script execution emits one status line (`Executed script for <stateId> (exit <status>).`) and one telemetry event under the `playbook.script` topic, carrying the command as executed, the step's duration, and a bounded tail of its output for hosts and people ([DR-106](106-a-script-step-records-its-output.md)).
- No `*.call.*` trace pair is added: trace consumers ([DR-010](010-playbook-session-tracing-and-resume.md)) are unaffected; the FSM transition trace plus the `playbook.script` topic record the step.
- Script stdout/stderr never enter machine context, guards, prompts, status lines, or traces; a script's effect is on the environment plus its exit status.

### 3. The `optimize` pass definition

- A new definition `slc/optimize.md` (gears → gears, format-preserving) rewrites eligible items into script items: mechanical, static-command, environment-only effects, two-way exit-status outcome.
  Uncertain items stay unchanged — the pass is conservative by construction, and an unoptimized playbook has identical observable behavior.
  A rewrite preserves the source's exact environmental predicate and effect, including resource location: being inside an ancestor's Git working tree does not satisfy an explicit requirement for the current directory to be its own repository root.
- A script item is its own provenance: the pass appends no `## Optimizations` section, and nothing requires or preserves one ([DR-108](108-compiled-gears-is-a-spec-package.md)).
- The definition ships in the package beside the other three (`./slc/*` export) and is compilable by `slc slc` like any phase definition; whether and when a compile runs it is the driver's concern (slc `-O`), not the definitions'.

### 4. Contract impact

- No change to `@sublang/playbook/runtime`: no new port, no new runtime method.
  The `script` actor is runtime-internal; `node:child_process` is imported by the shared engine rather than per artifact.
- `PlaybookRuntimeOptions` for a script-bearing playbook gains an optional `cwd` knob, emitted per playbook by the linker as with other per-run options.

## Consequences

- Deterministic setup steps stop costing agent calls; a compiled workflow's Git bootstrap runs in milliseconds with a mechanical outcome.
- Hosts and trace consumers need no changes; a checker can observe scripted execution through the `playbook.script` telemetry topic and the status line.
- The GEARS item-syntax contract now has four behavior kinds; conformance tooling that parses acting clauses adds one literal form (`Captain shall run:`).
- Optimization is opt-in per compile: pipelines and hosts that never request the pass see byte-identical behavior to today.

## References

[1]: https://github.com/sublang-ai/slc/blob/main/specs/decisions/013-normalize-and-pass-phases.md "slc DR-013 — generic input normalization and optimization pass phases"
