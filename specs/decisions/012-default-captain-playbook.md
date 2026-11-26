<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-012: Default Captain playbook

## Status

Accepted.
Amended by [DR-013](013-routing-only-captain-control.md), [DR-029](029-session-scoped-conversational-captain.md).

## Context

The Playbook Captain shell kept its routing policy in a hand-authored hidden-router prompt, which could not express a reviewable workflow.

The compiler treated every Captain-acting GEARS item as a call to a player named `captain`, while the launcher correctly reserves that name for the tmux-play host Captain.
Modeling the host Captain as a player would invent a pane and player resume-token semantics that do not exist.
The compiler also accepted only literal nested-playbook targets, which cannot select from a runtime registry catalog.

## Decision

### Compiled Captain policy

The package shall ship a natural-language source and compiled playbook for its default generic Captain, which runs as the session controller of [DR-029](029-session-scoped-conversational-captain.md) under the routing posture of [DR-013](013-routing-only-captain-control.md).
The hand-authored shell shall remain the transport, registry, lifecycle, visibility, and causal-stack owner.

### Captain is a first-class runtime actor

The runtime contract shall add a first-class `callCaptain` port with status, final text, error, abort signal, and visibility options.
Direct Captain GEARS behavior shall compile to a `captain` actor using that port; behavior delegated to a named role shall compile to a distinct `player` actor using `callPlayer`; nested behavior shall continue to use the `playbook` actor.

Workflow Captain calls of compiled playbooks other than the session Captain shall be visible and human-readable; the session Captain's own calls run hidden, with prose resurfaced through validated Captain speech.
Classifier and adjudicator calls shall remain hidden through `callJudge`.
The host shall serialize Captain and judge calls through one concurrency-one queue.

The trace schema shall add paired `captain.call.started` and `captain.call.finished` boundaries carrying the exact prompt, result, visibility, state identity, and normalized error, but no player resume selection.

### Catalog and dynamic child target

The shell shall inject only a sanitized immutable catalog of enabled callable playbooks containing `id`, effective `command`, and `intent`.
It shall omit module specifiers, options, players, tokens, stack data, and the internal Captain itself.

The compiler shall support a nested call whose target and text come from typed FSM context while retaining explicit static metadata that identifies the context fields.
The generated machine shall validate a selected id against the injected catalog before invoking the child, and the host shall independently validate it against the enabled registry.
Literal nested targets shall retain their existing form and behavior.
The session Captain selects playbooks through its actions rather than `callPlaybook`; dynamic targets serve other compiled playbooks.

SLC conformance shall verify dynamic-target metadata and context wiring without inspecting function source.
Its generated coverage shall drive scripted child success and failure so a real nested artifact is not accepted with an unsupported transition silently untested.

### Internal Captain presentation

The built-in Captain shall use reserved internal id `captain` and shall not be an enabled registry entry, slash command, or visible player.
Configured playbook ids and effective commands shall not collide with that id.

The shell shall not emit synthetic `/captain` lifecycle status or make any visibility request for the internal Captain.
It shall also filter the hidden Captain runtime's human status stream while retaining its structured telemetry, so machine state and context never become Boss-visible status.
Child status shall describe calls and returns relative to `Captain` without exposing internal ids.

## Consequences

- Captain routing becomes authored, compiled, testable playbook behavior.
- The public runtime contract has a sixth port and two Captain trace types.
- Dynamic child selection remains bounded by the enabled catalog, one outstanding child, and active-path cycle checks.
- Playbook's composed runtime must be released immutably before SLC can refresh its vendored definitions, reviewed meta artifacts, provenance mapping, and pins.
