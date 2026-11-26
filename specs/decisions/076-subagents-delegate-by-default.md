<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-076: Subagents Delegate by Default, at an Effort of Their Own

## Status

Accepted (2026-10-01).
Amends [DR-075](075-subagent-model-is-tuning.md).
Amended by [DR-105](105-runtime-owned-seed-and-delegation.md).

## Context

[DR-075](075-subagent-model-is-tuning.md) made the subagent model tuning, and Cligent 0.29 enforced it.
Two gaps surfaced on the first use.
An agent's effort governs its subagents too, since Claude's effort is one session setting and the Agent tool carries none per call; an agent at `ultracode` therefore ran its fine-grained delegations at `ultracode`, which the owner called a loophole.
And the default did nothing: a block that named no subagent model told its agent nothing about delegating, although delegating well-bounded work is the practice the owner wants every agent to follow.

Cligent 0.30 answers both at the adapter, through subagent definitions the Agent tool lists [[1]]: `subagentModel` admits `inherit`, the agent's own model; `subagentEffort` pins an effort, or, omitted, leaves the choice to the agent per task; and the directive's first sentence follows the two settings.
A pinned effort governs the `delegate` definition and the `general-purpose` one the adapter replaces; where the agent chooses, `delegate-<effort>` definitions carry its choice, and a call naming no type lands on `general-purpose` at `medium`.
`Explore` and `Plan` are never replaced and keep the agent's own effort, so an agent at `ultracode` still runs those two at `ultracode`.

## Decision

### 1. `subagentModel` defaults to `inherit` on Claude

The subagent model of [DR-075](075-subagent-model-is-tuning.md) admits `inherit`, the agent's own model.
A Claude agent block that leaves `subagentModel` unset resolves to `inherit`: its subagents run on its own model and it receives the delegation directive.
On Codex an unset field requests no delegation, and an explicit child model or effort requests it ([DR-105](105-runtime-owned-seed-and-delegation.md)).
A nonblank string pins a model, `inherit` names the agent's own explicitly, and `false` selects the runtime's own order with no directive — the way to switch delegation off.
Adapters serving none resolve to nothing, as before.

### 2. `subagentEffort` is a fifth tuning field

A `captain` or `players.<player-id>` block, a `playbooks.<id>.roles.<role>` binding, and a `--with` overlay may carry `subagentEffort`: a value of the adapter's effort vocabulary other than its orchestration value, pinning the effort of the `delegate` and `general-purpose` subagents but not of `Explore` or `Plan`; `false` on a binding selects the provider default, and omission inherits.
Resolved to absence it means the agent chooses per task.
It is validated through the installed Cligent against the block's adapter and the resolved subagent model, carried in every complete call setting beside `subagentModel`, erased from the structural projection, and free to differ on an ordinary reopen.

### 3. The seed names no subagent effort

The seed carries no `subagentEffort` and the child model Cligent returns ([DR-105](105-runtime-owned-seed-and-delegation.md)); the documentation shows both fields once in the role-binding form with what they do.

## Consequences

- Every Claude agent of an existing config now delegates by default: its runs carry the directive and the definitions, and its subagents run on its own model, at efforts the agent chooses except `Explore` and `Plan`, which keep its own — a behavior change this release names in its changelog, with `subagentModel: false` as the way back.
- Session records written by this release may carry `subagentEffort`; a host on 17.2 that reads one rejects the unknown field, so hosts sharing a session store upgrade together.
- The release-capability guard probes the new setting, which the Cligent floor of [DR-105](105-runtime-owned-seed-and-delegation.md) serves.
- This is additive in surface and ships in a MINOR release.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/decisions/029-subagent-effort.md "cligent DR-029 — subagent effort"
