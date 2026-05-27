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
shall launch against the user-level config seeded per
[PBCODE-7](#pbcode-7).

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
The copy shall preserve the template comments, including comments
that name the host-configuration invariants from
[PBRT-4](../user/playbook-runtime.md#pbrt-4): `captain.from`
points at the adapter module, and `players[].id` remains `coder`
/ `reviewer` with each entry's `adapter` doubling as the identity
string the adapter substitutes into player prompts.
The copy shall not run when `--config` is supplied.

### PBCODE-8

Where `playbook-code` runs the readiness gate per
[PBCODE-6](../user/playbook-code.md#pbcode-6), the shim shall read
the resolved YAML config and collect the declared `adapter` values
from `captain.adapter` and every `players[]` entry.
The shim shall treat `claude` as ready when `ANTHROPIC_API_KEY` is
set or `$HOME/.claude/` exists, and shall treat `codex` as ready
when `OPENAI_API_KEY` is set or `$HOME/.codex/` exists.
For every distinct adapter value other than `claude` or `codex`,
the shim shall emit one warning and shall exclude that adapter from
the blocking readiness result.
