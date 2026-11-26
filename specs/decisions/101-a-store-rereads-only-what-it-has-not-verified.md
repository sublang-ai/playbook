<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-101: A Store Rereads Only What It Has Not Verified

## Status

Accepted (2026-11-08).
Amends [DR-094](094-bounded-session-persistence.md).
Amended by [DR-109](109-a-writer-checkpoints-from-what-it-verified.md), [DR-111](111-a-session-is-a-manifest-and-a-replay-log.md).

## Context

- Long chunked sessions in the Spex app slowed down as they grew [[1]].
- A host that tees records through the replay observer reads the stream after every append.
- Every such read verified the complete replay history, so one read cost time proportional to the session and a session cost time quadratic in its length: 0.9 s per record at 3,700 records [[1]].
- The legacy single-file reader already kept a per-store cursor and validated only the bytes after it, and the writer already reused a publication proof so its appends and trusted checkpoints skip the walk; only the public read verified everything every time.
- This record changes one rule of [DR-094](094-bounded-session-persistence.md): a store need not verify the whole replay again when it reads a replay that extends a prefix it has verified completely; every other DR-094 decision stands.

## Decision

- A store caches, per session, the position through which it verified the complete replay log — the segment's identity and the byte offset after its last complete line, as [DR-111](111-a-session-is-a-manifest-and-a-replay-log.md) expresses it — with that prefix's final sequence and digest, and only when the verified prefix ends at a complete envelope line.
- A later monotonic read whose replay extends that position verifies only the bytes after it, continuing from the cached sequence and digest.
- A read without such a boundary verifies the complete log: a new store or process, a request below the cached sequence, a replay that does not extend the cached position, a shortened replay, a torn tail, export, conversion, and the retry after a changed snapshot; a shortened or replaced observed prefix still rejects in the live store.
- The trust assumed is the one the writer's publication proof already assumes: verified replay bytes are not modified outside the storage protocol. A partial read never establishes a publication proof.
- Writer initialization still verifies from the start without reusing a follower cursor, and a lease writer's own publications rest on its verified prefix ([DR-109](109-a-writer-checkpoints-from-what-it-verified.md)).

## Consequences

- A read after an append costs time proportional to the appended records, not to the session.
- A replay byte altered outside the protocol after this store verified it goes undetected by this store's later incremental reads; a new store, reopening, export and conversion still refuse it.
- "Public reads always verify" narrows to public reads without a boundary the reading store verified itself.

## References

[1]: https://github.com/sublang-ai/playbook/issues/95 "Chunked sessions re-read the whole replay chain after every record"
