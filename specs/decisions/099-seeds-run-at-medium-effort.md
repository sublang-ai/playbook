<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-099: Seeds Run at Medium Effort, and a Second-Adapter Reviewer at High

## Status

Accepted (2026-11-02).
Amends [DR-053](053-seeding-picks-a-ready-adapter.md), [DR-096](096-a-second-adapter-reviews.md).
Amended by [DR-105](105-runtime-owned-seed-and-delegation.md).

## Context

- The seed ran the Captain, Coder and Inspector at `high` and the Reviewer and Analyst at `xhigh`; the owner directed `medium`, judging it enough for a first run, and cheaper and faster for those who meet Playbook first through a workshop.
- A Reviewer on Codex beside Claude agents brings another provider's view to the same change; the owner keeps it one step above the rest, at `high`.
- A Reviewer seeded on the first adapter — Claude alone ready, behind any Anthropic-compatible service — stays with the rest, so a seed never names a Codex model where Codex is not ready.

## Decision

- The template's Captain and every player take effort `medium`.
- Where both adapters are ready, `dev.reviewer` takes the second adapter with effort `high`, amending [DR-096](096-a-second-adapter-reviews.md)'s rule that the Reviewer keeps its own effort; where it takes the first adapter, it keeps the template's `medium`.
- Selection, precedence, the none-ready notice and the public seed export of [DR-053](053-seeding-picks-a-ready-adapter.md) stand; the seeded models are Cligent's ([DR-105](105-runtime-owned-seed-and-delegation.md)).

## Consequences

- A fresh seed runs every agent at `medium`, a Codex Reviewer beside Claude agents at `high`.
- Existing configs are untouched: seeding writes only an absent file, and every effort stays tunable in place.
- Hosts seeding through `@sublang/playbook/seed-config` pick up the new efforts by upgrading Playbook.
