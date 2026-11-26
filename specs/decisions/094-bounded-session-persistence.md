<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-094: Bounded Session Persistence

## Status

Accepted (2026-10-22).
Amends [DR-049](049-portable-session-contract.md).
Amended by [DR-098](098-native-windows-private-storage.md), [DR-101](101-a-store-rereads-only-what-it-has-not-verified.md), [DR-109](109-a-writer-checkpoints-from-what-it-verified.md), [DR-111](111-a-session-is-a-manifest-and-a-replay-log.md).

## Context

Recovery snapshots repeat immutable execution evidence, so a single session manifest can exceed a storage service's file limit.
Replay history can grow independently of recovery state.
Dropping evidence or refusing completion recording after an external action would undermine recovery.

## Decision

- Keep the existing logical recovery contract and shared store API; introduce a versioned physical representation beneath it, now the manifest file and segmented replay log of [DR-111](111-a-session-is-a-manifest-and-a-replay-log.md).
- Keep every session-owned file within a per-file bound, splitting what would exceed it into integrity-checked parts.
- Publish dependencies durably before replacing a manifest.
- Preserve exact replay envelope bytes and bind recovery to its existing sequence and digest.
- Convert earlier physical formats only explicitly, under exclusive ownership with retained originals, by the separate command of [DR-111](111-a-session-is-a-manifest-and-a-replay-log.md).
- Treat per-file bounds separately from total-storage quotas and retention; introduce neither automatic evidence deletion nor a post-effect quota.
- A store reverifies only what it has not verified ([DR-101](101-a-store-rereads-only-what-it-has-not-verified.md)), a lease writer publishes from its verified prefix ([DR-109](109-a-writer-checkpoints-from-what-it-verified.md)), and native Windows storage is admitted under [DR-098](098-native-windows-private-storage.md).
- Coordinate CLI and embedding-host adoption before production writes.

## Consequences

Sync and export must preserve every session-owned file; whole-session deletion removes them.
The implementation materializes logical recovery objects in memory; bounded disk files do not promise bounded total recovery memory.
Older writers must not share stores with the new writer.
