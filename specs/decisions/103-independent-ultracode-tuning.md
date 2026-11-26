<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-103: Independent Ultracode tuning

## Status

Accepted (2026-11-14).
Amends [DR-021](021-inline-agent-settings.md), [DR-027](027-runtime-compatibility-from-cligent.md), [DR-032](032-explicit-roles-session-players.md).
Amended by [DR-105](105-runtime-owned-seed-and-delegation.md).

## Context

Claude workflows can be selected independently of reasoning effort.
The existing `effort: ultracode` shorthand combines xhigh effort with enabled workflows.
Cligent 0.39 is the required floor for independent boolean tuning.

## Decision

- Captain and player blocks and role bindings admit optional `ultracode:boolean` as mutable tuning, independent of effort and excluded from structural identity.
- A role inherits its player's omitted value; complete calls use the current effective value, ordinary reopening refreshes it, and uncertain retry retains attempted tuning.
- Legacy effort shorthand remains supported, with an explicit workflow boolean taking precedence.
- The installed Cligent validates the field per adapter, as [DR-027](027-runtime-compatibility-from-cligent.md) decides for every capability, and the public Captain module reports its adapter-scoped Ultracode capability for embedding hosts through Cligent's public export ([DR-105](105-runtime-owned-seed-and-delegation.md)).
- Claude receives either explicit boolean. Other adapters reject an enabled request and accept a disabled one without receiving the field.

## Consequences

Hosts use the adapter-scoped capability to offer independent tuning.
Existing configs that omit the field retain their behavior, and existing session structure remains compatible with current tuning.
Hosts sharing records containing the new execution field need validators that understand it.
