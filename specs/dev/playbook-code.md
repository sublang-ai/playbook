<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCODE: playbook-code CLI

## Intent

This spec defines the implementation requirements of the
`playbook-code` command shim in the `@sublang/playbook` package.

## Resolution

### PBCODE-3

The `playbook-code` shim shall resolve cligent's `tmux-play` CLI
via `import.meta.resolve('@sublang/cligent/tmux-play')` from within
`@sublang/playbook`'s own module tree — not from `PATH`, since a
global install links executables only for top-level packages.
The bundled production YAML shall not be the default runtime config
for the shim; when the user does not supply `--config`, the shim
shall compose the launched config from the user-level overlay
seeded per [PBCODE-7](#pbcode-7) and
[PBCODE-16](../user/playbook-code.md#pbcode-16), rather than launch
the user-level config directly.

### PBCODE-4

`package.json` `engines.node` shall be `>=20.6.0`, the floor at
which the synchronous `import.meta.resolve` used by
[PBCODE-3](#pbcode-3) is available; adopting a newer Node API in
the shim shall raise this floor in the same change.

### PBCODE-7

Where `playbook-code` seeds the user config per
[PBCODE-5](../user/playbook-code.md#pbcode-5), the shim shall
resolve the bundled `playbook-code.config.template.yaml` relative
to its own installed location in the `@sublang/playbook` package
tree and copy that template to the resolved user config path.
The bundled template shall be a CODE overlay per
[PBCODE-16](../user/playbook-code.md#pbcode-16): a `captain` judge
block, a `players` mapping with `coder` and `reviewer` keys (each
with `adapter` and optional `model` / `reasoningEffort` /
`permissions`) plus an optional `committer` alias slot, an optional
top-level `layout` block (window size and column weights), and any
`captain.options.code`; it shall carry neither `captain.from` nor
`players[].id`, since the composer injects those.
This item fixes the template's *shape*, not its model picks; the
concrete `adapter` / `model` / `reasoningEffort` values stay
user-tunable per [PBCODE-6](../user/playbook-code.md#pbcode-6).
The copy shall preserve the template comments, which shall
describe the tunable overlay fields rather than name `captain.from`
or `players[].id` as user-maintained invariants; the comments
shall note that each role's `model` (when pinned) or `adapter`
(otherwise) doubles as the identity string the adapter substitutes
into player prompts per [PBRT-4](../user/playbook-runtime.md#pbrt-4).
For every role that the bundled template seeds with `adapter: codex`,
the template shall include `permissions.mode: auto` and
`permissions.writablePaths: ['.git']`, so the default Codex player
can write git metadata under cligent's profile-scoped auto mode
without switching to bypass permissions.
The copy shall not run when `--config` is supplied.

### PBCODE-8

Where `playbook-code` runs the readiness gate per
[PBCODE-6](../user/playbook-code.md#pbcode-6), the shim shall
collect the declared `adapter` values from the composed config
([PBCODE-16](../user/playbook-code.md#pbcode-16)) — the
`captain.adapter`, which may have been inherited from the base
config, and the `coder` and `reviewer` player adapters — and not
from the raw overlay, so an inherited captain adapter is not
missed.
The shim shall treat `claude` as ready when `ANTHROPIC_API_KEY` is
set or `$HOME/.claude/` exists, and shall treat `codex` as ready
when `OPENAI_API_KEY` is set or `$HOME/.codex/` exists.
For every distinct adapter value other than `claude` or `codex`,
the shim shall emit one warning and shall exclude that adapter from
the blocking readiness result.

## Composition

### PBCODE-17

Where `playbook-code` composes the runtime config per
[PBCODE-16](../user/playbook-code.md#pbcode-16), the shim shall
locate any base tmux-play config with cligent's exported
`findTmuxPlayConfig` and shall not call `loadTmuxPlayConfig`
without a located path, since that loader writes a default config
when none exists.
The shim shall read the overlay (the
[PBCODE-5](../user/playbook-code.md#pbcode-5) path): its `players`
mapping keyed by `coder` / `reviewer`, its `captain` judge block,
and its `captain.options.code`; the overlay carries no
`captain.from` and no `players[].id`.
The shim shall set the composed `captain.from` to the Playbook
Captain shell adapter module with CODE registered.
For each of the `coder` and `reviewer` `players.<role>` keys it
shall emit one composed `players[]` array entry whose `id` is the
role key and whose `adapter`, `model`, `reasoningEffort`, and
`permissions` are taken from that role's block; it shall reject an
overlay whose `players` mapping omits `coder` or `reviewer`, or
carries any key other than `coder`, `reviewer`, and the optional
`committer` alias, with a path-named error.
The optional `players.committer` is a string naming `coder` or
`reviewer`; the shim shall resolve it into the composed
`captain.options.code.committer` (the named role id) and shall not
emit a `players[]` entry for it, so the roster stays `coder` +
`reviewer`. It shall reject a `committer` value that is not
`coder` or `reviewer` with a path-named error
(`players.committer`).
The shim is the sole writer of the composed
`captain.options.code.committer`: it shall reject an overlay that
sets `captain.options.code.committer` directly with a path-named
error (`captain.options.code.committer`), and shall carry the rest
of `captain.options.code` through unchanged.
It shall set the composed `captain.adapter` from the overlay when
present, else from the base config, and shall fail with a
path-named `captain.adapter` error when neither supplies it; the
role `adapter`s are required in the overlay and are not inherited.
It shall carry the optional top-level `layout` block into the
composed config from the overlay, or inherit it from the base
config when the overlay omits it — the same precedence as `theme` —
without interpreting its contents, since `layout` is a
host-observable tmux-play field, not a CODE option.
Because cligent's loader normalizes a discovered base to `captain` /
`players` / `theme` and drops fields it does not model — `layout`
among them — the shim shall recover a base `layout` from the raw
base YAML when the loader returns none, so base inheritance holds;
this recovery is inert once a loader preserves `layout` itself.
The shim shall type the composed config with cligent's exported
config types but shall serialize it to the temporary `.yaml` with
its own serializer, since `@sublang/cligent/tmux-play` exports no
config serializer; it shall depend on no cligent internals beyond
those public exports.
