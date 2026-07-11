<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-018: Composable playbook execution

## Goal

Run independent playbook tasks concurrently and let one live playbook call, await, and resume from another enabled playbook.

## Deliverables

- [x] Parallel, structured-state, nested-call, stack, and trace semantics recorded in canonical specs.
- [ ] DISCUSS initial and reconciliation rounds use XState parallel regions and branch-local Boss waits.
- [ ] Linked runtimes expose structured state, XState-tag quiescence, and concurrency-safe calls.
- [ ] The public runtime contract supports opening and resuming nested playbook calls.
- [ ] The Captain shell maintains a bounded causal LIFO runtime-session stack.
- [ ] Integration tests cover overlap, joins, independent waits, child return, cascading calls, cancellation, and trace causality.
- [ ] Generated JavaScript and declaration artifacts agree with their TypeScript sources.

## Tasks

1. **Specify composition.** _[done]_
   Add DR-011 and coordinated PBRT/CAPTAIN/SLC requirements before implementation.
2. **Compile parallel DISCUSS rounds.**
   Update the authored discussion, GEARS, FSM, runtime, and focused tests for independent Host and Participant regions.
3. **Normalize runtime state.**
   Add shared structured descriptors, XState tags, `waitFor` quiescence, and abort-aware judge serialization.
4. **Add the nested-call protocol.**
   Extend the shared contract and linked-runtime convention with child open, suspension, result, resume, and trace types.
5. **Implement the Captain stack.**
   Push enabled child runtimes, route the top frame, return results to parents, enforce bounds, and dispose LIFO.
6. **Verify and regenerate.**
   Exercise real linked runtimes and test-only nested callers, rebuild artifacts, run the complete suite, and audit the committed diff.

## Acceptance criteria

- Both DISCUSS players start each proposal round before either result is required, and the next round sees only the joined prior-round pair.
- A waiting parallel branch resumes independently while completed or separately waiting siblings are not restarted.
- Runtime telemetry, trace, classification, parking, and summaries work with structured XState values.
- A child may park across Boss turns, finish, return output, and resume its parent without blocking the host turn loop.
- Nested sessions have distinct UUIDs and causal trace fields; invalid targets, active-path cycles, duplicate child calls, and stale returns reject safely.
- Abort, dismissal, failure, and teardown stop in-flight work and dispose nested frames in last-in-first-out order.
- Build, package, CODE, DISCUSS, Captain shell, and full test suites pass.
