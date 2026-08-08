<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-030: Turn transaction and prompt provenance

## Status

Superseded by [DR-029](029-session-scoped-conversational-captain.md).

## Context

Repeated fixes to the session Captain led this record to prescribe transaction states, delivery states, log cursors, and prompt-fragment provenance.
Those representations were attempts to repair separate result and memory paths, not product-level architectural requirements.

## Decision

Do not impose those representations.
DR-029 instead requires one action-result path and recoverable session continuity, leaving data structures and algorithms to the implementing iteration.
Validation that keeps internal control data out of Boss-visible prose remains the independent [CAPTAIN-9](../dev/playbook-captain.md#captain-9) contract; it is not part of the conversational-Captain goal.

## Consequences

- This record supersedes no CAPTAIN or CAPPLAY item.
- Implementations may use transactions, logs, or typed prompt fragments when useful, but conformance is judged by DR-029's observable behavior.
