<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-094: Bounded Session Persistence

## Status

Accepted (2026-10-22).
Amends [DR-049](049-portable-session-contract.md).

## Context

Recovery snapshots repeat immutable execution evidence, so a single session manifest can exceed a storage service's file limit.
Replay history can grow independently of recovery state.
Dropping evidence or refusing completion recording after an external action would undermine recovery.

## Decision

- Keep the existing logical recovery contract and shared store API; introduce a versioned physical representation beneath it.
- Store each session's immutable, integrity-checked content in its own bounded chunks, deduplicating equal JSON subtrees and keeping root references bounded.
- Publish dependencies durably before replacing a manifest or replay root.
- Preserve exact replay envelope bytes across segmentation and bind recovery to its existing sequence and digest.
- Read existing sessions without modifying them; convert them explicitly under exclusive ownership with retained originals.
- Treat per-file bounds separately from total-storage quotas and retention; introduce neither automatic evidence deletion nor a post-effect quota in this change.
- Coordinate CLI and embedding-host adoption before production writes.

## Consequences

Sync and export must preserve the complete session-owned chunk closure.
Normal publication retains old chunks so concurrent readers can finish; whole-session deletion removes them.
The initial implementation continues materializing logical recovery objects in memory; bounded disk files do not promise bounded total recovery memory.
Old physical formats remain readable, but older writers must not share stores with the new writer.
