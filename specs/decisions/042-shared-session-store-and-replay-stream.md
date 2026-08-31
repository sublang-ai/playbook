<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-042: Shared session store and token-free replay stream

## Status

Accepted.
Takes up [DR-010](010-playbook-session-tracing-and-resume.md) §6's deferral of durable trace storage to a separate decision, and preserves its resume-token credential posture by persisting a token-free projection instead of the trace itself.
Extends [DR-031](031-shared-captain-session-front-ends.md) §2's one shared configuration with an optional `sessions` bootstrap locator.

## Context

A session run through `playbook run` and a session run through an external host live in two disjoint stores that cannot see each other.
This CLI persists a per-session record — structural and execution projections, the shell snapshot holding provider resume tokens, and the recovery journal — and discards everything below the Boss boundary that only the live record stream carries: player prompts, tool calls, event streams, and timestamps.
The external host persists that full record stream in its own store, which this CLI cannot read.
Both front ends already observe every record and drop most of it, so teeing the stream to a per-session file beside the existing record is one added observer rather than a new execution path.
The store module already ships in the published tarball and is injectable, but it is unreachable behind the package `exports` map and has no declaration file, so exposing it wholesale would freeze every internal it happens to carry.
The durable format and the public module surface are therefore this project's to define, and the external host pins its dependency floor to the release that ships them.

## Decision

### 1. One shared home

The sessions directory is the one home for playbook sessions, and the per-session record remains the session's manifest.
A per-session replay stream sits beside that record, so any host honoring this contract can list and replay any session written by any other.
Each host keeps its own additional sidecar files in that directory, and a host shall ignore files it does not own rather than adopt or delete them.

### 2. A narrow public facade

A deliberate facade module shall be published at a semver-stable subpath and shall expose exactly this surface:

| Subject | Surface |
| --- | --- |
| Module | the default sessions directory, a store opener accepting an explicit directory, and the records-stream version constant |
| Store | its resolved directory, session listing, session-record reading, lease-free stream reading, and lease acquisition |
| Lease | its session id and owner token, record appending, stream reading, stream status, and release |

Validators, staging, publication, retirement, effect-ledger writing, and every turn-lifecycle operation — beginning a turn, settling, and discarding — shall stay unexported behind it.
The published lease is therefore a narrower handle than the internal one, because exposing the turn lifecycle would freeze the whole session lifecycle as public contract.
Both front ends shall reach the store through that same facade, so an external consumer's validation is the CLI's own validation by construction rather than by resemblance.
A record below the current schema shall be rejected rather than migrated, consistent with this project's hard-cutover posture.

### 3. A token-free replay projection under one frozen ABI

The stream is a replay projection, never an authority: it is deliberately insufficient to resume anything, and the session record's snapshot remains the only durable home for provider resume tokens under their existing credential posture.
Before any entry is written, the writer shall strip every `resumeToken` field at any depth and every string-valued `resume` selection, while `resume: false` survives as semantics rather than as a token.
The following ABI is frozen at the release that ships it:

| Element | Contract |
| --- | --- |
| File | `<sessionId>.records.jsonl`, beside `<sessionId>.json` in the sessions directory |
| Privacy | the record writer's discipline — mode `0600` regular non-symlink files in a mode `0700` real non-symlink directory |
| Envelope | one JSON object per line, `{"v": 1, "seq": <n>, "role"?: <string>, "record": <sanitized record>}` |
| Sequence | assigned by the writer, contiguous from 1 across the session's whole life, so replay can be incremental |
| Role | optional enrichment naming the role a player record's call served; a reader needing roles refolds them from trace records when it is absent |
| Corruption | the readable content is the complete newline-terminated prefix, and at most the final line may be torn |
| Version | a line carrying an unknown `v` is rejected rather than migrated or skipped |

Contiguity is an invariant rather than a signal: the writer assigns the sequence, so a caller cannot violate it, and a missing sequence is malformed input rather than a loss report.
A checked-in cross-repository fixture pins the format, so both repositories read one file rather than two readings of one prose description.

### 4. Lease-bound appends that latch and stop

Appending is offered only through an acquired session lease, appends are awaited in record order, and a resumed lease continues one past the last durable sequence.
Repairing a torn final line is lawful only while holding the lease; a lease-free reader returns the newline-terminated prefix, mutates nothing, and leaves the file byte-identical.
Record I/O shall not kill an agent turn, because a throwing observer poisons the record dispatcher, but silently truncated history shall not be presented as complete.
When an append fails, the writer shall therefore latch the stream incomplete at the last durable sequence and stop appending for the remainder of the session, keeping the file a clean contiguous prefix, while the turn continues.
The latching store instance reports that condition through its stream reader and status; the latch is live state and is not durable, so a later reader sees only a shorter clean prefix.

### 5. A `sessions` bootstrap locator

The sessions directory must be known before a stored session can be selected and its launch plan loaded, so it is a locator resolved at bootstrap rather than a member of any persisted projection.
The shared launch configuration gains an optional top-level `sessions` key, resolved by these cases:

| Case | Resolution |
| --- | --- |
| Leading `~` or `~/` | expanded from the home directory; no `~user` form is accepted |
| Absolute path | accepted as given |
| Relative path | resolved against the primary configuration's directory, as a registry specifier is |
| Per-launch overlay | may override the primary value |
| Explicitly injected store | takes precedence over the key |
| Unusable directory | fails closed at launch, as any other configuration defect does |

Tilde expansion is new in this configuration, and it applies to this key alone.
The key shall never enter a persisted structural or execution projection, and behavior with the key unset shall be byte-identical to today's default directory.

### 6. Preserved scope and deferrals

- Lease acquisition and retirement are unchanged: per-session single writer, lease-free reads, and foreign-host leases never broken. This decision routes appends through that lease rather than altering it.
- The agent-runtime client library needs no change; the tee rides its existing record-observer contract.
- Stream retention and deletion are deferred: streams are unbounded in this first version, and retention rides the already-deferred session-deletion decision.
- A durable incompleteness latch is deferred as a queued rider: the next session-record schema bump that happens for any independent reason shall carry a durable `recordsStream.incompleteAfterSeq` member, so the latch lands at zero marginal cost rather than spending a schema bump of its own. A genuinely cross-host proof additionally requires the dependent host to read this shared record, which is that repository's adoption work and is not decided here — our member alone is not the symmetric solution.
- Reading another host's own sidecar files stays out of scope.

Every change above ships in one release, so the dependent host pins its floor to that version rather than to a sequence of partial ones.

## Consequences

- One directory holds every session, so a session started in either host lists and replays in both, while the per-session record stays the manifest that governs resumption.
- The published surface is deliberately smaller than the module behind it, so internals stay changeable while the facade carries the semver obligation.
- The stream cannot leak a conversation credential even though it carries hidden prompts and tool I/O, because the projection is written token-free rather than filtered on read.
- Incompleteness is a mutual blind spot, stated rather than smoothed over: each host latches into its own manifest and neither reads the other's, so a truncated stream is indistinguishable from a normally-ended one to any reader that did not observe the failing process. Under this decision that limit is ours; it is already the dependent host's limit toward us.
- The frozen ABI matches what the dependent host already writes, so adoption starts at zero compatibility burden and the fixture keeps it there.
- Freezing the format and surface makes both a release event: changing either is a recorded decision and a SemVer obligation, not a refactor.
