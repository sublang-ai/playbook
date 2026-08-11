<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-030: Shared mapped-player continuity

## Status

Accepted.

## Context

Composable playbooks may assign the same role to related work.
CODE and DECIDE now call REVIEW, and their shared Coder or Reviewer must retain the conversation that already holds the intent, proposal, findings, and rebuttals.
The existing host instead gives every playbook a separate namespaced player and every runtime a private resume-token map, so a nested same-role call starts a new backend conversation.

## Decision

- Runtime frames and playbook-session identities remain distinct.
- A nested child role with the same role id as an ancestor role inherits the nearest ancestor's host-player binding.
- A child role with no matching ancestor uses its own namespaced host-player binding.
- An inherited binding is authoritative for that frame; the child's configured same-role agent is its standalone fallback and is not applied to the already-running ancestor conversation.
- One root engagement tree owns continuation for every effective binding, including bindings first introduced by a child.
- A new root engagement starts with fresh continuation, while child return or disposal does not erase continuation retained by its root tree.
- A composed frame shall read its root-owned continuation before the player-start trace and call, then update or clear it from the validated result before the player-finish trace and result interpretation.
- A standalone runtime shall retain its private continuation store.
- Player identity metadata and visible panes shall follow each frame's effective bindings.
- Exact role-name inheritance needs no source syntax; explicit role renaming remains outside this decision.

## Consequences

- CODE to REVIEW shares Coder, while REVIEW's additional Reviewer uses REVIEW's configured player and remains continuous within that CODE engagement.
- DECIDE to REVIEW shares both Coder and Reviewer, so REVIEW can use their independent proposals without replaying them as reconstructed context.
- Unrelated root engagements and unrelated role names remain isolated.
- cligent needs no change because its player-call boundary already accepts an explicit fresh-or-resume selection.

## References

- [DR-010](010-playbook-session-tracing-and-resume.md) defines runtime-local player continuation.
- [[playbook-runtime-58](../packages/playbook-runtime.md#playbook-runtime-58)] defines the shared store boundary.
