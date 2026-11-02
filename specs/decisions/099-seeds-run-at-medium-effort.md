<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-099: Seeds Run at Medium Effort, and a Second-Adapter Reviewer at High

## Status

Accepted (2026-11-02) on the owner's direction.
Amends [DR-053](053-seeding-picks-a-ready-adapter.md) in its efforts: every seeded agent takes `medium` instead of `high` or `xhigh`.
Amends [DR-096](096-a-second-adapter-reviews.md) in "The Reviewer keeps its own effort": a `dev.reviewer` seeded on the second adapter takes `high`.
Applies [DR-074](074-seeds-name-the-latest-models.md) to the Codex row: `gpt-6.1-sol` is now the latest Sol model.
Selection, precedence, the none-ready notice and the public seed export stand.

## Context

- The seed ran the Captain, Coder and Inspector at `high` and the Reviewer and Analyst at `xhigh`; the owner judges `medium` enough for a first run, and cheaper and faster for those who meet Playbook first through a workshop.
- A Reviewer on Codex beside Claude agents brings another provider's view to the same change; the owner keeps it one step above the rest, at `high`.
- OpenAI's latest Sol model is GPT-6.1 Sol (`gpt-6.1-sol`); Codex bundles it from 0.159.1, and Cligent's Codex floor rises to that release.
- A Reviewer seeded on the first adapter — Claude alone ready, behind any Anthropic-compatible service — stays with the rest, so a seed never names a Codex model where Codex is not ready.

## Decision

- The template's Captain and every player take effort `medium`.
- Where both adapters are ready, `dev.reviewer` takes the second row's adapter and model with effort `high`; where it takes the first row, it keeps the template's `medium`.
- The Codex row names `gpt-6.1-sol`.
- Playbook's Cligent floor rises to the first Cligent release whose Codex floor is 0.159.1, per [DR-074](074-seeds-name-the-latest-models.md), and its Codex SDK development floor to 0.159.1.

## Consequences

- A fresh seed runs every agent at `medium`, a Codex Reviewer beside Claude agents at `high` on `gpt-6.1-sol`.
- Existing configs are untouched: seeding writes only an absent file, and every effort stays tunable in place.
- Hosts seeding through `@sublang/playbook/seed-config` pick up the new efforts and model by upgrading Playbook.
- Codex runtimes below 0.159.1 are refused by the launch gate with Cligent's named repair.
