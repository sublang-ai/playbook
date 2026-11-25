<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-109: A Writer Checkpoints From What It Verified

## Status

Accepted (2026-11-17), after manifest writes in long chunked sessions slowed down as the sessions grew [[1]].
Amends [DR-094](094-bounded-session-persistence.md) and [DR-101](101-a-store-rereads-only-what-it-has-not-verified.md) in one rule: recovery publication under a lease may rest on that lease writer's verified prefix instead of verifying the complete replay chain.
Every other DR-094 and DR-101 decision stands.
Amended by [DR-111](111-a-session-is-a-manifest-and-a-replay-log.md) to express the writer's verified prefix in the segmented replay log.

## Context

- The lifecycle publishes a manifest at every step start and step result, at turn begin and settlement, and at each effect-ledger change, so a long run publishes it hundreds of times.
- Each publication read and verified the complete replay chain twice, once to find the applicable context record and once to digest the durable prefix, so one publication cost time proportional to the session and a run cost time quadratic in its length: 1.7 s per write at 3,392 records on macOS and up to 25 s on Windows [[1]].
- A publication needs only two facts from history: the sequence of the last context record matching its configuration, and the SHA-256 of the exact bytes through the durable sequence.
- Both facts pass through the lease's writer: it verified the complete chain when it acquired the lease and appended every later record itself.
- The writer's publication proof (DR-094) and the follower cursor (DR-101) already assume that immutable chunks are not modified outside the storage protocol.

## Decision

- The lease writer keeps a verified prefix: a running SHA-256 of the exact envelope bytes it verified at acquisition and appended since, the digest at its durable sequence, and the context records among them.
- It establishes that prefix during the complete verification it already performs at acquisition and extends it on each successful append and content checkpoint.
- Recovery publication and context recording take the applicable context and the durable digest from that prefix and read no replay chunk.
- Where the writer holds no verified prefix, they read the complete chain as before, with unchanged results: its initialization failed, its replay latched incomplete, or its lease holds a monolithic session whose history is not the bounded chain it writes.
- Reopening, validation, export, migration and every other reader still verify as DR-094 and DR-101 decide.

## Consequences

- A manifest write costs time independent of the session's length, and the verified-cache cliff no longer reaches it.
- A chunk altered outside the protocol during the lease goes undetected at checkpoint time; the checkpoint still binds the digest of the bytes the writer wrote, so the next open's complete verification refuses continuation and damaged history is never resumed as valid.
- The writer holds one hash state and the session's context records in memory for the lease's lifetime.

## References

[1]: https://github.com/sublang-ai/playbook/issues/112 "Every manifest write re-reads and re-verifies the whole replay chain twice"
