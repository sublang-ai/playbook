<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-098: Native Windows Private Storage

## Status

Accepted (2026-10-30); narrowed after the 2026-11-01 compatibility review.
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
- Windows keeps opened directory handles and descriptor/path identity checks; only unsupported POSIX directory `fchmod` and directory `fsync` operations are omitted, while regular-file synchronization remains.
- This Windows adaptation preserves the original POSIX asset permission mask: private ordinary permission bits remain required, without newly rejecting special mode bits that the asset facade previously admitted.
- Host paths are interpreted with Node's platform path operations; portable record paths retain their portable syntax.

## Consequences

A host must supply the Windows permission package and its supported native or packaged .NET mechanism.
Missing or failing permission inspection refuses storage use rather than trusting synthetic mode bits.

The strict ACL admission policy preserves an existing upstream private-storage contract; it is not evidence that a personal computer requires an additional Agent sandbox or that same-account processes are isolated.
GitHub collaboration, concurrent CLI/APP calls, and crashes still require the existing leases, atomic publication and content checks, independently of ACL admission.
Windows directory `fsync` is not provided by this change, so its crash/power-loss durability is not claimed equivalent to the POSIX path.
The Windows Node 24.22.2 probe can open and stat directories; `fchmod` and `fsync` on that handle return `EPERM`, so a blanket claim that Windows cannot open directories is incorrect.

Windows-specific real-storage checks run in their own CI job at the declared Node minimum, because the existing Linux-only matrix skips them.
The packaged .NET permission fallback remains supported but can be expensive per inspection; the measured replay check takes about 69 seconds under Electron, so its integration-test allowance is two minutes without changing production operation deadlines.
