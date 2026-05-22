<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCODE: playbook-code CLI

## Intent

This spec defines the implementation requirements of the
`playbook-code` command shim in the `@sublang/playbook` package.

## Resolution

### PBCODE-3

The `playbook-code` shim shall resolve the bundled
`tmux-play.production.config.yaml` relative to its own installed
location, and shall resolve cligent's `tmux-play` CLI via
`import.meta.resolve('@sublang/cligent/tmux-play')` from within
`@sublang/playbook`'s own module tree — not from `PATH`, since a
global install links executables only for top-level packages.

### PBCODE-4

`package.json` `engines.node` shall be `>=20.6.0`, the floor at
which the synchronous `import.meta.resolve` used by
[PBCODE-3](#pbcode-3) is available; adopting a newer Node API in
the shim shall raise this floor in the same change.
