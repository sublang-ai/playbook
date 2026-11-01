<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-098: Native Windows Private Storage

## Status

Accepted (2026-10-30).
Amends [DR-087](087-leases-name-the-machine.md) and [DR-094](094-bounded-session-persistence.md) for native Windows storage admission.

## Context

Windows Node mode bits cannot establish private ownership and permissions.
Embedding desktop hosts need native Windows session storage without WSL.

## Decision

- Native Windows storage requires Node 22.19 or newer and uses the optional `@openclaw/fs-safe` permission mechanisms through the existing private-entry implementation.
- POSIX hosts keep their existing Node floor, verified permission tightening and directory synchronization, without loading the Windows mechanism.
- Windows entries admit only complete local owner/DACL facts, trusted ownership and grants limited to the current user, LocalSystem and built-in Administrators; links, special files, unsupported descriptors and other grants refuse.
- Windows private directory creation applies its protected inheritable DACL before session content is written; existing unsafe ACLs refuse without changing their contents or ownership.
- Machine identity, exclusive leases, bounded manifests, replay, chunks, assets, reconciliation and retained evidence keep their existing formats and publication rules.
- Windows keeps file synchronization and identity checks without claiming POSIX directory-fsync support.
- Host paths are interpreted with Node's platform path operations; portable record paths retain their portable syntax.

## Consequences

A host must supply the Windows permission package and its supported native or packaged .NET mechanism.
Missing or failing permission inspection refuses storage use rather than trusting synthetic mode bits.
