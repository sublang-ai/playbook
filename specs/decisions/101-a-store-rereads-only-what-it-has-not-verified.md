<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-101: A Store Rereads Only What It Has Not Verified

## Status

Accepted (2026-11-08), after long chunked sessions in the Spex app slowed down as they grew [[1]].
Amends [DR-094](094-bounded-session-persistence.md) in one rule: a store need not verify the whole replay chain again when it reads a root that extends a head it has verified completely.
Every other DR-094 decision stands.

## Context

- A host that tees records through the replay observer reads the stream after every append.
- On bounded storage every such read pinned the root and verified its complete chain from the head back to the first node, about two file stats per record even when the verified-bytes cache held the content, so one read cost time proportional to the session and a session cost time quadratic in its length: 0.9 s per record at 3,700 records [[1]].
- The legacy single-file reader already keeps a per-store cursor and validates only the bytes after it, and the bounded writer already reuses a publication proof so its appends and trusted checkpoints skip the walk; only the bounded public read verified everything every time.
- Chunks are content-addressed: a node whose `previous` names a verified head is bound to that whole prefix by SHA-256.

## Decision

- A store caches, per session, the head reference whose complete closure it verified, with that prefix's byte count, final sequence and digest, and only when the verified chain ends at a complete envelope line.
- A later monotonic read of a root whose byte length is not below that count walks from the new head, verifying each node and its content, until it reaches the cached head, whose remaining total must equal the cached count, and parses only the bytes it walked from the cached sequence and digest.
- A read without such a boundary verifies the complete chain: a new store or process, a request below the cached sequence, a root that does not extend the cached head, a shortened root, a chain ending in a torn tail, export, migration, and the retry after a changed snapshot; a shortened or replaced observed prefix still rejects in the live store.
- The trust assumed is the one the legacy offset cursor and the writer's publication proof already assume: immutable chunks are not modified outside the storage protocol. A partial walk never establishes a publication proof.
- Writer initialization still verifies from the root without reusing a follower cursor.

## Consequences

- A read after an append costs time proportional to the appended records, not to the session.
- A chunk altered outside the protocol after this store verified it goes undetected by this store's later incremental reads; a new store, reopening, export and migration still refuse it.
- "Public reads always verify" narrows to public reads without a boundary the reading store verified itself.

## References

[1]: https://github.com/sublang-ai/playbook/issues/95 "Chunked sessions re-read the whole replay chain after every record"
