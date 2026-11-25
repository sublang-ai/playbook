<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# session-storage: Shared Durable Sessions

## Intent

This package defines the portable session format, local provider hints and lifecycle shared by interactive CLI, headless CLI and embedding hosts under [DR-049](../decisions/049-portable-session-contract.md).
A **session bundle** consists of its manifest file, its replay log and the blob parts they reference, and its declared immutable asset files; all are required for portability.
**Closed** JSON objects permit only the declared fields.
History requires neither a provider conversation nor an application's project registry.

## External Behavior

### session-storage-1

The session store shall use these locations and files for each session's canonical lowercase UUID:

- the default is `sessions/` under Spex home, selected by nonempty `SPEX_HOME` or otherwise `~/.spex`;
- the shared configuration's `sessions` value selects another directory; an explicitly injected store takes precedence over that value [[playbook-cli-78](playbook-cli.md#playbook-cli-78)];
- hosts do not migrate the former `${XDG_STATE_HOME:-~/.local/state}/playbook/sessions` default, which stays unchanged ([DR-111](../decisions/111-a-session-is-a-manifest-and-a-replay-log.md)).

| File | Contents | Portability |
| --- | --- | --- |
| `<id>.json` | Manifest file holding the logical manifest [[session-persistence-1](session-persistence.md#session-persistence-1)] | Portable |
| `<id>.replay/`, `<id>.blobs/` | Replay log segments and blob parts [[session-persistence-2](session-persistence.md#session-persistence-2)] [[session-persistence-3](session-persistence.md#session-persistence-3)] | Portable |
| `<id>.assets/` | Immutable content and descriptors [[session-storage-18](#session-storage-18)] | Portable |
| `<id>.hints.json` | Provider hints [[session-storage-6](#session-storage-6)] | Local, ignored by Git |
| `.<id>.lock/` and its staging/retired directories | Existing writer lease [[playbook-cli-23](playbook-cli.md#playbook-cli-23)] | Local, ignored by Git |
| `.legacy-sessions/<id>/` beside the sessions directory | A converted session's former files [[session-storage-10](#session-storage-10)] | Local, outside the session namespace and sync |

- on Windows, private entries retain opened-handle identity checks without directory `fchmod` or directory `fsync` and qualify only by the Windows private-entry admission [[session-storage-26](#session-storage-26)], refusing any other ACL without changing its contents or ownership;
- manifests and hints use the same private regular-file and atomic writing rules as replay [[playbook-cli-74](playbook-cli.md#playbook-cli-74)]; opening prepares permissions before strict reads or granting a lease:
  - on POSIX, only the current-user-owned, non-symlink session directory and its current-user-owned single-link regular manifest, segment, blob and hint files and their directories qualify; verified file handles restrict directories to `0700` and files to `0600`, removing permissions only;
  - wrong ownership, links, special files, insufficient owner permissions or failed verification block opening, and a store that met a block prepares again at its next operation; preparation changes no content, ownership or lease metadata;
  - ordinary readers and leases retain their strict privacy checks; a private Git umask avoids exposure before opening.
- all hosts record the normalized absolute working directory as `cwd`; the format needs no Spex project ID or registry access.

### session-storage-26

Where the host runs on native Windows, every private-entry check shall admit an entry only when the current user, LocalSystem (`S-1-5-18`) or built-in Administrators (`S-1-5-32-544`) own it and its descriptor grants no other principal a right to change it ([DR-098](../decisions/098-native-windows-private-storage.md), [DR-100](../decisions/100-windows-private-storage-admits-read-grants.md)):

| Allow entry for another principal | Admission |
| --- | --- |
| Holds none of `0x2`, `0x4`, `0x10`, `0x40`, `0x100` (data, append or child, extended attributes, child deletion, attributes), `0x10000` (delete), `0x40000` (write descriptor), `0x80000` (write owner), `0x2000000` (maximum allowed), `0x10000000` (generic all) or `0x40000000` (generic write) — e.g. read, execute and synchronize `0x1200A9` | admitted |
| Holds any of them | refused |

- allow entries for the trusted principals and deny entries are admitted whatever their rights;
- owner and descriptor facts that are unsupported or incomplete, an absent descriptor or an unsupported entry type refuse; the volume need not be local;
- the check never changes the entry's descriptor, contents or ownership.

### session-storage-2

The store shall represent its logical manifest as a closed schema-version-7 JSON object with these common fields and exactly one state variant:

| Field | Content |
| --- | --- |
| `schemaVersion`, `kind` | `7`, `"captain-session"` |
| `sessionId`, `cwd` | Canonical UUID matching the filename; normalized absolute working directory |
| `createdAt`, `updatedAt` | Canonical ISO UTC timestamps; creation time stays fixed, each forward update has a later time |
| `replay` | Exactly `{seq,sha256,incomplete}` under the checkpoint rule [[session-storage-4](#session-storage-4)] |
| `assets` (optional) | Exactly `{version:1,entries}`; unique asset references naming the complete owned immutable assets [[session-storage-18](#session-storage-18)] |
| `contextSeq` | Positive safe integer no greater than `replay.seq`, naming the applicable context [[session-storage-5](#session-storage-5)]; `null` only in history-only state lacking context |
| `state: 'settled' \| 'uncertain'` | `structuralProjection`, `lastAppliedExecutionProjection`, `snapshot`, `effectLedger`, `unresolvedEffects`; optional `retainedGenerations` and `settledAbandonment`; `uncertain` present exactly in uncertain state |
| `state: 'history-only'` | Nonempty string `reason`; no executable recovery fields |

- uncertain `progress` stores the runtime-owned position and immutable step starts/results, validated against the preceding settled controller and current ledger [[recovery-18](recovery.md#recovery-18)];
- configured skill locators remain mutable execution fields under [[playbook-cli-4](playbook-cli.md#playbook-cli-4)], with an omitted list interpreted as empty; persisted locators do not add skill content to the bundle;
- executable fields preserve the structural/execution projections, uncertainty, settlement, snapshot and ledger relationships of the durable Captain contract [[playbook-cli-23](playbook-cli.md#playbook-cli-23)], in their token-free storage form [[session-storage-7](#session-storage-7)]; stored state never implies lease ownership.
- these optional recovery extensions retain the current version numbers only under the coordinated host upgrade gate [[release-35](release.md#release-35)]; an older same-version host is unsupported and is not promised history or deletion support for them;
- unknown manifest or nested recovery versions remain byte-for-byte unchanged; they allow history viewing and deletion with a lease, but no execution or silent downgrade.

### session-storage-3

Every host shall preserve the frozen v1 replay envelope and removal of provider tokens [[playbook-cli-74](playbook-cli.md#playbook-cli-74)] [[playbook-cli-75](playbook-cli.md#playbook-cli-75)]:

- valid unknown kinds and headerless records count in sequence and digest checks;
- only `v`, `seq`, optional string `role`, and object `record` are envelope fields; v1 does not require `type` or `timestamp` inside `record`;
- portable validation rejects structured provider continuation fields; history recorded before that rule stays readable without rewriting its bytes;
- presentation skips unsupported records without reporting damage; new context and reset kinds require their declared headers [[session-storage-5](#session-storage-5)] [[session-storage-8](#session-storage-8)];
- the shared history reader returns the valid newline-terminated prefix and reports the first damaged boundary without modifying the file; an incomplete final line waits for completion;
- new writers emit context records only after all host readers implement these rules.

### session-storage-4

When saving a session checkpoint, the shared lifecycle shall identify its exact durable replay prefix as `{seq,sha256,incomplete}`:

- `seq` is a nonnegative safe integer naming the last included record;
- `sha256` is lowercase hexadecimal SHA-256 of the exact UTF-8 bytes through that record's terminating LF;
- sequence zero hashes zero bytes; no JSON reserialization, whitespace normalization or line-ending conversion before hashing;
- replay is synced before publishing its checkpoint manifest; later presentation records cannot prove a newer recovery boundary;
- replay failure preserves the last proven prefix and sets `incomplete:true` in the next durable manifest; recovery and uncertainty remain independently durable;
- a digest mismatch, missing referenced history, saved incompleteness or unsupported required context blocks continuation while retaining readable history;
- a new lease cannot clear saved incompleteness merely because the current bytes parse; only explicit validated repair may establish a replacement checkpoint;
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

When saving recovery, the store shall remove provider tokens from the current checkpoint, uncertain progress record, retained recovery generations and every nested snapshot or ledger copy, using these schema-aware transformations:

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

- supply the Captain's full recovery journal, or the player's `freshPrompt` when supplied, otherwise its complete call prompt, preserving task and clarification context [[playbook-runtime-92](playbook-runtime.md#playbook-runtime-92)];
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

When run by hand on one sessions directory, or recursively on a directory under which it finds every directory named `sessions` holding a `<uuid>.json` root without following links or entering `.git`, `node_modules` or `.legacy-sessions`, the conversion command shall convert each schema 7 monolithic and schema 8 chunked session to schema 9 and report every session's outcome:

- it skips a session already in schema 9, in another format or held by a lease, and in a dry run only lists what it would convert;
- under the session's lease it tightens the former files' permissions by the opening rules [[session-storage-1](#session-storage-1)], verifies the former representation completely with read-only decoders — the schema 7 manifest beside `<id>.records.jsonl`, or the schema 8 root, chunks and replay chain — and verifies every complete replay envelope and its sequence [[session-storage-3](#session-storage-3)], the checkpoint's replay prefix digest [[session-storage-4](#session-storage-4)] and its referenced assets [[session-storage-18](#session-storage-18)];
- it writes the schema-9 log and manifest file [[session-persistence-1](session-persistence.md#session-persistence-1)] [[session-persistence-3](session-persistence.md#session-persistence-3)] from the exact former replay bytes, an unfinished final line included, and switches by replacing `<id>.json` only once the new manifest's logical content, the log's exact bytes and the checkpoint digest equal the former ones;
- before the switch it copies the former root into `.legacy-sessions/<id>/` beside the sessions directory with a receipt naming both roots' digests, and after it moves the remaining former files there and rebinds hints that matched the former root to the new manifest file [[session-storage-6](#session-storage-6)];
- a failure before the switch leaves the former session unchanged, and running again rewrites its own residue or finishes a switched conversion from its receipt; it refuses to overwrite the backup of a completed conversion;
- the store never loads it, and hosts using the sessions must stop first; it remains at least until the next major release ([DR-111](../decisions/111-a-session-is-a-manifest-and-a-replay-log.md)).

### session-storage-11

The published session API shall offer applications the same create, open, begin-turn, recordProgress [[recovery-18](recovery.md#recovery-18)], settle, retry, discard, abandonment and release operations as both CLIs, using the same store, validators, writer leases and durable effect ledger [[playbook-cli-23](playbook-cli.md#playbook-cli-23)]:

- opening validates required replay/context and destination compatibility before module imports, shell restoration, hint consumption or repository reconciliation [[session-storage-4](#session-storage-4)] [[session-storage-9](#session-storage-9)];
- hosts supply agent calls, module loading, presentation and repository dependencies; they do not reimplement manifest writes, journal authority or recovery decisions;
- create/open returns the session ID and a lease-bound lifecycle; begin/settle/retry/discard/abandonment preserve existing state-machine preconditions and durability boundaries;
- release closes admission and drains earlier work before retiring ownership; an ended runtime does not imply a settled checkpoint;
- read-only owner checks may overlap each other and record writes, so concurrent players can check the same lease; release rejects new checks and drains admitted checks before retiring ownership;
- existing summary and replay reads remain available and never expose provider hints;
- read-only lease inspection reports `active` for a live owner on this machine, `idle` for no lease or a proven-dead owner on this machine, and `unknown` otherwise, reading the owner's machine as the lease does [[playbook-cli-23](playbook-cli.md#playbook-cli-23)]; this observation never grants mutation authority;
- the lifecycle also exposes the shared read-only validator and explicit deletion, so management does not require executable playbook modules;
- the store factory's optional boolean `createSessionsDir` defaults to `true`, creating a missing sessions directory and its missing ancestors as private directories; `false` lets a host that prepared the directory forbid that:
  - no preparation of a session payload, lease, asset, replay or blob directory by that store creates its sessions directory or any ancestor of it; runtime and management acquisition, deletion, and record, replay and asset writes refuse while it is missing, including when it moves or disappears mid-operation, leaving the former path absent and reporting the refusal even if releasing an earlier lease then fails;
  - lease staging, asset, replay and blob directories are still created singly inside the existing directory, under the unchanged privacy checks and lease rules [[playbook-cli-23](playbook-cli.md#playbook-cli-23)];
  - the machine identity keeps its own directory provisioning [[playbook-cli-97](playbook-cli.md#playbook-cli-97)], unaffected by this option even where that directory shares an ancestor with the sessions directory, so a process's first identity resolution may create that shared ancestor;
  - a refusal is not kept: the same store acquires normally once the directory exists again.

### session-storage-12

When a host requests session deletion, the shared store shall acquire provable exclusive ownership and remove assets, local hints, the replay log and blob parts [[session-persistence-7](session-persistence.md#session-persistence-7)] before removing the manifest file last:

- active or unprovable ownership blocks deletion; retired lease directories remain against delayed reclaimers;
- interrupted cleanup is retryable, and partial bundles cannot continue;
- unknown recovery versions remain deletable by session ID under the same lease without loading a module;
- deletion writes no tombstone and never removes another session's files.

### session-storage-18

The session lifecycle shall own one `<sessionId>.assets` directory through the immutable asset facade [[session-assets-1](session-assets.md#session-assets-1)] [[session-assets-2](session-assets.md#session-assets-2)] [[session-assets-3](session-assets.md#session-assets-3)] [[session-assets-4](session-assets.md#session-assets-4)], with imports serialized by the session writer lease and reads available through the shared store.
Checkpoint publication shall include descriptors for its complete assets, and continuation shall reject a missing or corrupt declared asset or a known input, evidence, snapshot or media reference absent from that inventory.
An absent assets member shall preserve legacy manifest/replay-only sessions under the coordinated host upgrade rule [[session-storage-2](#session-storage-2)].

### session-storage-19

When exporting a session bundle, the shared store shall return exact physical manifest bytes, exactly the logical replay prefix proven by its checkpoint, verified relative content and descriptor entries for every declared asset, and the complete physical file inventory [[session-persistence-6](session-persistence.md#session-persistence-6)], refusing incomplete checkpoints and retrying a concurrently changed manifest within a bounded operation.
When deleting a session under its management lease, the store shall validate and remove that session's asset entries and then its private asset directory before removing its manifest, without removing copies belonging to another owner:

- regular non-link foreign files in that directory are removed with its asset entries;
- a directory still holding a subdirectory or link afterward remains, and deletion of the session's other files continues.

### session-storage-21

Before session presentation or replay, the host shall use the shared native-event ingestion boundary [[session-assets-9](session-assets.md#session-assets-9)] and report unavailable media when persistence fails, retaining no original large payload in that failure record.
The host shall promote saved media to one visible `playbook_evidence` record per content digest per genuine player call or explicitly scoped recovery-preparation call [[session-assets-5](session-assets.md#session-assets-5)], preserve its originating call and turn, and supply its reference to the active engagement.
Hidden decision, report and judge traffic shall produce no visible evidence promotion.

### session-storage-23

Where an embedding host supplies `approvalHandler` to the public create/open session-host facade, the host shall forward the typed tmux-play approval envelope and cancellable context only for working calls, preserving the native request, concrete actor and unique invocation while adding the persisted Captain turn offset.
The callback shall remain an ephemeral dependency, absent from execution/structural configuration, snapshots and model prompts; native approval events shall pass through ordinary replay recording [[session-storage-3](#session-storage-3)], with no pending request restored from history; handler rejections and invalid decisions shall preserve the adapter's error classification rather than become ordinary host denials.
When the controller is disposed, its approval scope shall abort pending callback signals and resolve their waits to denial before draining active work and releasing its lease [[session-storage-11](#session-storage-11)], ignoring late answers and denying later requests in the closed scope, per [DR-078](../decisions/078-live-tool-approval-forwarding.md).

## Internal Behavior

### session-storage-13

The shared lifecycle shall use one version-aware codec for validation, projection and hint attachment across all hosts, preserving unknown versions unchanged and rejecting mismatched recovery mirrors before external effects.

## Verification

### session-storage-24

When provider fixtures request approval through the real shared session host and store, integration verification shall assert exact allow/deny delivery, restored-turn attribution, independent invocation identity, hidden-control exclusion, archival without callback serialization, handler errors or invalid choices classified as errors without execution, and disposal cancellation before lease release with late answers unable to authorize work [[session-storage-23](#session-storage-23)].

### session-storage-22

When integration tests run working and hidden control calls through the shared session host, they shall verify saved native media, bounded replay payloads, once-per-call visible evidence, explicit preparation scope, and exclusion of hidden control traffic [[session-storage-21](#session-storage-21)].


### session-storage-14

When the integration suite creates, continues and deletes sessions through interactive, headless and application hosts against one real store, it shall verify:

- shared default and explicitly selected locations [[session-storage-1](#session-storage-1)];
- permission tightening after Git creates `0755`/`0644` entries, unchanged bytes, refusal of unsafe paths or insufficient owner access, and the same opened store preparing again once the path is repaired [[session-storage-1](#session-storage-1)];
- exact manifest fields for each state [[session-storage-2](#session-storage-2)];
- shared lifecycle, leases and read-only active/idle/unknown observations without file changes [[session-storage-11](#session-storage-11)];
- concurrent owner checks and release's admission barrier over the real store [[session-storage-11](#session-storage-11)];
- a missing sessions directory and parent created by default yet refused with `createSessionsDir: false` by runtime and management acquisition, deletion and a held lease's record and asset writes, a directory removed or moved during a held acquisition or deletion left absent at its former path with the refusal reported past a failed lease release, and the same store acquiring once it is restored [[session-storage-11](#session-storage-11)];
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
- one fresh attempt only for definite pre-execution rejection, using full clarification context after a compact resumed prompt, with no repeated actions after ambiguous failure [[session-storage-8](#session-storage-8)].

### session-storage-17

When the integration suite opens copied bundles in another storage directory and runs the conversion command on schema 7 and 8 fixtures the earlier writers produced, it shall verify:

- history-only access for unsupported path changes, portable POSIX/Windows recorded paths, and reconciliation for matching native paths [[session-storage-9](#session-storage-9)];
- each converted session's logical manifest and exact replay bytes equal to what the earlier store read from its fixture, the former files byte-identical in `.legacy-sessions/`, rebound hints and a resumable continuation; recursive discovery past links and skipped directories; skips of converted, unknown and leased sessions; a dry run changing nothing; a damaged complete replay envelope, missing declared asset, or written representation that does not verify leaving the former root in place; runs interrupted before and after the switch or during hint rebinding completed when run again; unrelated temporary files preserved and colliding backups refused before the switch; and the configured directory converted through the executable [[session-storage-10](#session-storage-10)].

### session-storage-20

When integration tests import assets under a real session lease, checkpoint, reopen, export and delete the session, they shall verify complete descriptors, exact replay-prefix export, independent owner copies, preparation, acquisition and deletion past foreign asset-directory entries, and refusal of missing or corrupt bytes without unsafe cleanup [[session-storage-18](#session-storage-18)] [[session-storage-19](#session-storage-19)].

### session-storage-25

When private directory preparation runs on real storage, verification shall assert that an opened directory is closed on success or pathname-replacement refusal, with Windows omitting directory `fchmod` while preserving handle/path identity checks [[session-storage-1](#session-storage-1)] ([integration checks](../../reference/sdlc/code.playbook/private-paths.integration.test.ts)).

### session-storage-27

Where the host runs on native Windows at the declared Node minimum, real-storage verification shall grant Everyone access to existing private entries with `icacls.exe` and assert ([integration checks](../../reference/sdlc/code.playbook/windows-storage.integration.test.ts)):

- a sessions directory and a session file granted read and execute, then reopened, leased and read, are admitted, and the machine identity's directory and file granted the same, read again from disk, still yield the published identity [[session-storage-26](#session-storage-26)];
- a session file granted modify refuses opening, and its bytes are unchanged [[session-storage-26](#session-storage-26)].


## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/packages/engine.md "Provider resume rejection classification"
