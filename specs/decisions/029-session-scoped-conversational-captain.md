<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-029: Session-scoped conversational Captain

## Status

Accepted.
Amends [DR-009](009-generic-playbook-cli-and-registry.md), [DR-011](011-composable-playbook-execution.md), [DR-012](012-default-captain-playbook.md), [DR-013](013-routing-only-captain-control.md), [DR-025](025-resilient-captain-control-adjudication.md).
Amended by [DR-034](034-durable-failure-retry-continuity.md), [DR-035](035-truthful-terminal-meaning.md), [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-049](049-portable-session-contract.md), [DR-051](051-host-selected-runtime-recovery.md), [DR-069](069-captain-prepares-step-recovery.md), [DR-073](073-durable-step-progress.md), [DR-077](077-portable-assets-and-inspection.md).

## Context

A linked CODE runtime was first adapted directly as the tmux-play Captain, so one workflow was both the whole Boss-facing Captain and the runnable playbook.
A built-in shell over registered playbook runtimes replaced it, first with a hand-authored chat and routing policy, then with a compiled Captain playbook run per intent as a lazy internal root.
That interactive Captain did not remember earlier turns, could not reliably continue a failed playbook, and sometimes reported work that had not happened.
The Boss requires the Captain to know the whole session, converse naturally while operating playbooks, and choose, replace, clear, or resume a playbook from its current condition.

## Decision

1. **A built-in shell hosts registered playbook runtimes.**
   - The shell is the host-side Captain over a registry of compiled `PlaybookRuntime` factories ([DR-009](009-generic-playbook-cli-and-registry.md)); each engaged playbook is a runtime session, not an XState child state, because a linked playbook's quiescent states are return-to-Boss states rather than `invoke` completion states.
   - It parks an engaged runtime that returns quiescent and disposes one that reaches a final state or that Boss dismisses.
   - It keeps a bounded deterministic control ledger mirrored from the runtime's `playbook.fsm.state` telemetry and the runtime-owned `describe` view, never a copy of the Boss conversation.
   - It passes each runtime's status and telemetry through to the host and publishes its own FSM telemetry under the distinct `playbook.captain.fsm.state` topic.
   - It delivers Boss text to a runtime or applies an action that runtime currently advertises through the runtime-owned `describe`/`apply` pair; it never fabricates or pre-classifies an FSM event, since each runtime classifies its own Boss events.
   - Hidden control calls pass `{ visibility: 'hidden' }` together with a hidden-control prompt envelope, so control JSON stays off the Boss pane.

2. **The Captain remains a compiled playbook.**
   It runs for the whole shell session as the controller outside the working-playbook stack of [DR-011](011-composable-playbook-execution.md), receives every non-empty Boss turn, and is never suspended behind a working playbook.
   Its own calls run hidden, with prose resurfaced through host-validated Captain speech.
   A turn's text and attachment references are independent inputs, and the Captain reasons over the attachments a turn selects ([DR-077](077-portable-assets-and-inspection.md)).

3. **The Captain keeps one recoverable conversation.**
   The host preserves the Boss turns, Captain replies, and action outcomes needed to restore that conversation if its agent-side continuity is lost.
   Replacing the conversation never replaces the engagement stack, player sessions, or completed work.
   Only a definite pre-execution session rejection permits one immediate fresh attempt; an ambiguous execution stays uncertain ([DR-049](049-portable-session-contract.md)).
   Sub-runtime judge calls stay fresh and isolated from this conversation.

4. **Conversation and control share one loop.**
   The Captain may reply naturally or select at most one action for the turn: start, switch, dismiss, deliver, or a recovery action the active runtime currently advertises.
   Registered commands may resolve that selection deterministically, and an embedding host may decide a runtime-action turn itself ([DR-051](051-host-selected-runtime-recovery.md)); both follow the same validation, execution, result, and reply path.
   Multi-playbook planning continues conversationally across Boss turns rather than as an intra-turn action plan.
   Automatic work follows only a stop produced by an operation of the same turn ([DR-073](073-durable-step-progress.md)).

5. **Policy, effects, and playbook state have separate owners.**
   The Captain owns conversation, intent, and action selection; its ordinary decisions, replies, and adjudication are tool-free, while a selected recovery action may run a separate bounded preparation call ([DR-069](069-captain-prepares-step-recovery.md)).
   The shell owns registry and stack effects, validation, presentation, and recovery history.
   Each working runtime owns its current state and the recovery actions valid from that state.

6. **Every selected action returns through one result path.**
   Success, rejection, failure, and partial completion are reported to the same Captain conversation, and its reply is grounded only in those reported facts.
   CODE, REVIEW, and DECIDE results are grounded in accepted outcomes and canonical structured settlements rather than aggregate player or judge prose, and the reply reports the exact receipt identity available ([DR-040](040-outcome-authority-effect-reconciliation.md)).
   A report may quote bounded, attributed visible player prose only once its accepted outcome matches its acknowledged repository receipt ([DR-077](077-portable-assets-and-inspection.md)).
   Input acceptance and the repository changes presented to Boss are recorded at their source ([DR-073](073-durable-step-progress.md)).
   A switch reports dismissal and start separately when only one succeeds.
   A failed model or presentation phase never causes an action to run again, and rejection has no separate status-only or carry-forward path.

7. **A conversational handoff carries the complete agreed request.**
   When the Captain starts or switches to a playbook after discussion, it may hand off the request accumulated across Boss turns, while preserving the original Boss turns in session history and adding no unrequested work.

8. **Summaries remain factual and conditional.**
   A turn summary is grounded in the action result, and a saved-counts line appears only when the turn recorded nonzero counted activity.

This places the session Captain outside the engagement stack of [DR-011](011-composable-playbook-execution.md), replacing the per-intent internal root, intra-turn multi-child plans, and hidden lifecycle classifier of [DR-012](012-default-captain-playbook.md) and the isolated per-turn Captain calls of [DR-013](013-routing-only-captain-control.md); [DR-031](031-shared-captain-session-front-ends.md) makes the interactive and headless front ends host this same session design.
The CAPTAIN and CAPPLAY item packages define the observable and implementation contracts.

## Consequences

- The Captain can chat while a playbook is active without moving it, and can act on a current runtime only through validated choices.
- A lost model conversation is recoverable without forgetting the session or repeating completed work.
- One result path keeps the Boss-visible reply and the Captain's remembered outcome aligned.
- The authority split stays clear: the Captain selects playbooks; each playbook classifies its own FSM events.
- Runtime APIs, recovery-history representation, prompt construction, retry mechanics, and test structure belong to item specs and intent records rather than this decision.
