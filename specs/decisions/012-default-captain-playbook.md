<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-012: Default Captain playbook

## Status

Accepted.
The initial routing, Captain-call isolation, input provenance, and terminal-presentation decisions are superseded by [DR-013](013-routing-only-captain-control.md).

## Context

The Playbook Captain shell currently keeps routing policy in a hand-authored hidden-router prompt.
It can select one root playbook, but it cannot express a reviewable workflow that clarifies an intent, decomposes complex work, calls several playbooks, observes their results, and replans.

[DR-011](011-composable-playbook-execution.md) already gives the host a causal LIFO runtime stack.
That stack, rather than an LLM, has the authoritative frame and call identities needed to route a later Boss turn to a parked child and resume its parent safely.

The compiler currently treats every Captain-acting GEARS item as a call to a player named `captain`, while the launcher correctly reserves that name for the tmux-play host Captain.
Modeling the host Captain as a player would invent a pane and player resume-token semantics that do not exist.
The compiler also accepts only literal nested-playbook targets, which cannot select from a runtime registry catalog.

## Decision

### Compiled orchestration policy

The package shall ship a natural-language source and compiled playbook for its default generic Captain.
The Captain playbook shall be a lazy internal root created for an ordinary Boss intent when no selected playbook is active.
An explicit registered slash command may instead select its corresponding enabled external playbook directly while the shell is idle.

The hand-authored shell shall remain the transport, registry, lifecycle, visibility, and causal-stack owner.
This decision supersedes [DR-008](008-playbook-captain-shell.md)'s hand-authored routing workflow, but not its host-adapter responsibilities or one-Captain-session design.

### Sequential decide-call-observe loop

One Captain intent shall run as a finite workflow:

1. decide whether to answer directly, ask one material routing question, or form a finite ordered plan;
2. keep at most one selected child playbook outstanding at a time;
3. observe the success, abort, or failure and revise the remaining plan;
4. repeat step 2 or return one final response.

The initial `remainingPlan` contains only calls after the selected first call.
Every continuing decision shall strictly reduce its length, so the authored
finite plan structurally bounds the loop while still allowing Captain to
revise or remove later calls after observing child evidence.

The Captain shall prefer a matching specialized playbook only when delegation materially improves the outcome.
It shall not call a playbook merely to restate or classify the intent, repeat an equivalent completed or failed call without new information, or select itself.
The model-facing policy owns that semantic equivalence judgment. As a
deterministic safety floor, the machine shall separately reject a continuation
whose stable target id and complete standalone input exactly match a prior
attempt, including one that later succeeded, aborted, or failed. A revised
input carrying new information is distinct for that exact check.

Plans shall be sequential because one child may park for Boss input and one parent frame may own only one outstanding child.
The current child result may change the input or necessity of later calls, so the Captain shall reassess between calls rather than launch a static batch.

### Deterministic stack ownership

Only the active leaf frame shall receive Boss input.
A parent Captain playbook shall remain suspended while its child or any descendant is active, and shall resume only from the host's validated matching child result.
The Captain model shall receive no session id, call id, stack ledger, or instruction to infer stack ownership from Boss prose.

The shell may retain a hidden lifecycle-only classification between delivering
engaged input and dismissing the active leaf. It shall disclose no frame
identity, shall fail open to delivery, and shall deliver the original Boss text
unchanged; it shall not retain the superseded hidden chat, dispatch, or text
rewriting policy.
Dismissal shall be selected only when Boss explicitly asks to stop or dismiss the active leaf; every task instruction, answer, clarification, continuation, near miss, and ambiguous input shall be delivered.

A routing clarification asked by the Captain itself shall use the standard parked Boss-reply state and preserve the same runtime instance.
The shell shall continue to own child dismissal, LIFO disposal, cycle rejection, and parent return.

### Captain is a first-class runtime actor

The runtime contract shall add a first-class `callCaptain` port with status, final text, error, abort signal, and visibility options.
Direct Captain GEARS behavior shall compile to a `captain` actor using that port; behavior delegated to a named player shall compile to a distinct `player` actor using `callPlayer`; nested behavior shall continue to use the `playbook` actor.

Workflow Captain calls shall be visible and human-readable.
Classifier and adjudicator calls shall remain hidden through `callJudge`.
The host shall serialize both kinds through one concurrency-one queue because they share one Captain session.

The trace schema shall add paired `captain.call.started` and `captain.call.finished` boundaries carrying the exact prompt, result, visibility, state identity, and normalized error, but no player resume selection.
The existing player, judge, and nested-call trace boundaries remain unchanged.

### Catalog and dynamic child target

The shell shall inject only a sanitized immutable catalog of enabled callable playbooks containing `id`, effective `command`, and `intent`.
It shall omit module specifiers, options, players, tokens, stack data, and the internal Captain itself.

The compiler shall support a nested call whose target and text come from typed FSM context while retaining explicit static metadata that identifies the context fields.
The generated machine shall validate a selected id against the injected catalog before invoking the child, and the host shall independently validate it against the enabled registry.
Literal nested targets shall retain their existing form and behavior.

SLC conformance shall verify dynamic-target metadata and context wiring without inspecting function source.
Its generated coverage shall drive scripted child success and failure so a real nested artifact is not accepted with an unsupported transition silently untested.

### Internal root presentation

The built-in Captain shall use reserved internal id `captain` and shall not be an enabled registry entry, slash command, or visible player.
Configured playbook ids and effective commands shall not collide with that id.

The shell shall not emit synthetic `/captain` lifecycle status or make any visibility request for the internal Captain root.
It shall also filter the hidden Captain runtime's human status stream while
retaining its structured telemetry, so machine state and context never become
Boss-visible status.
Child status shall describe calls and returns relative to `Captain` without exposing internal ids.
The Captain's final machine output shall be JSON-safe `{ response }`; its visible Captain call shall present that response once without exposing control JSON or reasoning.

## Consequences

- Captain routing and multi-playbook planning become authored, compiled, testable playbook behavior.
- Parked descendants continue to receive Boss replies through deterministic host state rather than LLM inference.
- The public runtime contract gains a sixth port and two trace types before its breaking composed contract is released.
- Dynamic child selection remains bounded by the enabled catalog, one outstanding child, and active-path cycle checks.
- Playbook's composed runtime must be released immutably before SLC can refresh its vendored definitions, reviewed meta artifacts, provenance mapping, and pins.
