<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# session-persistence: Session Manifest and Replay Log

## Intent

This package owns the physical representation of session recovery and replay — one manifest file, a segmented replay log and the rare blob part — preserving their logical meaning under [DR-094](../decisions/094-bounded-session-persistence.md) as amended by [DR-111](../decisions/111-a-session-is-a-manifest-and-a-replay-log.md).

## External Behavior

### session-persistence-1

When saving a session, the shared store shall write its complete logical manifest [[session-storage-2](session-storage.md#session-storage-2)] in one `<sessionId>.json` manifest file holding exactly `schemaVersion: 9`, `kind: "captain-session-storage"`, `sessionId`, `manifest` and `log`, plus `spills` only when a value spills [[session-persistence-2](#session-persistence-2)], where `log` binds the replay prefix its checkpoint proves [[session-persistence-3](#session-persistence-3)].
The store shall keep replay in the session-owned `<sessionId>.replay/` log and blob parts in `<sessionId>.blobs/`, and bound every file it writes to 8 MiB.

### session-persistence-2

When a logical manifest's compact JSON would take its manifest file past the per-file bound, the store shall move whole values below its root into blob parts, largest first, until the file fits, recording for each a `spills` entry of exactly `{path, parts}`:

- `path` names the value by its object keys and array indexes, and the manifest file holds `null` in its place;
- `parts` lists the ordered `{sha256, byteLength}` references whose concatenated content is that value's compact JSON;
- a blob part is named by the lowercase SHA-256 of its complete content of 1 through 8,388,608 bytes, written and synced before any file that references it, and reused only after its content verifies.

When reading a manifest file, the store shall verify every part's length and digest and place each value at its path, refusing a missing or corrupt part or a path not ending at `null`.
Only the lease holder, after a settlement's publication, shall remove a blob part that neither the published manifest nor a segment references.

### session-persistence-3

The replay log shall hold the exact ordered envelope bytes [[session-storage-3](session-storage.md#session-storage-3)] [[session-storage-4](session-storage.md#session-storage-4)] as whole lines in segment files named by their first sequence as twelve decimal digits and `.jsonl`, the first being `000000000001.jsonl` and each later one beginning one past its predecessor's last line:

- a line is an envelope's exact bytes and its terminating LF, or, for an envelope whose line alone exceeds the per-file bound, exactly `{"parts":[...]}` and an LF, whose parts [[session-persistence-2](#session-persistence-2)] concatenate to the envelope without its LF;
- the writer seals its open segment once it reaches 1 MiB, before a line would take it past the per-file bound, and at turn settlement; a sealed segment never changes, and a new lease appends to the last segment unless the manifest binds it sealed or it reached 1 MiB;
- the manifest's `log` is exactly `{sealed, open}`: `sealed` lists the `{name, byteLength, sha256}` of each segment wholly inside the bound prefix, in order, and `open` is null or the `{name, byteLength, sha256}` of the prefix that ends the bound in the next segment, so the bound holds exactly the checkpoint's sequence of lines;
- the checkpoint's cumulative digest [[session-storage-4](session-storage.md#session-storage-4)] covers the envelope bytes a reference line stands for.

### session-persistence-4

When appending, the lease writer shall write the line to the open segment and sync it — and, for a new segment, sync the replay directory, and the sessions directory when it created that directory — before acknowledging the append [[session-storage-4](session-storage.md#session-storage-4)].
When publishing a checkpoint, the store shall write the manifest file to an unpredictable same-directory `0600` temporary file, sync it, replace `<sessionId>.json` atomically under the owning lease, or publish a fresh session's with an atomic no-replace link, and sync the sessions directory, acknowledging only that completed publication and retaining no superseded manifest file [[session-storage-11](session-storage.md#session-storage-11)].
Where another process holds the manifest file open without delete sharing, the store shall retry the replacement briefly and otherwise fail the publication, keeping the previous manifest file.
It shall apply the private-directory, current-owner, single-link and non-symlink rules to every file it writes [[session-storage-1](session-storage.md#session-storage-1)], including the caller's prohibition on creating a missing sessions directory [[session-storage-11](session-storage.md#session-storage-11)].

### session-persistence-5

The store shall read only schema-9 manifest files, reporting a session whose `<sessionId>.json` holds an earlier format — a schema 7 monolithic or schema 8 chunked root, which the conversion command converts [[session-storage-10](session-storage.md#session-storage-10)], or a schema 2–6 record — as unsupported and leaving its files unchanged:

- runtime acquisition and deletion refuse it before creating lease residue;
- listing reports it with that reason and keeps the place in the same-directory predecessor order its root's plain `cwd`, `state` and `updatedAt` state, while a root lacking a well-formed summary, or holding any other schema, is invalid.

### session-persistence-6

When exporting a session, the store shall provide the exact manifest file bytes, the logical replay prefix its checkpoint proves, existing asset descriptors [[session-storage-19](session-storage.md#session-storage-19)] and a relative file inventory of the manifest file, every segment at the length read and every blob part the manifest or the log references.
The log may hold a later readable tail, but only the manifest's exact sequence and digest shall establish its recovery boundary [[session-storage-4](session-storage.md#session-storage-4)].
The export shall retry within its bounded operation when the manifest file is replaced or a part it references is removed while it reads.

### session-persistence-7

When deleting a session under provable exclusive ownership, the store shall remove its segments, blob parts and their own temporary files and then their directories before its manifest file, preserving the existing safety and retry rules [[session-storage-12](session-storage.md#session-storage-12)] and never removing another session's files; a directory still holding a subdirectory or link afterward remains.

### session-persistence-11

When opening, validating or exporting a session, the store shall read and verify its whole representation:

- the manifest file's exact fields and its spilled values [[session-persistence-2](#session-persistence-2)];
- each sealed segment by its length and digest, and the open segment's bound prefix by its length and digest, the prefix ending on a line;
- every segment's name against the sequence of its first line, and every envelope's sequence [[playbook-cli-74](playbook-cli.md#playbook-cli-74)];
- the cumulative digest at the checkpoint's sequence [[session-storage-4](session-storage.md#session-storage-4)].

A segment other than the last ending inside a line, or a reference line whose parts are missing or corrupt, shall be damage at that point; an unfinished final line of the last segment waits for its completion [[session-storage-3](session-storage.md#session-storage-3)].
Each file the store opens shall be admitted once by the private-entry rules — on Windows, one owner and descriptor read [[session-storage-26](session-storage.md#session-storage-26)] — with its opened handle required to be that entry, and a read shall restart rather than combine generations when the entry is replaced or truncated below the length read.

## Internal Behavior

### session-persistence-12

The lease writer shall be constructed from a complete verified read of the log [[playbook-cli-83](playbook-cli.md#playbook-cli-83)] and keep, for its lease:

- its sealed segments' names, lengths and digests and its open segment's name, identity, length and running digest, so a checkpoint binds the durable prefix without reading a segment;
- a verified prefix: a running SHA-256 of the exact envelope bytes it verified and appended, the digest at its latest successful checkpoint, and the context records among those envelopes [[session-storage-5](session-storage.md#session-storage-5)], from which recovery publication and context recording take the applicable context and the durable prefix's digest [[session-storage-4](session-storage.md#session-storage-4)]; where it holds none, because its initialization failed or its replay latched [[playbook-cli-76](playbook-cli.md#playbook-cli-76)], they read the complete log instead;
- the blob parts its log references.

At each checkpoint it shall verify, by one status read and no content read, that its open segment is still the file it appends to at the length it wrote; a replaced or changed segment latches replay [[playbook-cli-76](playbook-cli.md#playbook-cli-76)].

## Verification

### session-persistence-8

When integration tests save, reopen and export real sessions whose replay seals at settlement and at the size bound, with an envelope and manifest values over the per-file bound, they shall verify the manifest file's exact fields and log binding [[session-persistence-1](#session-persistence-1)] [[session-persistence-3](#session-persistence-3)], sealed segments unchanged after sealing, equal hydrated recovery and exact replay bytes and digest [[session-persistence-11](#session-persistence-11)], blob parts removed once unreferenced [[session-persistence-2](#session-persistence-2)], a bundle inventory that restores an equal valid session in another directory [[session-persistence-6](#session-persistence-6)], and every file private and within 8 MiB [[session-persistence-4](#session-persistence-4)].

### session-persistence-9

When integration tests interrupt publication and appends and damage the representation, they shall verify a reader concurrent with replacement reading a whole manifest, the previous manifest file kept when publication stops before its rename and the new one after it, a briefly held manifest replaced after retries and a persistently held one kept [[session-persistence-4](#session-persistence-4)], temporary residue ignored, refusal of a damaged bound prefix without changing its bytes, a segment corrupted during the writer's lease refused at the next open while the writer's checkpoint keeps the digest of the bytes it wrote, and a replaced open segment latching replay at the next checkpoint [[session-persistence-11](#session-persistence-11)] [[session-persistence-12](#session-persistence-12)].

### session-persistence-10

When integration tests place schema 2–8 sessions and unknown roots beside schema-9 ones, and delete sessions, they shall verify each earlier format reported unsupported with its reason, refused for acquisition and deletion with unchanged bytes, ordered by its stated summary, and a summary-less or unknown root failing closed [[session-persistence-5](#session-persistence-5)], and deletion removing exactly the session's own files with its manifest file last while another session stays valid [[session-persistence-7](#session-persistence-7)].

### session-persistence-13

When integration tests make consecutive progress writes on real sessions of 200 and 600 records holding twenty assets, they shall verify, through injected filesystem operations, that each write opens and reads no segment or asset file and makes the same number of filesystem operations at both lengths, and that validation opens the manifest file and each segment once [[session-persistence-11](#session-persistence-11)] [[session-persistence-12](#session-persistence-12)].

### session-persistence-14

When integration tests save a real session through context recording, a changed execution configuration, an imported asset and an injected append failure, they shall verify that every published manifest's replay sequence, digest and incompleteness and its context sequence equal those an independent store derives from a complete read [[session-persistence-12](#session-persistence-12)].
