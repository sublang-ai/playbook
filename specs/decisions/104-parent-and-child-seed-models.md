<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-104: Parent and Child Seed Models

## Status

Accepted (2026-11-14) on the owner's direction.
Amends [DR-076](076-subagents-delegate-by-default.md) §3 in writing explicit child models, and [DR-074](074-seeds-name-the-latest-models.md), [DR-075](075-subagent-model-is-tuning.md), and [DR-099](099-seeds-run-at-medium-effort.md) in the seeded model choices.

Amended in shared runtime model ownership and provider defaults under [DR-105](105-runtime-owned-seed-and-delegation.md).

## Context

The owner selects different parent and delegated models for each adapter.
Cligent 0.39 supports child-model selections on both adapters.

## Decision

- Seed Claude agents with `claude-fable-5-2` and child model `claude-opus-5-5`, and Codex agents with `gpt-6-astra` and child model `gpt-6.1-sol`.
- Use these pairs on the direct services. Cligent selects the applicable models for the provider under [DR-105](105-runtime-owned-seed-and-delegation.md).
- Set the Claude SDK development floor to 0.3.325, the tested release serving the Fable parent model.
- Keep existing configs, adapter precedence, second-adapter reviewer selection, efforts, and permissions unchanged.
- Current examples and live-gate defaults follow these parent choices; historical evidence and arbitrary model fixtures retain their recorded choices.

## Consequences

Existing configs remain user-owned.
Hosts using the public seed export receive the same model pairs without duplicating the seed table.
