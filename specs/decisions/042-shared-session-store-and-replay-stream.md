<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-042: Shared session store and token-free replay stream

## Status

Accepted.
Takes up [DR-010](010-playbook-session-tracing-and-resume.md) §6's deferral of durable trace storage to a separate decision, and preserves its resume-token credential posture by persisting a token-free projection instead of the trace itself.
Extends [DR-031](031-shared-captain-session-front-ends.md) §2's one shared configuration with an optional `sessions` bootstrap locator.
Amended by [DR-049](049-portable-session-contract.md): shared manifest lifecycle, default location, persisted replay status and local hints.

## Context

A session run through `playbook run` and a session run through an external host live in two disjoint stores that cannot see each other.
This CLI persists a per-session record — structural and execution projections, the shell snapshot holding provider resume tokens, and the recovery journal — and discards everything below the Boss boundary that only the live record stream carries: player prompts, tool calls, event streams, and timestamps.
The external host persists that full record stream in its own store, which this CLI cannot read.
Both front ends already observe every record and drop most of it, so teeing the stream to a per-session file beside the existing record is one added observer rather than a new execution path.
The store module already ships in the published tarball and is injectable, but it is unreachable behind the package `exports` map and has no declaration file, so exposing it wholesale would freeze every internal it happens to carry.
The durable format and the public module surface are therefore this project's to define, and the external host pins its dependency floor to the release that ships them.
The dependent host already writes the stream's content shape, but its current default-created directory and stream modes do not satisfy the privacy boundary and its reader does not enforce the frozen read contract, so its adoption includes those changes rather than starting at zero compatibility burden.

## Decision

### 1. One shared home

The sessions directory is the one home for canonical Playbook session manifests, replay streams, and host-owned sidecars, and the per-session `<sessionId>.json` record remains the only Playbook manifest and the basis for Playbook and facade listing.
A host honoring this contract can list and read a validated token-free summary of a canonical Playbook session and append and replay its stream; a host-only sidecar or stream does not create a listable Playbook session because manifest creation and the Playbook lifecycle remain private.
Each host keeps its own additional sidecar files in that directory, and a host shall ignore files it does not own rather than adopt or delete them.

### 2. A narrow public facade

A deliberate facade module shall be published at a semver-stable subpath and shall expose exactly this surface:

| Subject | Surface |
| --- | --- |
| Module | the default sessions directory, a store opener accepting an explicit directory, and the records-stream version constant |
| Store | its resolved directory, validated token-free session-summary listing and reading, lease-free stream reading with its observed readable boundary, and lease acquisition |
| Session summary | exactly the validated manifest's numeric schema version, session id, settled-or-uncertain state, absolute working directory, and update timestamp; never its snapshot, continuation credentials, projections, ledger, recovery data, or retained generations |
| Lease | its session id and owner token, record appending, stream reading with live writer status, stream status, and release returning the final stream status |

Validators, staging, publication, retirement, effect-ledger writing, and every turn-lifecycle operation — beginning a turn, settling, and discarding — shall stay unexported behind it.
The published lease is therefore a narrower handle than the internal one, because exposing the turn lifecycle would freeze the whole session lifecycle as public contract.
The facade shall validate a canonical manifest through the private reader and then return only a detached frozen session summary, so neither the credential-bearing manifest nor its evolving internal schema shape becomes reachable through the public capability.
The facade and both front ends shall use the same private store implementation and validators, so an external consumer's validation is the CLI's own validation by construction rather than by resemblance; the front ends retain their richer private leases, and the facade is not their exclusive access path.
A record below the current schema shall be rejected rather than migrated, consistent with this project's hard-cutover posture.

### 3. A token-free replay projection under one frozen ABI

The stream is a replay projection, never an authority: it is deliberately insufficient to resume anything, and the session record's snapshot remains the only durable home for provider resume tokens under their existing credential posture.
Before any entry is written, the writer shall strip every `resumeToken` field at any depth and every string-valued `resume` selection, while `resume: false` survives as semantics rather than as a token.
The following ABI is frozen at the release that ships it:

| Element | Contract |
| --- | --- |
| File | `<sessionId>.records.jsonl`, beside `<sessionId>.json` in the sessions directory |
| Privacy | every live store participant uses mode `0600` regular non-symlink stream files in a mode `0700` real non-symlink directory, and a reader rejects an incompatible boundary rather than weakening it |
| Envelope | one JSON object per line, `{"v": 1, "seq": <n>, "role"?: <string>, "record": <sanitized record>}` |
| Record | one opaque recursively sanitized JSON object, preserved without interpreting or gating its `type` or members; a missing or non-object value is a malformed envelope |
| Sequence | assigned by the writer, contiguous from 1 across the session's whole life, so replay can be incremental |
| Role | optional enrichment naming the local Playbook role a player record's call served, distinct from any host player identity inside `record`; a reader needing roles refolds them from trace telemetry when it is absent |
| Corruption | the readable content is the complete newline-terminated prefix, and at most the final line may be torn |
| Version | a line carrying an unknown `v` is rejected rather than migrated or skipped |

Contiguity is an invariant rather than a signal: the writer assigns the sequence, so a caller cannot violate it, and a missing sequence is malformed input rather than a loss report.
A trace bracket arrives as a `captain_telemetry` observed record with `topic: "playbook.trace"` and the schema-4 trace event in `record.payload`.
Where the CLI shell's explicit role binding supplies a player id, the Playbook writer keys each active player-call frame by that trace event's `(sessionId, callId)`, retains its `payload.playerId` and `payload.roleId`, closes only the exactly matching frame, and enriches each `player_prompt`, `player_event`, and `player_finished` with envelope `role` only when that player's active frames establish exactly one role; other, malformed, or indeterminate records omit `role`.
A checked-in cross-repository fixture pins the format, so both repositories read one file rather than two readings of one prose description.
Fixture compatibility is semantic equality of parsed envelopes: JSON object member order and the fixture's source-checkout mode are not ABI data, while a fixture materialized as a live stream must satisfy the privacy boundary.

### 4. Capability-scoped reads and lease-bound appends

A lease-free stream read shall pin one filesystem snapshot per call and report only the readable boundary it actually validates, because another process's content synchronization and live latch are not observable.
Continuous monotonic following shall validate work proportional to the newly completed suffix without mixing file generations or treating a torn tail as validated; it shall neither mutate nor repair the stream.
After the canonical store acquires a valid exclusive session lease, its replay writer shall independently rescan the retained prefix and establish live readable, durable, and incomplete state.
Failure to initialize that replay-only writer shall disable replay without invalidating the canonical lease or weakening strict reads; failure of the underlying private-directory, ownership, or independently requested manifest-read boundary remains fail-closed.
A successfully initialized, unlatched writer shall await lease-bound appends in order, synchronize the directory when first publishing the stream pathname, advance readability on completed appends, and advance durability only at batched content checkpoints after private session-record settlement and before normal release.
Replay initialization, sanitization, append, publication, or checkpoint failure shall latch and stop replay for that lease without failing or undoing the agent turn, successful private settlement, or otherwise valid release; intact complete lines remain readable and are not rolled back, while the live status declares the incomplete history.
Each CLI front end shall signal the first such incomplete transition once per acquired writer lease through its native ordered diagnostic channel, outside replay; the facade itself remains silent and exposes the live status to its caller.
The latch is not durable, so each successor lease reconstructs state from the filesystem; a CLI front end warns anew if its successor lease encounters the persistent defect, and only a lease holder may repair a torn final line.

### 5. A `sessions` bootstrap locator

The sessions directory must be known before a stored session can be selected and its launch plan loaded, so it is a locator resolved at bootstrap rather than a member of any persisted projection.
The shared launch configuration gains an optional top-level `sessions` key, resolved by these cases:

| Case | Resolution |
| --- | --- |
| Leading `~` or `~/` | expanded from the home directory; no `~user` form is accepted |
| Absolute path | accepted as given |
| Relative path | every other non-absolute value, including a bare `sessions/here`, is a filesystem path resolved against the primary configuration's directory |
| Per-launch overlay | may override the primary value |
| Explicitly injected store | takes precedence over the key |
| Unusable directory | fails closed at launch, as any other configuration defect does |

Tilde expansion is new in this configuration, and it applies to this key alone.
The key shall never enter a persisted structural or execution projection, and behavior with the key unset shall be byte-identical to today's default directory.

### 6. Preserved scope and deferrals

- Lease acquisition and retirement are unchanged: per-session single writer, lease-free reads, and foreign-host leases never broken. This decision routes appends through that lease rather than altering it.
- The public facade gains no explicit checkpoint operation: private session-record settlement and public lease release remain the two content-checkpoint boundaries, while separate readable and durable sequences keep intermediate status meaningful.
- The agent-runtime client library needs no change; the tee rides its existing record-observer contract.
- Stream retention and deletion are deferred: streams are unbounded in this first version, and retention rides the already-deferred session-deletion decision.
- A durable incompleteness latch is deferred as a queued rider: the next session-record schema bump that happens for any independent reason shall carry a durable `recordsStream.incompleteAfterSeq` member, so the latch lands at zero marginal cost rather than spending a schema bump of its own. A genuinely cross-host proof additionally requires the dependent host to read this shared record, which is that repository's adoption work and is not decided here — our member alone is not the symmetric solution.
- Reading another host's own sidecar files stays out of scope.
- Before it can use the shared home, the dependent host must satisfy the `0700` directory and `0600` stream-file boundary and the strict reader contract; this project shall not relax credential-bearing store privacy to accommodate its current defaults.

Every change above ships in one release, so the dependent host pins its floor to that version rather than to a sequence of partial ones.

## Consequences

- One directory holds canonical Playbook manifests, shared streams, and host sidecars; the Playbook manifest governs Playbook listing and resumption, while sidecar-only sessions remain discoverable only by their owning host.
- The published surface is deliberately smaller than the module behind it, so internals stay changeable while the facade carries the semver obligation.
- Neither public projection can leak a conversation credential: the stream is written token-free rather than filtered on read, and the session summary never exposes the credential-bearing manifest.
- Incompleteness is a mutual blind spot, stated rather than smoothed over: each host latches only in its own live store or process, so a truncated stream is indistinguishable from a normally-ended one to any reader that did not observe the failing process. Under this decision that limit is ours; it is already the dependent host's limit toward us.
- The frozen content ABI matches what the dependent host writes modulo immaterial JSON member order, while its privacy modes and strict reader remain explicit adoption work and the shared fixture prevents later content drift.
- Freezing the format and surface makes both a release event: changing either is a recorded decision and a SemVer obligation, not a refactor.
