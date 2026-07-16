<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-015: Per-run agent tuning

## Status

Accepted.

## Context

Tuning the agent lineup for one run currently means editing durable state.
The interactive `playbook` command reads exactly one top-level config at `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml` ([PBCLI-3](../user/playbook-cli.md#pbcli-3)); the only per-invocation alternative is `--config <path>`, a full raw tmux-play config that bypasses seeding, composition, and the readiness gate ([PBCLI-1](../user/playbook-cli.md#pbcli-1)) — far more than a lineup tweak wants, and in a different format.
The non-interactive `playbook run` binds a per-run model through `--player <role>=<adapter>:<model>` and `--captain <adapter>:<model>` ([PBCLI-19](../user/playbook-cli.md#pbcli-19)) but exposes no reasoning-effort control at all, even though the top-level config expresses effort per profile and cligent's `CligentOptions.effort` carries adapter-scoped values with discoverable `EFFORT_SUPPORT` metadata and validators.

Trying a stronger reviewer model, dropping the Coder's effort for a cheap smoke run, or swapping one playbook's lineup for a single launch should not require editing the global config and editing it back.

## Decision

### 1. Effort in the `playbook run` agent spec

The `<agent>` grammar of `playbook run` extends from `<adapter>[:<model>]` to `<adapter>[:<model>][@<effort>]`.
The effort rides after the last `@`, not a colon, because model names may themselves contain colons (`opencode:ollama/llama3:8b@max`); `claude@high` selects the adapter's default model while still setting effort.
The one-shot host resolves each bound agent's effort into the per-role `Cligent` it constructs, and validates every supplied effort against cligent's adapter-scoped support metadata up front, failing with a diagnostic that names the adapter's supported values rather than surfacing a mid-run adapter error.
Parked sessions store each agent spec as bound — adapter, optional model, optional effort — so a resumed run rebuilds the identical lineup ([DR-014 §3](014-durable-one-shot-run-sessions.md#3-one-shot-session-store)).

### 2. `--with` config overlays for the interactive launch

The generic launch path gains a repeatable `--with <path>` flag.
Each named file is a fragment in the same top-level `profiles`/`playbooks` format as the global config ([PBCLI-4](../user/playbook-cli.md#pbcli-4)); the launcher merges the fragments over the resolved — and, when absent, freshly seeded — global config in argument order, then feeds the merged result through the ordinary composition, `--list`, and readiness paths.
Merging is recursive for plain maps and replacement for everything else (scalars, sequences, and `null`), so a three-line fragment can retune one player while a larger one can swap profiles or enable another playbook.
`--with` is launcher-owned: the flag and its value are consumed, extending the launcher-owned argument set of [PBCLI-1](../user/playbook-cli.md#pbcli-1), and are never forwarded to tmux-play.
The global config file is never modified by an overlaid launch, and `--with` combined with `--config` is rejected — a raw tmux-play config bypasses the composition the overlay targets.

### 3. Preserved scope

- No mid-session re-tuning: overlays and run parameters bind at launch; changing a live session's lineup remains out of scope.
- No deletion semantics: an overlay can add and replace but not remove keys; disabling a playbook for one run means overlaying a config that does not carry it only via replacement of a whole map value.
- No `--with` on `playbook run`: the one-shot host's parameters already cover its per-run surface.
- Host fields beyond the agent lineup (notifications, theme, layout) merge like any other top-level key; no special casing.

## Consequences

- A one-shot run can pin model and effort per role — `--player reviewer=codex:gpt-5.5@xhigh --captain claude@high` — with unsupported efforts rejected before any agent runs.
- An interactive launch can be retuned with a small committed-nowhere YAML fragment: `playbook --with fast-lineup.yaml`.
- The global config keeps its role as the single durable lineup; overlays leave no trace after the process exits.
- The agent-spec grammar is backward compatible: existing `<adapter>` and `<adapter>:<model>` forms — including models that contain colons — parse exactly as before, and only a trailing `@` segment is new.
