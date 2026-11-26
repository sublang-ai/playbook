<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-074: Seeds Name the Latest Models

## Status

Accepted (2026-09-28).
Amends [DR-044](044-dev-planning-workflow.md), [DR-053](053-seeding-picks-a-ready-adapter.md).
Amended by [DR-105](105-runtime-owned-seed-and-delegation.md).

## Context

The starter's seed table named `claude-opus-5` for `claude` and `gpt-5.6-sol` for `codex`, and the documentation's examples, the live acceptance gate's Codex defaults, and the CI acceptance configuration named these models or older ones.
Both lines have a newer model: Claude Opus 5.5 (`claude-opus-5-5`) and GPT-6 Sol (`gpt-6-sol`).
[DR-053](053-seeding-picks-a-ready-adapter.md) left model currency out of scope and accepted that a seeded model goes stale.
A seed is what a new user runs first and an example is what a reader copies, so a stale name there puts the first run and the documented path on a superseded model.
Two examples also retuned the Claude-seeded `dev.coder` to a Codex model, which a Claude agent cannot run.

What held the seed at `claude-opus-5` is a rule the seed keeps: a seeded starter runs on every install Playbook supports.
Which runtime version serves which model is Cligent's knowledge, not Playbook's ([DR-027](027-runtime-compatibility-from-cligent.md)).
Cligent's runtime floors are the lowest versions serving every model its declared behavior depends on, and the launch gate refuses a runtime below them with Cligent's repair ([[playbook-cli-40](../packages/playbook-cli.md#playbook-cli-40)]).
Cligent 0.27's floors serve `claude-opus-5` and the GPT-5.6 routes but neither newer model, so seeding either would install cleanly and could fail the first call on a supported install.
Cligent 0.28.0 raises its Claude floor to the first runtime release serving `claude-opus-5-5` and its Codex floor to the first serving the GPT-6 family.

## Decision

- Every starter, default, or seed configuration and every user-facing example Playbook ships shall name the latest model of its line, a model currency [DR-053](053-seeding-picks-a-ready-adapter.md) left out of scope.
  This covers the seeded lineup ([[playbook-cli-11](../packages/playbook-cli.md#playbook-cli-11)]), whose models Cligent selects under [DR-105](105-runtime-owned-seed-and-delegation.md), the documentation's examples, the live acceptance gate's default models, and the CI acceptance configuration.
- The seeded `dev.analyst` player of [DR-044](044-dev-planning-workflow.md) takes its adapter's seeded model rather than a fixed one; the player, its binding, and everything else of that record stand.
- Each example shall run as written against the default seed: an example retuning a seeded player names a model of that player's adapter, and an example on another adapter names that adapter.
- Playbook's declared Cligent floor shall rise, where it is older, to the oldest Cligent release whose runtime floors serve every seeded model, so a seeded model and the floor serving it move together and no release seeds a model its Cligent floor does not serve.
  Playbook keeps no runtime-version knowledge of its own; it relies on Cligent's floors as [DR-027](027-runtime-compatibility-from-cligent.md) decided.
- Records of past runs — experiment evidence and fixtures captured from runs — keep the models they recorded, and test fixtures that stand for no default keep arbitrary names.

## Consequences

- A fresh install seeds the latest models its credentials select, on a runtime the declared Cligent range guarantees can serve them.
- Existing configs are untouched: seeding writes only an absent file, and every seeded value stays tunable in place ([[playbook-cli-6](../packages/playbook-cli.md#playbook-cli-6)]).
- Installs whose agent runtimes predate the seeded models lose support; they meet the launch gate's named repair instead of a failed first call.
- Adopting each newer model is a maintenance change to the examples, the gates, and the Cligent floor together, made once a Cligent release serves it.
