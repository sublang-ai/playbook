<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-006: CODE config composition and the `options.code` extension point

## Status

Superseded by [DR-009](009-generic-playbook-cli-and-registry.md).

DR-009 replaces the `playbook-code` composer and the user-authored CODE
overlay with the generic `playbook` launcher and a top-level
`profiles` / `playbooks` config, and moves CODE options from
`captain.options.code` to the registry-scoped
`captain.options.playbooks.code.options` slice
([PBRT-29](../user/playbook-runtime.md#pbrt-29),
[PBRT-30](../dev/playbook-runtime.md#pbrt-30)).
This DR's `captain.options` extension-point reasoning survives in DR-009's
per-playbook option slices; its `playbook-code` composer mechanics and the
retired PBCODE specs it cites below are historical.

## Context

Two apps are layered, with a one-way dependency that [DR-004](004-link-code-fsm-to-playbook-runtime.md) pins.
cligent ships tmux-play: the host platform, the Captain plugin contract, and the config schema.
`@sublang/playbook` ships the CODE playbook, its Playbook Captain shell / compatibility tmux-play adapters, and the `playbook-code` launcher; it depends on cligent, never the reverse.
cligent stays CODE-agnostic.

tmux-play's config is the host contract.
Its `captain` / `players` fields are strict-whitelisted, but `captain.options` is an opaque JSON value forwarded verbatim to the Captain factory (cligent TMUX-006).
Under cligent's contract (TMUX-008), when loading a config the loader rejects any unknown field — at any path — with an error that names the offending file or path.
So `captain.options` is the only place a plugin may extend without a cligent change.

CODE will need its own runtime options, and there is no clean home for them today.
The current onboarding seeds a full tmux-play config the user hand-maintains ([PBCODE-5](../user/playbook-code.md#pbcode-5), [PBCODE-7](../dev/playbook-code.md#pbcode-7)), including the `captain.from` and `players[].id` values the user is told not to touch ([PBRT-4](../user/playbook-runtime.md#pbrt-4)).
That is a leaky abstraction: the user maintains invariants that are not theirs to change.

cligent already exports the primitives needed to *read* a config — `findTmuxPlayConfig`, `loadTmuxPlayConfig`, and the config types — from `@sublang/cligent/tmux-play`.
It exports no config *serializer*: `yaml.stringify` is used only internally, and the exported snapshot writer emits JSON, not a `--config`-readable YAML.
So composition reads through cligent's API but playbook owns YAML serialization; no cligent change is required.

## Decision

### Addendum A1 (DR-008 shell target)

[DR-008](008-playbook-captain-shell.md) supersedes this record's
original direct CODE adapter target for tmux-play launch.
In this record's current text, "Playbook Captain shell adapter"
replaces the original CODE adapter module for composed
`captain.from`, and "CODE registry entry" replaces the direct CODE
adapter as the owner of `captain.options.code` validation.

### 1. Extension point: `captain.options.code`

- All CODE runtime options shall live under `captain.options.code`, a namespaced JSON object.
- tmux-play forwards `captain.options` verbatim; the CODE registry entry reads `options.code`, validates it, and rejects unknown keys with an error that names the offending path.
- cligent shall neither read nor validate `options.code`; the CODE registry entry is the sole validator, because only the side that owns the schema can validate it.
- The boundary rule for where a setting belongs:

| A setting that changes… | Belongs in |
| --- | --- |
| host-observable behavior — theme, layout, notifications, permissions, model/adapter routing, timing | tmux-play's own top-level fields plus `captain` / `players` fields |
| CODE-internal runtime behavior | `captain.options.code` |

### 2. `playbook-code` is a composer, not a config the user authors

The launched tmux-play config shall be composed at launch, not hand-authored by the user:

1. Locate an optional base tmux-play config with `findTmuxPlayConfig` — never the bare `loadTmuxPlayConfig`, which writes a default fanout config when none is found.
2. Read the user-level CODE overlay (the [PBCODE-5](../user/playbook-code.md#pbcode-5) path) — a tmux-play-shaped config minus `captain.from`, with `players` keyed by role (`coder`, `reviewer`) instead of an array with `id`. Each `players.<role>` block carries that role's `adapter` and optional `model` / `reasoningEffort` / `permissions`; the `captain` block carries the judge fields; top-level host fields such as `layout` and `notifications` may be set; CODE options live under `captain.options.code`.
3. Force the invariants and map the roster: `captain.from` = the Playbook Captain shell adapter module with CODE registered; produce one composed `players[]` entry per role with `id` = the role name (`coder`, `reviewer`) carrying that role's declared `adapter` / `model` / `reasoningEffort` / `permissions`.
4. Inherit from the base **only** `theme`, the top-level `layout` and `notifications` blocks, and the captain-judge fields (`adapter`, `model`, `reasoningEffort`, `permissions`), filling gaps the overlay leaves; the base `players[]` roster shall **not** be auto-mapped onto `coder` / `reviewer`. For `layout` and `notifications`, the gap is the block itself: a present overlay block replaces the base block whole rather than merging nested fields or event keys. `layout` and `notifications` are host-observable fields (per the §1 boundary table), so they ride alongside `theme` rather than under `captain.options.code`; the composer carries them through to the composed config and does not interpret them. `captain.adapter` must end up set from the overlay or the base, else composition fails with a path-named error; the role `adapter`s are required in the overlay and are not inherited.
5. Carry the overlay's `captain.options.code` through to the composed config unchanged.
6. Serialize the composed config to YAML with playbook's own serializer (cligent exports none), write it to a temp file, launch `tmux-play --config <temp>`, and remove it on exit.

Explicit `--config <path>` shall still bypass composition entirely ([PBCODE-1](../user/playbook-code.md#pbcode-1)).

The roster is not inherited because CODE's two fixed roles have no canonical mapping from an arbitrary base `players[]` list; inheriting it would make `coder` / `reviewer` silently adopt whatever adapters the user's generic config happened to list.

### 3. Defer the object-launcher

A cligent entry that launches the full app from an in-memory config object — skipping the temp-YAML round-trip — is deferred, not adopted.
The composer works on already-exported cligent API; the YAML round-trip is lossless for a valid config; the launcher's re-validation in the child process is a feature, not waste; and tmux-play materializes a config snapshot regardless, so a temp file is not new cost.
Revisit only on observed friction (e.g. config errors surfacing confusingly from the subprocess), and then as a generic, CODE-agnostic cligent change.
That entry is also the natural home for an exported config serializer; until it exists, playbook owning YAML serialization keeps cligent untouched.

### 4. Amendments to existing items

The implementing IR shall land these alongside the new items:

- **[PBCODE-1](../user/playbook-code.md#pbcode-1) / [PBCODE-5](../user/playbook-code.md#pbcode-5)** — the launch target becomes the composed temp config; the user-level CODE config becomes the overlay source, not the launched file.
- **[PBCODE-7](../dev/playbook-code.md#pbcode-7)** — the seeded template drops `captain.from` and `players[].id` (the composer injects them) and its comments no longer name those as user-maintained invariants.
- **[PBRT-4](../user/playbook-runtime.md#pbrt-4)** — the `captain.from` and baked-id invariants are injected by the composer rather than declared by the user; `captain.from` targets the Playbook Captain shell adapter per [DR-008](008-playbook-captain-shell.md), and `captain.options.code` is named as the CODE option surface.

New normative items: PBRT-29 / PBRT-30 (host config + registry validation) and PBCODE-16 / PBCODE-17 (composer behavior + mechanics), with test items PBRT-31 / PBCODE-18.

## Consequences

- **CODE gets a clean, namespaced option surface** without forking tmux-play's schema or teaching cligent about CODE.
- **The "do not touch" invariants leave the user's file.** Onboarding shifts from "edit a full tmux-play config" to "edit a small CODE overlay"; the composer owns `captain.from` and the baked ids.
- **A user's existing tmux-play config is reused** for theme, layout, notifications, and judge defaults, but not for the player roster — avoiding surprising adapter inheritance into the two CODE roles.
- **Validation moves to the boundary that owns the schema.** Malformed `options.code` fails fast in the CODE registry entry with a path-named error instead of an unchecked cast.
- **cligent is untouched.** Composition uses already-exported loader API; the object-launcher remains a deferred, optional optimization.
- **The session-level contract is updated only at the Captain target.** DR-004 §11's direct CODE adapter is superseded by [DR-008](008-playbook-captain-shell.md) for tmux-play launch; the composer still owns the baked player ids and produces the config the session consumes.
