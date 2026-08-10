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
- One root engagement tree owns continuation for every effective binding, including bindings first introduced by a child.
- A new root engagement starts with fresh continuation, while child return or disposal does not erase continuation retained by its root tree.
- The runtime shall select and update continuation through the host-supplied binding before it traces or calls the player, so trace data records the exact resume selection used.
- Player identity metadata and visible panes shall follow each frame's effective bindings.
- Exact role-name inheritance needs no source syntax; explicit role renaming remains outside this decision.

## Consequences

- CODE to REVIEW shares Coder, while REVIEW's additional Reviewer uses REVIEW's configured player and remains continuous within that CODE engagement.
- DECIDE to REVIEW shares both Coder and Reviewer, so REVIEW can use their independent proposals without replaying them as reconstructed context.
- Unrelated root engagements and unrelated role names remain isolated.
- cligent needs no change because its player-call boundary already accepts an explicit fresh-or-resume selection.
