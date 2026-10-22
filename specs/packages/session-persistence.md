<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# session-persistence: Bounded Session Persistence

## Intent

This package owns the bounded physical representation of session recovery and replay, preserving their logical meaning under [DR-094](../decisions/094-bounded-session-persistence.md).

## External Behavior

### session-persistence-1

When saving a new-format session, the shared store shall encode its logical manifest without changing its recovery meaning [[session-storage-2](session-storage.md#session-storage-2)] in a small `<sessionId>.json` root with exactly `schemaVersion: 8`, `kind: "captain-session-storage"`, `sessionId`, `cwd`, `state`, `createdAt`, `updatedAt` and `root`, where the summary fields equal the decoded manifest and `root` identifies its immutable content by SHA-256 and encoded byte length.
The store shall keep all immutable content in the session-owned `<sessionId>.chunks/` directory and bound every newly written root, index and content file to 8 MiB, including content containing one oversized string, key, array or replay record.

### session-persistence-2

When persisting JSON evidence, the store shall use an unambiguous tagged encoding that preserves its JSON value and deduplicates equal encoded subtrees within that session, with bounded references and indexes rather than an unbounded root inventory.
When reading referenced content, the store shall verify its exact length, digest, encoding and complete dependency closure before returning logical recovery, refusing missing, corrupt, cyclic or unsupported content without mutating the saved session.

### session-persistence-3

When appending replay in the bounded format, the store shall preserve the exact ordered envelope bytes and checkpoint digest [[session-storage-3](session-storage.md#session-storage-3)] [[session-storage-4](session-storage.md#session-storage-4)] through immutable segments identified by `<sessionId>.replay.json`, a closed root containing `kind: "captain-session-replay"`, `schemaVersion: 1`, `sessionId`, `head` and `byteLength`.
An empty stream shall have a null head and zero byte length; a nonempty stream shall identify an ordered immutable chain whose declared lengths equal its verified content, permitting a pinned reader to complete while a writer appends.
New append visibility shall follow atomic root publication, and the public stream shall preserve its sequence, ownership, durable-checkpoint and incompleteness guarantees [[session-storage-4](session-storage.md#session-storage-4)].

### session-persistence-4

When publishing a bounded checkpoint, the store shall persist and sync its complete immutable dependencies before atomically replacing and syncing its root under the owning lease, acknowledge only the completed durable publication, and preserve the preceding root on any failure before replacement [[session-storage-11](session-storage.md#session-storage-11)].
It shall apply the existing private-directory, verified-handle, current-owner, single-link and non-symlink rules to roots and chunks [[session-storage-1](session-storage.md#session-storage-1)], including the caller's prohibition on creating a missing sessions directory [[session-storage-11](session-storage.md#session-storage-11)].
Normal writes shall retain superseded chunks and shall not truncate evidence or impose a total-storage quota that prevents required post-action recovery recording [[session-storage-4](session-storage.md#session-storage-4)].

### session-persistence-5

When opening an existing monolithic session, the store shall read its supported logical contents unchanged, report it nonresumable with an explicit migration reason, and require explicit lease-protected, source-retaining migration before converting its physical representation [[session-storage-10](session-storage.md#session-storage-10)].
Migration shall validate the complete new representation before retiring its former active replay file and shall retain the original bytes outside the portable session bundle; an interrupted retry shall prove the exact published root and retained source bytes before retiring remaining legacy replay, while unknown formats shall remain unchanged and non-executable.
Local provider hints shall bind to the exact published root bytes [[session-storage-6](session-storage.md#session-storage-6)].

### session-persistence-6

When exporting a bounded session, the store shall provide the exact physical manifest root, the logical replay prefix proven by its checkpoint, existing asset descriptors and a verified relative file inventory of its physical manifest, replay root and reachable chunks [[session-storage-19](session-storage.md#session-storage-19)].
The physical replay may include a later readable tail, but only the manifest's exact sequence and digest shall establish its recovery boundary [[session-storage-4](session-storage.md#session-storage-4)].
The export shall retry a changed root within its bounded operation and shall never write a reconstructed monolithic file as an export side effect.

### session-persistence-7

When deleting a session under provable exclusive ownership, the store shall remove its private chunk files and replay root before the manifest, preserving the existing safety and retry rules [[session-storage-12](session-storage.md#session-storage-12)] and never removing another session's chunks.

## Internal Behavior

### session-persistence-11

For storage schema `8`, the chunk codec shall use the following closed binary-node and tagged-JSON representation, with every reference exactly `{sha256,byteLength}`, where `sha256` is the 64-character lowercase hexadecimal SHA-256 of the complete physical node bytes, `byteLength` is that node's encoded length from `1` through `8388608`, and its filename is exactly that digest within the owning session's chunk directory.
The encoding version shall be selected by the storage root version, with unknown tags or malformed references rejected rather than interpreted as user data.
All node JSON shall be compact UTF-8 JSON without a terminating newline, and readers shall reject malformed UTF-8.

| First byte | Remaining bytes | Interpretation |
| --- | --- | --- |
| `0` | Arbitrary byte content, including empty content | Byte leaf |
| `1` | JSON array of `1` through `1024` references | Ordered concatenation of child byte nodes |
| `2` | Tagged JSON bytes | JSON value encoded inline |
| `3` | JSON reference to a byte node | JSON value represented by oversized tagged JSON in that byte node's complete content |

When storing bytes, the codec shall split them in order into leaf payloads of at most `8388607` bytes, use one empty leaf for empty input, and repeatedly group consecutive references in batches of at most `1024` into byte-index nodes until one root reference remains.
When storing JSON, the codec shall encode finite numbers, booleans, null and strings as `["v",value]` when the UTF-8 JSON serialization of that scalar occupies at most `16384` bytes, and encode a larger string as `["s",ref]`, where the referenced byte content is the original string's JSON serialization.
The codec shall encode a dense array as `["a",encodedElements]` and a plain object as `["o",[[key,encodedValue],...]]`, preserving array order and the object's enumerable own string-key order, rejecting enumerable accessors, unsupported values, sparse or extended arrays, cyclic input and input nesting deeper than `512`.
For an array or object whose complete encoded representation exceeds `16384` bytes, it shall persist that representation as a JSON node and replace that occurrence with `["r",ref]` naming the JSON node; otherwise it shall retain that representation inline.
The top-level JSON encoding shall always be persisted as a JSON node: tag `2` carries its complete tagged JSON directly when its tag and content occupy at most `8388608` bytes, otherwise tag `3` references a byte-node tree carrying that content, whose splitting also bounds oversized keys and encoded array or object indexes.
Decoding shall distinguish these tagged structures from literal user data, reject duplicate object keys, reconstruct own data properties including `__proto__` safely, and reject byte-index descent beyond `512` or tagged-JSON decoding descent beyond `2048`.
Content-addressed publication shall reuse an existing digest only after verifying its complete bytes, length and private file identity, sync new chunk files before publishing their names, and sync their directory before returning references; these operations shall preserve the current-owner, verified-handle, single-link, non-symlink and private-permission requirements [[session-storage-1](session-storage.md#session-storage-1)].
An owner-local bounded cache may reuse verified physical bytes only after a fresh private-file path check proves the same containing-directory identity and exact device, inode, size, modification nanoseconds and change nanoseconds; absent precise metadata shall require a full verified-handle read and hash check instead.
An operation shall verify its containing directory before returning, return independent mutable logical values or copied byte buffers, and perform full byte and hash verification for export closure and namespace proofs despite cached content.
Ordinary preparation shall verify and preserve `.write-<digest>-<uuid>.tmp` files, permitting a private current-owner single-link regular file or a temporary and digest name proven to identify the same private current-owner regular file with exactly two links, while refusing other linked or unsafe entries rather than following them.
Only preparation explicitly authorized by an exclusive session lease or stopped-source migration authority may remove these proven interrupted temporary aliases; ordinary preparation shall leave the proven two-link digest unchanged so that exclusive recovery can proceed.
When proving the physical namespace for validation or export, the codec shall verify every canonical digest-named file, including unreferenced generations, against its private identity, encoded length, filename digest and supported physical-node tag with syntactically valid immediate references, without requiring unreachable dependencies to exist or modifying the directory.
That proof shall return only canonical chunk files, omit safe foreign regular files and proven store-owned temporary aliases, and refuse unsafe namespace entries.

### session-persistence-12

The bounded replay representation shall encode each nonempty append as one logical JSON node with exactly `previous`, `content`, `byteLength` and `totalBytes`, using the immutable JSON encoding [[session-persistence-11](#session-persistence-11)]:

- `previous` is null for the first append or a reference to its immediately preceding node; `content` references the immutable byte encoding of this append's exact UTF-8 envelope bytes [[session-persistence-11](#session-persistence-11)];
- each reference is exactly `{sha256,byteLength}`, naming the digest and physical byte length of its encoded root file;
- `byteLength` is a positive safe integer equal to this append's decoded byte count; `totalBytes` is a safe integer equal to that count plus the preceding node's total, or that count for the first node;
- the replay root's head references the latest node and its byte length equals that node's total; readers follow `previous` references to null, verify every node and content reference, reject cycles and inconsistent totals, and concatenate content in reverse traversal order;
- a zero-byte append creates no node, and publication changes only the replay root after its new node and content dependencies have been synced [[session-persistence-4](#session-persistence-4)];
- internal checkpoint synchronization by the owning lifecycle may reuse a proof of its fully verified predecessor and successfully synced append publication while the directory identity and root's identity, metadata and exact bytes remain unchanged; this proof stays within one lease and assumes that lease's immutable chunks are not modified outside the storage protocol;
- once a writer has verified or published a root, an externally changed root or containing directory blocks that writer's later append and checkpoint operations, including replacement with identical root bytes;
- reopening, public verification and export verify the complete chain, and recovery publication verifies replay before relying on its checkpoint; a failed chain verification invalidates the local publication proof.

## Verification

### session-persistence-8

When integration tests save, reopen and export real sessions containing repeated large observations and oversized individual JSON values or replay records, they shall verify equal hydrated recovery, exact replay bytes, deduplicated physical evidence and the 8 MiB bound on every generated file [[session-persistence-1](#session-persistence-1)] [[session-persistence-2](#session-persistence-2)] [[session-persistence-3](#session-persistence-3)] [[session-persistence-6](#session-persistence-6)] [[session-persistence-11](#session-persistence-11)] [[session-persistence-12](#session-persistence-12)].

### session-persistence-9

When integration tests interrupt writes and inspect malformed, missing or unsafe chunk paths, they shall verify preserved prior checkpoints, explicit incompleteness or refusal without repeated effects, dependency-before-root publication and unchanged private ownership guarantees [[session-persistence-2](#session-persistence-2)] [[session-persistence-3](#session-persistence-3)] [[session-persistence-4](#session-persistence-4)] [[session-persistence-12](#session-persistence-12)] [[session-persistence-11](#session-persistence-11)].

### session-persistence-10

When integration tests migrate an existing real bundle, read it concurrently, export it and delete it, they shall verify retained source bytes, unchanged recovery semantics and replay checkpoints, exact root-bound hints, complete portable closure and session-scoped manifest-last deletion [[session-persistence-5](#session-persistence-5)] [[session-persistence-6](#session-persistence-6)] [[session-persistence-7](#session-persistence-7)].
