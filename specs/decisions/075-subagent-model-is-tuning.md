<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-075: The subagent model is tuning

## Status

Accepted (2026-09-30).
Amends [DR-021](021-inline-agent-settings.md) §1 and [DR-032](032-explicit-roles-session-players.md): an agent block and a role binding carry a fourth tuning field, `subagentModel`.
Amends [DR-074](074-seeds-name-the-latest-models.md) in its Cligent floor alone: `^0.29.0`, the first release whose Claude adapter serves the field.
Cites [DR-027](027-runtime-compatibility-from-cligent.md): capability validation of the field is delegated to the installed Cligent, and Playbook keeps no adapter support list of its own.
Amended by [DR-076](076-subagents-delegate-by-default.md): the field admits `inherit` and defaults to it where the adapter serves one, and `subagentEffort` joins it as a fifth tuning field.

## Context

Cligent 0.29 adds an adapter-scoped option `subagentModel`: on Claude it makes every subagent of a run use the named model and tells the agent, through the run's system prompt, to hand well-defined, fine-grained tasks to subagents while keeping the deep thinking, reasoning, and design work itself, without lowering delivered quality.
Cligent's tmux-play admits the key on Captain and player blocks and carries it in complete call settings as an optional string whose omission selects the provider default.

Playbook's config model already knows two kinds of agent field.
Structural fields — `adapter`, `instruction`, `permissions` — define the stable player envelope: a session reopen compares them and fails closed on drift, and a role binding may not override them.
Tuning fields — `model`, `effort`, `fastMode` — may differ on an ordinary reopen, may be overridden per role binding and by a `--with` overlay, and reach the provider as complete call settings on every call.

Which kind is the subagent model?
It changes no tool, no permission, no instruction, and no conversation owner: the same player, on the same envelope, delegates to a different model, and a host wanting a stronger main model for one afternoon with a cheaper subagent model wants it the way it wants a model — for one session, from the next message, without moving a default.
The runtime applies it per call, exactly as it applies the model.
It is tuning.

## Decision

### 1. `subagentModel` is a tuning field on agent blocks and role bindings

A `captain` or `players.<player-id>` block may carry `subagentModel`, a nonblank string naming the model the agent's subagents use; the block's adapter must support it, and the launcher delegates that check to the installed Cligent contract exactly as it does for `fastMode`.
A `playbooks.<id>.roles.<role>` binding block may carry `subagentModel` beside `model`, `effort`, and `fastMode`: a nonblank string pins it for that role, boolean `false` selects the provider default explicitly, and omission inherits the player's top-level value.
A `--with` overlay may retune it like the other tuning fields.

### 2. It reaches the provider as an optional complete-call setting

The normalized `SessionAgent` and each normalized role binding carry `subagentModel?: string`; a provider-default selection resolves to absence.
The shell forms cligent's atomic complete-call settings with `subagentModel` taken from the binding's effective tuning for player calls and from the Captain's own tuning for Captain calls, so an omitted value is an explicit request for the provider default, never an inheritance of whatever the previous call left behind.

### 3. It is erased from the structural projection

The structural projection, the shell's fixed-agent snapshot, and the drift check that compares a reopen against the stored structure exclude `subagentModel` as they exclude `model`, `effort`, and `fastMode`, so a compatible change applies on the next provider call.
The execution projection, the shell snapshot's session agents, and the retained role bindings accept it as an optional string; a validator that lists the accepted keys lists it.

### 4. Nothing is seeded

The starter config names no subagent model, and no example turns it on by default; the documentation shows the field once, in the role-binding form, with what it does.

## Consequences

- The config gains one optional key in three places — agent blocks, role bindings, overlays — with the grammar the three tuning fields already have; a config that omits it is unchanged in every projection and every call.
- The Cligent floor rises to `^0.29.0`, an additive release, so a host that installs this Playbook resolves one Cligent whose `AgentCallSettings` carries the field; the release-capabilities check probes it.
- Session records written by this release may carry `subagentModel` in execution projections and shell snapshots; a host on 17.1 that reads such a record rejects the unknown field, so hosts sharing a session store upgrade together, and a record without the field reopens under both.
- This is additive and ships in a MINOR release.
