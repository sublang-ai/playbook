<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-007: Hide judge control work from Boss

## Status

Accepted.

## Context

Linked workflows use `callJudge` for classification and adjudication, whose JSON replies are control-plane data rather than Boss-facing prose.
Displaying those replies would duplicate the runtime's human-readable status and expose machine contracts on the Boss pane.
The generic Playbook Captain shell now owns every workflow's host bridge, while CODE contains no direct tmux-play adapter under [DR-004](004-link-code-fsm-to-playbook-runtime.md).
Hiding a judge reply also removes any incidental view of a player's clarifying question, so the runtime must present that question explicitly.

## Decision

### 1. Generic shell ownership

The Playbook Captain shell shall route every sub-runtime `callJudge` through its shared Captain-session queue to `context.callCaptain` with `{ visibility: 'hidden' }`, and no workflow-specific adapter shall own that routing.
Each hidden judge call shall remain fresh and isolated from the durable session-Captain conversation, and the shell shall return only a valid final reply to the calling runtime [[playbook-captain-9](../packages/playbook-captain.md#playbook-captain-9)] [[playbook-captain-10](../packages/playbook-captain.md#playbook-captain-10)].
The runtime shall identify adjudication prompts as hidden control work and shall validate the returned machine contract before acting on it [[playbook-runtime-10](../packages/playbook-runtime.md#playbook-runtime-10)].

### 2. Runtime-owned visible presentation

The runtime shall remain the sole composer of Boss-facing workflow progress, so raw judge JSON never reaches a visible pane.
On entry to a Boss-reply wait, it shall emit the full untruncated `<player> asks: <question>` as Captain speech and then the rider-less routing marker `◆ awaiting Boss reply · <resumeStateId> · <player> · <sourceItem>` [[playbook-runtime-3](../packages/playbook-runtime.md#playbook-runtime-3)].
Telemetry may retain the verbatim pending question for non-tmux-play hosts.

### 3. Scope

This decision governs the playbook shell and linked-runtime boundary, not cligent's internal implementation of hidden visibility.
It introduces no CODE-specific host type, adapter, or port beyond the generic contracts.

## Consequences

- The Boss pane carries human-readable workflow status without duplicate judge JSON.
- Every enabled workflow receives the same hidden-judge behavior through the generic shell.
- A suspended player's full question remains visible even though its adjudication reply is hidden.
- The durable session-Captain conversation is not contaminated by fresh judge calls.
