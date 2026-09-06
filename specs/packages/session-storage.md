<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# session-storage: Shared Durable Sessions

## Intent

This package defines the portable session format, local provider hints and lifecycle shared by interactive CLI, headless CLI and embedding hosts under [DR-049](../decisions/049-portable-session-contract.md).
A **session bundle** consists of a manifest and the replay stream matching its checkpoint digest; both files are required for portability.
**Closed** JSON objects permit only the declared fields.
History requires neither a provider conversation nor an application's project registry.

## External Behavior

### session-storage-1

The session store shall use these locations and files for each session's canonical lowercase UUID:

- the default is `sessions/` under Spex home, selected by nonempty `SPEX_HOME` or otherwise `~/.spex`;
- the shared configuration's `sessions` value selects another directory; an explicitly injected store takes precedence over that value [[playbook-cli-78](playbook-cli.md#playbook-cli-78)];
- before using the ordinary unoverridden `~/.spex/sessions`, hosts migrate the former `${XDG_STATE_HOME:-~/.local/state}/playbook/sessions` through the shared cutover; explicit `SPEX_HOME`, `sessions` or store selections bypass discovery.

| File | Contents | Portability |
| --- | --- | --- |
| `<id>.json` | Manifest [[session-storage-2](#session-storage-2)] | Portable |
| `<id>.records.jsonl` | Replay [[session-storage-3](#session-storage-3)] | Portable |
| `<id>.hints.json` | Provider hints [[session-storage-6](#session-storage-6)] | Local, ignored by Git |
| `.<id>.lock/` and its staging/retired directories | Existing writer lease [[playbook-cli-23](playbook-cli.md#playbook-cli-23)] | Local, ignored by Git |

- manifests and hints use the same private regular-file and atomic writing rules as replay [[playbook-cli-74](playbook-cli.md#playbook-cli-74)]; opening prepares permissions before strict reads or granting a lease:
  - only the current-user-owned, non-symlink session directory and its current-user-owned single-link regular manifest, replay and hint files qualify; verified file handles restrict the directory first to `0700` and files to `0600`, removing permissions only;
  - wrong ownership, links, special files, insufficient owner permissions or failed verification block opening; preparation changes no content, ownership or lease metadata;
  - ordinary readers and leases retain their strict privacy checks; a private Git umask avoids exposure before opening.
- all hosts record the normalized absolute working directory as `cwd`; the format needs no Spex project ID or registry access.

### session-storage-2

The store shall encode a manifest as a closed schema-version-7 JSON object with these common fields and exactly one state variant:

| Field | Content |
| --- | --- |
| `schemaVersion`, `kind` | `7`, `"captain-session"` |
| `sessionId`, `cwd` | Canonical UUID matching the filename; normalized absolute working directory |
| `createdAt`, `updatedAt` | Canonical ISO UTC timestamps; creation time stays fixed, each forward update has a later time |
| `replay` | Exactly `{seq,sha256,incomplete}` under the checkpoint rule [[session-storage-4](#session-storage-4)] |
| `contextSeq` | Positive safe integer no greater than `replay.seq`, naming the applicable context [[session-storage-5](#session-storage-5)]; `null` only in history-only state lacking context |
| `state: 'settled' \| 'uncertain'` | `structuralProjection`, `lastAppliedExecutionProjection`, `snapshot`, `effectLedger`, `unresolvedEffects`; optional `retainedGenerations` and `settledAbandonment`; `uncertain` present exactly in uncertain state |
| `state: 'history-only'` | Nonempty string `reason`; no executable recovery fields |

- executable fields preserve the structural/execution projections, uncertainty, settlement, snapshot and ledger relationships of the durable Captain contract [[playbook-cli-23](playbook-cli.md#playbook-cli-23)], in their token-free storage form [[session-storage-7](#session-storage-7)]; stored state never implies lease ownership.
- unknown manifest or nested recovery versions remain byte-for-byte unchanged; they allow history viewing and deletion with a lease, but no execution or silent downgrade.

### session-storage-3

Every host shall preserve the frozen v1 replay envelope and removal of provider tokens [[playbook-cli-74](playbook-cli.md#playbook-cli-74)] [[playbook-cli-75](playbook-cli.md#playbook-cli-75)]:

- valid unknown kinds and headerless records count in sequence and digest checks;
- only `v`, `seq`, optional string `role`, and object `record` are envelope fields; v1 does not require `type` or `timestamp` inside `record`;
- portable validation rejects structured provider continuation fields; legacy history stays readable without rewriting its bytes;
- presentation skips unsupported records without reporting damage; new context and reset kinds require their declared headers [[session-storage-5](#session-storage-5)] [[session-storage-8](#session-storage-8)];
- the shared history reader returns the valid newline-terminated prefix and reports the first damaged boundary without modifying the file; an incomplete final line waits for completion;
- absent legacy replay may be presented from supported legacy journal fields, validating Boss/reply entries and marking the result synthetic; this read-only projection proves no durable replay boundary;
- new writers emit context records only after all host readers implement these rules.

### session-storage-4

When saving a session checkpoint, the shared lifecycle shall identify its exact durable replay prefix as `{seq,sha256,incomplete}`:

- `seq` is a nonnegative safe integer naming the last included record;
- `sha256` is lowercase hexadecimal SHA-256 of the exact UTF-8 bytes through that record's terminating LF;
- sequence zero hashes zero bytes; no JSON reserialization, whitespace normalization or line-ending conversion before hashing;
- replay is synced before publishing its checkpoint manifest; later presentation records cannot prove a newer recovery boundary;
- replay failure preserves the last proven prefix and sets `incomplete:true` in the next durable manifest; recovery and uncertainty remain independently durable;
- a digest mismatch, missing referenced history, saved incompleteness or unsupported required context blocks continuation while retaining readable history;
- a new lease cannot clear saved incompleteness merely because the current bytes parse; only explicit validated migration or repair may establish a replacement checkpoint;
- releasing a lease saves any newly detected incompleteness first; a failed save reports failure and retains ownership until safe recovery or process death;
- failure to save recovery before an external action blocks that action; failures after actions preserve uncertainty and never authorize repeating those actions.

### session-storage-5

Before presenting events under a new execution configuration, the writer shall persist one immutable replay context record with exactly `{type:'session_context',timestamp,contextVersion:1,captainId,configuration,graphs,initialVisible}`:

| Member | Contract |
| --- | --- |
| `timestamp` | Finite numeric Unix milliseconds |
| `captainId` | Captain runtime UUID |
| `configuration` | Complete token-free schema-2 execution projection: Captain, ordered players, catalog and exact role bindings [[playbook-cli-23](playbook-cli.md#playbook-cli-23)] |
| `graphs` | One `{playbookId,graph}` per catalog member; `graph:null` means unavailable, never inferred from a later module |
| `initialVisible` | Unique array of player IDs from that configuration |
| Graph | Exactly `{initial,nodes,edges}`; `initial` names a node |
| Node | Exactly `{id,kind,tags,parent?,role?,description?}`; unique string ID; `kind:'state' \| 'final'`; string-array tags; optional strings; parent names a node without cycles |
| Edge | Exactly `{id,from,to,event}`; unique string ID; endpoints name nodes; empty event means an always transition |

- each new supported presentation record includes `contextSeq` inside `record`, referencing an earlier context; the envelope is unchanged;
- each executable checkpoint references its applicable context; older events lacking references retain their original presentation without invented historical graphs;
- graph activity and summaries derive from events, while stored settings and graphs remain immutable even if installed modules change;
- an unknown context version may be skipped for presentation but cannot satisfy a required recovery reference.

### session-storage-6

The hint store shall encode `<id>.hints.json` as exactly `{v:1,sessionId,checkpointSha256,players,captain?}`:

| Field | Contents |
| --- | --- |
| `checkpointSha256` | Digest of the exact published portable manifest bytes |
| `players` | Map from current player IDs to nonempty provider token strings |
| `captain` (optional) | Original pinned or catch-up conversation value [[playbook-captain-41](playbook-captain.md#playbook-captain-41)] |

- unknown participants, a session or digest mismatch, invalid fields, missing files and unreadable hints mean a fresh provider conversation; they do not invalidate portable history;
- hints apply only to the current checkpoint, never to retained recovery generations, a restored older manifest or another participant;
- before using a hint, the lease owner removes that participant's hint and synchronizes the removal to disk, so a crash after the provider advances cannot reuse it with the old checkpoint;
- new hints are written only after their resulting portable checkpoint, from an acknowledged continuation or proof that the old token remains valid because execution never began;
- a token removed from disk but still in memory is insufficient proof; a failed hint write means the next conversation starts fresh;
- hints are excluded from replay, portable manifests and Git; copying a session bundle copies neither hints nor leases.

### session-storage-7

When saving recovery, the store shall remove provider tokens from the current checkpoint, retained recovery generations and every nested snapshot or ledger copy, using these schema-aware transformations:

| Location | Portable form |
| --- | --- |
| Captain conversation | `unopened` for empty history; otherwise `needsSeeding` |
| Player ledger `resumeToken` | Omitted; fixed participant/settings identity retained |
| Runtime `roleResumeTokens` | Empty map; role bindings retained |
| Deferred logical operation `playerContinuation` | Exactly `{v:1,playerId}` naming the bound player, with operation/checkpoint/question/receipts unchanged [[playbook-runtime-73](playbook-runtime.md#playbook-runtime-73)] |
| Known observed/recovery payload token fields | Removed by the shared sanitizer [[playbook-cli-75](playbook-cli.md#playbook-cli-75)] |

- all ledger copies and aliased role views agree after projection; logical operation IDs and action receipts are never replaced by provider tokens;
- current hints may restore Captain/player provider conversations in memory; role views derive from the current player ledger, and tokens from retained generations are never restored;
- an unknown binding format or ambiguous player identity for a pending operation prevents recovery; deleting arbitrary JSON cannot make it resumable;
- instructions, prompts and tool content remain history; token-free storage removes structured provider-continuation fields, not secrets embedded in user text.

### session-storage-8

When a provider hint is absent or definitively rejected before execution, the host shall start a fresh conversation for the same logical call, preserving its operation ID and effect authority:

- supply the Captain's full recovery journal, or the player's complete task and pending questions and answers;
- a rejected hint permits exactly one fresh attempt only on Cligent's `SESSION_RESUME_REJECTED` classification [[1]]; unrelated errors, timeouts and ambiguous execution never take this path;
- the reset emits `{type:'continuity_reset',timestamp,contextSeq,participantId,reason}`, with finite timestamp and reason `missing_hint` or `rejected_hint`, without the token;
- a second failure uses ordinary failure and uncertainty handling, and the reset never repeats already acknowledged actions;
- provider-only knowledge is unavailable; the host must not claim to restore it from the session store.

### session-storage-9

When opening a portable checkpoint on another device, the lifecycle shall allow continuation only if the recorded working directory, canonical module locators and repository/effect identities match the destination's validated execution context:

- recorded path syntax accepts normalized POSIX and fully qualified Windows paths on every reader; execution still requires a matching native path;
- schema 7 permits no rewriting of repository/module paths inside checkpoints, opaque snapshots or effect receipts; changed paths permit history only;
- an application path alias associates history with a project; it cannot resolve a mismatch that prevents execution;
- matching paths still require compatible runtimes, exact structural validation and repository/effect reconciliation;
- checkpoint relocation requires a later versioned contract; hosts cannot add it by substituting path strings.

### session-storage-10

When migrating a stopped legacy store, the shared migrator shall hold the session lease and preserve source bytes outside the portable session namespace before publishing a validated schema-7 bundle:

- supported schema-6 recovery is validated with its legacy codec, then converted and revalidated with the current codec under the token-free rule [[session-storage-7](#session-storage-7)] without losing uncertainty, journals, counters, retained generations or effect evidence;
- legacy tokens are discarded as usable hints, since the old format cannot prove the provider still matches that checkpoint; original inputs remain ignored;
- replay uses the shared token-free projection; clean lines keep their exact bytes, changed lines receive new checkpoint digests, and ignored backups retain every original byte;
- schema 2–5 and desktop sidecars lacking complete durable recovery produce history-only manifests, retaining their replay or history reconstructed from journals and explaining why recovery is unavailable;
- missing historical context remains missing; current validated context may be appended for a supported checkpoint without assigning it to earlier events;
- malformed inputs remain unchanged and are reported; divergent destination bytes block replacement; identical completed outputs make retries idempotent;
- cross-directory migration also holds the source lease, reads the adjacent source replay, and removes source replay before the source manifest only after validated destination publication and source retention;
- former-default discovery reports preserved unsupported inputs and blocks on active or unprovable ownership and destination collisions; a missing source directory is a no-op;
- old writers stop permanently at migration; ordinary opening does not silently downgrade unsupported recovery or clear an incomplete marker;
- no host tracks the migrated bundle in Git until token-free validation succeeds.

### session-storage-11

The published session API shall offer applications the same create, open, begin-turn, settle, retry, discard, abandonment and release operations as both CLIs, using the same store, validators, writer leases and durable effect ledger [[playbook-cli-23](playbook-cli.md#playbook-cli-23)]:

- hosts supply agent calls, module loading, presentation and repository dependencies; they do not reimplement manifest writes, journal authority or recovery decisions;
- create/open returns the session ID and a lease-bound lifecycle; begin/settle/retry/discard/abandonment preserve existing state-machine preconditions and durability boundaries;
- release closes admission and drains earlier work before retiring ownership; an ended runtime does not imply a settled checkpoint;
- existing summary and replay reads remain available and never expose provider hints;
- read-only lease inspection reports `active` for a live local owner, `idle` for no lease or a proven-dead local owner, and `unknown` otherwise; this observation never grants mutation authority;
- the lifecycle also exposes the shared read-only validator and explicit migration/deletion operations, so management does not require executable playbook modules.

### session-storage-12

When a host requests session deletion, the shared store shall acquire provable exclusive ownership and remove replay, local hints, active legacy sidecar and derived session state before removing the manifest last:

- active or unprovable ownership blocks deletion; retired lease directories remain against delayed reclaimers;
- interrupted cleanup is retryable, and partial bundles cannot continue;
- unknown recovery versions remain deletable by session ID under the same lease without loading a module;
- deletion writes no tombstone and never removes another session's files.

## Internal Behavior

### session-storage-13

The shared lifecycle shall use one version-aware codec for validation, projection, migration and hint attachment across all hosts, preserving unknown versions unchanged and rejecting mismatched recovery mirrors before external effects.

## Verification

### session-storage-14

When the integration suite creates, continues and deletes sessions through interactive, headless and application hosts against one real store, it shall verify:

- shared default and explicitly selected locations [[session-storage-1](#session-storage-1)];
- permission tightening after Git creates `0755`/`0644` entries, unchanged bytes, and refusal of unsafe paths or insufficient owner access [[session-storage-1](#session-storage-1)];
- exact manifest fields for each state [[session-storage-2](#session-storage-2)];
- shared lifecycle, leases and read-only active/idle/unknown observations without file changes [[session-storage-11](#session-storage-11)];
- interrupted deletion, safe retries and retained lease directories [[session-storage-12](#session-storage-12)];
- one codec across hosts [[session-storage-13](#session-storage-13)].

### session-storage-15

When the integration suite records Captain/player work and reopens it with modules removed, it shall verify:

- opaque/headerless record tolerance [[session-storage-3](#session-storage-3)];
- byte-prefix digests and persistent incompleteness under injected write failures [[session-storage-4](#session-storage-4)];
- graph/settings history from referenced context, including unknown versions and legacy missing graphs [[session-storage-5](#session-storage-5)].

### session-storage-16

When the integration suite checkpoints a session with current and retained player continuations and a pending operation, it shall verify:

- hints tied to exact checkpoints and removed before provider calls, stale-manifest rejection and fresh conversations after crashes [[session-storage-6](#session-storage-6)];
- token-free current/nested/retained storage with unchanged operation and external-action IDs [[session-storage-7](#session-storage-7)];
- one fresh attempt only for definite pre-execution rejection, with no repeated actions after ambiguous failure [[session-storage-8](#session-storage-8)].

### session-storage-17

When the integration suite migrates legacy CLI/desktop fixtures and opens their copied bundles in another storage directory, it shall verify:

- history-only access for unsupported path changes, portable POSIX/Windows recorded paths, and reconciliation for matching native paths [[session-storage-9](#session-storage-9)];
- preserved original bytes, version/format refusals, idempotent migrations, former-default discovery with override isolation, source/destination ownership and collisions, and no Git tracking until provider tokens have been removed [[session-storage-10](#session-storage-10)].

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/packages/engine.md "Provider resume rejection classification"
