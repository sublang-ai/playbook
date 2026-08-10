<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-004: CODE linker bindings and host integration

## Status

Accepted.
[DR-019](019-shared-linked-runtime-factory.md) moves CODE's single-region interpreter into the shared runtime factory.
[DR-011](011-composable-playbook-execution.md) supplies nested playbook-call semantics, and [DR-030](030-shared-mapped-player-continuity.md) supplies same-role continuity for CODE to REVIEW.

## Context

CODE must compile from its maintained workflow source into a host-agnostic runtime while preserving exact Coder instructions and delegating every commit review to REVIEW.
The generic Playbook Captain shell owns tmux integration, registry loading, player binding, and nested runtime sessions [[1]], so CODE must not carry a direct host adapter or duplicate those policies.

## Decision

### 1. Runtime profile

CODE shall compile as a single-region XState workflow backed by `createXStatePlaybookRuntime` under [DR-019](019-shared-linked-runtime-factory.md).
Its public module shall use the shared runtime types and six ports and shall contain no tmux-play host type or direct adapter.

### 2. Player and entry bindings

Source role `Coder` shall map to local role `coder`, which the shell resolves to the frame's effective host binding.
A fresh nonempty input shall enter through deterministic event `START_CODE` with the exact text in `callerInput`, without a classifier call.
CODE shall declare only the Coder player because review work belongs to the nested REVIEW workflow.

### 3. Nested REVIEW boundary

After each CODE-owned Coder commit, CODE shall invoke enabled playbook `review` with the authored request and suspend until the child returns under [DR-011](011-composable-playbook-execution.md).
The child Coder shall inherit CODE's effective `coder` binding and continuation, while the child's `reviewer` role shall use its own fallback unless an ancestor already supplies that role under [DR-030](030-shared-mapped-player-continuity.md).
CODE shall validate REVIEW's declared success output before advancing and shall terminate with the child failure and exact last CODE-owned commit on an abort, error, or invalid success.
After REVIEW passes the direct phase or final IR task, CODE shall report its exact last CODE-owned commit rather than a later review-fix commit.

### 4. Registry boundary

CODE shall be enabled through the public `@sublang/playbook/code/registry` manifest under [DR-009](009-generic-playbook-cli-and-registry.md).
The registry shall declare only role `coder`, reject nonempty workflow options, derive Coder identity from the effective binding, and let the generic shell own ports, visibility, summaries, and lifecycle.

## Consequences

- CODE's machine describes coding phases and child calls without duplicating the review protocol.
- REVIEW can evolve as one reusable workflow for CODE, DECIDE, and standalone runs.
- The reviewed commit is never amended, and a later CODE phase cannot begin after an unsettled child failure.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/docs/tmux-play.md#custom-captains "cligent tmux-play custom Captains"
