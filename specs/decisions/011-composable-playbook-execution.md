<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-011: Composable playbook execution

## Status

Accepted.

## Context

Linked playbooks currently assume one active atomic FSM state, one player call at a time, and one runtime engagement in the Captain shell.
DISCUSS therefore asks Host and Participant serially even when both prompts depend only on the prior completed round.

XState v5 provides parallel states whose regions enter together and whose parent `onDone` transition fires only after every region reaches a final state [[1]].
Its invoked actors also bind asynchronous work to a state: entry starts the actor, exit stops it, and `onDone` or `onError` receives the result [[2]].

Nested playbooks introduce a separate host constraint.
A child can pause for later Boss input, while tmux-play serializes Boss turns.
If a parent `handleBossInput` awaits that child until final completion, the active Boss turn never settles and the child can never receive the next Boss turn.

The runtime boundary also cannot continue treating `snapshot.value` as a string once a parallel state is active.
Parallel state values are structured objects [[1]].

## Decision

### 1. Structured parallel work

A generated FSM shall model a fixed set of independent, coordinated tasks as an XState `type: "parallel"` state with one compound region per task.
Each working leaf shall invoke an actor, and each successful region shall reach a local final state.
The parallel parent's `onDone` transition is the join.
Async actions and runtime-owned `Promise.all` joins shall not model workflow state because XState does not await actions [[2]].

DISCUSS shall use this structure for both initial proposals and later reconciliation rounds.
Host and Participant shall receive the same completed prior-round inputs and run independently.
Their results shall be staged per branch and promoted together at the join, so completion order cannot affect the next round.

A branch that asks Boss shall enter a branch-local waiting state while sibling regions continue.
Answering the question shall re-enter only that branch's working leaf.
If both branches ask, their questions shall remain independently addressable.
A branch failure shall exit the parallel parent to the workflow's failure state, which stops sibling invocations through XState lifecycle semantics.

The fixed parallel parent is one Boss-interrupt unit. An interrupt may restart
the whole parent, but shall not target one branch working leaf and implicitly
restart its siblings. A branch-local Boss reply remains narrower: it resumes
only the identified waiting branch.

Parallel calls may target distinct resolved players.
A linked runtime shall reject simultaneous calls that resolve to the same player id because one backend resume-token chain cannot be forked deterministically.
The host Captain judge remains one single-flight resource, so hidden classifier and adjudicator calls shall pass through one abort-aware FIFO with concurrency one.
The implementation shall use `p-queue` rather than maintain a custom asynchronous queue [[5]].

### 2. Structured runtime state and quiescence

The shared contract shall represent an XState state as a JSON-safe descriptor containing its structured value, active stable state ids, tags, actor status, and whether it is quiescent.
A singular `stateId` may be included only when exactly one Boss-relevant state is active.

Generated working states shall carry the `playbook.busy` tag.
States that can return control to Boss shall carry `playbook.parked`.
A nested-call state shall carry `playbook.suspended` while its child is active.

The linked runtime shall use XState `waitFor` at the imperative boundary to await a snapshot with no active busy state, or terminal/error status [[3]].
The workflow shall continue to model waiting with states and invoked actors, not with `waitFor`.

FSM telemetry and trace payloads shall preserve structured `from` and `to` values and include normalized previous/current descriptors.
The Captain shell shall use the descriptor's status, tags, quiescence, and active ids instead of parsing one string state.
`PlaybookRunResult.outcome` and descriptor tags are authoritative for shell
lifecycle.
The registry's former `idleStateId`, `finalStateId`, and `parkStateIds` fields
shall be retired rather than compete with structured state.

### 3. Function-style nested calls

An FSM that calls another playbook shall invoke a provided `playbook` promise actor from a state-scoped call state.
The invoke input shall name the registered child playbook and carry JSON-safe child input.
The parent shall receive a successful child's output through `invoke.onDone`, and an aborted or failed child through `invoke.onError`, matching XState actor output semantics [[2]][[4]].

The linked runtime shall allocate a stable call id, emit `playbook.call.started`, ask the host to open the child, and keep the invoked actor pending.
Once the child is open, the parent drive loop shall settle with outcome `suspended` rather than await final child completion.
The result shall identify the pending call so the host can route later work without inspecting FSM internals.

When the child finishes, the host shall resume the parent runtime with the matching call id and a success, aborted, or error result.
The runtime shall validate the complete call identity, emit and drain
`playbook.call.finished`, settle the invoked actor, and then drive the parent
through its `onDone` or `onError` path until it again becomes quiescent,
suspended, failed, or terminal.
The finish trace shall precede the parent transition caused by the return.
Unknown, duplicate, or stale call ids shall reject.

The runtime contract shall therefore add a `callPlaybook` port whose start result is either settled or suspended, make `handleBossInput` return a run result, and add `resumePlaybookCall`.
This is an intentional pre-1.0 breaking change.

### 4. Captain call stack

The Playbook Captain shell shall treat one Boss-selected engagement and its nested descendants as one active call stack.
Each frame shall own a distinct runtime instance and immutable playbook-session UUID.
Only the top frame receives Boss input and owns visible player panes.

Opening a child shall push a frame whose session records `rootSessionId`, `parentSessionId`, `parentCallId`, and depth.
Child terminal completion shall pop and dispose that frame, then resume and drive its parent in the same live Captain turn.
This process may cascade through multiple returns or immediately open another child.

The stack shall allow one outstanding child per frame and reject a call whose
playbook id is already present anywhere on the active frame path, including
the caller itself.
Because recursion is deferred and enabled registry ids are unique, the finite enabled registry naturally bounds stack depth without an arbitrary numeric limit.
The target must be an enabled registry entry.
Initialization failure shall remove and dispose the partial child and resume the parent through its error path.
A child whose FSM returns outcome `failed` in a recoverable parked state shall
remain the active leaf for Boss recovery; only terminal success, boundary
rejection, initialization error, abort, or dismissal returns to the parent.

Boss dismissal at a child frame shall abort and dispose that child, then resume its parent through the call's error path.
Boss dismissal at the root shall dispose the complete stack in last-in-first-out order.
Host teardown shall dispose the complete stack in last-in-first-out order without resuming callers.
A child that parks remains the top frame for the next Boss turn.
Manual slash selection shall not bypass or replace an active stack.

### 5. Trace causality

`PlaybookSession` shall add required causal fields `rootSessionId` and
`depth`, plus optional `parentSessionId` and `parentCallId` fields.
Root sessions shall use their own id as `rootSessionId` and depth zero.

The trace schema for every linked runtime shall advance to version 2 and add
`rootSessionId`, optional parent-session/call fields, depth,
`playbook.call.started`, and `playbook.call.finished`.
Every event in one session shall carry the same causal identity.
The parent trace pair shall share the runtime call id and carry target playbook id, child session id when assigned, status, output, and normalized error where applicable.
The child's `session.started` trace shall carry its causal session fields.
Every trace payload shall be JSON-safe.
A suspended Boss settlement shall carry the structured state descriptor and
the same pending-call identity returned by the runtime.

This section supersedes DR-010's version-1 type set and state-id-only payload
vocabulary for all linked runtimes.
DR-010's boundary ordering, exact prompt/reply, error normalization,
sensitivity, and explicit player-continuation rules remain in force.

Parallel calls may finish in either order.
The session trace sequence remains the authoritative total order, while acceptance tests shall require only causal partial orders between independent calls.

### 6. Preserved scope

This decision composes live runtime sessions.
It does not add durable XState snapshot persistence, cross-process rehydration, recursive playbook calls, parallel Boss turns, or concurrent calls to one resolved player.
XState deep persistence can preserve invoked child actors in a future durable design, but restarted invocations and JSON-serialization constraints require a separate decision [[6]].

## Consequences

- DISCUSS can overlap independent Host and Participant work without race-dependent prompts.
- One branch can wait for Boss without discarding a completed sibling result.
- A playbook can call an enabled child, pause across Boss turns, and continue from the child's output like a function return.
- Every nested runtime retains independent player sessions and a causally linked trace.
- Hosts and linked runtimes must understand structured state descriptors and the new nested-call protocol.
- Direct child-machine invocation within one XState actor system remains the preferred future architecture when the public runtime factory exposes actor logic; the live stack bridge preserves current dynamic registry and free-text runtime boundaries without deadlocking interactive children.

## References

[1]: https://stately.ai/docs/parallel-states 'XState parallel states and joins'
[2]: https://stately.ai/docs/invoke 'XState invoked actors and lifecycle'
[3]: https://stately.ai/docs/actors#waitfor 'XState actor waitFor'
[4]: https://stately.ai/docs/output 'XState actor output'
[5]: https://github.com/sindresorhus/p-queue#readme 'p-queue concurrency and AbortSignal support'
[6]: https://stately.ai/docs/persistence 'XState deep actor persistence'
