<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-015: Per-session agent tuning

## Status

Accepted as amended by [DR-031](031-shared-captain-session-front-ends.md).
[DR-032](032-explicit-roles-session-players.md) supersedes the frozen-lineup and no-continuation-overlay rules for an ordinary settled reopen: current model and effort plus opening overlays may retune a stable player id, instruction and permissions remain structurally frozen, and uncertain retry retains its attempted settings.

## Context

Tuning the agent lineup for one run currently means editing durable state.
The interactive `playbook` command reads exactly one top-level config at `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml` ([[playbook-cli-3](../packages/playbook-cli.md#playbook-cli-3)]); the only per-invocation alternative is `--config <path>`, a full raw tmux-play config that bypasses seeding, composition, and the readiness gate ([[playbook-cli-1](../packages/playbook-cli.md#playbook-cli-1)]) — far more than a lineup tweak wants, and in a different format.
The released non-interactive `playbook run` introduced separate per-run agent flags, but [DR-031](031-shared-captain-session-front-ends.md) later replaced that split with the same configured Captain session used by interactive mode.

Trying a stronger reviewer model, dropping the Coder's effort for a cheap smoke run, or swapping one playbook's lineup for a single launch should not require editing the global config and editing it back.

## Decision

### 1. Agent tuning uses the shared config

Interactive and headless Captain sessions shall obtain each agent's adapter, model, effort, and permissions from the same inline top-level config and optional launch overlays.
An ordinary settled continuation shall preserve the session's structural settings while re-reading current model and effort tuning plus opening overlays under [DR-032](032-explicit-roles-session-players.md); an uncertain retry shall use its exact attempted settings, and neither path shall accept run-only binding flags.

### 2. `--with` config overlays for a configured session launch

The generic interactive or new-headless-session launch path has a repeatable `--with <path>` flag.
Each named file is a fragment in the same top-level `profiles`/`playbooks` format as the global config ([[playbook-cli-4](../packages/playbook-cli.md#playbook-cli-4)]); the launcher merges the fragments over the resolved — and, when absent, freshly seeded — global config in argument order, then feeds the merged result through the ordinary composition, `--list`, and readiness paths.
Merging is recursive for plain maps and replacement for everything else (scalars, sequences, and `null`), so a three-line fragment can retune one player while a larger one can swap profiles or enable another playbook.
`--with` is launcher-owned: the flag and its value are consumed, extending the launcher-owned argument set of [[playbook-cli-1](../packages/playbook-cli.md#playbook-cli-1)], and are never forwarded to tmux-play or interpreted as Boss text.
The global config file is never modified by an overlaid launch, and `--with` combined with `--config` is rejected — a raw tmux-play config bypasses the composition the overlay targets.

### 3. Preserved scope

- No in-process mutation: tuning is resolved only when a process opens a new or settled session; an already attached process retains its launch projection.
- No deletion semantics: an overlay can add and replace but not remove keys; disabling a playbook for one run means overlaying a config that does not carry it only via replacement of a whole map value.
- An ordinary settled continuation may use `--with` under [DR-032](032-explicit-roles-session-players.md); an uncertain retry rejects overlays and uses its recorded attempt.
- Host fields beyond the agent lineup (notifications, theme, layout) merge like any other top-level key; no special casing.

## Consequences

- Either front end can retune a new session with a small committed-nowhere YAML fragment, such as `playbook --with fast-lineup.yaml` or `playbook run --with fast-lineup.yaml "<task>"`.
- The global config keeps its role as the single durable lineup; overlays leave no trace after the process exits.
- One inline config grammar owns agent tuning, so headless and interactive sessions cannot silently select different lineups.
