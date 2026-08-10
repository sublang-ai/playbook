<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-029: Session-scoped conversational Captain

## Status

Accepted.

## Context

The interactive Captain did not remember earlier turns, could not reliably continue a failed playbook, and sometimes reported work that had not happened.
The Boss requires the Captain to know the whole session, converse naturally while operating playbooks, and choose, replace, clear, or resume a playbook from its current condition.

## Decision

1. **The Captain remains a compiled playbook.**
   It runs for the whole shell session as the controller outside the working-playbook stack, receives every non-empty Boss turn, and is never suspended behind a working playbook.

2. **The Captain keeps one recoverable conversation.**
   The host preserves the Boss turns, Captain replies, and action outcomes needed to restore that conversation if its agent-side continuity is lost.
   Replacing the conversation never replaces the engagement stack, player sessions, or completed work.

3. **Conversation and control share one loop.**
   The Captain may reply naturally or select at most one action for the turn: start, switch, dismiss, deliver, or a recovery action the active runtime currently advertises.
   Registered commands may resolve that selection deterministically, but follow the same validation, execution, result, and reply path.
   Multi-playbook planning continues conversationally across Boss turns rather than as an intra-turn action plan.

4. **Policy, effects, and playbook state have separate owners.**
   The Captain owns conversation, intent, and action selection.
   The shell owns registry and stack effects, validation, presentation, and recovery history.
   Each working runtime owns its current state and the recovery actions valid from that state.

5. **Every selected action returns through one result path.**
   Success, rejection, failure, and partial completion are reported to the same Captain conversation, and its reply is grounded only in those reported facts.
   A switch reports dismissal and start separately when only one succeeds.
   A failed model or presentation phase never causes an action to run again, and rejection has no separate status-only or carry-forward path.

6. **A conversational handoff carries the complete agreed request.**
   When the Captain starts or switches to a playbook after discussion, it may hand off the request accumulated across Boss turns, while preserving the original Boss turns in session history and adding no unrequested work.

7. **Summaries remain factual and conditional.**
   A turn summary is grounded in the action result, and a saved-counts line appears only when the turn recorded nonzero counted activity.

This decision supersedes the isolated per-turn Captain calls of DR-013, the hand-authored lifecycle classifier, and DR-012's intra-turn multi-child plans for the interactive shell.
It places the session Captain outside the DR-011 engagement stack and leaves headless `playbook run` unchanged.
The CAPTAIN and CAPPLAY item packages define the observable and implementation contracts.

## Consequences

- The Captain can chat while a playbook is active without moving it, and can act on a current runtime only through validated choices.
- A lost model conversation is recoverable without forgetting the session or repeating completed work.
- One result path keeps the Boss-visible reply and the Captain's remembered outcome aligned.
- Runtime APIs, recovery-history representation, prompt construction, retry mechanics, and test structure belong to item specs and intent records rather than this decision.
