<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-064: The Config Directory Is Named Config

## Status

Accepted (2026-09-20).
Amends [DR-043](043-shared-spex-root-config.md).

## Context

DR-043 moved the shared config under the Spex root as `playbook/playbook.config.yaml`, keeping the singular `playbook/` directory as this product's own namespace beside Spex's plural `playbooks/` library.
The namespace never gained a second file.
The rest of the root is laid out by what a directory holds — `sessions/`, `playbooks/`, `intents/` — not by which product owns it; this product's own sessions live at `sessions/`, not under `playbook/`.
What remains is a directory that stutters, reads as a sibling of `playbooks/`, and holds one file.
This record changes only DR-043's canonical directory, which becomes `config/`, adding DR-043's `playbook/` to the former locations a launch relocates from; everything else of that record stands.

## Decision

The canonical path is `${SPEX_HOME:-$HOME/.spex}/config/playbook.config.yaml`, the root resolved as DR-043 resolves it.
`config/` is the root's directory of human-authored configuration files, each named for the format it follows; it is the primary configuration directory every relative locator resolves against.
The file keeps its name: `playbook.config.yaml` is this product's format, the name `--config` documents and the starter template carries.

The relocation of DR-043 now serves two former locations, the nearer first: the root's `playbook/playbook.config.yaml`, then the pre-DR-043 XDG path.
The first regular file found moves under DR-043's rules — bytes and mode preserved, published with an exclusive link so a canonical entry appearing concurrently wins, refused when a primary relative locator would change target — and the former file goes, its directory with it when that leaves the directory empty.
A former file that disappears between inspection and staging relocates nothing.
`config/` sits at the depth `playbook/` did, so a relative `sessions` or `playbooks.<id>.from` locator reaching beside or above the directory keeps its target across the sibling move; only one pointing into the directory changes, and the refusal stands for it.

Considered and declined:

- `playbook.config.yaml` at the root itself: the depth changes, so every path-shaped relative locator retargets, the guard refuses to move a config with a managed library, and the file's backups would sit among the state files.
- `settings/`: the interface's word for its editor, not the file's; the file is `*.config.yaml` and the flag is `--config`.
- another file name, such as `config/playbook.yaml`: it would ripple through the raw `--config` conventions, the template, and project-level configs for no gain in clarity.

## Consequences

Both hosts open one file again once each resolves `config/`; as with DR-043, the release ordering coordinates them, and a host still resolving `playbook/` seeds its own file there.
The relocation's staging and the backups a migration writes beside the config stay inside `config/`.
