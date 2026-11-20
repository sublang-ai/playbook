<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-111: A Session Is One Manifest File and a Segmented Replay Log

## Status

Proposed (2026-11-19), after long sessions spent minutes at every host start, turn opening and Git sync on the per-file cost of the bounded chunk layout [[1]] [[2]].
Amends [DR-094](094-bounded-session-persistence.md): replaces its chunked physical representation, and moves the conversion of earlier physical formats out of the store into a separate command; its logical recovery contract, durable dependency publication, exact replay bytes, per-file bound and quota decisions stand.
Amends [DR-101](101-a-store-rereads-only-what-it-has-not-verified.md): a reader's verified boundary becomes a byte offset in the replay log instead of a chain head.
Amends [DR-109](109-a-writer-checkpoints-from-what-it-verified.md) in its representation only: the writer's verified prefix is the replay log it verified and appended, with no chain to walk.

## Context

- A 3,993-record session in the schema 8 layout holds 9,451 files with 32.8 MB of content and occupies 62–65 MB on disk.
  - A record is two chunk files of a few hundred bytes, each filling a 4 KB block.
  - A manifest publication writes 3–4 new chunk files and retains the superseded generation, which accounts for 86% of the content.
  - No chunk comes near the 8 MiB bound; the largest is 61.6 KB.
- Every complete verification opens every file, which costs about 2.2 ms per file on Windows and 0.1 ms on macOS.
  - On Windows, for that session: `validate` takes 20.9 s warm and 269 s cold, lease acquisition 119 s, and `git add` with a fresh index 282 s.
  - In a desktop host this showed as a 13.5-minute start and 10–148 s to open each turn.
- A publication grew from 0.2 s to 1 s per write on Windows, two thirds of it re-reading and re-hashing every asset to rebuild an inventory the writer already knew.
- A prototype of the layout below, driven by that session's exact records and its 437 published manifests, reproduced every manifest's replay binding and measured [[2]]:
  - 8 files and 3.3 MB on disk;
  - `validate` in 0.06 s and lease acquisition in 0.06 s on Windows;
  - a publication flat at about 20 ms;
  - an append at 1.1 ms on Windows and 4.0 ms on macOS with a sync per append.
- Few sessions exist in earlier physical formats.
- Reading them at run time would keep two layouts and their cost in every host, while their owners still need a way to keep them.

## Decision

- A session's physical representation (schema 9) consists of:
  - one manifest file, `<sessionId>.json`, holding the complete logical manifest;
  - an append-only replay log of segment files in `<sessionId>.replay/`;
  - content-addressed blob files in `<sessionId>.blobs/`, only for immutable values that would otherwise take the manifest past the per-file bound;
  - the existing asset files.
- Every file the store writes stays within 8 MiB.
- A replay segment holds whole envelopes in sequence, each as its exact bytes followed by a newline.
  - An envelope that alone exceeds the bound is stored as a blob and referenced from its segment line.
- The writer seals its open segment at a size bound and at turn settlement; a sealed segment never changes.
- The manifest binds replay by today's `{seq, sha256, incomplete}`, plus each sealed segment's name, length and digest and the open segment's bound prefix length and digest.
- An append is written and synced before it is acknowledged, as today.
  - An unfinished final line beyond the manifest's bound prefix is an append a crash left unacknowledged: the next lease truncates the open segment to its last complete line before appending, and a reader without the lease waits for the line to complete.
- A publication syncs the open segment, writes the manifest to a temporary file, syncs it, renames it over `<sessionId>.json` under the lease and syncs the directory.
  - It retains no superseded manifest.
- The writer keeps the asset inventory it imported, and publication uses it without re-reading assets.
- Opening, validation and export read and verify the whole representation:
  - the manifest;
  - every sealed segment by its digest;
  - the open segment's bound prefix;
  - every envelope's sequence;
  - the cumulative digest at the bound sequence.
- A reader that verified a prefix continues from its byte offset and verifies only the bytes after it.
- Each file the store opens is checked once against the private-entry rules; on Windows that is one owner and descriptor read per file.
- At run time the store reads only schema 9.
  - It reports a session in the schema 7 monolithic or schema 8 chunked format as an unsupported version and leaves its files unchanged.
  - Earlier records (schemas 2–6 and desktop sidecars) are unsupported likewise, and hosts no longer migrate the former `${XDG_STATE_HOME:-~/.local/state}/playbook/sessions` default at start; an earlier version migrates them first.
- A separate command, `playbook sessions upgrade`, run by hand and never loaded by the store at run time, converts schema 7 and schema 8 sessions to schema 9, replacing `playbook migrate-session`:
  - it takes one sessions directory, or, with a recursive option, a directory under which it finds every sessions directory without following links;
  - it skips a session already in schema 9, in an unknown format or held by a lease, and reports every session's outcome;
  - it verifies the former representation completely and writes the new one under the session's lease;
  - it switches only after the new manifest's logical content, the replay's exact bytes and its cumulative digest equal the former ones;
  - it moves the former files into a `.legacy-sessions/` directory beside that sessions directory, outside the portable session namespace;
  - it rebinds the session's provider hints to the new manifest;
  - an interrupted conversion leaves the former session unchanged and can run again.
- The command remains at least until the next major release, when its removal is reconsidered.

## Consequences

- A session holds a handful of files, so reading costs time in proportion to its bytes rather than its records, and a publication costs time independent of the session's length.
- A Git sync only adds sealed segments and blobs; between syncs the manifest and the open segment change, as the manifest root and replay root do today.
- A concurrent reader sees the previous or the new manifest whole.
  - Because the log is append-only, the replay prefix the previous manifest binds stays readable.
- On Windows, replacing the manifest fails while another process holds it open without delete sharing; the writer retries within its operation and otherwise fails the publication, keeping the previous manifest.
- Blobs that no manifest references are removed only by the lease holder at settlement.
- Until converted, sessions saved by earlier versions are not readable by this version.
  - An embedding host decides how to present them; the conversion command, or an earlier version, makes them readable.
- The conversion command keeps read-only decoders for schema 7 and schema 8, tested against fixtures generated before the earlier writers are removed.
- The specs change with this decision:
  - session-persistence is rewritten for the new representation;
  - session-storage-1 (locations), session-storage-12 and session-storage-19 (deletion and export inventory) change;
  - session-storage-10 and session-persistence-5 (legacy migration) become the conversion command's rules, and playbook-cli-92 its command;
  - session-storage-1 drops the former-default cutover, and session-storage-3 the read-only projection of legacy journals;
  - session-assets gains a writer-kept inventory;
  - playbook-cli-82 and playbook-cli-83 change their verified boundary from a chain head to a byte offset, and playbook-cli-83 repairs a torn final line beyond the bound prefix.
- Embedding hosts adopt the layout together with this release: their sync units, private-file rules, the exclusion of `.legacy-sessions/` from sync, and the removal of any import of earlier formats.

## References

[1]: https://github.com/sublang-ai/playbook/issues/113 "Session storage: places where the cost may exceed what the requirements need"
[2]: https://github.com/sublang-ai/playbook/issues/113#issuecomment-7000389564 "Prototype results: a few files per session"
