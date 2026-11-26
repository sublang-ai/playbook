<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-105: Runtime-owned seed and control-call delegation

## Status

Accepted (2026-11-14).
Amends [DR-032](032-explicit-roles-session-players.md), [DR-053](053-seeding-picks-a-ready-adapter.md), [DR-074](074-seeds-name-the-latest-models.md), [DR-075](075-subagent-model-is-tuning.md), [DR-076](076-subagents-delegate-by-default.md), [DR-093](093-captain-control-turns-native-skills-off.md), [DR-099](099-seeds-run-at-medium-effort.md), [DR-103](103-independent-ultracode-tuning.md).

## Context

The owner selects different parent and delegated models for each adapter, and Cligent 0.39 supports child-model selections on both adapters.
Earlier Cligent releases lacked provider-specific model defaults and independent Claude Ultracode tuning, so Playbook kept its own fixed per-adapter model table.
A host’s provider environment and settings determine which model catalog its agents can use.
A tool-free Captain call cannot perform delegated work.

## Decision

- Release Playbook after Cligent 0.39.0 and require `^0.39.0`. Use its `defaultAgentModels` and `isUltracodeSupported` exports directly; this replaces the per-feature Cligent floors of [DR-075](075-subagent-model-is-tuning.md) and [DR-076](076-subagents-delegate-by-default.md).
- Keep adapter order, credential selection, efforts and role placement in Playbook. For each selected adapter, seed the primary and child models returned by Cligent for the effective provider, replacing the fixed model table of [DR-053](053-seeding-picks-a-ready-adapter.md) and [DR-074](074-seeds-name-the-latest-models.md). An empty result leaves both model fields unset.
- On the direct services Cligent returns the owner's pairs: Claude agents on `claude-fable-5-2` with child model `claude-opus-5-5`, and Codex agents on `gpt-6-astra` with child model `gpt-6.1-sol`; current examples and live-gate defaults follow these parent choices, while historical evidence and arbitrary model fixtures retain their recorded choices.
- Set the Claude SDK development floor to 0.3.325, the tested release serving the Fable parent model.
- An embedding host may supply a separate provider environment for model selection, with a local user home or a seat’s approved Codex settings directory. The separate environment defaults to no filesystem scope.
- A provider-default role selection removes the player’s primary pin for that call. For Claude, omission delegates selection to the native SDK; on resume, `ANTHROPIC_MODEL` from the process environment or native `settings.env` overrides the session selection, while the top-level `model` key in Claude Code’s own `settings.json` alone does not. A named selection explicitly switches models.
- Keep the existing per-role and `--with` tuning surfaces; a future breaking player-only model rule is deferred.
- Claude keeps its implicit inheritance. On Codex, an explicit child model or effort requests delegation.
- Tool-free routing, Judge, existing-instruction question checks, reporting, and forwarded empty-allowlist calls omit child model and effort. Working calls keep their configured tuning.
- Existing configs, adapter precedence, second-adapter reviewer selection, efforts, and permissions stay unchanged.

## Consequences

An official route receives the released primary and child model pair, and custom routes keep their provider’s defaults.
The launcher and embedding hosts use the same first-run rule, and hosts using the public seed export receive the same model pairs without duplicating a seed table.
Existing configs remain user-owned.
