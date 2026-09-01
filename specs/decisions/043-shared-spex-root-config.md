<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-043: Config under the shared Spex root

## Status

Accepted.

## Context

Playbook and the Spex app share one configuration file.
Each resolves it independently, and both resolved
`${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`.

Spex has since moved its own state — projects, sessions, preferences — under
`${SPEX_HOME:-$HOME/.spex}`, leaving the shared config as the only artifact
outside that root.
The two resolvers must agree: if either moves alone, the products stop sharing
a file and each silently seeds its own.

This project otherwise rejects rather than migrates, on the grounds that a
regenerable artifact is cheaper to refuse than to convert.
A user-authored config is not regenerable, and the relocation is not the
user's doing.

## Decision

The canonical path is `${SPEX_HOME:-$HOME/.spex}/playbook/playbook.config.yaml`.
Both hosts resolve the root the same way: the first nonempty `SPEX_HOME`,
otherwise the first nonempty `HOME` joined with `.spex`, otherwise the
process home directory joined with `.spex`.
The singular `playbook/` namespace holds the config; Spex owns the plural
`playbooks/` library beside it.

Playbook relocates a config found at the former path to the canonical path on
its next launch, before any read, seed, or plan work observes its absence.
The move preserves the file's bytes and permissions, never overwrites a
canonical file, and is a no-op once the former file is gone.
Until the coordinated target-preserving locator rewrite is available, Playbook
rejects before publication when that byte-preserving move would change the
absolute target of a primary relative `sessions` or path-shaped relative
`playbooks.<id>.from` value, naming every target-preserving absolute
replacement while leaving the former file unchanged.
This one-time relocation is a deliberate exception to the reject-don't-migrate
posture, taken because the file is user-authored and unregenerable.

Session state is unaffected and stays under its own independently configured
location.

## Consequences

Both hosts open one file again, and the shared config sits under the root that
already holds the rest of the app's state.

A user with an existing config keeps it without acting; a user with none is
seeded at the canonical path as before.
An existing config whose primary relative locators would be retargeted must
first replace those values with the diagnosed absolute forms, then retry.

The relocation is not a compatibility layer: no alias is left behind, and a
host that still resolves the former path finds nothing there and seeds its
own.
Coordinating the two releases is therefore a release-ordering matter rather
than a runtime negotiation.

Where the move crosses filesystems it is a copy followed by a drop; an
interruption leaves the former file in place, and the next launch finds the
canonical file already present and ignores it.
