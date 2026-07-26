<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-021: Inline agent settings

## Status

Accepted.
Supersedes the top-level `profiles` map and the agent-block `profile` key of [DR-009](009-generic-playbook-cli-and-registry.md).

## Context

[DR-009 §Config model](009-generic-playbook-cli-and-registry.md) gave the generic config a top-level `profiles` map of reusable agent settings, referenced by a scalar `captain` / `players.<role>` value or by an agent block's `profile` key.
The seeded lineup ships three of them — `claude-opus`, `claude-opus-1m`, `codex-gpt` — one per distinct agent/model pairing.

Reuse turned out to be the wrong default for how the config is actually edited.
Tuning is per player: a user wants this Coder on a larger context window, that Reviewer on a different model, one role at higher effort, one role with an extra writable path.
Under `profiles`, changing one player means either editing a profile that other players share — silently retuning them too — or minting a new profile id for a single use, which is the common case and pure ceremony.

The indirection also costs more than it saves at this size.
A reader of `players.coder: claude-opus-1m` has to resolve an id in another block to learn the adapter, model, effort, and permissions; the profile ids exist only to be dereferenced once.
It adds its own failure modes — a `profile` key naming no known profile, and a profile id colliding with an adapter shorthand, which the launcher must reject specifically ([PBCLI-8](../dev/playbook-cli.md#pbcli-8)).
Duplication across two or three agents is cheaper than an indirection layer plus its validation.

## Decision

### 1. Agent settings are inline

The top-level `profiles` map and the agent-block `profile` key are removed.
Every `captain` and `players.<role>` value is either an adapter shorthand or a complete tmux-play agent block carrying its own `adapter`, `model`, `effort`, and `permissions` as needed.
A scalar therefore has exactly one meaning — an adapter shorthand — and an agent block is self-contained, so a reader learns an agent's full settings from the block in front of them and retuning one player cannot move another.

### 2. The seeded config inlines its lineup

The starter config ships the same three agents with their settings written out under `captain` and each `playbooks.<id>.players.<role>`.
The seeded lineup, models, efforts, and permissions are unchanged; only the indirection is gone.

### 3. A profiles-bearing config fails with a migration diagnostic

An existing config keeps working only if the user rewrites it, because a scalar that used to name a profile now reads as an adapter shorthand.
Silently treating `claude-opus` as an adapter would surface far downstream as an unknown-adapter warning and a tmux-play launch failure.
The launcher shall therefore reject a config that still carries a top-level `profiles` map or an agent-block `profile` key, naming the config path and how to inline the settings, and shall not launch.
This is a one-time, clearly explained break rather than a compatibility shim that would keep the removed model alive in code.

### 4. Preserved scope

- No change to the `playbooks` model, the launcher-owned keys, roster generation, readiness, or the `run` defaults block ([DR-017](017-run-defaults-config.md)), none of which read `profiles`.
- No change to `playbook run`'s `<adapter>[:<model>][@<effort>]` agent grammar ([DR-015](015-per-run-agent-tuning.md)), which was already inline.
- Agent-block schema and per-agent fields stay exactly as cligent's tmux-play defines them.

## Consequences

- Per-player tuning — the common edit — touches exactly one block and cannot affect another agent.
- The config gains some duplication across agents that share a model; at the seeded size of three agents this is smaller than the indirection it replaces.
- Two validation rules disappear with the feature: the unresolvable `profile` reference and the profile-id/adapter-shorthand collision.
- Existing configs must inline their profiles once, guided by a launcher diagnostic; this is a breaking config change and takes a major version.
