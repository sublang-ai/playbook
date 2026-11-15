<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-105: Runtime-owned seed and control-call delegation

## Status

Accepted (2026-11-14).
Amends [DR-104](104-parent-and-child-seed-models.md) in model ownership and provider selection, and [DR-076](076-subagents-delegate-by-default.md) in Codex's implicit delegation.
Amends [DR-093](093-captain-control-turns-native-skills-off.md) in isolating tool-free calls from delegation settings.
Amends [DR-053](053-seeding-picks-a-ready-adapter.md) and [DR-074](074-seeds-name-the-latest-models.md) in replacing their fixed model table with Cligent’s provider-specific selection.
Amends [DR-103](103-independent-ultracode-tuning.md) in requiring Cligent’s public Ultracode capability export.

Amends [DR-032](032-explicit-roles-session-players.md) for a provider-default primary model on a resumed Claude conversation.

## Context

Cligent 0.38 lacks provider-specific model defaults and independent Claude Ultracode tuning.
A host’s provider environment and settings determine which model catalog its agents can use.
A tool-free Captain call cannot perform delegated work.

## Decision

- Release Playbook after Cligent 0.39.0 and require `^0.39.0`. Use its `defaultAgentModels` and `isUltracodeSupported` exports directly.
- Keep adapter order, credential selection, efforts and role placement in Playbook. For each selected adapter, seed the models returned by Cligent for the effective provider. An empty result leaves both model fields unset.
- An embedding host may supply a separate provider environment for model selection, with a local user home or a seat’s approved Codex settings directory. The separate environment defaults to no filesystem scope.
- A provider-default role selection removes the player’s primary pin for that call. For Claude, omission delegates selection to the native SDK; on resume, `ANTHROPIC_MODEL` from the process environment or native `settings.env` overrides the session selection, while `settings.model` alone does not. A named selection explicitly switches models.
- Keep the existing per-role and `--with` tuning surfaces; a future breaking player-only model rule is deferred.
- Claude keeps its implicit inheritance. On Codex, an explicit child model or effort requests delegation.
- Tool-free routing, Judge, existing-instruction question checks, reporting, and forwarded empty-allowlist calls omit child model and effort. Working calls keep their configured tuning.

## Consequences

An official route receives the released primary and child model pair, and custom routes keep their provider’s defaults.
The launcher and embedding hosts use the same first-run rule.
