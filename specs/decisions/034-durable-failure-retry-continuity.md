<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-034: Durable failure-retry continuity

## Status

Accepted.
Amends [DR-029](029-session-scoped-conversational-captain.md).
Amended by [DR-038](038-universal-run-resumption.md), [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-069](069-captain-prepares-step-recovery.md), [DR-073](073-durable-step-progress.md).

## Context

- [DR-029](029-session-scoped-conversational-captain.md) made each working runtime the owner of the recovery actions valid from its current state, and the compiled Captain routes an explicit Boss recovery or resume request only to an action that runtime currently advertises.
- A failure-state retry built from the last classified Boss event, which the runtime records in process memory and the durable snapshot deliberately excludes [[playbook-runtime-52](../packages/playbook-runtime.md#playbook-runtime-52)], disappeared when a continued session restored the frame, and was refused inside the live process whenever the failed work had been resumed by a Boss reply.
- A playbook parked in the recoverable failure state — a nested REVIEW leaf after a reviewer player error under a headless CODE run, for example — therefore advertised zero actions, and the Captain could only dismiss and restart it.
- The gap is a process boundary rather than a front-end difference, so [DR-031](031-shared-captain-session-front-ends.md)'s one durable session recovered differently depending only on whether the hosting process survived the turn.

## Decision

1. **A failure's retry is derived from durable state.**
   The retry a parked failure advertises is built from the runtime-owned checkpoint of the interrupted invocation saved with that failure ([DR-069](069-captain-prepares-step-recovery.md), [DR-073](073-durable-step-progress.md)), never from process-local memory, so the process that failed and every process that restores its session advertise the same retry, root or nested leaf, including a failure reached after a Boss reply.

2. **Retry repeats only the interrupted step.**
   Retry reenters that invocation with its original context and input, preserving completed predecessor steps and parent/child ownership.
   Without an invocation checkpoint, no whole-playbook retry repeats earlier work ([DR-073](073-durable-step-progress.md)), and an effect-possible unresolved boundary advertises reconciliation as its only retry ([DR-040](040-outcome-authority-effect-reconciliation.md)).
   New Boss input, unlike a step retry, keeps the effect checks over the whole attempt that a live failure uses.

3. **The free-text invariants are unchanged.**
   `apply` never invents free text and never enters Boss-input classification.

4. **Cross-process at-most-once execution** rests on the per-session lease and the host's write-ahead uncertain record ([DR-031](031-shared-captain-session-front-ends.md) §4).

Considered and rejected: letting an explicit recovery request fall back to classification-backed delivery when the runtime advertises no action.
That changes the compiled Captain's closed selection semantics and restarts the work under freshly classified text instead of the input the Boss already gave.

## Consequences

- A playbook parked in the recoverable failure state advertises the same retry to a continued session as to the live process, so the Captain's recovery policy reaches it through either front end without dismissing the engagement.
- A failure reached after a Boss reply resumed the work is recoverable.
- [[playbook-runtime-45](../packages/playbook-runtime.md#playbook-runtime-45)] and the durable-record items govern what the snapshot carries; this decision adds no snapshot member of its own.
