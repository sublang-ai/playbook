<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-021: Inline agent settings

## Status

Accepted.
Supersedes the top-level `profiles` map and the agent-block `profile` key of [DR-009](009-generic-playbook-cli-and-registry.md).
[DR-032](032-explicit-roles-session-players.md) moves inline agent blocks to identity-bearing top-level players and explicit role bindings; they do not regain profile indirection.

## Context

[DR-009](009-generic-playbook-cli-and-registry.md) §Config model gave the generic config a top-level `profiles` map of reusable agent settings, referenced by a scalar `captain` / `players.<role>` value or by an agent block's `profile` key.
The seeded lineup ships three of them — `claude-opus`, `claude-opus-1m`, `codex-gpt` — one per distinct agent/model pairing.

Reuse turned out to be the wrong default for how the config is actually edited.
Tuning is per player: a user wants this Coder on a larger context window, that Reviewer on a different model, one role at higher effort, one role with an extra writable path.
Under `profiles`, changing one player means either editing a profile that other players share — silently retuning them too — or minting a new profile id for a single use, which is the common case and pure ceremony.

The indirection also costs more than it saves at this size.
A reader of `players.coder: claude-opus-1m` has to resolve an id in another block to learn the adapter, model, effort, fast mode, and permissions; the profile ids exist only to be dereferenced once.
It adds its own failure modes — a `profile` key naming no known profile, and a profile id colliding with an adapter shorthand, which the launcher must reject specifically ([[playbook-cli-8](../packages/playbook-cli.md#playbook-cli-8)]).
Duplication across two or three agents is cheaper than an indirection layer plus its validation.

## Decision

### 1. Agent settings are inline

The top-level `profiles` map and the agent-block `profile` key are removed.
Every `captain` and top-level `players.<player-id>` value is either an adapter shorthand or a complete tmux-play agent block carrying its own `adapter`, `model`, `effort`, `fastMode`, and `permissions` as needed.
A scalar therefore has exactly one meaning — an adapter shorthand — and an agent block is self-contained, so a reader learns an agent's full settings from the block in front of them and retuning one player cannot move another.

### 2. The seeded config inlines its lineup

The starter config ships its agents with settings written under `captain` and top-level `players`, while every playbook role binds explicitly under `playbooks.<id>.roles` per [DR-032](032-explicit-roles-session-players.md).
The seeded lineup and its current adapter, model, effort, fast-mode, and permission defaults are governed by the starter contract rather than by profile indirection.

### 3. An existing config migrates itself once

Every user who has ever launched `playbook` has a profiles-based config, because the seeded default used one; requiring each of them to hand-edit before the tool runs again is friction the change does not need to impose.
The launcher shall therefore migrate a config that still carries a top-level `profiles` map or an agent-block `profile` key: inline each referenced profile's settings into the agent that named it, with the agent block's own fields staying authoritative over the profile's, drop the `profiles` map, write the pre-migration file beside the config as a `.bak` that never overwrites an existing file, rewrite the config in place, name both paths on stderr, and continue the launch.
The rewrite shall go through a YAML document edit so the user's own comments survive, and shall leave a short note at the top of the file recording the migration and pointing at the backup.
Migration is on the user's config only.
A `profile` key introduced by a `--with` overlay, or a config the launcher cannot migrate, shall still be rejected with a diagnostic naming the path and the inline replacement, since overlays are authored against the current model.
Migration is idempotent: a migrated config carries nothing to migrate on the next launch, so the shim runs once per config and can be retired once configs have turned over.

### 4. Preserved scope

- The original release did not change the `playbooks` model, launcher-owned keys, roster generation, or readiness; [DR-032](032-explicit-roles-session-players.md) subsequently changes those surfaces for explicit bindings.
- [DR-031](031-shared-captain-session-front-ends.md) subsequently retired the separate `run` defaults block and run-only agent grammar; [DR-032](032-explicit-roles-session-players.md) gives both front ends the same inline Captain, top-level player, and role-binding blocks.
- Agent-block schema and per-agent fields stay exactly as the installed cligent tmux-play loader defines and normalizes them.

## Consequences

- Per-player tuning — the common edit — touches exactly one block and cannot affect another agent.
- The config gains some duplication across agents that share a model; at the seeded size of three agents this is smaller than the indirection it replaces.
- Two validation rules disappear with the feature: the unresolvable `profile` reference and the profile-id/adapter-shorthand collision.
- Existing configs are rewritten in place on the next launch, with the original kept as a `.bak`; the config format still changes incompatibly, so this takes a major version.
