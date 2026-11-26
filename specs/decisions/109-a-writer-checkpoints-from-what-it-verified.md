<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-109: A Writer Checkpoints From What It Verified

## Status

Accepted (2026-11-17).
Amends [DR-094](094-bounded-session-persistence.md), [DR-101](101-a-store-rereads-only-what-it-has-not-verified.md).
Amended by [DR-111](111-a-session-is-a-manifest-and-a-replay-log.md).

## Context

- Manifest writes in long chunked sessions slowed down as the sessions grew [[1]].
- The lifecycle publishes a manifest at every step start and step result, at turn begin and settlement, and at each effect-ledger change, so a long run publishes it hundreds of times.
- Each publication read and verified the complete replay history twice, once to find the applicable context record and once to digest the durable prefix, so one publication cost time proportional to the session and a run cost time quadratic in its length: 1.7 s per write at 3,392 records on macOS and up to 25 s on Windows [[1]].
- A publication needs only two facts from history: the sequence of the last context record matching its configuration, and the SHA-256 of the exact bytes through the durable sequence.
- Both facts pass through the lease's writer: it verified the complete replay when it acquired the lease and appended every later record itself.
- The writer's publication proof of [DR-094](094-bounded-session-persistence.md) and the follower cursor of [DR-101](101-a-store-rereads-only-what-it-has-not-verified.md) already assume that verified replay bytes are not modified outside the storage protocol; this record changes only how recovery publication obtains its facts, and every other decision of those records stands.

## Decision

- The lease writer keeps a verified prefix: the replay log it verified at acquisition and appended since, as [DR-111](111-a-session-is-a-manifest-and-a-replay-log.md) lays it out, with a running SHA-256 of its exact envelope bytes, the digest at its durable sequence, and the context records among them.
- It establishes that prefix during the complete verification it already performs at acquisition and extends it on each successful append and content checkpoint.
- Recovery publication and context recording take the applicable context and the durable digest from that prefix and read no replay bytes.
- Where the writer holds no verified prefix — its initialization failed or its replay latched incomplete — they read the complete log as before, with unchanged results.
- Reopening, validation, export, conversion and every other reader still verify as DR-094 and DR-101 decide.

## Consequences

- A manifest write costs time independent of the session's length.
- A replay byte altered outside the protocol during the lease goes undetected at checkpoint time; the checkpoint still binds the digest of the bytes the writer wrote, so the next open's complete verification refuses continuation and damaged history is never resumed as valid.
- The writer holds one hash state and the session's context records in memory for the lease's lifetime.

## References

[1]: https://github.com/sublang-ai/playbook/issues/112 "Every manifest write re-reads and re-verifies the whole replay chain twice"
