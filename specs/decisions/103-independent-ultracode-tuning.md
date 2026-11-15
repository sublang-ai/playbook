<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-103: Independent Ultracode tuning

## Status

Accepted (2026-11-14).
Amends [DR-021](021-inline-agent-settings.md) and [DR-032](032-explicit-roles-session-players.md) with an independent boolean tuning field.
Extends [DR-027](027-runtime-compatibility-from-cligent.md)'s installed-runtime capability rule to independent Ultracode.

## Context

Claude workflows can be selected independently of reasoning effort.
The existing `effort: ultracode` shorthand combines xhigh effort with enabled workflows.
Older Cligent releases cannot honor an independent disabled setting beside that shorthand.

## Decision

- Captain and player blocks and role bindings admit optional `ultracode:boolean` as mutable tuning, independent of effort and excluded from structural identity.
- A role inherits its player's omitted value; complete calls use the current effective value, ordinary reopening refreshes it, and uncertain retry retains attempted tuning.
- Legacy effort shorthand remains supported, with an explicit workflow boolean taking precedence on capable runtimes.
- Independent support comes from the installed Cligent probe, exposed through the public Captain module for embedding hosts; a missing probe reports no support without raising the published dependency floor.
- Either explicit boolean on incapable Claude rejects with update guidance, since silent omission cannot enforce disabled workflows; other incapable adapters accept false without receiving the unsupported field.

## Consequences

Hosts can detect the complete Playbook-to-Cligent capability before offering independent tuning.
Existing configs that omit the field retain their behavior, and existing session structure remains compatible with current tuning.
Hosts sharing records containing the new execution field need validators that understand it.
