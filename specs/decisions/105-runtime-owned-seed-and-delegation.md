<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-105: Runtime-owned seed and control-call delegation

## Status

Accepted (2026-11-14).
Amends [DR-104](104-parent-and-child-seed-models.md) in model ownership and compatibility, and [DR-076](076-subagents-delegate-by-default.md) in Codex's implicit delegation.
Extends [DR-093](093-captain-control-turns-native-skills-off.md)'s isolation to delegation settings.

## Context

Cligent 0.38 admits a Claude SDK older than the first release serving Fable 5.2.
The provider environment visible to a host can also select a different model catalog.
A tool-free Captain call cannot perform delegated work.

## Decision

- Keep the compatible Cligent ranges `^0.38.0 || ^0.39.0`. Seed the installed Cligent model pair for the effective provider. With no such API, leave both models to the provider.
- Keep adapter order, credentials, efforts and role placement in Playbook. An embedding host can supply its effective provider environment independently of the credential inputs.
- Claude keeps its implicit inheritance. On Codex, only an explicit delegation selection adds a directive.
- Omit child model and effort from tool-free routing, Judge, question checking and reporting calls. Working calls keep their configured tuning.

## Consequences

Each installed adapter owns its serving models. The launcher and its embedding hosts use the same first-run rule.
Independent Ultracode capability follows the established installed-runtime gate.
